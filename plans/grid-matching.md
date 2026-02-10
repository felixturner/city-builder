# WFC Multi-Grid Matching

## Problem
Joining separate WFC grids is difficult. We have tried various methods to get seamless matching, but grids with many populated neighbors still frequently require replacement/drop recovery to satisfy boundary constraints.

## Current Approach

Uses a global `Map<cubeKey, Cell>` (`HexMap.globalCells`) shared across all grids. WFC solver operates on cube coordinates — no coordinate transforms, no rectangular waste.

When a placeholder is clicked to expand into a new grid:

1. **Generate solve cells** — `cubeCoordsInRadius(center, radius)` gives the 217 cells to solve
2. **Collect fixed cells** — Check 6 cube neighbors of each solve cell in `globalCells`. Already-solved neighbor tiles become read-only constraints (skip during collapse, use during propagation)
3. **Pre-WFC: adjacent fixed cell conflicts** — Check fixed cells from different source grids that are adjacent to each other. Try replacing incompatible ones, drop if irreplaceable. (`filterConflictingFixedCells`)
4. **Pre-WFC: multi-fixed-cell conflicts** — Find solve cells adjacent to 2+ fixed cells with mutually impossible constraints. Try replacing/dropping until resolved. (`validateFixedCellConflicts`)
5. **WFC Phase 0** — Run WFC solver (in web worker) with all validated fixed cells. Worker returns `lastContradiction` with failed cell coords on both seeding and mid-solve failures.
6. **WFC Phase 1 (targeted replace)** — On failure, replace fixed cells adjacent to the failed cell (`tryReplaceFixedCell` + `findReplacementTilesForCell`), re-run WFC.
7. **WFC Phase 2 (drop)** — Drop fixed cells one by one, re-run WFC. Stop on first success.
8. **On success** — Add results to `globalCells`, render via `grid.populateFromCubeResults()`

## Improvement Ideas

### 1. Solve entire map in one WFC pass
Skip grid-by-grid expansion entirely. Collect all cell positions for the full map upfront, run a single WFC solve across all ~2800 cells (13 grids × 217 cells). No fixed cells, no boundary problem — WFC can freely backtrack across the entire space.

**Benefits:**
- Eliminates the boundary constraint problem completely
- No replacements, no drops, no multi-phase recovery
- WFC has full freedom to find globally consistent solutions

**Tradeoffs:**
- Larger solve (~2800 cells vs ~217), slower but probably still fast enough for a web worker
- Loses incremental expansion (click-to-add grids) unless you pre-solve the whole region and reveal progressively
- Need to decide map extent upfront

**Complexity:** Medium. Generate all solve cells for the full map, run one WFC call, then distribute results to grids for rendering.

### 2. Overlap zones (Modifying in Blocks)
Based on Paul Merrell's Model Synthesis / Boris the Brave's MiB writeups. Instead of treating neighbor boundary tiles as read-only fixed cells, include the outermost ring of each neighbor inside the new solve region and allow those cells to be re-solved.

**Core idea:** Boundaries are a shared zone, not a hard wall. When solving a new grid, the boundary tiles of already-populated neighbors are treated as solvable (not fixed), so WFC can change them if needed. After solving, update the neighbor grids' border tiles and re-render.

**Benefits:**
- Transforms hard constraints into soft ones — dramatically reduces failures
- Even 1-cell overlap would massively reduce the constraint load on 3-neighbor grids
- Still allows incremental expansion

**Tradeoffs:**
- Previously-rendered tiles at grid edges can change visually when a new neighbor is added
- Need to update BatchedMesh for affected neighbor tiles after each solve
- Slightly more complex solve region construction

**Complexity:** Medium-High. Need to mark border cells as re-solvable, expand the solve region, and re-render affected neighbor tiles.

**Sources:** [Boris the Brave - MiB](https://www.boristhebrave.com/2021/10/26/model-synthesis-and-modifying-in-blocks/), [Infinite MiB](https://www.boristhebrave.com/2021/11/08/infinite-modifying-in-blocks/)

### 3. Sub-complete tileset (guaranteed solvability)
From the N-WFC paper (arxiv 2308.07307). Design the tileset so that for any valid edge configuration on one side, there always exists at least one valid tile. A "sub-complete" tileset guarantees WFC never needs backtracking.

**Core idea:** This is a tileset design constraint, not an algorithm change. Audit every edge type that can appear at a boundary (road, river, coast, ocean, grass at each level). Ensure each has at least one compatible tile regardless of what the other 5 edges require. Add "bridge" or "transition" tiles where gaps exist.

**Benefits:**
- Guarantees solvability — no contradictions ever
- Works with any expansion order or grid count

**Tradeoffs:**
- Requires careful tileset audit and potentially new tile models
- Harder for hex grids (6 edges) than square grids (4 edges)
- May need "fallback" tiles that are visually bland

**Complexity:** High (tileset work, not code). Need to enumerate all boundary edge combinations and verify coverage.

**Source:** [N-WFC Paper](https://ar5iv.labs.arxiv.org/html/2308.07307)

### 4. Driven WFC (noise-based pre-constraints)
Townscaper-style approach. Use continuous world noise fields to pre-determine tile categories at each cell before WFC runs (water, mountain, grass-level-0, etc.). WFC only picks among variants within that category.

**Core idea:** Cross-grid boundaries become trivial because the noise field is continuous and doesn't care about grid boundaries. The high-level structure is decided globally, WFC just fills in detail.

**Benefits:**
- Boundaries are naturally consistent — noise doesn't have grid seams
- Already have world noise fields planned (water, mountains, forests)
- WFC solves become much easier (heavily pre-constrained)

**Tradeoffs:**
- Less emergent variety from WFC (noise decides the big picture)
- Need to design the noise → tile-category mapping carefully
- WFC becomes more of a "detail pass" than a generator

**Complexity:** Medium. Need noise field generation, cell-to-category mapping, and WFC filtering by category.

**Source:** [Boris the Brave - Driven WFC](https://www.boristhebrave.com/2021/06/06/driven-wavefunctioncollapse/)

### 5. Editable WFC (soft constraints with similarity heuristic)
From Boris the Brave. Instead of treating existing tiles as hard fixed constraints, treat them as soft preferences. Re-solve the new grid AND border rings of neighbors simultaneously, using existing tiles as weighted preferences.

**Core idea:** Mark cells whose previous tile is no longer possible as "dirty". Collapse dirty cells first. Use a similarity heuristic — prefer tiles matching what was there before. Early-stop once no dirty cells remain.

**Benefits:**
- No hard contradictions — everything is negotiable
- Previous tiles are preserved where possible (similarity heuristic)
- Can handle any constraint configuration

**Tradeoffs:**
- Potentially re-solves large areas (computational cost)
- Visual instability — previously-rendered tiles might change
- More complex solver logic

**Complexity:** High. New solver mode with dirty-cell tracking, similarity weights, and early stopping.

**Source:** [Boris the Brave - Editable WFC](https://www.boristhebrave.com/2022/04/25/editable-wfc/)

### 6. More WFC retries per replacement
Currently each replace/drop attempt runs WFC once (with `maxRestarts: 1`). Increasing retries per attempt would give the solver more chances to find a valid arrangement before moving on to the next seed. Cheap way to reduce failures without changing the matching logic.

**Complexity:** Trivial. Increase `maxRestarts` in the solver options. ~1 line.
