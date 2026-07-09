// ============================================================
// EventPay — Code.gs  (SINGLE unified backend, single router)
// ============================================================
// This is the ONLY .gs file in this project that defines
// doGet / doPost / handleAction. Do NOT add a second copy of any
// of these anywhere else in the project — that is what caused
// "Identifier already declared" errors and "Failed to fetch"
// before (a second Code.gs-style file existed with the same
// function names, which breaks the entire project at parse time).
//
// Sheets used:
//   MASTER DB spreadsheet: "Events" (registry), "AuditLog"
//   Per-event spreadsheet: Payments | Complaints | Gallery |
//                           Settings | AuditLog | Admins | Villages
// ============================================================

// ============================================================
// 0. SCRIPT PROPERTIES  (Project Settings → Script Properties)
// Required:  MASTER_DB_SPREADSHEET_ID  (or MASTER_DB_ID)
// Optional:  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET  (default/fallback
//            keys used only if an event hasn't set its own in its
//            Settings sheet)
// ============================================================

function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? String(v).trim() : "";
}

function getMasterDbId() {
  const id = getProp_("MASTER_DB_SPREADSHEET_ID") || getProp_("MASTER_DB_ID");
  if (!id) {
    throw new Error(
      "MASTER_DB_SPREADSHEET_ID is not set in Script Properties. " +
      "Go to Apps Script → Project Settings → Script Properties and add it " +
      "(or MASTER_DB_ID — either name works)."
    );
  }
  return id;
}

// Fixed parent Drive folder — every event's folder is created INSIDE
// this one. Never create anything in My Drive root.
function getRootDriveFolderId() {
  const id = PropertiesService.getScriptProperties().getProperty("ROOT_DRIVE_FOLDER_ID");

  if (!id) {
    throw new Error(
      "ROOT_DRIVE_FOLDER_ID is not set in Script Properties."
    );
  }

  return id.trim();
}

const PUBLIC_BASE_URL = "https://likhithlikki.github.io/MULTI-USERS--EVENTPAY/home.html";
const ADMIN_BASE_URL  = "https://likhithlikki.github.io/MULTI-USERS--EVENTPAY/admin-login.html";

// ============================================================
// 1. HTTP ENTRYPOINTS & ROUTER  (the ONLY doGet/doPost in the project)
// ============================================================

function doGet(e) {
  return out(handleAction(e.parameter.action, e.parameter, null));
}

function doPost(e) {
  const params = e.parameter;
  if (e.postData && e.postData.type === "application/x-www-form-urlencoded") {
    e.postData.contents.split("&").forEach(pair => {
      const kv = pair.split("=");
      params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
    });
  }
  return out(handleAction(params.action, params, e.postData));
}

function out(r) {
  return ContentService.createTextOutput(JSON.stringify(r))
                       .setMimeType(ContentService.MimeType.JSON);
}

function handleAction(action, p, pd) {
  try {
    switch (action) {
      // ---- Public / Visitor ----
      case "getEvents":
    return apiGetEvents();
      case "searchEvent":         return searchEvent(p);
      case "getSettings":         return apiGetSettings(p);
      case "getPublicVisibility": return apiGetPublicVisibility(p);
      case "getPublicStats":      return apiGetPublicStats(p);
      case "getPublicPayments":   return apiGetPublicPayments(p);
      case "checkStatus":         return apiCheckStatus(p);
      case "createPaymentOrder":  return apiCreatePaymentOrder(p);
      case "verifyPayment":       return apiVerifyPayment(p);
      case "getGalleryImages":    return apiGetGalleryImages(p);
      case "uploadPhoto":         return apiUploadPhoto(p);
      case "submitComplaint":     return apiSubmitComplaint(p);
      case "getComplaintStatus":  return apiGetComplaintStatus(p);

      // ---- Admin ----
      case "loginAdmin":       return apiLoginAdmin(p);
      case "adminLogout":      return apiAdminLogout(p);
      case "getPayments":      return apiGetPayments(p);
      case "updatePayments":   return apiUpdatePayments(p);
      case "getComplaints":    return apiGetComplaints(p);
      case "updateComplaint":  return apiUpdateComplaint(p);
      case "getPendingPhotos": return apiGetPendingPhotos(p);
      case "moderatePhoto":    return apiModeratePhoto(p);
      case "deletePhoto":      return apiDeletePhoto(p);

      // ---- Super Admin ----
      case "updateSettings":         return apiUpdateSettings(p);
      case "getAuditLog":            return apiGetAuditLog(p);
      case "createEventSpreadsheet": return apiCreateEventSpreadsheet(p); // manual/legacy re-init

      // ---- Apply / Create Event (merged — same router, no 2nd doGet/doPost) ----
      case "sendOrganizerOtp":       return apiSendOrganizerOtp(p);
      case "verifyOrganizerOtp":     return apiVerifyOrganizerOtp(p);
      case "checkDuplicateEvent":    return apiCheckDuplicateEvent(p);
      case "submitEventApplication": return apiSubmitEventApplication(p);

      default:
        return jsonError("Unknown backend action: " + action);
    }
  } catch (err) {
    return jsonError("Internal Server Error: " + err.message);
  }
}

// ============================================================
// 2. CORE UTILITY HELPERS
// ============================================================

function jsonSuccess(data) { return { success: true, data: data }; }
function jsonError(message) { return { success: false, error: message }; }

