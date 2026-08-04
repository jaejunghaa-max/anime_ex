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
 */
export async function gapi<T = unknown>(
  env: Env, guild: GuildRow, method: string, url: string, body?: unknown,
  opts: { raw?: boolean } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(env, guild);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      invalidateTokenCache(guild.guild_id);
      if (attempt === 0) continue;
      throw new GoogleAuthError('access rejected twice');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(700 * (attempt + 1));
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

/** Email shown on the panel; drive.file-safe (Drive "about" needs no extra scope). */
export function fetchConnectedEmail(env: Env, guild: GuildRow): Promise<string | null> {
  return gapi<{ user?: { emailAddress?: string } }>(
    env, guild, 'GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
  ).then((r) => r.user?.emailAddress ?? null).catch(() => null);
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

/** Write the small review template (§7.5): H1 title + context line + divider. */
export async function writeDocTemplate(
  env: Env, guild: GuildRow, docId: string, animeTitle: string, reviewerName: string, deadlineText: string,
): Promise<void> {
  const heading = `Review of ${animeTitle}\n`;
  const body = `given to @${reviewerName} — deadline ${deadlineText}\n————————————————\n\n`;
  await gapi(env, guild, 'POST', `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    requests: [
      { insertText: { location: { index: 1 }, text: heading + body } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: heading.length },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType',
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ Sheets

export function sheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

export const SHEET_TAB = 'Sign-Ups';

export async function createSpreadsheet(
  env: Env, guild: GuildRow, title: string,
): Promise<{ spreadsheetId: string; gid: number }> {
  const res = await gapi<{ spreadsheetId: string; sheets: Array<{ properties: { sheetId: number } }> }>(
    env, guild, 'POST', 'https://sheets.googleapis.com/v4/spreadsheets', {
      properties: { title: truncate(title, 200) },
      sheets: [{ properties: { title: SHEET_TAB, gridProperties: { frozenRowCount: 1 } } }],
    });
  return { spreadsheetId: res.spreadsheetId, gid: res.sheets[0]?.properties.sheetId ?? 0 };
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
