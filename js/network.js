'use strict';

// ═══════════════════════════════════════════════════════════════
//  MULTIPLAYER  —  pure MQTT relay, no WebRTC
//  All traffic goes through the free HiveMQ public broker.
//  No NAT issues, no P2P, no second service.
// ═══════════════════════════════════════════════════════════════

const MQTT_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
];

function genRoomCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

function mpStatus(msg) {
  const el = document.getElementById('mp-status-row');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

const MP = {
  active:   false,
  isHost:   false,
  client:   null,
  code:     null,
  txTopic:  null,   // topic we publish on
  rxTopic:  null,   // topic we subscribe to
  remoteNation:        null,
  remoteNationBonuses: { RECON: 0, STEAL: 0, SABOTAGE: 0 },
  pendingOps: {},

  send(type, data) {
    if (this.client?.connected) {
      this.client.publish(this.txTopic, JSON.stringify({ type, data }), { qos: 1 });
    }
  },

  _tryBroker(url) {
    return new Promise((resolve, reject) => {
      const id = 'fog_' + Math.random().toString(36).slice(2, 10);
      const client = mqtt.connect(url, { clientId: id, clean: true, connectTimeout: 6000 });
      const t = setTimeout(() => { client.end(true); reject(new Error('timeout')); }, 7000);
      client.on('connect', () => { clearTimeout(t); resolve(client); });
      client.on('error',   ()  => { clearTimeout(t); client.end(true); reject(new Error('error')); });
    });
  },

  async _connect(onMsg) {
    if (typeof mqtt === 'undefined') throw new Error('mqtt library failed to load — try refreshing');
    let client = null;
    for (const url of MQTT_BROKERS) {
      try { client = await this._tryBroker(url); break; } catch { /* try next */ }
    }
    if (!client) throw new Error('Could not reach relay — check your internet connection');
    client.on('message', (topic, msg) => {
      try { onMsg(JSON.parse(msg.toString())); } catch { /* ignore malformed */ }
    });
    return client;
  },

  async host() {
    this.isHost  = true;
    this.code    = genRoomCode();
    this.txTopic = `fogofwar3/${this.code}/host`;
    this.rxTopic = `fogofwar3/${this.code}/guest`;
    mpStatus('Connecting to relay…');
    try {
      this.client = await this._connect(msg => handleNetMsg(msg));
      this.client.subscribe(this.rxTopic, { qos: 1 });
      // Announce room so guest knows host is ready
      this.client.publish(`fogofwar3/${this.code}/ready`, '1', { qos: 1, retain: true });
      document.getElementById('mp-room-code').textContent = this.code;
      document.getElementById('mp-code-display').style.display = 'block';
      mpStatus('Waiting for opponent to connect…');
    } catch (e) {
      mpStatus(`Error: ${e.message}`);
    }
  },

  async join(code) {
    this.isHost  = false;
    this.code    = code;
    this.txTopic = `fogofwar3/${code}/guest`;
    this.rxTopic = `fogofwar3/${code}/host`;
    mpStatus('Connecting to relay…');
    try {
      this.client = await this._connect(msg => handleNetMsg(msg));
      // Check room exists
      mpStatus('Looking for host…');
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Room not found — check the code')), 8000);
        this.client.subscribe(`fogofwar3/${code}/ready`, { qos: 1 });
        this.client.once('message', (topic) => {
          if (topic === `fogofwar3/${code}/ready`) {
            clearTimeout(t);
            this.client.unsubscribe(`fogofwar3/${code}/ready`);
            resolve();
          }
        });
      });
      this.client.subscribe(this.rxTopic, { qos: 1 });
      // Tell host guest has arrived
      this.send('GUEST_JOINED', {});
      mpStatus('Connected! Waiting for host to pick a nation…');
    } catch (e) {
      mpStatus(`Error: ${e.message}`);
    }
  },
};

function mpDoHost() {
  MP.active = true;
  MP.host();
}

