/**
 * connectionStateMachine.js
 * NET-01: Formal client socket connection state machine (handling reconnects & stand-in reclaim).
 */

export const CONNECTION_STATES = Object.freeze({
  INITIAL: 'INITIAL',
  CONNECTING: 'CONNECTING',
  LOBBY: 'LOBBY',
  IN_GAME: 'IN_GAME',
  DISCONNECTED_WAITING_RETRY: 'DISCONNECTED_WAITING_RETRY',
  RECONNECTING_CLAIMING_SEAT: 'RECONNECTING_CLAIMING_SEAT',
  TERMINATED: 'TERMINATED'
});

export const CONNECTION_EVENTS = Object.freeze({
  CONNECT_START: 'CONNECT_START',
  CONNECTED: 'CONNECTED',
  ROOM_JOINED: 'ROOM_JOINED',
  GAME_STARTED: 'GAME_STARTED',
  DISCONNECTED: 'DISCONNECTED',
  RETRY_TIMER_EXPIRED: 'RETRY_TIMER_EXPIRED',
  RECONNECT_ATTEMPT: 'RECONNECT_ATTEMPT',
  SEAT_RECLAIMED: 'SEAT_RECLAIMED',
  TERMINATE: 'TERMINATE',
  RESET: 'RESET'
});

export class ConnectionStateMachine {
  constructor(initialState = CONNECTION_STATES.INITIAL) {
    this.state = initialState;
    this.previousState = null;
    this.wasInGame = false;

    // Action queue for offline / reconnecting state
    this.actionQueue = [];
    this.sendFn = null;

    // Reconnect token storage (in-memory, mirrored to localStorage when available)
    this.tokens = new Map();
    this.tokenStore = this.tokens; // alias
    this.lastRoomCode = null;

    // Event listeners
    this._stateChangeListeners = [];
    this._eventListeners = new Map();

    // Hydrate tokens from localStorage if available
    this._hydrateFromLocalStorage();
  }

