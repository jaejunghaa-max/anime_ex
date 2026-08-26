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
import { activeRecos, answersOf, declinedRecos, finalRecos, pendingRecos, picksLeft } from './db';
import { ts } from './util';

function visibleAnswerLines(giftee: SignupRow, items: FormItem[]): string {
  const answers = answersOf(giftee);
  return items
    .filter((it) => it.visible_to_recommender)
    .map((it) => `• **${it.label}:** ${answers[String(it.item_id)] || '—'}`)
    .join('\n');
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
 * The one live panel in a participant's thread during PREPARING/RECOMMENDING —
 * a SINGLE embed: mission on top, the anime they've accepted below, controls
 * last.
 */
export function statusPanel(
  event: EventRow, me: SignupRow, giftee: SignupRow, items: FormItem[],
  gifteeRecos: RecoRow[], myRecos: RecoRow[],
): Record<string, unknown> {
  const isSelf = giftee.signup_id === me.signup_id;
  const sent = [...gifteeRecos].sort((a, b) => a.slot - b.slot);
  const approvedForThem = finalRecos(gifteeRecos).length;
  const left = picksLeft(giftee, gifteeRecos);

  const missionLines = [
    event.theme ? `🎨 **Theme:** ${event.theme}` : null,
    `Study **${giftee.display_name}**'s (<@${giftee.user_id}>) taste. Recommend **at most ${giftee.max_recos}** anime they'll love` +
      `${event.theme ? ' — and that fit the theme' : ''}.`,
    `• **list:** ${giftee.list_url || '—'}`,
    visibleAnswerLines(giftee, items),
    '',
    `🎯 **Your recommendations** (${approvedForThem} approved / ${giftee.max_recos} at most)`,
    sent.length
      ? sent.map((r) => `• ${animeLabel(r)} — ${statusTag(r)}`).join('\n')
      : '*none sent yet*',
    event.reco_deadline
      ? `⏰ **Recommend by** ${ts(event.reco_deadline)} (${ts(event.reco_deadline, 'R')})`
      : null,
    event.max_declines > 0
      ? `They can send a pick back with Sorry😞. *They don't know it's you — identities stay secret until the reveal.* 🤫`
      : `*They don't know it's you — identities stay secret until the reveal.* 🤫`,
  ].filter((l) => l !== null).join('\n');

  const myFinal = finalRecos(myRecos);
  const myPending = pendingRecos(myRecos);
  const mineLines = [
    '🎁 **Anime you approved**',
    myFinal.length
      ? myFinal.map((r, i) => `**${i + 1}.** ✅ ${animeLabel(r)}\n${animeLine(r)}`).join('\n')
      : '*nothing accepted yet*',
    myPending.length
      ? `⏳ Waiting on your reply: ${myPending.map((r) => `**${animeLabel(r)}**`).join(', ')}`
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

  return {
    content: `<@${me.user_id}> your secret mission 🎯`,
    embeds: [
      embed({
        title: `🎯 You are the Secret Santa of ${giftee.display_name}`,
        description: `${missionLines}\n\n${mineLines}`,
      }),
    ],
    components: buttons.length ? [row(...buttons)] : [],
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

/** Button labels cap at 80 chars — keep long titles readable. */
const short = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Posted in each thread by the launch job: the recap of what this participant
 * picked (top), then their own anime + review docs + deadline, buttons last.
 * Every anime has its OWN review doc, so multi-anime threads get one link
 * button each.
 */
export function assignmentCard(
  event: EventRow, me: SignupRow, myGiftee: SignupRow,
  myRecos: RecoRow[], gifteeRecos: RecoRow[],
): Record<string, unknown> {
  const deadline = event.review_deadline!;
  const mine = activeRecos(myRecos);
  const theirs = activeRecos(gifteeRecos);
  const single = mine.length === 1 ? mine[0] : null;
  const docBtns = mine
    .filter((r) => r.doc_url)
    .map((r) => linkBtn(
      r.doc_url!,
      single ? '📝 Open your review doc' : `📝 Review: ${short(animeLabel(r), 55)}`,
    ));
  return {
    content: `<@${me.user_id}> the exchange is on — happy watching! 🎬`,
    embeds: [
      embed({
        title: `🎁 Your pick${theirs.length > 1 ? 's' : ''}: ${theirs.map(animeLabel).join(' · ') || '—'}`,
        description:
          `**${myGiftee.display_name}** (<@${myGiftee.user_id}>) will be reviewing ` +
          `${theirs.length > 1 ? 'them' : 'it'}.\n` +
          `MAL/AniList: ${myGiftee.list_url || '—'}`,
      }),
      embed({
        // No title url — the title stays unclickable.
        title: single ? `🎬 Your anime: ${animeLabel(single)}` : `🎬 Your anime (${mine.length})`,
        description:
          (single
            ? `${animeLine(single)}\n`
            : `${mine.map((r) => `• **${animeLabel(r)}** — ${animeLine(r)}`).join('\n')}\n`) +
          `Picked for you by your Secret Santa — *revealed at the end.*\n` +
          `Watch the **full season**${mine.length > 1 ? ' of each' : ''}, then write your review${mine.length > 1 ? 's' : ''} ` +
          `${single ? 'in your doc below' : '— **each anime has its own doc** below'}.`,
        image: single?.image ?? mine[0]?.image ?? undefined,
        fields: [{
          name: '⏰ Review deadline',
          value: `${ts(deadline)} (${ts(deadline, 'R')})`,
        }],
      }),
    ],
    components: [row(
      ...docBtns,
      btn('ax:score', mine.length > 1 ? '⭐ Score them /10' : '⭐ Score it /10', Style.PRIMARY),
    )],
  };
}

/** Posted in each thread by the close job. Every anime carries its own review
 *  link inline — "(read review)" — no buttons. */
export function revealCard(
  me: SignupRow, santa: SignupRow, myGiftee: SignupRow,
  myRecos: RecoRow[], gifteeRecos: RecoRow[],
): Record<string, unknown> {
  const mine = activeRecos(myRecos);
  const theirs = activeRecos(gifteeRecos);
  const scored = theirs.filter((r) => r.score !== null);
  const verdict = scored.length === 0
    ? `didn't score your pick${theirs.length > 1 ? 's' : ''}`
    : `rated your pick${theirs.length > 1 ? 's' : ''}`;
  const theirLine = (r: RecoRow): string =>
    `• **${animeLabel(r)}**${r.score !== null ? ` — ⭐ ${r.score}/10` : ''}` +
    `${r.doc_url ? ` ([read review](${r.doc_url}))` : ' — *review doc missing*'}`;
  return {
    content: `<@${me.user_id}> the reveal is here! 🎭`,
    embeds: [embed({
      title: '🎭 The reveal',
      description:
        `Your Secret Santa was **${santa.display_name}** (<@${santa.user_id}>) — ` +
        `they picked ${mine.map((r) => `**${animeLabel(r)}**`).join(', ') || '—'} for you.\n\n` +
        `**${myGiftee.display_name}** (<@${myGiftee.user_id}>) ${verdict}` +
        (theirs.length ? `\n${theirs.map(theirLine).join('\n')}` : '.'),
    })],
  };
}

/** Kept for the declined-history line in the sheet/status panel. */
export const declinedTitles = (rows: RecoRow[]): string[] =>
  declinedRecos(rows).map((r) => animeLabel(r));
