# SalesApp — Inquiry Control Dashboard

SalesApp is a web dashboard for the existing Inquiry Control Sheet.

## Architecture

- **Frontend:** static website hosted by GitHub Pages.
- **Application API:** Google Apps Script bound to the converted Google Spreadsheet.
- **Data:** Google Sheets. The workbook remains the source of truth.
- **API bridge:** Cloudflare Worker, used to provide a controlled browser-facing API and CORS handling between GitHub Pages and Apps Script.

The frontend must never connect directly to Google Sheets or contain spreadsheet credentials, passwords, password hashes, or backend secrets.

## Current repository layout

- `frontend/` — dashboard interface.
- `cloudflare-worker/` — API proxy template. Its secret values must be configured in Cloudflare, never committed here.
- `apps-script/` — Google Apps Script backend source. Copy these files into the Apps Script project attached to the converted spreadsheet.

## Important security status

This repository is currently public. Do not commit spreadsheet data, deployment URLs containing tokens, passwords, hashes, or any secret. Consider changing repository visibility to **Private** before adding further internal business logic. GitHub Pages availability for private repositories depends on the GitHub plan and repository settings; making the repository private does not automatically make a deployed website private.

The application is not production-ready until the Apps Script and Worker are deployed, their shared secret is configured outside source control, and the login/role/audit tests are completed.

## Setup sequence

1. Open the Google Sheet converted from `KAIZEN_INQUIRY_CONTROL_v2.xlsx`.
2. Open **Extensions → Apps Script**. This must be the script project bound to that spreadsheet.
3. Copy the files from `apps-script/` into the Apps Script editor, preserving filenames. Save.
4. Configure the backend secret in Apps Script Project Settings → Script Properties as `WORKER_SHARED_SECRET`. Generate a long random value; do not put it in this repository or in the frontend.
5. Deploy Apps Script as a Web App. Execute as the spreadsheet owner. Access should be restricted to the intended bridge/account policy; do not share the spreadsheet itself with dashboard users.
6. Deploy `cloudflare-worker/worker.js` as a Cloudflare Worker. Add the Apps Script Web App URL as Worker variable `APPS_SCRIPT_URL`, and add the same random secret as secret `WORKER_SHARED_SECRET`.
7. Set the deployed Worker URL in `frontend/config.js`.
8. Enable GitHub Pages for the repository using the `/frontend` folder if the repository settings support it, or publish the frontend folder through the configured Pages source.
9. Test with a non-production test account before creating real users.

## Workbook requirements

The backend expects these sheet names and header rows:

- `Inquiry sheet`: header row 6, data from row 7.
- `USERS`: row 1 contains the headers from the workbook template.
- `ACTIVITY_LOG`: row 1 contains the audit headers.

The backend uses `INQUIRY PROJECT NO` as the record key. It does not use the inconsistent sequence number in column A.

## Known limitation in this initial scaffold

The dashboard currently provides a working interface shell and API connection diagnostics. It does not yet enable business-data edits. Division-specific field ownership, the final status vocabulary, and the maintenance/workshop/project update schema must be confirmed before write endpoints are enabled. This is deliberate: allowing writes against an unvalidated mapping could corrupt the existing workbook.
