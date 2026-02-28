'use strict';

// ═══════════════════════════════════════════════════════════════
//  THREE.JS SCENE SETUP
// ═══════════════════════════════════════════════════════════════
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 2.9);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.getElementById('canvas-container').appendChild(renderer.domElement);

// Stars
(() => {
  const n = 2200, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const phi = Math.acos(2 * Math.random() - 1);
    const th  = Math.random() * Math.PI * 2;
    const r   = 50 + Math.random() * 30;
    pos[i*3]   = r * Math.sin(phi) * Math.cos(th);
    pos[i*3+1] = r * Math.cos(phi);
    pos[i*3+2] = r * Math.sin(phi) * Math.sin(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.07 })));
})();

// Lighting
scene.add(new THREE.AmbientLight(0x4a6a88, 0.40));
const sun = new THREE.DirectionalLight(0xddeeff, 1.6);
sun.position.set(4, 2, 3);
scene.add(sun);

// Globe group — everything on the planet lives here
const G_GROUP = new THREE.Group();
scene.add(G_GROUP);

// Ocean sphere — higher segments for smoother silhouette
const oceanMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1.0, 96, 96),
  new THREE.MeshPhongMaterial({ color: 0x6aaac8, shininess: 6, specular: 0x1a3a50 })
);
G_GROUP.add(oceanMesh);

// Atmosphere glow
G_GROUP.add(new THREE.Mesh(
  new THREE.SphereGeometry(1.06, 32, 32),
  new THREE.MeshBasicMaterial({
    color: 0x2a6090, transparent: true, opacity: 0.07,
    side: THREE.BackSide, blending: THREE.AdditiveBlending,
  })
));


// ═══════════════════════════════════════════════════════════════
//  COORDINATE UTILITIES
// ═══════════════════════════════════════════════════════════════
function ll2v3(lat, lon, r = 1.002) {
  const phi   = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta)
  );
}

function v3ToLL(v) {
  const n = v.clone().normalize();
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, n.y))) * 180 / Math.PI;
  let theta = Math.atan2(n.z, -n.x);
  if (theta < 0) theta += 2 * Math.PI;
  const lon = theta * 180 / Math.PI - 180;
  return { lat, lon };
}

// ═══════════════════════════════════════════════════════════════
//  GLOBE RENDERING — canvas texture (solid, no triangulation holes)
//  + 3D border line meshes per region for hover highlighting
// ═══════════════════════════════════════════════════════════════

let countryFeats     = [];
const regionBorders  = {};   // regionKey → THREE.LineSegments
const countryByRegion = {}; // regionKey → [feat, ...]
let overlayCanvas, overlayCtx, overlayTex, overlaySphere;
let hoveredRegionKey = null;
let landCanvas = null;   // kept after build for land/ocean sampling

function isOnLand(lat, lon) {
  if (!landCanvas) return true;  // canvas not ready — fail open
  const W = landCanvas.width, H = landCanvas.height;
  const [x, y] = llToXY(lon, lat, W, H);
  const px = landCanvas.getContext('2d')
    .getImageData(Math.floor(Math.min(x, W - 1)), Math.floor(Math.min(y, H - 1)), 1, 1).data;
  // Ocean is #6aaac8 = rgb(106,170,200). Land is #0d1e2c = rgb(13,30,44).
  // If pixel is dark (avg brightness < 80) it's land, otherwise ocean.
  return (px[0] + px[1] + px[2]) / 3 < 80;
}


