// Manager interactions (spec §5): draft builder, sign-up window, matching,
// launch/close/finish. Every irreversible action goes through an ephemeral
// [Confirm]/[Cancel] step; participant-scaling fan-outs are enqueued as jobs,
// never run inline (§13.1).

import type { EventRow, FormItem } from '../types';
import { modalFields } from '../types';
import {
  btn, deleteMessage, editOriginal, embed, linkBtn, modalSelect, modalText, respond,
  row, stringSelect, Style,
} from '../discord';
import {
  activeRecos, finalRecos, getItems, countSignups, dbBatchChunked, loopContext, optionsOf,
  orderedSignups, pendingRecos, recosOf, transition,
} from '../db';
import { repostPanels } from '../panels';
import { LINK_DESC_DEFAULT, LINK_LABEL_DEFAULT } from './signup';
import { createSpreadsheet, isConnected, sheetUrl } from '../google';
// Sheet writes before the recommendation phase carry no slots (none exist
// yet); anything after it goes through rewriteSheetFromDb.
import { rewriteSheet, rewriteSheetFromDb, writeHeader } from '../sheet';
import { adoptSignupOrder, runValidate, validateReport } from '../validate';
import {
  dealSizes, epochToZoned, isValidTz, now, randomHex, shuffled, ts, zonedToEpoch,
} from '../util';
import { bg, HCtx, repaint, stale } from './common';

const MAX_ITEMS = 8; // 2 modals × 5 fields − picks select − list link
// Pre-filled in the Set Basics / Launch timezone fields (still editable).
const DEFAULT_TZ = 'America/Chicago';

// --------------------------------------------------------------- helpers

function confirm(text: string, confirmId: string, confirmLabel: string, style: number = Style.DANGER): Response {
  return respond.ephemeral({
    content: text,
    components: [row(btn(confirmId, confirmLabel, style), btn('ax:cancel', 'Cancel'))],
  });
}

function needState(c: HCtx, ...states: EventRow['state'][]): EventRow | null {
  if (c.event && states.includes(c.event.state)) return c.event;
  return null;
}

async function enqueueJob(c: HCtx, eventId: number, kind: string, payload: Record<string, unknown> = {}): Promise<boolean> {
  try {
    await c.env.DB.prepare(
      'INSERT INTO jobs (event_id, kind, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(eventId, kind, JSON.stringify(payload), now()).run();
    return true;
  } catch {
    return false; // partial unique index: one active job per (event, kind) — §7.4
  }
}

/** Recommendation progress in PEOPLE (accepted / owing a reply / empty-handed)
 *  plus the same story in PICKS (accepted vs. the total everyone asked for). */
async function peopleCounts(c: HCtx, eventId: number): Promise<{
  total: number; accepted: number; pending: number; nothing: number;
  picks: number; wanted: number;
}> {
  const r = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM recos x WHERE x.signup_id = s.signup_id AND x.status = 'FINAL') THEN 1 ELSE 0 END), 0) AS accepted,
       COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM recos x WHERE x.signup_id = s.signup_id AND x.status = 'PENDING') THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM recos x WHERE x.signup_id = s.signup_id AND x.status != 'DECLINED') THEN 1 ELSE 0 END), 0) AS awaiting,
       COALESCE(SUM((SELECT COUNT(*) FROM recos x WHERE x.signup_id = s.signup_id AND x.status = 'FINAL')), 0) AS picks,
       COALESCE(SUM(s.max_recos), 0) AS wanted
     FROM signups s WHERE s.event_id = ?1`,
  ).bind(eventId).first<{
    total: number; accepted: number; pending: number; awaiting: number;
    picks: number; wanted: number;
  }>();
  return {
    total: r?.total ?? 0, accepted: r?.accepted ?? 0,
    pending: r?.pending ?? 0, nothing: r?.awaiting ?? 0,
    picks: r?.picks ?? 0, wanted: r?.wanted ?? 0,
  };
}

// ----------------------------------------------------------- IDLE actions

export async function newEvent(c: HCtx): Promise<Response> {
  if (c.event) return stale(c, 'An event already exists.');
  try {
    await c.env.DB.prepare(
      "INSERT INTO events (guild_id, state, created_at, updated_at) VALUES (?1, 'DRAFTING', ?2, ?2)",
    ).bind(c.guild.guild_id, now()).run();
  } catch {
    return stale(c, 'An event already exists.');
  }
  bg(c, async () => {
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: '🆕 Draft created — press **⚙ Set Basics** on the manager panel.',
    });
  });
  return respond.deferEphemeral();
}

export async function connectGoogle(c: HCtx): Promise<Response> {
  const state = randomHex(16);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?1').bind(now()),
    c.env.DB.prepare('INSERT INTO oauth_states (state, guild_id, user_id, expires_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(state, c.guild.guild_id, c.userId, now() + 600),
  ]);
  const origin = new URL(c.env.GOOGLE_REDIRECT_URI).origin;
  return respond.ephemeral({
    content:
      '🔗 Connect the Google account that should own the event sheet and review docs.\n' +
      `Scope is limited to files this app creates (\`drive.file\`). Link valid **10 minutes**.`,
    components: [row(linkBtn(`${origin}/google/oauth/start?state=${state}`, 'Open Google consent'))],
  });
}

// ------------------------------------------------------------ DRAFTING

export function basicsModal(c: HCtx): Response {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  // The sign-up deadline and timezone live in the Open Sign-Ups modal — they
  // are the act of opening, not part of the draft's identity.
  return respond.modal('axm:basics', 'Event basics', [
    modalText('topic', 'Session', {
      value: e.topic ?? '', max: 100, placeholder: 'Fall 2026 Exchange',
      description: 'The name of this event',
    }),
    modalText('theme', 'Theme (optional)', {
      required: false, value: e.theme ?? '', max: 100,
      placeholder: 'Nostalgia / hidden gems / movies only…',
      description: 'What the picks should aim for — shown to everyone',
    }),
    modalText('declines', 'Sorry😞 budget per person (0–9)', {
      value: String(e.max_declines), max: 1,
      description: 'How many recommendations each participant may send back',
    }),
  ]);
}

