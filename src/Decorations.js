import { Object3D, BatchedMesh, Color } from 'three/webgpu'
import { TILE_LIST, TileType } from './HexTileData.js'
import { HexTileGeometry } from './HexTiles.js'
import FastSimplexNoise from '@webvoxel/fast-simplex-noise'
import { random } from './SeededRandom.js'

// Global noise instances shared across all Decorations
// Created lazily on first use, seeded from global RNG
let globalNoiseA = null
let globalNoiseB = null

let currentTreeNoiseFreq = 0.05
let currentTreeThreshold = 0.5

export function initGlobalTreeNoise(frequency = 0.05) {
  currentTreeNoiseFreq = frequency
  globalNoiseA = new FastSimplexNoise({ frequency, min: 0, max: 1, random })
  globalNoiseB = new FastSimplexNoise({ frequency, min: 0, max: 1, random })
}

export function setTreeNoiseFrequency(frequency) {
  currentTreeNoiseFreq = frequency
  globalNoiseA = new FastSimplexNoise({ frequency, min: 0, max: 1, random })
  globalNoiseB = new FastSimplexNoise({ frequency, min: 0, max: 1, random })
}

export function getTreeNoiseFrequency() {
  return currentTreeNoiseFreq
}

export function setTreeThreshold(threshold) {
  currentTreeThreshold = threshold
}

export function getTreeThreshold() {
  return currentTreeThreshold
}

// Check if a tile type has any road edges
function hasRoadEdge(tileType) {
  const def = TILE_LIST[tileType]
  if (!def) return false
  return Object.values(def.edges).some(edge => edge === 'road')
}

// Check if a tile is a road dead-end (exactly 1 road edge) and return the exit direction
// Returns { isDeadEnd: true, exitDir } or { isDeadEnd: false }
function getRoadDeadEndInfo(tileType, rotation) {
  const def = TILE_LIST[tileType]
  if (!def) return { isDeadEnd: false }

  // Count road edges and find the exit direction
  const dirs = ['NE', 'E', 'SE', 'SW', 'W', 'NW']
  const roadDirs = []
  for (const dir of dirs) {
    if (def.edges[dir] === 'road') {
      roadDirs.push(dir)
    }
  }

  if (roadDirs.length !== 1) return { isDeadEnd: false }

  // Apply rotation to find actual exit direction
  const baseDirIndex = dirs.indexOf(roadDirs[0])
  const rotatedIndex = (baseDirIndex + rotation) % 6
  const exitDir = dirs[rotatedIndex]

  return { isDeadEnd: true, exitDir }
}

// Tree meshes organized by type and density (single -> small -> medium -> large)
const TreesByType = {
  A: ['tree_single_A', 'trees_A_small', 'trees_A_medium', 'trees_A_large'],
  B: ['tree_single_B', 'trees_B_small', 'trees_B_medium', 'trees_B_large'],
}

const TreeMeshNames = [...TreesByType.A, ...TreesByType.B]

// Building meshes
const BuildingMeshNames = [
  'building_home_A_yellow',
  'building_home_B_yellow',
  'building_church_yellow',
  'building_tower_A_yellow',
]

// Bridge meshes
const BridgeMeshNames = [
  'building_bridge_A',
  'building_bridge_B',
]

// Default white color for decorations (no tinting)
const WHITE = new Color(0xffffff)

// Instance limits for BatchedMesh
const MAX_TREES = 300
const MAX_BUILDINGS = 20
const MAX_BRIDGES = 50

export class Decorations {
  constructor(scene, worldOffset = { x: 0, z: 0 }) {
    this.scene = scene
    this.worldOffset = worldOffset
    this.treeMesh = null
    this.trees = []
    this.treeGeoms = new Map()      // meshName -> geometry
    this.treeGeomIds = new Map()    // meshName -> geomId in BatchedMesh

    this.buildingMesh = null
    this.buildings = []
    this.buildingGeoms = new Map()
    this.buildingGeomIds = new Map()

    this.bridgeMesh = null
    this.bridges = []
    this.bridgeGeoms = new Map()
    this.bridgeGeomIds = new Map()

    this.dummy = new Object3D()
  }