async function buildGlobeCountries() {
  try {
    const res  = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
    const topo = await res.json();
    countryFeats = topojson.feature(topo, topo.objects.countries).features;

    // Pre-group by region for fast hover updates
    for (const feat of countryFeats) {
      const cen = polyCentroid(feat.geometry);
      const reg = getRegion(cen.lat, cen.lon);
      if (reg) (countryByRegion[reg.id] = countryByRegion[reg.id] || []).push(feat);
    }

    // ── 1. Paint all countries onto a 4096×2048 canvas, use as sphere texture ──
    const W = 4096, H = 2048;
    landCanvas = document.createElement('canvas');
    landCanvas.width = W; landCanvas.height = H;
    const baseCanvas = landCanvas;
    const ctx = baseCanvas.getContext('2d');

    // ── Ocean base ───────────────────────────────────────────
    ctx.fillStyle = '#6aaac8';
    ctx.fillRect(0, 0, W, H);

    // ── Land — single unified dark navy, no borders ──────────
    ctx.fillStyle = '#0d1e2c';
    for (const feat of countryFeats) {
      geoFill(ctx, feat.geometry, W, H);
    }

    // Very subtle coastline edge — same dark tone, barely visible
    ctx.strokeStyle = 'rgba(10,25,40,0.55)';
    ctx.lineWidth   = 0.5;
    for (const feat of countryFeats) {
      ctx.beginPath();
      geoTrace(ctx, feat.geometry, W, H);
      ctx.stroke();
    }

    const baseTex = new THREE.CanvasTexture(baseCanvas);
    baseTex.minFilter  = THREE.LinearFilter;
    baseTex.magFilter  = THREE.LinearFilter;
    baseTex.generateMipmaps = false;
    baseTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    oceanMesh.material.map   = baseTex;
    oceanMesh.material.color.set(0xffffff);

    // ── Hillshade: real-world elevation painted directly into land pixels ──
    {
      // Try to load NASA/PlanetPixelEmporium heightmap (bright=mountains, dark=lowlands)
      // Falls back to procedural noise if CORS blocks it (e.g. file://)
      let hmData = null, hmW = 0, hmH = 0;
      try {
        const hmImg = new Image();
        hmImg.crossOrigin = 'anonymous';
        hmImg.src = 'https://cdn.jsdelivr.net/gh/jeromeetienne/threex.planets@master/images/earthbump1k.jpg';
        await new Promise((res, rej) => { hmImg.onload = res; hmImg.onerror = rej; });
        const hmc = document.createElement('canvas');
        hmc.width = hmImg.width; hmc.height = hmImg.height;
        hmc.getContext('2d').drawImage(hmImg, 0, 0);
        const raw = hmc.getContext('2d').getImageData(0, 0, hmc.width, hmc.height);
        hmData = raw.data; hmW = hmc.width; hmH = hmc.height;
      } catch(e) { console.warn('Heightmap CORS blocked, using procedural noise', e); }

      const imgData = ctx.getImageData(0, 0, W, H);
      const d = imgData.data;

      // Procedural fallback helpers
      function _sn(x, y) { const v = Math.sin(x*127.1+y*311.7)*43758.5453; return v-Math.floor(v); }
      function _vn(x, y) {
        const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
        const ux=xf*xf*(3-2*xf),uy=yf*yf*(3-2*yf);
        return _sn(xi,yi)*(1-ux)*(1-uy)+_sn(xi+1,yi)*ux*(1-uy)+_sn(xi,yi+1)*(1-ux)*uy+_sn(xi+1,yi+1)*ux*uy;
      }

      for (let py = 0; py < H; py++) {
        const lat = Math.PI * (0.5 - py / H);
        const cl  = Math.max(0.15, Math.cos(lat));
        for (let px = 0; px < W; px++) {
          const i = (py * W + px) * 4;
          if ((d[i] + d[i+1] + d[i+2]) / 3 >= 80) continue; // skip ocean pixels

          let v;
          if (hmData) {
            // Sample real-world heightmap (already equirectangular — no pole correction needed)
            const hx = Math.round(px / W * (hmW - 1));
            const hy = Math.round(py / H * (hmH - 1));
            v = hmData[(hy * hmW + hx) * 4] / 255;
          } else {
            // Procedural fallback with cos(lat) pole correction
            v = _vn(px/(180*cl),py/180)*0.42 + _vn(px/(80*cl),py/80)*0.28 +
                _vn(px/(38*cl), py/38) *0.18 + _vn(px/(17*cl),py/17)*0.09 +
                _vn(px/(8*cl),  py/8)  *0.05;
          }
          v = Math.pow(Math.min(1, Math.max(0, v)), 0.85);
          // Lerp: valley #0a1520 (10,21,32) → peak #224468 (34,68,104)
          d[i]   = Math.round(10 + v * 24);
          d[i+1] = Math.round(21 + v * 47);
          d[i+2] = Math.round(32 + v * 72);
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }
    oceanMesh.material.needsUpdate = true;

    // ── 2. Hover overlay — semi-transparent sphere redrawn on hover ──
    overlayCanvas        = document.createElement('canvas');
    overlayCanvas.width  = 2048;
    overlayCanvas.height = 1024;
    overlayCtx  = overlayCanvas.getContext('2d');
    overlayTex  = new THREE.CanvasTexture(overlayCanvas);
    overlaySphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.0018, 64, 64),
      new THREE.MeshBasicMaterial({
        map: overlayTex, transparent: true, depthWrite: false,
      })
    );
    G_GROUP.add(overlaySphere);

    // ── 3. 3D border line-segments per region (shown on hover) ──
    buildRegionBorderLines(countryFeats);

  } catch (e) {
    console.warn('Globe: failed to load country data', e);
  }
}

