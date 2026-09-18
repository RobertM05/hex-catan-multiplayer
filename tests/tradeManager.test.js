/**
 * tests/tradeManager.test.js
 * Comprehensive unit tests for TradeManager (ARCH-02).
 * Tests bank/maritime trading, harbor ratios (generic 3:1, specific 2:1),
 * Merchant Fleet bonus override, Commercial Harbor / Trading House L3 commodity trades,
 * domestic trade lifecycles (propose, accept, decline tracking, confirmation),
 * race condition safeguards, serialization, cloning, and GameEngine integration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TradeManager, COMMODITY_TYPES, IMPROVEMENT_PERK_LEVEL } from '../server/game/TradeManager.js';
import { GameEngine, GAME_PHASES, GAME_MODES } from '../server/game/GameEngine.js';
import { BoardManager } from '../server/game/BoardManager.js';

function makeTestEngine(mode = GAME_MODES.BASE) {
  const engine = new GameEngine();
  engine.gameMode = mode;
  engine.addPlayer({ id: 'p1', name: 'Alice', color: 'red' });
  engine.addPlayer({ id: 'p2', name: 'Bob', color: 'blue' });
  engine.addPlayer({ id: 'p3', name: 'Charlie', color: 'green' });
  engine.addPlayer({ id: 'p4', name: 'Dana', color: 'yellow' });
  engine.startGame('standard');
  engine.phase = GAME_PHASES.TURN_ACTION;
  return engine;
}

function makeCkEngine() {
  const engine = new GameEngine({ mode: GAME_MODES.CITIES_KNIGHTS });
  engine.mode = GAME_MODES.CITIES_KNIGHTS;
  engine.gameMode = GAME_MODES.CITIES_KNIGHTS;
  engine.addPlayer({ id: 'p1', name: 'Alice', color: 'red' });
  engine.addPlayer({ id: 'p2', name: 'Bob', color: 'blue' });
  engine.addPlayer({ id: 'p3', name: 'Charlie', color: 'green' });
  engine.startGame('standard');
  engine.phase = GAME_PHASES.TURN_ACTION;
  return engine;
}

describe('TradeManager - Bank & Harbor Trade Ratios', () => {
  it('returns default 4:1 ratio when player has no harbors or perks', () => {
    const tm = new TradeManager();
    const player = { id: 'p1', settlementsBuilt: [], citiesBuilt: [] };
    const ratio = tm.getBankTradeRatio(player, 'wood');
    assert.equal(ratio, 4, 'Default bank trade ratio must be 4:1');
  });

  it('returns 3:1 generic harbor ratio when player owns a settlement at a generic harbor', () => {
    const tm = new TradeManager();
    const board = {
      vertices: new Map([
        ['v_gen', { id: 'v_gen', harbor: { type: 'generic', ratio: 3 } }],
        ['v_normal', { id: 'v_normal', harbor: null }]
      ])
    };
    const player = {
      id: 'p1',
      settlementsBuilt: ['v_gen'],
      citiesBuilt: []
    };

    assert.equal(tm.getBankTradeRatio(player, 'wood', board), 3);
    assert.equal(tm.getBankTradeRatio(player, 'brick', board), 3);
    assert.equal(tm.getBankTradeRatio(player, 'ore', board), 3);
  });

  it('returns 2:1 specific resource harbor ratio when player owns a settlement at a 2:1 harbor', () => {
    const tm = new TradeManager();
    const board = {
      vertices: new Map([
        ['v_wood', { id: 'v_wood', harbor: { type: 'wood', ratio: 2 } }],
        ['v_other', { id: 'v_other', harbor: null }]
      ])
    };
    const player = {
      id: 'p1',
      settlementsBuilt: ['v_wood'],
      citiesBuilt: []
    };

    assert.equal(tm.getBankTradeRatio(player, 'wood', board), 2, 'Wood harbor must give 2:1 on wood');
    assert.equal(tm.getBankTradeRatio(player, 'brick', board), 4, 'Wood harbor does not give discount on brick');
    assert.equal(tm.getBankTradeRatio(player, 'ore', board), 4, 'Wood harbor does not give discount on ore');
  });

  it('confers harbor ratio when player owns a city (citiesBuilt) on a harbor vertex', () => {
    const tm = new TradeManager();
    const board = {
      vertices: new Map([
        ['v_ore', { id: 'v_ore', harbor: { type: 'ore', ratio: 2 } }]
      ])
    };
    const player = {
      id: 'p1',
      settlementsBuilt: [],
      citiesBuilt: ['v_ore']
    };

    assert.equal(tm.getBankTradeRatio(player, 'ore', board), 2, 'City on ore harbor must give 2:1');
    assert.equal(tm.getBankTradeRatio(player, 'wheat', board), 4);
  });

  it('correctly resolves combined generic 3:1 harbor and specific 2:1 harbor', () => {
    const tm = new TradeManager();
    const board = {
      vertices: new Map([
        ['v_gen', { id: 'v_gen', harbor: { type: 'generic', ratio: 3 } }],
        ['v_brick', { id: 'v_brick', harbor: { type: 'brick', ratio: 2 } }]
      ])
    };
    const player = {
      id: 'p1',
      settlementsBuilt: ['v_gen', 'v_brick'],
      citiesBuilt: []
    };

    assert.equal(tm.getBankTradeRatio(player, 'brick', board), 2, 'Brick gets 2:1 from specific harbor');
    assert.equal(tm.getBankTradeRatio(player, 'wood', board), 3, 'Wood gets 3:1 from generic harbor');
    assert.equal(tm.getBankTradeRatio(player, 'wheat', board), 3, 'Wheat gets 3:1 from generic harbor');
  });

  it('Merchant Fleet 2:1 bonus overrides default 4:1 and generic 3:1', () => {
    const tm = new TradeManager();
    const board = {
      vertices: new Map([
        ['v_gen', { id: 'v_gen', harbor: { type: 'generic', ratio: 3 } }]
      ])
    };
    const player = {
      id: 'p1',
      settlementsBuilt: ['v_gen'],
      citiesBuilt: [],
      merchantFleetActive: true,
      merchantFleetResource: 'wool'
    };

    assert.equal(tm.getBankTradeRatio(player, 'wool', board), 2, 'Merchant Fleet overrides to 2:1 for wool');
    assert.equal(tm.getBankTradeRatio(player, 'brick', board), 3, 'Other resources retain 3:1 generic ratio');
  });

  it('Trading House (Commercial Harbor) Level 3 in C&K allows 2:1 on commodities only', () => {
    const engine = makeCkEngine();
    const tm = engine.tradeManager;
    const player = engine.players[0];

    player.cityImprovements.trade = 2;
    assert.equal(tm.getBankTradeRatio(player, 'cloth'), 4, 'Trade level 2 does not grant 2:1 on cloth');

    player.cityImprovements.trade = IMPROVEMENT_PERK_LEVEL; // Level 3
    assert.equal(tm.getBankTradeRatio(player, 'cloth'), 2, 'Trading House L3 grants 2:1 on cloth');
    assert.equal(tm.getBankTradeRatio(player, 'coin'), 2, 'Trading House L3 grants 2:1 on coin');
    assert.equal(tm.getBankTradeRatio(player, 'paper'), 2, 'Trading House L3 grants 2:1 on paper');

    // Resources remain at 4:1 (or harbor ratio)
    assert.equal(tm.getBankTradeRatio(player, 'wood'), 4, 'Trading House does not grant 2:1 on resources');
    assert.equal(tm.getBankTradeRatio(player, 'brick'), 4, 'Trading House does not grant 2:1 on resources');
  });

  it('Trading House perk is ignored when C&K is disabled', () => {
    const baseEngine = makeTestEngine(GAME_MODES.BASE);
    const tm = baseEngine.tradeManager;
    const player = baseEngine.players[0];
    player.cityImprovements = { trade: 3 };

    assert.equal(tm.getBankTradeRatio(player, 'cloth'), 4, 'Base mode ignores Trading House perk');
  });

  it('Merchant pawn perk in C&K grants 2:1 on merchant hex resource', () => {
    const engine = makeCkEngine();
    const tm = engine.tradeManager;
    const player = engine.players[0];

    // Find a wood hex
    let woodHexId = null;
    for (const [hexId, hex] of engine.grid.hexes) {
      if (hex.resource === 'wood') {
        woodHexId = hexId;
        break;
      }
    }

    engine.merchantHolder = player.id;
    engine.merchantHexId = woodHexId;

    assert.equal(tm.getBankTradeRatio(player, 'wood'), 2, 'Merchant pawn hex owner gets 2:1 on that resource');
    assert.equal(tm.getBankTradeRatio(player, 'brick'), 4, 'Other resources do not get merchant pawn bonus');
  });
});

describe('TradeManager - Bank Maritime Trade Execution', () => {
  it('successfully executes 4:1 bank trade and adjusts resources', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 5;
    p1.resources.ore = 0;

    const result = tm.executeBankTrade(p1, 'wood', 'ore', 4, engine);
    assert.deepEqual(result, { give: 'wood', receive: 'ore', ratio: 4 });
    assert.equal(p1.resources.wood, 1, '4 wood should be deducted');
    assert.equal(p1.resources.ore, 1, '1 ore should be added');
  });

  it('successfully executes 2:1 bank trade with specific harbor', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];

    // Place a settlement on a vertex with wheat harbor
    const harborVertex = Array.from(engine.grid.vertices.values()).find(v => v.harbor && v.harbor.type === 'wheat');
    assert.ok(harborVertex, 'Wheat harbor vertex must exist');
    p1.settlementsBuilt.push(harborVertex.id);

    p1.resources.wheat = 4;
    p1.resources.wood = 0;

    const result = tm.executeBankTrade(p1, 'wheat', 'wood', 2, engine);
    assert.deepEqual(result, { give: 'wheat', receive: 'wood', ratio: 2 });
    assert.equal(p1.resources.wheat, 2);
    assert.equal(p1.resources.wood, 1);
  });

  it('rejects bank trade if ratio is lower than best ratio', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 4;

    assert.throws(
      () => tm.executeBankTrade(p1, 'wood', 'ore', 2, engine),
      /INVALID_TRADE_RATIO/
    );
  });

  it('rejects bank trade if player does not have enough resources', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 3; // needs 4

    assert.throws(
      () => tm.executeBankTrade(p1, 'wood', 'ore', 4, engine),
      /NOT_ENOUGH_RESOURCES/
    );
  });

  it('rejects bank trade when giving and receiving the same resource', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 4;

    assert.throws(
      () => tm.executeBankTrade(p1, 'wood', 'wood', 4, engine),
      /CANNOT_TRADE_SAME_RESOURCE/
    );
  });

  it('rejects bank trade with invalid resource type', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];

    assert.throws(
      () => tm.executeBankTrade(p1, 'wood', 'gold_coins', 4, engine),
      /INVALID_RESOURCE/
    );
  });

  it('rejects bank trade when not in action phase', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 4;
    engine.phase = GAME_PHASES.TURN_ROLL;

    assert.throws(
      () => tm.executeBankTrade(p1, 'wood', 'ore', 4, engine),
      /NOT_IN_ACTION_PHASE/
    );
  });

  it('rejects bank trade during Special Building Phase', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 4;
    engine.phase = GAME_PHASES.TURN_SPECIAL_BUILDING;

    assert.throws(
      () => tm.executeBankTrade(p1, 'wood', 'ore', 4, engine),
      /TRADE_BLOCKED_DURING_SPECIAL_BUILDING/
    );
  });

  it('rejects bank trade when not current player turn', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p2 = engine.players[1];
    p2.resources.wood = 4;

    assert.throws(
      () => tm.executeBankTrade(p2, 'wood', 'ore', 4, engine),
      /NOT_YOUR_TURN/
    );
  });
});

describe('TradeManager - Domestic Trade Lifecycle', () => {
  it('proposes trade, tracks activeTrade properties, and validates resources', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 2;

    const trade = tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    assert.ok(trade);
    assert.ok(trade.id.startsWith('trade_'));
    assert.equal(trade.proposerId, 'p1');
    assert.equal(trade.fromPlayerId, 'p1');
    assert.equal(trade.targetPlayerId, null);
    assert.deepEqual(trade.give, { wood: 1 });
    assert.deepEqual(trade.want, { brick: 1 });
    assert.ok(trade.acceptedBy instanceof Set);
    assert.ok(trade.declinedBy instanceof Set);
    assert.equal(trade.acceptedBy.size, 0);
    assert.equal(trade.declinedBy.size, 0);
    assert.equal(typeof trade.createdAt, 'number');
  });

  it('proposeTrade rejects if player has insufficient resources', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 0;

    assert.throws(
      () => tm.proposeTrade(p1, { wood: 1 }, { brick: 1 }),
      /NOT_ENOUGH_RESOURCES_TO_GIVE/
    );
  });

  it('proposeTrade rejects invalid trade formats and same resource trading', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 2;

    assert.throws(() => tm.proposeTrade(p1, null, { brick: 1 }), /INVALID_TRADE_FORMAT/);
    assert.throws(() => tm.proposeTrade(p1, { wood: 1 }, { wood: 1 }), /CANNOT_TRADE_SAME_RESOURCE/);
    assert.throws(() => tm.proposeTrade(p1, { wood: 0 }, { brick: 1 }), /TRADE_MUST_OFFER_AND_REQUEST_RESOURCES/);
    assert.throws(() => tm.proposeTrade(p1, { wood: -1 }, { brick: 1 }), /AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER/);
  });

  it('tracks multi-player accept/decline responses preserving non-destructive decline set', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    const p2 = engine.players[1];
    const p3 = engine.players[2];
    const p4 = engine.players[3];

    p1.resources.wood = 2;
    p2.resources.brick = 2;
    p3.resources.brick = 2;
    p4.resources.brick = 0;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });

    // p2 declines
    const dec2 = tm.respondToTrade('p2', false);
    assert.equal(dec2.accepted, false);
    assert.equal(dec2.declined, true);
    assert.ok(tm.activeTrade.declinedBy.has('p2'));
    assert.equal(tm.activeTrade.responses['p2'], false);

    // p3 accepts
    const acc3 = tm.respondToTrade('p3', true);
    assert.equal(acc3.accepted, true);
    assert.ok(tm.activeTrade.acceptedBy.has('p3'));
    assert.equal(tm.activeTrade.responses['p3'], true);

    // p4 declines
    const dec4 = tm.respondToTrade('p4', false);
    assert.equal(dec4.declined, true);
    assert.ok(tm.activeTrade.declinedBy.has('p4'));

    // Verify non-destructive decline set: p2 and p4 are both preserved in declinedBy
    assert.ok(tm.activeTrade.declinedBy.has('p2'), 'p2 decline must be preserved');
    assert.ok(tm.activeTrade.declinedBy.has('p4'), 'p4 decline must be preserved');
    assert.ok(tm.activeTrade.acceptedBy.has('p3'), 'p3 accept must be preserved');

    // p2 changes mind and accepts: removes p2 from declinedBy, p4 remains in declinedBy
    const acc2 = tm.respondToTrade('p2', true);
    assert.equal(acc2.accepted, true);
    assert.ok(tm.activeTrade.acceptedBy.has('p2'));
    assert.equal(tm.activeTrade.declinedBy.has('p2'), false);
    assert.ok(tm.activeTrade.declinedBy.has('p4'), 'p4 must still remain declined');
  });

  it('enforces targeted trades so only the designated recipient may respond', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    const p2 = engine.players[1];
    const p3 = engine.players[2];

    p1.resources.wood = 2;
    p2.resources.brick = 2;
    p3.resources.brick = 2;

    // Propose trade targeted only to p2
    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 }, 'p2');
    assert.equal(tm.activeTrade.targetPlayerId, 'p2');

    // p3 attempts to respond -> should fail
    assert.throws(
      () => tm.respondToTrade('p3', true),
      /NOT_TRADE_RECIPIENT/
    );

    // p2 responds -> should succeed
    const res = tm.respondToTrade('p2', true);
    assert.equal(res.accepted, true);
    assert.ok(tm.activeTrade.acceptedBy.has('p2'));
  });

  it('rejects responder acceptance if responder does not have wanted cards', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    const p2 = engine.players[1];

    p1.resources.wood = 2;
    p2.resources.brick = 0; // P1 wants 1 brick, p2 has 0

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    assert.throws(
      () => tm.respondToTrade('p2', true),
      /NOT_ENOUGH_RESOURCES/
    );
  });

  it('proposer cannot respond to their own trade', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 2;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    assert.throws(
      () => tm.respondToTrade('p1', true),
      /CANNOT_RESPOND_TO_OWN_TRADE/
    );
  });

  it('successfully confirms trade, exchanges cards atomically, and clears activeTrade', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    const p2 = engine.players[1];

    p1.resources.wood = 2;
    p1.resources.brick = 0;
    p2.resources.wood = 0;
    p2.resources.brick = 2;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    tm.respondToTrade('p2', true);

    const record = tm.confirmTrade('p1', 'p2', engine);
    assert.ok(record);
    assert.equal(record.partnerId, 'p2');
    assert.equal(tm.activeTrade, null, 'activeTrade must be cleared after confirmation');

    assert.equal(p1.resources.wood, 1);
    assert.equal(p1.resources.brick, 1);
    assert.equal(p2.resources.wood, 1);
    assert.equal(p2.resources.brick, 1);
  });

  it('cancelTrade cancels trade if called by proposer, rejects if called by others', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 2;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    assert.throws(
      () => tm.cancelTrade('p2'),
      /NOT_YOUR_TRADE/
    );

    const cancelled = tm.cancelTrade('p1');
    assert.equal(cancelled, true);
    assert.equal(tm.activeTrade, null);
  });

  it('handlePlayerRemoval cleans up trade if player leaves', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    const p2 = engine.players[1];
    p1.resources.wood = 2;
    p2.resources.brick = 2;

    // Case 1: responder leaves
    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    tm.respondToTrade('p2', true);
    assert.ok(tm.activeTrade.acceptedBy.has('p2'));

    tm.handlePlayerRemoval('p2');
    assert.equal(tm.activeTrade.acceptedBy.has('p2'), false);
    assert.notEqual(tm.activeTrade, null);

    // Case 2: initiator leaves
    tm.handlePlayerRemoval('p1');
    assert.equal(tm.activeTrade, null);
  });
});

describe('TradeManager - Race Condition Safeguards', () => {
  it('confirm fails if initiator spent cards before confirmation', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    const p2 = engine.players[1];

    p1.resources.wood = 1;
    p1.resources.brick = 0;
    p2.resources.wood = 0;
    p2.resources.brick = 1;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    tm.respondToTrade('p2', true);

    // Simulated race condition: initiator spent their wood (e.g. building or robber steal)
    p1.resources.wood = 0;

    assert.throws(
      () => tm.confirmTrade('p1', 'p2', engine),
      /INITIATOR_MISSING_RESOURCES/
    );

    // Confirm that no cards were transferred
    assert.equal(p1.resources.wood, 0);
    assert.equal(p1.resources.brick, 0);
    assert.equal(p2.resources.wood, 0);
    assert.equal(p2.resources.brick, 1);
  });

  it('confirm fails if partner spent cards before confirmation', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    const p2 = engine.players[1];

    p1.resources.wood = 1;
    p1.resources.brick = 0;
    p2.resources.wood = 0;
    p2.resources.brick = 1;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    tm.respondToTrade('p2', true);

    // Simulated race condition: partner spent their brick in another action
    p2.resources.brick = 0;

    assert.throws(
      () => tm.confirmTrade('p1', 'p2', engine),
      /PARTNER_MISSING_RESOURCES/
    );

    // Confirm that no cards were transferred
    assert.equal(p1.resources.wood, 1);
    assert.equal(p1.resources.brick, 0);
    assert.equal(p2.resources.wood, 0);
    assert.equal(p2.resources.brick, 0);
  });

  it('confirm fails if partner never accepted', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 2;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    assert.throws(
      () => tm.confirmTrade('p1', 'p2', engine),
      /PLAYER_DID_NOT_ACCEPT/
    );
  });
});

describe('TradeManager - State Serialization and Cloning', () => {
  it('serializes null trade state correctly', () => {
    const tm = new TradeManager();
    const serialized = tm.serialize();
    assert.deepEqual(serialized, {
      activeTrade: null,
      lastTradeEvent: null
    });
  });

  it('serializes active trade converting Sets to JSON-serializable arrays', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 2;
    engine.players[1].resources.brick = 2;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    tm.respondToTrade('p2', true);
    tm.respondToTrade('p3', false);

    const serialized = tm.serialize();
    assert.ok(serialized.activeTrade);
    assert.equal(serialized.activeTrade.proposerId, 'p1');
    assert.deepEqual(serialized.activeTrade.acceptedBy, ['p2']);
    assert.deepEqual(serialized.activeTrade.declinedBy, ['p3']);
    assert.deepEqual(serialized.activeTrade.responses, { p2: true, p3: false });

    // Verify JSON stringification works cleanly without lost Sets
    const jsonStr = JSON.stringify(serialized);
    const parsed = JSON.parse(jsonStr);
    assert.deepEqual(parsed.activeTrade.acceptedBy, ['p2']);
    assert.deepEqual(parsed.activeTrade.declinedBy, ['p3']);
  });

  it('deserializes trade state restoring Set instances', () => {
    const rawData = {
      activeTrade: {
        id: 'trade_test_123',
        proposerId: 'p1',
        fromPlayerId: 'p1',
        targetPlayerId: null,
        give: { wood: 1 },
        want: { brick: 1 },
        responses: { p2: true, p3: false },
        acceptedBy: ['p2'],
        declinedBy: ['p3'],
        createdAt: 123456789
      },
      lastTradeEvent: { id: 'evt_1', type: 'declined', playerId: 'p3' }
    };

    const tm = TradeManager.deserialize(rawData);
    assert.ok(tm.activeTrade);
    assert.equal(tm.activeTrade.id, 'trade_test_123');
    assert.ok(tm.activeTrade.acceptedBy instanceof Set);
    assert.ok(tm.activeTrade.declinedBy instanceof Set);
    assert.ok(tm.activeTrade.acceptedBy.has('p2'));
    assert.ok(tm.activeTrade.declinedBy.has('p3'));
    assert.deepEqual(tm.lastTradeEvent, rawData.lastTradeEvent);
  });

  it('clones TradeManager deeply without mutating original state', () => {
    const engine = makeTestEngine();
    const tm = engine.tradeManager;
    const p1 = engine.players[0];
    p1.resources.wood = 2;
    engine.players[1].resources.brick = 2;

    tm.proposeTrade(p1, { wood: 1 }, { brick: 1 });
    tm.respondToTrade('p2', true);

    const cloned = tm.clone();
    assert.ok(cloned.activeTrade);
    assert.equal(cloned.activeTrade.id, tm.activeTrade.id);
    assert.ok(cloned.activeTrade.acceptedBy instanceof Set);
    assert.ok(cloned.activeTrade.acceptedBy.has('p2'));

    // Mutate clone
    cloned.activeTrade.acceptedBy.add('p4');
    cloned.activeTrade.give.wood = 99;

    assert.equal(tm.activeTrade.acceptedBy.has('p4'), false, 'Original acceptedBy must not be mutated');
    assert.equal(tm.activeTrade.give.wood, 1, 'Original give object must not be mutated');
  });
});

describe('TradeManager - GameEngine Integration & Backward Compatibility', () => {
  it('engine initializes tradeManager and delegates all trade methods', () => {
    const engine = makeTestEngine();
    assert.ok(engine.tradeManager instanceof TradeManager);

    const p1 = engine.players[0];
    const p2 = engine.players[1];
    p1.resources.wood = 2;
    p2.resources.brick = 2;

    // Propose via engine
    engine.proposeTrade('p1', { wood: 1 }, { brick: 1 });
    assert.ok(engine.activeTrade);
    assert.equal(engine.activeTrade.fromPlayerId, 'p1');
    assert.equal(engine.tradeManager.activeTrade.fromPlayerId, 'p1');

    // Respond via engine
    engine.respondToTrade('p2', true);
    assert.ok(engine.activeTrade.acceptedBy.has('p2'));

    // Confirm via engine
    engine.confirmTrade('p1', 'p2');
    assert.equal(engine.activeTrade, null);
    assert.equal(engine.tradeManager.activeTrade, null);
    assert.equal(p1.resources.wood, 1);
    assert.equal(p1.resources.brick, 1);
  });

  it('engine.activeTrade setter delegates to tradeManager', () => {
    const engine = makeTestEngine();
    assert.equal(engine.activeTrade, null);

    const mockTrade = { id: 'mock', fromPlayerId: 'p1' };
    engine.activeTrade = mockTrade;
    assert.equal(engine.tradeManager.activeTrade, mockTrade);
    assert.equal(engine.activeTrade, mockTrade);

    engine.activeTrade = null;
    assert.equal(engine.tradeManager.activeTrade, null);
    assert.equal(engine.activeTrade, null);
  });

  it('engine.getBankTradeRatio, getBestBankTradeRatio, and getBestBankRatio all delegate properly', () => {
    const engine = makeTestEngine();
    const p1 = engine.players[0];

    assert.equal(engine.getBankTradeRatio(p1, 'wood'), 4);
    assert.equal(engine.getBestBankTradeRatio(p1, 'wood'), 4);
    assert.equal(engine.getBestBankRatio(p1, 'wood'), 4);
  });

  it('engine.executeBankTrade delegates to tradeManager and updates player resources', () => {
    const engine = makeTestEngine();
    const p1 = engine.players[0];
    p1.resources.wood = 4;
    p1.resources.brick = 0;

    const res = engine.executeBankTrade('p1', 'wood', 'brick', 4);
    assert.deepEqual(res, { give: 'wood', receive: 'brick', ratio: 4 });
    assert.equal(p1.resources.wood, 0);
    assert.equal(p1.resources.brick, 1);
  });

  it('engine.getStateForPlayer correctly formats activeTrade for client transport', () => {
    const engine = makeTestEngine();
    const p1 = engine.players[0];
    p1.resources.wood = 2;
    engine.players[1].resources.brick = 2;

    engine.proposeTrade('p1', { wood: 1 }, { brick: 1 });
    engine.respondToTrade('p2', true);

    const state = engine.getStateForPlayer('p1');
    assert.ok(state.activeTrade);
    assert.equal(Array.isArray(state.activeTrade.acceptedBy), true);
    assert.deepEqual(state.activeTrade.acceptedBy, ['p2']);
  });
});
