// RECOMMENDING-phase interactions (v3). Every Santa picks an anime for their
// giftee (the previous row in the loop) through the MAL wizard; the giftee
// answers Thank you!😊 (accepts — reversible until Launch via the red
// "No. I'll decline it.😞") or Sorry😞 (sends it back). Declining spends the
// events.max_declines budget; a spent budget only removes the decline
// buttons — nothing locks until Launch sweeps the still-pending picks.
//
// Buttons on thread cards carry the owner's user id (`ax:reco*:{uid}`) so a
// moderator clicking inside someone else's private thread is rejected instead
// of silently acting on their own row (§13.2). All writes are conditional on
// the current reco_status, so double-clicks and races produce a harmless
// ephemeral, never a duplicate side effect (§13.4).

import type { AnimeCandidate } from '../mal';
import { searchAnime } from '../mal';
import type { DraftRow, EventRow, SignupRow } from '../types';
import { modalFields } from '../types';
import { btn, editOriginal, embed, linkBtn, modalText, postMessage, respond, row, stringSelect, Style } from '../discord';
import { declinedOf, getItems, getSignup, loopContext } from '../db';
import { declineNotice, lockedNotice, recoCard } from '../cards';
import { writeRecoCells } from '../sheet';
import { now, truncate } from '../util';
import { bg, HCtx, repaint, stale, throttledCountRepaint } from './common';

const DRAFT_TTL = 30 * 60;

// ----------------------------------------------------------------- drafts
// The reco wizard shares signup_drafts (steps R_SEARCH/R_PICKED) — it can
// never overlap the signup wizard, which only runs during SIGNUP_OPEN.

async function loadDraft(c: HCtx, eventId: number): Promise<DraftRow | null> {
  const d = await c.env.DB
    .prepare("SELECT * FROM signup_drafts WHERE event_id = ?1 AND user_id = ?2 AND step IN ('R_SEARCH', 'R_PICKED')")
    .bind(eventId, c.userId).first<DraftRow>();
  if (!d) return null;
  if (d.expires_at < now()) {
    await c.env.DB.prepare('DELETE FROM signup_drafts WHERE event_id = ?1 AND user_id = ?2')
      .bind(eventId, c.userId).run();
    return null;
  }
  return d;
}

function saveDraft(c: HCtx, eventId: number, d: Partial<DraftRow> & { step: DraftRow['step'] }): Promise<unknown> {
  return c.env.DB.prepare(
    `INSERT OR REPLACE INTO signup_drafts
       (event_id, user_id, step, keyword, partial_answers_json, candidates_json, chosen_json, expires_at)
     VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6, ?7)`,
  ).bind(eventId, c.userId, d.step, d.keyword ?? null, d.candidates_json ?? null,
    d.chosen_json ?? null, now() + DRAFT_TTL).run();
}

function deleteDraft(c: HCtx, eventId: number): Promise<unknown> {
  return c.env.DB.prepare('DELETE FROM signup_drafts WHERE event_id = ?1 AND user_id = ?2')
    .bind(eventId, c.userId).run();
}

const parseJson = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

// ------------------------------------------------------------------ guards

interface RecoCtx {
  e: EventRow;
  me: SignupRow;
  /** The row this user recommends for (previous row in their loop). */
  giftee: SignupRow;
  /** The row that recommends for this user (next row in their loop). */
  santa: SignupRow;
}

/** Wrong-thread protection: `ax:reco*:{uid}` buttons act only for their owner. */
function ownedBy(c: HCtx, ownerArg: string): Response | null {
  if (ownerArg && ownerArg !== c.userId) {
    return respond.ephemeral({ content: `🔒 These buttons belong to <@${ownerArg}> — check your own thread, or press **🎯 My Status** on the panel.` });
  }
  return null;
}

async function recoCtxOf(c: HCtx): Promise<RecoCtx | Response> {
  const e = c.event;
  if (!e || e.state !== 'RECOMMENDING') {
    return stale(c, !e ? 'The recommendation phase is not running.'
      : e.state === 'PREPARING' ? 'Hold on — recommendation tasks are still being delivered.'
      : ['LAUNCHING', 'RUNNING', 'CLOSING', 'REVEALED'].includes(e.state)
        ? 'The exchange has launched — picks are locked in.'
        : 'The recommendation phase is not running.');
  }
  const { all, loops, indexOfUser } = await loopContext(c.env, e.event_id);
  const idx = indexOfUser(c.userId);
  if (idx < 0) return respond.ephemeral({ content: 'Only participants have a Santa mission.' });
  return { e, me: all[idx]!, giftee: all[loops.recipient[idx]!]!, santa: all[loops.santa[idx]!]! };
}