// ── Canvas drawing helpers ───────────────────────────────────
function polyCentroid(geometry) {
  let sLon = 0, sLat = 0, n = 0;
  const rings = geometry.type === 'Polygon'
    ? [geometry.coordinates[0]]
    : geometry.coordinates.map(p => p[0]);
  for (const ring of rings)
    for (const [lon, lat] of ring) { sLon += lon; sLat += lat; n++; }
  return { lon: sLon / n, lat: sLat / n };
}

function countryColor(region, id) {
  const base = new THREE.Color(region ? region.color : 0x505050);
  const h = ((parseInt(id) || 7) * 2654435761) >>> 0;
  const t = ((h % 1000) / 1000) - 0.5;
  return new THREE.Color(
    Math.max(0.04, Math.min(0.88, base.r + t * 0.14)),
    Math.max(0.04, Math.min(0.88, base.g + t * 0.10)),
    Math.max(0.04, Math.min(0.88, base.b + t * 0.12)),
  );
}

function llToXY(lon, lat, W, H) {
  return [(lon + 180) / 360 * W, (90 - lat) / 180 * H];
}

function geoFill(ctx, geometry, W, H) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) {
    ctx.beginPath();
    for (const ring of rings) {
      let prevLon = null;
      for (const [lon, lat] of ring) {
        const [x, y] = llToXY(lon, lat, W, H);
        // Antimeridian crossing: jump > 180° in longitude → lift the pen
        if (prevLon === null || Math.abs(lon - prevLon) > 180) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevLon = lon;
      }
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
}

function geoTrace(ctx, geometry, W, H) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      let prevLon = null;
      for (const [lon, lat] of ring) {
        const [x, y] = llToXY(lon, lat, W, H);
        if (prevLon === null || Math.abs(lon - prevLon) > 180) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevLon = lon;
      }
      ctx.closePath();
    }
  }
}

// ── 3D border lines per region ───────────────────────────────
function buildRegionBorderLines(feats) {
  const segsPerRegion = {};

  for (const feat of feats) {
    const cen = polyCentroid(feat.geometry);
    const reg = getRegion(cen.lat, cen.lon);
    if (!reg) continue;
    const buf = segsPerRegion[reg.id] || (segsPerRegion[reg.id] = []);
    const polys = feat.geometry.type === 'Polygon'
      ? [feat.geometry.coordinates] : feat.geometry.coordinates;
    for (const rings of polys) {
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [lo0, la0] = ring[i], [lo1, la1] = ring[i + 1];
          if (Math.abs(lo1 - lo0) > 90) continue;   // skip antimeridian jumps
          buf.push(ll2v3(la0, lo0, 1.003), ll2v3(la1, lo1, 1.003));
        }
      }
    }
  }

  for (const [key, segs] of Object.entries(segsPerRegion)) {
    const pos = [];
    for (const v of segs) pos.push(v.x, v.y, v.z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffeebb, transparent: true, opacity: 0, depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    G_GROUP.add(lines);
    regionBorders[key] = lines;
  }
}

