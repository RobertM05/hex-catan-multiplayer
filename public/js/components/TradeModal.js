/**
 * TradeModal.js
 * Decoupled ES module UI component managing domestic trade proposals,
 * bank trade card selection, active trade response banners,
 * and Merchant Fleet resource choice dialogs.
 * Eliminates innerHTML string interpolation risks structurally with safe DOM construction.
 */

import { i18n } from '../i18n.js';
import { audio } from '../audio.js';
import { network } from '../network.js';
import { ico } from '../icons.js';

export class TradeModal {
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.getElementById('trade-modal') : null);
    this.banner = options.banner || (typeof document !== 'undefined' ? document.getElementById('active-trade-banner') : null);
    this.network = options.network || network;
    this.audio = options.audio || audio;
    this.showToast = options.showToast || ((msg, isErr) => console.log(msg));
    this.getGameState = options.getGameState || (() => null);
    this.getMyPlayerId = options.getMyPlayerId || (() => this.network?.currentPlayerId || null);
    this.getHandCardTypes = options.getHandCardTypes || (() => ['wood', 'brick', 'wool', 'wheat', 'ore']);
    this.getCardCount = options.getCardCount || ((me, type) => {
      if (!me) return 0;
      if (type === 'cloth' || type === 'coin' || type === 'paper') return (me.commodities && me.commodities[type]) || 0;
      return (me.resources && me.resources[type]) || 0;
    });
    this.cardLabel = options.cardLabel || ((type) => {
      if (type === 'cloth' || type === 'coin' || type === 'paper') return i18n.t(`COMM_${type.toUpperCase()}`);
      return i18n.t(`RES_${type.toUpperCase()}`);
    });
    this.isCommodity = options.isCommodity || ((type) => type === 'cloth' || type === 'coin' || type === 'paper');

    this.bankTrade = { give: null, receive: null };
    this.lastTradeKey = null;
  }

  get myPlayerId() {
    return this.getMyPlayerId();
  }

  get gameState() {
    return this.getGameState();
  }

  setupTradeModals() {
    const tradeModal = this.container || document.getElementById('trade-modal');
    const tabPlayer = document.getElementById('tab-trade-player');
    const tabBank = document.getElementById('tab-trade-bank');
    const sectionPlayer = document.getElementById('trade-player-section');
    const sectionBank = document.getElementById('trade-bank-section');

    this.bankTrade = { give: null, receive: null };

    const openBtn = document.getElementById('btn-open-trade');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        this.open();
      });
    }

    document.querySelectorAll('.btn-close-trade-modal, #btn-close-trade').forEach(btn => {
      btn.addEventListener('click', () => {
        this.hide();
      });
    });

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

    document.querySelectorAll('.btn-stepper').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const input = document.getElementById(targetId);
        const valSpan = document.getElementById(`val-${targetId}`);
        if (!input || !valSpan) return;

        let curVal = parseInt(input.value, 10) || 0;
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

    const formPropose = document.getElementById('form-propose-trade');
    if (formPropose) {
      formPropose.addEventListener('submit', async (e) => {
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
          await this.network.sendAction('propose_trade', { give, want });
          this.audio.playTrade();
          this.hide();
        } catch (err) {
          this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
        }
      });
    }

    const formBank = document.getElementById('form-bank-trade');
    if (formBank) {
      formBank.addEventListener('submit', async (e) => {
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
          await this.network.sendAction('bank_trade', { give, receive, ratio });
          this.audio.playTrade();
          this.hide();
          const giveName = this.cardLabel(give);
          const recName = this.cardLabel(receive);
          this.showToast(i18n.t('BANK_TRADE_SUCCESS', { ratio, give: giveName, receive: recName }), false);
        } catch (err) {
          this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
        }
      });
    }
  }

  open() {
    this.resetTradeSteppers();
    this.renderBankTradeUI();

    const isMyTurn = this.gameState && this.gameState.currentPlayerId === this.myPlayerId;
    const isActionPhase = this.gameState && this.gameState.phase === 'TURN_ACTION';
    const canTrade = isMyTurn && isActionPhase;

    const proposeBtn = document.getElementById('btn-submit-propose-trade');
    if (proposeBtn) {
      proposeBtn.disabled = !canTrade;
      proposeBtn.textContent = canTrade ? i18n.t('PROPOSE_TRADE_BTN') : i18n.t('TRADE_ONLY_ON_YOUR_TURN');
    }

    const tabPlayer = document.getElementById('tab-trade-player');
    const tabBank = document.getElementById('tab-trade-bank');
    const sectionPlayer = document.getElementById('trade-player-section');
    const sectionBank = document.getElementById('trade-bank-section');

    if (tabPlayer && tabBank && sectionPlayer && sectionBank) {
      tabPlayer.classList.add('active');
      tabBank.classList.remove('active');
      sectionPlayer.classList.remove('is-hidden');
      sectionBank.classList.add('is-hidden');
    }

    const tradeModal = this.container || document.getElementById('trade-modal');
    if (tradeModal) tradeModal.classList.add('active');
  }

  hide() {
    const tradeModal = this.container || document.getElementById('trade-modal');
    if (tradeModal) tradeModal.classList.remove('active');
  }

  close() {
    this.hide();
  }

  showProposal(give = {}, want = {}) {
    this.open();
    this.getHandCardTypes().forEach(res => {
      const gVal = give[res] || 0;
      const wVal = want[res] || 0;

      const giveInput = document.getElementById(`trade-give-${res}`);
      const giveVal = document.getElementById(`val-trade-give-${res}`);
      if (giveInput) giveInput.value = String(gVal);
      if (giveVal) giveVal.textContent = String(gVal);

      const wantInput = document.getElementById(`trade-want-${res}`);
      const wantVal = document.getElementById(`val-trade-want-${res}`);
      if (wantInput) wantInput.value = String(wVal);
      if (wantVal) wantVal.textContent = String(wVal);
    });
  }

  resetTradeSteppers() {
    const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
    this.getHandCardTypes().forEach(res => {
      const giveInput = document.getElementById(`trade-give-${res}`);
      const giveVal = document.getElementById(`val-trade-give-${res}`);
      const availSpan = document.getElementById(`trade-avail-${res}`);
      if (giveInput) giveInput.value = '0';
      if (giveVal) giveVal.textContent = '0';
      if (availSpan) {
        availSpan.textContent = `(${this.getCardCount(me, res)})`;
      }

      const wantInput = document.getElementById(`trade-want-${res}`);
      const wantVal = document.getElementById(`val-trade-want-${res}`);
      if (wantInput) wantInput.value = '0';
      if (wantVal) wantVal.textContent = '0';
    });
  }

  getBestBankRatio(resource) {
    if (!this.gameState || !this.gameState.grid) return 4;
    let me = this.gameState.players.find(p => p.id === this.myPlayerId);
    if (!me || (me.resources && typeof me.resources.wood !== 'number')) {
      const candidate = this.gameState.players.find(p => p.resources && typeof p.resources.wood === 'number');
      if (candidate) me = candidate;
    }
    if (!me) return 4;

    if (me.merchantFleetResource && me.merchantFleetResource === resource) return 2;
    if ((me.cityImprovements?.trade || 0) >= 3 && this.isCommodity(resource)) return 2;
    if (this.gameState.merchantHolder === this.myPlayerId && this.gameState.merchantHexId) {
      const hex = this.gameState.grid.hexes?.[this.gameState.merchantHexId];
      if (hex && hex.resource === resource) return 2;
    }

    let bestRatio = 4;
    const ownedVertices = (me.settlementsBuilt || []).concat(me.citiesBuilt || []);
    for (const vId of ownedVertices) {
      const v = this.gameState.grid.vertices?.[vId];
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
    let me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
    if (!me || (me.resources && typeof me.resources.wood !== 'number')) {
      const candidate = this.gameState?.players?.find(p => p.resources && typeof p.resources.wood === 'number');
      if (candidate) me = candidate;
    }

    const ownedHarbors = [];
    const ownedVertices = (me?.settlementsBuilt || []).concat(me?.citiesBuilt || []);
    for (const vId of ownedVertices) {
      const v = this.gameState?.grid?.vertices?.[vId];
      if (v && v.harbor) {
        if (v.harbor.type === 'generic') {
          const lbl = 'Port General (3:1)';
          if (!ownedHarbors.includes(lbl)) ownedHarbors.push(lbl);
        } else {
          const resName = this.cardLabel(v.harbor.type);
          const lbl = `Port ${resName} (2:1)`;
          if (!ownedHarbors.includes(lbl)) ownedHarbors.push(lbl);
        }
      }
    }
    if ((me?.cityImprovements?.trade || 0) >= 3) {
      const house = i18n.t('BANK_TRADING_HOUSE');
      if (!ownedHarbors.includes(house)) ownedHarbors.push(house);
    }
    const harborsStatusEl = document.getElementById('bank-harbors-status');
    if (harborsStatusEl) {
      harborsStatusEl.textContent = ownedHarbors.length > 0
        ? `${i18n.t('BANK_HARBORS_OWNED', { harbors: ownedHarbors.join(', ') })}`
        : i18n.t('BANK_NO_HARBORS');
    }

    if (!this.bankTrade.give) {
      const firstAffordable = resources.find(r => {
        const ratio = this.getBestBankRatio(r);
        const have = this.getCardCount(me, r);
        return have >= ratio;
      });
      this.bankTrade.give = firstAffordable || 'wood';
    }

    if (this.bankTrade.receive === this.bankTrade.give) {
      this.bankTrade.receive = null;
    }
    if (!this.bankTrade.receive) {
      const alternative = resources.find(r => r !== this.bankTrade.give);
      if (alternative) this.bankTrade.receive = alternative;
    }

    resources.forEach(res => {
      const ratio = this.getBestBankRatio(res);
      const have = this.getCardCount(me, res);
      const canAfford = have >= ratio;
      const isSelected = this.bankTrade.give === res;

      let ratioClass = '';
      let ratioTag = `${ratio}:1 Bank`;
      if (ratio === 2 && me?.merchantFleetResource === res) {
        ratioClass = 'harbor-special';
        ratioTag = i18n.t('BANK_FLEET_RATIO_TAG');
      } else if (ratio === 2 && (me?.cityImprovements?.trade || 0) >= 3 && this.isCommodity(res)) {
        ratioClass = 'harbor-special';
        ratioTag = i18n.t('BANK_TRADING_HOUSE');
      } else if (ratio === 2) {
        ratioClass = 'harbor-special';
        ratioTag = '2:1 Port';
      } else if (ratio === 3) {
        ratioClass = 'harbor-generic';
        ratioTag = '3:1 Port';
      }

      const card = document.createElement('div');
      card.className = `bank-res-card res-${res} ${isSelected ? 'selected' : ''} ${canAfford ? 'can-afford' : 'insufficient'}`;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'bank-res-icon';
      iconSpan.innerHTML = ico(res);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'bank-res-name';
      nameSpan.textContent = this.cardLabel(res);

      const haveSpan = document.createElement('span');
      haveSpan.className = 'bank-res-have';
      haveSpan.style.color = canAfford ? '#34d399' : '#f87171';
      if (canAfford) haveSpan.style.fontWeight = '700';
      haveSpan.textContent = `${i18n.t('BANK_CARDS_HAVE', { count: have })} / ${ratio}`;

      const ratioSpan = document.createElement('span');
      ratioSpan.className = `bank-res-ratio ${ratioClass}`;
      ratioSpan.textContent = ratioTag;

      card.appendChild(iconSpan);
      card.appendChild(nameSpan);
      card.appendChild(haveSpan);
      card.appendChild(ratioSpan);

      card.addEventListener('click', () => {
        this.bankTrade.give = res;
        if (this.bankTrade.receive === res) this.bankTrade.receive = null;
        this.renderBankTradeUI();
      });
      giveGrid.appendChild(card);
    });

    resources.forEach(res => {
      const isSelected = this.bankTrade.receive === res;
      const isGiveRes = this.bankTrade.give === res;

      const card = document.createElement('div');
      card.className = `bank-res-card res-${res} ${isSelected ? 'selected' : ''} ${isGiveRes ? 'disabled' : ''}`;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'bank-res-icon';
      iconSpan.innerHTML = ico(res);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'bank-res-name';
      nameSpan.textContent = this.cardLabel(res);

      const haveSpan = document.createElement('span');
      haveSpan.className = 'bank-res-have';
      haveSpan.textContent = '+1 card';

      card.appendChild(iconSpan);
      card.appendChild(nameSpan);
      card.appendChild(haveSpan);

      if (!isGiveRes) {
        card.addEventListener('click', () => {
          this.bankTrade.receive = res;
          this.renderBankTradeUI();
        });
      }
      wantGrid.appendChild(card);
    });

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
        if (ratio === 2 && me?.merchantFleetResource === this.bankTrade.give) {
          ratioDescEl.textContent = i18n.t('BANK_FLEET_APPLIED_2', { res: giveName });
        } else if (ratio === 2 && (me?.cityImprovements?.trade || 0) >= 3 && this.isCommodity(this.bankTrade.give)) {
          ratioDescEl.textContent = i18n.t('BANK_TRADING_HOUSE_APPLIED');
        } else if (ratio === 2) {
          ratioDescEl.textContent = i18n.t('BANK_PORT_APPLIED_2', { res: giveName });
        } else if (ratio === 3) {
          ratioDescEl.textContent = i18n.t('BANK_PORT_APPLIED_3');
        } else {
          ratioDescEl.textContent = i18n.t('BANK_STANDARD_RATIO');
        }
      }

      if (giveSummaryEl) {
        giveSummaryEl.textContent = '';
        const mainText = document.createTextNode(`${ratio}x ${giveName} `);
        const subSpan = document.createElement('span');
        subSpan.style.fontSize = '11px';
        subSpan.style.opacity = '0.85';
        subSpan.textContent = i18n.t('AVAILABLE_IN_HAND', { count: have });
        giveSummaryEl.appendChild(mainText);
        giveSummaryEl.appendChild(subSpan);
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

  renderMerchantFleetChooser(container, onSelect) {
    if (!container) return;
    container.innerHTML = '';
    const label = document.createElement('div');
    label.textContent = i18n.t('PROGRESS_SELECT_RESOURCE_OR_COMMODITY');

    const grid = document.createElement('div');
    grid.className = 'modal-res-buttons-grid';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(4, 1fr)';
    grid.style.gap = '6px';
    grid.style.marginTop = '6px';

    this.getHandCardTypes().forEach(r => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-glass res-choice-btn';
      btn.dataset.res = r;
      btn.textContent = this.cardLabel(r);
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.res-choice-btn').forEach(x => x.classList.remove('btn-primary'));
        btn.classList.add('btn-primary');
        if (typeof onSelect === 'function') onSelect(r);
      });
      grid.appendChild(btn);
    });

    container.appendChild(label);
    container.appendChild(grid);
  }

  renderActiveTradeBanner(activeTrade) {
    const banner = this.banner || document.getElementById('active-trade-banner');
    if (!banner) return;

    if (!activeTrade) {
      banner.classList.remove('is-visible');
      banner.textContent = '';
      this.lastTradeKey = null;
      return;
    }

    const isMine = activeTrade.fromPlayerId === this.myPlayerId;
    banner.classList.add('is-visible');

    const from = this.gameState ? this.gameState.players.find(p => p.id === activeTrade.fromPlayerId) : null;
    const fromName = from ? from.name : '?';

    if (!isMine) {
      const key = `${activeTrade.fromPlayerId}:${JSON.stringify(activeTrade.give)}:${JSON.stringify(activeTrade.want)}`;
      if (key !== this.lastTradeKey) {
        this.audio.playTrade();
        this.showToast(i18n.t('TRADE_OFFER_FROM', { name: fromName }));
        this.lastTradeKey = key;
      }
    } else {
      this.lastTradeKey = null;
    }

    // Build chip list using safe DOM node construction
    const buildChipsList = (cardObj) => {
      const wrap = document.createElement('div');
      wrap.className = 'trade-chips-list';
      const entries = Object.entries(cardObj || {}).filter(([_, c]) => c > 0);
      if (entries.length === 0) {
        const empty = document.createElement('span');
        empty.style.fontSize = '11px';
        empty.style.color = 'var(--text-muted)';
        empty.textContent = '-';
        wrap.appendChild(empty);
        return wrap;
      }
      entries.forEach(([r, c]) => {
        const chip = document.createElement('span');
        chip.className = `trade-chip res-${r}`;
        chip.innerHTML = ico(r);
        const txt = document.createElement('span');
        txt.textContent = `${c} ${this.cardLabel(r)}`;
        chip.appendChild(txt);
        wrap.appendChild(chip);
      });
      return wrap;
    };

    const acceptedPlayers = (activeTrade.acceptedBy || []).map(pid =>
      this.gameState ? this.gameState.players.find(p => p.id === pid) : null
    ).filter(Boolean);

    banner.textContent = '';

    const body = document.createElement('div');
    body.className = 'trade-banner-body';

    const header = document.createElement('div');
    header.className = 'trade-banner-header';

    const exchange = document.createElement('div');
    exchange.className = 'trade-banner-exchange';

    const actions = document.createElement('div');
    actions.className = 'trade-banner-actions';

    if (isMine) {
      const iconSpan = document.createElement('span');
      iconSpan.textContent = '🤝';
      const textSpan = document.createElement('span');
      textSpan.textContent = i18n.t('TRADE_YOUR_OFFER');
      header.appendChild(iconSpan);
      header.appendChild(textSpan);

      const giveSide = document.createElement('div');
      giveSide.className = 'trade-exchange-side';
      const giveLbl = document.createElement('span');
      giveLbl.className = 'trade-side-label';
      giveLbl.style.color = '#f87171';
      giveLbl.textContent = `${i18n.t('TRADE_GIVE_LABEL')}:`;
      giveSide.appendChild(giveLbl);
      giveSide.appendChild(buildChipsList(activeTrade.give));

      const arrow = document.createElement('span');
      arrow.className = 'trade-arrow';
      arrow.textContent = '→';

      const wantSide = document.createElement('div');
      wantSide.className = 'trade-exchange-side';
      const wantLbl = document.createElement('span');
      wantLbl.className = 'trade-side-label';
      wantLbl.style.color = '#34d399';
      wantLbl.textContent = `${i18n.t('TRADE_RECEIVE_LABEL')}:`;
      wantSide.appendChild(wantLbl);
      wantSide.appendChild(buildChipsList(activeTrade.want));

      exchange.appendChild(giveSide);
      exchange.appendChild(arrow);
      exchange.appendChild(wantSide);

      body.appendChild(header);
      body.appendChild(exchange);

      if (acceptedPlayers.length > 0) {
        const badge = document.createElement('div');
        badge.className = 'trade-status-badge';
        badge.textContent = `✔ ${i18n.t('TRADE_PLAYERS_ACCEPTED', { names: acceptedPlayers.map(p => p.name).join(', ') })}`;
        body.appendChild(badge);

        acceptedPlayers.forEach(p => {
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'btn-glass btn-trade-confirm btn-confirm-trade';
          confirmBtn.dataset.pid = p.id;
          confirmBtn.textContent = `✅ ${i18n.t('CONFIRM_WITH')} ${p.name}`;
          confirmBtn.addEventListener('click', async () => {
            try {
              await this.network.sendAction('confirm_trade', { targetPlayerId: p.id });
            } catch (err) {
              this.showToast(err.message, true);
            }
          });
          actions.appendChild(confirmBtn);
        });
      } else {
        const waitNotice = document.createElement('div');
        waitNotice.style.fontSize = '11px';
        waitNotice.style.color = 'var(--text-secondary)';
        waitNotice.textContent = i18n.t('TRADE_WAITING_PLAYERS');
        body.appendChild(waitNotice);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-glass btn-secondary btn-cancel-trade';
      cancelBtn.textContent = i18n.t('CANCEL_ACTION');
      cancelBtn.addEventListener('click', async () => {
        await this.network.sendAction('cancel_trade');
      });
      actions.appendChild(cancelBtn);
    } else {
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '8px';

      const avatar = document.createElement('img');
      avatar.src = from?.avatar || '/assets/avatars/settler.jpg';
      avatar.style.width = '24px';
      avatar.style.height = '24px';
      avatar.style.borderRadius = '50%';
      avatar.style.objectFit = 'cover';
      avatar.style.border = `2px solid ${from?.color || 'var(--gold-primary)'}`;
      avatar.alt = fromName;

      const headerText = document.createElement('span');
      headerText.textContent = i18n.t('TRADE_OFFER_FROM', { name: fromName });

      header.appendChild(avatar);
      header.appendChild(headerText);

      const recSide = document.createElement('div');
      recSide.className = 'trade-exchange-side';
      const recLbl = document.createElement('span');
      recLbl.className = 'trade-side-label';
      recLbl.style.color = '#34d399';
      recLbl.textContent = `${i18n.t('TRADE_RECEIVE_LABEL')}:`;
      recSide.appendChild(recLbl);
      recSide.appendChild(buildChipsList(activeTrade.give));

      const arrow = document.createElement('span');
      arrow.className = 'trade-arrow';
      arrow.textContent = '←';

      const giveSide = document.createElement('div');
      giveSide.className = 'trade-exchange-side';
      const giveLbl = document.createElement('span');
      giveLbl.className = 'trade-side-label';
      giveLbl.style.color = '#f87171';
      giveLbl.textContent = `${i18n.t('TRADE_GIVE_LABEL')}:`;
      giveSide.appendChild(giveLbl);
      giveSide.appendChild(buildChipsList(activeTrade.want));

      exchange.appendChild(recSide);
      exchange.appendChild(arrow);
      exchange.appendChild(giveSide);

      body.appendChild(header);
      body.appendChild(exchange);

      const hasAccepted = (activeTrade.acceptedBy || []).includes(this.myPlayerId);
      const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
      const canAfford = me ? Object.entries(activeTrade.want).every(([res, amt]) => this.getCardCount(me, res) >= amt) : true;

      if (hasAccepted) {
        const badge = document.createElement('span');
        badge.className = 'trade-status-badge';
        badge.textContent = `✔ ${i18n.t('TRADE_YOU_ACCEPTED')}`;
        actions.appendChild(badge);

        const retractBtn = document.createElement('button');
        retractBtn.className = 'btn-glass btn-trade-decline btn-decline-trade';
        retractBtn.textContent = i18n.t('TRADE_RETRACT');
        retractBtn.addEventListener('click', async () => {
          try {
            await this.network.sendAction('respond_trade', { accept: false });
            banner.classList.remove('is-visible');
            banner.textContent = '';
          } catch (err) {
            this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
          }
        });
        actions.appendChild(retractBtn);
      } else if (canAfford) {
        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'btn-glass btn-trade-accept btn-accept-trade';
        acceptBtn.textContent = i18n.t('ACCEPT_TRADE_BTN');
        acceptBtn.addEventListener('click', async () => {
          try {
            await this.network.sendAction('respond_trade', { accept: true });
          } catch (err) {
            this.showToast(err.message, true);
          }
        });

        const declineBtn = document.createElement('button');
        declineBtn.className = 'btn-glass btn-trade-decline btn-decline-trade';
        declineBtn.textContent = i18n.t('DECLINE_TRADE_BTN');
        declineBtn.addEventListener('click', async () => {
          try {
            await this.network.sendAction('respond_trade', { accept: false });
            banner.classList.remove('is-visible');
            banner.textContent = '';
          } catch (err) {
            this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
          }
        });

        actions.appendChild(acceptBtn);
        actions.appendChild(declineBtn);
      } else {
        const disabledBtn = document.createElement('button');
        disabledBtn.className = 'btn-glass btn-trade-disabled';
        disabledBtn.disabled = true;
        disabledBtn.title = i18n.t('TRADE_NOT_ENOUGH_CARDS');
        disabledBtn.textContent = i18n.t('TRADE_NOT_ENOUGH_CARDS');

        const declineBtn = document.createElement('button');
        declineBtn.className = 'btn-glass btn-trade-decline btn-decline-trade';
        declineBtn.textContent = i18n.t('DECLINE_TRADE_BTN');
        declineBtn.addEventListener('click', async () => {
          try {
            await this.network.sendAction('respond_trade', { accept: false });
            banner.classList.remove('is-visible');
            banner.textContent = '';
          } catch (err) {
            this.showToast(i18n.t(`ERROR_${err.message}`) || err.message, true);
          }
        });

        actions.appendChild(disabledBtn);
        actions.appendChild(declineBtn);
      }
    }

    banner.appendChild(body);
    banner.appendChild(actions);
  }

  updateActiveTrade(tradeState) {
    this.renderActiveTradeBanner(tradeState);

    const tradeModal = this.container || document.getElementById('trade-modal');
    if (tradeModal && tradeModal.classList.contains('active')) {
      const s = this.gameState;
      if (s) {
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
    }
  }
}
