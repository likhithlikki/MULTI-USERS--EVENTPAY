// ============================================================
// EventPay Multi-Event — config.js
// ============================================================

const APP_CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwUbQf4-MhVkjQzbCGUY0kAaNXlzB5nI6CZzBRH2zLI7XVworB6V0EB8WdarNZeLhRGAA/exec",


  APP_NAME: "EventPay",
  APP_VER: "4.0",
  CURRENCY: "INR",

  // LocalStorage keys
  LS: {
    THEME:        "ep_theme",
    SELECTED_EID: "ep_selected_eid",    // selected event ID
    SELECTED_EURL:"ep_selected_eurl",   // selected event API URL
    SELECTED_ENAME:"ep_selected_ename", // selected event name
    ADMIN_TOKEN:  "ep_admin_token",
    ADMIN_EXPIRY: "ep_admin_expiry",
    ADMIN_USER:   "ep_admin_user",
    ADMIN_ROLE:   "ep_admin_role",
  },

  QUICK_AMTS: [101, 251, 501, 1001, 2001, 5001],
};

// ============================================================
// API CALL HELPER
// url can be MASTER_URL or a per-event script URL
// ============================================================
async function api(url, action, params = {}, method = "GET") {
  try {
    if (method === "GET") {
      const u = new URL(url);
      u.searchParams.set("action", action);
      Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
      const r = await fetch(u.toString());
      return r.json();
    } else {
      const body = new URLSearchParams({ action, ...params });
      const r = await fetch(url, { method: "POST", body });
      return r.json();
    }
  } catch(e) {
    return { error: e.message };
  }
}

// Get current event API URL from sessionStorage/localStorage
function getEventAPI() {
  return sessionStorage.getItem(EP.LS.SELECTED_EURL) ||
         localStorage.getItem(EP.LS.SELECTED_EURL) || "";
}

function setSelectedEvent(eid, apiUrl, ename) {
  sessionStorage.setItem(EP.LS.SELECTED_EID, eid);
  sessionStorage.setItem(EP.LS.SELECTED_EURL, apiUrl);
  sessionStorage.setItem(EP.LS.SELECTED_ENAME, ename);
  localStorage.setItem(EP.LS.SELECTED_EID, eid);
  localStorage.setItem(EP.LS.SELECTED_EURL, apiUrl);
  localStorage.setItem(EP.LS.SELECTED_ENAME, ename);
}

// ============================================================
// THEME
// ============================================================
function initTheme() {
  const t = localStorage.getItem(EP.LS.THEME) || "dark";
  document.documentElement.setAttribute("data-theme", t);
  const btn = document.getElementById("themeBtn");
  if (btn) btn.textContent = t === "dark" ? "☀️" : "🌙";
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(EP.LS.THEME, next);
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
  const url = getEventAPI();
  if (!url) {
    window.location.href = "index.html";
    return false;
  }
  return true;
}

document.addEventListener("DOMContentLoaded", initTheme);
