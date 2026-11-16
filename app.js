
(function(){
"use strict";

/* ============================================================
   0. CONSTANTS
   ============================================================ */
const DB_NAME = "toolify-db";
const DB_VERSION = 3;
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
const MUSIC_STORAGE_BUCKET = "toolify-music";
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
  function open(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=e=>{const db=e.target.result;for(const [n,k] of [['tools','id'],['categories','id'],['settings','key'],['snapshots','id'],['musicFiles','id']])if(!db.objectStoreNames.contains(n))db.createObjectStore(n,{keyPath:k});};req.onsuccess=e=>{dbInstance=req.result;dbInstance.onversionchange=()=>dbInstance.close();resolve(dbInstance);};req.onerror=e=>reject(req.error);});}
  function tx(n,m){return dbInstance.transaction(n,m).objectStore(n);}
  function localGetAll(n){return new Promise((resolve,reject)=>{try{const r=tx(n,'readonly').getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
  function localPut(n,v){return new Promise((resolve,reject)=>{try{const r=tx(n,'readwrite').put(v);r.onsuccess=()=>resolve(true);r.onerror=()=>reject(r.error);}catch(e){reject(e);}});}
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
        for(const n of names){const {data,error}=await supabaseClient.from(tableFor[n]).select('*').eq('user_id',user.id);if(error)throw error;remote[n]=(data||[]).map(v=>fromCloud(n,v));}
      }
      await Promise.all(names.map(async n=>{
        await localClear(n);
        if(remote[n].length)await localBulkPut(n,remote[n]);
      }));
    }finally{cloudSyncBusy=false;}
  }
  async function clearLocal(){for(const n of ['tools','categories','settings','snapshots'])await localClear(n);}
  return {open,getAll:localGetAll,put,bulkPut,del,clearStore,syncForUser,clearLocal,getMusicFiles,putMusicFiles,deleteMusicFile,deleteUnusedMusicFiles,clearMusicFiles};
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
function notesList(){
  if(!Array.isArray(State.settings.notes)) State.settings.notes = [];
  return State.settings.notes;
}

const MUSIC_THEMES = {
  silver:{accent:'#687785',bg:'#e4e8eb',surface:'#f4f6f7',elevated:'#d9dee2',text:'#1c2226',muted:'#64717a',border:'rgba(28,34,38,.13)'},
  classic:{accent:'#22b876',bg:'#171a19',surface:'#1d211f',elevated:'#252a27',text:'#f2f3f1',muted:'#8f9792',border:'rgba(255,255,255,.09)'},
  ocean:{accent:'#14b8a6',bg:'#10201f',surface:'#142a28',elevated:'#1b3532',text:'#e6f4f1',muted:'#86a9a2',border:'rgba(124,211,198,.13)'},
  rose:{accent:'#f47272',bg:'#241719',surface:'#301e21',elevated:'#42282c',text:'#fff0f0',muted:'#c1989c',border:'rgba(255,180,185,.13)'},
  pink:{accent:'#ec4899',bg:'#211622',surface:'#2e1d30',elevated:'#402743',text:'#fff0fb',muted:'#ba94b3',border:'rgba(236,72,153,.16)'},
  lavender:{accent:'#a78bfa',bg:'#1d192b',surface:'#282239',elevated:'#362e4c',text:'#f5f0ff',muted:'#aa9fc5',border:'rgba(167,139,250,.16)'},
  forest:{accent:'#84cc16',bg:'#172017',surface:'#202b1e',elevated:'#2c3a27',text:'#f2f7e9',muted:'#a0b08c',border:'rgba(163,230,53,.15)'},
  sunset:{accent:'#fb923c',bg:'#261c16',surface:'#352419',elevated:'#49301f',text:'#fff3e8',muted:'#c2a188',border:'rgba(251,146,60,.16)'},
  midnight:{accent:'#60a5fa',bg:'#111a29',surface:'#172337',elevated:'#20314a',text:'#edf5ff',muted:'#91a8c6',border:'rgba(96,165,250,.16)'}
};
let musicTracks = [];
let musicQueue = [];
let currentMusicTrack = -1;
let musicSettingsRef = null;
let musicSelectedPlaylist = 'all';
let musicShuffle = false;
let musicRepeat = 'off';
let musicYoutubePlayer = null;
let musicYoutubeReady = false;
let musicYoutubePendingId = null;
let musicProgressTimer = null;
let musicAudioContext = null;
let musicEqFilters = null;

function getMusicSettings(){
  if(!State.settings.music || typeof State.settings.music !== 'object'){
    State.settings.music = {tracks:[], playlists:[], queue:[], theme:'silver', customAccent:'', volume:75, speed:1};
  }
  const music = State.settings.music;
  if(!Array.isArray(music.tracks)) music.tracks = [];
  if(!Array.isArray(music.playlists)) music.playlists = [];
  if(!Array.isArray(music.queue)) music.queue = [];
  return music;
}

function musicStorageKey(name){
  return `toolify-music-${currentUser?.id||'anonymous'}-${name}`;
}

function syncMusicState(){
  const music = getMusicSettings();
  if(musicSettingsRef === music) return;
  musicSettingsRef = music;
  musicTracks.forEach(track=>{if(track.localFile && track.url) URL.revokeObjectURL(track.url);});
  musicTracks = music.tracks.map(track=>({...track}));
  musicQueue = music.queue.filter(id=>musicTracks.some(track=>track.id === id));
  currentMusicTrack = -1;
  musicSelectedPlaylist = 'all';
  musicShuffle = !!music.shuffle;
  musicRepeat = ['off','all','one'].includes(music.repeat) ? music.repeat : 'off';
  document.getElementById('music-volume').value = String(music.volume ?? 75);
  renderMusicLibrary();
  renderMusicQueue();
  updateMusicControls();
  createMusicSnapshot();
  hydrateLocalMusicFiles(music).catch(error=>musicPersistenceError(error));
}

async function hydrateLocalMusicFiles(music=getMusicSettings()){
  const files=await DB.getMusicFiles();
  if(musicSettingsRef!==music) return;
  let restoredMissingMetadata=false;
  files.forEach(file=>{
    if(!file.blob) return;
    const existing=findMusicTrack(file.trackId);
    if(existing){
      if(existing.mediaStored&&existing.blob) return;
      if(existing.url) URL.revokeObjectURL(existing.url);
      existing.url=URL.createObjectURL(file.blob);
      existing.blob=file.blob;
      existing.localFile=true;
      existing.mediaStored=true;
    }else{
      musicTracks.push({...file.track,url:URL.createObjectURL(file.blob),blob:file.blob,localFile:true,mediaStored:true});
      restoredMissingMetadata=true;
    }
  });
  if(currentUser&&supabaseClient){
    for(const track of musicTracks.filter(item=>item.localFile&&!item.url&&item.cloudPath)){
      try{
        const {data,error}=await supabaseClient.storage.from(MUSIC_STORAGE_BUCKET).download(track.cloudPath);
        if(error) throw error;
        if(!data) throw new Error('Supabase returned an empty music file.');
        await DB.putMusicFiles([{track,blob:data}]);
        track.url=URL.createObjectURL(data);
        track.blob=data;
        track.mediaStored=true;
        restoredMissingMetadata=true;
      }catch(error){
        console.error(`Could not restore ${track.title} from Supabase:`,error);
        musicMessage(`Could not download “${track.title}” from cloud storage.`,true);
      }
    }
  }
  musicQueue=music.queue.filter(id=>musicTracks.some(track=>track.id===id));
  renderMusicLibrary();
  renderMusicQueue();
  updateMusicControls();
  if(restoredMissingMetadata) await saveMusicState();
}

function musicMessage(message, isError=false){
  const status = document.getElementById('music-status');
  if(status) status.textContent = message;
  if(message) toast(message, isError ? 'error' : 'success');
}

function musicSnapshotPayload(){
  const music = getMusicSettings();
  return {
    version:1,
    tracks:musicTracks.map(musicTrackMetadata),
    playlists:music.playlists.map(playlist=>({...playlist})),
    queue:musicQueue.slice(),
    theme:music.theme,
    customAccent:music.customAccent,
    volume:music.volume??75,
    speed:music.speed??1,
    equalizer:music.equalizer||[0,0,0],
    shuffle:musicShuffle,
    repeat:musicRepeat
  };
}

function musicTrackMetadata(track){
  const metadata={...track};
  delete metadata.url;
  delete metadata.blob;
  delete metadata.mediaStored;
  return metadata;
}

function createMusicSnapshot(){
  try{
    const key = musicStorageKey('snapshots');
    const snapshots = JSON.parse(localStorage.getItem(key) || '[]');
    snapshots.unshift({createdAt:Date.now(), data:musicSnapshotPayload()});
    localStorage.setItem(key, JSON.stringify(snapshots.slice(0,5)));
    const backupStatus = document.getElementById('music-backup-status');
    if(backupStatus) backupStatus.textContent = `Automatic local snapshot saved · ${new Date().toLocaleString()}`;
  }catch(error){
    console.error('Could not create music backup snapshot:', error);
    const backupStatus = document.getElementById('music-backup-status');
    if(backupStatus) backupStatus.textContent = 'Automatic backup could not be saved in this browser.';
  }
}

async function blobToBase64(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let binary='';
  const chunkSize=0x8000;
  for(let offset=0;offset<bytes.length;offset+=chunkSize){
    binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(offset+chunkSize,bytes.length)));
  }
  return btoa(binary);
}

