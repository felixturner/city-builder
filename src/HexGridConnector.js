import {
  TILE_LIST,
  HexDir,
  HexOpposite,
  getHexNeighborOffset,
  rotateHexEdges,
  LEVELS_COUNT,
} from './HexTileData.js'
import { isInHexRadius } from './HexTiles.js'
import { random } from './SeededRandom.js'
import { HexWFCCell, edgesCompatible, getEdgeLevel } from './HexWFCCore.js'

// Re-export isInHexRadius for convenience
export { isInHexRadius }

// ============================================================================
// Cube Coordinates for Hex Grids
// Cube coords (q, r, s) where q + r + s = 0
// Much cleaner for edge detection and neighbor finding
// ============================================================================

/**
 * Convert offset coordinates (col, row) to cube coordinates (q, r, s)
 * Using odd-r offset (pointy-top hex tiles)
 */
export function offsetToCube(col, row) {
  const q = col - Math.floor(row / 2)
  const r = row
  const s = -q - r
  return { q, r, s }
}

/**
 * Convert cube coordinates to offset coordinates
 */
export function cubeToOffset(q, r, s) {
  const col = q + Math.floor(r / 2)
  const row = r
  return { col, row }
}

/**
 * Get the hex direction from one cell to an adjacent cell
 * Returns null if cells are not adjacent
 * @param {number} fromX - Source cell x
 * @param {number} fromZ - Source cell z
 * @param {number} toX - Target cell x
 * @param {number} toZ - Target cell z
 * @returns {string|null} Direction (NE, E, SE, SW, W, NW) or null
 */
export function getHexDirection(fromX, fromZ, toX, toZ) {
  // Check each direction to see if it leads to the target
  for (const dir of HexDir) {
    const offset = getHexNeighborOffset(fromX, fromZ, dir)
    if (fromX + offset.dx === toX && fromZ + offset.dz === toZ) {
      return dir
    }
  }
  return null  // Not adjacent
}

/**
 * Get the approximate hex direction from one cell toward another (not necessarily adjacent)
 * Uses cube coordinate difference to find closest direction
 * @param {number} fromX - Source cell x (array coords)
 * @param {number} fromZ - Source cell z (array coords)
 * @param {number} toX - Target cell x (array coords)
 * @param {number} toZ - Target cell z (array coords)
 * @returns {string|null} Closest direction (NE, E, SE, SW, W, NW) or null if same cell
 */
export function getApproxHexDirection(fromX, fromZ, toX, toZ) {
  if (fromX === toX && fromZ === toZ) return null

  // Convert to cube coords for cleaner direction calculation
  const fromCube = offsetToCube(fromX, fromZ)
  const toCube = offsetToCube(toX, toZ)

  const dq = toCube.q - fromCube.q
  const dr = toCube.r - fromCube.r
  const ds = toCube.s - fromCube.s

  // Cube direction vectors for pointy-top hex (matching HexDir order)
  const dirVectors = {
    'NE': { q: 1, r: -1, s: 0 },
    'E': { q: 1, r: 0, s: -1 },
    'SE': { q: 0, r: 1, s: -1 },
    'SW': { q: -1, r: 1, s: 0 },
    'W': { q: -1, r: 0, s: 1 },
    'NW': { q: 0, r: -1, s: 1 },
  }

  // Find direction with best dot product (closest alignment)
  let bestDir = null
  let bestScore = -Infinity
  for (const [dir, vec] of Object.entries(dirVectors)) {
    const score = dq * vec.q + dr * vec.r + ds * vec.s
    if (score > bestScore) {
      bestScore = score
      bestDir = dir
    }
  }
  return bestDir
}

/**
 * Convert local grid coordinates to global offset coordinates
 * Shared utility used by HexMap, HexGrid, and HexGridConnector
 * @param {number} x - Grid array x coordinate
 * @param {number} z - Grid array z coordinate
 * @param {number} gridRadius - Grid radius
 * @param {Object} globalCenterCube - Grid's center in global cube coords {q, r, s}
 * @returns {{col: number, row: number}} Global offset coordinates
 */
export function localToGlobalCoords(x, z, gridRadius, globalCenterCube) {
  const localCol = x - gridRadius
  const localRow = z - gridRadius
  const localCube = offsetToCube(localCol, localRow)
  const globalCube = {
    q: localCube.q + globalCenterCube.q,
    r: localCube.r + globalCenterCube.r,
    s: localCube.s + globalCenterCube.s
  }
  return cubeToOffset(globalCube.q, globalCube.r, globalCube.s)
}

/**
 * Convert a grid's world offset to its center in global cube coordinates
 * This is done once per grid at creation time
 */
export function worldOffsetToGlobalCube(worldOffset) {
  const offset = worldToOffset(worldOffset.x, worldOffset.z)
  return offsetToCube(offset.col, offset.row)
}

/**
 * Get the cube coordinate that defines each grid direction's edge
 * For flat-top hex grid-of-grids with pointy-top tiles inside:
 * - N/S edges are along the r axis (top/bottom horizontal edges)
 * - NE/SW edges are along the q axis (right-to-upper-right / left-to-lower-left)
 * - SE/NW edges are along the s axis (right-to-lower-right / upper-left-to-left)
 */
