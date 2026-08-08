// Batched job engine (spec §7.4): every participant-scaling fan-out (prepare,
// launch, close, sync, finish) drains at most JOB_BATCH units per cron tick,
// with per-unit completion markers on the signups row — re-entry is trivially
// safe and a redeploy mid-job loses nothing. The dispatcher never gives up; it
// retries every tick and surfaces last_error on the panel after 5 failures.

import type { Cfg, Env, EventRow, GuildRow, JobRow, SignupRow } from './types';
import {
  addThreadMember, createPrivateThread, deleteChannel, DiscordApiError, embed, postMessage,
} from './discord';
import { getItems, orderedSignups, transition } from './db';
import { assignmentCard, revealCard, taskCard } from './cards';
import {
  createDoc, docUrl, driveExportText, driveFileMeta, driveFlipAnyoneToReader, driveShareAnyone,
  GoogleApiError, GoogleAuthError, writeDocTemplate,
} from './google';
import { repaintPanels, repostPanels } from './panels';
import { lengthCell, rewriteSheet, scoreCell, writeReviewLinks, writeStatusCells } from './sheet';
import { buildLoops, chunkLines, epochToZoned, now, truncate } from './util';

/** Convergence self-heal: one full sheet rewrite from D1, best-effort. Run at
 *  job completion so any drift (failed cell writes, layout changes, manual
 *  edits mid-run) corrects itself without manager action. */
async function healSheet(env: Env, guild: GuildRow, event: EventRow): Promise<void> {
  const items = await getItems(env, event.event_id);
  const all = await orderedSignups(env, event.event_id);
  await rewriteSheet(env, guild, event, items, all).catch((e) => {
    console.error('sheet self-heal failed (non-fatal)', e);
  });
}

// "Started writing" = at least this many chars beyond the template. The
// spec's extra `modifiedTime > createdTime + 60s` grace clause is deliberately
// NOT applied: template inflation is already neutralized by subtracting
// template_chars, and the clause permanently false-negatived anyone whose
// last edit fell within a minute of doc creation.
const WROTE_MIN_CHARS = 20;

// ------------------------------------------------------------- dispatcher

/**
 * Drain one JOB_BATCH of the most eligible active job (§10.3 step "else").
 * FIFO within an event (sync enqueued before close must finish first); across
 * events the least-recently-attempted eligible job wins, so one guild's
 * stalled job cannot starve another guild (§10.3 "per-guild errors isolated").
 */
export async function drainJobs(env: Env, cfg: Cfg): Promise<void> {
  const active = await env.DB
    .prepare('SELECT * FROM jobs WHERE done_at IS NULL ORDER BY id')
    .all<JobRow>();
  if (active.results.length === 0) return;

  const firstPerEvent = new Map<number, JobRow>();
  for (const j of active.results) {
    if (!firstPerEvent.has(j.event_id)) firstPerEvent.set(j.event_id, j);
  }
  const job = [...firstPerEvent.values()]
    .sort((a, b) => (a.attempted_at ?? 0) - (b.attempted_at ?? 0) || a.id - b.id)[0]!;

  const event = await env.DB.prepare('SELECT * FROM events WHERE event_id = ?1')
    .bind(job.event_id).first<EventRow>();
  if (!event) {
    await env.DB.prepare('UPDATE jobs SET done_at = ?1 WHERE id = ?2').bind(now(), job.id).run();
    return;
  }
  const guild = await env.DB.prepare('SELECT * FROM guilds WHERE guild_id = ?1')
    .bind(event.guild_id).first<GuildRow>();
  if (!guild) return;

  try {
    switch (job.kind) {
      case 'prepare': await prepareTick(env, cfg, guild, event, job); break;
      case 'launch': await launchTick(env, cfg, guild, event, job); break;
      case 'close': await closeTick(env, cfg, guild, event, job); break;
      case 'sync': await syncTick(env, cfg, guild, event, job); break;
      case 'finish': await finishTick(env, cfg, guild, event, job); break;
    }
    await env.DB.prepare('UPDATE jobs SET attempts = 0, last_error = NULL, attempted_at = ?1 WHERE id = ?2 AND done_at IS NULL')
      .bind(now(), job.id).run();
  } catch (e) {
    const msg = e instanceof GoogleAuthError
      ? 'Google disconnected — press Connect Google on the manager panel; the job resumes automatically.'
      : e instanceof Error ? e.message : String(e);
    console.error(`job ${job.id} (${job.kind}) tick failed:`, e);
    await env.DB.prepare('UPDATE jobs SET attempts = attempts + 1, last_error = ?1, attempted_at = ?2 WHERE id = ?3')
      .bind(truncate(msg, 500), now(), job.id).run();
    // Surface the stall on the panel once attempts cross the threshold (§5.4b).
    await repaintPanels(env, cfg, guild.guild_id).catch(() => {});
  }
}