function base64ToBlob(data,type){
  const binary=atob(data);
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
  return new Blob([bytes],{type:type||'application/octet-stream'});
}

async function exportMusicBackup(){
  const files=await DB.getMusicFiles();
  const localFiles=await Promise.all(files.map(async file=>({
    trackId:file.trackId,
    name:file.track?.sourceName||file.track?.title||'',
    type:file.blob.type||'application/octet-stream',
    data:await blobToBase64(file.blob)
  })));
  const backup={app:'toolify-music',createdAt:new Date().toISOString(),...musicSnapshotPayload(),localFiles};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;
  anchor.download=`toolify-music-backup-${new Date().toISOString().slice(0,10)}.json`;
  anchor.click();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  musicMessage(`Backup exported with ${backup.tracks.length} songs and ${localFiles.length} local media files.`);
}

async function importMusicBackup(backup){
  if(!backup||!Array.isArray(backup.tracks)||!Array.isArray(backup.playlists)) throw new Error('This file is not a Toolify music backup.');
  const tracks=backup.tracks.filter(track=>{
    if(!track||typeof track.id!=='string') return false;
    if(track.localFile) return true;
    return typeof track.youtubeId==='string'&&!!youtubeVideoId(`https://youtu.be/${track.youtubeId}`);
  }).map(track=>musicTrackMetadata(track));
  const trackIds=new Set(tracks.map(track=>track.id));
  const localFiles=[...new Map((Array.isArray(backup.localFiles)?backup.localFiles:[])
    .filter(file=>file&&trackIds.has(file.trackId)&&typeof file.data==='string')
    .map(file=>[file.trackId,file])).values()];
  const localFileIds=new Set(localFiles.map(file=>file.trackId));
  const preparedFiles=localFiles.map(file=>{
    const track=tracks.find(item=>item.id===file.trackId);
    if(!track?.localFile) return null;
    track.sourceName=file.name||track.sourceName||track.title;
    return {track,blob:base64ToBlob(file.data,file.type)};
  }).filter(Boolean);
  await DB.putMusicFiles(preparedFiles);
  await DB.deleteUnusedMusicFiles(tracks.filter(track=>track.localFile).map(track=>track.id));
  stopMusicPlayback();
  musicTracks.forEach(track=>{if(track.localFile&&track.url) URL.revokeObjectURL(track.url);});
  musicTracks=tracks.map(track=>({...track,localFile:!!track.localFile,mediaStored:false}));
  preparedFiles.forEach(({track,blob})=>{
    const imported=findMusicTrack(track.id);
    imported.url=URL.createObjectURL(blob);
    imported.blob=blob;
    imported.mediaStored=true;
  });
  getMusicSettings().tracks=tracks;
  getMusicSettings().playlists=backup.playlists.filter(playlist=>playlist&&typeof playlist.id==='string'&&typeof playlist.name==='string');
  musicQueue=Array.isArray(backup.queue)?backup.queue.filter(id=>trackIds.has(id)):[];
  if(!musicQueue.length) musicQueue=tracks.map(track=>track.id);
  currentMusicTrack=-1;
  musicSelectedPlaylist='all';
  musicRepeat=['off','all','one'].includes(backup.repeat)?backup.repeat:'off';
  musicShuffle=!!backup.shuffle;
  getMusicSettings().volume=Math.max(0,Math.min(100,Number(backup.volume??75)));
  musicSettingsRef=getMusicSettings();
  document.getElementById('music-volume').value=String(getMusicSettings().volume);
  await hydrateLocalMusicFiles(musicSettingsRef);
  await saveMusicState();
  renderMusicLibrary();
  renderMusicQueue();
  updateMusicControls();
  const restoredFiles=localFiles.filter(file=>localFileIds.has(file.trackId)).length;
  musicMessage(`Imported ${tracks.length} songs, ${getMusicSettings().playlists.length} playlists, and ${restoredFiles} local media files.`);
}

async function saveMusicState(){
  const music = getMusicSettings();
  const pendingFiles=musicTracks.filter(track=>track.localFile&&track.blob&&!track.mediaStored);
  await DB.putMusicFiles(pendingFiles.map(track=>({track,blob:track.blob})));
  pendingFiles.forEach(track=>{track.mediaStored=true;});
  if(currentUser&&supabaseClient){
    for(const track of musicTracks.filter(item=>item.localFile&&item.blob&&!item.cloudPath)){
      const sourceName=track.sourceName||track.title;
      const extension=sourceName.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase()||'bin';
      const path=`${currentUser.id}/${track.id}.${extension}`;
      const {error}=await supabaseClient.storage.from(MUSIC_STORAGE_BUCKET).upload(path,track.blob,{
        upsert:true,
        contentType:track.blob.type||'application/octet-stream'
      });
      if(error) throw error;
      track.cloudPath=path;
    }
  }
  music.tracks = musicTracks.map(musicTrackMetadata);
  music.queue = musicQueue.filter(id=>musicTracks.some(track=>track.id===id));
  music.shuffle = musicShuffle;
  music.repeat = musicRepeat;
  await persistSettings();
  createMusicSnapshot();
}