export async function basicsSubmit(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const f = modalFields(c.i.data?.components);
  const topic = (f.get('topic') ?? '').trim();
  const theme = (f.get('theme') ?? '').trim().slice(0, 100) || null;
  const declinesRaw = (f.get('declines') ?? '').trim();
  if (!topic) return respond.ephemeral({ content: '⚠ The Session name cannot be empty.' });
  if (!/^[0-9]$/.test(declinesRaw)) {
    return respond.ephemeral({ content: '⚠ The Sorry😞 budget must be a single digit **0–9**. Reopen **Set Basics** and try again.' });
  }
  const maxDeclines = parseInt(declinesRaw, 10);
  await c.env.DB.prepare(
    'UPDATE events SET topic = ?1, theme = ?2, max_declines = ?3, updated_at = ?4 WHERE event_id = ?5',
  ).bind(topic, theme, maxDeclines, now(), e.event_id).run();
  bg(c, async () => {
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content:
        `✅ Basics saved — **${topic}**${theme ? ` · theme **${theme}**` : ''}, ` +
        `**${maxDeclines}** decline(s) per person.`,
    });
  });
  return respond.deferEphemeral();
}

/**
 * [⏰ Auto-stop] toggle — one flag, three phases: sign-ups close themselves at
 * the sign-up deadline, the recommendation phase locks every ⏳ pending pick at
 * the recommendation deadline, and RUNNING closes reviews at the review
 * deadline. Launching always stays manual (it's the irreversible one).
 */
export async function autostopToggle(c: HCtx): Promise<Response> {
  const e = needState(c, 'SIGNUP_OPEN', 'RECOMMENDING', 'RUNNING');
  if (!e) return stale(c);
  const nv = e.auto_stop ? 0 : 1;
  await c.env.DB.prepare('UPDATE events SET auto_stop = ?1, updated_at = ?2 WHERE event_id = ?3')
    .bind(nv, now(), e.event_id).run();
  const what = e.state === 'SIGNUP_OPEN'
    ? { on: 'sign-ups close automatically at the deadline', off: 'you close sign-ups manually' }
    : e.state === 'RECOMMENDING'
      ? { on: 'pending picks lock in automatically at the recommendation deadline', off: 'pending picks wait for you to Launch' }
      : { on: 'reviews close automatically at the review deadline — docs flip read-only, reveals and the gallery post', off: 'you press 🏁 Close Reviews yourself' };
  bg(c, async () => {
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: nv ? `⏰ **Auto-stop ON** — ${what.on}.` : `⏰ **Auto-stop OFF** — ${what.off}.`,
    });
  });
  return respond.deferEphemeral();
}

function itemModal(customId: string, item?: FormItem): Response {
  const opts = item ? optionsOf(item) : [];
  // New items default to 👁 visible; editing keeps the stored setting.
  const visible = item ? !!item.visible_to_recommender : true;
  return respond.modal(customId, item ? 'Edit form item' : 'Add form item', [
    modalText('label', 'Question label', { value: item?.label ?? '', max: 100, placeholder: 'Favorite genre' }),
    modalText('desc', 'Description (optional)', {
      required: false, value: item?.description ?? '', max: 100,
      placeholder: 'e.g. Pick the genre you watch the most',
      description: 'Shown under the question on the sign-up form',
    }),
    modalSelect('type', 'Type', [
      { label: 'Fill-in (free text)', value: 'FIB', default: (item?.type ?? 'FIB') === 'FIB' },
      { label: 'Multiple choice (2–10 options)', value: 'MCQ', default: item?.type === 'MCQ' },
    ]),
    modalText('options', 'MCQ options — one per line', {
      required: false, paragraph: true, value: opts.join('\n'), max: 1000,
      description: 'Only used for multiple choice',
    }),
    modalSelect('visibility', 'Who sees the answer?', [
      { label: '👁 Visible to your recommender', value: '1', default: visible },
      { label: '🔒 Hidden (manager sheet only)', value: '0', default: !visible },
    ]),
  ]);
}

export async function itemAdd(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const items = await getItems(c.env, e.event_id);
  if (items.length >= MAX_ITEMS) {
    return respond.ephemeral({ content: `⚠ Custom item cap is **${MAX_ITEMS}** — that is what fits the two-step signup flow (2 modals × 5 inputs, minus the built-in MAL/AniList link).` });
  }
  return itemModal('axm:item:new');
}

export async function itemEditModal(c: HCtx, itemId: string): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  if (itemId === 'link') return linkItemModal(e);
  const item = await c.env.DB.prepare('SELECT * FROM form_items WHERE item_id = ?1 AND event_id = ?2')
    .bind(Number(itemId), e.event_id).first<FormItem>();
  if (!item) return stale(c, 'That item no longer exists.');
  return itemModal(`axm:item:${item.item_id}`, item);
}

export async function itemSubmit(c: HCtx, arg: string): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  if (arg === 'link') return linkItemSubmit(c, e);
  const f = modalFields(c.i.data?.components);
  const label = (f.get('label') ?? '').trim();
  const type = f.get('type') === 'MCQ' ? 'MCQ' : 'FIB';
  const description = (f.get('desc') ?? '').trim().slice(0, 100) || null;
  const visibility = f.get('visibility') === '1' ? 1 : 0;
  const optionLines = (f.get('options') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!label) return respond.ephemeral({ content: '⚠ The label cannot be empty.' });
  if (type === 'MCQ' && (optionLines.length < 2 || optionLines.length > 10)) {
    return respond.ephemeral({ content: `⚠ MCQ needs **2–10** options, one per line (got ${optionLines.length}). Reopen the item and fix the options.` });
  }
  const optionsJson = type === 'MCQ' ? JSON.stringify(optionLines.map((o) => o.slice(0, 100))) : null;

  if (arg === 'new') {
    const items = await getItems(c.env, e.event_id);
    if (items.length >= MAX_ITEMS) return respond.ephemeral({ content: `⚠ Custom item cap is ${MAX_ITEMS}.` });
    await c.env.DB.prepare(
      'INSERT INTO form_items (event_id, position, label, type, description, options_json, visible_to_recommender) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    ).bind(e.event_id, items.length + 1, label, type, description, optionsJson, visibility).run();
  } else {
    const res = await c.env.DB.prepare(
      'UPDATE form_items SET label = ?1, type = ?2, description = ?3, options_json = ?4, visible_to_recommender = ?5 WHERE item_id = ?6 AND event_id = ?7',
    ).bind(label, type, description, optionsJson, visibility, Number(arg), e.event_id).run();
    if ((res.meta.changes ?? 0) === 0) return stale(c, 'That item no longer exists.');
  }
  bg(c, async () => {
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `✅ ${arg === 'new' ? 'Added' : 'Updated'} **${label}** (${type === 'MCQ' ? `MCQ, ${optionLines.length} options` : 'fill-in'}, ${visibility ? '👁 visible' : '🔒 hidden'}).`,
    });
  });
  return respond.deferEphemeral();
}

