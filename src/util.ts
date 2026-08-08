// Small pure helpers: crypto (Ed25519 verify, AES-GCM, hashing), IANA-tz
// wall-time conversion via Intl (no offset tables — spec §5.2 forbids
// hand-rolled offsets; ICU is the tz library here), text sanitizing, loop math.

// ------------------------------------------------------------------ bytes

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// -------------------------------------------------- Ed25519 (spec §2.1)
// Native WebCrypto only — a pure-JS verifier would blow the free-plan CPU
// budget on its own. Key import is cached per isolate.

let ed25519Key: CryptoKey | null = null;
let ed25519KeyHex = '';

async function importEd25519(publicKeyHex: string): Promise<CryptoKey> {
  if (ed25519Key && ed25519KeyHex === publicKeyHex) return ed25519Key;
  const raw = hexToBytes(publicKeyHex);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    // Legacy workerd naming, kept as a belt-and-braces fallback.
    key = await crypto.subtle.importKey(
      'raw', raw,
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as SubtleCryptoImportKeyAlgorithm,
      false, ['verify'],
    );
  }
  ed25519Key = key;
  ed25519KeyHex = publicKeyHex;
  return key;
}

export async function verifyDiscordSignature(
  publicKeyHex: string, signatureHex: string, timestamp: string, body: string,
): Promise<boolean> {
  try {
    const key = await importEd25519(publicKeyHex);
    const data = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex), data);
  } catch {
    return false;
  }
}

// ------------------------------------------------- AES-GCM token sealing

async function aesKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64decode(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(keyB64: string, plaintext: string): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${b64encode(iv)}.${b64encode(ct)}`;
}

export async function decryptToken(keyB64: string, sealed: string): Promise<string> {
  const [ivB64, ctB64] = sealed.split('.');
  if (!ivB64 || !ctB64) throw new Error('bad sealed token');
  const key = await aesKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(ivB64) }, key, b64decode(ctB64));
  return new TextDecoder().decode(pt);
}

// --------------------------------------------------------- time & zones

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const tzFmtCache = new Map<string, Intl.DateTimeFormat>();
function tzFmt(tz: string): Intl.DateTimeFormat {
  let f = tzFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    tzFmtCache.set(tz, f);
  }
  return f;
}

function wallParts(tz: string, epochMs: number): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const p of tzFmt(tz).formatToParts(epochMs)) {
    if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  }
  if (parts.hour === 24) parts.hour = 0; // some ICU versions emit 24:00
  return parts;
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(tz: string, epochMs: number): number {
  const p = wallParts(tz, epochMs);
  const wallUtc = Date.UTC(p.year!, (p.month! - 1), p.day!, p.hour!, p.minute!, p.second!);
  return wallUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Parse `YYYY-MM-DD HH:mm` as wall time in an IANA zone → epoch seconds.
 * Fixed-point iteration over the Intl-derived offset (converges in ≤3 steps,
 * DST-gap inputs resolve to one deterministic side). Returns null on bad input.
 */
export function zonedToEpoch(input: string, tz: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*$/.exec(input);
  if (!m || !isValidTz(tz)) return null;
  const [y, mo, d, h, mi] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const wallUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = wallUtc;
  for (let i = 0; i < 3; i++) {
    const next = wallUtc - tzOffsetMs(tz, ts);
    if (next === ts) break;
    ts = next;
  }
  // Round-trip check: reject nonsense like month 13 normalized by Date.UTC.
  const p = wallParts(tz, ts);
  if (p.year !== y || p.month !== mo || p.day !== d) return null;
  return Math.floor(ts / 1000);
}

/** Format an epoch as `YYYY-MM-DD HH:mm` wall time in `tz` (sheet cells, doc template). */
export function epochToZoned(epoch: number, tz: string): string {
  const p = wallParts(isValidTz(tz) ? tz : 'UTC', epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)} ${pad(p.hour!)}:${pad(p.minute!)}`;
}

/** Discord native timestamp markup (decision #16). */
export function ts(epoch: number, style: 'F' | 'R' | 'f' | 'D' = 'F'): string {
  return `<t:${epoch}:${style}>`;
}

// --------------------------------------------------------------- text

