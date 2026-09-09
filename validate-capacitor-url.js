#!/usr/bin/env node
// Validates that capacitor.config.json server.url matches the canonical production URL.
//
// In CI: VERCEL_PRODUCTION_URL is injected by the workflow (vars.VERCEL_PRODUCTION_URL).
// Locally: VERCEL_PRODUCTION_URL=https://family-shopping-one.vercel.app node validate-capacitor-url.js
//
// Exit 0 = OK, Exit 1 = mismatch, missing env var, or unreadable config

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXPECTED_URL = process.env.VERCEL_PRODUCTION_URL;
if (!EXPECTED_URL) {
  console.error('ERROR: VERCEL_PRODUCTION_URL environment variable is not set.');
  console.error('  In CI this is injected automatically via vars.VERCEL_PRODUCTION_URL.');
  console.error('  Locally: VERCEL_PRODUCTION_URL=https://family-shopping-one.vercel.app node validate-capacitor-url.js');
  process.exit(1);
}

const CONFIG_PATH = join(__dirname, 'capacitor.config.json');
let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`ERROR: Could not read ${CONFIG_PATH}: ${e.message}`);
  process.exit(1);
}

const actual = config?.server?.url;
if (actual === EXPECTED_URL) {
  console.log(`✓ capacitor.config.json server.url matches VERCEL_PRODUCTION_URL: ${actual}`);
  process.exit(0);
}

console.error('');
console.error('ERROR: capacitor.config.json server.url mismatch!');
console.error(`  Expected (VERCEL_PRODUCTION_URL): ${EXPECTED_URL}`);
console.error(`  Actual   (capacitor.config.json): ${actual ?? '(missing)'}`);
console.error('');
console.error('Fix: update capacitor.config.json → server.url to match VERCEL_PRODUCTION_URL.');
console.error('The APK is a remote shell — a wrong URL causes a white screen on Android.');
console.error('');
process.exit(1);
