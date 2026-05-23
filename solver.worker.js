// IDA* solver — runs off the main thread, no Three.js
// State: Int8Array(104)  →  [x, y, z, colorIdx] × 26 cubies

const FACE_AXIS  = { U:'y', D:'y', F:'z', B:'z', L:'x', R:'x' };
const FACE_LAYER = { U:1,  D:-1,  F:1,  B:-1,  L:-1,  R:1  };
const FACE_IDX   = { U:0,  D:1,   F:2,  B:3,   L:4,   R:5  };
const OPPOSITE   = [1, 0, 3, 2, 5, 4]; // U↔D, F↔B, L↔R

const MOVE_DEFS = [];
['U','D','F','B','L','R'].forEach(face => {
  const fi = FACE_IDX[face];
  MOVE_DEFS.push({ face, inv: false, double: false, label: face,      fi });
  MOVE_DEFS.push({ face, inv: true,  double: false, label: face + "'", fi });
  MOVE_DEFS.push({ face, inv: false, double: true,  label: face + '2', fi });
});

let solvedLookup; // Int8Array(27): posIdx → expected colorIdx, -1 = unused
const moveStack = new Int8Array(12);
let solutionDepth = 0;

function posIdx(x, y, z) { return (x + 1) * 9 + (y + 1) * 3 + (z + 1); }

// Pure-integer 90° rotation — no floating point, no matrix alloc
function applyMove(s, face, inv, double) {
  const axis  = FACE_AXIS[face];
  const layer = FACE_LAYER[face];
  const times = double ? 2 : 1;
  for (let t = 0; t < times; t++) {
    for (let i = 0; i < 26; i++) {
      const b = i << 2;
      const x = s[b], y = s[b + 1], z = s[b + 2];
      const lv = axis === 'x' ? x : axis === 'y' ? y : z;
      if (lv !== layer) continue;
      if (axis === 'y') {
        s[b]     = inv ?  z : -z;
        s[b + 2] = inv ? -x :  x;
        // y unchanged
      } else if (axis === 'z') {
        s[b]     = inv ? -y :  y;
        s[b + 1] = inv ?  x : -x;
        // z unchanged
      } else {
        s[b + 1] = inv ? -z :  z;
        s[b + 2] = inv ?  y : -y;
        // x unchanged
      }
    }
  }
}

function isGoal(s) {
  for (let i = 0; i < 26; i++) {
    const b  = i << 2;
    const pi = posIdx(s[b], s[b + 1], s[b + 2]);
    if (solvedLookup[pi] !== s[b + 3]) return false;
  }
  return true;
}

function dfs(s, remaining, lastFi, depth) {
  if (isGoal(s)) { solutionDepth = depth; return true; }
  if (remaining === 0) return false;
  for (let mi = 0; mi < MOVE_DEFS.length; mi++) {
    const { face, inv, double, fi } = MOVE_DEFS[mi];
    if (fi === lastFi) continue;                              // same face
    if (OPPOSITE[fi] === lastFi && fi > lastFi) continue;    // commuting opposite
    const next = new Int8Array(s);
    applyMove(next, face, inv, double);
    moveStack[depth] = mi;
    if (dfs(next, remaining - 1, fi, depth + 1)) return true;
  }
  return false;
}

function solve(startState) {
  if (isGoal(startState)) return [];
  for (let maxDepth = 1; maxDepth <= 7; maxDepth++) {
    if (dfs(new Int8Array(startState), maxDepth, -1, 0)) {
      return Array.from({ length: solutionDepth }, (_, i) => MOVE_DEFS[moveStack[i]].label);
    }
  }
  return null;
}

self.onmessage = ({ data }) => {
  const { startState, solvedState } = data;

  // Build lookup: posIdx → colorIdx
  solvedLookup = new Int8Array(27).fill(-1);
  for (let i = 0; i < 26; i++) {
    const b  = i << 2;
    const pi = posIdx(solvedState[b], solvedState[b + 1], solvedState[b + 2]);
    solvedLookup[pi] = solvedState[b + 3];
  }

  const moves = solve(startState);
  self.postMessage({ moves });
};
