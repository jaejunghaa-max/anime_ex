-- v3.4: two event basics.
--  * "Topic" splits into "Session" (the event's name — stays in events.topic)
--    and an optional "Theme" (what picks should aim for — new column), shown
--    on the participant panels, the sign-up announcement, and the mission /
--    pick cards during the recommendation phase.
--  * The recommendation phase gets its own deadline, entered in the Start
--    Recommending modal. Consistent with the rest of the bot, it never acts
--    on its own: it is displayed everywhere and a "deadline passed" banner
--    flips on both panels (reco_banner_flipped, checked by the 15-min cron);
--    nudging and launching stay manager actions.

ALTER TABLE events ADD COLUMN theme TEXT;
ALTER TABLE events ADD COLUMN reco_deadline INTEGER;
ALTER TABLE events ADD COLUMN reco_banner_flipped INTEGER NOT NULL DEFAULT 0;
