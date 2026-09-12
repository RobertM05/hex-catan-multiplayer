import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server, roomManager, io } from '../server/server.js';
import { CatanAIAgent } from '../scripts/aiAgentClient.js';

describe('AI-01: Autonomous AI Agent Client & Room Summoning', () => {
  let serverPort = null;
  let serverUrl = null;

  before(async () => {
    await new Promise((resolve) => {
      server.listen(0, () => {
        serverPort = server.address().port;
        serverUrl = `http://localhost:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    io.close();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('should connect over Socket.IO, join a room, and set ready status', async () => {
    // 1. Host creates room
    const hostData = { id: 'host_1', name: 'HostPlayer', socketId: 'sock_host_1' };
    const room = roomManager.createRoom(hostData, { name: 'AgentTestRoom', mode: 'base', maxPlayers: 4 });

    // 2. Spawn AI Agent client
    const agent = new CatanAIAgent({
      serverUrl,
      roomCode: room.code,
      name: 'AlphaAgent',
      turnDelay: 50,
      autoReady: true,
      log: () => {}
    });

    await agent.connect();
    const joinRes = await agent.joinRoom(room.code);

    assert.equal(joinRes.success, true);
    assert.ok(agent.myPlayerId);

    // Verify player exists in room and is ready
    const updatedRoom = roomManager.getRoom(room.code);
    const agentPlayer = updatedRoom.players.find(p => p.id === agent.myPlayerId);
    assert.ok(agentPlayer);
    assert.equal(agentPlayer.name, 'AlphaAgent');
    assert.equal(agentPlayer.isReady, true);

    agent.disconnect();
    roomManager.destroyRoom(room.code);
  });

  it('should autonomously place setup settlement and road on game start', async () => {
    // 1. Create 2-player room with Agent as first player to ensure immediate setup turn
    const agent = new CatanAIAgent({
      serverUrl,
      name: 'FirstAgent',
      turnDelay: 10,
      autoReady: true,
      log: () => {}
    });

    await agent.connect();

    // Create room with host
    const hostData = { id: 'host_p2', name: 'HostP2', socketId: 'sock_host_2' };
    const room = roomManager.createRoom(hostData, { name: 'SetupTestRoom', mode: 'base', maxPlayers: 2 });
    roomManager.setPlayerReady(room.code, hostData.id, true);

    // Agent joins room
    await agent.joinRoom(room.code);

    // Start game
    roomManager.startGame(room.code, hostData.id);
    roomManager.broadcastState(room);

    // If agent is not the first turn player, let host do setup or advance
    const engine = room.engine;
    if (engine.players[engine.currentTurnPlayerIndex].id !== agent.myPlayerId) {
      // Host takes their first setup
      const v = Array.from(engine.grid.vertices.keys())[0];
      engine.placeSetupSettlement(hostData.id, v);
      const e = engine.grid.vertices.get(v).adjacentEdges[0];
      engine.placeSetupRoad(hostData.id, e);
      roomManager.broadcastState(room);
    }

    // Wait for agent to process game_state_update and place settlement & road
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 100));
      const agentState = engine.players.find(p => p.id === agent.myPlayerId);
      if (agentState && agentState.settlementsBuilt.length >= 1 && agentState.roadsBuilt.length >= 1) {
        break;
      }
      attempts++;
    }

    const agentFinal = engine.players.find(p => p.id === agent.myPlayerId);
    assert.ok(agentFinal.settlementsBuilt.length >= 1, 'Agent should have placed a setup settlement');
    assert.ok(agentFinal.roadsBuilt.length >= 1, 'Agent should have placed a setup road');

    agent.disconnect();
    roomManager.destroyRoom(room.code);
  });

  it('should support REST API /api/rooms/:code/spawn-agent', async () => {
    const session = roomManager.createPlayerSession();
    const hostData = { id: session.id, name: 'ApiHost', socketId: 'sock_host_api', reconnectTokenHash: session.reconnectTokenHash };
    const room = roomManager.createRoom(hostData, { name: 'ApiRoom', mode: 'base', maxPlayers: 3 });

    // Call REST API
    const response = await fetch(`${serverUrl}/api/rooms/${room.code}/spawn-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.reconnectToken}` },
      body: JSON.stringify({ name: 'RestAgent' })
    });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.name, 'RestAgent');
    assert.ok(data.pid);

    if (data.pid) {
      try {
        process.kill(data.pid);
      } catch (e) {}
    }

    roomManager.destroyRoom(room.code);
  });
});
