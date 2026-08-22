// Signup wizard (v3): Modal A (MAL/AniList link + items 1–4) → optional
// Modal B (items 5–9) → summary card → confirm. No anime is picked at signup
// anymore — the built-in form item is the participant's list link, which their
// Secret Santa later uses to choose FOR them (handlers/reco.ts). Wizard
// progress lives in signup_drafts because every modal/select is a separate
// stateless interaction; drafts expire after 30 minutes.

import type { DraftRow, EventRow, FormItem } from '../types';
import { modalFields } from '../types';
import { btn, editOriginal, embed, modalSelect, modalText, respond, row, stringSelect, Style } from '../discord';
import type { RecoRow, SignupRow } from '../types';
import { activeRecos, answersOf, countSignups, getItems, getSignup, optionsOf, orderedSignups } from '../db';
import { rewriteSheet, writeScoreCells } from '../sheet';
import { normalizeListUrl, now, sanitizeName, truncate } from '../util';
import { bg, HCtx, stale, throttledCountRepaint } from './common';

const DRAFT_TTL = 30 * 60;

// The list link travels inside partial_answers_json under this key — item ids
// are numeric strings, so it can never collide.
const LINK_KEY = 'link';

// ----------------------------------------------------------------- drafts

async function loadDraft(c: HCtx, eventId: number): Promise<DraftRow | null> {
  const d = await c.env.DB
    .prepare('SELECT * FROM signup_drafts WHERE event_id = ?1 AND user_id = ?2')
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
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    eventId, c.userId, d.step, d.keyword ?? null, d.partial_answers_json ?? '{}',
    d.candidates_json ?? null, d.chosen_json ?? null, now() + DRAFT_TTL,
  ).run();
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

// ----------------------------------------------------------- modal builders

const itemsA = (items: FormItem[]) => items.slice(0, 4);
const itemsB = (items: FormItem[]) => items.slice(4, 9);

function itemComponent(it: FormItem, answers: Record<string, string>): Record<string, unknown> {
  const prev = answers[String(it.item_id)];
  const description = it.description ?? undefined;
  if (it.type === 'MCQ') {
    return modalSelect(`item:${it.item_id}`, it.label, optionsOf(it).map((o, idx) => ({
      label: o, value: String(idx), default: prev === o,
    })), { description });
  }
  return modalText(`item:${it.item_id}`, it.label, { paragraph: true, value: prev ?? '', max: 500, description });
}

export const LINK_LABEL_DEFAULT = 'Link of your MAL/AniList';
export const LINK_DESC_DEFAULT =
  'N/A if you have none — your Secret Santa studies this to pick for you';

function modalA(e: EventRow, items: FormItem[], answers: Record<string, string>): Response {
  return respond.modal('axm:signup_a', 'Sign up — step 1', [
    modalText(LINK_KEY, e.link_label || LINK_LABEL_DEFAULT, {
      value: answers[LINK_KEY] ?? '', max: 300,
      placeholder: 'https://myanimelist.net/profile/you — or anilist.co/user/you',
      description: e.link_desc || LINK_DESC_DEFAULT,
    }),
    ...itemsA(items).map((it) => itemComponent(it, answers)),
  ]);
}

function modalB(items: FormItem[], answers: Record<string, string>): Response {
  return respond.modal('axm:signup_b', 'Sign up — step 2', [
    ...itemsB(items).map((it) => itemComponent(it, answers)),
  ]);
}

/** Map submitted `item:{id}` fields to {item_id: answer text} (MCQ index → option text). */
function collectAnswers(items: FormItem[], fields: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    const raw = fields.get(`item:${it.item_id}`);
    if (raw === undefined) continue;
    if (it.type === 'MCQ') {
      const opt = optionsOf(it)[Number(raw)];
      if (opt !== undefined) out[String(it.item_id)] = opt;
    } else {
      out[String(it.item_id)] = raw.trim();
    }
  }
  return out;
}

/** Answers to prefill the wizard with: draft first, else the stored signup. */
function prefillAnswers(
  draft: DraftRow | null,
  existing: SignupRow | null,
): Record<string, string> {
  if (draft) return parseJson<Record<string, string>>(draft.partial_answers_json, {});
  if (existing) {
    return {
      ...answersOf(existing),
      [LINK_KEY]: existing.list_url,
      [PICKS_KEY]: String(existing.max_recos),
    };
  }
  return {};
}

