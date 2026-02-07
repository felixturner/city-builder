import { GLTFLoader } from 'three/examples/jsm/Addons.js'
import { Color } from 'three/webgpu'

/**
 * Hex tile type enum - matches Blender mesh names
 */
export const HexTileType = {
  // Base
  GRASS: 0,
  WATER: 1,

  // Roads (10-29)
  ROAD_A: 10,
  ROAD_B: 11,
  ROAD_C: 12,
  ROAD_D: 13,
  ROAD_E: 14,
  ROAD_F: 15,
  ROAD_G: 16,
  ROAD_H: 17,
  ROAD_I: 18,
  ROAD_J: 19,
  ROAD_K: 20,
  ROAD_L: 21,
  ROAD_M: 22,

  // Rivers (30-49)
  RIVER_A: 30,
  RIVER_A_CURVY: 31,
  RIVER_B: 32,
  RIVER_C: 33,
  RIVER_D: 34,
  RIVER_E: 35,
  RIVER_F: 36,
  RIVER_G: 37,
  RIVER_H: 38,
  RIVER_I: 39,
  RIVER_J: 40,
  RIVER_K: 41,
  RIVER_L: 42,

  // Coasts (50-59)
  COAST_A: 50,
  COAST_B: 51,
  COAST_C: 52,
  COAST_D: 53,
  COAST_E: 54,

  // Crossings (60-69)
  RIVER_CROSSING_A: 60,
  RIVER_CROSSING_B: 61,

  // Slopes (70-89)
  GRASS_SLOPE_HIGH: 70,
  ROAD_A_SLOPE_HIGH: 71,
  GRASS_CLIFF: 72,
  GRASS_CLIFF_B: 73,
  GRASS_CLIFF_C: 74,
  GRASS_SLOPE_LOW: 75,
  ROAD_A_SLOPE_LOW: 76,
  GRASS_CLIFF_LOW: 77,
  GRASS_CLIFF_LOW_B: 78,
  GRASS_CLIFF_LOW_C: 79,
}

/**
 * Edge terrain types
 */
export const EdgeType = {
  GRASS: 'grass',
  ROAD: 'road',
  RIVER: 'river',
  OCEAN: 'ocean',
  COAST: 'coast',
  CLIFF: 'cliff',
  CLIFF_ROAD: 'cliff_road',
}

/**
 * Hex directions (6 edges) for pointy-top orientation
 * Vertices are at N and S (points), edges are between vertices
 * Order: clockwise starting from top-right
 */
export const HexDir = ['NE', 'E', 'SE', 'SW', 'W', 'NW']

export const HexOpposite = {
  NE: 'SW',
  E: 'W',
  SE: 'NW',
  SW: 'NE',
  W: 'E',
  NW: 'SE',
}

/**
 * Hex neighbor offsets for odd-r offset coordinates (pointy-top, stagger odd rows)
 * x = column, z = row
 * Reference: https://www.redblobgames.com/grids/hexagons/#neighbors-offset
 *
 * Pointy-top edges: NE, E, SE, SW, W, NW
 * - E/W neighbors are in same row (dz=0)
 * - NE/NW neighbors are in row above (dz=-1)
 * - SE/SW neighbors are in row below (dz=+1)
 */
export const HexNeighborOffsets = {
  // Even rows (z % 2 === 0)
  even: {
    NE: { dx: 0, dz: -1 },
    E:  { dx: 1, dz: 0 },
    SE: { dx: 0, dz: 1 },
    SW: { dx: -1, dz: 1 },
    W:  { dx: -1, dz: 0 },
    NW: { dx: -1, dz: -1 },
  },
  // Odd rows (z % 2 === 1)
  odd: {
    NE: { dx: 1, dz: -1 },
    E:  { dx: 1, dz: 0 },
    SE: { dx: 1, dz: 1 },
    SW: { dx: 0, dz: 1 },
    W:  { dx: -1, dz: 0 },
    NW: { dx: 0, dz: -1 },
  },
}

/**
 * Get neighbor offset for a hex position (odd-r: parity based on row z)
 */
export function getHexNeighborOffset(x, z, dir) {
  const parity = (z % 2 === 0) ? 'even' : 'odd'
  return HexNeighborOffsets[parity][dir]
}

