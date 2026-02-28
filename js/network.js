'use strict';

// ═══════════════════════════════════════════════════════════════
//  MULTIPLAYER  (PeerJS WebRTC — peer-to-peer, no server needed)
// ═══════════════════════════════════════════════════════════════
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
  peer:     null,
  conn:     null,
  myId:     null,
  remoteNation:        null,
  remoteNationBonuses: { RECON: 0, STEAL: 0, SABOTAGE: 0 },
  pendingOps: {},   // opId → op object, waiting for OP_RESULT

  send(type, data) {
    if (this.conn?.open) this.conn.send(JSON.stringify({ type, data }));
  },

  _onConn(conn) {
    this.conn = conn;
    conn.on('data',  raw   => handleNetMsg(raw));
    conn.on('close', ()    => {
      if (!state.gameOver) { log('⚠ Opponent disconnected!', 'danger'); toast('Opponent disconnected!'); }
    });
    conn.on('error', err  => log(`Net error: ${err}`, 'warn'));
  },

  host() {
    const code = genRoomCode();
    this.isHost = true;
    this.myId   = code;
    mpStatus('Initialising…');
    if (typeof Peer === 'undefined') { mpStatus('PeerJS failed to load. Check your connection and reload.'); return; }
    this.peer = new Peer(code, { debug: 0 });
    this.peer.on('open', id => {
      this.myId = id;
      document.getElementById('mp-room-code').textContent = id;
      document.getElementById('mp-code-display').style.display = 'block';
      mpStatus('Waiting for opponent to connect…');
    });
    this.peer.on('connection', conn => {
      this._onConn(conn);
      conn.on('open', () => {
        mpStatus('Opponent connected! Pick your nation.');
        showNationSelect();
      });
    });
    this.peer.on('error', err => mpStatus(`Error: ${err.type}. Try a different code or reload.`));
  },

  join(code) {
    this.isHost = false;
    mpStatus('Connecting…');
    if (typeof Peer === 'undefined') { mpStatus('PeerJS failed to load. Check your connection and reload.'); return; }
    this.peer = new Peer({ debug: 0 });
    this.peer.on('open', () => {
      const conn = this.peer.connect(code, { reliable: true });
      this._onConn(conn);
      conn.on('open',  () => mpStatus('Connected! Waiting for host to pick a nation…'));
      conn.on('error', () => mpStatus('Connection failed — check the room code and try again.'));
    });
    this.peer.on('error', err => mpStatus(`Error: ${err.type}. Reload and try again.`));
  },
};

