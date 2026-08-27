// MAL search (spec §9): keyword search re-ranked client-side across all title
// variants, 24 h D1 cache. Two sources, tried in order:
//
//   1. Official MAL API v2 (api.myanimelist.net, X-MAL-CLIENT-ID) — primary
//      when MAL_CLIENT_ID is set. Authenticated and meant for server-side
//      use, so it is not subject to the anti-bot wall below. Effectively
//      required on Workers.
//   2. Jikan v4 — the spec's unauthenticated source; api.jikan.moe sits
//      behind Cloudflare bot protection that routinely 403-challenges
//      Workers egress traffic (shared datacenter IPs), which no header can
//      talk around — hence source #1.
//
// The spec's optional AniList fallback (§9.4) was removed: graphql.anilist.co
// blocks Cloudflare Workers traffic the same way, so it never helped here.
//
// The scoring functions are pure and exported for unit tests.

import type { Cfg, Env } from './types';
import { sha256hex, now, sleep } from './util';

export interface AnimeCandidate {
  mal_id: number;
  title: string;          // canonical (Jikan "Default")
  title_en: string | null;
  title_jp: string | null;
  synonyms: string[];
  year: number | null;
  type: string | null;
  episodes: number | null;
  url: string;
  image: string | null;
  members: number;
  score: number;
}

const CACHE_TTL = 24 * 3600;
const SCORE_MIN = 25;

// api.jikan.moe sits behind Cloudflare bot protection: requests with no
// User-Agent (the Workers fetch default) get 403'd, which surfaced as a
// permanent "search unavailable". Always identify ourselves.
const USER_AGENT = 'AnimeExchangeBot/2.0 (Cloudflare Workers; +https://github.com/jaejunghaa-max/anime_ex)';

// ------------------------------------------------------------ normalization

export function normalizeQuery(q: string): { norm: string; cjk: boolean } {
  const nfkc = q.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const cjk = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(nfkc);
  return { norm: cjk ? nfkc : nfkc.toLowerCase(), cjk };
}

// ----------------------------------------------------------------- scoring

/** Dice similarity over character bigrams (token-set-ish, robust for short titles). */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = grams.get(g) ?? 0;
    if (c > 0) {
      hits++;
      grams.set(g, c - 1);
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

function matchScore(q: string, title: string): number {
  if (!title) return 0;
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.includes(q)) return 60;
  return dice(q, title) * 50;
}

/**
 * score(anime) = max over titles of match(q, title) + popularityTiebreak.
 * CJK queries compare NFKC raw against Japanese title + synonyms; Latin
 * queries compare lowercased against all variants (spec §9.1 step 4).
 */
export function rankCandidates(norm: string, cjk: boolean, cands: AnimeCandidate[]): AnimeCandidate[] {
  const scored = cands.map((c) => {
    const titles = cjk
      ? [c.title_jp ?? '', ...c.synonyms]
      : [c.title, c.title_en ?? '', c.title_jp ?? '', ...c.synonyms].map((t) => t.toLowerCase());
    const prepared = titles.map((t) => t.normalize('NFKC')).filter(Boolean);
    const best = prepared.reduce((acc, t) => Math.max(acc, matchScore(norm, t)), 0);
    const tiebreak = c.members > 0 ? Math.min(10, Math.log10(c.members)) : 0;
    return { ...c, score: best + tiebreak };
  });
  return scored
    .filter((c) => c.score >= SCORE_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ------------------------------------------------- official MAL API v2

interface MalNode {
  id: number;
  title?: string;
  alternative_titles?: { synonyms?: string[]; en?: string | null; ja?: string | null };
  main_picture?: { medium?: string; large?: string };
  media_type?: string | null;
  num_episodes?: number | null;
  start_date?: string | null;
  num_list_users?: number | null;
}

export function fromMalOfficial(node: MalNode): AnimeCandidate {
  const alt = node.alternative_titles ?? {};
  const type = node.media_type
    ? (node.media_type.length <= 3 ? node.media_type.toUpperCase()
        : node.media_type.charAt(0).toUpperCase() + node.media_type.slice(1))
    : null;
  return {
    mal_id: node.id,
    title: node.title ?? `MAL #${node.id}`,
    title_en: alt.en || null,
    title_jp: alt.ja || null,
    synonyms: [node.title, alt.en, alt.ja, ...(alt.synonyms ?? [])].filter((t): t is string => !!t),
    year: node.start_date ? parseInt(node.start_date.slice(0, 4), 10) || null : null,
    type,
    episodes: node.num_episodes || null, // MAL uses 0 for unknown
    url: `https://myanimelist.net/anime/${node.id}`,
    image: node.main_picture?.large ?? node.main_picture?.medium ?? null,
    members: node.num_list_users ?? 0,
    score: 0,
  };
}

async function malOfficialSearch(clientId: string, q: string, sfw: boolean): Promise<AnimeCandidate[]> {
  const fields = 'alternative_titles,media_type,num_episodes,start_date,num_list_users,main_picture';
  const url = `https://api.myanimelist.net/v2/anime?q=${encodeURIComponent(q)}&limit=20&fields=${fields}${sfw ? '' : '&nsfw=true'}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-MAL-CLIENT-ID': clientId, 'User-Agent': USER_AGENT },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 1) {
      await sleep(800);
      continue;
    }
    if (!res.ok) throw new Error(`MAL ${res.status}`); // 400 on too-short queries → fall through
    const data = (await res.json()) as { data?: Array<{ node: MalNode }> };
    return (data.data ?? []).map((e) => fromMalOfficial(e.node));
  }
}

// ------------------------------------------------------------------- Jikan

interface JikanAnime {
  mal_id: number;
  url: string;
  images?: { jpg?: { image_url?: string; large_image_url?: string } };
  title?: string;
  title_english?: string | null;
  title_japanese?: string | null;
  titles?: Array<{ type: string; title: string }>;
  type?: string | null;
  episodes?: number | null;
  year?: number | null;
  aired?: { prop?: { from?: { year?: number | null } } };
  members?: number | null;
}

function fromJikan(a: JikanAnime): AnimeCandidate {
  const synonyms = (a.titles ?? [])
    .filter((t) => t.type === 'Synonym' || t.type === 'Default' || t.type === 'English' || t.type === 'Japanese')
    .map((t) => t.title);
  return {
    mal_id: a.mal_id,
    title: a.title ?? synonyms[0] ?? `MAL #${a.mal_id}`,
    title_en: a.title_english ?? null,
    title_jp: a.title_japanese ?? null,
    synonyms,
    year: a.year ?? a.aired?.prop?.from?.year ?? null,
    type: a.type ?? null,
    episodes: a.episodes ?? null,
    url: a.url || `https://myanimelist.net/anime/${a.mal_id}`,
    image: a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url ?? null,
    members: a.members ?? 0,
    score: 0,
  };
}

async function jikanSearch(q: string, sfw: boolean): Promise<AnimeCandidate[]> {
  const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=20${sfw ? '&sfw=true' : ''}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    // 403 = bot-protection challenge, 429 = the per-IP limit (shared by all
    // Workers egress traffic) — both are worth one backed-off retry.
    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    const data = (await res.json()) as { data?: JikanAnime[] };
    return (data.data ?? []).map(fromJikan);
  }
}

