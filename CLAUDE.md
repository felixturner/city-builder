# Project Notes

a hex map builder toy

## Critical Rules (ALWAYS follow)

1. NEVER git revert, commit, or push without asking for explicit permission first. No exceptions.
2. NEVER make code changes unless I specifically ask you to. If I ask a question, just answer it.
3. NEVER write to the memories directory. Use `plans/` for TODOs and notes.
4. ALWAYS play audio notification (`afplay /System/Library/Sounds/Glass.aiff`) after completing ANY task or before asking ANY question. Every single response.
5. DON'T run `npm run build` - I'll tell you if the build fails.

## Other Instructions

- Do not present guesses as facts. If you don't know something, say so.
- Don't ask leading questions about next steps
- Console log colors: only use black, green, red, and blue. Never use cyan or other colors.
- Console logs: only log global cell coords, never local cell coords.

## TODO

- Figure out how to get less wFC fails. bad seeds: 79319 (click 1,-1) , 351921 initial
- Add new TILES: River dead-end, road slope dead-ends (low/high). river slopes? coast slopes. branching bridges? to help WFC.

- fix coast can make weird strips
- use bigger world noise fields for water, mountains + forests, cities? 
- add rocks + plants
- add stepped rocks by cliffs
- Consider manual compositing passes instead of MRT (fixes transparency, enables half-res AO for perf)
- Consider preventing road slopes from meeting (use 'road_slope' edge type instead of 'road')
- Edge biasing for coast/ocean - Pre-seed boundary cells with water before solving, or use position-based weights to boost ocean/coast near edges and grass near center
- Check cliff render heights - Why are there no outcrops with 1 high neighbor? GRASS_CLIFF_C (1 highEdge) should create single-tile plateaus but they're rare/not appearing as expected
- Fix grids with no buildings - Buildings only spawn on grass adjacent to roads
- Place house on road dead-ends - Road end tiles should get a building
- after replacing a tile, check if dec needs to be removed.

- update mesh colors in blender png
- remove baked shadoews from blender file?

- add snowy areas?
- post - add subtle tilt shift, bleach,grain, LUT
- add extra tile with just 1 small bit of hill to fill jagged gaps in cliffs?(like coast)
- paint big noise color fileds over grasss for more variation
- find/make simpler house models
- fix weird ocean walls
- add boats + carts?
- add birds + clouds?
- add better skybox - styormy skies
- make tile hex edges less deep/visible in blender?
- Update to latest threejs
- add dec to hide road/river discontuities? Add a big house/watermill?


### Debug Label Colors
- Purple = WFC failed cell (0 possibilities)
- Red = Changed overlap cell (re-solved by neighbor grid)

## WFC (Wave Function Collapse) Implementation

### Core Algorithm
1. Initialization: All cells start with ALL possible states (tile × 6 rotations × levels)
2. Collapse: Pick cell with lowest entropy (log(possibilities) + noise), randomly select weighted state
3. Propagate: Remove incompatible states from neighbors via edge matching
4. Repeat: Until all cells collapsed or contradiction detected
5. Recovery: On contradiction, restart with incremented try count (max 10 restarts)

### Edge Matching System
- Each tile defines 6 edges (NE, E, SE, SW, W, NW) with types: `grass | road | river | ocean | coast`
- Compatibility: edges must match type AND level (except grass which allows any level)
- Slopes have `highEdges` array - edges facing uphill have `baseLevel + levelIncrement`

### Multi-Grid Expansion (Global Cell Map)
All solved tiles are stored in a global `Map<cubeKey, cell>` (`HexMap.globalCells`). When expanding to a new grid:
1. Generate solve cells via `cubeCoordsInRadius(center, radius)`
2. Find fixed cells: check 6 cube neighbors of each solve cell in `globalCells`
3. Pre-WFC: filter adjacent fixed cell conflicts (`filterConflictingFixedCells`)
4. Pre-WFC: validate multi-fixed-cell conflicts (`validateFixedCellConflicts`)
5. Phase 0: Initial WFC attempt with validated fixed cells
6. Phase 1: On failure, replace fixed cells adjacent to failed cell (`tryReplaceFixedCell` + `findReplacementTilesForCell`), re-run WFC
7. Phase 2: Drop fixed cells one by one, re-run WFC
8. On success: add results to `globalCells`, render via `grid.populateFromCubeResults()`

### Key Optimizations
- 3D byEdge index: O(1) lookup for compatible tiles by `edgeType → dir → level`
- Precomputed neighbors: Cached at init, includes return direction
- High edge caching: Avoid repeated rotation calculations
- Web Worker: WFC solver runs in worker thread (wfc.worker.js) for non-blocking UI

## Naming Conventions

### Hex Grid System (current)
- HexMap - The entire world, manages multiple Grids (class: `HexMap` in `src/HexMap.js`)
- HexGrid - A hexagonal grid of hex cells (one WFC solve = one Grid, class: `HexGrid` in `src/HexGrid.js`)
- GridHelper - Visual overlay (lines + dots) for a grid (class: `HexGridHelper` in `src/HexGridHelper.js`)
- GridPlaceholder - Clickable hexagonal button to expand into adjacent grid slot
- Cell - A position in the grid that can hold a Tile (the small hexes within a HexGrid)
- Tile - The actual mesh placed in a Cell (class: `HexTile` in `src/HexTiles.js`)
- Fixed Cell - A solved tile from a neighboring grid used as a read-only constraint during WFC solve
- RNG Seed - The number that initializes the random number generator (randomized or hard-coded at startup, global)


## Coordinate Systems

### Blender (Z-up)
- +X = East (right in top-down view)
- +Y = North (up in top-down view)
- +Z = Up (vertical, out of ground plane)

### Three.js / App (Y-up)
- +X = East (right in top-down view)
- +Y = Up (vertical)
- +Z = South (toward camera in default view, so -Z = North)

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
Two coordinate systems are used:

Cube/Axial Coordinates (q, r, s where s = -q-r) — PRIMARY
- Three axes at 60° angles, constraint: q + r + s = 0
- Used for: WFC solver, global cell map, cross-grid references, distance/neighbor calculations
- Hex distance = max(|q|, |r|, |s|)
- Neighbors: simple addition via CUBE_DIRS (no row parity needed)
- Shared utilities in `HexWFCCore.js`: cubeKey, parseCubeKey, cubeCoordsInRadius, cubeDistance

Offset Coordinates (col, row)
- Simple 2D array indexing
- Used for: rendering positions, local grid tile placement
- Row parity affects neighbor calculations (odd vs even rows have different neighbor offsets)

Conversion (pointy-top odd-row offset):
- Offset → Axial: `q = col - floor(row/2)`, `r = row`
- Axial → Offset: `col = q + floor(r/2)`, `row = r`

### Scale
- Blender: Tiles are 2m on X, 2.31m on Y, 1m on Z
- App: 1:1 scale (no scaling applied)
- Result: Hex tile is exactly 2 cells wide on the square grid (2 WU on X axis)

## Hex Grid Sources

- [Red Blob Games - Hexagonal Grids](https://www.redblobgames.com/grids/hexagons/) - Coordinate systems
- [mxgmn/WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse) - Original WFC
- Medieval Hexagon Pack - Tile assets (KayKit)
- https://observablehq.com/@sanderevers/hexagon-tiling-of-an-hexagonal-grid

## Game / Style Refs

- Dorf Romantik
- Bad North
