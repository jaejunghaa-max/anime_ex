import { describe, expect, it } from 'vitest';
import {
  buildLoops, chunkLines, dealSizes, epochToZoned, isValidTz, loopsPhrase, normalizeListUrl,
  sanitizeName, shuffled, timingSafeEqual, zonedToEpoch,
} from '../src/util';
import { dice, fromMalOfficial, normalizeQuery, rankCandidates, type AnimeCandidate } from '../src/mal';
import {
  a1, colLetter, declinesLeftCell, headerRow, layoutOf, MAX_ITEMS, MAX_PICKS, recoCell,
  recoStatusCell, SHEET_COLUMNS, sheetSlots, slotCol,
} from '../src/sheet';
import { activeRecos, declinedRecos, finalRecos, pendingRecos, picksLeft } from '../src/db';
import { animeCard, assignmentHeader, revealCard, statusPanel } from '../src/cards';
import { parseGroupCells } from '../src/validate';
import { modalFields } from '../src/types';
import type { EventRow, FormItem, RecoRow, SignupRow } from '../src/types';

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
  it('v3 direction: your Santa (next row) picks FOR you; you pick for the previous row', () => {
    const { santa, recipient } = buildLoops([1, 1, 1]);
    // Row 0's pick lands on recipient[0] = row 2; row 0's own anime comes from santa[0] = row 1.
    expect(recipient[0]).toBe(2);
    expect(santa[2]).toBe(0);      // …and row 2 agrees: their Santa is row 0
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
  it("quotes the tab title in A1 ranges (hyphen breaks Google's parser unquoted)", () => {
    expect(a1('A1:T21')).toBe("'Sign-Ups'!A1:T21");
  });
  it('header marks hidden items, places Group before the derived block (v3 layout)', () => {
    const h = headerRow(items);
    expect(h[0]).toBe('Row #');
    expect(h[1]).toContain('User ID');
    expect(h[3]).toBe('MAL/AniList');    // v3: one list-link column replaces Anime + MAL
    expect(h[4]).toBe('Genre');          // visible → no lock
    expect(h[5]).toBe('Why 🔒');         // hidden → lock suffix
    const layout = layoutOf(items);
    expect(h[layout.groupCol - 1]).toBe('Group');       // manager-editable (rev. 3)
    expect(h[layout.santaCol - 1]).toBe('Secret Santa');
    expect(h[layout.recoCol - 1]).toBe('Recommendation'); // single-pick events stay unnumbered
    expect(h[layout.recoCol]).toBe('Rec. Status');
    expect(h[layout.recoCol + 1]).toBe('Rating');
    expect(h[layout.linkCol - 1]).toBe('Review Link');
    expect(h[layout.lengthCol - 1]).toBe('Review Length');
    expect(h).not.toContain('Anime');
    expect(h).not.toContain('Given Anime');
    expect(layout.groupCol).toBe(7);     // A-D fixed + 2 items + Group
    expect(h).toHaveLength(layout.lastCol);
  });
  it('every slot carries its own review doc columns (v6)', () => {
    const h = headerRow(items, 3);
    const layout = layoutOf(items, 3);
    expect(h[layout.recoCol - 1]).toBe('Recommendation 1');
    expect(h[slotCol(layout, 2) - 1]).toBe('Recommendation 2');
    expect(h[slotCol(layout, 3) - 1]).toBe('Recommendation 3');
    expect(h[slotCol(layout, 3)]).toBe('Rec. Status 3');
    expect(h[slotCol(layout, 3) + 1]).toBe('Rating 3');
    expect(h[slotCol(layout, 3) + 2]).toBe('Review Link 3');
    expect(h[slotCol(layout, 3) + 3]).toBe('Review Length 3');
    expect(h).toHaveLength(layout.lastCol);
    // Each extra slot adds its own five columns.
    expect(layout.lastCol).toBe(layoutOf(items).lastCol + 10);
    expect(slotCol(layout, 1)).toBe(layout.recoCol);
  });
  it('reco cells mirror the approve/decline state machine', () => {
    expect(recoCell({ title: 'Frieren', year: 2023 })).toBe('Frieren (2023)');
    expect(recoCell({ title: 'Frieren', year: null })).toBe('Frieren');
    expect(recoCell({ title: null, year: null })).toBe('');
    expect(recoCell(undefined)).toBe('');
    // An empty slot stays empty — declines are the person's story, not a
    // slot's, and they live on 📊 View Status.
    expect(recoStatusCell(undefined)).toBe('');
    expect(recoStatusCell({ status: 'PENDING', final_via: null })).toBe('⏳ awaiting reply');
    expect(recoStatusCell({ status: 'FINAL', final_via: 'APPROVED' })).toBe('✅ accepted');
    expect(recoStatusCell({ status: 'FINAL', final_via: 'FORCED' })).toBe('⏩ locked at launch');
    expect(recoStatusCell({ status: 'DECLINED', final_via: null })).toBe('😞 declined');
  });
});

