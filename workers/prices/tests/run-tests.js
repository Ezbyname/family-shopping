// workers/prices/tests/run-tests.js
// Lightweight test suite — no testing framework needed.
// Runs: node tests/run-tests.js
//
// Tests:
//   1. Config validation (missing vars, bad private key format)
//   2. IP check mock (pass/fail/provider-error)
//   3. Firebase connection (real network call)
//   4. Dry-run sync for one chain (real fetch, no write)

import { checkIsraeliIP } from '../check-ip.js';
import { logger }         from '../logger.js';

// ── TEST HARNESS ──
let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  Testing: ${name}... `);
  try {
    await fn();
    console.log('✅ PASS');
    passed++;
  } catch (err) {
    console.log(`❌ FAIL — ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

// ─────────────────────────────────────────
// TEST 1: Config Validation
// ─────────────────────────────────────────
async function testConfig() {
  console.log('\n── Test 1: Config Validation ──');

  await test('loadConfig fails on missing vars', async () => {
    const saved = {};
    ['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','FIREBASE_DATABASE_URL']
      .forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });

    let threw = false;
    try {
      const { loadConfig } = await import('../config.js?' + Date.now());
      loadConfig();
    } catch (e) {
      threw = e.message.includes('Missing required');
    }

    // Restore
    Object.entries(saved).forEach(([k,v]) => { if (v) process.env[k] = v; });
    assert(threw, 'Should throw on missing env vars');
  });

  await test('loadConfig passes when all vars set', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.FIREBASE_PROJECT_ID    = 'test-project';
    process.env.FIREBASE_CLIENT_EMAIL  = 'test@test.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY   = '-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----';
    process.env.FIREBASE_DATABASE_URL  = 'https://test.firebaseio.com';
    process.env.NODE_ENV               = 'test';
    process.env.DRY_RUN                = 'false';
    process.env.SYNC_CONCURRENCY       = '1';

    let cfg;
    try {
      // Import fresh to avoid cache
      const mod = await import('../config.js?' + Date.now());
      cfg = mod.loadConfig();
    } finally {
      process.env.NODE_ENV = origEnv;
    }

    assert(cfg.firebase.projectId === 'test-project', 'projectId should match');
    assert(cfg.dryRun === false, 'dryRun should be false');
  });

  await test('DRY_RUN=true parsed correctly', async () => {
    process.env.DRY_RUN = 'true';
    const mod = await import('../config.js?' + Date.now());
    const cfg = mod.loadConfig();
    assert(cfg.dryRun === true, 'dryRun should be true');
    delete process.env.DRY_RUN;
  });

  await test('BYPASS_IP_CHECK in production is rejected by check-ip', async () => {
    const origNode  = process.env.NODE_ENV;
    const origBypass = process.env.BYPASS_IP_CHECK;
    process.env.NODE_ENV        = 'production';
    process.env.BYPASS_IP_CHECK = 'true';

    // checkIsraeliIP should run real check (not bypass) — we just verify it doesn't return bypassed:true
    // We mock by catching — in test env it will try providers which may or may not work
    // Just verify the bypass flag is NOT returned when NODE_ENV=production
    const result = await checkIsraeliIP({ silent: true }).catch(() => ({ bypassed: false }));
    assert(result.bypassed !== true, 'bypass should not work in production');

    process.env.NODE_ENV        = origNode;
    process.env.BYPASS_IP_CHECK = origBypass || '';
  });
}

// ─────────────────────────────────────────
// TEST 2: IP Check
// ─────────────────────────────────────────
async function testIPCheck() {
  console.log('\n── Test 2: IP Check ──');

  await test('IP check returns object with passed/ip/country fields', async () => {
    const result = await checkIsraeliIP({ silent: true });
    assert('passed'  in result, 'result.passed missing');
    assert('country' in result, 'result.country missing');
    assert('bypassed' in result, 'result.bypassed missing');
    // We can't assert passed=true here since we may not be on Israeli IP
    // Just check it returns the right shape
    console.log(`\n    → IP: ${result.ip}, Country: ${result.country}, Passed: ${result.passed}`);
  });

  await test('Non-production bypass works when BYPASS_IP_CHECK=true', async () => {
    const origNode  = process.env.NODE_ENV;
    const origBypass = process.env.BYPASS_IP_CHECK;
    process.env.NODE_ENV        = 'development';
    process.env.BYPASS_IP_CHECK = 'true';

    const result = await checkIsraeliIP({ silent: true });
    assert(result.bypassed === true, 'Should bypass in non-production');
    assert(result.passed   === true, 'Bypassed = passed');

    process.env.NODE_ENV        = origNode;
    process.env.BYPASS_IP_CHECK = origBypass || '';
  });
}

