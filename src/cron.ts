// Single minute cron (spec §10.3). One schedule; the handler gates by clock
// and each tick performs at most ONE category of fan-out work so the
// per-invocation CPU/subrequest budget always holds (§2.4).

import type { Cfg, Env, EventRow, GuildRow, RecoRow, SignupRow } from './types';
import { btn, createDm, DiscordApiError, linkBtn, postMessage, row, Style } from './discord';
import {
  activeRecos, getItems, loadRecos, orderedSignups, pendingRecos, recosOf, transition,
  type RecoMap,
} from './db';
import { drainJobs } from './jobs';
import { repaintPanels } from './panels';
import { adoptSignupOrder } from './validate';
import { buildLoops, now, truncate, ts, type LoopMap } from './util';

export async function cronTick(env: Env, cfg: Cfg, scheduledTimeMs: number): Promise<void> {
  const minute = new Date(scheduledTimeMs).getUTCMinutes();

  // Cheap always-on checks; per-guild failures stay isolated.
  await repaintDirtyPanels(env, cfg).catch((e) => console.error('dirty panels', e));
  if (minute % 15 === 0) {
    await deadlineChecks(env, cfg).catch((e) => console.error('deadline checks', e));
  }
  if (minute % 30 === 0) {
    // Wrote-detection every 30 min; 🔄 Refresh clicks enqueue on demand.
    await enqueuePeriodicSyncs(env).catch((e) => console.error('sync enqueue', e));
  }

  // Fan-out: due reminder messages first (time-sensitive), else one job batch.
  let sent = 0;
  try {
    sent = await deliverReminders(env, cfg);
  } catch (e) {
    console.error('reminder delivery', e);
  }
  if (sent === 0) {
    await drainJobs(env, cfg).catch((e) => console.error('job drain', e));
  }
}

// -------------------------------------------- throttled signup-count panels

async function repaintDirtyPanels(env: Env, cfg: Cfg): Promise<void> {
  const dirty = await env.DB.prepare(
    'SELECT event_id, guild_id FROM events WHERE panel_dirty = 1 AND count_panel_at <= ?1 LIMIT 5',
  ).bind(now() - 60).all<{ event_id: number; guild_id: string }>();
  for (const e of dirty.results) {
    await env.DB.prepare('UPDATE events SET panel_dirty = 0, count_panel_at = ?1 WHERE event_id = ?2')
      .bind(now(), e.event_id).run();
    await repaintPanels(env, cfg, e.guild_id).catch((err) => console.error('dirty repaint', err));
  }
}

// ------------------------------------------------- deadline banner/auto-stop

