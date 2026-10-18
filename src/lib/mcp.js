/**
 * JsonMend remote MCP server. Hand-rolled JSON-RPC 2.0 over Streamable HTTP; no SDK, no dependencies. Adapted from
 * CertGuard src/mcp.js (v0.2.0, incl. fix c2606ed: modern results keep _meta["<worker>/error"]), itself adapted from
 * DnsGuard src/lib/mcp.js.
 *
 * Dual-era and stateless:
 *  - Modern (MCP 2026-07-28): every request carries params._meta["io.modelcontextprotocol/protocolVersion"] plus the
 *    MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. Methods: server/discover, tools/list, tools/call.
 *  - Legacy (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05): initialize handshake, notifications/initialized, ping,
 *    tools/list, tools/call. JSON-RPC batches (max 10 messages, at most one tools/call) are accepted for legacy clients.
 *  - No sessions: no Mcp-Session-Id is ever issued; one sent by a client is ignored. GET/DELETE → 405 (no SSE stream).
 *  - Responses are always application/json (no SSE).
 *
 * Auth + limits are NOT implemented here: the router passes in authenticate(), parseToolArgs() and runTool() from
 * app.js, the exact functions behind POST /api/v1/repair and /api/v1/validate, so key handling and every
 * per-minute / daily / monthly / global counter are identical. One tools/call = one request. initialize /
 * tools/list / ping / server/discover never touch the request quota; they have a light per-isolate cap per IP
 * bucket (DISCOVERY_PER_MIN; IPv6 → its /64).
 */
import { VERSION } from './version.js';
import { FIX_CODES, FORMATS, MAX_INPUT_BYTES } from './repair.js';
import { DRAFTS } from './schema.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
// Same cap as the REST body (app.js MAX_BODY).
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_BATCH = 10;
export const MAX_CHECKS_PER_REQUEST = 1; // bounds CPU per invocation and keeps 1 HTTP request ≈ 1 counted request
export const DISCOVERY_PER_MIN = 120; // per IP bucket per isolate, for non-tool messages (initialize, tools/list, ping, …)
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
export const ERROR_META = 'jsonmend/error';
export const PASS_HEADERS = ['retry-after', 'x-jsonmend-plan']; // the headers the REST tool routes send

// JSON-RPC / MCP error codes
export const E = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  SERVER: -32000, // implementation-defined (auth, rate limit, body too large, forbidden origin)
  HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

export const MCP_CORS = {
  // Keys are explicit headers (never ambient cookies), so a wildcard origin without credentials is safe and lets
  // browser-based MCP inspectors work. Same policy as the REST API.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS', // GET/DELETE → 405 (no SSE stream, no sessions)
  'access-control-allow-headers': 'content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': ['mcp-protocol-version', ...PASS_HEADERS].join(', '),
  'access-control-max-age': '86400',
};

export const SERVER_INFO = { name: 'jsonmend', title: 'JsonMend', version: VERSION };
const fmt = (n) => Number(n).toLocaleString('en-US');
export const instructions = (L = { anonPerMin: 10, anonDailyPerIp: 30, keyPerMin: 30, keyMonthlyQuota: 1000 }) => 'JsonMend turns broken JSON (typically LLM output) into valid JSON. Call repair_json with the raw text as "input": it strips Markdown code fences and prose around the JSON, fixes trailing commas, single or curly quotes, unquoted keys, comments, Python None/True/False, missing commas, and closes truncated strings/arrays/objects; it returns the parsed value ("json"), the repaired text, and a list of the fixes applied. Already-valid JSON is returned unchanged with no fixes. Pass an optional JSON Schema ("schema", with "coerce": true to convert "42" → 42 etc.) to also get validation errors. Use validate_json to check JSON text or an already-parsed value ("data") against a schema. Input limit ' + fmt(MAX_INPUT_BYTES) + ' bytes. Pure computation: nothing is fetched and inputs are not stored. Anonymous use is limited to about ' + L.anonPerMin + ' requests per minute and ' + L.anonDailyPerIp + ' per day per IP; send "Authorization: Bearer <key>" or "X-API-Key: <key>" with a free jm_ key (POST /api/v1/keys) for about ' + L.keyPerMin + ' per minute and ' + fmt(L.keyMonthlyQuota) + ' per month.';

