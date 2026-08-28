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
import {
  activeRecos, answersOf, getItems, loadRecos, orderedSignups, recosOf, type RecoMap,
} from './db';
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
const FIXED = 4; // A Row#, B User ID, C Display name, D MAL/AniList

export interface Layout {
  itemCount: number;
  maxRecos: number;
  groupCol: number;
  santaCol: number;
  /** Per-person Sorry😞 budget remaining — the decline count has no other home. */
  declinesCol: number;
  /** First column of slot 1's block (Recommendation / Rec. Status / Rating). */
  recoCol: number;
  linkCol: number;
  lengthCol: number;
  lastCol: number;
}

/** Columns per slot: Recommendation, Rec. Status, Rating, Review Link, Review Length. */
const PER_RECO = 5;

/** Hard cap on how many anime one participant may ask for (v6). */
export const MAX_PICKS = 3;

/** How many recommendation column-groups the sheet needs: the largest
 *  "picks I want" among the participants (each may choose their own). */
export const sheetSlots = (rows: Array<{ max_recos: number }>): number =>
  Math.min(MAX_PICKS, Math.max(1, ...rows.map((r) => r.max_recos || 1)));

export function layoutOf(items: FormItem[], maxRecos = 1): Layout {
  const k = items.length;
  const n = Math.max(1, maxRecos);
  const recoCol = FIXED + k + 4;
  return {
    itemCount: k,
    maxRecos: n,
    groupCol: FIXED + k + 1,      // manager-editable loop membership
    santaCol: FIXED + k + 2,      // derived: next row within the group
    declinesCol: FIXED + k + 3,   // derived: Sorry😞s the person has left
    recoCol,                      // slot 1 starts here; slot j at recoCol + (j-1)*PER_RECO
    linkCol: recoCol + 3,         // slot 1's Review Link
    lengthCol: recoCol + 4,       // slot 1's Review Length
    lastCol: recoCol + n * PER_RECO - 1,
  };
}

/** 1-indexed first column of slot `slot` (1-based). */
export const slotCol = (layout: Layout, slot: number): number =>
  layout.recoCol + (Math.max(1, slot) - 1) * PER_RECO;

export function headerRow(items: FormItem[], maxRecos = 1): string[] {
  const n = Math.max(1, maxRecos);
  const recoHeaders: string[] = [];
  for (let j = 1; j <= n; j++) {
    // A single-pick event keeps the unnumbered headers.
    const sfx = n > 1 ? ` ${j}` : '';
    recoHeaders.push(
      `Recommendation${sfx}`, `Rec. Status${sfx}`, `Rating${sfx}`,
      `Review Link${sfx}`, `Review Length${sfx}`,
    );
  }
  return [
    'Row #', 'User ID 🔑', 'Display name', 'MAL/AniList',
    ...items.map((it) => (it.visible_to_recommender ? it.label : `${it.label} 🔒`)),
    'Group', 'Secret Santa', 'Sorry😞s left', ...recoHeaders,
  ];
}

/** Recommendation cell: the anime picked for this slot. */
export function recoCell(r: Pick<RecoRow, 'title' | 'year'> | undefined): string {
  if (!r?.title) return '';
  return r.year ? `${r.title} (${r.year})` : r.title;
}

/** Rec. Status cell — mirrors the approve/decline state machine. An empty slot
 *  stays empty: the decline count belongs to the person, not to a slot that
 *  holds no pick, so it lives in its own "Sorry😞s left" column. */
export function recoStatusCell(
  r: Pick<RecoRow, 'status' | 'final_via'> | undefined,
): string {
  switch (r?.status) {
    case 'PENDING':
      return '⏳ awaiting reply';
    case 'FINAL':
      return r.final_via === 'FORCED' ? '⏩ locked at launch' : '✅ accepted';
    case 'DECLINED':
      return '😞 declined';
    default:
      return '';
  }
}

