-- Phase 8.3 — NBA2K27 Player Import Bulk Upsert RPC
--
-- Replaces the Firestore-based batched writes in js/admin/nba2k-import.js
-- (_runImport) with a single Supabase RPC per client-side chunk. Follows
-- the same conventions established by save_nba2k_player_positions(),
-- the Phase 8.1F Add/Remove RPCs, and the Phase 8.2 Manual Edit RPC
-- (require_commissioner() first, SECURITY DEFINER, SET search_path TO
-- 'public', "PREFIX: message" exceptions with a matching SQLSTATE,
-- EXECUTE granted only to authenticated/service_role — never PUBLIC or
-- anon).
--
-- No schema change: the Phase 8.3 audit verified every field written by
-- the importer already has a compatible column on public.nba2k_players
-- (confirmed both from information_schema and by inspecting live data
-- already stored in the table: `height`/`weight`/`wingspan` are
-- formatted strings like "6'8\"" / "235 lbs" — a genuine match for their
-- `text` columns, not a numeric mismatch; `last_updated` values vary
-- per-player and parse cleanly as timestamptz; `attributes`/`badges`
-- match their jsonb columns' expected shape exactly).
--
-- Preserves Firestore's `merge:false` "source is authoritative on
-- re-import" semantics via an explicit full-column
-- `ON CONFLICT ... DO UPDATE SET <every imported column>` — never a
-- partial merge, so no stale value can survive a re-import.

CREATE OR REPLACE FUNCTION public.bulk_upsert_nba2k_players(p_players jsonb)
RETURNS TABLE(inserted_count integer, updated_count integer, total_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total integer;
  v_existing_count integer;
BEGIN
  PERFORM public.require_commissioner();

  IF p_players IS NULL OR jsonb_typeof(p_players) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_PAYLOAD: p_players must be a JSON array of player objects.'
      USING ERRCODE = '22023';
  END IF;

  v_total := jsonb_array_length(p_players);

  IF v_total = 0 THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- Counted BEFORE the upsert so the created/updated split reflects the
  -- state at the start of this call, matching the client's own
  -- pre-computed toCreate/toUpdate counts from the preview step (this is
  -- a cross-check/confirmation value, not the source of truth the UI
  -- displays — the client already computed those counts before calling).
  SELECT count(*) INTO v_existing_count
  FROM public.nba2k_players t
  WHERE t.slug IN (
    SELECT elem ->> 'slug' FROM jsonb_array_elements(p_players) AS elem
  );

  INSERT INTO public.nba2k_players (
    slug, name, team, team_type, overall, positions, height, weight,
    wingspan, build, player_url, player_image, team_img, attributes,
    badges, last_updated, imported_at
  )
  SELECT
    x.slug,
    x.name,
    x.team,
    x.team_type,
    x.overall,
    COALESCE(x.positions, '{}'::text[]),
    x.height,
    x.weight,
    x.wingspan,
    x.build,
    x.player_url,
    x.player_image,
    x.team_img,
    COALESCE(x.attributes, '{}'::jsonb),
    COALESCE(x.badges, '{}'::jsonb),
    x.last_updated,
    now() -- imported_at is ALWAYS server-side now(), never client-supplied
  FROM jsonb_to_recordset(p_players) AS x(
    slug text,
    name text,
    team text,
    team_type text,
    overall smallint,
    positions text[],
    height text,
    weight text,
    wingspan text,
    build text,
    player_url text,
    player_image text,
    team_img text,
    attributes jsonb,
    badges jsonb,
    last_updated timestamptz
  )
  ON CONFLICT (slug) DO UPDATE SET
    name          = EXCLUDED.name,
    team          = EXCLUDED.team,
    team_type     = EXCLUDED.team_type,
    overall       = EXCLUDED.overall,
    positions     = EXCLUDED.positions,
    height        = EXCLUDED.height,
    weight        = EXCLUDED.weight,
    wingspan      = EXCLUDED.wingspan,
    build         = EXCLUDED.build,
    player_url    = EXCLUDED.player_url,
    player_image  = EXCLUDED.player_image,
    team_img      = EXCLUDED.team_img,
    attributes    = EXCLUDED.attributes,
    badges        = EXCLUDED.badges,
    last_updated  = EXCLUDED.last_updated,
    imported_at   = EXCLUDED.imported_at;
  -- Every imported column is explicitly re-set on conflict — this is the
  -- "full overwrite, never a stale leftover" behavior Firestore's
  -- merge:false previously guaranteed. `slug` (the conflict key) is
  -- naturally never touched; nba2k27_pool is never referenced here.

  RETURN QUERY SELECT
    (v_total - v_existing_count)::integer,
    v_existing_count::integer,
    v_total::integer;
END;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────
-- Same ACL shape as every other write RPC in this migration: EXECUTE
-- limited to authenticated/service_role; no PUBLIC, no anon.
REVOKE ALL ON FUNCTION public.bulk_upsert_nba2k_players(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.bulk_upsert_nba2k_players(jsonb) TO authenticated, service_role;
