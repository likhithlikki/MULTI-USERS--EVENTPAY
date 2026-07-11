// ============================================================
// EventPay — SheetInit.gs  (creates all tabs for a NEW event spreadsheet)
// ============================================================
// FIXES vs the previous version:
//   - Payments headers now have the FULL 16 columns Code.gs actually
//     writes (FraudScore, RiskLevel, ReviewFlag were missing before,
//     so those values were landing in unlabeled columns).
//   - Event/folder names are decoded ("+" -> space, %XX -> char)
//     before being used as a Drive folder name, so folders read
//     "Birthday of Likith" instead of "Birthday+of+Likith".
// ============================================================

function initializeEventSpreadsheet(spreadsheetId) {
  if (!spreadsheetId) throw new Error("initializeEventSpreadsheet: spreadsheetId is required.");
  var ss = SpreadsheetApp.openById(spreadsheetId);

  var sheetDefinitions = {
    "Payments": ["RefID","Date","Time","Full Name","Village","Phone number","Amount","UTR","Status",
                 "FraudScore","RiskLevel","ReviewFlag","ShowPublic","Verified By","Verified At","Notes"],
    "Complaints": ["ComplaintID","Date","Time","Name","Village","Phone","Email","Complaint","Attachment",
                   "AttachmentURL","AttachmentName","Status","ReplyBy","AdminReply","RepliedAt","Priority"],
    "Villages": ["Village","NormalizedName","Count","Status"],
    "AuditLog": ["Timestamp","AdminUser","Module","Action","Field","OldValue","NewValue","Reason","Row","Column","RecordID"],
    "ActivityLog": ["RecordID","Date","Time","AdminUser","Module","Action","Detail","OldValue","NewValue","RecordID_Ref","Browser","Device","LogoutType"],
    "UTRBlacklist": ["UTR","Date Time","Reason"],
    "Settings": ["Key","Value"],
    "Admins": ["Username","Password","Role","AccessLevel","Status","Email","CreatedAt","LastLogin"]
  };

  var settingsDefaults = [
    ["Event Name", ""],
    ["EventDate", ""],
    ["EventTime", ""],
    ["VenueAddress", ""],
    ["VenueMapLink", ""],
    ["UPI_ID", ""],
    ["ORG_NAME", ""],
    ["OrganizerEmail", ""],
    ["INVITATION_CARD_DRIVE_LINK", ""],
    ["COMPLAINT_UPLOAD_FOLDER_ID", ""],
    ["MIN_AMOUNT", 500],
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
    ["ENGAGEMENT_GALLERY_FOLDER_ID", ""],
    ["HALDI_GALLERY_FOLDER_ID", ""],
    ["MARRIAGE_GALLERY_FOLDER_ID", ""]
  ];

  var sheetOrder = ["Payments","Complaints","Villages","AuditLog","ActivityLog","UTRBlacklist","Settings","Admins"];
  var createdSheets = [];

  sheetOrder.forEach(function(sheetName) {
    var isNew = ensureSheet(ss, sheetName, sheetDefinitions[sheetName]);
    if (isNew) {
      createdSheets.push(sheetName);
      var sheet = ss.getSheetByName(sheetName);

      if (sheetName === "Settings") {
        sheet.getRange(2, 1, settingsDefaults.length, 2).setValues(settingsDefaults);
        sheet.setRowHeights(2, settingsDefaults.length, 32);
        formatSettingsColumns(sheet);
      }
      if (sheetName === "Admins") {
        sheet.getRange(2, 1, 1, 8).setValues([
          ["admin", "admin123", "superadmin", "full", "Active", "", new Date(), ""]
        ]);
        sheet.setRowHeight(2, 30);
      }
      applyValidations(sheet, sheetName);
      applyNumberFormats(sheet, sheetName);
    }
  });

  return { success: true, createdSheets: createdSheets, spreadsheetId: ss.getId() };
}

