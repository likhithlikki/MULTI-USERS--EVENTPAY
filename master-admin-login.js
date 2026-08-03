// ============================================================
// EventPay — master-admin_login.js
// MASTER ADMIN dashboard. Manages ONLY the Master Database.
// Authentication: single master admin, password-only, checked
// server-side via masterLogin action.
//
// THIS REVISION fixes/adds (see fix doc):
// §11 — "refresh logs you out" bug. hasValidSession() used to
//   require REMEMBER === "1" even though loginMasterAdmin() always
//   wrote a valid TOKEN/EXPIRY to localStorage regardless of the
//   checkbox — so an unchecked "Remember me" silently discarded a
//   perfectly valid session on every refresh. Fixed by giving
//   "Remember me" real meaning: unchecked -> sessionStorage (survives
//   refresh/navigation, dies with the tab); checked -> localStorage
//   (survives closing the browser too). hasValidSession() now checks
//   both. The on-screen countdown is now derived from the real stored
//   expiry instead of always resetting to 60:00. masterApi() also
//   slides the locally stored expiry forward on every successful
//   authenticated call, mirroring the backend's own sliding
//   expiration in requireMasterAuth_().
// §2 — sidebar "Backend not connected" dot is now real: green after
//   a successful load, red (with a toast) if both the bootstrap and
//   the individual-loader fallback fail.
// §5 — Applications now carries a `type` field per row
//   ("eventApplication" | "subscriptionPayment") so Approve/Reject
//   hit the right sheet on the backend (EventApplications vs.
//   SubscriptionPayments), matching the already-updated backend.
// §9 — Master Database view now lists real backups (from the
//   `listMasterBackups` action) with a Restore button per row that
//   passes the correct backupFileId, instead of a single button that
//   always sent an empty payload.
//
// (Everything from the prior revision — staggered fallback loader,
// per-section inline error cards, combined bootstrap-first strategy —
// is unchanged.)
// ============================================================

const MASTER_CONFIG = {
  SCRIPT_URL: APP_CONFIG.SCRIPT_URL,
  SESSION_MINUTES: 60,
  REQUEST_TIMEOUT_MS: 45000,
  LOGIN_TIMEOUT_MS: 45000,
  BOOTSTRAP_TIMEOUT_MS: 60000,
  LS: {
    TOKEN: "ep_master_token",
    EXPIRY: "ep_master_expiry",
    REMEMBER: "ep_master_remember",
    THEME: "ep_theme"
  }
};

console.log("APP_CONFIG =", APP_CONFIG);
console.log("SCRIPT_URL =", APP_CONFIG.SCRIPT_URL);
console.log("MASTER_CONFIG =", MASTER_CONFIG);

// ============================================================
// STATE
// ============================================================
const state = {
  events: [],
  filteredEvents: [],
  eventsPage: 1,
  eventsPageSize: 10,
  selectedEvent: null,
  applications: [],
  auditLog: [],
  plans: [],
  globalSettings: [],
  backups: [],
  sessionSecondsLeft: MASTER_CONFIG.SESSION_MINUTES * 60,
  sessionTimerHandle: null,
  bootstrapSupported: true,
};

// ============================================================
// SESSION STORAGE HELPERS (§11)
// ------------------------------------------------------------
// "Remember me" now genuinely controls WHERE the token lives:
//   - unchecked -> sessionStorage: gone when the tab/browser closes,
//     but a plain refresh or in-tab navigation keeps it.
//   - checked   -> localStorage: survives closing and reopening the
//     browser entirely.
// Every read goes through getStoredSession()/getActiveStore() so
// there is exactly one place that decides "where is the token."
// ============================================================
function getActiveStore() {
  // Prefer whichever store actually holds a live, non-expired token.
  // sessionStorage is checked first since it's the more common case
  // (unchecked "Remember me").
  for (const store of [sessionStorage, localStorage]) {
    const token = store.getItem(MASTER_CONFIG.LS.TOKEN);
    const expiry = Number(store.getItem(MASTER_CONFIG.LS.EXPIRY) || 0);
    if (token && expiry > Date.now()) return store;
  }
  return null;
}

function getStoredToken() {
  const store = getActiveStore();
  return store ? store.getItem(MASTER_CONFIG.LS.TOKEN) : null;
}

function getStoredExpiry() {
  const store = getActiveStore();
  return store ? Number(store.getItem(MASTER_CONFIG.LS.EXPIRY) || 0) : 0;
}

function hasValidSession() {
  return !!getActiveStore();
}

function persistSession(token, expiry, remember) {
  const store = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  store.setItem(MASTER_CONFIG.LS.TOKEN, token);
  store.setItem(MASTER_CONFIG.LS.EXPIRY, String(expiry));
  // Keep REMEMBER as a simple UI-preference flag (used to pre-check
  // the checkbox next time), not as a gate on session validity.
  localStorage.setItem(MASTER_CONFIG.LS.REMEMBER, remember ? "1" : "0");
  // Make sure a stale token isn't left behind in the OTHER store from
  // a previous login with a different "Remember me" choice.
  other.removeItem(MASTER_CONFIG.LS.TOKEN);
  other.removeItem(MASTER_CONFIG.LS.EXPIRY);
}

function clearSession() {
  [localStorage, sessionStorage].forEach((store) => {
    store.removeItem(MASTER_CONFIG.LS.TOKEN);
    store.removeItem(MASTER_CONFIG.LS.EXPIRY);
  });
  localStorage.removeItem(MASTER_CONFIG.LS.REMEMBER);
}

// Slide the locally stored expiry forward, mirroring the backend's
// own sliding expiration (requireMasterAuth_ extends the CacheService
// TTL on every authenticated call). Without this, the frontend would
// force a re-login at the ORIGINAL login time's +60min mark even
// though the backend session is still very much alive.
function extendStoredExpiry() {
  const store = getActiveStore();
  if (!store) return;
  const newExpiry = Date.now() + MASTER_CONFIG.SESSION_MINUTES * 60 * 1000;
  store.setItem(MASTER_CONFIG.LS.EXPIRY, String(newExpiry));
}

// ============================================================
// GENERIC API HELPER
// ============================================================
async function masterApi(action, params = {}, method = "GET", timeoutMs = MASTER_CONFIG.REQUEST_TIMEOUT_MS) {
  if (!MASTER_CONFIG.SCRIPT_URL) {
    console.warn(`[masterApi] SCRIPT_URL not configured — action "${action}" skipped.`);
    return { success: false, error: "Backend not connected yet." };
  }

  const token = action === "masterLogin" ? null : getStoredToken();
  const fullParams = token ? { ...params, token } : params;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let result;
  try {
    if (method === "GET") {
      const url = new URL(MASTER_CONFIG.SCRIPT_URL);
      url.searchParams.set("action", action);
      Object.entries(fullParams).forEach(([k, v]) => url.searchParams.set(k, String(v)));
      const res = await fetch(url.toString(), { signal: controller.signal });
      if (!res.ok) { result = { success: false, error: `Server returned ${res.status}` }; }
      else {
        const text = await res.text();
        try { result = JSON.parse(text); }
        catch (e) { result = { success: false, error: "Invalid response from server", raw: text }; }
      }
    } else {
      const body = new URLSearchParams({ action, ...fullParams });
      const res = await fetch(MASTER_CONFIG.SCRIPT_URL, { method: "POST", body, signal: controller.signal });
      if (!res.ok) { result = { success: false, error: `Server returned ${res.status}` }; }
      else {
        const text = await res.text();
        try { result = JSON.parse(text); }
        catch (e) { result = { success: false, error: "Invalid response from server", raw: text }; }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      result = { success: false, error: `Request timed out after ${Math.round(timeoutMs / 1000)}s`, timeout: true };
    } else {
      result = { success: false, error: err.message || "Network error", networkError: true };
    }
  } finally {
    clearTimeout(timer);
  }

  // Sliding expiration: any successful, token-bearing call extends the
  // locally stored expiry too, so the frontend's idea of "still logged
  // in" tracks the backend's, instead of expiring 60 minutes after the
  // original login regardless of activity.
  if (token && result && result.success !== false) {
    extendStoredExpiry();
  }

  return result;
}

// ============================================================
// TOAST
// ============================================================
function toast(msg, type = "info", dur = 3500) {
  const tc = document.getElementById("toastContainer");
  if (!tc) return;
  const icons = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.innerHTML = `<span>${icons[type] || ""}</span><span>${escapeHtml(msg)}</span>`;
  tc.appendChild(el);
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => el.remove(), 350);
  }, dur);
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

