// Sheet layout + rewrite/read helpers (spec §8.3). The sheet's row order and
// its manager-editable Group column ARE the assignment (rows = loop order,
// Group = loop membership); the derived Santa/Given block is always
// overwritten by the bot and never read back as input (decision #6/#7).

import type { Env, EventRow, FormItem, GuildRow, SignupRow } from './types';
import {
  SHEET_TAB, addHeaderNotes, valuesBatchUpdate, valuesClear, valuesGet, valuesUpdate,
} from './google';
import { answersOf } from './db';
import { buildLoops, type LoopMap } from './util';

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
const FIXED = 5; // A Row#, B User ID, C Username, D Anime, E MAL

export interface Layout {
  itemCount: number;
  groupCol: number;
  santaCol: number;
  givenCol: number;
  linkCol: number;
  lengthCol: number;
  scoreCol: number;
  lastCol: number;
}

export function layoutOf(items: FormItem[]): Layout {
  const k = items.length;
  return {
    itemCount: k,
    groupCol: FIXED + k + 1, // manager-editable loop membership (§8.3)
    santaCol: FIXED + k + 2,
    givenCol: FIXED + k + 3,
    linkCol: FIXED + k + 4,
    lengthCol: FIXED + k + 5, // "Review Length" — body chars minus template
    scoreCol: FIXED + k + 6,  // participant's /10 score of their given anime
    lastCol: FIXED + k + 6,
  };
}

export function headerRow(items: FormItem[]): string[] {
  return [
    'Row #', 'User ID 🔑', 'Username', 'Anime', 'MAL',
    ...items.map((it) => (it.visible_to_recommender ? it.label : `${it.label} 🔒`)),
    'Group', 'Secret Santa', 'Given Anime', 'Review Link', 'Review Length', 'Score',
  ];
}

export function animeCell(s: SignupRow): string {
  return s.anime_year ? `${s.anime_title} (${s.anime_year})` : s.anime_title;
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
    animeCell(s),
    s.anime_url,
    ...items.map((it) => answers[String(it.item_id)] ?? ''),
    s.group_no,
    santa ? santa.display_name : '',
    santa ? animeCell(santa) : '',
    s.doc_url ?? '',
    lengthCell(s),
    scoreCell(s),
  ];
}

/**
 * Clear + rewrite the header and data block from D1 (idempotent, used by
 * signup upsert/withdraw, Shuffle, Grouping, Validate, restore). Including
 * the header row makes layout changes self-heal on sheets created by older
 * deployments; the clear range sweeps a few extra columns for the same
 * reason. Derived columns fill per group once the loop order has been
 * adopted (row_order non-NULL).
 */
export async function rewriteSheet(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[], ordered: SignupRow[],
): Promise<void> {
  if (!event.sheet_id) return;
  const layout = layoutOf(items);
  const derived = ordered.length >= 2 && ordered.every((s) => s.row_order !== null);
  const loops: LoopMap | null = derived ? buildLoops(ordered.map((s) => s.group_no)) : null;
  const end = colLetter(layout.lastCol);
  await valuesClear(env, guild, event.sheet_id, `${SHEET_TAB}!A2:${colLetter(layout.lastCol + 3)}1000`);
  const values = [
    headerRow(items),
    ...ordered.map((s, i) => dataRow(s, i, loops ? ordered[loops.santa[i]!] : undefined, items)),
  ];
  await valuesUpdate(env, guild, event.sheet_id, `${SHEET_TAB}!A1:${end}${ordered.length + 1}`, values);
}

export async function writeHeader(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<void> {
  if (!event.sheet_id) return;
  const header = headerRow(items);
  await valuesUpdate(env, guild, event.sheet_id,
    `${SHEET_TAB}!A1:${colLetter(header.length)}1`, [header]);
  if (event.sheet_gid !== null) {
    const layout = layoutOf(items);
    await addHeaderNotes(env, guild, event.sheet_id, event.sheet_gid, [
      { colIndex: 1, note: 'Immutable key — do not edit this column.' },
      {
        colIndex: layout.groupCol - 1,
        note: 'Loop membership — positive integer, blank = 1. Edit to move someone between loops; rows re-sort into contiguous group blocks on Validate.',
      },
      {
        colIndex: layout.santaCol - 1,
        note: 'Auto-derived: the next row within the group. Reorder rows / edit Group to change assignments; this block is overwritten on every Shuffle/Grouping/Validate/Launch.',
      },
    ]).catch(() => { /* cosmetic */ });
  }
}

/** Read the data block for Validate (§5.4): array of rows, col B = user id key. */
export async function readSheetRows(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<string[][]> {
  if (!event.sheet_id) return [];
  const layout = layoutOf(items);
  return valuesGet(env, guild, event.sheet_id, `${SHEET_TAB}!A2:${colLetter(layout.lastCol)}1000`);
}

/** Batched per-tick cell writes: Review Link during Launch (§7.5). */
export function writeReviewLinks(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rows: Array<{ rowIndex: number; url: string }>,
): Promise<unknown> {
  if (!event.sheet_id || rows.length === 0) return Promise.resolve();
  const col = colLetter(layoutOf(items).linkCol);
  return valuesBatchUpdate(env, guild, event.sheet_id, rows.map((r) => ({
    range: `${SHEET_TAB}!${col}${r.rowIndex + 2}`,
    values: [[r.url]],
  })));
}

/** Batched per-tick cell writes: Review Length + Score during sync (§8.5). */
export function writeStatusCells(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rows: Array<{ rowIndex: number; length: number | string; score: number | string }>,
): Promise<unknown> {
  if (!event.sheet_id || rows.length === 0) return Promise.resolve();
  const layout = layoutOf(items);
  const from = colLetter(layout.lengthCol);
  const to = colLetter(layout.scoreCol);
  return valuesBatchUpdate(env, guild, event.sheet_id, rows.map((r) => ({
    range: `${SHEET_TAB}!${from}${r.rowIndex + 2}:${to}${r.rowIndex + 2}`,
    values: [[r.length, r.score]],
  })));
}

/** Single-cell Score write when a participant submits their /10 rating. */
export function writeScoreCell(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[], rowIndex: number, score: number,
): Promise<unknown> {
  if (!event.sheet_id) return Promise.resolve();
  const col = colLetter(layoutOf(items).scoreCol);
  return valuesUpdate(env, guild, event.sheet_id, `${SHEET_TAB}!${col}${rowIndex + 2}`, [[score]]);
}
