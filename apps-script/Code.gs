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
    else if (action === "registerChallenge") data = registerChallenge_(payload);
    else if (action === "registerComplete") data = registerComplete_(payload);
    else if (action === "registrationStatus") data = registrationStatus_(payload);
    else if (action === "loginChallenge") data = beginLogin_(payload);
    else if (action === "loginVerify") data = completeLogin_(payload);
    else if (action === "me") data = requireSession_(payload.sessionToken);
    else if (action === "logout") data = logout_(payload);
    else if (action === "dashboard") data = dashboard_(payload);
    else if (action === "inquiryDetail") data = inquiryDetail_(payload);
    else if (action === "inquirySchema") data = inquirySchema_(payload);
    else if (action === "updateInquiry") data = updateInquiry_(payload);
    else if (action === "createInquiry") data = createInquiry_(payload);
    else if (action === "employeeDashboard") data = employeeDashboard_(payload);
    else if (action === "employeeSaveActivity") data = employeeSaveActivity_(payload);
    else if (action === "employeeSaveAttendance") data = employeeSaveAttendance_(payload);
    else if (action === "employeeSaveVisit") data = employeeSaveVisit_(payload);
    else if (action === "employeeAssign") data = employeeAssign_(payload);
    else if (action === "employeeUpdateAssignment") data = employeeUpdateAssignment_(payload);
    else if (action === "employeeHistory") data = employeeHistory_(payload);
    else if (action === "employeeVehicleSuggestions") data = employeeVehicleSuggestions_(payload);
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
      requester: cell_(row, table.map, "NAMA REQUESTER"),
      department: cell_(row, table.map, "DEPARTMENT"),
      customerSpec: cell_(row, table.map, "TECHNICAL SPEC. DARI CUSTOMER"),
      inquiryRank: cell_(row, table.map, "INQUIRY RANK"),
      planner: cell_(row, table.map, "PLANNER PIC"),
      planningStatus: cell_(row, table.map, "PLANING JOB"),
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
    maintenanceUpdate:value("MAINTENANCE UPDATE"),
    planningJob:value("PLANING JOB"), dataDelivery:value("DATA DELIVERY"), salesPic:value("SALES PIC"),
    quotationStatus:value("STATUS PENAWARAN"), quotationNo:value("NO PENAWARAN"),
    releaseDate:value("TANGGAL RELEASE"), projectStatus:value("STATUS PROJECT"), note:value("NOTE")
  };
  return {record:record,history:readInquiryHistory_(inquiryNo),editableFields:editableFields_(user, record),canEditAll:String(user.role).toUpperCase()==="ADMIN",diagnostics:{sheetName:sheet.getName(),rowNumber:record.rowNumber}};
}


/**
 * Explicit write permissions. These names map to the existing Inquiry sheet
 * columns; no client-supplied column number is ever accepted.
 */
function inquiryFieldDefinitions_() {
  return [
    {key:"CUSTOMER",label:"Customer",index:1,owner:"SALES"},
    {key:"NAMA PROJECT INQUIRY",label:"Nama project inquiry",index:2,owner:"SALES"},
    {key:"JENIS EQUIPMENT",label:"Jenis equipment",index:3,owner:"SALES"},
    {key:"INQUIRY PROJECT NO",label:"Inquiry project number",index:4,owner:"ADMIN",immutable:true},
    {key:"NAMA REQUESTER",label:"Nama requester",index:5,owner:"SALES"},
    {key:"DEPARTMENT",label:"Department",index:6,owner:"SALES"},
    {key:"TECHNICAL SPEC. DARI CUSTOMER",label:"Technical spec. dari customer",index:7,owner:"SALES",multiline:true},
    {key:"MOM / SPESIFIKASI DARI SALES",label:"MOM / spesifikasi dari Sales",index:8,owner:"SALES",multiline:true},
    {key:"INQUIRY RANK",label:"Inquiry rank",index:9,owner:"SALES"},
    {key:"DUE DATE DATA MASUK KE SALES",label:"Due date data masuk ke Sales",index:10,owner:"SALES",type:"date"},
    {key:"ESTIMASI DELIVERY TIME",label:"Estimasi delivery time",index:11,owner:"SALES"},
    {key:"TGL INQUIRY MASUK KE PLANNER",label:"Tanggal inquiry masuk ke Planner",index:12,owner:"PLANNER",type:"date"},
    {key:"PLANNER PIC",label:"Planner PIC",index:13,owner:"PLANNER"},
    {key:"TECHNICAL SPEC",label:"Technical spec",index:14,owner:"PLANNER",multiline:true},
    {key:"DRAWING",label:"Drawing",index:15,owner:"PLANNER"},
    {key:"COST TABLE",label:"Cost table",index:16,owner:"PLANNER"},
    {key:"LAIN-LAIN",label:"Lain-lain",index:17,owner:"PLANNER",multiline:true},
    {key:"ACTUAL DATA DELIVERY KE SALES",label:"Actual data delivery ke Sales",index:18,owner:"PLANNER",type:"date"},
    {key:"PROGRESS (%)",label:"Progress (%)",index:19,owner:"PLANNER",type:"percent"},
    {key:"PLANING JOB",label:"Planning job",index:21,owner:"WORKSHOP",multiline:true},
    {key:"DATA DELIVERY",label:"Data delivery",index:22,owner:"PROJECT",multiline:true},
    {key:"MAINTENANCE UPDATE",label:"Maintenance update",index:29,owner:"MAINTENANCE",multiline:true},
    {key:"SALES PIC",label:"Sales PIC",index:23,owner:"SALES"},
    {key:"STATUS PENAWARAN",label:"Status penawaran",index:24,owner:"SALES"},
    {key:"NO PENAWARAN",label:"Nomor penawaran",index:25,owner:"SALES"},
    {key:"TANGGAL RELEASE",label:"Tanggal release",index:26,owner:"SALES",type:"date"},
    {key:"STATUS PROJECT",label:"Status project",index:27,owner:"SALES"},
    {key:"NOTE",label:"Note",index:28,owner:"SALES",multiline:true}
  ];
}

function userDivisionGroup_(user) {
  const role = String(user.role || "").trim().toUpperCase();
  const division = String(user.division || "").trim().toUpperCase();
  if (role === "ADMIN") return "ADMIN";
  if (role === "GUEST" || role === "DIRECTORS" || role === "DIRECTOR" || role === "MANAGEMENT") return "READONLY";
  const value = role + " " + division;
  if (/SALES/.test(value)) return "SALES";
  if (/PLANNER|ENGINEER/.test(value)) return "PLANNER";
  if (/WORKSHOP|PRODUCTION|PRODUKSI|PPIC/.test(value)) return "WORKSHOP";
  if (/PROJECT/.test(value)) return "PROJECT";
  if (/MAINTENANCE/.test(value)) return "MAINTENANCE";
  return "READONLY";
}

