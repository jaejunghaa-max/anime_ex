// MAL search (spec §9): Jikan v4 keyword search, client-side re-rank across
// all title variants, 24 h D1 cache, optional AniList native-script fallback.
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
    const prepared = titles.map((t) => (cjk ? t.normalize('NFKC') : t.normalize('NFKC'))).filter(Boolean);
    const best = prepared.reduce((acc, t) => Math.max(acc, matchScore(norm, t)), 0);
    const tiebreak = c.members > 0 ? Math.min(10, Math.log10(c.members)) : 0;
    return { ...c, score: best + tiebreak };
  });
  return scored
    .filter((c) => c.score >= SCORE_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
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
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if ((res.status === 429 || res.status >= 500) && attempt < 1) {
      await sleep(900); // one retry with backoff (§9.1)
      continue;
    }
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    const data = (await res.json()) as { data?: JikanAnime[] };
    return (data.data ?? []).map(fromJikan);
  }
}

// ---------------------------------------------------------- AniList fallback

const ANILIST_QUERY = `query ($q: String) {
  Page(perPage: 10) {
    media(search: $q, type: ANIME) {
      idMal format episodes siteUrl
      startDate { year }
      coverImage { large }
      title { romaji english native }
    }
  }
}`;

async function anilistSearch(q: string): Promise<AnimeCandidate[]> {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { q } }),
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as {
    data?: { Page?: { media?: Array<{
      idMal?: number | null; format?: string | null; episodes?: number | null;
      startDate?: { year?: number | null };
      coverImage?: { large?: string | null };
      title?: { romaji?: string | null; english?: string | null; native?: string | null };
    }> } };
  } | null;
  const media = data?.data?.Page?.media ?? [];
  // Only entries that resolve to a MAL id keep the "MAL DB" requirement (§9.4).
  return media
    .filter((m) => typeof m.idMal === 'number' && m.idMal! > 0)
    .map((m) => ({
      mal_id: m.idMal!,
      title: m.title?.romaji ?? m.title?.english ?? m.title?.native ?? `MAL #${m.idMal}`,
      title_en: m.title?.english ?? null,
      title_jp: m.title?.native ?? null,
      synonyms: [m.title?.romaji, m.title?.english, m.title?.native].filter((t): t is string => !!t),
      year: m.startDate?.year ?? null,
      type: m.format ?? null,
      episodes: m.episodes ?? null,
      url: `https://myanimelist.net/anime/${m.idMal}`,
      image: m.coverImage?.large ?? null,
      members: 0,
      score: 0,
    }));
}

// -------------------------------------------------------------------- entry

/** Full pipeline (§9.1): normalize → cache → Jikan → re-rank → (AniList merge) → top 10. */
export async function searchAnime(env: Env, cfg: Cfg, rawQuery: string): Promise<AnimeCandidate[]> {
  const { norm, cjk } = normalizeQuery(rawQuery);
  if (!norm) return [];
  const qhash = await sha256hex(`${cfg.sfwOnly ? 's' : 'n'}:${norm}`);

  const cached = await env.DB
    .prepare('SELECT results_json FROM mal_cache WHERE qhash = ?1 AND fetched_at > ?2')
    .bind(qhash, now() - CACHE_TTL).first<{ results_json: string }>();
  if (cached) return JSON.parse(cached.results_json) as AnimeCandidate[];

  let ranked = rankCandidates(norm, cjk, await jikanSearch(norm, cfg.sfwOnly));

  if (cfg.anilistFallback && cjk && ranked.length < 3) {
    const extra = await anilistSearch(norm).catch(() => []);
    if (extra.length) {
      const seen = new Set(ranked.map((c) => c.mal_id));
      const merged = [...ranked, ...rankCandidates(norm, cjk, extra).filter((c) => !seen.has(c.mal_id))];
      ranked = merged.sort((a, b) => b.score - a.score).slice(0, 10);
    }
  }

  await env.DB
    .prepare('INSERT OR REPLACE INTO mal_cache (qhash, results_json, fetched_at) VALUES (?1, ?2, ?3)')
    .bind(qhash, JSON.stringify(ranked), now()).run();
  return ranked;
}
