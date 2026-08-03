// Validate (spec §5.4): read the sheet, key on the immutable User ID column,
// adopt the sheet's row order into D1, recompute + rewrite the derived block.
// Shared by the Validate button and the Launch confirm (§7.5).

import type { Env, EventRow, FormItem, GuildRow, SignupRow } from './types';
import { dbBatchChunked, orderedSignups } from './db';
import { readSheetRows, rewriteSheet } from './sheet';
import { now } from './util';

export interface ValidateResult {
  ok: boolean;
  n: number;
  errors: string[];
  warnings: string[];
  /** Signed-up users whose row vanished from the sheet → removal/restore flow. */
  missing: Array<{ userId: string; name: string }>;
}

export async function runValidate(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<ValidateResult> {
  const signups = await orderedSignups(env, event.event_id);
  const byId = new Map(signups.map((s) => [s.user_id, s]));
  const errors: string[] = [];
  const warnings: string[] = [];
  const missing: Array<{ userId: string; name: string }> = [];

  const rows = await readSheetRows(env, guild, event, items);
  const seen = new Set<string>();
  const sheetOrder: SignupRow[] = [];

  for (const [i, row] of rows.entries()) {
    const userId = (row[1] ?? '').toString().trim();
    if (!userId && row.every((c) => !(c ?? '').toString().trim())) continue; // blank line
    const rowNo = i + 2;
    if (!/^\d{5,20}$/.test(userId)) {
      errors.push(`Row ${rowNo}: User ID column is not a valid Discord id (\`${userId || 'empty'}\`) — the 🔑 column must not be edited.`);
      continue;
    }
    if (seen.has(userId)) {
      errors.push(`Row ${rowNo}: duplicate user <@${userId}>.`);
      continue;
    }
    seen.add(userId);
    const signup = byId.get(userId);
    if (!signup) {
      errors.push(`Row ${rowNo}: unknown user id \`${userId}\` — not a signed-up participant.`);
      continue;
    }
    sheetOrder.push(signup);
  }

  for (const s of signups) {
    if (!seen.has(s.user_id)) missing.push({ userId: s.user_id, name: s.display_name });
  }
  for (const m of missing) {
    errors.push(`**${m.name}** (<@${m.userId}>) signed up but has no sheet row — confirm their removal or restore the row.`);
  }

  const n = sheetOrder.length;
  if (errors.length === 0 && n < 2) errors.push(`Need at least 2 participants to launch (currently ${n}).`);
  if (errors.length === 0 && n === 2) {
    warnings.push('With exactly 2 participants your santa and your recipient are the same person — the reveal is trivial.');
  }

  if (errors.length > 0) return { ok: false, n, errors, warnings, missing };

  // Adopt the sheet's order as the loop (decision: the sheet is authoritative
  // for ORDER only; D1 stays authoritative for membership).
  const prev = signups.filter((s) => s.row_order !== null).map((s) => s.user_id).join(',');
  const next = sheetOrder.map((s) => s.user_id).join(',');
  const reordered = prev !== '' && prev !== next;

  const stmts = sheetOrder.map((s, i) =>
    env.DB.prepare('UPDATE signups SET row_order = ?1, updated_at = ?2 WHERE signup_id = ?3')
      .bind(i, now(), s.signup_id),
  );
  stmts.push(
    env.DB.prepare(
      'UPDATE events SET validated_at = ?1, updated_at = ?1, loop_status = CASE WHEN ?2 THEN \'manual\' ELSE loop_status END WHERE event_id = ?3',
    ).bind(now(), reordered ? 1 : 0, event.event_id),
  );
  await dbBatchChunked(env, stmts);

  // Rewrite the sheet: renumber Row #, recompute Santa/Given (next-row rule
  // is an invariant by construction — decision #7).
  const fresh = sheetOrder.map((s, i) => ({ ...s, row_order: i }));
  await rewriteSheet(env, guild, event, items, fresh);

  return { ok: true, n, errors, warnings, missing };
}

/**
 * Adopt the current loop order as row_order 0..n-1 and rewrite the sheet
 * (fills the derived Santa/Given block). Sheet write is best-effort — Validate
 * reconciles later; used by Stop Sign-Ups and the auto-stop cron (§4).
 */
export async function adoptSignupOrder(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<number> {
  const ordered = await orderedSignups(env, event.event_id);
  if (ordered.length > 0) {
    await dbBatchChunked(env, ordered.map((s, idx) =>
      env.DB.prepare('UPDATE signups SET row_order = ?1, updated_at = ?2 WHERE signup_id = ?3')
        .bind(idx, now(), s.signup_id)));
  }
  const fresh = ordered.map((s, idx) => ({ ...s, row_order: idx }));
  await rewriteSheet(env, guild, event, items, fresh).catch((e) => {
    console.error('sheet rewrite failed (will reconcile at Validate)', e);
  });
  return ordered.length;
}

export function validateReport(r: ValidateResult): string {
  if (r.ok) {
    const warn = r.warnings.length ? `\n⚠ ${r.warnings.join('\n⚠ ')}` : '';
    return `✅ **${r.n}** participants · single loop · Santa column = next-row rule ✔${warn}`;
  }
  const lines = [`❌ Validation failed:`, ...r.errors.map((e) => `• ${e}`)];
  if (r.warnings.length) lines.push(...r.warnings.map((w) => `⚠ ${w}`));
  return lines.join('\n');
}
