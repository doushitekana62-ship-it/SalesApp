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
  INQUIRY_HEADER_SCAN_ROWS: 20,
  INQUIRY_FIRST_ROW: 7,
  SESSION_TTL_SECONDS: 21600
});

function doGet(e) {
  // Public health check only; never return business data from GET/JSONP.
  return json_({ ok: true, data: { service: "SalesApp API", status: "online", corsTest: true } });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e && e.postData && e.postData.contents || "{}");
    const action = String(payload.action || "");
    let data;
    if (action === "ping") data = { service: "SalesApp API", status: "online", timestamp: new Date().toISOString() };
    else if (action === "login") data = login_(payload);
    else if (action === "me") data = requireSession_(payload.sessionToken);
    else if (action === "logout") data = logout_(payload);
    else if (action === "dashboard") data = dashboard_(payload);
    else throw new Error("Aksi tidak dikenal.");

    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
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
  const salt = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  const hash = pbkdf2Hex_(password, salt, 120000);
  const rowNumber = table.headerRow + idx + 1;
  sheet.getRange(rowNumber, saltCol + 1).setValue(salt);
  sheet.getRange(rowNumber, hashCol + 1).setValue(hash);
  SpreadsheetApp.flush();
  ui.alert("Password berhasil disimpan untuk USER_ID " + userId + ". Password asli tidak disimpan di spreadsheet.");
}

function login_(payload) {
  const identity = String(payload.identity || "").trim().toLowerCase();
  const password = String(payload.password || "");
  if (!identity || !password) throw new Error("USER_ID/email dan password wajib diisi.");

  const table = readUsersTable_(getSheet_(SA.USERS_SHEET));
  const required = ["USER_ID", "EMAIL", "FULL_NAME", "ROLE", "DIVISION", "ACTIVE", "PASSWORD_SALT", "PASSWORD_HASH"];
  required.forEach(k => { if (table.map[k] === undefined) throw new Error("Kolom USERS tidak ditemukan: " + k); });

  const userRow = table.rows.find(row =>
    String(row[table.map.USER_ID] || "").trim().toLowerCase() === identity ||
    String(row[table.map.EMAIL] || "").trim().toLowerCase() === identity
  );
  if (!userRow) throw new Error("Akun tidak ditemukan atau tidak aktif.");
  const active = String(userRow[table.map.ACTIVE]).trim().toLowerCase();
  if (!["true", "yes", "1", "active", "aktif"].includes(active)) throw new Error("Akun tidak ditemukan atau tidak aktif.");

  const salt = String(userRow[table.map.PASSWORD_SALT] || "");
  const storedHash = String(userRow[table.map.PASSWORD_HASH] || "");
  if (!salt || !storedHash || !safeEqual_(pbkdf2Hex_(password, salt, 120000), storedHash)) {
    throw new Error("USER_ID/email atau password salah.");
  }

  const user = publicUser_(userRow, table.map);
  const token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put("SA_SESSION_" + token, JSON.stringify(user), SA.SESSION_TTL_SECONDS);
  audit_("LOGIN", user, "Authentication", "", "", "Login berhasil");
  return { sessionToken: token, user: user };
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
  const table = readUsersTable_(getSheet_(SA.USERS_SHEET));
  const row = table.rows.find(r => String(r[table.map.USER_ID]) === String(session.userId));
  if (!row || !isActive_(row[table.map.ACTIVE])) {
    CacheService.getScriptCache().remove("SA_SESSION_" + token);
    throw new Error("Akun tidak aktif atau tidak lagi tersedia.");
  }
  return publicUser_(row, table.map);
}

function dashboard_(payload) {
  const user = requireSession_(payload.sessionToken);
  const sheet = getSheet_(SA.INQUIRY_SHEET);
  const table = readInquiryTable_(sheet);
  const keyIndex = table.map[normalizeHeader_("INQUIRY PROJECT NO")];
  if (keyIndex === undefined) {
    throw new Error("Header INQUIRY PROJECT NO tidak ditemukan pada baris " +
      table.headerRow + " di sheet '" + SA.INQUIRY_SHEET +
      "'. Header terbaca: " + Object.keys(table.map).join(" | "));
  }
  const validRows = table.rows.filter(row => String(row[keyIndex] || "").trim());
  const diagnostics = {
    sheetName: sheet.getName(),
    headerRow: table.headerRow,
    lastRow: sheet.getLastRow(),
    lastColumn: sheet.getLastColumn(),
    inquiryKeyColumn: keyIndex + 1,
    nonEmptyInquiryKeys: validRows.length
  };
  const records = validRows
    .map(row => ({
      inquiryNo: cell_(row, table.map, "INQUIRY PROJECT NO"),
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

  if (String(user.role).toUpperCase() === "GUEST") {
    return {
      guest: true,
      summary: {
        total: records.length,
        quotationReleased: records.filter(r => r.quotationNo).length,
        getOrder: records.filter(r => String(r.projectStatus).toUpperCase() === "GET ORDER").length,
        lost: records.filter(r => String(r.projectStatus).toUpperCase() === "LOST").length
      },
      records: [],
      diagnostics: diagnostics
    };
  }
  return { guest: false, summary: null, records: records, diagnostics: diagnostics };
}

function audit_(action, user, field, recordKey, oldValue, newValue) {
  const sheet = getSheet_(SA.LOG_SHEET);
  const headers = ["TIMESTAMP", "USER_ID", "FULL_NAME", "ROLE", "DIVISION", "ACTION", "FIELD", "RECORD_KEY", "OLD_VALUE", "NEW_VALUE"];
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  sheet.appendRow([
    new Date(),
    user ? user.userId : "",
    user ? user.fullName : "",
    user ? user.role : "",
    user ? user.division : "",
    action,
    field,
    recordKey,
    oldValue,
    newValue
  ]);
}

/**
 * Constant-time string comparison for password hashes.
 */
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
  const scanRows = Math.min(SA.INQUIRY_HEADER_SCAN_ROWS, sheet.getLastRow());
  const lastCol = sheet.getLastColumn();
  if (!scanRows || !lastCol) throw new Error("Sheet Inquiry sheet kosong.");

  const candidates = sheet.getRange(1, 1, scanRows, lastCol).getDisplayValues();
  for (let i = 0; i < candidates.length; i++) {
    const normalized = candidates[i].map(normalizeHeader_);
    if (normalized.includes("INQUIRY PROJECT NO") && normalized.includes("CUSTOMER")) {
      const table = readTable_(sheet, i + 1);
      table.headerRow = i + 1;
      return table;
    }
  }

  const inspected = candidates.map((row, i) =>
    "row " + (i + 1) + ": " + row.map(normalizeHeader_).filter(Boolean).join(" | ")
  ).filter(line => line.indexOf("INQUIRY") >= 0 || line.indexOf("CUSTOMER") >= 0);

  throw new Error("Header lengkap Inquiry sheet tidak ditemukan dalam " + scanRows +
    " baris pertama. Dibutuhkan INQUIRY PROJECT NO dan CUSTOMER pada baris yang sama. " +
    "Baris terkait: " + (inspected.join(" || ") || "tidak ada header terkait"));
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
  return String(value || "").replace(/\\s+/g, " ").trim().toUpperCase();
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
