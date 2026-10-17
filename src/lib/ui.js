// Static UI: landing page with the free paste-box tool, API docs, and the client script (served from /app.js so the
// CSP can forbid inline script).
import { VERSION } from './version.js';
import { MAX_INPUT_BYTES, MAX_DEPTH, FIX_MESSAGES } from './repair.js';
import { MAX_SCHEMA_BYTES } from './schema.js';
import { mcpClientConfig, CONTACT_EMAIL } from './agentdocs.js';

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => Number(n).toLocaleString('en-US');
const ext = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

export const faviconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f172a"/><text x="32" y="43" font-family="ui-monospace,Menlo,monospace" font-size="30" font-weight="700" text-anchor="middle" fill="#34d399">{ }</text></svg>';

const STYLE = `
:root{--bg:#0f172a;--card:#111c33;--fg:#e2e8f0;--mut:#94a3b8;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--acc:#34d399;--line:#1e2a44}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:960px;margin:0 auto;padding:28px 18px 60px}h1{margin:0 0 6px;font-size:30px;line-height:1.2}h1 span,.brand span{color:var(--acc)}
.brand{margin:0 0 10px;font-weight:700;font-size:18px}.cta{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
a.btn{display:inline-block;background:var(--acc);color:#04111f;font-weight:700;text-decoration:none;border-radius:8px;padding:11px 20px}
pre.curl3{margin:0;max-height:none}
h2{font-size:18px;margin:0 0 8px}p.sub{margin:0 0 22px;color:var(--mut)}a{color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-top:16px}
textarea,input,select,button{font:inherit;border-radius:8px;border:1px solid #334155;background:#0b1325;color:var(--fg);padding:10px 12px}
textarea{width:100%;min-height:200px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;resize:vertical}
#schema{min-height:110px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
button{background:var(--acc);color:#04111f;border:0;font-weight:600;cursor:pointer;padding:10px 18px}button.sec{background:#1e293b;color:var(--fg);border:1px solid #334155}button:disabled{opacity:.6}
label{color:var(--mut);font-size:14px}.mut{color:var(--mut)}.small{font-size:13px}.err{color:#fca5a5}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;margin-right:6px}
.b-ok{background:#14532d;color:#86efac}.b-warn{background:#4a3a0a;color:#fde68a}.b-bad{background:#4c1010;color:#fca5a5}.b-info{background:#0c3550;color:#7dd3fc}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:#0b1325;padding:12px;border-radius:8px;overflow:auto;max-height:480px;border:1px solid var(--line);white-space:pre-wrap;word-break:break-word}
ul{margin:6px 0 0;padding-left:18px}details summary{cursor:pointer;color:var(--mut)}footer{margin-top:30px;color:var(--mut);font-size:13px}
#agents pre{max-height:none}
@media (max-width:560px){#mcp-config{white-space:pre-wrap;word-break:break-all}main{padding:20px 12px 40px}}
`;

