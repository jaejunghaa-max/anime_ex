// Thread-card builders for the v3 flow, shared by the batched jobs (prepare /
// launch / close) and the RECOMMENDING interaction handlers. All pure
// state → payload functions; custom_ids carry the owner's user id so a click
// in the wrong thread can be rejected instead of silently acting on the
// clicker's own row.

import type { EventRow, FormItem, SignupRow } from './types';
import { btn, embed, linkBtn, row, Style } from './discord';
import { declinedOf, answersOf } from './db';
import { ts } from './util';

function visibleAnswerLines(giftee: SignupRow, items: FormItem[]): string {
  const answers = answersOf(giftee);
  return items
    .filter((it) => it.visible_to_recommender)
    .map((it) => `• **${it.label}:** ${answers[String(it.item_id)] || '—'}`)
    .join('\n');
}

const animeLine = (s: SignupRow): string =>
  `${s.reco_type ?? '?'} · ${s.reco_episodes ?? '?'} episodes${s.reco_url ? ` · [MAL](${s.reco_url})` : ''}`;

/**
 * Posted in the RECOMMENDER's thread by the prepare job: who their giftee is,
 * their info as one bullet list (list link + 👁-visible answers), and the
 * Recommend button. No decline-budget numbers — the Santa never sees counts.
 */
export function taskCard(
  event: EventRow, me: SignupRow, giftee: SignupRow, items: FormItem[],
): Record<string, unknown> {
  const infoLines = [
    `• **list:** ${giftee.list_url || '—'}`,
    visibleAnswerLines(giftee, items),
  ].filter(Boolean).join('\n');
  const budget = event.max_declines === 0
    ? `They can't send picks back — make it count.`
    : `They can send a pick back with Sorry😞.`;
  return {
    content: `<@${me.user_id}> your secret mission is here! 🎯`,
    embeds: [embed({
      title: `🎯 You are the Secret Santa of ${giftee.display_name}`,
      description:
        (event.theme ? `🎨 **Theme:** ${event.theme}\n` : '') +
        `Study **${giftee.display_name}**'s (<@${giftee.user_id}>) taste and recommend an anime they'll love${event.theme ? ' — and that fits the theme' : ''}.\n` +
        `${infoLines}\n\n` +
        (event.reco_deadline ? `⏰ **Recommend by** ${ts(event.reco_deadline)} (${ts(event.reco_deadline, 'R')})\n` : '') +
        `${budget}\n*They don't know it's you — identities stay secret until the reveal.* 🤫`,
    })],
    components: [row(btn(`ax:reco:${me.user_id}`, '🎯 Recommend an anime', Style.PRIMARY))],
  };
}

/**
 * Posted in the GIFTEE's thread on every send, and re-rendered in place when
 * they answer. PENDING carries Thank you! (+ Sorry, while the budget lasts);
 * an accepted pick keeps a red "I changed my mind to decline it😞" until Launch — Thank
 * you is not an irreversible lock. Only the launch sweep (FORCED) is final.
 */
export function recoCard(event: EventRow, giftee: SignupRow): Record<string, unknown> {
  const left = Math.max(0, event.max_declines - giftee.declines_used);
  const pending = giftee.reco_status === 'PENDING';
  const accepted = giftee.reco_status === 'FINAL' && giftee.reco_final_via === 'APPROVED';
  let choiceLine: string;
  let buttons: unknown[] = [];
  if (pending) {
    choiceLine = left > 0
      ? `**Thank you!😊** accepts it · **Sorry😞** sends it back — you can do that **${left}** more time(s).`
      : `**Thank you!😊** accepts it. *(You have no Sorry😞s left.)*`;
    buttons = [
      btn(`ax:reco_ok:${giftee.user_id}`, 'Thank you!😊', Style.SUCCESS),
      ...(left > 0 ? [btn(`ax:reco_no:${giftee.user_id}`, 'Sorry😞', Style.DANGER)] : []),
    ];
  } else if (accepted) {
    choiceLine = `You said **Thank you!😊** — enjoy! 🍿` +
      (left > 0 ? `\nChanged your mind? You can still decline it until the launch.` : '');
    buttons = left > 0
      ? [btn(`ax:reco_no:${giftee.user_id}`, 'I changed my mind to decline it😞', Style.DANGER)]
      : [];
  } else {
    choiceLine = `Locked in at launch. Enjoy! 🍿`;
  }
  const deadlineLine = pending && event.reco_deadline
    ? `\n⏰ Reply by ${ts(event.reco_deadline)} (${ts(event.reco_deadline, 'R')}).`
    : '';
  return {
    content: `<@${giftee.user_id}> your Secret Santa picked something for you! 🎁`,
    embeds: [embed({
      // No title url — like the assignment card, the title stays unclickable;
      // the [MAL] link lives in the body text.
      title: `🎁 ${giftee.reco_title}${giftee.reco_year ? ` (${giftee.reco_year})` : ''}`,
      description:
        (event.theme ? `🎨 **Theme:** ${event.theme}\n` : '') +
        `${animeLine(giftee)}\n` +
        `Chosen just for you — *who picked it stays secret until the reveal.*\n\n${choiceLine}${deadlineLine}`,
      image: giftee.reco_image ?? undefined,
    })],
    components: buttons.length ? [row(...buttons)] : [],
  };
}