function getEdgeAxis(gridDirection) {
  switch (gridDirection) {
    case GridDirection.N:  return { axis: 'r', value: -1 }  // r = -radius (top)
    case GridDirection.S:  return { axis: 'r', value: +1 }  // r = +radius (bottom)
    case GridDirection.NE: return { axis: 'q', value: +1 }  // q = +radius (right to upper-right)
    case GridDirection.SW: return { axis: 'q', value: -1 }  // q = -radius (left to lower-left)
    case GridDirection.SE: return { axis: 's', value: -1 }  // s = -radius (right to lower-right)
    case GridDirection.NW: return { axis: 's', value: +1 }  // s = +radius (upper-left to left)
    default: return null
  }
}

/**
 * Direction enum for grid expansion (6 directions for flat-top hex)
 * Flat-top hex has flat edges at N and S, vertices at E and W
 * So the 6 neighbor directions are: N, NE, SE, S, SW, NW (no E or W!)
 */
export const GridDirection = {
  N: 0,
  NE: 1,
  SE: 2,
  S: 3,
  SW: 4,
  NW: 5,
}

/**
 * Get the opposite grid direction
 */
export function getOppositeDirection(dir) {
  const opposites = {
    [GridDirection.N]: GridDirection.S,
    [GridDirection.NE]: GridDirection.SW,
    [GridDirection.SE]: GridDirection.NW,
    [GridDirection.S]: GridDirection.N,
    [GridDirection.SW]: GridDirection.NE,
    [GridDirection.NW]: GridDirection.SE,
  }
  return opposites[dir]
}

/**
 * Convert GridDirection (flat-top hex grid) to HexDir (pointy-top tile edge)
 *
 * Flat-top grid directions: N, NE, SE, S, SW, NW
 * Pointy-top tile edges: NE, E, SE, SW, W, NW
 *
 * The mapping picks the tile edge that most closely aligns with the grid direction:
 * - Grid N (0°)   → tile NE (30°) or NW (330°) - pick NE
 * - Grid NE (60°) → tile E (90°)
 * - Grid SE (120°) → tile SE (150°)
 * - Grid S (180°) → tile SW (210°) or SE (150°) - pick SW
 * - Grid SW (240°) → tile W (270°)
 * - Grid NW (300°) → tile NW (330°)
 */
export function gridDirToHexDir(gridDir) {
  const mapping = {
    [GridDirection.N]:  'NE',  // Grid N → tile NE edge
    [GridDirection.NE]: 'E',   // Grid NE → tile E edge
    [GridDirection.SE]: 'SE',  // Grid SE → tile SE edge
    [GridDirection.S]:  'SW',  // Grid S → tile SW edge
    [GridDirection.SW]: 'W',   // Grid SW → tile W edge
    [GridDirection.NW]: 'NW',  // Grid NW → tile NW edge
  }
  return mapping[gridDir]
}

/**
 * Get the HexDir direction(s) to check for a given GridDirection
 * For N/S edges, tiles alternate between two edge directions
 * Returns array of possible outward directions
 */
function getOutwardHexDirs(gridDirection) {
  switch (gridDirection) {
    case GridDirection.N:  return ['NE', 'NW']  // North border - both NE and NW edges
    case GridDirection.S:  return ['SE', 'SW']  // South border - both SE and SW edges
    case GridDirection.NE: return ['NE', 'E']   // NE border
    case GridDirection.SE: return ['SE', 'E']   // SE border
    case GridDirection.SW: return ['SW', 'W']   // SW border
    case GridDirection.NW: return ['NW', 'W']   // NW border
    default: return ['NE']
  }
}

/**
 * Check if a tile (in cube coords) is on the edge for a given direction
 * Uses cube coordinate boundaries - much cleaner than offset math!
 */
function isOnEdge(q, r, s, gridRadius, gridDirection) {
  const edge = getEdgeAxis(gridDirection)
  if (!edge) return false

  const coord = edge.axis === 'q' ? q : edge.axis === 'r' ? r : s
  const boundary = edge.value * gridRadius

  return coord === boundary
}

/**
 * Extract tiles on the boundary facing a given direction
 * Uses cube coordinates for clean edge detection
 * For each tile, determines ALL edges that point outward (can be 1 or 2)
 * @param {Array} hexGrid - 2D array of HexTile objects
 * @param {number} gridRadius - Radius of the hex grid
 * @param {number} direction - GridDirection enum value
 * @returns {Array} Array of { tile, outwardDirs: string[] } where outwardDirs are all HexDirs facing outward
 */
