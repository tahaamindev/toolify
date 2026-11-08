
(function(){
"use strict";

/* ============================================================
   0. CONSTANTS
   ============================================================ */
const DB_NAME = "toolify-db";
const DB_VERSION = 1;
const APP_VERSION = "1.1.0";
const BACKUP_APP_ID = "toolify";
const BACKUP_SCHEMA_VERSION = 1;
const UNCATEGORIZED_ID = "uncategorized";
const MAX_SNAPSHOTS = 5;

/* ============================================================
   1. LOCAL CACHE + SUPABASE CLOUD DATABASE
   ============================================================ */
const SUPABASE_URL = "https://ihlqghvdfunsfdnlaoks.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_roUVfR56-WA4eDay7bN_kg_g3mb2PwX";
let supabaseClient = null;
try{
  supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage,
      storageKey: 'toolify-auth'
    }
  }) : null;
}catch(error){
  console.error('Supabase initialization failed:',error);
}
let currentUser = null;
let cloudSyncBusy = false;
let libraryLoading = false;
const DB = (function(){
  let dbInstance = null;
  function open(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=e=>{const db=e.target.result;for(const [n,k] of [['tools','id'],['categories','id'],['settings','key'],['snapshots','id']])if(!db.objectStoreNames.contains(n))db.createObjectStore(n,{keyPath:k});};req.onsuccess=e=>{dbInstance=e.target.result;resolve(dbInstance);};req.onerror=e=>reject(e.target.error);});}
  function tx(n,m){return dbInstance.transaction(n,m).objectStore(n);}
  function localGetAll(n){return new Promise((resolve,reject)=>{try{const r=tx(n,'readonly').getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  function localPut(n,v){return new Promise((resolve,reject)=>{try{const r=tx(n,'readwrite').put(v);r.onsuccess=()=>resolve(true);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  function localBulkPut(n,vs){return new Promise((resolve,reject)=>{try{const st=tx(n,'readwrite');vs.forEach(v=>st.put(v));st.transaction.oncomplete=()=>resolve(true);st.transaction.onerror=()=>reject(st.transaction.error);}catch(e){reject(e);}});}
  function localDel(n,k){return new Promise((resolve,reject)=>{try{const r=tx(n,'readwrite').delete(k);r.onsuccess=()=>resolve(true);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  function localClear(n){return new Promise((resolve,reject)=>{try{const r=tx(n,'readwrite').clear();r.onsuccess=()=>resolve(true);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  const tableFor={tools:'tools',categories:'categories',settings:'settings',snapshots:'snapshots'};
  function toCloud(n,v){const base={user_id:currentUser.id};if(n==='tools')return {...base,id:v.id,name:v.name,url:v.url,category_id:v.categoryId||'uncategorized',description:v.description||'',favorite:!!v.favorite,icon_failed:!!v.iconFailed,created_at:v.createdAt||new Date().toISOString(),updated_at:v.updatedAt||new Date().toISOString()};if(n==='categories')return {...base,id:v.id,name:v.name,system:!!v.system,created_at:v.createdAt||new Date().toISOString()};if(n==='settings')return {...base,key:v.key,value:v.value??{}};return {...base,id:v.id,created_at:v.createdAt||new Date().toISOString(),data:{tools:v.tools||[],categories:v.categories||[],settings:v.settings||{}}};}
  function fromCloud(n,v){if(n==='tools')return {id:v.id,name:v.name,url:v.url,categoryId:v.category_id,description:v.description||'',favorite:!!v.favorite,iconFailed:!!v.icon_failed,createdAt:v.created_at,updatedAt:v.updated_at};if(n==='categories')return {id:v.id,name:v.name,system:!!v.system,createdAt:v.created_at};if(n==='settings')return {key:v.key,value:v.value};return {id:v.id,createdAt:v.created_at,tools:v.data?.tools||[],categories:v.data?.categories||[],settings:v.data?.settings||{}};}
  async function cloudUpsert(n,values){if(!currentUser||!values.length)return;const rows=values.map(v=>toCloud(n,v));const conflict=n==='settings'?'user_id,key':'user_id,id';const {error}=await supabaseClient.from(tableFor[n]).upsert(rows,{onConflict:conflict});if(error)throw error;}
  async function cloudDelete(n,key){if(!currentUser)return;let q=supabaseClient.from(tableFor[n]).delete().eq('user_id',currentUser.id);q=q.eq(n==='settings'?'key':'id',key);const {error}=await q;if(error)throw error;}
  async function cloudClear(n){if(!currentUser)return;const {error}=await supabaseClient.from(tableFor[n]).delete().eq('user_id',currentUser.id);if(error)throw error;}
  async function put(n,v){await localPut(n,v);if(currentUser&&!cloudSyncBusy)await cloudUpsert(n,[v]);return true;}
  async function bulkPut(n,vs){await localBulkPut(n,vs);if(currentUser&&!cloudSyncBusy)await cloudUpsert(n,vs);return true;}
  async function del(n,k){await localDel(n,k);if(currentUser&&!cloudSyncBusy)await cloudDelete(n,k);return true;}
  async function clearStore(n){await localClear(n);if(currentUser&&!cloudSyncBusy)await cloudClear(n);return true;}
  async function syncForUser(user){
    currentUser=user;cloudSyncBusy=true;
    try{
      const names=['categories','tools','settings','snapshots'];
      const local={};for(const n of names)local[n]=await localGetAll(n);
      const remote={};for(const n of names){const {data,error}=await supabaseClient.from(tableFor[n]).select('*').eq('user_id',user.id);if(error)throw error;remote[n]=(data||[]).map(v=>fromCloud(n,v));}
      const hasRemote=names.some(n=>remote[n].length>0);
      if(!hasRemote){
        if(!local.categories.some(c=>c.id==='uncategorized'))local.categories.push({id:'uncategorized',name:'Uncategorized',system:true,createdAt:new Date().toISOString()});
        if(local.categories.length)await cloudUpsert('categories',local.categories);
        if(local.tools.length)await cloudUpsert('tools',local.tools);
        if(local.settings.length)await cloudUpsert('settings',local.settings);
        if(local.snapshots.length)await cloudUpsert('snapshots',local.snapshots);
        for(const n of names){const {data,error}=await supabaseClient.from(tableFor[n]).select('*').eq('user_id',user.id);if(error)throw error;remote[n]=(data||[]).map(v=>fromCloud(n,v));}
      }
      for(const n of names){await localClear(n);if(remote[n].length)await localBulkPut(n,remote[n]);}
    }finally{cloudSyncBusy=false;}
  }
  async function clearLocal(){for(const n of ['tools','categories','settings','snapshots'])await localClear(n);}
  return {open,getAll:localGetAll,put,bulkPut,del,clearStore,syncForUser,clearLocal};
})();

/* ============================================================
   2. UTILITIES
   ============================================================ */
function uid(){
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,9);
}
function nowISO(){ return new Date().toISOString(); }
function escapeHTML(str){
  const d = document.createElement('div');
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}
function debounce(fn, wait){
  let t;
  return function(...args){ clearTimeout(t); t = setTimeout(()=>fn.apply(this,args), wait); };
}

/* URL normalization & validation */
const SAFE_PROTOCOLS = ["http:", "https:"];
function normalizeURL(raw){
  if(!raw) return null;
  let s = raw.trim();
  if(!s) return null;
  // reject dangerous schemes explicitly even before URL parsing
  const lowered = s.toLowerCase();
  const dangerous = ["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"];
  if(dangerous.some(p => lowered.startsWith(p))) return null;
  if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)){
    s = "https://" + s;
  }
  try{
    const u = new URL(s);
    if(!SAFE_PROTOCOLS.includes(u.protocol)) return null;
    if(!u.hostname || !u.hostname.includes(".")) {
      // allow localhost-like single-word hosts to fail gracefully but still permit if it has a dot or is a valid host
      if(u.hostname.length < 1) return null;
    }
    return u.href;
  }catch(e){
    return null;
  }
}
function normalizeForDupCheck(urlStr){
  try{
    const u = new URL(urlStr);
    let host = u.hostname.toLowerCase().replace(/^www\./,'');
    let path = u.pathname.replace(/\/$/,'');
    return (host + path + u.search).toLowerCase();
  }catch(e){ return urlStr.toLowerCase(); }
}
function isSafeToOpen(urlStr){
  try{
    const u = new URL(urlStr);
    return SAFE_PROTOCOLS.includes(u.protocol);
  }catch(e){ return false; }
}
function faviconURLFor(urlStr){
  try{
    const u = new URL(urlStr);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  }catch(e){ return null; }
}
function initialFor(name){
  if(!name) return "?";
  const trimmed = name.trim();
  return trimmed.length ? trimmed[0].toUpperCase() : "?";
}

/* ============================================================
   3. STATE
   ============================================================ */
const State = {
  tools: [],
  categories: [],
  settings: {
    theme: "dark",
    view: "grid",
    sort: "recent",
    lastBackupAt: null,
    landing: "auto",
clickSound: "click",
quickTools: undefined,
notes: []
  },
  ui: {
    activeNav: "all",   // 'all' | 'favorites' | categoryId
    search: "",
    sidebarCollapsed: false
  }
};

async function persistSettings(){
  await DB.put("settings", {key:"app", value: State.settings});
}
const DEFAULT_QUICK_TOOLS = [
  {id:'gemini', name:'Gemini', url:'https://gemini.google.com/'},
  {id:'ai-studio', name:'Google AI Studio', url:'https://aistudio.google.com/'},
  {id:'notebooklm', name:'NotebookLM', url:'https://notebooklm.google.com/'},
  {id:'drive', name:'Google Drive', url:'https://drive.google.com/'},
  {id:'gmail', name:'Gmail', url:'https://mail.google.com/'},
  {id:'docs', name:'Google Docs', url:'https://docs.google.com/'},
  {id:'calendar', name:'Google Calendar', url:'https://calendar.google.com/'},
  {id:'translate', name:'Google Translate', url:'https://translate.google.com/'}
];
function quickToolsList(){
  if(!Array.isArray(State.settings.quickTools)) State.settings.quickTools = DEFAULT_QUICK_TOOLS.map(t=>({...t}));
  return State.settings.quickTools;
}

function notesList(){
  if(!Array.isArray(State.settings.notes)) State.settings.notes = [];
  return State.settings.notes;
}

function renderQuickNotes(){
  const list = document.getElementById('quick-notes-list');
  if(!list) return;
  list.innerHTML = notesList().length
    ? notesList().slice().reverse().map(note=>`<div class="quick-note-item">${escapeHTML(note.text)}<button class="quick-note-delete" type="button" data-delete-note="${escapeHTML(note.id)}" aria-label="Delete note">&times;</button></div>`).join('')
    : '<div class="quick-note-empty">No saved notes yet.</div>';
  list.querySelectorAll('[data-delete-note]').forEach(button=>{
    button.addEventListener('click', async ()=>{
      State.settings.notes = notesList().filter(note=>note.id !== button.dataset.deleteNote);
      await persistSettings();
      renderQuickNotes();
    });
  });
}
function faviconURL(url){
  try{
    const hostname = new URL(normalizeURL(url) || url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
  }catch(e){
    return '';
  }
}
function renderQuickTools(){
  const nav = document.getElementById('quick-tools-nav');
  if(!nav) return;
  nav.innerHTML = quickToolsList().map(tool=>`
    <a class="quick-tool" data-sidebar-id="${escapeHTML(tool.id)}" href="${escapeHTML(tool.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHTML(tool.name)}" title="${escapeHTML(tool.name)}">
      <img src="${escapeHTML(faviconURL(tool.url))}" alt="" referrerpolicy="no-referrer">
      <span class="quick-tool-name">${escapeHTML(tool.name)}</span>
    </a>
  `).join('');

  const tooltip = document.getElementById('quick-tool-tooltip');
  nav.onpointermove = (event)=>{
    [...nav.querySelectorAll('.quick-tool')].forEach(item=>{
      const rect = item.getBoundingClientRect();
      const distance = Math.abs(event.clientY - (rect.top + rect.height / 2));
      const influence = Math.max(0, 1 - distance / 64);
      item.style.setProperty('--dock-scale', (1 + influence * 0.26).toFixed(2));
    });
  };
  nav.onpointerleave = ()=>{
    nav.querySelectorAll('.quick-tool').forEach(item=>item.style.setProperty('--dock-scale', '1'));
    tooltip?.classList.remove('open');
  };

  nav.querySelectorAll('.quick-tool').forEach(item=>{
    const showTooltip = ()=>{
      if(!tooltip) return;
      tooltip.textContent = item.getAttribute('aria-label') || '';
      const dockRect = document.querySelector('.quick-tools').getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      tooltip.style.left = `${Math.max(8, dockRect.left - 10)}px`;
      tooltip.style.top = `${itemRect.top + itemRect.height / 2}px`;
      tooltip.style.transform = 'translate(-100%, -50%) scale(1)';
      tooltip.classList.add('open');
    };
    const hideTooltip = ()=>tooltip?.classList.remove('open');
    item.addEventListener('pointerenter', showTooltip);
    item.addEventListener('pointerleave', hideTooltip);
    item.addEventListener('focus', showTooltip);
    item.addEventListener('blur', hideTooltip);
    item.addEventListener('contextmenu', (event)=>{
      event.preventDefault();
      hideTooltip();
      const tool = quickToolsList().find(shortcut=>shortcut.id === item.dataset.sidebarId);
      if(tool) showToolContextMenu(event.clientX, event.clientY, tool, 'sidebar');
    });
  });
}
async function persistTool(tool){
  await DB.put("tools", tool);
}
async function persistCategory(cat){
  await DB.put("categories", cat);
}

/* ============================================================
   4. TOAST
   ============================================================ */
function playClickSound(){
  const pref = State.settings.clickSound || 'off';
  if(pref === 'off') return;
  try{
    const ctx = playClickSound._ctx || (playClickSound._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    if(pref === 'click'){ osc.type='square'; osc.frequency.setValueAtTime(820, now); gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.0001, now+0.06); osc.start(now); osc.stop(now+0.06); }
    else if(pref === 'pop'){ osc.type='sine'; osc.frequency.setValueAtTime(620, now); osc.frequency.exponentialRampToValueAtTime(280, now+0.09); gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.0001, now+0.1); osc.start(now); osc.stop(now+0.1); }
    else if(pref === 'ding'){ osc.type='sine'; osc.frequency.setValueAtTime(880, now); gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.0001, now+0.25); osc.start(now); osc.stop(now+0.25); }
  }catch(e){}
}
function toast(msg, type){
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  const icon = type === 'error'
    ? '<svg viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="1.8"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span></span>`;
  el.querySelector('span:last-child').textContent = msg;
  document.getElementById('toast-stack').appendChild(el);
  setTimeout(()=>{
    el.classList.add('leaving');
    setTimeout(()=>el.remove(), 200);
  }, 2600);
}

/* ============================================================
   5. CATEGORY HELPERS
   ============================================================ */
function getCategory(id){
  return State.categories.find(c => c.id === id) || State.categories.find(c => c.id === UNCATEGORIZED_ID);
}
function categoryToolCount(id){
  return State.tools.filter(t => t.categoryId === id).length;
}
function ensureUncategorized(){
  if(!State.categories.find(c => c.id === UNCATEGORIZED_ID)){
    State.categories.push({id: UNCATEGORIZED_ID, name:"Uncategorized", system:true, createdAt: nowISO()});
  }
}

/* ============================================================
   6. RENDER: SIDEBAR
   ============================================================ */
function iconSVG(name){
  const icons = {
    all: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/></svg>',
    fav: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 17.3l-5.4 3.2 1.4-6.1L3 10l6.2-.5L12 3.7l2.8 5.8 6.2.5-4.9 4.4 1.4 6.1z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    uncat: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };
  return icons[name] || icons.all;
}

function renderSidebar(){
  const sys = document.getElementById('nav-system');
  const favCount = State.tools.filter(t => t.favorite).length;
  const allCount = State.tools.length;
  let sysHTML = `
    <button class="nav-item ${State.ui.activeNav==='all'?'active':''}" data-nav="all">
      <span class="nav-icon">${iconSVG('all')}</span>
      <span class="nav-label">All Tools</span>
      <span class="nav-count">${allCount}</span>
    </button>`;
  if(favCount > 0){
    sysHTML += `
    <button class="nav-item ${State.ui.activeNav==='favorites'?'active':''}" data-nav="favorites">
      <span class="nav-icon">${iconSVG('fav')}</span>
      <span class="nav-label">Favorites</span>
      <span class="nav-count">${favCount}</span>
    </button>`;
  }
  sys.innerHTML = sysHTML;

  const catWrap = document.getElementById('nav-categories');
  const userCats = State.categories.filter(c => c.id !== UNCATEGORIZED_ID).sort((a,b)=>a.name.localeCompare(b.name));
  const uncat = State.categories.find(c=>c.id===UNCATEGORIZED_ID);
  let html = '';
  userCats.forEach(c => {
    html += `<button class="nav-item ${State.ui.activeNav===c.id?'active':''}" data-nav="${c.id}">
      <span class="nav-icon"><span class="cat-dot"></span></span>
      <span class="nav-label">${escapeHTML(c.name)}</span>
      <span class="nav-count">${categoryToolCount(c.id)}</span>
    </button>`;
  });
  if(uncat && categoryToolCount(UNCATEGORIZED_ID) > 0){
    html += `<button class="nav-item ${State.ui.activeNav===UNCATEGORIZED_ID?'active':''}" data-nav="${UNCATEGORIZED_ID}">
      <span class="nav-icon">${iconSVG('uncat')}</span>
      <span class="nav-label">Uncategorized</span>
      <span class="nav-count">${categoryToolCount(UNCATEGORIZED_ID)}</span>
    </button>`;
  }
  catWrap.innerHTML = html || `<div style="padding:8px 10px; font-size:12px; color:var(--text-tertiary);">No categories yet</div>`;

  document.querySelectorAll('[data-nav]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      State.ui.activeNav = btn.dataset.nav;
      State.ui.search = "";
      document.getElementById('mac-search-input').value = "";
      closeMobileSidebar();
      render();
    });
  });
}

/* ============================================================
   7. FILTER / SORT / SEARCH PIPELINE
   ============================================================ */
function getCurrentToolset(){
  let list = State.tools.slice();
  if(State.ui.activeNav === 'favorites'){
    list = list.filter(t => t.favorite);
  } else if(State.ui.activeNav !== 'all'){
    list = list.filter(t => t.categoryId === State.ui.activeNav);
  }
  const q = State.ui.search.trim().toLowerCase();
  if(q){
    list = list.filter(t => {
      const cat = getCategory(t.categoryId);
      return t.name.toLowerCase().includes(q) ||
             (t.description||"").toLowerCase().includes(q) ||
             (cat && cat.name.toLowerCase().includes(q));
    });
  }
  switch(State.settings.sort){
    case 'az': list.sort((a,b)=>a.name.localeCompare(b.name)); break;
    case 'za': list.sort((a,b)=>b.name.localeCompare(a.name)); break;
    case 'oldest': list.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)); break;
    case 'recent': list.sort((a,b)=>new Date(b.lastOpenedAt||0)-new Date(a.lastOpenedAt||0)); break;
    default: list.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); // newest
  }
  return list;
}

/* ============================================================
   8. RENDER: TOP BAR TITLE
   ============================================================ */
function renderTopbar(list){
  let title = "All Tools";
  if(State.ui.activeNav === 'favorites') title = "Favorites";
  else if(State.ui.activeNav === UNCATEGORIZED_ID) title = "Uncategorized";
  else if(State.ui.activeNav !== 'all'){
    const c = getCategory(State.ui.activeNav);
    title = c ? c.name : "Category";
  }
  document.getElementById('view-title').textContent = title;
  const n = list.length;
  document.getElementById('view-sub').textContent = `${n} tool${n===1?'':'s'}`;
}

/* ============================================================
   9. RENDER: TOOL GRID / LIST
   ============================================================ */
function faviconMarkup(tool){
  const initial = initialFor(tool.name);
  if(tool.iconFailed){
    return `<div class="tool-icon-fallback">${escapeHTML(initial)}</div>`;
  }
  const src = faviconURLFor(tool.url);
  if(!src){
    return `<div class="tool-icon-fallback">${escapeHTML(initial)}</div>`;
  }
  return `<img src="${escapeHTML(src)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;tool-icon-fallback&quot;>${escapeHTML(initial)}</div>'">`;
}

function renderGrid(){
  const list = getCurrentToolset();
  renderTopbar(list);
  const grid = document.getElementById('tool-grid');
  grid.classList.toggle('list-mode', State.settings.view === 'list');
  grid.classList.toggle('compact-mode', State.settings.view === 'compact');

  if(libraryLoading){
    grid.innerHTML = Array.from({length:8},()=>`
      <div class="tool-skeleton" aria-hidden="true">
        <div class="tool-skeleton-icon"></div>
        <div class="tool-skeleton-lines">
          <div class="tool-skeleton-line tool-skeleton-line-title"></div>
          <div class="tool-skeleton-line tool-skeleton-line-url"></div>
        </div>
      </div>`).join('');
    return;
  }

  if(list.length === 0){
    grid.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    if(State.tools.length === 0){
      wrap.innerHTML = `
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none"><rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" stroke="currentColor" stroke-width="1.6"/></svg>
        <div class="empty-title">Your tool library is empty</div>
        <div class="empty-sub">Save the websites and tools you use often, and open them here in one click.</div>
        <button class="btn-primary" id="empty-add-btn">Add your first tool</button>`;
    } else if(State.ui.search.trim()){
      wrap.innerHTML = `
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <div class="empty-title">No matching tools found</div>
        <div class="empty-sub">Try a different search term or clear the filter.</div>`;
    } else {
      wrap.innerHTML = `
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none"><path d="M12 17.3l-5.4 3.2 1.4-6.1L3 10l6.2-.5L12 3.7l2.8 5.8 6.2.5-4.9 4.4 1.4 6.1z" stroke="currentColor" stroke-width="1.6"/></svg>
        <div class="empty-title">No tools in this category yet</div>
        <div class="empty-sub">Add a tool and assign it here to see it appear.</div>`;
    }
    grid.appendChild(wrap);
    const addBtn = document.getElementById('empty-add-btn');
    if(addBtn) addBtn.addEventListener('click', ()=>openToolModal());
    return;
  }

  grid.innerHTML = list.map(tool => {
    const cat = getCategory(tool.categoryId);
    const favSvg = tool.favorite ? '<span class="fav-indicator"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.3l-5.4 3.2 1.4-6.1L3 10l6.2-.5L12 3.7l2.8 5.8 6.2.5-4.9 4.4 1.4 6.1z"/></svg></span>' : '';
    if(State.settings.view === 'list'){
      return `<div class="tool-card" data-id="${tool.id}" tabindex="0" role="button" aria-label="Open ${escapeHTML(tool.name)}">
        <div class="tool-icon">${faviconMarkup(tool)}</div>
        <div class="card-body">
          <div class="tool-name">${escapeHTML(tool.name)}</div>
          <div class="tool-desc">${escapeHTML(tool.description||'')}</div>
          <div class="tool-badge"><span class="dot"></span>${escapeHTML(cat?cat.name:'Uncategorized')}</div>
        </div>
        ${favSvg}
      </div>`;
    }
    if(State.settings.view === 'compact'){
      return `<div class="tool-card" data-id="${tool.id}" tabindex="0" role="button" aria-label="Open ${escapeHTML(tool.name)}" title="${escapeHTML(tool.name)}">
        <div class="tool-icon">${faviconMarkup(tool)}</div>
        <div class="compact-name">${escapeHTML(tool.name)}</div>
      </div>`;
    }
    return `<div class="tool-card" data-id="${tool.id}" tabindex="0" role="button" aria-label="Open ${escapeHTML(tool.name)}">
      <div class="card-top">
        <div class="tool-icon">${faviconMarkup(tool)}</div>
        ${favSvg}
      </div>
      <div class="tool-name">${escapeHTML(tool.name)}</div>
      <div class="tool-desc">${escapeHTML(tool.description||'')}</div>
      <div class="tool-badge"><span class="dot"></span>${escapeHTML(cat?cat.name:'Uncategorized')}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.tool-card').forEach(card => {
    const id = card.dataset.id;
    const tool = State.tools.find(t=>t.id===id);
    card.addEventListener('click', ()=> openTool(tool));
    card.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openTool(tool); } });
    card.addEventListener('contextmenu', (event)=>{
      event.preventDefault();
      showToolContextMenu(event.clientX, event.clientY, tool, 'library');
    });
  });
}

let contextMenuTarget = null;
let contextMenuType = null;

function showToolContextMenu(x, y, tool, type='library'){
  const menu = document.getElementById('tool-context-menu');
  if(!menu || !tool) return;
  contextMenuTarget = tool;
  contextMenuType = type;
  const label = menu.querySelector('[data-context-action="favorite"]');
  const sidebarAction = menu.querySelector('[data-context-action="sidebar"]');
  const removeAction = menu.querySelector('[data-context-action="delete"]');
  label.textContent = tool.favorite ? 'Remove from Favorites' : 'Add to Favorites';
  if(type === 'sidebar'){
    sidebarAction.textContent = 'Remove from Sidebar';
    sidebarAction.dataset.contextAction = 'remove-sidebar';
    removeAction.textContent = 'Remove';
  }else{
    sidebarAction.textContent = quickToolsList().some(item=>item.url === tool.url) ? 'Added to Sidebar' : 'Add to Sidebar';
    sidebarAction.dataset.contextAction = 'sidebar';
    removeAction.textContent = 'Remove';
  }
  menu.style.left = `${Math.min(x, window.innerWidth - 210)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 210)}px`;
  menu.classList.add('open');
  menu.setAttribute('aria-hidden', 'false');
}

function hideToolContextMenu(){
  const menu = document.getElementById('tool-context-menu');
  menu?.classList.remove('open');
  menu?.setAttribute('aria-hidden', 'true');
  contextMenuTarget = null;
  contextMenuType = null;
}

async function addLibraryToolToSidebar(tool){
  if(!tool) return;
  if(quickToolsList().some(item=>item.url === tool.url)){
    toast('This tool is already on the sidebar.');
    return;
  }
  State.settings.quickTools = quickToolsList();
  State.settings.quickTools.push({id:uid(), name:tool.name, url:normalizeURL(tool.url)});
  await persistSettings();
  renderQuickTools();
  renderQuickNotes();
  toast('Added to Sidebar.');
}

function openTool(tool){
  if(!tool || !isSafeToOpen(tool.url)) { toast('This URL cannot be opened safely.', 'error'); return; }
  playClickSound();
  tool.lastOpenedAt = nowISO();
  persistTool(tool).catch(()=>{});
  window.open(tool.url, '_blank', 'noopener,noreferrer');
  if(State.settings.sort === 'recent') render();
}


/* ============================================================
   10. MASTER RENDER
   ============================================================ */
function render(){
  renderSidebar();
  renderQuickTools();
  renderGrid();
  document.querySelectorAll('.view-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===State.settings.view));
  document.getElementById('sort-label').textContent = {newest:'Newest',oldest:'Oldest',az:'A – Z',za:'Z – A',recent:'Recently opened'}[State.settings.sort];
  document.querySelectorAll('.sort-option').forEach(o=>o.classList.toggle('active', o.dataset.sort===State.settings.sort));
}

/* ============================================================
   11. ADD / EDIT TOOL MODAL
   ============================================================ */
let editingToolId = null;
let pendingDuplicateOK = false;

function populateCategorySelect(){
  const sel = document.getElementById('f-category');
  const cats = State.categories.slice().sort((a,b)=>{
    if(a.id===UNCATEGORIZED_ID) return 1;
    if(b.id===UNCATEGORIZED_ID) return -1;
    return a.name.localeCompare(b.name);
  });
  sel.innerHTML = cats.map(c=>`<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
}

function openToolModal(toolId){
  editingToolId = toolId || null;
  pendingDuplicateOK = false;
  populateCategorySelect();
  document.getElementById('dup-warning').style.display = 'none';
  document.getElementById('err-name').classList.remove('show');
  document.getElementById('err-url').classList.remove('show');
  document.getElementById('f-name').classList.remove('invalid');
  document.getElementById('f-url').classList.remove('invalid');

  if(editingToolId){
    const t = State.tools.find(x=>x.id===editingToolId);
    document.getElementById('tool-modal-title').textContent = 'Edit Tool';
    document.getElementById('f-name').value = t.name;
    document.getElementById('f-url').value = t.url;
    document.getElementById('f-category').value = t.categoryId;
    document.getElementById('f-desc').value = t.description || '';
  } else {
    document.getElementById('tool-modal-title').textContent = 'Add Tool';
    document.getElementById('f-name').value = '';
    document.getElementById('f-url').value = '';
    document.getElementById('f-category').value = (State.ui.activeNav !== 'all' && State.ui.activeNav !== 'favorites' && getCategory(State.ui.activeNav)) ? State.ui.activeNav : UNCATEGORIZED_ID;
    document.getElementById('f-desc').value = '';
  }
  const overlay = document.getElementById('tool-overlay');
  overlay.classList.add('open');
  setTimeout(()=>document.getElementById('f-name').focus(), 50);
}
function closeToolModal(){
  document.getElementById('tool-overlay').classList.remove('open');
  editingToolId = null;
}

async function saveTool(){
  const nameEl = document.getElementById('f-name');
  const urlEl = document.getElementById('f-url');
  const name = nameEl.value.trim();
  const rawUrl = urlEl.value.trim();
  const categoryId = document.getElementById('f-category').value;
  const description = document.getElementById('f-desc').value.trim().slice(0,160);

  let valid = true;
  if(!name){ document.getElementById('err-name').classList.add('show'); nameEl.classList.add('invalid'); valid=false; }
  else { document.getElementById('err-name').classList.remove('show'); nameEl.classList.remove('invalid'); }

  const normalized = normalizeURL(rawUrl);
  if(!normalized){ document.getElementById('err-url').classList.add('show'); urlEl.classList.add('invalid'); valid=false; }
  else { document.getElementById('err-url').classList.remove('show'); urlEl.classList.remove('invalid'); }

  if(!valid) return;

  // duplicate check
  const dupKey = normalizeForDupCheck(normalized);
  const dup = State.tools.find(t => normalizeForDupCheck(t.url) === dupKey && t.id !== editingToolId);
  if(dup && !pendingDuplicateOK){
    document.getElementById('dup-warning').style.display = 'flex';
    pendingDuplicateOK = true; // next click proceeds
    return;
  }

  const now = nowISO();
  if(editingToolId){
    const t = State.tools.find(x=>x.id===editingToolId);
    const urlChanged = t.url !== normalized;
    t.name = name.slice(0,60);
    t.url = normalized;
    t.categoryId = categoryId;
    t.description = description;
    t.updatedAt = now;
    if(urlChanged) t.iconFailed = false;
    try{ await persistTool(t); toast('Tool updated'); }
    catch(e){ toast('Could not save changes — storage error', 'error'); return; }
  } else {
    const t = {
      id: uid(), name: name.slice(0,60), url: normalized, categoryId,
      description, favorite:false, iconFailed:false,
      createdAt: now, updatedAt: now
    };
    State.tools.push(t);
    try{ await persistTool(t); toast('Tool saved'); }
    catch(e){ State.tools = State.tools.filter(x=>x.id!==t.id); toast('Could not save tool — storage error', 'error'); return; }
  }
  closeToolModal();
  render();
  refreshManagePanelIfOpen();
}

/* ============================================================
   12. DELETE TOOL (with confirmation)
   ============================================================ */
let pendingDeleteId = null;
function confirmDeleteTool(id){
  const t = State.tools.find(x=>x.id===id);
  if(!t) return;
  pendingDeleteId = id;
  document.getElementById('confirm-title').textContent = 'Delete this tool?';
  document.getElementById('confirm-msg').textContent = `“${t.name}” will be removed from your Toolify library. This cannot be undone.`;
  document.getElementById('confirm-overlay').classList.add('open');
}
function closeConfirm(){ document.getElementById('confirm-overlay').classList.remove('open'); pendingDeleteId = null; }
async function doDeleteTool(){
  if(!pendingDeleteId) return;
  const id = pendingDeleteId;
  State.tools = State.tools.filter(t=>t.id!==id);
  try{ await DB.del('tools', id); toast('Tool deleted'); }
  catch(e){ toast('Delete failed — storage error', 'error'); }
  closeConfirm();
  render();
  refreshManagePanelIfOpen();
}

/* ============================================================
   13. FAVORITE TOGGLE
   ============================================================ */
async function toggleFavorite(id){
  const t = State.tools.find(x=>x.id===id);
  if(!t) return;
  t.favorite = !t.favorite;
  t.updatedAt = nowISO();
  try{ await persistTool(t); } catch(e){ toast('Could not save favorite state', 'error'); }
  render();
}

/* ============================================================
   14. CATEGORY CRUD
   ============================================================ */
async function createCategory(name){
  const clean = (name||'').trim().slice(0,40);
  if(!clean) return null;
  const cat = {id: 'c_'+uid(), name: clean, system:false, createdAt: nowISO()};
  State.categories.push(cat);
  try{ await persistCategory(cat); toast('Category created'); }
  catch(e){ State.categories.pop(); toast('Could not create category', 'error'); return null; }
  render();
  return cat;
}
async function renameCategory(id, newName){
  const c = State.categories.find(x=>x.id===id);
  if(!c || c.system) return;
  const clean = (newName||'').trim().slice(0,40);
  if(!clean) return;
  c.name = clean;
  try{ await persistCategory(c); toast('Category renamed'); }
  catch(e){ toast('Could not rename category', 'error'); }
  render();
}
async function deleteCategory(id){
  const c = State.categories.find(x=>x.id===id);
  if(!c || c.system) return;
  const affected = State.tools.filter(t=>t.categoryId===id);
  affected.forEach(t => { t.categoryId = UNCATEGORIZED_ID; t.updatedAt = nowISO(); });
  State.categories = State.categories.filter(x=>x.id!==id);
  try{
    await DB.del('categories', id);
    if(affected.length) await DB.bulkPut('tools', affected);
    toast(`Category deleted — ${affected.length} tool${affected.length===1?'':'s'} moved to Uncategorized`);
  }catch(e){ toast('Could not delete category — storage error', 'error'); }
  render();
  renderSettingsPanel('categories');
}

/* ============================================================
   15. BACKUP EXPORT
   ============================================================ */
function buildBackupPayload(){
  return {
    app: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: nowISO(),
    tools: State.tools,
    categories: State.categories,
    settings: State.settings,
    integrity: { toolCount: State.tools.length, categoryCount: State.categories.length }
  };
}
async function exportBackup(){
  const payload = buildBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `toolify-backup-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  State.settings.lastBackupAt = nowISO();
  await persistSettings();
  toast('Backup exported');
  renderSettingsPanel('backup');
}

/* ============================================================
   16. IMPORT / RESTORE (validate -> snapshot -> merge)
   ============================================================ */
function validateBackupPayload(obj){
  const errors = [];
  if(!obj || typeof obj !== 'object') { errors.push('File is not a valid JSON object.'); return {valid:false, errors}; }
  if(obj.app !== BACKUP_APP_ID) errors.push('This does not look like a Toolify backup file.');
  if(typeof obj.schemaVersion !== 'number') errors.push('Missing or invalid schema version.');
  if(!Array.isArray(obj.tools)) errors.push('Missing tools array.');
  if(!Array.isArray(obj.categories)) errors.push('Missing categories array.');
  if(errors.length) return {valid:false, errors};

  const cleanCategories = [];
  obj.categories.forEach(c => {
    if(c && typeof c.id === 'string' && typeof c.name === 'string' && c.name.trim()){
      cleanCategories.push({id:c.id, name:c.name.trim().slice(0,40), system: c.id===UNCATEGORIZED_ID, createdAt: c.createdAt || nowISO()});
    }
  });
  if(!cleanCategories.find(c=>c.id===UNCATEGORIZED_ID)){
    cleanCategories.push({id:UNCATEGORIZED_ID, name:'Uncategorized', system:true, createdAt: nowISO()});
  }
  const catIds = new Set(cleanCategories.map(c=>c.id));

  const cleanTools = [];
  let invalidCount = 0;
  obj.tools.forEach(t => {
    if(!t || typeof t !== 'object'){ invalidCount++; return; }
    const norm = typeof t.url === 'string' ? normalizeURL(t.url) : null;
    if(!norm || !t.name || typeof t.name !== 'string'){ invalidCount++; return; }
    cleanTools.push({
      id: typeof t.id === 'string' ? t.id : uid(),
      name: String(t.name).trim().slice(0,60),
      url: norm,
      categoryId: catIds.has(t.categoryId) ? t.categoryId : UNCATEGORIZED_ID,
      description: typeof t.description === 'string' ? t.description.slice(0,160) : '',
      favorite: !!t.favorite,
      iconFailed: false,
      createdAt: t.createdAt || nowISO(),
      updatedAt: t.updatedAt || nowISO()
    });
  });

  return {valid:true, errors:[], tools: cleanTools, categories: cleanCategories, invalidCount};
}

let pendingImport = null;

async function handleImportFile(file){
  try{
    const text = await file.text();
    let parsed;
    try{ parsed = JSON.parse(text); }
    catch(e){ toast('Import failed — file is not valid JSON', 'error'); return; }
    const result = validateBackupPayload(parsed);
    if(!result.valid){
      toast('Import rejected: ' + result.errors[0], 'error');
      return;
    }
    // compute merge preview
    const existingUrlKeys = new Set(State.tools.map(t=>normalizeForDupCheck(t.url)));
    let newTools = 0, dupTools = 0;
    result.tools.forEach(t => {
      if(existingUrlKeys.has(normalizeForDupCheck(t.url))) dupTools++; else newTools++;
    });
    const existingCatNames = new Set(State.categories.map(c=>c.name.toLowerCase()));
    let newCats = 0;
    result.categories.forEach(c => { if(c.id!==UNCATEGORIZED_ID && !existingCatNames.has(c.name.toLowerCase())) newCats++; });

    pendingImport = result;
    document.getElementById('import-body').innerHTML = `
      <p style="font-size:13px; color:var(--text-secondary); line-height:1.6; margin-bottom:14px;">
        This backup contains <strong>${result.tools.length}</strong> tool${result.tools.length===1?'':'s'} and <strong>${result.categories.length}</strong> categor${result.categories.length===1?'y':'ies'}.
        Import will <strong>merge</strong> with your current library — nothing existing will be deleted.
      </p>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num">${newTools}</div><div class="stat-label">New tools</div></div>
        <div class="stat-box"><div class="stat-num">${dupTools}</div><div class="stat-label">Existing / duplicate</div></div>
        <div class="stat-box"><div class="stat-num">${newCats}</div><div class="stat-label">New categories</div></div>
      </div>
      ${result.invalidCount ? `<div class="warn-box"><svg viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="1.8"/></svg><div>${result.invalidCount} record(s) were skipped because they were invalid.</div></div>` : ''}
    `;
    document.getElementById('import-overlay').classList.add('open');
  }catch(e){
    toast('Import failed — could not read file', 'error');
  }
}

async function createSafetySnapshot(){
  try{
    const snap = { id: 'snap_'+Date.now(), createdAt: nowISO(), tools: State.tools, categories: State.categories, settings: State.settings };
    await DB.put('snapshots', snap);
    const all = await DB.getAll('snapshots');
    if(all.length > MAX_SNAPSHOTS){
      all.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
      const toRemove = all.slice(0, all.length - MAX_SNAPSHOTS);
      for(const s of toRemove) await DB.del('snapshots', s.id);
    }
  }catch(e){ /* snapshot failure should not block import */ }
}

async function applyImport(){
  if(!pendingImport) return;
  await createSafetySnapshot();

  // merge categories (by name, case-insensitive), keep existing ids when name matches
  const nameToExisting = new Map(State.categories.map(c=>[c.name.toLowerCase(), c]));
  const idRemap = {};
  pendingImport.categories.forEach(c => {
    if(c.id === UNCATEGORIZED_ID){ idRemap[c.id] = UNCATEGORIZED_ID; return; }
    const existing = nameToExisting.get(c.name.toLowerCase());
    if(existing){ idRemap[c.id] = existing.id; }
    else {
      const newCat = {id: c.id && !State.categories.find(x=>x.id===c.id) ? c.id : 'c_'+uid(), name:c.name, system:false, createdAt:c.createdAt};
      State.categories.push(newCat);
      nameToExisting.set(newCat.name.toLowerCase(), newCat);
      idRemap[c.id] = newCat.id;
    }
  });

  const existingUrlKeys = new Set(State.tools.map(t=>normalizeForDupCheck(t.url)));
  const toAdd = [];
  pendingImport.tools.forEach(t => {
    const key = normalizeForDupCheck(t.url);
    if(existingUrlKeys.has(key)) return; // skip duplicates, preserve existing
    const newId = State.tools.find(x=>x.id===t.id) ? uid() : t.id;
    const mapped = {...t, id:newId, categoryId: idRemap[t.categoryId] || UNCATEGORIZED_ID};
    toAdd.push(mapped);
    existingUrlKeys.add(key);
  });

  State.tools = State.tools.concat(toAdd);

  try{
    await DB.bulkPut('categories', State.categories);
    if(toAdd.length) await DB.bulkPut('tools', toAdd);
    toast(`Import complete — ${toAdd.length} tool${toAdd.length===1?'':'s'} added`);
  }catch(e){
    toast('Import partially failed — storage error', 'error');
  }
  pendingImport = null;
  document.getElementById('import-overlay').classList.remove('open');
  render();
  renderSettingsPanel('backup');
}

/* ============================================================
   17. RESET APP
   ============================================================ */
async function resetApp(){
  try{
    await DB.clearStore('tools');
    await DB.clearStore('categories');
    await DB.clearStore('settings');
    await DB.clearStore('snapshots');
  }catch(e){ toast('Reset encountered a storage error', 'error'); }
  State.tools = [];
  State.categories = [{id:UNCATEGORIZED_ID, name:'Uncategorized', system:true, createdAt: nowISO()}];
  State.settings = {theme:'dark', view:'grid', sort:'recent', lastBackupAt:null, landing:'auto', clickSound:'click'};
  State.ui.activeNav = 'all';
  applyTheme();
  await persistSettings();
  document.getElementById('reset-overlay').classList.remove('open');
  document.getElementById('settings-overlay').classList.remove('open');
  toast('Toolify has been reset');
  render();
}

/* ============================================================
   18. THEME
   ============================================================ */
function applyTheme(){
  let mode = State.settings.theme;
  if(mode === 'system'){
    mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', mode);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
  if(State.settings.theme === 'system') applyTheme();
});

/* ============================================================
   19. SETTINGS PANEL RENDERING
   ============================================================ */
const SHORTCUTS = [
  { keys: '/', action: 'Focus the search bar' },
  { keys: 'Esc', action: 'Close open dialog or clear search' },
  { keys: 'N', action: 'Add a new tool' },
  { keys: ',', action: 'Open Settings' },
  { keys: '?', action: 'Open Settings → General (shortcuts)' },
  { keys: 'F', action: 'Go to Favorites' },
  { keys: 'A', action: 'Go to All Tools' }
];

let currentSettingsPanel = 'general';

function daysSince(iso){
  if(!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  return Math.floor(diff / 86400000);
}

function renderSettingsPanel(panelName){
  currentSettingsPanel = panelName;
  document.querySelectorAll('.settings-nav-item').forEach(b=>b.classList.toggle('active', b.dataset.panel===panelName));
  const panel = document.getElementById('settings-panel');

  if(panelName === 'account'){
    const email = currentUser?.email || 'Not signed in';
    panel.innerHTML = `
      <h3>Accounts</h3>
      <div class="panel-sub">Manage the email address and password connected to your Toolify account.</div>
      <div class="settings-block">
        <div class="settings-row">
          <div><div class="settings-row-label">Current email</div><div class="settings-row-desc">${escapeHTML(email)}</div></div>
          <span class="tool-badge"><span class="dot"></span>Signed in</span>
        </div>
        <div class="backup-card" style="margin-top:12px;">
          <h4>Change email address</h4>
          <p>Supabase will send a confirmation link to verify the new email address. Your account data will stay attached to this account.</p>
          <div class="field"><label class="field-label" for="account-new-email">New email address</label><input class="field-input" id="account-new-email" type="email" autocomplete="email" placeholder="new@example.com"></div>
          <button class="btn btn-solid" id="account-change-email">Send verification email</button>
        </div>
      </div>
      <div class="settings-block">
        <div class="backup-card">
          <h4>Change password</h4>
          <p>Enter your current password first, then choose a new one (at least 6 characters).</p>
          <div class="field"><label class="field-label" for="account-current-password">Current password</label><input class="field-input" id="account-current-password" type="password" autocomplete="current-password" placeholder="Current password"></div>
          <div class="field"><label class="field-label" for="account-new-password">New password</label><input class="field-input" id="account-new-password" type="password" autocomplete="new-password" minlength="6" placeholder="At least 6 characters"></div>
          <div class="field"><label class="field-label" for="account-confirm-password">Confirm new password</label><input class="field-input" id="account-confirm-password" type="password" autocomplete="new-password" minlength="6" placeholder="Repeat new password"></div>
          <button class="btn btn-solid" id="account-change-password">Update password</button>
        </div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Sign out</div><div class="settings-row-desc">Sign out of Toolify on this browser.</div></div>
        <button class="btn btn-danger" id="account-panel-signout">Sign out</button>
      </div>
    `;
    document.getElementById('account-change-email').addEventListener('click', async ()=>{
      const nextEmail = document.getElementById('account-new-email').value.trim();
      if(!nextEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)){toast('Enter a valid email address.','error');return;}
      const btn = document.getElementById('account-change-email'); btn.disabled = true; btn.textContent = 'Sending…';
      try{
        const {error} = await supabaseClient.auth.updateUser({email:nextEmail},{emailRedirectTo:window.location.origin+window.location.pathname});
        if(error) throw error;
        toast('Verification email sent. Confirm the new address to finish the change.');
        document.getElementById('account-new-email').value = '';
      }catch(err){toast(err.message || 'Could not update email.','error');}
      finally{btn.disabled=false;btn.textContent='Send verification email';}
    });
    document.getElementById('account-change-password').addEventListener('click', async ()=>{
      const oldPass = document.getElementById('account-current-password').value;
      const nextPass = document.getElementById('account-new-password').value;
      const confirmPass = document.getElementById('account-confirm-password').value;
      if(!oldPass || !nextPass){toast('Complete all password fields.','error');return;}
      if(nextPass.length < 6){toast('New password must be at least 6 characters.','error');return;}
      if(nextPass !== confirmPass){toast('New passwords do not match.','error');return;}
      if(nextPass === oldPass){toast('Choose a password different from your current one.','error');return;}
      const btn = document.getElementById('account-change-password'); btn.disabled=true; btn.textContent='Updating…';
      try{
        const {error:verifyError} = await supabaseClient.auth.signInWithPassword({email:currentUser.email,password:oldPass});
        if(verifyError) throw new Error('Current password is incorrect.');
        const {error} = await supabaseClient.auth.updateUser({password:nextPass});
        if(error) throw error;
        document.getElementById('account-current-password').value='';
        document.getElementById('account-new-password').value='';
        document.getElementById('account-confirm-password').value='';
        toast('Password updated successfully.');
      }catch(err){toast(err.message || 'Could not update password.','error');}
      finally{btn.disabled=false;btn.textContent='Update password';}
    });
    document.getElementById('account-panel-signout').addEventListener('click', () => signOut());
  }

  if(panelName === 'general'){
    panel.innerHTML = `
      <h3>General</h3>
      <div class="panel-sub">Basic preferences for how Toolify behaves.</div>
      <div class="settings-row">
        <div><div class="settings-row-label">Default landing view</div><div class="settings-row-desc">Favorites is shown automatically when you have at least one favorite.</div></div>
        <div style="font-size:12.5px; color:var(--text-tertiary);">Automatic</div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Backup reminders</div><div class="settings-row-desc">Get a gentle nudge to export a backup periodically.</div></div>
        <div style="font-size:12.5px; color:var(--text-tertiary);">Enabled</div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Click sound</div><div class="settings-row-desc">Play a sound when opening a tool. Choose a sound or turn it off.</div></div>
        <select class="field-select" id="click-sound-select" style="width:auto; min-width:120px;">
          <option value="off">Off</option>
          <option value="click">Click</option>
          <option value="pop">Pop</option>
          <option value="ding">Ding</option>
        </select>
      </div>
      <div class="settings-block" style="margin-top:14px;">
        <div class="settings-row-label">Keyboard shortcuts</div>
        <div class="panel-sub" style="margin-bottom:8px;">Shortcuts that work anywhere in the app. Press the key to trigger the action.</div>
        <div class="shortcut-list">
          ${SHORTCUTS.map(s=>`<div class="shortcut-row"><kbd>${escapeHTML(s.keys)}</kbd><span>${escapeHTML(s.action)}</span></div>`).join('')}
        </div>
      </div>
    `;
    const soundSel = document.getElementById('click-sound-select');
    if(soundSel){
      soundSel.value = State.settings.clickSound || 'off';
      soundSel.addEventListener('change', async ()=>{
        State.settings.clickSound = soundSel.value;
        await persistSettings();
        if(soundSel.value !== 'off') playClickSound();
      });
    }
  }

  else if(panelName === 'tools'){
    panel.innerHTML = `
      <h3>Manage Tools</h3>
      <div class="panel-sub">Edit or delete tools in your library.</div>
      <div class="manage-search">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" style="left:11px; top:9px;"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input class="field-input" id="manage-search-input" style="padding-left:32px;" placeholder="Search your tools…">
      </div>
      <div class="manage-list" id="manage-tools-list"></div>
    `;
    renderManageToolsList('');
    document.getElementById('manage-search-input').addEventListener('input', (e)=>renderManageToolsList(e.target.value));
  }

  else if(panelName === 'sidebar'){
    const tools = quickToolsList();
    panel.innerHTML = `
      <h3>Sidebar</h3>
      <div class="panel-sub">Add, reorder-free, or remove shortcuts shown in the right-side toolbar. Changes sync with your Toolify account.</div>
      <div class="sidebar-tool-list">
        ${tools.map(tool=>`
          <div class="sidebar-tool-row" data-sidebar-tool="${escapeHTML(tool.id)}">
            <img src="${escapeHTML(faviconURL(tool.url))}" alt="">
            <div class="sidebar-tool-info">
              <div class="sidebar-tool-name">${escapeHTML(tool.name)}</div>
              <div class="sidebar-tool-url">${escapeHTML(tool.url)}</div>
            </div>
            <button class="icon-btn danger" data-remove-sidebar-tool="${escapeHTML(tool.id)}" aria-label="Remove ${escapeHTML(tool.name)}">
              <svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </button>
          </div>
        `).join('')}
      </div>
      <div class="sidebar-tool-form">
        <div class="sidebar-tool-form-title">Add shortcut</div>
        <div class="sidebar-tool-fields">
          <input class="field-input" id="sidebar-tool-name" maxlength="40" placeholder="Tool name">
          <input class="field-input" id="sidebar-tool-url" maxlength="500" placeholder="example.com">
        </div>
        <button class="btn btn-solid" id="sidebar-tool-add">Add Shortcut</button>
      </div>
    `;
    panel.querySelectorAll('[data-remove-sidebar-tool]').forEach(button=>{
      button.addEventListener('click', async ()=>{
        State.settings.quickTools = quickToolsList().filter(tool=>tool.id !== button.dataset.removeSidebarTool);
        await persistSettings();
        renderQuickTools();
        renderSettingsPanel('sidebar');
      });
    });
    document.getElementById('sidebar-tool-add').addEventListener('click', async ()=>{
      const nameInput = document.getElementById('sidebar-tool-name');
      const urlInput = document.getElementById('sidebar-tool-url');
      const name = nameInput.value.trim();
      const url = normalizeURL(urlInput.value);
      if(!name){ toast('Enter a shortcut name.', 'error'); nameInput.focus(); return; }
      if(!url){ toast('Enter a valid web address.', 'error'); urlInput.focus(); return; }
      State.settings.quickTools = quickToolsList();
      State.settings.quickTools.push({id:uid(), name, url});
      await persistSettings();
      renderQuickTools();
      renderSettingsPanel('sidebar');
      toast('Sidebar shortcut added.');
    });
  }

  else if(panelName === 'categories'){
    const userCats = State.categories.filter(c=>c.id!==UNCATEGORIZED_ID).sort((a,b)=>a.name.localeCompare(b.name));
    const uncat = State.categories.find(c=>c.id===UNCATEGORIZED_ID);
    panel.innerHTML = `
      <h3>Categories</h3>
      <div class="panel-sub">Create, rename, or delete categories. Deleting a category moves its tools to Uncategorized — nothing is ever deleted.</div>
      <div id="cat-list">
        ${userCats.map(c=>`
          <div class="cat-row" data-id="${c.id}">
            <input class="cat-name-input" value="${escapeHTML(c.name)}" data-id="${c.id}">
            <span class="cat-count">${categoryToolCount(c.id)} tool${categoryToolCount(c.id)===1?'':'s'}</span>
            <button class="icon-btn danger" data-del-cat="${c.id}" aria-label="Delete category"><svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
          </div>`).join('')}
        <div class="cat-row system">
          <span class="cat-name-input" style="cursor:default;">Uncategorized</span>
          <span class="cat-count">${categoryToolCount(UNCATEGORIZED_ID)} tools · system</span>
        </div>
      </div>
      <div class="new-cat-row">
        <input class="field-input" id="new-cat-input" placeholder="New category name" maxlength="40">
        <button class="btn btn-solid" id="new-cat-btn">Create</button>
      </div>
    `;
    panel.querySelectorAll('.cat-name-input[data-id]').forEach(inp=>{
      inp.addEventListener('change', ()=>renameCategory(inp.dataset.id, inp.value));
    });
    panel.querySelectorAll('[data-del-cat]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.dataset.delCat;
        const c = State.categories.find(x=>x.id===id);
        pendingDeleteId = null;
        document.getElementById('confirm-title').textContent = 'Delete this category?';
        document.getElementById('confirm-msg').textContent = `“${c.name}” will be deleted. Its tools will move to Uncategorized — they will not be removed.`;
        document.getElementById('confirm-overlay').classList.add('open');
        document.getElementById('confirm-ok').onclick = async ()=>{
          await deleteCategory(id);
          closeConfirm();
          document.getElementById('confirm-ok').onclick = doDeleteTool;
        };
      });
    });
    document.getElementById('new-cat-btn').addEventListener('click', async ()=>{
      const inp = document.getElementById('new-cat-input');
      await createCategory(inp.value);
      inp.value = '';
      renderSettingsPanel('categories');
    });
    document.getElementById('new-cat-input').addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){ document.getElementById('new-cat-btn').click(); }
    });
  }

  else if(panelName === 'backup'){
    const d = daysSince(State.settings.lastBackupAt);
    panel.innerHTML = `
      <h3>Backup &amp; Restore</h3>
      <div class="panel-sub">Your data lives in this browser's local storage. Exporting a backup file is the strongest protection against data loss.</div>
      <div class="reminder-pill" style="margin-bottom:18px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        ${State.settings.lastBackupAt ? `Last backup: ${d===0?'today':d+' day'+(d===1?'':'s')+' ago'}` : 'No backup created yet'}
      </div>
      <div class="backup-card">
        <h4>Export Backup</h4>
        <p>Download a portable JSON file containing all your tools, categories and preferences.</p>
        <button class="btn btn-solid" id="btn-export-backup">Create Backup Now</button>
      </div>
      <div class="backup-card">
        <h4>Import / Restore</h4>
        <p>Select a Toolify backup file. Your current library is protected — the import merges new items in and never deletes existing data.</p>
        <button class="btn btn-ghost" id="btn-import-backup">Choose Backup File…</button>
      </div>
    `;
    document.getElementById('btn-export-backup').addEventListener('click', exportBackup);
    document.getElementById('btn-import-backup').addEventListener('click', ()=>document.getElementById('import-file-input').click());
  }

  else if(panelName === 'appearance'){
    panel.innerHTML = `
      <h3>Appearance</h3>
      <div class="panel-sub">Choose how Toolify looks.</div>
      <div class="settings-row">
        <div><div class="settings-row-label">Theme</div><div class="settings-row-desc">System follows your OS preference.</div></div>
        <div class="theme-picker" id="theme-picker">
          <button class="theme-opt" data-theme="dark">Dark</button>
          <button class="theme-opt" data-theme="light">Light</button>
          <button class="theme-opt" data-theme="system">System</button>
        </div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Default view</div><div class="settings-row-desc">Grid, list, or compact icon layout for your library.</div></div>
        <div class="theme-picker" id="view-picker">
          <button class="theme-opt" data-view="grid">Grid</button>
          <button class="theme-opt" data-view="list">List</button>
          <button class="theme-opt" data-view="compact">Compact</button>
        </div>
      </div>
    `;
    panel.querySelectorAll('#theme-picker .theme-opt').forEach(b=>{
      b.classList.toggle('active', b.dataset.theme === State.settings.theme);
      b.addEventListener('click', async ()=>{
        State.settings.theme = b.dataset.theme;
        applyTheme();
        await persistSettings();
        renderSettingsPanel('appearance');
      });
    });
    panel.querySelectorAll('#view-picker .theme-opt').forEach(b=>{
      b.classList.toggle('active', b.dataset.view === State.settings.view);
      b.addEventListener('click', async ()=>{
        State.settings.view = b.dataset.view;
        await persistSettings();
        render();
        renderSettingsPanel('appearance');
      });
    });
  }

  else if(panelName === 'data'){
    const fav = State.tools.filter(t=>t.favorite).length;
    panel.innerHTML = `
      <h3>Data</h3>
      <div class="panel-sub">A snapshot of what's stored locally in this browser.</div>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num">${State.tools.length}</div><div class="stat-label">Total tools</div></div>
        <div class="stat-box"><div class="stat-num">${State.categories.length-1}</div><div class="stat-label">Categories</div></div>
        <div class="stat-box"><div class="stat-num">${fav}</div><div class="stat-label">Favorites</div></div>
      </div>
      <div class="backup-card" style="border-color:rgba(226,104,92,.3);">
        <h4 style="color:var(--danger);">Reset App</h4>
        <p>Permanently remove all locally stored tools, categories, and preferences from this browser. Export a backup first if you might want this data again.</p>
        <button class="btn btn-danger" id="btn-open-reset">Reset App…</button>
      </div>
    `;
    document.getElementById('btn-open-reset').addEventListener('click', ()=>{
      document.getElementById('reset-input').value = '';
      document.getElementById('reset-ok').disabled = true;
      document.getElementById('reset-overlay').classList.add('open');
    });
  }

  else if(panelName === 'about'){
    panel.innerHTML = `
      <div class="about-block">
        <img class="about-mark" src="logo.png?v=3" alt="Toolify">
        <h4>Toolify</h4>
        <p>Your Tools. Your Workspace. Your Productivity.</p>
        <p>Toolify is a personal tool management and productivity platform designed to help you organize, manage, and access all your essential digital tools in one centralized workspace.</p>

        <div class="about-section">
          <h5>What Makes Toolify Special</h5>
          <p>Toolify is built around simplicity, organization, accessibility, and personalization.</p>
          <ul class="about-list">
            <li><strong>Personal Tool Library</strong> — Save and manage all your frequently used tools in one place.</li>
            <li><strong>Smart Categorization</strong> — Organize your tools into custom categories for a cleaner, structured workspace.</li>
            <li><strong>Cloud Synchronization</strong> — Keep your tools, categories, and settings synchronized across devices.</li>
            <li><strong>Personal Accounts</strong> — Create your own account using your email address and maintain a private workspace.</li>
            <li><strong>Secure Data Management</strong> — Your personal data is protected through user-specific database access and Row Level Security (RLS).</li>
            <li><strong>Backup &amp; Recovery</strong> — Export your data, restore previous backups, and recover your personal tool library when needed.</li>
            <li><strong>Cross-Device Accessibility</strong> — Access your workspace from different devices without manually transferring your data.</li>
          </ul>
        </div>

        <div class="about-section">
          <h5>Available Features — Version 1.1.0</h5>
          <p>Toolify is currently in its initial release, introducing the foundation of a personalized tool management ecosystem.</p>
          <div>
            <span class="about-tag">Account &amp; Authentication</span>
            <span class="about-tag">Cloud Sync &amp; Database</span>
            <span class="about-tag">Tool Management</span>
            <span class="about-tag">Data Security</span>
            <span class="about-tag">Deployment &amp; Data Recovery</span>
            <span class="about-tag">Mobile-Optimized Interface</span>
          </div>
          <ul class="about-list">
            <li>User Registration, Email Verification, Email &amp; Password Login</li>
            <li>Forgot Password, Change Email, Change Password, Sign Out, Persistent Sessions</li>
            <li>Supabase Backend Integration, Secure Cloud Storage, Multi-User Accounts</li>
            <li>Private User Data, User-Specific Data Access, Cross-Device Synchronization</li>
            <li>Tools, Categories &amp; Settings Synchronization, Database Snapshots</li>
            <li>Save Personal Tools, Access Saved Tools, Custom Categories</li>
            <li>Row Level Security (RLS), User-Based Database Permissions</li>
            <li>GitHub Pages Hosting, Online Web App, Multi-Device Accessibility</li>
            <li>Manual Backup Export, Backup Import &amp; Restore, Advanced Recovery System</li>
          </ul>
        </div>

        <div class="about-section">
          <h5>The Future of Toolify</h5>
          <p>Toolify is not just a tool-saving application. It is evolving into a comprehensive personal productivity ecosystem — bringing multiple everyday utilities, productivity tools, management systems, and intelligent features together in one unified platform.</p>
          <details>
            <summary style="cursor:pointer; font-size:12.5px; color:var(--accent); margin-bottom:6px;">Show planned features roadmap</summary>
            <ul class="about-list">
              <li><strong>Productivity &amp; Organization:</strong> Smart Dashboard, Personal To-Do Manager, Daily Planner, Calendar &amp; Event Manager, Habit Tracker, Goal Tracker, Focus Timer (Pomodoro), Quick Notes, Sticky Notes</li>
              <li><strong>Knowledge &amp; Digital Management:</strong> Smart Bookmark Manager, Reading List, Watch Later Manager, Prompt Library, Secure Vault, File Manager, Document Organizer, Cloud Storage Integration</li>
              <li><strong>Planning &amp; Project Management:</strong> Mind Map Maker, Expense Tracker, Budget Planner, Project Manager, Workflow Automation, Email Organizer, Meeting Notes, Contact Manager</li>
              <li><strong>Personal Life Management:</strong> Birthday &amp; Anniversary Reminders, Shopping List, Fitness Tracker, Travel Planner, Important Dates Countdown, Expense Manager</li>
              <li><strong>Developer &amp; Utility Tools:</strong> Code Playground, Screenshot Tool, QR Code Generator, Password Generator, Quick Calculator, Currency Converter, Unit Converter, Image Compressor, Image Converter, PDF Toolkit, File Converter</li>
              <li><strong>Creative &amp; Design Tools:</strong> Color Palette Manager, Font Library, Design Inspiration Board</li>
              <li><strong>Advanced Productivity &amp; Intelligence:</strong> Social Media Planner, Content Calendar, Daily Inspiration, Global Notifications, Smart Reminders, Focus Mode, Distraction Blocker, Personal Automation Hub, AI Personal Assistant, Universal Search Across Everything</li>
            </ul>
          </details>
        </div>
        <div class="about-section">
          <h5>Our Mission</h5>
          <p>Our mission is to simplify digital life by creating one organized environment for the tools, resources, and utilities people use every day. Instead of switching between multiple platforms or trying to remember where everything is saved, Toolify aims to become your personal digital workspace — accessible, organized, and always evolving.</p>
        </div>

        <hr class="about-hr">

        <div class="about-section">
          <h5>Developer</h5>
          <p>Designed &amp; Developed by TAHA AMIN. Toolify is independently developed with a focus on building practical, user-friendly, and modern web applications.</p>
          <div class="about-links">
            <a class="about-link" href="https://github.com/tahaamindev" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a class="about-link" href="https://tahaamindev.github.io/TAHA/" target="_blank" rel="noopener noreferrer">Portfolio</a>
          </div>
        </div>

        <div class="about-meta">Version ${APP_VERSION} · Web Application · Backend: Supabase · Hosting: GitHub Pages</div>
      </div>
    `;
  }

}

function renderManageToolsList(query){
  const q = (query||'').trim().toLowerCase();
  const list = State.tools
    .filter(t => !q || t.name.toLowerCase().includes(q) || (getCategory(t.categoryId)?.name.toLowerCase().includes(q)))
    .slice().sort((a,b)=>a.name.localeCompare(b.name));
  const wrap = document.getElementById('manage-tools-list');
  if(!wrap) return;
  if(list.length === 0){
    wrap.innerHTML = `<div style="padding:20px 4px; font-size:12.5px; color:var(--text-tertiary); text-align:center;">No tools found.</div>`;
    return;
  }
  wrap.innerHTML = list.map(t=>{
    const cat = getCategory(t.categoryId);
    return `<div class="manage-row">
      <div class="tool-icon">${faviconMarkup(t)}</div>
      <div class="m-name">${escapeHTML(t.name)}</div>
      <div class="m-cat">${escapeHTML(cat?cat.name:'Uncategorized')}</div>
      <button class="icon-btn" data-edit="${t.id}" aria-label="Edit tool"><svg viewBox="0 0 24 24" fill="none"><path d="M11 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-5" stroke="currentColor" stroke-width="1.7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></button>
      <button class="icon-btn danger" data-del="${t.id}" aria-label="Delete tool"><svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click', ()=>{
    document.getElementById('settings-overlay').classList.remove('open');
    openToolModal(b.dataset.edit);
  }));
  wrap.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click', ()=>confirmDeleteTool(b.dataset.del)));
}
function refreshManagePanelIfOpen(){
  if(document.getElementById('settings-overlay').classList.contains('open') && currentSettingsPanel === 'tools'){
    renderManageToolsList(document.getElementById('manage-search-input')?.value || '');
  }
  if(document.getElementById('settings-overlay').classList.contains('open') && currentSettingsPanel === 'data'){
    renderSettingsPanel('data');
  }
}

function openSettings(panel){
  renderSettingsPanel(panel || 'general');
  document.getElementById('settings-overlay').classList.add('open');
}

/* ============================================================
   20. EVENT WIRING
   ============================================================ */
function closeMobileSidebar(){
  document.getElementById('sidebar').classList.remove('mobile-open');
}

function updateMacClock(){
  const clock = document.getElementById('mac-clock');
  if(!clock) return;
  const now = new Date();
  clock.textContent = now.toLocaleString([], {
    weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
  });
  clock.dateTime = now.toISOString();
}

function wireEvents(){
  updateMacClock();
  if(!wireEvents.clockTimer){
    wireEvents.clockTimer = window.setInterval(updateMacClock, 30000);
  }
  // Add tool
  document.getElementById('btn-add-tool-sidebar').addEventListener('click', ()=>openToolModal());
  document.getElementById('tool-modal-close').addEventListener('click', closeToolModal);
  document.getElementById('tool-cancel').addEventListener('click', closeToolModal);
  document.getElementById('tool-save').addEventListener('click', saveTool);
  document.getElementById('tool-overlay').addEventListener('click', (e)=>{ if(e.target.id==='tool-overlay') closeToolModal(); });
  ['f-name','f-url'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{ pendingDuplicateOK = false; document.getElementById('dup-warning').style.display='none'; });
  });

  // Confirm delete
  document.getElementById('confirm-close').addEventListener('click', closeConfirm);
  document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
  document.getElementById('confirm-ok').addEventListener('click', doDeleteTool);
  document.getElementById('confirm-overlay').addEventListener('click', (e)=>{ if(e.target.id==='confirm-overlay') closeConfirm(); });

  // Reset
  document.getElementById('reset-close').addEventListener('click', ()=>document.getElementById('reset-overlay').classList.remove('open'));
  document.getElementById('reset-cancel').addEventListener('click', ()=>document.getElementById('reset-overlay').classList.remove('open'));
  document.getElementById('reset-input').addEventListener('input', (e)=>{
    document.getElementById('reset-ok').disabled = e.target.value.trim() !== 'RESET';
  });
  document.getElementById('reset-ok').addEventListener('click', resetApp);

  // Import
  document.getElementById('import-close').addEventListener('click', ()=>{document.getElementById('import-overlay').classList.remove('open'); pendingImport=null;});
  document.getElementById('import-cancel').addEventListener('click', ()=>{document.getElementById('import-overlay').classList.remove('open'); pendingImport=null;});
  document.getElementById('import-confirm').addEventListener('click', applyImport);
  document.getElementById('import-file-input').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(file) handleImportFile(file);
    e.target.value = '';
  });

  // Settings
  document.getElementById('btn-open-settings')?.addEventListener('click', ()=>openSettings('general'));
  document.getElementById('mac-settings').addEventListener('click', ()=>openSettings('general'));
  document.getElementById('mac-about').addEventListener('click', showPublicAbout);
  document.getElementById('mac-contact').addEventListener('click', showPublicContact);
  document.getElementById('quick-tools-add').addEventListener('click', ()=>openSettings('sidebar'));
  document.getElementById('settings-close').addEventListener('click', ()=>document.getElementById('settings-overlay').classList.remove('open'));
  document.getElementById('settings-overlay').addEventListener('click', (e)=>{ if(e.target.id==='settings-overlay') document.getElementById('settings-overlay').classList.remove('open'); });
  document.querySelectorAll('.settings-nav-item').forEach(b=>b.addEventListener('click', ()=>renderSettingsPanel(b.dataset.panel)));

  document.getElementById('tool-context-menu').addEventListener('click', async (event)=>{
    const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
    if(!action || !contextMenuTarget) return;
    const tool = contextMenuTarget;
    const menuType = contextMenuType;
    hideToolContextMenu();
    if(action === 'open') openTool(tool);
    if(action === 'edit') openToolModal(tool.id);
    if(action === 'favorite'){ tool.favorite = !tool.favorite; await persistTool(tool); render(); toast(tool.favorite ? 'Added to Favorites.' : 'Removed from Favorites.'); }
    if(action === 'sidebar') await addLibraryToolToSidebar(tool);
    if(action === 'remove-sidebar'){
      State.settings.quickTools = quickToolsList().filter(item=>item.id !== tool.id);
      await persistSettings();
      renderQuickTools();
      toast('Removed from Sidebar.');
    }
    if(action === 'delete'){
      if(menuType === 'sidebar'){
        State.settings.quickTools = quickToolsList().filter(item=>item.id !== tool.id);
        await persistSettings();
        renderQuickTools();
        toast('Removed from Sidebar.');
      }else{
        confirmDeleteTool(tool.id);
      }
    }
  });
  document.addEventListener('click', (event)=>{
    if(!event.target.closest('#tool-context-menu')) hideToolContextMenu();
  });
  document.addEventListener('contextmenu', (event)=>{
    if(!event.target.closest('.tool-card, .quick-tool')) hideToolContextMenu();
  });

  // Search
  const searchInput = document.getElementById('mac-search-input');
  const legacySearchClear = document.getElementById('search-clear');
  const doSearch = debounce((val)=>{
    State.ui.search = val;
    legacySearchClear?.classList.toggle('show', !!val);
    renderGrid();
  }, 120);
  searchInput.addEventListener('input', (e)=>doSearch(e.target.value));
  legacySearchClear?.addEventListener('click', ()=>{
    searchInput.value=''; State.ui.search=''; legacySearchClear.classList.remove('show'); renderGrid(); searchInput.focus();
  });
  document.getElementById('mac-signout')?.addEventListener('click', ()=>signOut());

  document.getElementById('quick-note-add')?.addEventListener('click', async ()=>{
    const input = document.getElementById('quick-note-input');
    const text = input.value.trim();
    if(!text) return;
    notesList().push({id:uid(), text, createdAt:Date.now()});
    input.value='';
    await persistSettings();
    renderQuickNotes();
  });
  renderQuickNotes();

  // Sort
  const sortBtn = document.getElementById('sort-btn');
  const sortMenu = document.getElementById('sort-menu');
  sortBtn.addEventListener('click', (e)=>{ e.stopPropagation(); sortMenu.classList.toggle('open'); });
  document.addEventListener('click', ()=>sortMenu.classList.remove('open'));
  document.querySelectorAll('.sort-option').forEach(o=>{
    o.addEventListener('click', async (e)=>{
      e.stopPropagation();
      State.settings.sort = o.dataset.sort;
      await persistSettings();
      sortMenu.classList.remove('open');
      render();
    });
  });

  // View toggle
  document.querySelectorAll('.view-btn').forEach(b=>{
    b.addEventListener('click', async ()=>{
      State.settings.view = b.dataset.view;
      await persistSettings();
      render();
    });
  });

  // Sidebar collapse
  document.getElementById('btn-collapse').addEventListener('click', ()=>{
    if(window.innerWidth <= 860){ closeMobileSidebar(); return; }
    document.getElementById('sidebar').classList.toggle('collapsed');
  });
  document.getElementById('btn-mobile-menu').addEventListener('click', ()=>{
    document.getElementById('sidebar').classList.add('mobile-open');
  });

  // Swipe gestures (mobile): right swipe opens sidebar, left swipe closes
  let _swipeStartX = 0, _swipeStartY = 0;
  document.addEventListener('touchstart', (e)=>{
    if(!e.touches || e.touches.length !== 1) return;
    _swipeStartX = e.touches[0].clientX;
    _swipeStartY = e.touches[0].clientY;
  }, {passive:true});
  document.addEventListener('touchend', (e)=>{
    if(!e.changedTouches || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - _swipeStartX;
    const dy = e.changedTouches[0].clientY - _swipeStartY;
    if(Math.abs(dx) < 60 || Math.abs(dy) > 60) return;
    const sidebar = document.getElementById('sidebar');
    if(dx > 0) sidebar.classList.add('mobile-open');
    else sidebar.classList.remove('mobile-open');
  }, {passive:true});

  // Mobile: collapse topbar to search-only while scrolling down the tool list
  const contentScroll = document.querySelector('.content-scroll');
  const topbar = document.querySelector('.topbar');
  if(contentScroll && topbar){
    let lastScrollTop = 0;
    const onScroll = ()=>{
      if(window.innerWidth > 860){ topbar.classList.remove('scrolled'); return; }
      const st = contentScroll.scrollTop;
      if(st > 40 && st > lastScrollTop){
        topbar.classList.add('scrolled');
      } else if(st <= 40){
        topbar.classList.remove('scrolled');
      }
      // show again when scrolling up
      if(st < lastScrollTop){
        topbar.classList.remove('scrolled');
      }
      lastScrollTop = st <= 0 ? 0 : st;
    };
    contentScroll.addEventListener('scroll', onScroll, {passive:true});
    window.addEventListener('resize', ()=>{ if(window.innerWidth > 860) topbar.classList.remove('scrolled'); });
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e)=>{
    const target = e.target;
    const typing = !!(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable));

    // Escape always works
    if(e.key === 'Escape'){
      let closed = false;
      ['tool-overlay','confirm-overlay','reset-overlay','import-overlay','settings-overlay'].forEach(id=>{
        const el = document.getElementById(id);
        if(el && el.classList.contains('open')){ el.classList.remove('open'); closed = true; }
      });
      closeMobileSidebar();
      if(!closed){
        const si = document.getElementById('mac-search-input');
        if(si && si.value){ si.value = ''; State.ui.search = ''; document.getElementById('search-clear')?.classList.remove('show'); renderGrid(); }
        si?.blur();
      }
      return;
    }

    if(typing) return;
    const anyOpen = !!document.querySelector('.overlay.open');
    if(anyOpen) return;

    switch(e.key){
      case '/':
        e.preventDefault();
        document.getElementById('mac-search-input')?.focus();
        break;
      case 'n':
      case 'N':
        e.preventDefault();
        openToolModal();
        break;
      case ',':
        e.preventDefault();
        openSettings('general');
        break;
      case '?':
        e.preventDefault();
        openSettings('general');
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        State.ui.activeNav = 'favorites';
        State.ui.search = '';
        const siF = document.getElementById('mac-search-input'); if(siF) siF.value = '';
        document.getElementById('search-clear')?.classList.remove('show');
        closeMobileSidebar();
        render();
        break;
      case 'a':
      case 'A':
        e.preventDefault();
        State.ui.activeNav = 'all';
        State.ui.search = '';
        const siA = document.getElementById('mac-search-input'); if(siA) siA.value = '';
        document.getElementById('search-clear')?.classList.remove('show');
        closeMobileSidebar();
        render();
        break;
    }
  });

  // Favorite toggle & double-click alt path from card (long-press not needed; use small affordance via keyboard 'f' when focused)
  document.getElementById('tool-grid').addEventListener('dblclick', (e)=>{
    const card = e.target.closest('.tool-card');
    if(card) toggleFavorite(card.dataset.id);
  });
}

