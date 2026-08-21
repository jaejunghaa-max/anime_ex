-- v4.0: multiple recommendations per participant.
--
-- A Secret Santa now recommends up to events.max_recos (1–5, set in Set
-- Basics) anime for their giftee. Each recommendation is its own row in the
-- new `recos` table, keyed (signup_id, slot) — the giftee accepts or declines
-- each one individually, each gets its own sheet columns
-- ("Recommendation 1 / Rec. Status 1 / Score 1", …), and the participant's
-- single review doc gets one section per anime.
--
-- The per-recommendation block therefore moves OFF `signups` (which keeps the
-- per-person state: thread, doc, decline budget, declined titles) and the
-- ⭐ score becomes per-anime. max_recos = 1 reproduces the v3 behaviour
-- exactly, so existing events keep working: their current recommendation
-- becomes slot 1.
--
-- SQLite can't drop columns with a CHECK-bearing rebuild in place, so
-- `signups` is rebuilt. Nothing has a foreign key TO signups (recos keys off
-- event_id), so no cascade dance is needed here — just copy, drop, rename.

PRAGMA defer_foreign_keys = on;

ALTER TABLE events ADD COLUMN max_recos INTEGER NOT NULL DEFAULT 1;

CREATE TABLE recos (
  reco_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  signup_id INTEGER NOT NULL,               -- the GIFTEE this pick is for
  slot INTEGER NOT NULL,                    -- 1..events.max_recos
  mal_id INTEGER, title TEXT, title_en TEXT,
  year INTEGER, type TEXT, episodes INTEGER,
  url TEXT, image TEXT,
  status TEXT NOT NULL DEFAULT 'NONE'       -- NONE = the Santa still owes this slot
    CHECK (status IN ('NONE','PENDING','FINAL')),
  final_via TEXT,                           -- 'APPROVED' | 'FORCED' (set iff FINAL)
  score INTEGER,                            -- the giftee's /10 for this anime
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (signup_id, slot)
);
CREATE INDEX recos_event ON recos(event_id, signup_id, slot);

-- Carry any in-flight recommendation into slot 1. Events that haven't reached
-- the recommendation phase get their rows from the prepare job instead.
INSERT INTO recos (event_id, signup_id, slot, mal_id, title, title_en, year, type,
    episodes, url, image, status, final_via, score, created_at, updated_at)
  SELECT s.event_id, s.signup_id, 1, s.reco_mal_id, s.reco_title, s.reco_title_en,
    s.reco_year, s.reco_type, s.reco_episodes, s.reco_url, s.reco_image,
    s.reco_status, s.reco_final_via, s.score, s.created_at, s.updated_at
  FROM signups s
  JOIN events e ON e.event_id = s.event_id
  WHERE e.state IN ('PREPARING','RECOMMENDING','LAUNCHING','RUNNING','CLOSING','REVEALED');

CREATE TABLE signups_v4 (
  signup_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, display_name TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  list_url TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '{}',
  row_order INTEGER,
  group_no INTEGER NOT NULL DEFAULT 1,
  declines_used INTEGER NOT NULL DEFAULT 0,       -- Sorry😞 budget, per person
  reco_declined_json TEXT NOT NULL DEFAULT '[]',  -- [{mal_id, title}] — never re-picked
  reco_card_posted INTEGER NOT NULL DEFAULT 0,    -- prepare-job unit marker
  thread_id TEXT, doc_id TEXT, doc_url TEXT,
  perm_id TEXT,
  dm_channel_id TEXT,
  assignment_posted INTEGER NOT NULL DEFAULT 0,
  doc_readonly INTEGER NOT NULL DEFAULT 0,
  reveal_posted INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER,
  template_chars INTEGER NOT NULL DEFAULT 0,
  doc_missing INTEGER NOT NULL DEFAULT 0,
  wrote INTEGER NOT NULL DEFAULT 0, last_edited INTEGER, char_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (event_id, user_id)
);

INSERT INTO signups_v4 (signup_id, event_id, user_id, display_name, username, list_url,
    answers_json, row_order, group_no, declines_used, reco_declined_json, reco_card_posted,
    thread_id, doc_id, doc_url, perm_id, dm_channel_id, assignment_posted, doc_readonly,
    reveal_posted, synced_at, template_chars, doc_missing, wrote, last_edited, char_count,
    created_at, updated_at)
  SELECT signup_id, event_id, user_id, display_name, username, list_url,
    answers_json, row_order, group_no, declines_used, reco_declined_json, reco_card_posted,
    thread_id, doc_id, doc_url, perm_id, dm_channel_id, assignment_posted, doc_readonly,
    reveal_posted, synced_at, template_chars, doc_missing, wrote, last_edited, char_count,
    created_at, updated_at
  FROM signups;

DROP TABLE signups;
ALTER TABLE signups_v4 RENAME TO signups;
CREATE INDEX signups_event ON signups(event_id, row_order);
