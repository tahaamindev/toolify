/* ============================================================
   TOOLIFY — Music player & library
   Split from the original app.js (behaviour preserved).
   ============================================================ */

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
    const music = getMusicSettings();
    let snapshots = Array.isArray(music.snapshots) ? music.snapshots : [];
    const legacyKey = musicStorageKey('snapshots');
    let migrated = false;
    try{
      const legacy = JSON.parse(localStorage.getItem(legacyKey) || '[]');
      if(Array.isArray(legacy) && legacy.length){
        const known = new Set(snapshots.map(item=>item?.createdAt));
        snapshots = [...legacy.filter(item=>item && !known.has(item.createdAt)), ...snapshots];
        localStorage.removeItem(legacyKey);
        migrated = true;
      }
    }catch(legacyError){}
    snapshots.unshift({createdAt:Date.now(), data:musicSnapshotPayload()});
    music.snapshots = snapshots.slice(0,5);
    if(migrated) window.dispatchEvent(new CustomEvent('toolify:settings-changed'));
    const backupStatus = document.getElementById('music-backup-status');
    if(backupStatus) backupStatus.textContent = `Automatic cloud snapshot saved · ${new Date().toLocaleString()}`;
  }catch(error){
    console.error('Could not create music backup snapshot:', error);
    const backupStatus = document.getElementById('music-backup-status');
    if(backupStatus) backupStatus.textContent = 'Automatic cloud backup could not be saved.';
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
  createMusicSnapshot();
  await persistSettings();
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
function resetMusicSettingsRef(){ musicSettingsRef = null; }
