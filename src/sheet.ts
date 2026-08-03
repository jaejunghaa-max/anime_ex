// Sheet layout + rewrite/read helpers (spec §8.3). The sheet's row order IS
// the loop; the derived Santa/Given block is always overwritten by the bot
// and never read back as input (decision #6/#7).

import type { Env, EventRow, FormItem, GuildRow, SignupRow } from './types';
import {
  SHEET_TAB, addHeaderNotes, valuesBatchUpdate, valuesClear, valuesGet, valuesUpdate,
} from './google';
import { answersOf } from './db';
import { epochToZoned, santaIndex } from './util';

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
  santaCol: number;
  givenCol: number;
  linkCol: number;
  editedCol: number;
  charsCol: number;
  wroteCol: number;
  lastCol: number;
}

export function layoutOf(items: FormItem[]): Layout {
  const k = items.length;
  return {
    itemCount: k,
    santaCol: FIXED + k + 1,
    givenCol: FIXED + k + 2,
    linkCol: FIXED + k + 3,
    editedCol: FIXED + k + 4,
    charsCol: FIXED + k + 5,
    wroteCol: FIXED + k + 6,
    lastCol: FIXED + k + 6,
  };
}

export function headerRow(items: FormItem[]): string[] {
  return [
    'Row #', 'User ID 🔑', 'Username', 'Anime', 'MAL',
    ...items.map((it) => (it.visible_to_recommender ? it.label : `${it.label} 🔒`)),
    'Secret Santa', 'Given Anime', 'Review Link', 'Last Edited', 'Chars', 'Wrote',
  ];
}

export function animeCell(s: SignupRow): string {
  return s.anime_year ? `${s.anime_title} (${s.anime_year})` : s.anime_title;
}

export function wroteCell(s: SignupRow): string {
  if (s.doc_missing) return '❌ (missing)';
  return s.wrote ? '✅' : '❌';
}

function dataRow(
  s: SignupRow, idx: number, ordered: SignupRow[], items: FormItem[], event: EventRow, derived: boolean,
): unknown[] {
  const answers = answersOf(s);
  const santa = derived ? ordered[santaIndex(idx, ordered.length)] : undefined;
  return [
    idx + 1,
    s.user_id, // RAW valueInputOption keeps the 18-digit id a string (precision!)
    s.display_name,
    animeCell(s),
    s.anime_url,
    ...items.map((it) => answers[String(it.item_id)] ?? ''),
    santa ? santa.display_name : '',
    santa ? animeCell(santa) : '',
    s.doc_url ?? '',
    s.last_edited ? epochToZoned(s.last_edited, event.tz ?? 'UTC') : '',
    s.doc_id ? s.char_count : '',
    s.doc_id ? wroteCell(s) : '',
  ];
}

/**
 * Clear + rewrite the whole data block from D1 (idempotent, used by signup
 * upsert/withdraw, Shuffle, Validate, restore). Derived columns are filled
 * once the loop order has been adopted (row_order non-NULL).
 */
export async function rewriteSheet(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[], ordered: SignupRow[],
): Promise<void> {
  if (!event.sheet_id) return;
  const layout = layoutOf(items);
  const derived = ordered.length >= 2 && ordered.every((s) => s.row_order !== null);
  const end = colLetter(layout.lastCol);
  await valuesClear(env, guild, event.sheet_id, `${SHEET_TAB}!A2:${end}1000`);
  if (ordered.length === 0) return;
  const values = ordered.map((s, i) => dataRow(s, i, ordered, items, event, derived));
  await valuesUpdate(env, guild, event.sheet_id, `${SHEET_TAB}!A2:${end}${ordered.length + 1}`, values);
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
        colIndex: layout.santaCol - 1,
        note: 'Auto-derived from row order — reorder rows to change assignments; this block is overwritten on every Validate/Shuffle/Launch.',
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

/** Batched per-tick cell writes: Last Edited / Chars / Wrote during sync (§8.5). */
export function writeSyncCells(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
  rows: Array<{ rowIndex: number; edited: string; chars: number | string; wrote: string }>,
): Promise<unknown> {
  if (!event.sheet_id || rows.length === 0) return Promise.resolve();
  const layout = layoutOf(items);
  const from = colLetter(layout.editedCol);
  const to = colLetter(layout.wroteCol);
  return valuesBatchUpdate(env, guild, event.sheet_id, rows.map((r) => ({
    range: `${SHEET_TAB}!${from}${r.rowIndex + 2}:${to}${r.rowIndex + 2}`,
    values: [[r.edited, r.chars, r.wrote]],
  })));
}
