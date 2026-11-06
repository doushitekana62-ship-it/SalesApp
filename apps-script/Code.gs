/**
 * SalesApp backend — bound to the Google Spreadsheet.
 * Deploy as Web App: Execute as spreadsheet owner.
 * Browser requests connect directly to this Web App using a simple text/plain POST.
 */
const SA = Object.freeze({
  INQUIRY_SHEET: "Inquiry sheet",
  USERS_SHEET: "USERS",
  LOG_SHEET: "ACTIVITY_LOG",
  USERS_HEADER_SCAN_ROWS: 20,
  DASHBOARD_CACHE_SECONDS: 15,
  INQUIRY_FIRST_ROW: 7,
  SESSION_TTL_SECONDS: 21600
});

function doGet(e) {
  // Public health check only; never return business data from GET/JSONP.
  return json_({ ok: true, data: { service: "SalesApp API", status: "online", corsTest: true } });
}

function doPost(e) {
  const started = Date.now();
  let action = "";
  try {
    const payload = JSON.parse(e && e.postData && e.postData.contents || "{}");
    action = String(payload.action || "");
    let data;
    if (action === "ping") data = { service: "SalesApp API", status: "online", timestamp: new Date().toISOString() };
    else if (action === "loginChallenge") data = beginLogin_(payload);
    else if (action === "loginVerify") data = completeLogin_(payload);
    else if (action === "me") data = requireSession_(payload.sessionToken);
    else if (action === "logout") data = logout_(payload);
    else if (action === "dashboard") data = dashboard_(payload);
    else if (action === "inquiryDetail") data = inquiryDetail_(payload);
    else throw new Error("Aksi tidak dikenal.");
    return json_({ ok: true, data: data, meta: { action: action, serverMs: Date.now() - started } });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err), meta: { action: action, serverMs: Date.now() - started } });
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("SalesApp Owner")
    .addItem("Set / Reset Password User", "ownerSetUserPassword")
    .addToUi();
}

/** Owner-only password entry. Password is never written to a visible cell. */
function ownerSetUserPassword() {
  const props = PropertiesService.getScriptProperties();
  const ownerEmail = String(props.getProperty("OWNER_EMAIL") || "").toLowerCase();
  const activeEmail = String(Session.getActiveUser().getEmail() || "").toLowerCase();
  if (!ownerEmail || activeEmail !== ownerEmail) {
    throw new Error("Aksi ini hanya boleh dijalankan oleh Owner. Atur Script Property OWNER_EMAIL terlebih dahulu.");
  }

  const ui = SpreadsheetApp.getUi();
  const idPrompt = ui.prompt("Set / Reset Password", "Masukkan USER_ID target:", ui.ButtonSet.OK_CANCEL);
  if (idPrompt.getSelectedButton() !== ui.Button.OK) return;
  const userId = idPrompt.getResponseText().trim();
  if (!userId) throw new Error("USER_ID wajib diisi.");

  const passPrompt = ui.prompt("Set / Reset Password", "Masukkan password awal (minimal 12 karakter):", ui.ButtonSet.OK_CANCEL);
  if (passPrompt.getSelectedButton() !== ui.Button.OK) return;
  const password = passPrompt.getResponseText();
  if (password.length < 12) throw new Error("Password minimal 12 karakter.");

  const sheet = getSheet_(SA.USERS_SHEET);
  const table = readUsersTable_(sheet);
  const idCol = table.map.USER_ID;
  const saltCol = table.map.PASSWORD_SALT;
  const hashCol = table.map.PASSWORD_HASH;
  if ([idCol, saltCol, hashCol].some(x => x === undefined)) throw new Error("Header USERS belum lengkap.");

  const idx = table.rows.findIndex(row => String(row[idCol]).trim() === userId);
  if (idx < 0) throw new Error("USER_ID tidak ditemukan di USERS.");
  let pepper = props.getProperty("PASSWORD_PEPPER");
  if (!pepper) {
    pepper = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "") +
      Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    props.setProperty("PASSWORD_PEPPER", pepper);
  }
  const salt = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  const derivedKey = pbkdf2Hex_(password, salt, 120000);
  const hash = passwordVerifier_(derivedKey);
  const rowNumber = table.headerRow + idx + 1;
  sheet.getRange(rowNumber, saltCol + 1).setValue(salt);
  sheet.getRange(rowNumber, hashCol + 1).setValue(hash);
  SpreadsheetApp.flush();
  CacheService.getScriptCache().remove("SA_USERS_TABLE_V1");
  ui.alert("Password berhasil disimpan untuk USER_ID " + userId + ". Password asli tidak disimpan di spreadsheet.");
}

