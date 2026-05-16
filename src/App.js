import { useState, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";

// ═══════════════════════════════════════════════════════════════════════════════
// GEOMETRY CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const mm = (v) => v / 1000;

const SHEET_T = mm(1.5);
const WALL_LEG = mm(70);
const MAIN_FACE = mm(210);
const RETURN_LEG = mm(30);
const FOLD_K_FACTOR = 0.4;

const SLOT_CUT = mm(1.6);
const SLOT_EDGE_GAP = mm(2);
const SLOT_LONG = MAIN_FACE - 2 * SLOT_EDGE_GAP;
const SLOT_BACK = WALL_LEG;
const SLOT_FRONT = RETURN_LEG;

const BOLT_DIA = mm(5);
const BOLT_EDGE = mm(15);

const MIN_VOID = mm(50);
const MIN_SLOT_EDGE = mm(25);
const MAX_CANTILEVER_RATIO = 0.35;

// Minimum Y-distance between two horizontal shelves whose X-ranges overlap.
// Geometry: lower shelf's wall leg rises 70mm UP, upper shelf's return drops 30mm DOWN,
// + 2×1.5mm sheet thickness + ~7mm working clearance for assembly = ~110mm.
// Below this gap, the folded legs collide and fabrication is impossible.
const MIN_SHELF_GAP = mm(110);

const DEFAULT_PARAMS = {
  symmetry: 0.0,
  harmony: 0.0,
  familiarity: 0.0,
  simplicity: 0.0,
  pattern: 0.0,
  contrast: 0.0,
  proportion: 0.0,
};

function makeRng(seed) {
  let s = (Math.abs(Math.round(seed * 99991)) || 1) % 2147483647;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
function paramSeed(p) {
  return Object.values(p).reduce((a, v, i) => a + v * (i + 1) * 37, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MATERIALS
// ═══════════════════════════════════════════════════════════════════════════════
const MAT_STEEL = new THREE.MeshStandardMaterial({
  color: 0x9a9893,
  roughness: 0.7,
  metalness: 0.4,
  side: THREE.DoubleSide,
});
const MAT_ALU = MAT_STEEL;
const MAT_EDGE = new THREE.LineBasicMaterial({ color: 0x2a3438 });
const MAT_BOLT = new THREE.MeshStandardMaterial({
  color: 0x3a3530,
  roughness: 0.45,
  metalness: 0.65,
});
const MAT_WALL = new THREE.MeshStandardMaterial({
  color: 0xfaf7f2,
  roughness: 0.92,
  metalness: 0.0,
  side: THREE.DoubleSide,
});

// ═══════════════════════════════════════════════════════════════════════════════
// FLAT FACE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function buildFaceWithHoles(width, height, holes = []) {
  const shape = new THREE.Shape();
  const hw = width / 2;
  const hh = height / 2;
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.lineTo(-hw, -hh);

  const holePaths = [];
  for (const h of holes) {
    const path = new THREE.Path();
    if (h.kind === "circle") {
      path.absellipse(h.x, h.y, h.r, h.r, 0, Math.PI * 2, false, 0);
    } else if (h.kind === "rect") {
      const hw2 = h.w / 2,
        hh2 = h.h / 2;
      path.moveTo(h.x - hw2, h.y - hh2);
      path.lineTo(h.x + hw2, h.y - hh2);
      path.lineTo(h.x + hw2, h.y + hh2);
      path.lineTo(h.x - hw2, h.y + hh2);
      path.lineTo(h.x - hw2, h.y - hh2);
    } else if (h.kind === "zslot") {
      throw new Error(
        "zslot must be decomposed before calling buildFaceWithHoles"
      );
    }
    holePaths.push(path);
  }
  for (const p of holePaths) shape.holes.push(p);

  const geom = new THREE.ShapeGeometry(shape);
  const mesh = new THREE.Mesh(geom, MAT_ALU);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function decomposeZSlot({ x, y, longLen, backLen, frontLen, cut, angle }) {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const xform = (lx, ly) => ({
    x: x + lx * cosA - ly * sinA,
    y: y + lx * sinA + ly * cosA,
  });

  const longCenter = xform(0, 0);
  const backCenter = xform(+longLen / 2 - cut / 2, +cut / 2 + backLen / 2);
  const frontCenter = xform(-longLen / 2 + cut / 2, -cut / 2 - frontLen / 2);

  return [
    {
      kind: "rect",
      x: longCenter.x,
      y: longCenter.y,
      w: longLen,
      h: cut,
      angle,
    },
    {
      kind: "rect",
      x: backCenter.x,
      y: backCenter.y,
      w: cut,
      h: backLen,
      angle,
    },
    {
      kind: "rect",
      x: frontCenter.x,
      y: frontCenter.y,
      w: cut,
      h: frontLen,
      angle,
    },
  ];
}

function buildFaceWithRotatedHoles(width, height, holes = []) {
  const shape = new THREE.Shape();
  const hw = width / 2,
    hh = height / 2;
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.lineTo(-hw, -hh);

  for (const h of holes) {
    const path = new THREE.Path();
    if (h.kind === "circle") {
      path.absellipse(h.x, h.y, h.r, h.r, 0, Math.PI * 2, false, 0);
    } else if (h.kind === "rect") {
      const a = h.angle || 0;
      const cosA = Math.cos(a),
        sinA = Math.sin(a);
      const w2 = h.w / 2,
        h2 = h.h / 2;
      const corners = [
        [-w2, -h2],
        [w2, -h2],
        [w2, h2],
        [-w2, h2],
      ].map(([lx, ly]) => [
        h.x + lx * cosA - ly * sinA,
        h.y + lx * sinA + ly * cosA,
      ]);
      path.moveTo(corners[0][0], corners[0][1]);
      path.lineTo(corners[1][0], corners[1][1]);
      path.lineTo(corners[2][0], corners[2][1]);
      path.lineTo(corners[3][0], corners[3][1]);
      path.lineTo(corners[0][0], corners[0][1]);
    }
    shape.holes.push(path);
  }

  const geom = new THREE.ShapeGeometry(shape);
  const mesh = new THREE.Mesh(geom, MAT_ALU);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildSimpleFace(width, height) {
  return buildFaceWithRotatedHoles(width, height, []);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERTICAL PANEL (C-fold)
// ═══════════════════════════════════════════════════════════════════════════════

function buildVerticalPanel(height, slots) {
  const g = new THREE.Group();

  const faceHoles = [];
  for (const s of slots) {
    const centerX_face = 0;
    const centerY_face = s.y - height / 2;

    const rects = decomposeZSlot({
      x: centerX_face,
      y: centerY_face,
      longLen: s.longLen || SLOT_LONG,
      backLen: s.backLen || SLOT_BACK,
      frontLen: s.frontLen || SLOT_FRONT,
      cut: s.cut || SLOT_CUT,
      angle: s.angle || 0,
    });
    faceHoles.push(...rects);
  }

  const mainFace = buildFaceWithRotatedHoles(MAIN_FACE, height, faceHoles);
  mainFace.rotation.y = -Math.PI / 2;
  mainFace.position.set(WALL_LEG, height / 2, MAIN_FACE / 2);
  g.add(mainFace);

  const wallLeg = buildSimpleFace(WALL_LEG, height);
  wallLeg.position.set(WALL_LEG / 2, height / 2, 0);
  g.add(wallLeg);

  const returnLeg = buildSimpleFace(RETURN_LEG, height);
  returnLeg.position.set(WALL_LEG - RETURN_LEG / 2, height / 2, MAIN_FACE);
  g.add(returnLeg);

  return g;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HORIZONTAL PANEL (Z-fold)
// ═══════════════════════════════════════════════════════════════════════════════

function buildHorizontalPanel(length, leftLocalX, rightLocalX, intersections) {
  const g = new THREE.Group();

  const wallLegHoles = [];
  for (const x of intersections) {
    const cxLocal = x.localX - length / 2;
    const off = WALL_LEG / 2 - BOLT_EDGE;
    wallLegHoles.push({
      kind: "circle",
      x: cxLocal - off,
      y: -off,
      r: BOLT_DIA / 2,
    });
    wallLegHoles.push({
      kind: "circle",
      x: cxLocal + off,
      y: +off,
      r: BOLT_DIA / 2,
    });
  }

  const returnLegHoles = [];
  for (const x of intersections) {
    const cxLocal = x.localX - length / 2;
    returnLegHoles.push({ kind: "circle", x: cxLocal, y: 0, r: BOLT_DIA / 2 });
  }

  const mainFace = buildFaceWithRotatedHoles(length, MAIN_FACE, []);
  mainFace.rotation.x = -Math.PI / 2;
  mainFace.position.set(length / 2, 0, MAIN_FACE / 2);
  g.add(mainFace);

  const wallLeg = buildFaceWithRotatedHoles(length, WALL_LEG, wallLegHoles);
  wallLeg.position.set(length / 2, +WALL_LEG / 2, 0);
  g.add(wallLeg);

  const returnLeg = buildFaceWithRotatedHoles(
    length,
    RETURN_LEG,
    returnLegHoles
  );
  returnLeg.position.set(length / 2, -RETURN_LEG / 2, MAIN_FACE);
  g.add(returnLeg);

  return g;
}

function buildDiagonalPanel(length, intersections) {
  return buildHorizontalPanel(length, 0, length, intersections);
}

function addBoltVisuals(root, world) {
  const headRadius = mm(4);
  const headThick = mm(2);
  const headGeom = new THREE.CylinderGeometry(
    headRadius,
    headRadius,
    headThick,
    12
  );
  for (const p of world.wallBolts) {
    const m = new THREE.Mesh(headGeom, MAT_BOLT);
    m.position.set(p.x, p.y, p.z);
    m.rotation.x = Math.PI / 2;
    m.castShadow = true;
    root.add(m);
  }
  for (const p of world.returnBolts) {
    const m = new THREE.Mesh(headGeom, MAT_BOLT);
    m.position.set(p.x, p.y, p.z);
    m.rotation.x = Math.PI / 2;
    m.castShadow = true;
    root.add(m);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHELF GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════
function generateShelf(perceptual, dims) {
  const symmetry = perceptual.symmetry;
  const harmony = perceptual.harmony;
  const familiarity = perceptual.familiarity;
  const simplicity = perceptual.simplicity;
  const pattern = perceptual.pattern;
  const contrast = perceptual.contrast;
  const proportion = perceptual.proportion;

  const W = dims.width;
  const H = dims.height;
  const D = MAIN_FACE;

  const root = new THREE.Group();
  root.name = "shelf";

  // ── STEP 1: VERTICAL POSITIONS ──────────────────────────────────────────────
  const numV = Math.round(2 + simplicity * 6);
  const posRng = makeRng(paramSeed(perceptual) * 13.1);
  const rawPos = [];
  for (let i = 0; i < numV; i++) rawPos.push(0.05 + posRng() * 0.9);
  rawPos.sort((a, b) => a - b);
  const evenPos = rawPos.map((_, i) => (i + 1) / (numV + 1));
  let vXFracs = rawPos.map((r, i) => evenPos[i] * (1 - pattern) + r * pattern);

  if (proportion > 0.01) {
    const propRng = makeRng(paramSeed(perceptual) * 19.3);
    const gaps = [];
    for (let i = 1; i < vXFracs.length; i++)
      gaps.push(vXFracs[i] - vXFracs[i - 1]);
    const minGapFrac = 0.35;
    const distorted = gaps.map((g, i) => {
      const scale =
        i % 2 === 0
          ? 1 + proportion * propRng() * 1.2
          : Math.max(minGapFrac, 1 - proportion * propRng() * 0.5);
      return g * scale;
    });
    let cx = vXFracs[0];
    for (let i = 0; i < distorted.length; i++) {
      cx += distorted[i];
      vXFracs[i + 1] = cx;
    }
    const mn = Math.min(...vXFracs),
      mx = Math.max(...vXFracs);
    vXFracs = vXFracs.map((f) => 0.05 + ((f - mn) / (mx - mn)) * 0.9);
  }
  vXFracs.sort((a, b) => a - b);

  const mirrorStr = 1 - symmetry;
  if (mirrorStr > 0.01 && vXFracs.length >= 2) {
    const n = vXFracs.length,
      half = Math.floor(n / 2);
    for (let i = 0; i < half; i++) {
      const j = n - 1 - i;
      vXFracs[j] = vXFracs[j] * (1 - mirrorStr) + (1 - vXFracs[i]) * mirrorStr;
    }
    if (n % 2 === 1) {
      const mid = Math.floor(n / 2);
      vXFracs[mid] = vXFracs[mid] * (1 - mirrorStr) + 0.5 * mirrorStr;
    }
    vXFracs.sort((a, b) => a - b);
  }

  let vXPos = vXFracs.map((f) => f * W);
  const MIN_SEP = mm(200);
  const filtered = [vXPos[0]];
  for (let i = 1; i < vXPos.length; i++) {
    if (vXPos[i] - filtered[filtered.length - 1] >= MIN_SEP)
      filtered.push(vXPos[i]);
  }
  vXPos = filtered.map((x) => Math.max(mm(80), Math.min(W - mm(80), x)));

  if (mirrorStr > 0.01 && vXPos.length >= 2) {
    const n = vXPos.length,
      half = Math.floor(n / 2);
    for (let i = 0; i < half; i++) {
      const j = n - 1 - i;
      vXPos[j] = vXPos[j] * (1 - mirrorStr) + (W - vXPos[i]) * mirrorStr;
    }
    if (n % 2 === 1) {
      const mid = Math.floor(n / 2);
      vXPos[mid] = vXPos[mid] * (1 - mirrorStr) + (W / 2) * mirrorStr;
    }
    vXPos.sort((a, b) => a - b);
  }

  // ── STEP 2: VERTICAL HEIGHTS ─────────────────────────────────────────────────
  const hRng = makeRng(paramSeed(perceptual) * 17.7);
  const vHeights = vXPos.map((x, vi) => {
    if (contrast < 0.01) return H;
    const tallShort = vi % 2 === 0 ? 1.0 : 1.0 - contrast * 0.5;
    const randVar = (hRng() - 0.5) * contrast * (0.2 + proportion * 0.3);
    const frac = Math.max(0.3, Math.min(1.0, tallShort + randVar));
    return H * frac;
  });

  if (proportion < 0.99 && vHeights.length >= 2) {
    const maxRatio = 2.0 + proportion * 4.0;
    for (let i = 1; i < vHeights.length; i++) {
      const r = vHeights[i] / vHeights[i - 1];
      if (r > maxRatio) vHeights[i] = vHeights[i - 1] * maxRatio;
      if (r < 1 / maxRatio) vHeights[i] = vHeights[i - 1] / maxRatio;
    }
  }

  // ── STEP 3: SHELF ZONES ──────────────────────────────────────────────────────
  const shelvesPerZone = Math.round(2 + simplicity * 3);
  const numLevels = Math.round(2 + simplicity * 5);
  const canonicalYs = [];
  const yRng = makeRng(paramSeed(perceptual) * 3.7);
  for (let i = 0; i < numLevels; i++) {
    const evenY = H * 0.1 + H * 0.85 * (i / (numLevels - 1 || 1));
    const randY = H * 0.1 + yRng() * H * 0.85;
    const familiarBlend = evenY * (1 - familiarity) + randY * familiarity;
    const contrastMod =
      i % 2 === 0 ? 1 + contrast * 0.4 : Math.max(0.3, 1 - contrast * 0.4);
    const contrasted = H * 0.1 + (familiarBlend - H * 0.1) * contrastMod;
    canonicalYs.push(Math.max(H * 0.08, Math.min(H * 0.95, contrasted)));
  }
  canonicalYs.sort((a, b) => a - b);

  // ── ENFORCE MINIMUM Y-SPACING (fabrication clearance) ───────────────────────
  // Two stacked horizontals collide if too close: lower shelf's 70mm wall leg rises UP,
  // upper shelf's 30mm front lip drops DOWN. Below MIN_SHELF_GAP they overlap and
  // fabrication is impossible. Walk bottom-up and drop any Y too close to the last kept.
  {
    const filteredY = [];
    for (const y of canonicalYs) {
      if (
        filteredY.length === 0 ||
        y - filteredY[filteredY.length - 1] >= MIN_SHELF_GAP
      ) {
        filteredY.push(y);
      }
    }
    canonicalYs.length = 0;
    canonicalYs.push(...filteredY);
  }

  if (proportion > 0.01 && canonicalYs.length >= 2) {
    const propRngY = makeRng(paramSeed(perceptual) * 23.7);
    const yGaps = [];
    for (let i = 1; i < canonicalYs.length; i++)
      yGaps.push(canonicalYs[i] - canonicalYs[i - 1]);
    const minYGapFrac = 0.35;
    const distortedY = yGaps.map((g, i) => {
      const scale =
        i % 2 === 0
          ? 1 + proportion * propRngY() * 1.2
          : Math.max(minYGapFrac, 1 - proportion * propRngY() * 0.5);
      return g * scale;
    });
    for (let i = 0; i < distortedY.length; i++) {
      canonicalYs[i + 1] = canonicalYs[i] + distortedY[i];
    }
    for (let i = 0; i < canonicalYs.length; i++) {
      canonicalYs[i] = Math.max(H * 0.08, Math.min(H * 0.95, canonicalYs[i]));
    }
    canonicalYs.sort((a, b) => a - b);

    // Re-enforce minimum gap: proportion distortion + clamp can squeeze Ys back together.
    const filteredY2 = [];
    for (const y of canonicalYs) {
      if (
        filteredY2.length === 0 ||
        y - filteredY2[filteredY2.length - 1] >= MIN_SHELF_GAP
      ) {
        filteredY2.push(y);
      }
    }
    canonicalYs.length = 0;
    canonicalYs.push(...filteredY2);
  }

  const zoneRng = makeRng(paramSeed(perceptual) * 5.1);
  const zoneShelfYs = [];

  for (let zi = 0; zi < vXPos.length - 1; zi++) {
    const zoneCount = Math.max(
      1,
      Math.round(shelvesPerZone + (zoneRng() - 0.5) * pattern * 2)
    );
    const prevYs = zi === 0 ? new Set() : new Set(zoneShelfYs[zi - 1]);
    const picked = [];
    for (const y of canonicalYs) {
      const wasPresent = prevYs.has(y);
      if (wasPresent) {
        if (zoneRng() < 1 - pattern) picked.push(y);
      } else {
        if (picked.length < zoneCount) {
          if (zoneRng() < (zi === 0 ? 1.0 : pattern)) picked.push(y);
        }
      }
    }
    if (picked.length === 0 && canonicalYs.length > 0) {
      picked.push(canonicalYs[Math.floor(zoneRng() * canonicalYs.length)]);
    }
    picked.sort((a, b) => a - b);
    zoneShelfYs.push(picked);
  }

  const SLOT_EDGE_MIN = mm(40);

  // ── STEP 4: MERGE ZONES INTO SHELVES ────────────────────────────────────────
  const shelfMap = new Map();
  for (let zi = 0; zi < vXPos.length - 1; zi++) {
    const leftX = vXPos[zi],
      rightX = vXPos[zi + 1];
    for (const y of zoneShelfYs[zi]) {
      const key = Math.round(y * 1000);
      if (!shelfMap.has(key)) shelfMap.set(key, { y, xs: new Set() });
      shelfMap.get(key).xs.add(leftX);
      shelfMap.get(key).xs.add(rightX);
    }
  }

  const depthRng = makeRng(paramSeed(perceptual) * 9.3);
  const shelves = [];
  for (const [, { y, xs }] of shelfMap) {
    const sortedXs = [...xs].sort((a, b) => a - b);
    const leftX = sortedXs[0],
      rightX = sortedXs[sortedXs.length - 1];
    if (y < SLOT_EDGE_MIN) continue;

    const span = rightX - leftX;
    const variabilityFactor =
      0.25 +
      (1 - symmetry) * 0.45 +
      familiarity * 0.35 +
      contrast * 0.25 +
      harmony * 0.2;
    const maxOvh = span * MAX_CANTILEVER_RATIO * Math.min(1, variabilityFactor);

    const ovhL = SLOT_EDGE_MIN + depthRng() * maxOvh;
    const ovhR = SLOT_EDGE_MIN + depthRng() * maxOvh;

    const xStart = leftX - ovhL;
    const xEnd = rightX + ovhR;
    if (xEnd - xStart >= mm(100)) {
      shelves.push({ y, xStart, xEnd, leftX, rightX });
    }
  }

  // ── STEP 5: ENFORCE VERTICAL HEIGHTS ─────────────────────────────────────────
  const finalHeights = vXPos.map((x, vi) => {
    let structMin = H * 0.2;
    for (const s of shelves) {
      if (x >= s.leftX - mm(5) && x <= s.rightX + mm(5)) {
        structMin = Math.max(structMin, s.y + SLOT_EDGE_MIN);
      }
    }
    return Math.max(structMin, vHeights[vi]);
  });

  // ── STEP 6: VALIDATE SHELVES ────────────────────────────────────────────────
  let validShelves = shelves.filter((s) => {
    if (s.y < SLOT_EDGE_MIN) return false;
    for (let vi = 0; vi < vXPos.length; vi++) {
      const x = vXPos[vi];
      if (x >= s.leftX - mm(5) && x <= s.rightX + mm(5)) {
        if (finalHeights[vi] < s.y + SLOT_EDGE_MIN) return false;
      }
    }
    if (s.xStart >= s.leftX) return false;
    if (s.xEnd <= s.rightX) return false;
    return true;
  });

  // ── STEP 6b: ENFORCE MIN Y-GAP ON OVERLAPPING SHELVES (final safety net) ────
  // Even though canonicalYs were pre-filtered, two shelves can still end up with
  // overlapping X-ranges and Y values too close together. Walk bottom-up and drop
  // any shelf whose Y is within MIN_SHELF_GAP of an already-kept shelf that shares
  // any X-range with it. Non-overlapping shelves are independent (any height OK).
  validShelves.sort((a, b) => a.y - b.y);
  const yKept = [];
  for (const s of validShelves) {
    let collides = false;
    for (const k of yKept) {
      const xOverlap = !(s.xEnd <= k.xStart || s.xStart >= k.xEnd);
      if (xOverlap && Math.abs(s.y - k.y) < MIN_SHELF_GAP) {
        collides = true;
        break;
      }
    }
    if (!collides) yKept.push(s);
  }
  validShelves = yKept;

  // ── PANEL DATA (for PDF export) ─────────────────────────────────────────────
  const panelData = {
    width: W,
    height: H,
    depth: D,
    verticals: [],
    horizontals: [],
    diagonals: [],
  };

  // ── STEP 7: PLACE VERTICALS ──────────────────────────────────────────────────
  const wallBolts = [];
  const returnBolts = [];

  vXPos.forEach((x, vi) => {
    const pH = finalHeights[vi];

    const slots = [];
    for (let si = 0; si < validShelves.length; si++) {
      const s = validShelves[si];
      if (x >= s.leftX - mm(5) && x <= s.rightX + mm(5)) {
        slots.push({
          y: s.y,
          longLen: SLOT_LONG,
          backLen: SLOT_BACK,
          frontLen: SLOT_FRONT,
          cut: SLOT_CUT,
          angle: 0,
          shelfIndex: si,
        });
      }
    }

    const panel = buildVerticalPanel(pH, slots);
    panel.position.set(x - WALL_LEG / 2, 0, -D / 2);
    root.add(panel);

    for (const sl of slots) {
      const cxWorld = x;
      const cyWorld = sl.y;
      const off = WALL_LEG / 2 - BOLT_EDGE;
      const cyOverlap = cyWorld + WALL_LEG / 2;
      const zBolt = -D / 2 - mm(0.5);
      wallBolts.push({ x: cxWorld - off, y: cyOverlap - off, z: zBolt });
      wallBolts.push({ x: cxWorld + off, y: cyOverlap + off, z: zBolt });
      returnBolts.push({
        x: cxWorld,
        y: cyWorld - RETURN_LEG / 2,
        z: D / 2 + mm(0.5),
      });
    }

    panelData.verticals.push({
      id: `V${vi + 1}`,
      x,
      height: pH,
      depth: D,
      slots: slots.map((s) => ({
        y: s.y,
        longLen: s.longLen,
        backLen: s.backLen,
        frontLen: s.frontLen,
        angle: s.angle,
      })),
    });
  });

  // ── STEP 8: PLACE HORIZONTALS ────────────────────────────────────────────────
  validShelves.forEach((s, si) => {
    const length = s.xEnd - s.xStart;
    const intersections = [];
    for (let vi = 0; vi < vXPos.length; vi++) {
      const x = vXPos[vi];
      if (x >= s.leftX - mm(5) && x <= s.rightX + mm(5)) {
        intersections.push({ localX: x - s.xStart, verticalIndex: vi });
      }
    }

    const panel = buildHorizontalPanel(length, 0, length, intersections);
    panel.position.set(s.xStart, s.y, -D / 2);
    root.add(panel);

    panelData.horizontals.push({
      id: `H${si + 1}`,
      y: s.y,
      xStart: s.xStart,
      xEnd: s.xEnd,
      length,
      depth: D,
      intersections: intersections.map((i) => ({
        localX: i.localX,
        verticalIndex: i.verticalIndex,
      })),
    });
  });

  // ── STEP 9: DIAGONALS ───────────────────────────────────────────────────────
  const numDiag = harmony > 0.15 ? Math.round(harmony * 4) : 0;
  if (numDiag > 0 && vXPos.length >= 2) {
    const MIN_DIAG_GAP = mm(120);
    const NODE_CLEAR = mm(50);
    const nodes = [];
    for (let vi = 0; vi < vXPos.length; vi++) {
      const x = vXPos[vi];
      const pH = finalHeights[vi];

      const horizYs = [];
      for (const s of validShelves) {
        if (x >= s.leftX - mm(5) && x <= s.rightX + mm(5)) {
          if (pH >= s.y + SLOT_EDGE_MIN) horizYs.push(s.y);
        }
      }
      horizYs.sort((a, b) => a - b);

      const breakpoints = [0, ...horizYs, pH];
      for (let i = 0; i < breakpoints.length - 1; i++) {
        const lo = breakpoints[i] + (i === 0 ? 0 : NODE_CLEAR);
        const hi =
          breakpoints[i + 1] - (i === breakpoints.length - 2 ? 0 : NODE_CLEAR);
        if (hi - lo >= MIN_DIAG_GAP) {
          nodes.push({ x, y: (lo + hi) / 2, vi, gapLo: lo, gapHi: hi });
        }
      }
    }

    const maxAngleRad = ((10 + harmony * 35) * Math.PI) / 180;
    const minAngleRad = (8 * Math.PI) / 180;
    const usedPairs = new Set();
    let placed = 0;
    const dr = makeRng(paramSeed(perceptual) * 7.1);

    for (
      let attempt = 0;
      attempt < numDiag * 30 && placed < numDiag;
      attempt++
    ) {
      if (nodes.length < 2) break;
      const ai = Math.floor(dr() * nodes.length);
      const bi = Math.floor(dr() * nodes.length);
      if (ai === bi) continue;
      const a = nodes[ai],
        b = nodes[bi];
      if (a.vi === b.vi) continue;

      const leftX = Math.min(a.x, b.x),
        rightX = Math.max(a.x, b.x);
      const hasMidVertical = vXPos.some(
        (x) => x > leftX + mm(5) && x < rightX - mm(5)
      );
      if (hasMidVertical) continue;

      const dx = b.x - a.x,
        dy = b.y - a.y;
      if (Math.abs(dx) < mm(120) || Math.abs(dy) < mm(80)) continue;
      const ang = Math.atan2(dy, dx);
      const angAbs = Math.abs(ang);
      if (angAbs < minAngleRad || angAbs > maxAngleRad) continue;

      const len = Math.sqrt(dx * dx + dy * dy);
      const totalLen = len + SLOT_EDGE_MIN * 2;

      const key = [ai, bi].sort().join("-");
      if (usedPairs.has(key)) continue;
      usedPairs.add(key);

      const dp = buildDiagonalPanel(totalLen, []);
      const g = new THREE.Group();
      g.position.set(a.x + dx / 2, a.y + dy / 2, -D / 2);
      g.rotation.z = ang;
      dp.position.x = -totalLen / 2;
      g.add(dp);
      root.add(g);
      placed++;

      panelData.diagonals.push({
        id: `D${placed}`,
        ax: a.x,
        ay: a.y,
        bx: b.x,
        by: b.y,
        length: totalLen,
        depth: D,
        angle: ang,
      });
    }
  }

  addBoltVisuals(root, { wallBolts, returnBolts });

  return { group: root, panelData };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PDF EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
let _jsPDFPromise = null;
function loadJsPDF() {
  if (_jsPDFPromise) return _jsPDFPromise;
  _jsPDFPromise = new Promise((resolve, reject) => {
    if (window.jspdf && window.jspdf.jsPDF) {
      return resolve(window.jspdf.jsPDF);
    }
    const s = document.createElement("script");
    s.src =
      "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.crossOrigin = "anonymous";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      _jsPDFPromise = null;
      reject(new Error("jsPDF load timed out"));
    }, 15000);
    s.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (window.jspdf && window.jspdf.jsPDF) {
        resolve(window.jspdf.jsPDF);
      } else {
        _jsPDFPromise = null;
        reject(new Error("jsPDF loaded but did not initialize correctly"));
      }
    };
    s.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      _jsPDFPromise = null;
      reject(new Error("Could not load jsPDF from CDN"));
    };
    document.head.appendChild(s);
  });
  return _jsPDFPromise;
}

function setLineCut(pdf) {
  pdf.setDrawColor(220, 50, 50);
  pdf.setLineWidth(0.18);
  pdf.setLineDashPattern([], 0);
}
function setLineFold(pdf) {
  pdf.setDrawColor(50, 90, 200);
  pdf.setLineWidth(0.15);
  pdf.setLineDashPattern([2, 1.5], 0);
}
function setLineDim(pdf) {
  pdf.setDrawColor(140, 140, 140);
  pdf.setLineWidth(0.1);
  pdf.setLineDashPattern([], 0);
}
function setTextDark(pdf) {
  pdf.setTextColor(40, 40, 40);
}
function setTextDim(pdf) {
  pdf.setTextColor(120, 120, 120);
}

function drawDimH(pdf, x1, x2, y, label, opts = {}) {
  const tickH = 1.5;
  setLineDim(pdf);
  pdf.line(x1, y, x2, y);
  pdf.line(x1, y - tickH, x1, y + tickH);
  pdf.line(x2, y - tickH, x2, y + tickH);
  setTextDim(pdf);
  pdf.setFontSize(opts.fontSize || 5.5);
  const labelW = pdf.getTextWidth(label);
  const cx = (x1 + x2) / 2;
  pdf.text(label, cx - labelW / 2, y - 1);
}

function drawDimV(pdf, y1, y2, x, label, opts = {}) {
  const tickW = 1.5;
  setLineDim(pdf);
  pdf.line(x, y1, x, y2);
  pdf.line(x - tickW, y1, x + tickW, y1);
  pdf.line(x - tickW, y2, x + tickW, y2);
  setTextDim(pdf);
  pdf.setFontSize(opts.fontSize || 5.5);
  const cy = (y1 + y2) / 2;
  pdf.text(label, x + 2, cy + 1);
}

function drawCrossSectionInset(pdf, boxX, boxY, kind) {
  const W = 26;
  const H = 10;
  setLineDim(pdf);
  pdf.setLineWidth(0.1);
  pdf.rect(boxX, boxY, W, H);

  const wallX = boxX + W * 0.2;
  const frontX = boxX + W * 0.8;
  const baseY = boxY + H * 0.55;
  const legUpY = boxY + H * 0.2;
  const legDnY = boxY + H * 0.92;

  pdf.setDrawColor(40, 40, 40);
  pdf.setLineWidth(0.4);
  pdf.line(wallX, baseY, frontX, baseY);

  if (kind === "C") {
    pdf.line(wallX, baseY, wallX, legUpY);
    pdf.line(frontX, baseY, frontX, legUpY + 1.5);
  } else {
    pdf.line(wallX, baseY, wallX, legUpY);
    pdf.line(frontX, baseY, frontX, legDnY);
  }
  pdf.setLineWidth(0.18);

  setTextDim(pdf);
  pdf.setFontSize(3.8);
  pdf.text(kind === "C" ? "C-fold" : "Z-fold", boxX + 1, boxY - 0.6);
  if (kind === "Z") {
    pdf.text("70 UP", boxX + 1, boxY + H + 2.5);
    pdf.text("30 DN", boxX + W - 8, boxY + H + 2.5);
  } else {
    pdf.text("70", boxX + 1, boxY + H + 2.5);
    pdf.text("30", boxX + W - 5, boxY + H + 2.5);
  }
}

function drawVerticalFlatPattern(pdf, panel, originX, originY, scale) {
  const heightMM = panel.height * 1000;
  const flatWidthMM = (WALL_LEG + MAIN_FACE + RETURN_LEG) * 1000;
  const wallLegMM = WALL_LEG * 1000;
  const mainFaceMM = MAIN_FACE * 1000;
  const returnLegMM = RETURN_LEG * 1000;
  const cutMM = SLOT_CUT * 1000;

  setLineCut(pdf);
  pdf.rect(originX, originY, heightMM * scale, flatWidthMM * scale);

  setLineFold(pdf);
  const foldY1 = originY + wallLegMM * scale;
  const foldY2 = originY + (wallLegMM + mainFaceMM) * scale;
  pdf.line(originX, foldY1, originX + heightMM * scale, foldY1);
  pdf.line(originX, foldY2, originX + heightMM * scale, foldY2);

  setLineCut(pdf);
  const drawRect = (xMM, yMM, wMM, hMM) => {
    pdf.rect(
      originX + xMM * scale,
      originY + yMM * scale,
      wMM * scale,
      hMM * scale
    );
  };
  for (const s of panel.slots) {
    const longLenMM = s.longLen * 1000;
    const backLenMM = s.backLen * 1000;
    const frontLenMM = s.frontLen * 1000;
    const sxMM = s.y * 1000;

    const longCY = wallLegMM + mainFaceMM / 2;
    drawRect(sxMM - cutMM / 2, longCY - longLenMM / 2, cutMM, longLenMM);

    const backCX = sxMM + cutMM / 2 + backLenMM / 2;
    const backCY = longCY - longLenMM / 2 + cutMM / 2;
    drawRect(backCX - backLenMM / 2, backCY - cutMM / 2, backLenMM, cutMM);

    const frontCX = sxMM - cutMM / 2 - frontLenMM / 2;
    const frontCY = longCY + longLenMM / 2 - cutMM / 2;
    drawRect(frontCX - frontLenMM / 2, frontCY - cutMM / 2, frontLenMM, cutMM);
  }

  setTextDim(pdf);
  pdf.setFontSize(5);
  pdf.text("WALL LEG (C-fold, toward wall)", originX + 1.5, originY + 3);
  pdf.text("MAIN FACE", originX + 1.5, foldY1 + 3);
  pdf.text("RETURN (C-fold, toward wall)", originX + 1.5, foldY2 + 3);

  setTextDark(pdf);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(9);
  pdf.text(panel.id, originX + heightMM * scale - 7, originY + 4);
  pdf.setFont("helvetica", "normal");

  drawCrossSectionInset(
    pdf,
    originX + heightMM * scale - 30,
    originY - 16,
    "C"
  );

  drawDimH(
    pdf,
    originX,
    originX + heightMM * scale,
    originY + flatWidthMM * scale + 5,
    `${Math.round(heightMM)} mm`
  );

  const rightX = originX + heightMM * scale + 8;
  drawDimV(
    pdf,
    originY,
    originY + wallLegMM * scale,
    rightX,
    `${Math.round(wallLegMM)}`
  );
  drawDimV(
    pdf,
    originY + wallLegMM * scale,
    foldY2,
    rightX,
    `${Math.round(mainFaceMM)}`
  );
  drawDimV(
    pdf,
    foldY2,
    originY + flatWidthMM * scale,
    rightX,
    `${Math.round(returnLegMM)}`
  );
  drawDimV(
    pdf,
    originY,
    originY + flatWidthMM * scale,
    rightX + 8,
    `${Math.round(flatWidthMM)} mm`
  );

  setTextDim(pdf);
  pdf.setFontSize(4.8);
  for (const s of panel.slots) {
    const sxMM = s.y * 1000;
    const px = originX + sxMM * scale;
    const py = originY - 2;
    pdf.setFontSize(4.5);
    setLineDim(pdf);
    pdf.line(px, py, px, originY);
    const label = `${Math.round(sxMM)}`;
    const w = pdf.getTextWidth(label);
    pdf.text(label, px - w / 2, py - 0.5);
  }
  if (panel.slots.length > 0) {
    setTextDim(pdf);
    pdf.setFontSize(4.5);
    pdf.text("slot Y (mm from base)", originX, originY - 6);
  }
}

function drawHorizontalFlatPattern(pdf, panel, originX, originY, scale) {
  const lengthMM = panel.length * 1000;
  const flatWidthMM = (WALL_LEG + MAIN_FACE + RETURN_LEG) * 1000;
  const wallLegMM = WALL_LEG * 1000;
  const mainFaceMM = MAIN_FACE * 1000;
  const returnLegMM = RETURN_LEG * 1000;

  setLineCut(pdf);
  pdf.rect(originX, originY, lengthMM * scale, flatWidthMM * scale);

  setLineFold(pdf);
  const foldY1 = originY + wallLegMM * scale;
  const foldY2 = originY + (wallLegMM + mainFaceMM) * scale;
  pdf.line(originX, foldY1, originX + lengthMM * scale, foldY1);
  pdf.line(originX, foldY2, originX + lengthMM * scale, foldY2);

  setLineCut(pdf);
  const off = (WALL_LEG / 2 - BOLT_EDGE) * 1000 * scale;
  const r = (BOLT_DIA / 2) * 1000 * scale;
  for (const isec of panel.intersections) {
    const cx = originX + isec.localX * 1000 * scale;
    const cyWall = originY + (wallLegMM / 2) * scale;
    pdf.circle(cx - off, cyWall - off, r, "S");
    pdf.circle(cx + off, cyWall + off, r, "S");
    const cyReturn =
      originY + (wallLegMM + mainFaceMM + returnLegMM / 2) * scale;
    pdf.circle(cx, cyReturn, r, "S");
  }

  setTextDim(pdf);
  pdf.setFontSize(5);
  pdf.text("WALL LEG (folds UP at back)", originX + 1.5, originY + 3);
  pdf.text("MAIN FACE", originX + 1.5, foldY1 + 3);
  pdf.text("RETURN (folds DOWN at front)", originX + 1.5, foldY2 + 3);

  setTextDark(pdf);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(9);
  pdf.text(panel.id, originX + lengthMM * scale - 9, originY + 4);
  pdf.setFont("helvetica", "normal");

  drawCrossSectionInset(
    pdf,
    originX + lengthMM * scale - 30,
    originY - 16,
    "Z"
  );

  drawDimH(
    pdf,
    originX,
    originX + lengthMM * scale,
    originY + flatWidthMM * scale + 5,
    `${Math.round(lengthMM)} mm`
  );

  const rightX = originX + lengthMM * scale + 8;
  drawDimV(pdf, originY, foldY1, rightX, `${Math.round(wallLegMM)}`);
  drawDimV(pdf, foldY1, foldY2, rightX, `${Math.round(mainFaceMM)}`);
  drawDimV(
    pdf,
    foldY2,
    originY + flatWidthMM * scale,
    rightX,
    `${Math.round(returnLegMM)}`
  );
  drawDimV(
    pdf,
    originY,
    originY + flatWidthMM * scale,
    rightX + 8,
    `${Math.round(flatWidthMM)} mm`
  );

  setTextDim(pdf);
  pdf.setFontSize(4.5);
  for (const isec of panel.intersections) {
    const xMM = isec.localX * 1000;
    const px = originX + xMM * scale;
    setLineDim(pdf);
    pdf.line(px, originY - 2, px, originY);
    const label = `${Math.round(xMM)}`;
    const w = pdf.getTextWidth(label);
    pdf.text(label, px - w / 2, originY - 3);
  }
  if (panel.intersections.length > 0) {
    pdf.text("crossing X (mm from left)", originX, originY - 7);
  }
}

function drawDiagonalFlatPattern(pdf, panel, originX, originY, scale) {
  const lengthMM = panel.length * 1000;
  const flatWidthMM = (WALL_LEG + MAIN_FACE + RETURN_LEG) * 1000;
  const wallLegMM = WALL_LEG * 1000;
  const mainFaceMM = MAIN_FACE * 1000;
  const returnLegMM = RETURN_LEG * 1000;

  setLineCut(pdf);
  pdf.rect(originX, originY, lengthMM * scale, flatWidthMM * scale);

  setLineFold(pdf);
  const foldY1 = originY + wallLegMM * scale;
  const foldY2 = originY + (wallLegMM + mainFaceMM) * scale;
  pdf.line(originX, foldY1, originX + lengthMM * scale, foldY1);
  pdf.line(originX, foldY2, originX + lengthMM * scale, foldY2);

  setTextDim(pdf);
  pdf.setFontSize(5);
  pdf.text("WALL LEG (folds UP at back)", originX + 1.5, originY + 3);
  pdf.text("MAIN FACE", originX + 1.5, foldY1 + 3);
  pdf.text("RETURN (folds DOWN at front)", originX + 1.5, foldY2 + 3);

  setTextDark(pdf);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(9);
  pdf.text(panel.id, originX + lengthMM * scale - 9, originY + 4);
  pdf.setFont("helvetica", "normal");

  drawCrossSectionInset(
    pdf,
    originX + lengthMM * scale - 30,
    originY - 16,
    "Z"
  );

  drawDimH(
    pdf,
    originX,
    originX + lengthMM * scale,
    originY + flatWidthMM * scale + 5,
    `${Math.round(lengthMM)} mm  (angle ${(
      (panel.angle * 180) /
      Math.PI
    ).toFixed(1)}°)`
  );

  const rightX = originX + lengthMM * scale + 8;
  drawDimV(pdf, originY, foldY1, rightX, `${Math.round(wallLegMM)}`);
  drawDimV(pdf, foldY1, foldY2, rightX, `${Math.round(mainFaceMM)}`);
  drawDimV(
    pdf,
    foldY2,
    originY + flatWidthMM * scale,
    rightX,
    `${Math.round(returnLegMM)}`
  );
  drawDimV(
    pdf,
    originY,
    originY + flatWidthMM * scale,
    rightX + 8,
    `${Math.round(flatWidthMM)} mm`
  );
}

function drawAssembledElevation(pdf, panelData, originX, originY, maxW, maxH) {
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const v of panelData.verticals) {
    const halfW = RETURN_LEG / 2;
    minX = Math.min(minX, v.x - halfW);
    maxX = Math.max(maxX, v.x + halfW);
    minY = Math.min(minY, 0);
    maxY = Math.max(maxY, v.height);
  }
  for (const h of panelData.horizontals) {
    minX = Math.min(minX, h.xStart);
    maxX = Math.max(maxX, h.xEnd);
    minY = Math.min(minY, h.y - RETURN_LEG);
    maxY = Math.max(maxY, h.y);
  }
  for (const d of panelData.diagonals) {
    const dxw = d.bx - d.ax,
      dyw = d.by - d.ay;
    const lenw = Math.sqrt(dxw * dxw + dyw * dyw) || 1;
    const px = -dyw / lenw,
      py = dxw / lenw;
    const halfT = RETURN_LEG / 2;
    [
      [d.ax, d.ay],
      [d.bx, d.by],
    ].forEach(([wx, wy]) => {
      [+halfT, -halfT].forEach((t) => {
        const cx = wx + px * t,
          cy = wy + py * t;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
      });
    });
  }

  if (!isFinite(minX)) {
    setTextDim(pdf);
    pdf.setFontSize(8);
    pdf.text(
      "(no panels to draw)",
      originX + maxW / 2 - 12,
      originY + maxH / 2
    );
    return;
  }

  const extentW = (maxX - minX) * 1000;
  const extentH = (maxY - minY) * 1000;

  const RESERVED_LEFT = 14;
  const RESERVED_RIGHT = 4;
  const RESERVED_BOTTOM = 12;
  const RESERVED_TOP = 4;
  const drawableW = Math.max(40, maxW - RESERVED_LEFT - RESERVED_RIGHT);
  const drawableH = Math.max(40, maxH - RESERVED_TOP - RESERVED_BOTTOM);
  const scale = Math.min(drawableW / extentW, drawableH / extentH);
  const drawW = extentW * scale;
  const drawH = extentH * scale;
  const ox = originX + RESERVED_LEFT + (drawableW - drawW) / 2;
  const oy = originY + RESERVED_TOP + (drawableH - drawH) / 2;

  const toPx = (worldX) => ox + (worldX - minX) * 1000 * scale;
  const toPy = (worldY) => oy + drawH - (worldY - minY) * 1000 * scale;

  pdf.setDrawColor(20, 20, 20);
  pdf.setLineWidth(0.35);
  pdf.setLineDashPattern([], 0);

  const visW = RETURN_LEG * 1000 * scale;
  for (const v of panelData.verticals) {
    const xLeft = toPx(v.x) - visW / 2;
    const yTop = toPy(v.height);
    const h = v.height * 1000 * scale;
    pdf.rect(xLeft, yTop, visW, h, "S");
  }

  const visT = RETURN_LEG * 1000 * scale;
  for (const h of panelData.horizontals) {
    const xs = toPx(h.xStart);
    const xe = toPx(h.xEnd);
    const yTop = toPy(h.y);
    pdf.rect(xs, yTop, xe - xs, visT, "S");
  }

  for (const d of panelData.diagonals) {
    drawDiagonalSilhouette(pdf, d, toPx, toPy, scale);
  }

  setLineDim(pdf);
  pdf.setLineWidth(0.18);
  const bottomDimY = oy + drawH + 7;
  pdf.line(ox, bottomDimY, ox + drawW, bottomDimY);
  pdf.line(ox, bottomDimY - 1.5, ox, bottomDimY + 1.5);
  pdf.line(ox + drawW, bottomDimY - 1.5, ox + drawW, bottomDimY + 1.5);
  setTextDim(pdf);
  pdf.setFontSize(7);
  const widthLabel = `mm ${Math.round(extentW)}`;
  const wLW = pdf.getTextWidth(widthLabel);
  pdf.text(widthLabel, ox + drawW - wLW - 1, bottomDimY + 4);

  const leftDimX = ox - 7;
  pdf.line(leftDimX, oy, leftDimX, oy + drawH);
  pdf.line(leftDimX - 1.5, oy, leftDimX + 1.5, oy);
  pdf.line(leftDimX - 1.5, oy + drawH, leftDimX + 1.5, oy + drawH);
  const heightLabel = `mm ${Math.round(extentH)}`;
  pdf.text(heightLabel, leftDimX - 2, oy + drawH - 1, { angle: 90 });
}

function drawDiagonalSilhouette(pdf, d, toPx, toPy, scale) {
  const ax = toPx(d.ax),
    ay = toPy(d.ay);
  const bx = toPx(d.bx),
    by = toPy(d.by);
  const dx = bx - ax,
    dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.5) return;
  const px = -dy / len,
    py = dx / len;
  const halfT = (RETURN_LEG * 1000 * scale) / 2;
  const corners = [
    [ax + px * halfT, ay + py * halfT],
    [bx + px * halfT, by + py * halfT],
    [bx - px * halfT, by - py * halfT],
    [ax - px * halfT, ay - py * halfT],
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      b = corners[(i + 1) % 4];
    pdf.line(a[0], a[1], b[0], b[1]);
  }
}

function packPanelsToPages(panels, pageW, pageH, margin) {
  const FLAT_WIDTH_MM = (WALL_LEG + MAIN_FACE + RETURN_LEG) * 1000;
  const MAX_PAGES = 10;

  const PAD_RIGHT = 22;
  const PAD_BOTTOM = 10;
  const PAD_TOP = 20;
  const PAD_LEFT = 1;

  const items = panels.map((p, i) => {
    let longMM;
    if (p.kind === "vertical") longMM = p.panel.height * 1000;
    else longMM = p.panel.length * 1000;
    return { ...p, longMM, shortMM: FLAT_WIDTH_MM, idx: i };
  });
  items.sort((a, b) => b.longMM - a.longMM);

  const tryPack = (scale) => {
    const usableW = pageW - 2 * margin;
    const usableH = pageH - 2 * margin - 14;
    const pages = [];
    let curPage = { rows: [], usedH: 0 };
    let row = { items: [], rowH: 0, usedW: 0 };

    const flushRow = () => {
      if (row.items.length === 0) return;
      if (curPage.usedH + row.rowH + 4 <= usableH) {
        curPage.rows.push(row);
        curPage.usedH += row.rowH + 4;
      } else {
        pages.push(curPage);
        curPage = { rows: [row], usedH: row.rowH + 4 };
      }
      row = { items: [], rowH: 0, usedW: 0 };
    };

    for (const it of items) {
      const wRaw = it.longMM * scale;
      const hRaw = it.shortMM * scale;
      const w = wRaw + PAD_LEFT + PAD_RIGHT;
      const h = hRaw + PAD_TOP + PAD_BOTTOM;
      if (w > usableW) return null;
      if (row.usedW + w > usableW) flushRow();
      row.items.push({
        ...it,
        placeX: row.usedW + PAD_LEFT,
        placeY: PAD_TOP,
        drawW: wRaw,
        drawH: hRaw,
      });
      row.usedW += w;
      row.rowH = Math.max(row.rowH, h);
    }
    flushRow();
    if (curPage.rows.length > 0) pages.push(curPage);

    return { scale, pages };
  };

  let result = tryPack(0.2);
  if (result && result.pages.length <= MAX_PAGES)
    return { ...result, scaleLabel: "1 : 5" };
  result = tryPack(0.15);
  if (result && result.pages.length <= MAX_PAGES)
    return { ...result, scaleLabel: "1 : 6.67" };
  result = tryPack(0.125);
  if (result && result.pages.length <= MAX_PAGES)
    return { ...result, scaleLabel: "1 : 8" };
  result = tryPack(0.1) || { scale: 0.1, pages: [] };
  return { ...result, scaleLabel: "1 : 10" };
}

async function generatePDF(panelData, paramsLabel, dims) {
  const jsPDF = await loadJsPDF();
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });

  const PAGE_W = 297;
  const PAGE_H = 210;
  const MARGIN = 12;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(14);
  setTextDark(pdf);
  pdf.text("Parametric Shelf — Fabrication Drawing", MARGIN, MARGIN + 4);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  setTextDim(pdf);
  pdf.text(
    `Overall: ${Math.round(dims.width * 1000)} × ${Math.round(
      dims.height * 1000
    )} × ${Math.round(
      dims.depth * 1000
    )} mm  ·  Material: 1.5 mm mild steel  ·  ${paramsLabel}`,
    MARGIN,
    MARGIN + 9
  );

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(9);
  setTextDark(pdf);
  pdf.text("ASSEMBLED VIEW (front elevation)", MARGIN, MARGIN + 18);

  drawAssembledElevation(
    pdf,
    panelData,
    MARGIN,
    MARGIN + 22,
    PAGE_W - 2 * MARGIN,
    PAGE_H - MARGIN - 35
  );

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(6);
  setTextDim(pdf);
  pdf.text(
    `${panelData.verticals.length} verticals · ${
      panelData.horizontals.length
    } horizontals${
      panelData.diagonals.length > 0
        ? ` · ${panelData.diagonals.length} diagonals`
        : ""
    }`,
    MARGIN,
    PAGE_H - MARGIN
  );

  pdf.addPage();
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(14);
  setTextDark(pdf);
  pdf.text("Cut List", MARGIN, MARGIN + 4);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  setTextDim(pdf);
  pdf.text(
    "Complete list of every panel to be cut. Cross-reference this against the flat-pattern pages.",
    MARGIN,
    MARGIN + 9
  );

  let cy = MARGIN + 16;
  const colXs = [
    MARGIN,
    MARGIN + 16,
    MARGIN + 38,
    MARGIN + 65,
    MARGIN + 90,
    MARGIN + 130,
  ];

  const drawRow = (cells, opts = {}) => {
    if (opts.bold) pdf.setFont("helvetica", "bold");
    else pdf.setFont("helvetica", "normal");
    pdf.setFontSize(opts.bold ? 8 : 7.5);
    setTextDark(pdf);
    for (let i = 0; i < cells.length; i++) {
      pdf.text(String(cells[i]), colXs[i], cy);
    }
    if (opts.line) {
      setLineDim(pdf);
      pdf.line(MARGIN, cy + 1, PAGE_W - MARGIN, cy + 1);
    }
    cy += opts.bold ? 5 : 4.2;
  };

  drawRow(["ID", "Type", "Length × 310mm", "Position", "Features", "Notes"], {
    bold: true,
    line: true,
  });
  cy += 1;

  for (const v of panelData.verticals) {
    const slotsDesc =
      v.slots.length === 0
        ? "(no slots)"
        : v.slots.map((s) => `${Math.round(s.y * 1000)}`).join(", ");
    drawRow([
      v.id,
      "vertical (C-fold)",
      `${Math.round(v.height * 1000)} mm`,
      `x = ${Math.round(v.x * 1000)} mm`,
      `${v.slots.length} slots @ Y=${slotsDesc}`,
      "",
    ]);
  }
  for (const h of panelData.horizontals) {
    const xsDesc =
      h.intersections.length === 0
        ? "(no crossings)"
        : h.intersections
            .map((i) => `${Math.round(i.localX * 1000)}`)
            .join(", ");
    drawRow([
      h.id,
      "horizontal (Z-fold)",
      `${Math.round(h.length * 1000)} mm`,
      `Y = ${Math.round(h.y * 1000)} mm`,
      `${h.intersections.length} crossings @ x=${xsDesc}`,
      `xStart=${Math.round(h.xStart * 1000)}`,
    ]);
  }
  for (const d of panelData.diagonals) {
    drawRow([
      d.id,
      "diagonal (Z-fold)",
      `${Math.round(d.length * 1000)} mm`,
      `${((d.angle * 180) / Math.PI).toFixed(1)}°`,
      `(${Math.round(d.ax * 1000)},${Math.round(d.ay * 1000)}) → (${Math.round(
        d.bx * 1000
      )},${Math.round(d.by * 1000)})`,
      "",
    ]);
  }

  cy += 4;
  setLineDim(pdf);
  pdf.line(MARGIN, cy, PAGE_W - MARGIN, cy);
  cy += 5;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8);
  setTextDark(pdf);
  pdf.text("TOTALS", MARGIN, cy);
  cy += 4;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7.5);
  setTextDim(pdf);
  const cutListIntersections = panelData.horizontals.reduce(
    (a, h) => a + h.intersections.length,
    0
  );
  const cutListLengthMM = [
    ...panelData.verticals.map((v) => v.height * 1000),
    ...panelData.horizontals.map((h) => h.length * 1000),
    ...panelData.diagonals.map((d) => d.length * 1000),
  ].reduce((a, b) => a + b, 0);
  const cutListAreaMM2 = cutListLengthMM * 310;
  pdf.text(`Verticals: ${panelData.verticals.length}`, MARGIN, cy);
  pdf.text(`Horizontals: ${panelData.horizontals.length}`, MARGIN + 40, cy);
  pdf.text(`Diagonals: ${panelData.diagonals.length}`, MARGIN + 80, cy);
  pdf.text(`Intersections: ${cutListIntersections}`, MARGIN + 120, cy);
  pdf.text(`M5 bolts: ${cutListIntersections * 3}`, MARGIN + 175, cy);
  cy += 4;
  pdf.text(
    `Total panel length (sum): ${Math.round(
      cutListLengthMM
    )} mm  ·  Approx. material area: ${(cutListAreaMM2 / 1e6).toFixed(
      2
    )} m²  (1.5 mm mild steel)`,
    MARGIN,
    cy
  );

  const allPanels = [
    ...panelData.verticals.map((p) => ({ kind: "vertical", panel: p })),
    ...panelData.horizontals.map((p) => ({ kind: "horizontal", panel: p })),
    ...panelData.diagonals.map((p) => ({ kind: "diagonal", panel: p })),
  ];

  const pack = packPanelsToPages(allPanels, PAGE_W, PAGE_H, MARGIN);

  for (let pi = 0; pi < pack.pages.length; pi++) {
    pdf.addPage();

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    setTextDark(pdf);
    pdf.text(
      `FLAT PATTERNS — Page ${pi + 1} of ${pack.pages.length}`,
      MARGIN,
      MARGIN + 4
    );

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    setTextDark(pdf);
    const scaleText = `SCALE ${pack.scaleLabel}`;
    const scaleW = pdf.getTextWidth(scaleText);
    pdf.text(scaleText, PAGE_W - MARGIN - scaleW, MARGIN + 4);

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    setTextDim(pdf);
    pdf.text(
      "Cut: red solid · Fold: blue dashed · Bolt holes: M5 · Sheet: 1.5mm mild steel · All dimensions in mm",
      MARGIN,
      MARGIN + 9
    );

    const barLengthRealMM = 100;
    const barLengthPaperMM = barLengthRealMM * pack.scale;
    const barX = MARGIN;
    const barY = MARGIN + 12;
    setLineDim(pdf);
    pdf.setLineWidth(0.4);
    pdf.line(barX, barY, barX + barLengthPaperMM, barY);
    pdf.line(barX, barY - 1.5, barX, barY + 1.5);
    pdf.line(
      barX + barLengthPaperMM,
      barY - 1.5,
      barX + barLengthPaperMM,
      barY + 1.5
    );
    pdf.line(
      barX + barLengthPaperMM / 2,
      barY - 1,
      barX + barLengthPaperMM / 2,
      barY + 1
    );
    pdf.setLineWidth(0.18);
    setTextDim(pdf);
    pdf.setFontSize(5.5);
    pdf.text("0", barX - 1, barY + 4);
    pdf.text("50", barX + barLengthPaperMM / 2 - 2, barY + 4);
    pdf.text("100 mm", barX + barLengthPaperMM - 5, barY + 4);

    let cursorY = MARGIN + 18;
    for (const row of pack.pages[pi].rows) {
      for (const it of row.items) {
        const x = MARGIN + it.placeX;
        const y = cursorY + it.placeY;
        if (it.kind === "vertical")
          drawVerticalFlatPattern(pdf, it.panel, x, y, pack.scale);
        else if (it.kind === "horizontal")
          drawHorizontalFlatPattern(pdf, it.panel, x, y, pack.scale);
        else drawDiagonalFlatPattern(pdf, it.panel, x, y, pack.scale);
      }
      cursorY += row.rowH + 4;
    }

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(6);
    setTextDim(pdf);
    pdf.text(
      `Beyond Shelf Life · 1.5mm mild steel · Generated ${new Date()
        .toISOString()
        .slice(0, 10)} · Build v11 (min-shelf-gap)`,
      MARGIN,
      PAGE_H - MARGIN
    );
  }

  pdf.addPage();
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(14);
  setTextDark(pdf);
  pdf.text("Assembly Instructions", MARGIN, MARGIN + 4);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  let yy = MARGIN + 14;
  const lh = 5;
  const wrap = (text, fontSize = 9) => {
    pdf.setFontSize(fontSize);
    const lines = pdf.splitTextToSize(text, PAGE_W - 2 * MARGIN);
    for (const ln of lines) {
      pdf.text(ln, MARGIN, yy);
      yy += lh;
    }
    yy += 1;
  };
  const heading = (text) => {
    yy += 2;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(10);
    pdf.text(text, MARGIN, yy);
    yy += lh + 1;
    pdf.setFont("helvetica", "normal");
  };

  const totalIntersections = panelData.horizontals.reduce(
    (a, h) => a + h.intersections.length,
    0
  );
  const totalBolts = totalIntersections * 3;

  heading("MATERIALS");
  wrap(
    "• 1.5 mm mild steel sheet, sufficient to cover all flat patterns shown on the previous pages.\n" +
      `• ${totalBolts} M5 bolts (= ${totalIntersections} intersections × 3 bolts each: 2 at back, 1 at front).\n` +
      "• M5 wall plugs and screws for wall fixings (one back bolt per intersection doubles as a wall fixing).\n" +
      "• Standard tools: drill (only for wall plugs), Allen key for M5 bolts, press brake for folding."
  );

  heading("LASER CUTTING");
  wrap(
    "Send the flat-pattern pages to your laser-cutting service. Cut all RED lines: panel outlines, " +
      "Z-shaped slots in vertical panels, and 5 mm bolt holes in horizontal/diagonal panels. The BLUE " +
      "DASHED lines are FOLD references only — do NOT cut these. Tolerances: ±0.1 mm on cuts. " +
      "Slot cut width is 1.6 mm (= 1.5 mm sheet + 0.1 mm clearance for assembly)."
  );

  heading("FOLDING");
  wrap(
    "All panels are folded along the two blue-dashed lines using a press brake. Each flat pattern is " +
      "divided into three strips: 70 mm (wall leg), 210 mm (main face), 30 mm (return).\n" +
      "• VERTICAL PANELS — C-fold: Both fold lines bend in the SAME direction. The 70 mm wall leg " +
      "folds back to lie flat against the wall; the 30 mm return folds back toward the wall on the front " +
      "edge. Final cross-section is a C, opening toward the wall.\n" +
      "• HORIZONTAL PANELS — Z-fold: The two fold lines bend in OPPOSITE directions. The 70 mm wall leg " +
      "RISES UP from the back edge of the main face (it ends up vertical, behind the vertical panels' " +
      "main faces, hugging the wall). The 30 mm return DROPS DOWN from the front edge of the main face " +
      "(visible as a small lip below the shelf surface). Final cross-section is a Z.\n" +
      "• DIAGONAL PANELS — same Z-fold as horizontals."
  );

  heading("DRY ASSEMBLY");
  wrap(
    "1. Stand a vertical panel with its 70 mm wall leg flat against the wall.\n" +
      "2. Pass a horizontal panel through the Z-shaped slot in the vertical's main face.\n" +
      "3. Once seated, the horizontal's wall leg sits flat against the wall, behind the vertical's main face.\n" +
      "4. Repeat for every intersection. Diagonals slot through their own rotated slots.\n" +
      "5. Verify all panels sit flush with no forcing."
  );

  heading("BOLTING");
  wrap(
    "At every horizontal-vertical intersection, install three M5 bolts:\n" +
      "• TWO bolts at the BACK, through the overlapping wall legs (70×70 mm overlap, diagonal corners, 15 mm from edges).\n" +
      "• ONE bolt at the FRONT, centered in the 30×30 mm overlap of return legs.\n" +
      "Tighten progressively from the centre outward."
  );

  heading("WALL MOUNTING");
  wrap(
    "One of the two back-overlap bolts at each intersection doubles as a wall fixing point. Mark its " +
      "position on the wall, drill, insert an M5 wall plug, and bolt through both wall legs into the plug."
  );

  heading("FINAL NOTES");
  wrap(
    "All dimensions on the flat-pattern pages are NOMINAL (un-folded) and do not include bend allowance. " +
      "Your press-brake operator should apply an appropriate K-factor (typically 0.4 for 1.5 mm mild steel)."
  );

  return pdf;
}