// ── Hover update ─────────────────────────────────────────────
function updateHover(regionKey) {
  if (regionKey === hoveredRegionKey) return;
  hoveredRegionKey = regionKey;

  // Show/hide border lines
  for (const [k, lines] of Object.entries(regionBorders))
    lines.material.opacity = k === regionKey ? 0.9 : 0;

  // Redraw overlay canvas
  const W = overlayCanvas.width, H = overlayCanvas.height;
  overlayCtx.clearRect(0, 0, W, H);

  if (regionKey) {
    const reg = REGIONS[regionKey];
    // Warm golden fill for the hovered region
    overlayCtx.fillStyle = 'rgba(255, 224, 100, 0.18)';
    for (const feat of (countryByRegion[regionKey] || []))
      geoFill(overlayCtx, feat.geometry, W, H);

    // Bright border lines on the overlay canvas too
    overlayCtx.strokeStyle = 'rgba(255, 220, 80, 0.75)';
    overlayCtx.lineWidth   = 1.5;
    for (const feat of (countryByRegion[regionKey] || [])) {
      overlayCtx.beginPath();
      geoTrace(overlayCtx, feat.geometry, W, H);
      overlayCtx.stroke();
    }

    // Region label tooltip near top-center
    if (reg) showHoverLabel(reg.name);
  } else {
    hideHoverLabel();
  }

  overlayTex.needsUpdate = true;
}

// ═══════════════════════════════════════════════════════════════
//  MARKER + RING GROUPS
// ═══════════════════════════════════════════════════════════════
const MARKERS = new THREE.Group();
const RINGS   = new THREE.Group();
G_GROUP.add(MARKERS);
G_GROUP.add(RINGS);

// ── 3D building helpers ───────────────────────────────────────
function mkPart(geo, color) {
  const m = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
    color, specular: 0x112233, shininess: 40,
  }));
  m.userData.origColor = color;
  return m;
}

function placeGroup(group, lat, lon) {
  const pos = ll2v3(lat, lon, 1.003);
  const up  = pos.clone().normalize();
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  group.position.copy(pos);
}

// Set all child mesh colours — used for active/sabotaged state
function setMarkerEnabled(marker, enabled) {
  if (!marker) return;
  marker.traverse(child => {
    if (child.isMesh)
      child.material.color.setHex(enabled ? (child.userData.origColor ?? 0x888888) : 0x555555);
  });
}

// ── Lab: research facility ────────────────────────────────────
function createLabMarker(lab, isPlayer) {
  const CB = isPlayer ? 0x1e5220 : 0x521818;   // dark base / wing
  const CM = isPlayer ? 0x2e8a32 : 0x8a2e2e;   // main body
  const CR = isPlayer ? 0x3aaa3a : 0xaa3a3a;   // roof accent
  const CA = isPlayer ? 0x88ee44 : 0xee8844;   // antenna

  const g = new THREE.Group();

  const fnd  = mkPart(new THREE.BoxGeometry(0.030, 0.003, 0.024), CB);
  fnd.position.set(0, 0.0015, 0);

  const body = mkPart(new THREE.BoxGeometry(0.018, 0.018, 0.014), CM);
  body.position.set(0.002, 0.012, 0);

  const roof = mkPart(new THREE.BoxGeometry(0.022, 0.0025, 0.018), CR);
  roof.position.set(0.002, 0.0215, 0);

  const wing = mkPart(new THREE.BoxGeometry(0.010, 0.011, 0.010), CB);
  wing.position.set(-0.013, 0.0085, 0);

  const mast = mkPart(new THREE.CylinderGeometry(0.0007, 0.0009, 0.024, 4), CA);
  mast.position.set(0.005, 0.034, 0);

  const cross = mkPart(new THREE.BoxGeometry(0.010, 0.001, 0.001), CA);
  cross.position.set(0.005, 0.044, 0);

  g.add(fnd, body, roof, wing, mast, cross);
  placeGroup(g, lab.lat, lab.lon);
  g.userData.labId    = lab.id;
  g.userData.isPlayer = isPlayer;
  MARKERS.add(g);
  lab.marker = g;
  return g;
}

