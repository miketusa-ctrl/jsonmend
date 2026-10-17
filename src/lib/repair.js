/**
 * JsonMend repair engine. Pure compute, no I/O.
 *
 *   1. Extraction: BOM, Markdown code fences, prose before/after the JSON, extra closing brackets, and several
 *      top-level values (NDJSON / concatenated objects → one array).
 *   2. Detection: a single string-aware pass over each extracted value records WHICH syntax problems it has
 *      (trailing commas, single/smart quotes, unquoted keys, comments, Python literals, truncation, …) so the
 *      caller gets a list of fixes. jsonrepair itself does not report what it changed.
 *   3. Repair: jsonrepair v3.15.0 (ISC) for anything JSON.parse rejects; the result is always re-parsed.
 *
 * Already-valid JSON is passed through untouched (fixes: [], changed: false).
 */
import { jsonrepair } from 'jsonrepair';

export const MAX_INPUT_BYTES = 100 * 1024; // 102,400 UTF-8 bytes of input text
export const MAX_DEPTH = 256;              // nesting levels (also protects jsonrepair's recursive parser)
export const FORMATS = ['compact', 'pretty', 'preserve'];

export class RepairError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

export const FIX_MESSAGES = {
  removed_bom: 'Removed a byte-order mark (BOM) at the start',
  stripped_code_fence: 'Removed a Markdown code fence (```json … ```)',
  removed_surrounding_text: 'Removed text outside the code fence',
  removed_leading_text: 'Removed text before the JSON',
  removed_trailing_text: 'Removed text after the JSON',
  extra_closing_brackets: 'Removed extra closing brackets after the JSON',
  wrapped_multiple_values: 'Wrapped several top-level JSON values (NDJSON / concatenated output) in one array',
  comments: 'Removed comments (// … or /* … */)',
  single_quotes: 'Converted single-quoted strings to double quotes',
  smart_quotes: 'Converted curly “smart” quotes to straight double quotes',
  unquoted_keys: 'Quoted unquoted object keys',
  unquoted_strings: 'Quoted bare-word string values',
  trailing_commas: 'Removed trailing commas',
  extra_commas: 'Removed extra (leading or doubled) commas',
  missing_commas: 'Inserted missing commas',
  missing_colons: 'Inserted missing colons between keys and values',
  python_literals: 'Converted Python None/True/False to null/true/false',
  non_json_literals: 'Replaced non-JSON literals (undefined → null; NaN/Infinity → strings)',
  invalid_numbers: 'Fixed non-JSON number syntax (e.g. .5, hex, leading +)',
  control_characters: 'Escaped raw control characters (newlines, tabs) inside strings',
  truncated: 'Input was cut off: closed the unfinished string/brackets (values at the cut may be incomplete)',
  other_syntax_fixes: 'Fixed other syntax errors',
};
export const FIX_CODES = Object.keys(FIX_MESSAGES);

export const WARNING_MESSAGES = {
  number_precision: 'Some integers have more than 15 digits; they lose precision in "json" and in compact/pretty "text". Use format "preserve" to keep the original digits in "text".',
};

const WS = new Set([' ', '\t', '\n', '\r', '\u00a0', '\ufeff']);
const isWs = (c) => WS.has(c);
const OPEN_QUOTES = { '"': ['"'], "'": ["'"], '\u201c': ['\u201d', '\u201c'], '\u2018': ['\u2019', '\u2018'], '\u201d': ['\u201d'], '\u2019': ['\u2019'] };
const DELIMS = new Set([',', ':', '{', '}', '[', ']', '"', "'", '\u201c', '\u201d', '\u2018', '\u2019']);
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function skipWs(text, i) { while (i < text.length && isWs(text[i])) i++; return i; }

/** Is there a plausible JSON object/array starting at text[i]? (So "see [1] below" prose isn't taken for JSON.) */
export function plausibleAt(text, i) {
  const c = text[i];
  const j = skipWs(text, i + 1);
  if (j >= text.length) return true; // truncated right after the bracket
  const n = text[j];
  if (c === '{') {
    if (n === '}' || n in OPEN_QUOTES) return true;
    return /^[A-Za-z_$][\w$-]*\s*:/.test(text.slice(j, j + 80));
  }
  if (c === '[') {
    if ('{[]-0123456789'.includes(n) || n in OPEN_QUOTES) return true;
    return /^(?:true|false|null|None|True|False)\b/.test(text.slice(j, j + 8));
  }
  return false;
}

function findStart(text, from = 0) {
  let first = -1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      if (first < 0) first = i;
      if (plausibleAt(text, i)) return { index: i, plausible: true };
    }
  }
  return first < 0 ? null : { index: first, plausible: false };
}

