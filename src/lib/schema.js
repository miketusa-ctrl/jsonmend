/**
 * JSON Schema validation (@cfworker/json-schema, MIT; ajv can't run on Workers because it compiles with
 * new Function) plus optional, conservative type coercion. Pure compute, no I/O: remote $refs are never fetched
 * (an unresolved $ref is an invalid_schema error).
 */
import { Validator, dereference, format as FORMATS } from '@cfworker/json-schema';

export const DRAFTS = ['2020-12', '2019-09', '7', '4'];
export const MAX_SCHEMA_BYTES = 32 * 1024;
export const MAX_ERRORS = 50;
export const MAX_COERCIONS = 100;
/** Shared work budget for one request: every coerce() call and every (value, subschema) pair the validator will
 * visit (counted by a dry run before it runs, see estimateWork) is one step; uniqueItems adds its O(n²) cost.
 * A 100 KB array of 51,000 numbers checked against a plain `items` schema is ~51,000 steps (with a 3-schema allOf
 * per item ~205,000, just over the cap); the bench's 100 KB object array with a 4-property schema ~12,600.
 * Hitting the cap costs ~10-40 ms in node (the dry run and coerce are cheap; the validator never starts), far
 * under the 500 ms cpu_ms cap. */
export const MAX_SCHEMA_STEPS = 200_000;
/** Static cap: how many subschemas may apply in place ($ref/allOf/anyOf/oneOf/not/if/then/else) to ONE value. */
export const MAX_INPLACE = 10_000;
/**
 *  Raw validator errors post-processed per request. Beyond this the result says errorsTruncated:true
 * and errorCount is a lower bound.
 */
export const MAX_RAW_ERRORS = 5_000;

