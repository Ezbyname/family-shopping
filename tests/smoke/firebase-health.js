#!/usr/bin/env node
// smoke/firebase-health.js — Fast Firebase connectivity smoke test
// Runs in CI before E2E tests to fail early if Firebase is down
// Exit 0 = OK, Exit 1 = Firebase unreachable

const BASE_URL = process.env.TEST_BASE_URL;
if (!BASE_URL) {
  console.error('❌  TEST_BASE_URL env var is required');
  process.exit(1);
}

const TIMEOUT_MS = 15_000;

async function checkHealth() {
  const url = `${BASE_URL}/api/health`;
  console.log(`🔍  Checking Firebase health at ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      console.error(`❌  /api/health returned HTTP ${response.status}`);
      process.exit(1);
    }

    const body = await response.json();

    if (!body.ok) {
      console.error(`❌  Firebase health check failed: ${body.error}`);
      console.error('    Timings:', JSON.stringify(body.timings));
      process.exit(1);
    }

    const { initMs, pingMs, totalMs } = body.timings;
    console.log(`✅  Firebase healthy`);
    console.log(`    init=${initMs}ms  ping=${pingMs}ms  total=${totalMs}ms`);

    if (body.db?.lastSyncDate) {
      const syncDate   = new Date(body.db.lastSyncDate);
      const hoursSince = (Date.now() - syncDate.getTime()) / 3_600_000;
      console.log(`    Last price sync: ${body.db.lastSyncDate} (${Math.round(hoursSince)}h ago)`);
      if (hoursSince > 48) {
        console.warn(`⚠️   Price data is stale (${Math.round(hoursSince)}h). Sync worker may need attention.`);
      }
    }

    if (totalMs > 8000) {
      console.warn(`⚠️   Health check slow: ${totalMs}ms — Vercel cold start or Firebase latency`);
    }

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      console.error(`❌  Health check timed out after ${TIMEOUT_MS}ms`);
    } else {
      console.error(`❌  Health check failed: ${err.message}`);
    }
    process.exit(1);
  }
}

checkHealth();
