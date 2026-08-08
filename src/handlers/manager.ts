// Manager interactions (spec §5): draft builder, sign-up window, matching,
// launch/close/finish. Every irreversible action goes through an ephemeral
// [Confirm]/[Cancel] step; participant-scaling fan-outs are enqueued as jobs,
// never run inline (§13.1).

import type { EventRow, FormItem } from '../types';
import { modalFields } from '../types';
import {
  btn, editOriginal, embed, linkBtn, modalSelect, modalText, respond, row, stringSelect, Style,
} from '../discord';
import { getItems, countSignups, dbBatchChunked, loopContext, optionsOf, orderedSignups, transition } from '../db';
import { repostPanels } from '../panels';
import { createSpreadsheet, isConnected, sheetUrl } from '../google';
import { rewriteSheet, writeHeader } from '../sheet';
import { adoptSignupOrder, runValidate, validateReport } from '../validate';
import {
  chunkLines, dealSizes, epochToZoned, isValidTz, now, parseReminderDays, randomHex, shuffled, ts,
  zonedToEpoch,
} from '../util';
import { bg, HCtx, repaint, stale } from './common';

const MAX_ITEMS = 9;
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
  return respond.modal('axm:basics', 'Event basics', [
    modalText('topic', 'Topic', { value: e.topic ?? '', max: 100, placeholder: 'Fall 2026 Exchange: Nostalgia' }),
    modalText('deadline', 'Sign-up deadline (YYYY-MM-DD HH:mm)', {
      value: e.signup_deadline && e.tz ? epochToZoned(e.signup_deadline, e.tz) : '', max: 20,
      placeholder: '2026-09-01 21:00',
    }),
    modalText('tz', 'Timezone (IANA)', { value: e.tz ?? DEFAULT_TZ, max: 50, placeholder: DEFAULT_TZ }),
    modalSelect('autostop', 'Auto-stop sign-ups at the deadline?', [
      { label: 'No — I will stop sign-ups manually', value: '0', default: !e.auto_stop },
      { label: 'Yes — close sign-ups automatically', value: '1', default: !!e.auto_stop },
    ]),
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
  const tz = (f.get('tz') ?? '').trim();
  const deadlineRaw = (f.get('deadline') ?? '').trim();
  const autoStop = f.get('autostop') === '1' ? 1 : 0;
  const declinesRaw = (f.get('declines') ?? '').trim();
  if (!isValidTz(tz)) {
    return respond.ephemeral({ content: `⚠ \`${tz}\` is not a valid IANA timezone (e.g. \`Asia/Seoul\`, \`America/New_York\`). Reopen **Set Basics** and try again.` });
  }
  const deadline = zonedToEpoch(deadlineRaw, tz);
  if (deadline === null) {
    return respond.ephemeral({ content: '⚠ Deadline must look like `YYYY-MM-DD HH:mm`. Reopen **Set Basics** and try again.' });
  }
  if (deadline <= now()) {
    return respond.ephemeral({ content: '⚠ The sign-up deadline must be in the future. Reopen **Set Basics** and try again.' });
  }
  if (!/^[0-9]$/.test(declinesRaw)) {
    return respond.ephemeral({ content: '⚠ The Sorry😞 budget must be a single digit **0–9**. Reopen **Set Basics** and try again.' });
  }
  const maxDeclines = parseInt(declinesRaw, 10);
  await c.env.DB.prepare(
    'UPDATE events SET topic = ?1, tz = ?2, signup_deadline = ?3, auto_stop = ?4, max_declines = ?5, signup_banner_flipped = 0, updated_at = ?6 WHERE event_id = ?7',
  ).bind(topic, tz, deadline, autoStop, maxDeclines, now(), e.event_id).run();
  bg(c, async () => {
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `✅ Basics saved — **${topic}**, sign-ups until ${ts(deadline)} (${ts(deadline, 'R')}), auto-stop ${autoStop ? 'on' : 'off'}, **${maxDeclines}** decline(s) per person.`,
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
  const item = await c.env.DB.prepare('SELECT * FROM form_items WHERE item_id = ?1 AND event_id = ?2')
    .bind(Number(itemId), e.event_id).first<FormItem>();
  if (!item) return stale(c, 'That item no longer exists.');
  return itemModal(`axm:item:${item.item_id}`, item);
}

export async function itemSubmit(c: HCtx, arg: string): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const f = modalFields(c.i.data?.components);
  const label = (f.get('label') ?? '').trim();
  const type = f.get('type') === 'MCQ' ? 'MCQ' : 'FIB';
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
      'INSERT INTO form_items (event_id, position, label, type, options_json, visible_to_recommender) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(e.event_id, items.length + 1, label, type, optionsJson, visibility).run();
  } else {
    const res = await c.env.DB.prepare(
      'UPDATE form_items SET label = ?1, type = ?2, options_json = ?3, visible_to_recommender = ?4 WHERE item_id = ?5 AND event_id = ?6',
    ).bind(label, type, optionsJson, visibility, Number(arg), e.event_id).run();
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
  if (items.length === 0) return respond.ephemeral({ content: 'No items yet — press **➕ Add Item** first.' });
  return respond.ephemeral({
    content: 'Pick an item to edit:',
    components: [row(stringSelect('ax:item_pick', 'Choose an item…', items.map((it, i) => ({
      label: `${i + 1}. ${it.label}`,
      value: String(it.item_id),
      description: it.type === 'MCQ' ? `MCQ (${optionsOf(it).length} options)` : 'fill-in',
    }))))],
  });
}

export async function itemPick(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  const id = Number(c.i.data?.values?.[0] ?? 0);
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

export async function openSignups(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e) return stale(c);
  if (!e.topic || !e.signup_deadline || !e.tz) {
    return respond.ephemeral({ content: '⚠ Set the basics first (topic, deadline, timezone).' });
  }
  if (!isConnected(c.guild)) {
    return respond.ephemeral({ content: '⚠ Connect Google first — the sheet, review docs and status tracking all depend on it.' });
  }
  return confirm(
    `📨 Open sign-ups for **${e.topic}**? This creates the spreadsheet in **${c.guild.google_email}**'s Drive.`,
    'ax:open:go', 'Confirm — open sign-ups', Style.SUCCESS,
  );
}

export async function openSignupsGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'DRAFTING');
  if (!e || !e.topic || !e.signup_deadline || !e.tz || !isConnected(c.guild)) return stale(c);
  bg(c, async () => {
    let sheetId = e.sheet_id;
    let sheetGid = e.sheet_gid;
    if (!sheetId) {
      const title = `Anime Exchange — ${e.topic} — ${epochToZoned(now(), e.tz!).slice(0, 10)}`;
      const created = await createSpreadsheet(c.env, c.guild, title);
      sheetId = created.spreadsheetId;
      sheetGid = created.gid;
      await c.env.DB.prepare('UPDATE events SET sheet_id = ?1, sheet_gid = ?2, updated_at = ?3 WHERE event_id = ?4')
        .bind(created.spreadsheetId, created.gid, now(), e.event_id).run();
    }
    // Unconditional: if a previous attempt created the sheet but died before
    // the header landed, the retry must still write it.
    const items = await getItems(c.env, e.event_id);
    await writeHeader(c.env, c.guild, { ...e, sheet_id: sheetId, sheet_gid: sheetGid }, items);
    if (!(await transition(c.env, e.event_id, 'DRAFTING', 'SIGNUP_OPEN'))) {
      await editOriginal(c.env, c.i.token, { content: '↻ State changed — panels refreshed.', components: [] });
      await repaint(c);
      return;
    }
    await repaint(c);
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

export async function viewSignups(c: HCtx): Promise<Response> {
  const e = needState(c, 'SIGNUP_OPEN', 'MATCHING');
  if (!e) return stale(c);
  const n = await countSignups(c.env, e.event_id);
  const recent = await c.env.DB
    .prepare('SELECT display_name FROM signups WHERE event_id = ?1 ORDER BY signup_id DESC LIMIT 5')
    .bind(e.event_id).all<{ display_name: string }>();
  const names = recent.results.map((r) => r.display_name).join(', ') || '—';
  return respond.ephemeral({
    content: `📋 **${n}** signed up.\nMost recent: ${names}\nSheet: ${e.sheet_id ? sheetUrl(e.sheet_id) : '*not created*'}`,
  });
}

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
      content: `🛑 Sign-ups closed — **${n}** participants. Group/Shuffle or reorder sheet rows, Validate, then **🎯 Start Recommending**.`,
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

function validationResponse(c: HCtx, report: string, missing: Array<{ userId: string; name: string }>): Record<string, unknown> {
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
    await editOriginal(c.env, c.i.token, validationResponse(c, validateReport(result), result.missing));
  });
  return respond.deferEphemeral();
}

export async function removalConfirm(c: HCtx, userId: string): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  bg(c, async () => {
    await c.env.DB.prepare('DELETE FROM signups WHERE event_id = ?1 AND user_id = ?2')
      .bind(e.event_id, userId).run();
    const items = await getItems(c.env, e.event_id);
    const result = await runValidate(c.env, c.guild, e, items);
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `🗑 Removed <@${userId}> from the event.\n\n${validateReport(result)}`,
      components: validationResponse(c, '', result.missing).components,
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
      components: validationResponse(c, '', result.missing).components,
    });
  });
  return respond.deferUpdate();
}

