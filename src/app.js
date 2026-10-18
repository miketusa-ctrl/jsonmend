// JsonMend HTTP router, key gate, limits and the shared tool runner (REST + MCP). Pure compute: no outbound fetches.
// Structure follows CertGuard v0.2.0 / DnsGuard v0.7.2.
import { VERSION } from './lib/version.js';
import { ipBucket, ipBucket48 } from './lib/ip.js';
import { countVisitor } from './lib/visitors.js';
import { rateLimit, counterValue, counterIncr, utcDay, lookupKey, isValidEmail, generateKey, sha256hex, hmacHex } from './lib/limits.js';
import { repairJson, RepairError, FORMATS, MAX_INPUT_BYTES, MAX_DEPTH, valueDepthExceeds } from './lib/repair.js';
import { validateValue, checkSchema, SchemaError, DRAFTS } from './lib/schema.js';
import { indexHtml, docsHtml, appJs, faviconSvg } from './lib/ui.js';
import { handleMcp } from './lib/mcp.js';
import { llmsTxt, openApiSpec, serverCard, registryAuthProof, GLAMA_JSON } from './lib/agentdocs.js';

export { ipBucket };

export const MAX_BODY = 256 * 1024; // request body cap (REST + MCP): 100 KB input can grow ~2x when JSON-escaped, plus a schema
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export function config(env) {
  return {
    env: env.ENVIRONMENT || 'development',
    publicLaunch: env.PUBLIC_LAUNCH === 'true',
    anonPerMin: num(env.ANON_PER_MIN, 10),
    anonDailyPerIp: num(env.ANON_DAILY_PER_IP, 30),
    anonDailyPer48: num(env.ANON_DAILY_PER_IP48, 90),
    keyPerMin: num(env.KEY_PER_MIN, 30),
    keyMonthlyQuota: num(env.KEY_MONTHLY_QUOTA, 1000),
    keyIssuerMonthlyQuota: num(env.KEY_ISSUER_MONTHLY_QUOTA, 3000),
    keyIssuePerIpPerDay: num(env.KEY_ISSUE_PER_IP_PER_DAY, 3),
    keyIssueGlobalPerDay: num(env.KEY_ISSUE_GLOBAL_PER_DAY, 200),
    globalDailyRequestCap: num(env.GLOBAL_DAILY_REQUEST_CAP, 20000),
    maxInputBytes: MAX_INPUT_BYTES,
    pepper: typeof env.HASH_PEPPER === 'string' && env.HASH_PEPPER.length >= 16 ? env.HASH_PEPPER : null,
  };
}

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

export function baseHeaders(cfg, extra = {}) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'interest-cohort=()',
    'strict-transport-security': 'max-age=31536000',
    ...extra,
  };
  if (!cfg.publicLaunch) h['x-robots-tag'] = 'noindex, nofollow';
  return h;
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-jsonmend-plan, retry-after' };

function json(cfg, status, obj, extra = {}, { cors = true } = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: baseHeaders(cfg, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cors ? CORS : {}), ...extra }),
  });
}
const errJson = (cfg, status, code, message, extra = {}, opts) => json(cfg, status, { ok: false, error: { code, message } }, extra, opts);

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function staticResponse(cfg, method, body, contentType, extra = {}) {
  return new Response(method === 'HEAD' ? null : body, { headers: baseHeaders(cfg, { 'content-type': contentType, 'cache-control': 'public, max-age=300', ...extra }) });
}

async function readBodyCapped(req) {
  const cl = req.headers.get('content-length');
  const tooBig = () => new HttpError(413, 'payload_too_large', `request body exceeds ${MAX_BODY.toLocaleString('en-US')} bytes`);
  if (cl && Number(cl) > MAX_BODY) throw tooBig();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { try { await reader.cancel(); } catch { /* ignore */ } throw tooBig(); }
    chunks.push(value);
  }
  const all = new Uint8Array(total); let p = 0;
  for (const c of chunks) { all.set(c, p); p += c.byteLength; }
  return new TextDecoder().decode(all);
}

