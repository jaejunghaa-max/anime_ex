// Thread-card builders for the v3 flow, shared by the batched jobs (prepare /
// launch / close) and the RECOMMENDING interaction handlers. All pure
// state → payload functions; custom_ids carry the owner's user id so a click
// in the wrong thread can be rejected instead of silently acting on the
// clicker's own row.

import type { EventRow, FormItem, SignupRow } from './types';
import { btn, embed, linkBtn, row, Style } from './discord';
import { declinedOf, answersOf } from './db';
import { truncate, ts } from './util';

function safeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    new URL(u);
    return u;
  } catch {
    return null;
  }
}

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
 * the giftee's list link + 👁-visible answers, and the Recommend button.
 */
export function taskCard(
  event: EventRow, me: SignupRow, giftee: SignupRow, items: FormItem[],
): Record<string, unknown> {
  const visibleLines = visibleAnswerLines(giftee, items);
  const listUrl = safeUrl(giftee.list_url);
  const budget = event.max_declines === 0
    ? 'They **cannot** send it back — your first pick is final, so make it count.'
    : `They can send a pick back up to **${event.max_declines}** time(s) with Sorry😞 — after that, your next pick locks in automatically.`;
  return {
    content: `<@${me.user_id}> your secret mission is here! 🎯`,
    embeds: [embed({
      title: `🎯 You are the Secret Santa of ${giftee.display_name}`,
      description:
        `Study **${giftee.display_name}**'s (<@${giftee.user_id}>) taste and recommend an anime they'll love.\n` +
        `**Their list:** ${listUrl ?? (giftee.list_url || '*not provided*')}` +
        (visibleLines ? `\n\nWhat they shared with you:\n${visibleLines}` : '') +
        `\n\n${budget}\n*They don't know it's you — identities stay secret until the reveal.* 🤫`,
    })],
    components: [row(...[
      listUrl ? linkBtn(listUrl, '📚 Open their list') : null,
      btn(`ax:reco:${me.user_id}`, '🎯 Recommend an anime', Style.PRIMARY),
    ].filter(Boolean) as unknown[])],
  };
}

/**
 * Posted in the GIFTEE's thread on every send. When the pick is still PENDING
 * it carries the Thank you!/Sorry buttons; when the send exhausted the decline
 * budget (auto-FINAL) it is informational.
 */
export function recoCard(event: EventRow, giftee: SignupRow): Record<string, unknown> {
  const left = Math.max(0, event.max_declines - giftee.declines_used);
  const pending = giftee.reco_status === 'PENDING';
  const choiceLine = pending
    ? `**Thank you!😊** locks it in · **Sorry😞** sends it back — you can do that **${left}** more time(s).`
    : giftee.reco_final_via === 'APPROVED'
      ? `You said **Thank you!😊** — it's locked in. Enjoy! 🍿`
      : giftee.reco_final_via === 'FORCED'
        ? `Locked in by the event manager. Enjoy! 🍿`
        : `You've used all your declines — this one is locked in. Enjoy! 🍿`;
  return {
    content: `<@${giftee.user_id}> your Secret Santa picked something for you! 🎁`,
    embeds: [embed({
      title: `🎁 ${giftee.reco_title}${giftee.reco_year ? ` (${giftee.reco_year})` : ''}`,
      url: giftee.reco_url ?? undefined,
      description:
        `${animeLine(giftee)}\n` +
        `Chosen just for you — *who picked it stays secret until the reveal.*\n\n${choiceLine}`,
      image: giftee.reco_image ?? undefined,
    })],
    components: pending
      ? [row(
          btn(`ax:reco_ok:${giftee.user_id}`, 'Thank you!😊', Style.SUCCESS),
          btn(`ax:reco_no:${giftee.user_id}`, 'Sorry😞', Style.DANGER),
        )]
      : [],
  };
}

