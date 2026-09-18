/**
 * CitiesKnightsModule.js
 * Pluggable expansion module for Cities & Knights rules and mechanics (ARCH-03).
 * Encapsulates:
 * - Barbarian voyage tracks, attacks, city downgrades, and defender card rewards.
 * - City improvement tracks (Trade, Politics, Science), costs, perks, and Metropolis claims.
 * - Knight unit lifecycle: recruitment, activation, promotion, movement, displacement, and robber chasing.
 * - Progress card decks (shuffling, draws, hand limits, recycling).
 * - Lifecycle hooks: onDiceRoll, onTurnEnd, onBuildingUpgraded.
 */

import {
  GAME_PHASES,
  COSTS,
  KNIGHT_RANKS,
  IMPROVEMENT_TRACKS,
  PROGRESS_CARD_DECKS,
  PROGRESS_CARD_HAND_LIMIT,
  PROGRESS_CARD_TYPE_TO_DECK,
  BARBARIAN_TRACK_MAX
} from './GameEngine.js';

const PROGRESS_VP_CARD_TYPES = new Set(['constitution', 'printer']);

export class CitiesKnightsModule {
  constructor(engine) {
    this.engine = engine;
  }

  /* =========================================================
   * PROGRESS CARD DECKS & DRAWS
   * ========================================================= */

  initProgressCardDecks() {
    this.engine.progressDecks = { trade: [], politics: [], science: [] };
    for (const [deck, cards] of Object.entries(PROGRESS_CARD_DECKS)) {
      for (const card of cards) {
        for (let i = 0; i < card.count; i++) {
          this.engine.progressDecks[deck].push({ type: card.type, id: `${deck}-${card.type}-${i}` });
        }
      }
      this.engine.shuffle(this.engine.progressDecks[deck]);
    }
  }

  progressCardDeckName(card) {
    return card?.track || PROGRESS_CARD_TYPE_TO_DECK[card?.type] || null;
  }

  placeProgressCardUnderDeck(card) {
    const track = this.progressCardDeckName(card);
    if (!track || !Array.isArray(this.engine.progressDecks?.[track])) return;
    this.engine.progressDecks[track].unshift({ id: card.id, type: card.type });
  }

