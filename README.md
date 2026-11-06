# SalesApp — Inquiry Control Dashboard

SalesApp is a web dashboard for the existing Inquiry Control Sheet.

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

## Architecture

- **Frontend:** static website hosted by GitHub Pages.
- **Application API:** Google Apps Script bound to the converted Google Spreadsheet.
- **Data:** Google Sheets. The workbook remains the source of truth.
- **Communication:** GitHub Pages calls the Apps Script Web App directly. Requests use a simple `text/plain` POST body to avoid a CORS preflight; browser response access still requires a live test.

The frontend must never connect directly to Google Sheets or contain spreadsheet credentials, passwords, password hashes, or backend secrets.

## Current repository layout

- `frontend/` — dashboard interface.
- `apps-script/` — Google Apps Script backend source. Copy these files into the Apps Script project attached to the converted spreadsheet.

## Important security status

This repository is currently public. Do not commit spreadsheet data, deployment URLs containing tokens, passwords, hashes, or any secret. Consider changing repository visibility to **Private** before adding further internal business logic. GitHub Pages availability for private repositories depends on the GitHub plan and repository settings; making the repository private does not automatically make a deployed website private.

The application is not production-ready until Apps Script is deployed and direct browser CORS, login, role, and audit tests pass.

## Setup sequence

1. Open the Google Sheet converted from `KAIZEN_INQUIRY_CONTROL_v2.xlsx`.
2. Open **Extensions → Apps Script**. This must be the script project bound to that spreadsheet.
3. Copy the files from `apps-script/` into the Apps Script editor, preserving filenames. Save.
4. Deploy Apps Script as a Web App. Execute as the spreadsheet owner. The Web App must accept requests from anyone so the custom login can be used; spreadsheet users must not be granted direct spreadsheet access. All data actions must validate the app session and role.
5. Paste the deployed `/exec` URL into the root `config.js` as `APPS_SCRIPT_URL` (the root folder is the GitHub Pages source).
6. Open `cors-test.html` from the published site and run the connectivity test. Do not proceed to production until the test passes in the browser console.
7. Enable GitHub Pages using the repository root (`/`) because the published `index.html`, `app.js`, `style.css`, and `config.js` are in the root.
8. Test with a non-production test account before creating real users.

## Workbook requirements

The backend expects these sheet names and header rows:

- `Inquiry sheet`: header row 6, data from row 7.
- `USERS`: row 1 contains the headers from the workbook template.
- `ACTIVITY_LOG`: row 1 contains the audit headers.

The backend uses `INQUIRY PROJECT NO` as the record key. It does not use the inconsistent sequence number in column A.

For direct communication testing, publish the site and open `https://<your-github-pages-domain>/cors-test.html`. Enter the Apps Script Web App `/exec` URL and run the test. This must pass before real users are invited.

## Live input and editing

Google Sheets is the active database, not an export-only source. The website now includes:
- Add inquiry for ADMIN and SALES.
- Edit form in the inquiry detail view.
- ADMIN access to all business fields (the inquiry number is immutable after creation because it is the record key).
- Division-based field permissions enforced by Apps Script on every write.
- Maintenance update stored in column AD as MAINTENANCE UPDATE; Apps Script adds this header at row 6 only if column AD is available.
- Writes to the same Inquiry sheet, cache invalidation, and per-field audit records in ACTIVITY_LOG.
- Column U progress-bar formula protection when creating a new inquiry.

## Deployment after a code update

GitHub Pages updates the frontend automatically after commits. Apps Script is separate and must be updated manually:
1. Open the spreadsheet → Extensions → Apps Script.
2. Replace the complete contents of Apps Script Code.gs with the repository's latest apps-script/Code.gs.
3. Keep the existing Auth.gs code (or replace it with the repository's matching apps-script/Auth.gs).
4. Save, then Deploy → Manage deployments → Edit → New version → Deploy.
5. Keep the same Web App /exec URL in the root config.js.
6. Test first with a test inquiry and verify the changed cells and audit entries before allowing all users to use the editor.

Do not copy the frontend files into Apps Script. Do not change the spreadsheet ID or the existing /exec URL during this update.
