import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ROLES,
  GENERIC_AUTH_FAILURE,
  createFixedWindowLimiter,
  normalizeUsername,
  publicAccount,
  resolveRole,
  usernameLogin,
  usernameRecovery,
} from "../supabase/functions/_shared/auth-core.mjs";

test("username normalization is trimmed and case-insensitive", () => {
  assert.equal(normalizeUsername("  DraftPTest  "), "draftptest");
  assert.equal(normalizeUsername("ＤｒａｆｔｐＴｅｓｔ"), "draftptest");
});

test("username rules reject short, long, whitespace and unsafe punctuation", () => {
  assert.equal(normalizeUsername("ab"), null);
  assert.equal(normalizeUsername("a".repeat(31)), null);
  assert.equal(normalizeUsername("draftp test"), null);
  assert.equal(normalizeUsername("../draftp"), null);
});

test("role resolver fails closed for missing, inactive, and unknown roles", () => {
  assert.equal(resolveRole(null), null);
  assert.equal(resolveRole({ role: "scorekeeper", active: false }), null);
  assert.equal(resolveRole({ role: "owner", active: true }), null);
  assert.deepEqual([...ALLOWED_ROLES].sort(), ["league_manager", "schedule_manager", "scorekeeper", "superadmin"]);
});

test("username login authenticates mapped user and omits email from response", async () => {
  const result = await usernameLogin({ username: "DraftPTest", password: "test-only" }, {
    lookupAccount: async (u) => { assert.equal(u, "draftptest"); return { userId: "user-1", email: "private@example.test" }; },
    authenticate: async (email, password) => {
      assert.equal(email, "private@example.test"); assert.equal(password, "test-only");
      return { userId: "user-1", session: { access_token: "access", refresh_token: "refresh", expires_in: 3600 } };
    },
    lookupAdmin: async (id) => { assert.equal(id, "user-1"); return { role: "scorekeeper", active: true }; },
    dummyEmail: () => "dummy@draftp.invalid",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.account, publicAccount({ userId: "user-1", username: "draftptest", role: "scorekeeper" }));
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
});

test("unknown username performs a dummy Auth attempt and returns generic failure", async () => {
  let attempted = false;
  const result = await usernameLogin({ username: "unknownone", password: "x" }, {
    lookupAccount: async () => null,
    authenticate: async (email) => { attempted = true; assert.match(email, /@draftp\.invalid$/); return null; },
    lookupAdmin: async () => { throw new Error("must not run"); },
    dummyEmail: (u) => `${u}@draftp.invalid`,
  });
  assert.equal(attempted, true);
  assert.deepEqual(result, { ok: false, status: 401, message: GENERIC_AUTH_FAILURE });
});

test("wrong password, missing role, inactive role, and unknown role all deny login", async (t) => {
  for (const [name, auth, admin] of [
    ["wrong password", null, { role: "scorekeeper", active: true }],
    ["missing role", { userId: "user-1", session: { access_token: "a", refresh_token: "r" } }, null],
    ["inactive role", { userId: "user-1", session: { access_token: "a", refresh_token: "r" } }, { role: "scorekeeper", active: false }],
    ["unknown role", { userId: "user-1", session: { access_token: "a", refresh_token: "r" } }, { role: "other", active: true }],
  ]) {
    await t.test(name, async () => {
      const result = await usernameLogin({ username: "draftptest", password: "x" }, {
        lookupAccount: async () => ({ userId: "user-1", email: "hidden@example.test" }),
        authenticate: async () => auth,
        lookupAdmin: async () => admin,
        dummyEmail: () => "dummy@draftp.invalid",
      });
      assert.equal(result.ok, false);
      assert.equal(result.message, GENERIC_AUTH_FAILURE);
    });
  }
});

test("lookup failures do not expose a username or email", async () => {
  const result = await usernameLogin({ username: "draftptest", password: "x" }, {
    lookupAccount: async () => { throw new Error("database internal detail"); },
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("database internal detail"), false);
});

test("fixed-window rate limiter blocks repeated attempts and resets after the window", () => {
  let time = 1000;
  const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 100, now: () => time });
  assert.equal(limiter.allow("ip"), true);
  assert.equal(limiter.allow("ip"), true);
  assert.equal(limiter.allow("ip"), false);
  time += 101;
  assert.equal(limiter.allow("ip"), true);
});

test("recovery always returns a generic response and never returns the email", async () => {
  let target = "";
  const result = await usernameRecovery("DRAFTPTEST", {
    lookupAccount: async () => ({ email: "private@example.test", emailConfirmed: true }),
    sendRecovery: async (email) => { target = email; },
    dummyEmail: () => "dummy@draftp.invalid",
  });
  assert.equal(result.status, 202);
  assert.equal(target, "private@example.test");
  assert.equal(JSON.stringify(result).includes(target), false);
});

test("recovery uses a dummy identity for an unknown username", async () => {
  let target = "";
  const result = await usernameRecovery("unknownone", {
    lookupAccount: async () => null,
    sendRecovery: async (email) => { target = email; },
    dummyEmail: () => "dummy@draftp.invalid",
  });
  assert.equal(result.status, 202);
  assert.equal(target, "dummy@draftp.invalid");
});