// ============================================================
// INLINE SECTION ERROR STATE HELPERS
// ============================================================
function renderSectionError(containerId, message, retryFn) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const retryId = `retry-${containerId}-${Date.now()}`;
  el.innerHTML = `
    <div class="section-error glass" style="padding:20px;text-align:center;color:var(--text-faint,#94a3b8);grid-column:1/-1">
      <div style="font-size:14px;margin-bottom:10px;">
        ⚠️ Failed to load — ${escapeHtml(message || "Unknown error")}
      </div>
      <button class="btn btn-secondary btn-sm" id="${retryId}">
        <i data-lucide="refresh-cw"></i> Retry
      </button>
    </div>`;
  if (window.lucide) lucide.createIcons();
  const btn = document.getElementById(retryId);
  if (btn && typeof retryFn === "function") {
    btn.addEventListener("click", () => {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-faint,#94a3b8);grid-column:1/-1">Retrying…</div>`;
      retryFn();
    });
  }
}

function renderInlineError(el, message) {
  if (!el) return;
  el.innerHTML = `<span style="color:#f87171;font-size:12px;">⚠️ ${escapeHtml(message || "Failed")}</span>`;
}

// ============================================================
// CONFIRM DIALOG
// ============================================================
function confirmDialog({ title = "Are you sure?", message = "This action cannot be undone.", confirmLabel = "Confirm" } = {}) {
  const overlay = document.getElementById("confirmOverlay");
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  const okBtn = document.getElementById("confirmOkBtn");
  okBtn.textContent = confirmLabel;
  overlay.classList.remove("hidden");

  return new Promise((resolve) => {
    const cleanup = (result) => {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const cancelBtn = document.getElementById("confirmCancelBtn");
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// ============================================================
// ICON HELPER
// ============================================================
function setIcon(container, name) {
  if (!container) return;
  container.innerHTML = `<i data-lucide="${name}"></i>`;
  if (window.lucide) lucide.createIcons();
}

// ============================================================
// THEME
// ============================================================
function initTheme() {
  const saved = localStorage.getItem(MASTER_CONFIG.LS.THEME) || "dark";
  applyTheme(saved);
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(MASTER_CONFIG.LS.THEME, t);
  setIcon(document.getElementById("themeToggleBtn"), t === "dark" ? "moon" : "sun");
  const profileToggle = document.getElementById("profileThemeToggle");
  if (profileToggle) profileToggle.checked = t === "light";
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
}

// ============================================================
// BACKEND STATUS DOT (§2)
// ============================================================
function setBackendStatus(status, detail) {
  // status: "online" | "offline" | "pending"
  const dot = document.getElementById("sidebarStatusDot");
  const label = document.getElementById("sidebarStatusLabel");
  if (!dot || !label) return;
  dot.classList.remove("online", "offline", "pending");
  dot.classList.add(status);
  const text = { online: "Connected", offline: "Connection issue", pending: "Connecting…" }[status] || "Unknown";
  label.textContent = text;
  if (status === "offline" && detail) {
    toast("Connection issue: " + detail, "error");
  }
}

// ============================================================
// LOGIN FLOW
// ============================================================
function initLogin() {
  const form = document.getElementById("loginForm");
  const pwInput = document.getElementById("masterPassword");
  const toggleBtn = document.getElementById("togglePasswordBtn");
  const errorEl = document.getElementById("loginError");

  // Pre-check "Remember me" based on the user's last choice — purely
  // a UI convenience now, it no longer gates whether a session
  // survives a refresh (both paths do; see hasValidSession()).
  const rememberBox = document.getElementById("rememberMe");
  if (rememberBox) rememberBox.checked = localStorage.getItem(MASTER_CONFIG.LS.REMEMBER) === "1";

  toggleBtn.addEventListener("click", () => {
    const showing = pwInput.type === "text";
    pwInput.type = showing ? "password" : "text";
    setIcon(toggleBtn, showing ? "eye" : "eye-off");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    const password = pwInput.value.trim();
    const remember = document.getElementById("rememberMe").checked;
    if (!password) return;

    setLoginLoading(true);
    const result = await loginMasterAdmin(password, remember);
    setLoginLoading(false);

    if (result.success) {
      enterDashboard();
    } else {
      errorEl.textContent = result.error || "Incorrect master password.";
      errorEl.classList.remove("hidden");
    }
  });

  document.getElementById("forgotPasswordBtn").addEventListener("click", () => {
    document.getElementById("forgotOverlay").classList.remove("hidden");
  });
  document.getElementById("closeForgotBtn").addEventListener("click", closeForgotModal);
  document.getElementById("forgotOkBtn").addEventListener("click", closeForgotModal);

  if (hasValidSession()) enterDashboard();
}

function closeForgotModal() {
  document.getElementById("forgotOverlay").classList.add("hidden");
}

function setLoginLoading(loading) {
  const btn = document.getElementById("loginBtn");
  btn.querySelector(".btn-label").classList.toggle("hidden", loading);
  btn.querySelector(".btn-spinner").classList.toggle("hidden", !loading);
  btn.disabled = loading;
}

async function loginMasterAdmin(password, remember) {
  const res = await masterApi("masterLogin", { password }, "POST", MASTER_CONFIG.LOGIN_TIMEOUT_MS);
  if (!res.success) {
    return { success: false, error: res.error || "Incorrect master password." };
  }

  const expiry = Date.now() + (res.expiresInSeconds || MASTER_CONFIG.SESSION_MINUTES * 60) * 1000;
  persistSession(res.token, expiry, remember);
  return { success: true };
}

function enterDashboard() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("dashboardShell").classList.remove("hidden");
  if (window.lucide) lucide.createIcons();
  startSessionTimer();
  setBackendStatus("pending");
  loadAllData();
}

function logoutMasterAdmin() {
  clearSession();
  stopSessionTimer();
  document.getElementById("dashboardShell").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("masterPassword").value = "";
  toast("Logged out", "info");
}

// ============================================================
// SESSION TIMER (§11 — synced to the REAL stored expiry, not a
// hardcoded 60:00 reset on every call)
// ============================================================
function startSessionTimer() {
  const expiry = getStoredExpiry();
  state.sessionSecondsLeft = expiry ? Math.max(0, Math.floor((expiry - Date.now()) / 1000)) : MASTER_CONFIG.SESSION_MINUTES * 60;
  updateSessionTimerText();
  stopSessionTimer();
  state.sessionTimerHandle = setInterval(() => {
    // Re-derive from storage each tick instead of just counting down a
    // local variable — this way an extendStoredExpiry() call from
    // masterApi() (sliding expiration) is reflected immediately rather
    // than the timer ticking down to zero on its own stale schedule.
    const currentExpiry = getStoredExpiry();
    if (!currentExpiry) {
      stopSessionTimer();
      toast("Session expired — please log in again.", "warning");
      logoutMasterAdmin();
      return;
    }
    state.sessionSecondsLeft = Math.max(0, Math.floor((currentExpiry - Date.now()) / 1000));
    updateSessionTimerText();
    if (state.sessionSecondsLeft <= 0) {
      stopSessionTimer();
      toast("Session expired — please log in again.", "warning");
      logoutMasterAdmin();
    }
  }, 1000);
}
function stopSessionTimer() {
  if (state.sessionTimerHandle) clearInterval(state.sessionTimerHandle);
}
function updateSessionTimerText() {
  const m = Math.floor(state.sessionSecondsLeft / 60).toString().padStart(2, "0");
  const s = (state.sessionSecondsLeft % 60).toString().padStart(2, "0");
  const el = document.getElementById("sessionTimerText");
  if (el) el.textContent = `${m}:${s}`;
}

// ============================================================
// NAVIGATION
// ============================================================
function initNavigation() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("mobileMenuBtn")?.addEventListener("click", () => {
    document.getElementById("sidebar").classList.add("open");
    document.getElementById("sidebarScrim").classList.add("show");
  });
  document.getElementById("sidebarScrim")?.addEventListener("click", closeMobileSidebar);
}
function closeMobileSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarScrim").classList.remove("show");
}
function switchView(viewName) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === viewName));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${viewName}`));
  closeMobileSidebar();
  if (window.lucide) lucide.createIcons();
}

// ============================================================
// DATA LOADING
// ============================================================
async function loadAllData() {
  if (state.bootstrapSupported) {
    const res = await masterApi("getMasterDashboardBootstrap", {}, "GET", MASTER_CONFIG.BOOTSTRAP_TIMEOUT_MS);
    const looksUnsupported = !res || (res.success === false && /unknown action/i.test(res.error || ""));

    if (!looksUnsupported && res) {
      applyBootstrapResult(res);
      // Consider the backend "online" if at least the core sections
      // (events + stats) came back — a couple of secondary sections
      // failing shouldn't flip the whole dashboard red.
      const coreOk = !!(res.events && res.events.events) && !!res.stats;
      setBackendStatus(coreOk ? "online" : "offline",
        coreOk ? null : "Some dashboard sections failed to load.");
      return;
    }
    // Combined endpoint not available this session — retry it again
    // on the NEXT manual refresh instead of being locked into the
    // slower per-call fallback forever (see fix doc §3).
    state.bootstrapSupported = false;
  }

  const ok = await loadAllDataIndividually();
  setBackendStatus(ok ? "online" : "offline", ok ? null : "Backend did not respond.");
  // Give the combined endpoint another chance next time.
  state.bootstrapSupported = true;
}

function applyBootstrapResult(res) {
  const errors = res.errors || {};

  if (res.stats) renderStatCards(res.stats);
  else renderSectionError("statGrid", errors.stats || "No stats returned", loadStats);

  if (res.events && res.events.events) {
    state.events = res.events.events || [];
    applyEventsFilters();
  } else {
    renderSectionError("eventsTableBody", errors.events || "No events returned", loadEvents);
  }

  if (res.globalSettings && res.globalSettings.settings) {
    state.globalSettings = res.globalSettings.settings;
    renderGlobalSettings();
  } else {
    renderSectionError("globalSettingsGrid", errors.globalSettings || "No settings returned", loadGlobalSettings);
  }

  if (res.plans && res.plans.plans && res.plans.plans.length) {
    state.plans = res.plans.plans;
    renderPlans();
  } else if (errors.plans) {
    renderSectionError("plansGrid", errors.plans, loadPlans);
  } else {
    state.plans = DEFAULT_PLANS;
    renderPlans();
  }

  if (res.applications && res.applications.applications) {
    state.applications = res.applications.applications || [];
    document.getElementById("applicationsBadge").textContent =
      state.applications.filter((a) => a.status === "pending").length;
    renderApplications();
  } else {
    document.getElementById("applicationsBadge").textContent = "!";
    renderSectionError("applicationsGrid", errors.applications || "No applications returned", loadApplications);
  }

  if (res.auditLog && res.auditLog.log) {
    state.auditLog = res.auditLog.log || [];
    renderAuditTrail();
  } else {
    renderSectionError("auditTimeline", errors.auditLog || "No audit log returned", loadAuditTrail);
  }

  if (res.dbInfo && res.dbInfo.info) {
    renderMasterDbInfo(res.dbInfo.info);
  } else {
    renderInlineError(document.getElementById("masterDbId"), errors.dbInfo || "Failed to load");
  }
  // Backup list isn't part of the bootstrap payload — load it
  // separately (cheap, single-sheet read).
  loadBackupsList();

  if (res.profile && res.profile.profile) {
    applyProfileData(res.profile.profile);
  } else if (errors.profile) {
    console.warn("Profile load failed:", errors.profile);
  }

  if (res.emailSettings && res.emailSettings.settings) {
    applyEmailSettings(res.emailSettings.settings);
  } else if (errors.emailSettings) {
    console.warn("Email settings load failed:", errors.emailSettings);
  }
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function loadAllDataIndividually() {
  const loaders = [
    loadStats, loadEvents, loadGlobalSettings, loadPlans,
    loadApplications, loadAuditTrail, loadMasterDbInfo,
    loadProfileData, loadEmailSettings, loadBackupsList,
  ];
  const STAGGER_MS = 80;

  const results = await Promise.allSettled(
    loaders.map((fn, i) => wait(i * STAGGER_MS).then(fn))
  );

  let failures = 0;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      failures++;
      console.error(`[loadAllData] section #${i} threw unexpectedly:`, r.reason);
    }
  });
  // "Online" if at least most sections loaded — a single section
  // failing shouldn't flip the whole indicator red.
  return failures < loaders.length;
}

