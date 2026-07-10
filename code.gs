// ============================================================
// EventPay — Code.gs  (SINGLE unified backend, single router)
// ============================================================
// This file is the ONLY .gs file in this project that may define
// doGet / doPost / handleAction. Do NOT paste a second copy of any
// of these functions anywhere else in the project (Apps Script
// treats every .gs file as one shared global scope — a duplicate
// function name anywhere breaks the ENTIRE project at parse time
// with "Identifier ... has already been declared").
//
// ------------------------------------------------------------
// UPDATE (multi-event fix): resolveSid_() below was already correct
// — it checks p.sid first, then eventCode, then falls back to
// DEFAULT_SPREADSHEET_ID. The bug was never in this file: it was
// that every frontend page called the backend without ever sending
// "sid" in the first place, so resolveSid_() had nothing to resolve
// and always fell through to the default. That's fixed in config.js
// (a single fetch() interceptor now attaches sid to every request
// automatically). This file only adds: (a) Logger.log tracing inside
// resolveSid_ so you can confirm from Executions which spreadsheet
// each request actually resolved to, and (b) getCurrentSpreadsheet(p),
// a thin named wrapper around SpreadsheetApp.openById(resolveSid_(p))
// for any NEW code you add later, so future functions have one
// obvious helper to call instead of reaching for openById() directly.
// Every existing function below already goes through resolveSid_()
// correctly and is left as-is to avoid risking working code.
// ------------------------------------------------------------
//
// WHAT THIS FILE FIXES vs the previous "NEW" backend:
//   1. Response shape. Every page (home.html, donors.html, status.html,
//      gallery.html, invite.html, complaint.html, admin.html,
//      admin-login.html) is the OLD, working frontend. It expects FLAT
//      JSON back — {result:"Inserted"}, {donors:[...]}, {success:true,...}
//      — never {success:true, data:{...}}. The previous backend wrapped
//      everything in success/data, which is why every page looked broken
//      even though nothing was "wrong" on screen: the JS was reading
//      res.donors / res.payments / res.result and always getting undefined.
//   2. Action names. The frontend calls insertPayment, validateUTR,
//      getVillageSuggestions, getRecentTransactions, getPublicPayments,
//      getGalleryImages, loginAdmin, getPayments, updatePayments,
//      getComplaints, updateComplaint, insertComplaint, updateSettings,
//      getAuditLog, getActivity, getSheetsList/getSheetData/updateSheetCell/
//      addSheetRow/deleteSheetRow, undoActions, addUTRBlacklist,
//      getUTRBlacklist, addVillageSuggestion — the previous backend had
//      renamed or dropped most of these (e.g. only had createPaymentOrder/
//      verifyPayment instead of insertPayment), which is exactly the
//      "Unknown backend action: insertPayment" error you saw.
//   3. "+" in event names. Apps Script's manual form-decoder used
//      decodeURIComponent() directly on POST bodies. decodeURIComponent
//      does NOT turn "+" into a space (only %XX is a real escape to it —
//      "+" is a raw character as far as decodeURIComponent is concerned).
//      Since browsers submit spaces as "+" in
//      application/x-www-form-urlencoded bodies, "Birthday of Likith"
//      was arriving as "Birthday+of+Likith" and getting stored that way.
//      Fixed below in doPost() and with a cleanText_() helper used
//      everywhere a name is displayed or turned into a folder name.
//   4. Missing sheets/columns. Folders, gallery, complaints, and admin
//      login now use header-based lookups (getColMap) everywhere, so
//      adding a column never breaks anything, and sheets are created
//      automatically if missing instead of throwing.
//
// HOW MULTI-EVENT WORKS NOW (fully backward compatible):
//   - If a request includes "sid" (a Spreadsheet ID) or "eventCode",
//     that event's spreadsheet is used.
//   - If neither is present, DEFAULT_SPREADSHEET_ID below is used —
//     i.e. every page in this bundle keeps working exactly like the
//     single-event version, with ZERO changes needed to any .html/.js
//     file, because config.js now attaches sid to every request itself.
//   - config.js reads the selected event's Spreadsheet ID from
//     localStorage/sessionStorage (set by index.html's selectEvent())
//     and attaches it as "sid" to every fetch() call automatically.
// ============================================================

// ---- Legacy single-event spreadsheet (kept so nothing needs sid/eventCode) ----
const DEFAULT_SPREADSHEET_ID = "1TsSOerv8tI1oqxrlhdJts5hEyTbY5sfu8m3AD3XxZjM";

// ---- Public site URLs used only by the Apply-Event confirmation email ----
const PUBLIC_BASE_URL = "https://likhithlikki.github.io/MULTI-USERS--EVENTPAY/home.html";
const ADMIN_BASE_URL  = "https://likhithlikki.github.io/MULTI-USERS--EVENTPAY/admin-login.html";

function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? String(v).trim() : "";
}

// Master DB (Events registry) — optional. If not configured, the registry
// simply lives inside DEFAULT_SPREADSHEET_ID itself (an "Events" tab is
// created there on first use), so getEvents()/apply-event still work with
// zero extra setup.
function getMasterDbId_() {
  return getProp_("MASTER_DB_SPREADSHEET_ID") || getProp_("MASTER_DB_ID") || DEFAULT_SPREADSHEET_ID;
}

// Parent Drive folder for auto-created event folders (Apply-Event flow only).
function getRootDriveFolderId_() {
  const id = getProp_("ROOT_DRIVE_FOLDER_ID");
  if (!id) throw new Error("ROOT_DRIVE_FOLDER_ID is not set in Script Properties (Project Settings → Script Properties). Only required for the Apply-Event auto-create flow.");
  return id;
}

// ============================================================
// 1. HTTP ENTRYPOINTS & ROUTER  (the ONLY doGet/doPost in the project)
// ============================================================

function doGet(e) {
  // DEFENSIVE: e is undefined when doGet is run manually from the Apps
  // Script editor (Run > doGet), by certain warm-up/health-check calls,
  // or by some monitoring tools that ping the URL without a query string.
  // Never assume e or e.parameter exist — build a safe params object first.
  const params = (e && e.parameter) ? e.parameter : {};
  const action = params.action || "";
  if (!action) {
    return out_({
      error: "No action specified. Call this URL with ?action=... — e.g. ?action=getEvents",
      result: "Error",
      success: false
    });
  }
  return out_(handleAction(action, params, null));
}

function doPost(e) {
  // DEFENSIVE: same reasoning as doGet — e (and e.postData) can be
  // undefined if doPost is invoked in a way that doesn't supply the
  // normal request event (e.g. run manually from the editor).
  const params = Object.assign({}, (e && e.parameter) ? e.parameter : {});
  // FIX: form-urlencoded bodies use "+" for spaces. decodeURIComponent()
  // does not convert "+" to " " — only real %XX escapes. Convert "+" to
  // a space FIRST, then decode %XX, or every name/village/complaint with
  // a space in it comes out as "Birthday+of+Likith".
  if (e && e.postData && e.postData.type === "application/x-www-form-urlencoded" && e.postData.contents) {
    e.postData.contents.split("&").forEach(pair => {
      if (!pair) return;
      const kv = pair.split("=");
      const k = decodeURIComponent((kv[0] || "").replace(/\+/g, " "));
      const v = decodeURIComponent((kv[1] || "").replace(/\+/g, " "));
      params[k] = v;
    });
  }
  const action = params.action || "";
  if (!action) {
    return out_({
      error: "No action specified in POST body.",
      result: "Error",
      success: false
    });
  }
  return out_(handleAction(action, params, e ? e.postData : null));
}

function out_(r) {
  return ContentService.createTextOutput(JSON.stringify(r))
                        .setMimeType(ContentService.MimeType.JSON);
}

function handleAction(action, p, pd) {
  try {
    switch (action) {
      // ---- Public / Visitor (per-event, sid/eventCode optional) ----
      case "getSettings":           return getSettings(p);
      case "getPublicVisibility":   return getPublicVisibility(p);
      case "getPublicStats":        return getPublicStats(p);
      case "getPublicPayments":     return getPublicPayments(p);
      case "getRecentTransactions": return getRecentTransactions(p);
      case "checkStatus":           return checkStatus(p);
      case "insertPayment":         return insertPayment(p);
      case "insertComplaint":       return insertComplaint(p);
      case "submitComplaint":       return insertComplaint(p); // alias
      case "getVillageSuggestions": return getVillageSuggestions(p);
      case "validateUTR":           return validateUTR(p);
      case "getGalleryImages":      return getGalleryImages(p);

      // ---- Admin (per-event) ----
      case "loginAdmin":            return loginAdmin(p);
      case "getPayments":           return getPayments(p);
      case "updatePayments":        return updatePayments(p);
      case "getComplaints":         return getComplaints(p);
      case "updateComplaint":       return updateComplaint(p);
      case "logActivity":           return logActivity(p);
      case "getActivity":           return getActivity(p);
      case "updatePublicDisplay":   return updatePublicDisplay(p);
      case "addVillageSuggestion":  return addVillageSuggestion(p);
      case "addUTRBlacklist":       return addUTRBlacklist(p);
      case "getUTRBlacklist":       return getUTRBlacklist(p);

      // ---- Super Admin (per-event) ----
      case "updateSettings":        return updateSettings(p);
      case "getAuditLog":           return getAuditLog(p);
      case "getSheetsList":         return getSheetsList(p);
      case "getSheetData":          return getSheetData(p);
      case "updateSheetCell":       return updateSheetCell(p);
      case "addSheetRow":           return addSheetRow(p);
      case "deleteSheetRow":        return deleteSheetRow(p);
      case "undoActions":           return undoActions(p);

      // ---- Multi-event registry (Master DB) ----
      case "getEvents":             return getEvents(p);
      case "searchEvent":           return searchEvent(p);
      case "createEventSpreadsheet":return createEventSpreadsheetAction(p);

      // ---- Apply / Create Event ----
      case "sendOrganizerOtp":       return sendOrganizerOtp(p.email);
      case "verifyOrganizerOtp":     return verifyOrganizerOtp(p.email, p.otp);
      case "checkDuplicateEvent":    return checkDuplicateEvent(p.organizerEmail, p.eventDate, p.eventName);
      case "submitEventApplication": return submitEventApplicationAction(p);

      default:
        // Never crash and never show a bare "Unknown backend action" —
        // return a structured, safe JSON error instead (requirement #16).
        return { error: "Unknown action: " + action, result: "Error", success: false };
    }
  } catch (err) {
    return { error: err.message, result: "Error", success: false };
  }
}

