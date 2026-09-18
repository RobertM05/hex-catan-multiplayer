/**
 * TradeManager.js
 * Encapsulates domestic player-to-player trading and bank maritime trading,
 * including harbor ratio resolution, Merchant Fleet bonuses, and C&K perks.
 */

import { RESOURCE_TYPES } from './HexGrid.js';

export const COMMODITY_TYPES = {
  CLOTH: 'cloth',
  COIN: 'coin',
  PAPER: 'paper'
};

export const COMMODITY_VALUES = Object.values(COMMODITY_TYPES);

export const RESOURCE_VALUES = [
  RESOURCE_TYPES.WOOD,
  RESOURCE_TYPES.BRICK,
  RESOURCE_TYPES.WOOL,
  RESOURCE_TYPES.WHEAT,
  RESOURCE_TYPES.ORE
];

export const IMPROVEMENT_PERK_LEVEL = 3;

export const GAME_PHASES = {
  TURN_ACTION: 'TURN_ACTION',
  TURN_SPECIAL_BUILDING: 'TURN_SPECIAL_BUILDING'
};

export class TradeManager {
  constructor(engine = null) {
    this.engine = engine;
    this.activeTrade = null;
    this.lastTradeEvent = null;
  }

  // --- Bank / Maritime Trading ---

  hasTradingHouse(player) {
    return (player?.cityImprovements?.trade || 0) >= IMPROVEMENT_PERK_LEVEL;
  }

  isTradableType(type, engine = this.engine) {
    if (engine && typeof engine.isTradableType === 'function') {
      return engine.isTradableType(type);
    }
    if (RESOURCE_VALUES.includes(type)) return true;
    const isCk = engine
      ? (typeof engine.isCitiesKnights === 'function' ? engine.isCitiesKnights() : engine.gameMode === 'cities_knights')
      : true;
    return Boolean(isCk && COMMODITY_VALUES.includes(type));
  }

  getPlayerCardCount(player, type, engine = this.engine) {
    if (engine && typeof engine.getPlayerCardCount === 'function') {
      return engine.getPlayerCardCount(player, type);
    }
    if (COMMODITY_VALUES.includes(type)) {
      return player?.commodities?.[type] || 0;
    }
    return player?.resources?.[type] || 0;
  }

  adjustPlayerCard(player, type, delta, engine = this.engine) {
    if (engine && typeof engine.adjustPlayerCard === 'function') {
      engine.adjustPlayerCard(player, type, delta);
      return;
    }
    if (COMMODITY_VALUES.includes(type)) {
      if (!player.commodities) player.commodities = {};
      player.commodities[type] = (player.commodities[type] || 0) + delta;
      return;
    }
    if (!player.resources) player.resources = {};
    player.resources[type] = (player.resources[type] || 0) + delta;
  }

  _getVertex(board, vKey) {
    if (!board) return null;
    if (typeof board.getVertex === 'function') return board.getVertex(vKey);
    if (board.vertices) {
      if (typeof board.vertices.get === 'function') return board.vertices.get(vKey);
      if (typeof board.vertices === 'object') return board.vertices[vKey];
    }
    if (board.grid) {
      if (typeof board.grid.getVertex === 'function') return board.grid.getVertex(vKey);
      if (board.grid.vertices) {
        if (typeof board.grid.vertices.get === 'function') return board.grid.vertices.get(vKey);
        if (typeof board.grid.vertices === 'object') return board.grid.vertices[vKey];
      }
    }
    if (typeof board.get === 'function') return board.get(vKey);
    if (typeof board === 'object' && board[vKey]) return board[vKey];
    return null;
  }