const animeLabel = (a: { title: string; year?: number | null }) =>
  `${a.title}${a.year ? ` (${a.year})` : ''}`;

// ------------------------------------------------------- recommend wizard

/** [🎯 Recommend an anime] → keyword modal (opened immediately, §13.1). */
export async function recoOpen(c: HCtx, ownerArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee } = ctx;
  if (giftee.reco_status === 'FINAL') {
    return respond.ephemeral({ content: `✅ **${giftee.display_name}** accepted your pick: **${giftee.reco_title}**.` });
  }
  if (giftee.reco_status === 'PENDING') {
    return respond.ephemeral({ content: `⏳ You already sent **${giftee.reco_title}** to **${giftee.display_name}** — waiting for their reply.` });
  }
  const draft = await loadDraft(c, e.event_id);
  return respond.modal('axm:reco_kw', `Pick for ${truncate(giftee.display_name, 25)}`, [
    modalText('kw', 'Anime title keyword (English or Japanese)', {
      value: draft?.keyword ?? '', max: 100, placeholder: 'e.g. Frieren / 葬送のフリーレン',
    }),
  ]);
}

/** Keyword modal submit → deferred → MAL search → picker (§13.1 row 3). */
export async function recoModalKw(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee } = ctx;
  const keyword = (modalFields(c.i.data?.components).get('kw') ?? '').trim();
  // Modal opened from a wizard ephemeral ([Search again]) → update it in
  // place; opened from a thread card / reminder (non-ephemeral) → NEW
  // ephemeral, never an edit of the shared card.
  const fromEphemeral = ((c.i.message?.flags ?? 0) & 64) !== 0;
  bg(c, async () => {
    if (!keyword) {
      await editOriginal(c.env, c.i.token, {
        content: '⚠ Enter an anime title keyword.',
        components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
      });
      return;
    }
    let candidates: AnimeCandidate[] = [];
    let searchFailed = false;
    try {
      candidates = await searchAnime(c.env, c.cfg, keyword);
    } catch (err) {
      console.error('MAL search failed', err);
      searchFailed = true;
    }
    await saveDraft(c, e.event_id, {
      step: 'R_SEARCH',
      keyword,
      candidates_json: JSON.stringify(candidates),
    });
    if (searchFailed) {
      await editOriginal(c.env, c.i.token, {
        content: '⚠ Try a different keyword — or try again in a minute.',
        embeds: [],
        components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
      });
      return;
    }
    if (candidates.length === 0) {
      await editOriginal(c.env, c.i.token, {
        content: `😶 No MAL matches for **${truncate(keyword, 80)}**. Try another spelling (English or Japanese both work).`,
        embeds: [],
        components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
      });
      return;
    }
    const declined = new Set(declinedOf(giftee).map((d) => d.mal_id));
    await editOriginal(c.env, c.i.token, {
      content: `🔎 Results for **${truncate(keyword, 80)}** — pick the anime for **${giftee.display_name}**:`,
      embeds: [],
      components: [
        row(stringSelect('ax:reco_pick', 'Pick an anime…', candidates.map((a, idx) => ({
          label: `${a.title} (${a.year ?? '?'} · ${a.type ?? '?'} · ${a.episodes ?? '?'} eps)`,
          value: String(idx),
          description: declined.has(a.mal_id)
            ? '⛔ they already declined this one'
            : a.title_en ?? a.title_jp ?? undefined,
        })))),
        row(btn('ax:reco_again', '🔍 Search again')),
      ],
    });
  });
  return fromEphemeral ? respond.deferUpdate() : respond.deferEphemeral();
}

