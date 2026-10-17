// Client-IP bucketing for anonymous limits (shared agent-ready recipe §1; same output as workdayapi's
// ipBucket).

/** IPv4 as is; IPv6 → its /64 (one subscriber controls a whole /64); IPv4-mapped IPv6 → the IPv4. */
export function ipBucket(ip) {
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1); // IPv4-mapped ::ffff:a.b.c.d
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}

/**
 *  Coarser IPv6 aggregate (the /48 containing the address), so /64 rotation inside one site can't multiply the
 * anonymous daily quota. null for IPv4 / IPv4-mapped.
 */
export function ipBucket48(ip) {
  const b = ipBucket(ip);
  if (!b.endsWith('::/64')) return null;
  return b.slice(0, -5).split(':').slice(0, 3).join(':') + '::/48';
}