  drawProgressCard(player, track) {
    const deck = this.engine.progressDecks?.[track];
    if (!deck || deck.length === 0) return null;
    const card = deck.pop();
    const type = card.type || card;
    const isVp = PROGRESS_VP_CARD_TYPES.has(type);
    player.progressCards.push({
      id: card.id || `prog_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type,
      track,
      played: isVp,
      revealed: isVp,
      boughtTurn: this.engine.turnNumber
    });
    if (isVp) {
      this.engine.recalculateVictoryPoints();
    }
    if (this.countUnplayedProgressCards(player) > PROGRESS_CARD_HAND_LIMIT) {
      this.engine.pendingProgressDiscard.add(player.id);
    }
    return type;
  }

  discardProgressCard(playerId, cardId) {
    const player = this.engine.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    if (!this.engine.pendingProgressDiscard.has(playerId)) throw new Error('NO_PROGRESS_DISCARD_NEEDED');
    const idx = player.progressCards.findIndex(c => c.id === cardId && !c.played);
    if (idx === -1) throw new Error('CARD_NOT_FOUND');
    const [discarded] = player.progressCards.splice(idx, 1);
    this.placeProgressCardUnderDeck(discarded);
    if (this.countUnplayedProgressCards(player) <= PROGRESS_CARD_HAND_LIMIT) {
      this.engine.pendingProgressDiscard.delete(playerId);
    }
    return { remaining: this.countUnplayedProgressCards(player) };
  }

  countUnplayedProgressCards(player) {
    return (player?.progressCards || []).filter(c => !c.played).length;
  }

  distributeProgressCardDraws(track, redDie) {
    const eligible = this.engine.getProgressCardEligiblePlayers(track, redDie);
    this.engine.pendingProgressDraws = eligible.map(p => {
      const drawn = this.drawProgressCard(p, track);
      return { playerId: p.id, track, drawn: Boolean(drawn), cardType: drawn };
    });
    if (eligible.length) {
      this.engine.logEvent({
        type: 'PROGRESS_CARD_CHECK',
        messageKey: 'LOG_PROGRESS_CARD_CHECK',
        args: { track, redDie, playerIds: eligible.map(p => p.id) }
      });
    }
  }

  /* =========================================================
   * CITY IMPROVEMENTS & METROPOLISES
   * ========================================================= */

  improveCityTrack(playerId, track) {
    const player = this.engine.assertBuildTurn(playerId);
    if (!IMPROVEMENT_TRACKS[track]) throw new Error('INVALID_IMPROVEMENT_TRACK');
    if (!player.citiesBuilt.length) throw new Error('NEED_CITY_TO_IMPROVE');

    const currentLevel = player.cityImprovements[track] || 0;
    if (currentLevel >= 5) throw new Error('IMPROVEMENT_MAX_LEVEL');

    let cost = currentLevel + 1;
    if (player.craneDiscount) {
      cost = Math.max(0, cost - 1);
      player.craneDiscount = false;
    }
    const commodity = IMPROVEMENT_TRACKS[track];
    if ((player.commodities[commodity] || 0) < cost) throw new Error('NOT_ENOUGH_COMMODITIES');

    player.commodities[commodity] -= cost;
    player.cityImprovements[track] = currentLevel + 1;
    const newLevel = player.cityImprovements[track];

    this.engine.logEvent({
      type: 'CITY_IMPROVED',
      messageKey: 'LOG_CITY_IMPROVED',
      args: { playerName: player.name, track, level: newLevel }
    });

    if (newLevel === 3) {
      this.drawProgressCard(player, track);
    }

    this.checkMetropolisAward(playerId, track, newLevel);

    return { track, level: newLevel, cost };
  }

  checkMetropolisAward(playerId, track, newLevel) {
    if (newLevel < 4) return;
    const currentHolder = this.engine.metropolises[track];

    const player = this.engine.players.find(p => p.id === playerId);
    if (!this.getFirstVulnerableCityId(player)) return;

    if (!currentHolder) {
      this.beginMetropolisChoice(playerId, track);
      return;
    }

    if (currentHolder.playerId === playerId) return;
    if (newLevel !== 5) return;

    const holderPlayer = this.engine.players.find(p => p.id === currentHolder.playerId);
    const holderLevel = holderPlayer?.cityImprovements?.[track] || 0;
    if (holderLevel >= 5) return;

    const holderVertex = this.engine.grid.vertices.get(currentHolder.vertexId);
    if (holderVertex?.building?.type === 'metropolis' && holderVertex.building.metropolisTrack === track) {
      holderVertex.building.type = 'city';
      holderVertex.building.hasMetropolis = false;
      holderVertex.building.metropolisTrack = null;
    }
    if (holderPlayer?.metropolis) holderPlayer.metropolis[track] = false;
    this.engine.metropolises[track] = null;
    this.beginMetropolisChoice(playerId, track);
  }

  beginMetropolisChoice(playerId, track) {
    this.engine.pendingMetropolisChoice = { playerId, track };
    this.engine.previousPhase = this.engine.phase;
    this.engine.phase = GAME_PHASES.TURN_CHOOSE_METROPOLIS;
  }

  chooseMetropolis(playerId, vertexId) {
    if (this.engine.phase !== GAME_PHASES.TURN_CHOOSE_METROPOLIS) throw new Error('NOT_IN_METROPOLIS_PHASE');
    if (!this.engine.pendingMetropolisChoice || this.engine.pendingMetropolisChoice.playerId !== playerId) {
      throw new Error('NOT_YOUR_CHOICE');
    }

    const vertex = this.engine.grid.vertices.get(vertexId);
    const building = vertex?.building;
    if (building?.playerId === playerId && (building.hasMetropolis || building.type === 'metropolis')) {
      throw new Error('CITY_ALREADY_HAS_METROPOLIS');
    }
    if (!building || building.type !== 'city' || building.playerId !== playerId) {
      throw new Error('MUST_CHOOSE_YOUR_CITY: MUST_CHOOSE_OWN_CITY');
    }

    const track = this.engine.pendingMetropolisChoice.track;
    vertex.building.type = 'metropolis';
    vertex.building.hasMetropolis = true;
    vertex.building.metropolisTrack = track;
    this.engine.metropolises[track] = { playerId, vertexId };

    const player = this.engine.players.find(p => p.id === playerId);
    if (player?.metropolis) player.metropolis[track] = true;

    this.engine.pendingMetropolisChoice = null;
    this.engine.phase = this.engine.previousPhase || GAME_PHASES.TURN_ACTION;
    this.engine.previousPhase = null;

    this.engine.recalculateVictoryPoints();
    this.engine.checkVictory();

    this.engine.logEvent({
      type: 'METROPOLIS_AWARDED',
      messageKey: 'LOG_METROPOLIS',
      args: { playerName: player?.name, track }
    });

    return { track, vertexId };
  }

  getFirstVulnerableCityId(player) {
    return (player?.citiesBuilt || []).find(id => {
      const b = this.engine.grid.vertices.get(id)?.building;
      return b && b.type === 'city' && !b.hasMetropolis;
    }) || null;
  }

  hasVulnerableCity(player) {
    return Boolean(this.getFirstVulnerableCityId(player));
  }

  /* =========================================================
   * KNIGHTS UNIT LIFECYCLE
   * ========================================================= */

  getActiveKnightStrength(player) {
    return (player?.knightsPlaced || []).reduce((sum, k) => sum + (k.active ? k.strength : 0), 0);
  }

  placeKnight(playerId, vertexId) {
    const player = this.engine.assertCkAction(playerId);
    const vertex = this.engine.grid.vertices.get(vertexId);
    if (!vertex) throw new Error('INVALID_VERTEX');
    if (vertex.building || vertex.knight) throw new Error('VERTEX_OCCUPIED');
    if (!this.engine.vertexHasPlayerRoad(vertex, playerId)) throw new Error('MUST_CONNECT_TO_ROAD');
    if ((player.knightsAvailable.basic || 0) <= 0) throw new Error('NO_KNIGHTS_AVAILABLE');
    if (!this.engine.hasResources(player, COSTS.KNIGHT)) throw new Error('NOT_ENOUGH_RESOURCES');

    this.engine.deductResources(player, COSTS.KNIGHT);
    player.knightsAvailable.basic--;
    const knight = {
      playerId,
      vertexId,
      rank: 'basic',
      active: false,
      strength: KNIGHT_RANKS.basic.strength,
      hiredTurn: this.engine.turnNumber,
      lastActionTurn: null
    };
    vertex.knight = knight;
    player.knightsPlaced.push(knight);

    this.engine.logEvent({
      type: 'KNIGHT_PLACED',
      messageKey: 'LOG_KNIGHT_PLACED',
      args: { playerName: player.name }
    });
    return { vertexId, knight };
  }

  recruitKnight(playerId, vertexId) {
    return this.placeKnight(playerId, vertexId);
  }

  activateKnight(playerId, vertexId) {
    const player = this.engine.assertCkAction(playerId);
    const knight = this.engine.getKnightRecord(player, vertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    this.engine.assertKnightCanPerformAction(knight);
    if (knight.active) throw new Error('KNIGHT_ALREADY_ACTIVE');
    if (!this.engine.hasResources(player, COSTS.ACTIVATE_KNIGHT)) throw new Error('NOT_ENOUGH_RESOURCES');

    this.engine.deductResources(player, COSTS.ACTIVATE_KNIGHT);
    knight.active = true;
    knight.lastActionTurn = this.engine.turnNumber;

    this.engine.logEvent({
      type: 'KNIGHT_ACTIVATED',
      messageKey: 'LOG_KNIGHT_ACTIVATED',
      args: { playerName: player.name }
    });
    return { vertexId, knight };
  }

  promoteKnight(playerId, vertexId, options = {}) {
    const player = this.engine.assertCkAction(playerId);
    const knight = this.engine.getKnightRecord(player, vertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    const current = KNIGHT_RANKS[knight.rank];
    if (!current?.next) throw new Error('KNIGHT_MAX_RANK');
    const nextRank = current.next;
    const next = KNIGHT_RANKS[nextRank];
    if ((player.cityImprovements.politics || 0) < next.politicsRequired) {
      throw new Error('POLITICS_LEVEL_TOO_LOW');
    }
    if ((player.knightsAvailable[nextRank] || 0) <= 0) throw new Error('NO_KNIGHTS_AVAILABLE');
    if (!this.engine.hasResources(player, COSTS.PROMOTE_KNIGHT) && !options.free) throw new Error('NOT_ENOUGH_RESOURCES');

    if (!options.free) this.engine.deductResources(player, COSTS.PROMOTE_KNIGHT);
    player.knightsAvailable[knight.rank] = (player.knightsAvailable[knight.rank] || 0) + 1;
    player.knightsAvailable[nextRank]--;
    knight.rank = nextRank;
    knight.strength = next.strength;

    this.engine.logEvent({
      type: 'KNIGHT_PROMOTED',
      messageKey: 'LOG_KNIGHT_PROMOTED',
      args: { playerName: player.name, rank: nextRank }
    });
    return { vertexId, knight };
  }

  moveKnight(playerId, fromVertexId, toVertexId) {
    const player = this.engine.assertCkAction(playerId, { allowSpecialBuilding: false });
    const knight = this.engine.getKnightRecord(player, fromVertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    this.engine.assertKnightCanPerformAction(knight);
    if (!knight.active) throw new Error('KNIGHT_NOT_ACTIVE');
    if (fromVertexId === toVertexId) throw new Error('INVALID_KNIGHT_MOVE');

    const dest = this.engine.grid.vertices.get(toVertexId);
    if (!dest) throw new Error('INVALID_VERTEX');
    if (dest.building) throw new Error('VERTEX_OCCUPIED');
    if (dest.knight) {
      if (dest.knight.playerId === playerId) throw new Error('VERTEX_OCCUPIED');
      if (dest.knight.strength >= knight.strength) throw new Error('CANNOT_DISPLACE_EQUAL_OR_STRONGER');
    }

    const reachable = this.engine.listKnightMoveDestinations(playerId, fromVertexId, knight.strength);
    if (!reachable.includes(toVertexId)) {
      throw new Error(
        this.engine.verticesSharePlayerRoad(fromVertexId, toVertexId, playerId)
          ? 'INVALID_KNIGHT_MOVE'
          : 'MUST_MOVE_ALONG_OWN_ROAD'
      );
    }

    const from = this.engine.grid.vertices.get(fromVertexId);
    if (from) from.knight = null;

    let displaced = null;
    if (dest.knight) {
      displaced = this.displaceKnight(dest.knight, toVertexId, fromVertexId);
    }

    knight.vertexId = toVertexId;
    knight.active = false;
    knight.lastActionTurn = this.engine.turnNumber;
    dest.knight = knight;

    this.engine.logEvent({
      type: 'KNIGHT_MOVED',
      messageKey: 'LOG_KNIGHT_MOVED',
      args: { playerName: player.name }
    });
    return { fromVertexId, toVertexId, knight, displaced };
  }

  displaceKnight(victimKnight, fromVertexId, attackerFromId) {
    const owner = this.engine.players.find(p => p.id === victimKnight.playerId);
    const vacated = this.engine.grid.vertices.get(fromVertexId);
    if (vacated && vacated.knight === victimKnight) vacated.knight = null;

    victimKnight.vertexId = null;

    const options = owner
      ? this.engine.listKnightRelocations(owner.id, fromVertexId, [attackerFromId])
      : [];

    if (!owner || options.length === 0) {
      if (owner) this.engine.returnKnightToSupply(owner, victimKnight);
      return { playerId: victimKnight.playerId, vertexId: null, removed: true, pending: false, options: [] };
    }

    this.engine.pendingKnightRelocation = {
      playerId: owner.id,
      options,
      fromVertexId,
      attackerFromId
    };
    this.engine.previousPhase = this.engine.phase;
    this.engine.phase = GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE;
    return { playerId: owner.id, vertexId: null, removed: false, pending: true, options };
  }

  relocateDisplacedKnight(playerId, vertexId) {
    if (this.engine.phase !== GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) throw new Error('NOT_IN_KNIGHT_RELOCATE_PHASE');
    const pending = this.engine.pendingKnightRelocation;
    if (!pending || pending.playerId !== playerId) throw new Error('NOT_YOUR_CHOICE');
    if (!pending.options.includes(vertexId)) throw new Error('INVALID_RELOCATION');

    const owner = this.engine.players.find(p => p.id === playerId);
    const knight = owner?.knightsPlaced.find(k => k.vertexId == null);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');

    const dest = this.engine.grid.vertices.get(vertexId);
    if (!dest || dest.building || dest.knight) throw new Error('VERTEX_OCCUPIED');

    knight.vertexId = vertexId;
    dest.knight = knight;

    this.engine.pendingKnightRelocation = null;
    this.engine.phase = this.engine.previousPhase || GAME_PHASES.TURN_ACTION;
    this.engine.previousPhase = null;

    this.engine.logEvent({
      type: 'KNIGHT_RELOCATED',
      messageKey: 'LOG_KNIGHT_RELOCATED',
      args: { playerName: owner.name }
    });
    return { vertexId, knight };
  }

  chaseRobber(playerId, vertexId, hexId, targetPlayerId = null) {
    const player = this.engine.assertCkAction(playerId, { allowSpecialBuilding: false });
    if (!this.engine.isRobberInPlay()) throw new Error('ROBBER_NOT_IN_PLAY');
    const knight = this.engine.getKnightRecord(player, vertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    this.engine.assertKnightCanPerformAction(knight);
    if (!knight.active) throw new Error('KNIGHT_NOT_ACTIVE');
    const vertex = this.engine.grid.vertices.get(vertexId);
    if (!vertex || !vertex.hexes.includes(this.engine.grid.robberHexId)) {
      throw new Error('KNIGHT_NOT_ADJACENT_TO_ROBBER');
    }
    if (hexId === this.engine.grid.robberHexId) throw new Error('MUST_MOVE_ROBBER_TO_NEW_HEX');
    if (!this.engine.grid.hexes.has(hexId)) throw new Error('INVALID_HEX');

    const victims = this.engine.getRobberStealVictims(hexId, playerId);
    let target = null;
    if (victims.length > 0) {
      target = victims.find((p) => p.id === targetPlayerId);
      if (!target) throw new Error('STEAL_TARGET_REQUIRED');
    }

    this.engine.grid.robberHexId = hexId;
    let stolenResource = null;
    if (target) {
      stolenResource = this.engine.stealRandomCard(player, target);
    }
    knight.active = false;
    knight.lastActionTurn = this.engine.turnNumber;

    this.engine.logEvent({
      ...this.engine.buildRobberMovedLog(player.name, hexId),
      type: 'KNIGHT_CHASED_ROBBER'
    });
    return { vertexId, hexId, stolenFrom: targetPlayerId, stolenResource };
  }

  /* =========================================================
   * BARBARIAN ATTACK TRACKER & RESOLUTION
   * ========================================================= */

  advanceBarbarianPosition(steps = 1) {
    this.engine.barbarianPosition = Math.min(BARBARIAN_TRACK_MAX, this.engine.barbarianPosition + steps);
    this.engine.logEvent({
      type: 'BARBARIAN_ADVANCED',
      messageKey: 'LOG_BARBARIAN_ADVANCED',
      args: { position: this.engine.barbarianPosition }
    });
    return this.engine.barbarianPosition;
  }

  resolveBarbarianAttack() {
    this.engine.phase = GAME_PHASES.TURN_BARBARIAN_RESOLVE;
    const totalCities = this.engine.players.reduce((sum, p) => sum + p.citiesBuilt.length, 0);
    const strengths = this.engine.players.map(p => ({
      player: p,
      strength: this.getActiveKnightStrength(p)
    }));
    const totalActiveKnights = strengths.reduce((sum, row) => sum + row.strength, 0);
    const victory = totalActiveKnights >= totalCities;

    let result;
    if (victory) {
      const maxStrength = Math.max(0, ...strengths.map(row => row.strength));
      const leaders = strengths.filter(row => row.strength === maxStrength && maxStrength > 0);
      if (leaders.length === 1) {
        leaders[0].player.defenderCards = (leaders[0].player.defenderCards || 0) + 1;
        this.engine.defenderOfCatan = leaders[0].player.id;
        this.engine.recalculateVictoryPoints();
        this.engine.logEvent({
          type: 'BARBARIAN_VICTORY',
          messageKey: 'LOG_BARBARIAN_VICTORY',
          args: { playerName: leaders[0].player.name }
        });
      } else if (leaders.length > 1) {
        this.engine.pendingBarbarianTieDraws = new Set(leaders.map(l => l.player.id));
        this.engine.logEvent({
          type: 'BARBARIAN_VICTORY_TIE',
          messageKey: 'LOG_BARBARIAN_VICTORY_TIE',
          args: {}
        });
      }
      this.engine.pendingBarbarianDowngrades.clear();
      result = {
        id: `barb-${this.engine.turnNumber}-${this.engine.eventLog.length}`,
        outcome: 'victory',
        defenderOfCatan: this.engine.defenderOfCatan,
        totalActiveKnights,
        totalCities,
        pendingTieDraws: Array.from(this.engine.pendingBarbarianTieDraws)
      };
    } else {
      const cityOwners = strengths.filter(row => this.hasVulnerableCity(row.player));
      const minStrength = cityOwners.length
        ? Math.min(...cityOwners.map(row => row.strength))
        : 0;
      this.engine.pendingBarbarianDowngrades = new Set(
        cityOwners.filter(row => row.strength === minStrength).map(row => row.player.id)
      );
      this.engine.logEvent({
        type: 'BARBARIAN_DEFEAT',
        messageKey: 'LOG_BARBARIAN_DEFEAT',
        args: { playerIds: Array.from(this.engine.pendingBarbarianDowngrades) }
      });
      result = {
        id: `barb-${this.engine.turnNumber}-${this.engine.eventLog.length}`,
        outcome: 'defeat',
        pendingDowngrades: Array.from(this.engine.pendingBarbarianDowngrades),
        totalActiveKnights,
        totalCities
      };
    }

    for (const p of this.engine.players) {
      for (const k of p.knightsPlaced) k.active = false;
    }
    this.engine.barbarianPosition = 0;
    this.engine.lastBarbarianResult = result;
    this.engine.barbariansHaveAttacked = true;

    if (result.outcome === 'defeat' && this.engine.pendingBarbarianDowngrades.size > 0) {
      this.engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    } else if (result.outcome === 'victory' && this.engine.pendingBarbarianTieDraws.size > 0) {
      this.engine.phase = GAME_PHASES.TURN_BARBARIAN_REWARD;
    } else {
      this.continueAfterBarbarian();
    }
    this.engine.checkVictory();
    return result;
  }

  continueAfterBarbarian() {
    if (this.engine.pendingProductionRoll != null) {
      this.engine.resolveDiceProduction(this.engine.pendingProductionRoll);
      this.engine.pendingProductionRoll = null;
    }
    const next = this.engine.postBarbarianPhase || GAME_PHASES.TURN_ACTION;
    this.engine.postBarbarianPhase = null;
    if (next === GAME_PHASES.TURN_DISCARD || next === GAME_PHASES.TURN_ROBBER) {
      this.engine.enterRobberFlow();
    } else {
      this.engine.phase = next;
    }
  }

  downgradeCity(playerId, vertexId) {
    if (this.engine.phase !== GAME_PHASES.TURN_BARBARIAN_DOWNGRADE) throw new Error('NOT_IN_BARBARIAN_DOWNGRADE');
    if (!this.engine.pendingBarbarianDowngrades.has(playerId)) throw new Error('NO_DOWNGRADE_NEEDED');
    const player = this.engine.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    const vertex = this.engine.grid.vertices.get(vertexId);
    if (vertex?.building?.type === 'metropolis' || vertex?.building?.hasMetropolis) {
      throw new Error('CANNOT_DOWNGRADE_METROPOLIS: METROPOLIS_PROTECTED');
    }
    if (!vertex?.building || vertex.building.type !== 'city' || vertex.building.playerId !== playerId) {
      throw new Error('MUST_DOWNGRADE_OWN_CITY');
    }

    if (vertex.building.hasWall) {
      vertex.building.hasWall = false;
      player.cityWalls = (player.cityWalls || 0) + 1;
    }
    const cityIndex = player.citiesBuilt.indexOf(vertexId);
    if (cityIndex !== -1) player.citiesBuilt.splice(cityIndex, 1);
    player.citiesRemaining++;

    if (player.settlementsRemaining > 0) {
      vertex.building.type = 'settlement';
      player.settlementsBuilt.push(vertexId);
      player.settlementsRemaining--;
    } else {
      vertex.building.type = 'settlement';
      vertex.building.isCityOnSide = true;
      player.settlementsBuilt.push(vertexId);
    }

    this.engine.pendingBarbarianDowngrades.delete(playerId);
    this.engine.recalculateVictoryPoints();
    this.engine.logEvent({
      type: 'CITY_DOWNGRADED',
      messageKey: 'LOG_CITY_DOWNGRADED',
      args: { playerName: player.name }
    });

    if (this.engine.pendingBarbarianDowngrades.size === 0) {
      this.continueAfterBarbarian();
    }
    return { vertexId, remaining: Array.from(this.engine.pendingBarbarianDowngrades) };
  }

  chooseBarbarianReward(playerId, deck) {
    if (this.engine.phase !== GAME_PHASES.TURN_BARBARIAN_REWARD) {
      throw new Error('NOT_IN_BARBARIAN_REWARD_PHASE');
    }
    if (!this.engine.pendingBarbarianTieDraws || !this.engine.pendingBarbarianTieDraws.has(playerId)) {
      throw new Error('NO_BARBARIAN_REWARD_PENDING');
    }
    const validDecks = ['trade', 'politics', 'science'];
    if (!validDecks.includes(deck)) {
      throw new Error('INVALID_PROGRESS_DECK');
    }
    const player = this.engine.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');

    const cardType = this.drawProgressCard(player, deck);
    this.engine.pendingBarbarianTieDraws.delete(playerId);

    this.engine.logEvent({
      type: 'BARBARIAN_REWARD_CHOSEN',
      messageKey: 'LOG_BARBARIAN_REWARD_CHOSEN',
      args: { playerName: player.name, deck }
    });

    if (this.engine.pendingBarbarianTieDraws.size === 0) {
      this.continueAfterBarbarian();
    }
    return { deck, cardType, remaining: Array.from(this.engine.pendingBarbarianTieDraws) };
  }

  /* =========================================================
   * LIFECYCLE HOOKS (ARCH-03)
   * ========================================================= */

  onDiceRoll(redDie, yellowDie, eventDie) {
    if (eventDie === 'barbarian') {
      this.advanceBarbarianPosition(1);
    } else if (eventDie) {
      this.engine.pendingProgressCardColor = eventDie;
    }
  }

  onTurnEnd(player) {
    if (this.engine.pendingProgressDiscard?.has(player.id) || this.countUnplayedProgressCards(player) > PROGRESS_CARD_HAND_LIMIT) {
      if (this.engine.pendingProgressDiscard) {
        this.engine.pendingProgressDiscard.add(player.id);
      }
      throw new Error('MUST_DISCARD_PROGRESS_CARD_BEFORE_ENDING_TURN');
    }
  }

  onBuildingUpgraded(player, vertexId, newType) {
    if (newType === 'city') {
      // Metropolis or victory point recheck
      this.engine.recalculateVictoryPoints();
    }
  }
}
