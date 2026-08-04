// Single minute cron (spec §10.3). One schedule; the handler gates by clock
// and each tick performs at most ONE category of fan-out work so the
// per-invocation CPU/subrequest budget always holds (§2.4).

import type { Cfg, Env, EventRow, GuildRow } from './types';
import { createDm, linkBtn, postMessage, row } from './discord';
import { getItems, orderedSignups, transition } from './db';
import { drainJobs } from './jobs';
import { repaintPanels } from './panels';
import { adoptSignupOrder } from './validate';
import { buildLoops, now, ts, type LoopMap } from './util';

export async function cronTick(env: Env, cfg: Cfg, scheduledTimeMs: number): Promise<void> {
  const minute = new Date(scheduledTimeMs).getUTCMinutes();

  // Cheap always-on checks; per-guild failures stay isolated.
  await repaintDirtyPanels(env, cfg).catch((e) => console.error('dirty panels', e));
  if (minute % 15 === 0) {
    await deadlineChecks(env, cfg).catch((e) => console.error('deadline checks', e));
    // Wrote-detection cadence: every 15 min (spec §10.3 said hourly, but the
    // manual Refresh Status button was removed, so the background sync is the
    // only trigger now). The partial unique index keeps runs from overlapping.
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
}

// ----------------------------------------------------- periodic sync enqueue

async function enqueuePeriodicSyncs(env: Env): Promise<void> {
  const running = await env.DB.prepare("SELECT event_id FROM events WHERE state = 'RUNNING'")
    .all<{ event_id: number }>();
  for (const e of running.results) {
    try {
      await env.DB.prepare("INSERT INTO jobs (event_id, kind, created_at) VALUES (?1, 'sync', ?2)")
        .bind(e.event_id, now()).run();
    } catch {
      // active sync already queued — the partial unique index said no (§7.4)
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
  review_deadline: number;
  dm_mirror: number;
  thread_id: string | null;
  dm_channel_id: string | null;
  signup_id: number;
  row_order: number | null;
  wrote: number;
}

/**
 * Deliver due reminders, at most REMINDERS_PER_TICK *messages* per tick — a
 * thread post and its DM mirror each count (§10.2). Returns messages sent
 * (>0 suppresses job draining this tick, §10.3 priority order).
 */
async function deliverReminders(env: Env, cfg: Cfg): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT r.id, r.event_id, r.user_id, r.kind, r.due_at,
            e.guild_id, e.review_deadline, e.dm_mirror,
            s.thread_id, s.dm_channel_id, s.signup_id, s.row_order, s.wrote
     FROM reminders r
     JOIN events e ON e.event_id = r.event_id AND e.state = 'RUNNING'
     JOIN signups s ON s.event_id = r.event_id AND s.user_id = r.user_id
     WHERE r.sent_at IS NULL AND r.due_at <= ?1
     ORDER BY r.id LIMIT ?2`,
  ).bind(now(), cfg.remindersPerTick).all<DueReminder>();
  if (due.results.length === 0) return 0;

  // Given anime per participant = their santa's recommendation → needs the
  // loop structure (per-group next row); load once per event.
  const orders = new Map<number, { all: Awaited<ReturnType<typeof orderedSignups>>; loops: LoopMap }>();
  for (const r of due.results) {
    if (!orders.has(r.event_id)) {
      const all = await orderedSignups(env, r.event_id);
      orders.set(r.event_id, { all, loops: buildLoops(all.map((s) => s.group_no)) });
    }
  }

  let spent = 0;
  const done: number[] = [];
  const dmSaves: Array<{ signup_id: number; dm: string }> = [];

  for (const r of due.results) {
    const cost = 1 + (r.dm_mirror ? (r.dm_channel_id ? 1 : 2) : 0);
    if (spent + cost > cfg.remindersPerTick && spent > 0) break;

    // Manual nudges target laggards; if they started since the click, skip silently.
    if (r.kind === 'manual' && r.wrote) {
      done.push(r.id);
      continue;
    }

    const { all, loops } = orders.get(r.event_id)!;
    const idx = all.findIndex((s) => s.signup_id === r.signup_id);
    const santaIdx = idx >= 0 ? loops.santa[idx]! : -1;
    const santa = santaIdx >= 0 && santaIdx !== idx ? all[santaIdx] : undefined;
    const anime = santa?.anime_title ?? 'your assigned anime';
    const me = idx >= 0 ? all[idx] : undefined;
    const daysLeft = Math.max(1, Math.round((r.review_deadline - r.due_at) / 86400));

    const text = r.kind === 'manual'
      ? `📣 A nudge from your event manager — **${anime}** is still waiting for your review!`
      : r.wrote
        ? `⏰ **${daysLeft} day(s) left** — don't forget to finish your review of **${anime}**.`
        : `⏰ **${daysLeft} day(s) left** for **${anime}** — your review doc is still empty.`;
    const payload = {
      content: `<@${r.user_id}> ${text}\nDeadline: ${ts(r.review_deadline)} (${ts(r.review_deadline, 'R')})`,
      components: me?.doc_url ? [row(linkBtn(me.doc_url, '📝 Open your doc'))] : [],
    };

    if (r.thread_id) {
      // Posting auto-unarchives the thread, so reminders outlive the 7-day archive (§3.3).
      await postMessage(env, r.thread_id, payload).catch((e) => console.error(`reminder thread post ${r.id}`, e));
      spent += 1;
    }
    if (r.dm_mirror) {
      // Best-effort mirror (§10.2): closed DMs are ignored.
      try {
        let dm = r.dm_channel_id;
        if (!dm) {
          dm = (await createDm(env, r.user_id)).id;
          dmSaves.push({ signup_id: r.signup_id, dm });
          spent += 1;
        }
        await postMessage(env, dm, {
          content: `${text}\nDeadline: ${ts(r.review_deadline)} (${ts(r.review_deadline, 'R')})`,
          components: payload.components,
        });
        spent += 1;
      } catch {
        /* ignored */
      }
    }
    done.push(r.id);
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