/** Picker select → declined-check → confirm card with the Send button. */
export async function recoPick(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee } = ctx;
  const draft = await loadDraft(c, e.event_id);
  const candidates = parseJson<AnimeCandidate[]>(draft?.candidates_json ?? null, []);
  const chosen = candidates[Number(c.i.data?.values?.[0] ?? -1)];
  if (!draft || !chosen) {
    return respond.update({
      content: '⏳ This wizard expired — press **🎯 Recommend an anime** to start again.',
      embeds: [], components: [],
    });
  }
  if (declinedOf(giftee).some((d) => d.mal_id === chosen.mal_id)) {
    return respond.update({
      content: `⛔ **${giftee.display_name}** already declined **${chosen.title}** — pick something else.`,
      embeds: [],
      components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
    });
  }
  await saveDraft(c, e.event_id, { ...draft, step: 'R_PICKED', chosen_json: JSON.stringify(chosen) });
  const left = Math.max(0, e.max_declines - giftee.declines_used);
  return respond.update({
    content: `Send this pick to **${giftee.display_name}**?`,
    embeds: [embed({
      title: animeLabel(chosen),
      url: chosen.url,
      description: [
        chosen.title_en && chosen.title_en !== chosen.title ? chosen.title_en : null,
        `${chosen.type ?? '?'} · ${chosen.episodes ?? '?'} episodes · [MAL](${chosen.url})`,
        left > 0 ? `They can send it back **${left}** more time(s).` : null,
      ].filter(Boolean).join('\n'),
      thumbnail: chosen.image ?? undefined,
    })],
    components: [row(
      btn('ax:reco_send', `📨 Send to ${truncate(giftee.display_name, 60)}`, Style.SUCCESS),
      btn('ax:reco_again', '🔍 Search again'),
    )],
  });
}

/** [🔍 Search again] → keyword modal prefilled. */
export async function recoAgain(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const draft = await loadDraft(c, ctx.e.event_id);
  return respond.modal('axm:reco_kw', `Pick for ${truncate(ctx.giftee.display_name, 25)}`, [
    modalText('kw', 'Anime title keyword (English or Japanese)', {
      value: draft?.keyword ?? '', max: 100, placeholder: 'e.g. Frieren / 葬送のフリーレン',
    }),
  ]);
}

/** [📨 Send] → conditional write on the giftee's row → card in their thread. */
export async function recoSend(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee } = ctx;
  const draft = await loadDraft(c, e.event_id);
  const chosen = parseJson<AnimeCandidate | null>(draft?.chosen_json ?? null, null);
  if (!draft || !chosen) {
    return respond.update({ content: '⏳ This wizard expired — press **🎯 Recommend an anime** to start again.', embeds: [], components: [] });
  }
  if (declinedOf(giftee).some((d) => d.mal_id === chosen.mal_id)) {
    return respond.update({
      content: `⛔ **${giftee.display_name}** already declined **${chosen.title}** — pick something else.`,
      embeds: [],
      components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
    });
  }
  bg(c, async () => {
    const res = await c.env.DB.prepare(
      `UPDATE signups SET reco_mal_id = ?1, reco_title = ?2, reco_title_en = ?3, reco_year = ?4,
         reco_type = ?5, reco_episodes = ?6, reco_url = ?7, reco_image = ?8,
         reco_status = 'PENDING', reco_final_via = NULL, updated_at = ?9
       WHERE signup_id = ?10 AND reco_status = 'NONE'`,
    ).bind(
      chosen.mal_id, chosen.title, chosen.title_en, chosen.year, chosen.type, chosen.episodes,
      chosen.url, chosen.image, now(), giftee.signup_id,
    ).run();
    if ((res.meta.changes ?? 0) === 0) {
      await editOriginal(c.env, c.i.token, {
        content: `↻ **${giftee.display_name}** already has a pick ${giftee.reco_status === 'FINAL' ? 'accepted' : 'awaiting their reply'} — nothing sent.`,
        embeds: [], components: [],
      });
      return;
    }
    await deleteDraft(c, e.event_id);
    const fresh: SignupRow = {
      ...giftee,
      reco_mal_id: chosen.mal_id, reco_title: chosen.title, reco_title_en: chosen.title_en,
      reco_year: chosen.year, reco_type: chosen.type, reco_episodes: chosen.episodes,
      reco_url: chosen.url, reco_image: chosen.image,
      reco_status: 'PENDING', reco_final_via: null,
    };
    let deliveryNote = '';
    if (fresh.thread_id) {
      await postMessage(c.env, fresh.thread_id, recoCard(e, fresh)).catch((err) => {
        console.error('reco card post failed', err);
        deliveryNote = '\n⚠ Couldn\'t post to their thread — they can still respond via **🎯 My Status** on the panel.';
      });
    } else {
      deliveryNote = '\n⚠ They have no thread — they can respond via **🎯 My Status** on the panel.';
    }
    const items = await getItems(c.env, e.event_id);
    await writeRecoCells(c.env, c.guild, e, items, fresh).catch((err) => {
      console.error('reco cells write failed (heals at launch)', err);
    });
    await maybeMilestoneRepaint(c, e, 'send');
    await editOriginal(c.env, c.i.token, {
      content:
        `📨 Sent **${animeLabel(chosen)}** to **${giftee.display_name}**! ` +
        `You'll get a ping in your thread when they reply.` + deliveryNote,
      embeds: [], components: [],
    });
  });
  return respond.deferUpdate();
}

