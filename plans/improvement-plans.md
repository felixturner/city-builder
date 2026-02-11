# Create 6 WFC Improvement Plan Files

## Context

Joining separate WFC grids is the core unsolved problem. The current system uses fixed cells (read-only neighbor constraints) with a multi-phase replace/drop recovery loop, but grids with 3 populated neighbors (27 fixed cells) still frequently need 20-40 attempts. Edge biasing was tried and reverted — it just moved the problem. We need fundamentally better approaches.

The user wants detailed implementation plans for each of the 6 improvement ideas from `plans/grid-matching.md`, written as separate files in `plans/`.

## Summaries

**Plan 1 — Full Map WFC:** Solve all ~2800 cells (13 grids) in a single WFC pass with no fixed cells. Add a `populateAllGrids()` method to HexMap that collects all cell positions upfront, runs one big solve in the worker, then distributes results to individual grids for rendering. Eliminates the boundary problem entirely but loses incremental expansion and may be slower (~2800 vs 217 cells per solve).

**Plan 2 — Overlap Zones:** Instead of treating neighbor boundary tiles as read-only fixed cells, include 1 ring of neighbor cells as solvable in the new grid's WFC solve. After solving, update changed tiles in the neighbor grids via `replaceTile()`. New `getFixedAndOverlapCells()` splits neighbors into overlap (solvable, ring 1) and fixed (read-only, ring 2). Reduces constraint pressure while keeping incremental expansion.

**Plan 3 — Sub-Complete Tileset Audit:** Write a Node.js audit script (`tools/tileset-audit.js`) that enumerates all edge type+level combinations and checks how many tile states can satisfy each. Reports dead-ends (only 1 compatible tile) and fragile configs (< 5 options). Analysis only — identifies which new transition tiles would guarantee solvability.

**Plan 4 — Driven WFC (Noise):** Use continuous simplex noise fields (water, elevation) to pre-assign tile categories (water/coast/highland/land) per cell before WFC runs. Worker filters possibilities by category during init. Since noise is continuous across grid boundaries, cross-grid constraints are naturally compatible. Needs a new `WorldNoise.js` module.

**Plan 5 — Editable WFC:** Combine with Plan 2's overlap zones but treat previous tiles as soft preferences instead of hard constraints. Add dirty-cell tracking to the solver — prioritize collapsing cells whose previous state was invalidated. 10x weight boost for matching previous tile. Optional early stopping that force-collapses unchanged cells to their previous state.

**Plan 6 — More Retries:** Change `maxRestarts` from 1 to 3 on line 801 of HexMap.js. Gives the solver 3 attempts per Phase 1/2 try instead of 1. Trivial change, marginal improvement — doesn't fix the fundamental constraint problem.

---

## Plan 1: Solve Entire Map in One WFC Pass (`plans/plan-full-map-wfc.md`)

### Context
Eliminate grid boundaries entirely by solving all cells at once. Currently each grid is 217 cells (radius 8). With 13 grids that's ~2800 cells. No fixed cells means no boundary conflicts.

### Critical Files
- `src/HexMap.js` — New `populateAllGrids()` method
- `src/workers/wfc.worker.js` — No changes needed (already handles arbitrary solveCells arrays)
- `src/GUI.js` — Update Build All button to use new method

### Implementation

**Step 1: Add `populateAllGrids(gridCoordsList)` to HexMap (~line 1177)**

