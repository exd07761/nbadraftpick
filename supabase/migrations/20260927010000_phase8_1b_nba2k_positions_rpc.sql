-- Phase 8.1B: protected NBA2K player position update.
--
-- Replaces the Firebase-only _savePositions() write path.
-- Preserves the existing optimistic-concurrency check:
-- the stored positions must still match the editor's expected
-- previous value before the update is allowed.

CREATE OR REPLACE FUNCTION public.save_nba2k_player_positions(
  p_slug text,
  p_positions text[],
  p_expected_previous text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
  v_current_positions text[];
  v_normalized_positions text[];
  v_normalized_previous text[];
  v_normalized_current text[];
BEGIN
  PERFORM public.require_commissioner();

  IF p_slug IS NULL OR btrim(p_slug) = '' THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND: player slug is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT positions
    INTO v_current_positions
    FROM public.nba2k_players
   WHERE slug = p_slug
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND: This NBA2K player could not be found.'
      USING ERRCODE = 'P0002';
  END IF;

  /*
   * Match normalizeNba2kPositions() from the existing JavaScript:
   *   PG, SG, SF, PF, C
   *
   * Invalid values are ignored, duplicates are removed, and the
   * canonical position order is enforced.
   */
  SELECT COALESCE(
    ARRAY(
      SELECT position
      FROM unnest(
        ARRAY['PG', 'SG', 'SF', 'PF', 'C']::text[]
      ) WITH ORDINALITY AS valid(position, ord)
      WHERE position = ANY(
        COALESCE(p_positions, ARRAY[]::text[])
      )
      ORDER BY ord
    ),
    ARRAY[]::text[]
  )
  INTO v_normalized_positions;

  SELECT COALESCE(
    ARRAY(
      SELECT position
      FROM unnest(
        ARRAY['PG', 'SG', 'SF', 'PF', 'C']::text[]
      ) WITH ORDINALITY AS valid(position, ord)
      WHERE position = ANY(
        COALESCE(p_expected_previous, ARRAY[]::text[])
      )
      ORDER BY ord
    ),
    ARRAY[]::text[]
  )
  INTO v_normalized_previous;

  /*
   * Normalize the stored database value too, matching
   * nba2kPositionsEqual() in the existing JavaScript.
   */
  SELECT COALESCE(
    ARRAY(
      SELECT position
      FROM unnest(
        ARRAY['PG', 'SG', 'SF', 'PF', 'C']::text[]
      ) WITH ORDINALITY AS valid(position, ord)
      WHERE position = ANY(
        COALESCE(v_current_positions, ARRAY[]::text[])
      )
      ORDER BY ord
    ),
    ARRAY[]::text[]
  )
  INTO v_normalized_current;

  /*
   * Optimistic concurrency check.
   * This mirrors nba2kPositionsEqual() after normalization.
   */
  IF NOT (
    v_normalized_current = v_normalized_previous
  ) THEN
    RAISE EXCEPTION
      'CONFLICT: This player was updated elsewhere. Please reload the player before saving.'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.nba2k_players
     SET positions = v_normalized_positions
   WHERE slug = p_slug;
END;
$function$;

REVOKE EXECUTE
  ON FUNCTION public.save_nba2k_player_positions(text, text[], text[])
  FROM PUBLIC, anon;

GRANT EXECUTE
  ON FUNCTION public.save_nba2k_player_positions(text, text[], text[])
  TO authenticated, service_role;