function editableFieldDefs_(user) {
  const group = userDivisionGroup_(user);
  return inquiryFieldDefinitions_().filter(def => !def.immutable && (group === "ADMIN" || def.owner === group));
}

function editableFields_(user, record) {
  return editableFieldDefs_(user).map(def => ({
    key:def.key,label:def.label,type:def.type || (def.multiline ? "textarea" : "text"),
    value:editorValueForKey_(record, def)
  }));
}

function editorValueForKey_(record, def) {
  const value = recordValueForKey_(record, def.key);
  if (def.type === "percent") return String(value || "").replace("%", "").trim();
  return value;
}

function recordValueForKey_(record, key) {
  const map = {
    "CUSTOMER":"customer","NAMA PROJECT INQUIRY":"project","JENIS EQUIPMENT":"equipment",
    "NAMA REQUESTER":"requester","DEPARTMENT":"department",
    "TECHNICAL SPEC. DARI CUSTOMER":"customerTechnicalSpec","MOM / SPESIFIKASI DARI SALES":"salesMomSpec",
    "INQUIRY RANK":"inquiryRank","DUE DATE DATA MASUK KE SALES":"dueDate",
    "ESTIMASI DELIVERY TIME":"estimatedDeliveryTime","TGL INQUIRY MASUK KE PLANNER":"plannerInquiryDate",
    "PLANNER PIC":"planner","TECHNICAL SPEC":"technicalSpec","DRAWING":"drawing","COST TABLE":"costTable",
    "LAIN-LAIN":"otherDocuments","ACTUAL DATA DELIVERY KE SALES":"actualDelivery","PROGRESS (%)":"progress",
    "PLANING JOB":"planningJob","DATA DELIVERY":"dataDelivery","MAINTENANCE UPDATE":"maintenanceUpdate","SALES PIC":"salesPic",
    "STATUS PENAWARAN":"quotationStatus","NO PENAWARAN":"quotationNo","TANGGAL RELEASE":"releaseDate",
    "STATUS PROJECT":"projectStatus","NOTE":"note"
  };
  return record[map[key]] || "";
}

function inquirySchema_(payload) {
  const user = requireSession_(payload.sessionToken);
  const group = userDivisionGroup_(user);
  if (group !== "ADMIN" && group !== "SALES") {
    throw new Error("Hanya ADMIN dan Sales yang dapat membuat inquiry baru.");
  }
  return {
    fields: editableFieldDefs_(user).map(def => ({
      key:def.key,label:def.label,type:def.type || (def.multiline ? "textarea" : "text"),
      required:["CUSTOMER","NAMA PROJECT INQUIRY","INQUIRY PROJECT NO"].includes(def.key)
    })),
    canCreate:true
  };
}

function ensureMaintenanceColumn_(sheet) {
  const maxColumns = sheet.getMaxColumns();
  if (maxColumns < 30) sheet.insertColumnsAfter(maxColumns, 30 - maxColumns);
  const headerCell = sheet.getRange(6, 30);
  const current = normalizeHeader_(headerCell.getDisplayValue());
  if (!current) {
    const lastRow = sheet.getLastRow();
    if (lastRow >= SA.INQUIRY_FIRST_ROW) {
      const existing = sheet.getRange(SA.INQUIRY_FIRST_ROW, 30, lastRow - SA.INQUIRY_FIRST_ROW + 1, 1).getDisplayValues().flat();
      if (existing.some(value => String(value || "").trim())) {
        throw new Error("Kolom AD memiliki data tetapi header AD6 kosong. Periksa kolom AD sebelum mengaktifkan input Maintenance.");
      }
    }
    headerCell.setValue("MAINTENANCE UPDATE");
    headerCell.setNote("Kolom tambahan SalesApp untuk input divisi Maintenance. Data inquiry lama tidak diubah.");
  } else if (current !== "MAINTENANCE UPDATE") {
    throw new Error("Kolom AD pada Inquiry sheet sudah digunakan (" + current + "). Tentukan kolom Maintenance yang kosong sebelum mengaktifkan input Maintenance.");
  }
}

function nextInquiryRow_(sheet) {
  const last = sheet.getLastRow();
  if (last < SA.INQUIRY_FIRST_ROW) return SA.INQUIRY_FIRST_ROW;
  const keys = sheet.getRange(SA.INQUIRY_FIRST_ROW, 5, last - SA.INQUIRY_FIRST_ROW + 1, 1).getDisplayValues();
  for (let i = keys.length - 1; i >= 0; i--) {
    if (String(keys[i][0] || "").trim()) return SA.INQUIRY_FIRST_ROW + i + 1;
  }
  return SA.INQUIRY_FIRST_ROW;
}

function copyProgressFormula_(sheet, targetRow) {
  for (let row = targetRow - 1; row >= SA.INQUIRY_FIRST_ROW; row--) {
    const formula = sheet.getRange(row, 21).getFormulaR1C1();
    if (formula) {
      sheet.getRange(targetRow, 21).setFormulaR1C1(formula);
      return;
    }
  }
}

function findInquiryRow_(sheet, inquiryNo) {
  const last = sheet.getLastRow();
  if (last < SA.INQUIRY_FIRST_ROW) return -1;
  const values = sheet.getRange(SA.INQUIRY_FIRST_ROW, 5, last-SA.INQUIRY_FIRST_ROW+1, 1).getDisplayValues();
  const index = values.findIndex(row => String(row[0] || "").trim() === inquiryNo);
  return index < 0 ? -1 : SA.INQUIRY_FIRST_ROW + index;
}

function normalizeWriteValue_(def, raw) {
  if (raw === null || raw === undefined) return "";
  let value = String(raw).trim();
  if (value.length > 5000) throw new Error("Nilai " + def.label + " terlalu panjang (maksimal 5.000 karakter).");
  if (def.type === "percent") {
    if (!value) return "";
    value = value.replace("%","").trim();
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 100) {
      throw new Error("Progress harus berupa angka 0 sampai 100.");
    }
    return number / 100;
  }
  if (def.type === "date") {
    if (!value) return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Format tanggal " + def.label + " harus YYYY-MM-DD.");
    const parts = value.split("-").map(Number);
    return new Date(parts[0], parts[1]-1, parts[2], 12, 0, 0);
  }
  return value;
}

function comparableFieldValue_(def, value) {
  if (value === null || value === undefined || value === "") return "";
  if (def.type === "date") {
    if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
    return String(value).trim();
  }
  if (def.type === "percent") {
    const number = Number(String(value).replace("%", "").trim());
    if (!Number.isFinite(number)) return String(value).trim();
    return String(Math.round((number >= 0 && number <= 1 ? number * 100 : number) * 100) / 100);
  }
  return String(value).trim();
}

