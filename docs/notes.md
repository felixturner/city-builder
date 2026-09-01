# Architecture notes

Who owns what, and the traps. Rules of the game are in `gameplay.md`.

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

**`node --check` only checks syntax.** A missing import or a use-before-`const`
is a *runtime* error, so a file can pass and still throw the moment that line
runs. Several bugs this session were exactly that, all from moving code between
files.

**GSAP `kill()` freezes a tween mid-flight** — it does not finish it, and
`onComplete` never fires. Use `progress(1, true)` then kill, or state set in
`onComplete` stays stuck forever. See `Tower.settleRoof`.

**Deferred callbacks outlive their subject.** A tower destroyed during a 100ms
animation goes back to the pool and is handed out again immediately, so the
callback lands on a different tile. Re-check before applying.

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