// ── Reactor: containment vessel + cooling tower ───────────────
function createReactorMarker(reactor, isPlayer) {
  const CB = isPlayer ? 0x0e5238 : 0x602a08;   // dark base
  const CM = isPlayer ? 0x1a7a5a : 0x8a4010;   // main vessel
  const CD = isPlayer ? 0x2aaa7a : 0xcc6622;   // dome / band
  const CC = isPlayer ? 0x226644 : 0x7a3818;   // cooling tower

  const g = new THREE.Group();

  const fnd = mkPart(new THREE.CylinderGeometry(0.020, 0.022, 0.004, 10), CB);
  fnd.position.set(0, 0.002, 0);

  const vessel = mkPart(new THREE.CylinderGeometry(0.015, 0.015, 0.022, 10), CM);
  vessel.position.set(0, 0.015, 0);

  const band = mkPart(new THREE.TorusGeometry(0.016, 0.0018, 4, 14), CD);
  band.position.set(0, 0.012, 0);
  band.rotation.x = Math.PI / 2;

  const dome = mkPart(new THREE.ConeGeometry(0.015, 0.013, 10), CD);
  dome.position.set(0, 0.032, 0);

  const cool = mkPart(new THREE.CylinderGeometry(0.005, 0.011, 0.030, 8), CC);
  cool.position.set(0.017, 0.023, 0.005);

  g.add(fnd, vessel, band, dome, cool);
  placeGroup(g, reactor.lat, reactor.lon);
  g.userData.reactorId = reactor.id;
  MARKERS.add(g);
  reactor.marker = g;
  return g;
}

// ── Jammer: signal transmission tower ────────────────────────
function createJammerMarker(jammer, isPlayer) {
  const CB = isPlayer ? 0xaa7700 : 0x991400;   // base structure
  const CM = isPlayer ? 0xddaa00 : 0xdd2200;   // mast / arms
  const CT = isPlayer ? 0xffdd22 : 0xff4422;   // tip

  const g = new THREE.Group();

  const pad = mkPart(new THREE.BoxGeometry(0.014, 0.003, 0.014), CB);
  pad.position.set(0, 0.0015, 0);

  const mast = mkPart(new THREE.CylinderGeometry(0.0010, 0.0013, 0.050, 4), CM);
  mast.position.set(0, 0.028, 0);

  const arm1 = mkPart(new THREE.BoxGeometry(0.038, 0.0012, 0.0012), CM);
  arm1.position.set(0, 0.013, 0);

  const arm2 = mkPart(new THREE.BoxGeometry(0.028, 0.0012, 0.0012), CM);
  arm2.position.set(0, 0.026, 0);

  const arm3 = mkPart(new THREE.BoxGeometry(0.018, 0.0012, 0.0012), CM);
  arm3.position.set(0, 0.037, 0);

  const tip = mkPart(new THREE.SphereGeometry(0.003, 5, 4), CT);
  tip.position.set(0, 0.054, 0);

  g.add(pad, mast, arm1, arm2, arm3, tip);
  placeGroup(g, jammer.lat, jammer.lon);
  g.userData.jammerId = jammer.id;
  MARKERS.add(g);
  jammer.marker = g;
  return g;
}