export function extractEdgeTiles(hexGrid, gridRadius, direction) {
  const edgeTiles = []
  const size = gridRadius * 2 + 1
  const possibleDirs = getOutwardHexDirs(direction)

  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size; row++) {
      const offsetCol = col - gridRadius
      const offsetRow = row - gridRadius

      // Skip if outside hex radius
      if (!isInHexRadius(offsetCol, offsetRow, gridRadius)) continue

      // Convert to cube coordinates for clean edge detection
      const { q, r, s } = offsetToCube(offsetCol, offsetRow)

      // Skip if not on the edge we're looking for
      if (!isOnEdge(q, r, s, gridRadius, direction)) continue

      const tile = hexGrid[col]?.[row]
      if (!tile) continue

      // Find ALL edge directions that point outside (can be 1 or 2)
      const outwardDirs = []
      for (const dir of possibleDirs) {
        const offset = getHexNeighborOffset(col, row, dir)
        const neighborCol = col + offset.dx
        const neighborRow = row + offset.dz
        const neighborOffsetCol = neighborCol - gridRadius
        const neighborOffsetRow = neighborRow - gridRadius

        if (!isInHexRadius(neighborOffsetCol, neighborOffsetRow, gridRadius)) {
          outwardDirs.push(dir)
        }
      }

      if (outwardDirs.length > 0) {
        edgeTiles.push({ tile, outwardDirs })
      }
    }
  }

  return edgeTiles
}

/**
 * Find all tile+rotation combos that match an edge constraint
 * @param {HexWFCAdjacencyRules} rules - WFC adjacency rules
 * @param {string} edgeType - Edge type to match (grass, road, river, etc.)
 * @param {number} edgeLevel - Level the edge must match
 * @param {string} returnDir - Direction the matching edge must face
 * @returns {Array} Array of { type, rotation, level } objects
 */
export function findCompatibleTiles(rules, edgeType, edgeLevel, returnDir) {
  const results = []

  // Strict level match for all edge types (matches WFC solver behavior)
  const stateKeys = rules.getByEdge(edgeType, returnDir, edgeLevel)

  for (const key of stateKeys) {
    const state = HexWFCCell.parseKey(key)
    results.push(state)
  }

  return results
}

/**
 * Convert pointy-top hex offset coordinates to world position
 * Used for individual hex tiles within a grid
 * @param {number} col - Column (x)
 * @param {number} row - Row (z)
 * @param {number} w - Hex width (flat-to-flat)
 * @param {number} h - Hex height (point-to-point)
 * @returns {{x: number, z: number}}
 */
export function pointyTopHexToWorld(col, row, w, h) {
  // Odd-r offset: stagger odd rows to the right
  const x = col * w + (Math.abs(row) % 2) * w * 0.5
  const z = row * h * 0.75
  return { x, z }
}

/**
 * Convert flat-top hex offset coordinates to world position
 * Used for the grid-of-grids (each grid is a flat-top hex)
 * @param {number} col - Column (x)
 * @param {number} row - Row (z)
 * @param {number} w - Hex width (point-to-point)
 * @param {number} h - Hex height (flat-to-flat)
 * @returns {{x: number, z: number}}
 */
export function flatTopHexToWorld(col, row, w, h) {
  // Odd-q offset: stagger odd columns down
  const x = col * w * 0.75
  const z = row * h + (Math.abs(col) % 2) * h * 0.5
  return { x, z }
}

/**
 * Calculate world offset for a new grid in a given direction
 * Direct world-unit calculation based on grid dimensions
 * @param {number} gridRadius - Radius of the hex grids
 * @param {number} direction - GridDirection to expand
 * @param {number} hexWidth - Width of hex tiles (default 2)
 * @param {number} hexHeight - Height of hex tiles (default calculated from width)
 * @returns {{x: number, z: number}} World offset
 */
export function getGridWorldOffset(gridRadius, direction, hexWidth = 2, hexHeight = null) {
  if (!hexHeight) {
    hexHeight = 2 / Math.sqrt(3) * 2  // Pointy-top hex height
  }

  const d = gridRadius * 2 + 1  // diameter in cells

  // Grid dimensions in world units
  const gridW = d * hexWidth           // horizontal span (cells * cell width)
  const gridH = d * hexHeight * 0.75   // vertical span (cells * row spacing)

  // Flat-top hex grid: N/S are straight up/down, diagonals at 60° angles
  // Add 0.5 cell width correction along shared edge due to odd-r stagger
  const half = hexWidth * 0.5

  const offsets = {
    [GridDirection.N]:  { x: half, z: -gridH },                      // North (up)
    [GridDirection.S]:  { x: -half, z: gridH },                      // South (down)
    [GridDirection.NE]: { x: gridW * 0.75 + half * 0.5, z: -gridH * 0.5 + half * 0.866 },
    [GridDirection.SE]: { x: gridW * 0.75 - half * 0.5, z: gridH * 0.5 + half * 0.866 },
    [GridDirection.SW]: { x: -gridW * 0.75 - half * 0.5, z: gridH * 0.5 - half * 0.866 },
    [GridDirection.NW]: { x: -gridW * 0.75 + half * 0.5, z: -gridH * 0.5 - half * 0.866 },
  }

  return offsets[direction]
}

/**
 * Get grid key from coordinates
 */
export function getGridKey(gridX, gridZ) {
  return `${gridX},${gridZ}`
}

/**
 * Parse grid key to coordinates
 */
export function parseGridKey(key) {
  const [x, z] = key.split(',').map(Number)
  return { x, z }
}

/**
 * Get adjacent grid key in a direction
 * For flat-top hex grid, the coordinate offsets depend on column parity (odd-q system)
 */