  async init(gltfScene, material) {
    // Load tree geometries from already-loaded GLB scene
    for (const meshName of TreeMeshNames) {
      const geom = this.findGeometry(gltfScene, meshName)
      if (geom) this.treeGeoms.set(meshName, geom)
    }

    if (this.treeGeoms.size === 0) {
      console.warn('Decorations: No tree meshes found in GLB')
      return
    }

    // Create BatchedMesh for trees
    let totalV = 0, totalI = 0
    for (const geom of this.treeGeoms.values()) {
      totalV += geom.attributes.position.count
      totalI += geom.index ? geom.index.count : 0
    }

    this.treeMesh = new BatchedMesh(MAX_TREES, totalV * 2, totalI * 2, material)
    this.treeMesh.castShadow = true
    this.treeMesh.receiveShadow = true
    this.treeMesh.frustumCulled = false
    this.scene.add(this.treeMesh)

    // Register geometries
    for (const [name, geom] of this.treeGeoms) {
      const geomId = this.treeMesh.addGeometry(geom)
      this.treeGeomIds.set(name, geomId)
    }

    // Initialize color buffer with a dummy white instance (fixes WebGPU color sync issue)
    // This ensures setColorAt is called before first render
    const firstGeomId = this.treeGeomIds.values().next().value
    this.treeMesh._dummyInstanceId = this.treeMesh.addInstance(firstGeomId)
    this.treeMesh.setColorAt(this.treeMesh._dummyInstanceId, WHITE)
    this.dummy.position.set(0, -1000, 0) // Hide off-screen
    this.dummy.scale.setScalar(0)
    this.dummy.updateMatrix()
    this.treeMesh.setMatrixAt(this.treeMesh._dummyInstanceId, this.dummy.matrix)

    // Load building geometries
    for (const meshName of BuildingMeshNames) {
      const geom = this.findGeometry(gltfScene, meshName)
      if (geom) this.buildingGeoms.set(meshName, geom)
    }

    if (this.buildingGeoms.size > 0) {
      let bTotalV = 0, bTotalI = 0
      for (const geom of this.buildingGeoms.values()) {
        bTotalV += geom.attributes.position.count
        bTotalI += geom.index ? geom.index.count : 0
      }

      this.buildingMesh = new BatchedMesh(MAX_BUILDINGS, bTotalV * 2, bTotalI * 2, material)
      this.buildingMesh.castShadow = true
      this.buildingMesh.receiveShadow = true
      this.buildingMesh.frustumCulled = false
      this.scene.add(this.buildingMesh)

      for (const [name, geom] of this.buildingGeoms) {
        const geomId = this.buildingMesh.addGeometry(geom)
        this.buildingGeomIds.set(name, geomId)
      }

      // Initialize color buffer with dummy instance
      const firstBuildingGeomId = this.buildingGeomIds.values().next().value
      this.buildingMesh._dummyInstanceId = this.buildingMesh.addInstance(firstBuildingGeomId)
      this.buildingMesh.setColorAt(this.buildingMesh._dummyInstanceId, WHITE)
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.buildingMesh.setMatrixAt(this.buildingMesh._dummyInstanceId, this.dummy.matrix)
    }

    // Load bridge geometries
    for (const meshName of BridgeMeshNames) {
      const geom = this.findGeometry(gltfScene, meshName)
      if (geom) this.bridgeGeoms.set(meshName, geom)
    }

    if (this.bridgeGeoms.size > 0) {
      let brTotalV = 0, brTotalI = 0
      for (const geom of this.bridgeGeoms.values()) {
        brTotalV += geom.attributes.position.count
        brTotalI += geom.index ? geom.index.count : 0
      }

      this.bridgeMesh = new BatchedMesh(MAX_BRIDGES, brTotalV * 2, brTotalI * 2, material)
      this.bridgeMesh.castShadow = true
      this.bridgeMesh.receiveShadow = true
      this.bridgeMesh.frustumCulled = false
      this.scene.add(this.bridgeMesh)

      for (const [name, geom] of this.bridgeGeoms) {
        const geomId = this.bridgeMesh.addGeometry(geom)
        this.bridgeGeomIds.set(name, geomId)
      }

      // Initialize color buffer with dummy instance
      const firstBridgeGeomId = this.bridgeGeomIds.values().next().value
      this.bridgeMesh._dummyInstanceId = this.bridgeMesh.addInstance(firstBridgeGeomId)
      this.bridgeMesh.setColorAt(this.bridgeMesh._dummyInstanceId, WHITE)
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.bridgeMesh.setMatrixAt(this.bridgeMesh._dummyInstanceId, this.dummy.matrix)
    }
  }

  findGeometry(gltfScene, meshName) {
    let geom = null
    gltfScene.traverse((child) => {
      if (child.name === meshName && child.geometry) {
        geom = child.geometry.clone()
        geom.computeBoundingBox()
        const { min } = geom.boundingBox
        geom.translate(0, -min.y, 0)  // Sit on ground
        geom.computeBoundingSphere()
      }
    })
    return geom
  }

