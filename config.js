// ============================================================
// EventPay Multi-Event — config.js
// SINGLE SOURCE OF CONFIG. This is the ONLY file that may define
// the Apps Script Web App URL. No other file should declare
// WEB_APP_URL, MASTER_URL, EP.MASTER_URL, or any second URL.
// ============================================================

const APP_CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwifgugRYlVPzbJ7w1Cq-euKA136llg98jJI4Y_QB9LslbcOaNPsggxb7BvcUZuArkf/exec",

  APP_NAME: "EventPay",
  APP_VER: "4.0",
  CURRENCY: "INR",

  // Bump this any time stored event/session data could be stale relative to
  // a new deployment or schema change (new Master DB, new sid format, etc).
  // On load, if the version stamped in storage doesn't match this, all
  // ep_* keys are wiped automatically — see STORAGE VERSIONING below.
  STORAGE_VERSION: "2026-07-10.1",

  // LocalStorage keys
  LS: {
    THEME:          "ep_theme",
    STORAGE_VER:    "ep_storage_version",
    SELECTED_EID:   "ep_selected_eid",    // selected event ID
    SELECTED_EURL:  "ep_selected_eurl",   // NOTE: name kept for backward-compat with older
                                           // pages, but this now stores the event's
                                           // Spreadsheet ID ("sid"), not a second URL.
    SELECTED_ENAME: "ep_selected_ename",
    ADMIN_TOKEN:    "ep_admin_token",
    ADMIN_EXPIRY:   "ep_admin_expiry",
    ADMIN_USER:     "ep_admin_user",
    ADMIN_ROLE:     "ep_admin_role",
  },

  QUICK_AMTS: [101, 251, 501, 1001, 2001, 5001],
};

// ============================================================
// STORAGE VERSIONING (THE STALE-SID FIX)
// ------------------------------------------------------------
// Root cause found: the browser was caching a selected event's "sid" in
// localStorage/sessionStorage indefinitely. After any backend redeploy,
// Master DB change, or simply switching test events, that cached sid kept
// being sent on every request — which is exactly what produced "wrong
// spreadsheet", "You do not have permission...", and even downstream
// 400/CORS-looking failures, despite the backend itself working correctly.
//
// Fix, runs BEFORE anything else in this file touches storage:
//   1. Compare the version stamped in storage to APP_CONFIG.STORAGE_VERSION.
//   2. If it doesn't match (or is missing — e.g. very first load, or an
//      old browser that predates this mechanism), wipe every "ep_*" key
//      from both localStorage and sessionStorage, then stamp the current
//      version. This guarantees no session survives across a version bump.
//   3. Bump APP_CONFIG.STORAGE_VERSION above whenever you deploy a change
//      that could make previously-selected event data stale (new Master
//      DB, changed sid resolution logic, schema change, etc.) — every
//      returning visitor's stale selection is discarded automatically,
//      with zero manual "clear your cache" instructions needed.
// This does NOT run on every page load forever — only when the stamped
// version differs, so normal sessions are untouched.
// ============================================================
(function () {
  try {
    const stamped = localStorage.getItem(APP_CONFIG.LS.STORAGE_VER);
    if (stamped !== APP_CONFIG.STORAGE_VERSION) {
      Object.keys(localStorage)
        .filter(k => k.indexOf("ep_") === 0)
        .forEach(k => localStorage.removeItem(k));
      Object.keys(sessionStorage)
        .filter(k => k.indexOf("ep_") === 0)
        .forEach(k => sessionStorage.removeItem(k));
      localStorage.setItem(APP_CONFIG.LS.STORAGE_VER, APP_CONFIG.STORAGE_VERSION);
    }
  } catch (e) {
    // Storage may be unavailable (private browsing edge cases) — never
    // block page load over this.
  }
})();

// Backward-compat alias only — NOT a second config object. `EP` and
// `APP_CONFIG` point at the exact same object in memory. This exists
// solely so any not-yet-updated page that still references `EP.*`
// doesn't crash with "EP is not defined". Every value still lives in
// APP_CONFIG; nothing is duplicated.
const EP = APP_CONFIG;

// ============================================================
// API CALL HELPER
// Always calls APP_CONFIG.SCRIPT_URL — the ONLY Web App URL in the
// project. Supports both call styles so pages that haven't been
// touched yet keep working without edits:
//   api(action, params, method)              <- new/preferred
//   api(anyUrlArgumentIgnored, action, params, method)  <- legacy shape
// Any URL passed as the first legacy argument is ignored; there is
// only one endpoint now.
// ============================================================
async function api(a, b, c, d) {
  let action, params, method;
  if (typeof b === "string") {
    // legacy shape: api(url, action, params, method) — url ignored
    action = b; params = c || {}; method = d || "GET";
  } else {
    // new shape: api(action, params, method)
    action = a; params = b || {}; method = c || "GET";
  }

  try {
    if (method === "GET") {
      const u = new URL(APP_CONFIG.SCRIPT_URL);
      u.searchParams.set("action", action);
      Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
      const r = await fetch(u.toString());
      return r.json();
    } else {
      const body = new URLSearchParams({ action, ...params });
      const r = await fetch(APP_CONFIG.SCRIPT_URL, { method: "POST", body });
      return r.json();
    }
  } catch (e) {
    return { error: e.message };
  }
}

