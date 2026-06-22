// workers/prices/rami-levy-auth.js
// Authentication helper for the Rami Levy price feed (NCR Cerberus portal).
//
// The portal requires a session cookie obtained via a login POST.
// Username: RamiLevi  Password: (empty) — public access, no real credentials.
// The session cookie (cftpSID) must be passed with every subsequent request.

import fetch from 'node-fetch';
import { logger } from './logger.js';

const BASE_URL  = 'https://url.retail.publishedprices.co.il';
const LOGIN_URL = `${BASE_URL}/login`;

// Extract CSRF token from <meta name="csrftoken" content="..."/>
function extractCsrf(html) {
  const m = html.match(/<meta\s+name="csrftoken"\s+content="([^"]+)"/i)
         || html.match(/<meta\s+content="([^"]+)"\s+name="csrftoken"/i);
  return m ? m[1] : null;
}

// Extract Set-Cookie value for a given cookie name
function extractCookie(headers, name) {
  const cookies = headers.raw?.()['set-cookie'] || [];
  const match   = cookies.find(c => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null; // "cftpSID=abc123"
}

/**
 * Authenticate with the Cerberus portal.
 * Returns a cookie string to pass as `Cookie:` header on subsequent requests.
 * Throws on failure after `retries` attempts.
 */
export async function getSession({
  username  = 'RamiLevi',
  password  = '',
  timeoutMs = 15_000,
  retries   = 3,
} = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Step 1: GET /login — capture initial session cookie + CSRF token
      const getRes = await fetch(LOGIN_URL, {
        headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; price-worker/1.0)', 'Accept': 'text/html,*/*' },
        signal:   AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!getRes.ok) throw new Error(`Login page HTTP ${getRes.status}`);

      const html     = await getRes.text();
      const csrf     = extractCsrf(html);
      const initSid  = extractCookie(getRes.headers, 'cftpSID');

      // Step 2: POST /login — submit credentials
      const body = new URLSearchParams({ username, password });
      if (csrf) body.append('csrfmiddlewaretoken', csrf);

      const postRes = await fetch(LOGIN_URL, {
        method:   'POST',
        headers: {
          'User-Agent':   'Mozilla/5.0 (compatible; price-worker/1.0)',
          'Accept':       'text/html,*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer':      LOGIN_URL,
          ...(initSid ? { Cookie: initSid } : {}),
        },
        body:     body.toString(),
        signal:   AbortSignal.timeout(timeoutMs),
        redirect: 'manual', // capture redirect cookie, do not follow
      });

      // Accept 200, 301, 302 — all are valid login responses
      if (postRes.status >= 400) throw new Error(`Login POST HTTP ${postRes.status}`);

      const sessionCookie = extractCookie(postRes.headers, 'cftpSID') || initSid;
      if (!sessionCookie) throw new Error('No cftpSID cookie in login response');

      logger.info('[rami-levy] Auth: session acquired', { user: username, attempt });
      return sessionCookie; // e.g. "cftpSID=abc123"
    } catch (err) {
      lastErr = err;
      logger.warn(`[rami-levy] Auth attempt ${attempt}/${retries} failed`, { error: err.message });
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  throw new Error(`[rami-levy] Auth failed after ${retries} attempts: ${lastErr?.message}`);
}
