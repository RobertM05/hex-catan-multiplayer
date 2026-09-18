/**
 * CitiesKnightsView.js
 * Decoupled ES module UI component managing Cities & Knights HUD elements,
 * event die, barbarian track, knights action menu & overview,
 * city improvements panel, city walls, and barbarian attack/reward modal.
 */

import { i18n } from '../i18n.js';
import { audio } from '../audio.js';
import { network } from '../network.js';
import { ico } from '../icons.js';
import { canBuildWall } from '../turnStatus.js';
import { escapeHtml } from './LobbyView.js';

export class CitiesKnightsView {
  constructor(options = {}) {
    this.network = options.network || network;
    this.audio = options.audio || audio;
    this.showToast = options.showToast || ((msg, isErr) => {});
    this.getMyPlayerId = options.getMyPlayerId || (() => this.network?.currentPlayerId || null);
    this.getGameState = options.getGameState || (() => null);
    this.isCitiesKnights = options.isCitiesKnights || (() => false);
    this.cardLabel = options.cardLabel || ((type) => type);
    this.getCardCount = options.getCardCount || ((me, type) => 0);
    this.clearActiveAction = options.clearActiveAction || (() => {});
    this.setActionEnabled = options.setActionEnabled || (() => {});
    this.notifyProgressDraws = options.notifyProgressDraws || (() => {});
    this.checkProgressDiscardState = options.checkProgressDiscardState || (() => {});
    this.renderProgressCardHand = options.renderProgressCardHand || (() => {});
    this.collectKnightMoveTargets = options.collectKnightMoveTargets || (() => []);
    this.getBoardRenderer = options.getBoardRenderer || (() => null);
    this.updateBoardHint = options.updateBoardHint || (() => {});

    this.lastEventDie = null;
    this.aqueductClaimInFlight = false;
    this.dismissedBarbarianInvasionId = null;
    this.barbarianCloseBound = false;
  }

  get myPlayerId() {
    return this.getMyPlayerId();
  }

  get gameState() {
    return this.getGameState();
  }

  get boardRenderer() {
    return this.getBoardRenderer();
  }

