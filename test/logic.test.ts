import { describe, expect, it } from 'vitest';
import {
  buildLoops, chunkLines, dealSizes, epochToZoned, isValidTz, loopsPhrase, parseReminderDays,
  sanitizeName, shuffled, zonedToEpoch,
} from '../src/util';
import { dice, fromMalOfficial, normalizeQuery, rankCandidates, type AnimeCandidate } from '../src/mal';
import { colLetter, headerRow, layoutOf } from '../src/sheet';
import { parseGroupCells } from '../src/validate';
import { modalFields } from '../src/types';
import type { FormItem } from '../src/types';

describe('timezone conversion (Intl-based, no offset tables)', () => {
  it('converts Seoul wall time (no DST)', () => {
    expect(zonedToEpoch('2026-09-01 21:00', 'Asia/Seoul')).toBe(Date.UTC(2026, 8, 1, 12, 0) / 1000);
  });
  it('handles US DST summer and winter', () => {
    expect(zonedToEpoch('2026-07-04 12:00', 'America/New_York')).toBe(Date.UTC(2026, 6, 4, 16, 0) / 1000);
    expect(zonedToEpoch('2026-01-15 12:00', 'America/New_York')).toBe(Date.UTC(2026, 0, 15, 17, 0) / 1000);
  });
  it('round-trips through epochToZoned', () => {
    const epoch = zonedToEpoch('2026-03-03 08:30', 'Asia/Tokyo')!;
    expect(epochToZoned(epoch, 'Asia/Tokyo')).toBe('2026-03-03 08:30');
  });
  it('rejects garbage', () => {
    expect(zonedToEpoch('2026-13-01 10:00', 'Asia/Seoul')).toBeNull();
    expect(zonedToEpoch('2026-02-30 10:00', 'Asia/Seoul')).toBeNull();
    expect(zonedToEpoch('tomorrow', 'Asia/Seoul')).toBeNull();
    expect(zonedToEpoch('2026-01-01 10:00', 'Mars/OlympusMons')).toBeNull();
    expect(isValidTz('Asia/Seoul')).toBe(true);
    expect(isValidTz('nope')).toBe(false);
  });
});

describe('loop math (santa = next row within the group)', () => {
  it('single loop matches the spec §1 consistency check (A B C D)', () => {
    const { santa, recipient } = buildLoops([1, 1, 1, 1]);
    expect(santa[0]).toBe(1);      // A watches B's anime
    expect(recipient[0]).toBe(3);  // A's recommendation went to D
    expect(santa[3]).toBe(0);      // wraps
  });
  it('two blocks never cross the boundary (§1: A B C | D E F)', () => {
    const { santa, recipient, groups } = buildLoops([1, 1, 1, 2, 2, 2]);
    expect(santa[0]).toBe(1);      // A → B
    expect(santa[2]).toBe(0);      // C wraps to A
    expect(santa[3]).toBe(4);      // D → E
    expect(santa[5]).toBe(3);      // F wraps to D
    expect(recipient[0]).toBe(2);  // A's recommendation went to C
    expect(recipient[3]).toBe(5);
    expect(groups.get(1)).toEqual([0, 1, 2]);
    expect(groups.get(2)).toEqual([3, 4, 5]);
  });
  it('a 2-member group is a mutual pair (§1)', () => {
    const { santa, recipient } = buildLoops([1, 1]);
    expect(santa[0]).toBe(1);
    expect(recipient[0]).toBe(1);  // same person both ways
    expect(santa[1]).toBe(0);
  });
  it('handles non-contiguous same-group rows in row order', () => {
    const { santa } = buildLoops([1, 2, 1, 2]);
    expect(santa[0]).toBe(2);      // group 1 = rows 0,2
    expect(santa[2]).toBe(0);
    expect(santa[1]).toBe(3);      // group 2 = rows 1,3
  });
  it('deals group sizes that never differ by more than 1 (§7.1)', () => {
    expect(dealSizes(20, 2)).toEqual([10, 10]);
    expect(dealSizes(7, 3)).toEqual([3, 2, 2]);
    expect(dealSizes(5, 2)).toEqual([3, 2]);
    expect(dealSizes(4, 1)).toEqual([4]);
    expect(dealSizes(9, 4)).toEqual([3, 2, 2, 2]);
  });
  it('loopsPhrase wording', () => {
    expect(loopsPhrase([4])).toBe('single loop');
    expect(loopsPhrase([])).toBe('single loop');
    expect(loopsPhrase([10, 10])).toBe('2 loops (10 + 10)');
  });
  it('shuffle is a permutation', () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const out = shuffled(input);
    expect(out).toHaveLength(50);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });
});

