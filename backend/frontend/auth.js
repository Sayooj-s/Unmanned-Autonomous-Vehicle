/**
 * Shared authentication helper, included on every dashboard page (after
 * config.js, before the page's own script). Handles:
 *   - storing/reading the login token
 *   - redirecting to login.html if there's no valid session
 *   - injecting a "logged in as ... [Logout]" control into the topbar
 *
 * Telemetry ingestion from the UAVs themselves does NOT go through this --
 * only human-facing dashboard pages are gated.
 */

const AUTH_TOKEN_KEY = "uav_auth_token";

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

function setAuthToken(token) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

function goToLogin() {
  const here = encodeURIComponent(location.pathname.split("/").pop() || "index.html");
  window.location.href = `login.html?next=${here}`;
}

function injectUserBadge(user) {
  const isIndex = location.pathname.endsWith("index.html") || location.pathname.endsWith("/");
  if (!isIndex) return;

  const statusEl = document.querySelector(".link-status");
  if (!statusEl || document.getElementById("authBadge")) return;

  const sep = document.createElement("span");
  sep.className = "link-sep";
  sep.textContent = "·";

  const name = document.createElement("span");
  name.id = "authBadge";
  name.textContent = user.name || user.email;

  const logoutBtn = document.createElement("button");
  logoutBtn.textContent = "Logout";
  logoutBtn.className = "logout-btn";
  logoutBtn.addEventListener("click", () => {
    clearAuthToken();
    goToLogin();
  });

  statusEl.appendChild(sep);
  statusEl.appendChild(name);
  statusEl.appendChild(logoutBtn);
}

/** Call this at the top of every protected page. Redirects to login.html
 * if there's no token or the backend rejects it (expired/forged).
 * NOTE: not auto-invoked here -- call it explicitly on protected pages only.
 * login.html/signup.html load this file for the token helpers above but
 * must NOT call guardPage(), or they'd redirect to themselves. */
async function guardPage() {
  const token = getAuthToken();
  if (!token) {
    goToLogin();
    return;
  }
  try {
    const base = window.API_BASE || "";
    const res = await fetch(base + "/api/auth/me", { headers: authHeaders() });
    if (!res.ok) throw new Error("invalid session");
    const user = await res.json();
    injectUserBadge(user);
  } catch (e) {
    clearAuthToken();
    goToLogin();
  }
}

/** Call this on index.html instead of guardPage().
 * If logged in: shows user name + Logout button.
 * If NOT logged in: shows Sign In / Sign Up buttons instead of redirecting. */
async function landingInit() {
  const statusEl = document.querySelector(".link-status");
  const token = getAuthToken();

  if (!token) {
    // Not logged in — show Sign In / Sign Up
    if (statusEl) {
      const signInBtn = document.createElement("a");
      signInBtn.href = "login.html";
      signInBtn.textContent = "Sign In";
      signInBtn.className = "landing-auth-btn";

      const sep = document.createElement("span");
      sep.className = "link-sep";
      sep.textContent = "/";

      const signUpBtn = document.createElement("a");
      signUpBtn.href = "signup.html";
      signUpBtn.textContent = "Sign Up";
      signUpBtn.className = "landing-auth-btn landing-auth-btn--primary";

      statusEl.appendChild(signInBtn);
      statusEl.appendChild(sep);
      statusEl.appendChild(signUpBtn);
    }
    return;
  }

  // Token exists — validate it and show user + logout
  try {
    const base = window.API_BASE || "";
    const res = await fetch(base + "/api/auth/me", { headers: authHeaders() });
    if (!res.ok) throw new Error("invalid session");
    const user = await res.json();
    injectUserBadge(user);
  } catch (e) {
    clearAuthToken();
    // Still don't redirect — just show Sign In / Sign Up
    landingInit();
  }
}