function youtubeVideoId(rawUrl){
  try{
    const url = new URL(rawUrl.trim());
    if(url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if(hostname === 'youtu.be'){
      const id = url.pathname.split('/').filter(Boolean)[0];
      return /^[\w-]{11}$/.test(id || '') ? id : null;
    }
    if(hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) return null;
    const path = url.pathname.split('/').filter(Boolean);
    const id = url.pathname === '/watch'
      ? url.searchParams.get('v')
      : ['embed', 'shorts', 'live', 'live_stream'].includes(path[0]) ? path[1] : null;
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  }catch(error){
    return null;
  }
}

async function lookupYoutubeMetadata(videoId){
  const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`);
  if(!response.ok) throw new Error('YouTube could not provide details for this video.');
  const metadata = await response.json();
  return {
    title:metadata.title || '',
    artist:metadata.author_name || '',
    thumbnail:metadata.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

function findMusicTrack(id){
  return musicTracks.find(track=>track.id === id);
}

function renderMusicLibrary(){
  const list = document.getElementById('music-library-list');
  const query = document.getElementById('music-search').value.trim().toLowerCase();
  const filteredTracks = musicTracks.filter(track=>`${track.title} ${track.artist}`.toLowerCase().includes(query));
  list.replaceChildren();
  const summary=document.getElementById('music-queue-summary');
  if(summary) summary.textContent=`${musicTracks.length} ${musicTracks.length===1?'song':'songs'}`;
  if(!filteredTracks.length){
    const empty = document.createElement('div');
    empty.className = 'music-empty';
    empty.textContent = query ? 'No matching songs.' : 'Your library is empty. Use + to add files, a folder, or a YouTube link.';
    list.appendChild(empty);
  }
  filteredTracks.forEach(track=>{
    const row = document.createElement('div');
    row.className = `music-library-song${musicQueue[currentMusicTrack]===track.id?' active':''}`;
    row.dataset.trackId = track.id;
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'music-song-play';
    play.textContent = track.youtubeId ? '▶' : '♫';
    play.title = 'Play song';
    play.addEventListener('click', event=>{
      event.stopPropagation();
      playSong(track.id, true);
      saveMusicState().catch(error=>musicPersistenceError(error));
    });
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'music-song-meta';
    title.setAttribute('aria-label',`Play ${track.title}${track.artist ? ` by ${track.artist}` : ''}`);
    title.addEventListener('click', event=>{
      event.stopPropagation();
      playSong(track.id, true);
      saveMusicState().catch(error=>musicPersistenceError(error));
    });
    const strong = document.createElement('strong');
    strong.textContent = track.title;
    const artist = document.createElement('small');
    artist.textContent = track.localFile
      ? (track.url?(track.artist||'On this device'):'Cloud file not available on this device')
      : (track.artist||'YouTube');
    title.append(strong,artist);
    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.className = 'music-song-action';
    favorite.textContent = track.favorite ? '♥' : '♡';
    favorite.title = track.favorite ? 'Remove favorite' : 'Add to favorites';
    favorite.addEventListener('click', ()=>{
      track.favorite = !track.favorite;
      saveMusicState().then(renderMusicLibrary).catch(error=>musicPersistenceError(error));
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'music-song-action';
    remove.textContent = '×';
    remove.title = 'Remove song';
    remove.addEventListener('click', ()=>removeMusicSong(track.id));
    row.addEventListener('click',event=>{
      if(event.target.closest('button')) return;
      playSong(track.id,true);
      saveMusicState().catch(error=>musicPersistenceError(error));
    });
    row.append(play,title,favorite,remove);
    list.appendChild(row);
  });
  renderMusicQueueSummary();
}

function renderMusicPlaylistSelects(){
  const playlists = getMusicSettings().playlists;
  ['music-song-playlist','music-bulk-playlist'].forEach(id=>{
    const select = document.getElementById(id);
    if(!select) return;
    const selected = select.value;
    select.replaceChildren();
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All songs (no playlist)';
    select.appendChild(allOption);
    playlists.forEach(playlist=>{
      const option = document.createElement('option');
      option.value = playlist.id;
      option.textContent = playlist.name;
      select.appendChild(option);
    });
    if(playlists.some(playlist=>playlist.id === selected)) select.value = selected;
  });
}

function renderMusicQueue(){
  renderMusicQueueSummary();
}

function renderMusicQueueSummary(){
  const summary=document.getElementById('music-queue-summary');
  if(summary) summary.textContent = `${musicTracks.length} ${musicTracks.length===1?'song':'songs'}`;
  document.querySelectorAll('.music-library-song').forEach(row=>{
    const queued=musicQueue.includes(row.dataset.trackId);
    row.classList.toggle('active',musicQueue[currentMusicTrack]===row.dataset.trackId);
    row.classList.toggle('queued',queued);
  });
}

function renderUnavailableSongs(){
  const wrap=document.getElementById('music-unavailable');
  const unavailable=musicTracks.filter(track=>track.unavailable);
  wrap.textContent=unavailable.length ? unavailable.map(track=>track.title).join(', ') : 'No unavailable songs. Videos that cannot be embedded are flagged and skipped.';
}

function musicPersistenceError(error){
  console.error('Could not save music library:',error);
  musicMessage(error?.message||'Could not save music changes. Please try again.',true);
}

function showMusicForm(formName){
  const panel=document.getElementById('music-song-form');
  panel.hidden=formName==='add'?!panel.hidden:true;
  document.querySelector('[data-music-action="add"]').setAttribute('aria-expanded',String(!panel.hidden));
  if(!panel.hidden) document.getElementById('music-song-url').focus();
}

function createMusicPlaylist(){
  const name=prompt('Playlist name');
  if(!name || !name.trim()) return;
  const playlists=getMusicSettings().playlists;
  if(playlists.some(playlist=>playlist.name.toLowerCase()===name.trim().toLowerCase())){
    musicMessage('A playlist with that name already exists.',true);
    return;
  }
  playlists.push({id:uid(),name:name.trim(),createdAt:Date.now()});
  saveMusicState().then(renderMusicLibrary).catch(error=>musicPersistenceError(error));
}

async function saveMusicSong(){
  const urlInput=document.getElementById('music-song-url');
  const videoId=youtubeVideoId(urlInput.value);
  if(!videoId){
    musicMessage('Enter a valid YouTube video link.',true);
    urlInput.focus();
    return;
  }
  if(musicTracks.some(track=>track.youtubeId===videoId)){
    musicMessage('That video is already in your library.',true);
    return;
  }
  let metadata={};
  try{metadata=await lookupYoutubeMetadata(videoId);}
  catch(error){console.warn('Could not fetch YouTube song details:',error);}
  const track={
    id:uid(),youtubeId:videoId,title:metadata.title||`YouTube video (${videoId})`,
    artist:metadata.artist||'',thumbnail:metadata.thumbnail||`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    playlistId:'',favorite:false,unavailable:false,addedAt:Date.now()
  };
  musicTracks.unshift(track);
  urlInput.value='';
  showMusicForm('');
  musicQueue.push(track.id);
  playSong(track.id,false);
  try{
    await saveMusicState();
    renderMusicLibrary();
    musicMessage('YouTube video added to your library.');
  }catch(error){musicPersistenceError(error);}
}

async function importMusicLinks(){
  const input=document.getElementById('music-bulk-urls');
  const message=document.getElementById('music-bulk-message');
  const lines=input.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const playlistId=document.getElementById('music-bulk-playlist').value;
  const knownIds=new Set(musicTracks.map(track=>track.youtubeId).filter(Boolean));
  const validIds=[];
  let invalid=0,duplicates=0;
  lines.forEach(line=>{
    const id=youtubeVideoId(line);
    if(!id){invalid++;return;}
    if(knownIds.has(id)){duplicates++;return;}
    knownIds.add(id);
    validIds.push(id);
  });
  if(!validIds.length){
    musicMessage(lines.length ? 'No new valid YouTube links to import.' : 'Paste at least one YouTube link.',true);
    return;
  }
  const additions=validIds.map(id=>({id:uid(),youtubeId:id,title:`YouTube video (${id})`,artist:'',thumbnail:`https://i.ytimg.com/vi/${id}/hqdefault.jpg`,playlistId,favorite:false,unavailable:false,addedAt:Date.now()}));
  musicTracks.unshift(...additions);
  try{
    await saveMusicState();
    renderMusicLibrary();
    input.value='';
    message.textContent=`Imported ${additions.length}; ${duplicates} duplicates and ${invalid} invalid links skipped. Loading titles…`;
  }catch(error){musicPersistenceError(error);return;}
  let failures=0, completed=0;
  const workers=Array.from({length:Math.min(5,additions.length)},async()=>{
    while(completed<additions.length){
      const index=completed++;
      const track=additions[index];
      try{
        const metadata=await lookupYoutubeMetadata(track.youtubeId);
        track.title=metadata.title||track.title;
        track.artist=metadata.artist||track.artist;
        track.thumbnail=metadata.thumbnail||track.thumbnail;
      }catch(error){
        failures++;
        console.warn('Could not fetch imported YouTube title:',error);
      }
      if(completed%5===0 || completed===additions.length){
        message.textContent=`Loading song details: ${completed}/${additions.length}${failures ? ` · ${failures} unavailable` : ''}`;
        renderMusicLibrary();
      }
    }
  });
  await Promise.all(workers);
  try{
    await saveMusicState();
    renderMusicLibrary();
    message.textContent=`Imported ${additions.length} songs${failures ? `; details unavailable for ${failures}` : ''}.`;
  }catch(error){musicPersistenceError(error);}
}

