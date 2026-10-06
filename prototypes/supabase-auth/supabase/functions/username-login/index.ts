import { createClient } from "npm:@supabase/supabase-js@2";
import {
  createFixedWindowLimiter,
  GENERIC_AUTH_FAILURE,
  usernameLogin,
  usernameRecovery,
} from "../_shared/auth-core.mjs";

const PROJECT_URL = "https://xrorluukmizmhizftjwx.supabase.co";
const allowedOrigin = Deno.env.get("DRAFTP_DEV_APP_ORIGIN") ?? "http://localhost:4173";
const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resetRedirect = Deno.env.get("DRAFTP_DEV_PASSWORD_RESET_REDIRECT") ?? "";

if (url !== PROJECT_URL) {
  throw new Error("username-login prototype must run only in the approved development project");
}
if (!anonKey || !serviceKey) {
  throw new Error("username-login prototype requires its development project secrets");
}

const service = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});
const limiter = createFixedWindowLimiter({ limit: 8, windowMs: 15 * 60_000 });

const genericRecoveryMessage = "If the account is eligible, recovery instructions will be sent to its verified email.";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clientIp(req: Request) {
  // Supabase's gateway sets this header. Do not trust arbitrary forwarding
  // headers supplied by the caller.
  return req.headers.get("x-real-ip") ?? "unknown";
}

async function lookupAccount(usernameNormalized: string) {
  const { data, error } = await service.from("username_accounts")
    .select("user_id")
    .eq("username_normalized", usernameNormalized)
    .maybeSingle();
  if (error) throw error;
  if (!data?.user_id) return null;
  const { data: result, error: userError } = await service.auth.admin.getUserById(data.user_id);
  if (userError || !result?.user?.email) return null;
  return {
    userId: data.user_id as string,
    email: result.user.email,
    emailConfirmed: Boolean(result.user.email_confirmed_at),
  };
}

function dummyEmail(normalized: string) {
  // Stable non-routable identity: it can never be a real recovery destination.
  const encoded = btoa(normalized).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  return `unknown-${encoded}@draftp.invalid`;
}

async function authenticate(email: string, password: string) {
  // Send credentials only to Supabase Auth over HTTPS. Never log request or
  // response bodies; never persist the password in DraftP storage.
  const response = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
  const session = await response.json();
  return { session, userId: session?.user?.id };
}

async function lookupAdmin(userId: string) {
  const { data, error } = await service.from("admin_users")
    .select("role, active")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function sendRecovery(email: string) {
  let redirectOrigin = "";
  try { redirectOrigin = new URL(resetRedirect).origin; } catch { /* checked below */ }
  if (!resetRedirect || redirectOrigin !== allowedOrigin) {
    throw new Error("development password recovery redirect is not configured");
  }
  const { error } = await service.auth.resetPasswordForEmail(email, { redirectTo: resetRedirect });
  if (error) throw error;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (origin && origin !== allowedOrigin) return json(403, { error: "Request denied." });
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  const ip = clientIp(req);
  if (!limiter.allow(ip)) return json(429, { error: GENERIC_AUTH_FAILURE });

  let body: { action?: string; username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid request." });
  }

  if (body.action === "recovery") {
    const result = await usernameRecovery(body.username ?? "", { lookupAccount, dummyEmail, sendRecovery });
    return json(result.status, { message: result.message || genericRecoveryMessage });
  }

  const result = await usernameLogin(
    { username: body.username ?? "", password: body.password ?? "" },
    { lookupAccount, dummyEmail, authenticate, lookupAdmin },
  );
  if (!result.ok) return json(result.status, { error: result.message });
  return json(200, { ...result.session, account: result.account });
});