  getBankTradeRatio(player, resource, board = null) {
    const actualPlayer = typeof player === 'string'
      ? (this.engine?.players?.find(p => p.id === player) || { id: player })
      : player;

    let bestRatio = 4;

    // 1. Active Merchant Fleet resource (overrides all ratios to 2:1)
    if (actualPlayer?.merchantFleetResource && actualPlayer.merchantFleetResource === resource) {
      return 2;
    }

    // 2. Commercial Harbor / Trading House level 3 commodity trade perk if C&K enabled (2:1 for commodities only)
    const isCk = this.engine
      ? (typeof this.engine.isCitiesKnights === 'function'
          ? (this.engine.isCitiesKnights() || this.engine.gameMode === 'cities_knights' || this.engine.mode === 'cities_knights')
          : (this.engine.mode === 'cities_knights' || this.engine.gameMode === 'cities_knights'))
      : true;
    if (isCk && this.hasTradingHouse(actualPlayer) && COMMODITY_VALUES.includes(resource)) {
      bestRatio = 2;
    } else if (this.engine && this.engine.merchantHolder === actualPlayer?.id && this.engine.merchantHexId) {
      // Merchant pawn on resource hex perk (C&K)
      const hexGrid = this.engine.board || this.engine.grid;
      const hex = hexGrid?.hexes?.get ? hexGrid.hexes.get(this.engine.merchantHexId) : hexGrid?.hexes?.[this.engine.merchantHexId];
      if (hex && hex.resource === resource) {
        bestRatio = 2;
      }
    }

    // 3. Harbor vertices owned (2:1 specific harbor, 3:1 generic harbor)
    if (bestRatio > 2) {
      const activeBoard = board || this.engine?.board || this.engine?.grid;
      const builtVertices = (actualPlayer?.settlementsBuilt || []).concat(actualPlayer?.citiesBuilt || []);

      if (builtVertices.length > 0 && activeBoard) {
        for (const vKey of builtVertices) {
          const v = this._getVertex(activeBoard, vKey);
          if (v && v.harbor) {
            if (v.harbor.type === resource && v.harbor.ratio === 2) {
              bestRatio = 2;
              break;
            }
            if (v.harbor.type === 'generic' && v.harbor.ratio === 3) {
              bestRatio = Math.min(bestRatio, 3);
            }
          }
        }
      } else if (activeBoard) {
        // Fallback: iterate over vertices owned by player if settlement/city keys not populated directly on player
        const allVertices = activeBoard.vertices
          ? (activeBoard.vertices.values ? Array.from(activeBoard.vertices.values()) : Object.values(activeBoard.vertices))
          : (activeBoard.grid?.vertices ? (activeBoard.grid.vertices.values ? Array.from(activeBoard.grid.vertices.values()) : Object.values(activeBoard.grid.vertices)) : []);
        for (const v of allVertices) {
          if (v?.building?.playerId === actualPlayer?.id && v.harbor) {
            if (v.harbor.type === resource && v.harbor.ratio === 2) {
              bestRatio = 2;
              break;
            }
            if (v.harbor.type === 'generic' && v.harbor.ratio === 3) {
              bestRatio = Math.min(bestRatio, 3);
            }
          }
        }
      }
    }

    // 4. Default ratio (4:1)
    return bestRatio;
  }

  executeBankTrade(player, give, receive, ratio = 4, engine = this.engine) {
    const actualEngine = engine || this.engine;
    let actualPlayer;
    let playerId;

    if (typeof player === 'string') {
      playerId = player;
      actualPlayer = actualEngine?.players?.find(p => p.id === playerId)
        || (typeof actualEngine?.getCurrentPlayer === 'function' ? actualEngine.getCurrentPlayer() : null)
        || { id: playerId };
    } else {
      actualPlayer = player;
      playerId = player?.id;
    }

    if (actualEngine) {
      if (typeof actualEngine.getCurrentPlayer === 'function') {
        const curPlayer = actualEngine.getCurrentPlayer();
        if (curPlayer && curPlayer.id !== playerId) {
          throw new Error('NOT_YOUR_TURN');
        }
      }
      if (actualEngine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
        throw new Error('TRADE_BLOCKED_DURING_SPECIAL_BUILDING');
      }
      if (actualEngine.phase && actualEngine.phase !== GAME_PHASES.TURN_ACTION) {
        throw new Error('NOT_IN_ACTION_PHASE');
      }
    }

    if (!this.isTradableType(give, actualEngine) || !this.isTradableType(receive, actualEngine)) {
      throw new Error('INVALID_RESOURCE');
    }
    if (give === receive) {
      throw new Error('CANNOT_TRADE_SAME_RESOURCE');
    }

    const bestRatio = this.getBankTradeRatio(actualPlayer, give, actualEngine?.board || actualEngine?.grid);
    if (ratio < bestRatio) {
      throw new Error('INVALID_TRADE_RATIO');
    }

    if (this.getPlayerCardCount(actualPlayer, give, actualEngine) < bestRatio) {
      throw new Error('NOT_ENOUGH_RESOURCES');
    }

    this.adjustPlayerCard(actualPlayer, give, -bestRatio, actualEngine);
    this.adjustPlayerCard(actualPlayer, receive, 1, actualEngine);

    if (actualEngine && typeof actualEngine.logEvent === 'function') {
      actualEngine.logEvent({
        type: 'BANK_TRADE',
        messageKey: 'LOG_BANK_TRADE',
        args: { playerName: actualPlayer.name || playerId, give, receive, ratio: bestRatio }
      });
    }

    return { give, receive, ratio: bestRatio };
  }

