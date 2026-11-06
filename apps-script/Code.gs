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
    if (keyIndex === undefined) {
      throw new Error("Pemetaan kolom INQUIRY PROJECT NO tidak tersedia.");
    }

    const validRows = table.rows.filter(row => String(row[keyIndex] || "").trim());
    const records = validRows.map(row => ({
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

    cached = {
      records: records,
      diagnostics: {
        sheetName: sheet.getName(),
        headerRow: table.headerRow,
        lastRow: table.lastDataRow || sheet.getLastRow(),
        lastColumn: 29,
        inquiryKeyColumn: 5,
        nonEmptyInquiryKeys: records.length
      }
    };

    // CacheService has a per-item size limit. If the dataset is too large,
    // skip caching rather than failing the dashboard request.
    try {
      const serialized = JSON.stringify(cached);
      if (serialized.length < 90000) cache.put(cacheKey, serialized, SA.DASHBOARD_CACHE_SECONDS);
    } catch (e) {
      // Cache is an optimization only; live data remains usable.
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

function readUsersTableCached_() {
  const cache = CacheService.getScriptCache();
  const key = "SA_USERS_TABLE_V1";
  const value = cache.get(key);
  if (value) {
    try { return JSON.parse(value); } catch (e) { cache.remove(key); }
  }
  const table = readUsersTable_(getSheet_(SA.USERS_SHEET));
  cache.put(key, JSON.stringify(table), 30);
  return table;
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
