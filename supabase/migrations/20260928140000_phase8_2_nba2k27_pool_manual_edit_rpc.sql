-- Phase 8.2 — NBA2K27 Pool Manual Edit RPC
--
-- Replaces the Firestore-based "Manual Edit" save (Nba2k27PoolView.
-- _openManualEdit, js/admin/nba2k-database.js) with a Supabase RPC.
-- Follows the same conventions established by save_nba2k_player_positions()
-- and the Phase 8.1F Add/Remove RPCs (require_commissioner() first,
-- SECURITY DEFINER, SET search_path TO 'public', "PREFIX: message"
-- exceptions with a matching SQLSTATE, EXECUTE granted only to
-- authenticated/service_role — never PUBLIC or anon).
--
-- Per the Phase 8.2 usage audit: `teamOverride` has no Supabase column
-- and no downstream consumer anywhere in the app (confirmed dead —
-- every team display reads the source player record directly, never
-- this override), so it is NOT added here and is being removed from the
-- Manual Edit UI in the same phase. `variantLabel` IS actively displayed
-- (Pool Management's position grid, and the variant-group-members list)
-- so it IS added here.

-- ── Schema: add the one missing column needed to preserve variantLabel ──
ALTER TABLE public.nba2k27_pool
  ADD COLUMN variant_label text NULL;

-- ── update_nba2k27_pool_manual_edit ─────────────────────────────────────
-- Updates the Manual Edit fields on a single nba2k27_pool row: position,
-- name_override, overall_override, variant_group_id, variant_label, and
-- updated_at. Never touches pool, selected_at, or nba2k_ref — the same
-- "only the intended fields, never anything else" safety property the
-- Position Sorter and Add/Remove RPCs already guarantee.
--
-- NULL for any of p_name_override / p_overall_override /
-- p_variant_group_id / p_variant_label means "clear this field" — a
-- direct column assignment is Postgres's equivalent of Firestore's
-- FieldValue.delete() for a nullable column, so no special sentinel
-- value is needed. p_position is required and is never nullable.
CREATE OR REPLACE FUNCTION public.update_nba2k27_pool_manual_edit(
  p_slug text,
  p_position text,
  p_name_override text,
  p_overall_override smallint,
  p_variant_group_id text,
  p_variant_label text
)
RETURNS public.nba2k27_pool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.nba2k27_pool;
BEGIN
  PERFORM public.require_commissioner();

  IF p_slug IS NULL OR btrim(p_slug) = '' THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND: player slug is required'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.nba2k_players WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND: This NBA2K player could not be found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_position IS NULL OR p_position NOT IN ('PG', 'SG', 'SF', 'PF', 'C', 'UNASSIGNED') THEN
    RAISE EXCEPTION 'INVALID_POSITION: Position must be one of PG/SG/SF/PF/C/UNASSIGNED.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.nba2k27_pool
     SET position          = p_position,
         name_override     = p_name_override,
         overall_override  = p_overall_override,
         variant_group_id  = p_variant_group_id,
         variant_label     = p_variant_label,
         updated_at        = now()
   WHERE nba2k_ref = p_slug
  RETURNING * INTO v_row;

  -- Manual Edit is only ever opened for a player already in the pool
  -- (Nba2k27PoolView lists only pool rows, and _openManualEdit bails out
  -- on an orphaned row before this RPC is ever called), so this should
  -- not happen in normal use. Defensive only: a race where the row was
  -- removed between opening the form and saving. Reuses PLAYER_NOT_FOUND
  -- rather than inventing a new prefix outside the agreed error set.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND: This NBA2K player is not currently in the 2K27 pool.'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────
-- Same ACL shape as add_nba2k27_pool_player/remove_nba2k27_pool_player:
-- EXECUTE limited to authenticated/service_role; no PUBLIC, no anon.
REVOKE ALL ON FUNCTION public.update_nba2k27_pool_manual_edit(text, text, text, smallint, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.update_nba2k27_pool_manual_edit(text, text, text, smallint, text, text) TO authenticated, service_role;
