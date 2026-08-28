// The "GUI": one pinned message per channel, edited in place. All rendering
// is a pure function of D1 state (spec §3.2) so a redeployed Worker repaints
// correctly — panels are re-rendered from scratch on every change.

import type { Cfg, Env, EventRow, GuildRow, JobRow } from './types';
import { btn, dapi, editMessage, embed, pinMessage, postMessage, row, Style } from './discord';
import { isConnected, sheetUrl } from './google';
import { MAX_PICKS } from './sheet';
import { loopsPhrase, ts } from './util';

export interface PanelStats {
  count: number;
  launched: number;
  revealed: number;
  started: number;
  threadsLeft: number;
  /** Prepare-job progress: threads + Santa task cards delivered. */
  prepared: number;
  /** Recommendation phase, counted in PEOPLE: with an accepted anime, owing a
   *  reply, and still waiting on their Santa. */
  recoAccepted: number;
  recoPending: number;
  recoNothing: number;
  /** Recommendation phase, counted in PICKS: accepted anime, and the total
   *  everyone asked for (the sum of each participant's own maximum). */
  picksAccepted: number;
  picksWanted: number;
  /** Review docs, counted per ANIME (v6): created, flipped read-only, total. */
  docsMade: number;
  docsFlipped: number;
  docsTotal: number;
  /** Loop sizes in block order, as of the last adoption into D1 (rev. 3). */
  groupSizes: number[];
  lastSync: number | null;
  activeJob: JobRow | null;
}

export async function panelStats(env: Env, event: EventRow | null): Promise<PanelStats> {
  if (!event) {
    return {
      count: 0, launched: 0, revealed: 0, started: 0, threadsLeft: 0,
      prepared: 0, recoAccepted: 0, recoPending: 0, recoNothing: 0,
      picksAccepted: 0, picksWanted: 0, docsMade: 0, docsFlipped: 0, docsTotal: 0,
      groupSizes: [], lastSync: null, activeJob: null,
    };
  }
  const agg = await env.DB.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(assignment_posted), 0) AS launched,
            COALESCE(SUM(reveal_posted), 0) AS revealed,
            COALESCE(SUM(wrote), 0) AS started,
            COALESCE(SUM(CASE WHEN thread_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS threadsLeft,
            COALESCE(SUM(reco_card_posted), 0) AS prepared
     FROM signups WHERE event_id = ?1`,
  ).bind(event.event_id).first<{
    count: number; launched: number; revealed: number; started: number;
    threadsLeft: number; prepared: number;
  }>();
  const recoAgg = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM recos x WHERE x.signup_id = s.signup_id AND x.status = 'FINAL') THEN 1 ELSE 0 END), 0) AS accepted,
       COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM recos x WHERE x.signup_id = s.signup_id AND x.status = 'PENDING') THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM recos x WHERE x.signup_id = s.signup_id AND x.status != 'DECLINED') THEN 1 ELSE 0 END), 0) AS awaiting,
       COALESCE(SUM((SELECT COUNT(*) FROM recos x WHERE x.signup_id = s.signup_id AND x.status = 'FINAL')), 0) AS picks,
       COALESCE(SUM(s.max_recos), 0) AS wanted
     FROM signups s WHERE s.event_id = ?1`,
  ).bind(event.event_id).first<{
    accepted: number; pending: number; awaiting: number; picks: number; wanted: number;
  }>();
  // Review docs are per ANIME since v6 — count them on `recos`, never on people.
  const docAgg = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN doc_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS made,
            COALESCE(SUM(doc_readonly), 0) AS flipped
     FROM recos WHERE event_id = ?1 AND status != 'DECLINED'`,
  ).bind(event.event_id).first<{ total: number; made: number; flipped: number }>();
  const activeJob = await env.DB
    .prepare('SELECT * FROM jobs WHERE event_id = ?1 AND done_at IS NULL ORDER BY id LIMIT 1')
    .bind(event.event_id).first<JobRow>();
  const lastSync = await env.DB
    .prepare("SELECT done_at FROM jobs WHERE event_id = ?1 AND kind = 'sync' AND done_at IS NOT NULL ORDER BY id DESC LIMIT 1")
    .bind(event.event_id).first<{ done_at: number }>();
  const groups = await env.DB
    .prepare('SELECT COUNT(*) AS c FROM signups WHERE event_id = ?1 GROUP BY group_no ORDER BY group_no')
    .bind(event.event_id).all<{ c: number }>();
  return {
    count: agg?.count ?? 0,
    launched: agg?.launched ?? 0,
    revealed: agg?.revealed ?? 0,
    started: agg?.started ?? 0,
    threadsLeft: agg?.threadsLeft ?? 0,
    prepared: agg?.prepared ?? 0,
    recoAccepted: recoAgg?.accepted ?? 0,
    recoPending: recoAgg?.pending ?? 0,
    recoNothing: recoAgg?.awaiting ?? 0,
    picksAccepted: recoAgg?.picks ?? 0,
    picksWanted: recoAgg?.wanted ?? 0,
    docsMade: docAgg?.made ?? 0,
    docsFlipped: docAgg?.flipped ?? 0,
    docsTotal: docAgg?.total ?? 0,
    groupSizes: groups.results.map((r) => r.c),
    lastSync: lastSync?.done_at ?? null,
    activeJob,
  };
}

function googleLine(guild: GuildRow): string {
  return isConnected(guild)
    ? `✅ Google: connected as **${guild.google_email ?? 'unknown'}**`
    : guild.google_email
      ? `⚠️ Google: **disconnected** (was ${guild.google_email}) — reconnect before continuing`
      : '⚠️ Google: **not connected**';
}

function stallLine(job: JobRow | null): string {
  if (job && job.attempts >= 5 && job.last_error) {
    return `\n⚠ **Stalled ${job.kind} job** (retrying every minute — fixing the cause self-heals):\n\`${job.last_error.slice(0, 300)}\``;
  }
  return '';
}

