# Game balance

Where every number that matters lives, what it is now, what it was, and what a
logged run says about it. Constants are named so they can be grepped.

Measured with the `?dev` economy log (`src/systems/EconLog.js`), which writes one
JSON line per round to `logs/econ.log` via a dev-server endpoint
(`vite.config.js`). Recorded runs land beside it as `logs/run-<timestamp>.json`
(`src/systems/RunRecorder.js`); `?dev&replay` plays back the newest.

---

## The economy

### Energy cap — `src/Mana.js`

```
cap = boardCells × CAP_PER_CELL + level × CAP_PER_LEVEL
CAP_PER_CELL  = 0.25
CAP_PER_LEVEL = 25
```

| Lots (board) | Cells | Cap at that board's first level |
|---|---|---|
| 5 (start) | 625 | 181 |
| 7 (level 4) | 1225 | 406 |
| 9 (level 8) | 2025 | 706 |
| 11 (level 12, max) | 3025 | 1056 |

The board opens two lots per boss round (every 4th level) and maxes at 11 lots,
i.e. **level 12**. Past that only the level term grows the cap, which is why it
exists — without it the ceiling froze for the rest of the run.

**Previously:** `150 + grey blocks standing`. Farmable and enormous — height
counted, so five floors on one cell raised the cap as much as five separate
walls, and a well-built full board reached ~12,000 against tiles costing tens. It
also *fell* when creeps took a wall, clamping away energy already banked.

### Prices — `src/systems/tileCost.js`

```
price  = base × (1 + max(0, level - COST_GRACE_LEVELS) × rate) × Buffs.buildCost
floor  = half the tile price               (FLOOR_DISCOUNT   = 0.5)
refund = floor × floors × 0.5 on demolish  (DEMOLISH_REFUND  = 0.5)
reroll = the wall curve off a base of 5    (REROLL_BASE_COST = 5)

WALL_BASE_COST      = 4     UTILITY_BASE_COST   = 8   (generators + turrets)
WALL_COST_PER_LEVEL = 0.2   COST_PER_LEVEL      = 0.4
COST_GRACE_LEVELS   = 1
```

Everything is one curve, so nothing can drift from anything else. Demolishing
pays back half of what a tower's floors cost - priced off the FLOOR price times
its height, so a tall tower refunds more than a fresh one, and the round trip
always loses. Rerolling the tray climbs at the wall rate (5 / 9 / 14 / 24 at
levels 1 / 5 / 10 / 20) rather than staying small change late.

| Level | 1 | 2 | 3 | 5 | 10 | 20 | 30 |
|---|---|---|---|---|---|---|---|
| Wall | 4 | 4 | 5 | 6 | 10 | 18 | 26 |
| Turret / generator | 8 | 8 | 11 | 18 | 34 | 66 | 98 |
| Reroll the tray | 5 | 5 | 6 | 9 | 14 | 24 | 34 |

Walls climb at half the rate: they are the bulk purchase, placed a dozen at a
time and rebuilt after every wave, so pricing them like an investment tile made
the opening about affording a maze rather than designing one.

**Previously, in order:**

1. **Per-placement escalation** — `base × 1.2^(nth of that type)`, uncapped, and
   the counter only ever rose (rebuilding what creeps destroyed counted). Reached
   256 for a generator that cost 8. Buckets split generators by colour, which
   could never vary.
2. **Saturating** — `M - (M-1) × growth^n`, bending toward 6× base. Fixed the
   runaway but front-loaded the climb: the second generator doubled in price.
3. **Back-loaded** — `1 + (M-1) × (n/N)^2`. Flat early, steep late, still keyed
   on placements.
4. **Exponential by level** — `1.2^level`, then `1.28^level` with a 12× ceiling
   and a linear tail past it. Two regimes and three constants for the sake of a
   cheaper level 2.
5. **Linear by level** — where it is now.

There was also an income multiplier, `× (1 + incomePerSec × 0.02)`, later 0.04.
Removed: it punished you for building well, and pushed a level-5 wall to 42.

### Income — `src/systems/EnergySystem.js`

Two generator types, both ticking every `GEN_INTERVAL = 2` seconds, both scaled
by `PROD_FACTOR = 0.32` (was 0.39) and `Buffs.genRate`.

**Enclosure generators (pink)** — pay for sealed ground:

```
cells × floors × ENCLOSURE_RATE × genRate × supportFactor
ENCLOSURE_RATE = 0.00928
```

Was 0.056. A board sits at ~70% enclosed for most of a run, and at that rate the
whole cap refilled in ~30 seconds of a 70-second round at *every* board size —
the cap scales with cells and so does enclosed area, so the two move together and
one flat rate fixes all of them. At 0.030 it takes 50-60s.

