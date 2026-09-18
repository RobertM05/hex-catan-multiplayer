/**
 * network.js
 * Socket.IO client connection and event dispatcher.
 */

import { ConnectionStateMachine, CONNECTION_STATES, CONNECTION_EVENTS } from './connectionStateMachine.js';

export class NetworkClient {
  constructor() {
    this.socket = null;
    this.currentRoomCode = null;
    this.currentPlayerId = null;
    this.currentPlayerName = null;
    this.reconnectToken = typeof localStorage !== 'undefined' ? localStorage.getItem('catan_reconnect_token') : null;
    this.accessToken = null;
    this.onStateUpdate = null;
    this.onLobbyUpdate = null;
    this.onGameStarted = null;
    this.onTimerTick = null;
    this.onChatReceived = null;
    this.onError = null;
    this.onKicked = null;
    this.onSeatReclaimed = null;
    this.onRankedQueueStatus = null;
    this.onRankedMatchFound = null;
    /** Called when handshake rejects a stored JWT; caller should clear the session. */
    this.onInvalidAuth = null;
    this._clearingInvalidAuth = false;

    // NET-01: Connection state machine
    this.connectionFSM = new ConnectionStateMachine();
    if (this.reconnectToken) {
      this.connectionFSM.saveReconnectToken(this.currentRoomCode, this.currentPlayerId, this.reconnectToken);
    }

    // Configure automatic offline queue draining upon transition to IN_GAME
    this.connectionFSM.sendFn = (queued) => {
      if (typeof queued === 'function') {
        queued();
      } else if (queued && queued.actionName) {
        this.sendAction(queued.actionName, queued.data)
          .then((res) => queued.resolve && queued.resolve(res))
          .catch((err) => queued.reject && queued.reject(err));
      }
    };
  }

  connect() {
    if (this.connectionFSM.canTransition(CONNECTION_EVENTS.CONNECT_START)) {
      this.connectionFSM.transition(CONNECTION_EVENTS.CONNECT_START);
    }

    return new Promise((resolve) => {
      // Connect to same origin
      this.socket = io({
        auth: this.accessToken ? { token: this.accessToken } : {},
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        randomizationFactor: 0.5
      });

      this.socket.on('connect', () => {
        console.log('Connected to game server, socket id:', this.socket.id);
        this._clearingInvalidAuth = false;

        const token = this.connectionFSM.getReconnectToken(this.currentRoomCode) || this.reconnectToken;
        const currentState = this.connectionFSM.getState();
        const shouldReclaim = Boolean(
          token &&
          this.currentRoomCode &&
          (currentState === CONNECTION_STATES.DISCONNECTED_WAITING_RETRY ||
           currentState === CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT ||
           this.connectionFSM.wasInGame)
        );

        if (shouldReclaim) {
          this.reclaimSeat(this.currentRoomCode, token).catch((err) => {
            console.warn('[reconnect] Automatic seat reclaim error:', err?.message || err);
          });
        } else {
          if (this.connectionFSM.canTransition(CONNECTION_EVENTS.CONNECTED)) {
            this.connectionFSM.transition(CONNECTION_EVENTS.CONNECTED);
          }
        }
        resolve(this.socket);
      });

      this.socket.on('disconnect', (reason) => {
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.DISCONNECTED)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.DISCONNECTED, { reason });
        }
      });

