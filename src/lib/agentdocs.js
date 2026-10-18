/**
 * Agent-discovery documents: /llms.txt (llmstxt.org format), /openapi.json (OpenAPI 3.1) and the MCP server card
 * (/.well-known/mcp/server-card.json). Generated from code constants and config(env) so limits / versions / URLs
 * can't drift from what the Worker enforces.
 */
import { VERSION } from './version.js';
import { FIX_CODES, FORMATS, MAX_INPUT_BYTES, MAX_DEPTH } from './repair.js';
import { DRAFTS, MAX_SCHEMA_BYTES, MAX_ERRORS, MAX_SCHEMA_STEPS, MAX_INPLACE, MAX_RAW_ERRORS, ERR_COST } from './schema.js';
import { TOOLS, SERVER_INFO, SUPPORTED_VERSIONS, MAX_BODY_BYTES, MAX_BATCH, DISCOVERY_PER_MIN } from './mcp.js';

export const CONTACT_EMAIL = 'digitalpromohub.support@gmail.com';
const fmt = (n) => Number(n).toLocaleString('en-US');

export function mcpClientConfig(origin) {
  return { mcpServers: { jsonmend: { type: 'http', url: `${origin}/mcp` } } };
}

/** MCP registry HTTP-namespace proof: only a well-formed PUBLIC key record is ever served (else 404). */
export function registryAuthProof(env) {
  const proof = String((env && env.MCP_REGISTRY_AUTH) || '').trim();
  return /^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/.test(proof) ? proof : null;
}

// Glama connector ownership claim, served at /.well-known/glama.json. Set your own glama.ai claim token as the GLAMA_CLAIM Worker secret (or replace the placeholder, if present).
export const GLAMA_CLAIM = '<GLAMA_CLAIM_TOKEN>';
export const GLAMA_JSON = JSON.stringify({ $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: GLAMA_CLAIM });

export const SHORT_DESCRIPTION = 'Repair broken JSON from LLM output and validate it against a JSON Schema. Returns valid JSON plus the fixes applied.';

