-- Sync assigned NBA2K27 Green Pool positions from the current-player source.
-- Only existing Green rows with an already-assigned standard position are
-- eligible. NULL and UNASSIGNED are intentionally left untouched.

CREATE OR REPLACE FUNCTION public.sync_nba2k27_green_positions(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  PERFORM public.require_commissioner();

  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_PAYLOAD: p_updates must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  WITH updates AS (
    SELECT DISTINCT ON (x.nba2k_ref)
      x.nba2k_ref,
      x.position
    FROM jsonb_to_recordset(p_updates) AS x(nba2k_ref text, position text)
    WHERE x.nba2k_ref IS NOT NULL
      AND x.position IN ('PG', 'SG', 'SF', 'PF', 'C')
    ORDER BY x.nba2k_ref
  )
  UPDATE public.nba2k27_pool AS pool
  SET position = updates.position,
      updated_at = now()
  FROM updates
  WHERE pool.nba2k_ref = updates.nba2k_ref
    AND pool.pool = 'green'
    AND pool.position IN ('PG', 'SG', 'SF', 'PF', 'C');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_nba2k27_green_positions(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_nba2k27_green_positions(jsonb) TO authenticated, service_role;
