(() => {
  "use strict";
  const cfg = window.SALESAPP_CONFIG || {};
  const API = String(cfg.APPS_SCRIPT_URL || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  let sessionToken = sessionStorage.getItem("salesapp_session") || "";
  let records = [];
  let dashboardSummary = null;
  let guestMode = false;
  let dashboardBusy = false;
  let loginBusy = false;
  let lastApiTiming = null;
  let lastLoginMs = null;
  let lastLoginDiagnostics = null;

  async function api(action, payload = {}) {
    if (!API || API.includes("PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL")) {
      throw new Error("API belum dikonfigurasi. Periksa APPS_SCRIPT_URL di config.js.");
    }
    const started = performance.now();
    const response = await fetch(API, {
      method: "POST",
      mode: "cors",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, sessionToken, ...payload })
    });
    const clientMs = Math.round(performance.now() - started);
    if (!response.ok) throw new Error("Server merespons HTTP " + response.status);
    const result = await response.json();
    lastApiTiming = {
      action: action,
      clientMs: clientMs,
      serverMs: Number(result.meta && result.meta.serverMs || 0)
    };
    if (!result.ok) {
      const error = new Error(result.error || "Permintaan gagal.");
      error.apiTiming = lastApiTiming;
      throw error;
    }
    return result.data;
  }

  function showLogin(message = "") {
    $("loginView").hidden = false;
    $("appView").hidden = true;
    $("loginMessage").textContent = message;
  }

  function showApp(user) {
    $("loginView").hidden = true;
    $("appView").hidden = false;
    $("userName").textContent = user.fullName || user.userId;
    $("userRole").textContent = [user.role, user.division].filter(Boolean).join(" · ");
    $("scopeText").textContent = user.role === "GUEST"
      ? "Mode tamu — akses hanya untuk ringkasan yang diizinkan."
      : "Data sesuai hak akses akun " + (user.division || "") + ".";
  }

  function countStatus(status) {
    return records.filter(r => String(r.projectStatus || "").trim().toUpperCase() === status).length;
  }

  function render() {
    const summary = dashboardSummary || {
      total: records.length,
      quotationReleased: records.filter(r => String(r.quotationNo || "").trim()).length,
      getOrder: countStatus("GET ORDER"),
      lost: countStatus("LOST")
    };
    $("totalInquiry").textContent = Number(summary.total || 0).toLocaleString("id-ID");
    $("quotationReleased").textContent = Number(summary.quotationReleased || 0).toLocaleString("id-ID");
    $("getOrder").textContent = Number(summary.getOrder || 0).toLocaleString("id-ID");
    $("lost").textContent = Number(summary.lost || 0).toLocaleString("id-ID");

    const term = $("searchInput").value.trim().toLowerCase();
    const filtered = records.filter(r =>
      [r.inquiryNo, r.customer, r.project, r.equipment, r.planner, r.salesPic, r.quotationNo, r.projectStatus]
        .join(" ").toLowerCase().includes(term)
    ).slice(0, 100);

    $("inquiryRows").innerHTML = "";
    if (!filtered.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 8;
      td.className = "empty";
      td.textContent = "Tidak ada data yang cocok.";
      tr.appendChild(td);
      $("inquiryRows").appendChild(tr);
      return;
    }

    filtered.forEach(r => {
      const tr = document.createElement("tr");
      [r.inquiryNo, r.customer, r.project, r.equipment, r.planner, r.salesPic, r.quotationNo, r.projectStatus]
        .forEach(value => {
          const td = document.createElement("td");
          td.textContent = value || "—";
          tr.appendChild(td);
        });
      $("inquiryRows").appendChild(tr);
    });
  }

  async function loadDashboard({ forceRefresh = false } = {}) {
    if (dashboardBusy) return;
    dashboardBusy = true;
    const button = $("refreshBtn");
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = forceRefresh ? "Memperbarui…" : "Memuat…";
    $("notice").className = "notice";
    $("notice").textContent = forceRefresh
      ? "Mengambil data terbaru dari spreadsheet…"
      : "Memuat data dashboard…";

    try {
      const data = await api("dashboard", { forceRefresh: Boolean(forceRefresh) });
      records = Array.isArray(data.records) ? data.records : [];
      dashboardSummary = data.summary || null;
      guestMode = Boolean(data.guest);
      render();

      const d = data.diagnostics || {};
      const diagnosticText = records.length === 0 && !guestMode
        ? " Diagnostik: sheet=" + (d.sheetName || "?") +
          ", header=" + (d.headerRow || "?") +
          ", baris terakhir=" + (d.lastRow || "?") +
          ", kolom inquiry=" + (d.inquiryKeyColumn || "?") +
          ", key terisi=" + (d.nonEmptyInquiryKeys ?? "?") + "."
        : "";
      const timing = lastApiTiming
        ? " API " + lastApiTiming.clientMs + " ms (server " + lastApiTiming.serverMs + " ms)."
        : "";
      const loginTiming = lastLoginMs !== null
        ? " Login " + (lastLoginMs / 1000).toFixed(1) + " detik." +
          (lastLoginDiagnostics
            ? " USERS " + (lastLoginDiagnostics.challenge.usersReadMs || 0) + "/" +
              (lastLoginDiagnostics.verify.usersReadMs || 0) + " ms (" +
              (lastLoginDiagnostics.challenge.usersCacheHit ? "cache" : "sheet") + "/" +
              (lastLoginDiagnostics.verify.usersCacheHit ? "cache" : "sheet") +
              "), proof " + (lastLoginDiagnostics.verify.proofVerifyMs || 0) +
              " ms, audit " + (lastLoginDiagnostics.verify.auditMs || 0) + " ms."
            : "")
        : "";

      $("notice").textContent = guestMode
        ? "Mode tamu aktif. Hanya KPI agregat yang ditampilkan; detail inquiry dibatasi." + timing
        : "Terhubung. " + records.length + " inquiry berhasil dimuat." +
          diagnosticText + timing + loginTiming;
    } catch (err) {
      $("notice").className = "notice error";
      $("notice").textContent = err.message + (err.apiTiming
        ? " (client " + err.apiTiming.clientMs + " ms; server " + err.apiTiming.serverMs + " ms)"
        : "");
    } finally {
      dashboardBusy = false;
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async function deriveLoginProof(password, challenge, identity) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Browser tidak mendukung Web Crypto. Gunakan browser modern melalui HTTPS.");
    }
    const deriveStarted = performance.now();
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
      "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const derivedBits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      salt: encoder.encode(challenge.salt),
      iterations: Number(challenge.iterations || 120000),
      hash: "SHA-256"
    }, passwordKey, 256);

    const hmacKey = await crypto.subtle.importKey(
      "raw", derivedBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const message = challenge.nonce + "|" + challenge.challengeId + "|" + identity.toLowerCase();
    const signature = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(message));
    const toHex = (bytes) => Array.from(new Uint8Array(bytes))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
    return { derivedKey: toHex(derivedBits), proof: toHex(signature), deriveMs: Math.round(performance.now() - deriveStarted) };
  }

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loginBusy) return;
    loginBusy = true;

    const submitButton = $("loginForm").querySelector('button[type="submit"]');
    const originalLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = "Memeriksa…";
    const started = performance.now();
    const identity = $("identity").value.trim().toLowerCase();
    const passwordInput = $("password");
    const password = passwordInput.value;

    try {
      $("loginMessage").textContent = "Menghubungi server…";
      const challenge = await api("loginChallenge", { identity });
      const challengeTimings = challenge.authTimings || {};
      $("loginMessage").textContent = "Memverifikasi password di perangkat…";
      const credentials = await deriveLoginProof(password, challenge, identity);
      passwordInput.value = "";

      $("loginMessage").textContent = "Membuat sesi aman…";
      const data = await api("loginVerify", {
        challengeId: challenge.challengeId,
        derivedKey: credentials.derivedKey,
        proof: credentials.proof
      });

      sessionToken = data.sessionToken;
      sessionStorage.setItem("salesapp_session", sessionToken);
      lastLoginMs = Math.round(performance.now() - started);
      lastLoginDiagnostics = {
        challenge: challengeTimings,
        deriveMs: credentials.deriveMs,
        verify: data.authTimings || {}
      };
      showApp(data.user);
      await loadDashboard();
    } catch (err) {
      passwordInput.value = "";
      $("loginMessage").textContent = err.message + (err.apiTiming
        ? " (client " + err.apiTiming.clientMs + " ms; server " + err.apiTiming.serverMs + " ms)"
        : "");
    } finally {
      loginBusy = false;
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    const button = $("logoutBtn");
    button.disabled = true;
    try {
      if (sessionToken) await api("logout");
    } catch (_) {
      // Complete local logout even if the server is temporarily unreachable.
    }
    sessionToken = "";
    sessionStorage.removeItem("salesapp_session");
    records = [];
    dashboardSummary = null;
    guestMode = false;
    lastLoginMs = null;
    lastLoginDiagnostics = null;
    button.disabled = false;
    showLogin();
  });

  $("refreshBtn").addEventListener("click", () => loadDashboard({ forceRefresh: true }));
  $("searchInput").addEventListener("input", render);

  if (sessionToken) {
    api("me")
      .then(user => {
        showApp(user);
        return loadDashboard();
      })
      .catch(() => {
        sessionToken = "";
        sessionStorage.removeItem("salesapp_session");
        showLogin();
      });
  } else {
    showLogin();
  }
})();
