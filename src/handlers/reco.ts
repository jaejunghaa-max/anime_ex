// RECOMMENDING-phase interactions (v5). Every Santa may send their giftee up
// to `signups.max_recos` anime — the giftee's own choice at sign-up, and a
// MAXIMUM, not a quota: one accepted pick is enough for the exchange to
// launch. Each pick is answered with Thank you!😊 (accepts) or Sorry😞 (sends
// it back, spending the per-person decline budget). Accepted picks can still
// be taken back until Launch, via the status panel's "I'll change my mind😞".
//
// Each participant's thread holds one consolidated status panel (cards.ts
// statusPanel), edited in place on every change; pick cards are transient.
//
// Buttons carry the owner's user id (`ax:reco*:{uid}[:{reco}]`) so a moderator
// clicking inside someone else's private thread is rejected instead of acting
// on their own row (§13.2). Every write is conditional on the current status,
// so double-clicks and races produce a harmless ephemeral, never a duplicate
// side effect (§13.4).

import type { AnimeCandidate } from '../mal';
import { searchAnime } from '../mal';
import type { DraftRow, EventRow, RecoRow, SignupRow } from '../types';
import { modalFields } from '../types';
import {
  btn, deleteMessage, editMessage, editOriginal, embed, followUp, modalText, postMessage, respond,
  row, stringSelect, Style,
} from '../discord';
import {
  activeRecos, declinedRecos, finalRecos, getItems, loopContext, pendingRecos, picksLeft, recosOf,
} from '../db';
import { animeLabel, answerNotice, recoCard, statusPanel } from '../cards';
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
  /** My giftee's picks — the ones I send. */
  gifteeRecos: RecoRow[];
  /** My own picks — the ones I answer. */
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

/**
 * Re-render one participant's consolidated status panel in their thread.
 * Best-effort: a missing thread or deleted panel never breaks the action.
 */
async function refreshPanel(c: HCtx, e: EventRow, signupId: number): Promise<void> {
  try {
    const { all, loops, recos } = await loopContext(c.env, e.event_id);
    const idx = all.findIndex((s) => s.signup_id === signupId);
    if (idx < 0) return;
    const owner = all[idx]!;
    if (!owner.thread_id) return;
    const items = await getItems(c.env, e.event_id);
    const giftee = all[loops.recipient[idx]!]!;
    const payload = statusPanel(
      e, owner, giftee, items,
      recosOf(recos, giftee.signup_id), recosOf(recos, owner.signup_id),
    );
    if (owner.mission_msg_id) {
      await editMessage(c.env, owner.thread_id, owner.mission_msg_id, payload);
    } else {
      const msg = await postMessage(c.env, owner.thread_id, payload);
      await c.env.DB.prepare('UPDATE signups SET mission_msg_id = ?1 WHERE signup_id = ?2')
        .bind(msg.id, signupId).run();
    }
  } catch (err) {
    console.error(`status panel refresh failed for signup ${signupId}`, err);
  }
}

// ------------------------------------------------------- recommend wizard