/**
 * Challenge-response authentication. PBKDF2 runs in browser Web Crypto;
 * plaintext passwords are never sent to Apps Script.
 */
function beginLogin_(payload) {
  const identity = String(payload.identity || "").trim().toLowerCase();
  if (!identity) throw new Error("USER_ID/email wajib diisi.");
  const usersRead = readUsersTableCachedDetailed_();
  const table = usersRead.table;
  const lookupStarted = Date.now();
  const required = ["USER_ID", "EMAIL", "FULL_NAME", "ROLE", "DIVISION", "ACTIVE", "PASSWORD_SALT", "PASSWORD_HASH"];
  required.forEach(k => { if (table.map[k] === undefined) throw new Error("Kolom USERS tidak ditemukan: " + k); });
  const row = table.rows.find(r =>
    String(r[table.map.USER_ID] || "").trim().toLowerCase() === identity ||
    String(r[table.map.EMAIL] || "").trim().toLowerCase() === identity
  );
  const active = row && isActive_(row[table.map.ACTIVE]);
  const salt = active && row[table.map.PASSWORD_SALT] && row[table.map.PASSWORD_HASH]
    ? String(row[table.map.PASSWORD_SALT])
    : Utilities.getUuid() + Utilities.getUuid();
  const lookupMs = Date.now() - lookupStarted;
  const challengeId = Utilities.getUuid() + Utilities.getUuid();
  const nonce = Utilities.getUuid() + Utilities.getUuid();
  const storedHash = active ? String(row[table.map.PASSWORD_HASH] || "") : "";
  const state = {
    identity: identity,
    userId: active ? String(row[table.map.USER_ID]) : "",
    valid: Boolean(active && row[table.map.PASSWORD_SALT] && storedHash.indexOf("v2$") === 0),
    upgradeRequired: Boolean(active && storedHash && storedHash.indexOf("v2$") !== 0),
    nonce: nonce
  };
  CacheService.getScriptCache().put("SA_LOGIN_CHALLENGE_" + challengeId, JSON.stringify(state), 90);
  return {
    challengeId: challengeId, nonce: nonce, salt: salt, iterations: 120000,
    authTimings: { usersReadMs: usersRead.elapsedMs, usersCacheHit: usersRead.cacheHit, accountLookupMs: lookupMs }
  };
}

