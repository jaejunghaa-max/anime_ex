// Validate (spec §5.4, rev. 3): read the sheet, key on the immutable User ID
// column, parse the manager-editable Group column, enforce per-group rules
// (a 1-member group blocks — self-assignment; a 2-member group warns —
// mutual pair), stable-sort rows into contiguous group blocks, adopt order +
// membership into D1, and rewrite the derived block per group. Shared by the
// Validate button and the Launch confirm (§7.5).

import type { Env, EventRow, FormItem, GuildRow, SignupRow } from './types';
import { dbBatchChunked, orderedSignups } from './db';
import { layoutOf, readSheetRows, rewriteSheet } from './sheet';
import { loopsPhrase, now } from './util';

export interface ValidateResult {
  ok: boolean;
  n: number;
  /** Sizes of each loop in block order (empty until ok). */
  sizes: number[];
  errors: string[];
  warnings: string[];
  notes: string[];
  /** Signed-up users whose row vanished from the sheet → removal/restore flow. */
  missing: Array<{ userId: string; name: string }>;
}

export interface GroupParse {
  ok: boolean;
  /** Per row: group normalized to 1..G in order of first appearance. */
  normalized: number[];
  errors: string[];
  renumbered: boolean;
}

/**
 * Parse raw Group cells (§5.4 step 2): blank counts as 1; otherwise the cell
 * must be a positive integer — anything else fails naming the offending rows.
 * Distinct values are normalized to 1..G in order of first appearance.
 */
export function parseGroupCells(cells: Array<{ raw: string; sheetRow: number }>): GroupParse {
  const errors: string[] = [];
  const rawGroups: number[] = [];
  for (const { raw, sheetRow } of cells) {
    const t = raw.trim();
    if (t === '') {
      rawGroups.push(1);
      continue;
    }
    if (!/^\d+$/.test(t) || parseInt(t, 10) < 1) {
      errors.push(`Row ${sheetRow}: Group must be a positive integer, got \`${t}\`.`);
      rawGroups.push(1);
      continue;
    }
    rawGroups.push(parseInt(t, 10));
  }
  const remap = new Map<number, number>();
  for (const g of rawGroups) {
    if (!remap.has(g)) remap.set(g, remap.size + 1);
  }
  const normalized = rawGroups.map((g) => remap.get(g)!);
  const renumbered = [...remap.entries()].some(([orig, norm]) => orig !== norm);
  return { ok: errors.length === 0, normalized, errors, renumbered };
}

export async function runValidate(
  env: Env, guild: GuildRow, event: EventRow, items: FormItem[],
): Promise<ValidateResult> {
  const signups = await orderedSignups(env, event.event_id);
  const byId = new Map(signups.map((s) => [s.user_id, s]));
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const missing: Array<{ userId: string; name: string }> = [];

  const rows = await readSheetRows(env, guild, event, items);
  const groupColIdx = layoutOf(items).groupCol - 1;
  const seen = new Set<string>();
  const valid: Array<{ signup: SignupRow; sheetRow: number; groupRaw: string }> = [];

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
    valid.push({ signup, sheetRow: rowNo, groupRaw: (row[groupColIdx] ?? '').toString() });
  }

  for (const s of signups) {
    if (!seen.has(s.user_id)) missing.push({ userId: s.user_id, name: s.display_name });
  }
  for (const m of missing) {
    errors.push(`**${m.name}** (<@${m.userId}>) signed up but has no sheet row — confirm their removal or restore the row.`);
  }

  // Group column (§5.4 steps 2–3).
  const parse = parseGroupCells(valid.map((v) => ({ raw: v.groupRaw, sheetRow: v.sheetRow })));
  errors.push(...parse.errors);

  const n = valid.length;
  if (errors.length === 0 && n < 2) errors.push(`Need at least 2 participants to run an exchange (currently ${n}).`);

  let sizes: number[] = [];
  if (errors.length === 0) {
    const members = new Map<number, Array<{ signup: SignupRow; sheetRow: number }>>();
    valid.forEach((v, i) => {
      const g = parse.normalized[i]!;
      const list = members.get(g);
      if (list) list.push(v);
      else members.set(g, [v]);
    });
    for (const [g, list] of members) {
      if (list.length === 1) {
        errors.push(`Group ${g} has only **1** member (**${list[0]!.signup.display_name}**) — a one-person loop is a self-assignment. Move them to another group or remove them.`);
      } else if (list.length === 2) {
        warnings.push(`Group ${g} is a **mutual pair** (${list[0]!.signup.display_name} ↔ ${list[1]!.signup.display_name}) — each is the other's santa *and* recipient. Fine if intended.`);
      }
    }
    sizes = [...members.keys()].sort((a, b) => a - b).map((g) => members.get(g)!.length);
  }
  if (parse.ok && parse.renumbered) {
    notes.push(`Group numbers were normalized to 1..${new Set(parse.normalized).size} in order of first appearance.`);
  }

  if (errors.length > 0) return { ok: false, n, sizes: [], errors, warnings, notes, missing };

  // Normalize (§5.4 step 4): stable-sort into contiguous group blocks —
  // within-group relative order preserved, blocks in normalized group order.
  const buckets = new Map<number, SignupRow[]>();
  valid.forEach((v, i) => {
    const g = parse.normalized[i]!;
    const list = buckets.get(g);
    if (list) list.push(v.signup);
    else buckets.set(g, [v.signup]);
  });
  const canonical: Array<{ signup: SignupRow; group: number }> = [];
  for (const g of [...buckets.keys()].sort((a, b) => a - b)) {
    for (const signup of buckets.get(g)!) canonical.push({ signup, group: g });
  }

  const stmts = canonical.map(({ signup, group }, i) =>
    env.DB.prepare('UPDATE signups SET row_order = ?1, group_no = ?2, updated_at = ?3 WHERE signup_id = ?4')
      .bind(i, group, now(), signup.signup_id),
  );
  stmts.push(
    env.DB.prepare('UPDATE events SET validated_at = ?1, updated_at = ?1 WHERE event_id = ?2')
      .bind(now(), event.event_id),
  );
  await dbBatchChunked(env, stmts);

  // Rewrite the sheet in canonical order; Santa/Given recompute per group
  // (next-row-within-block is an invariant by construction — decision #7).
  const fresh = canonical.map(({ signup, group }, i) => ({ ...signup, row_order: i, group_no: group }));
  await rewriteSheet(env, guild, event, items, fresh);

  return { ok: true, n, sizes, errors, warnings, notes, missing };
}

/**
 * Adopt the current loop order + membership as row_order 0..n-1 (stable by
 * group block) and rewrite the sheet. Sheet write is best-effort — Validate
 * reconciles later; used by Stop Sign-Ups and the auto-stop cron (§4), where
 * everyone starts in group 1.
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
  const extras = [
    ...r.notes.map((x) => `ℹ ${x}`),
    ...r.warnings.map((w) => `⚠ ${w}`),
  ];
  if (r.ok) {
    const loops = r.sizes.length <= 1
      ? 'single loop · Santa column = next-row rule ✔'
      : `${loopsPhrase(r.sizes)} · Santa = next row within each group ✔`;
    return [`✅ **${r.n}** participants · ${loops}`, ...extras].join('\n');
  }
  return [`❌ Validation failed:`, ...r.errors.map((e) => `• ${e}`), ...extras].join('\n');
}
