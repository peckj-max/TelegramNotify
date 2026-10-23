const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const level = (process.env.TELEGRAM_NOTIFY_LOG_LEVEL || 'info').toLowerCase();

function enabled(name) {
  return (LEVELS[name] ?? LEVELS.info) <= (LEVELS[level] ?? LEVELS.info);
}

function stamp() {
  return new Date().toISOString();
}

function emit(stream, name, args) {
  if (!enabled(name)) return;
  stream.write(`${stamp()} ${name.toUpperCase()} `);
  for (const arg of args) {
    stream.write(typeof arg === 'string' ? arg : JSON.stringify(arg));
    stream.write(' ');
  }
  stream.write('\n');
}

export const log = {
  error: (...args) => emit(process.stderr, 'error', args),
  warn: (...args) => emit(process.stderr, 'warn', args),
  info: (...args) => emit(process.stderr, 'info', args),
  debug: (...args) => emit(process.stderr, 'debug', args),
};
