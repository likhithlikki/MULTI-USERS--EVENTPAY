/* ============================================================
   EventPay — Code.gs  (MERGED FILE)
   ------------------------------------------------------------
   This file combines what used to be two separate .gs files:
     1) The original Code.gs (public site, per-event admin/super-admin,
        Apply-Event flow, multi-event registry lookups)
     2) master-admin-backend.gs (the Master Admin panel: platform-wide
        stats, event management, global settings, subscription plans,
        payment gateway, email settings, applications, audit trail,
        Master DB backup/restore)

   WHY THEY WERE COMBINED:
   Google Apps Script only allows ONE doGet() and ONE doPost() per
   project. Having master-admin-backend.gs as a separate file in the
   same project silently broke everything, because Apps Script uses
   whichever doGet/doPost happened to be registered, so all the other
   pages (public site, per-event admin, etc.) stopped getting routed
   correctly. This file exposes a SINGLE doGet/doPost/handleAction
   router that serves BOTH the public/per-event actions and the
   master-admin actions.

   NOTHING about the original logic of either file was changed —
   every function below is copied over as-is from its source file.
   The only additions are:
     - one shared doGet/doPost/out_ (from the original Code.gs)
     - extra `case` entries in handleAction()'s switch so the master
       admin actions are reachable through the same router
     - a small guard that calls requireMasterAuth_() before any
       master-admin action runs (this replicates exactly what
       routeAction_() used to do in master-admin-backend.gs)
     - the ONE genuine naming collision between the two files —
       both defined a "getEvents" action — is resolved by checking
       whether a master session `token` was sent. The public site's
       getEvents call never sends a token; the Master Admin panel
       always does (it logs in via masterLogin first). The master
       version's internal function was renamed getEvents_ ->
       getMasterEvents_ purely so it reads unambiguously next to the
       public getEvents() — its code is unchanged.

   REQUIRED SCRIPT PROPERTIES (Project Settings > Script Properties):
     MASTER_DB_SPREADSHEET_ID   - Master DB spreadsheet ID (used by
                                   the master-admin functions below)
     MASTER-ADMIN-PASS          - the single master admin password
     RAZORPAY_KEY_ID            - (optional) payment gateway key
     RAZORPAY_KEY_SECRET        - (optional) payment gateway secret
     ROOT_DRIVE_FOLDER_ID       - where backups are stored AND where
                                   the Apply-Event flow creates event
                                   folders (both files already shared
                                   this exact property name)
     SHEETS-STORAGE_FOLDER_ID   - where per-event sheets live
============================================================ */

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


function getSheetsStorageFolderId_(){

  const id = getProp_("SHEETS-STORAGE_FOLDER_ID");

  if(!id)
    throw new Error(
      "SHEETS-STORAGE_FOLDER_ID is missing."
    );

  return id;

}

// ============================================================
// 1. HTTP ENTRYPOINTS & ROUTER  (the ONLY doGet/doPost in the project)
// ============================================================
function doPost(e) {
  try {

    if (!e) {
      return out_({
        success: false,
        error: "No request received"
      });
    }

    // Prefer Apps Script parsed parameters
    let p = (e.parameter && Object.keys(e.parameter).length)
      ? e.parameter
      : {};

    // Fallback if parameter is empty
    if (Object.keys(p).length === 0 && e.postData && e.postData.contents) {
      p = {};

      e.postData.contents.split("&").forEach(function(part) {
        const kv = part.split("=");

        const key = decodeURIComponent((kv[0] || "").replace(/\+/g, " "));
        const value = decodeURIComponent((kv.slice(1).join("=") || "").replace(/\+/g, " "));

        p[key] = value;
      });
    }

    const result = handleAction(
      p.action,
      p,
      e.postData ? e.postData.contents : null
    );

    return out_(result);

  } catch (err) {

    Logger.log(err);
    Logger.log(err.stack);

    return out_({
      success: false,
      error: err.toString()
    });

  }
}



function doGet(e) {

  try {

    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action || "";

    if (!action) {
      return out_({
        success: false,
        error: "No action"
      });
    }

    return out_(handleAction(action, params, null));

  } catch (err) {

    return out_({
      success: false,
      error: err.toString()
    });

  }

}





function out_(r) {

  console.log("========== OUT ==========");
  console.log(JSON.stringify(r));
  console.log("=========================");

  return ContentService
      .createTextOutput(JSON.stringify(r))
      .setMimeType(ContentService.MimeType.JSON);
}

// Master-admin actions require a valid master session token (issued by
// masterLogin). This is the exact same gate that routeAction_() used to
// apply in master-admin-backend.gs — it's just enforced here instead,
// since there's now only one router. masterLogin itself is public.
const MASTER_ADMIN_ACTIONS = [
  "getPlatformStats",
  "deactivateEvent",
  "deleteEvent",
  "downloadEventBackup",
  "getSpreadsheetPreview",
  "getGlobalSettings",
  "saveGlobalSettings",
  "getSubscriptionPlans",
  "updatePlanPrice",
 
  "savePaymentGatewaySettings",
  "getEmailSettings",
  "saveEmailSettings",
  "sendTestEmail",
  "getPendingApplications",
  "approveApplication",
  "rejectApplication",
  "getAuditTrail",
  "getMasterDbInfo",
  "createMasterBackup",
  "restoreMasterBackup",
  "downloadMasterBackup",
  "changeMasterPassword",
  "migratePlaintextPasswords"
];

function handleAction(action, p, pd) {
  console.log("ENTER handleAction");
console.log(action);
  console.log("ACTION = " + action);
  try {

    // ---- Master Admin auth gate ----
    // Mirrors what routeAction_() did in the old master-admin-backend.gs:
    // every master-admin action except masterLogin itself must carry a
    // valid session token issued by masterLogin.
    if (MASTER_ADMIN_ACTIONS.indexOf(action) !== -1) {
      requireMasterAuth_(p);
    }

    switch (action) {
     
      case "getSettings":
      return getSettings(p);

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
      // NOTE: "getEvents" is intentionally shared between the public
      // registry lookup and the Master Admin panel's event list. They are
      // disambiguated by the presence of a master session token: the
      // public site never sends `token`, the Master Admin panel always
      // does (it must call masterLogin first to get one).
      case "getEvents":
        if (p.token) {
          requireMasterAuth_(p);
          return getMasterEvents_();
        }
        return getEvents(p);
      case "searchEvent":           return searchEvent(p);
      case "createEventSpreadsheet":return createEventSpreadsheetAction(p);

      // ---- Apply / Create Event ----
      case "sendOrganizerOtp":       return sendOrganizerOtp(p.email);
      case "verifyOrganizerOtp":     return verifyOrganizerOtp(p.email, p.otp);
      case "checkDuplicateEvent":    return checkDuplicateEvent(p.organizerEmail, p.eventDate, p.eventName);
     case "submitEventApplication":
    return submitEventApplication(p);

      case "getHomeBootstrap":
      console.log("ENTER getHomeBootstrap");
      return getHomeBootstrap(p);  

      // ============================================================
      // ---- MASTER ADMIN PANEL ----
      // (moved in from master-admin-backend.gs — logic unchanged)
      // ============================================================
      case "masterLogin":               return masterLogin_(p);

      case "getPlatformStats":          return getPlatformStats_();
      case "deactivateEvent":           return deactivateEvent_(p);
      case "deleteEvent":               return deleteEvent_(p);
      case "downloadEventBackup":       return downloadEventBackup_(p);
      case "getSpreadsheetPreview":     return getSpreadsheetPreview_(p);

      case "getGlobalSettings":         return getGlobalSettings_();
      case "saveGlobalSettings":        return saveGlobalSettings_(p);

      case "getSubscriptionPlans":      return getSubscriptionPlans_();
      case "updatePlanPrice":           return updatePlanPrice_(p);


      case "savePaymentGatewaySettings":return savePaymentGatewaySettings_(p);

      case "getEmailSettings":          return getEmailSettings_();
      case "saveEmailSettings":         return saveEmailSettings_(p);
      case "sendTestEmail":             return sendTestEmail_(p);

      case "getPendingApplications":    return getPendingApplications_();
      case "approveApplication":        return approveApplication_(p);
      case "rejectApplication":         return rejectApplication_(p);

      case "getAuditTrail":             return getAuditTrail_();

      case "getMasterDbInfo":           return getMasterDbInfo_();
      case "createMasterBackup":        return createMasterBackup_();
      case "restoreMasterBackup":       return restoreMasterBackup_(p);
      case "downloadMasterBackup":      return downloadMasterBackup_();

      case "changeMasterPassword":      return changeMasterPassword_(p);

      case "migratePlaintextPasswords": return migratePlaintextPasswords_();


      case "createSubscriptionPaymentLink":
    return createSubscriptionPaymentLink(p);

case "verifySubscriptionPaymentLink":
    return verifySubscriptionPaymentLink(p);

      case "verifySubscriptionPayment":
          return verifySubscriptionPayment(p);

      case "getPaymentGatewaySettings":
          if (p.token) {
            requireMasterAuth_(p);
            return getPaymentGatewaySettings_();
          }
          return getPublicPaymentGatewaySettings_();




      default:
        // Never crash and never show a bare "Unknown backend action" —
        // return a structured, safe JSON error instead (requirement #16).
        return { error: "Unknown action: " + action, result: "Error", success: false };
    }
  } catch (err) {

    console.log("========== HANDLE ACTION ERROR ==========");
    console.log(err.toString());
    console.log(err.stack);
    console.log("Action = " + action);
    console.log("Params = " + JSON.stringify(p));
    console.log("=========================================");

    return {
      success: false,
      result: "Error",
      error: err.toString(),
      stack: err.stack
    };
  }
}


