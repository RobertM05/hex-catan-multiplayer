/**
 * app.js
 * Main client controller for Hexagonal Strategy Game.
 * Ties together UI, i18n, Web Audio, SVG Renderer, and Socket.IO networking.
 */

import { i18n } from './i18n.js';
import { audio } from './audio.js';
import { network } from './network.js';
import { BoardRenderer } from './renderer.js';
import { ico } from './icons.js';

class CatanApp {
  constructor() {
    this.boardRenderer = null;
    this.currentRoom = null;
    this.gameState = null;
    this.selectedAction = null; // { type: 'settlement'|'road'|'city'|'robber', validIds: Set }
    this.bankTrade = { give: null, receive: null };
    this.lastEventDie = null;
    this.barbarianOverlayKey = null;
    this.diceAnim = null;
    this.diceFaceTimer = null;
    this.deferredProductionToasts = [];
    this.myPlayerId = localStorage.getItem('catan_player_id') || `p_${Math.random().toString(36).substring(2, 8)}`;
    localStorage.setItem('catan_player_id', this.myPlayerId);
    network.currentPlayerId = this.myPlayerId;

    this.init();
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
    // Setup i18n language buttons
    this.setupLanguageSelector();
    this.setupSoundToggle();
    this.setupRulesModal();
    this.setupModalAccessibility();

    // Initialize SVG board renderer
    const boardContainer = document.getElementById('board-container');
    this.boardRenderer = new BoardRenderer(boardContainer);
    this.setupRendererInteractions();

    // Setup Lobby Forms & Tabs
    this.setupLobbyTabs();
    this.setupLobbyActions();
    this.setupWaitingRoomActions();
    this.setupInGameActions();
    this.setupCkUi();
    this.setupTradeModals();
    this.setupDiscardModal();
    this.setupDevCardsModal();

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

    // Initial DOM translation
    i18n.updateDOM();
  }

  /* =========================================================
   * VIEW NAVIGATION
   * ========================================================= */
  showView(viewId) {
    document.querySelectorAll('.view-screen').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');
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

  /* =========================================================
   * TOP BAR (Language, Sound, Rules)
   * ========================================================= */
  setupLanguageSelector() {
    const btnEn = document.getElementById('lang-en');
    const btnRo = document.getElementById('lang-ro');
    const updateActive = () => {
      const current = i18n.getLang();
      btnEn.classList.toggle('active', current === 'en');
      btnRo.classList.toggle('active', current === 'ro');
      document.documentElement.lang = current;
    };

    btnEn.addEventListener('click', () => {
      i18n.setLang('en');
      updateActive();
      this.updateHUDText();
    });

    btnRo.addEventListener('click', () => {
      i18n.setLang('ro');
      updateActive();
      this.updateHUDText();
    });

    updateActive();
  }

  setupSoundToggle() {
    const soundBtn = document.getElementById('btn-sound-toggle');
    const updateIcon = () => {
      const iconMarkup = ico(audio.enabled ? 'speakerHigh' : 'speakerSlash', 'btn-icon');
      soundBtn.innerHTML = `${iconMarkup} <span>${i18n.t('SOUND_TOGGLE')}</span>`;
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
    document.getElementById('btn-rules').addEventListener('click', () => {
      modal.classList.add('active');
    });
    document.getElementById('btn-close-rules').addEventListener('click', () => {
      modal.classList.remove('active');
    });
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
   * LOBBY SETUP & ACTIONS
   * ========================================================= */
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
    document.querySelectorAll('.lobby-tab-content').forEach(c => c.style.display = 'none');

    const activeBtn = document.getElementById(`tab-btn-${tab}`);
    const activeContent = document.getElementById(`tab-content-${tab}`);
    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.style.display = 'block';

    if (tab === 'public') {
      this.refreshPublicRooms();
    }
  }

  setupLobbyActions() {
    // Create Room
    document.getElementById('form-create-room').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hostName = document.getElementById('host-player-name').value.trim() || 'Commander';
      const roomName = document.getElementById('create-room-name').value.trim() || 'Realm';
      const maxPlayers = parseInt(document.getElementById('create-max-players').value);
      const mode = document.getElementById('create-game-mode').value;
      const turnDuration = parseInt(document.getElementById('create-turn-timer').value);
      const mapSize = document.getElementById('create-map-size').value;

      try {
        const res = await network.createRoom(hostName, {
          roomName,
          maxPlayers,
          mode,
          turnDuration,
          mapSize,
          vpTarget: mode === 'cities_knights' ? 13 : 10
        });
        this.enterWaitingRoom(res.roomCode);
      } catch (err) {
        this.showToast(err.message, true);
      }
    });

    // Join Room by Code
    document.getElementById('form-join-room').addEventListener('submit', async (e) => {
      e.preventDefault();
      const playerName = document.getElementById('join-player-name').value.trim() || 'Player';
      const code = document.getElementById('join-room-code').value.trim();
      if (!code) return;

      try {
        const res = await network.joinRoom(code, playerName);
        if (res.isStarted) {
          this.showView('view-game');
        } else {
          this.enterWaitingRoom(res.roomCode);
        }
      } catch (err) {
        this.showToast(err.message, true);
      }
    });
  }

  async refreshPublicRooms() {
    try {
      const res = await fetch('/api/rooms');
      const rooms = await res.json();
      const container = document.getElementById('public-rooms-list');
      container.innerHTML = '';

      if (rooms.length === 0) {
        container.innerHTML = `<p style="color: var(--text-secondary); text-align: center; padding: 24px;">${i18n.t('NO_ROOMS_AVAILABLE')}</p>`;
        return;
      }

      rooms.forEach(r => {
        const card = document.createElement('div');
        card.className = 'room-card';
        card.innerHTML = `
          <div>
            <h4 style="font-size: 16px; font-weight: 700;">${r.name}</h4>
            <span style="font-size: 12px; color: var(--text-secondary);">${i18n.t('HOST_LABEL')}: ${r.hostName} • ${r.playersCount}/${r.maxPlayers} ${i18n.t('PLAYERS_LABEL')}</span>
          </div>
          <button class="btn-glass btn-primary btn-join-direct" data-code="${r.code}">${i18n.t('JOIN_ROOM_BTN')}</button>
        `;
        card.querySelector('.btn-join-direct').addEventListener('click', () => {
          document.getElementById('join-room-code').value = r.code;
          this.switchLobbyTab('join');
        });
        container.appendChild(card);
      });
    } catch (err) {
      console.error('Failed to fetch rooms:', err);
    }
  }

  /* =========================================================
   * WAITING ROOM
   * ========================================================= */
  enterWaitingRoom(code) {
    this.showView('view-waiting');
    document.getElementById('display-room-code').textContent = code;

    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('room', code);
    window.history.pushState({}, '', url);
  }