// ---------------- Dashboard stats ----------------
const STAT_DEFS = [
  { key: "totalEvents", label: "Total Events", icon: "calendar-days" },
  { key: "activeEvents", label: "Active Events", icon: "check-circle" },
  { key: "expiredEvents", label: "Expired Events", icon: "clock" },
  { key: "pendingApplications", label: "Pending Applications", icon: "inbox" },
  { key: "totalOrganizers", label: "Total Organizers", icon: "users" },
  { key: "totalCollections", label: "Total Collections", icon: "wallet" },
  { key: "activePlans", label: "Current Active Plans", icon: "badge-percent" },
  { key: "totalRevenue", label: "Total Revenue", icon: "indian-rupee" },
  { key: "todaysRegistrations", label: "Today's Registrations", icon: "user-plus" },
];

function renderStatSkeletons() {
  const grid = document.getElementById("statGrid");
  grid.innerHTML = STAT_DEFS.map((s) => `
    <div class="stat-card glass skeleton">
      <div class="stat-card-icon"><i data-lucide="${s.icon}"></i></div>
      <div>
        <div class="stat-card-value">0</div>
        <div class="stat-card-label">${s.label}</div>
      </div>
    </div>`).join("");
  if (window.lucide) lucide.createIcons();
}

async function loadStats() {
  renderStatSkeletons();
  try {
    const res = await masterApi("getPlatformStats");
    if (!res.success && !res.stats) {
      renderSectionError("statGrid", res.error || "Failed to load stats", loadStats);
      return;
    }
    renderStatCards(res.stats || {});
  } catch (e) {
    renderSectionError("statGrid", e.message || "Unexpected error", loadStats);
  }
}

function renderStatCards(stats) {
  const grid = document.getElementById("statGrid");
  grid.innerHTML = STAT_DEFS.map((s) => {
    const raw = stats[s.key];
    const value = s.key === "totalRevenue" || s.key === "totalCollections"
      ? fmtINR(raw || 0)
      : (raw ?? 0);
    return `
    <div class="stat-card glass">
      <div class="stat-card-icon"><i data-lucide="${s.icon}"></i></div>
      <div>
        <div class="stat-card-value" data-count="${typeof raw === "number" ? raw : 0}">${value}</div>
        <div class="stat-card-label">${s.label}</div>
      </div>
    </div>`;
  }).join("");
  if (window.lucide) lucide.createIcons();
  animateCounters();
}

function animateCounters() {
  document.querySelectorAll(".stat-card-value[data-count]").forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    if (target === 0) return;
    let current = 0;
    const step = Math.max(1, Math.ceil(target / 30));
    const isMoney = el.textContent.includes("₹");
    const timer = setInterval(() => {
      current += step;
      if (current >= target) { current = target; clearInterval(timer); }
      el.textContent = isMoney ? fmtINR(current) : String(current);
    }, 20);
  });
}

