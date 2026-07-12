// ============================================================
// EventPay — master-admin_login.js
// MASTER ADMIN dashboard. Manages ONLY the Master Database — this
// is NOT an event admin panel. Frontend only: every backend call is
// a clearly-marked placeholder function ready for Apps Script wiring.
//
// Authentication: there is exactly ONE master admin. Login is
// password-only (no username) — checked against the MASTER-ADMIN-PASS
// Apps Script Property on the backend. See loginMasterAdmin().
// ============================================================

// ------------------------------------------------------------
// CONFIG — mirrors the shape of the app's shared config.js so this
// page can be wired to the same backend with minimal changes later.
// Replace SCRIPT_URL with the project's Apps Script Web App URL, or
// leave as-is and let a shared config.js (loaded before this file)
// define window.APP_CONFIG instead.
// ------------------------------------------------------------
const MASTER_CONFIG = {
  SCRIPT_URL: APP_CONFIG.SCRIPT_URL,
  SESSION_MINUTES: 60,
  LS: {
    TOKEN: "ep_master_token",
    EXPIRY: "ep_master_expiry",
    REMEMBER: "ep_master_remember",
    THEME: "ep_theme"
  }
};

// ============================================================
// STATE — single in-memory store for this page. Nothing here is
// persisted except the auth token/expiry (and only if the backend
// issues one) and the theme preference.
// ============================================================
const state = {
  events: [],          // full event list from Master DB (getEvents-style action)
  filteredEvents: [],
  eventsPage: 1,
  eventsPageSize: 10,
  selectedEvent: null,
  applications: [],
  auditLog: [],
  plans: [],
  globalSettings: [],
  sessionSecondsLeft: MASTER_CONFIG.SESSION_MINUTES * 60,
  sessionTimerHandle: null,
};

