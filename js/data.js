/* ============================================================
   TOOLIFY — Backup, import/restore & reset
   Split from the original app.js (behaviour preserved).
   ============================================================ */

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
    await DB.clearStore('books');
    await DB.clearStore('bookPages');
    await DB.clearMusicFiles();
  }catch(e){ toast('Reset encountered a storage error', 'error'); }
  try{
    localStorage.removeItem(musicStorageKey('youtube-api-key'));
    localStorage.removeItem(musicStorageKey('snapshots'));
  }catch(error){
    console.error('Could not clear local music data during reset:',error);
    toast('Music player backup data could not be cleared.', 'error');
  }
  State.tools = [];
  State.categories = [{id:UNCATEGORIZED_ID, name:'Uncategorized', system:true, createdAt: nowISO()}];
  State.settings = {theme:'dark', view:'grid', sort:'recent', lastBackupAt:null, landing:'auto', clickSound:'click', clockTheme:'emerald'};
  State.ui.activeNav = 'all';
  applyTheme();
  await persistSettings();
  document.getElementById('reset-overlay').classList.remove('open');
  document.getElementById('settings-overlay').classList.remove('open');
  toast('Toolify has been reset');
  render();
}

function setPendingImport(v){ pendingImport = v; }