function fmtINR(n) { return "₹" + Number(n || 0).toLocaleString("en-IN"); }
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}


function fmtDateTime(date, time) {
  if (!date) return "—";
  const dt = new Date(date);
  const dPart = isNaN(dt) ? String(date) : dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  if (time) return `${dPart}, ${time}`;
  if (!isNaN(dt) && (dt.getHours() || dt.getMinutes())) {
    const tPart = dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
    return `${dPart}, ${tPart}`;
  }
  return dPart;
}


// ============================================================
// EVENTS TABLE
// ============================================================
async function loadEvents() {
  const tbody = document.getElementById("eventsTableBody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="padding:20px;text-align:center;color:var(--text-faint,#94a3b8);">Loading events…</td></tr>`;

  try {
    const res = await masterApi("getEvents");
    if (!res.success && !res.events) {
      renderSectionError("eventsTableBody", res.error || "Failed to load events", loadEvents);
      return;
    }
    state.events = res.events || [];
    applyEventsFilters();
  } catch (e) {
    renderSectionError("eventsTableBody", e.message || "Unexpected error", loadEvents);
  }
}

function initEventsControls() {
  document.getElementById("eventsSearch").addEventListener("input", debounce(applyEventsFilters, 200));
  document.getElementById("eventsFilterStatus").addEventListener("change", applyEventsFilters);
  document.getElementById("eventsFilterPlan").addEventListener("change", applyEventsFilters);
  document.getElementById("eventsSort").addEventListener("change", applyEventsFilters);
  document.getElementById("eventsPrevPage").addEventListener("click", () => changeEventsPage(-1));
  document.getElementById("eventsNextPage").addEventListener("click", () => changeEventsPage(1));
  document.getElementById("exportEventsBtn").addEventListener("click", exportEventsCsv);
  document.getElementById("closeEventDetailsBtn").addEventListener("click", closeEventDetails);
  document.getElementById("eventDetailsOverlay").addEventListener("click", (e) => {
    if (e.target.id === "eventDetailsOverlay") closeEventDetails();
  });
  document.getElementById("eventDetailsActions").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (btn) handleEventDetailAction(btn.dataset.action);
  });
  document.getElementById("loadSpreadsheetPreviewBtn").addEventListener("click", loadSpreadsheetPreview);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function applyEventsFilters() {
  const q = document.getElementById("eventsSearch").value.trim().toLowerCase();
  const statusFilter = document.getElementById("eventsFilterStatus").value;
  const planFilter = document.getElementById("eventsFilterPlan").value;
  const sort = document.getElementById("eventsSort").value;

  let rows = state.events.filter((ev) => {
    const matchesQuery = !q || [ev.eventName, ev.eventCode, ev.organizerName, ev.organizerEmail]
      .some((f) => (f || "").toLowerCase().includes(q));
    const matchesStatus = !statusFilter || ev.status === statusFilter;
    const matchesPlan = !planFilter || ev.plan === planFilter;
    return matchesQuery && matchesPlan && matchesStatus;
  });

  rows.sort((a, b) => {
    if (sort === "nameAsc") return (a.eventName || "").localeCompare(b.eventName || "");
    if (sort === "nameDesc") return (b.eventName || "").localeCompare(a.eventName || "");
    const da = new Date(a.createdDate || 0), db = new Date(b.createdDate || 0);
    return sort === "createdAsc" ? da - db : db - da;
  });

  state.filteredEvents = rows;
  state.eventsPage = 1;
  renderEventsTable();
}

function changeEventsPage(delta) {
  const totalPages = Math.max(1, Math.ceil(state.filteredEvents.length / state.eventsPageSize));
  state.eventsPage = Math.min(totalPages, Math.max(1, state.eventsPage + delta));
  renderEventsTable();
}

function renderEventsTable() {
  const tbody = document.getElementById("eventsTableBody");
  const emptyState = document.getElementById("eventsEmptyState");
  const rows = state.filteredEvents;
  const totalPages = Math.max(1, Math.ceil(rows.length / state.eventsPageSize));
  const start = (state.eventsPage - 1) * state.eventsPageSize;
  const pageRows = rows.slice(start, start + state.eventsPageSize);

  document.getElementById("eventsPageInfo").textContent = `Page ${state.eventsPage} of ${totalPages}`;

  if (!pageRows.length) {
    tbody.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  tbody.innerHTML = pageRows.map((ev) => `
    <tr data-eid="${escapeHtml(ev.eventId)}">
      <td>${escapeHtml(ev.eventId)}</td>
      <td>${escapeHtml(ev.eventCode)}</td>
      <td>${escapeHtml(ev.eventName)}</td>
      <td>${escapeHtml(ev.organizerName)}</td>
      <td>${escapeHtml(ev.organizerPhone)}</td>
      <td>${escapeHtml(ev.organizerEmail)}</td>
      <td>${escapeHtml(ev.plan)}</td>
      <td>${statusBadge(ev.status)}</td>
      <td>${fmtDate(ev.createdDate)}</td>
      <td>${ev.spreadsheetId ? `<code>${escapeHtml(String(ev.spreadsheetId).slice(0, 10))}…</code>` : "—"}</td>
      <td class="col-actions">
        <div class="row-actions" onclick="event.stopPropagation()">
          <button class="icon-btn" title="View" onclick="openEventDetails('${escapeHtml(ev.eventId)}')"><i data-lucide="eye"></i></button>
          ${ev.status === "Active"
            ? `<button class="icon-btn" title="Deactivate" onclick="deactivateEvent('${escapeHtml(ev.eventId)}')"><i data-lucide="power-off"></i></button>`
            : `<button class="icon-btn" title="Activate" onclick="activateEvent('${escapeHtml(ev.eventId)}')"><i data-lucide="power"></i></button>`
          }
          <button class="icon-btn" title="Delete" onclick="deleteEvent('${escapeHtml(ev.eventId)}')"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    </tr>`).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => openEventDetails(tr.dataset.eid));
  });
  if (window.lucide) lucide.createIcons();
}

function statusBadge(status) {
  const cls = { Active: "badge-active", Expired: "badge-expired", Deactivated: "badge-deactivated" }[status] || "badge-pending";
  return `<span class="badge ${cls}">${escapeHtml(status || "Pending")}</span>`;
}

function exportEventsCsv() {
  const rows = state.filteredEvents;
  if (!rows.length) { toast("No events to export", "warning"); return; }
  const headers = ["eventId","eventCode","eventName","organizerName","organizerPhone","organizerEmail","plan","status","createdDate"];
  const csv = [headers.join(",")].concat(
    rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(","))
  ).join("\n");
  downloadTextFile("eventpay-events.csv", csv);
  toast("Events exported", "success");
}
function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- row actions ----------------
async function activateEvent(eventId) {
  const ok = await confirmDialog({
    title: "Activate this event?",
    message: "Organizers and the public site regain access immediately.",
    confirmLabel: "Activate",
  });
  if (!ok) return;
  const res = await masterApi("activateEvent", { eventId }, "POST");
  toast(res.success ? "Event activated" : (res.error || "Failed"), res.success ? "success" : "error");
  loadEvents();
}

async function deactivateEvent(eventId) {
  const ok = await confirmDialog({
    title: "Deactivate this event?",
    message: "Organizers lose access until reactivated.",
    confirmLabel: "Deactivate",
  });
  if (!ok) return;
  const res = await masterApi("deactivateEvent", { eventId }, "POST");
  toast(res.success ? "Event deactivated" : (res.error || "Failed"), res.success ? "success" : "error");
  loadEvents();
}