describe('per-participant pick maxima (v5)', () => {
  const reco = (over: Partial<RecoRow>): RecoRow => ({
    reco_id: 1, event_id: 1, signup_id: 1, slot: 1, mal_id: 1, title: 'X', title_en: null,
    year: 2020, type: 'TV', episodes: 12, url: null, image: null, status: 'PENDING',
    final_via: null, score: null, msg_id: null, doc_id: null, doc_url: null, perm_id: null,
    template_chars: 0, doc_missing: 0, doc_readonly: 0, wrote: 0, char_count: 0,
    last_edited: null, synced_at: null, created_at: 0, updated_at: 0, ...over,
  });
  it('declined picks are history — they free the slot back up', () => {
    const rows = [
      reco({ reco_id: 1, slot: 1, status: 'DECLINED' }),
      reco({ reco_id: 2, slot: 2, status: 'FINAL' }),
      reco({ reco_id: 3, slot: 3, status: 'PENDING' }),
    ];
    expect(activeRecos(rows).map((r) => r.reco_id)).toEqual([2, 3]);
    expect(finalRecos(rows).map((r) => r.reco_id)).toEqual([2]);
    expect(pendingRecos(rows).map((r) => r.reco_id)).toEqual([3]);
    expect(declinedRecos(rows).map((r) => r.reco_id)).toEqual([1]);
    // Two live picks against a maximum of three leaves room for one more.
    expect(picksLeft({ max_recos: 3 }, rows)).toBe(1);
    expect(picksLeft({ max_recos: 2 }, rows)).toBe(0);
    expect(picksLeft({ max_recos: 1 }, rows)).toBe(0);   // never negative
  });
  it('the sheet sizes its slot block to the greediest participant, capped at 3', () => {
    expect(sheetSlots([{ max_recos: 1 }, { max_recos: 3 }, { max_recos: 2 }])).toBe(3);
    expect(sheetSlots([{ max_recos: 9 }])).toBe(3);      // never past the cap
    expect(sheetSlots([])).toBe(1);
    expect(sheetSlots([{ max_recos: 0 }])).toBe(1);      // guards bad data
  });
});

