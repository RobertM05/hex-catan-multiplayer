/**
 * DevCardsModal.js
 * Decoupled ES module UI component managing Development Cards modal,
 * Monopoly modal, and Year of Plenty resource choice dialogs.
 */

import { i18n } from '../i18n.js';
import { audio } from '../audio.js';
import { network } from '../network.js';

export class DevCardsModal {
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.getElementById('dev-cards-modal') : null);
    this.network = options.network || network;
    this.audio = options.audio || audio;
    this.showToast = options.showToast || ((msg, isErr) => {});
    this.getGameState = options.getGameState || (() => null);
    this.getMyPlayerId = options.getMyPlayerId || (() => this.network?.currentPlayerId || null);
    this.activateBuildRoad = options.activateBuildRoad || (() => {});
  }

  get myPlayerId() {
    return this.getMyPlayerId();
  }

  get gameState() {
    return this.getGameState();
  }

  setupDevCardsModal() {
    const modal = this.container || document.getElementById('dev-cards-modal');
    const openBtn = document.getElementById('btn-open-dev-cards');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        this.renderDevCardsList();
        modal?.classList.add('active');
      });
    }

    const closeBtn = document.getElementById('btn-close-dev-cards');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal?.classList.remove('active');
      });
    }

    const closeX = document.getElementById('btn-close-dev-cards-x');
    if (closeX) {
      closeX.addEventListener('click', () => modal?.classList.remove('active'));
    }

    const closeMonopoly = document.getElementById('btn-close-monopoly');
    if (closeMonopoly) {
      closeMonopoly.addEventListener('click', () => {
        document.getElementById('monopoly-modal')?.classList.remove('active');
      });
    }

    const closeYop = document.getElementById('btn-close-yop');
    if (closeYop) {
      closeYop.addEventListener('click', () => {
        document.getElementById('year-of-plenty-modal')?.classList.remove('active');
      });
    }
  }

  renderDevCardsList() {
    const container = document.getElementById('dev-cards-list');
    if (!container) return;
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
          document.getElementById('dev-cards-modal')?.classList.remove('active');

          if (card.type === 'monopoly') {
            const monopolyModal = document.getElementById('monopoly-modal');
            monopolyModal?.classList.add('active');
            const btns = monopolyModal?.querySelectorAll('.res-choice-btn') || [];
            btns.forEach(b => {
              b.onclick = async () => {
                const res = b.dataset.res;
                try {
                  await this.network.sendAction('play_dev_card', { cardId: card.id, options: { resource: res } });
                  this.audio.playBuild();
                  monopolyModal?.classList.remove('active');
                } catch (err) {
                  this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
                }
              };
            });
          } else if (card.type === 'year_of_plenty') {
            const yopModal = document.getElementById('year-of-plenty-modal');
            yopModal?.classList.add('active');
            const confirmBtn = document.getElementById('btn-confirm-yop');
            if (confirmBtn) {
              confirmBtn.onclick = async () => {
                const res1 = document.getElementById('yop-res-1')?.value;
                const res2 = document.getElementById('yop-res-2')?.value;
                try {
                  await this.network.sendAction('play_dev_card', { cardId: card.id, options: { res1, res2 } });
                  this.audio.playBuild();
                  yopModal?.classList.remove('active');
                } catch (err) {
                  this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
                }
              };
            }
          } else if (card.type === 'knight') {
            try {
              await this.network.sendAction('play_dev_card', { cardId: card.id });
              this.audio.playBuild();
              this.showToast(i18n.t('KNIGHT_PLAYED_TOAST'));
            } catch (err) {
              this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
            }
          } else if (card.type === 'road_building') {
            try {
              await this.network.sendAction('play_dev_card', { cardId: card.id });
              this.audio.playBuild();
              this.activateBuildRoad();
              this.showToast(i18n.t('ROAD_BUILDING_PLAYED_TOAST'));
            } catch (err) {
              this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
            }
          } else {
            try {
              await this.network.sendAction('play_dev_card', { cardId: card.id });
              this.audio.playBuild();
            } catch (err) {
              this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
            }
          }
        });
      }

      container.appendChild(cardEl);
    });
  }
}
