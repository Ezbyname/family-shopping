# Hidden Admin Mode

Status: **stable** — automated regression suite passes 73/73 (commit `8aaf182`).

---

## 1. Granting Admin Access

In Firebase Realtime Database, set:

```
users/{uid}/roles/admin = true
```

To find a user's `uid`: Firebase Console → Authentication → Users → copy the UID column.

To revoke access at any time (including during an active session):

```
users/{uid}/roles/admin = false
```

The panel closes live on the user's device within seconds — no page reload required.

---

## 2. Opening Admin Mode

1. Log in to the app as a user whose `uid` has `roles/admin = true`
2. On the main shopping screen, **long-press the avatar** (top-right) for **3 seconds**
3. A PIN entry modal appears
4. Enter `ADMIN_PIN` (set in Vercel — see §3)
5. The admin status panel opens

The gesture is invisible to non-admins — a long press on the avatar does nothing if `roles/admin` is not `true` in Firebase.

Session TTL is **15 minutes**. After expiry, the PIN is required again.

---

## 3. Required Vercel Environment Variables

| Variable | Purpose | Example |
|---|---|---|
| `ADMIN_PIN` | PIN required at unlock modal | `a8k2!mZ9` (min 4 chars) |
| `ALLOWED_ORIGINS` | CSRF allowlist for admin endpoints | `https://your-domain.vercel.app` |

Set in Vercel Dashboard → Project Settings → Environment Variables → Production.

Comma-separate multiple origins:
```
ALLOWED_ORIGINS=https://your-domain.vercel.app,https://custom-domain.com
```

If `ALLOWED_ORIGINS` is unset, all origins are permitted (acceptable for preview/dev, not production).

`ADMIN_PIN` is **never** sent to the frontend. It lives only in Vercel's server environment and is read by `api/admin-unlock.js` via `process.env.ADMIN_PIN`.

---

## 4. What the Admin Panel Shows

All data comes from `GET /api/admin-status` — server-gated, requires valid Firebase admin role on every call.

| Field | Source | Description |
|---|---|---|
| `latestPriceSanityStatus` | Firebase RTDB | Full result of the last sanity-live.js run |
| `statusLabel` | Firebase | `full_pass` / `baseline_pass` / `fail` |
| `productionCoverage` | Firebase | `full` or `partial` |
| `disabledChains` / `disabledChainIds` | Firebase | Chains disabled pending endpoint verification |
| Sample product | Firebase | Barcode, name, price, storeId from first passing chain |
| `meta.deployedSha` | Vercel system env | 7-char git SHA of the deployed serverless function |
| `meta.deployedEnv` | Vercel system env | `production` / `preview` / `development` |
| `status.sanityVersion` | Firebase (written by sanity-live.js) | Version of the sanity script that produced the status |
| `checkedAt` | Firebase | ISO timestamp of last sanity run |

---

## 5. Security Notes

**`sessionStorage` is not a security boundary.**
It stores the 15-minute unlock timestamp for convenience only. Any user with DevTools can set `sessionStorage.adminUnlocked = Date.now()`. This does not grant access — every `/api/admin-*` call re-verifies the Firebase ID token and re-reads `users/{uid}/roles/admin` from the database server-side.

**Server re-checks role on every request.**
`/api/admin-status` and `/api/admin-unlock` both call `db.ref('users/{uid}/roles/admin').once('value')` on each invocation. A cached or forged token claim cannot bypass this.

**`SANITY_ADMIN_TOKEN` is never exposed to the frontend.**
The in-app admin panel calls only Vercel serverless endpoints (`/api/admin-unlock`, `/api/admin-status`). The VM admin server (`admin-server.js`, port 8080) and its token are completely separate and are never referenced from `index.html`.

**CSRF protection.**
Both admin endpoints reject browser requests from origins not in `ALLOWED_ORIGINS`. Non-browser callers (curl, server-to-server) send no `Origin` header and are always permitted.

**Rate limiting.**
`/api/admin-unlock` allows at most 5 failed attempts per IP hash per 15-minute window, then returns HTTP 429. Current implementation is per-serverless-instance. For distributed enforcement, migrate to Upstash Redis or Firebase RTDB (see architecture note in `api/admin-unlock.js`).

**Audit trail.**
Every unlock attempt (success or failure) is written to `adminAuditLogs/{timestamp}_{uid}` in Firebase with `{ uid, success, ipHash, userAgent, createdAt }`. No PIN, no token, no raw IP is stored.

**Session telemetry.**
Every admin panel open writes `adminPanelSessions/{uid}/{sessionId}` with `{ openedAt, closedAt, userAgent, revoked, timedOut }`. Use this to detect abandoned or suspicious sessions.

---

## 6. Manual E2E Checklist

Run after each deployment that touches `index.html`, `api/admin-unlock.js`, or `api/admin-status.js`.

### Admin unlock (happy path)
- [ ] Long-press avatar for 3 seconds → PIN modal appears
- [ ] Enter correct PIN → admin panel opens
- [ ] Panel shows status banner (pass / baseline / fail)
- [ ] Panel footer shows 7-char git SHA and environment badge
- [ ] `adminPanelSessions/{uid}/...` entry visible in Firebase console with `openedAt` set

### Wrong PIN
- [ ] Enter wrong PIN → `❌ קוד שגוי או אין הרשאה` appears
- [ ] Repeat 5 times → sixth attempt returns `Access denied` (HTTP 429)
- [ ] Audit log entries appear in `adminAuditLogs/` with `success: false`

### Non-admin long press
- [ ] Log in as a user without `roles/admin = true` in Firebase
- [ ] Long-press avatar for 3 seconds → nothing happens (no modal, no toast)

### Revoke admin while panel is open
- [ ] Open admin panel as admin
- [ ] In Firebase console, set `users/{uid}/roles/admin = false`
- [ ] Within seconds (no page reload): panel closes, toast `🔒 הרשאת אדמין בוטלה` appears
- [ ] `adminPanelSessions/{uid}/...` entry shows `revoked: true` and `closedAt` set
- [ ] Long-press avatar again → nothing happens (role check returns false)

### Panel footer
- [ ] `Git SHA` shows the first 7 chars of the deployed commit (verify against GitHub)
- [ ] Environment badge shows `production` (green), `preview` (amber), or `local` (muted)
- [ ] `Sanity` version matches `SANITY_VERSION` in `scripts/sanity-live.js`
