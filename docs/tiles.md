# Tiles

Reference for the tiles the palette generates (`TilePalette.randomTile()`), their
shapes, and generation odds. All placeable tiles are **rectangular** — the curved
`Quart` (quarter-circle) and the `Tri` (triangle) tops still exist in `blocks.glb`
but are no longer generated.

A tile carries four things: a **footprint** (w×h cells), a **top type** (its
shape/role), a **colorIndex** (one of 3 accent colours, used by generators), and a
**topColorIndex** (one of 5 grey roof colours, used by plain greys).

---

## Top types

| Type | Shape (top-down) | Role | Colour | Allowed footprints |
|------|------------------|------|--------|--------------------|
| **Square** | plain rect | grey wall / filler — forms enclosures | grey roof (1 of 5) | any |
| **Hole** (`ADJ_GENERATOR`) | rect with a circular hole | adjacency generator (energy when next to same) | accent (1 of 3) | squares only (1×1, 2×2, 3×3) |
| **Cross** (`PATH_GENERATOR`) | rect with an inset plus | path generator (energy via colour trails) | accent (1 of 3) | squares only |
| **Peg turret** (`PEG_TURRET`) | rect + raised disc (▲ icon) | bullet turret | grey body, accent laser | 1×1 only |
| **Divot turret** (`DIVOT_TURRET`) | rect + recessed dimple (▲ icon) | laser turret | grey body, accent laser | 1×1 only |

Constraints enforced in generation:
- **Generators** (Hole, Cross) only spawn on **square** footprints.
- **Turrets** (Peg, Divot) only spawn on **1×1**.
- **Non-square** footprints are **always plain Square** (grey).

---

## Footprint generation

`randomTile()` first rolls a footprint:

- **55%** square → of those: **55%** 1×1, **35%** 2×2, **10%** 3×3
- **45%** non-square → long side is **70%** length-2, **30%** length-3; orientation is a 50/50 coin flip

| Footprint | Chance |
|-----------|-------:|
| 1×1 | 30.25% |
| 2×2 | 19.25% |
| 3×3 | 5.5% |
| 1×2 / 2×1 (combined) | 31.5% (15.75% each) |
| 1×3 / 3×1 (combined) | 13.5% (6.75% each) |

---

## Type, given the footprint

Once the footprint is set, the top type is picked **uniformly** from the types
allowed for that footprint:

| Footprint | Candidate types | Each |
|-----------|-----------------|-----:|
| 1×1 | Square, Hole, Cross, Peg, Divot (5) | 20% |
| 2×2 / 3×3 | Square, Hole, Cross (3) | 33.3% |
| any non-square | Square (1) | 100% |

---

## Overall odds per top type

Combining footprint odds with the type-given-footprint odds:

| Type | Overall chance |
|------|---------------:|
| **Square** (grey) | **59.3%** |
| **Hole** (adj generator) | **14.3%** |
| **Cross** (path generator) | **14.3%** |
| **Peg turret** | **6.05%** |
| **Divot turret** | **6.05%** |

Greys dominate because every non-square is grey and they're also in the square
pools — which fits their role as the wall/enclosure material.

---

## Colour

- **colorIndex** — `randInt(0,2)`, one of 3 accent colours. Drives generator
  matching (same-colour generators chain). Only meaningful for Hole/Cross; turrets
  use it for their laser colour.
- **topColorIndex** — `randInt(0,4)`, one of 5 grey roof colours. Cosmetic; only
  shown on plain Square tops.

## Rotation

Non-square tiles can be rotated 90° while dragging (`R` key). Since all shapes are
now rectangular (symmetric under the placement), rotation just swaps the footprint
dimensions — no special-case geometry handling.