`cells` is the sealed region the generator claims. **One claimant earns per
region** — previously every generator in a region was handed the region's full
cell count, so three of them billed the same ground three times, and the way to
arrange that was to seal three small rings and knock the inner walls down.

**Path generators (blue)** — pay for a linked network, one link each:

```
per generator: area × longestLinkGap × PATH_LINK_RATE × genRate
PATH_LINK_RATE = 0.0582
```

Links form between every same-colour pair within combined reach
(`(a.floors + b.floors) × 2` cells), but a generator is paid for its **longest
link only**. Income is therefore linear in generator count.

**Previously each generator was paid in full for every link**, and links form
between all pairs — so income grew with the *square* of the network: eight
generators earned 19.7/s where two earned 0.7/s, and a logged run had seventeen
of them producing 94% of everything it earned. An intermediate version paid the
longest link plus 15% per extra link, which was still super-linear.

Plus `KING_BONUS = 4` every `GREY_INTERVAL = 5` seconds. Walls generate nothing.

### Support bonuses — `src/systems/EnergySystem.js`

A path generator also trails to any non-wall building within `floors × 2` cells.
Those trails earn nothing; they make the building better, and they **stack**.

```
turret fire rate      × (1 + 0.25 × trails)
enclosure output      × (1 + 0.15 × trails)
shield burn damage    SHIELD_DAMAGE + 1 per trail
barracks garrison     +1 soldier per trail
```

**Previously** a single flag: supported or not, ×1 or ×0.5. The first support
tower was enormous and the second was worth nothing.

That change cut income further than it looks, and quietly. Under the flag, one
trail DOUBLED a generator (0.5 → 1.0). Under the count it took more than three
to get there, and the leftover 0.5 lived on as a `BASE_FACTOR` in front of both
formulas - so every rate in EnergySystem.js meant half what it said. It has been
folded into the base rates (`ENCLOSURE_RATE` 0.030 → 0.015, `fireCooldown` 0.35
→ 0.7), which changed no behaviour and makes the constants mean their own value.

---

## Combat

One rule everywhere: an attack carries a damage number, a thing has hit points,
damage accumulates until it covers them. Overkill carries over to the next block.

### Hit points

| Thing | HP |
|---|---|
| Tower block (any tile, king included) | **3** (`BLOCK_HP`) |
| — grey wall with Reinforced Walls | +1 per card (`Buffs.wallHits`) |
| — any non-wall tile in a shield ring | +1 per ring (`SHIELD_COVER_HP`) |
| Creep, regular | 4 (`hitPoints`) |
| Creep, big | 8 (×2) |
| Creep, giant | 32 (×8) |
| Soldier | 3 (`SOLDIER_HP`) |
| King | `KING_HEALTH` = 5 floors, `KING_MAX_FLOORS` = 9 |

**Previously:** every hit took a floor (block HP was effectively 1), and melee
creeps kept their own `knocksPerFloor = 3` counter — so a bite that was not the
third one never reached the tile at all, and it sat there unflashed while a creep
visibly chewed on it.

### Damage

| Attacker | Attack | DMG |
|---|---|---|
| Creep (any size) | bite | 1 (`BITE_DAMAGE`) |
| Creep shooter | lobbed block | 2 (`SHOT_DAMAGE`) |
| Creep laser | beam | 2 (`laserDamage`) |
| Creep bomber | dropped bomb | 2 (`BOMB_DAMAGE`) |
| Soldier | melee | 1 (`SOLDIER_DAMAGE`) |
| Creep vs soldier | melee | 1 (`CREEP_DAMAGE`) |
| Shield perimeter | burn on inward crossing | 1 + 1 per support trail |
| King ring | burn on inward crossing | 2 (`KING_RING_DAMAGE`), no charges |
| Wall bite recoil | costs the creep | 2 HP (`WALL_BITE`) per floor broken |

Each gun's damage and cooldown is written down on its own. They currently all
land on **1.43 damage/second unsupported**, but nothing enforces that any more —
the cooldowns used to be derived from the peg, which meant a gun could not be
tuned without moving the other two:

| Gun | DMG | Cooldown | Notes |
|---|---|---|---|
| Peg | 1 | 0.70s (`fireCooldown`) | travelling projectile |
| Laser | 2 | 1.40s | hitscan |
| Mortar | 4 | 2.80s | AoE, `mortarRadius` 4 cells |

Mortar was 8 dmg / 2.8s — same DPS, but one shell every 2.8s meant it spent most
of a fight doing nothing and lost a whole cycle to a creep that walked out of the
blast.

Turret range: `turretRangeCells(floors) = floors × 1.5` — 1.5 cells at one floor
up to 9 at the six-floor cap (`MAX_FLOORS` 5 + `TURRET_EXTRA_FLOORS` 1). One
function, shared by the three guns, the range ring and the AO coverage disc, so a
ring can never disagree with the gun that drew it. Was `floors × 2 + 1`.

