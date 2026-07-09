// ============================================================ Multi Event.gs file 
// ============================================================
// TWO MODES:
//   1) No "sid" param → reads from MASTER_SPREADSHEET_ID (Events list)
//   2) "sid" param    → reads from that per-event SpreadsheetID
// ============================================================

const MASTER_SPREADSHEET_ID = "1vFZBJrguPeFMsgzLjHM_yEdA12LinoK4zXXPFHofPkY";



// ============================================================
// OPEN SPREADSHEET — master or per-event
// ============================================================
function openSS(sid) {
  const id = sid && sid.trim() ? sid.trim() : MASTER_SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

// ============================================================
// MASTER — EVENTS LIST
// ============================================================
function getEvents() {
  const ss    = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
  const sheet = ss.getSheetByName("Events");
  if (!sheet) return { events: [], error: "Events sheet not found" };
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return { events: [] };
  const headers = data[0].map(h => String(h).trim());
  const events  = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;   // skip empty rows
    const row = {};
    headers.forEach((h, j) => { row[h] = data[i][j]; });
    // Build Script URL from ScriptURL column or construct from MASTER + sid
    if (!row.ScriptURL && row.SpreadsheetID) {
      // Frontend will append &sid=SpreadsheetID to MASTER_URL
      row.ScriptURL = "";   // will be constructed in frontend
    }
    events.push(row);
  }
  return { events };
}

function addEvent(p) {
  const ss    = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
  const sheet = ss.getSheetByName("Events");
  if (!sheet) throw new Error("Events sheet not found");
  const n = nowFormatted();
  sheet.appendRow([
    p.EventID    || "WED" + Date.now().toString().slice(-6),
    p.EventCode  || "",
    p.EventType  || "Wedding",
    p.EventName  || "",
    p.SpreadsheetID || "",
    p.OrganizerName || "",
    p.OrganizerPhone || "",
    "Active",
    n.date,
    n.date,
    "",
    p.BrideName  || "",
    p.GroomName  || "",
    p.EventDate  || "",
    p.ScriptURL  || "",
    p.UpiID      || ""
  ]);
  return { result: "Added" };
}

function updateEvent(p) {
  const ss    = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
  const sheet = ss.getSheetByName("Events");
  const data  = sheet.getDataRange().getValues();
  const row   = parseInt(p.row);
  if (row < 2) throw new Error("Invalid row");
  if (p.field && p.value !== undefined) {
    const headers = data[0].map(h => String(h).trim());
    const col = headers.indexOf(p.field);
    if (col >= 0) sheet.getRange(row, col + 1).setValue(p.value);
  }
  return { result: "Updated" };
}

function masterLogin(p) {
  // Simple master admin check (uses master spreadsheet Admins tab if exists)
  const ss    = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
  const sheet = ss.getSheetByName("MasterAdmins") || ss.getSheetByName("Admins");
  if (!sheet) return { success: false, error: "Admin sheet not found" };
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === p.username && String(data[i][1]).trim() === p.password) {
      const token  = Utilities.getUuid();
      const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1hr
      return { success: true, token, expiry, role: data[i][2] || "masteradmin" };
    }
  }
  return { success: false };
}