const head = (cfg, title, desc, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="description" content="${escHtml(desc)}">
${extra}${cfg.publicLaunch ? '' : '<meta name="robots" content="noindex,nofollow">'}
<style>${STYLE}</style></head><body><main>`;

export const EXAMPLE_INPUT = 'Sure! Here is the JSON you asked for:\n```json\n{\n  name: \'Ada Lovelace\',\n  "born": "1815",\n  "languages": ["English", "French",],\n  // TODO: add more\n  "active": True,\n  "notes": "first programmer\n```';

export function indexHtml(cfg, origin = '') {
  const mcpUrl = `${origin}/mcp`;
  return `${head(cfg, 'JsonMend: repair broken JSON from LLM output (free tool + API + MCP)', 'Paste broken JSON from any LLM (chatbot or API) and get valid JSON back, plus the list of fixes. Optional JSON Schema validation. Free web tool, JSON API and MCP server.',
    '<link rel="canonical" href="/">\n<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">\n<link rel="service-desc" type="application/json" href="/openapi.json" title="OpenAPI 3.1">\n')}
<p class="brand">Json<span>Mend</span></p>
<h1>Fix broken JSON from LLM output</h1>
<p class="sub">Paste what your model returned and get valid JSON back, with every fix listed and an optional JSON Schema check.</p>
<div class="cta"><a class="btn" id="cta-fix" href="#tool">Fix my JSON</a><a href="#key" id="cta-key">Get a free API key</a><span class="mut small"><a href="/docs">API docs</a> · <a href="#agents">MCP</a></span></div>
<pre class="curl3" aria-label="curl example">curl -X POST '${escHtml(origin)}/api/v1/repair' \\
  -H 'content-type: text/plain' \\
  --data-binary "{name: 'Ada', tags: [1,2,],}"</pre>
<p class="mut small">It handles code fences, prose around the JSON, trailing commas, single quotes, unquoted keys, comments, Python <code>True</code>/<code>None</code>, and truncated arrays and objects.</p>
<section class="card" id="tool"><h2>Paste your JSON</h2>
<form id="f" autocomplete="off">
<textarea id="input" aria-label="Broken JSON input" spellcheck="false" placeholder="Paste LLM output or broken JSON here (max ${fmt(MAX_INPUT_BYTES)} bytes)"></textarea>
<details id="schemabox"><summary>Validate against a JSON Schema (optional)</summary>
<textarea id="schema" aria-label="JSON Schema" spellcheck="false" placeholder='{"type":"object","required":["name"],"properties":{"name":{"type":"string"},"born":{"type":"integer"}}}'></textarea>
<div class="row"><label><input type="checkbox" id="coerce"> Coerce types to match the schema ("42" → 42, "true" → true)</label></div></details>
<div class="row"><button id="go" type="submit">Repair JSON</button>
<label for="format">Output</label><select id="format"><option value="pretty">pretty</option><option value="compact">compact</option><option value="preserve">preserve</option></select>
<button class="sec" id="example" type="button">Load example</button><span class="mut small" id="bytes"></span></div>
</form>
<div id="out"></div></section>
<section class="card" id="key"><h2>Free API key</h2>
<p>No key is needed to try it (about ${cfg.anonPerMin} requests per minute and ${fmt(cfg.anonDailyPerIp)} per day per IP). A free key gives about ${cfg.keyPerMin} per minute and ${fmt(cfg.keyMonthlyQuota)} requests per month.</p>
<div class="row"><button class="sec" id="getkey" type="button">Get a free key</button><span class="mut small">Shown once; we keep only a hash.</span></div><div id="keyout"></div>
<pre>curl -X POST '${escHtml(origin)}/api/v1/repair' -H 'content-type: text/plain' --data-binary @broken.json
curl -X POST '${escHtml(origin)}/api/v1/repair' -H 'content-type: application/json' \\
  -H 'Authorization: Bearer jm_...' -d '{"input":"{name: \\u0027Ada\\u0027, tags: [1,2,],}"}'</pre></section>
<section id="agents" class="card"><h2>For AI agents (MCP)</h2>
<p>JsonMend is also a remote ${ext('https://modelcontextprotocol.io/', 'Model Context Protocol')} (MCP) server with two read-only tools, <code>repair_json</code> and <code>validate_json</code>. Most MCP clients accept this config; some use a different format (for example, VS Code uses a <code>servers</code> key). Clients with a settings screen just need the URL <code>${escHtml(mcpUrl)}</code>.</p>
<pre><code id="mcp-config">${escHtml(JSON.stringify(mcpClientConfig(origin), null, 2))}</code></pre>
<p class="mut small">Same limits and optional free API key as the JSON API (send it as <code>X-API-Key</code> or <code>Authorization: Bearer</code>). Machine-readable docs: <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI 3.1 spec</a> · <a href="/docs">API docs</a></p></section>
<section id="privacy" class="card"><h2>Privacy</h2>
<p class="small">The JSON you paste is processed in memory to produce the response and is not stored or logged by JsonMend. JsonMend never fetches anything: no URLs are opened, and remote schema <code>$ref</code>s are not followed. Rate limits keep a counter keyed by a salted hash of your IP address (kept up to 2 days). For a free API key we store only a hash of the key, a salted hash of the network it was requested from (so all keys from one network share a monthly quota), and, if you give one, a salted hash of your email address. To count daily unique visitors we store, for one UTC day (deleted after 9 days), only a salted one-way hash of your network and the date; no IP address, browser details or pasted content. The service runs on Cloudflare Workers.</p></section>
<footer>JsonMend v${VERSION} · Repair engine: ${ext('https://github.com/josdejong/jsonrepair', 'jsonrepair')} (ISC) · Schema checks: ${ext('https://github.com/cfworker/cfworker/tree/main/packages/json-schema', '@cfworker/json-schema')} (MIT) · Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></footer>
</main><script src="/app.js"></script></body></html>`;
}

export function docsHtml(cfg, origin) {
  const o = escHtml(origin);
  const fixRows = Object.entries(FIX_MESSAGES).map(([c, m]) => `<li><code>${c}</code>: ${escHtml(m)}</li>`).join('');
  return `${head(cfg, 'JsonMend API docs', 'JsonMend JSON API: repair broken JSON and validate it against a JSON Schema.')}
<h1>Json<span>Mend</span> API</h1><p class="sub"><a href="/">← paste-box tool</a></p>
<div class="card" id="quickstart"><h2>Quickstart</h2>
<p>1. Try it with no key:</p>
<pre>curl -X POST '${o}/api/v1/repair' -H 'content-type: text/plain' \\
  --data-binary "{name: 'Ada', tags: [1,2,],}"</pre>
<p>2. Get a free key (shown once), then send the same call with it:</p>
<pre>curl -X POST '${o}/api/v1/keys' -H 'content-type: application/json' -d '{}'
curl -X POST '${o}/api/v1/repair' -H 'content-type: text/plain' -H 'X-API-Key: jm_...' \\
  --data-binary "{name: 'Ada', tags: [1,2,],}"</pre></div>
<div class="card" id="limits-plain"><h2>Limits in plain words</h2><ul>
<li>Without a key you can make about ${cfg.anonPerMin} requests a minute and ${fmt(cfg.anonDailyPerIp)} a day from one IP address.</li>
<li>A free key raises that to about ${cfg.keyPerMin} a minute and ${fmt(cfg.keyMonthlyQuota)} a month.</li>
<li>Each input can be up to ${fmt(MAX_INPUT_BYTES)} bytes, each schema up to ${fmt(MAX_SCHEMA_BYTES)} bytes, nested at most ${MAX_DEPTH} levels deep.</li>
<li>A repair or a validation counts as one request, whether it comes from the API or an MCP <code>tools/call</code>.</li></ul></div>
<div class="card" id="endpoints"><h2>Endpoints</h2><ul>
<li><code>POST /api/v1/repair</code>: turn broken JSON text into valid JSON and list the fixes.</li>
<li><code>POST /api/v1/validate</code>: check JSON text or a value against a JSON Schema (optionally coercing types).</li>
<li><code>POST /api/v1/keys</code>: get a free API key.</li>
<li><code>GET /api/v1/usage</code>: see this month's usage for your key.</li>
<li><code>POST /mcp</code>: the same two tools for AI agents over MCP.</li>
<li><code>GET /health</code>: service status and version.</li></ul></div>
<div class="card"><h2>POST /api/v1/repair</h2>
<pre>curl -X POST '${o}/api/v1/repair' -H 'content-type: application/json' \\
  -d '{"input":"\`\`\`json\\n{\\"a\\": 1, \\"b\\": [1,2,],}\\n\`\`\`","format":"compact"}'
curl -X POST '${o}/api/v1/repair?format=pretty' -H 'content-type: text/plain' --data-binary @llm-output.txt</pre>
<p>Body fields: <code>input</code> (string, required, max ${fmt(MAX_INPUT_BYTES)} bytes), <code>format</code> (<code>compact</code> default, <code>pretty</code>, <code>preserve</code> = keep the repaired text's spacing and long-number digits), optional <code>schema</code>, <code>coerce</code>, <code>draft</code> (validate the result too). Or send the raw text as the body with <code>Content-Type: text/plain</code>.</p>
<pre>{
  "ok": true, "changed": true, "inputWasValid": false, "values": 1,
  "fixes": [ { "code": "stripped_code_fence", "message": "..." }, { "code": "trailing_commas", "message": "...", "count": 2 } ],
  "warnings": [],
  "json": { "a": 1, "b": [1, 2] },
  "text": "{\\"a\\":1,\\"b\\":[1,2]}",
  "format": "compact", "inputBytes": 37, "outputBytes": 17
}</pre>
<p>Already-valid JSON comes back unchanged with <code>"changed": false</code> and no fixes. Several top-level values (NDJSON, or objects one after another) are wrapped in one array (<code>wrapped_multiple_values</code>). If nothing JSON-like can be recovered the answer is <code>422</code> with <code>no_json_found</code> or <code>unrepairable</code> (plus <code>position</code> when known).</p>
<p>Fix codes:</p><ul class="small">${fixRows}</ul></div>
<div class="card"><h2>POST /api/v1/validate</h2>
<pre>curl -X POST '${o}/api/v1/validate' -H 'content-type: application/json' \\
  -d '{"schema":{"type":"object","required":["age"],"properties":{"age":{"type":"integer"}}},"input":"{age: \\"42\\"}","coerce":true}'</pre>
<p>Send <code>schema</code> plus either <code>input</code> (JSON text, repaired first if broken) or <code>data</code> (an already-parsed value). <code>coerce: true</code> converts values toward the schema's types (<code>"42"</code> → 42, <code>"true"</code> → true, <code>"null"</code> → null, 5 → <code>"5"</code>, x → [x]) and lists every change in <code>coercions</code>. Drafts 2020-12 (default), 2019-09, 7 and 4; the draft is taken from <code>$schema</code> when present. Only local <code>$ref</code>s (<code>#/...</code>) resolve; JsonMend never fetches remote schemas. A mismatch is a normal <code>200</code> with <code>"valid": false</code> and up to 50 <code>errors</code> (<code>path</code> is a JSON Pointer).</p>
<pre>{ "ok": true, "valid": true, "errorCount": 0, "errors": [], "draft": "2020-12",
  "coerced": true, "coercions": [ { "path": "/age", "from": "string", "to": "integer" } ],
  "repaired": true, "fixes": [ { "code": "unquoted_keys", "message": "..." } ], "warnings": [], "json": { "age": 42 } }</pre></div>
<div class="card"><h2>Limits &amp; free API keys</h2>
<p>Anonymous: ${cfg.anonPerMin} requests/minute and ${fmt(cfg.anonDailyPerIp)}/day per IP (IPv6: per /64; ${fmt(cfg.anonDailyPer48)}/day per /48). With a free key (<code>X-API-Key</code> or <code>Authorization: Bearer</code>): ${cfg.keyPerMin}/minute and ${fmt(cfg.keyMonthlyQuota)}/month (UTC calendar month). All keys issued to one IP share ${fmt(cfg.keyIssuerMonthlyQuota)} requests/month.</p>
<pre>curl -X POST '${o}/api/v1/keys' -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -H 'X-API-Key: jm_...' '${o}/api/v1/usage'</pre>
<p><code>email</code> is optional contact info and is not verified. At most ${cfg.keyIssuePerIpPerDay} keys per IP per day.</p>
<p>Errors: <code>{ "ok": false, "error": { "code", "message" } }</code>. <code>400</code> invalid body/arguments/schema, <code>401</code> bad key, <code>405</code> wrong method, <code>413</code> body/input/schema too large, <code>415</code> keys endpoint needs JSON, <code>422</code> no JSON found / unrepairable / too deeply nested, <code>429</code> rate limit or quota (see <code>Retry-After</code>), <code>503</code> not configured.</p></div>
<div class="card"><h2>MCP server for AI agents</h2><p><code>POST ${o}/mcp</code>: remote MCP (Streamable HTTP, stateless, JSON responses). Tools <code>repair_json</code> and <code>validate_json</code> (read-only, no network access). Same keys and limits as the JSON API; each <code>tools/call</code> is one request. Machine-readable: <a href="/llms.txt">/llms.txt</a>, <a href="/openapi.json">/openapi.json</a>.</p></div>
<div class="card"><h2>Other</h2><p><code>GET /health</code>: service status. <code>/sitemap.xml</code>, <code>/robots.txt</code>. Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p></div>
</main></body></html>`;
}

export const appJs = `(() => {
  const $ = (s) => document.querySelector(s);
  const mc = document.getElementById('mcp-config');
  if (mc) mc.textContent = JSON.stringify({ mcpServers: { jsonmend: { type: 'http', url: location.origin + '/mcp' } } }, null, 2);
  const cta = document.getElementById('cta-fix');
  if (cta) cta.addEventListener('click', (e) => { const t = document.getElementById('input'); if (!t) return; e.preventDefault(); document.getElementById('tool').scrollIntoView({ behavior: 'smooth', block: 'start' }); t.focus({ preventScroll: true }); history.replaceState(null, '', '#tool'); });
  const MAX = ${MAX_INPUT_BYTES};
  const EXAMPLE = ${JSON.stringify(EXAMPLE_INPUT)};
  const out = $('#out');
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else e.setAttribute(k, v); } for (const k of kids) e.append(k && k.nodeType ? k : String(k ?? '')); return e; };
  const badge = (t, k) => el('span', { class: 'badge b-' + k }, t);
  const bytes = (s) => new TextEncoder().encode(s).length;
  const showBytes = () => { const n = bytes($('#input').value); $('#bytes').textContent = n ? n.toLocaleString() + ' / ' + MAX.toLocaleString() + ' bytes' : ''; };
  $('#input').addEventListener('input', showBytes);
  $('#example').addEventListener('click', () => { $('#input').value = EXAMPLE; showBytes(); });
  function schemaBlock(v) {
    const box = el('div', { class: 'card' }, el('b', {}, 'Schema: '), v.valid ? badge('valid', 'ok') : badge((v.errorsTruncated ? 'at least ' : '') + v.errorCount + ' error' + (v.errorCount === 1 ? '' : 's'), 'bad'));
    if (v.errors && v.errors.length) { const ul = el('ul'); for (const e of v.errors) ul.append(el('li', {}, el('code', {}, e.path || '(root)'), ' ' + e.message)); box.append(ul); }
    if (v.coercions && v.coercions.length) { const ul = el('ul', { class: 'small mut' }); for (const c of v.coercions) ul.append(el('li', {}, 'coerced ' + (c.path || '(root)') + ': ' + c.from + ' → ' + c.to)); box.append(ul); }
    return box;
  }
  function render(r) {
    out.replaceChildren();
    if (!r.ok) { out.append(el('div', { class: 'card err' }, (r.error && r.error.message) || 'Error')); return; }
    const top = el('div', { class: 'card' });
    top.append(r.changed ? badge('repaired', 'ok') : badge('already valid', 'info'));
    if (r.values > 1) top.append(badge(r.values + ' values wrapped in an array', 'info'));
    if (r.fixes.length) { const ul = el('ul'); for (const f of r.fixes) ul.append(el('li', {}, el('code', {}, f.code), ' ' + f.message + (f.count ? ' (×' + f.count + ')' : ''))); top.append(ul); }
    for (const w of r.warnings || []) top.append(el('div', { class: 'small', style: 'color:#fde68a;margin-top:6px' }, w.message));
    out.append(top);
    if (r.schema) out.append(schemaBlock(r.schema));
    const pre = el('pre', { id: 'result' }, r.text);
    const copy = el('button', { class: 'sec', type: 'button' }, 'Copy JSON');
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.text); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; } setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1500); });
    out.append(el('div', { class: 'card' }, el('div', { class: 'row', style: 'margin:0 0 8px' }, el('b', {}, 'Valid JSON'), copy), pre));
  }
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#input').value;
    if (!input.trim()) return;
    if (bytes(input) > MAX) { render({ ok: false, error: { message: 'Input is larger than ' + MAX.toLocaleString() + ' bytes.' } }); return; }
    const body = { input, format: $('#format').value };
    const st = $('#schema').value.trim();
    if (st) {
      try { body.schema = JSON.parse(st); } catch { render({ ok: false, error: { message: 'The schema box must contain valid JSON (a JSON Schema object).' } }); return; }
      if ($('#coerce').checked) body.coerce = true;
    }
    $('#go').disabled = true; out.replaceChildren(el('div', { class: 'card mut' }, 'Repairing…'));
    try {
      const res = await fetch('/api/v1/repair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      render(await res.json());
    } catch (err) { render({ ok: false, error: { message: 'Request failed: ' + err.message } }); }
    finally { $('#go').disabled = false; }
  });
  $('#getkey').addEventListener('click', async () => {
    const b = $('#getkey'); b.disabled = true; const ko = $('#keyout');
    try {
      const res = await fetch('/api/v1/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await res.json();
      ko.replaceChildren(j.ok ? el('pre', {}, j.apiKey + '\\n\\n' + j.note) : el('div', { class: 'err' }, (j.error && j.error.message) || 'Error'));
    } catch (err) { ko.replaceChildren(el('div', { class: 'err' }, 'Request failed: ' + err.message)); }
    finally { b.disabled = false; }
  });
})();`;
