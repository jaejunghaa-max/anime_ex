// RECOMMENDING-phase interactions (v4). Every Santa fills their giftee's
// recommendation slots (1..event.max_recos) through the MAL wizard; the
// giftee answers each pick with Thank you!😊 (accepts — reversible until
// Launch via the red "I changed my mind to decline it😞") or Sorry😞 (sends
// it back). Declining spends the events.max_declines budget, counted per
// person across all slots; a spent budget only removes the decline buttons —
// nothing locks until Launch sweeps the still-pending picks.
//
// Buttons on thread cards carry the owner's user id (`ax:reco*:{uid}[:{reco}]`)
// so a moderator clicking inside someone else's private thread is rejected
// instead of silently acting on their own row (§13.2). All writes are
// conditional on the current status, so double-clicks and races produce a
// harmless ephemeral, never a duplicate side effect (§13.4).

import type { AnimeCandidate } from '../mal';
import { searchAnime } from '../mal';
import type { DraftRow, EventRow, RecoRow, SignupRow } from '../types';
import { modalFields } from '../types';
import { btn, editOriginal, embed, linkBtn, modalText, postMessage, respond, row, stringSelect, Style } from '../discord';
import { declinedOf, getItems, getSignup, loopContext, recosOf, sentRecos } from '../db';
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
  /** My giftee's slots — the ones I have to fill. */
  gifteeRecos: RecoRow[];
  /** My own slots — the picks I answer. */
  myRecos: RecoRow[];
}

/** Wrong-thread protection: `ax:reco*:{uid}` buttons act only for their owner. */
function ownedBy(c: HCtx, ownerArg: string): Response | null {
  if (ownerArg && ownerArg !== c.userId) {
    return respond.ephemeral({ content: `🔒 These buttons belong to <@${ownerArg}> — check your own private thread.` });
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
  const { all, loops, recos, indexOfUser } = await loopContext(c.env, e.event_id);
  const idx = indexOfUser(c.userId);
  if (idx < 0) return respond.ephemeral({ content: 'Only participants have a Santa mission.' });
  const me = all[idx]!;
  const giftee = all[loops.recipient[idx]!]!;
  return {
    e, me, giftee, santa: all[loops.santa[idx]!]!,
    gifteeRecos: recosOf(recos, giftee.signup_id),
    myRecos: recosOf(recos, me.signup_id),
  };
}

const candLabel = (a: { title: string; year?: number | null }) =>
  `${a.title}${a.year ? ` (${a.year})` : ''}`;

/** The slot a new pick goes into: the lowest one still empty. */
const nextOpenSlot = (recos: RecoRow[]): RecoRow | undefined =>
  recos.filter((r) => r.status === 'NONE').sort((a, b) => a.slot - b.slot)[0];

const openCount = (recos: RecoRow[]): number => recos.filter((r) => r.status === 'NONE').length;

/** "2 of 3 sent" progress for the Santa's messages. */
function progressLine(e: EventRow, gifteeRecos: RecoRow[]): string {
  if (e.max_recos <= 1) return '';
  const sent = sentRecos(gifteeRecos).length;
  return `\n📌 **${sent} of ${e.max_recos}** picks sent.`;
}

// ------------------------------------------------------- recommend wizard

/** [🎯 Recommend an anime] → keyword modal (opened immediately, §13.1). */
export async function recoOpen(c: HCtx, ownerArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee, gifteeRecos } = ctx;
  const open = nextOpenSlot(gifteeRecos);
  if (!open) {
    const pending = gifteeRecos.filter((r) => r.status === 'PENDING').length;
    return respond.ephemeral({
      content: pending > 0
        ? `⏳ All your picks for **${giftee.display_name}** are sent — ${pending} still waiting for their reply.`
        : `✅ **${giftee.display_name}** has all your picks. Mission complete!`,
    });
  }
  const draft = await loadDraft(c, e.event_id);
  return respond.modal('axm:reco_kw', `Pick for ${truncate(giftee.display_name, 25)}`, [
    modalText('kw', 'Anime title keyword (English or Japanese)', {
      value: draft?.keyword ?? '', max: 100, placeholder: 'e.g. Frieren / 葬送のフリーレン',
      description: e.max_recos > 1
        ? `Pick ${open.slot} of ${e.max_recos} for ${truncate(giftee.display_name, 40)}`
        : undefined,
    }),
  ]);
}