// Legacy name kept for compatibility with older pages that call
// api(getEventAPI(), "action", {...}) expecting a URL back.
// There is only one URL now, so this just returns it.
function getEventAPI() {
  return APP_CONFIG.SCRIPT_URL;
}

// Current event's Spreadsheet ID ("sid") — pass this as params.sid
// (or params.eventCode, both are accepted by the backend) on every
// per-event API call.
function getEventSID() {
  return sessionStorage.getItem(APP_CONFIG.LS.SELECTED_EURL) ||
         localStorage.getItem(APP_CONFIG.LS.SELECTED_EURL) || "";
}

function setSelectedEvent(eid, sid, ename) {
  // Always re-stamp the current storage version on every write, too —
  // belt-and-braces in case a page calls this before the version-check
  // IIFE above has run for some reason (e.g. script load order changes).
  localStorage.setItem(APP_CONFIG.LS.STORAGE_VER, APP_CONFIG.STORAGE_VERSION);
  sessionStorage.setItem(APP_CONFIG.LS.SELECTED_EID, eid);
  sessionStorage.setItem(APP_CONFIG.LS.SELECTED_EURL, sid);
  sessionStorage.setItem(APP_CONFIG.LS.SELECTED_ENAME, ename);
  localStorage.setItem(APP_CONFIG.LS.SELECTED_EID, eid);
  localStorage.setItem(APP_CONFIG.LS.SELECTED_EURL, sid);
  localStorage.setItem(APP_CONFIG.LS.SELECTED_ENAME, ename);
}

// Clears just the selected-event fields (not theme/admin session), used
// when a stored event turns out to be invalid/inactive so the user falls
// back to picking one again instead of silently reusing bad data.
function clearSelectedEvent() {
  [APP_CONFIG.LS.SELECTED_EID, APP_CONFIG.LS.SELECTED_EURL, APP_CONFIG.LS.SELECTED_ENAME].forEach(k => {
    sessionStorage.removeItem(k);
    localStorage.removeItem(k);
  });
}

// ============================================================
// LIVE VALIDATION OF THE STORED EVENT
// ------------------------------------------------------------
// The version-wipe above handles staleness across deployments, but a
// stored sid can also go bad WITHOUT a deployment — e.g. the event was
// deactivated, deleted from the registry, or simply belongs to a
// different test session than what's now in the Master DB. This checks
// the currently stored sid against the live "getEvents" registry and
// clears it if it's no longer a valid, active event.
//
// Cheap to call: results are cached for this page load (sessionStorage
// flag) so it only hits the network once per tab per event selection,
// not on every single api() call.
// ============================================================
async function validateSelectedEvent() {
  const sid = getEventSID();
  if (!sid) return true; // nothing selected — nothing to validate

  const cacheKey = "ep_sid_validated_" + sid;
  if (sessionStorage.getItem(cacheKey) === "1") return true;

  try {
    const res = await api("getEvents", {}, "GET");
    const events = (res && res.events) || [];
    const stillValid = events.some(ev => String(ev.SpreadsheetID || "").trim() === sid);
    if (!stillValid) {
      clearSelectedEvent();
      return false;
    }
    sessionStorage.setItem(cacheKey, "1");
    return true;
  } catch (e) {
    // Network/validation failure shouldn't itself wipe a possibly-good
    // session — fail open and let the actual page request surface any
    // real error instead.
    return true;
  }
}