export function llmsTxt(origin, L) {
  return `# JsonMend

> Repairs broken JSON (typically LLM output) and returns valid JSON plus a list of the fixes applied, with optional JSON Schema validation and type coercion. Public JSON API plus a remote MCP server for AI agents.

JsonMend strips Markdown code fences and prose around the JSON, removes comments and trailing commas, converts single and curly quotes, quotes unquoted keys, maps Python \`None\`/\`True\`/\`False\`, inserts missing commas, closes truncated strings, arrays and objects, and wraps NDJSON or several concatenated values into one array. Already-valid JSON is returned unchanged with \`"changed": false\` and no fixes. Repair uses jsonrepair; schemas are checked with @cfworker/json-schema (drafts ${DRAFTS.join(', ')}; only local \`$ref\`s). Pure computation: JsonMend fetches nothing and does not store your input.

## Quickstart

1. No key: \`curl -X POST '${origin}/api/v1/repair' -H 'content-type: text/plain' --data-binary "{name: 'Ada', tags: [1,2,],}"\` → \`{"ok":true,"json":{"name":"Ada","tags":[1,2]},"fixes":[...]}\`
2. Free key (shown once): \`curl -X POST '${origin}/api/v1/keys' -H 'content-type: application/json' -d '{}'\`, then send the same call with \`-H 'X-API-Key: jm_...'\`.
3. In plain words: without a key, about ${L.anonPerMin} requests a minute and ${fmt(L.anonDailyPerIp)} a day per IP; with a free key, about ${L.keyPerMin} a minute and ${fmt(L.keyMonthlyQuota)} a month. Inputs up to ${fmt(MAX_INPUT_BYTES)} bytes. Every repair or validation (API or MCP \`tools/call\`) is one request.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP at \`${origin}/mcp\` (POST only, stateless, JSON responses, no sessions). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')} (2026-07-28 per-request \`_meta\`; older versions use \`initialize\`). Tools: \`${TOOLS[0].name}\` (\`input\` required; \`format\`, \`schema\`, \`coerce\`, \`draft\` optional) and \`${TOOLS[1].name}\` (\`schema\` required, plus \`input\` text or \`data\` value; \`coerce\`, \`draft\` optional). Both read-only, no network access. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API
- [JSON API docs](${origin}/docs): human-readable API reference with examples

## JSON API

- \`POST ${origin}/api/v1/repair\` with \`{"input":"<broken JSON text>"}\` (optional \`format\`: ${FORMATS.join(' | ')}; optional \`schema\`, \`coerce\`, \`draft\`), or the raw text as the body with \`Content-Type: text/plain\`. Returns \`json\` (the value), \`text\`, \`changed\`, \`inputWasValid\`, \`fixes\` [{\`code\`, \`message\`, \`count\`}], \`warnings\`, and \`schema\` when a schema was sent. Fix codes: ${FIX_CODES.map((c) => `\`${c}\``).join(', ')}. CORS enabled.
- \`POST ${origin}/api/v1/validate\` with \`{"schema":{...},"input":"<JSON text>"}\` or \`{"schema":{...},"data":<value>}\` (optional \`coerce\`, \`draft\`): \`valid\`, \`errorCount\`, \`errors\` [{\`path\`, \`keyword\`, \`schemaPath\`, \`message\`}] (at most ${MAX_ERRORS} listed; past ${fmt(MAX_RAW_ERRORS)} raw validator errors only the first ${fmt(MAX_RAW_ERRORS)} are examined, \`errorsTruncated\` is true and \`errorCount\` is a lower bound), \`coercions\`, \`repaired\`, \`fixes\`, \`json\`. A schema mismatch is HTTP 200 with \`"valid": false\`.
- \`POST ${origin}/api/v1/keys\` (get a free API key) with \`{}\` or \`{"email":"you@example.com"}\` (JSON, no CORS): the key is shown once.
- \`GET ${origin}/api/v1/usage\` (see your key's usage) with your key: this month's usage and quota.
- \`GET ${origin}/health\`: service status and \`version\` (${VERSION}).
- Caps: input ${fmt(MAX_INPUT_BYTES)} bytes (UTF-8), schema ${fmt(MAX_SCHEMA_BYTES)} bytes, request body ${fmt(MAX_BODY_BYTES)} bytes, nesting depth ${MAX_DEPTH} (for \`input\` whether or not it needed repair, and for \`data\`).
- Schema complexity: a schema that loops back to itself without descending into the data (e.g. \`{"allOf":[{"$ref":"#"},{"$ref":"#"}]}\`; the same holds for loops through \`not\`, \`if\`/\`then\`/\`else\`, \`anyOf\`/\`oneOf\` or \`dependentSchemas\` that point back at an ancestor without going through \`properties\`/\`items\` etc.), or applies more than ${fmt(MAX_INPLACE)} subschemas to one value, is rejected up front with 422 \`schema_too_complex\` (no quota used). Checking data against a schema is limited to ${fmt(MAX_SCHEMA_STEPS)} steps (value × applicable subschema, coercion included; large \`enum\`/\`const\` values, each \`required\`/\`dependentRequired\` name checked, and each predicted keyword failure (${ERR_COST} steps; \`const\`/\`enum\` on objects/arrays are assumed to fail; inside \`not\` a predicted failure adds 1 step) add steps); over it: 422 \`schema_too_complex\`, which counts as a request. Other pathological schemas, notably catastrophic regex \`pattern\`s, can be stopped by the per-request CPU limit instead: the platform then returns a 5xx without the JSON error shape, and the request still counts.
- Errors: \`{ "ok": false, "error": { "code", "message" } }\` with HTTP 400 \`invalid_json\`/\`invalid_arguments\`/\`invalid_schema\`/\`empty_input\`, 401 \`invalid_api_key\`, 413 \`payload_too_large\`/\`input_too_large\`/\`schema_too_large\`, 422 \`no_json_found\`/\`unrepairable\`/\`too_deep\`/\`schema_too_complex\`, 429 \`rate_limited\`/\`ip_daily_quota\`/\`key_quota_exceeded\`/\`issuer_quota_exceeded\`/\`daily_cap_reached\` (see \`Retry-After\`), 503 \`not_configured\`.

## Limits and keys

- Anonymous (no key): about ${L.anonPerMin} requests per minute and ${fmt(L.anonDailyPerIp)} per UTC day per IP (IPv6: per /64, and ${fmt(L.anonDailyPer48)} per /48).
- Free API key: about ${L.keyPerMin} requests per minute and ${fmt(L.keyMonthlyQuota)} per calendar month (UTC); all keys issued to one IP share ${fmt(L.keyIssuerMonthlyQuota)} requests per month. Send \`X-API-Key: jm_…\` or \`Authorization: Bearer jm_…\`. At most ${L.keyIssuePerIpPerDay} new keys per IP per day. There is no paid plan yet.
- The MCP endpoint uses the same keys and the same counters: each \`tools/call\` is one request. \`initialize\`, \`tools/list\` and other non-tool messages don't count toward the request quota, but have a light cap of about ${DISCOVERY_PER_MIN} per minute per IP (over it: HTTP 429 with \`Retry-After\`). Over a limit, the tool result has \`isError: true\` with the reason and \`retryAfterSeconds\`. An invalid key returns HTTP 401.
- What counts: every call that reaches the repair engine or the validator is one request, including failed repairs (422 \`unrepairable\`, \`no_json_found\`, \`too_deep\` found while repairing) and 422 \`schema_too_complex\` from the step limit. Argument errors (400, 413, and the up-front 422 checks on \`data\` depth and schema shape) are rejected before any counter and don't count.
- MCP request caps: ${fmt(MAX_BODY_BYTES)}-byte body, JSON-RPC batches (legacy versions only) of at most ${MAX_BATCH} messages with at most one \`tools/call\`.

## Optional

- [Homepage and free paste-box tool](${origin}/)
- [Privacy](${origin}/#privacy)
- Contact: ${CONTACT_EMAIL}
`;
}