function mpDoHost() {
  MP.active = true;
  MP.host();
}
function mpDoJoin() {
  const code = (document.getElementById('mp-join-input')?.value || '').trim().toUpperCase();
  if (code.length < 4) { mpStatus('Enter a valid room code (at least 4 characters).'); return; }
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
function handleNetMsg(raw) {
  let msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
  const { type, data } = msg;

  switch (type) {

    // ── Guest receives host's nation → auto-assigns opposing nation ──
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

    // ── Opponent built a structure (add to ai state, hidden by fog) ──
    case 'BUILD_LAB': {
      if (!state.ai) break;
      const l = new Lab(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      l.id = data.id;
      state.ai.labs.push(l);
      state.ai.creditsPerSec = C.CREDITS_BASE + state.ai.labs.length * C.CREDITS_PER_LAB;
      break;
    }
    case 'BUILD_JAMMER': {
      if (!state.ai) break;
      const j = new Jammer(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      j.id = data.id;
      state.ai.jammers.push(j);
      break;
    }
    case 'BUILD_REACTOR': {
      if (!state.ai) break;
      const r = new Reactor(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      r.id = data.id;
      state.ai.reactors.push(r);
      break;
    }
    case 'BUILD_SILO': {
      if (!state.ai) break;
      const s = new Silo(data.lat, data.lon, REGIONS[data.regionId] || null, 'ai');
      s.id = data.id;
      state.ai.silo = s;
      break;
    }

    // ── Opponent launched an op against us — we are the defender ──
    case 'LAUNCH_OP': resolveRemoteOp(data); break;

    // ── Result of our op against opponent ─────────────────────
    case 'OP_RESULT': applyOpResult(data); break;

    // ── Opponent started assembly ──────────────────────────────
    case 'ASSEMBLY_START': {
      if (!state.ai) break;
      state.ai.assembling    = true;
      state.ai.assemblyStart = Date.now();
      log('⚠ INTEL: Enemy has initiated assembly!', 'danger');
      toast('Enemy assembly underway!');
      SFX.alert();
      break;
    }

    // ── Periodic resource sync ─────────────────────────────────
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

    // ── Opponent won ───────────────────────────────────────────
    case 'GAME_OVER': {
      if (!state.gameOver) endGame(false);
      break;
    }
  }
}

// ── Defender-side op resolution ────────────────────────────────
function resolveRemoteOp(data) {
  if (!state.player) return;
  const { opId, type, lat, lon, regionId } = data;
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
    result.revealedLabs = defender.labs
      .filter(l => origin.distanceTo(ll2v3(l.lat, l.lon)) <= C.RECON_RADIUS)
      .map(l => ({ id: l.id, lat: l.lat, lon: l.lon, regionId: l.region?.id || null }));
    result.revealedJammers = defender.jammers
      .filter(j => origin.distanceTo(ll2v3(j.lat, j.lon)) <= C.RECON_RADIUS)
      .map(j => ({ id: j.id, lat: j.lat, lon: j.lon }));
    result.revealedReactors = defender.reactors
      .filter(r => origin.distanceTo(ll2v3(r.lat, r.lon)) <= C.RECON_RADIUS)
      .map(r => ({ id: r.id, lat: r.lat, lon: r.lon }));
    result.revealedSilo = (defender.silo &&
      origin.distanceTo(ll2v3(defender.silo.lat, defender.silo.lon)) <= C.RECON_RADIUS)
      ? { id: defender.silo.id, lat: defender.silo.lat, lon: defender.silo.lon }
      : null;
    spawnSearchPulse(lat, lon);  // visual: someone just scanned our area

  } else if (type === 'STEAL') {
    const loss = 4;
    defender.science = Math.max(0, defender.science - loss);
    result.sciGained = 8;
    SFX.alert();
    log(`⚠ Enemy stole your science! −${loss}%`, 'danger');
    toast(`Enemy stole your science! −${loss}%`);

  } else if (type === 'SABOTAGE') {
    const t3 = ll2v3(lat, lon);
    const candidates = [];
    for (const lab of defender.labs) {
      if (!lab.isActive()) continue;
      candidates.push({ kind: 'lab', obj: lab, dist: t3.distanceTo(ll2v3(lab.lat, lab.lon)) });
    }
    for (const j of defender.jammers)
      candidates.push({ kind: 'jammer',  obj: j, dist: t3.distanceTo(ll2v3(j.lat, j.lon)) });
    for (const r of defender.reactors)
      candidates.push({ kind: 'reactor', obj: r, dist: t3.distanceTo(ll2v3(r.lat, r.lon)) });
    if (defender.silo)
      candidates.push({ kind: 'silo', obj: defender.silo, dist: t3.distanceTo(ll2v3(defender.silo.lat, defender.silo.lon)) });
    candidates.sort((a, b) => a.dist - b.dist);
    const hit = candidates.length > 0 && candidates[0].dist < 0.55 ? candidates[0] : null;
    result.hit = null;

    if (hit) {
      result.hit = { kind: hit.kind, id: hit.obj.id };
      if (hit.kind === 'lab') {
        hit.obj.disabledUntil = Date.now() + C.SABOTAGE_DUR;
        const interrupted = defender.interruptAssembly();
        result.assemblyInterrupted = interrupted;
        SFX.alert();
        if (hit.obj.marker) setMarkerEnabled(hit.obj.marker, false);
        log('⚠ Your lab was sabotaged! Offline 2min', 'danger');
        toast('Your lab sabotaged — offline 2min!');
        if (interrupted) { log('⚡ Your assembly was INTERRUPTED!', 'danger'); toast('YOUR ASSEMBLY INTERRUPTED!'); }
      } else if (hit.kind === 'jammer') {
        const j = hit.obj;
        if (j.marker) { MARKERS.remove(j.marker); j.marker = null; }
        defender.jammers = defender.jammers.filter(x => x.id !== j.id);
        SFX.destroyed(); log('⚠ Your jammer was destroyed!', 'danger'); toast('Your jammer was destroyed!');
      } else if (hit.kind === 'reactor') {
        const r = hit.obj;
        if (r.marker) { MARKERS.remove(r.marker); r.marker = null; }
        defender.reactors = defender.reactors.filter(x => x.id !== r.id);
        SFX.destroyed(); log('⚠ Your reactor was destroyed!', 'danger'); toast('Your reactor was destroyed!');
      } else if (hit.kind === 'silo') {
        const s = hit.obj;
        if (s.marker) { MARKERS.remove(s.marker); s.marker = null; }
        defender.silo = null;
        const interrupted = defender.interruptAssembly();
        result.assemblyInterrupted = interrupted;
        SFX.destroyed(); log('⚠ YOUR SILO WAS DESTROYED!', 'danger');
        if (interrupted) { log('⚡ YOUR LAUNCH WAS ABORTED!', 'danger'); toast('Silo destroyed — build a new one!'); }
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

  if (!success) {
    log(`${opType} FAILED${jammed ? ' — jammer interference' : ''}`, 'warn');
    SFX.opFail(); return;
  }

  if (opType === 'RECON') {
    spawnSearchPulse(op.lat, op.lon);
    let found = 0;

    for (const rd of data.revealedLabs || []) {
      let lab = state.ai.labs.find(l => l.id === rd.id);
      if (!lab) {
        lab = new Lab(rd.lat, rd.lon, REGIONS[rd.regionId] || null, 'ai');
        lab.id = rd.id;
        state.ai.labs.push(lab);
      }
      if (!state.player.revealedEnemyLabs.some(r => r.lab.id === lab.id)) {
        state.player.revealedEnemyLabs.push({ lab });
        createLabMarker(lab, false);
        if (lab.region) state.player.knownEnemyRegions.add(lab.region.id);
        found++;
      }
    }
    for (const jd of data.revealedJammers || []) {
      let j = state.ai.jammers.find(x => x.id === jd.id);
      if (!j) { j = new Jammer(jd.lat, jd.lon, null, 'ai'); j.id = jd.id; state.ai.jammers.push(j); }
      if (!state.player.revealedEnemyJammers.some(x => x.id === j.id)) {
        state.player.revealedEnemyJammers.push(j);
        createJammerMarker(j, false); found++;
      }
    }
    for (const rd of data.revealedReactors || []) {
      let r = state.ai.reactors.find(x => x.id === rd.id);
      if (!r) { r = new Reactor(rd.lat, rd.lon, null, 'ai'); r.id = rd.id; state.ai.reactors.push(r); }
      if (!state.player.revealedEnemyReactors.some(x => x.id === r.id)) {
        state.player.revealedEnemyReactors.push(r);
        createReactorMarker(r, false); found++;
      }
    }
    if (data.revealedSilo && !state.player.revealedEnemySilo) {
      let s = state.ai.silo;
      if (!s || s.id !== data.revealedSilo.id) {
        s = new Silo(data.revealedSilo.lat, data.revealedSilo.lon, null, 'ai');
        s.id = data.revealedSilo.id;
        state.ai.silo = s;
      }
      state.player.revealedEnemySilo = s;
      createSiloMarker(s, false);
      log('RECON: Enemy ROCKET SILO located! SABOTAGE it!', 'ok'); found++;
    }
    SFX.opSuccess();
    if (found > 0) { log(`RECON SUCCESS: ${found} structure(s) revealed!`, 'ok'); toast(`${found} structure(s) revealed!`); }
    else { log('RECON: Nothing new found in that area.', 'imp'); }

  } else if (opType === 'STEAL') {
    const gained = data.sciGained || 0;
    state.player.science = Math.min(100, state.player.science + gained);
    SFX.opSuccess();
    log(`STEAL SUCCESS: +${gained}% science!`, 'ok'); toast(`+${gained}% science stolen!`);

  } else if (opType === 'SABOTAGE') {
    if (!data.hit) { log('SABOTAGE: No valid target in range.', 'warn'); SFX.opFail(); return; }
    SFX.opSuccess();
    const { kind, id } = data.hit;
    if (kind === 'lab') {
      const rev = state.player.revealedEnemyLabs.find(r => r.lab.id === id);
      if (rev) { rev.lab.disabledUntil = Date.now() + C.SABOTAGE_DUR; setMarkerEnabled(rev.lab.marker, false); }
      log('SABOTAGE SUCCESS: Enemy lab disabled for 2min!', 'ok'); toast('Enemy lab sabotaged!');
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
