import { GLTFLoader } from 'three/examples/jsm/Addons.js'
import { Color } from 'three/webgpu'

/**
 * Hex tile type enum - matches Blender mesh names
 */
export const HexTileType = {
  GRASS: 0,
  ROAD_A: 1,
  ROAD_B: 2,
  ROAD_C: 3,
  ROAD_D: 4,
  ROAD_E: 5,
  ROAD_F: 6,
  ROAD_G: 7,
  ROAD_H: 8,
  ROAD_I: 9,
  ROAD_J: 10,
  ROAD_K: 11,
  ROAD_L: 12,
  ROAD_M: 13,
}

/**
 * Edge terrain types
 */
export const EdgeType = {
  GRASS: 'grass',
  ROAD: 'road',
  RIVER: 'river',
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
 */
export const HexTileDefinitions = {
  [HexTileType.GRASS]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 150,
  },
  [HexTileType.ROAD_A]: {
    // Straight E-W
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 40,
  },
  [HexTileType.ROAD_B]: {
    // NE, W
    edges: { NE: 'road', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 25,
  },
  [HexTileType.ROAD_C]: {
    // NW, W
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'road' },
    weight: 8,
  },
  [HexTileType.ROAD_D]: {
    // NE, SE, W
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 10,
  },
  [HexTileType.ROAD_E]: {
    // NE, E, W
    edges: { NE: 'road', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 10,
  },
  [HexTileType.ROAD_F]: {
    // E, SE, W
    edges: { NE: 'grass', E: 'road', SE: 'road', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 10,
  },
  [HexTileType.ROAD_G]: {
    // NW, W, SW
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'road', W: 'road', NW: 'road' },
    weight: 10,
  },
  [HexTileType.ROAD_H]: {
    // NW, E, SW, W
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'road', W: 'road', NW: 'road' },
    weight: 8,
  },
  [HexTileType.ROAD_I]: {
    // NE, NW, SE, SW
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'road', W: 'grass', NW: 'road' },
    weight: 8,
  },
  [HexTileType.ROAD_J]: {
    // E, W, SE, SW
    edges: { NE: 'grass', E: 'road', SE: 'road', SW: 'road', W: 'road', NW: 'grass' },
    weight: 5,
  },
  [HexTileType.ROAD_K]: {
    // All except E
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'road', W: 'road', NW: 'road' },
    weight: 3,
  },
  [HexTileType.ROAD_L]: {
    // All 6 edges
    edges: { NE: 'road', E: 'road', SE: 'road', SW: 'road', W: 'road', NW: 'road' },
    weight: 2,
  },
  [HexTileType.ROAD_M]: {
    // W only (dead end)
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 1,
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
  }

  /**
   * Get edges for this tile at its current rotation
   */
  getEdges() {
    const baseDef = HexTileDefinitions[this.type]
    if (!baseDef) return null
    return rotateHexEdges(baseDef.edges, this.rotation)
  }
}

/**
 * Mesh name mapping: HexTileType -> GLB mesh name
 */
export const HexMeshNames = {
  [HexTileType.GRASS]: 'hex_grass',
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