function completeLogin_(payload) {
  const challengeId = String(payload.challengeId || "");
  const proof = String(payload.proof || "").toLowerCase();
  const derivedKey = String(payload.derivedKey || "").toLowerCase();
  if (!challengeId || !/^[a-f0-9]{64}$/.test(proof) || !/^[a-f0-9]{64}$/.test(derivedKey)) {
    throw new Error("USER_ID/email atau password salah.");
  }
  const cache = CacheService.getScriptCache();
  const challengeKey = "SA_LOGIN_CHALLENGE_" + challengeId;
  const raw = cache.get(challengeKey);
  cache.remove(challengeKey);
  if (!raw) throw new Error("Sesi login kedaluwarsa. Silakan coba lagi.");
  const challenge = JSON.parse(raw);
  if (challenge.upgradeRequired) {
    throw new Error("Password akun perlu diatur ulang oleh Owner setelah pembaruan keamanan.");
  }
  if (!challenge.valid) throw new Error("USER_ID/email atau password salah.");

  const proofStarted = Date.now();
  const message = challenge.nonce + "|" + challengeId + "|" + challenge.identity;
  const expected = hmacHex_(message, hexToBytes_(derivedKey));
  const proofVerifyMs = Date.now() - proofStarted;
  if (!safeEqual_(proof, expected)) throw new Error("USER_ID/email atau password salah.");

  const usersRead = readUsersTableCachedDetailed_();
  const table = usersRead.table;
  const userRow = table.rows.find(r => String(r[table.map.USER_ID] || "") === challenge.userId);
  if (!userRow || !isActive_(userRow[table.map.ACTIVE])) {
    throw new Error("Akun tidak aktif atau tidak lagi tersedia.");
  }
  const currentVerifier = String(userRow[table.map.PASSWORD_HASH] || "");
  if (!safeEqual_(currentVerifier, passwordVerifier_(derivedKey))) {
    throw new Error("USER_ID/email atau password salah.");
  }

  const user = publicUser_(userRow, table.map);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put("SA_SESSION_" + token, JSON.stringify(user), SA.SESSION_TTL_SECONDS);
  const auditStarted = Date.now();
  audit_("LOGIN", user, "Authentication", "", "", "Login berhasil");
  const auditMs = Date.now() - auditStarted;
  return {
    sessionToken: token, user: user,
    authTimings: {
      proofVerifyMs: proofVerifyMs, usersReadMs: usersRead.elapsedMs,
      usersCacheHit: usersRead.cacheHit, auditMs: auditMs
    }
  };
}

function passwordVerifier_(derivedKeyHex) {
  const pepper = PropertiesService.getScriptProperties().getProperty("PASSWORD_PEPPER");
  if (!pepper) throw new Error("PASSWORD_PEPPER belum dibuat. Owner harus mengatur ulang password.");
  return "v2$" + hmacHex_(String(derivedKeyHex), Utilities.newBlob(pepper).getBytes());
}

function hexToBytes_(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    const value = parseInt(hex.substr(i, 2), 16);
    bytes.push(value > 127 ? value - 256 : value);
  }
  return bytes;
}

function hmacHex_(message, keyBytes) {
  const signature = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(String(message)).getBytes(), keyBytes
  );
  return signature.map(b => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("");
}


function logout_(payload) {
  const token = String(payload.sessionToken || "");
  const user = token ? requireSession_(token) : null;
  if (token) CacheService.getScriptCache().remove("SA_SESSION_" + token);
  if (user) audit_("LOGOUT", user, "Authentication", "", "", "Logout");
  return { loggedOut: true };
}

function requireSession_(token) {
  if (!token) throw new Error("Sesi tidak ditemukan. Silakan login kembali.");
  const raw = CacheService.getScriptCache().get("SA_SESSION_" + token);
  if (!raw) throw new Error("Sesi berakhir. Silakan login kembali.");
  const session = JSON.parse(raw);
  // Recheck account status and role from USERS on every protected request.
  const table = readUsersTableCached_();
  const row = table.rows.find(r => String(r[table.map.USER_ID]) === String(session.userId));
  if (!row || !isActive_(row[table.map.ACTIVE])) {
    CacheService.getScriptCache().remove("SA_SESSION_" + token);
    throw new Error("Akun tidak aktif atau tidak lagi tersedia.");
  }
  return publicUser_(row, table.map);
}

