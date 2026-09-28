-- Phase 8.1F — NBA2K27 Pool Add/Remove RPCs
--
-- Replaces the Firestore-based "Add to 2K27 Pool" / "Remove from 2K27
-- Pool" write paths in js/admin/nba2k-database.js with Supabase RPCs.
-- Follows the same conventions already established by
-- save_nba2k_player_positions() (require_commissioner() first, SECURITY
-- DEFINER, SET search_path TO 'public', "PREFIX: message" exceptions
-- with a matching SQLSTATE, EXECUTE granted only to authenticated/
-- service_role — never PUBLIC or anon).
--
-- This migration is DATABASE-ONLY: it does not change any frontend
-- code, does not touch public.nba2k_players, public.league/main-
-- equivalent tables, or any Draft Pool/promotion logic, and creates no
-- new RLS policies (writes continue to route through these
-- SECURITY DEFINER functions, per the existing RLS design).

-- ── add_nba2k27_pool_player ────────────────────────────────────────────
-- Adds (or re-syncs) a single NBA2K player's NBA 2K27 pool selection.
-- Idempotent by nba2k_ref (the primary key): a repeat call for an
-- already-selected player never resets selected_at, never touches
-- position, overall_override, name_override, or variant_group_id (so a
-- prior Manual Edit is never clobbered), and only re-derives+re-syncs
-- `pool` from the player's current team_type — a defensive consistency
-- correction (matching the existing bulk-Initialize "correct a stale
-- pool" behavior), not an expected code path, since team_type is not
-- expected to change for an existing player in normal operation.
CREATE OR REPLACE FUNCTION public.add_nba2k27_pool_player(p_slug text)
RETURNS public.nba2k27_pool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_team_type text;
  v_pool text;
  v_now timestamptz := now();
  v_row public.nba2k27_pool;
BEGIN
  PERFORM public.require_commissioner();

  IF p_slug IS NULL OR btrim(p_slug) = '' THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND: player slug is required'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT team_type
    INTO v_team_type
    FROM public.nba2k_players
   WHERE slug = p_slug;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND: This NBA2K player could not be found.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Server-side pool derivation — the ONLY source of truth for `pool`.
  -- A client-supplied pool value is never accepted; an unrecognized or
  -- missing team_type blocks the add entirely rather than guessing.
  v_pool := CASE v_team_type
    WHEN 'curr'  THEN 'green'
    WHEN 'allt'  THEN 'blue'
    WHEN 'class' THEN 'white'
    ELSE NULL
  END;

  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'POOL_UNDETERMINED: Cannot determine pool eligibility for this NBA2K player.'
      USING ERRCODE = '22023';
  END IF;

  -- Idempotent upsert by nba2k_ref (primary key). On first insert:
  -- position is explicitly 'UNASSIGNED' (never left NULL, even though
  -- the column allows it), matching current app behavior. On conflict
  -- (already selected): selected_at is preserved (omitted from the SET
  -- clause), position/overall_override/name_override/variant_group_id
  -- are left completely untouched, and only pool + updated_at are
  -- re-synced to the freshly-derived value.
  INSERT INTO public.nba2k27_pool (nba2k_ref, pool, position, selected_at, updated_at)
  VALUES (p_slug, v_pool, 'UNASSIGNED', v_now, v_now)
  ON CONFLICT (nba2k_ref) DO UPDATE
    SET pool = EXCLUDED.pool,
        updated_at = v_now
  RETURNING * INTO v_row;

  RETURN v_row;

EXCEPTION
  -- Defensive only: the explicit nba2k_players lookup above already
  -- rejects a missing slug before this INSERT runs, so this branch only
  -- fires on a genuine race (player deleted between the lookup and the
  -- insert). Ensures the client only ever sees the established
  -- "PLAYER_NOT_FOUND: ..." shape, never a raw FK-violation message.
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND: This NBA2K player could not be found.'
      USING ERRCODE = 'P0002';
END;
$function$;

-- ── remove_nba2k27_pool_player ─────────────────────────────────────────
-- Deletes a single NBA2K player's NBA 2K27 pool selection by nba2k_ref.
-- Never touches public.nba2k_players. A missing row is a successful
-- no-op (the caller's desired end state — player not in the 2K27
-- pool — is already true), matching current UI behavior where any
-- existing selection, including an orphaned or invalid one, can be
-- removed with no precondition beyond commissioner auth. The deleted
-- row is returned when one existed; NULL signals the no-op case, so the
-- client can distinguish "removed" from "already absent" if it needs to.
CREATE OR REPLACE FUNCTION public.remove_nba2k27_pool_player(p_slug text)
RETURNS public.nba2k27_pool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.nba2k27_pool;
BEGIN
  PERFORM public.require_commissioner();

  DELETE FROM public.nba2k27_pool
   WHERE nba2k_ref = p_slug
  RETURNING * INTO v_row;

  RETURN v_row; -- NULL when no matching row existed — a successful no-op.
END;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────
-- Mirrors the live ACL already observed on save_nba2k_player_positions
-- (EXECUTE limited to authenticated/service_role; no PUBLIC, no anon).
-- Explicit here for clarity/self-documentation even though this
-- project's default privileges for public-schema functions already
-- omit PUBLIC and anon by default.
REVOKE ALL ON FUNCTION public.add_nba2k27_pool_player(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_nba2k27_pool_player(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.add_nba2k27_pool_player(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_nba2k27_pool_player(text) TO authenticated, service_role;

-- require_commissioner()/is_commissioner() remain granted only to
-- service_role/postgres (unchanged by this migration) — never granted
-- directly to authenticated/anon. Client code must call the two RPCs
-- above, never the inner authorization helpers.