function itemCard(item: FormItem, position: number, total: number): Record<string, unknown> {
  const opts = optionsOf(item);
  return {
    content: '',
    embeds: [embed({
      title: `Item ${position}/${total}: ${item.label}`,
      description:
        `**Type:** ${item.type === 'MCQ' ? 'multiple choice' : 'fill-in'}\n` +
        (item.description ? `**Description:** ${item.description}\n` : '') +
        (item.type === 'MCQ' ? `**Options:**\n${opts.map((o) => `• ${o}`).join('\n')}\n` : '') +
        `**Visibility:** ${item.visible_to_recommender ? '👁 visible to your recommender' : '🔒 hidden'}`,
    })],
    components: [row(
      btn(`ax:item_edit:${item.item_id}`, '✏ Edit', Style.PRIMARY),
      btn(`ax:item_up:${item.item_id}`, '⬆'),
      btn(`ax:item_down:${item.item_id}`, '⬇'),
      btn(`ax:item_del:${item.item_id}`, '🗑 Delete', Style.DANGER),
    )],
  };
}

export async function itemMenu(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const items = await getItems(c.env, e.event_id);
  return respond.ephemeral({
    content: 'Pick an item to edit:',
    components: [row(stringSelect('ax:item_pick', 'Choose an item…', [
      // Item 1 is the built-in list link: its wording is editable too.
      {
        label: `1. ${e.link_label || LINK_LABEL_DEFAULT}`,
        value: 'link',
        description: 'built-in · always 👁 visible',
      },
      ...items.map((it, i) => ({
        label: `${i + 2}. ${it.label}`,
        value: String(it.item_id),
        description: it.type === 'MCQ' ? `MCQ (${optionsOf(it).length} options)` : 'fill-in',
      })),
    ]))],
  });
}

/** The built-in list-link item: only its wording can change. */
function linkItemModal(e: EventRow): Response {
  return respond.modal('axm:item:link', 'Edit the list-link item', [
    modalText('label', 'Question label', {
      value: e.link_label || LINK_LABEL_DEFAULT, max: 45,
      description: 'The built-in first question — always shown, always 👁 visible',
    }),
    modalText('desc', 'Description (optional)', {
      required: false, value: e.link_desc || LINK_DESC_DEFAULT, max: 100,
      description: 'Helper text under the question',
    }),
  ]);
}

async function linkItemSubmit(c: HCtx, e: EventRow): Promise<Response> {
  const f = modalFields(c.i.data?.components);
  const label = (f.get('label') ?? '').trim().slice(0, 45);
  const desc = (f.get('desc') ?? '').trim().slice(0, 100) || null;
  if (!label) return respond.ephemeral({ content: '⚠ The label cannot be empty.' });
  await c.env.DB.prepare('UPDATE events SET link_label = ?1, link_desc = ?2, updated_at = ?3 WHERE event_id = ?4')
    .bind(label, desc, now(), e.event_id).run();
  bg(c, async () => {
    await repaint(c);
    await editOriginal(c.env, c.i.token, { content: `✅ Updated the built-in item — **${label}**.` });
  });
  return respond.deferEphemeral();
}

export async function itemPick(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const raw = c.i.data?.values?.[0] ?? '';
  if (raw === 'link') {
    return respond.update({
      content: '',
      embeds: [embed({
        title: `Item 1: ${e.link_label || LINK_LABEL_DEFAULT}`,
        description:
          `**Type:** built-in list link (validated MAL/AniList URL)\n` +
          `**Description:** ${e.link_desc || LINK_DESC_DEFAULT}\n` +
          `**Visibility:** 👁 always visible to their Secret Santa\n` +
          `*Always the first question — it can't be moved or removed.*`,
      })],
      components: [row(btn('ax:item_edit:link', '✏ Edit', Style.PRIMARY))],
    });
  }
  const id = Number(raw);
  const items = await getItems(c.env, e.event_id);
  const idx = items.findIndex((it) => it.item_id === id);
  if (idx < 0) return stale(c, 'That item no longer exists.');
  return respond.update(itemCard(items[idx]!, idx + 1, items.length));
}

export async function itemMove(c: HCtx, itemId: string, dir: 'up' | 'down'): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const items = await getItems(c.env, e.event_id);
  const idx = items.findIndex((it) => it.item_id === Number(itemId));
  if (idx < 0) return stale(c, 'That item no longer exists.');
  const other = dir === 'up' ? idx - 1 : idx + 1;
  if (other < 0 || other >= items.length) {
    return respond.update(itemCard(items[idx]!, idx + 1, items.length));
  }
  const a = items[idx]!;
  const b = items[other]!;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE form_items SET position = ?1 WHERE item_id = ?2').bind(b.position, a.item_id),
    c.env.DB.prepare('UPDATE form_items SET position = ?1 WHERE item_id = ?2').bind(a.position, b.item_id),
  ]);
  c.ec.waitUntil(repaint(c).catch(() => {}));
  const fresh = await getItems(c.env, e.event_id);
  const newIdx = fresh.findIndex((it) => it.item_id === a.item_id);
  return respond.update(itemCard(fresh[newIdx]!, newIdx + 1, fresh.length));
}

export async function itemDelete(c: HCtx, itemId: string): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const item = await c.env.DB.prepare('SELECT * FROM form_items WHERE item_id = ?1 AND event_id = ?2')
    .bind(Number(itemId), e.event_id).first<FormItem>();
  if (!item) return stale(c, 'That item no longer exists.');
  await c.env.DB.prepare('DELETE FROM form_items WHERE item_id = ?1').bind(item.item_id).run();
  const rest = await getItems(c.env, e.event_id);
  if (rest.length) {
    await c.env.DB.batch(rest.map((it, i) =>
      c.env.DB.prepare('UPDATE form_items SET position = ?1 WHERE item_id = ?2').bind(i + 1, it.item_id)));
  }
  c.ec.waitUntil(repaint(c).catch(() => {}));
  return respond.update({ content: `🗑 Deleted **${item.label}**.`, embeds: [], components: [] });
}

/** [📨 Open Sign-Ups] → the sign-up window's own modal (deadline + timezone). */
export function openSignups(c: HCtx): Response {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  if (!e.topic) {
    return respond.ephemeral({ content: '⚠ Set the basics first — the Session needs a name.' });
  }
  if (!isConnected(c.guild)) {
    return respond.ephemeral({ content: '⚠ Connect Google first — the sheet, review docs and status tracking all depend on it.' });
  }
  return respond.modal('axm:open', 'Open sign-ups', [
    modalText('deadline', 'Sign-up deadline (YYYY-MM-DD HH:mm)', {
      value: e.signup_deadline && e.tz ? epochToZoned(e.signup_deadline, e.tz) : '', max: 20,
      placeholder: '2026-09-01 21:00',
    }),
    modalText('tz', 'Timezone (IANA)', { value: e.tz ?? DEFAULT_TZ, max: 50, placeholder: DEFAULT_TZ }),
  ]);
}