function updateInquiry_(payload) {
  const user = requireSession_(payload.sessionToken);
  if (userDivisionGroup_(user) === "READONLY") throw new Error("Akun ini hanya memiliki akses baca.");
  const inquiryNo = String(payload.inquiryNo || "").trim();
  const submitted = payload.fields;
  if (!inquiryNo || !submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    throw new Error("Nomor inquiry dan field perubahan wajib disertakan.");
  }
  const allowed = editableFieldDefs_(user);
  const defs = {};
  allowed.forEach(def => defs[def.key] = def);
  const keys = Object.keys(submitted);
  if (!keys.length) throw new Error("Tidak ada perubahan yang dikirim.");
  const unknown = keys.filter(key => !defs[key]);
  if (unknown.length) throw new Error("Akses ditolak untuk field: " + unknown.join(", "));
  const sheet = getSheet_(SA.INQUIRY_SHEET);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let rowNumber, changes = [];
  try {
    rowNumber = findInquiryRow_(sheet, inquiryNo);
    if (rowNumber < 0) throw new Error("Inquiry " + inquiryNo + " tidak ditemukan.");
    keys.forEach(key => {
      const def = defs[key];
      const range = sheet.getRange(rowNumber, def.index + 1);
      const oldRaw = range.getValue();
      const oldValue = range.getDisplayValue();
      const newValue = normalizeWriteValue_(def, submitted[key]);
      const compareOld = comparableFieldValue_(def, oldRaw);
      const compareNew = comparableFieldValue_(def, newValue);
      if (compareOld === compareNew) return;
      range.setValue(newValue);
      changes.push({key:key,label:def.label,oldValue:oldValue,newValue:compareNew});
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  if (!changes.length) return {updated:false,message:"Tidak ada nilai yang berubah.",changedFields:[]};
  const requestId = Utilities.getUuid();
  changes.forEach(change => audit_("UPDATE_INQUIRY",user,change.key,inquiryNo,change.oldValue,change.newValue,{
    inquiryProjectNo:inquiryNo,sheetName:SA.INQUIRY_SHEET,rowNumber:rowNumber,fieldKey:change.key,requestId:requestId,source:"WEB_APP"
  }));
  CacheService.getScriptCache().remove("SA_DASHBOARD_RECORDS_V1");
  return {updated:true,inquiryNo:inquiryNo,rowNumber:rowNumber,changedFields:changes.map(c=>c.key),message:changes.length+" field berhasil diperbarui."};
}

function createInquiry_(payload) {
  const user = requireSession_(payload.sessionToken);
  const group = userDivisionGroup_(user);
  if (group !== "ADMIN" && group !== "SALES") throw new Error("Hanya ADMIN dan Sales yang dapat membuat inquiry baru.");
  const submitted = payload.fields;
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) throw new Error("Data inquiry tidak valid.");
  const allowed = editableFieldDefs_(user);
  const defs = {};
  allowed.forEach(def => defs[def.key] = def);
  const inquiryNo = String(submitted["INQUIRY PROJECT NO"] || "").trim();
  if (!inquiryNo) throw new Error("INQUIRY PROJECT NO wajib diisi.");
  if (!String(submitted["CUSTOMER"] || "").trim()) throw new Error("CUSTOMER wajib diisi.");
  if (!String(submitted["NAMA PROJECT INQUIRY"] || "").trim()) throw new Error("NAMA PROJECT INQUIRY wajib diisi.");
  const keys = Object.keys(submitted);
  const unknown = keys.filter(key => !defs[key] && key !== "INQUIRY PROJECT NO");
  if (unknown.length) throw new Error("Akses ditolak untuk field: " + unknown.join(", "));
  const sheet = getSheet_(SA.INQUIRY_SHEET);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let rowNumber, values;
  try {
    if (findInquiryRow_(sheet,inquiryNo) >= 0) throw new Error("Nomor inquiry " + inquiryNo + " sudah digunakan.");
    ensureMaintenanceColumn_(sheet);
    rowNumber = nextInquiryRow_(sheet);
    values = new Array(30).fill("");
    const sequenceValues = rowNumber > SA.INQUIRY_FIRST_ROW
      ? sheet.getRange(SA.INQUIRY_FIRST_ROW,1,rowNumber-SA.INQUIRY_FIRST_ROW,1).getValues().flat()
      : [];
    const maxSequence = sequenceValues.reduce((max,value)=>Math.max(max,Number(value)||0),0);
    values[0] = maxSequence + 1;
    values[4] = inquiryNo;
    keys.forEach(key => {
      if (key === "INQUIRY PROJECT NO") return;
      const def = defs[key];
      if (!def) return;
      values[def.index] = normalizeWriteValue_(def,submitted[key]);
    });
    // Column U (index 21) contains the progress-bar formula; preserve it.
    sheet.getRange(rowNumber,1,1,20).setValues([values.slice(0,20)]);
    sheet.getRange(rowNumber,22,1,9).setValues([values.slice(21,30)]);
    copyProgressFormula_(sheet, rowNumber);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  const requestId = Utilities.getUuid();
  audit_("CREATE_INQUIRY",user,"RECORD",inquiryNo,"","Inquiry dibuat dari website",{
    inquiryProjectNo:inquiryNo,sheetName:SA.INQUIRY_SHEET,rowNumber:rowNumber,fieldKey:"RECORD",requestId:requestId,source:"WEB_APP"
  });
  CacheService.getScriptCache().remove("SA_DASHBOARD_RECORDS_V1");
  return {created:true,inquiryNo:inquiryNo,rowNumber:rowNumber,message:"Inquiry "+inquiryNo+" berhasil dibuat."};
}


/** Returns only audit entries associated with the requested inquiry key. */
function readInquiryHistory_(inquiryNo) {
  const sheet = getSheet_(SA.LOG_SHEET);
  const header = activityLogHeader_(sheet);
  const map = header.map;
  const keyCol = map.INQUIRY_PROJECT_NO !== undefined ? map.INQUIRY_PROJECT_NO : map.RECORD_KEY;
  if (keyCol === undefined) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow <= header.row) return [];
  const rows = sheet.getRange(header.row + 1, 1, lastRow - header.row, sheet.getLastColumn()).getValues();
  return rows.map((row,index)=>({row:row,rowNumber:header.row+index+1}))
    .filter(item=>String(item.row[keyCol]||"").trim()===inquiryNo)
    .map(item=>{
      const get=key=>map[key]===undefined?"":item.row[map[key]];
      const timestamp=get("TIMESTAMP");
      return {
        logId:String(get("LOG_ID")||""),
        timestamp:timestamp instanceof Date?Utilities.formatDate(timestamp,Session.getScriptTimeZone(),"yyyy-MM-dd HH:mm:ss"):String(timestamp||""),
        userName:String(get("USER_NAME")||get("FULL_NAME")||""),
        userId:String(get("USER_ID")||""),role:String(get("ROLE")||""),division:String(get("DIVISION")||""),
        action:String(get("ACTION")||""),fieldKey:String(get("FIELD_KEY")||get("FIELD")||""),
        oldValue:String(get("OLD_VALUE")||""),newValue:String(get("NEW_VALUE")||""),
        rowNumber:String(get("ROW_NUMBER")||""),source:String(get("SOURCE")||"")
      };
    }).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,100);
}

/**
 * Append audit events using header names, never positional assumptions.
 * Supports the current 15-column ACTIVITY_LOG schema and legacy header aliases.
 */
/**
 * Locate ACTIVITY_LOG headers instead of assuming they are on row 1.
 * If the sheet has legacy content but no recognizable header, append a new
 * canonical header row rather than overwriting or deleting existing history.
 */
function activityLogHeader_(sheet) {
  const lastRow = sheet.getLastRow();
  const scanRows = Math.min(Math.max(lastRow, 1), 50);
  const lastCol = Math.max(sheet.getLastColumn(), 15);
  const rows = sheet.getRange(1, 1, scanRows, lastCol).getDisplayValues();
  const aliases = {
    USER_NAME: ["USER_NAME", "FULL_NAME", "NAMA USER", "NAMA PENGGUNA"],
    INQUIRY_PROJECT_NO: ["INQUIRY_PROJECT_NO", "RECORD_KEY", "INQUIRY NO"],
    FIELD_KEY: ["FIELD_KEY", "FIELD", "KOLOM"]
  };
  let best = null;
  rows.forEach((row, index) => {
    const normalized = row.map(normalizeHeader_);
    const has = key => (aliases[key] || [key]).some(alias => normalized.includes(alias));
    const score = ["TIMESTAMP","USER_ID","ACTION","ROLE","DIVISION","LOG_ID"].filter(has).length
      + (has("USER_NAME") ? 1 : 0);
    if (score >= 3 && (!best || score > best.score)) {
      const map = {};
      normalized.forEach((key, col) => { if (key) map[key] = col; });
      best = { row: index + 1, map: map, score: score, lastColumn: lastCol };
    }
  });
  if (best) {
    const aliasMap = {
      USER_NAME: ["USER_NAME","FULL_NAME","NAMA USER","NAMA PENGGUNA"],
      INQUIRY_PROJECT_NO: ["INQUIRY_PROJECT_NO","RECORD_KEY","INQUIRY NO"],
      FIELD_KEY: ["FIELD_KEY","FIELD","KOLOM"]
    };
    Object.keys(aliasMap).forEach(key => {
      if (best.map[key] === undefined) {
        const found = aliasMap[key].find(alias => best.map[alias] !== undefined);
        if (found) best.map[key] = best.map[found];
      }
    });
    return best;
  }

  const headerRow = lastRow === 0 ? 1 : lastRow + 1;
  const headers = ["LOG_ID","TIMESTAMP","USER_ID","USER_NAME","ROLE","DIVISION","ACTION",
    "INQUIRY_PROJECT_NO","SHEET_NAME","ROW_NUMBER","FIELD_KEY","OLD_VALUE","NEW_VALUE","REQUEST_ID","SOURCE"];
  sheet.getRange(headerRow, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(headerRow, 1, 1, headers.length).setFontWeight("bold");
  return { row: headerRow, map: Object.fromEntries(headers.map((key,index)=>[key,index])),
    score: headers.length, lastColumn: headers.length };
}

function audit_(action, user, field, recordKey, oldValue, newValue, details) {
  const sheet = getSheet_(SA.LOG_SHEET);
  const header = activityLogHeader_(sheet);
  const map = header.map;
  const required = ["TIMESTAMP","USER_ID","ACTION"];
  const missing = required.filter(key => map[key] === undefined);
  if (missing.length) throw new Error("Header ACTIVITY_LOG tidak dapat dikenali. Kolom wajib: " + missing.join(", "));

  const extra = details || {};
  const width = Math.max(sheet.getLastColumn(), header.lastColumn || 0);
  const values = new Array(width).fill("");
  const event = {
    LOG_ID: Utilities.getUuid(),
    TIMESTAMP: new Date(),
    USER_ID: user ? user.userId : "",
    USER_NAME: user ? user.fullName : "",
    ROLE: user ? user.role : "",
    DIVISION: user ? user.division : "",
    ACTION: String(action || ""),
    INQUIRY_PROJECT_NO: String(extra.inquiryProjectNo || recordKey || ""),
    SHEET_NAME: String(extra.sheetName || (
      ["LOGIN","LOGOUT"].includes(String(action).toUpperCase()) ? "Authentication" : ""
    )),
    ROW_NUMBER: extra.rowNumber === undefined || extra.rowNumber === null ? "" : extra.rowNumber,
    FIELD_KEY: String(extra.fieldKey || (
      ["LOGIN","LOGOUT"].includes(String(action).toUpperCase()) ? "" : (field || "")
    )),
    OLD_VALUE: oldValue === undefined || oldValue === null ? "" : String(oldValue),
    NEW_VALUE: newValue === undefined || newValue === null ? "" : String(newValue),
    REQUEST_ID: String(extra.requestId || Utilities.getUuid()),
    SOURCE: String(extra.source || "WEB_APP")
  };
  const aliases = {
    USER_NAME:["USER_NAME","FULL_NAME","NAMA USER","NAMA PENGGUNA"],
    INQUIRY_PROJECT_NO:["INQUIRY_PROJECT_NO","RECORD_KEY","INQUIRY NO"],
    FIELD_KEY:["FIELD_KEY","FIELD","KOLOM"]
  };
  Object.keys(event).forEach(key => {
    const candidates = aliases[key] || [key];
    const target = candidates.find(candidate => map[candidate] !== undefined);
    if (target !== undefined) values[map[target]] = event[key];
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const nextRow = Math.max(sheet.getLastRow() + 1, header.row + 1);
    sheet.getRange(nextRow, 1, 1, width).setValues([values]);
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
  ensureMaintenanceColumn_(sheet);
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
    "STATUS PROJECT":27,"NOTE":28,"MAINTENANCE UPDATE":29
  };
  if (last < first) return {map:map,rows:[],headerRow:"3-6"};
  const keys = sheet.getRange(first,5,last-first+1,1).getDisplayValues();
  let end = -1;
  for (let i=keys.length-1;i>=0;i--) {
    if (String(keys[i][0] || "").trim()) { end=i; break; }
  }
  if (end < 0) return {map:map,rows:[],headerRow:"3-6"};
  const rows = sheet.getRange(first,1,end+1,30).getValues();
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


/* ==================== REGISTRATION & EMPLOYEE MANAGEMENT ==================== */
/* Existing workbook columns only. USERS.ROLE and USERS.DIVISION hold the
   requested values while ACTIVE=FALSE; these values grant no access until active. */

function registrationSheetTable_() {
  const sheet=getSheet_(SA.USERS_SHEET), table=readUsersTable_(sheet);
  ["USER_ID","FULL_NAME","EMAIL","ROLE","DIVISION","ACTIVE","PASSWORD_SALT","PASSWORD_HASH","CREATED_AT"].forEach(k=>{
    if(table.map[k]===undefined) throw new Error("Kolom USERS tidak ditemukan: "+k);
  });
  return {sheet:sheet,table:table};
}
function registerChallenge_(payload) {
  const email=String(payload.email||"").trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Format email tidak valid.");
  const salt=Utilities.getUuid().replace(/-/g,"")+Utilities.getUuid().replace(/-/g,"");
  const id=Utilities.getUuid()+Utilities.getUuid();
  CacheService.getScriptCache().put("SA_REGISTER_"+id,JSON.stringify({email:email,salt:salt}),300);
  return {challengeId:id,salt:salt,iterations:120000};
}
function registerComplete_(payload) {
  const challengeId=String(payload.challengeId||""), derivedKey=String(payload.derivedKey||"").toLowerCase();
  const fullName=String(payload.fullName||"").trim(), email=String(payload.email||"").trim().toLowerCase();
  const requestedRole=String(payload.role||"").trim().toUpperCase();
  const requestedDivision=String(payload.division||"").trim().toUpperCase();
  if(!challengeId||!/^[a-f0-9]{64}$/.test(derivedKey)) throw new Error("Data registrasi tidak valid.");
  if(fullName.length<3||fullName.length>120) throw new Error("Nama harus 3–120 karakter.");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Format email tidak valid.");
  if(!requestedRole||!requestedDivision) throw new Error("Role dan divisi wajib dipilih.");
  if(["ADMIN","DIVISION_HEAD","HEAD_OF_DIVISION","KEPALA_DIVISI","OWNER"].includes(requestedRole)) throw new Error("Role istimewa hanya dapat diberikan langsung oleh admin setelah pendaftaran.");
  const lock=LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const cache=CacheService.getScriptCache(), key="SA_REGISTER_"+challengeId, raw=cache.get(key);
    if(!raw) throw new Error("Sesi registrasi kedaluwarsa. Ulangi pendaftaran.");
    const challenge=JSON.parse(raw);
    if(challenge.email!==email) throw new Error("Email registrasi tidak cocok.");
    const {sheet,table}=registrationSheetTable_(), m=table.map;
    const existing=table.rows.find(r=>String(r[m.EMAIL]||"").trim().toLowerCase()===email);
    if(existing) throw new Error("Email sudah terdaftar. Silakan login atau hubungi admin.");
    const duplicate=table.rows.some(r=>
      String(r[m.FULL_NAME]||"").trim().toLowerCase()===fullName.toLowerCase() &&
      String(r[m.DIVISION]||"").trim().toUpperCase()===requestedDivision);
    let pepper=PropertiesService.getScriptProperties().getProperty("PASSWORD_PEPPER");
    if(!pepper) {
      pepper=Utilities.getUuid().replace(/-/g,"")+Utilities.getUuid().replace(/-/g,"")+
        Utilities.getUuid().replace(/-/g,"")+Utilities.getUuid().replace(/-/g,"");
      PropertiesService.getScriptProperties().setProperty("PASSWORD_PEPPER",pepper);
    }
    const userId="SA-"+Utilities.getUuid().replace(/-/g,"").slice(0,12).toUpperCase();
    const row=new Array(sheet.getLastColumn()).fill("");
    const set=(k,v)=>{if(m[k]!==undefined)row[m[k]]=v;};
    set("USER_ID",userId); set("FULL_NAME",fullName); set("EMAIL",email);
    // Submitted role/division are proposals only. ACTIVE=false is mandatory.
    set("ROLE",requestedRole); set("DIVISION",requestedDivision); set("ACTIVE",false);
    set("PASSWORD_SALT",challenge.salt); set("PASSWORD_HASH",passwordVerifier_(derivedKey));
    set("CREATED_AT",new Date()); set("LAST_LOGIN_AT","");
    const rowNumber=Math.max(sheet.getLastRow()+1,table.headerRow+1);
    sheet.getRange(rowNumber,1,1,row.length).setValues([row]);
    cache.remove(key); cache.remove("SA_USERS_TABLE_V1");
    const systemUser={userId:"SYSTEM",fullName:"Registration Service",role:"SYSTEM",division:""};
    audit_("USER_REGISTER",systemUser,"REGISTRATION",userId,"",duplicate?"PENDING_REVIEW":"PENDING",{
      sheetName:SA.USERS_SHEET,rowNumber:rowNumber,fieldKey:"REGISTRATION",
      source:"WEB_APP",requestId:Utilities.getUuid()
    });
    return {registered:true,userId:userId,status:"PENDING",duplicateReview:duplicate,
      message:duplicate?"Pendaftaran diterima untuk pemeriksaan nama dan divisi. Tunggu admin.":"Pendaftaran diterima. Tunggu aktivasi admin."};
  } finally {lock.releaseLock();}
}
function registrationStatus_(payload) {
  const email=String(payload.email||"").trim().toLowerCase();
  if(!email) throw new Error("Email wajib diisi.");
  const t=readUsersTableCached_(), m=t.map;
  const row=t.rows.find(r=>String(r[m.EMAIL]||"").trim().toLowerCase()===email);
  if(!row) return {found:false,status:"NOT_FOUND"};
  return {found:true,userId:String(row[m.USER_ID]||""),active:isActive_(row[m.ACTIVE]),
    status:isActive_(row[m.ACTIVE])?"ACTIVE":"PENDING_OR_INACTIVE"};
}

/* Installable/simple onEdit handler: sync only when an existing USERS row is
   switched to TRUE. Spreadsheet edits cannot reliably identify the editor in
   every Workspace configuration, so audit actor is explicitly SYSTEM. */
function onEdit(e) {
  try {
    if(!e||!e.range) return;
    const sh=e.range.getSheet();
    if(sh.getName()!==SA.USERS_SHEET||e.range.getNumRows()!==1||e.range.getNumColumns()!==1) return;
    const table=readUsersTable_(sh), activeCol=table.map.ACTIVE+1;
    if(e.range.getRow()<=table.headerRow) return;
    const editedKey=Object.keys(table.map).find(k=>table.map[k]+1===e.range.getColumn());
    if(!["ACTIVE","ROLE","DIVISION"].includes(editedKey)) return;
    CacheService.getScriptCache().remove("SA_USERS_TABLE_V1");
    const nowActive=isActive_(sh.getRange(e.range.getRow(),activeCol).getValue());
    const rowValues=sh.getRange(e.range.getRow(),1,1,sh.getLastColumn()).getValues()[0];
    const user={userId:"SYSTEM",fullName:"Spreadsheet Admin",role:"SYSTEM",division:""};
    if(editedKey==="ROLE"||editedKey==="DIVISION") {
      audit_("USER_"+editedKey+"_UPDATED",user,editedKey,String(rowValues[table.map.USER_ID]||""),String(e.oldValue||""),String(e.value||""),{sheetName:SA.USERS_SHEET,rowNumber:e.range.getRow(),fieldKey:editedKey,source:"SHEET_EDIT"});
      if(nowActive) syncEmployeeMasterFromUserRow_(rowValues,table.map);
      return;
    }
    if(nowActive) {
      syncEmployeeMasterFromUserRow_(rowValues,table.map);
      audit_("USER_ACTIVATED",user,"ACTIVE",String(rowValues[table.map.USER_ID]||""),String(e.oldValue||"FALSE"),"TRUE",{
        sheetName:SA.USERS_SHEET,rowNumber:e.range.getRow(),fieldKey:"ACTIVE",source:"SHEET_EDIT"
      });
    } else {
      removeOrDeactivateEmployeeMaster_(String(rowValues[table.map.USER_ID]||""));
      audit_("USER_DEACTIVATED",user,"ACTIVE",String(rowValues[table.map.USER_ID]||""),String(e.oldValue||"TRUE"),"FALSE",{
        sheetName:SA.USERS_SHEET,rowNumber:e.range.getRow(),fieldKey:"ACTIVE",source:"SHEET_EDIT"
      });
    }
  } catch(err) { console.error("SalesApp onEdit sync: "+err.message); }
}
function syncEmployeeMasterFromUserRow_(row,m) {
  const sh=getSheet_("EMPLOYEE_MASTER"), t=readTable_(sh,1), em=t.map;
  ["USER_ID","EMPLOYEE_NAME","EMAIL","DIVISION","ROLE","ACTIVE"].forEach(k=>{
    if(em[k]===undefined) throw new Error("Header EMPLOYEE_MASTER tidak ditemukan: "+k);
  });
  const id=String(row[m.USER_ID]||"");
  if(!id) return;
  const values=sh.getLastRow()>1?sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues():[];
  const index=values.findIndex(r=>String(r[em.USER_ID]||"")===id);
  const target=index<0?new Array(sh.getLastColumn()).fill(""):values[index].slice();
  target[em.USER_ID]=id; target[em.EMPLOYEE_NAME]=row[m.FULL_NAME]; target[em.EMAIL]=row[m.EMAIL];
  target[em.DIVISION]=row[m.DIVISION]; target[em.ROLE]=row[m.ROLE]; target[em.ACTIVE]=true;
  const rowNo=index<0?Math.max(2,sh.getLastRow()+1):index+2;
  if(index<0 || ["USER_ID","EMPLOYEE_NAME","EMAIL","DIVISION","ROLE","ACTIVE"].some(k=>String(values[index][em[k]]??"")!==String(target[em[k]]??"")))
    sh.getRange(rowNo,1,1,target.length).setValues([target]);
}
function removeOrDeactivateEmployeeMaster_(userId) {
  const sh=getSheet_("EMPLOYEE_MASTER"), t=readTable_(sh,1), c=t.map;
  if(c.USER_ID===undefined||c.ACTIVE===undefined) return;
  if(sh.getLastRow()<2) return;
  const values=sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues();
  const i=values.findIndex(r=>String(r[c.USER_ID]||"")===userId);
  if(i>=0) sh.getRange(i+2,c.ACTIVE+1).setValue(false);
}

function assertEmployeeAccess_(user) {
  const role=String(user.role||"").trim().toUpperCase();
  if(["GUEST","DIRECTOR","DIRECTORS","MANAGEMENT","READONLY"].includes(role)) throw new Error("Role akun ini tidak memiliki akses Employee Management.");
}
function employeeSheets_() {
  return {
    activity:{name:"EMPLOYEE_ACTIVITY",headers:["ACTIVITY_ID","ACTIVITY_DATE","USER_ID","EMPLOYEE_NAME","DIVISION","ACTIVITY_TYPE","INQUIRY_PROJECT_NO","PROJECT_NAME","ACTIVITY_DESCRIPTION","START_TIME","END_TIME","ACTIVITY_STATUS","COMPLETION_NOTE","CREATED_AT","UPDATED_AT"]},
    assignments:{name:"EMPLOYEE_ASSIGNMENTS",headers:["ASSIGNMENT_ID","USER_ID","EMPLOYEE_NAME","DIVISION","INQUIRY_PROJECT_NO","PROJECT_NAME","ASSIGNED_BY_USER_ID","ASSIGNED_BY_NAME","ASSIGNED_AT","START_DATE","TARGET_END_DATE","ACTUAL_END_DATE","ASSIGNMENT_STATUS","IS_ACTIVE","COMPLETION_NOTE","UPDATED_AT"]},
    attendance:{name:"EMPLOYEE_ATTENDANCE",headers:["ATTENDANCE_ID","ATTENDANCE_DATE","USER_ID","EMPLOYEE_NAME","DIVISION","PRESENCE_STATUS","NOTE","UPDATED_AT"]},
    visits:{name:"EMPLOYEE_VISITS",headers:["VISIT_ID","VISIT_DATE","USER_ID","EMPLOYEE_NAME","DIVISION","CUSTOMER","VISIT_PURPOSE","DEPARTURE_TIME","RETURN_TIME","VEHICLE_PLATE_NUMBER","VEHICLE_NOTE","VISIT_RESULT","CREATED_AT","UPDATED_AT"]},
    master:{name:"EMPLOYEE_MASTER",headers:["USER_ID","EMPLOYEE_NAME","EMAIL","DIVISION","ROLE","ACTIVE","DEFAULT_VEHICLE_PLATE","JOIN_DATE","NOTES"]}
  };
}
function employeeTable_(key) {
  const spec=employeeSheets_()[key], sh=getSheet_(spec.name), t=readTable_(sh,1);
  spec.headers.forEach(k=>{if(t.map[k]===undefined)throw new Error("Kolom "+k+" tidak ditemukan di "+spec.name);});
  return {sheet:sh,map:t.map,rows:t.rows,headers:spec.headers};
}
function employeeDirectory_() {
  // Reconcile active USERS into EMPLOYEE_MASTER, keyed strictly by USER_ID.
  const users=readUsersTableCached_(), um=users.map;
  users.rows.forEach(r=>{if(isActive_(r[um.ACTIVE])) syncEmployeeMasterFromUserRow_(r,um);});
  const t=employeeTable_("master");
  return t.rows.filter(r=>isActive_(r[t.map.ACTIVE])).map(r=>({
    userId:String(r[t.map.USER_ID]||""),name:String(r[t.map.EMPLOYEE_NAME]||""),
    email:String(r[t.map.EMAIL]||""),division:String(r[t.map.DIVISION]||""),
    role:String(r[t.map.ROLE]||""),defaultPlate:String(r[t.map.DEFAULT_VEHICLE_PLATE]||"")
  }));
}
function employeeDashboard_(payload) {
  const user=requireSession_(payload.sessionToken); assertEmployeeAccess_(user); const dir=employeeDirectory_(), isAdmin=String(user.role).toUpperCase()==="ADMIN";
  const team=dir.filter(e=>isAdmin||e.division.toUpperCase()===String(user.division).toUpperCase());
  const ownActivity=employeeTable_("activity"), ownAttendance=employeeTable_("attendance");
  const activities=ownActivity.rows.filter(r=>String(r[ownActivity.map.USER_ID])===user.userId).slice(-50).reverse().map(r=>employeeRowObject_(r,ownActivity.map));
  const attendance=ownAttendance.rows.filter(r=>String(r[ownAttendance.map.USER_ID])===user.userId).slice(-30).reverse().map(r=>employeeRowObject_(r,ownAttendance.map));
  const at=employeeTable_("assignments");
  const assignments=at.rows.filter(r=>String(r[at.map.USER_ID])===user.userId).slice(-50).reverse().map(r=>employeeRowObject_(r,at.map));
  const canAssign=isAdmin||/DIVISION_HEAD|HEAD_OF_DIVISION|KEPALA_DIVISI/.test(String(user.role).toUpperCase());
  return {directory:team,activities:activities,attendance:attendance,assignments:assignments,canAssign:canAssign,
    vehiclePlates:Array.from(new Set(dir.map(e=>e.defaultPlate).filter(Boolean)))};
}
function employeeRowObject_(r,m) {
  const o={};Object.keys(m).forEach(k=>{const v=r[m[k]];o[k]=v instanceof Date?Utilities.formatDate(v,Session.getScriptTimeZone(),"yyyy-MM-dd"):v;});return o;
}
function employeeSaveActivity_(payload) {
  const user=requireSession_(payload.sessionToken); assertEmployeeAccess_(user); const t=employeeTable_("activity"), data=payload.data||{}, id=String(data.ACTIVITY_ID||"");
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    let rowNo=-1,old=null;
    if(id){const i=t.rows.findIndex(r=>String(r[t.map.ACTIVITY_ID])===id);if(i<0)throw new Error("Aktivitas tidak ditemukan.");old=t.rows[i];if(String(old[t.map.USER_ID])!==user.userId)throw new Error("Anda hanya dapat mengubah aktivitas milik sendiri.");rowNo=i+2;}
    const now=new Date(), activityDate=String(data.ACTIVITY_DATE||"").trim(), type=String(data.ACTIVITY_TYPE||"").trim();
    if(!activityDate||!type)throw new Error("Tanggal dan jenis aktivitas wajib diisi.");
    const allowed=["WORK","MEETING","FIELD_WORK","FOLLOW_UP","OTHER"];
    if(!allowed.includes(type.toUpperCase()))throw new Error("Jenis aktivitas tidak valid.");
    const values=old?old.slice():new Array(t.sheet.getLastColumn()).fill("");
    const set=(k,v)=>{values[t.map[k]]=v;};
    set("ACTIVITY_ID",id||Utilities.getUuid());set("ACTIVITY_DATE",new Date(activityDate+"T12:00:00"));
    set("USER_ID",user.userId);set("EMPLOYEE_NAME",user.fullName);set("DIVISION",user.division);
    ["ACTIVITY_TYPE","INQUIRY_PROJECT_NO","PROJECT_NAME","ACTIVITY_DESCRIPTION","START_TIME","END_TIME","ACTIVITY_STATUS","COMPLETION_NOTE"].forEach(k=>{if(t.map[k]!==undefined)set(k,String(data[k]||""));});
    if(!old)set("CREATED_AT",now);set("UPDATED_AT",now);
    if(old) employeeAuditChanges_(user,t.name,rowNo,old,values,t.map);
    if(old)t.sheet.getRange(rowNo,1,1,values.length).setValues([values]);
    else {rowNo=t.sheet.getLastRow()+1;t.sheet.getRange(rowNo,1,1,values.length).setValues([values]);audit_("EMPLOYEE_ACTIVITY_CREATE",user,"RECORD",id,"","Created",{sheetName:t.name,rowNumber:rowNo,fieldKey:"RECORD"});}
    return {saved:true,id:id||values[t.map.ACTIVITY_ID]};
  } finally {lock.releaseLock();}
}
function employeeAuditChanges_(user,sheetName,rowNo,oldRow,newRow,map) {
  Object.keys(map).forEach(k=>{const a=oldRow[map[k]],b=newRow[map[k]];const av=a instanceof Date?a.toISOString():String(a==null?"":a),bv=b instanceof Date?b.toISOString():String(b==null?"":b);if(av!==bv)audit_("EMPLOYEE_RECORD_UPDATE",user,k,String(newRow[map.ACTIVITY_ID]||newRow[map.VISIT_ID]||""),av,bv,{sheetName:sheetName,rowNumber:rowNo,fieldKey:k});});
}
function employeeDateKey_(value) {
  if(value instanceof Date) return Utilities.formatDate(value,Session.getScriptTimeZone(),"yyyy-MM-dd");
  return String(value||"").trim().slice(0,10);
}
function employeeSaveAttendance_(payload) {
  const user=requireSession_(payload.sessionToken); assertEmployeeAccess_(user); const t=employeeTable_("attendance"),d=payload.data||{};
  const date=String(d.ATTENDANCE_DATE||"").trim(),status=String(d.PRESENCE_STATUS||"").toUpperCase();
  if(!date||!["OFFICE","EXTERNAL_VISIT","LEAVE","SICK","OFF"].includes(status))throw new Error("Tanggal atau status kehadiran tidak valid.");
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const i=t.rows.findIndex(r=>String(r[t.map.USER_ID])===user.userId&&employeeDateKey_(r[t.map.ATTENDANCE_DATE])===date);
    const values=i>=0?t.rows[i].slice():new Array(t.sheet.getLastColumn()).fill("");
    const set=(k,v)=>values[t.map[k]]=v;
    set("ATTENDANCE_ID",i>=0?values[t.map.ATTENDANCE_ID]:Utilities.getUuid());set("ATTENDANCE_DATE",new Date(date+"T12:00:00"));
    set("USER_ID",user.userId);set("EMPLOYEE_NAME",user.fullName);set("DIVISION",user.division);set("PRESENCE_STATUS",status);set("NOTE",String(d.NOTE||""));set("UPDATED_AT",new Date());
    const rowNo=i>=0?i+2:t.sheet.getLastRow()+1;t.sheet.getRange(rowNo,1,1,values.length).setValues([values]);
    if(i>=0)employeeAuditChanges_(user,t.name,rowNo,t.rows[i],values,t.map);else audit_("EMPLOYEE_ATTENDANCE_CREATE",user,"RECORD",values[t.map.ATTENDANCE_ID],"","Created",{sheetName:t.name,rowNumber:rowNo,fieldKey:"RECORD"});
    return {saved:true};
  }finally{lock.releaseLock();}
}
function employeeSaveVisit_(payload) {
  const user=requireSession_(payload.sessionToken); assertEmployeeAccess_(user); const t=employeeTable_("visits"),d=payload.data||{};
  const date=String(d.VISIT_DATE||"").trim();if(!date||!String(d.CUSTOMER||"").trim())throw new Error("Tanggal dan customer wajib diisi.");
  const values=new Array(t.sheet.getLastColumn()).fill(""),id=Utilities.getUuid(),now=new Date();
  const set=(k,v)=>values[t.map[k]]=v;
  set("VISIT_ID",id);set("VISIT_DATE",new Date(date+"T12:00:00"));set("USER_ID",user.userId);set("EMPLOYEE_NAME",user.fullName);set("DIVISION",user.division);
  ["CUSTOMER","VISIT_PURPOSE","DEPARTURE_TIME","RETURN_TIME","VEHICLE_PLATE_NUMBER","VEHICLE_NOTE","VISIT_RESULT"].forEach(k=>set(k,String(d[k]||"")));
  set("CREATED_AT",now);set("UPDATED_AT",now);
  const rowNo=t.sheet.getLastRow()+1;t.sheet.getRange(rowNo,1,1,values.length).setValues([values]);
  audit_("EMPLOYEE_VISIT_CREATE",user,"RECORD",id,"","Created",{sheetName:t.name,rowNumber:rowNo,fieldKey:"RECORD"});
  return {saved:true,id:id};
}
function employeeAssign_(payload) {
  const user=requireSession_(payload.sessionToken); assertEmployeeAccess_(user); const admin=String(user.role).toUpperCase()==="ADMIN";
  const head=/DIVISION_HEAD|HEAD_OF_DIVISION|KEPALA_DIVISI/.test(String(user.role).toUpperCase());
  if(!admin&&!head)throw new Error("Hanya Admin atau Kepala Divisi yang dapat memberikan penugasan.");
  const d=payload.data||{},targetId=String(d.USER_ID||"");
  const target=employeeDirectory_().find(e=>e.userId===targetId);
  if(!target)throw new Error("Karyawan aktif tidak ditemukan.");
  if(!admin&&target.division.toUpperCase()!==String(user.division).toUpperCase())throw new Error("Kepala divisi hanya dapat menugaskan karyawan dari divisinya sendiri.");
  const t=employeeTable_("assignments"),values=new Array(t.sheet.getLastColumn()).fill(""),id=Utilities.getUuid(),now=new Date();
  const set=(k,v)=>values[t.map[k]]=v;
  set("ASSIGNMENT_ID",id);set("USER_ID",target.userId);set("EMPLOYEE_NAME",target.name);set("DIVISION",target.division);
  ["INQUIRY_PROJECT_NO","PROJECT_NAME","START_DATE","TARGET_END_DATE","COMPLETION_NOTE"].forEach(k=>set(k,String(d[k]||"")));
  set("ASSIGNED_BY_USER_ID",user.userId);set("ASSIGNED_BY_NAME",user.fullName);set("ASSIGNED_AT",now);set("ASSIGNMENT_STATUS","ASSIGNED");set("IS_ACTIVE",true);set("UPDATED_AT",now);
  const rowNo=t.sheet.getLastRow()+1;t.sheet.getRange(rowNo,1,1,values.length).setValues([values]);
  audit_("EMPLOYEE_ASSIGN",user,"RECORD",id,"","Assigned to "+target.name,{sheetName:t.name,rowNumber:rowNo,fieldKey:"RECORD"});
  return {assigned:true,id:id};
}
function employeeUpdateAssignment_(payload) {
  const user=requireSession_(payload.sessionToken); assertEmployeeAccess_(user); const t=employeeTable_("assignments"),id=String(payload.assignmentId||""),status=String(payload.status||"").toUpperCase();
  if(!["ASSIGNED","IN_PROGRESS","ON_HOLD","COMPLETED","CANCELLED"].includes(status))throw new Error("Status penugasan tidak valid.");
  const i=t.rows.findIndex(r=>String(r[t.map.ASSIGNMENT_ID])===id);if(i<0)throw new Error("Penugasan tidak ditemukan.");
  const old=t.rows[i],isOwner=String(old[t.map.USER_ID])===user.userId;
  const isAdmin=String(user.role).toUpperCase()==="ADMIN",isHead=/DIVISION_HEAD|HEAD_OF_DIVISION|KEPALA_DIVISI/.test(String(user.role).toUpperCase());
  if(!isOwner&&!isAdmin&&!(isHead&&String(old[t.map.DIVISION]).toUpperCase()===String(user.division).toUpperCase()))throw new Error("Tidak memiliki izin mengubah penugasan ini.");
  const values=old.slice();values[t.map.ASSIGNMENT_STATUS]=status;values[t.map.COMPLETION_NOTE]=String(payload.note||"");values[t.map.IS_ACTIVE]=!["COMPLETED","CANCELLED"].includes(status);values[t.map.UPDATED_AT]=new Date();
  if(status==="COMPLETED")values[t.map.ACTUAL_END_DATE]=new Date();
  const rowNo=i+2;t.sheet.getRange(rowNo,1,1,values.length).setValues([values]);
  employeeAuditChanges_(user,t.name,rowNo,old,values,t.map);return {updated:true};
}
function employeeHistory_(payload) {
  const user=requireSession_(payload.sessionToken); assertEmployeeAccess_(user); const isAdmin=String(user.role).toUpperCase()==="ADMIN";
  const targetId=String(payload.userId||user.userId);
  if(targetId!==user.userId&&!isAdmin)throw new Error("Riwayat hanya dapat dilihat oleh pemilik atau Admin.");
  const sh=getSheet_(SA.LOG_SHEET),h=activityLogHeader_(sh),m=h.map,last=sh.getLastRow();
  if(last<=h.row)return {items:[]};
  const rows=sh.getRange(h.row+1,1,last-h.row,sh.getLastColumn()).getValues();
  const items=rows.filter(r=>String(r[m.USER_ID]||"")===targetId&&/^EMPLOYEE_/.test(String(r[m.ACTION]||""))).map(r=>employeeRowObject_(r,m)).reverse().slice(0,150);
  return {items:items};
}
function employeeVehicleSuggestions_(payload) {
  const user=requireSession_(payload.sessionToken); assertEmployeeAccess_(user); const dir=employeeDirectory_();
  const plates=Array.from(new Set(dir.map(e=>e.defaultPlate).filter(Boolean)));
  return {plates:plates};
}
