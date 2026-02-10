# Plan 2: Overlap Zones

## Context
Grid boundaries are the core failure point for WFC. Currently, neighbor boundary tiles are treated as immutable "fixed cells" — if they conflict, the solver has to replace or drop them through expensive multi-phase recovery. Overlap zones fix this by making the outermost ring of neighbor cells **solvable** instead of fixed, giving WFC freedom at boundaries. A second ring (further out) becomes the new fixed constraint layer.

Based on Paul Merrell's Model Synthesis / Boris the Brave's MiB writeups.
**Sources:** [Boris the Brave - MiB](https://www.boristhebrave.com/2021/10/26/model-synthesis-and-modifying-in-blocks/), [Infinite MiB](https://www.boristhebrave.com/2021/11/08/infinite-modifying-in-blocks/)

## Files Modified
- `src/HexMap.js` — constructor, `addToGlobalCells`, new `getFixedAndOverlapCells`, `populateGrid`, `createTileLabels`, `regenerateAll`
- `src/HexGrid.js` — added try/catch in `animateDecoration` onUpdate (instance can be deleted by decoration repopulation)
- `CLAUDE.md` — added blue debug label color

## Implementation (completed)

### 1. `overlapChangedCells` tracking Set
- Constructor: `this.overlapChangedCells = new Set()`
- `regenerateAll`: `this.overlapChangedCells.clear()`

### 2. New method: `getFixedAndOverlapCells(solveCells)`
- **Ring 1 (overlap)**: For each solve cell, check 6 cube neighbors in `globalCells`. If found and NOT in solve set -> overlap cell (solvable). Stores `gridKey` for later visual updates.
- **Ring 2 (fixed)**: For each overlap cell, check 6 cube neighbors in `globalCells`. If found and NOT in solve/overlap set -> fixed cell (immutable).
- Returns `{ overlapCells, fixedCells }`

### 3. Modified `addToGlobalCells`
If a cell already exists in `globalCells` -> update tile data in-place, **keep original gridKey**. Otherwise add normally. This ensures overlap cells stay "owned" by their source grid for rendering.

### 4. Modified `populateGrid`
- Replaced `getFixedCellsForRegion` with `getFixedAndOverlapCells`
- Extended `solveCells` with overlap cell positions (WFC can re-solve them)
- After WFC success: compare overlap results to originals, call `replaceTile()` on source grids for changed overlap cells
- Repopulate decorations on affected source grids
- Filter WFC result to core cells only for `populateFromCubeResults` and `addToGlobalCells`
- Updated log format: `"(217 cells, 27 overlap, 30 fixed)"` and `"22 overlap changed"`

### 5. Pre-WFC validation — no changes needed
`filterConflictingFixedCells` and `validateFixedCellConflicts` operate on ring 2 fixed cells only. Overlap cells don't need validation since they're solvable.

### 6. Debug label colors
- Blue = Changed overlap cell (re-solved by neighbor grid)
- Added in both populated grid labels and placeholder labels sections

### 7. HexGrid.js fix
- `animateDecoration` onUpdate: wrapped `setMatrixAt` in try/catch because `populateDecorations()` on source grids can delete decoration instances while GSAP tweens from the original animation are still running

## What Does NOT Change
- `wfc.worker.js` — worker treats all solve cells identically
- `HexGrid.js` — `replaceTile()` and `populateDecorations()` called but not modified (except the tween fix)
- `HexWFCCore.js` — utilities used as-is
- Phase 1/2 recovery loop — operates on ring 2 fixed cells, same logic
- `initialCollapses` seeding — only fires when no neighbors exist

## Results (seed 351921, Build All, 13 grids)

### Before overlap zones
- WFC failures on this seed
- More drops and replacements

### After overlap zones (1 ring)
```
[0,0] WFC SUCCESS (0 overlap, 0 fixed)
[1,-1] WFC SUCCESS (9 overlap, 10 fixed, 3 attempts, 9 overlap changed, 2 replaced)
[1,0] WFC SUCCESS (18 overlap, 20 fixed, 15 overlap changed)
[0,1] WFC SUCCESS (18 overlap, 20 fixed, 4 attempts, 16 overlap changed, 3 replaced, 1 dropped)
[-1,0] WFC SUCCESS (18 overlap, 20 fixed, 18 overlap changed, 2 dropped)
[-1,1] WFC SUCCESS (18 overlap, 20 fixed, 11 attempts, 16 overlap changed, 9 replaced, 1 dropped)
[1,1] WFC SUCCESS (18 overlap, 20 fixed, 18 overlap changed)
[0,2] WFC SUCCESS (27 overlap, 30 fixed, 7 attempts, 22 overlap changed, 6 replaced)
[-1,-1] WFC SUCCESS (18 overlap, 20 fixed, 11 overlap changed)
[-2,0] WFC SUCCESS (18 overlap, 20 fixed, 3 attempts, 11 overlap changed, 2 replaced)
[-2,1] WFC SUCCESS (27 overlap, 30 fixed, 5 attempts, 24 overlap changed, 4 replaced)
[-2,-1] WFC SUCCESS (18 overlap, 20 fixed, 14 overlap changed)
[0,-1] WFC SUCCESS (27 overlap, 30 fixed, 3 attempts, 23 overlap changed, 2 replaced)
```

### Key findings
- **Zero WFC failures** (previously this seed failed)
- **28 total replaced, 4 total dropped** across 13 grids — still present but reduced
- High overlap changed counts (11-24 per grid) — WFC is actively using boundary freedom
- Replaced/dropped are from **ring 2 fixed cell conflicts** — same mechanism as before, pushed one ring further out
- Ring 2 fixed cells from different source grids can still be adjacent at **triple-points** (where 3 grids meet), causing conflicts

## Iteration 2: Configurable Overlap Depth

Added `overlapRings` property (default 1) and made `getFixedAndOverlapCells` build N rings iteratively.

### 2-ring results (seed 351921)
Worse — 24 total drops, 21 replaced. More overlap = more cascading changes = more instability in the fixed ring further out. Reverted to 1 ring.

## Iteration 3: Remove Old Fixed Cell Recovery

Removed the old pre-WFC validation and phase 1/2 recovery (replace/drop) entirely. Just one clean WFC solve with `maxRestarts: 10`. Overlap handles all boundary flexibility.

### Changes
- Removed `filterConflictingFixedCells` calls from populateGrid
- Removed `validateFixedCellConflicts` calls from populateGrid
- Removed phase 1 (tryReplaceFixedCell loop) and phase 2 (drop loop)
- Single WFC solve with maxRestarts: 10
- Targeted decoration removal: `clearDecorationsAt(gridX, gridZ)` instead of full `populateDecorations()` on source grids

### Final results (seed 351921, Build All, 13 grids)
```
[0,0] WFC SUCCESS (0 overlap, 0 fixed)
[1,-1] WFC SUCCESS (9 overlap, 10 fixed, 9 overlap changed)
[1,0] WFC SUCCESS (18 overlap, 20 fixed, 17 overlap changed)
[0,1] WFC SUCCESS (18 overlap, 20 fixed, 15 overlap changed)
[-1,0] WFC SUCCESS (18 overlap, 20 fixed, 10 overlap changed)
[-1,1] WFC SUCCESS (18 overlap, 20 fixed, 17 overlap changed)
[1,1] WFC SUCCESS (18 overlap, 20 fixed, 16 overlap changed)
[0,2] WFC SUCCESS (27 overlap, 30 fixed, 19 overlap changed)
[-1,-1] WFC SUCCESS (18 overlap, 20 fixed, 17 overlap changed)
[-2,0] WFC SUCCESS (18 overlap, 20 fixed, 14 overlap changed)
[-2,1] WFC SUCCESS (27 overlap, 30 fixed, 22 overlap changed)
[-2,-1] WFC SUCCESS (18 overlap, 20 fixed, 16 overlap changed)
[0,-1] WFC SUCCESS (27 overlap, 30 fixed, 24 overlap changed)
```

- **Zero failures, zero drops, zero replacements**
- All grids solved on first attempt
- Overlap changed: 9-24 per grid (WFC naturally re-solving boundary cells)
- Only 1 cell deep into neighbor grids (overlap zone)

## Potential Future Improvements
- Plan 6 (similarity bias): Reduce unnecessary overlap changes by biasing WFC to keep original tiles
- Plan 3 (sub-complete tileset): Guarantee no contradictions for any edge combination
- Old recovery methods (filterConflictingFixedCells, validateFixedCellConflicts, tryReplaceFixedCell, findReplacementTilesForCell) are still defined but unused — can be removed if overlap proves reliable across more seeds