export async function openSignupsSubmit(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const f = modalFields(c.i.data?.components);
  const tz = (f.get('tz') ?? '').trim();
  if (!isValidTz(tz)) {
    return respond.ephemeral({ content: `⚠ \`${tz}\` is not a valid IANA timezone (e.g. \`Asia/Seoul\`, \`America/New_York\`). Reopen **📨 Open Sign-Ups**.` });
  }
  const deadline = zonedToEpoch((f.get('deadline') ?? '').trim(), tz);
  if (deadline === null || deadline <= now()) {
    return respond.ephemeral({ content: '⚠ The sign-up deadline must be `YYYY-MM-DD HH:mm` and in the future. Reopen **📨 Open Sign-Ups**.' });
  }
  await c.env.DB.prepare(
    'UPDATE events SET signup_deadline = ?1, tz = ?2, signup_banner_flipped = 0, updated_at = ?3 WHERE event_id = ?4',
  ).bind(deadline, tz, now(), e.event_id).run();
  return respond.ephemeral({
    content:
      `📨 **Open sign-ups for ${e.topic}?**\n` +
      `• Deadline: ${ts(deadline)} (${ts(deadline, 'R')})\n` +
      `• The participant panel opens — announce it yourself however you like.\n` +
      `• The spreadsheet is created in **${c.guild.google_email}**'s Drive.`,
    components: [row(btn('ax:open:go', 'Confirm — open sign-ups', Style.SUCCESS), btn('ax:cancel', 'Not yet'))],
  });
}

export async function openSignupsGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e || !e.topic || !isConnected(c.guild)) return stale(c);
  bg(c, async () => {
    // The deadline was just written by the modal — re-read it.
    const fresh = await c.env.DB.prepare('SELECT * FROM events WHERE event_id = ?1')
      .bind(e.event_id).first<EventRow>();
    if (!fresh?.signup_deadline || !fresh.tz) {
      await editOriginal(c.env, c.i.token, { content: '⚠ Set the sign-up deadline first — reopen **📨 Open Sign-Ups**.', components: [] });
      return;
    }
    let sheetId = e.sheet_id;
    let sheetGid = e.sheet_gid;
    if (!sheetId) {
      const title = `Anime Exchange — ${e.topic} — ${epochToZoned(now(), fresh.tz!).slice(0, 10)}`;
      const created = await createSpreadsheet(c.env, c.guild, title);
      sheetId = created.spreadsheetId;
      sheetGid = created.gid;
      await c.env.DB.prepare('UPDATE events SET sheet_id = ?1, sheet_gid = ?2, updated_at = ?3 WHERE event_id = ?4')
        .bind(created.spreadsheetId, created.gid, now(), e.event_id).run();
    }
    // Unconditional: if a previous attempt created the sheet but died before
    // the header landed, the retry must still write it.
    const items = await getItems(c.env, e.event_id);
    await writeHeader(c.env, c.guild, { ...fresh, sheet_id: sheetId, sheet_gid: sheetGid }, items);
    if (!(await transition(c.env, e.event_id, 'DRAFTING', 'SIGNUP_OPEN'))) {
      await editOriginal(c.env, c.i.token, { content: '↻ State changed — panels refreshed.', components: [] });
      await repaint(c);
      return;
    }
    await repaint(c);
    // No @everyone announcement — the panel flipping to "sign-ups open" IS the
    // notice, and managers ping their server themselves.
    await editOriginal(c.env, c.i.token, {
      content: `📨 **Sign-ups are open!** Sheet: ${sheetUrl(sheetId!)}`, components: [],
    });
  });
  return respond.deferUpdate();
}

export async function discard(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  return confirm('🗑 Discard this draft? Items and basics will be deleted.', 'ax:discard:go', 'Confirm — discard');
}

export async function discardGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  await c.env.DB.prepare("DELETE FROM events WHERE event_id = ?1 AND state = 'DRAFTING'").bind(e.event_id).run();
  bg(c, async () => {
    await repaint(c);
    await editOriginal(c.env, c.i.token, { content: '🗑 Draft discarded.', components: [] });
  });
  return respond.deferUpdate();
}

// ------------------------------------------------- SIGNUP_OPEN / MATCHING

export async function stopSignups(c: HCtx): Promise<Response> {
  const e = needState(c, 'SIGNUP_OPEN');
  if (!e) return stale(c);
  const n = await countSignups(c.env, e.event_id);
  return confirm(
    `🛑 Stop sign-ups with **${n}** participant(s)? The current order becomes the initial loop; you can still reopen from Matching.`,
    'ax:stop:go', 'Confirm — stop sign-ups',
  );
}

export async function stopSignupsGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'SIGNUP_OPEN');
  if (!e) return stale(c);
  bg(c, async () => {
    if (!(await transition(c.env, e.event_id, 'SIGNUP_OPEN', 'MATCHING'))) {
      await editOriginal(c.env, c.i.token, { content: '↻ State changed — panels refreshed.', components: [] });
      await repaint(c);
      return;
    }
    const items = await getItems(c.env, e.event_id);
    const n = await adoptSignupOrder(c.env, c.guild, e, items); // fills the derived Santa block (§4 side effect)
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `🛑 Sign-ups closed — **${n}** participants. Group/Shuffle or reorder sheet rows, **✅ Validate**, then **🎯 Start Recommending**.`,
      components: [],
    });
  });
  return respond.deferUpdate();
}

export async function reopenSignups(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  return confirm('↩ Reopen sign-ups? New participants will join at the end of the loop.', 'ax:reopen:go', 'Confirm — reopen', Style.PRIMARY);
}

export async function reopenSignupsGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  bg(c, async () => {
    if (!(await transition(c.env, e.event_id, 'MATCHING', 'SIGNUP_OPEN'))) {
      await editOriginal(c.env, c.i.token, { content: '↻ State changed — panels refreshed.', components: [] });
    } else {
      await editOriginal(c.env, c.i.token, { content: '📨 Sign-ups reopened.', components: [] });
    }
    await repaint(c);
  });
  return respond.deferUpdate();
}

/**
 * Shuffle (§5.4, rev. 3): re-draw the order **within each group
 * independently**, preserving membership — with everyone in group 1 this is
 * exactly the classic single-loop shuffle. Blocks concatenate in ascending
 * group order (§7.1).
 */
