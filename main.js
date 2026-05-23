import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// -- Constants -----------------------------------------------------------------

const COLOR_HEX = {
  white:  0xffffff,
  purple: 0x7b2fbe,
  green:  0x2ecc71,
  red:    0xe74c3c,
  orange: 0xe67e22,
  yellow: 0xf1c40f,
  blue:   0x2980b9,
  black:  0x111111,
};
const INNER      = 0x1c1c1c;
const GAP        = 0.045;
const ALL_FACES  = ['U', 'D', 'F', 'B', 'L', 'R'];
// Stable index list, must match what solver.worker.js expects
const COLOR_NAMES = ['white', 'purple', 'green', 'red', 'orange', 'yellow', 'blue', 'black'];
function colorIdx(name) { const i = COLOR_NAMES.indexOf(name); return i < 0 ? 7 : i; }

// Position → piece key  (order: U/D first, then F/B, then R/L. Matches config)
function posKey(x, y, z) {
  const parts = [];
  if (y ===  1) parts.push('U');
  if (y === -1) parts.push('D');
  if (z ===  1) parts.push('F');
  if (z === -1) parts.push('B');
  if (x ===  1) parts.push('R');
  if (x === -1) parts.push('L');
  return parts.join('');
}

function faceAxis(f)  { return { U:'y', D:'y', F:'z', B:'z', L:'x', R:'x' }[f]; }
function faceLayer(f) { return { U:1,  D:-1,  F:1,  B:-1,  L:-1,  R:1  }[f]; }

// -- Cubie state (plain objects, no Three.js) ----------------------------------

function buildCubies(config) {
  const list = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const key = posKey(x, y, z);
        const nz  = (x !== 0) + (y !== 0) + (z !== 0);
        const color =
          nz === 1 ? (config.centers[key] ?? 'black') :
          nz === 2 ? (config.edges[key]   ?? 'black') :
                     (config.corners[key] ?? 'black');
        list.push({ x, y, z, color });
      }
    }
  }
  return list;
}

// Serialize cubies for the worker: Int8Array [x,y,z,colorIdx] × 26
function cubiesToBuffer(cubies) {
  const buf = new Int8Array(26 * 4);
  cubies.forEach((c, i) => {
    buf[i * 4]     = c.x;
    buf[i * 4 + 1] = c.y;
    buf[i * 4 + 2] = c.z;
    buf[i * 4 + 3] = colorIdx(c.color);
  });
  return buf;
}

// -- Animation state -----------------------------------------------------------

let anim        = null;  // { pivot, axis, targetAngle, startTime, duration, onComplete }
let isAnimating = false;

function easeInOut(t) { return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; }

// Pivot-group animation: parent the slice to a group, rotate the group,
// then un-parent. This makes every cubie spin correctly around the face axis.
function startMoveAnimation(face, inv, double, duration, onComplete) {
  const axis    = faceAxis(face);
  const layer   = faceLayer(face);
  const affected = meshCubies.filter(mc => mc[axis] === layer);

  clearSelection(); // avoid stale selection box during animation

  const pivot = new THREE.Group(); // at world origin — same as cube centre
  scene.add(pivot);
  affected.forEach(mc => pivot.add(mc.mesh)); // auto-detaches from scene

  const targetAngle = (inv ? 1 : -1) * Math.PI / 2 * (double ? 2 : 1);

  anim = {
    pivot, axis, targetAngle,
    startTime: performance.now(),
    duration,
    onComplete() {
      // Un-parent back to scene, preserving world transform
      affected.forEach(mc => scene.attach(mc.mesh));
      scene.remove(pivot);
      // Update logical positions (mc.x/y/z still hold old values)
      applyMovePure(face, inv, double);
      // Snap mesh.position to integer grid and refresh material colours
      affected.forEach(mc => refreshMesh(mc));
      onComplete?.();
    },
  };
}

