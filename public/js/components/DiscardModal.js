/**
 * DiscardModal.js
 * Decoupled ES module UI component managing the 7-rolled discard modal
 * and the Robber victim target selection modal.
 */

import { i18n } from '../i18n.js';
import { audio } from '../audio.js';
import { network } from '../network.js';
import { escapeHtml } from './LobbyView.js';

export class DiscardModal {
  constructor(options = {}) {
    this.modal = options.modal || (typeof document !== 'undefined' ? document.getElementById('discard-modal') : null);
    this.network = options.network || network;
    this.audio = options.audio || audio;
    this.showToast = options.showToast || ((msg, isErr) => {});
    this.getMyPlayerId = options.getMyPlayerId || (() => this.network?.currentPlayerId || null);
    this.getGameState = options.getGameState || (() => null);
    this.getHandCardTypes = options.getHandCardTypes || (() => ['wood', 'brick', 'wool', 'wheat', 'ore']);
    this.cardLabel = options.cardLabel || ((type) => type);
    this.clearActiveAction = options.clearActiveAction || (() => {});

    this.discardTimerInterval = null;
  }

  get myPlayerId() {
    return this.getMyPlayerId();
  }

  get gameState() {
    return this.getGameState();
  }

  setupDiscardModal() {
    const modal = this.modal || document.getElementById('discard-modal');
    const form = document.getElementById('discard-form');
    if (!modal || !form) return;

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
        document.getElementById('robber-target-modal')?.classList.remove('active');
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
      if (!me) return;

      const discarded = {};
      for (const type of this.getHandCardTypes()) {
        discarded[type] = parseInt(document.getElementById(`discard-${type}`)?.value, 10) || 0;
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
        await this.network.sendAction('discard_cards', { cards: discarded });
        modal.classList.remove('active');
      } catch (err) {
        this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
        const submitBtn = document.getElementById('btn-submit-discard');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  checkDiscardState() {
    const modal = this.modal || document.getElementById('discard-modal');
    if (!modal || !this.gameState) return;

    const me = this.gameState.players.find(p => p.id === this.myPlayerId);
    const pending = this.gameState.pendingDiscards || [];
    const mustDiscard = this.gameState.phase === 'TURN_DISCARD' && pending.includes(this.myPlayerId);

    if (mustDiscard && me) {
      const getResourceCount = (r) => (me.resources && me.resources[r]) || 0;
      const getCommodityCount = (c) => (me.commodities && me.commodities[c]) || 0;
      const totalCards = ['wood', 'brick', 'wool', 'wheat', 'ore'].reduce((sum, r) => sum + getResourceCount(r), 0)
        + ['cloth', 'coin', 'paper'].reduce((sum, c) => sum + getCommodityCount(c), 0);
      const needed = Math.floor(totalCards / 2);

      const neededEl = document.getElementById('discard-needed-count');
      if (neededEl) neededEl.textContent = needed;

      const isAlreadyActive = modal.classList.contains('active');
      const handTypes = this.getHandCardTypes();

      handTypes.forEach(res => {
        const isComm = res === 'cloth' || res === 'coin' || res === 'paper';
        const count = isComm ? getCommodityCount(res) : getResourceCount(res);
        const row = document.getElementById(`row-discard-${res}`);
        if (row) {
          row.classList.toggle('is-hidden', count === 0 && !isComm);
        }
        const inp = document.getElementById(`discard-${res}`);
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
      ? this.network.sendAction('chase_robber', { vertexId: chaseFrom, hexId, victimPlayerId: targetPlayerId })
      : this.network.sendAction('move_robber', { hexId, victimPlayerId: targetPlayerId });
    const modal = document.getElementById('robber-target-modal');
    const container = document.getElementById('robber-targets-list');
    if (!modal || !container) return;
    container.innerHTML = '';

    const getCardCount = (p) => {
      if (!p || !p.resources) return 0;
      if (typeof p.resources.total === 'number') return p.resources.total;
      return Object.values(p.resources).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
    };

    const adjacentOpponentIds = new Set();
    for (const vKey of Object.keys(this.gameState?.grid?.vertices || {})) {
      const v = this.gameState.grid.vertices[vKey];
      if (v.hexes?.includes(hexId) && v.building && v.building.playerId !== this.myPlayerId) {
        adjacentOpponentIds.add(v.building.playerId);
      }
    }

    if (adjacentOpponentIds.size === 0) {
      sendMove(null);
      this.showToast(i18n.t('ROBBER_MOVED_NO_TARGETS') || 'Robber moved. No adjacent opponents to rob.');
      this.audio.playRobber();
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
      this.audio.playRobber();
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
          this.audio.playRobber();
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
}
