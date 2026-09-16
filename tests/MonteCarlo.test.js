import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameEngine, GAME_PHASES, GAME_MODES } from '../server/game/GameEngine.js';
import { BotAI } from '../server/game/BotAI.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outDir = path.resolve(__dirname, '../scratch');

describe('Monte Carlo Simulation', () => {
  it('Simulates Base Game matches', function() {
    const count = 30;
    let completed = 0, errors = 0, deadlocks = 0, totalTurns = 0;
    for (let i = 0; i < count; i++) {
       // Mock or run small sim
       const engine = new GameEngine({
         roomId: 'sim-b-' + i,
         mode: GAME_MODES.BASE,
         vpTarget: 10
       });
       for (let p = 1; p <= 4; p++) {
         engine.addPlayer({ id: `bot${p}`, name: `Bot ${p}`, color: `#00000${p}`, isBot: true, botDifficulty: 'medium' });
       }
       engine.startGame('standard');
       
       let turns = 0;
       const maxIterations = 20000;
       let iterations = 0;
       let lastPhase = engine.phase;
       let samePhaseCount = 0;
       let failed = false;

       try {
         while (engine.phase !== GAME_PHASES.GAME_OVER) {
           iterations++;
           if (iterations > maxIterations) { deadlocks++; failed = true; break; }
           if (engine.phase === lastPhase) {
             samePhaseCount++;
             if (samePhaseCount > 500) { deadlocks++; failed = true; break; }
           } else { lastPhase = engine.phase; samePhaseCount = 0; }

           const curPlayer = engine.getCurrentPlayer();
           
           if (engine.pendingProgressDiscard && engine.pendingProgressDiscard.size) {
             for (const pId of Array.from(engine.pendingProgressDiscard)) {
               const p = engine.players.find(x => x.id === pId);
               const cardId = BotAI.decideProgressDiscard(p);
               if (cardId) engine.discardProgressCard(pId, cardId);
             }
             continue;
           }

           if (engine.pendingAqueductClaims && engine.pendingAqueductClaims.size) {
             BotAI.resolvePendingAqueductClaims(engine, { includeHumans: true });
           }

           if (engine.phase === GAME_PHASES.TURN_DISCARD) {
             for (const pId of Array.from(engine.pendingDiscards)) {
               const p = engine.players.find(x => x.id === pId);
               const dis = BotAI.decideDiscard(engine, p);
               engine.discardCards(pId, dis.discarded);
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_BARBARIAN_DOWNGRADE) {
             for (const pId of Array.from(engine.pendingBarbarianDowngrades)) {
               const p = engine.players.find(x => x.id === pId);
               const city = BotAI.chooseCityToDowngrade(engine, pId) || (engine.getFirstVulnerableCityId && engine.getFirstVulnerableCityId(p)) || p.citiesBuilt[0];
               if (city) engine.downgradeCity(pId, city);
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_BARBARIAN_REWARD) {
             for (const pId of Array.from(engine.pendingBarbarianTieDraws || [])) {
               const p = engine.players.find(x => x.id === pId);
               const deck = BotAI.chooseBarbarianRewardDeck(p);
               engine.chooseBarbarianReward(pId, deck);
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
             const chooserId = engine.pendingMetropolisChoice?.playerId || curPlayer?.id;
             const chooser = engine.players.find(p => p.id === chooserId);
             if (chooser) {
                const city = BotAI.chooseCityForMetropolis(engine, chooserId) || (engine.getFirstVulnerableCityId && engine.getFirstVulnerableCityId(chooser));
                if (city) engine.chooseMetropolis(chooserId, city);
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) {
              engine.autoResolveKnightRelocation();
              continue;
           }

           if (engine.phase === GAME_PHASES.TURN_CHOOSE_PROGRESS_RESPONSE) {
             const pending = engine.pendingProgressChoice;
             if (pending) {
               for (const pId of Array.from(pending.pending)) {
                 engine.autoResolveProgressChoice(pId);
               }
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_CHOOSE_DESERTER_KNIGHT) {
              engine.autoResolveDeserterKnight();
              continue;
           }

           if (engine.phase === GAME_PHASES.TURN_PLACE_DESERTER_KNIGHT) {
              engine.autoResolveDeserterPlacement();
              continue;
           }

           if (!curPlayer) { errors++; failed = true; break; }

           if (engine.phase === GAME_PHASES.SETUP_ROUND_1 || engine.phase === GAME_PHASES.SETUP_ROUND_2) {
             const setupAction = BotAI.decideSetupAction(engine, curPlayer);
             if (setupAction) {
               if (setupAction.action === 'place_setup_settlement') {
                 engine.placeSetupSettlement(curPlayer.id, setupAction.vertexId);
               } else if (setupAction.action === 'place_setup_road') {
                 engine.placeSetupRoad(curPlayer.id, setupAction.edgeId);
               }
             } else {
                engine.endTurn(curPlayer.id);
             }
           } else if (engine.phase === GAME_PHASES.TURN_ROLL) {
             turns++;
             const alchemist = BotAI.decideProgressCardPlay(engine, curPlayer);
             if (alchemist?.action === 'play_progress_card') {
               engine.playProgressCard(curPlayer.id, alchemist.cardId, alchemist.options);
             }
             engine.rollDice(curPlayer.id);
           } else if (engine.phase === GAME_PHASES.TURN_ROBBER) {
             const robAction = BotAI.decideRobberMove(engine, curPlayer);
             engine.moveRobber(curPlayer.id, robAction.hexId, robAction.targetPlayerId);
           } else if (engine.phase === GAME_PHASES.TURN_ACTION || engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
             const action = BotAI.decideTurnAction(engine, curPlayer);
             if (action.action === 'end_turn') {
               engine.endTurn(curPlayer.id);
             } else {
               BotAI.applyTurnAction(engine, curPlayer, action);
             }
           }
         }
       } catch (e) {
         errors++;
         failed = true;
       }
       if (!failed) {
         completed++;
         totalTurns += turns;
       }
    }
    try {
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'sim-results-base.json'), JSON.stringify({ mode: 'base', completed, errors, deadlocks, totalTurns, count }));
    } catch {}
  });

  it('Simulates C&K Matches', function() {
    const count = 30;
    let completed = 0, errors = 0, deadlocks = 0, totalTurns = 0;
    for (let i = 0; i < count; i++) {
       const engine = new GameEngine({
         roomId: 'sim-ck-' + i,
         mode: GAME_MODES.CITIES_KNIGHTS,
         vpTarget: 13
       });
       for (let p = 1; p <= 4; p++) {
         engine.addPlayer({ id: `bot${p}`, name: `Bot ${p}`, color: `#00000${p}`, isBot: true, botDifficulty: 'medium' });
       }
       engine.startGame('standard');
       
       let turns = 0;
       const maxIterations = 20000;
       let iterations = 0;
       let lastPhase = engine.phase;
       let samePhaseCount = 0;
       let failed = false;

       try {
         while (engine.phase !== GAME_PHASES.GAME_OVER) {
           iterations++;
           if (iterations > maxIterations) { deadlocks++; failed = true; break; }
           if (engine.phase === lastPhase) {
             samePhaseCount++;
             if (samePhaseCount > 500) { deadlocks++; failed = true; break; }
           } else { lastPhase = engine.phase; samePhaseCount = 0; }

           const curPlayer = engine.getCurrentPlayer();
           
           if (engine.pendingProgressDiscard && engine.pendingProgressDiscard.size) {
             for (const pId of Array.from(engine.pendingProgressDiscard)) {
               const p = engine.players.find(x => x.id === pId);
               const cardId = BotAI.decideProgressDiscard(p);
               if (cardId) engine.discardProgressCard(pId, cardId);
             }
             continue;
           }

           if (engine.pendingAqueductClaims && engine.pendingAqueductClaims.size) {
             BotAI.resolvePendingAqueductClaims(engine, { includeHumans: true });
           }

           if (engine.phase === GAME_PHASES.TURN_DISCARD) {
             for (const pId of Array.from(engine.pendingDiscards)) {
               const p = engine.players.find(x => x.id === pId);
               const dis = BotAI.decideDiscard(engine, p);
               engine.discardCards(pId, dis.discarded);
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_BARBARIAN_DOWNGRADE) {
             for (const pId of Array.from(engine.pendingBarbarianDowngrades)) {
               const p = engine.players.find(x => x.id === pId);
               const city = BotAI.chooseCityToDowngrade(engine, pId) || (engine.getFirstVulnerableCityId && engine.getFirstVulnerableCityId(p)) || p.citiesBuilt[0];
               if (city) engine.downgradeCity(pId, city);
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_BARBARIAN_REWARD) {
             for (const pId of Array.from(engine.pendingBarbarianTieDraws || [])) {
               const p = engine.players.find(x => x.id === pId);
               const deck = BotAI.chooseBarbarianRewardDeck(p);
               engine.chooseBarbarianReward(pId, deck);
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
             const chooserId = engine.pendingMetropolisChoice?.playerId || curPlayer?.id;
             const chooser = engine.players.find(p => p.id === chooserId);
             if (chooser) {
                const city = BotAI.chooseCityForMetropolis(engine, chooserId) || (engine.getFirstVulnerableCityId && engine.getFirstVulnerableCityId(chooser));
                if (city) engine.chooseMetropolis(chooserId, city);
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) {
              engine.autoResolveKnightRelocation();
              continue;
           }

           if (engine.phase === GAME_PHASES.TURN_CHOOSE_PROGRESS_RESPONSE) {
             const pending = engine.pendingProgressChoice;
             if (pending) {
               for (const pId of Array.from(pending.pending)) {
                 engine.autoResolveProgressChoice(pId);
               }
             }
             continue;
           }

           if (engine.phase === GAME_PHASES.TURN_CHOOSE_DESERTER_KNIGHT) {
              engine.autoResolveDeserterKnight();
              continue;
           }

           if (engine.phase === GAME_PHASES.TURN_PLACE_DESERTER_KNIGHT) {
              engine.autoResolveDeserterPlacement();
              continue;
           }

           if (!curPlayer) { errors++; failed = true; break; }

           if (engine.phase === GAME_PHASES.SETUP_ROUND_1 || engine.phase === GAME_PHASES.SETUP_ROUND_2) {
             const setupAction = BotAI.decideSetupAction(engine, curPlayer);
             if (setupAction) {
               if (setupAction.action === 'place_setup_settlement') {
                 engine.placeSetupSettlement(curPlayer.id, setupAction.vertexId);
               } else if (setupAction.action === 'place_setup_road') {
                 engine.placeSetupRoad(curPlayer.id, setupAction.edgeId);
               }
             } else {
                engine.endTurn(curPlayer.id);
             }
           } else if (engine.phase === GAME_PHASES.TURN_ROLL) {
             turns++;
             const alchemist = BotAI.decideProgressCardPlay(engine, curPlayer);
             if (alchemist?.action === 'play_progress_card') {
               engine.playProgressCard(curPlayer.id, alchemist.cardId, alchemist.options);
             }
             engine.rollDice(curPlayer.id);
           } else if (engine.phase === GAME_PHASES.TURN_ROBBER) {
             const robAction = BotAI.decideRobberMove(engine, curPlayer);
             engine.moveRobber(curPlayer.id, robAction.hexId, robAction.targetPlayerId);
           } else if (engine.phase === GAME_PHASES.TURN_ACTION || engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
             const action = BotAI.decideTurnAction(engine, curPlayer);
             if (action.action === 'end_turn') {
               engine.endTurn(curPlayer.id);
             } else {
               BotAI.applyTurnAction(engine, curPlayer, action);
             }
           }
         }
       } catch (e) {
         errors++;
         failed = true;
       }
       if (!failed) {
         completed++;
         totalTurns += turns;
       }
    }
    try {
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'sim-results-ck.json'), JSON.stringify({ mode: 'ck', completed, errors, deadlocks, totalTurns, count }));
    } catch {}
  });
});