describe('thread cards (v6: one embed, one review doc per anime)', () => {
  const reco = (over: Partial<RecoRow>): RecoRow => ({
    reco_id: 1, event_id: 1, signup_id: 1, slot: 1, mal_id: 1, title: 'X', title_en: null,
    year: 2020, type: 'TV', episodes: 12, url: null, image: null, status: 'FINAL',
    final_via: 'APPROVED', score: null, msg_id: null, doc_id: null, doc_url: null, perm_id: null,
    template_chars: 0, doc_missing: 0, doc_readonly: 0, wrote: 0, char_count: 0,
    last_edited: null, synced_at: null, created_at: 0, updated_at: 0, ...over,
  });
  const signup = (over: Partial<SignupRow>): SignupRow => ({
    signup_id: 1, event_id: 1, user_id: 'u1', display_name: 'A', username: 'a',
    list_url: 'https://myanimelist.net/profile/a', answers_json: '{}', row_order: 0, group_no: 1,
    declines_used: 0, reco_card_posted: 0, thread_id: null,
    mission_msg_id: null, dm_channel_id: null,
    assignment_posted: 0, reveal_posted: 0, synced_at: null,
    doc_missing: 0, wrote: 0, char_count: 0, max_recos: 3,
    created_at: 0, updated_at: 0, ...over,
  });
  const event = {
    event_id: 1, state: 'RECOMMENDING', topic: 'S', theme: null, max_declines: 2,
    reco_deadline: null, review_deadline: 1800000000,
  } as unknown as EventRow;

  const me = signup({ signup_id: 1, user_id: 'u1', display_name: 'A' });
  const giftee = signup({ signup_id: 2, user_id: 'u2', display_name: 'B', max_recos: 2 });

  type Panel = {
    embeds: Array<{ title?: string; description: string }>;
    components: Array<{ components: Array<{ custom_id?: string; label?: string }> }>;
  };

  it('is one panel with two numbered missions', () => {
    const panel = statusPanel(event, me, giftee, [], [], [
      reco({ reco_id: 9, signup_id: 1, title: 'Kaiba' }),
    ]) as Panel;
    expect(panel.embeds).toHaveLength(1);
    const d = panel.embeds[0]!.description;
    expect(panel.embeds[0]!.title).toBe('🎯 Your missions');
    expect(d).toContain('**1. Recommend anime to B**');
    expect(d).toContain('**2. Approve anime you want to review**');
    expect(d).toContain('Recommendations you got');
    // Exactly one blank line, and only where the two missions meet.
    expect(d).toContain('\n\n**2. Approve anime you want to review**');
    expect(d.split('\n\n')).toHaveLength(3);
    // No blank line between a section header and its first content line.
    expect(d).toMatch(/\*\*1\. Recommend anime to B\*\*\n[^\n]/);
    expect(d).toMatch(/\*\*2\. Approve anime you want to review\*\*\n🎁/);
  });

  it('bullets received picks with their status, declines included', () => {
    const panel = statusPanel(event, me, giftee, [], [], [
      reco({ reco_id: 9, signup_id: 1, title: 'Sousou no Frieren', status: 'DECLINED' }),
      reco({ reco_id: 10, signup_id: 1, slot: 2, title: 'Kaiba', status: 'PENDING' }),
      reco({ reco_id: 11, signup_id: 1, slot: 3, title: 'Dandadan' }),
    ]) as Panel;
    const d = panel.embeds[0]!.description;
    expect(d).toContain('• Sousou no Frieren (2020) — declined 😞');
    expect(d).toContain('• Kaiba (2020) — waiting for your reply ⏳');
    expect(d).toContain('• Dandadan (2020) — approved 😊');
    // The header counts approvals against the reader's own maximum…
    expect(d).toContain('🎁 **Recommendations you got** (1 approved / 3 at most)');
    // …and the budget closes the list rather than heading it.
    expect(d.trimEnd().endsWith('**2** Sorry😞s left')).toBe(true);
  });

  it('trims the giftee answers, never the reader own section, when over the cap', () => {
    const items: FormItem[] = Array.from({ length: 8 }, (_, i) => ({
      item_id: i + 1, event_id: 1, position: i + 1, label: `Q${i + 1}`,
      type: 'FIB', description: null, options_json: null, visible_to_recommender: 1,
    }));
    const answers = Object.fromEntries(items.map((it) => [String(it.item_id), 'x'.repeat(500)]));
    const chatty = signup({
      signup_id: 2, user_id: 'u2', display_name: 'B', max_recos: 2,
      answers_json: JSON.stringify(answers),
    });
    const panel = statusPanel(event, me, chatty, items, [], [
      reco({ reco_id: 9, signup_id: 1, title: 'Kaiba' }),
    ]) as Panel;
    const d = panel.embeds[0]!.description;
    expect(d.length).toBeLessThanOrEqual(4096);
    expect(d).toContain('**2. Approve anime you want to review**');
    expect(d).toContain('Kaiba');
    expect(d).toContain('Sorry😞s left');
  });

  it('carries no per-pick accept buttons — the pick card is where you answer', () => {
    const panel = statusPanel(event, me, giftee, [], [], [
      reco({ reco_id: 9, signup_id: 1, title: 'Kaiba', status: 'PENDING' }),
    ]) as Panel;
    const ids = panel.components.flatMap((r) => r.components.map((b) => b.custom_id));
    expect(ids.some((id) => id?.startsWith('ax:reco_ok:'))).toBe(false);
  });

  it('the assignment header bullets the picks the same way for 1 and for many', () => {
    const one = assignmentHeader(event, me, giftee, [], [
      reco({ reco_id: 5, signup_id: 2, title: 'Kaiba' }),
    ]) as { embeds: Array<{ title: string; description: string }> };
    const many = assignmentHeader(event, me, giftee, [], [
      reco({ reco_id: 5, signup_id: 2, title: 'Kaiba' }),
      reco({ reco_id: 6, signup_id: 2, slot: 2, title: 'Dandadan' }),
    ]) as { embeds: Array<{ title: string; description: string }> };
    expect(one.embeds[0]!.title).toBe('🎁 Your pick');
    expect(many.embeds[0]!.title).toBe('🎁 Your pick');
    expect(one.embeds[0]!.description).toContain('• **Kaiba (2020)**');
    expect(many.embeds[0]!.description).toContain('• **Kaiba (2020)**\n• **Dandadan (2020)**');
    expect(one.embeds[1]!.title).toBe('🎬 Your anime');
    // No buttons on the header — they live on each anime's own panel.
    expect((one as { components?: unknown }).components).toBeUndefined();
  });

  it('each anime panel carries its own Review + Rate buttons', () => {
    const card = animeCard(reco({
      reco_id: 7, signup_id: 1, title: 'Kaiba', doc_url: 'https://d/7',
    })) as {
      embeds: Array<{ title: string; url?: string }>;
      components: Array<{ components: Array<{ url?: string; custom_id?: string; label: string }> }>;
    };
    expect(card.embeds[0]!.title).toBe('Kaiba (2020)');
    expect(card.embeds[0]!.url).toBeUndefined();          // title stays unclickable
    const [review, rate] = card.components[0]!.components;
    expect(review!.url).toBe('https://d/7');
    expect(rate!.custom_id).toBe('ax:score:7');           // rates THIS anime only
    expect(rate!.label).toContain('Rate');
    // A doc that never got made just drops its button.
    const noDoc = animeCard(reco({ reco_id: 8, signup_id: 1, doc_url: null })) as {
      components: Array<{ components: Array<{ custom_id?: string }> }>;
    };
    expect(noDoc.components[0]!.components).toHaveLength(1);
    expect(noDoc.components[0]!.components[0]!.custom_id).toBe('ax:score:8');
  });

  it('the reveal bullets both sides and links each anime own review', () => {
    const theirs = [
      reco({ reco_id: 3, signup_id: 2, title: 'Kaiba', score: 8, doc_url: 'https://d/3' }),
      reco({ reco_id: 4, signup_id: 2, slot: 2, title: 'Dandadan', score: null, doc_url: null }),
    ];
    const mine = [reco({ reco_id: 9, signup_id: 1, title: 'Frieren' })];
    const card = revealCard(me, signup({ signup_id: 3, user_id: 'u3', display_name: 'C' }),
      giftee, mine, theirs) as { embeds: Array<{ description: string }> };
    const d = card.embeds[0]!.description;
    expect(d).toContain('**C** (<@u3>) was your Secret Santa.');
    expect(d).toContain('• **Frieren (2020)**');
    expect(d).toContain('appreciated your picks');
    expect(d).toContain('• B rated **Kaiba (2020)** ⭐ 8 ([review](https://d/3))');
    expect(d).toContain("• B didn't rate **Dandadan (2020)**");
  });
});

