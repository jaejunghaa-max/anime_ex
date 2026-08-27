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
import { timingSafeEqual, verifyDiscordSignature } from './util';

// Bumped on releases; shown on the health route so "is the new code live?"
// is answerable from a browser.
const BUILD = '7.0.0-per-anime-panels';

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
    // position, so "which upstream is blocking us" stops being guesswork.
    //
    // Gated on the DIAG_KEY secret, and OFF entirely when that is unset. The
    // old gate was the last 8 characters of DISCORD_PUBLIC_KEY — a value
    // published in wrangler.toml and in the Discord developer portal, so
    // anyone reading either could drive unbounded MAL/Jikan traffic through
    // the Worker on the bot's own quota.
    if (req.method === 'GET' && url.pathname === '/diag/search') {
      const key = env.DIAG_KEY?.trim();
      if (!key) return new Response('not found', { status: 404 });
      if (!timingSafeEqual(url.searchParams.get('k') ?? '', key)) {
        return new Response('missing/bad k', { status: 403 });
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