export function getAdjacentGridKey(currentKey, direction) {
  const { x, z } = parseGridKey(currentKey)

  // Flat-top hex: odd-q offset coordinates
  // Even columns and odd columns have different neighbor offsets for some directions
  const isOddCol = Math.abs(x) % 2 === 1

  // Offsets for flat-top hex (odd-q)
  const offsets = isOddCol ? {
    [GridDirection.N]:  { dx: 0, dz: -1 },
    [GridDirection.NE]: { dx: 1, dz: 0 },
    [GridDirection.SE]: { dx: 1, dz: 1 },
    [GridDirection.S]:  { dx: 0, dz: 1 },
    [GridDirection.SW]: { dx: -1, dz: 1 },
    [GridDirection.NW]: { dx: -1, dz: 0 },
  } : {
    [GridDirection.N]:  { dx: 0, dz: -1 },
    [GridDirection.NE]: { dx: 1, dz: -1 },
    [GridDirection.SE]: { dx: 1, dz: 0 },
    [GridDirection.S]:  { dx: 0, dz: 1 },
    [GridDirection.SW]: { dx: -1, dz: 0 },
    [GridDirection.NW]: { dx: -1, dz: -1 },
  }

  const { dx, dz } = offsets[direction]
  return getGridKey(x + dx, z + dz)
}

/**
 * Hex dimensions (must match HexTileGeometry)
 */
const HEX_WIDTH = 2
const HEX_HEIGHT = 2 / Math.sqrt(3) * 2

/**
 * Get world position for a tile at offset coordinates
 */
export function getWorldPos(offsetCol, offsetRow) {
  const x = offsetCol * HEX_WIDTH + (Math.abs(offsetRow) % 2) * HEX_WIDTH * 0.5
  const z = offsetRow * HEX_HEIGHT * 0.75
  return { x, z }
}

/**
 * Convert world position to offset coordinates (inverse of getWorldPos)
 */
export function worldToOffset(worldX, worldZ) {
  // First estimate row from Z
  const row = Math.round(worldZ / (HEX_HEIGHT * 0.75))
  // Then calculate column accounting for row stagger
  const stagger = (Math.abs(row) % 2) * HEX_WIDTH * 0.5
  const col = Math.round((worldX - stagger) / HEX_WIDTH)
  return { col, row }
}

/**
 * Get world offset for neighbor in given direction
 */
function getNeighborWorldOffset(dir) {
  // Pointy-top hex neighbor offsets in world coordinates
  const w = HEX_WIDTH
  const h = HEX_HEIGHT
  const offsets = {
    'NE': { x: w * 0.5, z: -h * 0.75 },
    'E':  { x: w, z: 0 },
    'SE': { x: w * 0.5, z: h * 0.75 },
    'SW': { x: -w * 0.5, z: h * 0.75 },
    'W':  { x: -w, z: 0 },
    'NW': { x: -w * 0.5, z: -h * 0.75 },
  }
  return offsets[dir]
}

/**
 * Generate neighbor edge tiles as seeds for WFC using cube coordinates
 *
 * This approach uses cube coords which are linear and additive (no stagger issues):
 * 1. Convert source tile's local offset → local cube
 * 2. Add source grid's global cube center → global cube
 * 3. Subtract new grid's global cube center → new grid's local cube
 * 4. Convert to offset coordinates for the seed position
 *
 * @param {Array} hexGrid - Source grid's 2D tile array
 * @param {number} gridRadius - Grid radius
 * @param {number} direction - GridDirection FROM new grid TO source grid
 * @param {Object} sourceCube - Source grid's center in global cube coords {q, r, s}
 * @param {Object} newCube - New grid's center in global cube coords {q, r, s}
 * @param {string} sourceGridKey - Key of the source grid (for tile replacement)
 * @returns {Array} Seed tiles [{ x, z, type, rotation, level, sourceGridKey, sourceX, sourceZ }] in new grid's coordinate system
 */
export function getNeighborSeeds(hexGrid, gridRadius, direction, sourceCube = { q: 0, r: 0, s: 0 }, newCube = { q: 0, r: 0, s: 0 }, sourceGridKey = null) {
  // direction is FROM new grid TO source, oppositeDir is FROM source TO new
  const oppositeDir = getOppositeDirection(direction)
  const edgeTiles = extractEdgeTiles(hexGrid, gridRadius, oppositeDir)
  const seeds = []

  for (const { tile } of edgeTiles) {
    // Source tile's offset coordinates (local to source grid)
    const srcOffsetCol = tile.gridX - gridRadius
    const srcOffsetRow = tile.gridZ - gridRadius

    // Convert to local cube coords
    const srcLocalCube = offsetToCube(srcOffsetCol, srcOffsetRow)

    // Add source grid's global cube center to get global cube coords
    const globalCube = {
      q: srcLocalCube.q + sourceCube.q,
      r: srcLocalCube.r + sourceCube.r,
      s: srcLocalCube.s + sourceCube.s
    }

    // Subtract new grid's global cube center to get new grid's local cube coords
    const newLocalCube = {
      q: globalCube.q - newCube.q,
      r: globalCube.r - newCube.r,
      s: globalCube.s - newCube.s
    }

    // Convert to offset coordinates in new grid
    const newOffset = cubeToOffset(newLocalCube.q, newLocalCube.r, newLocalCube.s)

    // Convert to grid array indices
    const newGridCol = newOffset.col + gridRadius
    const newGridRow = newOffset.row + gridRadius

    seeds.push({
      x: newGridCol,
      z: newGridRow,
      type: tile.type,
      rotation: tile.rotation,
      level: tile.level ?? 0,
      // Source info for tile replacement
      sourceGridKey,
      sourceX: tile.gridX,
      sourceZ: tile.gridZ
    })
  }

  return seeds
}