```
async populateAllGrids(gridCoordsList) {
  // 1. Create all grids (PLACEHOLDER state) if they don't exist
  for (const [gx, gz] of gridCoordsList) {
    if (!this.grids.has(getGridKey(gx, gz))) {
      await this.createGrid(gx, gz)
    }
  }

  // 2. Collect ALL solve cells across all grids
  const allSolveCells = []
  const gridCenters = []  // track which center belongs to which grid
  for (const [gx, gz] of gridCoordsList) {
    const grid = this.grids.get(getGridKey(gx, gz))
    const center = grid.globalCenterCube
    gridCenters.push({ gx, gz, center })
    const cells = cubeCoordsInRadius(center.q, center.r, center.s, this.hexGridRadius)
    allSolveCells.push(...cells)
  }

  // 3. Include center grid (0,0) cells if already populated — as fixed cells
  //    OR include them in solve cells if we want to re-solve everything
  //    Decision: include (0,0) in the solve for full freedom

  // 4. Deduplicate solve cells (grids may share edge cells? No — hex grids
  //    don't overlap with radius 8. But verify by checking for duplicates)
  const seen = new Set()
  const uniqueSolveCells = allSolveCells.filter(c => {
    const k = cubeKey(c.q, c.r, c.s)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // 5. Seed center with grass + optional water edge
  const initialCollapses = [
    { q: gridCenters[0].center.q, r: gridCenters[0].center.r,
      s: gridCenters[0].center.s, type: TileType.GRASS, rotation: 0, level: 0 }
  ]

  // 6. Run single WFC solve
  const wfcResult = await this.solveWfcAsync(uniqueSolveCells, [], {
    tileTypes: this.getDefaultTileTypes(),
    weights: {},
    maxRestarts: 10,
    initialCollapses,
    seed: getSeed(),
  })

  if (!wfcResult.success) {
    console.log('%c[ALL] WFC FAILED', 'color: red')
    return
  }

  // 7. Distribute results to each grid
  //    For each tile in result, find which grid it belongs to (closest center)
  //    Add to globalCells, then call grid.populateFromCubeResults()
  for (const [gx, gz] of [[0,0], ...gridCoordsList]) {
    const key = getGridKey(gx, gz)
    const grid = this.grids.get(key)
    const center = grid.globalCenterCube

    // Filter tiles belonging to this grid (within radius of its center)
    const gridTiles = wfcResult.tiles.filter(t =>
      cubeDistance(t.q, t.r, t.s, center.q, center.r, center.s) <= this.hexGridRadius
    )

    this.addToGlobalCells(key, gridTiles)
    await grid.populateFromCubeResults(gridTiles, [], center, { animate: false })
    this.createAdjacentPlaceholders(key)
  }
}
```

**Step 2: Update GUI.js Build All button (~line 165)**

Change from `autoExpand` to `populateAllGrids`:
```
gui.add({ buildAll: () => demo.city.populateAllGrids([
  [1,-1],[1,0],[0,1],[-1,0],[-1,1],[1,1],[0,2],[-1,-1],[-2,0],[-2,1],[-2,-1],[0,-1]
]) }, 'buildAll').name('Build All')
```

**Step 3: Handle the center grid (0,0)**

The center grid is already populated during `init()`. Two options:
- **Option A**: Include (0,0) cells in the full solve, clear its existing tiles first. Simpler, fully consistent.
- **Option B**: Keep (0,0) as fixed cells. Reintroduces boundary constraints but only for 1 grid.

Recommend Option A — clear (0,0) and re-solve everything together. Modify `init()` to not populate (0,0) when a Build All will follow, or add a `clearAllGrids()` method.

**Step 4: Incremental expansion after Build All**

After the full solve, clicking a placeholder would need to revert to the current grid-by-grid approach (with fixed cells from the solved map). The full-map solve only applies to the initial Build All.

### Verification
1. Build All with seed 351921 — should complete with 0 replacements, 0 drops
2. All grid boundaries should be perfectly seamless
3. Check solve time in console — should be < 10 seconds for ~2800 cells
4. Clicking placeholders after Build All should still work (grid-by-grid with fixed cells)

### Risks
- 2800-cell solve may be slow in the web worker (test needed)
- Lose per-grid animation (tiles appear all at once or need batched reveal)
- Duplicate cells at grid boundaries need deduplication

---

## Plan 2: Overlap Zones (`plans/plan-overlap-zones.md`)

### Context
Instead of treating neighbor boundary tiles as immutable fixed cells, include 1 ring of neighbor cells inside the new solve region. Those cells become solvable — WFC can change them. After solving, update the changed cells in the neighbor grids.

### Critical Files
- `src/HexMap.js` — Modify `populateGrid()` to expand solve region + update neighbors after solve
- `src/HexGrid.js` — `replaceTile()` already exists for updating individual tiles

