# Apps Script backend

These files belong in the Apps Script project opened from the Google Sheet itself (**Extensions → Apps Script**).

## Files
- `Code.gs`: API routing, challenge-response login, session validation, dashboard cache, audit log, and Owner password menu.
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

## Security / scope
- No self-registration.
- User lookup is by USER_ID or email.
- ACTIVE is checked during login and again for every protected API request. USERS cache means manual changes can take up to 30 seconds to take effect; Owner password reset invalidates it immediately.
- Role and division are loaded from USERS, never trusted from the browser.
- Sessions expire after six hours and are stored in Apps Script cache.
- Guest receives aggregate counts only, not record-level data.
- Inquiry endpoint remains read-only until division field ownership and required columns are approved.
- Successful login/logout are audited. Future write endpoints must log actor, timestamp, field, record key, old value, and new value.
- Do not share spreadsheet access with ordinary dashboard users.

## Verification checklist
Test with a non-owner account:
- Correct password succeeds.
- Wrong password and unknown identity are rejected.
- A disabled account is rejected.
- Guest receives only KPI aggregates.
- Logout invalidates the session.
- A forced refresh bypasses the 15-second dashboard cache.
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