/* ============================================================
   21. AUTHENTICATION + INIT
   ============================================================ */
let authMode='login';
let manualSignOut=false;
let recoveryActive=false;
function authMessage(message,isError=false){const el=document.getElementById('auth-message');el.textContent=message;el.classList.toggle('error',isError);}
function setAuthMode(mode){authMode=mode;const title=document.getElementById('auth-title'),sub=document.getElementById('auth-sub'),submit=document.getElementById('auth-submit'),toggle=document.getElementById('auth-toggle'),forgot=document.getElementById('auth-forgot');const isSignup=mode==='signup';document.getElementById('auth-confirm-wrap').style.display=isSignup?'block':'none';document.getElementById('auth-password-wrap').style.display='block';document.getElementById('auth-password').required=true;document.getElementById('auth-confirm').required=isSignup;title.textContent=isSignup?'Create your account':'Welcome back';sub.textContent=isSignup?'Create an account to keep your tools synced securely.':'Sign in to access your personal cloud-synced tool library.';submit.textContent=isSignup?'Create account':'Sign in';toggle.textContent=isSignup?'Already have an account? Sign in':'New to Toolify? Sign up';forgot.style.display=isSignup?'none':'block';authMessage('');}
async function showAuthenticatedApp(user){if(currentUser && currentUser.id === user.id) return;currentUser=user;State.tools=[];State.categories=[];State.settings={theme:'dark',view:'grid',sort:'recent',lastBackupAt:null,landing:'auto',clickSound:'click',quickTools:undefined,notes:[]};libraryLoading=true;document.getElementById('auth-screen').style.display='none';document.getElementById('app').style.display='flex';document.getElementById('mac-signout').title=user.email||'Sign out';render();try{await DB.open();await initAppData();try{await DB.syncForUser(user);const [tools,categories,settingsRows]=await Promise.all([DB.getAll('tools'),DB.getAll('categories'),DB.getAll('settings')]);State.tools=tools;State.categories=categories;const saved=settingsRows.find(r=>r.key==='app');if(saved)Object.assign(State.settings,saved.value);libraryLoading=false;applyTheme();render();}catch(e){console.error('Cloud sync failed:',e);libraryLoading=false;render();toast('Offline: showing saved library','error');}}catch(e){libraryLoading=false;render();console.error(e);authMessage('Could not open your library: '+(e.message||'Please try again.'),true);document.getElementById('auth-screen').style.display='flex';document.getElementById('app').style.display='none';}}
async function initAppData(){try{const [tools,categories,settingsRows]=await Promise.all([DB.getAll('tools'),DB.getAll('categories'),DB.getAll('settings')]);State.tools=tools;State.categories=categories;const saved=settingsRows.find(r=>r.key==='app');if(saved)Object.assign(State.settings,saved.value);}catch(e){toast('Could not load saved data','error');}ensureUncategorized();const ids=new Set(State.categories.map(c=>c.id));let fixed=false;State.tools.forEach(t=>{if(!ids.has(t.categoryId)){t.categoryId=UNCATEGORIZED_ID;fixed=true;}});if(fixed)await DB.bulkPut('tools',State.tools);if(!State.categories.length)ensureUncategorized();await DB.bulkPut('categories',State.categories);applyTheme();State.ui.activeNav=State.tools.some(t=>t.favorite)?'favorites':'all';wireEvents();render();}
async function init(){
  if(!supabaseClient){
    document.getElementById('auth-screen').style.display='flex';
    authMessage('Could not load sign-in services. Check your connection and refresh.',true);
    return;
  }
  try{
    await DB.open();
  }catch(error){
    console.error('Could not open local database:',error);
    document.getElementById('auth-screen').style.display='flex';
    authMessage('Local storage is unavailable. Enable site storage and refresh.',true);
    return;
  }
  const recoveryUrl = new URL(window.location.href);
  const hashParams = new URLSearchParams(recoveryUrl.hash.replace(/^#/, ''));
  const recoveryType = recoveryUrl.searchParams.get('type') === 'recovery' ||
    hashParams.get('type') === 'recovery';
  const authCallbackPending = recoveryUrl.searchParams.has('code') ||
    recoveryUrl.searchParams.has('error_code') ||
    hashParams.has('access_token') ||
    hashParams.has('code') ||
    hashParams.has('error_code');
  let authUrlProcessing = authCallbackPending;
  recoveryActive = recoveryType;
  supabaseClient.auth.onAuthStateChange(async(event,session)=>{
    if(event==='TOKEN_REFRESH_FAILED'){await supabaseClient.auth.refreshSession().catch(()=>{});return;}
    if(event==='PASSWORD_RECOVERY'){
      recoveryActive=true;
      authUrlProcessing=false;
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='flex';
      document.getElementById('password-reset-overlay').classList.add('open');
      document.getElementById('password-reset-new').focus();
      return;
    }
    if(recoveryActive || authUrlProcessing) return;
    if(event==='SIGNED_IN'||event==='INITIAL_SESSION'||event==='TOKEN_REFRESHED'){if(session?.user&&!currentUser){await showAuthenticatedApp(session.user);}return;}
    if(event==='SIGNED_OUT'){
      manualSignOut=false;
      if(currentUser){currentUser=null;await DB.clearLocal();}
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='flex';
      setAuthMode('login');
      return;
    }
    if(session?.user&&!currentUser){await showAuthenticatedApp(session.user);}
  });
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(authUrlProcessing){
    window.setTimeout(()=>{
      authUrlProcessing=false;
      if(!recoveryActive){
        supabaseClient.auth.getSession().then(({data:{session:currentSession}})=>{
          if(currentSession?.user&&!currentUser) showAuthenticatedApp(currentSession.user);
        }).catch(()=>{});
      }
    },1500);
  }
  if(session?.user){
    if(recoveryType){
      recoveryActive=true;
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='flex';
      document.getElementById('password-reset-overlay').classList.add('open');
      document.getElementById('password-reset-new').focus();
    }else{
      await showAuthenticatedApp(session.user);
    }
  }else if(!authUrlProcessing){
    document.getElementById('auth-screen').style.display='flex';
    document.getElementById('app').style.display='none';
  }
}
document.getElementById('auth-form').addEventListener('submit',async e=>{
  e.preventDefault();const email=document.getElementById('auth-email').value.trim();const password=document.getElementById('auth-password').value;const submit=document.getElementById('auth-submit');submit.disabled=true;authMessage('Please wait…');
  try{
    if(authMode==='signup'){
      if(password!==document.getElementById('auth-confirm').value)throw new Error('Passwords do not match.');
      const {data,error}=await supabaseClient.auth.signUp({email,password,options:{emailRedirectTo:window.location.origin+window.location.pathname}});if(error)throw error;
      authMessage(data.session?'Account created. Loading your library…':'Account created. Check your email and verify your address before signing in.');
      if(data.session)await showAuthenticatedApp(data.user);
    }else{
      const {data,error}=await supabaseClient.auth.signInWithPassword({email,password});if(error)throw error;await showAuthenticatedApp(data.user);
    }
  }catch(err){authMessage(err.message||'Authentication failed.',true);}finally{submit.disabled=false;}
});
document.getElementById('auth-toggle').addEventListener('click',()=>setAuthMode(authMode==='signup'?'login':'signup'));
document.getElementById('auth-forgot').addEventListener('click',async()=>{
  const email=document.getElementById('auth-email').value.trim();
  if(!email){authMessage('Enter your email address first.',true);document.getElementById('auth-email').focus();return;}
  const button=document.getElementById('auth-forgot');button.disabled=true;
  try{
    const {error}=await supabaseClient.auth.resetPasswordForEmail(email,{
      redirectTo:window.location.origin+window.location.pathname+'?type=recovery'
    });
    if(error)throw error;
    authMessage('Password reset link sent. Check your email.');
  }catch(err){authMessage(err.message||'Could not send the reset link.',true);}
  finally{button.disabled=false;}
});

async function signOut(){
  manualSignOut=true;
  const {error}=await supabaseClient.auth.signOut({scope:'global'});
  currentUser=null;
  await DB.clearLocal();
  document.getElementById('app').style.display='none';
  document.getElementById('auth-screen').style.display='flex';
  setAuthMode('login');
  if(error){
    manualSignOut=false;
    console.error('Sign out error:',error);
    authMessage('Signed out locally. '+(error.message||''),true);
  }
}

function closePasswordReset(){
  document.getElementById('password-reset-overlay').classList.remove('open');
  document.getElementById('password-reset-new').value='';
  document.getElementById('password-reset-confirm').value='';
  document.getElementById('password-reset-error').textContent='';
  if(recoveryActive){
    recoveryActive=false;
    history.replaceState({},document.title,window.location.pathname);
    supabaseClient.auth.signOut({scope:'global'}).catch(()=>{});
  }
}
document.getElementById('password-reset-close').addEventListener('click',closePasswordReset);
document.getElementById('password-reset-cancel').addEventListener('click',closePasswordReset);
document.getElementById('password-reset-save').addEventListener('click',async()=>{
  const password=document.getElementById('password-reset-new').value;
  const confirm=document.getElementById('password-reset-confirm').value;
  const error=document.getElementById('password-reset-error');
  if(password.length<6){error.textContent='Password must be at least 6 characters.';return;}
  if(password!==confirm){error.textContent='Passwords do not match.';return;}
  const button=document.getElementById('password-reset-save');button.disabled=true;error.textContent='';
  try{
    const {error:updateError}=await supabaseClient.auth.updateUser({password});
    if(updateError)throw updateError;
    closePasswordReset();
    await signOut();
    recoveryActive=false;
    authMessage('Password updated successfully. Please sign in.');
  }catch(err){error.textContent=err.message||'Could not update password.';}
  finally{button.disabled=false;}
});
const authPage = document.getElementById('auth-screen');
const publicPage = document.getElementById('public-page');
const publicPageContent = document.getElementById('public-page-content');

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.querySelectorAll('[data-download-app]').forEach(button => button.textContent = 'Install Toolify');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.querySelectorAll('[data-download-app]').forEach(button => button.textContent = 'Toolify Installed');
  const platformLabel = document.getElementById('auth-platform-label');
  if(platformLabel) platformLabel.textContent = 'Installed successfully';
});

