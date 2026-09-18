/**
 * network.js
 * Socket.IO client connection and event dispatcher.
 */

export class NetworkClient {
  constructor() {
    this.socket = null;
    this.currentRoomCode = null;
    this.currentPlayerId = null;
    this.reconnectToken = typeof localStorage !== 'undefined' ? localStorage.getItem('catan_reconnect_token') : null;
    this.accessToken = null;
    this.onStateUpdate = null;
    this.onLobbyUpdate = null;
    this.onGameStarted = null;
    this.onTimerTick = null;
    this.onChatReceived = null;
    this.onError = null;
    this.onKicked = null;
    /** Called when handshake rejects a stored JWT; caller should clear the session. */
    this.onInvalidAuth = null;
    this._clearingInvalidAuth = false;
  }

  connect() {
    return new Promise((resolve) => {
      // Connect to same origin
      this.socket = io({
        auth: this.accessToken ? { token: this.accessToken } : {}
      });

      this.socket.on('connect', () => {
        console.log('Connected to game server, socket id:', this.socket.id);
        this._clearingInvalidAuth = false;
        resolve(this.socket);
      });

      this.socket.on('connect_error', (err) => {
        this.handleConnectError(err);
      });

      this.socket.on('game_state_update', (data) => {
        if (this.onStateUpdate) this.onStateUpdate(data);
      });

      this.socket.on('lobby_state_update', (data) => {
        if (this.onLobbyUpdate) this.onLobbyUpdate(data);
      });

      this.socket.on('game_started', (data) => {
        if (this.onGameStarted) this.onGameStarted(data);
      });

      this.socket.on('timer_tick', (data) => {
        if (this.onTimerTick) this.onTimerTick(data);
      });

      this.socket.on('chat_received', (data) => {
        if (this.onChatReceived) this.onChatReceived(data);
      });

      this.socket.on('player_kicked', (data) => {
        if (this.onKicked) this.onKicked(data);
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
      this.socket.emit('create_room', { hostName, ...options }, (res) => {
        if (res && res.success) {
          this.currentRoomCode = res.roomCode ? res.roomCode.toUpperCase() : null;
          this.currentPlayerId = res.playerId;
          this.storeReconnectToken(res.reconnectToken);
          resolve(res);
        } else {
          reject(new Error(res ? res.error : 'Failed to create room'));
        }
      });
    });
  }

  joinRoom(code, playerName) {
    return new Promise((resolve, reject) => {
      const roomCode = (code || '').toUpperCase();
      this.socket.emit('join_room', { code: roomCode, playerName, reconnectToken: this.reconnectToken }, (res) => {
        if (res && res.success) {
          this.currentRoomCode = res.roomCode ? res.roomCode.toUpperCase() : roomCode;
          this.currentPlayerId = res.playerId;
          this.storeReconnectToken(res.reconnectToken);
          resolve(res);
        } else {
          reject(new Error(res ? res.error : 'Failed to join room'));
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
  }

  leaveRoom(code = null) {
    return new Promise((resolve) => {
      const roomCode = (code || this.currentRoomCode)?.toUpperCase();
      this.socket.emit('leave_room', { code: roomCode }, () => {
        this.currentRoomCode = null;
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
        if (res && res.success) resolve(res);
        else reject(new Error(res ? res.error : 'Failed to start game'));
      });
    });
  }

  sendChat(text, code = null) {
    const roomCode = (code || this.currentRoomCode)?.toUpperCase();
    this.socket.emit('send_chat', { code: roomCode, text });
  }

  // Gameplay actions
  sendAction(actionName, data = {}) {
    return new Promise((resolve, reject) => {
      this.socket.emit(actionName, { code: this.currentRoomCode, ...data }, (res) => {
        if (res && res.success) resolve(res);
        else reject(new Error(res ? res.error : 'Action failed'));
      });
    });
  }
}

export const network = new NetworkClient();