function loadMusicFiles(files){
  const selectedFiles=Array.from(files);
  const supportedVideoTypes=['video/mp4','video/webm','video/ogg'];
  const mediaFiles=selectedFiles.filter(file=>file.type.startsWith('audio/')||supportedVideoTypes.includes(file.type)||/\.(mp3|wav|ogg|m4a|aac|flac|opus|webm|mp4|m4v|mov|ogv)$/i.test(file.name));
  if(!mediaFiles.length){musicMessage('No supported music or video files were found.',true);return;}
  const knownFiles=new Set(musicTracks.filter(track=>track.localFile).map(track=>track.sourceName||track.title));
  const additions=mediaFiles.filter(file=>!knownFiles.has(file.webkitRelativePath||file.name)).map(file=>({
    id:uid(),title:file.webkitRelativePath||file.name,sourceName:file.webkitRelativePath||file.name,artist:'On this device',url:URL.createObjectURL(file),blob:file,mediaStored:false,
    mediaType:file.type.startsWith('video/')||/\.(mp4|m4v|mov|ogv)$/i.test(file.name)?'video':'audio',
    localFile:true,playlistId:musicSelectedPlaylist==='all'?'':musicSelectedPlaylist,favorite:false
  }));
  if(!additions.length){musicMessage('These files are already in your music library.');return;}
  musicTracks.unshift(...additions);
  musicQueue.push(...additions.map(track=>track.id));
  renderMusicLibrary();
  renderMusicQueue();
  playSong(additions[0].id,false);
  saveMusicState().then(()=>{
    const storageMessage=currentUser?'synced to your account and saved in this browser.':'saved in this browser.';
    if(mediaFiles.length!==selectedFiles.length) musicMessage(`Loaded ${additions.length} media files; unsupported files were skipped.`,true);
    else musicMessage(`Loaded ${additions.length} media files, ${storageMessage}`);
  }).catch(error=>musicPersistenceError(error));
}

function queueSong(id,playNext){
  if(musicQueue[currentMusicTrack]===id && playNext) return;
  const currentId=musicQueue[currentMusicTrack];
  const existing=musicQueue.indexOf(id);
  if(existing>=0) musicQueue.splice(existing,1);
  currentMusicTrack=musicQueue.indexOf(currentId);
  if(playNext && currentMusicTrack>=0) musicQueue.splice(currentMusicTrack+1,0,id);
  else musicQueue.push(id);
  renderMusicQueue();
  saveMusicState().then(()=>musicMessage(playNext?'Added to play next.':'Added to queue.')).catch(error=>musicPersistenceError(error));
}

function playSong(id,addToQueue){
  let index=musicQueue.indexOf(id);
  if(index<0){
    if(addToQueue) musicQueue.push(id);
    else musicQueue.splice(Math.max(0,currentMusicTrack+1),0,id);
    index=musicQueue.indexOf(id);
  }
  currentMusicTrack=index;
  playCurrentMusicTrack();
}

function playCurrentMusicTrack(){
  let track=findMusicTrack(musicQueue[currentMusicTrack]);
  if(!track) return;
  if(track.localFile&&!track.url){
    document.getElementById('music-playback-state').textContent='FILE NEEDED';
    musicMessage(`“${track.title}” is unavailable on this device. Sign in to download it from cloud storage or add the source file again.`,true);
    renderMusicQueue();
    return;
  }
  if(track.unavailable&&track.youtubeId){
    const nextAvailable=musicQueue.map((id,index)=>({id,index,track:findMusicTrack(id)})).find(({index,track:queuedTrack})=>
      index!==currentMusicTrack&&queuedTrack&&!queuedTrack.unavailable
    );
    if(!nextAvailable){
      stopMusicPlayback();
      musicMessage('All songs in the queue are currently unavailable.',true);
      return;
    }
    currentMusicTrack=nextAvailable.index;
    track=findMusicTrack(nextAvailable.id);
  }
  document.getElementById('music-now-playing').textContent=track.title;
  document.getElementById('music-current-artist').textContent=track.artist||'YouTube';
  const audio=document.getElementById('music-audio');
  const video=document.getElementById('music-video');
  const youtubeWrap=document.getElementById('music-youtube-wrap');
  audio.pause();
  video.pause();
  video.hidden=!!track.youtubeId||track.mediaType!=='video';
  document.getElementById('music-video-stage').classList.remove('video-visible');
  document.getElementById('music-video-toggle').setAttribute('aria-pressed','false');
  document.getElementById('music-video-toggle').setAttribute('aria-label','Show video');
  document.getElementById('music-video-toggle').title='Show video';
  youtubeWrap.setAttribute('aria-hidden','true');
  updateMusicProgress(0,0);
  document.getElementById('music-playback-state').textContent='LOADING';
  if(track.youtubeId){
    musicYoutubePendingId=track.youtubeId;
    loadYouTubePlayer();
    if(musicYoutubeReady && musicYoutubePlayer) musicYoutubePlayer.loadVideoById(track.youtubeId);
  }else{
    musicYoutubePendingId=null;
    if(musicYoutubePlayer && musicYoutubeReady) musicYoutubePlayer.pauseVideo();
    const player=track.mediaType==='video'?video:audio;
    if(player.src!==track.url) player.src=track.url;
    player.play().then(()=>{
      if(musicAudioContext?.state==='suspended') musicAudioContext.resume();
      document.getElementById('music-playback-state').textContent='PLAYING';
      updateMusicControls();
    }).catch(error=>{
      console.error('Could not play selected media:',error);
      musicMessage('Could not play this media file.',true);
    });
    player.volume=Number(getMusicSettings().volume??75)/100;
  }
  renderMusicQueue();
  updateMusicControls();
}

function loadYouTubePlayer(preloadOnly=false){
  if(window.YT?.Player){
    if(!preloadOnly) createYouTubePlayer();
    return;
  }
  if(document.querySelector('script[data-toolify-youtube-api]')) return;
  const previousCallback=window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady=()=>{
    if(typeof previousCallback==='function') previousCallback();
    if(!preloadOnly||musicYoutubePendingId) createYouTubePlayer();
  };
  const script=document.createElement('script');
  script.src='https://www.youtube.com/iframe_api';
  script.async=true;
  script.dataset.toolifyYoutubeApi='true';
  script.onerror=()=>{
    musicMessage('YouTube player API could not be loaded. Check your internet connection.',true);
  };
  document.head.appendChild(script);
}

function createYouTubePlayer(){
  if(musicYoutubePlayer || !window.YT?.Player) return;
  const playerVars={autoplay:1,controls:0,playsinline:1,rel:0,enablejsapi:1};
  if(/^https?:$/.test(location.protocol)) playerVars.origin=location.origin;
  musicYoutubePlayer=new window.YT.Player('music-youtube-player',{
    width:320,height:200,videoId:musicYoutubePendingId||undefined,playerVars,host:'https://www.youtube-nocookie.com',
    events:{
      onReady:()=>{
        musicYoutubeReady=true;
        musicYoutubePlayer.setVolume(Number(getMusicSettings().volume??75));
        if(musicYoutubePendingId) musicYoutubePlayer.loadVideoById(musicYoutubePendingId);
      },
      onStateChange:event=>{
        const state=window.YT.PlayerState;
        if(event.data===state.PLAYING){
          document.getElementById('music-playback-state').textContent='PLAYING';
          document.getElementById('music-time-total').textContent=formatMusicTime(musicYoutubePlayer.getDuration());
          startMusicProgressTimer();
        }else if(event.data===state.PAUSED){
          document.getElementById('music-playback-state').textContent='PAUSED';
        }else if(event.data===state.ENDED){
          advanceMusic();
        }else if(event.data===state.BUFFERING){
          document.getElementById('music-playback-state').textContent='BUFFERING';
        }
        updateMusicControls();
      },
      onAutoplayBlocked:()=>{
        document.getElementById('music-playback-state').textContent='PAUSED';
        musicMessage('Playback was blocked by the browser. Press play in the player to start.');
      },
      onError:event=>{
        const track=findMusicTrack(musicQueue[currentMusicTrack]);
        if(track) handleUnavailableSong(track,event.data);
      }
    }
  });
}

