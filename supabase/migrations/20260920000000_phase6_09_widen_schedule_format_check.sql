-- Phase 6.9 prerequisite: widen public.seasons.schedule_format's CHECK
-- constraint to also allow 'conferenceRoundRobin'.
--
-- WHY: Firebase's Conference Round Robin scheduling format
-- (js/data.js -> season.scheduleFormat = "conferenceRoundRobin", set by
-- the Conference Round Robin schedule-generation path) is a real,
-- currently-live production value -- the current production season
-- (s_1789122165828_va8om, confirmed via the Phase 6.9 Seasons +
-- Participants dry-run) already has this exact value. The Supabase
-- `seasons.schedule_format` CHECK constraint only allowed 'roundRobin'
-- and 'groupStage', so the dry-run correctly aborted with zero writes
-- rather than silently drop or coerce the value. This migration is the
-- minimal fix identified by that investigation.
--
-- SCOPE -- deliberately minimal, per the investigation that identified
-- this as sufficient for the Seasons + Participants backfill:
--   - No table added.
--   - No column added.
--   - No RPC modified. generate_schedule / generate_group_stage_schedule /
--     reset_schedule keep writing their own hardcoded 'roundRobin' /
--     'groupStage' / NULL values, unchanged. There is still no RPC that
--     writes 'conferenceRoundRobin' -- schedule generation for that
--     format remains a Firebase-only capability until a future migration
--     slice addresses it. This migration only lets the *label* round-trip
--     through a read/backfill; it adds no Conference Round Robin
--     functionality on the Supabase side.
--   - No view modified (the only view, nba2k27_effective_players, is
--     unrelated to seasons/schedule_format).
--   - Purely additive to the constraint: 'roundRobin' and 'groupStage'
--     remain valid exactly as before, and NULL remains valid (the column
--     is nullable and this constraint does not touch nullability), so
--     every existing row satisfies the widened constraint unchanged --
--     preserving existing behavior for existing values.

ALTER TABLE public.seasons
  DROP CONSTRAINT seasons_schedule_format_check;

ALTER TABLE public.seasons
  ADD CONSTRAINT seasons_schedule_format_check
  CHECK (schedule_format = ANY (ARRAY['roundRobin'::text, 'groupStage'::text, 'conferenceRoundRobin'::text]));
