// ============================================================
// EventPay — SheetMaker.gs  (creates & maintains all tabs for an
// event spreadsheet)
// ============================================================
// initializeEventSpreadsheet(spreadsheetId) is fully idempotent:
// calling it any number of times will only create what's missing
// (sheets, headers, settings rows, the fallback admin, formatting,
// validations, number formats) and will NEVER duplicate rows,
// headers, validations, or formatting, and NEVER overwrite a value
// a user has already set.
// ============================================================

// ============================================================
// SECTION: CONFIGURATION
// ============================================================
var SHEET_ORDER = [
  "Payments", "Complaints", "Villages", "AuditLog",
  "ActivityLog", "UTRBlacklist", "Settings", "Admins"
];

// ============================================================
// SECTION: HEADER DEFINITIONS
// ============================================================
var SHEET_HEADERS = {
  "Payments": [
    "RefID", "Date", "Time", "Full Name", "Village", "Phone number", "Amount", "UTR", "Status",
    "FraudScore", "RiskLevel", "ReviewFlag", "ShowPublic", "Verified By", "Verified At", "Notes"
  ],
  "Complaints": [
    "ComplaintID", "Date", "Time", "Name", "Village", "Phone", "Email", "Complaint", "Attachment",
    "AttachmentURL", "AttachmentName", "Status", "ReplyBy", "AdminReply", "RepliedAt", "Priority"
  ],
  "Villages": ["Village", "NormalizedName", "Count", "Status"],
  "AuditLog": [
    "Timestamp", "AdminUser", "Module", "Action", "Field", "OldValue", "NewValue", "Reason", "Row", "Column", "RecordID"
  ],
  "ActivityLog": [
    "RecordID", "Date", "Time", "AdminUser", "Module", "Action", "Detail", "OldValue", "NewValue",
    "RecordID_Ref", "Browser", "Device", "LogoutType"
  ],
  "UTRBlacklist": ["UTR", "Date Time", "Reason"],
  "Settings": ["Key", "Value"],
  "Admins": ["Username", "Password", "Role", "AccessLevel", "Status", "Email", "CreatedAt", "LastLogin"]
};

// ============================================================
// SECTION: SETTINGS DEFAULTS
// ============================================================
var SETTINGS_DEFAULTS = [
  ["Event Name", ""],
  ["EventDate", ""],
  ["EventTime", ""],
  ["VenueAddress", ""],
  ["VenueMapLink", ""],

  ["UPI_ID", ""],

  ["ORG_NAME", ""],
  ["OrganizerEmail", ""],

  ["INVITATION_CARD_DRIVE_LINK", ""],
  ["INVITATION_CARD_FOLDER_ID", ""],

  ["COMPLAINT_UPLOAD_FOLDER_ID", ""],

  ["MIN_AMOUNT", 100],
  ["MAX_AMOUNT", 100000],

  ["SHOW_DONOR_LIST", "ACTIVE"],
  ["SHOW_PENDING_PAYMENTS", "ACTIVE"],
  ["SHOW_VERIFIED_PAYMENTS", "ACTIVE"],
  ["SHOW_RECENT_PAYMENTS", "ACTIVE"],
  ["SHOW_STATISTICS", "ACTIVE"],
  ["SHOW_HOMEPAGE_STATS", "ACTIVE"],
  ["SHOW_HOMEPAGE_DONORS", "ACTIVE"],
  ["SHOW_GALLERY", "ACTIVE"],
  ["SHOW_INVITE_CARD", "ACTIVE"],

  ["FRAUD_THRESHOLD_HIGH", 80],
  ["FRAUD_THRESHOLD_MEDIUM", 50],

  ["SHOW_ENGAGEMENT_GALLERY", "ACTIVE"],
  ["SHOW_HALDI_GALLERY", "ACTIVE"],
  ["SHOW_MARRIAGE_GALLERY", "ACTIVE"],

  ["ALLOW_DOWNLOAD_ALL", "ACTIVE"],
  ["ALLOW_SECTION_DOWNLOAD", "ACTIVE"],

  ["EVENT_PARENT_FOLDER_ID", ""],
  ["EVENT_PARENT_FOLDER_LINK", ""],

  ["ENGAGEMENT_GALLERY_FOLDER_ID", ""],
  ["HALDI_GALLERY_FOLDER_ID", ""],
  ["MARRIAGE_GALLERY_FOLDER_ID", ""],
  ["RECEPTION_GALLERY_FOLDER_ID", ""],
  ["BIRTHDAY_GALLERY_FOLDER_ID", ""],
  ["ANNIVERSARY_GALLERY_FOLDER_ID", ""],
  ["BABY_SHOWER_GALLERY_FOLDER_ID", ""],
  ["HOUSE_WARMING_GALLERY_FOLDER_ID", ""],
  ["TEMPLE_FESTIVAL_GALLERY_FOLDER_ID", ""],
  ["CORPORATE_EVENT_GALLERY_FOLDER_ID", ""],
  ["OTHER_GALLERY_FOLDER_ID", ""]
];


