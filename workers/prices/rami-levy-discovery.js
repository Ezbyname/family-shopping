// workers/prices/rami-levy-discovery.js
// Discovers PriceFull files via direct FTP (no web login / reCAPTCHA).
import { execFile } from 'child_process';
import { logger } from './logger.js';

const FTP_BASE = 'ftp://url.retail.publishedprices.co.il';
const FTP_USER = 'RamiLevi:';
const RE_NEW = /^PriceFull(\d+)-\d+-(\d{3})-(\d{8})-(\d{6})\.gz$/i;
const RE_OLD = /^PriceFull(\d+)-(\d{3})-(\d{12})\.gz$/i;

async function ftpList(timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sk', '--max-time', String(Math.ceil(timeoutMs/1000)), FTP_BASE, '--user', FTP_USER, '-l'],
      { maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => err ? reject(new Error('FTP list failed: ' + err.message))
                           : resolve(stdout.trim().split('\n').filter(Boolean))
    );
  });
}

function parseFileList(files, chainId) {
  const byStore = new Map();
  for (const fname of files) {
    let storeId, sortKey;
    const mNew = RE_NEW.exec(fname);
    if (mNew && mNew[1] === chainId) { storeId = mNew[2]; sortKey = mNew[3] + mNew[4]; }
    else { const mOld = RE_OLD.exec(fname); if (mOld && mOld[1] === chainId) { storeId = mOld[2]; sortKey = mOld[3]; } }
    if (!storeId) continue;
    const ex = byStore.get(storeId);
    if (!ex || sortKey > ex.sortKey) byStore.set(storeId, { storeId, filename: fname, url: FTP_BASE + '/' + fname, sortKey });
  }
  return byStore;
}

export async function discoverPriceFullFiles(_cookie, chainId, { timeoutMs = 60000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const files = await ftpList(timeoutMs);
      const byStore = parseFileList(files, chainId);
      if (byStore.size === 0) logger.warn('[rami-levy] No PriceFull files via FTP', { chainId, totalFiles: files.length });
      else logger.info('[rami-levy] FTP discovery complete', { stores: byStore.size, storeIds: [...byStore.keys()].sort() });
      return { byStore, metrics: { storesFound: byStore.size, totalFiles: files.length } };
    } catch (err) {
      lastErr = err;
      logger.warn('[rami-levy] FTP discovery attempt ' + attempt + '/' + retries + ' failed', { error: err.message });
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('[rami-levy] FTP discovery failed: ' + lastErr?.message);
}