// Update only the logical positions (mc.x/y/z), no mesh changes
function applyMovePure(face, inv, double = false) {
  const axis  = faceAxis(face);
  const layer = faceLayer(face);
  const angle = inv ? Math.PI / 2 : -Math.PI / 2;
  const times = double ? 2 : 1;
  for (let t = 0; t < times; t++) {
    const mat = new THREE.Matrix4();
    if (axis === 'x') mat.makeRotationX(angle);
    if (axis === 'y') mat.makeRotationY(angle);
    if (axis === 'z') mat.makeRotationZ(angle);
    meshCubies.filter(mc => mc[axis] === layer).forEach(mc => {
      const p = new THREE.Vector3(mc.x, mc.y, mc.z).applyMatrix4(mat);
      mc.x = Math.round(p.x);
      mc.y = Math.round(p.y);
      mc.z = Math.round(p.z);
    });
  }
}

function tickAnimation() {
  if (!anim) return;
  const t = Math.min((performance.now() - anim.startTime) / anim.duration, 1);
  const angle = anim.targetAngle * easeInOut(t);

  if (anim.axis === 'x') anim.pivot.rotation.x = angle;
  if (anim.axis === 'y') anim.pivot.rotation.y = angle;
  if (anim.axis === 'z') anim.pivot.rotation.z = angle;

  if (t >= 1) {
    const cb = anim.onComplete;
    anim = null;
    cb();
  }
}

function setAnimating(on) {
  isAnimating = on;
  ['btn-scramble', 'btn-solve', 'btn-reset', 'btn-prev', 'btn-next'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = on;
  });
}

// -- Three.js scene ------------------------------------------------------------

let scene, camera, renderer, controls, raycaster, pointer;
let meshCubies = [];   // { x, y, z, color, mesh }
let selBox      = null;
let selectedIdx = null;
let activeColor = 'white';
let config, solvedMap; // solvedMap: posKey → color

// Build Three.js mesh for one cubie: single material (all faces same colour).
// The physical pieces are solid-coloured plastic so this is correct for this puzzle,
// and avoids exposing dark inner faces through inter-layer gaps during rotation.
function makeMesh(c) {
  const geo  = new THREE.BoxGeometry(1 - GAP, 1 - GAP, 1 - GAP);
  const hex  = COLOR_HEX[c.color] ?? INNER;
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: hex }));
  mesh.position.set(c.x, c.y, c.z);
  return mesh;
}

// Sync mesh visuals to cubie data (call after any position/colour change).
// Rotation is reset so the mesh axes re-align with world axes after pivot animation.
function refreshMesh(mc) {
  mc.mesh.material.color.setHex(COLOR_HEX[mc.color] ?? INNER);
  mc.mesh.position.set(mc.x, mc.y, mc.z);
  mc.mesh.rotation.set(0, 0, 0);
}

function spawnMeshes(cubies) {
  meshCubies.forEach(mc => scene.remove(mc.mesh));
  meshCubies = cubies.map(c => {
    const mesh = makeMesh(c);
    scene.add(mesh);
    return { ...c, mesh };
  });
}

// -- Selection -----------------------------------------------------------------

function selectCubie(idx) {
  clearSelection();
  selectedIdx = idx;
  const mc  = meshCubies[idx];
  const geo = new THREE.BoxGeometry(1.08, 1.08, 1.08);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.35 });
  selBox = new THREE.Mesh(geo, mat);
  selBox.position.copy(mc.mesh.position);
  scene.add(selBox);
  showLabel(`${posKey(mc.x, mc.y, mc.z)} — pick a color to paint`);
}

function clearSelection() {
  selectedIdx = null;
  if (selBox) { scene.remove(selBox); selBox = null; }
  hideLabel();
}

function paintSelected(color) {
  if (selectedIdx === null) return;
  meshCubies[selectedIdx].color = color;
  refreshMesh(meshCubies[selectedIdx]);
  clearSelection();
}

// -- Pointer events ------------------------------------------------------------