// ============================================================
// 2. CORE UTILITY HELPERS
// ============================================================

// Decode "+" and %XX sequences for DISPLAY / folder-naming only.
// Never mutates what's already correctly stored — safe to call on any string.
function cleanText_(s) {
  if (s === null || s === undefined) return s;
  let str = String(s);
  if (str.indexOf("+") === -1 && str.indexOf("%") === -1) return str.trim();
  try {
    str = str.replace(/\+/g, " ");
    if (/%[0-9A-Fa-f]{2}/.test(str)) str = decodeURIComponent(str);
  } catch (e) { /* leave as-is if it isn't actually URL-encoded */ }
  return str.replace(/\s+/g, " ").trim();
}

function serializeVal(val, key) {
  if (!(val instanceof Date)) return val;
  const tz = Session.getScriptTimeZone(), k = String(key || '').toLowerCase().trim();
  if (val.getFullYear() <= 1900) return Utilities.formatDate(val, tz, "hh:mm a");
  if (k === 'date')              return Utilities.formatDate(val, tz, "dd-MMM-yyyy");
  if (k === 'time')              return Utilities.formatDate(val, tz, "hh:mm a");
  return Utilities.formatDate(val, tz, "dd-MMM-yyyy hh:mm a");
}
function getColMap(headers) {
  const m = {};
  headers.forEach((h, i) => { if (h) m[String(h).trim().toLowerCase()] = i; });
  return m;
}
function extractFolderID(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const f = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (f) return f[1];
  return s;
}
function extractSpreadsheetId_(link) {
  if (!link) return null;
  const s = String(link).trim();
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s; // already a bare ID
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}
function levenshtein(a, b) {
  const m = a.length, n = b.length, dp = [];
  for (let i = 0; i <= m; i++) { dp[i] = [i]; for (let j = 1; j <= n; j++) dp[i][j] = 0; }
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}
function nowFormatted() {
  const tz = Session.getScriptTimeZone(), now = new Date();
  return {
    date: Utilities.formatDate(now, tz, "dd-MMM-yyyy"),
    time: Utilities.formatDate(now, tz, "hh:mm a"),
    full: Utilities.formatDate(now, tz, "dd-MMM-yyyy hh:mm:ss"),
    iso: now.toISOString()
  };
}
function formatReadableDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone() || "Asia/Kolkata", "dd-MMM-yyyy hh:mm a");
}

// Builds a row array that matches a sheet's ACTUAL header order, so adding
// a column never shifts existing data and nothing is ever hardcoded by index.
function buildRowFromHeaders_(sheet, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.map(h => {
    const key = String(h).trim();
    return obj[key] !== undefined ? obj[key] : "";
  });
}

function verifyAdmin(params) {
  if (!params.adminToken) throw new Error("Unauthorized: no token");
  if (params.adminExpiry && new Date() > new Date(params.adminExpiry)) throw new Error("Session expired");
}
function verifySuperAdmin(params) {
  verifyAdmin(params);
  const ss = getCurrentSpreadsheet(params);
  const sheet = ss.getSheetByName("Admins");
  if (!sheet) throw new Error("Admins sheet not found");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === params.adminUser) {
      const role = String(data[i][2]).trim().toLowerCase();
      if (role !== "superadmin" && role !== "super admin") throw new Error("Super Admin access required");
      return;
    }
  }
  throw new Error("User not found");
}

// ============================================================
// 3. MULTI-EVENT RESOLUTION  (backward compatible — see header note)
// ============================================================
// Every event-scoped function below calls resolveSid_(params) (usually via
// SpreadsheetApp.openById(resolveSid_(p))) instead of touching a hardcoded
// ID directly. If the caller doesn't send sid/eventCode it transparently
// uses DEFAULT_SPREADSHEET_ID — i.e. behaves exactly like the old
// single-event app. In this bundle the caller (config.js) now ALWAYS sends
// sid once an event has been selected, so that fallback only kicks in
// before any event is picked, or for the Apply-Event / Master-DB actions
// that intentionally don't scope to a single event.

function resolveSid_(p) {
  let resolved = DEFAULT_SPREADSHEET_ID;
  let via = "default";

  if (p && p.sid && String(p.sid).trim()) {
    resolved = String(p.sid).trim();
    via = "sid";
  } else {
    const code = p && (p.eventCode || p.code);
    if (code) {
      const id = lookupSpreadsheetIdByCode_(code);
      if (id) { resolved = id; via = "eventCode"; }
    }
  }

  // DEBUG: trace exactly which spreadsheet each request resolves to.
  // View these in Apps Script → Executions while reproducing an issue.
  try {
    Logger.log(
      "resolveSid_ | action=%s | received sid=%s | received eventCode=%s | resolved via=%s | resolvedSpreadsheetId=%s",
      (p && p.action) || "(n/a)",
      (p && p.sid) || "(none)",
      (p && (p.eventCode || p.code)) || "(none)",
      via,
      resolved
    );
  } catch (e) { /* Logger should never break a request */ }

  return resolved;
}

// Single named helper for opening the correct per-event spreadsheet.
// New code should call this instead of SpreadsheetApp.openById(...) directly.
// (Existing functions below already call SpreadsheetApp.openById(resolveSid_(p))
// inline — functionally identical to this — and are left untouched.)
function getCurrentSpreadsheet(p) {
  const sid = resolveSid_(p);
  const ss = SpreadsheetApp.openById(sid);
  try {
    Logger.log("getCurrentSpreadsheet | Opened spreadsheet id=%s | name=%s", sid, ss.getName());
  } catch (e) {}
  return ss;
}

const EVENTS_SHEET_HEADERS = [
  "EventID", "EventCode", "EventType", "EventName", "SpreadsheetID", "SpreadsheetLink",
  "OrganizerName", "OrganizerPhone", "OrganizerEmail", "Plan", "TrialExpiry", "Status",
  "SettlementStatus", "CreatedDate", "UpdatedDate", "AdminUsername", "AdminPassword",
  "PublicURL", "AdminURL"
];

function getOrCreateEventsSheet_() {
  const ss = SpreadsheetApp.openById(getMasterDbId_());
  let sheet = ss.getSheetByName("Events");
  if (!sheet) {
    sheet = ss.insertSheet("Events");
    sheet.getRange(1, 1, 1, EVENTS_SHEET_HEADERS.length).setValues([EVENTS_SHEET_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, EVENTS_SHEET_HEADERS.length).setFontWeight("bold");
  }
  return sheet;
}

function lookupSpreadsheetIdByCode_(eventCode) {
  try {
    const sheet = getOrCreateEventsSheet_();
    const data = sheet.getDataRange().getValues();
    const col = getColMap(data[0]);
    const codeC = col["eventcode"] !== undefined ? col["eventcode"] : 1;
    const ssIdC = col["spreadsheetid"] !== undefined ? col["spreadsheetid"] : 4;
    const clean = String(eventCode).trim().toLowerCase();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][codeC]).trim().toLowerCase() === clean) {
        const id = String(data[i][ssIdC]).trim();
        return id || null;
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}

function getEvents(p) {
  try {
    const sheet = getOrCreateEventsSheet_();
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return { events: [] };
    const headers = data[0].map(h => String(h).trim());
    const statusC = getColMap(data[0])["status"];
    const nameC = getColMap(data[0])["eventname"];
    const events = [];
    for (let i = 1; i < data.length; i++) {
      if (!data[i][0]) continue;
      const row = {};
      headers.forEach((h, j) => { row[h] = data[i][j]; });
      if (nameC !== undefined) row.EventName = cleanText_(data[i][nameC]); // strip "+" from names
      if (statusC !== undefined && String(data[i][statusC]).trim().toLowerCase() !== "active") continue;
      events.push(row);
    }
    return { events: events };
  } catch (err) {
    return { events: [], error: err.message };
  }
}