export async function shuffle(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  bg(c, async () => {
    const ordered = await orderedSignups(c.env, e.event_id);
    if (ordered.length < 2) {
      await editOriginal(c.env, c.i.token, { content: `⚠ Need at least 2 participants to shuffle (currently ${ordered.length}).` });
      return;
    }
    const byGroup = new Map<number, typeof ordered>();
    for (const s of ordered) {
      const list = byGroup.get(s.group_no);
      if (list) list.push(s);
      else byGroup.set(s.group_no, [s]);
    }
    const order: typeof ordered = [];
    for (const g of [...byGroup.keys()].sort((a, b) => a - b)) {
      order.push(...shuffled(byGroup.get(g)!));
    }
    await dbBatchChunked(c.env, order.map((s, idx) =>
      c.env.DB.prepare('UPDATE signups SET row_order = ?1, updated_at = ?2 WHERE signup_id = ?3')
        .bind(idx, now(), s.signup_id)));
    const items = await getItems(c.env, e.event_id);
    await rewriteSheet(c.env, c.guild, e, items, order.map((s, idx) => ({ ...s, row_order: idx })));
    await repaint(c);
    const g = byGroup.size;
    await editOriginal(c.env, c.i.token, {
      content: `🔀 Shuffled — **${g}** loop${g > 1 ? 's' : ''} re-drawn within existing groups.`,
    });
  });
  return respond.deferEphemeral();
}

/**
 * Grouping (§5.4, rev. 3): Fisher–Yates the full list, deal into G blocks as
 * evenly as possible, adopt membership + order. G = 1 reproduces the single
 * loop. Like Shuffle, no confirm — re-rolling is always possible.
 */
export function groupingModal(c: HCtx): Response {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  return respond.modal('axm:grouping', 'Split into groups', [
    modalText('groups', 'Number of groups', {
      max: 3, placeholder: 'e.g. 2 — each loop needs ≥ 2 members',
      description: '1 = one big loop; max is half the participant count',
    }),
  ]);
}

export async function groupingSubmit(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  const raw = (modalFields(c.i.data?.components).get('groups') ?? '').trim();
  const n = await countSignups(c.env, e.event_id);
  const maxG = Math.floor(n / 2);
  if (n < 2) {
    return respond.ephemeral({ content: `⚠ Need at least 2 participants to form loops (currently ${n}).` });
  }
  if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1 || parseInt(raw, 10) > maxG) {
    return respond.ephemeral({
      content: `⚠ Number of groups must be an integer between **1** and **${maxG}** (⌊${n}/2⌋ — every loop needs at least 2 members). Reopen **🧩 Grouping** and try again.`,
    });
  }
  const g = parseInt(raw, 10);
  bg(c, async () => {
    const ordered = await orderedSignups(c.env, e.event_id);
    // Full-list Fisher–Yates, then deal into contiguous blocks (§7.1).
    const order = shuffled(ordered);
    const sizes = dealSizes(order.length, g);
    const stmts: D1PreparedStatement[] = [];
    const fresh: typeof ordered = [];
    let idx = 0;
    sizes.forEach((size, block) => {
      for (let k = 0; k < size; k++, idx++) {
        const s = order[idx]!;
        stmts.push(c.env.DB.prepare(
          'UPDATE signups SET row_order = ?1, group_no = ?2, updated_at = ?3 WHERE signup_id = ?4',
        ).bind(idx, block + 1, now(), s.signup_id));
        fresh.push({ ...s, row_order: idx, group_no: block + 1 });
      }
    });
    await dbBatchChunked(c.env, stmts);
    const items = await getItems(c.env, e.event_id);
    await rewriteSheet(c.env, c.guild, e, items, fresh);
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `🧩 Grouped **${order.length}** participants into **${g}** loop${g > 1 ? 's' : ''} (${sizes.join(' + ')}).`,
    });
  });
  return respond.deferEphemeral();
}

function validationResponse(report: string, missing: Array<{ userId: string; name: string }>): Record<string, unknown> {
  const first = missing[0];
  return {
    content: report,
    components: first
      ? [row(
          btn(`ax:rm_confirm:${first.userId}`, `Confirm removal of ${first.name}`.slice(0, 80), Style.DANGER),
          btn(`ax:rm_restore:${first.userId}`, `Restore ${first.name}'s row`.slice(0, 80), Style.PRIMARY),
        )]
      : [],
  };
}

export async function validate(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  bg(c, async () => {
    const items = await getItems(c.env, e.event_id);
    const result = await runValidate(c.env, c.guild, e, items);
    await repaint(c);
    await editOriginal(c.env, c.i.token, validationResponse(validateReport(result), result.missing));
  });
  return respond.deferEphemeral();
}

export async function removalConfirm(c: HCtx, userId: string): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  bg(c, async () => {
    await c.env.DB.prepare('DELETE FROM signups WHERE event_id = ?1 AND user_id = ?2')
      .bind(e.event_id, userId).run();
    // Close the gap the delete leaves in row_order. Validate renumbers too, but
    // only when it passes — and writeRecoRows addresses sheet rows as
    // row_order + 2, so the invariant should not depend on that.
    const remaining = await orderedSignups(c.env, e.event_id);
    if (remaining.length) {
      await dbBatchChunked(c.env, remaining.map((s, idx) =>
        c.env.DB.prepare('UPDATE signups SET row_order = ?1, updated_at = ?2 WHERE signup_id = ?3')
          .bind(idx, now(), s.signup_id)));
    }
    const items = await getItems(c.env, e.event_id);
    const result = await runValidate(c.env, c.guild, e, items);
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `🗑 Removed <@${userId}> from the event.\n\n${validateReport(result)}`,
      components: validationResponse('', result.missing).components,
    });
  });
  return respond.deferUpdate();
}

export async function removalRestore(c: HCtx, userId: string): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  bg(c, async () => {
    const items = await getItems(c.env, e.event_id);
    const ordered = await orderedSignups(c.env, e.event_id);
    await rewriteSheet(c.env, c.guild, e, items, ordered); // writes the missing row back
    const result = await runValidate(c.env, c.guild, e, items);
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `↩ Restored <@${userId}>'s sheet row.\n\n${validateReport(result)}`,
      components: validationResponse('', result.missing).components,
    });
  });
  return respond.deferUpdate();
}

// -------------------------------------------------- Start Recommending
// MATCHING → PREPARING: validate, LOCK the assignment (row order + groups
// stop being inputs), then the batched prepare job creates each private
// thread and posts the Santa task card.

export function recoStartModal(c: HCtx): Response {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  return respond.modal('axm:reco_start', 'Start recommending', [
    modalText('deadline', 'Recommendation deadline (YYYY-MM-DD HH:mm)', {
      value: e.reco_deadline && e.tz ? epochToZoned(e.reco_deadline, e.tz) : '',
      max: 20, placeholder: '2026-09-15 21:00',
      description: 'Shown everywhere; nudging & launching stay yours',
    }),
    modalText('tz', 'Timezone (IANA)', { value: e.tz ?? DEFAULT_TZ, max: 50, placeholder: DEFAULT_TZ }),
  ]);
}

