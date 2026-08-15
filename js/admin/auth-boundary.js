/**
 * auth-boundary.js
 *
 * PURPOSE:
 * This module defines the authentication boundary between public read access
 * and authenticated admin write access.
 *
 * PHASE 1 STATUS: STUB — No real authentication exists yet.
 *
 * ─── SECURITY NOTICE ──────────────────────────────────────────────────────────
 *
 * There is NO secure authentication in this phase.
 * DO NOT store an admin password in this file.
 * DO NOT trust any localStorage value as proof of identity.
 * DO NOT implement if (password === "hardcodedValue").
 *
 * The admin UI is separated from the public UI at the page level (admin.html),
 * but this is a UX boundary, not a security boundary, until a real backend
 * is implemented.
 *
 * All write operations in AdminActions (data.js) are protected by this guard.
 * In production, this guard checks a real server-issued session token.
 *
 * ─── WHAT THE BACKEND MUST PROVIDE ───────────────────────────────────────────
 *
 * 1. POST /api/auth/login
 *    Body: { username, password }
 *    Response: Set-Cookie with HttpOnly session cookie (or return a JWT)
 *    On success: { ok: true }
 *    On failure: { ok: false, error: "Invalid credentials" }
 *
 * 2. POST /api/auth/logout
 *    Clears the session cookie.
 *
 * 3. GET /api/auth/me
 *    Returns the current authenticated user or 401.
 *    Response: { id, username, role: "admin" } or 401
 *
 * 4. All admin API endpoints must require the session cookie / JWT header
 *    and return 401 if not authenticated.
 *
 * 5. Public read endpoints (GET /api/seasons, /api/players, etc.) require
 *    no authentication.
 *
 * ─── CURRENT PHASE 1 BEHAVIOR ────────────────────────────────────────────────
 *
 * The admin page shows a login form that simulates the future POST /api/auth/login
 * call. In Phase 1, it accepts a session flag stored ONLY in memory (not
 * localStorage) for the duration of the page session.
 *
 * This is explicitly NOT SECURE. It is a UI prototype scaffold.
 * Any user who opens admin.html and knows to call AuthBoundary.devUnlock()
 * in the console can access admin functions.
 *
 * This is acceptable ONLY because:
 * - No real data is at risk (localStorage prototype)
 * - The architecture is already designed for real auth replacement
 * - The public site (index.html) has no write access regardless
 */

const AuthBoundary = (() => {
  // In-memory only. Not persisted. Cleared on page reload.
  // Replace with a check against a real session cookie/JWT in production.
  let _sessionActive = false;
  let _currentUser = null;

  return {
    /**
     * Attempt login. In Phase 1: accepts any non-empty input and sets the
     * in-memory session flag. This MUST be replaced with a real API call.
     *
     * Future implementation:
     *   const res = await fetch('/api/auth/login', {
     *     method: 'POST',
     *     credentials: 'include',
     *     headers: { 'Content-Type': 'application/json' },
     *     body: JSON.stringify({ username, password })
     *   });
     *   return res.json();
     */
    async login(username, password) {
      // ⚠️ PHASE 1 STUB — Replace entirely with real API call
      if (!username || !password) {
        return { ok: false, error: "Username and password required." };
      }
      // TODO: remove this stub and call POST /api/auth/login
      console.warn(
        "[AuthBoundary] PHASE 1 STUB: No real authentication. " +
        "Replace login() with a real API call before production."
      );
      _sessionActive = true;
      _currentUser = { username, role: "admin" };
      return { ok: true };
    },

    logout() {
      _sessionActive = false;
      _currentUser = null;
      // Future: POST /api/auth/logout, clear cookie
    },

    isAuthenticated() {
      return _sessionActive;
    },

    getCurrentUser() {
      return _currentUser ? { ..._currentUser } : null;
    },

    /**
     * Guard function. Wrap all AdminActions calls with this.
     * In production this also verifies the server-side session.
     */
    requireAuth() {
      if (!_sessionActive) {
        throw new Error("UNAUTHORIZED: Admin authentication required.");
      }
    },

    /**
     * Dev convenience only. Not for production.
     * Allows testing admin UI without a backend.
     */
    devUnlock() {
      console.warn(
        "[AuthBoundary] devUnlock() called. This must not exist in production."
      );
      _sessionActive = true;
      _currentUser = { username: "dev", role: "admin" };
    },
  };
})();
