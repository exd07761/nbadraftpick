/**
 * auth-boundary.js
 *
 * PURPOSE:
 * This module defines the authentication boundary between public read access
 * and authenticated admin write access.
 *
 * STATUS: Real authentication via Firebase Authentication (email/password).
 * This replaces the Phase 1 in-memory stub — there is no more
 * `devUnlock()`, and login no longer accepts arbitrary input.
 *
 * Requires js/firebase-config.js to have already run (this file uses the
 * `firebase` global it sets up) — load order: firebase-config.js →
 * data.js → auth-boundary.js → everything else.
 *
 * This app has exactly one admin role (the commissioner) and no
 * per-user permission system — there is one Firebase Auth account (or a
 * small handful, if more than one person needs commissioner access), and
 * "signed in" IS "authenticated as admin". Real per-role authorization,
 * if ever needed, would layer on top of this via Firestore's
 * `request.auth.uid` in firestore.rules, not here.
 *
 * The actual enforcement boundary against bad writes is firestore.rules
 * (`allow write: if request.auth != null`) — requireAuth() below is a
 * fast client-side guard so the UI fails clearly before ever attempting a
 * write that Firestore would reject anyway.
 *
 * Creating the commissioner's login: Firebase Console → Authentication →
 * Sign-in method → enable "Email/Password" → Users tab → Add user. See
 * FIREBASE_SETUP.md.
 */

const AuthBoundary = (() => {
  let _currentUser = null; // { uid, username } — username holds the account's email
  let _authStateKnown = false;
  const authStateListeners = [];

  firebase.auth().onAuthStateChanged((user) => {
    _currentUser = user ? { uid: user.uid, username: user.email, role: "admin" } : null;
    _authStateKnown = true;
    authStateListeners.forEach((fn) => {
      try { fn(_currentUser); } catch (e) { console.error("[AuthBoundary] auth-state listener error:", e); }
    });
  });

  function friendlyAuthError(err) {
    switch (err.code) {
      case "auth/invalid-email":
        return "That doesn't look like a valid email address.";
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "Incorrect email or password.";
      case "auth/too-many-requests":
        return "Too many attempts — please wait a moment and try again.";
      case "auth/network-request-failed":
        return "Network error — check your connection and try again.";
      default:
        return err.message || "Login failed.";
    }
  }

  return {
    /**
     * Sign in with a Firebase Auth email/password account (created in the
     * Firebase Console — see FIREBASE_SETUP.md). The admin login form's
     * "username" field is the account's email address.
     */
    async login(email, password) {
      if (!email || !password) {
        return { ok: false, error: "Email and password required." };
      }
      try {
        await firebase.auth().signInWithEmailAndPassword(email, password);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: friendlyAuthError(err) };
      }
    },

    async logout() {
      await firebase.auth().signOut();
    },

    isAuthenticated() {
      return !!_currentUser;
    },

    getCurrentUser() {
      return _currentUser ? { ..._currentUser } : null;
    },

    /**
     * Resolves once Firebase has determined the REAL initial auth state on
     * page load (signed in or not — Firebase persists sessions across
     * reloads by default, unlike the old Phase 1 stub, which always forced
     * a fresh login every reload). admin.js awaits this before deciding
     * whether to show the login screen or go straight to the admin shell.
     */
    ready() {
      return new Promise((resolve) => {
        if (_authStateKnown) return resolve(this.isAuthenticated());
        const unsub = firebase.auth().onAuthStateChanged((user) => {
          unsub();
          resolve(!!user);
        });
      });
    },

    /** Fires on every subsequent sign-in/sign-out (not the initial load — see ready()). */
    onAuthStateChanged(fn) {
      authStateListeners.push(fn);
    },

    /**
     * Guard function. Wrap all AdminActions calls with this. The real
     * enforcement is firestore.rules — this is a fast client-side check so
     * the UI fails with a clear message instead of a raw Firestore
     * permission-denied error.
     */
    requireAuth() {
      if (!_currentUser) {
        throw new Error("UNAUTHORIZED: Admin authentication required.");
      }
    },
  };
})();