function searchEvent(p) {
  try {
    const sheet = getOrCreateEventsSheet_();
    const data = sheet.getDataRange().getValues();
    const col = getColMap(data[0]);
    const codeC = col["eventcode"] !== undefined ? col["eventcode"] : 1;
    const nameC = col["eventname"] !== undefined ? col["eventname"] : 3;
    const typeC = col["eventtype"] !== undefined ? col["eventtype"] : 2;
    const statusC = col["status"] !== undefined ? col["status"] : 11;
    const searchCode = p.code ? String(p.code).trim().toLowerCase() : null;
    const searchName = p.name ? String(p.name).trim().toLowerCase() : null;
    const matches = [];
    for (let i = 1; i < data.length; i++) {
      const codeVal = String(data[i][codeC]).trim();
      const nameVal = cleanText_(data[i][nameC]);
      const typeVal = String(data[i][typeC]).trim();
      if (String(data[i][statusC]).trim().toLowerCase() !== "active") continue;
      let isMatch = false;
      if (searchCode && codeVal.toLowerCase() === searchCode) isMatch = true;
      else if (searchName && nameVal.toLowerCase().indexOf(searchName) !== -1) isMatch = true;
      if (isMatch) matches.push({ eventCode: codeVal, eventName: nameVal, eventType: typeVal });
    }
    return { matches: matches };
  } catch (err) {
    return { matches: [], error: err.message };
  }
}

function createEventSpreadsheetAction(p) {
  try {
    verifySuperAdmin(p);
    const spreadsheetId = p.targetSpreadsheetId || p.sid;
    if (!spreadsheetId) return { result: "Error", error: "Target Spreadsheet ID is required." };
    const result = initializeEventSpreadsheet(spreadsheetId);
    return { result: result.success ? "SpreadsheetInitialized" : "Failed" };
  } catch (err) { return { result: "Error", error: err.message }; }
}

// ============================================================
// 4. SETTINGS — Vertical format: Col A = key, Col B = value
// ============================================================
function getSettings(p) {
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Settings");
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const obj = {};
  data.forEach(r => { if (r[0]) obj[String(r[0]).trim()] = r[1]; });
  if (obj["Event Name"]) obj["Event Name"] = cleanText_(obj["Event Name"]);
  if (obj["EventName"]) obj["EventName"] = cleanText_(obj["EventName"]);
  return obj;
}

function getPublicVisibility(p) {
  const s = getSettings(p);
  const isActive = (key) => String(s[key] || "ACTIVE").toUpperCase().trim() === "ACTIVE";
  return {
    showDonorList:          isActive("SHOW_DONOR_LIST"),
    showStatistics:         isActive("SHOW_STATISTICS"),
    showHomepageStats:      isActive("SHOW_HOMEPAGE_STATS"),
    showHomepageDonors:     isActive("SHOW_HOMEPAGE_DONORS"),
    showGallery:            isActive("SHOW_GALLERY"),
    showInviteCard:         isActive("SHOW_INVITE_CARD"),
    showPendingPayments:    isActive("SHOW_PENDING_PAYMENTS"),
    showVerifiedPayments:   isActive("SHOW_VERIFIED_PAYMENTS"),
    showRecentPayments:     isActive("SHOW_RECENT_PAYMENTS"),
    showEngagementGallery:  isActive("SHOW_ENGAGEMENT_GALLERY"),
    showHaldiGallery:       isActive("SHOW_HALDI_GALLERY"),
    showMarriageGallery:    isActive("SHOW_MARRIAGE_GALLERY"),
    allowDownloadAll:       isActive("ALLOW_DOWNLOAD_ALL"),
    allowSectionDownload:   isActive("ALLOW_SECTION_DOWNLOAD")
  };
}

function updateSettings(p) {
  verifySuperAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Settings");
  if (!sheet) throw new Error("Settings sheet not found");
  const data = sheet.getDataRange().getValues();
  const updates = JSON.parse(p.updates || '{}');
  Object.keys(updates).forEach(key => {
    let found = false;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === key) {
        const oldVal = data[i][1];
        sheet.getRange(i + 1, 2).setValue(updates[key]);
        logAudit({ adminUser: p.adminUser, module: "Settings", action: "Update",
          field: key, oldValue: String(oldVal), newValue: String(updates[key]), reason: p.reason || "",
          row: i + 1, column: 2 }, p);
        found = true; break;
      }
    }
    if (!found) sheet.appendRow([key, updates[key]]);
  });
  logActivity({ adminUser: p.adminUser, module: "Settings", action: "SettingsUpdate",
    detail: "Updated " + Object.keys(updates).length + " setting(s)" }, p);
  return { result: "Saved" };
}

// ============================================================
// 5. ADMIN LOGIN  (per-event Admins sheet, with Master DB fallback)
// ============================================================
function loginAdmin(p) {
  const sid = resolveSid_(p);
  const ss = SpreadsheetApp.openById(sid);
  const sheet = ss.getSheetByName("Admins");
  let matchedRow = null, adminsData = null;

  if (sheet) {
    adminsData = sheet.getDataRange().getValues();
    for (let i = 1; i < adminsData.length; i++) {
      const u = String(adminsData[i][0]).trim(), pw = String(adminsData[i][1]).trim();
      if (u === p.username && pw === p.password) { matchedRow = i; break; }
    }
  }

  if (matchedRow !== null) {
    const status = String(adminsData[matchedRow][4] || "Active").trim();
    if (status.toLowerCase() === "inactive") return { success: false, error: "Account inactive" };
    const s = getSettings(p);
    const timeout = parseInt(s.SessionTimeoutMinutes) || 30;
    const expiry = new Date(Date.now() + timeout * 60 * 1000).toISOString();
    const token = Utilities.getUuid();
    try { sheet.getRange(matchedRow + 1, 8).setValue(nowFormatted().full); } catch (e) {}
    logActivity({ adminUser: p.username, module: "Auth", action: "Login", detail: "Successful login" }, p);
    logAudit({ adminUser: p.username, module: "Auth", action: "Login",
      field: "session", oldValue: "", newValue: "active", reason: "Login" }, p);
    return {
      success: true,
      role: adminsData[matchedRow][2] || "admin",
      accessLevel: adminsData[matchedRow][3] || "full",
      email: adminsData[matchedRow][5] || "",
      token, expiry
    };
  }

  // Fallback: Master DB registry's per-event AdminUsername/AdminPassword
  // (set automatically when an event is created via Apply-Event).
  try {
    const eventsSheet = getOrCreateEventsSheet_();
    const data = eventsSheet.getDataRange().getValues();
    const col = getColMap(data[0]);
    const ssIdC = col["spreadsheetid"] !== undefined ? col["spreadsheetid"] : 4;
    const userC = col["adminusername"] !== undefined ? col["adminusername"] : 15;
    const passC = col["adminpassword"] !== undefined ? col["adminpassword"] : 16;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][ssIdC]).trim() === sid &&
          String(data[i][userC]).trim() === p.username &&
          String(data[i][passC]).trim() === p.password) {
        const token = Utilities.getUuid();
        const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        logActivity({ adminUser: p.username, module: "Auth", action: "Login", detail: "Successful login (registry)" }, p);
        return { success: true, role: "superadmin", accessLevel: "full", email: "", token, expiry };
      }
    }
  } catch (e) { /* Master DB not reachable — ignore, fall through to failure */ }

  logAudit({ adminUser: p.username || "unknown", module: "Auth", action: "FailedLogin",
    field: "", oldValue: "", newValue: "", reason: "Wrong credentials" }, p);
  return { success: false };
}

// ============================================================
// 6. UTR VALIDATION & FRAUD DETECTION
// ============================================================
function isUTRBlacklisted(utr, p) {
  try {
    const ss = getCurrentSpreadsheet(p);
    const sheet = ss.getSheetByName("UTRBlacklist");
    if (!sheet) return false;
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) if (String(data[i][0]).trim() === utr) return true;
  } catch (e) {}
  return false;
}

function addUTRBlacklist(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("UTRBlacklist");
  if (!sheet) throw new Error("UTRBlacklist sheet not found");
  const n = nowFormatted();
  sheet.appendRow([p.utr, n.full, p.reason || "Manually blacklisted by " + p.adminUser]);
  return { result: "Blacklisted" };
}

function getUTRBlacklist(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("UTRBlacklist");
  if (!sheet) return { list: [] };
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) if (data[i][0]) list.push({ utr: data[i][0], addedAt: serializeVal(data[i][1], 'date'), reason: data[i][2] });
  return { list };
}