// Default admin row. Index 6 (CreatedAt) is filled with the real
// timestamp at write time — see initializeAdminsSheet_.
var DEFAULT_ADMIN_ROW = ["admin", "admin123", "superadmin", "full", "Active", "", "", ""];

// ============================================================
// SECTION: PUBLIC FUNCTIONS
// ============================================================

/**
 * Creates and/or repairs every required sheet inside an event
 * spreadsheet. Safe to call repeatedly — only creates what's
 * missing, never duplicates or overwrites existing data.
 *
 * @param {string} spreadsheetId
 * @return {{success:boolean, createdSheets:Array, updatedSheets:Array,
 *           spreadsheetId:string, error?:string, details?:Array}}
 */
function initializeEventSpreadsheet(spreadsheetId) {
  if (!spreadsheetId) throw new Error("initializeEventSpreadsheet: spreadsheetId is required.");

  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (err) {
   console.log("SheetMaker ERROR: could not open spreadsheet " + spreadsheetId + " — " + err.message);
    return { success: false, error: "Unable to open spreadsheet: " + err.message, spreadsheetId: spreadsheetId };
  }

  var createdSheets = [];
  var updatedSheets = [];
  var errors = [];

  SHEET_ORDER.forEach(function (sheetName) {
    try {
      var isNew = ensureSheet(ss, sheetName, SHEET_HEADERS[sheetName]);
      var sheet = ss.getSheetByName(sheetName);

      if (isNew) {
        createdSheets.push(sheetName);
      } else {
        var headersAppended = syncHeaders_(sheet, SHEET_HEADERS[sheetName]);
        if (headersAppended) updatedSheets.push(sheetName);
      }

 if (sheetName === "Settings") {
    Logger.log("Initializing Settings");
    initializeSettingsSheet_(sheet);
    Logger.log("Settings rows = " + sheet.getLastRow());
}

    console.log("After initializeSettingsSheet");

    console.log("Rows = " + sheet.getLastRow());




      if (sheetName === "Admins") initializeAdminsSheet_(sheet);

    console.log("Formatting " + sheetName);

applySheetFormatting_(sheet, sheetName);

console.log("Formatted " + sheetName);
      applyValidations(sheet, sheetName);
      applyNumberFormats(sheet, sheetName);

    } catch (err) {
      console.log("SheetMaker ERROR on sheet '" + sheetName + "': " + err.message);
      errors.push({ sheet: sheetName, error: err.message });
    }
  });

  if (errors.length > 0) {
    return {
      success: false,
      error: "One or more sheets failed to initialize.",
      details: errors,
      createdSheets: createdSheets,
      updatedSheets: updatedSheets,
      spreadsheetId: ss.getId()
    };
  }
console.log(
    "SheetMaker: spreadsheet initialized (" + ss.getId() + ")" +
    (createdSheets.length ? " — created: [" + createdSheets.join(", ") + "]" : "") +
    (updatedSheets.length ? " — headers updated: [" + updatedSheets.join(", ") + "]" : "")
  );

  return {
    success: true,
    createdSheets: createdSheets,
    updatedSheets: updatedSheets,
    spreadsheetId: ss.getId()
  };
}

// ============================================================
// SECTION: SHEET CREATION
// ============================================================

/**
 * Creates `sheetName` with `headers` if it doesn't already exist.
 * No-op (returns false) if the sheet is already there — existing
 * sheets are handled by syncHeaders_ instead, so this never
 * touches or resets an existing sheet's data.
 *
 * @return {boolean} true if the sheet was created, false if it already existed.
 */
function ensureSheet(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) return false;

  sheet = ss.insertSheet(sheetName);
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight("bold").setFontColor("#000000").setBackground("#ffffff").setFontSize(12);
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 40);

  ensureColumnWidths_(sheet);

  headerRange.createFilter();
  headerRange.protect().setDescription(sheetName + " Header");

  console.log("SheetMaker: created sheet '" + sheetName + "'");
  return true;
}