function serializeVal(val, key) {
  if (val instanceof Date) {
    const tz = Session.getScriptTimeZone();
    const k = String(key || '').toLowerCase().trim();
    if (val.getFullYear() <= 1900) return Utilities.formatDate(val, tz, "hh:mm a");
    if (k === 'date' || k === 'paymentdate' || k === 'createddate' || k === 'updateddate') {
      return Utilities.formatDate(val, tz, "dd-MMM-yyyy");
    }
    if (k === 'time') return Utilities.formatDate(val, tz, "hh:mm a");
    return Utilities.formatDate(val, tz, "dd-MMM-yyyy hh:mm a");
  }
  return val;
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
  if (/^[a-zA-Z0-9_-]{20,}$/.test(link.trim())) return link.trim(); // already a bare ID
  const m = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length, dp = [];
  for (let i = 0; i <= m; i++) { dp[i] = [i]; for (let j = 1; j <= n; j++) dp[i][j] = 0; }
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
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

// ============================================================
// 3. MASTER DATABASE — EVENTS REGISTRY
// ============================================================
// Registry column layout (must match EVENTS_SHEET_HEADERS below):
// EventID(0) EventCode(1) EventType(2) EventName(3) SpreadsheetID(4)
// SpreadsheetLink(5) OrganizerName(6) OrganizerPhone(7) OrganizerEmail(8)
// Plan(9) TrialExpiry(10) Status(11) SettlementStatus(12) CreatedDate(13)
// UpdatedDate(14) AdminUsername(15) AdminPassword(16) PublicURL(17) AdminURL(18)

const EVENTS_SHEET_HEADERS = [
  "EventID","EventCode","EventType","EventName","SpreadsheetID","SpreadsheetLink",
  "OrganizerName","OrganizerPhone","OrganizerEmail","Plan","TrialExpiry","Status",
  "SettlementStatus","CreatedDate","UpdatedDate","AdminUsername","AdminPassword",
  "PublicURL","AdminURL"
];

function getOrCreateEventsSheet_() {
  const ss = SpreadsheetApp.openById(getMasterDbId());
  let sheet = ss.getSheetByName("Events");
  if (!sheet) {
    sheet = ss.insertSheet("Events");
    sheet.getRange(1, 1, 1, EVENTS_SHEET_HEADERS.length).setValues([EVENTS_SHEET_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, EVENTS_SHEET_HEADERS.length).setFontWeight("bold");
  }
  return sheet;
}

function searchEvent(params) {
  try {
    const sheet = getOrCreateEventsSheet_();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const col = getColMap(headers);

    const codeC   = col["eventcode"]   !== undefined ? col["eventcode"]   : 1;
    const nameC   = col["eventname"]   !== undefined ? col["eventname"]   : 3;
    const typeC   = col["eventtype"]   !== undefined ? col["eventtype"]   : 2;
    const statusC = col["status"]      !== undefined ? col["status"]      : 11;

    const searchCode = params.code ? String(params.code).trim().toLowerCase() : null;
    const searchName = params.name ? String(params.name).trim().toLowerCase() : null;

    const matches = [];
    for (let i = 1; i < data.length; i++) {
      const codeVal = String(data[i][codeC]).trim();
      const nameVal = String(data[i][nameC]).trim();
      const typeVal = String(data[i][typeC]).trim();
      const statusVal = String(data[i][statusC]).trim();
      if (statusVal.toLowerCase() !== "active") continue;

      let isMatch = false;
      if (searchCode && codeVal.toLowerCase() === searchCode) isMatch = true;
      else if (searchName && nameVal.toLowerCase().indexOf(searchName) !== -1) isMatch = true;

      if (isMatch) matches.push({ eventCode: codeVal, eventName: nameVal, eventType: typeVal });
    }
    return jsonSuccess({ matches: matches });
  } catch (err) {
    return jsonError(err.message);
  }
}

function resolveSpreadsheetID(eventCode) {
  if (!eventCode) throw new Error("EventCode is required.");
  const sheet = getOrCreateEventsSheet_();
  const data = sheet.getDataRange().getValues();
  const col = getColMap(data[0]);

  const codeC   = col["eventcode"]     !== undefined ? col["eventcode"]     : 1;
  const ssIdC   = col["spreadsheetid"] !== undefined ? col["spreadsheetid"] : 4;
  const statusC = col["status"]        !== undefined ? col["status"]        : 11;

  const cleanCode = eventCode.trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    const codeVal = String(data[i][codeC]).trim().toLowerCase();
    if (codeVal === cleanCode) {
      const statusVal = String(data[i][statusC]).trim().toLowerCase();
      if (statusVal !== "active") throw new Error("This event is inactive.");
      const ssId = String(data[i][ssIdC]).trim();
      if (!ssId) throw new Error("Spreadsheet ID is missing for this event.");
      return ssId;
    }
  }
  throw new Error("Event code not found in registry.");
}

function openEventSpreadsheet(spreadsheetId) {
  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (err) {
    throw new Error("Could not open event database: " + err.message);
  }
}

// ============================================================
// 4. EVENT CONTEXT RESOLVER
// Accepts EITHER params.sid (the event's Spreadsheet ID directly)
// OR params.eventCode / params.code (looked up via the registry).
// This keeps both calling styles working without knowing which
// one every frontend page currently uses.
// ============================================================

function resolveEventContext(params) {
  let spreadsheetId = params.sid;
  const eventCode = params.eventCode || params.code || "";
  if (!spreadsheetId) {
    if (!eventCode) throw new Error("Missing parameter: sid or eventCode.");
    spreadsheetId = resolveSpreadsheetID(eventCode);
  }
  const ss = openEventSpreadsheet(spreadsheetId);
  return { ss: ss, eventCode: eventCode ? eventCode.toUpperCase().trim() : "", spreadsheetId: spreadsheetId };
}

function resolveEventMetadata(params) {
  const context = resolveEventContext(params);

  let eventName = "EventPay", eventType = "General", status = "Active";
  if (context.eventCode) {
    const registrySheet = getOrCreateEventsSheet_();
    const data = registrySheet.getDataRange().getValues();
    const col = getColMap(data[0]);
    const codeC = col["eventcode"] !== undefined ? col["eventcode"] : 1;
    const nameC = col["eventname"] !== undefined ? col["eventname"] : 3;
    const typeC = col["eventtype"] !== undefined ? col["eventtype"] : 2;
    const statusC = col["status"] !== undefined ? col["status"] : 11;
    const cleanCode = context.eventCode.toLowerCase();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][codeC]).trim().toLowerCase() === cleanCode) {
        eventName = String(data[i][nameC]).trim();
        eventType = String(data[i][typeC]).trim();
        status = String(data[i][statusC]).trim();
        break;
      }
    }
  }

  const settingsSheet = context.ss.getSheetByName("Settings");
  const settingsObj = {};
  if (settingsSheet) {
    settingsSheet.getDataRange().getValues().forEach(r => { if (r[0]) settingsObj[String(r[0]).trim()] = r[1]; });
    if (settingsObj["Event Name"] && eventName === "EventPay") eventName = settingsObj["Event Name"];
    if (settingsObj["Event Type"] && eventType === "General") eventType = settingsObj["Event Type"];
  }

  return { eventCode: context.eventCode, eventName: eventName, eventType: eventType, status: status, settings: settingsObj };
}

// ============================================================
// 5. EVENT SETTINGS
// ============================================================

function apiGetSettings(params) {
  try { return jsonSuccess(resolveEventMetadata(params)); }
  catch (err) { return jsonError(err.message); }
}

