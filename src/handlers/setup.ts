// /setup init|repair (spec §3.1). An HTTP-only bot gets no "invited" event,
// so resource creation is explicit — and `repair` re-creates anything missing
// from the stored ids (panels re-render from D1, restart-safe by design).

import type { Cfg, Env, EventRow, GuildRow, Interaction } from '../types';
import {
  addMemberRole, createChannel, createRole, dapi, DiscordApiError, editOriginal,
  managerChannelOverwrites, participantChannelOverwrites, respond,
} from '../discord';
import { panelStats, postAndPinPanel, renderManagerPanel, renderParticipantPanel } from '../panels';
import { now } from '../util';

const MANAGER_CHANNEL = 'anime-exchange-manager';
const PARTICIPANT_CHANNEL = 'anime-exchange';

const ADMIN_BIT = 8n;

export function isAdmin(i: Interaction): boolean {
  try {
    return (BigInt(i.member?.permissions ?? '0') & ADMIN_BIT) === ADMIN_BIT;
  } catch {
    return false;
  }
}

/**
 * Does the stored resource still exist?
 *
 * Only 404 means gone. A 403 means it is there but the bot cannot see it —
 * treating that as "missing" made `/setup repair` create a duplicate channel
 * and abandon the original along with its pinned panel and history, which is
 * exactly what happens when someone runs `repair` *because* permissions broke.
 * Keep the stored id and tell the manager what to fix.
 */
async function exists(env: Env, path: string, notes: string[]): Promise<boolean> {
  try {
    await dapi(env, 'GET', path);
    return true;
  } catch (e) {
    if (e instanceof DiscordApiError) {
      if (e.status === 404) return false;
      if (e.status === 403) {
        notes.push(
          `Could not verify \`${path}\` — the bot is denied access (403). Keeping the existing ` +
          'resource rather than creating a duplicate. Give the bot **View Channel** (and **Read ' +
          'Message History**) there, then run `/setup repair` again.',
        );
        return true;
      }
    }
    throw e;
  }
}


export async function handleSetup(
  env: Env, cfg: Cfg, ec: ExecutionContext, i: Interaction,
): Promise<Response> {
  const sub = i.data?.options?.[0]?.name === 'repair' ? 'repair' : 'init';
  const guildId = i.guild_id;
  const invoker = i.member?.user.id;
  if (!guildId || !invoker) return respond.ephemeral({ content: 'Run this inside a server.' });
  if (!isAdmin(i)) return respond.ephemeral({ content: '🔒 `/setup` needs the **Administrator** permission.' });

  ec.waitUntil(
    doSetup(env, cfg, guildId, invoker, sub)
      .then((summary) => editOriginal(env, i.token, { content: summary }))
      .catch(async (e: unknown) => {
        console.error('setup failed', e);
        const hint = e instanceof DiscordApiError && e.status === 403
          ? ' The bot is missing permissions — re-invite it with the URL from `npm run register` (Manage Roles, Manage Channels, Manage Threads, …).'
          : '';
        await editOriginal(env, i.token, { content: `⚠ Setup failed: ${e instanceof Error ? e.message : e}${hint}` }).catch(() => {});
      }),
  );
  return respond.deferEphemeral();
}