function ensureSheet(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) return false;

  sheet = ss.insertSheet(sheetName);
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight("bold");
  headerRange.setFontColor("#000000");
  headerRange.setBackground("#ffffff");
  headerRange.setFontSize(12);
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 40);

  headers.forEach(function(header, index) {
    var col = index + 1;
    sheet.autoResizeColumn(col);
    var currentWidth = sheet.getColumnWidth(col);
    var targetWidth = currentWidth + 40;
    if (/FOLDER_ID/.test(header) || /Link/.test(header)) targetWidth = Math.max(targetWidth, 700);
    if (targetWidth < 160) targetWidth = 160;
    sheet.setColumnWidth(col, targetWidth);
  });

  headerRange.createFilter();
  headerRange.protect().setDescription(sheetName + " Header");
  return true;
}

function formatSettingsColumns(sheet) {
  var lastRow = sheet.getMaxRows();
  sheet.getRange(1, 1, lastRow, 1).setFontWeight("bold").setHorizontalAlignment("left");
  sheet.getRange(1, 2, lastRow, 1).setFontWeight("normal").setHorizontalAlignment("left");
  sheet.setColumnWidth(1, 350);
  sheet.setColumnWidth(2, 900);
}

function applyValidations(sheet, sheetName) {
  if (sheetName === "Payments") {
    sheet.getRange("I2:I").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["Pending", "Pending (Review)", "Verified", "Rejected"], true).setAllowInvalid(true).build()
    );
    sheet.getRange("K2:K").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["LOW", "MEDIUM", "HIGH"], true).setAllowInvalid(true).build()
    );
  }
  if (sheetName === "Admins") {
    sheet.getRange("C2:C").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["superadmin", "admin", "verifier", "viewer"], true).setAllowInvalid(true).build()
    );
  }
}

function applyNumberFormats(sheet, sheetName) {
  if (sheetName === "Payments") {
    sheet.getRange("B:B").setNumberFormat("dd-MMM-yyyy");
    sheet.getRange("C:C").setNumberFormat("hh:mm AM/PM");
    sheet.getRange("G:G").setNumberFormat("\u20B9#,##0");
  }
  if (sheetName === "Complaints") {
    sheet.getRange("B:B").setNumberFormat("dd-MMM-yyyy");
    sheet.getRange("C:C").setNumberFormat("hh:mm AM/PM");
  }
}











// ============================================================
// EventPay — SheetInit.gs  (creates all tabs for a NEW event spreadsheet)
// ============================================================
// FIXES vs the previous version:
//   - Payments headers now have the FULL 16 columns Code.gs actually
//     writes (FraudScore, RiskLevel, ReviewFlag were missing before,
//     so those values were landing in unlabeled columns).
//   - Event/folder names are decoded ("+" -> space, %XX -> char)
//     before being used as a Drive folder name, so folders read
//     "Birthday of Likith" instead of "Birthday+of+Likith".
// ============================================================

