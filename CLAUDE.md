# Project Notes

a hex map builder toy

## Critical Rules (ALWAYS follow)

1. **NEVER** git revert, commit, or push without asking for explicit permission first. No exceptions.
2. **NEVER** make code changes unless I specifically ask you to. If I ask a question, just answer it.
3. **NEVER** write to the memories directory. Use `plans/` for TODOs and notes.
4. **ALWAYS** play audio notification (`afplay /System/Library/Sounds/Glass.aiff`) after completing ANY task or before asking ANY question. Every single response.
5. **DON'T** run `npm run build` - I'll tell you if the build fails.

## Other Instructions

- Do not present guesses as facts. If you don't know something, say so.
- Don't ask leading questions about next steps

## TODO

- Figure out how to get less wFC fails
- [ ] Add new TILES: River dead-end, road slope dead-ends (low/high). river slopes? coast slopes. branching bridges? Allows easier transitions to grass, helps tile replacement resolve conflicts.

- use bigger world noise fields for water, mountains + forests, cities? 
- add rocks + plants
- add stepped rocks by cliffs
- [ ] Consider manual compositing passes instead of MRT (fixes transparency, enables half-res AO for perf)
- [ ] Consider preventing road slopes from meeting (use 'road_slope' edge type instead of 'road')
- [ ] **Edge biasing for coast/ocean** - Pre-seed boundary cells with water before solving, or use position-based weights to boost ocean/coast near edges and grass near center
- [ ] **Check cliff render heights** - Why are there no outcrops with 1 high neighbor? GRASS_CLIFF_C (1 highEdge) should create single-tile plateaus but they're rare/not appearing as expected
- [ ] **Fix grids with no buildings** - Buildings only spawn on grass adjacent to roads
- [ ] **Place house on road dead-ends** - Road end tiles should get a building

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
- [ ] Update to latest threejs
- [ ] **Consider switching to global cell coords** - Avoid world position math for coordinate conversion. Offset coords have stagger issues; cube/axial coords are linear and additive. See Red Blob Games article.
- add dec to hide road/river discontuities? Add a big house/watermill?


### Debug Label Colors
- Purple = WFC failed cell (0 possibilities)
- Orange = Replaced seed
- Red = Dropped seed

## Current Work: Multi-Grid WFC Connection

Expandable hex map where clicking placeholder helpers spawns new grids that seamlessly connect via WFC edge-matching.

### Key Files
- **src/HexMap.js** - Manages multiple HexGrid instances, handles expansion
- **src/HexGrid.js** - Self-contained grid with own BatchedMesh, Decorations, GridHelper
- **src/HexGridHelper.js** - Visual overlay (lines + dots) + clickable placeholder meshes
- **src/HexGridConnector.js** - Edge extraction, seed generation for adjacent grids
- **src/HexTiles.js** - Tile definitions, HexTile class, isInHexRadius()
- **src/HexWFC.js** - WFC solver and adjacency rules

### Architecture
- Each grid is self-contained with its own BatchedMesh instances
- `Map` manages a collection of `HexGrid` instances keyed by "x,z" grid coordinates
- Clicking a placeholder generates seeds from adjacent grid edge and creates new grid
- Seeds ensure seamless edge matching between adjacent grids

## WFC (Wave Function Collapse) Implementation

### Core Algorithm
1. **Initialization**: All cells start with ALL possible states (tile × 6 rotations × levels)
2. **Collapse**: Pick cell with lowest entropy (log(possibilities) + noise), randomly select weighted state
3. **Propagate**: Remove incompatible states from neighbors via edge matching
4. **Repeat**: Until all cells collapsed or contradiction detected
5. **Recovery**: On contradiction, restart with incremented try count (max 5 restarts)

### Edge Matching System
- Each tile defines 6 edges (NE, E, SE, SW, W, NW) with types: `grass | road | river | ocean | coast | cliff | cliff_road`
- Compatibility: edges must match type AND level (except grass which allows any level)
- Slopes have `highEdges` array - edges facing uphill have `baseLevel + levelIncrement`

### Multi-Grid Seeding
When expanding to adjacent grids:
1. Extract edge tiles from populated neighbor via `HexGridConnector.getNeighborSeeds()`
2. Transform coordinates: offset → cube → global cube → new grid local → offset
3. Pass seeds to new grid's WFC solver to constrain edge tiles
4. Result: seamless edge matching between grids