### Per-level ramps — `src/Creeps.js`

Damage **never** ramps. Level buys count, health and swing rate:

```
creeps in a wave = creepsBase + creepsPerWave × level     (8 + 3n)
creep HP         = base × (1 + hpPerWave × level)         (+16%/level)
swing rate       = base × (1 + attackPerWave × level)     (+14%/level)
knockInterval    = 0.45s between bites at level 1
```

Big and giant creeps swing at 2× on top of that. A bigger hit multiplied against
the swing ramp turned a late big into a five-storey deletion in one blow, which
is why size buys speed rather than damage.

Ranged creeps do **not** ramp their fire rate — `shootInterval` and
`bombInterval` are fixed, so they stay as dangerous at level 20 as at level 5
apart from having more HP.

### Wave shape — `src/systems/WaveClock.js`, `src/Creeps.js`

```
wavePeriod = 70s   (50s build, then waveActive = 20s of spawning)
```

A wave splits into clumps of ~4-9 (`SWARM_SIZE`, minimum `MIN_SWARMS` = 2), one
creep every `SWARM_GAP` = 0.11s within a clump, clumps spread over 85% of the
attack window. Each clump enters within ±2.5 cells of one point on **one** edge —
the second front every third wave is gone, because a fight on two edges of this
board cannot be watched.

Boss rounds are every 4th level. Their giants are **dealt across the clumps**
(one riding in with each) rather than all spawning on the first frame.

---

### Board and pool limits

A lot is 5×5 cells; a cell is 2 world units. The 13-lot grid is always built -
the arrays, the occupancy mask and the flow field are sized once at startup and
cannot grow - and `MAX_VISIBLE_LOTS = 11` keeps the outer ring permanently shut
as margin, so creeps always have somewhere to spawn and walk in from.

| | Lots | Cells | World |
|---|---|---|---|
| Start | 5 | 25×25 (625) | 50×50 |
| After boss 1 (L4) | 7 | 35×35 (1,225) | 70×70 |
| After boss 2 (L8) | 9 | 45×45 (2,025) | 90×90 |
| Max play (L12) | 11 | 55×55 (3,025) | 110×110 |
| Built grid | 13 | 65×65 (4,225) | 130×130 |

`poolSize = 900` pre-made towers is the cap on tiles STANDING at once - one pool
entry is one tile, so a wall tetromino costs one entry and covers four cells.
Filling the whole 11-lot board with tetrominoes takes about 760, so the cap is
not reachable in practice today. It would be on a bigger board, and the failure
is silent: `placeTileFree` returns null and the palette restores the tile
without charging.

Growing the board is cheap in memory (900 towers is ~0.5MB of matrices and
colours; the flow arrays are kilobytes) but not in time - `updateShieldCover` is
O(shields × towers) on every tower change, and `towerAt` walks every tower per
creep per step.

---

## What a logged run says

18 rounds, levels 1-17, with the constants as of 2026-09-01.

| Levels | Waste | Behaviour |
|---|---|---|
| 1-5 | 0-33% | scrappy, spending everything, hits zero |
| **6-13** | **62%** | pinned at the cap, never dropped below 385 |
| 14-17 | 0-7% | "recovers" only because income collapsed with the city |

**49% of everything produced across the run was thrown away.**

The cap refills in **17-25 seconds of a 70-second round** through the whole
middle game. It should take most of a round.

Two findings that matter more than the rates:

1. **Path generators are 75-96% of income from level 7 onward.** Enclosures keep
   getting broken; path gens sit safe behind walls and keep linking. At levels
   11-13 seventeen path generators produced 94% of everything earned.
2. **The late game is action-limited, not energy-limited.** By level 12+ you
   cannot place walls fast enough to hold the line, enclosures start falling, and
   income collapses with them. Cutting income there makes dying faster; it does
   not make the game harder in an interesting way.

Which points at a **sink rather than a rate cut**: something that converts banked
energy into rebuilt blocks without needing a click per block - a repair action -
would absorb the 5-12 surplus exactly where it piles up and pay out at 12+
exactly where the hands run out. Not built.

### What was changed in response

Three cuts, all keeping the formulas single expressions - no ceilings, no
piecewise regimes, nothing that changes shape partway through a run:

| Change | From | To |
|---|---|---|
| `ENCLOSURE_RATE` | 0.056 | 0.030 (now written 0.015, see above) |
| Path generator links paid | all of them, +15% each | longest one only |
| `PROD_FACTOR` | 0.39 | 0.32 |

The path change is the structural one: it takes network income from `O(n²)` to
`O(n)`. The other two are flat rate cuts. Needs another logged run to confirm the
mid game now has decisions in it rather than a full bar.
