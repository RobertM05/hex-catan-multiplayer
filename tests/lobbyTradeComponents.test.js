import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LobbyView, escapeHtml } from '../public/js/components/LobbyView.js';
import { TradeModal } from '../public/js/components/TradeModal.js';
import { DevCardsModal } from '../public/js/components/DevCardsModal.js';
import { DiscardModal } from '../public/js/components/DiscardModal.js';
import { ChatLogView, redactEventLogEntryForViewer } from '../public/js/components/ChatLogView.js';
import { CitiesKnightsView } from '../public/js/components/CitiesKnightsView.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('UI-02: app.js modularization and line count constraints', () => {
  const appSource = readFileSync(join(root, 'public/js/app.js'), 'utf8');
  const lineCount = appSource.split('\n').length;
  assert.ok(lineCount < 3000, `Expected app.js to be under 3000 lines, got ${lineCount}`);
  assert.ok(appSource.includes('this.lobbyView = new LobbyView'), 'app.js must instantiate LobbyView');
  assert.ok(appSource.includes('this.tradeModal = new TradeModal'), 'app.js must instantiate TradeModal');
  assert.ok(appSource.includes('export { escapeHtml, redactEventLogEntryForViewer }'), 'app.js must preserve backward-compatible exports');
});

test('UI-02: LobbyView instantiation and escapeHtml helper', () => {
  const lobby = new LobbyView();
  assert.ok(lobby, 'LobbyView should instantiate without DOM');
  assert.equal(typeof lobby.setupLobbyTabs, 'function');
  assert.equal(typeof lobby.setupLobbyActions, 'function');
  assert.equal(typeof lobby.refreshPublicRooms, 'function');
  assert.equal(typeof lobby.renderWaitingRoom, 'function');

  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml('Normal text & name'), 'Normal text &amp; name');
  assert.equal(escapeHtml(null), '');
});

test('UI-02: TradeModal bank ratio calculation logic', () => {
  let mockGameState = {
    currentPlayerId: 'p1',
    grid: {
      vertices: {
        v1: { harbor: { type: 'wood', ratio: 2 } },
        v2: { harbor: { type: 'generic', ratio: 3 } },
        v3: {}
      },
      hexes: {
        h1: { resource: 'wheat' }
      }
    },
    players: [
      {
        id: 'p1',
        name: 'Alice',
        resources: { wood: 5, brick: 3, wool: 1, wheat: 4, ore: 0 },
        settlementsBuilt: ['v1'],
        citiesBuilt: []
      }
    ]
  };

  const trade = new TradeModal({
    getGameState: () => mockGameState,
    getMyPlayerId: () => 'p1',
    getHandCardTypes: () => ['wood', 'brick', 'wool', 'wheat', 'ore'],
    getCardCount: (me, res) => me?.resources?.[res] || 0
  });

  // Wood has 2:1 harbor
  assert.equal(trade.getBestBankRatio('wood'), 2);
  // Brick has no harbor, defaults to 4:1
  assert.equal(trade.getBestBankRatio('brick'), 4);

  // Add 3:1 generic harbor to player's buildings
  mockGameState.players[0].settlementsBuilt.push('v2');
  assert.equal(trade.getBestBankRatio('brick'), 3);
  assert.equal(trade.getBestBankRatio('wool'), 3);
  // Wood still keeps 2:1 specialized ratio
  assert.equal(trade.getBestBankRatio('wood'), 2);

  // Merchant Fleet bonus gives 2:1 for designated resource
  mockGameState.players[0].merchantFleetResource = 'ore';
  assert.equal(trade.getBestBankRatio('ore'), 2);
});

test('UI-02: TradeModal proposal and safe DOM construction', () => {
  const trade = new TradeModal();
  assert.equal(typeof trade.setupTradeModals, 'function');
  assert.equal(typeof trade.renderActiveTradeBanner, 'function');
  assert.equal(typeof trade.open, 'function');
  assert.equal(typeof trade.hide, 'function');
  assert.equal(typeof trade.showProposal, 'function');
});

test('UI-02: DevCardsModal, DiscardModal, ChatLogView, and CitiesKnightsView module contracts', () => {
  const dev = new DevCardsModal();
  assert.equal(typeof dev.setupDevCardsModal, 'function');
  assert.equal(typeof dev.renderDevCardsList, 'function');

  const discard = new DiscardModal();
  assert.equal(typeof discard.setupDiscardModal, 'function');
  assert.equal(typeof discard.checkDiscardState, 'function');
  assert.equal(typeof discard.openRobberTargetModal, 'function');

  const chat = new ChatLogView();
  assert.equal(typeof chat.renderLog, 'function');
  assert.equal(typeof chat.appendChatMessage, 'function');

  const ck = new CitiesKnightsView();
  assert.equal(typeof ck.setupCkUi, 'function');
  assert.equal(typeof ck.openKnightActionMenu, 'function');
  assert.equal(typeof ck.closeKnightActionMenu, 'function');
  assert.equal(typeof ck.renderBarbarianOverlay, 'function');
});
