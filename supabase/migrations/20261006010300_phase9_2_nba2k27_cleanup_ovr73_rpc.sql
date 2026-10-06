-- Phase 9.2 — Atomic NBA2K27 source-player cleanup (source OVR <= 73).
--
-- This narrowly scoped RPC removes only source players whose SOURCE
-- nba2k_players.overall is <= 73 and matching nba2k27_pool rows. It does
-- not update league_state, draft_picks, roster_entries, or other players.
-- The hard count guard intentionally fails closed if live data has moved
-- from the reviewed set (675 source rows / 674 matching pool rows).

CREATE OR REPLACE FUNCTION public.cleanup_nba2k27_players_ovr73()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_candidate_slugs text[];
  v_source_candidates integer;
  v_pool_matches integer;
  v_players_candidate_refs bigint;
  v_pool_deleted integer := 0;
  v_source_deleted integer := 0;
  v_source_total_before bigint;
  v_source_total_after bigint;
  v_pool_total_before bigint;
  v_pool_total_after bigint;
  v_source_ge74_before bigint;
  v_source_ge74_after bigint;
  v_pool_ge74_before bigint;
  v_pool_ge74_after bigint;
  v_source_remaining_low bigint;
  v_pool_remaining_candidate_slugs bigint;
BEGIN
  PERFORM public.require_commissioner();

  -- Prevent new player-to-source references while the zero-reference check
  -- and source deletion are in progress. Lock players first, then the two
  -- source/pool tables, so the candidate set and guards stay stable.
  LOCK TABLE public.players IN SHARE MODE;
  LOCK TABLE public.nba2k_players IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.nba2k27_pool IN SHARE ROW EXCLUSIVE MODE;

  -- Fail closed if another table could be changed by referential actions.
  -- The only allowed inbound relationships are the pool membership FK
  -- (deleted explicitly first) and players.nba2k_ref (which must have zero
  -- candidate references below). Any other inbound FK to either target
  -- requires a separate reviewed cleanup plan.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_class AS referenced_table ON referenced_table.oid = c.confrelid
      JOIN pg_catalog.pg_namespace AS referenced_schema ON referenced_schema.oid = referenced_table.relnamespace
      JOIN pg_catalog.pg_class AS referencing_table ON referencing_table.oid = c.conrelid
      JOIN pg_catalog.pg_namespace AS referencing_schema ON referencing_schema.oid = referencing_table.relnamespace
     WHERE c.contype = 'f'
       AND referenced_schema.nspname = 'public'
       AND (
         (referenced_table.relname = 'nba2k_players'
           AND NOT (
             (
               (
                 c.conname = 'nba2k27_pool_nba2k_ref_fkey'
                 AND referencing_schema.nspname = 'public'
                 AND referencing_table.relname = 'nba2k27_pool'
                 AND c.confdeltype = 'r'
               )
               OR
               (
                 c.conname = 'fk_players_nba2k_ref'
                 AND referencing_schema.nspname = 'public'
                 AND referencing_table.relname = 'players'
                 AND c.confdeltype = 'n'
               )
             )
             AND cardinality(c.conkey) = 1
             AND cardinality(c.confkey) = 1
             AND EXISTS (
               SELECT 1 FROM pg_catalog.pg_attribute AS child_column
                WHERE child_column.attrelid = c.conrelid
                  AND child_column.attnum = c.conkey[1]
                  AND child_column.attname = 'nba2k_ref'
                  AND NOT child_column.attisdropped
             )
             AND EXISTS (
               SELECT 1 FROM pg_catalog.pg_attribute AS parent_column
                WHERE parent_column.attrelid = c.confrelid
                  AND parent_column.attnum = c.confkey[1]
                  AND parent_column.attname = 'slug'
                  AND NOT parent_column.attisdropped
             )
           ))
         OR referenced_table.relname = 'nba2k27_pool'
       )
  ) THEN
    RAISE EXCEPTION 'UNEXPECTED_FK_DEPENDENCY: cleanup targets have an inbound foreign key beyond the two reviewed relationships'
      USING ERRCODE = 'P0001';
  END IF;

  -- User-defined triggers could write to unrelated tables. Stop rather
  -- than allow hidden side effects; PostgreSQL's internal FK triggers are
  -- excluded because they are covered by the FK guard above.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid IN ('public.nba2k_players'::regclass, 'public.nba2k27_pool'::regclass)
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'UNEXPECTED_TRIGGER: cleanup targets have an enabled user-defined trigger'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(array_agg(p.slug ORDER BY p.slug), ARRAY[]::text[])
    INTO v_candidate_slugs
    FROM public.nba2k_players AS p
   WHERE p.overall <= 73;
  v_source_candidates := cardinality(v_candidate_slugs);

  SELECT count(*)::integer
    INTO v_pool_matches
    FROM public.nba2k27_pool AS pool
    JOIN public.nba2k_players AS player ON player.slug = pool.nba2k_ref
   WHERE player.overall <= 73;

  -- Reviewed live guard. Any change in source or matching pool counts
  -- aborts before either DELETE statement.
  IF v_source_candidates <> 675 OR v_pool_matches <> 674 THEN
    RAISE EXCEPTION 'COUNT_MISMATCH: expected 675 source candidates and 674 matching pool rows; found % and %',
      v_source_candidates, v_pool_matches
      USING ERRCODE = 'P0001';
  END IF;

  -- players.nba2k_ref has ON DELETE SET NULL. Do not permit cleanup to
  -- silently modify any players rows; candidate references must be zero.
  SELECT count(*)
    INTO v_players_candidate_refs
    FROM public.players AS player
   WHERE player.nba2k_ref = ANY(v_candidate_slugs);

  IF v_players_candidate_refs <> 0 THEN
    RAISE EXCEPTION 'PLAYERS_REFERENCE_EXISTS: found % players rows referencing OVR<=73 NBA2K27 candidates',
      v_players_candidate_refs
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_source_total_before FROM public.nba2k_players;
  SELECT count(*) INTO v_pool_total_before FROM public.nba2k27_pool;
  SELECT count(*) INTO v_source_ge74_before FROM public.nba2k_players WHERE overall >= 74;
  SELECT count(*) INTO v_pool_ge74_before
    FROM public.nba2k27_pool AS pool
    JOIN public.nba2k_players AS player ON player.slug = pool.nba2k_ref
   WHERE player.overall >= 74;

  -- Delete only memberships joined to the exact source candidate set.
  DELETE FROM public.nba2k27_pool AS pool
   USING public.nba2k_players AS player
   WHERE pool.nba2k_ref = player.slug
     AND player.overall <= 73;
  GET DIAGNOSTICS v_pool_deleted = ROW_COUNT;

  -- Delete source rows second; no other table or player fields are touched.
  DELETE FROM public.nba2k_players AS player
   WHERE player.slug = ANY(v_candidate_slugs)
     AND player.overall <= 73;
  GET DIAGNOSTICS v_source_deleted = ROW_COUNT;

  SELECT count(*) INTO v_source_total_after FROM public.nba2k_players;
  SELECT count(*) INTO v_pool_total_after FROM public.nba2k27_pool;
  SELECT count(*) INTO v_source_ge74_after FROM public.nba2k_players WHERE overall >= 74;
  SELECT count(*) INTO v_pool_ge74_after
    FROM public.nba2k27_pool AS pool
    JOIN public.nba2k_players AS player ON player.slug = pool.nba2k_ref
   WHERE player.overall >= 74;
  SELECT count(*) INTO v_source_remaining_low FROM public.nba2k_players WHERE overall <= 73;
  SELECT count(*) INTO v_pool_remaining_candidate_slugs
    FROM public.nba2k27_pool AS pool
   WHERE pool.nba2k_ref = ANY(v_candidate_slugs);

  -- Every postcondition is checked before returning. Any mismatch raises
  -- inside this function call, rolling both DELETE statements back.
  IF v_pool_deleted <> 674
     OR v_source_deleted <> 675
     OR v_source_remaining_low <> 0
     OR v_pool_remaining_candidate_slugs <> 0
     OR v_source_total_after <> v_source_total_before - v_source_deleted
     OR v_pool_total_after <> v_pool_total_before - v_pool_deleted
     OR v_source_ge74_after <> v_source_ge74_before
     OR v_pool_ge74_after <> v_pool_ge74_before THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: cleanup counts or preserved-player counts did not match expectations'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'criterion', 'nba2k_players.overall <= 73 (source overall)',
    'source_candidates_before', v_source_candidates,
    'pool_matches_before', v_pool_matches,
    'players_candidate_references_before', v_players_candidate_refs,
    'source_rows_deleted', v_source_deleted,
    'pool_rows_deleted', v_pool_deleted,
    'deleted_player_slugs', pg_catalog.to_jsonb(v_candidate_slugs),
    'source_rows_remaining_at_or_below_73', v_source_remaining_low,
    'pool_rows_remaining_for_deleted_slugs', v_pool_remaining_candidate_slugs,
    'source_rows_total_before', v_source_total_before,
    'source_rows_total_after', v_source_total_after,
    'pool_rows_total_before', v_pool_total_before,
    'pool_rows_total_after', v_pool_total_after,
    'source_rows_overall_ge_74_before', v_source_ge74_before,
    'source_rows_overall_ge_74_after', v_source_ge74_after,
    'pool_rows_for_source_overall_ge_74_before', v_pool_ge74_before,
    'pool_rows_for_source_overall_ge_74_after', v_pool_ge74_after,
    'league_state_touched', false,
    'draft_picks_touched', false,
    'roster_entries_touched', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_nba2k27_players_ovr73() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_nba2k27_players_ovr73() TO authenticated, service_role;

COMMENT ON FUNCTION public.cleanup_nba2k27_players_ovr73() IS
  'Atomic, commissioner-only deletion of NBA2K27 source players with source overall <=73 and their matching pool rows; fixed reviewed-count guards 675/674.';
