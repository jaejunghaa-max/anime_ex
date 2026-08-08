// Worker entry (spec §2.1): POST /interactions (Ed25519-verified), two OAuth
// routes, and the single minute cron. Interaction handlers respond within the
// 3-second rule; slow work rides ctx.waitUntil; participant-scaling fan-outs
// are cron-drained jobs.

import type { Env, Interaction } from './types';
import { cfgOf } from './types';
import { cronTick } from './cron';
import { diagnoseSearch } from './mal';
import { oauthCallback, oauthStart } from './oauth';
import { routeInteraction } from './handlers/router';
import { verifyDiscordSignature } from './util';

// Bumped on releases; shown on the health route so "is the new code live?"
// is answerable from a browser.
const BUILD = '3.1.0-reversible';

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
    // Search diagnostics: probes every source from the Worker's own network
    // position. Lightly gated (k = last 8 chars of the Discord public key)
    // to keep drive-by scanners from triggering upstream fetches.
    if (req.method === 'GET' && url.pathname === '/diag/search') {
      if (url.searchParams.get('k') !== env.DISCORD_PUBLIC_KEY.slice(-8)) {
        return new Response('missing/bad k (last 8 chars of DISCORD_PUBLIC_KEY)', { status: 403 });
      }
      const report = await diagnoseSearch(cfg, url.searchParams.get('q') ?? 'frieren');
      return new Response(JSON.stringify({ build: BUILD, ...report }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(`Anime Exchange bot is running. 🎁 (build ${BUILD})`, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ec: ExecutionContext): Promise<void> {
    ec.waitUntil(
      cronTick(env, cfgOf(env), controller.scheduledTime).catch((e) => console.error('cron tick failed', e)),
    );
  },
} satisfies ExportedHandler<Env>;
