#!/usr/bin/env node
// scripts/admin-server.js
// Admin API for remote sanity check trigger
// Requires: SANITY_ADMIN_TOKEN, Firebase credentials

import express from 'express';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const HOST = process.env.HOST || '127.0.0.1'; // Bind to localhost by default
const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.SANITY_ADMIN_TOKEN;

let firebaseDb = null;
let sanityRunning = false;
let lastRunTime = 0;

// ─────────────────────────────────────────────────────────────────
// Audit logging
// ─────────────────────────────────────────────────────────────────
function auditLog(method, endpoint, status, ip, duration, message = '') {
  const timestamp = new Date().toISOString();
  const durationMs = duration ? `${duration.toFixed(0)}ms` : 'N/A';
  const logMessage = `[${timestamp}] ${method.padEnd(6)} ${endpoint.padEnd(30)} ${status.toString().padEnd(3)} IP:${ip.padEnd(15)} ${durationMs.padEnd(8)} ${message}`;
  console.log(logMessage);
}

// ─────────────────────────────────────────────────────────────────
// Validate environment on startup
// ─────────────────────────────────────────────────────────────────
function validateEnvironment() {
  const errors = [];

  // Check SANITY_ADMIN_TOKEN
  if (!ADMIN_TOKEN) {
    errors.push('❌ SANITY_ADMIN_TOKEN not set in .env');
  } else if (ADMIN_TOKEN.length < 32) {
    errors.push(`❌ SANITY_ADMIN_TOKEN must be >= 32 chars (current: ${ADMIN_TOKEN.length})`);
  }

  // Check Firebase credentials
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const dbUrl = process.env.FIREBASE_DATABASE_URL;

  if (!projectId) errors.push('❌ FIREBASE_PROJECT_ID not set');
  if (!clientEmail) errors.push('❌ FIREBASE_CLIENT_EMAIL not set');
  if (!privateKey) errors.push('❌ FIREBASE_PRIVATE_KEY not set');
  if (!dbUrl) errors.push('❌ FIREBASE_DATABASE_URL not set');

  if (errors.length > 0) {
    console.error('\n⚠️  ENVIRONMENT VALIDATION FAILED\n');
    errors.forEach(e => console.error(e));
    console.error('\nRequired environment variables:');
    console.error('  - SANITY_ADMIN_TOKEN (>= 32 chars)');
    console.error('  - FIREBASE_PROJECT_ID');
    console.error('  - FIREBASE_CLIENT_EMAIL');
    console.error('  - FIREBASE_PRIVATE_KEY');
    console.error('  - FIREBASE_DATABASE_URL');
    console.error('\nFix .env and restart.\n');
    process.exit(1);
  }

  console.log('✅ Environment validation passed');
}

// Get caller IP (safe extraction from request)
function getCallerIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.connection.remoteAddress ||
    'unknown'
  );
}

