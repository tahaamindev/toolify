/* ============================================================
   T MUSIC for Toolify — event wiring & shortcuts
   Wired once from both wireEvents() and DOMContentLoaded.
   ============================================================ */
(function () {
  'use strict';
  const TM = window.TM;
  const $ = TM.$;
  const S = TM.S;
  const P = TM.player;
  const UI = TM.ui;

  const events = TM.events = { wired: false };
  const on = (element, type, handler) => { if (element) element.addEventListener(type, handler); };

  function playAll() {
    if (!S.songs.length) {
      UI.openSong();
      TM.toast('Add your first song, then press Play All.', true);
      return;
    }
    const selected = TM.dashboardSongs().map(song => song.id);
    if (!selected.length) { TM.toast('No songs in this selection yet.', true); return; }
    const others = S.queue.filter(id => !selected.includes(id));
    S.queue = selected.concat(others);
    TM.save();
    P.fails = 0;
    const playable = selected.filter(id => TM.playable(TM.songBy(id)));
    if (!playable.length) { TM.toast('No playable songs in this selection.', true); return; }
    P.playSong(S.shuffle
      ? playable[Math.floor(Math.random() * playable.length)]
      : playable.includes(S.current) ? S.current : playable[0]);
    UI.renderQueue();
  }

  function removeBad() {
    const count = S.songs.filter(song => song.bad).length;
    if (!count) { TM.toast('No unavailable songs.'); return; }
    if (!confirm('Remove ' + count + ' unavailable song(s) from your library?')) return;
    S.songs = S.songs.filter(song => !song.bad);
    TM.reindex(); TM.cleanQueue();
    if (S.current && !TM.M.has(S.current)) S.current = null;
    TM.save(); UI.render();
    TM.toast('Removed ' + count + ' songs.');
  }

  function saveApiKey() {
    const input = $('tm-api-key');
    const value = input.value.trim();
    if (value === '••••••••') { TM.toast('Key already saved.'); return; }
    if (!value) {
      P.key = '';
      try { localStorage.removeItem('tmusic-key'); } catch (error) { /* ignore */ }
      TM.toast('API key removed.');
      return;
    }
    const previous = P.key;
    P.key = value;
    P.ytApi('videos', { part: 'id', id: 'dQw4w9WgXcQ' }).then(() => {
      try { localStorage.setItem('tmusic-key', value); } catch (error) { /* ignore */ }
      P.quotaOut = false;
      input.value = '••••••••';
      TM.toast('✓ API key works. Smart fallback is on.');
    }).catch(error => {
      P.key = previous;
      TM.toast('Key rejected: ' + error.message, true);
    });
  }

  async function findAlternates() {
    if (!P.key) { TM.toast('Save an API key first.', true); return; }
    const songs = S.songs.filter(song => song.bad && !song.alt && !song.altFail);
    if (!songs.length) { TM.toast('No unavailable songs need an alternate. Try "Check all songs" first.'); return; }
    if (!confirm('Search alternates for ' + songs.length + ' songs? Each search uses 100 of your free daily 10,000 API quota units.')) return;
    let index = 0, found = 0;
    for (const song of songs) {
      if (P.quotaOut) break;
      index++;
      const bg = $('tm-bg');
      if (bg) bg.textContent = 'Finding alternates ' + index + '/' + songs.length;
      const video = await P.findAlt(song);
      if (video) { song.alt = video; delete song.bad; found++; }
      else if (!P.quotaOut) song.altFail = true;
      if (index % 5 === 0) { TM.save(); UI.renderQueue(); }
      await TM.sleep(150);
    }
    const bg = $('tm-bg');
    if (bg) bg.textContent = '';
    TM.save(); UI.render();
    TM.toast('Found alternates for ' + found + ' of ' + songs.length + ' songs.' + (P.quotaOut ? ' Quota/key limit reached — try again later.' : ''));
  }

  events.wire = function () {
    if (events.wired || !$('tm-app')) return;
    events.wired = true;

    document.addEventListener('click', event => {
      const actionButton = event.target.closest('[data-tm-action]');
      if (actionButton) {
        const action = actionButton.dataset.tmAction;
        if (action === 'add') UI.openSong();
        if (action === 'bulk') { UI.syncPlaylists(); UI.openModal('tm-bulk-back'); }
        if (action === 'settings') UI.openModal('tm-settings-back');
        if (action === 'new-playlist') { const form = $('tm-playlist-form'); if (form) form.reset(); UI.openModal('tm-playlist-back'); }
      }
      const viewButton = event.target.closest('[data-tm-view]');
      if (viewButton) UI.go(viewButton.dataset.tmView);
      const playlistButton = event.target.closest('[data-tm-pl]');
      if (playlistButton) UI.go('playlist', playlistButton.dataset.tmPl);
      const closeButton = event.target.closest('[data-tm-close]');
      if (closeButton) {
        if (closeButton.dataset.tmClose === 'tm-eq-back') UI.closeEq();
        else UI.closeModal(closeButton.dataset.tmClose);
      }
      document.querySelectorAll('.tm-backdrop').forEach(backdrop => {
        if (event.target === backdrop) {
          if (backdrop.id === 'tm-eq-back') UI.closeEq();
          else UI.closeModal(backdrop.id);
        }
      });
      const themeButton = event.target.closest('[data-tm-theme-choice]');
      if (themeButton) UI.setTheme(themeButton.dataset.tmThemeChoice);
    });

    on($('tm-banner-close'), 'click', () => $('tm-banner')?.classList.add('hide'));

    let searchTimer;
    on($('tm-search'), 'input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.limit = TM.PAGE;
        UI.renderQueue();
        const queue = $('tm-queue'); if (queue) queue.scrollTop = 0;
      }, 180);
    });

    on($('tm-dashboard-source'), 'change', event => {
      S.dashboardSource = event.currentTarget.value;
      S.limit = TM.PAGE;
      TM.save(); UI.renderQueue();
      const queue = $('tm-queue'); if (queue) queue.scrollTop = 0;
    });
    on($('tm-start'), 'click', playAll);
    on($('tm-queue-add'), 'click', () => UI.openSong());
    on($('tm-clear-queue'), 'click', () => {
      if (!confirm('Clear the queue? Saved songs will remain in your library.')) return;
      S.queue = [];
      TM.save(); UI.renderQueue();
      TM.toast('Queue cleared.');
    });

    /* queue rows */
    const queue = $('tm-queue');
    on(queue, 'click', event => {
      if (event.target.closest('#tm-more')) { S.limit += TM.PAGE; UI.renderQueue(); return; }
      const row = event.target.closest('.tm-row');
      if (row && !event.target.closest('button')) {
        P.fails = 0;
        P.playSong(row.dataset.id);
        return;
      }
      const button = event.target.closest('[data-tm-act]');
      if (!button) return;
      const rowEl = button.closest('.tm-row');
      const song = TM.songBy(rowEl?.dataset.id);
      if (!song) return;
      switch (button.dataset.tmAct) {
        case 'play':
          P.fails = 0;
          if (!S.queue.includes(song.id)) S.queue.push(song.id);
          P.playSong(song.id);
          break;
        case 'next': {
          S.queue = S.queue.filter(id => id !== song.id);
          const at = S.queue.indexOf(S.current);
          S.queue.splice(at + 1, 0, song.id);
          TM.save(); UI.renderQueue();
          TM.toast('Will play next.');
          break;
        }
        case 'add':
          if (!S.queue.includes(song.id)) { S.queue.push(song.id); TM.save(); TM.toast('Added to queue.'); }
          else TM.toast('Already in the queue.');
          break;
        case 'fav':
          song.favorite = !song.favorite;
          TM.save(); UI.render();
          break;
        case 'edit':
          UI.openSong(song);
          break;
        case 'remove':
          S.queue = S.queue.filter(id => id !== song.id);
          TM.save(); UI.renderQueue();
          TM.toast('Removed from queue.');
          break;
        case 'retry':
          delete song.bad; delete song.alt; delete song.altFail;
          TM.save(); UI.render();
          TM.toast('Flag cleared — it will be tried again.');
          break;
      }
    });
    on(queue, 'dragstart', event => {
      const row = event.target.closest('.tm-row');
      if (!row || S.view !== 'home') return;
      events.drag = row.dataset.id;
      row.classList.add('dragging');
      event.dataTransfer.setData('text/plain', events.drag);
      event.dataTransfer.effectAllowed = 'move';
    });
    on(queue, 'dragend', () => {
      events.drag = null;
      queue.querySelectorAll('.dragging,.over').forEach(row => row.classList.remove('dragging', 'over'));
    });
    on(queue, 'dragover', event => {
      const row = event.target.closest('.tm-row');
      if (!row || !events.drag) return;
      event.preventDefault();
      queue.querySelectorAll('.over').forEach(item => { if (item !== row) item.classList.remove('over'); });
      row.classList.add('over');
    });
    on(queue, 'drop', event => {
      const row = event.target.closest('.tm-row');
      if (!row || !events.drag) return;
      event.preventDefault();
      const from = events.drag, to = row.dataset.id;
      if (from === to) return;
      const a = S.queue.indexOf(from), b = S.queue.indexOf(to);
      if (a < 0 || b < 0) return;
      S.queue.splice(a, 1);
      S.queue.splice(b, 0, from);
      TM.save(); UI.renderQueue();
    });
    on(queue, 'scroll', () => {
      if ($('tm-more') && queue.scrollTop + queue.clientHeight >= queue.scrollHeight - 260) {
        S.limit += TM.PAGE;
        UI.renderQueue();
      }
    }, { passive: true });

    /* transport */
    on($('tm-toggle'), 'click', () => P.toggle());
    on($('tm-next'), 'click', () => P.next());
    on($('tm-prev'), 'click', () => P.prev());
    on($('tm-shuffle'), 'click', () => {
      S.shuffle = !S.shuffle;
      $('tm-shuffle').classList.toggle('active', S.shuffle);
      TM.toast(S.shuffle ? 'Shuffle enabled.' : 'Shuffle disabled.');
    });
    on($('tm-repeat'), 'click', () => {
      S.repeat = !S.repeat;
      $('tm-repeat').classList.toggle('active', S.repeat);
      TM.toast(S.repeat ? 'Repeat current song enabled.' : 'Repeat disabled.');
    });
    on($('tm-vid-toggle'), 'click', () => {
      S.audioOnly = !S.audioOnly;
      UI.applyMode(); TM.save();
      TM.toast(S.audioOnly ? 'Audio mode — video hidden.' : 'Video shown.');
    });
    on($('tm-mute'), 'click', () => P.toggleMute());
    on($('tm-eq-mute'), 'click', () => P.toggleMute());
    on($('tm-volume'), 'input', event => P.setVolume(Number(event.currentTarget.value)));
    on($('tm-eq-volume'), 'input', event => P.setVolume(Number(event.currentTarget.value)));
    on($('tm-speed'), 'change', event => {
      S.speed = Number(event.currentTarget.value) || 1;
      P.applyAudio(); TM.save();
      TM.toast('Playback speed set to ' + S.speed + '×');
    });

    function previewSeek(input, label) {
      on(input, 'pointerdown', () => { P.seeking = true; });
      on(input, 'input', () => {
        if (label) {
          const target = $(label);
          if (target && input.id !== 'tm-progress') $('tm-progress').value = input.value;
          try {
            const duration = P.p?.getDuration();
            if (duration && target) target.textContent = TM.fmt(duration * Number(input.value) / 1000);
          } catch (error) { /* ignore */ }
        } else {
          try {
            const duration = P.p?.getDuration();
            const target = $('tm-elapsed');
            if (duration && target) target.textContent = TM.fmt(duration * Number(input.value) / 1000);
          } catch (error) { /* ignore */ }
        }
      });
      on(input, 'change', () => {
        P.seeking = false;
        P.seekFraction(Number(input.value) / 1000);
      });
    }
    previewSeek($('tm-progress'));
    previewSeek($('tm-eq-progress'), 'tm-eq-elapsed');

    /* Audio Studio */
    on($('tm-eq-open'), 'click', () => UI.openEq());
    on($('tm-eq-close'), 'click', () => UI.closeEq());
    on($('tm-eq-play'), 'click', () => P.toggle());
    on($('tm-eq-next-btn'), 'click', () => P.next());
    on($('tm-eq-prev'), 'click', () => P.prev());
    on($('tm-eq-back5'), 'click', () => P.seekSeconds(-5));
    on($('tm-eq-forward5'), 'click', () => P.seekSeconds(5));
    document.querySelectorAll('[data-tm-band]').forEach(input => {
      on(input, 'input', () => {
        const label = $(input.dataset.tmBand === 'bass' ? 'tm-eq-bass-val' : 'tm-eq-treble-val');
        const value = Number(input.value);
        if (label) label.textContent = (value > 0 ? '+' : '') + value;
        try {
          const tone = JSON.parse(localStorage.getItem('tmusic-tone-profile') || '{}');
          document.querySelectorAll('[data-tm-band]').forEach(item => { tone[item.dataset.tmBand] = Number(item.value); });
          localStorage.setItem('tmusic-tone-profile', JSON.stringify(tone));
        } catch (error) { /* ignore */ }
      });
    });

    /* song form */
    on($('tm-url'), 'change', () => P.lookupTitle());
    on($('tm-url'), 'paste', () => setTimeout(() => P.lookupTitle(), 120));
    on($('tm-title'), 'input', () => { $('tm-title').dataset.auto = 'no'; });
    on($('tm-song-form'), 'submit', event => {
      event.preventDefault();
      const url = $('tm-url').value.trim();
      const video = TM.videoId(url);
      if (!video) { TM.toast('Please enter a valid YouTube video link.', true); return; }
      const title = $('tm-title').value.trim();
      if (!title) { TM.toast('Enter a song title.', true); return; }
      const data = {
        url: 'https://www.youtube.com/watch?v=' + video,
        v: video, title, artist: $('tm-artist').value.trim(),
        playlistId: $('tm-song-playlist').value
      };
      const old = $('tm-edit-id').value;
      if (old) {
        const song = TM.songBy(old);
        if (!song) return;
        Object.assign(song, data);
        if (P.lastBad && P.lastBad.video === video) song.bad = P.lastBad.bad;
        TM.toast('Song updated.');
      } else {
        if (S.songs.some(song => TM.vidOf(song) === video) && !confirm('This video is already in your library. Add it again?')) return;
        const song = {
          id: TM.uid(), ...data, favorite: false, addedAt: new Date().toISOString()
        };
        if (P.lastBad && P.lastBad.video === video) song.bad = P.lastBad.bad;
        S.songs.push(song);
        S.queue.push(song.id);
        TM.reindex();
        TM.toast('Song saved to your library.');
      }
      TM.save(); UI.closeModal('tm-song-back'); UI.render();
    });
    on($('tm-del-song'), 'click', () => {
      const id = $('tm-edit-id').value;
      if (!id || !confirm('Delete this song from your library?')) return;
      S.songs = S.songs.filter(song => song.id !== id);
      S.queue = S.queue.filter(queueId => queueId !== id);
      if (S.current === id) S.current = null;
      TM.reindex(); TM.save(); UI.closeModal('tm-song-back'); UI.render();
      TM.toast('Song deleted.');
    });

    on($('tm-bulk-form'), 'submit', event => {
      event.preventDefault();
      const tokens = $('tm-bulk-text').value.match(/https?:\/\/[^\s,;"'<>]+/g) || [];
      if (!tokens.length) { TM.toast('Paste at least one YouTube link.', true); return; }
      const have = new Set(S.songs.map(TM.vidOf));
      const playlistId = $('tm-bulk-playlist').value;
      const added = [];
      let duplicates = 0, invalid = 0;
      tokens.forEach(token => {
        const video = TM.videoId(token);
        if (!video) { invalid++; return; }
        if (have.has(video)) { duplicates++; return; }
        have.add(video);
        added.push({
          id: TM.uid(), url: 'https://www.youtube.com/watch?v=' + video, v: video,
          title: 'YouTube video · ' + video, artist: '', playlistId,
          favorite: false, addedAt: new Date().toISOString(), auto: 1
        });
      });
      if (!added.length) {
        TM.toast('Nothing new to add (' + duplicates + ' duplicates, ' + invalid + ' invalid).', true);
        return;
      }
      added.forEach(song => { S.songs.push(song); S.queue.push(song.id); });
      TM.reindex(); TM.save(); UI.closeModal('tm-bulk-back');
      $('tm-bulk-text').value = '';
      UI.render();
      TM.toast('Added ' + added.length + ' songs' + (duplicates ? ', ' + duplicates + ' duplicates skipped' : '') +
        (invalid ? ', ' + invalid + ' invalid skipped' : '') + '. Loading titles…');
      P.enqueueTitles(added);
    });

    on($('tm-playlist-form'), 'submit', event => {
      event.preventDefault();
      const name = $('tm-playlist-name').value.trim();
      if (!name) return;
      if (S.playlists.some(playlist => playlist.name.toLowerCase() === name.toLowerCase())) {
        TM.toast('That playlist name already exists.', true);
        return;
      }
      const playlist = { id: TM.uid(), name };
      S.playlists.push(playlist);
      TM.save(); UI.closeModal('tm-playlist-back');
      UI.go('playlist', playlist.id);
      TM.toast('Playlist created. Add songs and assign them to it.');
    });

    /* settings */
    on($('tm-custom-accent'), 'input', event => {
      const color = event.currentTarget.value;
      const app = $('tm-app');
      if (app) { app.style.setProperty('--tm-a', color); app.style.setProperty('--tm-b', color); }
      S.theme = 'classic';
      S.customAccent = color;
      document.querySelectorAll('[data-tm-theme-choice]').forEach(button => button.setAttribute('aria-pressed', 'false'));
      const current = $('tm-theme-current');
      if (current) current.textContent = 'Current: Custom accent';
      TM.save();
    });
    on($('tm-manual-snapshot'), 'click', () => { TM.flush(); TM.toast('Automatic snapshot created in this browser.'); });
    on($('tm-export'), 'click', () => TM.exportBackup());
    on($('tm-import'), 'click', () => $('tm-import-file')?.click());
    on($('tm-import-file'), 'change', event => {
      const file = event.currentTarget.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          TM.importBackup(data);
          UI.closeModal('tm-settings-back');
        } catch (error) {
          TM.toast('Invalid T Music backup file: ' + error.message, true);
        }
      };
      reader.readAsText(file);
      event.currentTarget.value = '';
    });
    on($('tm-save-key'), 'click', saveApiKey);
    on($('tm-check-all'), 'click', () => {
      if (!P.key) { TM.toast('Save an API key first.', true); return; }
      if (!S.songs.length) { TM.toast('No songs yet.', true); return; }
      P.titlesViaApi(S.songs.slice(), true);
    });
    on($('tm-alt-all'), 'click', findAlternates);
    on($('tm-retry-bad'), 'click', () => {
      let count = 0;
      S.songs.forEach(song => {
        if (song.bad || song.altFail) { delete song.bad; delete song.alt; delete song.altFail; count++; }
      });
      P.quotaOut = false;
      TM.save(); UI.render();
      TM.toast(count ? 'Cleared ' + count + ' flags.' : 'Nothing to retry.');
    });
    on($('tm-remove-bad'), 'click', removeBad);

    /* shortcuts */
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        UI.closeAllModals();
        return;
      }
      if ($('music-player')?.hidden || document.querySelector('.tm-backdrop.show')) return;
      if (event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if (event.code === 'Space') { event.preventDefault(); P.toggle(); }
      else if (event.key === 'ArrowUp') {
        event.preventDefault(); P.setVolume(S.volume + 5);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault(); P.setVolume(S.volume - 5);
      } else if (event.key === 'ArrowRight') { event.preventDefault(); P.seekSeconds(5); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); P.seekSeconds(-5); }
      else if (key === 'm') P.toggleMute();
      else if (key === 'n') P.next();
      else if (key === 'p') P.prev();
      else if (key === 's') $('tm-shuffle')?.click();
      else if (key === 'r') $('tm-repeat')?.click();
      else if (key === 'e') UI.openEq();
    });

    UI.render();
    P.preload(true);
  };

  document.addEventListener('DOMContentLoaded', () => events.wire());
})();
