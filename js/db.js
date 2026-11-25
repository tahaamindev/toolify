/* ============================================================
   TOOLIFY — Data layer — IndexedDB cache + Supabase sync
   Local writes are instant. Cloud writes are queued and flushed
   in the background so the UI never waits on the network.
   ============================================================ */

{ supabaseClient };
let currentUser = null;
let cloudSyncBusy = false;
let libraryLoading = false;

const DB = (function(){
  let dbInstance = null;
  const tableFor = {
    tools:'tools', categories:'categories', settings:'settings',
    snapshots:'snapshots', books:'books'
  };

  /* Cloud writes are coalesced and retried. Local edits made while the
     startup sync is running are replayed after the remote snapshot lands. */
  const cloudWriteQueue = [];
  const pendingLocalChanges = [];
  let cloudFlushing = false;
  let changeSeq = 0;
  let lastCloudWarning = 0;

  function open(){
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        for(const [name,key] of [
          ['tools','id'], ['categories','id'], ['settings','key'], ['snapshots','id'],
          ['musicFiles','id'], ['books','id'], ['bookPages','id']
        ]){
          if(!db.objectStoreNames.contains(name)) db.createObjectStore(name,{keyPath:key});
        }
      };
      req.onsuccess = e => {
        dbInstance = e.target.result;
        dbInstance.onversionchange = () => dbInstance.close();
        resolve(dbInstance);
      };
      req.onerror = e => reject(req.error);
    });
  }

  function tx(name, mode){ return dbInstance.transaction(name, mode).objectStore(name); }
  function localGetAll(name){
    return new Promise((resolve,reject)=>{
      try{
        const request = tx(name,'readonly').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }catch(error){ reject(error); }
    });
  }
  function localPut(name, value){
    return new Promise((resolve,reject)=>{
      try{
        const request = tx(name,'readwrite').put(value);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
      }catch(error){ reject(error); }
    });
  }
  function localGet(name,key){
    return new Promise((resolve,reject)=>{
      try{
        const request = tx(name,'readonly').get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      }catch(error){ reject(error); }
    });
  }
  function localBulkPut(name, values){
    if(!values.length) return Promise.resolve(true);
    return new Promise((resolve,reject)=>{
      try{
        const store = tx(name,'readwrite');
        values.forEach(value => store.put(value));
        store.transaction.oncomplete = () => resolve(true);
        store.transaction.onerror = () => reject(store.transaction.error);
      }catch(error){ reject(error); }
    });
  }
  function localDel(name,key){
    return new Promise((resolve,reject)=>{
      try{
        const request = tx(name,'readwrite').delete(key);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
      }catch(error){ reject(error); }
    });
  }
  function localClear(name){
    return new Promise((resolve,reject)=>{
      try{
        const request = tx(name,'readwrite').clear();
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
      }catch(error){ reject(error); }
    });
  }

  /* ---------- change tracking / background cloud queue ---------- */
  function recordKey(name,value){ return name === 'settings' ? value.key : value.id; }
  function track(name,key,value,clear){
    const seq = ++changeSeq;
    pendingLocalChanges.push({seq, name, key, value, clear:!!clear});
    return seq;
  }
  function trackPut(name,value){ return track(name,recordKey(name,value),value,false); }
  function trackDel(name,key){ return track(name,key,null,false); }
  function trackClear(name){ return track(name,'',null,true); }

  function cloudReady(){ return !!(currentUser && supabaseClient); }
  function warnCloud(error,label){
    console.warn(`Toolify cloud sync (${label}):`, error);
    const now = Date.now();
    if(typeof toast === 'function' && now - lastCloudWarning > 15000){
      lastCloudWarning = now;
      toast('Saved on this device — cloud sync will retry shortly.', 'error');
    }
  }
  function enqueueCloud(label, fn, sequences){
    if(!cloudReady()) return Promise.resolve(false);
    cloudWriteQueue.push({label, fn, sequences:sequences || [], attempts:0});
    return flushCloudWrites();
  }
  async function flushCloudWrites(){
    if(cloudSyncBusy || cloudFlushing) return;
    cloudFlushing = true;
    try{
      while(cloudWriteQueue.length){
        const task = cloudWriteQueue.shift();
        try{
          await task.fn();
          if(task.sequences.length){
            const done = new Set(task.sequences);
            for(let i = pendingLocalChanges.length - 1; i >= 0; i--){
              if(done.has(pendingLocalChanges[i].seq)) pendingLocalChanges.splice(i,1);
            }
          }
        }catch(error){
          task.attempts++;
          if(task.attempts < 3){
            window.setTimeout(()=>{
              cloudWriteQueue.push(task);
              flushCloudWrites().catch(()=>{});
            }, 700 * task.attempts);
          }else{
            warnCloud(error, task.label);
          }
        }
      }
    }finally{
      cloudFlushing = false;
    }
  }
  async function applyPendingLocalChanges(){
    const changes = pendingLocalChanges.splice(0);
    for(const change of changes){
      try{
        if(change.clear) await localClear(change.name);
        else if(change.value === null) await localDel(change.name, change.key);
        else await localPut(change.name, change.value);
      }catch(error){ console.warn('Could not replay a local change:', error); }
    }
  }
  async function flushCloud(){
    while(cloudSyncBusy || cloudFlushing){
      await new Promise(resolve => window.setTimeout(resolve, 80));
    }
    await flushCloudWrites();
  }

  /* ---------- cloud row mapping ---------- */
  function toCloud(name,value){
    const base = {user_id: currentUser.id};
    if(name === 'tools') return {
      ...base, id:value.id, name:value.name, url:value.url,
      category_id:value.categoryId || 'uncategorized', description:value.description || '',
      favorite:!!value.favorite, icon_failed:!!value.iconFailed,
      created_at:value.createdAt || new Date().toISOString(),
      updated_at:value.updatedAt || new Date().toISOString()
    };
    if(name === 'categories') return {
      ...base, id:value.id, name:value.name, system:!!value.system,
      created_at:value.createdAt || new Date().toISOString()
    };
    if(name === 'settings') return {...base, key:value.key, value:value.value ?? {}};
    if(name === 'books') return {
      ...base, id:value.id, name:value.name, size:Number(value.size) || 0,
      page_count:Number(value.pageCount) || 0,
      created_at:value.createdAt || new Date().toISOString(),
      storage_path:value.storagePath || null
    };
    return {
      ...base, id:value.id, created_at:value.createdAt || new Date().toISOString(),
      data:{tools:value.tools || [], categories:value.categories || [], settings:value.settings || {}}
    };
  }
  function fromCloud(name,value){
    if(name === 'tools') return {
      id:value.id, name:value.name, url:value.url, categoryId:value.category_id,
      description:value.description || '', favorite:!!value.favorite,
      iconFailed:!!value.icon_failed, createdAt:value.created_at, updatedAt:value.updated_at
    };
    if(name === 'categories') return {
      id:value.id, name:value.name, system:!!value.system, createdAt:value.created_at
    };
    if(name === 'settings') return {key:value.key, value:value.value};
    if(name === 'books') return {
      id:value.id, name:value.name, size:Number(value.size) || 0,
      pageCount:Number(value.page_count) || 0,
      createdAt:value.created_at, storagePath:value.storage_path || null
    };
    return {
      id:value.id, createdAt:value.created_at,
      tools:value.data?.tools || [], categories:value.data?.categories || [],
      settings:value.data?.settings || {}
    };
  }
  function isConflictTargetError(error){
    const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
    return message.includes('no unique') ||
      message.includes('on conflict') ||
      message.includes('unique or exclusion constraint');
  }

  /* Some Supabase projects only declare `id` as the primary key while older
     ones declare a composite (user_id,id)/(user_id,key). Try both, then do a
     scoped replace, so every table actually writes instead of silently
     failing on the ON CONFLICT target. */
  async function cloudReplaceRow(name,row){
    const keyColumn = name === 'settings' ? 'key' : 'id';
    const keyValue = name === 'settings' ? row.key : row.id;
    const updated = await supabaseClient.from(tableFor[name])
      .update(row).eq('user_id', row.user_id).eq(keyColumn, keyValue).select(keyColumn);
    if(updated.error) throw updated.error;
    if(updated.data?.length) return;
    const inserted = await supabaseClient.from(tableFor[name]).insert(row);
    if(inserted.error) throw inserted.error;
  }

  function settingsTimestamp(row){
    const value = row?.value;
    if(!value || typeof value !== 'object') return 0;
    return Number(value.updatedAt || 0) || 0;
  }
  function mergeSettingsRows(localRows,remoteRows){
    const byKey = new Map();
    remoteRows.forEach(row => { if(row?.key) byKey.set(row.key, row); });
    localRows.forEach(row => {
      if(!row?.key) return;
      const current = byKey.get(row.key);
      if(!current || settingsTimestamp(row) >= settingsTimestamp(current)) byKey.set(row.key, row);
    });
    return Array.from(byKey.values());
  }

  async function cloudUpsert(name,values){
    if(!cloudReady() || !values.length) return;
    const rows = values.map(value => toCloud(name,value));
    const conflicts = name === 'settings' ? ['user_id,key'] : ['user_id,id','id'];
    for(const onConflict of conflicts){
      const {error} = await supabaseClient.from(tableFor[name]).upsert(rows,{onConflict});
      if(!error) return;
      if(!isConflictTargetError(error)) throw error;
    }
    for(const row of rows) await cloudReplaceRow(name,row);
  }
  async function cloudDelete(name,key){
    if(!cloudReady()) return;
    let query = supabaseClient.from(tableFor[name]).delete().eq('user_id',currentUser.id);
    query = query.eq(name === 'settings' ? 'key' : 'id', key);
    const {error} = await query;
    if(error) throw error;
  }
  async function cloudClear(name){
    if(!cloudReady()) return;
    const {error} = await supabaseClient.from(tableFor[name]).delete().eq('user_id',currentUser.id);
    if(error) throw error;
  }

  /* ---------- public write API ---------- */
  async function put(name,value){
    await localPut(name,value);
    const seq = trackPut(name,value);
    void enqueueCloud(`save ${name}`, ()=>cloudUpsert(name,[value]), [seq]);
    return true;
  }
  async function bulkPut(name,values){
    await localBulkPut(name,values);
    if(!values.length) return true;
    const seqs = values.map(value => trackPut(name,value));
    void enqueueCloud(`save ${name}`, ()=>cloudUpsert(name,values), seqs);
    return true;
  }
  async function del(name,key){
    await localDel(name,key);
    const seq = trackDel(name,key);
    void enqueueCloud(`delete ${name}`, ()=>cloudDelete(name,key), [seq]);
    return true;
  }
  async function clearStore(name){
    await localClear(name);
    const seq = trackClear(name);
    void enqueueCloud(`clear ${name}`, ()=>cloudClear(name), [seq]);
    return true;
  }
  /* Local-only writes are used for startup repairs. Those records are
     uploaded by the first sync instead of racing it. */
  async function putLocal(name,value){ return localPut(name,value); }
  async function bulkPutLocal(name,values){ return localBulkPut(name,values); }

  /* ---------- startup sync ---------- */
  async function syncForUser(user){
    currentUser = user;
    cloudSyncBusy = true;
    try{
      const names = ['categories','tools','settings','snapshots'];
      const localEntries = await Promise.all(names.map(async name => [name, await localGetAll(name)]));
      const local = Object.fromEntries(localEntries);
      const remoteEntries = await Promise.all(names.map(async name => {
        const {data,error} = await supabaseClient.from(tableFor[name]).select('*').eq('user_id',user.id);
        if(error) throw error;
        return [name, (data || []).map(value => fromCloud(name,value))];
      }));
      const remote = Object.fromEntries(remoteEntries);
      const hasRemote = names.some(name => remote[name].length > 0);

      if(!hasRemote){
        if(!local.categories.some(category => category.id === 'uncategorized')){
          local.categories.push({
            id:'uncategorized', name:'Uncategorized', system:true,
            createdAt:new Date().toISOString()
          });
        }
        await Promise.all(names.map(name => {
          const rows = local[name];
          return rows.length ? cloudUpsert(name, rows) : Promise.resolve();
        }));
        names.forEach(name => { remote[name] = local[name].slice(); });
      }else{
        /* A note/task saved locally just before a slow login must win over an
           older cloud snapshot. Normalize duplicate settings rows too. */
        const before = JSON.stringify(remote.settings);
        remote.settings = mergeSettingsRows(local.settings, remote.settings);
        if(JSON.stringify(remote.settings) !== before){
          try{
            await cloudClear('settings');
            if(remote.settings.length) await cloudUpsert('settings', remote.settings);
          }catch(error){ console.warn('Could not normalize cloud settings:', error); }
        }
      }

      await Promise.all(names.map(async name => {
        await localClear(name);
        if(remote[name].length) await localBulkPut(name, remote[name]);
      }));
      await applyPendingLocalChanges();
    }finally{
      cloudSyncBusy = false;
      void flushCloudWrites();
    }
  }

  async function clearLocal(){
    for(const name of ['tools','categories','settings','snapshots','books','bookPages','musicFiles']){
      await localClear(name);
    }
    cloudWriteQueue.length = 0;
    pendingLocalChanges.length = 0;
  }

  /* ---------- books (metadata + PDF file in Supabase Storage) ---------- */
  function musicOwnerId(){ return currentUser?.id || 'anonymous'; }
  function musicFileKey(trackId){ return `${musicOwnerId()}:${trackId}`; }
  async function getMusicFiles(){
    return dbInstance ? (await localGetAll('musicFiles')).filter(file => file.userId === musicOwnerId()) : [];
  }
  async function putMusicFiles(files){
    if(!files.length) return true;
    const records = files.map(({track,blob}) => {
      const savedTrack = {...track};
      delete savedTrack.url;
      delete savedTrack.blob;
      delete savedTrack.mediaStored;
      return {id:musicFileKey(track.id), userId:musicOwnerId(), trackId:track.id, track:savedTrack, blob};
    });
    return localBulkPut('musicFiles', records);
  }
  async function deleteMusicFile(trackId){ return localDel('musicFiles',musicFileKey(trackId)); }
  async function deleteUnusedMusicFiles(trackIds){
    const keep = new Set(trackIds);
    const files = await getMusicFiles();
    await Promise.all(files.filter(file => !keep.has(file.trackId)).map(file => localDel('musicFiles',file.id)));
  }
  async function clearMusicFiles(){
    const files = await getMusicFiles();
    await Promise.all(files.map(file => localDel('musicFiles',file.id)));
  }

  async function ensureBookUpload(book){
    if(!cloudReady() || !book.blob) return book.storagePath || null;
    if(book.storagePath) return book.storagePath;
    const path = `${currentUser.id}/${book.id}.pdf`;
    const {error} = await supabaseClient.storage
      .from(BOOKS_STORAGE_BUCKET)
      .upload(path, book.blob, {upsert:true, contentType:'application/pdf'});
    if(error) throw error;
    book.storagePath = path;
    await localPut('books', book);
    return path;
  }
  async function getAllBooks(){ return dbInstance ? localGetAll('books') : []; }
  async function getBook(id){ return dbInstance ? localGet('books',id) : null; }
  async function putBook(book){
    await localPut('books',book);
    const seq = trackPut('books',book);
    void enqueueCloud('save book', async () => {
      await ensureBookUpload(book);
      await cloudUpsert('books',[book]);
    }, [seq]);
    return true;
  }
  async function delBook(id){
    const book = await localGet('books',id);
    await localDel('books',id);
    const seq = trackDel('books',id);
    void enqueueCloud('delete book', async () => {
      await cloudDelete('books',id);
      if(book?.storagePath){
        const {error} = await supabaseClient.storage.from(BOOKS_STORAGE_BUCKET).remove([book.storagePath]);
        if(error) throw error;
      }
    }, [seq]);
    return true;
  }
  async function getCloudBookBlob(book){
    if(!cloudReady() || !book?.storagePath) throw new Error('This book has no cloud copy yet.');
    const {data,error} = await supabaseClient.storage.from(BOOKS_STORAGE_BUCKET).download(book.storagePath);
    if(error) throw error;
    if(!data) throw new Error('Supabase returned an empty PDF.');
    return data;
  }
  async function syncBooksForUser(user){
    if(!supabaseClient) return;
    currentUser = user;
    try{
      const {data,error} = await supabaseClient.from('books').select('*').eq('user_id',user.id);
      if(error) throw error;
      const remote = (data || []).map(value => fromCloud('books',value));
      const local = await localGetAll('books');
      const localById = new Map(local.map(book => [book.id,book]));
      const remoteIds = new Set(remote.map(book => book.id));

      await Promise.all(remote.map(async remoteBook => {
        const existing = localById.get(remoteBook.id);
        if(!existing){
          await localPut('books', {...remoteBook, blob:null});
          return;
        }
        const merged = {
          ...existing,
          name:remoteBook.name || existing.name,
          size:remoteBook.size || existing.size,
          pageCount:remoteBook.pageCount || existing.pageCount,
          createdAt:remoteBook.createdAt || existing.createdAt,
          storagePath:remoteBook.storagePath || existing.storagePath || null
        };
        if(JSON.stringify(merged) !== JSON.stringify(existing)) await localPut('books',merged);
      }));

      const localOnly = local.filter(book => !remoteIds.has(book.id));
      if(localOnly.length){
        await Promise.all(localOnly.map(async book => {
          try{
            await ensureBookUpload(book);
            await cloudUpsert('books',[book]);
          }catch(uploadError){ console.warn('Book upload will be retried:', uploadError); }
        }));
      }
    }finally{
      void flushCloudWrites();
    }
  }
  async function clearCloudStorage(){
    if(!cloudReady()) return;
    for(const bucket of [MUSIC_STORAGE_BUCKET, BOOKS_STORAGE_BUCKET]){
      try{
        const all = [];
        for(let offset = 0; ; offset += 1000){
          const {data,error} = await supabaseClient.storage.from(bucket).list(currentUser.id,{limit:1000, offset});
          if(error) throw error;
          const page = data || [];
          all.push(...page);
          if(page.length < 1000) break;
        }
        if(all.length){
          const paths = all.map(item => `${currentUser.id}/${item.name}`);
          const {error} = await supabaseClient.storage.from(bucket).remove(paths);
          if(error) throw error;
        }
      }catch(error){ console.warn(`Could not clear ${bucket}:`, error); }
    }
  }

  async function getBookPages(id){ return dbInstance ? localGet('bookPages',id) : null; }
  async function putBookPages(record){ return localPut('bookPages',record); }
  async function delBookPages(id){ return localDel('bookPages',id); }

  /* Explicit category deletion must finish on both sides before the UI
     moves on, even if a startup sync is still running. */
  async function removeCategory(id, movedTools){
    if(movedTools && movedTools.length){
      const seqs = movedTools.map(tool => trackPut('tools',tool));
      await localBulkPut('tools', movedTools);
      await cloudUpsert('tools', movedTools);
      const done = new Set(seqs);
      for(let i = pendingLocalChanges.length - 1; i >= 0; i--){
        if(done.has(pendingLocalChanges[i].seq)) pendingLocalChanges.splice(i,1);
      }
    }
    const seq = trackDel('categories',id);
    await localDel('categories',id);
    await cloudDelete('categories',id);
    const index = pendingLocalChanges.findIndex(change => change.seq === seq);
    if(index >= 0) pendingLocalChanges.splice(index,1);
    return true;
  }

  return {
    open, getAll:localGetAll, put, bulkPut, del, clearStore,
    putLocal, bulkPutLocal,
    syncForUser, clearLocal, flushCloud, removeCategory,
    getAllBooks, getBook, putBook, delBook, getCloudBookBlob, syncBooksForUser,
    getBookPages, putBookPages, delBookPages,
    getMusicFiles, putMusicFiles, deleteMusicFile, deleteUnusedMusicFiles,
    clearMusicFiles, clearCloudStorage
  };
})();


async function persistTool(tool){
  await DB.put("tools", tool);
}
async function persistCategory(cat){
  await DB.put("categories", cat);
}

/* Cross-module state setters (ES module bindings are read-only) */
function setCurrentUser(v){ currentUser = v; }
function setLibraryLoading(v){ libraryLoading = v; }
