# Gameplay — current rules

What the game actually does today. Design ideas and unbuilt directions live in
`gameplay-ideas.md`.

## Goal

Keep the **king** alive. It sits at the centre of the board under a vertical
beam of light. Creeps knock floors off whatever they reach; when the king's last
floor goes, the run ends.

**Score = seconds survived.** The clock stops the moment the king dies. Best
score persists in localStorage.

## Round structure

- **80s cycle: 60s to build, then 20s of creeps.** Build comes first, including
  on the very first cycle - there is no separate grace period, and every round
  has the same shape.
- **Level** = wave number + 1, shown in the HUD.
- Every 4th wave is a **boss round** (levels 4, 8, 12…): a group of giants plus
  shooters, all from one side. Clearing one pays an upgrade card — pick 1 of 4.
- A round ends when the last creep of it dies, not when spawning stops. Overrun
  eats into your build time.
- Each wave commits to **1–2 board edges**. Screen-edge triangles flash during
  the countdown and hold steady while the wave is on the board.

## Resources

| | start | used for | comes from |
|---|---|---|---|
| **Energy** | 80 / 100 | placing tiles, adding floors | generators + a king trickle |
| **Ammo** | 30 / 50 | every turret shot | creep drops (20% chance, 8 each) |

Energy cap = 100 + population (total floors across grey walls) + upgrades.

## Building

A tray of **4 tiles**, drawn from a shuffled **36-tile bag** (no replacement, so
no long droughts). Drag a tile onto the grid; `R` or the on-screen button rotates
it. Slots refill on a timer.

- **Tile cost:** wall 4, everything else 8. Rises 20% per same-type tile already
  placed (walls only 1%), and 2% per point of income per second.
- **Add a floor:** click a tower. 1 energy per cell for walls, 2 for everything
  else. Max **5 floors**.
- **Demolish:** right-click a tower.
- **Reroll the whole tray:** 5 energy. Long-press or right-click one slot to
  discard just that tile.

## Tiles

- **Wall** (tetromino, 4 cells) — blocks creeps and *reroutes* them. Creeps path
  around walls and only smash through when there's no way past.
- **Path generator** (support tower) — links to same-colour path gens within
  `(a.floors + b.floors) × 2` cells and earns from trail length. Its trail also
  reaching a turret, area generator or shield brings that building to **full
  speed**; anything unsupported runs at **half**.
- **Enclosure generator** — claims a sealed region and earns from its area.
- **Turrets** — peg (fast, 0.25 ammo/shot), laser (0.5), mortar (1.0, AoE and
  arcs over walls). Range = `floors × 2 + 1` cells.
- **Barracks** — raises soldiers that chase and fight creeps.
- **Shield** — burns creeps crossing its ring. Radius `floors × 2 + 1` cells,
  5 charges per floor, then it goes dark.

## Reading the board

Two overlays show what creeps are about to do, both during the build phase only
(once creeps are on the board they are their own visualisation). Toggle either
under **View** in the GUI.

- **Creep flow** — dark orange arrows across every routable cell, showing where
  a creep standing there would walk. This is the maze you are authoring: place a
  wall and watch the field bend around it.
- **Creep path** — a single traced line from the next wave's entry side, the one
  journey actually about to happen.

## Creeps

They follow a flow field to the king; if the king is walled off from them, they
head for the nearest generator instead, and attack whatever stands in the way.
Their step is picked at random among the neighbours that get them closer, plus
an occasional misstep, so they spread into staircases rather than filing up the
board's centre lines.

- **7 hits to kill** (big ×2, giants ×10), **+16% health and +14% damage per
  wave**, uncapped.
- Types unlock by level: **big** at 2, **bomber** at 3 (flies over walls),
  **shooter** and **laser** at 4 (stop at range and fire on towers).
- Roughly half of them ignore generators and push for the king when it's sealed.

## Loot crates

Crates float around the board. **Wall one in** — seal its cell inside a closed
region — and it bursts for `20 × level` in energy or ammo.