/**
 * Check if a position is within hex grid radius (axial coordinates check)
 * @param {number} col - Offset column (relative to center)
 * @param {number} row - Offset row (relative to center)
 * @param {number} radius - Grid radius
 * @returns {boolean}
 */
export function isInHexRadius(col, row, radius) {
  const r = row
  const q = col - Math.floor(row / 2)
  if (q < -radius || q > radius) return false
  const r1 = Math.max(-radius, -q - radius)
  const r2 = Math.min(radius, -q + radius)
  return r >= r1 && r <= r2
}

/**
 * Get the direction from neighbor back to origin (dynamic opposite)
 * In offset coordinates, the "return direction" depends on both source and destination row parity
 */
export function getReturnDirection(fromX, fromZ, dir) {
  const offset = getHexNeighborOffset(fromX, fromZ, dir)
  const toX = fromX + offset.dx
  const toZ = fromZ + offset.dz

  // Find which direction from (toX, toZ) returns to (fromX, fromZ)
  for (const returnDir of HexDir) {
    const returnOffset = getHexNeighborOffset(toX, toZ, returnDir)
    if (returnOffset.dx === -offset.dx && returnOffset.dz === -offset.dz) {
      return returnDir
    }
  }

  // Fallback to geometric opposite (shouldn't happen if offsets are consistent)
  return HexOpposite[dir]
}

/**
 * Rotate hex edges by N steps (each step = 60°)
 * @param {Object} edges - { N, NE, SE, S, SW, NW } edge types
 * @param {number} rotation - 0-5 rotation steps
 */
export function rotateHexEdges(edges, rotation) {
  const rotated = {}
  for (let i = 0; i < 6; i++) {
    const fromDir = HexDir[i]
    const toDir = HexDir[(i + rotation) % 6]
    rotated[toDir] = edges[fromDir]
  }
  return rotated
}

/**
 * Tile definitions with edge patterns at rotation 0
 * Edges: NE, E, SE, SW, W, NW (pointy-top hex)
 * Edge types: grass, road, river, ocean
 */
