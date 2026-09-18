import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, createLogger, serializeError, safeStringify } from '../server/logger.js';
import { isValidSentryDsn } from '../server/server.js';

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

  it('handles nested causes and circular causes in serializeError', () => {
    const rootErr = new Error('Root cause');
    const wrapperErr = new Error('Wrapper failure', { cause: rootErr });
    const serialized = serializeError(wrapperErr);
    assert.equal(serialized.message, 'Wrapper failure');
    assert.equal(serialized.cause.message, 'Root cause');

    // Circular cause
    const cyclicA = new Error('Cyclic A');
    const cyclicB = new Error('Cyclic B');
    cyclicA.cause = cyclicB;
    cyclicB.cause = cyclicA;
    const serializedCyclic = serializeError(cyclicA);
    assert.equal(serializedCyclic.message, 'Cyclic A');
    assert.equal(serializedCyclic.cause.message, 'Cyclic B');
    assert.equal(serializedCyclic.cause.cause, '[Circular Error]');
  });

  it('handles non-Error objects in serializeError', () => {
    assert.equal(serializeError(null), null);
    assert.deepEqual(serializeError({ code: 500 }), { code: 500 });
    assert.deepEqual(serializeError('string error'), { message: 'string error' });
  });

  it('handles circular references and BigInt safely in safeStringify', () => {
    const obj = { id: 1, count: 9007199254740991n };
    obj.self = obj;
    const jsonStr = safeStringify(obj);
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.id, 1);
    assert.equal(parsed.count, '9007199254740991');
    assert.equal(parsed.self, '[Circular]');
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

  it('handles logger.error("Message", err) without swallowing Error properties', () => {
    const errorStream = new MockWritable();
    const logger = createLogger({
      errorStream,
      isProduction: true,
      level: 'error'
    });

    const err = new TypeError('Cannot read properties of undefined');
    logger.error('Unhandled failure', err);

    assert.equal(errorStream.lines.length, 1);
    const json = errorStream.lastJson;
    assert.equal(json.msg, 'Unhandled failure');
    assert.equal(json.err.name, 'TypeError');
    assert.equal(json.err.message, 'Cannot read properties of undefined');
    assert.ok(json.err.stack);
  });

  it('handles logger.error("Message", { error: err }) properly', () => {
    const errorStream = new MockWritable();
    const logger = createLogger({
      errorStream,
      isProduction: true,
      level: 'error'
    });

    const err = new Error('Something broke');
    logger.error('Failed request', { error: err });

    assert.equal(errorStream.lines.length, 1);
    const json = errorStream.lastJson;
    assert.equal(json.msg, 'Failed request');
    assert.equal(json.error.name, 'Error');
    assert.equal(json.error.message, 'Something broke');
  });

  it('handles primitive arguments without dropping messages', () => {
    const stream = new MockWritable();
    const logger = createLogger({
      stream,
      isProduction: true,
      level: 'info'
    });

    logger.info(404);
    assert.equal(stream.lastJson.msg, '404');

    logger.info(true, 'status');
    assert.equal(stream.lastJson.msg, 'true status');
  });

  it('supports case-insensitive and numeric log levels', () => {
    const streamUpper = new MockWritable();
    const loggerUpper = createLogger({
      stream: streamUpper,
      isProduction: true,
      level: 'WARN'
    });
    loggerUpper.info('should ignore');
    loggerUpper.warn('should log');
    assert.equal(streamUpper.lines.length, 1);
    assert.equal(streamUpper.lastJson.msg, 'should log');

    const streamNum = new MockWritable();
    const loggerNum = createLogger({
      stream: streamNum,
      isProduction: true,
      level: 40 // warn
    });
    loggerNum.info('should ignore');
    loggerNum.warn('should log');
    assert.equal(streamNum.lines.length, 1);
    assert.equal(streamNum.lastJson.msg, 'should log');
  });

  it('handles circular references and BigInt inside logged metadata', () => {
    const stream = new MockWritable();
    const logger = createLogger({
      stream,
      isProduction: true,
      level: 'info'
    });

    const circular = { name: 'cycle' };
    circular.loop = circular;
    circular.score = 500n;

    logger.info(circular, 'Circular payload');
    const json = stream.lastJson;
    assert.equal(json.msg, 'Circular payload');
    assert.equal(json.name, 'cycle');
    assert.equal(json.score, '500');
    assert.equal(json.loop.loop, '[Circular]');
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

  it('validates Sentry DSN URLs correctly', () => {
    assert.equal(isValidSentryDsn('https://abc@o123.ingest.sentry.io/456'), true);
    assert.equal(isValidSentryDsn('http://localhost:9000/1'), true);
    assert.equal(isValidSentryDsn('not-a-url'), false);
    assert.equal(isValidSentryDsn(''), false);
    assert.equal(isValidSentryDsn(null), false);
    assert.equal(isValidSentryDsn(undefined), false);
    assert.equal(isValidSentryDsn('ftp://invalid.scheme/1'), false);
  });
});