// Behaviour required:
//  - LOW    -> valid, submit allowed
//  - MEDIUM -> valid, submit allowed, but flagged "Review" (orange warning in UI)
//  - HIGH   -> invalid, submit BLOCKED (red warning in UI)
//  - Exact duplicate UTR anywhere in Payments -> BLOCKED
//  - Blacklisted UTR -> BLOCKED
function validateUTR(p) {
  const utr = String(p.utr || '').trim();
  if (!utr) return { valid: false, risk: "HIGH", score: 100, flags: ["Empty UTR"], block: true };

  const s = getSettings(p);
  const highT = parseInt(s.FRAUD_THRESHOLD_HIGH) || 70;
  const medT  = parseInt(s.FRAUD_THRESHOLD_MEDIUM) || 40;

  let score = 0; const flags = [];

  if (isUTRBlacklisted(utr, p)) return { valid: false, risk: "HIGH", score: 100, flags: ["UTR is blacklisted"], block: true };

  if (!/^\d+$/.test(utr)) { score += 35; flags.push("Non-numeric characters"); }
  if (utr.length < 10)     { score += 30; flags.push("Too short (min 10 digits)"); }
  if (utr.length > 22)     { score += 15; flags.push("Too long (max 22 digits)"); }
  if (/^(.)\1+$/.test(utr)) { score += 45; flags.push("All identical digits"); }

  const testVals = ["123456789012", "000000000000", "111111111111", "999999999999", "123123123123"];
  if (testVals.includes(utr)) { score += 50; flags.push("Known test/fake value"); }

  let isSeq = true;
  for (let i = 1; i < Math.min(utr.length, 8); i++) if (parseInt(utr[i]) - parseInt(utr[i - 1]) !== 1) { isSeq = false; break; }
  if (isSeq && utr.length >= 6) { score += 25; flags.push("Sequential digits"); }

  try {
    const ss = getCurrentSpreadsheet(p);
    const sheet = ss.getSheetByName("Payments");
    if (sheet && sheet.getLastRow() > 1) {
      const data = sheet.getDataRange().getValues();
      const col = getColMap(data[0]);
      const utrC = col["utr"] !== undefined ? col["utr"] : 7;
      const phoneC = col["phone number"] !== undefined ? col["phone number"] : (col["phone"] !== undefined ? col["phone"] : 5);
      for (let i = Math.max(1, data.length - 300); i < data.length; i++) {
        const eu = String(data[i][utrC] || '').trim();
        if (!eu) continue;
        if (eu === utr) return { valid: false, risk: "HIGH", score: 100, flags: ["Exact duplicate UTR"], block: true };
        if (eu.length >= 10 && utr.length >= 10) {
          const dist = levenshtein(utr, eu);
          if (dist <= 1) { score += 50; flags.push("Nearly identical to existing UTR"); }
          else if (dist <= 2) { score += 25; flags.push("Very similar to existing UTR"); }
        }
        if (p.phone && String(data[i][phoneC] || '').trim() === String(p.phone).trim()) score += 20;
      }
    }
  } catch (e) {}

  score = Math.min(score, 100);
  const risk = score >= highT ? "HIGH" : score >= medT ? "MEDIUM" : "LOW";
  const block = score >= highT;
  return { valid: !block, risk, score, flags, block };
}

// ============================================================
// 7. PAYMENTS
// ============================================================
function insertPayment(p) {
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Payments");
  if (!sheet) return { result: "Error", message: "Payments sheet not found" };
  const data = sheet.getDataRange().getValues();
  const col = getColMap(data[0]);
  const phoneC = col["phone number"] !== undefined ? col["phone number"] : (col["phone"] !== undefined ? col["phone"] : 5);

  const s = getSettings(p);
  const maxAmt = parseFloat(s.MAX_AMOUNT) || 0;
  const minAmt = parseFloat(s.MIN_AMOUNT) || 50;
  const amt = Number(p.amount) || 0;
  if (maxAmt > 0 && amt > maxAmt) return { result: "AmountExceedsMax", maxAmount: maxAmt, message: "Maximum contribution amount is ₹" + maxAmt.toLocaleString("en-IN") };
  if (amt < minAmt) return { result: "AmountBelowMin", minAmount: minAmt, message: "Minimum contribution amount is ₹" + minAmt.toLocaleString("en-IN") };

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][phoneC]).trim() === String(p.phone).trim()) return { result: "DuplicatePhone" };
  }

  const utrCheck = validateUTR({ utr: p.utr, phone: p.phone, sid: p.sid, eventCode: p.eventCode });
  if (utrCheck.block) return { result: "DuplicateUTR", message: utrCheck.flags.join(", "), risk: utrCheck.risk };

  const n = nowFormatted();
  const reviewFlag = utrCheck.risk === "MEDIUM" ? "Review" : utrCheck.risk === "HIGH" ? "HighRisk" : "";
  const status = utrCheck.risk === "MEDIUM" ? "Pending (Review)" : "Pending";

  const rowObj = {
    "RefID": p.refid, "Date": n.date, "Time": n.time,
    "Full Name": cleanText_(p.name), "Village": cleanText_(p.village), "Phone number": p.phone,
    "Amount": Number(p.amount), "UTR": p.utr, "Status": status,
    "FraudScore": utrCheck.score, "RiskLevel": utrCheck.risk, "ReviewFlag": reviewFlag,
    "ShowPublic": "Yes", "Verified By": "", "Verified At": "", "Notes": ""
  };
  sheet.appendRow(buildRowFromHeaders_(sheet, rowObj));

  addVillageInternal(cleanText_(p.village), p);

  try {
    if (s.OrganizerEmail) {
      MailApp.sendEmail({
        to: String(s.OrganizerEmail),
        subject: (utrCheck.risk === "MEDIUM" ? "⚠️[Review] " : "💰") + "New: " + cleanText_(p.name) + " ₹" + p.amount,
        body: "Name: " + cleanText_(p.name) + "\nPhone: " + p.phone + "\nAmount: ₹" + p.amount +
              "\nUTR: " + p.utr + "\nRisk: " + utrCheck.risk +
              (utrCheck.flags.length ? "\nFlags: " + utrCheck.flags.join(", ") : "") +
              "\nRef: " + p.refid + "\n" + n.date + " " + n.time
      });
    }
  } catch (e) {}
  return { result: "Inserted", riskLevel: utrCheck.risk };
}

function addVillageInternal(villageName, p) {
  if (!villageName) return;
  try {
    const ss = getCurrentSpreadsheet(p);
    const sheet = ss.getSheetByName("Villages");
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    const normalizedNew = villageName.trim().toLowerCase();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === normalizedNew) {
        sheet.getRange(i + 1, 3).setValue(parseInt(data[i][2] || 0) + 1);
        return;
      }
    }
    sheet.appendRow([villageName.trim(), normalizedNew, 1, "Active"]);
  } catch (e) {}
}

function getPublicStats(p) {
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Payments");
  if (!sheet) return { total: 0, count: 0, pending: 0 };
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { total: 0, count: 0, pending: 0 };
  const col = getColMap(data[0]);
  const aC = col["amount"] !== undefined ? col["amount"] : 6;
  const sC = col["status"] !== undefined ? col["status"] : 8;
  let total = 0, count = 0, pending = 0;
  for (let i = 1; i < data.length; i++) {
    const st = String(data[i][sC]).trim(), amt = Number(data[i][aC]) || 0;
    if (st === "Verified") { total += amt; count++; }
    if (st.startsWith("Pending")) pending++;
  }
  return { total, count, pending };
}

function getRecentTransactions(p) {
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Payments");
  if (!sheet) return { transactions: [] };
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { transactions: [] };
  const col = getColMap(data[0]);
  const nC = col["full name"] !== undefined ? col["full name"] : (col["name"] !== undefined ? col["name"] : 3);
  const vC = col["village"] !== undefined ? col["village"] : 4;
  const aC = col["amount"] !== undefined ? col["amount"] : 6;
  const sC = col["status"] !== undefined ? col["status"] : 8;
  const dC = col["date"] !== undefined ? col["date"] : 1;
  const spC = col["showpublic"] !== undefined ? col["showpublic"] : 12;
  const transactions = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][sC]).trim() === "Verified" && String(data[i][spC]).trim() !== "No") {
      transactions.push({ name: cleanText_(data[i][nC]), village: cleanText_(data[i][vC]), amount: Number(data[i][aC]) || 0, date: serializeVal(data[i][dC], 'date') });
    }
  }
  transactions.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { transactions: transactions.slice(0, 10) };
}

function checkStatus(p) {
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Payments");
  if (!sheet) return { found: false };
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { found: false };
  const col = getColMap(data[0]);
  const C = {
    refid: col["refid"] !== undefined ? col["refid"] : 0,
    date: col["date"] !== undefined ? col["date"] : 1,
    time: col["time"] !== undefined ? col["time"] : 2,
    name: col["full name"] !== undefined ? col["full name"] : (col["name"] !== undefined ? col["name"] : 3),
    village: col["village"] !== undefined ? col["village"] : 4,
    phone: col["phone number"] !== undefined ? col["phone number"] : (col["phone"] !== undefined ? col["phone"] : 5),
    amount: col["amount"] !== undefined ? col["amount"] : 6,
    utr: col["utr"] !== undefined ? col["utr"] : 7,
    status: col["status"] !== undefined ? col["status"] : 8,
    fscore: col["fraudscore"] !== undefined ? col["fraudscore"] : 9,
    risk: col["risklevel"] !== undefined ? col["risklevel"] : 10
  };
  const type = p.searchType || 'refid', val = String(p.searchVal || p.refid || '').trim();
  for (let i = 1; i < data.length; i++) {
    let match = false;
    if (type === 'phone') match = String(data[i][C.phone]).trim() === val;
    else if (type === 'utr') match = String(data[i][C.utr]).trim() === val;
    else match = String(data[i][C.refid]).trim().slice(-5) === val;
    if (match) return {
      found: true,
      refid: data[i][C.refid], date: serializeVal(data[i][C.date], 'date'), time: serializeVal(data[i][C.time], 'time'),
      name: cleanText_(data[i][C.name]), village: cleanText_(data[i][C.village]), phone: data[i][C.phone],
      amount: data[i][C.amount], utr: data[i][C.utr], status: data[i][C.status],
      fraudScore: data[i][C.fscore] || 0, riskLevel: data[i][C.risk] || "LOW"
    };
  }
  return { found: false };
}

function getPayments(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Payments");
  if (!sheet) return { payments: [] };
  const data = sheet.getDataRange().getValues();
  const headers = data[0]; const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = { _row: i + 1 };
    headers.forEach((h, j) => { if (h) row[String(h).trim()] = serializeVal(data[i][j], h); });
    row.Name = cleanText_(row["Full Name"] || row["Name"] || "");
    row.Village = cleanText_(row["Village"] || "");
    row.Phone = row["Phone number"] || row["Phone"] || "";
    row.RefID = row["RefID"] || "";
    row.RiskLevel = row["RiskLevel"] || "LOW";
    row.FraudScore = row["FraudScore"] || 0;
    row.VerifiedBy = row["Verified By"] || row["VerifiedBy"] || "";
    rows.push(row);
  }
  return { payments: rows };
}