/** Review Length cell: chars written beyond the template; flags deleted docs. */
export function lengthCell(
  r: Pick<RecoRow, 'doc_id' | 'doc_missing' | 'char_count'> | undefined,
): string | number {
  if (!r) return '';
  if (r.doc_missing) return '⚠ missing';
  return r.doc_id ? r.char_count : '';
}

export function scoreCell(r: Pick<RecoRow, 'score'> | undefined): string | number {
  return r?.score ?? '';
}

/** How many Sorry😞s this participant may still spend. */
export const declinesLeftCell = (
  s: Pick<SignupRow, 'declines_used'>, event: Pick<EventRow, 'max_declines'>,
): number => Math.max(0, event.max_declines - s.declines_used);

/** The per-slot block of one participant's row: 5 cells per slot. */
export function recoRowCells(recos: RecoRow[], slots: number): unknown[] {
  // Live picks fill the columns left to right — declined ones leave no gap and
  // no trace; unused slots stay blank.
  const live = activeRecos(recos).sort((a, b) => a.slot - b.slot);
  const cells: unknown[] = [];
  for (let j = 0; j < Math.max(1, slots); j++) {
    const r = live[j];
    cells.push(
      recoCell(r),
      recoStatusCell(r),
      scoreCell(r),
      r?.doc_url ?? '',
      lengthCell(r),
    );
  }
  return cells;
}

function dataRow(
  s: SignupRow, idx: number, santa: SignupRow | undefined, items: FormItem[],
  recos: RecoRow[], slots: number, event: Pick<EventRow, 'max_declines'>,
): unknown[] {
  const answers = answersOf(s);
  return [
    idx + 1,
    s.user_id, // RAW valueInputOption keeps the 18-digit id a string (precision!)
    s.display_name,
    s.list_url,
    ...items.map((it) => answers[String(it.item_id)] ?? ''),
    s.group_no,
    santa ? santa.display_name : '',
    declinesLeftCell(s, event),
    ...recoRowCells(recos, slots),
  ];
}

/**
 * Rewrite the header and data block from D1, then sweep what is left over
 * (idempotent; used by withdraw, Shuffle, Grouping, Validate, restore, and the
 * job-completion self-heal). Including the header row makes layout changes
 * self-heal on sheets created by older deployments, and the sweep reaches a few
 * columns past the block for the same reason. Derived columns fill per group
 * once the loop order has been adopted (row_order non-NULL).
 */
export async function rewriteSheet(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[], ordered: SignupRow[],
  recos: RecoMap = new Map(),
): Promise<void> {
  if (!event.sheet_id) return;
  const slots = sheetSlots(ordered);
  const layout = layoutOf(items, slots);
  const derived = ordered.length >= 2 && ordered.every((s) => s.row_order !== null);
  const loops: LoopMap | null = derived ? buildLoops(ordered.map((s) => s.group_no)) : null;
  const end = colLetter(layout.lastCol);
  const values = [
    headerRow(items, slots),
    ...ordered.map((s, i) => dataRow(
      s, i, loops ? ordered[loops.santa[i]!] : undefined, items,
      recosOf(recos, s.signup_id), slots, event,
    )),
  ];
  // Write BEFORE clearing. These are two separate API calls with no
  // transaction between them, so clearing first left the sheet visibly blank
  // until the update landed — and two interleaved writers could clear away
  // rows the other had just written. Overwriting in place has no such window;
  // only the region past the new data still needs sweeping.
  await valuesUpdate(env, guild, event.sheet_id, a1(`A1:${end}${ordered.length + 1}`), values);
  // Rows below the block (a participant withdrew) and columns past it (someone
  // lowered their pick count, shrinking the per-slot block).
  await valuesClear(env, guild, event.sheet_id, a1(`A${ordered.length + 2}:${colLetter(layout.lastCol + 12)}1000`));
  await valuesClear(env, guild, event.sheet_id,
    a1(`${colLetter(layout.lastCol + 1)}1:${colLetter(layout.lastCol + 12)}${ordered.length + 1}`));
}