/**
 * Filter out seeds that would conflict with each other (incompatible adjacent edges)
 * This happens when seeds from multiple source grids end up adjacent in the new grid
 *
 * @param {Array} seeds - Array of seed tiles [{ x, z, type, rotation, level }]
 * @param {number} gridRadius - Grid radius
 * @param {string} gridKey - Grid key for logging
 * @param {Object} globalCenterCube - Grid's center in global cube coords {q, r, s}
 * @returns {Array} Filtered seeds with conflicts removed
 */
export function filterConflictingSeeds(seeds, gridRadius = 8, gridKey = '?', globalCenterCube = { q: 0, r: 0, s: 0 }) {
  if (seeds.length <= 1) return seeds

  const validSeeds = []
  const seedMap = new Map() // "x,z" -> seed
  const conflicts = []

  for (const seed of seeds) {
    const key = `${seed.x},${seed.z}`

    // Check if this position is already taken
    if (seedMap.has(key)) continue

    // Check adjacency with existing seeds
    let hasConflict = false
    let conflictInfo = null
    for (const dir of HexDir) {
      const offset = getHexNeighborOffset(seed.x, seed.z, dir)
      const neighborKey = `${seed.x + offset.dx},${seed.z + offset.dz}`
      const neighborSeed = seedMap.get(neighborKey)

      if (neighborSeed) {
        // Check if edges are compatible (type AND level must match)
        const seedEdges = rotateHexEdges(TILE_LIST[seed.type]?.edges || {}, seed.rotation)
        const neighborEdges = rotateHexEdges(TILE_LIST[neighborSeed.type]?.edges || {}, neighborSeed.rotation)

        const seedEdge = seedEdges[dir]
        const neighborEdge = neighborEdges[HexOpposite[dir]]

        // Check edge level (for slopes)
        const seedEdgeLevel = getEdgeLevel(seed.type, seed.rotation, dir, seed.level ?? 0)
        const neighborEdgeLevel = getEdgeLevel(neighborSeed.type, neighborSeed.rotation, HexOpposite[dir], neighborSeed.level ?? 0)

        // Use shared edgesCompatible function
        if (!edgesCompatible(seedEdge, seedEdgeLevel, neighborEdge, neighborEdgeLevel)) {
          hasConflict = true
          const seedGlobal = localToGlobalCoords(seed.x, seed.z, gridRadius, globalCenterCube)
          const neighborGlobal = localToGlobalCoords(neighborSeed.x, neighborSeed.z, gridRadius, globalCenterCube)
          const reason = seedEdge !== neighborEdge ? 'edge type' : 'edge level'
          conflictInfo = {
            seed: { global: `${seedGlobal.col},${seedGlobal.row}`, type: TILE_LIST[seed.type]?.name || seed.type, rot: seed.rotation, level: seed.level ?? 0 },
            neighbor: { global: `${neighborGlobal.col},${neighborGlobal.row}`, type: TILE_LIST[neighborSeed.type]?.name || neighborSeed.type, rot: neighborSeed.rotation, level: neighborSeed.level ?? 0 },
            dir,
            seedEdge: `${seedEdge}@${seedEdgeLevel}`,
            neighborEdge: `${neighborEdge}@${neighborEdgeLevel}`,
            reason
          }
          break
        }
      }
    }

    if (!hasConflict) {
      validSeeds.push(seed)
      seedMap.set(key, seed)
    } else if (conflictInfo) {
      // Include actual seed object for replacement attempts
      conflictInfo.seedObj = seed
      conflicts.push(conflictInfo)
    }
  }

  // Log conflicts (these will be handled by replacement loop, not dropped here)
  if (conflicts.length > 0) {
    console.log(`%cSEED CONFLICT - ${conflicts.length} adjacent seed conflicts detected`, 'color: red')
    for (const c of conflicts) {
      const s = c.seed
      const n = c.neighbor
      console.log(`  (${s.global}) ${s.type} rot=${s.rot} lvl=${s.level}`)
      console.log(`  (${n.global}) ${n.type} rot=${n.rot} lvl=${n.level}`)
      console.log(`  → ${c.dir} edge: ${c.seedEdge} ≠ ${c.neighborEdge} (${c.reason})`)
    }
  }

  return { validSeeds, conflicts }
}

/**
 * Validate that seeds don't create unsolvable constraints for cells between them
 * A conflict occurs when a cell is adjacent to 2+ seeds whose edge requirements
 * can't be satisfied by any single tile.
 *
 * @param {Array} seeds - Array of seed tiles [{ x, z, type, rotation, level }]
 * @param {Object} rules - HexWFCAdjacencyRules instance
 * @param {number} gridRadius - Grid radius
 * @param {string} gridKey - Grid key for logging
 * @param {Object} globalCenterCube - Grid's center in global cube coords {q, r, s}
 * @returns {Object} { valid: boolean, conflicts: Array of { cell, seeds, requirements } }
 */