// ============================================================
// HELPERS
// ============================================================
function nowFormatted() {
  const tz  = Session.getScriptTimeZone(), now = new Date();
  return {
    date: Utilities.formatDate(now, tz, "dd-MMM-yyyy"),
    time: Utilities.formatDate(now, tz, "hh:mm a"),
    full: Utilities.formatDate(now, tz, "dd-MMM-yyyy hh:mm:ss"),
    iso:  now.toISOString()
  };
}
function serializeVal(val, key) {
  if (!(val instanceof Date)) return val;
  const tz = Session.getScriptTimeZone(), k = String(key||'').toLowerCase().trim();
  if (val.getFullYear() <= 1900) return Utilities.formatDate(val, tz, "hh:mm a");
  if (k === 'date')              return Utilities.formatDate(val, tz, "dd-MMM-yyyy");
  if (k === 'time')              return Utilities.formatDate(val, tz, "hh:mm a");
  return Utilities.formatDate(val, tz, "dd-MMM-yyyy hh:mm a");
}
function getColMap(headers) {
  const m = {};
  headers.forEach((h,i) => { if(h) m[String(h).trim().toLowerCase()] = i; });
  return m;
}
function extractFolderID(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/); if(m) return m[1];
  const f = s.match(/\/d\/([a-zA-Z0-9_-]+)/);       if(f) return f[1];
  return s;
}
function levenshtein(a, b) {
  const m=a.length,n=b.length,dp=[];
  for(let i=0;i<=m;i++){dp[i]=[i];for(let j=1;j<=n;j++)dp[i][j]=0;}
  for(let j=0;j<=n;j++)dp[0][j]=j;
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}
function verifyAdmin(params) {
  if (!params.adminToken) throw new Error("Unauthorized");
  if (params.adminExpiry && new Date() > new Date(params.adminExpiry)) throw new Error("Session expired");
}

// ============================================================
// SETTINGS (per-event)
// ============================================================
function getSettings(sid) {
  const ss    = openSS(sid);
  const sheet = ss.getSheetByName("Settings");
  if (!sheet) return {};
  const data  = sheet.getDataRange().getValues();
  const obj   = {};
  data.forEach(r => { if(r[0]) obj[String(r[0]).trim()] = r[1]; });
  return obj;
}
function getPublicVisibility(sid) {
  const s = getSettings(sid);
  const isActive = k => String(s[k]||"ACTIVE").toUpperCase().trim() === "ACTIVE";
  return {
    showDonorList:         isActive("SHOW_DONOR_LIST"),
    showStatistics:        isActive("SHOW_STATISTICS"),
    showGallery:           isActive("SHOW_GALLERY"),
    showInviteCard:        isActive("SHOW_INVITE_CARD"),
    showRecentPayments:    isActive("SHOW_RECENT_PAYMENTS"),
    showEngagementGallery: isActive("SHOW_ENGAGEMENT_GALLERY"),
    showHaldiGallery:      isActive("SHOW_HALDI_GALLERY"),
    showMarriageGallery:   isActive("SHOW_MARRIAGE_GALLERY"),
    allowDownloadAll:      isActive("ALLOW_DOWNLOAD_ALL"),
    allowSectionDownload:  isActive("ALLOW_SECTION_DOWNLOAD")
  };
}
function updateSettings(p, sid) {
  verifyAdmin(p);
  const ss    = openSS(sid);
  const sheet = ss.getSheetByName("Settings");
  if (!sheet) throw new Error("Settings sheet not found");
  const data  = sheet.getDataRange().getValues();
  const updates = JSON.parse(p.updates || '{}');
  Object.keys(updates).forEach(key => {
    let found = false;
    for(let i=0;i<data.length;i++){
      if(String(data[i][0]).trim()===key){ sheet.getRange(i+1,2).setValue(updates[key]); found=true; break; }
    }
    if(!found) sheet.appendRow([key, updates[key]]);
  });
  logActivity({adminUser:p.adminUser,module:"Settings",action:"Update",detail:"Updated "+Object.keys(updates).length+" settings"},sid);
  return { result:"Saved" };
}

// ============================================================
// ADMIN LOGIN (per-event)
// ============================================================
function loginAdmin(p, sid) {
  const ss    = openSS(sid);
  const sheet = ss.getSheetByName("Admins");
  if (!sheet) return { success:false, error:"Admins sheet not found" };
  const data  = sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    const u=String(data[i][0]).trim(), pw=String(data[i][1]).trim();
    if(u===p.username && pw===p.password){
      const token  = Utilities.getUuid();
      const s      = getSettings(sid);
      const timeout= parseInt(s.SessionTimeoutMinutes)||30;
      const expiry = new Date(Date.now()+timeout*60*1000).toISOString();
      logActivity({adminUser:p.username,module:"Auth",action:"Login",detail:"Successful login"},sid);
      return { success:true, role:data[i][2]||"admin", token, expiry };
    }
  }
  return { success:false };
}

