// test-fixtures.js — shared Playwright fixtures and session helpers
import { test as base } from '@playwright/test';
import { AppPage } from '../pages/AppPage.js';

const RUN_ID = Date.now().toString(36).slice(-4).toUpperCase();

// Writes the exact localStorage contract the app reads on startup (fsl_v2).
// myId is a placeholder — the app overwrites it with the real Firebase UID on auth.
export async function setSession(page, { myName = 'TestUser', myId = 'test-uid', groupId = '', groupName = '' } = {}) {
  await page.evaluate(({ myName, myId, groupId, groupName }) => {
    localStorage.setItem('fsl_v2', JSON.stringify({ myName, myId, groupId, groupName }));
  }, { myName, myId, groupId, groupName });
}

export async function clearSession(page) {
  await page.evaluate(() => {
    localStorage.removeItem('fsl_v2');
    sessionStorage.clear();
  });
}

export const test = base.extend({
  appPage: async ({ page }, use) => { await use(new AppPage(page)); },
  testUserName: async ({}, use) => { await use(`TestUser_${RUN_ID}`); },
});

export { expect } from '@playwright/test';

// ── API mocking helpers ────────────────────────────────────────────────────

export async function mockRoute(page, urlPattern, status, body) {
  await page.route(urlPattern, route =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  );
}

/**
 * Stub Firebase SDK modules so app.js loads in environments where gstatic.com
 * is not reachable (e.g. cloud CI, Playwright cloud runners).
 */
export async function stubFirebase(page) {
  const DB   = 'const noop=()=>{};export const getDatabase=()=>({}),ref=()=>({}),get=async()=>({exists:()=>false,val:()=>null}),set=async()=>{},update=async()=>{},push=async()=>({key:"k"}),remove=async()=>{},onValue=(r,cb)=>{cb({exists:()=>false,val:()=>null});return noop;},off=noop,query=(r)=>r,limitToFirst=()=>null,orderByChild=()=>null,equalTo=()=>null,orderByKey=()=>null,serverTimestamp=()=>Date.now(),increment=(v)=>v;';
  const AUTH = 'const noop=()=>{};export const getAuth=()=>({}),signInAnonymously=async()=>({user:{uid:"stub",isAnonymous:true}}),onAuthStateChanged=(auth,cb)=>{setTimeout(()=>cb({uid:"stub",isAnonymous:true}),100);return noop;},signOut=async()=>{};';
  const APP  = 'export const initializeApp=()=>({name:"stub",options:{}});';
  const STOR = 'export const getStorage=()=>({}),ref=()=>({}),uploadBytes=async()=>({}),getDownloadURL=async()=>"";';
  await page.route('https://www.gstatic.com/**firebase-app.js',     r => r.fulfill({ contentType:'application/javascript', body:APP  }));
  await page.route('https://www.gstatic.com/**firebase-database.js',r => r.fulfill({ contentType:'application/javascript', body:DB   }));
  await page.route('https://www.gstatic.com/**firebase-auth.js',    r => r.fulfill({ contentType:'application/javascript', body:AUTH }));
  await page.route('https://www.gstatic.com/**firebase-storage.js', r => r.fulfill({ contentType:'application/javascript', body:STOR }));
  await page.route('**firebaseio.com**',  r => r.abort());
  await page.route('**identitytoolkit**', r => r.abort());
}

export function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (
      t.includes('firebaseio') || t.includes('identitytoolkit') ||
      t.includes('favicon')    || t.includes('404') || t.includes('ERR_ABORTED') ||
      t.includes('fonts.google') || t.includes('gstatic')
    ) return;
    errors.push(t);
  });
  return errors;
}
