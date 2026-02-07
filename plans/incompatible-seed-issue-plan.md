# WFC Corner Conflict Resolution Plan

## Prerequisites: Global Seeded RNG

Before fixing the seed conflict issue, add deterministic map generation:

### 1. Create `src/SeededRandom.js`
```javascript
let rng = Math.random
let currentSeed = null

export function setSeed(seed) {
  currentSeed = seed
  if (seed === null || seed === 0) {
    rng = Math.random
  } else {
    let s = seed
    rng = () => {
      s |= 0
      s = s + 0x6D2B79F5 | 0
      let t = Math.imul(s ^ s >>> 15, 1 | s)
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
      return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
  }
  console.log(`%c[SEED] ${seed}`, 'color: cyan; font-weight: bold')
}

export function random() { return rng() }
export function getSeed() { return currentSeed }
```

### 2. Replace all `Math.random()` calls

**Core map generation (required for reproducibility):**

| File | Line | Usage |
|------|------|-------|
| `HexWFC.js` | 82 | entropy tie-breaking |
| `WFC.js` | 27 | entropy tie-breaking |
| `Decorations.js` | 189 | tree type A vs B |
| `Decorations.js` | 213 | tree rotation |
| `Decorations.js` | 229 | max buildings count |
| `Decorations.js` | 278 | shuffle candidates |
| `Decorations.js` | 285 | building mesh selection |
| `HexGrid.js` | 448, 451 | water edge seeding |
| `HexGridConnector.js` | 717 | weighted tile selection |

*(Skipping lib/Sounds.js, lib/Debris.js, lib/Trails.js - old unused code)*

### 3. Update noise initialization in `Decorations.js`
```javascript
import { random } from './SeededRandom.js'
// ...
this.noiseA = new FastSimplexNoise({ frequency: 0.05, min: 0, max: 1, random })
this.noiseB = new FastSimplexNoise({ frequency: 0.05, min: 0, max: 1, random })
```

### 4. Call `setSeed()` at app startup
In `main.js` or `Demo.js`, call `setSeed(params.roads.wfcSeed)` before any map generation.

### 5. Remove duplicate seeded RNG from HexWFC.js
Delete `createSeededRNG()` and `this.rng` - no longer needed.

---

## Problem
When expanding the hex map, seeds from multiple neighbor grids can create impossible constraints at "corner" cells - positions adjacent to 2+ seeds that require incompatible edges.

**Example failure:**
- Cell (17,1) needs: SW=road, W=river, NW=grass simultaneously
- No single tile has all three edge types

## Current Behavior
1. Seeds collected from all populated neighbors
2. `filterConflictingSeeds()` removes directly adjacent conflicts
3. WFC runs - if propagation fails, retry with 0 seeds (disconnects grids)

**Gap:** Corner constraints (cells adjacent to seeds but not seeds themselves) aren't validated before WFC runs.

---

## Failure Cases

### Case 1: Single-neighbor edge conflict
```
[0,-1] SEEDS INCOMPATIBLE - propagation failed after seeding
FAILED CELL: (0,-9)
  SE: (1,-8) COAST_B rot=4 → requires coast@0
  SW: (0,-8) ROAD_A rot=5 → requires road@0
Last step allowed: ROAD_A r2 l0, ROAD_A r5 l0, ROAD_B r3 l0...
```
**Analysis:** Source grid (0,0) has coast adjacent to road on its edge. No tile has both coast+road edges. This is a source grid WFC issue - it shouldn't generate incompatible adjacent edge tiles.

### Case 2: Multi-neighbor corner conflict
```
[2,0] SEEDS INCOMPATIBLE - propagation failed after seeding
FAILED CELL: (17,1)
  SW: (17,2) RIVER_CROSSING_B rot=3 → requires road@0
  W: (16,1) RIVER_B rot=3 → requires river@0
  NW: (17,0) RIVER_A rot=3 → requires grass@0
```
**Analysis:** Corner cell needs road+river+grass on 3 edges. No such tile exists.

---

## Solution Options Summary

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A** | Add missing junction tiles in Blender | Clean, seamless | Manual work, many combinations |
| **B** | Seed substitution - swap conflicting seed for alternative | Preserves connectivity | May not find substitutes |
| **C** | Pre-validate corners, remove bad seeds early | Fast, prevents failures | May lose connectivity |
| **D** | Graduated retry - remove specific failed seed | Simple, preserves max seeds | Multiple WFC runs |
| **E** | Corner-first solving | Corners always valid | Need fallback |

---

## Detailed Options

### Option A: Add Missing Junction Tiles
Create new tile types that handle corner cases (e.g., road+river+grass junctions).

**Approach:**
1. When WFC fails, log the exact edge requirements that couldn't be satisfied
2. Collect these "missing combinations" over time
3. Design tiles in Blender to fill gaps

**Pros:** Clean solution, tiles seamlessly connect
**Cons:** Many possible combinations, requires manual tile creation, may never be complete

---

### Option B: Seed Substitution (User's Suggestion #2)
When a corner fails, replace one of the conflicting neighbor seeds with an alternative tile that has the same *external* edges but different *internal* edges.