function parseJsonObject(text) {
  if (!text.trim()) throw new HttpError(400, 'invalid_json', 'request body must be a JSON object');
  let v;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_json', 'request body is not valid JSON. To repair broken JSON, put it in the "input" string field, or POST it raw with Content-Type: text/plain'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'invalid_json', 'request body must be a JSON object');
  return v;
}

const friendly429 = 'JsonMend has reached its free request allowance for today to stay within its shared budget. Please try again after 00:00 UTC.';
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'unknown';
const utcMonth = (d = new Date()) => d.toISOString().slice(0, 7);

function requirePepper(cfg) {
  if (!cfg.pepper) throw new HttpError(503, 'not_configured', 'This deployment is missing its HASH_PEPPER secret; the API is disabled until it is set.');
}

// ---------- per-isolate light limiter (MCP discovery messages only) ----------
const memLimits = new Map();
export function memLimit(key, limit, periodMs) {
  const now = Date.now();
  const e = memLimits.get(key);
  if (!e || now - e.start > periodMs) { memLimits.set(key, { start: now, n: 1 }); return true; }
  if (e.n >= limit) return false;
  e.n++;
  if (memLimits.size > 5000) memLimits.clear();
  return true;
}
export function _resetMemLimitsForTests() { memLimits.clear(); }

// ---------- tool arguments (shared by REST and MCP, checked before any limiter) ----------
export const TOOL_ARGS = {
  repair: ['input', 'schema', 'coerce', 'draft', 'format'],
  validate: ['input', 'data', 'schema', 'coerce', 'draft'],
};
const utf8Len = (s) => new TextEncoder().encode(s).length;

/** Validate + normalise tool arguments. Throws HttpError 400/413/422. Never touches limits or KV. */
export function parseToolArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(400, 'invalid_arguments', 'arguments must be a JSON object');
  const allowed = TOOL_ARGS[tool];
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new HttpError(400, 'invalid_arguments', `Unknown field(s): ${unknown.slice(0, 5).join(', ').slice(0, 80)}. Allowed: ${allowed.join(', ')}.`);
  const out = {};
  const hasInput = args.input !== undefined && args.input !== null;
  const hasData = tool === 'validate' && Object.hasOwn(args, 'data');
  if (tool === 'repair' && !hasInput) throw new HttpError(400, 'invalid_arguments', '"input" (string) is required: the broken JSON text to repair');
  if (tool === 'validate' && hasInput === hasData) throw new HttpError(400, 'invalid_arguments', 'send exactly one of "input" (JSON text, repaired first if needed) or "data" (an already-parsed JSON value)');
  if (hasInput) {
    if (typeof args.input !== 'string') throw new HttpError(400, 'invalid_arguments', tool === 'validate' ? '"input" must be a string (JSON text); to validate an already-parsed value, send it as "data" instead' : '"input" must be a string: the (broken) JSON text to repair');
    const n = utf8Len(args.input);
    if (n > MAX_INPUT_BYTES) throw new HttpError(413, 'input_too_large', `input is ${n.toLocaleString('en-US')} bytes; the limit is ${MAX_INPUT_BYTES.toLocaleString('en-US')} bytes (UTF-8)`);
    out.input = args.input;
  }
  if (hasData) {
    if (valueDepthExceeds(args.data, MAX_DEPTH)) throw new HttpError(422, 'too_deep', `"data" is nested more than ${MAX_DEPTH} levels deep`);
    out.data = args.data;
  }
  if (args.schema !== undefined && args.schema !== null) {
    if (typeof args.schema !== 'boolean' && (typeof args.schema !== 'object' || Array.isArray(args.schema))) throw new HttpError(400, 'invalid_schema', '"schema" must be a JSON Schema object (or true/false)');
    // Size cap + static complexity check before any quota is used: data-independent, cheap (≤ 32 KB).
    try { checkSchema(args.schema); } catch (e) { if (e instanceof SchemaError) throw new HttpError(e.status, e.code, e.message); throw e; }
    out.schema = args.schema;
  } else if (tool === 'validate') throw new HttpError(400, 'invalid_arguments', '"schema" (a JSON Schema object) is required');
  if (args.coerce !== undefined && args.coerce !== null) {
    if (typeof args.coerce !== 'boolean') throw new HttpError(400, 'invalid_arguments', '"coerce" must be a boolean');
    out.coerce = args.coerce;
  }
  if (args.draft !== undefined && args.draft !== null) {
    if (!DRAFTS.includes(String(args.draft))) throw new HttpError(400, 'invalid_arguments', `"draft" must be one of: ${DRAFTS.join(', ')}`);
    out.draft = String(args.draft);
  }
  if (args.format !== undefined && args.format !== null) {
    if (!FORMATS.includes(args.format)) throw new HttpError(400, 'invalid_arguments', `"format" must be one of: ${FORMATS.join(', ')}`);
    out.format = args.format;
  }
  if ((out.coerce || out.draft) && out.schema === undefined) throw new HttpError(400, 'invalid_arguments', '"coerce" and "draft" need a "schema"');
  return out;
}