### Implementation

**Step 1: Modify `getFixedCellsForRegion` to return overlap cells separately (~line 245)**

Currently returns all neighbor cells as fixed. Split into: overlap cells (within 1 ring) and truly-fixed cells (2+ rings out).

```
getFixedAndOverlapCells(solveCells) {
  const solveSet = new Set(solveCells.map(c => cubeKey(c.q, c.r, c.s)))
  const overlapCells = []   // neighbor cells adjacent to solve region — become solvable
  const fixedCells = []     // cells adjacent to overlap but NOT in solve — stay fixed
  const overlapSet = new Set()
  const fixedMap = new Map()

  // Ring 1: cells adjacent to solve region in globalCells → overlap (solvable)
  for (const { q, r, s } of solveCells) {
    for (const dir of CUBE_DIRS) {
      const nq = q + dir.dq, nr = r + dir.dr, ns = s + dir.ds
      const nKey = cubeKey(nq, nr, ns)
      if (solveSet.has(nKey) || overlapSet.has(nKey)) continue
      const existing = this.globalCells.get(nKey)
      if (existing) {
        overlapCells.push({ q: nq, r: nr, s: ns, ...existing })
        overlapSet.add(nKey)
      }
    }
  }

  // Ring 2: cells adjacent to overlap cells → fixed constraints
  for (const oc of overlapCells) {
    for (const dir of CUBE_DIRS) {
      const nq = oc.q + dir.dq, nr = oc.r + dir.dr, ns = oc.s + dir.ds
      const nKey = cubeKey(nq, nr, ns)
      if (solveSet.has(nKey) || overlapSet.has(nKey) || fixedMap.has(nKey)) continue
      const existing = this.globalCells.get(nKey)
      if (existing) {
        fixedMap.set(nKey, { q: nq, r: nr, s: ns, type: existing.type, rotation: existing.rotation, level: existing.level })
      }
    }
  }

  return { overlapCells, fixedCells: [...fixedMap.values()] }
}
```

**Step 2: Modify `populateGrid` to use overlap (~line 694)**

Replace:
```js
const solveCells = cubeCoordsInRadius(center.q, center.r, center.s, this.hexGridRadius)
let fixedCells = this.getFixedCellsForRegion(solveCells)
```

With:
```js
const coreSolveCells = cubeCoordsInRadius(center.q, center.r, center.s, this.hexGridRadius)
const { overlapCells, fixedCells: outerFixed } = this.getFixedAndOverlapCells(coreSolveCells)

// Overlap cells are added to solveCells (they can be re-solved)
const solveCells = [...coreSolveCells, ...overlapCells.map(c => ({ q: c.q, r: c.r, s: c.s }))]
let fixedCells = outerFixed
```

The worker receives a bigger solveCells array (217 + up to ~54 overlap cells for 3 neighbors) and fewer fixed cells. The overlap cells start uncollapsed — WFC has full freedom to choose their tiles.

**Step 3: After WFC success, update overlap cells in neighbor grids (~line 952)**

After `addToGlobalCells(gridKey, result)`, check which overlap cells changed:

```js
// Update overlap cells in neighbor grids
for (const oc of overlapCells) {
  const key = cubeKey(oc.q, oc.r, oc.s)
  const newTile = result.find(t => t.q === oc.q && t.r === oc.r && t.s === oc.s)
  if (!newTile) continue

  // Check if tile changed
  if (newTile.type === oc.type && newTile.rotation === oc.rotation && newTile.level === oc.level) continue

  // Update globalCells
  const existing = this.globalCells.get(key)
  if (existing) {
    existing.type = newTile.type
    existing.rotation = newTile.rotation
    existing.level = newTile.level

    // Update rendered tile in source grid
    const sourceGrid = this.grids.get(existing.gridKey)
    if (sourceGrid) {
      const localCube = {
        q: oc.q - sourceGrid.globalCenterCube.q,
        r: oc.r - sourceGrid.globalCenterCube.r,
        s: oc.s - sourceGrid.globalCenterCube.s,
      }
      const localOffset = cubeToOffset(localCube.q, localCube.r, localCube.s)
      const gridX = localOffset.col + sourceGrid.gridRadius
      const gridZ = localOffset.row + sourceGrid.gridRadius
      sourceGrid.replaceTile(gridX, gridZ, newTile.type, newTile.rotation, newTile.level)
    }
  }
}
```

