#!/usr/bin/env node
// smoke/vercel-health.js — Vercel deployment verification smoke test
// Checks that critical static assets and API routes are reachable after deploy
// Exit 0 = all checks pass, Exit 1 = any check fails

const BASE_URL = process.env.TEST_BASE_URL;
if (!BASE_URL) {
  console.error('❌  TEST_BASE_URL env var is required');
  process.exit(1);
}

const TIMEOUT_MS = 12_000;

const CHECKS = [
  // Static assets (PWA shell)
  { url: '/',              expect: 200, label: 'index.html' },
  { url: '/manifest.json', expect: 200, label: 'manifest.json', json: true, hasField: 'name' },
  { url: '/sw.js',         expect: 200, label: 'sw.js',          contentType: 'javascript' },
  // API routes
  { url: '/api/health',                expect: 200, label: 'API /health',        json: true, hasField: 'ok' },
  { url: '/api/prices?barcode=7290000066614', expect: 200, label: 'API /prices', json: true, hasField: 'prices' },
];

let passed = 0;
let failed = 0;

async function check({ url, expect: expectedStatus, label, json, hasField, isArray, contentType }) {
  const fullUrl = `${BASE_URL}${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(fullUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (response.status !== expectedStatus) {
      console.error(`❌  ${label}: expected HTTP ${expectedStatus}, got ${response.status}`);
      failed++;
      return;
    }

    if (contentType) {
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes(contentType)) {
        console.warn(`⚠️   ${label}: unexpected Content-Type "${ct}" (expected "${contentType}")`);
      }
    }

    if (json) {
      const body = await response.json();
      if (hasField && !(hasField in body)) {
        console.error(`❌  ${label}: response JSON missing field "${hasField}"`);
        failed++;
        return;
      }
      if (isArray && !Array.isArray(body)) {
        console.error(`❌  ${label}: expected JSON array, got ${typeof body}`);
        failed++;
        return;
      }
    }

    console.log(`✅  ${label} (HTTP ${response.status})`);
    passed++;

  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : err.message;
    console.error(`❌  ${label}: ${msg}`);
    failed++;
  }
}

console.log(`🔍  Vercel deployment smoke test — ${BASE_URL}\n`);

await Promise.all(CHECKS.map(check));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
