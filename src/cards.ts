// Thread-card builders (v5), shared by the batched jobs (prepare / launch /
// close) and the RECOMMENDING interaction handlers.
//
// During the recommendation phase each participant's thread carries ONE
// consolidated status panel (`statusPanel`) — their Santa mission, the picks
// they've sent, the anime they've accepted, and their controls — edited in
// place on every change. Individual pick cards are transient: they carry the
// Thank you!/Sorry buttons and disappear once answered.
//
// All pure state → payload functions; custom_ids carry the owner's user id
// (and, for per-pick buttons, the reco id) so a click in the wrong thread can
// be rejected instead of silently acting on the clicker's own row.

import type { EventRow, FormItem, RecoRow, SignupRow } from './types';
import { btn, embed, linkBtn, row, Style } from './discord';
import { activeRecos, answersOf, finalRecos, pendingRecos, picksLeft } from './db';
import { truncate, ts } from './util';

function visibleAnswerLines(giftee: SignupRow, items: FormItem[]): string | null {
  const answers = answersOf(giftee);
  const lines = items
    .filter((it) => it.visible_to_recommender)
    .map((it) => `• **${it.label}:** ${answers[String(it.item_id)] || '—'}`);
  return lines.length ? lines.join('\n') : null;
}

export const animeLabel = (r: Pick<RecoRow, 'title' | 'year'>): string =>
  `${r.title}${r.year ? ` (${r.year})` : ''}`;

const animeLine = (r: RecoRow): string =>
  `${r.type ?? '?'} · ${r.episodes ?? '?'} episodes${r.url ? ` · [MAL](${r.url})` : ''}`;

const statusTag = (r: RecoRow): string =>
  r.status === 'DECLINED' ? 'declined 😞'
    : r.status === 'FINAL' ? 'approved 😊'
    : 'waiting for their reply ⏳';

/**
 * The one live panel in a participant's thread during PREPARING/RECOMMENDING:
 * the Santa mission in the first embed, the anime *they* were given in the
 * second, controls last. The split is deliberate — a single description caps
 * at 4096 characters, which eight free-text form answers can fill on their own.
 */
export function statusPanel(
  event: EventRow, me: SignupRow, giftee: SignupRow, items: FormItem[],
  gifteeRecos: RecoRow[], myRecos: RecoRow[],
): Record<string, unknown> {
  const isSelf = giftee.signup_id === me.signup_id;
  const sent = [...gifteeRecos].sort((a, b) => a.slot - b.slot);
  const approvedForThem = finalRecos(gifteeRecos).length;
  const left = picksLeft(giftee, gifteeRecos);

  // The deadline rides inside the mission sentence — no separate ⏰ line.
  const by = event.reco_deadline
    ? ` by ${ts(event.reco_deadline)} (${ts(event.reco_deadline, 'R')})`
    : '';
  const missionLines = [
    event.theme ? `🎨 **Theme:** ${event.theme}` : null,
    `Study **${giftee.display_name}**'s (<@${giftee.user_id}>) taste. Recommend **at most ${giftee.max_recos}** anime they'll love` +
      `${event.theme ? ' — and that fit the theme' : ''}${by}.`,
    `• **list:** ${giftee.list_url || '—'}`,
    visibleAnswerLines(giftee, items),
    `🎯 **Your recommendations** (${approvedForThem} approved / ${giftee.max_recos} at most)`,
    sent.length
      ? sent.map((r) => `• ${animeLabel(r)} — ${statusTag(r)}`).join('\n')
      : '*none sent yet*',
    `*They don't know it's you — identities stay secret until the reveal.* 🤫`,
  ].filter((l) => l !== null).join('\n');

  const myFinal = finalRecos(myRecos);
  const myPending = pendingRecos(myRecos);
  const mineLines = [
    '🎁 **Anime you approved**',
    myFinal.length
      ? myFinal.map((r) => `• **${animeLabel(r)}** — ${animeLine(r)}`).join('\n')
      : '*nothing accepted yet*',
    myPending.length
      ? `⏳ Waiting on your reply:\n${myPending.map((r) => `• **${animeLabel(r)}**`).join('\n')}`
      : null,
    `Sorry😞s left: **${Math.max(0, event.max_declines - me.declines_used)}**`,
  ].filter(Boolean).join('\n');

  const buttons: unknown[] = [];
  if (!isSelf && left > 0) {
    buttons.push(btn(`ax:reco:${me.user_id}`, '🎯 Recommend an anime', Style.PRIMARY));
  }
  if (myFinal.length > 0 && me.declines_used < event.max_declines) {
    buttons.push(btn(`ax:reco_undo:${me.user_id}`, "I'll change my mind😞", Style.DANGER));
  }

  // Accepting must be possible from the panel, not only from the pick card:
  // cards are transient (deleted on answer, replaced on error, lost when a
  // thread is pruned), and without this the panel could list a pick as
  // "waiting for your reply" while offering no way to reply to it.
  const acceptRow: unknown[] = myPending.slice(0, 5).map((r) =>
    btn(
      `ax:reco_ok:${me.user_id}:${r.reco_id}`,
      myPending.length === 1 ? 'Thank you!😊' : `😊 ${truncate(animeLabel(r), 60)}`,
      Style.SUCCESS,
    ));

  return {
    content: `<@${me.user_id}> your secret mission 🎯`,
    embeds: [
      // Two embeds, not one 4096-char description: form answers are free text
      // and eight visible items can fill the cap on their own, which used to
      // truncate away exactly the half about the reader.
      embed({
        title: `🎯 You are the Secret Santa of ${giftee.display_name}`,
        description: missionLines,
      }),
      embed({ description: mineLines }),
    ],
    components: [
      ...(buttons.length ? [row(...buttons)] : []),
      ...(acceptRow.length ? [row(...acceptRow)] : []),
    ],
  };
}

