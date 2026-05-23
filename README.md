# Rubik's Tetris Solver

A web-based solver for the [Rubik's Tetris](https://rubiks.com) cube - a 3x3 Rubik's Cube where the goal is to form six classic Tetrimino shapes (one per face) rather than solid-colour faces.

## 1. Running

Serve the project root over HTTP (required for ES module imports and `fetch`):

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Or use any static file server (`npx serve .`, VS Code Live Server, etc.).

## 2. How to use

| Action | What to do |
|--------|-----------|
| **Rotate the cube** | Click and drag in the 3D viewport |
| **Paint a cubie** | Click a cubie to select it (wireframe highlight), then click a color swatch |
| **Scramble** | Applies 6 random moves |
| **Reset** | Restores the solved state from `configs/tetris.json` |
| **Solve** | Runs IDA* (up to 8 moves deep) and shows the move sequence |
| **Step through solution** | Use Prev / Next buttons |

> **Solver note:** the current solver finds optimal solutions up to 8 moves. It works best after using the Scramble button. For deeper scrambles, a two-phase solver will be added.

## 3. Cube notation

Standard Rubik's cube face notation is used:

| Letter | Face |
|--------|------|
| `U` | Up (top) |
| `D` | Down (bottom) |
| `F` | Front |
| `B` | Back |
| `L` | Left |
| `R` | Right |

`F` = 90° clockwise, `F'` = counter-clockwise, `F2` = 180°.

## 4. Config format

Puzzle definitions live in `configs/`. Each JSON file describes the **solved state** of one cube variant using piece positions as keys — no orientation ambiguity since center colors define which face is which.

```json
{
  "centers": { "U": "purple", "D": "black", "F": "green", "B": "red", "L": "orange", "R": "yellow" },
  "edges":   { "UF": "white", "UR": "purple", ... },
  "corners": { "UFR": "purple", "UFL": "green", ... }
}
```

**Key naming:** combine the face initials the piece touches — `UFR` is the corner between Up, Front, and Right faces. Order: U/D first, then F/B, then R/L.

**Constraint:** every cubie is mono-coloured (the physical puzzle has the same colour on all stickers of a given piece), so each entry is a single colour string.

## 5. Project structure

```
rubicks-tetris/
├── configs/
│   └── tetris.json      # Solved-state definition for the Rubik's Tetris
├── index.html
├── style.css
├── main.js              # Three.js rendering + IDA* solver
└── README.md
```
