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

  // LocalStorage keys
  LS: {
    THEME:          "ep_theme",
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
  sessionStorage.setItem(APP_CONFIG.LS.SELECTED_EID, eid);
  sessionStorage.setItem(APP_CONFIG.LS.SELECTED_EURL, sid);
  sessionStorage.setItem(APP_CONFIG.LS.SELECTED_ENAME, ename);
  localStorage.setItem(APP_CONFIG.LS.SELECTED_EID, eid);
  localStorage.setItem(APP_CONFIG.LS.SELECTED_EURL, sid);
  localStorage.setItem(APP_CONFIG.LS.SELECTED_ENAME, ename);
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
  return true;
}

document.addEventListener("DOMContentLoaded", initTheme);