/** Shown while an abort's finish job is tearing threads down. */
function abortingLine(stats: PanelStats): string {
  return stats.activeJob?.kind === 'finish'
    ? `\n🛑 Aborting — ${stats.threadsLeft} thread(s) left to remove; panels reset when done.`
    : '';
}

/**
 * Honest per-tick estimate. Each entry is one drain pass with its own budget,
 * so their tick counts add. The floor is deliberate rather than exact: the
 * dispatcher runs ONE job per tick across every guild, and a tick that
 * delivers reminders skips job draining entirely, so a single-event estimate
 * is the best case and the wording has to say so.
 */
function etaMinutes(passes: number[], batch: number): string {
  const ticks = passes.reduce((acc, n) => acc + Math.ceil(Math.max(0, n) / Math.max(1, batch)), 0);
  return `~${Math.max(1, ticks)} min remaining, longer if other events are running`;
}

const abortBtn = () => btn('ax:abort', '🛑 Abort', Style.DANGER);

const googleBtnLabel = (g: GuildRow) => (isConnected(g) ? '🔗 Reconnect Google' : '🔗 Connect Google');

/** The sheet travels in the panel body on every state that has one — bold,
 *  first line of the manager embed; the panels carry no View Sheet buttons. */
const sheetTop = (e: EventRow): string => (e.sheet_id ? `**📝 Sheet:** ${sheetUrl(e.sheet_id)}\n` : '');

/** The Theme is participant-facing — shown on every participant panel state. */
const themeLine = (e: EventRow): string => (e.theme ? `🎨 **Theme:** ${e.theme}\n` : '');

const autostopBtn = (e: EventRow) => btn('ax:autostop', `⏰ Auto-stop: ${e.auto_stop ? 'ON' : 'OFF'}`);