describe('Group column parsing (§5.4 step 2)', () => {
  const cells = (raws: string[]) => raws.map((raw, i) => ({ raw, sheetRow: i + 2 }));
  it('blank counts as 1; integers pass', () => {
    const p = parseGroupCells(cells(['', '1', '2', '2']));
    expect(p.ok).toBe(true);
    expect(p.normalized).toEqual([1, 1, 2, 2]);
    expect(p.renumbered).toBe(false);
  });
  it('rejects non-integers naming the exact rows (§14)', () => {
    const p = parseGroupCells(cells(['1', '2a', 'group 2', '0']));
    expect(p.ok).toBe(false);
    expect(p.errors).toHaveLength(3);
    expect(p.errors[0]).toContain('Row 3');
    expect(p.errors[1]).toContain('Row 4');
    expect(p.errors[2]).toContain('Row 5');
  });
  it('normalizes sparse labels to 1..G in order of first appearance', () => {
    const p = parseGroupCells(cells(['5', '5', '2', '2', '9']));
    expect(p.ok).toBe(true);
    expect(p.normalized).toEqual([1, 1, 2, 2, 3]);
    expect(p.renumbered).toBe(true);
  });
});

const cand = (over: Partial<AnimeCandidate>): AnimeCandidate => ({
  mal_id: 1, title: 'X', title_en: null, title_jp: null, synonyms: [], year: 2020,
  type: 'TV', episodes: 12, url: 'https://myanimelist.net/anime/1', image: null,
  members: 1000, score: 0, ...over,
});

describe('MAL re-ranking (§9.2: EN, romaji and native script land the same #1)', () => {
  const frieren = cand({
    mal_id: 52991,
    title: 'Sousou no Frieren',
    title_en: "Frieren: Beyond Journey's End",
    title_jp: '葬送のフリーレン',
    synonyms: ['Sousou no Frieren', "Frieren: Beyond Journey's End", '葬送のフリーレン', 'Frieren at the Funeral'],
    members: 1_200_000,
  });
  const decoy1 = cand({ mal_id: 2, title: 'Freezing', title_en: 'Freezing', members: 300_000, synonyms: ['Freezing'] });
  const decoy2 = cand({ mal_id: 3, title: 'Fruits Basket', title_en: 'Fruits Basket', members: 900_000, synonyms: ['Fruits Basket'] });
  const pool = [decoy1, frieren, decoy2];

  for (const q of ['frieren', 'Sousou no Frieren', '葬送のフリーレン']) {
    it(`ranks Frieren #1 for "${q}"`, () => {
      const { norm, cjk } = normalizeQuery(q);
      const ranked = rankCandidates(norm, cjk, pool);
      expect(ranked[0]?.mal_id).toBe(52991);
    });
  }
  it('drops results below the score threshold', () => {
    const { norm, cjk } = normalizeQuery('zzzzqqqq');
    expect(rankCandidates(norm, cjk, pool)).toHaveLength(0);
  });
  it('dice similarity behaves', () => {
    expect(dice('frieren', 'frieren')).toBe(1);
    expect(dice('ab', 'cd')).toBe(0);
    expect(dice('night', 'nacht')).toBeGreaterThan(0);
  });
  it('maps official MAL API nodes and ranks them the same', () => {
    const node = fromMalOfficial({
      id: 52991,
      title: 'Sousou no Frieren',
      alternative_titles: { en: "Frieren: Beyond Journey's End", ja: '葬送のフリーレン', synonyms: ['Frieren at the Funeral'] },
      main_picture: { medium: 'https://img/m.jpg', large: 'https://img/l.jpg' },
      media_type: 'tv',
      num_episodes: 28,
      start_date: '2023-09-29',
      num_list_users: 1_200_000,
    });
    expect(node.mal_id).toBe(52991);
    expect(node.title_jp).toBe('葬送のフリーレン');
    expect(node.year).toBe(2023);
    expect(node.type).toBe('TV');
    expect(node.image).toBe('https://img/l.jpg');
    expect(node.url).toBe('https://myanimelist.net/anime/52991');
    expect(node.synonyms).toContain("Frieren: Beyond Journey's End");
    const zeroEps = fromMalOfficial({ id: 1, num_episodes: 0, media_type: 'movie' });
    expect(zeroEps.episodes).toBeNull(); // MAL uses 0 for unknown
    expect(zeroEps.type).toBe('Movie');
    for (const q of ['frieren', '葬送のフリーレン']) {
      const { norm, cjk } = normalizeQuery(q);
      expect(rankCandidates(norm, cjk, [node])[0]?.mal_id).toBe(52991);
    }
  });
});

