-- Phase 8.6: Initialize 2K27 Pool -> Supabase RPC
-- Replaces the Firestore batch write in Nba2kDatabaseView._runInitialization().
--
-- Client sends a write plan: [{ "slug", "pool", "position" }, ...]
-- Server is authoritative for: existence (created vs corrected), selected_at,
-- updated_at, and final position. Never deletes. Upserts by nba2k_ref.
-- Only nba2k_ref / pool / position / selected_at / updated_at are ever written.

CREATE OR REPLACE FUNCTION public.initialize_nba2k27_pool(p_players jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  -- Keep in sync with the NBA2K27 position vocabulary used by the app
  -- (normalizeNba2kPositions / save_nba2k_player_positions).
  v_valid_positions constant text[] := ARRAY['PG','SG','SF','PF','C','UNASSIGNED'];
  v_valid_pools     constant text[] := ARRAY['green','blue','white'];
  v_now      timestamptz := now();
  v_item     jsonb;
  v_idx      int := 0;
  v_slugs    text[] := ARRAY[]::text[];
  v_slug     text;
  v_pool     text;
  v_pos      text;
  v_missing  text[];
  v_total    int;
  v_created  int := 0;
  v_corrected int := 0;
BEGIN
  PERFORM public.require_commissioner();

  IF p_players IS NULL OR jsonb_typeof(p_players) <> 'array' THEN
    RAISE EXCEPTION 'p_players must be a JSON array' USING ERRCODE = '22023';
  END IF;

  v_total := jsonb_array_length(p_players);
  IF v_total = 0 THEN
    RETURN jsonb_build_object('created', 0, 'corrected', 0, 'unchanged', 0, 'total', 0);
  END IF;

  -- Validate every item up front; any failure aborts the whole call.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_players) LOOP
    v_idx := v_idx + 1;

    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'item %: must be an object', v_idx USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_item->'slug') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item->'pool') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item->'position') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'item %: slug, pool and position must be strings', v_idx USING ERRCODE = '22023';
    END IF;

    v_slug := btrim(v_item->>'slug');
    v_pool := v_item->>'pool';
    v_pos  := v_item->>'position';

    IF v_slug = '' THEN
      RAISE EXCEPTION 'item %: slug must be non-empty', v_idx USING ERRCODE = '22023';
    END IF;
    IF NOT (v_pool = ANY (v_valid_pools)) THEN
      RAISE EXCEPTION 'item % (%): invalid pool %', v_idx, v_slug, v_pool USING ERRCODE = '22023';
    END IF;
    IF NOT (v_pos = ANY (v_valid_positions)) THEN
      RAISE EXCEPTION 'item % (%): invalid position %', v_idx, v_slug, v_pos USING ERRCODE = '22023';
    END IF;
    IF v_slug = ANY (v_slugs) THEN
      RAISE EXCEPTION 'item % (%): duplicate slug', v_idx, v_slug USING ERRCODE = '22023';
    END IF;
    v_slugs := v_slugs || v_slug;
  END LOOP;

  SELECT array_agg(s) INTO v_missing
  FROM unnest(v_slugs) AS s
  WHERE NOT EXISTS (SELECT 1 FROM public.nba2k_players p WHERE p.slug = s);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'unknown nba2k_players slug(s): %', array_to_string(v_missing, ', ')
      USING ERRCODE = '23503';
  END IF;

  -- Classify against current DB state (client isNew is never used).
  -- Final position: keep existing valid position, otherwise UNASSIGNED.
  -- Rows already correct (same pool, valid position) are left untouched.
  WITH incoming AS (
  SELECT
    btrim(e.value->>'slug') AS slug,
    CASE p.team_type
      WHEN 'curr'  THEN 'green'
      WHEN 'allt'  THEN 'blue'
      WHEN 'class' THEN 'white'
      ELSE NULL
    END AS pool,
    e.value->>'position' AS position
  FROM jsonb_array_elements(p_players) AS e
  JOIN public.nba2k_players p
    ON p.slug = btrim(e.value->>'slug')
),
  plan AS (
    SELECT i.slug,
           i.pool,
           (x.nba2k_ref IS NULL) AS is_new,
           CASE
            WHEN x.nba2k_ref IS NULL THEN i.position
            WHEN x.position = ANY (v_valid_positions) THEN x.position
              ELSE 'UNASSIGNED'
            END AS final_position,
           x.selected_at AS old_selected_at,
           (x.nba2k_ref IS NOT NULL
              AND x.pool = i.pool
              AND x.position = ANY (v_valid_positions)) AS already_correct
    FROM incoming i
    LEFT JOIN public.nba2k27_pool x ON x.nba2k_ref = i.slug
  ),
  written AS (
    INSERT INTO public.nba2k27_pool AS t (nba2k_ref, pool, position, selected_at, updated_at)
    SELECT p.slug, p.pool, p.final_position, COALESCE(p.old_selected_at, v_now), v_now
    FROM plan p
    WHERE NOT p.already_correct
    ON CONFLICT (nba2k_ref) DO UPDATE
      SET pool       = EXCLUDED.pool,
          position   = EXCLUDED.position,
          selected_at = COALESCE(t.selected_at, EXCLUDED.selected_at),
          updated_at = EXCLUDED.updated_at
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted),
         count(*) FILTER (WHERE NOT inserted)
    INTO v_created, v_corrected
  FROM written;

  RETURN jsonb_build_object(
    'created',   v_created,
    'corrected', v_corrected,
    'unchanged', v_total - v_created - v_corrected,
    'total',     v_total
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.initialize_nba2k27_pool(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.initialize_nba2k27_pool(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.initialize_nba2k27_pool(jsonb) TO authenticated, service_role;