export interface ItemSummary { label: string; type: 'FIB' | 'MCQ'; optionCount: number; visible: boolean }

// ---------------------------------------------------------- manager panel

export function renderManagerPanel(
  cfg: Cfg, guild: GuildRow, event: EventRow | null, stats: PanelStats, items: ItemSummary[],
): Record<string, unknown> {
  if (!event) {
    return {
      content: '',
      embeds: [embed({
        title: '🛠 Anime Exchange — Manager',
        description: `No event ongoing.\n\n${googleLine(guild)}`,
      })],
      components: [row(
        btn('ax:new_event', '🆕 New Event', Style.PRIMARY),
        btn('ax:google', googleBtnLabel(guild)),
      )],
    };
  }

  const e = event;

  switch (e.state) {
    case 'DRAFTING': {
      // The built-in list link is item 1 (editable wording); customs from 2.
      const itemLines = [
        `1. ${e.link_label || 'Link of your MAL/AniList'} — built-in — 👁 always visible to their Secret Santa`,
        ...items.map((it, i) =>
          `${i + 2}. ${it.label} — ${it.type === 'MCQ' ? `MCQ (${it.optionCount} options)` : 'fill-in'} — ${it.visible ? '👁 visible to your recommender' : '🔒 hidden'}`,
        ),
      ].join('\n');
      return {
        content: '',
        embeds: [embed({
          title: '📝 Drafting a new event',
          description:
            `**Session:** ${e.topic ?? '*not set*'}\n` +
            `**Theme:** ${e.theme ?? '*none*'}\n` +
            `**Sorry😞 budget:** **${e.max_declines}** per person\n` +
            `${googleLine(guild)}\n\n**Sign-up form**:\n${itemLines}\n\n` +
            `*The sign-up deadline and timezone are set when you press 📨 Open Sign-Ups.*`,
        })],
        components: [
          row(
            btn('ax:basics', '⚙ Set Basics', Style.PRIMARY),
            btn('ax:item_add', '➕ Add Item'),
            btn('ax:item_menu', '🛠 Edit Items'),
          ),
          row(
            btn('ax:google', googleBtnLabel(guild)),
            btn('ax:open', '📨 Open Sign-Ups', Style.SUCCESS),
            btn('ax:discard', '🗑 Discard', Style.DANGER),
            abortBtn(),
          ),
        ],
      };
    }
    case 'SIGNUP_OPEN':
      return {
        content: '',
        embeds: [embed({
          title: `📨 Sign-ups open — ${e.topic}`,
          description:
            sheetTop(e) +
            `**${stats.count}** signed up\n` +
            `**Deadline:** ${ts(e.signup_deadline!)} (${ts(e.signup_deadline!, 'R')})` +
            `${e.auto_stop ? ' · auto-stop **on**' : ''}\n${googleLine(guild)}`,
        })],
        components: [row(
          btn('ax:refresh', '🔄 Refresh'),
          autostopBtn(e),
          btn('ax:stop', '⏸ Stop Sign-Ups', Style.PRIMARY),
          abortBtn(),
        )],
      };
    case 'MATCHING': {
      // Loops summary as of the last adoption into D1 (rev. 3 §5.4).
      const loops = stats.groupSizes.length <= 1
        ? 'single'
        : `${stats.groupSizes.length} groups (${stats.groupSizes.join(' + ')})`;
      const validated = e.validated_at ? `last validated ${ts(e.validated_at, 'R')}` : 'not validated yet';
      return {
        content: '',
        embeds: [embed({
          title: `🔀 Matching — ${e.topic}`,
          description:
            sheetTop(e) +
            `**${stats.count}** participants · **Loops:** ${loops} · ${validated}\n` +
            `Flow: **1️⃣ Grouping** *(optional — only if you want several smaller loops)* → **2️⃣ Shuffle** (re-draw order within each loop) → hand-tune in the sheet (reorder rows / edit the Group column) → **✅ Validate** → **🎯 Start Recommending** (assignments lock — each row's Secret Santa is the next row in its loop).\n${googleLine(guild)}`,
        })],
        components: [
          row(
            btn('ax:grouping', '🧩 Grouping'),
            btn('ax:shuffle', '🔀 Shuffle'),
            btn('ax:validate', '✅ Validate'),
          ),
          row(
            btn('ax:reopen', '↩ Reopen Sign-Ups'),
            btn('ax:reco_start', '🎯 Start Recommending', Style.SUCCESS),
            abortBtn(),
          ),
        ],
      };
    }
    case 'PREPARING': {
      const remaining = Math.max(0, stats.count - stats.prepared);
      const eta = etaMinutes([remaining], cfg.jobBatch);
      return {
        content: '',
        embeds: [embed({
          title: `🎯 Preparing — ${e.topic}`,
          description:
            sheetTop(e) +
            `Creating private threads and delivering Santa missions… **${stats.prepared} / ${stats.count}** · ${eta} (automatic)` +
            stallLine(stats.activeJob) + abortingLine(stats),
        })],
        components: [row(abortBtn())],
      };
    }
    case 'RECOMMENDING': {
      const waiting = stats.recoNothing;
      const statusLine = waiting > 0
        ? `🚀 Launch unlocks once everyone has at least one pick — 📣 nudge the stragglers.`
        : stats.recoPending > 0
          ? `**‼️The pending picks will be locked** when you 🚀 Launch.`
          : `✅ **Everyone has an accepted anime — ready to 🚀 Launch.**`;
      const deadlineLine = e.reco_deadline
        ? `⏰ **Recommendation deadline:** ${ts(e.reco_deadline)} (${ts(e.reco_deadline, 'R')})` +
          `${e.reco_banner_flipped ? ' — **passed!** 📣 nudge or 🚀 Launch.' : ''}\n`
        : '';
      return {
        content: '',
        embeds: [embed({
          title: `🎯 Recommending — ${e.topic}`,
          description:
            sheetTop(e) +
            deadlineLine +
            `**${stats.recoAccepted} / ${stats.count}** participants accepted an anime · ` +
            `**${stats.picksAccepted} / ${stats.picksWanted}** picks accepted\n` +
            `Everyone chose their own maximum (1–${MAX_PICKS} picks) and may send a pick back **${e.max_declines}** time(s); accepted picks stay changeable until Launch.\n` +
            statusLine +
            `\n${googleLine(guild)}` + stallLine(stats.activeJob) + abortingLine(stats),
        })],
        components: [
          row(
            btn('ax:refresh', '🔄 Refresh'),
            btn('ax:remind', '📣 Remind Now'),
            autostopBtn(e),
          ),
          row(
            btn('ax:back_matching', '↩ Back to Matching'),
            btn('ax:launch', '🚀 Launch', Style.SUCCESS),
            abortBtn(),
          ),
        ],
      };
    }
    case 'LAUNCHING': {
      // Docs are per ANIME, cards per PARTICIPANT — and they drain in two
      // separate passes, each spending the whole per-tick budget, so the ticks
      // add rather than the totals. Pass 2 costs 1 + (their anime) messages.
      const docsLeft = Math.max(0, stats.docsTotal - stats.docsMade);
      const peopleLeft = Math.max(0, stats.count - stats.launched);
      // Each remaining person costs a header plus one message per anime; their
      // share of the anime is prorated, since which of them are left is unknown.
      const animeLeft = Math.round((stats.docsTotal * peopleLeft) / Math.max(1, stats.count));
      const eta = etaMinutes([docsLeft, peopleLeft + animeLeft], cfg.jobBatch);
      return {
        content: '',
        embeds: [embed({
          title: `🚀 Launching — ${e.topic}`,
          description:
            sheetTop(e) +
            `**${stats.docsMade} / ${stats.docsTotal}** review docs (one per anime) · ` +
            `**${stats.launched} / ${stats.count}** assignment cards · ${eta} (automatic)` +
            stallLine(stats.activeJob) + abortingLine(stats),
        })],
        components: [row(abortBtn())],
      };
    }
    case 'RUNNING': {
      const sync = stats.lastSync ? `last status sync ${ts(stats.lastSync, 'R')}` : 'no status sync yet';
      return {
        content: '',
        embeds: [embed({
          title: `🎬 Running — ${e.topic}`,
          description:
            sheetTop(e) +
            `**Review deadline:** ${ts(e.review_deadline!)} (${ts(e.review_deadline!, 'R')})\n` +
            `**${stats.started} / ${stats.count}** started writing · ${sync}\n${googleLine(guild)}` +
            stallLine(stats.activeJob) + abortingLine(stats),
        })],
        components: [row(
          btn('ax:refresh', '🔄 Refresh'),
          btn('ax:remind', '📣 Remind Now'),
          autostopBtn(e),
          btn('ax:close', '🏁 Close Reviews', Style.PRIMARY),
          abortBtn(),
        )],
      };
    }
    case 'CLOSING': {
      return {
        content: '',
        embeds: [embed({
          title: `🏁 Closing — ${e.topic}`,
          description:
            sheetTop(e) +
            `Flipping docs read-only and posting reveals…\n` +
            `(read-only: ${stats.docsFlipped}/${stats.docsTotal} docs · reveals: ${stats.revealed}/${stats.count})` +
            stallLine(stats.activeJob) + abortingLine(stats),
        })],
        components: [row(abortBtn())],
      };
    }
    case 'REVEALED': {
      const finishing = stats.activeJob?.kind === 'finish'
        ? `\n🧹 Cleaning up — ${stats.threadsLeft} thread(s) left to remove…${stallLine(stats.activeJob)}`
        : '';
      return {
        content: '',
        embeds: [embed({
          title: `🎉 Revealed — ${e.topic}`,
          description:
            sheetTop(e) +
            `**${stats.count}** participants · ${loopsPhrase(stats.groupSizes)} · review deadline was ${ts(e.review_deadline!)}\n` +
            `Docs are view-only; reveals are posted in participant threads.` + finishing,
        })],
        components: [row(btn('ax:finish', '🧹 Finish', Style.PRIMARY), abortBtn())],
      };
    }
    default:
      return { content: '', embeds: [embed({ title: '🛠 Anime Exchange — Manager', description: 'Unknown state.' })], components: [] };
  }
}