// ============================================================
// PAYMENTS
// ============================================================
function getPublicStats(sid) {
  const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
  if(!sheet||sheet.getLastRow()<2) return {total:0,count:0,pending:0};
  const data=sheet.getDataRange().getValues(), col=getColMap(data[0]);
  const aC=col["amount"]!==undefined?col["amount"]:6, sC=col["status"]!==undefined?col["status"]:8;
  let total=0,count=0,pending=0;
  for(let i=1;i<data.length;i++){
    const st=String(data[i][sC]||'').trim(), a=Number(data[i][aC])||0;
    if(st==="Verified"){total+=a;count++}
    if(st.startsWith("Pending")) pending++;
  }
  return {total,count,pending};
}

function insertPayment(p, sid) {
  const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
  if(!sheet) throw new Error("Payments sheet not found");
  const data=sheet.getDataRange().getValues(), col=getColMap(data[0]);
  const phoneC=col["phone number"]!==undefined?col["phone number"]:(col["phone"]!==undefined?col["phone"]:5);
  const s=getSettings(sid);
  const maxAmt=parseFloat(s.MAX_AMOUNT)||0, minAmt=parseFloat(s.MIN_AMOUNT)||50;
  const amt=Number(p.amount)||0;
  if(maxAmt>0&&amt>maxAmt) return {result:"AmountExceedsMax",maxAmount:maxAmt,message:"Maximum contribution amount is ₹"+maxAmt.toLocaleString("en-IN")};
  if(amt<minAmt) return {result:"AmountBelowMin",minAmount:minAmt,message:"Minimum contribution amount is ₹"+minAmt.toLocaleString("en-IN")};
  for(let i=1;i<data.length;i++){
    if(String(data[i][phoneC]).trim()===String(p.phone).trim()) return {result:"DuplicatePhone"};
  }
  const utrCheck=validateUTR({utr:p.utr,phone:p.phone},sid);
  if(utrCheck.block) return {result:"DuplicateUTR",message:(utrCheck.flags||[]).join(", "),risk:utrCheck.risk};
  const n=nowFormatted();
  const status=utrCheck.risk==="MEDIUM"?"Pending (Review)":"Pending";
  sheet.appendRow([p.refid,n.date,n.time,p.name,p.village,p.phone,Number(p.amount),p.utr,status,utrCheck.score,utrCheck.risk,"",utrCheck.risk==="MEDIUM"?"Review":"","","",""]);
  addVillageInternal(p.village, sid);
  try{if(s.OrganizerEmail)MailApp.sendEmail({to:String(s.OrganizerEmail),subject:"💰 New: "+p.name+" ₹"+p.amount,body:"Name: "+p.name+"\nPhone: "+p.phone+"\nAmount: ₹"+p.amount+"\nUTR: "+p.utr+"\nRisk: "+utrCheck.risk+"\nRef: "+p.refid})}catch(e){}
  return {result:"Inserted",riskLevel:utrCheck.risk};
}

function getPublicPayments(sid) {
  const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
  if(!sheet||sheet.getLastRow()<2) return {donors:[]};
  const data=sheet.getDataRange().getValues(), col=getColMap(data[0]);
  const nC=col["full name"]!==undefined?col["full name"]:(col["name"]!==undefined?col["name"]:3);
  const aC=col["amount"]!==undefined?col["amount"]:6, sC=col["status"]!==undefined?col["status"]:8;
  const spC=col["showpublic"]!==undefined?col["showpublic"]:12, dC=col["date"]!==undefined?col["date"]:1;
  const donors=[];
  for(let i=1;i<data.length;i++){
    if(String(data[i][sC]).trim()==="Verified"&&String(data[i][spC]).trim()!=="No")
      donors.push({name:data[i][nC],amount:Number(data[i][aC])||0,date:serializeVal(data[i][dC],'date')});
  }
  donors.sort((a,b)=>b.amount-a.amount);
  return {donors};
}

