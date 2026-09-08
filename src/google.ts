// Google integration (spec §8): manager OAuth with drive.file scope only,
// raw fetch REST for Drive v3 / Sheets v4 / Docs v1. Access tokens are cached
// in a module-level map so warm isolates skip the refresh POST (spec §2.4 #3).

import type { Env, GuildRow } from './types';
import { decryptToken, sleep, truncate } from './util';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export class GoogleAuthError extends Error {
  constructor(msg = 'Google disconnected') { super(msg); }
}

export const GOOGLE_RECONNECT_MSG =
  '⚠ **Google disconnected** — a manager must press **Connect Google** on the manager panel, then retry.';

export class GoogleApiError extends Error {
  constructor(public status: number, public path: string, body: string) {
    super(`Google ${status} on ${path}: ${truncate(body, 300)}`);
  }
}

// guild_id → cached short-lived access token
const tokenCache = new Map<string, { token: string; exp: number }>();

export function invalidateTokenCache(guildId: string): void {
  tokenCache.delete(guildId);
}

async function refreshAccessToken(env: Env, guild: GuildRow): Promise<string> {
  if (!guild.google_refresh_token_enc) throw new GoogleAuthError();
  const refreshToken = await decryptToken(env.TOKEN_ENC_KEY, guild.google_refresh_token_enc);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string; expires_in?: number; error?: string;
  };
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      // Token revoked (§8.1): clear it so the panel shows "not connected";
      // stalled jobs surface the reconnect prompt and self-heal after reconnect.
      await env.DB.prepare('UPDATE guilds SET google_refresh_token_enc = NULL WHERE guild_id = ?1')
        .bind(guild.guild_id).run();
      guild.google_refresh_token_enc = null;
      throw new GoogleAuthError('refresh token revoked');
    }
    throw new GoogleApiError(res.status, 'oauth2/token', JSON.stringify(data));
  }
  const entry = {
    token: data.access_token,
    exp: Math.floor(Date.now() / 1000) + Math.max(60, (data.expires_in ?? 3600) - 120),
  };
  tokenCache.set(guild.guild_id, entry);
  return entry.token;
}

async function accessToken(env: Env, guild: GuildRow): Promise<string> {
  const hit = tokenCache.get(guild.guild_id);
  if (hit && hit.exp > Math.floor(Date.now() / 1000)) return hit.token;
  return refreshAccessToken(env, guild);
}

/**
 * Authenticated Google REST call. On a 401 the cached token is dropped and the
 * call retried once with a fresh token; a second 401 means the grant is dead.
 *
 * The auth and rate-limit budgets are counted separately: sharing one counter
 * meant a 429 retry consumed the auth budget, so the very first 401 after a
 * transient failure was reported as a revoked grant — sending the manager off
 * to re-authorize a connection that was never broken.
 */
export async function gapi<T = unknown>(
  env: Env, guild: GuildRow, method: string, url: string, body?: unknown,
  opts: { raw?: boolean } = {},
): Promise<T> {
  let authRetries = 0;
  let backoffRetries = 0;
  for (;;) {
    const token = await accessToken(env, guild);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      invalidateTokenCache(guild.guild_id);
      if (authRetries < 1) {
        authRetries++;
        continue;
      }
      throw new GoogleAuthError('access rejected twice');
    }
    if ((res.status === 429 || res.status >= 500) && backoffRetries < 2) {
      backoffRetries++;
      await sleep(700 * backoffRetries);
      continue;
    }
    if (!res.ok) throw new GoogleApiError(res.status, url, await res.text().catch(() => ''));
    if (opts.raw) return (await res.text()) as unknown as T;
    if (res.status === 204) return undefined as T;
    return (await res.json().catch(() => undefined)) as T;
  }
}

export function isConnected(guild: GuildRow): boolean {
  return !!guild.google_refresh_token_enc;
}

// ------------------------------------------------------------------ Drive

export interface DriveFileMeta { modifiedTime?: string }

export function driveFileMeta(env: Env, guild: GuildRow, fileId: string): Promise<DriveFileMeta> {
  return gapi(env, guild, 'GET',
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime`);
}

export function driveExportText(env: Env, guild: GuildRow, fileId: string): Promise<string> {
  return gapi(env, guild, 'GET',
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain`,
    undefined, { raw: true });
}

/** Permanently delete a file this app created (drive.file scope covers it).
 *  Used only by the abort teardown; 🧹 Finish leaves everything in place. */
