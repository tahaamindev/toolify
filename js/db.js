/* ============================================================
   TOOLIFY — Data layer — IndexedDB cache + Supabase sync
   Split from the original app.js (behaviour preserved).
   ============================================================ */

{ supabaseClient };
let currentUser = null;
let cloudSyncBusy = false;
let libraryLoading = false;
const DB = (function(){
  let dbInstance = null;
  function open(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=e=>{const db=e.target.result;for(const [n,k] of [['tools','id'],['categories','id'],['settings','key'],['snapshots','id'],['musicFiles','id'],['books','id'],['bookPages','id']])if(!db.objectStoreNames.contains(n))db.createObjectStore(n,{keyPath:k});};req.onsuccess=e=>{dbInstance=req.result;dbInstance.onversionchange=()=>dbInstance.close();resolve(dbInstance);};req.onerror=e=>reject(req.error);});}
  function tx(n,m){return dbInstance.transaction(n,m).objectStore(n);}
  function localGetAll(n){return new Promise((resolve,reject)=>{try{const r=tx(n,'readonly').getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  function localPut(n,v){return new Promise((resolve,reject)=>{try{const r=tx(n,'readwrite').put(v);r.onsuccess=()=>resolve(true);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  function localGet(n,k){return new Promise((resolve,reject)=>{try{const r=tx(n,'readonly').get(k);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  function localBulkPut(n,vs){return new Promise((resolve,reject)=>{try{const st=tx(n,'readwrite');vs.forEach(v=>st.put(v));st.transaction.oncomplete=()=>resolve(true);st.transaction.onerror=()=>reject(st.transaction.error);}catch(e){reject(e);}});}
  function localDel(n,k){return new Promise((resolve,reject)=>{try{const r=tx(n,'readwrite').delete(k);r.onsuccess=()=>resolve(true);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  function musicOwnerId(){return currentUser?.id||'anonymous';}
  function musicFileKey(trackId){return `${musicOwnerId()}:${trackId}`;}
  async function getMusicFiles(){return dbInstance?(await localGetAll('musicFiles')).filter(file=>file.userId===musicOwnerId()):[];}
  async function putMusicFiles(files){
    if(!files.length) return true;
    const records=files.map(({track,blob})=>{
      const savedTrack={...track};
      delete savedTrack.url;
      delete savedTrack.blob;
      delete savedTrack.mediaStored;
      return {id:musicFileKey(track.id),userId:musicOwnerId(),trackId:track.id,track:savedTrack,blob};
    });
    return new Promise((resolve,reject)=>{
      try{
        const store=tx('musicFiles','readwrite');
        const transaction=store.transaction;
        transaction.oncomplete=()=>resolve(true);
        transaction.onerror=()=>reject(transaction.error);
        transaction.onabort=()=>reject(transaction.error||new Error('Could not save local music files.'));
        records.forEach(record=>store.put(record));
      }catch(error){reject(error);}
    });
  }
  async function deleteMusicFile(trackId){return localDel('musicFiles',musicFileKey(trackId));}
  async function deleteUnusedMusicFiles(trackIds){
    const keep=new Set(trackIds);
    const files=await getMusicFiles();
    await Promise.all(files.filter(file=>!keep.has(file.trackId)).map(file=>localDel('musicFiles',file.id)));
  }
  async function clearMusicFiles(){
    const files=await getMusicFiles();
    await Promise.all(files.map(file=>localDel('musicFiles',file.id)));
  }
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
      const localEntries=await Promise.all(names.map(async n=>[n,await localGetAll(n)]));
      const local=Object.fromEntries(localEntries);
      const remoteEntries=await Promise.all(names.map(async n=>{
        const {data,error}=await supabaseClient.from(tableFor[n]).select('*').eq('user_id',user.id);
        if(error)throw error;
        return [n,(data||[]).map(v=>fromCloud(n,v))];
      }));
      const remote=Object.fromEntries(remoteEntries);
      const hasRemote=names.some(n=>remote[n].length>0);
      if(!hasRemote){
        if(!local.categories.some(c=>c.id==='uncategorized'))local.categories.push({id:'uncategorized',name:'Uncategorized',system:true,createdAt:new Date().toISOString()});
        if(local.categories.length)await cloudUpsert('categories',local.categories);
        if(local.tools.length)await cloudUpsert('tools',local.tools);
        if(local.settings.length)await cloudUpsert('settings',local.settings);
        if(local.snapshots.length)await cloudUpsert('snapshots',local.snapshots);
        names.forEach(n=>{remote[n]=local[n].slice();});
      }
      await Promise.all(names.map(async n=>{
        await localClear(n);
        if(remote[n].length)await localBulkPut(n,remote[n]);
      }));
    }finally{cloudSyncBusy=false;}
  }
  async function clearLocal(){for(const n of ['tools','categories','settings','snapshots'])await localClear(n);}
  async function getAllBooks(){return dbInstance?(await localGetAll('books')):[];}
  async function putBook(book){await localPut('books',book);return true;}
  async function delBook(id){await localDel('books',id);return true;}
  async function getBookPages(id){return dbInstance?localGet('bookPages',id):null;}
  async function putBookPages(record){await localPut('bookPages',record);return true;}
  async function delBookPages(id){await localDel('bookPages',id);return true;}
  /* Explicit user action: move the affected tools first, then remove the
     category from both the local cache and Supabase. Not gated by
     cloudSyncBusy, so a delete is never silently skipped during startup sync. */
  async function removeCategory(id, movedTools){
    if(movedTools && movedTools.length){
      await localBulkPut('tools', movedTools);
      if(currentUser) await cloudUpsert('tools', movedTools);
    }
    await localDel('categories', id);
    if(currentUser) await cloudDelete('categories', id);
    return true;
  }
  return {open,getAll:localGetAll,put,bulkPut,del,clearStore,syncForUser,clearLocal,removeCategory,getAllBooks,putBook,delBook,getBookPages,putBookPages,delBookPages,getMusicFiles,putMusicFiles,deleteMusicFile,deleteUnusedMusicFiles,clearMusicFiles};
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
