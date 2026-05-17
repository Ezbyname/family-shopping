// scripts/xml-parser.js — v2.0.0
// Streaming SAX parser — extracts prices AND store location data
import sax from 'sax';
import { isValidBarcode, isValidPrice, normalizeBarcode, normalizePrice } from './utils.js';

const FIELD_MAP = {
  'itemcode':'barcode','itemnm':'name','itemname':'name','itemprice':'price',
  'priceupdatedate':'updatedAt','lastupdatedate':'updatedAt',
  'unitofmeasure':'unit','quantity':'quantity','unitqty':'unitQty',
  'manufacturername':'brand','manufacturecountry':'country',
  'storeid':'storeId','storename':'storeName','chainid':'chainId','chainname':'chainName',
  'subchainid':'subChainId','subchainname':'subChainName',
  // Store location fields (appear in Stores XML files)
  'address':'address','city':'city','zipcode':'zipCode',
  'latitude':'latitude','longitude':'longitude',
  'storetype':'storeType',
};

const ITEM_TAG  = 'item';
const STORE_TAG = 'store'; // Some chains have separate Stores XML

export function parseXMLStream(stream, onProduct, onStore, chainMeta = {}) {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(false, { lowercase: true, trim: true, normalize: true });

    let count = 0, storeCount = 0, skipped = 0, errors = 0;
    const header = { ...chainMeta };
    let cur = null, curTag = '', curText = '', inStore = false, inItem = false;

    parser.on('opentag', node => {
      const tag = node.name.toLowerCase();
      if (tag === ITEM_TAG)  { inItem  = true; cur = {}; }
      if (tag === STORE_TAG) { inStore = true; cur = {}; }
      curText = '';
    });

    parser.on('text',  t => { curText += t; });
    parser.on('cdata', t => { curText += t; });

    parser.on('closetag', raw => {
      const tag = raw.toLowerCase();
      const text = curText.trim();

      // Capture file-level header info
      if (!inItem && !inStore && FIELD_MAP[tag] && text) {
        const f = FIELD_MAP[tag];
        if (['storeId','storeName','chainId','chainName'].includes(f)) header[f] = text;
      }

      if ((inItem || inStore) && tag !== ITEM_TAG && tag !== STORE_TAG && text) {
        const f = FIELD_MAP[tag];
        if (f) cur[f] = text;
      }

      if (tag === ITEM_TAG && inItem) {
        inItem = false;
        try {
          const p = buildProduct(cur, header);
          if (p) { onProduct(p); count++; } else skipped++;
        } catch (_) { errors++; }
        cur = null;
      }

      if (tag === STORE_TAG && inStore) {
        inStore = false;
        try {
          const s = buildStore(cur, header, chainMeta);
          if (s && onStore) { onStore(s); storeCount++; }
        } catch (_) {}
        cur = null;
      }

      curText = '';
    });

    parser.on('error', () => {
      errors++;
      try { parser._parser.error = null; parser._parser.resume(); } catch (_) {}
    });

    parser.on('end', () => resolve({ count, storeCount, skipped, errors }));
    stream.on('error', e => reject(new Error(`Stream: ${e.message}`)));
    stream.pipe(parser);
  });
}

function buildProduct(raw, header) {
  const barcode = normalizeBarcode(raw.barcode);
  if (!isValidBarcode(barcode)) return null;
  const price = normalizePrice(raw.price);
  if (!isValidPrice(price)) return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;

  return {
    barcode, name, price,
    chainId:   raw.chainId   || header.chainId   || '',
    chainName: raw.chainName || header.chainName || '',
    storeId:   raw.storeId   || header.storeId   || '',
    storeName: raw.storeName || header.storeName || '',
    unit:      raw.unit      || '',
    quantity:  raw.quantity  || raw.unitQty || '',
    brand:     raw.brand     || '',
    updatedAt: toISO(raw.updatedAt),
    source:    'official',
  };
}

function buildStore(raw, header, chainMeta) {
  const storeId = String(raw.storeId || header.storeId || '').trim();
  if (!storeId) return null;

  const lat = parseFloat(raw.latitude  || '');
  const lng = parseFloat(raw.longitude || '');
  const hasCoords = !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0;

  return {
    chainId:   chainMeta.chainId   || raw.chainId   || '',
    chainName: chainMeta.chainName || raw.chainName || '',
    storeId,
    storeName: raw.storeName || '',
    address:   raw.address   || '',
    city:      raw.city      || '',
    zipCode:   raw.zipCode   || '',
    latitude:  hasCoords ? lat : null,
    longitude: hasCoords ? lng : null,
    hasCoords,
    updatedAt: new Date().toISOString(),
  };
}

function toISO(raw) {
  if (!raw) return new Date().toISOString();
  const s = String(raw).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00.000Z`;
  try { const d = new Date(s); if (!isNaN(d)) return d.toISOString(); } catch (_) {}
  return new Date().toISOString();
}