// ============================================================
// EVENT CACHE — load once, reuse everywhere, expire automatically
// ------------------------------------------------------------
// Instead of every page independently calling api("getSettings", {sid})
// on load, this loads the selected event's Settings once, stores it in
// localStorage keyed to that sid, and every page reuses it until it
// expires (10 minutes) or a different event is selected. This cuts
// redundant Apps Script calls and guarantees every page is reading the
// exact same settings snapshot for the current event.
//
// Cache shape (localStorage key: ep_event_cache):
//   { sid, eventName, settings, loadedTime }
//
// Master DB is NOT involved here — this reads directly from the
// selected event's own spreadsheet via the existing getSettings action
// (which already resolves via sid, never the Master DB).
// ============================================================
const EVENT_CACHE_KEY = "ep_event_cache";
const EVENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getEventCache() {
  try {
    const raw = localStorage.getItem(EVENT_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    const sid = getEventSID();
    if (!cache || cache.sid !== sid) return null;              // different event selected — stale
    if (Date.now() - cache.loadedTime > EVENT_CACHE_TTL_MS) return null; // expired
    return cache;
  } catch (e) {
    return null;
  }
}

function setEventCache(sid, eventName, settings) {
  try {
    localStorage.setItem(EVENT_CACHE_KEY, JSON.stringify({
      sid: sid, eventName: eventName, settings: settings, loadedTime: Date.now()
    }));
  } catch (e) { /* storage full/unavailable — cache is a pure optimization, safe to skip */ }
}

function clearEventCache() {
  try { localStorage.removeItem(EVENT_CACHE_KEY); } catch (e) {}
}

// Drop-in replacement for `api("getSettings", {})` — same return shape
// (the flat Settings object), but serves from cache when valid instead
// of hitting the backend every time. Pages can swap:
//   const settings = await api("getSettings", {});
// for:
//   const settings = await getEventSettingsCached();
// with no other changes needed.
async function getEventSettingsCached(forceRefresh) {
  if (!forceRefresh) {
    const cached = getEventCache();
    if (cached) return cached.settings;
  }
  const settings = await api("getSettings", {});
  setEventCache(getEventSID(), getSelectedEventName(), settings);
  return settings;
}

function getSelectedEventName() {
  return sessionStorage.getItem(APP_CONFIG.LS.SELECTED_ENAME) ||
         localStorage.getItem(APP_CONFIG.LS.SELECTED_ENAME) || "";
}

// ============================================================
// EVENT SELECTION + FULL PRELOAD (used by index.html's event cards)
// ------------------------------------------------------------
// Runs the full "select event → load everything → then navigate" flow
// described in the loading-experience spec: clears any previous event's
// cache/sid, stamps the new one, pulls Settings (+ villages + gallery so
// they're warm for home.html/gallery.html), caches it, and only THEN
// redirects to home.html. Reports progress via onStep(label) so the
// caller can drive a progress UI.
// ============================================================
async function selectEventAndLoad(eid, sid, ename, onStep) {
  const step = (label) => { try { onStep && onStep(label); } catch (e) {} };

  step("Selecting event...");
  clearEventCache();          // drop any previous event's cached settings
  clearSelectedEvent();       // drop any previous sid/eid/ename
  setSelectedEvent(eid, sid, ename);

  // This event was just confirmed live against the Master Database (it
  // came from the getEvents()/searchEvent() list rendered on this very
  // page). Mark it pre-validated so the destination page's requireEvent()
  // does NOT immediately re-query the Master Database again — that
  // redundant re-check right after selection was the root cause of the
  // false "event no longer available" toast.
  try { sessionStorage.setItem("ep_sid_validated_" + sid, "1"); } catch (e) {}

  step("Loading settings...");
  let settings = {};
  try { settings = await api("getSettings", {}); } catch (e) {}
  setEventCache(sid, ename, settings);

  // Best-effort warm-up of secondary data. These are cheap GETs and are
  // allowed to fail silently — home.html/gallery.html will simply fetch
  // them fresh (uncached) if this pre-warm didn't succeed for any reason.
  step("Loading gallery...");
  try { await api("getGalleryImages", {}); } catch (e) {}

  step("Loading villages...");
  try { await api("getVillageSuggestions", {}); } catch (e) {}

  step("Done");
  return settings;
}

// ============================================================
// AUTO-SID INJECTION (THE MULTI-EVENT FIX)
// ------------------------------------------------------------
// Root cause of "every page loads the default/Ram&Sita spreadsheet":
// home.html, donors.html, gallery.html, status.html, invite.html,
// complaint.html, admin.html and admin-login.html all call the
// backend with plain fetch(APP_CONFIG.SCRIPT_URL + "?action=...")
// or fetch(APP_CONFIG.SCRIPT_URL, {method:"POST", body:...}) and
// NONE of them ever attached "sid". The backend's resolveSid_()
// was already correct (it checks p.sid first) — it just never
// received one, so it always fell through to DEFAULT_SPREADSHEET_ID.
//
// Rather than hand-edit 30+ scattered fetch() call sites (fragile —
// one missed spot silently reintroduces this exact bug), every
// request the app makes to APP_CONFIG.SCRIPT_URL is intercepted
// here, ONE time, and "sid" is attached automatically from the
// currently selected event (getEventSID()) if the caller didn't
// already set one. This makes sid behave like a global header:
// no page has to remember it, and no future page can forget it.
//
// Safe by construction:
//  - Only touches requests whose URL starts with our own backend URL.
//  - Never overwrites a sid a caller explicitly set.
//  - If no event is selected yet (e.g. on index.html before Enter is
//    clicked), getEventSID() is "" and nothing is injected — actions
//    like getEvents/searchEvent that read the Master DB are unaffected
//    since the backend only consults sid for per-event actions.
// ============================================================
(function () {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const isPlainString = typeof input === "string";
      const urlStr = isPlainString ? input : (input && input.url);
      if (urlStr && typeof APP_CONFIG !== "undefined" && urlStr.indexOf(APP_CONFIG.SCRIPT_URL) === 0) {
        const sid = getEventSID();
        if (sid) {
          const isPost = init && init.method && String(init.method).toUpperCase() === "POST";
          if (isPost) {
            if (init.body instanceof URLSearchParams) {
              if (!init.body.has("sid")) init.body.append("sid", sid);
            } else if (typeof init.body === "string") {
              const bodyParams = new URLSearchParams(init.body);
              if (!bodyParams.has("sid")) {
                bodyParams.append("sid", sid);
                init = Object.assign({}, init, { body: bodyParams.toString() });
              }
            }
          } else {
            const u = new URL(urlStr, window.location.href);
            if (!u.searchParams.has("sid")) {
              u.searchParams.set("sid", sid);
              input = isPlainString ? u.toString() : new Request(u.toString(), input);
            }
          }
        }
      }
    } catch (e) {
      // Never let the sid shim break a request — fall through to the
      // original call unmodified if anything above goes wrong.
    }
    return nativeFetch(input, init);
  };
})();

