(() => {
  "use strict";
  const cfg = window.SALESAPP_CONFIG || {};
  const API = String(cfg.APPS_SCRIPT_URL || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  let sessionToken = sessionStorage.getItem("salesapp_session") || "";
  let records = [];
  let dashboardSummary = null;
  let guestMode = false;

  async function api(action, payload = {}) {
    if (!API || API.includes("PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL")) throw new Error("API belum dikonfigurasi. Isi APPS_SCRIPT_URL di frontend/config.js setelah Apps Script dideploy.");
    const response = await fetch(API, {
      method: "POST",
      mode: "cors",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, sessionToken, ...payload })
    });
    if (!response.ok) throw new Error("Server merespons HTTP " + response.status);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "Permintaan gagal.");
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
    $("scopeText").textContent = user.role === "GUEST" ? "Mode tamu — akses hanya untuk ringkasan yang diizinkan." : "Data sesuai hak akses akun " + (user.division || "") + ".";
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
    const filtered = records.filter(r => [r.inquiryNo,r.customer,r.project,r.equipment,r.planner,r.salesPic,r.quotationNo,r.projectStatus].join(" ").toLowerCase().includes(term)).slice(0,100);
    $("inquiryRows").innerHTML = "";
    if (!filtered.length) {
      const tr = document.createElement("tr"); const td = document.createElement("td");
      td.colSpan = 8; td.className = "empty"; td.textContent = "Tidak ada data yang cocok."; tr.appendChild(td); $("inquiryRows").appendChild(tr); return;
    }
    filtered.forEach(r => {
      const tr = document.createElement("tr");
      [r.inquiryNo,r.customer,r.project,r.equipment,r.planner,r.salesPic,r.quotationNo,r.projectStatus].forEach(value => {
        const td = document.createElement("td"); td.textContent = value || "—"; tr.appendChild(td);
      });
      $("inquiryRows").appendChild(tr);
    });
  }
  async function loadDashboard() {
    $("notice").className = "notice"; $("notice").textContent = "Memuat data dashboard…";
    try {
      const data = await api("dashboard");
      records = Array.isArray(data.records) ? data.records : [];
      dashboardSummary = data.summary || null;
      guestMode = Boolean(data.guest);
      render();
      $("notice").textContent = guestMode
        ? "Mode tamu aktif. Hanya KPI agregat yang ditampilkan; detail inquiry dibatasi."
        : "Terhubung. " + records.length + " inquiry berhasil dimuat.";
    } catch (err) {
      $("notice").className = "notice error"; $("notice").textContent = err.message;
    }
  }
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("loginMessage").textContent = "Memeriksa akun…";
    try {
      const data = await api("login", { identity: $("identity").value.trim(), password: $("password").value });
      sessionToken = data.sessionToken;
      sessionStorage.setItem("salesapp_session", sessionToken);
      showApp(data.user);
      await loadDashboard();
    } catch (err) { $("loginMessage").textContent = err.message; }
  });
  $("logoutBtn").addEventListener("click", async () => {
    try { if (sessionToken) await api("logout"); } catch (_) {}
    sessionToken = ""; sessionStorage.removeItem("salesapp_session"); records = []; showLogin();
  });
  $("refreshBtn").addEventListener("click", loadDashboard);
  $("searchInput").addEventListener("input", render);

  if (sessionToken) {
    api("me").then(user => { showApp(user); return loadDashboard(); })
      .catch(() => { sessionToken = ""; sessionStorage.removeItem("salesapp_session"); showLogin(); });
  } else showLogin();
})();