// -------------------------------------------------- Start Recommending
// MATCHING → PREPARING: validate, LOCK the assignment (row order + groups
// stop being inputs), then the batched prepare job creates each private
// thread and posts the Santa task card.

export async function recoStart(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  const n = await countSignups(c.env, e.event_id);
  return confirm(
    `🎯 **Start the recommendation phase for ${e.topic}?**\n` +
    `Validation runs first, then **assignments lock**: each of the **${n}** participants gets a private thread ` +
    `telling them who they're the Secret Santa of (with that person's MAL/AniList link), and picking begins. ` +
    `Each person can send picks back **${e.max_declines}** time(s).\n` +
    `You can still undo with **↩ Back to Matching** — but that wipes all picks.`,
    'ax:reco_start:go', '🎯 Confirm — start recommending', Style.SUCCESS,
  );
}

export async function recoStartGo(c: HCtx): Promise<Response> {
  const e = needState(c, 'MATCHING');
  if (!e) return stale(c);
  bg(c, async () => {
    const items = await getItems(c.env, e.event_id);
    const result = await runValidate(c.env, c.guild, e, items);
    if (!result.ok) {
      await editOriginal(c.env, c.i.token, validationResponse(c, validateReport(result), result.missing));
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

/** [📊 View Status] — per-pair progress of the recommendation phase. */
export async function recoView(c: HCtx): Promise<Response> {
  const e = needState(c, 'RECOMMENDING', 'PREPARING');
  if (!e) return stale(c);
  const { all, loops } = await loopContext(c.env, e.event_id);
  const lines = all.map((s, idx) => {
    const santa = all[loops.santa[idx]!]!;
    switch (s.reco_status) {
      case 'FINAL':
        return `<@${s.user_id}> — ✅ accepted: **${s.reco_title}** (from ${santa.display_name})`;
      case 'PENDING':
        return `<@${s.user_id}> — ⏳ **${s.reco_title}** awaiting their reply (from ${santa.display_name})`;
      default:
        return `<@${s.user_id}> — 🎁 waiting on **${santa.display_name}**` +
          (s.declines_used > 0 ? ` (declined ×${s.declines_used})` : '');
    }
  });
  const final = all.filter((s) => s.reco_status === 'FINAL').length;
  const chunks = chunkLines(lines.length ? lines : ['*no participants*'], 3900, 40);
  const embeds: ReturnType<typeof embed>[] = [];
  let used = 0;
  let shown = 0;
  for (const d of chunks) {
    if (embeds.length >= 9 || used + d.length > 5200) break;
    embeds.push(embed({ description: d }));
    used += d.length;
    shown += d.split('\n').length;
  }
  if (shown < lines.length) {
    embeds.push(embed({ description: `…and **${lines.length - shown}** more — full detail in the sheet.` }));
  }
  return respond.ephemeral({
    content: `📊 **${e.topic}** — ${final}/${all.length} picks accepted.\nSheet: ${e.sheet_id ? sheetUrl(e.sheet_id) : '—'}`,
    embeds,
  });
}

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
      c.env.DB.prepare(
        `UPDATE signups SET reco_mal_id = NULL, reco_title = NULL, reco_title_en = NULL, reco_year = NULL,
           reco_type = NULL, reco_episodes = NULL, reco_url = NULL, reco_image = NULL,
           reco_status = 'NONE', reco_final_via = NULL, declines_used = 0, reco_declined_json = '[]',
           reco_card_posted = 0, updated_at = ?1
         WHERE event_id = ?2`,
      ).bind(now(), e.event_id),
      c.env.DB.prepare('DELETE FROM signup_drafts WHERE event_id = ?1').bind(e.event_id),
      c.env.DB.prepare('DELETE FROM reminders WHERE event_id = ?1 AND sent_at IS NULL').bind(e.event_id),
    ]);
    const items = await getItems(c.env, e.event_id);
    const ordered = await orderedSignups(c.env, e.event_id);
    await rewriteSheet(c.env, c.guild, e, items, ordered).catch(() => {});
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

export function launchModal(c: HCtx): Response {
  const e = needState(c, 'RECOMMENDING');
  if (!e) return stale(c);
  return respond.modal('axm:launch', 'Launch the exchange', [
    modalText('deadline', 'Review deadline (YYYY-MM-DD HH:mm)', {
      value: e.review_deadline && e.tz ? epochToZoned(e.review_deadline, e.tz) : '',
      max: 20, placeholder: '2026-10-01 21:00',
    }),
    modalText('tz', 'Timezone (IANA)', { value: e.tz ?? DEFAULT_TZ, max: 50, placeholder: DEFAULT_TZ }),
    modalText('days', 'Reminder days before deadline', {
      value: e.reminder_days || '7,3,1', max: 30, required: false,
      description: 'Comma-separated, e.g. 7,3,1 — empty for none',
    }),
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
  const days = parseReminderDays(f.get('days') ?? '');
  if (days === null) {
    return respond.ephemeral({ content: '⚠ Reminder days must be numbers 1–60, comma-separated (e.g. `7,3,1`) — or empty for none. Reopen **Launch**.' });
  }
  const mirror = f.get('mirror') === '1' ? 1 : 0;
  // Stage on the event row; ax:launch:go freezes them (§5.4).
  await c.env.DB.prepare(
    'UPDATE events SET review_deadline = ?1, tz = ?2, reminder_days = ?3, dm_mirror = ?4, updated_at = ?5 WHERE event_id = ?6',
  ).bind(deadline, tz, days.join(','), mirror, now(), e.event_id).run();
  const n = await countSignups(c.env, e.event_id);
  const agg = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN reco_status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN reco_status = 'NONE' THEN 1 ELSE 0 END), 0) AS waiting
     FROM signups WHERE event_id = ?1`,
  ).bind(e.event_id).first<{ pending: number; waiting: number }>();
  const pending = agg?.pending ?? 0;
  const waiting = agg?.waiting ?? 0;
  const reminderLine = days.length
    ? days.map((d) => `${d}d`).join(', ') + ' before the deadline'
    : 'none';
  return respond.ephemeral({
    content:
      `🚀 **Launch ${e.topic}?**\n` +
      `• Participants: **${n}** · accepted: **${n - pending - waiting}** · ⏳ pending: **${pending}** · 🎁 waiting on their Santa: **${waiting}**\n` +
      `• Review deadline: ${ts(deadline)} (${ts(deadline, 'R')})\n` +
      `• Reminders: ${reminderLine}${mirror ? ' (+ DM mirror)' : ''}\n\n` +
      (waiting > 0
        ? `⚠ **${waiting} Santa(s) haven't sent a pick** — the launch will refuse until every pick has been sent.\n\n`
        : pending > 0
          ? `**‼️The pending picks will be locked**\n\n`
          : '') +
      `Launching creates one review doc per participant for their anime and posts the assignment ` +
      `card in their existing thread (batched — ~${Math.max(1, Math.ceil(n / c.cfg.jobBatch))} min). Forward-only.`,
    components: [row(btn('ax:launch:go', '🚀 Confirm launch', Style.SUCCESS), btn('ax:cancel', 'Cancel'))],
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
    const waiting = await c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND reco_status = 'NONE'")
      .bind(e.event_id).first<{ n: number }>();
    if ((waiting?.n ?? 0) > 0) {
      await editOriginal(c.env, c.i.token, {
        content:
          `⚠ **${waiting!.n} Santa(s) haven't sent a pick yet** — every giftee needs a pick before launch. ` +
          `Use **📣 Remind Now** to nudge them.`,
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
      "UPDATE signups SET reco_status = 'FINAL', reco_final_via = 'FORCED', updated_at = ?1 WHERE event_id = ?2 AND reco_status = 'PENDING'",
    ).bind(now(), e.event_id).run();
    // Freeze reminders (§10.1): rows per (day × participant), future only.
    const days = parseReminderDays(e.reminder_days) ?? [];
    const participants = await orderedSignups(c.env, e.event_id);
    const stmts = [];
    for (const d of days) {
      const due = e.review_deadline! - d * 86400;
      if (due <= now()) continue;
      for (const p of participants) {
        stmts.push(c.env.DB.prepare(
          "INSERT INTO reminders (event_id, user_id, kind, due_at) VALUES (?1, ?2, 'review', ?3)",
        ).bind(e.event_id, p.user_id, due));
      }
    }
    if (stmts.length) await dbBatchChunked(c.env, stmts);
    await enqueueJob(c, e.event_id, 'launch');
    await repaint(c);
    await editOriginal(c.env, c.i.token, {
      content: `🚀 **Launching** — ${participants.length} review docs + assignment cards will be delivered over the next ~${Math.max(1, Math.ceil(participants.length / c.cfg.jobBatch))} minute(s). The panel counts up automatically.`,
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
  if (e.state === 'RUNNING') {
    const queued = await enqueueJob(c, e.event_id, 'sync');
    const agg = await c.env.DB
      .prepare('SELECT COALESCE(SUM(wrote), 0) AS started, COUNT(*) AS n FROM signups WHERE event_id = ?1')
      .bind(e.event_id).first<{ started: number; n: number }>();
    return respond.ephemeral({
      content:
        (queued
          ? '🔄 **Status refresh queued** — the panel and sheet update within a minute or two.'
          : '🔄 A refresh is already running — the panel and sheet update within a minute or two.') +
        `\n✍ **${agg?.started ?? 0} / ${agg?.n ?? 0}** started writing · full detail in the sheet: ${e.sheet_id ? sheetUrl(e.sheet_id) : '—'}`,
    });
  }
  bg(c, async () => {
    await repaint(c);
    if (e.state === 'SIGNUP_OPEN') {
      const n = await countSignups(c.env, e.event_id);
      await editOriginal(c.env, c.i.token, { content: `🔄 Refreshed — **${n}** signed up.` });
    } else {
      const agg = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN reco_status = 'FINAL' THEN 1 ELSE 0 END), 0) AS final,
                COALESCE(SUM(CASE WHEN reco_status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending
         FROM signups WHERE event_id = ?1`,
      ).bind(e.event_id).first<{ n: number; final: number; pending: number }>();
      const n = agg?.n ?? 0;
      const final = agg?.final ?? 0;
      const pending = agg?.pending ?? 0;
      await editOriginal(c.env, c.i.token, {
        content: `🔄 Refreshed — **${final} / ${n}** accepted · ⏳ **${pending}** awaiting a reply · 🎁 **${Math.max(0, n - final - pending)}** waiting on their Santa.`,
      });
    }
  });
  return respond.deferEphemeral();
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
  const { all, loops } = await loopContext(c.env, e.event_id);
  const targets = new Set<string>();
  all.forEach((s, idx) => {
    if (s.reco_status === 'NONE') targets.add(all[loops.santa[idx]!]!.user_id); // their Santa owes a pick
    if (s.reco_status === 'PENDING') targets.add(s.user_id);                    // they owe a reply
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
  const targets = await remindTargets(c, e);
  if (targets.length) {
    await dbBatchChunked(c.env, targets.map((uid) =>
      c.env.DB.prepare("INSERT INTO reminders (event_id, user_id, kind, due_at) VALUES (?1, ?2, 'manual', ?3)")
        .bind(e.event_id, uid, now())));
  }
  const ticks = Math.max(1, Math.ceil(targets.length / c.cfg.remindersPerTick));
  bg(c, async () => {
    await editOriginal(c.env, c.i.token, {
      content: `📣 Reminders queued for **${targets.length}** participant(s) — delivered within ~${ticks} minute(s).`,
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
