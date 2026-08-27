// Google OAuth web routes (spec §8.1): /google/oauth/start redirects to the
// consent screen; the callback validates the random state (10-min TTL),
// exchanges the code, seals the refresh token with AES-GCM, and shows a
// "return to Discord" page. Scope is drive.file only — minimal blast radius.

import type { Cfg, Env } from './types';
import { GOOGLE_SCOPE, invalidateTokenCache } from './google';
import { repaintPanels } from './panels';
import { encryptToken, now } from './util';

/** Values interpolated into the page below come from Google; escape anyway —
 *  the assumption that a source is trustworthy outlives the source. */
function esc(v: string): string {
  return v.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function page(title: string, body: string, ok: boolean): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;background:#1e1f22;color:#eee}
main{max-width:26rem;text-align:center;padding:2rem;border-radius:1rem;background:#2b2d31}
h1{font-size:1.3rem}.ok{color:#57f287}.bad{color:#ed4245}</style>
<main><h1 class="${ok ? 'ok' : 'bad'}">${title}</h1><p>${body}</p></main>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function oauthStart(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const row = await env.DB
    .prepare('SELECT state FROM oauth_states WHERE state = ?1 AND expires_at > ?2')
    .bind(state, now()).first();
  if (!row) return page('Link expired', 'Go back to Discord and press Connect Google again.', false);
  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  consent.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  consent.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
  consent.searchParams.set('response_type', 'code');
  consent.searchParams.set('scope', GOOGLE_SCOPE);
  consent.searchParams.set('access_type', 'offline');
  consent.searchParams.set('prompt', 'consent'); // guarantees a refresh_token
  consent.searchParams.set('state', state);
  return Response.redirect(consent.toString(), 302);
}

export async function oauthCallback(env: Env, cfg: Cfg, ec: ExecutionContext, url: URL): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const stateRow = await env.DB
    .prepare('SELECT * FROM oauth_states WHERE state = ?1 AND expires_at > ?2')
    .bind(state, now()).first<{ state: string; guild_id: string; user_id: string }>();
  if (!stateRow) return page('Link expired', 'Go back to Discord and press Connect Google again.', false);
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?1').bind(state).run();
  if (!code) return page('Consent cancelled', 'No code returned — try again from Discord.', false);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; error?: string;
  };
  if (!tokenRes.ok || !tok.refresh_token || !tok.access_token) {
    console.error('oauth exchange failed', tok.error);
    return page('Connection failed', 'Google did not return a refresh token — press Connect Google and try again.', false);
  }

  // drive.file-scoped identity: Drive "about" carries the account email.
  const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { user?: { emailAddress?: string } } | null;
  const email = about?.user?.emailAddress ?? 'connected account';

  const sealed = await encryptToken(env.TOKEN_ENC_KEY, tok.refresh_token);
  await env.DB.prepare(
    'UPDATE guilds SET google_refresh_token_enc = ?1, google_email = ?2 WHERE guild_id = ?3',
  ).bind(sealed, email, stateRow.guild_id).run();
  invalidateTokenCache(stateRow.guild_id);
  ec.waitUntil(repaintPanels(env, cfg, stateRow.guild_id).catch(() => {}));

  return page('✅ Google connected', `Connected as <b>${esc(email)}</b>. You can close this tab and return to Discord.`, true);
}
