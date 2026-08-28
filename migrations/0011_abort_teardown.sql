-- v7.1: Abort tears everything down, including what it put outside the bot.
--
-- Two things survived an abort that should not have:
--
--   * the reveal gallery — a handful of messages in the participant channel,
--     posted by the close job. Abort already removed its own sign-up
--     announcement (events.announce_msg_id) but had no record of the gallery,
--     so aborting after the reveal left the whole loop published in a channel
--     whose event no longer exists. `gallery_msg_ids` stores their ids as a
--     JSON array so the teardown can delete them.
--
--   * the Google sheet and the per-anime review docs. These stay on 🧹 Finish
--     (the event ended normally; the artifacts are the point). On Abort they
--     are now deleted, which the confirmation says explicitly. The finish job
--     carries {"files": true} in its payload to tell the two apart — no schema
--     change needed for that part.

ALTER TABLE events ADD COLUMN gallery_msg_ids TEXT NOT NULL DEFAULT '[]';