function apiGetPublicVisibility(params) {
  try {
    const context = resolveEventContext(params);
    const settingsSheet = context.ss.getSheetByName("Settings");
    const s = {};
    if (settingsSheet) settingsSheet.getDataRange().getValues().forEach(r => { if (r[0]) s[String(r[0]).trim()] = r[1]; });

    const isActive = (key) => String(s[key] || "ACTIVE").toUpperCase().trim() === "ACTIVE" ||
                               String(s[key] || "").toLowerCase().trim() === "true" ||
                               String(s[key] || "").trim() === "1";

    return jsonSuccess({
      showDonorList: isActive("SHOW_DONOR_LIST"), showStatistics: isActive("SHOW_STATISTICS"),
      showHomepageStats: isActive("SHOW_HOMEPAGE_STATS"), showHomepageDonors: isActive("SHOW_HOMEPAGE_DONORS"),
      showGallery: isActive("SHOW_GALLERY"), showInviteCard: isActive("SHOW_INVITE_CARD"),
      showPendingPayments: isActive("SHOW_PENDING_PAYMENTS"), showVerifiedPayments: isActive("SHOW_VERIFIED_PAYMENTS"),
      showRecentPayments: isActive("SHOW_RECENT_PAYMENTS"), showEngagementGallery: isActive("SHOW_ENGAGEMENT_GALLERY"),
      showHaldiGallery: isActive("SHOW_HALDI_GALLERY"), showMarriageGallery: isActive("SHOW_MARRIAGE_GALLERY"),
      allowDownloadAll: isActive("ALLOW_DOWNLOAD_ALL"), allowSectionDownload: isActive("ALLOW_SECTION_DOWNLOAD"),
      showComplaints: isActive("SHOW_COMPLAINTS"), showVideos: isActive("SHOW_VIDEOS"), showAnalytics: isActive("SHOW_ANALYTICS")
    });
  } catch (err) { return jsonError(err.message); }
}

function apiUpdateSettings(params) {
  try {
    verifySuperAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Settings");
    if (!sheet) return jsonError("Settings sheet not found.");

    const data = sheet.getDataRange().getValues();
    const updates = JSON.parse(params.updates || '{}');

    Object.keys(updates).forEach(key => {
      let found = false;
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]).trim() === key) {
          const oldVal = data[i][1];
          sheet.getRange(i + 1, 2).setValue(updates[key]);
          logAuditRecord(context.ss, { adminUser: params.adminUser, module: "Settings", action: "Update", field: key, oldValue: String(oldVal), newValue: String(updates[key]), reason: params.reason || "" });
          found = true;
          break;
        }
      }
      if (!found) {
        sheet.appendRow([key, updates[key]]);
        logAuditRecord(context.ss, { adminUser: params.adminUser, module: "Settings", action: "Create", field: key, oldValue: "", newValue: String(updates[key]), reason: params.reason || "Init settings param" });
      }
    });
    return jsonSuccess({ result: "Saved" });
  } catch (err) { return jsonError(err.message); }
}

// ============================================================
// 6. PAYMENTS & RAZORPAY
// ============================================================

function razorpayKeys_(s) {
  // Per-event key (Settings sheet) wins; Script Properties value is
  // only used as the default when an event hasn't configured its own.
  return {
    keyId: s["RAZORPAY_KEY_ID"] || getProp_("RAZORPAY_KEY_ID"),
    keySecret: s["RAZORPAY_KEY_SECRET"] || getProp_("RAZORPAY_KEY_SECRET")
  };
}

function apiCreatePaymentOrder(params) {
  try {
    const context = resolveEventContext(params);
    const settingsSheet = context.ss.getSheetByName("Settings");
    const s = {};
    if (settingsSheet) settingsSheet.getDataRange().getValues().forEach(r => { if (r[0]) s[String(r[0]).trim()] = r[1]; });

    const { keyId, keySecret } = razorpayKeys_(s);
    if (!keyId || !keySecret) return jsonError("Razorpay keys are not configured for this event.");

    const amount = Number(params.amount);
    if (!amount || amount <= 0) return jsonError("Invalid amount.");

    const minAmt = Number(s["MIN_AMOUNT"] || 50);
    const maxAmt = Number(s["MAX_AMOUNT"] || 100000);
    if (amount < minAmt) return jsonError("Amount is below minimum ₹" + minAmt);
    if (amount > maxAmt) return jsonError("Amount exceeds maximum ₹" + maxAmt);

    const url = "https://api.razorpay.com/v1/orders";
    const payload = { amount: amount * 100, currency: "INR", receipt: "receipt_" + Utilities.getUuid().substring(0, 8) };
    const options = {
      method: "post", contentType: "application/json",
      headers: { "Authorization": "Basic " + Utilities.base64Encode(keyId + ":" + keySecret) },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const resText = response.getContentText();
    const resData = JSON.parse(resText);
    if (response.getResponseCode() !== 200) {
      return jsonError("Razorpay order creation failed: " + (resData.error && resData.error.description || resText));
    }
    return jsonSuccess({ razorpayOrderId: resData.id, amountPaise: resData.amount, currency: resData.currency, keyId: keyId });
  } catch (err) { return jsonError(err.message); }
}

function apiVerifyPayment(params) {
  try {
    const context = resolveEventContext(params);
    const settingsSheet = context.ss.getSheetByName("Settings");
    const s = {};
    if (settingsSheet) settingsSheet.getDataRange().getValues().forEach(r => { if (r[0]) s[String(r[0]).trim()] = r[1]; });

    const { keyId, keySecret } = razorpayKeys_(s);
    if (!keySecret) return jsonError("Payment gateway configuration missing.");

    const orderId = params.razorpay_order_id, paymentId = params.razorpay_payment_id, signature = params.razorpay_signature;
    if (!orderId || !paymentId || !signature) return jsonError("Missing verification parameters.");

    const signPayload = orderId + "|" + paymentId;
    const computedSignature = Utilities.computeHmacSha256Signature(signPayload, keySecret);
    const computedSignatureHex = computedSignature.map(b => { let hex = (b & 0xff).toString(16); return hex.length === 1 ? '0' + hex : hex; }).join('');
    if (computedSignatureHex !== signature) return jsonError("Payment signature verification failed. Potential fraud attempt.");

    const paymentsSheet = context.ss.getSheetByName("Payments");
    if (!paymentsSheet) return jsonError("Payments table not found.");

    const url = "https://api.razorpay.com/v1/payments/" + paymentId;
    const options = { method: "get", headers: { "Authorization": "Basic " + Utilities.base64Encode(keyId + ":" + keySecret) }, muteHttpExceptions: true };
    const response = UrlFetchApp.fetch(url, options);
    const pDetails = JSON.parse(response.getContentText());
    if (response.getResponseCode() !== 200 || pDetails.status !== "captured") {
      return jsonError("Payment verification failed on gateway. Status: " + (pDetails.status || "Unknown"));
    }

    const amount = Number(pDetails.amount) / 100;
    const name = params.name || pDetails.notes.name || "Anonymous";
    const village = params.village || pDetails.notes.village || "";
    const phone = params.phone || pDetails.contact || "";
    const email = params.email || pDetails.email || "";
    const message = params.message || pDetails.notes.message || "";

    const n = nowFormatted();
    const receiptNum = "EP" + n.date.replace(/-/g,"") + "_" + Utilities.getUuid().substring(0, 4).toUpperCase();

    paymentsSheet.appendRow([receiptNum, orderId, paymentId, name, village, phone, email, amount, message, n.date + " " + n.time, "Paid", "Pending", "None", n.iso, n.iso]);
    addVillageInternal(context.ss, village);

    try {
      if (s["OrganizerEmail"]) {
        MailApp.sendEmail({ to: String(s["OrganizerEmail"]), subject: "💰 Contribution: " + name + " - ₹" + amount, body: "Name: " + name + "\nVillage: " + village + "\nPhone: " + phone + "\nAmount: ₹" + amount + "\nReceipt: " + receiptNum + "\nPayment ID: " + paymentId });
      }
    } catch (e) {}

    return jsonSuccess({ receiptNumber: receiptNum, paymentId: paymentId, amount: amount, date: n.date, time: n.time });
  } catch (err) { return jsonError(err.message); }
}

function addVillageInternal(ss, villageName) {
  if (!villageName) return;
  try {
    const sheet = ss.getSheetByName("Villages");
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    const normalizedNew = villageName.trim().toLowerCase();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]).trim().toLowerCase() === normalizedNew) {
        sheet.getRange(i + 1, 3).setValue(parseInt(data[i][2] || 0) + 1);
        return;
      }
    }
    sheet.appendRow([villageName.trim(), normalizedNew, 1]);
  } catch (e) {}
}

