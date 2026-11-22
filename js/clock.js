/* ============================================================
   TOOLIFY — Clock / stopwatch / timer panel
   Split from the original app.js (behaviour preserved).
   ============================================================ */

function startClock(){
"use strict";

  const panel = document.getElementById("clock-panel");
  const widget = document.getElementById("clock-widget");
  if(!panel || !widget) return;

  const el = (id)=>document.getElementById(id);

  // --- Dial theme menu & internal tabs ---
  const themeToggle = el("clock-theme-toggle");
  const themeMenu = el("clock-theme-menu");
  const themeOptions = panel.querySelectorAll(".clock-theme-option");
  const tabs = panel.querySelectorAll(".clock-nav-tab");
  const panels = {
    clock: el("clock-tab-clock"),
    stopwatch: el("clock-tab-stopwatch"),
    timer: el("clock-tab-timer")
  };

  function setDialTheme(theme, persist=true){
    const valid = Array.from(themeOptions).some(option=>option.dataset.set === theme);
    const next = valid ? theme : "emerald";
    if(next === "emerald") widget.removeAttribute("data-dial-theme");
    else widget.setAttribute("data-dial-theme", next);
    themeOptions.forEach(option=>{
      const active = option.dataset.set === next;
      option.classList.toggle("active", active);
      option.setAttribute("aria-checked", String(active));
    });
    if(persist) window.dispatchEvent(new CustomEvent("toolify:clock-theme-change",{detail:{theme:next}}));
  }
  function closeThemeMenu(){
    if(!themeMenu) return;
    themeMenu.hidden = true;
    themeToggle.setAttribute("aria-expanded","false");
  }
  if(themeToggle && themeMenu){
    themeToggle.addEventListener("click", (event)=>{
      event.stopPropagation();
      const open = themeMenu.hidden;
      themeMenu.hidden = !open;
      themeToggle.setAttribute("aria-expanded", String(open));
    });
    themeOptions.forEach(option=>{
      option.addEventListener("click", ()=>{
        setDialTheme(option.dataset.set);
        closeThemeMenu();
      });
    });
    document.addEventListener("click", (event)=>{
      if(!event.target.closest(".clock-theme-picker")) closeThemeMenu();
    });
  }
  window.addEventListener("toolify:apply-clock-theme", (event)=>setDialTheme(event.detail?.theme||"emerald", false));

  tabs.forEach((tab)=>{
    tab.addEventListener("click", ()=>{
      tabs.forEach((t)=>{
        t.classList.remove("active");
        t.setAttribute("aria-selected","false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected","true");
      const target = tab.dataset.tab;
      Object.keys(panels).forEach((key)=>panels[key].classList.toggle("active", key === target));
      requestAnimationFrame(layoutAllDials);
    });
  });

  // --- Build ticks & numerals for all analog dials ---
  const allDials = panel.querySelectorAll(".clock-analog-dial");

  allDials.forEach((dial)=>{
    const ticksBox = dial.querySelector(".clock-ticks");
    for(let i=0;i<60;i++){
      const tick = document.createElement("div");
      tick.className = i % 5 === 0 ? "clock-tick major" : "clock-tick";
      tick.style.transform = `translateX(-50%) rotate(${i*6}deg)`;
      ticksBox.appendChild(tick);
    }
  });

  function layoutDial(dial){
    const numBox = dial.querySelector(".clock-numerals");
    numBox.innerHTML = "";
    const size = dial.offsetWidth || 228;
    dial.style.setProperty("--clock-dial-size", `${size}px`);
    const tickOrigin = `50% ${size/2 - 7}px`;
    dial.querySelectorAll(".clock-tick").forEach((tick)=>{ tick.style.transformOrigin = tickOrigin; });
    const radius = size * 0.345;
    const center = size / 2;
    const isChrono = dial.dataset.dial === "stopwatch";

    for(let n=1;n<=12;n++){
      const rad = ((n*30 - 90)*Math.PI)/180;
      const x = center + radius*Math.cos(rad);
      const y = center + radius*Math.sin(rad);
      const span = document.createElement("span");
      span.className = "clock-numeral" + ([12,3,6,9].includes(n) ? " cardinal" : "");
      span.textContent = isChrono ? (n === 12 ? "60" : String(n*5)) : String(n);
      span.style.left = `${x}px`;
      span.style.top = `${y}px`;
      span.style.transform = "translate(-50%, -50%)";
      numBox.appendChild(span);
    }
  }

  function layoutAllDials(){ allDials.forEach(layoutDial); }

  layoutAllDials();
  requestAnimationFrame(layoutAllDials);
  window.addEventListener("load", layoutAllDials);
  window.addEventListener("resize", layoutAllDials);
  if("MutationObserver" in window){
    new MutationObserver(()=>{ if(!panel.hidden) requestAnimationFrame(layoutAllDials); })
      .observe(panel,{attributes:true,attributeFilter:["hidden"]});
  }

  // --- 1. Clock ---
  const hourHand = el("clock-hour-hand");
  const minuteHand = el("clock-minute-hand");
  const secondHand = el("clock-second-hand");
  const dialDate = el("clock-dial-date");
  const dialMeridiem = el("clock-dial-meridiem");
  const digitalClock = el("clock-digital-clock");
  const digitalAmpm = el("clock-digital-ampm");
  const digitalDate = el("clock-digital-date");
  const tzSelect = el("clock-tz-select");
  const hourFormatBtn = el("clock-hour-format-btn");

  let is24h = false;
  let selectedTz = "local";

  hourFormatBtn.addEventListener("click", ()=>{
    is24h = !is24h;
    hourFormatBtn.textContent = is24h ? "24H" : "12H";
    hourFormatBtn.setAttribute("aria-pressed", String(is24h));
    digitalAmpm.style.display = is24h ? "none" : "inline";
  });

  tzSelect.addEventListener("change", (e)=>{ selectedTz = e.target.value; });

  // --- Orbita theme: rotating SVG ring clock ---
  const orbitaDial = el("orbita-dial");
  const orbitaRings = [];

  function orbitaNode(type, attrs, parent){
    const node = document.createElementNS("http://www.w3.org/2000/svg", type);
    Object.entries(attrs).forEach(([key,value])=>node.setAttribute(key,String(value)));
    parent.appendChild(node);
    return node;
  }

  function buildOrbitaRing(groupId, radius, numberRadius, tickCount, labelClass){
    const group = el(groupId);
    if(!group) return null;
    for(let i=0;i<tickCount;i++){
      const rad = (i*(360/tickCount)*Math.PI)/180;
      const major = tickCount === 12 || i%5 === 0;
      const length = major ? 5 : 2.4;
      orbitaNode("line",{
        x1:120+Math.cos(rad)*(radius-length),
        y1:120+Math.sin(rad)*(radius-length),
        x2:120+Math.cos(rad)*radius,
        y2:120+Math.sin(rad)*radius,
        class:major ? "orbita-major" : "orbita-tick"
      },group);
    }
    const labels = [];
    for(let i=0;i<12;i++){
      const rad = (i*30*Math.PI)/180;
      const x = 120+Math.cos(rad)*numberRadius;
      const y = 120+Math.sin(rad)*numberRadius;
      const halo = orbitaNode("circle",{cx:x,cy:y,r:8.2,class:"orbita-halo"},group);
      const text = orbitaNode("text",{x,y,class:"orbita-num "+labelClass},group);
      text.textContent = tickCount === 12 ? (i === 0 ? "1" : String(i+1)) : String(i*5);
      labels.push({element:text,halo,x,y,angle:i*30});
    }
    return {group,labels};
  }

  if(orbitaDial){
    orbitaRings.push(buildOrbitaRing("orbita-seconds-ring",103,89,60,"seconds"));
    orbitaRings.push(buildOrbitaRing("orbita-minutes-ring",77,63,60,"minutes"));
    orbitaRings.push(buildOrbitaRing("orbita-hours-ring",50,36,12,"hours"));
  }
  const orbitaDay = el("orbita-day");
  const orbitaDate = el("orbita-date");

  function rotateOrbitaRing(ring, angle){
    if(!ring || !ring.group) return;
    ring.group.setAttribute("transform",`rotate(${-angle} 120 120)`);
    let nearest = null;
    let nearestDistance = Infinity;
    ring.labels.forEach(label=>{
      label.element.setAttribute("transform",`rotate(${angle} ${label.x} ${label.y})`);
      const distance = Math.abs((((label.angle-angle)%360)+540)%360-180);
      if(distance < nearestDistance){ nearestDistance = distance; nearest = label; }
    });
    ring.labels.forEach(label=>{
      const active = label === nearest;
      label.element.classList.toggle("active",active);
      if(label.halo) label.halo.classList.toggle("active",active);
    });
  }

  const orbitaSweep = el("orbita-sweep");

  function renderOrbita(dayLong, dateLong, secSmooth, minSmooth, hrSmooth){
    if(!orbitaDial || widget.getAttribute("data-dial-theme") !== "orbita") return;
    rotateOrbitaRing(orbitaRings[0],secSmooth*6);
    rotateOrbitaRing(orbitaRings[1],minSmooth*6);
    rotateOrbitaRing(orbitaRings[2],((hrSmooth-1+12)%12)*30);
    if(orbitaSweep) orbitaSweep.style.transform = `rotate(${secSmooth*6}deg)`;
    if(orbitaDay) orbitaDay.textContent = dayLong;
    if(orbitaDate) orbitaDate.textContent = dateLong;
  }

  function getClockParts(now, tz){
    if(tz === "local"){
      return {
        h:now.getHours(), m:now.getMinutes(), s:now.getSeconds(), ms:now.getMilliseconds(),
        dayNum:String(now.getDate()),
        dateText:now.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}),
        dayLong:now.toLocaleDateString("en-US",{weekday:"long"}).toUpperCase(),
        dateLong:now.toLocaleDateString("en-US",{day:"2-digit",month:"long",year:"numeric"}).toUpperCase()
      };
    }
    const fmt = new Intl.DateTimeFormat("en-US",{
      timeZone:tz, hour12:false, year:"numeric", month:"short", day:"numeric", weekday:"short",
      hour:"2-digit", minute:"2-digit", second:"2-digit"
    });
    const map = Object.fromEntries(fmt.formatToParts(now).map((p)=>[p.type,p.value]));
    let h = parseInt(map.hour,10);
    if(h === 24) h = 0;
    const mapLong = Object.fromEntries(new Intl.DateTimeFormat("en-US",{
      timeZone:tz, weekday:"long", day:"2-digit", month:"long", year:"numeric"
    }).formatToParts(now).map((p)=>[p.type,p.value]));
    return {
      h, m:parseInt(map.minute,10), s:parseInt(map.second,10), ms:now.getMilliseconds(),
      dayNum:map.day, dateText:`${map.weekday}, ${map.month} ${map.day}`,
      dayLong:mapLong.weekday.toUpperCase(),
      dateLong:`${mapLong.day} ${mapLong.month} ${mapLong.year}`.toUpperCase()
    };
  }

  function updateClock(now){
    const parts = getClockParts(now, selectedTz);
    const {h,m,s,ms,dayNum,dateText} = parts;
    const secSmooth = s + ms/1000;
    const minSmooth = m + secSmooth/60;
    const hrSmooth = (h%12) + minSmooth/60;

    secondHand.style.transform = `translateX(-50%) rotate(${secSmooth*6}deg)`;
    minuteHand.style.transform = `translateX(-50%) rotate(${minSmooth*6}deg)`;
    hourHand.style.transform = `translateX(-50%) rotate(${hrSmooth*30}deg)`;

    const ampm = h >= 12 ? "PM" : "AM";
    const dispH = is24h ? String(h).padStart(2,"0") : String(h%12 || 12).padStart(2,"0");
    digitalClock.textContent = `${dispH}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    digitalAmpm.textContent = ampm;
    digitalDate.textContent = dateText;
    dialDate.textContent = dayNum;
    dialMeridiem.textContent = ampm;
    renderOrbita(parts.dayLong,parts.dateLong,secSmooth,minSmooth,hrSmooth);
  }

  // --- 2. Stopwatch (analog + digital) ---
  const swSecHand = el("clock-sw-sec-hand");
  const swSubHand = el("clock-sw-sub-hand");
  const swDialState = el("clock-sw-dial-state");
  const swMain = el("clock-sw-main");
  const swCs = el("clock-sw-cs");
  const swStatus = el("clock-sw-status");
  const swStartBtn = el("clock-sw-start-btn");
  const swLapBtn = el("clock-sw-lap-btn");
  const swResetBtn = el("clock-sw-reset-btn");
  const swLapsEl = el("clock-sw-laps");

  let swRunning = false, swStartPerf = 0, swElapsedMs = 0, swLastLapTotal = 0, laps = [];

  function renderStopwatchVisual(elapsed){
    const totalHundredths = Math.floor(elapsed/10);
    const hundredths = totalHundredths%100;
    const totalSec = Math.floor(totalHundredths/100);
    const sec = totalSec%60;
    const min = Math.floor(totalSec/60);

    swSecHand.style.transform = `translateX(-50%) rotate(${((elapsed/1000)%60)*6}deg)`;
    swSubHand.style.transform = `translateX(-50%) rotate(${((elapsed/60000)%60)*6}deg)`;
    swMain.textContent = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}.${Math.floor(hundredths/10)}`;
    swCs.textContent = String(hundredths%10);
  }

  function formatLapDuration(ms){
    const totalSec = Math.floor(ms/1000);
    const cs = Math.floor((ms%1000)/10);
    return `${String(Math.floor(totalSec/60)).padStart(2,"0")}:${String(totalSec%60).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
  }

  function renderLaps(){
    if(!laps.length){ swLapsEl.innerHTML = '<div class="clock-laps-empty">No laps recorded yet</div>'; return; }
    const durations = laps.map((l)=>l.duration);
    const minDur = durations.length >= 2 ? Math.min(...durations) : null;
    const maxDur = durations.length >= 2 ? Math.max(...durations) : null;
    swLapsEl.innerHTML = laps.slice().reverse().map((lap)=>{
      let tag = "";
      if(minDur !== null && maxDur !== null && minDur !== maxDur){
        if(lap.duration === minDur) tag = '<span class="clock-lap-tag clock-lap-fast">Fastest</span>';
        else if(lap.duration === maxDur) tag = '<span class="clock-lap-tag clock-lap-slow">Slowest</span>';
      }
      return `<div class="clock-lap-row"><span class="clock-lap-index">Lap ${lap.num}${tag}</span><strong>${formatLapDuration(lap.duration)}</strong></div>`;
    }).join("");
  }

  swStartBtn.addEventListener("click", ()=>{
    if(!swRunning){
      swRunning = true;
      swStartPerf = performance.now() - swElapsedMs;
      swStartBtn.textContent = "Pause";
      swLapBtn.disabled = false;
      swStatus.textContent = "Running";
      swDialState.textContent = "RUN";
    }else{
      swRunning = false;
      swElapsedMs = performance.now() - swStartPerf;
      swStartBtn.textContent = "Resume";
      swLapBtn.disabled = true;
      swStatus.textContent = "Paused";
      swDialState.textContent = "HOLD";
    }
  });

  swLapBtn.addEventListener("click", ()=>{
    if(!swRunning) return;
    const currentTotal = performance.now() - swStartPerf;
    laps.push({num:laps.length+1, duration:currentTotal - swLastLapTotal});
    swLastLapTotal = currentTotal;
    renderLaps();
  });

  swResetBtn.addEventListener("click", ()=>{
    swRunning = false;
    swElapsedMs = 0;
    swLastLapTotal = 0;
    laps = [];
    swStartBtn.textContent = "Start";
    swLapBtn.disabled = true;
    swStatus.textContent = "Ready";
    swDialState.textContent = "READY";
    renderStopwatchVisual(0);
    renderLaps();
  });

  // --- 3. Timer (analog + digital) ---
  const tmHr = el("clock-tm-hr");
  const tmMin = el("clock-tm-min");
  const tmSec = el("clock-tm-sec");
  const tmSecHand = el("clock-tm-sec-hand");
  const tmRing = el("clock-tm-ring");
  const tmDialState = el("clock-tm-dial-state");
  const tmDisplay = el("clock-tm-display");
  const tmStatus = el("clock-tm-status");
  const tmStartBtn = el("clock-tm-start-btn");
  const tmResetBtn = el("clock-tm-reset-btn");
  const presetChips = panel.querySelectorAll(".clock-preset-chip");

  let tmTotalMs = 5*60*1000, tmRemainingMs = tmTotalMs, tmRunning = false, tmEndPerf = 0;

  function playChime(){
    try{
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [523.25,659.25,783.99].forEach((freq,idx)=>{
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(.08,ctx.currentTime + idx*.16);
        gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime + idx*.16 + .5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx*.16);
        osc.stop(ctx.currentTime + idx*.16 + .55);
      });
    }catch(_){}
  }

  function formatTimer(ms){
    const clamped = Math.max(0,Math.ceil(ms/1000));
    const h = Math.floor(clamped/3600);
    const m = Math.floor((clamped%3600)/60);
    const s = clamped%60;
    if(h > 0) return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  function renderTimerVisual(remMs,totalMs){
    const formatted = formatTimer(remMs);
    tmDisplay.textContent = formatted;
    tmDialState.textContent = formatted;
    tmSecHand.style.transform = `translateX(-50%) rotate(${((remMs/1000)%60)*6}deg)`;
    const ratio = totalMs > 0 ? Math.max(0,Math.min(1,remMs/totalMs)) : 0;
    tmRing.style.setProperty("--timer-angle",`${ratio*360}deg`);
  }

  function syncTimerFromInputs(){
    const h = Math.max(0,Math.min(23,parseInt(tmHr.value,10) || 0));
    const m = Math.max(0,Math.min(59,parseInt(tmMin.value,10) || 0));
    const s = Math.max(0,Math.min(59,parseInt(tmSec.value,10) || 0));
    tmTotalMs = (h*3600 + m*60 + s)*1000;
    tmRemainingMs = tmTotalMs;
    renderTimerVisual(tmRemainingMs,tmTotalMs);
    tmStatus.textContent = tmTotalMs > 0 ? "Ready to start" : "Enter a duration above";
  }

  [tmHr,tmMin,tmSec].forEach((input)=>{
    input.addEventListener("change",()=>{ if(!tmRunning) syncTimerFromInputs(); });
  });

  presetChips.forEach((chip)=>{
    chip.addEventListener("click",()=>{
      tmRunning = false;
      tmStartBtn.textContent = "Start";
      const sec = parseInt(chip.dataset.seconds,10);
      tmHr.value = Math.floor(sec/3600);
      tmMin.value = Math.floor((sec%3600)/60);
      tmSec.value = sec%60;
      syncTimerFromInputs();
    });
  });

  tmStartBtn.addEventListener("click",()=>{
    if(!tmRunning){
      if(tmRemainingMs <= 0) syncTimerFromInputs();
      if(tmRemainingMs <= 0) return;
      tmRunning = true;
      tmEndPerf = performance.now() + tmRemainingMs;
      tmStartBtn.textContent = "Pause";
      tmStatus.textContent = "Counting down";
    }else{
      tmRunning = false;
      tmRemainingMs = Math.max(0,tmEndPerf - performance.now());
      tmStartBtn.textContent = "Resume";
      tmStatus.textContent = "Paused";
    }
  });

  tmResetBtn.addEventListener("click",()=>{
    tmRunning = false;
    tmStartBtn.textContent = "Start";
    syncTimerFromInputs();
  });

  // --- Master animation loop ---
  renderStopwatchVisual(0);
  syncTimerFromInputs();

  function masterLoop(nowPerf){
    updateClock(new Date());
    if(swRunning){ swElapsedMs = nowPerf - swStartPerf; renderStopwatchVisual(swElapsedMs); }
    if(tmRunning){
      const rem = tmEndPerf - nowPerf;
      if(rem <= 0){
        tmRunning = false;
        tmRemainingMs = 0;
        renderTimerVisual(0,tmTotalMs);
        tmStatus.textContent = "Time is up";
        tmStartBtn.textContent = "Start";
        playChime();
      }else{
        tmRemainingMs = rem;
        renderTimerVisual(rem,tmTotalMs);
      }
    }
    requestAnimationFrame(masterLoop);
  }

  requestAnimationFrame(masterLoop);
}
