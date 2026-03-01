'use strict';

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════
const C = {
  LAB_COST:           500,
  CREDITS_BASE:       5,
  CREDITS_PER_LAB:    3,
  SCI_PER_LAB:        0.04,   // per second per active lab
  ASSEMBLY_TIME:      240000, // 4 minutes
  AI_TICK:            20000,
  DETECT_CHANCE:      0.30,
  SABOTAGE_DUR:       120000, // 2 minutes
  RECON_RADIUS:       0.32,   // chord distance on unit sphere ≈ ~2000 km
  JAMMER_COST:        600,
  SWEEP_COST:         1500,
  JAMMER_RADIUS:      0.22,   // effect radius (chord distance)
  SWEEP_RADIUS:       0.20,   // per-lab scan radius
  JAMMER_DEF_PENALTY: 0.28,   // op success reduction near friendly jammer
  SILO_COST:          1200,
  REACTOR_COST:       700,
  DU_PER_REACTOR:     0.10,   // depleted uranium per second per reactor
};

// Nation capitals for ICBM targeting
const NATION_CAPITALS = {
  USA:    { lat: 38.9,  lon: -77.0 },   // Washington DC
  RUSSIA: { lat: 55.75, lon:  37.6 },   // Moscow
};

const OPS = {
  RECON:    { cost: 300, duration: 45000,  success: 0.65 },
  STEAL:    { cost: 500, duration: 70000,  success: 0.45 },
  SABOTAGE: { cost: 700, duration: 30000,  success: 0.40 },
};

let _uid = 0;
const uid = () => ++_uid;

// ── Nation selection ───────────────────────────────────────────
let playerNation = null;
let nationBonuses = { RECON: 0, STEAL: 0, SABOTAGE: 0 };

function selectNation(nation) {
  playerNation = nation;
  applySettings();
  document.getElementById('nation-screen').style.display = 'none';

  const flag = nation === 'USA' ? '🇺🇸' : '🇷🇺';
  const name = nation === 'USA' ? 'USA'  : 'RUSSIA';
  document.getElementById('h-flag').textContent   = flag;
  document.getElementById('h-nation').textContent = name;

  if (nation === 'USA')    nationBonuses.RECON    = 0.05;
  if (nation === 'RUSSIA') nationBonuses.SABOTAGE = 0.05;

  // In multiplayer (host only), tell guest which nation the host chose
  if (MP.active && MP.isHost) {
    const remoteNation = nation === 'USA' ? 'RUSSIA' : 'USA';
    MP.remoteNation = remoteNation;
    MP.remoteNationBonuses.RECON    = remoteNation === 'USA'    ? 0.05 : 0;
    MP.remoteNationBonuses.SABOTAGE = remoteNation === 'RUSSIA' ? 0.05 : 0;
    MP.send('GAME_START', { nation });
  }

  init();
}

// ═══════════════════════════════════════════════════════════════
//  SETTINGS + MENU NAVIGATION
// ═══════════════════════════════════════════════════════════════
const SETTINGS = {
  difficulty: 'normal',  // easy | normal | hard
  speed:      'normal',  // short | normal | long
  autoSpin:   true,
  sound:      true,
};

function applySettings() {
  const sm = { short: 2.5, normal: 1.0, long: 0.5 }[SETTINGS.speed];
  C.SCI_PER_LAB     = +(0.04  * sm).toFixed(4);
  C.DU_PER_REACTOR  = +(0.10  * sm).toFixed(4);
  C.CREDITS_BASE    = Math.round(5 * sm);
  C.CREDITS_PER_LAB = Math.round(3 * sm);
  C.ASSEMBLY_TIME   = Math.round(240000 / sm);
  C.SABOTAGE_DUR    = Math.round(120000 / sm);
  const dm = { easy: 2.0, normal: 1.0, hard: 0.55 }[SETTINGS.difficulty];
  C.AI_TICK = Math.round(20000 * dm);
}

function setSetting(key, val) {
  SETTINGS[key] = val;
  document.querySelectorAll(`.sopt[data-key="${key}"]`).forEach(el => {
    el.classList.toggle('active', el.dataset.val === String(val));
  });
  const diffDesc = {
    easy:   'Slow AI — builds infrequently and rarely launches operations.',
    normal: 'Balanced — AI builds and operates at normal speed.',
    hard:   'Aggressive AI — builds fast and launches operations frequently.',
  };
  const speedDesc = {
    short:  'Fast pacing — labs and reactors generate resources at 2.5× rate.',
    normal: 'Standard pacing — resources generate at normal rate.',
    long:   'Slow pacing — resources at half rate, longer strategic game.',
  };
  const dd = document.getElementById('desc-difficulty');
  const sd = document.getElementById('desc-speed');
  if (dd) dd.textContent = diffDesc[SETTINGS.difficulty];
  if (sd) sd.textContent = speedDesc[SETTINGS.speed];
}

function showMainMenu() {
  document.getElementById('main-menu').style.display       = 'flex';
  document.getElementById('help-screen').style.display     = 'none';
  document.getElementById('settings-screen').style.display = 'none';
  document.getElementById('nation-screen').style.display   = 'none';
  document.getElementById('mp-screen').style.display       = 'none';
}

function showMp() {
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('mp-screen').style.display = 'flex';
}

function showNationSelect() {
  document.getElementById('main-menu').style.display     = 'none';
  document.getElementById('nation-screen').style.display = 'flex';
}

function showHelp() {
  document.getElementById('main-menu').style.display   = 'none';
  document.getElementById('help-screen').style.display = 'flex';
}

function showSettings() {
  document.getElementById('main-menu').style.display       = 'none';
  document.getElementById('settings-screen').style.display = 'flex';
}

// ═══════════════════════════════════════════════════════════════
//  REGIONS
// ═══════════════════════════════════════════════════════════════
const REGIONS = {
  NA:  { id:'NA',  name:'North America',       latMin:20,  latMax:72,  lonMin:-170, lonMax:-52,  color:0x3d6b45 },
  SAM: { id:'SAM', name:'South America',       latMin:-56, latMax:14,  lonMin:-82,  lonMax:-33,  color:0x4a7038 },
  WEU: { id:'WEU', name:'Western Europe',      latMin:35,  latMax:71,  lonMin:-15,  lonMax:25,   color:0x3a527a },
  EEU: { id:'EEU', name:'Eastern Europe',      latMin:40,  latMax:65,  lonMin:25,   lonMax:50,   color:0x363a6a },
  RUS: { id:'RUS', name:'Russia',              latMin:50,  latMax:78,  lonMin:50,   lonMax:180,  color:0x4c4840 },
  MEA: { id:'MEA', name:'Middle East',         latMin:12,  latMax:42,  lonMin:25,   lonMax:65,   color:0x7c6028 },
  NAF: { id:'NAF', name:'North Africa',        latMin:14,  latMax:38,  lonMin:-18,  lonMax:40,   color:0x967830 },
  SSA: { id:'SSA', name:'Sub-Saharan Africa',  latMin:-36, latMax:14,  lonMin:-18,  lonMax:52,   color:0x5c4228 },
  CAS: { id:'CAS', name:'Central Asia',        latMin:35,  latMax:56,  lonMin:50,   lonMax:90,   color:0x685240 },
  SAS: { id:'SAS', name:'South Asia',          latMin:5,   latMax:38,  lonMin:65,   lonMax:100,  color:0x4c6a28 },
  EAS: { id:'EAS', name:'East Asia',           latMin:18,  latMax:55,  lonMin:100,  lonMax:145,  color:0x2e5c78 },
  SEA: { id:'SEA', name:'Southeast Asia',      latMin:-10, latMax:25,  lonMin:95,   lonMax:142,  color:0x2e7050 },
  OCE: { id:'OCE', name:'Oceania',             latMin:-46, latMax:-10, lonMin:110,  lonMax:178,  color:0x245868 },
  JAP: { id:'JAP', name:'Japan / Korea',       latMin:30,  latMax:50,  lonMin:126,  lonMax:148,  color:0x3c3870 },
  ARC: { id:'ARC', name:'Arctic',              latMin:78,  latMax:90,  lonMin:-180, lonMax:180,  color:0x606a78 },
};

// Priority order: more specific regions first
const REGION_ORDER = ['JAP','ARC','NA','SAM','WEU','EEU','RUS','MEA','NAF','SSA','CAS','SAS','EAS','SEA','OCE'];

function getRegion(lat, lon) {
  for (const k of REGION_ORDER) {
    const r = REGIONS[k];
    if (lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax) return r;
  }
  return null;
}

function randInRegion(r) {
  return {
    lat: r.latMin + Math.random() * (r.latMax - r.latMin),
    lon: r.lonMin + Math.random() * (r.lonMax - r.lonMin),
  };
}

