-- Phase 8.1G: make nba2k_players read policy compatible with
-- Firebase UID subjects carried in the Supabase JWT.
--
-- auth.uid() assumes auth.jwt()->>'sub' is a PostgreSQL UUID.
-- This application uses Firebase Auth UIDs, which are strings.
-- Preserve the existing conditional-read behavior while avoiding
-- the UUID cast.

ALTER POLICY conditional_read
ON public.nba2k_players
USING (
  (auth.jwt() ->> 'sub') IS NOT NULL
  OR EXISTS (
    SELECT 1
    FROM public.nba2k27_pool
    WHERE public.nba2k27_pool.nba2k_ref = public.nba2k_players.slug
  )
);