// ------------------------------------------------------------ wizard steps

/** [📝 Sign Up/Edit] → Modal A, prefilled from draft ?? existing signup —
 *  one button covers first-time signup and edits alike. */
export async function signupStart(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') {
    return stale(c, e && ['MATCHING', 'PREPARING', 'RECOMMENDING', 'LAUNCHING', 'RUNNING', 'CLOSING', 'REVEALED'].includes(e.state)
      ? 'Sign-ups are closed.' : 'No sign-up is open right now.');
  }
  const existing = await getSignup(c.env, e.event_id, c.userId);
  if (!existing) {
    const n = await countSignups(c.env, e.event_id);
    if (n >= c.cfg.maxParticipants) {
      return respond.ephemeral({ content: `⚠ The event is full (**${c.cfg.maxParticipants}** participants).` });
    }
  }
  const items = await getItems(c.env, e.event_id);
  const draft = await loadDraft(c, e.event_id);
  return modalA(e, items, prefillAnswers(draft, existing));
}

/**
 * Modal A submit — pure D1 work (no search anymore), so it responds directly:
 * link validation error, the Continue (2/2) step, or the summary card.
 * Opened from the panel (public message) → fresh ephemeral; opened from a
 * wizard button (flags 64) → update that ephemeral in place (§13.1).
 */
export async function signupModalA(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const items = await getItems(c.env, e.event_id);
  const fields = modalFields(c.i.data?.components);
  const rawLink = (fields.get(LINK_KEY) ?? '').trim();
  const prevDraft = await loadDraft(c, e.event_id);
  const answers = {
    ...parseJson<Record<string, string>>(prevDraft?.partial_answers_json ?? null, {}),
    ...collectAnswers(itemsA(items), fields),
    [LINK_KEY]: rawLink,
  };
  const fromEphemeral = ((c.i.message?.flags ?? 0) & 64) !== 0;
  const reply = (payload: Record<string, unknown>) =>
    fromEphemeral ? respond.update(payload) : respond.ephemeral(payload);

  const link = normalizeListUrl(rawLink);
  if (!link) {
    await saveDraft(c, e.event_id, { step: 'A_DONE', partial_answers_json: JSON.stringify(answers) });
    return reply({
      content:
        '⚠ That doesn\'t look like a MAL/AniList link. Use your profile or list URL, e.g.\n' +
        '`https://myanimelist.net/profile/you` · `https://myanimelist.net/animelist/you` · `https://anilist.co/user/you`',
      embeds: [],
      components: [row(
        btn('ax:signup_again', '✏ Fix my sign-up', Style.PRIMARY),
        // Escape hatch for lists that live elsewhere — kept as typed.
        ...(rawLink ? [btn('ax:signup_force', '⚠ Proceed anyway', Style.DANGER)] : []),
      )],
    });
  }
  answers[LINK_KEY] = link;
  await saveDraft(c, e.event_id, { step: 'A_DONE', partial_answers_json: JSON.stringify(answers) });
  return reply(nextStep(e, items, answers));
}

/** After step 1 is stored: the Continue (2/2) prompt, or straight to summary. */
function nextStep(e: EventRow, items: FormItem[], answers: Record<string, string>): Record<string, unknown> {
  if (itemsB(items).length > 0) {
    return {
      content: `🔗 List saved — one more step for the remaining questions.`,
      embeds: [],
      components: [row(
        btn('ax:signup_cont', 'Continue (2/2)', Style.PRIMARY),
        btn('ax:signup_again', '✏ Back to step 1'),
      )],
    };
  }
  return summaryCard(e, items, answers);
}

/** [⚠ Proceed anyway] — keep the non-MAL/AniList link exactly as typed. */
export async function signupForce(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  const answers = parseJson<Record<string, string>>(draft?.partial_answers_json ?? null, {});
  if (!draft || !(answers[LINK_KEY] ?? '').trim()) {
    return respond.update({ content: '⏳ This wizard expired — press **📝 Sign Up/Edit** to start again.', embeds: [], components: [] });
  }
  const items = await getItems(c.env, e.event_id);
  return respond.update(nextStep(e, items, answers));
}

