import { GLTFLoader } from 'three/examples/jsm/Addons.js'
import { Color } from 'three/webgpu'
import {
  HexTileType,
  HexDir,
  HexOpposite,
  HexTileDefinitions,
  getHexNeighborOffset,
  rotateHexEdges,
  TILE_LIST,
} from './HexTileData.js'

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
 * HexTile class - represents a single hex tile instance
 */
export class HexTile {
  static ID = 0
  static DEFAULT_COLOR = new Color(0xffffff)
  static LEVEL_COLORS = [
    new Color(0x44aa44),  // Level 0: green
    new Color(0xcccc44),  // Level 1: yellow
    new Color(0xcc4444),  // Level 2: red
  ]
  static debugLevelColors = false

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
   * Update color based on current level (for debug visualization)
   */
  updateLevelColor() {
    if (HexTile.debugLevelColors) {
      const levelColor = HexTile.LEVEL_COLORS[this.level] || HexTile.LEVEL_COLORS[HexTile.LEVEL_COLORS.length - 1]
      this.color.copy(levelColor)
    } else {
      this.color.copy(HexTile.DEFAULT_COLOR)
    }
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
  [HexTileType.RIVER_M]: 'hex_river_M',

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

      // Load geometries only for included tile types
      for (const [typeStr, meshName] of Object.entries(HexMeshNames)) {
        const type = parseInt(typeStr)
        if (!TILE_LIST.has(type)) continue
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
