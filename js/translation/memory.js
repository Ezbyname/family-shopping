// js/translation/memory.js
// Layer 6: User memory — saves confirmed mappings to Firebase per user
// Does NOT auto-promote to global dictionary

// Firebase refs injected at runtime (set via init)
let _dbRef = null;
let _userId = null;

export function initMemory(dbRef, userId) {
  _dbRef = dbRef;
  _userId = userId;
}

// Load user's personal dictionary from Firebase
export async function loadUserDictionary() {
  if (!_dbRef || !_userId) return {};
  try {
    const { get, ref } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');
    const snap = await get(ref(_dbRef, `userDicts/${_userId}`));
    return snap.exists() ? snap.val() : {};
  } catch (e) {
    console.error('Failed to load user dict:', e);
    return {};
  }
}

// Save a confirmed mapping (Hebrew → English) for this user only
export async function saveUserMapping(hebrewTerm, englishTerm) {
  if (!_dbRef || !_userId) return false;
  if (!hebrewTerm || !englishTerm) return false;

  // Never overwrite with empty values
  const cleanHebrew = hebrewTerm.trim();
  const cleanEnglish = englishTerm.trim().toLowerCase();
  if (!cleanHebrew || !cleanEnglish) return false;

  try {
    const { update, ref } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');
    await update(ref(_dbRef, `userDicts/${_userId}`), {
      [cleanHebrew]: cleanEnglish,
    });
    console.log(`✅ Saved mapping: "${cleanHebrew}" → "${cleanEnglish}"`);
    return true;
  } catch (e) {
    console.error('Failed to save mapping:', e);
    return false;
  }
}

// In-memory cache for current session
let _sessionCache = {};

export function getCachedDict() { return _sessionCache; }
export function setCachedDict(dict) { _sessionCache = { ...dict }; }
export function addToCache(hebrew, english) { _sessionCache[hebrew] = english; }