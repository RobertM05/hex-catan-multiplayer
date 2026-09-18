/**
 * Optional lobby auth (Supabase). Guests are the default; no-ops when
 * /api/auth/config reports enabled:false.
 */

const SESSION_KEY = 'catan_supabase_session';

export class LobbyAuth {
  constructor() {
    this.config = { enabled: false, url: null, anonKey: null };
    this.client = null;
    this.session = null;
    this.onChange = null;
    this._initPromise = null;
    /** True when the current page load originated from a password-recovery email link. */
    this.isRecovery = false;
  }

  get accessToken() {
    return this.session?.access_token || null;
  }

  get user() {
    return this.session?.user || null;
  }

  get displayName() {
    return this.session?.profileDisplayName
      || this.user?.user_metadata?.display_name
      || (this.user?.email ? this.user.email.split('@')[0] : null);
  }

  get avatarUrl() {
    return this.session?.customAvatar
      || this.user?.user_metadata?.avatar_url
      || this.user?.user_metadata?.picture
      || '/assets/avatars/settler.jpg';
  }

  setCustomAvatar(avatarPath) {
    if (!this.session) {
      this.session = {};
    }
    this.session.customAvatar = avatarPath;
    this.persistSession();
    if (this.onChange) this.onChange();
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      try {
        const res = await fetch('/api/auth/config');
        this.config = await res.json();
      } catch {
        this.config = { enabled: false, url: null, anonKey: null };
      }
      if (!this.config?.enabled) return this;
      this.restoreSession();
      await this.captureRedirectSession();
      await this.ensureValidSession();
      if (this.accessToken) {
        await this.refreshProfileName();
      }
      return this;
    })();
    return this._initPromise;
  }

  async ensureInitialized() {
    if (this._initPromise) {
      await this._initPromise;
    } else {
      await this.init();
    }
  }

  restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) this.session = JSON.parse(raw);
    } catch {
      this.session = null;
    }
  }

  persistSession() {
    if (!this.session) {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
  }

  async captureRedirectSession() {
    if (typeof window === 'undefined') return;
    const search = new URLSearchParams(window.location.search);
    const hashStr = window.location.hash.replace(/^#/, '');
    const hash = new URLSearchParams(hashStr);

    const code = search.get('code') || hash.get('code');
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    const expiresIn = hash.get('expires_in');
    const tokenType = hash.get('type');          // 'recovery' | 'signup' | null
    const errorParam = search.get('error') || hash.get('error');

    // Log OAuth errors from Supabase/Google for easier debugging
    if (errorParam) {
      const desc = search.get('error_description') || hash.get('error_description') || '';
      console.warn(`[auth] OAuth error returned: ${errorParam} — ${desc}`);
      search.delete('error');
      search.delete('error_description');
      history.replaceState(null, '', window.location.pathname + (search.toString() ? `?${search}` : ''));
      return;
    }

    // PKCE flow: ?code= is in the URL. The Supabase client holds the code_verifier
    // in sessionStorage (set during signInWithOAuth). We load the client first so its
    // storage is intact, then call exchangeCodeForSession which reads the verifier internally.
    if (code) {
      try {
        const client = await this.loadClient();
        if (client) {
          const { data, error } = await client.auth.exchangeCodeForSession(code);
          if (!error && data?.session) {
            this.session = {
              access_token: data.session.access_token,
              refresh_token: data.session.refresh_token,
              expires_at: data.session.expires_at ? data.session.expires_at * 1000 : null,
              user: data.session.user
            };
            this.persistSession();
            // Detect recovery type from PKCE metadata if available
            if (data.user?.recovery_sent_at || data.session?.user?.recovery_sent_at) {
              this.isRecovery = true;
            }
          } else if (error) {
            console.warn('[auth] exchangeCodeForSession error:', error.message);
          }
        }
      } catch (err) {
        console.warn('[auth] exchangeCodeForSession failed:', err);
      } finally {
        search.delete('code');
        const cleanSearch = search.toString() ? `?${search.toString()}` : '';
        history.replaceState(null, '', window.location.pathname + cleanSearch);
      }
      return;
    }

    // Implicit flow fallback: #access_token= in hash (older Supabase / magic link / recovery)
    if (accessToken) {
      this.session = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresIn ? Date.now() + Number(expiresIn) * 1000 : null,
        user: parseJwtUser(accessToken)
      };
      this.persistSession();
      // Mark as recovery flow so LobbyView can show the reset step
      if (tokenType === 'recovery') {
        this.isRecovery = true;
      }
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  /** Clear the recovery flag once the user has successfully set their new password. */
  clearRecoveryState() {
    this.isRecovery = false;
  }

  async ensureValidSession() {
    if (!this.session) return null;
    if (this.session.expires_at && (Date.now() + 60_000) > this.session.expires_at && this.session.refresh_token) {
      try {
        const client = await this.loadClient();
        if (client) {
          const { data, error } = await client.auth.refreshSession({ refresh_token: this.session.refresh_token });
          if (!error && data?.session) {
            this.session = {
              access_token: data.session.access_token,
              refresh_token: data.session.refresh_token,
              expires_at: data.session.expires_at ? data.session.expires_at * 1000 : null,
              user: data.session.user,
              profileDisplayName: this.session.profileDisplayName
            };
            this.persistSession();
          }
        }
      } catch (err) {
        console.warn('[auth] token refresh error:', err);
      }
    }
    return this.session;
  }

  async loadClient() {
    if (this.client) return this.client;
    await this.ensureInitialized();
    if (!this.config.enabled) return null;
    await loadSupabaseScript();
    // persistSession: true is required for PKCE — the code_verifier is stored in
    // sessionStorage during signInWithOAuth() and must survive the Google redirect
    // round-trip so that exchangeCodeForSession() can complete successfully.
    // detectSessionInUrl: true lets Supabase auto-detect ?code= or #access_token= on return.
    this.client = window.supabase.createClient(this.config.url, this.config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: true,
        flowType: 'pkce'
      }
    });
    return this.client;
  }

  async checkUserExists(email) {
    await this.ensureInitialized();
    if (!this.config.enabled) return false;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/rpc/check_user_exists`, {
        method: 'POST',
        headers: {
          apikey: this.config.anonKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_email: email })
      });
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data);
    } catch (err) {
      console.warn('[auth] checkUserExists failed:', err);
      return false;
    }
  }

  async signInWithGoogle() {
    const client = await this.loadClient();
    if (!client) throw new Error('AUTH_NOT_CONFIGURED');
    // redirectTo must be the exact origin (no trailing slash, no path).
    // Add profile+email scopes so Google returns avatar_url in user_metadata.
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        scopes: 'openid email profile',
        queryParams: { access_type: 'offline', prompt: 'select_account' }
      }
    });
    if (error) throw error;
  }

  async signInWithPassword(email, password) {
    const client = await this.loadClient();
    if (!client) throw new Error('AUTH_NOT_CONFIGURED');
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data?.session) {
      this.session = {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at ? data.session.expires_at * 1000 : null,
        user: data.session.user
      };
      this.persistSession();
      await this.refreshProfileName();
      this.onChange?.(this.session);
    }
    return this.session;
  }

  async signUpWithPassword(email, password) {
    const client = await this.loadClient();
    if (!client) throw new Error('AUTH_NOT_CONFIGURED');
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    // Supabase anti-enumeration: when an account already exists, it returns identities: []
    if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      const err = new Error('USER_ALREADY_EXISTS');
      err.code = 'USER_ALREADY_EXISTS';
      throw err;
    }
    if (data?.session) {
      this.session = {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at ? data.session.expires_at * 1000 : null,
        user: data.session.user
      };
      this.persistSession();
      await this.refreshProfileName();
      this.onChange?.(this.session);
    }
    return data;
  }

  async signInWithMagicLink(email) {
    const client = await this.loadClient();
    if (!client) throw new Error('AUTH_NOT_CONFIGURED');
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) throw error;
  }

  /** Drop the local Supabase session without waiting on the remote client. */
  clearStoredSession() {
    this.session = null;
    this.persistSession();
    this.onChange?.(null);
  }

  async signOut() {
    try {
      const client = await this.loadClient();
      await client?.auth.signOut();
    } catch {
      // local sign-out still proceeds
    }
    this.clearStoredSession();
  }

  async refreshProfileName() {
    if (!this.accessToken) return;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/profiles?select=display_name,avatar_url&id=eq.${this.user?.id || ''}`, {
        headers: {
          apikey: this.config.anonKey,
          Authorization: `Bearer ${this.accessToken}`
        }
      });
      if (!res.ok) return;
      const rows = await res.json();
      if (rows?.[0]?.display_name) {
        this.session.profileDisplayName = rows[0].display_name;
      }
      if (rows?.[0]?.avatar_url) {
        this.session.customAvatar = rows[0].avatar_url;
      }
      this.persistSession();
    } catch {
      // keep JWT local-part fallback
    }
  }

  async saveDisplayName(displayName) {
    await this.ensureValidSession();
    const res = await fetch('/api/me/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`
      },
      body: JSON.stringify({ displayName })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'PROFILE_UPDATE_FAILED');
    if (this.session) {
      this.session.profileDisplayName = displayName;
      this.persistSession();
    }
    this.onChange?.(this.session);
    return body.profile;
  }

  async saveProfile({ displayName, avatarUrl } = {}) {
    await this.ensureValidSession();
    const payload = {};
    if (displayName !== undefined) payload.displayName = displayName;
    if (avatarUrl !== undefined) payload.avatarUrl = avatarUrl;
    const res = await fetch('/api/me/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`
      },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'PROFILE_UPDATE_FAILED');
    if (this.session) {
      if (displayName !== undefined) this.session.profileDisplayName = displayName;
      if (avatarUrl !== undefined) this.session.customAvatar = avatarUrl;
      this.persistSession();
    }
    this.onChange?.(this.session);
    return body.profile;
  }
  async updatePassword(newPassword) {
    const client = await this.loadClient();
    if (!client) throw new Error('AUTH_NOT_CONFIGURED');
    const { data, error } = await client.auth.updateUser({ password: newPassword });
    if (error) throw error;
    return data;
  }

  async fetchStats() {
    await this.ensureValidSession();
    const res = await fetch('/api/me/stats', {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'STATS_FAILED');
    return body;
  }
}

function parseJwtUser(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { id: payload.sub, email: payload.email, user_metadata: payload.user_metadata || {} };
  } catch {
    return null;
  }
}

function loadSupabaseScript() {
  if (window.supabase) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-supabase-js]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    script.async = true;
    script.dataset.supabaseJs = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('SUPABASE_JS_LOAD_FAILED'));
    document.head.appendChild(script);
  });
}

export const lobbyAuth = new LobbyAuth();
