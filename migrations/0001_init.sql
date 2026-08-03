-- Anime Exchange Bot — D1 schema (spec §11, plus documented extensions marked "ext:").
-- Extensions exist to satisfy other spec sections without extra API calls:
--   events.count_panel_at/panel_dirty  — §5.3 "panel edit throttled to ≥60 s"
--   events.loop_status/validated_at    — §5.4 MATCHING panel loop status line
--   events.sheet_gid                   — numeric tab id for spreadsheets.batchUpdate (header notes)
--   signups.perm_id                    — Drive permission id saved at Launch so Close flips in 1 call (§7.6)
--   signups.dm_channel_id              — DM mirror channel cache (§10.2), halves mirror subrequests
--   signups.doc_missing                — §8.5 "404 on a doc → wrote = ❌ (missing)"
--   jobs.attempted_at + kind 'finish'  — fair job scheduling across guilds; Finish's thread
--                                        deletion scales with participants so it must be a
--                                        batched job too (§13.1: fan-out never in handlers)
--   reminders.user_id                  — §10.2 "sent_at marked atomically per participant"

CREATE TABLE guilds (
  guild_id TEXT PRIMARY KEY,
  manager_channel_id TEXT, participant_channel_id TEXT,
  manager_msg_id TEXT, participant_msg_id TEXT,
  manager_role_id TEXT,
  google_refresh_token_enc TEXT, google_email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL UNIQUE REFERENCES guilds(guild_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN
    ('DRAFTING','SIGNUP_OPEN','MATCHING','LAUNCHING','RUNNING','CLOSING','REVEALED')),
  topic TEXT, tz TEXT,
  signup_deadline INTEGER, auto_stop INTEGER NOT NULL DEFAULT 0,
  signup_banner_flipped INTEGER NOT NULL DEFAULT 0,
  review_deadline INTEGER, reminder_days TEXT NOT NULL DEFAULT '7,3,1',
  dm_mirror INTEGER NOT NULL DEFAULT 0,
  sheet_id TEXT, gallery_posted INTEGER NOT NULL DEFAULT 0,
  sheet_gid INTEGER,                                  -- ext
  loop_status TEXT NOT NULL DEFAULT 'none',           -- ext: 'none' | 'shuffled' | 'manual'
  validated_at INTEGER,                               -- ext
  count_panel_at INTEGER NOT NULL DEFAULT 0,          -- ext
  panel_dirty INTEGER NOT NULL DEFAULT 0,             -- ext
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE form_items (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('FIB','MCQ')),
  options_json TEXT,                       -- JSON array, MCQ only, 2..10
  visible_to_recommender INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX form_items_event ON form_items(event_id, position);

CREATE TABLE signups (
  signup_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, display_name TEXT NOT NULL,
  mal_id INTEGER NOT NULL, anime_title TEXT NOT NULL, anime_title_en TEXT,
  anime_year INTEGER, anime_type TEXT, anime_episodes INTEGER,
  anime_url TEXT NOT NULL, anime_image TEXT,
  answers_json TEXT NOT NULL DEFAULT '{}',  -- {item_id: answer}
  row_order INTEGER,                        -- 0..n-1, NULL until first adoption/shuffle
  thread_id TEXT, doc_id TEXT, doc_url TEXT,
  perm_id TEXT,                                   -- ext
  dm_channel_id TEXT,                             -- ext
  assignment_posted INTEGER NOT NULL DEFAULT 0,   -- launch-job unit marker
  doc_readonly INTEGER NOT NULL DEFAULT 0,        -- close-job unit marker (phase 1)
  reveal_posted INTEGER NOT NULL DEFAULT 0,       -- close-job unit marker (phase 2)
  synced_at INTEGER,                              -- sync-job unit marker
  template_chars INTEGER NOT NULL DEFAULT 0,
  doc_missing INTEGER NOT NULL DEFAULT 0,         -- ext
  wrote INTEGER NOT NULL DEFAULT 0, last_edited INTEGER, char_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (event_id, user_id)
);
CREATE INDEX signups_event ON signups(event_id, row_order);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('launch','close','sync','finish')),
  payload_json TEXT NOT NULL DEFAULT '{}',  -- e.g. {"gallery": true}
  created_at INTEGER NOT NULL, done_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  attempted_at INTEGER                            -- ext
);
CREATE UNIQUE INDEX jobs_active ON jobs(event_id, kind) WHERE done_at IS NULL;

CREATE TABLE signup_drafts (
  event_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  step TEXT NOT NULL,                       -- 'A_DONE' | 'PICKED' | 'B_DONE'
  keyword TEXT, partial_answers_json TEXT, candidates_json TEXT, chosen_json TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,                          -- ext (per-participant delivery marker)
  kind TEXT NOT NULL,                       -- 'review' | 'manual'
  due_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE INDEX reminders_due ON reminders(due_at) WHERE sent_at IS NULL;

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE mal_cache (
  qhash TEXT PRIMARY KEY, results_json TEXT NOT NULL, fetched_at INTEGER NOT NULL
);
