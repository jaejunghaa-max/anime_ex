// Shared handler context + the deferred-work wrapper. Handlers respond within
// the 3-second rule and push slow work into ctx.waitUntil (spec §2.1), which
// edits the deferred ephemeral when it finishes — or with a caught error.

import type { Cfg, Env, EventRow, GuildRow, Interaction } from '../types';
import { editOriginal, respond } from '../discord';
import { GOOGLE_RECONNECT_MSG, GoogleAuthError } from '../google';
import { repaintPanels } from '../panels';
import { shortRef } from '../util';

export interface HCtx {
  env: Env;
  cfg: Cfg;
  ec: ExecutionContext;
  i: Interaction;
  guild: GuildRow;
  event: EventRow | null;
  userId: string;
  displayName: string;
  isManager: boolean;
}

/** Run deferred work; on failure edit the deferred message with a short ref. */
export function bg(c: HCtx, work: () => Promise<void>): void {
  c.ec.waitUntil(
    work().catch(async (e: unknown) => {
      const ref = shortRef();
      console.error(`[${ref}]`, e instanceof Error ? `${e.message}\n${e.stack}` : e);
      const content = e instanceof GoogleAuthError
        ? GOOGLE_RECONNECT_MSG
        : `⚠ Something went wrong (\`${ref}\`) — try again.`;
      await editOriginal(c.env, c.i.token, { content, embeds: [], components: [] }).catch(() => {});
    }),
  );
}

export function repaint(c: HCtx): Promise<void> {
  return repaintPanels(c.env, c.cfg, c.guild.guild_id);
}

/** "State changed under you" reply: explain ephemerally + repaint panels (§13.1). */
export function stale(c: HCtx, msg = 'That action no longer applies — the event moved on. Panels refreshed.'): Response {
  c.ec.waitUntil(repaint(c).catch(() => {}));
  return respond.ephemeral({ content: `↻ ${msg}` });
}

export function managerOnly(): Response {
  return respond.ephemeral({ content: '🔒 Manager only — you need the **Exchange Manager** role.' });
}

/** Mark the participant-count panels dirty, repainting at most every 60 s (§5.3). */
export async function throttledCountRepaint(c: HCtx, eventId: number): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  const res = await c.env.DB.prepare(
    'UPDATE events SET count_panel_at = ?1, panel_dirty = 0 WHERE event_id = ?2 AND count_panel_at <= ?3',
  ).bind(nowS, eventId, nowS - 60).run();
  if ((res.meta.changes ?? 0) > 0) {
    await repaint(c);
  } else {
    await c.env.DB.prepare('UPDATE events SET panel_dirty = 1 WHERE event_id = ?1').bind(eventId).run();
  }
}