function dashboard_(payload) {
  const user = requireSession_(payload.sessionToken);
  const cache = CacheService.getScriptCache();
  const cacheKey = "SA_DASHBOARD_RECORDS_V1";
  let cached = null;
  if (!payload.forceRefresh) {
    const raw = cache.get(cacheKey);
    if (raw) {
      try { cached = JSON.parse(raw); } catch (e) { cache.remove(cacheKey); }
    }
  }
  if (!cached) {
    const sheet = getSheet_(SA.INQUIRY_SHEET);
    const table = readInquiryTable_(sheet);
    const keyIndex = table.map[normalizeHeader_("INQUIRY PROJECT NO")];
    if (keyIndex === undefined) throw new Error("Pemetaan kolom INQUIRY PROJECT NO tidak tersedia.");
    const validRows = table.rows.filter(row => String(row[keyIndex] || "").trim());
    const records = validRows.map(row => ({
      inquiryNo: cell_(row, table.map, "INQUIRY PROJECT NO"),
      inquiryRank: cell_(row, table.map, "INQUIRY RANK"),
      dueDate: cell_(row, table.map, "DUE DATE DATA MASUK KE SALES"),
      actualDelivery: cell_(row, table.map, "ACTUAL DATA DELIVERY KE SALES"),
      customer: cell_(row, table.map, "CUSTOMER"),
      project: cell_(row, table.map, "NAMA PROJECT INQUIRY"),
      equipment: cell_(row, table.map, "JENIS EQUIPMENT"),
      planner: cell_(row, table.map, "PLANNER PIC"),
      salesPic: cell_(row, table.map, "SALES PIC"),
      quotationNo: cell_(row, table.map, "NO PENAWARAN"),
      quotationStatus: cell_(row, table.map, "STATUS PENAWARAN"),
      projectStatus: cell_(row, table.map, "STATUS PROJECT"),
      progress: cell_(row, table.map, "PROGRESS (%)")
    }));
    cached = {
      records: records,
      diagnostics: {
        sheetName: sheet.getName(), headerRow: table.headerRow,
        lastRow: table.lastDataRow || sheet.getLastRow(), lastColumn: 29,
        inquiryKeyColumn: 5, nonEmptyInquiryKeys: records.length
      }
    };
    try {
      const serialized = JSON.stringify(cached);
      if (serialized.length < 90000) cache.put(cacheKey, serialized, SA.DASHBOARD_CACHE_SECONDS);
    } catch (e) {
      // Cache is optional; live data must still be returned.
    }
  }
  const records = cached.records || [];
  const diagnostics = cached.diagnostics || {};
  if (String(user.role).toUpperCase() === "GUEST") {
    return {
      guest: true,
      summary: {
        total: records.length,
        quotationReleased: records.filter(r => r.quotationNo).length,
        getOrder: records.filter(r => String(r.projectStatus).toUpperCase() === "GET ORDER").length,
        lost: records.filter(r => String(r.projectStatus).toUpperCase() === "LOST").length
      },
      records: [], diagnostics: diagnostics
    };
  }
  return { guest: false, summary: null, records: records, diagnostics: diagnostics };
}



function formatProgress_(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) return "";
  if (/%$/.test(text)) return text;
  const number = Number(text);
  if (!Number.isFinite(number)) return text;
  if (number >= 0 && number <= 1) return Math.round(number * 100) + "%";
  return number + "%";
}