/**
 * Rewrite ONE participant's whole row. Used by the sign-up wizard, where the
 * full rewrite above costs a clear + an update per confirmation — ~200 Sheets
 * calls over a 100-person sign-up window, all of them rewriting rows that did
 * not change. Only valid while the layout is stable: a change to the widest
 * pick count moves every row's slot block and needs the full rewrite.
 */
export async function writeSignupRow(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  ordered: SignupRow[], index: number,
): Promise<void> {
  const s = ordered[index];
  if (!event.sheet_id || !s) return;
  const slots = sheetSlots(ordered);
  const layout = layoutOf(items, slots);
  const derived = ordered.length >= 2 && ordered.every((r) => r.row_order !== null);
  const loops: LoopMap | null = derived ? buildLoops(ordered.map((r) => r.group_no)) : null;
  await valuesUpdate(
    env, guild, event.sheet_id,
    a1(`A${index + 2}:${colLetter(layout.lastCol)}${index + 2}`),
    [dataRow(s, index, loops ? ordered[loops.santa[index]!] : undefined, items, [], slots, event)],
  );
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

/** Written once, on a brand-new empty sheet — hence a single slot. Every later
 *  signup widens the block through `rewriteSheet`, which rewrites the header. */
export async function writeHeader(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<void> {
  if (!event.sheet_id) return;
  const header = headerRow(items, 1);
  await valuesUpdate(env, guild, event.sheet_id, a1(`A1:${colLetter(header.length)}1`), [header]);
  if (event.sheet_gid !== null) {
    const layout = layoutOf(items, 1);
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
        colIndex: layout.declinesCol - 1,
        note: 'Auto-derived: how many times this person may still send a pick back. Written by the bot; never read as input.',
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
  // Validate only reads up to the Group column, so the (variable) slot block
  // beyond it never affects the range's meaning.
  const layout = layoutOf(items, MAX_PICKS);
  return valuesGet(env, guild, event.sheet_id, a1(`A2:${colLetter(layout.lastCol)}1000`));
}

/**
 * Rewrite whole recommendation blocks, one A1 range per participant row —
 * every send / accept / decline / rating / doc-link / sync shifts cells inside
 * the block, so it is always written as a unit. Best-effort; the
 * job-completion rewrite heals anything that failed.
 */
export async function writeRecoRows(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rows: Array<{ row: SignupRow; recos: RecoRow[] }>,
): Promise<void> {
  const usable = rows.filter((r) => r.row.row_order !== null);
  if (!event.sheet_id || usable.length === 0) return;
  const widest = await env.DB
    .prepare('SELECT COALESCE(MAX(max_recos), 1) AS n FROM signups WHERE event_id = ?1')
    .bind(event.event_id).first<{ n: number }>();
  const slots = Math.min(MAX_PICKS, Math.max(1, widest?.n ?? 1));
  const layout = layoutOf(items, slots);
  // Starts one column early: declines_used changes on every Sorry😞, so the
  // budget cell has to travel with the block that a decline rewrites.
  const from = colLetter(layout.declinesCol);
  const to = colLetter(slotCol(layout, slots) + PER_RECO - 1);
  await valuesBatchUpdate(env, guild, event.sheet_id, usable.map(({ row, recos }) => ({
    range: a1(`${from}${row.row_order! + 2}:${to}${row.row_order! + 2}`),
    values: [[declinesLeftCell(row, event), ...recoRowCells(recos, slots)]],
  })));
}

/** Same, for a single participant — loads their picks itself. */
export async function writeRecoCells(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[], row: SignupRow,
): Promise<void> {
  if (!event.sheet_id || row.row_order === null) return;
  const res = await env.DB.prepare('SELECT * FROM recos WHERE signup_id = ?1 ORDER BY slot')
    .bind(row.signup_id).all<RecoRow>();
  await writeRecoRows(env, guild, event, items, [{ row, recos: res.results }]);
}