/** The actual work (pure). Returns the JSON body for a 200. Throws RepairError / SchemaError. */
export function computeTool(tool, a) {
  if (tool === 'repair') {
    const r = repairJson(a.input, { format: a.format || 'compact' });
    const body = { ok: true, changed: r.changed, inputWasValid: r.inputWasValid, values: r.values, fixes: r.fixes, warnings: r.warnings, json: r.value, text: r.text, format: r.format, inputBytes: r.inputBytes, outputBytes: r.outputBytes };
    if (a.schema !== undefined) {
      const v = validateValue(r.value, a.schema, { draft: a.draft, coerce: !!a.coerce });
      if (v.coerced) {
        body.json = v.value;
        body.text = a.format === 'pretty' ? JSON.stringify(v.value, null, 2) : JSON.stringify(v.value);
        if (a.format === 'preserve') body.warnings = [...body.warnings, { code: 'preserve_after_coercion', message: 'Coercion changed values, so "text" was re-serialized (compact) instead of preserved.' }];
        body.outputBytes = utf8Len(body.text);
      }
      body.schema = { valid: v.valid, errorCount: v.errorCount, errorsTruncated: v.errorsTruncated, errors: v.errors, draft: v.draft, coerced: v.coerced, coercions: v.coercions };
    }
    return body;
  }
  let value, repaired = false, fixes = [], warnings = [];
  if (a.input !== undefined) {
    const r = repairJson(a.input, { format: 'compact' });
    value = r.value; repaired = r.changed; fixes = r.fixes; warnings = r.warnings;
  } else value = a.data;
  const v = validateValue(value, a.schema, { draft: a.draft, coerce: !!a.coerce });
  return { ok: true, valid: v.valid, errorCount: v.errorCount, errorsTruncated: v.errorsTruncated, errors: v.errors, draft: v.draft, coerced: v.coerced, coercions: v.coercions, repaired, fixes, warnings, json: v.value };
}

// ---------- key gate (shared by /api/v1/* and /mcp) ----------
function extractApiKey(req) {
  const x = req.headers.get('x-api-key');
  if (x !== null) return { key: x.trim(), via: 'x-api-key' };
  const m = /^Bearer[ \t]+(\S.*)$/i.exec(req.headers.get('authorization') || '');
  if (m) return { key: m[1].trim(), via: 'bearer' };
  return null;
}

/** Same behaviour for REST and MCP. Never echoes the key. { ok:true, plan, rec } | { ok:false, status, code, message, headers } */
export async function authenticate(req, env, cfg = config(env)) {
  try {
    requirePepper(cfg);
    const presented = extractApiKey(req);
    if (!presented) return { ok: true, plan: 'anonymous', rec: null };
    const rec = await lookupKey(env.JSONMEND_KV, presented.key);
    if (!rec || rec.revoked) {
      throw new HttpError(401, 'invalid_api_key', presented.via === 'x-api-key'
        ? 'X-API-Key is not valid. Omit the header for anonymous (lower-rate) use, or get a free key via POST /api/v1/keys.'
        : 'The Bearer API key is not valid. Omit the Authorization header for anonymous (lower-rate) use, or get a free key via POST /api/v1/keys.');
    }
    return { ok: true, plan: 'key', rec };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, status: e.status, code: e.code, message: e.message, headers: e.headers };
    throw e;
  }
}