// ═══════════════════════════════════════════════════════════════
//  GAME CLASSES
// ═══════════════════════════════════════════════════════════════
class Lab {
  constructor(lat, lon, region, ownerId) {
    this.id = uid();
    this.lat = lat; this.lon = lon;
    this.region = region;
    this.ownerId = ownerId;
    this.disabledUntil = 0;
    this.marker = null;
  }
  isActive() { return Date.now() >= this.disabledUntil; }
}

class Operation {
  constructor(type, lat, lon, region) {
    this.id = uid();
    this.type = type;
    this.lat = lat; this.lon = lon;
    this.region = region;
    this.startTime = Date.now();
    this.duration = OPS[type].duration;
    this.done = false;
    this.ring = null;
  }
  progress() { return Math.min(1, (Date.now() - this.startTime) / this.duration); }
  isComplete() { return Date.now() >= this.startTime + this.duration; }
}

class Jammer {
  constructor(lat, lon, region, ownerId) {
    this.id      = uid();
    this.lat     = lat;  this.lon = lon;
    this.region  = region;
    this.ownerId = ownerId;
    this.marker  = null;
  }
}

class Reactor {
  constructor(lat, lon, region, ownerId) {
    this.id      = uid();
    this.lat     = lat;  this.lon = lon;
    this.region  = region;
    this.ownerId = ownerId;
    this.marker  = null;
  }
}

class Silo {
  constructor(lat, lon, region, ownerId) {
    this.id      = uid();
    this.lat     = lat;  this.lon = lon;
    this.region  = region;
    this.ownerId = ownerId;
    this.marker  = null;
  }
}

