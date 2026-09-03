# Tiles

Reference for what the palette deals (`TileBag._refill`) and what each tile does.
Rules of play are in `gameplay.md`.

There are exactly two footprints: **tetromino walls** (4 cells) and **1×1**
utilities. Nothing else — the old rectangles up to 3×3 are gone, so footprint is
no longer an axis of variation on top of height.

## The bag

One shared bag of **36**, drawn without replacement and reshuffled when empty, so
the wait for any particular tile is bounded.

| tile | count | share | avg wait | worst |
|---|---:|---:|---:|---:|
| **Wall** (6 shapes × 4) | 24 | 66.7% | 1.5 | 12 |
| Path generator | 3 | 8.3% | 9.3 | 33 |
| Enclosure generator | 2 | 5.6% | 12.3 | 34 |
| Barracks | 2 | 5.6% | 12.3 | 34 |
| Shield | 2 | 5.6% | 12.3 | 34 |
| Peg / Divot / Mortar turret | 1 each | 2.8% each | 18.5 | 35 |

Waits are in draws: average is `(37)/(n+1)`, worst is `36 − n` — the run you get
if every copy sits at the back of the shuffle.

The wall count must stay a multiple of 6 to keep the six tetromino shapes equally
likely.

## What each does

| tile | `TopType` | role |
|---|---|---|
| **Wall** | `SQUARE` | blocks and *reroutes* creeps; seals enclosures. Grey |
| **Enclosure generator** | `ENC_GEN` | claims a sealed region and earns from its area — the primary income. Yellow |
| **Support generator** | `SUPPORT` | links to other supports within `(a.floors + b.floors) × 2` cells and earns a retainer for its LONGEST link only. Its real job is the trails: one reaching a turret, enclosure gen, barracks or shield makes that building better at what it does, and they stack. Blue |
| **Rifle turret** | `RIFLE` | a travelling pellet, 1 damage |
| **Laser turret** | `LASER` | hitscan, 2 damage at half the rate |
| **Mortar turret** | `MORTAR` | 4 damage, AoE, arcs over walls |
| **Barracks** | `BARRACKS` | raises soldiers. A new floor raises one immediately. Grey (its rooftop soldier identifies it) |
| **Shield** | `SHIELD` | burns creeps crossing its ring inward, 5 charges per floor. Pink |
| **King** | `KING` | the thing you are defending. Earns from sealed ground like an enclosure gen, plus a flat trickle. Pink |

Both generator kinds answer `isGenerator`; `isEncGen` and `isSupport` pick one.
`isWall` is everything that is none of the above.

Turret range is `floors × 1.5` cells and shield radius `floors + 1`. Turrets need
line of sight, tested against floor counts rather than the rendered mesh — roof
decoration never blocks a shot.

## Cost

One function prices placing *and* growing (`systems/tileCost.js`):

```
price = base × (1 + max(0, level - 1) × rate)
```

- **base** — wall **4**, everything else **8**. Flat, not per cell
- **rate** — wall 0.2 a level, everything else 0.4. Walls climb at half speed
  because they are the bulk purchase, rebuilt after every wave
- **adding a floor costs half** that; demolishing refunds half of what the
  floors cost. Max 5 floors, 6 for turrets

## Colour

Every colour in the game lives in `src/palette.js`. On a tower:

- **accentIndex** — which of the three city accents it wears, as an index into
  `City.accentColors`. Fixed per type, so colour identifies the tool. Supports
  only chain to the same colour.
- **blockColor** / **roofColor** — the floor blocks, and the roof on top of them
  (usually the same hue a shade darker).
- **pulseColor** / **pulses** — what a support brightens to while pulsing, and
  whether it does at all. Null and false for everything else.

## Rotation

`R` or the on-screen button, while dragging. Tetrominoes have real rotation
states; shields and barracks are corner shapes whose facing matters. Rotation is
also offset by the camera's nearest quarter turn, so a tile lands looking like its
tray icon whichever way the board is facing.