export async function recoStartSubmit(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  const f = modalFields(c.i.data?.components);
  const tz = (f.get('tz') ?? '').trim();
  if (!isValidTz(tz)) {
    return respond.ephemeral({ content: `⚠ \`${tz}\` is not a valid IANA timezone. Reopen **🎯 Start Recommending** and try again.` });
  }
  const deadline = zonedToEpoch((f.get('deadline') ?? '').trim(), tz);
  if (deadline === null || deadline <= now()) {
    return respond.ephemeral({ content: '⚠ The recommendation deadline must be `YYYY-MM-DD HH:mm` and in the future. Reopen **🎯 Start Recommending**.' });
  }
  // Stage on the event row; ax:reco_start:go freezes it.
  await c.env.DB.prepare(
    'UPDATE events SET reco_deadline = ?1, tz = ?2, reco_banner_flipped = 0, updated_at = ?3 WHERE event_id = ?4',
  ).bind(deadline, tz, now(), e.event_id).run();
  const n = await countSignups(c.env, e.event_id);
  return respond.ephemeral({
    content:
      `🎯 **Start the recommendation phase for ${e.topic}?**\n` +
      `• Recommendation deadline: ${ts(deadline)} (${ts(deadline, 'R')})\n` +
      `• Validation runs first, then **assignments lock**: each of the **${n}** participants gets a private thread ` +
      `telling them who they're the Secret Santa of (with that person's MAL/AniList link), and picking begins. ` +
      `Everyone recommends up to the number their giftee asked for (1–3) and can send picks back **${e.max_declines}** time(s).\n` +
      `You can still undo with **↩ Back to Matching** — but that wipes all picks.`,
    components: [row(btn('ax:reco_start:go', '🎯 Confirm — start recommending', Style.SUCCESS), btn('ax:cancel', 'Not yet'))],
  });
}

export async function recoStartGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  if (!e.reco_deadline || e.reco_deadline <= now()) {
    return respond.ephemeral({ content: '⚠ Recommendation deadline missing or passed — reopen **🎯 Start Recommending**.' });
  }
  bg(c, async () => {
    const items = await getItems(c.env, e.event_id);
    const result = await runValidate(c.env, c.guild, e, items);
    if (!result.ok) {
      await editOriginal(c.env, c.i.token, validationResponse(validateReport(result), result.missing));
      return;
    }
    if (!(await transition(c.env, e.event_id, 'MATCHING', 'PREPARING'))) {
      await editOriginal(c.env, c.i.token, { content: '↻ State changed — panels refreshed.', components: [] });
      await repaint(c);
      return;
    }
    await enqueueJob(c, e.event_id, 'prepare');
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content:
        `🎯 **Recommendation phase starting** — ${result.n} Santa missions will be delivered over the next ` +
        `~${Math.max(1, Math.ceil(result.n / c.cfg.jobBatch))} minute(s). Assignments are locked.`,
      components: [],
    });
  });
  return respond.deferUpdate();
}

// ---------------------------------------------------------- RECOMMENDING

/** [↩ Back to Matching] — destructive: wipes every pick/decline, keeps threads. */
export async function backMatching(c: HCtx): Promise<Response> {
  const e = needState(c, 'RECOMMENDING');
  if (!e) return stale(c);
  return confirm(
    '↩ **Go back to Matching?** All picks, approvals and declines are **wiped** and assignments unlock ' +
    'for regrouping/shuffling. Private threads stay and are reused when you start recommending again. ' +
    'This cannot be undone.',
    'ax:back_matching:go', 'Confirm — back to Matching',
  );
}

export async function backMatchingGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'RECOMMENDING');
  if (!e) return stale(c);
  bg(c, async () => {
    if (!(await transition(c.env, e.event_id, 'RECOMMENDING', 'MATCHING'))) {
      await editOriginal(c.env, c.i.token, { content: '↻ State changed — panels refreshed.', components: [] });
      await repaint(c);
      return;
    }
    await c.env.DB.batch([
      // Slots are recreated (empty) by the next prepare job.
      c.env.DB.prepare('DELETE FROM recos WHERE event_id = ?1').bind(e.event_id),
      c.env.DB.prepare(
        `UPDATE signups SET declines_used = 0, reco_card_posted = 0,
           mission_msg_id = NULL, updated_at = ?1
         WHERE event_id = ?2`,
      ).bind(now(), e.event_id),
      // Deadline stays (prefills the next Start Recommending); its banner resets.
      c.env.DB.prepare('UPDATE events SET reco_banner_flipped = 0, updated_at = ?1 WHERE event_id = ?2')
        .bind(now(), e.event_id),
      c.env.DB.prepare('DELETE FROM signup_drafts WHERE event_id = ?1').bind(e.event_id),
      c.env.DB.prepare('DELETE FROM reminders WHERE event_id = ?1 AND sent_at IS NULL').bind(e.event_id),
    ]);
    await rewriteSheetFromDb(c.env, c.guild, e).catch(() => {});
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: '↩ **Back to Matching** — all picks wiped, assignments unlocked. Old thread cards are stale; fresh missions go out when you press 🎯 Start Recommending again.',
      components: [],
    });
  });
  return respond.deferUpdate();
}

// ---------------------------------------------------------------- Launch
// Now gated on the recommendation phase: every pick must be FINAL.

export async function launchModal(c: HCtx): Promise<Response> {
  const e = needState(c, 'RECOMMENDING');
  if (!e) return stale(c);
  // The panel says launch unlocks once everyone has a pick, and launchGo
  // enforces it — so refuse here rather than after the manager has filled in
  // a review deadline and pressed confirm.
  const counts = await peopleCounts(c, e.event_id);
  if (counts.nothing > 0) {
    return respond.ephemeral({
      content:
        `⚠ **${counts.nothing} participant(s) have no anime yet** — everyone needs at least one pick ` +
        `before launch. Use **📣 Remind Now** to nudge the Santas who still owe one.`,
    });
  }
  return respond.modal('axm:launch', 'Launch the exchange', [
    modalText('deadline', 'Review deadline (YYYY-MM-DD HH:mm)', {
      value: e.review_deadline && e.tz ? epochToZoned(e.review_deadline, e.tz) : '',
      max: 20, placeholder: '2026-10-01 21:00',
    }),
    modalText('tz', 'Timezone (IANA)', { value: e.tz ?? DEFAULT_TZ, max: 50, placeholder: DEFAULT_TZ }),
    modalSelect('mirror', 'Also mirror reminders via DM?', [
      { label: 'No — thread pings only', value: '0', default: !e.dm_mirror },
      { label: 'Yes — best-effort DM copy', value: '1', default: !!e.dm_mirror },
    ]),
  ]);
}