function apiGetPublicStats(params) {
  try {
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Payments");
    if (!sheet) return jsonSuccess({ totalCollected: 0, donorCount: 0, goalAmount: 0 });
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonSuccess({ totalCollected: 0, donorCount: 0, goalAmount: 0 });

    const col = getColMap(data[0]);
    const aC = col["amount"] !== undefined ? col["amount"] : 7;
    const sC = col["paymentstatus"] !== undefined ? col["paymentstatus"] : 10;

    let total = 0, count = 0;
    for (let i = 1; i < data.length; i++) {
      const st = String(data[i][sC]).trim().toLowerCase();
      const amt = Number(data[i][aC]) || 0;
      if (st === "paid") { total += amt; count++; }
    }

    const settingsSheet = context.ss.getSheetByName("Settings");
    let goalAmount = 0;
    if (settingsSheet) settingsSheet.getDataRange().getValues().forEach(r => { if (r[0] === "Goal Amount") goalAmount = Number(r[1]) || 0; });

    return jsonSuccess({ totalCollected: total, donorCount: count, goalAmount: goalAmount, currency: "INR" });
  } catch (err) { return jsonError(err.message); }
}

function apiGetPublicPayments(params) {
  try {
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Payments");
    if (!sheet) return jsonSuccess({ donors: [] });
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonSuccess({ donors: [] });

    const col = getColMap(data[0]);
    const nC = col["name"] !== undefined ? col["name"] : 3, vC = col["village"] !== undefined ? col["village"] : 4;
    const aC = col["amount"] !== undefined ? col["amount"] : 7, sC = col["paymentstatus"] !== undefined ? col["paymentstatus"] : 10;
    const dC = col["paymentdate"] !== undefined ? col["paymentdate"] : 9, mC = col["message"] !== undefined ? col["message"] : 8;

    const donors = [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][sC]).trim().toLowerCase() === "paid") {
        donors.push({ name: data[i][nC], village: data[i][vC], amount: Number(data[i][aC]) || 0, paymentDate: serializeVal(data[i][dC], 'paymentdate'), message: data[i][mC] || "" });
      }
    }
    return jsonSuccess({ donors: donors });
  } catch (err) { return jsonError(err.message); }
}

function apiCheckStatus(params) {
  try {
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Payments");
    if (!sheet) return jsonSuccess({ found: false });
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonSuccess({ found: false });

    const col = getColMap(data[0]);
    const C = {
      receipt: col["paymentid"] !== undefined ? col["paymentid"] : 0, payment: col["razorpaypaymentid"] !== undefined ? col["razorpaypaymentid"] : 2,
      name: col["name"] !== undefined ? col["name"] : 3, village: col["village"] !== undefined ? col["village"] : 4,
      phone: col["phone"] !== undefined ? col["phone"] : 5, amount: col["amount"] !== undefined ? col["amount"] : 7,
      msg: col["message"] !== undefined ? col["message"] : 8, date: col["paymentdate"] !== undefined ? col["paymentdate"] : 9,
      status: col["paymentstatus"] !== undefined ? col["paymentstatus"] : 10, settle: col["settlementstatus"] !== undefined ? col["settlementstatus"] : 11,
      refund: col["refundstatus"] !== undefined ? col["refundstatus"] : 12
    };

    const searchVal = String(params.searchVal || "").trim().toLowerCase();
    if (!searchVal) return jsonSuccess({ found: false });

    for (let i = 1; i < data.length; i++) {
      const recVal = String(data[i][C.receipt]).toLowerCase(), phoneVal = String(data[i][C.phone]).toLowerCase(), payVal = String(data[i][C.payment]).toLowerCase();
      const isMatch = recVal === searchVal || phoneVal === searchVal || payVal === searchVal || recVal.slice(-5) === searchVal;
      if (isMatch) {
        return jsonSuccess({
          found: true, receiptNumber: data[i][C.receipt], paymentId: data[i][C.payment], name: data[i][C.name], village: data[i][C.village],
          phone: data[i][C.phone], amount: Number(data[i][C.amount]), message: data[i][C.msg], date: serializeVal(data[i][C.date], 'paymentdate'),
          status: data[i][C.status], settlementStatus: data[i][C.settle], refundStatus: data[i][C.refund]
        });
      }
    }
    return jsonSuccess({ found: false });
  } catch (err) { return jsonError(err.message); }
}