class Player {
  constructor(id, isHuman) {
    this.id = id;
    this.isHuman = isHuman;
    this.credits = 500;
    this.creditsPerSec = C.CREDITS_BASE;
    this.science = 0;
    this.labs = [];
    this.ops = [];
    this.jammers = [];
    this.reactors = [];
    this.silo = null;
    this.depletedUranium = 0;
    this.revealedEnemyJammers = [];
    this.revealedEnemyReactors = [];
    this.revealedEnemySilo = null;
    this.revealedEnemyLabs = [];     // { lab }
    this.knownEnemyRegions = new Set();
    this.estimatedEnemySci = { min: 0, max: 30 };
    this.assembling = false;
    this.assemblyStart = 0;
    this.assemblyDone = false;
  }
  activeLabs() { return this.labs.filter(l => l.isActive()); }
  addLab(lab) {
    this.labs.push(lab);
    this.creditsPerSec = C.CREDITS_BASE + this.labs.length * C.CREDITS_PER_LAB;
  }
  startAssembly() {
    if (this.science >= 100 && this.depletedUranium >= 100 && this.silo &&
        !this.assembling && !this.assemblyDone) {
      this.assembling = true; this.assemblyStart = Date.now(); return true;
    }
    return false;
  }
  assemblyProg() {
    if (!this.assembling) return 0;
    return Math.min(1, (Date.now() - this.assemblyStart) / C.ASSEMBLY_TIME);
  }
  interruptAssembly() {
    if (this.assembling) { this.assembling = false; this.assemblyStart = 0; return true; }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  GAME STATE + LOOP
// ═══════════════════════════════════════════════════════════════
const state = {
  player:      null,
  ai:          null,
  gameOver:    false,
  buildMode:   false,
  jammerMode:  false,
  reactorMode: false,
  siloMode:    false,
  pendingOp:   null,
  lastUpdate:  0,
  lastAiTick:  0,
};

let _lastAssemblyTick = 0;

// Fog marker tracking
const fogMarkers = [];

function refreshFogMarkers() {
  // Remove old fog markers
  for (const m of fogMarkers) MARKERS.remove(m);
  fogMarkers.length = 0;

  for (const regionId of state.player.knownEnemyRegions) {
    const region = REGIONS[regionId];
    if (!region) continue;
    const aiLabsHere = state.ai.labs.filter(l => l.region?.id === regionId);
    const revealedHere = state.player.revealedEnemyLabs.filter(r => r.lab.region?.id === regionId);
    if (aiLabsHere.length > revealedHere.length) {
      const clat = (region.latMin + region.latMax) / 2;
      const clon = (region.lonMin + region.lonMax) / 2;
      const m = createFogMarker(clat, clon, regionId);
      fogMarkers.push(m);
    }
  }
}

function update() {
  if (state.gameOver || !state.player || !state.ai) return;
  const now = Date.now();
  const dt  = (now - state.lastUpdate) / 1000;
  state.lastUpdate = now;

  const { player, ai } = state;

  // Accumulate credits (local player always; AI only in single-player)
  player.credits += player.creditsPerSec * dt;
  if (!MP.active) ai.credits += ai.creditsPerSec * dt;

  // Accumulate science (each lab checked for enemy jammer overlap → 50% penalty)
  let pSciGain = 0;
  for (const lab of player.activeLabs()) {
    const lv   = ll2v3(lab.lat, lab.lon);
    const mult = ai.jammers.some(j => lv.distanceTo(ll2v3(j.lat, j.lon)) <= C.JAMMER_RADIUS) ? 0.5 : 1.0;
    pSciGain  += C.SCI_PER_LAB * mult;
  }
  player.science = Math.min(100, player.science + pSciGain * dt);
  if (!MP.active) {
    let aSciGain = 0;
    for (const lab of ai.activeLabs()) {
      const lv   = ll2v3(lab.lat, lab.lon);
      const mult = player.jammers.some(j => lv.distanceTo(ll2v3(j.lat, j.lon)) <= C.JAMMER_RADIUS) ? 0.5 : 1.0;
      aSciGain  += C.SCI_PER_LAB * mult;
    }
    ai.science = Math.min(100, ai.science + aSciGain * dt);
  }

  // Accumulate depleted uranium from reactors (jammer penalty applies)
  let pDUGain = 0;
  for (const r of player.reactors) {
    const rv   = ll2v3(r.lat, r.lon);
    const mult = ai.jammers.some(j => rv.distanceTo(ll2v3(j.lat, j.lon)) <= C.JAMMER_RADIUS) ? 0.5 : 1.0;
    pDUGain   += C.DU_PER_REACTOR * mult;
  }
  player.depletedUranium = Math.min(100, player.depletedUranium + pDUGain * dt);
  if (!MP.active) {
    let aDUGain = 0;
    for (const r of ai.reactors) {
      const rv   = ll2v3(r.lat, r.lon);
      const mult = player.jammers.some(j => rv.distanceTo(ll2v3(j.lat, j.lon)) <= C.JAMMER_RADIUS) ? 0.5 : 1.0;
      aDUGain   += C.DU_PER_REACTOR * mult;
    }
    ai.depletedUranium = Math.min(100, ai.depletedUranium + aDUGain * dt);
  }

  // Refresh disabled-lab marker colours
  for (const lab of player.labs) {
    if (lab.marker) setMarkerEnabled(lab.marker, lab.isActive());
  }

  // AI tick (single-player only)
  if (!MP.active && now - state.lastAiTick > C.AI_TICK) {
    state.lastAiTick = now;
    aiTick();
  }

  // Fuzzy drift of enemy science estimate (single-player only — MP uses SYNC)
  if (!MP.active && Math.random() < dt * 0.08) {
    const noise = (Math.random() - 0.5) * 12;
    player.estimatedEnemySci.min = Math.max(0,   ai.science - 20 + noise);
    player.estimatedEnemySci.max = Math.min(100, ai.science + 20 + noise);
  }

  // Assembly button: show when science is 100% (click reveals missing requirements)
  document.getElementById('btn-asm').style.display =
    (player.science >= 100 && !player.assembling && !player.assemblyDone) ? 'block' : 'none';

  // Check win
  // Assembly countdown tick (every 10s)
  if (player.assembling && !player.assemblyDone) {
    if (now - _lastAssemblyTick >= 10000) { _lastAssemblyTick = now; SFX.assemblyTick(); }
  } else if (!player.assembling) {
    _lastAssemblyTick = 0;
  }

  if (player.assembling && player.assemblyProg() >= 1) {
    player.assemblyDone = true;
    endGame(true);
    return;
  }
  if (ai.assembling && ai.assemblyProg() >= 1) {
    ai.assemblyDone = true;
    endGame(false);
    return;
  }

  updateUI();
}

function updateUI() {
  const p = state.player;

  document.getElementById('h-cred').textContent    = `${Math.floor(p.credits)}c`;
  document.getElementById('h-cps').textContent     = `+${p.creditsPerSec.toFixed(0)}/s`;
  document.getElementById('h-sci').textContent     = `${p.science.toFixed(1)}%`;
  document.getElementById('h-sci-bar').style.width = `${p.science}%`;

  document.getElementById('h-du').textContent      = `${p.depletedUranium.toFixed(1)}%`;
  document.getElementById('h-du-bar').style.width  = `${Math.min(100, p.depletedUranium)}%`;

  const siloLbl = document.getElementById('h-silo-lbl');
  if (p.silo) {
    siloLbl.textContent = 'Silo — ready ✓';
    siloLbl.style.color = '#44ccaa';
  } else {
    siloLbl.textContent = 'Silo — not built';
    siloLbl.style.color = '#4a6a8a';
  }

  const eMin = Math.floor(p.estimatedEnemySci.min);
  const eMax = Math.floor(p.estimatedEnemySci.max);
  document.getElementById('h-enemy').textContent        = `~${eMin}–${eMax}%`;
  document.getElementById('h-enemy-bar').style.width    = `${(eMin + eMax) / 2}%`;

  if (p.assembling) {
    document.getElementById('assembly-display').classList.add('show');
    const ap = Math.floor(p.assemblyProg() * 100);
    document.getElementById('h-asm').textContent     = `${ap}%`;
    document.getElementById('h-asm-bar').style.width = `${ap}%`;
  }

  // Left sidebar
  const al = p.activeLabs().length;
  document.getElementById('sl-labs').textContent =
    `Labs: ${p.labs.length} (${al} active) · Jammers: ${p.jammers.length}` +
    `\nReactors: ${p.reactors.length} · Silo: ${p.silo ? '✓ placed' : 'none'}`;

  let effectiveSciRate = 0;
  for (const lab of p.activeLabs()) {
    const lv   = ll2v3(lab.lat, lab.lon);
    const mult = state.ai.jammers.some(j => lv.distanceTo(ll2v3(j.lat, j.lon)) <= C.JAMMER_RADIUS) ? 0.5 : 1.0;
    effectiveSciRate += C.SCI_PER_LAB * mult;
  }
  const nominalRate = al * C.SCI_PER_LAB;
  const duRate = p.reactors.length * C.DU_PER_REACTOR;
  document.getElementById('sl-rate').textContent =
    (effectiveSciRate < nominalRate - 0.001
      ? `${effectiveSciRate.toFixed(3)} sci/s ⚡`
      : `${effectiveSciRate.toFixed(3)} sci/s`) +
    `\n${duRate.toFixed(2)} uranium/s`;

  const detailLines = p.labs.map(l => {
    const lv       = ll2v3(l.lat, l.lon);
    const isJammed = state.ai.jammers.some(j => lv.distanceTo(ll2v3(j.lat, j.lon)) <= C.JAMMER_RADIUS);
    const status   = !l.isActive() ? '⏸ sabotaged' : isJammed ? '📡 jammed' : '✓';
    return `• Lab ${l.region ? l.region.name.split(' ')[0] : '?'} ${status}`;
  });
  for (const r of p.reactors) {
    detailLines.push(`• Reactor ${r.region ? r.region.name.split(' ')[0] : '?'} ✓`);
  }
  if (p.silo) {
    detailLines.push(`• Silo ${p.silo.region ? p.silo.region.name.split(' ')[0] : '?'} ✓`);
  }
  document.getElementById('sl-detail').textContent = detailLines.join('\n');

  // Button states
  document.getElementById('btn-build').disabled    = p.credits < nextLabCost(p);
  document.getElementById('btn-jammer').disabled   = p.credits < C.JAMMER_COST;
  document.getElementById('btn-reactor').disabled  = p.credits < C.REACTOR_COST;
  document.getElementById('btn-silo').disabled     = p.credits < C.SILO_COST || !!p.silo;
  document.getElementById('btn-recon').disabled    = p.credits < OPS.RECON.cost;
  document.getElementById('btn-steal').disabled    = p.credits < OPS.STEAL.cost;
  document.getElementById('btn-sabotage').disabled = p.credits < OPS.SABOTAGE.cost;
  document.getElementById('btn-sweep').disabled    = p.credits < C.SWEEP_COST;

  // Active ops
  const activeOps = p.ops.filter(o => !o.done);
  const opsEl = document.getElementById('sr-ops');
  if (!activeOps.length) {
    opsEl.innerHTML = '<div class="sec-info">—</div>';
  } else {
    opsEl.innerHTML = activeOps.map(o => `
      <div class="op-card">
        ${o.type} → ${o.region ? o.region.name.split(' ')[0] : '?'}
        <div class="op-bar"><div class="op-fill" style="width:${o.progress() * 100}%"></div></div>
      </div>`).join('');
  }

  // Intel
  const intel          = p.revealedEnemyLabs;
  const jammerIntel    = p.revealedEnemyJammers;
  const reactorIntel   = p.revealedEnemyReactors;
  const siloIntel      = p.revealedEnemySilo;
  const intelEl        = document.getElementById('sr-intel');
  const hasIntel = intel.length || jammerIntel.length || reactorIntel.length || siloIntel;
  if (!hasIntel) {
    intelEl.textContent = 'No intel. Use RECON or SWEEP to gather data.';
  } else {
    let txt = '';
    if (intel.length) {
      txt += `${intel.length} lab(s) located:\n` +
        intel.map(r => `• ${r.lab.region ? r.lab.region.name : '?'} (${r.lab.lat.toFixed(0)}°, ${r.lab.lon.toFixed(0)}°)`).join('\n');
    }
    if (jammerIntel.length) {
      if (txt) txt += '\n';
      txt += `${jammerIntel.length} jammer(s) found:\n` +
        jammerIntel.map(j => `• ${j.region ? j.region.name : '?'} (${j.lat.toFixed(0)}°, ${j.lon.toFixed(0)}°) ← SABOTAGE`).join('\n');
    }
    if (reactorIntel.length) {
      if (txt) txt += '\n';
      txt += `${reactorIntel.length} reactor(s) located:\n` +
        reactorIntel.map(r => `• ${r.region ? r.region.name : '?'} (${r.lat.toFixed(0)}°, ${r.lon.toFixed(0)}°) ← SABOTAGE`).join('\n');
    }
    if (siloIntel) {
      if (txt) txt += '\n';
      txt += `Enemy silo located:\n• ${siloIntel.region ? siloIntel.region.name : '?'} (${siloIntel.lat.toFixed(0)}°, ${siloIntel.lon.toFixed(0)}°) ← SABOTAGE`;
    }
    intelEl.textContent = txt;
  }
}

// ═══════════════════════════════════════════════════════════════
//  CLICK HANDLING
// ═══════════════════════════════════════════════════════════════
function handleClick(e) {
  closeCtx();
  const hit = raycastSphere(e.clientX, e.clientY);
  if (!hit) return;
  const { lat, lon } = hit;
  const region = getRegion(lat, lon);

  if (state.siloMode)    { doBuildSilo(lat, lon, region);    exitSiloMode();    return; }
  if (state.reactorMode) { doBuildReactor(lat, lon, region); exitReactorMode(); return; }
  if (state.jammerMode)  { doBuildJammer(lat, lon, region);  exitJammerMode();  return; }

  if (state.buildMode) {
    doBuildLab(lat, lon, region);
    exitBuildMode();
    return;
  }

  if (state.pendingOp) {
    SFX.opLaunch();
    doLaunchOp(state.pendingOp, lat, lon, region);
    state.pendingOp = null;
    clearOpBtns();
    return;
  }

  openCtxMenu(e.clientX, e.clientY, lat, lon, region);
}

// ═══════════════════════════════════════════════════════════════
//  CONTEXT MENU
// ═══════════════════════════════════════════════════════════════
const ctxEl = document.getElementById('ctx-menu');
let ctxTarget = { lat: 0, lon: 0, region: null };

function openCtxMenu(px, py, lat, lon, region) {
  ctxTarget = { lat, lon, region };
  const p = state.player;
  const canLab     = p.credits >= nextLabCost(p)  && isOnLand(lat, lon);
  const canJam     = p.credits >= C.JAMMER_COST  && isOnLand(lat, lon);
  const canReactor = p.credits >= C.REACTOR_COST && isOnLand(lat, lon);
  const canSilo    = p.credits >= C.SILO_COST    && isOnLand(lat, lon) && !p.silo;
  const canR    = p.credits >= OPS.RECON.cost;
  const canSt   = p.credits >= OPS.STEAL.cost;
  const canSab  = p.credits >= OPS.SABOTAGE.cost;
  const rname   = region ? region.name : 'Ocean';

  ctxEl.innerHTML = `
    <div class="ctx-hdr">${rname} — ${lat.toFixed(1)}°, ${lon.toFixed(1)}°</div>
    <div class="ctx-row ${canLab ? '' : 'off'}" id="ctx-lab">
      Place Lab <span class="ctx-c">500c</span>
    </div>
    <div class="ctx-row ${canJam ? '' : 'off'}" id="ctx-jammer">
      Deploy Jammer <span class="ctx-c">${C.JAMMER_COST}c</span>
    </div>
    <div class="ctx-row ${canReactor ? '' : 'off'}" id="ctx-reactor">
      Build Reactor <span class="ctx-c">${C.REACTOR_COST}c</span>
    </div>
    <div class="ctx-row ${canSilo ? '' : 'off'}" id="ctx-silo">
      Build Silo <span class="ctx-c">${C.SILO_COST}c</span>
    </div>
    <hr class="ctx-div">
    <div class="ctx-row ${canR   ? '' : 'off'}" id="ctx-recon">
      RECON <span class="ctx-c">300c · 65%</span>
    </div>
    <div class="ctx-row ${canSt  ? '' : 'off'}" id="ctx-steal">
      STEAL <span class="ctx-c">500c · 45%</span>
    </div>
    <div class="ctx-row ${canSab ? '' : 'off'}" id="ctx-sab">
      SABOTAGE <span class="ctx-c">700c · 40%</span>
    </div>
  `;

  if (canLab)  ctxEl.querySelector('#ctx-lab').onclick    = () => { closeCtx(); doBuildLab(ctxTarget.lat, ctxTarget.lon, ctxTarget.region); };
  if (canJam)     ctxEl.querySelector('#ctx-jammer').onclick  = () => { closeCtx(); doBuildJammer(ctxTarget.lat, ctxTarget.lon, ctxTarget.region); };
  if (canReactor) ctxEl.querySelector('#ctx-reactor').onclick = () => { closeCtx(); doBuildReactor(ctxTarget.lat, ctxTarget.lon, ctxTarget.region); };
  if (canSilo)    ctxEl.querySelector('#ctx-silo').onclick    = () => { closeCtx(); doBuildSilo(ctxTarget.lat, ctxTarget.lon, ctxTarget.region); };
  if (canR)    ctxEl.querySelector('#ctx-recon').onclick  = () => { closeCtx(); doLaunchOp('RECON',    ctxTarget.lat, ctxTarget.lon, ctxTarget.region); };
  if (canSt)   ctxEl.querySelector('#ctx-steal').onclick  = () => { closeCtx(); doLaunchOp('STEAL',    ctxTarget.lat, ctxTarget.lon, ctxTarget.region); };
  if (canSab)  ctxEl.querySelector('#ctx-sab').onclick    = () => { closeCtx(); doLaunchOp('SABOTAGE', ctxTarget.lat, ctxTarget.lon, ctxTarget.region); };

  ctxEl.style.display = 'block';
  ctxEl.style.left    = Math.min(px, window.innerWidth  - 210) + 'px';
  ctxEl.style.top     = Math.min(py, window.innerHeight - 180) + 'px';
}

function closeCtx() { ctxEl.style.display = 'none'; }

document.addEventListener('mousedown', e => {
  if (!ctxEl.contains(e.target) && e.target !== cvs) closeCtx();
});

// ═══════════════════════════════════════════════════════════════
//  BUILD MODE
// ═══════════════════════════════════════════════════════════════
function enterBuildMode() {
  const cost = nextLabCost(state.player);
  if (state.player.credits < cost) { toast(`Need ${cost}c to build a lab`); return; }
  exitJammerMode(); exitReactorMode(); exitSiloMode();
  state.buildMode = true;
  state.pendingOp = null;
  clearOpBtns();
  showTargetInd(`Click globe to place lab (${cost}c) — ESC to cancel`);
  document.getElementById('btn-build').classList.add('active');
}

function exitBuildMode() {
  state.buildMode = false;
  hideTargetInd();
  document.getElementById('btn-build').classList.remove('active');
}

function nextLabCost(player) {
  return Math.round(C.LAB_COST * (1 + player.labs.length * 0.5));
}

function doBuildLab(lat, lon, region) {
  const p = state.player;
  const cost = nextLabCost(p);
  if (p.credits < cost) { toast('Not enough credits!'); return; }
  if (!isOnLand(lat, lon)) { toast('Labs must be built on land!'); return; }
  p.credits -= cost;
  const lab = new Lab(lat, lon, region, 'player');
  p.addLab(lab);
  createLabMarker(lab, true);
  SFX.buildLab();
  log(`Lab built in ${region ? region.name : 'Ocean'}`, 'ok');
  toast(`Lab placed! (+${C.SCI_PER_LAB} sci/s)`);
  if (MP.active) MP.send('BUILD_LAB', { id: lab.id, lat, lon, regionId: region?.id || null });
  updateUI();
}

// ═══════════════════════════════════════════════════════════════
//  JAMMER PLACEMENT
// ═══════════════════════════════════════════════════════════════
function enterJammerMode() {
  if (state.player.credits < C.JAMMER_COST) { toast(`Need ${C.JAMMER_COST}c to deploy jammer`); return; }
  exitBuildMode(); exitReactorMode(); exitSiloMode();
  state.jammerMode = true;
  state.pendingOp = null;
  clearOpBtns();
  showTargetInd(`Click globe to deploy jammer (${C.JAMMER_COST}c) — ESC to cancel`);
  document.getElementById('btn-jammer').classList.add('active');
}

function exitJammerMode() {
  state.jammerMode = false;
  document.getElementById('btn-jammer')?.classList.remove('active');
  if (!state.buildMode && !state.pendingOp) hideTargetInd();
}

function doBuildJammer(lat, lon, region) {
  const p = state.player;
  if (p.credits < C.JAMMER_COST) { toast('Not enough credits!'); return; }
  if (!isOnLand(lat, lon)) { toast('Jammers must be on land!'); return; }
  p.credits -= C.JAMMER_COST;
  const jammer = new Jammer(lat, lon, region, 'player');
  p.jammers.push(jammer);
  createJammerMarker(jammer, true);
  SFX.buildJammer();
  log(`Jammer deployed in ${region ? region.name : 'unknown'}`, 'ok');
  toast('Jammer deployed! Defensive near your labs, offensive near theirs.');
  if (MP.active) MP.send('BUILD_JAMMER', { id: jammer.id, lat, lon, regionId: region?.id || null });
  updateUI();
}

// ═══════════════════════════════════════════════════════════════
//  REACTOR PLACEMENT
// ═══════════════════════════════════════════════════════════════
function enterReactorMode() {
  if (state.player.credits < C.REACTOR_COST) { toast(`Need ${C.REACTOR_COST}c to build reactor`); return; }
  exitBuildMode(); exitJammerMode(); exitSiloMode();
  state.reactorMode = true;
  state.pendingOp = null;
  clearOpBtns();
  showTargetInd(`Click globe to build reactor (${C.REACTOR_COST}c) — ESC to cancel`);
  document.getElementById('btn-reactor').classList.add('active');
}

function exitReactorMode() {
  state.reactorMode = false;
  document.getElementById('btn-reactor')?.classList.remove('active');
  if (!state.buildMode && !state.jammerMode && !state.siloMode && !state.pendingOp) hideTargetInd();
}

function doBuildReactor(lat, lon, region) {
  const p = state.player;
  if (p.credits < C.REACTOR_COST) { toast('Not enough credits!'); return; }
  if (!isOnLand(lat, lon)) { toast('Reactors must be on land!'); return; }
  p.credits -= C.REACTOR_COST;
  const reactor = new Reactor(lat, lon, region, 'player');
  p.reactors.push(reactor);
  createReactorMarker(reactor, true);
  SFX.buildReactor();
  log(`Reactor built in ${region ? region.name : 'unknown'} (+${C.DU_PER_REACTOR} uranium/s)`, 'ok');
  toast(`Reactor online! +${C.DU_PER_REACTOR} uranium/s`);
  if (MP.active) MP.send('BUILD_REACTOR', { id: reactor.id, lat, lon, regionId: region?.id || null });
  updateUI();
}

// ═══════════════════════════════════════════════════════════════
//  SILO PLACEMENT
// ═══════════════════════════════════════════════════════════════
function enterSiloMode() {
  const p = state.player;
  if (p.credits < C.SILO_COST) { toast(`Need ${C.SILO_COST}c to build silo`); return; }
  if (p.silo) { toast('You already have a rocket silo!'); return; }
  exitBuildMode(); exitJammerMode(); exitReactorMode();
  state.siloMode = true;
  state.pendingOp = null;
  clearOpBtns();
  showTargetInd(`Click globe to build rocket silo (${C.SILO_COST}c) — ESC to cancel`);
  document.getElementById('btn-silo').classList.add('active');
}

function exitSiloMode() {
  state.siloMode = false;
  document.getElementById('btn-silo')?.classList.remove('active');
  if (!state.buildMode && !state.jammerMode && !state.reactorMode && !state.pendingOp) hideTargetInd();
}

function doBuildSilo(lat, lon, region) {
  const p = state.player;
  if (p.credits < C.SILO_COST) { toast('Not enough credits!'); return; }
  if (p.silo) { toast('Already have a silo!'); return; }
  if (!isOnLand(lat, lon)) { toast('Silo must be on land!'); return; }
  p.credits -= C.SILO_COST;
  const silo = new Silo(lat, lon, region, 'player');
  p.silo = silo;
  createSiloMarker(silo, true);
  SFX.buildSilo();
  log(`Rocket silo built in ${region ? region.name : 'unknown'}`, 'ok');
  toast('Rocket silo ready! Reach 100% science + uranium to launch.');
  if (MP.active) MP.send('BUILD_SILO', { id: silo.id, lat, lon, regionId: region?.id || null });
  updateUI();
}

// ═══════════════════════════════════════════════════════════════
//  SWEEP
// ═══════════════════════════════════════════════════════════════
function doSweep() {
  const p = state.player;
  if (p.credits < C.SWEEP_COST) { toast(`Need ${C.SWEEP_COST}c for SWEEP`); return; }
  p.credits -= C.SWEEP_COST;

  let found = 0;
  const scanPoints = [
    ...p.labs.map(l => ll2v3(l.lat, l.lon)),
    ...p.reactors.map(r => ll2v3(r.lat, r.lon)),
    ...(p.silo ? [ll2v3(p.silo.lat, p.silo.lon)] : []),
  ];

  for (const sv of scanPoints) {
    for (const jammer of state.ai.jammers) {
      if (p.revealedEnemyJammers.some(r => r.id === jammer.id)) continue;
      if (sv.distanceTo(ll2v3(jammer.lat, jammer.lon)) <= C.SWEEP_RADIUS) {
        p.revealedEnemyJammers.push(jammer); createJammerMarker(jammer, false); found++;
      }
    }
    for (const reactor of state.ai.reactors) {
      if (p.revealedEnemyReactors.some(r => r.id === reactor.id)) continue;
      if (sv.distanceTo(ll2v3(reactor.lat, reactor.lon)) <= C.SWEEP_RADIUS) {
        p.revealedEnemyReactors.push(reactor); createReactorMarker(reactor, false); found++;
      }
    }
    if (!p.revealedEnemySilo && state.ai.silo) {
      if (sv.distanceTo(ll2v3(state.ai.silo.lat, state.ai.silo.lon)) <= C.SWEEP_RADIUS) {
        p.revealedEnemySilo = state.ai.silo; createSiloMarker(state.ai.silo, false); found++;
      }
    }
  }

  SFX.sweep();
  if (found > 0) {
    log(`SWEEP: ${found} enemy structure(s) detected!`, 'ok');
    toast(`${found} structure(s) revealed — SABOTAGE to destroy!`);
  } else {
    log('SWEEP: Nothing detected near your structures', 'imp');
    toast('Nothing detected near your structures');
  }
  updateUI();
}

// ═══════════════════════════════════════════════════════════════
//  OPERATION SELECTION + LAUNCH
// ═══════════════════════════════════════════════════════════════
function selectOp(type) {
  if (state.player.credits < OPS[type].cost) { toast(`Need ${OPS[type].cost}c`); return; }
  exitBuildMode();
  state.pendingOp = type;
  clearOpBtns();
  const btn = document.getElementById(`btn-${type.toLowerCase()}`);
  if (btn) btn.classList.add('active');
  showTargetInd(`${type}: Click globe to target — ESC to cancel`);
}

function clearOpBtns() {
  ['recon','steal','sabotage'].forEach(t => {
    document.getElementById(`btn-${t}`)?.classList.remove('active');
  });
  if (!state.buildMode) hideTargetInd();
}

function doLaunchOp(type, lat, lon, region) {
  const p = state.player;
  if (p.credits < OPS[type].cost) { toast('Not enough credits!'); return; }
  p.credits -= OPS[type].cost;
  const op = new Operation(type, lat, lon, region);
  p.ops.push(op);
  op.ring = spawnOpRing(lat, lon, type === 'RECON' ? 0x44cc88 : 0x4aaacc);
  log(`${type} launched → ${lat.toFixed(1)}°, ${lon.toFixed(1)}°`, 'imp');
  updateUI();
  if (MP.active) {
    // Multiplayer: send to opponent (defender) to resolve, then receive OP_RESULT
    MP.pendingOps[op.id] = op;
    setTimeout(() => {
      if (op.done) return;  // already resolved (shouldn't happen, but guard)
      if (MP.conn?.open) {
        MP.send('LAUNCH_OP', { opId: op.id, type, lat, lon, regionId: region?.id || null });
      } else {
        // Disconnected — clear op ring
        op.done = true;
        if (op.ring) { RINGS.remove(op.ring); op.ring = null; }
        log(`${type} aborted — opponent disconnected`, 'warn');
      }
    }, OPS[type].duration);
  } else {
    setTimeout(() => resolveOp(op, state.player, state.ai), OPS[type].duration);
  }
}

// ═══════════════════════════════════════════════════════════════
//  OPERATION RESOLUTION
// ═══════════════════════════════════════════════════════════════
function resolveOp(op, attacker, defender) {
  op.done = true;
  if (op.ring) { RINGS.remove(op.ring); op.ring = null; }

  // Detection chance
  if (attacker === state.player && Math.random() < C.DETECT_CHANCE) {
    log('⚠ Your agent was detected!', 'warn');
    state.ai.estimatedEnemySci.min = Math.max(0,   state.player.science - 15);
    state.ai.estimatedEnemySci.max = Math.min(100, state.player.science + 15);
  }

  const bonus   = attacker === state.player ? (nationBonuses[op.type] || 0) : 0;

  // Jammer defense: defender's jammers near the target reduce op success
  const targetV       = ll2v3(op.lat, op.lon);
  const jammed        = defender.jammers.some(j => targetV.distanceTo(ll2v3(j.lat, j.lon)) <= C.JAMMER_RADIUS);
  const jammerPenalty = jammed ? C.JAMMER_DEF_PENALTY : 0;

  const success = Math.random() < Math.max(0.05, OPS[op.type].success + bonus - jammerPenalty);
  if (!success) {
    if (attacker === state.player) { log(`${op.type} FAILED${jammed ? ' — jammer interference' : ''}`, 'warn'); SFX.opFail(); }
    return;
  }

  // ── RECON ──────────────────────────────────────
  if (op.type === 'RECON') {
    if (attacker === state.player) {
      // Radius-based search: find all enemy labs within RECON_RADIUS of clicked point
      const origin = ll2v3(op.lat, op.lon);
      const inRadius = defender.labs.filter(
        l => origin.distanceTo(ll2v3(l.lat, l.lon)) <= C.RECON_RADIUS
      );
      const unrevealed = inRadius.filter(
        l => !attacker.revealedEnemyLabs.some(r => r.lab.id === l.id)
      );

      // Pulse ring to show the searched area
      spawnSearchPulse(op.lat, op.lon);

      if (unrevealed.length > 0) {
        for (const lab of unrevealed) {
          attacker.revealedEnemyLabs.push({ lab });
          createLabMarker(lab, false);
          if (lab.region) attacker.knownEnemyRegions.add(lab.region.id);
        }
        bumpdEstimate(attacker, defender, 10);
        log(`RECON SUCCESS: ${unrevealed.length} lab(s) found in search area!`, 'ok');
        toast(`${unrevealed.length} enemy lab(s) revealed!`);
        refreshFogMarkers();
      } else if (inRadius.length > 0) {
        log(`RECON: Area searched — all labs there already known`, 'imp');
      } else {
        log(`RECON: Nothing found in search area`, 'imp');
        bumpdEstimate(attacker, defender, 20);
      }

      // Also reveal jammers, reactors, and silo within RECON radius
      const jammersFound = defender.jammers.filter(j =>
        !attacker.revealedEnemyJammers.some(r => r.id === j.id) &&
        origin.distanceTo(ll2v3(j.lat, j.lon)) <= C.RECON_RADIUS
      );
      for (const j of jammersFound) { attacker.revealedEnemyJammers.push(j); createJammerMarker(j, false); }

      const reactorsFound = defender.reactors.filter(r =>
        !attacker.revealedEnemyReactors.some(x => x.id === r.id) &&
        origin.distanceTo(ll2v3(r.lat, r.lon)) <= C.RECON_RADIUS
      );
      for (const r of reactorsFound) { attacker.revealedEnemyReactors.push(r); createReactorMarker(r, false); }

      if (!attacker.revealedEnemySilo && defender.silo &&
          origin.distanceTo(ll2v3(defender.silo.lat, defender.silo.lon)) <= C.RECON_RADIUS) {
        attacker.revealedEnemySilo = defender.silo;
        createSiloMarker(defender.silo, false);
        log('RECON: Enemy ROCKET SILO located! SABOTAGE it!', 'ok');
      }

      const hidden = jammersFound.length + reactorsFound.length;
      if (hidden > 0)
        log(`RECON: Detected ${hidden} enemy hidden structure(s)!`, 'ok');
      SFX.opSuccess();
    }
    // AI RECON — update its estimate
    if (attacker === state.ai) {
      bumpdEstimate(attacker, defender, 10);
    }
  }

  // ── STEAL ──────────────────────────────────────
  else if (op.type === 'STEAL') {
    const gain = 8, loss = 4;
    attacker.science = Math.min(100, attacker.science + gain);
    defender.science = Math.max(0,   defender.science - loss);
    if (attacker === state.player) {
      SFX.opSuccess();
      log(`STEAL SUCCESS: +${gain}% science!`, 'ok');
      toast(`+${gain}% science stolen!`);
      bumpdEstimate(attacker, defender, 10);
    } else {
      SFX.alert();
      log(`⚠ Enemy stole your science! −${loss}%`, 'danger');
      toast(`Enemy stole your science! −${loss}%`);
    }
  }

  // ── SABOTAGE ───────────────────────────────────
  else if (op.type === 'SABOTAGE') {
    const t3 = ll2v3(op.lat, op.lon);
    const candidates = [];

    for (const lab of defender.labs) {
      if (!lab.isActive()) continue;
      candidates.push({ kind: 'lab', obj: lab, dist: t3.distanceTo(ll2v3(lab.lat, lab.lon)) });
    }
    for (const j of attacker.revealedEnemyJammers) {
      if (j.ownerId === defender.id)
        candidates.push({ kind: 'jammer', obj: j, dist: t3.distanceTo(ll2v3(j.lat, j.lon)) });
    }
    for (const r of attacker.revealedEnemyReactors) {
      if (r.ownerId === defender.id)
        candidates.push({ kind: 'reactor', obj: r, dist: t3.distanceTo(ll2v3(r.lat, r.lon)) });
    }
    if (attacker.revealedEnemySilo?.ownerId === defender.id) {
      const s = attacker.revealedEnemySilo;
      candidates.push({ kind: 'silo', obj: s, dist: t3.distanceTo(ll2v3(s.lat, s.lon)) });
    }

    candidates.sort((a, b) => a.dist - b.dist);
    const hit = candidates.length > 0 && candidates[0].dist < 0.55 ? candidates[0] : null;

    if (!hit) {
      if (attacker === state.player) { log('SABOTAGE: No valid target in range', 'warn'); SFX.opFail(); }

    } else if (hit.kind === 'lab') {
      const l = hit.obj;
      if (l.marker) { MARKERS.remove(l.marker); l.marker = null; }
      defender.labs = defender.labs.filter(x => x.id !== l.id);
      defender.creditsPerSec = C.CREDITS_BASE + defender.labs.length * C.CREDITS_PER_LAB;
      if (attacker === state.player) {
        SFX.opSuccess();
        log('SABOTAGE SUCCESS: Enemy lab destroyed!', 'ok'); toast('Enemy lab destroyed!');
        if (defender.interruptAssembly()) { log('⚡ Enemy assembly INTERRUPTED!', 'ok'); toast('Enemy ASSEMBLY INTERRUPTED!'); }
      } else {
        SFX.destroyed();
        log('⚠ Your lab was destroyed!', 'danger'); toast('Your lab was destroyed!');
        if (defender.interruptAssembly()) { log('⚡ Your assembly was INTERRUPTED!', 'danger'); toast('YOUR ASSEMBLY INTERRUPTED!'); }
      }

    } else if (hit.kind === 'jammer') {
      const j = hit.obj;
      if (j.marker) { MARKERS.remove(j.marker); j.marker = null; }
      defender.jammers              = defender.jammers.filter(x => x.id !== j.id);
      attacker.revealedEnemyJammers = attacker.revealedEnemyJammers.filter(x => x.id !== j.id);
      if (attacker === state.player) { SFX.opSuccess(); log('SABOTAGE SUCCESS: Enemy jammer destroyed!', 'ok'); toast('Enemy jammer obliterated!'); }
      else { SFX.destroyed(); log('⚠ Your jammer was destroyed!', 'danger'); toast('Your jammer was destroyed!'); }

    } else if (hit.kind === 'reactor') {
      const r = hit.obj;
      if (r.marker) { MARKERS.remove(r.marker); r.marker = null; }
      defender.reactors               = defender.reactors.filter(x => x.id !== r.id);
      attacker.revealedEnemyReactors  = attacker.revealedEnemyReactors.filter(x => x.id !== r.id);
      if (attacker === state.player) { SFX.opSuccess(); log('SABOTAGE SUCCESS: Enemy reactor destroyed! Uranium slows.', 'ok'); toast('Enemy reactor destroyed!'); }
      else { SFX.destroyed(); log('⚠ Your reactor was destroyed!', 'danger'); toast('Your reactor was destroyed!'); }

    } else if (hit.kind === 'silo') {
      const s = hit.obj;
      if (s.marker) { MARKERS.remove(s.marker); s.marker = null; }
      defender.silo                = null;
      attacker.revealedEnemySilo   = null;
      const interrupted = defender.interruptAssembly();
      if (attacker === state.player) {
        SFX.opSuccess();
        log('SABOTAGE SUCCESS: Enemy SILO destroyed!', 'ok');
        if (interrupted) { log('⚡ Enemy LAUNCH ABORTED!', 'ok'); toast('Enemy silo destroyed — launch aborted!'); }
        else toast('Enemy rocket silo obliterated!');
      } else {
        SFX.destroyed();
        log('⚠ YOUR SILO WAS DESTROYED!', 'danger');
        if (interrupted) { log('⚡ YOUR LAUNCH WAS ABORTED!', 'danger'); toast('Silo destroyed — build a new one!'); }
        else toast('Your rocket silo was destroyed!');
      }
    }
  }

  updateUI();
}

function bumpdEstimate(attacker, defender, uncertainty) {
  attacker.estimatedEnemySci.min = Math.max(0,   defender.science - uncertainty);
  attacker.estimatedEnemySci.max = Math.min(100, defender.science + uncertainty);
}

// ═══════════════════════════════════════════════════════════════
//  AI LOGIC
// ═══════════════════════════════════════════════════════════════
function aiTick() {
  if (state.gameOver) return;
  const ai = state.ai;
  const p  = state.player;

  if (ai.science >= 100 && ai.depletedUranium >= 100 && ai.silo && !ai.assembling && !ai.assemblyDone) {
    ai.startAssembly();
    log('⚠ INTEL: Enemy has initiated assembly!', 'danger');
    return;
  }

  const estPlayerSci = (ai.estimatedEnemySci.min + ai.estimatedEnemySci.max) / 2;

  // Build a lab if affordable and under cap
  if (ai.credits >= nextLabCost(ai) + 80 && ai.labs.length < 8) {
    aiBuild(); return;
  }

  // Build reactors (need uranium to win)
  if (ai.credits >= C.REACTOR_COST + 200 && ai.reactors.length < 3 && Math.random() < 0.55) {
    aiBuildReactor(); return;
  }

  // Build silo (need it to win — wait until 2+ labs exist)
  if (ai.credits >= C.SILO_COST + 200 && !ai.silo && ai.labs.length >= 2 && Math.random() < 0.65) {
    aiBuildSilo(); return;
  }

  // Place a jammer (keep 300c buffer; max 4 jammers)
  if (ai.credits >= C.JAMMER_COST + 300 && ai.jammers.length < 4 && Math.random() < 0.40) {
    aiPlaceJammer(); return;
  }

  // Sweep for player jammers
  if (ai.credits >= C.SWEEP_COST && Math.random() < 0.22) {
    aiSweep(); return;
  }

  // Destroy a revealed player jammer
  if (ai.revealedEnemyJammers.length > 0 && ai.credits >= OPS.SABOTAGE.cost && Math.random() < 0.75) {
    aiOp('SABOTAGE'); return;
  }

  // Sabotage if significantly behind
  if (ai.science < estPlayerSci - 20 && ai.credits >= OPS.SABOTAGE.cost && Math.random() < 0.55) {
    aiOp('SABOTAGE'); return;
  }

  // Steal if behind
  if (ai.science < estPlayerSci - 10 && ai.credits >= OPS.STEAL.cost && Math.random() < 0.60) {
    aiOp('STEAL'); return;
  }

  // Random steal
  if (ai.credits >= OPS.STEAL.cost && Math.random() < 0.35) {
    aiOp('STEAL'); return;
  }

  // Random RECON
  if (ai.credits >= OPS.RECON.cost && Math.random() < 0.30) {
    aiOp('RECON');
  }
}

function aiBuild() {
  const ai = state.ai;
  if (ai.credits < nextLabCost(ai)) return;
  const keys = Object.keys(REGIONS);
  let region, lat, lon, attempts = 0;
  do {
    region = REGIONS[keys[Math.floor(Math.random() * keys.length)]];
    ({ lat, lon } = randInRegion(region));
    attempts++;
  } while (!isOnLand(lat, lon) && attempts < 30);
  if (!isOnLand(lat, lon)) return;  // gave up — all sampled points were ocean
  ai.credits -= nextLabCost(ai);
  const lab = new Lab(lat, lon, region, 'ai');
  ai.addLab(lab);
  console.log(`[AI] Lab built in ${region.name} (${lat.toFixed(1)}, ${lon.toFixed(1)})`);
  refreshFogMarkers();
}

function aiSweep() {
  const ai = state.ai;
  const p  = state.player;
  if (ai.credits < C.SWEEP_COST) return;
  ai.credits -= C.SWEEP_COST;
  let found = 0;

  const scanPts = [
    ...ai.labs.map(l => ll2v3(l.lat, l.lon)),
    ...ai.reactors.map(r => ll2v3(r.lat, r.lon)),
    ...(ai.silo ? [ll2v3(ai.silo.lat, ai.silo.lon)] : []),
  ];

  for (const sv of scanPts) {
    for (const jammer of p.jammers) {
      if (ai.revealedEnemyJammers.some(r => r.id === jammer.id)) continue;
      if (sv.distanceTo(ll2v3(jammer.lat, jammer.lon)) <= C.SWEEP_RADIUS) {
        ai.revealedEnemyJammers.push(jammer); found++;
      }
    }
    for (const reactor of p.reactors) {
      if (ai.revealedEnemyReactors.some(r => r.id === reactor.id)) continue;
      if (sv.distanceTo(ll2v3(reactor.lat, reactor.lon)) <= C.SWEEP_RADIUS) {
        ai.revealedEnemyReactors.push(reactor); found++;
      }
    }
    if (!ai.revealedEnemySilo && p.silo) {
      if (sv.distanceTo(ll2v3(p.silo.lat, p.silo.lon)) <= C.SWEEP_RADIUS) {
        ai.revealedEnemySilo = p.silo; found++;
      }
    }
  }
  if (found > 0) log(`⚠ Enemy sweep detected ${found} of your structures!`, 'warn');
  console.log(`[AI] SWEEP found ${found} player structure(s)`);
}

function aiBuildReactor() {
  const ai = state.ai;
  if (ai.credits < C.REACTOR_COST) return;
  let lat, lon, region, attempts = 0;
  do {
    const keys = Object.keys(REGIONS);
    region = REGIONS[keys[Math.floor(Math.random() * keys.length)]];
    ({ lat, lon } = randInRegion(region));
    attempts++;
  } while (!isOnLand(lat, lon) && attempts < 30);
  if (!isOnLand(lat, lon)) return;
  ai.credits -= C.REACTOR_COST;
  ai.reactors.push(new Reactor(lat, lon, region, 'ai'));
  console.log(`[AI] Reactor built in ${region.name}`);
}

function aiBuildSilo() {
  const ai = state.ai;
  if (ai.credits < C.SILO_COST || ai.silo) return;
  let lat, lon, region, attempts = 0;
  do {
    const keys = Object.keys(REGIONS);
    region = REGIONS[keys[Math.floor(Math.random() * keys.length)]];
    ({ lat, lon } = randInRegion(region));
    attempts++;
  } while (!isOnLand(lat, lon) && attempts < 30);
  if (!isOnLand(lat, lon)) return;
  ai.credits -= C.SILO_COST;
  ai.silo = new Silo(lat, lon, region, 'ai');
  console.log(`[AI] Silo built in ${region.name}`);
}

function aiPlaceJammer() {
  const ai = state.ai;
  const p  = state.player;
  if (ai.credits < C.JAMMER_COST) return;

  let lat, lon, region, attempts = 0;
  const defensive = Math.random() < 0.5 && ai.labs.length > 0;

  do {
    if (defensive) {
      const lab = ai.labs[Math.floor(Math.random() * ai.labs.length)];
      lat = Math.max(-85, Math.min(85, lab.lat + (Math.random() - 0.5) * 5));
      lon = lab.lon + (Math.random() - 0.5) * 5;
      region = getRegion(lat, lon) || lab.region;
    } else if (p.labs.length > 0) {
      const lab = p.labs[Math.floor(Math.random() * p.labs.length)];
      lat = Math.max(-85, Math.min(85, lab.lat + (Math.random() - 0.5) * 6));
      lon = lab.lon + (Math.random() - 0.5) * 6;
      region = getRegion(lat, lon) || lab.region;
    } else {
      const keys = Object.keys(REGIONS);
      region = REGIONS[keys[Math.floor(Math.random() * keys.length)]];
      ({ lat, lon } = randInRegion(region));
    }
    attempts++;
  } while (!isOnLand(lat, lon) && attempts < 30);

  if (!isOnLand(lat, lon)) return;
  ai.credits -= C.JAMMER_COST;
  const jammer = new Jammer(lat, lon, region, 'ai');
  ai.jammers.push(jammer);
  console.log(`[AI] Jammer placed ${defensive ? '(defensive)' : '(offensive)'} in ${region ? region.name : '?'}`);
}

function aiOp(type) {
  const ai = state.ai;
  const p  = state.player;
  if (ai.credits < OPS[type].cost) return;
  ai.credits -= OPS[type].cost;

  let lat, lon, region;
  // SABOTAGE priority: revealed silo > revealed reactors > revealed jammers > labs
  if (type === 'SABOTAGE' && ai.revealedEnemySilo?.ownerId === p.id && Math.random() < 0.85) {
    lat = ai.revealedEnemySilo.lat; lon = ai.revealedEnemySilo.lon; region = ai.revealedEnemySilo.region;
  } else if (type === 'SABOTAGE' && ai.revealedEnemyReactors.length > 0 && Math.random() < 0.70) {
    const t = ai.revealedEnemyReactors[Math.floor(Math.random() * ai.revealedEnemyReactors.length)];
    lat = t.lat; lon = t.lon; region = t.region;
  } else if (type === 'SABOTAGE' && ai.revealedEnemyJammers.length > 0 && Math.random() < 0.65) {
    const t = ai.revealedEnemyJammers[Math.floor(Math.random() * ai.revealedEnemyJammers.length)];
    lat = t.lat; lon = t.lon; region = t.region;
  } else if (p.labs.length > 0) {
    const t  = p.labs[Math.floor(Math.random() * p.labs.length)];
    lat = t.lat; lon = t.lon; region = t.region;
  } else {
    const keys  = Object.keys(REGIONS);
    region = REGIONS[keys[Math.floor(Math.random() * keys.length)]];
    ({ lat, lon } = randInRegion(region));
  }

  const op = new Operation(type, lat, lon, region);
  ai.ops.push(op);
  console.log(`[AI] ${type} → ${region ? region.name : '?'}`);
  setTimeout(() => resolveOp(op, state.ai, state.player), OPS[type].duration);
}

// ═══════════════════════════════════════════════════════════════
//  ICBM LAUNCH ANIMATION
// ═══════════════════════════════════════════════════════════════
function launchICBM(fromLat, fromLon, toLat, toLon, onArrival, incoming = true) {
  SFX.icbmLaunch();

  // Alarm overlay
  const alarmEl    = document.getElementById('icbm-alarm');
  const alarmText  = document.getElementById('icbm-alarm-text');
  alarmText.textContent = incoming ? '⚠  INCOMING MISSILE  ⚠' : '⚛  MISSILE LAUNCHED  ⚛';
  alarmText.style.color = incoming ? '#ff2200' : '#ffcc00';
  alarmText.style.textShadow = incoming
    ? '0 0 28px rgba(255,34,0,0.9)'
    : '0 0 28px rgba(255,200,0,0.9)';
  alarmEl.classList.add('show');
  if (SETTINGS.sound) startKlaxon();

  // Positions in globe-local space
  const start = ll2v3(fromLat, fromLon, 1.0);
  const end   = ll2v3(toLat,   toLon,   1.0);
  const ctrl  = start.clone().add(end).multiplyScalar(0.5).normalize().multiplyScalar(1.58);
  const curve = new THREE.QuadraticBezierCurve3(start, ctrl, end);

  // Missile body
  const missileMat = new THREE.MeshBasicMaterial({ color: 0xffeecc });
  const missile    = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), missileMat);
  G_GROUP.add(missile);