async function doSetup(
  env: Env, cfg: Cfg, guildId: string, invoker: string, sub: 'init' | 'repair',
): Promise<string> {
  const botId = env.DISCORD_APP_ID;
  const existing = await env.DB.prepare('SELECT * FROM guilds WHERE guild_id = ?1')
    .bind(guildId).first<GuildRow>();
  const notes: string[] = [];
  if (sub === 'repair' && !existing) return '⚠ Nothing to repair — run `/setup init` first.';
  if (sub === 'init' && existing) notes.push('Already set up — verifying and repairing missing pieces instead.');

  const g: GuildRow = existing ?? {
    guild_id: guildId,
    manager_channel_id: null, participant_channel_id: null,
    manager_msg_id: null, participant_msg_id: null,
    manager_role_id: null,
    google_refresh_token_enc: null, google_email: null,
    created_at: now(),
  };

  // 1. Role — a visibility key only, no Discord permissions (§3.1).
  let roleOk = false;
  if (g.manager_role_id) {
    const roles = await dapi<Array<{ id: string }>>(env, 'GET', `/guilds/${guildId}/roles`);
    roleOk = roles.some((r) => r.id === g.manager_role_id);
  }
  if (!roleOk) {
    const role = await createRole(env, guildId, 'Exchange Manager');
    g.manager_role_id = role.id;
    // Persist the id NOW, not at step 5. The permission gate matches this id
    // exactly, so if anything below throws (a 403 creating channels is the
    // usual one) the role would exist on the invoker while D1 still knew
    // nothing about it — leaving a manager holding a role the bot rejects,
    // and the next /setup creating yet another one.
    await env.DB.prepare(
      `INSERT INTO guilds (guild_id, manager_role_id, created_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(guild_id) DO UPDATE SET manager_role_id = excluded.manager_role_id`,
    ).bind(guildId, role.id, g.created_at).run();
    notes.push('Created the **Exchange Manager** role.');
  }
  // Always hand the stored role to whoever ran /setup, not just when it was
  // just created — this is the self-service way out of "I have a manager role
  // but the bot says I don't".
  await addMemberRole(env, guildId, invoker, g.manager_role_id!).catch(() => {
    notes.push('Could not assign the **Exchange Manager** role to you — move the bot’s own role above it in Server Settings → Roles, then run `/setup repair` again.');
  });

  // 2 + 3. Channels.
  if (!g.manager_channel_id || !(await exists(env, `/channels/${g.manager_channel_id}`, notes))) {
    const ch = await createChannel(env, guildId, MANAGER_CHANNEL,
      'Anime Exchange — manager controls. Buttons on the pinned panel.',
      managerChannelOverwrites(guildId, g.manager_role_id!, botId));
    g.manager_channel_id = ch.id;
    g.manager_msg_id = null;
    notes.push(`Created <#${ch.id}>.`);
  } else {
    // Existing channel: re-apply the current permission set (read-only for
    // everyone — nobody can send), so perm changes land via /setup repair.
    await dapi(env, 'PATCH', `/channels/${g.manager_channel_id}`, {
      permission_overwrites: managerChannelOverwrites(guildId, g.manager_role_id!, botId),
    }).catch((e) => console.error('manager channel perms patch failed', e));
  }
  if (!g.participant_channel_id || !(await exists(env, `/channels/${g.participant_channel_id}`, notes))) {
    const ch = await createChannel(env, guildId, PARTICIPANT_CHANNEL,
      'Anime Exchange — sign up on the pinned panel. Your assignment arrives in a private thread.',
      participantChannelOverwrites(guildId, botId));
    g.participant_channel_id = ch.id;
    g.participant_msg_id = null;
    notes.push(`Created <#${ch.id}>.`);
  } else {
    await dapi(env, 'PATCH', `/channels/${g.participant_channel_id}`, {
      permission_overwrites: participantChannelOverwrites(guildId, botId),
    }).catch((e) => console.error('participant channel perms patch failed', e));
  }

  // 4. Panels (rendered from current D1 state — repair-safe).
  const event = await env.DB.prepare('SELECT * FROM events WHERE guild_id = ?1')
    .bind(guildId).first<EventRow>();
  const stats = await panelStats(env, event);
  if (!g.manager_msg_id || !(await exists(env, `/channels/${g.manager_channel_id}/messages/${g.manager_msg_id}`, notes))) {
    g.manager_msg_id = await postAndPinPanel(env, g.manager_channel_id!,
      renderManagerPanel(cfg, g, event, stats, []));
    notes.push('Posted + pinned the manager panel.');
  }
  if (!g.participant_msg_id || !(await exists(env, `/channels/${g.participant_channel_id}/messages/${g.participant_msg_id}`, notes))) {
    g.participant_msg_id = await postAndPinPanel(env, g.participant_channel_id!,
      renderParticipantPanel(event, stats));
    notes.push('Posted + pinned the participant panel.');
  }

  // 5. Persist ids (google connection untouched).
  await env.DB.prepare(
    `INSERT INTO guilds (guild_id, manager_channel_id, participant_channel_id, manager_msg_id,
                         participant_msg_id, manager_role_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(guild_id) DO UPDATE SET
       manager_channel_id = excluded.manager_channel_id,
       participant_channel_id = excluded.participant_channel_id,
       manager_msg_id = excluded.manager_msg_id,
       participant_msg_id = excluded.participant_msg_id,
       manager_role_id = excluded.manager_role_id`,
  ).bind(guildId, g.manager_channel_id, g.participant_channel_id, g.manager_msg_id,
    g.participant_msg_id, g.manager_role_id, g.created_at).run();

  const done = notes.length ? notes.map((n) => `• ${n}`).join('\n') : '• Everything already in place — panels re-verified.';
  return `✅ Setup ${sub === 'repair' ? 'repair ' : ''}complete:\n${done}\n\n` +
    `Manager role: <@&${g.manager_role_id}> — the bot matches this exact role, so any similarly ` +
    `named role you made yourself will not work.\n` +
    `Next: open <#${g.manager_channel_id}> and press **Connect Google**, then **New Event**.`;
}