/** Sanitize a Discord display name for doc titles / thread names (§8.2). */
export function sanitizeName(name: string, cap = 60): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const out = cleaned.length > cap ? cleaned.slice(0, cap).trimEnd() : cleaned;
  return out || 'participant';
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * v3 built-in signup item: link to the participant's MAL/AniList list.
 * Accepts myanimelist.net / anilist.co (optionally www., scheme optional →
 * normalized to https) with a non-root path, so the Santa lands on an actual
 * profile/list page. Returns the normalized URL or null. Strict on purpose:
 * the URL is later embedded in a link button, where garbage would 400 the
 * whole task-card message.
 */
export function normalizeListUrl(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, '');
  if (!t || t.length > 300) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'myanimelist.net' && host !== 'anilist.co') return null;
  if (url.pathname === '/' || url.pathname === '') return null;
  url.protocol = 'https:';
  return url.toString();
}

export function displayNameOf(member: { nick?: string | null; user: { global_name?: string | null; username: string } }): string {
  return sanitizeName(member.nick ?? member.user.global_name ?? member.user.username);
}

/** Chunk lines into strings each ≤ maxChars and ≤ maxLines lines (gallery §6.4, View Status). */
export function chunkLines(lines: string[], maxChars: number, maxLines: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const line of lines) {
    const joined = cur.length > 0 ? line.length + 1 : line.length;
    if (cur.length > 0 && (cur.length >= maxLines || len + joined > maxChars)) {
      chunks.push(cur.join('\n'));
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += cur.length > 1 ? line.length + 1 : line.length;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

export function shortRef(): string {
  return randomHex(3);
}

/** Parse "7,3,1" → sorted-desc unique ints in [1, 60]; null if anything invalid. */
export function parseReminderDays(input: string): number[] | null {
  const t = input.trim();
  if (t === '') return [];
  const parts = t.split(/[,\s]+/).filter(Boolean);
  const days = new Set<number>();
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const d = parseInt(p, 10);
    if (d < 1 || d > 60) return null;
    days.add(d);
  }
  return [...days].sort((a, b) => b - a);
}

// ----------------------------------------------------------- loop math
// The ordered row list + the Group column ARE the assignment (spec §1):
// santa(i) = the next row within i's group, wrapping at the block boundary.
// Each group is exactly one cycle; with everyone in group 1 this is the
// classic single loop. Works even if same-group rows are non-contiguous
// (treats them as one loop in row order), though adoption always writes
// contiguous blocks.

export interface LoopMap {
  /** santa[i] = index (into the ordered array) of row i's Secret Santa. */
  santa: number[];
  /** recipient[i] = index of the row that received row i's recommendation. */
  recipient: number[];
  /** group_no → member indices in row order (insertion order = block order). */
  groups: Map<number, number[]>;
}

export function buildLoops(groupNos: number[]): LoopMap {
  const groups = new Map<number, number[]>();
  groupNos.forEach((g, i) => {
    const members = groups.get(g);
    if (members) members.push(i);
    else groups.set(g, [i]);
  });
  const santa = new Array<number>(groupNos.length).fill(-1);
  const recipient = new Array<number>(groupNos.length).fill(-1);
  for (const members of groups.values()) {
    members.forEach((rowIdx, k) => {
      santa[rowIdx] = members[(k + 1) % members.length]!;
      recipient[rowIdx] = members[(k - 1 + members.length) % members.length]!;
    });
  }
  return { santa, recipient, groups };
}

/** Group sizes for Grouping (§7.1): n mod G groups of ⌈n/G⌉, rest ⌊n/G⌋ — never differ by more than 1. */
export function dealSizes(n: number, g: number): number[] {
  const big = Math.ceil(n / g);
  const small = Math.floor(n / g);
  const rem = n % g;
  return [...Array<number>(rem).fill(big), ...Array<number>(g - rem).fill(small)];
}

/** "single loop" / "3 loops (4 + 3 + 3)" — validate reports & REVEALED panel. */
export function loopsPhrase(sizes: number[]): string {
  if (sizes.length <= 1) return 'single loop';
  return `${sizes.length} loops (${sizes.join(' + ')})`;
}

/** Fisher–Yates over crypto randomness (spec §7.1). */
export function shuffled<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i >= 1; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Uniform int in [0, maxExclusive) via rejection sampling on 32-bit words. */
function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % maxExclusive;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