  // Core trail (bright white → red on re-entry)
  const MAX_TRAIL = 90;
  const trailPts  = [];
  const trailGeo  = new THREE.BufferGeometry();
  const trailMat  = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
  const trailLine = new THREE.Line(trailGeo, trailMat);
  G_GROUP.add(trailLine);

  // Glow trail (wider, additive, orange → deep red on re-entry)
  const glowGeo  = new THREE.BufferGeometry();
  const glowMat  = new THREE.LineBasicMaterial({
    color: 0xff8800, transparent: true, opacity: 0.30,
    blending: THREE.AdditiveBlending,
  });
  const glowLine = new THREE.Line(glowGeo, glowMat);
  G_GROUP.add(glowLine);

  const DURATION  = 7000;
  const startTime = performance.now();

  function tick() {
    const t   = Math.min(1, (performance.now() - startTime) / DURATION);
    const pos = curve.getPoint(t);
    missile.position.copy(pos);

    // Re-entry phase: last 30% of flight
    const reentry = Math.max(0, (t - 0.70) / 0.30);
    if (reentry > 0) {
      // Core turns white → orange → red
      trailMat.color.setHex(reentry < 0.5
        ? 0xffcc44 + Math.round((1 - reentry * 2) * 0xbb) * 0x100
        : 0xff2200);
      glowMat.color.setHex(0xff2200);
      glowMat.opacity = 0.30 + reentry * 0.55;
      missileMat.color.setHex(reentry > 0.6 ? 0xff4400 : 0xff9900);
    }

    // Update trail
    trailPts.push(pos.clone());
    if (trailPts.length > MAX_TRAIL) trailPts.shift();
    const flat = [];
    for (const p of trailPts) flat.push(p.x, p.y, p.z);
    const attr = new THREE.Float32BufferAttribute(flat, 3);
    trailGeo.setAttribute('position', attr);
    trailGeo.setDrawRange(0, trailPts.length);
    glowGeo.setAttribute('position', attr.clone());
    glowGeo.setDrawRange(0, trailPts.length);

    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      // Cleanup missile + trails
      G_GROUP.remove(missile); G_GROUP.remove(trailLine); G_GROUP.remove(glowLine);
      missile.geometry.dispose(); missileMat.dispose();
      trailGeo.dispose(); trailMat.dispose();
      glowGeo.dispose();  glowMat.dispose();

      // Stop alarm
      stopKlaxon();
      alarmEl.classList.remove('show');

      // Initial fireball flash
      const fireball = new THREE.Mesh(
        new THREE.SphereGeometry(0.10, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending })
      );
      fireball.position.copy(end);
      G_GROUP.add(fireball);