// ------------------------------------------------------ participant panel

const howItWorks = (maxDeclines: number): string =>
  `Sign up with a link to your MAL/AniList and say how many anime you want (up to ${MAX_PICKS}). ` +
  'You’ll be secretly assigned another participant — study their list and recommend for them, ' +
  'while your own Secret Santa picks for you. ' +
  (maxDeclines > 0
    ? `Not feeling a pick? Send it back with Sorry😞 (up to **${maxDeclines}** time${maxDeclines > 1 ? 's' : ''}). `
    : 'The pick you receive is final — trust your Santa. ') +
  'Then watch the full season and write a review in a Google Doc by the deadline. ' +
  'Who picked yours stays secret until the reveal. 🎁';

export function renderParticipantPanel(
  event: EventRow | null, stats: PanelStats,
): Record<string, unknown> {
  const title = '🎁 Anime Exchange';
  if (!event || event.state === 'DRAFTING') {
    return {
      content: '',
      embeds: [embed({ title, description: 'No event ongoing.' })],
      components: [],
    };
  }
  const e = event;
  switch (e.state) {
    case 'SIGNUP_OPEN': {
      const banner = e.signup_banner_flipped
        ? '\n\n**⏰ Deadline passed — still accepting until the manager closes sign-ups.**'
        : '';
      // The live signup count is deliberately manager-only — the participant
      // panel never shows how many people have signed up.
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description:
            themeLine(e) +
            `${howItWorks(e.max_declines)}\n\n**Sign-up deadline:** ${ts(e.signup_deadline!)} (${ts(e.signup_deadline!, 'R')})${banner}`,
        })],
        components: [row(
          btn('ax:signup', '📝 Sign Up/Edit', Style.PRIMARY),
          btn('ax:withdraw', '🚪 Withdraw', Style.DANGER),
        )],
      };
    }
    case 'MATCHING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description: themeLine(e) + '🔀 Sign-ups closed — matching in progress. Watch this space.',
        })],
        components: [],
      };
    case 'PREPARING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description:
            themeLine(e) +
            '🎯 Matching done! Your **private thread** is being created — it will tell you who *you* are the Secret Santa for. A few minutes.',
        })],
        components: [],
      };
    case 'RECOMMENDING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description:
            themeLine(e) +
            `🎯 **Recommendation time!** Pick anime for your person, and answer each pick you receive with **Thank you!😊** or **Sorry😞**` +
            `${e.max_declines > 0 ? ` (you can decline up to **${e.max_declines}** time${e.max_declines > 1 ? 's' : ''}, even after accepting — until launch)` : ''}.\n` +
            (e.reco_deadline
              ? `⏰ **Deadline:** ${ts(e.reco_deadline)} (${ts(e.reco_deadline, 'R')})` +
                `${e.reco_banner_flipped ? ' — **passed, lock in those picks!**' : ''}\n`
              : '') +
            `See your **private thread** to see your status.`,
        })],
        components: [],
      };
    case 'LAUNCHING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description: themeLine(e) + '🚀 All picks are locked in — review docs and assignment cards are being delivered to your thread now.',
        })],
        components: [],
      };
    case 'RUNNING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description:
            themeLine(e) +
            `🎬 Event running — check your **private thread** under this channel for your assignment.\n` +
            `**Review deadline:** ${ts(e.review_deadline!)} (${ts(e.review_deadline!, 'R')})`,
        })],
        components: [],
      };
    case 'CLOSING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description: themeLine(e) + '🏁 Reviews are closed — reveals are being posted to your thread now.',
        })],
        components: [],
      };
    case 'REVEALED':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description: themeLine(e) + `🎉 **${e.topic}** finished — ${stats.count} participants. Reveals are in your thread.`,
        })],
        components: [],
      };
    default:
      return { content: '', embeds: [embed({ title, description: 'No event ongoing.' })], components: [] };
  }
}