async function downloadToolify() {
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    return;
  }

  if(window.matchMedia('(display-mode: standalone)').matches || navigator.standalone){
    toast('Toolify is already installed.');
    return;
  }

  const isChrome = /Chrome|Chromium|EdgA|Edg/i.test(navigator.userAgent) && !/OPR|Opera/i.test(navigator.userAgent);
  if(isChrome){
    toast('Open Chrome menu and select "Install Toolify" or "Add to Home screen".');
  }else{
    toast('Open Toolify in Chrome to install the app.');
  }
}

function showPublicAbout() {
  publicPageContent.innerHTML = `
    <div class="about-block">
      <img class="about-mark" src="logo.png?v=3" alt="Toolify">
      <h1>About Toolify</h1>
      <h4>Your Tools. Your Workspace. Your Productivity.</h4>
      <p>Toolify is a personal tool management and productivity platform that brings your essential digital tools into one organized workspace.</p>
      <div class="about-section">
        <h5>What Makes Toolify Special</h5>
        <ul class="about-list">
          <li><strong>Personal Tool Library</strong> — Save and organize frequently used tools.</li>
          <li><strong>Smart Categories</strong> — Keep your workspace clean and structured.</li>
          <li><strong>Cloud Sync</strong> — Access your tools across your devices.</li>
          <li><strong>Private Accounts</strong> — Keep your workspace secure and personal.</li>
          <li><strong>Backup &amp; Recovery</strong> — Export and restore your library whenever needed.</li>
        </ul>
      </div>
      <div class="about-section">
        <h5>Developer</h5>
        <p>Designed and developed by <strong>TAHA AMIN</strong>, with a focus on practical, accessible, and modern productivity software.</p>
        <div class="about-links">
          <a class="about-link" href="https://github.com/tahaamindev" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a class="about-link" href="https://tahaamindev.github.io/TAHA/" target="_blank" rel="noopener noreferrer">Portfolio</a>
        </div>
      </div>
      <div class="about-section">
        <h5>Contact</h5>
        <p><a class="about-link" href="mailto:tahaamin.dev@gmail.com">tahaamin.dev@gmail.com</a></p>
      </div>
      <div class="about-meta">Version ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : '1.1.0'} · Web Application · Backend: Supabase · Hosting: GitHub Pages</div>
    </div>`;
  authPage.setAttribute('aria-hidden', 'true');
  publicPage.classList.add('open');
  publicPage.setAttribute('aria-hidden', 'false');
  publicPage.scrollTop = 0;
}

