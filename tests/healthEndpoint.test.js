import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server, io } from '../server/server.js';

describe('API: Health Check & System Telemetry', () => {
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

  it('should return status 200, status ok, uptime, memory, and activeRooms', async () => {
    const res = await fetch(`${serverUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(typeof data.uptime, 'number');
    assert.ok(data.uptime >= 0);
    assert.equal(typeof data.timestamp, 'number');
    assert.equal(typeof data.memory.rss, 'number');
    assert.equal(typeof data.memory.heapUsed, 'number');
    assert.equal(typeof data.activeRooms, 'number');
  });

  it('should include correct Content-Type header', async () => {
    const res = await fetch(`${serverUrl}/api/health`);
    assert.ok(res.headers.get('content-type').includes('application/json'));
  });
});
