# Gameplay — current rules

What the game actually does today. Design ideas and unbuilt directions live in
`gameplay-ideas.md` and `depth-ideas.md`.

## Goal

Keep the **king** alive. It sits at the centre of the board, always yellow, under
a vertical beam with a spinning marker over it. Creeps knock floors off whatever
they reach; when the king's last floor goes, the run ends. You cannot build the
king taller — its height *is* its health.

**Score = seconds survived.** The clock stops the moment the king dies. Best
score persists in localStorage.

## Round structure

- **80s cycle: 60s to build, then 20s of creeps.** Build comes first, including
  on the very first cycle — there is no grace period, and every round is the
  same shape.
- **Level** = wave number + 1, shown in the HUD.
- Every 4th wave is a **boss round** (levels 4, 8, 12…): the ordinary wave plus
  *n* giants, all from one side.
- A round ends when the last creep of it dies, not when spawning stops. Overrun
  eats into your build time.
- Each wave commits to **1–2 board edges** (one only, before level 3). Ground
  arrows just outside your walls pulse during the countdown and hold steady while
  the wave is on the board.

**Clearing a boss round**, in order: 2s quiet → the board opens a ring (1.2s) →
1.5s → pick 1 of 4 upgrade cards.

## The board

Built at 13×13 lots, but only part is in play:

| | |
|---|---|
| **bounds** | where you can build. Starts **5×5**, +2 lots per boss cleared, up to 11×11 |
| **outer field** | one lot of apron, 20% darker. Creeps walk it; you can't build on it |
| beyond | darker again, out of the game |

Creeps spawn one lot outside the bounds, so the walk-in never gets longer as the
board grows.

**Rocks** are scattered across the whole eventual play area at the start —
indestructible terrain that blocks movement and placement and can seal an
enclosure. Nothing targets them. Ones in unopened rings are switched off until
their ring opens.

## Resources

| | start | used for | comes from |
|---|---|---|---|
| **Energy** | 100 / 150 | placing tiles, adding floors | generators + a king trickle |
| **Ammo** | 30 / 50 | every turret shot | creep drops (20% chance, 8 each) |

Energy cap = 150 + population (floors across grey walls) + upgrades.

## Building

A tray of **4 tiles** drawn from a shuffled **36-tile bag** — no replacement, so
no long droughts. Drag onto the grid; `R` or the on-screen button rotates.

One price function covers both placing and growing:

```
price = base × growth^(that type already placed) × (1 + income/sec × 0.02)
```

- **base**: wall **4**, everything else **8**
- **growth**: wall 1.01, everything else **1.2**
- **adding a floor costs half** the tile price. Max **5 floors**
- **reroll the tray** 5 energy; long-press or right-click one slot to discard it
- **demolish** with right-click

## Tiles

Bag composition: **wall 24** (6 shapes × 4), path gen 3, enclosure gen 2,
turrets 1 each, barracks 2, shield 2.

- **Wall** (tetromino, 4 cells) — blocks creeps and *reroutes* them. They path
  around walls and only smash through when there's no way past.
- **Path generator** (support tower) — links to same-colour path gens within
  `(a.floors + b.floors) × 2` cells and earns from trail length. Its trail
  reaching a turret, area generator or shield brings that building to **full
  speed**; anything unsupported runs at **half**.
- **Enclosure generator** — claims a sealed region and earns from its area.
- **Turrets** — peg (fast, 1 damage, 0.25 ammo), laser (2 damage, 0.5), mortar
  (8 damage, AoE, arcs over walls, 1.0). Range `floors × 2 + 1` cells. All need
  line of sight.
- **Barracks** — raises soldiers that chase and fight creeps. A new floor raises
  its soldier immediately.
- **Shield** — burns creeps crossing its ring. Radius `floors × 2 + 1` cells,
  5 charges per floor, then it goes dark.

## Creeps

They follow a flow field to the king. If the king is walled off from them, half
push for it anyway and smash through; the rest divert to the nearest generator.
Steps are picked at random among the neighbours that get them closer, plus a 12%
misstep, so they spread into staircases rather than filing up the centre lines.
They queue rather than stack — a creep won't enter a cell another is walking into.

**Count per level is a straight line: 8 at level 1, +7 each level, uncapped.**
It arrives in clumps of 4–9 from one point on an edge, spread across the window.

| | health | swing | move | floors/hit |
|---|---|---|---|---|
| normal | 7 | 1× | 3.3 cells/s | 1 |
| big | ×2 | 2× faster | 3.3 cells/s | 1 |
| giant | ×8 | 2× faster | 1.9 cells/s | 1 |

Per level, **+16% health and +14% swing rate** — both additive off the base,
uncapped. Nothing else scales.

- A floor takes 3 knocks. Breaking one **costs the creep 2 health**, so an
  undefended wall still charges an entry fee.
- Types unlock by level: **big** at 2, **bomber** at 3 (flies, crosses
  diagonally), **shooter** and **laser** at 4 — they stop at range, need line of
  sight, and burn out after 12 shots.
- Giants always beeline the king and ignore the maze.

## Reading the board

Both build-phase only; toggle under **View** in the GUI.

- **Creep flow** — orange arrows on every routable cell. Full orange flows to the
  king, dark brown means the king is sealed off from there and creeps will divert
  to a generator. This is the maze you're authoring.
- **Creep path** — a single traced line from the next wave's entry side.

## Loot crates

Scattered across the whole eventual play area, switched on as their ring opens.
**Wall one in** — seal its cell inside a closed region — and it bursts for
`20 × level` in energy or ammo.
