import { resolveRole } from "./supabase/functions/_shared/auth-core.mjs";

const status = document.querySelector("#status");
const envEl = document.querySelector("#environment");
const signedOut = document.querySelector("#signedOut");
const signedIn = document.querySelector("#signedIn");
const loginForm = document.querySelector("#loginForm");
const loginButton = loginForm.querySelector("button[type=submit]");
const loginUrl = "https://xrorluukmizmhizftjwx.supabase.co/functions/v1/username-login";
let supabaseClient;

function say(message, kind = "") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setBusy(busy) {
  loginButton.disabled = busy;
  document.querySelector("#recoveryButton").disabled = busy;
}

async function postEdge(body) {
  const response = await fetch(loginUrl, {
    method: "POST",
    headers: {
      apikey: window.DRAFTP_DEV_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json().catch(() => ({})) };
}

async function resolveOwnRole(userId) {
  const { data, error } = await supabaseClient
    .from("admin_users")
    .select("role, active")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Role lookup failed. Check the development RLS policy.");
  return resolveRole(data);
}

function displaySession(session, account) {
  document.querySelector("#userId").textContent = account.userId;
  document.querySelector("#accountUsername").textContent = account.username;
  document.querySelector("#role").textContent = account.role;
  document.querySelector("#active").textContent = String(account.active);
  document.querySelector("#expiry").textContent = session.expires_at
    ? new Date(session.expires_at * 1000).toLocaleString()
    : "managed by Supabase Auth";
  signedOut.classList.add("hidden");
  signedIn.classList.remove("hidden");
}

async function restoreSession() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session) return;
  const { data: userData, error: userError } = await supabaseClient.auth.getUser();
  if (userError || !userData.user) {
    await supabaseClient.auth.signOut();
    return;
  }
  const role = await resolveOwnRole(userData.user.id);
  if (!role) {
    await supabaseClient.auth.signOut();
    say("This account is not active for DraftP.", "error");
    return;
  }
  const username = sessionStorage.getItem("draftp.prototype.username") || "—";
  displaySession(data.session, { userId: userData.user.id, username, role: role.role, active: role.active });
}

async function initialize() {
  const configResponse = await fetch("/runtime-config.json", { cache: "no-store" });
  const config = await configResponse.json();
  if (!configResponse.ok || config.projectRef !== "xrorluukmizmhizftjwx" || config.url !== "https://xrorluukmizmhizftjwx.supabase.co") {
    throw new Error(config.error || "Development project configuration mismatch.");
  }
  window.DRAFTP_DEV_ANON_KEY = config.anonKey;
  envEl.textContent = `Connected configuration: development project ${config.projectRef}`;
  supabaseClient = window.supabase.createClient(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  await restoreSession();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  say("Signing in…");
  try {
    const username = document.querySelector("#username").value;
    const passwordInput = document.querySelector("#password");
    const password = passwordInput.value;
    passwordInput.value = "";
    const { response, data } = await postEdge({ action: "login", username, password });
    if (!response.ok || !data.access_token || !data.refresh_token || !data.account) {
      throw new Error(data.error || "Username or password is incorrect, or this account is inactive.");
    }
    const { data: sessionData, error } = await supabaseClient.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    });
    if (error || !sessionData.session) throw new Error("Could not establish a Supabase session.");
    const role = await resolveOwnRole(data.account.userId);
    if (!role || data.account.active !== true || role.role !== data.account.role) {
      await supabaseClient.auth.signOut();
      throw new Error("This account is not active for DraftP.");
    }
    sessionStorage.setItem("draftp.prototype.username", data.account.username);
    displaySession(sessionData.session, data.account);
    say("Signed in. Session is stored by Supabase Auth.", "success");
  } catch (error) {
    say(error.message || "Sign-in failed.", "error");
  } finally {
    setBusy(false);
  }
});

document.querySelector("#refreshButton").addEventListener("click", async () => {
  try {
    const { data, error } = await supabaseClient.auth.refreshSession();
    if (error || !data.session) throw new Error("Session refresh failed.");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !userData.user) throw new Error("Could not verify the refreshed session.");
    const role = await resolveOwnRole(userData.user.id);
    if (!role) throw new Error("This account is not active for DraftP.");
    displaySession(data.session, {
      userId: userData.user.id,
      username: sessionStorage.getItem("draftp.prototype.username") || "—",
      role: role.role,
      active: role.active,
    });
    say("Session refreshed successfully.", "success");
  } catch (error) {
    say(error.message || "Session refresh failed.", "error");
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  const { error } = await supabaseClient.auth.signOut();
  sessionStorage.removeItem("draftp.prototype.username");
  signedIn.classList.add("hidden");
  signedOut.classList.remove("hidden");
  say(error ? "Sign-out failed." : "Signed out.", error ? "error" : "success");
});

document.querySelector("#recoveryButton").addEventListener("click", async () => {
  const username = document.querySelector("#username").value;
  if (!username) {
    say("Enter your username. If the account is eligible, recovery instructions go to its verified email.", "info");
    document.querySelector("#username").focus();
    return;
  }
  setBusy(true);
  try {
    const { response } = await postEdge({ action: "recovery", username });
    if (!response.ok) throw new Error("Recovery is temporarily unavailable.");
    say("If the account is eligible, recovery instructions will be sent to its verified email.", "success");
  } catch (error) {
    say(error.message || "Recovery is temporarily unavailable.", "error");
  } finally {
    setBusy(false);
  }
});

initialize().catch((error) => {
  envEl.textContent = "Development configuration unavailable.";
  say(error.message || "Could not initialize the prototype.", "error");
  loginButton.disabled = true;
});