      // Secondary white core flash
      const coreFlash = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0,
          blending: THREE.AdditiveBlending })
      );
      coreFlash.position.copy(end);
      G_GROUP.add(coreFlash);

      // Animate fireball + core
      let age = 0;
      const fade = setInterval(() => {
        age += 0.06;
        fireball.material.opacity  = Math.max(0, 0.95 * (1 - age));
        fireball.scale.setScalar(1 + age * 4);
        coreFlash.material.opacity = Math.max(0, 1.0  * (1 - age * 2));
        coreFlash.scale.setScalar(1 + age * 2);
        if (age >= 1) {
          clearInterval(fade);
          G_GROUP.remove(fireball);  fireball.geometry.dispose();
          G_GROUP.remove(coreFlash); coreFlash.geometry.dispose();
        }
      }, 30);

      // Shockwave rings
      spawnShockwave(end);

      // Camera shake
      shakeCamera(1600, 14);

      SFX.icbmImpact();
      if (onArrival) onArrival();
    }
  }
  requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════════════
//  PLAYER ASSEMBLY
// ═══════════════════════════════════════════════════════════════
function startAssembly() {
  const p = state.player;
  if (p.depletedUranium < 100) { toast('Need 100% depleted uranium! Build more reactors.'); return; }
  if (!p.silo) { toast('Need a rocket silo before assembly!'); return; }
  if (p.startAssembly()) {
    SFX.assemblyStart();
    log('⚛ Assembly initiated! 4 minutes to completion...', 'imp');
    document.getElementById('btn-asm').style.display = 'none';
    document.getElementById('assembly-display').classList.add('show');
    if (MP.active) MP.send('ASSEMBLY_START', {});
  }
}