function getRecentTransactions(sid) {
  const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
  if(!sheet||sheet.getLastRow()<2) return {transactions:[]};
  const data=sheet.getDataRange().getValues(), col=getColMap(data[0]);
  const nC=col["full name"]!==undefined?col["full name"]:(col["name"]!==undefined?col["name"]:3);
  const vC=col["village"]!==undefined?col["village"]:4, aC=col["amount"]!==undefined?col["amount"]:6;
  const sC=col["status"]!==undefined?col["status"]:8, dC=col["date"]!==undefined?col["date"]:1;
  const spC=col["showpublic"]!==undefined?col["showpublic"]:12;
  const tx=[];
  for(let i=1;i<data.length;i++){
    if(String(data[i][sC]).trim()==="Verified"&&String(data[i][spC]).trim()!=="No")
      tx.push({name:data[i][nC],village:data[i][vC],amount:Number(data[i][aC])||0,date:serializeVal(data[i][dC],'date')});
  }
  tx.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  return {transactions:tx.slice(0,10)};
}

function checkStatus(p, sid) {
  const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
  if(!sheet||sheet.getLastRow()<2) return {found:false};
  const data=sheet.getDataRange().getValues(), col=getColMap(data[0]);
  const C={refid:col["refid"]!==undefined?col["refid"]:0,date:col["date"]!==undefined?col["date"]:1,time:col["time"]!==undefined?col["time"]:2,name:col["full name"]!==undefined?col["full name"]:(col["name"]!==undefined?col["name"]:3),village:col["village"]!==undefined?col["village"]:4,phone:col["phone number"]!==undefined?col["phone number"]:(col["phone"]!==undefined?col["phone"]:5),amount:col["amount"]!==undefined?col["amount"]:6,utr:col["utr"]!==undefined?col["utr"]:7,status:col["status"]!==undefined?col["status"]:8};
  const type=p.searchType||"refid", val=String(p.searchVal||p.refid||'').trim();
  for(let i=1;i<data.length;i++){
    let match=false;
    if(type==="phone") match=String(data[i][C.phone]).trim()===val;
    else if(type==="utr") match=String(data[i][C.utr]).trim()===val;
    else match=String(data[i][C.refid]).trim().slice(-5)===val;
    if(match) return {found:true,refid:data[i][C.refid],date:serializeVal(data[i][C.date],'date'),time:serializeVal(data[i][C.time],'time'),name:data[i][C.name],village:data[i][C.village],amount:data[i][C.amount],status:data[i][C.status]};
  }
  return {found:false};
}

function getPayments(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
  if(!sheet) return {payments:[]};
  const data=sheet.getDataRange().getValues(), headers=data[0], rows=[];
  for(let i=1;i<data.length;i++){
    const row={_row:i+1};
    headers.forEach((h,j)=>{if(h)row[String(h).trim()]=serializeVal(data[i][j],h)});
    row.Name=row["Full Name"]||row["Name"]||""; row.Phone=row["Phone number"]||row["Phone"]||"";
    row.RefID=row["RefID"]||""; row.RiskLevel=row["RiskLevel"]||"LOW"; row.FraudScore=row["FraudScore"]||0;
    rows.push(row);
  }
  return {payments:rows};
}

function updatePayments(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
  const data=sheet.getDataRange().getValues(), col=getColMap(data[0]);
  const n=nowFormatted();
  const stC=(col["status"]!==undefined?col["status"]:8)+1;
  const vbC=(col["verified by"]!==undefined?col["verified by"]:13)+1;
  const vaC=(col["verifiedat"]!==undefined?col["verifiedat"]:14)+1;
  const updates=JSON.parse(p.updates);
  updates.forEach(u=>{
    const oldSt=sheet.getRange(u.row,stC).getValue();
    sheet.getRange(u.row,stC).setValue(u.status);
    sheet.getRange(u.row,vbC).setValue(p.adminUser||"admin");
    sheet.getRange(u.row,vaC).setValue(n.full);
    logAudit({adminUser:p.adminUser,module:"Payments",action:"StatusChange",field:"Status",oldValue:String(oldSt),newValue:u.status,row:u.row,column:stC},sid);
  });
  logActivity({adminUser:p.adminUser,module:"Payments",action:"UpdateStatus",detail:updates.length+" records"},sid);
  return {result:"Saved"};
}