/**
 * Posted in the GIFTEE's thread when a pick arrives — transient: accepting
 * removes it (the anime moves into their status panel) and declining turns it
 * into a one-line note. The Sorry button disappears once the budget is spent.
 */
export function recoCard(
  event: EventRow, giftee: SignupRow, reco: RecoRow,
): Record<string, unknown> {
  const left = Math.max(0, event.max_declines - giftee.declines_used);
  const choiceLine = left > 0
    ? `**Thank you!😊** accepts it · **Sorry😞** sends it back — you can do that **${left}** more time(s).`
    : `**Thank you!😊** accepts it. *(You have no Sorry😞s left.)*`;
  return {
    content: `<@${giftee.user_id}> your Secret Santa picked something for you! 🎁`,
    embeds: [embed({
      // No title url — the title stays unclickable; [MAL] lives in the body.
      title: `🎁 ${animeLabel(reco)}`,
      description:
        `${animeLine(reco)}\n` +
        `Chosen just for you — *who picked it stays secret until the reveal.*\n\n${choiceLine}` +
        (event.reco_deadline ? `\n⏰ Reply by ${ts(event.reco_deadline)} (${ts(event.reco_deadline, 'R')}).` : ''),
      image: reco.image ?? undefined,
    })],
    components: [row(...[
      btn(`ax:reco_ok:${giftee.user_id}:${reco.reco_id}`, 'Thank you!😊', Style.SUCCESS),
      ...(left > 0 ? [btn(`ax:reco_no:${giftee.user_id}:${reco.reco_id}`, 'Sorry😞', Style.DANGER)] : []),
    ])],
  };
}

/** One-liner pinged to the Santa when their pick is answered. */
export const answerNotice = (santa: SignupRow, giftee: SignupRow, reco: RecoRow): Record<string, unknown> => ({
  content: reco.status === 'DECLINED'
    ? `<@${santa.user_id}> 😞 **${giftee.display_name}** said **Sorry😞** to **${animeLabel(reco)}**.`
    : `<@${santa.user_id}> 🎉 **${giftee.display_name}** said **Thank you!😊** to **${animeLabel(reco)}**.`,
});

/**
 * Launch delivers the assignment as a small SEQUENCE of thread messages, so
 * every anime's own panel is followed by its own buttons (Discord always
 * renders a message's components below ALL of its embeds — one message could
 * never interleave them):
 *
 *   1. `assignmentHeader` — 🎁 Your pick(s) + 🎬 Your anime + the deadline
 *   2. `animeCard` × n     — one panel per anime, with [📝 Review] [⭐ Rate]
 */
