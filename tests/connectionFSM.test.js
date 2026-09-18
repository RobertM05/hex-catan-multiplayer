import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectionStateMachine,
  CONNECTION_STATES,
  CONNECTION_EVENTS
} from '../public/js/connectionStateMachine.js';
import { NetworkClient } from '../public/js/network.js';

describe('NET-01: Formal client socket connection state machine', () => {
  let fsm;

  beforeEach(() => {
    fsm = new ConnectionStateMachine();
  });

  describe('Lifecycle and valid state transitions', () => {
    it('executes the full lifecycle: INITIAL -> CONNECTING -> LOBBY -> IN_GAME -> DISCONNECTED_WAITING_RETRY -> RECONNECTING_CLAIMING_SEAT -> IN_GAME', () => {
      assert.equal(fsm.getState(), CONNECTION_STATES.INITIAL);

      // INITIAL -> CONNECTING
      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      assert.equal(fsm.getState(), CONNECTION_STATES.CONNECTING);

      // CONNECTING -> LOBBY
      fsm.transition(CONNECTION_EVENTS.CONNECTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.LOBBY);

      // LOBBY -> LOBBY (room joined)
      fsm.transition(CONNECTION_EVENTS.ROOM_JOINED);
      assert.equal(fsm.getState(), CONNECTION_STATES.LOBBY);

      // LOBBY -> IN_GAME
      fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.IN_GAME);

      // IN_GAME -> DISCONNECTED_WAITING_RETRY
      fsm.transition(CONNECTION_EVENTS.DISCONNECTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.DISCONNECTED_WAITING_RETRY);

      // DISCONNECTED_WAITING_RETRY -> RECONNECTING_CLAIMING_SEAT (via RECONNECT_ATTEMPT while in-game)
      fsm.transition(CONNECTION_EVENTS.RECONNECT_ATTEMPT);
      assert.equal(fsm.getState(), CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT);

      // RECONNECTING_CLAIMING_SEAT -> IN_GAME
      fsm.transition(CONNECTION_EVENTS.SEAT_RECLAIMED);
      assert.equal(fsm.getState(), CONNECTION_STATES.IN_GAME);
    });

    it('supports RETRY_TIMER_EXPIRED transition from DISCONNECTED_WAITING_RETRY to RECONNECTING_CLAIMING_SEAT', () => {
      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      fsm.transition(CONNECTION_EVENTS.CONNECTED);
      fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      fsm.transition(CONNECTION_EVENTS.DISCONNECTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.DISCONNECTED_WAITING_RETRY);

      fsm.transition(CONNECTION_EVENTS.RETRY_TIMER_EXPIRED);
      assert.equal(fsm.getState(), CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT);
    });

    it('transitions directly from INITIAL to LOBBY when CONNECTED is received immediately', () => {
      fsm.transition(CONNECTION_EVENTS.CONNECTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.LOBBY);
    });

    it('transitions to CONNECTING from DISCONNECTED_WAITING_RETRY when not in a game', () => {
      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      fsm.transition(CONNECTION_EVENTS.CONNECTED); // in LOBBY
      fsm.transition(CONNECTION_EVENTS.DISCONNECTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.DISCONNECTED_WAITING_RETRY);

      fsm.transition(CONNECTION_EVENTS.RECONNECT_ATTEMPT);
      assert.equal(fsm.getState(), CONNECTION_STATES.CONNECTING);
    });

    it('supports TERMINATE and RESET from various states', () => {
      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      fsm.transition(CONNECTION_EVENTS.TERMINATE);
      assert.equal(fsm.getState(), CONNECTION_STATES.TERMINATED);

      fsm.transition(CONNECTION_EVENTS.RESET);
      assert.equal(fsm.getState(), CONNECTION_STATES.INITIAL);

      fsm.transition(CONNECTION_EVENTS.CONNECTED);
      fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      fsm.transition(CONNECTION_EVENTS.TERMINATE);
      assert.equal(fsm.getState(), CONNECTION_STATES.TERMINATED);

      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      assert.equal(fsm.getState(), CONNECTION_STATES.CONNECTING);
    });

    it('transitions from RECONNECTING_CLAIMING_SEAT back to DISCONNECTED_WAITING_RETRY on network failure', () => {
      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      fsm.transition(CONNECTION_EVENTS.CONNECTED);
      fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      fsm.transition(CONNECTION_EVENTS.DISCONNECTED);
      fsm.transition(CONNECTION_EVENTS.RECONNECT_ATTEMPT);
      assert.equal(fsm.getState(), CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT);

      fsm.transition(CONNECTION_EVENTS.DISCONNECTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.DISCONNECTED_WAITING_RETRY);
    });
  });

  describe('Rejection of invalid transitions', () => {
    it('throws when attempting invalid transition from INITIAL', () => {
      assert.throws(() => {
        fsm.transition(CONNECTION_EVENTS.SEAT_RECLAIMED);
      }, /Invalid transition/);
      assert.equal(fsm.getState(), CONNECTION_STATES.INITIAL);

      assert.throws(() => {
        fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      }, /Invalid transition/);
      assert.equal(fsm.getState(), CONNECTION_STATES.INITIAL);

      assert.throws(() => {
        fsm.transition(CONNECTION_EVENTS.DISCONNECTED);
      }, /Invalid transition/);
      assert.equal(fsm.getState(), CONNECTION_STATES.INITIAL);
    });

    it('throws when attempting invalid transition from CONNECTING', () => {
      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      assert.throws(() => {
        fsm.transition(CONNECTION_EVENTS.SEAT_RECLAIMED);
      }, /Invalid transition/);
      assert.equal(fsm.getState(), CONNECTION_STATES.CONNECTING);

      assert.throws(() => {
        fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      }, /Invalid transition/);
      assert.equal(fsm.getState(), CONNECTION_STATES.CONNECTING);
    });

    it('throws when attempting invalid transition from IN_GAME', () => {
      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      fsm.transition(CONNECTION_EVENTS.CONNECTED);
      fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.IN_GAME);

      assert.throws(() => {
        fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      }, /Invalid transition/);
      assert.equal(fsm.getState(), CONNECTION_STATES.IN_GAME);

      assert.throws(() => {
        fsm.transition(CONNECTION_EVENTS.SEAT_RECLAIMED);
      }, /Invalid transition/);
      assert.equal(fsm.getState(), CONNECTION_STATES.IN_GAME);
    });

    it('throws for unknown event strings', () => {
      assert.throws(() => {
        fsm.transition('BOGUS_EVENT');
      }, /Invalid transition/);
    });

    it('canTransition returns true for valid transitions and false for invalid ones', () => {
      assert.equal(fsm.canTransition(CONNECTION_EVENTS.CONNECT_START), true);
      assert.equal(fsm.canTransition(CONNECTION_EVENTS.CONNECTED), true);
      assert.equal(fsm.canTransition(CONNECTION_EVENTS.SEAT_RECLAIMED), false);
      assert.equal(fsm.canTransition(CONNECTION_EVENTS.GAME_STARTED), false);
      assert.equal(fsm.canTransition('UNKNOWN'), false);
    });
  });

  describe('Offline action queueing and flushing', () => {
    it('queues actions while disconnected or reconnecting', () => {
      const a1 = { actionName: 'roll_dice', data: {} };
      const a2 = { actionName: 'build_road', data: { edgeId: 'e1' } };

      fsm.queueAction(a1);
      fsm.queueAction(a2);

      const queue = fsm.getActionQueue();
      assert.equal(queue.length, 2);
      assert.deepEqual(queue[0], a1);
      assert.deepEqual(queue[1], a2);
    });

    it('flushes queue with a custom sender function and leaves queue empty', () => {
      const dispatched = [];
      fsm.queueAction({ actionName: 'roll_dice', data: {} });
      fsm.queueAction({ actionName: 'end_turn', data: {} });

      const drained = fsm.flushActionQueue((action) => {
        dispatched.push(action.actionName);
      });

      assert.equal(drained.length, 2);
      assert.deepEqual(dispatched, ['roll_dice', 'end_turn']);
      assert.equal(fsm.getActionQueue().length, 0);
    });

    it('clears action queue without sending', () => {
      fsm.queueAction({ actionName: 'roll_dice' });
      assert.equal(fsm.getActionQueue().length, 1);

      fsm.clearActionQueue();
      assert.equal(fsm.getActionQueue().length, 0);
    });

    it('automatically flushes action queue upon transitioning to IN_GAME when sendFn is set', () => {
      const sent = [];
      fsm.sendFn = (action) => sent.push(action.actionName);

      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      fsm.transition(CONNECTION_EVENTS.CONNECTED);
      fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      fsm.transition(CONNECTION_EVENTS.DISCONNECTED);

      fsm.queueAction({ actionName: 'buy_dev_card' });
      fsm.queueAction({ actionName: 'roll_dice' });
      assert.equal(fsm.getActionQueue().length, 2);

      fsm.transition(CONNECTION_EVENTS.RECONNECT_ATTEMPT);
      assert.equal(fsm.getActionQueue().length, 2);

      fsm.transition(CONNECTION_EVENTS.SEAT_RECLAIMED);
      assert.equal(fsm.getState(), CONNECTION_STATES.IN_GAME);
      assert.equal(fsm.getActionQueue().length, 0);
      assert.deepEqual(sent, ['buy_dev_card', 'roll_dice']);
    });
  });

  describe('Exponential retry backoff calculation', () => {
    it('calculates deterministic exponential delay without jitter: 1s, 2s, 4s, 8s, capped at 10s', () => {
      assert.equal(fsm.calculateBackoff(0, false), 1000);
      assert.equal(fsm.calculateBackoff(1, false), 2000);
      assert.equal(fsm.calculateBackoff(2, false), 4000);
      assert.equal(fsm.calculateBackoff(3, false), 8000);
      assert.equal(fsm.calculateBackoff(4, false), 10000);
      assert.equal(fsm.calculateBackoff(5, false), 10000);
      assert.equal(fsm.calculateBackoff(10, false), 10000);
    });

    it('calculates backoff with jitter within ±20% bounds and caps at 10s', () => {
      for (let i = 0; i < 20; i++) {
        const d0 = fsm.calculateBackoff(0, true);
        assert.ok(d0 >= 800 && d0 <= 1200, `d0=${d0} should be within [800, 1200]`);

        const d1 = fsm.calculateBackoff(1, true);
        assert.ok(d1 >= 1600 && d1 <= 2400, `d1=${d1} should be within [1600, 2400]`);

        const d4 = fsm.calculateBackoff(4, true);
        assert.ok(d4 <= 10000 && d4 >= 8000, `d4=${d4} should be capped at 10000`);
      }
    });

    it('supports alias methods getReconnectDelay and getBackoffDelay', () => {
      assert.equal(fsm.getReconnectDelay(2, false), 4000);
      assert.equal(fsm.getBackoffDelay(3, false), 8000);
    });
  });

  describe('Reconnect token storage & seat reclaim recovery cycle', () => {
    it('saves, retrieves, and clears reconnect tokens by room code', () => {
      fsm.saveReconnectToken('ROOM_A', 'player_1', 'token_xyz_123');

      assert.equal(fsm.getReconnectToken('ROOM_A'), 'token_xyz_123');
      assert.equal(fsm.getReconnectToken('room_a'), 'token_xyz_123'); // case insensitive

      const session = fsm.getReconnectSession('ROOM_A');
      assert.deepEqual(session, { code: 'ROOM_A', playerId: 'player_1', token: 'token_xyz_123' });

      fsm.clearReconnectToken('ROOM_A');
      assert.equal(fsm.getReconnectToken('ROOM_A'), null);
      assert.equal(fsm.getReconnectSession('ROOM_A'), null);
    });

    it('clears all tokens when clearReconnectToken is called without arguments', () => {
      fsm.saveReconnectToken('ROOM_A', 'p1', 't1');
      fsm.saveReconnectToken('ROOM_B', 'p2', 't2');

      fsm.clearReconnectToken();
      assert.equal(fsm.getReconnectToken('ROOM_A'), null);
      assert.equal(fsm.getReconnectToken('ROOM_B'), null);
    });

    it('executes full token seat reclaim recovery cycle', () => {
      const roomCode = 'MATCH1';
      const playerId = 'p_hero';
      const reconnectToken = 'reclaim_secret_999';

      fsm.saveReconnectToken(roomCode, playerId, reconnectToken);
      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      fsm.transition(CONNECTION_EVENTS.CONNECTED);
      fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.IN_GAME);

      // Sudden disconnect
      fsm.transition(CONNECTION_EVENTS.DISCONNECTED);
      assert.equal(fsm.getState(), CONNECTION_STATES.DISCONNECTED_WAITING_RETRY);

      // Reconnect attempt begins with token recovery
      assert.ok(fsm.hasStoredTokenForActiveRoom(roomCode));
      fsm.transition(CONNECTION_EVENTS.RECONNECT_ATTEMPT, { code: roomCode, inGame: true });
      assert.equal(fsm.getState(), CONNECTION_STATES.RECONNECTING_CLAIMING_SEAT);

      // Reconnect successfully reclaims stand-in seat
      fsm.transition(CONNECTION_EVENTS.SEAT_RECLAIMED, { playerId, roomCode });
      assert.equal(fsm.getState(), CONNECTION_STATES.IN_GAME);
    });
  });

  describe('Subscriber notification on state changes', () => {
    it('notifies onStateChange subscriber with nextState, prevState, and transitionDetails', () => {
      const history = [];
      const unsubscribe = fsm.onStateChange((newState, prevState, details) => {
        history.push({ newState, prevState, event: details.event });
      });

      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      fsm.transition(CONNECTION_EVENTS.CONNECTED);

      assert.equal(history.length, 2);
      assert.deepEqual(history[0], {
        newState: CONNECTION_STATES.CONNECTING,
        prevState: CONNECTION_STATES.INITIAL,
        event: CONNECTION_EVENTS.CONNECT_START
      });
      assert.deepEqual(history[1], {
        newState: CONNECTION_STATES.LOBBY,
        prevState: CONNECTION_STATES.CONNECTING,
        event: CONNECTION_EVENTS.CONNECTED
      });

      // Test unsubscribe
      unsubscribe();
      fsm.transition(CONNECTION_EVENTS.GAME_STARTED);
      assert.equal(history.length, 2);
    });

    it('notifies on("transition") subscriber', () => {
      const transitionList = [];
      fsm.on('transition', (details) => {
        transitionList.push({ from: details.from, to: details.to });
      });

      fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      assert.equal(transitionList.length, 1);
      assert.deepEqual(transitionList[0], {
        from: CONNECTION_STATES.INITIAL,
        to: CONNECTION_STATES.CONNECTING
      });
    });

    it('handles subscriber exceptions gracefully without disrupting transition', () => {
      fsm.onStateChange(() => {
        throw new Error('Subscriber error');
      });

      assert.doesNotThrow(() => {
        fsm.transition(CONNECTION_EVENTS.CONNECT_START);
      });
      assert.equal(fsm.getState(), CONNECTION_STATES.CONNECTING);
    });
  });

  describe('NetworkClient integration with ConnectionStateMachine', () => {
    let client;

    beforeEach(() => {
      client = new NetworkClient();
    });

    it('initializes NetworkClient with connectionFSM in INITIAL state', () => {
      assert.ok(client.connectionFSM instanceof ConnectionStateMachine);
      assert.equal(client.connectionFSM.getState(), CONNECTION_STATES.INITIAL);
    });

    it('syncs reconnect token to connectionFSM when storeReconnectToken is called', () => {
      client.currentRoomCode = 'TEST_ROOM';
      client.currentPlayerId = 'test_p1';
      client.storeReconnectToken('tok_sec_1');

      assert.equal(client.reconnectToken, 'tok_sec_1');
      assert.equal(client.connectionFSM.getReconnectToken('TEST_ROOM'), 'tok_sec_1');
    });

    it('queues actions in connectionFSM when disconnected or reconnecting', async () => {
      client.connectionFSM.transition(CONNECTION_EVENTS.CONNECT_START);
      client.connectionFSM.transition(CONNECTION_EVENTS.CONNECTED);
      client.connectionFSM.transition(CONNECTION_EVENTS.GAME_STARTED);
      client.connectionFSM.transition(CONNECTION_EVENTS.DISCONNECTED);

      assert.equal(client.connectionFSM.getState(), CONNECTION_STATES.DISCONNECTED_WAITING_RETRY);

      // sendAction should return a Promise and queue action
      const actionPromise = client.sendAction('roll_dice', { foo: 'bar' });
      assert.equal(client.connectionFSM.getActionQueue().length, 1);

      const queued = client.connectionFSM.getActionQueue()[0];
      assert.equal(queued.actionName, 'roll_dice');
      assert.deepEqual(queued.data, { foo: 'bar' });

      // Resolve the action
      queued.resolve({ success: true, roll: 7 });
      const res = await actionPromise;
      assert.equal(res.success, true);
      assert.equal(res.roll, 7);
    });

    it('clears reconnect token and resets FSM on leaveRoom', async () => {
      client.socket = {
        emit(event, data, cb) {
          if (event === 'leave_room' && cb) cb({ success: true });
        }
      };
      client.currentRoomCode = 'ROOM_LEAVE';
      client.storeReconnectToken('tok_leave');
      client.connectionFSM.transition(CONNECTION_EVENTS.CONNECT_START);
      client.connectionFSM.transition(CONNECTION_EVENTS.CONNECTED);

      await client.leaveRoom('ROOM_LEAVE');

      assert.equal(client.currentRoomCode, null);
      assert.equal(client.connectionFSM.getState(), CONNECTION_STATES.INITIAL);
      assert.equal(client.connectionFSM.getReconnectToken('ROOM_LEAVE'), null);
    });
  });
});
