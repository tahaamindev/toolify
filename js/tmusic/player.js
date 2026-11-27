/* ============================================================
   T MUSIC for Toolify — playback & YouTube services
   IFrame player, transport, availability checks, alternates and
   background title loading. Uses only the TM namespace.
   ============================================================ */
(function () {
  'use strict';
  const TM = window.TM;
  const $ = TM.$;
  const S = TM.S;

  const P = TM.player = {
    p: null, ready: false, pending: null, pv: null, timer: null,
    fails: 0, seeking: false, ending: null, quotaOut: false,
    apiReq: false, key: ''
  };
  try { P.key = localStorage.getItem('tmusic-key') || ''; } catch (error) { P.key = ''; }

  const BADTXT = { embed: 'Embedding disabled by owner', gone: 'Removed or private', err: 'Cannot play' };
  TM.BADTXT = BADTXT;

  function status(text) { const el = $('tm-status'); if (el) el.textContent = text; }
  function stage(text) { const el = $('tm-stage-text'); if (el) el.textContent = text; }
  TM.setStatus = status;
  TM.setStage = stage;

  /* ---------- YouTube Data API (optional key) ---------- */

  async function ytApi(path, params) {
    const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set('key', P.key);
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error((body.error && body.error.message) || 'API error');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  P.ytApi = ytApi;

  async function findAlt(song) {
    if (!P.key || P.quotaOut) return null;
    let query = String(song.title || '').replace(/^YouTube video · .*/, '').trim();
    if (!query) return null;
    if (song.artist && !query.toLowerCase().includes(song.artist.toLowerCase())) query += ' ' + song.artist;
    try {
      const data = await ytApi('search', {
        part: 'snippet', type: 'video', videoEmbeddable: 'true',
        videoSyndicated: 'true', maxResults: 6, q: query
      });
      const original = TM.vidOf(song);
      const item = (data.items || []).find(result => result.id?.videoId && result.id.videoId !== original);
      return item ? item.id.videoId : null;
    } catch (error) {
      if (error.status === 403) {
        P.quotaOut = true;
        TM.toast('YouTube API quota/key problem: ' + error.message, true);
      }
      return null;
    }
  }
  P.findAlt = findAlt;

  function resolveAlt(song, id) {
    status('FINDING AUDIO');
    stage('Original blocks embedding — finding a playable version…');
    findAlt(song).then(video => {
      if (S.current !== id) return;
      if (video) {
        song.alt = video;
        delete song.bad;
        TM.save();
        TM.ui?.renderQueue?.();
        TM.toast('Playing an alternate version of this song.');
        createPlayer(video);
      } else {
        if (!P.quotaOut) song.altFail = true;
        song.bad = song.bad || 'embed';
        TM.save();
        onError({ data: 101 });
      }
    });
  }

  async function titlesViaApi(list, checkAll) {
    const songs = list.filter(song => TM.M.has(song.id));
    try {
      for (let index = 0; index < songs.length; index += 50) {
        const chunk = songs.slice(index, index + 50);
        const data = await ytApi('videos', {
          part: 'snippet,status', id: chunk.map(TM.vidOf).join(','), maxResults: 50
        });
        const info = new Map((data.items || []).map(item => [item.id, item]));
        chunk.forEach(song => {
          const item = info.get(TM.vidOf(song));
          if (!item) {
            song.bad = 'gone';
          } else {
            if (song.auto || (checkAll && !song.title)) {
              song.title = item.snippet.title;
              if (!song.artist) song.artist = item.snippet.channelTitle || '';
            }
            if (item.status.embeddable === false) song.bad = 'embed';
            else if (item.status.privacyStatus === 'private') song.bad = 'gone';
            else {
              delete song.bad;
              delete song.altFail;
              delete song.alt;
            }
          }
          delete song.auto;
        });
        const bg = $('tm-bg');
        if (bg) bg.textContent = 'Checking ' + Math.min(index + 50, songs.length) + '/' + songs.length;
        TM.save();
        TM.ui?.renderQueue?.();
        await TM.sleep(100);
      }
    } catch (error) {
      const bg = $('tm-bg');
      if (bg) bg.textContent = '';
      if (error.status === 403) P.quotaOut = true;
      TM.toast('YouTube API: ' + error.message + ' — using basic mode.', true);
      enqueueTitles(songs.filter(song => song.auto), true);
      return;
    }
    const bg = $('tm-bg');
    if (bg) bg.textContent = '';
    TM.save();
    TM.ui?.render?.();
    if (checkAll) TM.toast('Check complete: ' + S.songs.filter(song => song.bad && !song.alt).length + ' unavailable songs flagged.');
  }
  P.titlesViaApi = titlesViaApi;

  async function oembed(video) {
    try {
      const response = await fetch('https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + video));
      if (response.status === 401) return { bad: 'embed' };
      if (response.status === 404) return { bad: 'gone' };
      if (!response.ok) return null;
      const data = await response.json();
      return { title: data.title, author: data.author_name };
    } catch (error) {
      return null;
    }
  }
  P.oembed = oembed;

  const queue = [];
  let workers = 0, done = 0, total = 0, failures = 0;
  function enqueueTitles(songs, noApi) {
    if (!songs.length) return;
    if (P.key && !P.quotaOut && !noApi) { titlesViaApi(songs); return; }
    songs.forEach(song => queue.push(song));
    total += songs.length;
    while (workers < 3 && queue.length) { workers++; work(); }
  }
  P.enqueueTitles = enqueueTitles;

  async function work() {
    while (queue.length) {
      const song = queue.shift();
      done++;
      if (!TM.M.has(song.id)) continue;
      const result = await oembed(TM.vidOf(song));
      if (result) {
        failures = 0;
        if (result.title) {
          song.title = result.title;
          if (!song.artist) song.artist = result.author || '';
        }
        if (result.bad) song.bad = result.bad;
        delete song.auto;
      } else if (++failures >= 6) {
        queue.length = 0;
        TM.toast('Could not fetch titles (network blocked?). Placeholders kept — you can edit titles manually.', true);
        break;
      }
      const bg = $('tm-bg');
      if (bg) bg.textContent = 'Loading titles ' + done + '/' + total;
      if (done % 25 === 0) { TM.save(); TM.ui?.renderQueue?.(); }
      await TM.sleep(120);
    }
    workers--;
    if (!workers) {
      total = done = failures = 0;
      const bg = $('tm-bg');
      if (bg) bg.textContent = '';
      TM.save();
      TM.ui?.render?.();
    }
  }

  P.lookupTitle = async function () {
    const input = $('tm-url');
    if (!input) return;
    const video = TM.videoId(input.value);
    const hint = $('tm-fetch-hint');
    if (!video) { if (hint) hint.textContent = 'Paste a valid YouTube video link first.'; return; }
    const token = (P.lookupToken = (P.lookupToken || 0) + 1);
    if (hint) hint.textContent = 'Fetching video title from YouTube…';
    const result = await oembed(video);
    if (token !== P.lookupToken) return;
    if (!result) {
      if (hint) hint.textContent = 'Auto-title lookup was blocked by the browser/network. You can enter the title manually.';
      return;
    }
    if (result.bad) {
      P.lastBad = { video, bad: result.bad };
      if (hint) hint.textContent = '⚠ ' + BADTXT[result.bad] + ' — it will be saved but skipped during playback.';
      return;
    }
    const title = $('tm-title');
    if (title && (!title.value.trim() || title.dataset.auto === 'yes')) {
      title.value = result.title || '';
      title.dataset.auto = 'yes';
    }
    const artist = $('tm-artist');
    if (artist && !artist.value.trim()) artist.value = result.author || '';
    if (hint) hint.textContent = '✓ YouTube title found. You can edit it before saving.';
  };

  /* ---------- IFrame player ---------- */

  function loadApi() {
    if ((window.YT && window.YT.Player) || P.apiReq) return;
    P.apiReq = true;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      P.apiReq = false;
      status('OFFLINE');
      TM.toast('Could not load the YouTube player. Check your internet connection.', true);
    };
    document.head.appendChild(script);
  }
  P.loadApi = loadApi;

  const previousReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function () {
    if (typeof previousReady === 'function') previousReady();
    if (P.pending) createPlayer(P.pending);
  };

  function resetPlayer() {
    try { P.p && P.p.destroy(); } catch (error) { /* ignore */ }
    P.p = null; P.ready = false; P.pv = null;
    const wrap = $('tm-youtube-wrap');
    if (wrap) wrap.innerHTML = '<div id="tm-youtube-player"></div>';
  }
  P.reset = resetPlayer;

  function createPlayer(video) {
    if (!(window.YT && window.YT.Player)) { P.pending = video || null; loadApi(); return; }
    P.pending = null;
    if (P.p && !P.ready) { P.pv = video || P.pv; return; }
    if (P.p) {
      try { P.p.loadVideoById(video); return; } catch (error) { resetPlayer(); }
    }
    const options = {
      autoplay: 1, controls: 0, disablekb: 1, fs: 0,
      iv_load_policy: 3, modestbranding: 1, playsinline: 1, rel: 0
    };
    if (/^https?:/.test(location.protocol)) options.origin = location.origin;
    P.p = new YT.Player('tm-youtube-player', {
      width: '100%', height: '100%', videoId: video, playerVars: options,
      events: {
        onReady: () => {
          P.ready = true;
          applyAudio();
          if (P.pv) {
            const next = P.pv;
            P.pv = null;
            try { P.p.loadVideoById(next); } catch (error) { /* ignore */ }
          }
        },
        onStateChange: onStateChange,
        onError: onError,
        onAutoplayBlocked: () => {
          status('TAP PLAY');
          stage('Your browser blocked autoplay — press play.');
        }
      }
    });
  }
  P.create = createPlayer;

  P.preload = function (preloadOnly) {
    loadApi();
    if (!preloadOnly && P.pending) createPlayer(P.pending);
  };

  function applyAudio() {
    try {
      P.p.setVolume(S.muted ? 0 : S.volume);
      P.p.setPlaybackRate(S.speed);
    } catch (error) { /* player not ready */ }
  }
  P.applyAudio = applyAudio;

  function stopTimer() {
    clearInterval(P.timer);
    P.timer = null;
  }

  function syncProgress(time, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return;
    const progress = $('tm-progress');
    if (progress && !P.seeking) progress.value = String(Math.round(time / duration * 1000));
    const elapsed = $('tm-elapsed'), total = $('tm-duration'), label = $('tm-time-label');
    if (elapsed) elapsed.textContent = TM.fmt(time);
    if (total) total.textContent = TM.fmt(duration);
    if (label) label.textContent = TM.fmt(time) + ' / ' + TM.fmt(duration);
    const eqProgress = $('tm-eq-progress');
    if (eqProgress && !P.seeking) {
      eqProgress.value = progress ? progress.value : String(Math.round(time / duration * 1000));
      const eqElapsed = $('tm-eq-elapsed'), eqDuration = $('tm-eq-duration');
      if (eqElapsed) eqElapsed.textContent = TM.fmt(time);
      if (eqDuration) eqDuration.textContent = TM.fmt(duration);
    }
  }
  P.syncProgress = syncProgress;

  function onStateChange(event) {
    const code = event.data;
    const video = $('tm-video');
    const toggle = $('tm-toggle');
    if (code === 1) {
      P.ending = null;
      P.fails = 0;
      status('PLAYING');
      if (toggle) toggle.textContent = 'Ⅱ';
      video?.classList.add('playing');
      stage('Playing in audio mode');
      applyAudio();
      stopTimer();
      P.timer = setInterval(() => {
        try {
          const duration = P.p.getDuration(), time = P.p.getCurrentTime();
          if (duration > 0) syncProgress(time, duration);
        } catch (error) { /* ignore */ }
      }, 700);
    } else if (code === 2) {
      status('PAUSED');
      if (toggle) toggle.textContent = '▶';
      video?.classList.remove('playing');
      stopTimer();
    } else if (code === 0) {
      stopTimer();
      video?.classList.remove('playing');
      if (toggle) toggle.textContent = '▶';
      if (S.repeat && S.current) {
        try { P.p.seekTo(0, true); P.p.playVideo(); } catch (error) { /* ignore */ }
      } else {
        status('ENDED');
        const ended = S.current;
        if (P.ending !== ended) {
          P.ending = ended;
          setTimeout(() => { if (S.current === ended) nextSong(true); }, 250);
        }
      }
    } else if (code === 3) {
      status('BUFFERING');
    }
  }

  function onError(event) {
    const code = Number(event.data);
    const id = S.current;
    const song = TM.songBy(id);
    if (code === 153 || code === 152) {
      status('SETUP NEEDED');
      $('tm-banner')?.classList.remove('hide');
      stage('Open the app from localhost or a web address to enable playback.');
      TM.toast('YouTube needs the page to be opened from a web address (localhost or hosting), not as a plain file.', true);
      return;
    }
    if (song && (code === 100 || code === 101 || code === 150 || code === 2)) {
      if (song.alt) { delete song.alt; song.altFail = true; }
      song.bad = (code === 101 || code === 150) ? 'embed' : 'gone';
      if (P.key && !song.altFail && !P.quotaOut) { resolveAlt(song, id); return; }
      TM.save();
    }
    P.fails++;
    $('tm-video')?.classList.remove('playing');
    if (P.fails > Math.min(30, Math.max(3, S.queue.length))) {
      status('STOPPED');
      stage('Several songs in a row failed. Check your internet connection.');
      TM.toast('Several songs in a row could not play. Check your internet connection or the links.', true);
      TM.ui?.renderQueue?.();
      return;
    }
    status('SKIPPING');
    stage('Unavailable — skipping to the next song…');
    TM.toast('"' + (song ? song.title.slice(0, 40) : 'Song') + '" can\'t be played here — skipping.', true);
    TM.ui?.render?.();
    setTimeout(() => { if (S.current === id) nextSong(true); }, 900);
  }
  P.onError = onError;

  function media(song) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title, artist: song.artist || 'T Music', album: 'T Music',
        artwork: [{ src: 'https://i.ytimg.com/vi/' + TM.vidOf(song) + '/hqdefault.jpg', sizes: '480x360', type: 'image/jpeg' }]
      });
    } catch (error) { /* unsupported */ }
  }
  try {
    if ('mediaSession' in navigator) {
      const session = navigator.mediaSession;
      session.setActionHandler('play', () => P.toggle());
      session.setActionHandler('pause', () => P.toggle());
      session.setActionHandler('nexttrack', () => nextSong());
      session.setActionHandler('previoustrack', () => prevSong());
    }
  } catch (error) { /* unsupported */ }

  P.playSong = function (id) {
    const song = TM.songBy(id);
    if (!song) return;
    const video = TM.vidOf(song);
    if (!video) { TM.toast('Invalid YouTube link. Edit the song and check its URL.', true); return; }
    if (!S.queue.includes(id)) S.queue.unshift(id);
    const needAlt = !!(song.bad && !song.alt && P.key && !song.altFail && !P.quotaOut);
    if (!song.alt && !needAlt) delete song.bad;
    S.current = id;
    TM.save();
    TM.ui?.updateTrack?.(song);
    media(song);
    if (S.view === 'home') {
      const at = S.queue.indexOf(id);
      if (at >= S.limit) S.limit = at + 20;
    }
    TM.ui?.renderSidebar?.();
    TM.ui?.renderQueue?.();
    TM.ui?.revealCurrent?.();
    if (needAlt) resolveAlt(song, id);
    else createPlayer(song.alt || video);
  };

  function nextSong(auto) {
    const source = S.view === 'home' ? TM.dashboardSongs().map(song => song.id) : S.queue;
    if (!source.length) { TM.toast('This selection is empty. Choose another source or add songs.', true); return; }
    const playable = source.filter(id => TM.playable(TM.songBy(id)));
    if (!playable.length) { TM.toast('No playable songs in the queue.', true); return; }
    let next = null;
    if (S.shuffle && playable.length > 1) {
      const others = playable.filter(id => id !== S.current);
      next = others[Math.floor(Math.random() * others.length)];
    } else {
      const index = source.indexOf(S.current);
      for (let i = index + 1; i < source.length; i++) {
        if (TM.playable(TM.songBy(source[i]))) { next = source[i]; break; }
      }
      if (!next) {
        if (auto || index < 0) next = playable[0];
        else { TM.toast('End of queue. Add more songs or turn on shuffle.'); return; }
      }
    }
    P.playSong(next);
  }
  P.next = nextSong;

  function prevSong() {
    try {
      if (P.ready && P.p.getCurrentTime() > 3) { P.p.seekTo(0, true); return; }
    } catch (error) { /* ignore */ }
    const source = S.view === 'home' ? TM.dashboardSongs().map(song => song.id) : S.queue;
    const index = source.indexOf(S.current);
    for (let i = index - 1; i >= 0; i--) {
      if (TM.playable(TM.songBy(source[i]))) { P.playSong(source[i]); return; }
    }
    const first = source.find(id => TM.playable(TM.songBy(id)));
    if (first) P.playSong(first);
  }
  P.prev = prevSong;

  P.toggle = function () {
    if (!P.p) { $('tm-start')?.click(); return; }
    if (!P.ready) { TM.toast('Player is still loading…'); return; }
    try {
      if (P.p.getPlayerState() === 1) P.p.pauseVideo();
      else P.p.playVideo();
    } catch (error) { TM.toast('Player is not ready yet.', true); }
  };

  P.stop = function () {
    stopTimer();
    try { P.p && P.p.stopVideo(); } catch (error) { /* ignore */ }
    status('READY');
    const toggle = $('tm-toggle');
    if (toggle) toggle.textContent = '▶';
    $('tm-video')?.classList.remove('playing');
  };

  P.setVolume = function (value) {
    S.volume = Math.max(0, Math.min(100, Number(value) || 0));
    S.muted = false;
    const volume = $('tm-volume'), eqVolume = $('tm-eq-volume'), mute = $('tm-mute'), eqMute = $('tm-eq-mute');
    if (volume) volume.value = String(S.volume);
    if (eqVolume) eqVolume.value = String(S.volume);
    if (mute) mute.textContent = '🔊';
    if (eqMute) eqMute.textContent = '🔊';
    applyAudio();
    TM.save();
  };

  P.toggleMute = function () {
    S.muted = !S.muted;
    const mute = $('tm-mute'), eqMute = $('tm-eq-mute');
    if (mute) mute.textContent = S.muted ? '🔇' : '🔊';
    if (eqMute) eqMute.textContent = S.muted ? '🔇' : '🔊';
    applyAudio();
    TM.toast(S.muted ? 'Muted' : 'Sound on');
  };

  P.seekSeconds = function (seconds) {
    try {
      if (P.ready) P.p.seekTo(Math.max(0, P.p.getCurrentTime() + seconds), true);
    } catch (error) { /* ignore */ }
  };

  P.seekFraction = function (fraction) {
    try {
      if (P.ready && P.p.getDuration()) P.p.seekTo(P.p.getDuration() * fraction, true);
    } catch (error) { /* ignore */ }
  };
})();