export async function launchSubmit(c: HCtx): Promise<Response> {
  const e = needState(c, 'RECOMMENDING');
  if (!e) return stale(c);
  const f = modalFields(c.i.data?.components);
  const tz = (f.get('tz') ?? '').trim();
  if (!isValidTz(tz)) {
    return respond.ephemeral({ content: `⚠ \`${tz}\` is not a valid IANA timezone. Reopen **Launch** and try again.` });
  }
  const deadline = zonedToEpoch((f.get('deadline') ?? '').trim(), tz);
  if (deadline === null || deadline <= now()) {
    return respond.ephemeral({ content: '⚠ Review deadline must be `YYYY-MM-DD HH:mm` and in the future. Reopen **Launch** and try again.' });
  }
  const mirror = f.get('mirror') === '1' ? 1 : 0;
  // Stage on the event row; ax:launch:go freezes them (§5.4).
  await c.env.DB.prepare(
    'UPDATE events SET review_deadline = ?1, tz = ?2, dm_mirror = ?3, updated_at = ?4 WHERE event_id = ?5',
  ).bind(deadline, tz, mirror, now(), e.event_id).run();
  const n = await countSignups(c.env, e.event_id);
  const agg = await peopleCounts(c, e.event_id);
  const pending = agg.pending;
  const waiting = agg.nothing;
  return respond.ephemeral({
    content:
      `🚀 **Launch ${e.topic}?**\n` +
      `• Participants: **${n}** · with an accepted anime: **${agg.accepted}** · picks accepted: **${agg.picks} / ${agg.wanted}**\n` +
      `• Review deadline: ${ts(deadline)} (${ts(deadline, 'R')})\n` +
      `• Nudges: manual, via **📣 Remind Now**${mirror ? ' (+ DM mirror)' : ''}\n\n` +
      (waiting > 0
        ? `⚠ **${waiting} participant(s) have no anime yet** — the launch will refuse until every Santa has sent at least one pick.\n\n`
        : pending > 0
          ? `**‼️The pending picks will be locked**\n\n`
          : '') +
      `Launching creates one review doc per accepted anime (**${agg.picks}** of them) and posts the ` +
      `assignment into each existing thread (batched — ~${Math.ceil(agg.picks / c.cfg.jobBatch) + Math.ceil((n + agg.picks) / c.cfg.jobBatch)} min, ` +
      `longer if other events are running). Forward-only.`,
    components: [row(btn('ax:launch:go', '🚀 Confirm launch', Style.SUCCESS), btn('ax:cancel', 'Not yet'))],
  });
}

export async function launchGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'RECOMMENDING');
  if (!e) return stale(c);
  if (!e.review_deadline || e.review_deadline <= now()) {
    return respond.ephemeral({ content: '⚠ Review deadline missing or passed — reopen **Launch**.' });
  }
  bg(c, async () => {
    // Only picks that were never sent block the launch; ⏳ pending ones are
    // locked by the sweep below (the confirm warned: ‼️).
    const counts = await peopleCounts(c, e.event_id);
    if (counts.nothing > 0) {
      await editOriginal(c.env, c.i.token, {
        content:
          `⚠ **${counts.nothing} participant(s) have no anime yet** — everyone needs at least one pick before launch. ` +
          `Use **📣 Remind Now** to nudge the Santas who still owe one.`,
        components: [],
      });
      return;
    }
    if (!(await transition(c.env, e.event_id, 'RECOMMENDING', 'LAUNCHING'))) {
      await editOriginal(c.env, c.i.token, { content: '↻ State changed — panels refreshed.', components: [] });
      await repaint(c);
      return;
    }
    // The launch sweep: every still-pending pick locks in now.
    await c.env.DB.prepare(
      "UPDATE recos SET status = 'FINAL', final_via = 'FORCED', updated_at = ?1 WHERE event_id = ?2 AND status = 'PENDING'",
    ).bind(now(), e.event_id).run();
    // No scheduled reminder rows: nudging is the manager's call, via
    // 📣 Remind Now, which enqueues 'manual' reminders on demand.
    const participants = await orderedSignups(c.env, e.event_id);
    await enqueueJob(c, e.event_id, 'launch');
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `🚀 **Launching** — review docs (one per anime) and ${participants.length} assignment cards will be delivered over the next few minutes. The panel counts up automatically.`,
      components: [],
    });
  });
  return respond.deferUpdate();
}

// ---------------------------------------------------------------- RUNNING

/** [🔄 Refresh] — SIGNUP_OPEN/RECOMMENDING: repaint the panel with fresh
 *  counts right now (skipping the 60 s throttle). RUNNING: queue a
 *  wrote-detection sync. The detail view is always the sheet, linked in the
 *  panel body. */
export async function refreshStatus(c: HCtx): Promise<Response> {
  const e = needState(c, 'SIGNUP_OPEN', 'RECOMMENDING', 'RUNNING');
  if (!e) return stale(c);
  // The numbers live on the panel and in the sheet — the reply is just a
  // receipt, identical in every state.
  if (e.state === 'RUNNING') await enqueueJob(c, e.event_id, 'sync');
  else bg(c, () => repaint(c));
  return respond.ephemeral({
    content: '🔄 **Status refresh queued** — the panel and sheet update within a minute or two.',
  });
}

/**
 * Manual-nudge targets by state: RUNNING → review laggards; RECOMMENDING →
 * Santas who owe a pick + giftees sitting on a pending pick (deduped). The
 * cron's delivery re-checks the condition, so a nudge that resolves in the
 * meantime is skipped silently.
 */
async function remindTargets(c: HCtx, e: EventRow): Promise<string[]> {
  if (e.state === 'RUNNING') {
    const laggards = await c.env.DB
      .prepare('SELECT user_id FROM signups WHERE event_id = ?1 AND wrote = 0')
      .bind(e.event_id).all<{ user_id: string }>();
    return laggards.results.map((l) => l.user_id);
  }
  const { all, loops, recos } = await loopContext(c.env, e.event_id);
  const targets = new Set<string>();
  all.forEach((s, idx) => {
    const slots = recosOf(recos, s.signup_id);
    // Their Santa hasn't got them anything yet (picks are a maximum, so one
    // live pick is enough to be off the hook)…
    if (activeRecos(slots).length === 0) {
      targets.add(all[loops.santa[idx]!]!.user_id);
    }
    // …or they owe a reply on one.
    if (pendingRecos(slots).length > 0) targets.add(s.user_id);
  });
  return [...targets];
}

