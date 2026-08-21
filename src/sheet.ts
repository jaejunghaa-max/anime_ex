// Sheet layout + rewrite/read helpers (v3). The sheet's row order and its
// manager-editable Group column ARE the assignment (rows = loop order, Group =
// loop membership) while MATCHING lasts; the derived Secret Santa column and
// the Recommendation/Rec. Status block are always written by the bot and never
// read back as input. Once recommendations start, the assignment is frozen —
// the sheet becomes a dashboard.

import type { Env, EventRow, FormItem, GuildRow, RecoRow, SignupRow } from './types';
import {
  SHEET_TAB, addHeaderNotes, valuesBatchUpdate, valuesClear, valuesGet, valuesUpdate,
} from './google';
import { answersOf, getItems, loadRecos, orderedSignups, recosOf, type RecoMap } from './db';
import { buildLoops, type LoopMap } from './util';

/**
 * A1 range on the data tab. The tab title contains a hyphen, which Google's
 * A1 parser only accepts when the title is single-quoted — unquoted,
 * `Sign-Ups!A1:T21` 400s with "Unable to parse range", which silently
 * starved every sheet write while the spreadsheet itself created fine.
 */
export function a1(range: string): string {
  return `'${SHEET_TAB}'!${range}`;
}

/** 1-indexed column number → A1 letter(s). */
export function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Fixed columns before the custom items block.
const FIXED = 4; // A Row#, B User ID, C Username, D MAL/AniList

export interface Layout {
  itemCount: number;
  maxRecos: number;
  groupCol: number;
  santaCol: number;
  /** First column of slot 1's triple (Recommendation / Rec. Status / Score). */
  recoCol: number;
  linkCol: number;
  lengthCol: number;
  lastCol: number;
}

/** Columns per recommendation slot: Recommendation, Rec. Status, Score. */
const PER_RECO = 3;

export function layoutOf(items: FormItem[], maxRecos = 1): Layout {
  const k = items.length;
  const n = Math.max(1, maxRecos);
  const recoCol = FIXED + k + 3;
  return {
    itemCount: k,
    maxRecos: n,
    groupCol: FIXED + k + 1,      // manager-editable loop membership
    santaCol: FIXED + k + 2,      // derived: next row within the group
    recoCol,                      // slot 1 starts here; slot j at recoCol + (j-1)*3
    linkCol: recoCol + n * PER_RECO,
    lengthCol: recoCol + n * PER_RECO + 1, // "Review Length" — chars minus template
    lastCol: recoCol + n * PER_RECO + 1,
  };
}

/** 1-indexed first column of slot `slot` (1-based). */
export const slotCol = (layout: Layout, slot: number): number =>
  layout.recoCol + (Math.max(1, slot) - 1) * PER_RECO;

export function headerRow(items: FormItem[], maxRecos = 1): string[] {
  const n = Math.max(1, maxRecos);
  const recoHeaders: string[] = [];
  for (let j = 1; j <= n; j++) {
    // A single-pick event keeps the unnumbered v3 headers.
    const sfx = n > 1 ? ` ${j}` : '';
    recoHeaders.push(`Recommendation${sfx}`, `Rec. Status${sfx}`, `Score${sfx}`);
  }
  return [
    'Row #', 'User ID 🔑', 'Username', 'MAL/AniList',
    ...items.map((it) => (it.visible_to_recommender ? it.label : `${it.label} 🔒`)),
    'Group', 'Secret Santa', ...recoHeaders, 'Review Link', 'Review Length',
  ];
}

/** Recommendation cell: the anime picked for this slot. */
export function recoCell(r: Pick<RecoRow, 'title' | 'year'> | undefined): string {
  if (!r?.title) return '';
  return r.year ? `${r.title} (${r.year})` : r.title;
}

/** Rec. Status cell — mirrors the approve/decline state machine. */
export function recoStatusCell(
  r: Pick<RecoRow, 'status' | 'final_via'> | undefined,
  declinesUsed = 0,
): string {
  switch (r?.status) {
    case 'PENDING':
      return '⏳ awaiting reply';
    case 'FINAL':
      return r.final_via === 'FORCED' ? '⏩ locked at launch' : '✅ accepted';
    default:
      return declinesUsed > 0 ? `😞 declined ×${declinesUsed}` : '';
  }
}

/** Review Length cell: chars written beyond the template; flags deleted docs. */
export function lengthCell(s: Pick<SignupRow, 'doc_id' | 'doc_missing' | 'char_count'>): string | number {
  if (s.doc_missing) return '⚠ missing';
  return s.doc_id ? s.char_count : '';
}

export function scoreCell(r: Pick<RecoRow, 'score'> | undefined): string | number {
  return r?.score ?? '';
}

function dataRow(
  s: SignupRow, idx: number, santa: SignupRow | undefined, items: FormItem[],
  recos: RecoRow[], maxRecos: number,
): unknown[] {
  const answers = answersOf(s);
  const bySlot = new Map(recos.map((r) => [r.slot, r]));
  const recoCells: unknown[] = [];
  for (let j = 1; j <= Math.max(1, maxRecos); j++) {
    const r = bySlot.get(j);
    recoCells.push(recoCell(r), recoStatusCell(r, s.declines_used), scoreCell(r));
  }
  return [
    idx + 1,
    s.user_id, // RAW valueInputOption keeps the 18-digit id a string (precision!)
    s.display_name,
    s.list_url,
    ...items.map((it) => answers[String(it.item_id)] ?? ''),
    s.group_no,
    santa ? santa.display_name : '',
    ...recoCells,
    s.doc_url ?? '',
    lengthCell(s),
  ];
}

