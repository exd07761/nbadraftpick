-- Phase 8.6 RPC tests. Run against a THROWAWAY local Postgres only (creates stub schema).
\set ON_ERROR_STOP on
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
-- STUB SCHEMA (assumption: verify against real schema)
CREATE TABLE public.nba2k_players (slug text PRIMARY KEY, team_type text);
CREATE TABLE public.nba2k27_pool (
  nba2k_ref text PRIMARY KEY REFERENCES public.nba2k_players(slug),
  pool text NOT NULL, position text, selected_at timestamptz, updated_at timestamptz,
  extra_note text, other_flag boolean DEFAULT false);
CREATE FUNCTION public.require_commissioner() RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF coalesce(current_setting('app.is_commissioner', true),'') <> 'on' THEN
  RAISE EXCEPTION 'commissioner required' USING ERRCODE='42501'; END IF; END $$;
\i supabase/migrations/20261002120000_phase8_6_nba2k27_pool_initialize_rpc.sql

CREATE TEMP TABLE results(n int, name text, ok boolean);
CREATE FUNCTION pg_temp.expect_err(sql text, frag text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN position(frag in SQLERRM) > 0; END $$;

INSERT INTO nba2k_players(slug) SELECT 'p'||g FROM generate_series(1,10) g;
SET app.is_commissioner = 'on';

-- 1 empty input
INSERT INTO results SELECT 1,'empty input', (initialize_nba2k27_pool('[]')) = '{"created":0,"corrected":0,"unchanged":0,"total":0}'::jsonb;
-- 2 unknown slug
INSERT INTO results SELECT 2,'unknown slug rejected', pg_temp.expect_err($q$select initialize_nba2k27_pool('[{"slug":"nope","pool":"green","position":"UNASSIGNED"}]')$q$,'unknown');
-- 3 invalid pool
INSERT INTO results SELECT 3,'invalid pool rejected', pg_temp.expect_err($q$select initialize_nba2k27_pool('[{"slug":"p1","pool":"red","position":"PG"}]')$q$,'invalid pool');
-- 4 invalid position
INSERT INTO results SELECT 4,'invalid position rejected', pg_temp.expect_err($q$select initialize_nba2k27_pool('[{"slug":"p1","pool":"green","position":"XX"}]')$q$,'invalid position');
-- whole-transaction rejection: valid + invalid => nothing written
INSERT INTO results SELECT 41,'bad item rolls back whole call',
  pg_temp.expect_err($q$select initialize_nba2k27_pool('[{"slug":"p1","pool":"green","position":"PG"},{"slug":"nope","pool":"blue","position":"PG"}]')$q$,'unknown')
  AND (SELECT count(*) FROM nba2k27_pool)=0;
INSERT INTO results SELECT 42,'empty slug / non-array / duplicate rejected',
  pg_temp.expect_err($q$select initialize_nba2k27_pool('[{"slug":"  ","pool":"green","position":"PG"}]')$q$,'non-empty')
  AND pg_temp.expect_err($q$select initialize_nba2k27_pool('{"a":1}')$q$,'JSON array')
  AND pg_temp.expect_err($q$select initialize_nba2k27_pool('[{"slug":"p1","pool":"green","position":"PG"},{"slug":"p1","pool":"blue","position":"PG"}]')$q$,'duplicate');

-- 5 new insert (client isNew ignored/unknown field ignored)
SELECT initialize_nba2k27_pool('[{"slug":"p1","pool":"green","position":"UNASSIGNED","isNew":false,"selected_at":"1999-01-01","extra_note":"hax"}]') AS r \gset
INSERT INTO results SELECT 5,'new row inserted; client isNew/extra fields ignored',
  (:'r'::jsonb->>'created')::int=1 AND (:'r'::jsonb->>'corrected')::int=0
  AND (SELECT pool='green' AND position='UNASSIGNED' AND selected_at>now()-interval '1 minute' AND extra_note IS NULL FROM nba2k27_pool WHERE nba2k_ref='p1');

-- 5b new row uses incoming position; existing row ignores incoming position
SELECT initialize_nba2k27_pool('[{"slug":"p7","pool":"blue","position":"PF"}]') AS r5b \gset
INSERT INTO results SELECT 51,'new row uses incoming position (PF)',
  (:'r5b'::jsonb->>'created')::int=1
  AND (SELECT position='PF' AND pool='blue' FROM nba2k27_pool WHERE nba2k_ref='p7');

-- seed existing rows
INSERT INTO nba2k27_pool(nba2k_ref,pool,position,selected_at,updated_at,extra_note,other_flag) VALUES
 ('p2','blue','PG','2020-01-01','2020-01-02','keep',true),   -- wrong pool, valid pos
 ('p3','blue','BOGUS','2021-01-01','2021-01-02','keep3',true), -- right pool, invalid pos
 ('p4','white',NULL,'2022-01-01','2022-01-02',NULL,false),    -- wrong pool, null pos
 ('p5','green','SF','2023-01-01','2023-01-02','keep5',true),  -- already correct
 ('p9','white','C','2024-01-01','2024-01-02','orphan',false); -- orphan, not in input
SELECT initialize_nba2k27_pool('[
 {"slug":"p2","pool":"green","position":"UNASSIGNED"},
 {"slug":"p3","pool":"blue","position":"UNASSIGNED"},
 {"slug":"p4","pool":"blue","position":"UNASSIGNED"},
 {"slug":"p5","pool":"green","position":"UNASSIGNED"},
 {"slug":"p6","pool":"white","position":"SG"}]') AS r2 \gset
INSERT INTO results SELECT 6,'existing correction counts',
  (:'r2'::jsonb->>'created')::int=1 AND (:'r2'::jsonb->>'corrected')::int=3 AND (:'r2'::jsonb->>'unchanged')::int=1;
INSERT INTO results SELECT 61,'new row p6 in mixed call uses incoming SG',
  (SELECT position='SG' FROM nba2k27_pool WHERE nba2k_ref='p6');
INSERT INTO results SELECT 7,'valid existing position preserved (even if client says UNASSIGNED)',
  (SELECT pool='green' AND position='PG' FROM nba2k27_pool WHERE nba2k_ref='p2');
INSERT INTO results SELECT 8,'invalid/missing existing position -> UNASSIGNED',
  (SELECT position='UNASSIGNED' FROM nba2k27_pool WHERE nba2k_ref='p3')
  AND (SELECT position='UNASSIGNED' AND pool='blue' FROM nba2k27_pool WHERE nba2k_ref='p4');
INSERT INTO results SELECT 9,'selected_at preserved on correction',
  (SELECT selected_at='2020-01-01' FROM nba2k27_pool WHERE nba2k_ref='p2')
  AND (SELECT selected_at='2021-01-01' FROM nba2k27_pool WHERE nba2k_ref='p3')
  AND (SELECT selected_at='2022-01-01' FROM nba2k27_pool WHERE nba2k_ref='p4');
INSERT INTO results SELECT 10,'updated_at refreshed on written rows; untouched on already-correct row',
  (SELECT bool_and(updated_at>now()-interval '1 minute') FROM nba2k27_pool WHERE nba2k_ref IN ('p2','p3','p4','p6'))
  AND (SELECT updated_at='2023-01-02' FROM nba2k27_pool WHERE nba2k_ref='p5');
INSERT INTO results SELECT 11,'orphan row not deleted or modified',
  (SELECT count(*)=1 AND bool_and(pool='white' AND position='C' AND selected_at='2024-01-01' AND updated_at='2024-01-02' AND extra_note='orphan') FROM nba2k27_pool WHERE nba2k_ref='p9');
INSERT INTO results SELECT 12,'only intended columns modified (extra_note/other_flag intact)',
  (SELECT extra_note='keep' AND other_flag FROM nba2k27_pool WHERE nba2k_ref='p2')
  AND (SELECT extra_note='keep3' AND other_flag FROM nba2k27_pool WHERE nba2k_ref='p3')
  AND (SELECT extra_note='keep5' AND other_flag FROM nba2k27_pool WHERE nba2k_ref='p5');

-- 13 authorization
RESET app.is_commissioner;
INSERT INTO results SELECT 13,'non-commissioner rejected before any work',
  pg_temp.expect_err($q$select initialize_nba2k27_pool('[]')$q$,'commissioner required');
INSERT INTO results SELECT 14,'grants: authenticated+service_role yes; anon+PUBLIC no',
  has_function_privilege('authenticated','public.initialize_nba2k27_pool(jsonb)','EXECUTE')
  AND has_function_privilege('service_role','public.initialize_nba2k27_pool(jsonb)','EXECUTE')
  AND NOT has_function_privilege('anon','public.initialize_nba2k27_pool(jsonb)','EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname='initialize_nba2k27_pool' AND a.grantee=0)
  AND (SELECT prosecdef FROM pg_proc WHERE proname='initialize_nba2k27_pool')
  AND (SELECT proconfig::text LIKE '%search_path=public%' FROM pg_proc WHERE proname='initialize_nba2k27_pool');

\echo
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, name FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE NOT ok) AS failures FROM results \gset
\if :failures
  \echo FAILED
  \quit 1
\endif
\echo ALL SQL TESTS PASSED