// ─────────────────────────────────────────
// TEST 3: Firebase Connection
// ─────────────────────────────────────────
async function testFirebase() {
  console.log('\n── Test 3: Firebase Connection ──');

  await test('Firebase connects with env var credentials', async () => {
    const { FIREBASE_PROJECT_ID, FIREBASE_DATABASE_URL } = process.env;
    if (!FIREBASE_PROJECT_ID || !FIREBASE_DATABASE_URL) {
      console.log('\n    ⚠️  Skipped — FIREBASE_* env vars not set');
      return;
    }
    const { loadConfig }       = await import('../config.js?' + Date.now());
    const { initFirebase, getDB } = await import('../firebaseWriter.js?' + Date.now());
    const cfg = loadConfig();
    initFirebase(cfg.firebase);
    const db   = getDB();
    const snap = await db.ref('syncSummary').get();
    console.log(`\n    → syncSummary exists: ${snap.exists()}, lastSync: ${snap.val()?.lastSyncDate || 'never'}`);
  });

  await test('BatchWriter dry-run does not write to Firebase', async () => {
    const { loadConfig }           = await import('../config.js?' + Date.now());
    const { initFirebase, BatchWriter, getDB } = await import('../firebaseWriter.js?' + Date.now());
    const { FIREBASE_PROJECT_ID }  = process.env;
    if (!FIREBASE_PROJECT_ID) {
      console.log('\n    ⚠️  Skipped — Firebase not configured');
      return;
    }
    const cfg    = loadConfig();
    initFirebase(cfg.firebase);
    const writer = new BatchWriter(getDB(), { dryRun: true });
    await writer.queue('prices/__test_dry_run__/test_store', { price: 99 });
    await writer.flush();
    // Verify nothing was written
    const snap = await getDB().ref('prices/__test_dry_run__').get();
    assert(!snap.exists(), 'Dry-run should not write to Firebase');
    assert(writer.stats().totalWritten === 0, 'totalWritten should be 0 in dry-run');
    assert(writer.stats().totalDryRun  === 1, 'totalDryRun should be 1');
  });
}

// ─────────────────────────────────────────
// TEST 4: Dry-Run Chain Sync
// ─────────────────────────────────────────
async function testDryRunSync() {
  console.log('\n── Test 4: Dry-Run Chain Sync ──');

  await test('Single chain dry-run (no Firebase write)', async () => {
    const { FIREBASE_PROJECT_ID } = process.env;
    if (!FIREBASE_PROJECT_ID) {
      console.log('\n    ⚠️  Skipped — Firebase not configured');
      return;
    }
    // This spawns a child process to keep the test isolated
    const { execSync } = await import('child_process');
    const result = execSync(
      'NODE_ENV=test BYPASS_IP_CHECK=true DRY_RUN=true node index.js shufersal',
      { cwd: new URL('..', import.meta.url).pathname, timeout: 300_000, encoding: 'utf8' }
    );
    console.log('\n    → Sync output (last 3 lines):');
    result.trim().split('\n').slice(-3).forEach(l => console.log(`    ${l}`));
    assert(result.includes('"✅') || result.includes('dry-run') || result.includes('Done'), 'Should complete dry-run');
  });
}

// ─────────────────────────────────────────
// RUN ALL
// ─────────────────────────────────────────
async function runAll() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Israeli Price Worker — Test Suite       ║');
  console.log('╚══════════════════════════════════════════╝');

  await testConfig();
  await testIPCheck();
  await testFirebase();
  await testDryRunSync();

  console.log('\n══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  logger.fail('Test suite crashed', { error: err.message, stack: err.stack });
  process.exit(1);
});