// ─────────────────────────────────────────────────────────────────
// Initialize Firebase
// ─────────────────────────────────────────────────────────────────
async function initFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const url = process.env.FIREBASE_DATABASE_URL;

  if (!projectId || !clientEmail || !privateKey || !url) {
    console.warn('⚠️ Firebase credentials not available');
    return null;
  }

  try {
    if (!getApps().length) {
      const key = privateKey.replace(/\\n/g, '\n');
      initializeApp({
        credential: cert({ projectId, clientEmail, privateKey: key }),
        databaseURL: url,
      });
    }
    firebaseDb = getDatabase();
    console.log('✅ Firebase initialized');
    return firebaseDb;
  } catch (err) {
    console.warn(`⚠️ Firebase init failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Middleware: Check admin token + audit logging
// ─────────────────────────────────────────────────────────────────
function requireAdminToken(req, res, next) {
  const startTime = Date.now();
  const token = req.headers['x-admin-token'];
  const ip = getCallerIp(req);
  const endpoint = req.path;

  if (!token) {
    const duration = Date.now() - startTime;
    auditLog('POST', endpoint, 401, ip, duration, 'Missing token');
    return res.status(401).json({
      ok: false,
      error: 'Missing x-admin-token header',
      code: 'NO_TOKEN',
    });
  }

  if (token !== ADMIN_TOKEN) {
    const duration = Date.now() - startTime;
    auditLog('POST', endpoint, 401, ip, duration, 'Invalid token');
    return res.status(401).json({
      ok: false,
      error: 'Invalid admin token',
      code: 'INVALID_TOKEN',
    });
  }

  // Store timing info in request for logging in endpoint
  req.startTime = startTime;
  req.callerIp = ip;

  next();
}

// ─────────────────────────────────────────────────────────────────
// POST /admin/run-live-sanity
// ─────────────────────────────────────────────────────────────────
app.post('/admin/run-live-sanity', requireAdminToken, async (req, res) => {
  // Check if sanity check is already running
  if (sanityRunning) {
    return res.status(409).json({
      ok: false,
      error: 'Live sanity check already running',
      code: 'ALREADY_RUNNING',
      lastRun: new Date(lastRunTime).toISOString(),
    });
  }

  // Check minimum time between runs (prevent spam)
  const timeSinceLastRun = Date.now() - lastRunTime;
  if (timeSinceLastRun < 60000) {
    // 60 second cooldown
    return res.status(429).json({
      ok: false,
      error: 'Too many requests. Minimum 60 seconds between runs.',
      code: 'RATE_LIMITED',
      secondsUntilRetry: Math.ceil((60000 - timeSinceLastRun) / 1000),
    });
  }

  sanityRunning = true;
  lastRunTime = Date.now();
  const startTime = Date.now();
  let output = '';

  try {
    // Spawn the sanity check process
    const child = spawn('node', ['sanity-live.js'], {
      cwd: __dirname,
      stdio: 'pipe',
      timeout: 300000, // 5 minute timeout
    });

    // Capture stdout and stderr
    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    // Wait for process to finish
    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', (err) => {
        output += `\n❌ Process error: ${err.message}\n`;
        resolve(1);
      });
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    // Read latest Firebase status
    let latestStatus = null;
    if (firebaseDb) {
      try {
        const snap = await firebaseDb.ref('latestPriceSanityStatus').once('value');
        latestStatus = snap.val();
      } catch (err) {
        console.warn(`⚠️ Failed to read Firebase status: ${err.message}`);
      }
    }

    sanityRunning = false;

    // Determine overall status
    const status = latestStatus?.status || (exitCode === 0 ? 'pass' : 'fail');

    // Audit log
    const totalDuration = Date.now() - req.startTime;
    auditLog('POST', '/admin/run-live-sanity', 200, req.callerIp, totalDuration, `Status: ${status}`);

    return res.status(200).json({
      ok: true,
      status,
      output,
      latestPriceSanityStatus: latestStatus || null,
      elapsed: parseFloat(elapsed),
      exitCode,
    });
  } catch (err) {
    sanityRunning = false;

    const totalDuration = Date.now() - req.startTime;
    auditLog('POST', '/admin/run-live-sanity', 500, req.callerIp, totalDuration, `Error: ${err.message}`);

    return res.status(500).json({
      ok: false,
      error: `Failed to run sanity check: ${err.message}`,
      code: 'EXECUTION_ERROR',
      output,
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/live-sanity-status
// ─────────────────────────────────────────────────────────────────
app.get('/admin/live-sanity-status', requireAdminToken, async (req, res) => {
  const startTime = Date.now();

  if (!firebaseDb) {
    const duration = Date.now() - req.startTime;
    auditLog('GET', '/admin/live-sanity-status', 503, req.callerIp, duration, 'Firebase unavailable');
    return res.status(503).json({
      ok: false,
      error: 'Firebase not available',
      code: 'FIREBASE_UNAVAILABLE',
    });
  }

  try {
    const snap = await firebaseDb.ref('latestPriceSanityStatus').once('value');
    const status = snap.val();

    if (!status) {
      const duration = Date.now() - req.startTime;
      auditLog('GET', '/admin/live-sanity-status', 404, req.callerIp, duration, 'No status found');
      return res.status(404).json({
        ok: false,
        error: 'No sanity check status found in Firebase',
        code: 'NOT_FOUND',
      });
    }

    // Parse the results and summarize
    const chainResults = status.results || {};
    const chainSummary = Object.entries(chainResults).map(([chainId, result]) => ({
      chainId,
      status: result.status,
      barcode: result.barcode,
      name: result.name,
      price: result.price,
      storeId: result.storeId,
      error: result.error,
    }));

    const duration = Date.now() - req.startTime;
    auditLog('GET', '/admin/live-sanity-status', 200, req.callerIp, duration, `Status: ${status.status}`);

    return res.status(200).json({
      ok: true,
      status: status.status,
      running: sanityRunning,
      checkedAt: status.checkedAt,
      runId: status.runId,
      chainsTested: status.chainsTested,
      chainsPassed: status.chainsPassed,
      chainsFailed: status.chainsFailed,
      chains: chainSummary,
      raw: status, // Full data for advanced users
    });
  } catch (err) {
    const duration = Date.now() - req.startTime;
    auditLog('GET', '/admin/live-sanity-status', 500, req.callerIp, duration, `Error: ${err.message}`);

    return res.status(500).json({
      ok: false,
      error: `Failed to read Firebase status: ${err.message}`,
      code: 'FIREBASE_ERROR',
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/panel  — serve the status UI (no auth on HTML itself;
//                     browser JS calls /admin/live-sanity-status with token)
// ─────────────────────────────────────────────────────────────────
app.get('/admin/panel', (req, res) => {
  const ip = getCallerIp(req);
  auditLog('GET', '/admin/panel', 200, ip, 0, 'Panel served');
  res.sendFile(join(__dirname, 'admin-panel.html'));
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/health (no auth required)
// ─────────────────────────────────────────────────────────────────
app.get('/admin/health', (req, res) => {
  const startTime = Date.now();
  const ip = getCallerIp(req);

  const duration = Date.now() - startTime;
  auditLog('GET', '/admin/health', 200, ip, duration, 'Health check');

  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    firebaseReady: firebaseDb !== null,
    sanityRunning,
    lastRun: lastRunTime > 0 ? new Date(lastRunTime).toISOString() : 'never',
  });
});

// ─────────────────────────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`❌ Unhandled error: ${err.message}`);
  res.status(500).json({
    ok: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

// ─────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────
async function start() {
  console.log('\n📋 STARTUP VALIDATION\n');

  // Validate environment
  validateEnvironment();

  // Initialize Firebase
  console.log('\n📡 Initializing Firebase...');
  await initFirebase();

  // Start server
  app.listen(PORT, HOST, () => {
    console.log(`\n✅ Admin API started securely\n`);
    console.log(`🔒 SECURITY CONFIGURATION:`);
    console.log(`   Bind address: ${HOST} (localhost only by default)`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Token length: ${ADMIN_TOKEN.length} chars`);
    console.log(`   Audit logging: ENABLED`);
    console.log(`\n📍 ENDPOINTS:`);
    console.log(`   GET    /admin/panel                (status UI — open in browser)`);
    console.log(`   POST   /admin/run-live-sanity      (requires x-admin-token header)`);
    console.log(`   GET    /admin/live-sanity-status   (requires x-admin-token header)`);
    console.log(`   GET    /admin/health               (no auth required)`);
    console.log(`\n🔐 ACCESS METHODS:`);
    console.log(`   Local VM:   curl -H "x-admin-token: \$SANITY_ADMIN_TOKEN" http://127.0.0.1:${PORT}/...`);
    console.log(`   SSH tunnel: ssh -L 8080:127.0.0.1:${PORT} price-worker@<vm-ip>`);
    console.log(`   Nginx:      Configure reverse proxy with HTTPS + IP allowlist`);
    console.log(`\n⚠️  IMPORTANT: Do NOT expose port ${PORT} to the public internet without HTTPS + authentication\n`);
  });
}

start().catch((err) => {
  console.error(`❌ Failed to start: ${err.message}`);
  process.exit(1);
});