function markDone(env: Env, job: JobRow): Promise<unknown> {
  return env.DB.prepare('UPDATE jobs SET done_at = ?1 WHERE id = ?2').bind(now(), job.id).run();
}

/** Create-or-reuse the participant's private thread and add them to it. */
async function ensureThread(env: Env, guild: GuildRow, s: SignupRow): Promise<string> {
  if (!s.thread_id) {
    const thread = await createPrivateThread(env, guild.participant_channel_id!, `🎁 ${s.display_name}`);
    s.thread_id = thread.id;
    await env.DB.prepare('UPDATE signups SET thread_id = ?1, updated_at = ?2 WHERE signup_id = ?3')
      .bind(thread.id, now(), s.signup_id).run();
  }
  await addThreadMember(env, s.thread_id, s.user_id).catch((e) => {
    // Member left the server → keep the row, the loop stays intact (§14).
    console.error(`thread member add failed for ${s.user_id}`, e);
  });
  return s.thread_id;
}

// ---------------------------------------------------------------- prepare
// MATCHING → PREPARING → RECOMMENDING. Per unit: create the private thread
// (threads now exist for the whole recommending phase, so approvals and
// declines can ping people) and post the Santa task card — who the
// participant recommends for, their list link, and the Recommend button.

async function prepareTick(env: Env, cfg: Cfg, guild: GuildRow, event: EventRow, job: JobRow): Promise<void> {
  const all = await orderedSignups(env, event.event_id);
  const loops = buildLoops(all.map((s) => s.group_no));
  const pending = all
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !s.reco_card_posted)
    .slice(0, cfg.jobBatch);

  if (pending.length === 0) {
    await transition(env, event.event_id, 'PREPARING', 'RECOMMENDING');
    await markDone(env, job);
    await repaintPanels(env, cfg, guild.guild_id);
    return;
  }

  const items = await getItems(env, event.event_id);
  const stmts: D1PreparedStatement[] = [];
  for (const { s, idx } of pending) {
    // giftee = the row this participant recommends for (previous row in the loop).
    const giftee = all[loops.recipient[idx]!]!;
    const threadId = await ensureThread(env, guild, s);
    await postMessage(env, threadId, taskCard(event, s, giftee, items));
    stmts.push(env.DB.prepare(
      'UPDATE signups SET reco_card_posted = 1, updated_at = ?1 WHERE signup_id = ?2',
    ).bind(now(), s.signup_id));
  }
  await env.DB.batch(stmts);

  const left = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND reco_card_posted = 0')
    .bind(event.event_id).first<{ n: number }>();
  if ((left?.n ?? 0) === 0) {
    await transition(env, event.event_id, 'PREPARING', 'RECOMMENDING');
    await markDone(env, job);
  }
  await repaintPanels(env, cfg, guild.guild_id); // PREPARING panel counts up
}

// ----------------------------------------------------------------- launch
// RECOMMENDING → LAUNCHING → RUNNING. Every pick is FINAL by now; per unit:
// review doc for the locked-in anime + assignment card in the existing thread.