/** [🎯 Recommend an anime] → keyword modal (opened immediately, §13.1). */
export async function recoOpen(c: HCtx, ownerArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, giftee, gifteeRecos } = ctx;
  if (picksLeft(giftee, gifteeRecos) <= 0) {
    const pending = pendingRecos(gifteeRecos).length;
    return respond.ephemeral({
      content: pending > 0
        ? `⏳ **${pending}** pick(s) are still waiting for **${giftee.display_name}**'s reply. You cannot send picks now.`
        : `✅ **${giftee.display_name}** has all **${giftee.max_recos}** anime they asked for. Mission complete!`,
    });
  }
  const draft = await loadDraft(c, e.event_id);
  return respond.modal('axm:reco_kw', `Pick for ${truncate(giftee.display_name, 25)}`, [
    modalText('kw', 'Anime title keyword (English or Japanese)', {
      value: draft?.keyword ?? '', max: 100, placeholder: 'e.g. Frieren / 葬送のフリーレン',
      description: `${giftee.display_name} accepts at most ${giftee.max_recos} anime`,
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
      step: 'R_SEARCH', keyword, candidates_json: JSON.stringify(candidates),
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
    const taken = new Map<number, string>();
    for (const r of declinedRecos(gifteeRecos)) {
      if (r.mal_id !== null) taken.set(r.mal_id, '⛔ they already declined this one');
    }
    for (const r of activeRecos(gifteeRecos)) {
      if (r.mal_id !== null) taken.set(r.mal_id, '⛔ already one of your picks for them');
    }
    await editOriginal(c.env, c.i.token, {
      content: `🔎 Results for **${truncate(keyword, 80)}** — pick the anime for **${giftee.display_name}**:`,
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

/** Reject a title the giftee declined before, or one already sent to them. */
function duplicateReason(giftee: SignupRow, gifteeRecos: RecoRow[], malId: number): string | null {
  if (declinedRecos(gifteeRecos).some((r) => r.mal_id === malId)) {
    return `⛔ **${giftee.display_name}** already declined that one — pick something else.`;
  }
  if (activeRecos(gifteeRecos).some((r) => r.mal_id === malId)) {
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
      content: dupe, embeds: [],
      components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
    });
  }
  await saveDraft(c, e.event_id, { ...draft, step: 'R_PICKED', chosen_json: JSON.stringify(chosen) });
  return respond.update({
    content: `Send this pick to **${giftee.display_name}**?`,
    embeds: [embed({
      // No title url — the title stays plain; [MAL] lives in the body.
      title: candLabel(chosen),
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

/** [📨 Send] → insert the pick → card in the giftee's thread → panels. */
export async function recoSend(c: HCtx): Promise<Response> {
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, me, giftee, gifteeRecos } = ctx;
  const draft = await loadDraft(c, e.event_id);
  const chosen = parseJson<AnimeCandidate | null>(draft?.chosen_json ?? null, null);
  if (!draft || !chosen) {
    return respond.update({ content: '⏳ This wizard expired — press **🎯 Recommend an anime** to start again.', embeds: [], components: [] });
  }
  const dupe = duplicateReason(giftee, gifteeRecos, chosen.mal_id);
  if (dupe) {
    return respond.update({
      content: dupe, embeds: [],
      components: [row(btn('ax:reco_again', '🔍 Search again', Style.PRIMARY))],
    });
  }
  if (picksLeft(giftee, gifteeRecos) <= 0) {
    return respond.update({
      content: `↻ **${giftee.display_name}** already has all **${giftee.max_recos}** picks — nothing sent.`,
      embeds: [], components: [],
    });
  }
  const slot = Math.max(0, ...gifteeRecos.map((r) => r.slot)) + 1;
  bg(c, async () => {
    // The count guard is re-checked inside the write window by re-reading the
    // giftee's rows; the UNIQUE(signup_id, slot) index makes a double-click
    // collide instead of inserting twice.
    const fresh = await c.env.DB
      .prepare('SELECT * FROM recos WHERE signup_id = ?1 ORDER BY slot').bind(giftee.signup_id)
      .all<RecoRow>();
    if (picksLeft(giftee, fresh.results) <= 0) {
      await editOriginal(c.env, c.i.token, {
        content: `↻ **${giftee.display_name}** already has all **${giftee.max_recos}** picks — nothing sent.`,
        embeds: [], components: [],
      });
      return;
    }
    let inserted;
    try {
      inserted = await c.env.DB.prepare(
        `INSERT INTO recos (event_id, signup_id, slot, mal_id, title, title_en, year, type,
           episodes, url, image, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'PENDING', ?12, ?12)
         RETURNING *`,
      ).bind(
        e.event_id, giftee.signup_id, slot, chosen.mal_id, chosen.title, chosen.title_en,
        chosen.year, chosen.type, chosen.episodes, chosen.url, chosen.image, now(),
      ).first<RecoRow>();
    } catch {
      await editOriginal(c.env, c.i.token, {
        content: '↻ That pick was already sent — check your mission panel.', embeds: [], components: [],
      });
      return;
    }
    if (!inserted) return;
    await deleteDraft(c, e.event_id);

    let deliveryNote = '';
    if (giftee.thread_id) {
      const msg = await postMessage(c.env, giftee.thread_id, recoCard(e, giftee, inserted))
        .catch((err) => {
          console.error('reco card post failed', err);
          deliveryNote = '\n⚠ Couldn\'t reach their thread — let your event manager know.';
          return null;
        });
      if (msg) {
        await c.env.DB.prepare('UPDATE recos SET msg_id = ?1 WHERE reco_id = ?2')
          .bind(msg.id, inserted.reco_id).run();
      }
    } else {
      deliveryNote = '\n⚠ They have no thread — let your event manager know.';
    }
    const items = await getItems(c.env, e.event_id);
    await writeRecoCells(c.env, c.guild, e, items, giftee).catch((err) => {
      console.error('reco cells write failed (heals at launch)', err);
    });
    await refreshPanel(c, e, me.signup_id);
    await refreshPanel(c, e, giftee.signup_id);
    await milestoneRepaint(c, e);
    await editOriginal(c.env, c.i.token, {
      content: `📨 Sent **${candLabel(chosen)}** to **${giftee.display_name}**!${deliveryNote}`,
      embeds: [], components: [],
    });
  });
  return respond.deferUpdate();
}

// ------------------------------------------------------- approve / decline

const findReco = (rows: RecoRow[], arg: string): RecoRow | undefined => {
  const id = Number(arg);
  return Number.isFinite(id) && id > 0 ? rows.find((r) => r.reco_id === id) : undefined;
};

/** [Thank you!😊] — accepts one pick; the card is removed and the accepted
 *  anime shows up in the status panel instead. */
export async function recoApprove(c: HCtx, ownerArg: string, recoArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, me, santa, myRecos } = ctx;
  const target = findReco(myRecos, recoArg) ?? pendingRecos(myRecos)[0];
  if (!target || target.status !== 'PENDING') {
    return respond.ephemeral({ content: '↻ That pick is no longer waiting for a reply.' });
  }
  bg(c, async () => {
    const res = await c.env.DB.prepare(
      "UPDATE recos SET status = 'FINAL', final_via = 'APPROVED', updated_at = ?1 WHERE reco_id = ?2 AND status = 'PENDING'",
    ).bind(now(), target.reco_id).run();
    if ((res.meta.changes ?? 0) === 0) {
      await refreshPanel(c, e, me.signup_id);
      return;
    }
    const fresh: RecoRow = { ...target, status: 'FINAL', final_via: 'APPROVED' };
    await removeCard(c, me, fresh);
    if (santa.signup_id !== me.signup_id && santa.thread_id) {
      await postMessage(c.env, santa.thread_id, answerNotice(santa, me, fresh))
        .catch((err) => console.error('answer notice post failed', err));
    }
    const items = await getItems(c.env, e.event_id);
    await writeRecoCells(c.env, c.guild, e, items, me).catch(() => {});
    await refreshPanel(c, e, me.signup_id);
    await refreshPanel(c, e, santa.signup_id);
    await milestoneRepaint(c, e);
    // The card is gone and the status panel sits far above the thread — say so
    // here, or accepting looks like nothing happened.
    await followUp(c.env, c.i.token, {
      content: `😊 **${animeLabel(fresh)}** is yours — it's on your status panel now.` +
        (me.declines_used < e.max_declines
          ? ' You can still take it back with **I\'ll change my mind😞** until launch.'
          : ''),
    }).catch(() => {});
  }, { reportVia: 'followup' });
  return respond.deferUpdate();
}

/** Delete an answered pick card (the status panel carries the outcome) and
 *  forget its id, so a later cleanup doesn't 404 on a message already gone. */
async function removeCard(c: HCtx, giftee: SignupRow, reco: RecoRow): Promise<void> {
  if (!giftee.thread_id || !reco.msg_id) return;
  await deleteMessage(c.env, giftee.thread_id, reco.msg_id)
    .catch((err) => console.error('pick card cleanup failed', err));
  await c.env.DB.prepare('UPDATE recos SET msg_id = NULL WHERE reco_id = ?1')
    .bind(reco.reco_id).run().catch(() => {});
}

/**
 * [Sorry😞] on a pending pick, and the engine behind the status panel's
 * "I'll change my mind😞" for accepted ones. Spends one decline from the
 * per-person budget and frees a slot for the Santa.
 */
/**
 * Report a decline that did NOT happen. When the click came from a pick card
 * (a public thread message), the notice must NOT go through editOriginal: that
 * would replace the card — artwork, title and the Thank you!😊 button — with a
 * one-line note while the pick is still PENDING, leaving the giftee no way to
 * accept it. Send an ephemeral instead and re-render the card so its buttons
 * match the budget that actually remains.
 */
async function declineFailed(
  c: HCtx, e: EventRow, me: SignupRow, target: RecoRow, viaPanel: boolean, content: string,
): Promise<void> {
  if (viaPanel) {
    await editOriginal(c.env, c.i.token, { content, embeds: [], components: [] }).catch(() => {});
    return;
  }
  await followUp(c.env, c.i.token, { content }).catch(() => {});
  if (!me.thread_id || !target.msg_id) return;
  const fresh = await c.env.DB.prepare('SELECT * FROM recos WHERE reco_id = ?1')
    .bind(target.reco_id).first<RecoRow>();
  const spent = await c.env.DB.prepare('SELECT declines_used FROM signups WHERE signup_id = ?1')
    .bind(me.signup_id).first<{ declines_used: number }>();
  if (!fresh || fresh.status !== 'PENDING') return; // the card is stale; the panel carries the truth
  await editMessage(c.env, me.thread_id, target.msg_id,
    recoCard(e, { ...me, declines_used: spent?.declines_used ?? me.declines_used }, fresh),
  ).catch((err) => console.error('pick card re-render failed', err));
}

async function declineReco(c: HCtx, ctx: RecoCtx, target: RecoRow, viaPanel: boolean): Promise<void> {
  const { e, me, santa } = ctx;
  // Spend the budget first, conditionally — that single UPDATE is what keeps
  // concurrent declines (several pending cards, double-clicks) inside the
  // budget. If the pick then turns out to be gone, the budget is handed back.
  const spend = await c.env.DB.prepare(
    'UPDATE signups SET declines_used = declines_used + 1, updated_at = ?1 WHERE signup_id = ?2 AND declines_used < ?3',
  ).bind(now(), me.signup_id, e.max_declines).run();
  if ((spend.meta.changes ?? 0) === 0) {
    await declineFailed(c, e, me, target, viaPanel,
      '🔒 You have no Sorry😞s left — this pick stays. You can still accept it with **Thank you!😊**.');
    return;
  }
  // The state subquery closes the launch race: once the event leaves
  // RECOMMENDING nothing can be sent back any more.
  const res = await c.env.DB.prepare(
    `UPDATE recos SET status = 'DECLINED', final_via = NULL, score = NULL, updated_at = ?1
     WHERE reco_id = ?2 AND status IN ('PENDING', 'FINAL')
       AND (SELECT state FROM events WHERE events.event_id = recos.event_id) = 'RECOMMENDING'`,
  ).bind(now(), target.reco_id).run();
  if ((res.meta.changes ?? 0) === 0) {
    await c.env.DB.prepare('UPDATE signups SET declines_used = declines_used - 1 WHERE signup_id = ?1 AND declines_used > 0')
      .bind(me.signup_id).run();
    await refreshPanel(c, e, me.signup_id);
    await declineFailed(c, e, me, target, viaPanel,
      '↻ That pick already moved on — your status panel is up to date.');
    return;
  }
  const declined: RecoRow = { ...target, status: 'DECLINED', final_via: null, score: null };
  const left = Math.max(0, e.max_declines - (me.declines_used + 1));
  const note = `😞 You sent **${animeLabel(declined)}** back — ` +
    (left > 0 ? `**${left}** Sorry😞${left > 1 ? 's' : ''} left.` : `that was your last Sorry😞.`);
  if (viaPanel) {
    await editOriginal(c.env, c.i.token, { content: note, embeds: [], components: [] }).catch(() => {});
    await removeCard(c, me, declined);
  } else {
    // The clicked pick card becomes the one-line note.
    await editOriginal(c.env, c.i.token, { content: note, embeds: [], components: [] }).catch(() => {});
    await c.env.DB.prepare('UPDATE recos SET msg_id = NULL WHERE reco_id = ?1').bind(target.reco_id).run();
  }
  // Budget exhausted → the Sorry buttons on any other pending card are now
  // lies; re-render those cards so they match reality.
  if (left === 0) await refreshSiblingCards(c, e, me, target.reco_id);

  if (santa.signup_id !== me.signup_id && santa.thread_id) {
    await postMessage(c.env, santa.thread_id, answerNotice(santa, me, declined))
      .catch((err) => console.error('answer notice post failed', err));
  }
  const items = await getItems(c.env, e.event_id);
  await writeRecoCells(c.env, c.guild, e, items, me).catch(() => {});
  await refreshPanel(c, e, me.signup_id);
  await refreshPanel(c, e, santa.signup_id);
  await throttledCountRepaint(c, e.event_id);
}

/** Re-render the giftee's other pending pick cards (budget/state changed). */
async function refreshSiblingCards(
  c: HCtx, e: EventRow, giftee: SignupRow, exceptRecoId: number,
): Promise<void> {
  if (!giftee.thread_id) return;
  const rows = await c.env.DB
    .prepare("SELECT * FROM recos WHERE signup_id = ?1 AND status = 'PENDING' AND msg_id IS NOT NULL")
    .bind(giftee.signup_id).all<RecoRow>();
  const spent: SignupRow = { ...giftee, declines_used: e.max_declines };
  for (const r of rows.results) {
    if (r.reco_id === exceptRecoId) continue;
    await editMessage(c.env, giftee.thread_id, r.msg_id!, recoCard(e, spent, r))
      .catch((err) => console.error('sibling card refresh failed', err));
  }
}

export async function recoDecline(c: HCtx, ownerArg: string, recoArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, me, myRecos } = ctx;
  if (me.declines_used >= e.max_declines) {
    return respond.ephemeral({ content: '🔒 You have no Sorry😞s left — you can\'t send this one back.' });
  }
  const target = findReco(myRecos, recoArg) ?? pendingRecos(myRecos)[0];
  if (!target || target.status === 'DECLINED') {
    return respond.ephemeral({ content: '↻ That pick is no longer yours to decline.' });
  }
  bg(c, () => declineReco(c, ctx, target, false), { reportVia: 'followup' });
  return respond.deferUpdate();
}

/** ["I'll change my mind😞"] → select which accepted anime to send back. */
export async function recoUndoMenu(c: HCtx, ownerArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const { e, me, myRecos } = ctx;
  if (me.declines_used >= e.max_declines) {
    return respond.ephemeral({ content: '🔒 You have no Sorry😞s left — your picks stay as they are.' });
  }
  const accepted = finalRecos(myRecos);
  if (accepted.length === 0) {
    return respond.ephemeral({ content: 'You haven\'t accepted anything yet — nothing to take back.' });
  }
  return respond.ephemeral({
    content: `😞 Which one should go back? Your Santa will pick a replacement. ` +
      `(**${Math.max(0, e.max_declines - me.declines_used)}** Sorry😞 left.)`,
    components: [row(stringSelect(`ax:reco_undo_pick:${me.user_id}`, 'Send one back…',
      accepted.map((r) => ({ label: truncate(animeLabel(r), 100), value: String(r.reco_id) })),
    ))],
  });
}

export async function recoUndoPick(c: HCtx, ownerArg: string): Promise<Response> {
  const owned = ownedBy(c, ownerArg);
  if (owned) return owned;
  const ctx = await recoCtxOf(c);
  if (ctx instanceof Response) return ctx;
  const target = findReco(ctx.myRecos, c.i.data?.values?.[0] ?? '');
  if (!target || target.status !== 'FINAL') {
    return respond.update({ content: '↻ That pick already moved on.', components: [] });
  }
  bg(c, () => declineReco(c, ctx, target, true));
  return respond.deferUpdate();
}

/** Repaint the manager panel; instant when the phase becomes launch-ready. */
async function milestoneRepaint(c: HCtx, e: EventRow): Promise<void> {
  const agg = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signups s
     WHERE s.event_id = ?1
       AND NOT EXISTS (SELECT 1 FROM recos r WHERE r.signup_id = s.signup_id AND r.status != 'DECLINED')`,
  ).bind(e.event_id).first<{ n: number }>();
  if ((agg?.n ?? 1) === 0) await repaint(c);
  else await throttledCountRepaint(c, e.event_id);
}
