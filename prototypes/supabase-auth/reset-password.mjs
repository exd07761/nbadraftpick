const status = document.querySelector("#status");
const form = document.querySelector("#resetForm");
const submitButton = form.querySelector("button[type=submit]");

const PROJECT_URL = "https://xrorluukmizmhizftjwx.supabase.co";

function say(message, kind = "") {
  status.textContent = message;
  status.dataset.kind = kind;
}

async function initialize() {
  const configResponse = await fetch("/runtime-config.json", {
    cache: "no-store",
  });
  const config = await configResponse.json();

  if (
    !configResponse.ok ||
    config.projectRef !== "xrorluukmizmhizftjwx" ||
    config.url !== PROJECT_URL ||
    !config.anonKey
  ) {
    throw new Error("Development configuration is unavailable.");
  }

  const supabase = window.supabase.createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  // The recovery email must establish a valid Supabase recovery session.
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    throw new Error("This recovery link is invalid, expired, or already used. Request a new one.");
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    await supabase.auth.signOut();
    throw new Error("The recovery session could not be verified. Request a new link.");
  }

  form.classList.remove("hidden");
  say("Recovery session verified. Enter your new password.", "success");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const password = document.querySelector("#password").value;
    const confirmation = document.querySelector("#confirmPassword").value;

    if (password.length < 8 || password.length > 128) {
      say("Use a password between 8 and 128 characters.", "error");
      return;
    }
    if (password !== confirmation) {
      say("The passwords do not match.", "error");
      return;
    }

    submitButton.disabled = true;
    say("Updating password…");

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      await supabase.auth.signOut();
      form.reset();
      form.classList.add("hidden");
      say("Password updated. Return to DraftP sign in and use your new password.", "success");
    } catch {
      say("Password update failed. The link may have expired, or the password may not meet the project's requirements.", "error");
    } finally {
      submitButton.disabled = false;
    }
  });
}

initialize().catch((error) => {
  say(error.message || "Could not initialize password recovery.", "error");
});
