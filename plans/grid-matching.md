# WFC Multi-Grid Matching

## Problem
When expanding to adjacent grids, seeds from populated neighbors frequently create impossible constraints on non-seed cells, causing WFC failures. The replacement system thrashes through random seeds instead of targeting the actual problem, leading to 20-35 WFC attempts per grid expansion.

## Current Approach

When a placeholder is clicked to expand into a new grid:

1. **Collect seeds** — Extract edge tiles from all populated neighbors, transform coords via cube math into the new grid's local space. (`getNeighborSeeds`)
2. **Pre-WFC: adjacent seed conflicts** — Check seeds from different source grids that ended up next to each other. Try replacing incompatible ones in the source grid, drop if irreplaceable. (`filterConflictingSeeds`)
3. **Pre-WFC: multi-seed cell conflicts** — Find non-seed cells adjacent to 2+ seeds with mutually impossible constraints. Strict level matching for all edge types (including grass). Try replacing/dropping until resolved. (`validateSeedConflicts`)
4. **WFC Phase 0** — Run WFC solver (in web worker) with all validated seeds. Worker returns `lastContradiction` with failed cell coords on both seeding and mid-solve failures.
5. **WFC Phase 1 (targeted replace)** — On failure, prioritize replacing seeds adjacent to the failed cell (instead of random order). After each replacement, re-validate seed conflicts to catch cascading issues (`onValidateSeeds`). Falls back to shuffled seed order if adjacent replacements don't work. Each seed is only replaced once.
6. **WFC Phase 2 (drop)** — Shuffle remaining active seeds. For each: mark it as dropped (excluded from WFC), then re-run WFC. Stop on first success.

## Improvement Ideas

### 1. Global cube-coord cell map (eliminates seeding + rectangular waste)
Combines two ideas: hex-native WFC grid + global cell map.

**Current problems:**
- WFC solver uses a rectangular 2D array for a hex-shaped grid (41-70% wasted cells depending on padding)
- Seeds copied from neighbors with coordinate transforms (error-prone, parity issues)
- Entire seeding pipeline: copy, transform, validate, replace, drop — hundreds of lines of recovery logic

**Proposal:** One global `Map<cubeCoordKey, Cell>` shared across all grids. When expanding to a new area, the WFC solver operates on a hex-radius region of this map. Already-collapsed cells from neighbor grids are just there — no copying, no transforms.

The solver treats:
- Uncollapsed cells within the hex radius → solve these
- Already-collapsed neighbor cells → fixed constraints (skip during collapse, use during propagation)

Benefits:
- Eliminates entire seeding pipeline (`getNeighborSeeds`, `filterConflictingSeeds`, `validateSeedConflicts`, `findReplacementTiles`, all phase 1/2/3 recovery)
- ~40-70% fewer cells in the solve (no rectangular waste, no padding)
- Cube coordinate math for adjacency — no stagger/parity issues
- No coordinate transforms between grids

Worker integration:
- Global map lives on main thread
- Serialize relevant region (solve area + adjacent collapsed cells) and send to worker
- Worker solves using cube-coord map, returns results
- Main thread applies results to global map
- Cell has a `gridKey` field for rendering ownership (which BatchedMesh it belongs to)

Tile replacement for contradictions still works — modify the actual cell in the global map, same as `replaceTile()` does today. Still needs interior neighbor compatibility checks.

**Complexity:** High. Rearchitects multi-grid system. New global cell storage, rewrite WFC solver for cube-coord maps, remove seeding pipeline, update rendering. Touches HexMap, HexGrid, HexGridConnector, wfc.worker.js. ~500+ lines changed, ~300+ lines removed. Net code reduction.

### 2. Edge biasing during generation
Bias WFC weights to place simple tiles (grass, flat road) near grid edges. Prevents the problem at its source — slopes, coasts, and rivers near edges cause most failures because they're hard to match across grid boundaries. Could be done with position-based weight multipliers during the solve.

**Complexity:** Low. Pass grid radius + cell position to the solver, multiply weights by a bias factor based on distance from edge. ~20-30 lines in the worker.

### 3. More WFC retries per replacement
Currently each replace/drop attempt runs WFC once (with `maxRestarts: 1`). Increasing retries per attempt would give the solver more chances to find a valid arrangement before moving on to the next seed. Cheap way to reduce failures without changing the matching logic.

**Complexity:** Trivial. Increase `maxRestarts` in the solver options. ~1 line.
