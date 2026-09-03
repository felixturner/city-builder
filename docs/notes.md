# Architecture notes

The vocabulary, who owns what, and the traps. The rules of the game are in
`gameplay.md`, what each tile does is in `tiles.md`, the numbers are in
`game-balance.md`, and recording a run is in `replay.md`.

## Vocabulary

### The board

- **City** - the entire grid, 11x11 lots
- **Lot** - a 10x10 grid of cells holding towers, separated by 3-cell roads
- **Cell** - a 1x1 grid unit, the size of the smallest block
- **Tower** - a building/stack made of several blocks (class: `Tower`)
- **Block** - one mesh instance within a tower
- **Floor** - one level of a tower, rendered as a block instance

### Tile types (`TopType` in `src/blockTypes.js`)

`WALL` - `ENC_GEN` - `SUPPORT` - `RIFLE` - `LASER` - `MORTAR` - `BARRACKS` -
`SHIELD` - `KING`

**ENC_GEN** and **SUPPORT** are the two kinds of generator: `isGenerator`
matches either, `isEncGen` and `isSupport` pick one. **isWall** is everything
that is none of the above.

A tile's ROLE and the mesh it WEARS are separate - several roles share a roof
geometry (`ROOF_GEOM`), so you cannot infer one from the other.

### Colour fields on a tower

**accentIndex** is an index into `City.accentColors`, not a colour. The colours
themselves are **blockColor**, **roofColor**, and **pulseColor** / **pulses**.

## Ownership

Most bugs here have come from two copies of the same idea drifting apart. Each of
these is meant to be the *only* place its thing is decided.

| owns | module |
|---|---|
| wave schedule — timing, wave index, boss rounds, spawn edges | `systems/WaveClock.js` |
| what spawns, and creep behaviour | `Creeps.js` |
| what a wave *sounds* like | `systems/WaveAudio.js` |
| creep pathing | `systems/FlowField.js` |
| sealed regions and the floor glow | `systems/Enclosure.js` |
| terrain (rocks) | `systems/Rocks.js` |
| prices — tiles *and* floors | `systems/tileCost.js` |
| the tile bag | `systems/TileBag.js` |
| FX material conventions + the glow layer | `fx.js` |
| running costs / brownout — **disabled**, see below | `systems/Upkeep.js` |
| every colour in the game | `palette.js` |
| the king's beam, ring, marker, siren, death pulse | `systems/KingVisuals.js` |
| the cell grid, lot grid, dots, board outline | `systems/BoardGrid.js` |
| pause/fast-forward chips, game-over panel, menu | `systems/DemoUI.js` |
| creep meshes and materials | `systems/creepAssets.js` |

`Demo` wires everything together and owns the frame loop. `City` owns the grid,
the tower pool and the BatchedMesh.

## Things that bite

**Interval vs rate.** Creep count is `window / gap`, so ramping the *gap*
linearly makes the *count* hyperbolic — that produced a cliff at level 7 and,
separately, a giant four times too strong. Ramp the number you actually care
about. Anything named `...Rate` means bigger = faster.

**Two matrix paths.** `City.updateTowerMatrices` (one tower) and
`City.updateMatrices` (bulk) carry separate copies of the per-tower logic. A
guard added to one and not the other looks fixed until something rebuilds the
whole board.

**Neither `node --check` nor `vite build` catches a missing import.** Both are
happy with a bare identifier; it throws only when the line runs. A green build
is not verification - four separate crashes came from this while moving code
between files, each found by loading the page rather than by any tool.

**GSAP `kill()` freezes a tween mid-flight** — it does not finish it, and
`onComplete` never fires. Use `progress(1, true)` then kill, or state set in
`onComplete` stays stuck forever. See `Tower.settleRoof`.

**Deferred callbacks outlive their subject.** A tower destroyed during a 100ms
animation goes back to the pool and is handed out again immediately, so the
callback lands on a different tile. Re-check before applying.

**Animations may be cut short; state may never wait for one.** GSAP runs on the
wall clock, so anything a tween decides makes the frame rate part of the
simulation - and a fast-forwarded replay reaches the same tween sixteen times
further into the game. Five separate divergences came from this. `docs/replay.md`
has the list.

**Never decide anything from a mesh.** A mesh is an interpolated picture of the
state, mid-animation as often as not. Line of sight raycast the tower
BatchedMesh in two files, which made "can this gun see that creep" depend on
where a build tween had got to. Read floor counts and footprints instead.

**Optional chaining skips its arguments.** `econ?.earnFrom(src, mana.add(amt))`
does not call `mana.add` when `econ` is undefined - and `econ` only exists under
`?dev`, so this stopped the entire city earning in a normal game while every dev
session looked fine. Never put a side effect in an optional-chained call's
arguments.

**`?dev` changes behaviour.** The run recorder and the econ log exist only with
it. A bug behind `run?.` or `econ?.` cannot show up in a session that has them.

**Palette values are hex numbers**, which is right for `new Color(x)`,
GridHelper and setClearColor - and wrong for anything reading `.r/.g/.b`.
`lerp(WHITE, t)` on a number yields NaN, which renders black. Make a Color
first.

## Rendering

- **One BatchedMesh** holds every tower. Blocks are instances, not objects.
- **Glow is opt-in by layer**, not brightness — `glow(obj)` in `fx.js`. Those
  objects render a second time into their own target and only that is bloomed.
  A thing glows because it was put on the layer; material brightness does nothing.
- **Coloured FX** (trails, rings, beams) all go through `fxMaterial()`: additive,
  a flat "up" normal so AO skips them, depth-tested. Only walls and blocks take AO.
- **MRT attachments are matched by `texture.name`.** An unnamed one matches
  nothing, the struct comes out empty, and the whole command buffer is discarded —
  a silent, total failure. See `PostFX.glowTarget`.
- **Winding decides back-face culling**, not the normal attribute. Ground-plane
  triangles must be wound to face up or they vanish under the camera.

## Board

Built at 13×13 lots; `visibleLots` (5 → 11) is what's in play. The grid, pool and
BatchedMesh are all sized once at init, so the board can't actually resize — the
full one exists from the start and an active region opens over it. The outermost
ring is never opened: it's the margin creeps spawn into.

## Upkeep is disabled

`Upkeep.js` is complete but off (`ENABLED = false`). It deadlocks: browning out
by distance from the king switches off *generators*, which makes the deficit
worse, and income can never recover. Re-enabling needs consumers-only shutdown
plus a floor income. The diagnosis is in the file header.

## Assets

- `assets/` is source; `public/assets/` is served. Both copies need updating.
- **`public/assets/sfx/incoming/` is deliberately untracked** — ~19MB of raw
  source audio (wavs, unused mp3s) staged for auditioning. It sits under
  `public/`, so committing it would both bloat the history permanently and ship
  every byte to the live site. Copy a file out to `sfx/` when you actually use it.
- Sound names resolve **voices → groups → files**, in that order. A voice alias
  shadows a file of the same name permanently.
- `vite.config.js` full-reloads on save, gated to real source files so editing
  docs doesn't throw away a run.
