import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, push, onValue, update, remove }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const FB = {
  apiKey:"AIzaSyC_D-qyOz_N8EkvYUMmt3TAgpi5P9q7sTw",
  authDomain:"family-shopping-list-7ad33.firebaseapp.com",
  databaseURL:"https://family-shopping-list-7ad33-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:"family-shopping-list-7ad33",
  storageBucket:"family-shopping-list-7ad33.firebasestorage.app",
  messagingSenderId:"844977987151",
  appId:"1:844977987151:web:09ca0aefa9b9727318543a"
};
const app = initializeApp(FB);
const db  = getDatabase(app);

// ── APP VERSION ────────────────────────────────────────────────────────────
// Single source of truth for the frontend build. BUMP on every shipped fix so
// "which build am I running?" is answerable from the UI (group/settings sheet).
const APP_VERSION = '3.1.0';   // 2026-06: search relevance + price stability + radius/pagination + clickable store details

// ── USER IDENTITY ─────────────────────────────────────────────────────────
// Silent upsert — called on every auth. Never blocks UI, never fails loudly.
// Single update() call: Firebase server sets createdAt only if not present
// (via server-side no-op on existing fields is not supported in RTDB, so we
//  use a transaction-free two-field approach: update always, set createdAt
//  only on first write via a separate path check avoided by using update with
//  a createdAt that gets overwritten — acceptable tradeoff vs extra read).
// Actual approach: update() merges fields — safe to call repeatedly.
async function upsertUserProfile(uid) {
  if (!uid) return;
  try {
    const now = Date.now();
    // update() is idempotent and merge-safe in RTDB — will not delete
    // existing fields. createdAt will be overwritten on repeat calls;
    // to preserve it, we'd need a read first (extra RTT not worth it for
    // a background profile. Clients should treat createdAt as "last seen
    // on this device" until a server timestamp is available).
    await update(ref(db, `users/${uid}`), {
      userId:           uid,
      displayName:      myName  || null,
      groupId:          groupId || null,
      lastSeen:         now,
      appVersion:       APP_VERSION,
      migrationVersion: 1,
    });
  } catch(e) {
    // Never block the app over a profile write failure
    console.warn('[identity] upsertUserProfile failed (non-fatal):', e.message);
  }
}

// ── WHATSAPP / SMS DATA MODEL (Phase 6 — design only, not implemented) ────
//
// FIREBASE SCHEMA:
//   incomingMessages/{groupId}/{messageId}
//   → {
//       raw:          string,   // original message text
//       source:       'whatsapp' | 'sms' | 'api',
//       senderId:     string,   // phone number or user uid
//       senderName:   string,
//       receivedAt:   number,   // ms timestamp
//       processed:    boolean,
//       processedAt:  number | null,
//       parsedAction: 'add' | 'bought' | 'query' | 'unknown',
//       parsedItems:  [{ name: string, quantity: number, unit: string | null }],
//       resultItemIds: string[], // Firebase item keys created/updated
//       error:        string | null,
//     }
//
// PARSER FLOW:
//   1. Webhook (Cloud Function or API route) receives raw message
//   2. Hebrew NLP tokenizer splits into action + items
//      "לקנות 2 חלב טרה" → action=add, items=[{name:'חלב טרה', quantity:2}]
//      "קניתי יוגורט"     → action=bought, items=[{name:'יוגורט', quantity:1}]
//   3. Fuzzy match against existing items in groups/{groupId}/items
//   4. Write to Firebase: add item or mark bought
//   5. Update incomingMessages/{groupId}/{messageId}.processed = true
//
// DEDUPLICATION:
//   - Key: hash(groupId + senderId + raw + floor(receivedAt / 60000))
//   - Prevents duplicate processing if webhook fires twice
//
// SECURITY:
//   - Webhook validates sender is a known group member (phone linked to uid)
//   - incomingMessages writable only by server (service account)
//   - App reads incomingMessages for audit trail; users cannot write
//
// CAPACITOR MIGRATION ARCHITECTURE (Phase 5):
//   Problem: Firebase anonymous auth is per-browser-context.
//            Capacitor WebView = new context = new anonymous UID.
//   Solution (3-step):
//     Step A — Before Capacitor release: link anonymous account to phone number
//              via Firebase Phone Auth. UID remains the SAME after linking.
//              App shows one-time "Secure your account" prompt.
//     Step B — Capacitor app signs in with phone auth on first launch.
//              Same UID → same group membership → seamless transition.
//     Step C — Migration code (fallback): if user skips Step A,
//              generate a one-time 8-character transfer code stored at
//              transferCodes/{code} → { uid, groupId, expiresAt }.
//              User enters code in new app. New UID is added to group.
//              Old UID record kept (can be cleaned up later).
//   localStorage migration:
//     Capacitor uses @capacitor/preferences instead of localStorage.
//     Wrap all localStorage calls in a storage adapter before Capacitor release:
//       storage.get(key) / storage.set(key, val) / storage.remove(key)
//     Web: delegates to localStorage. Capacitor: delegates to Preferences plugin.
//   Service worker:
//     Not supported in Capacitor. Replace SW offline strategy with
//     Firebase enableIndexedDbPersistence() before Capacitor migration.
window._lastApiVersion = null; // last `version` seen from /api/prices (server-side build)

window._renderVersionFooter = function() {
  const el = document.getElementById('gs-version');
  if (!el) return;
  const api = window._lastApiVersion ? ` · API v${window._lastApiVersion}` : '';
  el.innerHTML = `📦 גרסה ${APP_VERSION}${api}<br><span style="opacity:.7">לחץ להעתקת פרטי גרסה</span>`;
};

window._copyVersionInfo = function() {
  const info = `Family Shopping\nApp: v${APP_VERSION}\nAPI: v${window._lastApiVersion || '—'}\nURL: ${location.host}\nUA: ${navigator.userAgent}`;
  (navigator.clipboard?.writeText(info) || Promise.reject())
    .then(() => toast('📋 פרטי הגרסה הועתקו'))
    .catch(() => toast(`גרסה ${APP_VERSION}`));
};

// ── AUTH READY HELPER ──────────────────────────────────────────────────
// Returns Promise<FirebaseUser> — always the real anonymous Firebase UID.
// Cached after first resolution so all subsequent calls are instant.
// NEVER falls back to a fake local ID.
let _authUser          = null;   // cached resolved user
let _authReadyPromise  = null;   // singleton promise

function waitForAuthReady() {
  if (_authUser)          return Promise.resolve(_authUser);
  if (_authReadyPromise)  return _authReadyPromise;
  const _auth = getAuth(app);
  _authReadyPromise = new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(_auth, user => {
      if (user) {
        unsub();
        _authUser = user;
        resolve(user);
      }
      // user===null: main onAuthStateChanged will call signInAnonymously,
      // which fires this listener again with the real user.
    }, err => { unsub(); reject(err); });
  });
  return _authReadyPromise;
}
// ──────────────────────────────────────────────────────────────────────

let myName='', myId='', groupId='', groupName='';
let items={}, members={}, prices={}, favorites={};
let _membershipOk = false; // set true once ensureGroupMembership succeeds
let curTab='all', priceRadius=10;
const STORES=['שופרסל','רמי לוי','ויקטורי','יינות ביתן','מחסני להב','אושר עד'];
let activeStores=new Set(STORES);

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;')}

// ── CUSTOM MODAL DIALOGS (replaces native confirm/alert/prompt) ──
(function() {
  function _getOrCreateOverlay() {
    let el = document.getElementById('app-dialog-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-dialog-overlay';
      document.body.appendChild(el);
    }
    return el;
  }

  function _show(html, onMounted) {
    const overlay = _getOrCreateOverlay();
    overlay.innerHTML = html;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      const card = overlay.querySelector('.app-dialog-card');
      if (card) card.classList.add('app-dialog-in');
    });
    if (onMounted) onMounted(overlay);
  }

  function _close() {
    const overlay = document.getElementById('app-dialog-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  window.showConfirm = function(message, onConfirm, onCancel) {
    _show(`
      <div class="app-dialog-card">
        <div class="app-dialog-msg">${esc(message)}</div>
        <div class="app-dialog-btns">
          <button class="app-dialog-btn primary" id="_dlg_ok">אישור</button>
          <button class="app-dialog-btn ghost" id="_dlg_cancel">ביטול</button>
        </div>
      </div>`, overlay => {
      overlay.querySelector('#_dlg_ok').onclick = () => { _close(); if (onConfirm) onConfirm(); };
      overlay.querySelector('#_dlg_cancel').onclick = () => { _close(); if (onCancel) onCancel(); };
    });
  };

  window.showAlert = function(message, onClose) {
    _show(`
      <div class="app-dialog-card">
        <div class="app-dialog-msg">${esc(message)}</div>
        <div class="app-dialog-btns">
          <button class="app-dialog-btn primary" id="_dlg_ok">אישור</button>
        </div>
      </div>`, overlay => {
      overlay.querySelector('#_dlg_ok').onclick = () => { _close(); if (onClose) onClose(); };
    });
  };

  window.showPrompt = function(message, defaultValue, onConfirm, onCancel) {
    _show(`
      <div class="app-dialog-card">
        <div class="app-dialog-msg">${esc(message)}</div>
        <input class="app-dialog-input" id="_dlg_input" value="${esc(defaultValue || '')}" />
        <div class="app-dialog-btns">
          <button class="app-dialog-btn primary" id="_dlg_ok">אישור</button>
          <button class="app-dialog-btn ghost" id="_dlg_cancel">ביטול</button>
        </div>
      </div>`, overlay => {
      const input = overlay.querySelector('#_dlg_input');
      setTimeout(() => { input.focus(); input.select(); }, 50);
      overlay.querySelector('#_dlg_ok').onclick = () => { _close(); if (onConfirm) onConfirm(input.value); };
      overlay.querySelector('#_dlg_cancel').onclick = () => { _close(); if (onCancel) onCancel(); };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { _close(); if (onConfirm) onConfirm(input.value); }
        if (e.key === 'Escape') { _close(); if (onCancel) onCancel(); }
      });
    });
  };
})();

function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active')}

function saveLocal(){localStorage.setItem('fsl_v2',JSON.stringify({myName,myId,groupId,groupName}))}

// ── SETUP SCREEN TAB SWITCHER ──
window.switchSetupTab = function(tab) {
  ['create','join'].forEach(t => {
    document.getElementById(`stab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`spane-${t}`)?.classList.toggle('active', t === tab);
  });
};

window.createGroup=async function(){
  const name=document.getElementById('cn-name').value.trim();
  const grp=document.getElementById('cn-group').value.trim();
  if(!name||!grp){toast('⚠️ מלא שם וקבוצה');return;}

  // ── Step 1: real Firebase UID (8s timeout) ──
  let fbUser;
  try {
    const _authTimeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error('auth_ready_timeout')),8000));
    fbUser = await Promise.race([waitForAuthReady(), _authTimeout]);
  } catch(e) {
    console.error('[createGroup] auth_ready_failed:', e.message);
    toast('לא הצלחנו ליצור קבוצה — בעיית אימות');
    return;
  }

  const code=String(Math.floor(100000+Math.random()*900000));
  groupId=code; groupName=grp;
  myId=fbUser.uid;
  myName=name;
  console.log('[createGroup] auth ok | uid:', myId, '| code:', code);

  // ── Step 2: write group info ──
  try {
    await set(ref(db,`groups/${code}/info`),{name:grp,code});
  } catch(e) {
    console.error('[createGroup] group_write_failed:', e.message);
    toast('לא הצלחנו ליצור קבוצה — בדוק חיבור והרשאות');
    return;
  }

  // ── Step 3: write creator as member ──
  try {
    await set(ref(db,`groups/${code}/members/${myId}`),{name,id:myId,joined:Date.now()});
  } catch(e) {
    console.error('[createGroup] member_write_failed:', e.message);
    toast('לא הצלחנו ליצור קבוצה — שגיאת כתיבה לחברים');
    return;
  }

  saveLocal(); connectToGroup();
  upsertUserProfile(myId).catch(() => {});
};

// Returns 'yes' | 'no' | null (dismissed)
function _showDuplicateMemberDialog(name) {
  return new Promise(resolve => {
    const safe = esc(name);
    const id   = 'dup-member-dlg';
    const el   = document.createElement('div');
    el.id      = id;
    el.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);direction:rtl';
    el.innerHTML = `
      <div style="background:var(--surface,#fff);border-radius:18px;padding:24px 20px;max-width:320px;width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.18)">
        <div style="font-size:16px;font-weight:800;margin-bottom:10px">קיים כבר חבר בשם "${safe}"</div>
        <div style="font-size:14px;color:var(--muted,#888);margin-bottom:20px">האם אתה אותו אדם?</div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button id="dup-yes" style="flex:1;padding:12px;border-radius:12px;border:none;background:var(--accent,#46c97a);color:#fff;font-size:15px;font-weight:700;cursor:pointer">כן</button>
          <button id="dup-no"  style="flex:1;padding:12px;border-radius:12px;border:1.5px solid var(--border,#ddd);background:transparent;font-size:15px;cursor:pointer">לא</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    const cleanup = ans => { el.remove(); resolve(ans); };
    document.getElementById('dup-yes').onclick = () => cleanup('yes');
    document.getElementById('dup-no').onclick  = () => cleanup('no');
    el.addEventListener('click', e => { if (e.target === el) cleanup(null); });
  });
}

window.joinGroup=async function(){
  const name=document.getElementById('jn-name').value.trim();
  const code=document.getElementById('jn-code').value.trim();
  if(!name||code.length!==6){toast('⚠️ מלא שם וקוד 6 ספרות');return;}

  // ── Step 1: real Firebase UID (8s timeout) ──
  let fbUser;
  try {
    const _authTimeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error('auth_ready_timeout')),8000));
    fbUser = await Promise.race([waitForAuthReady(), _authTimeout]);
  } catch(e) {
    console.error('[joinGroup] auth_ready_failed:', e.message);
    toast('לא הצלחנו להצטרף — בעיית אימות');
    return;
  }

  // ── Step 2: verify group exists ──
  let info;
  try {
    const snap=await get(ref(db,`groups/${code}/info`));
    if(!snap.exists()){toast('❌ קבוצה לא נמצאה');return;}
    info=snap.val();
  } catch(e) {
    console.error('[joinGroup] group_read_failed:', e.message);
    const msg = (e.message||'');
    if (msg.includes('PERMISSION_DENIED') || msg.toLowerCase().includes('permission denied'))
      toast('❌ אין גישה לקבוצה — ודא שהקוד נכון ושהקבוצה קיימת');
    else
      toast('❌ שגיאת רשת — נסה שוב');
    return;
  }

  // ── Step 2.5: duplicate member name check ──
  let dupUid = null, dupMemberData = null;
  try {
    const mSnap = await get(ref(db, `groups/${code}/members`));
    if (mSnap.exists()) {
      const normNew = normalizeName(name);
      const entry = Object.entries(mSnap.val()).find(
        ([uid, m]) => uid !== fbUser.uid && normalizeName(m.name || '') === normNew
      );
      if (entry) { dupUid = entry[0]; dupMemberData = entry[1]; }
    }
  } catch(_) { /* non-critical — proceed if members can't be read yet */ }

  if (dupUid !== null) {
    const answer = await _showDuplicateMemberDialog(name);
    if (answer === 'no') {
      const nameEl = document.getElementById('jn-name');
      if (nameEl) { nameEl.value = ''; nameEl.focus(); }
      toast('שם זה כבר קיים — אנא בחר שם אחר');
      return;
    }
    if (answer === null) return; // dialog dismissed without choice
    // answer === 'yes' → transfer existing member profile to this session's UID,
    // then remove the old UID entry so member count stays exactly the same.
  }

  groupId=code; groupName=info.name;
  myId=fbUser.uid;
  myName=name;
  console.log('[joinGroup] auth ok | uid:', myId, '| group:', code);

  // ── Step 3: write member ──
  // YES flow: carry the full existing profile (joined date, role, avatar, etc.)
  //           so no history or preferences are lost.
  // NEW flow: write minimal record with current timestamp.
  const memberRecord = dupMemberData
    ? { ...dupMemberData, id: myId, updatedAt: Date.now() }   // preserve all existing fields
    : { name, id: myId, joined: Date.now() };
  try {
    await set(ref(db, `groups/${code}/members/${myId}`), memberRecord);
  } catch(e) {
    console.error('[joinGroup] member_write_failed:', e.message);
    toast('לא הצלחנו להצטרף — בדוק הרשאות');
    return;
  }

  // Remove old UID entry so the member count stays the same (no duplicate rows).
  // Best-effort — a silent failure here leaves an extra row but doesn't break the app.
  if (dupUid !== null) {
    remove(ref(db, `groups/${code}/members/${dupUid}`)).catch(() => {});
  }

  // Seed myProfile from the copied record so ensureGroupMembership doesn't
  // overwrite the preserved avatar/role with session defaults.
  if (dupMemberData) {
    myProfile = {
      avatarType:  dupMemberData.avatarType  || 'emoji',
      avatarValue: dupMemberData.avatarValue || '👤',
      avatarEmoji: dupMemberData.avatarEmoji || null,
      displayName: name,
    };
    try { localStorage.setItem('fsl_profile', JSON.stringify(myProfile)); } catch(_) {}
  }

  saveLocal(); connectToGroup();
  upsertUserProfile(myId).catch(() => {});
};

// ── ANALYTICS ────────────────────────────────────────────────────────────────
// Batched event queue — writes to analytics/events/{YYYY-MM-DD} via Firebase push().
// Requires auth (auth !== null rule) — events sent only when connected to a group.
const _analyticsQueue      = [];
let   _analyticsFlushPending = false;
const _ANALYTICS_MAX_QUEUE   = 50; // drop events if queue grows unexpectedly large (abuse guard)

function trackEvent(eventName, props = {}) {
  if (!db || !groupId) return;
  if (_analyticsQueue.length >= _ANALYTICS_MAX_QUEUE) return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const entry = {
    event:    eventName,
    ts:       Date.now(),
    group:    groupId.slice(0, 6), // anonymized group prefix only
    platform: 'pwa',
    props,
  };
  _analyticsQueue.push({ today, entry });
  if (_analyticsFlushPending) return;
  _analyticsFlushPending = true;
  // Batch flush after 2 s to avoid spamming writes on rapid interactions
  setTimeout(() => {
    _analyticsFlushPending = false;
    const batch = _analyticsQueue.splice(0);
    batch.forEach(({ today: d, entry: e }) => {
      try { push(ref(db, `analytics/events/${d}`), e).catch(() => {}); } catch (_) {}
    });
  }, 2000);
}

// ── SYNC HEALTH MONITOR ──────────────────────────────────────────────────────
// Reads syncSummary once on app connect. Shows a dismissible banner if prices
// are stale (>36 h) or majority of chains failed the last sync run.
const _STALE_HOURS = 36;

async function checkSyncHealth() {
  if (!db) return;
  try {
    const snap = await withClientTimeout(get(ref(db, 'syncSummary')), 5_000, 'syncSummary');
    if (!snap?.exists()) return;
    const { lastSync, chainsFailed, chainsSucceeded } = snap.val() || {};
    const ageHours    = lastSync ? (Date.now() - lastSync) / 3_600_000 : Infinity;
    const majorFailed = (chainsFailed || 0) > (chainsSucceeded || 0);
    if (ageHours > _STALE_HOURS || majorFailed) {
      const label = isFinite(ageHours) ? `${Math.round(ageHours)} שעות` : 'זמן רב';
      showSyncStaleBanner(label);
      trackEvent('sync_stale_banner_shown', {
        ageHours:    Math.round(isFinite(ageHours) ? ageHours : 999),
        chainsFailed: chainsFailed || 0,
      });
    }
  } catch (_) {} // non-blocking — ignore all failures silently
}

function showSyncStaleBanner(ageLabel) {
  if (document.getElementById('sync-stale-banner')) return; // show once per session
  const banner = document.createElement('div');
  banner.id = 'sync-stale-banner';
  banner.style.cssText = [
    'position:fixed;top:0;left:0;right:0;z-index:9999',
    'background:rgba(248,113,113,.92);backdrop-filter:blur(6px)',
    'padding:10px 14px;display:flex;align-items:center;gap:8px',
    'font-family:Heebo,sans-serif;font-size:13px;font-weight:600;color:#111',
    'direction:rtl;box-shadow:0 2px 12px rgba(0,0,0,.3)',
  ].join(';');
  banner.innerHTML = `
    <span style="flex:1">⚠️ המחירים עשויים להיות לא מעודכנים — הסנכרון האחרון היה לפני ${esc(ageLabel)}</span>
    <button onclick="this.parentElement.remove()" style="background:transparent;border:none;font-size:18px;cursor:pointer;color:#111;line-height:1">✕</button>`;
  document.body.prepend(banner);
}

function connectToGroup(){
  showScreen('main-screen');
  // Cleanup old notifications silently (>30 days)
  setTimeout(() => cleanupOldNotifications(), 5000);
  document.getElementById('hdr-group-name').textContent=groupName;
  document.getElementById('hdr-group-code').textContent=groupId;
  if(document.getElementById('modal-code'))
    document.getElementById('modal-code').textContent=groupId;

  // Connection status listener (global, not group-scoped)
  onValue(ref(db,'.info/connected'),snap=>{
    document.getElementById('online-dot').style.opacity=snap.val()?'1':'.3';
  });

  // Attach all group-scoped listeners (detaches previous ones automatically)
  attachGroupListeners();

  // Save active group to localStorage
  localStorage.setItem('activeGroupId', groupId);

  // Ensure member record + users/{userId}/groups entry
  ensureGroupMembership(groupId, groupName);

  // Load header avatar
  setTimeout(updateHeaderAvatar, 300);
  // Attach hidden admin long-press gesture (silently no-ops for non-admins)
  setTimeout(initAdminGesture, 600);
  // Check sync health — warn users if prices are stale (>36 h since last sync)
  setTimeout(checkSyncHealth, 4000);

  toast('👋 שלום '+myName+'!');

  // If the user arrived via an invite link — offer to join that group too
  if (window._pendingInviteCode) {
    const inviteCode = window._pendingInviteCode;
    window._pendingInviteCode = null;

    if (inviteCode === groupId) {
      // Already a member of this group — nothing to do
      setTimeout(() => toast('✅ כבר חבר בקבוצה זו'), 1200);
    } else {
      // Different group — open the join overlay pre-filled
      setTimeout(() => {
        const codeInput = document.getElementById('ag-join-code');
        if (codeInput) codeInput.value = inviteCode;
        if (typeof switchAddGroupTab === 'function') switchAddGroupTab('join');
        document.getElementById('add-group-overlay')?.classList.add('show');
        toast('🔗 הוזמנת להצטרף לקבוצה — הזן את שמך');
      }, 1000);
    }
  }
}


function _warnPermission(){ toast('⚠️ אין הרשאה — רענן את האפליקציה'); }
// Light haptic tap on supported mobile devices (no-op elsewhere)
function _haptic(ms){ try{ navigator.vibrate && navigator.vibrate(ms||15); }catch(_){} }
window.toggleFav=function(id){const i=items[id];update(ref(db,`groups/${groupId}/items/${id}`),{fav:!i.fav}).then(()=>toast(i.fav?'הוסר מהמועדפים':'⭐ נוסף למועדפים')).catch(e=>{if((e.message||'').includes('PERMISSION_DENIED'))_warnPermission();else toast('❌ '+e.message);});};
window.changeQty=function(id,d){const i=items[id];update(ref(db,`groups/${groupId}/items/${id}`),{qty:Math.max(1,(i.qty||1)+d)}).catch(e=>{if((e.message||'').includes('PERMISSION_DENIED'))_warnPermission();});};
window.clearBought=function(){Object.entries(items).forEach(([id,i])=>{if(i.bought)remove(ref(db,`groups/${groupId}/items/${id}`))});toast('🗑 נקנים נמחקו')};

window.setTab=function(tab){
  curTab=tab;
  ['all','fav','bought','price'].forEach(t=>{
    const el=document.getElementById('tab-'+t);if(el)el.classList.toggle('active',t===tab);
  });
  ['list','fav','price','members'].forEach(n=>{
    const el=document.getElementById('nav-'+n);if(el)el.classList.remove('active');
  });
  if(tab==='price'){document.getElementById('nav-price').classList.add('active');}
  else if(tab==='fav'){document.getElementById('nav-fav').classList.add('active');}
  else{document.getElementById('nav-list').classList.add('active');}

  const isPrice = tab === 'price';
  const isFav   = tab === 'fav';

  document.getElementById('add-bar').style.display   = isPrice ? 'none' : 'flex';
  document.getElementById('list-panel').style.display = (isPrice || isFav) ? 'none' : 'flex';
  document.getElementById('price-panel').style.display = isPrice ? 'flex' : 'none';

  const favPanel = document.getElementById('fav-panel');
  if (favPanel) favPanel.style.display = isFav ? 'flex' : 'none';

  // Show price-tools (scan/basket) only on price tab
  const pt = document.getElementById('price-tools');
  if (pt) pt.style.display = isPrice && pt.children.length ? 'flex' : 'none';

  if (isPrice) { renderPrices(); _resolverReadyPromise; /* ensure pre-warmed */ }
  else if (isFav) renderFavoritesPanel();
  else renderList();
};

function renderList(){
  const wrap=document.getElementById('list-content');
  let list=Object.entries(items).map(([id,v])=>({...v,id})).sort((a,b)=>(b.ts||0)-(a.ts||0));
  if(curTab==='fav') list=list.filter(i=>i.fav);
  if(curTab==='bought') list=list.filter(i=>i.bought);
  if(!list.length){
    const m={all:{e:'🛒',t:'הרשימה ריקה'},fav:{e:'⭐',t:'אין מועדפים'},bought:{e:'✅',t:'עדיין לא קנית'}};
    const d=m[curTab]||m.all;
    wrap.innerHTML=`<div class="empty"><div class="em">${d.e}</div><p>${d.t}</p></div>`;return;
  }
  const pending=list.filter(i=>!i.bought), bList=list.filter(i=>i.bought);
  let html='';
  if(pending.length){
    if(curTab!=='bought')html+=`<div class="sec-label">לקנות (${pending.length})</div>`;
    pending.forEach(i=>html+=itemHTML(i));
  }
  if(bList.length){
    html+=`<div class="sec-label">✅ נקנה (${bList.length})</div>`;
    bList.forEach(i=>html+=itemHTML(i));
    if(curTab!=='fav')html+=`<button class="clear-btn" onclick="clearBought()">🗑 מחק את כל הנקנים</button>`;
  }
  wrap.innerHTML=html;
  // Load cheapest price chips for pending items with barcodes (non-blocking)
  if(curTab==='all') setTimeout(loadItemPricesInBackground, 80);
}

// itemHTML defined below with attribution support

function updateCounts(){
  const all=Object.keys(items).length;
  const favCount=Object.keys(favorites).length;
  const bought=Object.values(items).filter(i=>i.bought).length;
  const pending=all-bought;
  document.getElementById('cnt-all').textContent=all;
  document.getElementById('cnt-fav').textContent=favCount;
  document.getElementById('cnt-bought').textContent=bought;
  // Cart badge in header: show pending (not bought) count
  const cartBadge = document.getElementById('hdr-cart-badge');
  if (cartBadge) {
    cartBadge.textContent = pending > 0 ? pending : '';
    cartBadge.classList.toggle('show', pending > 0);
  }
}

function renderAvatars(){
  // Keep hidden av-stack populated for any code that might read it
  const stack=document.getElementById('av-stack');
  if(stack){
    stack.innerHTML=Object.values(members).slice(0,4).map(m=>{
      const name = m.displayName || m.name || '?';
      if(m.avatarType==='photo'&&m.avatarValue&&!m.avatarValue.startsWith('blob:')) {
        return `<div class="av" title="${esc(name)}" style="overflow:hidden;padding:0">
          <img src="${esc(m.avatarValue)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">
        </div>`;
      }
      const e = m.avatarType==='cartoon'?(m.avatarEmoji||'🧑'):(m.avatarValue||name.charAt(0)||'?');
      return `<div class="av" title="${esc(name)}">${e}</div>`;
    }).join('');
  }
  // Update group pill member count
  const cnt = document.getElementById('hdr-grp-cnt');
  if (cnt) {
    const n = Object.keys(members).length;
    cnt.textContent = n > 0 ? n : '';
  }
}

// ── LIVE PRICE SEARCH ──
let lastSearchQuery = '';
let searchResults = [];
let selectedProduct = null;
// Request-identity guards — only the LATEST request may render. Prevents a slow
// first response (cold Vercel / cold Firebase) from overwriting a newer, valid one.
let _searchSeq = 0;   // increments per price search
let _pdSeq     = 0;   // increments per product price-detail view
// Search-product store-list pagination (10 at a time, reset on every new product view)
let _spdPrices    = [];
let _spdWarnings  = null;
let _spdSpreadHTML = '';
let _spdPage      = 1;
const SPD_PAGE    = 10;

window.setRadius=function(v){
  priceRadius=+v;
  const el=document.getElementById('radius-val');
  if(el) el.textContent=v+' ק"מ';
};
window.toggleStore=function(s){
  if(activeStores.has(s))activeStores.delete(s); else activeStores.add(s);
  if(selectedProduct) showProductPrices(selectedProduct);
};

function renderQuickItems(){
  const wrap = document.getElementById('quick-items');
  if(!wrap) return;
  const pending = Object.values(items).filter(i=>!i.bought).slice(0,10);
  if(!pending.length){wrap.style.display='none';return;}
  wrap.style.display='flex';
  wrap.innerHTML = pending.map(i=>
    `<button class="quick-chip" onclick="quickSearch('${esc(i.name)}')">${esc(i.name)}</button>`
  ).join('');
}

window.quickSearch = function(name){
  document.getElementById('price-search-input').value = name;
  searchPrices();
};

window.searchPrices = async function(){
  const q = document.getElementById('price-search-input').value.trim();
  if(!q || q.length < 2){toast('⚠️ הכנס שם מוצר לחיפוש');return;}

  // Tap-lock: disable search button immediately and show spinner so the
  // user gets instant feedback and accidental re-taps are ignored.
  const _btn = document.querySelector('.price-search-btn');
  if (_btn?._searching) return;           // already in flight — ignore tap
  if (_btn) { _btn._searching = true; _btn.textContent = '⏳'; _btn.disabled = true; }
  const _unlock = () => { if (_btn) { _btn._searching = false; _btn.textContent = '🔍'; _btn.disabled = false; } };

  // Wait for translation modules to load (up to 3s) before firing so
  // first-tap searches get Hebrew→English resolution, not raw Hebrew.
  await _resolverReadyPromise;

  // Run through translation resolver pipeline
  await resolveAndSearch(q, async (resolvedQuery) => {
    const mySeq = ++_searchSeq;          // claim latest — older responses self-cancel
    lastSearchQuery = resolvedQuery;
    selectedProduct = null;
    const wrap = document.getElementById('price-content');
    const locationLabel = _hasLoc()
      ? ` · 📍 סניפים עד ${_nearbyRadius} ק"מ`
      : ' בכל הסופרמרקטים';
    wrap.innerHTML = `<div class="price-loading"><div class="spin"></div><p>מחפש "${esc(q)}"${locationLabel}...</p></div>`;
    try {
      let _apiUrl = `/api/prices?q=${encodeURIComponent(resolvedQuery)}`;
      if (_hasLoc()) {
        _apiUrl += `&lat=${_locLat()}&lng=${_locLng()}&radiusKm=${_nearbyRadius}`;
      }
      // 15s client timeout so a hung first request can't strand the UI on "loading"
      const ctrl = new AbortController();
      const tmo  = setTimeout(() => ctrl.abort(), 15000);
      let res, data;
      try {
        res  = await fetch(_apiUrl, { signal: ctrl.signal });
        data = await res.json();
      } finally { clearTimeout(tmo); }

      if (mySeq !== _searchSeq) { _unlock(); return; }  // a newer search superseded this one

      if (data.version) window._lastApiVersion = data.version;  // track deployed API build

      // Server timeout / error (504/503) → offer RETRY, never a false "no results"
      if (!res.ok || data.error) {
        wrap.innerHTML = _renderSearchRetry(q);
        _unlock(); return;
      }

      if (!data.results || !data.results.length) {
        wrap.innerHTML = `<div class="search-hint"><div class="sh-icon">🔍</div><p>לא נמצאו תוצאות עבור "${esc(q)}"</p><small>נסה שם שונה</small></div>`;
        _unlock(); return;
      }

      // Products exist but radius filtered ALL prices — show friendly no-nearby UI
      if (data.hasProductsButNoNearbyPrices) {
        wrap.innerHTML = _renderNearbyNoResults(q, data);
        _unlock(); return;
      }

      searchResults = data.results;
      // Only fall back to manual entry when the single result genuinely has NO prices.
      // (API exposes prices under `prices`, not `storePrices` — the old field name
      //  was always undefined, forcing manual fallback even when prices existed.)
      if (data.results.length === 1 && !data.results[0].prices?.length) {
        wrap.innerHTML = renderManualFallback(q, data.results[0]);
      } else {
        renderSearchResults(data.results, q);
      }
      _unlock();
    } catch(e) {
      if (mySeq !== _searchSeq) { _unlock(); return; }  // superseded — stay silent
      // Network failure / abort → RETRY affordance, not a fake empty/manual state
      wrap.innerHTML = _renderSearchRetry(q);
      _unlock();
    }
  });
  _unlock(); // fallback — if resolveAndSearch exits without calling callback
};

// Retry card shown on network error / timeout (never a false "no prices")
function _renderSearchRetry(q) {
  return `<div class="search-hint"><div class="sh-icon">⏳</div>
    <p>החיפוש לקח יותר מדי זמן</p>
    <small>בדוק את החיבור ונסה שוב</small>
    <button class="nnr-btn primary" style="margin-top:12px"
      onclick="searchPrices()">🔄 נסה שוב</button></div>`;
}

// ── NO-NEARBY-RESULTS: context-aware feedback with action buttons ─────────────
function _renderNearbyNoResults(q, data) {
  const radius  = data.radiusKm || _nearbyRadius;
  const locName = _selectedLocation?.label || 'המיקום הנבחר';

  // Distinguish: coords exist but no stores nearby vs no geocoded stores at all
  const hasGeocoded = data.results?.some(r => (r.totalPricesBeforeRadius || 0) > 0);

  if (!hasGeocoded) {
    // Stores haven't been geocoded yet
    return `<div class="nearby-no-results">
      <div class="nnr-icon">🗺️</div>
      <div class="nnr-title">החנויות עדיין לא ממופות למיקום</div>
      <div class="nnr-sub">טרם בוצע גאוקוד לחנויות.<br>ניתן לחפש ללא סינון קרבה או לשנות מיקום.</div>
      <div class="nnr-actions">
        <button class="nnr-btn primary" onclick="searchEverywhere(${JSON.stringify(q)})">🌍 חפש בכל הארץ</button>
        <button class="nnr-btn ghost" onclick="openManualAddressModal()">📌 בחר מיקום אחר</button>
      </div>
    </div>`;
  }

  // Geocoded stores exist, but none within this radius carry the product
  const maxBefore   = Math.max(...(data.results || []).map(r => r.totalPricesBeforeRadius || 0));
  const approxCount = data.approximateNearbyCount || 0;
  return `<div class="nearby-no-results">
    <div class="nnr-icon">📍</div>
    <div class="nnr-title">מצאתי מוצרים — אבל לא בחנויות קרובות</div>
    <div class="nnr-sub">
      ליד <strong>${esc(locName)}</strong> אין מחיר על "${esc(q)}"<br>
      בטווח ${radius} ק"מ.
      ${maxBefore > 0 ? `נמצאו מחירים ב-${maxBefore} חנויות אחרות בארץ.` : ''}
    </div>
    <div class="nnr-actions">
      <button class="nnr-btn primary" onclick="increaseRadius()">🔭 הגדל רדיוס ל-${_nextRadius()} ק"מ</button>
      ${approxCount > 0 ? `<button class="nnr-btn ghost" onclick="searchPricesWithApproximate(${JSON.stringify(q)})">📍 הצג גם מיקומים משוערים (${approxCount})</button>` : ''}
      <button class="nnr-btn ghost" onclick="searchEverywhere(${JSON.stringify(q)})">🌍 חפש בכל הארץ</button>
      <button class="nnr-btn ghost" onclick="openManualAddressModal()">📌 בחר מיקום אחר</button>
    </div>
  </div>`;
}

// Return the next larger radius step from the current
function _nextRadius() {
  const steps = [1, 3, 5, 10, 25, 50];
  const idx = steps.indexOf(_nearbyRadius);
  return idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : 50;
}

// Bump to the next radius step and re-search
window.increaseRadius = function() {
  setNearbyRadius(_nextRadius());
};

// Run the search without any location filter (one-shot, does not clear _selectedLocation)
window.searchEverywhere = async function(q) {
  const wrap = document.getElementById('price-content');
  if (!q) q = lastSearchQuery;
  if (!q) return;
  wrap.innerHTML = `<div class="price-loading"><div class="spin"></div><p>מחפש "${esc(q)}" בכל הארץ...</p></div>`;
  try {
    const res  = await fetch(`/api/prices?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.results?.length) {
      wrap.innerHTML = `<div class="search-hint"><div class="sh-icon">🔍</div>
        <p>לא נמצאו תוצאות עבור "${esc(q)}"</p><small>נסה שם שונה</small></div>`;
      return;
    }
    searchResults = data.results;
    // Add a banner noting we're showing all-country results
    renderSearchResults(data.results, q);
    const content = document.getElementById('price-content');
    if (content) {
      const banner = document.createElement('div');
      banner.style.cssText = 'text-align:center;font-size:11px;color:var(--muted);padding:6px 0 2px;';
      banner.textContent = '🌍 מציג מחירים מכל הארץ';
      content.insertBefore(banner, content.firstChild);
    }
  } catch(e) {
    wrap.innerHTML = renderManualFallback(q, null);
  }
};

// Re-run last search including APPROXIMATE location stores (one-shot, user-initiated)
window.searchPricesWithApproximate = async function(q) {
  const wrap = document.getElementById('price-content');
  if (!q) q = lastSearchQuery;
  if (!q) return;
  wrap.innerHTML = `<div class="price-loading"><div class="spin"></div><p>מחפש "${esc(q)}" כולל מיקומים משוערים...</p></div>`;
  try {
    let url = `/api/prices?q=${encodeURIComponent(q)}&includeApproximate=true`;
    if (_hasLoc()) url += `&lat=${_locLat()}&lng=${_locLng()}&radiusKm=${_nearbyRadius}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.results?.length) {
      wrap.innerHTML = `<div class="search-hint"><div class="sh-icon">🔍</div>
        <p>לא נמצאו תוצאות עבור "${esc(q)}"</p><small>נסה שם שונה</small></div>`;
      return;
    }
    searchResults = data.results;
    renderSearchResults(data.results, q);
    const content = document.getElementById('price-content');
    if (content) {
      const banner = document.createElement('div');
      banner.style.cssText = 'text-align:center;font-size:11px;color:#f59e0b;padding:6px 0 2px;';
      banner.textContent = '📍 כולל חנויות במיקום משוער';
      content.insertBefore(banner, content.firstChild);
    }
  } catch(e) {
    wrap.innerHTML = renderManualFallback(q, null);
  }
};

// ── SEARCH RESULTS v2 ────────────────────────────────────────────────

const CHAIN_META = {
  'שופרסל':     { color: '#f97316', bg: '#431407' },
  'רמי לוי':    { color: '#3b82f6', bg: '#0f1a35' },
  'ויקטורי':    { color: '#8b5cf6', bg: '#1d1135' },
  'יינות ביתן': { color: '#ec4899', bg: '#3b0a2a' },
  'אושר עד':    { color: '#10b981', bg: '#052e16' },
  'מחסני להב':  { color: '#f59e0b', bg: '#1c1007' },
};

// ── NEARBY MODE ──────────────────────────────────────────────────────────────
// Enabled: stores/{key}.latitude/longitude are populated from the 422-store sync.
const NEARBY_COORDS_READY = true;

let _nearbyMode       = false;
let _selectedLocation = null;  // { label, lat, lng, source: 'gps'|'manual' }
let _nearbyRadius     = 3;     // km, persisted in localStorage
let _recentLocations  = [];    // up to 5 manual locations, persisted in localStorage

// Convenience helpers (replaces raw _userLat / _userLng access)
const _locLat  = () => _selectedLocation?.lat  ?? null;
const _locLng  = () => _selectedLocation?.lng  ?? null;
const _hasLoc  = () => Boolean(_nearbyMode && _selectedLocation?.lat);

(function _initNearbyState() {
  const r = parseInt(localStorage.getItem('nearbyRadius') || '3', 10);
  if ([1,3,5,10,25,50].includes(r)) _nearbyRadius = r;
  try {
    const sl = localStorage.getItem('selectedLocation');
    if (sl) _selectedLocation = JSON.parse(sl);
  } catch (_) {}
  try {
    const rl = localStorage.getItem('recentLocations');
    if (rl) _recentLocations = JSON.parse(rl);
  } catch (_) {}
})();

function _syncNearbyUI() {
  const btn        = document.getElementById('nearby-toggle-btn');
  const strip      = document.getElementById('nearby-strip');
  const labelBar   = document.getElementById('loc-label-bar');
  const labelTxt   = document.getElementById('loc-label-txt');
  const srcBtn     = document.getElementById('loc-source-btn');
  const srcIcon    = document.getElementById('loc-source-icon');
  const srcLabel   = document.getElementById('loc-source-label');
  if (!btn || !strip) return;

  btn.classList.toggle('active', _nearbyMode);
  strip.classList.toggle('show', _nearbyMode);

  // Location label bar (visible when nearby mode ON and location is set)
  const hasLoc = _hasLoc();
  if (labelBar) labelBar.classList.toggle('show', hasLoc);
  if (labelTxt && _selectedLocation) {
    labelTxt.textContent = `משווה מחירים ליד: ${_selectedLocation.label}`;
  }

  // Source button state
  if (srcBtn) srcBtn.classList.toggle('has-loc', Boolean(_selectedLocation));
  if (srcIcon && srcLabel && _selectedLocation) {
    srcIcon.textContent  = _selectedLocation.source === 'gps' ? '✅' : '📌';
    srcLabel.textContent = _selectedLocation.label;
  } else if (srcLabel) {
    srcLabel.textContent = 'בחר מיקום';
    if (srcIcon) srcIcon.textContent = '📍';
  }

  // Radius buttons
  document.querySelectorAll('#radius-seg .radius-seg-btn').forEach((b, i) => {
    b.classList.toggle('active', [1,3,5,10,25,50][i] === _nearbyRadius);
  });

  // Populate recent locations in dropdown
  _renderRecentLocOpts();
}

window.toggleNearbyMode = function() {
  if (!NEARBY_COORDS_READY) {
    toast('📍 סינון לפי מיקום יהיה זמין בקרוב — נתוני קואורדינטות סניפים בתהליך איסוף');
    return;
  }
  _nearbyMode = !_nearbyMode;
  _syncNearbyUI();
  if (_nearbyMode && !_hasLoc()) toggleLocDropdown();
};

window.setNearbyRadius = function(km) {
  _nearbyRadius = km;
  localStorage.setItem('nearbyRadius', String(km));
  _syncNearbyUI();
  if (_hasLoc() && lastSearchQuery) searchPrices();
};

// ── LOCATION MANAGEMENT ──────────────────────────────────────────────────────

// Set the active location and persist to localStorage
function _setLocation(loc) {
  _selectedLocation = loc;
  try { localStorage.setItem('selectedLocation', JSON.stringify(loc)); } catch(_) {}
  _syncNearbyUI();
}

// Clear the active location
window.clearLocation = function() {
  _selectedLocation = null;
  try { localStorage.removeItem('selectedLocation'); } catch(_) {}
  _syncNearbyUI();
  if (lastSearchQuery) searchPrices();
};

// Save a manual location to recent list (max 5, deduped by address or label)
function _saveRecentLocation(loc) {
  if (loc.source !== 'manual') return;
  const key = loc.address || loc.label;
  _recentLocations = _recentLocations.filter(r => (r.address || r.label) !== key);
  _recentLocations.unshift({ ...loc, lastUsedAt: new Date().toISOString() });
  if (_recentLocations.length > 5) _recentLocations.length = 5;
  try { localStorage.setItem('recentLocations', JSON.stringify(_recentLocations)); } catch(_) {}
}

// Remove a recent location by index
window.deleteRecentLocation = function(idx, ev) {
  ev?.stopPropagation();
  const removed = _recentLocations.splice(idx, 1)[0];
  try { localStorage.setItem('recentLocations', JSON.stringify(_recentLocations)); } catch(_) {}
  if (removed && _selectedLocation?.address === removed.address) clearLocation();
  else _syncNearbyUI();
};

// Render recent locations inside the dropdown
function _renderRecentLocOpts() {
  const el = document.getElementById('loc-recent-opts');
  if (!el) return;
  if (!_recentLocations.length) { el.innerHTML = ''; return; }
  el.innerHTML = _recentLocations.map((r, i) => `
    <div class="loc-opt" onclick="selectRecentLocation(${i})">
      <span class="loc-opt-ic">📌</span>
      <span class="loc-opt-lbl">${esc(r.label || r.address)}</span>
      <button class="loc-opt-del" onclick="deleteRecentLocation(${i},event)" title="מחק">✕</button>
    </div>`).join('');
}

// Select a recent location by index
window.selectRecentLocation = function(idx) {
  const loc = _recentLocations[idx];
  if (!loc) return;
  loc.lastUsedAt = new Date().toISOString();
  _setLocation(loc);
  closeLocDropdown();
  if (lastSearchQuery) searchPrices();
};

// ── GPS location ──────────────────────────────────────────────────────────────
window.selectLocGPS = async function() {
  closeLocDropdown();
  if (!navigator.geolocation) { toast('⚠️ GPS לא נתמך בדפדפן זה'); return; }
  const srcLabel = document.getElementById('loc-source-label');
  const srcIcon  = document.getElementById('loc-source-icon');
  if (srcLabel) srcLabel.textContent = 'מאתר...';
  if (srcIcon)  srcIcon.textContent  = '⏳';
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject,
        { timeout: 8000, maximumAge: 60000, enableHighAccuracy: false })
    );
    _setLocation({
      label:  'המיקום שלי עכשיו',
      lat:    pos.coords.latitude,
      lng:    pos.coords.longitude,
      source: 'gps',
    });
    toast('📍 מיקום נמצא!');
    if (lastSearchQuery) searchPrices();
  } catch (e) {
    _syncNearbyUI(); // restore button state
    toast('⚠️ לא ניתן לקבל מיקום — בדוק הרשאות GPS');
  }
};

// Backward-compat alias (called from HTML and modal)
window.requestLocation = window.selectLocGPS;

// ── Location dropdown ────────────────────────────────────────────────────────
window.toggleLocDropdown = function() {
  const dd = document.getElementById('loc-dropdown');
  if (!dd) return;
  _renderRecentLocOpts();
  dd.classList.toggle('open');
  if (dd.classList.contains('open')) {
    // Close on outside click
    setTimeout(() => document.addEventListener('click', _closeLocDropdownOutside, { once: true }), 0);
  }
};

function _closeLocDropdownOutside(e) {
  const wrap = document.getElementById('loc-source-wrap');
  if (wrap && !wrap.contains(e.target)) closeLocDropdown();
}

window.closeLocDropdown = function() {
  document.getElementById('loc-dropdown')?.classList.remove('open');
};

// ── Manual address modal ──────────────────────────────────────────────────────
window.openManualAddressModal = function() {
  closeLocDropdown();
  document.getElementById('addr-input').value = '';
  document.getElementById('addr-error').textContent = '';
  document.getElementById('addr-result').textContent = '';
  document.getElementById('addr-submit-btn').textContent = 'חפש כתובת';
  document.getElementById('addr-submit-btn').disabled = false;
  document.getElementById('addr-overlay').classList.add('show');
  setTimeout(() => document.getElementById('addr-input')?.focus(), 300);
};

window.closeManualAddressModal = function() {
  document.getElementById('addr-overlay').classList.remove('show');
};

window.submitManualAddress = async function() {
  const input   = document.getElementById('addr-input');
  const errEl   = document.getElementById('addr-error');
  const resEl   = document.getElementById('addr-result');
  const btn     = document.getElementById('addr-submit-btn');
  const address = (input?.value || '').trim();

  if (!address || address.length < 3) {
    input?.classList.add('error');
    errEl.textContent = 'נא להזין כתובת (לפחות 3 תווים)';
    return;
  }
  input?.classList.remove('error');
  errEl.textContent = '';
  btn.textContent   = '⏳ מחפש...';
  btn.disabled      = true;
  if (resEl) resEl.textContent = '';

  try {
    const res  = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`);
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error || 'כתובת לא נמצאה — נסה לפרט יותר';
      if (data.suggestion && resEl) resEl.textContent = `אולי התכוונת: ${data.suggestion}`;
      input?.classList.add('error');
      btn.textContent = 'חפש כתובת';
      btn.disabled    = false;
      return;
    }

    if (resEl) resEl.textContent = `✅ ${data.formattedAddress}`;

    const loc = {
      label:            data.formattedAddress || address,
      address,
      lat:              data.lat,
      lng:              data.lng,
      source:           'manual',
      createdAt:        new Date().toISOString(),
    };
    _saveRecentLocation(loc);
    _setLocation(loc);
    closeManualAddressModal();
    toast(`📌 מיקום נבחר: ${loc.label.slice(0, 40)}`);
    if (lastSearchQuery) searchPrices();
  } catch (e) {
    errEl.textContent = 'שגיאת חיבור — נסה שוב';
    btn.textContent   = 'חפש כתובת';
    btn.disabled      = false;
  }
};

async function _fetchNearby(barcode) {
  if (!barcode || !_hasLoc()) return null;
  try {
    const url = `/api/prices?barcode=${encodeURIComponent(barcode)}&lat=${_locLat()}&lng=${_locLng()}&radiusKm=${_nearbyRadius}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const ps = Array.isArray(data.prices) ? data.prices : [];
    if (!ps.length) return null;
    return {
      results: ps
        .map(p => ({
          chainName:  p.chainName  || '',
          storeName:  p.storeName  || `סניף ${p.storeId}`,
          storeId:    p.storeId    || '',
          city:       p.city       || '',
          price:      parseFloat(p.displayPrice ?? p.price) || 0,
          distanceKm: p.distanceKm != null ? p.distanceKm : null,
          syncedAt:   p.syncedAt   || null,
          isStale:    p.isStale    || false,
        }))
        .filter(p => p.price > 0)
        .sort((a, b) => a.price - b.price),
    };
  } catch (_) { return null; }
}

// ── CITY FILTER — MULTI-CITY CHIP SELECTOR ───────────────────────────────────
let _cityFilterActive  = false;
let _selectedCities    = [];    // display city names chosen from suggestions
let _cityDebounce      = null;
let _citySugItems      = [];    // current suggestion list [{ city, count }]
let _citySugFocusIdx   = -1;    // keyboard-nav index into _citySugItems

// ── Restore from localStorage ──
(function _initCityState() {
  try {
    const saved = JSON.parse(localStorage.getItem('priceFilterCities') || '[]');
    if (Array.isArray(saved)) {
      _selectedCities = saved.filter(c => typeof c === 'string' && c.trim().length > 0);
    }
  } catch (_) {}
  // Auto-show strip if persisted cities exist
  if (_selectedCities.length > 0) _cityFilterActive = true;
})();

// ── Render chips inside city-chips-container ──
function _renderCityChips() {
  const container = document.getElementById('city-chips-container');
  const input     = document.getElementById('city-filter-input');
  if (!container) return;
  container.innerHTML = _selectedCities.map(city =>
    `<span class="city-chip">
       <span class="city-chip-label">${esc(city)}</span>
       <button class="city-chip-x" onclick="_removeCityChip(${JSON.stringify(city)})" title="הסר">×</button>
     </span>`
  ).join('');
  if (input) input.placeholder = _selectedCities.length ? 'הוסף עיר נוספת...' : 'הוסף עיר...';
}

// ── Sync button + strip visibility ──
function _syncCityUI() {
  const btn   = document.getElementById('city-toggle-btn');
  const strip = document.getElementById('city-filter-strip');
  if (!btn || !strip) return;
  const show = _cityFilterActive || _selectedCities.length > 0;
  btn.classList.toggle('active', show);
  strip.classList.toggle('show',  show);
  _renderCityChips();
}

// ── Public: toggle filter panel ──
window.toggleCityFilter = function() {
  _cityFilterActive = !_cityFilterActive;
  _syncCityUI();
  if (_cityFilterActive) {
    setTimeout(() => document.getElementById('city-filter-input')?.focus(), 80);
  } else {
    _hideCitySuggestions();
  }
};

// ── Public: clear ALL selected cities ──
window.clearCityFilter = function() {
  _selectedCities    = [];
  _cityFilterActive  = false;
  _hideCitySuggestions();
  const inp = document.getElementById('city-filter-input');
  if (inp) { inp.value = ''; }
  localStorage.setItem('priceFilterCities', '[]');
  _syncCityUI();
};

// ── Add a city chip (called on suggestion tap / Enter) ──
window._addCityChip = function(city) {
  if (!city || _selectedCities.includes(city)) return;
  _selectedCities = [..._selectedCities, city];
  localStorage.setItem('priceFilterCities', JSON.stringify(_selectedCities));
  _hideCitySuggestions();
  const inp = document.getElementById('city-filter-input');
  if (inp) { inp.value = ''; inp.focus(); }
  _syncCityUI();
};

// ── Remove a city chip ──
window._removeCityChip = function(city) {
  _selectedCities = _selectedCities.filter(c => c !== city);
  localStorage.setItem('priceFilterCities', JSON.stringify(_selectedCities));
  if (_selectedCities.length === 0) _cityFilterActive = false;
  _syncCityUI();
};

// ── Render suggestion dropdown ──
function _renderCitySuggestions(q) {
  const panel = document.getElementById('city-suggestions-panel');
  if (!panel) return;

  const filtered = _citySugItems.filter(s => !_selectedCities.includes(s.city));
  if (!filtered.length) {
    panel.innerHTML = `<div class="city-sug-empty">לא נמצאו ערים מתאימות</div>`;
    panel.classList.add('open');
    return;
  }

  panel.innerHTML = filtered.map((s, i) => {
    const label = _highlightMatch(esc(s.city), q);
    return `<div class="city-sug-item${i === _citySugFocusIdx ? ' focused' : ''}"
                 onclick="_addCityChip(${JSON.stringify(s.city)})"
                 data-idx="${i}">
               <span>${label}</span>
               <span class="city-sug-count">${s.count} סניף${s.count !== 1 ? 'ים' : ''}</span>
             </div>`;
  }).join('');
  panel.classList.add('open');
}

/** Bold the matched substring in a city label (safe — esc() already applied). */
function _highlightMatch(escapedCity, q) {
  if (!q) return escapedCity;
  const idx = escapedCity.indexOf(q);
  if (idx < 0) return escapedCity;
  return escapedCity.slice(0, idx)
    + `<strong>${escapedCity.slice(idx, idx + q.length)}</strong>`
    + escapedCity.slice(idx + q.length);
}

function _hideCitySuggestions() {
  const panel = document.getElementById('city-suggestions-panel');
  if (panel) { panel.innerHTML = ''; panel.classList.remove('open'); }
  _citySugFocusIdx = -1;
  _citySugItems    = [];
}

// ── Fetch suggestions from API ──
async function _loadCitySuggestions(q) {
  try {
    const res = await fetch(`/api/stores-cities?q=${encodeURIComponent(q)}`);
    if (!res.ok) { _hideCitySuggestions(); return; }
    _citySugItems    = await res.json();
    _citySugFocusIdx = -1;
    _renderCitySuggestions(q);
  } catch (_) { _hideCitySuggestions(); }
}

// ── Input handler (debounced 200ms) ──
window._onCityInput = function(val) {
  clearTimeout(_cityDebounce);
  if (!val.trim()) { _hideCitySuggestions(); return; }
  _cityDebounce = setTimeout(() => _loadCitySuggestions(val.trim()), 200);
};

// ── Keyboard navigation ──
window._onCityKeydown = function(e) {
  const panel   = document.getElementById('city-suggestions-panel');
  const visible = panel?.classList.contains('open');
  const filtered = _citySugItems.filter(s => !_selectedCities.includes(s.city));

  if (e.key === 'ArrowDown' && visible) {
    e.preventDefault();
    _citySugFocusIdx = Math.min(_citySugFocusIdx + 1, filtered.length - 1);
    _renderCitySuggestions(e.target.value.trim());
  } else if (e.key === 'ArrowUp' && visible) {
    e.preventDefault();
    _citySugFocusIdx = Math.max(_citySugFocusIdx - 1, -1);
    _renderCitySuggestions(e.target.value.trim());
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const pick = _citySugFocusIdx >= 0 ? filtered[_citySugFocusIdx] : filtered[0];
    if (pick) _addCityChip(pick.city);
  } else if (e.key === 'Backspace' && !e.target.value && _selectedCities.length > 0) {
    // Remove last chip on backspace when input is empty
    _removeCityChip(_selectedCities[_selectedCities.length - 1]);
  } else if (e.key === 'Escape') {
    _hideCitySuggestions();
  }
};

// Close suggestions when clicking outside
document.addEventListener('click', e => {
  const strip = document.getElementById('city-filter-strip');
  const panel = document.getElementById('city-suggestions-panel');
  if (!strip?.contains(e.target) && !panel?.contains(e.target)) {
    _hideCitySuggestions();
  }
}, true);

/** Fetch /api/prices-by-city for all selected cities. */
async function _fetchByCity(barcode) {
  if (!barcode || _selectedCities.length === 0) return null;
  try {
    const params = new URLSearchParams({ barcode });
    for (const city of _selectedCities) params.append('city', city);
    const res = await fetch(`/api/prices-by-city?${params.toString()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

// Score how well a product name matches the search query
function matchScore(name, query) {
  const n = (name || '').trim().toLowerCase();
  const q = (query || '').trim().toLowerCase();
  if (!q) return 50;
  if (n === q) return 100;
  if (n.startsWith(q)) return n[q.length] === ' ' ? 90 : 85;
  const words = n.split(/\s+/);
  if (words[0] === q) return 88;
  if (words.includes(q)) return 75;
  if (n.includes(q)) return 60;
  const qWords = q.split(/\s+/);
  if (qWords.length > 1 && qWords.every(qw => words.some(w => w.startsWith(qw)))) return 40;
  return 10;
}

// Filter state – active (applied) and drawer (in-progress editing)
let _filterState = { chains: new Set(), officialOnly: false, matchQuality: 'all' };
// Chain-grouped data from last successful search
let _chainGroups = [];

function _normalizeResults(results) {
  // API v6 returns: { name, barcode, prices: [{chainName, storeName, displayPrice, price, unit, ...}] }
  const normalized = results.map(r => {
    // Primary: r.prices[] from buildLayeredPrices (official / proxy / manual)
    const rawPrices = Array.isArray(r.prices) ? r.prices : [];
    const stores = rawPrices
      .map(p => ({
        store:               p.chainName || p.storeName || p.chain || '',
        storeName:           p.storeName || '',
        storeId:             p.storeId   || '',
        chainId:             p.chainId   || '',
        city:                p.city      || '',
        address:             p.address   || '',
        latitude:            p.latitude  ?? null,
        longitude:           p.longitude ?? null,
        distanceKm:          p.distanceKm != null ? p.distanceKm : null,
        price:               parseFloat(p.displayPrice ?? p.price) || 0,
        unit:                p.unit || '',
        syncedAt:            p.syncedAt  || null,
        source:              p.source || '',
        isStale:             p.isStale || false,
        approximateLocation: p.approximateLocation === true,
      }))
      .filter(sp => sp.price > 0 && sp.store);
    return {
      name: r.name || '', brand: r.brand || '', size: r.size || '',
      image: r.image || '', barcode: r.barcode || '',
      stores
    };
  }).filter(r => r.name.length > 0);

  // De-duplicate by name
  const seen = new Set(), deduped = [];
  normalized.forEach(r => {
    const key = r.name.trim().toLowerCase().substring(0, 40);
    if (!seen.has(key)) { seen.add(key); deduped.push(r); }
    else {
      const ex = deduped.find(g => g.name.trim().toLowerCase().substring(0, 40) === key);
      if (ex) ex.stores.push(...r.stores);
    }
  });
  return deduped;
}

// Score threshold for relevance filtering.
// Applied adaptively: if any product meets the threshold, only threshold-passing
// products are shown. If none meet it (niche query), top-N are shown with a
// "תוצאות פחות מדויקות" banner instead of a false "no results" message.
const _SCORE_THRESHOLD = 40;
const _SCORE_FALLBACK_N = 5; // max products to show in low-relevance fallback mode

// Set by _buildChainGroups, read by renderSearchResults to show the banner.
let _lastSearchLowRelevance = false;

function _buildChainGroups(deduped, query) {
  const _debug = window.__debug_prices === true;

  // Score all products first so we can make an adaptive threshold decision.
  const scored = deduped.map(product => ({
    product,
    score: matchScore(product.name, query),
  }));

  const bestScore = scored.length ? Math.max(...scored.map(s => s.score)) : 0;
  const useThreshold = bestScore >= _SCORE_THRESHOLD;

  // Relative threshold: when strong matches exist, raise the bar so that
  // weak word-anywhere matches (e.g. "שוקולד חלב" for query "חלב") are filtered
  // while all legitimate variants still pass (e.g. "חלב שקדים", "חלב עמיד").
  const threshold = bestScore >= 90 ? bestScore - 15
                  : bestScore >= 80 ? bestScore - 20
                  : _SCORE_THRESHOLD;

  _lastSearchLowRelevance = !useThreshold && scored.length > 0;

  if (_debug) {
    console.log(`[prices] query="${query}" bestScore=${bestScore} threshold=${threshold} mode=${useThreshold ? 'strict' : 'fallback(top-'+_SCORE_FALLBACK_N+')'}`);
    scored.forEach(({ product, score }) =>
      console.log(`[prices]   ${score >= threshold ? 'kept    ' : 'low-rel '} (${score}): "${product.name}"`)
    );
  }

  // In fallback mode, show top-N by score; in strict mode, apply relative threshold.
  const eligible = useThreshold
    ? scored.filter(s => s.score >= threshold)
    : scored.sort((a, b) => b.score - a.score).slice(0, _SCORE_FALLBACK_N);

  const map = new Map();
  const noPrice = [];
  eligible.forEach(({ product, score }) => {
    if (!product.stores || product.stores.length === 0) {
      noPrice.push({ product, score, chainPrice: null, unit: null });
      return;
    }
    product.stores.forEach(sp => {
      const chain = sp.store;
      if (!map.has(chain)) map.set(chain, { name: chain, products: [] });
      const existing = map.get(chain).products.find(
        p => p.product.name.trim().toLowerCase() === product.name.trim().toLowerCase()
      );
      if (!existing) {
        map.get(chain).products.push({ product, score, chainPrice: sp.price, unit: sp.unit });
      } else if (sp.price < existing.chainPrice) {
        existing.chainPrice = sp.price;
        existing.unit = sp.unit;
      }
    });
  });
  map.forEach(g => g.products.sort((a, b) => b.score - a.score || a.chainPrice - b.chainPrice));
  const groups = [...map.entries()]
    .sort((a, b) => b[1].products.length - a[1].products.length)
    .map(([, g]) => g);
  if (noPrice.length) {
    noPrice.sort((a, b) => b.score - a.score);
    groups.push({ name: '__no_price__', products: noPrice });
  }
  return groups;
}

function _applyFilter(groups) {
  return groups.map(group => {
    if (group.name === '__no_price__') return group; // always pass through
    if (_filterState.chains.size > 0 && !_filterState.chains.has(group.name)) return null;
    let products = group.products;
    if (_filterState.matchQuality === 'good')  products = products.filter(p => p.score >= 60);
    if (_filterState.matchQuality === 'exact') products = products.filter(p => p.score >= 85);
    if (_filterState.officialOnly) products = products.filter(p => p.chainPrice > 0);
    return products.length ? { ...group, products } : null;
  }).filter(Boolean);
}

function renderSearchResults(results, query) {
  const deduped = _normalizeResults(results);
  _chainGroups = _buildChainGroups(deduped, query); // also sets _lastSearchLowRelevance
  _filterState = { chains: new Set(), officialOnly: false, matchQuality: 'all' };

  // Debug instrumentation — enable with: window.__debug_prices = true
  if (window.__debug_prices === true) {
    const allScores = deduped.map(p => ({ name: p.name, score: matchScore(p.name, query) }))
                              .sort((a, b) => b.score - a.score);
    const best = allScores[0]?.score ?? 0;
    const kept = allScores.filter(p => p.score >= _SCORE_THRESHOLD).length;
    console.groupCollapsed(`[prices] renderSearchResults — query="${query}" resolvedQuery="${query}" apiCount=${results.length} filteredCount=${kept} bestScore=${best}`);
    allScores.forEach(p => console.log(`  ${p.score >= _SCORE_THRESHOLD ? '✅' : '⬇️ '} score=${p.score} "${p.name}"`));
    console.groupEnd();
  }

  const filterRow = document.getElementById('sr-filter-row');
  if (filterRow) filterRow.style.display = '';
  const badge = document.getElementById('sr-filter-badge');
  if (badge) { badge.textContent = '0'; badge.classList.remove('show'); }
  const btn = document.getElementById('sr-filter-btn');
  if (btn) btn.classList.remove('active');

  _updateFdChains();
  _renderChainGroups();
}

function _renderChainGroups() {
  const wrap = document.getElementById('price-content');
  const filtered = _applyFilter(_chainGroups);
  const total = filtered.reduce((s, g) => s + g.products.length, 0);

  const countEl = document.getElementById('sr-count');
  if (countEl) countEl.textContent = total > 0 ? `${total} מוצרים` : '';

  if (!filtered.length) {
    // Distinguish: active user filters vs. score threshold removed all results
    const hasUserFilters = _filterState.chains.size > 0 || _filterState.officialOnly ||
                           _filterState.matchQuality !== 'all';
    wrap.innerHTML = `<div class="search-hint"><div class="sh-icon">🔍</div>
      <p>${hasUserFilters ? 'לא נמצאו תוצאות' : 'לא נמצאו מוצרים רלוונטיים'}</p>
      <small>${hasUserFilters ? 'נסה להסיר פילטרים' : 'נסה שם שונה או ביטוי קצר יותר'}</small></div>`;
    wrap._groups = null;
    return;
  }

  // Low-relevance fallback banner — shown when no product met the score threshold
  // and we're displaying best-available results instead of "no results".
  let html = _lastSearchLowRelevance
    ? `<div style="margin:8px 12px 4px;padding:8px 12px;border-radius:10px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);font-size:12px;color:#d97706;direction:rtl">
        ⚠️ תוצאות פחות מדויקות — נסה שם מוצר אחר</div>`
    : '';
  filtered.forEach(group => {
    // No-price group: products found by name but not yet in Firebase price DB
    if (group.name === '__no_price__') {
      html += `<div class="chain-group">
        <div class="chain-group-header" style="color:#9ca3af">
          <div class="chain-dot" style="background:#9ca3af"></div>
          <div class="chain-name">מוצרים נוספים</div>
          <div class="chain-count" style="font-size:11px;opacity:.7">מחיר עדיין לא זמין</div>
        </div>
        <div class="chain-row">`;
      group.products.forEach(({ product }) => {
        html += `<div class="pc2" style="opacity:.6;border-color:#9ca3af33;cursor:default">
          ${product.image
            ? `<img class="pc2-img" src="${esc(product.image)}" onerror="this.style.display='none'" loading="lazy">`
            : `<div class="pc2-img-ph">🛍</div>`}
          <div class="pc2-name">${esc(product.name)}</div>
          ${product.brand ? `<div class="pc2-brand">${esc(product.brand)}</div>` : ''}
          <div class="pc2-price" style="color:#9ca3af;font-size:12px">מחיר לא זמין</div>
        </div>`;
      });
      html += `</div></div>`;
      return;
    }

    const meta = CHAIN_META[group.name] || { color: '#7d8590', bg: '#161b22' };
    const prices = group.products.map(p => p.chainPrice).filter(Boolean);
    const minP = prices.length ? Math.min(...prices) : null;
    const maxP = prices.length ? Math.max(...prices) : null;

    html += `<div class="chain-group">
      <div class="chain-group-header" style="color:${meta.color}">
        <div class="chain-dot" style="background:${meta.color}"></div>
        <div class="chain-name">${esc(group.name)}</div>
        <div class="chain-count">${group.products.length} מוצרים</div>
        ${minP ? `<div class="chain-min-price">מ-₪${minP.toFixed(2)}</div>` : ''}
      </div>
      <div class="chain-row">`;

    group.products.forEach((item, i) => {
      const { product, chainPrice, unit } = item;
      const isBest  = chainPrice && prices.length > 1 && chainPrice === minP;
      const isWorst = chainPrice && prices.length > 1 && chainPrice === maxP && maxP !== minP;
      const safeChain = esc(group.name).replace(/'/g, "\\'");

      html += `<div class="pc2" onclick="openProductModal('${safeChain}',${i})"
          style="border-color:${meta.color}33">
        ${isBest  ? `<div class="pc2-badge">🏆 זול</div>` : ''}
        ${isWorst ? `<div class="pc2-badge worst">יקר</div>` : ''}
        ${product.image
          ? `<img class="pc2-img" src="${esc(product.image)}" onerror="this.style.display='none'" loading="lazy">`
          : `<div class="pc2-img-ph">🛍</div>`}
        <div class="pc2-name">${esc(product.name)}</div>
        ${product.brand ? `<div class="pc2-brand">${esc(product.brand)}</div>` : ''}
        <div class="pc2-price">${chainPrice ? `₪${chainPrice.toFixed(2)}` : '—'}</div>
        ${unit ? `<div class="pc2-unit">${esc(unit)}</div>` : ''}
      </div>`;
    });

    html += `</div></div>`;
  });

  wrap.innerHTML = html;
  wrap._groups = null; // chain mode — legacy _groups not used
}

// ── FILTER DRAWER ─────────────────────────────────────────────────────

function _updateFdChains() {
  const container = document.getElementById('fd-chains');
  if (!container) return;
  container.innerHTML = _chainGroups
    .filter(g => g.name !== '__no_price__')
    .map(g => {
      const meta = CHAIN_META[g.name] || { color: '#7d8590' };
      const safe = esc(g.name).replace(/'/g, "\\'");
      return `<button class="fd-chip" data-chain="${esc(g.name)}"
        onclick="fdToggleChain(this,'${safe}')">${esc(g.name)}</button>`;
    }).join('');
}

function _syncFdUI() {
  document.querySelectorAll('#fd-chains .fd-chip').forEach(btn => {
    btn.classList.toggle('on',
      _filterState.chains.size === 0 || _filterState.chains.has(btn.dataset.chain));
  });
  document.querySelectorAll('#fd-quality .fd-chip').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.q === _filterState.matchQuality);
  });
  const offEl = document.getElementById('fd-official-only');
  if (offEl) offEl.checked = _filterState.officialOnly;
}

window.openFilterDrawer = function() {
  _syncFdUI();
  document.getElementById('fd-overlay').classList.add('show');
  document.getElementById('fd-drawer').classList.add('show');
  document.body.classList.add('sheet-open');
};
window.closeFilterDrawer = function() {
  document.getElementById('fd-overlay').classList.remove('show');
  document.getElementById('fd-drawer').classList.remove('show');
  document.body.classList.remove('sheet-open');
};
window.fdToggleChain = function(btn, chain) {
  if (_filterState.chains.has(chain)) {
    _filterState.chains.delete(chain);
  } else {
    _filterState.chains.add(chain);
  }
  if (_filterState.chains.size === _chainGroups.length) _filterState.chains.clear();
  _syncFdUI();
};
window.fdQuality = function(btn) {
  _filterState.matchQuality = btn.dataset.q;
  _syncFdUI();
};
window.clearFilters = function() {
  _filterState = { chains: new Set(), officialOnly: false, matchQuality: 'all' };
  _syncFdUI();
};
window.applyFilters = function() {
  const offEl = document.getElementById('fd-official-only');
  if (offEl) _filterState.officialOnly = offEl.checked;

  let count = 0;
  if (_filterState.chains.size > 0) count++;
  if (_filterState.officialOnly) count++;
  if (_filterState.matchQuality !== 'all') count++;

  const badge = document.getElementById('sr-filter-badge');
  if (badge) { badge.textContent = count; badge.classList.toggle('show', count > 0); }
  const fbtn = document.getElementById('sr-filter-btn');
  if (fbtn) fbtn.classList.toggle('active', count > 0);

  closeFilterDrawer();
  _renderChainGroups();
};

// ── PRODUCT MODAL ─────────────────────────────────────────────────────

let _pmChainName = '', _pmProducts = [], _pmIndex = 0;
let _pmSwipeStartX = 0, _pmSwipeStartY = 0;

window.openProductModal = function(chainName, productIndex) {
  const filtered = _applyFilter(_chainGroups);
  const group = filtered.find(g => g.name === chainName);
  if (!group) return;
  _pmChainName = chainName;
  _pmProducts  = group.products;
  _pmIndex     = productIndex;

  const overlay = document.getElementById('pm-overlay');
  const sheet   = document.getElementById('pm-sheet');
  overlay.classList.add('show');
  document.body.classList.add('sheet-open');
  sheet.scrollTop = 0;
  _pmEnrichAndRender();

  sheet.addEventListener('touchstart', _pmTouchStart, { passive: true });
  sheet.addEventListener('touchend',   _pmTouchEnd,   { passive: true });
};

window.closeProductModal = function() {
  const overlay = document.getElementById('pm-overlay');
  const sheet   = document.getElementById('pm-sheet');
  overlay.classList.remove('show');
  document.body.classList.remove('sheet-open');
  sheet.removeEventListener('touchstart', _pmTouchStart);
  sheet.removeEventListener('touchend',   _pmTouchEnd);
};

const _PM_PAGE_SIZE      = 10;
const _pmVisibleStores   = new Map(); // keyed by barcode+':'+viewMode; module-scoped, no window pollution
const _productDetailCache = new Map(); // barcode → enriched prices array; avoids repeat modal fetches

// Merge enriched store fields (address/city/storeName/lat/lng) into existing product.stores in-place.
// Only fills missing fields — never overwrites data the lightweight result already provided.
function _mergeEnrichedStores(product, enrichedPrices) {
  for (const e of enrichedPrices) {
    const key = `${e.chainId || ''}_${e.storeId || ''}`;
    const s   = product.stores.find(s => `${s.chainId || ''}_${s.storeId || ''}` === key);
    if (!s) continue;
    if (!s.address   && e.address)   s.address   = e.address;
    if (!s.city      && e.city)      s.city      = e.city;
    if (!s.storeName && e.storeName) s.storeName = e.storeName;
    if (s.latitude  == null && e.latitude  != null) s.latitude  = e.latitude;
    if (s.longitude == null && e.longitude != null) s.longitude = e.longitude;
  }
}

// Render the modal immediately (lightweight), then fetch enriched store data and silently re-render.
// Skipped when: no barcode (can't do barcode lookup), or cache already populated.
async function _pmEnrichAndRender() {
  _renderProductModal();
  const item    = _pmProducts[_pmIndex];
  if (!item) return;
  const barcode = item.product.barcode;
  if (!barcode) return;                              // no barcode → can't enrich, show as-is
  if (_productDetailCache.has(barcode)) {
    _mergeEnrichedStores(item.product, _productDetailCache.get(barcode));
    _renderProductModal();
    return;
  }
  try {
    const res = await fetch(`/api/prices?barcode=${encodeURIComponent(barcode)}&detail=1`);
    if (!res.ok) return;
    const data = await res.json();
    const prices = Array.isArray(data.prices) ? data.prices : [];
    _productDetailCache.set(barcode, prices);
    _mergeEnrichedStores(item.product, prices);
    _renderProductModal();
  } catch { /* enrichment is best-effort; plain price data already visible */ }
}

window._pmShowMore = function(key) {
  _pmVisibleStores.set(key, (_pmVisibleStores.get(key) || _PM_PAGE_SIZE) + _PM_PAGE_SIZE);
  window._pmRenderStoreList?.();
};

window._pmToggleStore = function(row) {
  const detail = row.querySelector('.sr2-detail');
  if (!detail) return;
  const isOpen = detail.style.display !== 'none';
  // Collapse all other rows first
  row.closest('.store-prices')?.querySelectorAll('.sr2-detail').forEach(d => {
    d.style.display = 'none';
    d.closest('.sr2')?.classList.remove('sr2-open');
  });
  if (!isOpen) {
    detail.style.display = 'block';
    row.classList.add('sr2-open');
  }
};

function _pmTouchStart(e) {
  _pmSwipeStartX = e.changedTouches[0].clientX;
  _pmSwipeStartY = e.changedTouches[0].clientY;
}
function _pmTouchEnd(e) {
  const dx = e.changedTouches[0].clientX - _pmSwipeStartX;
  const dy = e.changedTouches[0].clientY - _pmSwipeStartY;
  if (Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 45) return;
  // RTL: swipe right → previous (higher index in visual RTL), swipe left → next
  if (dx < -45 && _pmIndex < _pmProducts.length - 1) { _pmIndex++; _pmEnrichAndRender(); }
  else if (dx > 45 && _pmIndex > 0)                   { _pmIndex--; _pmEnrichAndRender(); }
}

function _renderProductModal() {
  const posEl = document.getElementById('pm-pos');
  if (posEl) posEl.textContent = _pmProducts.length > 1
    ? `${_pmIndex + 1} / ${_pmProducts.length}` : '';

  const item = _pmProducts[_pmIndex];
  if (!item) return;
  const { product } = item;

  // Flat per-store list sorted: price asc, then distance asc as tiebreaker
  const allPrices = product.stores
    .filter(s => s.price > 0)
    .sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      const da = a.distanceKm ?? Infinity;
      const db = b.distanceKm ?? Infinity;
      return da - db;
    });
  const minPrice = allPrices.length ? allPrices[0].price : null;
  const maxPrice = allPrices.length ? allPrices[allPrices.length - 1].price : null;

  // Savings header — only when spread exists
  const modalSpread = (allPrices.length > 1 && maxPrice > minPrice)
    ? `<div class="pm-spread">
         <span class="pm-spread-min">₪${minPrice.toFixed(2)}</span>
         <span class="pm-spread-arrow">→</span>
         <span class="pm-spread-max">₪${maxPrice.toFixed(2)}</span>
         <span class="pm-spread-save">חיסכון <strong>₪${(maxPrice - minPrice).toFixed(2)}</strong></span>
       </div>`
    : '';

  const storeRows = allPrices.length
    ? allPrices.map((s, idx) => {
        const isBest  = s.price === minPrice;
        const meta    = CHAIN_META[s.store] || { color: '#7d8590' };
        // Store display name: sub-brand if distinct, else chain name
        const brandLabel = (s.storeName && s.storeName !== s.store)
          ? s.storeName : s.store;
        const addrLine  = s.address || '';
        const cityLine  = s.city    || '';
        const location  = [addrLine, cityLine].filter(Boolean).join(', ');
        const distLine  = s.distanceKm != null ? `${s.distanceKm} ק"מ` : null;
        // Google Maps navigation query: prefer lat/lng for accuracy, fall back to text
        const mapsQuery = (s.latitude && s.longitude)
          ? `${s.latitude},${s.longitude}`
          : encodeURIComponent([brandLabel, addrLine, cityLine].filter(Boolean).join(' '));
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;
        const hasNav  = !!(s.latitude && s.longitude) || !!(addrLine || cityLine);
        // Age of price data
        const ageHours = s.syncedAt
          ? Math.round((Date.now() - new Date(s.syncedAt).getTime()) / 3_600_000) : null;
        const ageTxt   = ageHours != null
          ? (ageHours < 24 ? `לפני ${ageHours} שעות` : `לפני ${Math.round(ageHours/24)} ימים`) : null;

        return `<div class="sr2${isBest ? ' sr2-best' : ''}" data-idx="${idx}"
                     onclick="_pmToggleStore(this)">
          <div class="sr2-left">
            <div class="sr2-dot" style="background:${meta.color}"></div>
          </div>
          <div class="sr2-body">
            <div class="sr2-top">
              <span class="sr2-chain" style="color:${meta.color}">${esc(s.store)}</span>
              ${s.storeName && s.storeName !== s.store
                ? `<span class="sr2-sub">${esc(s.storeName)}</span>` : ''}
              ${isBest ? `<span class="sr2-badge">הכי זול 🏆</span>` : ''}
              ${s.isStale ? `<span class="sr2-stale">⚠ ישן</span>` : ''}
            </div>
            <div class="sr2-meta">
              ${location ? `<span class="sr2-addr">${esc(location)}</span>` : ''}
              ${distLine
                ? `<span class="sr2-dist">📍 ${distLine}</span>`
                : ''}
            </div>
            <div class="sr2-detail" style="display:none">
              ${ageTxt ? `<div class="sr2-age">עודכן ${ageTxt}</div>` : ''}
              ${s.approximateLocation ? `<div class="sr2-approx">📍 מיקום משוער</div>` : ''}
              ${hasNav
                ? `<a class="sr2-nav" href="${mapsUrl}" target="_blank" rel="noopener"
                      onclick="event.stopPropagation()">🗺 נווט</a>`
                : ''}
            </div>
          </div>
          <div class="sr2-price">
            <span class="sr2-amt">₪${s.price.toFixed(2)}</span>
            ${s.unit ? `<span class="sr2-unit">${esc(s.unit)}</span>` : ''}
          </div>
        </div>`;
      }).join('')
    : `<div class="spr no-data" style="justify-content:center;font-size:12px">אין מחירים רשמיים</div>`;

  // Pagination state per barcode — preserved across swipe-navigation between products
  const barcode = product.barcode || product.name; // fallback key for products without barcode
  const pmKey   = barcode + ':' + 'list';
  if (!_pmVisibleStores.has(pmKey)) {
    _pmVisibleStores.set(pmKey, _PM_PAGE_SIZE);
  }

  const _renderStoreList = () => {
    const vis   = _pmVisibleStores.get(pmKey);
    const shown = allPrices.slice(0, vis);
    const total = allPrices.length;
    const el    = document.getElementById('pm-store-list');
    if (!el) return;
    el.innerHTML = shown.map((s, idx) => {
      const isBest     = s.price === minPrice;
      const meta       = CHAIN_META[s.store] || { color: '#7d8590' };
      const location   = [s.address, s.city].filter(Boolean).join(', ');
      const distLine   = s.distanceKm != null ? `${s.distanceKm} ק"מ` : null;
      const _lat = Number(s.latitude); const _lng = Number(s.longitude);
      const hasCoords  = Number.isFinite(_lat) && Number.isFinite(_lng);
      const mapsQuery  = hasCoords
        ? `${_lat},${_lng}`
        : encodeURIComponent([(s.storeName || s.store), s.address, s.city].filter(Boolean).join(' '));
      const mapsUrl    = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;
      const hasNav     = hasCoords || !!(s.address || s.city);
      const ageHours   = s.syncedAt
        ? Math.round((Date.now() - new Date(s.syncedAt).getTime()) / 3_600_000) : null;
      const ageTxt     = ageHours != null
        ? (ageHours < 24 ? `לפני ${ageHours} שעות` : `לפני ${Math.round(ageHours / 24)} ימים`) : null;

      return `<div class="sr2${isBest ? ' sr2-best' : ''}" data-idx="${idx}"
                   onclick="_pmToggleStore(this)">
        <div class="sr2-left">
          <div class="sr2-dot" style="background:${meta.color}"></div>
        </div>
        <div class="sr2-body">
          <div class="sr2-top">
            <span class="sr2-chain" style="color:${meta.color}">${esc(s.store)}</span>
            ${s.storeName && s.storeName !== s.store
              ? `<span class="sr2-sub">${esc(s.storeName)}</span>` : ''}
            ${isBest ? `<span class="sr2-badge">הכי זול 🏆</span>` : ''}
            ${s.isStale ? `<span class="sr2-stale">⚠ ישן</span>` : ''}
          </div>
          ${location || distLine ? `<div class="sr2-meta">
            ${location  ? `<span class="sr2-addr">${esc(location)}</span>` : ''}
            ${distLine  ? `<span class="sr2-dist">📍 ${distLine}</span>` : ''}
          </div>` : ''}
          <div class="sr2-detail" style="display:none">
            ${ageTxt ? `<div class="sr2-age">עודכן ${ageTxt}</div>` : ''}
            ${s.approximateLocation ? `<div class="sr2-approx">📍 מיקום משוער</div>` : ''}
            ${hasNav
              ? `<a class="sr2-nav" href="${mapsUrl}" target="_blank" rel="noopener"
                    onclick="event.stopPropagation()">🗺 נווט</a>`
              : ''}
          </div>
        </div>
        <div class="sr2-price">
          <span class="sr2-amt">₪${s.price.toFixed(2)}</span>
          ${s.unit ? `<span class="sr2-unit">${esc(s.unit)}</span>` : ''}
        </div>
      </div>`;
    }).join('');

    // Counter + show-more button
    const footer = document.getElementById('pm-store-footer');
    if (!footer) return;
    if (total <= _PM_PAGE_SIZE && vis >= total) {
      footer.innerHTML = '';
    } else if (vis >= total) {
      footer.innerHTML = `<div class="pm-store-counter">כל ${total} החנויות מוצגות</div>`;
    } else {
      const remaining = Math.min(_PM_PAGE_SIZE, total - vis);
      footer.innerHTML = `
        <div class="pm-store-counter">מציג ${vis} מתוך ${total} חנויות</div>
        <button class="pm-show-more" onclick="_pmShowMore(${JSON.stringify(pmKey)})">
          הצג עוד ${remaining} חנויות
        </button>`;
    }
  };

  document.getElementById('pm-body').innerHTML = `
    <div class="pm-img-row">
      ${product.image
        ? `<img class="pm-img" src="${esc(product.image)}" onerror="this.style.display='none'" loading="lazy">`
        : `<div class="pm-img-ph">🛍</div>`}
    </div>
    <div class="pm-name">${esc(product.name)}</div>
    <div class="pm-sub">${[product.brand, product.size].filter(Boolean).map(esc).join(' · ')}</div>
    ${modalSpread}
    <div class="pm-sec-label">מחירים לפי סניף</div>
    <div id="pm-store-list" class="store-prices"></div>
    <div id="pm-store-footer" class="pm-store-footer"></div>
    <button class="pm-add-btn" onclick="_pmAddToList()">➕ הוסף לרשימה</button>
    <button class="pm-detail-btn" onclick="_pmShowDetail()">השוואה מפורטת ←</button>
    ${_pmProducts.length > 1 ? `<div class="pm-swipe-hint">← החלק לניווט בין מוצרים →</div>` : ''}
  `;

  _renderStoreList();
  // Expose re-render for show-more button
  window._pmRenderStoreList = _renderStoreList;
}

window._pmAddToList = function() {
  const item = _pmProducts[_pmIndex];
  if (!item) return;
  const name = item.product.name;
  if (!groupId) { toast('💡 בחר קבוצה תחילה'); return; }

  // Duplicate detection — same as addItem: increment qty instead of new row
  const existing = findExistingListItem(name, item.product.barcode || null);
  if (existing) {
    const newQty = (existing.qty || 1) + 1;
    update(ref(db, `groups/${groupId}/items/${existing.id}`), { qty: newQty });
    toast(`➕ ${esc(name)} × ${newQty}`);
    closeProductModal();
    return;
  }

  const m = myProfile || {};
  const newRef = push(ref(db, `groups/${groupId}/items`));
  set(newRef, {
    name, qty: 1, bought: false, fav: false,
    barcode: item.product.barcode || null,
    addedByUserId:      myId,
    addedByDisplayName: myName,
    addedByAvatarType:  m.avatarType  || 'emoji',
    addedByAvatarValue: m.avatarValue || '👤',
    addedByAvatarEmoji: m.avatarEmoji || null,
    addedAt: Date.now(), ts: Date.now(),
  });
  if (typeof logActivity === 'function') logActivity('item_added', newRef.key, name);
  toast(`✅ ${esc(name)} נוסף לרשימה`);
  closeProductModal();
};

window._pmShowDetail = function() {
  const item = _pmProducts[_pmIndex];
  if (!item) return;
  selectedProduct = item.product;
  _currentScanProduct = selectedProduct;
  closeProductModal();
  window.showProductPricesEnhanced(selectedProduct);
};


function showProductPrices(product){
  const wrap = document.getElementById('price-content');
  const STORE_LIST = ['שופרסל','רמי לוי','ויקטורי','יינות ביתן','מחסני להב','אושר עד'];
  const relevant = STORE_LIST.filter(s => activeStores.has(s));

  const storesHTML = STORE_LIST.map(s=>
    `<button class="store-chip${activeStores.has(s)?' on':''}" onclick="toggleStore('${s}')">${s}</button>`
  ).join('');

  // Build price map
  const priceMap = {};
  product.stores.forEach(s => { priceMap[s.store] = s.price; });

  const relevantPrices = relevant.map(s => ({store:s, price:priceMap[s]||null}));
  const withPrice = relevantPrices.filter(r=>r.price!==null);
  const minPrice = withPrice.length ? Math.min(...withPrice.map(r=>r.price)) : null;
  const maxPrice = withPrice.length ? Math.max(...withPrice.map(r=>r.price)) : null;
  const savings = (minPrice && maxPrice && maxPrice>minPrice) ? (maxPrice-minPrice).toFixed(2) : null;

  const pricesHTML = relevantPrices.map(r => {
    const isBest = r.price!==null && r.price===minPrice && withPrice.length>1;
    const isWorst = r.price!==null && r.price===maxPrice && withPrice.length>1 && r.price!==minPrice;
    const storeKey = r.store.replace(/\s/g,'_');
    if (r.price !== null) {
      return `<div class="spr${isBest?' best':''}">
        <span class="spr-name">${r.store}</span>
        <span style="display:flex;align-items:center;gap:5px">
          ${isBest?'<span class="best-badge">הכי זול 🏆</span>':''}
          ${isWorst?'<span style="font-size:9px;background:rgba(248,113,113,.15);color:var(--red);border-radius:4px;padding:1px 5px;font-weight:700">הכי יקר</span>':''}
          <span class="spr-price">₪${r.price.toFixed(2)}</span>
        </span>
      </div>`;
    } else {
      return `<div class="spr no-data" style="gap:8px">
        <span class="spr-name" style="flex-shrink:0">${r.store}</span>
        <span style="display:flex;align-items:center;gap:5px;flex:1;justify-content:flex-end;direction:ltr">
          <span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">₪</span>
          <input type="number" id="mp-${storeKey}" placeholder="0.00"
            step="0.01" min="0"
            style="width:80px;background:var(--card);border:1px solid var(--border);
              border-radius:8px;padding:4px 8px;color:var(--text);font-family:'Rubik',sans-serif;
              font-size:12px;text-align:left;outline:none;direction:ltr">
          <button onclick="saveManualPrice('${r.store}','mp-${storeKey}')"
            style="background:var(--accent);color:#fff;border:none;border-radius:7px;
              padding:4px 10px;font-family:'Rubik',sans-serif;font-size:11px;font-weight:700;cursor:pointer;">
            שמור
          </button>
        </span>
      </div>`;
    }
  }).join('');

  let html = `
  <button onclick="backToResults()" style="background:transparent;border:none;color:var(--muted);font-family:'Rubik',sans-serif;font-size:13px;font-weight:600;cursor:pointer;padding:4px 0 8px;display:flex;align-items:center;gap:4px;">
    ← חזרה לתוצאות
  </button>

  <div class="compare-card">
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
      ${product.image
        ? `<img class="product-img" src="${product.image}" onerror="this.style.display='none'" loading="lazy">`
        : `<div class="product-img-placeholder">🛍</div>`}
      <div>
        <div style="font-size:14px;font-weight:700">${esc(product.name)}</div>
        ${product.brand?`<div style="font-size:11px;color:var(--muted)">${esc(product.brand)}</div>`:''}
        ${product.size?`<div style="font-size:11px;color:var(--muted)">${esc(product.size)}</div>`:''}
      </div>
    </div>

    <div class="price-ctrl" style="margin-bottom:10px">
      <div class="price-ctrl-title">⚙️ חנויות להשוואה</div>
      <div class="radius-row">
        <label>רדיוס</label>
        <input type="range" min="1" max="50" value="${priceRadius}" oninput="setRadius(this.value)">
        <span class="radius-val" id="radius-val">${priceRadius} ק"מ</span>
      </div>
      <div class="stores-row">${storesHTML}</div>
    </div>

    <div class="store-prices">${pricesHTML}</div>

    ${savings ? `<div class="savings-bar">💰 חיסכון פוטנציאלי: ₪${savings} בקנייה בחנות הזולה</div>` : ''}
  </div>

  <div style="padding:8px 0 4px;font-size:11px;color:var(--muted);text-align:center">
    מחירים בזמן אמת מהאתרים הרשמיים • עודכן כעת
  </div>`;

  wrap.innerHTML = html;
  wrap._groups = null; // cleared, use backToResults to restore
}

window.backToResults = function(){
  if (_chainGroups.length > 0) {
    // Restore chain-grouped view without re-fetching
    const filterRow = document.getElementById('sr-filter-row');
    if (filterRow) filterRow.style.display = '';
    _renderChainGroups();
  } else if (lastSearchQuery) {
    searchPrices();
  }
};

window.saveManualPrice = function(storeName, inputId) {
  const val = parseFloat(document.getElementById(inputId)?.value);
  if (!val || val <= 0) { toast('⚠️ הכנס מחיר תקין'); return; }
  if (!selectedProduct) return;
  // Add to product stores
  const existing = selectedProduct.stores.find(s => s.store === storeName);
  if (existing) existing.price = val;
  else selectedProduct.stores.push({ store: storeName, price: val, unit: '' });
  showProductPrices(selectedProduct);
  toast('💰 מחיר נשמר!');
};

function renderManualFallback(query, product){
  const STORE_LIST = ['שופרסל','רמי לוי','ויקטורי','יינות ביתן','מחסני להב','אושר עד'];
  const storeInputs = STORE_LIST.map(s=>`
    <div class="spr">
      <span class="spr-name">${s}</span>
      <div style="display:flex;align-items:center;gap:4px;direction:ltr">
        <span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">₪</span>
        <input class="pi" type="number" id="manual-${s.replace(/\s/g,'_')}"
          placeholder="0.00" step="0.01" min="0"
          style="width:80px;text-align:left;padding-right:4px">
      </div>
    </div>`).join('');

  // Product header with image
  const imgHTML = (product?.image)
    ? `<img class="product-img" src="${product.image}" onerror="this.style.display='none'" loading="lazy">`
    : `<div class="product-img-placeholder">🛍</div>`;

  const name    = product?.name  || query;
  const brand   = product?.brand || '';
  const size    = product?.size  || '';
  const barcode = product?.barcode || '';

  return `<div class="compare-card">
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
      ${imgHTML}
      <div>
        <div style="font-size:14px;font-weight:700">${esc(name)}</div>
        ${brand ? `<div style="font-size:11px;color:var(--muted)">${esc(brand)}</div>` : ''}
        ${size  ? `<div style="font-size:11px;color:var(--muted)">${esc(size)}</div>`  : ''}
        ${barcode ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">ברקוד: ${esc(barcode)}</div>` : ''}
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:10px;background:var(--card2);
      border-radius:8px;padding:8px;text-align:center">
      📝 לא נמצאו מחירים רשמיים — הכנס ידנית:
    </div>
    <div class="store-prices">${storeInputs}</div>
    <button onclick="saveManualPrices('${query.replace(/'/g,"\'")}')" 
      style="margin-top:10px;width:100%;background:var(--accent);color:#fff;border:none;
        border-radius:10px;padding:10px;font-family:'Rubik',sans-serif;font-size:14px;font-weight:700;cursor:pointer;">
      💾 שמור מחירים
    </button>
  </div>`;
}

window.saveManualPrices = function(query){
  toast('💰 מחירים נשמרו!');
};

function renderPrices(){
  if(curTab!=='price') return;
  renderQuickItems();
  const wrap = document.getElementById('price-content');
  if(!lastSearchQuery){
    const pending = Object.values(items).filter(i=>!i.bought);
    wrap.innerHTML = `<div class="search-hint">
      <div class="sh-icon">🔍</div>
      <p>חפש מוצר להשוואת מחירים</p>
      <small>המחירים נטענים מאתרי הסופרמרקטים בזמן אמת</small>
    </div>`;
  }
}

window.openMembers=function(){
  document.getElementById('modal-code').textContent=groupId;
  document.getElementById('members-list').innerHTML=dedupMembers(Object.values(members)).map(m=>`
    <div class="member-row">
      <div class="member-av">${m.name.charAt(0)}</div>
      <div><div class="member-name">${esc(m.name)}</div>
        <div class="member-sub">${m.id===myId?'👤 זה אתה':'חבר קבוצה'}</div></div>
    </div>`).join('');
  document.getElementById('members-overlay').classList.add('show');
};

window.copyCode = function() {
  const inviteUrl  = `${location.origin}/?join=${groupId}`;
  const shareTitle = `הצטרף לקבוצה "${groupName}" 🛒`;
  const shareText  = 'לחץ על הקישור כדי להצטרף לרשימת הקניות המשותפת';

  if (navigator.share) {
    navigator.share({ title: shareTitle, text: shareText, url: inviteUrl })
      .catch(err => {
        // AbortError = user dismissed the native share sheet — no action needed
        if (err.name !== 'AbortError') {
          navigator.clipboard.writeText(inviteUrl)
            .then(() => toast('🔗 קישור הועתק!'))
            .catch(() => _copyFallback(inviteUrl));
        }
      });
  } else {
    navigator.clipboard.writeText(inviteUrl)
      .then(() => toast('🔗 קישור הוזמנה הועתק!'))
      .catch(() => _copyFallback(inviteUrl));
  }
};

function _copyFallback(text) {
  const el = document.createElement('input');
  el.value = text;
  el.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(el);
  el.select();
  try { document.execCommand('copy'); toast('🔗 קישור הוזמנה הועתק!'); }
  catch (_) { toast('העתק ידנית: ' + text); }
  document.body.removeChild(el);
}

// Detect ?join=XXXXXX in the URL at page load and store for later use.
// Must run before onAuthStateChanged so the code is ready when the app decides which screen to show.
(function _handleInviteParam() {
  try {
    const code = new URLSearchParams(location.search).get('join');
    if (code && /^\d{6}$/.test(code)) {
      window._pendingInviteCode = code;
      history.replaceState({}, '', location.pathname); // clean URL, no page reload
    }
  } catch (_) {}
})();

window.openShare=function(){
  const pending=Object.values(items).filter(i=>!i.bought);
  const bought=Object.values(items).filter(i=>i.bought);
  let text=`🛒 רשימת קניות — ${groupName}\n${'─'.repeat(22)}\n\n`;
  if(pending.length){text+='📋 לקנות:\n';pending.forEach(i=>{text+=`${i.fav?'⭐ ':'• '}${i.name}  ×${i.qty||1}\n`});}
  if(bought.length){text+='\n✅ כבר קניתי:\n';bought.forEach(i=>{text+=`✓ ${i.name}  ×${i.qty||1}\n`});}
  if(!Object.keys(items).length)text+='(הרשימה ריקה)';
  document.getElementById('share-box').textContent=text;
  document.getElementById('share-overlay').classList.add('show');
};

window.doShare=function(){
  const text=document.getElementById('share-box').textContent;
  if(navigator.share){navigator.share({title:'רשימת קניות',text});closeOL2('share-overlay');return;}
  navigator.clipboard.writeText(text).then(()=>{closeOL2('share-overlay');toast('📋 הועתק!')});
};

window.closeOL=function(e,id){if(e.target===document.getElementById(id))closeOL2(id)};
window.closeOL2=function(id){document.getElementById(id).classList.remove('show')};

window.toast=function(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  clearTimeout(window._toastT);
  window._toastT=setTimeout(()=>t.classList.remove('show'),2200);
};


// ══════════════════════════════════════════════════
// PROFILE & AVATAR SYSTEM
// ══════════════════════════════════════════════════

const EMOJIS = ['🛒','🍎','🥛','🧀','🥚','🍞','☕','🍋','🍇','🥕',
  '🧅','🥦','🐔','🐟','🦁','🐯','🐻','🦊','🐼','🐸',
  '😀','😎','🤩','🥳','🎉','⭐','🌟','💪','🏃','👨‍👩‍👧'];

const CARTOONS = [
  {id:'c01',e:'👨'},  {id:'c02',e:'👩'},  {id:'c03',e:'👴'},  {id:'c04',e:'👵'},
  {id:'c05',e:'👦'},  {id:'c06',e:'👧'},  {id:'c07',e:'🧑'},  {id:'c08',e:'👱'},
  {id:'c09',e:'🧔'},  {id:'c10',e:'👲'},  {id:'c11',e:'🧕'},  {id:'c12',e:'👮'},
  {id:'c13',e:'🕵️'}, {id:'c14',e:'👩‍🍳'},{id:'c15',e:'🧑‍🚀'},{id:'c16',e:'🧑‍🎨'},
];

let _profileAvatar = { type: 'emoji', value: '🛒' };

function renderProfileSetup() {
  // Emoji grid
  const eg = document.getElementById('emoji-grid');
  if (eg) eg.innerHTML = EMOJIS.map(e =>
    `<button class="emoji-btn" onclick="pickEmoji('${e}')">${e}</button>`).join('');
  // Cartoon grid
  const cg = document.getElementById('cartoon-grid');
  if (cg) cg.innerHTML = CARTOONS.map(c =>
    `<button class="cartoon-btn" onclick="pickCartoon('${c.id}','${c.e}')">${c.e}</button>`).join('');
}

window.showAvatarPanel = function(type) {
  document.getElementById('emoji-panel').style.display   = type==='emoji'   ? 'block' : 'none';
  document.getElementById('cartoon-panel').style.display = type==='cartoon' ? 'block' : 'none';
};

window.pickEmoji = function(emoji) {
  _profileAvatar = { type: 'emoji', value: emoji };
  updateProfilePreview();
  document.querySelectorAll('.emoji-btn').forEach(b => b.classList.toggle('sel', b.textContent===emoji));
};

window.pickCartoon = function(id, emoji) {
  _profileAvatar = { type: 'cartoon', value: id, emoji };
  updateProfilePreview();
  document.querySelectorAll('.cartoon-btn').forEach(b => b.classList.toggle('sel', b.textContent===emoji));
};

window.triggerPhotoUpload = function(source) {
  document.getElementById(source==='camera' ? 'camera-input' : 'gallery-input').click();
};

window.handlePhotoUpload = async function(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5*1024*1024) { toast('⚠️ תמונה גדולה מדי (מקס 5MB)'); return; }
  // Compress to canvas
  const url = await compressImage(file, 200);
  _profileAvatar = { type: 'photo', value: url, isLocalBlob: true, file };
  updateProfilePreview();
};

async function compressImage(file, maxPx) {
  return new Promise(resolve => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e => {
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ratio = Math.min(maxPx/img.width, maxPx/img.height, 1);
        canvas.width = img.width * ratio; canvas.height = img.height * ratio;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function updateProfilePreview() {
  const wrap = document.getElementById('profile-preview-wrap');
  const content = document.getElementById('profile-preview-content');
  if (_profileAvatar.type === 'photo') {
    content.innerHTML = `<img src="${_profileAvatar.value}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    const e = _profileAvatar.type==='cartoon' ? _profileAvatar.emoji : _profileAvatar.value;
    content.innerHTML = `<span style="font-size:38px">${e}</span>`;
  }
}

window.saveProfile = async function() {
  const name = document.getElementById('profile-name-input').value.trim();
  if (!name) { toast('⚠️ הכנס שם'); return; }

  let avatarValue = _profileAvatar.value;

  // Upload photo to Firebase Storage if needed
  if (_profileAvatar.type === 'photo' && _profileAvatar.isLocalBlob) {
    toast('⬆️ מעלה תמונה...');
    try {
      avatarValue = await uploadAvatarPhoto(_profileAvatar.file);
    } catch (e) {
      console.warn('Photo upload failed, using local:', e);
      avatarValue = _profileAvatar.value; // keep base64 as fallback
    }
  }

  const profile = {
    displayName:    name,
    avatarType:     _profileAvatar.type,
    avatarValue:    avatarValue,
    avatarEmoji:    _profileAvatar.emoji || null,
  };

  // Save to localStorage for quick access
  localStorage.setItem('fsl_profile', JSON.stringify(profile));

  // Save to Firebase groups/{groupId}/members/{myId}
  if (groupId && myId) {
    try {
      await set(ref(db, `groups/${groupId}/members/${myId}`), {
        userId:      myId,
        displayName: name,
        avatarType:  _profileAvatar.type,
        avatarValue: avatarValue,
        avatarEmoji: _profileAvatar.emoji || null,
        role:        'member',
        joinedAt:    Date.now(),
      });
    } catch (e) { console.warn('Profile save to Firebase failed:', e); }
  }

  // Update local state
  myName = name;
  myProfile = profile;
  showScreen('main-screen');
  toast(`👋 שלום ${name}!`);
};

async function uploadAvatarPhoto(file) {
  const { getStorage, ref: storRef, uploadBytes, getDownloadURL } =
    await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js');
  const storage = getStorage();
  // Unique path per user — overwrites previous photo automatically
  const path = `avatars/${groupId}/${myId}/profile.jpg`;
  const sRef = storRef(storage, path);
  // Compress before upload
  const compressed = await compressImageToBlob(file, 300);
  await uploadBytes(sRef, compressed, { contentType: 'image/jpeg' });
  const url = await getDownloadURL(sRef);
  console.log('[avatar] uploaded, URL:', url.substring(0, 60) + '...');
  return url;
}

// Upload from an already-compressed base64 dataUrl — avoids re-reading file from disk
async function uploadAvatarPhotoFromDataUrl(dataUrl) {
  const { getStorage, ref: storRef, uploadBytes, getDownloadURL } =
    await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js');
  const storage = getStorage();
  const path = `avatars/${groupId}/${myId}/profile.jpg`;
  const sRef = storRef(storage, path);
  const blob = _dataUrlToBlob(dataUrl);
  await uploadBytes(sRef, blob, { contentType: 'image/jpeg' });
  return await getDownloadURL(sRef);
}

// Convert a base64 data-URL to a Blob (no re-read from disk, no hanging canvas)
function _dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = (header.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin  = atob(b64);
  const arr  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Compress image file → Blob (for Storage upload, not base64)
async function compressImageToBlob(file, maxPx) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.onload = e => {
      img.onerror = () => reject(new Error('Image load error'));
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const ratio = Math.min(maxPx / img.width, maxPx / img.height, 1);
          canvas.width  = Math.round(img.width  * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('canvas.toBlob returned null'));
          }, 'image/jpeg', 0.85);
        } catch(err) { reject(err); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ══════════════════════════════════════════════════
// AVATAR RENDERING HELPER
// ══════════════════════════════════════════════════
function renderAvatar(avatarType, avatarValue, avatarEmoji, size=18) {
  if (avatarType === 'photo' && avatarValue) {
    return `<div class="item-av" style="width:${size}px;height:${size}px"><img src="${avatarValue}"></div>`;
  }
  const e = avatarType==='cartoon' ? (avatarEmoji||'🧑') : (avatarValue||'👤');
  return `<div class="item-av" style="width:${size}px;height:${size}px;font-size:${size-4}px">${e}</div>`;
}

// ══════════════════════════════════════════════════
// ENHANCED ITEM HTML WITH ATTRIBUTION
// ══════════════════════════════════════════════════
// Override itemHTML to include attribution
const _origItemHTML = window.itemHTML || null;

function itemHTML(item) {
  const byMe = item.addedByUserId === myId || item.addedByDisplayName === myName;
  const isFavTab = curTab === 'fav';
  const isFavSaved = isItemInFavorites(item.name, item.barcode);

  // Live member data is PRIMARY source — snapshot is FALLBACK only
  const addedMember = item.addedByUserId ? (members[item.addedByUserId] || null) : null;
  const displayName = addedMember?.displayName || item.addedByDisplayName || item.addedBy || '?';
  const avatarType  = addedMember?.avatarType  || item.addedByAvatarType  || 'emoji';
  const avatarValue = addedMember?.avatarValue || item.addedByAvatarValue || '👤';
  const avatarEmoji = addedMember?.avatarEmoji || item.addedByAvatarEmoji || null;

  const boughtBtn = isFavTab ? '' : `<button class="${item.bought?'bought-tag':'pending-tag'}" onclick="toggleBought('${item.id}')" aria-pressed="${item.bought?'true':'false'}" aria-label="${item.bought?'בטל סימון — נקנה':'סמן כמוצר שנקנה'}">${item.bought?'✅ קניתי':'קניתי'}</button>`;

  // ── Product attachment tile (replaces check-btn) ──
  const at = item.attached;
  let ipTile;
  if (!isFavTab && at && at.name) {
    const label = esc(at.name.split(' ').slice(0, 3).join(' '));
    const sub   = esc([at.brand, at.size].filter(Boolean).join(' · '));
    const iconHtml = at.image
      ? `<img class="ip-tile-img" src="${esc(at.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span class="ip-tile-icon" style="display:none">${_ipEmoji(item.name)}</span>`
      : `<span class="ip-tile-icon">${_ipEmoji(item.name)}</span>`;
    ipTile = `<div class="ip-tile-wrap">
      <button class="ip-tile has-product" onclick="openBrandPicker('attach','${item.id}','${encodeURIComponent(item.name||'').replace(/'/g,'%27')}')" title="${label}">
        ${iconHtml}
        <span class="ip-tile-label">${label}</span>
        ${sub ? `<span class="ip-tile-sub">${sub}</span>` : ''}
      </button>
      <button class="ip-clear-btn" onclick="clearItemProduct('${item.id}',event)" title="הסר מוצר">✕</button>
    </div>`;
  } else if (!isFavTab) {
    ipTile = `<button class="ip-tile" onclick="openBrandPicker('attach','${item.id}','${encodeURIComponent(item.name||'').replace(/'/g,'%27')}')" title="בחר מוצר ספציפי">
      <span class="ip-tile-icon">${_ipEmoji(item.name)}</span>
      <span class="ip-tile-label" style="color:var(--muted)">בחר מוצר</span>
    </button>`;
  } else {
    ipTile = '';
  }

  const barcode = item.barcode || item.attached?.barcode || '';
  const hasPriceSource = !isFavTab && !item.bought && barcode && isValidBarcode(barcode);
  const priceChipHTML = hasPriceSource
    ? `<div class="price-chip-area" id="price-chip-${item.id}"><div class="price-chip-shimmer"></div></div>`
    : '';

  return `<div class="item-card${(!isFavTab&&item.bought)?' bought':''}${item.fav?' fav':''}">
    ${ipTile}
    <div class="item-body">
      <div class="item-name">${esc(item.name)}</div>
      <div class="item-attribution">
        ${renderAvatar(avatarType, avatarValue, avatarEmoji, 18)}
        <span class="item-by-name">${esc(displayName)}${byMe?' (אתה)':''}</span>
        ${item.checkedByUserId && item.bought ? `<span class="item-by-name" style="margin-right:5px">· ✅ ${esc(members[item.checkedByUserId]?.displayName || 'מישהו')}</span>` : ''}
      </div>
      <div class="qty-row">
        <button class="qty-btn" onclick="changeQty('${item.id}',-1)">−</button>
        <span class="qty-num">${item.qty||1}</span>
        <button class="qty-btn" onclick="changeQty('${item.id}',1)">+</button>
        ${boughtBtn}
      </div>
      ${priceChipHTML}
    </div>
    <div class="item-acts">
      <button class="fav-star-btn${isFavSaved?' starred':''}"
        onclick="toggleSavedFavorite('${item.id}','${esc(item.name)}','${item.barcode||''}')"
        aria-pressed="${isFavSaved?'true':'false'}"
        aria-label="${isFavSaved?'הסר ממועדפים':'הוסף למועדפים'}"
        title="${isFavSaved?'הסר ממועדפים':'שמור במועדפים'}"
      >${isFavSaved?'⭐':'☆'}</button>
      <button class="act-btn del" onclick="deleteItem('${item.id}')">✕</button>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════
// ACTIVITY FEED
// ══════════════════════════════════════════════════
let _activityOpen = false;

window.toggleActivityFeed = function() {
  _activityOpen = !_activityOpen;
  document.getElementById('activity-feed').style.display = _activityOpen ? 'block' : 'none';
  document.getElementById('act-toggle-icon').textContent = _activityOpen ? '▲' : '▼';
};

function renderActivityFeed(activityData) {
  const feed = document.getElementById('activity-feed');
  if (!feed) return;
  const acts = Object.values(activityData||{})
    .sort((a,b) => (b.createdAt||0) - (a.createdAt||0))
    .slice(0, 20);
  if (!acts.length) { feed.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:11px;padding:8px">אין פעילות עדיין</div>'; return; }

  const typeLabel = { item_added:'הוסיף', item_checked:'סימן', item_removed:'מחק', quantity_changed:'שינה כמות', manual_price_added:'הוסיף מחיר' };

  feed.innerHTML = acts.map(a => {
    const m = members[a.userId] || {};
    const av = renderAvatar(m.avatarType||a.avatarType||'emoji', m.avatarValue||a.avatarValue||'👤', m.avatarEmoji, 20);
    return `<div class="act-item">
      ${av}
      <span><b>${esc(m.displayName||a.displayName||'מישהו')}</b> ${typeLabel[a.type]||a.type} <b>${esc(a.itemName||'')}</b></span>
    </div>`;
  }).join('');
}

async function logActivity(type, itemId, itemName) {
  if (!groupId || !listId) return;
  const m = myProfile || {};
  const actId = 'act_' + Date.now();
  try {
    await set(ref(db, `shoppingLists/${groupId}/${listId}/activity/${actId}`), {
      type, itemId, itemName,
      userId:       myId,
      displayName:  myName,
      avatarType:   m.avatarType  || 'emoji',
      avatarValue:  m.avatarValue || '👤',
      avatarEmoji:  m.avatarEmoji || null,
      createdAt:    Date.now(),
    });
  } catch (_) {}
}

// ══════════════════════════════════════════════════
// BASKET COMPARE
// ══════════════════════════════════════════════════
let basketRadius = 10;

window.setBasketRadius = function(v) {
  basketRadius = +v;
  document.getElementById('basket-radius-val').textContent = v + ' ק"מ';
};

window.openBasketCompare = function() {
  document.getElementById('basket-overlay').classList.add('show');
};

window.runBasketCompare = async function() {
  const pending = Object.entries(items).filter(([,v]) => !v.bought);
  if (!pending.length) { toast('⚠️ הרשימה ריקה'); return; }

  const wrap = document.getElementById('basket-results-wrap');
  wrap.innerHTML = `<div class="price-loading"><div class="spin"></div><p>משווה מחירים...</p></div>`;

  // Use selectedLocation; if nearby mode off or no location, run without filter
  const lat = _hasLoc() ? _locLat() : null;
  const lng = _hasLoc() ? _locLng() : null;
  const locationLabel = _selectedLocation?.label || null;

  // Build items array (use barcode if available, else name)
  const basketItems = pending
    .filter(([,v]) => v.barcode)
    .map(([,v]) => ({ barcode: v.barcode, quantity: v.qty || 1 }));

  if (!basketItems.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">אין פריטים עם ברקוד לשוואה</div>';
    return;
  }

  try {
    const body = { items: basketItems, radiusKm: basketRadius };
    if (lat) { body.lat = lat; body.lng = lng; body.locationLabel = locationLabel; }

    const res = await fetch('/api/basket-compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    renderBasketResults(data, basketItems.length);
  } catch (e) {
    wrap.innerHTML = `<div style="text-align:center;padding:20px;color:var(--red)">${esc(e.message)}</div>`;
  }
};

function renderBasketResults(data, totalItems) {
  const wrap = document.getElementById('basket-results-wrap');
  const { results, bestFullBasket } = data;

  if (!results?.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">לא נמצאו חנויות בטווח</div>';
    return;
  }

  let html = '';
  if (bestFullBasket) {
    html += `<div style="font-size:10px;font-weight:700;color:var(--green);letter-spacing:.7px;text-transform:uppercase;margin-bottom:6px">🏆 הכי זול לסל המלא</div>`;
  }

  results.forEach(r => {
    const isBest = bestFullBasket && r.storeId === bestFullBasket.storeId && r.chainId === bestFullBasket.chainId;
    const completePct = Math.round((r.availableItems / totalItems) * 100);
    html += `<div class="basket-result-card${isBest?' best':''}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div class="basket-chain">${esc(r.chainName)}</div>
        ${isBest?'<span class="best-badge-full">הכי זול ✅</span>':''}
      </div>
      <div style="display:flex;align-items:baseline;gap:6px">
        <div class="basket-total">₪${r.total.toFixed(2)}</div>
        ${r.distanceKm ? `<span class="distance-label">📍 ${r.distanceKm} ק"מ</span>` : ''}
      </div>
      <div class="basket-meta">
        <span>✅ ${r.availableItems}/${totalItems} פריטים (${completePct}%)</span>
        ${r.city ? `<span>🏙 ${esc(r.city)}</span>` : ''}
      </div>
      ${(Array.isArray(r.missingItems) ? r.missingItems.length : (r.missingItems||0)) > 0 ? `<div class="basket-missing">חסרים ${Array.isArray(r.missingItems) ? r.missingItems.length : r.missingItems} פריטים</div>` : ''}
      <div class="basket-items-mini">
        ${(r.items||[]).slice(0,4).map(i => `
          <div class="basket-item-row">
            <span>${esc(i.name||i.barcode)}</span>
            <span>₪${i.totalPrice.toFixed(2)}</span>
          </div>`).join('')}
        ${r.items?.length > 4 ? `<div class="basket-item-row" style="color:var(--muted);text-align:center">ועוד ${r.items.length-4}...</div>` : ''}
      </div>
    </div>`;
  });

  wrap.innerHTML = html;
}

// ══════════════════════════════════════════════════
// ENHANCED SHOPPING LIST ACTIONS WITH ATTRIBUTION + ACTIVITY
// ══════════════════════════════════════════════════
// Store listId (default: 'default')
let listId = 'default';
let myProfile = null;

// ── BRAND PICKER ──
let _bpAbortCtrl  = null;   // cancel in-flight OFF requests when picker re-opens/closes
let _bpMode       = 'new';  // 'new' | 'attach'
let _bpItemId     = null;   // item ID when mode==='attach'
let _bpProducts   = [];     // current result list (indexed by button onclick)
let _bpSearchTimer = null;

function _boldKeyword(text, keyword) {
  if (!keyword || !text) return esc(text);
  try {
    const kw = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.split(new RegExp(`(${kw})`, 'gi'))
      .map(p => p.toLowerCase() === keyword.toLowerCase() ? `<strong>${esc(p)}</strong>` : esc(p))
      .join('');
  } catch(_) { return esc(text); }
}

window._onAddInputChange = function() {
  const btn = document.getElementById('brand-pick-btn');
  const val = document.getElementById('new-item-input')?.value.trim() || '';
  btn?.classList.toggle('show', val.length > 1);
};

// Internal search runner — used by both 'new' and 'attach' modes
// Quick Hebrew→English for OFX search (mirrors server-side HE_EN dict)
const _BP_HE_EN = {
  'חלב':'milk','גבינה':'cheese','קוטג':'cottage cheese',"קוטג'":'cottage cheese',
  'שמנת':'cream','יוגורט':'yogurt','חמאה':'butter','לחם':'bread','פיתה':'pita',
  'קמח':'flour','ביצים':'eggs','ביצה':'egg','קורנפלקס':'cornflakes',
  'שיבולת שועל':'oatmeal','גרנולה':'granola','אורז':'rice','פסטה':'pasta',
  'שמן':'oil','שמן זית':'olive oil','סוכר':'sugar','דבש':'honey','מלח':'salt',
  'טחינה':'tahini','חומוס':'hummus','קטשופ':'ketchup','מיונז':'mayonnaise',
  'טונה':'tuna','קפה':'coffee','תה':'tea','מיץ':'juice','שוקולד':'chocolate',
  'עוגיות':'cookies','במבה':'bamba','ביסלי':'bisli','גלידה':'ice cream',
  'עוף':'chicken','בשר':'beef','דג':'fish','עגבניות':'tomatoes',
  'מלפפון':'cucumber','בצל':'onion','שום':'garlic','גזר':'carrot',
  'תפוח אדמה':'potato','ברוקולי':'broccoli','תפוח':'apple','בננה':'banana',
  // household & hygiene
  'נייר טואלט':'toilet paper','נייר אסלה':'toilet paper',
  'נייר מגבת':'paper towel','מגבת נייר':'paper towel',
  'מגבונים':'wet wipes','מגבון':'wet wipe',
  'סבון':'soap','סבון ידיים':'hand soap','סבון כלים':'dish soap',
  'שמפו':'shampoo','מרכך':'conditioner','מרכך שיער':'hair conditioner',
  'אבקת כביסה':'laundry detergent','נוזל כביסה':'liquid detergent',
  'מרכך כביסה':'fabric softener','ממיס שומן':'degreaser',
  'חומר ניקוי':'cleaning product','נוזל ניקוי':'cleaning liquid',
  'אקונומיקה':'bleach','מי ברז':'water',
  'תחתיות':'diapers','חיתולים':'diapers','טיטולים':'diapers',
  'פד':'pad','תחבושת':'sanitary pad',
  'קרם שיניים':'toothpaste','מברשת שיניים':'toothbrush',
  'דאודורנט':'deodorant','קרם גוף':'body lotion','קרם פנים':'face cream',
  'תחבושת פלסטר':'bandage','כדורים':'pills',
  // kitchen & misc
  'שקיות זבל':'garbage bags','שקית זבל':'garbage bag',
  'ניילון נצמד':'cling film','נייר אלומיניום':'aluminum foil',
  'נייר אפייה':'baking paper','נייר לאפייה':'baking paper',
  'ספריי ניקוי':'cleaning spray','ספריי':'spray',
  'נוזל כלים':'dish soap',
  'כלי חד פעמי':'disposable','צלחת חד פעמית':'disposable plate',
  'כוס חד פעמית':'disposable cup',
  'מרק':'soup','מרק עוף':'chicken soup','מרק ירקות':'vegetable soup',
  'שימורים':'canned food','קופסת שימורים':'canned goods',
  'חטיפים':'snacks','חטיף':'snack',
  'מים':'water','מים מינרליים':'mineral water','סודה':'soda water',
};

// Canonical synonym map — variant phrasings → canonical _BP_HE_EN key.
// Add entries here to cover misspellings, alternative phrasing, singular/plural.
const _BP_SYNONYMS = {
  // toilet paper variants & typos
  'נייר שירותים':  'נייר טואלט',
  'טישו טואלט':    'נייר טואלט',
  'נייר טואלת':    'נייר טואלט',
  'ניר טואלט':     'נייר טואלט',   // missing yod
  'ניר טואלת':     'נייר טואלט',
  // paper towel
  'נייר מגבות':    'נייר מגבת',
  'ניר מגבת':      'נייר מגבת',
  // other
  'מגבונים לחים':  'מגבונים',
  'משחת שיניים':   'קרם שיניים',
  'משחה לשיניים':  'קרם שיניים',
  'סבון כלים':     'נוזל כלים',
  'ג\'ל רחצה':     'סבון',
  'חיתול':         'חיתולים',
  'טיטול':         'טיטולים',
  'שמפו לשיניים':  'קרם שיניים',
  // common Hebrew typos
  "קוטץ":          "קוטג'",         // ץ/ג final-letter confusion
};

// Full text normalization — Unicode, punctuation, separators, whitespace.
// Applied before ALL matching: translation, synonym, scoring, API queries.
// Raw query is preserved separately for display only.
function normalizeProductQuery(q) {
  if (!q) return '';
  let s = String(q).normalize('NFKC');
  // Remove emoji and pictographic symbols (common in WhatsApp messages: 🛒 ✅ 🔥 ❤️)
  s = s.replace(/\p{Extended_Pictographic}/gu, '');
  // Strip leading NL action prefixes (may survive from WhatsApp import item names)
  s = s.replace(/^(לקנות|צריך|תוסיף|להוסיף|קנה|קני|נצטרך|צריכים|תקני|תקנה|מחק|תמחק|קניתי|כבר יש)\s*:?\s*/u, '');
  // Normalize apostrophe/geresh variants → straight apostrophe U+0027
  s = s.replace(/[''׳`ʼ']/g, "'");
  // Normalize quote/gershayim variants → straight double-quote, then strip wrapping quotes
  s = s.replace(/[""״]/g, '"').replace(/^"(.+)"$/, '$1').replace(/^'(.+)'$/, '$1');
  // Replace separator characters with spaces
  s = s.replace(/[-–—,;:/\\|_]/g, ' ');
  // Replace bracket/parenthesis chars with spaces (keep inner content)
  s = s.replace(/[()[\]{}]/g, ' ');
  // Remove trailing dots and ellipsis
  s = s.replace(/[.…]+$/, '').replace(/^[.…]+/, '');
  // Remove internal dots (Hebrew product queries never use decimal notation)
  s = s.replace(/\.+/g, ' ');
  // Collapse whitespace
  return s.replace(/\s+/g, ' ').trim();
}

// Apply synonym map after full normalization.
function _bpNormalizeQuery(q) {
  const s = normalizeProductQuery(q);
  return _BP_SYNONYMS[s] || s;
}

// Extract quantity and brand from a normalized query.
// qty and brand are stored for future use; product is the search term.
// "2 קוטג' תנובה" → { product: "קוטג'", qty: 2, brand: "תנובה" }
function _bpParseQueryMeta(normQ) {
  let s = normQ;
  let qty = null, brand = null, m;
  if ((m = s.match(/^(\d+)\s*x?\s+/i))     && +m[1] > 0) { qty = +m[1]; s = s.slice(m[0].length).trim(); }
  else if ((m = s.match(/\s+x?(\d+)$/i))   && +m[1] > 0) { qty = +m[1]; s = s.slice(0, -m[0].length).trim(); }
  const sLow = s.toLowerCase();
  for (const br of _IL_BRANDS_SET) {
    if (sLow.endsWith(' ' + br)) { brand = br; s = s.slice(0, -(br.length + 1)).trim(); break; }
    else if (sLow === br)        { brand = br; s = '';                                   break; }
  }
  return { product: s || normQ, qty, brand };
}

// Levenshtein distance for short tokens — used in fuzzy scoring.
// Fast-exits when string lengths differ by more than 3 (tokens are short).
function _levenshtein(a, b) {
  if (!a) return b.length; if (!b) return a.length;
  if (Math.abs(a.length - b.length) > 3) return Math.max(a.length, b.length);
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function _bpTranslate(q) {
  // q arrives already normalized; apostrophe guard kept as defense-in-depth
  const l     = q.trim();
  const lNorm = l.replace(/[''׳`'ʼ]/g, "'");
  if (_BP_HE_EN[l])     return _BP_HE_EN[l];
  if (_BP_HE_EN[lNorm]) return _BP_HE_EN[lNorm];
  // Exact substring match
  for (const [h, e] of Object.entries(_BP_HE_EN)) {
    if (l.includes(h) || lNorm.includes(h)) return e;
  }
  // Fuzzy token match — catches typos like "ניר" (missing yod) vs "נייר".
  // Only fires when exact/substring both failed.
  // Requires ALL query tokens to find a match (exact or dist≤1) within the SAME dict key.
  // This prevents "ניר מגבת" from falsely matching "נייר טואלט" via the "ניר"≈"נייר" hit alone.
  const lTokens = lNorm.split(/\s+/).filter(w => w.length >= 3);
  if (lTokens.length) {
    for (const [h, e] of Object.entries(_BP_HE_EN)) {
      const hTokens = h.replace(/[''׳`'ʼ]/g, '').split(/\s+/).filter(w => w.length >= 3);
      if (!hTokens.length) continue;
      const allMatch = lTokens.every(lt => hTokens.some(ht => _levenshtein(lt, ht) <= 1));
      if (allMatch) return e;
    }
  }
  return null;
}

// ── Language detection & relevance scoring ──────────────────────────────────
const _RE_HEB  = /[א-ת]/;   // Hebrew alphabet
const _RE_ARAB = /[؀-ۿ]/;   // Arabic alphabet

function _bpDetectLang(t) {
  return _RE_HEB.test(t) ? 'he' : _RE_ARAB.test(t) ? 'ar' : 'latin';
}

// Known Israeli/Israel-common brand tokens (lowercase) — scoring bonus
const _IL_BRANDS_SET = new Set([
  'תנובה','שטראוס','עלית','אסם','אוסם','טרה','ויסוצקי','תלמה','אנג\'לה',
  'tnuva','strauss','elite','osem','tara','wissotzky','telma','angel','yotvata',
]);

// Pick the most appropriate name field based on the query's language
function _bpSelectName(p, queryLang) {
  const he = (p.product_name_he || '').trim();
  const ar = (p.product_name_ar || '').trim();
  const en = (p.product_name    || '').trim();
  if (queryLang === 'he') return he || en || ar;
  if (queryLang === 'ar') return ar || he || en;
  return en || he || ar;
}

// Score a candidate product for a given query.
// Higher = more relevant. Negative = should be filtered out.
// queryBrand (optional): extracted brand token — gives a ranking boost.
function _bpScore(p, query, queryLang, enQuery, queryBrand) {
  let score = 0;
  const nameLang = _bpDetectLang(p.name);
  const nLow     = p.name.toLowerCase();
  const qLow     = query.toLowerCase();
  const eLow     = (enQuery || '').toLowerCase();
  const bLow     = (p.brand || '').toLowerCase();

  // ── 1. Language alignment (most important) ──────────────────────────────
  // Big bonus when the product name is in the same language as the query
  if (queryLang === 'he' && nameLang === 'he') score += 50;
  if (queryLang === 'ar' && nameLang === 'ar') score += 50;
  // Heavily penalise non-Israeli Latin results when query is Hebrew/Arabic —
  // this is what filters out Kinder/Jaouda/Carrefour junk
  if (queryLang !== 'latin' && nameLang === 'latin' && !p.isIsraeli) score -= 25;

  // ── 2. Israeli origin ───────────────────────────────────────────────────
  if (p.isIsraeli) score += 25;
  if (bLow.split(/[\s,/]+/).some(w => w && _IL_BRANDS_SET.has(w))) score += 15;

  // ── 3. Name contains the query words ────────────────────────────────────
  const qWords = qLow.split(/\s+/).filter(w => w.length > 1);
  if (qWords.length) {
    score += (qWords.filter(w => nLow.includes(w)).length / qWords.length) * 25;
  }
  if (nLow.includes(qLow))   score += 20; // exact phrase in name
  if (nLow.startsWith(qLow)) score += 10; // name starts with query

  // ── 4. English translation match ─────────────────────────────────────────
  if (eLow && eLow !== qLow) {
    const eWords = eLow.split(/\s+/).filter(w => w.length > 2);
    if (eWords.length) {
      score += (eWords.filter(w => nLow.includes(w)).length / eWords.length) * 15;
    }
    if (nLow.includes(eLow)) score += 10;
  }

  // ── 5. Extracted query brand match ───────────────────────────────────────
  if (queryBrand) {
    const qbLow = queryBrand.toLowerCase();
    if (bLow.split(/[\s,/]+/).some(w => w === qbLow) || nLow.includes(qbLow)) score += 20;
  }

  // ── 6. Fuzzy token match — Levenshtein distance (typo tolerance) ─────────
  // Adds score for tokens that are close but not exact (edit distance 1-2).
  // Handles: "ניר" vs "נייר", "קוטץ" vs "קוטג", "טואלת" vs "טואלט"
  const qTokens = qLow.split(/\s+/).filter(w => w.length >= 3);
  const nTokens = nLow.split(/\s+/).filter(w => w.length >= 3);
  if (qTokens.length && nTokens.length) {
    let fuzzyHits = 0;
    for (const qt of qTokens) {
      if (nLow.includes(qt)) continue; // exact already scored in component 3
      const bestDist = Math.min(...nTokens.map(nt => _levenshtein(qt, nt)));
      if (bestDist === 1) fuzzyHits += 1;
      else if (bestDist === 2 && qt.length >= 5) fuzzyHits += 0.5;
    }
    if (fuzzyHits > 0) score += (fuzzyHits / qTokens.length) * 12;
  }

  return score;
}
// ────────────────────────────────────────────────────────────────────────────

async function _bpRunSearch(query, signal) {
  const resultsEl = document.getElementById('bp-results');
  const queryEl   = document.getElementById('bp-query-text');
  if (queryEl)   queryEl.textContent = `מחפש "${query}"...`;
  if (resultsEl) resultsEl.innerHTML = '<div class="bp-loading">🔍 מחפש מוצרים...</div>';
  try {
    const rawQuery  = query;                           // preserved for display only
    const normQ     = _bpNormalizeQuery(rawQuery);     // normalized + synonym-resolved
    const meta      = _bpParseQueryMeta(normQ);        // extract qty, brand, clean product
    const queryBrand = meta.brand;                     // null or extracted brand token
    const productQ  = meta.product;                    // query with qty/brand stripped
    const queryLang = _bpDetectLang(normQ);            // lang detection on clean text
    const enQuery   = queryLang === 'he' ? (_bpTranslate(productQ) || normQ) : normQ;
    const enc       = encodeURIComponent(enQuery);
    const encOrig   = encodeURIComponent(normQ);       // normalized (not raw) for URL 1

    const BASE   = 'https://world.openfoodfacts.org/cgi/search.pl';
    // Added product_name_ar so Arabic product names are available for ranking
    const FIELDS = 'product_name,product_name_he,product_name_ar,brands,quantity,image_small_url,code,countries_tags';
    const IL     = '&tagtype_0=countries&tag_contains_0=contains&tag_0=israel';

    const urls = [
      // 1. Israel-filtered + original normalized query
      `${BASE}?search_terms=${encOrig}&search_simple=1&action=process&json=1&page_size=20&fields=${FIELDS}${IL}`,
      // 2. Israel-filtered + translated query (only when translation differs from normalized query)
      enQuery !== normQ
        ? `${BASE}?search_terms=${enc}&search_simple=1&action=process&json=1&page_size=15&fields=${FIELDS}${IL}`
        : null,
      // 3. Broad fallback — no country filter; low-scored items get filtered by _bpScore
      `${BASE}?search_terms=${enc}&search_simple=1&action=process&json=1&page_size=20&fields=${FIELDS}`,
    ].filter(Boolean);

    const seen = new Set();
    const raw  = [];

    for (const url of urls) {
      if (raw.length >= 35) break;
      if (signal.aborted) return;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'FamilyShoppingIL/6.3' }, signal });
        if (!r.ok) continue;
        const data = await r.json();
        for (const p of data?.products || []) {
          const code = p.code || '';
          if (code && seen.has(code)) continue;
          if (code) seen.add(code);
          const isIsraeli = (p.countries_tags || []).some(c => c.includes('israel'));
          // Use language-aware name selection
          const name = _bpSelectName(
            { product_name_he: p.product_name_he, product_name_ar: p.product_name_ar, product_name: p.product_name },
            queryLang
          ) || '';
          if (!name) continue;
          raw.push({ name, brand: p.brands || '', size: p.quantity || '',
                     image: p.image_small_url || '', barcode: code, isIsraeli });
        }
      } catch(e) { if (e.name === 'AbortError') return; }
    }

    if (signal.aborted) return;

    // Score every candidate, filter irrelevant ones, sort by relevance
    const MIN_SCORE = queryLang !== 'latin' ? -10 : -20;
    const _scored = raw.map(p => ({ ...p, _s: _bpScore(p, normQ, queryLang, enQuery, queryBrand) }));
    const topScore = _scored.length ? Math.max(..._scored.map(p => p._s)) : 0;
    _bpProducts = _scored
      .filter(p => p._s > MIN_SCORE)
      .sort((a, b) => b._s - a._s)
      .map(({ _s, ...p }) => p)
      .slice(0, 20);
    // Layer 5: if strict filter removed everything, show best candidates anyway
    let _bpFallback = false;
    if (!_bpProducts.length && raw.length > 0) {
      _bpFallback = true;
      _bpProducts = [..._scored].sort((a, b) => b._s - a._s).slice(0, 8).map(({ _s, ...p }) => p);
    }
    console.log('[search-quality]', { rawQuery, normalizedQuery: normQ, translatedQuery: enQuery, topScore, resultCount: _bpProducts.length, candidateCount: raw.length, fallback: _bpFallback });

    if (queryEl) queryEl.textContent = _bpProducts.length
      ? `מצאנו ${_bpProducts.length} מוצרים עבור "${query}"`
      : `לא נמצאו תוצאות עבור "${query}"`;
    if (!_bpProducts.length) {
      if (resultsEl) resultsEl.innerHTML = '<div class="bp-loading">😕 לא נמצאו מוצרים<br><small>נסה מילה אחרת</small></div>';
      return;
    }
    const isAttach = _bpMode === 'attach' || _bpMode === 'fav-attach';
    const _fallbackNotice = _bpFallback
      ? '<div class="bp-fallback-note">לא נמצאה התאמה מדויקת — מציגים תוצאות דומות</div>'
      : '';
    if (resultsEl) resultsEl.innerHTML = _fallbackNotice + _bpProducts.slice(0, 14).map((p, i) => {
      const nameHtml = _boldKeyword(p.name, normQ);
      const sub = [p.brand, p.size].filter(Boolean).join(' · ');
      const imgTag = p.image
        ? `<img class="bp-item-img" src="${esc(p.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : '';
      const phStyle = p.image ? 'style="display:none"' : '';
      const btnClick = `selectBrandProduct(${i})`;
      const btnLabel = isAttach ? 'בחר' : 'הוסף';
      return `<div class="bp-item">
        ${imgTag}<div class="bp-img-ph" ${phStyle}>🛒</div>
        <div class="bp-item-info">
          <div class="bp-item-name">${nameHtml}</div>
          ${sub ? `<div class="bp-item-sub">${esc(sub)}</div>` : ''}
        </div>
        <button class="bp-add-btn" onclick="${btnClick}">${btnLabel}</button>
      </div>`;
    }).join('');
  } catch(e) {
    if (e.name === 'AbortError') return;
    const resultsEl = document.getElementById('bp-results');
    if (resultsEl) resultsEl.innerHTML = `<div class="bp-loading">⚠️ ${esc(e.message)}</div>`;
  }
}

// openBrandPicker(mode='new')           — from add-bar brand button
// openBrandPicker('attach', id, name)   — from ip-tile on existing items
window.openBrandPicker = async function(mode, itemId, itemName) {
  _bpMode   = (mode === 'attach') ? 'attach' : (mode === 'fav-attach') ? 'fav-attach' : 'new';
  _bpItemId = itemId || null;
  try { itemName = decodeURIComponent(itemName || ''); } catch(_) {}

  if (_bpAbortCtrl) _bpAbortCtrl.abort();
  _bpAbortCtrl = new AbortController();
  const signal = _bpAbortCtrl.signal;

  const isAttachMode = _bpMode === 'attach' || _bpMode === 'fav-attach';
  const query = isAttachMode
    ? (itemName || '')
    : (document.getElementById('new-item-input')?.value.trim() || '');
  if (!query) return;

  // Show/hide mode-specific controls
  const hintEl      = document.getElementById('bp-item-hint');
  const searchWrap  = document.getElementById('bp-search-wrap');
  const searchEl    = document.getElementById('bp-search');
  const queryBar    = document.getElementById('bp-query-bar');
  if (isAttachMode) {
    if (hintEl)     { hintEl.textContent = `עבור: ${itemName}`; hintEl.style.display = 'block'; }
    if (searchWrap) searchWrap.style.display = 'block';
    if (searchEl)   { searchEl.value = query; }
    if (queryBar)   queryBar.style.display = 'none';
  } else {
    if (hintEl)     hintEl.style.display = 'none';
    if (searchWrap) searchWrap.style.display = 'none';
    if (queryBar)   queryBar.style.display = 'block';
  }

  document.getElementById('bp-overlay')?.classList.add('show');
  document.body.classList.add('sheet-open');
  await _bpRunSearch(query, signal);
};

window._bpOnSearchInput = function() {
  clearTimeout(_bpSearchTimer);
  const val = document.getElementById('bp-search')?.value.trim();
  if (!val) return;
  if (_bpAbortCtrl) _bpAbortCtrl.abort();
  _bpAbortCtrl = new AbortController();
  _bpSearchTimer = setTimeout(() => _bpRunSearch(val, _bpAbortCtrl.signal), 380);
};

window.selectBrandProduct = function(nameOrIdx, barcode) {
  if (_bpMode === 'attach' || _bpMode === 'fav-attach') {
    // nameOrIdx is an index into _bpProducts
    const p = _bpProducts[nameOrIdx];
    if (p && _bpItemId) {
      const payload = { name: p.name, brand: p.brand||null, size: p.size||null,
                        barcode: p.barcode||null, image: p.image||null };
      const path = _bpMode === 'fav-attach'
        ? `favorites/${groupId}/${_bpItemId}`
        : `groups/${groupId}/items/${_bpItemId}`;
      update(ref(db, path), { attached: payload })
        .catch(e => console.warn('[bp-attach] failed:', e.message));
    }
    closeBrandPicker();
    return;
  }
  // 'new' mode — nameOrIdx is the product index into _bpProducts
  const p = _bpProducts[nameOrIdx];
  if (!p) return;
  window._pendingBarcode = p.barcode || null;
  const input = document.getElementById('new-item-input');
  if (input) input.value = p.name;
  closeBrandPicker();
  window.addItem();
};

window.closeBrandPicker = function() {
  clearTimeout(_bpSearchTimer);
  if (_bpAbortCtrl) { _bpAbortCtrl.abort(); _bpAbortCtrl = null; }
  document.getElementById('bp-overlay')?.classList.remove('show');
  document.body.classList.remove('sheet-open');
  _bpMode = 'new'; _bpItemId = null; _bpProducts = [];
};

// ── ip-tile helpers (emoji + clear; picker reuses bp-overlay) ──
function _ipEmoji(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('חלב'))                          return '🥛';
  if (n.includes('לחמ') || n.includes('לחם'))     return '🍞';
  if (n.includes('ביצ'))                          return '🥚';
  if (n.includes('עוף') || n.includes('פרגית'))   return '🍗';
  if (n.includes('בשר') || n.includes('סטייק'))   return '🥩';
  if (n.includes('דג'))                           return '🐟';
  if (n.includes('גבינ'))                         return '🧀';
  if (n.includes('יוגורט'))                       return '🥄';
  if (n.includes('תפוח') || n.includes('פרי'))    return '🍎';
  if (n.includes('ירק') || n.includes('עגבנ'))    return '🥦';
  if (n.includes('אורז'))                         return '🍚';
  if (n.includes('פסטה') || n.includes('ספגטי'))  return '🍝';
  if (n.includes('קפה'))                          return '☕';
  if (n.includes('תה'))                           return '🍵';
  if (n.includes('שמן'))                          return '🫙';
  if (n.includes('סוכר') || n.includes('מלח'))    return '🧂';
  if (n.includes('שוקולד') || n.includes('חטיף')) return '🍫';
  if (n.includes('עוגי') || n.includes('ביסקוי')) return '🍪';
  if (n.includes('מיץ') || n.includes('שתייה'))   return '🧃';
  if (n.includes('חומוס') || n.includes('טחינ'))  return '🫘';
  if (n.includes('ממרח') || n.includes('חמאה'))   return '🧈';
  if (n.includes('שמפו') || n.includes('סבון'))   return '🧴';
  if (n.includes('ניקוי') || n.includes('כביסה')) return '🧹';
  return '🛒';
}

window.clearItemProduct = function(itemId, e) {
  if (e) e.stopPropagation();
  update(ref(db, `groups/${groupId}/items/${itemId}`), { attached: null })
    .catch(e => console.warn('[ip] clear failed:', e.message));
};

// Override addItem to include attribution and activity
window.addItem = function() {
  const input = document.getElementById('new-item-input');
  const name = input.value.trim();
  if (!name) return;

  // Duplicate detection — increase quantity instead of adding a new row
  const existing = findExistingListItem(name, null);
  if (existing) {
    const newQty = (existing.qty || 1) + 1;
    update(ref(db, `groups/${groupId}/items/${existing.id}`), { qty: newQty });
    toast(`➕ ${esc(name)} × ${newQty}`);
    input.value = '';
    return;
  }

  const m = myProfile || {};
  const barcode = window._pendingBarcode || null;
  window._pendingBarcode = null;
  const newRef = push(ref(db, `groups/${groupId}/items`));
  set(newRef, {
    name, qty: 1, bought: false, fav: false,
    barcode,
    addedByUserId:      myId,
    addedByDisplayName: myName,
    addedByAvatarType:  m.avatarType  || 'emoji',
    addedByAvatarValue: m.avatarValue || '👤',
    addedByAvatarEmoji: m.avatarEmoji || null,
    addedAt:            Date.now(),
    ts:                 Date.now(),
  });
  logActivity('item_added', newRef.key, name);
  input.value = '';
  window._onAddInputChange(); // hide the 🔍 button after adding
  toast('✅ ' + name + ' נוסף');
};

// Override toggleBought to save checkedByUserId
const _origToggleBought = window.toggleBought;
window.toggleBought = async function(id) {
  const item = items[id];
  if (!item) return;
  const nowBought = !item.bought;
  _haptic(nowBought ? 18 : 12);

  await update(ref(db, `groups/${groupId}/items/${id}`), {
    bought:              nowBought,
    checkedByUserId:     nowBought ? myId   : null,   // legacy field (kept for compatibility)
    checkedAt:           nowBought ? Date.now() : null, // legacy field
    purchasedByUserId:   nowBought ? myId   : null,   // Phase 4 canonical field
    purchasedByName:     nowBought ? myName : null,
    purchasedAt:         nowBought ? Date.now() : null,
  });

  if (nowBought) {
    logActivity('item_checked', id, item.name);
    // Notify item owner if different user
    const isOther = item.addedByUserId && item.addedByUserId !== myId;
    if (isOther) {
      const targets = {};
      targets[item.addedByUserId] = true;
      await createNotification({
        type: 'item_bought', itemId: id,
        itemName: item.name, targetUsersObj: targets,
      });
    }
  } else {
    logActivity('item_unbought', id, item.name);
    const isOther = item.addedByUserId && item.addedByUserId !== myId;
    if (isOther) {
      const targets = {};
      targets[item.addedByUserId] = true;
      await createNotification({
        type: 'item_unbought', itemId: id,
        itemName: item.name, targetUsersObj: targets,
      });
    }
  }
};

// Override deleteItem to log activity
const _origDeleteItem = window.deleteItem;

// ══════════════════════════════════════════════════
// PROFILE INIT ON APP LOAD
// ══════════════════════════════════════════════════
function loadSavedProfile() {
  const saved = localStorage.getItem('fsl_profile');
  if (saved) {
    try { myProfile = JSON.parse(saved); myName = myProfile.displayName || myName; } catch (_) {}
  }
}

// ══════════════════════════════════════════════════
// BASKET COMPARE BUTTON IN HEADER
// ══════════════════════════════════════════════════
// ── ADD BASKET COMPARE BUTTON → price toolbar (keeps main header clean) ──
function addBasketButton() {
  if (document.getElementById('basket-compare-btn')) return;
  const toolbar = document.getElementById('price-tools');
  if (!toolbar) return;
  const btn = document.createElement('button');
  btn.id = 'basket-compare-btn'; btn.className = 'pt-btn'; btn.title = 'השוואת סל';
  btn.innerHTML = '🧺 השווה סל'; btn.onclick = openBasketCompare;
  toolbar.appendChild(btn);
}

// ══════════════════════════════════════════════════
// FIREBASE PATH UPDATE: use shoppingLists/{groupId}/{listId}/items
// ══════════════════════════════════════════════════
// Override connectToGroup to use new schema
const _origConnectToGroup = connectToGroup;
// We patch this after the module loads via init hook
function patchFirebasePaths() {
  if (!groupId || !listId) return;
  // Listen to items at new path
  onValue(ref(db, `shoppingLists/${groupId}/${listId}/items`), snap => {
    items = snap.val() || {};
    renderList(); updateCounts();
  });
  // Listen to activity
  onValue(ref(db, `shoppingLists/${groupId}/${listId}/activity`), snap => {
    const container = document.getElementById('activity-feed-container');
    if (container) container.style.display = snap.exists() ? 'block' : 'none';
    renderActivityFeed(snap.val() || {});
  });
}

// ══════════════════════════════════════════════════
// INIT HOOK
// ══════════════════════════════════════════════════
const _origInit = window._origInit || null;
window._profileSystemReady = true;

// Run after Firebase connected
const _origConnectFn = connectToGroup;
window._patchConnectToGroup = function() {
  loadSavedProfile();
  renderProfileSetup();
  addBasketButton();

  // Check if profile is set — if not, show profile screen
  if (!myProfile || !myProfile.displayName) {
    const savedUser = localStorage.getItem('fsl_v2');
    if (savedUser) {
      // Has group but no profile — show profile setup
      showScreen('profile-screen');
      return;
    }
  }
};

// Call patch on connect
const _realConnectToGroup = connectToGroup;




// ══════════════════════════════════════════════════
// PRICE SYSTEM — LAYERED ARCHITECTURE
// Layer 1: Official XML (GitHub Actions → Firebase) — primary
// Layer 2: Proxy (Vercel Edge) — experimental fallback
// Layer 3: Manual (Barcode scan + user input) — always available
// ══════════════════════════════════════════════════

const STORE_LIST_ALL = ['שופרסל','רמי לוי','ויקטורי','יינות ביתן','מחסני להב','אושר עד'];
let _currentScanProduct = null;
let _scannerStream = null;
let _barcodeDetector = null;
let _scanTimer = null;

let _overrideContext = null;
let _reportContext = null;
// ── SOURCE BADGE HELPER ──

// ── GET ALL PRICES FOR BARCODE (layered) ──
async function getAllPricesForBarcode(barcode) {
  if (!barcode) return { official: [], manual: [], proxy: [] };

  // Layer 1: Official from Firebase (synced from XML)
  let official = [];
  try {
    const snap = await get(ref(db, `prices/${barcode}`));
    if (snap.exists()) {
      official = Object.values(snap.val())
        .filter(p => p?.price > 0 && p?.source !== 'manual')
        .map(p => ({ ...p, source: 'official' }))
        .sort((a,b) => a.price - b.price);
    }
  } catch (_) {}

  // Layer 2: Manual prices from Firebase
  let manual = [];
  try {
    const snap = await get(ref(db, `manualPrices/${barcode}`));
    if (snap.exists()) {
      manual = Object.values(snap.val())
        .filter(p => p?.price > 0)
        .map(p => ({ ...p, source: 'manual' }))
        .sort((a,b) => a.price - b.price);
    }
  } catch (_) {}

  // Layer 3: Proxy (experimental — non-blocking)
  let proxy = [];
  // Proxy attempt runs in background — don't await here for speed

  return { official, manual, proxy };
}

// ── OPEN BARCODE SCANNER ──



// ── HANDLE SCANNED BARCODE ──

// ── PRICE SUBMIT MODAL ──

// ── SUBMIT MANUAL PRICES ──

// ── ENHANCED PRICE DISPLAY in showProductPrices ──
// Override to show badges per source
const _origShowProductPrices = window.showProductPrices;

// Override selectProduct to use enhanced version

// ── SAVE SINGLE PRICE (from price tab inline input) ──
window.saveSinglePrice = async function(storeName, inputId, barcode, productName) {
  const val = parseFloat(document.getElementById(inputId)?.value);
  if (!val || val <= 0) { toast('⚠️ הכנס מחיר תקין'); return; }
  const m = myProfile || {};
  const entryId = `m_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  try {
    await set(ref(db, `manualPrices/${barcode}/${entryId}`), {
      barcode, name: productName,
      price: Math.round(val*100)/100,
      chainName: storeName, storeName,
      groupId: groupId||null,
      submittedByUserId:      myId,
      submittedByDisplayName: myName,
      submittedByAvatarType:  m.avatarType  || 'emoji',
      submittedByAvatarValue: m.avatarValue || '👤',
      submittedAt: new Date().toISOString(),
      source: 'manual',
    });
    toast(`💰 מחיר נשמר: ₪${val.toFixed(2)} ב${storeName}`);
    // Refresh display
    if (selectedProduct) window.showProductPricesEnhanced(selectedProduct);
  } catch(e) { toast('❌ ' + e.message); }
};

// ── OPEN SCANNER FOR SPECIFIC PRODUCT ──
window.openScannerForProduct = function(name, barcode) {
  _currentScanProduct = { name, barcode, brand:'', size:'', image:'' };
  openPriceSubmitModal(_currentScanProduct, [], []);
  document.getElementById('price-submit-overlay').classList.add('show');
};

// ── ADD SCAN BUTTON TO HEADER ──

// ── PROXY ATTEMPT (experimental, non-blocking) ──
async function tryProxyFetch(query, storeName) {
  const storeMap = {'שופרסל':'shufersal','רמי לוי':'ramilevi'};
  const storeId = storeMap[storeName];
  if (!storeId) return null;
  try {
    const res = await fetch(
      `/api/proxy-prices?q=${encodeURIComponent(query)}&store=${storeId}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.ok && data?.data?.results?.[0]?.price) {
      return { price: data.data.results[0].price, source: 'proxy' };
    }
  } catch (_) {}
  return null;
}




// ══════════════════════════════════════════════════════════════
// PRICE PRIORITY SYSTEM v3.0
//
// Priority (deterministic, per barcode+chain):
//   A. userPriceOverrides/{userId}/{barcode}/{key}     personal only
//   B. prices/{barcode}/{chainId_storeId}              official XML  ← primary source of truth
//   C. proxyCache/{barcode}/{chainKey}                 proxy TTL 1h  only if no official
//   D. manualPrices/{groupId}/{barcode}/{entryId}      family-scoped only if no B/C
//   E. priceReports → warning signal only, never real price
//
// Badges: ✅ רשמי | ✏️ תיקון אישי | ⚡ חי | 📝 משפחה | 🚨 אזהרה
// ══════════════════════════════════════════════════════════════

// STORE_LIST_ALL defined above

// ── Validation ──
// Strict EAN-8 / UPC-A / EAN-13 / ITF-14 barcode validation (matches api/_firebase.js)
function isValidBarcode(b) {
  const s = String(b || '').replace(/\D/g, '');
  if (!/^(?:8|12|13|14)$/.test(String(s.length))) return false;
  if (/^0+$/.test(s)) return false;
  return true;
}
function isValidPrice(p)   { const n=parseFloat(p); return !isNaN(n)&&n>0&&n<10000; }
function sanitize(s,max=200) { return String(s||'').trim().replace(/[<>]/g,'').substring(0,max); }
/**
 * Phone number sanitizer — allowlist: digits, +, -, spaces, parentheses.
 * Returns null for anything that fails E.164 digit-count rules (7–15 digits).
 * Prevents tel: URI injection if Firebase phone field contains crafted values.
 */
function sanitizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw.replace(/[^\d+\-\s()]/g, '').trim();
  const digits   = stripped.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return stripped;
}
/** Race a Firebase promise against a timeout. Returns { isTimeout: true } on expiry. */
function withClientTimeout(promise, ms, label = '') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`timeout:${label}`), { isTimeout: true })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── SOURCE BADGE ──
function sourceBadge(source, submittedBy) {
  if (source==='official')     return '<span class="badge-official">✅ רשמי</span>';
  if (source==='user_override') return '<span class="badge-override">✏️ תיקון אישי</span>';
  if (source==='proxy')        return '<span class="badge-proxy">⚡ חי</span>';
  if (source==='manual')       return `<span class="badge-manual">📝 ${esc(submittedBy||'משפחה')}</span>`;
  return '<span class="badge-none">אין מחיר</span>';
}

// ── FETCH ALL PRICE LAYERS ──
async function fetchAllPriceLayers(barcode) {
  if (!db || !isValidBarcode(barcode)) return { official:[], proxy:[], manual:[], overrides:{}, reports:{} };
  console.log(`[prices] fetching layers for ${barcode}`);

  const tasks = {
    official: get(ref(db, `prices/${barcode}`)),
    proxy:    get(ref(db, `proxyCache/${barcode}`)),
    reports:  get(ref(db, `priceReports/${barcode}`)),
    overrides: myId ? get(ref(db, `userPriceOverrides/${myId}/${barcode}`)) : Promise.resolve(null),
    manual:    groupId ? get(ref(db, `manualPrices/${groupId}/${barcode}`)) : Promise.resolve(null),
  };

  const snaps = {};
  await Promise.all(Object.entries(tasks).map(async ([k,p]) => {
    try { snaps[k] = await p; } catch (e) { console.warn(`[prices] ${k} fetch failed:`, e.message); snaps[k] = null; }
  }));

  const now = Date.now();
  const overrides = snaps.overrides?.exists() ? snaps.overrides.val() : {};

  // B. Official XML
  const official = snaps.official?.exists()
    ? Object.entries(snaps.official.val())
        .filter(([,p]) => p?.price > 0)
        .map(([key,p]) => ({
          ...p, _key: key, source: 'official',
          displayPrice: overrides[key]?.overridePrice ?? p.price,
          override: overrides[key] || null,
          sourceDisplay: overrides[key] ? 'user_override' : 'official',
        }))
        .sort((a,b) => a.displayPrice - b.displayPrice)
    : [];

  // C. Proxy (TTL 1h) — only used when no official
  const proxy = snaps.proxy?.exists()
    ? Object.values(snaps.proxy.val())
        .filter(p => p?.price>0 && (now-(p.fetchedAt||0))<3_600_000)
        .map(p => ({ ...p, source:'proxy', displayPrice:p.price, sourceDisplay:'proxy' }))
    : [];

  // D. Manual family prices — latest per chain
  const manualRaw = snaps.manual?.exists()
    ? Object.values(snaps.manual.val()).filter(p=>p?.price>0).map(p=>({...p,source:'manual',displayPrice:p.price,sourceDisplay:'manual'}))
    : [];
  const manualByChain = {};
  manualRaw.forEach(p => {
    const k = p.chainName||p.storeName||'';
    if (!manualByChain[k]||new Date(p.submittedAt)>new Date(manualByChain[k].submittedAt)) manualByChain[k]=p;
  });
  const manual = Object.values(manualByChain);

  // E. Reports (warning only)
  const reports = snaps.reports?.exists() ? snaps.reports.val() : {};

  return { official, proxy, manual, overrides, reports };
}

// ── BUILD DISPLAY PRICES (deterministic priority) ──
function buildDisplayPrices(layers) {
  const { official, proxy, manual, reports } = layers;

  // De-duplicate official prices by sub-brand (storeName).
  // Shufersal alone may have 422 raw entries; de-duping keeps one entry per
  // unique sub-brand name (e.g. "שופרסל דיל", "שופרסל שלי") — cheapest wins.
  // Fallback key: chainName_storeId (when storeName is absent).
  const storeNameMap = {};
  official.forEach(p => {
    const k = (p.storeName && p.storeName !== p.chainName)
      ? p.storeName
      : `${p.chainName || ''}_${p.storeId || ''}`;
    if (!storeNameMap[k] || p.displayPrice < storeNameMap[k].displayPrice) {
      storeNameMap[k] = p;
    }
  });
  const officialDeduped = Object.values(storeNameMap);

  // Start with official (highest priority)
  const result = [...officialDeduped];
  const coveredChains = new Set(officialDeduped.map(p => p.chainName||p.chainId||''));

  // Add proxy only for chains without official
  proxy.filter(p => !coveredChains.has(p.chainName||p.chainId||'')).forEach(p => {
    result.push(p);
    coveredChains.add(p.chainName||p.chainId||'');
  });

  // Add manual only for chains without official or proxy
  manual.filter(p => !coveredChains.has(p.chainName||p.storeName||'')).forEach(p => result.push(p));

  // Sort: cheapest first, deterministic tie-breakers (distance, then store key)
  // so equal prices never reshuffle between renders / pagination pages.
  result.sort((a,b) => {
    const pa = a.displayPrice ?? a.price ?? Infinity;
    const pb = b.displayPrice ?? b.price ?? Infinity;
    if (pa !== pb) return pa - pb;
    const da = a.distanceKm ?? Infinity, db = b.distanceKm ?? Infinity;
    if (da !== db) return da - db;
    const ka = `${a.chainId||''}_${a.storeId||''}`, kb = `${b.chainId||''}_${b.storeId||''}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Attach community warnings (reports only as signal, never as price)
  const warnings = buildCommunityWarnings(reports, official);

  return { prices: result, warnings };
}

function buildCommunityWarnings(reports, official) {
  const warnings = [];
  const thirtyDaysAgo = Date.now() - 30*24*3600*1000;
  Object.entries(reports).forEach(([chainKey, chainReports]) => {
    if (!chainReports) return;
    const recent = Object.values(chainReports)
      .filter(r => r?.reportedAt && new Date(r.reportedAt).getTime() > thirtyDaysAgo);
    if (recent.length < 2) return;
    const prices = recent.map(r=>r.reportedPrice).filter(isValidPrice);
    if (!prices.length) return;
    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const offMatch = official.find(p => `${p.chainId||''}_${p.storeId||''}` === chainKey);
    warnings.push({
      chainKey,
      chainName: offMatch?.chainName || '',
      officialPrice: offMatch?.price,
      reportCount: recent.length,
      reportedMin: minP,
      reportedMax: maxP,
    });
  });
  return warnings;
}

// ── RENDER PRICE ROW ──
function renderPriceRow(p, isFirst, total, warnings) {
  // Use storeName (sub-brand) when it differs from chainName for clearer display
  const chainDisplay = p.chainName || p.chainId || '';
  const store = (p.storeName && p.storeName !== p.chainName && p.storeName !== p.chainId)
    ? p.storeName
    : chainDisplay || p.storeName || p.store || '';
  const chainKey = `${p.chainId||chainDisplay.replace(/\s/g,'_')}_${p.storeId||'0'}`;
  const isBest = isFirst && total > 1;
  const badge = sourceBadge(p.sourceDisplay||p.source, p.submittedByDisplayName);

  let submittedLine = '';
  if ((p.source==='manual'||p.sourceDisplay==='manual') && p.submittedByDisplayName) {
    const av = p.submittedByAvatarValue||'👤';
    submittedLine = `<div class="submitted-by"><div class="submitted-av">${av}</div><span>${esc(p.submittedByDisplayName)}</span></div>`;
  }

  let overrideLine = '';
  if (p.override) {
    overrideLine = `<div style="font-size:10px;color:var(--muted);margin-top:1px">
      <span class="spr-official-struck">₪${p.price.toFixed(2)}</span>
      <span style="color:var(--blue)"> → ₪${p.displayPrice.toFixed(2)} (תיקון אישי)</span>
      <button onclick="event.stopPropagation();removeOverride('${chainKey}','${esc(store)}')"
        style="background:transparent;border:none;color:var(--red);cursor:pointer;font-size:10px;margin-right:6px">✕ בטל</button>
    </div>`;
  }

  // Community warning (reports signal)
  const warn = warnings?.find(w => w.chainKey===chainKey);
  let warnLine = '';
  if (warn) {
    warnLine = `<div class="community-warning">
      ⚠️ <strong>${warn.reportCount} משתמשים</strong> דיווחו: ₪${warn.reportedMin.toFixed(2)}${warn.reportedMin!==warn.reportedMax?`–₪${warn.reportedMax.toFixed(2)}`:''}
    </div>`;
  }

  // Action buttons — only for official/override. stopPropagation so tapping a
  // button does NOT also trigger the row's store-detail click.
  let actions = '';
  if (p.source==='official'||p.source==='user_override') {
    const pname = sanitize(_currentScanProduct?.name||selectedProduct?.name||'');
    actions = `<div class="override-actions">
      <button class="override-btn primary" onclick="event.stopPropagation();openOverrideModal('${chainKey}','${esc(store)}','${p.price}','${esc(pname)}')">✏️ תקן אישי</button>
      <button class="override-btn" onclick="event.stopPropagation();openReportModal('${chainKey}','${esc(store)}','${p.price}','${esc(pname)}')">🚨 דווח שגיאה</button>
    </div>`;
  }

  // City + distance meta line
  const metaParts = [];
  if (p.city) metaParts.push(esc(p.city));
  if (p.distanceKm != null) metaParts.push(`📍 ${p.distanceKm} ק"מ`);
  const metaLine = metaParts.length
    ? `<div style="font-size:10px;color:var(--muted);margin-top:1px">${metaParts.join(' · ')}</div>`
    : '';

  // Freshness badge — only flag stale rows (fresh rows are silent = default)
  const staleBadge = p.isStale
    ? `<span style="font-size:9px;color:var(--red);background:rgba(248,113,113,.1);padding:1px 5px;border-radius:4px">⚠ ישן</span>`
    : '';

  // Cache row data for the store-detail panel (safe index reference, no inline
  // JSON) so the row is tappable → opens existing openStoreDetail.
  const _sdIdx = (window._sdRows = window._sdRows || []).length;
  window._sdRows.push({
    chainName: p.chainName || p.chainId || '', chainId: p.chainId || '',
    storeId: p.storeId || '', storeName: p.storeName || '',
    city: p.city || '', address: p.address || '',
    distanceKm: p.distanceKm ?? null,
    latitude: p.latitude ?? null, longitude: p.longitude ?? null,
    approximateLocation: p.approximateLocation || false,
    openingHours: p.openingHours || null,
    price: p.displayPrice ?? p.price ?? null,
    unit: p.unit || '', quantity: p.quantity || '',
    syncedAt: p.syncedAt || p.lastUpdated || null,
  });

  return `<div class="spr${isBest?' best':''}" style="cursor:pointer"
      onclick="openStoreDetail(window._sdRows[${_sdIdx}])">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
        <span class="spr-name">${esc(store)}</span> ${badge} ${staleBadge}
        ${isBest&&total>1?'<span class="best-badge">הכי זול 🏆</span>':''}
      </div>
      ${metaLine}${submittedLine}${overrideLine}${warnLine}${actions}
    </div>
    <span class="spr-price" style="flex-shrink:0;margin-right:8px">₪${p.displayPrice.toFixed(2)}</span>
  </div>`;
}

// ── showProductPricesEnhanced ──
window.showProductPricesEnhanced = async function(product) {
  if (!product) return;
  const mySeq = ++_pdSeq;                         // request-identity guard
  const wrap = document.getElementById('price-content');
  const barcode = product.barcode || '';

  // No barcode → this product was never linked to the catalog. Do NOT claim
  // "no prices" — say so honestly and offer to link a product / add manually.
  if (!isValidBarcode(barcode)) {
    wrap.innerHTML = `
      <button onclick="backToResults()" style="background:transparent;border:none;color:var(--muted);font-family:'Rubik',sans-serif;font-size:13px;font-weight:600;cursor:pointer;padding:4px 0 10px">← חזרה</button>
      <div class="compare-card" style="text-align:center;padding:24px 16px">
        <div style="font-size:34px;margin-bottom:8px">🔗</div>
        <div style="font-size:15px;font-weight:800;margin-bottom:6px">${esc(product.name||'המוצר')} לא מקושר לברקוד עדיין</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:16px">
          כדי להשוות מחירים צריך לקשר מוצר ספציפי מהקטלוג (עם ברקוד).
        </div>
        <button class="mbtn primary" style="width:100%"
          onclick="openBrandPicker('new')">🔍 בחר מוצר</button>
      </div>`;
    return;
  }

  wrap.innerHTML = `<div class="price-loading"><div class="spin"></div><p>בודק מחירים...</p></div>`;

  let layers = { official:[], proxy:[], manual:[], overrides:{}, reports:{} };
  try {
    layers = await fetchAllPriceLayers(barcode);
  } catch (e) {
    if (mySeq !== _pdSeq) return;
    wrap.innerHTML = `<div class="search-hint"><div class="sh-icon">⏳</div>
      <p>טעינת המחירים נכשלה</p><small>בדוק חיבור ונסה שוב</small>
      <button class="nnr-btn primary" style="margin-top:12px"
        onclick="showProductPricesEnhanced(selectedProduct)">🔄 נסה שוב</button></div>`;
    return;
  }
  if (mySeq !== _pdSeq) return;                   // a newer view superseded this one

  const { prices, warnings } = buildDisplayPrices(layers);

  // ── Radius mode (Option B) ────────────────────────────────────────────────
  // Price records carry no coordinates, so when a location is selected we ask
  // the API (which joins store coords server-side) for distances, then keep
  // only NEARBY stores in the main list and surface the cheapest out-of-radius
  // option in a separate card. Any failure → fall back to the full list.
  let displayRows = prices, outsideCard = null, noLocationHint = false, radiusActive = false;
  if (_hasLoc()) {
    const apiRows = await _fetchPricesWithDistance(barcode);
    if (mySeq !== _pdSeq) return;                 // superseded during await
    if (apiRows && apiRows.length) {
      const part  = _partitionByRadius(apiRows, _nearbyRadius);
      displayRows = part.nearby;                  // outside + unknown excluded
      outsideCard = part.showOutsideCard ? part.cheapestOutside : null;
      radiusActive = true;
    }
  } else {
    noLocationHint = true;                         // Part 2: prompt to set location
  }

  const coveredChains = new Set(displayRows.map(p=>p.chainName||p.storeName||p.store||''));
  const missing = STORE_LIST_ALL.filter(s=>!coveredChains.has(s));

  // Price spread header — shows ₪min → ₪max + potential saving
  const minP = displayRows.length ? displayRows[0].displayPrice : null;
  const maxP = displayRows.length ? displayRows[displayRows.length-1].displayPrice : null;
  const spreadHTML = (displayRows.length > 1 && maxP > minP) ? `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--card2);border-radius:10px;margin-bottom:10px;flex-wrap:wrap">
      <span style="font-size:13px;font-weight:900;color:var(--green)">₪${minP.toFixed(2)}</span>
      <span style="color:var(--muted);font-size:13px">→</span>
      <span style="font-size:13px;font-weight:900;color:var(--red)">₪${maxP.toFixed(2)}</span>
      <span style="font-size:11px;color:var(--muted);margin-right:auto">
        חיסכון עד <strong style="color:var(--accent)">₪${(maxP-minP).toFixed(2)}</strong>
      </span>
    </div>` : '';

  // Store full sorted set for pagination; reset to page 1 on every product view.
  _spdPrices     = displayRows;
  _spdWarnings   = warnings;
  _spdSpreadHTML = spreadHTML;
  _spdPage       = 1;

  // Location hint (Part 2) — shown when no location/radius is set.
  const locationHintHTML = noLocationHint ? `
    <div style="background:var(--card2);border:1px solid var(--border);border-radius:10px;
      padding:9px 12px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5">
      📍 הגדר מיקום ורדיוס כדי להשוות חנויות קרובות אליך.
    </div>` : '';

  // Cheapest-outside-area card (Part 3) — separate, never in the nearby list/count.
  const outsideCardHTML = outsideCard ? (() => {
    const oName = (outsideCard.storeName && outsideCard.storeName !== outsideCard.chainName)
      ? outsideCard.storeName : (outsideCard.chainName || '');
    const oCity = outsideCard.city ? ` · ${esc(outsideCard.city)}` : '';
    return `<div style="margin-top:12px;border:1.5px dashed var(--border);border-radius:13px;
        padding:12px;background:var(--card2)">
        <div style="font-size:11px;font-weight:800;color:var(--muted);margin-bottom:6px">
          ${displayRows.length ? '🔭 הזול ביותר מחוץ לאזור שלך' : `אין מחירים בטווח ${_nearbyRadius} ק"מ · הזול ביותר מחוץ לאזור:`}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:15px;font-weight:900;color:var(--accent)">₪${(outsideCard.displayPrice ?? outsideCard.price).toFixed(2)}</span>
          <span style="font-size:13px;font-weight:700">${esc(oName)}${oCity}</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px">
          ${outsideCard.distanceKm != null ? `${outsideCard.distanceKm} ק"מ ממך — מחוץ לרדיוס ${_nearbyRadius} ק"מ` : 'מחוץ לאזור הנבחר'}
        </div>
      </div>`;
  })() : '';

  window._sdRows = [];   // reset row cache before rendering (indices align with renderPriceRow pushes)
  const firstPage = displayRows.slice(0, SPD_PAGE);
  const emptyMsg = radiusActive
    ? `אין מחירים בטווח ${_nearbyRadius} ק"מ`
    : 'עדיין אין מחיר למוצר הזה';
  const pricesHTML = displayRows.length
    ? spreadHTML + firstPage.map((p,i)=>renderPriceRow(p,i===0,displayRows.length,warnings)).join('')
    : `<div style="text-align:center;padding:18px 14px;background:var(--accent-dim);
         border:1.5px dashed rgba(22,163,74,.35);border-radius:13px">
         <div style="font-size:30px;margin-bottom:8px">🏷️</div>
         <div style="font-size:14px;font-weight:800;margin-bottom:5px">${emptyMsg}</div>
         <div style="font-size:12px;color:var(--muted);line-height:1.6">
           ${radiusActive ? 'הגדל את הרדיוס או' : 'ראית את המחיר בסופר?'}<br>הוסף מחיר למטה ועזור למשפחה לחסוך 👇
         </div>
       </div>`;

  const missingHTML = missing.length ? `
    <div style="margin-top:10px">
      <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px">📝 הכנס מחיר ידנית:</div>
      ${missing.map(s=>`<div class="spr no-data">
        <span class="spr-name" style="flex-shrink:0">${s} <span class="badge-none">אין מחיר</span></span>
        <span style="display:flex;align-items:center;gap:5px;direction:ltr">
          <span class="ps-currency">₪</span>
          <input type="number" id="mp-${s.replace(/\s/g,'_')}" placeholder="0.00" step="0.01" min="0" class="ps-input">
          <button onclick="saveSingleManualPrice('${s}','mp-${s.replace(/\s/g,'_')}','${barcode}','${esc(product.name||'')}')"
            style="background:var(--accent);color:#fff;border:none;border-radius:7px;padding:4px 10px;font-family:'Rubik',sans-serif;font-size:11px;font-weight:700;cursor:pointer">שמור</button>
        </span>
      </div>`).join('')}
    </div>` : '';

  const savings = (minP && maxP && maxP > minP) ? (maxP - minP).toFixed(2) : null;

  wrap.innerHTML = `
    <button onclick="backToResults()" style="background:transparent;border:none;color:var(--muted);font-family:'Rubik',sans-serif;font-size:13px;font-weight:600;cursor:pointer;padding:4px 0 10px;display:flex;align-items:center;gap:4px">← חזרה לתוצאות</button>
    <div class="compare-card">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
        ${product.image?`<img class="product-img" src="${esc(product.image)}" loading="lazy" onerror="this.style.display='none'">`:
          `<div class="product-img-placeholder">🛍</div>`}
        <div>
          <div style="font-size:14px;font-weight:700">${esc(product.name||'')}</div>
          ${product.brand?`<div style="font-size:11px;color:var(--muted)">${esc(product.brand)}</div>`:''}
          ${product.size?`<div style="font-size:11px;color:var(--muted)">${esc(product.size)}</div>`:''}
          ${barcode?`<div style="font-size:10px;color:var(--muted)">🔖 ${esc(barcode)}</div>`:''}
        </div>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap">
        <span class="badge-official">✅ רשמי</span> XML ממשלתי &nbsp;
        <span class="badge-proxy">⚡ חי</span> Proxy &nbsp;
        <span class="badge-manual">📝</span> משפחה &nbsp;
        <span class="badge-override">✏️</span> תיקון אישי שלך
      </div>
      ${locationHintHTML}
      <div class="store-prices">${pricesHTML}</div>
      <div id="spd-more"></div>
      ${outsideCardHTML}
      ${missingHTML}
      ${barcode?`<button onclick="openScanner()" class="clear-btn" style="margin-top:10px">📷 סרוק בסופר ועדכן מחיר</button>`:''}
    </div>
    <div style="font-size:10px;color:var(--muted);text-align:center;padding:8px 0">
      ✏️ תיקון אישי גלוי רק לך · 🚨 דיווח מוצג לאחרי 2+ דיווחים · 📝 מחיר משפחה גלוי לקבוצה בלבד
    </div>`;

  _renderSpdMore();   // populate "show more 10" button + "showing X of N"
};

// ── Search-product store-list pagination helpers ──
function _renderSpdStoreRows() {
  const cont = document.querySelector('.store-prices');
  if (!cont) return;
  window._sdRows = [];   // reset so onclick indices match the re-rendered rows
  const shown = _spdPrices.slice(0, SPD_PAGE * _spdPage);
  cont.innerHTML = _spdSpreadHTML +
    shown.map((p,i) => renderPriceRow(p, i === 0, _spdPrices.length, _spdWarnings)).join('');
  _renderSpdMore();
}

function _renderSpdMore() {
  const el = document.getElementById('spd-more');
  if (!el) return;
  const total = _spdPrices.length;
  const shown = Math.min(SPD_PAGE * _spdPage, total);
  if (total <= SPD_PAGE || shown >= total) { el.innerHTML = ''; return; }
  const next = Math.min(SPD_PAGE, total - shown);
  el.innerHTML = `
    <div style="text-align:center;font-size:11px;color:var(--muted);margin:8px 0 6px">
      מציג ${shown} מתוך ${total}
    </div>
    <button class="clear-btn" style="margin-top:0" onclick="_spdShowMore()">⬇️ הצג עוד ${next}</button>`;
}

window._spdShowMore = function() {
  _spdPage++;
  _renderSpdStoreRows();   // re-renders the store-prices container in place (scroll preserved)
};

window.selectProduct = function(idx) {
  const groups = document.getElementById('price-content')._groups;
  if (!groups) return;
  selectedProduct = groups[idx];
  _currentScanProduct = selectedProduct;
  window.showProductPricesEnhanced(selectedProduct);
};

// ── SAVE SINGLE MANUAL PRICE ──
window.saveSingleManualPrice = async function(storeName, inputId, barcode, productName) {
  const val = parseFloat(document.getElementById(inputId)?.value);
  if (!isValidPrice(val)) { toast('⚠️ הכנס מחיר תקין'); return; }
  if (!isValidBarcode(barcode)) { toast('⚠️ ברקוד לא תקין'); return; }
  if (!groupId) { toast('⚠️ לא חובר לקבוצה'); return; }

  const m = myProfile || {};
  const entryId = `m_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  console.log(`[manual] saving ${barcode}/${storeName} ₪${val}`);

  try {
    // Save to manualPrices/{groupId}/{barcode} — NEVER to prices/
    await set(ref(db, `manualPrices/${groupId}/${barcode}/${entryId}`), {
      barcode, name: sanitize(productName),
      price: Math.round(val*100)/100,
      chainName: storeName, storeName,
      groupId,
      submittedByUserId:      myId,
      submittedByDisplayName: myName,
      submittedByAvatarType:  m.avatarType  || 'emoji',
      submittedByAvatarValue: m.avatarValue || '👤',
      submittedByAvatarEmoji: m.avatarEmoji || null,
      submittedAt: new Date().toISOString(),
      source: 'manual',
    });
    toast(`💰 ₪${val.toFixed(2)} ב${storeName} נשמר`);
    if (selectedProduct) window.showProductPricesEnhanced(selectedProduct);
  } catch(e) { console.error('[manual] error:', e.message); toast('❌ ' + e.message); }
};

// ── OVERRIDE SYSTEM ──
window.openOverrideModal = function(chainKey, storeName, officialPrice, productName) {
  _overrideContext = { chainKey, storeName, officialPrice: parseFloat(officialPrice), productName };
  document.getElementById('override-product-info').innerHTML =
    `<strong>${esc(storeName)}</strong> · מחיר רשמי: ₪${parseFloat(officialPrice).toFixed(2)}<br>
     <span style="font-size:11px;color:var(--muted)">${esc(productName)}</span>`;
  document.getElementById('override-price-input').value = '';
  document.getElementById('override-reason-input').value = '';
  document.getElementById('override-overlay').classList.add('show');
};

window.saveOverride = async function() {
  if (!_overrideContext) return;
  const { chainKey, storeName, officialPrice, productName } = _overrideContext;
  const price = parseFloat(document.getElementById('override-price-input').value);
  const reason = sanitize(document.getElementById('override-reason-input').value, 300);
  if (!isValidPrice(price)) { toast('⚠️ הכנס מחיר תקין'); return; }
  const barcode = _currentScanProduct?.barcode || selectedProduct?.barcode || '';
  if (!isValidBarcode(barcode)) { toast('⚠️ ברקוד חסר'); return; }
  const now = new Date().toISOString();
  console.log(`[override] ${barcode}/${chainKey} ₪${price}`);
  try {
    await set(ref(db, `userPriceOverrides/${myId}/${barcode}/${chainKey}`), {
      barcode, chainId: chainKey.split('_')[0]||'', chainName: storeName,
      storeId: chainKey.split('_')[1]||'', storeName,
      officialPrice, overridePrice: Math.round(price*100)/100,
      reason: reason||null, createdAt: now, updatedAt: now, source: 'user_override',
    });
    closeOL2('override-overlay');
    toast(`✏️ תיקון אישי נשמר ב${storeName}`);
    if (selectedProduct) window.showProductPricesEnhanced(selectedProduct);
  } catch(e) { console.error('[override]', e.message); toast('❌ '+e.message); }
};

window.removeOverride = async function(chainKey, storeName) {
  const barcode = _currentScanProduct?.barcode || selectedProduct?.barcode || '';
  if (!barcode) return;
  try {
    await remove(ref(db, `userPriceOverrides/${myId}/${barcode}/${chainKey}`));
    toast(`↩️ חזרת למחיר הרשמי ב${storeName}`);
    if (selectedProduct) window.showProductPricesEnhanced(selectedProduct);
  } catch(e) { toast('❌ '+e.message); }
};

// ── REPORT SYSTEM ──
window.openReportModal = function(chainKey, storeName, officialPrice, productName) {
  _reportContext = { chainKey, storeName, officialPrice: parseFloat(officialPrice), productName };
  document.getElementById('report-product-info').innerHTML =
    `<strong>${esc(storeName)}</strong> · מחיר רשמי: ₪${parseFloat(officialPrice).toFixed(2)}<br>
     <span style="font-size:11px;color:var(--muted)">${esc(productName)}</span>`;
  document.getElementById('report-price-input').value = '';
  document.getElementById('report-note-input').value = '';
  document.getElementById('report-overlay').classList.add('show');
};

window.submitReport = async function() {
  if (!_reportContext) return;
  const { chainKey, storeName, officialPrice } = _reportContext;
  const price = parseFloat(document.getElementById('report-price-input').value);
  const note  = sanitize(document.getElementById('report-note-input').value, 300);
  if (!isValidPrice(price)) { toast('⚠️ הכנס מחיר שראיתי'); return; }
  const barcode = _currentScanProduct?.barcode || selectedProduct?.barcode || '';
  if (!isValidBarcode(barcode)) { toast('⚠️ ברקוד חסר'); return; }
  const m = myProfile || {};
  const rid = `r_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  console.log(`[report] ${barcode}/${chainKey} ₪${price}`);
  try {
    await set(ref(db, `priceReports/${barcode}/${chainKey}/${rid}`), {
      barcode, chainId: chainKey.split('_')[0]||'', chainName: storeName,
      storeId: chainKey.split('_')[1]||'', storeName,
      officialPrice, reportedPrice: Math.round(price*100)/100,
      reportedByUserId: myId, reportedByDisplayName: myName,
      reportedAt: new Date().toISOString(),
      note: note||null, evidenceType: 'user_report', status: 'pending',
    });
    closeOL2('report-overlay');
    toast('📢 תודה! הדיווח נשמר');
    if (selectedProduct) window.showProductPricesEnhanced(selectedProduct);
  } catch(e) { console.error('[report]', e.message); toast('❌ '+e.message); }
};

// ── BARCODE SCANNER ──
window.openScanner = async function() {
  document.getElementById('scanner-overlay').classList.add('show');
  const hint = document.getElementById('scanner-hint');
  document.getElementById('scanner-barcode-input').value = '';
  try {
    _scannerStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' } });
    document.getElementById('scanner-video').srcObject = _scannerStream;
    if ('BarcodeDetector' in window) {
      _barcodeDetector = new BarcodeDetector({ formats:['ean_13','ean_8','code_128','upc_a'] });
      const video = document.getElementById('scanner-video');
      _scanTimer = setInterval(async () => {
        if (video.readyState < 2) return;
        try {
          const codes = await _barcodeDetector.detect(video);
          if (codes.length > 0) { closeScanner(); await handleBarcodeScanned(codes[0].rawValue); }
        } catch(_){}
      }, 250);
      hint.textContent = '📷 כוון את הברקוד למסגרת';
    } else {
      hint.textContent = '⌨️ הכנס ברקוד ידנית למטה';
    }
  } catch(e) {
    hint.textContent = '❌ אין גישה למצלמה — הכנס ברקוד ידנית';
  }
};

window.closeScanner = function() {
  document.getElementById('scanner-overlay').classList.remove('show');
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
  if (_scannerStream) { _scannerStream.getTracks().forEach(t=>t.stop()); _scannerStream=null; }
};

window.submitManualBarcode = async function() {
  const val = document.getElementById('scanner-barcode-input').value.trim();
  if (!isValidBarcode(val)) { toast('⚠️ הכנס ברקוד תקין'); return; }
  closeScanner();
  await handleBarcodeScanned(val);
};

async function handleBarcodeScanned(barcode) {
  toast(`🔍 מחפש ברקוד ${barcode}...`);
  let product = { barcode, name: barcode, brand:'', size:'', image:'' };
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`,
      { headers:{'User-Agent':'FamilyShoppingIL/3.0'}, signal:AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d.status===1&&d.product) {
      const p = d.product;
      product = { barcode, name:p.product_name_he||p.product_name||barcode,
        brand:p.brands||'', size:p.quantity||'', image:p.image_small_url||'' };
    }
  } catch(_){}

  const layers = await fetchAllPriceLayers(barcode);
  _currentScanProduct = product;
  selectedProduct = product;

  // Open price submit with existing data
  openPriceSubmitModal(product, layers);
}

function openPriceSubmitModal(product, layers) {
  const { official, manual } = layers;
  const info = document.getElementById('ps-product-info');
  info.innerHTML = `
    ${product.image
      ?`<img src="${esc(product.image)}" style="width:52px;height:52px;border-radius:10px;object-fit:contain;background:white;padding:3px;flex-shrink:0" onerror="this.style.display='none'">`
      :`<div style="width:52px;height:52px;border-radius:10px;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0">🛍</div>`}
    <div>
      <div style="font-size:14px;font-weight:700">${esc(product.name)}</div>
      ${product.brand?`<div style="font-size:11px;color:var(--muted)">${esc(product.brand)}</div>`:''}
      <div style="font-size:10px;color:var(--muted)">🔖 ${esc(product.barcode)}</div>
    </div>`;

  const note = document.getElementById('ps-official-note');
  if (official.length > 0) {
    note.style.display='block';
    note.innerHTML=`✅ מחיר רשמי קיים: ₪${official[0].price.toFixed(2)} — הכנסתך תסומן "ידני" ולא תחליף את הרשמי`;
  } else { note.style.display='none'; }

  const officialChains = new Set(official.map(p=>p.chainName||p.chainId||''));
  document.getElementById('ps-store-inputs').innerHTML = STORE_LIST_ALL.map(store => {
    const off = official.find(p=>(p.chainName||p.chainId||'')===store);
    const man = manual.find(p=>(p.chainName||p.storeName||'')===store);
    const existing = man?.price;
    return `<div class="ps-store-row">
      <div>
        <div class="ps-store-name">${store}</div>
        ${off?`<div style="font-size:9px;color:var(--green)">✅ רשמי: ₪${off.price.toFixed(2)}</div>`:''}
        ${!off&&man?`<div style="font-size:9px;color:var(--accent)">📝 ₪${man.price.toFixed(2)} (${esc(man.submittedByDisplayName||'משפחה')})</div>`:''}
      </div>
      <div class="ps-input-wrap">
        <span class="ps-currency">₪</span>
        <input class="ps-input" id="ps-${store.replace(/\s/g,'_')}"
          type="number" placeholder="0.00" step="0.01" min="0"
          value="${existing?existing.toFixed(2):''}">
      </div>
    </div>`;
  }).join('');

  document.getElementById('price-submit-overlay').classList.add('show');
}

window.submitManualPrices = async function() {
  if (!_currentScanProduct) return;
  const { barcode, name } = _currentScanProduct;
  if (!isValidBarcode(barcode)) { toast('⚠️ ברקוד לא תקין'); return; }
  if (!groupId) { toast('⚠️ לא חובר לקבוצה'); return; }

  const m = myProfile || {};
  let count = 0;

  for (const store of STORE_LIST_ALL) {
    const input = document.getElementById(`ps-${store.replace(/\s/g,'_')}`);
    const val = parseFloat(input?.value);
    if (!isValidPrice(val)) continue;
    const entryId = `m_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    try {
      // ALWAYS to manualPrices/{groupId}/... NEVER to prices/
      await set(ref(db, `manualPrices/${groupId}/${barcode}/${entryId}`), {
        barcode, name: sanitize(name),
        price: Math.round(val*100)/100,
        chainName: store, storeName: store, groupId,
        submittedByUserId:      myId,
        submittedByDisplayName: myName,
        submittedByAvatarType:  m.avatarType  || 'emoji',
        submittedByAvatarValue: m.avatarValue || '👤',
        submittedByAvatarEmoji: m.avatarEmoji || null,
        submittedAt: new Date().toISOString(),
        source: 'manual',
      });
      count++;
    } catch(e) { console.error('[manual]', e.message); }
  }

  if (!count) { toast('⚠️ הכנס לפחות מחיר אחד'); return; }
  closeOL2('price-submit-overlay');
  toast(`✅ ${count} מחירים ידניים נשמרו לקבוצה`);
  logActivity('manual_price_added', barcode, name);
  if (curTab==='price') renderPrices();
};

// ── PROXY (experimental, non-blocking) ──
async function tryProxy(query, chainName) {
  const map = {'שופרסל':'shufersal','רמי לוי':'ramilevi'};
  const storeId = map[chainName];
  if (!storeId) return null;
  try {
    const r = await fetch(`/api/proxy-prices?q=${encodeURIComponent(query)}&store=${storeId}`,
      { signal:AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d.ok && d.results?.length ? d.results[0] : null;
  } catch(_) { return null; } // fail silently
}

// ── ADD SCAN BUTTON → price toolbar (keeps main header clean) ──
function addScanButton() {
  if (document.getElementById('global-scan-btn')) return;
  const toolbar = document.getElementById('price-tools');
  if (!toolbar) return;
  const btn = document.createElement('button');
  btn.id = 'global-scan-btn'; btn.className = 'pt-btn'; btn.title = 'סרוק ברקוד';
  btn.innerHTML = '📷 סרוק'; btn.onclick = openScanner;
  toolbar.appendChild(btn);
}


// ══════════════════════════════════════════════════
// PROFILE EDIT SYSTEM
// ══════════════════════════════════════════════════

let _peAvatar = { type: 'emoji', value: '🛒', emoji: null }; // working copy during edit

// ── OPEN PROFILE EDIT MODAL ──
window.openProfileEdit = function() {
  const m = myProfile || {};

  // Pre-fill name
  const nameInput = document.getElementById('pe-name-input');
  nameInput.value = myName || '';
  document.getElementById('pe-name-preview').textContent = myName || 'שמך';

  // Pre-fill avatar
  _peAvatar = {
    type:  m.avatarType  || 'emoji',
    value: m.avatarValue || '🛒',
    emoji: m.avatarEmoji || null,
  };
  updatePeAvatarPreview();

  // Render grids
  renderPeEmojiGrid();
  renderPeCartoonGrid();

  // Switch to current tab
  switchAvTab(_peAvatar.type, null);

  // Close members modal first
  closeOL2('members-overlay');
  document.getElementById('profile-edit-overlay').classList.add('show');
};

// ── SWITCH AVATAR TAB ──
window.switchAvTab = function(type, clickedEl) {
  // Update tab styles
  document.querySelectorAll('.av-tab').forEach(t => t.classList.remove('active'));
  if (clickedEl) clickedEl.classList.add('active');
  else {
    // Activate by type
    const tabs = document.querySelectorAll('.av-tab');
    const map = { emoji: 0, cartoon: 1, photo: 2 };
    if (tabs[map[type]]) tabs[map[type]].classList.add('active');
  }
  // Show/hide panels
  document.getElementById('pe-emoji-panel').classList.toggle('show',   type === 'emoji');
  document.getElementById('pe-cartoon-panel').classList.toggle('show', type === 'cartoon');
  document.getElementById('pe-photo-panel').classList.toggle('show',   type === 'photo');
};

// ── RENDER EMOJI GRID ──
function renderPeEmojiGrid() {
  const grid = document.getElementById('pe-emoji-grid');
  if (!grid || grid.dataset.rendered) return;
  grid.innerHTML = EMOJIS.map(e =>
    `<button class="emoji-btn${_peAvatar.value===e&&_peAvatar.type==='emoji'?' sel':''}"
      onclick="pickPeEmoji('${e}')">${e}</button>`
  ).join('');
  grid.dataset.rendered = '1';
}

function renderPeCartoonGrid() {
  const grid = document.getElementById('pe-cartoon-grid');
  if (!grid || grid.dataset.rendered) return;
  grid.innerHTML = CARTOONS.map(c =>
    `<button class="cartoon-btn${_peAvatar.value===c.id&&_peAvatar.type==='cartoon'?' sel':''}"
      onclick="pickPeCartoon('${c.id}','${c.e}')">${c.e}</button>`
  ).join('');
  grid.dataset.rendered = '1';
}

window.pickPeEmoji = function(emoji) {
  _peAvatar = { type: 'emoji', value: emoji, emoji: null };
  updatePeAvatarPreview();
  document.querySelectorAll('#pe-emoji-grid .emoji-btn').forEach(b =>
    b.classList.toggle('sel', b.textContent === emoji));
};

window.pickPeCartoon = function(id, emoji) {
  _peAvatar = { type: 'cartoon', value: id, emoji };
  updatePeAvatarPreview();
  document.querySelectorAll('#pe-cartoon-grid .cartoon-btn').forEach(b =>
    b.classList.toggle('sel', b.textContent === emoji));
};

window.handleProfilePhotoEdit = async function(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('⚠️ תמונה גדולה מדי (מקס 5MB)'); return; }
  const dataUrl = await compressImage(file, 200);
  _peAvatar = { type: 'photo', value: dataUrl, isBlob: true, file };
  updatePeAvatarPreview();
  document.getElementById('pe-photo-preview').textContent = '✅ תמונה נטענה — לחץ "שמור" לאישור';
};

function updatePeAvatarPreview() {
  const wrap    = document.getElementById('pe-avatar-preview');
  const content = document.getElementById('pe-avatar-content');
  if (!wrap || !content) return;

  if (_peAvatar.type === 'photo' && _peAvatar.value) {
    const src = _peAvatar.value;
    content.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    const e = _peAvatar.type === 'cartoon' ? (_peAvatar.emoji || '🧑') : (_peAvatar.value || '🛒');
    content.innerHTML = `<span style="font-size:34px">${e}</span>`;
  }
}

// ── SAVE PROFILE EDIT ──
window.saveProfileEdit = async function() {
  const name = document.getElementById('pe-name-input').value.trim();
  if (!name) { toast('⚠️ הכנס שם תצוגה'); return; }

  let avatarValue = _peAvatar.value;
  let avatarType  = _peAvatar.type;
  let avatarEmoji = _peAvatar.emoji || null;

  // Upload photo if new blob (use already-compressed base64 → avoids re-reading file)
  if (avatarType === 'photo' && _peAvatar.isBlob && _peAvatar.value) {
    toast('⬆️ מעלה תמונה...');
    try {
      const _timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('upload timeout')), 15000));
      avatarValue = await Promise.race([uploadAvatarPhotoFromDataUrl(_peAvatar.value), _timeout]);
    } catch (e) {
      console.warn('[profile-edit] photo upload failed, using base64:', e.message);
      avatarValue = _peAvatar.value; // keep compressed base64 as fallback
      toast('📷 תמונה נשמרה מקומית');
    }
  }

  const updatedProfile = {
    displayName: name,
    avatarType,
    avatarValue,
    avatarEmoji,
  };

  // Update local state
  myName    = name;
  myProfile = { ...myProfile, ...updatedProfile };
  localStorage.setItem('fsl_profile', JSON.stringify(myProfile));

  // Validate: do not store blob: URLs or data: URLs in Firebase
  if (avatarType === 'photo' && avatarValue && avatarValue.startsWith('blob:')) {
    toast('⚠️ שגיאה בהעלאת תמונה — נסה שוב'); return;
  }

  // Update groups/{groupId}/members/{myId} — triggers onValue → re-render
  if (db && groupId && myId) {
    try {
      await update(ref(db, `groups/${groupId}/members/${myId}`), {
        userId:      myId,
        displayName: name,
        avatarType,
        avatarValue,
        avatarEmoji,
        role:      'member',
        updatedAt: Date.now(),
      });
      console.log('[profile-edit] Firebase member updated');
    } catch (e) {
      console.warn('[profile-edit] Firebase update failed:', e.message);
    }
  }

  // Also update users/{myId}/groups/{groupId} entry
  if (db && myId && groupId) {
    try {
      await update(ref(db, `users/${myId}/groups/${groupId}`), {
        groupName,
        role: 'member',
      });
    } catch (_) {}
  }

  // Update header avatar display
  updateHeaderAvatar();

  closeOL2('profile-edit-overlay');
  toast(`✅ פרופיל עודכן — שלום ${name}!`);

  // Re-render list to show updated attribution
  renderList();
};

// ── UPDATE HEADER AVATAR ──
function updateHeaderAvatar() {
  const hdrAv = document.getElementById('hdr-my-avatar');
  if (!hdrAv) return;
  const m = myProfile || {};
  if (m.avatarType === 'photo' && m.avatarValue) {
    hdrAv.innerHTML = `<img src="${m.avatarValue}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    const e = m.avatarType === 'cartoon' ? (m.avatarEmoji || '🧑') : (m.avatarValue || '👤');
    hdrAv.textContent = e;
  }
}


// ══════════════════════════════════════════════════
// FAVORITES SYSTEM v1.0
// Firebase path: favorites/{groupId}/{itemId}
// Source of truth: favorites collection only
// ══════════════════════════════════════════════════

// ── UTILS ──

// Collapse duplicate names — keeps the entry for the current session's UID,
// or the most-recently-updated entry when neither is the current session.
// After selecting the winner, merges "richer" profile fields from the loser
// so a stale default on the winner never silently downgrades role or avatar.
// Runs at render time; no Firebase writes.
function dedupMembers(list) {
  const seen = new Map(); // normalizedName → { winner, loser | null }

  for (const m of list) {
    const key = normalizeName(m.displayName || m.name || '');
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) { seen.set(key, { winner: m, loser: null }); continue; }

    const mTs    = m.updatedAt || m.joined || 0;
    const exTs   = existing.winner.updatedAt || existing.winner.joined || 0;
    const mIsMe  = (m.uid || m.id) === myId;
    const exIsMe = (existing.winner.uid || existing.winner.id) === myId;

    let winner, loser;
    if      (mIsMe)               { winner = m;               loser = existing.winner; }
    else if (exIsMe)              { winner = existing.winner; loser = m; }
    else if (mTs > exTs)          { winner = m;               loser = existing.winner; }
    else                          { winner = existing.winner; loser = m; }

    seen.set(key, { winner, loser });
  }

  return Array.from(seen.values()).map(({ winner, loser }) => {
    if (!loser) return winner;
    // Merge richer fields from loser so winner is never silently downgraded.
    const merged = { ...winner };
    // Role: admin outranks member — never strip admin
    if (loser.role === 'admin' && merged.role !== 'admin') merged.role = 'admin';
    if (loser.roles?.admin && !merged.roles?.admin)
      merged.roles = { ...(merged.roles || {}), admin: true };
    // Avatar: prefer non-default over default emoji '👤'
    const winnerIsDefault = !merged.avatarType || merged.avatarType === 'emoji' &&
                            (merged.avatarValue === '👤' || !merged.avatarValue);
    const loserIsRicher   = loser.avatarType && !(loser.avatarType === 'emoji' &&
                            (loser.avatarValue === '👤' || !loser.avatarValue));
    if (winnerIsDefault && loserIsRicher) {
      merged.avatarType  = loser.avatarType;
      merged.avatarValue = loser.avatarValue;
      merged.avatarEmoji = loser.avatarEmoji;
    }
    return merged;
  });
}

// Normalize name for duplicate detection
function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '') // strip Hebrew niqqud
    .replace(/\s+/g, '')
    .replace(/[^\w\u0590-\u05FF]/g, '');
}

// Check if an item name/barcode is already in favorites
function isItemInFavorites(name, barcode) {
  const norm = normalizeName(name);
  return Object.values(favorites).some(f =>
    (barcode && f.barcode && f.barcode === barcode) ||
    normalizeName(f.name) === norm
  );
}

// Check if an item name/barcode exists in the active shopping list
function isItemInActiveList(name, barcode) {
  const norm = normalizeName(name);
  return Object.values(items).some(i =>
    !i.bought && (
      (barcode && i.barcode && i.barcode === barcode) ||
      normalizeName(i.name) === norm
    )
  );
}

// Find existing shopping list item by name/barcode
function findExistingListItem(name, barcode) {
  const norm = normalizeName(name);
  const entry = Object.entries(items).find(([, i]) =>
    !i.bought && (
      (barcode && i.barcode && i.barcode === barcode) ||
      normalizeName(i.name) === norm
    )
  );
  return entry ? { id: entry[0], ...entry[1] } : null;
}

// ── TOGGLE SAVED FAVORITE (from shopping list item star button) ──
window.toggleSavedFavorite = async function(itemId, name, barcode) {
  if (!groupId) return;
  const alreadySaved = isItemInFavorites(name, barcode);
  _haptic(alreadySaved ? 12 : 18);

  if (alreadySaved) {
    // Remove from favorites — find its key
    const entry = Object.entries(favorites).find(([, f]) =>
      (barcode && f.barcode === barcode) ||
      normalizeName(f.name) === normalizeName(name)
    );
    if (entry) {
      try {
        await remove(ref(db, `favorites/${groupId}/${entry[0]}`));
        toast('☆ הוסר ממועדפים');
        console.log('[favorites] removed:', name);
      } catch (e) { toast('❌ ' + e.message); }
    }
  } else {
    // Add to favorites
    const item = items[itemId] || {};
    const favId = 'fav_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    try {
      await set(ref(db, `favorites/${groupId}/${favId}`), {
        itemId:         favId,
        name:           sanitize(name, 200),
        normalizedName: normalizeName(name),
        barcode:        barcode || null,
        defaultQty:     item.qty || 1,
        unit:           item.unit || null,
        category:       item.category || null,
        addedBy:        myId,
        addedByName:    myName,
        addedAt:        Date.now(),
        updatedAt:      Date.now(),
      });
      toast('⭐ נוסף למועדפים!');
      console.log('[favorites] saved:', name);
    } catch (e) { toast('❌ ' + e.message); }
  }
};

// ── ADD SINGLE FAVORITE TO SHOPPING LIST ──
window.addFavoriteToList = async function(favId) {
  const fav = favorites[favId];
  if (!fav || !groupId) return;

  // Duplicate detection — prefer increasing quantity
  const existing = findExistingListItem(fav.name, fav.barcode);

  if (existing) {
    // STRATEGY A: increase quantity
    const newQty = (existing.qty || 1) + (fav.defaultQty || 1);
    try {
      await update(ref(db, `groups/${groupId}/items/${existing.id}`), { qty: newQty });
      toast(`➕ כמות עודכנה: ${esc(fav.name)} × ${newQty}`);
      console.log('[favorites] qty increased:', fav.name, '->', newQty);
    } catch (e) { toast('❌ ' + e.message); }
    return;
  }

  // Add as new item
  const m = myProfile || {};
  const newRef = push(ref(db, `groups/${groupId}/items`));
  try {
    await set(newRef, {
      name:               fav.name,
      barcode:            fav.barcode || null,
      qty:                fav.defaultQty || 1,
      bought:             false,
      fav:                false,
      addedByUserId:      myId,
      addedByDisplayName: myName,
      addedByAvatarType:  m.avatarType  || 'emoji',
      addedByAvatarValue: m.avatarValue || '👤',
      addedByAvatarEmoji: m.avatarEmoji || null,
      addedAt:            Date.now(),
      ts:                 Date.now(),
    });
    toast(`✅ ${esc(fav.name)} נוסף לרשימה`);
    console.log('[favorites] added to list:', fav.name);

    // Switch to list tab to show the item
    window.setTab('all');
  } catch (e) { toast('❌ ' + e.message); }
};

// ── ADD ALL FAVORITES TO SHOPPING LIST ──
window.addAllFavoritesToList = async function() {
  const favList = Object.entries(favorites);
  if (!favList.length) return;

  const btn = document.getElementById('add-all-fav-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ מוסיף...'; }

  let added = 0, updated = 0;
  const m = myProfile || {};

  for (const [favId, fav] of favList) {
    const existing = findExistingListItem(fav.name, fav.barcode);
    if (existing) {
      // Increase quantity for already-in-list items
      const newQty = (existing.qty || 1) + (fav.defaultQty || 1);
      try {
        await update(ref(db, `groups/${groupId}/items/${existing.id}`), { qty: newQty });
        updated++;
      } catch (e) { console.warn('[favorites] qty update failed:', e.message); }
    } else {
      const newRef = push(ref(db, `groups/${groupId}/items`));
      try {
        await set(newRef, {
          name:               fav.name,
          barcode:            fav.barcode || null,
          qty:                fav.defaultQty || 1,
          bought:             false,
          fav:                false,
          addedByUserId:      myId,
          addedByDisplayName: myName,
          addedByAvatarType:  m.avatarType  || 'emoji',
          addedByAvatarValue: m.avatarValue || '👤',
          addedByAvatarEmoji: m.avatarEmoji || null,
          addedAt:            Date.now(),
          ts:                 Date.now(),
        });
        added++;
      } catch (e) { console.warn('[favorites] add failed:', e.message); }
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = '➕ הוסף הכל'; }

  const parts = [];
  if (added > 0)   parts.push(`✅ ${added} נוספו`);
  if (updated > 0) parts.push(`➕ ${updated} עודכנו`);
  toast(parts.join(' · ') || '✅ הכל ברשימה');

  console.log('[favorites] addAll:', { added, updated });

  // Switch to list
  window.setTab('all');
};

// ── REMOVE FROM FAVORITES ──
window.removeFavorite = async function(favId) {
  const fav = favorites[favId];
  if (!fav) return;
  try {
    await remove(ref(db, `favorites/${groupId}/${favId}`));
    toast('☆ הוסר ממועדפים');
    console.log('[favorites] removed:', fav.name);
  } catch (e) { toast('❌ ' + e.message); }
};

// ── CHANGE DEFAULT QTY OF FAVORITE ──
window.changeFavQty = function(favId, delta) {
  const fav = favorites[favId];
  if (!fav || !groupId) return;
  const newQty = Math.max(1, (fav.defaultQty || 1) + delta);
  update(ref(db, `favorites/${groupId}/${favId}`), { defaultQty: newQty })
    .catch(e => console.warn('[fav-qty] failed:', e.message));
};

// ── CLEAR ATTACHED PRODUCT FROM FAVORITE ──
window.clearFavProduct = function(favId, ev) {
  if (ev) ev.stopPropagation();
  if (!groupId) return;
  update(ref(db, `favorites/${groupId}/${favId}`), { attached: null })
    .catch(e => console.warn('[fav-clear] failed:', e.message));
};

// ── RENDER FAVORITES PANEL ──
function renderFavoritesPanel() {
  const wrap = document.getElementById('fav-list-content');
  const badge = document.getElementById('fav-count-badge');
  const addAllBtn = document.getElementById('add-all-fav-btn');
  if (!wrap) return;

  const favList = Object.entries(favorites)
    .map(([id, f]) => ({ ...f, _id: id }))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  // Update count badge
  if (badge) badge.textContent = favList.length ? `(${favList.length})` : '';

  // Enable/disable add-all button
  if (addAllBtn) addAllBtn.disabled = favList.length === 0;

  if (!favList.length) {
    wrap.innerHTML = `
      <div class="fav-empty">
        <div class="fav-em">⭐</div>
        <p>אין מועדפים עדיין<br>
          <span style="font-size:11px;opacity:.7">
            לחץ ☆ ליד פריט ברשימה כדי לשמור אותו כמועדף
          </span>
        </p>
      </div>`;
    return;
  }

  wrap.innerHTML = favList.map(fav => {
    const inList = isItemInActiveList(fav.name, fav.barcode);
    const qty    = fav.defaultQty || 1;
    const at     = fav.attached;

    // ip-tile — product attachment
    let ipTile;
    if (at && at.name) {
      const label   = esc(at.name.split(' ').slice(0, 3).join(' '));
      const iconHtml = at.image
        ? `<img class="ip-tile-img" src="${esc(at.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span class="ip-tile-icon" style="display:none">${_ipEmoji(fav.name)}</span>`
        : `<span class="ip-tile-icon">${_ipEmoji(fav.name)}</span>`;
      ipTile = `<div class="ip-tile-wrap">
        <button class="ip-tile has-product" onclick="openBrandPicker('fav-attach','${fav._id}','${encodeURIComponent(fav.name||'').replace(/'/g,'%27')}')" title="${label}">
          ${iconHtml}
          <span class="ip-tile-label">${label}</span>
        </button>
        <button class="ip-clear-btn" onclick="clearFavProduct('${fav._id}',event)" title="הסר מוצר">✕</button>
      </div>`;
    } else {
      ipTile = `<button class="ip-tile" onclick="openBrandPicker('fav-attach','${fav._id}','${encodeURIComponent(fav.name||'').replace(/'/g,'%27')}')" title="בחר מוצר ספציפי">
        <span class="ip-tile-icon">${_ipEmoji(fav.name)}</span>
        <span class="ip-tile-label" style="color:var(--muted)">בחר מוצר</span>
      </button>`;
    }

    return `
      <div class="fav-item-card${inList ? ' in-list' : ''}">
        ${ipTile}
        <div class="fav-item-body">
          <div class="fav-item-name">${esc(fav.name)}</div>
          <div class="qty-row">
            <button class="qty-btn" onclick="changeFavQty('${fav._id}',-1)">−</button>
            <span class="qty-num">${qty}</span>
            <button class="qty-btn" onclick="changeFavQty('${fav._id}',1)">+</button>
            ${inList ? `<span class="fav-in-list-badge">✅ ברשימה</span>` : ''}
          </div>
        </div>
        <div class="fav-actions">
          <button class="fav-add-btn${inList ? ' in-list' : ''}"
            onclick="addFavoriteToList('${fav._id}')"
            title="${inList ? 'הוסף עוד אחד' : 'הוסף לרשימה'}">
            ${inList ? '➕' : '+'}
          </button>
          <button class="fav-remove-btn"
            onclick="removeFavorite('${fav._id}')"
            title="הסר ממועדפים">
            ✕
          </button>
        </div>
      </div>`;
  }).join('');
}


// ══════════════════════════════════════════════════
// MULTI-GROUP SYSTEM v1.0
// Firebase: users/{userId}/groups/{groupId}
//           groups/{groupId}/members/{userId}
// ══════════════════════════════════════════════════

// Active Firebase listeners — stored so we can detach when switching groups
let _groupListeners = []; // array of unsubscribe functions

// My groups map: groupId → { groupId, groupName, role, joinedAt }
let myGroups = {};

// ── DETACH ALL GROUP LISTENERS ──
function detachGroupListeners() {
  _groupListeners.forEach(unsub => { try { unsub(); } catch(_) {} });
  _groupListeners = [];
  // Also stop notification listener for previous group
  stopNotificationListener();
  _allNotifications = {};
  updateNotifBadge();
  console.log('[multi-group] listeners detached');
}

// ── ATTACH GROUP LISTENERS (replaces connectToGroup body) ──
function attachGroupListeners() {
  detachGroupListeners();

  const unsubItems = onValue(ref(db, `groups/${groupId}/items`), snap => {
    items = snap.val() || {};
    renderList(); renderPrices(); updateCounts();
  });
  const unsubMembers = onValue(ref(db, `groups/${groupId}/members`), snap => {
    members = snap.val() || {};
    renderAvatars();
    renderList();      // ← live avatar update on all items
    renderProfile();   // ← update header avatar if own profile changed
    updateHeaderAvatar();
  });
  const unsubPrices = onValue(ref(db, `groups/${groupId}/prices`), snap => {
    prices = snap.val() || {};
    if (curTab === 'price') renderPrices();
  });
  const unsubFavs = onValue(ref(db, `favorites/${groupId}`), snap => {
    favorites = snap.val() || {};
    if (curTab === 'fav') renderFavoritesPanel();
    renderList();
    updateCounts();
  });
  const unsubMyGroups = onValue(ref(db, `users/${myId}/groups`), snap => {
    myGroups = snap.val() || {};
    renderGroupDropdown();
  });

  _groupListeners.push(unsubItems, unsubMembers, unsubPrices, unsubFavs, unsubMyGroups);
  console.log('[multi-group] listeners attached for', groupId);

  // Start notification listener for new group
  startGroupNotifications();
}

// ── SWITCH TO A DIFFERENT GROUP ──
window.switchGroup = async function(newGroupId) {
  if (newGroupId === groupId) { closeGroupDropdown(); return; }

  // Look up group name from myGroups or Firebase
  let newGroupName = myGroups[newGroupId]?.groupName || '';
  if (!newGroupName) {
    try {
      const snap = await get(ref(db, `groups/${newGroupId}/info`));
      if (snap.exists()) newGroupName = snap.val().name || newGroupId;
    } catch(_) { newGroupName = newGroupId; }
  }

  console.log('[multi-group] switching to', newGroupId, newGroupName);

  // Update state
  groupId   = newGroupId;
  groupName = newGroupName;
  items = {}; members = {}; prices = {}; favorites = {};

  // Persist active group
  localStorage.setItem('activeGroupId', groupId);
  saveLocal();

  // Update header
  document.getElementById('hdr-group-name').textContent = groupName;
  document.getElementById('hdr-group-code').textContent = groupId;
  if (document.getElementById('modal-code'))
    document.getElementById('modal-code').textContent = groupId;

  // Ensure we're in the members list for this group
  await ensureGroupMembership(newGroupId, newGroupName);

  // Reattach listeners
  attachGroupListeners();

  // Reset tab to list
  setTab('all');
  closeGroupDropdown();
  toast(`📂 עברת לקבוצה: ${groupName}`);
};

// ── ENSURE MEMBERSHIP in the group ──
async function ensureGroupMembership(gId, gName) {
  // ── 1. Always resolve the real Firebase UID first ──
  let fbUser;
  try { fbUser = await waitForAuthReady(); }
  catch(e) { console.error('[auth] ensureGroupMembership: waitForAuthReady failed:', e.message); return; }
  const realUid = fbUser.uid;

  // ── 2. Correct myId if it was set to a fake local UID before auth resolved ──
  if (myId !== realUid) {
    console.warn('[auth] myId mismatch — correcting', JSON.stringify(myId), '→', realUid);
    myId = realUid;
    saveLocal();
  }

  const m = myProfile || {};

  // ── 3. Write real UID to members (members.$uid rule allows self-write) ──
  try {
    await update(ref(db, `groups/${gId}/members/${realUid}`), {
      userId:      realUid,
      displayName: myName,
      avatarType:  m.avatarType  || 'emoji',
      avatarValue: m.avatarValue || '👤',
      avatarEmoji: m.avatarEmoji || null,
      role:        'member',
      updatedAt:   Date.now(),
    });
    _membershipOk = true;

    // ── 4. Detect stale fake u_* members (warn, don't auto-delete) ──
    get(ref(db, `groups/${gId}/members`)).then(snap => {
      if (!snap.exists()) return;
      const fakeKeys = Object.keys(snap.val()).filter(k => /^u_\d{10,}$/.test(k));
      if (fakeKeys.length) {
        console.warn('[auth] Recovered fake local UID membership — fake keys:', fakeKeys,
          '| real UID now registered:', realUid);
      }
    }).catch(() => {});
  } catch(e) {
    _membershipOk = false;
    console.warn('[multi-group] ensureMembership (members write) failed:', e.message);
    if ((e.message||'').includes('PERMISSION_DENIED')) {
      toast('⚠️ בעיית הרשאות — רענן את האפליקציה או פנה למנהל הקבוצה');
    }
    return; // don't attempt users write if members write failed
  }

  // ── 5. users/{uid}/groups — best-effort, separate try/catch ──
  //    (may fail if no Firebase rule — non-critical, does not affect group access)
  try {
    await set(ref(db, `users/${realUid}/groups/${gId}`), {
      groupId:   gId,
      groupName: gName,
      role:      'member',
      joinedAt:  Date.now(),
    });
  } catch(ue) {
    console.warn('[auth] users path write skipped (add "users" rule to Firebase if needed):', ue.message);
  }
}

// ── RENDER GROUP DROPDOWN ──
function renderGroupDropdown() {
  const list = document.getElementById('gdrop-list');
  if (!list) return;

  const groupList = Object.values(myGroups)
    .sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));

  if (!groupList.length) {
    list.innerHTML = `<div style="padding:8px 14px;font-size:12px;color:var(--muted)">
      אין קבוצות</div>`;
    return;
  }

  list.innerHTML = groupList.map(g => `
    <div class="gdrop-item${g.groupId === groupId ? ' active-group' : ''}"
      onclick="switchGroup('${g.groupId}')">
      <div class="gdrop-item-dot"></div>
      <div class="gdrop-item-name">${esc(g.groupName || g.groupId)}</div>
      <div class="gdrop-item-code">${g.groupId}</div>
    </div>`).join('');
}

// ── TOGGLE DROPDOWN ──
window.toggleGroupDropdown = function() {
  const dd    = document.getElementById('group-dropdown');
  const arrow = document.getElementById('gdrop-arrow');
  if (!dd) return;
  const isOpen = dd.classList.toggle('show');
  if (arrow) arrow.classList.toggle('open', isOpen);
  if (isOpen) {
    renderGroupDropdown();
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', closeGroupDropdownOnOutside, { once: true });
    }, 0);
  }
};

function closeGroupDropdownOnOutside(e) {
  const dd = document.getElementById('group-dropdown');
  const sw = document.getElementById('group-switcher');
  if (dd && !sw?.contains(e.target)) closeGroupDropdown();
}

function closeGroupDropdown() {
  const dd    = document.getElementById('group-dropdown');
  const arrow = document.getElementById('gdrop-arrow');
  dd?.classList.remove('show');
  arrow?.classList.remove('open');
  // Also close the group sheet if it's open
  closeGroupSheet();
}

// ── GROUP SHEET ──────────────────────────────────────────────────────

// ── GROUP SHEET STATE ─────────────────────────────────────────────────
let _gsSwipeStartY = 0, _gsSwipeActive = false;

window.openGroupSheet = function() {
  _renderGroupSheet();
  _renderVersionFooter();
  document.getElementById('gs-overlay').classList.add('show');
  const sheet = document.getElementById('gs-sheet');
  sheet.classList.add('show');
  sheet.scrollTop = 0;
  document.body.classList.add('sheet-open');
  // Sticky shadow: add .scrolled to sticky-top when sheet is scrolled
  const stickyTop = document.getElementById('gs-sticky-top');
  function _onSheetScroll() {
    if (stickyTop) stickyTop.classList.toggle('scrolled', sheet.scrollTop > 8);
  }
  sheet._sheetScrollHandler = _onSheetScroll;
  sheet.addEventListener('scroll', _onSheetScroll, { passive: true });
  // Attach swipe-to-close
  sheet.addEventListener('touchstart', _gsTouchStart, { passive: true });
  sheet.addEventListener('touchmove',  _gsTouchMove,  { passive: false });
  sheet.addEventListener('touchend',   _gsTouchEnd,   { passive: true });
};

window.closeGroupSheet = function() {
  const overlay = document.getElementById('gs-overlay');
  const sheet   = document.getElementById('gs-sheet');
  if (!overlay || !sheet) return;
  // Fast ease-in for close (feels snappy vs the springy open)
  sheet.style.transition = 'transform .26s cubic-bezier(.55,0,.9,.45)';
  overlay.classList.remove('show');
  sheet.classList.remove('show');
  sheet.style.transform = '';
  document.body.classList.remove('sheet-open');
  // Remove sticky shadow
  const stickyTop = document.getElementById('gs-sticky-top');
  if (stickyTop) stickyTop.classList.remove('scrolled');
  // Clean up scroll listener
  if (sheet._sheetScrollHandler) {
    sheet.removeEventListener('scroll', sheet._sheetScrollHandler);
    sheet._sheetScrollHandler = null;
  }
  sheet.removeEventListener('touchstart', _gsTouchStart);
  sheet.removeEventListener('touchmove',  _gsTouchMove);
  sheet.removeEventListener('touchend',   _gsTouchEnd);
  // Restore spring transition after close animation
  setTimeout(() => { if (sheet) sheet.style.transition = ''; }, 300);
};

function _gsTouchStart(e) {
  // Don't hijack taps on interactive elements — let click fire normally
  if (e.target.closest('button,a,input,select,textarea')) { _gsSwipeActive = false; return; }
  const sheet = document.getElementById('gs-sheet');
  // Only start swipe-down tracking when at the top of the scroll area
  if (sheet.scrollTop > 4) { _gsSwipeActive = false; return; }
  _gsSwipeStartY = e.touches[0].clientY;
  _gsSwipeActive = true;
}
function _gsTouchMove(e) {
  if (!_gsSwipeActive) return;
  const dy = e.touches[0].clientY - _gsSwipeStartY;
  if (dy <= 0) return;
  e.preventDefault(); // prevent page scroll while dragging the sheet down
  document.getElementById('gs-sheet').style.transform = `translateY(${Math.min(dy, 300)}px)`;
}
function _gsTouchEnd(e) {
  if (!_gsSwipeActive) return;
  _gsSwipeActive = false;
  const dy = e.changedTouches[0].clientY - _gsSwipeStartY;
  if (dy > 90) {
    closeGroupSheet();
  } else {
    // Spring back — same spring curve as open for consistency
    const sheet = document.getElementById('gs-sheet');
    sheet.style.transition = 'transform .38s cubic-bezier(.34,1.28,.64,1)';
    sheet.style.transform = '';
    setTimeout(() => { sheet.style.transition = ''; }, 420);
  }
}

// Esc key closes any open sheet/drawer
(function _registerEscKey() {
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeGroupSheet();
    if (typeof closeFilterDrawer === 'function') closeFilterDrawer();
    if (typeof closeProductModal === 'function') closeProductModal();
  });
})();

function _renderGroupSheet() {
  // Hero
  const heroName = document.getElementById('gs-hero-name');
  const heroCode = document.getElementById('gs-hero-code');
  if (heroName) heroName.textContent = groupName || 'משפחה';
  if (heroCode) heroCode.textContent = groupId   || '------';

  // Members — smart ordering: me → admins → online → offline
  const membersEl = document.getElementById('gs-members');
  if (membersEl) {
    const mList = dedupMembers(Object.values(members || {}));
    if (!mList.length) {
      membersEl.innerHTML =
        `<div style="padding:10px 20px;font-size:12px;color:var(--muted)">אין חברים עדיין</div>`;
    } else {
      const NOW = Date.now();
      const ONLINE_TTL = 5 * 60 * 1000; // 5 min window = "online"
      mList.sort((a, b) => {
        // Tier 0 — me
        const aMe = (a.uid || a.id) === myId ? 0 : 1;
        const bMe = (b.uid || b.id) === myId ? 0 : 1;
        if (aMe !== bMe) return aMe - bMe;
        // Tier 1 — admins
        const aAdm = a.roles?.admin ? 0 : 1;
        const bAdm = b.roles?.admin ? 0 : 1;
        if (aAdm !== bAdm) return aAdm - bAdm;
        // Tier 2 — recently seen (online)
        const aOn = (a.lastSeen || 0) > NOW - ONLINE_TTL ? 0 : 1;
        const bOn = (b.lastSeen || 0) > NOW - ONLINE_TTL ? 0 : 1;
        if (aOn !== bOn) return aOn - bOn;
        // Tier 3 — alphabetical
        return (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', 'he');
      });

      // Lazy render: show first 20 immediately, collapse the rest
      const LAZY_LIMIT = 20;
      const visible = mList.slice(0, LAZY_LIMIT);
      const hidden  = mList.slice(LAZY_LIMIT);

      function _memberRow(m) {
        const name  = m.displayName || m.name || '?';
        const uid   = m.uid || m.id;
        const isMe  = uid === myId;
        const isAdm = m.roles?.admin === true;
        const isOn  = isMe || (m.lastSeen || 0) > NOW - ONLINE_TTL;
        let avHtml;
        if (m.avatarType === 'photo' && m.avatarValue && !m.avatarValue.startsWith('blob:')) {
          avHtml = `<div class="gs-mem-av"><img src="${esc(m.avatarValue)}" loading="lazy"></div>`;
        } else {
          const e = m.avatarType === 'cartoon' ? (m.avatarEmoji || '🧑')
                  : (m.avatarValue || name.charAt(0) || '?');
          avHtml = `<div class="gs-mem-av">${e}</div>`;
        }
        const dot = `<div class="gs-mem-dot${isOn ? ' online' : ''}"></div>`;
        const meLabel   = isMe  ? `<span style="font-size:9px;background:var(--accent-dim);color:var(--accent);border-radius:4px;padding:1px 5px;font-weight:700;margin-right:5px">אני</span>` : '';
        const admLabel  = isAdm && !isMe ? `<span style="font-size:9px;background:rgba(99,102,241,.15);color:#a5b4fc;border-radius:4px;padding:1px 5px;font-weight:700;margin-right:5px">מנהל</span>` : '';
        const status    = isMe ? 'מחובר' : isOn ? 'פעיל עכשיו' : 'חבר קבוצה';
        return `<div class="gs-member">${avHtml}<div class="gs-mem-info"><div class="gs-mem-name">${meLabel}${admLabel}${esc(name)}</div><div class="gs-mem-status">${status}</div></div>${dot}</div>`;
      }

      let html = visible.map(_memberRow).join('');
      if (hidden.length) {
        const collapsedHtml = hidden.map(_memberRow).join('');
        html += `<div id="gs-members-more" style="display:none">${collapsedHtml}</div>
          <button onclick="
            document.getElementById('gs-members-more').style.display='';
            this.style.display='none';
          " style="display:flex;align-items:center;justify-content:center;gap:6px;
            width:100%;padding:10px 20px;background:none;border:none;
            font-family:'Rubik',sans-serif;font-size:12px;font-weight:600;
            color:var(--muted);cursor:pointer">
            ▾ עוד ${hidden.length} חברים
          </button>`;
      }
      membersEl.innerHTML = html;
    }
  }

  // Groups list (switch group)
  const groupsEl = document.getElementById('gs-groups-list');
  if (groupsEl) {
    const gList = Object.values(typeof myGroups !== 'undefined' ? myGroups : {})
      .sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));
    if (gList.length <= 1) {
      // Only one group — hide the section
      groupsEl.closest ? (groupsEl.innerHTML = '') : (groupsEl.innerHTML = '');
      const label = groupsEl.previousElementSibling;
      if (label && label.classList.contains('gs-sec-label')) label.style.display = 'none';
      const sep   = groupsEl.nextElementSibling;
      if (sep   && sep.classList.contains('gs-sep'))       sep.style.display   = 'none';
    } else {
      groupsEl.previousElementSibling?.style &&
        (groupsEl.previousElementSibling.style.display = '');
      groupsEl.nextElementSibling?.style &&
        (groupsEl.nextElementSibling.style.display = '');
      groupsEl.innerHTML = gList.map(g => {
        const isActive = g.groupId === groupId;
        return `<div class="gs-grp-item${isActive ? ' active-g' : ''}"
            onclick="switchGroup('${g.groupId}'); closeGroupSheet()">
          <div class="gs-grp-dot"></div>
          <div class="gs-grp-name">${esc(g.groupName || g.groupId)}</div>
          ${!isActive ? `<div class="gs-grp-code">${esc(g.groupId)}</div>` : ''}
          ${isActive  ? `<span class="gs-grp-chk">✓</span>` : ''}
        </div>`;
      }).join('');
    }
  }
}

// Leave group — confirmation before action
window.confirmLeaveGroup = function() {
  showConfirm(`עזוב את "${groupName}"?\n\nתוכל להצטרף מחדש בעזרת הקוד.`, () => {
    closeGroupSheet();
    toast('💡 בקרוב: עזיבת קבוצה — בינתיים צור קבוצה חדשה');
  });
};

// Wire: old dropdown toggle → sheet
window.toggleGroupDropdown = function() {
  openGroupSheet();
};

// ── OPEN JOIN/CREATE PANEL from dropdown ──
window.openJoinGroupPanel = function() {
  closeGroupDropdown();
  switchAddGroupTab('join');
  document.getElementById('add-group-overlay').classList.add('show');
};

window.openCreateGroupPanel = function() {
  closeGroupDropdown();
  switchAddGroupTab('create');
  document.getElementById('add-group-overlay').classList.add('show');
};

window.switchAddGroupTab = function(tab) {
  document.getElementById('ag-join-panel').style.display   = tab === 'join'   ? 'block' : 'none';
  document.getElementById('ag-create-panel').style.display = tab === 'create' ? 'block' : 'none';
  document.getElementById('agtab-join').className    = 'mbtn ' + (tab === 'join'   ? 'primary' : 'ghost');
  document.getElementById('agTab-create').className = 'mbtn ' + (tab === 'create' ? 'primary' : 'ghost');
};

// ── JOIN ANOTHER GROUP ──
window.joinAnotherGroup = async function() {
  const code = document.getElementById('ag-join-code').value.trim();
  if (!code || code.length !== 6) { toast('⚠️ קוד חייב להיות 6 ספרות'); return; }
  try {
    const snap = await get(ref(db, `groups/${code}/info`));
    if (!snap.exists()) { toast('❌ קבוצה לא נמצאה'); return; }
    const info = snap.val();
    const newName = info.name || code;
    closeOL2('add-group-overlay');
    await switchGroup(code);
    toast(`✅ הצטרפת לקבוצה: ${newName}`);
  } catch(e) {
    const msg = (e.message||'');
    if (msg.includes('PERMISSION_DENIED') || msg.toLowerCase().includes('permission denied'))
      toast('❌ שגיאת הרשאות — הקוד שגוי או שאין גישה לקבוצה זו');
    else
      toast('❌ ' + msg);
  }
};

// ── CREATE ANOTHER GROUP ──
window.createAnotherGroup = async function() {
  const name = document.getElementById('ag-create-name').value.trim();
  if (!name) { toast('⚠️ הכנס שם קבוצה'); return; }
  const newCode = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await set(ref(db, `groups/${newCode}/info`), { name, code: newCode });
    closeOL2('add-group-overlay');
    await switchGroup(newCode);
    toast(`✨ קבוצה נוצרה: ${name}`);
  } catch(e) { toast('❌ ' + e.message); }
};

// ── renderProfile (called on members update) ──
function renderProfile() {
  const live = members[myId];
  if (!live) return;
  // Update local profile from Firebase if changed
  if (live.displayName && live.displayName !== myName) {
    myName = live.displayName;
  }
  if (live.avatarValue && myProfile) {
    myProfile.avatarType  = live.avatarType  || myProfile.avatarType;
    myProfile.avatarValue = live.avatarValue || myProfile.avatarValue;
    myProfile.avatarEmoji = live.avatarEmoji || myProfile.avatarEmoji;
    localStorage.setItem('fsl_profile', JSON.stringify(myProfile));
  }
  updateHeaderAvatar();
}


// ══════════════════════════════════════════════════
// NOTIFICATION SYSTEM v1.0
// Firebase: notifications/{groupId}/{notifId}
// Architecture ready for FCM, activity feed, mentions
// ══════════════════════════════════════════════════

// ── TYPES ──
const NOTIF_TYPES = {
  item_deleted:  { icon: '🗑',  verb: 'מחק את'        },
  item_bought:   { icon: '✅',  verb: 'סימן כנקנה את' },
  item_unbought: { icon: '↩️',  verb: 'ביטל קנייה של' },
  item_added:    { icon: '➕',  verb: 'הוסיף את'       },
  item_updated:  { icon: '✏️',  verb: 'עדכן את'        },
};

// ── NOTIFICATION LISTENER ──
let _notifListener = null;
let _allNotifications = {}; // { notifId: notifObj }

function startNotificationListener() {
  if (!db || !groupId || !myId) return;
  if (_notifListener) { _notifListener(); _notifListener = null; }

  _notifListener = onValue(
    ref(db, `notifications/${groupId}`),
    snap => {
      _allNotifications = snap.val() || {};
      updateNotifBadge();
    }
  );
  console.log('[notif] listener started for group', groupId);
}

function stopNotificationListener() {
  if (_notifListener) { _notifListener(); _notifListener = null; }
}

// ── UNREAD COUNT ──
function getUnreadCount() {
  return Object.values(_allNotifications).filter(n =>
    n.targetUsers?.[myId] &&           // addressed to me
    !n.readBy?.[myId] &&               // not read by me
    n.createdBy !== myId               // not my own action
  ).length;
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const count = getUnreadCount();
  badge.textContent = count > 9 ? '9+' : count;
  badge.classList.toggle('show', count > 0);
}

// ── CREATE NOTIFICATION ──
// Reusable — call this from any action
async function createNotification({ type, itemId, itemName, targetUsersObj }) {
  if (!groupId || !myId || !itemName) return;
  // Don't notify if no other group members
  const otherMembers = Object.keys(members).filter(uid => uid !== myId);
  if (!otherMembers.length && !targetUsersObj) return;

  const targets = targetUsersObj || {};
  otherMembers.forEach(uid => { targets[uid] = true; });

  const m = myProfile || {};
  const notifId = `n_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

  const notif = {
    type,
    itemId:          itemId || null,
    itemName:        sanitize(itemName, 200),
    createdBy:       myId,
    createdByName:   myName,
    createdByAvatar: m.avatarValue || '👤',
    createdByAvatarType: m.avatarType || 'emoji',
    targetUsers:     targets,
    readBy:          {},
    createdAt:       Date.now(),
  };

  try {
    await set(ref(db, `notifications/${groupId}/${notifId}`), notif);
    console.log('[notif] created:', type, itemName);
  } catch(e) {
    console.warn('[notif] create failed:', e.message);
  }
}

// ── MARK AS READ ──
async function markNotificationRead(notifId) {
  if (!notifId || !myId) return;
  try {
    await set(ref(db, `notifications/${groupId}/${notifId}/readBy/${myId}`), true);
  } catch(e) { console.warn('[notif] markRead failed:', e.message); }
}

window.markAllNotificationsRead = async function() {
  const unread = Object.keys(_allNotifications).filter(id => {
    const n = _allNotifications[id];
    return n.targetUsers?.[myId] && !n.readBy?.[myId] && n.createdBy !== myId;
  });
  await Promise.all(unread.map(id => markNotificationRead(id)));
  renderNotificationList();
};

// ── OPEN / CLOSE NOTIFICATIONS ──
window.openNotifications = function() {
  document.getElementById('notif-overlay').classList.add('show');
  document.body.classList.add('sheet-open');
  renderNotificationList();
  // Mark visible notifications as read after a short delay
  setTimeout(() => {
    Object.keys(_allNotifications).forEach(id => {
      const n = _allNotifications[id];
      if (n.targetUsers?.[myId] && !n.readBy?.[myId] && n.createdBy !== myId) {
        markNotificationRead(id);
      }
    });
  }, 1200);
};

window.closeNotifications = function() {
  document.getElementById('notif-overlay').classList.remove('show');
  document.body.classList.remove('sheet-open');
};

// ── RENDER NOTIFICATION LIST ──
function renderNotificationList() {
  const list = document.getElementById('notif-list');
  if (!list) return;

  const myNotifs = Object.entries(_allNotifications)
    .map(([id, n]) => ({ ...n, _id: id }))
    .filter(n => n.targetUsers?.[myId] && n.createdBy !== myId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 50);

  if (!myNotifs.length) {
    list.innerHTML = `
      <div class="notif-empty">
        <div class="ne-icon">🔔</div>
        <p>אין התראות עדיין</p>
      </div>`;
    return;
  }

  list.innerHTML = myNotifs.map(n => {
    const isUnread = !n.readBy?.[myId];
    const meta = NOTIF_TYPES[n.type] || { icon: '📣', verb: 'עדכן' };
    const timeStr = formatNotifTime(n.createdAt);

    // Avatar
    let avHTML = '';
    if (n.createdByAvatarType === 'photo' && n.createdByAvatar &&
        !n.createdByAvatar.startsWith('blob:')) {
      avHTML = `<div class="notif-av">
        <img src="${esc(n.createdByAvatar)}" loading="lazy"></div>`;
    } else {
      const e = n.createdByAvatarType === 'cartoon'
        ? (n.createdByAvatar || '🧑')
        : (n.createdByAvatar || '👤');
      avHTML = `<div class="notif-av">${e}</div>`;
    }

    return `<div class="notif-item${isUnread ? ' unread' : ''}"
      onclick="markNotificationRead('${n._id}');this.classList.remove('unread')">
      ${avHTML}
      <div class="notif-body">
        <div class="notif-text">
          <strong>${esc(n.createdByName || 'מישהו')}</strong>
          ${meta.verb} <strong>${esc(n.itemName)}</strong>
          ${meta.icon}
        </div>
        <div class="notif-time">${timeStr}</div>
      </div>
    </div>`;
  }).join('');
}

// ── TIME FORMATTER ──
function formatNotifTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000)  return 'עכשיו';
  if (diff < 3600000) return `לפני ${Math.round(diff/60000)} דקות`;
  if (diff < 86400000) return `לפני ${Math.round(diff/3600000)} שעות`;
  return new Date(ts).toLocaleDateString('he-IL');
}

// ── Hook notification listener into group connect/switch ──
// Called from attachGroupListeners
function startGroupNotifications() {
  startNotificationListener();
}

// ══════════════════════════════════════════════════
// DELETE CONFIRMATION SYSTEM
// ══════════════════════════════════════════════════

let _pendingDeleteId   = null;
let _pendingDeleteItem = null;

// ── SHOW CONFIRM DELETE MODAL ──
window.deleteItem = function(id) {
  const item = items[id];
  if (!item) return;

  _pendingDeleteId   = id;
  _pendingDeleteItem = item;

  // Populate modal
  document.getElementById('confirm-item-name').textContent = item.name || 'פריט';

  // Show who added it
  const addedMember  = members[item.addedByUserId] || null;
  const adderName    = addedMember?.displayName || item.addedByDisplayName || item.addedBy || '';
  const adderAvType  = addedMember?.avatarType  || item.addedByAvatarType  || 'emoji';
  const adderAvValue = addedMember?.avatarValue || item.addedByAvatarValue || '👤';
  const adderEmoji   = addedMember?.avatarEmoji || item.addedByAvatarEmoji || null;
  const isOtherUser  = item.addedByUserId && item.addedByUserId !== myId;

  const byEl = document.getElementById('confirm-item-by');
  if (adderName && isOtherUser) {
    // Build avatar
    let avHTML = '';
    if (adderAvType === 'photo' && adderAvValue && !adderAvValue.startsWith('blob:')) {
      avHTML = `<div class="confirm-modal-by-av">
        <img src="${esc(adderAvValue)}" style="width:100%;height:100%;object-fit:cover"></div>`;
    } else {
      const e = adderAvType === 'cartoon' ? (adderEmoji || '🧑') : (adderAvValue || '👤');
      avHTML = `<div class="confirm-modal-by-av">${e}</div>`;
    }
    byEl.innerHTML = `${avHTML}<span>הוסף על ידי ${esc(adderName)}</span>`;
    byEl.style.display = 'flex';
  } else {
    byEl.style.display = 'none';
  }

  // Open modal
  document.getElementById('confirm-delete-overlay').classList.add('show');

  // ESC key support
  document.addEventListener('keydown', handleDeleteEsc, { once: true });
};

function handleDeleteEsc(e) {
  if (e.key === 'Escape') closeConfirmDelete();
}

window.closeConfirmDelete = function() {
  document.getElementById('confirm-delete-overlay').classList.remove('show');
  _pendingDeleteId   = null;
  _pendingDeleteItem = null;
};

// ── CONFIRM AND EXECUTE DELETE ──
window.confirmDeleteItem = async function() {
  const id   = _pendingDeleteId;
  const item = _pendingDeleteItem;
  if (!id || !item) return;

  // Close modal immediately (optimistic)
  closeConfirmDelete();

  const addedByUserId = item.addedByUserId;
  const isOtherUser   = addedByUserId && addedByUserId !== myId;

  try {
    // 1. Remove from Firebase
    await remove(ref(db, `groups/${groupId}/items/${id}`));
    console.log('[delete] removed item:', item.name);

    // 2. Create notification for item owner (if different user)
    if (isOtherUser) {
      const targets = {};
      targets[addedByUserId] = true;
      await createNotification({
        type:           'item_deleted',
        itemId:         id,
        itemName:       item.name,
        targetUsersObj: targets,
      });
    }

    // 3. Log to activity feed
    logActivity('item_removed', id, item.name);

    toast(`🗑 ${esc(item.name)} נמחק`);

  } catch(e) {
    console.error('[delete] failed:', e.message);
    toast('❌ מחיקה נכשלה: ' + e.message);
  }
};

// Notifications are started from connectToGroup via startGroupNotifications()
// (called inside attachGroupListeners which is called by connectToGroup)



// ══════════════════════════════════════════════════
// SHARED UTILITIES
// ══════════════════════════════════════════════════

// Cleanup notifications older than 30 days
async function cleanupOldNotifications() {
  if (!db || !groupId) return;
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const toDelete = Object.entries(_allNotifications)
    .filter(([, n]) => (n.createdAt || 0) < cutoff)
    .map(([id]) => id);
  if (!toDelete.length) return;
  console.log('[notif] cleanup:', toDelete.length, 'old notifications');
  await Promise.all(
    toDelete.map(id =>
      remove(ref(db, `notifications/${groupId}/${id}`)).catch(() => {})
    )
  );
}

// Reusable avatar HTML builder
function buildAvatarHTML(avatarType, avatarValue, avatarEmoji, size = 36) {
  const px = size + 'px';
  const style = `width:${px};height:${px};border-radius:50%;background:var(--card2);`
    + `display:flex;align-items:center;justify-content:center;`
    + `font-size:${Math.round(size*0.5)}px;overflow:hidden;flex-shrink:0`;
  if (avatarType === 'photo' && avatarValue && !avatarValue.startsWith('blob:')) {
    return `<div style="${style}"><img src="${esc(avatarValue)}"
      style="width:100%;height:100%;object-fit:cover;border-radius:50%" loading="lazy"></div>`;
  }
  const e = avatarType === 'cartoon' ? (avatarEmoji || '🧑') : (avatarValue || '👤');
  return `<div style="${style}">${e}</div>`;
}

// SERVICE WORKER
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}

// ── TRANSLATION RESOLVER INTEGRATION ──
// Dynamically import resolver modules
let resolverReady = false;
let resolveProductTerm, confirmResolution, initMemory, loadUserDictionary, setCachedDict;

async function initResolver() {
  try {
    const resolver  = await import('./js/translation/resolver.js');
    const memoryMod = await import('./js/translation/memory.js');
    resolveProductTerm = resolver.resolveProductTerm;
    confirmResolution  = resolver.confirmResolution;
    initMemory         = memoryMod.initMemory;
    loadUserDictionary = memoryMod.loadUserDictionary;
    setCachedDict      = memoryMod.setCachedDict;
    resolverReady = true;
    console.log('✅ Translation resolver ready');
  } catch(e) {
    console.warn('Resolver not available:', e.message);
  }
}
initResolver();

// Promise that resolves when the translation resolver is ready (or times out at 3s).
// Used by searchPrices to avoid firing with raw Hebrew before modules load.
let _resolverReadyPromise = new Promise(resolve => {
  if (resolverReady) { resolve(); return; }
  const check = setInterval(() => {
    if (resolverReady) { clearInterval(check); resolve(); }
  }, 50);
  setTimeout(() => { clearInterval(check); resolve(); }, 3000); // give up after 3s
});

// Pending resolve callback
let _resolveCallback = null;

// Main entry: try to resolve a Hebrew term, show popup if needed
window.resolveAndSearch = async function(hebrewTerm, onResolved) {
  if (!resolverReady || !resolveProductTerm) {
    onResolved(hebrewTerm); return;
  }
  // Init memory with current db + user
  if (initMemory && db && myId) {
    initMemory(db, myId);
    const userDict = await loadUserDictionary();
    setCachedDict(userDict);
  }

  const result = await resolveProductTerm(hebrewTerm);

  if (result.resolved) {
    // Resolved directly — proceed
    onResolved(result.resolved);
  } else if (result.needsConfirmation) {
    // Show popup
    _resolveCallback = async (chosenEnglish) => {
      if (chosenEnglish) {
        await confirmResolution(hebrewTerm, chosenEnglish);
        onResolved(chosenEnglish);
      }
    };
    showResolverPopup(hebrewTerm, result.suggestions || [], result.manualOnly);
  }
};

function showResolverPopup(term, suggestions, manualOnly) {
  document.getElementById('resolver-term').textContent = term;
  const suggestionsEl = document.getElementById('resolver-suggestions');

  if (manualOnly || suggestions.length === 0) {
    suggestionsEl.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:13px;padding:8px">
      לא נמצאו הצעות אוטומטיות — הכנס ידנית</div>`;
    showManualEntry();
  } else {
    suggestionsEl.innerHTML = suggestions.map((s, i) => `
      <button class="resolver-btn" onclick="pickSuggestion('${s.label.replace(/'/g,"\'")}')">
        <span>${s.label}</span>
        ${s.confidence ? `<span class="conf">${Math.round(s.confidence*100)}%</span>` : 
          `<span class="conf">${s.source === 'ai' ? '🤖 AI' : ''}</span>`}
      </button>`).join('');
  }

  document.getElementById('resolver-manual').classList.remove('show');
  document.getElementById('resolver-overlay').classList.add('show');
}

window.pickSuggestion = async function(englishTerm) {
  document.getElementById('resolver-overlay').classList.remove('show');
  if (_resolveCallback) { await _resolveCallback(englishTerm); _resolveCallback = null; }
};

window.showManualEntry = function() {
  document.getElementById('resolver-none-btn').style.display = 'none';
  document.getElementById('resolver-manual').classList.add('show');
  document.getElementById('resolver-manual-input').focus();
};

window.confirmManualEntry = async function() {
  const val = document.getElementById('resolver-manual-input').value.trim();
  if (!val) { toast('⚠️ הכנס שם מוצר'); return; }
  document.getElementById('resolver-overlay').classList.remove('show');
  document.getElementById('resolver-none-btn').style.display = '';
  document.getElementById('resolver-manual-input').value = '';
  if (_resolveCallback) { await _resolveCallback(val); _resolveCallback = null; }
};

// ── FIREBASE ANONYMOUS AUTH + INIT ──
const auth = getAuth();


// ── CONTINUE OPTION — shown on setup screen when user already has a group ──
window.showContinueIfReturning = function() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('fsl_v2') || '{}'); } catch(_) { return {}; } })();
  if (!saved.groupId || !saved.myName) return; // new user — show normal setup

  const existing = document.getElementById('setup-continue-card');
  if (existing) return; // already shown

  const card = document.createElement('div');
  card.id = 'setup-continue-card';
  card.style.cssText = 'background:#fff;border:2px solid var(--accent);border-radius:16px;padding:16px 18px;margin:12px 16px 0;text-align:center;';

  // Build DOM nodes to avoid XSS from user-controlled name/groupName fields
  const welcome = document.createElement('div');
  welcome.style.cssText = 'font-size:14px;color:var(--muted);margin-bottom:6px';
  welcome.textContent = 'ברוך השב!';

  const identity = document.createElement('div');
  identity.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:12px';
  identity.textContent = `${saved.myName} · ${saved.groupName || saved.groupId}`;

  const btn = document.createElement('button');
  btn.className = 'btn-p';
  btn.style.width = '100%';
  btn.textContent = '▶ המשך לקבוצה';
  btn.addEventListener('click', function() {
    const u = (() => { try { return JSON.parse(localStorage.getItem('fsl_v2') || '{}'); } catch(_) { return {}; } })();
    if (!u.groupId) return;
    myName = u.myName; myId = u.myId || myId; groupId = u.groupId; groupName = u.groupName;
    loadSavedProfile(); connectToGroup();
  });

  card.appendChild(welcome);
  card.appendChild(identity);
  card.appendChild(btn);

  const setupEl = document.getElementById('setup-screen');
  if (setupEl) setupEl.insertBefore(card, setupEl.firstChild);
};

onAuthStateChanged(auth, async (user) => {
  if (user) {
    const firebaseUid = user.uid;

    // Warm the waitForAuthReady() cache so all subsequent calls resolve instantly
    _authUser = user;

    // Load saved session
    const saved = localStorage.getItem('fsl_v2');
    if (saved) {
      try {
        const u = JSON.parse(saved);
        myName = u.myName; myId = firebaseUid; // always real Firebase UID
        groupId = u.groupId; groupName = u.groupName;
        localStorage.setItem('fsl_v2', JSON.stringify({ ...u, myId: firebaseUid }));

        // ── Startup verification log ──
        console.log('[auth] ✓ signed in | uid:', firebaseUid, '| myId:', myId, '| groupId:', groupId || '(none)');
        if (groupId) {
          get(ref(db, `groups/${groupId}/members/${firebaseUid}`))
            .then(snap => console.log('[auth] membership under auth.uid:', snap.exists() ? '✓ exists' : '✗ missing — ensureGroupMembership will add it'))
            .catch(() => {});
          get(ref(db, `groups/${groupId}/members`))
            .then(snap => {
              if (!snap.exists()) return;
              const fakeKeys = Object.keys(snap.val()).filter(k => /^u_\d{10,}$/.test(k));
              if (fakeKeys.length) console.warn('[auth] ⚠ fake u_* members detected in group:', fakeKeys);
            }).catch(() => {});
        }

        loadSavedProfile();
        connectToGroup();
        setTimeout(updateHeaderAvatar, 300);
        upsertUserProfile(firebaseUid).catch(() => {}); // fire-and-forget
      } catch(_) {
        showScreen('setup-screen');
      }
    } else {
      console.log('[auth] ✓ signed in | uid:', firebaseUid, '| no saved session → setup screen');
      showScreen('setup-screen');
      showContinueIfReturning();

      // Pre-fill join form if user arrived via an invite link
      if (window._pendingInviteCode) {
        const code = window._pendingInviteCode;
        window._pendingInviteCode = null;
        setTimeout(() => {
          if (typeof switchSetupTab === 'function') switchSetupTab('join');
          const codeInput = document.getElementById('jn-code');
          if (codeInput) codeInput.value = code;
          document.getElementById('jn-name')?.focus();
          toast('🔗 הוזמנת להצטרף — הזן את שמך');
        }, 400);
      }
    }
  } else {
    // Not signed in — sign in anonymously (onAuthStateChanged fires again with user)
    console.log('[auth] not signed in — requesting anonymous sign-in...');
    try {
      await signInAnonymously(auth);
    } catch(e) {
      console.error('[auth] anonymous sign-in failed:', e.message);
      // Auth failed entirely — show setup screen, DO NOT use fake local IDs
      showScreen('setup-screen');
      toast('❌ בעיית חיבור — בדוק אינטרנט ורענן');
    }
  }
});

// ── DEV DEBUG OBJECT — safe, no secrets ──
// Available in browser console on localhost and vercel.app
if (location.hostname.includes('localhost') || location.hostname.includes('vercel.app')) {
  window.__debugAuth = {
    getUid:     () => getAuth(app).currentUser?.uid   || '(no firebase auth)',
    getMyId:    () => myId                            || '(not set)',
    getGroupId: () => groupId                         || '(not set)',
    isFakeId:   () => /^u_\d{10,}$/.test(myId),
    getMembersPath: () => groupId ? `groups/${groupId}/members/${myId}` : '(no group)',
  };
  console.log('[debug] window.__debugAuth ready — __debugAuth.getUid() | getMyId() | getGroupId() | isFakeId()');
}

// ════════════════════════════════════════════════════════════════════
// ADMIN UNLOCK — hidden long-press gesture on avatar
// Security model:
//   1. Client reads users/{uid}/roles/admin from Firebase (fast pre-check)
//   2. PIN + Firebase ID token sent to /api/admin-unlock (server validates both)
//   3. Session stored in sessionStorage with 15-min TTL
//   4. Status data fetched from /api/admin-status (server-gated)
// ════════════════════════════════════════════════════════════════════

const ADMIN_SESSION_MS = 15 * 60 * 1000; // 15 minutes
let _adminPressTimer = null;
let _adminRoleCache = null; // null=unknown, true/false
let _adminRevokeListenerActive = false;

// ── Admin panel session telemetry ─────────────────────────────────────
// adminPanelSessions/{uid}/{sessionId} = { openedAt, closedAt, userAgent, revoked, timedOut }
// Goal: detect abandoned sessions and suspicious usage patterns.
let _adminSessionRef   = null; // Firebase ref for the active session record
let _adminSessionTimer = null; // setTimeout handle for TTL-based timedOut marker

async function _openAdminSession() {
  if (!myId) return;
  // If a previous session ref leaked, close it as abandoned before opening a new one
  if (_adminSessionRef) await _closeAdminSession('abandoned');
  const sessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _adminSessionRef = ref(db, `adminPanelSessions/${myId}/${sessionId}`);
  try {
    await set(_adminSessionRef, {
      openedAt:  new Date().toISOString(),
      closedAt:  null,
      userAgent: navigator.userAgent.slice(0, 200),
      revoked:   false,
      timedOut:  false,
    });
  } catch {
    _adminSessionRef = null; // telemetry failure is non-critical
    return;
  }
  // Auto-mark timedOut when the 15-min session TTL expires while the panel is still open
  const elapsed = Date.now() - parseInt(sessionStorage.getItem('adminUnlocked') || '0', 10);
  const msLeft  = Math.max(ADMIN_SESSION_MS - elapsed, 0);
  if (_adminSessionTimer) clearTimeout(_adminSessionTimer);
  _adminSessionTimer = setTimeout(async () => {
    _adminSessionTimer = null;
    await _updateAdminSession({ closedAt: new Date().toISOString(), timedOut: true });
    _adminSessionRef = null;
    // Session expired — next API call will 401; UI shows error naturally
  }, msLeft);
}

async function _updateAdminSession(fields) {
  if (!_adminSessionRef) return;
  try { await update(_adminSessionRef, fields); } catch { /* non-critical */ }
}

async function _closeAdminSession(reason = 'manual') {
  if (_adminSessionTimer) { clearTimeout(_adminSessionTimer); _adminSessionTimer = null; }
  await _updateAdminSession({
    closedAt: new Date().toISOString(),
    revoked:  reason === 'revoked',
    timedOut: reason === 'timeout',
  });
  _adminSessionRef = null;
}

// ── Live admin-role revocation listener ──────────────────────────────
// Watches users/{uid}/roles/admin in Firebase. If an admin revokes their own
// (or another admin revokes their) role while the panel is open, the session
// is invalidated immediately and the panel closes without a page reload.
// Emergency revoke: set users/{uid}/roles/admin = false in Firebase console.
function initAdminRevokeListener() {
  if (_adminRevokeListenerActive || !myId) return;
  _adminRevokeListenerActive = true;

  let firstFire = true;
  onValue(ref(db, `users/${myId}/roles/admin`), snap => {
    const isAdmin = snap.val() === true;

    if (firstFire) {
      // Seed the cache from live DB value on first fire (replaces one-time get())
      _adminRoleCache = isAdmin;
      firstFire = false;
      return; // Don't react to the initial read — only to changes
    }

    // Role changed after initial load — update cache unconditionally
    _adminRoleCache = isAdmin;

    if (!isAdmin) {
      // Admin access was revoked externally. Wipe local session immediately.
      sessionStorage.removeItem('adminUnlocked');

      // Close the admin panel if it is currently visible
      const overlay = document.getElementById('admin-overlay');
      if (overlay && overlay.classList.contains('show')) {
        closeAdminOverlay('revoked');
        toast('🔒 הרשאת אדמין בוטלה');
      }
    }
  });
}

// ── Attach long-press to avatar after connectToGroup ────────────────
function initAdminGesture() {
  const avatar = document.getElementById('hdr-my-avatar');
  if (!avatar || avatar._adminGestureAttached) return;
  avatar._adminGestureAttached = true;

  // Start the revocation listener alongside the gesture (one-time, idempotent)
  initAdminRevokeListener();

  const HOLD_MS = 3000;

  function startPress() {
    if (_adminPressTimer) return;
    _adminPressTimer = setTimeout(async () => {
      _adminPressTimer = null;
      avatar.classList.remove('admin-press-active');
      await onAdminLongPress();
    }, HOLD_MS);
    avatar.classList.add('admin-press-active');
  }

  function cancelPress() {
    if (_adminPressTimer) {
      clearTimeout(_adminPressTimer);
      _adminPressTimer = null;
    }
    avatar.classList.remove('admin-press-active');
  }

  avatar.addEventListener('pointerdown', startPress);
  avatar.addEventListener('pointerup',   cancelPress);
  avatar.addEventListener('pointerleave', cancelPress);
  avatar.addEventListener('contextmenu', e => e.preventDefault());
}

async function onAdminLongPress() {
  // Silently check Firebase admin role first
  const isAdmin = await checkAdminRole();
  if (!isAdmin) return; // no feedback — not admin

  // Haptic feedback if available
  if (navigator.vibrate) navigator.vibrate(40);

  // Check if already unlocked with valid session
  if (isAdminSessionValid()) {
    openAdminPanel();
  } else {
    openAdminUnlock();
  }
}

async function checkAdminRole() {
  // Return cached value to avoid repeated DB reads
  if (_adminRoleCache !== null) return _adminRoleCache;
  if (!myId) return false;
  try {
    const snap = await get(ref(db, `users/${myId}/roles/admin`));
    _adminRoleCache = snap.val() === true;
    return _adminRoleCache;
  } catch {
    return false;
  }
}

function isAdminSessionValid() {
  // ⚠️ sessionStorage is NOT a security boundary.
  // It prevents accidental access but is trivially bypassed by anyone with
  // DevTools. Real security is enforced server-side on every /api/admin-* call.
  const ts = parseInt(sessionStorage.getItem('adminUnlocked') || '0', 10);
  return ts > 0 && (Date.now() - ts) < ADMIN_SESSION_MS;
}

// ── Unlock modal ─────────────────────────────────────────────────────
function openAdminUnlock() {
  document.getElementById('admin-unlock-modal').style.display = 'block';
  document.getElementById('admin-panel-modal').style.display  = 'none';
  document.getElementById('admin-overlay').classList.add('show');
  document.getElementById('admin-pin-input').value = '';
  document.getElementById('admin-pin-error').textContent = '';
  document.getElementById('admin-unlock-btn').disabled = false;
  setTimeout(() => document.getElementById('admin-pin-input').focus(), 100);
}

window.submitAdminPin = async function() {
  const pin = document.getElementById('admin-pin-input').value.trim();
  if (!pin) return;

  const btn = document.getElementById('admin-unlock-btn');
  btn.disabled = true;
  btn.textContent = '...';
  document.getElementById('admin-pin-error').textContent = '';

  try {
    const user = auth.currentUser;
    if (!user) throw new Error('not-auth');
    const idToken = await user.getIdToken();

    const res = await fetch('/api/admin-unlock', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ pin }),
    });

    const data = await res.json();

    if (data.ok) {
      sessionStorage.setItem('adminUnlocked', String(Date.now()));
      if (navigator.vibrate) navigator.vibrate([30, 20, 30]);
      openAdminPanel();
    } else {
      document.getElementById('admin-pin-error').textContent = '❌ קוד שגוי או אין הרשאה';
      document.getElementById('admin-pin-input').value = '';
      document.getElementById('admin-pin-input').focus();
    }
  } catch {
    document.getElementById('admin-pin-error').textContent = '❌ שגיאת חיבור';
  } finally {
    btn.disabled = false;
    btn.textContent = 'כניסה';
  }
};

// ── Admin status panel ────────────────────────────────────────────────
async function openAdminPanel() {
  document.getElementById('admin-unlock-modal').style.display = 'none';
  document.getElementById('admin-panel-modal').style.display  = 'block';
  document.getElementById('admin-overlay').classList.add('show');
  document.getElementById('admin-panel-content').innerHTML =
    '<div style="text-align:center;color:var(--muted);padding:32px 0">' +
    '<div style="font-size:32px;margin-bottom:8px">⏳</div>טוען נתונים...</div>';
  _openAdminSession(); // non-blocking telemetry
  await loadAdminStatus();
}

async function loadAdminStatus() {
  try {
    const user = auth.currentUser;
    if (!user) throw new Error('not-auth');
    const idToken = await user.getIdToken();

    const res = await fetch('/api/admin-status', {
      headers: { 'Authorization': `Bearer ${idToken}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'failed');
    renderAdminPanel(data.status, data.meta || {});
  } catch (err) {
    document.getElementById('admin-panel-content').innerHTML =
      `<div style="color:#ef4444;text-align:center;padding:24px">❌ ${esc(err.message)}</div>`;
  }
}

function renderAdminPanel(s, meta = {}) {
  const statusLabel  = s.statusLabel        || 'unknown';
  const coverage     = s.productionCoverage || 'unknown';
  const checkedAt    = s.checkedAt          || null;
  const disabledIds  = s.disabledChainIds   || [];
  const enabledReq   = s.enabledRequiredChains ?? '?';
  const disabledCnt  = s.disabledChains     ?? disabledIds.length;
  const results      = s.results            || {};

  // Banner
  let bannerCls, bannerIcon, bannerTitle, bannerSub;
  if (statusLabel === 'full_pass') {
    bannerCls = 'pass'; bannerIcon = '✅';
    bannerTitle = 'FULL PASS — כל הרשתות פעילות';
    bannerSub   = 'כיסוי ייצור מלא';
  } else if (statusLabel === 'baseline_pass') {
    bannerCls = 'warn'; bannerIcon = '⚠️';
    bannerTitle = 'BASELINE PASS — כיסוי חלקי';
    bannerSub   = s.message || 'רק רשתות מופעלות נבדקו';
  } else {
    bannerCls = 'fail'; bannerIcon = '❌';
    bannerTitle = 'FAIL — בדיקת הסניטי נכשלה';
    bannerSub   = 'רשת חובה אחת או יותר לא מחזירה מחירים';
  }
  if (checkedAt) bannerSub += ` · ${adminTimeAgo(checkedAt)}`;

  // Coverage warning
  const warnHtml = coverage === 'partial'
    ? `<div class="admin-coverage-warn">
        <strong>⚠️ כיסוי חלקי — כרגע רק שופרסל פעילה</strong>
        רשתות נוספות (רמי לוי, ויקטורי, יינות ביתן, אושר עד, מחסני להב) מושבתות בהמתנה לאימות endpoints.
       </div>`
    : '';

  // Meta pills
  const checkedStr = checkedAt
    ? new Date(checkedAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
  const metaHtml = `
    <div class="admin-meta-row">
      <div class="admin-meta-pill">
        <div class="aml">סטטוס</div>
        <div class="amv ${bannerCls}">${statusLabel === 'full_pass' ? 'Full' : statusLabel === 'baseline_pass' ? 'Base' : 'Fail'}</div>
      </div>
      <div class="admin-meta-pill">
        <div class="aml">כיסוי</div>
        <div class="amv ${coverage === 'full' ? 'pass' : 'warn'}">${coverage === 'full' ? 'מלא' : 'חלקי'}</div>
      </div>
      <div class="admin-meta-pill">
        <div class="aml">פעילות</div>
        <div class="amv ${enabledReq > 0 ? 'pass' : 'fail'}">${enabledReq}</div>
      </div>
      <div class="admin-meta-pill">
        <div class="aml">מושבתות</div>
        <div class="amv ${disabledCnt > 0 ? 'warn' : 'pass'}">${disabledCnt}</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted);text-align:center;margin-bottom:14px">
      בדיקה אחרונה: ${esc(checkedStr)}
    </div>`;

  // Sample product
  const passing = Object.values(results).find(r => r.status === 'pass');
  const productHtml = passing && passing.barcode ? `
    <div class="admin-section-label">מוצר לדוגמה</div>
    <div class="admin-product-card">
      <div class="admin-product-barcode">${esc(passing.barcode)}</div>
      <div class="admin-product-name">${esc(passing.name || '—')}</div>
      <div class="admin-product-price">₪${passing.price != null ? Number(passing.price).toFixed(2) : '—'}</div>
      ${passing.storeId ? `<div class="admin-product-store">סניף ${esc(passing.storeId)}</div>` : ''}
    </div>` : '';

  // Chains
  const allChainIds = [...Object.keys(results), ...disabledIds.filter(id => !results[id])];
  const enabledRows = allChainIds
    .filter(id => !disabledIds.includes(id))
    .map(id => {
      const r = results[id] || {};
      const pass = r.status === 'pass';
      const price = r.price != null ? `₪${Number(r.price).toFixed(2)}` : '';
      const err = r.error ? esc(r.error.substring(0, 50)) : '';
      return `<div class="admin-chain-row">
        <span class="acdot ${pass ? 'pass' : 'fail'}"></span>
        <span class="admin-chain-id">${esc(id)}</span>
        ${price ? `<span class="admin-chain-price">${price}</span>` : ''}
        ${err  ? `<span class="admin-chain-err">${err}</span>` : ''}
      </div>`;
    }).join('');

  const disabledRows = disabledIds.map(id => `
    <div class="admin-chain-row disabled">
      <span class="acdot dis"></span>
      <span class="admin-chain-id">${esc(id)}</span>
      <span class="admin-chain-err">ממתין לאימות endpoint</span>
    </div>`).join('');

  const chainsHtml = `
    ${enabledRows ? `<div class="admin-section-label">רשתות פעילות</div>${enabledRows}` : ''}
    ${disabledRows ? `<div class="admin-section-label" style="margin-top:12px">רשתות מושבתות</div>${disabledRows}` : ''}`;

  // ── Version / build footer ──────────────────────────────────────────
  const sha       = esc(meta.deployedSha || 'unknown');
  const env       = esc(meta.deployedEnv || (location.hostname === 'localhost' ? 'local' : 'unknown'));
  const envColor  = env === 'production' ? '#34d399' : env === 'preview' ? '#16a34a' : '#7d8590';
  const svVer     = esc(s.sanityVersion  || '—');
  const footerHtml = `
    <div style="margin-top:18px;padding:12px 14px;background:#0d1117;border-radius:10px;
                font-size:10px;color:var(--muted);line-height:1.7">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-weight:700;letter-spacing:.5px;text-transform:uppercase">Build Info</span>
        <span style="background:${envColor}22;color:${envColor};padding:1px 7px;border-radius:4px;
                     font-weight:700;letter-spacing:.5px;text-transform:uppercase">${env}</span>
      </div>
      <div>Git SHA: <code style="color:var(--text)">${sha}</code></div>
      <div>Sanity: <code style="color:var(--text)">v${svVer}</code></div>
      <div>runId: <code style="color:var(--text);font-size:9px">${esc(s.runId || '—')}</code></div>
    </div>`;

  document.getElementById('admin-panel-content').innerHTML = `
    <div class="admin-status-banner ${bannerCls}">
      <span class="asb-icon">${bannerIcon}</span>
      <div>
        <div class="asb-title">${esc(bannerTitle)}</div>
        <div class="asb-sub">${esc(bannerSub)}</div>
      </div>
    </div>
    ${warnHtml}
    ${metaHtml}
    ${productHtml}
    ${chainsHtml}
    ${footerHtml}
  `;
}

// ── Close overlay ─────────────────────────────────────────────────────
window.closeAdminOverlay = async function(reason = 'manual') {
  await _closeAdminSession(reason); // telemetry — non-blocking for UI timing
  document.getElementById('admin-overlay').classList.remove('show');
  document.getElementById('admin-pin-input').value = '';
};

function adminTimeAgo(iso) {
  const diff = Math.round((Date.now() - new Date(iso)) / 1000);
  if (diff < 60)   return `לפני ${diff}ש`;
  if (diff < 3600) return `לפני ${Math.round(diff/60)}ד`;
  return `לפני ${Math.round(diff/3600)}ש`;
}

// initAdminGesture is called from connectToGroup() directly (line above auth block).

// ══════════════════════════════════════════════════
// PRICE CACHE SYSTEM v2
// Dual-layer: in-memory (30 min) + localStorage (6 h)
// Includes metadata: cachedAt, expiresAt, sourceCount, hasOfficial, hasManual
// ══════════════════════════════════════════════════
const _priceCache = {};
const PRICE_CACHE_TTL    = 30 * 60 * 1000;   // 30 min in-memory
const PRICE_CACHE_LS_TTL =  6 * 60 * 60 * 1000; // 6 h localStorage

function _pcKey(barcode) { return 'pc_' + barcode; }

function _pcLoadLS(barcode) {
  try {
    const raw = localStorage.getItem(_pcKey(barcode));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || Date.now() - (obj.ts || 0) > PRICE_CACHE_LS_TTL) return null;
    return obj;
  } catch(_) { return null; }
}
function _pcSaveLS(barcode, entry) {
  try { localStorage.setItem(_pcKey(barcode), JSON.stringify(entry)); } catch(_) {}
}
function _pcGet(barcode) {
  const m = _priceCache[barcode];
  if (m && Date.now() - m.ts < PRICE_CACHE_TTL) return m;
  const ls = _pcLoadLS(barcode);
  if (ls) { _priceCache[barcode] = ls; return ls; }
  return null;
}
function _pcSet(barcode, prices) {
  const now = Date.now();
  const entry = {
    prices, ts: now, barcode,
    cachedAt:    new Date(now).toISOString(),
    expiresAt:   new Date(now + PRICE_CACHE_TTL).toISOString(),
    sourceCount: prices.length,
    hasOfficial: prices.some(p => p.source === 'official' || p.source === 'user_override'),
    hasManual:   prices.some(p => p.source === 'manual'),
    hasOverrides:prices.some(p => p.override),
  };
  _priceCache[barcode] = entry;
  _pcSaveLS(barcode, entry);
  // Recompute basket totals whenever a barcode is cached/updated
  setTimeout(_updateListTotals, 50);
}
function _pcInvalidate(barcode) {
  delete _priceCache[barcode];
  try { localStorage.removeItem(_pcKey(barcode)); } catch(_) {}
}

// Fetch prices for a barcode, using cache when available.
// Returns { prices, ts, fromCache, stale? } or null on total failure.
// API barcode mode returns: { barcode, prices: [...], source, isStale, ... }
async function _fetchPricesForBarcode(barcode) {
  const cached = _pcGet(barcode);
  if (cached) return { ...cached, fromCache: true };
  if (!navigator.onLine) {
    // Offline — return stale entry if any (bypass TTL)
    const stale = _priceCache[barcode] || _pcLoadLS(barcode);
    if (stale) return { ...stale, stale: true, fromCache: true };
    return null;
  }
  try {
    let url = `/api/prices?barcode=${encodeURIComponent(barcode)}`;
    if (_hasLoc()) url += `&lat=${_locLat()}&lng=${_locLng()}&radiusKm=${_nearbyRadius}&includeApproximate=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.version) window._lastApiVersion = data.version;  // track deployed API build
    // Barcode mode: top-level { prices: [...] }
    const prices = (data.prices || []).filter(p => (p.displayPrice || p.price || 0) > 0);
    _pcSet(barcode, prices);
    return { prices, ts: Date.now(), fromCache: false };
  } catch(e) {
    console.warn('[priceCache] fetch failed:', barcode, e.message);
    // Prefer stale cache over empty — never erase valid data
    const stale = _priceCache[barcode] || _pcLoadLS(barcode);
    if (stale) return { ...stale, stale: true, fromCache: true };
    return null;
  }
}

// Fetch all price rows WITH per-store distance for the current location, by
// asking the API with a very large radius (price records carry no coords; the
// API joins store coords server-side and returns distanceKm). Used by System-1
// to partition nearby vs. outside-radius. Returns rows[] or null on failure.
async function _fetchPricesWithDistance(barcode) {
  if (!_hasLoc() || !navigator.onLine) return null;
  try {
    const url = `/api/prices?barcode=${encodeURIComponent(barcode)}`
      + `&lat=${_locLat()}&lng=${_locLng()}&radiusKm=99999&includeApproximate=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.prices || []).filter(p => (p.displayPrice || p.price || 0) > 0);
  } catch (_) { return null; }
}

// Client mirror of api/prices.js partitionByRadius (kept in sync; tested there).
function _partitionByRadius(prices, radiusKm) {
  const rows = Array.isArray(prices) ? prices : [];
  const nearby = [], outside = [], unknown = [];
  for (const p of rows) {
    if (p.distanceKm == null) unknown.push(p);
    else if (p.distanceKm <= radiusKm) nearby.push(p);
    else outside.push(p);
  }
  const cmp = (a, b) => {
    const pa = a.displayPrice ?? a.price ?? Infinity, pb = b.displayPrice ?? b.price ?? Infinity;
    if (pa !== pb) return pa - pb;
    const da = a.distanceKm ?? Infinity, db = b.distanceKm ?? Infinity;
    if (da !== db) return da - db;
    const ka = `${a.chainId||''}_${a.storeId||''}`, kb = `${b.chainId||''}_${b.storeId||''}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  nearby.sort(cmp); outside.sort(cmp);
  const cheapestOutside = outside[0] || null;
  const minNearby = nearby.length ? (nearby[0].displayPrice ?? nearby[0].price ?? Infinity) : Infinity;
  const outP = cheapestOutside ? (cheapestOutside.displayPrice ?? cheapestOutside.price ?? Infinity) : Infinity;
  return { nearby, outside, unknown, cheapestOutside,
           showOutsideCard: !!cheapestOutside && (nearby.length === 0 || outP < minNearby) };
}

// Client mirror of api/prices.js isStoreOpenNow (kept in sync; tested there).
function isStoreOpenNow(openingHours, now = new Date()) {
  if (!openingHours || typeof openingHours !== 'object') return null;
  const keys = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const today = openingHours[keys[now.getDay()]];
  if (today == null || today === '') return null;
  if (today === 'סגור' || /closed/i.test(String(today))) return false;
  const m = String(today).match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const cur = now.getHours()*60 + now.getMinutes();
  const open = (+m[1])*60 + (+m[2]); let close = (+m[3])*60 + (+m[4]);
  if (close < open) close += 1440;
  const curAdj = cur < open ? cur + 1440 : cur;
  return curAdj >= open && curAdj <= close;
}

// ── Freshness label ──────────────────────────────────────────────────────────
function _freshnessLabel(syncedAt) {
  if (!syncedAt) return { label: 'לא מעודכן', cls: 'fresh-stale' };
  const ageMs = Date.now() - new Date(syncedAt).getTime();
  const ageH  = ageMs / 3600000;
  if (ageH < 1)  return { label: 'עודכן עכשיו',               cls: 'fresh-now'   };
  if (ageH < 24) return { label: `לפני ${Math.floor(ageH)} ש'`, cls: 'fresh-hour'  };
  if (ageH < 48) return { label: 'אתמול',                      cls: 'fresh-day'   };
  return              { label: 'לא מעודכן',                    cls: 'fresh-stale' };
}

// ══════════════════════════════════════════════════
// OFFLINE DETECTION & EDIT QUEUE
// ══════════════════════════════════════════════════
const OFFLINE_QUEUE_KEY = 'priceEditQueue_v1';

function _updateOfflineIndicator() {
  document.getElementById('offline-pill')?.classList.toggle('show', !navigator.onLine);
}
function _queueOfflineEdit(path, data) {
  try {
    const q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
    q.push({ path, data, queuedAt: new Date().toISOString() });
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
    toast('📥 המחיר יסונכרן כשהחיבור יחזור');
  } catch(_) {}
}
async function _flushOfflineQueue() {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return;
    const q = JSON.parse(raw);
    if (!q.length) return;
    console.log('[offline queue] flushing', q.length, 'edits');
    for (const entry of q) {
      await set(ref(db, entry.path), entry.data); // throws on first failure
    }
    localStorage.removeItem(OFFLINE_QUEUE_KEY);
    toast('✅ מחירים ממתינים סונכרנו');
  } catch(e) {
    console.warn('[offline queue] flush failed:', e.message);
  }
}
window.addEventListener('online',  () => { _updateOfflineIndicator(); setTimeout(_flushOfflineQueue, 600); });
window.addEventListener('offline', _updateOfflineIndicator);
_updateOfflineIndicator();

// ══════════════════════════════════════════════════
// SHOPPING LIST PRICE CHIPS  (stability-safe)
// ══════════════════════════════════════════════════
let _chipBatchTimer = null;

async function loadItemPricesInBackground() {
  clearTimeout(_chipBatchTimer);
  _chipBatchTimer = setTimeout(async () => {
    const pending = Object.entries(items)
      .map(([id, v]) => ({ ...v, id }))
      .filter(i => !i.bought);

    for (const item of pending) {
      const barcode = item.barcode || item.attached?.barcode;
      if (!barcode || !isValidBarcode(barcode)) continue;
      const chipArea = document.getElementById('price-chip-' + item.id);
      if (!chipArea) continue;

      const alreadyLoaded = chipArea.dataset.loaded === '1';

      // Always fetch (cache-first) — but only show shimmer on first load
      try {
        const result = await _fetchPricesForBarcode(barcode);
        // Guard: chipArea might have been removed if list re-rendered during await
        if (!document.contains(chipArea)) continue;

        if (!result?.prices?.length) {
          if (!alreadyLoaded) chipArea.innerHTML = '';
          continue;
        }

        const prices = result.prices;
        const best   = prices[0];
        const qty    = item.qty || 1;
        const totalP = (best.displayPrice || best.price || 0) * qty;
        const isStale  = best.isStale || result.stale;
        const hasMulti = prices.length > 1;
        const chainLabel = esc(best.chainName || best.storeName || '');

        // Stable fingerprint — browsers normalise innerHTML so string compare is unreliable.
        // Instead compare the values that would cause a visible change.
        const fingerprint = `${totalP.toFixed(2)}|${chainLabel}|${isStale?1:0}|${hasMulti?1:0}|${qty}`;
        if (chipArea.dataset.fingerprint !== fingerprint) {
          chipArea.innerHTML = `<button class="price-chip${hasMulti?' best':''}${isStale?' stale':''}"
            onclick="openPriceChipDetail('${item.id}')"
            title="השווה מחירים">
            <span>₪${totalP.toFixed(2)}</span>
            <span style="font-size:9px;opacity:.7">${chainLabel}</span>
            ${qty > 1 ? `<span style="opacity:.55">×${qty}</span>` : ''}
            ${isStale ? '<span style="color:var(--red)">⚠</span>' : ''}
          </button>`;
          chipArea.dataset.fingerprint = fingerprint;
        }
        chipArea.dataset.loaded = '1';
      } catch(e) {
        // Never erase an existing chip on failure
        if (!alreadyLoaded) {
          const el = document.getElementById('price-chip-' + item.id);
          if (el) el.innerHTML = '';
        }
      }
    }
    // Always recompute basket totals after chip pass
    _updateListTotals();
  }, 150);
}

// ══════════════════════════════════════════════════
// BASKET TOTALS BAR
// ══════════════════════════════════════════════════
function _updateListTotals() {
  const bar      = document.getElementById('basket-totals-bar');
  const priceEl  = document.getElementById('bt-price');
  const savingEl = document.getElementById('bt-saving');
  if (!bar || !priceEl) return;
  // Only show on the "all" tab
  if (curTab !== 'all') { bar.classList.remove('show'); return; }

  const pending = Object.entries(items)
    .map(([id, v]) => ({ ...v, id }))
    .filter(i => !i.bought);

  if (!pending.length) { bar.classList.remove('show'); return; }

  let bestTotal  = 0;
  let worstTotal = 0;
  let covered    = 0;

  for (const item of pending) {
    const barcode = item.barcode || item.attached?.barcode;
    if (!barcode) continue;
    const cached = _pcGet(barcode);
    if (!cached?.prices?.length) continue;
    const sorted  = [...cached.prices].sort((a, b) => (a.displayPrice||a.price||0) - (b.displayPrice||b.price||0));
    const qty     = item.qty || 1;
    bestTotal  += (sorted[0].displayPrice || sorted[0].price || 0) * qty;
    worstTotal += (sorted[sorted.length-1].displayPrice || sorted[sorted.length-1].price || 0) * qty;
    covered++;
  }

  if (!covered) { bar.classList.remove('show'); return; }

  const saving = worstTotal - bestTotal;
  bar.classList.add('show');
  priceEl.textContent = '₪' + bestTotal.toFixed(2);
  if (savingEl) {
    if (saving > 0.1) {
      savingEl.innerHTML = `חסכון אפשרי: <strong style="color:var(--green)">₪${saving.toFixed(2)}</strong>
        <small>(${covered}/${pending.length} פריטים)</small>`;
    } else {
      savingEl.innerHTML = `<small>${covered}/${pending.length} פריטים עם מחיר</small>`;
    }
  }
}

// ══════════════════════════════════════════════════
// PRICE DETAIL BOTTOM SHEET  (cache-first + real-time)
// ══════════════════════════════════════════════════
let _pdBarcode   = null;
let _pdName      = '';
let _pdQty       = 1;
let _pdSort      = 'cheapest';
let _pdFilters   = new Set();
let _pdPrices    = [];
let _pdFromCache = false;
let _pdUnsub     = null;   // Firebase real-time unsub
let _pdLastUpdateBy = null; // track who just updated for notification

// Stable-key entry from the list price chip. Looks the item up by its Firebase
// id (safe inline) so a product NAME — single- or multi-word, with quotes,
// apostrophes, % — is never embedded in an HTML attribute (which truncated the
// old onclick and broke the chip click for every product). Barcode is the
// primary lookup key; name is used only for the modal title.
window.openPriceChipDetail = function(id) {
  const it = items[id];
  if (!it) return;
  const bc = it.barcode || it.attached?.barcode || '';
  if (!bc || !isValidBarcode(bc)) return;
  openPriceDetailModal(bc, it.name || '', it.qty || 1);
};

window.openPriceDetailModal = async function(barcode, name, qty) {
  if (!barcode) return;
  _pdBarcode   = barcode;
  _pdName      = name || '';
  _pdQty       = qty  || 1;
  _pdSort      = 'cheapest';
  _pdFilters   = new Set();
  _pdLastUpdateBy = null;

  const overlay = document.getElementById('price-detail-overlay');
  const body    = document.getElementById('pd-body');
  const nameEl  = document.getElementById('pd-product-name');
  const qtyEl   = document.getElementById('pd-qty-badge');

  if (nameEl) nameEl.textContent = _pdName || 'מחירים';
  if (qtyEl)  { qtyEl.style.display = _pdQty > 1 ? '' : 'none'; qtyEl.textContent = '×' + _pdQty; }

  // Reset sort/filter UI
  document.querySelectorAll('.pd-sort-btn').forEach(b  => b.classList.remove('active'));
  document.querySelectorAll('.pd-filter-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('pd-sort-cheapest')?.classList.add('active');

  // Detach previous real-time listener
  if (_pdUnsub) { _pdUnsub(); _pdUnsub = null; }

  overlay?.classList.add('show');
  document.body.classList.add('sheet-open');

  // ── Cache-first: render immediately if cached ────────────────────────────
  const cached = _pcGet(barcode);
  if (cached?.prices?.length) {
    _pdPrices    = cached.prices;
    _pdFromCache = true;
    _renderPriceDetail();
    // Background refresh — do NOT show loading spinner
    _fetchPricesForBarcode(barcode).then(result => {
      if (result && !result.fromCache && _pdBarcode === barcode) {
        _pdPrices    = result.prices;
        _pdFromCache = false;
        _renderPriceDetail();
      }
    }).catch(() => {}); // silently ignore — cached data stays visible
  } else {
    // No cache — show loading spinner and wait
    if (body) body.innerHTML = `<div class="pd-loading"><div class="spin"></div><p>טוען מחירים...</p></div>`;
    const result = await _fetchPricesForBarcode(barcode).catch(() => null);
    _pdPrices    = result?.prices || [];
    _pdFromCache = result?.fromCache || false;
    const isOffline = !navigator.onLine;

    // Fallback: search by name if barcode returns nothing and we're online
    if (!_pdPrices.length && _pdName && !isOffline) {
      try {
        let url = `/api/prices?q=${encodeURIComponent(_pdName)}`;
        if (_hasLoc()) url += `&lat=${_locLat()}&lng=${_locLng()}&radiusKm=${_nearbyRadius}`;
        const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        const match = (data.results || []).find(r => r.barcode === barcode) || data.results?.[0];
        _pdPrices = (match?.prices || []).filter(p => (p.displayPrice || p.price || 0) > 0);
        if (_pdPrices.length) _pcSet(barcode, _pdPrices);
      } catch(_) {}
    }
    _renderPriceDetail();
  }

  // ── Real-time Firebase listener for family manual prices ──────────────────
  if (groupId && db) {
    const manualPath = `manualPrices/${groupId}/${barcode}`;
    let firstSnap = true;
    _pdUnsub = onValue(ref(db, manualPath), snap => {
      if (firstSnap) { firstSnap = false; return; } // skip initial event
      if (!document.getElementById('price-detail-overlay')?.classList.contains('show')) return;
      if (_pdBarcode !== barcode) return;
      // A family member updated — invalidate cache and refresh
      _pcInvalidate(barcode);
      _fetchPricesForBarcode(barcode).then(result => {
        if (!result) return;
        const prevBest = _pdPrices[0]?.displayPrice;
        _pdPrices = result.prices || [];
        // Detect who updated (last submittedByDisplayName from manual entries)
        if (snap.exists()) {
          const vals = Object.values(snap.val() || {});
          const latest = vals.sort((a,b) => (b.submittedAt||'') > (a.submittedAt||'') ? 1 : -1)[0];
          if (latest?.submittedByDisplayName && latest.submittedByDisplayName !== myName) {
            _pdLastUpdateBy = latest.submittedByDisplayName;
          }
        }
        _renderPriceDetail();
        // Animate updated rows
        setTimeout(() => {
          document.querySelectorAll('.pd-row').forEach(r => {
            r.classList.add('price-updated');
            setTimeout(() => r.classList.remove('price-updated'), 1400);
          });
        }, 100);
      }).catch(() => {});
    });
  }
};

window.closePriceDetail = function() {
  document.getElementById('price-detail-overlay')?.classList.remove('show');
  document.body.classList.remove('sheet-open');
  if (_pdUnsub) { _pdUnsub(); _pdUnsub = null; }
};

window.setPdSort = function(mode) {
  _pdSort = mode;
  document.querySelectorAll('.pd-sort-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('pd-sort-' + mode)?.classList.add('active');
  _renderPriceDetail();
};

window.togglePdFilter = function(type) {
  const btn = document.getElementById('pd-filter-' + type);
  if (_pdFilters.has(type)) { _pdFilters.delete(type); btn?.classList.remove('active'); }
  else                      { _pdFilters.add(type);    btn?.classList.add('active');    }
  _renderPriceDetail();
};

function _renderPriceDetail() {
  const body = document.getElementById('pd-body');
  if (!body) return;

  // ── Banners ──────────────────────────────────────────────────────────────
  const updateByBanner = _pdLastUpdateBy
    ? `<div class="pd-updated-by">✨ ${esc(_pdLastUpdateBy)} עדכן מחיר זה עכשיו</div>` : '';
  const offlineBanner  = !navigator.onLine
    ? `<div class="pd-warn-banner">📵 מציג מחירים ממטמון — אין חיבור לרשת</div>` : '';
  const staleBanner    = _pdFromCache && _pcGet(_pdBarcode)?.ts && (Date.now() - _pcGet(_pdBarcode).ts > PRICE_CACHE_TTL * 0.9)
    ? `<div class="pd-warn-banner">⚠ ייתכן שהמחירים אינם עדכניים לחלוטין</div>` : '';

  if (!_pdPrices.length) {
    body.innerHTML = updateByBanner + offlineBanner + `
      <div class="pd-empty">
        <div class="pe-icon">🔍</div>
        <div style="font-size:14px;font-weight:700;margin-bottom:6px">אין מחירים זמינים</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:14px">
          ${!navigator.onLine ? 'אין חיבור — לא ניתן לחפש מחירים' : 'לא נמצאו מחירים רשמיים. הוסף ידנית:'}
        </div>
      </div>
      ${navigator.onLine ? `<button class="pd-manual-btn" onclick="openMp2(${JSON.stringify(_pdBarcode)},${JSON.stringify(_pdName)},false,'',0)">📝 הוסף מחיר ידנית</button>` : ''}`;
    return;
  }

  // ── Filter ───────────────────────────────────────────────────────────────
  let filtered = [..._pdPrices];
  if (_pdFilters.size > 0) {
    filtered = filtered.filter(p => {
      const src = p.source || '';
      if (_pdFilters.has('official') && (src === 'official' || src === 'user_override' || src === 'proxy')) return true;
      if (_pdFilters.has('manual')   && src === 'manual') return true;
      if (_pdFilters.has('approx')   && p.approximateLocation) return true;
      return false;
    });
  }

  // ── Sort ─────────────────────────────────────────────────────────────────
  if (_pdSort === 'nearest') {
    filtered.sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
  } else if (_pdSort === 'fresh') {
    filtered.sort((a, b) => {
      const ta = a.syncedAt ? new Date(a.syncedAt).getTime() : 0;
      const tb = b.syncedAt ? new Date(b.syncedAt).getTime() : 0;
      return tb - ta;
    });
  } else {
    filtered.sort((a, b) => (a.displayPrice || a.price || 0) - (b.displayPrice || b.price || 0));
  }

  if (!filtered.length) {
    body.innerHTML = updateByBanner + `<div class="pd-empty">
      <div class="pe-icon">🔍</div>
      <div style="font-size:13px;font-weight:600;margin-bottom:6px">אין תוצאות לסינון הנוכחי</div>
      <div style="font-size:12px;color:var(--muted)">נסה להסיר את הסינון</div>
    </div>`;
    return;
  }

  // ── Summary hero ─────────────────────────────────────────────────────────
  const qty      = _pdQty || 1;
  const bestRaw  = (filtered[0].displayPrice  || filtered[0].price  || 0);
  const worstRaw = (filtered[filtered.length-1].displayPrice || filtered[filtered.length-1].price || 0);
  const bestTot  = bestRaw  * qty;
  const worstTot = worstRaw * qty;
  const saving   = worstTot - bestTot;

  const summaryHTML = filtered.length > 1 ? `
    <div class="pd-summary">
      <div class="pd-summary-min">₪${bestTot.toFixed(2)}</div>
      <div class="pd-summary-sep">—</div>
      <div class="pd-summary-max">₪${worstTot.toFixed(2)}</div>
      ${qty > 1 ? `<div style="font-size:10px;color:var(--muted)">×${qty}</div>` : ''}
      ${saving > 0.05 ? `<div class="pd-summary-save">אפשר לחסוך עד<br><strong>₪${saving.toFixed(2)}</strong></div>` : ''}
    </div>` : '';

  // ── Price rows ───────────────────────────────────────────────────────────
  // Store data is cached in _sdRows[] by index to avoid unsafe inline JSON.
  window._sdRows = [];

  const rowsHTML = filtered.map((p, i) => {
    const isBest      = i === 0;
    const displayP    = (p.displayPrice || p.price || 0);
    const totalP      = displayP * qty;
    const src         = p.source || '';
    const isOverride  = !!p.override;
    const badge       = sourceBadge(p.sourceDisplay || src, p.submittedByDisplayName);
    const chainName   = p.chainName || p.chainId || '';
    const storeName   = (p.storeName && p.storeName !== p.chainName) ? p.storeName : '';
    const chainKey    = `${p.chainId || chainName.replace(/\s/g,'_')}_${p.storeId || '0'}`;
    const approxMark  = p.approximateLocation ? `<span class="approx-badge">~משוער</span>` : '';

    // Freshness label
    const freshInfo   = _freshnessLabel(p.syncedAt);
    const freshBadge  = `<span class="fresh-label ${freshInfo.cls}">${freshInfo.label}</span>`;

    const metaParts = [];
    if (p.city)            metaParts.push(esc(p.city));
    if (p.distanceKm != null) metaParts.push(`📍 ${p.distanceKm} ק"מ`);

    // Cache store data for the details modal (safe index reference, no inline JSON)
    const sdIdx = window._sdRows.length;
    window._sdRows.push({
      chainName, chainId: p.chainId || '',
      storeId: p.storeId || '', storeName: p.storeName || '',
      city: p.city || '', address: p.address || '',
      distanceKm: p.distanceKm ?? null,
      latitude: p.latitude ?? null, longitude: p.longitude ?? null,
      approximateLocation: p.approximateLocation || false,
      openingHours: p.openingHours || null,
    });

    const actionBtns = (src === 'official' || src === 'user_override') ? `
      <div class="pd-row-actions">
        <button class="pd-row-act"
          onclick="event.stopPropagation();openMp2(${JSON.stringify(_pdBarcode)},${JSON.stringify(_pdName)},true,${JSON.stringify(chainName)},${displayP})">✏️ תקן</button>
        <button class="pd-row-act"
          onclick="event.stopPropagation();openReportModal(${JSON.stringify(chainKey)},${JSON.stringify(chainName)},${displayP},${JSON.stringify(_pdName)})">🚨 דווח</button>
      </div>` : '';

    // Override rows get a distinct background; all rows are tappable → opens store detail
    const rowCls = ['pd-row', isBest ? 'best' : '', isOverride ? 'is-override' : ''].filter(Boolean).join(' ');

    return `<div class="${rowCls}" data-tappable="1"
        data-barcode="${esc(_pdBarcode)}" data-chain="${esc(chainName)}"
        data-store="${esc(p.storeId||'')}" data-source="${esc(src)}"
        onclick="openStoreDetail(window._sdRows[${sdIdx}])">
      <div class="pd-row-left">
        ${isBest && filtered.length > 1 ? '<div class="pd-row-trophy">🏆 הכי זול לידך</div>' : ''}
        <div class="pd-row-chain">${esc(chainName)} ${badge} ${approxMark}</div>
        ${storeName ? `<div class="pd-row-store">${esc(storeName)}</div>` : ''}
        <div class="pd-row-meta">${metaParts.join(' · ')}</div>
        <div class="pd-row-meta">${freshBadge} ${p.isStale ? '<span class="pd-row-stale">⚠ מחיר ישן</span>' : ''}</div>
        ${isOverride ? '<div style="font-size:10px;color:var(--blue);margin-top:2px">✏️ תיקון אישי שלך · המחיר הרשמי לא השתנה</div>' : ''}
        ${actionBtns}
      </div>
      <div class="pd-row-right">
        <div class="pd-row-price">₪${totalP.toFixed(2)}</div>
        ${qty > 1 ? `<div class="pd-row-unit">₪${displayP.toFixed(2)} יח'</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const hasOfficial = filtered.some(p => p.source === 'official' || p.source === 'user_override');
  body.innerHTML = updateByBanner + offlineBanner + staleBanner + summaryHTML + rowsHTML + `
    <button class="pd-manual-btn" onclick="openMp2(${JSON.stringify(_pdBarcode)},${JSON.stringify(_pdName)},${hasOfficial},'',0)">
      📝 ${hasOfficial ? 'תקן / הוסף מחיר' : 'הוסף מחיר ידנית'}
    </button>`;
}

// ══════════════════════════════════════════════════
// MANUAL PRICE MODAL v2 — unified personal + family
// ══════════════════════════════════════════════════
let _mp2Context = null;
let _mp2Tab     = 'override';

window.openMp2 = function(barcode, name, hasOfficial, store, officialPrice) {
  _mp2Context = { barcode, name, hasOfficial, store: store || '', officialPrice: +officialPrice || 0 };
  _mp2Tab     = hasOfficial ? 'override' : 'family';

  const titleEl   = document.getElementById('mp2-title');
  const productEl = document.getElementById('mp2-product');
  const storeEl   = document.getElementById('mp2-store-input');
  const priceEl   = document.getElementById('mp2-price-input');
  const tabOvr    = document.getElementById('mp2-tab-override');

  if (titleEl)   titleEl.textContent   = hasOfficial ? '✏️ תיקון / הוספת מחיר' : '📝 הוסף מחיר';
  if (productEl) productEl.textContent = name || '';
  if (storeEl)   storeEl.value  = store || '';
  if (priceEl)   priceEl.value  = '';
  if (tabOvr)    tabOvr.style.display  = hasOfficial ? '' : 'none';

  setMp2Tab(_mp2Tab);
  document.getElementById('mp2-overlay')?.classList.add('show');
  document.body.classList.add('sheet-open');
  setTimeout(() => priceEl?.focus(), 320);
};

window.closeMp2 = function() {
  document.getElementById('mp2-overlay')?.classList.remove('show');
  document.body.classList.remove('sheet-open');
};

window.setMp2Tab = function(tab) {
  _mp2Tab = tab;
  document.querySelectorAll('.mp2-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('mp2-tab-' + tab)?.classList.add('active');

  const hintEl  = document.getElementById('mp2-hint');
  const storeEl = document.getElementById('mp2-store-input');
  const ctx     = _mp2Context;
  const offP    = ctx?.officialPrice ? `₪${ctx.officialPrice.toFixed(2)}` : null;

  if (tab === 'override') {
    if (hintEl) hintEl.innerHTML =
      `<strong>תיקון אישי</strong> — גלוי רק לך, לא לשאר המשפחה.<br>
       המחיר הרשמי <strong>נשאר ללא שינוי</strong>${offP ? ` (${offP})` : ''} לשאר המשתמשים.`;
    if (storeEl) storeEl.style.display = 'none';
  } else {
    if (hintEl) hintEl.innerHTML =
      `<strong>מחיר משפחה</strong> — גלוי לכל חברי הקבוצה.<br>
       השתמש רק כשאין מחיר רשמי — מחיר רשמי תמיד גובר.`;
    if (storeEl) storeEl.style.display = '';
  }
};

window.saveMp2Price = async function() {
  if (!_mp2Context) return;
  const { barcode, name, store, officialPrice } = _mp2Context;
  const priceEl = document.getElementById('mp2-price-input');
  const storeEl = document.getElementById('mp2-store-input');

  const price = parseFloat(priceEl?.value);
  if (!isValidPrice(price)) { toast('⚠️ הכנס מחיר תקין'); return; }
  if (!isValidBarcode(barcode)) { toast('⚠️ ברקוד לא תקין'); return; }

  if (_mp2Tab === 'override') {
    const storeName = store || 'לא ידוע';
    const chainKey  = storeName.replace(/\s/g,'_') + '_0';
    const now       = new Date().toISOString();
    const path      = `userPriceOverrides/${myId}/${barcode}/${chainKey}`;
    const data      = {
      barcode, chainId: chainKey.split('_')[0], chainName: storeName,
      storeId: '0', storeName, officialPrice: officialPrice || null,
      overridePrice: Math.round(price * 100) / 100,
      reason: null, createdAt: now, updatedAt: now, source: 'user_override',
    };
    if (!navigator.onLine) { _queueOfflineEdit(path, data); closeMp2(); return; }
    try {
      await set(ref(db, path), data);
      closeMp2();
      _pcInvalidate(barcode);
      toast(`✏️ תיקון אישי נשמר ב${storeName}`);
      _refreshPdAfterSave(barcode);
    } catch(e) { toast('❌ ' + e.message); }
  } else {
    if (!groupId) { toast('⚠️ לא חובר לקבוצה'); return; }
    const storeName = sanitize(storeEl?.value || 'לא ידוע', 60);
    const m         = myProfile || {};
    const entryId   = `m_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const path      = `manualPrices/${groupId}/${barcode}/${entryId}`;
    const data      = {
      barcode, name: sanitize(name, 100),
      price: Math.round(price * 100) / 100,
      chainName: storeName, storeName, groupId,
      submittedByUserId:      myId,
      submittedByDisplayName: myName,
      submittedByAvatarType:  m.avatarType  || 'emoji',
      submittedByAvatarValue: m.avatarValue || '👤',
      submittedByAvatarEmoji: m.avatarEmoji || null,
      submittedAt: new Date().toISOString(),
      source: 'manual',
    };
    if (!navigator.onLine) { _queueOfflineEdit(path, data); closeMp2(); return; }
    try {
      await set(ref(db, path), data);
      closeMp2();
      _pcInvalidate(barcode);
      toast(`💰 ₪${price.toFixed(2)} ב${storeName} נשמר לקבוצה`);
      _refreshPdAfterSave(barcode);
    } catch(e) { toast('❌ ' + e.message); }
  }
};

// Refresh price detail sheet after a save — without full loading spinner
async function _refreshPdAfterSave(barcode) {
  const overlay = document.getElementById('price-detail-overlay');
  if (!overlay?.classList.contains('show') || _pdBarcode !== barcode) return;
  // Fetch fresh data (cache already invalidated)
  const res  = await _fetchPricesForBarcode(barcode).catch(() => null);
  if (res?.prices) { _pdPrices = res.prices; _renderPriceDetail(); }
}

// ══════════════════════════════════════════════════
// STAGE 2 — SEARCH CLEAR BUTTON
// ══════════════════════════════════════════════════
function _updatePsiClear() {
  const btn = document.getElementById('psi-clear');
  if (!btn) return;
  btn.classList.toggle('show', (document.getElementById('price-search-input')?.value?.length || 0) > 0);
}

window.clearPriceSearch = function() {
  const inp = document.getElementById('price-search-input');
  if (inp) { inp.value = ''; inp.focus(); }
  _updatePsiClear();
  const wrap = document.getElementById('price-content');
  if (wrap) wrap.innerHTML = `<div class="search-hint">
    <div class="sh-icon">🔍</div>
    <p>חפש מוצר לקבלת מחירים</p>
    <small>קורנפלקס, חלב, ביצים...</small>
  </div>`;
  searchResults = [];
  if (typeof lastSearchQuery !== 'undefined') lastSearchQuery = '';
  if (typeof selectedProduct !== 'undefined') selectedProduct = null;
  document.getElementById('price-tools')?.setAttribute('style', 'display:none');
  document.getElementById('sr-filter-row')?.setAttribute('style', 'display:none');
};

// ══════════════════════════════════════════════════
// STAGE 1 — STORE DETAILS MODAL
// ══════════════════════════════════════════════════
let _sdStore = null;

window.openStoreDetail = function(storeData) {
  if (!storeData) return;
  _sdStore = storeData;

  // Header
  document.getElementById('sd-chain').textContent = storeData.chainName || '';
  const nameEl = document.getElementById('sd-name');
  nameEl.textContent = (storeData.storeName && storeData.storeName !== storeData.chainName)
    ? storeData.storeName : storeData.chainName || '';
  document.getElementById('sd-city').textContent = storeData.city || '';

  // Confidence + distance tags
  const tags = [];
  if (storeData.approximateLocation) {
    tags.push(`<span class="sd-tag approx">📍 מיקום משוער</span>`);
  } else if (storeData.latitude) {
    tags.push(`<span class="sd-tag precise">✅ מיקום מדויק</span>`);
  }
  if (storeData.distanceKm != null) {
    tags.push(`<span class="sd-tag dist">📏 ${storeData.distanceKm} ק"מ ממך</span>`);
  }
  // Open/closed badge (only when hours data is parseable — never guess)
  const openNow = isStoreOpenNow(storeData.openingHours);
  if (openNow === true)  tags.push(`<span class="sd-tag" style="background:var(--green-dim);color:var(--green)">🟢 פתוח עכשיו</span>`);
  if (openNow === false) tags.push(`<span class="sd-tag" style="background:rgba(248,113,113,.12);color:var(--red)">🔴 סגור עכשיו</span>`);
  // Selected product price + price-per-unit
  if (storeData.price != null) {
    tags.push(`<span class="sd-tag" style="background:var(--accent-dim);color:var(--accent)">₪${Number(storeData.price).toFixed(2)}</span>`);
    const qty = parseFloat(storeData.quantity);
    if (qty > 0 && storeData.unit) {
      const per = (Number(storeData.price) / qty);
      tags.push(`<span class="sd-tag" style="color:var(--muted)">₪${per.toFixed(2)} ל-1 ${esc(storeData.unit)}</span>`);
    }
  }
  // Last updated (Part 4 fallback when missing)
  tags.push(storeData.syncedAt
    ? `<span class="sd-tag" style="color:var(--muted)">🕒 ${_freshnessLabel(storeData.syncedAt).label}</span>`
    : `<span class="sd-tag" style="color:var(--muted)">🕒 עדכון אחרון לא זמין</span>`);
  document.getElementById('sd-tags').innerHTML = tags.join('');

  // Address section
  const addrSec = document.getElementById('sd-address-sec');
  const addrEl  = document.getElementById('sd-address');
  if (storeData.address || storeData.city) {
    const parts = [storeData.address, storeData.city].filter(Boolean);
    addrEl.textContent = parts.join(', ');
    addrSec.style.display = '';
  } else {
    addrSec.style.display = 'none';
  }

  // Opening hours
  const hoursSec     = document.getElementById('sd-hours-sec');
  const hoursContent = document.getElementById('sd-hours-content');
  const oh = storeData.openingHours;
  if (oh && typeof oh === 'object' && Object.keys(oh).length > 0) {
    const dayKeys  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
    const todayKey = dayKeys[new Date().getDay()];
    hoursContent.innerHTML = `<div class="sd-hours-grid">` +
      dayKeys.map((k, idx) => {
        const isToday = k === todayKey;
        const cls     = isToday ? ' sd-hours-today' : '';
        return `<div class="sd-hours-day${cls}">${dayNames[idx]}:</div>
                <div class="sd-hours-time${cls}">${esc(oh[k] || 'סגור')}</div>`;
      }).join('') +
      `</div>`;
  } else {
    hoursContent.innerHTML = `<div class="sd-fallback">שעות פעילות לא זמינות כרגע</div>`;
  }
  hoursSec.style.display = '';

  document.getElementById('sd-overlay')?.classList.add('show');
  document.body.classList.add('sheet-open');
};

window.closeStoreDetail = function() {
  document.getElementById('sd-overlay')?.classList.remove('show');
  document.body.classList.remove('sheet-open');
};

window.navigateToStore = function() {
  if (!_sdStore) return;
  const { latitude, longitude, address, storeName, chainName, city } = _sdStore;
  let url;
  if (latitude && longitude) {
    url = `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`;
  } else if (address || city) {
    const q = encodeURIComponent([address, city].filter(Boolean).join(', '));
    url = `https://www.google.com/maps/search/?api=1&query=${q}`;
  } else {
    const q = encodeURIComponent((storeName || chainName || '') + (city ? ' ' + city : ''));
    url = `https://www.google.com/maps/search/?api=1&query=${q}`;
  }
  window.open(url, '_blank');
};

window.searchStoreProducts = function() {
  if (!_sdStore) return;
  closeStoreDetail();
  setTab('price');
  const name = _sdStore.storeName || _sdStore.chainName || '';
  toast(`🔍 חיפוש מוצרים ב${name}`);
};

window.compareListAtStore = function() {
  closeStoreDetail();
  openBasketCompare(_sdStore);
};

// ══════════════════════════════════════════════════
// STAGE 3 — FULL BASKET COMPARISON
// ══════════════════════════════════════════════════
let _bcAbort = null;
let _bcFocusStore = null; // optional store to highlight

window.openBasketCompare = async function(focusStore = null) {
  _bcFocusStore = focusStore || null;
  const overlay = document.getElementById('bc-overlay');
  const body    = document.getElementById('bc-body');
  const sub     = document.getElementById('bc-sub');
  if (!overlay || !body) return;

  overlay.classList.add('show');
  document.body.classList.add('sheet-open');

  // Gather items with barcodes
  const listItems = Object.entries(items || {})
    .map(([id, v]) => ({ ...v, id }))
    .filter(i => {
      if (i.bought) return false;
      const bc = i.barcode || i.attached?.barcode;
      return bc && isValidBarcode(bc);
    });

  if (!listItems.length) {
    body.innerHTML = `<div style="text-align:center;padding:50px 20px">
      <div style="font-size:40px;margin-bottom:10px">🛒</div>
      <div style="font-size:14px;font-weight:700;margin-bottom:6px">אין מוצרים עם ברקוד ברשימה</div>
      <div style="font-size:12px;color:var(--muted)">הוסף ברקוד למוצרים כדי להשוות מחירים</div>
    </div>`;
    if (sub) sub.textContent = '';
    return;
  }

  const hasLoc  = _hasLoc();
  const payload = {
    items: listItems.map(i => ({
      barcode:  i.barcode || i.attached?.barcode,
      name:     i.name || '',
      quantity: i.qty || 1,
    })),
    ...(hasLoc ? { lat: _locLat(), lng: _locLng(), radiusKm: _nearbyRadius } : {}),
    includeApproximate: false,
    ...(groupId ? { groupId } : {}),
  };

  body.innerHTML = `<div class="bc-loading"><div class="spin"></div>
    <p>משווה את כל הרשימה...</p></div>`;
  if (sub) sub.textContent =
    `${listItems.length} מוצרים${hasLoc ? ` · עד ${_nearbyRadius} ק"מ` : ' · כל הארץ'}`;

  try {
    if (_bcAbort) _bcAbort.abort();
    const ctrl = new AbortController();
    _bcAbort   = ctrl;
    const res  = await fetch('/api/basket-compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _bcAbort = null;
    _renderBasketCompare(data, payload.items);
  } catch (e) {
    if (e.name === 'AbortError') return;
    body.innerHTML = `<div style="text-align:center;padding:40px 16px">
      <div style="font-size:36px;margin-bottom:10px">⚠️</div>
      <div style="font-size:14px;font-weight:700;margin-bottom:6px">לא ניתן לטעון נתונים</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:14px">${esc(e.message)}</div>
      <div class="bc-action-btns">
        <button class="bc-action-btn primary" onclick="openBasketCompare(_bcFocusStore)">🔄 נסה שוב</button>
      </div>
    </div>`;
  }
};

window.closeBasketCompare = function() {
  document.getElementById('bc-overlay')?.classList.remove('show');
  document.body.classList.remove('sheet-open');
  if (_bcAbort) { _bcAbort.abort(); _bcAbort = null; }
};

function _renderBasketCompare(data, requestItems) {
  const body = document.getElementById('bc-body');
  if (!body) return;

  const results  = data.results || [];
  const full     = results.filter(s => !(s.missingItems?.length));
  const partial  = results.filter(s => (s.missingItems?.length || 0) > 0 && s.availableItems > 0);
  const cheapest = data.bestFullBasket;
  const hasLoc   = _hasLoc();
  let html = '';

  if (!results.length) {
    body.innerHTML = `<div class="bc-no-full">
      <div class="bc-ns-icon">🔍</div>
      <p>לא מצאנו חנויות עם מחירים${hasLoc ? ' בטווח הזה' : ''}</p>
      <small>ייתכן שהמחירים טרם סונכרנו לאזור שלך</small>
      <div class="bc-action-btns" style="margin-top:10px">
        ${hasLoc ? `<button class="bc-action-btn primary" onclick="_bcIncreaseRadius()">🔭 הגדל רדיוס ל-${_nextRadius()} ק"מ</button>` : ''}
        <button class="bc-action-btn" onclick="_bcSearchAll()">🌍 השווה ללא סינון מיקום</button>
      </div>
    </div>`;
    return;
  }

  // Hero — cheapest full basket
  if (cheapest) {
    const nextTotal = full.length > 1 ? full[1].total : null;
    const maxTotal  = full.length > 1 ? full[full.length - 1].total : null;
    const savingVsNext = nextTotal != null ? (nextTotal - cheapest.total) : 0;
    const savingVsMax  = maxTotal  != null ? (maxTotal  - cheapest.total) : 0;
    const nameLine = [cheapest.chainName, cheapest.storeName !== cheapest.chainName ? cheapest.storeName : '']
      .filter(Boolean).join(' — ');
    html += `<div class="bc-hero">
      <div class="bc-hero-label">🏆 הכי זול בשבילך</div>
      <div class="bc-hero-name">${esc(nameLine)}</div>
      <div class="bc-hero-city">${esc(cheapest.city || '')}${cheapest.distanceKm != null ? ` · 📍 ${cheapest.distanceKm} ק"מ` : ''}</div>
      <div class="bc-hero-price">₪${cheapest.total.toFixed(2)}</div>
      ${savingVsNext > 0.05 ? `<div class="bc-hero-saving">חסכת ₪${savingVsNext.toFixed(2)} לעומת הסופר הבא</div>` : ''}
      ${savingVsMax  > 0.05 ? `<div class="bc-hero-note">אפשר לחסוך עד ₪${savingVsMax.toFixed(2)} לעומת הסופר היקר ביותר</div>` : ''}
      <div class="bc-hero-actions">
        <button class="bc-hero-btn" onclick="navigateToStoreDirect(${cheapest.latitude},${cheapest.longitude},${JSON.stringify(cheapest.address||'')},${JSON.stringify(nameLine)})">🗺 נווט</button>
        <button class="bc-hero-btn ghost" onclick="_bcToggleBreakdown(0)">📋 פירוט</button>
      </div>
    </div>`;
  } else if (!full.length && partial.length) {
    // No complete basket anywhere
    html += `<div class="bc-no-full">
      <div class="bc-ns-icon">⚠️</div>
      <p>לא מצאנו סופר אחד עם כל הרשימה${hasLoc ? ' בטווח הזה' : ''}</p>
      <small>הוצגות החנויות עם הכי הרבה מוצרים זמינים</small>
      <div class="bc-action-btns" style="margin-top:8px">
        ${hasLoc ? `<button class="bc-action-btn primary" onclick="_bcIncreaseRadius()">🔭 הגדל רדיוס ל-${_nextRadius()} ק"מ</button>` : ''}
        <button class="bc-action-btn" onclick="_bcSearchAll()">🌍 השווה ללא סינון מיקום</button>
        <button class="bc-action-btn" onclick="_bcSplitShopping()">✂️ פצל קנייה בין כמה סופרים</button>
      </div>
    </div>`;
  }

  // Full basket results
  if (full.length > 0) {
    if (full.length > 1) html += `<span class="bc-section-title">כל הרשימה — ${full.length} חנויות</span>`;
    full.forEach((s, i) => { html += _bcRenderCard(s, i, cheapest?.total, i === 0 && !!cheapest); });
  }

  // Partial results
  if (partial.length > 0) {
    html += `<span class="bc-section-title">חסרים חלק מהמוצרים</span>`;
    partial.slice(0, 6).forEach((s, i) => {
      html += _bcRenderCard(s, full.length + i, cheapest?.total, false);
    });
  }

  body.innerHTML = html;
}

function _bcRenderCard(s, rank, bestTotal, isChampion) {
  const delta       = (bestTotal != null && !isChampion) ? (s.total - bestTotal) : 0;
  const missingCnt  = s.missingItems?.length || 0;
  const missing3    = (s.missingItems || []).slice(0, 3).map(m => esc(m.name || m.barcode)).join('، ');
  const moreMissing = missingCnt > 3 ? ` ו-${missingCnt - 3} נוספים` : '';
  const nameParts   = [s.chainName, s.storeName && s.storeName !== s.chainName ? s.storeName : ''].filter(Boolean);

  return `<div class="bc-rank-card${isChampion ? ' best' : ''}" id="bc-card-${rank}">
    <div class="bc-rank-top">
      <div class="bc-rank-num${isChampion ? ' best' : ''}">${rank + 1}</div>
      <div class="bc-rank-name">${nameParts.length > 1
          ? esc(nameParts[0]) + '<br><span style="font-size:11px;font-weight:400;color:var(--muted)">' + esc(nameParts[1]) + '</span>'
          : esc(nameParts[0] || '')}</div>
      <div class="bc-rank-price${isChampion ? ' best' : ''}">₪${s.total.toFixed(2)}</div>
    </div>
    <div class="bc-rank-meta">
      ${s.city ? `<span>${esc(s.city)}</span>` : ''}
      ${s.distanceKm != null ? `<span>📍 ${s.distanceKm} ק"מ</span>` : ''}
    </div>
    <div class="bc-rank-footer">
      <div class="bc-rank-items">
        <strong>${s.availableItems}</strong>/${s.totalItems} מוצרים
        ${missingCnt > 0 ? `<span class="bc-rank-missing"> · חסרים ${missingCnt}: ${missing3}${moreMissing}</span>` : ''}
      </div>
      ${isChampion ? `<div class="bc-rank-delta cheaper">🏆 הכי זול</div>`
        : delta > 0.05 ? `<div class="bc-rank-delta pricier">יקר ב־₪${delta.toFixed(2)}</div>` : ''}
    </div>
    <button class="bc-expand-btn" onclick="_bcToggleBreakdown(${rank})">📋 פירוט →</button>
    <div class="bc-breakdown" id="bc-breakdown-${rank}">
      ${(s.items || []).map(item => `<div class="bc-item-row">
        <span class="bc-item-name">${esc(item.name || item.barcode)}</span>
        <span class="bc-item-qty">×${item.quantity}</span>
        <span class="bc-item-price">₪${item.totalPrice.toFixed(2)}</span>
      </div>`).join('')}
      ${(s.missingItems || []).map(m => `<div class="bc-item-row">
        <span class="bc-item-name missing">✗ ${esc(m.name || m.barcode)}</span>
        <span class="bc-item-qty"></span>
        <span class="bc-item-price missing">לא זמין</span>
      </div>`).join('')}
      ${s.latitude && s.longitude ? `<button class="bc-action-btn" style="margin-top:8px"
        onclick="navigateToStoreDirect(${s.latitude},${s.longitude},${JSON.stringify(s.address||'')},${JSON.stringify(s.chainName||'')})">
        🗺 נווט לחנות זו
      </button>` : ''}
    </div>
  </div>`;
}

window._bcToggleBreakdown = function(rank) {
  const el  = document.getElementById('bc-breakdown-' + rank);
  const btn = el?.previousElementSibling;
  if (!el) return;
  const showing = el.classList.toggle('show');
  if (btn) btn.textContent = showing ? '📋 הסתר פירוט ↑' : '📋 פירוט →';
};

window._bcIncreaseRadius = function() {
  setNearbyRadius(_nextRadius());
  openBasketCompare(_bcFocusStore);
};

window._bcSearchAll = async function() {
  const body = document.getElementById('bc-body');
  const sub  = document.getElementById('bc-sub');
  const listItems = Object.entries(items || {})
    .map(([id, v]) => ({ ...v, id }))
    .filter(i => !i.bought && (i.barcode || i.attached?.barcode) && isValidBarcode(i.barcode || i.attached?.barcode));
  const payload = {
    items: listItems.map(i => ({
      barcode: i.barcode || i.attached?.barcode, name: i.name || '', quantity: i.qty || 1,
    })),
    ...(groupId ? { groupId } : {}),
  };
  if (body) body.innerHTML = `<div class="bc-loading"><div class="spin"></div><p>משווה בכל הארץ...</p></div>`;
  if (sub)  sub.textContent = 'ללא סינון מיקום';
  try {
    const res  = await fetch('/api/basket-compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    _renderBasketCompare(data, payload.items);
  } catch (e) {
    if (body) body.innerHTML = `<div style="text-align:center;padding:30px">
      <div style="font-size:13px;font-weight:700">⚠️ שגיאה בטעינת הנתונים</div></div>`;
  }
};

window._bcSplitShopping = function() {
  toast('🚧 פיצול קנייה — בקרוב!');
};

// Navigate directly using coordinates from basket compare results
window.navigateToStoreDirect = function(lat, lng, address, name) {
  let url;
  if (lat && lng) {
    url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  } else if (address) {
    url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  } else {
    url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
  }
  window.open(url, '_blank');
};


// ══ THEME SYSTEM ══════════════════════════════════════════════════════════════
const _THEMES = {
  light: {
    '--bg':'#f3f7f3','--surface':'#ffffff','--card':'#eaf2ea','--card2':'#ddeedd',
    '--accent':'#16a34a','--accent-dim':'rgba(22,163,74,.12)',
    '--green':'#16a34a','--green-dim':'rgba(22,163,74,.10)',
    '--red':'#dc2626','--text':'#111827','--muted':'#6b7280','--border':'#d8e8d8',
    '--blue':'#2563eb','--blue-dim':'rgba(37,99,235,.12)',
    '--grad-tint':'rgba(22,163,74,.07)','--grad-tint2':'rgba(22,163,74,.08)',
    '--shadow-accent':'rgba(22,163,74,.35)','--shadow-accent-h':'rgba(22,163,74,.45)',
  },
  dark: {
    '--bg':'#0d1117','--surface':'#161b22','--card':'#1f2937','--card2':'#273040',
    '--accent':'#f0b429','--accent-dim':'rgba(240,180,41,.15)',
    '--green':'#34d399','--green-dim':'rgba(52,211,153,.12)',
    '--red':'#f87171','--text':'#e6edf3','--muted':'#7d8590','--border':'#30363d',
    '--blue':'#60a5fa','--blue-dim':'rgba(96,165,250,.12)',
    '--grad-tint':'rgba(240,180,41,.07)','--grad-tint2':'rgba(240,180,41,.08)',
    '--shadow-accent':'rgba(240,180,41,.4)','--shadow-accent-h':'rgba(240,180,41,.5)',
  }
};

window._currentTheme = 'light';

window.applyTheme = function(theme) {
  if (!_THEMES[theme]) return;
  window._currentTheme = theme;
  const root = document.documentElement;
  const vars = _THEMES[theme];
  for (const [k,v] of Object.entries(vars)) root.style.setProperty(k, v);
  localStorage.setItem('theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0d1117' : '#16a34a';
  // Update any visible seg buttons
  document.querySelectorAll('.theme-seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
};

// Apply saved theme immediately (before paint)
(function() {
  const saved = localStorage.getItem('theme') || 'light';
  applyTheme(saved);
})();
// ══════════════════════════════════════════════════════════════════════════════

// ═══ TEXT IMPORT (WhatsApp / SMS) ═══
// V1 scope: line-based parser only. Each line = one item.
// Multi-item lines are treated as a single item name.
// Bulk-bought triggers one notification per item (same as manual toggle — by design).
// Bulk-duplicate qty race under rapid import (same as rapid manual adds — V2 item).

let _importParsed = [];

function _parseImportLines(raw) {
  const CHECKBOX_RE  = /^[✅☑✔]\s*/u;
  const NOISE_RE     = /^[-–—•*#\s]*$/u;
  const BULLET_RE    = /^[*\-–—•]\s+/u;
  const NL_REMOVE_RE = /^(מחק|תמחק|תוריד|להוריד|הסר|לא צריך|אין צורך ב|בלי)\s+/u;
  const NL_BOUGHT_RE = /^(קניתי|כבר קניתי|סיימתי לקנות|כבר יש|נקנה|כבר קנינו)\s+/u;
  const NL_ADD_RE    = /^(לקנות|צריך|תוסיף|להוסיף|קנה|קני|נצטרך|צריכים|תקני|תקנה)\s+/u;
  const result = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || NOISE_RE.test(t)) continue;
    if (CHECKBOX_RE.test(t)) {
      const n = t.replace(CHECKBOX_RE, '').trim();
      if (n) result.push({ name: n, action: 'bought' });
    } else if (NL_REMOVE_RE.test(t)) {
      const n = t.replace(NL_REMOVE_RE, '').trim();
      if (n) result.push({ name: n, action: 'remove' });
    } else if (NL_BOUGHT_RE.test(t)) {
      const n = t.replace(NL_BOUGHT_RE, '').trim();
      if (n) result.push({ name: n, action: 'bought' });
    } else if (NL_ADD_RE.test(t)) {
      const n = t.replace(NL_ADD_RE, '').trim();
      if (n) result.push({ name: n, action: 'add' });
    } else {
      const n = t.replace(BULLET_RE, '').trim();
      if (n) result.push({ name: n, action: 'add' });
    }
  }
  return result;
}

window.openImportModal = function() {
  const el = document.getElementById('import-overlay');
  if (el) el.style.display = 'flex';
  _importShowTextarea();
  const ta = document.getElementById('import-textarea');
  if (ta) { ta.value = ''; setTimeout(() => ta.focus(), 50); }
};

window.closeImportModal = function() {
  const el = document.getElementById('import-overlay');
  if (el) el.style.display = 'none';
  _importParsed = [];
};

function _importShowTextarea() {
  const tv = document.getElementById('import-textarea-view');
  const pv = document.getElementById('import-preview-view');
  if (tv) tv.style.display = 'flex';
  if (pv) pv.style.display = 'none';
}

function _importShowPreview(parsed) {
  const tv = document.getElementById('import-textarea-view');
  const pv = document.getElementById('import-preview-view');
  if (tv) tv.style.display = 'none';
  if (!pv) return;
  pv.style.display = 'flex';
  const ICON = { add: '➕', bought: '✅', remove: '🗑' };
  const html = parsed.map(({ name, action }) => {
    const norm = normalizeName(name);
    const missing = action === 'remove' &&
      !Object.values(items).some(i => normalizeName(i.name) === norm);
    return '<div class="import-preview-row' + (missing ? ' import-preview-missing' : '') + '">' +
      '<span class="import-preview-icon">' + ICON[action] + '</span>' +
      '<span class="import-preview-name">' + esc(name) + '</span>' +
      (missing ? '<span class="import-preview-note">לא ברשימה</span>' : '') +
      '</div>';
  }).join('');
  document.getElementById('import-preview-list').innerHTML =
    html || '<div style="color:var(--muted);text-align:center;padding:16px">לא נמצאו פריטים</div>';
  _importParsed = parsed;
}

window.runImport = function() {
  const raw = document.getElementById('import-textarea')?.value || '';
  const parsed = _parseImportLines(raw);
  if (!parsed.length) { toast('⚠️ לא נמצאו פריטים לייבוא'); return; }
  _importShowPreview(parsed);
};

window.backToImportEdit = function() { _importShowTextarea(); };

window.executeImport = async function() {
  if (!_importParsed.length) return;
  const m = myProfile || {};
  let added = 0, bought = 0, removed = 0;

  for (const { name, action } of _importParsed) {

    if (action === 'bought') {
      const existing = findExistingListItem(name, null);
      if (existing) {
        await toggleBought(existing.id);
      } else {
        const newRef = push(ref(db, `groups/${groupId}/items`));
        await set(newRef, {
          name, qty: 1, bought: false, fav: false, barcode: null,
          addedByUserId: myId, addedByDisplayName: myName,
          addedByAvatarType:  m.avatarType  || 'emoji',
          addedByAvatarValue: m.avatarValue || '👤',
          addedByAvatarEmoji: m.avatarEmoji || null,
          addedAt: Date.now(), ts: Date.now(),
        });
        logActivity('item_added', newRef.key, name);
        await toggleBought(newRef.key);
      }
      bought++;

    } else if (action === 'remove') {
      const norm = normalizeName(name);
      const id = Object.keys(items).find(k => normalizeName(items[k].name) === norm);
      if (id) {
        const item = items[id];
        try {
          await remove(ref(db, `groups/${groupId}/items/${id}`));
          if (item.addedByUserId && item.addedByUserId !== myId) {
            const targets = {};
            targets[item.addedByUserId] = true;
            await createNotification({
              type: 'item_deleted', itemId: id, itemName: item.name, targetUsersObj: targets,
            });
          }
          logActivity('item_removed', id, name);
          removed++;
        } catch(e) {
          console.error('[import] delete failed:', e.message);
        }
      }

    } else {
      const existing = findExistingListItem(name, null);
      if (existing) {
        await update(ref(db, `groups/${groupId}/items/${existing.id}`), { qty: (existing.qty || 1) + 1 });
      } else {
        const newRef = push(ref(db, `groups/${groupId}/items`));
        set(newRef, {
          name, qty: 1, bought: false, fav: false, barcode: null,
          addedByUserId: myId, addedByDisplayName: myName,
          addedByAvatarType:  m.avatarType  || 'emoji',
          addedByAvatarValue: m.avatarValue || '👤',
          addedByAvatarEmoji: m.avatarEmoji || null,
          addedAt: Date.now(), ts: Date.now(),
        });
        logActivity('item_added', newRef.key, name);
      }
      added++;
    }
  }

  closeImportModal();
  const parts = [];
  if (added)   parts.push('➕ ' + added);
  if (bought)  parts.push('✅ ' + bought);
  if (removed) parts.push('🗑 ' + removed);
  toast(parts.length ? '📋 יובאו: ' + parts.join(' · ') : '⚠️ לא בוצעו פעולות');
};

// ── Android back-button interception ─────────────────────────────────────────
// Push a dummy history state so the first Android back press fires popstate
// instead of leaving the app. On popstate: if any sheet/overlay is open,
// close it. Otherwise show a "leave app?" confirmation dialog.
(function _initBackButton() {
  // Push synthetic state once so there is always something to pop to
  if (history.state === null || history.state?.appShell !== true) {
    history.pushState({ appShell: true }, '');
  }

  function _anyOverlayOpen() {
    const selectors = [
      '#bp-overlay.show', '#sd-overlay.show', '#pm-overlay.show',
      '#gs-sheet[style*="translateY(0"]', '#gs-sheet.open',
      '.import-overlay.show', '#dup-member-dlg',
      '#members-overlay.show', '#add-group-overlay.show',
      '.ol2.show', '[id$="-overlay"].show',
    ];
    return selectors.some(s => { try { return !!document.querySelector(s); } catch(_) { return false; } });
  }

  function _closeTopOverlay() {
    // Close in priority order: dialogs first, then modals, then sheets
    if (document.querySelector('#exit-dlg'))             { document.getElementById('exit-dlg')?.remove();        return true; }
    if (document.querySelector('#dup-member-dlg'))       { document.getElementById('dup-member-dlg')?.remove();  return true; }
    if (document.querySelector('#bp-overlay.show'))      { window.closeBrandPicker?.();    return true; }
    if (document.querySelector('#sd-overlay.show'))      { window.closeStoreDetail?.();    return true; }
    if (document.querySelector('#pm-overlay.show'))      { window.closeProductModal?.();   return true; }
    if (document.querySelector('.import-overlay.show'))  { window.closeImportModal?.();    return true; }
    if (document.querySelector('#members-overlay.show')) { document.getElementById('members-overlay')?.classList.remove('show'); return true; }
    if (document.querySelector('#gs-sheet'))             { window.closeGroupSheet?.();     return true; }
    // generic .ol2 overlays
    const ol2 = document.querySelector('.ol2.show');
    if (ol2) { ol2.classList.remove('show'); return true; }
    return false;
  }

  window.addEventListener('popstate', (e) => {
    // Always re-push the sentinel so the next back press also fires popstate
    history.pushState({ appShell: true }, '');

    // If any overlay is open, close it — don't prompt to leave
    if (_closeTopOverlay()) return;

    // No overlay open — confirm leaving the app
    const dlg = document.createElement('div');
    dlg.id = 'exit-dlg';
    dlg.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);direction:rtl';
    dlg.innerHTML = `
      <div style="background:var(--surface,#fff);border-radius:20px;padding:28px 22px;max-width:300px;width:88%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.22)">
        <div style="font-size:32px;margin-bottom:10px">🛒</div>
        <div style="font-size:17px;font-weight:800;margin-bottom:8px">לצאת מהאפליקציה?</div>
        <div style="font-size:13px;color:var(--muted,#888);margin-bottom:22px">הרשימה שלך תישמר</div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button id="exit-yes" style="flex:1;padding:12px;border-radius:12px;border:none;background:var(--accent,#46c97a);color:#fff;font-size:15px;font-weight:700;cursor:pointer">יציאה</button>
          <button id="exit-no"  style="flex:1;padding:12px;border-radius:12px;border:1.5px solid var(--border,#ddd);background:transparent;font-size:15px;cursor:pointer">ביטול</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    document.getElementById('exit-yes').onclick = () => { dlg.remove(); window.history.go(-2); };
    document.getElementById('exit-no').onclick  = () => dlg.remove();
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
  });
})();