  // --- Domestic Player-to-Player Trading ---

  proposeTrade(player, give, want, targetPlayerId = null) {
    const actualEngine = this.engine;
    let proposer;
    let playerId;

    if (typeof player === 'string') {
      playerId = player;
      proposer = actualEngine?.players?.find(p => p.id === playerId)
        || (typeof actualEngine?.getCurrentPlayer === 'function' ? actualEngine.getCurrentPlayer() : null)
        || { id: playerId };
    } else {
      proposer = player;
      playerId = player?.id;
    }

    if (actualEngine) {
      if (typeof actualEngine.getCurrentPlayer === 'function') {
        const curPlayer = actualEngine.getCurrentPlayer();
        if (curPlayer && curPlayer.id !== playerId) {
          throw new Error('NOT_YOUR_TURN');
        }
      }
      if (actualEngine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
        throw new Error('TRADE_BLOCKED_DURING_SPECIAL_BUILDING');
      }
      if (actualEngine.phase && actualEngine.phase !== GAME_PHASES.TURN_ACTION) {
        throw new Error('NOT_IN_ACTION_PHASE');
      }
    }

    if (!give || !want || typeof give !== 'object' || typeof want !== 'object') {
      throw new Error('INVALID_TRADE_FORMAT');
    }

    let totalGive = 0;
    for (const [res, amount] of Object.entries(give)) {
      if (!this.isTradableType(res, actualEngine)) throw new Error(`INVALID_RESOURCE_${res}`);
      if (!Number.isInteger(amount) || amount < 0) throw new Error('AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER');
      if (this.getPlayerCardCount(proposer, res, actualEngine) < amount) throw new Error('NOT_ENOUGH_RESOURCES_TO_GIVE');
      totalGive += amount;
    }

    let totalWant = 0;
    for (const [res, amount] of Object.entries(want)) {
      if (!this.isTradableType(res, actualEngine)) throw new Error(`INVALID_RESOURCE_${res}`);
      if (!Number.isInteger(amount) || amount < 0) throw new Error('AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER');
      totalWant += amount;
    }

    if (totalGive <= 0 || totalWant <= 0) {
      throw new Error('TRADE_MUST_OFFER_AND_REQUEST_RESOURCES');
    }

    for (const res of Object.keys(give)) {
      if (give[res] > 0 && want[res] > 0) {
        throw new Error('CANNOT_TRADE_SAME_RESOURCE');
      }
    }

    if (targetPlayerId) {
      if (targetPlayerId === playerId) {
        throw new Error('CANNOT_TRADE_WITH_SELF');
      }
      if (actualEngine?.players && !actualEngine.players.some(p => p.id === targetPlayerId)) {
        throw new Error('TARGET_PLAYER_NOT_FOUND');
      }
    }

    const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.activeTrade = {
      id: tradeId,
      proposerId: playerId,
      fromPlayerId: playerId, // alias for backward compatibility
      targetPlayerId: targetPlayerId || null,
      give: { ...give },
      want: { ...want },
      responses: {},
      acceptedBy: new Set(),
      declinedBy: new Set(),
      createdAt: Date.now()
    };

    if (actualEngine && typeof actualEngine.logEvent === 'function') {
      actualEngine.logEvent({
        type: 'TRADE_PROPOSED',
        messageKey: 'LOG_TRADE_PROPOSED',
        args: { playerName: proposer.name || playerId, give, want }
      });
    }

    return this.activeTrade;
  }