describe('MAL/AniList link validation (v3 built-in signup item)', () => {
  it('accepts profile and list URLs on both sites', () => {
    expect(normalizeListUrl('https://myanimelist.net/profile/Xinil')).toBe('https://myanimelist.net/profile/Xinil');
    expect(normalizeListUrl('https://myanimelist.net/animelist/Xinil')).toBe('https://myanimelist.net/animelist/Xinil');
    expect(normalizeListUrl('https://anilist.co/user/somebody/animelist')).toBe('https://anilist.co/user/somebody/animelist');
  });
  it('normalizes scheme-less and www-prefixed input to https', () => {
    expect(normalizeListUrl('myanimelist.net/profile/you')).toBe('https://myanimelist.net/profile/you');
    expect(normalizeListUrl('www.anilist.co/user/you')).toBe('https://www.anilist.co/user/you');
    expect(normalizeListUrl('http://myanimelist.net/profile/you')).toBe('https://myanimelist.net/profile/you');
    expect(normalizeListUrl('  https://anilist.co/user/you  ')).toBe('https://anilist.co/user/you');
  });
  it('rejects other hosts, bare domains and garbage', () => {
    expect(normalizeListUrl('https://example.com/profile/you')).toBeNull();
    expect(normalizeListUrl('https://myanimelist.net')).toBeNull();     // root path tells the Santa nothing
    expect(normalizeListUrl('https://myanimelist.net/')).toBeNull();
    expect(normalizeListUrl('https://evil.myanimelist.net.example.com/x')).toBeNull();
    expect(normalizeListUrl('not a url')).toBeNull();
    expect(normalizeListUrl('')).toBeNull();
    expect(normalizeListUrl('x'.repeat(400))).toBeNull();
  });
});