function apiGetPayments(params) {
  try {
    verifyAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Payments");
    if (!sheet) return jsonSuccess({ payments: [] });
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const payments = [];
    for (let i = 1; i < data.length; i++) {
      const row = { _row: i + 1 };
      headers.forEach((h, j) => { if (h) row[String(h).trim()] = serializeVal(data[i][j], h); });
      payments.push(row);
    }
    return jsonSuccess({ payments: payments });
  } catch (err) { return jsonError(err.message); }
}

function apiUpdatePayments(params) {
  try {
    verifyAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Payments");
    if (!sheet) return jsonError("Payments table not found.");
    const row = Number(params.row);
    const updates = JSON.parse(params.updates || '{}');
    const headers = sheet.getDataRange().getValues()[0];
    const col = getColMap(headers);
    Object.keys(updates).forEach(key => {
      const colIdx = col[key.toLowerCase()];
      if (colIdx !== undefined) {
        const oldVal = sheet.getRange(row, colIdx + 1).getValue();
        sheet.getRange(row, colIdx + 1).setValue(updates[key]);
        logAuditRecord(context.ss, { adminUser: params.adminUser, module: "Payments", action: "Edit", field: key, oldValue: String(oldVal), newValue: String(updates[key]), reason: params.reason || "Dashboard edit" });
      }
    });
    return jsonSuccess({ result: "Updated" });
  } catch (err) { return jsonError(err.message); }
}

// ============================================================
// 7. PHOTO GALLERY
// ============================================================

function apiGetGalleryImages(params) {
  try {
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Gallery");
    if (!sheet) return jsonSuccess({ sections: {}, images: [] });
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonSuccess({ sections: {}, images: [] });

    const col = getColMap(data[0]);
    const fldC = col["folder"] !== undefined ? col["folder"] : 1, urlC = col["imageurl"] !== undefined ? col["imageurl"] : 3;
    const thbC = col["thumbnailurl"] !== undefined ? col["thumbnailurl"] : 4, nameC = col["imagename"] !== undefined ? col["imagename"] : 2;
    const statusC = col["status"] !== undefined ? col["status"] : 7;

    const sections = { marriage: [], reception: [], haldi: [], engagement: [], public: [] };
    const allImages = [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][statusC]).trim().toLowerCase() !== "approved") continue;
      const folderVal = String(data[i][fldC]).trim().toLowerCase();
      const imgObj = { id: String(i + 1), url: String(data[i][urlC]).trim(), thumb: String(data[i][thbC]).trim() || String(data[i][urlC]).trim(), name: String(data[i][nameC]).trim() };
      if (sections[folderVal] !== undefined) sections[folderVal].push(imgObj); else sections.public.push(imgObj);
      allImages.push(imgObj);
    }
    return jsonSuccess({ sections: sections, images: allImages });
  } catch (err) { return jsonError(err.message); }
}

function apiUploadPhoto(params) {
  try {
    const context = resolveEventContext(params);
    const settingsSheet = context.ss.getSheetByName("Settings");
    const s = {};
    if (settingsSheet) settingsSheet.getDataRange().getValues().forEach(r => { if (r[0]) s[String(r[0]).trim()] = r[1]; });

    const folderCategory = String(params.folder || "public").trim().toLowerCase();
    const folderKey = folderCategory.toUpperCase() + "_FOLDER_ID";
    const folderId = extractFolderID(s[folderKey] || s["PUBLIC_FOLDER_ID"]);
    if (!folderId) return jsonError("Drive folder configuration not found for category: " + folderCategory);

    const name = params.name || "Anonymous";
    const filedata = params.filedata;
    const filename = params.filename || "upload_" + Date.now();
    const filetype = params.filetype || "image/jpeg";
    if (!filedata) return jsonError("No image data provided.");

    const cleanBase64 = filedata.split(",")[1] || filedata;
    const bytes = Utilities.base64Decode(cleanBase64);
    const blob = Utilities.newBlob(bytes, filetype, filename);
    const folder = DriveApp.getFolderById(folderId);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const fileUrl = file.getUrl();
    const fileId = file.getId();
    const thumbUrl = "https://lh3.googleusercontent.com/d/" + fileId + "=w400-h400-no";

    const gallerySheet = context.ss.getSheetByName("Gallery");
    if (!gallerySheet) return jsonError("Gallery table not found.");

    const n = nowFormatted();
    const photoId = "PH" + Utilities.getUuid().substring(0, 8).toUpperCase();
    const defaultStatus = (s["MODERATION_ENABLED"] === "No" || s["MODERATION_ENABLED"] === "false") ? "Approved" : "Pending";

    gallerySheet.appendRow([photoId, folderCategory, filename, fileUrl, thumbUrl, name, n.iso, defaultStatus]);
    return jsonSuccess({ photoId: photoId, status: defaultStatus, message: defaultStatus === "Approved" ? "Uploaded and published!" : "Submitted for approval." });
  } catch (err) { return jsonError(err.message); }
}

function apiGetPendingPhotos(params) {
  try {
    verifyAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Gallery");
    if (!sheet) return jsonSuccess({ photos: [] });
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonSuccess({ photos: [] });

    const col = getColMap(data[0]);
    const idC = col["photoid"] !== undefined ? col["photoid"] : 0, fldC = col["folder"] !== undefined ? col["folder"] : 1;
    const nameC = col["imagename"] !== undefined ? col["imagename"] : 2, urlC = col["imageurl"] !== undefined ? col["imageurl"] : 3;
    const whoC = col["uploadedby"] !== undefined ? col["uploadedby"] : 5, whenC = col["uploadedtime"] !== undefined ? col["uploadedtime"] : 6;
    const statusC = col["status"] !== undefined ? col["status"] : 7;

    const photos = [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][statusC]).trim() === "Pending") {
        photos.push({ row: i + 1, photoId: data[i][idC], folder: data[i][fldC], name: data[i][nameC], url: data[i][urlC], uploadedBy: data[i][whoC], uploadedTime: serializeVal(data[i][whenC], 'uploadedtime') });
      }
    }
    return jsonSuccess({ photos: photos });
  } catch (err) { return jsonError(err.message); }
}