/** SEP-1649-style server card (Smithery fallback). Generated from the same TOOLS as tools/list. */
export function serverCard(origin) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: SUPPORTED_VERSIONS[0],
    serverInfo: SERVER_INFO,
    description: SHORT_DESCRIPTION,
    websiteUrl: `${origin}/`,
    transport: { type: 'streamable-http', url: `${origin}/mcp` },
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false, schemes: ['bearer'] },
    tools: TOOLS,
    resources: [],
    prompts: [],
  };
}

const errorSchema = { $ref: '#/components/schemas/Error' };
const json = (schema) => ({ 'application/json': { schema } });
const errResp = (description, extraHeaders) => ({ description, ...(extraHeaders ? { headers: extraHeaders } : {}), content: json(errorSchema) });
const retryAfter = { 'Retry-After': { description: 'Seconds to wait before retrying', schema: { type: 'integer' } } };
const planHeader = { 'x-jsonmend-plan': { description: '`anonymous` or `key`', schema: { type: 'string', enum: ['anonymous', 'key'] } } };
const allowHeader = { Allow: { schema: { type: 'string' } } };
const mcpNotAllowed = (m) => ({
  tags: ['mcp'],
  operationId: `mcp_${m}_not_allowed`,
  summary: 'Not supported (stateless server: no SSE stream, no sessions)',
  responses: {
    405: { description: 'Always 405 with `Allow: POST, OPTIONS` and a JSON-RPC error body', headers: { Allow: { schema: { type: 'string', const: 'POST, OPTIONS' } } }, content: json({ type: 'object' }) },
  },
});

