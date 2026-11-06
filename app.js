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
  let activeKpiFilter = "all";
  let activeChartFilter = null;
  let currentUser = null;
  let activeInquiryNo = "";
  let activeEditableFields = [];
  let editorMode = "edit";

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
    currentUser = user;
    $("loginView").hidden = true;
    $("appView").hidden = false;
    $("userName").textContent = user.fullName || user.userId;
    $("userRole").textContent = [user.role, user.division].filter(Boolean).join(" · ");
    const role = String(user.role || "").toUpperCase();
    const division = String(user.division || "").toUpperCase();
    $("createInquiryBtn").hidden = !(role === "ADMIN" || role === "SALES" || division === "SALES");
    $("scopeText").textContent = user.role === "GUEST"
      ? "Mode tamu — akses hanya untuk ringkasan yang diizinkan."
      : "Data sesuai hak akses akun " + (user.division || "") + ".";
  }

  function countStatus(status) {
    return records.filter(r => String(r.projectStatus || "").trim().toUpperCase() === status).length;
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const text = String(value).trim();
    if (!text || text === "—" || text === "-") return null;
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    match = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/);
    if (match) {
      const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const month = months[match[2].slice(0,3).toLowerCase()];
      if (month !== undefined) return new Date(Number(match[3]), month, Number(match[1]));
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  function deadlineState(record) {
    if (record.actualDelivery) return null;
    const due = parseDate(record.dueDate);
    if (!due) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    const days = Math.round((due.getTime() - today.getTime()) / 86400000);
    if (days < 0) return {kind:"overdue",days:Math.abs(days),label:"Terlambat "+Math.abs(days)+" hari"};
    if (days <= 7) return {kind:"soon",days,label:days===0?"Jatuh tempo hari ini":days+" hari lagi"};
    return null;
  }

  function countBy(values, getter) {
    const counts = {};
    values.forEach(item => { const raw=String(getter(item)||"").trim(); const label=raw||"Belum diisi"; counts[label]=(counts[label]||0)+1; });
    return Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  }

  function renderBars(targetId, entries, limit=8) {
    const target=$(targetId); target.innerHTML="";
    const list=entries.slice(0,limit);
    if(!list.length){target.textContent="Belum ada data.";target.className="bar-chart chart-empty";return;}
    target.className="bar-chart";
    const max=Math.max(1,...list.map(item=>item[1]));
    list.forEach(([label,value])=>{
      const row=document.createElement("div");row.className="bar-row";
      const name=document.createElement("span");name.className="bar-label";name.textContent=label;
      const track=document.createElement("div");track.className="bar-track";
      const fill=document.createElement("span");fill.className="bar-fill";fill.style.width=Math.max(2,value/max*100)+"%";track.appendChild(fill);
      const count=document.createElement("strong");count.className="bar-value";count.textContent=value.toLocaleString("id-ID");
      row.append(name,track,count);target.appendChild(row);
    });
  }

  function renderDonut(entries) {
    const target=$("projectDonut");target.innerHTML="";
    const total=entries.reduce((sum,item)=>sum+item[1],0);
    if(!total){target.textContent="Belum ada data.";target.className="donut-layout chart-empty";return;}
    const palette=["#24456f","#5c83b7","#8aa5c7","#d2a85c","#9b7180","#7a8798","#6c9a8b"];
    let cursor=0;
    const segments=entries.map(([label,value],index)=>{const start=cursor;cursor+=value/total*100;return palette[index%palette.length]+" "+start+"% "+cursor+"%";});
    const wrap=document.createElement("div");wrap.className="donut";wrap.style.background="conic-gradient("+segments.join(",")+")";
    const hole=document.createElement("div");hole.className="donut-hole";
    const totalNode=document.createElement("strong");totalNode.textContent=total.toLocaleString("id-ID");
    const caption=document.createElement("small");caption.textContent="Project";hole.append(totalNode,caption);wrap.appendChild(hole);
    const legend=document.createElement("div");legend.className="donut-legend";
    entries.forEach(([label,value],index)=>{const row=document.createElement("div");row.className="legend-row";const dot=document.createElement("i");dot.style.background=palette[index%palette.length];const name=document.createElement("span");name.textContent=label;const amount=document.createElement("strong");amount.textContent=value+" · "+Math.round(value/total*100)+"%";row.append(dot,name,amount);legend.appendChild(row);});
    target.className="donut-layout";target.append(wrap,legend);
  }

  const chartPalette=["#477fcf","#f04b3e","#f2b400","#28a9a2","#8a73c7","#6b9a52","#d17aa6","#7b8798","#e18b35"];
  function normalizedCategory(value){const text=String(value||"").trim();return text||"Belum diisi";}
  function categoryEntries(getter){return countBy(records,getter).sort((a,b)=>b[1]-a[1]);}
  function setChartFilter(filters,label){
    activeChartFilter={filters:filters,label:label};
    $("clearChartFilter").hidden=false;$("clearChartFilter").textContent="Hapus filter: "+label;
    render();$("inquiryRows").scrollIntoView({behavior:"smooth",block:"start"});
  }
  function chartCategoryButton(label,value,color,filters){
    const button=document.createElement("button");button.type="button";button.className="chart-legend-button";
    const dot=document.createElement("i");dot.className="chart-legend-dot";dot.style.background=color;
    const name=document.createElement("span");name.textContent=label;
    const count=document.createElement("strong");count.textContent=value.toLocaleString("id-ID");
    button.append(dot,name,count);button.addEventListener("click",()=>setChartFilter(filters,label));return button;
  }
  function renderPieChart(targetId,entries,field){
    const target=$(targetId);target.innerHTML="";const total=entries.reduce((sum,item)=>sum+item[1],0);
    if(!total){target.textContent="Belum ada data.";target.className="pie-layout chart-empty";return;}
    let cursor=0;const slices=entries.map(([label,value],i)=>{const start=cursor;cursor+=value/total*100;return chartPalette[i%chartPalette.length]+" "+start+"% "+cursor+"%";});
    const pie=document.createElement("div");pie.className="pie-chart";pie.style.background="conic-gradient("+slices.join(",")+")";
    const legend=document.createElement("div");legend.className="pie-legend";
    entries.forEach(([label,value],i)=>legend.appendChild(chartCategoryButton(label+" · "+Math.round(value/total*100)+"%",value,chartPalette[i%chartPalette.length],[{field,value:label==="Belum diisi"?"":label}])));
    target.className="pie-layout";target.append(pie,legend);
  }
  function renderStackedProjectRank(){
    const target=$("projectRankChart");target.innerHTML="";
    const ranks=["AA","AB","BA","BB","-","Belum diisi"];const equipment=categoryEntries(r=>r.equipment);
    if(!equipment.length){target.textContent="Belum ada data.";return;}
    const legend=document.createElement("div");legend.className="stacked-legend";
    ranks.forEach((rank,i)=>legend.appendChild(chartCategoryButton(rank,0,chartPalette[i],[{field:"inquiryRank",value:rank==="Belum diisi"?"":rank}])));
    target.appendChild(legend);
    equipment.forEach(([kind])=>{
      const row=document.createElement("div");row.className="stacked-row";
      const label=document.createElement("span");label.className="stacked-label";label.textContent=kind;
      const track=document.createElement("div");track.className="stacked-track";
      const totalCount=records.filter(r=>normalizedCategory(r.equipment)===kind).length;
      ranks.forEach((rank,i)=>{
        const count=records.filter(r=>normalizedCategory(r.equipment)===kind&&normalizedCategory(r.inquiryRank)===rank).length;if(!count)return;
        const segment=document.createElement("button");segment.type="button";segment.className="stacked-segment";segment.style.width=(count/totalCount*100)+"%";segment.style.background=chartPalette[i];segment.title=kind+" · "+rank+": "+count;
        segment.addEventListener("click",()=>setChartFilter([{field:"equipment",value:kind==="Belum diisi"?"":kind},{field:"inquiryRank",value:rank==="Belum diisi"?"":rank}],kind+" / "+rank));track.appendChild(segment);
      });
      const total=document.createElement("strong");total.className="bar-value";total.textContent=totalCount;row.append(label,track,total);target.appendChild(row);
    });
  }
  function renderPlanningQuotation(){
    const target=$("planningQuotationChart");target.innerHTML="";
    const items=[
      {label:"Finished planning",value:records.filter(r=>String(r.planningStatus||"").trim().toUpperCase()==="FINISHED").length,filters:[{field:"planningStatus",value:"FINISHED"}]},
      {label:"Quotation released",value:records.filter(r=>String(r.quotationStatus||"").trim().toUpperCase()==="RELEASED").length,filters:[{field:"quotationStatus",value:"RELEASED"}]}
    ];const max=Math.max(1,...items.map(x=>x.value));
    items.forEach((item,i)=>{
      const wrap=document.createElement("button");wrap.type="button";wrap.className="column-item";wrap.addEventListener("click",()=>setChartFilter(item.filters,item.label));
      const number=document.createElement("strong");number.textContent=item.value.toLocaleString("id-ID");
      const track=document.createElement("div");track.className="column-track";
      const fill=document.createElement("span");fill.className="column-fill";fill.style.height=(item.value/max*100)+"%";fill.style.background=chartPalette[i];track.appendChild(fill);
      const label=document.createElement("span");label.textContent=item.label;wrap.append(number,track,label);target.appendChild(wrap);
    });
  }
  function matchesChartFilters(record){
    if(!activeChartFilter)return true;
    return activeChartFilter.filters.every(({field,value})=>normalizedCategory(record[field]).toLowerCase()===normalizedCategory(value).toLowerCase());
  }

  function renderAnalytics() {
    if(guestMode){$("analyticsSection").hidden=true;$("deadlineSection").hidden=true;return;}
    $("analyticsSection").hidden=false;$("deadlineSection").hidden=false;
    renderPieChart("kindWorksChart",categoryEntries(r=>r.equipment),"equipment");
    renderBars("inquiryRankChart",categoryEntries(r=>r.inquiryRank));
    renderStackedProjectRank();
    renderPieChart("requesterChart",categoryEntries(r=>r.department),"department");
    renderBars("planningStatusChart",categoryEntries(r=>r.planningStatus));
    renderDonut(categoryEntries(r=>r.projectStatus));
    renderPlanningQuotation();
    renderPieChart("customerSpecChart",categoryEntries(r=>r.customerSpec),"customerSpec");
    renderBars("plannerPerformance",countBy(records.filter(r=>r.planner),r=>r.planner),5);
    renderBars("salesPerformance",countBy(records.filter(r=>r.salesPic),r=>r.salesPic),5);
    const deadlines=records.map(record=>({record,state:deadlineState(record)})).filter(item=>item.state)
      .sort((a,b)=>a.state.kind===b.state.kind?a.state.days-b.state.days:(a.state.kind==="overdue"?-1:1));
    const overdue=deadlines.filter(item=>item.state.kind==="overdue").length;
    $("deadlineSummary").textContent=overdue+" terlambat · "+(deadlines.length-overdue)+" mendekati";
    const body=$("deadlineRows");body.innerHTML="";
    if(!deadlines.length){const row=document.createElement("tr");const cell=document.createElement("td");cell.colSpan=6;cell.className="empty";cell.textContent="Tidak ada inquiry aktif yang mendekati atau melewati due date dalam 7 hari ke depan.";row.appendChild(cell);body.appendChild(row);return;}
    deadlines.slice(0,50).forEach(({record,state})=>{const row=document.createElement("tr");[record.inquiryNo,record.customer,record.project,record.planner,record.dueDate].forEach(value=>{const cell=document.createElement("td");cell.textContent=value||"—";row.appendChild(cell);});const status=document.createElement("td");const badge=document.createElement("span");badge.className="deadline-badge "+state.kind;badge.textContent=state.label;status.appendChild(badge);row.appendChild(status);body.appendChild(row);});
  }

  function render() {
    const summary=dashboardSummary||{total:records.length,quotationReleased:records.filter(r=>String(r.quotationNo||"").trim()).length,getOrder:countStatus("GET ORDER"),lost:countStatus("LOST")};
    $("totalInquiry").textContent=Number(summary.total||0).toLocaleString("id-ID");
    $("quotationReleased").textContent=Number(summary.quotationReleased||0).toLocaleString("id-ID");
    $("getOrder").textContent=Number(summary.getOrder||0).toLocaleString("id-ID");
    $("lost").textContent=Number(summary.lost||0).toLocaleString("id-ID");
    renderAnalytics();
    const term=$("searchInput").value.trim().toLowerCase();
    let source=records.filter(matchesChartFilters);
    if(activeKpiFilter==="quotation")source=source.filter(r=>String(r.quotationNo||"").trim());
    if(activeKpiFilter==="getOrder")source=source.filter(r=>String(r.projectStatus||"").trim().toUpperCase()==="GET ORDER");
    if(activeKpiFilter==="lost")source=source.filter(r=>String(r.projectStatus||"").trim().toUpperCase()==="LOST");
    const filtered=source.filter(r=>[r.inquiryNo,r.customer,r.project,r.equipment,r.planner,r.salesPic,r.quotationNo,r.projectStatus].join(" ").toLowerCase().includes(term)).slice(0,100);
    document.querySelectorAll("[data-kpi]").forEach(card=>{const selected=card.dataset.kpi===activeKpiFilter||(card.dataset.kpi==="total"&&activeKpiFilter==="all");card.setAttribute("aria-pressed",selected?"true":"false");});
    $("inquiryRows").innerHTML="";
    if(!filtered.length){const tr=document.createElement("tr");const td=document.createElement("td");td.colSpan=8;td.className="empty";td.textContent="Tidak ada data yang cocok.";tr.appendChild(td);$("inquiryRows").appendChild(tr);return;}
    filtered.forEach(r=>{const tr=document.createElement("tr");tr.className="clickable-row";tr.tabIndex=0;tr.title="Klik untuk melihat detail inquiry";[r.inquiryNo,r.customer,r.project,r.equipment,r.planner,r.salesPic,r.quotationNo,r.projectStatus].forEach(value=>{const td=document.createElement("td");td.textContent=value||"—";tr.appendChild(td);});tr.addEventListener("click",()=>openInquiryDetail(r.inquiryNo));tr.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();openInquiryDetail(r.inquiryNo);}});$("inquiryRows").appendChild(tr);});
  }


  function addDetailField(containerId,label,value){
    const container=$(containerId),item=document.createElement("div");item.className="detail-field";
    const term=document.createElement("span");term.textContent=label;
    const description=document.createElement("strong");description.textContent=(value===null||value===undefined||String(value).trim()==="")?"—":String(value);
    item.append(term,description);container.appendChild(item);
  }
  function renderDetail(record,history,editableFields=[]){
    activeInquiryNo = record.inquiryNo || "";
    activeEditableFields = editableFields;
    $("editDetailBtn").hidden = editableFields.length === 0;
    $("detailEditorPanel").hidden = true;
    $("detailTitle").textContent=record.inquiryNo||"Detail inquiry";
    $("detailSubtitle").textContent=(record.customer||"Customer belum diisi")+" · Baris spreadsheet "+record.rowNumber;
    const groups={
      detailIdentity:[["Nomor inquiry",record.inquiryNo],["Customer",record.customer],["Nama project",record.project]],
      detailEquipment:[["Jenis equipment",record.equipment],["Technical spec. dari customer",record.customerTechnicalSpec],["MOM / spesifikasi dari Sales",record.salesMomSpec],["Technical spec",record.technicalSpec]],
      detailRequester:[["Nama requester",record.requester],["Department",record.department],["Inquiry rank",record.inquiryRank]],
      detailPeople:[["Planner PIC",record.planner],["Tanggal inquiry masuk ke Planner",record.plannerInquiryDate],["Sales PIC",record.salesPic]],
      detailDocuments:[["Technical spec",record.technicalSpec],["Drawing",record.drawing],["Cost table",record.costTable],["Lain-lain",record.otherDocuments]],
      detailProgress:[["Due date data masuk ke Sales",record.dueDate],["Estimasi delivery time",record.estimatedDeliveryTime],["Actual data delivery ke Sales",record.actualDelivery],["Progress (%)",record.progress],["Planing job",record.planningJob],["Data delivery",record.dataDelivery]],
      detailMaintenance:[["Maintenance update",record.maintenanceUpdate]],
      detailCommercial:[["Status penawaran",record.quotationStatus],["Nomor quotation",record.quotationNo],["Tanggal release",record.releaseDate],["Status project",record.projectStatus]],
      detailNotes:[["Note",record.note]]
    };
    Object.entries(groups).forEach(([id,fields])=>{const target=$(id);target.innerHTML="";fields.forEach(([label,value])=>addDetailField(id,label,value));});
    const body=$("detailHistory");body.innerHTML="";$("historyEmpty").hidden=history.length>0;
    history.forEach(item=>{const tr=document.createElement("tr");[item.timestamp,item.userName||item.userId,item.action,item.fieldKey,item.oldValue,item.newValue].forEach(value=>{const td=document.createElement("td");td.textContent=value||"—";tr.appendChild(td);});body.appendChild(tr);});
    $("detailContent").hidden=false;$("detailLoading").hidden=true;
  }
  async function openInquiryDetail(inquiryNo){
    const dialog=$("detailDialog");$("detailContent").hidden=true;$("detailLoading").hidden=false;
    $("detailError").textContent="";$("detailLoading").textContent="Memuat detail "+inquiryNo+"…";
    if(!dialog.open)dialog.showModal();
    try{const data=await api("inquiryDetail",{inquiryNo:inquiryNo});renderDetail(data.record,data.history||[],data.editableFields||[]);}
    catch(error){$("detailLoading").hidden=true;$("detailError").textContent=error.message;}
  }


  function closeEditor() {
    $("detailEditorPanel").hidden = true;
    $("editDetailBtn").hidden = activeEditableFields.length === 0;
    $("detailError").textContent = "";
  }

  function renderEditorFields(fields) {
    const target = $("inquiryEditorFields");
    target.innerHTML = "";
    fields.forEach(field => {
      const wrap = document.createElement("div");
      wrap.className = "editor-field" + (field.type === "textarea" ? " full-width" : "");
      const label = document.createElement("label");
      label.textContent = field.label;
      label.htmlFor = "edit_" + field.key;
      let input;
      if (field.type === "textarea") {
        input = document.createElement("textarea");
        input.rows = 3;
      } else {
        input = document.createElement("input");
        input.type = field.type === "date" ? "date" : (field.type === "percent" ? "number" : "text");
        if (field.type === "percent") {
          input.min = "0"; input.max = "100"; input.step = "1";
        }
      }
      input.id = "edit_" + field.key;
      input.name = field.key;
      input.value = field.value === null || field.value === undefined ? "" : String(field.value);
      if (field.required) input.required = true;
      wrap.append(label,input);
      target.appendChild(wrap);
    });
  }

  function showEditor(fields, mode) {
    editorMode = mode;
    $("detailEditorPanel").hidden = false;
    $("editDetailBtn").hidden = true;
    $("editorHeading").textContent = mode === "create" ? "Buat inquiry baru" : "Edit data inquiry";
    $("editorHelp").textContent = mode === "create"
      ? "Isi nomor inquiry, customer, dan nama project. Data akan langsung ditambahkan ke spreadsheet."
      : "Field yang tampil adalah field yang dapat diedit oleh divisi akun ini. ADMIN dapat mengubah seluruh field.";
    $("saveInquiryBtn").textContent = mode === "create" ? "Buat inquiry" : "Simpan perubahan";
    renderEditorFields(fields);
    $("detailEditorPanel").scrollIntoView({behavior:"smooth",block:"start"});
  }

  $("editDetailBtn").addEventListener("click", () => showEditor(activeEditableFields,"edit"));
  $("cancelEditBtn").addEventListener("click", closeEditor);

  $("inquiryEditorForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("saveInquiryBtn");
    button.disabled = true;
    button.textContent = "Menyimpan…";
    $("detailError").textContent = "";
    const fields = {};
    $("inquiryEditorFields").querySelectorAll("input,textarea").forEach(input => {
      fields[input.name] = input.value.trim();
    });
    try {
      if (editorMode === "create") {
        const result = await api("createInquiry",{fields});
        $("detailDialog").close();
        await loadDashboard({forceRefresh:true});
        await openInquiryDetail(result.inquiryNo);
      } else {
        const result = await api("updateInquiry",{inquiryNo:activeInquiryNo,fields});
        if (!result.updated) {
          $("detailError").textContent = result.message || "Tidak ada perubahan.";
        } else {
          $("detailLoading").hidden = false;
          $("detailLoading").textContent = result.message + " Memuat ulang data…";
          $("detailContent").hidden = true;
          await loadDashboard({forceRefresh:true});
          await openInquiryDetail(activeInquiryNo);
        }
      }
    } catch (error) {
      $("detailError").textContent = error.message || "Gagal menyimpan perubahan.";
    } finally {
      button.disabled = false;
      button.textContent = editorMode === "create" ? "Buat inquiry" : "Simpan perubahan";
    }
  });

  async function openNewInquiry() {
    $("detailTitle").textContent = "Inquiry baru";
    $("detailSubtitle").textContent = "Data akan disimpan langsung ke sheet Inquiry sheet.";
    $("detailContent").hidden = false;
    $("detailLoading").hidden = true;
    $("detailError").textContent = "";
    $("detailHistory").innerHTML = "";
    $("historyEmpty").hidden = true;
    $("editDetailBtn").hidden = true;
    if (!$("detailDialog").open) $("detailDialog").showModal();
    try {
      const schema = await api("inquirySchema");
      const fields = [{key:"INQUIRY PROJECT NO",label:"Nomor inquiry / Inquiry Project No",type:"text",required:true},...schema.fields];
      showEditor(fields,"create");
      ["detailIdentity","detailEquipment","detailRequester","detailPeople","detailDocuments","detailProgress","detailMaintenance","detailCommercial","detailNotes"].forEach(id=>$(id).innerHTML="");
      $("detailContent").querySelectorAll(".detail-section:not(.editor-panel)").forEach(section=>section.hidden=true);
    } catch (error) {
      $("detailError").textContent = error.message;
    }
  }

  $("createInquiryBtn").addEventListener("click",openNewInquiry);

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
              "), PBKDF2 " + (lastLoginDiagnostics.deriveMs || 0) +
              " ms, proof " + (lastLoginDiagnostics.verify.proofVerifyMs || 0) +
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
    currentUser = null;
    $("createInquiryBtn").hidden = true;
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
  $("clearChartFilter").addEventListener("click",()=>{activeChartFilter=null;$("clearChartFilter").hidden=true;render();});
  $("searchInput").addEventListener("input", render);
  $("closeDetailBtn").addEventListener("click",()=> $("detailDialog").close());
  $("detailDialog").addEventListener("click",event=>{if(event.target===$("detailDialog"))$("detailDialog").close();});
  $("detailDialog").addEventListener("close",()=>{ $("detailContent").querySelectorAll(".detail-section:not(.editor-panel)").forEach(section=>section.hidden=false); closeEditor(); });
  document.querySelectorAll("[data-kpi]").forEach(card => card.addEventListener("click", () => { activeKpiFilter = card.dataset.kpi === "total" ? "all" : card.dataset.kpi; render(); $("inquiryRows").closest(".data-panel").scrollIntoView({behavior:"smooth",block:"start"}); }));

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