Note: This reuses the exact same pattern as `tryReplaceFixedCell` lines 586-598.

**Step 4: Update `addToGlobalCells` to handle overlap**

The overlap cells already exist in `globalCells` with a different `gridKey`. When re-solved, we need to update them but keep the original `gridKey` (the cell still belongs to the original grid for rendering).

Change `addToGlobalCells` to skip cells that already exist (they're overlap cells):
```js
addToGlobalCells(gridKey, tiles) {
  for (const tile of tiles) {
    const key = cubeKey(tile.q, tile.r, tile.s)
    if (this.globalCells.has(key)) {
      // Overlap cell — update in place, keep original gridKey
      const existing = this.globalCells.get(key)
      existing.type = tile.type
      existing.rotation = tile.rotation
      existing.level = tile.level
    } else {
      this.globalCells.set(key, {
        q: tile.q, r: tile.r, s: tile.s,
        type: tile.type, rotation: tile.rotation, level: tile.level,
        gridKey
      })
    }
  }
}
```

**Step 5: Pre-WFC validation adjustments**

The pre-WFC phases (`filterConflictingFixedCells`, `validateFixedCellConflicts`) now operate on `outerFixed` only (fewer cells, further away). Overlap cells don't need validation since they're solvable. This should significantly reduce pre-WFC conflicts too.

### Verification
1. Build All with seed 351921 — grid `[0,-1]` should need fewer/no replacements
2. Neighbor grid edge tiles may change visually — check they still look correct
3. Verify no tile gaps at boundaries (overlap cells get assigned to exactly one grid for rendering)
4. Check that expanding further after overlap zones still works correctly

### Risks
- Overlap cells lose their decorations (trees/buildings) when re-solved — need to re-run decoration pass on affected source grid
- Solve region is larger (~270 cells vs 217) — slightly slower but not significant
- Visual "pop" when neighbor edge tiles change

---

## Plan 3: Sub-Complete Tileset Audit (`plans/plan-sub-complete-tileset.md`)

### Context
A "sub-complete" tileset guarantees that for any valid edge config on one side of a cell, there exists at least one tile that can satisfy it regardless of what the other 5 edges require. This eliminates WFC contradictions entirely. This is an analysis task — write a script to audit the current tileset and identify gaps.

### Critical Files
- New file: `tools/tileset-audit.js` (Node.js script, not part of the app)
- `src/HexTileData.js` — Reference for tile definitions

### Implementation

**Step 1: Create audit script `tools/tileset-audit.js`**

```js
// Import tile data (may need to adjust import path for Node.js)
// Enumerate all possible edge configurations at a boundary

// For each direction (0-5), enumerate all (edgeType, level) pairs that can appear:
// - grass at levels 0, 1, 2
// - road at levels 0, 1, 2
// - river at levels 0, 1, 2
// - ocean at level 0 (water is always level 0)
// - coast at level 0

// For each (edgeType, level) on direction D:
//   Find all tile states where edge D has matching (type, level)
//   For each of those states, check what edges they produce on the OTHER 5 directions
//   The tileset is "sub-complete" for this config if:
//     For every possible (type, level) on each other direction,
//     there exists at least one tile state matching BOTH

// Simplified check (practical):
//   For each (type, level) combo on a boundary direction,
//   how many tile states can satisfy it? If only 1-2, it's fragile.
//   Report all combos with < N compatible states.
```

**Step 2: Report format**

For each edge configuration, report:
- Edge type + level
- Number of compatible tile states (across all 6 rotations)
- Which tile types can match
- Whether it's a dead-end (only 1 option) or fragile (< 5 options)

**Step 3: Identify gap-filling tiles**

Based on the audit, suggest:
- Which edge combos are most constrained
- What new tile types would fill the gaps
- Whether existing tiles could be modified (e.g., adding a new rotation variant)

### Verification
1. Run the audit script: `node tools/tileset-audit.js`
2. Review the output for dead-ends and fragile configs
3. Cross-reference with actual WFC failures (which edge types cause contradictions)

### Risks
- This is analysis only — doesn't change runtime behavior
- New tiles require 3D modeling work in Blender
- Hex grids with 6 edges make sub-completeness harder than square grids

---

## Plan 4: Driven WFC — Noise-Based Pre-Constraints (`plans/plan-driven-wfc.md`)

### Context
Use continuous noise fields to pre-determine what general tile category each cell should have. WFC then only picks among tiles within that category. Since noise is continuous across grid boundaries, cross-grid constraints are naturally compatible.

### Critical Files
- `src/HexMap.js` — Noise generation, category assignment, pass to worker
- `src/workers/wfc.worker.js` — Filter possibilities by category during init
- New: `src/WorldNoise.js` — Noise field module (or add to HexMap)

### Implementation

**Step 1: Design tile categories**

Map each tile type to a category:
```
CATEGORY_LAND   = [GRASS, ROAD_*, RIVER_*, RIVER_CROSSING_*, GRASS_SLOPE_*, GRASS_CLIFF_*, ROAD_SLOPE_*]
CATEGORY_WATER  = [WATER]
CATEGORY_COAST  = [COAST_*]
```

Categories can overlap — coast tiles can appear in both LAND and COAST zones.

**Step 2: Create noise module `src/WorldNoise.js`**

Use simplex/perlin noise (can implement with the seeded RNG, or use a small library). Need two noise fields:

```js
// Water noise: determines ocean vs land
// High values → ocean, medium → coast, low → land
function getWaterNoise(q, r, s) {
  // Convert cube coords to world position for noise sampling
  const offset = cubeToOffset(q, r, s)
  const worldX = offset.col * HEX_WIDTH + (offset.row % 2) * HEX_WIDTH * 0.5
  const worldZ = offset.row * HEX_HEIGHT * 0.75

  // Sample 2D simplex noise at large scale (1 period ≈ 3-4 grids)
  const scale = 0.02  // ~50 cells per period
  return simplex2(worldX * scale, worldZ * scale)
}

// Elevation noise: determines hills/mountains vs flat
function getElevationNoise(q, r, s) {
  // Similar, different frequency/offset
  const scale = 0.03
  return simplex2(worldX * scale + 1000, worldZ * scale + 1000)
}
```

**Step 3: Assign categories per cell in `populateGrid` (~line 694)**

After generating solve cells, compute category for each:

```js
const cellCategories = new Map()  // cubeKey → category string
for (const { q, r, s } of solveCells) {
  const waterNoise = getWaterNoise(q, r, s)
  const elevNoise = getElevationNoise(q, r, s)

  let category
  if (waterNoise > 0.4) category = 'water'
  else if (waterNoise > 0.2) category = 'coast'
  else if (elevNoise > 0.3) category = 'highland'  // prefer slopes/cliffs, higher levels
  else category = 'land'

  cellCategories.set(cubeKey(q, r, s), category)
}
```

**Step 4: Pass categories to worker**

Add to worker options:
```js
const wfcResult = await this.solveWfcAsync(solveCells, activeFixed, {
  ...existingOptions,
  cellCategories: Object.fromEntries(cellCategories),  // serialize Map
})
```

**Step 5: Filter possibilities in worker init (`wfc.worker.js` ~line 77)**

After creating cells with full possibility space, filter by category:

```js
// In init(), after creating all cells:
if (this.options.cellCategories) {
  const categoryTiles = {
    water: new Set([TileType.WATER]),
    coast: new Set([TileType.WATER, TileType.COAST_A, TileType.COAST_B, TileType.COAST_C, TileType.COAST_D, TileType.COAST_E, TileType.GRASS]),
    highland: new Set([TileType.GRASS, TileType.GRASS_SLOPE_HIGH, TileType.GRASS_SLOPE_LOW, TileType.GRASS_CLIFF, TileType.GRASS_CLIFF_C, TileType.GRASS_CLIFF_LOW, TileType.GRASS_CLIFF_LOW_C, TileType.ROAD_A, TileType.ROAD_A_SLOPE_HIGH, TileType.ROAD_A_SLOPE_LOW]),
    land: null,  // no filtering — allow everything
  }

  for (const [key, cell] of this.cells) {
    const category = this.options.cellCategories[key]
    if (!category) continue
    const allowedTypes = categoryTiles[category]
    if (!allowedTypes) continue  // null = allow all

    for (const stateKey of [...cell.possibilities]) {
      const state = HexWFCCell.parseKey(stateKey)
      if (!allowedTypes.has(state.type)) {
        cell.possibilities.delete(stateKey)
      }
    }
  }
}
```

**Step 6: Handle category transitions**

Coast cells need to be able to transition to both water and land. The noise thresholds should create smooth gradients. Edge cells between categories need tiles that bridge both (e.g., COAST tiles bridge water↔land).

**Step 7: Fixed cells override noise**

Fixed cells are not filtered by category — they keep whatever tile they already have. The category only affects new solve cells.

### Verification
1. Build All — check that water clusters on one side, mountains on another
2. Vary noise seed to get different terrain distributions
3. Verify grid boundaries are seamless (noise is continuous)
4. Check that WFC failures are reduced (fewer tile types per cell = easier solve)

### Risks
- Need a simplex noise implementation (can port a small one, ~50 lines)
- Category thresholds need tuning — too strict and WFC can't find solutions, too loose and noise has no effect
- Transition zones (coast) are critical — wrong category assignment causes contradictions
- Doesn't directly fix the fixed cell constraint problem — helps indirectly by reducing tile variety at boundaries

---

## Plan 5: Editable WFC — Soft Constraints (`plans/plan-editable-wfc.md`)

### Context
Instead of hard fixed cells, treat neighbor boundary tiles as soft preferences. Include them in the solve region as solvable cells, but bias WFC to keep them unchanged via a similarity heuristic. Only change them when necessary to avoid contradictions.

### Critical Files
- `src/workers/wfc.worker.js` — Modified solver with dirty tracking + similarity weights
- `src/HexMap.js` — Pass previous tile state to worker, update changed cells after solve

### Implementation

**Step 1: Add "previous state" data to worker**

In `populateGrid`, pass the previous tile states for overlap cells:

```js
// In HexMap.populateGrid:
const previousStates = {}  // cubeKey → { type, rotation, level }
for (const oc of overlapCells) {
  previousStates[cubeKey(oc.q, oc.r, oc.s)] = {
    type: oc.type, rotation: oc.rotation, level: oc.level
  }
}

// Pass to worker:
const wfcResult = await this.solveWfcAsync(solveCells, fixedCells, {
  ...options,
  previousStates,
})
```

**Step 2: Add dirty cell tracking to solver**

In `HexWFCSolver.init()`:

```js
// After creating cells, mark overlap cells and set previous state
this.previousStates = new Map()  // key → stateKey
this.dirtyCells = new Set()  // keys of cells that may need to change

if (this.options.previousStates) {
  for (const [key, prev] of Object.entries(this.options.previousStates)) {
    const prevStateKey = HexWFCCell.stateKey(prev)
    this.previousStates.set(key, prevStateKey)

    const cell = this.cells.get(key)
    if (cell && cell.possibilities.has(prevStateKey)) {
      // Previous state is still valid — not dirty yet
      // Will become dirty if propagation removes it
    } else if (cell) {
      // Previous state already invalid — mark dirty
      this.dirtyCells.add(key)
    }
  }
}
```

**Step 3: Modified `findLowestEntropyCell` — prioritize dirty cells**

```js
findLowestEntropyCell() {
  let minEntropy = Infinity
  let minKey = null
  let hasDirty = false

  for (const [key, cell] of this.cells) {
    if (cell.collapsed || cell.possibilities.size === 0) continue

    const isDirty = this.dirtyCells.has(key)
    const entropy = cell.entropy

    // Dirty cells take priority over clean cells
    if (isDirty && !hasDirty) {
      minEntropy = entropy
      minKey = key
      hasDirty = true
    } else if (isDirty === hasDirty && entropy < minEntropy) {
      minEntropy = entropy
      minKey = key
    }
  }

  return minKey
}
```

**Step 4: Modified `collapse` — similarity weight boost**

In `collapse()`, after computing base weights:

```js
const prevStateKey = this.previousStates?.get(key)
if (prevStateKey) {
  for (let i = 0; i < possArray.length; i++) {
    if (possArray[i] === prevStateKey) {
      weights[i] *= 10  // Strong preference to keep previous tile
    }
  }
}
```

**Step 5: Track dirty state during propagation**

In `propagate()`, after removing possibilities from a neighbor:

```js
if (changed) {
  // Check if previous state was removed — cell becomes dirty
  const prevKey = this.previousStates?.get(nKey)
  if (prevKey && !neighbor.possibilities.has(prevKey)) {
    this.dirtyCells.add(nKey)
  }
  this.propagationStack.push(nKey)
}
```

**Step 6: Early stopping (optional, advanced)**

After all dirty cells are collapsed, check if remaining uncollapsed cells have previous states. If so, collapse them to their previous state directly:

```js
// In solve(), after finding no more dirty cells:
// Collapse remaining cells with previous states to their previous value
for (const [key, prevStateKey] of this.previousStates) {
  const cell = this.cells.get(key)
  if (cell && !cell.collapsed && cell.possibilities.has(prevStateKey)) {
    const state = HexWFCCell.parseKey(prevStateKey)
    cell.collapse(state)
    this.propagationStack.push(key)
    if (!this.propagate()) break  // contradiction from forcing previous state
  }
}
```

### Verification
1. Build All — overlap cells should mostly keep their original tiles
2. Only cells that truly conflict should change
3. Compare replacement/drop counts vs current approach
4. Visual stability: neighbor edges should rarely change

### Risks
- Combines with Plan 2 (overlap zones) — can't use alone, needs overlap cells to be solvable
- 10x similarity boost may be too strong (WFC picks suboptimal tiles to preserve previous state)
- Early stopping + forced collapse can itself cause contradictions
- More complex solver logic, harder to debug

---

## Plan 6: More WFC Retries (`plans/plan-more-retries.md`)

### Context
Currently during Phase 1/2 recovery, each replace/drop attempt runs WFC with `maxRestarts: 1` (one attempt, no retries). The solver restarts with a fresh random state on contradiction, so more restarts = more chances to find a valid arrangement before moving on to the next replacement.

### Critical Files
- `src/HexMap.js` — Change `maxRestarts` in `runWfc` (~line 801)

### Implementation

**Step 1: Increase `maxRestarts` for grids with fixed cells**

In `populateGrid`, the `runWfc` helper (~line 798):

```js
// Current:
maxRestarts: initialFixedCount === 0 ? 10 : 1,

// Change to:
maxRestarts: initialFixedCount === 0 ? 10 : 3,
```

This gives the solver 3 attempts per Phase 1/2 try instead of 1.

**Step 2: Consider different values for Phase 1 vs Phase 2**

Phase 2 (dropping) is more expensive (fewer constraints = bigger search space). Could pass different maxRestarts:

- Phase 1 (replace): `maxRestarts: 3` — trying harder before giving up on a replacement
- Phase 2 (drop): `maxRestarts: 2` — less effort since dropping already simplifies the problem

To implement this, pass `maxRestarts` as a parameter to `runWfc` instead of computing it inside. But the simplest change is just updating the single value on line 801.

### Verification
1. Build All with seed 351921 — check if total attempts/replacements/drops decrease
2. Check solve time — more restarts = potentially slower per attempt
3. Compare multiple seeds to see if the improvement is consistent

### Risks
- More restarts per attempt means slower failure (takes longer to exhaust options)
- Marginal improvement — the fundamental problem is constraint satisfaction, not randomness
- With 3 restarts × 50 replacement attempts = 150 WFC solves worst case (vs current 50)