async function deadlineChecks(env: Env, cfg: Cfg): Promise<void> {
  const t = now();

  // Banner flip (§6.1): deadline passed with auto-stop off.
  const toFlip = await env.DB.prepare(
    "SELECT * FROM events WHERE state = 'SIGNUP_OPEN' AND auto_stop = 0 AND signup_banner_flipped = 0 AND signup_deadline IS NOT NULL AND signup_deadline <= ?1",
  ).bind(t).all<EventRow>();
  for (const e of toFlip.results) {
    await env.DB.prepare('UPDATE events SET signup_banner_flipped = 1, updated_at = ?1 WHERE event_id = ?2')
      .bind(t, e.event_id).run();
    await repaintPanels(env, cfg, e.guild_id).catch((err) => console.error('banner repaint', err));
  }

  // Recommendation deadline (v3.4/v5): the banner always flips; with auto-stop
  // ON the phase also closes itself — every ⏳ pending pick locks in, exactly
  // what Launch would have done. Launching itself stays a manager action.
  const recoFlip = await env.DB.prepare(
    "SELECT * FROM events WHERE state = 'RECOMMENDING' AND reco_banner_flipped = 0 AND reco_deadline IS NOT NULL AND reco_deadline <= ?1",
  ).bind(t).all<EventRow>();
  for (const e of recoFlip.results) {
    await env.DB.prepare('UPDATE events SET reco_banner_flipped = 1, updated_at = ?1 WHERE event_id = ?2')
      .bind(t, e.event_id).run();
    if (e.auto_stop) {
      await env.DB.prepare(
        "UPDATE recos SET status = 'FINAL', final_via = 'FORCED', updated_at = ?1 WHERE event_id = ?2 AND status = 'PENDING'",
      ).bind(t, e.event_id).run();
    }
    await repaintPanels(env, cfg, e.guild_id).catch((err) => console.error('reco banner repaint', err));
  }

  // Auto-stop (§4): the only deadline-driven transition, and it's cron-driven.
  const toStop = await env.DB.prepare(
    "SELECT * FROM events WHERE state = 'SIGNUP_OPEN' AND auto_stop = 1 AND signup_deadline IS NOT NULL AND signup_deadline <= ?1",
  ).bind(t).all<EventRow>();
  for (const e of toStop.results) {
    try {
      if (!(await transition(env, e.event_id, 'SIGNUP_OPEN', 'MATCHING'))) continue;
      const guild = await env.DB.prepare('SELECT * FROM guilds WHERE guild_id = ?1')
        .bind(e.guild_id).first<GuildRow>();
      if (guild) {
        const items = await getItems(env, e.event_id);
        await adoptSignupOrder(env, guild, e, items);
      }
      await repaintPanels(env, cfg, e.guild_id);
    } catch (err) {
      console.error(`auto-stop failed for event ${e.event_id}`, err);
    }
  }

  // Review deadline (v7): with auto-stop ON, RUNNING closes itself — same as
  // pressing 🏁 Close Reviews, gallery included. The close job flips every doc
  // read-only before it posts a single reveal, so nothing leaks early.
  const toClose = await env.DB.prepare(
    "SELECT * FROM events WHERE state = 'RUNNING' AND auto_stop = 1 AND review_deadline IS NOT NULL AND review_deadline <= ?1",
  ).bind(t).all<EventRow>();
  for (const e of toClose.results) {
    try {
      if (!(await transition(env, e.event_id, 'RUNNING', 'CLOSING'))) continue;
      await env.DB.prepare(
        "INSERT INTO jobs (event_id, kind, payload_json, created_at) VALUES (?1, 'close', ?2, ?3)",
      ).bind(e.event_id, JSON.stringify({ gallery: true }), t).run().catch(() => {});
      await repaintPanels(env, cfg, e.guild_id);
    } catch (err) {
      console.error(`auto-close failed for event ${e.event_id}`, err);
    }
  }
}

// ----------------------------------------------------- periodic sync enqueue

async function enqueuePeriodicSyncs(env: Env): Promise<void> {
  const running = await env.DB.prepare("SELECT event_id FROM events WHERE state = 'RUNNING'")
    .all<{ event_id: number }>();
  for (const ev of running.results) {
    try {
      await env.DB.prepare("INSERT INTO jobs (event_id, kind, created_at) VALUES (?1, 'sync', ?2)")
        .bind(ev.event_id, now()).run();
    } catch (err) {
      // Expected: the partial unique index rejecting a second active sync
      // (§7.4). Anything else is a real fault and must not look identical to
      // it, or the 30-minute wrote-detection would stop with no trace.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE|constraint/i.test(msg)) {
        console.error(`periodic sync enqueue failed for event ${ev.event_id}`, err);
      }
    }
  }
}

// --------------------------------------------------------- reminder delivery

interface DueReminder {
  id: number;
  event_id: number;
  user_id: string;
  kind: 'review' | 'manual';
  due_at: number;
  guild_id: string;
  state: 'RECOMMENDING' | 'RUNNING';
  review_deadline: number | null;
  reco_deadline: number | null;
  dm_mirror: number;
  max_declines: number;
  thread_id: string | null;
  dm_channel_id: string | null;
  signup_id: number;
  row_order: number | null;
  wrote: number;
  declines_used: number;
}

