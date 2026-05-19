// workers/prices/logger.js
// Structured JSON logger — works with journald, PM2, Datadog, CloudWatch

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function log(level, msg, meta = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const entry = {
    ts:    new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (msg, meta)  => log('debug', msg, meta),
  info:  (msg, meta)  => log('info',  msg, meta),
  warn:  (msg, meta)  => log('warn',  msg, meta),
  error: (msg, meta)  => log('error', msg, meta),
  ok:    (msg, meta)  => log('info',  `✅ ${msg}`, meta),
  fail:  (msg, meta)  => log('error', `❌ ${msg}`, meta),
  skip:  (msg, meta)  => log('info',  `⏭  ${msg}`, meta),
};