function updatePayments(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Payments");
  const data = sheet.getDataRange().getValues();
  const col = getColMap(data[0]);
  const n = nowFormatted();
  const stC = (col["status"] !== undefined ? col["status"] : 8) + 1;
  const vbC = (col["verified by"] !== undefined ? col["verified by"] : (col["verifiedby"] !== undefined ? col["verifiedby"] : 13)) + 1;
  const vaC = (col["verifiedat"] !== undefined ? col["verifiedat"] : 14) + 1;
  const refC = (col["refid"] !== undefined ? col["refid"] : 0);
  const updates = JSON.parse(p.updates);
  updates.forEach(u => {
    const oldSt = sheet.getRange(u.row, stC).getValue();
    const refId = data[u.row - 1] ? data[u.row - 1][refC] : "";
    sheet.getRange(u.row, stC).setValue(u.status);
    sheet.getRange(u.row, vbC).setValue(p.adminUser || "admin");
    sheet.getRange(u.row, vaC).setValue(n.full);
    logAudit({ adminUser: p.adminUser, module: "Payments", action: "StatusChange",
      field: "Status", oldValue: String(oldSt), newValue: u.status, reason: p.reason || "",
      row: u.row, column: stC, recordId: String(refId) }, p);
  });
  logActivity({ adminUser: p.adminUser, module: "Payments", action: "VerifyPayments",
    detail: updates.length + " records updated", oldValue: "", newValue: updates.map(u => u.status).join(",") }, p);
  return { result: "Saved" };
}

function updatePublicDisplay(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Payments");
  const data = sheet.getDataRange().getValues();
  const col = getColMap(data[0]);
  const spC = (col["showpublic"] !== undefined ? col["showpublic"] : 12) + 1;
  sheet.getRange(parseInt(p.row), spC).setValue(p.showPublic);
  return { result: "Updated" };
}

function getPublicPayments(p) {
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Payments");
  if (!sheet) return { donors: [] };
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { donors: [] };
  const col = getColMap(data[0]);
  const nC = col["full name"] !== undefined ? col["full name"] : (col["name"] !== undefined ? col["name"] : 3);
  const aC = col["amount"] !== undefined ? col["amount"] : 6;
  const sC = col["status"] !== undefined ? col["status"] : 8;
  const spC = col["showpublic"] !== undefined ? col["showpublic"] : 12;
  const dC = col["date"] !== undefined ? col["date"] : 1;
  const donors = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][sC]).trim() === "Verified" && String(data[i][spC]).trim() !== "No")
      donors.push({ name: cleanText_(data[i][nC]), amount: Number(data[i][aC]) || 0, date: serializeVal(data[i][dC], 'date') });
  }
  donors.sort((a, b) => b.amount - a.amount);
  return { donors };
}

// ============================================================
// 8. COMPLAINTS
// ============================================================
function insertComplaint(p) {
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Complaints");
  if (!sheet) return { result: "Error", message: "Complaints sheet not found" };
  const n = nowFormatted();
  let fileUrl = "", fileStatus = "None";

  if (p.filedata && p.filename) {
    try {
      const s = getSettings(p);
      const folderID = extractFolderID(s.COMPLAINT_UPLOAD_FOLDER_ID);
      if (folderID) {
        const folder = DriveApp.getFolderById(folderID);
        const cleanBase64 = String(p.filedata).split(",")[1] || p.filedata;
        const decoded = Utilities.base64Decode(cleanBase64);
        const blob = Utilities.newBlob(decoded, p.filetype || "application/octet-stream", p.filename);
        const file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        fileUrl = "https://drive.google.com/file/d/" + file.getId() + "/view";
        fileStatus = "Attached";
      }
    } catch (e) {
      fileUrl = "Error: " + e.message;
      fileStatus = "Error";
    }
  }

  const cID = "CP" + Date.now().toString().slice(-8);
  const rowObj = {
    "ComplaintID": cID, "Date": n.date, "Time": n.time,
    "Name": cleanText_(p.name), "Village": cleanText_(p.village), "Phone": p.phone, "Email": p.email,
    "Complaint": p.complaint, "Attachment": fileStatus, "AttachmentURL": fileUrl, "AttachmentName": p.filename || "",
    "Status": "Open", "ReplyBy": "", "AdminReply": "", "RepliedAt": "", "Priority": ""
  };
  sheet.appendRow(buildRowFromHeaders_(sheet, rowObj));

  try {
    const s = getSettings(p);
    if (s.OrganizerEmail) MailApp.sendEmail({
      to: String(s.OrganizerEmail),
      subject: "📋 Complaint: " + cleanText_(p.name),
      body: "ID: " + cID + "\nName: " + cleanText_(p.name) + "\nVillage: " + cleanText_(p.village) +
            "\nPhone: " + p.phone + "\nComplaint:\n" + p.complaint + (fileUrl ? "\nAttachment: " + fileUrl : "")
    });
  } catch (e) {}
  return { result: "Inserted", complaintID: cID };
}

function getComplaints(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Complaints");
  if (!sheet) return { complaints: [] };
  const data = sheet.getDataRange().getValues();
  const headers = data[0]; const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = { _row: i + 1 };
    headers.forEach((h, j) => { if (h) row[String(h).trim()] = serializeVal(data[i][j], h); });
    if (row.Name) row.Name = cleanText_(row.Name);
    if (row.Village) row.Village = cleanText_(row.Village);
    rows.push(row);
  }
  return { complaints: rows };
}

function updateComplaint(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Complaints");
  const data = sheet.getDataRange().getValues();
  const col = getColMap(data[0]);
  const n = nowFormatted();
  const stC = (col["status"] !== undefined ? col["status"] : 11) + 1;
  const rbC = (col["replyby"] !== undefined ? col["replyby"] : 12) + 1;
  const arC = (col["adminreply"] !== undefined ? col["adminreply"] : 13) + 1;
  const raC = (col["repliedat"] !== undefined ? col["repliedat"] : 14) + 1;
  const idC = (col["complaintid"] !== undefined ? col["complaintid"] : 0);
  const oldSt = sheet.getRange(parseInt(p.row), stC).getValue();
  const cID = data[parseInt(p.row) - 1] ? data[parseInt(p.row) - 1][idC] : "";
  sheet.getRange(parseInt(p.row), stC).setValue(p.status);
  sheet.getRange(parseInt(p.row), rbC).setValue(p.adminUser || "admin");
  sheet.getRange(parseInt(p.row), arC).setValue(p.reply);
  sheet.getRange(parseInt(p.row), raC).setValue(n.full);
  try {
    if (p.email && p.reply) {
      const s = getSettings(p);
      MailApp.sendEmail({ to: p.email, subject: "Reply — " + (s["Event Name"] || s.EventName || "Event"),
        body: "Dear " + cleanText_(p.name) + ",\n\nReply:\n" + p.reply + "\n\nStatus: " + p.status + "\n\nEvent Team" });
    }
  } catch (e) {}
  logAudit({ adminUser: p.adminUser, module: "Complaints", action: "Reply",
    field: "Status", oldValue: String(oldSt), newValue: p.status, reason: "Complaint reply",
    row: parseInt(p.row), column: stC, recordId: String(cID) }, p);
  logActivity({ adminUser: p.adminUser, module: "Complaints", action: "ReplyComplaint",
    detail: "Replied to " + cleanText_(p.name) + " (" + cID + ")", oldValue: String(oldSt), newValue: p.status }, p);
  return { result: "Updated" };
}

// ============================================================
// 9. VILLAGES
// ============================================================
function getVillageSuggestions(p) {
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Villages");
  if (!sheet) return { villages: [] };
  const data = sheet.getDataRange().getValues();
  const villages = [];
  for (let i = 1; i < data.length; i++) {
    const v = String(data[i][0] || '').trim();
    const status = String(data[i][3] || 'Active').trim();
    if (v && status.toLowerCase() !== 'inactive') villages.push(v);
  }
  return { villages: [...new Set(villages)].sort() };
}

function addVillageSuggestion(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("Villages");
  if (!sheet) throw new Error("Villages sheet not found");
  const data = sheet.getDataRange().getValues();
  const normalized = p.village.trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === normalized) {
      sheet.getRange(i + 1, 3).setValue(parseInt(data[i][2] || 0) + 1);
      return { result: "Updated" };
    }
  }
  sheet.appendRow([p.village.trim(), normalized, 1, "Active"]);
  return { result: "Added" };
}

