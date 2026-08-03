// Two-step signup wizard (spec §6.2, decision #3): Modal A (keyword + items
// 1–4) → MAL picker → Modal B (items 5–9) → summary card → confirm. Wizard
// progress lives in signup_drafts because every modal/select is a separate
// stateless interaction; drafts expire after 30 minutes.

import type { AnimeCandidate } from '../mal';
import { searchAnime } from '../mal';
import type { DraftRow, FormItem } from '../types';
import { modalFields } from '../types';
import { btn, editOriginal, embed, linkBtn, modalSelect, modalText, respond, row, stringSelect, Style } from '../discord';
import { answersOf, countSignups, getItems, getSignup, optionsOf, orderedSignups } from '../db';
import { rewriteSheet } from '../sheet';
import { now, truncate } from '../util';
import { bg, HCtx, repaint, stale, throttledCountRepaint } from './common';

const DRAFT_TTL = 30 * 60;

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
  if (it.type === 'MCQ') {
    return modalSelect(`item:${it.item_id}`, it.label, optionsOf(it).map((o, idx) => ({
      label: o, value: String(idx), default: prev === o,
    })));
  }
  return modalText(`item:${it.item_id}`, it.label, { paragraph: true, value: prev ?? '', max: 500 });
}

function modalA(items: FormItem[], keyword: string, answers: Record<string, string>): Response {
  return respond.modal('axm:signup_a', 'Sign up — step 1', [
    modalText('kw', 'Anime title keyword (English or Japanese)', {
      value: keyword, max: 100, placeholder: 'e.g. Frieren / 葬送のフリーレン',
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

// ------------------------------------------------------------ wizard steps

/** [📝 Sign Up] / [✏ Edit My Sign-Up] → Modal A, prefilled from draft ?? existing signup. */
export async function signupStart(c: HCtx, editing: boolean): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') {
    return stale(c, e && ['MATCHING', 'LAUNCHING', 'RUNNING', 'CLOSING', 'REVEALED'].includes(e.state)
      ? 'Sign-ups are closed.' : 'No sign-up is open right now.');
  }
  const existing = await getSignup(c.env, e.event_id, c.userId);
  if (editing && !existing) {
    return respond.ephemeral({ content: 'You haven\'t signed up yet — press **📝 Sign Up** instead.' });
  }
  if (!editing && !existing) {
    const n = await countSignups(c.env, e.event_id);
    if (n >= c.cfg.maxParticipants) {
      return respond.ephemeral({ content: `⚠ The event is full (**${c.cfg.maxParticipants}** participants).` });
    }
  }
  const items = await getItems(c.env, e.event_id);
  const draft = await loadDraft(c, e.event_id);
  const answers = draft
    ? parseJson<Record<string, string>>(draft.partial_answers_json, {})
    : existing ? answersOf(existing) : {};
  const keyword = draft?.keyword ?? existing?.anime_title ?? '';
  return modalA(items, keyword, answers);
}

/** Modal A submit → deferred ephemeral → MAL search → picker (§13.1 row 3). */
export async function signupModalA(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const items = await getItems(c.env, e.event_id);
  const fields = modalFields(c.i.data?.components);
  const keyword = (fields.get('kw') ?? '').trim();
  const prevDraft = await loadDraft(c, e.event_id);
  const answers = {
    ...parseJson<Record<string, string>>(prevDraft?.partial_answers_json ?? null, {}),
    ...collectAnswers(itemsA(items), fields),
  };
  // Opened from the panel (public message) → new deferred ephemeral. Opened
  // from a wizard button ([Search again], flags 64) → update that message in
  // place; type 6/7 on a panel-sourced modal would edit the shared panel.
  const fromEphemeral = ((c.i.message?.flags ?? 0) & 64) !== 0;
  bg(c, async () => {
    if (!keyword) {
      await editOriginal(c.env, c.i.token, {
        content: '⚠ Enter an anime title keyword.',
        components: [row(btn('ax:signup_again', '🔍 Search again', Style.PRIMARY))],
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
      step: 'A_DONE',
      keyword,
      partial_answers_json: JSON.stringify(answers),
      candidates_json: JSON.stringify(candidates),
      chosen_json: prevDraft?.chosen_json ?? null,
    });
    if (searchFailed) {
      await editOriginal(c.env, c.i.token, {
        content: '⚠ Search is temporarily unavailable — try again in a minute.',
        embeds: [],
        components: [row(btn('ax:signup_again', '🔍 Search again', Style.PRIMARY))],
      });
      return;
    }
    if (candidates.length === 0) {
      await editOriginal(c.env, c.i.token, {
        content: `😶 No MAL matches for **${truncate(keyword, 80)}**. Try another spelling (English or Japanese both work).`,
        embeds: [],
        components: [row(btn('ax:signup_again', '🔍 Search again', Style.PRIMARY))],
      });
      return;
    }
    await editOriginal(c.env, c.i.token, {
      content: `🔎 Results for **${truncate(keyword, 80)}** — pick your anime:`,
      embeds: [],
      components: [
        row(stringSelect('ax:signup_pick', 'Pick your anime…', candidates.map((a, idx) => ({
          label: `${a.title} (${a.year ?? '?'} · ${a.type ?? '?'} · ${a.episodes ?? '?'} eps)`,
          value: String(idx),
          description: a.title_en ?? a.title_jp ?? undefined,
        })))),
        row(btn('ax:signup_again', '🔍 Search again')),
      ],
    });
  });
  return fromEphemeral ? respond.deferUpdate() : respond.deferEphemeral();
}

/** Picker select → store choice → Continue (2/2) or summary card. */
export async function signupPick(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  const candidates = parseJson<AnimeCandidate[]>(draft?.candidates_json ?? null, []);
  const chosen = candidates[Number(c.i.data?.values?.[0] ?? -1)];
  if (!draft || !chosen) {
    return respond.update({
      content: '⏳ This wizard expired — press **📝 Sign Up** on the panel to start again.',
      embeds: [], components: [],
    });
  }
  await saveDraft(c, e.event_id, { ...draft, step: 'PICKED', chosen_json: JSON.stringify(chosen) });
  const items = await getItems(c.env, e.event_id);
  if (itemsB(items).length > 0) {
    return respond.update({
      content: `🎬 **${chosen.title}** (${chosen.year ?? '?'}) — one more step for the remaining questions.`,
      embeds: [],
      components: [row(
        btn('ax:signup_cont', 'Continue (2/2)', Style.PRIMARY),
        btn('ax:signup_again', '🔍 Search again'),
      )],
    });
  }
  return respond.update(await summaryCard(c, e.event_id, items, { ...draft, chosen_json: JSON.stringify(chosen) }));
}

/** [Continue (2/2)] → Modal B prefilled. */
export async function signupContinue(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  if (!draft || !draft.chosen_json) {
    return respond.ephemeral({ content: '⏳ This wizard expired — press **📝 Sign Up** to start again.' });
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
  if (!draft || !draft.chosen_json) {
    return respond.ephemeral({ content: '⏳ This wizard expired — press **📝 Sign Up** to start again.' });
  }
  const items = await getItems(c.env, e.event_id);
  const answers = {
    ...parseJson<Record<string, string>>(draft.partial_answers_json, {}),
    ...collectAnswers(itemsB(items), modalFields(c.i.data?.components)),
  };
  const merged = { ...draft, step: 'B_DONE' as const, partial_answers_json: JSON.stringify(answers) };
  await saveDraft(c, e.event_id, merged);
  return respond.update(await summaryCard(c, e.event_id, items, merged));
}

/** [🔍 Search again] → Modal A with previous values prefilled. */
export async function signupAgain(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  const items = await getItems(c.env, e.event_id);
  return modalA(items, draft?.keyword ?? '', parseJson<Record<string, string>>(draft?.partial_answers_json ?? null, {}));
}

/** [↺ Start Over] → wipe the draft (keep the keyword as a convenience) → Modal A. */
export async function signupRestart(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups are not open.');
  const draft = await loadDraft(c, e.event_id);
  const keyword = draft?.keyword ?? '';
  await deleteDraft(c, e.event_id);
  const items = await getItems(c.env, e.event_id);
  return modalA(items, keyword, {});
}

async function summaryCard(
  c: HCtx, eventId: number, items: FormItem[], draft: Pick<DraftRow, 'chosen_json' | 'partial_answers_json'>,
): Promise<Record<string, unknown>> {
  const chosen = parseJson<AnimeCandidate | null>(draft.chosen_json, null)!;
  const answers = parseJson<Record<string, string>>(draft.partial_answers_json, {});
  return {
    content: 'Almost done — confirm your sign-up:',
    embeds: [embed({
      title: `${chosen.title}${chosen.year ? ` (${chosen.year})` : ''}`,
      url: chosen.url,
      description: [
        chosen.title_en && chosen.title_en !== chosen.title ? chosen.title_en : null,
        `${chosen.type ?? '?'} · ${chosen.episodes ?? '?'} episodes · [MAL](${chosen.url})`,
      ].filter(Boolean).join('\n'),
      thumbnail: chosen.image ?? undefined,
      fields: items.map((it) => ({
        name: `${it.label}${it.visible_to_recommender ? ' 👁' : ' 🔒'}`,
        value: answers[String(it.item_id)] || '—',
      })),
      footer: '👁 = shown to whoever receives your recommendation',
    })],
    components: [row(
      btn('ax:signup_confirm', '✅ Confirm Sign-Up', Style.SUCCESS),
      btn('ax:signup_restart', '↺ Start Over'),
    )],
  };
}

/** [✅ Confirm Sign-Up] → upsert signup + sheet row + throttled panel count. */
export async function signupConfirm(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Sign-ups closed before you confirmed — sorry!');
  const draft = await loadDraft(c, e.event_id);
  const chosen = parseJson<AnimeCandidate | null>(draft?.chosen_json ?? null, null);
  if (!draft || !chosen) {
    return respond.update({ content: '⏳ This wizard expired — press **📝 Sign Up** to start again.', embeds: [], components: [] });
  }
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
      `INSERT INTO signups (event_id, user_id, display_name, mal_id, anime_title, anime_title_en,
         anime_year, anime_type, anime_episodes, anime_url, anime_image, answers_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
       ON CONFLICT(event_id, user_id) DO UPDATE SET
         display_name = excluded.display_name, mal_id = excluded.mal_id,
         anime_title = excluded.anime_title, anime_title_en = excluded.anime_title_en,
         anime_year = excluded.anime_year, anime_type = excluded.anime_type,
         anime_episodes = excluded.anime_episodes, anime_url = excluded.anime_url,
         anime_image = excluded.anime_image, answers_json = excluded.answers_json,
         updated_at = excluded.updated_at`,
    ).bind(
      e.event_id, c.userId, c.displayName, chosen.mal_id, chosen.title, chosen.title_en,
      chosen.year, chosen.type, chosen.episodes, chosen.url, chosen.image,
      draft.partial_answers_json ?? '{}', now(),
    ).run();
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
      content: `🎉 **You're in!** Submitted **${chosen.title}**. You can edit or withdraw until sign-ups close.${sheetNote}`,
      embeds: [], components: [],
    });
  });
  return respond.deferUpdate();
}

// ----------------------------------------------------------------- withdraw

export async function withdraw(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e || e.state !== 'SIGNUP_OPEN') return stale(c, 'Withdrawing is only possible while sign-ups are open — ask a manager.');
  const existing = await getSignup(c.env, e.event_id, c.userId);
  if (!existing) return respond.ephemeral({ content: 'You are not signed up.' });
  return respond.ephemeral({
    content: `🚪 Withdraw from **${e.topic}**? Your submission (**${existing.anime_title}**) will be deleted.`,
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
