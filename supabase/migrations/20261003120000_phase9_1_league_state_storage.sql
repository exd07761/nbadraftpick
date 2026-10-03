-- Phase 9.1: league_state storage layer
-- Supabase-side home for the single league document that FirebaseSync
-- currently keeps in Firestore (collection "league", doc "main").
--
-- This migration is storage + write RPCs only. It does NOT import data,
-- and nothing in the application reads or writes this table yet.
--
-- Shape: one row per league document, keyed by text id. The only id the
-- application will ever use is 'main'.
--
-- Security model (mirrors Phase 6.10 and the Phase 8.x RPCs):
--   - anon / authenticated may SELECT only. No direct INSERT / UPDATE /
--     DELETE / TRUNCATE (this table is created after the Phase 6.10
--     blanket REVOKE, so the revoke is repeated here explicitly rather
--     than relying on project default privileges).
--   - RLS is enabled with a single read-only policy (public_read).
--   - All browser writes go through SECURITY DEFINER RPCs that begin
--     with PERFORM public.require_commissioner().
--
-- DEPENDENCY: public.require_commissioner() already exists in the live
-- database and is intentionally NOT defined, replaced, or recreated
-- here. It is not defined anywhere in this repository.
--
-- Write RPCs:
--   initialize_league_state(p_data) - inserts ONLY id = 'main'; fails if
--       it already exists; never overwrites.
--   save_league_state(p_data)       - replaces data on the EXISTING
--       'main' row only; fails if that row is missing; never creates a
--       row; never deletes anything.
-- Neither RPC accepts an id argument, so arbitrary league_state ids can
-- never be created through them.

CREATE TABLE public.league_state (
  id         text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.league_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY public_read ON public.league_state
  FOR SELECT
  TO anon, authenticated
  USING (true);

REVOKE ALL ON TABLE public.league_state FROM PUBLIC;
REVOKE ALL ON TABLE public.league_state FROM anon, authenticated;
GRANT SELECT ON TABLE public.league_state TO anon, authenticated;


-- initialize_league_state: one-time creation of the 'main' row.
CREATE OR REPLACE FUNCTION public.initialize_league_state(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_updated_at timestamptz;
BEGIN
  PERFORM public.require_commissioner();

  IF p_data IS NULL THEN
    RAISE EXCEPTION 'p_data must not be NULL' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'p_data must be a JSON object' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.league_state WHERE id = 'main') THEN
    RAISE EXCEPTION 'league_state row ''main'' already exists; use save_league_state to update it'
      USING ERRCODE = '23505';
  END IF;

  -- Plain INSERT (no ON CONFLICT): a concurrent initializer that slips
  -- past the check above hits the primary key and fails with 23505
  -- instead of overwriting anything.
  INSERT INTO public.league_state (id, data, updated_at)
  VALUES ('main', p_data, now())
  RETURNING updated_at INTO v_updated_at;

  RETURN jsonb_build_object(
    'id',         'main',
    'updated_at', v_updated_at
  );
END;
$function$;


-- save_league_state: replace the data of the existing 'main' row.
CREATE OR REPLACE FUNCTION public.save_league_state(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_updated_at timestamptz;
BEGIN
  PERFORM public.require_commissioner();

  IF p_data IS NULL THEN
    RAISE EXCEPTION 'p_data must not be NULL' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'p_data must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- UPDATE only: never inserts, never deletes. data is replaced
  -- completely (no merge); updated_at is always server-side.
  UPDATE public.league_state
     SET data       = p_data,
         updated_at = now()
   WHERE id = 'main'
  RETURNING updated_at INTO v_updated_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'league_state row ''main'' does not exist; run initialize_league_state first'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'id',         'main',
    'updated_at', v_updated_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.initialize_league_state(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.initialize_league_state(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.initialize_league_state(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_league_state(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_league_state(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_league_state(jsonb) TO authenticated, service_role;