// ============================================================
// THEME
// ============================================================
function initTheme() {
  const t = localStorage.getItem(APP_CONFIG.LS.THEME) || "dark";
  document.documentElement.setAttribute("data-theme", t);
  const btn = document.getElementById("themeBtn");
  if (btn) btn.textContent = t === "dark" ? "☀️" : "🌙";
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(APP_CONFIG.LS.THEME, next);
  const btn = document.getElementById("themeBtn");
  if (btn) btn.textContent = next === "dark" ? "☀️" : "🌙";
}

// ============================================================
// TOAST
// ============================================================
function toast(msg, type = "info", dur = 3500) {
  const tc = document.getElementById("toastContainer");
  if (!tc) return;
  const el = document.createElement("div");
  el.className = "toast " + type;
  const icons = { success:"✅", error:"❌", warning:"⚠️", info:"ℹ️" };
  el.innerHTML = `<span>${icons[type]||""}</span><span>${msg}</span>`;
  tc.appendChild(el);
  setTimeout(() => { el.classList.add("fade-out"); setTimeout(() => el.remove(), 350); }, dur);
}

// ============================================================
// FORMAT
// ============================================================
function fmtINR(n) { return "₹" + Number(n||0).toLocaleString("en-IN"); }
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d); if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
}
function sanitize(s) { const d=document.createElement("div"); d.textContent=s||""; return d.innerHTML; }

// ============================================================
// MOBILE MENU
// ============================================================
function toggleMobileMenu() {
  const m = document.getElementById("mobileMenu");
  if (m) m.classList.toggle("open");
}

// ============================================================
// GUARD — redirect if no event selected
// ============================================================
function requireEvent() {
  const sid = getEventSID();
  if (!sid) {
    window.location.href = "index.html";
    return false;
  }

  // Master DB revalidation ONLY happens here if the local event cache has
  // actually expired (10 min TTL) or was never populated for this sid.
  // A warm cache means this event was already confirmed valid recently
  // (either at selection time, or by a previous expired-cache refresh),
  // so we trust it completely and never touch the Master DB — this is
  // what stops the false "event no longer available" toast that used to
  // fire on every page load right after a successful selection.
  const cached = getEventCache();
  if (!cached) {
    validateSelectedEvent().then(stillValid => {
      if (!stillValid) {
        toast("That event is no longer available — please pick again.", "warning");
        setTimeout(() => { window.location.href = "index.html"; }, 1200);
      } else {
        // Confirmed still active — refresh the cache now so subsequent
        // pages in this tab don't need another Master DB round-trip
        // until this new cache window itself expires.
        getEventSettingsCached(true).catch(() => {});
      }
    });
  }
  return true;
}

document.addEventListener("DOMContentLoaded", initTheme);



function getCachedEventData() {
    try {
        const data = JSON.parse(sessionStorage.getItem(EVENT_CACHE_KEY) || "{}");

        if (!data.time) return null;

        if (Date.now() - data.time > 10 * 60 * 1000) {
            sessionStorage.removeItem(EVENT_CACHE_KEY);
            return null;
        }

        return data;
    } catch(e){
        return null;
    }
}

function saveCachedEventData(data){
    sessionStorage.setItem(EVENT_CACHE_KEY, JSON.stringify({
        time: Date.now(),
        ...data
    }));
}



