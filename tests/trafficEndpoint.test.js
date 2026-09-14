import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server, io, extractClientIp, extractClientCountry, recordTrafficEvent, recordPlayerIp, trafficBuffer, trafficStats, formatEventStory, capitalizeWord, clearTrafficLogs } from '../server/server.js';

describe('API: Real-time Traffic & IP Telemetry', () => {
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

  it('extractClientIp should correctly prioritize cf-connecting-ip, x-real-ip, x-forwarded-for, and req.ip', () => {
    // Cloudflare Connecting IP
    const reqCf = { headers: { 'cf-connecting-ip': '198.51.100.42', 'x-forwarded-for': '203.0.113.1' } };
    assert.equal(extractClientIp(reqCf), '198.51.100.42');

    // X-Real-IP
    const reqReal = { headers: { 'x-real-ip': '198.51.100.88' } };
    assert.equal(extractClientIp(reqReal), '198.51.100.88');

    // X-Forwarded-For chain
    const reqFwd = { headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.1, 192.168.1.1' } };
    assert.equal(extractClientIp(reqFwd), '203.0.113.50');

    // Socket handshake format
    const socket = { handshake: { headers: { 'cf-connecting-ip': '86.120.10.5' }, address: '127.0.0.1' } };
    assert.equal(extractClientIp(socket), '86.120.10.5');

    // Strips ::ffff:
    const reqIpv6 = { ip: '::ffff:192.168.1.100', headers: {} };
    assert.equal(extractClientIp(reqIpv6), '192.168.1.100');
  });

  it('extractClientCountry should extract cf-ipcountry header', () => {
    const req = { headers: { 'cf-ipcountry': 'RO' } };
    assert.equal(extractClientCountry(req), 'RO');

    const reqEmpty = { headers: {} };
    assert.equal(extractClientCountry(reqEmpty), null);
  });

  it('recordTrafficEvent should append to buffer and track unique IPs', () => {
    const initialCount = trafficBuffer.length;
    const testIp = '198.51.100.99';
    recordTrafficEvent({
      type: 'TEST_EVENT',
      ip: testIp,
      country: 'RO'
    });

    assert.ok(trafficBuffer.length >= initialCount + 1);
    assert.ok(trafficStats.uniqueIps.has(testIp));
  });

  it('GET /api/admin/traffic should return telemetry data and respect query limits', async () => {
    const res = await fetch(`${serverUrl}/api/admin/traffic?limit=5`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.status, 'ok');
    assert.ok(data.stats);
    assert.equal(typeof data.stats.totalHttpRequests, 'number');
    assert.equal(typeof data.stats.totalSocketPackets, 'number');
    assert.equal(typeof data.stats.uniqueIpCount, 'number');
    assert.ok(Array.isArray(data.stats.uniqueIps));
    assert.ok(Array.isArray(data.activeConnections));
    assert.ok(Array.isArray(data.recentEvents));
    assert.ok(data.recentEvents.length <= 5);
  });

  it('GET /api/admin/traffic should filter by event type when requested', async () => {
    const res = await fetch(`${serverUrl}/api/admin/traffic?type=HTTP&limit=10`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.recentEvents));
    for (const event of data.recentEvents) {
      assert.equal(event.type, 'HTTP');
    }
  });

  it('GET /api/admin/room/:code should return 404 for non-existent room and 200 with debug state for active room', async () => {
    // 404 case
    const res404 = await fetch(`${serverUrl}/api/admin/room/NONEXISTENT`);
    assert.equal(res404.status, 404);
    const data404 = await res404.json();
    assert.equal(data404.error, 'ROOM_NOT_FOUND');

    // Create a room via roomManager and test 200 case
    const { roomManager } = await import('../server/server.js');
    const session = roomManager.createPlayerSession();
    const testRoom = roomManager.createRoom(
      { id: session.id, name: 'DebugTester', socketId: 'test_sock' },
      { name: 'Debug Room', mode: 'cities_knights' }
    );

    const res200 = await fetch(`${serverUrl}/api/admin/room/${testRoom.code}`);
    assert.equal(res200.status, 200);
    const data200 = await res200.json();
    assert.equal(data200.status, 'ok');
    assert.equal(data200.roomCode, testRoom.code);
    assert.equal(data200.mode, 'cities_knights');
    assert.ok(Array.isArray(data200.players));
    assert.equal(data200.players[0].name, 'DebugTester');

    // Cleanup
    roomManager.rooms.delete(testRoom.code);
  });

  it('GET /admin should serve HTML dashboard with status 200', async () => {
    const res = await fetch(`${serverUrl}/admin`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Catan Admin Telemetry & Traffic Dashboard'));
    assert.ok(text.includes('dashboard-container'));
  });

  it('GET /api/admin/traffic should return dashboard url and valid JSON with indentation', async () => {
    const res = await fetch(`${serverUrl}/api/admin/traffic?limit=1`);
    assert.equal(res.status, 200);
    const rawText = await res.text();
    // Verify JSON indentation (contains indented lines)
    assert.ok(rawText.includes('\n  "status": "ok"'));
    const parsed = JSON.parse(rawText);
    assert.equal(parsed.dashboard, '/admin');
  });

  it('GET /api/admin/traffic should support auto-refresh headers and log sorting', async () => {
    // Test refresh header
    const resRefresh = await fetch(`${serverUrl}/api/admin/traffic?refresh=4`);
    assert.equal(resRefresh.headers.get('refresh'), '4');
    const dataRefresh = await resRefresh.json();
    assert.equal(dataRefresh.refreshSeconds, 4);

    // Test sort by time_asc
    const resAsc = await fetch(`${serverUrl}/api/admin/traffic?sort=time_asc&limit=10`);
    assert.equal(resAsc.status, 200);
    const dataAsc = await resAsc.json();
    assert.equal(dataAsc.sort, 'time_asc');
    if (dataAsc.recentEvents.length >= 2) {
      const t1 = new Date(dataAsc.recentEvents[0].timestamp).getTime();
      const t2 = new Date(dataAsc.recentEvents[1].timestamp).getTime();
      assert.ok(t1 <= t2);
    }

    // Test sort by ip
    const resIp = await fetch(`${serverUrl}/api/admin/traffic?sort=ip&limit=10`);
    assert.equal(resIp.status, 200);
    const dataIp = await resIp.json();
    assert.equal(dataIp.sort, 'ip');
  });

  it('formatEventStory should accurately translate game events into human-readable narratives', () => {
    assert.equal(capitalizeWord('cities_knights'), 'Cities knights');
    assert.equal(capitalizeWord('science'), 'Science');

    // Dice roll with barbarian & event die
    const rollStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'roll_dice',
      playerName: 'Alice',
      dice: { d1: 5, d2: 3, sum: 8 },
      eventDie: 'barbarian',
      barbarianPosition: 4
    });
    assert.ok(rollStory.includes('Alice rolled [5, 3] = 8'));
    assert.ok(rollStory.includes('Barbarian'));
    assert.ok(rollStory.includes('4/7'));

    // Building settlements and cities
    const settleStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'build_settlement',
      playerName: 'Bob',
      vertexId: 24
    });
    assert.ok(settleStory.includes('Bob built a Settlement at intersection #24'));

    const cityStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'build_city',
      playerName: 'Bob',
      vertexId: 24
    });
    assert.ok(cityStory.includes('Bob upgraded Settlement to City at intersection #24'));

    // Road and City Wall
    const roadStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'build_road',
      playerName: 'Charlie',
      edgeId: 10
    });
    assert.ok(roadStory.includes('Charlie paved a Road on path #10'));

    const wallStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'build_city_wall',
      playerName: 'Charlie',
      vertexId: 24
    });
    assert.ok(wallStory.includes('Charlie fortified City with a Wall at intersection #24'));

    // City Improvement
    const improveStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'improve_city',
      playerName: 'Diana',
      track: 'politics'
    });
    assert.ok(improveStory.includes('Diana upgraded City Improvement: Politics'));

    // Knights
    const knightStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'place_knight',
      playerName: 'Eve',
      vertexId: 15
    });
    assert.ok(knightStory.includes('Eve hired a Knight at intersection #15'));

    const moveKnightStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'move_knight',
      playerName: 'Eve',
      fromVertexId: 15,
      toVertexId: 16
    });
    assert.ok(moveKnightStory.includes('Eve moved Knight from intersection #15 to #16'));

    // Bank Trade
    const tradeStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'bank_trade',
      playerName: 'Frank',
      give: 'wood',
      receive: 'ore',
      ratio: 4
    });
    assert.ok(tradeStory.includes('Frank traded with Bank: 4x Wood for 1x Ore'));

    // Progress Card & Dev Card
    const progressStory = formatEventStory({
      type: 'ACTION_SUCCESS',
      action: 'play_progress_card',
      playerName: 'Grace',
      cardId: 'alchemist'
    });
    assert.ok(progressStory.includes('Grace played Progress Card: Alchemist'));

    // Action Error
    const errorStory = formatEventStory({
      type: 'ACTION_ERROR',
      action: 'build_city',
      playerName: 'Hank',
      error: 'NOT_ENOUGH_RESOURCES'
    });
    assert.ok(errorStory.includes('Hank attempted "build_city" but was rejected: NOT_ENOUGH_RESOURCES'));

    // Chat Message
    const chatStory = formatEventStory({
      type: 'CHAT_MESSAGE',
      playerName: 'Ivy',
      text: 'Good luck everyone!'
    });
    assert.ok(chatStory.includes('Ivy: "Good luck everyone!"'));

    // Game Start & Game Over
    const startStory = formatEventStory({
      type: 'GAME_START',
      roomCode: 'W4XYZ',
      startedBy: 'Jack',
      mode: 'cities_knights'
    });
    assert.ok(startStory.includes('Game started in [W4XYZ] by "Jack" (cities_knights mode)'));

    const overStory = formatEventStory({
      type: 'GAME_OVER',
      roomCode: 'W4XYZ',
      winnerName: 'Jack',
      winnerPoints: 13
    });
    assert.ok(overStory.includes('Jack won with 13 Victory Points!'));
  });

  it('GET /api/admin/traffic should support ?mode=simple and ?mode=advanced', async () => {
    // Record sample action event
    recordTrafficEvent({
      type: 'ACTION_SUCCESS',
      action: 'build_settlement',
      playerName: 'TestPlayer',
      roomCode: 'T1234',
      vertexId: 42,
      ip: '127.0.0.1',
      country: 'RO'
    });

    // Simple Mode: raw technical packet format
    const resSimple = await fetch(`${serverUrl}/api/admin/traffic?mode=simple&limit=10`);
    assert.equal(resSimple.status, 200);
    const dataSimple = await resSimple.json();
    assert.equal(dataSimple.mode, 'simple');
    assert.ok(Array.isArray(dataSimple.recentEvents));
    const simpleAction = dataSimple.recentEvents.find(e => e.type === 'ACTION_SUCCESS');
    assert.ok(simpleAction);
    assert.equal(simpleAction.event, 'build_settlement');
    assert.equal(simpleAction.ip, '127.0.0.1');
    assert.equal(simpleAction.country, 'RO');
    assert.equal(simpleAction.story, undefined); // Story is omitted in simple mode

    // Advanced Mode: player action story narrative
    const resAdvanced = await fetch(`${serverUrl}/api/admin/traffic?mode=advanced&limit=10`);
    assert.equal(resAdvanced.status, 200);
    const dataAdvanced = await resAdvanced.json();
    assert.equal(dataAdvanced.mode, 'advanced');
    assert.ok(Array.isArray(dataAdvanced.recentEvents));
    const advancedAction = dataAdvanced.recentEvents.find(e => e.type === 'ACTION_SUCCESS');
    assert.ok(advancedAction);
    assert.equal(advancedAction.player, 'TestPlayer');
    assert.equal(advancedAction.room, 'T1234');
    assert.ok(typeof advancedAction.story === 'string');
    assert.ok(advancedAction.story.includes('TestPlayer built a Settlement at intersection #42'));
  });

  it('GET /admin should contain mode toggle buttons and dynamic table structure', async () => {
    const res = await fetch(`${serverUrl}/admin`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="btn-mode-advanced"'));
    assert.ok(html.includes('id="btn-mode-simple"'));
    assert.ok(html.includes('id="traffic-thead"'));
    assert.ok(html.includes('id="btn-raw-json"'));
    assert.ok(html.includes('id="chat-window-stream"'));
    assert.ok(html.includes('id="btn-clear-logs"'));
    assert.ok(html.includes('id="btn-clear-stream"'));
    assert.ok(html.includes('id="feed-filter-all"'));
    assert.ok(html.includes('id="feed-filter-chat"'));
    assert.ok(html.includes('id="feed-filter-actions"'));
    assert.ok(html.includes('id="feed-filter-errors"'));
    assert.ok(html.includes('id="check-autoscroll"'));
  });

  it('clearTrafficLogs and POST /api/admin/traffic/clear should reset logs buffer and stats', async () => {
    // Add sample events
    recordTrafficEvent({ type: 'TEST_1', ip: '192.168.1.1' });
    recordTrafficEvent({ type: 'TEST_2', ip: '192.168.1.2' });
    assert.ok(trafficBuffer.length >= 2);

    // Call clear endpoint via POST
    const resClear = await fetch(`${serverUrl}/api/admin/traffic/clear`, { method: 'POST' });
    assert.equal(resClear.status, 200);
    const dataClear = await resClear.json();
    assert.equal(dataClear.status, 'ok');
    assert.equal(trafficBuffer.length, 0);

    // Add another event and verify DELETE /api/admin/traffic works too
    recordTrafficEvent({ type: 'TEST_3', ip: '192.168.1.3' });
    assert.equal(trafficBuffer.length, 1);
    const resDelete = await fetch(`${serverUrl}/api/admin/traffic`, { method: 'DELETE' });
    assert.equal(resDelete.status, 200);
    assert.equal(trafficBuffer.length, 0);
  });

  it('recordPlayerIp and playerIps directory should track usernames to IPs', async () => {
    // Record actions with usernames and IPs
    recordTrafficEvent({
      type: 'ACTION_SUCCESS',
      action: 'roll_dice',
      playerName: 'AliceSettler',
      roomCode: 'RM101',
      ip: '10.0.0.15',
      country: 'US'
    });
    recordTrafficEvent({
      type: 'CHAT_MESSAGE',
      playerName: 'AliceSettler',
      roomCode: 'RM101',
      text: 'Good luck everyone!',
      ip: '10.0.0.15',
      country: 'US'
    });
    // Alice reconnects from a secondary IP
    recordTrafficEvent({
      type: 'ACTION_SUCCESS',
      action: 'build_road',
      playerName: 'AliceSettler',
      roomCode: 'RM101',
      ip: '10.0.0.16',
      country: 'US'
    });
    // Bob joins
    recordTrafficEvent({
      type: 'ROOM_JOIN',
      playerName: 'BobKnight',
      roomCode: 'RM101',
      ip: '86.120.10.22',
      country: 'RO'
    });

    assert.ok(trafficStats.playerIps.has('AliceSettler'));
    assert.ok(trafficStats.playerIps.has('BobKnight'));

    const alice = trafficStats.playerIps.get('AliceSettler');
    assert.equal(alice.ip, '10.0.0.16'); // latest IP
    assert.ok(alice.ips.has('10.0.0.15'));
    assert.ok(alice.ips.has('10.0.0.16'));
    assert.equal(alice.country, 'US');
    assert.equal(alice.roomCode, 'RM101');

    // Fetch via GET /api/admin/traffic
    const res = await fetch(`${serverUrl}/api/admin/traffic?limit=50`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.playerIps));
    const aliceApi = data.playerIps.find(p => p.name === 'AliceSettler');
    assert.ok(aliceApi);
    assert.equal(aliceApi.ip, '10.0.0.16');
    assert.deepEqual(aliceApi.ips.sort(), ['10.0.0.15', '10.0.0.16'].sort());
    assert.equal(aliceApi.country, 'US');

    // Test filter by player query parameter: ?player=Alice
    const resFilterPlayer = await fetch(`${serverUrl}/api/admin/traffic?player=alice`);
    assert.equal(resFilterPlayer.status, 200);
    const dataFilter = await resFilterPlayer.json();
    for (const ev of dataFilter.recentEvents) {
      assert.ok(ev.story?.toLowerCase().includes('alice') || ev.player?.toLowerCase().includes('alice'));
    }

    // Verify admin.html contains Player & IP directory UI elements
    const resHtml = await fetch(`${serverUrl}/admin`);
    const html = await resHtml.text();
    assert.ok(html.includes('id="player-directory-tbody"'));
    assert.ok(html.includes('id="stat-identified-players"'));
    assert.ok(html.includes('id="filter-player-directory"'));
    assert.ok(html.includes('badge-ip'));
  });
});
