// Thin typed D1 accessors. Handlers stay "verify → parse → 1–2 reads →
// respond" (spec §2.4 #4); anything heavier lives in jobs.

import type { Env, EventRow, EventState, FormItem, GuildRow, SignupRow } from './types';
import { buildLoops, now, type LoopMap } from './util';

export function getGuild(env: Env, guildId: string): Promise<GuildRow | null> {
  return env.DB.prepare('SELECT * FROM guilds WHERE guild_id = ?1').bind(guildId).first<GuildRow>();
}

export function getEventByGuild(env: Env, guildId: string): Promise<EventRow | null> {
  return env.DB.prepare('SELECT * FROM events WHERE guild_id = ?1').bind(guildId).first<EventRow>();
}

export async function getItems(env: Env, eventId: number): Promise<FormItem[]> {
  const res = await env.DB
    .prepare('SELECT * FROM form_items WHERE event_id = ?1 ORDER BY position')
    .bind(eventId).all<FormItem>();
  return res.results;
}

/** Loop order: adopted row_order first, signup chronology for the not-yet-ordered. */
export async function orderedSignups(env: Env, eventId: number): Promise<SignupRow[]> {
  const res = await env.DB
    .prepare('SELECT * FROM signups WHERE event_id = ?1 ORDER BY CASE WHEN row_order IS NULL THEN 1 ELSE 0 END, row_order, signup_id')
    .bind(eventId).all<SignupRow>();
  return res.results;
}

export function getSignup(env: Env, eventId: number, userId: string): Promise<SignupRow | null> {
  return env.DB.prepare('SELECT * FROM signups WHERE event_id = ?1 AND user_id = ?2')
    .bind(eventId, userId).first<SignupRow>();
}

export async function countSignups(env: Env, eventId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1')
    .bind(eventId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Conditional state transition (spec §4): zero rows updated ⇒ someone else
 * moved first — the caller replies "state changed, panel refreshed".
 */
export async function transition(
  env: Env, eventId: number, from: EventState, to: EventState,
): Promise<boolean> {
  const res = await env.DB
    .prepare('UPDATE events SET state = ?1, updated_at = ?2 WHERE event_id = ?3 AND state = ?4')
    .bind(to, now(), eventId, from).run();
  return (res.meta.changes ?? 0) > 0;
}

/** DB.batch in slices of 40 statements — keeps large per-participant write
 *  sets (reminder fan-outs, row_order adoption) well inside D1 batch limits. */
export async function dbBatchChunked(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 40) {
    await env.DB.batch(stmts.slice(i, i + 40));
  }
}

/**
 * Ordered rows + loop map + this-user resolution in one read — the shape every
 * RECOMMENDING interaction needs. santa[idx] recommends FOR idx; the row this
 * user recommends for is recipient[idx] (their "giftee").
 */
export async function loopContext(env: Env, eventId: number): Promise<{
  all: SignupRow[];
  loops: LoopMap;
  indexOfUser: (userId: string) => number;
}> {
  const all = await orderedSignups(env, eventId);
  const loops = buildLoops(all.map((s) => s.group_no));
  return { all, loops, indexOfUser: (userId) => all.findIndex((s) => s.user_id === userId) };
}

export function answersOf(s: { answers_json: string }): Record<string, string> {
  try {
    return JSON.parse(s.answers_json) as Record<string, string>;
  } catch {
    return {};
  }
}

export interface DeclinedEntry { mal_id: number; title: string }

/** Titles a giftee has already sent back — their Santa may not re-pick these. */
export function declinedOf(s: Pick<SignupRow, 'reco_declined_json'>): DeclinedEntry[] {
  try {
    const arr = JSON.parse(s.reco_declined_json) as DeclinedEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function optionsOf(item: FormItem): string[] {
  try {
    return item.options_json ? (JSON.parse(item.options_json) as string[]) : [];
  } catch {
    return [];
  }
}
