# Notes

a hex map builder toy

## WFC (Wave Function Collapse) Implementation

### Core Algorithm
1. Initialization: All cells start with ALL possible states (tile × 6 rotations × levels)
2. Collapse: Pick cell with lowest entropy (log(possibilities) + noise), randomly select weighted state
3. Propagate: Remove incompatible states from neighbors via edge matching
4. Repeat: Until all cells collapsed or contradiction detected
5. Recovery: On contradiction, restart with incremented try count (max 10 restarts)

### Edge Matching System
Each tile defines 6 edges (NE, E, SE, SW, W, NW) with types: `grass | road | river | ocean | coast`. Adjacent edges must match type AND level (except grass which allows any level). Slopes have `highEdges` array — edges facing uphill have `baseLevel + levelIncrement`.

All solved tiles are stored in a global `Map<cubeKey, cell>` (`HexMap.globalCells`). When expanding to a new grid, boundary matching uses overlap zones ([Boris the Brave's MiB](https://www.boristhebrave.com/2021/10/26/model-synthesis-and-modifying-in-blocks/)):

- **Ring 1 (overlap cells)**: Neighbor cells adjacent to the solve region become solvable — WFC can re-solve them, giving it freedom at boundaries
- **Ring 2 (fixed cells)**: Cells adjacent to the overlap ring stay immutable constraints
- Edge cells (solve cells adjacent to fixed cells) use grass-any-level matching during propagation, preventing seed conflicts at boundaries while keeping strict level matching in the grid interior
- After solving, changed overlap cells are updated in their source grids via `replaceTile()`
- **Seed conflicts**: When initial propagation from fixed cells produces 0 possibilities in a cell, this is deterministic — retrying won't help. Skips straight to replace/drop recovery
- On failure: **Phase 1** swaps fixed cells near the failed cell with compatible alternatives; **Phase 2** drops fixed cells as constraints one by one

### Key Optimizations
- 3D byEdge index: O(1) lookup for compatible tiles by `edgeType → dir → level`
- Precomputed neighbors: Cached at init, includes return direction
- High edge caching: Avoid repeated rotation calculations
- Web Worker: WFC solver runs in worker thread (wfc.worker.js) for non-blocking UI

## Naming Conventions

### Hex Grid System
- HexMap — The entire world, manages multiple Grids (`src/HexMap.js`)
- HexGrid — A hexagonal grid of hex cells, one WFC solve = one Grid (`src/HexGrid.js`)
- GridHelper — Visual overlay (lines + dots) for a grid (`src/HexGridHelper.js`)
- Placeholder — Clickable hexagonal button to expand into adjacent grid slot (`src/Placeholder.js`)
- Cell — A position in the grid that can hold a Tile
- Tile — The actual mesh placed in a Cell (`src/HexTiles.js`)
- Fixed Cell — A solved tile from a neighboring grid used as a read-only constraint during WFC
- Overlap Cell — A neighbor boundary tile made solvable (ring 1) instead of fixed
- RNG Seed — The number that initializes the random number generator (global)

## Coordinate Systems

### Blender (Z-up)
- +X = East, +Y = North, +Z = Up

### Three.js / App (Y-up)
- +X = East, +Y = Up, +Z = South (-Z = North)

### glTF Export Transform ("+Y Up" checked)
| Blender | Three.js |
|---------|----------|
| +X | +X (East) |
| +Y | -Z (North) |
| +Z | +Y (Up) |

### Hex Orientation
- Cells/Tiles: Pointy-top (pointy vertices face ±Z North/South, flat edges face ±X East/West)
- HexGrids: Flat-top (flat edges face ±Z North/South, pointy vertices face ±X East/West)

### Hex Coordinate Systems

Cube/Axial Coordinates (q, r, s where s = -q-r) — PRIMARY
- Used for: WFC solver, global cell map, cross-grid references, distance/neighbor calculations
- Hex distance = max(|q|, |r|, |s|)
- Neighbors: addition via CUBE_DIRS (no row parity needed)

Offset Coordinates (col, row)
- Used for: rendering positions, local grid tile placement
- Row parity affects neighbor calculations

Conversion (pointy-top odd-row offset):
- Offset → Axial: `q = col - floor(row/2)`, `r = row`
- Axial → Offset: `col = q + floor(r/2)`, `row = r`

### Scale
- Blender: Tiles are 2m on X, 2.31m on Y, 1m on Z
- App: 1:1 scale, hex tile is 2 WU wide on X axis

## Future Improvements

### Sub-Complete Tileset
From the [N-WFC paper](https://ar5iv.labs.arxiv.org/html/2308.07307). Design the tileset so that for any valid edge configuration on one side of a cell, at least one tile exists that satisfies it regardless of what the other 5 edges require. This guarantees WFC never contradicts. Requires auditing every edge type at boundaries (road, river, coast, ocean, grass at each level) and adding "bridge" or "transition" tiles where gaps exist. Harder for hex grids (6 edges) than square grids.

### Driven WFC (Noise-Based Pre-Constraints)
[Townscaper-style](https://www.boristhebrave.com/2021/06/06/driven-wavefunctioncollapse/). Use continuous world noise fields to pre-determine tile categories (water, mountain, flat grass, etc.) before WFC runs. WFC only picks among variants within that category. Cross-grid boundaries become trivial because noise is continuous and doesn't care about grid edges. WFC becomes more of a detail pass than a generator.

## Debug Label Colors
- Purple = WFC seed conflict (0 possibilities during initial propagation)
- Orange = Replaced fixed cell / changed overlap cell
- Red = Dropped fixed cell

## References

- [Red Blob Games - Hexagonal Grids](https://www.redblobgames.com/grids/hexagons/)
- [mxgmn/WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse)
- [Boris the Brave - MiB](https://www.boristhebrave.com/2021/10/26/model-synthesis-and-modifying-in-blocks/)
- [Boris the Brave - Infinite MiB](https://www.boristhebrave.com/2021/11/08/infinite-modifying-in-blocks/)
- Medieval Hexagon Pack - Tile assets (KayKit)
- https://observablehq.com/@sanderevers/hexagon-tiling-of-an-hexagonal-grid
- Dorf Romantik, Bad North (style refs)