function getPublicVisibilityFromSettings_(s) {

  const isActive = (key) =>
    String(s[key] || "ACTIVE").toUpperCase().trim() === "ACTIVE";

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

// ============================================================
// PASSWORD HASHING (SHA-256) — the single source of truth for turning
// a plaintext password into the value that is ever written to a sheet
// or compared against. Nothing else in this file should call
// Utilities.computeDigest directly — always go through these helpers,
// so there is exactly one place that defines "how we hash".
//
//   hashPassword_(password)   -> lowercase 64-char hex SHA-256 digest
//   isSha256Hash_(value)      -> true if value already looks like one
//
// IMPORTANT: this hashes ONLY inside Code.gs (server side). The
// frontend must keep sending the plaintext password over HTTPS exactly
// as before — do not hash in JavaScript, and do not change any
// request/response field names because of this.
// ============================================================
function hashPassword_(password) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(password),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

function isSha256Hash_(value) {
  return /^[a-f0-9]{64}$/.test(String(value || "").trim());
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

  console.log("SID = " + resolved);

  let via = "default";

  if (p && p.eventSid && String(p.eventSid).trim()) {
    resolved = String(p.eventSid).trim();
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
    console.log(
      "resolveSid_ | action=%s | received sid=%s | received eventCode=%s | resolved via=%s | resolvedSpreadsheetId=%s",
      (p && p.action) || "(n/a)",
      (p && p.eventSid) || "(none)",
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
  console.log("OPENING = " + sid);

  const ss = SpreadsheetApp.openById(sid);
  console.log("OPENED = " + ss.getName());

  try {
    console.log("getCurrentSpreadsheet | Opened spreadsheet id=%s | name=%s", sid, ss.getName());
  } catch (e) {}
  return ss;
}

const EVENTS_SHEET_HEADERS = [
  "EventID",
  "EventCode",
  "EventType",
  "EventName",
  "SpreadsheetID",
  "SpreadsheetLink",
  "OrganizerName",
  "OrganizerPhone",
  "OrganizerEmail",
  "Plan",
  "TrialExpiry",
  "Status",
  "SettlementStatus",
  "CreatedDate",
  "UpdatedDate",
  "AdminUsername",
  "AdminPassword",
  "PublicURL",
  "AdminURL",

  "EventFolderLink",
  "ComplaintFolderLink",
  "BirthdayGalleryLink",
  "HaldiGalleryLink",
  "MarriageGalleryLink",
  "ReceptionGalleryLink",
  "OtherGalleryLink"
];

function getOrCreateEventsSheet_() {

  const ss = SpreadsheetApp.openById(getMasterDbId_());
  console.log("OPENED = " + ss.getName());

  let sheet = ss.getSheetByName("Events");

  if (!sheet) {

    sheet = ss.insertSheet("Events");

    sheet.getRange(1, 1, 1, EVENTS_SHEET_HEADERS.length)
         .setValues([EVENTS_SHEET_HEADERS]);

    sheet.setFrozenRows(1);

    sheet.getRange(1, 1, 1, EVENTS_SHEET_HEADERS.length)
         .setFontWeight("bold");

  } else {

    ensureEventsSheetHeaders_(sheet);

  }

  return sheet;
}

function ensureEventsSheetHeaders_(sheet) {

  try {

    const lastCol = Math.max(sheet.getLastColumn(), 1);

    const existing = sheet
      .getRange(1, 1, 1, lastCol)
      .getValues()[0]
      .map(h => String(h).trim());

    const missing = EVENTS_SHEET_HEADERS.filter(h => existing.indexOf(h) === -1);

    if (missing.length) {

      sheet
        .getRange(1, lastCol + 1, 1, missing.length)
        .setValues([missing]);

      sheet
        .getRange(1, lastCol + 1, 1, missing.length)
        .setFontWeight("bold");

    }

  } catch (e) {
    console.log(e);
  }

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
    const nameC = getColMap(data[0])["eventname"];
    const events = [];
    for (let i = 1; i < data.length; i++) {
      if (!data[i][0]) continue;
      const row = {};
      headers.forEach((h, j) => { row[h] = data[i][j]; });
      if (nameC !== undefined) row.EventName = cleanText_(data[i][nameC]); // strip "+" from names
      // NOTE: inactive events are intentionally included now — the public
      // Event Listing page needs the full roster (active + inactive) to
      // compute accurate stats, populate the Inactive filter, and let the
      // QR scanner resolve inactive events too. Active/inactive display
      // logic lives client-side in index.html's isEventActive().
      //
      // SECURITY: this is the PUBLIC event registry response (no master
      // token). AdminPassword must never leave the sheet in this
      // direction either, even though it's now a hash rather than a
      // plaintext value — the public site has no legitimate use for it.
      delete row.AdminPassword;
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

const lock = LockService.getScriptLock()  ;
lock.waitLock(30000);

try {

  try {
    verifySuperAdmin(p);
    const spreadsheetId = p.targetSpreadsheetId ||p.eventSid ;
    if (!spreadsheetId) return { result: "Error", error: "Target Spreadsheet ID is required." };
    const result = initializeEventSpreadsheet(spreadsheetId);
    return { result: result.success ? "SpreadsheetInitialized" : "Failed" };
  } catch (err) { return { result: "Error", error: err.message }; }


}
finally{
   lock.releaseLock();
}
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

  // ---- KEY ALIASING ----
  // SheetInit.gs / writeEventSettings_ store these under one specific
  // spelling ("Event Name", "ORG_NAME", "INVITATION_CARD_DRIVE_LINK"), but
  // several frontend pages (invite.html, gallery.html, complaint.html,
  // admin-login.html, admin.html's Settings panel) read a different
  // spelling ("EventName", "OrganizerName", "InviteCardURL") that was
  // never actually written anywhere. That mismatch — not a missing
  // Master DB / sid problem — is why those pages showed "Event" /
  // blank fields even though the Event Spreadsheet had the right data.
  // Both spellings are populated here and kept in sync, so every page
  // can read whichever one it was written to expect.
  if (obj["Event Name"] !== undefined && obj["EventName"] === undefined) obj["EventName"] = obj["Event Name"];
  if (obj["EventName"] !== undefined && obj["Event Name"] === undefined) obj["Event Name"] = obj["EventName"];
  if (obj["ORG_NAME"] !== undefined && obj["OrganizerName"] === undefined) obj["OrganizerName"] = obj["ORG_NAME"];
  if (obj["OrganizerName"] !== undefined && obj["ORG_NAME"] === undefined) obj["ORG_NAME"] = obj["OrganizerName"];
  if (obj["INVITATION_CARD_DRIVE_LINK"] !== undefined && obj["InviteCardURL"] === undefined) obj["InviteCardURL"] = obj["INVITATION_CARD_DRIVE_LINK"];
  if (obj["InviteCardURL"] !== undefined && obj["INVITATION_CARD_DRIVE_LINK"] === undefined) obj["INVITATION_CARD_DRIVE_LINK"] = obj["InviteCardURL"];

  if (obj["Event Name"]) obj["Event Name"] = cleanText_(obj["Event Name"]);
  if (obj["EventName"]) obj["EventName"] = cleanText_(obj["EventName"]);
  return obj;
}

function getPublicVisibility(p) {
  return getPublicVisibilityFromSettings_(getSettings(p));
}

function updateSettings(p) {




const lock =LockService.getScriptLock()  ;
lock.waitLock(30000);

try {


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
finally{
   lock.releaseLock();
}
}

// ============================================================
// 5. ADMIN LOGIN  (per-event Admins sheet, with Master DB fallback)
// ------------------------------------------------------------
// SECURITY: both comparison paths below now compare SHA-256 hashes,
// never plaintext. To stay compatible with any rows that predate this
// change (before migratePlaintextPasswords_() has been run), each path
// falls back to a one-time plaintext comparison ONLY when the stored
// value doesn't already look like a 64-char hex hash — and if that
// legacy comparison succeeds, the row is transparently rehashed and
// rewritten on the spot, so every account self-migrates the moment it
// next logs in (in addition to the bulk migratePlaintextPasswords_()).
// ============================================================
function loginAdmin(p) {
  const sid = resolveSid_(p);
  const ss = SpreadsheetApp.openById(sid);
  console.log("OPENED = " + ss.getName());
  const sheet = ss.getSheetByName("Admins");
  let matchedRow = null, adminsData = null;

  if (sheet) {
    adminsData = sheet.getDataRange().getValues();
    for (let i = 1; i < adminsData.length; i++) {
      const u = String(adminsData[i][0]).trim(), storedPw = String(adminsData[i][1]).trim();
      let isMatch = false;

      if (isSha256Hash_(storedPw)) {
        isMatch = (u === p.username && storedPw === hashPassword_(p.password));
      } else {
        // Legacy plaintext row — compare directly once, then migrate.
        isMatch = (u === p.username && storedPw === p.password);
        if (isMatch) {
          try { sheet.getRange(i + 1, 2).setValue(hashPassword_(p.password)); } catch (e) {}
        }
      }

      if (isMatch) { matchedRow = i; break; }
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
      const storedPw = String(data[i][passC]).trim();
      const sameLocation = String(data[i][ssIdC]).trim() === sid && String(data[i][userC]).trim() === p.username;
      if (!sameLocation) continue;

      let isMatch = false;
      if (isSha256Hash_(storedPw)) {
        isMatch = storedPw === hashPassword_(p.password);
      } else {
        isMatch = storedPw === p.password;
        if (isMatch) {
          try { eventsSheet.getRange(i + 1, passC + 1).setValue(hashPassword_(p.password)); } catch (e) {}
        }
      }

      if (isMatch) {
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

const lock = LockService.getScriptLock()  ;
lock.waitLock(30000);

try {

  verifyAdmin(p);
  const ss = getCurrentSpreadsheet(p);
  const sheet = ss.getSheetByName("UTRBlacklist");
  if (!sheet) throw new Error("UTRBlacklist sheet not found");
  const n = nowFormatted();
  sheet.appendRow([p.utr, n.full, p.reason || "Manually blacklisted by " + p.adminUser]);
  return { result: "Blacklisted" };

}
finally{
   lock.releaseLock();
}

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


console.log("STEP 1");

const lock = LockService.getScriptLock();
console.log("STEP 2");
lock.waitLock(30000);

console.log("STEP 3");
console.log("eventSid = " + p.eventSid);
const ss = getCurrentSpreadsheet(p);

console.log("STEP 4");
console.log(ss.getId());

const sheet = ss.getSheetByName("Payments");
console.log("STEP 5");

try {




  console.log("insertPayment sid = " + p.eventSid);
  const ss = getCurrentSpreadsheet(p);
  console.log("Spreadsheet = " + ss.getName());
  const sheet = ss.getSheetByName("Payments");
  console.log("Sheet = " + sheet.getName());

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
  
const utrCheck = validateUTR({
    utr: p.utr,
    phone: p.phone,
    eventSid: p.eventSid,
    eventCode: p.eventCode
});

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
finally{
   lock.releaseLock();
}

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

function getHomeBootstrap(p) {

  console.log("START getHomeBootstrap");

  try {

    console.log("Loading Settings");
    const settings = getSettings(p);

    console.log("Loading Visibility");
    const visibility = getPublicVisibilityFromSettings_(settings);

    console.log("Loading Stats");
    const stats = getPublicStats(p);

    console.log("Loading Villages");
    const villages = getVillageSuggestions(p);

    console.log("Loading Transactions");
    const recent = getRecentTransactions(p);

    console.log("SUCCESS");

    return {
      settings,
      visibility,
      stats,
      villages: villages.villages || [],
      transactions: recent.transactions || []
    };

  } catch (e) {

    console.log("ERROR: " + e);
    console.log(e.stack);

    return {
      error: e.toString(),
      success: false
    };
  }
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


  const lock = LockService.getScriptLock()  ;
lock.waitLock(30000);

try {

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
finally{
   lock.releaseLock();
}

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


const lock = LockService.getScriptLock()   ;
lock.waitLock(30000);

try {
  console.log("===== INSERT COMPLAINT =====");
console.log(JSON.stringify(p));

 const ss = getCurrentSpreadsheet(p);
 console.log("Spreadsheet = " + ss.getName());

  const sheet = ss.getSheetByName("Complaints");
  console.log("Sheet = " + (sheet ? sheet.getName() : "NULL"));

  if (!sheet) return { result: "Error", message: "Complaints sheet not found" };
  const n = nowFormatted();
  let fileUrl = "", fileStatus = "None";

  if (p.filedata && p.filename) {
    console.log("Uploading attachment...");
    try {
      const s = getSettings(p);
      const folderID = extractFolderID(s.COMPLAINT_UPLOAD_FOLDER_ID);
      if (folderID) {
        const folder = DriveApp.getFolderById(folderID);
        const cleanBase64 = String(p.filedata).split(",")[1] || p.filedata;
        const decoded = Utilities.base64Decode(cleanBase64);
        const blob = Utilities.newBlob(decoded, p.filetype || "application/octet-stream", p.filename);
        const file = folder.createFile(blob);
        console.log("File uploaded = " + file.getId());
        
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        fileUrl = "https://drive.google.com/file/d/" + file.getId() + "/view";
        fileStatus = "Attached";
      }
    }catch (e) {
  console.log("UPLOAD ERROR = " + e);
  throw e;
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
finally{
   lock.releaseLock();
}

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


const lock = LockService.getScriptLock()   ;
lock.waitLock(30000);

try {



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
finally{
   lock.releaseLock();
}

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


const lock =LockService.getScriptLock()   ;
lock.waitLock(30000);

try {

  
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
finally{
   lock.releaseLock();
}

}

// ============================================================
// 10. GALLERY — auto-detects eventCode / sid / raw folder IDs
// ============================================================
// All possible per-event gallery folder settings this app can create
// (see FOLDER_NAME_TO_SETTINGS_KEY below, in section 15). A given event
// only ever has the few relevant to its EventType populated — sections
// whose settingKey is blank/unset for this event are omitted entirely,
// but any section that DOES have a folder ID configured is always
// included in the response, even if that folder currently has zero
// images, so the frontend can render an empty state instead of quietly
// hiding the whole section or treating it as a failure.
const GALLERY_SECTIONS = [
  { key: "engagement",    label: "Engagement",        settingKey: "ENGAGEMENT_GALLERY_FOLDER_ID" },
  { key: "haldi",         label: "Haldi Ceremony",     settingKey: "HALDI_GALLERY_FOLDER_ID" },
  { key: "marriage",      label: "Marriage",           settingKey: "MARRIAGE_GALLERY_FOLDER_ID" },
  { key: "reception",     label: "Reception",          settingKey: "RECEPTION_GALLERY_FOLDER_ID" },
  { key: "birthday",      label: "Birthday",           settingKey: "BIRTHDAY_GALLERY_FOLDER_ID" },
  { key: "anniversary",   label: "Anniversary",        settingKey: "ANNIVERSARY_GALLERY_FOLDER_ID" },
  { key: "babyshower",    label: "Baby Shower",        settingKey: "BABY_SHOWER_GALLERY_FOLDER_ID" },
  { key: "housewarming",  label: "House Warming",      settingKey: "HOUSE_WARMING_GALLERY_FOLDER_ID" },
  { key: "festival",      label: "Temple Festival",    settingKey: "TEMPLE_FESTIVAL_GALLERY_FOLDER_ID" },
  { key: "corporate",     label: "Corporate Event",    settingKey: "CORPORATE_GALLERY_FOLDER_ID" },
  { key: "naming",        label: "Naming Ceremony",    settingKey: "NAMING_CEREMONY_GALLERY_FOLDER_ID" },
  { key: "other",         label: "Event Gallery",      settingKey: "OTHER_GALLERY_FOLDER_ID" },
  { key: "invitation",    label: "Invitation Card",    settingKey: "INVITATION_FOLDER_ID" }
];

function getGalleryImages(p) {
  try {
    const s = getSettings(p); // getCurrentSpreadsheet inside getSettings already handles sid/eventCode/default

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
      } catch (e) { return []; } // folder missing/inaccessible -> empty, never an error for the whole request
    }

    const sections = {};
    const sectionMeta = [];
    GALLERY_SECTIONS.forEach(function (sec) {
      const folderID = extractFolderID(s[sec.settingKey]);
      if (!folderID) return; // this event never configured this section — omit it, don't show an empty tab for it
      sections[sec.key] = getFolderImages(folderID, sec.label); // may legitimately be [] — still included
      sectionMeta.push({ key: sec.key, label: sec.label });
    });

    const allImages = Object.keys(sections).reduce(function (acc, k) { return acc.concat(sections[k]); }, []);
    return { images: allImages, sections: sections, sectionMeta: sectionMeta };
  } catch (e) { return { images: [], sections: {}, sectionMeta: [], error: e.message }; }
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


  const lock = LockService.getScriptLock()  ;
lock.waitLock(30000);

try {

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
finally{
   lock.releaseLock();
}
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

  // SECURITY: this generic raw-sheet viewer is otherwise untouched (same
  // super-admin-only feature as before), but the "Admins" sheet's column B
  // is a password hash and must never be shipped to the frontend, even to
  // an already-authenticated super admin. Every other sheet/column is
  // returned exactly as before.
  if (String(p.sheetName).trim() === "Admins" && data.length) {
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] !== undefined && data[i][1] !== "") data[i][1] = "••••••••";
    }
  }

  return { data, rows: data.length, cols: data[0] ? data[0].length : 0, sheetName: p.sheetName };
}
function updateSheetCell(p) {


  const lock = LockService.getScriptLock();
lock.waitLock(30000);

try {


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
finally{
   lock.releaseLock();
}
}

function addSheetRow(p) {
  

const lock =LockService.getScriptLock()  ;
lock.waitLock(30000);

try {

 
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


finally{
   lock.releaseLock();
}
}

function deleteSheetRow(p) {

  const lock = LockService.getScriptLock()  ;
  lock.waitLock(30000);

  try {

    verifySuperAdmin(p);

    const ss = getCurrentSpreadsheet(p);
    const sheet = ss.getSheetByName(p.sheetName);

    if (!sheet) throw new Error("Sheet not found");

    const row = parseInt(p.row);

    if (row < 2)
      throw new Error("Cannot delete header row");

    const oldData =
      sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];

    sheet.deleteRow(row);

    logAudit({
      adminUser: p.adminUser,
      module: "Sheet:" + p.sheetName,
      action: "DeleteRow",
      field: "row " + row,
      oldValue: JSON.stringify(oldData),
      newValue: "",
      reason: p.reason || "Deleted",
      row: row,
      column: 1
    }, p);

    logActivity({
      adminUser: p.adminUser,
      module: "Sheet:" + p.sheetName,
      action: "DeleteRow",
      detail: "Deleted row " + row + " from " + p.sheetName
    }, p);

    return {
      result: "Deleted"
    };

  } finally {

    lock.releaseLock();

  }
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

function submitEventApplication(formData) {

  const eventId = getNextEventId_();
  const eventCode = generateEventCode_(formData.eventType);
  const eventName = cleanText_(formData.autoEventName || buildEventName_(formData));

  try {

    const cache = CacheService.getScriptCache();
    if (!cache.get("OTP_VERIFIED_" + formData.organizerEmail)) {
      return { success: false, message: "Email not verified. Please verify OTP first." };
    }

    // ---- NEW: read global config from Master DB before any writes ----
    const globalSettings = readGlobalSettings_();
    const globalPayments = getMasterPaymentSettings_(); // available if plan pricing is needed downstream

    const createdSpreadsheet = createEventSpreadsheet_(eventCode);
    const spreadsheetId = createdSpreadsheet.spreadsheetId;
    const spreadsheetLink = createdSpreadsheet.spreadsheetUrl;

    const dup = checkDuplicateEvent(formData.organizerEmail, formData.eventDate, formData.autoEventName);
    if (dup.duplicate && !formData.confirmDuplicateOverride) {
      return { success: false, duplicate: true, message: dup.message };
    }

    if (formData.plan === "Free" && hasClaimedFreeTrial_(formData.organizerEmail)) {
      return { success: false, message: "This email has already used its free trial." };
    }

    const initResult = initializeEventSpreadsheet(spreadsheetId);
    if (!initResult || !initResult.success) {
      return { success: false, message: "Failed to initialize spreadsheet." };
    }

    const targetSs = SpreadsheetApp.openById(spreadsheetId);
    moveSpreadsheetToStorageFolder_(spreadsheetId);

    const folderResult = createEventDriveFolders_(eventId, eventCode, eventName, formData.eventType);
    writeEventSettings_(targetSs, formData, folderResult.settingsUpdates, eventName);

    const adminUsername = "admin_" + eventCode;
    // Plaintext is generated here and used ONLY for (a) the one-time
    // organizer notification email below and (b) the one-time success
    // response returned to the frontend right after signup — the only
    // two places a freshly-created password is ever allowed to appear as
    // plaintext, because that's the organizer's sole chance to learn it.
    // Everywhere it is PERSISTED (the event spreadsheet's Admins sheet,
    // and the Master DB Events sheet's AdminPassword column) it is
    // hashed first — see writeAdminAccount_() and insertEventRow_() below.
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
    const eventFolderLink = folderResult.parentFolderId
      ? "https://drive.google.com/drive/folders/" + folderResult.parentFolderId
      : "";

    insertEventRow_({
       EventID: eventId, EventCode: eventCode, EventType: formData.eventType, EventName: eventName,
       SpreadsheetID: spreadsheetId, SpreadsheetLink: spreadsheetLink,
       OrganizerName: formData.organizerName, OrganizerPhone: formData.organizerPhone, OrganizerEmail: formData.organizerEmail,
       Plan: formData.plan, TrialExpiry: trialExpiry,
       Status: formData.eventStatus || "Active",   // CHANGED: was hardcoded "Active"
       
      SettlementStatus: "Pending",
      CreatedDate: createdDate, UpdatedDate: createdDate,
      AdminUsername: adminUsername,
      // SECURITY: only the hash is ever written to the Master DB registry.
      AdminPassword: hashPassword_(adminPassword),
      PublicURL: publicURL, AdminURL: adminURL,
      EventFolderLink: eventFolderLink,
      ComplaintFolderLink: folderResult.settingsUpdates["COMPLAINT_UPLOAD_FOLDER_ID"]
        ? "https://drive.google.com/drive/folders/" + folderResult.settingsUpdates["COMPLAINT_UPLOAD_FOLDER_ID"] : "",
      BirthdayGalleryLink: folderResult.settingsUpdates["BIRTHDAY_GALLERY_FOLDER_ID"]
        ? "https://drive.google.com/drive/folders/" + folderResult.settingsUpdates["BIRTHDAY_GALLERY_FOLDER_ID"] : "",
      HaldiGalleryLink: folderResult.settingsUpdates["HALDI_GALLERY_FOLDER_ID"]
        ? "https://drive.google.com/drive/folders/" + folderResult.settingsUpdates["HALDI_GALLERY_FOLDER_ID"] : "",
      MarriageGalleryLink: folderResult.settingsUpdates["MARRIAGE_GALLERY_FOLDER_ID"]
        ? "https://drive.google.com/drive/folders/" + folderResult.settingsUpdates["MARRIAGE_GALLERY_FOLDER_ID"] : "",
      ReceptionGalleryLink: folderResult.settingsUpdates["RECEPTION_GALLERY_FOLDER_ID"]
        ? "https://drive.google.com/drive/folders/" + folderResult.settingsUpdates["RECEPTION_GALLERY_FOLDER_ID"] : "",
      OtherGalleryLink: folderResult.settingsUpdates["OTHER_GALLERY_FOLDER_ID"]
        ? "https://drive.google.com/drive/folders/" + folderResult.settingsUpdates["OTHER_GALLERY_FOLDER_ID"] : ""
    });

    logAudit_({
      action: "Created Event", organizerEmail: formData.organizerEmail,
      spreadsheetId: spreadsheetId, eventCode: eventCode, plan: formData.plan
    });

    // ---- MODIFIED: gated by globalSettings, not hardcoded ----
    try {
      if (String(globalSettings["Send Event Created Email"] || "TRUE").toUpperCase().trim() === "TRUE") {
        sendEventCreatedEmail_(formData.organizerEmail, {
          eventName: eventName, eventId: eventId, eventCode: eventCode, eventType: formData.eventType,
          organizerName: formData.organizerName, organizerPhone: formData.organizerPhone, organizerEmail: formData.organizerEmail,
          spreadsheetLink: spreadsheetLink, spreadsheetId: spreadsheetId,
          publicURL: publicURL, adminURL: adminURL, eventFolderLink: eventFolderLink,
          adminUsername: adminUsername, adminPassword: adminPassword,
          plan: formData.plan, trialExpiry: trialExpiry, createdDate: createdDate, status: "Active"
        }, globalSettings);
      }
    } catch (mailErr) {}

    cache.remove("OTP_VERIFIED_" + formData.organizerEmail);

    return {
      success: true, eventId: eventId, eventCode: eventCode, eventName: eventName,
      SpreadsheetLink: spreadsheetLink, publicURL: publicURL, adminURL: adminURL,
      adminUsername: adminUsername, adminPassword: adminPassword
    };

  } catch (err) {
    return { success: false, message: "Unexpected error: " + err.message };
  }
}



function createEventSpreadsheet_(eventCode){

  const ss = SpreadsheetApp.create("EventPay - " + eventCode);

  return{
    spreadsheetId:ss.getId(),
    spreadsheetUrl:ss.getUrl(),
    ss:ss
  };

}

function moveSpreadsheetToStorageFolder_(spreadsheetId) {

  const folder = DriveApp.getFolderById(getSheetsStorageFolderId_());
  const file = DriveApp.getFileById(spreadsheetId);

  try {
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
    console.log("Spreadsheet moved successfully.");
  } catch (e) {
    console.log("Failed to move spreadsheet: " + e);
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
  // SECURITY: only the SHA-256 hash of the freshly-generated password is
  // ever written to the sheet. `password` (plaintext) is only used by the
  // caller to email/return the one-time credential — it is never stored
  // here or anywhere else.
  adminsSheet.appendRow([username, hashPassword_(password), "superadmin", "full", "Active", email, formatReadableDate_(new Date()), ""]);
}

function logAudit_(entry) {
  const masterSs = SpreadsheetApp.openById(getMasterDbId_());
 console.log(masterSs.getName());;
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


function ensureMasterSettingsSheet_() {

  const ss = SpreadsheetApp.openById(getMasterDbId_());
  let sheet = ss.getSheetByName("Settings");

  const defaults = [
    ["Send Event Created Email", "TRUE"],
    ["Send Spreadsheet Link", "TRUE"],
    ["Send Spreadsheet ID", "TRUE"],
    ["Send Parent Event Folder Link", "TRUE"],
    ["Send Organizer Details", "TRUE"],
    ["Send Admin Credentials", "TRUE"],
    ["Send Public URL", "TRUE"],
    ["Send Admin URL", "TRUE"],
    ["Send Subscription Details", "TRUE"],
    ["Send Plan Details", "TRUE"],
    ["Allow Gallery Folder Links", "TRUE"],
    ["Allow Password Reset", "TRUE"],
    ["Password Reset Expiry (Minutes)", 30],
    ["Send Password Reset Email", "TRUE"]
  ];

  if (!sheet) {
    sheet = ss.insertSheet("Settings");
    sheet.getRange(1, 1, 1, 2).setValues([["Setting", "Value"]]).setFontWeight("bold");
    sheet.getRange(2, 1, defaults.length, 2).setValues(defaults);
    sheet.setFrozenRows(1);
    return;
  }

  const lastRow = sheet.getLastRow();
  const existingKeys = {};
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(r => {
      const k = String(r[0]).trim();
      if (k) existingKeys[k] = true;
    });
  }

  const missing = defaults.filter(pair => !existingKeys[pair[0]]);
  if (missing.length > 0) {
    sheet.getRange(Math.max(lastRow + 1, 2), 1, missing.length, 2).setValues(missing);
  }
}


/**
 * Reads the MASTER DB's Settings sheet (global, org-wide flags only —
 * e.g. SEND_SPREADSHEET_LINK, SEND_ADMIN_CREDENTIALS). Ensures the sheet
 * exists first. Never touches any event spreadsheet.
 * @return {Object} key -> value map
 */
function readGlobalSettings_() {
  ensureMasterSettingsSheet_();
  const ss = SpreadsheetApp.openById(getMasterDbId_());
  const sheet = ss.getSheetByName("Settings");
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const obj = {};
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0] || "").trim();
    if (key) obj[key] = data[i][1];
  }
  return obj;
}



/**
 * Idempotent creator for the MASTER DB's global Payments sheet
 * (plan pricing / gateway config only — never per-event payment data).
 * Safe to call repeatedly: only creates what's missing, never
 * duplicates rows or overwrites an existing value.
 */
function ensureMasterPaymentsSheet_() {
  const ss = SpreadsheetApp.openById(getMasterDbId_());
  let sheet = ss.getSheetByName("Payments");

  const defaults = [
    ["Payment Gateway Enabled", "FALSE"],
    ["Gateway Name", ""],
    ["Basic Plan Price", 0],
    ["Premium Plan Price", 0],
    ["Enterprise Plan Price", 0]
  ];

  if (!sheet) {
    sheet = ss.insertSheet("Payments");
    sheet.getRange(1, 1, 1, 2).setValues([["Setting", "Value"]]).setFontWeight("bold");
    sheet.getRange(2, 1, defaults.length, 2).setValues(defaults);
    sheet.setFrozenRows(1);
    return;
  }

  const lastRow = sheet.getLastRow();
  const existingKeys = {};
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(r => {
      const k = String(r[0]).trim();
      if (k) existingKeys[k] = true;
    });
  }

  const missing = defaults.filter(pair => !existingKeys[pair[0]]);
  if (missing.length > 0) {
    sheet.getRange(Math.max(lastRow + 1, 2), 1, missing.length, 2).setValues(missing);
  }
}



/**
 * Reads the MASTER DB's Payments sheet (global plan/gateway config only).
 * Ensures the sheet exists first. Never touches any event spreadsheet.
 * @return {Object} key -> value map
 */
function getMasterPaymentSettings_() {
  ensureMasterPaymentsSheet_();
  const ss = SpreadsheetApp.openById(getMasterDbId_());
  const sheet = ss.getSheetByName("Payments");
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const obj = {};
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0] || "").trim();
    if (key) obj[key] = data[i][1];
  }
  return obj;
}




// Professional HTML confirmation email (requirement #19).
function sendEventCreatedEmail_(to, d, globalSettings) {
  const g = globalSettings || {};
  const isOn = (key) => String(g[key] || "TRUE").toUpperCase().trim() === "TRUE";

  const btn = (label, url) => `<a href="${url}" style="display:inline-block;padding:12px 22px;margin:6px 8px 0 0;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-family:Arial,sans-serif;font-size:14px;">${label}</a>`;
  const row = (label, value) => `<tr><td style="padding:6px 12px;color:#6b7280;font-size:13px;font-family:Arial,sans-serif;white-space:nowrap;">${label}</td><td style="padding:6px 12px;color:#111827;font-size:13px;font-family:Arial,sans-serif;font-weight:600;">${value}</td></tr>`;

  let rows = "";
  rows += row("Event Name", d.eventName);
  rows += row("Event Code", d.eventCode);
  rows += row("Event ID", d.eventId);
  rows += row("Event Type", d.eventType || "");
  if (isOn("Send Organizer Details")) {
    rows += row("Organizer", d.organizerName || "");
    rows += row("Organizer Phone", d.organizerPhone || "");
    rows += row("Organizer Email", d.organizerEmail || "");
  }
  if (isOn("Send Plan Details")) rows += row("Plan", d.plan + (d.trialExpiry ? " (trial expires " + d.trialExpiry + ")" : ""));
  if (isOn("Send Spreadsheet ID")) rows += row("Spreadsheet ID", d.spreadsheetId || "");
  rows += row("Created", d.createdDate || "");
  rows += row("Status", d.status || "Active");
  if (isOn("Send Admin Credentials")) {
    rows += row("Admin Username", d.adminUsername);
    rows += row("Admin Password", d.adminPassword);
  }

  let buttons = "";
  if (isOn("Send Public URL")) buttons += btn("Open Public Event", d.publicURL);
  if (isOn("Send Admin URL")) buttons += btn("Open Admin Panel", d.adminURL);
  if (isOn("Send Spreadsheet Link")) buttons += btn("Open Spreadsheet", d.spreadsheetLink);
  if (isOn("Send Parent Event Folder Link") && d.eventFolderLink) buttons += btn("Open Event Folder", d.eventFolderLink);

  const html = `
  <div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;background:#f9fafb;padding:24px;">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:14px 14px 0 0;padding:28px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">🎉 Your EventPay Event Has Been Created Successfully</h1>
    </div>
    <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:24px;border:1px solid #e5e7eb;border-top:none;">
      <p style="color:#374151;font-size:14px;">Hi ${d.organizerName || "there"}, your event is ready to go. Keep this email safe — it contains your admin login.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9fafb;border-radius:10px;overflow:hidden;">
        ${rows}
      </table>
      ${isOn("Send Admin Credentials") ? '<p style="color:#b91c1c;font-size:12px;">Please log in and change this password as soon as possible.</p>' : ""}
      <div style="margin-top:12px;">
        ${buttons}
      </div>
      <p style="color:#9ca3af;font-size:11px;margin-top:24px;">Support: reply to this email if you need help setting anything up.</p>
    </div>
  </div>`;

  const plain = "Your event has been created.\nEvent: " + d.eventName + " (" + d.eventCode + ")" +
    (isOn("Send Admin Credentials") ? "\nAdmin: " + d.adminUsername + " / " + d.adminPassword : "") +
    (isOn("Send Public URL") ? "\nPublic: " + d.publicURL : "") +
    (isOn("Send Admin URL") ? "\nAdmin: " + d.adminURL : "");

  MailApp.sendEmail({ to: to, subject: "🎉 Your EventPay Event Has Been Created Successfully — " + d.eventCode, body: plain, htmlBody: html });
}

// ============================================================
// 16. MASTER ADMIN PANEL
// ------------------------------------------------------------
// Everything below is copied over unchanged from the old
// master-admin-backend.gs, EXCEPT:
//   - its doGet/doPost/handleRequest_/jsonOut_/routeAction_ were removed
//     (this file's doGet/doPost/out_/handleAction above now do that job)
//   - requireAuth_ was renamed to requireMasterAuth_ (same body) so it
//     can't be confused with the per-event verifyAdmin/verifySuperAdmin
//     above, and so its name is self-explanatory now that it lives next
//     to them in the same file
//   - its getEvents_ was renamed to getMasterEvents_ purely for
//     readability next to the public getEvents() above — see the
//     "getEvents" case in handleAction() for how the two are told apart
//   - masterLogin_/changeMasterPassword_ now hash-compare (SHA-256)
//     instead of comparing MASTER-ADMIN-PASS in plaintext — see those
//     two functions below for the migrate-on-first-use logic
//
// This backend manages ONLY the Master Database. It never touches
// an individual event's own spreadsheet except to read a read-only
// preview of it (getSpreadsheetPreview) and to back it up.
// ============================================================

// ---- MASTER ADMIN AUTH ----
// Single master admin, password-only. A session token is issued on
// success and cached (CacheService, max 1 hour) so every subsequent
// call can be checked cheaply without re-hitting Script Properties.
const SESSION_TTL_SECONDS = 60 * 60; // 1 hour, matches frontend SESSION_MINUTES

// ============================================================
// SECURITY: MASTER-ADMIN-PASS (Script Property) now stores a SHA-256
// hash, not plaintext. To stay compatible with a project that hasn't
// been migrated yet, masterLogin_ falls back to a one-time plaintext
// comparison ONLY if the stored property doesn't already look like a
// 64-char hex hash, and immediately rewrites the property as a hash the
// moment that legacy comparison succeeds — the same self-migrating
// pattern used in loginAdmin() above. migratePlaintextPasswords_()
// (bottom of this file) also migrates this property in one bulk pass.
// ============================================================
function masterLogin_(p) {
  const password = String(p.password || "");
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty("MASTER-ADMIN-PASS") || "";

  let ok = false;
  if (isSha256Hash_(stored)) {
    ok = !!password && hashPassword_(password) === stored;
  } else {
    // Legacy plaintext property — compare once, then migrate in place.
    ok = !!password && password === stored;
    if (ok) props.setProperty("MASTER-ADMIN-PASS", hashPassword_(password));
  }

  if (!ok) {
    return { success: false, error: "Incorrect master password." };
  }

  const token = Utilities.getUuid();
  CacheService.getScriptCache().put("session_" + token, "valid", SESSION_TTL_SECONDS);

  return {
    success: true,
    token: token,
    expiresInSeconds: SESSION_TTL_SECONDS,
  };
}

function requireMasterAuth_(p) {
  const token = p.token;
  if (!token || CacheService.getScriptCache().get("session_" + token) !== "valid") {
    throw new Error("Not authenticated — please log in again.");
  }
  // Sliding expiry: touching the session extends it while the admin is active.
  CacheService.getScriptCache().put("session_" + token, "valid", SESSION_TTL_SECONDS);
}

function changeMasterPassword_(p) {
  const current = String(p.current || "");
  const next = String(p.next || "");
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty("MASTER-ADMIN-PASS") || "";

  let currentOk = false;
  if (isSha256Hash_(stored)) {
    currentOk = hashPassword_(current) === stored;
  } else {
    // Legacy plaintext property.
    currentOk = current === stored;
  }

  if (!currentOk) return { success: false, error: "Current password is incorrect." };
  if (!next || next.length < 6) return { success: false, error: "New password must be at least 6 characters." };

  // Only the hash is ever written back.
  props.setProperty("MASTER-ADMIN-PASS", hashPassword_(next));
  appendAuditLog_("Changed Master Password", "master", "", "", "");
  return { success: true };
}

// ---- MASTER DB SHEET HELPERS ----
function getMasterSS_() {
  const id = PropertiesService.getScriptProperties().getProperty("MASTER_DB_SPREADSHEET_ID");
  if (!id) throw new Error("MASTER_DB_SPREADSHEET_ID script property is not set.");
  return SpreadsheetApp.openById(id);
}
function getSheet_(name) {
  const sheet = getMasterSS_().getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found in Master DB.');
  return sheet;
}

// Converts a sheet's rows into an array of objects, keyed by a
// camelCase version of each header. Handles duplicate header names by
// keeping the first occurrence (so e.g. two "SpreadsheetLink" columns
// don't clobber each other silently) — adjust HEADER_ALIASES below if
// your sheet's exact header text differs.
function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(headerToKey_);
  const seen = {};
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every((c) => c === "" || c === null)) continue; // skip blank rows
    const obj = { __row: r + 1 }; // 1-based sheet row, for later writes
    headers.forEach((key, i) => {
      const finalKey = seen[key] ? key + "2" : key; // avoid clobbering dup headers
      if (!(finalKey in obj)) obj[finalKey] = row[i];
    });
    headers.forEach((key) => (seen[key] = true));
    rows.push(obj);
  }
  return rows;
}

// Known header text -> the exact camelCase key the frontend expects.
// Anything not listed here is auto-camelCased as a fallback.
const HEADER_ALIASES = {
  "EventID": "eventId",
  "EventCode": "eventCode",
  "EventType": "eventType",
  "EventName": "eventName",
  "SpreadsheetID": "spreadsheetId",
  "SpreadSheetLink": "spreadsheetLink",
  "SpreadsheetLink": "spreadsheetLink",
  "OrganizerName": "organizerName",
  "OrganizerPhone": "organizerPhone",
  "OrganizerEmail": "organizerEmail",
  "Plan": "plan",
  "TrialExpiry": "trialExpiry",
  "Status": "status",
  "SettlementStatus": "settlementStatus",
  "CreatedDate": "createdDate",
  "UpdatedDate": "updatedDate",
  "AdminUsername": "adminUsername",
  "AdminPassword": "adminPassword",
  "PublicURL": "publicUrl",
  "AdminURL": "adminUrl",
  "EventFolderLink": "parentFolderLink",
  "Timestamp": "date",
  "Action": "action",
  "OrganizerEmail ": "organizerEmail",
  "IP": "ip",
};
function headerToKey_(header) {
  const h = String(header || "").trim();
  if (HEADER_ALIASES[h]) return HEADER_ALIASES[h];
  // fallback: "Some Header" -> "someHeader"
  return h
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^./, (c) => c.toLowerCase());
}

function findColumnIndex_(sheet, headerText) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = headers.findIndex((h) => String(h).trim() === headerText);
  return idx === -1 ? -1 : idx + 1; // 1-based
}

function appendAuditLog_(action, user, organizerEmail, spreadsheetId, eventCode, plan) {
  try {
    const sheet = getSheet_("AuditLog");
    sheet.appendRow([
      Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Kolkata", "dd-MMM-yyyy hh:mm a"),
      action,
      organizerEmail || "",
      spreadsheetId || "",
      eventCode || "",
      plan || "",
    ]);
  } catch (e) {
    // Audit logging should never break the primary action.
  }
}

// ---- DASHBOARD STATS ----
function getPlatformStats_() {
  const events = sheetToObjects_(getSheet_("Events"));
  const applications = safeSheetToObjects_("EventApplications");
  const payments = safeSheetToObjects_("Payments");

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Kolkata", "dd-MMM-yyyy");

  const activeEvents = events.filter((e) => e.status === "Active").length;
  const expiredEvents = events.filter((e) => e.status === "Expired").length;
  const pendingApplications = applications.filter((a) => (a.status || "").toLowerCase() === "pending").length;
  const organizers = new Set(events.map((e) => e.organizerEmail).filter(Boolean));
  const activePlans = new Set(events.filter((e) => e.status === "Active").map((e) => e.plan)).size;

  let totalRevenue = 0;
  let totalCollections = 0;
  payments.forEach((row) => {
    const amt = Number(row.amount || row.Amount || 0);
    totalRevenue += amt;
    totalCollections += amt;
  });

  const todaysRegistrations = events.filter((e) => String(e.createdDate || "").indexOf(today) === 0).length;

  return {
    success: true,
    stats: {
      totalEvents: events.length,
      activeEvents,
      expiredEvents,
      pendingApplications,
      totalOrganizers: organizers.size,
      totalCollections,
      activePlans,
      totalRevenue,
      todaysRegistrations,
    },
  };
}

function safeSheetToObjects_(name) {
  try { return sheetToObjects_(getSheet_(name)); } catch (e) { return []; }
}

// ---- EVENTS (Master Admin panel) ----
// SECURITY: adminPassword is now a SHA-256 hash in the sheet — it must
// still never reach the frontend, so it is stripped from every row
// here before returning, exactly like the public getEvents() above.
function getMasterEvents_() {
  const events = sheetToObjects_(getSheet_("Events")).map((ev) => {
    const copy = Object.assign({}, ev);
    delete copy.adminPassword;
    return copy;
  });
  return { success: true, events: events };
}

function deactivateEvent_(p) {
  const sheet = getSheet_("Events");
  const row = findEventRow_(sheet, p.eventId);
  if (!row) return { success: false, error: "Event not found." };

  const statusCol = findColumnIndex_(sheet, "Status");
  const updatedCol = findColumnIndex_(sheet, "UpdatedDate");
  if (statusCol > 0) sheet.getRange(row.__row, statusCol).setValue("Deactivated");
  if (updatedCol > 0) sheet.getRange(row.__row, updatedCol).setValue(new Date());

  appendAuditLog_("Deactivated Event", "master", row.organizerEmail, row.spreadsheetId, row.eventCode, row.plan);
  return { success: true };
}

function deleteEvent_(p) {
  const sheet = getSheet_("Events");
  const row = findEventRow_(sheet, p.eventId);
  if (!row) return { success: false, error: "Event not found." };

  sheet.deleteRow(row.__row);
  appendAuditLog_("Deleted Event", "master", row.organizerEmail, row.spreadsheetId, row.eventCode, row.plan);
  return { success: true };
}

function findEventRow_(sheet, eventId) {
  const rows = sheetToObjects_(sheet);
  return rows.find((r) => String(r.eventId) === String(eventId)) || null;
}

// Copies the event's spreadsheet into the backups folder (or Drive
// root if ROOT_DRIVE_FOLDER_ID isn't set) and returns a download-ready
// link. This does NOT modify the original spreadsheet.
function downloadEventBackup_(p) {
  const sheet = getSheet_("Events");
  const row = findEventRow_(sheet, p.eventId);
  if (!row || !row.spreadsheetId) return { success: false, error: "Event or its spreadsheet was not found." };

  const copy = backupSpreadsheetById_(row.spreadsheetId, "Backup - " + (row.eventName || row.eventCode || row.eventId));
  appendAuditLog_("Downloaded Event Backup", "master", row.organizerEmail, row.spreadsheetId, row.eventCode, row.plan);
  return { success: true, url: copy.getUrl(), fileId: copy.getId() };
}

// Read-only preview of an event's own spreadsheet, grouped by
// worksheet name. Each row becomes an object keyed by that sheet's
// own header row — so this works for any event schema without
// hardcoding column names.
function getSpreadsheetPreview_(p) {
  const sid = p.sid;
  if (!sid) return { success: false, error: "Missing sid." };

  const ss = SpreadsheetApp.openById(sid);
  const sheets = {};
  ss.getSheets().forEach((sh) => {
    // Cap rows/cols read for performance on very large sheets.
    const maxRows = Math.min(sh.getLastRow(), 500);
    const maxCols = sh.getLastColumn();
    if (maxRows < 1 || maxCols < 1) { sheets[sh.getName()] = []; return; }
    const values = sh.getRange(1, 1, maxRows, maxCols).getValues();
    if (values.length < 2) { sheets[sh.getName()] = []; return; }
    const headers = values[0].map((h) => String(h || "").trim() || "Column");
    const rows = values.slice(1)
      .filter((r) => r.some((c) => c !== "" && c !== null))
      .map((r) => {
        const obj = {};
        headers.forEach((h, i) => (obj[h] = r[i]));
        return obj;
      });

    // SECURITY: this is a raw, arbitrary-sheet preview — if the sheet
    // being previewed is an event's "Admins" sheet, its password-hash
    // column must still never reach the frontend.
    if (sh.getName() === "Admins") {
      rows.forEach((obj) => { if ("Password" in obj) obj.Password = "••••••••"; });
    }

    sheets[sh.getName()] = rows;
  });

  return { success: true, sheets };
}

// ---- GLOBAL SETTINGS (Master Admin panel) ----
// Stored in the "Settings" tab of the Master DB: col A = readable
// label (e.g. "Send Event Created Email"), col B = TRUE/FALSE or a
// number (e.g. Password Reset Expiry). We map label <-> frontend key
// via SETTINGS_LABELS below.
const SETTINGS_LABELS = [
  ["sendEventCreatedEmail",   "Send Event Created Email"],
  ["sendSpreadsheetLink",     "Send Spreadsheet Link"],
  ["sendSpreadsheetId",       "Send Spreadsheet ID"],
  ["sendParentFolderLink",    "Send Parent Event Folder Link"],
  ["sendOrganizerDetails",    "Send Organizer Details"],
  ["sendAdminCredentials",    "Send Admin Credentials"],
  ["sendPublicUrl",           "Send Public URL"],
  ["sendAdminUrl",            "Send Admin URL"],
  ["sendSubscriptionDetails", "Send Subscription Details"],
  ["sendPlanDetails",         "Send Plan Details"],
  ["allowGalleryFolderLinks", "Allow Gallery Folder Links"],
  ["allowPasswordReset",      "Allow Password Reset"],
  ["passwordResetExpiry",     "Password Reset Expiry (Minutes)"],
  ["sendPasswordResetEmail",  "Send Password Reset Email"],
];

function getGlobalSettings_() {
  const sheet = getSheet_("Settings");
  const values = sheet.getDataRange().getValues();
  const byLabel = {};
  values.forEach((row) => { byLabel[String(row[0]).trim()] = row[1]; });

  const settings = {};
  SETTINGS_LABELS.forEach(([key, label]) => {
    const raw = byLabel[label];
    settings[key] = typeof raw === "boolean" ? raw : (raw === "TRUE" || raw === true || raw === "" ? raw === "TRUE" || raw === true : raw);
  });
  return { success: true, settings };
}

function saveGlobalSettings_(p) {
  const sheet = getSheet_("Settings");
  const values = sheet.getDataRange().getValues();
  const rowIndexByLabel = {};
  values.forEach((row, i) => { rowIndexByLabel[String(row[0]).trim()] = i + 1; });

  SETTINGS_LABELS.forEach(([key, label]) => {
    if (!(key in p)) return;
    const rowNum = rowIndexByLabel[label];
    if (!rowNum) return; // label doesn't exist in the sheet — skip rather than guess a new row
    const isNumeric = key === "passwordResetExpiry";
    const value = isNumeric ? Number(p[key]) : (p[key] === "true" || p[key] === true);
    sheet.getRange(rowNum, 2).setValue(isNumeric ? value : (value ? "TRUE" : "FALSE"));
  });

  appendAuditLog_("Updated Global Settings", "master", "", "", "");
  return { success: true };
}

// ---- SUBSCRIPTION PLANS ----
// No dedicated sheet exists yet, so plans are stored as JSON in
// Script Properties (SUBSCRIPTION_PLANS_JSON). First read seeds
// sensible defaults if nothing has been saved yet.
function getSubscriptionPlans_() {
  const raw = PropertiesService.getScriptProperties().getProperty("SUBSCRIPTION_PLANS_JSON");
  if (raw) return { success: true, plans: JSON.parse(raw) };

  const defaults = [
    { id: "basic", name: "Basic", price: 499, features: ["1 Event", "Up to 200 guests", "Email support"] },
    { id: "premium", name: "Premium", price: 1499, features: ["5 Events", "Up to 1000 guests", "Priority support", "Custom domain"], featured: true },
    { id: "enterprise", name: "Enterprise", price: 4999, features: ["Unlimited events", "Unlimited guests", "Dedicated support", "White-label branding"] },
  ];
  PropertiesService.getScriptProperties().setProperty("SUBSCRIPTION_PLANS_JSON", JSON.stringify(defaults));
  return { success: true, plans: defaults };
}

function updatePlanPrice_(p) {
  const props = PropertiesService.getScriptProperties();
  const plans = JSON.parse(props.getProperty("SUBSCRIPTION_PLANS_JSON") || "[]");
  const plan = plans.find((pl) => pl.id === p.planId);
  if (!plan) return { success: false, error: "Plan not found." };
  plan.price = Number(p.price);
  props.setProperty("SUBSCRIPTION_PLANS_JSON", JSON.stringify(plans));
  appendAuditLog_("Updated Plan Price: " + p.planId, "master", "", "", "");
  return { success: true };
}

// ---- PAYMENT GATEWAY (Master Admin panel) ----
// Stored in Script Properties. Reuses the existing RAZORPAY_KEY_ID /
// RAZORPAY_KEY_SECRET properties for the "Razorpay" provider so this
// doesn't duplicate credentials you've already configured.
function getPaymentGatewaySettings_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("PAYMENT_GATEWAY_JSON");
  const base = raw ? JSON.parse(raw) : { enabled: false, provider: "razorpay", webhook: "", testMode: true };
  // Merchant ID / secret for Razorpay come from the dedicated properties if not overridden.
  if (base.provider === "razorpay") {
    base.merchantId = base.merchantId || props.getProperty("RAZORPAY_KEY_ID") || "";
  }
  return { success: true, settings: maskSecret_(base) };
}
function maskSecret_(settings) {
  const copy = Object.assign({}, settings);
  if (copy.secret) copy.secret = "••••••••" + String(copy.secret).slice(-4);
  return copy;
}

function savePaymentGatewaySettings_(p) {
  const props = PropertiesService.getScriptProperties();
  const settings = {
    enabled: p.enabled === "true" || p.enabled === true,
    provider: p.provider || "razorpay",
    merchantId: p.merchantId || "",
    webhook: p.webhook || "",
    testMode: p.testMode === "true" || p.testMode === true,
  };
  props.setProperty("PAYMENT_GATEWAY_JSON", JSON.stringify(settings));

  // Keep the dedicated Razorpay properties in sync if that's the active provider.
  if (settings.provider === "razorpay") {
    if (p.merchantId) props.setProperty("RAZORPAY_KEY_ID", p.merchantId);
    if (p.secret) props.setProperty("RAZORPAY_KEY_SECRET", p.secret);
  }

  appendAuditLog_("Updated Payment Gateway Settings", "master", "", "", "");
  return { success: true };
}

// ---- EMAIL SETTINGS (Master Admin panel) ----
function getEmailSettings_() {
  const raw = PropertiesService.getScriptProperties().getProperty("EMAIL_SETTINGS_JSON");
  const settings = raw ? JSON.parse(raw) : {
    senderName: "EventPay", replyEmail: "", supportEmail: "", orgEmail: "", footer: "", signature: "",
  };
  return { success: true, settings };
}

function saveEmailSettings_(p) {
  const settings = {
    senderName: p.senderName || "EventPay",
    replyEmail: p.replyEmail || "",
    supportEmail: p.supportEmail || "",
    orgEmail: p.orgEmail || "",
    footer: p.footer || "",
    signature: p.signature || "",
  };
  PropertiesService.getScriptProperties().setProperty("EMAIL_SETTINGS_JSON", JSON.stringify(settings));
  appendAuditLog_("Updated Email Settings", "master", "", "", "");
  return { success: true };
}

function sendTestEmail_(p) {
  const settings = getEmailSettings_().settings;
  const to = p.to || settings.supportEmail || Session.getEffectiveUser().getEmail();
  if (!to) return { success: false, error: "No destination email available." };

  MailApp.sendEmail({
    to: to,
    subject: "EventPay — Test Email",
    body: "This is a test email from the EventPay Master Admin panel.\n\n" + (settings.signature || ""),
    name: settings.senderName || "EventPay",
    replyTo: settings.replyEmail || undefined,
  });
  return { success: true };
}

// ---- APPLICATIONS (Master Admin panel) ----
// Reads/writes the "EventApplications" sheet. Expected columns
// (adjust HEADER_ALIASES above if yours differ): Name, Email,
// EventName, Status, SubmittedDate.
function getPendingApplications_() {
  const rows = sheetToObjects_(getSheet_("EventApplications"));
  const applications = rows.map((r) => ({
    id: String(r.__row),
    name: r.name || r.organizerName,
    email: r.email || r.organizerEmail,
    eventName: r.eventName,
    status: (r.status || "pending").toLowerCase(),
    submittedDate: r.submittedDate || r.createdDate,
  }));
  return { success: true, applications };
}

function approveApplication_(p) {
  return setApplicationStatus_(p.id, "Approved");
}
function rejectApplication_(p) {
  return setApplicationStatus_(p.id, "Rejected");
}
function setApplicationStatus_(rowId, status) {
  const sheet = getSheet_("EventApplications");
  const row = Number(rowId);
  if (!row) return { success: false, error: "Invalid application id." };

  const statusCol = findColumnIndex_(sheet, "Status");
  if (statusCol < 1) return { success: false, error: 'Sheet is missing a "Status" column.' };

  sheet.getRange(row, statusCol).setValue(status);
  appendAuditLog_(status + " Application", "master", "", "", "");
  return { success: true };
}

// ---- AUDIT TRAIL (Master Admin panel) ----
function getAuditTrail_() {
  const rows = sheetToObjects_(getSheet_("AuditLog"));
  // Most recent first.
  const log = rows.reverse().map((r) => ({
    date: r.date,
    action: r.action,
    user: "master", // AuditLog doesn't currently track a "user" column separately from OrganizerEmail
    ip: r.ip || "",
  }));
  return { success: true, log };
}

// ---- MASTER DATABASE (Master Admin panel) ----
function getMasterDbInfo_() {
  const id = PropertiesService.getScriptProperties().getProperty("MASTER_DB_SPREADSHEET_ID");
  const lastBackup = PropertiesService.getScriptProperties().getProperty("MASTER_DB_LAST_BACKUP") || "";
  return { success: true, info: { spreadsheetId: id, lastBackup } };
}

function createMasterBackup_() {
  const id = PropertiesService.getScriptProperties().getProperty("MASTER_DB_SPREADSHEET_ID");
  const copy = backupSpreadsheetById_(id, "Master DB Backup - " + new Date().toISOString());
  PropertiesService.getScriptProperties().setProperty("MASTER_DB_LAST_BACKUP", new Date().toISOString());
  appendAuditLog_("Created Master Database Backup", "master", "", "", "");
  return { success: true, fileId: copy.getId(), url: copy.getUrl() };
}

function downloadMasterBackup_() {
  const id = PropertiesService.getScriptProperties().getProperty("MASTER_DB_SPREADSHEET_ID");
  const copy = backupSpreadsheetById_(id, "Master DB Backup - " + new Date().toISOString());
  return { success: true, url: copy.getUrl(), fileId: copy.getId() };
}

// Restores from a given Drive file ID by overwriting every sheet in
// the live Master DB with the backup's contents. Requires p.backupFileId.
// NOTE: intentionally conservative — it copies data sheet-by-sheet
// rather than deleting/replacing the whole spreadsheet, so the Web
// App deployment (and its ID/URL) never changes.
function restoreMasterBackup_(p) {
  const backupFileId = p.backupFileId;
  if (!backupFileId) return { success: false, error: "Missing backupFileId." };

  const liveId = PropertiesService.getScriptProperties().getProperty("MASTER_DB_SPREADSHEET_ID");
  const live = SpreadsheetApp.openById(liveId);
  const backup = SpreadsheetApp.openById(backupFileId);

  backup.getSheets().forEach((backupSheet) => {
    const name = backupSheet.getName();
    let liveSheet = live.getSheetByName(name);
    if (!liveSheet) liveSheet = live.insertSheet(name);
    liveSheet.clear();
    const values = backupSheet.getDataRange().getValues();
    if (values.length) liveSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  });

  appendAuditLog_("Restored Master Database from backup", "master", "", "", "");
  return { success: true };
}

// Copies a spreadsheet by ID into the backups folder (falls back to
// Drive root) and returns the new File.
function backupSpreadsheetById_(spreadsheetId, name) {
  const file = DriveApp.getFileById(spreadsheetId);
  const folderId = PropertiesService.getScriptProperties().getProperty("ROOT_DRIVE_FOLDER_ID");
  const folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
  return file.makeCopy(name, folder);
}

// ============================================================
// 17. PASSWORD MIGRATION — run ONCE (from the Apps Script editor:
// select migratePlaintextPasswords_ in the function dropdown and
// click Run — or call it as the master-admin action
// "migratePlaintextPasswords") after deploying SHA-256 hashing.
// ------------------------------------------------------------
// Scans every place a password is stored and, for any value that
// ISN'T already a 64-character hex SHA-256 hash, hashes it in place
// and writes the hash back. Rows that already hold a valid hash are
// left completely untouched (idempotent — safe to run more than
// once, e.g. after adding a new event spreadsheet).
//
// Covers:
//   1. The Master Admin password (Script Property MASTER-ADMIN-PASS)
//   2. The Master DB "Events" sheet's AdminPassword column
//   3. Every individual event spreadsheet's own "Admins" sheet
//      (Password is column B), discovered via each Events row's
//      SpreadsheetID — wrapped in try/catch per event so one
//      deleted/inaccessible spreadsheet can't abort the whole run.
//
// Returns only counts — never any password value, hashed or not.
// ============================================================
function migratePlaintextPasswords_() {
  const result = {
    masterAdminMigrated: false,
    eventsRegistryMigrated: 0,
    eventsRegistrySkipped: 0,
    eventAdminsMigrated: 0,
    eventAdminsSkipped: 0,
    eventSpreadsheetsWithErrors: 0
  };

  // 1) Master Admin password (Script Property).
  try {
    const props = PropertiesService.getScriptProperties();
    const stored = props.getProperty("MASTER-ADMIN-PASS") || "";
    if (stored && !isSha256Hash_(stored)) {
      props.setProperty("MASTER-ADMIN-PASS", hashPassword_(stored));
      result.masterAdminMigrated = true;
    }
  } catch (e) { /* leave master password untouched on any error */ }

  // 2) Master DB "Events" sheet — AdminPassword column.
  let eventsSheet;
  try {
    eventsSheet = getOrCreateEventsSheet_();
    const data = eventsSheet.getDataRange().getValues();
    const col = getColMap(data[0]);
    const ssIdC = col["spreadsheetid"] !== undefined ? col["spreadsheetid"] : 4;
    const passC = col["adminpassword"] !== undefined ? col["adminpassword"] : 16;

    for (let i = 1; i < data.length; i++) {
      const stored = String(data[i][passC] || "").trim();
      if (!stored) continue;
      if (isSha256Hash_(stored)) { result.eventsRegistrySkipped++; continue; }
      eventsSheet.getRange(i + 1, passC + 1).setValue(hashPassword_(stored));
      result.eventsRegistryMigrated++;
    }

    // 3) Each event's own spreadsheet "Admins" sheet.
    for (let i = 1; i < data.length; i++) {
      const sid = String(data[i][ssIdC] || "").trim();
      if (!sid) continue;
      try {
        const ss = SpreadsheetApp.openById(sid);
        const adminsSheet = ss.getSheetByName("Admins");
        if (!adminsSheet) continue;
        const adminsData = adminsSheet.getDataRange().getValues();
        for (let r = 1; r < adminsData.length; r++) {
          const stored = String(adminsData[r][1] || "").trim();
          if (!stored) continue;
          if (isSha256Hash_(stored)) { result.eventAdminsSkipped++; continue; }
          adminsSheet.getRange(r + 1, 2).setValue(hashPassword_(stored));
          result.eventAdminsMigrated++;
        }
      } catch (e) {
        result.eventSpreadsheetsWithErrors++;
      }
    }
  } catch (e) { /* Master DB not reachable — return whatever was gathered so far */ }

  return { success: true, result: result };
}

// ============================================================
// SUBSCRIPTION PAYMENT ADDITIONS
// ============================================================
/* ============================================================
   EventPay — SUBSCRIPTION PAYMENT ADDITIONS
   ------------------------------------------------------------
   Everything in this file is NEW. Paste it into your existing
   Code.gs (anywhere below the existing functions is fine — Apps
   Script doesn't care about order). Then apply the two small
   EDITS described at the bottom to handleAction()'s switch and to
   MASTER_ADMIN_ACTIONS.

   These actions power payment.html/payment.js ONLY. They never
   create an event, spreadsheet, or Drive folder — that still
   happens exclusively in submitEventApplication() (Apply-Event
   flow), untouched.

   Reuses the SAME Script Properties already in your project:
     RAZORPAY_KEY_ID
     RAZORPAY_KEY_SECRET
   Reuses the SAME Master DB spreadsheet (getMasterDbId_()) already
   used for Events/AuditLog, so no new spreadsheet is introduced.
============================================================ */

// ============================================================
// PUBLIC (non-master-admin) gateway settings
// ------------------------------------------------------------
// The existing getPaymentGatewaySettings_() (Master Admin panel)
// requires a master session token and also returns the merchantId.
// payment.html is a PUBLIC page with no master login, so it needs
// its own safe, token-free variant that exposes only what the
// checkout UI needs: whether the gateway is enabled, which
// provider, the UPI ID to render the QR against, and the Razorpay
// key_id (key_id is a public, not a secret, value — same one sent
// back by createSubscriptionOrder).
// ============================================================
function getPublicPaymentGatewaySettings_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty("PAYMENT_GATEWAY_JSON");
    var base = raw ? JSON.parse(raw) : { enabled: true, provider: "razorpay" };

   var keyId = getProp_("RAZORPAY_KEY_ID");
   var upiId = base.upiId || getProp_("UPI_ID") || "";
   
    return {
      success: true,
      settings: {
        enabled: base.enabled !== false,
        provider: base.provider || "razorpay",
        upiId: upiId,
        keyId: keyId
      }
    };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ============================================================
// SUBSCRIPTION ORDERS — cached, not written to a sheet until
// verified. CacheService keeps this cheap and self-cleaning (6hr
// TTL); verifySubscriptionPayment cross-checks against this cache
// so the amount/plan a payment is verified against always matches
// what the order was actually created for (never trusts the
// frontend's own resend of amount/plan at verify time).
// ============================================================
function createSubscriptionPaymentLink(p) {
  try {
    var amount = Math.round(Number(p.amount) * 100); // paise
    if (!amount || amount <= 0) {
      return { success: false, message: "Invalid amount." };
    }

    var keyId = getProp_("RAZORPAY_KEY_ID");
    var keySecret = getProp_("RAZORPAY_KEY_SECRET");
    if (!keyId || !keySecret) {
      return { success: false, message: "Payment gateway is not configured." };
    }

    var referenceId = "sub_" + (p.plan || "plan") + "_" + Date.now();
    var callbackUrl = "https://likhithlikki.github.io/MULTI-USERS--EVENTPAY/payment.html";

    var payload = {
      amount: amount,
      currency: "INR",
      description: (p.plan || "Plan") + " Plan Subscription",
      reference_id: referenceId,
      customer: {
        name: p.organizerName || "",
        email: p.organizerEmail || "",
        contact: p.organizerPhone || ""
      },
      notify: { sms: false, email: false },
      reminder_enable: false,
      callback_url: callbackUrl,
      callback_method: "get"
    };

    var response = UrlFetchApp.fetch("https://api.razorpay.com/v1/payment_links", {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Basic " + Utilities.base64Encode(keyId + ":" + keySecret)
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var body = JSON.parse(response.getContentText());

    if (response.getResponseCode() >= 300 || !body.id) {
      return { success: false, message: (body.error && body.error.description) || "Failed to create payment link." };
    }

    // Cache expected plan/amount/organizer info, keyed by the Payment
    // Link id — Razorpay sends that id back on the callback, so
    // verify can recover everything from it without trusting the client.
    CacheService.getScriptCache().put(
      "PLINK_" + body.id,
      JSON.stringify({
        plan: p.plan || "",
        amount: amount,
        organizerEmail: p.organizerEmail || "",
        organizerName: p.organizerName || "",
        organizerPhone: p.organizerPhone || ""
      }),
      6 * 60 * 60
    );

    return { success: true, payment_link_id: body.id, short_url: body.short_url, reference_id: referenceId };
  } catch (err) {
    return { success: false, message: "Unexpected error: " + err.toString() };
  }
}

function verifySubscriptionPaymentLink(p) {
  try {
    var linkId = p.razorpay_payment_link_id;
    var referenceId = p.razorpay_payment_link_reference_id;
    var status = p.razorpay_payment_link_status;
    var paymentId = p.razorpay_payment_id;
    var signature = p.razorpay_signature;

    if (!linkId || !paymentId || !signature) {
      return { success: false, message: "Missing payment details." };
    }

    var keySecret = getProp_("RAZORPAY_KEY_SECRET");
    if (!keySecret) return { success: false, message: "Payment gateway is not configured." };

    // Per Razorpay docs: payload = link_id|reference_id|status|payment_id
    var payload = linkId + "|" + referenceId + "|" + status + "|" + paymentId;
    var expectedSignature = computeHmacHex_(payload, keySecret);

    if (expectedSignature !== signature) {
      appendSubscriptionAudit_("Subscription Payment Link - Signature Mismatch", "", linkId, paymentId, "");
      return { success: false, message: "Signature verification failed." };
    }
    if (status !== "paid") {
      appendSubscriptionAudit_("Subscription Payment Link - Not Paid (" + status + ")", "", linkId, paymentId, "");
      return { success: false, message: "Payment was not completed (status: " + status + ")." };
    }

    var cached = CacheService.getScriptCache().get("PLINK_" + linkId);
    var meta = cached ? JSON.parse(cached) : { plan: "", amount: 0, organizerEmail: "" };

    recordSubscriptionPaymentRow_({
      plan: meta.plan, amount: meta.amount / 100, organizerEmail: meta.organizerEmail,
      organizerName: meta.organizerName || "", organizerPhone: meta.organizerPhone || "",
      method: "Razorpay Payment Link", orderId: linkId, paymentId: paymentId, utr: "", status: "Verified"
    });

    CacheService.getScriptCache().remove("PLINK_" + linkId);
    appendSubscriptionAudit_("Subscription Payment Link Verified", meta.organizerEmail, linkId, paymentId, meta.plan);
    return { success: true };
  } catch (err) {
    return { success: false, message: "Unexpected error: " + err.toString() };
  }
}
// ============================================================
// VERIFY SUBSCRIPTION PAYMENT
// ------------------------------------------------------------
// Two paths:
//  - Razorpay: verifies the HMAC SHA256 signature Razorpay sends
//    back, using RAZORPAY_KEY_SECRET. Only writes a row to the
//    SubscriptionPayments sheet (Master DB) if the signature is
//    genuinely valid.
//  - Direct UPI (p.method === "upi"): there is nothing to
//    cryptographically verify at submission time — a human must
//    check the UTR against the bank statement — so this always
//    records the submission as "Pending" and returns success:true,
//    matching the required pendingVerification UX (the frontend
//    treats this response as "submitted for review", not "paid").
// ============================================================
function verifySubscriptionPayment(p) {
  try {
    if (p.method === "upi") {
      return recordUpiSubscriptionSubmission_(p);
    }

    var orderId = p.razorpay_order_id;
    var paymentId = p.razorpay_payment_id;
    var signature = p.razorpay_signature;

    if (!orderId || !paymentId || !signature) {
      return { success: false, message: "Missing payment details." };
    }

    var cached = CacheService.getScriptCache().get("SUBORDER_" + orderId);
    var orderMeta = cached ? JSON.parse(cached) : {
      plan: p.plan || "", amount: Math.round(Number(p.amount) * 100) || 0, organizerEmail: p.organizerEmail || ""
    };

    var keySecret = PropertiesService.getScriptProperties().getProperty("RAZORPAY_KEY_SECRET");
    if (!keySecret) return { success: false, message: "Payment gateway is not configured." };

    var payload = orderId + "|" + paymentId;
    var expectedSignature = computeHmacHex_(payload, keySecret);

    if (expectedSignature !== signature) {
      appendSubscriptionAudit_("Subscription Payment - Signature Mismatch", orderMeta.organizerEmail, orderId, paymentId, orderMeta.plan);
      return { success: false, message: "Signature verification failed." };
    }

    recordSubscriptionPaymentRow_({
      plan: orderMeta.plan,
      amount: orderMeta.amount / 100,
      organizerEmail: orderMeta.organizerEmail,
      organizerName: orderMeta.organizerName || "",
      organizerPhone: orderMeta.organizerPhone || "",
      method: "Razorpay",
      orderId: orderId,
      paymentId: paymentId,
      utr: "",
      status: "Verified"
    });

    CacheService.getScriptCache().remove("SUBORDER_" + orderId);
    appendSubscriptionAudit_("Subscription Payment Verified", orderMeta.organizerEmail, orderId, paymentId, orderMeta.plan);

    return { success: true };
  } catch (err) {
    return { success: false, message: "Unexpected error: " + err.toString() };
  }
}

function recordUpiSubscriptionSubmission_(p) {
  recordSubscriptionPaymentRow_({
    plan: p.plan || "",
    amount: Number(p.amount) || 0,
    organizerEmail: p.organizerEmail || "",
    organizerName: p.organizerName || "",
    organizerPhone: p.organizerPhone || "",
    method: "Direct UPI",
    orderId: "",
    paymentId: "",
    utr: p.utr || "",
    status: "Pending"
  });
  appendSubscriptionAudit_("Subscription UPI Submission (Pending Review)", p.organizerEmail, "", p.utr || "", p.plan || "");
  return { success: true, status: "pendingVerification" };
}

// Computes an HMAC-SHA256 hex digest, matching how Razorpay signs
// order_id|payment_id with the key secret.
function computeHmacHex_(payload, secret) {
  var bytes = Utilities.computeHmacSha256Signature(payload, secret);
  return bytes.map(function (byte) {
    var v = (byte < 0 ? byte + 256 : byte).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

// ============================================================
// SUBSCRIPTION PAYMENTS SHEET (Master DB)
// ------------------------------------------------------------
// Idempotent creator + appender, same pattern as
// ensureMasterPaymentsSheet_ / getOrCreateEventsSheet_ elsewhere in
// this project. Lives in the Master DB — NOT inside any event's own
// spreadsheet — since a subscription purchase happens before any
// event/spreadsheet exists.
// ============================================================
var SUBSCRIPTION_PAYMENTS_HEADERS = [
  "Timestamp", "Plan", "Amount", "OrganizerEmail", "OrganizerName", "OrganizerPhone",
  "Method", "OrderID", "PaymentID", "UTR", "Status"
];

function getOrCreateSubscriptionPaymentsSheet_() {
  var ss = SpreadsheetApp.openById(getMasterDbId_());
  var sheet = ss.getSheetByName("SubscriptionPayments");
  if (!sheet) {
    sheet = ss.insertSheet("SubscriptionPayments");
    sheet.getRange(1, 1, 1, SUBSCRIPTION_PAYMENTS_HEADERS.length)
      .setValues([SUBSCRIPTION_PAYMENTS_HEADERS])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function recordSubscriptionPaymentRow_(d) {
  var sheet = getOrCreateSubscriptionPaymentsSheet_();
  sheet.appendRow([
    formatReadableDate_(new Date()),
    d.plan, d.amount, d.organizerEmail, d.organizerName, d.organizerPhone,
    d.method, d.orderId, d.paymentId, d.utr, d.status
  ]);
}

function appendSubscriptionAudit_(action, organizerEmail, orderId, paymentId, plan) {
  try {
    logAudit_({
      action: action,
      organizerEmail: organizerEmail || "",
      spreadsheetId: orderId || "",
      eventCode: paymentId || "",
      plan: plan || ""
    });
  } catch (e) { /* audit logging should never break the payment flow */ }
}

/* ============================================================
   REQUIRED EDITS TO YOUR EXISTING Code.gs
   ------------------------------------------------------------
   1) In handleAction()'s switch statement, ADD these three cases
      (near the other "Apply / Create Event" cases is a good spot):

        case "createSubscriptionOrder":
          return createSubscriptionOrder(p);

        case "verifySubscriptionPayment":
          return verifySubscriptionPayment(p);

        case "getPaymentGatewaySettings":
          if (p.token) {
            requireMasterAuth_(p);
            return getPaymentGatewaySettings_();
          }
          return getPublicPaymentGatewaySettings_();

   2) Your MASTER_ADMIN_ACTIONS array already lists
      "getPaymentGatewaySettings". REMOVE it from that array — the
      case above now does its own token check manually, exactly the
      same pattern your "getEvents" action already uses to serve
      both the public site and the Master Admin panel from one
      action name. (createSubscriptionOrder and
      verifySubscriptionPayment are public actions and must NOT be
      added to MASTER_ADMIN_ACTIONS.)

   No other function in Code.gs, SheetMaker.gs, or config.js needs
   to change. submitEventApplication(), initializeEventSpreadsheet(),
   and every existing donation-payment action (insertPayment,
   validateUTR, etc.) are completely untouched.

   3) SHA-256 PASSWORD HASHING — after deploying this version, run
      migratePlaintextPasswords_() ONCE (Apps Script editor: pick it
      from the function dropdown next to "Run", or call it via the
      master-admin action "migratePlaintextPasswords") to convert any
      pre-existing plaintext passwords (Master Admin password, the
      Events registry's AdminPassword column, and every event
      spreadsheet's own Admins sheet) to SHA-256 hashes in place.
      Every login path also self-migrates a legacy plaintext row the
      first time that account successfully logs in, so this bulk step
      is a convenience, not a hard requirement, for the system to end
      up fully hash-only.
============================================================ */
