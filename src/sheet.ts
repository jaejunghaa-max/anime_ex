// Sheet layout + rewrite/read helpers (v3). The sheet's row order and its
// manager-editable Group column ARE the assignment (rows = loop order, Group =
// loop membership) while MATCHING lasts; the derived Secret Santa column and
// the Recommendation/Rec. Status block are always written by the bot and never
// read back as input. Once recommendations start, the assignment is frozen —
// the sheet becomes a dashboard.

import type { Env, EventRow, FormItem, GuildRow, SignupRow } from './types';
import {
  SHEET_TAB, addHeaderNotes, valuesBatchUpdate, valuesClear, valuesGet, valuesUpdate,
} from './google';
import { answersOf } from './db';
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
  groupCol: number;
  santaCol: number;
  recoCol: number;
  recoStatusCol: number;
  linkCol: number;
  lengthCol: number;
  scoreCol: number;
  lastCol: number;
}

export function layoutOf(items: FormItem[]): Layout {
  const k = items.length;
  return {
    itemCount: k,
    groupCol: FIXED + k + 1,      // manager-editable loop membership
    santaCol: FIXED + k + 2,      // derived: next row within the group
    recoCol: FIXED + k + 3,       // the anime this row's Santa picked for them
    recoStatusCol: FIXED + k + 4, // approval state of that pick
    linkCol: FIXED + k + 5,
    lengthCol: FIXED + k + 6,     // "Review Length" — body chars minus template
    scoreCol: FIXED + k + 7,      // participant's /10 score of their given anime
    lastCol: FIXED + k + 7,
  };
}

export function headerRow(items: FormItem[]): string[] {
  return [
    'Row #', 'User ID 🔑', 'Username', 'MAL/AniList',
    ...items.map((it) => (it.visible_to_recommender ? it.label : `${it.label} 🔒`)),
    'Group', 'Secret Santa', 'Recommendation', 'Rec. Status', 'Review Link', 'Review Length', 'Score',
  ];
}

/** Recommendation cell: the anime this row's Santa picked for them. */
export function recoCell(s: Pick<SignupRow, 'reco_title' | 'reco_year'>): string {
  if (!s.reco_title) return '';
  return s.reco_year ? `${s.reco_title} (${s.reco_year})` : s.reco_title;
}

/** Rec. Status cell — mirrors the approve/decline state machine. */
export function recoStatusCell(
  s: Pick<SignupRow, 'reco_status' | 'reco_final_via' | 'declines_used'>,
): string {
  switch (s.reco_status) {
    case 'PENDING':
      return '⏳ awaiting reply';
    case 'FINAL':
      return s.reco_final_via === 'EXHAUSTED' ? '🔒 locked (declines used up)'
        : s.reco_final_via === 'FORCED' ? '⏩ finalized by manager'
        : '✅ approved';
    default:
      return s.declines_used > 0 ? `😞 declined ×${s.declines_used}` : '';
  }
}

/** Review Length cell: chars written beyond the template; flags deleted docs. */
export function lengthCell(s: Pick<SignupRow, 'doc_id' | 'doc_missing' | 'char_count'>): string | number {
  if (s.doc_missing) return '⚠ missing';
  return s.doc_id ? s.char_count : '';
}

export function scoreCell(s: Pick<SignupRow, 'score'>): string | number {
  return s.score ?? '';
}

function dataRow(
  s: SignupRow, idx: number, santa: SignupRow | undefined, items: FormItem[],
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
    recoCell(s),
    recoStatusCell(s),
    s.doc_url ?? '',
    lengthCell(s),
    scoreCell(s),
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
): Promise<void> {
  if (!event.sheet_id) return;
  const layout = layoutOf(items);
  const derived = ordered.length >= 2 && ordered.every((s) => s.row_order !== null);
  const loops: LoopMap | null = derived ? buildLoops(ordered.map((s) => s.group_no)) : null;
  const end = colLetter(layout.lastCol);
  await valuesClear(env, guild, event.sheet_id, a1(`A2:${colLetter(layout.lastCol + 3)}1000`));
  const values = [
    headerRow(items),
    ...ordered.map((s, i) => dataRow(s, i, loops ? ordered[loops.santa[i]!] : undefined, items)),
  ];
  await valuesUpdate(env, guild, event.sheet_id, a1(`A1:${end}${ordered.length + 1}`), values);
}

export async function writeHeader(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<void> {
  if (!event.sheet_id) return;
  const header = headerRow(items);
  await valuesUpdate(env, guild, event.sheet_id, a1(`A1:${colLetter(header.length)}1`), [header]);
  if (event.sheet_gid !== null) {
    const layout = layoutOf(items);
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
        note: 'Written by the bot during the recommending phase — the anime this row\'s Secret Santa picked for them. Never read as input.',
      },
    ]).catch(() => { /* cosmetic */ });
  }
}

/** Read the data block for Validate: array of rows, col B = user id key. */
export async function readSheetRows(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<string[][]> {
  if (!event.sheet_id) return [];
  const layout = layoutOf(items);
  return valuesGet(env, guild, event.sheet_id, a1(`A2:${colLetter(layout.lastCol)}1000`));
}

/** Batched per-tick cell writes: Review Link during Launch. */
export function writeReviewLinks(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rows: Array<{ rowIndex: number; url: string }>,
): Promise<unknown> {
  if (!event.sheet_id || rows.length === 0) return Promise.resolve();
  const col = colLetter(layoutOf(items).linkCol);
  return valuesBatchUpdate(env, guild, event.sheet_id, rows.map((r) => ({
    range: a1(`${col}${r.rowIndex + 2}`),
    values: [[r.url]],
  })));
}

/** Batched per-tick cell writes: Review Length + Score during sync. */
export function writeStatusCells(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rows: Array<{ rowIndex: number; length: number | string; score: number | string }>,
): Promise<unknown> {
  if (!event.sheet_id || rows.length === 0) return Promise.resolve();
  const layout = layoutOf(items);
  const from = colLetter(layout.lengthCol);
  const to = colLetter(layout.scoreCol);
  return valuesBatchUpdate(env, guild, event.sheet_id, rows.map((r) => ({
    range: a1(`${from}${r.rowIndex + 2}:${to}${r.rowIndex + 2}`),
    values: [[r.length, r.score]],
  })));
}

/** Recommendation + Rec. Status cells for one row — written on every send /
 *  approve / decline so the manager's sheet mirrors the phase live. */
export function writeRecoCells(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[], row: SignupRow,
): Promise<unknown> {
  if (!event.sheet_id || row.row_order === null) return Promise.resolve();
  const layout = layoutOf(items);
  const from = colLetter(layout.recoCol);
  const to = colLetter(layout.recoStatusCol);
  return valuesUpdate(env, guild, event.sheet_id,
    a1(`${from}${row.row_order + 2}:${to}${row.row_order + 2}`),
    [[recoCell(row), recoStatusCell(row)]]);
}

/** Single-cell Score write when a participant submits their /10 rating. */
export function writeScoreCell(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[], rowIndex: number, score: number,
): Promise<unknown> {
  if (!event.sheet_id) return Promise.resolve();
  const col = colLetter(layoutOf(items).scoreCol);
  return valuesUpdate(env, guild, event.sheet_id, a1(`${col}${rowIndex + 2}`), [[score]]);
}
