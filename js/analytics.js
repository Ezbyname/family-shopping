/**
 * js/analytics.js — v1.0.0
 *
 * Privacy-safe Firebase RTDB analytics event tracking.
 *
 * Design constraints:
 *   - No PII: no full groupId, no userId, no barcodes, no lat/lng
 *   - groupId anonymised to first 6 chars (de-duplication, not identity)
 *   - All writes go to analytics/events/{YYYY-MM-DD}/{pushKey}
 *   - Firebase rules enforce auth !== null + field-length validation
 *   - 2-second batch flush to avoid per-keystroke writes
 *   - Queue capped at MAX_QUEUE_SIZE to prevent runaway accumulation
 *
 * Usage:
 *   import { createTracker } from './js/analytics.js';
 *   const { trackEvent } = createTracker({ getDb, getGroupId, push, ref });
 *
 * The factory pattern avoids a circular dependency between this module
 * and the Firebase SDK (which is initialised in the main module scope).
 */

const MAX_QUEUE_SIZE = 50;

/**
 * Create an analytics tracker bound to the calling module's Firebase references.
 *
 * @param {object} opts
 * @param {function(): any}    opts.getDb       Returns the Firebase DB instance (or null)
 * @param {function(): string} opts.getGroupId  Returns the current group ID (or '')
 * @param {function}           opts.push        Firebase push()
 * @param {function}           opts.ref         Firebase ref()
 * @returns {{ trackEvent: function, flush: function }}
 */
export function createTracker({ getDb, getGroupId, push, ref }) {
  const queue = [];
  let flushPending = false;

  function flush() {
    flushPending = false;
    const db      = getDb();
    const groupId = getGroupId();
    if (!db || !groupId) { queue.length = 0; return; }
    const batch = queue.splice(0);
    batch.forEach(({ today, entry }) => {
      try {
        push(ref(db, `analytics/events/${today}`), entry).catch(() => {});
      } catch (_) {}
    });
  }

  /**
   * Queue an analytics event for batch-write to Firebase.
   *
   * @param {string} eventName  Short event name (max 40 chars per Firebase rule)
   * @param {object} props      Event-specific properties (no PII)
   */
  function trackEvent(eventName, props = {}) {
    const db      = getDb();
    const groupId = getGroupId();
    if (!db || !groupId) return;
    if (queue.length >= MAX_QUEUE_SIZE) return; // runaway guard

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    queue.push({
      today,
      entry: {
        event:    String(eventName).slice(0, 40),
        ts:       Date.now(),
        group:    groupId.slice(0, 6),
        platform: 'pwa',
        props,
      },
    });

    if (flushPending) return;
    flushPending = true;
    setTimeout(flush, 2000);
  }

  return { trackEvent, flush };
}

/**
 * Event schema reference (enforced by Firebase rules on the server):
 *
 * price_search   { mode:'barcode'|'name'|'location', hasLocation:bool, resultCount:int }
 * store_sheet_open { source:'official'|'proxy'|'manual', hasCoords:bool, hasEnrichment:bool }
 * basket_compare { itemCount:int, storeCount:int, hasLocation:bool,
 *                  maxSavingsPct:int, cheapestHasFullBasket:bool }
 * location_toggle { action:'on'|'off' }
 * load_more      { page:int }
 * manual_price   { source:'manual' }
 * app_launch     { source:'web'|'twa'|'shortcut'|'pwa' }
 * sync_stale_banner_shown { ageHours:int, chainsFailed:int }
 */