async function deleteEvent(eventId) {
  const ok = await confirmDialog({
    title: "Delete this event permanently?",
    message: "Removes it from the Master Database. Its spreadsheet and Drive folder are not affected.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  const res = await masterApi("deleteEvent", { eventId }, "POST");
  toast(res.success ? "Event deleted" : (res.error || "Failed"), res.success ? "success" : "error");
  loadEvents();
}

// ============================================================
// EVENT DETAILS PANEL
// ============================================================
function openEventDetails(eventId) {
  const ev = state.events.find((e) => String(e.eventId) === String(eventId));
  if (!ev) { toast("Event not found", "error"); return; }
  state.selectedEvent = ev;

  document.getElementById("eventDetailsTitle").textContent = ev.eventName || "Event Details";

  document.getElementById("eventDetailsGeneral").innerHTML = [
    ["Event ID", ev.eventId], ["Event Code", ev.eventCode], ["Event Name", ev.eventName],
    ["Event Type", ev.eventType], ["Status", ev.status], ["Created Date", fmtDate(ev.createdDate)],
    ["Plan", ev.plan], ["Trial Expiry", fmtDate(ev.trialExpiry)],
  ].map(detailItem).join("");

  document.getElementById("eventDetailsOrganizer").innerHTML = [
    ["Name", ev.organizerName], ["Phone", ev.organizerPhone], ["Email", ev.organizerEmail],
  ].map(detailItem).join("");

  document.getElementById("eventDetailsVenue").innerHTML = [
    ["Venue", ev.venue], ["Date", fmtDate(ev.eventDate)], ["Time", ev.eventTime], ["Location", ev.location],
  ].map(detailItem).join("");

  document.getElementById("sheetPreview").classList.add("hidden");
  document.getElementById("eventDetailsOverlay").classList.remove("hidden");
  if (window.lucide) lucide.createIcons();
}
function detailItem([label, value]) {
  return `<div><div class="detail-item-label">${escapeHtml(label)}</div><div class="detail-item-value">${escapeHtml(value || "—")}</div></div>`;
}
function closeEventDetails() {
  document.getElementById("eventDetailsOverlay").classList.add("hidden");
  state.selectedEvent = null;
}

function handleEventDetailAction(action) {
  const ev = state.selectedEvent;
  if (!ev) return;
  const openers = {
    toggleEventStatus: () => (ev.status === "Active" ? deactivateEvent(ev.eventId) : activateEvent(ev.eventId)),
    openSpreadsheet: () => openUrl(ev.spreadsheetLink || sheetUrlFromId(ev.spreadsheetId)),
    copySpreadsheetId: () => copyToClipboard(ev.spreadsheetId, "Spreadsheet ID copied"),
    openParentFolder: () => openUrl(ev.parentFolderLink),
    openPublicSite: () => openUrl(ev.publicUrl),
    openAdminDashboard: () => openUrl(ev.adminUrl),
    openComplaintFolder: () => openUrl(ev.complaintFolderLink),
    openGalleryFolder: () => openUrl(ev.galleryFolderLink),
    openInvitationFolder: () => openUrl(ev.invitationFolderLink),
    downloadBackup: () => downloadEventBackup(ev),
  };
  (openers[action] || (() => {}))();
}
function openUrl(url) {
  if (!url) { toast("No link available for this event yet", "warning"); return; }
  window.open(url, "_blank", "noopener");
}
function sheetUrlFromId(id) {
  return id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : "";
}
function copyToClipboard(text, successMsg) {
  if (!text) { toast("Nothing to copy", "warning"); return; }
  navigator.clipboard?.writeText(text).then(() => toast(successMsg, "success"))
    .catch(() => toast("Couldn't copy — copy manually", "error"));
}

async function downloadEventBackup(ev) {
  const res = await masterApi("downloadEventBackup", { eventId: ev.eventId }, "POST");
  if (res.success && res.url) {
    window.open(res.url, "_blank", "noopener");
    toast("Backup ready", "success");
  } else {
    toast(res.error || "Backup failed", "error");
  }
}

// ---------------- Spreadsheet Preview ----------------
async function loadSpreadsheetPreview() {
  const ev = state.selectedEvent;
  if (!ev) return;
  const container = document.getElementById("sheetPreview");
  container.classList.remove("hidden");
  document.getElementById("sheetTabs").innerHTML = `<div style="padding:10px;color:var(--text-faint,#94a3b8)">Loading preview…</div>`;

  const res = await masterApi("getSpreadsheetPreview", { sid: ev.spreadsheetId });
  if (!res.success && !res.sheets) {
    renderSectionError("sheetTabs", res.error || "Failed to load spreadsheet preview", loadSpreadsheetPreview);
    return;
  }
  const sheets = res.sheets || {
    Settings: [], Payments: [], Complaints: [], Villages: [], Admins: [], Activity: [], Gallery: [], Audit: [],
  };
  renderSheetTabs(sheets);
}

let activeSheetData = { name: "", rows: [] };
function renderSheetTabs(sheets) {
  const tabsEl = document.getElementById("sheetTabs");
  const names = Object.keys(sheets);
  tabsEl.innerHTML = names.map((n, i) =>
    `<button class="sheet-tab ${i === 0 ? "active" : ""}" data-sheet="${escapeHtml(n)}">${escapeHtml(n)}</button>`
  ).join("");
  tabsEl.querySelectorAll(".sheet-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      tabsEl.querySelectorAll(".sheet-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      showSheetData(btn.dataset.sheet, sheets[btn.dataset.sheet] || []);
    });
  });
  if (names.length) showSheetData(names[0], sheets[names[0]] || []);

  document.getElementById("sheetRefreshBtn").onclick = loadSpreadsheetPreview;
  document.getElementById("sheetSearchInput").oninput = debounce((e) => filterSheetRows(e.target.value), 150);
  document.getElementById("sheetDownloadCsvBtn").onclick = downloadActiveSheetCsv;
  document.getElementById("sheetOpenInGoogleBtn").onclick = () => openUrl(sheetUrlFromId(state.selectedEvent?.spreadsheetId));
}
function showSheetData(name, rows) {
  activeSheetData = { name, rows };
  renderSheetGrid(rows);
}
function renderSheetGrid(rows) {
  const table = document.getElementById("sheetGridTable");
  if (!rows.length) {
    table.innerHTML = `<tr><td style="padding:20px;text-align:center;color:var(--text-faint)">No data in this sheet yet.</td></tr>`;
    return;
  }
  const headers = Object.keys(rows[0]);
  table.innerHTML = `
    <tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>
    ${rows.map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(r[h])}</td>`).join("")}</tr>`).join("")}
  `;
}
function filterSheetRows(query) {
  const q = query.trim().toLowerCase();
  const rows = activeSheetData.rows.filter((r) => !q || Object.values(r).some((v) => String(v).toLowerCase().includes(q)));
  renderSheetGrid(rows);
}
function downloadActiveSheetCsv() {
  const { name, rows } = activeSheetData;
  if (!rows.length) { toast("Nothing to export in this sheet", "warning"); return; }
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(",")].concat(rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(","))).join("\n");
  downloadTextFile(`${name || "sheet"}.csv`, csv);
}

// ============================================================
// GLOBAL SETTINGS
// ============================================================
const GLOBAL_SETTINGS_DEFS = [
  ["sendEventCreatedEmail", "Send Event Created Email", "Notify the organizer as soon as their event is created."],
  ["sendSpreadsheetLink", "Send Spreadsheet Link", "Include a direct link to the event's spreadsheet in emails."],
  ["sendSpreadsheetId", "Send Spreadsheet ID", "Include the raw Spreadsheet ID in outgoing emails."],
  ["sendParentFolderLink", "Send Parent Folder Link", "Share the Drive parent folder link with the organizer."],
  ["sendOrganizerDetails", "Send Organizer Details", "Confirm the organizer's own details back to them."],
  ["sendAdminCredentials", "Send Admin Credentials", "Email the event admin username and password on creation."],
  ["sendPublicUrl", "Send Public URL", "Share the public-facing event website link."],
  ["sendAdminUrl", "Send Admin URL", "Share the event's admin dashboard link."],
  ["sendSubscriptionDetails", "Send Subscription Details", "Include subscription status in organizer emails."],
  ["sendPlanDetails", "Send Plan Details", "Include plan name and limits in organizer emails."],
  ["allowGalleryFolderLinks", "Allow Gallery Folder Links", "Let event admins share gallery folder links publicly."],
  ["allowPasswordReset", "Allow Password Reset", "Let event admins reset their own password."],
  ["passwordResetExpiry", "Password Reset Expiry (minutes)", "How long a password reset link stays valid.", "number"],
  ["sendPasswordResetEmail", "Send Password Reset Email", "Email a link automatically when a reset is requested."],
];