  populate(hexTiles, gridRadius, options = {}) {
    this.clearTrees()

    if (!this.treeMesh || this.treeGeomIds.size === 0) return
    if (!globalNoiseA || !globalNoiseB) return  // Need global noise initialized

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1  // Height of tile mesh surface above base
    const threshold = currentTreeThreshold  // noise > threshold = tree
    const { x: offsetX, z: offsetZ } = this.worldOffset

    for (const tile of hexTiles) {
      // Only flat grass tiles (not slopes)
      if (tile.type !== TileType.GRASS) continue

      // Get local position (relative to grid group)
      const localPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      // Use world position for noise sampling (consistent across grids)
      const worldX = localPos.x + offsetX
      const worldZ = localPos.z + offsetZ
      const noiseA = globalNoiseA.scaled2D(worldX, worldZ)
      const noiseB = globalNoiseB.scaled2D(worldX, worldZ)

      const aAbove = noiseA >= threshold
      const bAbove = noiseB >= threshold

      // Skip if neither noise field is above threshold
      if (!aAbove && !bAbove) continue

      // Determine tree type: if both overlap, higher noise value wins
      let treeType, noiseVal
      if (aAbove && bAbove) {
        treeType = noiseA >= noiseB ? 'A' : 'B'
        noiseVal = treeType === 'A' ? noiseA : noiseB
      } else if (aAbove) {
        treeType = 'A'
        noiseVal = noiseA
      } else {
        treeType = 'B'
        noiseVal = noiseB
      }

      // Check instance limit before adding
      if (this.trees.length >= MAX_TREES - 1) {  // -1 for dummy instance
        console.warn(`Decorations: Tree instance limit (${MAX_TREES}) reached`)
        break
      }

      // Map noise value to density tier (0-3)
      // threshold..1.0 maps to single -> small -> medium -> large
      const normalizedNoise = (noiseVal - threshold) / (1 - threshold)  // 0..1
      const tierIndex = Math.min(3, Math.floor(normalizedNoise * 4))
      const meshName = TreesByType[treeType][tierIndex]
      const geomId = this.treeGeomIds.get(meshName)
      const instanceId = this.treeMesh.addInstance(geomId)
      this.treeMesh.setColorAt(instanceId, WHITE)

      // Position at tile center (local coords since mesh is in group)
      const rotationY = random() * Math.PI * 2
      this.dummy.position.set(
        localPos.x,
        tile.level * LEVEL_HEIGHT + TILE_SURFACE,
        localPos.z
      )
      this.dummy.rotation.y = rotationY
      this.dummy.scale.setScalar(1)
      this.dummy.updateMatrix()

      this.treeMesh.setMatrixAt(instanceId, this.dummy.matrix)
      this.trees.push({ tile, meshName, instanceId, rotationY })
    }
  }

