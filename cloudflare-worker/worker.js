/**
 * SalesApp API bridge.
 * Cloudflare Worker variables/secrets:
 *   APPS_SCRIPT_URL       = deployed Google Apps Script Web App URL
 *   WORKER_SHARED_SECRET  = same random secret stored in Apps Script Script Properties
 *
 * Never commit real values here.
 */
export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, cors);
    if (!env.APPS_SCRIPT_URL || !env.WORKER_SHARED_SECRET) {
      return json({ ok: false, error: "Worker belum dikonfigurasi." }, 503, cors);
    }

    let body;
    try { body = await request.json(); }
    catch (_) { return json({ ok: false, error: "Request JSON tidak valid." }, 400, cors); }

    const upstream = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, bridgeSecret: env.WORKER_SHARED_SECRET }),
      redirect: "follow"
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.ok ? 200 : upstream.status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}