      this.socket.on('connect_error', (err) => {
        this.handleConnectError(err);
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.DISCONNECTED)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.DISCONNECTED, { error: err });
        }
      });

      const onReconnectAttempt = (attempt) => {
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.RECONNECT_ATTEMPT)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.RECONNECT_ATTEMPT, {
            attempt,
            code: this.currentRoomCode
          });
        }
      };
      this.socket.on('reconnect_attempt', onReconnectAttempt);
      if (this.socket.io) {
        this.socket.io.on('reconnect_attempt', onReconnectAttempt);
      }

      this.socket.on('room_created', (data) => {
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.ROOM_JOINED)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.ROOM_JOINED, data);
        }
      });

      this.socket.on('room_joined', (data) => {
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.ROOM_JOINED)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.ROOM_JOINED, data);
        }
      });

      this.socket.on('game_start', (data) => {
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.GAME_STARTED)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.GAME_STARTED, data);
        }
        if (this.onGameStarted) this.onGameStarted(data);
      });

      this.socket.on('game_started', (data) => {
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.GAME_STARTED)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.GAME_STARTED, data);
        }
        if (this.onGameStarted) this.onGameStarted(data);
      });

      this.socket.on('seat_reclaimed', (data) => {
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.SEAT_RECLAIMED)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.SEAT_RECLAIMED, data);
        }
        if (this.onSeatReclaimed) this.onSeatReclaimed(data);
      });

      this.socket.on('game_state_update', (data) => {
        if (this.connectionFSM.getState() === CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT) {
          if (this.connectionFSM.canTransition(CONNECTION_EVENTS.SEAT_RECLAIMED)) {
            this.connectionFSM.transition(CONNECTION_EVENTS.SEAT_RECLAIMED, data);
          }
        }
        if (this.onStateUpdate) this.onStateUpdate(data);
      });

      this.socket.on('lobby_state_update', (data) => {
        if (this.onLobbyUpdate) this.onLobbyUpdate(data);
      });

      this.socket.on('timer_tick', (data) => {
        if (this.onTimerTick) this.onTimerTick(data);
      });

      this.socket.on('chat_received', (data) => {
        if (this.onChatReceived) this.onChatReceived(data);
      });

      this.socket.on('player_kicked', (data) => {
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.TERMINATE)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.TERMINATE, data);
        }
        if (this.onKicked) this.onKicked(data);
      });

      this.socket.on('ranked_queue_status', (data) => {
        if (this.onRankedQueueStatus) this.onRankedQueueStatus(data);
      });

      this.socket.on('ranked_match_found', (data) => {
        this.currentRoomCode = data?.roomCode;
        if (data?.playerId) this.currentPlayerId = data.playerId;
        if (this.onRankedMatchFound) this.onRankedMatchFound(data);
      });
    });
  }

  handleConnectError(err) {
    const msg = String(err?.message || err || '');
    if (!/INVALID_AUTH_TOKEN/i.test(msg)) return;
    if (this._clearingInvalidAuth) return;
    this._clearingInvalidAuth = true;
    this.accessToken = null;
    if (this.socket) this.socket.auth = {};
    if (typeof this.onInvalidAuth === 'function') {
      try {
        this.onInvalidAuth(err);
      } catch (e) {
        console.warn('[auth] onInvalidAuth handler failed:', e);
      }
    }
    // Next Socket.IO reconnect attempt goes as guest (auth cleared).
  }

  createRoom(hostName, options) {
    return new Promise((resolve, reject) => {
      this.currentPlayerName = hostName;
      this.socket.emit('create_room', { hostName, ...options }, (res) => {
        if (res && res.success) {
          this.currentRoomCode = res.roomCode ? res.roomCode.toUpperCase() : null;
          this.currentPlayerId = res.playerId;
          this.storeReconnectToken(res.reconnectToken);
          if (this.connectionFSM.canTransition(CONNECTION_EVENTS.ROOM_JOINED)) {
            this.connectionFSM.transition(CONNECTION_EVENTS.ROOM_JOINED, res);
          }
          resolve(res);
        } else {
          reject(new Error(res ? res.error : 'Failed to create room'));
        }
      });
    });
  }

  joinRoom(code, playerName, options = {}) {
    return new Promise((resolve, reject) => {
      const roomCode = (code || '').toUpperCase();
      this.currentPlayerName = playerName;
      const token = this.connectionFSM.getReconnectToken(roomCode) || this.reconnectToken;
      this.socket.emit('join_room', { code: roomCode, playerName, reconnectToken: token, ...options }, (res) => {
        if (res && res.success) {
          this.currentRoomCode = res.roomCode ? res.roomCode.toUpperCase() : roomCode;
          this.currentPlayerId = res.playerId;
          this.storeReconnectToken(res.reconnectToken);
          if (res.reconnected) {
            if (this.connectionFSM.canTransition(CONNECTION_EVENTS.SEAT_RECLAIMED)) {
              this.connectionFSM.transition(CONNECTION_EVENTS.SEAT_RECLAIMED, res);
            }
          } else if (res.isStarted) {
            if (this.connectionFSM.canTransition(CONNECTION_EVENTS.GAME_STARTED)) {
              this.connectionFSM.transition(CONNECTION_EVENTS.GAME_STARTED, res);
            }
          } else {
            if (this.connectionFSM.canTransition(CONNECTION_EVENTS.ROOM_JOINED)) {
              this.connectionFSM.transition(CONNECTION_EVENTS.ROOM_JOINED, res);
            }
          }
          resolve(res);
        } else {
          reject(new Error(res ? res.error : 'Failed to join room'));
        }
      });
    });
  }

  reclaimSeat(code = null, token = null) {
    const roomCode = (code || this.currentRoomCode)?.toUpperCase();
    const reclaimToken = token || this.connectionFSM.getReconnectToken(roomCode) || this.reconnectToken;

    if (!roomCode || !reclaimToken) {
      return Promise.reject(new Error('Missing room code or reconnect token for seat reclaim'));
    }

    if (this.connectionFSM.canTransition(CONNECTION_EVENTS.RECONNECT_ATTEMPT)) {
      this.connectionFSM.transition(CONNECTION_EVENTS.RECONNECT_ATTEMPT, { code: roomCode, inGame: true });
    }

    return new Promise((resolve, reject) => {
      this.socket.emit('join_room', {
        code: roomCode,
        playerName: this.currentPlayerName || '',
        reconnectToken: reclaimToken
      }, (res) => {
        if (res && res.success) {
          this.currentRoomCode = roomCode;
          this.currentPlayerId = res.playerId;
          if (res.reconnectToken) {
            this.storeReconnectToken(res.reconnectToken);
          }
          if (this.connectionFSM.canTransition(CONNECTION_EVENTS.SEAT_RECLAIMED)) {
            this.connectionFSM.transition(CONNECTION_EVENTS.SEAT_RECLAIMED, res);
          }
          if (this.onSeatReclaimed) {
            this.onSeatReclaimed(res);
          }
          resolve(res);
        } else {
          const err = new Error(res ? res.error : 'Failed to reclaim seat');
          if (this.connectionFSM.canTransition(CONNECTION_EVENTS.ROOM_JOINED)) {
            this.connectionFSM.transition(CONNECTION_EVENTS.ROOM_JOINED, res);
          } else if (this.connectionFSM.canTransition(CONNECTION_EVENTS.RESET)) {
            this.connectionFSM.transition(CONNECTION_EVENTS.RESET);
          }
          reject(err);
        }
      });
    });
  }

  setAccessToken(token) {
    this.accessToken = token || null;
  }

  reconnectWithAuth(token) {
    this.setAccessToken(token);
    if (!this.socket) return this.connect();
    this.socket.auth = this.accessToken ? { token: this.accessToken } : {};
    if (this.connectionFSM.canTransition(CONNECTION_EVENTS.CONNECT_START)) {
      this.connectionFSM.transition(CONNECTION_EVENTS.CONNECT_START);
    }
    return new Promise((resolve) => {
      this.socket.once('connect', () => resolve(this.socket));
      this.socket.disconnect();
      this.socket.connect();
    });
  }

  storeReconnectToken(token) {
    if (!token) return;
    this.reconnectToken = token;
    if (typeof localStorage !== 'undefined') localStorage.setItem('catan_reconnect_token', token);
    this.connectionFSM.saveReconnectToken(this.currentRoomCode, this.currentPlayerId, token);
  }

  leaveRoom(code = null) {
    return new Promise((resolve) => {
      const roomCode = (code || this.currentRoomCode)?.toUpperCase();
      this.socket.emit('leave_room', { code: roomCode }, () => {
        if (roomCode) {
          this.connectionFSM.clearReconnectToken(roomCode);
        }
        this.connectionFSM.clearActionQueue();
        this.currentRoomCode = null;
        this.currentPlayerId = null;
        if (this.connectionFSM.canTransition(CONNECTION_EVENTS.RESET)) {
          this.connectionFSM.transition(CONNECTION_EVENTS.RESET);
        }
        resolve();
      });
    });
  }

  addBot(difficulty = 'medium', code = null) {
    return new Promise((resolve, reject) => {
      const roomCode = (code || this.currentRoomCode)?.toUpperCase();
      this.socket.emit('add_bot', { code: roomCode, difficulty }, (res) => {
        if (res && res.success) resolve(res.bot);
        else reject(new Error(res ? res.error : 'Failed to add bot'));
      });
    });
  }

  spawnAiAgent(name = null, code = null) {
    return new Promise((resolve, reject) => {
      const roomCode = (code || this.currentRoomCode)?.toUpperCase();
      this.socket.emit('spawn_ai_agent', { code: roomCode, name }, (res) => {
        if (res && res.success) resolve(res);
        else reject(new Error(res ? res.error : 'Failed to spawn AI agent'));
      });
    });
  }

  removePlayer(id, code = null) {
    return new Promise((resolve, reject) => {
      const roomCode = (code || this.currentRoomCode)?.toUpperCase();
      this.socket.emit('remove_player', { code: roomCode, id }, (res) => {
        if (res && res.success) resolve(res);
        else reject(new Error(res ? res.error : 'Failed to remove player'));
      });
    });
  }

  setReady(isReady, code = null) {
    const roomCode = (code || this.currentRoomCode)?.toUpperCase();
    this.socket.emit('set_ready', { code: roomCode, isReady });
  }

  setColor(color, code = null) {
    const roomCode = (code || this.currentRoomCode)?.toUpperCase();
    this.socket.emit('set_color', { code: roomCode, color });
  }

  setAvatar(avatar, code = null) {
    const roomCode = (code || this.currentRoomCode)?.toUpperCase();
    return new Promise((resolve) => {
      this.socket.emit('set_avatar', { code: roomCode, avatar }, (res) => {
        resolve(res);
      });
    });
  }

  startGame(code = null) {
    return new Promise((resolve, reject) => {
      const roomCode = (code || this.currentRoomCode)?.toUpperCase();
      this.socket.emit('start_game', { code: roomCode }, (res) => {
        if (res && res.success) {
          if (this.connectionFSM.canTransition(CONNECTION_EVENTS.GAME_STARTED)) {
            this.connectionFSM.transition(CONNECTION_EVENTS.GAME_STARTED, res);
          }
          resolve(res);
        } else {
          reject(new Error(res ? res.error : 'Failed to start game'));
        }
      });
    });
  }

  sendChat(text, code = null) {
    const roomCode = (code || this.currentRoomCode)?.toUpperCase();
    this.socket.emit('send_chat', { code: roomCode, text });
  }

  // Gameplay actions
  sendAction(actionName, data = {}) {
    const currentState = this.connectionFSM.getState();
    const isDisconnectedOrReconnecting =
      currentState === CONNECTION_STATES.DISCONNECTED_WAITING_RETRY ||
      currentState === CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT;

    if (isDisconnectedOrReconnecting) {
      return new Promise((resolve, reject) => {
        this.connectionFSM.queueAction({
          actionName,
          data,
          resolve,
          reject,
          queuedAt: Date.now()
        });
      });
    }

    return new Promise((resolve, reject) => {
      this.socket.emit(actionName, { code: this.currentRoomCode, ...data }, (res) => {
        if (res && res.success) resolve(res);
        else reject(new Error(res ? res.error : 'Action failed'));
      });
    });
  }

  joinRankedQueue(avatar = null) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('SOCKET_DISCONNECTED'));
      this.socket.emit('join_ranked_queue', { accessToken: this.accessToken, avatar }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  leaveRankedQueue() {
    return new Promise((resolve) => {
      if (!this.socket) return resolve({ success: true });
      this.socket.emit('leave_ranked_queue', {}, (res) => {
        resolve(res);
      });
    });
  }
}

export const network = new NetworkClient();
