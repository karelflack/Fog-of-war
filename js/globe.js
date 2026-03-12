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
function mkPart(geo, color, emissive = null) {
  const mat = new THREE.MeshPhongMaterial({
    color, specular: 0x223344, shininess: 55,
  });
  if (emissive !== null) {
    mat.emissive = new THREE.Color(emissive);
    mat.emissiveIntensity = 0.7;
    mat.userData = { emissive };
  }
  const m = new THREE.Mesh(geo, mat);
  m.userData.origColor    = color;
  m.userData.emissiveColor = emissive;
  return m;
}

function placeGroup(group, lat, lon) {
  const pos = ll2v3(lat, lon, 1.003);
  const up  = pos.clone().normalize();
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  group.position.copy(pos);
}


// Draw a radius circle on the sphere surface (chord-distance radius)
function createDefenseRadiusRing(lat, lon, chordRadius, color) {
  const center  = ll2v3(lat, lon, 1.0).normalize();
  const angle   = 2 * Math.asin(Math.min(1, chordRadius / 2));
  const right   = new THREE.Vector3().crossVectors(
    center, Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  ).normalize();
  const fwd = new THREE.Vector3().crossVectors(right, center).normalize();
  const pts = [];
  for (let i = 0; i <= 128; i++) {
    const t = (i / 128) * Math.PI * 2;
    pts.push(
      new THREE.Vector3()
        .addScaledVector(center, Math.cos(angle))
        .addScaledVector(right,  Math.sin(angle) * Math.cos(t))
        .addScaledVector(fwd,    Math.sin(angle) * Math.sin(t))
        .normalize().multiplyScalar(1.004)
    );
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 })
  );
  G_GROUP.add(line);
  return line;
}

function removeDefenseRadiusRing(ring) {
  if (!ring) return;
  G_GROUP.remove(ring);
  ring.geometry.dispose();
}

// ── Satellite system visuals ──────────────────────────────────

function createRadioTowerMarker(tower, isPlayer) {
  const col = isPlayer ? 0x44aaff : 0xff6644;
  const g = new THREE.Group();
  const base = mkPart(new THREE.CylinderGeometry(0.013, 0.017, 0.005, 8), 0x223344);
  base.position.set(0, 0.0025, 0);
  const mast = mkPart(new THREE.CylinderGeometry(0.003, 0.004, 0.048, 6), 0x334455);
  mast.position.set(0, 0.027, 0);
  const dish = mkPart(new THREE.SphereGeometry(0.015, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), col, col);
  dish.position.set(0.008, 0.056, 0.004);
  dish.rotation.z = -0.6;
  const tip = mkPart(new THREE.SphereGeometry(0.003, 5, 4), col, col);
  tip.position.set(0, 0.052, 0);
  g.add(base, mast, dish, tip);
  placeGroup(g, tower.lat, tower.lon);
  MARKERS.add(g);
  tower.marker = g;
  return g;
}

function createSatelliteMarker(isPlayer) {
  const panelCol = isPlayer ? 0x2255cc : 0xcc2222;
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.026, 0.016, 0.016),
    new THREE.MeshPhongMaterial({ color: 0x8899aa, emissive: 0x223344, emissiveIntensity: 0.5 })
  );
  const panelMat = new THREE.MeshPhongMaterial({ color: panelCol, emissive: panelCol, emissiveIntensity: 0.5 });
  const lp = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.002, 0.016), panelMat);
  lp.position.set(-0.030, 0, 0);
  const rp = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.002, 0.016), panelMat);
  rp.position.set(0.030, 0, 0);
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(0.007, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshPhongMaterial({ color: 0xccddee, emissive: 0x445566, emissiveIntensity: 0.4 })
  );
  dish.position.set(0, -0.012, 0);
  dish.rotation.x = Math.PI;
  g.add(body, lp, rp, dish);
  G_GROUP.add(g);
  return g;
}