export const HexTileDefinitions = {
  // === BASE ===
  [HexTileType.GRASS]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 500,
  },
  [HexTileType.WATER]: {
    edges: { NE: 'ocean', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'ocean', NW: 'ocean' },
    weight: 50,
  },

  // === ROADS ===
  [HexTileType.ROAD_A]: {
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 10,
  },
  [HexTileType.ROAD_B]: {
    edges: { NE: 'road', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 8,
  },
  [HexTileType.ROAD_C]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'road' },
    weight: 1,
  },
  [HexTileType.ROAD_D]: {
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.ROAD_E]: {
    edges: { NE: 'road', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.ROAD_F]: {
    edges: { NE: 'grass', E: 'road', SE: 'road', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.ROAD_G]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'road', W: 'road', NW: 'road' },
    weight: 2,
  },
  [HexTileType.ROAD_H]: {
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'road', W: 'road', NW: 'road' },
    weight: 2,
  },
  [HexTileType.ROAD_I]: {
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'road', W: 'grass', NW: 'road' },
    weight: 2,
  },
  [HexTileType.ROAD_J]: {
    edges: { NE: 'grass', E: 'road', SE: 'road', SW: 'road', W: 'road', NW: 'grass' },
    weight: 1,
  },
  [HexTileType.ROAD_K]: {
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'road', W: 'road', NW: 'road' },
    weight: 1,
  },
  [HexTileType.ROAD_L]: {
    edges: { NE: 'road', E: 'road', SE: 'road', SW: 'road', W: 'road', NW: 'road' },
    weight: 1,
  },
  [HexTileType.ROAD_M]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 8,
  },

  // === RIVERS (TODO: verify edges) ===
  [HexTileType.RIVER_A]: {
    edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 10,
  },
  [HexTileType.RIVER_A_CURVY]: {
    edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 10,
  },
  [HexTileType.RIVER_B]: {
    edges: { NE: 'river', E: 'grass', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 20,
  },
  [HexTileType.RIVER_C]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'river', NW: 'river' },
    weight: 4,
  },
  [HexTileType.RIVER_D]: {
    edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.RIVER_E]: {
    edges: { NE: 'river', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.RIVER_F]: {
    edges: { NE: 'grass', E: 'river', SE: 'river', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.RIVER_G]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'river', W: 'river', NW: 'river' },
    weight: 2,
  },
  [HexTileType.RIVER_H]: {
    edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'river', W: 'river', NW: 'river' },
    weight: 1,
  },
  [HexTileType.RIVER_I]: {
    edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'river', W: 'grass', NW: 'river' },
    weight: 1,
  },
  [HexTileType.RIVER_J]: {
    edges: { NE: 'grass', E: 'river', SE: 'river', SW: 'river', W: 'river', NW: 'grass' },
    weight: 1,
  },
  [HexTileType.RIVER_K]: {
    edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'river', W: 'river', NW: 'river' },
    weight: 1,
  },
  [HexTileType.RIVER_L]: {
    edges: { NE: 'river', E: 'river', SE: 'river', SW: 'river', W: 'river', NW: 'river' },
    weight: 1,
  },

  // === COASTS ===
  [HexTileType.COAST_A]: {
    edges: { NE: 'grass', E: 'coast', SE: 'ocean', SW: 'coast', W: 'grass', NW: 'grass' },
    weight: 20,
  },
  [HexTileType.COAST_B]: {
    edges: { NE: 'grass', E: 'coast', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'grass' },
    weight: 15,
  },
  [HexTileType.COAST_C]: {
    edges: { NE: 'coast', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'grass' },
    weight: 15,
  },
  [HexTileType.COAST_D]: {
    edges: { NE: 'ocean', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'coast' },
    weight: 15,
  },
  [HexTileType.COAST_E]: {
    edges: { NE: 'grass', E: 'grass', SE: 'coast', SW: 'coast', W: 'grass', NW: 'grass' },
    weight: 10,
  },

  // === CROSSINGS (road over river) ===
  [HexTileType.RIVER_CROSSING_A]: {
    // River E-W, Road NW-SE
    edges: { NE: 'grass', E: 'river', SE: 'road', SW: 'grass', W: 'river', NW: 'road' },
    weight: 5,
  },
  [HexTileType.RIVER_CROSSING_B]: {
    // River E-W, Road NE-SW
    edges: { NE: 'road', E: 'river', SE: 'grass', SW: 'road', W: 'river', NW: 'grass' },
    weight: 5,
  },

  // === SLOPES ===
  // Slopes connect two levels. High edges (NE, E, SE) are at level + levelIncrement.
  // Edge types are regular (grass, road) - the level handles height matching.
  // levelIncrement: 2 = 1u rise (2 × 0.5u), levelIncrement: 1 = 0.5u rise (1 × 0.5u)

  // High slopes: 1u rise (levelIncrement: 2)
  [HexTileType.GRASS_SLOPE_HIGH]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 200,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 2,
  },
  [HexTileType.ROAD_A_SLOPE_HIGH]: {
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 120,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 2,
  },
  // Cliff - uses flat grass geometry but connects levels like a slope (vertical drop)
  [HexTileType.GRASS_CLIFF]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 60,
    highEdges: ['NE', 'E', 'SE'],  // 3 high edges (half the hex)
    levelIncrement: 2,
  },
  [HexTileType.GRASS_CLIFF_B]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 60,
    highEdges: ['NE', 'E', 'SE', 'SW'],  // 4 high edges (wider cliff wrap)
    levelIncrement: 2,
  },
  [HexTileType.GRASS_CLIFF_C]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 60,
    highEdges: ['E'],  // 1 high edge (narrow point)
    levelIncrement: 2,
  },

  // Low slopes: 0.5u rise (levelIncrement: 1)
  [HexTileType.GRASS_SLOPE_LOW]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 10,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 1,
  },
  [HexTileType.ROAD_A_SLOPE_LOW]: {
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 10,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 1,
  },
  // Low cliffs: 0.5u rise
  [HexTileType.GRASS_CLIFF_LOW]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 38,
    highEdges: ['NE', 'E', 'SE'],  // 3 high edges
    levelIncrement: 1,
  },
  [HexTileType.GRASS_CLIFF_LOW_B]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 38,
    highEdges: ['NE', 'E', 'SE', 'SW'],  // 4 high edges
    levelIncrement: 1,
  },
  [HexTileType.GRASS_CLIFF_LOW_C]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 38,
    highEdges: ['E'],  // 1 high edge
    levelIncrement: 1,
  },
}

/**
 * HexTile class - represents a single hex tile instance
 */
export class HexTile {
  static ID = 0
  static DEFAULT_COLOR = new Color(0x88aa88)