// ============================================================
// SECTION: SHEET FORMATTING
// ============================================================

/**
 * Verifies frozen rows, column widths, filter, and header
 * protection are in place — and extends them to cover any newly
 * appended header columns. All checks are guarded so nothing is
 * re-applied when it's already correct.
 */
function applySheetFormatting_(sheet, sheetName) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;

  if (sheet.getFrozenRows() < 1) {
    sheet.setFrozenRows(1);
    sheet.setRowHeight(1, 40);
  }

  ensureColumnWidths_(sheet);

  var filter = sheet.getFilter();
  if (!filter) {
    sheet.getRange(1, 1, 1, lastCol).createFilter();
  } else if (filter.getRange().getLastColumn() < lastCol) {
    filter.remove();
    sheet.getRange(1, 1, 1, lastCol).createFilter();
  }

  ensureHeaderProtection_(sheet, sheetName, lastCol);
}

/**
 * Auto-sizes + widens header columns, but only for columns still
 * at Sheets' untouched default width (100px) — this way a manual
 * resize by a user is never overwritten on a later run.
 */
function ensureColumnWidths_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  headers.forEach(function (header, index) {
    var col = index + 1;
    if (sheet.getColumnWidth(col) !== 100) return; // already sized — leave it alone

    sheet.autoResizeColumn(col);
    var targetWidth = sheet.getColumnWidth(col) + 40;
    if (/FOLDER_ID/.test(header) || /Link/.test(header)) targetWidth = Math.max(targetWidth, 700);
    if (targetWidth < 160) targetWidth = 160;
    sheet.setColumnWidth(col, targetWidth);
  });
}

/**
 * Ensures the header row is protected, widening an existing
 * protection to cover newly appended columns instead of stacking
 * a second protection on top of it.
 */
function ensureHeaderProtection_(sheet, sheetName, lastCol) {
  var description = sheetName + " Header";
  var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);

  for (var i = 0; i < protections.length; i++) {
    if (protections[i].getDescription() === description) {
      if (protections[i].getRange().getLastColumn() < lastCol) {
        protections[i].remove();
        sheet.getRange(1, 1, 1, lastCol).protect().setDescription(description);
        console.log("SheetMaker: extended header protection on '" + sheetName + "'");
      }
      return;
    }
  }

  sheet.getRange(1, 1, 1, lastCol).protect().setDescription(description);
  console.log("SheetMaker: header protection applied on '" + sheetName + "'");
}

/**
 * Settings sheet only: wide Key/Value columns + left-aligned text.
 * Guarded so it only runs once (checked via column width) instead
 * of re-applying font/alignment on every single call.
 */
function formatSettingsColumns(sheet) {
  var alreadyFormatted = sheet.getColumnWidth(1) === 350 && sheet.getColumnWidth(2) === 900;
  if (alreadyFormatted) return;

  var lastRow = sheet.getMaxRows();
  sheet.getRange(1, 1, lastRow, 1).setFontWeight("bold").setHorizontalAlignment("left");
  sheet.getRange(1, 2, lastRow, 1).setFontWeight("normal").setHorizontalAlignment("left");
  sheet.setColumnWidth(1, 350);
  sheet.setColumnWidth(2, 900);

  console.log("SheetMaker: formatting applied on 'Settings'");
}

// ============================================================
// SECTION: SHEET VALIDATION
// ============================================================

function applyValidations(sheet, sheetName) {
  if (sheetName === "Payments") {
    ensureValidation_(sheet, "I2:I", ["Pending", "Pending (Review)", "Verified", "Rejected"]);
    ensureValidation_(sheet, "K2:K", ["LOW", "MEDIUM", "HIGH"]);
  }
  if (sheetName === "Admins") {
    ensureValidation_(sheet, "C2:C", ["superadmin", "admin", "verifier", "viewer"]);
  }
}

/**
 * Applies a list-validation rule to a range only if the probe cell
 * doesn't already have one — never duplicates, never overwrites an
 * unrelated existing validation.
 */
function ensureValidation_(sheet, a1Range, listValues) {
  var probeCell = sheet.getRange(a1Range.split(":")[0]);
  if (probeCell.getDataValidation() !== null) return;

  sheet.getRange(a1Range).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(listValues, true)
      .setAllowInvalid(true)
      .build()
  );
  console.log("SheetMaker: validation applied on '" + sheet.getName() + "'!" + a1Range);
}

