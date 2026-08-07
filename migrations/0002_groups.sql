-- Rev. 3: multi-loop groups (spec §1, §5.4, §7.1). Participants are
-- partitioned into groups; each group is one independent circular loop laid
-- out as a contiguous block of rows after Validate. Everyone starts in
-- group 1, which reproduces the single-loop behavior exactly.
--
-- Note: events.loop_status (from 0001) is no longer read — the rev. 3
-- MATCHING panel shows the loops summary + last-validated time instead.

ALTER TABLE signups ADD COLUMN group_no INTEGER NOT NULL DEFAULT 1;