/**
 * Scan ONE JSON-ish value starting at `start`. Returns { end, truncated, feats, bigNumber }.
 * `end` is exclusive; for a truncated value it is text.length. `complete` = the missing tail of a cut-off
 * true/false/null literal. Throws RepairError(too_deep).
 */
export function scanValue(text, start, maxDepth = MAX_DEPTH) {
  const feats = new Map();
  const add = (k, n = 1) => feats.set(k, (feats.get(k) || 0) + n);
  const stack = []; // frames: { t: '{'|'[', s: 'key'|'colon'|'value'|'after', comma: bool }
  const top = { s: 'value' };
  let bigNumber = false;
  const frame = () => stack[stack.length - 1] || top;
  const len = text.length;

  // A value (or key) token just finished at the current frame.
  const tokenDone = (isKeyish) => {
    const f = frame();
    f.comma = false;
    if (f === top) { top.s = 'done'; return; }
    if (f.t === '{') {
      if (f.s === 'after') { add('missing_commas'); f.s = 'colon'; return; }
      if (f.s === 'key') { if (!isKeyish) add('unquoted_keys'); f.s = 'colon'; return; }
      if (f.s === 'colon') { add('missing_colons'); f.s = 'after'; return; }
      f.s = 'after';
    } else {
      if (f.s === 'after') add('missing_commas');
      f.s = 'after';
    }
  };

  let i = start;
  while (i < len) {
    const c = text[i];
    if (isWs(c)) { i++; continue; }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      add('comments');
      if (text[i + 1] === '/') { while (i < len && text[i] !== '\n') i++; }
      else { const e = text.indexOf('*/', i + 2); i = e < 0 ? len : e + 2; }
      continue;
    }
    if (c in OPEN_QUOTES) {
      if (c === "'") add('single_quotes'); else if (c !== '"') add('smart_quotes');
      const closers = OPEN_QUOTES[c];
      let j = i + 1, ctrl = false, closed = false;
      while (j < len) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (closers.includes(d)) { closed = true; break; }
        if (d < ' ') ctrl = true;
        j++;
      }
      if (ctrl && c === '"') add('control_characters');
      if (!closed) { add('truncated'); return { end: len, truncated: true, feats, bigNumber }; }
      i = j + 1;
      const f = frame();
      tokenDone(true);
      if (f === top) return { end: i, truncated: false, feats, bigNumber };
      continue;
    }
    if (c === '{' || c === '[') {
      const f = frame();
      if (f !== top) {
        f.comma = false;
        if (f.s === 'after') add('missing_commas');
        else if (f.t === '{' && f.s === 'colon') add('missing_colons');
      }
      if (stack.length >= maxDepth) throw new RepairError(422, 'too_deep', `JSON is nested more than ${maxDepth} levels deep`);
      stack.push({ t: c, s: c === '{' ? 'key' : 'value', comma: false });
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      if (!stack.length) return { end: i, truncated: false, feats, bigNumber }; // stray closer: caller treats as trailing text
      const f = stack.pop();
      if (f.comma) add('trailing_commas');
      i++;
      if (!stack.length) return { end: i, truncated: false, feats, bigNumber };
      const p = frame();
      p.comma = false;
      if (p.t === '{' && p.s === 'colon') add('missing_colons');
      p.s = 'after';
      continue;
    }
    if (c === ',') {
      const f = frame();
      if (f === top) return { end: i, truncated: false, feats, bigNumber };
      if (f.s === 'after') { f.s = f.t === '{' ? 'key' : 'value'; f.comma = true; }
      else add('extra_commas');
      i++;
      continue;
    }
    if (c === ':') {
      const f = frame();
      if (f.t === '{' && f.s === 'colon') f.s = 'value';
      i++;
      continue;
    }
    // bare token: number, literal, or unquoted word
    let j = i;
    while (j < len && !isWs(text[j]) && !DELIMS.has(text[j]) && !(text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*'))) j++;
    if (j === i) { i++; continue; } // lone delimiter we don't model (e.g. a stray quote type) — let jsonrepair decide
    const tok = text.slice(i, j);
    const f = frame();
    const keyPos = f.t === '{' && (f.s === 'key' || f.s === 'after');
    let complete = '';
    if (j >= len && f !== top) { // a token that runs into the end of the input (e.g. "tru" → true)
      add('truncated');
      const lit = ['true', 'false', 'null'].find((w) => w.length > tok.length && w.startsWith(tok));
      if (lit && !keyPos) complete = lit.slice(tok.length);
    }
    if (keyPos) {
      tokenDone(false);
      if (f.s === 'colon' && !feats.has('unquoted_keys')) add('unquoted_keys');
    } else {
      if (NUMBER_RE.test(tok)) { if (/^-?\d{16,}/.test(tok)) bigNumber = true; }
      else if (tok === 'true' || tok === 'false' || tok === 'null' || complete) { /* fine (a cut-off literal is reported as truncated) */ }
      else if (tok === 'None' || tok === 'True' || tok === 'False') add('python_literals');
      else if (/^(?:undefined|NaN|[+-]?Infinity)$/.test(tok)) add('non_json_literals');
      else if (/^[+-]?(?:\.?\d)/.test(tok)) add('invalid_numbers');
      else add('unquoted_strings');
      tokenDone(false);
    }
    i = j;
    if (f === top) return { end: i, truncated: false, feats, bigNumber };
    if (complete) return { end: len, truncated: true, feats, bigNumber, complete };
  }
  if (stack.length) {
    if (stack[stack.length - 1].comma) add('trailing_commas');
    if (!feats.has('truncated')) add('truncated');
    return { end: len, truncated: true, feats, bigNumber };
  }
  return { end: len, truncated: false, feats, bigNumber };
}

