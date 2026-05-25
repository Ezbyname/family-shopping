// ecosystem.config.cjs
// PM2 configuration for family-shopping price sync system
// Usage: pm2 start ecosystem.config.cjs --only price-sync-worker
//        pm2 start ecosystem.config.cjs --only price-sanity-live

const HOME = '/home/yahalom_assets';
const PROJECT = `${HOME}/family-shopping`;
const LOGS = `${HOME}/price-worker-logs`;
const WORKER  = `${PROJECT}/workers/prices`;   // cwd for price-sync-worker (dotenv reads .env here)
const SCRIPTS = `${PROJECT}/scripts`;          // cwd for price-sanity-live (dotenv reads .env here)

module.exports = {
  apps: [
    // ─────────────────────────────────────────────────────────────────
    // Price Sync Worker — runs every day at 06:00 & 18:00 Israel time
    // ─────────────────────────────────────────────────────────────────
    {
      name: 'price-sync-worker',
      script: 'index.js',   // relative to cwd (workers/prices/)
      cwd: WORKER,          // process.cwd() = workers/prices/ → dotenv finds .env here
      instances: 1,
      exec_mode: 'fork',
      error_file: `${LOGS}/sync.error.log`,
      out_file:   `${LOGS}/sync.out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // 03:00 & 15:00 UTC = 06:00 & 18:00 Israel time (UTC+3)
      cron_restart: '0 3,15 * * *',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        // Firebase credentials are loaded from workers/prices/.env
        // Make sure DRY_RUN and BYPASS_IP_CHECK are NOT set (or empty)
      },
      watch: false,
      ignore_watch: ['node_modules', '.git', 'data'],
      max_memory_restart: '2G',
      autorestart: false,   // cron job — don't loop-restart on exit
      max_restarts: 3,
      min_uptime: '30s',    // 50-store sync takes ~3.5 min; 30s gives enough runway before crash-flag
    },

    // ─────────────────────────────────────────────────────────────────
    // Live Sanity Check — runs same schedule, verifies chain sources
    // ─────────────────────────────────────────────────────────────────
    {
      name: 'price-sanity-live',
      script: 'sanity-live.js', // relative to cwd (scripts/)
      cwd: SCRIPTS,             // process.cwd() = scripts/ → dotenv finds .env here
      instances: 1,
      exec_mode: 'fork',
      error_file: `${LOGS}/sanity.error.log`,
      out_file:   `${LOGS}/sanity.out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      cron_restart: '0 3,15 * * *',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      watch: false,
      ignore_watch: ['node_modules', '.git', 'data'],
      max_memory_restart: '2G',
      autorestart: false,
      max_restarts: 3,
      min_uptime: '30s',    // give enough runway before crash-flag fires
    },
  ],
};