// ── Silo: underground launch facility + emerging missile ──────
function createSiloMarker(silo, isPlayer) {
  const CR = isPlayer ? 0x1a3a7a : 0x7a1a1a;   // outer rim
  const CS = isPlayer ? 0x080814 : 0x100808;   // inner shaft (dark)
  const CM = isPlayer ? 0xb0c4de : 0xe0c0b8;   // missile body
  const CN = isPlayer ? 0xd0e8ff : 0xffd0c8;   // nose cone

  const g = new THREE.Group();

  const rim = mkPart(new THREE.CylinderGeometry(0.018, 0.020, 0.007, 12), CR);
  rim.position.set(0, 0.0035, 0);

  const shaft = mkPart(new THREE.CylinderGeometry(0.012, 0.012, 0.007, 10), CS);
  shaft.position.set(0, 0.0035, 0);

  const mbody = mkPart(new THREE.CylinderGeometry(0.005, 0.007, 0.038, 8), CM);
  mbody.position.set(0, 0.026, 0);

  const nose = mkPart(new THREE.ConeGeometry(0.006, 0.016, 8), CN);
  nose.position.set(0, 0.053, 0);

  g.add(rim, shaft, mbody, nose);
  placeGroup(g, silo.lat, silo.lon);
  g.userData.siloId = silo.id;
  MARKERS.add(g);
  silo.marker = g;
  return g;
}

function createFogMarker(lat, lon, regionId) {
  const pos = ll2v3(lat, lon, 1.003);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.012, 0.022, 8),
    new THREE.MeshBasicMaterial({ color: 0x5577aa, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
  );
  ring.position.copy(pos);
  const up = pos.clone().normalize();
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
  ring.userData.isFog    = true;
  ring.userData.regionId = regionId;
  MARKERS.add(ring);
  return ring;
}

function spawnOpRing(lat, lon, color = 0x4a9acc) {
  const pos = ll2v3(lat, lon, 1.004);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.018, 0.028, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  );
  ring.position.copy(pos);
  const up = pos.clone().normalize();
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
  ring.userData.born = Date.now();
  RINGS.add(ring);
  return ring;
}

// Search-area pulse: a large ring that expands slowly from the RECON point
// to give the player a sense of the radius that was searched.
function spawnSearchPulse(lat, lon) {
  const pos = ll2v3(lat, lon, 1.004);
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.13, 0.16, 48),
    new THREE.MeshBasicMaterial({ color: 0x44ffaa, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  mesh.position.copy(pos);
  const up = pos.clone().normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
  mesh.userData.born      = Date.now();
  mesh.userData.isPulse   = true;   // slower fade, less expansion
  RINGS.add(mesh);
}

// ── Expanding shockwave rings at impact site ───────────────────
function spawnShockwave(pos) {
  const normal = pos.clone().normalize();
  const tmp    = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
  const right  = new THREE.Vector3().crossVectors(tmp, normal).normalize();
  const fwd    = new THREE.Vector3().crossVectors(normal, right).normalize();

  // Build unit circle in local tangent plane
  const N = 80;
  const unitPts = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    unitPts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }

  [[0, 0xffffff, 0.90, 900], [120, 0xff9900, 0.70, 1200], [280, 0xff2200, 0.50, 1500]].forEach(
    ([delay, color, maxOpacity, dur]) => {
      setTimeout(() => {
        // Build ring points in world tangent plane
        const worldPts = unitPts.map(p =>
          pos.clone()
            .addScaledVector(right, p.x * 0.001)
            .addScaledVector(fwd,   p.z * 0.001)
        );
        const geo = new THREE.BufferGeometry().setFromPoints(worldPts);
        const mat = new THREE.LineBasicMaterial({
          color, transparent: true, opacity: maxOpacity,
          blending: THREE.AdditiveBlending,
        });
        const ring = new THREE.Line(geo, mat);
        ring.position.set(0, 0, 0);  // points are already in world space
        G_GROUP.add(ring);

        const t0 = performance.now();
        function animRing() {
          const t = Math.min(1, (performance.now() - t0) / dur);
          const scale = 1 + t * 280;
          // Expand by scaling ring object (local origin = impact pos effectively)
          ring.scale.setScalar(scale);
          mat.opacity = maxOpacity * (1 - t * t);
          if (t < 1) requestAnimationFrame(animRing);
          else { G_GROUP.remove(ring); geo.dispose(); mat.dispose(); }
        }
        requestAnimationFrame(animRing);
      }, delay);
    }
  );
}

