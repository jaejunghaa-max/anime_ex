-- v3.1 UX pass:
--  * "Thank you!😊" is no longer an irreversible lock — an accepted pick can
--    still be declined (red "No. I'll decline it.😞") until Launch, while the
--    Sorry😞 budget lasts.
--  * Exhausting the budget no longer auto-locks the next pick; it simply
--    can't be declined and locks at Launch (reco_final_via 'EXHAUSTED' is
--    gone — normalized below).
--  * The Force-finalize button is gone: Launch itself locks any ⏳ pending
--    picks (with a "‼️The pending picks will be locked" warning first).
--  * signups.username stores the Discord handle for the review-doc header
--    line: "given to Display(@username) — deadline …".

ALTER TABLE signups ADD COLUMN username TEXT NOT NULL DEFAULT '';

-- Legacy EXHAUSTED locks: events still in the recommendation phase revert to
-- PENDING (the recipient regains the Thank-you choice; with no declines left
-- the pick still can't be sent back). Launched events read as locked-at-launch.
UPDATE signups SET reco_status = 'PENDING', reco_final_via = NULL
 WHERE reco_final_via = 'EXHAUSTED'
   AND event_id IN (SELECT event_id FROM events WHERE state IN ('PREPARING', 'RECOMMENDING'));

UPDATE signups SET reco_final_via = 'FORCED' WHERE reco_final_via = 'EXHAUSTED';
