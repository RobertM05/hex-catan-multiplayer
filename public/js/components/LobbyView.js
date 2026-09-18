/**
 * LobbyView.js
 * Decoupled ES module UI component managing Lobby navigation,
 * Room Creation, Room Joining, Public Rooms listing,
 * Waiting Room slot rendering & actions, and Lobby Auth/Profile screens.
 */

import { i18n } from '../i18n.js';
import { network } from '../network.js';
import { lobbyAuth } from '../auth.js';
import { ico, mountIcons } from '../icons.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[char]);
}

export class LobbyView {
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.getElementById('view-lobby') : null);
    this.network = options.network || network;
    this.auth = options.auth || lobbyAuth;
    this.showToast = options.showToast || ((msg, isErr) => console.log(msg));
    this.showView = options.showView || ((viewId) => {});
    this.syncRulesModal = options.syncRulesModal || ((mode) => {});
    this.onHostRoom = options.onHostRoom || null;
    this.onJoinRoom = options.onJoinRoom || null;
    this.onStartGame = options.onStartGame || null;
    this.onLeaveRoom = options.onLeaveRoom || null;
    this.onGameStarted = options.onGameStarted || null;
    this.getMyPlayerId = options.getMyPlayerId || (() => this.network?.currentPlayerId || null);
    this.setMyPlayerId = options.setMyPlayerId || ((id) => {
      if (this.network) this.network.currentPlayerId = id;
    });

    this.currentRoom = null;
    this.authState = { email: '', exists: false };
  }

  get myPlayerId() {
    return this.getMyPlayerId();
  }

  set myPlayerId(id) {
    this.setMyPlayerId(id);
  }

  setupLobbyTabs() {
    const tabs = ['host', 'join', 'public'];
    tabs.forEach(tab => {
      const btn = document.getElementById(`tab-btn-${tab}`);
      if (btn) {
        btn.addEventListener('click', () => this.switchLobbyTab(tab));
      }
    });
  }

  switchLobbyTab(tab) {
    document.querySelectorAll('.lobby-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.lobby-tab-content').forEach(c => c.classList.add('is-hidden'));

    const activeBtn = document.getElementById(`tab-btn-${tab}`);
    const activeContent = document.getElementById(`tab-content-${tab}`);
    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.classList.remove('is-hidden');

    if (tab === 'public') {
      this.refreshPublicRooms();
    }
  }

  switchTab(tab) {
    this.switchLobbyTab(tab);
  }

  validateAuthEmail(email) {
    if (!email) return i18n.t('EMAIL_REQUIRED') || 'Please enter an email address.';
    if (!email.includes('@')) {
      return i18n.t('EMAIL_INVALID') || 'Please enter a valid email address ("@" is expected, e.g. name@example.com).';
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return i18n.t('EMAIL_INVALID') || 'Please enter a valid email address ("@" is expected, e.g. name@example.com).';
    }
    return null;
  }

  validateAuthPassword(password) {
    if (!password) return i18n.t('PASSWORD_REQUIRED') || 'Please enter your password.';
    if (password.length < 6) {
      return i18n.t('PASSWORD_MIN_LENGTH') || 'Password must be at least 6 characters.';
    }
    return null;
  }

  setupAuthUi() {
    const authModal = document.getElementById('auth-modal');
    this.auth.onChange = () => this.syncAuthChrome();

    const showAuthStep = (step) => {
      document.getElementById('auth-step-email')?.classList.toggle('is-hidden', step !== 'email');
      document.getElementById('auth-step-login')?.classList.toggle('is-hidden', step !== 'login');
      document.getElementById('auth-step-register')?.classList.toggle('is-hidden', step !== 'register');
      if (step === 'email') {
        setTimeout(() => document.getElementById('auth-email-input')?.focus(), 50);
      } else if (step === 'login') {
        const chip = document.getElementById('auth-chip-email');
        if (chip) chip.textContent = this.authState.email;
        const pass = document.getElementById('auth-login-password');
        if (pass) pass.value = '';
        setTimeout(() => pass?.focus(), 50);
      } else if (step === 'register') {
        const chip = document.getElementById('auth-chip-email-reg');
        if (chip) chip.textContent = this.authState.email;
        const pass = document.getElementById('auth-register-password');
        if (pass) pass.value = '';
        setTimeout(() => pass?.focus(), 50);
      }
    };

    document.querySelectorAll('.btn-auth-back-to-email').forEach(btn => {
      btn.addEventListener('click', () => showAuthStep('email'));
    });

    document.getElementById('btn-auth-modal')?.addEventListener('click', () => {
      showAuthStep('email');
      authModal?.classList.add('active');
    });

    document.getElementById('btn-auth-trigger')?.addEventListener('click', () => {
      showAuthStep('email');
      authModal?.classList.add('active');
    });

    document.getElementById('btn-close-auth')?.addEventListener('click', () => {
      authModal?.classList.remove('active');
    });

    document.getElementById('btn-google-auth')?.addEventListener('click', async () => {
      try {
        await this.auth.signInWithOAuth('google');
      } catch (err) {
        this.showToast(err.message, true);
      }
    });

    document.getElementById('form-auth-email')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('auth-email-input')?.value.trim();
      const err = this.validateAuthEmail(email);
      if (err) {
        this.showToast(err, true);
        document.getElementById('auth-email-input')?.focus();
        return;
      }
      this.authState.email = email;
      const btn = document.getElementById('btn-auth-email-submit');
      const originalText = btn ? btn.textContent : 'Continue';
      if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
      try {
        const exists = await this.auth.checkUserExists(email);
        this.authState.exists = exists;
        showAuthStep(exists ? 'login' : 'register');
      } catch (err) {
        this.showToast(err.message, true);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = originalText; }
      }
    });

    document.getElementById('form-auth-login')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('auth-login-password')?.value;
      const passErr = this.validateAuthPassword(password);
      if (passErr) {
        this.showToast(passErr, true);
        document.getElementById('auth-login-password')?.focus();
        return;
      }
      try {
        await this.auth.signInWithPassword(this.authState.email, password);
        this.network.setAccessToken(this.auth.accessToken);
        await this.network.reconnectWithAuth(this.auth.accessToken);
        this.syncAuthChrome();
        this.showToast(i18n.t('SIGNED_IN_AS', { name: this.auth.displayName || 'Player' }));
        authModal?.classList.remove('active');
      } catch (err) {
        let msg = err.message;
        if (/invalid login credentials/i.test(msg)) {
          msg = i18n.t('INVALID_CREDENTIALS') || 'Invalid password. Please try again.';
        }
        this.showToast(msg, true);
      }
    });

    document.getElementById('btn-auth-login-magic')?.addEventListener('click', async () => {
      try {
        await this.auth.signInWithMagicLink(this.authState.email);
        this.showToast(i18n.t('MAGIC_LINK_SENT'));
        authModal?.classList.remove('active');
      } catch (err) {
        let msg = err.message;
        if (/rate limit/i.test(msg) || /over_email_send_rate_limit/i.test(msg)) {
          msg = 'Email rate limit exceeded (max 3/hr). Please use your password to sign in.';
        }
        this.showToast(msg, true);
      }
    });

    document.getElementById('form-auth-register')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('auth-register-password')?.value;
      const passErr = this.validateAuthPassword(password);
      if (passErr) {
        this.showToast(passErr, true);
        document.getElementById('auth-register-password')?.focus();
        return;
      }
      try {
        await this.auth.signUpWithPassword(this.authState.email, password);
        if (this.auth.accessToken) {
          this.network.setAccessToken(this.auth.accessToken);
          await this.network.reconnectWithAuth(this.auth.accessToken);
          this.syncAuthChrome();
          this.showToast(i18n.t('SIGNED_IN_AS', { name: this.auth.displayName || 'Player' }));
          authModal?.classList.remove('active');
        } else {
          this.showToast('Account created successfully! You can now sign in.');
          showAuthStep('login');
        }
      } catch (err) {
        this.showToast(err.message, true);
      }
    });

    document.getElementById('form-display-name')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('profile-display-name')?.value.trim();
      const newPass = document.getElementById('profile-new-password')?.value;
      if (!name) return;
      try {
        await this.auth.saveDisplayName(name);
        if (newPass) {
          if (newPass.length < 6) {
            this.showToast(i18n.t('PASSWORD_MIN_LENGTH') || 'Password must be at least 6 characters.', true);
            return;
          }
          await this.auth.updatePassword(newPass);
          const newPassInput = document.getElementById('profile-new-password');
          if (newPassInput) newPassInput.value = '';
          this.showToast('Profile and password updated successfully!');
        } else {
          this.showToast(i18n.t('PROFILE_SAVED') || 'Profile name saved.');
        }
        await this.network.reconnectWithAuth(this.auth.accessToken);
        this.syncAuthChrome();
        authModal?.classList.remove('active');
      } catch (err) {
        this.showToast(i18n.t(err.message) || err.message, true);
      }
    });

    document.getElementById('btn-sign-out')?.addEventListener('click', async () => {
      await this.auth.signOut();
      await this.network.reconnectWithAuth(null);
      this.syncAuthChrome();
      authModal?.classList.remove('active');
    });

    document.getElementById('btn-my-stats')?.addEventListener('click', () => {
      this.openProfilePage('history');
    });

    document.getElementById('btn-stats-back')?.addEventListener('click', () => {
      this.showView('view-lobby');
    });

    document.getElementById('btn-profile-back')?.addEventListener('click', () => {
      this.showView('view-lobby');
    });

    document.getElementById('btn-profile-guest-signin')?.addEventListener('click', () => {
      showAuthStep('email');
      authModal?.classList.add('active');
    });

    document.querySelectorAll('.profile-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-profile-tab');
        if (tab) this.switchProfileTab(tab);
      });
    });

    document.getElementById('profile-search-player')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = e.target.value.trim();
        if (q) this.showToast(`Search for player "${q}" (mock result: 1 player found).`);
      }
    });

    document.getElementById('btn-profile-invite-link')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.origin);
        this.showToast('Invite link copied to clipboard!');
      } catch {
        this.showToast('Copy invite URL: ' + window.location.origin);
      }
    });

    document.getElementById('form-profile-account-name')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('account-display-name')?.value.trim();
      if (!name) return;
      try {
        await this.auth.saveDisplayName(name);
        await this.network.reconnectWithAuth(this.auth.accessToken);
        this.syncAuthChrome();
        const headerName = document.getElementById('profile-display-name-header');
        if (headerName) headerName.textContent = name;
        const overviewName = document.getElementById('profile-overview-name');
        if (overviewName) overviewName.textContent = name;
        this.showToast(i18n.t('PROFILE_SAVED') || 'Profile name saved.');
      } catch (err) {
        this.showToast(i18n.t(err.message) || err.message, true);
      }
    });

    document.getElementById('form-profile-account-password')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newPass = document.getElementById('account-new-password')?.value;
      if (!newPass) return;
      if (newPass.length < 6) {
        this.showToast(i18n.t('PASSWORD_MIN_LENGTH') || 'Password must be at least 6 characters.', true);
        return;
      }
      try {
        await this.auth.updatePassword(newPass);
        const input = document.getElementById('account-new-password');
        if (input) input.value = '';
        this.showToast('Password updated successfully!');
      } catch (err) {
        this.showToast(i18n.t(err.message) || err.message, true);
      }
    });

    document.getElementById('btn-account-signout')?.addEventListener('click', async () => {
      await this.auth.signOut();
      await this.network.reconnectWithAuth(null);
      this.syncAuthChrome();
      this.showView('view-lobby');
      this.showToast('Signed out successfully.');
    });

    this.syncAuthChrome();
  }

  switchProfileTab(tabName) {
    document.querySelectorAll('.profile-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-profile-tab') === tabName);
    });
    document.querySelectorAll('.profile-tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `ptab-${tabName}`);
    });
  }

  updateUserAvatar(containerId, avatarUrl) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (avatarUrl && (avatarUrl.startsWith('/') || avatarUrl.startsWith('http') || avatarUrl.startsWith('data:'))) {
      container.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="Avatar" referrerpolicy="no-referrer" />`;
    } else {
      const iconName = avatarUrl || 'user';
      container.innerHTML = `<span class="ico" data-icon="${iconName}"></span>`;
      mountIcons(container);
    }
  }

  renderAvatarPicker() {
    const picker = document.getElementById('profile-avatar-picker');
    if (!picker) return;

    const AVATARS = [
      { id: '/assets/avatars/settler.jpg', name: 'Settler' },
      { id: '/assets/avatars/monarch.jpg', name: 'Monarch' },
      { id: '/assets/avatars/knight.jpg', name: 'Knight' },
      { id: '/assets/avatars/merchant.jpg', name: 'Merchant' },
      { id: '/assets/avatars/farmer.jpg', name: 'Farmer' },
      { id: '/assets/avatars/lumberjack.jpg', name: 'Lumberjack' },
      { id: '/assets/avatars/miner.jpg', name: 'Miner' },
      { id: '/assets/avatars/bandit.jpg', name: 'Bandit' }
    ];

    const googlePhoto = this.auth.user?.user_metadata?.avatar_url || this.auth.user?.user_metadata?.picture;
    const currentAvatar = this.auth.avatarUrl;

    let html = '';
    if (googlePhoto) {
      const isGoogleActive = currentAvatar === googlePhoto;
      html += `
        <button type="button" class="avatar-choice-btn ${isGoogleActive ? 'active' : ''}" data-avatar-url="${escapeHtml(googlePhoto)}" title="Google Profile Photo">
          <img src="${escapeHtml(googlePhoto)}" alt="Google Photo" referrerpolicy="no-referrer" />
        </button>
      `;
    }

    AVATARS.forEach(av => {
      const isActive = currentAvatar === av.id;
      html += `
        <button type="button" class="avatar-choice-btn ${isActive ? 'active' : ''}" data-avatar-url="${av.id}" title="${av.name}">
          <img src="${av.id}" alt="${av.name}" />
        </button>
      `;
    });

    picker.innerHTML = html;

    picker.querySelectorAll('.avatar-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-avatar-url');
        if (!url) return;
        this.auth.setCustomAvatar(url);
        if (this.auth.session) {
          this.auth.saveProfile({ avatarUrl: url }).catch(err => console.warn('[profile] Failed to persist avatar:', err));
        }
        this.network.setAvatar?.(url);
        this.renderAvatarPicker();
        this.syncAuthChrome();
        this.updateUserAvatar('profile-main-avatar', this.auth.avatarUrl);
        this.updateUserAvatar('profile-hero-avatar', this.auth.avatarUrl);
        this.showToast('Avatar updated!');
      });
    });
  }

  async openProfilePage(activeTab = 'overview') {
    const authed = Boolean(this.auth.accessToken);
    if (!authed) {
      this.showToast('Please sign in to view your profile.', true);
      const authModal = document.getElementById('auth-modal');
      if (authModal) {
        document.getElementById('auth-step-email')?.classList.remove('is-hidden');
        document.getElementById('auth-step-login')?.classList.add('is-hidden');
        document.getElementById('auth-step-register')?.classList.add('is-hidden');
        authModal.classList.add('active');
      }
      this.showView('view-lobby');
      return;
    }

    this.showView('view-profile');
    const root = document.getElementById('view-profile');
    if (root) mountIcons(root);

    const displayName = this.auth.displayName || 'Player';
    const email = this.auth.user?.email || '';

    this.updateUserAvatar('profile-main-avatar', this.auth.avatarUrl);
    this.updateUserAvatar('profile-hero-avatar', this.auth.avatarUrl);
    const nameHeader = document.getElementById('profile-display-name-header');
    if (nameHeader) nameHeader.textContent = displayName;
    const overviewName = document.getElementById('profile-overview-name');
    if (overviewName) overviewName.textContent = displayName;

    this.renderAvatarPicker();
    const accName = document.getElementById('account-display-name');
    if (accName) accName.value = this.auth.displayName || '';
    const accEmail = document.getElementById('account-email-display');
    if (accEmail) accEmail.textContent = email;
    const accStatus = document.getElementById('account-status-display');
    if (accStatus) accStatus.textContent = 'Active Player';

    const guestBanner = document.getElementById('profile-guest-banner');
    if (guestBanner) {
      guestBanner.classList.add('is-hidden');
    }

    this.switchProfileTab(activeTab);

    try {
      const stats = await this.auth.fetchStats();
      const totalGames = stats.matches || 0;
      const wins = stats.wins || 0;
      const winRate = stats.winRate != null ? Number(stats.winRate).toFixed(2) : (totalGames > 0 ? ((wins / totalGames) * 100).toFixed(2) : '0.00');
      const pointGame = stats.pointsPerGame != null ? Number(stats.pointsPerGame).toFixed(2) : (stats.averageVp != null ? Number(stats.averageVp).toFixed(2) : '0.00');
      const totalPoints = stats.totalPoints != null ? stats.totalPoints : (totalGames && stats.averageVp ? Math.round(totalGames * stats.averageVp) : 0);

      const elGames = document.getElementById('cstat-total-games');
      if (elGames) elGames.textContent = String(totalGames);
      const elWinRate = document.getElementById('cstat-win-rate');
      if (elWinRate) elWinRate.textContent = String(winRate);
      const elPointGame = document.getElementById('cstat-point-game');
      if (elPointGame) elPointGame.textContent = String(pointGame);
      const elTotalPoints = document.getElementById('cstat-total-points');
      if (elTotalPoints) elTotalPoints.textContent = String(totalPoints);
      const elWins = document.getElementById('cstat-wins');
      if (elWins) elWins.textContent = String(wins);
      const elAvgRank = document.getElementById('cstat-avg-rank');
      if (elAvgRank) elAvgRank.textContent = stats.averageRank != null ? String(stats.averageRank) : '—';

      const tbody = document.getElementById('colonist-history-tbody');
      if (tbody) {
        const rows = stats.recent || [];
        if (rows.length === 0) {
          tbody.innerHTML = `
            <tr class="history-empty-row">
              <td colspan="5">No games played yet. Play a match to build your history!</td>
            </tr>
          `;
        } else {
          tbody.innerHTML = rows.map((match) => {
            const isWin = Number(match.rank) === 1;
            const rankText = match.rankDisplay || `${match.rank || 1}/4`;
            const opponentsList = Array.isArray(match.opponents) && match.opponents.length > 0
              ? match.opponents.map(name => escapeHtml(name)).join(' ')
              : escapeHtml(displayName);
            const dateText = match.dateDisplay || (match.endedAt ? new Date(match.endedAt).toLocaleString() : '—');
            const durationText = match.durationDisplay || '—';

            return `
              <tr>
                <td class="cell-date">${dateText}</td>
                <td class="cell-rank ${isWin ? 'rank-win' : ''}">${rankText}</td>
                <td class="cell-opponents">${opponentsList}</td>
                <td class="cell-duration">${durationText}</td>
                <td class="cell-replay">
                  <button type="button" class="btn-replay-icon" title="Game ${escapeHtml(match.roomCode || match.matchId || '')}">
                    ${ico('play')}
                  </button>
                </td>
              </tr>
            `;
          }).join('');
        }
      }
    } catch (err) {
      console.warn('Failed to load profile stats:', err);
    }
  }

  async openStatsPage() {
    return this.openProfilePage('history');
  }

  syncAuthChrome() {
    const authed = Boolean(this.auth.accessToken);
    const guest = Boolean(this.auth.isGuest);
    const user = this.auth.user;
    const displayName = this.auth.displayName || 'Player';
    const avatar = this.auth.avatarUrl;

    const btnAuth = document.getElementById('btn-auth-trigger');
    const authStatus = document.getElementById('auth-status-chip');
    const authName = document.getElementById('auth-chip-name');
    const authAvatar = document.getElementById('auth-chip-avatar');
    const btnMyStats = document.getElementById('btn-my-stats');

    if (btnMyStats) {
      btnMyStats.classList.toggle('is-hidden', !authed);
    }

    if (authed) {
      if (btnAuth) btnAuth.classList.add('is-hidden');
      if (authStatus) {
        authStatus.classList.remove('is-hidden');
        if (authName) authName.textContent = displayName;
        if (authAvatar) {
          if (avatar && (avatar.startsWith('/') || avatar.startsWith('http') || avatar.startsWith('data:'))) {
            authAvatar.innerHTML = `<img src="${escapeHtml(avatar)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" alt="Avatar" referrerpolicy="no-referrer" />`;
          } else {
            authAvatar.innerHTML = `<span class="ico" data-icon="${avatar || 'user'}"></span>`;
            mountIcons(authAvatar);
          }
        }
      }
      const hostInput = document.getElementById('host-player-name');
      if (hostInput && !hostInput.value) hostInput.value = displayName;
      const joinInput = document.getElementById('join-player-name');
      if (joinInput && !joinInput.value) joinInput.value = displayName;

      const profileNameInput = document.getElementById('profile-display-name');
      if (profileNameInput) profileNameInput.value = displayName;
      const profileEmailDisplay = document.getElementById('profile-email-display');
      if (profileEmailDisplay) profileEmailDisplay.textContent = user?.email || (guest ? 'Guest' : '');

      document.getElementById('auth-logged-in-panel')?.classList.remove('is-hidden');
      document.getElementById('auth-logged-out-panel')?.classList.add('is-hidden');
    } else {
      if (btnAuth) btnAuth.classList.remove('is-hidden');
      if (authStatus) authStatus.classList.add('is-hidden');
      document.getElementById('auth-logged-in-panel')?.classList.add('is-hidden');
      document.getElementById('auth-logged-out-panel')?.classList.remove('is-hidden');
    }
  }

  setupLobbyActions() {
    const formCreate = document.getElementById('form-create-room');
    if (formCreate) {
      formCreate.addEventListener('submit', async (e) => {
        e.preventDefault();
        const hostName = document.getElementById('host-player-name')?.value.trim() || 'Commander';
        const roomName = document.getElementById('create-room-name')?.value.trim() || 'Realm';
        const maxPlayers = parseInt(document.getElementById('create-max-players')?.value, 10) || 4;
        const mode = document.getElementById('create-game-mode')?.value || 'base';
        const turnDuration = parseInt(document.getElementById('create-turn-timer')?.value, 10) || 60;
        const mapSize = document.getElementById('create-map-size')?.value || 'standard';

        const roomOptions = {
          roomName,
          maxPlayers,
          mode,
          turnDuration,
          mapSize,
          avatar: this.auth.avatarUrl || '/assets/avatars/settler.jpg',
          vpTarget: mode === 'cities_knights' ? 13 : 10
        };

        try {
          let res;
          if (typeof this.onHostRoom === 'function') {
            res = await this.onHostRoom({ hostName, options: roomOptions });
          } else {
            res = await this.network.createRoom(hostName, roomOptions);
          }

          if (this.container) {
            this.container.dispatchEvent(new CustomEvent('host-room', { detail: { hostName, roomOptions, res } }));
          }

          if (res?.playerId) {
            this.myPlayerId = res.playerId;
          }
          if (res?.roomCode) {
            this.enterWaitingRoom(res.roomCode);
          }
        } catch (err) {
          this.showToast(err.message, true);
        }
      });
    }

    const formJoin = document.getElementById('form-join-room');
    if (formJoin) {
      formJoin.addEventListener('submit', async (e) => {
        e.preventDefault();
        const playerName = document.getElementById('join-player-name')?.value.trim() || 'Player';
        const code = document.getElementById('join-room-code')?.value.trim();
        if (!code) return;

        try {
          let res;
          const joinOptions = {
            avatar: this.auth.avatarUrl || '/assets/avatars/settler.jpg'
          };
          if (typeof this.onJoinRoom === 'function') {
            res = await this.onJoinRoom(code, playerName, joinOptions);
          } else {
            res = await this.network.joinRoom(code, playerName, joinOptions);
          }

          if (this.container) {
            this.container.dispatchEvent(new CustomEvent('join-room', { detail: { code, playerName, res } }));
          }

          if (res?.playerId) {
            this.myPlayerId = res.playerId;
          }
          if (res?.isStarted) {
            if (typeof this.onGameStarted === 'function') {
              this.onGameStarted(res);
            } else {
              this.showView('view-game');
            }
          } else if (res?.roomCode) {
            this.enterWaitingRoom(res.roomCode);
          }
        } catch (err) {
          this.showToast(err.message, true);
        }
      });
    }
  }

  async refreshPublicRooms() {
    try {
      const res = await fetch('/api/rooms');
      const rooms = await res.json();
      const container = document.getElementById('public-rooms-list');
      if (!container) return;
      container.innerHTML = '';

      if (rooms.length === 0) {
        container.innerHTML = `<p style="color: var(--text-secondary); text-align: center; padding: 24px;">${i18n.t('NO_ROOMS_AVAILABLE')}</p>`;
        return;
      }

      rooms.forEach(r => {
        const card = document.createElement('div');
        card.className = 'room-card';

        const info = document.createElement('div');
        const title = document.createElement('h4');
        title.style.fontSize = '16px';
        title.style.fontWeight = '700';
        title.textContent = r.name;

        const subtitle = document.createElement('span');
        subtitle.style.fontSize = '12px';
        subtitle.style.color = 'var(--text-secondary)';
        subtitle.textContent = `${i18n.t('HOST_LABEL')}: ${r.hostName} • ${r.playersCount}/${r.maxPlayers} ${i18n.t('PLAYERS_LABEL')}`;

        info.appendChild(title);
        info.appendChild(subtitle);

        const joinBtn = document.createElement('button');
        joinBtn.className = 'btn-glass btn-primary btn-join-direct';
        joinBtn.dataset.code = r.code;
        joinBtn.textContent = i18n.t('JOIN_ROOM_BTN');
        joinBtn.addEventListener('click', () => {
          const codeInput = document.getElementById('join-room-code');
          if (codeInput) codeInput.value = r.code;
          this.switchLobbyTab('join');
        });

        card.appendChild(info);
        card.appendChild(joinBtn);
        container.appendChild(card);
      });
    } catch (err) {
      console.error('Failed to fetch rooms:', err);
    }
  }

  renderLobby() {
    this.refreshPublicRooms();
  }

  enterWaitingRoom(code) {
    this.myPlayerId = this.network.currentPlayerId || this.myPlayerId;
    this.showView('view-waiting');
    const codeEl = document.getElementById('display-room-code');
    if (codeEl) codeEl.textContent = code;

    if (typeof window !== 'undefined' && window.location) {
      const url = new URL(window.location);
      url.searchParams.set('room', code);
      window.history.pushState({}, '', url);
    }
  }

  setupWaitingRoomActions() {
    const btnShare = document.getElementById('btn-share-link');
    if (btnShare) {
      btnShare.addEventListener('click', () => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(window.location.href);
        }
        this.showToast(i18n.t('LINK_COPIED'));
      });
    }

    const btnReady = document.getElementById('btn-toggle-ready');
    if (btnReady) {
      btnReady.addEventListener('click', () => {
        const me = this.currentRoom?.players?.find(p => p.id === this.myPlayerId);
        const nextReady = !(me?.isReady);
        this.network.setReady(nextReady);
      });
    }

    const btnAddBot = document.getElementById('btn-add-bot');
    if (btnAddBot) {
      btnAddBot.addEventListener('click', async () => {
        try {
          await this.network.addBot('medium');
        } catch (err) {
          this.showToast(err.message, true);
        }
      });
    }

    const btnSpawnAgent = document.getElementById('btn-spawn-agent');
    if (btnSpawnAgent) {
      btnSpawnAgent.addEventListener('click', async () => {
        try {
          await this.network.spawnAiAgent();
          this.showToast(i18n.t('TOAST_AGENT_SUMMONED') || 'AI Agent summoned!');
        } catch (err) {
          this.showToast(err.message, true);
        }
      });
    }

    const btnStart = document.getElementById('btn-start-game');
    if (btnStart) {
      btnStart.addEventListener('click', async () => {
        try {
          if (typeof this.onStartGame === 'function') {
            await this.onStartGame(this.currentRoom?.code);
          } else {
            await this.network.startGame();
          }
          if (this.container) {
            this.container.dispatchEvent(new CustomEvent('start-game', { detail: { roomCode: this.currentRoom?.code } }));
          }
        } catch (err) {
          this.showToast(err.message, true);
        }
      });
    }

    const btnLeave = document.getElementById('btn-leave-waiting');
    if (btnLeave) {
      btnLeave.addEventListener('click', () => {
        if (typeof this.onLeaveRoom === 'function') {
          this.onLeaveRoom();
        }
      });
    }
  }

  renderWaitingRoom(lobbyData) {
    this.myPlayerId = this.network.currentPlayerId || this.myPlayerId;
    this.currentRoom = lobbyData;
    this.syncRulesModal(lobbyData.mode);
    const slotsContainer = document.getElementById('waiting-slots-grid');
    if (!slotsContainer) return;
    slotsContainer.innerHTML = '';

    const isHost = lobbyData.hostId === this.myPlayerId;
    const startBtn = document.getElementById('btn-start-game');
    if (startBtn) startBtn.classList.toggle('is-hidden', !isHost);

    const addBotBtn = document.getElementById('btn-add-bot');
    if (addBotBtn) addBotBtn.classList.toggle('is-hidden', !(isHost && lobbyData.players.length < lobbyData.maxPlayers));

    const btnSpawnAgent = document.getElementById('btn-spawn-agent');
    if (btnSpawnAgent) {
      btnSpawnAgent.classList.toggle('is-hidden', !(isHost && lobbyData.players.length < lobbyData.maxPlayers));
    }

    const me = lobbyData.players.find(p => p.id === this.myPlayerId);
    const readyBtn = document.getElementById('btn-toggle-ready');
    if (readyBtn && me) {
      readyBtn.classList.toggle('btn-primary', !me.isReady);
    }

    if (startBtn && isHost) {
      const humansReady = lobbyData.players.filter(p => !p.isBot).every(p => p.isReady);
      startBtn.disabled = !humansReady;
      startBtn.title = humansReady ? '' : i18n.t('ERROR_PLAYERS_NOT_READY');
    }

    lobbyData.players.forEach(p => {
      const card = document.createElement('div');
      card.className = 'player-slot-card';
      card.style.setProperty('--player-color', p.color);
      const playerAvatar = p.avatar || '/assets/avatars/settler.jpg';

      const header = document.createElement('div');
      header.className = 'player-slot-header';

      const infoWrap = document.createElement('div');
      infoWrap.style.display = 'flex';
      infoWrap.style.alignItems = 'center';
      infoWrap.style.gap = '10px';

      const avatarImg = document.createElement('img');
      avatarImg.src = playerAvatar;
      avatarImg.className = 'slot-avatar-img';
      avatarImg.style.border = `2px solid ${p.color}`;
      avatarImg.alt = p.name;

      const nameBox = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.className = 'player-slot-name';
      nameEl.style.display = 'flex';
      nameEl.style.alignItems = 'center';
      nameEl.style.gap = '6px';
      nameEl.textContent = p.name;

      if (p.id === lobbyData.hostId) {
        const hostBadge = document.createElement('span');
        hostBadge.className = 'player-badge host-badge';
        hostBadge.textContent = 'Host';
        nameEl.appendChild(hostBadge);
      }
      if (p.isBot) {
        const botBadge = document.createElement('span');
        botBadge.className = 'player-badge bot-badge';
        botBadge.textContent = 'Bot';
        nameEl.appendChild(botBadge);
      }
      nameBox.appendChild(nameEl);
      infoWrap.appendChild(avatarImg);
      infoWrap.appendChild(nameBox);

      const readyBadge = document.createElement('span');
      readyBadge.className = `ready-badge ${p.isReady ? 'ready' : 'not-ready'}`;
      readyBadge.textContent = p.isReady ? i18n.t('STATUS_READY') : i18n.t('STATUS_NOT_READY');

      header.appendChild(infoWrap);
      header.appendChild(readyBadge);

      const footer = document.createElement('div');
      footer.style.display = 'flex';
      footer.style.justifyContent = 'space-between';
      footer.style.alignItems = 'center';
      footer.style.marginTop = '8px';

      const colorWrap = document.createElement('div');
      colorWrap.style.display = 'flex';
      colorWrap.style.alignItems = 'center';
      colorWrap.style.gap = '6px';

      const colorLbl = document.createElement('span');
      colorLbl.style.fontSize = '12px';
      colorLbl.style.color = 'var(--text-secondary)';
      colorLbl.textContent = i18n.t('CHOOSE_COLOR');

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = p.color;
      colorInput.className = 'color-picker-input';
      colorInput.style.border = 'none';
      colorInput.style.width = '28px';
      colorInput.style.height = '28px';
      colorInput.style.borderRadius = '50%';
      colorInput.style.cursor = 'pointer';
      if (p.id !== this.myPlayerId) {
        colorInput.disabled = true;
      } else {
        colorInput.addEventListener('change', (e) => {
          this.network.setColor(e.target.value);
        });
      }

      colorWrap.appendChild(colorLbl);
      colorWrap.appendChild(colorInput);
      footer.appendChild(colorWrap);

      if (isHost && p.id !== this.myPlayerId) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn-glass btn-danger btn-kick-player';
        kickBtn.dataset.id = p.id;
        kickBtn.style.padding = '4px 8px';
        kickBtn.style.fontSize = '11px';
        kickBtn.textContent = i18n.t('KICK_PLAYER');
        kickBtn.addEventListener('click', () => {
          if (typeof window !== 'undefined' && window.confirm && !window.confirm(i18n.t('KICK_PLAYER') + '?')) return;
          this.network.removePlayer(p.id);
        });
        footer.appendChild(kickBtn);
      }

      card.appendChild(header);
      card.appendChild(footer);
      slotsContainer.appendChild(card);
    });
  }
}