function mpDoJoin() {
  const code = (document.getElementById('mp-join-input')?.value || '').trim().toUpperCase();
  if (code.length < 4) { mpStatus('Enter a valid room code.'); return; }
  MP.active = true;
  MP.join(code);
}

// ── Periodic SYNC ──────────────────────────────────────────────
setInterval(() => {
  if (MP.active && state.player && !state.gameOver) {
    MP.send('SYNC', { science: state.player.science, du: state.player.depletedUranium });
  }
}, 12000);

// ── Incoming message router ────────────────────────────────────
function handleNetMsg(msg) {
  const { type, data } = msg;

  switch (type) {

    case 'GUEST_JOINED': {
      // Host sees guest arrive — prompt nation select
      mpStatus('Opponent connected! Pick your nation.');
      showNationSelect();
      break;
    }

    case 'GAME_START': {
      const hostNation  = data.nation;
      const guestNation = hostNation === 'USA' ? 'RUSSIA' : 'USA';
      playerNation = guestNation;
      if (guestNation === 'USA')    nationBonuses.RECON    = 0.05;
      if (guestNation === 'RUSSIA') nationBonuses.SABOTAGE = 0.05;
      MP.remoteNation = hostNation;
      MP.remoteNationBonuses.RECON    = hostNation === 'USA'    ? 0.05 : 0;
      MP.remoteNationBonuses.SABOTAGE = hostNation === 'RUSSIA' ? 0.05 : 0;
      document.getElementById('h-flag').textContent   = guestNation === 'USA' ? '🇺🇸' : '🇷🇺';
      document.getElementById('h-nation').textContent = guestNation;
      document.getElementById('mp-screen').style.display = 'none';
      applySettings();
      init();
      log(`Multiplayer game started! You are playing as ${guestNation}.`, 'imp');
      break;
    }

    case 'BUILD_LAB': {
      if (!state.ai) break;
      const l = new Lab(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      l.id = data.id; state.ai.labs.push(l);
      state.ai.creditsPerSec = C.CREDITS_BASE + state.ai.labs.length * C.CREDITS_PER_LAB;
      break;
    }
    case 'BUILD_JAMMER': {
      if (!state.ai) break;
      const j = new Jammer(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      j.id = data.id; state.ai.jammers.push(j);
      break;
    }
    case 'BUILD_REACTOR': {
      if (!state.ai) break;
      const r = new Reactor(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      r.id = data.id; state.ai.reactors.push(r);
      break;
    }
    case 'BUILD_SILO': {
      if (!state.ai) break;
      const s = new Silo(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      s.id = data.id; state.ai.silo = s;
      break;
    }
    case 'BUILD_OIL_FIELD': {
      if (!state.ai) break;
      const of_ = new OilField(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      of_.id = data.id; state.ai.addOilField(of_);
      break;
    }
    case 'BUILD_DEFENSE': {
      if (!state.ai) break;
      const def = new Defense(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      def.id = data.id; state.ai.defenses.push(def);
      break;
    }

    case 'LAUNCH_OP':     resolveRemoteOp(data); break;
    case 'OP_RESULT':     applyOpResult(data);   break;

    case 'ASSEMBLY_START': {
      if (!state.ai) break;
      state.ai.assembling = true; state.ai.assemblyStart = Date.now();
      log('⚠ INTEL: Enemy has initiated assembly!', 'danger'); toast('Enemy assembly underway!'); SFX.alert();
      break;
    }
    case 'SYNC': {
      if (!state.ai || !state.player) break;
      if (data.science !== undefined) {
        state.ai.science = data.science;
        state.player.estimatedEnemySci.min = Math.max(0,   data.science - 8);
        state.player.estimatedEnemySci.max = Math.min(100, data.science + 8);
      }
      if (data.du !== undefined) state.ai.depletedUranium = data.du;
      break;
    }
    case 'GAME_OVER': {
      if (!state.gameOver) endGame(false);
      break;
    }
  }
}

// ── Defender-side op resolution ────────────────────────────────
function resolveRemoteOp(data) {
  if (!state.player) return;
  const { opId, type, lat, lon } = data;
  const defender    = state.player;
  const remoteBonus = MP.remoteNationBonuses[type] || 0;
  const targetV     = ll2v3(lat, lon);
  const jammed      = defender.jammers.some(j => targetV.distanceTo(ll2v3(j.lat, j.lon)) <= C.JAMMER_RADIUS);
  const jamPenalty  = jammed ? C.JAMMER_DEF_PENALTY : 0;
  const success     = Math.random() < Math.max(0.05, OPS[type].success + remoteBonus - jamPenalty);
  const result      = { opId, opType: type, success, jammed };

  if (!success) { MP.send('OP_RESULT', result); return; }

  if (type === 'RECON') {
    const origin = ll2v3(lat, lon);
    result.revealedLabs     = defender.labs.filter(l => origin.distanceTo(ll2v3(l.lat, l.lon)) <= C.RECON_RADIUS)
      .map(l => ({ id: l.id, lat: l.lat, lon: l.lon, regionId: l.region?.id || null }));
    result.revealedJammers  = defender.jammers.filter(j => origin.distanceTo(ll2v3(j.lat, j.lon)) <= C.RECON_RADIUS)
      .map(j => ({ id: j.id, lat: j.lat, lon: j.lon }));
    result.revealedReactors = defender.reactors.filter(r => origin.distanceTo(ll2v3(r.lat, r.lon)) <= C.RECON_RADIUS)
      .map(r => ({ id: r.id, lat: r.lat, lon: r.lon }));
    result.revealedDefenses  = defender.defenses.filter(d => origin.distanceTo(ll2v3(d.lat, d.lon)) <= C.RECON_RADIUS)
      .map(d => ({ id: d.id, lat: d.lat, lon: d.lon }));
    result.revealedOilFields = defender.oilFields.filter(o => origin.distanceTo(ll2v3(o.lat, o.lon)) <= C.RECON_RADIUS)
      .map(o => ({ id: o.id, lat: o.lat, lon: o.lon, regionId: o.region?.id || null }));
    result.revealedSilo = (defender.silo && origin.distanceTo(ll2v3(defender.silo.lat, defender.silo.lon)) <= C.RECON_RADIUS)
      ? { id: defender.silo.id, lat: defender.silo.lat, lon: defender.silo.lon } : null;
    spawnSearchPulse(lat, lon);

  } else if (type === 'STEAL') {
    const tv = ll2v3(lat, lon);
    const nearOilField = defender.oilFields.find(o => tv.distanceTo(ll2v3(o.lat, o.lon)) < 0.55);
    const nearReactor  = defender.reactors.find(r  => tv.distanceTo(ll2v3(r.lat,  r.lon))  < 0.55);
    const nearLab      = defender.labs.find(l      => tv.distanceTo(ll2v3(l.lat,  l.lon))  < 0.55 && l.isActive());
    if (nearOilField) {
      defender.credits = Math.max(0, defender.credits - 250);
      result.stealKind = 'oilField'; result.creditsGained = 175;
      SFX.alert(); log('⚠ Enemy drained your oil field! −250c', 'danger'); toast('Enemy stole 250c from your oil field!');
    } else if (nearReactor) {
      defender.depletedUranium = Math.max(0, defender.depletedUranium - 18);
      result.stealKind = 'reactor'; result.uraniumGained = 12;
      SFX.alert(); log('⚠ Enemy stole your uranium! −18%', 'danger'); toast('Enemy stole your uranium! −18%');
    } else if (nearLab) {
      defender.science = Math.max(0, defender.science - 6);
      result.stealKind = 'lab'; result.sciGained = 10;
      SFX.alert(); log('⚠ Enemy stole research from your lab! −6%', 'danger'); toast('Enemy stole your research! −6%');
    } else {
      defender.science = Math.max(0, defender.science - 4);
      result.stealKind = 'science'; result.sciGained = 8;
      SFX.alert(); log('⚠ Enemy stole your science! −4%', 'danger'); toast('Enemy stole your science! −4%');
    }

  } else if (type === 'SABOTAGE') {
    const t3 = ll2v3(lat, lon);
    const candidates = [];
    for (const lab of defender.labs) {
      if (!lab.isActive()) continue;
      candidates.push({ kind: 'lab',     obj: lab,           dist: t3.distanceTo(ll2v3(lab.lat, lab.lon)) });
    }
    for (const j of defender.jammers)
      candidates.push({ kind: 'jammer',  obj: j,             dist: t3.distanceTo(ll2v3(j.lat, j.lon)) });
    for (const r of defender.reactors)
      candidates.push({ kind: 'reactor', obj: r,             dist: t3.distanceTo(ll2v3(r.lat, r.lon)) });
    for (const d of defender.defenses)
      candidates.push({ kind: 'defense', obj: d,             dist: t3.distanceTo(ll2v3(d.lat, d.lon)) });
    if (defender.silo)
      candidates.push({ kind: 'silo',    obj: defender.silo, dist: t3.distanceTo(ll2v3(defender.silo.lat, defender.silo.lon)) });
    candidates.sort((a, b) => a.dist - b.dist);
    const hit = candidates.length > 0 && candidates[0].dist < 0.55 ? candidates[0] : null;
    result.hit = null;
    if (hit) {
      result.hit = { kind: hit.kind, id: hit.obj.id };
      if (hit.kind === 'lab') {
        hit.obj.disabledUntil = Date.now() + C.SABOTAGE_DUR;
        result.assemblyInterrupted = defender.interruptAssembly();
        SFX.alert(); if (hit.obj.marker) setMarkerEnabled(hit.obj.marker, false);
        log('⚠ Your lab was sabotaged! Offline 2min', 'danger'); toast('Your lab sabotaged — offline 2min!');
        if (result.assemblyInterrupted) { log('⚡ Your assembly was INTERRUPTED!', 'danger'); toast('YOUR ASSEMBLY INTERRUPTED!'); }
      } else if (hit.kind === 'jammer') {
        const j = hit.obj; if (j.marker) { MARKERS.remove(j.marker); j.marker = null; }
        defender.jammers = defender.jammers.filter(x => x.id !== j.id);
        SFX.destroyed(); log('⚠ Your jammer was destroyed!', 'danger'); toast('Your jammer was destroyed!');
      } else if (hit.kind === 'reactor') {
        const r = hit.obj; if (r.marker) { MARKERS.remove(r.marker); r.marker = null; }
        defender.reactors = defender.reactors.filter(x => x.id !== r.id);
        SFX.destroyed(); log('⚠ Your reactor was destroyed!', 'danger'); toast('Your reactor was destroyed!');
      } else if (hit.kind === 'defense') {
        const d = hit.obj; if (d.marker) { MARKERS.remove(d.marker); d.marker = null; }
        defender.defenses = defender.defenses.filter(x => x.id !== d.id);
        SFX.destroyed(); log('⚠ Your defense system was destroyed!', 'danger'); toast('Your defense system was destroyed!');
      } else if (hit.kind === 'silo') {
        const s = hit.obj; if (s.marker) { MARKERS.remove(s.marker); s.marker = null; }
        defender.silo = null; result.assemblyInterrupted = defender.interruptAssembly();
        SFX.destroyed(); log('⚠ YOUR SILO WAS DESTROYED!', 'danger');
        if (result.assemblyInterrupted) { log('⚡ YOUR LAUNCH WAS ABORTED!', 'danger'); toast('Silo destroyed — build a new one!'); }
        else toast('Your rocket silo was destroyed!');
      }
    }
  }

  MP.send('OP_RESULT', result);
  updateUI();
}

// ── Attacker-side op result application ────────────────────────
function applyOpResult(data) {
  const { opId, opType, success, jammed } = data;
  const op = MP.pendingOps[opId];
  if (!op) return;
  delete MP.pendingOps[opId];
  op.done = true;
  if (op.ring) { RINGS.remove(op.ring); op.ring = null; }

  if (!success) { log(`${opType} FAILED${jammed ? ' — jammer interference' : ''}`, 'warn'); SFX.opFail(); return; }

  if (opType === 'RECON') {
    spawnSearchPulse(op.lat, op.lon);
    let found = 0;
    for (const rd of data.revealedLabs || []) {
      let lab = state.ai.labs.find(l => l.id === rd.id);
      if (!lab) { lab = new Lab(rd.lat, rd.lon, REGIONS[rd.regionId] || null, 'ai'); lab.id = rd.id; state.ai.labs.push(lab); }
      if (!state.player.revealedEnemyLabs.some(r => r.lab.id === lab.id)) {
        state.player.revealedEnemyLabs.push({ lab }); createLabMarker(lab, false);
        if (lab.region) state.player.knownEnemyRegions.add(lab.region.id); found++;
      }
    }
    for (const jd of data.revealedJammers || []) {
      let j = state.ai.jammers.find(x => x.id === jd.id);
      if (!j) { j = new Jammer(jd.lat, jd.lon, null, 'ai'); j.id = jd.id; state.ai.jammers.push(j); }
      if (!state.player.revealedEnemyJammers.some(x => x.id === j.id)) {
        state.player.revealedEnemyJammers.push(j); createJammerMarker(j, false); found++;
      }
    }
    for (const rd of data.revealedReactors || []) {
      let r = state.ai.reactors.find(x => x.id === rd.id);
      if (!r) { r = new Reactor(rd.lat, rd.lon, null, 'ai'); r.id = rd.id; state.ai.reactors.push(r); }
      if (!state.player.revealedEnemyReactors.some(x => x.id === r.id)) {
        state.player.revealedEnemyReactors.push(r); createReactorMarker(r, false); found++;
      }
    }
    for (const dd of data.revealedDefenses || []) {
      let d = state.ai.defenses.find(x => x.id === dd.id);
      if (!d) { d = new Defense(dd.lat, dd.lon, null, 'ai'); d.id = dd.id; state.ai.defenses.push(d); }
      if (!state.player.revealedEnemyDefenses.some(x => x.id === d.id)) {
        state.player.revealedEnemyDefenses.push(d); createDefenseMarker(d, false); found++;
      }
    }
    for (const od of data.revealedOilFields || []) {
      let o = state.ai.oilFields.find(x => x.id === od.id);
      if (!o) { o = new OilField(od.lat, od.lon, REGIONS[od.regionId] || null, 'ai'); o.id = od.id; state.ai.addOilField(o); }
      if (!state.player.revealedEnemyOilFields.some(x => x.id === o.id)) {
        state.player.revealedEnemyOilFields.push(o); createOilFieldMarker(o, false);
        log('RECON: Enemy oil field located! Use STEAL to drain it!', 'ok'); found++;
      }
    }
    if (data.revealedSilo && !state.player.revealedEnemySilo) {
      let s = state.ai.silo;
      if (!s || s.id !== data.revealedSilo.id) {
        s = new Silo(data.revealedSilo.lat, data.revealedSilo.lon, null, 'ai');
        s.id = data.revealedSilo.id; state.ai.silo = s;
      }
      state.player.revealedEnemySilo = s; createSiloMarker(s, false);
      log('RECON: Enemy ROCKET SILO located! SABOTAGE it!', 'ok'); found++;
    }
    SFX.opSuccess();
    if (found > 0) { log(`RECON SUCCESS: ${found} structure(s) revealed!`, 'ok'); toast(`${found} structure(s) revealed!`); }
    else log('RECON: Nothing new found in that area.', 'imp');

  } else if (opType === 'STEAL') {
    SFX.opSuccess();
    if (data.stealKind === 'oilField') {
      state.player.credits += data.creditsGained || 0;
      log(`STEAL SUCCESS: +${data.creditsGained}c from enemy oil field!`, 'ok'); toast(`+${data.creditsGained}c drained!`);
    } else if (data.stealKind === 'reactor') {
      state.player.depletedUranium = Math.min(100, state.player.depletedUranium + (data.uraniumGained || 0));
      log(`STEAL SUCCESS: +${data.uraniumGained}% uranium from enemy reactor!`, 'ok'); toast(`+${data.uraniumGained}% uranium stolen!`);
    } else {
      state.player.science = Math.min(100, state.player.science + (data.sciGained || 0));
      log(`STEAL SUCCESS: +${data.sciGained}% science!`, 'ok'); toast(`+${data.sciGained}% science stolen!`);
    }

  } else if (opType === 'SABOTAGE') {
    if (!data.hit) { log('SABOTAGE: No valid target in range.', 'warn'); SFX.opFail(); return; }
    SFX.opSuccess();
    const { kind, id } = data.hit;
    if (kind === 'lab') {
      const rev = state.player.revealedEnemyLabs.find(r => r.lab.id === id);
      if (rev) { rev.lab.disabledUntil = Date.now() + C.SABOTAGE_DUR; setMarkerEnabled(rev.lab.marker, false); }
      log('SABOTAGE SUCCESS: Enemy lab disabled!', 'ok'); toast('Enemy lab sabotaged!');
      if (data.assemblyInterrupted) { log('⚡ Enemy assembly INTERRUPTED!', 'ok'); toast('Enemy ASSEMBLY INTERRUPTED!'); }
    } else if (kind === 'jammer') {
      const j = state.player.revealedEnemyJammers.find(x => x.id === id);
      if (j) { if (j.marker) { MARKERS.remove(j.marker); j.marker = null; }
        state.ai.jammers = state.ai.jammers.filter(x => x.id !== id);
        state.player.revealedEnemyJammers = state.player.revealedEnemyJammers.filter(x => x.id !== id); }
      log('SABOTAGE SUCCESS: Enemy jammer destroyed!', 'ok'); toast('Enemy jammer obliterated!');
    } else if (kind === 'reactor') {
      const r = state.player.revealedEnemyReactors.find(x => x.id === id);
      if (r) { if (r.marker) { MARKERS.remove(r.marker); r.marker = null; }
        state.ai.reactors = state.ai.reactors.filter(x => x.id !== id);
        state.player.revealedEnemyReactors = state.player.revealedEnemyReactors.filter(x => x.id !== id); }
      log('SABOTAGE SUCCESS: Enemy reactor destroyed!', 'ok'); toast('Enemy reactor destroyed!');
    } else if (kind === 'defense') {
      const d = state.player.revealedEnemyDefenses.find(x => x.id === id);
      if (d) { if (d.marker) { MARKERS.remove(d.marker); d.marker = null; }
        state.ai.defenses = state.ai.defenses.filter(x => x.id !== id);
        state.player.revealedEnemyDefenses = state.player.revealedEnemyDefenses.filter(x => x.id !== id); }
      log('SABOTAGE SUCCESS: Enemy defense system destroyed!', 'ok'); toast('Enemy defense system neutralised!');
    } else if (kind === 'silo') {
      const s = state.player.revealedEnemySilo;
      if (s) { if (s.marker) { MARKERS.remove(s.marker); s.marker = null; }
        state.ai.silo = null; state.player.revealedEnemySilo = null; }
      log('SABOTAGE SUCCESS: Enemy SILO destroyed!', 'ok');
      if (data.assemblyInterrupted) { log('⚡ Enemy LAUNCH ABORTED!', 'ok'); toast('Enemy silo destroyed — launch aborted!'); }
      else toast('Enemy rocket silo obliterated!');
    }
  }

  refreshFogMarkers();
  updateUI();
}