export async function remindNow(c: HCtx): Promise<Response> {
  const e = needState(c, 'RUNNING', 'RECOMMENDING');
  if (!e) return stale(c);
  const targets = await remindTargets(c, e);
  if (targets.length === 0) {
    return respond.ephemeral({
      content: e.state === 'RUNNING'
        ? '📣 Everyone has already started writing — nothing to nudge. 🎉'
        : '📣 Nobody is stalling — every pick is locked in. 🎉',
    });
  }
  return confirm(
    e.state === 'RUNNING'
      ? `📣 Send an immediate reminder to **${targets.length}** participant(s) who haven't started writing?`
      : `📣 Nudge **${targets.length}** participant(s) who owe an action (a pick to send, or a reply to give)?`,
    'ax:remind:go', `Confirm — remind ${targets.length}`, Style.PRIMARY,
  );
}

export async function remindNowGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'RUNNING', 'RECOMMENDING');
  if (!e) return stale(c);
  // Everything below scales with the participant count (⌈n/40⌉ D1 batches), so
  // it belongs after the deferral, not inside the 3-second response budget.
  bg(c, async () => {
    const targets = await remindTargets(c, e);
    if (targets.length) {
      await dbBatchChunked(c.env, targets.map((uid) =>
        c.env.DB.prepare("INSERT INTO reminders (event_id, user_id, kind, due_at) VALUES (?1, ?2, 'manual', ?3)")
          .bind(e.event_id, uid, now())));
    }
    const ticks = Math.max(1, Math.ceil(targets.length / c.cfg.remindersPerTick));
    await editOriginal(c.env, c.i.token, {
      content: targets.length
        ? `📣 Reminders queued for **${targets.length}** participant(s) — delivered within ~${ticks} minute(s).`
        : '📣 Nothing to nudge any more — everyone is up to date. 🎉',
      components: [],
    });
  });
  return respond.deferUpdate();
}

export async function closeReviews(c: HCtx): Promise<Response> {
  const e = needState(c, 'RUNNING');
  if (!e) return stale(c);
  return respond.ephemeral({
    content:
      '🏁 **Close reviews?** The final status snapshot is taken, every doc flips to view-only, ' +
      'then reveal cards go to every thread and the gallery is posted in the exchange channel.',
    components: [row(
      btn('ax:close:gallery', '🏁 Confirm — close reviews', Style.SUCCESS),
      btn('ax:cancel', 'Cancel'),
    )],
  });
}

export async function closeGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'RUNNING');
  if (!e) return stale(c);
  bg(c, async () => {
    if (!(await transition(c.env, e.event_id, 'RUNNING', 'CLOSING'))) {
      await editOriginal(c.env, c.i.token, { content: '↻ State changed — panels refreshed.', components: [] });
      await repaint(c);
      return;
    }
    // FIFO: the final wrote-snapshot lands before docs flip (§5.5). If a sync
    // job is already active its id is lower — same guarantee.
    await enqueueJob(c, e.event_id, 'sync');
    await enqueueJob(c, e.event_id, 'close', { gallery: true });
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: '🏁 **Closing** — final status sync, then docs flip read-only and reveals + the gallery go out. The panel tracks progress.',
      components: [],
    });
  });
  return respond.deferUpdate();
}

// --------------------------------------------------------------- REVEALED

export async function finish(c: HCtx): Promise<Response> {
  const e = needState(c, 'REVEALED');
  if (!e) return stale(c);
  return confirm(
    '🧹 This deletes the bot\'s event data and all private threads. **Your Google Sheet and Docs are yours and stay in your Drive.** Finish?',
    'ax:finish:go', 'Confirm — finish event',
  );
}

export async function finishGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'REVEALED');
  if (!e) return stale(c);
  const queued = await enqueueJob(c, e.event_id, 'finish');
  bg(c, async () => {
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: queued
        ? '🧹 Finishing — private threads are being removed (batched); both panels reset when done.'
        : '🧹 Already finishing — panels reset when done.',
      components: [],
    });
  });
  return respond.deferUpdate();
}

// ------------------------------------------------------------------ abort
// The red escape hatch (every non-IDLE state): kills the event no matter
// what's stuck — cancels active jobs first so cleanup can't queue behind a
// wedged launch/close, purges unsent reminders, then tears down. Google
// artifacts always stay in the manager's Drive.

export function abort(c: HCtx): Response {
  if (!c.event) return stale(c, 'No event to abort.');
  return confirm(
    '🛑 **Abort this event?** The bot\'s event data and any private threads are deleted, and any running launch/close/sync stops. ' +
    '**Your Google Sheet and Docs stay in your Drive.** This cannot be undone.',
    'ax:abort:go', 'Confirm — abort event',
  );
}

export async function abortGo(c: HCtx): Promise<Response> {
  const e = c.event;
  if (!e) return stale(c, 'No event to abort.');
  bg(c, async () => {
    // Cancel whatever is in flight; per-event FIFO would otherwise park the
    // cleanup job behind a stuck launch/close forever.
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE jobs SET done_at = ?1, last_error = 'aborted by manager' WHERE event_id = ?2 AND done_at IS NULL")
        .bind(now(), e.event_id),
      c.env.DB.prepare('DELETE FROM reminders WHERE event_id = ?1 AND sent_at IS NULL').bind(e.event_id),
    ]);
    // The sign-up ping belongs to the aborted event — take it down with it.
    if (e.announce_msg_id && c.guild.participant_channel_id) {
      await deleteMessage(c.env, c.guild.participant_channel_id, e.announce_msg_id)
        .catch((err) => console.error('announcement cleanup failed', err));
    }
    const hasThreads = await c.env.DB
      .prepare('SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND thread_id IS NOT NULL')
      .bind(e.event_id).first<{ n: number }>();
    if ((hasThreads?.n ?? 0) === 0) {
      // Nothing launched yet → instant teardown, no fan-out needed. Panels are
      // re-posted (not edited) so the fresh IDLE panels sit at the bottom of
      // their channels.
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM signup_drafts WHERE event_id = ?1').bind(e.event_id),
        c.env.DB.prepare('DELETE FROM events WHERE event_id = ?1').bind(e.event_id),
      ]);
      await repostPanels(c.env, c.cfg, c.guild.guild_id);
      await editOriginal(c.env, c.i.token, {
        content: '🛑 **Event aborted** — fresh panels posted. The sheet (if created) stays in your Drive.',
        components: [],
      });
      return;
    }
    // Threads exist → batched teardown via the finish job (§13.1: fan-out
    // never runs in handlers). Panels reset when the last thread is gone.
    await enqueueJob(c, e.event_id, 'finish');
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: '🛑 **Aborting** — private threads are being removed (batched); both panels reset when done.',
      components: [],
    });
  });
  return respond.deferUpdate();
}

// ------------------------------------------------------------------ misc

export function cancel(): Response {
  return respond.update({ content: '✖ Cancelled.', embeds: [], components: [] });
}
