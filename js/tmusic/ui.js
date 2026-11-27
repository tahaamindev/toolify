/* ============================================================
   T MUSIC for Toolify — interface
   Rendering, views, dialogs, themes and the Audio Studio panel.
   ============================================================ */
(function () {
  'use strict';
  const TM = window.TM;
  const $ = TM.$;
  const S = TM.S;
  const esc = TM.esc;
  const UI = TM.ui = {};

  const THEMES = {
    silver: 'Silver · Black & White', classic: 'Classic', ocean: 'Ocean teal',
    rose: 'Rose', pink: 'Pink', lavender: 'Lavender', forest: 'Forest',
    sunset: 'Sunset', midnight: 'Midnight dark'
  };
  UI.THEMES = THEMES;

  UI.applyTheme = function () {
    const app = $('tm-app');
    if (!app) return;
    let theme = S.theme;
    if (!THEMES[theme]) theme = 'classic';
    if (S.customAccent) {
      app.style.setProperty('--tm-a', S.customAccent);
      app.style.setProperty('--tm-b', S.customAccent);
    } else {
      app.style.removeProperty('--tm-a');
      app.style.removeProperty('--tm-b');
    }
    app.dataset.tmTheme = theme;
    document.querySelectorAll('[data-tm-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.tmThemeChoice === theme));
    });
    const current = $('tm-theme-current');
    if (current) current.textContent = 'Current: ' + (S.customAccent ? 'Custom accent' : THEMES[theme]);
    const accent = $('tm-custom-accent');
    if (accent && S.customAccent) accent.value = S.customAccent;
  };

  UI.setTheme = function (theme) {
    S.theme = THEMES[theme] ? theme : 'classic';
    S.customAccent = '';
    UI.applyTheme();
    TM.save();
  };

  UI.applyMode = function () {
    $('tm-video')?.classList.toggle('show', !S.audioOnly);
    $('tm-vid-toggle')?.classList.toggle('active', !S.audioOnly);
  };

  UI.setStatus = TM.setStatus;
  UI.setStage = TM.setStage;

  UI.updateTrack = function (song) {
    const title = $('tm-now-title');
    if (title) title.textContent = song ? song.title : 'Nothing playing yet';
    const artist = $('tm-now-artist');
    if (artist) artist.textContent = song ? (song.artist || 'YouTube video') : 'Choose a song to begin';
    TM.setStatus(song ? 'LOADING' : 'READY');
    const toggle = $('tm-toggle');
    if (toggle) toggle.textContent = '▶';
    const elapsed = $('tm-elapsed'), duration = $('tm-duration'), label = $('tm-time-label'), progress = $('tm-progress');
    if (elapsed) elapsed.textContent = '0:00';
    if (duration) duration.textContent = '0:00';
    if (label) label.textContent = '--:--';
    if (progress) progress.value = '0';
    $('tm-video')?.classList.remove('playing');
    const cover = $('tm-now-cover');
    if (cover) {
      cover.innerHTML = song
        ? '<img alt="" src="https://i.ytimg.com/vi/' + esc(TM.vidOf(song)) + '/mqdefault.jpg">'
        : '♫';
      const image = cover.querySelector('img');
      if (image) image.onerror = () => { cover.textContent = '♫'; };
    }
    const art = $('tm-art');
    if (art) {
      if (song) {
        art.hidden = false;
        art.src = 'https://i.ytimg.com/vi/' + TM.vidOf(song) + '/hqdefault.jpg';
        art.onerror = () => { art.hidden = true; };
      } else art.hidden = true;
    }
    TM.setStage(song ? 'Loading…' : 'Add a YouTube link, then press play.');
    const eqNow = $('tm-eq-now');
    if (eqNow) eqNow.textContent = song ? song.title : 'Nothing playing yet';
    const eqNext = $('tm-eq-next');
    if (eqNext) {
      const next = TM.listData().filter(item => item.id !== S.current)[0];
      eqNext.textContent = next ? next.title : 'No next song selected';
    }
    const eqDisc = $('tm-eq-disc');
    if (eqDisc) {
      eqDisc.style.backgroundImage = song ? 'url(https://i.ytimg.com/vi/' + TM.vidOf(song) + '/hqdefault.jpg)' : '';
      eqDisc.style.backgroundSize = 'cover';
      eqDisc.style.backgroundPosition = 'center';
    }
  };

  UI.renderSidebar = function () {
    const nav = $('tm-playlists');
    if (nav) {
      nav.innerHTML = S.playlists.length
        ? S.playlists.map(playlist => {
          const count = S.songs.reduce((n, song) => n + (song.playlistId === playlist.id ? 1 : 0), 0);
          return '<button type="button" class="tm-pl' + (S.view === 'playlist' && S.pl === playlist.id ? ' active' : '') +
            '" data-tm-pl="' + esc(playlist.id) + '">▤ ' + esc(playlist.name) + '<span>' + count + '</span></button>';
        }).join('') + '<button type="button" class="tm-pl add" data-tm-action="new-playlist" title="New playlist">＋</button>'
        : '<button type="button" class="tm-pl add" data-tm-action="new-playlist" title="New playlist">＋ New playlist</button>';
    }
    document.querySelectorAll('[data-tm-view]').forEach(button => {
      button.classList.toggle('active', button.dataset.tmView === S.view);
    });
  };

  UI.row = function (song, index, home) {
    const bad = song.alt ? null : song.bad;
    const now = song.id === S.current;
    const buttons = home
      ? '<button data-tm-act="play" title="Play">▶</button><button data-tm-act="next" title="Play next">⤒</button>' +
        '<button data-tm-act="fav" title="Favorite">' + (song.favorite ? '♥' : '♡') + '</button>' +
        '<button data-tm-act="edit" title="Edit">✎</button><button data-tm-act="remove" title="Remove from queue">×</button>'
      : '<button data-tm-act="add" title="Add to queue">＋</button>' +
        '<button data-tm-act="fav" title="Favorite">' + (song.favorite ? '♥' : '♡') + '</button>' +
        '<button data-tm-act="edit" title="Edit">✎</button>';
    return '<div class="tm-row' + (now ? ' now' : '') + (bad ? ' bad' : '') + '"' +
      (home ? ' draggable="true"' : '') + ' data-id="' + esc(song.id) + '">' +
      (home ? '<span class="tm-grip">⠿</span>' : '') +
      '<span class="tm-num">' + String(index + 1).padStart(2, '0') + '</span>' +
      '<div class="tm-cover"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/' + esc(TM.vidOf(song)) +
      '/mqdefault.jpg" onerror="this.style.display=\'none\'"></div>' +
      '<div class="tm-meta"><b>' + esc(song.title) + '</b><span>' + esc(song.artist || 'YouTube') +
      (now ? ' · NOW PLAYING' : '') + (song.alt ? ' · ♻ alternate version' : bad ? ' · ⚠ ' + esc(TM.BADTXT[bad] || 'Unavailable') : '') +
      '</span></div><div class="tm-row-buttons">' + (bad ? '<button data-tm-act="retry" title="Retry">⟳</button>' : '') +
      buttons + '</div></div>';
  };

  UI.renderQueue = function () {
    const container = $('tm-queue');
    if (!container) return;
    const songs = TM.listData();
    const home = S.view === 'home';
    const shown = songs.slice(0, S.limit);
    const left = songs.length - shown.length;
    container.className = 'tm-queue' + (home ? ' home' : '');
    container.innerHTML = shown.length
      ? shown.map((song, index) => UI.row(song, index, home)).join('') +
        (left > 0 ? '<button type="button" class="tm-btn more" id="tm-more">Show ' + Math.min(TM.PAGE, left) + ' more · ' + left + ' left</button>' : '')
      : home
        ? '<div class="tm-empty"><b>Your queue is empty</b>Add songs (or use Bulk Add) and they will show up here.</div>'
        : '<div class="tm-empty"><b>No songs here yet</b>Add a song or choose another section.</div>';
  };

  UI.render = function () {
    UI.renderSidebar();
    const favorites = S.songs.reduce((n, song) => n + (song.favorite ? 1 : 0), 0);
    const bad = S.songs.reduce((n, song) => n + (song.bad ? 1 : 0), 0);
    const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
    set('tm-all-count', S.songs.length);
    set('tm-fav-count', favorites);
    set('tm-stat-songs', S.songs.length);
    set('tm-stat-lists', S.playlists.length);
    set('tm-stat-favs', favorites);
    const info = $('tm-bad-info');
    if (info) info.textContent = bad
      ? bad + ' song(s) are flagged unavailable and skipped automatically.'
      : 'No unavailable songs. Anything YouTube refuses to embed is flagged and skipped automatically.';

    const source = $('tm-dashboard-source');
    if (source) {
      const wanted = S.dashboardSource;
      source.innerHTML = '<option value="all">All Songs</option><option value="favorites">♥ Favorites</option>' +
        S.playlists.map(playlist => '<option value="playlist:' + esc(playlist.id) + '">▤ ' + esc(playlist.name) + '</option>').join('');
      source.value = [...source.options].some(option => option.value === wanted) ? wanted : 'all';
      S.dashboardSource = source.value;
    }
    const home = S.view === 'home';
    const playlist = S.playlists.find(item => item.id === S.pl);
    set('tm-view-title', home ? 'Good music. Good mood.'
      : S.view === 'all' ? 'All Songs'
        : S.view === 'favorites' ? 'Favorite Songs' : playlist ? playlist.name : 'Playlist');
    set('tm-view-subtitle', home ? 'Your personal collection, ready when you are.'
      : S.view === 'favorites' ? 'Only songs you marked as favorites.'
        : S.view === 'playlist' ? 'Songs saved in this playlist.' : 'Your complete music collection.');
    set('tm-list-title', home ? 'Up Next' : S.view === 'favorites' ? 'Your Favorites' : S.view === 'playlist' ? 'Playlist Songs' : 'All Songs');
    set('tm-list-desc', home ? 'Drag songs (or use ⤒) to change what plays next.' : 'Choose a song to play it, or add it to the queue.');
    $('tm-queue-add')?.classList.toggle('hide', !home);
    $('tm-clear-queue')?.classList.toggle('hide', !home);
    $('tm-shuffle')?.classList.toggle('active', !!S.shuffle);
    $('tm-repeat')?.classList.toggle('active', !!S.repeat);
    const volume = $('tm-volume'); if (volume) volume.value = String(S.volume);
    const speed = $('tm-speed'); if (speed) speed.value = String(S.speed);
    UI.renderQueue();
  };

  UI.go = function (view, playlistId) {
    S.view = view;
    S.pl = playlistId || null;
    S.limit = TM.PAGE;
    UI.render();
    const queue = $('tm-queue'); if (queue) queue.scrollTop = 0;
  };

  UI.openModal = function (id) { $(id)?.classList.add('show'); };
  UI.closeModal = function (id) { $(id)?.classList.remove('show'); };
  UI.closeAllModals = function () {
    /* The studio temporarily hosts the live video; restore it before hiding. */
    if ($('tm-eq-back')?.classList.contains('show')) UI.closeEq();
    document.querySelectorAll('.tm-backdrop.show').forEach(backdrop => backdrop.classList.remove('show'));
  };

  UI.syncPlaylists = function (selected) {
    const options = '<option value="">All Songs (no playlist)</option>' + S.playlists.map(playlist =>
      '<option value="' + esc(playlist.id) + '">' + esc(playlist.name) + '</option>').join('');
    ['tm-song-playlist', 'tm-bulk-playlist'].forEach(id => {
      const select = $(id);
      if (!select) return;
      select.innerHTML = options;
      if (id === 'tm-song-playlist') select.value = selected || (S.view === 'playlist' ? S.pl || '' : '');
      else select.value = S.view === 'playlist' ? S.pl || '' : '';
    });
  };

  UI.openSong = function (song) {
    const form = $('tm-song-form');
    if (!form) return;
    form.reset();
    if (song) {
      $('tm-edit-id').value = song.id;
      $('tm-url').value = song.url;
      $('tm-title').value = song.title;
      $('tm-artist').value = song.artist || '';
      $('tm-fetch-hint').textContent = 'The title will be fetched from YouTube automatically when possible.';
    } else {
      $('tm-edit-id').value = '';
      $('tm-fetch-hint').textContent = 'The title will be fetched from YouTube automatically when possible.';
    }
    TM.player.lastBad = null;
    $('tm-del-song')?.classList.toggle('hide', !song);
    const heading = $('tm-song-modal-title');
    if (heading) heading.textContent = song ? 'Edit Song' : 'Add a Song';
    UI.syncPlaylists(song ? song.playlistId || '' : S.view === 'playlist' ? S.pl || '' : '');
    UI.openModal('tm-song-back');
  };

  let videoPlaceholder = null;
  let discPlaceholder = null;
  UI.openEq = function () {
    const video = $('tm-video'), host = $('tm-eq-video-host'), disc = $('tm-eq-disc');
    if (!video || !host || !disc) return;
    UI.syncEq();
    if (!videoPlaceholder) {
      videoPlaceholder = document.createComment('tm-video-home');
      video.parentNode.insertBefore(videoPlaceholder, video);
    }
    host.appendChild(video);
    video.classList.add('show');
    if (!discPlaceholder) {
      discPlaceholder = document.createComment('tm-disc-home');
      disc.parentNode.insertBefore(discPlaceholder, disc);
    }
    host.appendChild(disc);
    UI.openModal('tm-eq-back');
  };

  UI.closeEq = function () {
    const video = $('tm-video'), disc = $('tm-eq-disc');
    if (videoPlaceholder && video && videoPlaceholder.parentNode) videoPlaceholder.parentNode.insertBefore(video, videoPlaceholder);
    if (discPlaceholder && disc && discPlaceholder.parentNode) discPlaceholder.parentNode.insertBefore(disc, discPlaceholder);
    UI.applyMode();
    UI.closeModal('tm-eq-back');
  };

  function syncEq() {
    const song = TM.songBy(S.current);
    const now = $('tm-eq-now');
    if (now) now.textContent = song ? song.title : 'Nothing playing yet';
    const next = TM.listData().filter(item => item.id !== S.current)[0];
    const nextEl = $('tm-eq-next');
    if (nextEl) nextEl.textContent = next ? next.title : 'No next song selected';
    const volume = $('tm-eq-volume'); if (volume) volume.value = String(S.volume);
    const progress = $('tm-eq-progress'); if (progress) progress.value = $('tm-progress')?.value || '0';
    const elapsed = $('tm-eq-elapsed'); if (elapsed) elapsed.textContent = $('tm-elapsed')?.textContent || '0:00';
    const duration = $('tm-eq-duration'); if (duration) duration.textContent = $('tm-duration')?.textContent || '0:00';
    try {
      const tone = JSON.parse(localStorage.getItem('tmusic-tone-profile') || '{}');
      document.querySelectorAll('[data-tm-band]').forEach(input => {
        const value = Number(tone[input.dataset.tmBand] ?? 0);
        input.value = String(value);
        const label = $(input.dataset.tmBand === 'bass' ? 'tm-eq-bass-val' : 'tm-eq-treble-val');
        if (label) label.textContent = (value > 0 ? '+' : '') + value;
      });
    } catch (error) { /* ignore */ }
  }
  UI.syncEq = syncEq;

  UI.revealCurrent = function () {
    const container = $('tm-queue');
    const current = container?.querySelector('.tm-row.now');
    if (!current || !container) return;
    const row = current.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    let delta = 0;
    if (row.top < box.top + 16) delta = row.top - box.top - 16;
    else if (row.bottom > box.bottom - 24) delta = row.bottom - box.bottom + 24;
    if (delta) container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
  };
})();
