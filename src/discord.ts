// Discord REST v10 client + interaction-response and component builders.
// Raw fetch (spec §2.4); handlers only ever build small JSON payloads.

import type { Env } from './types';
import { RT, EPHEMERAL } from './types';
import { sleep, truncate } from './util';

const API = 'https://discord.com/api/v10';

export class DiscordApiError extends Error {
  constructor(public status: number, public path: string, body: string) {
    super(`Discord ${status} on ${path}: ${truncate(body, 300)}`);
  }
}

/** REST call with one retry on 429 and one on 5xx. Returns undefined on 204. */
export async function dapi<T = unknown>(
  env: Env, method: string, path: string, body?: unknown,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Audit-Log-Reason': 'Anime Exchange bot',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 2) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min(5000, ((data.retry_after ?? 1) * 1000) + 50));
      continue;
    }
    if (res.status >= 500 && attempt < 1) {
      await sleep(600);
      continue;
    }
    if (!res.ok) throw new DiscordApiError(res.status, path, await res.text().catch(() => ''));
    if (res.status === 204) return undefined as T;
    return (await res.json().catch(() => undefined)) as T;
  }
}

// Follow-up plumbing for deferred interactions (token valid 15 min).
export function editOriginal(env: Env, token: string, payload: unknown): Promise<unknown> {
  return dapi(env, 'PATCH', `/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, payload);
}

export function followUp(env: Env, token: string, payload: Record<string, unknown>): Promise<unknown> {
  return dapi(env, 'POST', `/webhooks/${env.DISCORD_APP_ID}/${token}`, { flags: EPHEMERAL, ...payload });
}

export function postMessage(env: Env, channelId: string, payload: unknown): Promise<{ id: string }> {
  return dapi(env, 'POST', `/channels/${channelId}/messages`, payload);
}

export function editMessage(env: Env, channelId: string, messageId: string, payload: unknown): Promise<unknown> {
  return dapi(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
}

// ------------------------------------------------- interaction responses

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
}

export const respond = {
  pong: () => json({ type: RT.PONG }),
  /** Ephemeral message (type 4). */
  ephemeral: (data: Record<string, unknown>) =>
    json({ type: RT.MESSAGE, data: { flags: EPHEMERAL, ...data } }),
  /** Deferred ephemeral (type 5) — finish via editOriginal in waitUntil. */
  deferEphemeral: () => json({ type: RT.DEFER_MESSAGE, data: { flags: EPHEMERAL } }),
  /** Deferred update of the component's message (type 6). */
  deferUpdate: () => json({ type: RT.DEFER_UPDATE }),
  /** Immediate update of the component's message (type 7). */
  update: (data: Record<string, unknown>) => json({ type: RT.UPDATE_MESSAGE, data }),
  /** Open a modal (type 9) — must be the immediate response (§13.1). */
  modal: (custom_id: string, title: string, components: unknown[]) =>
    json({ type: RT.MODAL, data: { custom_id, title: truncate(title, 45), components } }),
};

// ------------------------------------------------------ message components

export type Button = {
  type: 2;
  style: number;
  label?: string;
  emoji?: { name: string };
  custom_id?: string;
  url?: string;
  disabled?: boolean;
};

export const Style = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 } as const;

export function btn(custom_id: string, label: string, style: number = Style.SECONDARY, disabled = false): Button {
  return { type: 2, style, label: truncate(label, 80), custom_id, disabled };
}

export function linkBtn(url: string, label: string): Button {
  return { type: 2, style: Style.LINK, label: truncate(label, 80), url };
}

export function row(...components: unknown[]): { type: 1; components: unknown[] } {
  return { type: 1, components };
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export function stringSelect(
  custom_id: string, placeholder: string, options: SelectOption[],
): Record<string, unknown> {
  return {
    type: 3,
    custom_id,
    placeholder: truncate(placeholder, 150),
    min_values: 1,
    max_values: 1,
    options: options.slice(0, 25).map((o) => ({
      ...o,
      label: truncate(o.label, 100),
      value: truncate(o.value, 100),
      description: o.description ? truncate(o.description, 100) : undefined,
    })),
  };
}

// ----------------------------------------------------- modal components
// Modals use the Label component (type 18) wrapping exactly one Text Input
// (type 4) or String Select (type 3) — the GA'd Components-v2 modal layout
// (spec §5.2 [verify], GA September 2025). Max 5 top-level components.

export function modalText(
  custom_id: string, label: string,
  opts: { required?: boolean; paragraph?: boolean; value?: string; placeholder?: string; max?: number; description?: string } = {},
): Record<string, unknown> {
  return {
    type: 18,
    label: truncate(label, 45),
    description: opts.description ? truncate(opts.description, 100) : undefined,
    component: {
      type: 4,
      custom_id,
      style: opts.paragraph ? 2 : 1,
      required: opts.required ?? true,
      value: opts.value || undefined,
      placeholder: opts.placeholder ? truncate(opts.placeholder, 100) : undefined,
      max_length: opts.max,
    },
  };
}

export function modalSelect(
  custom_id: string, label: string, options: SelectOption[],
  opts: { required?: boolean; placeholder?: string; description?: string } = {},
): Record<string, unknown> {
  return {
    type: 18,
    label: truncate(label, 45),
    description: opts.description ? truncate(opts.description, 100) : undefined,
    component: {
      type: 3,
      custom_id,
      required: opts.required ?? true,
      placeholder: opts.placeholder ? truncate(opts.placeholder, 150) : undefined,
      options: options.slice(0, 25).map((o) => ({
        ...o,
        label: truncate(o.label, 100),
        value: truncate(o.value, 100),
      })),
    },
  };
}

// ----------------------------------------------------------------- embeds

export const ACCENT = 0x8e6ce8;

export function embed(e: {
  title?: string; description?: string; color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  thumbnail?: string; image?: string; footer?: string; url?: string;
}): Record<string, unknown> {
  return {
    title: e.title ? truncate(e.title, 256) : undefined,
    description: e.description ? truncate(e.description, 4096) : undefined,
    color: e.color ?? ACCENT,
    url: e.url,
    fields: e.fields?.slice(0, 25).map((f) => ({
      name: truncate(f.name, 256), value: truncate(f.value || '—', 1024), inline: f.inline,
    })),
    thumbnail: e.thumbnail ? { url: e.thumbnail } : undefined,
    image: e.image ? { url: e.image } : undefined,
    footer: e.footer ? { text: truncate(e.footer, 2048) } : undefined,
  };
}

// ------------------------------------------------------- guild resources

export function createRole(env: Env, guildId: string, name: string): Promise<{ id: string }> {
  return dapi(env, 'POST', `/guilds/${guildId}/roles`, { name, permissions: '0', mentionable: false });
}

export function addMemberRole(env: Env, guildId: string, userId: string, roleId: string): Promise<void> {
  return dapi(env, 'PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
}

export interface Overwrite { id: string; type: 0 | 1; allow: string; deny: string }

export function createChannel(
  env: Env, guildId: string, name: string, topic: string, overwrites: Overwrite[],
): Promise<{ id: string }> {
  return dapi(env, 'POST', `/guilds/${guildId}/channels`, {
    name, type: 0, topic, permission_overwrites: overwrites,
  });
}

export function pinMessage(env: Env, channelId: string, messageId: string): Promise<void> {
  // New pins endpoint (2025); the old /channels/{id}/pins/{mid} is deprecated.
  return dapi(env, 'PUT', `/channels/${channelId}/messages/pins/${messageId}`);
}

export function createPrivateThread(env: Env, channelId: string, name: string): Promise<{ id: string }> {
  return dapi(env, 'POST', `/channels/${channelId}/threads`, {
    name: truncate(name, 100), type: 12, auto_archive_duration: 10080, invitable: false,
  });
}

export function addThreadMember(env: Env, threadId: string, userId: string): Promise<void> {
  return dapi(env, 'PUT', `/channels/${threadId}/thread-members/${userId}`);
}

export function deleteChannel(env: Env, channelId: string): Promise<void> {
  return dapi(env, 'DELETE', `/channels/${channelId}`);
}

/** DM mirror (§10.2): create-or-get the DM channel. */
export function createDm(env: Env, userId: string): Promise<{ id: string }> {
  return dapi(env, 'POST', `/users/@me/channels`, { recipient_id: userId });
}

// Permission bits used by /setup (§3.1).
const P = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  ADD_REACTIONS: 1n << 6n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

const sum = (...bits: bigint[]) => bits.reduce((a, b) => a | b, 0n).toString();

export function managerChannelOverwrites(guildId: string, managerRoleId: string, botId: string): Overwrite[] {
  return [
    { id: guildId, type: 0, allow: '0', deny: sum(P.VIEW_CHANNEL) },
    {
      id: managerRoleId, type: 0,
      allow: sum(P.VIEW_CHANNEL, P.READ_MESSAGE_HISTORY),
      deny: sum(P.SEND_MESSAGES, P.SEND_MESSAGES_IN_THREADS, P.ADD_REACTIONS),
    },
    {
      id: botId, type: 1,
      allow: sum(P.VIEW_CHANNEL, P.SEND_MESSAGES, P.EMBED_LINKS, P.READ_MESSAGE_HISTORY, P.MANAGE_MESSAGES),
      deny: '0',
    },
  ];
}

export function participantChannelOverwrites(guildId: string, botId: string): Overwrite[] {
  return [
    {
      id: guildId, type: 0,
      allow: sum(P.VIEW_CHANNEL, P.READ_MESSAGE_HISTORY),
      deny: sum(
        P.SEND_MESSAGES, P.SEND_MESSAGES_IN_THREADS,
        P.CREATE_PUBLIC_THREADS, P.CREATE_PRIVATE_THREADS, P.ADD_REACTIONS,
      ),
    },
    {
      id: botId, type: 1,
      allow: sum(
        P.VIEW_CHANNEL, P.SEND_MESSAGES, P.EMBED_LINKS, P.READ_MESSAGE_HISTORY,
        P.MANAGE_MESSAGES, P.MANAGE_THREADS, P.CREATE_PRIVATE_THREADS, P.SEND_MESSAGES_IN_THREADS,
      ),
      deny: '0',
    },
  ];
}