function updatePublicDisplay(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
  const data=sheet.getDataRange().getValues(), col=getColMap(data[0]);
  const spC=(col["showpublic"]!==undefined?col["showpublic"]:12)+1;
  sheet.getRange(parseInt(p.row),spC).setValue(p.showPublic);
  return {result:"Updated"};
}

// ============================================================
// UTR VALIDATION
// ============================================================
function validateUTR(p, sid) {
  const utr=String(p.utr||'').trim();
  if(!utr) return {valid:false,risk:"HIGH",score:100,flags:["Empty UTR"],block:true};
  const s=getSettings(sid);
  const highT=parseInt(s.FRAUD_THRESHOLD_HIGH)||70, medT=parseInt(s.FRAUD_THRESHOLD_MEDIUM)||40;
  let score=0; const flags=[];
  if(isUTRBlacklisted(utr,sid)) return {valid:false,risk:"HIGH",score:100,flags:["UTR blacklisted"],block:true};
  if(!/^\d+$/.test(utr)){score+=35;flags.push("Non-numeric")}
  if(utr.length<10){score+=30;flags.push("Too short")}
  if(utr.length>22){score+=15;flags.push("Too long")}
  if(/^(.)\1+$/.test(utr)){score+=45;flags.push("All identical digits")}
  const testVals=["123456789012","000000000000","111111111111","999999999999","123123123123"];
  if(testVals.includes(utr)){score+=50;flags.push("Known test value")}
  try{
    const ss=openSS(sid), sheet=ss.getSheetByName("Payments");
    if(sheet&&sheet.getLastRow()>1){
      const data=sheet.getDataRange().getValues(), col=getColMap(data[0]);
      const utrC=col["utr"]!==undefined?col["utr"]:7;
      for(let i=Math.max(1,data.length-300);i<data.length;i++){
        const eu=String(data[i][utrC]||'').trim();
        if(!eu) continue;
        if(eu===utr) return {valid:false,risk:"HIGH",score:100,flags:["Exact duplicate UTR"],block:true};
        if(eu.length>=10&&utr.length>=10){const d=levenshtein(utr,eu);if(d<=1){score+=50;flags.push("Nearly identical UTR")}else if(d<=2){score+=25;flags.push("Similar UTR")}}
      }
    }
  }catch(e){}
  score=Math.min(score,100);
  const risk=score>=highT?"HIGH":score>=medT?"MEDIUM":"LOW";
  return {valid:score<highT,risk,score,flags,block:score>=highT};
}

function isUTRBlacklisted(utr, sid) {
  try{
    const ss=openSS(sid), sheet=ss.getSheetByName("UTRBlacklist");
    if(!sheet) return false;
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++) if(String(data[i][0]).trim()===utr) return true;
  }catch(e){}
  return false;
}

function addUTRBlacklist(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("UTRBlacklist");
  if(!sheet) throw new Error("UTRBlacklist sheet not found");
  sheet.appendRow([p.utr,nowFormatted().full,p.reason||"Blacklisted by "+p.adminUser]);
  return {result:"Blacklisted"};
}
function getUTRBlacklist(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("UTRBlacklist");
  if(!sheet) return {list:[]};
  const data=sheet.getDataRange().getValues(), list=[];
  for(let i=1;i<data.length;i++) if(data[i][0]) list.push({utr:data[i][0],addedAt:serializeVal(data[i][1],'date'),reason:data[i][2]});
  return {list};
}