### Conflict Resolution (3 phases)
1. **Adjacent Seed Conflicts**: Seeds from different grids placed next to each other with incompatible edges
   - Detection: `filterConflictingSeeds()` checks edge compatibility
   - Resolution: `findReplacementTile()` searches for alternative tile in source grid that preserves its neighbors but presents compatible edge toward conflict

2. **Multi-Seed Cell Conflicts**: Cell adjacent to 2+ seeds with mutually incompatible requirements
   - Detection: `validateSeedConflicts()` pre-validates before WFC
   - Resolution: Try replacement, drop seed if no replacement found

3. **WFC Failure Recovery**: When propagation creates contradiction mid-solve
   - Detection: Cell has 0 possibilities, `lastContradiction` stores failure info
   - Resolution: `findAdjacentSeeds()` identifies problematic seed, remove and retry (graduated retry, max 10 attempts)

### Key Optimizations
- **3D byEdge index**: O(1) lookup for compatible tiles by `edgeType → dir → level`
- **Precomputed neighbors**: Cached at init, includes return direction
- **High edge caching**: Avoid repeated rotation calculations
- **Web Worker**: WFC solver runs in worker thread (HexWFCWorker.js) for non-blocking UI

## Naming Conventions

### Hex Grid System (current)
- **HexMap** - The entire world, manages multiple Grids (class: `HexMap` in `src/HexMap.js`)
- **HexGrid** - A hexagonal grid of hex cells (one WFC solve = one Grid, class: `HexGrid` in `src/HexGrid.js`)
- **GridHelper** - Visual overlay (lines + dots) for a grid (class: `HexGridHelper` in `src/HexGridHelper.js`)
- **GridPlaceholder** - Clickable hexagonal button to expand into adjacent grid slot
- **Cell** - A position in the grid that can hold a Tile (the small hexes within a HexGrid)
- **Tile** - The actual mesh placed in a Cell (class: `HexTile` in `src/HexTiles.js`)


## Coordinate Systems

### Blender (Z-up)
- **+X = East** (right in top-down view)
- **+Y = North** (up in top-down view)
- **+Z = Up** (vertical, out of ground plane)

### Three.js / App (Y-up)
- **+X = East** (right in top-down view)
- **+Y = Up** (vertical)
- **+Z = South** (toward camera in default view, so **-Z = North**)

### glTF Export Transform ("+Y Up" checked)
| Blender | Three.js |
|---------|----------|
| +X | +X (East) |
| +Y | -Z (North) |
| +Z | +Y (Up) |

### Hex Orientation
- **Cells/Tiles**: Pointy-top (pointy vertices face ±Z North/South, flat edges face ±X East/West)
- **HexGrids**: Flat-top (flat edges face ±Z North/South, pointy vertices face ±X East/West)

### Hex Coordinate Systems
Two coordinate systems are used:

**Offset Coordinates (col, row)**
- Simple 2D array indexing
- Best for: storage, iteration, array access, rendering positions
- Row parity affects neighbor calculations (odd vs even rows have different neighbor offsets)

**Cube/Axial Coordinates (q, r, s where s = -q-r)**
- Three axes at 60° angles, constraint: q + r + s = 0
- Best for: distance calculations, rotations, symmetry operations, hex math
- Hex distance = max(|q|, |r|, |s|)

**Conversion (pointy-top odd-row offset):**
- Offset → Axial: `q = col - floor(row/2)`, `r = row`
- Axial → Offset: `col = q + floor(r/2)`, `row = r`

### Scale
- **Blender**: Tiles are 2m on X, 2.31m on Y, 1m on Z
- **App**: 1:1 scale (no scaling applied)
- **Result**: Hex tile is exactly 2 cells wide on the square grid (2 WU on X axis)

## Hex Grid Sources

- [Red Blob Games - Hexagonal Grids](https://www.redblobgames.com/grids/hexagons/) - Coordinate systems
- [mxgmn/WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse) - Original WFC
- Medieval Hexagon Pack - Tile assets (KayKit)
- https://observablehq.com/@sanderevers/hexagon-tiling-of-an-hexagonal-grid

## Game / Style Refs

- Dorf Romantik
- Bad North
