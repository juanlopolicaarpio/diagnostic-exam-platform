-- ============================================================================
-- Section clock: track time actually spent, not wall-clock since started_at
-- ============================================================================
-- The section countdown was computed as time_limit_seconds - (now - started_at).
-- That counts every minute between started_at and now, including minutes the
-- student was not in the exam at all — a dropped connection, a closed laptop,
-- a crashed tab. pause-section existed to compensate, but it is best-effort
-- from the browser: if the client never got to call it, the clock kept
-- burning. Students returned to a timer that had silently run down, and
-- submit-answer then rejected every save as "time expired", so their answers
-- were lost without anyone being told.
--
-- Two new columns turn the wall clock into an activity clock:
--
--   elapsed_seconds   accumulated time genuinely spent in the section across
--                     all sittings. Survives pauses and crashes.
--
--   last_activity_at  the last time we saw the student. If the gap between
--                     this and now is large, they were away, and that gap is
--                     credited back instead of being charged to their budget.
--
-- time_limit_seconds goes back to meaning the immutable budget. pause-section
-- used to overwrite it with the remaining time, which destroyed the original
-- value and made the drift impossible to audit after the fact.
-- ============================================================================

ALTER TABLE session_sections
  ADD COLUMN IF NOT EXISTS elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

COMMENT ON COLUMN session_sections.elapsed_seconds IS
  'Accumulated seconds the student has actually spent in this section, across all sittings. Time while disconnected is not counted.';

COMMENT ON COLUMN session_sections.last_activity_at IS
  'Last observed student activity (answer saved, section opened, heartbeat). Used to detect that a student was away so the clock can be re-anchored instead of charging them for the gap.';

-- Seed liveness for sections that are already running.
--
-- The signal has to come from real evidence of the student, not just
-- started_at: if every in-flight section were seeded with its own start time,
-- any section older than the staleness window would look abandoned on the
-- first read after deploy and hand its student a full fresh budget — including
-- students who are sitting in the exam right now.
--
-- The last answer saved in the section is that evidence. A student who is
-- actually working answered recently and keeps their true remaining time; a
-- student whose section has been stranded for hours answered long ago and gets
-- re-anchored, which is exactly the recovery they are owed.
--
-- elapsed_seconds intentionally stays 0. started_at still marks the real start
-- of the sitting, so the clock derives time-actually-worked as
-- (last_activity_at - started_at) on the first read. Pre-banking it here would
-- double-count that same stretch.
UPDATE session_sections s
   SET last_activity_at = GREATEST(
         s.started_at,
         COALESCE(
           (SELECT MAX(r.submitted_at)
              FROM session_responses r
              JOIN session_questions q ON q.id = r.session_question_id
             WHERE q.session_id = s.session_id
               AND q.section_name = s.section_name),
           s.started_at
         )
       )
 WHERE s.last_activity_at IS NULL
   AND s.started_at IS NOT NULL;