async function launchTick(env: Env, cfg: Cfg, guild: GuildRow, event: EventRow, job: JobRow): Promise<void> {
  const all = await orderedSignups(env, event.event_id);
  const loops = buildLoops(all.map((s) => s.group_no));
  const pending = all
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !s.assignment_posted)
    .slice(0, cfg.jobBatch);

  if (pending.length === 0) {
    await transition(env, event.event_id, 'LAUNCHING', 'RUNNING');
    await markDone(env, job);
    await repaintPanels(env, cfg, guild.guild_id);
    return;
  }

  const items = await getItems(env, event.event_id);
  const deadlineText = epochToZoned(event.review_deadline ?? now(), event.tz ?? 'UTC');
  const linkWrites: Array<{ rowIndex: number; url: string }> = [];
  const finalStmts: D1PreparedStatement[] = [];

  for (const { s, idx } of pending) {
    const myGiftee = all[loops.recipient[idx]!]!;
    const anime = s.reco_title ?? 'their anime';

    // Docs sub-steps persist immediately after creation so a crash between
    // calls never duplicates a doc/thread on the next tick (§7.4).
    if (!s.doc_id) {
      const id = await createDoc(env, guild, `Review of ${anime} by ${s.display_name}`);
      s.doc_id = id;
      s.doc_url = docUrl(id);
      await env.DB.prepare('UPDATE signups SET doc_id = ?1, doc_url = ?2, updated_at = ?3 WHERE signup_id = ?4')
        .bind(id, s.doc_url, now(), s.signup_id).run();
      // "given to J(@j_handle)" — falls back to the display name alone for
      // rows signed up before the username column existed.
      const givenTo = s.username ? `${s.display_name}(@${s.username})` : s.display_name;
      await writeDocTemplate(env, guild, id, anime, givenTo, deadlineText);
      const template = await driveExportText(env, guild, id);
      s.template_chars = template.length;
    }
    if (!s.perm_id) {
      s.perm_id = await driveShareAnyone(env, guild, s.doc_id, 'writer'); // link-as-capability (§8.4)
      await env.DB.prepare('UPDATE signups SET perm_id = ?1, template_chars = ?2, updated_at = ?3 WHERE signup_id = ?4')
        .bind(s.perm_id, s.template_chars, now(), s.signup_id).run();
    }
    // Threads were created by the prepare job; ensure covers the rare case of
    // one being deleted mid-event.
    const threadId = await ensureThread(env, guild, s);
    await postMessage(env, threadId, assignmentCard(event, s, myGiftee));

    finalStmts.push(env.DB.prepare(
      'UPDATE signups SET assignment_posted = 1, updated_at = ?1 WHERE signup_id = ?2',
    ).bind(now(), s.signup_id));
    linkWrites.push({ rowIndex: idx, url: s.doc_url! });
  }

  await env.DB.batch(finalStmts);
  await writeReviewLinks(env, guild, event, items, linkWrites).catch((e) => {
    console.error('review link cells failed (non-fatal)', e);
  });

  const left = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND assignment_posted = 0')
    .bind(event.event_id).first<{ n: number }>();
  if ((left?.n ?? 0) === 0) {
    await transition(env, event.event_id, 'LAUNCHING', 'RUNNING');
    await markDone(env, job);
    await healSheet(env, guild, event); // review links + any drift, in one pass
  }
  await repaintPanels(env, cfg, guild.guild_id); // LAUNCHING panel counts up (§5.4b)
}

// ------------------------------------------------------------------ close

async function postGallery(env: Env, guild: GuildRow, event: EventRow, all: SignupRow[]): Promise<void> {
  // One section per loop (§6.4): "**Loop 1** (10)" then one line per member in
  // block order; single-group events get one untitled section.
  const loops = buildLoops(all.map((s) => s.group_no));
  const multi = loops.groups.size > 1;
  const lines: string[] = [];
  for (const [g, members] of loops.groups) {
    if (multi) lines.push(`**Loop ${g}** (${members.length})`);
    for (const i of members) {
      const s = all[i]!;
      const santa = all[loops.santa[i]!]!;
      // "J (@J) picked X for rabbit (@rabbit) — ⭐ 8 (read review)"
      const link = s.doc_url ? ` ([read review](${s.doc_url}))` : '';
      const verdict = s.score !== null ? ` — **⭐ ${s.score} stars**` : '';
      lines.push(
        `🎁 **${santa.display_name}** (<@${santa.user_id}>) picked **${s.reco_title ?? '?'}** for ` +
        `**${s.display_name}** (<@${s.user_id}>)${verdict}${link}`,
      );
    }
  }
  // ≤10 lines per embed, ≤10 embeds per message (§6.4), and ≤6000 total embed
  // chars per message; mentions inside embeds don't ping.
  const chunks = chunkLines(lines, 3900, 10);
  let batch: string[] = [];
  let used = 0;
  let first = true;
  const flush = async () => {
    if (!batch.length) return;
    await postMessage(env, guild.participant_channel_id!, {
      content: first ? `🎉 **${event.topic}** — the full loop, revealed:` : '',
      embeds: batch.map((d) => embed({ description: d })),
    });
    first = false;
    batch = [];
    used = 0;
  };
  for (const d of chunks) {
    if (batch.length >= 10 || used + d.length > 5500) await flush();
    batch.push(d);
    used += d.length;
  }
  await flush();
}

