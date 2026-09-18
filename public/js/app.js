/**
 * app.js
 * Main client controller for Hexagonal Strategy Game.
 * Ties together UI, i18n, Web Audio, SVG Renderer, and Socket.IO networking.
 */

import { i18n } from './i18n.js';
import { audio } from './audio.js';
import { network } from './network.js';
import { lobbyAuth } from './auth.js';
import { BoardRenderer } from './renderer.js';
import { ico, mountIcons } from './icons.js';
import { mapPhaseToStatusKey, mapPhaseToOpponentStateKey, canPayCost, canBuildWall, isCityWallHost, BUILD_COSTS } from './turnStatus.js';
import {
  getProgressDeck,
  PROGRESS_CARD_ICONS,
  unplayedProgressCards,
  revealedProgressCards,
  isProgressCardBoughtThisTurn,
  progressCardHandModifiers
} from './progressCards.js';
import { TurnTimerUI, playerMustDiscard } from './turnTimer.js';
import { confetti } from './confetti.js';

import { LobbyView, escapeHtml } from './components/LobbyView.js';
import { TradeModal } from './components/TradeModal.js';
import { DevCardsModal } from './components/DevCardsModal.js';
import { DiscardModal } from './components/DiscardModal.js';
import { ChatLogView, redactEventLogEntryForViewer } from './components/ChatLogView.js';
import { CitiesKnightsView } from './components/CitiesKnightsView.js';

export { escapeHtml, redactEventLogEntryForViewer };

export function renderVictoryStatsHtml(winner, s) {
  const turns = s?.turnNumber || 1;
  const vp = winner?.victoryPoints || s?.vpTarget || 10;
  const hasLongestRoad = s?.longestRoad?.playerId === winner?.id;
  const hasLargestArmy = s?.largestArmy?.playerId === winner?.id;
  const metropolisesCount = Object.values(s?.metropolises || {}).filter(m => m?.playerId === winner?.id).length;

  let cardsHtml = `
    <div class="victory-stat-card">
      <span class="victory-stat-val">${vp}</span>
      <span class="victory-stat-lbl">${i18n.t('VICTORY_POINTS_LABEL')}</span>
    </div>
    <div class="victory-stat-card">
      <span class="victory-stat-val">${turns}</span>
      <span class="victory-stat-lbl">${i18n.t('TURNS_PLAYED_LABEL')}</span>
    </div>
  `;

  if (hasLongestRoad && s?.longestRoad?.length) {
    cardsHtml += `
      <div class="victory-stat-card">
        <span class="victory-stat-val">🛣️ ${s.longestRoad.length}</span>
        <span class="victory-stat-lbl">${i18n.t('AWARD_LONGEST_ROAD')}</span>
      </div>
    `;
  }

  if (hasLargestArmy && s?.largestArmy?.count) {
    cardsHtml += `
      <div class="victory-stat-card">
        <span class="victory-stat-val">⚔️ ${s.largestArmy.count}</span>
        <span class="victory-stat-lbl">${i18n.t('AWARD_LARGEST_ARMY')}</span>
      </div>
    `;
  }

  if (metropolisesCount > 0) {
    cardsHtml += `
      <div class="victory-stat-card">
        <span class="victory-stat-val">🏛️ ${metropolisesCount}</span>
        <span class="victory-stat-lbl">${i18n.t('AWARD_METROPOLIS')}</span>
      </div>
    `;
  }

  return cardsHtml;
}

export class CatanApp {
  constructor(autoInit = true) {
    this.boardRenderer = null;
    this.turnTimerUI = new TurnTimerUI({ audio });
    this.currentRoom = null;
    this.victoryCelebrated = false;
    this.gameState = null;
    this.selectedAction = null; // { type: 'settlement'|'road'|'city'|'robber', validIds: Set }
    this.bankTrade = { give: null, receive: null };
    this.lastEventDie = null;
    this.barbarianOverlayKey = null;
    this.diceAnim = null;
    this.diceFaceTimer = null;
    this.deferredProductionToasts = [];
    this.progressPlay = null;
    this.seenProgressDrawKeys = new Set();
    this._myPlayerId = null;
    this.leavingMatch = false;
    this.seenTradeEventId = null;
    this.lastRenderedPhase = null;
    this.aqueductClaimInFlight = false;

    // Component instances
    this.lobbyView = new LobbyView({
      container: typeof document !== 'undefined' ? document.getElementById('view-lobby') : null,
      network,
      auth: lobbyAuth,
      showToast: (msg, isErr) => this.showToast(msg, isErr),
      showView: (viewId) => this.showView(viewId),
      syncRulesModal: (mode) => this.syncRulesModal(mode),
      syncAuthChrome: (viewId) => this.syncAuthChrome(viewId),
      onLeaveRoom: () => this.leaveMatchOrLobby(),
      onGameStarted: () => this.showView('view-game'),
      getMyPlayerId: () => this.myPlayerId,
      setMyPlayerId: (id) => { this.myPlayerId = id; }
    });
    this.lobby = this.lobbyView;

    this.tradeModal = new TradeModal({
      container: typeof document !== 'undefined' ? document.getElementById('trade-modal') : null,
      banner: typeof document !== 'undefined' ? document.getElementById('active-trade-banner') : null,
      network,
      audio,
      showToast: (msg, isErr) => this.showToast(msg, isErr),
      getGameState: () => this.gameState,
      getMyPlayerId: () => this.myPlayerId,
      getHandCardTypes: () => this.getHandCardTypes(),
      getCardCount: (me, type) => this.getCardCount(me, type),
      cardLabel: (type) => this.cardLabel(type),
      isCommodity: (type) => this.isCommodity(type)
    });

    this.devCardsModal = new DevCardsModal({
      container: typeof document !== 'undefined' ? document.getElementById('dev-cards-modal') : null,
      network,
      audio,
      showToast: (msg, isErr) => this.showToast(msg, isErr),
      getGameState: () => this.gameState,
      getMyPlayerId: () => this.myPlayerId,
      activateBuildRoad: () => this.activateBuildRoad()
    });

    this.discardModal = new DiscardModal({
      modal: typeof document !== 'undefined' ? document.getElementById('discard-modal') : null,
      network,
      audio,
      showToast: (msg, isErr) => this.showToast(msg, isErr),
      getMyPlayerId: () => this.myPlayerId,
      getGameState: () => this.gameState,
      getHandCardTypes: () => this.getHandCardTypes(),
      cardLabel: (type) => this.cardLabel(type),
      clearActiveAction: () => this.clearActiveAction()
    });

    this.chatLogView = new ChatLogView({
      logContainer: typeof document !== 'undefined' ? document.getElementById('log-scroll') : null,
      chatContainer: typeof document !== 'undefined' ? document.getElementById('chat-messages') : null,
      network,
      showToast: (msg, isErr) => this.showToast(msg, isErr),
      getMyPlayerId: () => this.myPlayerId,
      getGameState: () => this.gameState,
      cardLabel: (type) => this.cardLabel(type)
    });

    this.ckView = new CitiesKnightsView({
      network,
      audio,
      showToast: (msg, isErr) => this.showToast(msg, isErr),
      getMyPlayerId: () => this.myPlayerId,
      getGameState: () => this.gameState,
      isCitiesKnights: () => this.isCitiesKnights(),
      cardLabel: (type) => this.cardLabel(type),
      getCardCount: (me, type) => this.getCardCount(me, type),
      clearActiveAction: () => this.clearActiveAction(),
      setActionEnabled: (btn, en, reason) => this.setActionEnabled(btn, en, reason),
      notifyProgressDraws: (s) => this.notifyProgressDraws(s),
      checkProgressDiscardState: () => this.checkProgressDiscardState(),
      renderProgressCardHand: () => this.renderProgressCardHand(),
      collectKnightMoveTargets: (f, s) => this.collectKnightMoveTargets(f, s),
      getBoardRenderer: () => this.boardRenderer,
      updateBoardHint: () => this.updateBoardHint()
    });

    if (autoInit && typeof document !== 'undefined') {
      this.init();
    }
  }

  get myPlayerId() {
    return this._myPlayerId || network.currentPlayerId || null;
  }

  set myPlayerId(id) {
    this._myPlayerId = id || null;
    if (id) {
      network.currentPlayerId = id;
    }
  }

  isCitiesKnights() {
    return this.gameState?.mode === 'cities_knights';
  }

  getHandCardTypes() {
    const types = ['wood', 'brick', 'wool', 'wheat', 'ore'];
    if (this.isCitiesKnights()) types.push('cloth', 'coin', 'paper');
    return types;
  }

  isCommodity(type) {
    return type === 'cloth' || type === 'coin' || type === 'paper';
  }

  getCardCount(me, type) {
    if (!me) return 0;
    if (this.isCommodity(type)) return (me.commodities && me.commodities[type]) || 0;
    return (me.resources && me.resources[type]) || 0;
  }

  cardLabel(type) {
    if (this.isCommodity(type)) return i18n.t(`COMM_${type.toUpperCase()}`);
    return i18n.t(`RES_${type.toUpperCase()}`);
  }

  async init() {
    this.setupSoundToggle();
    this.setupRulesModal();
    this.setupModalAccessibility();

    // Initialize SVG board renderer
    const boardContainer = document.getElementById('board-container');
    this.boardRenderer = new BoardRenderer(boardContainer);
    this.setupRendererInteractions();

    // Setup Lobby Forms & Tabs
    this.setupLobbyTabs();
    this.setupRankedQueueUi();
    this.setupLobbyActions();
    this.setupWaitingRoomActions();
    this.setupInGameActions();
    this.setupHudOverlays();
    this.setupCkUi();
    this.setupTradeModals();
    this.setupDiscardModal();
    this.setupProgressChoiceModal();
    this.setupDevCardsModal();
    this.setupProgressCardUi();

    // Init auth FIRST so config.enabled=true before wiring auth UI buttons
    await lobbyAuth.init();
    this.setupAuthUi();
    network.setAccessToken(lobbyAuth.accessToken);
    network.onInvalidAuth = () => {
      // Stale JWT must not hard-block reconnects — clear session and continue as guest.
      lobbyAuth.clearStoredSession();
      this.syncAuthChrome();
    };
    this.syncAuthChrome();

    // Connect to WebSocket Server
    await network.connect();
    this.bindNetworkEvents();

    // Check URL parameters for join room (e.g. ?room=ABCD)
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl) {
      document.getElementById('join-room-code').value = roomFromUrl.toUpperCase();
      this.switchLobbyTab('join');
    }

    // Refresh public rooms list
    this.refreshPublicRooms();

    // Initial English copy
    i18n.updateDOM();

