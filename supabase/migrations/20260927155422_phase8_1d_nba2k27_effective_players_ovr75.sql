-- Phase 8.1D: raise the NBA2K27 effective/draftable-player overall floor
-- from 40 to 75, for all three pools (green/blue/white).
--
-- WHY: 40 was a generic "not obviously garbage data" sanity bound
-- introduced in the "Season CutOver" commit (89a8c53, 2026-09-10), never
-- a deliberate skill-level cutoff. The confirmed intended NBA2K27 rule is
-- overall >= 75 for every pool. This migration changes ONLY that lower
-- bound in the view predicate -- every other condition (position validity,
-- pool validity, non-blank effective name, overall <= 99, all columns,
-- the join, name_override/overall_override handling) is byte-for-byte
-- unchanged.
--
-- SCOPE:
--   - No table touched. No row in nba2k_players or nba2k27_pool is
--     read/write-affected -- this only changes which existing rows the
--     view surfaces. Players below 75 remain valid rows in both tables.
--   - No RPC modified.
--   - Does NOT touch minRatingFor()/GREEN_MIN_RATING/WHITE_MIN_RATING/
--     BLUE_MIN_RATING (js/data.js) -- those are a separate, pool-specific
--     roster-entry rule (75/75/84) and are intentionally left alone here.
--     This migration only aligns the "effective player" listing floor
--     with the flat 75 the business has now confirmed; it does not
--     attempt to reconcile Blue's stricter 84 roster-entry floor, which
--     remains a separate discussion.

CREATE OR REPLACE VIEW public.nba2k27_effective_players AS
 SELECT 'p27live_'::text || p.nba2k_ref AS live_id,
    p.nba2k_ref,
    COALESCE(NULLIF(TRIM(BOTH FROM p.name_override), ''::text), n.name) AS name,
    COALESCE(p.overall_override, n.overall) AS overall,
    p."position",
    p.pool,
    NULLIF(TRIM(BOTH FROM p.variant_group_id), ''::text) AS variant_group_id
   FROM nba2k27_pool p
     JOIN nba2k_players n ON n.slug = p.nba2k_ref
  WHERE p."position" IS NOT NULL
    AND p."position" <> 'UNASSIGNED'::text
    AND (p."position" = ANY (ARRAY['PG'::text, 'SG'::text, 'SF'::text, 'PF'::text, 'C'::text]))
    AND (p.pool = ANY (ARRAY['green'::text, 'blue'::text, 'white'::text]))
    AND COALESCE(NULLIF(TRIM(BOTH FROM p.name_override), ''::text), n.name) IS NOT NULL
    AND COALESCE(NULLIF(TRIM(BOTH FROM p.name_override), ''::text), n.name) <> ''::text
    AND COALESCE(p.overall_override, n.overall) >= 75
    AND COALESCE(p.overall_override, n.overall) <= 99;