function closePublicPage() {
  publicPage.classList.remove('open');
  publicPage.setAttribute('aria-hidden', 'true');
  const appVisible = document.getElementById('app').style.display !== 'none';
  authPage.setAttribute('aria-hidden', appVisible ? 'true' : 'false');
}

function showPublicContact() {
  publicPageContent.innerHTML = `
    <div class="contact-page">
      <div class="contact-heading">
        <span class="auth-kicker">Get in touch</span>
        <h1>Contact Taha Amin.</h1>
      </div>
      <div class="contact-info-card contact-info-only">
        <h2>Direct contact</h2>
        <div class="contact-actions">
          <a class="primary" href="tel:+923255581504">+92325 5581504</a>
          <a href="https://tahaamindev.github.io/TAHA/" target="_blank" rel="noopener noreferrer">Portfolio</a>
          <a href="https://github.com/tahaamindev" target="_blank" rel="noopener noreferrer">GitHub Profile</a>
        </div>
      </div>
    </div>`;
  authPage.setAttribute('aria-hidden', 'true');
  publicPage.classList.add('open');
  publicPage.setAttribute('aria-hidden', 'false');
  publicPage.scrollTop = 0;
}

document.querySelectorAll('[data-public-page="about"]').forEach(button => button.addEventListener('click', showPublicAbout));
document.querySelectorAll('[data-public-page="contact"]').forEach(button => button.addEventListener('click', showPublicContact));
document.querySelectorAll('[data-close-public-page]').forEach(button => button.addEventListener('click', closePublicPage));
document.querySelectorAll('[data-download-app]').forEach(button => button.addEventListener('click', downloadToolify));

const authPlatformLabel = document.getElementById('auth-platform-label');
if(authPlatformLabel) authPlatformLabel.textContent = 'Install with Chrome';

document.querySelectorAll('.password-toggle').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const input = document.getElementById(btn.dataset.target);
    if(!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.innerHTML = show
      ? '<svg viewBox="0 0 24 24" fill="none"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A10.5 10.5 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.4M6.2 6.2C3.6 8.1 2 12 2 12s3.5 7 10 7c1.3 0 2.5-.2 3.6-.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/></svg>';
  });
});

// Service Worker registration (offline + auto-update)
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').then((reg)=>{
    reg.update();
    reg.addEventListener('updatefound',()=>{
      const newWorker=reg.installing;
      if(!newWorker)return;
      newWorker.addEventListener('statechange',()=>{
        if(newWorker.state==='installed'&&navigator.serviceWorker.controller){
          // New version available — prompt reload on next load
          console.log('New Toolify version available. Refresh to update.');
        }
      });
    });
  }).catch((err)=>console.log('SW registration failed:',err));
}

init().catch(error=>{
  console.error('Toolify startup failed:',error);
  document.getElementById('auth-screen').style.display='flex';
  authMessage(error?.message || 'Could not start Toolify.',true);
});

})();