function getSatellitePos(sat) {
  const N = sat.orbitNormal;
  const arb = Math.abs(N.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(N, arb).normalize();
  const v = new THREE.Vector3().crossVectors(N, u).normalize();
  const r = (typeof C !== 'undefined' && C.SATELLITE_ORBIT_RADIUS) || 1.10;
  return new THREE.Vector3()
    .addScaledVector(u, Math.cos(sat.phase))
    .addScaledVector(v, Math.sin(sat.phase))
    .multiplyScalar(r);
}

function updateSatelliteMarker(sat) {
  if (!sat.marker) return;
  const pos = getSatellitePos(sat);
  sat.marker.position.copy(pos);
  // Orient so solar panels face perpendicular to velocity
  const N = sat.orbitNormal;
  const arb = Math.abs(N.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(N, arb).normalize();
  const v = new THREE.Vector3().crossVectors(N, u).normalize();
  const tangent = new THREE.Vector3()
    .addScaledVector(u, -Math.sin(sat.phase))
    .addScaledVector(v,  Math.cos(sat.phase))
    .normalize();
  sat.marker.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tangent);
  // Update ground track dot
  if (sat.groundDot) {
    sat.groundDot.position.copy(pos.clone().normalize().multiplyScalar(1.003));
  }
}

function createOrbitRing(orbitNormal, isPlayer) {
  const N = orbitNormal;
  const arb = Math.abs(N.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(N, arb).normalize();
  const v = new THREE.Vector3().crossVectors(N, u).normalize();
  const r = (typeof C !== 'undefined' && C.SATELLITE_ORBIT_RADIUS) || 1.10;
  const pts = [];
  for (let i = 0; i <= 128; i++) {
    const t = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3().addScaledVector(u, Math.cos(t)).addScaledVector(v, Math.sin(t)).multiplyScalar(r));
  }
  const ring = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: isPlayer ? 0x4499ff : 0xff5533, transparent: true, opacity: 0.22 })
  );
  G_GROUP.add(ring);
  return ring;
}

function createGroundDot(isPlayer) {
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.006, 6, 6),
    new THREE.MeshBasicMaterial({ color: isPlayer ? 0x44aaff : 0xff6644, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending })
  );
  G_GROUP.add(dot);
  return dot;
}

function removeSatelliteVisuals(sat) {
  if (sat.marker)    { G_GROUP.remove(sat.marker);    sat.marker    = null; }
  if (sat.orbitRing) { G_GROUP.remove(sat.orbitRing); sat.orbitRing = null; }
  if (sat.groundDot) { G_GROUP.remove(sat.groundDot); sat.groundDot = null; }
}

function createOrbitPointDot(lat, lon) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.009, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending })
  );
  m.position.copy(ll2v3(lat, lon, 1.005));
  G_GROUP.add(m);
  return m;
}

// Set all child mesh colours — used for active/sabotaged state
function setMarkerEnabled(marker, enabled) {
  if (!marker) return;
  marker.traverse(child => {
    if (child.isMesh) {
      child.material.color.setHex(enabled ? (child.userData.origColor ?? 0x888888) : 0x444444);
      if (child.material.emissive) {
        child.material.emissiveIntensity = enabled ? 0.7 : 0;
      }
    }
    if (child.isMesh && child.userData.isGlow) {
      child.userData.disabled = !enabled;
    }
  });
}

