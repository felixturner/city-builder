import { GLTFLoader } from 'three/examples/jsm/Addons.js'
import { Color } from 'three/webgpu'
import {
  TILE_LIST,
  TileType,
  HexDir,
  HexOpposite,
  getHexNeighborOffset,
  rotateHexEdges,
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
    new Color(0xcc8844),  // Level 2: orange
    new Color(0xcc4444),  // Level 3: red
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
      const colors = HexTile.LEVEL_COLORS
      const baseDef = TILE_LIST[this.type]
      if (baseDef && baseDef.highEdges && baseDef.highEdges.length > 0) {
        const lo = colors[this.level] || colors[colors.length - 1]
        const hi = colors[this.level + (baseDef.levelIncrement ?? 1)] || colors[colors.length - 1]
        this.color.copy(lo).lerp(hi, 0.5)
      } else {
        this.color.copy(colors[this.level] || colors[colors.length - 1])
      }
    } else {
      this.color.copy(HexTile.DEFAULT_COLOR)
    }
  }

  /**
   * Get edges for this tile at its current rotation
   */
  getEdges() {
    const baseDef = TILE_LIST[this.type]
    if (!baseDef) return null
    return rotateHexEdges(baseDef.edges, this.rotation)
  }

  /**
   * Get high edges for this tile at its current rotation (for slope tiles)
   * Returns a Set of direction strings, or null if not a slope tile
   */
  getHighEdges() {
    const baseDef = TILE_LIST[this.type]
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
    const baseDef = TILE_LIST[this.type]
    return baseDef && baseDef.highEdges && baseDef.highEdges.length > 0
  }
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

      // Load geometries for all active tile types
      for (let type = 0; type < TILE_LIST.length; type++) {
        const tile = TILE_LIST[type]
        const result = this.findAndProcessGeometry(gltf.scene, tile.mesh)
        if (result.geom) {
          this.geoms.set(type, result.geom)
        }
      }

      // Calculate hex dimensions from grass tile
      const grassGeom = this.geoms.get(TileType.GRASS)
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