export async function driveDelete(env: Env, guild: GuildRow, fileId: string): Promise<void> {
  try {
    await gapi(env, guild, 'DELETE', `https://www.googleapis.com/drive/v3/files/${fileId}`);
  } catch (e) {
    // Already gone, or someone moved it out of our reach — either way there is
    // nothing left to delete and the teardown must not stall on it.
    if (e instanceof GoogleApiError && (e.status === 404 || e.status === 403)) return;
    throw e;
  }
}

/** anyone-with-link role; returns the permission id (stored for the Close flip). */
export async function driveShareAnyone(
  env: Env, guild: GuildRow, fileId: string, role: 'writer' | 'reader',
): Promise<string> {
  const res = await gapi<{ id: string }>(env, guild, 'POST',
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=id`,
    { type: 'anyone', role });
  return res.id;
}

export async function driveFlipAnyoneToReader(
  env: Env, guild: GuildRow, fileId: string, permId: string | null,
): Promise<void> {
  let id = permId;
  if (!id) {
    const list = await gapi<{ permissions?: Array<{ id: string; type: string }> }>(
      env, guild, 'GET',
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,type)`);
    id = list.permissions?.find((p) => p.type === 'anyone')?.id ?? null;
    if (!id) return; // nothing shared → nothing to flip
  }
  await gapi(env, guild, 'PATCH',
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${id}`,
    { role: 'reader' });
}

// ------------------------------------------------------------------- Docs

export function docUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

export async function createDoc(env: Env, guild: GuildRow, title: string): Promise<string> {
  const res = await gapi<{ documentId: string }>(env, guild, 'POST',
    'https://docs.googleapis.com/v1/documents', { title: truncate(title, 300) });
  return res.documentId;
}

/**
 * Write the small review template (§7.5): H1 title + context line + divider.
 * `givenTo` arrives preformatted, e.g. `J(@j_handle)`.
 *
 * (Pre-v6 this also emitted one H2 per anime, because a participant had one
 * doc for all of their picks. Since v6 every anime has its own doc, so the
 * section list was always empty and is gone.)
 */
export async function writeDocTemplate(
  env: Env, guild: GuildRow, docId: string,
  t: { heading: string; givenTo: string; deadlineText: string },
): Promise<void> {
  const parts: Array<{ text: string; style?: 'HEADING_1' }> = [
    { text: `${t.heading}\n`, style: 'HEADING_1' },
    { text: `given to ${t.givenTo} — deadline ${t.deadlineText}\n————————————————\n\n` },
  ];
  // Build the text and the paragraph-style ranges in one pass; Docs indices
  // start at 1 and each part's range covers its own trailing newline.
  let text = '';
  let index = 1;
  const styles: unknown[] = [];
  for (const p of parts) {
    const start = index;
    text += p.text;
    index += p.text.length;
    if (p.style) {
      styles.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: start + p.text.length },
          paragraphStyle: { namedStyleType: p.style },
          fields: 'namedStyleType',
        },
      });
    }
  }
  await gapi(env, guild, 'POST', `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    requests: [{ insertText: { location: { index: 1 }, text } }, ...styles],
  });
}

// ------------------------------------------------------------------ Sheets

export function sheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

export const SHEET_TAB = 'Sign-Ups';

export async function createSpreadsheet(
  env: Env, guild: GuildRow, title: string, columns: number,
): Promise<{ spreadsheetId: string; gid: number }> {
  const res = await gapi<{ spreadsheetId: string; sheets: Array<{ properties: { sheetId: number } }> }>(
    env, guild, 'POST', 'https://sheets.googleapis.com/v4/spreadsheets', {
      properties: { title: truncate(title, 200) },
      // Size the grid for the widest layout the bot can produce plus the sweep
      // margin past it. Google's default is 26 columns, which the largest
      // layout fills exactly — and Sheets rejects a range starting past the
      // last column outright (a range that merely overlaps the grid is clamped
      // instead), so the cleanup pass would 400 on every write.
      sheets: [{ properties: { title: SHEET_TAB, gridProperties: { frozenRowCount: 1, columnCount: columns } } }],
    });
  return { spreadsheetId: res.spreadsheetId, gid: res.sheets[0]?.properties.sheetId ?? 0 };
}

/** Grow a sheet's grid to at least `columns` wide. No-op if it already is —
 *  never shrinks, so a manager who added columns by hand keeps them. */