**Approach:**
1. When propagation fails at cell X, identify the conflicting seeds around X
2. For each conflicting seed, find alternative tiles that:
   - Match the seed's edges facing its OWN source grid (preserve connectivity)
   - Have different edges facing the new grid (resolve conflict)
3. Replace the seed and retry WFC

**Example:**
- Seed at (17,2) is RIVER_CROSSING_B facing road toward (17,1)
- Find alternative: a tile that still connects to its source grid but faces grass toward (17,1)

**Pros:** Preserves connectivity, works with existing tiles
**Cons:** May not always find valid substitutes, complex to implement

---

### Option C: Pre-Validation with Selective Seed Removal
Before running WFC, validate that all corner positions CAN be satisfied.

**Approach:**
1. After collecting seeds, identify all "corner cells" (adjacent to 2+ seeds)
2. For each corner, check if ANY tile type satisfies all neighbor constraints
3. If not, remove the seed that contributes the most conflicts
4. Repeat until all corners are satisfiable

**Pros:** Prevents WFC failures, faster than backtracking
**Cons:** May remove too many seeds, losing connectivity

---

### Option D: Graduated Retry Strategy
Instead of jumping to 0 seeds on failure, try progressively removing problem seeds.

**Approach:**
1. Run WFC with all seeds
2. If fail: use `lastContradiction` to identify which seed caused failure
3. Remove that specific seed, retry
4. Repeat until success or no seeds remain

**Pros:** Simple to implement, preserves maximum connectivity
**Cons:** Multiple WFC runs (slow), doesn't prevent failures

---

### Option E: Corner-First Solving
Solve corner cells first (they have most constraints), then let WFC fill the rest.

**Approach:**
1. Identify corner cells before WFC
2. For each corner, find the single valid tile (if any) and add as seed
3. If no valid tile exists, handle gracefully (Option B/C/D)
4. Run WFC with original seeds + corner solutions

**Pros:** Corners always valid, fast WFC after
**Cons:** Need fallback for unsolvable corners

---

## Implementation Plan

### Step 1: Global Seeded RNG
- Create `SeededRandom.js`
- Replace 9 `Math.random()` calls
- Update noise to use global seed
- Log seed at startup
- **VERIFY**: Same seed → same map (click same grids in same order)

### Step 2: Find a Failure
- Use random seed until we get a seed conflict failure
- Note the seed number from the log

### Step 3: Graduated Retry
- Hardcode the failing seed
- Implement graduated retry (remove only conflicting seeds)
- **VERIFY**: Failure now recovers with minimal breakage

---

### Phase 1 Details: Graduated Retry (Option D)

When WFC fails, remove only the conflicting seeds instead of all seeds.

**In `src/HexGrid.js` (around line 347-360):**

Current behavior:
```javascript
if (!result && seedTiles.length > 0) {
  // Retry with just center grass - BREAKS ALL CONNECTIONS
  solver = new HexWFCSolver(...)
  result = solver.solve([{ x: center, z: center, type: GRASS, ... }])
}
```

New behavior:
```javascript
if (!result && seedTiles.length > 0) {
  // Get the seeds that caused the conflict
  const failedSeeds = getConflictingSeeds(solver.lastContradiction, seedTiles)

  // Remove just those seeds and retry
  const reducedSeeds = seedTiles.filter(s => !failedSeeds.includes(s))

  if (reducedSeeds.length > 0 && reducedSeeds.length < seedTiles.length) {
    solver = new HexWFCSolver(...)
    result = solver.solve(reducedSeeds)
  }

  // Only fall back to 1 seed if graduated retry also fails
  if (!result) {
    solver = new HexWFCSolver(...)
    result = solver.solve([{ x: center, z: center, type: GRASS, ... }])
  }
}
```

**Helper function to identify conflicting seeds:**
```javascript
function getConflictingSeeds(contradiction, seeds) {
  if (!contradiction) return []
  const { failedX, failedZ } = contradiction
  // Return seeds adjacent to the failed cell
  return seeds.filter(s => isAdjacent(s.x, s.z, failedX, failedZ))
}
```

### Phase 2: (Future) Pre-validation, Seed Substitution

Defer these until we see how well graduated retry works alone.

---

## Key Files to Modify
- `src/HexGridConnector.js` - Add `validateCornerConstraints()` function
- `src/HexWFC.js` - Return failure info for graduated retry
- `src/HexGrid.js` - Implement retry loop with seed removal
- `src/HexMap.js` - Orchestrate the process

## Existing Utilities to Reuse
- `HexWFCAdjacencyRules.byEdge[type][dir][level]` - O(1) edge compatibility lookup
- `lastContradiction` data - identifies exact failure point
- `rotateHexEdges()` - for finding alternative rotations
- `findCompatibleTiles()` in HexGridConnector.js - finds tiles matching edge constraints

---

## Research References
- [Boris the Brave - WFC Explained](https://www.boristhebrave.com/2020/04/13/wave-function-collapse-explained/) - Backtracking strategies
- [Nested WFC for Large-Scale Generation](https://arxiv.org/pdf/2308.07307) - Sub-grid constraint handling