  setupWaitingRoomActions() {
    // Copy Invite Link
    document.getElementById('btn-share-link').addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href);
      this.showToast(i18n.t('LINK_COPIED'));
    });

    // Ready Check
    let isReady = false;
    document.getElementById('btn-toggle-ready').addEventListener('click', () => {
      isReady = !isReady;
      network.setReady(isReady);
      document.getElementById('btn-toggle-ready').classList.toggle('btn-primary', !isReady);
    });

    // Add Bot
    document.getElementById('btn-add-bot').addEventListener('click', async () => {
      try {
        await network.addBot('medium');
      } catch (err) {
        this.showToast(err.message, true);
      }
    });

    // Start Game (Host only)
    document.getElementById('btn-start-game').addEventListener('click', async () => {
      try {
        await network.startGame();
      } catch (err) {
        this.showToast(err.message, true);
      }
    });

    // Leave Room
    document.getElementById('btn-leave-waiting').addEventListener('click', () => {
      window.location.href = window.location.pathname;
    });
  }

  renderWaitingRoom(lobbyData) {
    this.currentRoom = lobbyData;
    const slotsContainer = document.getElementById('waiting-slots-grid');
    slotsContainer.innerHTML = '';

    const isHost = lobbyData.hostId === this.myPlayerId;
    document.getElementById('btn-start-game').style.display = isHost ? 'block' : 'none';
    document.getElementById('btn-add-bot').style.display = isHost && lobbyData.players.length < lobbyData.maxPlayers ? 'block' : 'none';

    lobbyData.players.forEach(p => {
      const card = document.createElement('div');
      card.className = 'player-slot-card';
      card.style.setProperty('--player-color', p.color);
      card.innerHTML = `
        <div class="player-slot-header">
          <div class="player-slot-name" style="display: flex; align-items: center; gap: 6px;">
            ${p.name}
            ${p.id === lobbyData.hostId ? '<span class="player-badge host-badge">Host</span>' : ''}
            ${p.isBot ? '<span class="player-badge bot-badge">Bot</span>' : ''}
          </div>
          <span class="ready-badge ${p.isReady ? 'ready' : 'not-ready'}">
            ${p.isReady ? i18n.t('STATUS_READY') : i18n.t('STATUS_NOT_READY')}
          </span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 12px; color: var(--text-secondary);">${i18n.t('CHOOSE_COLOR')}</span>
            <input type="color" value="${p.color}" class="color-picker-input" ${p.id === this.myPlayerId ? '' : 'disabled'} style="border: none; width: 28px; height: 28px; border-radius: 50%; cursor: pointer;">
          </div>
          ${isHost && p.id !== this.myPlayerId ? `<button class="btn-glass btn-danger btn-kick-player" data-id="${p.id}" style="padding: 4px 8px; font-size: 11px;">${i18n.t('KICK_PLAYER')}</button>` : ''}
        </div>
      `;

      if (p.id === this.myPlayerId) {
        card.querySelector('.color-picker-input').addEventListener('change', (e) => {
          network.setColor(e.target.value);
        });
      }

      const kickBtn = card.querySelector('.btn-kick-player');
      if (kickBtn) {
        kickBtn.addEventListener('click', () => {
          network.removePlayer(p.id);
        });
      }

      slotsContainer.appendChild(card);
    });
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

    document.getElementById('btn-build-city-wall')?.addEventListener('click', () => {
      if (this.selectedAction && this.selectedAction.type === 'wall') {
        this.clearActiveAction();
      } else {
        this.activateBuildCityWall();
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
      document.getElementById('panel-log').style.display = 'flex';
      document.getElementById('panel-chat').style.display = 'none';
    });

    document.getElementById('tab-btn-chat').addEventListener('click', () => {
      document.getElementById('tab-btn-chat').classList.add('active');
      document.getElementById('tab-btn-log').classList.remove('active');
      document.getElementById('panel-chat').style.display = 'flex';
      document.getElementById('panel-log').style.display = 'none';
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
        this.showToast(i18n.t('ROBBER_ROLLED'), true);
        setTimeout(() => dice.forEach(d => d.classList.remove('die-seven')), 700);
      }
    }
    this.flushDeferredProductionToasts();
  }

  flushDeferredProductionToasts() {
    const queued = this.deferredProductionToasts.splice(0);
    queued.forEach(message => this.showToast(message));
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
        }
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    };

    this.boardRenderer.onHexClick = async (hexId) => {
      if (this.gameState && this.gameState.phase === 'TURN_ROBBER') {
        // Open robber steal target selector
        this.openRobberTargetModal(hexId);
      }
    };
  }

  clearActiveAction() {
    this.selectedAction = null;
    document.querySelectorAll('.btn-build-action').forEach(b => b.classList.remove('btn-primary'));
    if (this.gameState && this.gameState.grid) {
      this.boardRenderer.render(this.gameState.grid, null);
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
    this.boardRenderer.render(this.gameState.grid, this.selectedAction);
    this.updateBoardHint();
  }

  activateBuildCityWall() {
    if (!this.gameState || !this.gameState.grid) return;
    const validIds = new Set();
    Object.values(this.gameState.grid.vertices).forEach(v => {
      if (v.building && v.building.type === 'city' && v.building.playerId === this.myPlayerId && !v.building.hasWall) {
        validIds.add(v.id);
      }
    });
    this.selectedAction = { type: 'wall', validIds };
    document.getElementById('btn-build-city-wall')?.classList.add('btn-primary');
    this.boardRenderer.render(this.gameState.grid, this.selectedAction);
    this.updateBoardHint();
  }

  setupCkUi() {
    const panel = document.getElementById('city-improvements-panel');
    panel?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-improve-track]');
      if (!btn || btn.disabled) return;
      try {
        await network.sendAction('improve_city', { track: btn.getAttribute('data-improve-track') });
        audio.playBuild();
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    });

    document.getElementById('btn-close-barbarian')?.addEventListener('click', () => {
      document.getElementById('barbarian-modal')?.classList.remove('active');
    });

    document.getElementById('btn-toggle-improvements')?.addEventListener('click', () => {
      document.getElementById('city-improvements-panel')?.classList.toggle('collapsed');
    });
  }

  renderCkHud(s, me, isActionPhase) {
    document.body.classList.toggle('mode-cities-knights', this.isCitiesKnights());
    this.renderEventDie(s);
    this.renderBarbarianTrack(s);
    this.renderImprovementPanel(me, isActionPhase);
    this.renderBarbarianOverlay(s, me);
    const wallCount = document.getElementById('wall-supply-count');
    if (wallCount) wallCount.textContent = String(me?.cityWalls ?? 0);
  }

  renderEventDie(s) {
    const el = document.getElementById('die-event');
    if (!el) return;
    el.classList.remove('event-barbarian', 'event-trade', 'event-politics', 'event-science');
    const face = s.eventDie;
    if (!face) {
      el.textContent = '?';
      return;
    }
    const icons = { barbarian: 'bandit', trade: 'cloth', politics: 'coin', science: 'paper' };
    el.classList.add(`event-${face}`);
    el.innerHTML = ico(icons[face] || 'warning');
    el.title = i18n.t(`EVENT_DIE_${face.toUpperCase()}`) || face;
    if (this.lastEventDie !== face) {
      el.classList.add('event-flash');
      setTimeout(() => el.classList.remove('event-flash'), 450);
      this.lastEventDie = face;
    }
  }

  renderBarbarianTrack(s) {
    const wrap = document.getElementById('barbarian-track');
    const pips = document.getElementById('barbarian-track-pips');
    const countEl = document.getElementById('barbarian-track-count');
    if (!wrap || !pips) return;
    const pos = s.barbarianPosition || 0;
    wrap.classList.toggle('barbarian-warning', pos >= 5);
    if (countEl) countEl.textContent = `${pos}/7`;
    pips.innerHTML = '';
    for (let i = 1; i <= 7; i++) {
      const pip = document.createElement('div');
      pip.className = 'barbarian-pip';
      if (i <= pos) pip.classList.add('filled');
      if (i === pos) pip.classList.add('ship');
      pips.appendChild(pip);
    }
  }

  renderImprovementPanel(me, isActionPhase) {
    if (!me) return;
    const tracks = {
      trade: 'cloth',
      politics: 'coin',
      science: 'paper'
    };
    const hasCities = (me.citiesBuilt || []).length > 0;
    for (const [track, commodity] of Object.entries(tracks)) {
      const level = me.cityImprovements?.[track] || 0;
      const cost = Math.min(level + 1, 5);
      const have = this.getCardCount(me, commodity);
      const canAfford = hasCities && isActionPhase && level < 5 && have >= cost;
      const levelEl = document.getElementById(`improve-level-${track}`);
      const fillEl = document.getElementById(`improve-fill-${track}`);
      const costEl = document.getElementById(`improve-cost-${track}`);
      const btn = document.getElementById(`btn-improve-${track}`);
      const row = document.querySelector(`.improvement-track[data-track="${track}"]`);
      if (levelEl) levelEl.textContent = `${level}/5`;
      if (fillEl) fillEl.style.width = `${(level / 5) * 100}%`;
      if (costEl) costEl.textContent = level >= 5 ? '—' : String(cost);
      if (btn) btn.disabled = !canAfford;
      row?.classList.toggle('track-ready', canAfford);
      row?.classList.toggle('track-metro', level >= 4);
    }
  }

  renderBarbarianOverlay(s, me) {
    const modal = document.getElementById('barbarian-modal');
    const body = document.getElementById('barbarian-modal-body');
    const list = document.getElementById('barbarian-downgrade-list');
    const closeBtn = document.getElementById('btn-close-barbarian');
    if (!modal || !body || !list) return;

    const pending = s.pendingBarbarianDowngrades || [];
    const result = s.lastBarbarianResult;
    const mustDowngrade = s.phase === 'TURN_BARBARIAN_DOWNGRADE' && me && pending.includes(me.id);

    if (!result && !mustDowngrade) {
      modal.classList.remove('active');
      return;
    }

    const key = `${s.turnNumber}-${result?.outcome || 'none'}-${pending.join(',')}`;
    if (!mustDowngrade && this.barbarianOverlayKey === key) return;
    this.barbarianOverlayKey = key;

    if (result?.outcome === 'victory') {
      const defender = s.players.find(p => p.id === result.defenderOfCatan);
      body.textContent = defender
        ? i18n.t('BARBARIAN_VICTORY_BODY', { name: defender.name, knights: result.totalActiveKnights, cities: result.totalCities })
        : i18n.t('BARBARIAN_VICTORY_TIE_BODY', { knights: result.totalActiveKnights, cities: result.totalCities });
    } else {
      body.textContent = i18n.t('BARBARIAN_DEFEAT_BODY', {
        knights: result?.totalActiveKnights ?? '—',
        cities: result?.totalCities ?? '—'
      });
    }

    list.innerHTML = '';
    if (mustDowngrade) {
      closeBtn.style.display = 'none';
      (me.citiesBuilt || []).forEach((vid) => {
        const vertex = s.grid?.vertices?.[vid];
        const hexes = (vertex?.hexes || []).map((hid) => s.grid?.hexes?.[hid]?.resource).filter(Boolean);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-glass barbarian-city-btn';
        btn.textContent = i18n.t('BARBARIAN_DOWNGRADE_CITY', { hexes: hexes.map((r) => this.cardLabel(r)).join(', ') || vid });
        btn.addEventListener('click', async () => {
          try {
            await network.sendAction('downgrade_city', { vertexId: vid });
            modal.classList.remove('active');
          } catch (err) {
            this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
          }
        });
        list.appendChild(btn);
      });
    } else {
      closeBtn.style.display = '';
    }

    modal.classList.add('active');
  }

  /* =========================================================
   * ROBBER & DISCARD MODALS
   * ========================================================= */
  setupDiscardModal() {
    const modal = document.getElementById('discard-modal');
    const form = document.getElementById('discard-form');

    const updateDiscardSum = () => {
      const currentCount = this.getHandCardTypes().reduce((sum, res) => {
        const inp = document.getElementById(`discard-${res}`);
        return sum + (parseInt(inp?.value, 10) || 0);
      }, 0);
      const currentCountEl = document.getElementById('discard-current-count');
      if (currentCountEl) currentCountEl.textContent = currentCount;

      const neededCount = parseInt(document.getElementById('discard-needed-count')?.textContent, 10) || 0;
      const submitBtn = document.getElementById('btn-submit-discard');
      if (submitBtn) {
        submitBtn.disabled = (currentCount !== neededCount);
        if (currentCount === neededCount) {
          submitBtn.style.opacity = '1';
          submitBtn.style.cursor = 'pointer';
        } else {
          submitBtn.style.opacity = '0.5';
          submitBtn.style.cursor = 'not-allowed';
        }
      }
    };

    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-stepper');
      if (!btn) return;
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (!input) return;

      let currentVal = parseInt(input.value, 10) || 0;
      const maxVal = parseInt(input.max, 10) || 0;

      const totalSelected = this.getHandCardTypes().reduce((sum, res) => {
        const inp = document.getElementById(`discard-${res}`);
        return sum + (parseInt(inp?.value, 10) || 0);
      }, 0);
      const neededCount = parseInt(document.getElementById('discard-needed-count')?.textContent, 10) || 0;

      if (btn.classList.contains('btn-stepper-inc')) {
        if (currentVal < maxVal && totalSelected < neededCount) {
          input.value = currentVal + 1;
        }
      } else if (btn.classList.contains('btn-stepper-dec')) {
        if (currentVal > 0) {
          input.value = currentVal - 1;
        }
      }
      updateDiscardSum();
    });

    const btnCloseRobber = document.getElementById('btn-close-robber-target');
    if (btnCloseRobber) {
      btnCloseRobber.addEventListener('click', () => {
        document.getElementById('robber-target-modal').classList.remove('active');
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.myPlayerId = network.currentPlayerId || this.myPlayerId;
      const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
      if (!me) return;

      const discarded = {};
      for (const type of this.getHandCardTypes()) {
        discarded[type] = parseInt(document.getElementById(`discard-${type}`).value, 10) || 0;
      }

      const sumDiscarded = Object.values(discarded).reduce((a, b) => a + b, 0);
      const neededCount = parseInt(document.getElementById('discard-needed-count')?.textContent, 10) || 0;
      if (sumDiscarded !== neededCount) {
        this.showToast(i18n.t('ERROR_MUST_DISCARD_EXACT_AMOUNT') || `Selectează exact ${neededCount} cărți.`, true);
        return;
      }

      try {
        const submitBtn = document.getElementById('btn-submit-discard');
        if (submitBtn) submitBtn.disabled = true;
        await network.sendAction('discard_cards', { discarded });
        modal.classList.remove('active');
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
        const submitBtn = document.getElementById('btn-submit-discard');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  checkDiscardState() {
    const modal = document.getElementById('discard-modal');
    if (!modal || !this.gameState) return;

    this.myPlayerId = network.currentPlayerId || this.myPlayerId;

    if (this.gameState.phase === 'TURN_DISCARD' && this.gameState.pendingDiscards && this.gameState.pendingDiscards.includes(this.myPlayerId)) {
      // Find me, or find any player in pendingDiscards that has detailed resource keys
      let me = this.gameState.players.find(p => p.id === this.myPlayerId);
      if (!me || (me.resources && typeof me.resources.wood !== 'number')) {
        const candidate = this.gameState.players.find(p => this.gameState.pendingDiscards.includes(p.id) && p.resources && typeof p.resources.wood === 'number');
        if (candidate) me = candidate;
      }
      if (!me) return;

      const handTypes = this.getHandCardTypes();
      const resCounts = {};
      for (const type of handTypes) {
        if (['cloth', 'coin', 'paper'].includes(type)) {
          resCounts[type] = (me.commodities && typeof me.commodities[type] === 'number') ? me.commodities[type] : 0;
        } else {
          resCounts[type] = (me.resources && typeof me.resources[type] === 'number') ? me.resources[type] : 0;
        }
      }

      const total = Object.values(resCounts).reduce((a, b) => a + b, 0);
      const needed = Math.floor(total / 2);
      const wallsBuilt = (me.citiesBuilt || []).filter((vid) => this.gameState.grid?.vertices?.[vid]?.building?.hasWall).length;
      const threshold = typeof me.discardThreshold === 'number' ? me.discardThreshold : (7 + wallsBuilt * 2);

      const neededCountEl = document.getElementById('discard-needed-count');
      if (neededCountEl) neededCountEl.textContent = needed;
      const thresholdHint = document.getElementById('discard-threshold-hint');
      if (thresholdHint) {
        thresholdHint.textContent = i18n.t('DISCARD_THRESHOLD_HINT', { needed, threshold, walls: wallsBuilt });
      }

      const isAlreadyActive = modal.classList.contains('active');

      document.body.classList.toggle('mode-cities-knights', this.isCitiesKnights());

      handTypes.forEach(res => {
        const inp = document.getElementById(`discard-${res}`);
        const count = resCounts[res];
        if (inp) {
          inp.max = count;
          if (!isAlreadyActive) {
            inp.value = 0;
          } else {
            const cur = parseInt(inp.value, 10) || 0;
            inp.value = Math.min(cur, count);
          }
        }
        const availSpan = document.getElementById(`discard-avail-${res}`);
        if (availSpan) {
          availSpan.textContent = `(${count})`;
        }
      });

      const currentCount = handTypes.reduce((sum, res) => {
        const inp = document.getElementById(`discard-${res}`);
        return sum + (parseInt(inp?.value, 10) || 0);
      }, 0);
      const currentCountEl = document.getElementById('discard-current-count');
      if (currentCountEl) currentCountEl.textContent = currentCount;

      const submitBtn = document.getElementById('btn-submit-discard');
      if (submitBtn) {
        submitBtn.disabled = (currentCount !== needed);
        if (currentCount === needed) {
          submitBtn.style.opacity = '1';
          submitBtn.style.cursor = 'pointer';
        } else {
          submitBtn.style.opacity = '0.5';
          submitBtn.style.cursor = 'not-allowed';
        }
      }

      modal.classList.add('active');
      this.startDiscardCountdown();
    } else {
      modal.classList.remove('active');
      this.stopDiscardCountdown();
    }
  }

  startDiscardCountdown() {
    this.stopDiscardCountdown();
    const el = document.getElementById('discard-timer-display');
    if (!el) return;

    const tick = () => {
      const deadline = this.gameState?.discardDeadline;
      if (!deadline) {
        el.textContent = '';
        return;
      }
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      el.textContent = `${secs}s`;
      el.style.color = secs <= 10 ? '#ef4444' : 'var(--gold-primary)';
    };
    tick();
    this.discardTimerInterval = setInterval(tick, 500);
  }

  stopDiscardCountdown() {
    if (this.discardTimerInterval) {
      clearInterval(this.discardTimerInterval);
      this.discardTimerInterval = null;
    }
  }

  openRobberTargetModal(hexId) {
    const modal = document.getElementById('robber-target-modal');
    const container = document.getElementById('robber-targets-list');
    container.innerHTML = '';

    const getCardCount = (p) => {
      if (!p || !p.resources) return 0;
      if (typeof p.resources.total === 'number') return p.resources.total;
      return Object.values(p.resources).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
    };

    // Find opponents adjacent to hexId
    const adjacentOpponentIds = new Set();
    for (const vKey of Object.keys(this.gameState.grid.vertices)) {
      const v = this.gameState.grid.vertices[vKey];
      if (v.hexes.includes(hexId) && v.building && v.building.playerId !== this.myPlayerId) {
        adjacentOpponentIds.add(v.building.playerId);
      }
    }

    if (adjacentOpponentIds.size === 0) {
      // No one adjacent to steal from, move robber immediately
      network.sendAction('move_robber', { hexId, targetPlayerId: null });
      this.showToast(i18n.t('ROBBER_MOVED_NO_TARGETS') || 'Hoțul a fost mutat. Niciun adversar adiacent.');
      audio.playRobber();
      return;
    }

    const opponentsList = [];
    adjacentOpponentIds.forEach(pId => {
      const opponent = this.gameState.players.find(p => p.id === pId);
      if (opponent) {
        opponentsList.push({ opponent, cardCount: getCardCount(opponent) });
      }
    });

    const eligible = opponentsList.filter(item => item.cardCount > 0);

    if (eligible.length === 0) {
      // Adjacent opponents all have 0 cards
      network.sendAction('move_robber', { hexId, targetPlayerId: null });
      this.showToast(i18n.t('ROBBER_NO_CARDS_TO_STEAL') || 'Hoțul a fost mutat. Adversarii adiacenți nu au cărți în mână.');
      audio.playRobber();
      return;
    }

    eligible.forEach(({ opponent, cardCount }) => {
      const item = document.createElement('div');
      item.className = 'robber-target-item';
      item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 10px 14px; gap: 12px;';
      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: ${opponent.color}; box-shadow: 0 0 6px ${opponent.color}99;"></span>
          <div>
            <div style="font-weight: 700; color: var(--text-primary); font-size: 14px;">${opponent.name}</div>
            <div style="font-size: 12px; color: var(--text-secondary);">${cardCount} ${i18n.t('CARDS_LABEL')}</div>
          </div>
        </div>
        <button type="button" class="btn-glass btn-primary btn-steal-card" style="padding: 8px 16px; font-size: 13px; font-weight: 700;">
          ${i18n.t('STEAL_1_RES_BTN')}
        </button>
      `;

      item.querySelector('.btn-steal-card').addEventListener('click', async () => {
        modal.classList.remove('active');
        try {
          const res = await network.sendAction('move_robber', { hexId, targetPlayerId: opponent.id });
          audio.playRobber();
          if (res && res.stolenResource) {
            const resName = i18n.t(`RES_${res.stolenResource.toUpperCase()}`);
            this.showToast(i18n.t('STOLE_RESOURCE_FROM', { resource: resName, player: opponent.name }), false);
          } else {
            this.showToast(i18n.t('ROBBER_NO_CARDS_TO_STEAL'), true);
          }
        } catch (err) {
          this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
        }
      });
      container.appendChild(item);
    });

    modal.classList.add('active');
  }

  /* =========================================================
   * TRADE MODAL (Domestic & Bank / Port)
   * ========================================================= */
  getBestBankRatio(resource) {
    if (this.isCommodity(resource)) return 4;
    if (!this.gameState || !this.gameState.grid) return 4;
    this.myPlayerId = network.currentPlayerId || this.myPlayerId;
    let me = this.gameState.players.find(p => p.id === this.myPlayerId);
    if (!me || (me.resources && typeof me.resources.wood !== 'number')) {
      const candidate = this.gameState.players.find(p => p.resources && typeof p.resources.wood === 'number');
      if (candidate) me = candidate;
    }
    if (!me) return 4;
    let bestRatio = 4;
    const ownedVertices = (me.settlementsBuilt || []).concat(me.citiesBuilt || []);
    for (const vId of ownedVertices) {
      const v = this.gameState.grid.vertices[vId];
      if (v && v.harbor) {
        if (v.harbor.type === resource && v.harbor.ratio === 2) {
          return 2;
        }
        if (v.harbor.type === 'generic' && v.harbor.ratio === 3) {
          bestRatio = Math.min(bestRatio, 3);
        }
      }
    }
    return bestRatio;
  }

  renderBankTradeUI() {
    const giveGrid = document.getElementById('bank-give-grid');
    const wantGrid = document.getElementById('bank-want-grid');
    if (!giveGrid || !wantGrid) return;

    giveGrid.innerHTML = '';
    wantGrid.innerHTML = '';

    const resources = this.getHandCardTypes();
    this.myPlayerId = network.currentPlayerId || this.myPlayerId;
    let me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
    if (!me || (me.resources && typeof me.resources.wood !== 'number')) {
      const candidate = this.gameState?.players?.find(p => p.resources && typeof p.resources.wood === 'number');
      if (candidate) me = candidate;
    }

    // Detect and display owned harbors
    const ownedHarbors = [];
    const ownedVertices = (me?.settlementsBuilt || []).concat(me?.citiesBuilt || []);
    for (const vId of ownedVertices) {
      const v = this.gameState?.grid?.vertices?.[vId];
      if (v && v.harbor) {
        if (v.harbor.type === 'generic') {
          const lbl = 'Port General (3:1)';
          if (!ownedHarbors.includes(lbl)) ownedHarbors.push(lbl);
        } else {
          const resName = i18n.t(`RES_${v.harbor.type.toUpperCase()}`);
          const lbl = `Port ${resName} (2:1)`;
          if (!ownedHarbors.includes(lbl)) ownedHarbors.push(lbl);
        }
      }
    }
    const harborsStatusEl = document.getElementById('bank-harbors-status');
    if (harborsStatusEl) {
      harborsStatusEl.textContent = ownedHarbors.length > 0
        ? `${i18n.t('BANK_HARBORS_OWNED', { harbors: ownedHarbors.join(', ') })}`
        : i18n.t('BANK_NO_HARBORS');
    }

    // Default auto-select give resource if none selected
    if (!this.bankTrade.give) {
      const firstAffordable = resources.find(r => {
        const ratio = this.getBestBankRatio(r);
        const have = this.getCardCount(me, r);
        return have >= ratio;
      });
      this.bankTrade.give = firstAffordable || 'wood';
    }

    // Ensure receive resource is not the same as give
    if (this.bankTrade.receive === this.bankTrade.give) {
      this.bankTrade.receive = null;
    }
    if (!this.bankTrade.receive) {
      const alternative = resources.find(r => r !== this.bankTrade.give);
      if (alternative) this.bankTrade.receive = alternative;
    }

    // Render Give Grid - always allow user to select any resource to trade
    resources.forEach(res => {
      const ratio = this.getBestBankRatio(res);
      const have = this.getCardCount(me, res);
      const canAfford = have >= ratio;
      const isSelected = this.bankTrade.give === res;

      let ratioClass = '';
      let ratioTag = `${ratio}:1 Bancă`;
      if (ratio === 2) {
        ratioClass = 'harbor-special';
        ratioTag = `2:1 Port`;
      } else if (ratio === 3) {
        ratioClass = 'harbor-generic';
        ratioTag = `3:1 Port`;
      }

      const card = document.createElement('div');
      card.className = `bank-res-card res-${res} ${isSelected ? 'selected' : ''} ${canAfford ? 'can-afford' : 'insufficient'}`;
      card.innerHTML = `
        <span class="bank-res-icon">${ico(res)}</span>
        <span class="bank-res-name">${this.cardLabel(res)}</span>
        <span class="bank-res-have" style="${canAfford ? 'color: #34d399; font-weight: 700;' : 'color: #f87171;'}">${i18n.t('BANK_CARDS_HAVE', { count: have })} / ${ratio}</span>
        <span class="bank-res-ratio ${ratioClass}">${ratioTag}</span>
      `;

      card.addEventListener('click', () => {
        this.bankTrade.give = res;
        if (this.bankTrade.receive === res) this.bankTrade.receive = null;
        this.renderBankTradeUI();
      });
      giveGrid.appendChild(card);
    });

    // Render Want Grid
    resources.forEach(res => {
      const isSelected = this.bankTrade.receive === res;
      const isGiveRes = this.bankTrade.give === res;

      const card = document.createElement('div');
      card.className = `bank-res-card res-${res} ${isSelected ? 'selected' : ''} ${isGiveRes ? 'disabled' : ''}`;
      card.innerHTML = `
        <span class="bank-res-icon">${ico(res)}</span>
        <span class="bank-res-name">${this.cardLabel(res)}</span>
        <span class="bank-res-have">+1 carte</span>
      `;

      if (!isGiveRes) {
        card.addEventListener('click', () => {
          this.bankTrade.receive = res;
          this.renderBankTradeUI();
        });
      }
      wantGrid.appendChild(card);
    });

    // Update Exchange Indicator Banner & Submit Button
    const ratioTextEl = document.getElementById('bank-ratio-text');
    const ratioDescEl = document.getElementById('bank-ratio-desc');
    const giveSummaryEl = document.getElementById('bank-give-summary');
    const wantSummaryEl = document.getElementById('bank-want-summary');
    const submitBtn = document.getElementById('btn-submit-bank-trade');

    if (this.bankTrade.give && this.bankTrade.receive) {
      const ratio = this.getBestBankRatio(this.bankTrade.give);
      const have = this.getCardCount(me, this.bankTrade.give);
      const canAfford = have >= ratio;
      const giveName = this.cardLabel(this.bankTrade.give);
      const recName = this.cardLabel(this.bankTrade.receive);

      if (ratioTextEl) ratioTextEl.textContent = i18n.t('BANK_RATE_VALUE', { ratio });
      if (ratioDescEl) {
        if (ratio === 2) ratioDescEl.textContent = i18n.t('BANK_PORT_APPLIED_2', { res: giveName });
        else if (ratio === 3) ratioDescEl.textContent = i18n.t('BANK_PORT_APPLIED_3');
        else ratioDescEl.textContent = i18n.t('BANK_STANDARD_RATIO');
      }

      if (giveSummaryEl) {
        giveSummaryEl.innerHTML = `${ratio}x ${giveName} <span style="font-size: 11px; opacity: 0.85;">(Ai ${have})</span>`;
      }
      if (wantSummaryEl) wantSummaryEl.textContent = `1x ${recName}`;

      if (submitBtn) {
        if (canAfford) {
          submitBtn.disabled = false;
          submitBtn.style.opacity = '1';
          submitBtn.style.cursor = 'pointer';
          submitBtn.textContent = `${i18n.t('ACTION_TRADE_BANK')}: ${ratio} ${giveName} ➔ 1 ${recName}`;
        } else {
          submitBtn.disabled = true;
          submitBtn.style.opacity = '0.6';
          submitBtn.style.cursor = 'not-allowed';
          submitBtn.textContent = `${i18n.t('ERROR_NOT_ENOUGH_RESOURCES')} (${have}/${ratio} ${giveName})`;
        }
      }
    } else {
      if (giveSummaryEl) giveSummaryEl.textContent = i18n.t('SELECT_GIVE');
      if (wantSummaryEl) wantSummaryEl.textContent = i18n.t('SELECT_RECEIVE');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.6';
        submitBtn.style.cursor = 'not-allowed';
        submitBtn.textContent = i18n.t('BANK_SELECT_RESOURCES');
      }
    }
  }

  setupTradeModals() {
    const tradeModal = document.getElementById('trade-modal');
    const tabPlayer = document.getElementById('tab-trade-player');
    const tabBank = document.getElementById('tab-trade-bank');
    const sectionPlayer = document.getElementById('trade-player-section');
    const sectionBank = document.getElementById('trade-bank-section');

    this.bankTrade = { give: null, receive: null };

    const resetTradeSteppers = () => {
      this.myPlayerId = network.currentPlayerId || this.myPlayerId;
      const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
      this.getHandCardTypes().forEach(res => {
        // Reset Give
        const giveInput = document.getElementById(`trade-give-${res}`);
        const giveVal = document.getElementById(`val-trade-give-${res}`);
        const availSpan = document.getElementById(`trade-avail-${res}`);
        if (giveInput) giveInput.value = '0';
        if (giveVal) giveVal.textContent = '0';
        if (availSpan) {
          availSpan.textContent = `(${this.getCardCount(me, res)})`;
        }
        // Reset Want
        const wantInput = document.getElementById(`trade-want-${res}`);
        const wantVal = document.getElementById(`val-trade-want-${res}`);
        if (wantInput) wantInput.value = '0';
        if (wantVal) wantVal.textContent = '0';
      });
    };

    // Open Trade Modal
    document.getElementById('btn-open-trade').addEventListener('click', () => {
      resetTradeSteppers();
      this.renderBankTradeUI();
      const isMyTurn = this.gameState && this.gameState.currentPlayerId === this.myPlayerId;
      const isActionPhase = this.gameState && this.gameState.phase === 'TURN_ACTION';
      const canTrade = isMyTurn && isActionPhase;
      const proposeBtn = document.getElementById('btn-submit-propose-trade');
      if (proposeBtn) {
        proposeBtn.disabled = !canTrade;
        proposeBtn.textContent = canTrade ? i18n.t('PROPOSE_TRADE_BTN') : i18n.t('TRADE_ONLY_ON_YOUR_TURN');
      }
      if (tabPlayer && tabBank && sectionPlayer && sectionBank) {
        tabPlayer.classList.add('active');
        tabBank.classList.remove('active');
        sectionPlayer.style.display = 'block';
        sectionBank.style.display = 'none';
      }
      tradeModal.classList.add('active');
    });

    // Close / Cancel Trade Modal (X button and all Cancel buttons)
    document.querySelectorAll('.btn-close-trade-modal, #btn-close-trade').forEach(btn => {
      btn.addEventListener('click', () => {
        tradeModal.classList.remove('active');
      });
    });

    // Segmented tab switching
    if (tabPlayer && tabBank && sectionPlayer && sectionBank) {
      tabPlayer.addEventListener('click', () => {
        tabPlayer.classList.add('active');
        tabBank.classList.remove('active');
        sectionPlayer.style.display = 'block';
        sectionBank.style.display = 'none';
      });

      tabBank.addEventListener('click', () => {
        tabBank.classList.add('active');
        tabPlayer.classList.remove('active');
        sectionBank.style.display = 'block';
        sectionPlayer.style.display = 'none';
        this.renderBankTradeUI();
      });
    }

    // Resource Stepper buttons [-] and [+]
    document.querySelectorAll('.btn-stepper').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const input = document.getElementById(targetId);
        const valSpan = document.getElementById(`val-${targetId}`);
        if (!input || !valSpan) return;

        let curVal = parseInt(input.value) || 0;
        const isAdd = btn.classList.contains('btn-stepper-add');

        if (isAdd) {
          if (targetId.startsWith('trade-give-')) {
            const resType = targetId.replace('trade-give-', '');
            const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
            const maxAvail = this.getCardCount(me, resType);
            if (curVal >= maxAvail) {
              this.showToast(i18n.t('ERROR_NOT_ENOUGH_RESOURCES'), true);
              return;
            }
          }
          curVal++;
        } else {
          if (curVal > 0) curVal--;
        }

        input.value = curVal;
        valSpan.textContent = curVal;
      });
    });

    // Propose Trade
    document.getElementById('form-propose-trade').addEventListener('submit', async (e) => {
      e.preventDefault();
      const isMyTurn = this.gameState && this.gameState.currentPlayerId === this.myPlayerId;
      const isActionPhase = this.gameState && this.gameState.phase === 'TURN_ACTION';
      if (!isMyTurn || !isActionPhase) {
        this.showToast(i18n.t('ERROR_NOT_YOUR_TURN'), true);
        return;
      }
      const give = {};
      const want = {};
      for (const res of this.getHandCardTypes()) {
        give[res] = parseInt(document.getElementById(`trade-give-${res}`)?.value, 10) || 0;
        want[res] = parseInt(document.getElementById(`trade-want-${res}`)?.value, 10) || 0;
      }

      const totalGive = Object.values(give).reduce((a, b) => a + b, 0);
      const totalWant = Object.values(want).reduce((a, b) => a + b, 0);
      if (totalGive === 0 && totalWant === 0) {
        this.showToast(i18n.t('TRADE_INVALID_SELECTION'), true);
        return;
      }

      try {
        await network.sendAction('propose_trade', { give, want });
        audio.playTrade();
        tradeModal.classList.remove('active');
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    });

    // Bank Trade (Colonist style visual card selection)
    document.getElementById('form-bank-trade').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!this.bankTrade.give || !this.bankTrade.receive) {
        this.showToast(i18n.t('BANK_SELECT_RESOURCES'), true);
        return;
      }
      const give = this.bankTrade.give;
      const receive = this.bankTrade.receive;
      if (give === receive) {
        this.showToast(i18n.t('TRADE_SAME_BANK_RESOURCE'), true);
        return;
      }

      const ratio = this.getBestBankRatio(give);
      const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
      if (me && (me.resources[give] || 0) < ratio) {
        this.showToast(i18n.t('ERROR_NOT_ENOUGH_RESOURCES'), true);
        return;
      }

      try {
        await network.sendAction('bank_trade', { give, receive, ratio });
        audio.playTrade();
        tradeModal.classList.remove('active');
        const giveName = i18n.t(`RES_${give.toUpperCase()}`);
        const recName = i18n.t(`RES_${receive.toUpperCase()}`);
        this.showToast(i18n.t('BANK_TRADE_SUCCESS', { ratio, give: giveName, receive: recName }), false);
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
      }
    });
  }

  setupDevCardsModal() {
    const modal = document.getElementById('dev-cards-modal');
    document.getElementById('btn-open-dev-cards').addEventListener('click', () => {
      this.renderDevCardsList();
      modal.classList.add('active');
    });
    document.getElementById('btn-close-dev-cards').addEventListener('click', () => {
      modal.classList.remove('active');
    });
    const closeX = document.getElementById('btn-close-dev-cards-x');
    if (closeX) {
      closeX.addEventListener('click', () => modal.classList.remove('active'));
    }

    // Monopoly & Year of Plenty dialog close listeners
    const closeMonopoly = document.getElementById('btn-close-monopoly');
    if (closeMonopoly) {
      closeMonopoly.addEventListener('click', () => {
        document.getElementById('monopoly-modal').classList.remove('active');
      });
    }
    const closeYop = document.getElementById('btn-close-yop');
    if (closeYop) {
      closeYop.addEventListener('click', () => {
        document.getElementById('year-of-plenty-modal').classList.remove('active');
      });
    }
  }

  renderDevCardsList() {
    const container = document.getElementById('dev-cards-list');
    container.innerHTML = '';
    if (!this.gameState) return;

    const me = this.gameState.players.find(p => p.id === this.myPlayerId);
    const unplayedCards = me && Array.isArray(me.devCards) ? me.devCards.filter(c => !c.played) : [];
    if (!me || unplayedCards.length === 0) {
      container.innerHTML = `<p style="color: var(--text-secondary); text-align: center; padding: 24px 0;">${i18n.t('NO_DEV_CARDS_IN_HAND')}</p>`;
      return;
    }

    unplayedCards.forEach(card => {
      const cardEl = document.createElement('div');
      cardEl.className = 'room-card';
      const cardName = i18n.t(`CARD_${card.type.toUpperCase()}`);
      const cardDesc = i18n.t(`CARD_${card.type.toUpperCase()}_DESC`);
      const isBoughtThisTurn = card.boughtTurn === this.gameState.turnNumber;

      let actionMarkup = '';
      if (card.type === 'victory_point') {
        actionMarkup = `<span class="dev-card-vp-badge">${i18n.t('VP_COUNTED_AUTO')}</span>`;
      } else if (isBoughtThisTurn) {
        actionMarkup = `<span class="dev-card-rule-badge">${i18n.t('CANNOT_PLAY_TURN_BOUGHT')}</span>`;
      } else {
        actionMarkup = `<button class="btn-glass btn-primary btn-play-card" data-id="${card.id}">${i18n.t('ACTION_PLAY_CARD')}</button>`;
      }

      cardEl.innerHTML = `
        <div style="flex: 1;">
          <h4 style="font-size: 15px; font-weight: 700; color: var(--gold-primary);">${cardName}</h4>
          <p style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">${cardDesc}</p>
        </div>
        <div style="display: flex; align-items: center;">
          ${actionMarkup}
        </div>
      `;

      const playBtn = cardEl.querySelector('.btn-play-card');
      if (playBtn) {
        playBtn.addEventListener('click', async () => {
          document.getElementById('dev-cards-modal').classList.remove('active');

          if (card.type === 'monopoly') {
            const monopolyModal = document.getElementById('monopoly-modal');
            monopolyModal.classList.add('active');
            const btns = monopolyModal.querySelectorAll('.res-choice-btn');
            btns.forEach(b => {
              b.onclick = async () => {
                const res = b.dataset.res;
                try {
                  await network.sendAction('play_dev_card', { cardId: card.id, options: { resource: res } });
                  audio.playBuild();
                  monopolyModal.classList.remove('active');
                } catch (err) {
                  this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
                }
              };
            });
          } else if (card.type === 'year_of_plenty') {
            const yopModal = document.getElementById('year-of-plenty-modal');
            yopModal.classList.add('active');
            const confirmBtn = document.getElementById('btn-confirm-yop');
            confirmBtn.onclick = async () => {
              const res1 = document.getElementById('yop-res-1').value;
              const res2 = document.getElementById('yop-res-2').value;
              try {
                await network.sendAction('play_dev_card', { cardId: card.id, options: { res1, res2 } });
                audio.playBuild();
                yopModal.classList.remove('active');
              } catch (err) {
                this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
              }
            };
          } else if (card.type === 'knight') {
            try {
              await network.sendAction('play_dev_card', { cardId: card.id });
              audio.playBuild();
              this.showToast(i18n.t('KNIGHT_PLAYED_TOAST'));
            } catch (err) {
              this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
            }
          } else if (card.type === 'road_building') {
            try {
              await network.sendAction('play_dev_card', { cardId: card.id });
              audio.playBuild();
              this.activateBuildRoad();
              this.showToast(i18n.t('ROAD_BUILDING_PLAYED_TOAST'));
            } catch (err) {
              this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
            }
          } else {
            try {
              await network.sendAction('play_dev_card', { cardId: card.id });
              audio.playBuild();
            } catch (err) {
              this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
            }
          }
        });
      }

      container.appendChild(cardEl);
    });
  }

  /* =========================================================
   * NETWORK SYNC
   * ========================================================= */
  bindNetworkEvents() {
    network.onLobbyUpdate = (lobbyData) => {
      this.renderWaitingRoom(lobbyData);
    };

    network.onGameStarted = () => {
      this.showView('view-game');
      audio.playTurnAlert();
    };

    network.onTimerTick = (data) => {
      const timerEl = document.getElementById('turn-timer-display');
      if (timerEl) {
        timerEl.textContent = `${data.remaining}s`;
        timerEl.style.color = data.remaining <= 10 ? '#ef4444' : '#38bdf8';
      }
    };

    network.onStateUpdate = (payload) => {
      this.gameState = payload.state;
      this.currentRoom = payload.room;
      this.renderGameState();
    };

    network.onChatReceived = (msg) => {
      this.appendChatMessage(msg);
    };
  }

  renderGameState() {
    const s = this.gameState;
    if (!s) return;

    // Render SVG Board
    if (s.phase === 'SETUP_ROUND_1' || s.phase === 'SETUP_ROUND_2') {
      const curPlayer = s.players[s.currentTurnPlayerIndex];
      const isMySetup = curPlayer.id === this.myPlayerId;

      // Auto highlight valid vertices or edges during setup
      if (isMySetup) {
        if (!s.grid) return;
        const validIds = new Set();
        if (curPlayer.settlementsBuilt.length === curPlayer.roadsBuilt.length) {
          // Settlement step
          for (const [vId, v] of Object.entries(s.grid.vertices)) {
            if (!v.building) {
              const noAdj = v.adjacentVertices.every(adjId => !s.grid.vertices[adjId].building);
              if (noAdj) validIds.add(vId);
            }
          }
          this.boardRenderer.render(s.grid, { type: 'settlement', validIds });
        } else {
          // Road step: connect to the last settlement
          const lastVId = curPlayer.settlementsBuilt[curPlayer.settlementsBuilt.length - 1];
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
    } else if (s.phase === 'TURN_ROBBER' && s.players[s.currentTurnPlayerIndex].id === this.myPlayerId) {
      // Robber target highlight
      this.boardRenderer.render(s.grid, { type: 'robber' });
    } else {
      const rollSum = (s.dice && s.dice.length === 2 && s.hasRolledDice) ? s.dice[0] + s.dice[1] : null;
      this.boardRenderer.render(s.grid, this.selectedAction, rollSum);
    }

    // Check discard modal
    this.checkDiscardState();

    // Update Turn Banner & Buttons
    const curPlayer = s.players[s.currentTurnPlayerIndex];
    const isMyTurn = curPlayer.id === this.myPlayerId;

    document.getElementById('turn-commander-name').textContent = curPlayer.name;
    document.getElementById('turn-commander-name').style.color = curPlayer.color;
    document.getElementById('round-number-display').textContent = s.turnNumber;

    const rollBtn = document.getElementById('btn-roll-dice');
    const endTurnBtn = document.getElementById('btn-end-turn');
    const buildBtns = document.querySelectorAll('.btn-build-action');

    const isActionPhase = s.phase === 'TURN_ACTION' && isMyTurn;
    const isRollPhase = s.phase === 'TURN_ROLL' && isMyTurn;

    rollBtn.disabled = !isRollPhase;
    endTurnBtn.disabled = !isActionPhase;
    buildBtns.forEach(b => b.disabled = !isActionPhase);

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

    this.renderCkHud(s, s.players.find(p => p.id === this.myPlayerId), isActionPhase);

    // Update My Resources
    const me = s.players.find(p => p.id === this.myPlayerId);
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
        const unplayed = (me.devCards || []).filter(c => !c.played);
        devBadge.textContent = unplayed.length;
        devBadge.style.display = unplayed.length > 0 ? 'inline-flex' : 'none';
      }
    }

    // Update Opponents list
    const oppContainer = document.getElementById('opponents-list');
    oppContainer.innerHTML = '';
    s.players.forEach(p => {
      const card = document.createElement('div');
      card.className = 'opponent-mini-card';
      const resourceCount = typeof p.resources.total === 'number'
        ? p.resources.total
        : Object.values(p.resources || {}).reduce((a, b) => a + b, 0);
      const commodityCount = typeof p.commodities?.total === 'number'
        ? p.commodities.total
        : Object.values(p.commodities || {}).reduce((a, b) => a + b, 0);
      const cardCount = resourceCount + commodityCount;

      card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${p.color};"></span>
          <span style="font-weight: 600;">${p.name} ${p.id === this.myPlayerId ? '(You)' : ''}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 11px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 4px;">
            ${ico('cards', 'ico-opp')}
            ${cardCount}
          </span>
          <span class="opponent-vp-badge">${p.victoryPoints} ${i18n.t('VICTORY_POINTS_ABBR')}</span>
        </div>
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
      const winner = s.players.find(p => p.victoryPoints >= s.vpTarget) || curPlayer;
      document.getElementById('victory-winner-name').textContent = winner.name;
      document.getElementById('victory-modal').classList.add('active');
      audio.playVictory();
    }
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
        const isSettlementStep = curPlayer.settlementsBuilt.length === curPlayer.roadsBuilt.length;
        if (s.phase === 'SETUP_ROUND_1') {
          hintText = isSettlementStep ? i18n.t('SETUP_HINT_SETTLEMENT_1') : i18n.t('SETUP_HINT_ROAD_1');
        } else {
          hintText = isSettlementStep ? i18n.t('SETUP_HINT_SETTLEMENT_2') : i18n.t('SETUP_HINT_ROAD_2');
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
    } else if (s.phase === 'TURN_ROLL') {
      if (isMyTurn) {
        isActionable = true;
        hintText = i18n.t('ACTION_HINT_ROLL');
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
        }
      }
    }

    hintTextEl.textContent = hintText;
    if (isActionable) {
      hintPill.classList.add('hint-active');
    } else {
      hintPill.classList.remove('hint-active');
    }
  }

  renderLog(logs) {
    if (!logs) return;
    const logScroll = document.getElementById('log-scroll');
    logScroll.innerHTML = '';
    this.myPlayerId = network.currentPlayerId || this.myPlayerId;
    const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;

    // Check for newly added events since last render
    if (logs.length > (this.lastProcessedLogCount || 0)) {
      const newEntries = logs.slice(this.lastProcessedLogCount || 0);
      newEntries.forEach(entry => {
        if (entry.type === 'ROBBER_STOLE' && me && entry.args && entry.args.victimName === me.name && entry.args.robberName !== me.name) {
          this.showToast(i18n.t('ROBBER_STOLE_FROM_YOU', { robber: entry.args.robberName }), true);
        } else if (entry.type === 'RESOURCE_PRODUCED' && me && entry.args && entry.args.playerName === me.name) {
          const resLocalized = i18n.t(`RES_${entry.args.resource.toUpperCase()}`);
          const message = i18n.t('YOU_RECEIVED_RESOURCE', { amount: entry.args.amount, resource: resLocalized });
          if (this.diceAnim) this.deferredProductionToasts.push(message);
          else this.showToast(message);
        }
      });
      this.lastProcessedLogCount = logs.length;
    }

    logs.slice().reverse().forEach(entry => {
      const el = document.createElement('div');
      el.className = 'log-entry';
      const argsCopy = entry.args ? { ...entry.args } : {};
      if (argsCopy.resource) {
        argsCopy.resource = i18n.t(`RES_${argsCopy.resource.toUpperCase()}`);
      }
      if (argsCopy.give) {
        argsCopy.give = i18n.t(`RES_${argsCopy.give.toUpperCase()}`);
      }
      if (argsCopy.receive) {
        argsCopy.receive = i18n.t(`RES_${argsCopy.receive.toUpperCase()}`);
      }
      el.textContent = i18n.t(entry.messageKey, argsCopy);
      logScroll.appendChild(el);
    });
  }

  appendChatMessage(msg) {
    const container = document.getElementById('chat-messages');
    const el = document.createElement('div');
    el.style.marginBottom = '6px';
    el.innerHTML = `
      <span style="color: ${msg.color || '#f59e0b'}; font-weight: 700;">${msg.senderName}:</span>
      <span style="color: var(--text-primary);">${msg.text}</span>
    `;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  renderActiveTradeBanner(activeTrade) {
    const banner = document.getElementById('active-trade-banner');
    if (!banner) return;
    if (!activeTrade) {
      banner.style.display = 'none';
      this.lastTradeKey = null;
      return;
    }

    const isMine = activeTrade.fromPlayerId === this.myPlayerId;
    banner.style.display = 'flex';

    const from = this.gameState ? this.gameState.players.find(p => p.id === activeTrade.fromPlayerId) : null;
    const fromName = from ? from.name : '?';

    // Notify receivers with chime & toast once per new incoming offer
    if (!isMine) {
      const key = `${activeTrade.fromPlayerId}:${JSON.stringify(activeTrade.give)}:${JSON.stringify(activeTrade.want)}`;
      if (key !== this.lastTradeKey) {
        audio.playTrade();
        this.showToast(i18n.t('TRADE_OFFER_FROM', { name: fromName }));
        this.lastTradeKey = key;
      }
    } else {
      this.lastTradeKey = null;
    }

    // Helper to render resource/commodity chips
    const renderChips = (cardObj) => {
      const entries = Object.entries(cardObj || {}).filter(([_, c]) => c > 0);
      if (entries.length === 0) return `<span style="font-size: 11px; color: var(--text-muted);">-</span>`;
      return entries.map(([r, c]) => `
        <span class="trade-chip res-${r}">
          ${ico(r)}
          <span>${c} ${this.cardLabel(r)}</span>
        </span>
      `).join('');
    };

    const giveChips = renderChips(activeTrade.give);
    const wantChips = renderChips(activeTrade.want);

    // Build accepted-by confirm buttons for trade initiator
    const acceptedPlayers = (activeTrade.acceptedBy || []).map(pid =>
      this.gameState ? this.gameState.players.find(p => p.id === pid) : null
    ).filter(Boolean);

    let contentHTML = '';

    if (isMine) {
      // Initiator perspective
      let confirmButtonsHTML = '';
      if (acceptedPlayers.length > 0) {
        confirmButtonsHTML = acceptedPlayers.map(p =>
          `<button class="btn-glass btn-trade-confirm btn-confirm-trade" data-pid="${p.id}">✅ ${i18n.t('CONFIRM_WITH')} ${p.name}</button>`
        ).join('');
      }

      contentHTML = `
        <div class="trade-banner-body">
          <div class="trade-banner-header">
            <span>🤝</span>
            <span>${i18n.t('TRADE_YOUR_OFFER')}</span>
          </div>
          <div class="trade-banner-exchange">
            <div class="trade-exchange-side">
              <span class="trade-side-label" style="color: #f87171;">${i18n.t('TRADE_GIVE_LABEL')}:</span>
              <div class="trade-chips-list">${giveChips}</div>
            </div>
            <span class="trade-arrow">&rarr;</span>
            <div class="trade-exchange-side">
              <span class="trade-side-label" style="color: #34d399;">${i18n.t('TRADE_RECEIVE_LABEL')}:</span>
              <div class="trade-chips-list">${wantChips}</div>
            </div>
          </div>
          ${acceptedPlayers.length > 0
            ? `<div class="trade-status-badge">✔ ${acceptedPlayers.map(p => p.name).join(', ')} a acceptat!</div>`
            : `<div style="font-size: 11px; color: var(--text-secondary);">${i18n.t('TRADE_WAITING_PLAYERS')}</div>`
          }
        </div>
        <div class="trade-banner-actions">
          ${confirmButtonsHTML}
          <button class="btn-glass btn-secondary btn-cancel-trade">${i18n.t('CANCEL_ACTION')}</button>
        </div>
      `;
    } else {
      // Receiver perspective
      const hasAccepted = (activeTrade.acceptedBy || []).includes(this.myPlayerId);
      const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
      const canAfford = me ? Object.entries(activeTrade.want).every(([res, amt]) => this.getCardCount(me, res) >= amt) : true;

      let actionButtonsHTML = '';
      if (hasAccepted) {
        actionButtonsHTML = `
          <span class="trade-status-badge">✔ ${i18n.t('TRADE_YOU_ACCEPTED')}</span>
          <button class="btn-glass btn-trade-decline btn-decline-trade">${i18n.t('TRADE_RETRACT')}</button>
        `;
      } else if (canAfford) {
        actionButtonsHTML = `
          <button class="btn-glass btn-trade-accept btn-accept-trade">${i18n.t('ACCEPT_TRADE_BTN')}</button>
          <button class="btn-glass btn-trade-decline btn-decline-trade">${i18n.t('DECLINE_TRADE_BTN')}</button>
        `;
      } else {
        actionButtonsHTML = `
          <button class="btn-glass btn-trade-disabled" disabled title="${i18n.t('TRADE_NOT_ENOUGH_CARDS')}">${i18n.t('TRADE_NOT_ENOUGH_CARDS')}</button>
          <button class="btn-glass btn-trade-decline btn-decline-trade">${i18n.t('DECLINE_TRADE_BTN')}</button>
        `;
      }

      contentHTML = `
        <div class="trade-banner-body">
          <div class="trade-banner-header">
            <span>🤝</span>
            <span>${i18n.t('TRADE_OFFER_FROM', { name: fromName })}</span>
          </div>
          <div class="trade-banner-exchange">
            <div class="trade-exchange-side">
              <span class="trade-side-label" style="color: #34d399;">${i18n.t('TRADE_RECEIVE_LABEL')}:</span>
              <div class="trade-chips-list">${giveChips}</div>
            </div>
            <span class="trade-arrow">&larr;</span>
            <div class="trade-exchange-side">
              <span class="trade-side-label" style="color: #f87171;">${i18n.t('TRADE_GIVE_LABEL')}:</span>
              <div class="trade-chips-list">${wantChips}</div>
            </div>
          </div>
        </div>
        <div class="trade-banner-actions">
          ${actionButtonsHTML}
        </div>
      `;
    }

    banner.innerHTML = contentHTML;

    // Confirm trade buttons (initiator picks which accepted player to trade with)
    banner.querySelectorAll('.btn-confirm-trade').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await network.sendAction('confirm_trade', { targetPlayerId: btn.dataset.pid });
        } catch (err) {
          this.showToast(err.message, true);
        }
      });
    });

    const acceptBtn = banner.querySelector('.btn-accept-trade');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', async () => {
        try {
          await network.sendAction('respond_trade', { accept: true });
        } catch (err) {
          this.showToast(err.message, true);
        }
      });
    }

    const declineBtn = banner.querySelector('.btn-decline-trade');
    if (declineBtn) {
      declineBtn.addEventListener('click', async () => {
        await network.sendAction('respond_trade', { accept: false });
      });
    }

    const cancelBtn = banner.querySelector('.btn-cancel-trade');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        await network.sendAction('cancel_trade');
      });
    }
  }

  updateHUDText() {
    i18n.updateDOM();
    if (this.gameState) {
      this.renderGameState();
    }
  }
}

// Instantiate and start app on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  new CatanApp();
});
