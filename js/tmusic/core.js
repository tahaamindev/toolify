/* ============================================================
   T MUSIC for Toolify — core
   State, helpers, local storage, snapshots and v4 backup I/O.
   Classic script (no ES modules), namespace: window.TM
   ============================================================ */
(function () {
  'use strict';
  const TM = window.TM = window.TM || {};
  const KEY = 'echovault-organized-v2';
  const SNAP = 'tmusic-auto-backup-v1';
  const PAGE = 60;

  TM.PAGE = PAGE;
  TM.S = {
    songs: [], playlists: [], queue: [], current: null,
    view: 'home', pl: null, limit: PAGE,
    shuffle: false, repeat: false, muted: false,
    audioOnly: true, dashboardSource: 'all',
    theme: 'silver', customAccent: '',
    volume: 75, speed: 1
  };
  TM.M = new Map();
  TM.ref = null;

  const $ = TM.$ = id => document.getElementById(id);
  TM.esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
  TM.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  TM.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  TM.fmt = n => (!Number.isFinite(n) || n < 0)
    ? '0:00'
    : Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0');

  TM.toast = function (message, isError) {
    if (typeof window.toast === 'function') {
      window.toast(message, isError ? 'error' : 'success');
      return;
    }
    const box = $('tm-toast');
    if (!box) return;
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(TM._toastTimer);
    TM._toastTimer = setTimeout(() => box.classList.remove('show'), 3200);
  };

  TM.videoId = function (raw) {
    try {
      const url = new URL(String(raw || '').trim());
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      let id = '';
      if (host === 'youtu.be') {
        id = url.pathname.split('/').filter(Boolean)[0] || '';
      } else if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
        if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
        else {
          const parts = url.pathname.split('/').filter(Boolean);
          const at = parts.findIndex(part => ['embed', 'shorts', 'live', 'v'].includes(part));
          if (at >= 0) id = parts[at + 1] || '';
        }
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    } catch (error) {
      return null;
    }
  };

  TM.vidOf = song => song && (song.v || (song.v = TM.videoId(song.url)));
  TM.songBy = id => TM.M.get(id);
  TM.reindex = () => { TM.M = new Map(TM.S.songs.map(song => [song.id, song])); };
  TM.cleanQueue = function () {
    const seen = new Set();
    TM.S.queue = TM.S.queue.filter(id => TM.M.has(id) && !seen.has(id) && seen.add(id));
  };

  TM.playable = function (song) {
    if (!song) return false;
    const p = TM.player || {};
    return !song.bad || !!song.alt || (!!p.key && !song.altFail && !p.quotaOut);
  };

  TM.dashboardSongs = function () {
    let songs = TM.S.songs.slice();
    if (TM.S.dashboardSource === 'favorites') songs = songs.filter(song => song.favorite);
    else if (String(TM.S.dashboardSource).startsWith('playlist:')) {
      const id = TM.S.dashboardSource.slice(9);
      songs = songs.filter(song => song.playlistId === id);
    }
    const order = new Map(TM.S.queue.map((id, index) => [id, index]));
    return songs.sort((a, b) => (order.get(a.id) ?? 999999) - (order.get(b.id) ?? 999999));
  };

  TM.listData = function () {
    const query = ($('tm-search')?.value || '').trim().toLowerCase();
    let songs;
    if (TM.S.view === 'home') songs = TM.dashboardSongs();
    else {
      songs = TM.S.songs.slice();
      if (TM.S.view === 'favorites') songs = songs.filter(song => song.favorite);
      if (TM.S.view === 'playlist') songs = songs.filter(song => song.playlistId === TM.S.pl);
    }
    if (query) songs = songs.filter(song => (song.title + ' ' + (song.artist || '')).toLowerCase().includes(query));
    return songs;
  };

  /* ---------- persistence ---------- */

  function settings() {
    if (!State.settings.music || typeof State.settings.music !== 'object') {
      State.settings.music = { tracks: [], playlists: [], queue: [], theme: 'silver', customAccent: '', volume: 75, speed: 1 };
    }
    const music = State.settings.music;
    if (!music.tm || typeof music.tm !== 'object') {
      music.tm = { songs: [], playlists: [], queue: [], audioOnly: true, dashboardSource: 'all', theme: 'silver', customAccent: '' };
    }
    ['songs', 'playlists', 'queue'].forEach(key => {
      if (!Array.isArray(music.tm[key])) music.tm[key] = [];
    });
    return music;
  }
  TM.settings = settings;

  function snapshot() {
    const app = $('tm-app');
    return {
      songs: TM.S.songs,
      playlists: TM.S.playlists,
      queue: TM.S.queue,
      audioOnly: TM.S.audioOnly,
      dashboardSource: TM.S.dashboardSource,
      theme: TM.S.theme || app?.dataset.tmTheme || 'silver',
      customAccent: TM.S.customAccent || '',
      savedAt: new Date().toISOString()
    };
  }
  TM.snapshot = snapshot;

  let saveTimer = null;
  function flush() {
    try {
      const data = snapshot();
      const music = settings();
      Object.assign(music.tm, JSON.parse(JSON.stringify(data)));
      music.volume = TM.S.volume;
      music.speed = TM.S.speed;
      localStorage.setItem(KEY, JSON.stringify(data));
      localStorage.setItem(SNAP, JSON.stringify(data));
      if (typeof persistSettings === 'function') persistSettings().catch(() => {});
      const status = $('tm-auto-status');
      if (status) status.textContent = 'Automatic snapshot saved locally · ' + new Date().toLocaleString();
    } catch (error) {
      console.error('T Music save failed:', error);
      TM.toast('Could not save locally. Export a backup.', true);
    }
  }
  TM.flush = flush;
  TM.save = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
  };
  window.addEventListener('pagehide', flush);

  function normalizeSong(raw) {
    if (!raw || !raw.url) return null;
    const id = TM.videoId(raw.url);
    if (!id) return null;
    const song = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : TM.uid(),
      url: 'https://www.youtube.com/watch?v=' + id,
      title: String(raw.title || 'YouTube video · ' + id),
      artist: String(raw.artist || ''),
      playlistId: raw.playlistId || '',
      favorite: !!raw.favorite,
      addedAt: raw.addedAt || new Date().toISOString()
    };
    if (raw.auto) song.auto = 1;
    if (raw.bad) song.bad = raw.bad;
    if (raw.alt) song.alt = raw.alt;
    if (raw.altFail) song.altFail = true;
    return song;
  }
  TM.normalizeSong = normalizeSong;

  function readLocal(key) {
    try {
      const data = JSON.parse(localStorage.getItem(key) || 'null');
      return data && Array.isArray(data.songs) ? data : null;
    } catch (error) {
      return null;
    }
  }

  TM.load = function (force) {
    const music = settings();
    if (!force && TM.ref === music.tm) return false;
    TM.ref = music.tm;

    let data = music.tm;
    if (!Array.isArray(data.songs) || !data.songs.length) {
      data = readLocal(KEY) || readLocal(SNAP) || data;
    }

    TM.S.songs = (Array.isArray(data.songs) ? data.songs : []).map(normalizeSong).filter(Boolean);
    TM.S.playlists = Array.isArray(data.playlists)
      ? data.playlists.filter(p => p && p.id && p.name).map(p => ({ id: p.id, name: String(p.name) }))
      : [];
    TM.S.queue = Array.isArray(data.queue) ? data.queue.slice() : [];
    TM.S.audioOnly = data.audioOnly !== false;
    TM.S.dashboardSource = data.dashboardSource || 'all';
    TM.S.theme = data.theme || 'silver';
    TM.S.customAccent = data.customAccent || '';
    TM.S.volume = Math.max(0, Math.min(100, Number(music.volume ?? 75)));
    TM.S.speed = Number(music.speed) || 1;
    TM.S.current = null;
    TM.reindex();
    TM.cleanQueue();
    if (TM.ui?.applyTheme) TM.ui.applyTheme();
    return true;
  };

  TM.sync = function () {
    TM.load(false);
    if (TM.ui?.render) TM.ui.render();
  };
  TM.resetRef = function () {
    TM.load(true);
    if (TM.ui?.render) TM.ui.render();
  };

  /* ---------- backup files (T Music v4 format) ---------- */

  TM.exportBackup = function () {
    flush();
    const data = {
      app: 'T Music',
      version: 4,
      exportedAt: new Date().toISOString(),
      songs: TM.S.songs,
      playlists: TM.S.playlists,
      queue: TM.S.queue,
      audioOnly: TM.S.audioOnly,
      dashboardSource: TM.S.dashboardSource,
      theme: TM.S.theme
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'tmusic-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    TM.toast('Backup exported: ' + data.songs.length + ' songs.');
  };

  TM.importBackup = function (raw) {
    const data = Array.isArray(raw) ? { songs: raw } : raw;
    const songs = (Array.isArray(data?.songs) ? data.songs : []).map(normalizeSong).filter(Boolean);
    if (!songs.length) throw new Error('No valid songs found in this backup.');

    const existingVideos = new Set(TM.S.songs.map(song => TM.vidOf(song)).filter(Boolean));
    const existingIds = new Set(TM.S.songs.map(song => song.id));
    const imported = [];
    songs.forEach(song => {
      const video = TM.videoId(song.url);
      if (!video || existingVideos.has(video)) return;
      let id = song.id && !existingIds.has(song.id) ? song.id : TM.uid();
      while (existingIds.has(id)) id = TM.uid();
      existingIds.add(id);
      existingVideos.add(video);
      imported.push({ ...song, id });
    });

    const playlistMap = new Map(TM.S.playlists.map(p => [String(p.name).toLowerCase(), p.id]));
    (Array.isArray(data.playlists) ? data.playlists : []).forEach(playlist => {
      if (!playlist || !playlist.name) return;
      const key = String(playlist.name).toLowerCase();
      if (playlistMap.has(key)) return;
      const id = playlist.id && !TM.S.playlists.some(p => p.id === playlist.id) ? playlist.id : TM.uid();
      TM.S.playlists.push({ id, name: String(playlist.name) });
      playlistMap.set(key, id);
    });

    TM.S.songs.push(...imported);
    const importedIds = new Set(imported.map(song => song.id));
    const savedQueue = Array.isArray(data.queue) ? data.queue.filter(id => importedIds.has(id)) : [];
    TM.S.queue = [
      ...TM.S.queue,
      ...savedQueue.filter(id => !TM.S.queue.includes(id)),
      ...imported.map(song => song.id).filter(id => !TM.S.queue.includes(id))
    ];
    TM.S.audioOnly = data.audioOnly !== false;
    TM.S.dashboardSource = data.dashboardSource || TM.S.dashboardSource;
    if (data.theme && TM.ui?.setTheme) TM.ui.setTheme(data.theme);

    TM.S.current = null;
    TM.player?.stop?.();
    TM.reindex();
    TM.cleanQueue();
    TM.ui?.updateTrack?.(null);
    flush();
    TM.ui?.render?.();
    TM.player?.enqueueTitles?.(imported.filter(song => song.auto));
    TM.toast('Backup merged: ' + imported.length + ' new song(s) added; duplicates skipped.');
    return imported.length;
  };
})();