function onClick(e) {
  if (isAnimating) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(meshCubies.map(mc => mc.mesh));
  if (!hits.length) { clearSelection(); return; }
  const idx = meshCubies.findIndex(mc => mc.mesh === hits[0].object);
  if (idx === selectedIdx) clearSelection();
  else selectCubie(idx);
}

// -- Move application to meshes ------------------------------------------------

function applyMoveToScene(face, inv, double = false) {
  const axis  = faceAxis(face);
  const layer = faceLayer(face);
  const angle = inv ? Math.PI / 2 : -Math.PI / 2;
  const times = double ? 2 : 1;

  for (let t = 0; t < times; t++) {
    const mat = new THREE.Matrix4();
    if (axis === 'x') mat.makeRotationX(angle);
    if (axis === 'y') mat.makeRotationY(angle);
    if (axis === 'z') mat.makeRotationZ(angle);

    meshCubies.filter(mc => mc[axis] === layer).forEach(mc => {
      const p = new THREE.Vector3(mc.x, mc.y, mc.z).applyMatrix4(mat);
      mc.x = Math.round(p.x);
      mc.y = Math.round(p.y);
      mc.z = Math.round(p.z);
      refreshMesh(mc);
    });
  }

  // Keep selection box in sync
  if (selBox && selectedIdx !== null) {
    selBox.position.copy(meshCubies[selectedIdx].mesh.position);
  }
}

function parseLabel(label) {
  return { face: label[0], inv: label.includes("'"), double: label.includes('2') };
}

// -- Scramble ------------------------------------------------------------------

let scrambleHistory = [];

function doScramble() {
  hideSolution();
  clearSelection();
  scrambleHistory = [];
  let lastFace = '';

  for (let i = 0; i < 6; i++) {
    let face;
    do { face = ALL_FACES[Math.floor(Math.random() * 6)]; } while (face === lastFace);
    lastFace = face;
    const inv = Math.random() < 0.5;
    scrambleHistory.push({ face, inv, double: false });
  }

  setAnimating(true);
  let i = 0;
  function playNext() {
    if (i >= scrambleHistory.length) { setAnimating(false); return; }
    const { face, inv, double } = scrambleHistory[i++];
    startMoveAnimation(face, inv, double, 180, playNext);
  }
  playNext();
}

// -- Solver (Web Worker) -------------------------------------------------------

let solution     = [];
let solutionStep = 0;
let preSnapshot  = null;
let activeWorker = null;

function snapshotState() {
  return meshCubies.map(mc => ({ x: mc.x, y: mc.y, z: mc.z, color: mc.color }));
}

function doSolve() {
  clearSelection();

  // Already solved?
  const snap = snapshotState();
  if (snap.every(c => solvedMap.get(posKey(c.x, c.y, c.z)) === c.color)) {
    showSolution([]);
    return;
  }

  preSnapshot = snap;
  setSolving(true);

  if (activeWorker) activeWorker.terminate();
  activeWorker = new Worker('./solver.worker.js');

  activeWorker.onmessage = ({ data: { moves } }) => {
    activeWorker = null;
    setSolving(false);
    if (moves === null) {
      alert('No solution found within 7 moves.\nTip: use the Scramble button (6 moves) and then Solve.');
      return;
    }
    solution     = moves;
    solutionStep = 0;
    showSolution(moves);
  };

  activeWorker.postMessage({
    startState:  cubiesToBuffer(snap),
    solvedState: cubiesToBuffer(buildCubies(config)),
  });
}

function setSolving(on) {
  const btn = document.getElementById('btn-solve');
  btn.textContent = on ? 'Solving…' : 'Solve';
  btn.disabled    = on;
}

// -- Solution panel ------------------------------------------------------------

function showSolution(moves) {
  const panel = document.getElementById('solution-panel');
  panel.hidden = false;
  const el = document.getElementById('solution-moves');
  el.innerHTML = '';
  if (moves.length === 0) {
    el.textContent = 'Already solved!';
  } else {
    moves.forEach((m, i) => {
      const span = document.createElement('span');
      span.className  = 'move-token';
      span.textContent = m;
      span.dataset.i  = i;
      el.appendChild(span);
    });
  }
  updateCounter();
}

