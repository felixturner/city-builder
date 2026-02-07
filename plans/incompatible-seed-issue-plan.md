# WFC Corner Conflict Resolution Plan

## Problem
When expanding the hex map, seeds from multiple neighbor grids can create impossible constraints at "corner" cells - positions adjacent to 2+ seeds that require incompatible edges.

**Focus:** Roads, rivers, and coasts are the problematic edge types. Levels/heights are not an issue.

**Example failure:**
- Cell (17,1) needs: SW=road, W=river, NW=grass simultaneously
- No single tile has all three edge types

## Current Approach
1. Seeds collected from all populated neighbors
2. `filterConflictingSeeds()` removes directly adjacent conflicts
3. `validateSeedConflicts()` pre-validates corner cells
4. **Tile replacement** - try to find alternative tile that preserves source grid connections but presents different edge toward conflict cell (`findReplacementTile()`)
5. Fall back to seed dropping if no replacement found
6. WFC runs - if propagation fails, graduated retry drops problem seeds one at a time
7. Falls back to center grass seed only if all else fails

---

## Solution Options Summary

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A** | Add missing junction tiles in Blender | Clean, seamless | Manual work, many combinations |
| **B** | Neighbor tile replacement - find alternative tile, overwrite source grid | Preserves connectivity | Search cost, may not find substitutes |
| **C** | Corner-first solving | WFC more likely to succeed | Need fallback |

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

**Note:** Theoretical combinations are huge (4^6 = 4096+ ignoring levels), but most are nonsensical. Use data-driven approach: run many random seeds, collect actual conflict edge requirements, identify the ~5-10 common missing combos that occur in practice.

**High-value tiles to add:**
- River dead-end (river terminates into grass)
- Road slope dead-ends (2x: low and high slope variants with road ending in grass)

These allow easier transitions to grass, giving tile replacement more options to resolve conflicts.

---

### Option B: Neighbor Tile Replacement
Instead of removing the conflicting seed (which breaks connectivity), search for a replacement tile that resolves the conflict while preserving connections. Must overwrite the actual tile in the source grid.

**Approach:**
1. When conflict detected at cell X with seeds around it
2. For each conflicting seed:
   - Get seed's edges facing its SOURCE grid (must preserve these)
   - Brute-force search ALL tile types/rotations that match those source-facing edges
   - Check if any replacement presents a compatible edge toward cell X
3. If replacement found → overwrite the tile in source grid, update seed
4. If no replacement exists → fall back to seed removal

**Example:**
- RIVER_B at (-3,-8) conflicts with ROAD_A_SLOPE_LOW at (-5,-9)
- RIVER_B connects to source grid on its N, NE edges (river edges)
- Search: tiles with river on N, NE but grass/road on SW (toward conflict cell)
- If RIVER_END or similar exists → replace RIVER_B with it

**Pros:** Preserves connectivity, river/road continues on source side
**Cons:** Brute-force search cost, need to update source grid's BatchedMesh, may not find substitutes

---

### Option C: Corner-First Solving
Solve corner cells first (they have most constraints), then let WFC fill the rest.

**Approach:**
1. Identify corner cells before WFC
2. For each corner, find the single valid tile (if any) and add as seed
3. If no valid tile exists, handle gracefully (Option B)
4. Run WFC with original seeds + corner solutions

**Pros:** WFC more likely to succeed, fails fast if corners unsolvable
**Cons:** Need fallback for unsolvable corners

---

## Next Steps

Explore options to preserve connectivity when conflicts occur (Option B).

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