export function openApiSpec(origin, L) {
  const sec = [{}, { apiKeyHeader: [] }, { bearerAuth: [] }];
  const toolErrors = {
    400: errResp('`invalid_json` (body is not a JSON object), `invalid_arguments`, `invalid_schema` (schema unusable, e.g. bad regex or unresolved $ref) or `empty_input`'),
    401: errResp('`invalid_api_key`: a key was sent but is unknown or revoked'),
    405: errResp('`method_not_allowed`', allowHeader),
    413: errResp(`\`payload_too_large\` (body over ${fmt(MAX_BODY_BYTES)} bytes), \`input_too_large\` (input over ${fmt(MAX_INPUT_BYTES)} bytes) or \`schema_too_large\` (over ${fmt(MAX_SCHEMA_BYTES)} bytes)`),
    422: { description: `\`no_json_found\`, \`unrepairable\` (with \`position\` when known), \`too_deep\` (nesting over ${MAX_DEPTH}) or \`schema_too_complex\` (schema loops without descending into the data, applies over ${fmt(MAX_INPLACE)} subschemas to one value, or checking needs over ${fmt(MAX_SCHEMA_STEPS)} steps). Failures found while repairing or validating count as a request; the up-front checks (schema loop/size, \`data\` depth) do not.`, headers: planHeader, content: json(errorSchema) },
    429: errResp('`rate_limited` (per-minute), `ip_daily_quota`, `key_quota_exceeded`, `issuer_quota_exceeded` or `daily_cap_reached` (service-wide daily allowance)', retryAfter),
    500: errResp('`internal_error`. Note: pathological schemas (e.g. catastrophic regex `pattern`s) can instead be stopped by the platform per-request CPU limit, which returns a 5xx without this JSON body; such requests still count.'),
    503: errResp('`not_configured` (deployment missing its HASH_PEPPER secret)'),
  };
  const validationProps = {
    valid: { type: 'boolean' }, errorCount: { type: 'integer', description: 'Errors found; a lower bound when errorsTruncated is true' },
    errorsTruncated: { type: 'boolean', description: `true when the validator produced more than ${fmt(MAX_RAW_ERRORS)} raw errors and only the first ${fmt(MAX_RAW_ERRORS)} were examined` },
    errors: { type: 'array', maxItems: MAX_ERRORS, items: { $ref: '#/components/schemas/SchemaError' } },
    draft: { type: 'string', enum: DRAFTS }, coerced: { type: 'boolean' },
    coercions: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } } },
  };
  const schemaArg = { type: ['object', 'boolean'], description: `JSON Schema (max ${fmt(MAX_SCHEMA_BYTES)} bytes). Only local $refs.` };
  const inputArg = { type: 'string', maxLength: MAX_INPUT_BYTES, description: `Raw (possibly broken) JSON text, max ${fmt(MAX_INPUT_BYTES)} bytes UTF-8` };
  return {
    openapi: '3.1.0',
    info: {
      title: 'JsonMend API',
      version: VERSION,
      summary: SHORT_DESCRIPTION,
      description: `Free JSON API behind ${origin}. No key needed for light use (about ${L.anonPerMin} requests/min and ${fmt(L.anonDailyPerIp)}/day per IP). A free API key (POST /api/v1/keys) allows about ${L.keyPerMin}/min and ${fmt(L.keyMonthlyQuota)}/month. There are no X-RateLimit-* headers; a 429 carries Retry-After. Pure computation: nothing is fetched, inputs are not stored. AI agents can also use the remote MCP server at ${origin}/mcp (see /llms.txt).`,
      contact: { name: 'JsonMend', email: CONTACT_EMAIL, url: `${origin}/` },
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Human-readable API docs', url: `${origin}/docs` },
    tags: [{ name: 'json' }, { name: 'keys' }, { name: 'meta' }, { name: 'mcp' }],
    components: {
      securitySchemes: {
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Free key (`jm_` + 32 characters). Optional on /api/v1/repair, /api/v1/validate and /mcp.' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Same key as apiKeyHeader, as `Authorization: Bearer jm_…`. X-API-Key wins when both are sent.' },
      },
      schemas: {
        Error: {
          type: 'object', required: ['ok', 'error'],
          properties: { ok: { const: false }, error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, position: { type: 'integer', description: 'Character offset in the input where repair failed (unrepairable only)' } } } },
        },
        Fix: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string', enum: FIX_CODES }, message: { type: 'string' }, count: { type: 'integer', minimum: 2 } } },
        Warning: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
        SchemaError: { type: 'object', required: ['path', 'keyword', 'schemaPath', 'message'], properties: { path: { type: 'string', description: 'JSON Pointer to the failing value ("" = root)' }, keyword: { type: 'string' }, schemaPath: { type: 'string' }, message: { type: 'string' } } },
        Validation: { type: 'object', required: ['valid', 'errorCount', 'errorsTruncated', 'errors', 'draft', 'coerced', 'coercions'], properties: validationProps },
        RepairResult: {
          type: 'object',
          required: ['ok', 'changed', 'inputWasValid', 'values', 'fixes', 'warnings', 'json', 'text', 'format', 'inputBytes', 'outputBytes'],
          properties: {
            ok: { const: true }, changed: { type: 'boolean' }, inputWasValid: { type: 'boolean' },
            values: { type: 'integer', description: 'Top-level values found; more than 1 = wrapped in an array' },
            fixes: { type: 'array', items: { $ref: '#/components/schemas/Fix' } },
            warnings: { type: 'array', items: { $ref: '#/components/schemas/Warning' } },
            json: { description: 'The repaired value (any JSON type; coerced when coerce was used)' },
            text: { type: 'string', description: 'The repaired JSON as text, in the requested format' },
            format: { type: 'string', enum: FORMATS }, inputBytes: { type: 'integer' }, outputBytes: { type: 'integer' },
            schema: { $ref: '#/components/schemas/Validation' },
          },
        },
        ValidateResult: {
          type: 'object',
          required: ['ok', 'valid', 'errorCount', 'errorsTruncated', 'errors', 'draft', 'coerced', 'coercions', 'repaired', 'fixes', 'warnings', 'json'],
          properties: {
            ok: { const: true }, ...validationProps, repaired: { type: 'boolean' },
            fixes: { type: 'array', items: { $ref: '#/components/schemas/Fix' } },
            warnings: { type: 'array', items: { $ref: '#/components/schemas/Warning' } },
            json: { description: 'The validated value (after repair and coercion)' },
          },
        },
        JsonRpcMessage: {
          type: 'object', required: ['jsonrpc'],
          properties: { jsonrpc: { const: '2.0' }, id: { type: ['string', 'integer'] }, method: { type: 'string' }, params: { type: 'object' } },
        },
      },
    },
    paths: {
      '/api/v1/repair': {
        post: {
          tags: ['json'], operationId: 'repairJson', summary: 'Repair broken JSON and list the fixes (optionally validate against a schema)', description: 'Turn broken JSON text (for example LLM output with code fences, comments or trailing commas) into valid JSON and list every fix made.', security: sec,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { type: 'object', required: ['input'], additionalProperties: false, properties: { input: inputArg, format: { type: 'string', enum: FORMATS, default: 'compact' }, schema: schemaArg, coerce: { type: 'boolean', default: false }, draft: { type: 'string', enum: DRAFTS } } } },
              'text/plain': { schema: { type: 'string', maxLength: MAX_INPUT_BYTES, description: 'The raw input itself (options: ?format=compact|pretty|preserve)' } },
            },
          },
          parameters: [{ name: 'format', in: 'query', required: false, description: 'Only for text/plain bodies', schema: { type: 'string', enum: FORMATS } }],
          responses: { 200: { description: 'Repaired (or passed-through) JSON with the fixes applied', headers: planHeader, content: json({ $ref: '#/components/schemas/RepairResult' }) }, ...toolErrors },
        },
      },
      '/api/v1/validate': {
        post: {
          tags: ['json'], operationId: 'validateJson', summary: 'Validate JSON text or a parsed value against a JSON Schema', description: 'Check JSON text (repaired first if broken) or an already-parsed value against a JSON Schema, optionally coercing types to match.', security: sec,
          requestBody: { required: true, content: json({ type: 'object', required: ['schema'], additionalProperties: false, properties: { schema: schemaArg, input: inputArg, data: { description: 'Already-parsed JSON value (instead of input)' }, coerce: { type: 'boolean', default: false }, draft: { type: 'string', enum: DRAFTS } } }) },
          responses: { 200: { description: 'Validation result (a schema mismatch is still 200, with valid: false)', headers: planHeader, content: json({ $ref: '#/components/schemas/ValidateResult' }) }, ...toolErrors },
        },
      },
      '/api/v1/keys': {
        post: {
          tags: ['keys'], operationId: 'createKey', summary: 'Get a free API key (shown once; JSON only; no CORS)', description: `Create a free key for higher limits (about ${L.keyPerMin}/min and ${fmt(L.keyMonthlyQuota)}/month); only its hash is stored.`, security: [{}],
          requestBody: { required: true, content: json({ type: 'object', properties: { email: { type: 'string', format: 'email', maxLength: 254, description: 'Optional, unverified contact info' } } }) },
          responses: {
            201: { description: 'Key created', content: json({ type: 'object', required: ['ok', 'apiKey', 'keyId'], properties: { ok: { const: true }, apiKey: { type: 'string', pattern: '^jm_[A-Za-z0-9]{32}$' }, keyId: { type: 'string' }, plan: { const: 'free' }, monthlyQuota: { type: 'integer' }, perMinute: { type: 'integer' }, note: { type: 'string' } } }) },
            400: errResp('`invalid_json` or `invalid_email`'),
            403: errResp('`cross_origin_forbidden`: requests from other websites are refused'),
            405: errResp('`method_not_allowed`', allowHeader),
            413: errResp('`payload_too_large`'),
            415: errResp('`unsupported_media_type`: send application/json'),
            429: errResp(`\`rate_limited\`, \`key_issue_limit\` (at most ${L.keyIssuePerIpPerDay} keys per IP per day) or \`daily_cap_reached\``, retryAfter),
            503: errResp('`not_configured` or `unavailable`'),
          },
        },
      },
      '/api/v1/usage': {
        get: {
          tags: ['keys'], operationId: 'usage', summary: 'This month\'s usage for your key', description: 'See how many requests your key has used this month and how many remain.', security: [{ apiKeyHeader: [] }, { bearerAuth: [] }],
          responses: {
            200: { description: 'Usage (approximate, batched counters)', content: json({ type: 'object', properties: { ok: { const: true }, keyId: { type: 'string' }, plan: { type: 'string' }, monthlyQuota: { type: 'integer' }, usedThisMonth: { type: 'integer' }, remainingThisMonth: { type: 'integer' }, perMinute: { type: 'integer' }, resetsAt: { type: 'string', format: 'date-time' }, note: { type: 'string' } } }) },
            401: errResp('`missing_api_key` or `invalid_api_key`'),
            405: errResp('`method_not_allowed`', allowHeader),
            503: errResp('`not_configured`'),
          },
        },
      },
      '/health': {
        get: {
          tags: ['meta'], operationId: 'health', summary: 'Service status and deployed version', description: 'Check that the service is up and which version is deployed.', security: [{}],
          responses: {
            200: { description: 'OK', content: json({ type: 'object', required: ['ok', 'service', 'version'], properties: { ok: { const: true }, service: { const: 'jsonmend' }, version: { type: 'string', examples: [VERSION] }, environment: { type: 'string' }, time: { type: 'string', format: 'date-time' } } }) },
            405: errResp('`method_not_allowed`', allowHeader),
          },
        },
      },
      '/mcp': {
        post: {
          tags: ['mcp'],
          operationId: 'mcp',
          summary: 'Remote MCP server (Streamable HTTP, JSON-RPC 2.0)',
          description: `Model Context Protocol endpoint. Stateless, JSON responses only (no SSE, no Mcp-Session-Id). Supported protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Modern (2026-07-28) requests carry params._meta and the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers; legacy clients use initialize. Tools: ${TOOLS.map((t) => t.name).join(', ')}. Same keys and limits as the JSON API; each tools/call counts as one request. Body max ${MAX_BODY_BYTES} bytes; legacy batches max ${MAX_BATCH} messages with at most one tools/call.`,
          security: sec,
          parameters: [
            { name: 'MCP-Protocol-Version', in: 'header', required: false, schema: { type: 'string', enum: SUPPORTED_VERSIONS } },
            { name: 'Mcp-Method', in: 'header', required: false, description: 'Required for 2026-07-28; must equal the body method', schema: { type: 'string' } },
            { name: 'Mcp-Name', in: 'header', required: false, description: 'Required for 2026-07-28 tools/call; must equal params.name', schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: json({ oneOf: [{ $ref: '#/components/schemas/JsonRpcMessage' }, { type: 'array', maxItems: MAX_BATCH, items: { $ref: '#/components/schemas/JsonRpcMessage' } }] }),
          },
          responses: {
            200: { description: 'JSON-RPC response (or batch of responses). Tool failures, including rate limits and unrepairable input, are results with isError: true.', headers: { ...planHeader, ...retryAfter }, content: json({ type: ['object', 'array'] }) },
            202: { description: 'Notification(s) accepted; no body' },
            400: { description: 'Parse error (-32700), invalid request (-32600), header mismatch (-32020), unsupported protocol version (-32022) or missing _meta (-32602)', content: json({ type: 'object' }) },
            401: { description: 'Invalid API key (JSON-RPC error, data.code = invalid_api_key)', content: json({ type: 'object' }) },
            403: { description: 'Origin header present but not allowed', content: json({ type: 'object' }) },
            404: { description: 'Unknown method in a 2026-07-28 request (-32601)', content: json({ type: 'object' }) },
            413: { description: 'Body larger than the cap', content: json({ type: 'object' }) },
            429: { description: 'Too many non-tool MCP messages from this IP', headers: retryAfter, content: json({ type: 'object' }) },
            500: errResp('Unexpected internal error (`internal_error`); per-message failures are JSON-RPC -32603 inside a 200 response instead'),
            503: { description: 'Deployment missing its HASH_PEPPER secret (`not_configured`)', content: json({ type: 'object' }) },
          },
        },
        get: mcpNotAllowed('get'),
        delete: mcpNotAllowed('delete'),
      },
    },
  };
}