function getMusicPlayerElement(){
  const track=findMusicTrack(musicQueue[currentMusicTrack]);
  return track?.mediaType==='video'?document.getElementById('music-video'):document.getElementById('music-audio');
}

function updateMusicControls(){
  const track=findMusicTrack(musicQueue[currentMusicTrack]);
  const playerState=track?.youtubeId?(musicYoutubeReady?musicYoutubePlayer.getPlayerState():-1):getMusicPlayerElement()?.paused?2:1;
  const isPlaying=playerState===1;
  const playButton=document.getElementById('music-play-pause');
  playButton.textContent=isPlaying?'Ⅱ':'▶';
  playButton.title=isPlaying?'Pause':'Play';
  playButton.setAttribute('aria-label',isPlaying?'Pause':'Play');
  const videoButton=document.getElementById('music-video-toggle');
  const videoVisible=document.getElementById('music-video-stage').classList.contains('video-visible');
  const videoAvailable=!!track&&(track.youtubeId||track.mediaType==='video');
  videoButton.disabled=!videoAvailable;
  videoButton.setAttribute('aria-pressed',String(videoVisible));
  videoButton.setAttribute('aria-label',videoVisible?'Hide video':'Show video');
  videoButton.title=videoVisible?'Hide video':'Show video';
}

function toggleMusicVideo(){
  const track=findMusicTrack(musicQueue[currentMusicTrack]);
  if(!track||(!track.youtubeId&&track.mediaType!=='video')) return;
  const stage=document.getElementById('music-video-stage');
  const visible=!stage.classList.contains('video-visible');
  stage.classList.toggle('video-visible',visible);
  document.getElementById('music-youtube-wrap').setAttribute('aria-hidden',String(!visible));
  updateMusicControls();
}

function setMusicVolume(value){
  const volume=Math.max(0,Math.min(100,Math.round(value)));
  getMusicSettings().volume=volume;
  document.getElementById('music-volume').value=String(volume);
  const track=findMusicTrack(musicQueue[currentMusicTrack]);
  if(track?.youtubeId && musicYoutubeReady) musicYoutubePlayer.setVolume(volume);
  else{
    const player=getMusicPlayerElement();
    if(player) player.volume=volume/100;
  }
  updateMusicControls();
}

function seekMusicBy(seconds){
  const track=findMusicTrack(musicQueue[currentMusicTrack]);
  if(track?.youtubeId){
    if(musicYoutubeReady) musicYoutubePlayer.seekTo(Math.max(0,musicYoutubePlayer.getCurrentTime()+seconds),true);
  }else{
    const player=getMusicPlayerElement();
    if(player?.duration) player.currentTime=Math.max(0,Math.min(player.duration,player.currentTime+seconds));
  }
}

function toggleMusicPlayback(){
  if(currentMusicTrack<0){
    if(musicQueue.length) playSong(musicQueue[0],false);
    else if(musicTracks.length) playSong(musicTracks[0].id,true);
    return;
  }
  const track=findMusicTrack(musicQueue[currentMusicTrack]);
  if(track?.youtubeId){
    if(!musicYoutubeReady){musicMessage('YouTube player is still loading. Please wait.');return;}
    if(musicYoutubePlayer.getPlayerState()===1) musicYoutubePlayer.pauseVideo();
    else musicYoutubePlayer.playVideo();
  }else{
    const player=getMusicPlayerElement();
    if(player.paused) player.play().catch(error=>musicMessage('Playback could not start.',true));
    else player.pause();
  }
  updateMusicControls();
}

function advanceMusic(direction=1,forceRepeat=false){
  if(!musicQueue.length) return;
  if(direction<0 && currentMusicTrack<=0){
    const track=findMusicTrack(musicQueue[currentMusicTrack]);
    if(track?.youtubeId && musicYoutubeReady) musicYoutubePlayer.seekTo(0,true);
    else{
      const player=getMusicPlayerElement();
      if(player){player.currentTime=0;player.play().catch(error=>musicMessage('Playback could not restart.',true));}
    }
    return;
  }
  if(musicRepeat==='one' && direction>0 && !forceRepeat){
    const track=findMusicTrack(musicQueue[currentMusicTrack]);
    if(track?.youtubeId && musicYoutubeReady) musicYoutubePlayer.seekTo(0,true);
    else{const player=getMusicPlayerElement();player.currentTime=0;player.play().catch(error=>musicMessage('Playback could not restart.',true));}
    return;
  }
  let next=currentMusicTrack+direction;
  if(musicShuffle && direction>0 && musicQueue.length>1){
    const choices=musicQueue.map((_,index)=>index).filter(index=>index!==currentMusicTrack);
    next=choices[Math.floor(Math.random()*choices.length)];
  }else if(musicRepeat==='all'){
    next=(next+musicQueue.length)%musicQueue.length;
  }
  if(next<0 || next>=musicQueue.length){
    stopMusicPlayback();
    return;
  }
  currentMusicTrack=next;
  playCurrentMusicTrack();
}

function stopMusicPlayback(){
  document.getElementById('music-audio').pause();
  document.getElementById('music-video').pause();
  document.getElementById('music-video-stage').classList.remove('video-visible');
  musicYoutubePendingId=null;
  if(musicYoutubePlayer && musicYoutubeReady) musicYoutubePlayer.pauseVideo();
  currentMusicTrack=-1;
  document.getElementById('music-playback-state').textContent='READY';
  document.getElementById('music-video-toggle').setAttribute('aria-pressed','false');
  document.getElementById('music-video-toggle').setAttribute('aria-label','Show video');
  updateMusicControls();
  renderMusicQueue();
}

