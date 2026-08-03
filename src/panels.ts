// The "GUI": one pinned message per channel, edited in place. All rendering
// is a pure function of D1 state (spec §3.2) so a redeployed Worker repaints
// correctly — panels are re-rendered from scratch on every change.

import type { Cfg, Env, EventRow, GuildRow, JobRow } from './types';
import { btn, editMessage, embed, linkBtn, row, Style } from './discord';
import { isConnected, sheetUrl } from './google';
import { ts } from './util';

export interface PanelStats {
  count: number;
  launched: number;
  flipped: number;
  revealed: number;
  started: number;
  threadsLeft: number;
  lastSync: number | null;
  activeJob: JobRow | null;
}

export async function panelStats(env: Env, event: EventRow | null): Promise<PanelStats> {
  if (!event) {
    return { count: 0, launched: 0, flipped: 0, revealed: 0, started: 0, threadsLeft: 0, lastSync: null, activeJob: null };
  }
  const agg = await env.DB.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(assignment_posted), 0) AS launched,
            COALESCE(SUM(doc_readonly), 0) AS flipped,
            COALESCE(SUM(reveal_posted), 0) AS revealed,
            COALESCE(SUM(wrote), 0) AS started,
            COALESCE(SUM(CASE WHEN thread_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS threadsLeft
     FROM signups WHERE event_id = ?1`,
  ).bind(event.event_id).first<{ count: number; launched: number; flipped: number; revealed: number; started: number; threadsLeft: number }>();
  const activeJob = await env.DB
    .prepare('SELECT * FROM jobs WHERE event_id = ?1 AND done_at IS NULL ORDER BY id LIMIT 1')
    .bind(event.event_id).first<JobRow>();
  const lastSync = await env.DB
    .prepare("SELECT done_at FROM jobs WHERE event_id = ?1 AND kind = 'sync' AND done_at IS NOT NULL ORDER BY id DESC LIMIT 1")
    .bind(event.event_id).first<{ done_at: number }>();
  return {
    count: agg?.count ?? 0,
    launched: agg?.launched ?? 0,
    flipped: agg?.flipped ?? 0,
    revealed: agg?.revealed ?? 0,
    started: agg?.started ?? 0,
    threadsLeft: agg?.threadsLeft ?? 0,
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

const googleBtnLabel = (g: GuildRow) => (isConnected(g) ? '🔗 Reconnect Google' : '🔗 Connect Google');

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
  const sheetBtn = e.sheet_id ? linkBtn(sheetUrl(e.sheet_id), '📋 View Sheet') : null;

  switch (e.state) {
    case 'DRAFTING': {
      const itemLines = items.length
        ? items.map((it, i) =>
            `${i + 1}. ${it.label} — ${it.type === 'MCQ' ? `MCQ (${it.optionCount} options)` : 'fill-in'} — ${it.visible ? '👁 visible to your recommender' : '🔒 hidden'}`,
          ).join('\n')
        : '*no custom items yet*';
      const deadline = e.signup_deadline
        ? `${ts(e.signup_deadline)} (${ts(e.signup_deadline, 'R')})`
        : '*not set*';
      return {
        content: '',
        embeds: [embed({
          title: '📝 Drafting a new event',
          description:
            `**Topic:** ${e.topic ?? '*not set*'}\n` +
            `**Sign-up deadline:** ${deadline}\n` +
            `**Timezone:** ${e.tz ?? '*not set*'} · **Auto-stop:** ${e.auto_stop ? 'on' : 'off'}\n` +
            `${googleLine(guild)}\n\n**Sign-up form items** (max 9):\n${itemLines}`,
        })],
        components: [
          row(
            btn('ax:basics', '⚙ Set Basics', Style.PRIMARY),
            btn('ax:item_add', '➕ Add Item'),
            btn('ax:item_menu', '🛠 Edit Items', Style.SECONDARY, items.length === 0),
          ),
          row(
            btn('ax:google', googleBtnLabel(guild)),
            btn('ax:open', '📨 Open Sign-Ups', Style.SUCCESS),
            btn('ax:discard', '🗑 Discard', Style.DANGER),
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
            `**Deadline:** ${ts(e.signup_deadline!)} (${ts(e.signup_deadline!, 'R')})` +
            `${e.auto_stop ? ' · auto-stop **on**' : ''}\n` +
            `**${stats.count}** signed up\n${googleLine(guild)}`,
        })],
        components: [row(
          btn('ax:view_signups', '📋 View Sign-Ups'),
          btn('ax:stop', '🛑 Stop Sign-Ups', Style.DANGER),
        )],
      };
    case 'MATCHING': {
      const loop =
        e.loop_status === 'none' ? 'not yet shuffled'
        : e.loop_status === 'shuffled' ? 'shuffled'
        : 'manually reordered';
      const validated = e.validated_at ? ` — last validated ${ts(e.validated_at, 'R')}` : '';
      return {
        content: '',
        embeds: [embed({
          title: `🔀 Matching — ${e.topic}`,
          description:
            `**${stats.count}** participants\n**Loop:** ${loop}${validated}\n` +
            `Reorder rows in the sheet to hand-tune assignments, then **Validate**.\n${googleLine(guild)}`,
        })],
        components: [
          row(...[sheetBtn, btn('ax:shuffle', '🔀 Shuffle'), btn('ax:validate', '✅ Validate')].filter(Boolean) as unknown[]),
          row(btn('ax:reopen', '↩ Reopen Sign-Ups'), btn('ax:launch', '🚀 Launch', Style.SUCCESS)),
        ],
      };
    }
    case 'LAUNCHING': {
      const remaining = Math.max(0, stats.count - stats.launched);
      const eta = Math.max(1, Math.ceil(remaining / cfg.jobBatch));
      return {
        content: '',
        embeds: [embed({
          title: `🚀 Launching — ${e.topic}`,
          description:
            `**${stats.launched} / ${stats.count}** assignments delivered · ~${eta} min remaining (automatic)` +
            stallLine(stats.activeJob),
        })],
        components: sheetBtn ? [row(sheetBtn)] : [],
      };
    }
    case 'RUNNING': {
      const sync = stats.lastSync ? `last status sync ${ts(stats.lastSync, 'R')}` : 'no status sync yet';
      return {
        content: '',
        embeds: [embed({
          title: `🎬 Running — ${e.topic}`,
          description:
            `**Review deadline:** ${ts(e.review_deadline!)} (${ts(e.review_deadline!, 'R')})\n` +
            `**${stats.started} / ${stats.count}** started writing · ${sync}\n${googleLine(guild)}` +
            stallLine(stats.activeJob),
        })],
        components: [row(
          btn('ax:view_event', '📊 View Event'),
          btn('ax:refresh', '🔄 Refresh Status'),
          btn('ax:remind', '📣 Remind Now'),
          btn('ax:close', '🏁 Close Reviews', Style.DANGER),
        )],
      };
    }
    case 'CLOSING': {
      const done = Math.min(stats.flipped, stats.revealed);
      return {
        content: '',
        embeds: [embed({
          title: `🏁 Closing — ${e.topic}`,
          description:
            `Flipping docs read-only and posting reveals… **${done} / ${stats.count}**\n` +
            `(read-only: ${stats.flipped}/${stats.count} · reveals: ${stats.revealed}/${stats.count})` +
            stallLine(stats.activeJob),
        })],
        components: sheetBtn ? [row(sheetBtn)] : [],
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
            `**${stats.count}** participants · review deadline was ${ts(e.review_deadline!)}\n` +
            `Docs are view-only; reveals are posted in participant threads.` + finishing,
        })],
        components: [row(...[sheetBtn, btn('ax:finish', '🧹 Finish', Style.DANGER)].filter(Boolean) as unknown[])],
      };
    }
    default:
      return { content: '', embeds: [embed({ title: '🛠 Anime Exchange — Manager', description: 'Unknown state.' })], components: [] };
  }
}

// ------------------------------------------------------ participant panel

const HOW_IT_WORKS =
  'Submit one anime recommendation. You’ll receive another participant’s pick at random, ' +
  'watch the full season, and write a review in a Google Doc by the deadline. ' +
  'Who recommended yours stays secret until the reveal. 🎁';

export function renderParticipantPanel(
  cfg: Cfg, guild: GuildRow, event: EventRow | null, stats: PanelStats, itemCount: number,
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
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description:
            `${HOW_IT_WORKS}\n\n**Sign-up deadline:** ${ts(e.signup_deadline!)} (${ts(e.signup_deadline!, 'R')})\n` +
            `**Sign-up form:** anime pick + ${itemCount} question(s)\n**${stats.count}** signed up${banner}`,
        })],
        components: [row(
          btn('ax:signup', '📝 Sign Up', Style.PRIMARY),
          btn('ax:edit_signup', '✏ Edit My Sign-Up'),
          btn('ax:withdraw', '🚪 Withdraw', Style.DANGER),
        )],
      };
    }
    case 'MATCHING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description: '🔀 Sign-ups closed — matching in progress. Watch this space.',
        })],
        components: [],
      };
    case 'LAUNCHING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description: '🚀 Matching done — assignments are being delivered now. Your private thread will appear within a few minutes.',
        })],
        components: [],
      };
    case 'RUNNING':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description:
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
          description: '🏁 Reviews are closed — reveals are being posted to your thread now.',
        })],
        components: [],
      };
    case 'REVEALED':
      return {
        content: '',
        embeds: [embed({
          title: `${title} — ${e.topic}`,
          description: `🎉 **${e.topic}** finished — ${stats.count} participants. Reveals are in your thread.`,
        })],
        components: [],
      };
    default:
      return { content: '', embeds: [embed({ title, description: 'No event ongoing.' })], components: [] };
  }
}

// ----------------------------------------------------------------- repaint

/** Re-render both panels from D1 and PATCH them in place. Failures are logged,
 *  never thrown — a deleted panel is repaired via /setup repair (§3.1). */
export async function repaintPanels(env: Env, cfg: Cfg, guildId: string): Promise<void> {
  const guild = await env.DB.prepare('SELECT * FROM guilds WHERE guild_id = ?1')
    .bind(guildId).first<GuildRow>();
  if (!guild) return;
  const event = await env.DB.prepare('SELECT * FROM events WHERE guild_id = ?1')
    .bind(guildId).first<EventRow>();
  const stats = await panelStats(env, event);
  let items: ItemSummary[] = [];
  let itemCount = 0;
  if (event) {
    const res = await env.DB
      .prepare('SELECT label, type, options_json, visible_to_recommender FROM form_items WHERE event_id = ?1 ORDER BY position')
      .bind(event.event_id).all<{ label: string; type: 'FIB' | 'MCQ'; options_json: string | null; visible_to_recommender: number }>();
    items = res.results.map((r) => ({
      label: r.label,
      type: r.type,
      optionCount: r.options_json ? (JSON.parse(r.options_json) as string[]).length : 0,
      visible: !!r.visible_to_recommender,
    }));
    itemCount = items.length;
  }
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
        renderParticipantPanel(cfg, guild, event, stats, itemCount))
        .catch((e) => console.error('participant panel repaint failed', e)),
    );
  }
  await Promise.all(jobs);
}