// ═══════════════════════════════════════════════════════════════
//  WIN / LOSS
// ═══════════════════════════════════════════════════════════════
function endGame(playerWon) {
  if (state.gameOver) return;
  state.gameOver = true;
  if (MP.active && playerWon) MP.send('GAME_OVER', { won: true });

  // Reveal all hidden AI labs (dimmed orange)
  const alreadyRevealed = new Set(state.player.revealedEnemyLabs.map(r => r.lab.id));
  let hidden = 0;
  for (const lab of state.ai.labs) {
    if (!alreadyRevealed.has(lab.id)) {
      const pos  = ll2v3(lab.lat, lab.lon, 1.003);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.013, 0.045, 7),
        new THREE.MeshBasicMaterial({ color: 0xcc7700, transparent: true, opacity: 0.75 })
      );
      const up = pos.clone().normalize();
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      cone.position.copy(pos).addScaledVector(up, 0.022);
      MARKERS.add(cone); hidden++;
    }
  }
  // Reveal hidden AI silo and reactors
  if (state.ai.silo && !state.player.revealedEnemySilo) createSiloMarker(state.ai.silo, false);
  for (const r of state.ai.reactors) {
    if (!state.player.revealedEnemyReactors.some(x => x.id === r.id)) createReactorMarker(r, false);
  }

  for (const m of fogMarkers) MARKERS.remove(m);
  fogMarkers.length = 0;

  const totalLabs  = state.ai.labs.length;
  const found      = totalLabs - hidden;
  const revealLine = totalLabs > 0
    ? `Enemy had ${totalLabs} lab(s) — you found ${found}, missed ${hidden}.`
    : 'The enemy built no labs.';

  function showOverlay() {
    const el    = document.getElementById('game-over');
    const title = document.getElementById('go-title');
    const desc  = document.getElementById('go-desc');
    if (playerWon) {
      el.className      = 'victory';
      title.textContent = 'VICTORY';
      desc.textContent  = `ICBM impact confirmed. The world bows. ${revealLine}`;
    } else {
      el.className      = 'defeat';
      title.textContent = 'DEFEAT';
      desc.textContent  = `Enemy ICBM has landed. The arms race is over. ${revealLine}`;
    }
    el.classList.add('show');
    el.style.display = 'flex';
    if (playerWon) SFX.victory(); else SFX.defeat();
  }

  // Launch ICBM from winner's silo toward enemy capital
  const winningSilo  = playerWon ? state.player.silo : state.ai.silo;
  const enemyNat     = playerNation === 'USA' ? 'RUSSIA' : 'USA';
  const targetCap    = playerWon ? NATION_CAPITALS[enemyNat] : NATION_CAPITALS[playerNation];
  const launchFlag   = playerWon ? (playerNation === 'USA' ? '🇺🇸' : '🇷🇺') : (playerNation === 'USA' ? '🇷🇺' : '🇺🇸');

  if (winningSilo && targetCap) {
    log(`⚛ ${launchFlag} ICBM LAUNCHED — missile inbound!`, playerWon ? 'ok' : 'danger');
    toast('ICBM LAUNCHED — missile inbound!');
    launchICBM(winningSilo.lat, winningSilo.lon, targetCap.lat, targetCap.lon, showOverlay, !playerWon);
  } else {
    showOverlay();
  }
}