/** First fenced block (``` or ~~~), preferring one whose content looks like JSON. Unclosed fence = runs to the end. */
function extractFence(text) {
  const re = /(```|~~~)[ \t]*([A-Za-z0-9_+.-]*)[ \t]*\r?\n([\s\S]*?)(?:\r?\n?[ \t]*\1|$)/g;
  let m, pick = null, firstNonEmpty = null;
  while ((m = re.exec(text))) {
    const body = m[3];
    const t = body.trim();
    if (!t) continue;
    const blk = { body, offset: m.index + m[0].indexOf(body, m[1].length), start: m.index, end: m.index + m[0].length };
    if (!firstNonEmpty) firstNonEmpty = blk;
    if (t[0] === '{' || t[0] === '[') { pick = blk; break; }
  }
  // Inline single-line fence: ```{"a":1}```
  if (!pick && !firstNonEmpty) {
    const im = /```\s*(?:json\s+)?(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/i.exec(text);
    if (im) return { body: im[1], offset: im.index + im[0].indexOf(im[1]), start: im.index, end: im.index + im[0].length };
  }
  return pick || firstNonEmpty;
}

const utf8Len = (s) => new TextEncoder().encode(s).length;

function repairSegment(seg, absOffset) {
  try { return { value: JSON.parse(seg), text: seg.trim(), wasValid: true }; } catch { /* repair below */ }
  let out;
  try { out = jsonrepair(seg); } catch (e) {
    if (e instanceof RangeError) throw new RepairError(422, 'too_deep', 'JSON is nested too deeply to repair');
    const pos = Number.isInteger(e && e.position) ? absOffset + e.position : undefined;
    const why = String((e && e.message) || 'unrecognised syntax').replace(/ at position \d+$/, '').slice(0, 160);
    throw new RepairError(422, 'unrepairable', `Could not repair this input: ${why}${pos !== undefined ? ` (at character ${pos})` : ''}.`, pos !== undefined ? { position: pos } : {});
  }
  let value;
  try { value = JSON.parse(out); } catch { throw new RepairError(422, 'unrepairable', 'Could not repair this input into valid JSON.'); }
  return { value, text: out.trim(), wasValid: false };
}

function render(value, preserved, format) {
  try {
    if (format === 'preserve') return preserved;
    return format === 'pretty' ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  } catch (e) {
    if (e instanceof RangeError) throw new RepairError(422, 'too_deep', 'JSON is nested too deeply');
    throw e;
  }
}

/**
 * Repair `input` (string). Returns
 *   { value, text, format, changed, inputWasValid, fixes: [{ code, message, count? }], warnings: [{ code, message }],
 *     values: number of top-level values found, inputBytes, outputBytes }
 * Throws RepairError (400 empty_input / 413 input_too_large / 422 no_json_found | unrepairable | too_deep).
 */
/** True if valid JSON text nests arrays/objects deeper than `max` (string-aware; one pass, no allocation). */
export function textDepthExceeds(text, max) {
  let d = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) { if (c === 92) i++; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 91 || c === 123) { if (++d > max) return true; }
    else if (c === 93 || c === 125) d--;
  }
  return false;
}

/** True if a parsed value nests arrays/objects deeper than `max` (iterative: safe on hostile depth). */
export function valueDepthExceeds(value, max) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (d + 1 > max) return true;
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (x !== null && typeof x === 'object') stack.push([x, d + 1]);
  }
  return false;
}

