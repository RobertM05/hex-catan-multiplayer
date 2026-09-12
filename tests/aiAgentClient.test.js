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

  it('should autonomously place city and road in C&K Round 2 setup without freezing', async () => {
    // Create C&K room
    const hostData = { id: 'ck_host', name: 'CKHost', socketId: 'sock_ck_host' };
    const room = roomManager.createRoom(hostData, { name: 'CKAgentTestRoom', mode: 'cities_knights', maxPlayers: 2 });
    roomManager.setPlayerReady(room.code, hostData.id, true);

    const agent = new CatanAIAgent({
      serverUrl,
      name: 'ClaudeBot',
      turnDelay: 10,
      autoReady: true,
      log: () => {}
    });

    await agent.connect();
    await agent.joinRoom(room.code);

    roomManager.startGame(room.code, hostData.id);
    const engine = room.engine;

    // Helper to simulate a player's setup step
    const takeSetupTurn = (playerId) => {
      const curPlayer = engine.getCurrentPlayer();
      if (curPlayer.id !== playerId) return;
      const v = Array.from(engine.grid.vertices.keys()).find(vId => {
        const vtx = engine.grid.vertices.get(vId);
        return !vtx.building && !vtx.knight && !engine.violatesDistanceRule(vId);
      });
      engine.placeSetupSettlement(playerId, v);
      const e = engine.grid.vertices.get(v).adjacentEdges.find(eId => !engine.grid.edges.get(eId)?.road);
      engine.placeSetupRoad(playerId, e);
      roomManager.broadcastState(room);
    };

    // Advance round 1 if needed
    if (engine.getCurrentPlayer().id === hostData.id) {
      takeSetupTurn(hostData.id);
    }

    // Wait for agent round 1
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 100));
      const agentState = engine.players.find(p => p.id === agent.myPlayerId);
      if (agentState && agentState.settlementsBuilt.length >= 1 && agentState.roadsBuilt.length >= 1) {
        break;
      }
      attempts++;
    }

    // Now in Round 2: snake draft order has the second player go first, or host
    if (engine.phase === 'SETUP_ROUND_2') {
      if (engine.getCurrentPlayer().id === hostData.id) {
        takeSetupTurn(hostData.id);
      }

      // Wait for agent to place city and road in Round 2
      attempts = 0;
      while (attempts < 30) {
        await new Promise(r => setTimeout(r, 100));
        const agentState = engine.players.find(p => p.id === agent.myPlayerId);
        if (agentState && agentState.citiesBuilt.length >= 1 && agentState.roadsBuilt.length >= 2) {
          break;
        }
        attempts++;
      }
    }

    const finalAgent = engine.players.find(p => p.id === agent.myPlayerId);
    assert.ok(finalAgent.settlementsBuilt.length >= 1, 'Agent should have a settlement from Round 1');
    assert.ok(finalAgent.citiesBuilt.length >= 1, 'Agent should have placed a city in C&K Round 2');
    assert.ok(finalAgent.roadsBuilt.length >= 2, 'Agent should have placed roads in both rounds');

    agent.disconnect();
    roomManager.destroyRoom(room.code);
  });

  it('should successfully discard cards on 7-roll without INVALID_DISCARD_DATA', async () => {
    const hostData = { id: 'discard_host', name: 'DiscardHost', socketId: 'sock_discard_host' };
    const room = roomManager.createRoom(hostData, { name: 'DiscardRoom', mode: 'cities_knights', maxPlayers: 2 });
    roomManager.setPlayerReady(room.code, hostData.id, true);

    const agent = new CatanAIAgent({
      serverUrl,
      name: 'DeepHex',
      turnDelay: 10,
      autoReady: true,
      log: () => {}
    });

    await agent.connect();
    await agent.joinRoom(room.code);

    roomManager.startGame(room.code, hostData.id);
    const engine = room.engine;

    // Fast-forward setup
    engine.phase = 'TURN_ACTION';
    const agentPlayer = engine.players.find(p => p.id === agent.myPlayerId);
    // Give agent 8 cards (5 resources + 3 commodities)
    agentPlayer.resources = { wood: 2, brick: 1, wool: 1, wheat: 1, ore: 0 };
    agentPlayer.commodities = { cloth: 1, coin: 1, paper: 1 };

    // Trigger discard phase
    engine.phase = 'TURN_DISCARD';
    engine.pendingDiscards = new Set([agent.myPlayerId]);
    roomManager.broadcastState(room);

    // Wait for agent to discard
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 100));
      if (!engine.pendingDiscards.has(agent.myPlayerId)) {
        break;
      }
      attempts++;
    }

    assert.ok(!engine.pendingDiscards.has(agent.myPlayerId), 'Agent should have completed discard successfully');
    const totalRemaining = Object.values(agentPlayer.resources).reduce((s, v) => s + v, 0) +
                           Object.values(agentPlayer.commodities).reduce((s, v) => s + v, 0);
    assert.equal(totalRemaining, 4, 'Agent should have discarded exactly half (4 cards)');

    agent.disconnect();
    roomManager.destroyRoom(room.code);
  });
});