// ── Lab: research facility ────────────────────────────────────
function createLabMarker(lab, isPlayer) {
  const CB  = isPlayer ? 0x1a4a1e : 0x4a1a1a;   // dark base
  const CM  = isPlayer ? 0x2a7a30 : 0x7a2a2a;   // main body
  const CR  = isPlayer ? 0x33993a : 0x993333;   // roof
  const CA  = isPlayer ? 0x66ff44 : 0xff8833;   // antenna (emissive)

  const g = new THREE.Group();

  const fnd  = mkPart(new THREE.BoxGeometry(0.032, 0.003, 0.026), CB);
  fnd.position.set(0, 0.0015, 0);

  const body = mkPart(new THREE.BoxGeometry(0.020, 0.020, 0.015), CM);
  body.position.set(0.002, 0.013, 0);

  const roof = mkPart(new THREE.BoxGeometry(0.024, 0.003, 0.019), CR);
  roof.position.set(0.002, 0.0245, 0);

  const wing = mkPart(new THREE.BoxGeometry(0.011, 0.012, 0.011), CB);
  wing.position.set(-0.014, 0.009, 0);

  // Antenna mast — emissive so it glows
  const mast = mkPart(new THREE.CylinderGeometry(0.0008, 0.001, 0.028, 5), CA, CA);
  mast.position.set(0.005, 0.038, 0);

  // Cross-arms
  const arm1 = mkPart(new THREE.BoxGeometry(0.014, 0.0012, 0.0012), CA, CA);
  arm1.position.set(0.005, 0.044, 0);

  const arm2 = mkPart(new THREE.BoxGeometry(0.009, 0.0012, 0.0012), CA, CA);
  arm2.position.set(0.005, 0.049, 0);

  // Beacon tip
  const tip = mkPart(new THREE.SphereGeometry(0.002, 6, 4), CA, CA);
  tip.position.set(0.005, 0.054, 0);
  tip.userData.isBeacon = true;

  g.add(fnd, body, roof, wing, mast, arm1, arm2, tip);
  placeGroup(g, lab.lat, lab.lon);
  g.userData.labId    = lab.id;
  g.userData.isPlayer = isPlayer;
  MARKERS.add(g);
  lab.marker = g;
  return g;
}

// ── Reactor: containment vessel + cooling towers ──────────────
function createReactorMarker(reactor, isPlayer) {
  const CB  = isPlayer ? 0x0a3a28 : 0x3a1a06;   // dark base
  const CM  = isPlayer ? 0x186650 : 0x7a380e;   // vessel
  const CD  = isPlayer ? 0x22cc88 : 0xee7722;   // dome (emissive)
  const CC  = isPlayer ? 0x1a5540 : 0x6a3010;   // cooling tower

  const g = new THREE.Group();

  const fnd = mkPart(new THREE.CylinderGeometry(0.022, 0.024, 0.004, 12), CB);
  fnd.position.set(0, 0.002, 0);

  const vessel = mkPart(new THREE.CylinderGeometry(0.016, 0.016, 0.024, 12), CM);
  vessel.position.set(0, 0.016, 0);

  const band = mkPart(new THREE.TorusGeometry(0.017, 0.002, 5, 16), CD, CD);
  band.position.set(0, 0.014, 0);
  band.rotation.x = Math.PI / 2;

  // Dome — emissive glow (reactor core indicator)
  const dome = mkPart(new THREE.SphereGeometry(0.016, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), CD, CD);
  dome.position.set(0, 0.028, 0);

  // Primary cooling tower
  const cool1 = mkPart(new THREE.CylinderGeometry(0.005, 0.013, 0.036, 9), CC);
  cool1.position.set(0.020, 0.022, 0.004);

  // Secondary cooling tower (slightly smaller)
  const cool2 = mkPart(new THREE.CylinderGeometry(0.004, 0.010, 0.028, 9), CC);
  cool2.position.set(-0.018, 0.018, -0.006);

  g.add(fnd, vessel, band, dome, cool1, cool2);
  placeGroup(g, reactor.lat, reactor.lon);
  g.userData.reactorId = reactor.id;
  MARKERS.add(g);
  reactor.marker = g;
  return g;
}

