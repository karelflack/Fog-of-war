'use strict';

// ═══════════════════════════════════════════════════════════════
//  SOUND ENGINE  (Web Audio API — fully synthesized, no files)
// ═══════════════════════════════════════════════════════════════
let _actx = null;
function actx() {
  if (!SETTINGS.sound) return null;
  if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
  if (_actx.state === 'suspended') _actx.resume();
  return _actx;
}

// Single oscillator tone with attack+decay envelope
function tone(freq, dur, type = 'sine', vol = 0.22, t0 = 0) {
  const c = actx(); if (!c) return;
  const now = c.currentTime + t0;
  const o = c.createOscillator(), g = c.createGain();
  o.connect(g); g.connect(c.destination);
  o.type = type;
  o.frequency.setValueAtTime(freq, now);
  g.gain.setValueAtTime(0.001, now);
  g.gain.linearRampToValueAtTime(vol, now + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, now + dur);
  o.start(now); o.stop(now + dur + 0.05);
}

// Frequency-ramping tone (for whoosh/sweep effects)
function ramp(f0, f1, dur, type = 'sine', vol = 0.20, t0 = 0) {
  const c = actx(); if (!c) return;
  const now = c.currentTime + t0;
  const o = c.createOscillator(), g = c.createGain();
  o.connect(g); g.connect(c.destination);
  o.type = type;
  o.frequency.setValueAtTime(f0, now);
  o.frequency.exponentialRampToValueAtTime(f1, now + dur);
  g.gain.setValueAtTime(vol, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + dur);
  o.start(now); o.stop(now + dur + 0.05);
}

// Band-pass filtered white noise burst
function noise(dur, vol = 0.25, t0 = 0, filterHz = 400) {
  const c = actx(); if (!c) return;
  const now = c.currentTime + t0;
  const sr  = c.sampleRate;
  const buf = c.createBuffer(1, Math.ceil(sr * (dur + 0.1)), sr);
  const dat = buf.getChannelData(0);
  for (let i = 0; i < dat.length; i++) dat[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(), flt = c.createBiquadFilter(), g = c.createGain();
  flt.type = 'bandpass'; flt.frequency.value = filterHz;
  src.buffer = buf;
  src.connect(flt); flt.connect(g); g.connect(c.destination);
  g.gain.setValueAtTime(0.001, now);
  g.gain.linearRampToValueAtTime(vol, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, now + dur);
  src.start(now); src.stop(now + dur + 0.1);
}

const SFX = {
  buildLab()    { tone(392,0.12,'sine',0.22); tone(523,0.22,'sine',0.18,0.10); },
  buildReactor(){ tone(130,0.18,'sawtooth',0.22); tone(196,0.22,'sine',0.16,0.10); tone(261,0.30,'sine',0.12,0.20); },
  buildJammer() { noise(0.08,0.30,0,600); tone(900,0.12,'square',0.14,0.06); tone(1200,0.08,'square',0.10,0.16); },
  buildSilo()   { noise(0.12,0.20,0,150); tone(80,0.50,'sine',0.30); tone(160,0.28,'sine',0.16,0.10); tone(320,0.18,'sine',0.10,0.20); },

  opLaunch()    { tone(880,0.06,'square',0.13); tone(880,0.06,'square',0.13,0.10); tone(1320,0.12,'square',0.16,0.20); },
  opSuccess()   { tone(440,0.08,'sine',0.18); tone(554,0.08,'sine',0.18,0.08); tone(659,0.22,'sine',0.22,0.16); },
  opFail()      { tone(440,0.10,'sawtooth',0.14); tone(330,0.12,'sawtooth',0.12,0.09); tone(220,0.28,'sawtooth',0.10,0.18); },

  alert()       { tone(880,0.08,'square',0.22); tone(660,0.08,'square',0.18,0.12); tone(880,0.08,'square',0.22,0.24); tone(660,0.14,'square',0.18,0.36); },
  destroyed()   { noise(0.35,0.45,0,180); tone(180,0.45,'sawtooth',0.22,0.04); tone(90,0.60,'sine',0.18,0.14); },

  sweep()       { ramp(700,180,0.90,'sine',0.22); },

  assemblyStart(){ [261,329,392,523].forEach((f,i) => tone(f,0.5+i*0.08,'sine',0.16,i*0.09)); },
  assemblyTick() { tone(1400,0.04,'square',0.12); noise(0.03,0.10,0.02,2200); },

  icbmLaunch()  { noise(0.60,0.40,0,120); tone(80,2.0,'sawtooth',0.28); ramp(120,2600,2.2,'sawtooth',0.20); },
  icbmImpact()  { noise(1.2,0.65,0,160); tone(55,1.5,'sine',0.40); tone(40,2.0,'sine',0.28,0.12); },

  victory()     { [261,329,392,523,659,784].forEach((f,i) => tone(f,0.5+i*0.04,'sine',0.16,i*0.09)); },
  defeat()      { [392,349,294,261,220,196].forEach((f,i) => tone(f,0.5,'sine',0.16,i*0.13)); },
};

// ── Klaxon alarm ───────────────────────────────────────────────
let _klaxonInterval = null;
function startKlaxon() {
  function blast() {
    ramp(740, 460, 0.28, 'sawtooth', 0.32, 0.00);
    ramp(740, 460, 0.28, 'sawtooth', 0.28, 0.34);
  }
  blast();
  _klaxonInterval = setInterval(blast, 700);
}
function stopKlaxon() {
  if (_klaxonInterval) { clearInterval(_klaxonInterval); _klaxonInterval = null; }
}

// ── Camera shake (CSS transform on canvas) ─────────────────────
function shakeCamera(duration = 1400, intensity = 12) {
  const canvas = renderer.domElement;
  const startT = performance.now();
  function shake() {
    const elapsed = performance.now() - startT;
    if (elapsed >= duration) { canvas.style.transform = ''; return; }
    const factor = 1 - elapsed / duration;
    const amp = intensity * factor * factor;
    const dx = (Math.random() - 0.5) * amp * 2;
    const dy = (Math.random() - 0.5) * amp * 2;
    canvas.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
    requestAnimationFrame(shake);
  }
  requestAnimationFrame(shake);
}