/**
 * Deliver due reminders, at most REMINDERS_PER_TICK *messages* per tick — a
 * thread post and its DM mirror each count (§10.2). Returns messages sent
 * (>0 suppresses job draining this tick, §10.3 priority order).
 *
 * Two flavors by event state: RUNNING nudges review laggards; RECOMMENDING
 * nudges Santas who still owe a pick and giftees sitting on a pending pick.
 */
async function deliverReminders(env: Env, cfg: Cfg): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT r.id, r.event_id, r.user_id, r.kind, r.due_at,
            e.guild_id, e.state, e.review_deadline, e.reco_deadline, e.dm_mirror, e.max_declines,
            s.thread_id, s.dm_channel_id, s.signup_id, s.row_order, s.wrote,
            s.declines_used
     FROM reminders r
     JOIN events e ON e.event_id = r.event_id AND e.state IN ('RECOMMENDING', 'RUNNING')
     JOIN signups s ON s.event_id = r.event_id AND s.user_id = r.user_id
     WHERE r.sent_at IS NULL AND r.due_at <= ?1
     ORDER BY r.id LIMIT ?2`,
  ).bind(now(), cfg.remindersPerTick).all<DueReminder>();
  if (due.results.length === 0) return 0;

  // Both flavors need the recommendation slots (which picks are owed, which
  // anime to name); RECOMMENDING also needs each user's giftee (previous row
  // in the loop). Load once per event in this batch.
  const orders = new Map<number, { all: SignupRow[]; loops: LoopMap; recos: RecoMap }>();
  for (const r of due.results) {
    if (!orders.has(r.event_id)) {
      const all = await orderedSignups(env, r.event_id);
      orders.set(r.event_id, {
        all,
        loops: buildLoops(all.map((s) => s.group_no)),
        recos: await loadRecos(env, r.event_id),
      });
    }
  }

  let spent = 0;
  const done: number[] = [];
  const dmSaves: Array<{ signup_id: number; dm: string }> = [];

  for (const r of due.results) {
    const mirror = !!r.dm_mirror && r.state === 'RUNNING';
    const cost = 1 + (mirror ? (r.dm_channel_id ? 1 : 2) : 0);
    if (spent + cost > cfg.remindersPerTick && spent > 0) break;

    let text: string;
    let deadlineLine = '';
    let components: unknown[] = [];

    const ctx = orders.get(r.event_id)!;
    const myRecos: RecoRow[] = recosOf(ctx.recos, r.signup_id);

    if (r.state === 'RECOMMENDING') {
      const idx = ctx.all.findIndex((s) => s.signup_id === r.signup_id);
      const giftee = idx >= 0 ? ctx.all[ctx.loops.recipient[idx]!] : undefined;
      // A Santa owes something only while their giftee has nothing accepted
      // and room for more (picks are a maximum, not a quota).
      const gifteeRecos = giftee && giftee.signup_id !== r.signup_id
        ? recosOf(ctx.recos, giftee.signup_id) : [];
      const owes = !!giftee && activeRecos(gifteeRecos).length === 0;
      const pending = pendingRecos(myRecos);
      if (!owes && pending.length === 0) {
        done.push(r.id); // resolved since the nudge was queued — skip silently
        continue;
      }
      const parts: string[] = [];
      const buttons: unknown[] = [];
      if (owes) {
        parts.push(`🎯 **${giftee!.display_name}** is still waiting for a recommendation from you.`);
        buttons.push(btn(`ax:reco:${r.user_id}`, '🎯 Recommend an anime', Style.PRIMARY));
      }
      if (pending.length > 0) {
        const canDecline = r.declines_used < r.max_declines;
        const titles = pending.map((x) => `**${x.title}**`).join(', ');
        parts.push(`🎁 ${titles} ${pending.length > 1 ? 'are' : 'is'} waiting for your reply — **Thank you!😊** accepts${canDecline ? ', **Sorry😞** sends back' : ''}.`);
        const first = pending[0]!;
        buttons.push(btn(`ax:reco_ok:${r.user_id}:${first.reco_id}`, 'Thank you!😊', Style.SUCCESS));
        if (canDecline) buttons.push(btn(`ax:reco_no:${r.user_id}:${first.reco_id}`, 'Sorry😞', Style.DANGER));
      }
      text = `📣 A nudge from your event manager:\n${parts.join('\n')}`;
      if (r.reco_deadline) {
        deadlineLine = `\nDeadline: ${ts(r.reco_deadline)} (${ts(r.reco_deadline, 'R')})`;
      }
      components = [row(...buttons)];
    } else {
      // RUNNING: manual nudges target laggards; if they started since the
      // click, skip silently.
      if (r.kind === 'manual' && r.wrote) {
        done.push(r.id);
        continue;
      }
      const live = activeRecos(myRecos);
      const titles = live.map((x: RecoRow) => x.title ?? '?');
      const anime = titles.length ? titles.join(', ') : 'your assigned anime';
      const deadline = r.review_deadline ?? r.due_at;
      const daysLeft = Math.max(1, Math.round((deadline - r.due_at) / 86400));
      text = r.kind === 'manual'
        ? `📣 A nudge from your event manager — **${anime}** is still waiting for your review!`
        : r.wrote
          ? `⏰ **${daysLeft} day(s) left** — don't forget to finish your review of **${anime}**.`
          : `⏰ **${daysLeft} day(s) left** for **${anime}** — your review doc is still empty.`;
      deadlineLine = `\nDeadline: ${ts(deadline)} (${ts(deadline, 'R')})`;
      // One doc per anime (v6) — one button each, named when there are several.
      const docs = live.filter((x) => x.doc_url);
      components = docs.length
        ? [row(...docs.map((x) => linkBtn(
            x.doc_url!,
            docs.length === 1 ? '📝 Open your doc' : `📝 Review: ${truncate(x.title ?? 'your anime', 55)}`,
          )))]
        : [];
    }

    const payload = { content: `<@${r.user_id}> ${text}${deadlineLine}`, components };

    // `sent_at` is a delivery marker, so only stamp it when something actually
    // went out. Stamping unconditionally silently swallowed every reminder for
    // a participant whose thread was missing or deleted — and during
    // RECOMMENDING the DM mirror is off, so there was no fallback either.
    let delivered = false;
    let permanent = false;
    if (r.thread_id) {
      // Posting auto-unarchives the thread, so reminders outlive the 7-day archive (§3.3).
      try {
        await postMessage(env, r.thread_id, payload);
        delivered = true;
      } catch (e) {
        // 404/403 = the thread is gone or closed to us; retrying never helps.
        permanent = e instanceof DiscordApiError && (e.status === 404 || e.status === 403);
        console.error(`reminder thread post ${r.id} failed (${permanent ? 'permanent' : 'transient'})`, e);
      }
      spent += 1;
    } else {
      permanent = true;
      console.error(`reminder ${r.id}: participant ${r.user_id} has no thread — cannot deliver`);
    }
    if (mirror) {
      // Best-effort mirror (§10.2, RUNNING only — reco buttons need guild
      // context, and the mirror is frozen at Launch anyway): closed DMs ignored.
      try {
        let dm = r.dm_channel_id;
        if (!dm) {
          dm = (await createDm(env, r.user_id)).id;
          dmSaves.push({ signup_id: r.signup_id, dm });
          spent += 1;
        }
        await postMessage(env, dm, { content: `${text}${deadlineLine}`, components });
        spent += 1;
        delivered = true;
      } catch {
        /* ignored */
      }
    }
    // Transient failures stay queued for the next tick; permanent ones are
    // retired so they cannot block the head of the queue forever.
    if (delivered || permanent) done.push(r.id);
  }

  if (done.length || dmSaves.length) {
    await env.DB.batch([
      ...done.map((id) =>
        env.DB.prepare('UPDATE reminders SET sent_at = ?1 WHERE id = ?2 AND sent_at IS NULL').bind(now(), id)),
      ...dmSaves.map((d) =>
        env.DB.prepare('UPDATE signups SET dm_channel_id = ?1 WHERE signup_id = ?2').bind(d.dm, d.signup_id)),
    ]);
  }
  return spent;
}