/** [Continue (2/2)] → Modal B prefilled. */
export async function signupContinue(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  if (!draft) {
    return respond.ephemeral({ content: '⏳ This wizard expired — press **📝 Sign Up/Edit** to start again.' });
  }
  const items = await getItems(c.env, e.event_id);
  const existing = await getSignup(c.env, e.event_id, c.userId);
  const answers = {
    ...(existing ? answersOf(existing) : {}),
    ...parseJson<Record<string, string>>(draft.partial_answers_json, {}),
  };
  return modalB(items, answers);
}

/** Modal B submit → merged answers → summary card (type 7 swaps the wizard message). */
export async function signupModalB(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  if (!draft) {
    return respond.ephemeral({ content: '⏳ This wizard expired — press **📝 Sign Up/Edit** to start again.' });
  }
  const items = await getItems(c.env, e.event_id);
  const answers = {
    ...parseJson<Record<string, string>>(draft.partial_answers_json, {}),
    ...collectAnswers(itemsB(items), modalFields(c.i.data?.components)),
  };
  await saveDraft(c, e.event_id, { ...draft, step: 'B_DONE', partial_answers_json: JSON.stringify(answers) });
  return respond.update(summaryCard(e, items, answers));
}

/** [✏ Fix my sign-up / Back to step 1] → Modal A with previous values prefilled. */
export async function signupAgain(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  const existing = await getSignup(c.env, e.event_id, c.userId);
  const items = await getItems(c.env, e.event_id);
  return modalA(e, items, prefillAnswers(draft, existing));
}

/** [↺ Start Over] → wipe the draft → blank Modal A. */
export async function signupRestart(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  await deleteDraft(c, e.event_id);
  const items = await getItems(c.env, e.event_id);
  return modalA(e, items, {});
}

// How many anime the participant is willing to receive — their own call,
// travelling through the wizard next to the answers.
const PICKS_KEY = 'picks';

const picksOf = (answers: Record<string, string>, fallback: number): number => {
  const n = parseInt(answers[PICKS_KEY] ?? '', 10);
  return n >= 1 && n <= 5 ? n : Math.min(5, Math.max(1, fallback));
};

function summaryCard(
  e: EventRow, items: FormItem[], answers: Record<string, string>,
): Record<string, unknown> {
  const link = answers[LINK_KEY] ?? '—';
  const offSite = link !== '—' && !normalizeListUrl(link) ? ' ⚠ *(not a MAL/AniList link)*' : '';
  const picks = picksOf(answers, e.max_recos);
  return {
    content: 'Almost done — confirm your sign-up:',
    embeds: [embed({
      title: '📝 Your sign-up',
      description:
        `**Your list:** ${link}${offSite}\n*Your Secret Santa studies this to pick your anime.*\n\n` +
        `**Anime you want:** at most **${picks}** — your Secret Santa may send fewer.`,
      fields: items.map((it) => ({
        name: `${it.label}${it.visible_to_recommender ? ' 👁' : ' 🔒'}`,
        value: answers[String(it.item_id)] || '—',
      })),
      footer: '👁 = shown to your Secret Santa when they pick for you',
    })],
    components: [
      row(stringSelect('ax:signup_picks', 'How many anime do you want?',
        [1, 2, 3, 4, 5].map((n) => ({
          label: n === 1 ? '1 anime' : `up to ${n} anime`,
          value: String(n),
          default: n === picks,
        })))),
      row(
        btn('ax:signup_confirm', '✅ Confirm Sign-Up', Style.SUCCESS),
        btn('ax:signup_restart', '↺ Start Over'),
      ),
    ],
  };
}

/** The picks select under the summary card. */
export async function signupPicks(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  if (!draft) {
    return respond.update({ content: '⏳ This wizard expired — press **📝 Sign Up/Edit** to start again.', embeds: [], components: [] });
  }
  const answers = parseJson<Record<string, string>>(draft.partial_answers_json, {});
  answers[PICKS_KEY] = c.i.data?.values?.[0] ?? String(e.max_recos);
  await saveDraft(c, e.event_id, { ...draft, partial_answers_json: JSON.stringify(answers) });
  const items = await getItems(c.env, e.event_id);
  return respond.update(summaryCard(e, items, answers));
}