function applyNumberFormats(sheet, sheetName) {
  if (sheetName === "Payments") {
    ensureNumberFormat_(sheet, "B:B", "dd-MMM-yyyy");
    ensureNumberFormat_(sheet, "C:C", "hh:mm AM/PM");
    ensureNumberFormat_(sheet, "G:G", "\u20B9#,##0");
  }
  if (sheetName === "Complaints") {
    ensureNumberFormat_(sheet, "B:B", "dd-MMM-yyyy");
    ensureNumberFormat_(sheet, "C:C", "hh:mm AM/PM");
  }
}

function ensureNumberFormat_(sheet, a1Range, format) {
  var range = sheet.getRange(a1Range);
  if (range.getNumberFormat() === format) return;
  range.setNumberFormat(format);
  console.log("SheetMaker: number format applied on '" + sheet.getName() + "'!" + a1Range);
}

// ============================================================
// SECTION: SETTINGS INITIALIZATION
// ============================================================

/**
 * Fills in any missing default settings, whether the Settings sheet
 * is brand-new, pre-existing with only headers, or pre-existing with
 * some (but not all) defaults already present. Existing values are
 * NEVER read for the purpose of overwriting — only missing keys are
 * appended, in a single batched write.
 */
function initializeSettingsSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  var existingKeys = {};

  if (lastRow > 1) {
    var existingData = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    existingData.forEach(function (row) {
      var key = String(row[0]).trim();
      if (key) existingKeys[key] = true;
    });
  }

  var missingRows = SETTINGS_DEFAULTS.filter(function (pair) {
    return !existingKeys[pair[0]];
  });

  if (missingRows.length > 0) {
    var startRow = Math.max(lastRow + 1, 2);
    sheet.getRange(startRow, 1, missingRows.length, 2).setValues(missingRows);
    console.log("SheetMaker: added " + missingRows.length + " missing default setting(s)");
  }

  var dataRowCount = sheet.getLastRow() - 1;
  if (dataRowCount > 0) sheet.setRowHeights(2, dataRowCount, 32);

  formatSettingsColumns(sheet);
}

// ============================================================
// SECTION: ADMIN INITIALIZATION
// ============================================================

/**
 * Creates the default admin account ONLY if the Admins sheet
 * currently has zero admin users — never recreates or duplicates
 * an admin row if one already exists.
 */
function initializeAdminsSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  var hasAdmin = false;

  if (lastRow > 1) {
    var usernames = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    hasAdmin = usernames.some(function (row) { return String(row[0]).trim() !== ""; });
  }

  if (!hasAdmin) {
    var row = DEFAULT_ADMIN_ROW.slice();
    row[6] = new Date(); // CreatedAt
    sheet.getRange(2, 1, 1, row.length).setValues([row]);
    sheet.setRowHeight(2, 30);
   console.log("SheetMaker: default admin account created");
  }
}

// ============================================================
// SECTION: GALLERY INITIALIZATION
// ============================================================
// Gallery support (Engagement, Haldi, Marriage, Reception, Other) is
// not a separate sheet — it lives as *_FOLDER_ID keys inside the
// Settings sheet, written by Code.gs's writeEventSettings_() at
// event-creation time using the real Drive folder IDs it just
// created. This file's only responsibility toward galleries is to
// make sure the Settings sheet exists and accepts new keys, which
// initializeSettingsSheet_() + syncHeaders_() already guarantee.
// No gallery logic has been removed or altered.

// ============================================================
// SECTION: UTILITIES
// ============================================================

/**
 * Appends any headers from `requiredHeaders` that are missing from
 * an EXISTING sheet's header row, in a single batched write. Never
 * reorders or removes existing columns.
 *
 * @return {boolean} true if any headers were appended.
 */
function syncHeaders_(sheet, requiredHeaders) {
  var lastCol = sheet.getLastColumn();
  var existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
    : [];

  var missing = requiredHeaders.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length === 0) return false;

  var startCol = existing.length + 1;
  var range = sheet.getRange(1, startCol, 1, missing.length);
  range.setValues([missing]);
  range.setFontWeight("bold").setFontColor("#000000").setBackground("#ffffff").setFontSize(12);

  console.log("SheetMaker: appended header(s) to '" + sheet.getName() + "': " + missing.join(", "));
  return true;
}