// ============================================================
// VILLAGES
// ============================================================
function getVillageSuggestions(sid) {
  const ss=openSS(sid), sheet=ss.getSheetByName("Villages");
  if(!sheet) return {villages:[]};
  const data=sheet.getDataRange().getValues(), villages=[];
  for(let i=1;i<data.length;i++){
    const v=String(data[i][0]||'').trim(), status=String(data[i][3]||'Active').trim();
    if(v&&status.toLowerCase()!=='inactive') villages.push(v);
  }
  return {villages:[...new Set(villages)].sort()};
}
function addVillageInternal(name, sid) {
  if(!name) return;
  try{
    const ss=openSS(sid), sheet=ss.getSheetByName("Villages");
    if(!sheet) return;
    const data=sheet.getDataRange().getValues(), norm=name.trim().toLowerCase();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0]).trim().toLowerCase()===norm){sheet.getRange(i+1,3).setValue(parseInt(data[i][2]||0)+1);return}
    }
    sheet.appendRow([name.trim(),norm,1,"Active"]);
  }catch(e){}
}
function addVillageSuggestion(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("Villages");
  if(!sheet) throw new Error("Villages sheet not found");
  const data=sheet.getDataRange().getValues(), norm=p.village.trim().toLowerCase();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0]).trim().toLowerCase()===norm){sheet.getRange(i+1,3).setValue(parseInt(data[i][2]||0)+1);return{result:"Updated"}}
  }
  sheet.appendRow([p.village.trim(),norm,1,"Active"]);
  return {result:"Added"};
}

// ============================================================
// COMPLAINTS
// ============================================================
function insertComplaint(p, sid) {
  const ss=openSS(sid), sheet=ss.getSheetByName("Complaints");
  if(!sheet) throw new Error("Complaints sheet not found");
  const n=nowFormatted();
  let fileUrl="",fileStatus="None";
  if(p.filedata&&p.filename){
    try{
      const s=getSettings(sid), folderID=extractFolderID(s.COMPLAINT_UPLOAD_FOLDER_ID)||"";
      if(folderID){
        const folder=DriveApp.getFolderById(folderID);
        const decoded=Utilities.base64Decode(p.filedata);
        const blob=Utilities.newBlob(decoded,p.filetype||"application/octet-stream",p.filename);
        const file=folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK,DriveApp.Permission.VIEW);
        fileUrl="https://drive.google.com/file/d/"+file.getId()+"/view";
        fileStatus="Attached";
      }
    }catch(e){fileStatus="Error: "+e.message}
  }
  const cID="CP"+Date.now().toString().slice(-8);
  sheet.appendRow([cID,n.date,n.time,p.name,p.village,p.phone,p.email,p.complaint,fileStatus,fileUrl,p.filename||"","Open","","","",""]);
  try{const s=getSettings(sid);if(s.OrganizerEmail)MailApp.sendEmail({to:String(s.OrganizerEmail),subject:"📋 Complaint: "+p.name,body:"ID: "+cID+"\nName: "+p.name+"\nComplaint:\n"+p.complaint})}catch(e){}
  return {result:"Inserted",complaintID:cID};
}
function getComplaints(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("Complaints");
  if(!sheet) return {complaints:[]};
  const data=sheet.getDataRange().getValues(), headers=data[0], rows=[];
  for(let i=1;i<data.length;i++){const row={_row:i+1};headers.forEach((h,j)=>{if(h)row[String(h).trim()]=serializeVal(data[i][j],h)});rows.push(row)}
  return {complaints:rows};
}
function updateComplaint(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("Complaints");
  const data=sheet.getDataRange().getValues(), col=getColMap(data[0]), n=nowFormatted();
  const stC=(col["status"]!==undefined?col["status"]:11)+1;
  const rbC=(col["replyby"]!==undefined?col["replyby"]:12)+1;
  const arC=(col["adminreply"]!==undefined?col["adminreply"]:13)+1;
  const raC=(col["repliedat"]!==undefined?col["repliedat"]:14)+1;
  sheet.getRange(parseInt(p.row),stC).setValue(p.status);
  sheet.getRange(parseInt(p.row),rbC).setValue(p.adminUser||"admin");
  sheet.getRange(parseInt(p.row),arC).setValue(p.reply);
  sheet.getRange(parseInt(p.row),raC).setValue(n.full);
  logActivity({adminUser:p.adminUser,module:"Complaints",action:"Reply",detail:"Replied to complaint"},sid);
  return {result:"Updated"};
}

