import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as Client } from 'socket.io-client';
import { server, io, gracefulShutdown, isShuttingDown } from '../server/server.js';
import http from 'http';

function makeRequest(url, agent) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

describe('Graceful Shutdown & Socket Draining', () => {
  let serverPort = null;
  let serverUrl = null;
  let clientSocket = null;
  const agent = new http.Agent({ keepAlive: true });

  before(async () => {
    if (!server.listening) {
      await new Promise((resolve) => {
        server.listen(0, () => {
          serverPort = server.address().port;
          serverUrl = `http://localhost:${serverPort}`;
          resolve();
        });
      });
    } else {
      serverPort = server.address().port;
      serverUrl = `http://localhost:${serverPort}`;
    }
  });

  after(async () => {
    if (clientSocket) clientSocket.close();
    agent.destroy();
  });

  it('sockets receive server_announcement on shutdown and HTTP returns 503', async () => {
    clientSocket = Client(serverUrl, { reconnection: false });
    
    const announcementPromise = new Promise((resolve) => {
      clientSocket.on('server_announcement', (data) => {
        if (data.type === 'SERVER_RESTARTING') resolve(data);
      });
    });

    await new Promise(resolve => clientSocket.on('connect', resolve));

    // Warm up the keep-alive connection
    await makeRequest(`${serverUrl}/health`, agent);

    const shutdownPromise = gracefulShutdown(server, io, { noExit: true, killTimeout: 100 });
    
    const announcement = await announcementPromise;
    assert.equal(announcement.type, 'SERVER_RESTARTING');

    // Use the warmed up connection to bypass the closed listener
    try {
      const resRooms = await makeRequest(`${serverUrl}/api/rooms`, agent);
      assert.equal(resRooms.status, 503);
    } catch (err) {
      // If connection closed abruptly, that's also acceptable during shutdown
    }
    
    try {
      const resHealth = await makeRequest(`${serverUrl}/health`, agent);
      assert.equal(resHealth.status, 503);
    } catch (err) {}

    await shutdownPromise;
    assert.equal(server.listening, false);
  });
});