  setupCkUi() {
    const panel = document.getElementById('city-improvements-panel');
    panel?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-improve-track]');
      if (!btn || btn.disabled) return;
      try {
        await this.network.sendAction('improve_city', { track: btn.getAttribute('data-improve-track') });
        this.audio.playBuild();
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

    const aqueductModal = document.getElementById('aqueduct-modal');
    aqueductModal?.querySelectorAll('.res-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => this.claimAqueductChoice(btn.dataset.res));
    });
  }

  closeKnightActionMenu() {
    const menu = document.getElementById('knight-action-menu');
    if (menu) menu.hidden = true;
  }

  openKnightActionMenu(vertexId, knight, evt, callbacks = {}) {
    const me = this.gameState?.players?.find(p => p.id === this.myPlayerId);
    if (!me || knight.playerId !== this.myPlayerId) return;
    const isMyTurn = this.gameState?.players?.[this.gameState.currentTurnPlayerIndex]?.id === this.myPlayerId;
    if (!isMyTurn || (this.gameState.phase !== 'TURN_ACTION' && this.gameState.phase !== 'TURN_SPECIAL_BUILDING')) return;

    const wheat = me.resources?.wheat || 0;
    const wool = me.resources?.wool || 0;
    const ore = me.resources?.ore || 0;
    const politics = me.cityImprovements?.politics || 0;
    const nextRank = knight.rank === 'basic' ? 'strong' : knight.rank === 'strong' ? 'mighty' : null;
    const politicsNeeded = nextRank === 'mighty' ? 3 : 0;
    const vertex = this.gameState?.grid?.vertices?.[vertexId];
    const actedThisTurn = knight.lastActionTurn === this.gameState.turnNumber;
    const robberInPlay = !!this.gameState.barbariansHaveAttacked;
    const canChase = robberInPlay && knight.active && vertex?.hexes?.includes(this.gameState.grid.robberHexId);

    const actions = [];
    if (!knight.active) {
      actions.push({
        label: i18n.t('KNIGHT_ACTIVATE'),
        disabled: wheat < 1 || actedThisTurn,
        run: async () => {
          await this.network.sendAction('activate_knight', { vertexId });
          this.audio.playBuild();
        }
      });
    }
    if (nextRank) {
      actions.push({
        label: i18n.t('KNIGHT_PROMOTE'),
        disabled: wool < 1 || ore < 1 || politics < politicsNeeded || (me.knightsAvailable?.[nextRank] || 0) <= 0,
        run: async () => {
          await this.network.sendAction('promote_knight', { vertexId });
          this.audio.playBuild();
        }
      });
    }
    if (knight.active && this.gameState.phase === 'TURN_ACTION') {
      actions.push({
        label: i18n.t('KNIGHT_MOVE'),
        disabled: actedThisTurn,
        run: () => callbacks.activateMoveKnight ? callbacks.activateMoveKnight(vertexId, knight) : null
      });
      if (robberInPlay) {
        actions.push({
          label: i18n.t('KNIGHT_CHASE_ROBBER'),
          disabled: !canChase || actedThisTurn,
          run: () => callbacks.activateChaseRobber ? callbacks.activateChaseRobber(vertexId) : null
        });
      }
    }

    const menu = document.getElementById('knight-action-menu');
    if (!menu) return;
    menu.innerHTML = actions.map((a, i) =>
      `<button type="button" class="btn-glass knight-action-btn" data-i="${i}" ${a.disabled ? 'disabled' : ''}>${a.label}</button>`
    ).join('');
    menu.hidden = false;
    const viewport = document.querySelector('.board-viewport');
    const rect = viewport ? viewport.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
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
    const dest = this.gameState?.grid?.vertices?.[toVertexId];
    if (dest?.knight && dest.knight.playerId !== this.myPlayerId) {
      const ok = typeof window !== 'undefined' && window.confirm ? window.confirm(i18n.t('KNIGHT_DISPLACE_CONFIRM')) : true;
      if (!ok) return;
    }
    try {
      const res = await this.network.sendAction('move_knight', { fromVertexId, toVertexId });
      this.audio.playBuild();
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

  async claimAqueductChoice(resource) {
    if (!resource || this.aqueductClaimInFlight) return;
    this.aqueductClaimInFlight = true;
    try {
      await this.network.sendAction('claim_aqueduct_resource', { resource });
      this.audio.playBuild();
      document.getElementById('aqueduct-modal')?.classList.remove('active');
    } catch (err) {
      this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
    } finally {
      this.aqueductClaimInFlight = false;
    }
  }

  checkAqueductChooser() {
    const modal = document.getElementById('aqueduct-modal');
    if (!modal || !this.gameState) return;
    const pending = this.gameState.pendingAqueductClaims || [];
    const needsChoice = this.isCitiesKnights() && pending.includes(this.myPlayerId);
    if (!needsChoice) {
      modal.classList.remove('active');
      return;
    }
    modal.classList.add('active');
  }

  renderCkHud(s, me, isActionPhase, notTurnReason) {
    document.body.classList.toggle('mode-cities-knights', this.isCitiesKnights());
    this.renderEventDie(s);
    this.renderBarbarianTrack(s);
    this.renderImprovementPanel(me, isActionPhase);
    this.renderBarbarianOverlay(s, me);
    this.renderWallSupplyAndButton(s, me, isActionPhase, notTurnReason);
    this.renderProgressCardHand();
    this.notifyProgressDraws(s);
    this.checkProgressDiscardState();
    this.checkAqueductChooser();
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

    let html = '';
    for (const [res, count] of Object.entries(bank.resources || {})) {
      html += `<div class="bank-pill bank-res-${res}" title="${i18n.t(`RES_${res.toUpperCase()}`)}: ${count} in bank">
        <span class="bank-pill-icon">${ico(res)}</span>
        <span class="bank-pill-label">${this.cardLabel(res)}</span>
        <span class="bank-pill-count">${count}</span>
      </div>`;
    }

    if (isCk && bank.commodities) {
      for (const [com, count] of Object.entries(bank.commodities)) {
        html += `<div class="bank-pill bank-com-${com}" title="${i18n.t(`COMM_${com.toUpperCase()}`)}: ${count} in bank">
          <span class="bank-pill-icon">${ico(com)}</span>
          <span class="bank-pill-label">${this.cardLabel(com)}</span>
          <span class="bank-pill-count">${count}</span>
        </div>`;
      }
    }

    if (isCk && bank.decks) {
      if (bank.decks.trade !== undefined) {
        html += `<div class="bank-pill bank-deck-trade" title="Trade Progress Deck: ${bank.decks.trade} cards remaining">
          <span class="bank-pill-icon">${ico('bookOpen')}</span>
          <span class="bank-pill-label">Trade</span>
          <span class="bank-pill-count">${bank.decks.trade}</span>
        </div>`;
      }
      if (bank.decks.politics !== undefined) {
        html += `<div class="bank-pill bank-deck-politics" title="Politics Progress Deck: ${bank.decks.politics} cards remaining">
          <span class="bank-pill-icon">${ico('city')}</span>
          <span class="bank-pill-label">Politics</span>
          <span class="bank-pill-count">${bank.decks.politics}</span>
        </div>`;
      }
      if (bank.decks.science !== undefined) {
        html += `<div class="bank-pill bank-deck-science" title="Science Progress Deck: ${bank.decks.science} cards remaining">
          <span class="bank-pill-icon">${ico('refresh')}</span>
          <span class="bank-pill-label">Science</span>
          <span class="bank-pill-count">${bank.decks.science}</span>
        </div>`;
      }
    } else if (bank.decks?.devCards !== undefined) {
      html += `<div class="bank-pill bank-deck-dev" title="Development Deck: ${bank.decks.devCards} cards remaining">
        <span class="bank-pill-icon">${ico('cards')}</span>
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
    const perkKeys = {
      trade: 'TRACK_PERK_TRADE',
      politics: 'TRACK_PERK_POLITICS',
      science: 'TRACK_PERK_SCIENCE'
    };
    const hasCities = (me.citiesBuilt || []).length > 0;
    for (const [track, commodity] of Object.entries(tracks)) {
      const level = me.cityImprovements?.[track] || 0;
      const cost = Math.min(level + 1, 5);
      const have = this.getCardCount(me, commodity);
      const canAfford = hasCities && isActionPhase && level < 5 && have >= cost;
      const perkUnlocked = level >= 3;
      const levelEl = document.getElementById(`improve-level-${track}`);
      const fillEl = document.getElementById(`improve-fill-${track}`);
      const costEl = document.getElementById(`improve-cost-${track}`);
      const perkEl = document.getElementById(`improve-perk-${track}`);
      const btn = document.getElementById(`btn-improve-${track}`);
      const row = document.querySelector(`.improvement-track[data-track="${track}"]`);
      if (levelEl) levelEl.textContent = `${level}/5`;
      if (fillEl) fillEl.style.width = `${(level / 5) * 100}%`;
      if (costEl) costEl.textContent = level >= 5 ? '—' : String(cost);
      if (perkEl) perkEl.textContent = i18n.t(perkKeys[track]);
      if (btn) btn.disabled = !canAfford;
      row?.classList.toggle('track-ready', canAfford);
      row?.classList.toggle('track-metro', level >= 4);
      row?.classList.toggle('track-perk-on', perkUnlocked);
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
        if (vertex?.building?.hasWall) {
          btn.title = i18n.t('BARBARIAN_WALL_NOTE');
          btn.textContent += ' 🛡️';
        }
        btn.addEventListener('click', async () => {
          try {
            await this.network.sendAction('downgrade_city', { vertexId: vid });
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
            await this.network.sendAction('choose_barbarian_reward', { deck: deck.id });
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
}
