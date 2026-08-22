-- v5: the recommendation count belongs to the PARTICIPANT, not the event, and
-- it is a maximum rather than a quota.
--
--  * Each participant chooses at sign-up how many anime they're willing to
--    receive (1–5, `signups.max_recos`; the manager's Set Basics value is now
--    just the default offered in the wizard). Their Secret Santa may send up
--    to that many — never more, but fewer is fine.
--  * Recommendation rows are therefore created when a pick is SENT, not
--    pre-allocated: `recos.status` becomes PENDING → FINAL (accepted) or
--    DECLINED (sent back, kept as history so the Santa can see what missed and
--    can't re-pick it). Empty NONE placeholders are gone.
--  * Each participant's thread carries ONE consolidated status panel (their
--    mission + the anime they've accepted + their controls), edited in place —
--    `signups.mission_msg_id`. Individual pick cards are tracked by
--    `recos.msg_id` so they can be updated or removed as the state changes.
--  * `events.announce_msg_id` remembers the @everyone sign-up announcement so
--    Abort can clean it up; `link_label`/`link_desc` make the built-in
--    MAL/AniList form item editable like any other item.

PRAGMA defer_foreign_keys = on;

ALTER TABLE events ADD COLUMN announce_msg_id TEXT;
ALTER TABLE events ADD COLUMN link_label TEXT;
ALTER TABLE events ADD COLUMN link_desc TEXT;

ALTER TABLE signups ADD COLUMN max_recos INTEGER NOT NULL DEFAULT 1;
ALTER TABLE signups ADD COLUMN mission_msg_id TEXT;

-- Carry the event-wide setting into every existing participant.
UPDATE signups SET max_recos = (
  SELECT MAX(1, MIN(5, e.max_recos)) FROM events e WHERE e.event_id = signups.event_id
);

CREATE TABLE recos_v5 (
  reco_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  signup_id INTEGER NOT NULL,               -- the GIFTEE this pick is for
  slot INTEGER NOT NULL,                    -- send order (declined rows keep theirs)
  mal_id INTEGER, title TEXT, title_en TEXT,
  year INTEGER, type TEXT, episodes INTEGER,
  url TEXT, image TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','FINAL','DECLINED')),
  final_via TEXT,                           -- 'APPROVED' | 'FORCED' (set iff FINAL)
  score INTEGER,                            -- the giftee's /10 for this anime
  msg_id TEXT,                              -- the pick card in the giftee's thread
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (signup_id, slot)
);

-- NONE rows were empty placeholders; only real picks carry over.
INSERT INTO recos_v5 (reco_id, event_id, signup_id, slot, mal_id, title, title_en, year,
    type, episodes, url, image, status, final_via, score, created_at, updated_at)
  SELECT reco_id, event_id, signup_id, slot, mal_id, title, title_en, year,
    type, episodes, url, image, status, final_via, score, created_at, updated_at
  FROM recos WHERE status IN ('PENDING', 'FINAL');

DROP TABLE recos;
ALTER TABLE recos_v5 RENAME TO recos;
CREATE INDEX recos_event ON recos(event_id, signup_id, slot);