/** Authenticated read-only detail endpoint. Guest accounts cannot read records. */
function inquiryDetail_(payload) {
  const user = requireSession_(payload.sessionToken);
  if (String(user.role).toUpperCase() === "GUEST") throw new Error("Akun Guest hanya dapat melihat ringkasan dashboard.");
  const inquiryNo = String(payload.inquiryNo || "").trim();
  if (!inquiryNo) throw new Error("Nomor inquiry wajib disertakan.");
  const sheet = getSheet_(SA.INQUIRY_SHEET);
  const table = readInquiryTable_(sheet);
  const keyIndex = table.map["INQUIRY PROJECT NO"];
  if (keyIndex === undefined) throw new Error("Kolom INQUIRY PROJECT NO tidak ditemukan.");
  const index = table.rows.findIndex(row => String(row[keyIndex] || "").trim() === inquiryNo);
  if (index < 0) throw new Error("Inquiry " + inquiryNo + " tidak ditemukan.");
  const row = table.rows[index];
  const value = key => cell_(row, table.map, key);
  const record = {
    rowNumber: SA.INQUIRY_FIRST_ROW + index,
    inquiryNo:value("INQUIRY PROJECT NO"), customer:value("CUSTOMER"), project:value("NAMA PROJECT INQUIRY"),
    equipment:value("JENIS EQUIPMENT"), requester:value("NAMA REQUESTER"), department:value("DEPARTMENT"),
    customerTechnicalSpec:value("TECHNICAL SPEC. DARI CUSTOMER"), salesMomSpec:value("MOM / SPESIFIKASI DARI SALES"),
    inquiryRank:value("INQUIRY RANK"), dueDate:value("DUE DATE DATA MASUK KE SALES"),
    estimatedDeliveryTime:value("ESTIMASI DELIVERY TIME"), plannerInquiryDate:value("TGL INQUIRY MASUK KE PLANNER"),
    planner:value("PLANNER PIC"), technicalSpec:value("TECHNICAL SPEC"), drawing:value("DRAWING"),
    costTable:value("COST TABLE"), otherDocuments:value("LAIN-LAIN"),
    actualDelivery:value("ACTUAL DATA DELIVERY KE SALES"), progress:formatProgress_(value("PROGRESS (%)")),
    planningJob:value("PLANING JOB"), dataDelivery:value("DATA DELIVERY"), salesPic:value("SALES PIC"),
    quotationStatus:value("STATUS PENAWARAN"), quotationNo:value("NO PENAWARAN"),
    releaseDate:value("TANGGAL RELEASE"), projectStatus:value("STATUS PROJECT"), note:value("NOTE")
  };
  return {record:record,history:readInquiryHistory_(inquiryNo),diagnostics:{sheetName:sheet.getName(),rowNumber:record.rowNumber}};
}

/** Returns only audit entries associated with the requested inquiry key. */
function readInquiryHistory_(inquiryNo) {
  const sheet=getSheet_(SA.LOG_SHEET), lastRow=sheet.getLastRow(), lastCol=sheet.getLastColumn();
  if(lastRow<2||lastCol<1)return [];
  const headers=sheet.getRange(1,1,1,lastCol).getDisplayValues()[0], map={};
  headers.forEach((header,index)=>{const key=normalizeHeader_(header);if(key)map[key]=index;});
  const keyCol=map.INQUIRY_PROJECT_NO!==undefined?map.INQUIRY_PROJECT_NO:map.RECORD_KEY;
  if(keyCol===undefined)return [];
  const rows=sheet.getRange(2,1,lastRow-1,lastCol).getValues();
  return rows.map((row,index)=>({row:row,rowNumber:index+2}))
    .filter(item=>String(item.row[keyCol]||"").trim()===inquiryNo)
    .map(item=>{
      const get=key=>map[key]===undefined?"":item.row[map[key]];
      const timestamp=get("TIMESTAMP");
      return {
        logId:String(get("LOG_ID")||""),
        timestamp:timestamp instanceof Date?Utilities.formatDate(timestamp,Session.getScriptTimeZone(),"yyyy-MM-dd HH:mm:ss"):String(timestamp||""),
        userName:String(get("USER_NAME")||get("FULL_NAME")||""),userId:String(get("USER_ID")||""),
        role:String(get("ROLE")||""),division:String(get("DIVISION")||""),action:String(get("ACTION")||""),
        fieldKey:String(get("FIELD_KEY")||get("FIELD")||""),oldValue:String(get("OLD_VALUE")||""),
        newValue:String(get("NEW_VALUE")||""),rowNumber:String(get("ROW_NUMBER")||""),source:String(get("SOURCE")||"")
      };
    }).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,100);
}


/**
 * Append audit events using header names, never positional assumptions.
 * Supports the current 15-column ACTIVITY_LOG schema and legacy header aliases.
 */
