/**
 * ChatLogView.js
 * Decoupled ES module UI component managing the In-Game Event Log
 * and Player Chat message stream.
 */

import { i18n } from '../i18n.js';
import { network } from '../network.js';
import { escapeHtml } from './LobbyView.js';

const FOW_TYPED_GAIN_LOG_TYPES = new Set(['RESOURCE_PRODUCED', 'AQUEDUCT_RESOURCE', 'BOOTSTRAP_RESOURCES']);
const HIDDEN_GAIN_MESSAGE_KEYS = {
  RESOURCE_PRODUCED: 'LOG_RESOURCE_PRODUCED_HIDDEN',
  AQUEDUCT_RESOURCE: 'LOG_AQUEDUCT_RESOURCE_HIDDEN',
  BOOTSTRAP_RESOURCES: 'LOG_BOOTSTRAP_RESOURCES_HIDDEN'
};

function countCardMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 0;
  return Object.values(map).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

export function redactEventLogEntryForViewer(entry, viewer) {
  if (!entry || !FOW_TYPED_GAIN_LOG_TYPES.has(entry.type)) return entry;
  const args = entry.args && typeof entry.args === 'object' ? entry.args : {};
  const viewerId = viewer?.id || viewer?.playerId;
  const isOwner = Boolean(viewerId) && args.playerId === viewerId;
  if (isOwner) return entry;

  const publicArgs = {
    playerName: args.playerName,
    playerId: args.playerId
  };
  if (entry.type === 'RESOURCE_PRODUCED') {
    publicArgs.amount = args.amount;
  } else if (entry.type === 'AQUEDUCT_RESOURCE') {
    publicArgs.amount = 1;
  } else {
    publicArgs.count = args.count != null ? args.count : countCardMap(args.resources);
  }
  return {
    ...entry,
    messageKey: HIDDEN_GAIN_MESSAGE_KEYS[entry.type] || entry.messageKey,
    args: publicArgs
  };
}

export class ChatLogView {
  constructor(options = {}) {
    this.logContainer = options.logContainer || (typeof document !== 'undefined' ? document.getElementById('log-scroll') : null);
    this.chatContainer = options.chatContainer || (typeof document !== 'undefined' ? document.getElementById('chat-messages') : null);
    this.network = options.network || network;
    this.showToast = options.showToast || ((msg, isErr) => {});
    this.getMyPlayerId = options.getMyPlayerId || (() => this.network?.currentPlayerId || null);
    this.getGameState = options.getGameState || (() => null);
    this.cardLabel = options.cardLabel || ((type) => type);
    this.lastProcessedLogCount = 0;
  }

  get myPlayerId() {
    return this.getMyPlayerId();
  }

  get gameState() {
    return this.getGameState();
  }

  renderLog(logs, diceAnim = false, deferredProductionToasts = []) {
    if (!logs) return;
    const logScroll = this.logContainer || document.getElementById('log-scroll');
    if (!logScroll) return;
    logScroll.innerHTML = '';

    const me = this.gameState ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;

    if (logs.length > (this.lastProcessedLogCount || 0)) {
      const newEntries = logs.slice(this.lastProcessedLogCount || 0);
      newEntries.forEach(rawEntry => {
        const entry = redactEventLogEntryForViewer(rawEntry, me);
        if (entry.type === 'ROBBER_STOLE' && me && entry.args && entry.args.victimName === me.name && entry.args.robberName !== me.name) {
          this.showToast(i18n.t('ROBBER_STOLE_FROM_YOU', { robber: entry.args.robberName }), true);
        } else if (entry.type === 'RESOURCE_PRODUCED' && me && entry.args && entry.args.playerId === me.id && entry.args.resource) {
          const resLocalized = i18n.t(`RES_${entry.args.resource.toUpperCase()}`);
          const message = i18n.t('YOU_RECEIVED_RESOURCE', { amount: entry.args.amount, resource: resLocalized });
          if (diceAnim) deferredProductionToasts.push(message);
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

    logs.slice().reverse().forEach(rawEntry => {
      const entry = redactEventLogEntryForViewer(rawEntry, me);
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
    const container = this.chatContainer || document.getElementById('chat-messages');
    if (!container) return;
    const el = document.createElement('div');
    el.style.marginBottom = '6px';
    el.innerHTML = `
      <span style="color: ${msg.color || '#f59e0b'}; font-weight: 700;">${escapeHtml(msg.senderName)}:</span>
      <span style="color: var(--text-primary);">${escapeHtml(msg.text)}</span>
    `;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }
}
