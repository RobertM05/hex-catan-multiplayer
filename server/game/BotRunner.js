/**
 * BotRunner.js
 * In-process, non-blocking bot runner using BotAI directly.
 * Replaces heavy OS child_process.fork() with lightweight in-memory execution.
 */

import { BotAI } from './BotAI.js';
import { GAME_PHASES } from './GameEngine.js';

export const BOT_TURN_DELAY_MS = 600;
export const BOT_DISCARD_DELAY_MS = 300;

export class InProcessBotRunner {
  constructor({ minDelayMs = 300, maxDelayMs = 800 } = {}) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  getThinkingDelay() {
    return Math.floor(this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs));
  }

  /**
   * Schedule a bot action asynchronously to simulate human thinking delay.
   */
  scheduleAction(room, delayMs, playerId, callback) {
    if (!room) return null;
    const effectiveDelay = delayMs != null ? delayMs : this.getThinkingDelay();

    if (!room.botActionTimers) room.botActionTimers = new Map();

    const timer = setTimeout(() => {
      if (room.botActionTimers) room.botActionTimers.delete(timer);
      if (room.engine?.phase === GAME_PHASES.GAME_OVER) return;

      const player = room.players?.find(p => p.id === playerId);
      const isBotAllowed = Boolean(player?.isBot || player?.isStandInBot);
      if (!isBotAllowed) return;

      try {
        callback();
      } catch (err) {
        console.error(`[InProcessBotRunner] Error executing action for ${playerId}:`, err);
      }
    }, effectiveDelay);

    if (typeof timer.unref === 'function') timer.unref();
    room.botActionTimers.set(timer, playerId);
    return timer;
  }

  clearTimersForPlayer(room, playerId) {
    if (!room?.botActionTimers) return;
    for (const [timer, pid] of room.botActionTimers.entries()) {
      if (pid === playerId) {
        clearTimeout(timer);
        room.botActionTimers.delete(timer);
      }
    }
  }

  clearAllTimers(room) {
    if (!room?.botActionTimers) return;
    for (const timer of room.botActionTimers.keys()) {
      clearTimeout(timer);
    }
    room.botActionTimers.clear();
  }

  /**
   * Evaluates the active turn for a given bot player in the room and dispatches the action.
   */
  evaluateTurn(room, botPlayerId) {
    const engine = room?.engine;
    if (!room || !room.isStarted || !engine || engine.phase === GAME_PHASES.GAME_OVER) {
      return null;
    }

    const curPlayer = engine.getCurrentPlayer();
    if (!curPlayer || curPlayer.id !== botPlayerId) {
      return null;
    }

    const action = this.chooseAction(engine, curPlayer);
    if (action) {
      this.dispatchAction(room, botPlayerId, action);
      return action;
    }
    return null;
  }

  chooseAction(engine, player) {
    switch (engine.phase) {
      case GAME_PHASES.SETUP_ROUND_1:
      case GAME_PHASES.SETUP_ROUND_2:
        return BotAI.decideSetupAction(engine, player);

      case GAME_PHASES.TURN_ROLL: {
        const alchemist = BotAI.decideProgressCardPlay(engine, player);
        if (alchemist?.action === 'play_progress_card') {
          return alchemist;
        }
        return { action: 'roll_dice' };
      }

      case GAME_PHASES.TURN_ROBBER:
        return BotAI.decideRobberMove(engine, player);

      case GAME_PHASES.TURN_ACTION:
      case GAME_PHASES.TURN_SPECIAL_BUILDING:
        return BotAI.decideTurnAction(engine, player);

      default:
        return null;
    }
  }

  dispatchAction(room, botPlayerId, action) {
    const engine = room.engine;
    if (!action || !engine) return;

    switch (action.action) {
      case 'place_setup_settlement':
        engine.placeSetupSettlement(botPlayerId, action.vertexId);
        break;
      case 'place_setup_road':
        engine.placeSetupRoad(botPlayerId, action.edgeId);
        break;
      case 'roll_dice':
        engine.rollDice(botPlayerId);
        BotAI.resolvePendingAqueductClaims(engine);
        break;
      case 'move_robber':
        engine.moveRobber(botPlayerId, action.hexId, action.targetPlayerId);
        break;
      case 'build_road':
      case 'build_settlement':
      case 'upgrade_city':
      case 'build_wall':
      case 'buy_development_card':
      case 'recruit_knight':
      case 'promote_knight':
      case 'activate_knight':
      case 'chase_robber':
      case 'upgrade_city_improvement':
      case 'bank_trade':
      case 'play_progress_card':
      case 'propose_trade':
      case 'end_turn':
        BotAI.applyTurnAction(engine, engine.players.find(p => p.id === botPlayerId), action);
        break;
      default:
        break;
    }
  }

  /**
   * Synchronously or rapidly steps a 4-bot match to verify end-to-end completion.
   */
  stepMatchSync(engine, maxSteps = 1500) {
    let steps = 0;
    while (engine.phase !== GAME_PHASES.GAME_OVER && steps < maxSteps) {
      steps++;
      const progressed = BotAI.playCurrentBotStep(engine);
      if (!progressed) {
        break;
      }
    }
    return {
      steps,
      isGameOver: engine.phase === GAME_PHASES.GAME_OVER,
      winner: engine.winner
    };
  }
}

export const defaultBotRunner = new InProcessBotRunner();
