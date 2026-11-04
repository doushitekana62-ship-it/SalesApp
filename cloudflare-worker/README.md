# Cloudflare Worker bridge

Create a Worker and paste `worker.js`.

Configure:
- Variable `APPS_SCRIPT_URL`: the deployed Apps Script Web App URL.
- Secret `WORKER_SHARED_SECRET`: a long random secret. Store the identical value in Apps Script Script Properties under `WORKER_SHARED_SECRET`.
- Optional variable `ALLOWED_ORIGIN`: the exact GitHub Pages origin, for example `https://doushitekana62-ship-it.github.io`. Do not include a path. Avoid `*` for the final deployment.

The Worker is a transport/CORS bridge, not the authentication system. Apps Script must validate the shared secret, user session, account status, and role on every request. Do not expose the shared secret in frontend files.