// ============================================================
// 10. GALLERY — auto-detects eventCode / sid / raw folder IDs
// ============================================================
function getGalleryImages(p) {
  try {
    const s = getSettings(p); // getCurrentSpreadsheet inside getSettings already handles sid/eventCode/default
    const engFolderID = extractFolderID(s.ENGAGEMENT_GALLERY_FOLDER_ID);
    const haldiFolderID = extractFolderID(s.HALDI_GALLERY_FOLDER_ID);
    const marFolderID = extractFolderID(s.MARRIAGE_GALLERY_FOLDER_ID);

    function getFolderImages(folderID, section) {
      if (!folderID) return [];
      try {
        const folder = DriveApp.getFolderById(folderID);
        const files = folder.getFiles();
        const imgs = [];
        while (files.hasNext()) {
          const f = files.next();
          if (f.getMimeType().startsWith("image/")) {
            try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
            imgs.push({
              id: f.getId(), name: f.getName(), section: section,
              url: "https://drive.google.com/uc?id=" + f.getId(),
              thumb: "https://drive.google.com/thumbnail?id=" + f.getId() + "&sz=w400"
            });
          }
        }
        return imgs;
      } catch (e) { return []; }
    }

    const sections = {
      engagement: getFolderImages(engFolderID, "Engagement"),
      haldi: getFolderImages(haldiFolderID, "Haldi"),
      marriage: getFolderImages(marFolderID, "Marriage")
    };
    const allImages = [...sections.engagement, ...sections.haldi, ...sections.marriage];
    return { images: allImages, sections };
  } catch (e) { return { images: [], sections: {}, error: e.message }; }
}

// ============================================================
// 11. ACTIVITY LOG — "Admin X did Y on Module Z"
// ============================================================
function logActivity(p, ctx) {
  try {
    const ss = getCurrentSpreadsheet(ctx || p);
    let sheet = ss.getSheetByName("ActivityLog");
    if (!sheet) {
      sheet = ss.insertSheet("ActivityLog");
      sheet.appendRow(["RecordID", "Date", "Time", "AdminUser", "Module", "Action", "Detail",
        "OldValue", "NewValue", "RecordID_Ref", "Browser", "Device", "LogoutType"]);
    }
    const n = nowFormatted();
    const recID = "AL" + Date.now().toString().slice(-8);
    sheet.appendRow([
      recID, n.date, n.time,
      p.adminUser || "", p.module || "", p.action || "", p.detail || "",
      p.oldValue || "", p.newValue || "", p.recordId || "", "", "", ""
    ]);
  } catch (e) {}
  return { result: "Logged" };
}

function getActivity(p) {
  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("ActivityLog");
  if (!sheet) return { activities: [] };
  const data = sheet.getDataRange().getValues();
  const rows = [];
  const col = getColMap(data[0]);
  for (let i = Math.max(1, data.length - 100); i < data.length; i++) {
    rows.push({
      date: serializeVal(data[i][col["date"] !== undefined ? col["date"] : 1], 'date'),
      time: serializeVal(data[i][col["time"] !== undefined ? col["time"] : 2], 'time'),
      user: data[i][col["adminuser"] !== undefined ? col["adminuser"] : 3],
      module: data[i][col["module"] !== undefined ? col["module"] : 4],
      action: data[i][col["action"] !== undefined ? col["action"] : 5],
      detail: data[i][col["detail"] !== undefined ? col["detail"] : 6],
      oldValue: data[i][col["oldvalue"] !== undefined ? col["oldvalue"] : 7],
      newValue: data[i][col["newvalue"] !== undefined ? col["newvalue"] : 8],
      recordId: data[i][col["recordid_ref"] !== undefined ? col["recordid_ref"] : 9] || ""
    });
  }
  return { activities: rows.reverse() };
}

// ============================================================
// 12. AUDIT LOG
// ============================================================
function logAudit(p, ctx) {
  try {
    const ss = getCurrentSpreadsheet(ctx || p);
    let sheet = ss.getSheetByName("AuditLog");
    if (!sheet) {
      sheet = ss.insertSheet("AuditLog");
      sheet.appendRow(["Timestamp", "AdminUser", "Module", "Action", "Field", "OldValue", "NewValue", "Reason", "Row", "Column", "RecordID"]);
    }
    const n = nowFormatted();
    sheet.appendRow([
      n.full, p.adminUser || "", p.module || "", p.action || "",
      p.field || "", p.oldValue || "", p.newValue || "", p.reason || "",
      p.row || "", p.column || "", p.recordId || ""
    ]);
  } catch (e) {}
}

function getAuditLog(p) {
  verifySuperAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("AuditLog");
  if (!sheet) return { logs: [] };
  const data = sheet.getDataRange().getValues();
  const logs = [];
  const limit = parseInt(p.limit) || 100;
  for (let i = Math.max(1, data.length - limit); i < data.length; i++) {
    logs.push({
      timestamp: String(data[i][0]), user: data[i][1], module: data[i][2],
      action: data[i][3], field: data[i][4], oldValue: data[i][5], newValue: data[i][6],
      reason: data[i][7], row: data[i][8], column: data[i][9], recordId: data[i][10] || ""
    });
  }
  return { logs: logs.reverse() };
}

// ============================================================
// 13. UNDO SYSTEM
// ============================================================
function undoActions(p) {
  verifySuperAdmin(p);
  const scope = p.scope || "last";
  const ss = getCurrentSpreadsheet(p);
  const auditSheet = ss.getSheetByName("AuditLog");
  if (!auditSheet) return { result: "NoAuditLog", undone: 0 };

  const data = auditSheet.getDataRange().getValues();
  const now = new Date();
  let cutoff = null;
  if (scope === "1hour") cutoff = new Date(now.getTime() - 3600 * 1000);
  if (scope === "24hour") cutoff = new Date(now.getTime() - 86400 * 1000);
  if (scope === "7days") cutoff = new Date(now.getTime() - 7 * 86400 * 1000);

  let undone = 0;
  const toUndo = [];
  for (let i = data.length - 1; i >= 1; i--) {
    const ts = new Date(String(data[i][0]));
    if (scope === "last" && toUndo.length >= 1) break;
    if (cutoff && ts < cutoff) break;
    if (scope === "all" || scope === "last" || (cutoff && ts >= cutoff)) {
      toUndo.push({
        idx: i, timestamp: data[i][0], user: data[i][1], module: data[i][2],
        action: data[i][3], field: data[i][4], oldValue: data[i][5], newValue: data[i][6],
        reason: data[i][7], row: data[i][8], column: data[i][9]
      });
    }
  }

  const errors = [];
  toUndo.forEach(entry => {
    try {
      if (String(entry.module).startsWith("Sheet:")) {
        const sheetName = String(entry.module).replace("Sheet:", "");
        const targetSheet = ss.getSheetByName(sheetName);
        if (targetSheet && entry.row && entry.column && entry.oldValue !== undefined) {
          targetSheet.getRange(parseInt(entry.row), parseInt(entry.column)).setValue(entry.oldValue);
          undone++;
        }
      } else if (entry.module === "Payments" && entry.action === "StatusChange") {
        const pSheet = ss.getSheetByName("Payments");
        if (pSheet && entry.row && entry.column && entry.oldValue) {
          pSheet.getRange(parseInt(entry.row), parseInt(entry.column)).setValue(entry.oldValue);
          undone++;
        }
      } else if (entry.module === "Settings" && entry.action === "Update") {
        const sSheet = ss.getSheetByName("Settings");
        const sData = sSheet.getDataRange().getValues();
        for (let j = 0; j < sData.length; j++) {
          if (String(sData[j][0]).trim() === entry.field) { sSheet.getRange(j + 1, 2).setValue(entry.oldValue); undone++; break; }
        }
      }
      logAudit({ adminUser: p.adminUser, module: entry.module, action: "UNDO_" + entry.action,
        field: entry.field, oldValue: entry.newValue, newValue: entry.oldValue,
        reason: "Undo by " + p.adminUser + " (scope: " + scope + ")",
        row: entry.row, column: entry.column }, p);
    } catch (e) { errors.push(e.message); }
  });

  logActivity({ adminUser: p.adminUser, module: "System", action: "UndoActions",
    detail: "Undone " + undone + " action(s) [scope: " + scope + "]" }, p);
  return { result: "Done", undone, errors };
}

// ============================================================
// 14. SHEET EDITOR (Super Admin Only)
// ============================================================
function getSheetsList(p) {
  verifySuperAdmin(p);
  return { sheets: getCurrentSpreadsheet(p).getSheets().map(s => s.getName()) };
}
function getSheetData(p) {
  verifySuperAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName(p.sheetName);
  if (!sheet) return { error: "Sheet not found" };
  const data = sheet.getDataRange().getValues();
  return { data, rows: data.length, cols: data[0] ? data[0].length : 0, sheetName: p.sheetName };
}
function updateSheetCell(p) {
  verifySuperAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName(p.sheetName);
  if (!sheet) throw new Error("Sheet not found");
  const row = parseInt(p.row), col = parseInt(p.col);
  if (row < 2) throw new Error("Cannot edit header row");
  const oldVal = sheet.getRange(row, col).getValue();
  sheet.getRange(row, col).setValue(p.value);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const fieldName = headers[col - 1] || ("Col " + col);
  logAudit({ adminUser: p.adminUser, module: "Sheet:" + p.sheetName, action: "CellEdit",
    field: fieldName, oldValue: String(oldVal), newValue: String(p.value),
    reason: p.reason || "Direct edit", row: row, column: col }, p);
  logActivity({ adminUser: p.adminUser, module: "Sheet:" + p.sheetName, action: "CellEdit",
    detail: "Edited " + fieldName + " in row " + row, oldValue: String(oldVal), newValue: String(p.value) }, p);
  return { result: "Updated" };
}
function addSheetRow(p) {
  verifySuperAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName(p.sheetName);
  if (!sheet) throw new Error("Sheet not found");
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const cols = headers.length || 3;
  const rowData = JSON.parse(p.rowData || "[]");
  const finalRow = Array(cols).fill("").map((v, i) => rowData[i] !== undefined ? rowData[i] : "");
  sheet.appendRow(finalRow);
  const newRowNum = sheet.getLastRow();
  logAudit({ adminUser: p.adminUser, module: "Sheet:" + p.sheetName, action: "AddRow",
    field: "row", oldValue: "", newValue: JSON.stringify(finalRow), reason: p.reason || "New row",
    row: newRowNum, column: 1 }, p);
  logActivity({ adminUser: p.adminUser, module: "Sheet:" + p.sheetName, action: "AddRow",
    detail: "Added new row " + newRowNum + " to " + p.sheetName }, p);
  return { result: "Added", row: newRowNum };
}
function deleteSheetRow(p) {
  verifySuperAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName(p.sheetName);
  if (!sheet) throw new Error("Sheet not found");
  const row = parseInt(p.row);
  if (row < 2) throw new Error("Cannot delete header row");
  const oldData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.deleteRow(row);
  logAudit({ adminUser: p.adminUser, module: "Sheet:" + p.sheetName, action: "DeleteRow",
    field: "row " + row, oldValue: JSON.stringify(oldData), newValue: "", reason: p.reason || "Deleted",
    row: row, column: 1 }, p);
  logActivity({ adminUser: p.adminUser, module: "Sheet:" + p.sheetName, action: "DeleteRow",
    detail: "Deleted row " + row + " from " + p.sheetName }, p);
  return { result: "Deleted" };
}

