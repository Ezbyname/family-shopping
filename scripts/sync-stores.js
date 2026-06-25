import { execFile } from 'child_process';
import { promisify } from 'util';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { resolveCity } from './lib/city-code-resolver.js';
const execFileAsync = promisify(execFile);
const CHAIN_ID = '7290058140886';
const CHAIN_NAME = '??? ???';
const FTP_BASE = 'ftp://url.retail.publishedprices.co.il/';
const BATCH_SIZE = 400;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
const VERBOSE = process.argv.includes('--verbose');
function log(...a) { console.error('[sync-stores]', ...a); }
function vlog(...a) { if (VERBOSE) log(...a); }
function initFirebase() {
  if (getApps().length) return getDatabase();
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_DATABASE_URL } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_DATABASE_URL) { log('ERROR: Missing FIREBASE_* env vars'); process.exit(4); }
  initializeApp({ credential: cert({ projectId: FIREBASE_PROJECT_ID, clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }), databaseURL: FIREBASE_DATABASE_URL });
  return getDatabase();
}
async function listFtp(url) {
  const { stdout } = await execFileAsync('curl', ['--silent','--list-only','--user','RamiLevi:',url], { timeout: 30000 });
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}
async function dlFtp(url) {
  const { stdout } = await execFileAsync('curl', ['--silent','--user','RamiLevi:',url], { encoding: 'buffer', timeout: 60000, maxBuffer: 50*1024*1024 });
  return stdout;
}
async function findLatest() {
  const files = await listFtp(FTP_BASE);
  vlog(`FTP listing: ${files.length} entries`);
  const RE = /^Stores\d+-\d+-(\d{8})-(\d{6})\.xml(\.gz)?$/i;
  const m = files.map(f => ({ name: f, m: RE.exec(f) })).filter(({ m }) => m).sort((a, b) => (b.m[1]+b.m[2]).localeCompare(a.m[1]+a.m[2]));
  if (!m.length) throw new Error('No StoresFull XML found on FTP');
  vlog(`Latest: ${m[0].name}`);
  return FTP_BASE + m[0].name;
}
function decodeUtf16Le(buf) {
  const start = (buf[0] === 0xff && buf[1] === 0xfe) ? 2 : 0;
  return new TextDecoder('utf-16le').decode(buf.slice(start));
}
function extractTag(block, tag) { const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(block); return m ? m[1].trim() : ''; }
function parseXml(xml) {
  const stores = []; const RE = /<Store>([\s\S]*?)<\/Store>/gi; let m;
  while ((m = RE.exec(xml)) !== null) {
    const b = m[1], storeId = extractTag(b,'StoreId').replace(/^0+/,'') || extractTag(b,'StoreId');
    if (!storeId) continue;
    stores.push({ storeId, storeName: extractTag(b,'StoreName'), address: extractTag(b,'Address'), rawCityCode: extractTag(b,'City'), zipCode: extractTag(b,'ZipCode') });
  }
  return stores;
}
async function syncFb(db, records) {
  let written = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i+BATCH_SIZE), updates = {};
    for (const r of chunk) updates[`stores/${r.identityKey}`] = r.payload;
    if (DRY_RUN) { vlog(`[dry-run] Would write ${chunk.length} stores`); } else { await db.ref('/').update(updates); }
    written += chunk.length; log(`Wrote ${written}/${records.length} stores`);
  }
  return written;
}
async function main() {
  log(`Starting (dry-run=${DRY_RUN})`);
  let fileUrl; try { fileUrl = await findLatest(); } catch(e) { log('ERROR FTP:', e.message); process.exit(1); }
  log(`Downloading: ${fileUrl}`);
  let raw; try { raw = await dlFtp(fileUrl); } catch(e) { log('ERROR dl:', e.message); process.exit(1); }
  log(`Downloaded ${raw.length} bytes`);
  let xml; try {
    if (raw[0]===0x1f && raw[1]===0x8b) { const {gunzipSync} = await import('zlib'); raw = gunzipSync(raw); log('Decompressed'); }
    if (raw[0]===0xff && raw[1]===0xfe) { xml = decodeUtf16Le(raw); log('Decoded UTF-16LE'); } else { xml = raw.toString('utf-8'); log('Decoded UTF-8'); }
  } catch(e) { log('ERROR decode:', e.message); process.exit(2); }
  const rawStores = parseXml(xml);
  log(`Parsed ${rawStores.length} stores`);
  if (!rawStores.length) { log('ERROR: 0 stores — aborting'); process.exit(2); }
  const now = Date.now();
  const records = rawStores.map(s => {
    const cr = resolveCity(s.rawCityCode), key = `${CHAIN_ID}_${s.storeId}`;
    return { identityKey: key, payload: { chainId: CHAIN_ID, chainName: CHAIN_NAME, storeId: s.storeId, identityKey: key, storeName: s.storeName||null, address: s.address||null, zipCode: s.zipCode||null, rawCityCode: s.rawCityCode||null, cityId: cr.cityId, cityName: cr.cityName, cityResolutionSource: cr.cityResolutionSource, isActive: true, source: 'xml_sync_v1', syncVersion: 1, updatedAt: now } };
  });
  if (VERBOSE) {
    const res = records.filter(r => r.payload.cityResolutionSource === 'cbs_mapping').length;
    log(`City resolution: ${res} resolved, ${records.length-res} unknown`);
    if (records.length-res > 0) log('Unknown CBS codes:', [...new Set(records.filter(r => r.payload.cityResolutionSource !== 'cbs_mapping').map(r => r.payload.rawCityCode))].sort().join(', '));
  }
  const db = initFirebase();
  let written; try { written = await syncFb(db, records); } catch(e) { log('ERROR Firebase:', e.message); process.exit(3); }
  log(`Done. ${written} stores ${DRY_RUN ? '(dry-run)' : 'written to Firebase'}`);
  if (!DRY_RUN) { try { await db.ref('syncStatus/rami-levy-stores').update({ lastSyncDate: new Date().toISOString().slice(0,10), lastSuccessAt: now, storesProcessed: written, sourceFile: fileUrl, syncVersion: 1 }); } catch(e) { log('WARN syncStatus:', e.message); } }
  process.exit(0);
}
main().catch(e => { log('FATAL:', e); process.exit(1); });
