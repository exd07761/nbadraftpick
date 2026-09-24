-- Phase 6.10 grant hardening: remove table-level write privileges from
-- anon/authenticated that the application does not use.
--
-- WHY: a live read-only audit (Supabase project hsazfgivpxmdueyxmjpp)
-- confirmed that INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and
-- TRIGGER are currently granted to both anon and authenticated on every
-- application table in public except commissioners. Every real write
-- path in this app goes through SECURITY DEFINER RPCs (add_participant,
-- make_draft_pick, record_match_result, commit_trade, update_player,
-- etc.), which run as their owner and enforce require_commissioner()
-- internally -- none of them depend on the caller holding direct
-- table-level write grants. A repo-wide check of every browser-loaded
-- file under js/ found zero direct .insert()/.update()/.delete()/
-- .upsert() calls against any table, and js/admin/*.js (the
-- commissioner/admin UI) does not reference Supabase at all yet. RLS
-- currently has no INSERT/UPDATE/DELETE policies on any table, so these
-- grants are not presently exploitable -- but leaving them in place
-- means a single future policy mistake (e.g. an overly broad USING/
-- WITH CHECK clause) would be the only thing standing between anon and
-- full table writes, with no grant-level backstop. This migration
-- closes that gap without changing anything the app currently relies
-- on.
--
-- SCOPE -- deliberately minimal, per the Phase 6.10 audit that
-- identified this as sufficient:
--   - No RLS policy added, changed, or dropped. public_read /
--     conditional_read policies are untouched; they already govern
--     what anon/authenticated can SELECT and are not affected by this
--     REVOKE/GRANT pair.
--   - No SECURITY DEFINER function or RPC modified. All existing
--     write RPCs continue to work unchanged -- they execute as their
--     owner (postgres), which bypasses RLS and is not named in this
--     migration.
--   - commissioners is not modified. It already has no anon/
--     authenticated grants of any kind (confirmed by the same audit),
--     so it is unaffected by this statement either way.
--   - No ALTER DEFAULT PRIVILEGES. This migration only affects tables
--     that exist in public at the time it runs; privileges on any
--     table created after this migration are out of scope here and
--     will be handled separately if needed.
--   - No other schema, security, or data change of any kind.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON ALL TABLES IN SCHEMA public
FROM anon, authenticated;

-- Re-affirm public reads explicitly, since a bare REVOKE above touches
-- only the six listed privileges and does not remove SELECT -- this
-- GRANT is not compensating for anything the REVOKE took away, it is
-- making the intended end state explicit rather than implicit.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
