// workers/prices/check-ip.js — v2.0.0 (hardened)
// Verifies server outbound IP is geolocated in Israel.
// MUST pass before price sync runs.
//
// Safety rules:
//   - BYPASS_IP_CHECK=true is IGNORED when NODE_ENV=production (fail closed)
//   - Provider failure is NOT treated as Israeli IP (fail closed always)
//   - All providers attempted with individual timeouts
//
// Exit codes: 0 = pass  |  1 = fail

import { logger } from './logger.js';

const REQUIRED_COUNTRY = 'IL';
const PROVIDER_TIMEOUT = 8_000; // ms per provider

const IP_PROVIDERS = [
  {
    name:  'ipapi.co',
    url:   'https://ipapi.co/json/',
    parse: d => {
      if (!d || typeof d !== 'object') throw new Error('Invalid shape');
      if (d.error) throw new Error(`API error: ${d.reason || d.error}`);
      if (!d.country_code) throw new Error('Missing country_code');
      return { ip: String(d.ip||''), country: String(d.country_code||''),
               region: String(d.region||''), city: String(d.city||''), org: String(d.org||'') };
    },
  },
  {
    name:  'ip-api.com',
    url:   'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,org,query',
    parse: d => {
      if (!d || typeof d !== 'object') throw new Error('Invalid shape');
      if (d.status === 'fail') throw new Error(`API error: ${d.message}`);
      if (!d.countryCode) throw new Error('Missing countryCode');
      return { ip: String(d.query||''), country: String(d.countryCode||''),
               region: String(d.regionName||''), city: String(d.city||''), org: String(d.org||'') };
    },
  },
  {
    name:  'ipinfo.io',
    url:   'https://ipinfo.io/json',
    parse: d => {
      if (!d || typeof d !== 'object') throw new Error('Invalid shape');
      if (!d.country) throw new Error('Missing country');
      return { ip: String(d.ip||''), country: String(d.country||''),
               region: String(d.region||''), city: String(d.city||''), org: String(d.org||'') };
    },
  },
];

async function checkProvider(provider) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT);
  try {
    const res = await fetch(provider.url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'IsraeliPriceWorker/2.0' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data;
    try { data = JSON.parse(await res.text()); }
    catch { throw new Error('Non-JSON response'); }
    return provider.parse(data);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkIsraeliIP({ silent = false } = {}) {
  const isProduction = process.env.NODE_ENV === 'production';
  const bypassSet    = process.env.BYPASS_IP_CHECK === 'true';

  // ── Production bypass enforcement ──
  if (bypassSet) {
    if (isProduction) {
      // IGNORE bypass in production — fail closed
      logger.warn('SECURITY: BYPASS_IP_CHECK=true ignored in NODE_ENV=production — running real check',
        { NODE_ENV: 'production' });
      if (!silent) {
        console.error('\n  ⚠️  SECURITY WARNING: BYPASS_IP_CHECK=true is IGNORED in production!');
        console.error('  Running real IP check...\n');
      }
      // Falls through to actual check
    } else {
      // Dev only — allow with warning
      logger.warn('BYPASS_IP_CHECK=true — skipping IP check (dev/test mode)',
        { NODE_ENV: process.env.NODE_ENV || 'undefined' });
      if (!silent) console.log('\n  ⚠️  BYPASS_IP_CHECK=true — IP check skipped (non-production)\n');
      return { passed: true, ip: '(bypassed)', country: '(bypassed)', bypassed: true };
    }
  }

  if (!silent) {
    console.log('\n═══════════════════════════════════════════════');
    console.log('  🌍  Israeli IP Geolocation Verification');
    console.log('═══════════════════════════════════════════════\n');
  }

  const errors = [];

  for (const provider of IP_PROVIDERS) {
    if (!silent) process.stdout.write(`  [${provider.name}] Checking... `);
    try {
      const info = await checkProvider(provider);

      if (!silent) {
        console.log('OK');
        console.log(`           IP      : ${info.ip}`);
        console.log(`           Country : ${info.country} ${info.country === REQUIRED_COUNTRY ? '✅ ISRAEL' : `❌ (got: ${info.country})`}`);
        console.log(`           City    : ${info.city}`);
        console.log(`           Org     : ${info.org}\n`);
      }

      const isIsrael = info.country === REQUIRED_COUNTRY;

      if (isIsrael) {
        logger.ok('IP check passed', { ip: info.ip, country: info.country, city: info.city, provider: provider.name });
        if (!silent) {
          console.log('  ✅  PASS — Server IP confirmed Israeli.');
          console.log('  Price sync is permitted.\n');
          console.log('═══════════════════════════════════════════════\n');
        }
        return { passed: true, ip: info.ip, country: info.country, info, bypassed: false };
      }

      // Valid response — not Israel
      logger.fail('IP check failed — not Israeli', { ip: info.ip, country: info.country, provider: provider.name });
      if (!silent) {
        console.error('  ❌  FAIL — Server is NOT in Israel.\n');
        console.error(`  Detected: ${info.country} / ${info.city} (${info.org})\n`);
        console.error('  ▶  Move to a confirmed Israeli cloud region:');
        console.error('     • Google Cloud  : me-west1       (Tel Aviv)');
        console.error('     • AWS           : il-central-1   (Tel Aviv)');
        console.error('     • Oracle Cloud  : il-jerusalem-1 (Jerusalem)');
        console.error('\n═══════════════════════════════════════════════\n');
      }
      return { passed: false, ip: info.ip, country: info.country, info, bypassed: false };

    } catch (err) {
      const msg = err.name === 'AbortError' ? `Timeout (${PROVIDER_TIMEOUT}ms)` : err.message;
      if (!silent) console.log(`FAILED — ${msg}`);
      logger.warn('IP provider failed', { provider: provider.name, error: msg });
      errors.push(`${provider.name}: ${msg}`);
    }
  }

  // All providers failed → fail CLOSED
  const summary = errors.join(' | ');
  logger.fail('All IP providers failed — failing closed', { errors: summary });
  if (!silent) {
    console.error('\n  ❌  All IP providers failed to respond.');
    console.error(`  Errors: ${summary}`);
    console.error('\n  Failing CLOSED — cannot confirm Israeli IP.');
    console.error('  Check VPS network and DNS.\n');
    console.error('═══════════════════════════════════════════════\n');
  }
  return { passed: false, ip: null, country: null, info: null, bypassed: false, allProvidersFailed: true };
}

// Standalone run
if (process.argv[1] && process.argv[1].endsWith('check-ip.js')) {
  const silent = process.argv.includes('--silent');
  checkIsraeliIP({ silent }).then(r => process.exit(r.passed ? 0 : 1))
    .catch(err => { logger.fail('IP check crashed', { error: err.message }); process.exit(1); });
}