export class SchemaError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Draft from an explicit argument, else from $schema, else 2020-12. */
export function pickDraft(schema, draft) {
  if (draft !== undefined && draft !== null) {
    const d = String(draft);
    if (!DRAFTS.includes(d)) throw new SchemaError(400, 'invalid_arguments', `draft must be one of: ${DRAFTS.join(', ')}`);
    return d;
  }
  const id = schema && typeof schema === 'object' && typeof schema.$schema === 'string' ? schema.$schema : '';
  if (/draft-04/.test(id)) return '4';
  if (/draft-0[67]/.test(id)) return '7';
  if (/2019-09/.test(id)) return '2019-09';
  return '2020-12';
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const allows = (types, v) => { const t = typeOf(v); return types.includes(t) || (t === 'integer' && types.includes('number')); };
const NUM_RE = /^\s*-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\s*$/;

/** JSON-pointer segment decode; null for a malformed %-escape (never throws URIError). */
function decodeSeg(raw) {
  let k;
  try { k = decodeURIComponent(raw); } catch { return null; }
  return k.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveLocal(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return null;
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return null;
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    const k = decodeSeg(raw);
    if (k === null || !cur || typeof cur !== 'object' || !Object.hasOwn(cur, k)) return null;
    cur = cur[k];
  }
  return cur;
}

const ptr = (path) => path.map((p) => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

// complexity limits
class BudgetExceeded extends Error {}
const newBudget = (max = MAX_SCHEMA_STEPS) => ({ steps: 0, max });
function step(budget) { if (++budget.steps > budget.max) throw new BudgetExceeded('schema step budget exceeded'); }
function charge(budget, n) { if (n > 0 && (budget.steps += n) > budget.max) throw new BudgetExceeded('schema step budget exceeded'); }

/**
 *  Per-subschema keyword cost, cached per node. On a mismatch the validator builds the message with
 * JSON.stringify(enum/const), so a big enum/const costs its serialized size on every failing value (memory too);
 * deepCompareStrict walks it as well. `required` can push one error object per name per object value. Calibrated
 * so ordinary schemas cost nothing extra: enum 3,000 ints × 25,000 values was 8 s unbudgeted, const with 2,500 keys
 * × 12,000 values 7.8 s, required 3,000 × 10,000 {} exhausted a 1 GB heap.
 */
function keywordCost(node, cache) {
  let c = cache.kw.get(node);
  if (c) return c;
  const bytes = (x) => { try { return JSON.stringify(x).length; } catch { return 0; } };
  c = { any: 0, obj: 0 };
  if (Array.isArray(node.enum)) c.any += Math.floor(node.enum.length / 32) + Math.floor(bytes(node.enum) / 128);
  if (node.const !== undefined) c.any += Math.floor(bytes(node.const) / 128);
  if (Array.isArray(node.required)) c.obj += node.required.length;
  cache.kw.set(node, c);
  return c;
}
/*
 *  Error cost. With shortCircuit off the validator allocates an error object (plus one wrapper per
 * applicator on the way up) for EVERY failure, ~1.2 µs each in node, before leafErrors() can cap anything:
 * {"items":{"allOf":[{"type":"string"},{"maximum":0}]}} × 50,000 ints built 200,000 errors (230 ms warm) in just
 * 150,000 traversal steps. So the dry run predicts the failures of the cheap leaf keywords and charges ERR_COST steps
 * for each one; data that passes pays nothing extra, and a budget-sized request stays ≲ 50k raw errors. `pattern` and
 * `format` are evaluated as the validator would (so a catastrophic regex runs twice; it is bounded by cpu_ms either
 * way); enum/const on object values are too costly to predict and are charged as failing; under `not` a predicted
 * failure costs 1 step.
 */
export const ERR_COST = 4;
const missing = (obj, names) => { let n = 0; for (const k of names) if (typeof k === 'string' && !Object.hasOwn(obj, k)) n++; return n; };
function typeOk(t, v) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return isObj(v);
    default: return true;
  }
}
function predictErrors(v, n, cache) {
  let e = 0;
  if (typeof n.type === 'string') { if (!typeOk(n.type, v)) e++; }
  else if (Array.isArray(n.type) && n.type.length && !n.type.some((t) => typeOk(t, v))) e++;
  if (Array.isArray(n.enum)) { if (v !== null && typeof v === 'object') e++; else if (!n.enum.includes(v)) e++; }
  if (n.const !== undefined) { if ((v !== null && typeof v === 'object') || n.const !== v) e++; }
  if (typeof v === 'number') {
    if (typeof n.maximum === 'number' && v > n.maximum) e++;
    if (typeof n.minimum === 'number' && v < n.minimum) e++;
    if (n.exclusiveMaximum !== undefined && !(typeof n.exclusiveMaximum === 'number' && v < n.exclusiveMaximum)) e++;
    if (n.exclusiveMinimum !== undefined && !(typeof n.exclusiveMinimum === 'number' && v > n.exclusiveMinimum)) e++;
    if (typeof n.multipleOf === 'number' && n.multipleOf > 0 && !Number.isInteger(v / n.multipleOf)) e++;
  } else if (typeof v === 'string') {
    if (typeof n.maxLength === 'number' && v.length > n.maxLength) e++;
    if (typeof n.minLength === 'number' && v.length < n.minLength * 2) e++; // conservative: code points ≥ length/2
    if (n.pattern !== undefined) { // evaluated exactly as the validator does (new RegExp(p, 'u')); compiled once per request
      let re = cache.re.get(n.pattern);
      if (re === undefined) { try { re = new RegExp(n.pattern, 'u'); } catch { re = null; } cache.re.set(n.pattern, re); }
      if (!re || !re.test(v)) e++;
    }
    if (n.format !== undefined && FORMATS[n.format] && !FORMATS[n.format](v)) e++;
  } else if (Array.isArray(v)) {
    if (typeof n.maxItems === 'number' && v.length > n.maxItems) e++;
    if (typeof n.minItems === 'number' && v.length < n.minItems) e++;
  } else if (isObj(v)) {
    if (typeof n.maxProperties === 'number' || typeof n.minProperties === 'number') e++;
    if (Array.isArray(n.required)) e += missing(v, n.required);
  }
  return e;
}
const tooComplex = (why) => new SchemaError(422, 'schema_too_complex', `schema is too complex: ${why}`);

