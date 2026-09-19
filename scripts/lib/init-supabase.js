/**
 * scripts/lib/init-supabase.js
 *
 * Shared, secure Supabase credential resolution for server-side scripts
 * (currently just scripts/import-nba2k27-live-pool.js) — the Supabase
 * counterpart to scripts/lib/init-admin.js's Firebase Admin resolution,
 * following the exact same philosophy (see the Phase 6.7i audit for the
 * full reasoning behind this design):
 *
 *   - Plain process.env variables only. No .env file, no dotenv or other
 *     loader, no new dependency.
 *   - Never hardcodes the service-role key. Never logs, prints, or
 *     otherwise exposes its value — not even in an error message.
 *   - SUPABASE_URL is NOT a secret (it's already shipped to every
 *     browser in js/supabase-config.js), so it may safely default to
 *     this project's known public URL. An env var can still override it
 *     (e.g. to target a different Supabase project).
 *   - SUPABASE_SERVICE_ROLE_KEY IS a secret and has no default. If it's
 *     missing or blank, this fails immediately with a clear, specific
 *     explanation and makes NO network request — mirroring
 *     init-admin.js's "refuses to guess" behavior exactly.
 *
 * This is intentionally narrow: it resolves credentials for one script's
 * one use case, not a generic credential framework.
 */

const DEFAULT_SUPABASE_URL = 'https://hsazfgivpxmdueyxmjpp.supabase.co';

/**
 * Resolves { url, serviceRoleKey } from the environment, or throws with
 * a clear, actionable message (never including any credential value) if
 * the required service-role key is missing/blank.
 */
function initSupabase() {
  const url = (process.env.SUPABASE_URL && process.env.SUPABASE_URL.trim())
    || DEFAULT_SUPABASE_URL;

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey || !serviceRoleKey.trim()) {
    throw new Error(
      '\nERROR: No Supabase service-role credential found.\n\n' +
      'This script refuses to guess — set:\n\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=<your service-role key>\n' +
      '    (from the Supabase dashboard -> Project Settings -> API ->\n' +
      '     service_role secret. NEVER commit this value, paste it into\n' +
      '     chat, or put it in any file tracked by git.)\n\n' +
      '  Optionally also set SUPABASE_URL to override the default\n' +
      `  project URL (${DEFAULT_SUPABASE_URL}).\n`
    );
  }

  return { url, serviceRoleKey: serviceRoleKey.trim() };
}

module.exports = { initSupabase, DEFAULT_SUPABASE_URL };