// ============================================================
// 15. APPLY / CREATE EVENT — OTP + automatic per-event spreadsheet
// ============================================================
const EVENT_CODE_PREFIX = {
  "Marriage": "WED", "Birthday": "BDY", "Reception": "REC", "Engagement": "ENG",
  "Anniversary": "ANN", "Baby Shower": "BBS", "House Warming": "HSW",
  "Temple Festival": "TMP", "Corporate Event": "COR", "Naming Ceremony": "NAM", "Other": "OTH"
};
const EVENT_GALLERY_FOLDER_NAME = {
  "Marriage": ["Marriage Gallery", "Haldi Gallery", "Engagement Gallery"],
  "Birthday": ["Birthday Gallery"], "Reception": ["Reception Gallery"],
  "Temple Festival": ["Festival Gallery"], "Engagement": ["Engagement Gallery"],
  "Anniversary": ["Anniversary Gallery"], "Baby Shower": ["Baby Shower Gallery"],
  "House Warming": ["House Warming Gallery"], "Corporate Event": ["Corporate Gallery"],
  "Naming Ceremony": ["Naming Ceremony Gallery"], "Other": ["Event Gallery"]
};
const FOLDER_NAME_TO_SETTINGS_KEY = {
  "Invitation Card": "INVITATION_FOLDER_ID", "Complaint Uploads": "COMPLAINT_UPLOAD_FOLDER_ID",
  "Marriage Gallery": "MARRIAGE_GALLERY_FOLDER_ID", "Haldi Gallery": "HALDI_GALLERY_FOLDER_ID",
  "Engagement Gallery": "ENGAGEMENT_GALLERY_FOLDER_ID", "Reception Gallery": "RECEPTION_GALLERY_FOLDER_ID",
  "Birthday Gallery": "BIRTHDAY_GALLERY_FOLDER_ID", "Anniversary Gallery": "ANNIVERSARY_GALLERY_FOLDER_ID",
  "Baby Shower Gallery": "BABY_SHOWER_GALLERY_FOLDER_ID", "House Warming Gallery": "HOUSE_WARMING_GALLERY_FOLDER_ID",
  "Festival Gallery": "TEMPLE_FESTIVAL_GALLERY_FOLDER_ID", "Corporate Gallery": "CORPORATE_GALLERY_FOLDER_ID",
  "Naming Ceremony Gallery": "NAMING_CEREMONY_GALLERY_FOLDER_ID", "Event Gallery": "OTHER_GALLERY_FOLDER_ID"
};

function sendOrganizerOtp(email) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, message: "Invalid email address." };
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  CacheService.getScriptCache().put("OTP_" + email, otp, 600);
  try { MailApp.sendEmail(email, "Your EventPay Verification Code", "Your verification code is: " + otp + "\n\nThis code expires in 10 minutes."); }
  catch (err) { return { success: false, message: "Failed to send OTP: " + err.message }; }
  return { success: true, message: "OTP sent." };
}

function verifyOrganizerOtp(email, otp) {
  const cache = CacheService.getScriptCache();
  const stored = cache.get("OTP_" + email);
  if (!stored) return { success: false, message: "OTP expired. Please request a new code." };
  if (stored !== otp) return { success: false, message: "Incorrect OTP." };
  cache.remove("OTP_" + email);
  cache.put("OTP_VERIFIED_" + email, "true", 1800);
  return { success: true, message: "Email verified." };
}

function checkDuplicateEvent(organizerEmail, eventDate, eventName) {
  const sheet = getOrCreateEventsSheet_();
  const data = sheet.getDataRange().getValues();
  const col = {}; data[0].forEach((h, i) => { col[h] = i; });
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const sameEmail = row[col["OrganizerEmail"]] === organizerEmail;
    const sameDate = formatDateOnly_(row[col["CreatedDate"]]) === eventDate ||
      cleanText_(row[col["EventName"]]).toLowerCase() === cleanText_(eventName).toLowerCase();
    if (sameEmail && sameDate) return { duplicate: true, message: "A similar event already exists for this email." };
  }
  return { duplicate: false };
}

function formatDateOnly_(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || "Asia/Kolkata", "dd-MMM-yyyy");
}

function submitEventApplicationAction(p) {
  let formData;
  try { formData = JSON.parse(p.formData || "{}"); }
  catch (err) { return { success: false, message: "Malformed form data." }; }
  // Defense-in-depth: strip any stray "+"/percent-encoding from every text field.
  Object.keys(formData).forEach(k => { if (typeof formData[k] === "string") formData[k] = cleanText_(formData[k]); });
  return submitEventApplication(formData);
}

function submitEventApplication(formData) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache.get("OTP_VERIFIED_" + formData.organizerEmail)) {
      return { success: false, message: "Email not verified. Please verify OTP first." };
    }

    const spreadsheetId = extractSpreadsheetId_(formData.spreadsheetLink);
    if (!spreadsheetId) return { success: false, message: "Could not read a valid Google Sheets link." };

    let targetSs;
    try { targetSs = SpreadsheetApp.openById(spreadsheetId); }
    catch (err) { return { success: false, message: "Spreadsheet not accessible. Check sharing permissions and the link." }; }

    const dup = checkDuplicateEvent(formData.organizerEmail, formData.eventDate, formData.autoEventName);
    if (dup.duplicate && !formData.confirmDuplicateOverride) return { success: false, duplicate: true, message: dup.message };

    if (formData.plan === "Free" && hasClaimedFreeTrial_(formData.organizerEmail)) {
      return { success: false, message: "This email has already used its free trial." };
    }

    const eventId = getNextEventId_();
    const eventCode = generateEventCode_(formData.eventType);
    const eventName = cleanText_(formData.autoEventName || buildEventName_(formData));

    const initResult = initializeEventSpreadsheet(spreadsheetId);
    if (!initResult || !initResult.success) return { success: false, message: "Failed to initialize spreadsheet." };

    const folderResult = createEventDriveFolders_(eventId, eventCode, eventName, formData.eventType);
    writeEventSettings_(targetSs, formData, folderResult.settingsUpdates, eventName);

    const adminUsername = "admin_" + eventCode;
    const adminPassword = generateSecurePassword_(12);
    writeAdminAccount_(targetSs, adminUsername, adminPassword, formData.organizerEmail);

    const publicURL = PUBLIC_BASE_URL + "?event=" + eventCode;
    const adminURL = ADMIN_BASE_URL + "?event=" + eventCode;

    let trialExpiry = "";
    if (formData.plan === "Free") {
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 30);
      trialExpiry = formatReadableDate_(expiryDate);
    }

    const createdDate = formatReadableDate_(new Date());
    insertEventRow_({
      EventID: eventId, EventCode: eventCode, EventType: formData.eventType, EventName: eventName,
      SpreadsheetID: spreadsheetId, SpreadsheetLink: formData.spreadsheetLink,
      OrganizerName: formData.organizerName, OrganizerPhone: formData.organizerPhone, OrganizerEmail: formData.organizerEmail,
      Plan: formData.plan, TrialExpiry: trialExpiry,
      Status: "Active", SettlementStatus: "Pending",
      CreatedDate: createdDate, UpdatedDate: createdDate,
      AdminUsername: adminUsername, AdminPassword: adminPassword, PublicURL: publicURL, AdminURL: adminURL
    });

    logAudit_({ action: "Created Event", organizerEmail: formData.organizerEmail, spreadsheetId: spreadsheetId, eventCode: eventCode, plan: formData.plan });

    try {
      sendEventCreatedEmail_(formData.organizerEmail, {
        eventName: eventName, eventId: eventId, eventCode: eventCode, eventType: formData.eventType,
        organizerName: formData.organizerName, organizerPhone: formData.organizerPhone, organizerEmail: formData.organizerEmail,
        spreadsheetLink: formData.spreadsheetLink, spreadsheetId: spreadsheetId,
        publicURL: publicURL, adminURL: adminURL, adminUsername: adminUsername, adminPassword: adminPassword,
        plan: formData.plan, trialExpiry: trialExpiry, createdDate: createdDate, status: "Active"
      });
    } catch (mailErr) {}

    cache.remove("OTP_VERIFIED_" + formData.organizerEmail);

    return {
      success: true, eventId: eventId, eventCode: eventCode, eventName: eventName,
      spreadsheetLink: formData.spreadsheetLink, publicURL: publicURL, adminURL: adminURL,
      adminUsername: adminUsername, adminPassword: adminPassword
    };
  } catch (err) {
    return { success: false, message: "Unexpected error: " + err.message };
  }
}

