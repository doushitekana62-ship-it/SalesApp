# Apps Script backend

These files belong in the Apps Script project opened from the Google Sheet itself (**Extensions → Apps Script**).

## Files
- `Code.gs`: API routing, login, session validation, dashboard read-only endpoint, audit log, owner password menu.
- `Auth.gs`: PBKDF2-HMAC-SHA256 password hashing.

## Script Properties
Set these under **Project Settings → Script Properties**:
- `WORKER_SHARED_SECRET`: a long random secret shared only with the Cloudflare Worker.
- `OWNER_EMAIL`: the exact Google account email of the spreadsheet Owner, used to restrict the password-reset menu.

Do not put these values into GitHub or frontend code.

## First deployment
1. Confirm sheet names: `Inquiry sheet`, `USERS`, `ACTIVITY_LOG`.
2. Confirm `Inquiry sheet` headers are on row 6 and data begins row 7.
3. Confirm USERS headers are on row 1, including USER_ID, FULL_NAME, EMAIL, ROLE, DIVISION, ACTIVE, PASSWORD_SALT, PASSWORD_HASH.
4. Confirm ACTIVITY_LOG exists. The first login creates its header if the sheet is empty.
5. Save and run `onOpen` once from Apps Script; approve the spreadsheet permissions. Reload the spreadsheet. The **SalesApp Owner** menu should appear.
6. Set a password for USER_ID `25022` from the Owner menu. The sample salt `12345678` in the sheet is replaced with a random salt and the password hash is written. Password is not stored in a cell.
7. Deploy as Web App, execute as **Me (Owner)**. Use the deployed URL only in the Cloudflare Worker variable `APPS_SCRIPT_URL`.

## Security / scope
- No self-registration.
- User lookup is by USER_ID or email.
- ACTIVE is checked at login and again for every protected API request.
- Role and division are loaded from USERS, never trusted from the browser.
- Sessions expire after six hours and are stored in Apps Script cache.
- Guest receives aggregate counts only, not record-level data.
- This first backend release is read-only for inquiry data. Division update/write endpoints are intentionally not enabled until field ownership and required columns are approved.
- Audit entries are created for successful login/logout. When write endpoints are added, each field update must log old/new values and record key.
- Do not share spreadsheet access with ordinary dashboard users.

## Important
This is an initial implementation. Before production use, verify login, session expiry, disabled-account rejection, guest data restriction, and Worker-to-Apps-Script connectivity with a test account. A spreadsheet owner should also keep a backup of the workbook.
