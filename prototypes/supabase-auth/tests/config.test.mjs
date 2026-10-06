import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLocalEnv, parseEnv } from "../config.mjs";

test("parseEnv reads dotenv assignments, comments, quotes, and export prefixes", () => {
  assert.deepEqual(parseEnv('\uFEFF# comment\nA=plain\nB="quoted value"\nC=\'single\'\nexport D=value # note\ninvalid line'), {
    A: "plain",
    B: "quoted value",
    C: "single",
    D: "value",
  });
});

test("loadLocalEnv loads local config but preserves process environment values", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "supabase-auth-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, ".env");
  await writeFile(path, "DRAFTP_DEV_SUPABASE_URL=https://xrorluukmizmhizftjwx.supabase.co\nDRAFTP_DEV_SUPABASE_ANON_KEY=local-test-value\n");
  const env = { DRAFTP_DEV_SUPABASE_ANON_KEY: "environment-value" };

  await loadLocalEnv(path, env);

  assert.equal(env.DRAFTP_DEV_SUPABASE_URL, "https://xrorluukmizmhizftjwx.supabase.co");
  assert.equal(env.DRAFTP_DEV_SUPABASE_ANON_KEY, "environment-value");
});

test("loadLocalEnv tolerates a missing local file", async () => {
  await assert.doesNotReject(loadLocalEnv(join(tmpdir(), "missing-supabase-auth-env-file"), {}));
});