describe('small utils', () => {  it('sanitizeName strips control chars and caps length', () => {
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

describe('timingSafeEqual (shared-secret comparison)', () => {
  it('matches only on exact equality', () => {
    expect(timingSafeEqual('s3cret', 's3cret')).toBe(true);
    expect(timingSafeEqual('s3cret', 's3crev')).toBe(false);
    expect(timingSafeEqual('s3cret', 's3cre')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });
});

describe('the Sorry😞s-left column (the decline count has no other home)', () => {
  const items: FormItem[] = [{
    item_id: 1, event_id: 1, position: 1, label: 'Genre',
    type: 'FIB', description: null, options_json: null, visible_to_recommender: 1,
  }];

  it('sits after Secret Santa, so Validate reads the same Group column as before', () => {
    const layout = layoutOf(items, 2);
    // A Row#, B User ID, C Display name, D MAL/AniList, E Genre, F Group, G Santa …
    expect(layout.groupCol).toBe(6);
    expect(layout.santaCol).toBe(7);
    expect(layout.declinesCol).toBe(8);
    expect(layout.recoCol).toBe(9);
  });

  it('is headed and positioned to match the data row', () => {
    const header = headerRow(items, 1);
    expect(header[layoutOf(items, 1).declinesCol - 1]).toBe('Sorry😞s left');
  });

  it('reports the remaining budget and never goes negative', () => {
    expect(declinesLeftCell({ declines_used: 0 }, { max_declines: 2 })).toBe(2);
    expect(declinesLeftCell({ declines_used: 2 }, { max_declines: 2 })).toBe(0);
    expect(declinesLeftCell({ declines_used: 5 }, { max_declines: 2 })).toBe(0);
  });
});

describe('sheet grid width (Sheets rejects a range starting past the last column)', () => {
  const widest: FormItem[] = Array.from({ length: MAX_ITEMS }, (_, i) => ({
    item_id: i + 1, event_id: 1, position: i + 1, label: `Q${i + 1}`,
    type: 'FIB', description: null, options_json: null, visible_to_recommender: 1,
  }));

  it('covers the widest layout AND the sweep that reaches past it', () => {
    const layout = layoutOf(widest, MAX_PICKS);
    // The data block must fit…
    expect(layout.lastCol).toBeLessThanOrEqual(SHEET_COLUMNS);
    // …and so must the trailing-column sweep, which starts at lastCol + 1.
    // A range that merely overlaps the grid is clamped by Sheets; one that
    // starts beyond it is a hard 400, which used to break every sheet write.
    expect(layout.lastCol + 12).toBeLessThanOrEqual(SHEET_COLUMNS);
  });

  it('is wider than Google\'s 26-column default, which the layout overruns', () => {
    expect(layoutOf(widest, MAX_PICKS).lastCol).toBeGreaterThan(26);
    expect(SHEET_COLUMNS).toBeGreaterThan(26);
  });
});