const fixSchema = { type: 'object', properties: { code: { type: 'string', enum: FIX_CODES }, message: { type: 'string' }, count: { type: 'integer', minimum: 2 } }, required: ['code', 'message'] };
const warningSchema = { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] };
const schemaErrorSchema = { type: 'object', properties: { path: { type: 'string', description: 'JSON Pointer to the failing value ("" = root)' }, keyword: { type: 'string' }, schemaPath: { type: 'string' }, message: { type: 'string' } }, required: ['path', 'keyword', 'message'] };
const coercionSchema = { type: 'object', properties: { path: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['path', 'from', 'to'] };
const validationProps = {
  valid: { type: 'boolean' },
  errorCount: { type: 'integer', description: 'Total errors (at most 50 are listed); a lower bound when errorsTruncated is true' },
  errorsTruncated: { type: 'boolean', description: 'true when the validator produced more than 5,000 raw errors and only the first 5,000 were examined' },
  errors: { type: 'array', items: schemaErrorSchema },
  draft: { type: 'string', enum: DRAFTS },
  coerced: { type: 'boolean' },
  coercions: { type: 'array', items: coercionSchema },
};
const inputProp = { type: 'string', minLength: 1, maxLength: MAX_INPUT_BYTES, description: `The raw (possibly broken) JSON text, e.g. an LLM reply with code fences and prose around the JSON. Max ${fmt(MAX_INPUT_BYTES)} bytes (UTF-8).` };
const schemaProp = { type: 'object', description: 'A JSON Schema (draft 2020-12 by default; 2019-09, 7 and 4 also supported). Only local $refs (#/...) resolve; remote $refs are an error. Max 32 KB.' };
const coerceProp = { type: 'boolean', default: false, description: 'Convert values toward the schema\'s declared types before validating: "42" → 42, "true" → true, "null" → null, 5 → "5", x → [x]. Each change is listed in coercions.' };
const draftProp = { type: 'string', enum: DRAFTS, description: 'JSON Schema draft. Default: from the schema\'s $schema, else 2020-12.' };
const common = { plan: { type: 'string', enum: ['anonymous', 'key'] }, version: { type: 'string' } };

export const TOOLS = [{
  name: 'repair_json',
  title: 'Repair broken JSON (LLM output) and list the fixes',
  description: 'Turn broken or messy JSON text into valid JSON. Strips Markdown code fences and prose before/after the JSON, removes comments and trailing commas, converts single/curly quotes, quotes unquoted keys, maps Python None/True/False, inserts missing commas, closes truncated strings/arrays/objects, and wraps NDJSON / several concatenated objects into one array. Returns the parsed value (json), the repaired text, and the list of fixes applied; valid input passes through unchanged with no fixes. Optional schema (+ coerce) also validates the result. Fails with isError (code unrepairable / no_json_found) when nothing JSON-like can be recovered. Pure computation: read-only, no network access, inputs not stored. Same engine and limits as POST /api/v1/repair.',
  inputSchema: {
    type: 'object',
    properties: {
      input: inputProp,
      format: { type: 'string', enum: FORMATS, default: 'compact', description: 'Layout of the returned text: compact (default), pretty (2-space indent), or preserve (jsonrepair\'s output, keeps original spacing and long-number digits).' },
      schema: schemaProp,
      coerce: coerceProp,
      draft: draftProp,
    },
    required: ['input'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      changed: { type: 'boolean', description: 'false when the input was already valid JSON' },
      inputWasValid: { type: 'boolean' },
      values: { type: 'integer', description: 'Number of top-level JSON values found (more than 1 = wrapped in an array)' },
      fixes: { type: 'array', items: fixSchema },
      warnings: { type: 'array', items: warningSchema },
      json: { description: 'The repaired JSON value (coerced if coerce was used)' },
      format: { type: 'string', enum: FORMATS },
      inputBytes: { type: 'integer' },
      outputBytes: { type: 'integer' },
      schema: { type: 'object', properties: validationProps, required: ['valid', 'errorCount', 'errors'] },
      ...common,
    },
    required: ['ok', 'changed', 'inputWasValid', 'fixes', 'json'],
  },
  annotations: { title: 'Repair JSON', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, {
  name: 'validate_json',
  title: 'Validate JSON against a JSON Schema (repairs broken input first)',
  description: 'Check JSON against a JSON Schema and get every error with its JSON Pointer path. Send the JSON either as text ("input"; broken text is repaired first, and the fixes are listed) or as an already-parsed value ("data"). Optional coerce converts "42" → 42, "true" → true, etc. toward the schema\'s types before validating and lists each change. A schema mismatch is a normal result (valid: false), not an error. Drafts 2020-12 (default), 2019-09, 7, 4; only local $refs. Pure computation: read-only, no network access, inputs not stored. Same engine and limits as POST /api/v1/validate.',
  inputSchema: {
    type: 'object',
    properties: {
      schema: schemaProp,
      input: { ...inputProp, description: `JSON text to validate (repaired first if broken). Send this or "data", not both. Max ${fmt(MAX_INPUT_BYTES)} bytes.` },
      data: { description: 'An already-parsed JSON value to validate. Send this or "input", not both.' },
      coerce: coerceProp,
      draft: draftProp,
    },
    required: ['schema'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      ...validationProps,
      repaired: { type: 'boolean', description: 'true when "input" needed repair before validation' },
      fixes: { type: 'array', items: fixSchema },
      warnings: { type: 'array', items: warningSchema },
      json: { description: 'The validated value (after repair and coercion)' },
      ...common,
    },
    required: ['ok', 'valid', 'errorCount', 'errorsTruncated', 'errors', 'json'],
  },
  annotations: { title: 'Validate JSON', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];
const TOOL_KIND = { repair_json: 'repair', validate_json: 'validate' };

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const MAX_TEXT_CHARS = 120_000; // the content[0] text block; structuredContent.json always carries the full value

/** structuredContent for a 200 body (keys in outputSchema order; never null except inside json). */
export function summarize(kind, body, plan) {
  if (kind === 'repair') {
    const out = { ok: true, changed: body.changed, inputWasValid: body.inputWasValid, values: body.values, fixes: body.fixes, warnings: body.warnings, json: body.json, format: body.format, inputBytes: body.inputBytes, outputBytes: body.outputBytes };
    if (body.schema) out.schema = body.schema;
    return { ...out, plan: plan || 'anonymous', version: VERSION };
  }
  return { ok: true, valid: body.valid, errorCount: body.errorCount, errorsTruncated: body.errorsTruncated, errors: body.errors, draft: body.draft, coerced: body.coerced, coercions: body.coercions, repaired: body.repaired, fixes: body.fixes, warnings: body.warnings, json: body.json, plan: plan || 'anonymous', version: VERSION };
}

function schemaLines(v) {
  const lines = [];
  if (v.valid) lines.push('Schema: valid.');
  else {
    lines.push(`Schema: INVALID (${v.errorsTruncated ? 'at least ' : ''}${v.errorCount} error${v.errorCount === 1 ? '' : 's'}):`);
    for (const e of v.errors.slice(0, 20)) lines.push(`- ${e.path || '(root)'}: ${e.message}`);
    if (v.errorCount > 20) lines.push(`- … ${v.errorCount - 20} more in structuredContent`);
  }
  if (v.coercions && v.coercions.length) lines.push(`Coerced ${v.coercions.length} value(s): ${v.coercions.slice(0, 10).map((c) => `${c.path || '(root)'} ${c.from}→${c.to}`).join(', ')}`);
  return lines;
}

/** Human/LLM-readable text (content[0]). */
export function summaryText(kind, body) {
  const lines = [];
  if (kind === 'repair') {
    if (!body.changed) lines.push('Input was already valid JSON (no fixes needed).');
    else lines.push(`Repaired JSON (${body.fixes.length} kind${body.fixes.length === 1 ? '' : 's'} of fix: ${body.fixes.map((f) => f.code + (f.count ? `×${f.count}` : '')).join(', ')}).`);
    for (const w of body.warnings) lines.push(`Warning: ${w.message}`);
    if (body.schema) lines.push(...schemaLines(body.schema));
    const t = body.text.length > MAX_TEXT_CHARS ? `${body.text.slice(0, MAX_TEXT_CHARS)}\n… (text clipped; the full value is in structuredContent.json)` : body.text;
    lines.push('', t);
  } else {
    lines.push(...schemaLines(body));
    if (body.repaired) lines.push(`The input was repaired first: ${body.fixes.map((f) => f.code).join(', ')}.`);
  }
  return lines.join('\n');
}

function toolError(message, data, extra = {}) {
  return { content: [{ type: 'text', text: message }], isError: true, ...(data ? { _meta: { [ERROR_META]: data } } : {}), ...extra };
}

/** tools/call. Returns { result } or { error } (protocol error), plus HTTP headers to surface. */
async function callTool(params, deps, auth) {
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;
  const kind = Object.hasOwn(TOOL_KIND, String(name)) ? TOOL_KIND[name] : null;
  if (!kind) return { error: { code: E.INVALID_PARAMS, message: `Unknown tool: ${clip(String(name), 80)}` } };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: { code: E.INVALID_PARAMS, message: 'arguments must be an object' } };
  // Input problems are tool-execution errors (isError) so the model can correct itself. No limiter/KV is touched.
  let parsed;
  try { parsed = deps.parseToolArgs(kind, args); } catch (e) {
    if (e && e.status && e.code) return { result: toolError(clip(String(e.message), 600), { code: e.code, httpStatus: e.status }) };
    throw e;
  }
  const r = await deps.runTool({ tool: kind, args: parsed, auth });
  const headers = { ...(r.headers || {}) };
  if (r.status !== 200) {
    const retry = headers['retry-after'] ? Number(headers['retry-after']) : undefined;
    const e = (r.body && r.body.error) || {};
    const data = { code: String(e.code || 'error'), httpStatus: r.status };
    if (Number.isInteger(e.position)) data.position = e.position;
    if (retry) data.retryAfterSeconds = retry;
    return { result: toolError(clip(`${e.message || 'The request could not be completed.'}${retry ? ` (retry after ${retry} seconds)` : ''}`, 1200), data), headers };
  }
  return { result: { content: [{ type: 'text', text: summaryText(kind, r.body) }], structuredContent: summarize(kind, r.body, auth.plan), isError: false }, headers };
}

// ---------- transport helpers ----------

/** Origin policy: absent = OK (CLI / server-side clients). Present: must be a bare https origin or an http loopback
 * origin, or (if MCP_ALLOWED_ORIGINS is set) same-origin / listed. Malformed, "null" and plain-http remote → 403. */
export function originAllowed(origin, selfOrigin, allowList) {
  if (origin === null || origin === undefined) return true;
  if (origin === selfOrigin) return true;
  if (allowList) return String(allowList).split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

const isId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * Handle one JSON-RPC message. Returns { response?, status?, headers?, isCheck? }.
 * `response` undefined = notification accepted (202 when it's the whole request).
 */
async function handleMessage(msg, { modern, request, deps, auth, checkBudget }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request'), status: 400 };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.jsonrpc !== '2.0') return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'), status: 400 };
  if (typeof msg.method !== 'string') {
    // A JSON-RPC response or garbage. Legacy clients may POST responses → accept like a notification.
    if (!modern && hasId && ('result' in msg || 'error' in msg)) return {};
    return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: method is required'), status: 400 };
  }
  if (!hasId) return {}; // notification (notifications/initialized, cancelled, …): accepted, nothing to do
  if (!isId(msg.id)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request: id must be a string or number'), status: 400 };
  const { id, method } = msg;
  const params = msg.params === undefined ? {} : msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { response: rpcError(id, E.INVALID_PARAMS, 'params must be an object') };

  // Modern results carry serverInfo in _meta; merge so a tool error's _meta["jsonmend/error"] is kept (CertGuard fix c2606ed).
  const done = (result) => ({ response: rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER]: SERVER_INFO } } : result) });
  const notFound = () => ({ response: rpcError(id, E.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`), status: modern ? 404 : 200 });
  const instr = instructions(deps.limits);

  if (modern) {
    // MCP 2026-07-28 per-request validation (version, capabilities, mirrored headers).
    const hName = decodeHeaderValue(request.headers.get('mcp-name'));
    if (request.headers.get('mcp-method') !== method) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing or does not match the body method'), status: 400 };
    if (!params._meta || typeof params._meta[META_CAPS] !== 'object' || params._meta[META_CAPS] === null) {
      return { response: rpcError(id, E.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`), status: 400 };
    }
    if (method === 'tools/call' && hName !== params.name) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), status: 400 };
    if (method === 'server/discover') {
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: instr, ttlMs: 3_600_000, cacheScope: 'public' });
    }
    if (method === 'tools/list') return done({ tools: TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method !== 'tools/call') return notFound(); // includes initialize and ping (removed in 2026-07-28)
  } else {
    if (method === 'initialize') {
      const req = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(req) ? req : LEGACY_VERSIONS[0];
      return done({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    }
    if (method === 'ping') return done({});
    if (method === 'tools/list') return done({ tools: TOOLS });
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    if (method !== 'tools/call') return notFound();
  }

  // tools/call
  if (typeof params.name !== 'string') return { response: rpcError(id, E.INVALID_PARAMS, 'params.name (tool name) is required') };
  if (checkBudget.used >= MAX_CHECKS_PER_REQUEST) {
    return { response: rpcError(id, E.INVALID_REQUEST, `At most ${MAX_CHECKS_PER_REQUEST} tools/call per HTTP request; send each call as its own request.`) };
  }
  checkBudget.used++;
  const r = await callTool(params, deps, auth);
  if (r.error) return { response: rpcError(id, r.error.code, r.error.message), isCheck: true };
  return { ...done(r.result), headers: r.headers, isCheck: true };
}

/** Entry point from the router for every request to /mcp. */
export async function handleMcp(request, env, ctx, deps) {
  const base = { ...MCP_CORS, ...deps.security };
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), 'cache-control': 'no-store', ...base, ...extra },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...MCP_CORS, ...deps.security } });
  if (!originAllowed(request.headers.get('origin'), deps.origin, deps.allowedOrigins)) {
    return reply(403, rpcError(null, E.SERVER, 'Forbidden: Origin not allowed'));
  }
  if (request.method !== 'POST') {
    return reply(405, rpcError(null, E.SERVER, 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream, no sessions). Docs: /llms.txt'), { allow: 'POST, OPTIONS' });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, rpcError(null, E.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
  let payload;
  try { payload = JSON.parse(text); } catch { return reply(400, rpcError(null, E.PARSE, 'Parse error: body must be valid JSON')); }

  // Era detection. Modern = per-request _meta version or a modern MCP-Protocol-Version header.
  const hVer = request.headers.get('mcp-protocol-version');
  const single = !Array.isArray(payload);
  const metaVer = single && payload && typeof payload === 'object' && payload.params && typeof payload.params === 'object'
    && payload.params._meta && typeof payload.params._meta === 'object' ? payload.params._meta[META_VERSION] : undefined;
  const modern = metaVer !== undefined || MODERN_VERSIONS.includes(hVer);
  const idOf = (p) => (p && typeof p === 'object' && isId(p.id) ? p.id : null);
  if (modern) {
    if (!single) return reply(400, rpcError(null, E.INVALID_REQUEST, 'JSON-RPC batches are not supported in protocol 2026-07-28; send one message per POST'));
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      if (metaVer === undefined && typeof payload.method === 'string') {
        return reply(400, rpcError(idOf(payload), E.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`));
      }
      if (metaVer !== undefined && !SUPPORTED_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(String(metaVer), 40) }));
      }
      if (metaVer !== undefined && !MODERN_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, `Protocol version ${metaVer} uses the initialize handshake; per-request _meta requires one of: ${MODERN_VERSIONS.join(', ')}`, { supported: SUPPORTED_VERSIONS, requested: metaVer }));
      }
      if (hVer !== metaVer) return reply(400, rpcError(idOf(payload), E.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing or does not match _meta protocolVersion'));
    }
  } else if (hVer && !LEGACY_VERSIONS.includes(hVer)) {
    return reply(400, rpcError(single ? idOf(payload) : null, E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(hVer, 40) }));
  }

  const msgs = single ? [payload] : payload;
  if (!msgs.length) return reply(400, rpcError(null, E.INVALID_REQUEST, 'Invalid Request: empty batch'));
  if (msgs.length > MAX_BATCH) return reply(400, rpcError(null, E.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH} messages)`));

  // Light per-IP-bucket cap on non-tool messages (tools/call is governed by the REST limits inside runTool).
  const nonCheck = msgs.filter((m) => !(m && m.method === 'tools/call')).length;
  for (let i = 0; i < nonCheck; i++) {
    if (!deps.memLimit(`mcp:${deps.ipBucket}`, DISCOVERY_PER_MIN, 60_000)) {
      return reply(429, rpcError(single ? idOf(payload) : null, E.SERVER, `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute). Retry in a minute.`, { code: 'rate_limited', retryAfterSeconds: 60 }), { 'retry-after': '60' });
    }
  }

  // Same key gate as the REST API, evaluated once per HTTP request (bad key → 401 for every method).
  const auth = await deps.authenticate(request, env);
  if (!auth.ok) {
    // No WWW-Authenticate on /mcp: MCP clients treat a 401 Bearer challenge as "start OAuth discovery", which this
    // server doesn't offer; the JSON-RPC error body (data.code = invalid_api_key) is the useful signal.
    return reply(auth.status, rpcError(single ? idOf(payload) : null, E.SERVER, auth.message, { code: auth.code, httpStatus: auth.status }), { ...(auth.headers || {}) });
  }

  const mdeps = { ...deps, env, ctx };
  const checkBudget = { used: 0 };
  const responses = [];
  let status = 200;
  let headers = {};
  for (const m of msgs) {
    let out;
    try {
      out = await handleMessage(m, { modern, request, deps: mdeps, auth, checkBudget });
    } catch {
      out = { response: rpcError(idOf(m), E.INTERNAL, 'Internal error') };
    }
    if (out.response) responses.push(out.response);
    if (single) status = out.status || 200;
    if (out.headers) headers = out.headers; // the (single) tools/call's REST headers, for batches too
  }
  if (!responses.length) return reply(202, null);
  const exposed = {};
  for (const h of PASS_HEADERS) if (headers[h]) exposed[h] = headers[h];
  return reply(status, single ? responses[0] : responses, exposed);
}