// ── Jammer: signal transmission tower ────────────────────────
function createJammerMarker(jammer, isPlayer) {
  const CB  = isPlayer ? 0x7a5500 : 0x771000;   // base
  const CM  = isPlayer ? 0xcc9900 : 0xcc2000;   // mast
  const CA  = isPlayer ? 0xffee33 : 0xff4422;   // arms (emissive)

  const g = new THREE.Group();

  const pad = mkPart(new THREE.BoxGeometry(0.016, 0.003, 0.016), CB);
  pad.position.set(0, 0.0015, 0);

  const mast = mkPart(new THREE.CylinderGeometry(0.0011, 0.0014, 0.054, 5), CM);
  mast.position.set(0, 0.030, 0);

  // Three cross-arms — all emissive, tapering inward
  const arm1 = mkPart(new THREE.BoxGeometry(0.042, 0.0013, 0.0013), CA, CA);
  arm1.position.set(0, 0.012, 0);

  const arm2 = mkPart(new THREE.BoxGeometry(0.030, 0.0013, 0.0013), CA, CA);
  arm2.position.set(0, 0.025, 0);

  const arm3 = mkPart(new THREE.BoxGeometry(0.018, 0.0013, 0.0013), CA, CA);
  arm3.position.set(0, 0.038, 0);

  // Glowing tip beacon
  const tip = mkPart(new THREE.SphereGeometry(0.0035, 6, 4), CA, CA);
  tip.position.set(0, 0.058, 0);
  tip.userData.isBeacon = true;

  g.add(pad, mast, arm1, arm2, arm3, tip);
  placeGroup(g, jammer.lat, jammer.lon);
  g.userData.jammerId = jammer.id;
  MARKERS.add(g);
  jammer.marker = g;
  return g;
}

// ── Defense System: ABM radar + interceptor battery ───────────
function createDefenseMarker(defense, isPlayer) {
  const CB  = isPlayer ? 0x0a2a3a : 0x3a0a0a;   // base pad
  const CM  = isPlayer ? 0x1a5a7a : 0x7a1a1a;   // structure
  const CR  = isPlayer ? 0x22aadd : 0xdd2222;   // radar dish / emissive
  const CL  = isPlayer ? 0x44ddff : 0xff4444;   // beacon

  const g = new THREE.Group();

  // Concrete base
  const base = mkPart(new THREE.CylinderGeometry(0.022, 0.024, 0.004, 10), CB);
  base.position.set(0, 0.002, 0);

  // Central pedestal
  const ped = mkPart(new THREE.CylinderGeometry(0.007, 0.009, 0.018, 8), CM);
  ped.position.set(0, 0.013, 0);

  // Radar dish (flat hemisphere facing up)
  const dish = mkPart(new THREE.SphereGeometry(0.016, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), CR, CR);
  dish.rotation.x = Math.PI;   // open face up
  dish.position.set(0, 0.024, 0);

  // Two interceptor missile tubes on either side
  const tube1 = mkPart(new THREE.CylinderGeometry(0.004, 0.004, 0.030, 6), CM);
  tube1.position.set(0.018, 0.019, 0);

  const tube2 = mkPart(new THREE.CylinderGeometry(0.004, 0.004, 0.030, 6), CM);
  tube2.position.set(-0.018, 0.019, 0);

  // Interceptor tips (emissive warheads)
  const tip1 = mkPart(new THREE.ConeGeometry(0.004, 0.010, 6), CL, CL);
  tip1.position.set(0.018, 0.039, 0);
  tip1.userData.isBeacon = true;

  const tip2 = mkPart(new THREE.ConeGeometry(0.004, 0.010, 6), CL, CL);
  tip2.position.set(-0.018, 0.039, 0);
  tip2.userData.isBeacon = true;

  g.add(base, ped, dish, tube1, tube2, tip1, tip2);
  placeGroup(g, defense.lat, defense.lon);
  g.userData.defenseId = defense.id;
  MARKERS.add(g);
  defense.marker = g;
  return g;
}