async function loadGlobalSettings() {
  const grid = document.getElementById("globalSettingsGrid");
  if (grid) grid.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-faint,#94a3b8);grid-column:1/-1">Loading settings…</div>`;

  try {
    const res = await masterApi("getGlobalSettings");
    if (!res.success && !res.settings) {
      renderSectionError("globalSettingsGrid", res.error || "Failed to load global settings", loadGlobalSettings);
      return;
    }
    state.globalSettings = res.settings || {};
    renderGlobalSettings();
  } catch (e) {
    renderSectionError("globalSettingsGrid", e.message || "Unexpected error", loadGlobalSettings);
  }
}

function renderGlobalSettings() {
  const grid = document.getElementById("globalSettingsGrid");
  const values = state.globalSettings;
  grid.innerHTML = GLOBAL_SETTINGS_DEFS.map(([key, title, desc, type]) => {
    if (type === "number") {
      return `
      <div class="setting-card glass">
        <div><div class="setting-title">${escapeHtml(title)}</div><div class="setting-desc">${escapeHtml(desc)}</div></div>
        <input type="number" class="select" style="width:80px" data-setting="${key}" value="${values[key] ?? 30}">
      </div>`;
    }
    const checked = values[key] ? "checked" : "";
    return `
      <div class="setting-card glass">
        <div><div class="setting-title">${escapeHtml(title)}</div><div class="setting-desc">${escapeHtml(desc)}</div></div>
        <label class="switch"><input type="checkbox" data-setting="${key}" ${checked}><span class="slider"></span></label>
      </div>`;
  }).join("") + `
    <div class="sticky-save" style="grid-column:1/-1">
      <button class="btn btn-primary" id="saveGlobalSettingsBtn"><i data-lucide="save"></i>Save changes</button>
    </div>`;
  document.getElementById("saveGlobalSettingsBtn").addEventListener("click", saveGlobalSettings);
  if (window.lucide) lucide.createIcons();
}

async function saveGlobalSettings() {
  const payload = {};
  document.querySelectorAll("#globalSettingsGrid [data-setting]").forEach((el) => {
    payload[el.dataset.setting] = el.type === "checkbox" ? el.checked : Number(el.value);
  });
  const res = await masterApi("saveGlobalSettings", payload, "POST");
  toast(res.success ? "Global settings saved" : (res.error || "Save failed"), res.success ? "success" : "error");
}

// ============================================================
// SUBSCRIPTION PLANS
// ============================================================
const DEFAULT_PLANS = [
  { id: "basic", name: "Basic", price: 499, features: ["1 Event", "Up to 200 guests", "Email support"] },
  { id: "premium", name: "Premium", price: 1499, features: ["5 Events", "Up to 1000 guests", "Priority support", "Custom domain"], featured: true },
  { id: "enterprise", name: "Enterprise", price: 4999, features: ["Unlimited events", "Unlimited guests", "Dedicated support", "White-label branding"] },
];

async function loadPlans() {
  try {
    const res = await masterApi("getSubscriptionPlans");
    if (!res.success && !res.plans) {
      renderSectionError("plansGrid", res.error || "Failed to load plans", loadPlans);
      return;
    }
    state.plans = (res.plans && res.plans.length) ? res.plans : DEFAULT_PLANS;
    renderPlans();
  } catch (e) {
    renderSectionError("plansGrid", e.message || "Unexpected error", loadPlans);
  }
}

function renderPlans() {
  const grid = document.getElementById("plansGrid");
  grid.innerHTML = state.plans.map((p) => `
    <div class="plan-card glass ${p.featured ? "featured" : ""}">
      <div class="plan-name">${escapeHtml(p.name)}</div>
      <div class="plan-price-row">
        <span>₹</span>
        <input type="number" class="plan-price-input" data-plan="${p.id}" value="${p.price}">
        <span class="plan-price-period">/month</span>
      </div>
      <ul class="plan-features">
        ${p.features.map((f) => `<li><i data-lucide="check-circle"></i>${escapeHtml(f)}</li>`).join("")}
      </ul>
      <button class="btn btn-secondary btn-sm save-plan-btn" data-plan="${p.id}"><i data-lucide="save"></i>Save</button>
    </div>`).join("");
  grid.querySelectorAll(".save-plan-btn").forEach((btn) => btn.addEventListener("click", () => savePlan(btn.dataset.plan)));
  if (window.lucide) lucide.createIcons();
}

async function savePlan(planId) {
  const input = document.querySelector(`.plan-price-input[data-plan="${planId}"]`);
  const price = Number(input.value);
  const res = await masterApi("updatePlanPrice", { planId, price }, "POST");
  toast(res.success ? `${planId} plan updated to ${fmtINR(price)}` : (res.error || "Failed"), res.success ? "success" : "error");
}

// ============================================================
// PAYMENT GATEWAY
// ============================================================
function initPaymentGateway() {
  document.getElementById("savePaymentGatewayBtn").addEventListener("click", async () => {
    const payload = {
      enabled: document.getElementById("pgEnabled").checked,
      provider: document.getElementById("pgProvider").value,
      merchantId: document.getElementById("pgMerchantId").value,
      secret: document.getElementById("pgSecret").value,
      webhook: document.getElementById("pgWebhook").value,
      testMode: document.getElementById("pgTestMode").checked,
    };
    const res = await masterApi("savePaymentGatewaySettings", payload, "POST");
    toast(res.success ? "Payment gateway settings saved" : (res.error || "Failed"), res.success ? "success" : "error");
  });
}

// ============================================================
// EMAIL SETTINGS
// ============================================================
function initEmailSettings() {
  document.getElementById("esLogoUploadBtn").addEventListener("click", () => document.getElementById("esLogoUpload").click());
  document.getElementById("esLogoUpload").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById("esLogoPreview").innerHTML = `<img src="${reader.result}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
      window._currentLogoUrl = reader.result;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("sendTestEmailBtn").addEventListener("click", async () => {
    const res = await masterApi("sendTestEmail", {}, "POST");
    toast(res.success ? "Test email sent" : (res.error || "Failed"), res.success ? "success" : "error");
  });

document.getElementById("saveEmailSettingsBtn").addEventListener("click", async () => {
    const payload = {
      senderName: document.getElementById("esSenderName").value,
      replyEmail: document.getElementById("esReplyEmail").value,
      replyToName: document.getElementById("esReplyToName").value,
      supportEmail: document.getElementById("esSupportEmail").value,
      orgEmail: document.getElementById("esOrgEmail").value,
      footer: document.getElementById("esFooter").value,
      signature: document.getElementById("esSignature").value,
      bccAdmin: document.getElementById("esBccAdmin").checked,
      logoUrl: window._currentLogoUrl || "",
    };
    const res = await masterApi("saveEmailSettings", payload, "POST");
    toast(res.success ? "Email settings saved" : (res.error || "Failed"), res.success ? "success" : "error");
  });
}

function applyEmailSettings(s) {
  document.getElementById("esSenderName").value = s.senderName || "";
  document.getElementById("esReplyEmail").value = s.replyEmail || "";
  document.getElementById("esReplyToName").value = s.replyToName || "";
  document.getElementById("esSupportEmail").value = s.supportEmail || "";
  document.getElementById("esOrgEmail").value = s.orgEmail || "";
  document.getElementById("esFooter").value = s.footer || "";
  document.getElementById("esSignature").value = s.signature || "";
  document.getElementById("esBccAdmin").checked = !!s.bccAdmin;
  if (s.logoUrl) {
    document.getElementById("esLogoPreview").innerHTML =
      `<img src="${s.logoUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
  }
  window._currentLogoUrl = s.logoUrl || "";
}