// ============================================================
// GALLERY
// ============================================================
function getGalleryImages(sid) {
  try{
    const s=getSettings(sid);
    function getFolderImages(fid,section){
      if(!fid) return [];
      try{
        const folder=DriveApp.getFolderById(fid), files=folder.getFiles(), imgs=[];
        while(files.hasNext()){
          const f=files.next();
          if(f.getMimeType().startsWith("image/")){
            try{f.setSharing(DriveApp.Access.ANYONE_WITH_LINK,DriveApp.Permission.VIEW)}catch(e){}
            imgs.push({id:f.getId(),name:f.getName(),section,url:"https://drive.google.com/uc?id="+f.getId(),thumb:"https://drive.google.com/thumbnail?id="+f.getId()+"&sz=w400"});
          }
        }
        return imgs;
      }catch(e){return []}
    }
    const eng=getFolderImages(extractFolderID(s.ENGAGEMENT_GALLERY_FOLDER_ID),"Engagement");
    const hld=getFolderImages(extractFolderID(s.HALDI_GALLERY_FOLDER_ID),"Haldi");
    const mar=getFolderImages(extractFolderID(s.MARRIAGE_GALLERY_FOLDER_ID),"Marriage");
    return {images:[...eng,...hld,...mar],sections:{engagement:eng,haldi:hld,marriage:mar}};
  }catch(e){return {images:[],sections:{},error:e.message}}
}

// ============================================================
// AUDIT + ACTIVITY LOGS
// ============================================================
function logActivity(p, sid) {
  try{
    const ss=openSS(sid); let sheet=ss.getSheetByName("ActivityLog");
    if(!sheet){sheet=ss.insertSheet("ActivityLog");sheet.appendRow(["RecordID","Date","Time","AdminUser","Module","Action","Detail"])}
    const n=nowFormatted();
    sheet.appendRow(["AL"+Date.now().toString().slice(-8),n.date,n.time,p.adminUser||"",p.module||"",p.action||"",p.detail||""]);
  }catch(e){}
  return {result:"Logged"};
}
function getActivity(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("ActivityLog");
  if(!sheet) return {activities:[]};
  const data=sheet.getDataRange().getValues(), rows=[], col=getColMap(data[0]);
  for(let i=Math.max(1,data.length-100);i<data.length;i++){
    rows.push({date:serializeVal(data[i][col["date"]!==undefined?col["date"]:1],'date'),time:serializeVal(data[i][col["time"]!==undefined?col["time"]:2],'time'),user:data[i][col["adminuser"]!==undefined?col["adminuser"]:3],module:data[i][col["module"]!==undefined?col["module"]:4],action:data[i][col["action"]!==undefined?col["action"]:5],detail:data[i][col["detail"]!==undefined?col["detail"]:6]||""});
  }
  return {activities:rows.reverse()};
}
function logAudit(p, sid) {
  try{
    const ss=openSS(sid); let sheet=ss.getSheetByName("AuditLog");
    if(!sheet){sheet=ss.insertSheet("AuditLog");sheet.appendRow(["Timestamp","AdminUser","Module","Action","Field","OldValue","NewValue","Reason","Row","Column"])}
    sheet.appendRow([nowFormatted().full,p.adminUser||"",p.module||"",p.action||"",p.field||"",p.oldValue||"",p.newValue||"",p.reason||"",p.row||"",p.column||""]);
  }catch(e){}
}
function getAuditLog(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName("AuditLog");
  if(!sheet) return {logs:[]};
  const data=sheet.getDataRange().getValues(), logs=[], limit=parseInt(p.limit)||100;
  for(let i=Math.max(1,data.length-limit);i<data.length;i++){
    logs.push({timestamp:String(data[i][0]),user:data[i][1],module:data[i][2],action:data[i][3],field:data[i][4],oldValue:data[i][5],newValue:data[i][6],reason:data[i][7],row:data[i][8],column:data[i][9]});
  }
  return {logs:logs.reverse()};
}

