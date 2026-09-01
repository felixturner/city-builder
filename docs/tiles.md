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
| **Path generator** | `PATH_GENERATOR` | links to same-colour path gens within `(a.floors + b.floors) × 2` cells, earning from trail length. Its trail reaching a turret, enclosure gen or shield brings that building to full speed — unsupported ones run at half. Blue |
| **Enclosure generator** | `ENCLOSURE_GENERATOR` | claims a sealed region, earns from its area. Pink |
| **Peg turret** | `PEG_TURRET` | fast, 1 damage, 0.25 ammo |
| **Divot turret** | `DIVOT_TURRET` | laser, 2 damage, 0.5 ammo |
| **Mortar turret** | `MORTAR_TURRET` | 8 damage, AoE, arcs over walls, 1.0 ammo |
| **Barracks** | `BARRACKS` | raises soldiers. A new floor raises one immediately. Yellow |
| **Shield** | `SHIELD` | burns creeps crossing its ring, 5 charges per floor. Yellow |

Turret range and shield radius are both `floors × 2 + 1` cells. Turrets need line
of sight. `HOLE` is the king's roof — never dealt.

## Cost

One function prices placing *and* growing (`systems/tileCost.js`):

```
price = base × growth^(that type already placed) × (1 + income/sec × 0.02)
```

- **base** — wall **4**, everything else **8**. Flat, not per cell
- **growth** — wall 1.01, everything else 1.2
- **adding a floor costs half** that. Max 5 floors
- generators bucket by type *and* colour; turrets by type

## Colour

- **colorIndex** — the tile's accent. Fixed per type for generators (blue paths,
  pink enclosures), so colour identifies the tool. Path gens only chain to the
  same colour.
- **topColorIndex** — cosmetic roof shade on walls.

## Rotation

`R` or the on-screen button, while dragging. Tetrominoes have real rotation
states; shields and barracks are corner shapes whose facing matters. Rotation is
also offset by the camera's nearest quarter turn, so a tile lands looking like its
tray icon whichever way the board is facing.