async function closeTick(env: Env, cfg: Cfg, guild: GuildRow, event: EventRow, job: JobRow): Promise<void> {
  const all = await orderedSignups(env, event.event_id);
  const n = all.length;
  const loops = buildLoops(all.map((s) => s.group_no));
  const payload = JSON.parse(job.payload_json || '{}') as { gallery?: boolean };

  // Phase 1 — ALL docs flip read-only before ANY reveal link is posted (§7.6,
  // M6: reveal cards link the *giftee's* doc, so per-unit interleaving
  // would leak an editable doc).
  const toFlip = all.filter((s) => !s.doc_readonly).slice(0, cfg.jobBatch);
  if (toFlip.length > 0) {
    const stmts: D1PreparedStatement[] = [];
    for (const s of toFlip) {
      if (s.doc_id && !s.doc_missing) {
        try {
          await driveFlipAnyoneToReader(env, guild, s.doc_id, s.perm_id);
        } catch (e) {
          if (e instanceof GoogleApiError && e.status === 404) {
            stmts.push(env.DB.prepare('UPDATE signups SET doc_missing = 1 WHERE signup_id = ?1').bind(s.signup_id));
          } else {
            throw e; // auth/5xx: retry next tick, panel surfaces after 5 fails
          }
        }
      }
      stmts.push(env.DB.prepare('UPDATE signups SET doc_readonly = 1, updated_at = ?1 WHERE signup_id = ?2')
        .bind(now(), s.signup_id));
    }
    await env.DB.batch(stmts);
    await repaintPanels(env, cfg, guild.guild_id);
    return;
  }

  // Phase 2 — reveal cards.
  const toReveal = all
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !s.reveal_posted)
    .slice(0, cfg.jobBatch);
  if (toReveal.length > 0) {
    const stmts: D1PreparedStatement[] = [];
    for (const { s, idx } of toReveal) {
      const santa = all[loops.santa[idx]!]!;
      const myGiftee = all[loops.recipient[idx]!]!;
      if (s.thread_id) {
        await postMessage(env, s.thread_id, revealCard(s, santa, myGiftee)).catch((e) => {
          if (!(e instanceof DiscordApiError && (e.status === 404 || e.status === 403))) throw e;
          console.error(`reveal post failed for ${s.user_id} (thread gone)`, e);
        });
      }
      stmts.push(env.DB.prepare('UPDATE signups SET reveal_posted = 1, updated_at = ?1 WHERE signup_id = ?2')
        .bind(now(), s.signup_id));
    }
    await env.DB.batch(stmts);
    await repaintPanels(env, cfg, guild.guild_id);
    return;
  }

  // Final unit — optional gallery, then complete (§7.6).
  if (payload.gallery && !event.gallery_posted && n > 0) {
    await postGallery(env, guild, event, all);
    await env.DB.prepare('UPDATE events SET gallery_posted = 1, updated_at = ?1 WHERE event_id = ?2')
      .bind(now(), event.event_id).run();
  }
  await transition(env, event.event_id, 'CLOSING', 'REVEALED');
  await markDone(env, job);
  await repaintPanels(env, cfg, guild.guild_id);
}

// ------------------------------------------------------------------- sync