/** Keyword modal submit → deferred → MAL search → picker (§13.1 row 3). */
export async function recoModalKw(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee, gifteeRecos } = ctx;
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
    // Neither a title they already declined nor one already in another slot.
    const taken = new Map<number, string>();
    for (const d of declinedOf(giftee)) taken.set(d.mal_id, '⛔ they already declined this one');
    for (const r of sentRecos(gifteeRecos)) {
      if (r.mal_id !== null) taken.set(r.mal_id, '⛔ already one of your picks for them');
    }
    await editOriginal(c.env, c.i.token, {
      content: `🔎 Results for **${truncate(keyword, 80)}** — pick the anime for **${giftee.display_name}**:` +
        progressLine(e, gifteeRecos),
      embeds: [],
      components: [
        row(stringSelect('ax:reco_pick', 'Pick an anime…', candidates.map((a, idx) => ({
          label: `${a.title} (${a.year ?? '?'} · ${a.type ?? '?'} · ${a.episodes ?? '?'} eps)`,
          value: String(idx),
          description: taken.get(a.mal_id) ?? a.title_en ?? a.title_jp ?? undefined,
        })))),
        row(btn('ax:reco_again', '🔍 Search again')),
      ],
    });
  });
  return fromEphemeral ? respond.deferUpdate() : respond.deferEphemeral();
}

/** Reject a pick the giftee declined before, or one already in another slot. */
function duplicateReason(giftee: SignupRow, gifteeRecos: RecoRow[], malId: number): string | null {
  if (declinedOf(giftee).some((d) => d.mal_id === malId)) {
    return `⛔ **${giftee.display_name}** already declined that one — pick something else.`;
  }
  if (sentRecos(gifteeRecos).some((r) => r.mal_id === malId)) {
    return `⛔ That's already one of your picks for **${giftee.display_name}** — pick something else.`;
  }
  return null;
}

