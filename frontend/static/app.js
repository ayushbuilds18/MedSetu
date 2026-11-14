/* MedSetu frontend. API routes are configurable below; demo responses are clearly labelled. */
(() => {
  "use strict";
  const API_BASE = ""; // Same-origin FastAPI. Set to e.g. "http://127.0.0.1:8000" if needed.
  const API = {
    search: ["/api/compare", "/compare", "/api/search", "/search"],
    ocr: ["/api/ocr", "/ocr", "/api/prescription/ocr"],
    kendras: ["/api/kendras", "/kendras", "/api/locator"],
    health: ["/health", "/api/health"]
  };
  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const money = n => Number.isFinite(Number(n)) ? "₹" + Number(n).toLocaleString("en-IN",{maximumFractionDigits:2}) : "Not available";
  const safe = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const getStore = () => { try { return JSON.parse(localStorage.getItem("medsetu_medicines") || "[]"); } catch { return []; } };
  const setStore = list => { try { localStorage.setItem("medsetu_medicines", JSON.stringify(list)); } catch {} };
  let medicines = getStore(), editingId = null, lastResult = null, toastTimer;
  const toast = msg => { const el=$("#toast"); el.textContent=msg; el.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),3000); };
  const go = page => {
    $$(".page").forEach(p=>p.classList.toggle("active",p.id==="page-"+page));
    $$(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
    const label=({home:"Overview",search:"Compare medicine","my-medicines":"My medicines",kendra:"Find a Kendra",safety:"Safety guide"})[page]||"Overview";
    $("#page-crumb").textContent=label;
    $("#sidebar").classList.remove("open");
    window.scrollTo({top:0,behavior:"smooth"});
    if(page==="my-medicines") renderMedicines();
    if(page==="home") renderSavings();
  };
  $$("[data-page]").forEach(el=>el.addEventListener("click",e=>{e.preventDefault();go(el.dataset.page); if(el.dataset.focusUpload==="true") setTimeout(()=>$("#prescription-file").click(),150);}));
  $("#mobile-menu").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
  $("#safety-top").addEventListener("click",()=>go("safety"));
  $("#clear-query").addEventListener("click",()=>{ $("#medicine-query").value=""; $("#medicine-query").focus(); });
  $$("[data-clear]").forEach(b=>b.addEventListener("click",()=>{const i=$("#"+b.dataset.clear);i.value="";i.focus();}));
  $("#clear-kendra").addEventListener("click",()=>{$("#kendra-location").value="";$("#kendra-location").focus();});
  $$("[data-query]").forEach(b=>b.addEventListener("click",()=>{const q=b.dataset.query;$("#medicine-query").value=q;$("#medicine-query-secondary").value=q;go("search");runSearch(q);}));
  $("#search-form").addEventListener("submit",e=>{e.preventDefault();const q=$("#medicine-query").value.trim();$("#medicine-query-secondary").value=q;go("search");runSearch(q);});
  $("#search-form-secondary").addEventListener("submit",e=>{e.preventDefault();const q=$("#medicine-query-secondary").value.trim();$("#medicine-query").value=q;runSearch(q);});
  const setSearchState=(title,desc)=>{$("#result-panel").hidden=true;$("#search-state").hidden=false;$("#search-state").innerHTML=`<div class="empty-illustration"><span>⌕</span></div><h2>${safe(title)}</h2><p>${safe(desc)}</p>`;};
  async function fetchCandidates(paths, options) {
    let lastError;
    for(const path of paths) {
      try {
        const res=await fetch(API_BASE+path,options);
        if(res.status===404||res.status===405) continue;
        if(!res.ok) { lastError=new Error("Request failed ("+res.status+")"); continue; }
        return {data:await res.json(),path};
      } catch(err) { lastError=err; }
    }
    throw lastError||new Error("No compatible API endpoint found");
  }
  function normalizeResult(data, query) {
    const d=data?.result||data?.data||data?.medicine||data;
    return {
      query,
      name:d.name||d.brand_name||d.medicine_name||d.input_name||query,
      composition:d.composition||d.salt_composition||d.active_ingredients||d.generic_name||"Not provided by the connected dataset",
      strength:d.strength||d.dosage_strength||"",
      form:d.form||d.dosage_form||"",
      manufacturer:d.manufacturer||d.brand||"",
      brandPrice:d.brand_price??d.current_price??d.price??d.mrp??null,
      genericName:d.generic_name||d.alternative_name||d.generic_medicine||d.candidate?.name||"",
      genericComposition:d.generic_composition||d.candidate?.composition||"",
      genericPrice:d.generic_price??d.alternative_price??d.candidate?.price??null,
      saving:d.saving??d.savings??null,
      verdict:d.verdict||d.safety_verdict||d.status||"not_enough_data",
      reason:d.reason||d.explanation||d.message||"The available data does not establish whether a change is appropriate.",
      confidence:d.confidence??null,
      source:d.source||d.data_source||"",
      isDemo:false
    };
  }
  function demoResult(query) {
    const q=query.toLowerCase();
    const samples=[
      {keys:["dolo","paracetamol","crocin"],name:"Dolo 650 (sample)",composition:"Paracetamol 650 mg",strength:"650 mg",form:"Tablet",brandPrice:30,genericName:"Paracetamol 650 mg (sample entry)",genericComposition:"Paracetamol 650 mg",genericPrice:10,verdict:"ask_doctor",reason:"This is illustrative sample data only. Confirm the exact product, current price and suitability with a pharmacist."},
      {keys:["thyronorm","thyroxine"],name:"Thyronorm 100 mcg (sample)",composition:"Thyroxine 100 mcg",strength:"100 mcg",form:"Tablet",brandPrice:160,genericName:"No alternative confirmed",genericComposition:"",genericPrice:null,verdict:"ask_doctor",reason:"Thyroid medicines may require consistency and monitoring. Ask your prescriber before any brand change."},
      {keys:["augmentin"],name:"Augmentin 625 (sample)",composition:"Amoxicillin 500 mg + Clavulanic acid 125 mg",strength:"500/125 mg",form:"Tablet",brandPrice:220,genericName:"Combination entry not verified",genericComposition:"",genericPrice:null,verdict:"ask_doctor",reason:"Combination ingredients and ratio must match exactly. This sample does not confirm an interchangeable product."}
    ];
    const found=samples.find(x=>x.keys.some(k=>q.includes(k)));
    return {...(found||{name:query+" (demo lookup)",composition:"No verified composition in demo mode",strength:"",form:"",brandPrice:null,genericName:"No verified equivalent found",genericComposition:"",genericPrice:null,verdict:"not_enough_data",reason:"This frontend is running without a connected medicine API. No reliable match can be established."}),query,isDemo:true,source:"Illustrative demo catalogue — not for treatment decisions"};
  }
  async function runSearch(query) {
    if(!query) return;
    $("#search-state").hidden=false;$("#result-panel").hidden=true;
    $("#search-state").innerHTML='<div class="empty-illustration"><span>⌕</span></div><h2>Checking available information…</h2><p>Searching the connected medicine catalogue. Please wait.</p>';
    try {
      const response=await fetchCandidates(API.search,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query,medicine_name:query,medicine:query})});
      lastResult=normalizeResult(response.data,query); lastResult.apiPath=response.path;
      renderResult(lastResult);
    } catch(err) {
      lastResult=demoResult(query);renderResult(lastResult);
      toast("API not connected — showing clearly labelled sample data.");
    }
  }
  function verdictMeta(v) {
    const s=String(v||"").toLowerCase().replace(/[\s-]+/g,"_");
    if(s.includes("safe")||s.includes("potential_match")||s==="match")return ["Potential match","verdict-green"];
    if(s.includes("do_not")||s.includes("unsafe")||s.includes("reject"))return ["Do not switch","verdict-red"];
    if(s.includes("ask")||s.includes("doctor")||s.includes("caution")||s.includes("review"))return ["Ask a professional","verdict-amber"];
    return ["Not enough data","verdict-grey"];
  }
  function renderResult(r) {
    $("#search-state").hidden=true;const panel=$("#result-panel");panel.hidden=false;
    const [verdict,cls]=verdictMeta(r.verdict);
    const priceAvailable=r.brandPrice!==null&&r.brandPrice!==""&&r.brandPrice!==undefined;
    const altAvailable=r.genericPrice!==null&&r.genericPrice!==""&&r.genericPrice!==undefined;
    const saving= r.saving!==null&&r.saving!==undefined ? Number(r.saving) : (priceAvailable&&altAvailable ? Number(r.brandPrice)-Number(r.genericPrice):null);
    const sourceLine=r.isDemo?"DEMO MODE · No live medicine data connected":(r.source?"Source: "+r.source:"Connected API result");
    panel.innerHTML=`<div class="result-shell">
      <div class="result-head"><div><span class="tag">${r.isDemo?"SAMPLE RESULT":"MEDICINE RESULT"}</span><h2>${safe(r.name)}</h2><p>${safe([r.strength,r.form].filter(Boolean).join(" · ")||"Details as returned by available data")}</p></div><div class="result-actions"><span class="verdict-badge ${cls}">${safe(verdict)}</span><button class="btn btn-outline" id="save-result">＋ Save to my medicines</button></div></div>
      <div class="result-body"><div class="result-grid">
        <div class="result-box"><h3>Medicine details</h3><div class="data-line"><span>Composition</span><strong>${safe(r.composition||"Not available")}</strong></div><div class="data-line"><span>Manufacturer / brand</span><strong>${safe(r.manufacturer||"Not available")}</strong></div><div class="data-line"><span>Dosage form</span><strong>${safe(r.form||"Not available")}</strong></div></div>
        <div class="result-box"><h3>Price comparison</h3><div class="data-line"><span>Current / brand price</span><strong>${priceAvailable?money(r.brandPrice):"Not available"}</strong></div><div class="data-line"><span>Possible alternative</span><strong>${safe(r.genericName||"Not verified")}</strong></div><div class="data-line"><span>Alternative price</span><strong>${altAvailable?money(r.genericPrice):"Not available"}</strong></div>${saving!==null&&Number.isFinite(saving)&&saving>0?`<div class="saving-banner"><span class="saving-icon">↗</span><div><strong>${money(saving)}</strong><small>Potential difference per listed pack · verify pack size and prices</small></div></div>`:"<p class='result-foot'>A savings estimate is shown only when comparable price data is available.</p>"}</div>
      </div>
      <div class="result-warning"><span>ⓘ</span><p><strong>${safe(verdict)}:</strong> ${safe(r.reason)} ${r.isDemo?"This is a demonstration result, not verified live data.":""} Do not change your medicine based on this screen alone.</p></div>
      <div class="result-foot">${safe(sourceLine)}${r.confidence!==null?" · Match confidence: "+safe(r.confidence):""}</div></div></div>`;
    $("#save-result").addEventListener("click",()=>saveResult(r,saving));
  }
  function saveResult(r,saving) {
    const list=getStore();
    const item={id:Date.now(),name:r.name,composition:r.composition,price:r.brandPrice,altPrice:r.genericPrice,notes:r.isDemo?"Demo result — verify details before use.":("Safety status: "+verdictMeta(r.verdict)[0]),savedAt:new Date().toISOString()};
    list.unshift(item);setStore(list);medicines=list;updateCount();renderSavings();toast("Saved to My medicines on this device.");$("#save-result").textContent="✓ Saved";$("#save-result").disabled=true;
  }
  const trackedSaving = m => {const a=Number(m.price),b=Number(m.altPrice);return Number.isFinite(a)&&Number.isFinite(b)&&a>b?a-b:0;};
  function renderSavings(){const total=getStore().reduce((s,m)=>s+trackedSaving(m),0);$("#home-savings").textContent=money(total);}
  function updateCount(){const n=getStore().length;$("#medicine-count").textContent=n;$("#list-count-title").textContent=n+" saved medicine"+(n===1?"":"s");$("#list-subtitle").textContent=n+" item"+(n===1?"":"s");}
  function renderMedicines(){
    medicines=getStore();updateCount();renderSavings();const list=$("#my-medicines-list"),empty=$("#list-empty");
    empty.hidden=medicines.length>0;list.innerHTML="";
    medicines.forEach(m=>{
      const saving=trackedSaving(m),row=document.createElement("article");row.className="medicine-row";
      row.innerHTML=`<div class="medicine-symbol">▤</div><div class="medicine-main"><strong>${safe(m.name)}</strong><small>${safe(m.composition||"Composition not entered")}${m.notes?" · "+safe(m.notes):""}</small></div><div class="medicine-prices"><strong>${m.price!==null&&m.price!==""?money(m.price):"—"}</strong><small>${saving>0?"Potential difference "+money(saving):"Prices not compared"}</small></div><div class="row-actions"><button class="small-action" data-edit="${m.id}">Edit</button><button class="small-action" data-delete="${m.id}" aria-label="Delete ${safe(m.name)}">Delete</button></div>`;
      list.appendChild(row);
    });
    $$("[data-edit]",list).forEach(b=>b.addEventListener("click",()=>openEditor(Number(b.dataset.edit))));
    $$("[data-delete]",list).forEach(b=>b.addEventListener("click",()=>{const id=Number(b.dataset.delete);setStore(getStore().filter(m=>m.id!==id));renderMedicines();toast("Medicine removed from this device.");}));
  }
  const dialog=$("#medicine-dialog");
  function openEditor(id=null){
    editingId=id;const m=id?getStore().find(x=>x.id===id):null;
    $("#dialog-title").textContent=m?"Edit medicine":"Add a medicine";
    $("#edit-name").value=m?.name||"";$("#edit-composition").value=m?.composition||"";$("#edit-current-price").value=m?.price??"";$("#edit-alt-price").value=m?.altPrice??"";$("#edit-notes").value=m?.notes||"";
    dialog.showModal();
  }
  $("#add-manual-medicine").addEventListener("click",()=>openEditor());
  $("#empty-add").addEventListener("click",()=>openEditor());
  $("#cancel-editor").addEventListener("click",()=>dialog.close());
  $("#medicine-editor").addEventListener("submit",e=>{
    e.preventDefault();const old=getStore();const item={id:editingId||Date.now(),name:$("#edit-name").value.trim(),composition:$("#edit-composition").value.trim(),price:$("#edit-current-price").value===""?null:Number($("#edit-current-price").value),altPrice:$("#edit-alt-price").value===""?null:Number($("#edit-alt-price").value),notes:$("#edit-notes").value.trim(),savedAt:new Date().toISOString()};
    if(editingId){const i=old.findIndex(m=>m.id===editingId);if(i>=0)old[i]=item;else old.unshift(item);}else old.unshift(item);
    setStore(old);dialog.close();renderMedicines();toast(editingId?"Medicine updated.":"Medicine saved on this device.");
  });
  $("#export-list").addEventListener("click",()=>{
    const data=getStore();if(!data.length){toast("Your list is empty.");return;}
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="medsetu-my-medicines.json";a.click();URL.revokeObjectURL(url);toast("Export started.");
  });
  const fileInput=$("#prescription-file");
  fileInput.addEventListener("change",async()=>{
    const file=fileInput.files?.[0];if(!file)return;
    if(file.size>10*1024*1024){toast("Please choose an image smaller than 10 MB.");fileInput.value="";return;}
    const preview=$("#file-preview");preview.hidden=false;$("#clear-file").hidden=false;
    const url=URL.createObjectURL(file);preview.innerHTML=`<img src="${url}" alt="Selected prescription preview"><span><strong>${safe(file.name)}</strong><br>Selected photo · review extracted text carefully</span>`;
    try {
      const form=new FormData();form.append("file",file);form.append("image",file);
      const res=await fetchCandidates(API.ocr,{method:"POST",body:form});
      const text=res.data?.text||res.data?.extracted_text||res.data?.ocr_text||res.data?.result?.text||"";
      if(text){const q=$("#medicine-query-secondary");q.value=text.slice(0,500);toast("Text extracted. Review it carefully, then search.");}
      else toast("Photo uploaded to the connected OCR endpoint. Review any extracted text before using it.");
    } catch {toast("OCR endpoint is not connected yet. You can still type the medicine name manually.");}
  });
  $("#clear-file").addEventListener("click",()=>{fileInput.value="";$("#file-preview").hidden=true;$("#file-preview").innerHTML="";$("#clear-file").hidden=true;});
  $("#kendra-form").addEventListener("submit",async e=>{
    e.preventDefault();const q=$("#kendra-location").value.trim();const out=$("#kendra-results");
    out.innerHTML='<div class="empty-state"><h2>Looking for listings…</h2><p>Checking available store information.</p></div>';
    try{
      const response=await fetchCandidates(API.kendras,{method:"GET",headers:{"Accept":"application/json"}});
      const d=response.data;const items=Array.isArray(d)?d:(d.results||d.kendras||d.items||[]);
      if(!items.length){
        out.innerHTML=`<div class="empty-state"><h2>No verified local listings found</h2><p>${safe(d.notice||"No matching Kendra records are stored in this demo database.")}</p><p>Try another city or PIN code, or check the official Jan Aushadhi website for current store details.</p><a class="text-link" target="_blank" rel="noopener noreferrer" href="https://janaushadhi.gov.in/">Open official Jan Aushadhi website ↗</a></div>`;
      } else {
        out.innerHTML=items.map(k=>`<article class="kendra-result"><div class="action-icon teal">⌖</div><div><strong>${safe(k.name||k.kendra_name||"Jan Aushadhi Kendra")}</strong><p>${safe(k.address||k.location||"Address not provided")}${k.pincode?" · PIN "+safe(k.pincode):""}</p>${k.phone?`<a href="tel:${safe(k.phone)}">Call ${safe(k.phone)}</a>`:""}</div></article>`).join("")+`<p class="search-foot">${safe(d.notice||"Verify store details before travelling.")}</p>`;
      }
    }catch{
      out.innerHTML=`<div class="option-card"><span class="action-icon blue">↗</span><div><strong>Use the official locator</strong><p>The local store-search API is not connected. Search for <b>${safe(q)}</b> on the official Jan Aushadhi website and call to confirm stock.</p><a class="text-link" target="_blank" rel="noopener noreferrer" href="https://janaushadhi.gov.in/">Open official website ↗</a></div></div>`;
    }
  });
  // Improve location lookup with a query parameter if the backend supports it.
  const originalFetchCandidates=fetchCandidates;
  fetchCandidates = async (paths, options) => {
    if(paths===API.kendras){
      let last;
      for(const path of paths){
        try{const u=new URL(API_BASE+path,window.location.origin);u.searchParams.set("q",$("#kendra-location").value.trim());u.searchParams.set("location",$("#kendra-location").value.trim());const res=await fetch(u.toString(),options);if(res.status===404||res.status===405)continue;if(!res.ok){last=new Error("Request failed");continue;}return {data:await res.json(),path};}catch(e){last=e;}
      }throw last||new Error("No locator endpoint");
    }
    return originalFetchCandidates(paths,options);
  };
  // Initial state
  updateCount();renderSavings();
})();