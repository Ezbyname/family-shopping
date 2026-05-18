// api/manual-price.js — v3.0.0
// POST /api/manual-price
// Family-scoped manual price — saved to manualPrices/{groupId}/{barcode}/{entryId}
// NEVER writes to prices/ (official XML path)
// NEVER overwrites official prices

import { getDB, setCors, isValidBarcode, isValidPrice, sanitize } from './_firebase.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const {
    barcode, price, chainName, storeName, productName,
    note, groupId, userId, displayName,
    avatarType, avatarValue, avatarEmoji,
  } = body || {};

  // ── Validation ──
  const cleanBarcode = String(barcode || '').replace(/\D/g, '');
  if (!isValidBarcode(cleanBarcode))
    return res.status(400).json({ error: 'Invalid barcode' });

  const cleanPrice = parseFloat(String(price || '0').replace(',', '.'));
  if (!isValidPrice(cleanPrice))
    return res.status(400).json({ error: 'Invalid price — must be a positive number' });

  const cleanChain = sanitize(chainName, 100);
  if (!cleanChain)
    return res.status(400).json({ error: 'chainName is required' });

  if (!groupId)
    return res.status(400).json({ error: 'groupId is required — manual prices are family-scoped' });

  try {
    const db = await getDB();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    // ── Check: official price exists? ──
    // We allow manual even if official exists — it goes to manualPrices/ not prices/
    // But we flag it in the response so UI can inform the user
    const officialSnap = await db.ref(`prices/${cleanBarcode}`).get();
    const hasOfficial = officialSnap.exists() &&
      Object.values(officialSnap.val()).some(p => p?.price > 0);

    // ── Save to manualPrices/{groupId}/{barcode}/{entryId} ──
    // NEVER to prices/ (official XML path)
    const entryId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entry = {
      barcode:    cleanBarcode,
      name:       sanitize(productName, 200),
      price:      Math.round(cleanPrice * 100) / 100,
      chainName:  cleanChain,
      storeName:  sanitize(storeName, 100) || cleanChain,
      groupId,
      submittedByUserId:      sanitize(userId, 50)      || 'anonymous',
      submittedByDisplayName: sanitize(displayName, 50) || 'משתמש',
      submittedByAvatarType:  sanitize(avatarType, 20)  || 'emoji',
      submittedByAvatarValue: sanitize(avatarValue, 100)|| '👤',
      submittedByAvatarEmoji: sanitize(avatarEmoji, 10) || null,
      note:       sanitize(note, 300) || null,
      submittedAt: new Date().toISOString(),
      source:     'manual',
    };

    await db.ref(`manualPrices/${groupId}/${cleanBarcode}/${entryId}`).set(entry);
    console.log(`[manual-price] Saved ${cleanBarcode} ₪${cleanPrice} by ${sanitize(userId)} in group ${sanitize(groupId)}`);

    return res.status(201).json({
      success:       true,
      entryId,
      entry,
      officialExists: hasOfficial,
      note: hasOfficial
        ? 'Official XML price exists — your manual price is saved as family fallback'
        : 'No official price exists — this manual price will be shown to your family',
    });

  } catch (e) {
    console.error('[manual-price] error:', e.message);
    return res.status(500).json({ error: 'Failed to save', detail: e.message });
  }
}
