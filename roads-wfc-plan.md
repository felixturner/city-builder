# Road Tile WFC System Plan

## Overview
Implement a Wave Function Collapse (WFC) road tile system. All 6 tiles are 2x2 cells (20x20 Blender units) with centered origins. Grid operates on 2x2 placement zones.

## Tile Definitions

### All Tiles: 2x2 Footprint, Centered Origin
```
[A][B]   A=NW, B=NE
[C][D]   C=SW, D=SE
```
Each cell = 10x10 Blender units. All tiles occupy full 2x2 area.

### 6 Tile Types (from updated GLB)
| Type | Index | Exits (rot=0) | Pattern |
|------|-------|---------------|---------|
| **RoadForward** | 0 | N, S | Straight road through center |
| **RoadEnd** | 1 | S | Dead end, cap at north, exit south |
| **RoadT** | 2 | N, S, W | T-junction, corner fill SE |
| **RoadX** | 3 | N, E, S, W | Full cross intersection |
| **RoadAngle** | 4 | N, E | 90° corner with sidewalk SW |
| **Road90** | 5 | N, E | Curved 90° turn |

### Rotation (0-3 = 0°, 90°, 180°, 270° clockwise)
Exits rotate with tile:
- rot=0: N,E,S,W as defined
- rot=1: exits shift → N→E, E→S, S→W, W→N
- rot=2: exits shift → N→S, E→W, S→N, W→E
- rot=3: exits shift → N→W, E→N, S→E, W→S

### Scale Factor
`SCALE = 1/10` → 10 BU = 1 cell, 20 BU = 2 cells = 1 tile footprint

## Data Structures

### 1. TileDefinition (static metadata per type)
```javascript
// All tiles are 2x2, just define which edges have road exits
export const TileDefinitions = {
  [TileType.FORWARD]: { exits: { N: true, E: false, S: true, W: false } },
  [TileType.END]:     { exits: { N: false, E: false, S: true, W: false } },  // Cap at N, exit S
  [TileType.T]:       { exits: { N: true, E: false, S: true, W: true } },   // Corner fill SE
  [TileType.X]:       { exits: { N: true, E: true, S: true, W: true } },
  [TileType.ANGLE]:   { exits: { N: true, E: true, S: false, W: false } },   // Corner fill SW
  [TileType.TURN_90]: { exits: { N: true, E: true, S: false, W: false } },
}

// Rotate exits clockwise by rotation steps (0-3)
function rotateExits(exits, rotation) {
  const dirs = ['N', 'E', 'S', 'W']
  const rotated = {}
  for (let i = 0; i < 4; i++) {
    rotated[dirs[(i + rotation) % 4]] = exits[dirs[i]]
  }
  return rotated
}
```

### 2. Grid Structure (2x2 placement zones)
```javascript
// Grid of 2x2 placement zones (not individual cells)
// Each zone can hold one tile
this.zoneGrid = Array(zoneW).fill(null).map(() =>
  Array(zoneH).fill(null)  // null = empty, Tile = occupied
)
this.tiles = []  // All placed tiles

// Zone size in world units
this.zoneSize = 2  // 2x2 cells = 20x20 Blender units
```

### 3. Tile Class (simplified)
```javascript
export class Tile {
  constructor(zoneX, zoneZ, type, rotation = 0) {
    this.id = Tile.ID++
    this.zoneX = zoneX   // Zone position (not cell position)
    this.zoneZ = zoneZ
    this.type = type
    this.rotation = rotation  // 0-3 = 0°, 90°, 180°, 270°
    this.instanceId = null
  }

  // Get rotated exits
  getExits() {
    return rotateExits(TileDefinitions[this.type].exits, this.rotation)
  }
}
```

## WFC Algorithm

### Placement Logic (zone-based)
```javascript
canPlaceTile(type, zoneX, zoneZ, rotation) {
  // Check zone is in bounds and empty
  if (zoneX < 0 || zoneX >= zoneW || zoneZ < 0 || zoneZ >= zoneH) return false
  if (this.zoneGrid[zoneX][zoneZ] !== null) return false

  // Check edge connections with neighbors
  return this.checkConnections(type, zoneX, zoneZ, rotation)
}

placeTile(type, zoneX, zoneZ, rotation) {
  const tile = new Tile(zoneX, zoneZ, type, rotation)
  this.zoneGrid[zoneX][zoneZ] = tile
  this.tiles.push(tile)
  return tile
}
```

### Connection Validation (simple edge matching)
```javascript
checkConnections(type, zoneX, zoneZ, rotation) {
  const exits = rotateExits(TileDefinitions[type].exits, rotation)

  // Check each neighbor (4 directions)
  const neighbors = [
    { dir: 'N', dx: 0, dz: -1, opposite: 'S' },
    { dir: 'E', dx: 1, dz: 0, opposite: 'W' },
    { dir: 'S', dx: 0, dz: 1, opposite: 'N' },
    { dir: 'W', dx: -1, dz: 0, opposite: 'E' },
  ]

  for (const { dir, dx, dz, opposite } of neighbors) {
    const neighbor = this.zoneGrid[zoneX + dx]?.[zoneZ + dz]
    if (neighbor) {
      const neighborExits = neighbor.getExits()
      // Road must connect to road, empty to empty
      if (exits[dir] !== neighborExits[opposite]) return false
    }
  }
  return true
}
```

## Files to Modify

### [src/Tiles.js](src/Tiles.js)
- Update `TILE_MESH_NAMES` to 6 tiles (remove Road90_2x2)
- Change `SCALE = 1/10` (currently 1/20)
- Add `TileDefinitions` with exits per type
- Add `rotateExits()` helper
- Add `computeBoundingSphere()` after geometry transforms
- Update `Tile` class: `zoneX/zoneZ` instead of `gridX/gridZ`

### [src/City.js](src/City.js)
- Change `roadGrid` to `zoneGrid` (2x2 zones instead of 1x1 cells)
- Update `roadGridSize` to zone count (e.g., 15 zones = 30 cells)
- Add `canPlaceTile()`, `placeTile()`, `checkConnections()`
- Update `updateRoadMatrices()` for zone-based positioning
- Fix tile Y positioning (bottom at Y=0.01)

## Implementation Phases

### Phase 1: Fix Current Rendering
1. Change `SCALE = 1/10`
2. Remove Road90_2x2 from `TILE_MESH_NAMES` (now 6 tiles)
3. Add `computeBoundingSphere()` after geometry transforms
4. Fix tile Y: bottom at Y=0.01 (above floor at Y=0)

### Phase 2: Zone-Based Grid
1. Add `TileDefinitions` with exits
2. Change grid to 2x2 zones (one tile per zone)
3. Update positioning: `zoneX * 2 + 1` for world X (center of 2x2)

### Phase 3: WFC Connections
1. Add `rotateExits()` helper
2. Add `checkConnections()` - validates neighbor edges match
3. Random placement with connection validation

### Phase 4: WFC Solver (future)
1. Constraint propagation
2. Backtracking for invalid states
3. Generate connected road networks

## Verification
1. All 6 tiles render at 2x2 cell size
2. No popping (bounding sphere computed)
3. No z-fighting (tiles above floor)
4. Tiles centered in their 2x2 zones
5. Rotations work correctly (0°, 90°, 180°, 270°)
