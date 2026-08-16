/**
 * firebase-config.js
 *
 * Firebase project configuration and SDK initialization.
 *
 * MUST load before js/data.js and js/admin/auth-boundary.js — both use the
 * `firebase` global this file sets up (via the Firebase "compat" SDK, which
 * keeps the classic `firebase.xxx()` global API this whole app already uses
 * everywhere else — no ES modules / bundler needed).
 *
 * IMPORTANT: this file is loaded as a plain classic <script> tag (see
 * admin.html / index.html), NOT <script type="module">. Do not paste in
 * Firebase Console's default "Add Firebase to your app" snippet as-is —
 * that snippet uses `import { initializeApp } from "firebase/app"`, which
 * only works inside an ES module and throws
 * "Cannot use import statement outside a module" here, which breaks
 * everything that loads after it (this file loads first).
 */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAje3Y0MexcCT9kjjQtmmIa7a8U4yJkcSQ",
  authDomain: "nbadraftpick.firebaseapp.com",
  projectId: "nbadraftpick",
  storageBucket: "nbadraftpick.firebasestorage.app",
  messagingSenderId: "270292612223",
  appId: "1:270292612223:web:70deed385ab467b50afb4a",
};

firebase.initializeApp(FIREBASE_CONFIG);

// IMPORTANT — do not remove: this app's data layer (Phase 5's Joker
// designation, specifically) writes an explicit `undefined` value for a
// field on non-Joker roster entries, matching how JSON.stringify has
// always silently dropped it under the old localStorage storage. Without
// this setting, Firestore's default behavior is to THROW on any undefined
// field anywhere in the object graph — this restores the original
// (silently-drop-it) behavior instead, so nothing in data.js had to change
// to accommodate Firestore's stricter default.
firebase.firestore().settings({ ignoreUndefinedProperties: true });