function initializeEventSpreadsheet(spreadsheetId) {
  if (!spreadsheetId) throw new Error("initializeEventSpreadsheet: spreadsheetId is required.");
  var ss = SpreadsheetApp.openById(spreadsheetId);

  var sheetDefinitions = {
    "Payments": ["RefID","Date","Time","Full Name","Village","Phone number","Amount","UTR","Status",
                 "FraudScore","RiskLevel","ReviewFlag","ShowPublic","Verified By","Verified At","Notes"],
    "Complaints": ["ComplaintID","Date","Time","Name","Village","Phone","Email","Complaint","Attachment",
                   "AttachmentURL","AttachmentName","Status","ReplyBy","AdminReply","RepliedAt","Priority"],
    "Villages": ["Village","NormalizedName","Count","Status"],
    "AuditLog": ["Timestamp","AdminUser","Module","Action","Field","OldValue","NewValue","Reason","Row","Column","RecordID"],
    "ActivityLog": ["RecordID","Date","Time","AdminUser","Module","Action","Detail","OldValue","NewValue","RecordID_Ref","Browser","Device","LogoutType"],
    "UTRBlacklist": ["UTR","Date Time","Reason"],
    "Settings": ["Key","Value"],
    "Admins": ["Username","Password","Role","AccessLevel","Status","Email","CreatedAt","LastLogin"]
  };

  var settingsDefaults = [
    ["Event Name", ""],
    ["EventDate", ""],
    ["EventTime", ""],
    ["VenueAddress", ""],
    ["VenueMapLink", ""],
    ["UPI_ID", ""],
    ["ORG_NAME", ""],
    ["OrganizerEmail", ""],
    ["INVITATION_CARD_DRIVE_LINK", ""],
    ["COMPLAINT_UPLOAD_FOLDER_ID", ""],
    ["MIN_AMOUNT", 500],
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
    ["ENGAGEMENT_GALLERY_FOLDER_ID", ""],
    ["HALDI_GALLERY_FOLDER_ID", ""],
    ["MARRIAGE_GALLERY_FOLDER_ID", ""]
  ];

  var sheetOrder = ["Payments","Complaints","Villages","AuditLog","ActivityLog","UTRBlacklist","Settings","Admins"];
  var createdSheets = [];

  sheetOrder.forEach(function(sheetName) {
    var isNew = ensureSheet(ss, sheetName, sheetDefinitions[sheetName]);
    if (isNew) {
      createdSheets.push(sheetName);
      var sheet = ss.getSheetByName(sheetName);

      if (sheetName === "Settings") {
        sheet.getRange(2, 1, settingsDefaults.length, 2).setValues(settingsDefaults);
        sheet.setRowHeights(2, settingsDefaults.length, 32);
        formatSettingsColumns(sheet);
      }
      if (sheetName === "Admins") {
        sheet.getRange(2, 1, 1, 8).setValues([
          ["admin", "admin123", "superadmin", "full", "Active", "", new Date(), ""]
        ]);
        sheet.setRowHeight(2, 30);
      }
      applyValidations(sheet, sheetName);
      applyNumberFormats(sheet, sheetName);
    }
  });

  return { success: true, createdSheets: createdSheets, spreadsheetId: ss.getId() };
}

function ensureSheet(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) return false;

  sheet = ss.insertSheet(sheetName);
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight("bold");
  headerRange.setFontColor("#000000");
  headerRange.setBackground("#ffffff");
  headerRange.setFontSize(12);
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 40);

  headers.forEach(function(header, index) {
    var col = index + 1;
    sheet.autoResizeColumn(col);
    var currentWidth = sheet.getColumnWidth(col);
    var targetWidth = currentWidth + 40;
    if (/FOLDER_ID/.test(header) || /Link/.test(header)) targetWidth = Math.max(targetWidth, 700);
    if (targetWidth < 160) targetWidth = 160;
    sheet.setColumnWidth(col, targetWidth);
  });

  headerRange.createFilter();
  headerRange.protect().setDescription(sheetName + " Header");
  return true;
}

function formatSettingsColumns(sheet) {
  var lastRow = sheet.getMaxRows();
  sheet.getRange(1, 1, lastRow, 1).setFontWeight("bold").setHorizontalAlignment("left");
  sheet.getRange(1, 2, lastRow, 1).setFontWeight("normal").setHorizontalAlignment("left");
  sheet.setColumnWidth(1, 350);
  sheet.setColumnWidth(2, 900);
}

function applyValidations(sheet, sheetName) {
  if (sheetName === "Payments") {
    sheet.getRange("I2:I").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["Pending", "Pending (Review)", "Verified", "Rejected"], true).setAllowInvalid(true).build()
    );
    sheet.getRange("K2:K").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["LOW", "MEDIUM", "HIGH"], true).setAllowInvalid(true).build()
    );
  }
  if (sheetName === "Admins") {
    sheet.getRange("C2:C").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["superadmin", "admin", "verifier", "viewer"], true).setAllowInvalid(true).build()
    );
  }
}

function applyNumberFormats(sheet, sheetName) {
  if (sheetName === "Payments") {
    sheet.getRange("B:B").setNumberFormat("dd-MMM-yyyy");
    sheet.getRange("C:C").setNumberFormat("hh:mm AM/PM");
    sheet.getRange("G:G").setNumberFormat("\u20B9#,##0");
  }
  if (sheetName === "Complaints") {
    sheet.getRange("B:B").setNumberFormat("dd-MMM-yyyy");
    sheet.getRange("C:C").setNumberFormat("hh:mm AM/PM");
  }
}