  _hydrateFromLocalStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      const defaultToken = localStorage.getItem('catan_reconnect_token');
      const defaultRoom = localStorage.getItem('catan_reconnect_room');
      const defaultPlayer = localStorage.getItem('catan_reconnect_player');
      if (defaultToken) {
        this.saveReconnectToken(defaultRoom, defaultPlayer, defaultToken);
      }
    } catch (e) {
      // localStorage may fail in restricted/private modes
    }
  }

  /**
   * Returns current state string.
   */
  getState() {
    return this.state;
  }

  /**
   * Check if a transition is valid from current state.
   */
  canTransition(event, payload = {}) {
    try {
      this._resolveNextState(event, payload);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve target state based on strict transition table.
   * Throws if transition is invalid.
   */
  _resolveNextState(event, payload = {}) {
    const s = this.state;

    // Universal resets & terminates
    if (event === CONNECTION_EVENTS.RESET) {
      return CONNECTION_STATES.INITIAL;
    }

    if (event === CONNECTION_EVENTS.TERMINATE) {
      return CONNECTION_STATES.TERMINATED;
    }

    switch (s) {
      case CONNECTION_STATES.INITIAL:
        if (event === CONNECTION_EVENTS.CONNECT_START) {
          return CONNECTION_STATES.CONNECTING;
        }
        if (event === CONNECTION_EVENTS.CONNECTED) {
          return CONNECTION_STATES.LOBBY;
        }
        break;

      case CONNECTION_STATES.CONNECTING:
        if (event === CONNECTION_EVENTS.CONNECTED) {
          return CONNECTION_STATES.LOBBY;
        }
        if (event === CONNECTION_EVENTS.ROOM_JOINED) {
          return CONNECTION_STATES.LOBBY;
        }
        if (event === CONNECTION_EVENTS.DISCONNECTED) {
          return CONNECTION_STATES.DISCONNECTED_WAITING_RETRY;
        }
        break;

      case CONNECTION_STATES.LOBBY:
        if (event === CONNECTION_EVENTS.ROOM_JOINED) {
          return CONNECTION_STATES.LOBBY;
        }
        if (event === CONNECTION_EVENTS.GAME_STARTED) {
          return CONNECTION_STATES.IN_GAME;
        }
        if (event === CONNECTION_EVENTS.CONNECT_START) {
          return CONNECTION_STATES.CONNECTING;
        }
        if (event === CONNECTION_EVENTS.DISCONNECTED) {
          return CONNECTION_STATES.DISCONNECTED_WAITING_RETRY;
        }
        break;

      case CONNECTION_STATES.IN_GAME:
        if (event === CONNECTION_EVENTS.DISCONNECTED) {
          return CONNECTION_STATES.DISCONNECTED_WAITING_RETRY;
        }
        if (event === CONNECTION_EVENTS.ROOM_JOINED || event === CONNECTION_EVENTS.GAME_STARTED) {
          return CONNECTION_STATES.IN_GAME;
        }
        break;

      case CONNECTION_STATES.DISCONNECTED_WAITING_RETRY: {
        const isGameReclaim = Boolean(
          this.wasInGame ||
          payload?.inGame === true ||
          payload?.reclaiming === true ||
          (payload?.inGame !== false && this.hasStoredTokenForActiveRoom(payload?.code))
        );

        if (event === CONNECTION_EVENTS.RECONNECT_ATTEMPT || event === CONNECTION_EVENTS.RETRY_TIMER_EXPIRED) {
          return isGameReclaim
            ? CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT
            : CONNECTION_STATES.CONNECTING;
        }
        if (event === CONNECTION_EVENTS.CONNECTED) {
          return isGameReclaim
            ? CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT
            : CONNECTION_STATES.LOBBY;
        }
        break;
      }

      case CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT:
        if (event === CONNECTION_EVENTS.SEAT_RECLAIMED || event === CONNECTION_EVENTS.GAME_STARTED) {
          return CONNECTION_STATES.IN_GAME;
        }
        if (event === CONNECTION_EVENTS.ROOM_JOINED) {
          return CONNECTION_STATES.LOBBY;
        }
        if (event === CONNECTION_EVENTS.CONNECTED) {
          return CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT;
        }
        if (event === CONNECTION_EVENTS.DISCONNECTED) {
          return CONNECTION_STATES.DISCONNECTED_WAITING_RETRY;
        }
        break;

      case CONNECTION_STATES.TERMINATED:
        if (event === CONNECTION_EVENTS.CONNECT_START) {
          return CONNECTION_STATES.CONNECTING;
        }
        break;

      default:
        break;
    }

    throw new Error(`Invalid transition: cannot handle event "${event}" in state "${this.state}"`);
  }

  /**
   * Transition state machine to next state with strict transition validation.
   */
  transition(event, payload = {}) {
    const nextState = this._resolveNextState(event, payload);
    const prevState = this.state;

    this.previousState = prevState;
    this.state = nextState;

    // Track whether we are/were in game
    if (nextState === CONNECTION_STATES.IN_GAME) {
      this.wasInGame = true;
    } else if (nextState === CONNECTION_STATES.LOBBY || nextState === CONNECTION_STATES.INITIAL || nextState === CONNECTION_STATES.TERMINATED) {
      this.wasInGame = false;
    } else if (prevState === CONNECTION_STATES.IN_GAME) {
      this.wasInGame = true;
    }

    // Auto-drain action queue upon entering IN_GAME
    if (nextState === CONNECTION_STATES.IN_GAME && prevState !== CONNECTION_STATES.IN_GAME) {
      this.flushActionQueue(this.sendFn);
    }

    // Notify subscribers
    const transitionDetails = {
      from: prevState,
      to: nextState,
      state: nextState,
      prevState,
      event,
      payload
    };

    for (const listener of [...this._stateChangeListeners]) {
      try {
        listener(nextState, prevState, transitionDetails);
      } catch (e) {
        console.error('[ConnectionStateMachine] Error in onStateChange listener:', e);
      }
    }

    const eventSpecificListeners = this._eventListeners.get('transition');
    if (eventSpecificListeners) {
      for (const listener of [...eventSpecificListeners]) {
        try {
          listener(transitionDetails);
        } catch (e) {
          console.error('[ConnectionStateMachine] Error in transition event listener:', e);
        }
      }
    }

    const stateSpecificListeners = this._eventListeners.get(nextState);
    if (stateSpecificListeners) {
      for (const listener of [...stateSpecificListeners]) {
        try {
          listener(transitionDetails);
        } catch (e) {
          console.error(`[ConnectionStateMachine] Error in ${nextState} listener:`, e);
        }
      }
    }

    return this.state;
  }

  /**
   * Event subscription: onStateChange(callback)
   * Callback receives (newState, prevState, transitionDetails).
   */
  onStateChange(callback) {
    if (typeof callback !== 'function') return () => {};
    this._stateChangeListeners.push(callback);
    return () => this.offStateChange(callback);
  }

  offStateChange(callback) {
    this._stateChangeListeners = this._stateChangeListeners.filter(cb => cb !== callback);
  }

  /**
   * Generic event listener: on('transition', fn) or on(state, fn)
   */
  on(eventName, callback) {
    if (typeof callback !== 'function') return () => {};
    if (!this._eventListeners.has(eventName)) {
      this._eventListeners.set(eventName, []);
    }
    this._eventListeners.get(eventName).push(callback);
    return () => this.off(eventName, callback);
  }

  off(eventName, callback) {
    const list = this._eventListeners.get(eventName);
    if (list) {
      this._eventListeners.set(eventName, list.filter(cb => cb !== callback));
    }
  }

  /**
   * Queue an action while disconnected or reconnecting.
   */
  queueAction(action) {
    this.actionQueue.push(action);
    return action;
  }

  /**
   * Retrieve shallow copy of current action queue.
   */
  getActionQueue() {
    return [...this.actionQueue];
  }

  /**
   * Drain queued actions, optionally applying sendFn to each item.
   */
  flushActionQueue(sendFn) {
    const drained = [...this.actionQueue];
    this.actionQueue = [];
    const handler = typeof sendFn === 'function' ? sendFn : this.sendFn;
    if (typeof handler === 'function') {
      for (const action of drained) {
        try {
          handler(action);
        } catch (err) {
          console.error('[ConnectionStateMachine] Failed to flush action:', err);
        }
      }
    }
    return drained;
  }

  /**
   * Clear offline action queue without sending.
   */
  clearActionQueue() {
    this.actionQueue = [];
  }

  /**
   * Save reconnect token for room and player seat.
   */
  saveReconnectToken(code, playerId, token) {
    if (!token) return null;
    const key = code ? String(code).trim().toUpperCase() : '_DEFAULT_';
    const entry = { code: key, playerId: playerId || null, token };
    this.tokens.set(key, entry);
    if (key !== '_DEFAULT_') {
      this.lastRoomCode = key;
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('catan_reconnect_token', token);
        if (key && key !== '_DEFAULT_') {
          localStorage.setItem('catan_reconnect_room', key);
          localStorage.setItem(`catan_reconnect_${key}`, JSON.stringify(entry));
        }
        if (playerId) {
          localStorage.setItem('catan_reconnect_player', String(playerId));
        }
      } catch (e) {
        // ignore storage errors
      }
    }
    return token;
  }

  /**
   * Retrieve reconnect token for room (or active room).
   */
  getReconnectToken(code) {
    const key = code ? String(code).trim().toUpperCase() : (this.lastRoomCode || '_DEFAULT_');
    if (this.tokens.has(key)) {
      return this.tokens.get(key).token;
    }

    if ((!code || key === '_DEFAULT_') && this.tokens.size > 0) {
      for (const entry of this.tokens.values()) {
        if (entry?.token) return entry.token;
      }
    }

    if (typeof localStorage !== 'undefined') {
      try {
        if (key && key !== '_DEFAULT_') {
          const stored = localStorage.getItem(`catan_reconnect_${key}`);
          if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed?.token) return parsed.token;
          }
        }
        const defaultToken = localStorage.getItem('catan_reconnect_token');
        if (defaultToken) return defaultToken;
      } catch (e) {
        // ignore
      }
    }
    return null;
  }

  /**
   * Retrieve full token session metadata { code, playerId, token }.
   */
  getReconnectSession(code) {
    const key = code ? String(code).trim().toUpperCase() : (this.lastRoomCode || '_DEFAULT_');
    if (this.tokens.has(key)) {
      return { ...this.tokens.get(key) };
    }
    return null;
  }

  /**
   * Check if reconnect token exists for given or last room.
   */
  hasStoredTokenForActiveRoom(code) {
    return Boolean(this.getReconnectToken(code));
  }

  /**
   * Clear reconnect token for room (or all rooms if code omitted).
   */
  clearReconnectToken(code) {
    const key = code ? String(code).trim().toUpperCase() : null;
    if (key) {
      this.tokens.delete(key);
      if (this.lastRoomCode === key) this.lastRoomCode = null;
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(`catan_reconnect_${key}`);
          if (localStorage.getItem('catan_reconnect_room') === key) {
            localStorage.removeItem('catan_reconnect_room');
            localStorage.removeItem('catan_reconnect_token');
            localStorage.removeItem('catan_reconnect_player');
          }
        } catch (e) {}
      }
    } else {
      this.tokens.clear();
      this.lastRoomCode = null;
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem('catan_reconnect_token');
          localStorage.removeItem('catan_reconnect_room');
          localStorage.removeItem('catan_reconnect_player');
        } catch (e) {}
      }
    }
  }

  /**
   * Calculate exponential backoff delay with jitter (e.g. 1s, 2s, 4s capped at 10s).
   *
   * @param {number} attempt - 0-indexed attempt count
   * @param {object|boolean} options - { baseDelay: 1000, maxDelay: 10000, factor: 2, jitter: true } or boolean for jitter
   * @returns {number} delay in milliseconds
   */
  calculateBackoff(attempt = 0, options = {}) {
    const opts = typeof options === 'boolean' ? { jitter: options } : (options || {});
    const baseDelay = opts.baseDelay ?? 1000;
    const maxDelay = opts.maxDelay ?? 10000;
    const factor = opts.factor ?? 2;
    const useJitter = opts.jitter !== false;
    const random = typeof opts.random === 'function' ? opts.random : Math.random;

    const safeAttempt = Math.max(0, Math.floor(attempt || 0));
    const rawDelay = Math.min(maxDelay, baseDelay * Math.pow(factor, safeAttempt));

    if (!useJitter) {
      return rawDelay;
    }

    // ±20% jitter variation around rawDelay, capped at maxDelay
    const jitterFactor = 0.8 + random() * 0.4;
    return Math.min(maxDelay, Math.round(rawDelay * jitterFactor));
  }

  /** Alias for calculateBackoff */
  getReconnectDelay(attempt, options) {
    return this.calculateBackoff(attempt, options);
  }

  /** Alias for calculateBackoff */
  getBackoffDelay(attempt, options) {
    return this.calculateBackoff(attempt, options);
  }
}