// ------------------------------------------------------- approve / decline

/** [Thank you!😊] — locks the pick on the clicker's own row. */
export async function recoApprove(c: HCtx, ownerArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, me, santa } = ctx;
  bg(c, async () => {
    const res = await c.env.DB.prepare(
      "UPDATE signups SET reco_status = 'FINAL', reco_final_via = 'APPROVED', updated_at = ?1 WHERE signup_id = ?2 AND reco_status = 'PENDING'",
    ).bind(now(), me.signup_id).run();
    if ((res.meta.changes ?? 0) === 0) {
      // Lost a race (double-click / force-finalize) — show the fresh truth.
      const current = await getSignup(c.env, e.event_id, c.userId);
      await editOriginal(c.env, c.i.token, statusPayload(e, current ?? me, ctx.giftee)).catch(() => {});
      return;
    }
    const fresh: SignupRow = { ...me, reco_status: 'FINAL', reco_final_via: 'APPROVED' };
    // The clicked message (thread card, reminder, or My Status ephemeral)
    // becomes the locked-in card.
    await editOriginal(c.env, c.i.token, { ...recoCard(e, fresh), content: '' }).catch(() => {});
    if (santa.signup_id !== me.signup_id && santa.thread_id) {
      await postMessage(c.env, santa.thread_id, lockedNotice(santa, fresh)).catch((err) => {
        console.error('locked notice post failed', err);
      });
    }
    const items = await getItems(c.env, e.event_id);
    await writeRecoCells(c.env, c.guild, e, items, fresh).catch(() => {});
    await maybeMilestoneRepaint(c, e, 'approve');
  });
  return respond.deferUpdate();
}

/**
 * [Sorry😞] on a pending pick, or [No. I'll decline it.😞] on an accepted one
 * — Thank you is reversible until Launch. Either way it consumes one decline
 * from the budget and sends the Santa back to picking.
 */
export async function recoDecline(c: HCtx, ownerArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, me, santa } = ctx;
  if (me.declines_used >= e.max_declines) {
    return respond.ephemeral({ content: '🔒 You have no Sorry😞s left — you can\'t send this one back.' });
  }
  bg(c, async () => {
    const declinedTitle = me.reco_title ?? '?';
    const newDeclined = JSON.stringify([
      ...declinedOf(me),
      ...(me.reco_mal_id !== null ? [{ mal_id: me.reco_mal_id, title: declinedTitle }] : []),
    ]);
    // The state subquery closes the launch race: once the event leaves
    // RECOMMENDING, no decline can land (an accepted pick is final by then).
    const res = await c.env.DB.prepare(
      `UPDATE signups SET reco_status = 'NONE', declines_used = declines_used + 1, reco_declined_json = ?1,
         reco_mal_id = NULL, reco_title = NULL, reco_title_en = NULL, reco_year = NULL,
         reco_type = NULL, reco_episodes = NULL, reco_url = NULL, reco_image = NULL,
         reco_final_via = NULL, updated_at = ?2
       WHERE signup_id = ?3
         AND (reco_status = 'PENDING' OR (reco_status = 'FINAL' AND reco_final_via = 'APPROVED'))
         AND declines_used < ?4
         AND (SELECT state FROM events WHERE events.event_id = signups.event_id) = 'RECOMMENDING'`,
    ).bind(newDeclined, now(), me.signup_id, e.max_declines).run();
    if ((res.meta.changes ?? 0) === 0) {
      // Lost a race (double-click / force-finalize) — show the fresh truth.
      const current = await getSignup(c.env, e.event_id, c.userId);
      await editOriginal(c.env, c.i.token, statusPayload(e, current ?? me, ctx.giftee)).catch(() => {});
      return;
    }
    const fresh: SignupRow = {
      ...me, reco_status: 'NONE', reco_final_via: null, declines_used: me.declines_used + 1,
      reco_declined_json: newDeclined, reco_mal_id: null, reco_title: null, reco_title_en: null,
      reco_year: null, reco_type: null, reco_episodes: null, reco_url: null, reco_image: null,
    };
    const left = Math.max(0, e.max_declines - fresh.declines_used);
    await editOriginal(c.env, c.i.token, {
      content: '',
      embeds: [embed({
        title: `😞 You sent ${declinedTitle} back`,
        description:
          `Your Secret Santa is choosing another pick — you'll get a ping when it arrives.\n` +
          (left > 0
            ? `You can decline **${left}** more time(s).`
            : `That was your last Sorry😞 — you won't be able to send the next one back.`),
      })],
      components: [],
    }).catch(() => {});
    if (santa.signup_id !== me.signup_id && santa.thread_id) {
      await postMessage(c.env, santa.thread_id, declineNotice(e, santa, fresh, declinedTitle)).catch((err) => {
        console.error('decline notice post failed', err);
      });
    }
    const items = await getItems(c.env, e.event_id);
    await writeRecoCells(c.env, c.guild, e, items, fresh).catch(() => {});
    await throttledCountRepaint(c, e.event_id);
  });
  return respond.deferUpdate();
}

