// Worker entry (spec §2.1): POST /interactions (Ed25519-verified), two OAuth
// routes, and the single minute cron. Interaction handlers respond within the
// 3-second rule; slow work rides ctx.waitUntil; participant-scaling fan-outs
// are cron-drained jobs.

import type { Env, Interaction } from './types';
import { cfgOf } from './types';
import { cronTick } from './cron';
import { oauthCallback, oauthStart } from './oauth';
import { routeInteraction } from './handlers/router';
import { verifyDiscordSignature } from './util';

export default {
  async fetch(req: Request, env: Env, ec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const cfg = cfgOf(env);

    if (req.method === 'POST' && url.pathname === '/interactions') {
      const sig = req.headers.get('X-Signature-Ed25519');
      const timestamp = req.headers.get('X-Signature-Timestamp');
      const body = await req.text();
      if (!sig || !timestamp ||
          !(await verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, sig, timestamp, body))) {
        return new Response('invalid request signature', { status: 401 });
      }
      let interaction: Interaction;
      try {
        interaction = JSON.parse(body) as Interaction;
      } catch {
        return new Response('bad payload', { status: 400 });
      }
      return routeInteraction(env, cfg, ec, interaction);
    }

    if (req.method === 'GET' && url.pathname === '/google/oauth/start') {
      return oauthStart(env, url);
    }
    if (req.method === 'GET' && url.pathname === '/google/oauth/callback') {
      return oauthCallback(env, cfg, ec, url);
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response('Anime Exchange bot is running. 🎁', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ec: ExecutionContext): Promise<void> {
    ec.waitUntil(
      cronTick(env, cfgOf(env), controller.scheduledTime).catch((e) => console.error('cron tick failed', e)),
    );
  },
} satisfies ExportedHandler<Env>;
