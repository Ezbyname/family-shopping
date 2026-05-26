// api/manual-price.js — v2.1.0
// POST /api/manual-price — manual price fallback (only when no official price exists)
// v2.1.0: official-price check uses REST; write still uses Admin SDK
import { getDB, restGet, getDbUrl, getAdminToken, setCors } from './_firebase.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { barcode, price, chainName, storeName, productName, note, submittedBy, userId, groupId } = body || {};

  const clean = String(barcode||'').replace(/\D/g,'');
  if (!clean || clean.length < 4 || clean.length > 20) return res.status(400).json({ error: 'Invalid barcode' });

  const cleanPrice = parseFloat(String(price||'0').replace(',','.'));
  if (isNaN(cleanPrice) || cleanPrice <= 0 || cleanPrice > 10000) return res.status(400).json({ error: 'Invalid price' });

  const cleanChain = String(chainName||'').trim().substring(0,100);
  if (!cleanChain) return res.status(400).json({ error: 'chainName required' });

  try {
    const dbUrl = getDbUrl();
    if (!dbUrl) return res.status(503).json({ error: 'Database not available' });

    // Block if official prices already exist — use REST (public read, no Admin SDK hang)
    await getAdminToken().catch(() => {});
    const offData = await restGet(dbUrl, `prices/${clean}`, 5_000).catch(() => null);
    if (offData && typeof offData === 'object') {
      const official = Object.values(offData).filter(p => p?.price > 0);
      if (official.length > 0)
        return res.status(409).json({ error: 'Official prices exist — manual entry not needed', count: official.length });
    }

    // Write via Admin SDK (service-account auth required for RTDB writes)
    const db = await getDB();
    if (!db) return res.status(503).json({ error: 'Database write unavailable' });

    const entryId = `m_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const entry = {
      barcode:     clean,
      name:        String(productName||'').trim().substring(0,200),
      chainId:     'manual',
      chainName:   cleanChain,
      storeId:     null,
      storeName:   String(storeName||'').trim().substring(0,100) || null,
      price:       Math.round(cleanPrice*100)/100,
      note:        String(note||'').trim().substring(0,300) || null,
      submittedBy: String(submittedBy||userId||'anonymous').trim().substring(0,50),
      userId:      userId || null,
      groupId:     groupId || null,
      submittedAt: new Date().toISOString(),
      source:      'manual',
    };

    await db.ref(`manualPrices/${clean}/${entryId}`).set(entry);
    return res.status(201).json({ success: true, entryId, entry });

  } catch (e) {
    return res.status(500).json({ error: 'Failed to save', detail: e.message });
  }
}