function getNextEventId_() {
  const sheet = getOrCreateEventsSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1000;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().filter(v => typeof v === "number");
  if (ids.length === 0) return 1000;
  return Math.max.apply(null, ids) + 1;
}

function generateEventCode_(eventType) {
  const prefix = EVENT_CODE_PREFIX[eventType] || "EVT";
  const sheet = getOrCreateEventsSheet_();
  const data = sheet.getDataRange().getValues();
  const year = new Date().getFullYear().toString().slice(-2);
  let maxSeq = 0;
  for (let i = 1; i < data.length; i++) {
    const code = String(data[i][1] || "");
    if (code.indexOf(prefix + year) === 0) {
      const seq = parseInt(code.slice((prefix + year).length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  const nextSeq = (maxSeq + 1).toString().padStart(3, "0");
  return prefix + year + nextSeq;
}

function insertEventRow_(rowObj) {
  const sheet = getOrCreateEventsSheet_();
  sheet.appendRow(EVENTS_SHEET_HEADERS.map(h => rowObj[h] !== undefined ? rowObj[h] : ""));
}

function hasClaimedFreeTrial_(email) {
  const sheet = getOrCreateEventsSheet_();
  const data = sheet.getDataRange().getValues();
  const col = getColMap(data[0]);
  const emailCol = col["organizeremail"], planCol = col["plan"];
  for (let i = 1; i < data.length; i++) if (data[i][emailCol] === email && data[i][planCol] === "Free") return true;
  return false;
}

function buildEventName_(formData) {
  switch (formData.eventType) {
    case "Marriage": return "Wedding of " + formData.brideName + " & " + formData.groomName;
    case "Reception": return "Reception of " + formData.brideName + " & " + formData.groomName;
    case "Engagement": return "Engagement of " + formData.brideName + " & " + formData.groomName;
    case "Birthday": return "Birthday of " + formData.birthdayPersonName;
    case "Anniversary": return "Anniversary Celebration";
    case "Baby Shower": return "Baby Shower Celebration";
    case "House Warming": return "House Warming of " + formData.familyName;
    case "Temple Festival": return formData.templeName + " Temple Festival";
    case "Corporate Event": return formData.companyName + " Corporate Event";
    default: return formData.customEventName || "Event";
  }
}

function createEventDriveFolders_(eventId, eventCode, eventName, eventType) {
  const cleanName = cleanText_(eventName);
  const root = DriveApp.getFolderById(getRootDriveFolderId_());
  const parentName = eventId + "_" + eventCode + "_" + cleanName;
  const parentFolder = getOrCreateChildFolder_(root, parentName);

  const galleryFolders = EVENT_GALLERY_FOLDER_NAME[eventType] || EVENT_GALLERY_FOLDER_NAME["Other"];
  const foldersToCreate = ["Invitation Card"].concat(galleryFolders).concat(["Complaint Uploads"]);

  const settingsUpdates = {};
  foldersToCreate.forEach(folderName => {
    const folder = getOrCreateChildFolder_(parentFolder, folderName);
    const settingsKey = FOLDER_NAME_TO_SETTINGS_KEY[folderName];
    if (settingsKey) settingsUpdates[settingsKey] = folder.getId();
    if (folderName === "Invitation Card") settingsUpdates["INVITATION_CARD_DRIVE_LINK"] = "https://drive.google.com/drive/folders/" + folder.getId();
  });
  return { parentFolderId: parentFolder.getId(), settingsUpdates: settingsUpdates };
}

function getOrCreateChildFolder_(parentFolder, name) {
  const existing = parentFolder.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : parentFolder.createFolder(name);
}

function writeEventSettings_(targetSs, formData, folderSettings, cleanEventName) {
  const settingsSheet = targetSs.getSheetByName("Settings");
  if (!settingsSheet) return;
  const updates = {
    "Event Name": cleanEventName, "EventDate": formData.eventDate, "EventTime": formData.eventTime,
    "VenueAddress": cleanText_(formData.venue), "VenueMapLink": formData.mapsLink, "UPI_ID": formData.upiId,
    "ORG_NAME": cleanText_(formData.organizerName), "OrganizerEmail": formData.organizerEmail
  };
  Object.keys(folderSettings || {}).forEach(key => { updates[key] = folderSettings[key]; });
  const extraKeys = {
    "BrideName": formData.brideName, "GroomName": formData.groomName, "BirthdayPersonName": formData.birthdayPersonName,
    "FamilyName": formData.familyName, "TempleName": formData.templeName, "CompanyName": formData.companyName,
    "CustomEventName": formData.customEventName, "ExpectedGuests": formData.expectedGuests, "Description": formData.description
  };
  Object.keys(extraKeys).forEach(key => { updates[key] = extraKeys[key]; });

  const data = settingsSheet.getDataRange().getValues();
  const keyToRow = {};
  for (let i = 1; i < data.length; i++) keyToRow[data[i][0]] = i + 1;

  const appendRows = [];
  Object.keys(updates).forEach(key => {
    const value = updates[key];
    if (value === undefined || value === "" || value === null) return;
    if (keyToRow[key]) settingsSheet.getRange(keyToRow[key], 2).setValue(value);
    else appendRows.push([key, value]);
  });
  if (appendRows.length > 0) settingsSheet.getRange(settingsSheet.getLastRow() + 1, 1, appendRows.length, 2).setValues(appendRows);
}

function writeAdminAccount_(targetSs, username, password, email) {
  const adminsSheet = targetSs.getSheetByName("Admins");
  if (!adminsSheet) return;
  adminsSheet.appendRow([username, password, "superadmin", "full", "Active", email, formatReadableDate_(new Date()), ""]);
}

function logAudit_(entry) {
  const masterSs = SpreadsheetApp.openById(getMasterDbId_());
  let sheet = masterSs.getSheetByName("AuditLog");
  if (!sheet) {
    sheet = masterSs.insertSheet("AuditLog");
    sheet.appendRow(["Timestamp", "Action", "OrganizerEmail", "SpreadsheetID", "EventCode", "Plan"]);
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold");
  }
  sheet.appendRow([formatReadableDate_(new Date()), entry.action, entry.organizerEmail, entry.spreadsheetId, entry.eventCode, entry.plan]);
}

function generateSecurePassword_(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let password = "";
  for (let i = 0; i < length; i++) password += chars.charAt(Math.floor(Math.random() * chars.length));
  return password;
}

// Professional HTML confirmation email (requirement #19).
function sendEventCreatedEmail_(to, d) {
  const btn = (label, url) => `<a href="${url}" style="display:inline-block;padding:12px 22px;margin:6px 8px 0 0;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-family:Arial,sans-serif;font-size:14px;">${label}</a>`;
  const row = (label, value) => `<tr><td style="padding:6px 12px;color:#6b7280;font-size:13px;font-family:Arial,sans-serif;white-space:nowrap;">${label}</td><td style="padding:6px 12px;color:#111827;font-size:13px;font-family:Arial,sans-serif;font-weight:600;">${value}</td></tr>`;
  const html = `
  <div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;background:#f9fafb;padding:24px;">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:14px 14px 0 0;padding:28px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">🎉 Your EventPay Event Has Been Created Successfully</h1>
    </div>
    <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:24px;border:1px solid #e5e7eb;border-top:none;">
      <p style="color:#374151;font-size:14px;">Hi ${d.organizerName || "there"}, your event is ready to go. Keep this email safe — it contains your admin login.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9fafb;border-radius:10px;overflow:hidden;">
        ${row("Event Name", d.eventName)}
        ${row("Event Code", d.eventCode)}
        ${row("Event ID", d.eventId)}
        ${row("Event Type", d.eventType || "")}
        ${row("Organizer", d.organizerName || "")}
        ${row("Organizer Phone", d.organizerPhone || "")}
        ${row("Organizer Email", d.organizerEmail || "")}
        ${row("Plan", d.plan + (d.trialExpiry ? " (trial expires " + d.trialExpiry + ")" : ""))}
        ${row("Spreadsheet ID", d.spreadsheetId || "")}
        ${row("Created", d.createdDate || "")}
        ${row("Status", d.status || "Active")}
        ${row("Admin Username", d.adminUsername)}
        ${row("Admin Password", d.adminPassword)}
      </table>
      <p style="color:#b91c1c;font-size:12px;">Please log in and change this password as soon as possible.</p>
      <div style="margin-top:12px;">
        ${btn("Open Public Event", d.publicURL)}
        ${btn("Open Admin Panel", d.adminURL)}
        ${btn("Open Spreadsheet", d.spreadsheetLink)}
      </div>
      <p style="color:#9ca3af;font-size:11px;margin-top:24px;">Support: reply to this email if you need help setting anything up.</p>
    </div>
  </div>`;
  const plain = "Your event has been created.\nEvent: " + d.eventName + " (" + d.eventCode + ")\nAdmin: " + d.adminUsername + " / " + d.adminPassword +
    "\nPublic: " + d.publicURL + "\nAdmin: " + d.adminURL;
  MailApp.sendEmail({ to: to, subject: "🎉 Your EventPay Event Has Been Created Successfully — " + d.eventCode, body: plain, htmlBody: html });
}