    document.getElementById('btn-brand-home')?.addEventListener('click', () => {
      this.goToHomepageFromBrand();
    });
    document.getElementById('btn-confirm-home-stay')?.addEventListener('click', () => {
      this.closeHomeConfirm();
    });
    document.getElementById('btn-confirm-home-leave')?.addEventListener('click', () => {
      this.closeHomeConfirm();
      this.leaveMatchOrLobby();
    });
    document.getElementById('confirm-home-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'confirm-home-modal') this.closeHomeConfirm();
    });

    window.addEventListener('beforeunload', (e) => {
      if (this.leavingMatch) return;
      if (this.gameState && this.currentRoom) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* =========================================================
   * VIEW NAVIGATION
   * ========================================================= */
  showView(viewId) {
    document.querySelectorAll('.view-screen').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');
    this.syncAuthChrome(viewId);
  }

  syncAuthChrome(viewId = document.querySelector('.view-screen.active')?.id) {
    const inMatch = viewId === 'view-game' || viewId === 'view-waiting';
    document.body.classList.toggle('match-active', inMatch);
    const authed = Boolean(lobbyAuth.accessToken);
    const authEnabled = Boolean(lobbyAuth.config?.enabled);

    // Header controls next to Sound / Rules
    document.getElementById('btn-header-sign-in')?.classList.toggle('is-hidden', !authEnabled || authed || inMatch);
    
    // Header Profile button: visible ONLY when authenticated and not in a live match
    const profileBtn = document.getElementById('header-user-profile');
    if (profileBtn) {
      profileBtn.classList.toggle('is-hidden', !authed || inMatch);
      const userNameEl = document.getElementById('header-user-name');
      if (userNameEl && authed) {
        userNameEl.textContent = lobbyAuth.displayName || 'Player';
      }
      this.updateUserAvatar('header-user-avatar', authed ? lobbyAuth.avatarUrl : null);
    }
    document.getElementById('btn-sign-out')?.classList.toggle('is-hidden', !authEnabled || !authed || inMatch);
    document.getElementById('btn-my-stats')?.classList.toggle('is-hidden', true);

    const nameLocked = authed;
    ['host-player-name', 'join-player-name'].forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.disabled = nameLocked;
      if (nameLocked && lobbyAuth.displayName) input.value = lobbyAuth.displayName;
    });

    // Inside Auth Modal
    document.getElementById('lobby-auth-signed-out')?.classList.toggle('is-hidden', authed);
    document.getElementById('auth-modal-signed-in')?.classList.toggle('is-hidden', !authed);
    const modalTitle = document.getElementById('auth-modal-title');
    if (modalTitle) {
      modalTitle.textContent = authed ? (i18n.t('DISPLAY_NAME_LABEL') || 'Profile name') : (i18n.t('SIGN_IN') || 'Sign In');
    }

    const status = document.getElementById('lobby-auth-status');
    if (status) {
      if (authed) {
        status.classList.remove('is-hidden');
        status.textContent = i18n.t('SIGNED_IN_AS', { name: lobbyAuth.displayName || 'Player' });
      } else {
        status.classList.add('is-hidden');
        status.textContent = '';
      }
    }
    const profileInput = document.getElementById('profile-display-name');
    if (profileInput && authed && lobbyAuth.displayName && !profileInput.value) {
      profileInput.value = lobbyAuth.displayName;
    }

    this.lobbyView?.syncLobbyChrome();
  }

  showToast(message, isError = false) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${isError ? 'toast-error' : ''}`;
    const iconMarkup = isError
      ? ico('warning', 'ico-error toast-icon')
      : ico('check', 'ico-ok toast-icon');
    toast.innerHTML = `${iconMarkup} <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  isOnHomepage() {
    const lobby = document.getElementById('view-lobby');
    return Boolean(lobby?.classList.contains('active')) && !this.currentRoom && !this.gameState;
  }

  goToHomepageFromBrand() {
    if (this.isOnHomepage()) return;
    // Only show confirmation modal when inside an active match.
    // From the waiting room, profile page or any other sub-view, navigate home directly.
    if (this.gameState) {
      this.openHomeConfirm();
    } else {
      this.leaveMatchOrLobby();
    }
  }

  openHomeConfirm() {
    const modal = document.getElementById('confirm-home-modal');
    if (!modal) return;
    modal.classList.add('active');
    document.getElementById('btn-confirm-home-leave')?.focus();
  }

  closeHomeConfirm() {
    document.getElementById('confirm-home-modal')?.classList.remove('active');
  }

  async leaveMatchOrLobby() {
    this.leavingMatch = true;
    try {
      await network.leaveRoom();
    } catch {
      // still return home
    }
    this.returnToHomepage();
  }

  returnToHomepage({ kicked = false } = {}) {
    this.leavingMatch = true;
    this.gameState = null;
    this.currentRoom = null;
    this.selectedAction = null;
    this.progressPlay = null;
    network.currentRoomCode = null;
    const path = window.location.pathname;
    if (window.location.search) {
      window.history.replaceState({}, '', path);
    }
    this.showView('view-lobby');
    this.syncAuthChrome();
    if (kicked) this.showToast(i18n.t('YOU_WERE_KICKED'), true);
    this.refreshPublicRooms();
    i18n.updateDOM();
    this.leavingMatch = false;
  }

  /* =========================================================
   * TOP BAR (Sound, Rules)
   * ========================================================= */
  setupSoundToggle() {
    const soundBtn = document.getElementById('btn-sound-toggle');
    if (!soundBtn) return;
    const updateIcon = () => {
      const isMuted = audio.isMuted();
      const iconMarkup = ico(isMuted ? 'speakerSlash' : 'speakerHigh', 'btn-icon');
      soundBtn.innerHTML = `${iconMarkup} <span class="sound-label">${i18n.t('SOUND_TOGGLE')}</span>`;
      soundBtn.setAttribute('aria-label', i18n.t('SOUND_TOGGLE'));
      soundBtn.setAttribute('title', i18n.t('SOUND_TOGGLE'));
    };
    soundBtn.addEventListener('click', () => {
      audio.toggle();
      updateIcon();
    });
    updateIcon();
  }

  setupRulesModal() {
    const modal = document.getElementById('rules-modal');
    document.getElementById('btn-rules')?.addEventListener('click', () => {
      this.syncRulesModal(this.resolveRulesMode());
      modal?.classList.add('active');
    });
    document.getElementById('btn-close-rules')?.addEventListener('click', () => {
      modal?.classList.remove('active');
    });

    const victoryLobbyBtn = document.getElementById('btn-victory-lobby');
    if (victoryLobbyBtn) {
      victoryLobbyBtn.addEventListener('click', () => {
        confetti.stop();
        const vModal = document.getElementById('victory-modal');
        if (vModal) vModal.classList.remove('active');
        window.location.reload();
      });
    }

    document.getElementById('create-game-mode')?.addEventListener('change', (e) => {
      this.syncRulesModal(e.target.value);
    });
    this.syncRulesModal(this.resolveRulesMode());
  }

  resolveRulesMode() {
    if (this.gameState?.mode) return this.gameState.mode;
    if (this.currentRoom?.mode) return this.currentRoom.mode;
    return document.getElementById('create-game-mode')?.value || 'base';
  }

  syncRulesModal(mode) {
    const ck = mode === 'cities_knights' || mode === 'advanced';
    document.getElementById('rules-copy-base')?.classList.toggle('is-hidden', ck);
    document.getElementById('rules-copy-ck')?.classList.toggle('is-hidden', !ck);
  }

  playerTitleStatsHtml(s, p) {
    const roadLen = p.roadLength || p.longestRoadLength || 0;
    const holdsRoad = s.longestRoadHolder?.playerId === p.id;
    const holdsArmy = !this.isCitiesKnights() && s.largestArmyHolder?.playerId === p.id;
    const defenderCount = p.defenderCards || 0;
    const holdsDefender = this.isCitiesKnights() && (defenderCount > 0 || s.defenderOfCatan === p.id);
    let html = `<span class="opponent-stat opponent-road${holdsRoad ? ' is-title' : ''}" title="${holdsRoad ? i18n.t('LONGEST_ROAD_TITLE') : i18n.t('ROAD_LENGTH_ABBR')}">${ico('path', 'ico-opp')} ${roadLen}</span>`;
    if (!this.isCitiesKnights()) {
      html += `<span class="opponent-stat opponent-army${holdsArmy ? ' is-title' : ''}" title="${holdsArmy ? i18n.t('LARGEST_ARMY_TITLE') : i18n.t('ARMY_SIZE_ABBR')}">${ico('cards', 'ico-opp')} ${p.playedKnights || 0}</span>`;
    } else if (holdsDefender) {
      const defenderLabel = defenderCount > 0 ? `${defenderCount}` : i18n.t('DEFENDER_ABBR');
      html += `<span class="opponent-stat opponent-defender is-title" title="${i18n.t('DEFENDER_TITLE')}">${ico('trophy', 'ico-opp')} ${defenderLabel}</span>`;
    }
    return html;
  }

  setupModalAccessibility() {
    this.modalReturnFocus = null;
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && !btn.closest('.modal-overlay')) this.modalReturnFocus = btn;
    }, true);

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const observer = new MutationObserver(() => {
        if (!overlay.classList.contains('active')) return;
        const focusable = overlay.querySelector('button, [href], input, select, textarea');
        if (focusable) focusable.focus();
      });
      observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = [...document.querySelectorAll('.modal-overlay.active')]
        .filter(m => m.id !== 'victory-modal');
      const top = open[open.length - 1];
      if (!top) return;
      e.preventDefault();
      top.classList.remove('active');
      if (this.modalReturnFocus && typeof this.modalReturnFocus.focus === 'function') {
        this.modalReturnFocus.focus();
      }
    });
  }

  /* =========================================================
   * LOBBY & WAITING ROOM (Delegated to LobbyView component)
   * ========================================================= */
  setupLobbyTabs() {
    this.lobbyView.setupLobbyTabs();
  }

  setupRankedQueueUi() {
    const joinBtn = document.getElementById('btn-join-ranked-queue');
    const leaveBtn = document.getElementById('btn-leave-ranked-queue');
    const statusBox = document.getElementById('ranked-queue-status-box');
    const statusText = document.getElementById('ranked-queue-status-text');
    const eloBadge = document.getElementById('ranked-user-elo-text');

    const updateEloDisplay = () => {
      if (eloBadge) {
        if (lobbyAuth?.user) {
          eloBadge.textContent = `Rating: ${this.myElo || 1000} Elo`;
        } else {
          eloBadge.textContent = i18n.t('RANKED_SIGN_IN_PROMPT') || 'Sign in required for Ranked';
        }
      }
    };
    updateEloDisplay();

    joinBtn?.addEventListener('click', async () => {
      if (!lobbyAuth?.user) {
        this.showToast(i18n.t('RANKED_SIGN_IN_REQUIRED') || 'Please sign in to play Ranked!', true);
        document.getElementById('auth-modal')?.classList.add('active');
        return;
      }

      try {
        joinBtn.classList.add('is-hidden');
        statusBox?.classList.remove('is-hidden');
        if (statusText) statusText.textContent = i18n.t('RANKED_SEARCHING') || 'Searching for 4 players...';

        await network.joinRankedQueue(this.selectedAvatar);
        audio.playClick();
      } catch (err) {
        joinBtn.classList.remove('is-hidden');
        statusBox?.classList.add('is-hidden');
        this.showToast(err.message, true);
      }
    });

    leaveBtn?.addEventListener('click', async () => {
      await network.leaveRankedQueue();
      joinBtn?.classList.remove('is-hidden');
      statusBox?.classList.add('is-hidden');
    });

    network.onRankedQueueStatus = (status) => {
      if (!status) return;
      if (status.inQueue) {
        joinBtn?.classList.add('is-hidden');
        statusBox?.classList.remove('is-hidden');
        if (statusText) {
          statusText.textContent = `Searching for players (${status.queueSize || 1}/4)...`;
        }
      } else {
        joinBtn?.classList.remove('is-hidden');
        statusBox?.classList.add('is-hidden');
      }
    };

    network.onRankedMatchFound = (data) => {
      audio.playStart();
      this.showToast(i18n.t('RANKED_MATCH_FOUND') || '⚔️ Ranked Match Found! Starting game...', false);
      joinBtn?.classList.remove('is-hidden');
      statusBox?.classList.add('is-hidden');
      this.currentRoom = { code: data.roomCode, ranked: true };
      this.showView('view-game');
    };
  }

  switchLobbyTab(tab) {
    this.lobbyView.switchLobbyTab(tab);
  }

  validateAuthEmail(email) {
    return this.lobbyView.validateAuthEmail(email);
  }

  validateAuthPassword(password) {
    return this.lobbyView.validateAuthPassword(password);
  }

  setupAuthUi() {
    this.lobbyView.setupAuthUi();
  }

  switchProfileTab(tabName) {
    this.lobbyView.switchProfileTab(tabName);
  }

  updateUserAvatar(containerId, avatarUrl) {
    this.lobbyView.updateUserAvatar(containerId, avatarUrl);
  }

  renderAvatarPicker() {
    this.lobbyView.renderAvatarPicker();
  }

  openProfilePage(activeTab = 'overview') {
    return this.lobbyView.openProfilePage(activeTab);
  }

  openStatsPage() {
    return this.lobbyView.openStatsPage();
  }

  // Note: app-level syncAuthChrome() at line ~311 handles the full header/modal chrome.
  // LobbyView.syncAuthChrome() handles lobby-panel chrome only (auth-trigger chip, etc.).
  // This stub is kept for backward-compat but the real method is defined above.
  _syncLobbyChrome() {
    this.lobbyView.syncAuthChrome();
  }

  setupLobbyActions() {
    this.lobbyView.setupLobbyActions();
  }

  refreshPublicRooms() {
    return this.lobbyView.refreshPublicRooms();
  }

  renderLobby() {
    this.lobbyView.renderLobby();
  }

  enterWaitingRoom(code) {
    this.leavingMatch = false;
    this.lobbyView.enterWaitingRoom(code);
    if (this.currentRoom && this.currentRoom.code === code) {
      this.renderWaitingRoom(this.currentRoom);
    }
  }

  setupWaitingRoomActions() {
    this.lobbyView.setupWaitingRoomActions();
  }

  renderWaitingRoom(lobbyData) {
    this.currentRoom = lobbyData;
    this.lobbyView.renderWaitingRoom(lobbyData);
  }

  /* =========================================================
   * IN-GAME INTERFACE & CONTROLLER
   * ========================================================= */
  setupInGameActions() {
    // Roll dice button
    document.getElementById('btn-roll-dice').addEventListener('click', async () => {
      if (this.diceAnim) return;
      const rollBtn = document.getElementById('btn-roll-dice');
      try {
        rollBtn.disabled = true;
        audio.playDiceRoll();
        this.beginDiceAnimation();
        await network.sendAction('roll_dice');
      } catch (err) {
        this.cancelDiceAnimation();
        rollBtn.disabled = false;
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    });

    // End turn button
    document.getElementById('btn-end-turn').addEventListener('click', async () => {
      try {
        const me = this.getMe();
        const unplayedCards = unplayedProgressCards(me?.progressCards);
        if (this.isCitiesKnights() && unplayedCards.length > 4) {
          this.showToast(i18n.t('ERROR_MUST_DISCARD_PROGRESS_CARD_BEFORE_ENDING_TURN'), true);
          this.checkProgressDiscardState();
          return;
        }
        this.clearActiveAction();
        await network.sendAction('end_turn');
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
        if (err.message === 'MUST_DISCARD_PROGRESS_CARD_BEFORE_ENDING_TURN') {
          this.checkProgressDiscardState();
        }
      }
    });

    document.getElementById('btn-pass-sbp')?.addEventListener('click', async () => {
      try {
        this.clearActiveAction();
        await network.sendAction('end_turn');
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    });

    // Build Settlement action
    document.getElementById('btn-build-settlement').addEventListener('click', () => {
      if (this.selectedAction && this.selectedAction.type === 'settlement') {
        this.clearActiveAction();
      } else {
        this.activateBuildSettlement();
      }
    });

    // Build Road action
    document.getElementById('btn-build-road').addEventListener('click', () => {
      if (this.selectedAction && this.selectedAction.type === 'road') {
        this.clearActiveAction();
      } else {
        this.activateBuildRoad();
      }
    });

    // Build City action
    document.getElementById('btn-build-city').addEventListener('click', () => {
      if (this.selectedAction && this.selectedAction.type === 'city') {
        this.clearActiveAction();
      } else {
        this.activateBuildCity();
      }
    });

    document.getElementById('btn-build-city-wall')?.addEventListener('click', (e) => {
      if (e.currentTarget?.disabled) return;
      if (this.selectedAction && this.selectedAction.type === 'wall') {
        this.clearActiveAction();
      } else {
        this.activateBuildCityWall();
      }
    });

    document.getElementById('btn-place-knight')?.addEventListener('click', () => {
      if (this.selectedAction && this.selectedAction.type === 'knight') {
        this.clearActiveAction();
      } else {
        this.activatePlaceKnight();
      }
    });

    // Buy Dev Card
    document.getElementById('btn-buy-dev-card').addEventListener('click', async () => {
      try {
        const res = await network.sendAction('buy_dev_card');
        audio.playBuild();
        if (res && res.cardType) {
          const cardName = i18n.t(`CARD_${res.cardType.toUpperCase()}`);
          this.showToast(`${i18n.t('DREW_DEV_CARD')} ${cardName}`);
        }
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    });

    // Zoom controls
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      this.boardRenderer.viewBox.width *= 0.85;
      this.boardRenderer.viewBox.height *= 0.85;
      this.boardRenderer.updateViewBox();
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      this.boardRenderer.viewBox.width *= 1.15;
      this.boardRenderer.viewBox.height *= 1.15;
      this.boardRenderer.updateViewBox();
    });

    document.getElementById('btn-zoom-reset').addEventListener('click', () => {
      this.boardRenderer.resetZoom();
    });

    // Tabs for Log & Chat
    document.getElementById('tab-btn-log').addEventListener('click', () => {
      document.getElementById('tab-btn-log').classList.add('active');
      document.getElementById('tab-btn-chat').classList.remove('active');
      document.getElementById('panel-log').classList.remove('is-hidden');
      document.getElementById('panel-chat').classList.add('is-hidden');
    });

    document.getElementById('tab-btn-chat').addEventListener('click', () => {
      document.getElementById('tab-btn-chat').classList.add('active');
      document.getElementById('tab-btn-log').classList.remove('active');
      document.getElementById('panel-chat').classList.remove('is-hidden');
      document.getElementById('panel-log').classList.add('is-hidden');
    });

    // Chat submit
    document.getElementById('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (text) {
        network.sendChat(text);
        input.value = '';
      }
    });
  }

  prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  numberDice() {
    return [document.getElementById('die-1'), document.getElementById('die-2')].filter(Boolean);
  }

  beginDiceAnimation() {
    this.clearDiceTimers();
    const reduced = this.prefersReducedMotion();
    this.diceAnim = { minElapsed: reduced, pending: null };
    this.numberDice().forEach(d => {
      d.classList.add('rolling');
      d.classList.remove('die-seven');
    });
    if (!reduced) {
      this.diceFaceTimer = setInterval(() => {
        this.numberDice().forEach(d => {
          d.textContent = String(1 + Math.floor(Math.random() * 6));
        });
      }, 90);
      this.diceSettleTimer = setTimeout(() => {
        if (this.diceAnim) {
          this.diceAnim.minElapsed = true;
          if (this.diceAnim.pending) this.settleDiceAnimation();
        }
      }, 520);
    }
  }

  cancelDiceAnimation() {
    this.clearDiceTimers();
    this.numberDice().forEach(d => d.classList.remove('rolling'));
    this.diceAnim = null;
  }

  clearDiceTimers() {
    if (this.diceFaceTimer) {
      clearInterval(this.diceFaceTimer);
      this.diceFaceTimer = null;
    }
    if (this.diceSettleTimer) {
      clearTimeout(this.diceSettleTimer);
      this.diceSettleTimer = null;
    }
  }

  settleDiceAnimation() {
    const pending = this.diceAnim?.pending || this.gameState?.dice;
    this.clearDiceTimers();
    this.diceAnim = null;
    const dice = this.numberDice();
    dice.forEach(d => d.classList.remove('rolling'));
    if (pending && pending.length >= 2) {
      document.getElementById('die-1').textContent = pending[0];
      document.getElementById('die-2').textContent = pending[1];
      document.getElementById('dice-sum').textContent = pending[0] + pending[1];
      if (pending[0] + pending[1] === 7) {
        dice.forEach(d => d.classList.add('die-seven'));
        const robberInPlay = !this.isCitiesKnights() || this.gameState?.barbariansHaveAttacked;
        this.showToast(i18n.t(robberInPlay ? 'ROBBER_ROLLED' : 'SEVEN_DISCARD_ONLY'), true);
        setTimeout(() => dice.forEach(d => d.classList.remove('die-seven')), 700);
      }
    }
    this.flushDeferredProductionToasts();
  }

  flushDeferredProductionToasts() {
    const queued = this.deferredProductionToasts.splice(0);
    queued.forEach(message => this.showToast(message));
  }

  setupHudOverlays() {
    const viewport = document.querySelector('.game-viewport-container');
    const toggle = document.getElementById('btn-toggle-sidebar');
    const backdrop = document.getElementById('hud-sidebar-backdrop');
    if (!viewport || !toggle || !backdrop) return;

    const setOpen = (open) => {
      viewport.classList.toggle('sidebar-open', open);
      backdrop.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    toggle.addEventListener('click', () => {
      setOpen(!viewport.classList.contains('sidebar-open'));
    });
    backdrop.addEventListener('click', () => setOpen(false));
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1024) setOpen(false);
    });
  }

  setupRendererInteractions() {
    this.boardRenderer.onVertexClick = async (vertexId) => {
      if (!this.gameState) return;
      const isSetup = this.gameState.phase === 'SETUP_ROUND_1' || this.gameState.phase === 'SETUP_ROUND_2';

      try {
        if (isSetup) {
          await network.sendAction('place_setup_settlement', { vertexId });
          audio.playBuild();
        } else if (this.selectedAction && this.selectedAction.type === 'settlement') {
          await network.sendAction('build_settlement', { vertexId });
          audio.playBuild();
          this.clearActiveAction();
        } else if (this.selectedAction && this.selectedAction.type === 'city') {
          await network.sendAction('build_city', { vertexId });
          audio.playBuild();
          this.clearActiveAction();
        } else if (this.selectedAction && this.selectedAction.type === 'wall') {
          await network.sendAction('build_city_wall', { vertexId });
          audio.playBuild();
          this.clearActiveAction();
        } else if (this.selectedAction && this.selectedAction.type === 'progress_vertex') {
          this.onProgressVertexPicked(vertexId);
        } else if (this.gameState.phase === 'TURN_CHOOSE_METROPOLIS' || (this.selectedAction && this.selectedAction.type === 'metropolis')) {
          await network.sendAction('choose_metropolis', { vertexId });
          audio.playBuild();
          this.clearActiveAction();
        } else if (this.selectedAction && this.selectedAction.type === 'knight') {
          await network.sendAction('place_knight', { vertexId });
          audio.playBuild();
          this.clearActiveAction();
        } else if (this.selectedAction && this.selectedAction.type === 'move_knight') {
          await this.confirmAndMoveKnight(this.selectedAction.fromVertexId, vertexId);
        } else if (this.gameState.phase === 'TURN_CHOOSE_KNIGHT_RELOCATE' || (this.selectedAction && this.selectedAction.type === 'relocate_knight')) {
          await network.sendAction('relocate_displaced_knight', { vertexId });
          audio.playBuild();
          this.clearActiveAction();
        } else if (this.gameState.phase === 'TURN_CHOOSE_DESERTER_KNIGHT' || (this.selectedAction && this.selectedAction.type === 'deserter_knight')) {
          await network.sendAction('choose_deserter_knight', { vertexId });
          audio.playBuild();
          this.clearActiveAction();
        } else if (this.gameState.phase === 'TURN_PLACE_DESERTER_KNIGHT' || (this.selectedAction && this.selectedAction.type === 'deserter_place')) {
          await network.sendAction('place_deserter_knight', { placeVertexId: vertexId });
          audio.playBuild();
          this.clearActiveAction();
        }
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    };

    this.boardRenderer.onEdgeClick = async (edgeId) => {
      if (!this.gameState) return;
      const isSetup = this.gameState.phase === 'SETUP_ROUND_1' || this.gameState.phase === 'SETUP_ROUND_2';

      try {
        if (isSetup) {
          await network.sendAction('place_setup_road', { edgeId });
          audio.playBuild();
        } else if (this.selectedAction && this.selectedAction.type === 'road') {
          const res = await network.sendAction('build_road', { edgeId });
          audio.playBuild();
          if (res && res.remainingFreeRoads > 0) {
            this.activateBuildRoad();
            this.showToast(i18n.t('ROAD_BUILDING_SECOND_ROAD'));
          } else {
            this.clearActiveAction();
          }
        } else if (this.selectedAction && (this.selectedAction.type === 'progress_road' || this.selectedAction.type === 'progress_road_replace')) {
          this.onProgressRoadPicked(edgeId);
        }
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    };

    this.boardRenderer.onHexClick = async (hexId) => {
      if (this.gameState && this.gameState.phase === 'TURN_ROBBER') {
        this.openRobberTargetModal(hexId);
        return;
      }
      if (this.selectedAction && this.selectedAction.type === 'progress_hex') {
        this.onProgressHexPicked(hexId);
        return;
      }
      if (this.selectedAction && this.selectedAction.type === 'chase_robber') {
        this.openRobberTargetModal(hexId, { chaseFrom: this.selectedAction.fromVertexId });
        return;
      }
      if (this.gameState && this.gameState.phase === 'TURN_ROBBER') {
        this.openRobberTargetModal(hexId);
      }
    };

    this.boardRenderer.onKnightClick = (vertexId, knight, evt) => {
      if (!this.gameState) return;
      if (this.selectedAction?.validIds?.has(vertexId) &&
        ['deserter_knight', 'deserter_place', 'progress_vertex'].includes(this.selectedAction.type)) {
        this.boardRenderer.onVertexClick?.(vertexId);
        return;
      }
      if (this.gameState.phase !== 'TURN_ACTION') return;
      const cur = this.gameState.players[this.gameState.currentTurnPlayerIndex];
      if (!cur || cur.id !== this.myPlayerId) return;
      evt?.stopPropagation();
      setTimeout(() => this.openKnightActionMenu(vertexId, knight, evt), 0);
    };

    document.addEventListener('click', (e) => {
      const menu = document.getElementById('knight-action-menu');
      if (!menu || menu.hidden) return;
      if (menu.contains(e.target)) return;
      this.closeKnightActionMenu();
    });
  }

  clearActiveAction() {
    this.selectedAction = null;
    document.querySelectorAll('.btn-build-action').forEach(b => b.classList.remove('btn-primary'));
    if (this.gameState && this.gameState.grid) {
      this.boardRenderer.render(this.gameState.grid, null, null, this.gameState.players);
    }
    this.updateBoardHint();
  }

  activateBuildSettlement() {
    if (!this.gameState || !this.gameState.grid) return;
    const validIds = new Set();
    const vertices = Object.values(this.gameState.grid.vertices);

    // Filter valid vertices (distance rule + road connection)
    vertices.forEach(v => {
      if (!v.building) {
        // Distance rule
        let validDist = true;
        for (const adjId of v.adjacentVertices) {
          if (this.gameState.grid.vertices[adjId] && this.gameState.grid.vertices[adjId].building) {
            validDist = false;
            break;
          }
        }
        if (validDist) {
          // Connected to own road
          const connected = v.adjacentEdges.some(eId => {
            const edge = this.gameState.grid.edges[eId];
            return edge && edge.road && edge.road.playerId === this.myPlayerId;
          });
          if (connected) validIds.add(v.id);
        }
      }
    });

    this.selectedAction = { type: 'settlement', validIds };
    document.getElementById('btn-build-settlement').classList.add('btn-primary');
    this.boardRenderer.render(this.gameState.grid, this.selectedAction);
    this.updateBoardHint();
  }

  activateBuildRoad() {
    if (!this.gameState || !this.gameState.grid) return;
    const validIds = new Set();
    const edges = Object.values(this.gameState.grid.edges);

    edges.forEach(edge => {
      if (!edge.road) {
        const v1 = this.gameState.grid.vertices[edge.v1];
        const v2 = this.gameState.grid.vertices[edge.v2];
        let connects = false;

        if ((v1.building && v1.building.playerId === this.myPlayerId) || (v2.building && v2.building.playerId === this.myPlayerId)) {
          connects = true;
        } else {
          for (const adjId of edge.adjacentEdges) {
            const adjEdge = this.gameState.grid.edges[adjId];
            if (adjEdge && adjEdge.road && adjEdge.road.playerId === this.myPlayerId) {
              connects = true;
              break;
            }
          }
        }
        if (connects) validIds.add(edge.id);
      }
    });

    this.selectedAction = { type: 'road', validIds };
    document.getElementById('btn-build-road').classList.add('btn-primary');
    this.boardRenderer.render(this.gameState.grid, this.selectedAction);
    this.updateBoardHint();
  }

  activateBuildCity() {
    if (!this.gameState || !this.gameState.grid) return;
    const validIds = new Set();
    const vertices = Object.values(this.gameState.grid.vertices);

    vertices.forEach(v => {
      if (v.building && v.building.type === 'settlement' && v.building.playerId === this.myPlayerId) {
        validIds.add(v.id);
      }
    });

    this.selectedAction = { type: 'city', validIds };
    document.getElementById('btn-build-city').classList.add('btn-primary');
    this.boardRenderer.render(this.gameState.grid, this.selectedAction, null, this.gameState.players);
    this.updateBoardHint();
  }

  activateBuildCityWall() {
    if (!this.gameState || !this.gameState.grid) return;
    const wallBtn = document.getElementById('btn-build-city-wall');
    if (wallBtn?.disabled) return;
    const validIds = new Set();
    Object.values(this.gameState.grid.vertices).forEach(v => {
      if (isCityWallHost(v.building) && v.building.playerId === this.myPlayerId && !v.building.hasWall) {
        validIds.add(v.id);
      }
    });
    this.selectedAction = { type: 'wall', validIds };
    wallBtn?.classList.add('btn-primary');
    this.boardRenderer.render(this.gameState.grid, this.selectedAction);
    this.updateBoardHint();
  }

  vertexHasOwnRoad(vertex) {
    return (vertex.adjacentEdges || []).some(eId => {
      const edge = this.gameState.grid.edges[eId];
      return edge && edge.road && edge.road.playerId === this.myPlayerId;
    });
  }

  verticesShareOwnRoad(fromId, toId) {
    const from = this.gameState.grid.vertices[fromId];
    if (!from) return false;
    return (from.adjacentEdges || []).some(eId => {
      const edge = this.gameState.grid.edges[eId];
      if (!edge?.road || edge.road.playerId !== this.myPlayerId) return false;
      return edge.v1 === toId || edge.v2 === toId;
    });
  }

  distanceClear(vertexId, ignore = []) {
    const v = this.gameState.grid.vertices[vertexId];
    if (!v) return false;
    return (v.adjacentVertices || []).every(adjId => {
      if (ignore.includes(adjId)) return true;
      const adj = this.gameState.grid.vertices[adjId];
      return !adj?.building;
    });
  }

  collectKnightPlaceTargets() {
    const validIds = new Set();
    Object.values(this.gameState.grid.vertices).forEach(v => {
      if (v.building || v.knight) return;
      if (!this.vertexHasOwnRoad(v)) return;
      validIds.add(v.id);
    });
    return validIds;
  }

  collectKnightMoveTargets(fromVertexId, strength) {
    const validIds = new Set();
    const visited = new Set([fromVertexId]);
    const queue = [fromVertexId];
    while (queue.length) {
      const cur = queue.shift();
      const vertex = this.gameState.grid.vertices[cur];
      if (!vertex) continue;
      for (const adjId of vertex.adjacentVertices || []) {
        if (!this.verticesShareOwnRoad(cur, adjId)) continue;
        if (visited.has(adjId)) continue;
        visited.add(adjId);
        const dest = this.gameState.grid.vertices[adjId];
        if (!dest) continue;
        if (dest.knight) {
          if (dest.knight.playerId !== this.myPlayerId && dest.knight.strength < strength) {
            validIds.add(adjId);
          }
          continue;
        }
        if (dest.building) {
          queue.push(adjId);
          continue;
        }
        validIds.add(adjId);
        queue.push(adjId);
      }
    }
    return validIds;
  }

  activatePlaceKnight() {
    if (!this.isCitiesKnights() || !this.gameState?.grid) return;
    const me = this.gameState.players.find(p => p.id === this.myPlayerId);
    if ((me?.knightsAvailable?.basic || 0) <= 0) {
      this.showToast(i18n.t('ERROR_NO_KNIGHTS_AVAILABLE'), true);
      return;
    }
    const validIds = this.collectKnightPlaceTargets();
    if (validIds.size === 0) {
      this.showToast(i18n.t('ERROR_NO_LEGAL_KNIGHT_SPOTS'), true);
      return;
    }
    this.selectedAction = { type: 'knight', validIds };
    document.getElementById('btn-place-knight')?.classList.add('btn-primary');
    this.boardRenderer.render(this.gameState.grid, this.selectedAction, null, this.gameState.players);
    this.updateBoardHint();
  }

  activateMoveKnight(fromVertexId, knight) {
    const validIds = this.collectKnightMoveTargets(fromVertexId, knight.strength || 1);
    this.selectedAction = { type: 'move_knight', fromVertexId, validIds };
    this.closeKnightActionMenu();
    this.boardRenderer.render(this.gameState.grid, this.selectedAction, null, this.gameState.players);
    this.updateBoardHint();
  }

  activateChaseRobber(fromVertexId) {
    this.selectedAction = { type: 'chase_robber', fromVertexId };
    this.closeKnightActionMenu();
    this.boardRenderer.render(this.gameState.grid, this.selectedAction, null, this.gameState.players);
    this.updateBoardHint();
  }

  closeKnightActionMenu() {
    this.ckView.closeKnightActionMenu();
  }

  openKnightActionMenu(vertexId, knight, evt) {
    this.ckView.openKnightActionMenu(vertexId, knight, evt, {
      activateMoveKnight: (v, k) => this.activateMoveKnight(v, k),
      activateChaseRobber: (v) => this.activateChaseRobber(v)
    });
  }

  confirmAndMoveKnight(fromVertexId, toVertexId) {
    return this.ckView.confirmAndMoveKnight(fromVertexId, toVertexId);
  }

  setupCkUi() {
    this.ckView.setupCkUi();
  }

  claimAqueductChoice(resource) {
    return this.ckView.claimAqueductChoice(resource);
  }

  checkAqueductChooser() {
    this.ckView.checkAqueductChooser();
  }

  renderCkHud(s, me, isActionPhase, notTurnReason) {
    this.ckView.renderCkHud(s, me, isActionPhase, notTurnReason);
  }

  renderWallSupplyAndButton(s, me, isActionPhase, notTurnReason) {
    this.ckView.renderWallSupplyAndButton(s, me, isActionPhase, notTurnReason);
  }

  renderKnightSupply(me, isActionPhase) {
    this.ckView.renderKnightSupply(me, isActionPhase);
  }

  renderBankSupply(bank, isCk) {
    this.ckView.renderBankSupply(bank, isCk);
  }

  renderKnightsOverview(overview) {
    this.ckView.renderKnightsOverview(overview);
  }

  populateKnightsModal(overview) {
    this.ckView.populateKnightsModal(overview);
  }

  renderEventDie(s) {
    this.ckView.renderEventDie(s);
  }

  renderBarbarianTrack(s) {
    this.ckView.renderBarbarianTrack(s);
  }

  renderImprovementPanel(me, isActionPhase) {
    this.ckView.renderImprovementPanel(me, isActionPhase);
  }

  renderBarbarianOverlay(s, me) {
    this.ckView.renderBarbarianOverlay(s, me);
  }

  /* =========================================================
   * ROBBER & DISCARD MODALS
   * ========================================================= */
  setupDiscardModal() {
    this.discardModal.setupDiscardModal();
  }

  syncPhaseTimer(tickData = null) {
    const s = this.gameState;
    const isMyTurn = !!(s && s.players && s.players[s.currentTurnPlayerIndex]?.id === this.myPlayerId);
    if (s && s.phase === 'TURN_DISCARD' && s.discardDeadline) {
      this.turnTimerUI.syncDiscard({
        discardDeadline: s.discardDeadline,
        isPendingDiscard: playerMustDiscard(s.pendingDiscards, this.myPlayerId)
      });
      return;
    }
    if (s && s.phase === 'TURN_ROBBER' && s.robberDeadline) {
      this.turnTimerUI.syncRobber({
        robberDeadline: s.robberDeadline,
        isMyTurn
      });
      return;
    }
    if (tickData) {
      this.turnTimerUI.update({
        remaining: tickData.remaining,
        duration: tickData.duration,
        isMyTurn
      });
    } else if (this.currentRoom) {
      this.turnTimerUI.update({
        remaining: this.currentRoom.turnTimeRemaining,
        duration: this.currentRoom.turnDuration,
        isMyTurn
      });
    }
  }

  checkDiscardState() {
    this.discardModal.checkDiscardState();
  }

  startDiscardCountdown() {
    this.discardModal.startDiscardCountdown();
  }

  stopDiscardCountdown() {
    this.discardModal.stopDiscardCountdown();
  }

  setupProgressChoiceModal() {
    const modal = document.getElementById('progress-choice-modal');
    const submit = document.getElementById('btn-submit-progress-choice');
    if (!modal || !submit) return;
    this.progressChoicePicks = [];

    submit.addEventListener('click', async () => {
      const pending = this.gameState?.pendingProgressChoice;
      if (!pending?.pending?.includes(this.myPlayerId)) return;
      try {
        submit.disabled = true;
        if (pending.kind === 'wedding') {
          await network.sendAction('respond_progress_choice', { cards: this.progressChoicePicks });
        } else if (pending.kind === 'commercial_harbor' && this.progressChoicePicks[0]) {
          await network.sendAction('respond_progress_choice', { commodity: this.progressChoicePicks[0] });
        }
        modal.classList.remove('active');
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
        submit.disabled = false;
      }
    });
  }

  checkProgressChoiceState() {
    const modal = document.getElementById('progress-choice-modal');
    if (!modal || !this.gameState) return;
    this.myPlayerId = network.currentPlayerId || this.myPlayerId;
    const pending = this.gameState.pendingProgressChoice;
    const mine = pending && this.gameState.phase === 'TURN_CHOOSE_PROGRESS_RESPONSE'
      && pending.pending?.includes(this.myPlayerId);

    if (!mine) {
      modal.classList.remove('active');
      this.stopProgressChoiceCountdown();
      this.progressChoiceKey = null;
      return;
    }

    const me = this.gameState.players.find(p => p.id === this.myPlayerId);
    const choiceKey = `${pending.kind}:${pending.deadline}:${pending.playerId}:${this.myPlayerId}`;
    if (this.progressChoiceKey === choiceKey && modal.classList.contains('active')) {
      this.startProgressChoiceCountdown();
      return;
    }
    this.progressChoiceKey = choiceKey;

    const title = document.getElementById('progress-choice-title');
    const hint = document.getElementById('progress-choice-hint');
    const buttons = document.getElementById('progress-choice-buttons');
    const submit = document.getElementById('btn-submit-progress-choice');
    const host = this.gameState.players.find(p => p.id === pending.playerId);
    this.progressChoicePicks = [];

    if (pending.kind === 'wedding') {
      const need = Math.min(2, this.countPlayerTotalCards(me));
      if (title) title.textContent = i18n.t('PROGRESS_CHOICE_WEDDING_TITLE');
      if (hint) hint.textContent = i18n.t('PROGRESS_CHOICE_WEDDING_HINT', { name: host?.name || '', count: need });
      if (buttons) {
        buttons.innerHTML = this.getHandCardTypes().map(type => {
          const count = this.getCardCount(me, type);
          return `<button type="button" class="btn-glass res-choice-btn" data-type="${type}" ${count < 1 ? 'disabled' : ''}>${this.cardLabel(type)} (${count})</button>`;
        }).join('');
        buttons.querySelectorAll('.res-choice-btn:not([disabled])').forEach(btn => {
          btn.addEventListener('click', () => {
            if (this.progressChoicePicks.length >= need) return;
            this.progressChoicePicks.push(btn.dataset.type);
            btn.disabled = this.getCardCount(me, btn.dataset.type) <= this.progressChoicePicks.filter(t => t === btn.dataset.type).length;
            if (submit) submit.disabled = this.progressChoicePicks.length !== need;
          });
        });
      }
      if (submit) {
        submit.textContent = i18n.t('PROGRESS_CHOICE_GIVE');
        submit.disabled = need === 0;
        submit.classList.remove('is-hidden');
      }
    } else if (pending.kind === 'commercial_harbor') {
      if (title) title.textContent = i18n.t('PROGRESS_CHOICE_HARBOR_TITLE');
      if (hint) hint.textContent = i18n.t('PROGRESS_CHOICE_HARBOR_HINT', { name: host?.name || '', resource: this.cardLabel(pending.resource) });
      if (buttons) {
        buttons.innerHTML = ['cloth', 'coin', 'paper'].map(type => {
          const count = this.getCardCount(me, type);
          return `<button type="button" class="btn-glass res-choice-btn" data-type="${type}" ${count < 1 ? 'disabled' : ''}>${this.cardLabel(type)} (${count})</button>`;
        }).join('');
        buttons.querySelectorAll('.res-choice-btn:not([disabled])').forEach(btn => {
          btn.addEventListener('click', async () => {
            try {
              await network.sendAction('respond_progress_choice', { commodity: btn.dataset.type });
              modal.classList.remove('active');
            } catch (err) {
              this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
            }
          });
        });
      }
      if (submit) submit.classList.add('is-hidden');
    }

    modal.classList.add('active');
    this.startProgressChoiceCountdown();
  }

  startProgressChoiceCountdown() {
    this.stopProgressChoiceCountdown();
    const el = document.getElementById('progress-choice-timer');
    if (!el) return;
    const tick = () => {
      const deadline = this.gameState?.pendingProgressChoice?.deadline;
      if (!deadline) {
        el.textContent = '';
        return;
      }
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      el.textContent = `${secs}s`;
      el.style.color = secs <= 10 ? '#ef4444' : 'var(--gold-primary)';
    };
    tick();
    this.progressChoiceTimerInterval = setInterval(tick, 500);
  }

  stopProgressChoiceCountdown() {
    if (this.progressChoiceTimerInterval) {
      clearInterval(this.progressChoiceTimerInterval);
      this.progressChoiceTimerInterval = null;
    }
  }

  openRobberTargetModal(hexId, options = {}) {
    this.discardModal.openRobberTargetModal(hexId, options);
  }

  /* =========================================================
   * TRADE MODAL (Domestic & Bank / Port)
   * ========================================================= */
  getBestBankRatio(resource) {
    return this.tradeModal.getBestBankRatio(resource);
  }

  renderBankTradeUI() {
    return this.tradeModal.renderBankTradeUI();
  }

  setupTradeModals() {
    return this.tradeModal.setupTradeModals();
  }

  setupDevCardsModal() {
    return this.devCardsModal.setupDevCardsModal();
  }

  renderDevCardsList() {
    return this.devCardsModal.renderDevCardsList();
  }

  setupProgressCardUi() {
    document.getElementById('btn-close-progress-card')?.addEventListener('click', () => this.closeProgressCardModal());
    document.getElementById('btn-cancel-progress-card')?.addEventListener('click', () => this.closeProgressCardModal());
    document.getElementById('btn-play-progress-card')?.addEventListener('click', () => this.confirmProgressCardPlay());

    document.getElementById('btn-pick-progress-board')?.addEventListener('click', () => {
      if (!this.progressPlay) return;
      const cardType = this.progressPlay.card.type;
      document.getElementById('progress-card-modal')?.classList.remove('active');
      this.beginProgressBoardPick(cardType);
      const banner = document.getElementById('board-pick-banner');
      const bannerText = document.getElementById('board-pick-banner-text');
      if (banner && bannerText) {
        const hintKey = `CARD_${cardType.toUpperCase()}`;
        bannerText.textContent = `🎯 Select ${i18n.t(hintKey) || cardType} target on the board`;
        banner.classList.remove('is-hidden');
      }
    });

    document.getElementById('btn-cancel-board-pick')?.addEventListener('click', () => {
      const banner = document.getElementById('board-pick-banner');
      if (banner) banner.classList.add('is-hidden');
      this.progressPlay = null;
      this.clearActiveAction();
    });

    // Knights Overview Modal Listeners
    document.getElementById('btn-open-knights-modal')?.addEventListener('click', () => {
      const modal = document.getElementById('knights-overview-modal');
      if (!modal) return;
      if (this.gameState?.knightsOverview) {
        this.populateKnightsModal(this.gameState.knightsOverview);
      }
      modal.classList.add('active');
    });

    document.querySelectorAll('#btn-close-knights-modal, #btn-close-knights-modal-x').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('knights-overview-modal')?.classList.remove('active');
      });
    });
  }

  getMe() {
    if (!this.gameState) return null;
    return this.gameState.players.find(p => p.id === this.myPlayerId) || null;
  }

  opponentRevealedProgressHtml(player) {
    if (!this.isCitiesKnights()) return '';
    const revealed = Array.isArray(player.progressCards)
      ? revealedProgressCards(player.progressCards)
      : (player.progressCards?.revealed || []);
    if (!revealed.length) return '';
    return `<div class="progress-special-cards">${revealed.map(c =>
      `<span class="progress-special-chip">${i18n.t(`CARD_${c.type.toUpperCase()}`)}</span>`
    ).join('')}</div>`;
  }

  renderProgressCardHand() {
    const panel = document.getElementById('progress-cards-panel');
    if (!panel) return;
    if (!this.isCitiesKnights()) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    const me = this.getMe();
    const cards = unplayedProgressCards(me?.progressCards);
    const title = document.getElementById('progress-cards-title');
    if (title) title.textContent = i18n.t('PROGRESS_CARDS_TITLE', { count: cards.length });
    const limit = document.getElementById('progress-cards-limit');
    panel.classList.toggle('at-limit', cards.length >= 4);
    if (limit) limit.textContent = cards.length >= 4 ? i18n.t('PROGRESS_CARDS_AT_LIMIT') : '';

    const hand = document.getElementById('progress-card-hand');
    if (hand) {
      hand.innerHTML = cards.map(card => {
        const deck = getProgressDeck(card.type);
        const name = i18n.t(`CARD_${card.type.toUpperCase()}`);
        const desc = i18n.t(`CARD_${card.type.toUpperCase()}_DESC`);
        const mods = progressCardHandModifiers(card, this.gameState?.turnNumber);
        const title = mods.locked ? i18n.t(mods.titleKey) : desc;
        const lockMarkup = mods.locked
          ? `<span class="dev-card-rule-badge progress-card-lock-badge">${i18n.t(mods.badgeKey)}</span>`
          : '';
        return `<button type="button" class="progress-card card-${deck} progress-card-reveal${mods.extraClass ? ` ${mods.extraClass}` : ''}" data-card-id="${card.id}" title="${title}">
          <span class="card-icon">${PROGRESS_CARD_ICONS[card.type] || '◆'}</span>
          <span class="card-name">${name}</span>
          ${lockMarkup}
        </button>`;
      }).join('');
      hand.querySelectorAll('.progress-card').forEach(el => {
        el.addEventListener('click', () => this.openProgressCardModal(el.dataset.cardId));
      });
    }

    const special = document.getElementById('progress-special-cards');
    if (special) {
      const revealed = revealedProgressCards(me?.progressCards);
      special.innerHTML = revealed.length
        ? `<div class="progress-special-label">${i18n.t('PROGRESS_SPECIAL_TITLE')}</div>` +
        revealed.map(c => `<span class="progress-special-chip">${i18n.t(`CARD_${c.type.toUpperCase()}`)} +1 VP</span>`).join('')
        : '';
    }

    const badge = document.getElementById('dev-card-badge');
    if (badge) {
      badge.textContent = cards.length;
      badge.style.display = cards.length > 0 ? 'inline-flex' : 'none';
    }
  }

  notifyProgressDraws(s) {
    const meId = this.myPlayerId;
    for (const draw of s.pendingProgressDraws || []) {
      const key = `${s.turnNumber}-${draw.playerId}-${draw.cardType}-${draw.drawn}`;
      if (this.seenProgressDrawKeys.has(key)) continue;
      this.seenProgressDrawKeys.add(key);
      if (draw.playerId === meId && draw.drawn && draw.cardType) {
        const name = i18n.t(`CARD_${String(draw.cardType).toUpperCase()}`);
        this.showToast(i18n.t('DREW_PROGRESS_CARD', { card: name }));
      }
    }
  }

  checkProgressDiscardState() {
    const modal = document.getElementById('progress-discard-modal');
    if (!modal || !this.gameState) return;
    const pending = this.gameState.pendingProgressDiscard || [];
    const mustDiscard = this.isCitiesKnights() && pending.includes(this.myPlayerId);
    if (!mustDiscard) {
      modal.classList.remove('active');
      return;
    }
    const me = this.getMe();
    const cards = unplayedProgressCards(me?.progressCards);
    const list = document.getElementById('progress-discard-list');
    if (list) {
      list.innerHTML = cards.map(card => `
        <button type="button" class="btn-glass progress-discard-item" data-card-id="${card.id}">
          ${PROGRESS_CARD_ICONS[card.type] || ''} ${i18n.t(`CARD_${card.type.toUpperCase()}`)}
        </button>`).join('');
      list.querySelectorAll('.progress-discard-item').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await network.sendAction('discard_progress_card', { cardId: btn.dataset.cardId });
          } catch (err) {
            this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
          }
        });
      });
    }
    modal.classList.add('active');
  }

  openProgressCardModal(cardId) {
    const me = this.getMe();
    const card = (me?.progressCards || []).find(c => c.id === cardId && !c.played);
    if (!card) return;
    this.progressPlay = { card, options: {}, picks: [] };
    const modal = document.getElementById('progress-card-modal');
    document.getElementById('progress-card-modal-title').textContent = i18n.t(`CARD_${card.type.toUpperCase()}`);
    document.getElementById('progress-card-modal-desc').textContent = i18n.t(`CARD_${card.type.toUpperCase()}_DESC`);
    this.renderCardTargetSelector(card);
    const playBtn = document.getElementById('btn-play-progress-card');
    if (playBtn && isProgressCardBoughtThisTurn(card, this.gameState?.turnNumber)) {
      playBtn.disabled = true;
    }
    modal.classList.add('active');
  }

  closeProgressCardModal() {
    document.getElementById('progress-card-modal')?.classList.remove('active');
    const banner = document.getElementById('board-pick-banner');
    if (banner) banner.classList.add('is-hidden');
    this.progressPlay = null;
    if (this.selectedAction && String(this.selectedAction.type).startsWith('progress_')) {
      this.clearActiveAction();
    }
  }

  countPlayerCommodities(p) {
    if (!p || !p.commodities) return 0;
    if (typeof p.commodities.total === 'number') return p.commodities.total;
    return Object.values(p.commodities).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  }

  countPlayerTotalCards(p) {
    if (!p) return 0;
    const res = typeof p.resources?.total === 'number' ? p.resources.total : Object.values(p.resources || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const com = this.countPlayerCommodities(p);
    return res + com;
  }

  renderCardTargetSelector(card) {
    const box = document.getElementById('progress-card-target-ui');
    const pickBoardBtn = document.getElementById('btn-pick-progress-board');
    const playBtn = document.getElementById('btn-play-progress-card');
    if (!box) return;
    box.innerHTML = '';
    if (pickBoardBtn) pickBoardBtn.classList.add('is-hidden');

    const type = card.type;
    const me = this.getMe();
    const isMyTurn = this.gameState?.currentPlayerId === this.myPlayerId;
    const boughtThisTurn = isProgressCardBoughtThisTurn(card, this.gameState?.turnNumber);
    const isActionPhase = this.gameState?.phase === 'TURN_ACTION' && isMyTurn && !boughtThisTurn;

    if (boughtThisTurn) {
      box.innerHTML = `<div class="progress-bought-lock"><span class="dev-card-rule-badge">${escapeHtml(i18n.t('CANNOT_PLAY_TURN_BOUGHT'))}</span></div>`;
      if (playBtn) playBtn.disabled = true;
      return;
    }

    if (type === 'alchemist') {
      box.innerHTML = `<div class="alchemist-dice-row">
        <label>${i18n.t('PROGRESS_DIE_1')}<select id="alchemist-d1">${[1, 2, 3, 4, 5, 6].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <label>${i18n.t('PROGRESS_DIE_2')}<select id="alchemist-d2">${[1, 2, 3, 4, 5, 6].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
      </div>`;
      if (playBtn) playBtn.disabled = !(this.gameState.phase === 'TURN_ROLL' && isMyTurn);
      return;
    }

    if (type === 'resource_monopoly') {
      box.innerHTML = `<div>${i18n.t('PROGRESS_SELECT_RESOURCE')}</div>
        <div class="modal-res-buttons-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:6px;">
          ${['wood','brick','wool','wheat','ore'].map(r => `<button type="button" class="btn-glass res-choice-btn" data-res="${r}">${this.cardLabel(r)}</button>`).join('')}
        </div>`;
      if (playBtn) playBtn.disabled = true;
      box.querySelectorAll('.res-choice-btn').forEach(b => {
        b.addEventListener('click', () => {
          this.progressPlay.options.resource = b.dataset.res;
          box.querySelectorAll('.res-choice-btn').forEach(x => x.classList.remove('btn-primary'));
          b.classList.add('btn-primary');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    if (type === 'trade_monopoly') {
      box.innerHTML = `<div>${i18n.t('PROGRESS_SELECT_COMMODITY')}</div>
        <div class="modal-res-buttons-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px;">
          ${['cloth','coin','paper'].map(c => `<button type="button" class="btn-glass res-choice-btn" data-com="${c}">${this.cardLabel(c)}</button>`).join('')}
        </div>`;
      if (playBtn) playBtn.disabled = true;
      box.querySelectorAll('.res-choice-btn').forEach(b => {
        b.addEventListener('click', () => {
          this.progressPlay.options.commodity = b.dataset.com;
          box.querySelectorAll('.res-choice-btn').forEach(x => x.classList.remove('btn-primary'));
          b.classList.add('btn-primary');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    if (type === 'merchant_fleet') {
      const types = this.getHandCardTypes();
      box.innerHTML = `<div>${i18n.t('PROGRESS_SELECT_RESOURCE_OR_COMMODITY')}</div>
        <div class="modal-res-buttons-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px;">
          ${types.map(r => `<button type="button" class="btn-glass res-choice-btn" data-res="${r}">${this.cardLabel(r)}</button>`).join('')}
        </div>`;
      if (playBtn) playBtn.disabled = true;
      box.querySelectorAll('.res-choice-btn').forEach(b => {
        b.addEventListener('click', () => {
          this.progressPlay.options.resource = b.dataset.res;
          box.querySelectorAll('.res-choice-btn').forEach(x => x.classList.remove('btn-primary'));
          b.classList.add('btn-primary');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    if (type === 'commercial_harbor') {
      const available = ['wood', 'brick', 'wool', 'wheat', 'ore'].filter(r => (me?.resources?.[r] || 0) > 0);
      const opponentsWithCom = (this.gameState?.players || []).filter(p => p.id !== this.myPlayerId && this.countPlayerCommodities(p) > 0);

      if (available.length === 0) {
        box.innerHTML = `<div class="progress-notice-box warning">
          <p>You have no resources to give. You need at least 1 resource to trade with opponents.</p>
        </div>`;
        if (playBtn) playBtn.disabled = true;
        return;
      }

      box.innerHTML = `<div>Select 1 resource to offer to opponents in exchange for their commodities:</div>
        <div class="modal-res-buttons-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin:8px 0;">
          ${['wood', 'brick', 'wool', 'wheat', 'ore'].map(r => {
        const count = me?.resources?.[r] || 0;
        return `<button type="button" class="btn-glass res-choice-btn" data-res="${r}" ${count < 1 ? 'disabled' : ''}>${this.cardLabel(r)} (${count})</button>`;
      }).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-secondary);">
          ${opponentsWithCom.length > 0
          ? `Opponents holding commodities: ${opponentsWithCom.map(p => escapeHtml(p.name)).join(', ')}. Each will choose which commodity to give.`
          : 'Notice: Opponents currently hold 0 commodities.'}
        </div>`;

      if (playBtn) playBtn.disabled = true;
      box.querySelectorAll('.res-choice-btn:not([disabled])').forEach(b => {
        b.addEventListener('click', () => {
          this.progressPlay.options.resource = b.dataset.res;
          box.querySelectorAll('.res-choice-btn').forEach(x => x.classList.remove('btn-primary'));
          b.classList.add('btn-primary');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    if (type === 'wedding') {
      const myVp = me?.victoryPoints || 0;
      const targets = (this.gameState?.players || []).filter(p => p.id !== this.myPlayerId && (p.victoryPoints || 0) > myVp);

      if (targets.length === 0) {
        box.innerHTML = `<div class="progress-notice-box warning">
          <p>No opponent currently has more victory points than you (${myVp} VP). Wedding requires at least one opponent with strictly more VP.</p>
        </div>`;
        if (playBtn) playBtn.disabled = true;
      } else {
        box.innerHTML = `<div class="progress-notice-box info">
          <p>💍 <strong>Opponents with more VP must each choose up to 2 cards to give you:</strong></p>
          <ul style="margin: 6px 0 0 16px;">
            ${targets.map(p => `<li><strong>${escapeHtml(p.name)}</strong> (${p.victoryPoints} VP, ${this.countPlayerTotalCards(p)} cards)</li>`).join('')}
          </ul>
          <p style="margin-top:8px;font-size:12px;color:var(--text-secondary);">They pick after you play this card. Cards are not taken automatically.</p>
        </div>`;
        if (playBtn) playBtn.disabled = !isActionPhase;
      }
      return;
    }

    if (type === 'merchant') {
      const mine = new Set([...(me?.settlementsBuilt || []), ...(me?.citiesBuilt || [])]);
      const validHexIds = new Set();
      Object.values(this.gameState?.grid?.vertices || {}).forEach(v => {
        if (mine.has(v.id) && v.hexes) v.hexes.forEach(hid => validHexIds.add(hid));
      });

      const validHexes = Array.from(validHexIds).map(id => this.gameState.grid.hexes[id]).filter(Boolean);

      if (validHexes.length === 0) {
        box.innerHTML = `<div class="progress-notice-box warning"><p>You must have a settlement or city adjacent to a hex to place the Merchant.</p></div>`;
        if (playBtn) playBtn.disabled = true;
        return;
      }

      box.innerHTML = `<div>Choose an adjacent hex to place the Merchant (gives 2:1 bank trade & 1 VP):</div>
        <div class="progress-target-grid">
          ${validHexes.map(h => {
        const tokenStr = h.token ? ` (#${h.token})` : '';
        return `<button type="button" class="btn-glass progress-target-card-btn" data-hex-id="${h.id}">
              <span>${this.cardLabel(h.resource)}${tokenStr}</span>
            </button>`;
      }).join('')}
        </div>`;

      if (pickBoardBtn) pickBoardBtn.classList.remove('is-hidden');
      if (playBtn) playBtn.disabled = true;

      box.querySelectorAll('.progress-target-card-btn').forEach(b => {
        b.addEventListener('click', () => {
          this.progressPlay.options.hexId = b.dataset.hexId;
          box.querySelectorAll('.progress-target-card-btn').forEach(x => x.classList.remove('selected'));
          b.classList.add('selected');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    if (type === 'engineer') {
      const unwalled = (me?.citiesBuilt || []).filter(vid => {
        const v = this.gameState?.grid?.vertices?.[vid];
        return isCityWallHost(v?.building) && !v.building.hasWall;
      });

      if (unwalled.length === 0) {
        box.innerHTML = `<div class="progress-notice-box warning"><p>You have no unwalled cities to build a wall on.</p></div>`;
        if (playBtn) playBtn.disabled = true;
        return;
      }

      box.innerHTML = `<div>Choose a city to fortify with a city wall for free:</div>
        <div class="progress-target-grid">
          ${unwalled.map(vid => {
        const v = this.gameState.grid.vertices[vid];
        const hexes = (v.hexes || []).map(hid => this.cardLabel(this.gameState.grid.hexes[hid]?.resource)).filter(Boolean).join(', ');
        return `<button type="button" class="btn-glass progress-target-card-btn" data-vertex-id="${vid}">
              <span>🏰 City (${hexes || vid})</span>
            </button>`;
      }).join('')}
        </div>`;

      if (pickBoardBtn) pickBoardBtn.classList.remove('is-hidden');
      if (playBtn) playBtn.disabled = true;

      box.querySelectorAll('.progress-target-card-btn').forEach(b => {
        b.addEventListener('click', () => {
          this.progressPlay.options.vertexId = b.dataset.vertexId;
          box.querySelectorAll('.progress-target-card-btn').forEach(x => x.classList.remove('selected'));
          b.classList.add('selected');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    if (type === 'smith') {
      const politics = me?.cityImprovements?.politics || 0;
      const promotable = (me?.knightsPlaced || []).filter(k => {
        if (k.rank === 'mighty') return false;
        if (k.rank === 'strong' && politics < 3) return false;
        return true;
      });
      if (promotable.length === 0) {
        box.innerHTML = `<div class="progress-notice-box warning"><p>You have no knights that can be promoted.</p></div>`;
        if (playBtn) playBtn.disabled = true;
        return;
      }

      box.innerHTML = `<div>Select up to 2 knights to promote for free (or click Pick on Board):</div>
        <div class="progress-target-grid">
          ${promotable.map(k => `
            <button type="button" class="btn-glass progress-target-card-btn" data-vertex-id="${k.vertexId}">
              <span>⚔️ ${k.rank.toUpperCase()} (Str ${k.strength})</span>
            </button>
          `).join('')}
        </div>`;

      if (pickBoardBtn) pickBoardBtn.classList.remove('is-hidden');
      if (playBtn) playBtn.disabled = true;

      const selected = new Set();
      box.querySelectorAll('.progress-target-card-btn').forEach(b => {
        b.addEventListener('click', () => {
          const vid = b.dataset.vertexId;
          if (selected.has(vid)) {
            selected.delete(vid);
            b.classList.remove('selected');
          } else {
            if (selected.size < 2) {
              selected.add(vid);
              b.classList.add('selected');
            }
          }
          this.progressPlay.options.knightVertices = Array.from(selected);
          if (playBtn) playBtn.disabled = selected.size === 0 || !isActionPhase;
        });
      });
      return;
    }

    if (type === 'spy') {
      const opponents = (this.gameState?.players || []).filter(p => p.id !== this.myPlayerId);
      box.innerHTML = `<div>${i18n.t('PROGRESS_SELECT_OPPONENT')}</div>
        <div class="modal-res-buttons-grid" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
          ${opponents.map(p => {
        const count = Array.isArray(p.progressCards)
          ? unplayedProgressCards(p.progressCards).length
          : Math.max(0, (p.progressCards?.count || 0) - (p.progressCards?.revealed?.length || 0));
        return `<button type="button" class="btn-glass progress-target-btn" data-id="${p.id}">${escapeHtml(p.name)} (${count} cards)</button>`;
      }).join('')}
        </div>`;
      if (playBtn) playBtn.disabled = true;
      box.querySelectorAll('.progress-target-btn').forEach(b => {
        b.addEventListener('click', () => {
          if (this.progressPlay.peekLocked) return;
          this.progressPlay.options.targetPlayerId = b.dataset.id;
          delete this.progressPlay.options.stealCardId;
          box.querySelectorAll('.progress-target-btn').forEach(x => x.classList.remove('btn-primary'));
          b.classList.add('btn-primary');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    if (type === 'deserter') {
      const opponentsWithKnights = (this.gameState?.players || []).filter(p => {
        if (p.id === this.myPlayerId) return false;
        return (p.knightsPlaced || []).some(k => k.vertexId);
      });
      if (opponentsWithKnights.length === 0) {
        box.innerHTML = `<div class="progress-notice-box warning">
          <p>${i18n.t('ERROR_TARGET_HAS_NO_KNIGHTS')}</p>
        </div>`;
        if (playBtn) playBtn.disabled = true;
        return;
      }
      box.innerHTML = `<div>${i18n.t('PROGRESS_SELECT_DESERTER_OPPONENT')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0;">
          ${opponentsWithKnights.map(p => {
        const count = (p.knightsPlaced || []).filter(k => k.vertexId).length;
        return `<button type="button" class="btn-glass progress-target-btn" data-id="${p.id}">${escapeHtml(p.name)} (${count})</button>`;
      }).join('')}
        </div>`;
      if (playBtn) playBtn.disabled = true;
      box.querySelectorAll('.progress-target-btn').forEach(b => {
        b.addEventListener('click', () => {
          this.progressPlay.options.targetPlayerId = b.dataset.id;
          box.querySelectorAll('.progress-target-btn').forEach(x => x.classList.remove('btn-primary'));
          b.classList.add('btn-primary');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    if (type === 'master_merchant') {
      const opponents = (this.gameState?.players || []).filter(p => p.id !== this.myPlayerId);
      box.innerHTML = `<div>${i18n.t('PROGRESS_SELECT_OPPONENT')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0;">
          ${opponents.map(p => `<button type="button" class="btn-glass progress-target-btn" data-id="${p.id}">${escapeHtml(p.name)}</button>`).join('')}
        </div>
        <div id="mm-hand-reveal"></div>`;
      if (playBtn) playBtn.disabled = true;
      box.querySelectorAll('.progress-target-btn').forEach(b => {
        b.addEventListener('click', () => {
          if (this.progressPlay.peekLocked) return;
          this.progressPlay.options.targetPlayerId = b.dataset.id;
          this.progressPlay.handPeeked = false;
          delete this.progressPlay.options.steal;
          box.querySelectorAll('.progress-target-btn').forEach(x => x.classList.remove('btn-primary'));
          b.classList.add('btn-primary');
          if (playBtn) playBtn.disabled = !isActionPhase;
        });
      });
      return;
    }

    const hints = {
      bishop: 'PROGRESS_SELECT_HEX',
      merchant: 'PROGRESS_SELECT_HEX',
      inventor: 'PROGRESS_SELECT_HEX',
      smith: 'PROGRESS_SELECT_KNIGHTS',
      intrigue: 'PROGRESS_SELECT_KNIGHT',
      engineer: 'PROGRESS_SELECT_CITY',
      diplomat: 'PROGRESS_SELECT_ROAD'
    };
    if (hints[type]) {
      box.innerHTML = `<p>${i18n.t(hints[type])}</p>`;
      if (pickBoardBtn) pickBoardBtn.classList.remove('is-hidden');
      if (playBtn) playBtn.disabled = true;
    } else {
      if (playBtn) playBtn.disabled = !isActionPhase;
    }
  }

  handTypeOptions() {
    return ['wood', 'brick', 'wool', 'wheat', 'ore', 'cloth', 'coin', 'paper']
      .map(t => `<option value="${t}">${this.cardLabel(t)}</option>`).join('');
  }

  beginProgressBoardPick(type) {
    if (!this.gameState?.grid) return;
    const me = this.getMe();
    const vertices = Object.values(this.gameState.grid.vertices || {});
    const hexes = Object.values(this.gameState.grid.hexes || {});
    const edges = Object.values(this.gameState.grid.edges || {});
    if (type === 'bishop') {
      this.selectedAction = {
        type: 'progress_hex',
        validIds: new Set(hexes.filter(h => h.id !== this.gameState.grid.robberHexId).map(h => h.id))
      };
    } else if (type === 'merchant') {
      const mine = new Set([...(me.settlementsBuilt || []), ...(me.citiesBuilt || [])]);
      const ids = new Set();
      vertices.forEach(v => {
        if (mine.has(v.id) && v.hexes) v.hexes.forEach(hid => ids.add(hid));
      });
      this.selectedAction = { type: 'progress_hex', validIds: ids };
    } else if (type === 'inventor') {
      const forbidden = new Set([2, 6, 8, 12]);
      this.selectedAction = {
        type: 'progress_hex',
        validIds: new Set(hexes.filter(h => h.token && !forbidden.has(h.token)).map(h => h.id))
      };
    } else if (type === 'smith') {
      const ids = new Set((me.knightsPlaced || []).map(k => k.vertexId));
      this.selectedAction = { type: 'progress_vertex', validIds: ids };
    } else if (type === 'intrigue') {
      const ids = new Set();
      vertices.forEach(v => {
        if (!v.knight || v.knight.playerId === this.myPlayerId) return;
        const hasRoad = (v.adjacentEdges || []).some(eid => this.gameState.grid.edges[eid]?.road?.playerId === this.myPlayerId);
        if (hasRoad) ids.add(v.id);
      });
      this.selectedAction = { type: 'progress_vertex', validIds: ids };
    } else if (type === 'engineer') {
      const ids = new Set();
      (me.citiesBuilt || []).forEach(vid => {
        const v = this.gameState.grid.vertices[vid];
        if (isCityWallHost(v?.building) && !v.building.hasWall) ids.add(vid);
      });
      this.selectedAction = { type: 'progress_vertex', validIds: ids };
    } else if (type === 'diplomat') {
      const ids = new Set();
      edges.forEach(e => {
        if (!e.road) return;
        const ownerId = e.road.playerId;
        const isEndClosed = (vid) => {
          const v = this.gameState.grid.vertices[vid];
          if (!v) return false;
          if (v.building && v.building.playerId === ownerId) return true;
          for (const adjEid of v.adjacentEdges || []) {
            if (adjEid === e.id) continue;
            const adj = this.gameState.grid.edges[adjEid];
            if (adj?.road?.playerId === ownerId) return true;
          }
          return false;
        };
        if (!isEndClosed(e.v1) || !isEndClosed(e.v2)) {
          ids.add(e.id);
        }
      });
      this.selectedAction = { type: 'progress_road', validIds: ids };
    }
    this.boardRenderer.render(this.gameState.grid, this.selectedAction);
  }

  onProgressHexPicked(hexId) {
    if (!this.progressPlay) return;
    const banner = document.getElementById('board-pick-banner');
    const type = this.progressPlay.card.type;
    if (type === 'inventor') {
      this.progressPlay.picks.push(hexId);
      if (this.progressPlay.picks.length === 1) {
        const hint = document.getElementById('progress-card-target-ui');
        if (hint) hint.innerHTML = `<p>${i18n.t('PROGRESS_SELECT_HEX_2')}</p>`;
        const bannerText = document.getElementById('board-pick-banner-text');
        if (bannerText) bannerText.textContent = `🎯 ${i18n.t('PROGRESS_SELECT_HEX_2')}`;
        return;
      }
      if (banner) banner.classList.add('is-hidden');
      this.progressPlay.options.hexId1 = this.progressPlay.picks[0];
      this.progressPlay.options.hexId2 = this.progressPlay.picks[1];
      this.confirmProgressCardPlay();
      return;
    }
    if (banner) banner.classList.add('is-hidden');
    this.progressPlay.options.hexId = hexId;
    this.confirmProgressCardPlay();
  }

  onProgressVertexPicked(vertexId) {
    if (!this.progressPlay) return;
    const banner = document.getElementById('board-pick-banner');
    const type = this.progressPlay.card.type;
    if (type === 'smith') {
      if (!this.progressPlay.picks.includes(vertexId)) this.progressPlay.picks.push(vertexId);
      if (this.progressPlay.picks.length < 2) {
        const bannerText = document.getElementById('board-pick-banner-text');
        if (bannerText) bannerText.textContent = '🎯 Click a 2nd knight (or click Confirm)';
        return;
      }
      if (banner) banner.classList.add('is-hidden');
      this.progressPlay.options.knightVertices = this.progressPlay.picks.slice(0, 2);
      this.confirmProgressCardPlay();
      return;
    }
    if (type === 'engineer') {
      if (banner) banner.classList.add('is-hidden');
      this.progressPlay.options.vertexId = vertexId;
      this.confirmProgressCardPlay();
      return;
    }
    if (banner) banner.classList.add('is-hidden');
    this.progressPlay.options.vertexId = vertexId;
    this.confirmProgressCardPlay();
  }

  onProgressRoadPicked(edgeId) {
    if (!this.progressPlay) return;
    const banner = document.getElementById('board-pick-banner');
    if (banner) banner.classList.add('is-hidden');
    const type = this.progressPlay.card.type;
    if (type === 'diplomat') {
      const edge = this.gameState.grid.edges[edgeId];
      if (!this.progressPlay.options.edgeId) {
        this.progressPlay.options.edgeId = edgeId;
        const wasOwn = edge?.road?.playerId === this.myPlayerId;
        if (wasOwn) {
          const validRoadEdges = new Set();
          Object.values(this.gameState.grid.edges || {}).forEach(e => {
            if (e.road && e.id !== edgeId) return;
            const connectsToOwnBuilding = [e.v1, e.v2].some(vid => {
              const v = this.gameState.grid.vertices[vid];
              return v?.building && v.building.playerId === this.myPlayerId;
            });
            const connectsToOwnRoad = [e.v1, e.v2].some(vid => {
              const v = this.gameState.grid.vertices[vid];
              return (v?.adjacentEdges || []).some(adjId => {
                if (adjId === edgeId || adjId === e.id) return false;
                return this.gameState.grid.edges[adjId]?.road?.playerId === this.myPlayerId;
              });
            });
            if (connectsToOwnBuilding || connectsToOwnRoad) validRoadEdges.add(e.id);
          });
          if (validRoadEdges.size > 0) {
            this.selectedAction = { type: 'progress_road_replace', validIds: validRoadEdges };
            this.boardRenderer.render(this.gameState.grid, this.selectedAction);
            const hint = document.getElementById('progress-card-target-ui');
            if (hint) {
              hint.innerHTML = `<p>${i18n.t('PROGRESS_SELECT_ROAD_REPLACE')}</p><button id="btn-skip-replace-road" class="btn-glass btn-sm" style="margin-top:8px">${i18n.t('BUTTON_SKIP_REPLACE')}</button>`;
              document.getElementById('btn-skip-replace-road')?.addEventListener('click', () => {
                this.confirmProgressCardPlay();
              });
            }
            return;
          }
        }
        this.confirmProgressCardPlay();
        return;
      }
      this.progressPlay.options.newEdgeId = edgeId;
      this.confirmProgressCardPlay();
      return;
    }
    this.progressPlay.options.edgeId = edgeId;
    this.confirmProgressCardPlay();
  }

  async confirmProgressCardPlay() {
    const play = this.progressPlay;
    if (!play) return;
    if (isProgressCardBoughtThisTurn(play.card, this.gameState?.turnNumber)) {
      this.showToast(i18n.t('ERROR_CANNOT_PLAY_CARD_TURN_BOUGHT'), true);
      return;
    }
    const options = { ...play.options };
    if (play.card.type === 'alchemist') {
      options.d1 = parseInt(document.getElementById('alchemist-d1')?.value, 10);
      options.d2 = parseInt(document.getElementById('alchemist-d2')?.value, 10);
    }
    if (play.card.type === 'merchant_fleet' && !options.resource) {
      this.showToast(i18n.t('ERROR_SPECIFY_VALID_RESOURCE'), true);
      return;
    }
    if (play.card.type === 'spy' && !options.stealCardId) {
      options.peek = true;
    }
    if (play.card.type === 'master_merchant' && !play.handPeeked) {
      options.peek = true;
      delete options.steal;
    }
    if (play.card.type === 'master_merchant' && play.handPeeked) {
      options.steal = [
        document.getElementById('mm-steal-1')?.value,
        document.getElementById('mm-steal-2')?.value
      ].filter(Boolean);
    }
    const el = document.querySelector(`.progress-card[data-card-id="${play.card.id}"]`);
    el?.classList.add('playing');
    try {
      const res = await network.sendAction('play_progress_card', { cardId: play.card.id, options });
      if (res?.peek && play.card.type === 'spy') {
        el?.classList.remove('playing');
        play.peekLocked = true;
        this.renderSpyStealChoices(res.targetProgressCards || []);
        return;
      }
      if (res?.peek && play.card.type === 'master_merchant') {
        el?.classList.remove('playing');
        play.handPeeked = true;
        play.peekLocked = true;
        this.renderMasterMerchantHand(res.revealedHand);
        return;
      }
      audio.playBuild();
      this.closeProgressCardModal();
      if (play.card.type === 'road_building') {
        this.activateBuildRoad();
        this.showToast(i18n.t('ROAD_BUILDING_PLAYED_TOAST'));
      }
    } catch (err) {
      el?.classList.remove('playing');
      this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
    }
  }

  renderSpyStealChoices(cards) {
    const box = document.getElementById('progress-card-target-ui') || document.getElementById('progress-card-options');
    const playBtn = document.getElementById('btn-play-progress-card');
    if (!box) return;
    box.innerHTML = `<div>${i18n.t('PROGRESS_SELECT_SPY_CARD')}</div>
      <div class="progress-target-grid" style="margin-top:8px;">
        ${cards.map(c => `<button type="button" class="btn-glass progress-target-card-btn" data-card-id="${c.id}">${escapeHtml(i18n.t('CARD_' + String(c.type).toUpperCase()) || c.type)}</button>`).join('')}
      </div>`;
    if (playBtn) playBtn.disabled = true;
    box.querySelectorAll('.progress-target-card-btn').forEach(b => {
      b.addEventListener('click', () => {
        this.progressPlay.options.stealCardId = b.dataset.cardId;
        box.querySelectorAll('.progress-target-card-btn').forEach(x => x.classList.remove('btn-primary'));
        b.classList.add('btn-primary');
        if (playBtn) playBtn.disabled = false;
      });
    });
  }

  renderMasterMerchantHand(hand) {
    const box = document.getElementById('mm-hand-reveal')
      || document.getElementById('progress-card-target-ui')
      || document.getElementById('progress-card-options');
    const playBtn = document.getElementById('btn-play-progress-card');
    if (!box) return;
    const types = [];
    for (const [res, n] of Object.entries(hand?.resources || {})) {
      for (let i = 0; i < n; i++) types.push(res);
    }
    for (const [com, n] of Object.entries(hand?.commodities || {})) {
      for (let i = 0; i < n; i++) types.push(com);
    }
    const opts = [...new Set(types)].map(t => `<option value="${t}">${escapeHtml(this.cardLabel(t) || t)}</option>`).join('');
    const list = types.map(t => this.cardLabel(t) || t).join(', ') || '—';
    box.innerHTML = `<div>${i18n.t('PROGRESS_PEEK_HAND')}: ${escapeHtml(list)}</div>
      <div style="margin-top:8px;">${i18n.t('PROGRESS_SELECT_STEAL')}</div>
      <select id="mm-steal-1">${opts}</select>
      <select id="mm-steal-2">${opts}</select>`;
    if (playBtn) playBtn.disabled = types.length < 2;
  }

  /* =========================================================
   * NETWORK SYNC
   * ========================================================= */
  bindNetworkEvents() {
    network.onLobbyUpdate = (lobbyData) => {
      if (this.leavingMatch) return;
      this.myPlayerId = network.currentPlayerId || this.myPlayerId;
      if (this.myPlayerId && lobbyData?.players && !lobbyData.players.some(p => p.id === this.myPlayerId)) {
        this.returnToHomepage({ kicked: true });
        return;
      }
      this.renderWaitingRoom(lobbyData);
    };

    network.onGameStarted = () => {
      this.showView('view-game');
      audio.playTurnAlert();
    };

    network.onTimerTick = (data) => {
      this.syncPhaseTimer(data);
    };

    network.onStateUpdate = (payload) => {
      this.gameState = payload.state;
      this.currentRoom = payload.room;
      this.syncRulesModal(payload.state?.mode);
      this.renderGameState();
    };

    network.onChatReceived = (msg) => {
      this.appendChatMessage(msg);
    };

    network.onKicked = () => {
      this.returnToHomepage({ kicked: true });
    };

    network.connectionFSM?.onStateChange((newState, prevState) => {
      if (newState === 'DISCONNECTED_WAITING_RETRY') {
        if (this.currentRoom || this.gameState) {
          this.showToast(i18n.t('CONNECTION_LOST') || 'Connection lost. Reconnecting...', true);
        }
      } else if (newState === 'IN_GAME' && prevState === 'RECONNECTING_CLAIMING_SEAT') {
        this.showToast(i18n.t('SEAT_RECLAIMED') || 'Reconnected to match!');
        this.showView('view-game');
      }
    });
  }

  setActionEnabled(el, enabled, reasonKey) {
    if (!el) return;
    el.disabled = !enabled;
    if (enabled) {
      el.removeAttribute('title');
    } else if (reasonKey) {
      el.title = i18n.t(reasonKey);
    }
  }

  setBuildEnabled(id, inActionPhase, me, cost, phaseReasonKey) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!inActionPhase) {
      this.setActionEnabled(el, false, phaseReasonKey);
      return;
    }
    const ok = canPayCost(me?.resources, cost);
    this.setActionEnabled(el, ok, ok ? null : 'REASON_NOT_ENOUGH_RESOURCES');
  }

  renderGameState() {
    const s = this.gameState;
    if (!s) return;

    if (this.lastRenderedPhase && this.lastRenderedPhase !== s.phase) {
      if (this.selectedAction?.type === 'progress_hex' || s.phase === 'TURN_ROBBER' || this.lastRenderedPhase === 'TURN_ACTION') {
        if (s.phase !== 'TURN_ACTION') {
          this.clearActiveAction();
          this.closeProgressCardModal();
        }
      }
    }
    this.lastRenderedPhase = s.phase;

    if (s.lastTradeEvent?.id && s.lastTradeEvent.id !== this.seenTradeEventId) {
      this.seenTradeEventId = s.lastTradeEvent.id;
      if (s.lastTradeEvent.type === 'declined' && s.lastTradeEvent.fromPlayerId === this.myPlayerId) {
        this.showToast(i18n.t('TRADE_DECLINED_TOAST', { name: s.lastTradeEvent.playerName }));
      }
    }

    this.boardRenderer.currentPlayerId = this.myPlayerId;
    this.boardRenderer.gameStatePlayers = s.players;
    this.boardRenderer.longestRoadHolder = s.longestRoadHolder;
    this.boardRenderer.merchantHexId = s.merchantHexId;

    // Render SVG Board
    if (s.phase === 'SETUP_ROUND_1' || s.phase === 'SETUP_ROUND_2') {
      const curPlayer = s.players[s.currentTurnPlayerIndex];
      const isMySetup = curPlayer.id === this.myPlayerId;

      // Auto highlight valid vertices or edges during setup
      if (isMySetup) {
        if (!s.grid) return;
        const validIds = new Set();
        const isBuildingStep = s.setupStep
          ? s.setupStep === 'settlement'
          : ((curPlayer.settlementsBuilt?.length || 0) + (curPlayer.citiesBuilt?.length || 0)) === (curPlayer.roadsBuilt?.length || 0);
        if (isBuildingStep) {
          for (const [vId, v] of Object.entries(s.grid.vertices)) {
            if (!v.building && !v.knight) {
              const noAdj = v.adjacentVertices.every(adjId => !s.grid.vertices[adjId].building && !s.grid.vertices[adjId].knight);
              if (noAdj) validIds.add(vId);
            }
          }
          this.boardRenderer.render(s.grid, { type: 'settlement', validIds });
        } else {
          const lastVId = s.lastSetupSettlementVertex
            || curPlayer.citiesBuilt?.[curPlayer.citiesBuilt.length - 1]
            || curPlayer.settlementsBuilt[curPlayer.settlementsBuilt.length - 1];
          if (lastVId && s.grid.vertices[lastVId]) {
            for (const eId of s.grid.vertices[lastVId].adjacentEdges) {
              if (!s.grid.edges[eId].road) validIds.add(eId);
            }
          }
          this.boardRenderer.render(s.grid, { type: 'road', validIds });
        }
      } else {
        this.boardRenderer.render(s.grid, null);
      }
    } else if (s.phase === 'TURN_CHOOSE_METROPOLIS') {
      const pending = s.pendingMetropolisChoice;
      const me = s.players.find(p => p.id === this.myPlayerId);
      if (pending && pending.playerId === this.myPlayerId && me) {
        const validIds = new Set(
          (me.citiesBuilt || []).filter(id => {
            const b = s.grid?.vertices?.[id]?.building;
            return b?.type === 'city' && !b.hasMetropolis;
          })
        );
        this.selectedAction = { type: 'metropolis', validIds };
        this.boardRenderer.render(s.grid, this.selectedAction);
      } else {
        this.boardRenderer.render(s.grid, null);
      }
    } else if (s.phase === 'TURN_CHOOSE_KNIGHT_RELOCATE') {
      const pending = s.pendingKnightRelocation;
      if (pending && pending.playerId === this.myPlayerId) {
        const validIds = new Set(pending.options || []);
        this.selectedAction = { type: 'relocate_knight', validIds };
        this.boardRenderer.render(s.grid, { type: 'relocate_knight', validIds }, null, s.players);
      } else {
        this.boardRenderer.render(s.grid, null, null, s.players);
      }
    } else if (s.phase === 'TURN_CHOOSE_DESERTER_KNIGHT') {
      const pending = s.pendingDeserter;
      if (pending && pending.targetPlayerId === this.myPlayerId) {
        const validIds = new Set(pending.options || []);
        this.selectedAction = { type: 'deserter_knight', validIds };
        this.boardRenderer.render(s.grid, { type: 'progress_vertex', validIds }, null, s.players);
      } else {
        this.boardRenderer.render(s.grid, null, null, s.players);
      }
    } else if (s.phase === 'TURN_PLACE_DESERTER_KNIGHT') {
      const pending = s.pendingDeserter;
      if (pending && pending.playerId === this.myPlayerId) {
        const validIds = new Set(pending.legalPlaceIds || []);
        this.selectedAction = { type: 'deserter_place', validIds };
        this.boardRenderer.render(s.grid, { type: 'progress_vertex', validIds }, null, s.players);
      } else {
        this.boardRenderer.render(s.grid, null, null, s.players);
      }
    } else if (s.phase === 'TURN_ROBBER' && s.players[s.currentTurnPlayerIndex].id === this.myPlayerId) {
      // Robber target highlight
      this.boardRenderer.render(s.grid, { type: 'robber' });
    } else {
      const rollSum = (s.dice && s.dice.length === 2 && s.hasRolledDice) ? s.dice[0] + s.dice[1] : null;
      this.boardRenderer.render(s.grid, this.selectedAction, rollSum, s.players);
    }

    // Check discard modal
    this.checkDiscardState();
    this.checkProgressChoiceState();

    // Update Turn Banner & Buttons
    const curPlayer = s.players[s.currentTurnPlayerIndex];
    const isMyTurn = curPlayer.id === this.myPlayerId;

    document.getElementById('turn-commander-name').textContent = curPlayer.name;
    document.getElementById('turn-commander-name').style.color = curPlayer.color;
    document.getElementById('round-number-display').textContent = s.turnNumber;

    // Synchronize Turn Timer immediately (zero-flicker on state refresh / reconnect)
    this.syncPhaseTimer(this.currentRoom ? {
      remaining: this.currentRoom.turnTimeRemaining,
      duration: this.currentRoom.turnDuration
    } : null);

    const statusEl = document.getElementById('turn-phase-status');
    if (statusEl) {
      let statusKey = mapPhaseToStatusKey(s.phase, isMyTurn, {
        mustDiscard: s.phase === 'TURN_DISCARD' && s.pendingDiscards?.includes(this.myPlayerId),
        isDeserterChooser: s.pendingDeserter?.targetPlayerId === this.myPlayerId,
        isDeserterPlacer: s.pendingDeserter?.playerId === this.myPlayerId
      });
      if (this.isCitiesKnights() && s.phase === 'SETUP_ROUND_2') {
        statusKey = isMyTurn ? 'STATUS_YOUR_SETUP_CK' : 'STATUS_WAIT_SETUP_CK';
      }
      if (s.phase === 'TURN_CHOOSE_PROGRESS_RESPONSE') {
        const waitingOnMe = s.pendingProgressChoice?.pending?.includes(this.myPlayerId);
        statusKey = waitingOnMe ? 'STATUS_YOUR_PROGRESS_CHOICE' : 'STATUS_WAIT_PROGRESS_CHOICE';
      }
      statusEl.textContent = i18n.t(statusKey, { name: curPlayer.name });
    }

    const me = s.players.find(p => p.id === this.myPlayerId);
    const isSbp = s.phase === 'TURN_SPECIAL_BUILDING';
    const isActionPhase = s.phase === 'TURN_ACTION' && isMyTurn;
    const isBuildPhase = isMyTurn && (s.phase === 'TURN_ACTION' || isSbp);
    const isRollPhase = s.phase === 'TURN_ROLL' && isMyTurn;
    const notTurnReason = !isMyTurn ? 'REASON_NOT_YOUR_TURN' : 'REASON_WRONG_PHASE';

    this.setActionEnabled(document.getElementById('btn-roll-dice'), isRollPhase, isMyTurn && !isRollPhase ? 'REASON_ALREADY_ROLLED' : notTurnReason);
    this.setActionEnabled(document.getElementById('btn-end-turn'), isActionPhase, notTurnReason);
    const passBtn = document.getElementById('btn-pass-sbp');
    if (passBtn) {
      passBtn.classList.toggle('is-hidden', !isSbp);
      this.setActionEnabled(passBtn, isSbp && isMyTurn, notTurnReason);
    }
    document.getElementById('btn-end-turn')?.classList.toggle('is-hidden', isSbp);
    this.setActionEnabled(document.getElementById('btn-open-trade'), isActionPhase, notTurnReason);
    const unplayedDev = (me?.devCards || []).filter(c => !c.played);
    this.setActionEnabled(
      document.getElementById('btn-open-dev-cards'),
      isActionPhase && unplayedDev.length > 0,
      !isActionPhase ? notTurnReason : 'REASON_WRONG_PHASE'
    );

    this.setBuildEnabled('btn-build-road', isBuildPhase, me, BUILD_COSTS.ROAD, notTurnReason);
    this.setBuildEnabled('btn-build-settlement', isBuildPhase, me, BUILD_COSTS.SETTLEMENT, notTurnReason);
    this.setBuildEnabled('btn-build-city', isBuildPhase, me, BUILD_COSTS.CITY, notTurnReason);
    this.setBuildEnabled('btn-buy-dev-card', isBuildPhase && !this.isCitiesKnights(), me, BUILD_COSTS.DEV_CARD, notTurnReason);
    this.renderWallSupplyAndButton(s, me, isBuildPhase, notTurnReason);

    // Update Dice Values
    if (s.dice) {
      if (this.diceAnim && !this.diceAnim.minElapsed) {
        this.diceAnim.pending = s.dice;
      } else if (this.diceAnim && this.diceAnim.minElapsed) {
        this.diceAnim.pending = s.dice;
        this.settleDiceAnimation();
      } else {
        document.getElementById('die-1').textContent = s.dice[0];
        document.getElementById('die-2').textContent = s.dice[1];
        document.getElementById('dice-sum').textContent = s.dice[0] + s.dice[1];
      }
    }

    this.renderCkHud(s, me, isBuildPhase);
    this.renderBankSupply(s.bank, this.isCitiesKnights());
    this.renderKnightsOverview(s.knightsOverview);

    // Update My Resources
    if (me) {
      document.body.classList.toggle('mode-cities-knights', this.isCitiesKnights());

      if (me.resources && typeof me.resources.wood === 'number') {
        ['wood', 'brick', 'wool', 'wheat', 'ore'].forEach(res => {
          const el = document.getElementById(`count-${res}`);
          if (el) el.textContent = me.resources[res] || 0;
        });
        ['cloth', 'coin', 'paper'].forEach(com => {
          const el = document.getElementById(`count-${com}`);
          if (el) el.textContent = (me.commodities && me.commodities[com]) || 0;
        });
        document.getElementById('my-vp-count').textContent = me.victoryPoints;
      }
      const devBadge = document.getElementById('dev-card-badge');
      if (devBadge) {
        const unplayed = this.isCitiesKnights()
          ? unplayedProgressCards(me.progressCards)
          : (me.devCards || []).filter(c => !c.played);
        devBadge.textContent = unplayed.length;
        devBadge.classList.toggle('is-hidden', unplayed.length === 0);
      }
    }

    // Update Opponents list
    const oppContainer = document.getElementById('opponents-list');
    oppContainer.innerHTML = '';
    s.players.forEach(p => {
      const card = document.createElement('div');
      const isActivePlayer = p.id === curPlayer.id;
      card.className = `opponent-mini-card${isActivePlayer ? ' is-active-turn' : ''}`;
      const resourceCount = typeof p.resources.total === 'number'
        ? p.resources.total
        : Object.values(p.resources || {}).reduce((a, b) => a + b, 0);
      const commodityCount = typeof p.commodities?.total === 'number'
        ? p.commodities.total
        : Object.values(p.commodities || {}).reduce((a, b) => a + b, 0);
      const cardCount = resourceCount + commodityCount;
      const stateKey = mapPhaseToOpponentStateKey(s.phase, isActivePlayer);
      const you = p.id === this.myPlayerId ? ` ${i18n.t('YOU_SUFFIX')}` : '';
      const playerAvatar = p.avatar || '/assets/avatars/settler.jpg';

      card.innerHTML = `
        <div class="opponent-identity">
          <img src="${escapeHtml(playerAvatar)}" class="opponent-avatar-img" style="border: 2px solid ${p.color};" alt="${escapeHtml(p.name)}" />
          <div style="display: flex; flex-direction: column; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="opponent-swatch" style="background: ${p.color};"></span>
              <span class="opponent-name">${escapeHtml(p.name)}${you}</span>
            </div>
          </div>
        </div>
        <div class="opponent-card-meta">
          <span class="opponent-phase">${i18n.t(stateKey)}</span>
          <div class="opponent-stats">
            <span class="opponent-card-count">
              ${ico('cards', 'ico-opp')}
              ${cardCount}
            </span>
            <span class="opponent-vp-badge">${p.victoryPoints} ${i18n.t('VICTORY_POINTS_ABBR')}</span>
            ${this.playerTitleStatsHtml(s, p)}
          </div>
        </div>
        ${this.opponentRevealedProgressHtml(p)}
      `;
      oppContainer.appendChild(card);
    });

    // Update Event Log
    this.renderLog(s.eventLog);

    // Active Domestic Trade Banner
    this.renderActiveTradeBanner(s.activeTrade);

    // Refresh Trade Modal state if modal is active
    const tradeModal = document.getElementById('trade-modal');
    if (tradeModal && tradeModal.classList.contains('active')) {
      const isMyTurn = s.currentPlayerId === this.myPlayerId;
      const isActionPhase = s.phase === 'TURN_ACTION';
      const canTrade = isMyTurn && isActionPhase;
      const proposeBtn = document.getElementById('btn-submit-propose-trade');
      if (proposeBtn) {
        proposeBtn.disabled = !canTrade;
        proposeBtn.textContent = canTrade ? i18n.t('PROPOSE_TRADE_BTN') : i18n.t('TRADE_ONLY_ON_YOUR_TURN');
      }
      const tabBank = document.getElementById('tab-trade-bank');
      if (tabBank && tabBank.classList.contains('active')) {
        this.renderBankTradeUI();
      }
    }

    // Update Dynamic Board Guidance Hint
    this.updateBoardHint();

    // Check Victory
    if (s.phase === 'GAME_OVER') {
      const winner = s.players?.find(p => p.victoryPoints >= (s.vpTarget || 10)) || curPlayer;
      const winnerEl = document.getElementById('victory-winner-name');
      if (winnerEl) winnerEl.textContent = winner?.name || '---';
      const winnerAvatarEl = document.getElementById('victory-winner-avatar');
      if (winnerAvatarEl && winner?.avatar) winnerAvatarEl.src = winner.avatar;
      this.renderVictoryStats(winner, s);
      const victoryModal = document.getElementById('victory-modal');
      if (victoryModal) victoryModal.classList.add('active');
      if (!this.victoryCelebrated) {
        this.victoryCelebrated = true;
        audio.playFanfare();
        confetti.start();
      }
    }
  }

  renderVictoryStats(winner, s) {
    const statsEl = document.getElementById('victory-stats');
    if (!statsEl) return;
    statsEl.innerHTML = renderVictoryStatsHtml(winner, s);
  }

  updateBoardHint() {
    const hintPill = document.getElementById('board-hint');
    const hintTextEl = document.getElementById('board-hint-text');
    if (!hintPill || !hintTextEl) return;
    const s = this.gameState;
    if (!s) {
      hintTextEl.textContent = i18n.t('PAN_ZOOM_HINT');
      hintPill.classList.remove('hint-active');
      return;
    }

    const curPlayer = s.players ? s.players[s.currentTurnPlayerIndex] : null;
    const isMyTurn = curPlayer && curPlayer.id === this.myPlayerId;
    let hintText = i18n.t('PAN_ZOOM_HINT');
    let isActionable = false;

    if (s.phase === 'SETUP_ROUND_1' || s.phase === 'SETUP_ROUND_2') {
      if (isMyTurn && curPlayer) {
        isActionable = true;
        const isBuildingStep = s.setupStep
          ? s.setupStep === 'settlement'
          : ((curPlayer.settlementsBuilt?.length || 0) + (curPlayer.citiesBuilt?.length || 0)) === (curPlayer.roadsBuilt?.length || 0);
        if (s.phase === 'SETUP_ROUND_1') {
          hintText = isBuildingStep ? i18n.t('SETUP_HINT_SETTLEMENT_1') : i18n.t('SETUP_HINT_ROAD_1');
        } else if (this.isCitiesKnights()) {
          hintText = isBuildingStep ? i18n.t('SETUP_HINT_CITY_2') : i18n.t('SETUP_HINT_ROAD_2');
        } else {
          hintText = isBuildingStep ? i18n.t('SETUP_HINT_SETTLEMENT_2') : i18n.t('SETUP_HINT_ROAD_2');
        }
      } else if (curPlayer) {
        hintText = i18n.t('SETUP_HINT_WAITING', { playerName: curPlayer.name });
      }
    } else if (s.phase === 'TURN_ROBBER') {
      if (isMyTurn) {
        isActionable = true;
        hintText = i18n.t('ACTION_HINT_ROBBER');
      } else if (curPlayer) {
        hintText = i18n.t('SETUP_HINT_WAITING', { playerName: curPlayer.name });
      }
    } else if (s.phase === 'TURN_CHOOSE_METROPOLIS') {
      const pending = s.pendingMetropolisChoice;
      const chooser = pending && s.players.find(p => p.id === pending.playerId);
      if (pending && pending.playerId === this.myPlayerId) {
        isActionable = true;
        hintText = i18n.t('ACTION_HINT_METROPOLIS', { track: i18n.t(`TRACK_${(pending.track || '').toUpperCase()}`) });
      } else if (chooser) {
        hintText = i18n.t('SETUP_HINT_WAITING', { playerName: chooser.name });
      }
    } else if (s.phase === 'TURN_CHOOSE_KNIGHT_RELOCATE') {
      const pending = s.pendingKnightRelocation;
      const chooser = pending && s.players.find(p => p.id === pending.playerId);
      if (pending && pending.playerId === this.myPlayerId) {
        isActionable = true;
        hintText = i18n.t('ACTION_HINT_KNIGHT_RELOCATE');
      } else if (chooser) {
        hintText = i18n.t('SETUP_HINT_WAITING', { playerName: chooser.name });
      }
    } else if (s.phase === 'TURN_CHOOSE_DESERTER_KNIGHT') {
      const pending = s.pendingDeserter;
      const chooser = pending && s.players.find(p => p.id === pending.targetPlayerId);
      if (pending && pending.targetPlayerId === this.myPlayerId) {
        isActionable = true;
        hintText = i18n.t('ACTION_HINT_DESERTER_KNIGHT');
      } else if (chooser) {
        hintText = i18n.t('SETUP_HINT_WAITING', { playerName: chooser.name });
      }
    } else if (s.phase === 'TURN_PLACE_DESERTER_KNIGHT') {
      const pending = s.pendingDeserter;
      const placer = pending && s.players.find(p => p.id === pending.playerId);
      if (pending && pending.playerId === this.myPlayerId) {
        isActionable = true;
        hintText = i18n.t('ACTION_HINT_DESERTER_PLACE');
      } else if (placer) {
        hintText = i18n.t('SETUP_HINT_WAITING', { playerName: placer.name });
      }
    } else if (s.phase === 'TURN_ROLL') {
      isActionable = isMyTurn;
      hintText = i18n.t(mapPhaseToStatusKey(s.phase, isMyTurn), { name: curPlayer?.name || '' });
    } else if (s.phase === 'TURN_DISCARD') {
      const mustDiscard = s.pendingDiscards?.includes(this.myPlayerId);
      hintText = i18n.t(mapPhaseToStatusKey(s.phase, isMyTurn, { mustDiscard }), { name: curPlayer?.name || '' });
    } else if (s.phase === 'TURN_SPECIAL_BUILDING') {
      if (isMyTurn) {
        isActionable = true;
        hintText = i18n.t('ACTION_HINT_SBP');
      } else if (curPlayer) {
        hintText = i18n.t('STATUS_WAIT_SBP', { name: curPlayer.name });
      }
    } else if (s.phase === 'TURN_ACTION') {
      if (isMyTurn) {
        if (this.selectedAction && this.selectedAction.type === 'road') {
          isActionable = true;
          hintText = i18n.t('ACTION_HINT_BUILD_ROAD');
        } else if (this.selectedAction && this.selectedAction.type === 'settlement') {
          isActionable = true;
          hintText = i18n.t('ACTION_HINT_BUILD_SETTLEMENT');
        } else if (this.selectedAction && this.selectedAction.type === 'city') {
          isActionable = true;
          hintText = i18n.t('ACTION_HINT_BUILD_CITY');
        } else if (this.selectedAction && this.selectedAction.type === 'wall') {
          isActionable = true;
          hintText = i18n.t('ACTION_HINT_BUILD_WALL');
        } else if (this.selectedAction && this.selectedAction.type === 'knight') {
          isActionable = true;
          hintText = i18n.t('ACTION_HINT_PLACE_KNIGHT');
        } else if (this.selectedAction && this.selectedAction.type === 'move_knight') {
          isActionable = true;
          hintText = i18n.t('ACTION_HINT_MOVE_KNIGHT');
        } else if (this.selectedAction && this.selectedAction.type === 'chase_robber') {
          isActionable = true;
          hintText = i18n.t('ACTION_HINT_CHASE_ROBBER');
        } else {
          hintText = i18n.t('STATUS_YOUR_ACTION');
        }
      } else if (curPlayer) {
        hintText = i18n.t('STATUS_WAIT_ACTION', { name: curPlayer.name });
      }
    } else if (curPlayer) {
      hintText = i18n.t(mapPhaseToStatusKey(s.phase, isMyTurn), { name: curPlayer.name });
    }

    hintTextEl.textContent = hintText;
    if (isActionable) {
      hintPill.classList.add('hint-active');
    } else {
      hintPill.classList.remove('hint-active');
    }
  }

  renderLog(logs) {
    return this.chatLogView.renderLog(logs, this.diceAnim, this.deferredProductionToasts);
  }

  appendChatMessage(msg) {
    return this.chatLogView.appendChatMessage(msg);
  }

  renderActiveTradeBanner(activeTrade) {
    return this.tradeModal.renderActiveTradeBanner(activeTrade);
  }

  updateHUDText() {
    i18n.updateDOM();
    if (this.gameState) {
      this.renderGameState();
    }
  }
}

// Instantiate and start app on DOMContentLoaded
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('DOMContentLoaded', () => {
    new CatanApp();
  });
}
