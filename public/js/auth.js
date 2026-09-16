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

  async init() {
    try {
      const res = await fetch('/api/auth/config');
      this.config = await res.json();
    } catch {
      this.config = { enabled: false, url: null, anonKey: null };
    }
    if (!this.config?.enabled) return this;
    this.restoreSession();
    this.captureRedirectSession();
    if (this.accessToken) {
      await this.refreshProfileName();
    }
    return this;
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

  captureRedirectSession() {
    if (typeof window === 'undefined') return;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    const expiresIn = hash.get('expires_in');
    if (!accessToken) return;
    this.session = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresIn ? Date.now() + Number(expiresIn) * 1000 : null,
      user: parseJwtUser(accessToken)
    };
    this.persistSession();
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  async loadClient() {
    if (this.client) return this.client;
    if (!this.config.enabled) return null;
    await loadSupabaseScript();
    this.client = window.supabase.createClient(this.config.url, this.config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return this.client;
  }

  async signInWithGoogle() {
    const client = await this.loadClient();
    if (!client) throw new Error('AUTH_NOT_CONFIGURED');
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin }
    });
    if (error) throw error;
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

  async signOut() {
    try {
      const client = await this.loadClient();
      await client?.auth.signOut();
    } catch {
      // local sign-out still proceeds
    }
    this.session = null;
    this.persistSession();
    this.onChange?.(null);
  }

  async refreshProfileName() {
    if (!this.accessToken) return;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/profiles?select=display_name&id=eq.${this.user?.id || ''}`, {
        headers: {
          apikey: this.config.anonKey,
          Authorization: `Bearer ${this.accessToken}`
        }
      });
      if (!res.ok) return;
      const rows = await res.json();
      if (rows?.[0]?.display_name) {
        this.session.profileDisplayName = rows[0].display_name;
        this.persistSession();
      }
    } catch {
      // keep JWT local-part fallback
    }
  }

  async saveDisplayName(displayName) {
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

  async fetchStats() {
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
