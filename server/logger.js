/**
 * Structured Logger for HexSettlers Server
 * Supports NDJSON production logging, human-readable development output,
 * child loggers for session correlation (roomCode, playerId), and safe error serialization.
 */

const LOG_LEVELS = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

const LEVEL_NAMES = {
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error'
};

export function serializeError(err, seen = new WeakSet()) {
  if (!err) return null;
  if (err instanceof Error) {
    if (seen.has(err)) return '[Circular Error]';
    seen.add(err);
    const serialized = {
      name: err.name || 'Error',
      message: err.message,
      stack: err.stack,
      ...(err.code !== undefined ? { code: err.code } : {}),
      ...(err.status !== undefined ? { status: err.status } : {})
    };
    if (err.cause !== undefined) {
      serialized.cause = serializeError(err.cause, seen);
    }
    return serialized;
  }
  if (typeof err === 'object') {
    return err;
  }
  return { message: String(err) };
}

export function safeStringify(obj) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  } catch (err) {
    return JSON.stringify({
      level: 'error',
      time: Date.now(),
      msg: 'Failed to serialize log entry',
      err: serializeError(err)
    });
  }
}

export class Logger {
  constructor(options = {}) {
    this.bindings = options.bindings || {};
    this.stream = options.stream || process.stdout;
    this.errorStream = options.errorStream || process.stderr;
    this.isProduction = options.isProduction ?? (process.env.NODE_ENV === 'production');

    const envLevel = (process.env.LOG_LEVEL || '').toLowerCase().trim();
    const defaultLevel = this.isProduction ? 'info' : 'debug';
    let targetLevel = options.level !== undefined ? options.level : (envLevel || defaultLevel);
    if (typeof targetLevel === 'string') {
      targetLevel = targetLevel.toLowerCase().trim();
    }
    if (typeof targetLevel === 'number') {
      this.minLevel = targetLevel;
    } else {
      this.minLevel = LOG_LEVELS[targetLevel] ?? (this.isProduction ? LOG_LEVELS.info : LOG_LEVELS.debug);
    }
  }

  child(bindings = {}) {
    return new Logger({
      bindings: { ...this.bindings, ...bindings },
      stream: this.stream,
      errorStream: this.errorStream,
      isProduction: this.isProduction,
      level: LEVEL_NAMES[this.minLevel]
    });
  }

  _log(levelNum, arg1, arg2) {
    if (levelNum < this.minLevel) return;

    let meta = {};
    let msg = '';

    if (typeof arg1 === 'string') {
      msg = arg1;
      if (arg2 instanceof Error) {
        meta = { err: serializeError(arg2) };
      } else if (typeof arg2 === 'object' && arg2 !== null) {
        meta = { ...arg2 };
        if (meta.err && meta.err instanceof Error) {
          meta.err = serializeError(meta.err);
        }
        if (meta.error && meta.error instanceof Error) {
          meta.error = serializeError(meta.error);
        }
      } else if (arg2 !== undefined) {
        msg = `${arg1} ${String(arg2)}`;
      }
    } else if (arg1 instanceof Error) {
      meta = { err: serializeError(arg1) };
      msg = typeof arg2 === 'string' ? arg2 : arg1.message;
    } else if (typeof arg1 === 'object' && arg1 !== null) {
      meta = { ...arg1 };
      if (meta.err && meta.err instanceof Error) {
        meta.err = serializeError(meta.err);
      }
      if (meta.error && meta.error instanceof Error) {
        meta.error = serializeError(meta.error);
      }
      msg = typeof arg2 === 'string' ? arg2 : (meta.msg || meta.message || '');
      delete meta.msg;
      delete meta.message;
    } else if (arg1 !== undefined) {
      msg = String(arg1);
      if (arg2 instanceof Error) {
        meta = { err: serializeError(arg2) };
      } else if (typeof arg2 === 'object' && arg2 !== null) {
        meta = { ...arg2 };
      } else if (typeof arg2 === 'string') {
        msg = `${msg} ${arg2}`;
      }
    }

    const levelStr = LEVEL_NAMES[levelNum] || 'info';

    if (this.isProduction) {
      const record = {
        level: levelStr,
        time: Date.now(),
        pid: process.pid,
        ...this.bindings,
        ...meta,
        msg
      };
      const line = safeStringify(record) + '\n';
      if (levelNum >= LOG_LEVELS.error) {
        this.errorStream.write(line);
      } else {
        this.stream.write(line);
      }
    } else {
      const timeStr = new Date().toLocaleTimeString();
      const prefix = `[${timeStr}] [${levelStr.toUpperCase()}]`;
      const allMeta = { ...this.bindings, ...meta };
      const hasMeta = Object.keys(allMeta).length > 0;
      const metaStr = hasMeta ? ` ${safeStringify(allMeta)}` : '';
      const line = `${prefix} ${msg}${metaStr}\n`;
      if (levelNum >= LOG_LEVELS.error) {
        this.errorStream.write(line);
      } else {
        this.stream.write(line);
      }
    }
  }

  debug(arg1, arg2) {
    this._log(LOG_LEVELS.debug, arg1, arg2);
  }

  info(arg1, arg2) {
    this._log(LOG_LEVELS.info, arg1, arg2);
  }

  warn(arg1, arg2) {
    this._log(LOG_LEVELS.warn, arg1, arg2);
  }

  error(arg1, arg2) {
    this._log(LOG_LEVELS.error, arg1, arg2);
  }
}

export function createLogger(options = {}) {
  return new Logger(options);
}

export const logger = new Logger();