// ============================================================
// SHEET EDITOR
// ============================================================
function getSheetsList(p, sid) {
  verifyAdmin(p);
  return {sheets:openSS(sid).getSheets().map(s=>s.getName())};
}
function getSheetData(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName(p.sheetName);
  if(!sheet) return {error:"Sheet not found"};
  const data=sheet.getDataRange().getValues();
  return {data,rows:data.length,cols:data[0]?data[0].length:0,sheetName:p.sheetName};
}
function updateSheetCell(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName(p.sheetName);
  if(!sheet) throw new Error("Sheet not found");
  const row=parseInt(p.row), col=parseInt(p.col);
  if(row<2) throw new Error("Cannot edit header row");
  const oldVal=sheet.getRange(row,col).getValue();
  sheet.getRange(row,col).setValue(p.value);
  const headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  logAudit({adminUser:p.adminUser,module:"Sheet:"+p.sheetName,action:"CellEdit",field:headers[col-1]||("Col "+col),oldValue:String(oldVal),newValue:String(p.value),row,column:col},sid);
  return {result:"Updated"};
}
function addSheetRow(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName(p.sheetName);
  if(!sheet) throw new Error("Sheet not found");
  const headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const rowData=JSON.parse(p.rowData||"[]");
  const finalRow=Array(headers.length).fill("").map((v,i)=>rowData[i]!==undefined?rowData[i]:"");
  sheet.appendRow(finalRow);
  logAudit({adminUser:p.adminUser,module:"Sheet:"+p.sheetName,action:"AddRow",field:"row",oldValue:"",newValue:JSON.stringify(finalRow),row:sheet.getLastRow(),column:1},sid);
  return {result:"Added",row:sheet.getLastRow()};
}
function deleteSheetRow(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), sheet=ss.getSheetByName(p.sheetName);
  if(!sheet) throw new Error("Sheet not found");
  const row=parseInt(p.row);
  if(row<2) throw new Error("Cannot delete header row");
  const oldData=sheet.getRange(row,1,1,sheet.getLastColumn()).getValues()[0];
  sheet.deleteRow(row);
  logAudit({adminUser:p.adminUser,module:"Sheet:"+p.sheetName,action:"DeleteRow",field:"row "+row,oldValue:JSON.stringify(oldData),newValue:"",row,column:1},sid);
  return {result:"Deleted"};
}
function undoActions(p, sid) {
  verifyAdmin(p);
  const ss=openSS(sid), auditSheet=ss.getSheetByName("AuditLog");
  if(!auditSheet) return {result:"NoAuditLog",undone:0};
  const data=auditSheet.getDataRange().getValues(), now=new Date();
  let cutoff=null;
  if(p.scope==="1hour") cutoff=new Date(now-3600*1000);
  if(p.scope==="24hour") cutoff=new Date(now-86400*1000);
  if(p.scope==="7days") cutoff=new Date(now-7*86400*1000);
  let undone=0;
  for(let i=data.length-1;i>=1;i--){
    if(p.scope==="last"&&undone>=1) break;
    const ts=new Date(String(data[i][0]));
    if(cutoff&&ts<cutoff) break;
    const entry={module:data[i][2],action:data[i][3],field:data[i][4],oldValue:data[i][5],row:data[i][8],column:data[i][9]};
    try{
      if(entry.module==="Payments"&&entry.action==="StatusChange"){
        const ps=ss.getSheetByName("Payments");
        if(ps&&entry.row&&entry.column) ps.getRange(parseInt(entry.row),parseInt(entry.column)).setValue(entry.oldValue);
        undone++;
      }
    }catch(e){}
  }
  return {result:"Done",undone};
}





