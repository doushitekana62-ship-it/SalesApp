(() => {
  "use strict";
  const $=id=>document.getElementById(id);
  const API=String((window.SALESAPP_CONFIG||{}).APPS_SCRIPT_URL||"").replace(/\/$/,"");
  let sessionToken=sessionStorage.getItem("salesapp_session")||"";
  let employeeData=null;
  const request=async(action,payload={})=>{
    sessionToken=sessionStorage.getItem("salesapp_session")||"";
    const response=await fetch(API,{method:"POST",mode:"cors",redirect:"follow",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({action,sessionToken,...payload})});
    const result=await response.json();if(!result.ok)throw new Error(result.error||"Permintaan gagal.");return result.data;
  };
  const formData=form=>Object.fromEntries(new FormData(form).entries());
  const today=()=>new Date().toISOString().slice(0,10);
  async function derive(password,salt,iterations){
    const enc=new TextEncoder(),key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
    const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations:Number(iterations||120000),hash:"SHA-256"},key,256);
    return Array.from(new Uint8Array(bits)).map(x=>x.toString(16).padStart(2,"0")).join("");
  }
  function showOnly(view){
    ["loginView","registerView","registrationStatusView","appView"].forEach(id=>{if($(id))$(id).hidden=id!==view;});
  }
  $("showRegisterBtn")?.addEventListener("click",()=>showOnly("registerView"));
  $("showRegistrationStatusBtn")?.addEventListener("click",()=>showOnly("registrationStatusView"));
  $("backToLoginBtn")?.addEventListener("click",()=>showOnly("loginView"));
  $("backStatusLoginBtn")?.addEventListener("click",()=>showOnly("loginView"));
  $("registerForm")?.addEventListener("submit",async e=>{
    e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type="submit"]'),msg=$("registerMessage");
    const d=formData(form),password=$("regPassword").value;button.disabled=true;msg.textContent="Memproses pendaftaran…";
    try{
      const challenge=await request("registerChallenge",{email:d.regEmail});
      const derivedKey=await derive(password,challenge.salt,challenge.iterations);
      $("regPassword").value="";
      const result=await request("registerComplete",{challengeId:challenge.challengeId,derivedKey,fullName:d.regName,email:d.regEmail,role:d.regRole,division:d.regDivision});
      msg.textContent=result.message+" Nomor akun: "+result.userId;
      form.reset();
    }catch(err){msg.textContent=err.message;}finally{button.disabled=false;}
  });
  $("registrationStatusForm")?.addEventListener("submit",async e=>{
    e.preventDefault();const msg=$("registrationStatusMessage");msg.textContent="Memeriksa…";
    try{const r=await request("registrationStatus",{email:$("statusEmail").value});msg.textContent=!r.found?"Email belum ditemukan.":r.active?"Akun sudah aktif. Silakan login.":"Pendaftaran ditemukan, tetapi akun belum aktif. Hubungi admin jika status terlalu lama.";}
    catch(err){msg.textContent=err.message;}
  });
  const dashboardIds=["analyticsSection","deadlineSection","totalInquiry","inquiryRows"];
  function setEmployeeMode(enabled){
    $("employeeManagementView").hidden=!enabled;$("backDashboardBtn").hidden=!enabled;$("employeeViewBtn").hidden=enabled;
    ["analyticsSection","deadlineSection"].forEach(id=>{if($(id))$(id).hidden=enabled;});
    document.querySelector(".kpi-grid").hidden=enabled;
    document.querySelector(".data-panel").hidden=enabled;
    $("createInquiryBtn").hidden=enabled||$("createInquiryBtn").dataset.allowed!=="true";
    document.querySelector(".page-heading h1").textContent=enabled?"Employee Management":"Inquiry monitoring";
    document.querySelector(".page-heading .eyebrow").textContent=enabled?"EMPLOYEE":"OVERVIEW";
  }
  $("employeeViewBtn")?.addEventListener("click",()=>{setEmployeeMode(true);loadEmployees();});
  $("backDashboardBtn")?.addEventListener("click",()=>setEmployeeMode(false));
  $("employeeRefreshBtn")?.addEventListener("click",loadEmployees);
  function renderActivityRows(rows){
    const target=$("employeeActivityRows");target.innerHTML="";
    if(!rows.length){target.innerHTML='<tr><td colspan="6" class="empty">Belum ada data.</td></tr>';return;}
    rows.forEach(row=>{const tr=document.createElement("tr");["ACTIVITY_DATE","ACTIVITY_TYPE","PROJECT_NAME","ACTIVITY_DESCRIPTION","ACTIVITY_STATUS"].forEach(k=>{const td=document.createElement("td");td.textContent=row[k]??"";tr.append(td);});const td=document.createElement("td"),btn=document.createElement("button");btn.type="button";btn.className="secondary";btn.textContent="Edit";btn.addEventListener("click",()=>{const form=$("employeeActivityForm");Object.keys(row).forEach(k=>{if(form.elements[k])form.elements[k].value=row[k]??"";});$("employeeActivityHeading").textContent="Edit aktivitas harian";form.scrollIntoView({behavior:"smooth",block:"center"});});td.append(btn);tr.append(td);});
  }
  function fillTable(target,rows,columns){
    target.innerHTML="";
    if(!rows.length){const tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=columns.length;td.className="empty";td.textContent="Belum ada data.";tr.append(td);target.append(tr);return;}
    rows.forEach(row=>{const tr=document.createElement("tr");columns.forEach(k=>{const td=document.createElement("td");td.textContent=row[k]??"";tr.append(td);});target.append(tr);});
  }
  async function loadEmployees(){
    const notice=$("employeeNotice");notice.textContent="Memuat data…";
    try{
      employeeData=await request("employeeDashboard");notice.textContent=employeeData.directory.length+" karyawan aktif dalam cakupan akses.";
      renderActivityRows(employeeData.activities);
      const hist=await request("employeeHistory");fillTable($("employeeHistoryRows"),hist.items,["TIMESTAMP","ACTION","FIELD_KEY","OLD_VALUE","NEW_VALUE"]);
      const dl=$("employeePlateList");dl.innerHTML="";employeeData.vehiclePlates.forEach(p=>{const o=document.createElement("option");o.value=p;dl.append(o);});
      const assign=$("employeeAssignForm");assign.hidden=!employeeData.canAssign;
      const select=assign.elements.USER_ID;select.innerHTML="";employeeData.directory.forEach(emp=>{const o=document.createElement("option");o.value=emp.userId;o.textContent=emp.name+" · "+emp.division;select.append(o);});
    }catch(err){notice.textContent=err.message;}
  }
  function setDefaultDates(){
    ["employeeActivityForm","employeeAttendanceForm","employeeVisitForm"].forEach(id=>{const el=$(id)?.querySelector('input[type="date"]');if(el&&!el.value)el.value=today();});
  }
  async function submitEmployeeForm(form,action,wrap=true){
    const button=form.querySelector('[type="submit"]');button.disabled=true;
    try{const data=formData(form);await request(action,wrap?{data}:{...data});form.reset();if(form.id==="employeeActivityForm")$("employeeActivityHeading").textContent="Aktivitas harian";setDefaultDates();$("employeeNotice").textContent="Data berhasil disimpan.";await loadEmployees();}
    catch(err){$("employeeNotice").textContent=err.message;}finally{button.disabled=false;}
  }
  $("employeeActivityForm")?.addEventListener("submit",e=>{e.preventDefault();submitEmployeeForm(e.currentTarget,"employeeSaveActivity");});
  $("employeeAttendanceForm")?.addEventListener("submit",e=>{e.preventDefault();submitEmployeeForm(e.currentTarget,"employeeSaveAttendance");});
  $("employeeVisitForm")?.addEventListener("submit",e=>{e.preventDefault();submitEmployeeForm(e.currentTarget,"employeeSaveVisit");});
  $("employeeAssignForm")?.addEventListener("submit",e=>{e.preventDefault();submitEmployeeForm(e.currentTarget,"employeeAssign");});
  setDefaultDates();
  // Keep session token synchronized after the existing login/logout code changes sessionStorage.
  $("employeeViewBtn")?.addEventListener("click",()=>{sessionToken=sessionStorage.getItem("salesapp_session")||"";});
  if(!API&&$("registerMessage"))$("registerMessage").textContent="API belum dikonfigurasi.";
})();