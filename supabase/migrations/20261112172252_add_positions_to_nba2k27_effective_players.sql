-- Append the ordered source positions for public Draft Pool secondary-position display.
-- Existing view columns, joins, filters, ownership, and grants are retained.
CREATE OR REPLACE VIEW public.nba2k27_effective_players
WITH (security_invoker = true)
AS
 SELECT 'p27live_'::text || p.nba2k_ref AS live_id,
    p.nba2k_ref,
    COALESCE(NULLIF(TRIM(BOTH FROM p.name_override), ''::text), n.name) AS name,
    COALESCE(p.overall_override, n.overall) AS overall,
    p."position",
    p.pool,
    NULLIF(TRIM(BOTH FROM p.variant_group_id), ''::text) AS variant_group_id,
    n.positions
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