  constructor(gridX, gridZ, type, rotation = 0) {
    this.id = HexTile.ID++
    this.gridX = gridX  // Column (q)
    this.gridZ = gridZ  // Row (r)
    this.type = type
    this.rotation = rotation  // 0-5 (60° steps)
    this.instanceId = null
    this.color = HexTile.DEFAULT_COLOR.clone()
    this.level = 0  // Elevation level, set by height propagation
  }

  /**
   * Get edges for this tile at its current rotation
   */
  getEdges() {
    const baseDef = HexTileDefinitions[this.type]
    if (!baseDef) return null
    return rotateHexEdges(baseDef.edges, this.rotation)
  }

  /**
   * Get high edges for this tile at its current rotation (for slope tiles)
   * Returns a Set of direction strings, or null if not a slope tile
   */
  getHighEdges() {
    const baseDef = HexTileDefinitions[this.type]
    if (!baseDef || !baseDef.highEdges) return null

    // Rotate high edges by the tile's rotation
    const rotatedHighEdges = new Set()
    for (const dir of baseDef.highEdges) {
      const dirIndex = HexDir.indexOf(dir)
      const rotatedIndex = (dirIndex + this.rotation) % 6
      rotatedHighEdges.add(HexDir[rotatedIndex])
    }
    return rotatedHighEdges
  }

  /**
   * Check if this tile is a slope tile
   */
  isSlope() {
    const baseDef = HexTileDefinitions[this.type]
    return baseDef && baseDef.highEdges && baseDef.highEdges.length > 0
  }
}

/**
 * Mesh name mapping: HexTileType -> GLB mesh name
 */
export const HexMeshNames = {
  // Base
  [HexTileType.GRASS]: 'hex_grass',
  [HexTileType.WATER]: 'hex_water',

  // Roads
  [HexTileType.ROAD_A]: 'hex_road_A',
  [HexTileType.ROAD_B]: 'hex_road_B',
  [HexTileType.ROAD_C]: 'hex_road_C',
  [HexTileType.ROAD_D]: 'hex_road_D',
  [HexTileType.ROAD_E]: 'hex_road_E',
  [HexTileType.ROAD_F]: 'hex_road_F',
  [HexTileType.ROAD_G]: 'hex_road_G',
  [HexTileType.ROAD_H]: 'hex_road_H',
  [HexTileType.ROAD_I]: 'hex_road_I',
  [HexTileType.ROAD_J]: 'hex_road_J',
  [HexTileType.ROAD_K]: 'hex_road_K',
  [HexTileType.ROAD_L]: 'hex_road_L',
  [HexTileType.ROAD_M]: 'hex_road_M',

  // Rivers
  [HexTileType.RIVER_A]: 'hex_river_A',
  [HexTileType.RIVER_A_CURVY]: 'hex_river_A_curvy',
  [HexTileType.RIVER_B]: 'hex_river_B',
  [HexTileType.RIVER_C]: 'hex_river_C',
  [HexTileType.RIVER_D]: 'hex_river_D',
  [HexTileType.RIVER_E]: 'hex_river_E',
  [HexTileType.RIVER_F]: 'hex_river_F',
  [HexTileType.RIVER_G]: 'hex_river_G',
  [HexTileType.RIVER_H]: 'hex_river_H',
  [HexTileType.RIVER_I]: 'hex_river_I',
  [HexTileType.RIVER_J]: 'hex_river_J',
  [HexTileType.RIVER_K]: 'hex_river_K',
  [HexTileType.RIVER_L]: 'hex_river_L',

  // Coasts
  [HexTileType.COAST_A]: 'hex_coast_A',
  [HexTileType.COAST_B]: 'hex_coast_B',
  [HexTileType.COAST_C]: 'hex_coast_C',
  [HexTileType.COAST_D]: 'hex_coast_D',
  [HexTileType.COAST_E]: 'hex_coast_E',

  // Crossings
  [HexTileType.RIVER_CROSSING_A]: 'hex_river_crossing_A',
  [HexTileType.RIVER_CROSSING_B]: 'hex_river_crossing_B',

  // High slopes (1u rise)
  [HexTileType.GRASS_SLOPE_HIGH]: 'hex_grass_sloped_high',
  [HexTileType.ROAD_A_SLOPE_HIGH]: 'hex_road_A_sloped_high',
  [HexTileType.GRASS_CLIFF]: 'hex_grass',  // Reuse flat grass for vertical cliff
  [HexTileType.GRASS_CLIFF_B]: 'hex_grass',
  [HexTileType.GRASS_CLIFF_C]: 'hex_grass',

  // Low slopes (0.5u rise)
  [HexTileType.GRASS_SLOPE_LOW]: 'hex_grass_sloped_low',
  [HexTileType.ROAD_A_SLOPE_LOW]: 'hex_road_A_sloped_low',
  [HexTileType.GRASS_CLIFF_LOW]: 'hex_grass',  // Reuse flat grass for vertical cliff
  [HexTileType.GRASS_CLIFF_LOW_B]: 'hex_grass',
  [HexTileType.GRASS_CLIFF_LOW_C]: 'hex_grass',
}