function hideSolution() {
  document.getElementById('solution-panel').hidden = true;
  solution = []; solutionStep = 0; preSnapshot = null;
}

function stepSolution(dir) {
  if (!preSnapshot || isAnimating) return;
  const target = solutionStep + dir;
  if (target < 0 || target > solution.length) return;

  if (dir === 1) {
    const { face, inv, double } = parseLabel(solution[solutionStep]);
    setAnimating(true);
    startMoveAnimation(face, inv, double, 280, () => {
      solutionStep++;
      updateCounter();
      setAnimating(false);
    });
  } else {
    // Rewind is instant — rebuild from snapshot, replay up to target
    spawnMeshes(preSnapshot);
    for (let i = 0; i < target; i++) {
      const { face, inv, double } = parseLabel(solution[i]);
      applyMoveToScene(face, inv, double);
    }
    solutionStep = target;
    updateCounter();
  }
}

function updateCounter() {
  document.getElementById('step-counter').textContent = `${solutionStep} / ${solution.length}`;
  document.querySelectorAll('.move-token').forEach(el => {
    el.classList.toggle('active', +el.dataset.i === solutionStep - 1);
  });
}

// -- UI wiring -----------------------------------------------------------------

function setupUI() {
  document.querySelectorAll('.swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeColor = btn.dataset.color;
      paintSelected(activeColor);
    });
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    anim = null;
    if (activeWorker) { activeWorker.terminate(); activeWorker = null; setSolving(false); }
    setAnimating(false);
    spawnMeshes(buildCubies(config));
    clearSelection();
    hideSolution();
  });
  document.getElementById('btn-scramble').addEventListener('click', () => {
    anim = null;
    if (activeWorker) { activeWorker.terminate(); activeWorker = null; setSolving(false); }
    setAnimating(false);
    doScramble();
  });
  document.getElementById('btn-solve').addEventListener('click', doSolve);
  document.getElementById('btn-prev').addEventListener('click', () => stepSolution(-1));
  document.getElementById('btn-next').addEventListener('click', () => stepSolution(1));
}

// -- Label ---------------------------------------------------------------------

let labelEl;
function ensureLabel() {
  if (!labelEl) {
    labelEl = document.createElement('div');
    labelEl.id = 'selected-label';
    document.getElementById('viewport').appendChild(labelEl);
  }
  return labelEl;
}
function showLabel(t) { ensureLabel().textContent = t; ensureLabel().classList.add('visible'); }
function hideLabel()  { ensureLabel().classList.remove('visible'); }

// -- Render loop ---------------------------------------------------------------

function animate() {
  requestAnimationFrame(animate);
  tickAnimation();
  controls.update();
  renderer.render(scene, camera);
}

function onResize() {
  const vp = document.getElementById('viewport');
  camera.aspect = vp.clientWidth / vp.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(vp.clientWidth, vp.clientHeight);
}

// -- Entry point ---------------------------------------------------------------

async function init() {
  config = await fetch('./configs/tetris.json').then(r => r.json());

  const solved = buildCubies(config);
  solvedMap    = new Map(solved.map(c => [posKey(c.x, c.y, c.z), c.color]));

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0f0f);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(4.5, 3.5, 5.5);

  const vp = document.getElementById('viewport');
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  vp.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(5, 8, 6);
  scene.add(dir);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping  = true;
  controls.dampingFactor  = 0.08;
  controls.minDistance    = 3;
  controls.maxDistance    = 14;

  raycaster = new THREE.Raycaster();
  pointer   = new THREE.Vector2();

  spawnMeshes(solved);
  setupUI();
  onResize();

  window.addEventListener('resize', onResize);

  // Click vs drag detection
  let pStart = { x: 0, y: 0 };
  renderer.domElement.addEventListener('pointerdown', e => { pStart = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (Math.hypot(e.clientX - pStart.x, e.clientY - pStart.y) > 6) return;
    onClick(e);
  });

  animate();
}

init();