// ============================================================
// GENERIC API HELPER
// Every backend call funnels through here. Talks to the Apps Script
// Web App deployed from master-admin-backend.gs. The session token
// (from masterLogin) is attached to every call automatically except
// masterLogin itself.
// ============================================================
async function masterApi(action, params = {}, method = "GET") {
  if (!MASTER_CONFIG.SCRIPT_URL) {
    console.warn(`[masterApi] SCRIPT_URL not configured — action "${action}" skipped.`);
    return { success: false, error: "Backend not connected yet." };
  }

  const token = action === "masterLogin" ? null : localStorage.getItem(MASTER_CONFIG.LS.TOKEN);
  const fullParams = token ? { ...params, token } : params;

  try {
    if (method === "GET") {
      const url = new URL(MASTER_CONFIG.SCRIPT_URL);
      url.searchParams.set("action", action);
      Object.entries(fullParams).forEach(([k, v]) => url.searchParams.set(k, String(v)));
      const res = await fetch(url.toString());
      return await res.json();
    } else {
      const body = new URLSearchParams({ action, ...fullParams });
      const res = await fetch(MASTER_CONFIG.SCRIPT_URL, { method: "POST", body });
      const text = await res.text();
      try { return JSON.parse(text); } catch (e) { return { success: false, error: "Invalid response from server", raw: text }; }
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
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
// CONFIRM DIALOG — generic reusable confirmation, used by every
// destructive action (deactivate, delete, restore backup, etc).
// Usage: confirmDialog({ title, message, confirmLabel }).then(ok => ...)
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
// Lucide's createIcons() replaces each <i data-lucide="..."> with a
// real <svg> element, so re-querying for "i" after the first render
// finds nothing. This helper resets the icon slot's HTML back to a
// fresh <i data-lucide> before re-running createIcons(), so it's safe
// to call repeatedly (e.g. toggling eye/eye-off, moon/sun).
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
// LOGIN FLOW (password only — single master admin)
// ============================================================
function initLogin() {
  const form = document.getElementById("loginForm");
  const pwInput = document.getElementById("masterPassword");
  const toggleBtn = document.getElementById("togglePasswordBtn");
  const errorEl = document.getElementById("loginError");

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

  // Auto-login if a valid remembered session exists.
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

// Checks the single MASTER-ADMIN-PASS property on the backend via the
// masterLogin action and stores the returned session token.
async function loginMasterAdmin(password, remember) {
  const res = await masterApi("masterLogin", { password }, "POST");
  if (!res.success) {
    return { success: false, error: res.error || "Incorrect master password." };
  }

  const expiry = Date.now() + (res.expiresInSeconds || MASTER_CONFIG.SESSION_MINUTES * 60) * 1000;
  localStorage.setItem(MASTER_CONFIG.LS.TOKEN, res.token);
  localStorage.setItem(MASTER_CONFIG.LS.EXPIRY, String(expiry));
  localStorage.setItem(MASTER_CONFIG.LS.REMEMBER, remember ? "1" : "0");
  return { success: true };
}

function hasValidSession() {
  const expiry = Number(localStorage.getItem(MASTER_CONFIG.LS.EXPIRY) || 0);
  return localStorage.getItem(MASTER_CONFIG.LS.REMEMBER) === "1" && expiry > Date.now();
}

function enterDashboard() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("dashboardShell").classList.remove("hidden");
  if (window.lucide) lucide.createIcons();
  startSessionTimer();
  loadAllData();
}

function logoutMasterAdmin() {
  localStorage.removeItem(MASTER_CONFIG.LS.TOKEN);
  localStorage.removeItem(MASTER_CONFIG.LS.EXPIRY);
  localStorage.removeItem(MASTER_CONFIG.LS.REMEMBER);
  stopSessionTimer();
  document.getElementById("dashboardShell").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("masterPassword").value = "";
  toast("Logged out", "info");
}

// ============================================================
// SESSION TIMER
// ============================================================
function startSessionTimer() {
  state.sessionSecondsLeft = MASTER_CONFIG.SESSION_MINUTES * 60;
  updateSessionTimerText();
  stopSessionTimer();
  state.sessionTimerHandle = setInterval(() => {
    state.sessionSecondsLeft--;
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
// DATA LOADING — placeholder calls, all can fail silently since
// every render function tolerates empty state.
// ============================================================
async function loadAllData() {
  await Promise.all([
    loadStats(),
    loadEvents(),
    loadGlobalSettings(),
    loadPlans(),
    loadApplications(),
    loadAuditTrail(),
    loadMasterDbInfo(),
  ]);
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
  // TODO(backend): const res = await masterApi("getPlatformStats");
  const res = await masterApi("getPlatformStats");
  const stats = res.stats || {}; // all zero/undefined until backend connected
  renderStatCards(stats);
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

// Simple count-up animation for numeric stat cards.
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

// ============================================================
// EVENTS TABLE
// ============================================================
async function loadEvents() {
  // TODO(backend): const res = await masterApi("getEvents");
  const res = await masterApi("getEvents");
  state.events = res.events || [];
  applyEventsFilters();
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
    return matchesQuery && matchesStatus && matchesPlan;
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
          <button class="icon-btn" title="Deactivate" onclick="deactivateEvent('${escapeHtml(ev.eventId)}')"><i data-lucide="power"></i></button>
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
  // TODO(backend): could also request a server-generated export.
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

// ---------------- row action placeholders ----------------
async function deactivateEvent(eventId) {
  const ok = await confirmDialog({
    title: "Deactivate this event?",
    message: "Organizers and attendees will lose access until it's reactivated.",
    confirmLabel: "Deactivate",
  });
  if (!ok) return;
  // TODO(backend): await masterApi("deactivateEvent", { eventId }, "POST");
  toast("Event deactivated", "success");
  loadEvents();
}
async function deleteEvent(eventId) {
  const ok = await confirmDialog({
    title: "Delete this event permanently?",
    message: "This removes the event from the Master Database. Its spreadsheet and Drive folder are not affected.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  // TODO(backend): await masterApi("deleteEvent", { eventId }, "POST");
  toast("Event deleted", "success");
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
  // TODO(backend): await masterApi("downloadEventBackup", { eventId: ev.eventId });
  toast("Backup requested — this will download once the backend is connected", "info");
}

// ---------------- Spreadsheet Preview ----------------
async function loadSpreadsheetPreview() {
  const ev = state.selectedEvent;
  if (!ev) return;
  const container = document.getElementById("sheetPreview");
  container.classList.remove("hidden");

  // TODO(backend): const res = await masterApi("getSpreadsheetPreview", { sid: ev.spreadsheetId });
  const res = await masterApi("getSpreadsheetPreview", { sid: ev.spreadsheetId });
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
    table.innerHTML = `<tr><td style="padding:20px;text-align:center;color:var(--text-faint)">No data in this sheet yet — read-only preview will populate once the backend is connected.</td></tr>`;
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
// GLOBAL SETTINGS (toggle cards, no tables)
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
  // TODO(backend): const res = await masterApi("getGlobalSettings");
  const res = await masterApi("getGlobalSettings");
  state.globalSettings = res.settings || {};
  renderGlobalSettings();
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
  // TODO(backend): await masterApi("saveGlobalSettings", payload, "POST");
  toast("Global settings saved", "success");
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
  // TODO(backend): const res = await masterApi("getSubscriptionPlans");
  const res = await masterApi("getSubscriptionPlans");
  state.plans = (res.plans && res.plans.length) ? res.plans : DEFAULT_PLANS;
  renderPlans();
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
  // TODO(backend): await masterApi("updatePlanPrice", { planId, price }, "POST");
  toast(`${planId} plan price updated to ${fmtINR(price)}`, "success");
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
    // TODO(backend): await masterApi("savePaymentGatewaySettings", payload, "POST");
    toast("Payment gateway settings saved", "success");
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
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("sendTestEmailBtn").addEventListener("click", async () => {
    // TODO(backend): await masterApi("sendTestEmail", {}, "POST");
    toast("Test email queued", "info");
  });
  document.getElementById("saveEmailSettingsBtn").addEventListener("click", async () => {
    const payload = {
      senderName: document.getElementById("esSenderName").value,
      replyEmail: document.getElementById("esReplyEmail").value,
      supportEmail: document.getElementById("esSupportEmail").value,
      orgEmail: document.getElementById("esOrgEmail").value,
      footer: document.getElementById("esFooter").value,
      signature: document.getElementById("esSignature").value,
    };
    // TODO(backend): await masterApi("saveEmailSettings", payload, "POST");
    toast("Email settings saved", "success");
  });
}

// ============================================================
// APPLICATIONS
// ============================================================
async function loadApplications() {
  // TODO(backend): const res = await masterApi("getPendingApplications");
  const res = await masterApi("getPendingApplications");
  state.applications = res.applications || [];
  document.getElementById("applicationsBadge").textContent = state.applications.filter((a) => a.status === "pending").length;
  renderApplications();
}

function initApplicationsControls() {
  document.getElementById("applicationsSearch").addEventListener("input", debounce(renderApplications, 200));
  document.getElementById("applicationsFilter").addEventListener("change", renderApplications);
}

function renderApplications() {
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
        <span class="application-card-name">${escapeHtml(a.eventName || "Untitled event")}</span>
        <span class="badge ${a.status === "approved" ? "badge-active" : a.status === "rejected" ? "badge-expired" : "badge-pending"}">${escapeHtml(a.status || "pending")}</span>
      </div>
      <div class="application-card-meta">
        <span>${escapeHtml(a.name || "")}</span>
        <span>${escapeHtml(a.email || "")}</span>
        <span>${fmtDate(a.submittedDate)}</span>
      </div>
      <div class="application-card-actions">
        <button class="btn btn-primary btn-sm" onclick="approveApplication('${escapeHtml(a.id)}')"><i data-lucide="check"></i>Approve</button>
        <button class="btn btn-danger btn-sm" onclick="rejectApplication('${escapeHtml(a.id)}')"><i data-lucide="x"></i>Reject</button>
        <button class="btn btn-ghost btn-sm" onclick="viewApplication('${escapeHtml(a.id)}')"><i data-lucide="eye"></i>View</button>
      </div>
    </div>`).join("");
  if (window.lucide) lucide.createIcons();
}

async function approveApplication(id) {
  // TODO(backend): await masterApi("approveApplication", { id }, "POST");
  toast("Application approved", "success");
  loadApplications();
}
async function rejectApplication(id) {
  const ok = await confirmDialog({ title: "Reject this application?", message: "The organizer will be notified.", confirmLabel: "Reject" });
  if (!ok) return;
  // TODO(backend): await masterApi("rejectApplication", { id }, "POST");
  toast("Application rejected", "success");
  loadApplications();
}
function viewApplication(id) {
  const app = state.applications.find((a) => String(a.id) === String(id));
  toast(app ? `Viewing ${app.eventName || "application"}` : "Application not found", "info");
  // TODO: open a details modal once the backend supplies full application data.
}

// ============================================================
// AUDIT TRAIL
// ============================================================
async function loadAuditTrail() {
  // TODO(backend): const res = await masterApi("getAuditTrail");
  const res = await masterApi("getAuditTrail");
  state.auditLog = res.log || [];
  renderAuditTrail();
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
    const matchesQuery = !q || [r.user, r.action, r.ip].some((f) => (f || "").toLowerCase().includes(q));
    const matchesFilter = !filter || r.action === filter;
    return matchesQuery && matchesFilter;
  });

  if (!rows.length) {
    timeline.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  timeline.innerHTML = rows.map((r) => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-content">
        <div class="timeline-action">${escapeHtml(r.action)}</div>
        <div class="timeline-meta">${escapeHtml(r.user || "—")} &middot; ${fmtDate(r.date)} ${escapeHtml(r.time || "")} &middot; ${escapeHtml(r.ip || "—")}</div>
      </div>
    </div>`).join("");
}

// ============================================================
// MASTER DATABASE
// ============================================================
async function loadMasterDbInfo() {
  // TODO(backend): const res = await masterApi("getMasterDbInfo");
  const res = await masterApi("getMasterDbInfo");
  const info = res.info || {};
  document.getElementById("masterDbId").textContent = info.spreadsheetId || "Not connected";
  document.getElementById("masterDbLastBackup").textContent = info.lastBackup ? fmtDate(info.lastBackup) : "No backup yet";

  document.getElementById("openMasterDbBtn").onclick = () => openUrl(sheetUrlFromId(info.spreadsheetId));
  document.getElementById("copyMasterDbIdBtn").onclick = () => copyToClipboard(info.spreadsheetId, "Master Spreadsheet ID copied");
}
function initMasterDatabaseControls() {
  document.getElementById("downloadMasterBackupBtn").addEventListener("click", async () => {
    // TODO(backend): await masterApi("downloadMasterBackup");
    toast("Backup download requested", "info");
  });
  document.getElementById("createBackupBtn").addEventListener("click", async () => {
    // TODO(backend): await masterApi("createMasterBackup", {}, "POST");
    toast("Backup created", "success");
    loadMasterDbInfo();
  });
  document.getElementById("restoreBackupBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Restore Master Database?",
      message: "This will overwrite the current Master Database with the selected backup. This cannot be undone.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    // TODO(backend): await masterApi("restoreMasterBackup", {}, "POST");
    toast("Master Database restored", "success");
  });
}

// ============================================================
// PROFILE
// ============================================================
function initProfile() {
  document.getElementById("profilePhotoUploadBtn").addEventListener("click", () => document.getElementById("profilePhotoUpload").click());
  document.getElementById("profilePhotoUpload").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById("profilePhotoPreview").innerHTML = `<img src="${reader.result}" alt="Profile photo">`;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("changePasswordBtn").addEventListener("click", async () => {
    const current = document.getElementById("pwCurrent").value;
    const next = document.getElementById("pwNew").value;
    const confirm = document.getElementById("pwConfirm").value;
    if (!current || !next) { toast("Fill in all password fields", "warning"); return; }
    if (next !== confirm) { toast("New passwords don't match", "error"); return; }
    // TODO(backend): await masterApi("changeMasterPassword", { current, next }, "POST");
    toast("Password updated", "success");
    document.getElementById("pwCurrent").value = "";
    document.getElementById("pwNew").value = "";
    document.getElementById("pwConfirm").value = "";
  });

  document.getElementById("profileThemeToggle").addEventListener("change", toggleTheme);
  document.getElementById("profileLogoutBtn").addEventListener("click", logoutMasterAdmin);
}

// ============================================================
// HEADER ACTIONS
// ============================================================
function initHeader() {
  document.getElementById("themeToggleBtn").addEventListener("click", toggleTheme);
  document.getElementById("logoutBtn").addEventListener("click", logoutMasterAdmin);
  document.getElementById("refreshBtn").addEventListener("click", () => {
    toast("Refreshing...", "info", 1200);
    loadAllData();
  });
  document.getElementById("notifBtn").addEventListener("click", () => {
    toast("No new notifications", "info");
  });
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
