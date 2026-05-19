// workers/prices/config.js — v2.0.0 (hardened)
// All configuration from environment variables only.
// Validates and fails fast with clear error messages.

const REQUIRED = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_DATABASE_URL',
];

function require_env(name) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `  Copy .env.example to .env and fill in all required values.`
    );
  }
  return val.trim();
}

function optional_env(name, defaultVal = '') {
  const val = process.env[name];
  return (val !== undefined && val !== '') ? val : defaultVal;
}

function optional_int(name, defaultVal) {
  const val = parseInt(optional_env(name, String(defaultVal)));
  if (isNaN(val) || val <= 0) {
    throw new Error(`Invalid value for ${name}: must be a positive integer`);
  }
  return val;
}

export function loadConfig() {
  // Fail fast — check all required vars before doing anything else
  const missing = REQUIRED.filter(k => !process.env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n` +
      missing.map(k => `  • ${k}`).join('\n') +
      `\n\nSee .env.example for setup instructions.`
    );
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const dryRun       = process.env.DRY_RUN === 'true';

  // Warn about dry run in production
  if (dryRun && isProduction) {
    // Allowed — useful for production validation
    console.warn('[config] DRY_RUN=true in production — no Firebase writes will occur');
  }

  return {
    env:        process.env.NODE_ENV || 'development',
    isProduction,
    dryRun,

    firebase: {
      projectId:   require_env('FIREBASE_PROJECT_ID'),
      clientEmail: require_env('FIREBASE_CLIENT_EMAIL'),
      // Normalize private key: handle both literal \n and real newlines
      privateKey:  require_env('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      databaseURL: require_env('FIREBASE_DATABASE_URL'),
    },

    worker: {
      // Comma-separated chain IDs to sync (empty = all enabled)
      enabledChains:   optional_env('ENABLED_CHAINS', '')
        .split(',').map(s => s.trim()).filter(Boolean),
      // Sync concurrency (1 = sequential, safe; >1 = faster but more RAM)
      concurrency:     optional_int('SYNC_CONCURRENCY', 1),
      // Firebase batch write size (max 400 for safety under 500 limit)
      batchSize:       optional_int('BATCH_SIZE', 400),
      // Per-file download timeout in ms
      downloadTimeout: optional_int('DOWNLOAD_TIMEOUT_MS', 120_000),
      // Retry attempts per file download
      downloadRetries: optional_int('DOWNLOAD_RETRIES', 3),
    },

    // Optional Slack webhook for critical failure alerts
    slackWebhook: optional_env('SLACK_WEBHOOK_URL', ''),
  };
}
