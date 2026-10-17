// Rate limiting, quotas and API keys.
//  - Per-IP and per-key burst limits: Workers Rate Limiting bindings (per-minute, per-location, approximate).
//  - Per-key daily quota + global daily soft caps: KV counters, batched per isolate to keep KV writes low
//    (KV write = cost). Counters are approximate by design ("soft" caps) — eventual consistency and
//    concurrent isolates can undercount by up to FLUSH_EVERY × isolates.

const FLUSH_EVERY = 10;      // flush a counter to KV after this many local increments…
const FLUSH_MAX_AGE = 30000; // …or after this many ms
const READ_TTL = 20000;      // re-read a counter from KV at most this often per isolate

export function utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }

const counters = new Map(); // name -> { base, baseAt, pending, lastFlush }

async function readCounter(kv, name) {
  let c = counters.get(name);
  const now = Date.now();
  if (!c) { c = { base: 0, baseAt: 0, pending: 0, lastFlush: now }; counters.set(name, c); }
  if (now - c.baseAt > READ_TTL) {
    const v = kv ? await kv.get(name) : null;
    c.base = Math.max(c.base, Number(v) || 0);
    c.baseAt = now;
  }
  return c;
}

/** Current approximate value of a counter (KV base + unflushed local increments). */
export async function counterValue(kv, name) {
  const c = await readCounter(kv, name);
  return c.base + c.pending;
}

/**
 * Increment; returns new approximate value. Flush happens in ctx.waitUntil.
 * opts.flushEvery (default 10) and opts.maxAgeMs (default 30 s; Infinity = only flush by count).
 * opts.ttl: KV expirationTtl seconds (default 3 days).
 */
export async function counterIncr(kv, name, ctx, by = 1, opts = {}) {
  const flushEvery = opts.flushEvery || FLUSH_EVERY;
  const maxAge = opts.maxAgeMs === undefined ? FLUSH_MAX_AGE : opts.maxAgeMs;
  const ttl = opts.ttl || 3 * 86400;
  const c = await readCounter(kv, name);
  c.pending += by;
  const value = c.base + c.pending;
  if (kv && (c.pending >= flushEvery || Date.now() - c.lastFlush > maxAge)) {
    const delta = c.pending; c.pending = 0; c.lastFlush = Date.now();
    const p = (async () => {
      try {
        const cur = Number(await kv.get(name)) || 0;
        const next = Math.max(cur + delta, c.base + delta);
        await kv.put(name, String(next), { expirationTtl: Math.max(60, ttl) });
        c.base = next; c.baseAt = Date.now();
      } catch { c.pending += delta; }
    })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  if (counters.size > 5000) { // bound memory (keys rotate daily)
    const day = utcDay(); const hour = new Date().toISOString().slice(0, 13);
    for (const k of counters.keys()) { if (!k.includes(day) && !k.includes(hour)) counters.delete(k); }
  }
  return value;
}

export function _resetCountersForTests() { counters.clear(); }

// ---------- Rate limit bindings ----------
const memLimiter = new Map();
/** Fallback in-memory limiter if a binding is missing (e.g. unit tests). */
function memLimit(key, limit, periodMs = 60000) {
  const now = Date.now();
  let e = memLimiter.get(key);
  if (!e || now - e.start > periodMs) { e = { start: now, n: 0 }; memLimiter.set(key, e); }
  e.n++;
  if (memLimiter.size > 10000) memLimiter.clear();
  return e.n <= limit;
}

export async function rateLimit(binding, key, fallbackLimit) {
  if (binding && typeof binding.limit === 'function') {
    try { const { success } = await binding.limit({ key }); return success; } catch { /* fall through */ }
  }
  return memLimit(key, fallbackLimit);
}

// ---------- API keys ----------
const KEY_RE = /^jm_[A-Za-z0-9]{32}$/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidKeyFormat(k) { return typeof k === 'string' && KEY_RE.test(k); }
export function isValidEmail(e) { return typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e); }

export function generateKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const out = [];
  while (out.length < 32) {
    for (const b of crypto.getRandomValues(new Uint8Array(48))) {
      if (b < 248 && out.length < 32) out.push(alphabet[b % 62]); // rejection sampling: 248 = 4*62
    }
  }
  return 'jm_' + out.join('');
}

const keyCache = new Map(); // keyHash -> { rec, at }
export async function lookupKey(kv, apiKey) {
  if (!isValidKeyFormat(apiKey)) return null;
  const h = await sha256hex(apiKey);
  const c = keyCache.get(h);
  if (c && Date.now() - c.at < 300000) return c.rec;
  const raw = kv ? await kv.get('key:' + h) : null;
  const rec = raw ? { ...JSON.parse(raw), hash: h } : null;
  keyCache.set(h, { rec, at: Date.now() });
  if (keyCache.size > 2000) keyCache.clear();
  return rec;
}

/** HMAC-SHA-256(secret, message) as hex. Used for anything derived from IPs or emails that is stored in KV. */
const hmacKeys = new Map();
export async function hmacHex(secret, message) {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, k);
  }
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}