// ── Silo: underground launch facility + emerging missile ──────
function createSiloMarker(silo, isPlayer) {
  const CR  = isPlayer ? 0x1a3a7a : 0x7a1a1a;   // outer rim
  const CS  = isPlayer ? 0x060810 : 0x100606;   // inner shaft
  const CM  = isPlayer ? 0x8899bb : 0xbb8888;   // missile body
  const CN  = isPlayer ? 0xaaddff : 0xffaaaa;   // nose (emissive)

  const g = new THREE.Group();

  // Concrete rim — slightly larger + warning stripes via colour
  const rim = mkPart(new THREE.CylinderGeometry(0.020, 0.022, 0.006, 14), CR);
  rim.position.set(0, 0.003, 0);

  // Dark shaft interior
  const shaft = mkPart(new THREE.CylinderGeometry(0.013, 0.013, 0.006, 12), CS);
  shaft.position.set(0, 0.003, 0);

  // Missile body
  const mbody = mkPart(new THREE.CylinderGeometry(0.0055, 0.008, 0.042, 9), CM);
  mbody.position.set(0, 0.028, 0);

  // Fins (two thin boxes at base of missile)
  const fin1 = mkPart(new THREE.BoxGeometry(0.016, 0.006, 0.002), CR);
  fin1.position.set(0, 0.010, 0);
  const fin2 = mkPart(new THREE.BoxGeometry(0.002, 0.006, 0.016), CR);
  fin2.position.set(0, 0.010, 0);

  // Nose cone — emissive warhead indicator
  const nose = mkPart(new THREE.ConeGeometry(0.0058, 0.018, 9), CN, CN);
  nose.position.set(0, 0.058, 0);
  nose.userData.isBeacon = true;

  g.add(rim, shaft, mbody, fin1, fin2, nose);
  placeGroup(g, silo.lat, silo.lon);
  g.userData.siloId = silo.id;
  MARKERS.add(g);
  silo.marker = g;
  return g;
}