/**
 * HexTileGeometry - loads hex tile meshes from GLB
 */
export class HexTileGeometry {
  static geoms = new Map()  // type -> geometry
  static geomIds = new Map() // type -> BatchedMesh geometry ID
  static loaded = false
  static gltfScene = null
  static material = null  // Material from GLB

  // Scale factor: Blender units to world units
  // Blender tiles are 2m on X, we want 2 WU in app (1:1)
  static SCALE = 1.0

  // Hex dimensions (calculated from loaded meshes)
  static HEX_WIDTH = 2   // Will be updated from mesh bounds
  static HEX_HEIGHT = 2  // Will be updated from mesh bounds

  static async init(glbPath = './assets/models/hex-roads.glb') {
    const loader = new GLTFLoader()
    try {
      const gltf = await loader.loadAsync(glbPath)
      this.gltfScene = gltf.scene

      // Extract material from first mesh
      gltf.scene.traverse((child) => {
        if (child.isMesh && child.material && !this.material) {
          this.material = child.material
        }
      })

      // Load geometries for each tile type
      for (const [typeStr, meshName] of Object.entries(HexMeshNames)) {
        const type = parseInt(typeStr)
        const result = this.findAndProcessGeometry(gltf.scene, meshName)
        if (result.geom) {
          this.geoms.set(type, result.geom)
        }
      }

      // Calculate hex dimensions from grass tile
      const grassGeom = this.geoms.get(HexTileType.GRASS)
      if (grassGeom) {
        grassGeom.computeBoundingBox()
        const bb = grassGeom.boundingBox
        this.HEX_WIDTH = bb.max.x - bb.min.x
        this.HEX_HEIGHT = bb.max.z - bb.min.z
      }

      this.loaded = true
    } catch (e) {
      console.warn('HexTileGeometry: Failed to load', glbPath, e)
      this.loaded = false
    }
  }

  /**
   * Find geometry by mesh name, scale and center it
   */
  static findAndProcessGeometry(scene, meshName) {
    let mesh = null
    scene.traverse((child) => {
      if (child.name === meshName && child.geometry) {
        mesh = child
      }
    })

    if (!mesh) {
      console.warn(`HexTileGeometry: Mesh not found: ${meshName}`)
      return { geom: null }
    }

    // Clone and scale geometry
    const geom = mesh.geometry.clone()
    geom.scale(this.SCALE, this.SCALE, this.SCALE)

    // DISABLED - checking base orientation from GLB
    // geom.rotateY(Math.PI / 6)

    // Compute bounds and center XZ, lift Y to sit on floor
    geom.computeBoundingBox()
    const { min, max } = geom.boundingBox
    const centerX = (min.x + max.x) / 2
    const centerZ = (min.z + max.z) / 2
    geom.translate(-centerX, -min.y + 0.01, -centerZ)

    geom.computeBoundingBox()
    geom.computeBoundingSphere()

    return { geom }
  }

  /**
   * Get world position for hex grid coordinates
   * Pointy-top hex with odd-r offset coordinates (stagger odd rows)
   */
  static getWorldPosition(gridX, gridZ) {
    // Pointy-top: width = flat-to-flat (X), height = point-to-point (Z)
    const w = this.HEX_WIDTH || 2
    const h = this.HEX_HEIGHT || (2 / Math.sqrt(3) * 2)

    // Stagger odd rows (not columns)
    const x = gridX * w + (Math.abs(gridZ) % 2) * w * 0.5
    const z = gridZ * h * 0.75

    return { x, z }
  }
}