// Where subschemas live (mirrors @cfworker/json-schema's dereference/validate keyword sets).
const IN_PLACE_ONE = ['not', 'if', 'then', 'else'];
const IN_PLACE_ARR = ['allOf', 'anyOf', 'oneOf'];
const IN_PLACE_MAP = ['dependentSchemas', 'dependencies'];
const DESC_ONE = ['additionalItems', 'unevaluatedItems', 'items', 'contains', 'additionalProperties', 'unevaluatedProperties', 'propertyNames'];
const DESC_ARR = ['prefixItems', 'items'];
const DESC_MAP = ['properties', 'patternProperties'];
const NOT_SCHEMA = new Set(['id', '$id', '$ref', '$schema', '$anchor', '$vocabulary', '$comment', 'default', 'enum', 'const', 'examples', 'required', 'type', 'maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum', 'multipleOf', 'maxLength', 'minLength', 'pattern', 'format', 'maxItems', 'minItems', 'uniqueItems', 'maxProperties', 'minProperties', 'dependentRequired', '$recursiveRef', '$recursiveAnchor', 'title', 'description']);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Subschemas applied to the SAME instance value (refs resolved through the validator's own lookup). */
function inPlaceChildren(n, lookup) {
  const out = [];
  if (typeof n.$ref === 'string' && n.__absolute_ref__ && lookup[n.__absolute_ref__] !== undefined) out.push(lookup[n.__absolute_ref__]);
  if (typeof n.$recursiveRef === 'string' && n.__absolute_recursive_ref__ && lookup[n.__absolute_recursive_ref__] !== undefined) out.push(lookup[n.__absolute_recursive_ref__]);
  for (const k of IN_PLACE_ONE) if (isObj(n[k])) out.push(n[k]);
  for (const k of IN_PLACE_ARR) if (Array.isArray(n[k])) for (const x of n[k]) if (isObj(x)) out.push(x);
  for (const k of IN_PLACE_MAP) if (isObj(n[k])) for (const x of Object.values(n[k])) if (isObj(x)) out.push(x);
  return out;
}
/** Subschemas applied to child values (object members / array items). */
function descendChildren(n) {
  const out = [];
  for (const k of DESC_ONE) if (isObj(n[k])) out.push(n[k]);
  for (const k of DESC_ARR) if (Array.isArray(n[k])) for (const x of n[k]) if (isObj(x)) out.push(x);
  for (const k of DESC_MAP) if (isObj(n[k])) for (const x of Object.values(n[k])) if (isObj(x)) out.push(x);
  return out;
}

function shapeAndSize(schema) {
  if (schema === null || (typeof schema !== 'object' && typeof schema !== 'boolean') || Array.isArray(schema)) {
    throw new SchemaError(400, 'invalid_schema', 'schema must be a JSON Schema object (or true/false)');
  }
  let bytes;
  try { bytes = new TextEncoder().encode(JSON.stringify(schema)).length; } catch { throw new SchemaError(400, 'invalid_schema', 'schema could not be serialized'); }
  if (bytes > MAX_SCHEMA_BYTES) throw new SchemaError(413, 'schema_too_large', `schema is ${bytes.toLocaleString('en-US')} bytes; the limit is ${MAX_SCHEMA_BYTES.toLocaleString('en-US')} bytes`);
}

/**
 * Static pre-check, cheap (schema ≤ 32 KB) and data-independent, so the router runs it BEFORE any quota is used:
 * size cap, then — over every subschema reachable from the root — reject (422 schema_too_complex) a loop of in-place
 * applicators that never descends into the data (e.g. {"allOf":[{"$ref":"#"},{"$ref":"#"}]}: infinite for ANY value)
 * and more than MAX_INPLACE subschemas applying to one value (non-looping exponential $ref/allOf trees).
 * Returns the dereferenced clone + lookup so validateValue doesn't redo the work.
 */
export function checkSchema(schema) {
  shapeAndSize(schema);
  if (typeof schema === 'boolean') return { clone: schema, lookup: null };
  const clone = structuredClone(schema);
  let lookup;
  try { lookup = dereference(clone); } catch (e) {
    throw new SchemaError(400, 'invalid_schema', `schema could not be used: ${clip(String((e && e.message) || 'error').split('\n')[0], 200)}`);
  }
  const reach = new Set();
  const todo = [clone];
  while (todo.length) {
    const n = todo.pop();
    if (!isObj(n) || reach.has(n)) continue;
    reach.add(n);
    for (const c of inPlaceChildren(n, lookup)) todo.push(c);
    for (const c of descendChildren(n)) todo.push(c);
  }
  const memo = new Map(), onStack = new Set();
  const cost = (n) => {
    const m = memo.get(n); if (m !== undefined) return m;
    if (onStack.has(n)) throw tooComplex('it loops back to itself through $ref/allOf/anyOf/oneOf/not/if without descending into the data, so no value could ever be checked');
    onStack.add(n);
    let c = 1;
    for (const ch of inPlaceChildren(n, lookup)) { c += cost(ch); if (c > MAX_INPLACE) break; }
    onStack.delete(n);
    memo.set(n, c = Math.min(c, MAX_INPLACE + 1));
    return c;
  };
  try {
    for (const n of reach) if (cost(n) > MAX_INPLACE) throw tooComplex(`more than ${MAX_INPLACE.toLocaleString('en-US')} subschemas would apply to a single value (nested $ref/allOf/anyOf/oneOf expansion)`);
  } catch (e) {
    if (e instanceof RangeError) throw tooComplex('subschemas are nested too deeply');
    throw e;
  }
  return { clone, lookup };
}

/**
 * Dry run of the validator's traversal: walks (value, subschema) pairs the way @cfworker/json-schema will — $ref /
 * $recursiveRef through its own lookup, allOf/anyOf/oneOf/not/if/then/else, dependentSchemas/dependencies,
 * properties/patternProperties/additionalProperties/unevaluatedProperties/propertyNames, prefixItems/items/
 * additionalItems/unevaluatedItems/contains — ticking the shared budget once per pair, WITHOUT checking any keyword. It
 * over-approximates (e.g. both then and else, and $ref siblings in drafts 4/7), never under-counts, so running the real
 * validator afterwards is bounded too. `uniqueItems` is O(n²) in the validator, so an array it applies to costs n²/1000
 * steps (primitives) or n²/20 (objects/arrays), calibrated in node: 51,000 numbers ≈ 3.4 s, 4,000 small objects ≈ 0.8
 * s.
 */
function estimateWork(value, node, lookup, budget, reCache, neg = false) {
  step(budget);
  const errCost = neg ? 1 : ERR_COST; // inside `not`, a predicted failure is the expected outcome and is discarded
  if (node === false) { charge(budget, errCost); return; }
  if (!isObj(node)) return;
  const kc = keywordCost(node, reCache);
  // `not` is no longer charged as a predicted failure (that gave false 422s on large valid inputs such as
  // {"items":{"not":{"type":"null"}}} × 50,000 ints). Its subschema is walked as before (1 step per pair), and
  // predicted failures inside it cost 1 step each (neg; toggled again by a nested `not`), since failing there is the
  // passing case.
  charge(budget, kc.any + predictErrors(value, node, reCache) * errCost);
  if (isObj(value)) {
    charge(budget, kc.obj);
    for (const k of ['dependentRequired', 'dependencies']) {
      if (!isObj(node[k])) continue;
      for (const [dk, names] of Object.entries(node[k])) if (Array.isArray(names) && Object.hasOwn(value, dk)) charge(budget, names.length + missing(value, names) * errCost);
    }
  }
  if (typeof node.$ref === 'string' && node.__absolute_ref__ && lookup[node.__absolute_ref__] !== undefined) estimateWork(value, lookup[node.__absolute_ref__], lookup, budget, reCache, neg);
  if (typeof node.$recursiveRef === 'string' && node.__absolute_recursive_ref__ && lookup[node.__absolute_recursive_ref__] !== undefined) estimateWork(value, lookup[node.__absolute_recursive_ref__], lookup, budget, reCache, neg);
  for (const k of IN_PLACE_ONE) if (node[k] !== undefined) estimateWork(value, node[k], lookup, budget, reCache, k === 'not' ? !neg : neg);
  for (const k of IN_PLACE_ARR) if (Array.isArray(node[k])) for (const x of node[k]) estimateWork(value, x, lookup, budget, reCache, neg);
  const isO = isObj(value), isA = Array.isArray(value);
  if (isO) {
    for (const k of IN_PLACE_MAP) if (isObj(node[k])) for (const [dk, x] of Object.entries(node[k])) if (Object.hasOwn(value, dk) && (isObj(x) || typeof x === 'boolean')) estimateWork(value, x, lookup, budget, reCache, neg);
    const props = isObj(node.properties) ? node.properties : null;
    let pats = null;
    if (isObj(node.patternProperties)) {
      pats = reCache.get(node);
      if (!pats) {
        pats = Object.entries(node.patternProperties).map(([re, x]) => { try { return [new RegExp(re, 'u'), x]; } catch { return [null, x]; } });
        reCache.set(node, pats);
      }
    }
    const extra = node.additionalProperties !== undefined ? node.additionalProperties : node.unevaluatedProperties;
    for (const key of Object.keys(value)) {
      let matched = false;
      if (props && Object.hasOwn(props, key)) { matched = true; estimateWork(value[key], props[key], lookup, budget, reCache, neg); }
      if (pats) for (const [re, x] of pats) if (!re || re.test(key)) { matched = true; estimateWork(value[key], x, lookup, budget, reCache, neg); }
      if (!matched && extra !== undefined) estimateWork(value[key], extra, lookup, budget, reCache, neg);
      if (node.propertyNames !== undefined) estimateWork(key, node.propertyNames, lookup, budget, reCache, neg);
    }
  } else if (isA) {
    const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : [];
    const rest = Array.isArray(node.items) ? (node.additionalItems !== undefined ? node.additionalItems : node.unevaluatedItems)
      : (node.items !== undefined ? node.items : node.unevaluatedItems);
    for (let i = 0; i < value.length; i++) {
      const sub = i < prefix.length ? prefix[i] : rest;
      if (sub !== undefined) estimateWork(value[i], sub, lookup, budget, reCache, neg);
      if (node.contains !== undefined) estimateWork(value[i], node.contains, lookup, budget, reCache, neg);
    }
    if (node.uniqueItems === true && value.length > 1) {
      const n = value.length;
      const heavy = value.some((x) => x !== null && typeof x === 'object');
      charge(budget, Math.ceil((n * n) / (heavy ? 20 : 1000)));
    }
  }
}

/**
 * Coerce primitives toward the schema's declared `type` (like ajv coerceTypes: "array"):
 *   "42" → 42 (number/integer), "true"/"false" → boolean, "null" → null, number/boolean → string, x → [x] (array).
 * Follows properties, patternProperties, additionalProperties, items / prefixItems, allOf and local $refs.
 * Does NOT branch into anyOf / oneOf / if-then-else. Returns a new value; records each change in `log`.
 */
export function coerce(value, schema, root = schema, path = [], log = [], depth = 0, budget = newBudget()) {
  if (!schema || typeof schema !== 'object' || depth > 64) return value;
  step(budget);
  if (schema.$ref) {
    const target = resolveLocal(root, schema.$ref);
    if (target) value = coerce(value, target, root, path, log, depth + 1, budget);
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) value = coerce(value, s, root, path, log, depth + 1, budget);
  const types = schema.type === undefined ? null : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types && !allows(types, value)) {
    let out, done = false;
    for (const t of types) {
      if ((t === 'number' || t === 'integer') && typeof value === 'string' && NUM_RE.test(value)) {
        const n = Number(value); if (Number.isFinite(n) && (t === 'number' || Number.isInteger(n))) { out = n; done = true; }
      } else if ((t === 'number' || t === 'integer') && typeof value === 'boolean') { out = value ? 1 : 0; done = true; }
      else if (t === 'boolean' && typeof value === 'string' && /^(true|false)$/i.test(value.trim())) { out = value.trim().toLowerCase() === 'true'; done = true; }
      else if (t === 'boolean' && (value === 0 || value === 1)) { out = value === 1; done = true; }
      else if (t === 'null' && (value === 'null' || value === '')) { out = null; done = true; }
      else if (t === 'string' && (typeof value === 'number' || typeof value === 'boolean')) { out = String(value); done = true; }
      else if (t === 'array' && value !== null && value !== undefined && !Array.isArray(value)) { out = [value]; done = true; }
      if (done) break;
    }
    if (done) {
      if (log.length < MAX_COERCIONS) log.push({ path: ptr(path), from: typeOf(value) === 'integer' ? 'number' : typeOf(value), to: typeOf(out) === 'integer' ? (types.includes('integer') ? 'integer' : 'number') : typeOf(out) });
      else log.truncated = true;
      value = out;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const pats = schema.patternProperties && typeof schema.patternProperties === 'object' ? Object.entries(schema.patternProperties) : [];
    let copy = null;
    for (const k of Object.keys(value)) {
      let sub = Object.hasOwn(props, k) ? props[k] : null;
      if (!sub) for (const [re, s] of pats) { try { if (new RegExp(re, 'u').test(k)) { sub = s; break; } } catch { /* bad pattern: validator reports it */ } }
      if (!sub && schema.additionalProperties && typeof schema.additionalProperties === 'object') sub = schema.additionalProperties;
      if (!sub) continue;
      const nv = coerce(value[k], sub, root, [...path, k], log, depth + 1, budget);
      if (nv !== value[k]) { copy = copy || { ...value }; copy[k] = nv; }
    }
    if (copy) value = copy;
  } else if (Array.isArray(value)) {
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : [];
    const rest = schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items) ? schema.items
      : (Array.isArray(schema.items) && schema.additionalItems && typeof schema.additionalItems === 'object' ? schema.additionalItems : null);
    let copy = null;
    value.forEach((item, i) => {
      const sub = i < prefix.length ? prefix[i] : rest;
      if (!sub) return;
      const nv = coerce(item, sub, root, [...path, i], log, depth + 1, budget);
      if (nv !== item) { copy = copy || value.slice(); copy[i] = nv; }
    });
    if (copy) value = copy;
  }
  return value;
}

