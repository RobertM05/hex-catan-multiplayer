/**
 * network.js
 * Socket.IO client connection and event dispatcher.
 */

export class NetworkClient {
  constructor() {
    this.socket = null;
    this.currentRoomCode = null;
    this.currentPlayerId = null;
    this.onStateUpdate = null;
    this.onLobbyUpdate = null;
    this.onGameStarted = null;
    this.onTimerTick = null;
    this.onChatReceived = null;
    this.onError = null;
  }

  connect() {
    return new Promise((resolve) => {
      // Connect to same origin
      this.socket = io();

      this.socket.on('connect', () => {
        console.log('Connected to game server, socket id:', this.socket.id);
        resolve(this.socket);
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
    });
  }

  createRoom(hostName, options) {
    return new Promise((resolve, reject) => {
      this.socket.emit('create_room', { hostName, ...options, playerId: this.currentPlayerId }, (res) => {
        if (res && res.success) {
          this.currentRoomCode = res.roomCode;
          this.currentPlayerId = res.playerId;
          resolve(res);
        } else {
          reject(new Error(res ? res.error : 'Failed to create room'));
        }
      });
    });
  }

  joinRoom(code, playerName) {
    return new Promise((resolve, reject) => {
      this.socket.emit('join_room', { code: code.toUpperCase(), playerName, playerId: this.currentPlayerId }, (res) => {
        if (res && res.success) {
          this.currentRoomCode = res.roomCode;
          this.currentPlayerId = res.playerId;
          resolve(res);
        } else {
          reject(new Error(res ? res.error : 'Failed to join room'));
        }
      });
    });
  }

  addBot(difficulty = 'medium') {
    return new Promise((resolve, reject) => {
      this.socket.emit('add_bot', { code: this.currentRoomCode, difficulty }, (res) => {
        if (res && res.success) resolve(res.bot);
        else reject(new Error(res ? res.error : 'Failed to add bot'));
      });
    });
  }

  removePlayer(id) {
    return new Promise((resolve, reject) => {
      this.socket.emit('remove_player', { code: this.currentRoomCode, id }, (res) => {
        if (res && res.success) resolve(res);
        else reject(new Error(res ? res.error : 'Failed to remove player'));
      });
    });
  }

  setReady(isReady) {
    this.socket.emit('set_ready', { code: this.currentRoomCode, isReady });
  }

  setColor(color) {
    this.socket.emit('set_color', { code: this.currentRoomCode, color });
  }

  startGame() {
    return new Promise((resolve, reject) => {
      this.socket.emit('start_game', { code: this.currentRoomCode }, (res) => {
        if (res && res.success) resolve(res);
        else reject(new Error(res ? res.error : 'Failed to start game'));
      });
    });
  }

  sendChat(text) {
    this.socket.emit('send_chat', { code: this.currentRoomCode, text });
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