export function validateSeedConflicts(seeds, rules, gridRadius = 8, gridKey = '?', globalCenterCube = { q: 0, r: 0, s: 0 }) {
  if (seeds.length <= 1) return { valid: true, conflicts: [] }

  // Build seed lookup map
  const seedMap = new Map()
  for (const seed of seeds) {
    seedMap.set(`${seed.x},${seed.z}`, seed)
  }

  // Find all non-seed cells adjacent to 2+ seeds
  const cellNeighbors = new Map() // "x,z" -> [{ seed, dir }]
  for (const seed of seeds) {
    for (const dir of HexDir) {
      const offset = getHexNeighborOffset(seed.x, seed.z, dir)
      const nx = seed.x + offset.dx
      const nz = seed.z + offset.dz
      const key = `${nx},${nz}`

      // Skip if this cell is itself a seed
      if (seedMap.has(key)) continue

      if (!cellNeighbors.has(key)) {
        cellNeighbors.set(key, [])
      }
      cellNeighbors.get(key).push({ seed, dir: HexOpposite[dir] }) // dir the cell needs to face
    }
  }

  const conflicts = []

  // Check each cell adjacent to 2+ seeds
  for (const [cellKey, neighbors] of cellNeighbors) {
    if (neighbors.length < 2) continue

    const [cx, cz] = cellKey.split(',').map(Number)

    // Build edge requirements from all adjacent seeds
    const requirements = neighbors.map(({ seed, dir }) => {
      const seedEdges = rotateHexEdges(TILE_LIST[seed.type]?.edges || {}, seed.rotation)
      const edgeType = seedEdges[HexOpposite[dir]] // The edge the seed is presenting
      const edgeLevel = getEdgeLevel(seed.type, seed.rotation, HexOpposite[dir], seed.level ?? 0)
      return { edgeType, edgeLevel, dir, seed }
    })

    // Find tiles that match ALL requirements (intersection)
    let compatible = null
    for (const { edgeType, edgeLevel, dir } of requirements) {
      const matches = findCompatibleTiles(rules, edgeType, edgeLevel, dir)
      const matchSet = new Set(matches.map(m => `${m.type},${m.rotation},${m.level}`))

      if (compatible === null) {
        compatible = matchSet
      } else {
        compatible = new Set([...compatible].filter(k => matchSet.has(k)))
      }

      if (compatible.size === 0) break
    }

    if (!compatible || compatible.size === 0) {
      const cellGlobal = localToGlobalCoords(cx, cz, gridRadius, globalCenterCube)
      conflicts.push({
        cell: { x: cx, z: cz, global: `${cellGlobal.col},${cellGlobal.row}` },
        seeds: neighbors.map(({ seed }) => {
          const g = localToGlobalCoords(seed.x, seed.z, gridRadius, globalCenterCube)
          return {
            global: `${g.col},${g.row}`,
            type: TILE_LIST[seed.type]?.name || seed.type,
            rotation: seed.rotation,
            level: seed.level ?? 0
          }
        }),
        requirements: requirements.map(r => `${r.dir}=${r.edgeType}@${r.edgeLevel}`)
      })
    }
  }

  if (conflicts.length > 0) {
    for (const c of conflicts) {
      console.log(`%cSeed conflict @ (${c.cell.global}) needs: ${c.requirements.join(', ')}`, 'color: red')
    }
  }

  return { valid: conflicts.length === 0, conflicts }
}

/**
 * Find replacement tiles for a conflicting seed
 * Returns ALL candidates that:
 * 1. Match edges that connect to other tiles in the source grid (preserve connectivity)
 * 2. Have a compatible edge toward the conflict cell
 *
 * Caller should iterate through candidates to find one compatible with adjacent seeds.
 *
 * @param {Object} seed - The seed to replace { type, rotation, level, sourceX, sourceZ, ... }
 * @param {Array} sourceHexGrid - The source grid's tile array
 * @param {number} gridRadius - Grid radius
 * @param {Object} sourceGlobalCenterCube - Source grid's center in global cube coords {q, r, s}
 * @returns {Array} Array of replacement candidates [{ type, rotation, level }], empty if none found
 */
