 // EventPay — Sheetmaker.gs  (SINGLE unified backend, single router)
 

function initializeEventSpreadsheet(spreadsheetId) {
  if (!spreadsheetId) {
    throw new Error("initializeEventSpreadsheet: spreadsheetId is required.");
  }
  var ss = SpreadsheetApp.openById(spreadsheetId);
  
  var sheetDefinitions = {
    "Payments": ["RefID","Date","Time","Full Name","Village","Phone number","Amount","UTR","Status","Verified By","Risk Score","Notes","Show Public","Verified At"],
    "Complaints": ["ComplaintID","Date","Time","Name","Village","Phone","Email","Complaint","Attachment","AttachmentURL","AttachmentName","Status","ReplyBy","AdminReply","RepliedAt","Priority"],
    "Villages": ["Village","NormalizedName","Count","Status"],
    "AuditLog": ["Timestamp","AdminUser","Module","Action","Field","OldValue","NewValue","Reason","RowNumber","ColumnNumber"],
    "ActivityLog": ["RecordID","Date","Time","AdminUser","Action","Detail","OldValue","NewValue","Details","Duration","Browser","Device","LogoutType"],
    "UTRBlacklist": ["UTR","Date Time","Reason"],
    "Settings": ["Key","Value"],
    "Admins": ["Username","Password","Role","AccessLevel","Status","Email","CreatedAt","LastLogin"]
  };

  var settingsDefaults = [
    ["EventName", ""],
    ["EventDate", ""],
    ["EventTime", ""],
    ["VenueAddress", ""],
    ["VenueMapLink", ""],
    ["UPI_ID", ""],
    ["ORG_NAME", ""],
    ["OrganizerEmail", ""],
    ["INVITATION_CARD_DRIVE_LINK", ""],
    ["EVENT_GALLERY_FOLDER_ID", ""],
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

  // Maps Settings key -> Drive folder name to create
  var folderKeyToName = {
    "EVENT_GALLERY_FOLDER_ID": "Event Gallery",
    "ENGAGEMENT_GALLERY_FOLDER_ID": "Engagement Gallery",
    "HALDI_GALLERY_FOLDER_ID": "Haldi Gallery",
    "MARRIAGE_GALLERY_FOLDER_ID": "Marriage Gallery",
    "COMPLAINT_UPLOAD_FOLDER_ID": "Complaint Upload"
  };

  // Custom column widths (px) per sheet/header. Anything not listed falls
  // back to auto-resize + 40px padding, with a 160px minimum floor.
  var columnWidthOverrides = {
    "Complaints": {
      "Complaint": 500,
      "AttachmentURL": 550,
      "AdminReply": 450,
      "Email": 300,
      "Name": 220,
      "Phone": 180
    },
    "Payments": {
      "Full Name": 220,
      "Phone number": 180
    },
    "Settings": {
      "Key": 350,
      "Value": 900
    }
  };
  // Any header containing these substrings gets the wide "Folder ID" / "Link" treatment
  var wideHeaderPatterns = [
    { match: "FOLDER_ID", width: 700 },
    { match: "Link", width: 800 }
  ];

  var sheetOrder = ["Payments","Complaints","Villages","AuditLog","ActivityLog","UTRBlacklist","Settings","Admins"];
  var createdSheets = [];

  sheetOrder.forEach(function(sheetName) {
    var isNew = ensureSheet(ss, sheetName, sheetDefinitions[sheetName], columnWidthOverrides[sheetName]);

    if (isNew) {
      createdSheets.push(sheetName);
      var sheet = ss.getSheetByName(sheetName);

      if (sheetName === "Settings") {
        sheet.getRange(2, 1, settingsDefaults.length, 2).setValues(settingsDefaults);
        sheet.setRowHeights(2, settingsDefaults.length, 32);
        formatSettingsColumns(sheet);
        createEventFolders(ss, sheet, folderKeyToName);
        applyWideHeaderWidths(sheet, sheetDefinitions["Settings"], wideHeaderPatterns);
      }

      if (sheetName === "Admins") {
        sheet.getRange(2, 1, 1, 8).setValues([
          ["admin", "admin123", "superadmin", "full", "Active", "", new Date(), ""]
        ]);
        sheet.setRowHeight(2, 30);
      }

      applyValidations(sheet, sheetName);
      applyNumberFormats(sheet, sheetName);
      applyWideHeaderWidths(sheet, sheetDefinitions[sheetName], wideHeaderPatterns);
    }
  });

  return {
    success: true,
    createdSheets: createdSheets,
    spreadsheetId: ss.getId()
  };
}

function ensureSheet(ss, sheetName, headers, widthOverrides) {
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    return false;
  }

  sheet = ss.insertSheet(sheetName);
  var headerRange = sheet.getRange(1, 1, 1, headers.length);

  headerRange.setValues([headers]);
  headerRange.setFontWeight("bold");
  headerRange.setFontColor("#000000");
  headerRange.setBackground("#ffffff");
  headerRange.setFontSize(12);
  headerRange.setBorder(false, false, false, false, false, false);

  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 40);

  headers.forEach(function(header, index) {
    var col = index + 1;
    sheet.autoResizeColumn(col);
    var currentWidth = sheet.getColumnWidth(col);
    var targetWidth = currentWidth + 40;

    if (widthOverrides && widthOverrides[header] !== undefined) {
      targetWidth = widthOverrides[header];
    } else if (targetWidth < 160) {
      targetWidth = 160;
    }

    sheet.setColumnWidth(col, targetWidth);
  });

  headerRange.createFilter();
  headerRange.protect().setDescription(sheetName + " Header");

  return true;
}

function applyWideHeaderWidths(sheet, headers, wideHeaderPatterns) {
  headers.forEach(function(header, index) {
    var col = index + 1;
    for (var i = 0; i < wideHeaderPatterns.length; i++) {
      if (header.indexOf(wideHeaderPatterns[i].match) !== -1) {
        sheet.setColumnWidth(col, wideHeaderPatterns[i].width);
        break;
      }
    }
  });
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
    var statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["Pending", "Verified", "Rejected"], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange("I2:I").setDataValidation(statusRule);

    var riskRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["LOW", "MEDIUM", "HIGH"], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange("K2:K").setDataValidation(riskRule);
  }

  if (sheetName === "Admins") {
    var roleRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["superadmin", "admin", "verifier", "viewer"], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange("C2:C").setDataValidation(roleRule);
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

function createEventFolders(ss, settingsSheet, folderKeyToName) {
  var rootFolder = DriveApp.createFolder(ss.getName() + " - EventPay Media");
  var keyToRow = {};
  var data = settingsSheet.getRange(2, 1, settingsSheet.getLastRow() - 1, 1).getValues();

  data.forEach(function(row, index) {
    keyToRow[row[0]] = index + 2;
  });

  Object.keys(folderKeyToName).forEach(function(key) {
    if (keyToRow[key]) {
      var folder = rootFolder.createFolder(folderKeyToName[key]);
      settingsSheet.getRange(keyToRow[key], 2).setValue(folder.getId());
    }
  });
}