export async function ensureGridWidth(
  env: Env, guild: GuildRow, spreadsheetId: string, gid: number, columns: number,
): Promise<void> {
  const meta = await gapi<{
    sheets?: Array<{ properties: { sheetId: number; gridProperties?: { columnCount?: number } } }>;
  }>(env, guild, 'GET',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,gridProperties(columnCount)))`);
  const sheet = meta.sheets?.find((x) => x.properties.sheetId === gid) ?? meta.sheets?.[0];
  const have = sheet?.properties.gridProperties?.columnCount ?? 0;
  if (have === 0 || have >= columns) return;
  await gapi(env, guild, 'POST',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      requests: [{ appendDimension: { sheetId: gid, dimension: 'COLUMNS', length: columns - have } }],
    });
}

function enc(range: string): string {
  return encodeURIComponent(range);
}

export function valuesUpdate(
  env: Env, guild: GuildRow, spreadsheetId: string, range: string, values: unknown[][],
): Promise<unknown> {
  return gapi(env, guild, 'PUT',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${enc(range)}?valueInputOption=RAW`,
    { range, majorDimension: 'ROWS', values });
}

/** One subrequest for many scattered cell writes (per-tick batches, §7.5/§8.5). */
export function valuesBatchUpdate(
  env: Env, guild: GuildRow, spreadsheetId: string, data: Array<{ range: string; values: unknown[][] }>,
): Promise<unknown> {
  return gapi(env, guild, 'POST',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    { valueInputOption: 'RAW', data: data.map((d) => ({ ...d, majorDimension: 'ROWS' })) });
}

export function valuesClear(
  env: Env, guild: GuildRow, spreadsheetId: string, range: string,
): Promise<unknown> {
  return gapi(env, guild, 'POST',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${enc(range)}:clear`, {});
}

export async function valuesGet(
  env: Env, guild: GuildRow, spreadsheetId: string, range: string,
): Promise<string[][]> {
  const res = await gapi<{ values?: string[][] }>(env, guild, 'GET',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${enc(range)}?valueRenderOption=FORMATTED_VALUE`);
  return res.values ?? [];
}

/**
 * Does this tab carry a sort that only exists for the viewer?
 *
 * `values.get` returns the UNDERLYING row order. A **filter view** (Data →
 * Filter views) sorts for one person and never moves the stored rows, so a
 * manager who reorders that way sees one order while the bot reads another —
 * Validate then "succeeds" and rewrites the sheet in the order it actually
 * read, which looks exactly like the reorder being undone. A basic filter with
 * sortSpecs is reported too, since it is just as invisible after the fact.
 */
export async function sheetSortWarning(
  env: Env, guild: GuildRow, spreadsheetId: string, gid: number,
): Promise<string | null> {
  const meta = await gapi<{
    sheets?: Array<{
      properties: { sheetId: number };
      filterViews?: Array<{ sortSpecs?: unknown[] }>;
      basicFilter?: { sortSpecs?: unknown[] };
    }>;
  }>(env, guild, 'GET',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId),filterViews(sortSpecs),basicFilter(sortSpecs))`);
  const sheet = meta.sheets?.find((x) => x.properties.sheetId === gid) ?? meta.sheets?.[0];
  if (!sheet) return null;
  if (sheet.filterViews?.length) {
    return 'This tab has a **filter view**. A filter view sorts what *you* see without moving the ' +
      'stored rows, and the bot reads the stored order — so reordering inside one has no effect. ' +
      'Close the filter view (Data → Filter views → None) and reorder the rows themselves.';
  }
  if (sheet.basicFilter?.sortSpecs?.length) {
    return 'This tab has a **filter with a sort** on it. Remove the filter (Data → Remove filter) ' +
      'before reordering, so what you see is the order the bot reads.';
  }
  return null;
}

/** Header notes: "immutable key — do not edit" on User ID, derived-columns warning (§8.3). */
export function addHeaderNotes(
  env: Env, guild: GuildRow, spreadsheetId: string, gid: number,
  notes: Array<{ colIndex: number; note: string }>,
): Promise<unknown> {
  return gapi(env, guild, 'POST',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      requests: notes.map((n) => ({
        updateCells: {
          range: {
            sheetId: gid, startRowIndex: 0, endRowIndex: 1,
            startColumnIndex: n.colIndex, endColumnIndex: n.colIndex + 1,
          },
          rows: [{ values: [{ note: n.note }] }],
          fields: 'note',
        },
      })),
    });
}