function downloadPDF(pdf, filename) {
  try {
    pdf.save(filename);
    return { ok: true, method: "save" };
  } catch (e) {
    console.warn("[shelf] pdf.save() failed:", e);
  }
  try {
    const blob = pdf.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
    return { ok: true, method: "blob" };
  } catch (e) {
    console.warn("[shelf] blob download failed:", e);
  }
  try {
    const dataUri = pdf.output("datauristring");
    const win = window.open();
    if (win) {
      win.document.write(
        `<iframe src="${dataUri}" style="width:100%;height:100%;border:0;"></iframe>`
      );
      return { ok: true, method: "newtab" };
    }
  } catch (e) {
    console.warn("[shelf] new-tab fallback failed:", e);
  }
  return { ok: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function PerceptualSlider({ labelLeft, labelRight, value, onChange }) {
  const pct = value * 100;
  const leftActive = pct < 40,
    rightActive = pct > 60;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: leftActive ? 600 : 400,
            color: leftActive ? "#2c2824" : "#cfc9c0",
            minWidth: 80,
            textAlign: "right",
            transition: "all 0.25s",
            opacity: leftActive ? 1 : 0.7,
          }}
        >
          {labelLeft}
        </span>
        <div
          style={{
            flex: 1,
            position: "relative",
            height: 28,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              height: 2,
              background: "#eae6e0",
              borderRadius: 1,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              height: 2,
              width: `${pct}%`,
              background: "#2c2824",
              borderRadius: 1,
              transition: "width 0.12s",
            }}
          />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(pct)}
            onChange={(e) => onChange(+e.target.value / 100)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              opacity: 0,
              cursor: "pointer",
              height: 28,
              margin: 0,
              zIndex: 2,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${pct}%`,
              transform: "translate(-50%, 0)",
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "#fff",
              border: "2px solid #2c2824",
              boxShadow: "0 1px 6px rgba(44,40,36,0.15)",
              pointerEvents: "none",
              transition: "left 0.12s",
            }}
          />
        </div>
        <span
          style={{
            fontSize: 9,
            fontWeight: rightActive ? 600 : 400,
            color: rightActive ? "#2c2824" : "#cfc9c0",
            minWidth: 80,
            transition: "all 0.25s",
            opacity: rightActive ? 1 : 0.7,
          }}
        >
          {labelRight}
        </span>
      </div>
    </div>
  );
}

function BalanceIndicator({ params }) {
  const avg =
    Object.values(params).reduce((a, b) => a + b, 0) /
    Object.values(params).length;
  const pct = avg * 100;
  return (
    <div
      style={{ marginTop: 8, paddingTop: 16, borderTop: "1px solid #f0ede8" }}
    >
      <div
        style={{
          fontSize: 8,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#b5ada2",
          fontWeight: 700,
          marginBottom: 8,
          textAlign: "center",
        }}
      >
        Perceptual Balance
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 8,
            color: "#cfc9c0",
            minWidth: 80,
            textAlign: "right",
          }}
        >
          ←
        </span>
        <div
          style={{
            flex: 1,
            position: "relative",
            height: 28,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              height: 1,
              background: "#ddd8d0",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              width: 1,
              height: 14,
              background: "#ccc",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${pct}%`,
              transform: "translate(-50%, 0)",
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "#2c2824",
              boxShadow: "0 1px 6px rgba(44,40,36,0.25)",
              pointerEvents: "none",
              transition: "left 0.3s cubic-bezier(0.4,0,0.2,1)",
            }}
          />
        </div>
        <span style={{ fontSize: 8, color: "#cfc9c0", minWidth: 80 }}>→</span>
      </div>
      <div
        style={{
          textAlign: "center",
          fontSize: 8,
          color: "#b5ada2",
          marginTop: 4,
        }}
      >
        avg. position of all parameters
      </div>
    </div>
  );
}