/**
 * Clear + rewrite the header and data block from D1 (idempotent, used by
 * signup upsert/withdraw, Shuffle, Grouping, Validate, restore, and the
 * job-completion self-heal). Including the header row makes layout changes
 * self-heal on sheets created by older deployments; the clear range sweeps a
 * few extra columns for the same reason. Derived columns fill per group once
 * the loop order has been adopted (row_order non-NULL).
 */
export async function rewriteSheet(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[], ordered: SignupRow[],
  recos: RecoMap = new Map(),
): Promise<void> {
  if (!event.sheet_id) return;
  const layout = layoutOf(items, event.max_recos);
  const derived = ordered.length >= 2 && ordered.every((s) => s.row_order !== null);
  const loops: LoopMap | null = derived ? buildLoops(ordered.map((s) => s.group_no)) : null;
  const end = colLetter(layout.lastCol);
  await valuesClear(env, guild, event.sheet_id, a1(`A2:${colLetter(layout.lastCol + 3)}1000`));
  const values = [
    headerRow(items, event.max_recos),
    ...ordered.map((s, i) => dataRow(
      s, i, loops ? ordered[loops.santa[i]!] : undefined, items,
      recosOf(recos, s.signup_id), event.max_recos,
    )),
  ];
  await valuesUpdate(env, guild, event.sheet_id, a1(`A1:${end}${ordered.length + 1}`), values);
}

/** Full rewrite straight from D1 — the common "reconcile the sheet" call. */
export async function rewriteSheetFromDb(
  env: Env, guild: GuildRow, event: EventRow,
): Promise<void> {
  if (!event.sheet_id) return;
  const [items, ordered, recos] = await Promise.all([
    getItems(env, event.event_id),
    orderedSignups(env, event.event_id),
    loadRecos(env, event.event_id),
  ]);
  await rewriteSheet(env, guild, event, items, ordered, recos);
}

export async function writeHeader(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<void> {
  if (!event.sheet_id) return;
  const header = headerRow(items, event.max_recos);
  await valuesUpdate(env, guild, event.sheet_id, a1(`A1:${colLetter(header.length)}1`), [header]);
  if (event.sheet_gid !== null) {
    const layout = layoutOf(items, event.max_recos);
    await addHeaderNotes(env, guild, event.sheet_id, event.sheet_gid, [
      { colIndex: 1, note: 'Immutable key — do not edit this column.' },
      {
        colIndex: layout.groupCol - 1,
        note: 'Loop membership — positive integer, blank = 1. Edit to move someone between loops; rows re-sort into contiguous group blocks on Validate. Locked once recommendations start.',
      },
      {
        colIndex: layout.santaCol - 1,
        note: 'Auto-derived: the next row within the group recommends for this row. Reorder rows / edit Group to change assignments (until recommendations start); this block is overwritten by the bot.',
      },
      {
        colIndex: layout.recoCol - 1,
        note: 'Written by the bot during the recommending phase — the anime this row\'s Secret Santa picked for them (one block per recommendation slot). Never read as input.',
      },
    ]).catch(() => { /* cosmetic */ });
  }
}

/** Read the data block for Validate: array of rows, col B = user id key. */
export async function readSheetRows(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<string[][]> {
  if (!event.sheet_id) return [];
  const layout = layoutOf(items, event.max_recos);
  return valuesGet(env, guild, event.sheet_id, a1(`A2:${colLetter(layout.lastCol)}1000`));
}

/** Batched per-tick cell writes: Review Link during Launch. */
export function writeReviewLinks(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rows: Array<{ rowIndex: number; url: string }>,
): Promise<unknown> {
  if (!event.sheet_id || rows.length === 0) return Promise.resolve();
  const col = colLetter(layoutOf(items, event.max_recos).linkCol);
  return valuesBatchUpdate(env, guild, event.sheet_id, rows.map((r) => ({
    range: a1(`${col}${r.rowIndex + 2}`),
    values: [[r.url]],
  })));
}

/** Batched per-tick cell writes: Review Length during sync. */
export function writeStatusCells(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rows: Array<{ rowIndex: number; length: number | string }>,
): Promise<unknown> {
  if (!event.sheet_id || rows.length === 0) return Promise.resolve();
  const col = colLetter(layoutOf(items, event.max_recos).lengthCol);
  return valuesBatchUpdate(env, guild, event.sheet_id, rows.map((r) => ({
    range: a1(`${col}${r.rowIndex + 2}`),
    values: [[r.length]],
  })));
}

/** One slot's Recommendation / Rec. Status / Score triple — written on every
 *  send / approve / decline / score so the manager's sheet mirrors it live. */
export function writeRecoCells(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  row: SignupRow, reco: RecoRow,
): Promise<unknown> {
  if (!event.sheet_id || row.row_order === null) return Promise.resolve();
  const layout = layoutOf(items, event.max_recos);
  const from = slotCol(layout, reco.slot);
  return valuesUpdate(env, guild, event.sheet_id,
    a1(`${colLetter(from)}${row.row_order + 2}:${colLetter(from + PER_RECO - 1)}${row.row_order + 2}`),
    [[recoCell(reco), recoStatusCell(reco, row.declines_used), scoreCell(reco)]]);
}

/** Score cells for one participant (all slots) after they submit ratings. */
export function writeScoreCells(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rowIndex: number, recos: RecoRow[],
): Promise<unknown> {
  if (!event.sheet_id || recos.length === 0) return Promise.resolve();
  const layout = layoutOf(items, event.max_recos);
  return valuesBatchUpdate(env, guild, event.sheet_id, recos.map((r) => {
    const col = colLetter(slotCol(layout, r.slot) + PER_RECO - 1);
    return { range: a1(`${col}${rowIndex + 2}`), values: [[scoreCell(r)]] };
  }));
}
