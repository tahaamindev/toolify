/* ============================================================
   TOOLIFY — Tool library rendering & CRUD
   Split from the original app.js (behaviour preserved).
   ============================================================ */

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
  return `<img src="${escapeHTML(src)}" alt="" loading="lazy" decoding="async" onerror="this.parentElement.innerHTML='<div class=&quot;tool-icon-fallback&quot;>${escapeHTML(initial)}</div>'">`;
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
    const description = (tool.description||'').trim() || (cat ? cat.name : 'Uncategorized');
    const favSvg = tool.favorite ? '<span class="fav-indicator" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.3l-5.4 3.2 1.4-6.1L3 10l6.2-.5L12 3.7l2.8 5.8 6.2.5-4.9 4.4 1.4 6.1z"/></svg></span>' : '';
    const icon = `<div class="tool-icon">${faviconMarkup(tool)}</div>`;

    if(State.settings.view === 'list'){
      return `<div class="tool-card list-card" data-id="${tool.id}" tabindex="0" role="button" aria-label="Open ${escapeHTML(tool.name)}">
        ${icon}
        <div class="list-info">
          <div class="list-name">${escapeHTML(tool.name)}</div>
          <div class="list-desc">${escapeHTML(description)}</div>
        </div>
        <span class="tool-badge"><span class="dot"></span>${escapeHTML(cat?cat.name:'Uncategorized')}</span>
        ${favSvg}
        <div class="list-cta" aria-hidden="true">
          <span>Open</span><strong>${escapeHTML(tool.name)}</strong>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>
      </div>`;
    }

    if(State.settings.view === 'compact'){
      return `<div class="tool-card compact-card" data-id="${tool.id}" tabindex="0" role="button" aria-label="Open ${escapeHTML(tool.name)}">
        ${icon}
        ${favSvg}
        <div class="label-box">
          <span class="glow-line" aria-hidden="true"></span>
          <span class="display-name">${escapeHTML(tool.name)}</span>
        </div>
      </div>`;
    }

    return `<div class="tool-card grid-card" data-id="${tool.id}" tabindex="0" role="button" aria-label="Open ${escapeHTML(tool.name)}">
      ${icon}
      <div class="grid-info">
        <div class="grid-name">${escapeHTML(tool.name)}</div>
        <div class="grid-desc">${escapeHTML(description)}</div>
      </div>
      ${favSvg}
    </div>`;
  }).join('');

  grid.querySelectorAll('.tool-card').forEach(card => {
    const id = card.dataset.id;
    const tool = State.tools.find(t=>t.id===id);
    card.addEventListener('click', ()=> openTool(tool));
    card.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openTool(tool); } });
  });
}

let contextMenuTarget = null;

function showToolContextMenu(x, y, tool){
  const menu = document.getElementById('tool-context-menu');
  if(!menu || !tool) return;
  contextMenuTarget = tool;
  const label = menu.querySelector('[data-context-action="favorite"]');
  label.textContent = tool.favorite ? 'Remove from Favorites' : 'Add to Favorites';
  menu.classList.remove('open');
  void menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 210))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 210))}px`;
  menu.classList.add('open');
  menu.setAttribute('aria-hidden', 'false');
}

function hideToolContextMenu(){
  const menu = document.getElementById('tool-context-menu');
  menu?.classList.remove('open');
  menu?.setAttribute('aria-hidden', 'true');
  contextMenuTarget = null;
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
  renderQuickNotes();
  renderQuickTasks();
  renderWorkspaceOverview();
  syncMusicState();
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
  render();
  persistTool(t).catch(()=>toast('Could not save favorite state', 'error'));
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
  const originalTools = affected.map(t=>({...t}));
  const movedTools = affected.map(t=>({...t, categoryId:UNCATEGORIZED_ID, updatedAt:nowISO()}));
  try{
    // Tools must stop referencing the category before the cloud row is deleted.
    await DB.removeCategory(id, movedTools);
    affected.forEach(t => { t.categoryId = UNCATEGORIZED_ID; t.updatedAt = nowISO(); });
    State.categories = State.categories.filter(x=>x.id!==id);
    toast(`Category deleted - ${affected.length} tool${affected.length===1?'':'s'} moved to Uncategorized`);
  }catch(e){
    // Put the tools back if Supabase refused the delete.
    if(originalTools.length) await DB.bulkPut('tools', originalTools).catch(()=>{});
    toast('Could not delete category - cloud storage error', 'error');
  }
  render();
  renderSettingsPanel('categories');
}

function setPendingDeleteId(v){ pendingDeleteId = v; }
function setPendingDuplicateOK(v){ pendingDuplicateOK = v; }