function DimKnob({ label, unit, values, displayFn, value, onChange }) {
  const idx = values.indexOf(value),
    canPrev = idx > 0,
    canNext = idx < values.length - 1;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        flex: 1,
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 8,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "#b5ada2",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "#f8f6f3",
          borderRadius: 10,
          padding: "3px 4px",
          border: "1px solid #ece8e3",
        }}
      >
        <button
          onClick={() => canPrev && onChange(values[idx - 1])}
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            border: "none",
            background: canPrev ? "#fff" : "transparent",
            cursor: canPrev ? "pointer" : "default",
            opacity: canPrev ? 1 : 0.25,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            color: "#2c2824",
            fontWeight: 300,
            boxShadow: canPrev ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
            transition: "all 0.15s",
          }}
        >
          −
        </button>
        <div
          style={{
            minWidth: 52,
            textAlign: "center",
            padding: "0 4px",
            fontSize: 16,
            fontWeight: 600,
            color: "#2c2824",
            letterSpacing: "-0.02em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {displayFn ? displayFn(value) : value}
        </div>
        <button
          onClick={() => canNext && onChange(values[idx + 1])}
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            border: "none",
            background: canNext ? "#fff" : "transparent",
            cursor: canNext ? "pointer" : "default",
            opacity: canNext ? 1 : 0.25,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            color: "#2c2824",
            fontWeight: 300,
            boxShadow: canNext ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
            transition: "all 0.15s",
          }}
        >
          +
        </button>
      </div>
      <div style={{ fontSize: 8, color: "#cbc5bc", letterSpacing: "0.04em" }}>
        {unit || "cm"}
      </div>
    </div>
  );
}