/** Posted in the SANTA's thread when their pick is declined. */
export function declineNotice(
  event: EventRow, santa: SignupRow, giftee: SignupRow, declinedTitle: string,
): Record<string, unknown> {
  const left = Math.max(0, event.max_declines - giftee.declines_used);
  const already = declinedOf(giftee).map((d) => d.title);
  return {
    content: `<@${santa.user_id}> 😞 **${giftee.display_name}** sent your pick back — round ${giftee.declines_used + 1}!`,
    embeds: [embed({
      description:
        `**${declinedTitle}** was declined (${giftee.declines_used}/${event.max_declines} declines used).\n` +
        (already.length ? `Already declined: ${already.map((t) => `**${t}**`).join(', ')}\n` : '') +
        (left > 0
          ? `They can still send **${left}** more pick(s) back.`
          : `Their declines are used up — **your next pick locks in automatically.**`),
    })],
    components: [row(btn(`ax:reco:${santa.user_id}`, '🎯 Recommend another', Style.PRIMARY))],
  };
}

/** Posted in the SANTA's thread when their pick is approved (or auto-locked). */
export function lockedNotice(santa: SignupRow, giftee: SignupRow): Record<string, unknown> {
  const how = giftee.reco_final_via === 'APPROVED'
    ? `said **Thank you!😊** to`
    : giftee.reco_final_via === 'FORCED' ? 'had the manager lock in' : 'is now locked in with';
  return {
    content:
      `<@${santa.user_id}> 🎉 **${giftee.display_name}** ${how} **${giftee.reco_title}** — ` +
      `your mission is complete. The exchange launches once everyone's pick is locked.`,
  };
}

/**
 * Posted in each thread by the launch job: the locked-in anime + review doc +
 * deadline, plus a recap of what this participant picked for their giftee.
 */
export function assignmentCard(
  event: EventRow, me: SignupRow, myGiftee: SignupRow,
): Record<string, unknown> {
  const deadline = event.review_deadline!;
  return {
    content: `<@${me.user_id}> the exchange is on — happy watching! 🎬`,
    embeds: [
      embed({
        title: `🎬 Your anime: ${me.reco_title}${me.reco_year ? ` (${me.reco_year})` : ''}`,
        url: me.reco_url ?? undefined,
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
      embed({
        title: `🎁 Your pick: ${myGiftee.reco_title}`,
        description: `You chose it for **${myGiftee.display_name}** (<@${myGiftee.user_id}>) — they'll be reviewing it too.`,
      }),
    ],
    components: [row(...[
      me.doc_url ? linkBtn(me.doc_url, '📝 Open your review doc') : null,
      btn('ax:score', '⭐ Score it /10', Style.PRIMARY),
    ].filter(Boolean) as unknown[])],
  };
}

/** Posted in each thread by the close job. */
export function revealCard(
  me: SignupRow, santa: SignupRow, myGiftee: SignupRow,
): Record<string, unknown> {
  const reviewTitle = `Review of ${myGiftee.reco_title} by ${myGiftee.display_name}`;
  const verdict = myGiftee.score !== null
    ? `gave your pick **${myGiftee.reco_title}** **⭐ ${myGiftee.score} stars**`
    : `reviewed your pick **${myGiftee.reco_title}**`;
  return {
    content: `<@${me.user_id}> the reveal is here! 🎭`,
    embeds: [embed({
      title: '🎭 The reveal',
      description:
        `Your Secret Santa was **${santa.display_name}** (<@${santa.user_id}>) — ` +
        `they picked **${me.reco_title}** for you.\n\n` +
        `**${myGiftee.display_name}** (<@${myGiftee.user_id}>) ${verdict}` +
        `${myGiftee.doc_url ? ':' : ' — but their review doc is missing.'}`,
    })],
    components: myGiftee.doc_url ? [row(linkBtn(myGiftee.doc_url, `📖 ${truncate(reviewTitle, 70)}`))] : [],
  };
}
