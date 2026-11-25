/* ============================================================
   TOOLIFY — Shared application state
   Split from the original app.js (behaviour preserved).
   ============================================================ */

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
clockTheme: "emerald",
notes: [],
tasks: []
  },
  ui: {
    activeNav: "all",   // 'all' | 'favorites' | categoryId
    search: "",
    sidebarCollapsed: false
  }
};

/* Incremented on every settings save so a cloud refresh can tell whether the
   user changed notes/tasks while the remote snapshot was still loading. */
window.TOOLIFY_SETTINGS_REVISION = 0;

async function persistSettings(){
  /* Stamp and snapshot the settings so notes/tasks saved during startup sync
     are never replaced by an older cloud row. */
  State.settings.updatedAt = Date.now();
  window.TOOLIFY_SETTINGS_REVISION = (window.TOOLIFY_SETTINGS_REVISION || 0) + 1;
  const snapshot = typeof structuredClone === 'function'
    ? structuredClone(State.settings)
    : JSON.parse(JSON.stringify(State.settings));
  await DB.put("settings", {key:"app", value: snapshot});
}
function persistSettingsFast(){
  persistSettings().catch(error=>{
    console.error('Cloud sync failed:',error);
    toast('Saved on this device — cloud sync failed','error');
  });
}
window.addEventListener('toolify:clock-theme-change', event=>{
  State.settings.clockTheme = event.detail?.theme || 'emerald';
  persistSettingsFast();
});
window.addEventListener('toolify:settings-changed', ()=>persistSettingsFast());
function notesList(){
  if(!Array.isArray(State.settings.notes)) State.settings.notes = [];
  return State.settings.notes;
}
function tasksList(){
  if(!Array.isArray(State.settings.tasks)) State.settings.tasks = [];
  return State.settings.tasks;
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