/** [✅ Confirm Sign-Up] → upsert signup + sheet row + throttled panel count. */
export async function signupConfirm(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups closed before you confirmed — sorry!');
  const draft = await loadDraft(c, e.event_id);
  const answers = parseJson<Record<string, string>>(draft?.partial_answers_json ?? null, {});
  const raw = (answers[LINK_KEY] ?? '').trim();
  // An off-site link is only reachable via [⚠ Proceed anyway] — keep it as typed.
  const link = normalizeListUrl(raw) ?? truncate(raw, 300);
  if (!draft || !link) {
    return respond.update({ content: '⏳ This wizard expired — press **📝 Sign Up/Edit** to start again.', embeds: [], components: [] });
  }
  const picks = picksOf(answers, e.max_recos);
  const itemAnswers = { ...answers };
  delete itemAnswers[LINK_KEY];
  delete itemAnswers[PICKS_KEY];
  const username = sanitizeName(c.i.member?.user.username ?? '', 40);
  bg(c, async () => {
    const existing = await getSignup(c.env, e.event_id, c.userId);
    if (!existing) {
      const n = await countSignups(c.env, e.event_id);
      if (n >= c.cfg.maxParticipants) {
        await editOriginal(c.env, c.i.token, {
          content: `⚠ The event filled up (**${c.cfg.maxParticipants}**) before you confirmed.`,
          embeds: [], components: [],
        });
        return;
      }
    }
    await c.env.DB.prepare(
      `INSERT INTO signups (event_id, user_id, display_name, username, list_url, max_recos,
         answers_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT(event_id, user_id) DO UPDATE SET
         display_name = excluded.display_name, username = excluded.username,
         list_url = excluded.list_url, max_recos = excluded.max_recos,
         answers_json = excluded.answers_json, updated_at = excluded.updated_at`,
    ).bind(e.event_id, c.userId, c.displayName, username, link, picks,
      JSON.stringify(itemAnswers), now()).run();
    await deleteDraft(c, e.event_id);

    let sheetNote = '';
    try {
      const items = await getItems(c.env, e.event_id);
      const ordered = await orderedSignups(c.env, e.event_id);
      await rewriteSheet(c.env, c.guild, e, items, ordered);
    } catch (err) {
      console.error('sheet upsert failed (reconciled at Validate)', err);
      sheetNote = '\n*(sheet update pending — the manager\'s Validate reconciles it)*';
    }
    await throttledCountRepaint(c, e.event_id);
    await editOriginal(c.env, c.i.token, {
      content:
        `🎉 **You're in!** Your Secret Santa will recommend ${picks > 1 ? `up to **${picks}** anime` : 'an anime'} for you. ` +
        `You can update your sign-up or withdraw until sign-ups close.${sheetNote}`,
      embeds: [], components: [],
    });
  });
  return respond.deferUpdate();
}

// ------------------------------------------------------------------- score
// The ⭐ button on the assignment card (private thread). Scores are keyed to
// the clicking user's own signup (§13.2 — never trusted from the payload),
// so it always rates the anime *they* were given, out of 10.

const SCORE_STATES = ['LAUNCHING', 'RUNNING'] as const;

/** The participant's own anime, in slot order (max 5 — one modal select each). */
async function myRecos(c: HCtx, eventId: number, signupId: number): Promise<RecoRow[]> {
  const res = await c.env.DB
    .prepare('SELECT * FROM recos WHERE event_id = ?1 AND signup_id = ?2 ORDER BY slot')
    .bind(eventId, signupId).all<RecoRow>();
  return activeRecos(res.results);
}

export async function scoreModal(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || !SCORE_STATES.includes(e.state as (typeof SCORE_STATES)[number])) {
    return stale(c, e && ['CLOSING', 'REVEALED'].includes(e.state)
      ? 'Reviews are closed — scores are locked in.' : 'Scoring is open while the event is running.');
  }
  const me = await getSignup(c.env, e.event_id, c.userId);
  if (!me) return respond.ephemeral({ content: 'Only participants can score their given anime.' });
  const mine = await myRecos(c, e.event_id, me.signup_id);
  if (mine.length === 0) return respond.ephemeral({ content: 'You have no anime to score yet.' });
  // One select per anime (≤5 = the modal cap); each optional, so people can
  // score what they've finished and come back for the rest.
  return respond.modal('axm:score', mine.length > 1 ? 'Score your anime' : 'Score your given anime',
    mine.map((r) => modalSelect(`score:${r.reco_id}`, truncate(r.title ?? 'Your anime', 45), [
      { label: '— no score —', value: '0', default: r.score === null },
      ...Array.from({ length: 10 }, (_, i) => 10 - i).map((n) => ({
        label: `${'⭐'.repeat(Math.ceil(n / 2))} ${n} / 10`,
        value: String(n),
        default: r.score === n,
      })),
    ], {
      required: false,
      placeholder: r.score !== null ? `Current: ${r.score}/10` : 'Pick a score…',
    })),
  );
}

