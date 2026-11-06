# Apps Script backend

These files belong in the Apps Script project opened from the Google Sheet itself (**Extensions → Apps Script**).

## Dashboard analytics (Stage 6)

The dashboard now renders eight Excel-inspired visualizations from live inquiry records:
1. Kind of Works — `JENIS EQUIPMENT` (column D).
2. Inquiry Rank — `INQUIRY RANK` (column J).
3. Project Rank — 100% stacked distribution of inquiry rank by equipment.
4. Requester — `DEPARTMENT` (column G).
5. Planning Status — `PLANING JOB` (column V; values such as FINISHED / NOT STARTED).
6. Project Status — `STATUS PROJECT` (column AB). This is intentionally labeled Project Status because the source Excel chart title "Quotation Status" actually plots project-status categories.
7. Finished Planning vs Quotation Released — compares FINISHED in column V with RELEASED in column Y.
8. Customer Specification Document — `TECHNICAL SPEC. DARI CUSTOMER` (column H).

Planner and Sales PIC performance charts remain available. Selecting a category in supported charts filters the inquiry register; use "Hapus filter grafik" to clear the chart filter. All counts are recalculated from records returned by Apps Script, not copied from the workbook's legacy chart formulas.

## Files
- `Code.gs`: API routing, challenge-response login, session validation, dashboard/detail reads, division-based create/edit writes, audit log, and Owner password menu.
- `Auth.gs`: PBKDF2-HMAC-SHA256 used when the Owner creates or resets a password.

## Script Properties
Set this under **Project Settings → Script Properties**:
- `OWNER_EMAIL`: exact Google account email of the spreadsheet Owner. It restricts the password-reset menu.
- `PASSWORD_PEPPER`: generated automatically the first time the Owner sets/resets a password. Keep it only in Script Properties; never copy it to GitHub, the spreadsheet, or frontend code.

## Deployment and password migration
1. Confirm sheet names: `Inquiry sheet`, `USERS`, and `ACTIVITY_LOG`.
2. Confirm the inquiry data starts at row 7, with inquiry project number in column E.
3. Confirm USERS has headers including USER_ID, FULL_NAME, EMAIL, ROLE, DIVISION, ACTIVE, PASSWORD_SALT, and PASSWORD_HASH.
4. Confirm ACTIVITY_LOG exists. Its headers are created automatically when the sheet is empty.
5. Copy the latest `Code.gs` and `Auth.gs` from this repository into the bound Apps Script project. Save.
6. Run `onOpen` once and approve spreadsheet permissions. Reload the spreadsheet; the **SalesApp Owner** menu should appear.
7. **After deploying this authentication update, reset each existing user's password once** from SalesApp Owner → Set / Reset Password User. This migrates the stored verifier to the peppered `v2$` format. Existing unpeppered hashes are deliberately rejected rather than accepted as pass-the-hash credentials.
8. Deploy → Manage deployments → Edit the existing Web App deployment → select **New version** → Deploy. Keep the existing `/exec` URL in the GitHub `config.js`.

## Performance behavior
- PBKDF2-HMAC-SHA256 (120,000 iterations) now runs in the browser through Web Crypto, not in Apps Script during each login.
- The browser sends a derived key plus a one-use HMAC challenge proof over HTTPS; the plaintext password is not sent to Apps Script.
- The database stores a peppered verifier (`v2$` prefix). The pepper is stored in Script Properties, not in the spreadsheet.
- USERS table reads are cached for 30 seconds and reused by login/session checks. Owner password reset clears this cache.
- Inquiry dashboard records are cached for 15 seconds. The **Muat ulang** button bypasses that cache and reads the current sheet data. Duplicate refresh requests are blocked while one is in progress.
- API responses include server processing time. The dashboard displays browser/network time, server time, PBKDF2 time, USERS cache/read time, proof verification time, and audit write time after login.

## Division-based input and edit permissions

The website writes directly to the existing `Inquiry sheet`; Google Sheets remains the live database. Backend permissions are derived from the authenticated USERS row and checked again for every write. Browser-provided role/division values are never trusted.

- ADMIN can create inquiries and edit every business field. `INQUIRY PROJECT NO` is intentionally immutable after creation because it is the record key used by the dashboard and audit history.
- SALES can create inquiries and edit the Sales-owned fields.
- ENGINEERING / PLANNER can edit Planner-owned fields.
- WORKSHOP / PPIC can edit `PLANING JOB`.
- PROJECT can edit `DATA DELIVERY`.
- MAINTENANCE can edit `MAINTENANCE UPDATE`, stored in the automatically added column AD of `Inquiry sheet`. The script adds the column header in row 6 if AD is empty; it stops rather than overwrite a different existing AD header.
- MANAGEMENT, DIRECTORS, and GUEST remain read-only.
- Create/edit writes invalidate the dashboard cache. The next dashboard/detail read gets saved values from the spreadsheet.
- Column U is reserved for the existing progress-bar formula. Creating a new inquiry writes A:T and V:AD separately and copies the previous row's U formula where available, so the formula is not overwritten.
- Every changed field is written to ACTIVITY_LOG with actor, timestamp, inquiry number, row, field, old value, new value, request ID, and source.

## Security / scope
- No self-registration.
- User lookup is by USER_ID or email.
- ACTIVE is checked during login and again for every protected API request. USERS cache means manual changes can take up to 30 seconds to take effect; Owner password reset invalidates it immediately.
- Role and division are loaded from USERS, never trusted from the browser.
- Sessions expire after six hours and are stored in Apps Script cache.
- Guest receives aggregate counts only, not record-level data.
- Write endpoints are enabled for the division mappings listed above. Validate these mappings with each division before production rollout.
- Successful login/logout and each inquiry create/update are audited. Do not allow ordinary dashboard users to edit the ACTIVITY_LOG sheet.
- Do not share spreadsheet access with ordinary dashboard users.

## Verification checklist
Test with a non-owner account:
- Correct password succeeds.
- Wrong password and unknown identity are rejected.
- A disabled account is rejected.
- Guest receives only KPI aggregates.
- Logout invalidates the session.
- A forced refresh bypasses the 15-second dashboard cache.
- Create an inquiry with a test Sales account and verify the new row appears in `Inquiry sheet`.
- Edit a Sales-owned field with Sales, a Planner-owned field with Planner, and verify other divisions are rejected by the API.
- Edit any business field with ADMIN and verify the spreadsheet changes.
- Verify a Maintenance update is stored in column AD and the column U progress formula remains intact on newly created rows.
- Verify each changed field produces an ACTIVITY_LOG entry with the correct old/new values.
- Existing users complete the one-time Owner password reset after this authentication update.

Back up the workbook before production use.

## ACTIVITY_LOG schema
The audit writer maps values by header name, not by column position. The current supported schema is:
`LOG_ID, TIMESTAMP, USER_ID, USER_NAME, ROLE, DIVISION, ACTION, INQUIRY_PROJECT_NO, SHEET_NAME, ROW_NUMBER, FIELD_KEY, OLD_VALUE, NEW_VALUE, REQUEST_ID, SOURCE`.

- Every event receives a unique UUID in LOG_ID and REQUEST_ID.
- Login/logout events use SHEET_NAME=`Authentication`; they do not populate ROW_NUMBER or FIELD_KEY.
- Inquiry changes can supply inquiry number, sheet, row, field, old value and new value through the optional audit details object.
- SOURCE defaults to `WEB_APP`.
- Existing historical rows are not rewritten automatically. Their old 10-column layout was written under a different header schema; review or back them up before any manual cleanup.
- The writer validates required headers and uses a script lock before writing a complete row, preventing concurrent events from colliding.