function reconstructPanelData(entry) {
  const result = generateShelf(entry.params, entry.dims);
  return result.panelData;
}

function GalleryCard({ entry }) {
  const [calculating, setCalculating] = useState(false);
  const [calcStatus, setCalcStatus] = useState("idle");

  const avg = Math.round(entry.avgBalance * 100);
  const SLIDER_LABELS = {
    symmetry: ["Symmetric", "Asymmetric"],
    harmony: ["Harmony", "Chaos"],
    familiarity: ["Familiar", "Novelty"],
    simplicity: ["Simple", "Complex"],
    pattern: ["Pattern", "Irregular"],
    contrast: ["Low Contrast", "High Contrast"],
    proportion: ["Proportion", "Disproportion"],
  };

  const handleCalculate = async () => {
    setCalculating(true);
    setCalcStatus("idle");
    try {
      const panelData = reconstructPanelData(entry);
      const summary = Object.entries(entry.params)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join("  ");
      const pdf = await generatePDF(panelData, summary, entry.dims);
      const safeName = (entry.name || "shelf").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadPDF(pdf, `shelf_${safeName}_fabrication.pdf`);
      setCalcStatus("done");
      setTimeout(() => setCalcStatus("idle"), 2000);
    } catch (e) {
      console.error(e);
      setCalcStatus("error");
      setTimeout(() => setCalcStatus("idle"), 2500);
    } finally {
      setCalculating(false);
    }
  };

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid #f0ede8",
        boxShadow: "0 2px 16px rgba(44,40,36,0.06)",
      }}
    >
      {entry.image && (
        <div
          style={{ background: "#faf9f7", borderBottom: "1px solid #f0ede8" }}
        >
          <img
            src={entry.image}
            alt={entry.name}
            style={{
              width: "100%",
              height: 160,
              objectFit: "contain",
              display: "block",
            }}
          />
        </div>
      )}
      <div style={{ padding: "14px 16px 16px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 10,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#2c2824" }}>
              {entry.name}
            </div>
            <div style={{ fontSize: 9, color: "#b5ada2", marginTop: 2 }}>
              {entry.dims
                ? `${Math.round(entry.dims.width * 100)} × ${Math.round(
                    entry.dims.height * 100
                  )} × ${Math.round(entry.dims.depth * 100)} cm`
                : ""}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#2c2824",
                letterSpacing: "-0.03em",
              }}
            >
              {avg}
            </div>
            <div
              style={{
                fontSize: 7,
                color: "#b5ada2",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              balance
            </div>
          </div>
        </div>
        <div
          style={{
            position: "relative",
            height: 3,
            background: "#f0ede8",
            borderRadius: 2,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: `${avg}%`,
              transform: "translateX(-50%)",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#2c2824",
              top: -2.5,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              width: 1,
              height: 8,
              background: "#ddd8d0",
              top: -2,
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            marginBottom: 10,
          }}
        >
          {Object.entries(entry.params || {}).map(([k, v]) => {
            const labels = SLIDER_LABELS[k] || [k, k];
            const label = v < 0.5 ? labels[0] : labels[1];
            const intensity =
              v < 0.5
                ? Math.round((1 - v * 2) * 100)
                : Math.round((v * 2 - 1) * 100);
            return (
              <span
                key={k}
                style={{
                  fontSize: 7.5,
                  padding: "2px 7px",
                  borderRadius: 10,
                  background: "#f5f3f0",
                  color: "#8a8278",
                  letterSpacing: "0.04em",
                }}
              >
                {label} {intensity > 10 ? `${intensity}%` : ""}
              </span>
            );
          })}
        </div>
        <button
          onClick={handleCalculate}
          disabled={calculating}
          style={{
            width: "100%",
            padding: "8px 0",
            border: "1px solid #2c2824",
            background:
              calcStatus === "done"
                ? "#5a9070"
                : calcStatus === "error"
                ? "#c05050"
                : calculating
                ? "#f5f3f0"
                : "#fff",
            color:
              calcStatus === "done" || calcStatus === "error"
                ? "#fff"
                : "#2c2824",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: calculating ? "wait" : "pointer",
            fontFamily: "inherit",
            borderRadius: 8,
            transition: "all 0.2s",
          }}
        >
          {calcStatus === "done"
            ? "✓ PDF downloaded"
            : calcStatus === "error"
            ? "× failed"
            : calculating
            ? "Calculating…"
            : "Calculate this shelf"}
        </button>
      </div>
    </div>
  );
}