function apiModeratePhoto(params) {
  try {
    verifyAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Gallery");
    if (!sheet) return jsonError("Gallery table not found.");
    const row = Number(params.row);
    const approve = String(params.approve).toLowerCase() === "true" || String(params.approve) === "1";
    const headers = sheet.getDataRange().getValues()[0];
    const statusIdx = getColMap(headers)["status"];
    if (statusIdx === undefined) return jsonError("Status column not found.");
    const newStatus = approve ? "Approved" : "Rejected";
    sheet.getRange(row, statusIdx + 1).setValue(newStatus);
    logAuditRecord(context.ss, { adminUser: params.adminUser, module: "Gallery", action: approve ? "Approve" : "Reject", field: "Status", oldValue: "Pending", newValue: newStatus, reason: params.reason || "Admin moderation" });
    return jsonSuccess({ result: "Moderated", status: newStatus });
  } catch (err) { return jsonError(err.message); }
}

function apiDeletePhoto(params) {
  try {
    verifyAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Gallery");
    if (!sheet) return jsonError("Gallery table not found.");
    const row = Number(params.row);
    const data = sheet.getDataRange().getValues();
    if (row < 2 || row > data.length) return jsonError("Invalid row index.");
    const col = getColMap(data[0]);
    const idVal = data[row - 1][col["photoid"]], urlVal = data[row - 1][col["imageurl"]];
    try { const fileId = extractFolderID(urlVal); if (fileId) DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {}
    sheet.deleteRow(row);
    logAuditRecord(context.ss, { adminUser: params.adminUser, module: "Gallery", action: "Delete", field: "Row", oldValue: String(idVal), newValue: "Deleted", reason: params.reason || "Gallery cleaning" });
    return jsonSuccess({ result: "Deleted" });
  } catch (err) { return jsonError(err.message); }
}

// ============================================================
// 8. COMPLAINTS
// ============================================================

function apiSubmitComplaint(params) {
  try {
    const context = resolveEventContext(params);
    const settingsSheet = context.ss.getSheetByName("Settings");
    const s = {};
    if (settingsSheet) settingsSheet.getDataRange().getValues().forEach(r => { if (r[0]) s[String(r[0]).trim()] = r[1]; });

    let fileUrl = "";
    if (params.filedata) {
      try {
        const folderId = extractFolderID(s["COMPLAINT_UPLOAD_FOLDER_ID"] || s["PUBLIC_FOLDER_ID"]);
        if (folderId) {
          const cleanBase64 = params.filedata.split(",")[1] || params.filedata;
          const bytes = Utilities.base64Decode(cleanBase64);
          const blob = Utilities.newBlob(bytes, params.filetype || "image/jpeg", params.filename || "screenshot_" + Date.now());
          const folder = DriveApp.getFolderById(folderId);
          const file = folder.createFile(blob);
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          fileUrl = file.getUrl();
        }
      } catch (err) {}
    }

    const complaintsSheet = context.ss.getSheetByName("Complaints");
    if (!complaintsSheet) return jsonError("Complaints database table not found.");

    const name = params.name || "Anonymous", village = params.village || "", phone = params.phone || "", complaintText = params.complaint || "";
    if (!complaintText) return jsonError("Please describe your issue.");

    const n = nowFormatted();
    const complaintId = "CP" + Utilities.getUuid().substring(0, 8).toUpperCase();
    complaintsSheet.appendRow([complaintId, name, village, phone, complaintText, fileUrl, "Open", "", n.iso, ""]);
    return jsonSuccess({ complaintId: complaintId, status: "Open" });
  } catch (err) { return jsonError(err.message); }
}

function apiGetComplaintStatus(params) {
  try {
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Complaints");
    if (!sheet) return jsonSuccess({ complaints: [] });
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonSuccess({ complaints: [] });

    const col = getColMap(data[0]);
    const idC = col["complaintid"] !== undefined ? col["complaintid"] : 0, txtC = col["complaint"] !== undefined ? col["complaint"] : 4;
    const phC = col["phone"] !== undefined ? col["phone"] : 3, stC = col["status"] !== undefined ? col["status"] : 6;
    const repC = col["reply"] !== undefined ? col["reply"] : 7, timeC = col["createdtime"] !== undefined ? col["createdtime"] : 8;

    const searchPhone = String(params.phone || "").trim().toLowerCase();
    const searchId = String(params.trackId || params.complaintId || "").trim().toLowerCase();
    if (!searchPhone && !searchId) return jsonError("Phone or Complaint ID is required.");

    const results = [];
    for (let i = 1; i < data.length; i++) {
      const idVal = String(data[i][idC]).trim(), phoneVal = String(data[i][phC]).trim();
      let isMatch = false;
      if (searchId && idVal.toLowerCase() === searchId) isMatch = true;
      else if (searchPhone && phoneVal.toLowerCase() === searchPhone) isMatch = true;
      if (isMatch) results.push({ complaintId: idVal, complaint: data[i][txtC], status: data[i][stC], reply: data[i][repC], createdTime: serializeVal(data[i][timeC], 'createdtime') });
    }
    return jsonSuccess({ complaints: results });
  } catch (err) { return jsonError(err.message); }
}

function apiGetComplaints(params) {
  try {
    verifyAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Complaints");
    if (!sheet) return jsonSuccess({ complaints: [] });
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const complaints = [];
    for (let i = 1; i < data.length; i++) {
      const row = { _row: i + 1 };
      headers.forEach((h, j) => { if (h) row[String(h).trim()] = serializeVal(data[i][j], h); });
      complaints.push(row);
    }
    return jsonSuccess({ complaints: complaints });
  } catch (err) { return jsonError(err.message); }
}

function apiUpdateComplaint(params) {
  try {
    verifyAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Complaints");
    if (!sheet) return jsonError("Complaints table not found.");
    const row = Number(params.row), status = params.status, reply = params.reply;
    const col = getColMap(sheet.getDataRange().getValues()[0]);
    const statusIdx = col["status"], replyIdx = col["reply"], resolvedTimeIdx = col["resolvedtime"];
    if (statusIdx === undefined || replyIdx === undefined) return jsonError("Table schema mismatch.");

    const n = nowFormatted();
    sheet.getRange(row, statusIdx + 1).setValue(status);
    sheet.getRange(row, replyIdx + 1).setValue(reply);
    if ((status === "Resolved" || status === "Closed") && resolvedTimeIdx !== undefined) sheet.getRange(row, resolvedTimeIdx + 1).setValue(n.iso);

    logAuditRecord(context.ss, { adminUser: params.adminUser, module: "Complaints", action: "Update", field: "Resolution", oldValue: "Open", newValue: status + " (" + String(reply).substring(0, 10) + "...)", reason: params.reason || "Complaint resolved by admin" });
    return jsonSuccess({ result: "Resolved" });
  } catch (err) { return jsonError(err.message); }
}

// ============================================================
// 9. ADMIN AUTHENTICATION, SESSIONS & AUDITING (per-event)
// ============================================================

function apiLoginAdmin(params) {
  try {
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("Admins");
    if (!sheet) return jsonError("Admins authentication table not found.");

    const username = String(params.username || "").trim(), password = String(params.password || "").trim();
    if (!username || !password) return jsonError("Missing login credentials.");

    const data = sheet.getDataRange().getValues();
    const col = getColMap(data[0]);
    const userIdx = col["username"] !== undefined ? col["username"] : 0, passIdx = col["password"] !== undefined ? col["password"] : 1;
    const roleIdx = col["role"] !== undefined ? col["role"] : 2, accessIdx = col["accesslevel"] !== undefined ? col["accesslevel"] : 3;
    const statusIdx = col["status"] !== undefined ? col["status"] : 4, emailIdx = col["email"] !== undefined ? col["email"] : 5;
    const loginIdx = col["lastlogin"] !== undefined ? col["lastlogin"] : 7;

    for (let i = 1; i < data.length; i++) {
      const uVal = String(data[i][userIdx]).trim(), pVal = String(data[i][passIdx]).trim();
      const statusVal = String(data[i][statusIdx] || "Active").trim().toLowerCase();
      if (uVal === username && pVal === password) {
        if (statusVal === "inactive") return jsonError("Account is inactive. Contact Super Admin.");

        const n = nowFormatted();
        if (loginIdx !== undefined) sheet.getRange(i + 1, loginIdx + 1).setValue(n.full);

        const settingsSheet = context.ss.getSheetByName("Settings");
        let timeout = 30;
        if (settingsSheet) settingsSheet.getDataRange().getValues().forEach(r => { if (r[0] === "SessionTimeoutMinutes") timeout = parseInt(r[1]) || 30; });

        const expiry = new Date(Date.now() + timeout * 60 * 1000).toISOString();
        const token = Utilities.getUuid();
        const cache = CacheService.getScriptCache();
        const sessionInfo = { username: username, role: String(data[i][roleIdx]), accessLevel: String(data[i][accessIdx]), email: String(data[i][emailIdx]), spreadsheetId: context.spreadsheetId };
        cache.put("session_" + token, JSON.stringify(sessionInfo), timeout * 60);

        logAuditRecord(context.ss, { adminUser: username, module: "Auth", action: "Login", field: "Session", oldValue: "Offline", newValue: "Online", reason: "Dashboard login" });
        return jsonSuccess({ role: sessionInfo.role, accessLevel: sessionInfo.accessLevel, email: sessionInfo.email, token: token, expiry: expiry });
      }
    }
    return jsonError("Invalid username or password.");
  } catch (err) { return jsonError(err.message); }
}

function apiAdminLogout(params) {
  try {
    const token = params.adminToken || params.token;
    if (token) CacheService.getScriptCache().remove("session_" + token);
    return jsonSuccess({ result: "LoggedOut" });
  } catch (err) { return jsonError(err.message); }
}

function verifyAdmin(params) {
  const token = params.adminToken || params.token;
  if (!token) throw new Error("Unauthorized: session token is missing.");
  const cached = CacheService.getScriptCache().get("session_" + token);
  if (!cached) throw new Error("Unauthorized: session expired or invalid.");
  const session = JSON.parse(cached);

  // Match against whichever identifier this call was made with.
  const wantSid = params.sid;
  const wantCode = String(params.eventCode || params.code || "").toUpperCase().trim();
  if (wantSid && session.spreadsheetId !== wantSid) throw new Error("Unauthorized: token does not match this event's context.");
  if (!wantSid && wantCode) {
    const sid = resolveSpreadsheetID(wantCode);
    if (session.spreadsheetId !== sid) throw new Error("Unauthorized: token does not match this event's context.");
  }
  return session;
}

function verifySuperAdmin(params) {
  const session = verifyAdmin(params);
  const role = String(session.role).toLowerCase();
  if (role !== "super admin" && role !== "superadmin") throw new Error("Super Admin permissions required.");
  return session;
}

function logAuditRecord(ss, record) {
  try {
    const sheet = ss.getSheetByName("AuditLog");
    if (!sheet) return;
    const n = nowFormatted();
    sheet.appendRow([n.full, record.adminUser || "system", record.action || "", record.module || "", record.field || "", record.oldValue || "", record.newValue || "", record.reason || ""]);
  } catch (e) {}
}

function apiGetAuditLog(params) {
  try {
    verifySuperAdmin(params);
    const context = resolveEventContext(params);
    const sheet = context.ss.getSheetByName("AuditLog");
    if (!sheet) return jsonSuccess({ audit: [] });
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const logs = [];
    for (let i = 1; i < data.length; i++) {
      const row = { _row: i + 1 };
      headers.forEach((h, j) => { if (h) row[String(h).trim()] = serializeVal(data[i][j], h); });
      logs.push(row);
    }
    return jsonSuccess({ audit: logs });
  } catch (err) { return jsonError(err.message); }
}

// ============================================================
// 10. SHEET INITIALIZATION  (used by both manual admin action
//     "createEventSpreadsheet" and the automatic Apply-Event flow)
// ============================================================
// NOTE: initializeEventSpreadsheet() itself lives in SheetInit.gs
// (a separate file in this project) to keep this file focused on
// routing/API logic. Do not redefine it here.

function apiCreateEventSpreadsheet(params) {
  try {
    verifySuperAdmin(params);
    const spreadsheetId = params.targetSpreadsheetId || params.sid;
    if (!spreadsheetId) return jsonError("Target Spreadsheet ID is required.");
    const result = initializeEventSpreadsheet(spreadsheetId);
    return jsonSuccess({ result: result.success ? "SpreadsheetInitialized" : "Failed" });
  } catch (err) { return jsonError(err.message); }
}

// ============================================================
// 11. APPLY EVENT — OTP, duplicate check, automatic creation
// ============================================================

const EVENT_CODE_PREFIX = {
  "Marriage": "WED", "Birthday": "BDY", "Reception": "REC", "Engagement": "ENG",
  "Anniversary": "ANN", "Baby Shower": "BBS", "House Warming": "HSW",
  "Temple Festival": "TMP", "Corporate Event": "COR", "Naming Ceremony": "NAM", "Other": "OTH"
};

// Common folders for every event, per the specified structure.
// Gallery folder name is the only thing that varies by event type.
const EVENT_GALLERY_FOLDER_NAME = {
  "Marriage": ["Marriage Gallery", "Haldi Gallery", "Engagement Gallery"],
  "Birthday": ["Birthday Gallery"],
  "Reception": ["Reception Gallery"],
  "Temple Festival": ["Festival Gallery"],
  // Not explicitly specified — sensible default pattern, single gallery folder:
  "Engagement": ["Engagement Gallery"], "Anniversary": ["Anniversary Gallery"],
  "Baby Shower": ["Baby Shower Gallery"], "House Warming": ["House Warming Gallery"],
  "Corporate Event": ["Corporate Gallery"], "Naming Ceremony": ["Naming Ceremony Gallery"],
  "Other": ["Event Gallery"]
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

function apiSendOrganizerOtp(p) { return sendOrganizerOtp(p.email); }
function apiVerifyOrganizerOtp(p) { return verifyOrganizerOtp(p.email, p.otp); }
function apiCheckDuplicateEvent(p) { return checkDuplicateEvent(p.organizerEmail, p.eventDate, p.eventName); }
function apiSubmitEventApplication(p) {
  let formData;
  try { formData = JSON.parse(p.formData || "{}"); }
  catch (err) { return { success: false, message: "Malformed form data." }; }
  return submitEventApplication(formData);
}

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
  const col = {};
  data[0].forEach((h, i) => { col[h] = i; });
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const sameEmail = row[col["OrganizerEmail"]] === organizerEmail;
    const sameDate = formatDateOnly_(row[col["CreatedDate"]]) === eventDate || String(row[col["EventName"]]).toLowerCase() === String(eventName).toLowerCase();
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
  try {
    const cache = CacheService.getScriptCache();
    if (!cache.get("OTP_VERIFIED_" + formData.organizerEmail)) {
      return { success: false, message: "Email not verified. Please verify OTP first." };
    }

    // Automatically extract the Spreadsheet ID from whatever the user pasted —
    // full edit URL or a bare ID both work.
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

    const eventId = getNextEventId_();                 // automatic, numeric, e.g. 1000
    const eventCode = generateEventCode_(formData.eventType); // automatic
    const eventName = formData.autoEventName || buildEventName_(formData);

    const initResult = initializeEventSpreadsheet(spreadsheetId);
    if (!initResult || !initResult.success) return { success: false, message: "Failed to initialize spreadsheet." };

    const folderResult = createEventDriveFolders_(eventId, eventCode, eventName, formData.eventType);
    writeEventSettings_(targetSs, formData, folderResult.settingsUpdates);

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
      Status: "Active", SettlementStatus: "Pending",           // automatic — never asked from the user
      CreatedDate: createdDate, UpdatedDate: createdDate,
      AdminUsername: adminUsername, AdminPassword: adminPassword, PublicURL: publicURL, AdminURL: adminURL
    });

    logAudit_({ action: "Created Event", organizerEmail: formData.organizerEmail, spreadsheetId: spreadsheetId, eventCode: eventCode, plan: formData.plan });

    try {
      sendEventCreatedEmail_(formData.organizerEmail, {
        eventName: eventName, eventId: eventId, eventCode: eventCode, spreadsheetLink: formData.spreadsheetLink,
        publicURL: publicURL, adminURL: adminURL, adminUsername: adminUsername, adminPassword: adminPassword,
        plan: formData.plan, trialExpiry: trialExpiry
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
  for (let i = 1; i < data.length; i++) {
    if (data[i][emailCol] === email && data[i][planCol] === "Free") return true;
  }
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

/**
 * Creates the event's Drive folder tree INSIDE ROOT_DRIVE_FOLDER_ID:
 *   <EventID>_<EventCode>_<EventName>
 *   ├── Invitation Card
 *   ├── Complaint Uploads
 *   └── <gallery folder(s) specific to eventType>
 * Exactly the folders listed for that event type — nothing extra.
 */
function createEventDriveFolders_(eventId, eventCode, eventName, eventType) {
  const root = DriveApp.getFolderById(getRootDriveFolderId());
  const parentName = eventId + "_" + eventCode + "_" + eventName;
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

function writeEventSettings_(targetSs, formData, folderSettings) {
  const settingsSheet = targetSs.getSheetByName("Settings");
  if (!settingsSheet) return;

  const updates = {
    "Event Name": formData.autoEventName, "EventDate": formData.eventDate, "EventTime": formData.eventTime,
    "VenueAddress": formData.venue, "VenueMapLink": formData.mapsLink, "UPI_ID": formData.upiId,
    "ORG_NAME": formData.organizerName, "OrganizerEmail": formData.organizerEmail
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
  const masterSs = SpreadsheetApp.openById(getMasterDbId());
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

function sendEventCreatedEmail_(to, details) {
  const body =
    "Congratulations! Your event has been created.\n\n" +
    "Event Name: " + details.eventName + "\n" + "Event ID: " + details.eventId + "\n" + "Event Code: " + details.eventCode + "\n" +
    "Plan: " + details.plan + (details.trialExpiry ? (" (trial expires " + details.trialExpiry + ")") : "") + "\n\n" +
    "Spreadsheet: " + details.spreadsheetLink + "\n" + "Public Page: " + details.publicURL + "\n" + "Admin Panel: " + details.adminURL + "\n\n" +
    "Admin Username: " + details.adminUsername + "\n" + "Temporary Password: " + details.adminPassword + "\n" +
    "(Please log in and change this password immediately.)\n";
  MailApp.sendEmail(to, "Your EventPay Event Is Ready — " + details.eventCode, body);
}


function apiGetEvents() {

  const sheet = getOrCreateEventsSheet_();
  const data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    return {
      success: true,
      events: []
    };
  }

  const headers = data[0];
  const events = [];

  for (let i = 1; i < data.length; i++) {

    let row = {};

    headers.forEach((h, j) => {
      row[h] = data[i][j];
    });

    if (String(row.Status).toLowerCase() === "active") {
      events.push(row);
    }

  }

  return {
    success: true,
    events: events
  };

}