// ═══════════════════════════════════════════════════════════════
//  CAMERA CONTROLS
// ═══════════════════════════════════════════════════════════════
const cvs = renderer.domElement;
let drag = false, dragDist = 0;
let mx0 = 0, my0 = 0, mxc = 0, myc = 0;

cvs.addEventListener('mousedown', e => {
  drag = true; dragDist = 0;
  mx0 = mxc = e.clientX; my0 = myc = e.clientY;
});

cvs.addEventListener('mousemove', e => {
  if (drag) {
    const dx = e.clientX - mxc, dy = e.clientY - myc;
    dragDist += Math.hypot(dx, dy);
    mxc = e.clientX; myc = e.clientY;
    G_GROUP.rotation.y += dx * 0.006;
    G_GROUP.rotation.x = Math.max(-1.4, Math.min(1.4, G_GROUP.rotation.x + dy * 0.006));
    return;
  }
  // Hover detection
  const hit = raycastSphere(e.clientX, e.clientY);
  const reg = hit ? getRegion(hit.lat, hit.lon) : null;
  updateHover(reg ? reg.id : null);
  cvs.style.cursor = reg ? 'crosshair' : 'default';
});

cvs.addEventListener('mouseup', e => {
  if (drag && dragDist < 5) handleClick(e);
  drag = false;
});

cvs.addEventListener('mouseleave', () => {
  updateHover(null);
  cvs.style.cursor = 'default';
});

cvs.addEventListener('wheel', e => {
  camera.position.z = Math.max(1.6, Math.min(5.5, camera.position.z + e.deltaY * 0.002));
  e.preventDefault();
}, { passive: false });

// ═══════════════════════════════════════════════════════════════
//  RAYCASTING
// ═══════════════════════════════════════════════════════════════
const raycaster = new THREE.Raycaster();
const mouse2d   = new THREE.Vector2();

function raycastSphere(cx, cy) {
  mouse2d.x = (cx / window.innerWidth)  *  2 - 1;
  mouse2d.y = (cy / window.innerHeight) * -2 + 1;
  raycaster.setFromCamera(mouse2d, camera);
  const hits = raycaster.intersectObject(oceanMesh);
  if (!hits.length) return null;
  const local = G_GROUP.worldToLocal(hits[0].point.clone());
  return v3ToLL(local);
}

// ═══════════════════════════════════════════════════════════════
//  ANIMATION LOOP
// ═══════════════════════════════════════════════════════════════
const clock = new THREE.Clock();

(function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  // Slow auto-spin when not dragging (always on in menu; respects setting in-game)
  if (!drag && (SETTINGS.autoSpin || !state.player)) G_GROUP.rotation.y += 0.0003;

  // Expand + fade op rings
  for (const ring of [...RINGS.children]) {
    const age = (Date.now() - ring.userData.born) / 1000;
    if (ring.userData.isPulse) {
      // Search-area pulse: slow expand, lasts 3s
      if (age > 3.0) { RINGS.remove(ring); ring.geometry.dispose(); }
      else { ring.scale.setScalar(1 + age * 0.4); ring.material.opacity = 0.7 * (1 - age / 3.0); }
    } else {
      if (age > 2.5) { RINGS.remove(ring); ring.geometry.dispose(); }
      else { ring.scale.setScalar(1 + age * 1.8); ring.material.opacity = 0.85 * (1 - age / 2.5); }
    }
  }

  // Pulse fog markers
  for (const m of fogMarkers) {
    m.material.opacity = 0.35 + 0.3 * Math.sin(t * 2.5 + m.position.x * 8);
  }

  update();
  renderer.render(scene, camera);
})();

// ═══════════════════════════════════════════════════════════════
//  RESIZE
// ═══════════════════════════════════════════════════════════════
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