async function syncTick(env: Env, cfg: Cfg, guild: GuildRow, event: EventRow, job: JobRow): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT * FROM signups WHERE event_id = ?1 AND doc_id IS NOT NULL
       AND (synced_at IS NULL OR synced_at < ?2) ORDER BY row_order LIMIT ?3`,
  ).bind(event.event_id, job.created_at, cfg.jobBatch).all<SignupRow>();

  if (pending.results.length === 0) {
    await markDone(env, job);
    await repaintPanels(env, cfg, guild.guild_id);
    return;
  }

  const items = await getItems(env, event.event_id);
  const stmts: D1PreparedStatement[] = [];
  const cells: Array<{ rowIndex: number; length: number | string; score: number | string }> = [];
  let wroteChanged = false;

  for (const s of pending.results) {
    let meta;
    try {
      meta = await driveFileMeta(env, guild, s.doc_id!);
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 404) {
        // Manager deleted the doc (§8.5): flag it, keep syncing others.
        stmts.push(env.DB.prepare(
          'UPDATE signups SET doc_missing = 1, wrote = 0, synced_at = ?1, updated_at = ?1 WHERE signup_id = ?2',
        ).bind(now(), s.signup_id));
        if (s.row_order !== null) {
          cells.push({ rowIndex: s.row_order, length: lengthCell({ ...s, doc_missing: 1 }), score: scoreCell(s) });
        }
        wroteChanged = wroteChanged || s.wrote === 1;
        continue;
      }
      throw e;
    }
    const mtime = meta.modifiedTime ? Math.floor(Date.parse(meta.modifiedTime) / 1000) : null;

    if (mtime !== null && s.last_edited === mtime && s.synced_at !== null) {
      // Cheap path: unchanged since last sync (§8.5 step 1). Still re-derive
      // wrote from the stored char_count so rows synced under the old
      // grace-clause formula heal without waiting for another doc edit.
      const wrote = s.char_count >= WROTE_MIN_CHARS ? 1 : 0;
      if (wrote !== s.wrote) wroteChanged = true;
      stmts.push(env.DB.prepare('UPDATE signups SET wrote = ?1, synced_at = ?2, doc_missing = 0 WHERE signup_id = ?3')
        .bind(wrote, now(), s.signup_id));
      continue;
    }

    const text = await driveExportText(env, guild, s.doc_id!);
    const chars = Math.max(0, text.length - s.template_chars);
    // wrote stays internal (drives reminders + the progress panel) even
    // though it no longer has a sheet column.
    const wrote = chars >= WROTE_MIN_CHARS ? 1 : 0;
    if (wrote !== s.wrote) wroteChanged = true;
    stmts.push(env.DB.prepare(
      'UPDATE signups SET last_edited = ?1, char_count = ?2, wrote = ?3, doc_missing = 0, synced_at = ?4, updated_at = ?4 WHERE signup_id = ?5',
    ).bind(mtime, chars, wrote, now(), s.signup_id));
    if (s.row_order !== null) {
      cells.push({
        rowIndex: s.row_order,
        length: lengthCell({ ...s, char_count: chars, doc_missing: 0 }),
        score: scoreCell(s),
      });
    }
  }

  await env.DB.batch(stmts);
  await writeStatusCells(env, guild, event, items, cells).catch((e) => {
    console.error('sync cells write failed (non-fatal)', e);
  });

  const left = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND doc_id IS NOT NULL AND (synced_at IS NULL OR synced_at < ?2)',
  ).bind(event.event_id, job.created_at).first<{ n: number }>();
  if ((left?.n ?? 0) === 0) {
    await markDone(env, job);
    await healSheet(env, guild, event); // periodic convergence for the whole sheet
  }
  if (wroteChanged || (left?.n ?? 0) === 0) {
    await repaintPanels(env, cfg, guild.guild_id); // progress fraction changed (§8.5)
  }
}

// ----------------------------------------------------------------- finish

async function finishTick(env: Env, cfg: Cfg, guild: GuildRow, event: EventRow, _job: JobRow): Promise<void> {
  const withThreads = await env.DB
    .prepare('SELECT signup_id, thread_id FROM signups WHERE event_id = ?1 AND thread_id IS NOT NULL LIMIT ?2')
    .bind(event.event_id, cfg.jobBatch).all<{ signup_id: number; thread_id: string }>();

  if (withThreads.results.length > 0) {
    for (const s of withThreads.results) {
      await deleteChannel(env, s.thread_id).catch((e) => {
        if (!(e instanceof DiscordApiError && e.status === 404)) throw e;
      });
      await env.DB.prepare('UPDATE signups SET thread_id = NULL WHERE signup_id = ?1').bind(s.signup_id).run();
    }
    await repaintPanels(env, cfg, guild.guild_id);
    return;
  }

  // All threads gone → wipe the event. Cascades take signups/items/jobs/
  // reminders (this job included); drafts have no FK, wipe explicitly.
  // Sheet and docs stay in the manager's Drive (§5.6). The IDLE panels are
  // re-POSTED (old ones deleted) so they land at the bottom of their channels.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM signup_drafts WHERE event_id = ?1').bind(event.event_id),
    env.DB.prepare('DELETE FROM events WHERE event_id = ?1').bind(event.event_id),
  ]);
  await repostPanels(env, cfg, guild.guild_id);
}