function formatMusicTime(seconds){
  if(!Number.isFinite(seconds)||seconds<0) return '0:00';
  const mins=Math.floor(seconds/60);
  return `${mins}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
}

function updateMusicProgress(current,duration){
  document.getElementById('music-time-current').textContent=formatMusicTime(current);
  document.getElementById('music-time-total').textContent=formatMusicTime(duration);
  const seek=document.getElementById('music-seek');
  seek.value=duration>0?String(Math.round(current/duration*1000)):'0';
}

function startMusicProgressTimer(){
  clearInterval(musicProgressTimer);
  musicProgressTimer=window.setInterval(()=>{
    const track=findMusicTrack(musicQueue[currentMusicTrack]);
    if(track?.youtubeId && musicYoutubeReady) updateMusicProgress(musicYoutubePlayer.getCurrentTime(),musicYoutubePlayer.getDuration());
    else{
      const player=getMusicPlayerElement();
      if(player?.duration) updateMusicProgress(player.currentTime,player.duration);
    }
  },500);
}

function setupMusicEqualizer(player){
  if(!window.AudioContext && !window.webkitAudioContext) return;
  try{
    if(!player._toolifyEqualizer){
      const AudioContextConstructor=window.AudioContext||window.webkitAudioContext;
      musicAudioContext=musicAudioContext||new AudioContextConstructor();
      const source=musicAudioContext.createMediaElementSource(player);
      const filters=[
        musicAudioContext.createBiquadFilter(),musicAudioContext.createBiquadFilter(),musicAudioContext.createBiquadFilter()
      ];
      filters[0].type='lowshelf';filters[0].frequency.value=250;
      filters[1].type='peaking';filters[1].frequency.value=1000;filters[1].Q.value=1;
      filters[2].type='highshelf';filters[2].frequency.value=4000;
      source.connect(filters[0]);filters[0].connect(filters[1]);filters[1].connect(filters[2]);filters[2].connect(musicAudioContext.destination);
      player._toolifyEqualizer=filters;
    }
    musicEqFilters=player._toolifyEqualizer;
    applyMusicEqualizer();
  }catch(error){
    console.error('Could not initialize the music equalizer:',error);
    musicMessage('The equalizer is not supported for this media in your browser.',true);
  }
}

function applyMusicEqualizer(){
  if(!musicEqFilters) return;
  const values=Array.from(document.querySelectorAll('[data-eq]')).map(input=>Number(input.value));
  musicEqFilters.forEach((filter,index)=>{filter.gain.value=values[index]||0;});
  getMusicSettings().equalizer=values;
}

async function removeMusicSong(id){
  const track=findMusicTrack(id);
  if(!track) return;
  if(track.cloudPath&&currentUser&&supabaseClient){
    const {error}=await supabaseClient.storage.from(MUSIC_STORAGE_BUCKET).remove([track.cloudPath]);
    if(error){musicPersistenceError(error);return;}
  }
  if(track.localFile && track.url) URL.revokeObjectURL(track.url);
  musicTracks=musicTracks.filter(item=>item.id!==id);
  const removedIndex=musicQueue.indexOf(id);
  musicQueue=musicQueue.filter(item=>item!==id);
  if(currentMusicTrack===removedIndex){
    if(musicQueue.length) playSong(musicQueue[Math.min(removedIndex,musicQueue.length-1)],false);
    else stopMusicPlayback();
  }else if(removedIndex>=0 && removedIndex<currentMusicTrack) currentMusicTrack--;
  try{
    if(track.localFile) await DB.deleteMusicFile(id);
    await saveMusicState();
    renderMusicLibrary();
    renderMusicQueue();
  }catch(error){musicPersistenceError(error);}
}

function getYoutubeApiKey(){
  return localStorage.getItem(musicStorageKey('youtube-api-key'))||'';
}

async function youtubeDataRequest(resource,params){
  const key=getYoutubeApiKey();
  if(!key) throw new Error('Add a YouTube Data API v3 key in Music settings to use this feature.');
  const query=new URLSearchParams({...params,key});
  const response=await fetch(`https://www.googleapis.com/youtube/v3/${resource}?${query}`);
  const result=await response.json();
  if(!response.ok) throw new Error(result.error?.message||'YouTube API request failed.');
  return result;
}

async function checkYoutubeAvailability(tracks=musicTracks.filter(track=>track.youtubeId)){
  if(!getYoutubeApiKey()){musicMessage('Save your YouTube Data API key in Music settings first.',true);return;}
  try{
    let checked=0;
    for(let offset=0;offset<tracks.length;offset+=50){
      const batch=tracks.slice(offset,offset+50);
      const result=await youtubeDataRequest('videos',{part:'status',id:batch.map(track=>track.youtubeId).join(','),fields:'items(id,status(embeddable))'});
      const available=new Map((result.items||[]).map(item=>[item.id,item.status?.embeddable===true]));
      batch.forEach(track=>{track.unavailable=!available.get(track.youtubeId);});
      checked+=batch.length;
      document.getElementById('music-status').textContent=`Checked ${checked}/${tracks.length} songs…`;
    }
    await saveMusicState();renderMusicLibrary();
    musicMessage(`Checked ${tracks.length} songs. ${tracks.filter(track=>track.unavailable).length} unavailable.`);
  }catch(error){console.error('YouTube availability check failed:',error);musicMessage(error.message||'Could not check song availability.',true);}
}

async function findYoutubeAlternate(track){
  const search=await youtubeDataRequest('search',{part:'snippet',type:'video',videoEmbeddable:'true',maxResults:'5',q:`${track.title} ${track.artist||''}`.trim()});
  const candidates=(search.items||[]).map(item=>item.id?.videoId).filter(Boolean);
  if(!candidates.length) return false;
  const details=await youtubeDataRequest('videos',{part:'status,snippet',id:candidates.join(','),fields:'items(id,status(embeddable),snippet(title,channelTitle,thumbnails(high(url)))))'});
  const alternate=details.items?.find(item=>item.status?.embeddable);
  if(!alternate) return false;
  track.originalYoutubeId=track.originalYoutubeId||track.youtubeId;
  track.youtubeId=alternate.id;
  track.unavailable=false;
  track.isAlternate=true;
  track.thumbnail=alternate.snippet?.thumbnails?.high?.url||`https://i.ytimg.com/vi/${alternate.id}/hqdefault.jpg`;
  return true;
}

async function findYoutubeAlternates(tracks=musicTracks.filter(track=>track.unavailable&&track.youtubeId)){
  if(!getYoutubeApiKey()){musicMessage('Save your YouTube Data API v3 key in Music settings first.',true);return;}
  let found=0;
  try{
    for(let index=0;index<tracks.length;index++){
      const track=tracks[index];
      document.getElementById('music-status').textContent=`Searching alternates ${index+1}/${tracks.length}…`;
      if(await findYoutubeAlternate(track)) found++;
    }
    await saveMusicState();renderMusicLibrary();
    musicMessage(`Found ${found} embeddable alternate${found===1?'':'s'}.`);
  }catch(error){console.error('Could not find YouTube alternates:',error);musicMessage(error.message||'Could not find alternate videos.',true);}
}

async function handleUnavailableSong(track,code){
  track.unavailable=true;
  track.unavailableReason=`YouTube player error ${code}`;
  try{
    await saveMusicState();
    if(getYoutubeApiKey()){
      try{
        if(await findYoutubeAlternate(track)){
          await saveMusicState();
          musicMessage(`Playing an alternate upload for “${track.title}”.`);
          playCurrentMusicTrack();
          return;
        }
      }catch(error){console.error('Automatic alternate search failed:',error);}
    }
    renderMusicLibrary();
    musicMessage(`“${track.title}” is unavailable in the embedded player; skipping it.`,true);
    advanceMusic(1,true);
  }catch(error){musicPersistenceError(error);}
}

function setRightPanel(panelName,forceOpen=false){
  const dock = document.querySelector('.quick-tools');
  const isMobile = window.matchMedia('(max-width: 860px)').matches;
  const activeTab = document.querySelector('.quick-tools-tab.active');
  const wasSamePanel = activeTab?.dataset.rightPanel === panelName;
  const mobilePanelOpen = dock.classList.contains('mobile-panel-open');
  const closeMobilePanel = !forceOpen && isMobile && wasSamePanel && mobilePanelOpen;
  dock.classList.toggle('mobile-panel-open', isMobile && !closeMobilePanel);
  document.querySelectorAll('.quick-tools-tab').forEach(button=>{
    const isActive = button.dataset.rightPanel === panelName;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive && !closeMobilePanel));
  });
  document.getElementById('right-home-panel').hidden = panelName !== 'home' || closeMobilePanel;
  document.getElementById('music-player').hidden = panelName !== 'music' || closeMobilePanel;
  document.getElementById('notes-panel').hidden = panelName !== 'notes' || closeMobilePanel;
  if(panelName==='music'&&!closeMobilePanel) loadYouTubePlayer(true);
}

function renderWorkspaceOverview(){
  const toolCount = document.getElementById('workspace-tool-count');
  const favoriteCount = document.getElementById('workspace-favorite-count');
  if(toolCount) toolCount.textContent = String(State.tools.length);
  if(favoriteCount) favoriteCount.textContent = String(State.tools.filter(tool=>tool.favorite).length);
}

