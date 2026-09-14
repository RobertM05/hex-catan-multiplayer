import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HexGrid } from '../server/game/HexGrid.js';
import { RoomManager } from '../server/game/RoomManager.js';

describe('Robika fixes', () => {
  it('avoids three mutually adjacent hexes of the same resource', () => {
    for (let i = 0; i < 12; i++) {
      const grid = new HexGrid({ mapSize: 'standard' });
      assert.equal(grid.hasTightSameResourceCluster(), false);
    }
  });

  it('blocks start until every human player is ready', () => {
    const rm = new RoomManager({ to: () => ({ emit() {} }) });
    const room = rm.createRoom({ id: 'h1', name: 'Host', socketId: 's1' });
    rm.joinRoom(room.code, { id: 'p2', name: 'Guest', socketId: 's2' });
    assert.throws(() => rm.startGame(room.code, 'h1'), /PLAYERS_NOT_READY/);
    rm.setPlayerReady(room.code, 'p2', true);
    assert.equal(rm.startGame(room.code, 'h1').isStarted, true);
    rm.destroyRoom(room.code);
  });

  it('replaces a disconnected human with a stand-in bot and reclaims the seat on reconnect', () => {
    const rm = new RoomManager({ to: () => ({ emit() {} }) });
    const host = rm.createPlayerSession();
    const guest = rm.createPlayerSession();
    const room = rm.createRoom({
      id: host.id,
      name: 'Host',
      socketId: 's1',
      reconnectTokenHash: host.reconnectTokenHash
    });
    rm.joinRoom(room.code, {
      id: guest.id,
      name: 'Guest',
      socketId: 's2',
      reconnectTokenHash: guest.reconnectTokenHash
    });
    rm.setPlayerReady(room.code, guest.id, true);
    rm.startGame(room.code, host.id);

    const replaced = rm.replaceDisconnectedPlayerWithBot(room.code, guest.id);
    assert.ok(replaced);
    assert.equal(replaced.isBot, true);
    assert.equal(replaced.isStandInBot, true);
    assert.equal(room.engine.players.find(p => p.id === guest.id).isBot, true);

    const back = rm.joinRoom(room.code, {
      socketId: 's2-new',
      reconnectToken: guest.reconnectToken,
      allowLegacyId: false
    });
    assert.equal(back.reconnected, true);
    assert.equal(back.playerId, guest.id);
    const seat = room.players.find(p => p.id === guest.id);
    assert.equal(seat.isBot, false);
    assert.equal(seat.isStandInBot, false);
    rm.destroyRoom(room.code);
  });
});