// ============================================================
// APPLICATIONS (§5 — merged EventApplications + SubscriptionPayments)
// ============================================================
async function loadApplications() {
  const badge = document.getElementById("applicationsBadge");
  const grid = document.getElementById("applicationsGrid");
  if (grid) grid.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-faint,#94a3b8);grid-column:1/-1">Loading applications…</div>`;

  try {
    const res = await masterApi("getPendingApplications");
    if (!res.success && !res.applications) {
      if (badge) badge.textContent = "!";
      renderSectionError("applicationsGrid", res.error || "Failed to load applications", loadApplications);
      return;
    }
    state.applications = res.applications || [];
    if (badge) badge.textContent = state.applications.filter((a) => a.status === "pending").length;
    renderApplications();
  } catch (e) {
    if (badge) badge.textContent = "!";
    renderSectionError("applicationsGrid", e.message || "Unexpected error", loadApplications);
  }
}

function initApplicationsControls() {
  document.getElementById("applicationsSearch").addEventListener("input", debounce(renderApplications, 200));
  document.getElementById("applicationsFilter").addEventListener("change", renderApplications);
}

async function loadNotifications() {
  const body = document.getElementById("notifPanelBody");
  if (!body) return;
  body.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-faint,#94a3b8);">Loading…</div>`;
  const res = await masterApi("getRecentNotifications");
  if (!res || !res.success) {
    body.innerHTML = `<div style="padding:14px;text-align:center;color:var(--danger);">Failed to load notifications</div>`;
    return;
  }
  updateNotifBadge(res.pendingCount || 0);

  const pendingLine = res.pendingCount > 0
    ? `<div class="notif-item notif-item-pending">${res.pendingCount} pending application${res.pendingCount === 1 ? "" : "s"} awaiting review</div>`
    : "";
  const items = res.notifications || [];
  const itemsHtml = items.length
    ? items.map((n) => `
        <div class="notif-item">
          <div class="notif-item-action">${escapeHtml(n.action || "Activity")}</div>
          <div class="notif-item-meta">${escapeHtml(n.user || "master")} &middot; ${fmtDate(n.date)}</div>
        </div>`).join("")
    : `<div style="padding:14px;text-align:center;color:var(--text-faint,#94a3b8);">No recent activity</div>`;

  body.innerHTML = pendingLine + itemsHtml;
}

function updateNotifBadge(count) {
  const badge = document.getElementById("notifBadge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}


function renderApplications() {
   updateNotifBadge(state.applications.filter((a) => a.status === "pending").length);
  const q = (document.getElementById("applicationsSearch")?.value || "").trim().toLowerCase();
  const filter = document.getElementById("applicationsFilter")?.value || "";
  const grid = document.getElementById("applicationsGrid");
  const emptyState = document.getElementById("applicationsEmptyState");

  const rows = state.applications.filter((a) => {
    const matchesQuery = !q || [a.name, a.email, a.eventName].some((f) => (f || "").toLowerCase().includes(q));
    const matchesFilter = !filter || a.status === filter;
    return matchesQuery && matchesFilter;
  });

  if (!rows.length) {
    grid.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  grid.innerHTML = rows.map((a) => `
    <div class="application-card glass">
      <div class="application-card-head">
        <span class="application-card-name">${escapeHtml(a.eventName || "Untitled")}</span>
        <span class="badge ${a.status === "approved" ? "badge-active" : a.status === "rejected" ? "badge-expired" : "badge-pending"}">${escapeHtml(a.status || "pending")}</span>
      </div>
      <div class="application-card-meta">
        <span>${escapeHtml(a.name || "")}</span>
        <span>${escapeHtml(a.email || "")}</span>
        <span>${fmtDate(a.submittedDate)}</span>
        <span class="app-type-tag">${a.type === "subscriptionPayment" ? "Subscription payment" : "Event application"}</span>
      </div>
      <div class="application-card-actions">
        <button class="btn btn-primary btn-sm" onclick="approveApplication('${escapeHtml(a.id)}','${escapeHtml(a.type || "eventApplication")}')"><i data-lucide="check"></i>Approve</button>
        <button class="btn btn-danger btn-sm" onclick="rejectApplication('${escapeHtml(a.id)}','${escapeHtml(a.type || "eventApplication")}')"><i data-lucide="x"></i>Reject</button>
        <button class="btn btn-ghost btn-sm" onclick="viewApplication('${escapeHtml(a.id)}')"><i data-lucide="eye"></i>View</button>
      </div>
    </div>`).join("");
  if (window.lucide) lucide.createIcons();
}

async function approveApplication(id, type) {
  const res = await masterApi("approveApplication", { id, type }, "POST");
  toast(res.success ? "Approved" : (res.error || "Failed"), res.success ? "success" : "error");
  loadApplications();
}
async function rejectApplication(id, type) {
  const ok = await confirmDialog({ title: "Reject this application?", message: "The organizer will be notified.", confirmLabel: "Reject" });
  if (!ok) return;
  const res = await masterApi("rejectApplication", { id, type }, "POST");
  toast(res.success ? "Rejected" : (res.error || "Failed"), res.success ? "success" : "error");
  loadApplications();
}
function viewApplication(id) {
  const app = state.applications.find((a) => String(a.id) === String(id));
  toast(app ? `Viewing ${app.eventName || "application"}` : "Application not found", "info");
}

// ============================================================
// AUDIT TRAIL
// ============================================================
async function loadAuditTrail() {
  const timeline = document.getElementById("auditTimeline");
  if (timeline) timeline.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-faint,#94a3b8);">Loading audit trail…</div>`;

  try {
    const res = await masterApi("getAuditTrail");
    if (!res.success && !res.log) {
      renderSectionError("auditTimeline", res.error || "Failed to load audit trail", loadAuditTrail);
      return;
    }
    state.auditLog = res.log || [];
    renderAuditTrail();
  } catch (e) {
    renderSectionError("auditTimeline", e.message || "Unexpected error", loadAuditTrail);
  }
}
function initAuditControls() {
  document.getElementById("auditSearch").addEventListener("input", debounce(renderAuditTrail, 200));
  document.getElementById("auditFilter").addEventListener("change", renderAuditTrail);
}
function renderAuditTrail() {
  const q = (document.getElementById("auditSearch")?.value || "").trim().toLowerCase();
  const filter = document.getElementById("auditFilter")?.value || "";
  const timeline = document.getElementById("auditTimeline");
  const emptyState = document.getElementById("auditEmptyState");

  const rows = state.auditLog.filter((r) => {
    const matchesQuery = !q || [r.user, r.action].some((f) => (f || "").toLowerCase().includes(q));
    const matchesFilter = !filter || r.action === filter;
    return matchesQuery && matchesFilter;
  });

  if (!rows.length) {
    timeline.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  // §6.3: Apps Script web apps cannot see caller IPs without a proxy
  // in front of them — the "IP" field was always empty/misleading, so
  // it's been dropped from the display entirely rather than shown as
  // a blank or fake value.
  timeline.innerHTML = rows.map((r) => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-content">
        <div class="timeline-action">${escapeHtml(r.action)}</div>
        <div class="timeline-meta">${escapeHtml(r.user || "—")} &middot; ${fmtDateTime(r.date, r.time)}</div>
      </div>
    </div>`).join("");
}
// ============================================================
// MASTER DATABASE (§9 — real backup list + fixed Restore)
// ============================================================
async function loadMasterDbInfo() {
  const idEl = document.getElementById("masterDbId");
  const backupEl = document.getElementById("masterDbLastBackup");
  if (idEl) idEl.textContent = "Loading…";

  try {
    const res = await masterApi("getMasterDbInfo");
    if (!res.success && !res.info) {
      renderInlineError(idEl, res.error || "Failed to load");
      if (backupEl) backupEl.textContent = "—";
      return;
    }
    renderMasterDbInfo(res.info || {});
  } catch (e) {
    renderInlineError(idEl, e.message || "Unexpected error");
  }
}

function renderMasterDbInfo(info) {
  document.getElementById("masterDbId").textContent = info.spreadsheetId || "Not connected";
  document.getElementById("masterDbLastBackup").textContent = info.lastBackup ? fmtDate(info.lastBackup) : "No backup yet";

  document.getElementById("openMasterDbBtn").onclick = () => openUrl(sheetUrlFromId(info.spreadsheetId));
  document.getElementById("copyMasterDbIdBtn").onclick = () => copyToClipboard(info.spreadsheetId, "Master Spreadsheet ID copied");
}

async function loadBackupsList() {
  const container = document.getElementById("backupsList");
  if (!container) return;
  container.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-faint,#94a3b8);">Loading backups…</div>`;
  try {
    const res = await masterApi("listMasterBackups");
    if (!res.success && !res.backups) {
      renderSectionError("backupsList", res.error || "Failed to load backups", loadBackupsList);
      return;
    }
    state.backups = res.backups || [];
    renderBackupsList();
  } catch (e) {
    renderSectionError("backupsList", e.message || "Unexpected error", loadBackupsList);
  }
}

function renderBackupsList() {
  const container = document.getElementById("backupsList");
  if (!container) return;
  if (!state.backups.length) {
    container.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-faint,#94a3b8);">No backups yet — create one below.</div>`;
    return;
  }
  container.innerHTML = state.backups.map((b) => `
    <div class="backup-row">
      <div class="backup-row-info">
        <div class="backup-row-name">${escapeHtml(b.fileName || "Backup")}</div>
       <div class="backup-row-meta">${fmtDateTime(b.timestamp)}</div>
      </div>
      <div class="backup-row-actions">
        <button class="btn btn-ghost btn-sm" data-open="${escapeHtml(b.fileId)}"><i data-lucide="external-link"></i>Open</button>
        <button class="btn btn-danger btn-sm" data-restore="${escapeHtml(b.fileId)}"><i data-lucide="rotate-ccw"></i>Restore</button>
      </div>
    </div>`).join("");

  container.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => openUrl(sheetUrlFromId(btn.dataset.open)));
  });
  container.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.addEventListener("click", () => restoreSpecificBackup(btn.dataset.restore));
  });
  if (window.lucide) lucide.createIcons();
}