function showResults() {
  document.getElementById('game-over').style.display = 'none';
  document.getElementById('results-pill').classList.add('show');
}

// ═══════════════════════════════════════════════════════════════
//  NOTIFICATION + LOG
// ═══════════════════════════════════════════════════════════════
const notifEl = document.getElementById('notif');
let notifTmr;
function toast(msg) {
  notifEl.textContent = msg;
  notifEl.style.opacity = '1';
  clearTimeout(notifTmr);
  notifTmr = setTimeout(() => { notifEl.style.opacity = '0'; }, 3200);
}

const logEl = document.getElementById('event-log');
function log(msg, cls = '') {
  const el = document.createElement('div');
  el.className = `log-line ${cls}`;
  const t = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent = `[${t}] ${msg}`;
  logEl.prepend(el);
  while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
}

// ═══════════════════════════════════════════════════════════════
//  TARGETING INDICATOR + HOVER LABEL HELPERS
// ═══════════════════════════════════════════════════════════════
const tIndEl    = document.getElementById('target-ind');
const hoverLbl  = document.getElementById('hover-label');
function showTargetInd(msg) { tIndEl.textContent = msg; tIndEl.classList.add('show'); }
function hideTargetInd()     { tIndEl.classList.remove('show'); }
function showHoverLabel(name) { hoverLbl.textContent = name; hoverLbl.style.display = 'block'; }
function hideHoverLabel()      { hoverLbl.style.display = 'none'; }