async function applyLimits(req, env, cfg, ctx, auth) {
  const kv = env.JSONMEND_KV;
  const bucket = ipBucket(clientIp(req));
  const day = utcDay();
  if (auth.plan === 'key') {
    const rec = auth.rec;
    if (!(await rateLimit(env.KEY_LIMITER, 'k:' + rec.id, cfg.keyPerMin))) {
      throw new HttpError(429, 'rate_limited', `Per-key rate limit (${cfg.keyPerMin}/min) exceeded. Slow down and retry in a minute.`, { 'retry-after': '60' });
    }
    const month = utcMonth();
    const quota = rec.monthlyQuota || cfg.keyMonthlyQuota;
    const usedName = `q:keymon:${rec.id}:${month}`;
    if ((await counterValue(kv, usedName)) >= quota) {
      throw new HttpError(429, 'key_quota_exceeded', `Monthly quota for this API key (${quota.toLocaleString('en-US')} requests/month) is used up. It resets on the 1st (00:00 UTC).`, { 'retry-after': '3600' });
    }
    const issuerName = `q:issuermon:${rec.issuer || 'legacy-' + rec.id}:${month}`;
    if ((await counterValue(kv, issuerName)) >= cfg.keyIssuerMonthlyQuota) {
      throw new HttpError(429, 'issuer_quota_exceeded', `Combined monthly quota for API keys issued to your network (${cfg.keyIssuerMonthlyQuota.toLocaleString('en-US')} requests/month) is used up. It resets on the 1st (00:00 UTC).`, { 'retry-after': '3600' });
    }
    await counterIncr(kv, usedName, ctx, 1, { ttl: 40 * 86400 });
    await counterIncr(kv, issuerName, ctx, 1, { ttl: 40 * 86400 });
    return { plan: 'key' };
  }
  if (!(await rateLimit(env.IP_LIMITER, 'ip:' + bucket, cfg.anonPerMin))) {
    throw new HttpError(429, 'rate_limited', `Anonymous rate limit (${cfg.anonPerMin} requests/min per IP) exceeded. Retry in a minute, or use a free API key for a higher limit.`, { 'retry-after': '60' });
  }
  const ipName = `q:ipday:${(await hmacHex(cfg.pepper, 'ip:' + bucket)).slice(0, 32)}:${day}`;
  if ((await counterValue(kv, ipName)) >= cfg.anonDailyPerIp) {
    throw new HttpError(429, 'ip_daily_quota', `Anonymous daily quota (${cfg.anonDailyPerIp} requests/day per IP) reached. It resets at 00:00 UTC; a free API key (POST /api/v1/keys) gives ${cfg.keyMonthlyQuota.toLocaleString('en-US')} requests/month.`, { 'retry-after': '3600' });
  }
  const b48 = ipBucket48(clientIp(req));
  let n48 = null;
  if (b48) {
    n48 = `q:ip48day:${(await hmacHex(cfg.pepper, 'ip48:' + b48)).slice(0, 32)}:${day}`;
    if ((await counterValue(kv, n48)) >= cfg.anonDailyPer48) {
      throw new HttpError(429, 'ip_daily_quota', `Anonymous daily quota for your IPv6 network (${cfg.anonDailyPer48} requests/day per /48) reached. It resets at 00:00 UTC; a free API key gives a higher quota.`, { 'retry-after': '3600' });
    }
  }
  await counterIncr(kv, ipName, ctx, 1, { flushEvery: 10, maxAgeMs: Infinity, ttl: 2 * 86400 });
  if (n48) await counterIncr(kv, n48, ctx, 1, { flushEvery: 10, maxAgeMs: Infinity, ttl: 2 * 86400 });
  return { plan: 'anonymous' };
}

/**
 * One tool call with every per-minute / daily / monthly / global limit applied exactly like the REST routes.
 * Used by POST /api/v1/repair, POST /api/v1/validate and MCP tools/call (one call = one request against the same
 * counters). `args` must already have passed parseToolArgs(). Returns { status, body, headers }.
 */
