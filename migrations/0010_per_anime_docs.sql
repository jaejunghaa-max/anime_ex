-- v6: one review doc per ANIME, not per participant.
--
-- Someone who accepted three recommendations now gets three review docs —
-- each with its own link, its own "started writing" state and its own Review
-- Length — so the doc columns move onto `recos`. The participant-level
-- rollups on `signups` (wrote, char_count) stay as the panel/reminder cache,
-- and the old per-person doc columns are kept but no longer written: an
-- in-flight event's doc becomes the doc of its first live recommendation.

ALTER TABLE recos ADD COLUMN doc_id TEXT;
ALTER TABLE recos ADD COLUMN doc_url TEXT;
ALTER TABLE recos ADD COLUMN perm_id TEXT;
ALTER TABLE recos ADD COLUMN template_chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recos ADD COLUMN doc_missing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recos ADD COLUMN doc_readonly INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recos ADD COLUMN wrote INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recos ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recos ADD COLUMN last_edited INTEGER;
ALTER TABLE recos ADD COLUMN synced_at INTEGER;

-- Hand each launched participant's existing doc to their first live pick.
UPDATE recos SET
  doc_id = (SELECT s.doc_id FROM signups s WHERE s.signup_id = recos.signup_id),
  doc_url = (SELECT s.doc_url FROM signups s WHERE s.signup_id = recos.signup_id),
  perm_id = (SELECT s.perm_id FROM signups s WHERE s.signup_id = recos.signup_id),
  template_chars = (SELECT s.template_chars FROM signups s WHERE s.signup_id = recos.signup_id),
  doc_missing = (SELECT s.doc_missing FROM signups s WHERE s.signup_id = recos.signup_id),
  doc_readonly = (SELECT s.doc_readonly FROM signups s WHERE s.signup_id = recos.signup_id),
  wrote = (SELECT s.wrote FROM signups s WHERE s.signup_id = recos.signup_id),
  char_count = (SELECT s.char_count FROM signups s WHERE s.signup_id = recos.signup_id),
  last_edited = (SELECT s.last_edited FROM signups s WHERE s.signup_id = recos.signup_id),
  synced_at = (SELECT s.synced_at FROM signups s WHERE s.signup_id = recos.signup_id)
WHERE status != 'DECLINED'
  AND EXISTS (SELECT 1 FROM signups s WHERE s.signup_id = recos.signup_id AND s.doc_id IS NOT NULL)
  AND reco_id = (
    SELECT MIN(r2.reco_id) FROM recos r2
    WHERE r2.signup_id = recos.signup_id AND r2.status != 'DECLINED'
  );

-- The pick maximum is now purely the recipient's call, capped at 3.
UPDATE signups SET max_recos = 3 WHERE max_recos > 3;
UPDATE events SET max_recos = 3 WHERE max_recos > 3;