  respondToTrade(playerId, accept) {
    if (!this.activeTrade) throw new Error('NO_ACTIVE_TRADE');
    const proposerId = this.activeTrade.proposerId || this.activeTrade.fromPlayerId;
    if (proposerId === playerId) throw new Error('CANNOT_RESPOND_TO_OWN_TRADE');

    if (this.activeTrade.targetPlayerId && this.activeTrade.targetPlayerId !== playerId) {
      throw new Error('NOT_TRADE_RECIPIENT');
    }

    const actualEngine = this.engine;
    const responder = actualEngine?.players?.find(p => p.id === playerId) || { id: playerId };
    if (actualEngine?.players && !actualEngine.players.some(p => p.id === playerId)) {
      throw new Error('PLAYER_NOT_FOUND');
    }

    if (accept) {
      // Verify responder has resources requested in want
      for (const [res, amount] of Object.entries(this.activeTrade.want)) {
        if (this.getPlayerCardCount(responder, res, actualEngine) < amount) {
          throw new Error('NOT_ENOUGH_RESOURCES');
        }
      }
      this.activeTrade.acceptedBy.add(playerId);
      this.activeTrade.responses[playerId] = true;
      if (this.activeTrade.declinedBy) {
        this.activeTrade.declinedBy.delete(playerId);
      }
      return { trade: this.activeTrade, accepted: true, playerId };
    } else {
      this.activeTrade.acceptedBy.delete(playerId);
      this.activeTrade.responses[playerId] = false;
      if (!this.activeTrade.declinedBy) {
        this.activeTrade.declinedBy = new Set();
      }
      this.activeTrade.declinedBy.add(playerId);

      const fromPlayer = actualEngine?.players?.find(p => p.id === proposerId);
      const lastTradeEvent = {
        id: `trade_declined_${Date.now()}`,
        type: 'declined',
        playerId,
        playerName: responder.name || 'Player',
        fromPlayerId: proposerId
      };
      this.lastTradeEvent = lastTradeEvent;
      if (actualEngine) {
        actualEngine.lastTradeEvent = lastTradeEvent;
        if (typeof actualEngine.logEvent === 'function') {
          actualEngine.logEvent({
            type: 'TRADE_DECLINED',
            messageKey: 'LOG_TRADE_DECLINED',
            args: { playerName: responder.name || 'Player', initiator: fromPlayer?.name || 'Player' }
          });
        }
      }
      return { trade: this.activeTrade, accepted: false, playerId, declined: true };
    }
  }

  confirmTrade(proposerId, targetId, engine = this.engine) {
    if (!this.activeTrade) throw new Error('NO_ACTIVE_TRADE');

    const pId = typeof proposerId === 'object' ? proposerId.id : proposerId;
    const tId = typeof targetId === 'object' ? targetId.id : targetId;
    const activeProposerId = this.activeTrade.proposerId || this.activeTrade.fromPlayerId;

    if (activeProposerId !== pId) throw new Error('NOT_YOUR_TRADE');

    const actualEngine = engine || this.engine;
    if (actualEngine) {
      if (actualEngine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
        throw new Error('TRADE_BLOCKED_DURING_SPECIAL_BUILDING');
      }
      if (actualEngine.phase && actualEngine.phase !== GAME_PHASES.TURN_ACTION) {
        throw new Error('NOT_IN_ACTION_PHASE');
      }
    }

    if (!this.activeTrade.acceptedBy.has(tId)) {
      throw new Error('PLAYER_DID_NOT_ACCEPT');
    }

    let initiator = typeof proposerId === 'object' ? proposerId : null;
    let partner = typeof targetId === 'object' ? targetId : null;

    if (actualEngine?.players) {
      initiator = actualEngine.players.find(p => p.id === pId) || initiator;
      partner = actualEngine.players.find(p => p.id === tId) || partner;
    }
    if (!initiator || !partner) throw new Error('PLAYER_NOT_FOUND');

    // Instant card verification to prevent race condition exploits
    for (const [res, amt] of Object.entries(this.activeTrade.give)) {
      if (this.getPlayerCardCount(initiator, res, actualEngine) < amt) {
        throw new Error('INITIATOR_MISSING_RESOURCES');
      }
    }
    for (const [res, amt] of Object.entries(this.activeTrade.want)) {
      if (this.getPlayerCardCount(partner, res, actualEngine) < amt) {
        throw new Error('PARTNER_MISSING_RESOURCES');
      }
    }

    // Execute card exchange atomically
    for (const [res, amt] of Object.entries(this.activeTrade.give)) {
      this.adjustPlayerCard(initiator, res, -amt, actualEngine);
      this.adjustPlayerCard(partner, res, amt, actualEngine);
    }
    for (const [res, amt] of Object.entries(this.activeTrade.want)) {
      this.adjustPlayerCard(partner, res, -amt, actualEngine);
      this.adjustPlayerCard(initiator, res, amt, actualEngine);
    }

    const tradeRecord = {
      ...this.activeTrade,
      partnerId: tId,
      targetPlayerId: tId,
      acceptedBy: new Set(this.activeTrade.acceptedBy),
      declinedBy: new Set(this.activeTrade.declinedBy || [])
    };
    this.activeTrade = null;

    if (actualEngine && typeof actualEngine.logEvent === 'function') {
      actualEngine.logEvent({
        type: 'TRADE_COMPLETED',
        messageKey: 'LOG_TRADE_COMPLETED',
        args: { initiator: initiator.name || pId, partner: partner.name || tId }
      });
    }

    return tradeRecord;
  }