/** Walk an error's keywordLocation (e.g. "#/properties/d/$ref/additionalProperties") through local $refs. */
function schemaAt(root, loc) {
  let cur = root;
  for (const raw of String(loc).replace(/^#\/?/, '').split('/').filter(Boolean)) {
    const k = decodeSeg(raw);
    if (k === null) return null;
    if (k === '$ref' && cur && typeof cur.$ref === 'string') { cur = resolveLocal(root, cur.$ref); continue; }
    if (!cur || typeof cur !== 'object' || !Object.hasOwn(cur, k)) return null;
    cur = cur[k];
  }
  return cur;
}

/** @cfworker/json-schema also reports a DECLARED property that failed its own subschema as an "additional" property.
 * Drop those (the real error is reported at the property itself). */
function isSpuriousAdditional(e, root) {
  if (e.keyword !== 'additionalProperties' || !root || typeof root !== 'object') return false;
  const m = /^Property "(.*)" does not match additional properties schema\.$/.exec(String(e.error));
  if (!m) return false;
  const parent = schemaAt(root, String(e.keywordLocation).replace(/\/additionalProperties$/, ''));
  if (!parent || typeof parent !== 'object') return false;
  if (parent.properties && typeof parent.properties === 'object' && Object.hasOwn(parent.properties, m[1])) return true;
  for (const re of Object.keys(parent.patternProperties || {})) { try { if (new RegExp(re, 'u').test(m[1])) return true; } catch { /* ignore */ } }
  return false;
}

const seg = (raw) => { const k = decodeSeg(raw); return k === null ? raw : k; };
// keyword → [instance levels it descends, schema segments it consumes after itself]
const DESCEND = { properties: [1, 1], patternProperties: [1, 1], additionalProperties: [1, 0], unevaluatedProperties: [1, 0], prefixItems: [1, 1], additionalItems: [1, 0], unevaluatedItems: [1, 0], contains: [1, 0], $defs: [0, 1], definitions: [0, 1], dependentSchemas: [0, 1], allOf: [0, 1], anyOf: [0, 1], oneOf: [0, 1] };

/** Same quirk, for errors raised INSIDE the additionalProperties subschema (e.g. "#/additionalProperties/type" at
 * "/declaredProp"): drop them when the instance property is declared in the sibling "properties". */
function isInsideSpuriousAdditional(e, root) {
  const ks = String(e.keywordLocation).replace(/^#\/?/, '').split('/').filter(Boolean).map(seg);
  const is = String(e.instanceLocation).replace(/^#\/?/, '').split('/').filter(Boolean).map(seg);
  let depth = 0;
  for (let k = 0; k < ks.length; k++) {
    const kw = ks[k];
    if (kw === 'additionalProperties' && k < ks.length - 1) {
      const name = is[depth];
      const parent = schemaAt(root, '#/' + ks.slice(0, k).map((x) => x.replace(/~/g, '~0').replace(/\//g, '~1')).join('/'));
      if (name !== undefined && parent && typeof parent === 'object' && parent.properties && typeof parent.properties === 'object' && Object.hasOwn(parent.properties, name)) return true;
    }
    if (kw === 'items') { const next = ks[k + 1]; depth += 1; if (next !== undefined && /^\d+$/.test(next)) k++; continue; }
    const d = DESCEND[kw];
    if (d) { depth += d[0]; k += d[1]; }
  }
  return false;
}

/**
 *  Drop wrapper errors ("Property x does not match schema") when a more specific error below them exists.
 * Returns { errors, truncated }. The validator emits a wrapper before the errors under it, so a cut can at worst
 * keep a wrapper whose children fell past the cap.
 */
export function leafErrors(raw, root) {
  const truncated = raw.length > MAX_RAW_ERRORS;
  const memo = new Map();
  const spurious = (e) => {
    const k = `${e.keyword}\u0000${e.keywordLocation}\u0000${e.instanceLocation}\u0000${e.keyword === 'additionalProperties' ? e.error : ''}`;
    let v = memo.get(k);
    if (v === undefined) memo.set(k, v = isSpuriousAdditional(e, root) || isInsideSpuriousAdditional(e, root));
    return v;
  };
  const errors = (truncated ? raw.slice(0, MAX_RAW_ERRORS) : raw).filter((e) => !spurious(e));
  const anc = new Set();
  for (const e of errors) {
    const l = String(e.keywordLocation);
    for (let k = l.lastIndexOf('/'); k > 0; k = l.lastIndexOf('/', k - 1)) {
      const p = l.slice(0, k);
      if (anc.has(p)) break; // its own ancestors are already in
      anc.add(p);
    }
  }
  const out = errors.filter((e) => !(e.keyword === 'false' && errors.length > 1) && !anc.has(String(e.keywordLocation)));
  return { errors: out, truncated };
}

/**
 * Validate `value` against `schema`. Returns { valid, errorCount, errorsTruncated, errors: [{ path, keyword, schemaPath, message }],
 * draft, coerced: bool, coercions: [{ path, from, to }], value }. Throws SchemaError for an unusable schema.
 */
export function validateValue(value, schema, { draft, coerce: doCoerce = false, maxSteps = MAX_SCHEMA_STEPS } = {}) {
  const { clone, lookup } = checkSchema(schema);
  const d = pickDraft(schema, draft);
  const log = [];
  const budget = newBudget(maxSteps);
  const tooMuch = () => tooComplex(`checking this data against it would take more than ${budget.max.toLocaleString('en-US')} schema steps (each value × each subschema that applies to it)`);
  let v = value;
  try {
    if (doCoerce && typeof schema === 'object') v = coerce(value, schema, schema, [], log, 0, budget);
  } catch (e) {
    if (e instanceof BudgetExceeded) throw tooMuch();
    if (e instanceof RangeError) throw new SchemaError(422, 'too_deep', 'JSON is nested too deeply to validate');
    throw e;
  }
  let res;
  try {
    if (typeof clone === 'object') estimateWork(v, clone, lookup, budget, Object.assign(new Map(), { kw: new Map(), re: new Map() }));
    res = new Validator(clone, d, false).validate(v);
  } catch (e) {
    if (e instanceof SchemaError) throw e;
    if (e instanceof BudgetExceeded) throw tooMuch();
    if (e instanceof RangeError) throw new SchemaError(422, 'too_deep', 'JSON or schema is nested too deeply to validate');
    throw new SchemaError(400, 'invalid_schema', `schema could not be used: ${clip(String((e && e.message) || 'error').split('\n')[0], 200)}`);
  }
  const { errors: all, truncated } = res.valid ? { errors: [], truncated: false } : leafErrors(res.errors, schema);
  const errors = all.slice(0, MAX_ERRORS).map((e) => ({
    path: e.instanceLocation === '#' ? '' : String(e.instanceLocation).replace(/^#/, ''),
    keyword: String(e.keyword),
    schemaPath: String(e.keywordLocation),
    message: clip(String(e.error), 300),
  }));
  return { valid: res.valid, errorCount: all.length, errorsTruncated: truncated, errors, draft: d, coerced: log.length > 0, coercions: log, value: v, steps: budget.steps };
}
