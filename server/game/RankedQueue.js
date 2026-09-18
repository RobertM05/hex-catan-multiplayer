/**
 * RankedQueue.js
 * Matchmaking queue for 4-player competitive ranked Catan.
 * 
 * Rules:
 * - Only signed-in humans (with valid userId).
 * - Exact 4 players to pop a match.
 * - Auto-clean on disconnect or cancellation.
 */

export class RankedQueue {
  constructor(options = {}) {
    this.queue = []; // Array of { socketId, userId, name, elo, joinedAt }
    this.onMatchReady = typeof options.onMatchReady === 'function' ? options.onMatchReady : null;
  }

  /**
   * Add a signed-in player to the ranked matchmaking queue.
   * @param {Object} player - { socketId, userId, name, elo }
   * @returns {{ success: boolean, reason?: string, position?: number, queueSize?: number }}
   */
  addPlayer(player) {
    if (!player || !player.userId) {
      return { success: false, reason: 'AUTH_REQUIRED' };
    }

    // Check if already in queue by userId or socketId
    const existingIndex = this.queue.findIndex(
      p => p.userId === player.userId || (player.socketId && p.socketId === player.socketId)
    );

    if (existingIndex !== -1) {
      // Update socketId if rejoining
      this.queue[existingIndex].socketId = player.socketId;
      return {
        success: true,
        alreadyQueued: true,
        position: existingIndex + 1,
        queueSize: this.queue.length
      };
    }

    const entry = {
      socketId: player.socketId,
      userId: player.userId,
      name: player.name || 'Player',
      elo: Number(player.elo) || 1000,
      avatar: player.avatar || null,
      joinedAt: Date.now()
    };

    this.queue.push(entry);

    const position = this.queue.length;
    const queueSize = this.queue.length;

    // Check if we have 4 players ready
    if (this.queue.length >= 4) {
      this.processQueue();
    }

    return { success: true, position, queueSize };
  }

  /**
   * Remove player by socketId or userId
   */
  removePlayer(identifier) {
    if (!identifier) return false;
    const idx = this.queue.findIndex(p => p.socketId === identifier || p.userId === identifier);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  isInQueue(identifier) {
    return this.queue.some(p => p.socketId === identifier || p.userId === identifier);
  }

  getQueueSize() {
    return this.queue.length;
  }

  getStatus(userIdOrSocketId) {
    const idx = this.queue.findIndex(p => p.userId === userIdOrSocketId || p.socketId === userIdOrSocketId);
    return {
      inQueue: idx !== -1,
      position: idx !== -1 ? idx + 1 : 0,
      queueSize: this.queue.length,
      needed: 4
    };
  }

  clear() {
    this.queue = [];
  }

  processQueue() {
    if (this.queue.length < 4) return null;

    // Pop first 4 players
    const matched = this.queue.splice(0, 4);

    if (this.onMatchReady) {
      try {
        this.onMatchReady(matched);
      } catch (err) {
        console.error('[RankedQueue] Error dispatching match:', err);
      }
    }

    return matched;
  }
}