export async function runTool({ req, env, ctx, cfg = config(env), auth, tool, args }) {
  try {
    requirePepper(cfg);
    const lim = await applyLimits(req, env, cfg, ctx, auth);
    const day = utcDay();
    const reqCounter = `q:global:req:${day}`;
    if ((await counterValue(env.JSONMEND_KV, reqCounter)) >= cfg.globalDailyRequestCap) throw new HttpError(429, 'daily_cap_reached', friendly429, { 'retry-after': '3600' });
    await counterIncr(env.JSONMEND_KV, reqCounter, ctx);
    const headers = { 'x-jsonmend-plan': lim.plan };
    try {
      return { status: 200, body: computeTool(tool, args), headers };
    } catch (e) {
      if (e instanceof RepairError || e instanceof SchemaError) {
        return { status: e.status, body: { ok: false, error: { code: e.code, message: e.message, ...(Number.isInteger(e.position) ? { position: e.position } : {}) } }, headers };
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { ok: false, error: { code: e.code, message: e.message } }, headers: e.headers || {} };
    throw e;
  }
}

async function handleTool(req, env, ctx, cfg, tool, url) {
  const ct = req.headers.get('content-type') || '';
  const text = await readBodyCapped(req);
  let raw;
  if (/^application\/json\b/i.test(ct) || (tool === 'validate')) raw = parseJsonObject(text);
  else {
    // repair: raw text body (Content-Type text/plain or none) = the input; options from the query string
    raw = { input: text };
    const f = url.searchParams.get('format');
    if (f !== null) raw.format = f;
  }
  const auth = await authenticate(req, env, cfg); // same key gate as /mcp (bad key → 401 even with bad input)
  if (!auth.ok) throw new HttpError(auth.status, auth.code, auth.message, auth.headers);
  const args = parseToolArgs(tool, raw); // 400/413 before any limiter: bad input costs no quota
  const r = await runTool({ req, env, ctx, cfg, auth, tool, args });
  return json(cfg, r.status, r.body, r.headers);
}

async function handleKeys(req, env, ctx, cfg) {
  const kv = env.JSONMEND_KV;
  if (!kv) throw new HttpError(503, 'unavailable', 'key issuance is not configured');
  requirePepper(cfg);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'cross_origin_forbidden', 'API keys can only be requested from this site or directly (e.g. curl), not from other websites.');
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) throw new HttpError(415, 'unsupported_media_type', 'send the request body as application/json');
  const bucket = ipBucket(clientIp(req));
  if (!(await rateLimit(env.IP_LIMITER, 'keys:' + bucket, cfg.anonPerMin))) throw new HttpError(429, 'rate_limited', 'Too many requests. Retry in a minute.', { 'retry-after': '60' });
  const body = parseJsonObject(await readBodyCapped(req));
  let email = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!isValidEmail(email)) throw new HttpError(400, 'invalid_email', '"email" is optional, but if given it must be a valid address');
  }
  const day = utcDay();
  const ipName = `q:keyissue:${(await hmacHex(cfg.pepper, 'ip:' + bucket)).slice(0, 32)}:${day}`;
  const gName = `q:keyissue:global:${day}`;
  const [ipCount, gCount] = await Promise.all([kv.get(ipName), kv.get(gName)]);
  const ipN = Number(ipCount || 0); const gN = Number(gCount || 0);
  if (ipN >= cfg.keyIssuePerIpPerDay) throw new HttpError(429, 'key_issue_limit', `At most ${cfg.keyIssuePerIpPerDay} keys per IP (IPv6: per /64) per day.`, { 'retry-after': '3600' });
  if (gN >= cfg.keyIssueGlobalPerDay) throw new HttpError(429, 'daily_cap_reached', 'JsonMend has issued its maximum number of free keys for today. Please try again after 00:00 UTC.', { 'retry-after': '3600' });
  // Reserve before minting (KV has no atomic increment; narrows, but cannot close, the race window).
  await Promise.all([
    kv.put(ipName, String(ipN + 1), { expirationTtl: 2 * 86400 }),
    kv.put(gName, String(gN + 1), { expirationTtl: 2 * 86400 }),
  ]);
  const apiKey = generateKey();
  const keyHash = await sha256hex(apiKey);
  const id = keyHash.slice(0, 16);
  const rec = { id, created: new Date().toISOString(), plan: 'free', monthlyQuota: cfg.keyMonthlyQuota, issuer: (await hmacHex(cfg.pepper, 'issuer:' + bucket)).slice(0, 32) };
  if (email) rec.contactHmac = await hmacHex(cfg.pepper, 'email:' + email.toLowerCase());
  await kv.put('key:' + keyHash, JSON.stringify(rec));
  return json(cfg, 201, {
    ok: true, apiKey, keyId: id, plan: 'free', monthlyQuota: cfg.keyMonthlyQuota, perMinute: cfg.keyPerMin,
    note: 'Store this key now. It is shown only once (we keep only a hash). Send it as the X-API-Key header or as Authorization: Bearer <key>.',
  }, {}, { cors: false });
}