export function repairJson(input, { format = 'compact', maxBytes = MAX_INPUT_BYTES } = {}) {
  if (typeof input !== 'string') throw new RepairError(400, 'invalid_arguments', '"input" must be a string containing the (broken) JSON text');
  const inputBytes = utf8Len(input);
  if (inputBytes > maxBytes) throw new RepairError(413, 'input_too_large', `input is ${inputBytes.toLocaleString('en-US')} bytes; the limit is ${maxBytes.toLocaleString('en-US')} bytes (UTF-8)`);
  if (!FORMATS.includes(format)) throw new RepairError(400, 'invalid_arguments', `format must be one of: ${FORMATS.join(', ')}`);
  const fixes = new Map();
  const fix = (code, n = 1) => fixes.set(code, (fixes.get(code) || 0) + n);
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); fix('removed_bom'); }
  if (!text.trim()) throw new RepairError(400, 'empty_input', 'input is empty');

  const finish = (value, preserved, extra) => {
    const out = render(value, preserved, format);
    const fixList = [...fixes.entries()].map(([code, count]) => ({ code, message: FIX_MESSAGES[code], ...(count > 1 ? { count } : {}) }));
    const warnings = extra.bigNumber ? [{ code: 'number_precision', message: WARNING_MESSAGES.number_precision }] : [];
    return { value, text: out, format, changed: fixList.length > 0, inputWasValid: extra.inputWasValid, fixes: fixList, warnings, values: extra.values, inputBytes, outputBytes: utf8Len(out) };
  };

  // Fast path: already valid → pass through untouched.
  let parsed, valid = false;
  try { parsed = JSON.parse(text); valid = true; } catch (e) { if (e instanceof RangeError) throw new RepairError(422, 'too_deep', 'JSON is nested too deeply'); }
  if (valid) {
    // Same depth cap as the repair path: JSON.parse alone would accept up to its own stack limit.
    if (textDepthExceeds(text, MAX_DEPTH)) throw new RepairError(422, 'too_deep', `JSON is nested more than ${MAX_DEPTH} levels deep`);
    const big = /(?:^|[^\w."])-?\d{16,}/.test(text) && scanValue(text, skipWs(text, 0)).bigNumber;
    return finish(parsed, text.trim(), { inputWasValid: !fixes.size, values: 1, bigNumber: big });
  }

  // 1. extraction
  let cand = text, base = 0;
  const fence = extractFence(text);
  if (fence) {
    fix('stripped_code_fence');
    if ((text.slice(0, fence.start) + text.slice(fence.end)).trim()) fix('removed_surrounding_text');
    cand = fence.body; base = fence.offset;
  }
  const first = skipWs(cand, 0);
  if (first >= cand.length) throw new RepairError(422, 'no_json_found', 'no JSON found in the input (the code fence is empty)');
  const c0 = cand[first];
  const scalarStart = c0 in OPEN_QUOTES || c0 === '{' || c0 === '['
    || /^(?:-?\d|(?:true|false|null|None|True|False|undefined|NaN|-?Infinity)\s*$)/.test(cand.slice(first, first + 12));
  let start = first;
  if (!scalarStart) {
    const s = findStart(cand, first);
    if (!s) throw new RepairError(422, 'no_json_found', 'no JSON object or array found in the input');
    start = s.index;
    if (cand.slice(0, start).trim()) fix('removed_leading_text');
  }

  // 2. scan one or more top-level values
  const segs = [];
  let pos = start, bigNumber = false;
  for (;;) {
    const r = scanValue(cand, pos);
    segs.push({ s: pos, e: r.end, feats: r.feats, complete: r.complete || '' });
    bigNumber = bigNumber || r.bigNumber;
    if (r.truncated) { pos = cand.length; break; }
    let k = r.end;
    while (k < cand.length && (isWs(cand[k]) || cand[k] === ',')) k++;
    if (k < cand.length && (cand[k] === '{' || cand[k] === '[') && plausibleAt(cand, k) && segs.length < 10000) { pos = k; continue; }
    pos = r.end;
    break;
  }
  const rest = cand.slice(pos).trim();
  if (rest) fix(/^[\]}\s]+$/.test(rest) ? 'extra_closing_brackets' : 'removed_trailing_text');
  if (segs.length > 1) fix('wrapped_multiple_values', segs.length);

  // 3. repair each value
  const results = segs.map((g) => {
    const seg = cand.slice(g.s, g.e) + g.complete; // complete a cut-off literal (tru → true) before jsonrepair
    const r = repairSegment(seg, base + g.s);
    if (!r.wasValid) {
      if (g.feats.size) for (const [k, n] of g.feats) fix(k, n);
      else fix('other_syntax_fixes');
    }
    return r;
  });
  if (segs.length === 1) {
    return finish(results[0].value, results[0].text, { inputWasValid: false, values: 1, bigNumber });
  }
  return finish(results.map((r) => r.value), `[${results.map((r) => r.text).join(',\n')}]`, { inputWasValid: false, values: segs.length, bigNumber });
}
