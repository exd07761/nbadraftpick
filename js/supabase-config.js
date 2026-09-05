/**
 * supabase-config.js
 *
 * Supabase project configuration and client initialization — the
 * Supabase-side counterpart to js/firebase-config.js.
 *
 * PHASE 6.1 STATUS: this file is purely additive infrastructure. It is
 * NOT yet loaded by index.html or admin.html, and nothing in js/data.js
 * or anywhere else references it. Creating it does not change any
 * application behavior — the app continues to run entirely on Firebase
 * until a later Phase 6 step explicitly wires this in.
 *
 * Requires the Supabase JS client library (loaded via a classic
 * <script> tag from a CDN — see the "Next step" note below — matching
 * this app's existing no-bundler, global-script convention rather than
 * ES modules, exactly like js/firebase-config.js does for Firebase).
 *
 * The values below are this project's public URL and anon (publishable)
 * key — safe to ship in client-side code by design, the same way
 * FIREBASE_CONFIG's apiKey already is. All real authorization happens
 * server-side: RLS policies plus each RPC's own require_commissioner()
 * check, never anything client-side.
 *
 * NEXT STEP (not done in this file, requires separate approval):
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="js/supabase-config.js"></script>
 * added to index.html / admin.html, load order: Supabase SDK ->
 * supabase-config.js -> (existing Firebase scripts, unchanged) ->
 * data.js -> everything else. Firebase's own script tags and load order
 * are untouched by this or that future step — both stacks coexist until
 * Firebase is explicitly retired at the end of Phase 6.
 */

const SUPABASE_URL = "https://hsazfgivpxmdueyxmjpp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYXpmZ2l2cHhtZHVleXhtanBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyMjA5MDQsImV4cCI6MjEwMzc5NjkwNH0.ysDhn-uzcFKQKLN_6XOkIn0tGoU0mIEs2slO45AdAO4";

// `supabase` here refers to the global the CDN script above attaches
// (window.supabase from @supabase/supabase-js) — NOT the client instance
// itself. We immediately shadow that name with our own instance below,
// mirroring how firebase-config.js's `firebase.initializeApp(...)` call
// works against the `firebase` global.
const SupabaseClient = (() => {
  if (typeof window === "undefined" || !window.supabase) {
    // The CDN script tag hasn't been added yet (see NEXT STEP above) —
    // fail loudly rather than silently exporting `null` and letting a
    // much-later, confusing error surface instead.
    console.error(
      "[SupabaseClient] window.supabase is not defined — the Supabase JS " +
        "SDK <script> tag must load before supabase-config.js."
    );
    return null;
  }
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();