// ═══════════════════════════════════════════════════════════════
//  KEYBOARD
// ═══════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    exitBuildMode();
    exitJammerMode();
    exitReactorMode();
    exitSiloMode();
    state.pendingOp = null;
    clearOpBtns();
    closeCtx();
  }
});

// ═══════════════════════════════════════════════════════════════
//  INITIALISE
// ═══════════════════════════════════════════════════════════════
function init() {
  state.player    = new Player('player', true);
  state.ai        = new Player('ai',     false);
  state.lastUpdate = Date.now();
  state.lastAiTick = Date.now();

  // Expose helpers for HTML onclick
  window.G = { enterBuildMode, enterJammerMode, enterReactorMode, enterSiloMode, selectOp, startAssembly, doSweep };

  // Give AI an initial lab after a short delay
  setTimeout(() => { if (!state.gameOver) aiBuild(); }, 1500);
  setTimeout(() => { if (!state.gameOver && state.ai.credits >= nextLabCost(state.ai)) aiBuild(); }, 6000);

  log('War Room online. Build labs, reactors, and a rocket silo.', 'imp');
  log('100% science + 100% uranium + silo → assembly → ICBM launch → victory.', '');
  log('Use RECON or SWEEP to locate hidden enemy structures.', '');

  updateUI();
}

// Load globe countries immediately so they're ready when nation is chosen
buildGlobeCountries();