/** Repaint immediately at true milestones — the last Santa sending their pick
 *  (Launch turns green) or the last pick being accepted — and throttled like
 *  the signup counter otherwise. */
async function maybeMilestoneRepaint(c: HCtx, e: EventRow, kind: 'send' | 'approve'): Promise<void> {
  const agg = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN reco_status = 'NONE' THEN 1 ELSE 0 END), 0) AS waiting,
            COALESCE(SUM(CASE WHEN reco_status = 'FINAL' THEN 1 ELSE 0 END), 0) AS final
     FROM signups WHERE event_id = ?1`,
  ).bind(e.event_id).first<{ n: number; waiting: number; final: number }>();
  const milestone = kind === 'send'
    ? (agg?.waiting ?? 1) === 0
    : (agg?.final ?? 0) === (agg?.n ?? -1);
  if (milestone) await repaint(c);
  else await throttledCountRepaint(c, e.event_id);
}

// ---------------------------------------------------------------- My Status

function statusPayload(e: EventRow, me: SignupRow, giftee: SignupRow): Record<string, unknown> {
  const left = Math.max(0, e.max_declines - me.declines_used);
  const accepted = me.reco_status === 'FINAL' && me.reco_final_via === 'APPROVED';
  const mission = giftee.signup_id === me.signup_id
    ? null
    : giftee.reco_status === 'FINAL'
      ? `✅ **${giftee.display_name}** accepted your pick: **${giftee.reco_title}**.`
      : giftee.reco_status === 'PENDING'
        ? `⏳ You sent **${giftee.reco_title}** to **${giftee.display_name}** — waiting for their reply.`
        : `🎯 **${giftee.display_name}** is waiting for your pick${giftee.declines_used > 0 ? ` (they've sent ${giftee.declines_used} back so far)` : ''}.\n` +
          `Their list: ${giftee.list_url || '*not provided*'}`;
  const incoming = accepted
    ? `✅ You accepted **${me.reco_title}**.${left > 0 ? ' You can still change your mind until the launch.' : ''}`
    : me.reco_status === 'FINAL'
      ? `✅ Your anime: **${me.reco_title}**.`
      : me.reco_status === 'PENDING'
        ? `📬 **${me.reco_title}** is waiting for your reply!`
        : `🎁 Your Secret Santa is still choosing${me.declines_used > 0 ? ` (you've sent ${me.declines_used} pick(s) back)` : ''}…`;
  const buttons: unknown[] = [];
  if (mission && giftee.reco_status === 'NONE') {
    buttons.push(btn(`ax:reco:${me.user_id}`, '🎯 Recommend an anime', Style.PRIMARY));
  }
  if (me.reco_status === 'PENDING') {
    buttons.push(btn(`ax:reco_ok:${me.user_id}`, 'Thank you!😊', Style.SUCCESS));
    if (left > 0) buttons.push(btn(`ax:reco_no:${me.user_id}`, 'Sorry😞', Style.DANGER));
  }
  if (accepted && left > 0) {
    buttons.push(btn(`ax:reco_no:${me.user_id}`, "No. I'll decline it.😞", Style.DANGER));
  }
  if ((me.reco_status === 'PENDING' || accepted) && me.reco_url) {
    buttons.push(linkBtn(me.reco_url, '🔗 View on MAL'));
  }
  return {
    content: '',
    embeds: [embed({
      title: '🎯 Your exchange status',
      description: [
        mission ? `**Your mission**\n${mission}` : null,
        `**Your anime**\n${incoming}`,
        `*(Sorry😞s left: **${left}**.)*`,
      ].filter(Boolean).join('\n\n'),
    })],
    components: buttons.length ? [row(...buttons)] : [],
  };
}

/** [🎯 My Status] on the participant panel — thread-free fallback surface. */
export async function recoStatusMe(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  return respond.ephemeral(statusPayload(ctx.e, ctx.me, ctx.giftee));
}