async function restoreSpecificBackup(backupFileId) {
  const ok = await confirmDialog({
    title: "Restore this backup?",
    message: "This overwrites the live Master Database with this backup's contents.",
    confirmLabel: "Restore",
  });
  if (!ok) return;
  const res = await masterApi("restoreMasterBackup", { backupFileId }, "POST");
  toast(res.success ? "Master Database restored" : (res.error || "Restore failed"), res.success ? "success" : "error");
}

function initMasterDatabaseControls() {
  document.getElementById("createBackupBtn").addEventListener("click", async () => {
    const res = await masterApi("createMasterBackup", {}, "POST");
    toast(res.success ? "Backup created" : (res.error || "Backup failed"), res.success ? "success" : "error");
    loadMasterDbInfo();
    loadBackupsList();
  });

  document.getElementById("downloadMasterBackupBtn").addEventListener("click", async () => {
    const res = await masterApi("downloadMasterBackup");
    if (res.success && res.url) window.open(res.url, "_blank");
    else toast(res.error || "No backup found", "error");
    loadBackupsList();
  });

  // The old single "Restore" button had no way to specify WHICH
  // backup to restore, so it always sent an empty payload and the
  // backend always rejected it with "Missing backupFileId." The
  // button now just scrolls to / focuses the backup list instead of
  // trying to restore blindly.
  const legacyRestoreBtn = document.getElementById("restoreBackupBtn");
  if (legacyRestoreBtn) {
    legacyRestoreBtn.textContent = "";
    legacyRestoreBtn.innerHTML = `<i data-lucide="list"></i> View backups to restore`;
    legacyRestoreBtn.addEventListener("click", () => {
      document.getElementById("backupsList")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
}

// ============================================================
// PROFILE / CHANGE PASSWORD
// ============================================================
function initProfile() {
  document.getElementById("profilePhotoUploadBtn").addEventListener("click", () => document.getElementById("profilePhotoUpload").click());
  document.getElementById("profilePhotoUpload").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      document.getElementById("profilePhotoPreview").innerHTML = `<img src="${reader.result}" alt="Profile photo">`;
      const res = await masterApi("saveProfile", { photoUrl: reader.result }, "POST");
      toast(res.success ? "Photo saved" : "Failed to save photo", res.success ? "success" : "error");
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("profileThemeToggle").addEventListener("change", toggleTheme);
  document.getElementById("profileLogoutBtn").addEventListener("click", logoutMasterAdmin);
}

document.getElementById("changePasswordBtn").addEventListener("click", async () => {
  const current = document.getElementById("pwCurrent").value;
  const next = document.getElementById("pwNew").value;
  const confirmVal = document.getElementById("pwConfirm").value;
  if (!current && current !== "") { toast("Fill in all password fields", "warning"); return; }
  if (next !== confirmVal) { toast("New passwords don't match", "error"); return; }
  const res = await masterApi("changeMasterPassword", { current, next }, "POST");
  toast(res.success ? "Password updated" : (res.error || "Failed"), res.success ? "success" : "error");
  if (res.success) {
    document.getElementById("pwCurrent").value = "";
    document.getElementById("pwNew").value = "";
    document.getElementById("pwConfirm").value = "";
  }
});

// ============================================================
// HEADER ACTIONS
// ============================================================
function initHeader() {
  document.getElementById("themeToggleBtn").addEventListener("click", toggleTheme);
  document.getElementById("logoutBtn").addEventListener("click", logoutMasterAdmin);
  document.getElementById("refreshBtn").addEventListener("click", () => {
    setBackendStatus("pending");
    toast("Refreshing...", "info", 1200);
    loadAllData();
  });
document.getElementById("notifBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = document.getElementById("notifPanel");
    const wasHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (wasHidden) loadNotifications();
  });
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("notifPanel");
    if (!panel || panel.classList.contains("hidden")) return;
    if (!panel.contains(e.target) && e.target.id !== "notifBtn" && !e.target.closest("#notifBtn")) {
      panel.classList.add("hidden");
    }
  });
}

// ============================================================
// PROFILE DATA / EMAIL SETTINGS LOADERS
// ============================================================
async function loadProfileData() {
  try {
    const res = await masterApi("getProfile");
    if (res.success && res.profile) {
      applyProfileData(res.profile);
    } else if (!res.success) {
      console.warn("Profile load failed:", res.error);
    }
  } catch (e) {
    console.warn("Profile load failed:", e.message);
  }
}

function applyProfileData(profile) {
  document.getElementById("profileUsername").value = profile.username || "master";
  if (profile.photoUrl) {
    document.getElementById("profilePhotoPreview").innerHTML = `<img src="${profile.photoUrl}" alt="Profile photo">`;
  }
}

async function loadEmailSettings() {
  try {
    const res = await masterApi("getEmailSettings");
    if (res.success || res.settings) {
      applyEmailSettings(res.settings || {});
    } else {
      console.warn("Email settings load failed:", res.error);
    }
  } catch (e) {
    console.warn("Email settings load failed:", e.message);
  }
}

// ============================================================
// INIT
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initLogin();
  initNavigation();
  initEventsControls();
  initPaymentGateway();
  initEmailSettings();
  initApplicationsControls();
  initAuditControls();
  initMasterDatabaseControls();
  initProfile();
  initHeader();
  if (window.lucide) lucide.createIcons();
});