/** Posted in the SANTA's thread when their pick is declined. Deliberately
 *  count-free: the Santa never learns how many Sorry😞s remain. */
export function declineNotice(
  _event: EventRow, santa: SignupRow, giftee: SignupRow, declinedTitle: string,
): Record<string, unknown> {
  const already = declinedOf(giftee).map((d) => d.title);
  return {
    content: `<@${santa.user_id}> 😞 **${giftee.display_name}** sent your pick back!`,
    embeds: [embed({
      description:
        `**${declinedTitle}** was declined.` +
        (already.length ? `\nAlready declined: ${already.map((t) => `**${t}**`).join(', ')}` : ''),
    })],
    components: [row(btn(`ax:reco:${santa.user_id}`, '🎯 Recommend another', Style.PRIMARY))],
  };
}

/** Posted in the SANTA's thread when their pick is accepted. */
export function lockedNotice(santa: SignupRow, giftee: SignupRow): Record<string, unknown> {
  return {
    content: `<@${santa.user_id}> 🎉 **${giftee.display_name}** said **Thank you!😊** to **${giftee.reco_title}**.`,
  };
}

/**
 * Posted in each thread by the launch job: the recap of what this participant
 * picked (top), then their own locked-in anime + review doc + deadline, with
 * the buttons last.
 */
export function assignmentCard(
  event: EventRow, me: SignupRow, myGiftee: SignupRow,
): Record<string, unknown> {
  const deadline = event.review_deadline!;
  return {
    content: `<@${me.user_id}> the exchange is on — happy watching! 🎬`,
    embeds: [
      embed({
        title: `🎁 Your pick: ${myGiftee.reco_title}`,
        description:
          `**${myGiftee.display_name}** (<@${myGiftee.user_id}>) will be reviewing it.\n` +
          `MAL/AniList: ${myGiftee.list_url || '—'}`,
      }),
      embed({
        // No title url — "Your anime" stays unclickable; the MAL link lives
        // in the body text instead.
        title: `🎬 Your anime: ${me.reco_title}${me.reco_year ? ` (${me.reco_year})` : ''}`,
        description:
          `${animeLine(me)}\n` +
          `Picked for you by your Secret Santa — *revealed at the end.*\n` +
          `Watch the **full season**, then write your review in your doc below.`,
        image: me.reco_image ?? undefined,
        fields: [{
          name: '⏰ Review deadline',
          value: `${ts(deadline)} (${ts(deadline, 'R')})`,
        }],
      }),
    ],
    components: [row(...[
      me.doc_url ? linkBtn(me.doc_url, '📝 Open your review doc') : null,
      btn('ax:score', '⭐ Score it /10', Style.PRIMARY),
    ].filter(Boolean) as unknown[])],
  };
}

/** Posted in each thread by the close job. The review link rides inline in
 *  the sentence — "(read review)" — no button. */
export function revealCard(
  me: SignupRow, santa: SignupRow, myGiftee: SignupRow,
): Record<string, unknown> {
  const verdict = myGiftee.score !== null
    ? `gave your pick **${myGiftee.reco_title}** **⭐ ${myGiftee.score} stars**`
    : `didn't score your pick **${myGiftee.reco_title}**`;
  return {
    content: `<@${me.user_id}> the reveal is here! 🎭`,
    embeds: [embed({
      title: '🎭 The reveal',
      description:
        `Your Secret Santa was **${santa.display_name}** (<@${santa.user_id}>) — ` +
        `they picked **${me.reco_title}** for you.\n\n` +
        `**${myGiftee.display_name}** (<@${myGiftee.user_id}>) ${verdict}` +
        `${myGiftee.doc_url ? ` ([read review](${myGiftee.doc_url}))` : ' — but their review doc is missing.'}`,
    })],
  };
}
