/* ============================================================
   TOOLify — Music compatibility facade
   The player itself lives in js/tmusic/*.js. These globals are
   kept so existing Toolify modules keep working unchanged.
   ============================================================ */

function syncMusicState() {
  if (window.TM) TM.sync();
}

function resetMusicSettingsRef() {
  if (window.TM) TM.resetRef();
}

function loadYouTubePlayer(preloadOnly = false) {
  if (window.TM) TM.player.preload(preloadOnly);
}

function getMusicSettings() {
  if (window.TM) return TM.settings();
  return null;
}
