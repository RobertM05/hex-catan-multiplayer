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
import { mapPhaseToStatusKey, mapPhaseToOpponentStateKey, canPayCost, canBuildWall, BUILD_COSTS } from './turnStatus.js';
import {
  getProgressDeck,
  PROGRESS_CARD_ICONS,
  unplayedProgressCards,
  revealedProgressCards
} from './progressCards.js';
import { TurnTimerUI } from './turnTimer.js';
import { confetti } from './confetti.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

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
    this.setupLobbyActions();
    this.setupWaitingRoomActions();
    this.setupInGameActions();
    this.setupHudOverlays();
    this.setupCkUi();
    this.setupTradeModals();
    this.setupDiscardModal();
    this.setupDevCardsModal();
    this.setupProgressCardUi();

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
    document.querySelectorAll('.lobby-tab-content').forEach(c => c.classList.add('is-hidden'));

    const activeBtn = document.getElementById(`tab-btn-${tab}`);
    const activeContent = document.getElementById(`tab-content-${tab}`);
    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.classList.remove('is-hidden');

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
        this.myPlayerId = res.playerId;
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
        this.myPlayerId = res.playerId;
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
            <h4 style="font-size: 16px; font-weight: 700;">${escapeHtml(r.name)}</h4>
            <span style="font-size: 12px; color: var(--text-secondary);">${i18n.t('HOST_LABEL')}: ${escapeHtml(r.hostName)} • ${r.playersCount}/${r.maxPlayers} ${i18n.t('PLAYERS_LABEL')}</span>
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
    this.myPlayerId = network.currentPlayerId || this.myPlayerId;
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

    // Summon Autonomous AI Agent
    const btnSpawnAgent = document.getElementById('btn-spawn-agent');
    if (btnSpawnAgent) {
      btnSpawnAgent.addEventListener('click', async () => {
        try {
          await network.spawnAiAgent();
          this.showToast(i18n.t('TOAST_AGENT_SUMMONED') || 'AI Agent summoned!');
        } catch (err) {
          this.showToast(err.message, true);
        }
      });
    }

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
    this.myPlayerId = network.currentPlayerId || this.myPlayerId;
    this.currentRoom = lobbyData;
    this.syncRulesModal(lobbyData.mode);
    const slotsContainer = document.getElementById('waiting-slots-grid');
    slotsContainer.innerHTML = '';

    const isHost = lobbyData.hostId === this.myPlayerId;
    document.getElementById('btn-start-game').classList.toggle('is-hidden', !isHost);
    document.getElementById('btn-add-bot').classList.toggle('is-hidden', !(isHost && lobbyData.players.length < lobbyData.maxPlayers));
    const btnSpawnAgent = document.getElementById('btn-spawn-agent');
    if (btnSpawnAgent) {
      btnSpawnAgent.classList.toggle('is-hidden', !(isHost && lobbyData.players.length < lobbyData.maxPlayers));
    }

    lobbyData.players.forEach(p => {
      const card = document.createElement('div');
      card.className = 'player-slot-card';
      card.style.setProperty('--player-color', p.color);
      card.innerHTML = `
        <div class="player-slot-header">
          <div class="player-slot-name" style="display: flex; align-items: center; gap: 6px;">
            ${escapeHtml(p.name)}
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
      if (!this.gameState || this.gameState.phase !== 'TURN_ACTION') return;
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
      if (v.building && v.building.type === 'city' && v.building.playerId === this.myPlayerId && !v.building.hasWall) {
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
        if (!dest || dest.building) continue;
        if (dest.knight) {
          if (dest.knight.playerId !== this.myPlayerId && dest.knight.strength < strength) {
            validIds.add(adjId);
          }
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
    const menu = document.getElementById('knight-action-menu');
    if (menu) menu.hidden = true;
  }

  openKnightActionMenu(vertexId, knight, evt) {
    const me = this.gameState.players.find(p => p.id === this.myPlayerId);
    if (!me || knight.playerId !== this.myPlayerId) return;
    const isMyTurn = this.gameState.players[this.gameState.currentTurnPlayerIndex]?.id === this.myPlayerId;
    if (!isMyTurn || this.gameState.phase !== 'TURN_ACTION') return;

    const wheat = me.resources?.wheat || 0;
    const wool = me.resources?.wool || 0;
    const ore = me.resources?.ore || 0;
    const politics = me.cityImprovements?.politics || 0;
    const nextRank = knight.rank === 'basic' ? 'strong' : knight.rank === 'strong' ? 'mighty' : null;
    const politicsNeeded = knight.rank === 'basic' ? 1 : 2;
    const vertex = this.gameState.grid.vertices[vertexId];
    const canChase = knight.active && vertex?.hexes?.includes(this.gameState.grid.robberHexId);

    const actions = [];
    if (!knight.active) {
      actions.push({
        label: i18n.t('KNIGHT_ACTIVATE'),
        disabled: wheat < 1,
        run: async () => {
          await network.sendAction('activate_knight', { vertexId });
          audio.playBuild();
        }
      });
    }
    if (nextRank) {
      actions.push({
        label: i18n.t('KNIGHT_PROMOTE'),
        disabled: wool < 1 || ore < 1 || politics < politicsNeeded || (me.knightsAvailable?.[nextRank] || 0) <= 0,
        run: async () => {
          await network.sendAction('promote_knight', { vertexId });
          audio.playBuild();
        }
      });
    }
    if (knight.active) {
      actions.push({
        label: i18n.t('KNIGHT_MOVE'),
        disabled: false,
        run: () => this.activateMoveKnight(vertexId, knight)
      });
      actions.push({
        label: i18n.t('KNIGHT_CHASE_ROBBER'),
        disabled: !canChase,
        run: () => this.activateChaseRobber(vertexId)
      });
    }

    const menu = document.getElementById('knight-action-menu');
    if (!menu) return;
    menu.innerHTML = actions.map((a, i) =>
      `<button type="button" class="btn-glass knight-action-btn" data-i="${i}" ${a.disabled ? 'disabled' : ''}>${a.label}</button>`
    ).join('');
    menu.hidden = false;
    const viewport = document.querySelector('.board-viewport');
    const rect = viewport.getBoundingClientRect();
    const x = evt?.clientX ? evt.clientX - rect.left : 24;
    const y = evt?.clientY ? evt.clientY - rect.top : 24;
    menu.style.left = `${Math.max(12, Math.min(x, rect.width - 240))}px`;
    menu.style.top = `${Math.max(12, Math.min(y, rect.height - 180))}px`;
    menu.querySelectorAll('.knight-action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = actions[Number(btn.dataset.i)];
        this.closeKnightActionMenu();
        if (!action || action.disabled) return;
        try {
          await action.run();
        } catch (err) {
          this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
        }
      });
    });
  }

  async confirmAndMoveKnight(fromVertexId, toVertexId) {
    const dest = this.gameState.grid.vertices[toVertexId];
    if (dest?.knight && dest.knight.playerId !== this.myPlayerId) {
      const ok = window.confirm(i18n.t('KNIGHT_DISPLACE_CONFIRM'));
      if (!ok) return;
    }
    try {
      const res = await network.sendAction('move_knight', { fromVertexId, toVertexId });
      audio.playBuild();
      if (res?.displaced?.pending) {
        this.showToast(i18n.t('KNIGHT_DISPLACE_WAIT'));
      } else if (res?.displaced?.removed) {
        this.showToast(i18n.t('KNIGHT_DISPLACED_REMOVED'));
      } else if (res?.displaced?.vertexId) {
        this.showToast(i18n.t('KNIGHT_DISPLACED_MOVED'));
      }
      this.clearActiveAction();
    } catch (err) {
      this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
    }
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
    this.renderWallSupplyAndButton(s, me, isActionPhase);
    this.renderProgressCardHand();
    this.notifyProgressDraws(s);
    this.checkProgressDiscardState();
    this.renderKnightSupply(me, isActionPhase);
  }

  renderWallSupplyAndButton(s, me, isActionPhase, notTurnReason) {
    const wallCount = document.getElementById('wall-supply-count');
    if (wallCount) wallCount.textContent = String(me?.cityWalls ?? 0);

    const wallBtn = document.getElementById('btn-build-city-wall');
    if (!wallBtn) return;

    if (!this.isCitiesKnights()) {
      this.setActionEnabled(wallBtn, false, notTurnReason || 'REASON_WRONG_PHASE');
      return;
    }

    const { allowed, reasonKey } = canBuildWall(me, this.isCitiesKnights(), isActionPhase, s?.grid);
    this.setActionEnabled(wallBtn, allowed, reasonKey || notTurnReason);

    if (!allowed && this.selectedAction && this.selectedAction.type === 'wall') {
      this.clearActiveAction();
    }
  }

  renderKnightSupply(me, isActionPhase) {
    const el = document.getElementById('knight-supply');
    const btn = document.getElementById('btn-place-knight');
    if (!el) return;
    if (!this.isCitiesKnights() || !me) {
      el.textContent = '';
      return;
    }
    const a = me.knightsAvailable || { basic: 0, strong: 0, mighty: 0 };
    el.textContent = i18n.t('KNIGHT_SUPPLY', {
      basic: a.basic ?? 0,
      strong: a.strong ?? 0,
      mighty: a.mighty ?? 0
    });
    if (btn) {
      const canPlace = isActionPhase && (a.basic || 0) > 0 && (me.resources?.ore || 0) >= 1 && (me.resources?.wool || 0) >= 1;
      btn.disabled = !canPlace;
      btn.title = i18n.t('PLACE_KNIGHT_COST');
    }
  }

  renderBankSupply(bank, isCk) {
    const container = document.getElementById('bank-pills-container');
    if (!container || !bank) return;

    const resIcons = {
      wood: '🌲', brick: '🧱', wool: '🐑', wheat: '🌾', ore: '⛰️',
      cloth: '🧶', coin: '🪙', paper: '📜'
    };

    let html = '';
    // Resources
    for (const [res, count] of Object.entries(bank.resources || {})) {
      html += `<div class="bank-pill bank-res-${res}" title="${i18n.t(`RES_${res.toUpperCase()}`)}: ${count} in bank">
        <span class="bank-pill-icon">${resIcons[res] || ''}</span>
        <span class="bank-pill-label">${this.cardLabel(res)}</span>
        <span class="bank-pill-count">${count}</span>
      </div>`;
    }

    // Commodities (if C&K)
    if (isCk && bank.commodities) {
      for (const [com, count] of Object.entries(bank.commodities)) {
        html += `<div class="bank-pill bank-com-${com}" title="${i18n.t(`COMM_${com.toUpperCase()}`)}: ${count} in bank">
          <span class="bank-pill-icon">${resIcons[com] || ''}</span>
          <span class="bank-pill-label">${this.cardLabel(com)}</span>
          <span class="bank-pill-count">${count}</span>
        </div>`;
      }
    }

    // Decks
    if (isCk && bank.decks) {
      if (bank.decks.trade !== undefined) {
        html += `<div class="bank-pill bank-deck-trade" title="Trade Progress Deck: ${bank.decks.trade} cards remaining">
          <span class="bank-pill-icon">📜</span>
          <span class="bank-pill-label">Trade</span>
          <span class="bank-pill-count">${bank.decks.trade}</span>
        </div>`;
      }
      if (bank.decks.politics !== undefined) {
        html += `<div class="bank-pill bank-deck-politics" title="Politics Progress Deck: ${bank.decks.politics} cards remaining">
          <span class="bank-pill-icon">🏛️</span>
          <span class="bank-pill-label">Politics</span>
          <span class="bank-pill-count">${bank.decks.politics}</span>
        </div>`;
      }
      if (bank.decks.science !== undefined) {
        html += `<div class="bank-pill bank-deck-science" title="Science Progress Deck: ${bank.decks.science} cards remaining">
          <span class="bank-pill-icon">🧪</span>
          <span class="bank-pill-label">Science</span>
          <span class="bank-pill-count">${bank.decks.science}</span>
        </div>`;
      }
    } else if (bank.decks?.devCards !== undefined) {
      html += `<div class="bank-pill bank-deck-dev" title="Development Deck: ${bank.decks.devCards} cards remaining">
        <span class="bank-pill-icon">🃏</span>
        <span class="bank-pill-label">Dev Cards</span>
        <span class="bank-pill-count">${bank.decks.devCards}</span>
      </div>`;
    }

    container.innerHTML = html;
  }

  renderKnightsOverview(overview) {
    const summaryBtn = document.getElementById('btn-open-knights-modal');
    const summaryText = document.getElementById('defense-summary-text');
    if (!overview || !this.isCitiesKnights()) {
      if (summaryBtn) summaryBtn.style.display = 'none';
      return;
    }
    if (summaryBtn) summaryBtn.style.display = 'inline-flex';

    if (summaryText) {
      const statusLabel = overview.isDefenseReady ? i18n.t('DEFENSE_STATUS_SAFE') : i18n.t('DEFENSE_STATUS_DANGER');
      summaryText.textContent = `⚔️ ${overview.totalActiveStrength} / 🏰 ${overview.totalCities} (${statusLabel}) · ⛵ ${overview.barbarianPosition}/7`;
    }

    if (summaryBtn) {
      summaryBtn.classList.toggle('safe', overview.isDefenseReady);
      summaryBtn.classList.toggle('danger', !overview.isDefenseReady);
    }

    const modal = document.getElementById('knights-overview-modal');
    if (modal && modal.classList.contains('active')) {
      this.populateKnightsModal(overview);
    }
  }

  populateKnightsModal(overview) {
    const banner = document.getElementById('knights-defense-status-banner');
    const container = document.getElementById('knights-players-table-container');
    if (!banner || !container) return;

    const isReady = overview.isDefenseReady;
    const margin = overview.defenseMargin;
    const percent = Math.min(100, Math.round((overview.barbarianPosition / 7) * 100));

    banner.innerHTML = `
      <div class="knights-defense-headline ${isReady ? 'safe' : 'danger'}">
        <span>${isReady ? '🛡️' : '⚠️'}</span>
        <span>${isReady
          ? i18n.t('DEFENSE_BANNER_SAFE', { active: overview.totalActiveStrength, cities: overview.totalCities, margin })
          : i18n.t('DEFENSE_BANNER_DANGER', { active: overview.totalActiveStrength, cities: overview.totalCities, shortfall: Math.abs(margin) })}</span>
      </div>
      <div class="knights-defense-track-row">
        <span>Barbarian Fleet: <strong>${overview.barbarianPosition} / 7</strong></span>
        <div class="knights-barbarian-progress-bar">
          <div class="knights-barbarian-progress-fill" style="width: ${percent}%;"></div>
        </div>
        <span>${overview.barbarianPosition >= 7 ? '⚔️ ATTACKING!' : `${7 - overview.barbarianPosition} steps away`}</span>
      </div>
    `;

    let html = '<div class="knights-players-grid">';
    for (const p of overview.players || []) {
      html += `
        <div class="knights-player-card">
          <div class="knights-player-card-header">
            <span style="display: flex; align-items: center; gap: 6px;">
              <span style="width: 10px; height: 10px; border-radius: 50%; background: ${p.color}; display: inline-block;"></span>
              <span>${escapeHtml(p.name)}</span>
            </span>
            <span style="color: ${p.activeStrength > 0 ? '#4ade80' : 'var(--text-secondary)'};">
              ⚔️ ${p.activeStrength} str
            </span>
          </div>
          <div class="knights-player-rank-list">
            <div class="knights-player-rank-row">
              <span class="knights-rank-badge">Basic (⚔1):</span>
              <span>${p.ranks.basic.active} active · ${p.ranks.basic.inactive} inactive</span>
            </div>
            <div class="knights-player-rank-row">
              <span class="knights-rank-badge">Strong (⚔2):</span>
              <span>${p.ranks.strong.active} active · ${p.ranks.strong.inactive} inactive</span>
            </div>
            <div class="knights-player-rank-row">
              <span class="knights-rank-badge">Mighty (⚔3):</span>
              <span>${p.ranks.mighty.active} active · ${p.ranks.mighty.inactive} inactive</span>
            </div>
          </div>
          <div class="knights-supply-row">
            <span>Reserve Supply:</span>
            <span>${p.availableSupply.basic}B · ${p.availableSupply.strong}S · ${p.availableSupply.mighty}M</span>
          </div>
        </div>
      `;
    }
    html += '</div>';
    container.innerHTML = html;
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
    const shipWrapper = document.getElementById('barbarian-ship-wrapper');
    const sublabel = document.getElementById('barbarian-sublabel');
    if (!wrap || !pips) return;
    const pos = Math.max(0, Math.min(7, s.barbarianPosition || 0));
    wrap.classList.toggle('barbarian-warning', pos >= 5);
    wrap.classList.toggle('barbarian-danger', pos >= 7);
    if (countEl) countEl.textContent = `${pos}/7`;

    if (shipWrapper) {
      const pct = (pos / 7) * 100;
      shipWrapper.style.left = `calc(${pct}% - ${Math.round(pct * 0.32)}px)`;
      shipWrapper.classList.toggle('ship-warning', pos >= 5);
      shipWrapper.classList.toggle('ship-danger', pos >= 7);
    }

    if (sublabel) {
      if (pos === 0) {
        sublabel.textContent = i18n.t('BARBARIAN_POS_0') || 'Distant Waters — Catan is Safe';
      } else if (pos < 5) {
        sublabel.textContent = i18n.t('BARBARIAN_POS_APPROACH', { step: pos, remain: 7 - pos }) || `Barbarians sailing to Catan (${7 - pos} steps away)`;
      } else if (pos < 7) {
        sublabel.textContent = i18n.t('BARBARIAN_POS_WARNING', { step: pos }) || `⚠️ WARNING: Invasion imminent! (${7 - pos} step left)`;
      } else {
        sublabel.textContent = i18n.t('BARBARIAN_POS_ATTACK') || '⚔️ Barbarian Attack in Progress!';
      }
    }

    pips.innerHTML = '';
    for (let i = 0; i <= 7; i++) {
      const pip = document.createElement('div');
      pip.className = 'barbarian-waypoint';
      pip.dataset.step = i;
      if (i < pos) pip.classList.add('passed');
      if (i === pos) pip.classList.add('current');
      if (i === 7) pip.classList.add('catan-shore');
      pip.title = i === 0 ? 'Distant Waters (Start)' : i === 7 ? 'Catan Shore (Invasion)' : `Step ${i} of 7`;
      pips.appendChild(pip);
    }

    if (this.boardRenderer && typeof this.boardRenderer.renderBarbarianShip === 'function') {
      this.boardRenderer.renderBarbarianShip(pos, this.isCitiesKnights());
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
    const pendingRewards = s.pendingBarbarianTieDraws || [];
    const result = s.lastBarbarianResult;
    const mustDowngrade = s.phase === 'TURN_BARBARIAN_DOWNGRADE' && me && pending.includes(me.id);
    const mustChooseReward = s.phase === 'TURN_BARBARIAN_REWARD' && me && pendingRewards.includes(me.id);

    if (!result && !mustDowngrade && !mustChooseReward) {
      modal.classList.remove('active');
      return;
    }

    const invasionId = result?.id || (result ? `${result.outcome}-${result.totalActiveKnights}-${result.totalCities}` : null);
    if (!mustDowngrade && !mustChooseReward && invasionId && this.dismissedBarbarianInvasionId === invasionId) {
      modal.classList.remove('active');
      return;
    }

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
      if (closeBtn) closeBtn.style.display = 'none';
      (me.citiesBuilt || []).filter((vid) => s.grid?.vertices?.[vid]?.building?.type === 'city').forEach((vid) => {
        const vertex = s.grid?.vertices?.[vid];
        const hexes = (vertex?.hexes || []).map((hid) => s.grid?.hexes?.[hid]?.resource).filter(Boolean);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-glass barbarian-city-btn';
        btn.textContent = i18n.t('BARBARIAN_DOWNGRADE_CITY', { hexes: hexes.map((r) => this.cardLabel(r)).join(', ') || vid });
        btn.addEventListener('click', async () => {
          try {
            await network.sendAction('downgrade_city', { vertexId: vid });
            if (invasionId) this.dismissedBarbarianInvasionId = invasionId;
            modal.classList.remove('active');
          } catch (err) {
            this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
          }
        });
        list.appendChild(btn);
      });
    } else if (mustChooseReward) {
      if (closeBtn) closeBtn.style.display = 'none';
      const promptTitle = document.createElement('div');
      promptTitle.className = 'barbarian-reward-title';
      promptTitle.style.fontWeight = 'bold';
      promptTitle.style.marginBottom = '10px';
      promptTitle.textContent = i18n.t('BARBARIAN_CHOOSE_REWARD');
      list.appendChild(promptTitle);

      const decks = [
        { id: 'trade', label: i18n.t('BARBARIAN_CHOOSE_DECK_TRADE'), icon: '📜' },
        { id: 'politics', label: i18n.t('BARBARIAN_CHOOSE_DECK_POLITICS'), icon: '🏛️' },
        { id: 'science', label: i18n.t('BARBARIAN_CHOOSE_DECK_SCIENCE'), icon: '🧪' }
      ];

      decks.forEach((deck) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-glass barbarian-reward-btn';
        btn.style.margin = '4px';
        btn.textContent = `${deck.icon} ${deck.label}`;
        btn.addEventListener('click', async () => {
          try {
            await network.sendAction('choose_barbarian_reward', { deck: deck.id });
            if (invasionId) this.dismissedBarbarianInvasionId = invasionId;
            modal.classList.remove('active');
          } catch (err) {
            this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
          }
        });
        list.appendChild(btn);
      });
    } else {
      if (closeBtn) {
        closeBtn.style.display = '';
        if (!this.barbarianCloseBound) {
          this.barbarianCloseBound = true;
          closeBtn.addEventListener('click', () => {
            const curResult = this.gameState?.lastBarbarianResult;
            const curId = curResult?.id || (curResult ? `${curResult.outcome}-${curResult.totalActiveKnights}-${curResult.totalCities}` : null);
            if (curId) this.dismissedBarbarianInvasionId = curId;
            modal.classList.remove('active');
          });
        }
      }
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
        this.showToast(i18n.t('ERROR_MUST_DISCARD_EXACT_AMOUNT') || `Select exactly ${neededCount} cards.`, true);
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

  openRobberTargetModal(hexId, options = {}) {
    const chaseFrom = options.chaseFrom || null;
    const sendMove = (targetPlayerId) => chaseFrom
      ? network.sendAction('chase_robber', { vertexId: chaseFrom, hexId, targetPlayerId })
      : network.sendAction('move_robber', { hexId, targetPlayerId });
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
      sendMove(null);
      this.showToast(i18n.t('ROBBER_MOVED_NO_TARGETS') || 'Robber moved. No adjacent opponents to rob.');
      audio.playRobber();
      if (chaseFrom) this.clearActiveAction();
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
      sendMove(null);
      this.showToast(i18n.t('ROBBER_NO_CARDS_TO_STEAL') || 'Robber moved. Adjacent opponents have no cards to steal.');
      audio.playRobber();
      if (chaseFrom) this.clearActiveAction();
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
            <div style="font-weight: 700; color: var(--text-primary); font-size: 14px;">${escapeHtml(opponent.name)}</div>
            <div style="font-size: 12px; color: var(--text-secondary);">${cardCount} ${i18n.t('CARDS_LABEL')}</div>
          </div>
        </div>
        <button type="button" class="btn-glass btn-primary btn-steal-card" style="padding: 8px 16px; font-size: 13px; font-weight: 700;">
          ${i18n.t('STEAL_1_RANDOM_CARD_BTN') || i18n.t('STEAL_1_RES_BTN')}
        </button>
      `;

      item.querySelector('.btn-steal-card').addEventListener('click', async () => {
        modal.classList.remove('active');
        try {
          const res = await sendMove(opponent.id);
          audio.playRobber();
          if (chaseFrom) this.clearActiveAction();
          if (res && res.stolenResource) {
            const cardName = this.cardLabel(res.stolenResource);
            this.showToast(i18n.t('STOLE_RANDOM_CARD_FROM', { resource: cardName, player: opponent.name }) || `You drew 1 random ${cardName} from ${opponent.name}!`, false);
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
    if (!this.gameState || !this.gameState.grid) return 4;
    this.myPlayerId = network.currentPlayerId || this.myPlayerId;
    let me = this.gameState.players.find(p => p.id === this.myPlayerId);
    if (!me || (me.resources && typeof me.resources.wood !== 'number')) {
      const candidate = this.gameState.players.find(p => p.resources && typeof p.resources.wood === 'number');
      if (candidate) me = candidate;
    }
    if (!me) return 4;
    if (me.merchantFleetActive) return 2;
    if ((me.cityImprovements?.trade || 0) >= 5) return 2;
    if (this.gameState.merchantHolder === this.myPlayerId && this.gameState.merchantHexId) {
      const hex = this.gameState.grid.hexes?.[this.gameState.merchantHexId];
      if (hex && hex.resource === resource) return 2;
    }
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
      let ratioTag = `${ratio}:1 Bank`;
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
        <span class="bank-res-have">+1 card</span>
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
        giveSummaryEl.innerHTML = `${ratio}x ${giveName} <span style="font-size: 11px; opacity: 0.85;">${i18n.t('AVAILABLE_IN_HAND', { count: have })}</span>`;
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
        sectionPlayer.classList.remove('is-hidden');
        sectionBank.classList.add('is-hidden');
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
        sectionPlayer.classList.remove('is-hidden');
        sectionBank.classList.add('is-hidden');
      });

      tabBank.addEventListener('click', () => {
        tabBank.classList.add('active');
        tabPlayer.classList.remove('active');
        sectionBank.classList.remove('is-hidden');
        sectionPlayer.classList.add('is-hidden');
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
      if (me && this.getCardCount(me, give) < ratio) {
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
        return `<button type="button" class="progress-card card-${deck} progress-card-reveal" data-card-id="${card.id}" title="${desc}">
          <span class="card-icon">${PROGRESS_CARD_ICONS[card.type] || '◆'}</span>
          <span class="card-name">${name}</span>
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
    const isActionPhase = this.gameState?.phase === 'TURN_ACTION' && isMyTurn;

    if (type === 'alchemist') {
      box.innerHTML = `<div class="alchemist-dice-row">
        <label>${i18n.t('PROGRESS_DIE_1')}<select id="alchemist-d1">${[1,2,3,4,5,6].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <label>${i18n.t('PROGRESS_DIE_2')}<select id="alchemist-d2">${[1,2,3,4,5,6].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
      </div>`;
      if (playBtn) playBtn.disabled = !(this.gameState.phase === 'TURN_ROLL' && isMyTurn);
      return;
    }

    if (type === 'resource_monopoly' || type === 'trade_monopoly') {
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

    if (type === 'commercial_harbor') {
      const available = ['wood','brick','wool','wheat','ore'].filter(r => (me?.resources?.[r] || 0) > 0);
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
          ${['wood','brick','wool','wheat','ore'].map(r => {
            const count = me?.resources?.[r] || 0;
            return `<button type="button" class="btn-glass res-choice-btn" data-res="${r}" ${count < 1 ? 'disabled' : ''}>${this.cardLabel(r)} (${count})</button>`;
          }).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-secondary);">
          ${opponentsWithCom.length > 0
            ? `Opponents holding commodities: ${opponentsWithCom.map(p => escapeHtml(p.name)).join(', ')}`
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
          <p>💍 <strong>Opponents with more VP who must give you up to 2 cards:</strong></p>
          <ul style="margin: 6px 0 0 16px;">
            ${targets.map(p => `<li><strong>${escapeHtml(p.name)}</strong> (${p.victoryPoints} VP, ${this.countPlayerTotalCards(p)} cards)</li>`).join('')}
          </ul>
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
        return v?.building && !v.building.hasWall;
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
      const promotable = (me?.knightsPlaced || []).filter(k => k.rank !== 'mighty');
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
        <div>${i18n.t('PROGRESS_SELECT_STEAL')}</div>
        <select id="mm-steal-1">${this.handTypeOptions()}</select>
        <select id="mm-steal-2">${this.handTypeOptions()}</select>`;
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

    const hints = {
      bishop: 'PROGRESS_SELECT_HEX',
      merchant: 'PROGRESS_SELECT_HEX',
      inventor: 'PROGRESS_SELECT_HEX',
      smith: 'PROGRESS_SELECT_KNIGHTS',
      deserter: 'PROGRESS_SELECT_KNIGHT',
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
    return ['wood','brick','wool','wheat','ore','cloth','coin','paper']
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
    } else if (type === 'deserter') {
      const ids = new Set();
      vertices.forEach(v => {
        if (v.knight && v.knight.playerId !== this.myPlayerId) ids.add(v.id);
      });
      this.selectedAction = { type: 'progress_vertex', validIds: ids };
    } else if (type === 'engineer') {
      const ids = new Set();
      (me.citiesBuilt || []).forEach(vid => {
        const v = this.gameState.grid.vertices[vid];
        if (v?.building && !v.building.hasWall) ids.add(vid);
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
    if (type === 'deserter') {
      if (!this.progressPlay.options.vertexId) {
        this.progressPlay.options.vertexId = vertexId;
        const me = this.gameState.players.find(p => p.id === this.myPlayerId);
        const ids = new Set();
        Object.values(this.gameState.grid.vertices).forEach(v => {
          if (v.building) return;
          if (v.knight && v.id !== vertexId) return;
          const hasRoad = (v.adjacentEdges || []).some(eid => this.gameState.grid.edges[eid]?.road?.playerId === me.id);
          if (!hasRoad) return;
          const blocked = (v.adjacentVertices || []).some(adj => {
            const n = this.gameState.grid.vertices[adj];
            return n && (n.building || (n.knight && n.id !== vertexId));
          });
          if (!blocked) ids.add(v.id);
        });
        this.selectedAction = { type: 'progress_vertex', validIds: ids };
        this.boardRenderer.render(this.gameState.grid, this.selectedAction);
        const hint = document.getElementById('progress-card-target-ui');
        if (hint) hint.innerHTML = `<p>${i18n.t('PROGRESS_SELECT_KNIGHT_PLACE')}</p>`;
        const bannerText = document.getElementById('board-pick-banner-text');
        if (bannerText) bannerText.textContent = `🎯 ${i18n.t('PROGRESS_SELECT_KNIGHT_PLACE')}`;
        return;
      }
      if (banner) banner.classList.add('is-hidden');
      this.progressPlay.options.placeVertexId = vertexId;
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
    const options = { ...play.options };
    if (play.card.type === 'alchemist') {
      options.d1 = parseInt(document.getElementById('alchemist-d1')?.value, 10);
      options.d2 = parseInt(document.getElementById('alchemist-d2')?.value, 10);
    }
    if (play.card.type === 'master_merchant') {
      options.steal = [
        document.getElementById('mm-steal-1')?.value,
        document.getElementById('mm-steal-2')?.value
      ];
    }
    const el = document.querySelector(`.progress-card[data-card-id="${play.card.id}"]`);
    el?.classList.add('playing');
    try {
      await network.sendAction('play_progress_card', { cardId: play.card.id, options });
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

  /* =========================================================
   * NETWORK SYNC
   * ========================================================= */
  bindNetworkEvents() {
    network.onLobbyUpdate = (lobbyData) => {
      this.myPlayerId = network.currentPlayerId || this.myPlayerId;
      this.renderWaitingRoom(lobbyData);
    };

    network.onGameStarted = () => {
      this.showView('view-game');
      audio.playTurnAlert();
    };

    network.onTimerTick = (data) => {
      const s = this.gameState;
      const isMyTurn = s && s.players && s.players[s.currentTurnPlayerIndex]?.id === this.myPlayerId;
      if (s && s.phase === 'TURN_DISCARD' && s.discardDeadline) {
        this.turnTimerUI.syncDiscard({ discardDeadline: s.discardDeadline, isMyTurn });
      } else {
        this.turnTimerUI.update({
          remaining: data.remaining,
          duration: data.duration,
          isMyTurn
        });
      }
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

    this.boardRenderer.currentPlayerId = this.myPlayerId;
    this.boardRenderer.gameStatePlayers = s.players;
    this.boardRenderer.longestRoadHolder = s.longestRoadHolder;

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
          (me.citiesBuilt || []).filter(id => s.grid?.vertices?.[id]?.building?.type === 'city')
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
    } else if (s.phase === 'TURN_ROBBER' && s.players[s.currentTurnPlayerIndex].id === this.myPlayerId) {
      // Robber target highlight
      this.boardRenderer.render(s.grid, { type: 'robber' });
    } else {
      const rollSum = (s.dice && s.dice.length === 2 && s.hasRolledDice) ? s.dice[0] + s.dice[1] : null;
      this.boardRenderer.render(s.grid, this.selectedAction, rollSum, s.players);
    }

    // Check discard modal
    this.checkDiscardState();

    // Update Turn Banner & Buttons
    const curPlayer = s.players[s.currentTurnPlayerIndex];
    const isMyTurn = curPlayer.id === this.myPlayerId;

    document.getElementById('turn-commander-name').textContent = curPlayer.name;
    document.getElementById('turn-commander-name').style.color = curPlayer.color;
    document.getElementById('round-number-display').textContent = s.turnNumber;

    // Synchronize Turn Timer immediately (zero-flicker on state refresh / reconnect)
    if (s.phase === 'TURN_DISCARD' && s.discardDeadline) {
      this.turnTimerUI.syncDiscard({ discardDeadline: s.discardDeadline, isMyTurn });
    } else if (this.currentRoom) {
      this.turnTimerUI.update({
        remaining: this.currentRoom.turnTimeRemaining,
        duration: this.currentRoom.turnDuration,
        isMyTurn
      });
    }

    const statusEl = document.getElementById('turn-phase-status');
    if (statusEl) {
      let statusKey = mapPhaseToStatusKey(s.phase, isMyTurn);
      if (this.isCitiesKnights() && s.phase === 'SETUP_ROUND_2') {
        statusKey = isMyTurn ? 'STATUS_YOUR_SETUP_CK' : 'STATUS_WAIT_SETUP_CK';
      }
      statusEl.textContent = i18n.t(statusKey, { name: curPlayer.name });
    }

    const me = s.players.find(p => p.id === this.myPlayerId);
    const isActionPhase = s.phase === 'TURN_ACTION' && isMyTurn;
    const isRollPhase = s.phase === 'TURN_ROLL' && isMyTurn;
    const notTurnReason = !isMyTurn ? 'REASON_NOT_YOUR_TURN' : 'REASON_WRONG_PHASE';

    this.setActionEnabled(document.getElementById('btn-roll-dice'), isRollPhase, isMyTurn && !isRollPhase ? 'REASON_ALREADY_ROLLED' : notTurnReason);
    this.setActionEnabled(document.getElementById('btn-end-turn'), isActionPhase, notTurnReason);
    this.setActionEnabled(document.getElementById('btn-open-trade'), isActionPhase, notTurnReason);
    const unplayedDev = (me?.devCards || []).filter(c => !c.played);
    this.setActionEnabled(
      document.getElementById('btn-open-dev-cards'),
      isActionPhase && unplayedDev.length > 0,
      !isActionPhase ? notTurnReason : 'REASON_WRONG_PHASE'
    );

    this.setBuildEnabled('btn-build-road', isActionPhase, me, BUILD_COSTS.ROAD, notTurnReason);
    this.setBuildEnabled('btn-build-settlement', isActionPhase, me, BUILD_COSTS.SETTLEMENT, notTurnReason);
    this.setBuildEnabled('btn-build-city', isActionPhase, me, BUILD_COSTS.CITY, notTurnReason);
    this.setBuildEnabled('btn-buy-dev-card', isActionPhase && !this.isCitiesKnights(), me, BUILD_COSTS.DEV_CARD, notTurnReason);
    this.renderWallSupplyAndButton(s, me, isActionPhase, notTurnReason);

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

    this.renderCkHud(s, me, isActionPhase);
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

      card.innerHTML = `
        <div class="opponent-identity">
          <span class="opponent-swatch" style="background: ${p.color};"></span>
          <span class="opponent-name">${escapeHtml(p.name)}${you}</span>
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
    } else if (s.phase === 'TURN_ROLL') {
      isActionable = isMyTurn;
      hintText = i18n.t(mapPhaseToStatusKey(s.phase, isMyTurn), { name: curPlayer?.name || '' });
    } else if (s.phase === 'TURN_DISCARD') {
      hintText = i18n.t(mapPhaseToStatusKey(s.phase, isMyTurn), { name: curPlayer?.name || '' });
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
        } else if (entry.type === 'WEDDING_GIFT' && me && entry.args) {
          if (entry.args.targetName === me.name) {
            this.showToast(i18n.t('WEDDING_GIFT_GIVEN', { player: entry.args.playerName, count: entry.args.count }) || `💍 You gave ${entry.args.count} card(s) to ${entry.args.playerName} for the wedding.`, true);
          } else if (entry.args.playerName === me.name) {
            this.showToast(i18n.t('WEDDING_GIFT_RECEIVED', { target: entry.args.targetName, count: entry.args.count }) || `💍 You received ${entry.args.count} wedding card(s) from ${entry.args.targetName}!`);
          }
        } else if (entry.type === 'COMMERCIAL_HARBOR_TRADE' && me && entry.args && entry.args.playerName === me.name) {
          this.showToast(`⚖️ Commercial Harbor: traded ${entry.args.resource} for ${entry.args.count} commodities!`);
        }
      });
      this.lastProcessedLogCount = logs.length;
    }

    logs.slice().reverse().forEach(entry => {
      const el = document.createElement('div');
      el.className = 'log-entry';
      const argsCopy = entry.args ? { ...entry.args } : {};
      const localizeResToken = (val) => {
        if (typeof val !== 'string') return val;
        return i18n.t(`RES_${val.toUpperCase()}`);
      };
      if (typeof argsCopy.resource === 'string') {
        argsCopy.resource = localizeResToken(argsCopy.resource);
      }
      if (typeof argsCopy.give === 'string') {
        argsCopy.give = localizeResToken(argsCopy.give);
      } else if (argsCopy.give && typeof argsCopy.give === 'object') {
        argsCopy.give = Object.entries(argsCopy.give)
          .filter(([, count]) => count > 0)
          .map(([res, count]) => `${count} ${this.cardLabel(res)}`)
          .join(', ');
      }
      if (typeof argsCopy.receive === 'string') {
        argsCopy.receive = localizeResToken(argsCopy.receive);
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
      <span style="color: ${msg.color || '#f59e0b'}; font-weight: 700;">${escapeHtml(msg.senderName)}:</span>
      <span style="color: var(--text-primary);">${escapeHtml(msg.text)}</span>
    `;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  renderActiveTradeBanner(activeTrade) {
    const banner = document.getElementById('active-trade-banner');
    if (!banner) return;
    if (!activeTrade) {
      banner.classList.remove('is-visible');
      banner.innerHTML = '';
      this.lastTradeKey = null;
      return;
    }

    const isMine = activeTrade.fromPlayerId === this.myPlayerId;
    banner.classList.add('is-visible');

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
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('DOMContentLoaded', () => {
    new CatanApp();
  });
}
