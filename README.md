# SalesApp — Inquiry Control Dashboard

SalesApp is a web dashboard for the existing Inquiry Control Sheet.

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
5. Paste the deployed `/exec` URL into `frontend/config.js` as `APPS_SCRIPT_URL`.
6. Open `cors-test.html` from the published site and run the connectivity test. Do not proceed to production until the test passes in the browser console.
8. Enable GitHub Pages for the repository using the `/frontend` folder if the repository settings support it, or publish the frontend folder through the configured Pages source.
9. Test with a non-production test account before creating real users.

## Workbook requirements

The backend expects these sheet names and header rows:

- `Inquiry sheet`: header row 6, data from row 7.
- `USERS`: row 1 contains the headers from the workbook template.
- `ACTIVITY_LOG`: row 1 contains the audit headers.

The backend uses `INQUIRY PROJECT NO` as the record key. It does not use the inconsistent sequence number in column A.

For direct communication testing, publish the site and open `https://<your-github-pages-domain>/cors-test.html`. Enter the Apps Script Web App `/exec` URL and run the test. This must pass before real users are invited.

## Known limitation in this initial scaffold

The dashboard currently provides a working interface shell and API connection diagnostics. It does not yet enable business-data edits. Division-specific field ownership, the final status vocabulary, and the maintenance/workshop/project update schema must be confirmed before write endpoints are enabled. This is deliberate: allowing writes against an unvalidated mapping could corrupt the existing workbook.