export function assignmentHeader(
  event: EventRow, me: SignupRow, myGiftee: SignupRow,
  myRecos: RecoRow[], gifteeRecos: RecoRow[],
): Record<string, unknown> {
  const deadline = event.review_deadline!;
  const mine = activeRecos(myRecos);
  const theirs = activeRecos(gifteeRecos);
  const plural = mine.length > 1;
  return {
    content: `<@${me.user_id}> the exchange is on — happy watching! 🎬`,
    embeds: [
      embed({
        title: '🎁 Your pick',
        description:
          `${theirs.map((r) => `• **${animeLabel(r)}**`).join('\n') || '• —'}\n` +
          `**${myGiftee.display_name}** (<@${myGiftee.user_id}>) will be reviewing ` +
          `${theirs.length > 1 ? 'them' : 'it'}.\n` +
          `MAL/AniList: ${myGiftee.list_url || '—'}`,
      }),
      embed({
        title: '🎬 Your anime',
        description:
          `Below ${plural ? 'are' : 'is'} picked for you by your Secret Santa — *revealed at the end.*\n` +
          `Watch the **full season**${plural ? ' of each' : ''}, then write your review${plural ? 's' : ''} ` +
          `— **each anime has its own doc**.\n` +
          `*Don't share your review${plural ? 's' : ''} until the deadline.*`,
        fields: [{
          name: '⏰ Review deadline',
          value: `${ts(deadline)} (${ts(deadline, 'R')})`,
        }],
      }),
    ],
  };
}

/** One anime's panel + its own [📝 Review] [⭐ Rate] pair. */
export function animeCard(r: RecoRow): Record<string, unknown> {
  const label = animeLabel(r);
  return {
    embeds: [embed({
      // No title url — the title stays unclickable; [MAL] lives in the body.
      title: label,
      description: animeLine(r) +
        (r.final_via === 'FORCED'
          ? '\n*Locked in at launch — this one was still waiting on your reply.*'
          : ''),
      image: r.image ?? undefined,
    })],
    components: [row(...[
      r.doc_url ? linkBtn(r.doc_url, `📝 Review: ${truncate(label, 50)}`) : null,
      btn(`ax:score:${r.reco_id}`, `⭐ Rate: ${truncate(label, 53)}`, Style.PRIMARY),
    ].filter(Boolean) as unknown[])],
  };
}

/**
 * One "who rated what" bullet, shared by the thread reveal and the public
 * gallery: "• J rated **Kaijuu 8-gou (2024)** ⭐ 9 ([review](…))".
 */
export const ratingLine = (rater: SignupRow, r: RecoRow): string =>
  `• ${rater.display_name} ${r.score !== null ? `rated` : `didn't rate`} **${animeLabel(r)}**` +
  `${r.score !== null ? ` ⭐ ${r.score}` : ''}` +
  `${r.doc_url ? ` ([review](${r.doc_url}))` : ''}`;

/** Posted in each thread by the close job. Every anime carries its own review
 *  link inline — "(review)" — no buttons. */
export function revealCard(
  me: SignupRow, santa: SignupRow, myGiftee: SignupRow,
  myRecos: RecoRow[], gifteeRecos: RecoRow[],
): Record<string, unknown> {
  const mine = activeRecos(myRecos);
  const theirs = activeRecos(gifteeRecos);
  return {
    content: `<@${me.user_id}> the reveal is here! 🎭`,
    embeds: [embed({
      title: '🎭 The reveal',
      description:
        `Your Secret Santa was **${santa.display_name}** (<@${santa.user_id}>). ` +
        `They picked the anime for you.\n` +
        `${mine.map((r) => `• **${animeLabel(r)}**`).join('\n') || '• —'}\n\n` +
        `**${myGiftee.display_name}** (<@${myGiftee.user_id}>) appreciated your pick${theirs.length > 1 ? 's' : ''}\n` +
        `${theirs.map((r) => ratingLine(myGiftee, r)).join('\n') || '• —'}`,
    })],
  };
}

