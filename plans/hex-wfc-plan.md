# WFC Hexagonal Tile Generation Plan

## TODO

- [ ] **Edge biasing for coast/ocean** - Pre-seed boundary cells with water before solving, or use position-based weights to boost ocean/coast near edges and grass near center
- [ ] **Check cliff render heights** - Why are there no outcrops with 1 high neighbor? GRASS_CLIFF_C (1 highEdge) should create single-tile plateaus but they're rare/not appearing as expected

## Summary

Extend WFC to support hexagonal tiles with multiple terrain types (grass, roads, rivers). Key change: 6 directions and 6 rotations instead of 4.

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

### Hex Orientation: Pointy-top
- Pointy vertices face ±Z (North/South)
- Flat edges face ±X (East/West)

```
In Three.js (looking down from +Y):

         -Z (North)
            /\
           /  \
    NW    /    \    NE
         |      |
   -X ---|  ⬡   |--- +X
  (West) |      | (East)
    SW    \    /    SE
           \  /
            \/
         +Z (South)
```

The STRAIGHT road tile (hex_road_A) connects E↔W (flat edge to flat edge along X axis).

### Scale
- **Blender**: Tiles are 2m on X, 2.31m on Y, 1m on Z
- **App**: 1:1 scale (no scaling applied)
- **Result**: Hex tile is exactly 2 cells wide on the square grid (2 WU on X axis)

## Phase 1: Square WFC (DONE ✓)

Basic WFC implemented in `src/WFC.js` with:
- WFCCell, WFCAdjacencyRules, WFCSolver classes
- 4-direction adjacency (N, E, S, W)
- 4 rotations (0°, 90°, 180°, 270°)

## Phase 2: Hexagonal WFC

### Key Differences from Square Grid

| Aspect | Square | Hexagonal |
|--------|--------|-----------|
| Directions | 4 (N, E, S, W) | 6 (N, NE, SE, S, SW, NW) |
| Rotations | 4 (90° steps) | 6 (60° steps) |
| Neighbor offset | Simple ±1 | Depends on row parity (odd/even) |
| States per tile | type × 4 | type × 6 |

### Hexagonal Coordinate System

Using "offset coordinates" (odd-q or odd-r):
```
Row parity affects neighbor calculation:

Even row (z % 2 == 0):     Odd row (z % 2 == 1):
    NW  N                      N  NE
   W  ⬡  E                    W  ⬡  E
    SW  S                      S  SE
```

Direction offsets:
```javascript
const HEX_DIRS = {
  N:  { even: {dx: 0, dz:-1}, odd: {dx: 0, dz:-1} },
  NE: { even: {dx: 1, dz:-1}, odd: {dx: 1, dz: 0} },
  SE: { even: {dx: 1, dz: 0}, odd: {dx: 1, dz: 1} },
  S:  { even: {dx: 0, dz: 1}, odd: {dx: 0, dz: 1} },
  SW: { even: {dx:-1, dz: 0}, odd: {dx:-1, dz: 1} },
  NW: { even: {dx:-1, dz:-1}, odd: {dx:-1, dz: 0} },
}
const HEX_OPPOSITE = { N:'S', NE:'SW', SE:'NW', S:'N', SW:'NE', NW:'SE' }
```

### Tile Types (from Medieval Hexagon Pack)

**Road Tiles (13 types, A-M):**
| ID | Name | Edge pattern (base rotation) |
|----|------|------------------------------|
| A | STRAIGHT | N-S through |
| B | CURVE_WIDE | Gentle curve |
| C | CURVE_SLIGHT | Slight bend |
| D | T_JUNCTION | 3 exits |
| E | Y_JUNCTION | 3 exits (Y shape) |
| F | END | Single exit (dead end) |
| G | STRAIGHT_ALT | Horizontal variant |
| H | CURVE_TIGHT | Sharp turn |
| I | CURVE_SMALL | Small bend |
| J | FORK | Y-fork |
| K | JUNCTION_4 | 4 exits |
| L | CROSS | X intersection |
| M | GRASS | No road (pure grass) |

**River Tiles (12 types, A-L):** Similar patterns for water

### Edge Matching System

Each hex edge can have terrain type: `grass | road | river`

```javascript
// Example tile definition
HexTileDefinitions = {
  ROAD_STRAIGHT: {
    edges: { N: 'road', NE: 'grass', SE: 'grass', S: 'road', SW: 'grass', NW: 'grass' }
  },
  ROAD_CURVE: {
    edges: { N: 'road', NE: 'grass', SE: 'road', S: 'grass', SW: 'grass', NW: 'grass' }
  },
  GRASS: {
    edges: { N: 'grass', NE: 'grass', SE: 'grass', S: 'grass', SW: 'grass', NW: 'grass' }
  },
  // ... etc
}
```

Adjacency rule: `edgesA[dir] === edgesB[opposite(dir)]`

### Files to Create/Modify

**New: `src/HexWFC.js`**
- `HexTileDefinitions` - Edge patterns for each tile type
- `rotateHexEdges(edges, rotation)` - Rotate edges by 0-5 steps (60° each)
- `HexWFCAdjacencyRules` - 6-direction compatibility
- `HexWFCSolver` - Hex grid solver with parity-aware neighbors

**New: `src/HexTiles.js`**
- `HexTileType` enum
- `HexTile` class
- `HexTileGeometry` - Load hex tile meshes from GLB

**Modify: `src/City.js`**
- Add hex grid support alongside zone grid
- `generateHexWFC()` method
- Hex tile placement and rendering

**Modify: `src/GUI.js`**
- Grid type toggle (square/hex)
- Terrain weights (grass %, road %, river %)

### Tile Weights

```javascript
{
  GRASS: 100,        // Most common (filler)
  ROAD_STRAIGHT: 30,
  ROAD_CURVE: 20,
  ROAD_T: 10,
  ROAD_END: 15,
  RIVER_STRAIGHT: 25,
  RIVER_CURVE: 15,
  // ... etc
}
```

### Rendering Hex Grid

Position formula for **pointy-top hexagons** (points face ±Y, flats face ±X):
```javascript
// In Blender (XY plane, Z-up):
const HEX_WIDTH = Math.sqrt(3)   // Flat edge to flat edge (X direction)
const HEX_HEIGHT = 2             // Point to point (Y direction)

worldX = x * HEX_WIDTH + (y % 2) * HEX_WIDTH * 0.5
worldY = y * HEX_HEIGHT * 0.75
```

Mesh rotation: `rotation.y = step * Math.PI / 3` (60° per step)

### Implementation Order

1. Create `HexTiles.js` with tile definitions and geometry loader
2. Create `HexWFC.js` with hex-aware solver
3. Add hex grid rendering to City.js
4. Wire up GUI controls
5. Test and tune weights

## Verification

1. Visual: Hex edges align, roads/rivers connect seamlessly
2. Console: Log tile counts, restart count
3. Seed: Same seed = same layout
4. Performance: 15×15 hex grid solves quickly

## Sources

- [Red Blob Games - Hexagonal Grids](https://www.redblobgames.com/grids/hexagons/) - Coordinate systems
- [mxgmn/WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse) - Original WFC
- Medieval Hexagon Pack - Tile assets (KayKit)