describe('sheet layout (§8.3)', () => {
  const items = [
    { item_id: 10, event_id: 1, position: 1, label: 'Genre', type: 'MCQ', options_json: '["a","b"]', visible_to_recommender: 1 },
    { item_id: 11, event_id: 1, position: 2, label: 'Why', type: 'FIB', options_json: null, visible_to_recommender: 0 },
  ] as FormItem[];
  it('column letters', () => {
    expect(colLetter(1)).toBe('A');
    expect(colLetter(26)).toBe('Z');
    expect(colLetter(27)).toBe('AA');
  });
  it('header marks hidden items, places Group before the derived block', () => {
    const h = headerRow(items);
    expect(h[0]).toBe('Row #');
    expect(h[1]).toContain('User ID');
    expect(h[5]).toBe('Genre');          // visible → no lock
    expect(h[6]).toBe('Why 🔒');         // hidden → lock suffix
    const layout = layoutOf(items);
    expect(h[layout.groupCol - 1]).toBe('Group');       // manager-editable (rev. 3)
    expect(h[layout.santaCol - 1]).toBe('Secret Santa');
    expect(h[layout.lengthCol - 1]).toBe('Review Length'); // renamed from Chars; Last Edited/Wrote dropped
    expect(h[layout.scoreCol - 1]).toBe('Score');
    expect(h).not.toContain('Wrote');
    expect(h).not.toContain('Last Edited');
    expect(layout.groupCol).toBe(8);     // A-E fixed + 2 items + Group
    expect(h).toHaveLength(layout.lastCol);
  });
});

describe('small utils', () => {
  it('parseReminderDays', () => {
    expect(parseReminderDays('7,3,1')).toEqual([7, 3, 1]);
    expect(parseReminderDays('1, 3,3')).toEqual([3, 1]);
    expect(parseReminderDays('')).toEqual([]);
    expect(parseReminderDays('0')).toBeNull();
    expect(parseReminderDays('x')).toBeNull();
    expect(parseReminderDays('90')).toBeNull();
  });
  it('sanitizeName strips control chars and caps length', () => {
    expect(sanitizeName('a bc')).toBe('abc');
    expect(sanitizeName('  spaced   out  ')).toBe('spaced out');
    expect(sanitizeName('x'.repeat(100))).toHaveLength(60);
    expect(sanitizeName(' ')).toBe('participant');
  });
  it('chunkLines respects both caps', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
    const chunks = chunkLines(lines, 10_000, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.split('\n')).toHaveLength(10);
    const byChars = chunkLines(['aaaa', 'bbbb', 'cccc'], 9, 10);
    expect(byChars).toHaveLength(2);
  });
  it('modalFields flattens Labels and legacy Action Rows', () => {
    const fields = modalFields([
      { type: 18, component: { type: 4, custom_id: 'kw', value: 'frieren' } },
      { type: 18, component: { type: 3, custom_id: 'item:1', values: ['2'] } },
      { type: 1, components: [{ type: 4, custom_id: 'legacy', value: 'x' }] },
    ]);
    expect(fields.get('kw')).toBe('frieren');
    expect(fields.get('item:1')).toBe('2');
    expect(fields.get('legacy')).toBe('x');
  });
});