// -------------------------------------------------------------------- entry

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Full pipeline (§9.1): normalize → cache → official MAL, then Jikan →
 * re-rank → top 10. Every source outcome is logged so `wrangler tail` shows
 * exactly which upstream failed with what status. Throws only when no source
 * yields anything (→ "Search is temporarily unavailable").
 */
export async function searchAnime(env: Env, cfg: Cfg, rawQuery: string): Promise<AnimeCandidate[]> {
  const { norm, cjk } = normalizeQuery(rawQuery);
  if (!norm) return [];
  const qhash = await sha256hex(`${cfg.sfwOnly ? 's' : 'n'}:${norm}`);

  const cached = await env.DB
    .prepare('SELECT results_json FROM mal_cache WHERE qhash = ?1 AND fetched_at > ?2')
    .bind(qhash, now() - CACHE_TTL).first<{ results_json: string }>();
  if (cached) return JSON.parse(cached.results_json) as AnimeCandidate[];

  const attempts: string[] = [];
  let primary: AnimeCandidate[] | null = null;

  if (cfg.malClientId) {
    try {
      primary = await malOfficialSearch(cfg.malClientId, norm, cfg.sfwOnly);
      attempts.push(`mal-official:ok(${primary.length})`);
    } catch (e) {
      attempts.push(`mal-official:${errMsg(e)}`);
    }
  }
  if (primary === null) {
    try {
      primary = await jikanSearch(norm, cfg.sfwOnly);
      attempts.push(`jikan:ok(${primary.length})`);
    } catch (e) {
      attempts.push(`jikan:${errMsg(e)}`);
    }
  }

  if (primary === null) {
    console.error(`anime search: every source failed for "${norm}" [${attempts.join(' | ')}]`);
    throw new Error(`all search sources failed: ${attempts.join(' | ')}`);
  }
  console.log(`anime search "${norm}": ${attempts.join(' | ')}`);

  const ranked = rankCandidates(norm, cjk, primary);
  // Never cache a miss. A source that answers 200 with nothing — reindexing, a
  // normalization edge case, an over-tight SCORE_MIN cut — used to be stored
  // exactly like a good answer, so one bad response made a title unsearchable
  // for every guild for 24 hours with no way to bust it.
  if (ranked.length > 0) {
    await env.DB
      .prepare('INSERT OR REPLACE INTO mal_cache (qhash, results_json, fetched_at) VALUES (?1, ?2, ?3)')
      .bind(qhash, JSON.stringify(ranked), now()).run();
  }
  return ranked;
}

/**
 * Ground-truth probe for the /diag/search route: hits every source
 * independently from the Worker's own network position and reports each
 * outcome, so "which upstream is blocking us" stops being guesswork.
 */
export async function diagnoseSearch(cfg: Cfg, rawQuery: string): Promise<Record<string, unknown>> {
  const { norm, cjk } = normalizeQuery(rawQuery || 'frieren');
  const probe = async (fn: () => Promise<AnimeCandidate[]>) => {
    const started = Date.now();
    try {
      const r = await fn();
      return { ok: true, results: r.length, top: r[0]?.title ?? null, ms: Date.now() - started };
    } catch (e) {
      return { ok: false, error: errMsg(e), ms: Date.now() - started };
    }
  };
  return {
    query: norm,
    cjk,
    config: { malClientId: !!cfg.malClientId, sfwOnly: cfg.sfwOnly },
    sources: {
      malOfficial: cfg.malClientId
        ? await probe(() => malOfficialSearch(cfg.malClientId!, norm, cfg.sfwOnly))
        : { ok: false, error: 'MAL_CLIENT_ID not configured' },
      jikan: await probe(() => jikanSearch(norm, cfg.sfwOnly)),
    },
  };
}
