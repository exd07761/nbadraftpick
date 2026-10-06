# DraftP Supabase Auth prototype

This is an isolated, non-production prototype. It is pinned to Supabase project `xrorluukmizmhizftjwx` and is not loaded by `admin.html`, `index.html`, or any production script.

## Development configuration

The local server loads `prototypes/supabase-auth/.env` automatically. Create it once from the checked-in example:

```powershell
Copy-Item prototypes/supabase-auth/.env.example prototypes/supabase-auth/.env
notepad prototypes/supabase-auth/.env
```

Keep the development publishable key in that local `.env` file. It is ignored by Git. The checked-in example has no key. You can also provide these variables in the launching environment; existing process environment values take precedence over `.env`:

- `DRAFTP_DEV_SUPABASE_URL=https://xrorluukmizmhizftjwx.supabase.co`
- `DRAFTP_DEV_SUPABASE_ANON_KEY=<development publishable key>`

The Edge Function additionally needs Supabase's development-only `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`, plus:

- `DRAFTP_DEV_APP_ORIGIN=http://localhost:4173`
- `DRAFTP_DEV_PASSWORD_RESET_REDIRECT=http://localhost:4173/reset-password`

Never place a service-role key in the browser, a checked-in file, or logs. The local server exposes only the development URL and publishable key. It refuses to serve runtime configuration if the URL differs from the fixed development project.

Run the local UI from the repository root with:

```powershell
node prototypes/supabase-auth/server.mjs
```

Then open `http://localhost:4173`. The server reads the local `.env` before starting and never logs its contents. Only the URL and publishable key are exposed to this isolated prototype; do not put a service-role key in this file.

## Username login design

Supabase Auth password authentication uses email or phone, not an arbitrary username. The browser sends the username and password only to the development Edge Function. The function normalizes the username, looks up `username_accounts.username_normalized` with the service-role client, obtains the associated Auth user's email internally, and submits the password to Supabase Auth's password-token endpoint over HTTPS. It returns the Supabase session tokens and a minimal DraftP account object without returning email. No password is stored or logged by DraftP.

Unknown usernames use a deterministic `.invalid` dummy address and still take the Supabase Auth password-verification path. Responses for unknown names, wrong passwords, inactive accounts, and missing/unknown roles are generic. The function also applies a small in-memory per-IP limit; this is suitable only for a prototype because Edge Function instances do not share memory. A production username endpoint needs a shared durable rate limiter and monitoring.

The Edge Function checks `admin_users` after password verification and returns a session only when the authenticated Auth user ID matches the mapping and has an active, recognized role. The browser then calls `auth.setSession()` and independently resolves its own role through RLS-protected `admin_users` access. Supabase JS persists and refreshes the session. Sign-out calls Supabase Auth's `signOut()`.

Recovery accepts a username only. The function resolves a verified email server-side and calls Supabase Auth's recovery flow; it returns the same generic response for unknown and known usernames. The Edge Function will send a recovery email if that action is used. No recovery request was sent as part of this work. A recovery page must be added at the configured redirect before exercising the complete password-reset flow.

## Database assumptions

The supplied development database is expected to contain:

- `public.username_accounts(user_id uuid, username_normalized text)` with case-insensitive/normalized uniqueness and no public read policy.
- `public.admin_users(user_id uuid, role text, active boolean)` with a self-read policy (`user_id = auth.uid()`) and no user-write policy.

The user supplied for the prototype is Auth user `d05ab9ac-e29a-4388-9d23-089189ec47de`, username `draftptest`, role `scorekeeper`. The Edge Function does not provision users or edit roles.

The schema and RLS were not inspectable from this execution environment. Before deploying the function, run `verification/check-schema-and-rls.sql` in the development project's SQL editor and verify the reported columns and policies. In particular, ensure authenticated users cannot read `username_accounts` or insert/update/delete either table. The source code does not treat the user's statement that the database is prepared as proof of those policies.

## Edge Function

Deploy only to the supplied development ref after its schema and secrets are verified:

```text
supabase --workdir prototypes/supabase-auth functions deploy username-login --project-ref xrorluukmizmhizftjwx
```

The Supabase CLI is not currently installed or authenticated in the task environment, so deployment and live login/session tests were not performed here. Confirm function secret values through the development dashboard/secret manager, not source code.

## Local tests

```text
node --test prototypes/supabase-auth/tests/auth-core.test.mjs
```

These tests cover normalization, case-insensitive behavior, generic failure handling, role denial, recovery response behavior, and rate limiting. They do not replace live database/RLS tests.
