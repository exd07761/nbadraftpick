export const ALLOWED_ROLES = new Set([
  "superadmin",
  "league_manager",
  "schedule_manager",
  "scorekeeper",
]);

export const GENERIC_AUTH_FAILURE = "Username or password is incorrect, or this account is inactive.";

export function normalizeUsername(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,29}$/.test(normalized) ? normalized : null;
}

export function resolveRole(record) {
  if (!record || record.active !== true || !ALLOWED_ROLES.has(record.role)) return null;
  return { role: record.role, active: true };
}

export function publicAccount({ userId, username, role }) {
  return { userId, username, role, active: true };
}

export function createFixedWindowLimiter({ limit = 8, windowMs = 15 * 60_000, now = Date.now } = {}) {
  const buckets = new Map();
  return {
    allow(key) {
      const current = now();
      const bucket = buckets.get(key);
      if (!bucket || current - bucket.startedAt >= windowMs) {
        buckets.set(key, { startedAt: current, count: 1 });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
  };
}

/** Shared login orchestration used by the Edge Function and unit tests. */
export async function usernameLogin({ username, password }, deps) {
  const normalized = normalizeUsername(username);
  if (!normalized || typeof password !== "string" || password.length < 1 || password.length > 1024) {
    return { ok: false, status: 401, message: GENERIC_AUTH_FAILURE };
  }

  let account = null;
  try {
    account = await deps.lookupAccount(normalized);
  } catch {
    return { ok: false, status: 503, message: "Login is temporarily unavailable. Please try again." };
  }

  let authResult;
  try {
    // Unknown names use a deterministic, non-routable identity. Supabase Auth
    // still handles the password attempt and applies its own endpoint limits.
    authResult = await deps.authenticate(account?.email ?? deps.dummyEmail(normalized), password);
  } catch {
    return { ok: false, status: 401, message: GENERIC_AUTH_FAILURE };
  }

  if (!account || !authResult?.session || authResult.userId !== account.userId) {
    return { ok: false, status: 401, message: GENERIC_AUTH_FAILURE };
  }

  let roleRecord;
  try {
    roleRecord = await deps.lookupAdmin(account.userId);
  } catch {
    return { ok: false, status: 503, message: "Login is temporarily unavailable. Please try again." };
  }
  const role = resolveRole(roleRecord);
  if (!role) return { ok: false, status: 401, message: GENERIC_AUTH_FAILURE };

  const { access_token, refresh_token, expires_in, token_type } = authResult.session;
  if (!access_token || !refresh_token) {
    return { ok: false, status: 401, message: GENERIC_AUTH_FAILURE };
  }

  return {
    ok: true,
    status: 200,
    session: { access_token, refresh_token, expires_in, token_type: token_type || "bearer" },
    account: publicAccount({ userId: account.userId, username: normalized, role: role.role }),
  };
}

export async function usernameRecovery(username, deps) {
  const generic = "If the account is eligible, recovery instructions will be sent to its verified email.";
  const normalized = normalizeUsername(username);
  if (!normalized) return { status: 202, message: generic };
  try {
    const account = await deps.lookupAccount(normalized);
    if (account?.email && account.emailConfirmed) await deps.sendRecovery(account.email);
    else await deps.sendRecovery(deps.dummyEmail(normalized));
  } catch {
    // Uniform response avoids revealing whether a name exists.
  }
  return { status: 202, message: generic };
}