function GalleryView({ onClose }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    try {
      const all = JSON.parse(localStorage.getItem("shelf_collection") || "[]");
      setEntries(
        [...all].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      );
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(44,40,36,0.55)",
        zIndex: 200,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        overflowY: "auto",
        padding: "40px 20px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#faf9f7",
          borderRadius: 20,
          width: "100%",
          maxWidth: 800,
          padding: "28px 28px 32px",
          boxShadow: "0 16px 60px rgba(44,40,36,0.2)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 24,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#2c2824",
                letterSpacing: "-0.02em",
              }}
            >
              Shelf Collection
            </div>
            <div style={{ fontSize: 10, color: "#b5ada2", marginTop: 2 }}>
              {entries.length} saved configuration
              {entries.length !== 1 ? "s" : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              border: "1px solid #e8e3dc",
              background: "#fff",
              cursor: "pointer",
              fontSize: 16,
              color: "#8a8278",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>
        {loading ? (
          <div
            style={{
              textAlign: "center",
              padding: "40px 0",
              color: "#b5ada2",
              fontSize: 12,
            }}
          >
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "40px 0",
              color: "#b5ada2",
              fontSize: 12,
            }}
          >
            No shelves saved yet.
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            {entries.map((e, i) => (
              <GalleryCard key={i} entry={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SavePanel({ params, width, height, depth, onClose, captureImage }) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState("idle");
  const avg =
    Object.values(params).reduce((a, b) => a + b, 0) /
    Object.values(params).length;
  const SLIDER_LABELS = {
    symmetry: ["Symmetric", "Asymmetric"],
    harmony: ["Harmony", "Chaos"],
    familiarity: ["Familiar", "Novelty"],
    simplicity: ["Simple", "Complex"],
    pattern: ["Pattern", "Irregular"],
    contrast: ["Low Contrast", "High Contrast"],
    proportion: ["Proportion", "Disproportion"],
  };
  const handleSave = () => {
    if (!name.trim()) return;
    setStatus("saving");
    try {
      let imageData = null;
      try {
        imageData = captureImage();
      } catch {}
      const entry = {
        name: name.trim(),
        timestamp: new Date().toISOString(),
        params,
        dims: { width, height, depth },
        avgBalance: +avg.toFixed(3),
        image: imageData,
      };
      const existing = JSON.parse(
        localStorage.getItem("shelf_collection") || "[]"
      );
      existing.push({
        key: `shelf:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ...entry,
      });
      localStorage.setItem("shelf_collection", JSON.stringify(existing));
      setStatus("done");
      setTimeout(() => onClose(false), 1400);
    } catch {
      setStatus("error");
    }
  };
  const avg_pct = Math.round(avg * 100);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(44,40,36,0.45)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 20,
          padding: "28px 28px 24px",
          width: 340,
          boxShadow: "0 8px 40px rgba(44,40,36,0.18)",
          animation: "fadeSlideIn 0.25s ease",
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: "#2c2824",
            marginBottom: 4,
            letterSpacing: "-0.02em",
          }}
        >
          Save this shelf
        </div>
        <div
          style={{
            fontSize: 10,
            color: "#b5ada2",
            marginBottom: 22,
            lineHeight: 1.5,
          }}
        >
          Your shelf will be added to the shared collection, visible to
          everyone.
        </div>
        <div
          style={{
            fontSize: 9,
            color: "#b5ada2",
            marginBottom: 6,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Your name
        </div>
        <input
          placeholder="e.g. Ilie, Studio X, Anonymous…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "11px 14px",
            borderRadius: 10,
            border: "1.5px solid #e8e3dc",
            fontSize: 13,
            color: "#2c2824",
            outline: "none",
            marginBottom: 18,
            fontFamily: "inherit",
            transition: "border-color 0.2s",
          }}
          onFocus={(e) => (e.target.style.borderColor = "#2c2824")}
          onBlur={(e) => (e.target.style.borderColor = "#e8e3dc")}
          autoFocus
        />
        <div
          style={{
            background: "#f8f6f3",
            borderRadius: 12,
            padding: "14px 16px",
            marginBottom: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <div
              style={{
                fontSize: 9,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#b5ada2",
                fontWeight: 600,
              }}
            >
              Perceptual Balance
            </div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: "#2c2824",
                letterSpacing: "-0.03em",
              }}
            >
              {avg_pct}
              <span style={{ fontSize: 10, fontWeight: 400, color: "#b5ada2" }}>
                /100
              </span>
            </div>
          </div>
          <div
            style={{
              position: "relative",
              height: 4,
              background: "#edeae5",
              borderRadius: 2,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                transform: "translateX(-50%)",
                width: 1,
                height: 10,
                background: "#ddd8d0",
                top: -3,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: `${avg_pct}%`,
                transform: "translateX(-50%)",
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: "#2c2824",
                top: -4,
                boxShadow: "0 1px 4px rgba(44,40,36,0.2)",
              }}
            />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {Object.entries(params).map(([k, v]) => {
              const labels = SLIDER_LABELS[k] || [k, k];
              const label = v < 0.5 ? labels[0] : labels[1];
              return (
                <span
                  key={k}
                  style={{
                    fontSize: 7.5,
                    padding: "3px 8px",
                    borderRadius: 10,
                    background: "#edeae5",
                    color: "#8a8278",
                    letterSpacing: "0.04em",
                  }}
                >
                  {label}
                </span>
              );
            })}
          </div>
          <div
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid #ece8e3",
              fontSize: 9,
              color: "#c5bfb5",
            }}
          >
            {Math.round(width * 100)} × {Math.round(height * 100)} ×{" "}
            {Math.round(depth * 100)} cm · Mild Steel 1.5mm · folded
          </div>
        </div>
        {status === "done" ? (
          <div
            style={{
              textAlign: "center",
              fontSize: 13,
              color: "#5a9070",
              fontWeight: 600,
              padding: "12px 0",
              animation: "fadeSlideIn 0.3s ease",
            }}
          >
            ✓ Saved to collection!
          </div>
        ) : status === "error" ? (
          <div
            style={{
              textAlign: "center",
              fontSize: 12,
              color: "#c05050",
              padding: "8px 0",
              lineHeight: 1.5,
            }}
          >
            Could not save. Please try again.
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                padding: "11px 0",
                border: "1px solid #e8e3dc",
                background: "transparent",
                color: "#9e9789",
                fontSize: 11,
                cursor: "pointer",
                borderRadius: 10,
                fontFamily: "inherit",
                transition: "all 0.2s",
              }}
              onMouseOver={(e) =>
                (e.currentTarget.style.background = "#f8f6f3")
              }
              onMouseOut={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!name.trim() || status === "saving"}
              style={{
                flex: 2,
                padding: "11px 0",
                border: "none",
                background: name.trim() ? "#2c2824" : "#ccc",
                color: "#fff",
                fontSize: 11,
                fontWeight: 600,
                cursor: name.trim() ? "pointer" : "default",
                borderRadius: 10,
                fontFamily: "inherit",
                letterSpacing: "0.08em",
                transition: "all 0.2s",
              }}
            >
              {status === "saving" ? "Saving…" : "Save to collection"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const SLIDERS = [
  { key: "simplicity", left: "Simple", right: "Complex" },
  { key: "familiarity", left: "Familiar", right: "Novelty" },
  { key: "symmetry", left: "Symmetric", right: "Asymmetric" },
  { key: "harmony", left: "Harmony", right: "Chaos" },
  { key: "pattern", left: "Pattern", right: "Irregular" },
  { key: "contrast", left: "Low Contrast", right: "High Contrast" },
  { key: "proportion", left: "Proportion", right: "Disproportion" },
];

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function ShelfConfigurator() {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const rendRef = useRef(null);
  const shelfRef = useRef(null);
  const camRef = useRef(null);
  const dragRef = useRef({ active: false, x: 0, y: 0 });
  const rotRef = useRef({ y: 0.35, ty: 0.35, x: -0.08, tx: -0.08 });
  const panelDataRef = useRef(null);
  const wallMeshRef = useRef(null);
  const floorMeshRef = useRef(null);
  const gridRef = useRef(null);

  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [width, setWidth] = useState(1.0);
  const [height, setHeight] = useState(1.0);
  const depth = MAIN_FACE;
  const [mobile, setMobile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [pdfStatus, setPdfStatus] = useState("idle");
  const [wallMounted, setWallMounted] = useState(false);
  const [mountY, setMountY] = useState(0.9);
  const wallMountedRef = useRef(false);
  const mountYRef = useRef(0.9);
  useEffect(() => {
    wallMountedRef.current = wallMounted;
  }, [wallMounted]);
  useEffect(() => {
    mountYRef.current = mountY;
  }, [mountY]);

  useEffect(() => {
    const check = () => setMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const setP = (key) => (val) => setParams((p) => ({ ...p, [key]: val }));

  const captureImage = useCallback(() => {
    const renderer = rendRef.current,
      scene = sceneRef.current,
      cam = camRef.current;
    if (!renderer || !scene || !cam) return null;
    renderer.render(scene, cam);
    try {
      return renderer.domElement.toDataURL("image/jpeg", 0.75);
    } catch {
      return null;
    }
  }, []);

  const [pdfError, setPdfError] = useState(null);

  const handleCalculate = useCallback(async () => {
    const pd = panelDataRef.current;
    if (!pd) {
      setPdfError("No shelf to export — try changing a slider first");
      setPdfStatus("error");
      setTimeout(() => {
        setPdfStatus("idle");
        setPdfError(null);
      }, 3500);
      return;
    }
    setPdfStatus("loading");
    setPdfError(null);
    try {
      const summary = Object.entries(params)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join("  ");
      const pdf = await generatePDF(pd, summary, { width, height, depth });
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const result = downloadPDF(pdf, `shelf_${ts}_fabrication.pdf`);
      if (!result.ok) {
        throw new Error("Download failed — your browser may be blocking it.");
      }
      setPdfStatus("done");
      setTimeout(() => setPdfStatus("idle"), 2200);
    } catch (e) {
      setPdfError(e.message || String(e));
      setPdfStatus("error");
      setTimeout(() => {
        setPdfStatus("idle");
        setPdfError(null);
      }, 5000);
    }
  }, [params, width, height, depth]);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xfaf9f7);
    sceneRef.current = scene;
    const cam = new THREE.PerspectiveCamera(
      24,
      el.clientWidth / el.clientHeight,
      0.001,
      50
    );
    cam.position.set(0, 1.1, 5.8);
    cam.lookAt(0, 0.85, 0);
    camRef.current = cam;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    rendRef.current = renderer;
    el.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xfff8f0, 0.85);
    key.position.set(4, 6, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 15;
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -1;
    key.shadow.bias = -0.001;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xf0f4ff, 0.32);
    fill.position.set(-3, 2, 3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.15);
    rim.position.set(0, -1, -4);
    scene.add(rim);
    const grid = new THREE.GridHelper(6, 40, 0xedeae6, 0xf2f0ec);
    grid.position.y = -0.001;
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    scene.add(grid);
    gridRef.current = grid;

    const wallGeom = new THREE.PlaneGeometry(20, 8);
    const wallMesh = new THREE.Mesh(wallGeom, MAT_WALL);
    wallMesh.name = "wall";
    wallMesh.position.set(0, 4, 0);
    wallMesh.receiveShadow = true;
    wallMesh.visible = false;
    scene.add(wallMesh);
    wallMeshRef.current = wallMesh;

    const floorGeom = new THREE.PlaneGeometry(20, 20);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xf0ede8,
      roughness: 0.95,
    });
    const floorMesh = new THREE.Mesh(floorGeom, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -0.002;
    floorMesh.receiveShadow = true;
    floorMesh.visible = false;
    scene.add(floorMesh);
    floorMeshRef.current = floorMesh;

    const getP = (e) => ({
      x: e.touches ? e.touches[0].clientX : e.clientX,
      y: e.touches ? e.touches[0].clientY : e.clientY,
    });
    const onDown = (e) => {
      if (wallMountedRef.current) return;
      const p = getP(e);
      dragRef.current = { active: true, ...p };
    };
    const onMove = (e) => {
      if (!dragRef.current.active) return;
      const p = getP(e);
      rotRef.current.ty = Math.max(
        -1.4,
        Math.min(1.4, rotRef.current.ty + (p.x - dragRef.current.x) * 0.005)
      );
      rotRef.current.tx = Math.max(
        -0.4,
        Math.min(0.4, rotRef.current.tx + (p.y - dragRef.current.y) * 0.003)
      );
      dragRef.current = { active: true, ...p };
    };
    const onUp = () => {
      dragRef.current.active = false;
    };
    const cv = renderer.domElement;
    cv.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    cv.addEventListener("touchstart", onDown, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onUp);

    let alive = true;
    const tick = () => {
      if (!alive) return;
      requestAnimationFrame(tick);
      if (!wallMountedRef.current) {
        const r = rotRef.current;
        r.y += (r.ty - r.y) * 0.08;
        r.x += (r.tx - r.x) * 0.08;
        if (shelfRef.current) {
          shelfRef.current.rotation.y = r.y;
          shelfRef.current.rotation.x = r.x;
        }
      }
      renderer.render(scene, cam);
    };
    tick();

    const onResize = () => {
      cam.aspect = el.clientWidth / el.clientHeight;
      cam.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener("resize", onResize);
    return () => {
      alive = false;
      window.removeEventListener("resize", onResize);
      cv.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cv.removeEventListener("touchstart", onDown);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
      if (el.contains(cv)) el.removeChild(cv);
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const old = scene.getObjectByName("shelf");
    if (old) {
      old.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
      });
      scene.remove(old);
    }
    const result = generateShelf(params, { width, height, depth });
    const shelf = result.group;
    panelDataRef.current = result.panelData;
    const box = new THREE.Box3().setFromObject(shelf);
    const ctr = new THREE.Vector3();
    box.getCenter(ctr);

    if (wallMounted) {
      shelf.position.set(-ctr.x, mountY - box.min.y, -box.min.z);
      shelf.rotation.y = 0;
      shelf.rotation.x = 0;
      rotRef.current.y = 0;
      rotRef.current.ty = 0;
      rotRef.current.x = 0;
      rotRef.current.tx = 0;
    } else {
      shelf.position.set(-ctr.x, -box.min.y, -ctr.z);
      shelf.rotation.y = rotRef.current.y;
      shelf.rotation.x = rotRef.current.x;
    }
    scene.add(shelf);
    shelfRef.current = shelf;

    if (wallMeshRef.current) wallMeshRef.current.visible = wallMounted;
    if (floorMeshRef.current) floorMeshRef.current.visible = wallMounted;
    if (gridRef.current) gridRef.current.visible = !wallMounted;

    const cam = camRef.current;
    if (cam) {
      if (wallMounted) {
        const camDist = Math.max(width, height) * 2.5 + 1.2;
        const camH = mountY + height / 2;
        cam.position.set(0, camH, camDist);
        cam.lookAt(0, camH, 0);
      } else {
        const camDist = Math.max(width, height) * 2.8 + 1.5;
        const camH = Math.max(width, height) * 0.55;
        cam.position.set(0, camH, camDist);
        cam.lookAt(0, camH * 0.75, 0);
      }
      cam.updateProjectionMatrix();
    }
  }, [params, width, height, depth, wallMounted, mountY]);

  useEffect(() => {
    const el = mountRef.current,
      renderer = rendRef.current,
      cam = camRef.current;
    if (!el || !renderer || !cam) return;
    requestAnimationFrame(() => {
      const w = el.clientWidth,
        h = el.clientHeight;
      if (w > 0 && h > 0) {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
    });
  }, [mobile]);

  const cmDisplay = (v) => `${Math.round(v * 100)}`;

  const logoBlock = (sz) => (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: sz > 28 ? 12 : 10,
      }}
    >
      <div
        style={{
          width: sz,
          height: sz,
          borderRadius: sz > 28 ? 7 : 6,
          background: "linear-gradient(135deg, #2c2824, #403832)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 8px rgba(44,40,36,0.18)",
          flexShrink: 0,
        }}
      >
        <svg
          width={sz * 0.47}
          height={sz * 0.47}
          viewBox="0 0 14 14"
          fill="none"
        >
          <rect
            x="1"
            y="1"
            width="5"
            height="5"
            rx="0.8"
            fill="#fff"
            opacity="0.92"
          />
          <rect
            x="8"
            y="1"
            width="5"
            height="5"
            rx="0.8"
            fill="#bec6ca"
            opacity="0.6"
          />
          <rect
            x="1"
            y="8"
            width="5"
            height="5"
            rx="0.8"
            fill="#bec6ca"
            opacity="0.6"
          />
          <rect
            x="8"
            y="8"
            width="5"
            height="5"
            rx="0.8"
            fill="#fff"
            opacity="0.92"
          />
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: sz > 28 ? 16 : 14,
            fontWeight: 600,
            color: "#2c2824",
            letterSpacing: "-0.015em",
          }}
        >
          Beyond Shelf Life
        </div>
        {sz > 28 && (
          <>
            <div
              style={{
                fontSize: 10,
                color: "#8a8278",
                lineHeight: 1.45,
                marginTop: 6,
                fontWeight: 400,
              }}
            >
              Beyond Shelf Life is an interactive parametric shelving design
              system that explores how perceptual qualities shape aesthetic
              preference. Adjust the sliders to generate a unique folded steel
              shelving system, then save your design to the shared collection or
              export it as fabrication drawings.
            </div>
            <div
              style={{
                fontSize: 9.5,
                color: "#c0bab0",
                letterSpacing: "0.02em",
                marginTop: 8,
              }}
            >
              Mild Steel 1.5 mm · Folded · Bolted
            </div>
          </>
        )}
      </div>
    </div>
  );

  const controlsContent = (
    <>
      <div style={{ padding: mobile ? "16px 20px 14px" : "20px 24px 18px" }}>
        <div
          style={{
            fontSize: 9,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#c5bfb5",
            fontWeight: 600,
            marginBottom: 14,
          }}
        >
          Dimensions
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "stretch" }}>
          <DimKnob
            label="W"
            unit="cm"
            values={[1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4]}
            value={width}
            displayFn={cmDisplay}
            onChange={setWidth}
          />
          <DimKnob
            label="H"
            unit="cm"
            values={[1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4]}
            value={height}
            displayFn={cmDisplay}
            onChange={setHeight}
          />
        </div>
      </div>
      <div
        style={{
          height: 1,
          background: "#f0ede8",
          margin: mobile ? "0 20px" : "0 24px",
        }}
      />
      <div style={{ padding: mobile ? "16px 20px 8px" : "20px 24px 8px" }}>
        <div
          style={{
            fontSize: 9,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#c5bfb5",
            fontWeight: 600,
            marginBottom: 18,
          }}
        >
          Perceptual Balance
        </div>
        {SLIDERS.map((s) => (
          <PerceptualSlider
            key={s.key}
            labelLeft={s.left}
            labelRight={s.right}
            value={params[s.key]}
            onChange={setP(s.key)}
          />
        ))}
        <BalanceIndicator params={params} />
      </div>
      <div style={{ padding: mobile ? "10px 20px 4px" : "10px 24px 4px" }}>
        <button
          onClick={() => setGalleryOpen(true)}
          style={{
            width: "100%",
            padding: "10px 0",
            border: "1px solid #e8e3dc",
            background: "transparent",
            color: "#8a8278",
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "inherit",
            borderRadius: 8,
            transition: "all 0.2s",
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.background = "#f8f6f3";
            e.currentTarget.style.color = "#2c2824";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "#8a8278";
          }}
        >
          View collection
        </button>
      </div>
      <div style={{ padding: mobile ? "6px 20px 4px" : "6px 24px 4px" }}>
        <button
          onClick={() => setWallMounted((w) => !w)}
          style={{
            width: "100%",
            padding: "10px 0",
            border: "1px solid #e8e3dc",
            background: wallMounted ? "#2c2824" : "transparent",
            color: wallMounted ? "#f5f3f0" : "#8a8278",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "inherit",
            borderRadius: 8,
            transition: "all 0.2s",
          }}
        >
          {wallMounted ? "✓ Wall-mounted" : "Wall-mount it"}
        </button>
      </div>
      <div style={{ padding: mobile ? "6px 20px 4px" : "6px 24px 4px" }}>
        <button
          onClick={() => setSaveOpen(true)}
          style={{
            width: "100%",
            padding: "10px 0",
            border: "none",
            background: "#2c2824",
            color: "#f5f3f0",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "inherit",
            borderRadius: 8,
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = "#403832")}
          onMouseOut={(e) => (e.currentTarget.style.background = "#2c2824")}
        >
          Save this shelf
        </button>
      </div>
      <div style={{ padding: mobile ? "6px 20px 4px" : "6px 24px 4px" }}>
        <button
          onClick={handleCalculate}
          disabled={pdfStatus === "loading"}
          style={{
            width: "100%",
            padding: "10px 0",
            border: "1px solid #2c2824",
            background:
              pdfStatus === "done"
                ? "#5a9070"
                : pdfStatus === "error"
                ? "#c05050"
                : pdfStatus === "loading"
                ? "#f5f3f0"
                : "#fff",
            color:
              pdfStatus === "done" || pdfStatus === "error"
                ? "#fff"
                : "#2c2824",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: pdfStatus === "loading" ? "wait" : "pointer",
            fontFamily: "inherit",
            borderRadius: 8,
            transition: "all 0.2s",
          }}
        >
          {pdfStatus === "done"
            ? "✓ PDF downloaded"
            : pdfStatus === "error"
            ? "× Failed — see message below"
            : pdfStatus === "loading"
            ? "Generating PDF…"
            : "Calculate this shelf"}
        </button>
        {pdfError && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 10px",
              background: "#fbe9e9",
              border: "1px solid #f0c8c8",
              borderRadius: 6,
              fontSize: 9.5,
              color: "#a04040",
              lineHeight: 1.45,
            }}
          >
            {pdfError}
          </div>
        )}
      </div>
      <div style={{ padding: mobile ? "6px 20px 24px" : "6px 24px 20px" }}>
        <button
          onClick={() => setParams(DEFAULT_PARAMS)}
          style={{
            width: "100%",
            padding: "10px 0",
            border: "none",
            background: "#f5f3f0",
            color: "#a9a196",
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "inherit",
            borderRadius: 8,
            transition: "all 0.2s",
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.background = "#edeae5";
            e.currentTarget.style.color = "#2c2824";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = "#f5f3f0";
            e.currentTarget.style.color = "#a9a196";
          }}
        >
          Reset to default
        </button>
      </div>
    </>
  );

  const viewportOverlays = (
    <>
      {!wallMounted && (
        <div
          style={{
            position: "absolute",
            top: mobile ? 52 : 18,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 9,
            color: "#d4cfc6",
            letterSpacing: "0.28em",
            textTransform: "uppercase",
            pointerEvents: "none",
          }}
        >
          Drag to rotate
        </div>
      )}
      <div
        style={{
          position: "absolute",
          bottom: mobile ? (drawerOpen ? "56%" : 72) : 18,
          right: mobile ? 14 : 22,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: mobile ? 9 : 10,
          color: "#a9a196",
          background: "rgba(255,255,255,0.82)",
          backdropFilter: "blur(12px)",
          padding: mobile ? "5px 12px" : "7px 16px",
          borderRadius: 20,
          border: "1px solid rgba(44,40,36,0.05)",
          boxShadow: "0 2px 12px rgba(44,40,36,0.04)",
          zIndex: 1,
        }}
      >
        <span
          style={{
            fontWeight: 500,
            color: "#8a8278",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Math.round(width * 1000)} × {Math.round(height * 1000)} ×{" "}
          {Math.round(depth * 1000)}
        </span>
        <span style={{ fontSize: 8.5, color: "#c5bfb5" }}>mm</span>
      </div>
      {!mobile && (
        <div
          style={{
            position: "absolute",
            bottom: 18,
            left: 22,
            fontSize: 9,
            color: "#beb6ab",
            background: "rgba(255,255,255,0.82)",
            backdropFilter: "blur(12px)",
            padding: "6px 14px",
            borderRadius: 16,
            border: "1px solid rgba(44,40,36,0.05)",
          }}
        >
          Mild Steel 1.5mm · Folded · Bolted
        </div>
      )}
    </>
  );

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        display: "flex",
        flexDirection: mobile ? "column" : "row",
        background: "#faf9f7",
        fontFamily:
          "'SF Pro Display', -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <style>{`
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #e0dbd4; border-radius: 3px; }
        @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {!mobile && (
        <div
          style={{
            width: 320,
            minWidth: 320,
            background: "#fff",
            borderRight: "1px solid rgba(44,40,36,0.05)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            boxShadow: "4px 0 20px rgba(44,40,36,0.025)",
            zIndex: 2,
          }}
        >
          <div
            style={{
              padding: "24px 24px 20px",
              borderBottom: "1px solid #f0ede8",
            }}
          >
            {logoBlock(30)}
          </div>
          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
            {controlsContent}
          </div>
        </div>
      )}

      <div
        style={{
          flex: 1,
          position: "relative",
          background: "#faf9f7",
          minHeight: 0,
        }}
      >
        <div
          ref={mountRef}
          style={{
            width: "100%",
            height: "100%",
            cursor: wallMounted ? "default" : "grab",
          }}
        />
        {mobile && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              background: "rgba(250,249,247,0.85)",
              backdropFilter: "blur(12px)",
              zIndex: 3,
            }}
          >
            {logoBlock(26)}
          </div>
        )}
        {viewportOverlays}
      </div>

      {mobile && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            maxHeight: drawerOpen ? "60vh" : 56,
            background: "#fff",
            borderRadius: "16px 16px 0 0",
            boxShadow: "0 -4px 24px rgba(44,40,36,0.08)",
            transition: "max-height 0.4s cubic-bezier(0.4,0,0.2,1)",
            overflow: "hidden",
            zIndex: 10,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <button
            onClick={() => setDrawerOpen((p) => !p)}
            style={{
              width: "100%",
              padding: "10px 20px 8px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: "#ddd8d0",
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: "#2c2824" }}>
                {drawerOpen ? "Hide controls" : "Configure"}
              </span>
              <span style={{ fontSize: 9, color: "#b5ada2" }}>
                {Math.round(width * 100)}×{Math.round(height * 100)}×
                {Math.round(depth * 100)} cm
              </span>
            </div>
          </button>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              overflowX: "hidden",
              opacity: drawerOpen ? 1 : 0,
              transition: "opacity 0.3s ease 0.1s",
            }}
          >
            {controlsContent}
          </div>
        </div>
      )}

      {saveOpen && (
        <SavePanel
          params={params}
          width={width}
          height={height}
          depth={depth}
          onClose={() => setSaveOpen(false)}
          captureImage={captureImage}
        />
      )}
      {galleryOpen && <GalleryView onClose={() => setGalleryOpen(false)} />}
    </div>
  );
}