async function handleUsage(req, env, cfg) {
  requirePepper(cfg);
  const presented = extractApiKey(req);
  if (!presented || !presented.key) throw new HttpError(401, 'missing_api_key', 'send your key in the X-API-Key header (or Authorization: Bearer)');
  const rec = await lookupKey(env.JSONMEND_KV, presented.key);
  if (!rec || rec.revoked) throw new HttpError(401, 'invalid_api_key', 'the API key is not valid');
  const month = utcMonth();
  const used = await counterValue(env.JSONMEND_KV, `q:keymon:${rec.id}:${month}`);
  const quota = rec.monthlyQuota || cfg.keyMonthlyQuota;
  const d = new Date(); const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return json(cfg, 200, { ok: true, keyId: rec.id, plan: rec.plan, monthlyQuota: quota, usedThisMonth: used, remainingThisMonth: Math.max(0, quota - used), perMinute: cfg.keyPerMin, resetsAt: next.toISOString().replace('.000Z', 'Z'), note: 'usage counts are approximate (batched counters)' });
}

function sitemap(origin) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n  <url><loc>${origin}/docs</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>\n</urlset>\n`;
}

// Route table: path → allowed methods. Anything else on a known path → 405 with Allow.
const ROUTES = {
  '/': ['GET', 'HEAD'],
  '/docs': ['GET', 'HEAD'],
  '/app.js': ['GET', 'HEAD'],
  '/health': ['GET', 'HEAD'],
  '/robots.txt': ['GET', 'HEAD'],
  '/sitemap.xml': ['GET', 'HEAD'],
  '/favicon.svg': ['GET', 'HEAD'],
  '/api/v1/repair': ['POST', 'OPTIONS'],
  '/api/v1/validate': ['POST', 'OPTIONS'],
  '/api/v1/keys': ['POST'],
  '/api/v1/usage': ['GET', 'OPTIONS'],
  '/llms.txt': ['GET', 'HEAD', 'OPTIONS'],
  '/openapi.json': ['GET', 'HEAD', 'OPTIONS'],
  '/.well-known/mcp/server-card.json': ['GET', 'HEAD', 'OPTIONS'],
  '/.well-known/mcp-registry-auth': ['GET', 'HEAD'],
  '/.well-known/glama.json': ['GET', 'HEAD'],
};
// /mcp is handled by handleMcp (POST + OPTIONS; GET/DELETE/other → 405 with Allow: POST, OPTIONS).
export const ROUTE_TABLE = ROUTES;

export function createApp() {
  return {
    async fetch(req, env, ctx) {
      const cfg = config(env);
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method;
      // Daily unique visitors (shared counter, v0.1.3): homepage views and real tool traffic only. Never /health,
      // docs, static files or HEAD
      if ((method === 'GET' && path === '/') || (method === 'POST' && (path === '/mcp' || path === '/api/v1/repair' || path === '/api/v1/validate'))) {
        countVisitor(req, env, ctx, ipBucket(clientIp(req)));
      }
      try {
        if (path === '/mcp') {
          return await handleMcp(req, env, ctx, {
            authenticate: (r, e) => authenticate(r, e, cfg),
            parseToolArgs,
            runTool: ({ tool, args, auth }) => runTool({ req, env, ctx, cfg, auth, tool, args }),
            ipBucket: ipBucket(clientIp(req)), memLimit, origin: url.origin, security: baseHeaders(cfg),
            allowedOrigins: env.MCP_ALLOWED_ORIGINS, limits: cfg, maxBody: MAX_BODY,
          });
        }
        const allowed = ROUTES[path];
        if (!allowed) {
          if (path.startsWith('/api/')) throw new HttpError(404, 'not_found', 'unknown endpoint; see /docs');
          return new Response(method === 'HEAD' ? null : 'Not found', { status: 404, headers: baseHeaders(cfg, { 'content-type': 'text/plain; charset=utf-8' }) });
        }
        if (!allowed.includes(method)) throw new HttpError(405, 'method_not_allowed', `use ${allowed.join(', ')}`, { allow: allowed.join(', ') });
        if (method === 'OPTIONS') { // CORS preflight (never for /api/v1/keys)
          return new Response(null, { status: 204, headers: baseHeaders(cfg, {
            'access-control-allow-origin': '*', 'access-control-allow-methods': allowed.join(', '),
            'access-control-allow-headers': 'content-type, x-api-key, authorization', 'access-control-max-age': '86400' }) });
        }
        switch (path) {
          case '/': return staticResponse(cfg, method, indexHtml(cfg, url.origin), 'text/html; charset=utf-8', { 'content-security-policy': CSP });
          case '/docs': return staticResponse(cfg, method, docsHtml(cfg, url.origin), 'text/html; charset=utf-8', { 'content-security-policy': CSP });
          case '/app.js': return staticResponse(cfg, method, appJs, 'application/javascript; charset=utf-8');
          case '/robots.txt': return staticResponse(cfg, method, cfg.publicLaunch
            ? `User-agent: *\nDisallow: /api/\nSitemap: ${url.origin}/sitemap.xml\n`
            : 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8');
          case '/sitemap.xml': return staticResponse(cfg, method, sitemap(url.origin), 'application/xml; charset=utf-8');
          case '/favicon.svg': return staticResponse(cfg, method, faviconSvg, 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
          case '/llms.txt': return staticResponse(cfg, method, llmsTxt(url.origin, cfg), 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=3600', ...CORS });
          case '/openapi.json': return staticResponse(cfg, method, JSON.stringify(openApiSpec(url.origin, cfg), null, 2), 'application/json; charset=utf-8', { 'cache-control': 'public, max-age=3600', ...CORS });
          case '/.well-known/mcp/server-card.json': return staticResponse(cfg, method, JSON.stringify(serverCard(url.origin), null, 2), 'application/json; charset=utf-8', { 'cache-control': 'public, max-age=3600', ...CORS });
          case '/.well-known/glama.json': return staticResponse(cfg, method, GLAMA_JSON, 'application/json', { 'cache-control': 'public, max-age=3600' });
          case '/.well-known/mcp-registry-auth': {
            const proof = registryAuthProof(env);
            if (proof) return staticResponse(cfg, method, proof + '\n', 'text/plain; charset=utf-8', { 'cache-control': 'no-store' });
            return new Response(method === 'HEAD' ? null : 'Not found', { status: 404, headers: baseHeaders(cfg, { 'content-type': 'text/plain; charset=utf-8' }) });
          }
          case '/health': {
            const r = json(cfg, 200, { ok: true, service: 'jsonmend', version: VERSION, environment: cfg.env, time: new Date().toISOString(),
              kv: !!env.JSONMEND_KV, rateLimiters: { ip: !!env.IP_LIMITER, key: !!env.KEY_LIMITER }, secrets: { hashPepper: !!cfg.pepper } });
            return method === 'HEAD' ? new Response(null, { status: 200, headers: r.headers }) : r;
          }
          case '/api/v1/repair': return await handleTool(req, env, ctx, cfg, 'repair', url);
          case '/api/v1/validate': return await handleTool(req, env, ctx, cfg, 'validate', url);
          case '/api/v1/keys': return await handleKeys(req, env, ctx, cfg);
          case '/api/v1/usage': return await handleUsage(req, env, cfg);
        }
        throw new HttpError(404, 'not_found', 'unknown endpoint');
      } catch (e) {
        const opts = { cors: path !== '/api/v1/keys' };
        if (e instanceof HttpError) return errJson(cfg, e.status, e.code, e.message, e.headers, opts);
        return errJson(cfg, 500, 'internal_error', 'unexpected error', {}, opts);
      }
    },
  };
}