  cancelTrade(playerId = null) {
    if (!this.activeTrade) return false;
    const proposerId = this.activeTrade.proposerId || this.activeTrade.fromPlayerId;
    if (playerId && proposerId !== playerId) {
      throw new Error('NOT_YOUR_TRADE');
    }
    this.activeTrade = null;
    return true;
  }

  handlePlayerRemoval(playerId) {
    if (!this.activeTrade) return;
    const proposerId = this.activeTrade.proposerId || this.activeTrade.fromPlayerId;
    if (proposerId === playerId) {
      this.activeTrade = null;
    } else {
      if (this.activeTrade.responses) {
        delete this.activeTrade.responses[playerId];
      }
      this.activeTrade.acceptedBy?.delete(playerId);
      this.activeTrade.declinedBy?.delete(playerId);
    }
  }

  // --- Serialization & Cloning ---

  serializeActiveTrade() {
    if (!this.activeTrade) return null;
    return {
      id: this.activeTrade.id,
      proposerId: this.activeTrade.proposerId || this.activeTrade.fromPlayerId,
      fromPlayerId: this.activeTrade.fromPlayerId || this.activeTrade.proposerId,
      targetPlayerId: this.activeTrade.targetPlayerId || null,
      give: { ...this.activeTrade.give },
      want: { ...this.activeTrade.want },
      responses: { ...(this.activeTrade.responses || {}) },
      acceptedBy: Array.from(this.activeTrade.acceptedBy || []),
      declinedBy: Array.from(this.activeTrade.declinedBy || []),
      createdAt: this.activeTrade.createdAt
    };
  }

  serialize() {
    return {
      activeTrade: this.serializeActiveTrade(),
      lastTradeEvent: this.lastTradeEvent ? { ...this.lastTradeEvent } : null
    };
  }

  toJSON() {
    return this.serialize();
  }

  clone(engine = null) {
    const cloned = new TradeManager(engine || this.engine);
    if (this.activeTrade) {
      const proposerId = this.activeTrade.proposerId || this.activeTrade.fromPlayerId;
      cloned.activeTrade = {
        id: this.activeTrade.id,
        proposerId,
        fromPlayerId: proposerId,
        targetPlayerId: this.activeTrade.targetPlayerId || null,
        give: { ...this.activeTrade.give },
        want: { ...this.activeTrade.want },
        responses: { ...(this.activeTrade.responses || {}) },
        acceptedBy: new Set(this.activeTrade.acceptedBy || []),
        declinedBy: new Set(this.activeTrade.declinedBy || []),
        createdAt: this.activeTrade.createdAt
      };
    } else {
      cloned.activeTrade = null;
    }
    if (this.lastTradeEvent) {
      cloned.lastTradeEvent = { ...this.lastTradeEvent };
    }
    return cloned;
  }

  static deserialize(data, engine = null) {
    const manager = new TradeManager(engine);
    if (!data) return manager;
    const rawTrade = data.activeTrade !== undefined ? data.activeTrade : data;
    if (rawTrade && typeof rawTrade === 'object') {
      const proposerId = rawTrade.proposerId || rawTrade.fromPlayerId;
      manager.activeTrade = {
        id: rawTrade.id || `trade_${Date.now()}`,
        proposerId,
        fromPlayerId: proposerId,
        targetPlayerId: rawTrade.targetPlayerId || null,
        give: { ...(rawTrade.give || {}) },
        want: { ...(rawTrade.want || {}) },
        responses: { ...(rawTrade.responses || {}) },
        acceptedBy: new Set(rawTrade.acceptedBy || []),
        declinedBy: new Set(rawTrade.declinedBy || []),
        createdAt: rawTrade.createdAt || Date.now()
      };
    }
    if (data.lastTradeEvent) {
      manager.lastTradeEvent = { ...data.lastTradeEvent };
    }
    return manager;
  }

  static fromJSON(data, engine = null) {
    return TradeManager.deserialize(data, engine);
  }
}

export default TradeManager;