// ----------------------------------------------------------------- repaint

function countOptions(optionsJson: string | null): number {
  if (!optionsJson) return 0;
  try {
    const parsed = JSON.parse(optionsJson) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function loadPanelState(env: Env, guildId: string): Promise<{
  guild: GuildRow; event: EventRow | null; stats: PanelStats; items: ItemSummary[];
} | null> {
  const guild = await env.DB.prepare('SELECT * FROM guilds WHERE guild_id = ?1')
    .bind(guildId).first<GuildRow>();
  if (!guild) return null;
  const event = await env.DB.prepare('SELECT * FROM events WHERE guild_id = ?1')
    .bind(guildId).first<EventRow>();
  const stats = await panelStats(env, event);
  let items: ItemSummary[] = [];
  if (event) {
    const res = await env.DB
      .prepare('SELECT label, type, options_json, visible_to_recommender FROM form_items WHERE event_id = ?1 ORDER BY position')
      .bind(event.event_id).all<{ label: string; type: 'FIB' | 'MCQ'; options_json: string | null; visible_to_recommender: number }>();
    items = res.results.map((r) => ({
      label: r.label,
      // Guarded like every other reader (db.optionsOf): an unguarded parse here
      // threw out of loadPanelState, and since callers swallow repaint errors
      // both panels would silently stop updating instead of failing loudly.
      optionCount: countOptions(r.options_json),
      type: r.type,
      visible: !!r.visible_to_recommender,
    }));
  }
  return { guild, event, stats, items };
}

/** Re-render both panels from D1 and PATCH them in place. Failures are logged,
 *  never thrown — a deleted panel is repaired via /setup repair (§3.1). */
export async function repaintPanels(env: Env, cfg: Cfg, guildId: string): Promise<void> {
  const s = await loadPanelState(env, guildId);
  if (!s) return;
  const { guild, event, stats, items } = s;
  const jobs: Promise<unknown>[] = [];
  if (guild.manager_channel_id && guild.manager_msg_id) {
    jobs.push(
      editMessage(env, guild.manager_channel_id, guild.manager_msg_id,
        renderManagerPanel(cfg, guild, event, stats, items))
        .catch((e) => console.error('manager panel repaint failed', e)),
    );
  }
  if (guild.participant_channel_id && guild.participant_msg_id) {
    jobs.push(
      editMessage(env, guild.participant_channel_id, guild.participant_msg_id,
        renderParticipantPanel(event, stats))
        .catch((e) => console.error('participant panel repaint failed', e)),
    );
  }
  await Promise.all(jobs);
}

/** Post a panel, pin it, and sweep the "pinned a message" system notice. */
export async function postAndPinPanel(env: Env, channelId: string, payload: unknown): Promise<string> {
  const msg = await postMessage(env, channelId, payload);
  await pinMessage(env, channelId, msg.id).catch(() => {});
  type Recent = { id: string; type: number; author?: { id: string } };
  const recent = await dapi<Recent[]>(
    env, 'GET', `/channels/${channelId}/messages?limit=5`,
  ).catch(() => [] as Recent[]);
  for (const m of recent) {
    // Type 6 is "pinned a message". Only sweep our own — deleting by type alone
    // would take down a notice someone else's pin produced.
    if (m.type === 6 && m.author?.id === env.DISCORD_APP_ID) {
      await dapi(env, 'DELETE', `/channels/${channelId}/messages/${m.id}`).catch(() => {});
    }
  }
  return msg.id;
}

/**
 * Delete both pinned panels and post fresh ones, so they land at the BOTTOM
 * of their channels — run when an event finishes or is aborted (an old pinned
 * panel far up in the scrollback is easy to miss). Per-channel failures leave
 * the stored id pointing at whatever exists; /setup repair recovers.
 */
export async function repostPanels(env: Env, cfg: Cfg, guildId: string): Promise<void> {
  const s = await loadPanelState(env, guildId);
  if (!s) return;
  const { guild, event, stats, items } = s;
  const targets = [
    {
      channel: guild.manager_channel_id, msg: guild.manager_msg_id, column: 'manager_msg_id',
      sql: 'UPDATE guilds SET manager_msg_id = ?1 WHERE guild_id = ?2',
      payload: renderManagerPanel(cfg, guild, event, stats, items),
    },
    {
      channel: guild.participant_channel_id, msg: guild.participant_msg_id, column: 'participant_msg_id',
      sql: 'UPDATE guilds SET participant_msg_id = ?1 WHERE guild_id = ?2',
      payload: renderParticipantPanel(event, stats),
    },
  ];
  for (const t of targets) {
    if (!t.channel) continue;
    try {
      if (t.msg) {
        await dapi(env, 'DELETE', `/channels/${t.channel}/messages/${t.msg}`).catch(() => {});
      }
      const id = await postAndPinPanel(env, t.channel, t.payload);
      // Literal statements rather than an interpolated column name: the values
      // are safe today, but a built statement is one refactor from taking input.
      await env.DB.prepare(t.sql).bind(id, guildId).run();
    } catch (e) {
      console.error(`panel repost failed for ${t.column}`, e);
    }
  }
}
