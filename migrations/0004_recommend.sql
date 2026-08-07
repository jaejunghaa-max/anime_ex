-- v3: the recommendation-flow rework. The exchange no longer collects an anime
-- pick at signup; instead the signup form's built-in item is a link to the
-- participant's MAL/AniList list, and after MATCHING a new phase runs:
--
--   MATCHING → PREPARING (threads + "you're the Santa of X" task cards, batched)
--            → RECOMMENDING (each Santa picks an anime for their giftee via the
--              MAL wizard; the giftee answers "Thank you!😊" (locks it in) or
--              "Sorry😞" (sends it back — at most events.max_declines times,
--              set by the manager at drafting; once used up, the next pick
--              locks automatically) → LAUNCHING (unchanged from here on).
--
-- Schema consequences:
--   events   — two new states in the CHECK + max_declines (declines per person)
--   signups  — anime-pick columns replaced by list_url + a reco_* block that
--              stores the anime recommended TO this row by their Santa
--   jobs     — new 'prepare' kind in the CHECK
--
-- SQLite cannot ALTER a CHECK constraint, so events/signups/jobs are rebuilt.
-- DROP TABLE on a parent runs an implicit DELETE FROM, which fires the
-- children's ON DELETE CASCADE — so every child of events is backed up first
-- and restored after the swap. The DELETE+INSERT restore is idempotent, so the
-- migration is correct whether or not the runtime cascades on DROP.
--
-- Upgrading with an event in flight: rows survive, but v2 signup-time anime
-- picks are dropped (the v3 flow has no such pick) — finish or 🛑 Abort any
-- in-flight event before upgrading.

PRAGMA defer_foreign_keys = on;

-- ---------------------------------------------------------------- events

CREATE TABLE events_v3 (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL UNIQUE REFERENCES guilds(guild_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN
    ('DRAFTING','SIGNUP_OPEN','MATCHING','PREPARING','RECOMMENDING',
     'LAUNCHING','RUNNING','CLOSING','REVEALED')),
  topic TEXT, tz TEXT,
  signup_deadline INTEGER, auto_stop INTEGER NOT NULL DEFAULT 0,
  signup_banner_flipped INTEGER NOT NULL DEFAULT 0,
  review_deadline INTEGER, reminder_days TEXT NOT NULL DEFAULT '7,3,1',
  dm_mirror INTEGER NOT NULL DEFAULT 0,
  max_declines INTEGER NOT NULL DEFAULT 1,            -- v3: Sorry😞 budget per person (0–9)
  sheet_id TEXT, gallery_posted INTEGER NOT NULL DEFAULT 0,
  sheet_gid INTEGER,
  loop_status TEXT NOT NULL DEFAULT 'none',           -- unused since rev. 3 (kept)
  validated_at INTEGER,
  count_panel_at INTEGER NOT NULL DEFAULT 0,
  panel_dirty INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

INSERT INTO events_v3 (event_id, guild_id, state, topic, tz, signup_deadline, auto_stop,
    signup_banner_flipped, review_deadline, reminder_days, dm_mirror, sheet_id,
    gallery_posted, sheet_gid, loop_status, validated_at, count_panel_at, panel_dirty,
    created_at, updated_at)
  SELECT event_id, guild_id, state, topic, tz, signup_deadline, auto_stop,
    signup_banner_flipped, review_deadline, reminder_days, dm_mirror, sheet_id,
    gallery_posted, sheet_gid, loop_status, validated_at, count_panel_at, panel_dirty,
    created_at, updated_at
  FROM events;

-- Secure every child of events before the DROP (see header).
CREATE TABLE form_items_bak AS SELECT * FROM form_items;
CREATE TABLE signups_bak    AS SELECT * FROM signups;
CREATE TABLE jobs_bak       AS SELECT * FROM jobs;
CREATE TABLE reminders_bak  AS SELECT * FROM reminders;

DROP TABLE events;
ALTER TABLE events_v3 RENAME TO events;

-- Children kept as-is: restore rows (idempotent under either DROP semantics).
DELETE FROM form_items;
INSERT INTO form_items SELECT * FROM form_items_bak;
DROP TABLE form_items_bak;

DELETE FROM reminders;
INSERT INTO reminders SELECT * FROM reminders_bak;
DROP TABLE reminders_bak;

-- ---------------------------------------------------------------- signups

CREATE TABLE signups_v3 (
  signup_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, display_name TEXT NOT NULL,
  list_url TEXT NOT NULL DEFAULT '',        -- v3 built-in form item: MAL/AniList link
  answers_json TEXT NOT NULL DEFAULT '{}',  -- {item_id: answer}
  row_order INTEGER,                        -- 0..n-1, NULL until first adoption/shuffle
  group_no INTEGER NOT NULL DEFAULT 1,
  -- v3 recommendation block: the anime recommended TO this row by their Santa
  -- (the previous row in the loop is whom *this* row recommends for).
  reco_mal_id INTEGER, reco_title TEXT, reco_title_en TEXT,
  reco_year INTEGER, reco_type TEXT, reco_episodes INTEGER,
  reco_url TEXT, reco_image TEXT,
  reco_status TEXT NOT NULL DEFAULT 'NONE'  -- NONE = waiting on the Santa (initial + after a decline)
    CHECK (reco_status IN ('NONE','PENDING','FINAL')),
  reco_final_via TEXT,                      -- 'APPROVED' | 'EXHAUSTED' | 'FORCED' (set iff FINAL)
  declines_used INTEGER NOT NULL DEFAULT 0,
  reco_declined_json TEXT NOT NULL DEFAULT '[]',  -- [{mal_id, title}] — Santa may not re-pick these
  reco_card_posted INTEGER NOT NULL DEFAULT 0,    -- prepare-job unit marker (thread + task card)
  thread_id TEXT, doc_id TEXT, doc_url TEXT,
  perm_id TEXT,
  dm_channel_id TEXT,
  assignment_posted INTEGER NOT NULL DEFAULT 0,   -- launch-job unit marker
  doc_readonly INTEGER NOT NULL DEFAULT 0,        -- close-job unit marker (phase 1)
  reveal_posted INTEGER NOT NULL DEFAULT 0,       -- close-job unit marker (phase 2)
  synced_at INTEGER,                              -- sync-job unit marker
  template_chars INTEGER NOT NULL DEFAULT 0,
  doc_missing INTEGER NOT NULL DEFAULT 0,
  wrote INTEGER NOT NULL DEFAULT 0, last_edited INTEGER, char_count INTEGER NOT NULL DEFAULT 0,
  score INTEGER,                                  -- participant's /10 rating of their given anime
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (event_id, user_id)
);

INSERT INTO signups_v3 (signup_id, event_id, user_id, display_name, answers_json,
    row_order, group_no, thread_id, doc_id, doc_url, perm_id, dm_channel_id,
    assignment_posted, doc_readonly, reveal_posted, synced_at, template_chars,
    doc_missing, wrote, last_edited, char_count, score, created_at, updated_at)
  SELECT signup_id, event_id, user_id, display_name, answers_json,
    row_order, group_no, thread_id, doc_id, doc_url, perm_id, dm_channel_id,
    assignment_posted, doc_readonly, reveal_posted, synced_at, template_chars,
    doc_missing, wrote, last_edited, char_count, score, created_at, updated_at
  FROM signups_bak;

DROP TABLE signups;
ALTER TABLE signups_v3 RENAME TO signups;
DROP TABLE signups_bak;
CREATE INDEX signups_event ON signups(event_id, row_order);

-- ------------------------------------------------------------------- jobs

CREATE TABLE jobs_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prepare','launch','close','sync','finish')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, done_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  attempted_at INTEGER
);

INSERT INTO jobs_v3 (id, event_id, kind, payload_json, created_at, done_at,
    attempts, last_error, attempted_at)
  SELECT id, event_id, kind, payload_json, created_at, done_at,
    attempts, last_error, attempted_at
  FROM jobs_bak;

DROP TABLE jobs;
ALTER TABLE jobs_v3 RENAME TO jobs;
DROP TABLE jobs_bak;
CREATE UNIQUE INDEX jobs_active ON jobs(event_id, kind) WHERE done_at IS NULL;