export function findReplacementTiles(seed, sourceHexGrid, gridRadius, sourceGlobalCenterCube = { q: 0, r: 0, s: 0 }) {
  const { sourceX, sourceZ, type: currentType, rotation: currentRotation, level: currentLevel } = seed

  const currentTypeName = TILE_LIST[currentType]?.name || currentType
  const globalCoords = localToGlobalCoords(sourceX, sourceZ, gridRadius, sourceGlobalCenterCube)
  // console.log(`%c  Finding replacements for ${currentTypeName} rot=${currentRotation} @ (${globalCoords.col},${globalCoords.row})`, 'color: gray')

  // Find which edges connect to actual neighbors in source grid
  // These edges are "locked" - replacement must match them
  const lockedEdges = {} // dir -> { type, level }
  for (const dir of HexDir) {
    const offset = getHexNeighborOffset(sourceX, sourceZ, dir)
    const nx = sourceX + offset.dx
    const nz = sourceZ + offset.dz
    const neighbor = sourceHexGrid[nx]?.[nz]

    if (neighbor) {
      // Read the NEIGHBOR's edge facing back toward us
      const neighborDef = TILE_LIST[neighbor.type]
      if (!neighborDef) continue
      const neighborEdges = rotateHexEdges(neighborDef.edges, neighbor.rotation)
      const oppositeDir = HexOpposite[dir]
      const neighborEdgeType = neighborEdges[oppositeDir]
      const neighborEdgeLevel = getEdgeLevel(neighbor.type, neighbor.rotation, oppositeDir, neighbor.level ?? 0)

      // Lock this edge to match what neighbor requires
      if (neighborEdgeType === 'grass') {
        lockedEdges[dir] = { type: neighborEdgeType, level: null }  // null = any level OK
      } else {
        lockedEdges[dir] = { type: neighborEdgeType, level: neighborEdgeLevel }
      }
    }
  }

  // Search active tile types and rotations for replacements
  const candidates = []

  for (let tileType = 0; tileType < TILE_LIST.length; tileType++) {
    const def = TILE_LIST[tileType]

    // Skip same tile type entirely to avoid oscillation (e.g., WATER rot=0 -> WATER rot=1)
    if (tileType === currentType) continue

    // Skip if currentLevel is invalid for this tile type (e.g. high slope only valid at level 0)
    const isSlope = def.highEdges?.length > 0
    if (isSlope) {
      const increment = def.levelIncrement ?? 1
      const maxBaseLevel = LEVELS_COUNT - 1 - increment
      if (currentLevel > maxBaseLevel) continue
    }

    for (let rot = 0; rot < 6; rot++) {
      const edges = rotateHexEdges(def.edges, rot)

      // Check if this tile matches all locked edges
      let matchesLocked = true
      for (const [dir, required] of Object.entries(lockedEdges)) {
        const edgeType = edges[dir]
        const edgeLevel = getEdgeLevel(tileType, rot, dir, currentLevel)
        // Type must match; level must match unless it's grass (null = any level OK)
        if (edgeType !== required.type) {
          matchesLocked = false
          break
        }
        if (required.level !== null && edgeType !== 'grass' && edgeLevel !== required.level) {
          matchesLocked = false
          break
        }
      }

      if (matchesLocked) {
        candidates.push({ type: tileType, rotation: rot, level: currentLevel })
      }
    }
  }

  // Shuffle candidates to avoid bias toward early-defined tile types (e.g., GRASS)
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }

  // if (candidates.length > 0) {
  //   console.log(`%c  → Found ${candidates.length} replacement candidates`, 'color: blue')
  // } else {
  //   console.log(`%c  → No replacements found (${Object.keys(lockedEdges).length} locked edges)`, 'color: orange')
  // }
  return candidates
}

/**
 * Generate seeds for an adjacent grid based on edge matching
 * @deprecated Use generateExternalNeighbors instead for better WFC constraint handling
 * @param {Array} hexGrid - 2D array of HexTile objects from source grid
 * @param {number} gridRadius - Radius of hex grids
 * @param {number} direction - GridDirection to expand
 * @param {HexWFCAdjacencyRules} rules - WFC adjacency rules
 * @param {Object} options - Options { maxSeeds, useWeightedRandom }
 * @returns {Array} Array of { x, z, type, rotation, level } seed objects for solver.solve()
 */