export async function scoreSubmit(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || !SCORE_STATES.includes(e.state as (typeof SCORE_STATES)[number])) {
    return stale(c, 'Reviews are closed — scores are locked in.');
  }
  const me = await getSignup(c.env, e.event_id, c.userId);
  if (!me) return respond.ephemeral({ content: 'Only participants can score their given anime.' });
  const mine = await myRecos(c, e.event_id, me.signup_id);
  const fields = modalFields(c.i.data?.components);
  const updates: RecoRow[] = [];
  for (const r of mine) {
    const raw = fields.get(`score:${r.reco_id}`);
    if (raw === undefined || raw === '') continue;          // left untouched
    const v = parseInt(raw, 10);
    if (!(v >= 0 && v <= 10)) continue;
    const score = v === 0 ? null : v;                        // 0 = clear it
    if (score === r.score) continue;
    updates.push({ ...r, score });
  }
  if (updates.length === 0) {
    return respond.ephemeral({ content: '⭐ Nothing changed — your scores stay as they were.' });
  }
  await c.env.DB.batch(updates.map((r) =>
    c.env.DB.prepare('UPDATE recos SET score = ?1, updated_at = ?2 WHERE reco_id = ?3')
      .bind(r.score, now(), r.reco_id)));
  bg(c, async () => {
    if (me.row_order !== null) {
      // Best-effort sheet cells; a job's self-heal rewrite fixes any failure.
      const items = await getItems(c.env, e.event_id);
      // Scores sit in the live-pick columns, so pass the full ordered list.
      const live = await myRecos(c, e.event_id, me.signup_id);
      await writeScoreCells(c.env, c.guild, e, items, me.row_order, live, Math.max(me.max_recos, live.length)).catch((err) => {
        console.error('score cell write failed (self-heal will fix)', err);
      });
    }
    const saved = updates
      .map((r) => `**${r.title}** ${r.score === null ? '— cleared' : `**${r.score}/10**`}`)
      .join(' · ');
    await editOriginal(c.env, c.i.token, {
      content: `⭐ Saved — ${saved}. You can change scores until reviews close.`,
    });
  });
  return respond.deferEphemeral();
}

// ----------------------------------------------------------------- withdraw

export async function withdraw(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Withdrawing is only possible while sign-ups are open — ask a manager.');
  const existing = await getSignup(c.env, e.event_id, c.userId);
  if (!existing) return respond.ephemeral({ content: 'You are not signed up.' });
  return respond.ephemeral({
    content: `🚪 Withdraw from **${e.topic}**? Your sign-up (list link + answers) will be deleted.`,
    components: [row(btn('ax:withdraw:go', 'Confirm — withdraw', Style.DANGER), btn('ax:cancel', 'Cancel'))],
  });
}

export async function withdrawGo(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups already closed — ask a manager to remove you (Validate flow).');
  bg(c, async () => {
    await c.env.DB.prepare('DELETE FROM signups WHERE event_id = ?1 AND user_id = ?2')
      .bind(e.event_id, c.userId).run();
    await deleteDraft(c, e.event_id);
    try {
      const items = await getItems(c.env, e.event_id);
      const ordered = await orderedSignups(c.env, e.event_id);
      await rewriteSheet(c.env, c.guild, e, items, ordered);
    } catch (err) {
      console.error('sheet rewrite on withdraw failed', err);
    }
    await throttledCountRepaint(c, e.event_id);
    await editOriginal(c.env, c.i.token, { content: '🚪 You\'ve withdrawn from the event.', components: [] });
  });
  return respond.deferUpdate();
}
