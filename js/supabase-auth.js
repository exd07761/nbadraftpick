/**
 * supabase-auth.js
 *
 * Supabase Auth bridge for DraftP.
 *
 * PHASE 6 AUTH:
 * - Adds Supabase Auth without replacing Firebase Auth.
 * - Firebase remains the existing application authentication system.
 * - This module only manages the Supabase Auth session.
 *
 * Required load order:
 *
 *   Supabase JS SDK
 *   ↓
 *   supabase-config.js
 *   ↓
 *   supabase-auth.js
 *
 * Do NOT load this before supabase-config.js.
 */

const SupabaseAuth = (() => {
  if (typeof SupabaseClient === "undefined" || !SupabaseClient) {
    console.error(
      "[SupabaseAuth] SupabaseClient is not available. " +
      "Load supabase-config.js before supabase-auth.js."
    );

    return null;
  }

  /**
   * Sign in with email/password.
   *
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{data: object|null, error: object|null}>}
   */
  async function signIn(email, password) {
    const { data, error } =
      await SupabaseClient.auth.signInWithPassword({
        email,
        password
      });

    if (error) {
      console.error("[SupabaseAuth] Sign-in failed:", error);
    }

    return { data, error };
  }

  /**
   * Sign out the current Supabase Auth session.
   *
   * @returns {Promise<{error: object|null}>}
   */
  async function signOut() {
    const { error } =
      await SupabaseClient.auth.signOut();

    if (error) {
      console.error("[SupabaseAuth] Sign-out failed:", error);
    }

    return { error };
  }

  /**
   * Get the current Supabase Auth session.
   *
   * @returns {Promise<{session: object|null, error: object|null}>}
   */
  async function getSession() {
    const { data, error } =
      await SupabaseClient.auth.getSession();

    if (error) {
      console.error(
        "[SupabaseAuth] Failed to get session:",
        error
      );
    }

    return {
      session: data?.session ?? null,
      error
    };
  }

  /**
   * Get the currently authenticated Supabase user.
   *
   * @returns {Promise<{user: object|null, error: object|null}>}
   */
  async function getCurrentUser() {
    const { data, error } =
      await SupabaseClient.auth.getUser();

    if (error) {
      // "Auth session missing" is a normal state when nobody
      // is signed in, so don't treat it as a fatal application error.
      if (error.message !== "Auth session missing!") {
        console.error(
          "[SupabaseAuth] Failed to get user:",
          error
        );
      }

      return {
        user: null,
        error
      };
    }

    return {
      user: data?.user ?? null,
      error: null
    };
  }

  /**
   * Subscribe to Supabase Auth state changes.
   *
   * @param {Function} callback
   * @returns {{data: object|null}}
   */
  function onAuthStateChange(callback) {
    if (typeof callback !== "function") {
      throw new TypeError(
        "[SupabaseAuth] onAuthStateChange requires a callback."
      );
    }

    return SupabaseClient.auth.onAuthStateChange(
      (event, session) => {
        callback(event, session);
      }
    );
  }

  return Object.freeze({
    signIn,
    signOut,
    getSession,
    getCurrentUser,
    onAuthStateChange
  });
})();