export function generateAdjacentGridSeeds(hexGrid, gridRadius, direction, rules, options = {}) {
  const { maxSeeds = Infinity, useWeightedRandom = true } = options

  const dirNames = ['N', 'NE', 'SE', 'S', 'SW', 'NW']
  console.log(`[EdgeSeed] Generating seeds for direction ${dirNames[direction]}`)

  // Extract edge tiles from source grid
  const edgeTiles = extractEdgeTiles(hexGrid, gridRadius, direction)

  if (edgeTiles.length === 0) {
    console.warn('[EdgeSeed] No edge tiles found!')
    return []
  }
  console.log(`[EdgeSeed] Found ${edgeTiles.length} edge tiles`)

  const seeds = []
  const usedPositions = new Set()

  let failCount = 0
  let skippedGrass = 0
  for (const { tile, outwardDirs } of edgeTiles) {
    // Get edge info from source tile
    const def = TILE_LIST[tile.type]
    if (!def) {
      console.warn(`[EdgeSeed] No definition for tile type ${tile.type}`)
      continue
    }

    const edges = rotateHexEdges(def.edges, tile.rotation)

    // Build constraints for ALL outward edges
    // Each outward edge requires a matching edge on the new tile in the opposite direction
    const constraints = outwardDirs.map(outwardDir => {
      const edgeType = edges[outwardDir]
      const edgeLevel = getEdgeLevel(tile.type, tile.rotation, outwardDir, tile.level)
      const returnDir = HexOpposite[outwardDir]  // New tile's edge facing back to source
      return { edgeType, edgeLevel, returnDir, outwardDir }
    })

    // Skip tiles that only have grass edges - let WFC fill those naturally
    const hasInterestingEdge = constraints.some(c => c.edgeType !== 'grass')
    if (!hasInterestingEdge) {
      skippedGrass++
      continue
    }

    // Find tiles that match ALL constraints (intersection)
    let compatible = null
    for (const { edgeType, edgeLevel, returnDir } of constraints) {
      const matches = findCompatibleTiles(rules, edgeType, edgeLevel, returnDir)
      const matchSet = new Set(matches.map(m => `${m.type},${m.rotation},${m.level}`))

      if (compatible === null) {
        compatible = matchSet
      } else {
        // Intersect with previous matches
        compatible = new Set([...compatible].filter(k => matchSet.has(k)))
      }

      if (compatible.size === 0) break
    }

    if (!compatible || compatible.size === 0) {
      failCount++
      if (failCount <= 5) {
        const srcX = tile.gridX - gridRadius
        const srcZ = tile.gridZ - gridRadius
        const srcName = TILE_LIST[tile.type]?.name || `type${tile.type}`
        const edgeDesc = constraints.map(c => `${c.outwardDir}=${c.edgeType}`).join(', ')
        console.warn(`[EdgeSeed] No compatible tiles for edges [${edgeDesc}] (tile at ${srcX},${srcZ} ${srcName} rot=${tile.rotation})`)
      }
      continue
    }

    // Convert back to objects
    const compatibleTiles = [...compatible].map(key => {
      const [type, rotation, level] = key.split(',').map(Number)
      return { type, rotation, level }
    })

    // Calculate position in new grid
    const newPosition = mapEdgePosition(
      tile.gridX, tile.gridZ,
      gridRadius,
      direction
    )

    // Validate position is within grid bounds
    const offsetCol = newPosition.col - gridRadius
    const offsetRow = newPosition.row - gridRadius
    if (!isInHexRadius(offsetCol, offsetRow, gridRadius)) {
      continue
    }

    // Skip if position already used
    const posKey = `${newPosition.col},${newPosition.row}`
    if (usedPositions.has(posKey)) {
      continue
    }
    usedPositions.add(posKey)

    // Select a tile (weighted random or first)
    let selected
    if (useWeightedRandom && compatibleTiles.length > 1) {
      const weights = compatibleTiles.map(s =>
        TILE_LIST[s.type]?.weight ?? 1
      )
      const totalWeight = weights.reduce((a, b) => a + b, 0)
      let roll = random() * totalWeight
      selected = compatibleTiles[compatibleTiles.length - 1]
      for (let i = 0; i < compatibleTiles.length; i++) {
        roll -= weights[i]
        if (roll <= 0) {
          selected = compatibleTiles[i]
          break
        }
      }
    } else {
      selected = compatibleTiles[0]
    }

    seeds.push({
      x: newPosition.col,
      z: newPosition.row,
      type: selected.type,
      rotation: selected.rotation,
      level: selected.level,
    })

    // Log offset-from-center coords to match tile labels
    const srcX = tile.gridX - gridRadius
    const srcZ = tile.gridZ - gridRadius
    const seedX = newPosition.col - gridRadius
    const seedZ = newPosition.row - gridRadius
    const tileName = TILE_LIST[selected.type]?.name || `type${selected.type}`
    const edgeDesc = constraints.map(c => `${c.outwardDir}=${c.edgeType}`).join(', ')
    console.log(`[EdgeSeed] Source (${srcX},${srcZ}) [${edgeDesc}] → Seed (${seedX},${seedZ}): ${tileName} rot=${selected.rotation} level=${selected.level}`)

    if (seeds.length >= maxSeeds) break
  }

  if (failCount > 0) {
    console.warn(`[EdgeSeed] ${failCount}/${edgeTiles.length} edge tiles had no compatible matches`)
  }
  console.log(`[EdgeSeed] Generated ${seeds.length} seeds from ${edgeTiles.length} edge tiles (skipped ${skippedGrass} grass-only tiles)`)

  return seeds
}

/**
 * Map a source grid edge position to the corresponding position in the new adjacent grid
 * The new grid's opposite edge should align with the source grid's edge
 * @param {number} sourceCol - Column in source grid
 * @param {number} sourceRow - Row in source grid
 * @param {number} gridRadius - Grid radius
 * @param {number} direction - Direction of expansion
 * @returns {{col: number, row: number}} Position in new grid
 */
function mapEdgePosition(sourceCol, sourceRow, gridRadius, direction) {
  const center = gridRadius

  // Convert to offset from center (-R to +R)
  const offsetCol = sourceCol - center
  const offsetRow = sourceRow - center

  // Mirror the position to the opposite edge in new grid
  let newOffsetCol, newOffsetRow

  switch (direction) {
    case GridDirection.N:
    case GridDirection.S:
      // Vertical (N/S): mirror row, keep column
      newOffsetCol = offsetCol
      newOffsetRow = -offsetRow
      break

    case GridDirection.NE:
    case GridDirection.SW:
    case GridDirection.NW:
    case GridDirection.SE:
      // Diagonal directions: rotate 180°
      newOffsetCol = -offsetCol
      newOffsetRow = -offsetRow
      break

    default:
      newOffsetCol = offsetCol
      newOffsetRow = offsetRow
  }

  return {
    col: center + newOffsetCol,
    row: center + newOffsetRow,
  }
}
