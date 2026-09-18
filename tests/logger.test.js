import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, createLogger, serializeError } from '../server/logger.js';

class MockWritable {
  constructor() {
    this.chunks = [];
  }
  write(chunk) {
    this.chunks.push(chunk);
    return true;
  }
  get lines() {
    return this.chunks.join('').trim().split('\n').filter(Boolean);
  }
  get lastJson() {
    const last = this.lines[this.lines.length - 1];
    return last ? JSON.parse(last) : null;
  }
}

describe('OPS-03: Structured Logger (server/logger.js)', () => {
  it('serializes standard Error objects properly', () => {
    const err = new Error('Database connection failed');
    err.code = 'ECONNREFUSED';
    const serialized = serializeError(err);
    assert.equal(serialized.name, 'Error');
    assert.equal(serialized.message, 'Database connection failed');
    assert.equal(serialized.code, 'ECONNREFUSED');
    assert.ok(typeof serialized.stack === 'string');
  });

  it('handles non-Error objects in serializeError', () => {
    assert.equal(serializeError(null), null);
    assert.deepEqual(serializeError({ code: 500 }), { code: 500 });
    assert.deepEqual(serializeError('string error'), { message: 'string error' });
  });

  it('emits NDJSON in production mode with standard fields', () => {
    const stream = new MockWritable();
    const logger = createLogger({
      stream,
      isProduction: true,
      level: 'info'
    });

    logger.info({ roomCode: 'ROOM1', playerId: 'p123' }, 'Player joined game');

    assert.equal(stream.lines.length, 1);
    const json = stream.lastJson;
    assert.equal(json.level, 'info');
    assert.equal(json.msg, 'Player joined game');
    assert.equal(json.roomCode, 'ROOM1');
    assert.equal(json.playerId, 'p123');
    assert.equal(typeof json.time, 'number');
    assert.equal(typeof json.pid, 'number');
  });

  it('routes error logs to errorStream in production mode', () => {
    const stream = new MockWritable();
    const errorStream = new MockWritable();
    const logger = createLogger({
      stream,
      errorStream,
      isProduction: true,
      level: 'debug'
    });

    logger.error(new Error('Fatal error'), 'Server crashed');

    assert.equal(stream.lines.length, 0);
    assert.equal(errorStream.lines.length, 1);
    const json = errorStream.lastJson;
    assert.equal(json.level, 'error');
    assert.equal(json.msg, 'Server crashed');
    assert.equal(json.err.message, 'Fatal error');
  });

  it('respects minimum log levels', () => {
    const stream = new MockWritable();
    const logger = createLogger({
      stream,
      isProduction: true,
      level: 'warn'
    });

    logger.debug('should be filtered');
    logger.info('should also be filtered');
    logger.warn('warning emitted');

    assert.equal(stream.lines.length, 1);
    assert.equal(stream.lastJson.msg, 'warning emitted');
  });

  it('supports child loggers with inherited and merged bindings', () => {
    const stream = new MockWritable();
    const parent = createLogger({
      stream,
      isProduction: true,
      bindings: { service: 'catan-server' },
      level: 'info'
    });

    const roomLogger = parent.child({ roomCode: 'ABCD' });
    const playerLogger = roomLogger.child({ playerId: 'u456' });

    playerLogger.info({ action: 'roll_dice' }, 'Dice rolled');

    const json = stream.lastJson;
    assert.equal(json.service, 'catan-server');
    assert.equal(json.roomCode, 'ABCD');
    assert.equal(json.playerId, 'u456');
    assert.equal(json.action, 'roll_dice');
    assert.equal(json.msg, 'Dice rolled');
  });

  it('provides readable human output in development mode', () => {
    const stream = new MockWritable();
    const logger = createLogger({
      stream,
      isProduction: false,
      level: 'info'
    });

    logger.info({ roomCode: 'TEST1' }, 'Lobby opened');

    assert.equal(stream.lines.length, 1);
    const line = stream.lines[0];
    assert.match(line, /\[INFO\] Lobby opened \{"roomCode":"TEST1"\}/);
  });
});