// ── Oil Field: nodding-donkey pump jack (animated) ────────────
function createOilFieldMarker(oilField, isPlayer) {
  const CB  = isPlayer ? 0x141008 : 0x0c0804;   // concrete pad
  const CM  = isPlayer ? 0x3a2c1a : 0x221208;   // structural steel
  const CE  = isPlayer ? 0x28200e : 0x180c04;   // engine house
  const CW  = isPlayer ? 0x6a5030 : 0x4a1c08;   // counterweight
  const CL  = isPlayer ? 0xff9900 : 0xff3300;   // safety beacon (emissive)

  const g = new THREE.Group();
  const PX = 0.002;    // pivot x (slightly forward)
  const PY = 0.044;    // samson post top height

  // ── Concrete base pad ────────────────────────────────────────
  const base = mkPart(new THREE.BoxGeometry(0.058, 0.003, 0.042), CB);
  base.position.set(0, 0.0015, 0);

  // ── Engine house (back of platform) ──────────────────────────
  const eng = mkPart(new THREE.BoxGeometry(0.022, 0.024, 0.026), CE);
  eng.position.set(-0.018, 0.014, 0);
  const engRoof = mkPart(new THREE.BoxGeometry(0.024, 0.005, 0.028), CM);
  engRoof.position.set(-0.018, 0.027, 0);

  // ── Samson post: 4 legs converging at pivot cap ───────────────
  const postData = [
    [PX - 0.011,  0.013, 0.22, -0.22],   // front-left
    [PX + 0.011,  0.013, -0.22, -0.22],  // front-right
    [PX - 0.011, -0.013, 0.22,  0.22],   // back-left
    [PX + 0.011, -0.013, -0.22,  0.22],  // back-right
  ];
  for (const [px, pz, rz, rx] of postData) {
    const post = mkPart(new THREE.BoxGeometry(0.003, 0.050, 0.0045), CM);
    post.position.set(px, PY * 0.52, pz);
    post.rotation.z = rz;
    post.rotation.x = rx;
    g.add(post);
  }
  // Bearing cap at top of Samson post
  const cap = mkPart(new THREE.BoxGeometry(0.014, 0.007, 0.020), CM);
  cap.position.set(PX, PY + 0.002, 0);

  g.add(base, eng, engRoof, cap);

  // ── Walking beam pivot group (animated) ──────────────────────
  const pivot = new THREE.Group();
  pivot.position.set(PX, PY + 0.005, 0);
  pivot.userData.isPumpBeam = true;
  pivot.userData.pumpPhase  = Math.random() * Math.PI * 2;  // random start so multiple pumps don't sync

  // Main walking beam (runs along x-axis)
  const walkBeam = mkPart(new THREE.BoxGeometry(0.062, 0.0040, 0.0055), CM);
  walkBeam.position.set(0.002, 0, 0);

  // Horsehead — two-piece downward-curved head at front (+x)
  const hh1 = mkPart(new THREE.BoxGeometry(0.009, 0.018, 0.006), CM);
  hh1.position.set(0.035, -0.007, 0);
  hh1.rotation.z = -0.38;
  const hh2 = mkPart(new THREE.BoxGeometry(0.013, 0.005, 0.006), CM);
  hh2.position.set(0.036, -0.018, 0);

  // Polish rod / bridle (hangs from horsehead tip toward wellhead)
  const rod = mkPart(new THREE.CylinderGeometry(0.0007, 0.0007, 0.014, 4), CM);
  rod.position.set(0.034, -0.026, 0);

  // Counterweight (heavy block at back end, −x)
  const cw = mkPart(new THREE.BoxGeometry(0.017, 0.022, 0.011), CW);
  cw.position.set(-0.027, 0.002, 0);

  // Safety light on counterweight — emissive, blinks with pumpPhase offset
  const safetyLight = mkPart(new THREE.SphereGeometry(0.003, 6, 4), CL, CL);
  safetyLight.position.set(-0.027, 0.014, 0.007);
  safetyLight.userData.isBeacon = true;
  safetyLight.userData.phase    = pivot.userData.pumpPhase + 0.9;

  // Pitman arm / crank (connects counterweight end to engine below)
  const crank = mkPart(new THREE.BoxGeometry(0.003, 0.022, 0.004), CM);
  crank.position.set(-0.019, -0.013, 0);
  crank.rotation.z = 0.32;

  pivot.add(walkBeam, hh1, hh2, rod, cw, safetyLight, crank);
  g.add(pivot);

  // ── Wellhead (where rod enters ground) ───────────────────────
  const wh = mkPart(new THREE.CylinderGeometry(0.003, 0.004, 0.010, 8), CE);
  wh.position.set(PX + 0.033, 0.005, 0);
  g.add(wh);

  placeGroup(g, oilField.lat, oilField.lon);
  g.userData.oilFieldId = oilField.id;
  g.userData.isPlayer   = isPlayer;
  MARKERS.add(g);
  oilField.marker = g;
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
  const _settings = typeof SETTINGS !== 'undefined' ? SETTINGS : null;
  const _state    = typeof state    !== 'undefined' ? state    : null;
  if (!drag && (_settings?.autoSpin || !_state?.player)) G_GROUP.rotation.y += 0.0003;

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
  for (const m of (typeof fogMarkers !== 'undefined' ? fogMarkers : [])) {
    m.material.opacity = 0.35 + 0.3 * Math.sin(t * 2.5 + m.position.x * 8);
  }

  // Pulse beacon tips + animate pump jack walking beams
  MARKERS.traverse(child => {
    if (child.isMesh && child.userData.isBeacon && child.material.emissiveIntensity > 0) {
      child.material.emissiveIntensity = 0.5 + 0.5 * Math.sin(t * 3.5 + (child.userData.phase || 0));
    }
    if (child.userData.isPumpBeam) {
      // Nodding donkey: beam rocks ±12° (~0.22 rad), one cycle ~6 seconds
      child.rotation.z = Math.sin(t * 1.05 + (child.userData.pumpPhase || 0)) * 0.22;
    }
  });

  if (typeof update !== 'undefined') update();
  // Update satellite marker positions each frame
  if (typeof state !== 'undefined') {
    for (const _t of (state.player?.towers || [])) {
      if (_t.satellite?.active && _t.satellite.marker) updateSatelliteMarker(_t.satellite);
    }
    for (const _t of (state.ai?.towers || [])) {
      if (_t.satellite?.active && _t.satellite.marker) updateSatelliteMarker(_t.satellite);
    }
  }
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
