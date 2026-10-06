-- Read-only preflight for the isolated development Supabase project.
-- Run only against xrorluukmizmhizftjwx. This script does not read email,
-- password, token, or row payload values and performs no writes.
DO $$
DECLARE
  missing_columns text[];
  table_rls boolean;
BEGIN
  IF current_database() IS NULL THEN
    RAISE EXCEPTION 'Could not identify database';
  END IF;

  SELECT array_agg(expected.column_name)
    INTO missing_columns
    FROM (VALUES
      ('username_accounts', 'user_id'),
      ('username_accounts', 'username_normalized'),
      ('admin_users', 'user_id'),
      ('admin_users', 'role'),
      ('admin_users', 'active')
    ) AS expected(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = expected.table_name
        AND c.column_name = expected.column_name
   );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Missing expected columns: %', array_to_string(missing_columns, ', ');
  END IF;

  SELECT c.relrowsecurity
    INTO table_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'username_accounts';
  IF coalesce(table_rls, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'RLS must be enabled on public.username_accounts';
  END IF;

  SELECT c.relrowsecurity
    INTO table_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'admin_users';
  IF coalesce(table_rls, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'RLS must be enabled on public.admin_users';
  END IF;

  IF has_table_privilege('anon', 'public.username_accounts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.username_accounts', 'SELECT') THEN
    RAISE EXCEPTION 'anon/authenticated have direct SELECT grants on username_accounts';
  END IF;

  IF has_table_privilege('anon', 'public.admin_users', 'SELECT') THEN
    RAISE EXCEPTION 'anon has a direct SELECT grant on admin_users';
  END IF;

  IF has_table_privilege('anon', 'public.admin_users', 'INSERT')
     OR has_table_privilege('anon', 'public.admin_users', 'UPDATE')
     OR has_table_privilege('anon', 'public.admin_users', 'DELETE')
     OR has_table_privilege('authenticated', 'public.admin_users', 'INSERT')
     OR has_table_privilege('authenticated', 'public.admin_users', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.admin_users', 'DELETE') THEN
    RAISE EXCEPTION 'anon/authenticated have direct write grants on admin_users';
  END IF;

  IF has_table_privilege('anon', 'public.username_accounts', 'INSERT')
     OR has_table_privilege('anon', 'public.username_accounts', 'UPDATE')
     OR has_table_privilege('anon', 'public.username_accounts', 'DELETE')
     OR has_table_privilege('authenticated', 'public.username_accounts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.username_accounts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.username_accounts', 'DELETE') THEN
    RAISE EXCEPTION 'anon/authenticated have direct write grants on username_accounts';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'username_accounts'
       AND indexdef ILIKE '%UNIQUE%'
       AND indexdef ILIKE '%lower%username_normalized%'
  ) THEN
    RAISE EXCEPTION 'A case-insensitive unique index is required on username_accounts.username_normalized';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.admin_users', 'SELECT')
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = 'admin_users'
          AND p.cmd IN ('SELECT', 'ALL')
          AND p.roles @> ARRAY['authenticated']::name[]
          AND p.qual ILIKE '%auth.uid%'
          AND p.qual ILIKE '%user_id%'
     ) THEN
    RAISE EXCEPTION 'authenticated needs an RLS-protected self-read policy on admin_users';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename = 'username_accounts'
       AND p.cmd IN ('SELECT', 'ALL')
  ) THEN
    RAISE EXCEPTION 'username_accounts must not have a public/authenticated read policy';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename IN ('admin_users', 'username_accounts')
       AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       AND (p.roles && ARRAY['anon', 'authenticated', 'public']::name[])
  ) THEN
    RAISE EXCEPTION 'A user-facing write policy exists on a prototype authorization table';
  END IF;

  RAISE NOTICE 'Schema/RLS preflight passed. Review the policy catalog manually to confirm admin_users self-read and no username_accounts read policy.';
END;
$$;

-- Policy inventory only; outputs predicates, not row values.
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('username_accounts', 'admin_users')
 ORDER BY tablename, policyname;