  populateBuildings(hexTiles, hexGrid, gridRadius, options = {}) {
    this.clearBuildings()

    if (!this.buildingMesh || this.buildingGeomIds.size === 0) return

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1
    const maxBuildings = options.maxBuildings ?? (2 + Math.floor(random() * 11))
    const buildingNames = [...this.buildingGeomIds.keys()]

    // Direction to angle mapping (building front is S/+Z, angle rotates to face direction)
    const dirToAngle = {
      'NE': Math.PI / 3,
      'E': Math.PI / 2,
      'SE': 2 * Math.PI / 3,
      'SW': -2 * Math.PI / 3,
      'W': -Math.PI / 2,
      'NW': -Math.PI / 3,
    }

    const deadEndCandidates = []
    const roadAdjacentCandidates = []
    const size = gridRadius * 2 + 1

    // Get tiles that already have trees
    const treeTileIds = new Set(this.trees.map(t => t.tile.id))

    for (const tile of hexTiles) {
      // Skip tiles that already have trees
      if (treeTileIds.has(tile.id)) continue

      // Check for road dead-ends - place building facing the road exit
      const deadEndInfo = getRoadDeadEndInfo(tile.type, tile.rotation)
      if (deadEndInfo.isDeadEnd) {
        const roadAngle = dirToAngle[deadEndInfo.exitDir] ?? 0
        deadEndCandidates.push({ tile, roadAngle })
        continue
      }

      // Only consider grass tiles for road-adjacent placement
      if (tile.type !== TileType.GRASS) continue

      // Check if any neighbor has a road, track direction to road
      // Building front is S (+Z), so angle rotates front to face the road
      const dirOffsets = [
        { dx: 1, dz: 0 },   // E
        { dx: -1, dz: 0 },  // W
        { dx: 0, dz: 1 },   // S
        { dx: 0, dz: -1 },  // N
        { dx: 1, dz: -1 },  // NE
        { dx: -1, dz: 1 },  // SW
      ]
      let roadAngle = null
      for (const { dx, dz } of dirOffsets) {
        const nx = tile.gridX + dx
        const nz = tile.gridZ + dz
        if (nx >= 0 && nx < size && nz >= 0 && nz < size) {
          const neighbor = hexGrid[nx]?.[nz]
          if (neighbor && hasRoadEdge(neighbor.type)) {
            // Compute angle to face front (+Z) toward road direction
            roadAngle = -Math.atan2(dx, dz)
            break
          }
        }
      }

      // Only include road-adjacent tiles
      if (roadAngle !== null) {
        roadAdjacentCandidates.push({ tile, roadAngle })
      }
    }

    // Shuffle each group separately
    for (let i = deadEndCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[deadEndCandidates[i], deadEndCandidates[j]] = [deadEndCandidates[j], deadEndCandidates[i]]
    }
    for (let i = roadAdjacentCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[roadAdjacentCandidates[i], roadAdjacentCandidates[j]] = [roadAdjacentCandidates[j], roadAdjacentCandidates[i]]
    }

    // Dead-ends first, then road-adjacent
    const candidates = [...deadEndCandidates, ...roadAdjacentCandidates]

    // Place buildings
    for (let i = 0; i < Math.min(maxBuildings, candidates.length); i++) {
      const { tile, roadAngle } = candidates[i]
      const meshName = buildingNames[Math.floor(random() * buildingNames.length)]
      const geomId = this.buildingGeomIds.get(meshName)
      const instanceId = this.buildingMesh.addInstance(geomId)
      this.buildingMesh.setColorAt(instanceId, WHITE)

      const localPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )

      this.dummy.position.set(
        localPos.x,
        tile.level * LEVEL_HEIGHT + TILE_SURFACE,
        localPos.z
      )
      // Face the road
      this.dummy.rotation.y = roadAngle
      this.dummy.scale.setScalar(1)
      this.dummy.updateMatrix()

      this.buildingMesh.setMatrixAt(instanceId, this.dummy.matrix)
      this.buildings.push({ tile, meshName, instanceId, rotationY: roadAngle })
    }
  }

  populateBridges(hexTiles, gridRadius) {
    this.clearBridges()

    if (!this.bridgeMesh || this.bridgeGeomIds.size === 0) return

    const LEVEL_HEIGHT = 0.5

    for (const tile of hexTiles) {
      // Only river crossing tiles
      if (tile.type !== TileType.RIVER_CROSSING_A &&
          tile.type !== TileType.RIVER_CROSSING_B) continue

      // Pick matching bridge mesh
      const meshName = tile.type === TileType.RIVER_CROSSING_A
        ? 'building_bridge_A'
        : 'building_bridge_B'

      const geomId = this.bridgeGeomIds.get(meshName)
      if (geomId === undefined) continue

      const instanceId = this.bridgeMesh.addInstance(geomId)
      this.bridgeMesh.setColorAt(instanceId, WHITE)

      const localPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )

      this.dummy.position.set(
        localPos.x,
        tile.level * LEVEL_HEIGHT,
        localPos.z
      )
      // Match tile rotation (60° steps, same as hex tiles)
      this.dummy.rotation.y = -tile.rotation * Math.PI / 3
      this.dummy.scale.setScalar(1)
      this.dummy.updateMatrix()

      this.bridgeMesh.setMatrixAt(instanceId, this.dummy.matrix)
      this.bridges.push({ tile, meshName, instanceId })
    }
  }

  clear() {
    this.clearTrees()
    this.clearBuildings()
    this.clearBridges()
  }

  clearTrees() {
    if (!this.treeMesh) return
    for (const tree of this.trees) {
      this.treeMesh.deleteInstance(tree.instanceId)
    }
    this.trees = []
  }

  clearBuildings() {
    if (!this.buildingMesh) return
    for (const building of this.buildings) {
      this.buildingMesh.deleteInstance(building.instanceId)
    }
    this.buildings = []
  }

  clearBridges() {
    if (!this.bridgeMesh) return
    for (const bridge of this.bridges) {
      this.bridgeMesh.deleteInstance(bridge.instanceId)
    }
    this.bridges = []
  }

  /**
   * Dispose of all resources
   */
  dispose() {
    this.clear()

    if (this.treeMesh) {
      this.scene.remove(this.treeMesh)
      this.treeMesh.dispose()
      this.treeMesh = null
    }

    if (this.buildingMesh) {
      this.scene.remove(this.buildingMesh)
      this.buildingMesh.dispose()
      this.buildingMesh = null
    }

    if (this.bridgeMesh) {
      this.scene.remove(this.bridgeMesh)
      this.bridgeMesh.dispose()
      this.bridgeMesh = null
    }

    this.treeGeoms.clear()
    this.treeGeomIds.clear()
    this.buildingGeoms.clear()
    this.buildingGeomIds.clear()
    this.bridgeGeoms.clear()
    this.bridgeGeomIds.clear()
  }
}