/** Picker select → duplicate check → confirm card with the Send button. */
export async function recoPick(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee, gifteeRecos } = ctx;
  const draft = await loadDraft(c, e.event_id);
  const candidates = parseJson<AnimeCandidate[]>(draft?.candidates_json ?? null, []);
  const chosen = candidates[Number(c.i.data?.values?.[0] ?? -1)];
  if (!draft || !chosen) {
    return respond.update({
      content: '⏳ This wizard expired — press **🎯 Recommend an anime** to start again.',
      embeds: [], components: [],
    });
  }
  const dupe = duplicateReason(giftee, gifteeRecos, chosen.mal_id);
  if (dupe) {
    return respond.update({
      content: dupe,
      embeds: [],
      components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
    });
  }
  await saveDraft(c, e.event_id, { ...draft, step: 'R_PICKED', chosen_json: JSON.stringify(chosen) });
  const slot = nextOpenSlot(gifteeRecos);
  return respond.update({
    content: `Send this pick to **${giftee.display_name}**?` +
      (e.max_recos > 1 && slot ? ` *(pick ${slot.slot} of ${e.max_recos})*` : ''),
    embeds: [embed({
      title: candLabel(chosen),
      url: chosen.url,
      description: [
        chosen.title_en && chosen.title_en !== chosen.title ? chosen.title_en : null,
        `${chosen.type ?? '?'} · ${chosen.episodes ?? '?'} episodes · [MAL](${chosen.url})`,
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

/** [📨 Send] → conditional write on the slot → card in the giftee's thread. */
export async function recoSend(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee, gifteeRecos } = ctx;
  const draft = await loadDraft(c, e.event_id);
  const chosen = parseJson<AnimeCandidate | null>(draft?.chosen_json ?? null, null);
  if (!draft || !chosen) {
    return respond.update({ content: '⏳ This wizard expired — press **🎯 Recommend an anime** to start again.', embeds: [], components: [] });
  }
  const dupe = duplicateReason(giftee, gifteeRecos, chosen.mal_id);
  if (dupe) {
    return respond.update({
      content: dupe,
      embeds: [],
      components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
    });
  }
  const slot = nextOpenSlot(gifteeRecos);
  if (!slot) {
    return respond.update({
      content: `↻ All your picks for **${giftee.display_name}** are already sent — nothing to do.`,
      embeds: [], components: [],
    });
  }
  bg(c, async () => {
    const res = await c.env.DB.prepare(
      `UPDATE recos SET mal_id = ?1, title = ?2, title_en = ?3, year = ?4, type = ?5, episodes = ?6,
         url = ?7, image = ?8, status = 'PENDING', final_via = NULL, updated_at = ?9
       WHERE reco_id = ?10 AND status = 'NONE'`,
    ).bind(
      chosen.mal_id, chosen.title, chosen.title_en, chosen.year, chosen.type, chosen.episodes,
      chosen.url, chosen.image, now(), slot.reco_id,
    ).run();
    if ((res.meta.changes ?? 0) === 0) {
      await editOriginal(c.env, c.i.token, {
        content: `↻ That slot was already filled — press **🎯 Recommend an anime** again if you still owe a pick.`,
        embeds: [], components: [],
      });
      return;
    }
    await deleteDraft(c, e.event_id);
    const fresh: RecoRow = {
      ...slot,
      mal_id: chosen.mal_id, title: chosen.title, title_en: chosen.title_en,
      year: chosen.year, type: chosen.type, episodes: chosen.episodes,
      url: chosen.url, image: chosen.image, status: 'PENDING', final_via: null,
    };
    let deliveryNote = '';
    if (giftee.thread_id) {
      await postMessage(c.env, giftee.thread_id, recoCard(e, giftee, fresh)).catch((err) => {
        console.error('reco card post failed', err);
        deliveryNote = '\n⚠ Couldn\'t reach their thread — let your event manager know.';
      });
    } else {
      deliveryNote = '\n⚠ They have no thread — let your event manager know.';
    }
    const items = await getItems(c.env, e.event_id);
    await writeRecoCells(c.env, c.guild, e, items, giftee, fresh).catch((err) => {
      console.error('reco cells write failed (heals at launch)', err);
    });
    await maybeMilestoneRepaint(c, e, 'send');
    const stillOwed = openCount(gifteeRecos) - 1;
    await editOriginal(c.env, c.i.token, {
      content:
        `📨 Sent **${candLabel(chosen)}** to **${giftee.display_name}**! ` +
        (stillOwed > 0
          ? `**${stillOwed}** more pick(s) to go — press **🎯 Recommend another**.`
          : `You'll get a ping in your thread when they reply.`) +
        deliveryNote,
      embeds: [],
      components: stillOwed > 0
        ? [row(btn(`ax:reco:${c.userId}`, '🎯 Recommend another', Style.PRIMARY))]
        : [],
    });
  });
  return respond.deferUpdate();
}

// ------------------------------------------------------- approve / decline

/** Resolve the reco a button refers to; falls back to the single pending one. */
function targetReco(myRecos: RecoRow[], recoArg: string): RecoRow | undefined {
  const id = Number(recoArg);
  if (Number.isFinite(id) && id > 0) return myRecos.find((r) => r.reco_id === id);
  return myRecos.find((r) => r.status === 'PENDING');
}

/** [Thank you!😊] — accepts one pick on the clicker's own row. */
export async function recoApprove(c: HCtx, ownerArg: string, recoArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, me, santa, myRecos, giftee, gifteeRecos } = ctx;
  const target = targetReco(myRecos, recoArg);
  if (!target) {
    return respond.ephemeral({ content: '↻ That pick is no longer waiting for a reply.' });
  }
  bg(c, async () => {
    const res = await c.env.DB.prepare(
      "UPDATE recos SET status = 'FINAL', final_via = 'APPROVED', updated_at = ?1 WHERE reco_id = ?2 AND status = 'PENDING'",
    ).bind(now(), target.reco_id).run();
    if ((res.meta.changes ?? 0) === 0) {
      // Lost a race (double-click / launch sweep) — show the fresh truth.
      await editOriginal(c.env, c.i.token, statusPayload(e, me, giftee, myRecos, gifteeRecos)).catch(() => {});
      return;
    }
    const fresh: RecoRow = { ...target, status: 'FINAL', final_via: 'APPROVED' };
    // The clicked message (thread card or reminder) becomes the accepted card.
    await editOriginal(c.env, c.i.token, { ...recoCard(e, me, fresh), content: '' }).catch(() => {});
    if (santa.signup_id !== me.signup_id && santa.thread_id) {
      await postMessage(c.env, santa.thread_id,
        lockedNotice(santa, me, fresh.title ?? '?', openCount(myRecos))).catch((err) => {
        console.error('locked notice post failed', err);
      });
    }
    const items = await getItems(c.env, e.event_id);
    await writeRecoCells(c.env, c.guild, e, items, me, fresh).catch(() => {});
    await maybeMilestoneRepaint(c, e, 'approve');
  });
  return respond.deferUpdate();
}

/**
 * [Sorry😞] on a pending pick, or [I changed my mind to decline it😞] on an
 * accepted one — Thank you is reversible until Launch. Either way it consumes
 * one decline from the per-person budget and re-opens that slot.
 */
export async function recoDecline(c: HCtx, ownerArg: string, recoArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, me, santa, myRecos, giftee, gifteeRecos } = ctx;
  if (me.declines_used >= e.max_declines) {
    return respond.ephemeral({ content: '🔒 You have no Sorry😞s left — you can\'t send this one back.' });
  }
  const target = targetReco(myRecos, recoArg);
  if (!target || target.status === 'NONE') {
    return respond.ephemeral({ content: '↻ That pick is no longer yours to decline.' });
  }
  bg(c, async () => {
    // Spend the budget first, conditionally — that single UPDATE is what makes
    // concurrent declines (two slots at once, double-clicks) safe. If the pick
    // then turns out to be gone, the budget is handed back.
    const spend = await c.env.DB.prepare(
      'UPDATE signups SET declines_used = declines_used + 1, updated_at = ?1 WHERE signup_id = ?2 AND declines_used < ?3',
    ).bind(now(), me.signup_id, e.max_declines).run();
    if ((spend.meta.changes ?? 0) === 0) {
      await editOriginal(c.env, c.i.token, {
        content: '🔒 You have no Sorry😞s left — this pick stays.', embeds: [], components: [],
      }).catch(() => {});
      return;
    }
    const declinedTitle = target.title ?? '?';
    // The state subquery closes the launch race: once the event leaves
    // RECOMMENDING, no decline can land (an accepted pick is final by then).
    const res = await c.env.DB.prepare(
      `UPDATE recos SET status = 'NONE', final_via = NULL, mal_id = NULL, title = NULL,
         title_en = NULL, year = NULL, type = NULL, episodes = NULL, url = NULL, image = NULL,
         score = NULL, updated_at = ?1
       WHERE reco_id = ?2
         AND (status = 'PENDING' OR (status = 'FINAL' AND final_via = 'APPROVED'))
         AND (SELECT state FROM events WHERE events.event_id = recos.event_id) = 'RECOMMENDING'`,
    ).bind(now(), target.reco_id).run();
    if ((res.meta.changes ?? 0) === 0) {
      await c.env.DB.prepare('UPDATE signups SET declines_used = declines_used - 1 WHERE signup_id = ?1 AND declines_used > 0')
        .bind(me.signup_id).run();
      await editOriginal(c.env, c.i.token, statusPayload(e, me, giftee, myRecos, gifteeRecos)).catch(() => {});
      return;
    }
    const declinedJson = JSON.stringify([
      ...declinedOf(me),
      ...(target.mal_id !== null ? [{ mal_id: target.mal_id, title: declinedTitle }] : []),
    ]);
    await c.env.DB.prepare('UPDATE signups SET reco_declined_json = ?1 WHERE signup_id = ?2')
      .bind(declinedJson, me.signup_id).run();

    const freshMe: SignupRow = {
      ...me, declines_used: me.declines_used + 1, reco_declined_json: declinedJson,
    };
    const freshReco: RecoRow = {
      ...target, status: 'NONE', final_via: null, mal_id: null, title: null, title_en: null,
      year: null, type: null, episodes: null, url: null, image: null, score: null,
    };
    const left = Math.max(0, e.max_declines - freshMe.declines_used);
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
      // openCount is computed from the pre-decline snapshot, so +1 for this slot.
      await postMessage(c.env, santa.thread_id,
        declineNotice(santa, freshMe, declinedTitle, openCount(myRecos) + 1)).catch((err) => {
        console.error('decline notice post failed', err);
      });
    }
    const items = await getItems(c.env, e.event_id);
    await writeRecoCells(c.env, c.guild, e, items, freshMe, freshReco).catch(() => {});
    await throttledCountRepaint(c, e.event_id);
  });
  return respond.deferUpdate();
}

/** Repaint immediately at true milestones — the last slot being filled
 *  (Launch turns green) or the last pick being accepted — and throttled like
 *  the signup counter otherwise. */
async function maybeMilestoneRepaint(c: HCtx, e: EventRow, kind: 'send' | 'approve'): Promise<void> {
  const agg = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN status = 'NONE' THEN 1 ELSE 0 END), 0) AS waiting,
            COALESCE(SUM(CASE WHEN status = 'FINAL' THEN 1 ELSE 0 END), 0) AS final
     FROM recos WHERE event_id = ?1`,
  ).bind(e.event_id).first<{ n: number; waiting: number; final: number }>();
  const milestone = kind === 'send'
    ? (agg?.waiting ?? 1) === 0
    : (agg?.final ?? 0) === (agg?.n ?? -1);
  if (milestone) await repaint(c);
  else await throttledCountRepaint(c, e.event_id);
}

// ---------------------------------------------------------------- My status

function statusPayload(
  e: EventRow, me: SignupRow, giftee: SignupRow, myRecos: RecoRow[], gifteeRecos: RecoRow[],
): Record<string, unknown> {
  const left = Math.max(0, e.max_declines - me.declines_used);
  const owed = openCount(gifteeRecos);
  const mission = giftee.signup_id === me.signup_id
    ? null
    : owed > 0
      ? `🎯 **${giftee.display_name}** is waiting for **${owed}** more pick(s).\n` +
        `Their list: ${giftee.list_url || '*not provided*'}`
      : gifteeRecos.some((r) => r.status === 'PENDING')
        ? `⏳ All picks sent to **${giftee.display_name}** — waiting for their reply.`
        : `✅ **${giftee.display_name}** accepted all your picks.`;
  const mineLines = myRecos.map((r) => {
    const tag = e.max_recos > 1 ? `**${r.slot}.** ` : '';
    if (r.status === 'FINAL') return `${tag}✅ **${r.title}**`;
    if (r.status === 'PENDING') return `${tag}📬 **${r.title}** — waiting for your reply!`;
    return `${tag}🎁 your Secret Santa is still choosing…`;
  }).join('\n');
  const buttons: unknown[] = [];
  if (mission && owed > 0) {
    buttons.push(btn(`ax:reco:${me.user_id}`, '🎯 Recommend an anime', Style.PRIMARY));
  }
  const firstPending = myRecos.find((r) => r.status === 'PENDING');
  if (firstPending) {
    buttons.push(btn(`ax:reco_ok:${me.user_id}:${firstPending.reco_id}`, 'Thank you!😊', Style.SUCCESS));
    if (left > 0) buttons.push(btn(`ax:reco_no:${me.user_id}:${firstPending.reco_id}`, 'Sorry😞', Style.DANGER));
    if (firstPending.url) buttons.push(linkBtn(firstPending.url, '🔗 View on MAL'));
  }
  return {
    content: '',
    embeds: [embed({
      title: '🎯 Your exchange status',
      description: [
        mission ? `**Your mission**\n${mission}` : null,
        `**Your anime**\n${mineLines || '—'}`,
        `*(Sorry😞s left: **${left}**.)*`,
      ].filter(Boolean).join('\n\n'),
    })],
    components: buttons.length ? [row(...buttons)] : [],
  };
}

/** Legacy: the pre-3.2 participant panel had a 🎯 My Status button; stale
 *  clicks still get a useful answer. Threads are the primary status surface. */
export async function recoStatusMe(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  return respond.ephemeral(statusPayload(ctx.e, ctx.me, ctx.giftee, ctx.myRecos, ctx.gifteeRecos));
}