function renderQuickNotes(){
  const list = document.getElementById('quick-notes-list');
  if(!list) return;
  list.innerHTML = notesList().length
    ? notesList().slice().reverse().map(note=>`<div class="quick-note-item" role="button" tabindex="0" data-load-note="${escapeHTML(note.id)}">${escapeHTML(note.text)}<button class="quick-note-delete" type="button" data-delete-note="${escapeHTML(note.id)}" aria-label="Delete note">&times;</button></div>`).join('')
    : '<div class="quick-note-empty">No saved notes yet.</div>';
  list.querySelectorAll('[data-load-note]').forEach(item=>{
    const loadNote = ()=>{
      const note = notesList().find(savedNote=>savedNote.id === item.dataset.loadNote);
      if(!note) return;
      const input = document.getElementById('quick-note-input');
      input.value = note.text;
      input.focus();
    };
    item.addEventListener('click', loadNote);
    item.addEventListener('keydown', event=>{
      if(event.key === 'Enter' || event.key === ' '){
        event.preventDefault();
        loadNote();
      }
    });
  });
  list.querySelectorAll('[data-delete-note]').forEach(button=>{
    button.addEventListener('keydown', event=>event.stopPropagation());
    button.addEventListener('click', async (event)=>{
      event.stopPropagation();
      State.settings.notes = notesList().filter(note=>note.id !== button.dataset.deleteNote);
      await persistSettings();
      renderQuickNotes();
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
function toast(msg, type, duration=2600){
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
  }, duration);
}

function featureAnnouncementStorageKey(){
  return `toolify-feature-announcement-dismissed-${currentUser?.id||'anonymous'}`;
}

function showFeatureAnnouncement(){
  const announcement = document.getElementById('feature-announcement');
  if(!announcement) return;
  announcement.hidden=localStorage.getItem(featureAnnouncementStorageKey())==='dismissed';
}

function dismissFeatureAnnouncement(){
  const announcement=document.getElementById('feature-announcement');
  if(announcement) announcement.hidden=true;
  localStorage.setItem(featureAnnouncementStorageKey(),'dismissed');
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
  const root=document.documentElement;
  root.setAttribute('data-theme', mode);
  const palette=MUSIC_THEMES[State.settings.colorTheme]?MUSIC_THEMES[State.settings.colorTheme]:MUSIC_THEMES.classic;
  root.dataset.palette=MUSIC_THEMES[State.settings.colorTheme]?State.settings.colorTheme:'classic';
  const accent=/^#[\da-f]{6}$/i.test(State.settings.customAccent||'')?State.settings.customAccent:palette.accent;
  root.style.setProperty('--accent',accent);
  root.style.setProperty('--accent-strong',accent);
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
    panel.innerHTML = `
      <h3>Sidebar</h3>
      <div class="panel-sub">Use the right sidebar to check your workspace, play music from files or folders, add YouTube links, and open your saved notes.</div>
    `;
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
      <div class="panel-sub">Choose a mode and color palette for the whole app.</div>
      <div class="settings-row">
        <div><div class="settings-row-label">Theme</div><div class="settings-row-desc">System follows your OS preference.</div></div>
        <div class="theme-picker" id="theme-picker">
          <button class="theme-opt" data-theme="dark">Dark</button>
          <button class="theme-opt" data-theme="light">Light</button>
          <button class="theme-opt" data-theme="system">System</button>
        </div>
      </div>
      <div class="settings-block">
        <div class="settings-row-label">Color palette</div>
        <div class="panel-sub">Changes the colors across the entire Toolify interface.</div>
        <div class="app-palette-picker" id="app-palette-picker">
          ${Object.entries(MUSIC_THEMES).map(([name,palette])=>`<button type="button" class="app-palette-option" data-palette="${name}" aria-label="${name} palette" title="${name}"><span style="--palette-swatch:${palette.accent}"></span><small>${name}</small></button>`).join('')}
        </div>
        <label class="app-custom-accent">Custom accent <input type="color" id="app-custom-accent" aria-label="Custom accent color"></label>
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
    const accentInput=document.getElementById('app-custom-accent');
    accentInput.value=/^#[\da-f]{6}$/i.test(State.settings.customAccent||'')?State.settings.customAccent:MUSIC_THEMES[State.settings.colorTheme||'classic'].accent;
    panel.querySelectorAll('.app-palette-option').forEach(button=>{
      button.classList.toggle('active',button.dataset.palette===(State.settings.colorTheme||'classic')&&!State.settings.customAccent);
      button.addEventListener('click',async()=>{
        State.settings.colorTheme=button.dataset.palette;
        State.settings.customAccent='';
        applyTheme();
        await persistSettings();
        renderSettingsPanel('appearance');
      });
    });
    accentInput.addEventListener('input',()=>{
      State.settings.customAccent=accentInput.value;
      applyTheme();
    });
    accentInput.addEventListener('change',()=>persistSettings().catch(error=>{
      console.error('Could not save appearance settings:',error);
      toast('Could not save appearance settings.','error');
    }));
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

  else if(panelName === 'report'){
    panel.innerHTML = `
      <h3>Report a Bug</h3>
      <div class="panel-sub">Tell us what went wrong so we can improve Toolify.</div>
      <form class="report-form" id="bug-report-form">
        <div class="field">
          <label class="field-label" for="bug-name">Name</label>
          <input class="field-input" id="bug-name" name="name" autocomplete="name" value="${escapeHTML(currentUser?.user_metadata?.full_name || '')}" placeholder="Your name">
        </div>
        <div class="field">
          <label class="field-label" for="bug-email">Email</label>
          <input class="field-input" id="bug-email" name="email" type="email" autocomplete="email" value="${escapeHTML(currentUser?.email || '')}" required placeholder="you@example.com">
        </div>
        <div class="field">
          <label class="field-label" for="bug-type">Issue type</label>
          <select class="field-select" id="bug-type" name="issue_type">
            <option value="Bug">Bug</option>
            <option value="Interface problem">Interface problem</option>
            <option value="Feature request">Feature request</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="bug-message">What happened?</label>
          <textarea class="field-textarea" id="bug-message" name="message" required minlength="10" maxlength="3000" placeholder="Describe the problem, what you expected, and the steps to reproduce it..."></textarea>
        </div>
        <input type="hidden" name="_subject" value="Toolify Bug Report">
        <input type="hidden" name="_template" value="table">
        <input type="hidden" name="_captcha" value="false">
        <input type="hidden" name="app_version" value="${escapeHTML(APP_VERSION)}">
        <button class="btn btn-solid" id="bug-report-submit" type="submit">Send Report</button>
      </form>
    `;

    document.getElementById('bug-report-form').addEventListener('submit', async event=>{
      event.preventDefault();
      const form = event.currentTarget;
      if(!form.reportValidity()) return;
      const button = document.getElementById('bug-report-submit');
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = 'Sending…';
      try{
        const response = await fetch('https://formsubmit.co/ajax/tahaamin.dev@gmail.com',{
          method:'POST',
          headers:{'Content-Type':'application/json','Accept':'application/json'},
          body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))
        });
        const result = await response.json().catch(()=>null);
        if(!response.ok || result?.success === false) throw new Error(result?.message || 'Could not send the report.');
        form.reset();
        if(currentUser?.email) document.getElementById('bug-email').value = currentUser.email;
        toast('Bug report sent successfully.');
      }catch(error){
        toast(error.message || 'Could not send the report.', 'error');
      }finally{
        button.disabled = false;
        button.textContent = originalText;
      }
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
  document.getElementById('feature-announcement-dismiss').addEventListener('click',dismissFeatureAnnouncement);
  document.getElementById('feature-theme-button').addEventListener('click',()=>{
    openSettings('appearance');
    dismissFeatureAnnouncement();
  });
  document.getElementById('feature-music-button').addEventListener('click',()=>{
    setRightPanel('music',true);
    dismissFeatureAnnouncement();
  });
  document.querySelectorAll('.quick-tools-tab').forEach(button=>{
    button.addEventListener('click', ()=>setRightPanel(button.dataset.rightPanel));
  });
  document.querySelectorAll('[data-music-action]').forEach(button=>{
    button.addEventListener('click',()=>{
      const action=button.dataset.musicAction;
      if(action==='add') showMusicForm('add');
      if(action==='cancel-form') showMusicForm('');
    });
  });
  document.getElementById('music-file-input').addEventListener('change',event=>{
    loadMusicFiles(event.currentTarget.files);
    event.currentTarget.value='';
  });
  document.getElementById('music-folder-input').addEventListener('change',event=>{
    loadMusicFiles(event.currentTarget.files);
    event.currentTarget.value='';
  });
  document.getElementById('music-save-song').addEventListener('click',saveMusicSong);
  document.getElementById('music-search').addEventListener('input',renderMusicLibrary);
  document.getElementById('music-previous').addEventListener('click',()=>advanceMusic(-1,true));
  document.getElementById('music-next').addEventListener('click',()=>advanceMusic(1,true));
  document.getElementById('music-play-pause').addEventListener('click',toggleMusicPlayback);
  document.getElementById('music-stop').addEventListener('click',stopMusicPlayback);
  document.getElementById('music-video-toggle').addEventListener('click',toggleMusicVideo);
  document.getElementById('music-volume').addEventListener('input',event=>setMusicVolume(Number(event.currentTarget.value)));
  document.getElementById('music-volume').addEventListener('change',()=>saveMusicState().catch(error=>musicPersistenceError(error)));
  document.getElementById('music-seek').addEventListener('input',event=>{
    const track=findMusicTrack(musicQueue[currentMusicTrack]);
    const fraction=Number(event.currentTarget.value)/1000;
    if(track?.youtubeId){
      if(musicYoutubeReady){
        const duration=musicYoutubePlayer.getDuration();
        if(duration) musicYoutubePlayer.seekTo(duration*fraction,true);
      }
    }else{
      const player=getMusicPlayerElement();
      if(player?.duration) player.currentTime=player.duration*fraction;
    }
  });
  [document.getElementById('music-audio'),document.getElementById('music-video')].forEach(player=>{
    player.addEventListener('ended',()=>advanceMusic());
    player.addEventListener('timeupdate',()=>updateMusicProgress(player.currentTime,player.duration));
    player.addEventListener('play',()=>{document.getElementById('music-playback-state').textContent='PLAYING';updateMusicControls();startMusicProgressTimer();});
    player.addEventListener('pause',()=>{document.getElementById('music-playback-state').textContent='PAUSED';updateMusicControls();});
    player.addEventListener('loadedmetadata',()=>updateMusicProgress(0,player.duration));
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){
      if(!document.getElementById('music-song-form').hidden){showMusicForm('');return;}
    }
    if(document.getElementById('music-player').hidden||document.querySelector('.overlay.open')) return;
    if(event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
    if(event.code==='Space'){event.preventDefault();toggleMusicPlayback();}
    else if(event.key==='ArrowUp'){event.preventDefault();setMusicVolume(Math.min(100,Number(getMusicSettings().volume??75)+5));saveMusicState().catch(error=>musicPersistenceError(error));}
    else if(event.key==='ArrowDown'){event.preventDefault();setMusicVolume(Math.max(0,Number(getMusicSettings().volume??75)-5));saveMusicState().catch(error=>musicPersistenceError(error));}
    else if(event.key==='ArrowRight') seekMusicBy(5);
    else if(event.key==='ArrowLeft') seekMusicBy(-5);
  });
  window.addEventListener('beforeunload', ()=>{
    musicTracks.forEach(track=>{
      if(track.url) URL.revokeObjectURL(track.url);
    });
  });
  document.getElementById('settings-close').addEventListener('click', ()=>document.getElementById('settings-overlay').classList.remove('open'));
  document.getElementById('settings-overlay').addEventListener('click', (e)=>{ if(e.target.id==='settings-overlay') document.getElementById('settings-overlay').classList.remove('open'); });
  document.querySelectorAll('.settings-nav-item').forEach(b=>b.addEventListener('click', ()=>renderSettingsPanel(b.dataset.panel)));

  document.getElementById('tool-context-menu').addEventListener('click', async (event)=>{
    const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
    if(!action || !contextMenuTarget) return;
    const tool = contextMenuTarget;
    hideToolContextMenu();
    if(action === 'open') openTool(tool);
    if(action === 'edit') openToolModal(tool.id);
    if(action === 'favorite'){ tool.favorite = !tool.favorite; await persistTool(tool); render(); toast(tool.favorite ? 'Added to Favorites.' : 'Removed from Favorites.'); }
    if(action === 'delete') confirmDeleteTool(tool.id);
  });
  document.addEventListener('click', (event)=>{
    if(!event.target.closest('#tool-context-menu')) hideToolContextMenu();
  });
  if(!wireEvents.contextMenuWired){
    document.addEventListener('contextmenu', event=>{
      const card = event.target.closest('.tool-card');
      if(!card){
        hideToolContextMenu();
        return;
      }
      event.preventDefault();
      const tool = State.tools.find(item=>item.id === card.dataset.id);
      if(tool) showToolContextMenu(event.clientX, event.clientY, tool);
    });
    wireEvents.contextMenuWired = true;
  }

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
async function showAuthenticatedApp(user){
  if(currentUser && currentUser.id===user.id) return;
  currentUser=user;
  State.tools=[];
  State.categories=[];
  State.settings={theme:'dark',view:'grid',sort:'recent',lastBackupAt:null,landing:'auto',clickSound:'click',quickTools:undefined,notes:[]};
  libraryLoading=true;
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('mac-signout').title=user.email||'Sign out';
  render();
  try{
    await DB.open();
    await initAppData();
    showFeatureAnnouncement();
    try{
      await DB.syncForUser(user);
      const [tools,categories,settingsRows]=await Promise.all([DB.getAll('tools'),DB.getAll('categories'),DB.getAll('settings')]);
      State.tools=tools;
      State.categories=categories;
      const saved=settingsRows.find(row=>row.key==='app');
      if(saved) Object.assign(State.settings,saved.value);
      libraryLoading=false;
      applyTheme();
      render();
    }catch(error){
      console.error('Cloud sync failed:',error);
      libraryLoading=false;
      render();
      toast('Offline: showing saved library','error');
    }
  }catch(error){
    libraryLoading=false;
    render();
    console.error(error);
    authMessage('Could not open your library: '+(error.message||'Please try again.'),true);
    document.getElementById('auth-screen').style.display='flex';
    document.getElementById('app').style.display='none';
  }
}
async function initAppData(){try{const [tools,categories,settingsRows]=await Promise.all([DB.getAll('tools'),DB.getAll('categories'),DB.getAll('settings')]);State.tools=tools;State.categories=categories;const saved=settingsRows.find(r=>r.key==='app');if(saved)Object.assign(State.settings,saved.value);}catch(e){toast('Could not load saved data','error');}ensureUncategorized();const ids=new Set(State.categories.map(c=>c.id));let fixed=false;State.tools.forEach(t=>{if(!ids.has(t.categoryId)){t.categoryId=UNCATEGORIZED_ID;fixed=true;}});if(fixed)await DB.bulkPut('tools',State.tools);if(!State.categories.length)ensureUncategorized();await DB.bulkPut('categories',State.categories);applyTheme();musicSettingsRef=null;State.ui.activeNav=State.tools.some(t=>t.favorite)?'favorites':'all';wireEvents();render();}
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
  currentUser=null;
  document.getElementById('app').style.display='none';
  document.getElementById('auth-screen').style.display='flex';
  setAuthMode('login');
  const signOutPromise=supabaseClient.auth.signOut({scope:'global'});
  DB.clearLocal().catch(()=>{});
  const {error}=await signOutPromise;
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