function audit_(action, user, field, recordKey, oldValue, newValue, details) {
  const sheet = getSheet_(SA.LOG_SHEET);
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error("ACTIVITY_LOG belum memiliki header.");

  const headerRow = 1;
  const headers = sheet.getRange(headerRow, 1, 1, lastColumn).getDisplayValues()[0];
  const map = {};
  headers.forEach((header, index) => {
    const key = normalizeHeader_(header);
    if (key) map[key] = index;
  });

  const required = ["LOG_ID", "TIMESTAMP", "USER_ID", "USER_NAME", "ROLE", "DIVISION", "ACTION"];
  const missing = required.filter(key => map[key] === undefined);
  if (missing.length) {
    throw new Error("Header ACTIVITY_LOG tidak lengkap: " + missing.join(", "));
  }

  const extra = details || {};
  const values = new Array(lastColumn).fill("");
  const eventId = Utilities.getUuid();
  const requestId = String(extra.requestId || Utilities.getUuid());
  const event = {
    LOG_ID: eventId,
    TIMESTAMP: new Date(),
    USER_ID: user ? user.userId : "",
    USER_NAME: user ? user.fullName : "",
    ROLE: user ? user.role : "",
    DIVISION: user ? user.division : "",
    ACTION: String(action || ""),
    INQUIRY_PROJECT_NO: String(extra.inquiryProjectNo || recordKey || ""),
    SHEET_NAME: String(extra.sheetName || (
      String(action).toUpperCase() === "LOGIN" || String(action).toUpperCase() === "LOGOUT"
        ? "Authentication" : ""
    )),
    ROW_NUMBER: extra.rowNumber === undefined || extra.rowNumber === null ? "" : extra.rowNumber,
    FIELD_KEY: String(extra.fieldKey || ((String(action).toUpperCase() === "LOGIN" || String(action).toUpperCase() === "LOGOUT") ? "" : (field || ""))),
    OLD_VALUE: oldValue === undefined || oldValue === null ? "" : String(oldValue),
    NEW_VALUE: newValue === undefined || newValue === null ? "" : String(newValue),
    REQUEST_ID: requestId,
    SOURCE: String(extra.source || "WEB_APP")
  };

  const aliases = {
    USER_NAME: ["USER_NAME", "FULL_NAME"],
    INQUIRY_PROJECT_NO: ["INQUIRY_PROJECT_NO", "RECORD_KEY"],
    FIELD_KEY: ["FIELD_KEY", "FIELD"]
  };
  Object.keys(event).forEach(key => {
    const target = (aliases[key] || [key]).find(candidate => map[candidate] !== undefined);
    if (target !== undefined) values[map[target]] = event[key];
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const nextRow = Math.max(sheet.getLastRow() + 1, headerRow + 1);
    sheet.getRange(nextRow, 1, 1, lastColumn).setValues([values]);
  } finally {
    lock.releaseLock();
  }
}

function safeEqual_(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function publicUser_(row, map) {
  return {
    userId: String(row[map.USER_ID] || ""),
    fullName: String(row[map.FULL_NAME] || ""),
    email: String(row[map.EMAIL] || ""),
    role: String(row[map.ROLE] || ""),
    division: String(row[map.DIVISION] || ""),
    assignedPicName: String(row[map.ASSIGNED_PIC_NAME] || "")
  };
}
function isActive_(value) {
  return ["true", "yes", "1", "active", "aktif"].includes(String(value).trim().toLowerCase());
}
function cell_(row, map, key) {
  const i = map[key];
  if (i === undefined) return "";
  const value = row[i];
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return value === null || value === undefined ? "" : String(value).trim();
}
/**
 * Locate the USERS header row instead of assuming it is row 1.
 * The sheet contains a title and explanatory note above the actual table.
 */
/**
 * Find the actual inquiry header row. The workbook may have title or section
 * rows above the table, so do not assume a fixed row number.
 */
function readInquiryTable_(sheet) {
  // A7 = sequence number 1; E7 = inquiry project number (primary record key).
  // Header rows 3-6 contain merged cells and are intentionally not parsed.
  const first = 7;
  const last = sheet.getLastRow();
  const map = {
    "NO":0,"CUSTOMER":1,"NAMA PROJECT INQUIRY":2,"JENIS EQUIPMENT":3,
    "INQUIRY PROJECT NO":4,"NAMA REQUESTER":5,"DEPARTMENT":6,
    "TECHNICAL SPEC. DARI CUSTOMER":7,"MOM / SPESIFIKASI DARI SALES":8,
    "INQUIRY RANK":9,"DUE DATE DATA MASUK KE SALES":10,
    "ESTIMASI DELIVERY TIME":11,"TGL INQUIRY MASUK KE PLANNER":12,
    "PLANNER PIC":13,"TECHNICAL SPEC":14,"DRAWING":15,"COST TABLE":16,
    "LAIN-LAIN":17,"ACTUAL DATA DELIVERY KE SALES":18,"PROGRESS (%)":19,
    "PLANING JOB":21,"DATA DELIVERY":22,"SALES PIC":23,
    "STATUS PENAWARAN":24,"NO PENAWARAN":25,"TANGGAL RELEASE":26,
    "STATUS PROJECT":27,"NOTE":28
  };
  if (last < first) return {map:map,rows:[],headerRow:"3-6"};
  const keys = sheet.getRange(first,5,last-first+1,1).getDisplayValues();
  let end = -1;
  for (let i=keys.length-1;i>=0;i--) {
    if (String(keys[i][0] || "").trim()) { end=i; break; }
  }
  if (end < 0) return {map:map,rows:[],headerRow:"3-6"};
  const rows = sheet.getRange(first,1,end+1,29).getValues();
  return {map:map,rows:rows,headerRow:"3-6 (fixed map)",lastDataRow:first+end};
}

function readUsersTableCachedDetailed_() {
  const started = Date.now();
  const cache = CacheService.getScriptCache();
  const key = "SA_USERS_TABLE_V1";
  const value = cache.get(key);
  if (value) {
    try { return { table: JSON.parse(value), cacheHit: true, elapsedMs: Date.now() - started }; }
    catch (e) { cache.remove(key); }
  }
  const table = readUsersTable_(getSheet_(SA.USERS_SHEET));
  cache.put(key, JSON.stringify(table), 30);
  return { table: table, cacheHit: false, elapsedMs: Date.now() - started };
}

function readUsersTableCached_() {
  return readUsersTableCachedDetailed_().table;
}

function readUsersTable_(sheet) {
  const scanRows = Math.min(SA.USERS_HEADER_SCAN_ROWS, sheet.getLastRow());
  const lastCol = sheet.getLastColumn();
  if (!scanRows || !lastCol) throw new Error("Sheet USERS kosong.");

  const candidates = sheet.getRange(1, 1, scanRows, lastCol).getDisplayValues();
  for (let i = 0; i < candidates.length; i++) {
    const normalized = candidates[i].map(h => String(h).trim().toUpperCase());
    if (normalized.includes("USER_ID") && normalized.includes("EMAIL")) {
      const table = readTable_(sheet, i + 1);
      table.headerRow = i + 1;
      return table;
    }
  }
  throw new Error("Header USERS tidak ditemukan dalam " + scanRows +
    " baris pertama. Pastikan terdapat kolom USER_ID dan EMAIL.");
}

function normalizeHeader_(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function readTable_(sheet, headerRow) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (!lastCol || lastRow < headerRow) throw new Error("Sheet " + sheet.getName() + " belum memiliki header.");
  const headers = sheet.getRange(headerRow, 1, 1, lastCol).getDisplayValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    const key = normalizeHeader_(h);
    if (key) map[key] = i;
  });
  const rows = lastRow > headerRow ? sheet.getRange(headerRow + 1, 1, lastRow - headerRow, lastCol).getValues() : [];
  return { map: map, rows: rows };
}
function getSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error("Sheet tidak ditemukan: " + name);
  return sheet;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
