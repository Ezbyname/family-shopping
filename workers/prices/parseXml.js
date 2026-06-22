// workers/prices/parseXml.js
// Streaming SAX XML parser for Israeli supermarket price files.
// Handles large files (10–50MB) without loading into memory.
// Supports: PriceFull, Stores XML formats from all Israeli chains.

import sax from 'sax';
import { normalizeProduct, normalizeStore } from './normalizeProduct.js';

// Maps lowercase XML tag names → our normalized field names
const FIELD_MAP = {
  'itemcode':           'barcode',
  'itemnm':             'name',
  'itemname':           'name',
  'itemprice':          'price',
  'priceupdatedate':    'updatedAt',
  'lastupdatedate':     'updatedAt',
  'unitofmeasure':      'unit',
  'quantity':           'quantity',
  'unitqty':            'unitQty',
  'manufacturername':   'brand',
  'manufacturename':    'brand',      // Rami Levy: ManufactureName (no trailing 'r')
  'priceupdatetime':   'updatedAt',  // Rami Levy: PriceUpdateTime
  'manufacturecountry': 'country',
  'storeid':            'storeId',
  'storename':          'storeName',
  'chainid':            'chainId',
  'chainname':          'chainName',
  'subchainid':         'subChainId',
  'subchainname':       'subChainName',
  'address':            'address',
  'city':               'city',
  'zipcode':            'zipCode',
  'latitude':           'latitude',
  'longitude':          'longitude',
  'storetype':          'storeType',
};

const ITEM_TAG  = 'item';
const STORE_TAG = 'store';
const HEADER_FIELDS = new Set(['storeId','storeName','chainId','chainName']);

/**
 * Parse a streaming XML price/store file.
 *
 * @param {Readable} stream      - Readable stream (may be pre-decompressed)
 * @param {Function} onProduct   - Called for each valid product
 * @param {Function} onStore     - Called for each valid store (may be null)
 * @param {Object}   chainMeta   - { chainId, chainName } from config
 * @returns {Promise<{count, storeCount, skipped, errors}>}
 */
export function parseXMLStream(stream, onProduct, onStore, chainMeta = {}) {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(false /* not strict */, {
      lowercase: true,
      trim:      true,
      normalize: true,
    });

    let count = 0, storeCount = 0, skipped = 0, errors = 0;
    const header = { ...chainMeta };
    let cur = null, curText = '', inItem = false, inStore = false;

    parser.on('opentag', node => {
      const tag = node.name.toLowerCase();
      if (tag === ITEM_TAG)  { inItem  = true; cur = {}; }
      if (tag === STORE_TAG) { inStore = true; cur = {}; }
      curText = '';
    });

    parser.on('text',  t => { curText += t; });
    parser.on('cdata', t => { curText += t; });

    parser.on('closetag', raw => {
      const tag  = raw.toLowerCase();
      const text = curText.trim();

      // Capture file-level header (chain/store metadata before items)
      if (!inItem && !inStore && text) {
        const field = FIELD_MAP[tag];
        if (field && HEADER_FIELDS.has(field)) header[field] = text;
      }

      // Accumulate item/store fields
      if ((inItem || inStore) && tag !== ITEM_TAG && tag !== STORE_TAG && text) {
        const field = FIELD_MAP[tag];
        if (field) cur[field] = text;
      }

      // Emit item
      if (tag === ITEM_TAG && inItem) {
        inItem = false;
        try {
          const product = normalizeProduct(cur, header);
          if (product && onProduct) {
            Promise.resolve(onProduct(product)).catch(() => {});
            count++;
          } else {
            skipped++;
          }
        } catch (_) { errors++; }
        cur = null;
      }

      // Emit store
      if (tag === STORE_TAG && inStore) {
        inStore = false;
        try {
          const store = normalizeStore(cur, chainMeta);
          if (store && onStore) {
            Promise.resolve(onStore(store)).catch(() => {});
            storeCount++;
          }
        } catch (_) {}
        cur = null;
      }

      curText = '';
    });

    parser.on('error', () => {
      errors++;
      // Attempt to recover from malformed XML
      try {
        parser._parser.error = null;
        parser._parser.resume();
      } catch (_) {}
    });

    parser.on('end', () => resolve({ count, storeCount, skipped, errors }));
    stream.on('error', e => reject(new Error(`Stream error: ${e.message}`)));
    stream.pipe(parser);
  });
}
