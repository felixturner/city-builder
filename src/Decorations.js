import { Object3D, BatchedMesh, Color } from 'three/webgpu'
import { TILE_LIST, TileType } from './HexTileData.js'
import { HexTileGeometry } from './HexTiles.js'
import FastSimplexNoise from '@webvoxel/fast-simplex-noise'
import { random } from './SeededRandom.js'
import gsap from 'gsap'

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

// Pick a random item from a weighted defs array [{ name, weight }]
function weightedPick(defs) {
  const total = defs.reduce((sum, d) => sum + d.weight, 0)
  let r = random() * total
  for (const d of defs) {
    r -= d.weight
    if (r <= 0) return d.name
  }
  return defs[defs.length - 1].name
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
const BuildingDefs = [
  { name: 'building_home_A_yellow', weight: 10 },
  { name: 'building_home_B_yellow', weight: 6 },
  { name: 'building_church_yellow', weight: 2 },
  { name: 'building_tower_A_yellow', weight: 2 },
  { name: 'building_townhall_yellow', weight: 1 },
]

// Rural buildings — placed away from roads on flat grass
const RuralBuildingDefs = [
  { name: 'building_shrine_yellow', weight: 1 },
  { name: 'building_well_yellow', weight: 5 },
]

const BuildingMeshNames = BuildingDefs.map(b => b.name)
const RuralBuildingMeshNames = RuralBuildingDefs.map(b => b.name)

// Windmill (3-part composite building)
const WindmillMeshNames = [
  'building_windmill_yellow',       // base
  'building_windmill_top_yellow',   // top section
  'building_windmill_top_fan_yellow', // fan blades
]
// Offsets relative to base (from GLB hierarchy transforms)
const WINDMILL_TOP_OFFSET = { x: 0, y: 0.685, z: 0 }
const WINDMILL_FAN_OFFSET = { x: 0, y: 0.957, z: 0.332 }

// Bridge meshes
const BridgeMeshNames = [
  'building_bridge_A',
  'building_bridge_B',
]

// Waterlily meshes (placed on river tiles)
const WaterlilyMeshNames = [
  'waterlily_A',
  'waterlily_B',
]

// Flower meshes (placed on grass tiles)
const FlowerMeshNames = [
  'waterplant_A',
  'waterplant_B',
  'waterplant_C',
]

// Rock meshes (placed near cliffs and slopes)
const RockMeshNames = [
  'rock_single_A',
  'rock_single_B',
  'rock_single_C',
  'rock_single_D',
  'rock_single_E',
]

// Hill meshes (placed on 1-level cliffs)
const HillDefs = [
  { name: 'hills_A', weight: 5 },
  { name: 'hills_A_trees', weight: 10 },
  { name: 'hills_B', weight: 5 },
  { name: 'hills_B_trees', weight: 10 },
  { name: 'hills_C', weight: 5 },
  { name: 'hills_C_trees', weight: 10 },
]

// Mountain meshes (placed on 2-level cliffs)
const MountainDefs = [
  // { name: 'mountain_A', weight: 1 },
  // { name: 'mountain_B', weight: 1 },
  // { name: 'mountain_C', weight: 1 },
  { name: 'mountain_A_grass', weight: 3 },
  { name: 'mountain_B_grass', weight: 3 },
  { name: 'mountain_C_grass', weight: 3 },
  { name: 'mountain_A_grass_trees', weight: 2 },
  { name: 'mountain_B_grass_trees', weight: 2 },
  { name: 'mountain_C_grass_trees', weight: 2 },
]

const HillMeshNames = HillDefs.map(h => h.name)
const MountainMeshNames = MountainDefs.map(m => m.name)

// Default white color for decorations (no tinting)
const WHITE = new Color(0xffffff)

// Instance limits for BatchedMesh
const MAX_TREES = 300
const MAX_BUILDINGS = 20
const MAX_BRIDGES = 50
const MAX_WATERLILIES = 100
const MAX_FLOWERS = 200
const MAX_ROCKS = 100
const MAX_HILLS = 10
const MAX_MOUNTAINS = 10

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
    this.windmillFans = []  // { instanceId, x, y, z, baseRotationY }

    this.bridgeMesh = null
    this.bridges = []
    this.bridgeGeoms = new Map()
    this.bridgeGeomIds = new Map()

    this.waterlilyMesh = null
    this.waterlilies = []
    this.waterlilyGeoms = new Map()
    this.waterlilyGeomIds = new Map()

    this.flowerMesh = null
    this.flowers = []
    this.flowerGeoms = new Map()
    this.flowerGeomIds = new Map()

    this.rockMesh = null
    this.rocks = []
    this.rockGeoms = new Map()
    this.rockGeomIds = new Map()

    this.hillMesh = null
    this.hills = []
    this.hillGeoms = new Map()
    this.hillGeomIds = new Map()

    this.mountainMesh = null
    this.mountains = []
    this.mountainGeoms = new Map()
    this.mountainGeomIds = new Map()

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

    // Load building geometries (includes windmill parts + rural buildings)
    for (const meshName of [...BuildingMeshNames, ...RuralBuildingMeshNames, ...WindmillMeshNames]) {
      const isFan = meshName === 'building_windmill_top_fan_yellow'
      const geom = this.findGeometry(gltfScene, meshName, { center: isFan })
      if (geom) this.buildingGeoms.set(meshName, geom)
      else if (WindmillMeshNames.includes(meshName)) console.warn(`[Windmill] missing geometry: ${meshName}`)
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

    // Load waterlily geometries
    for (const meshName of WaterlilyMeshNames) {
      const geom = this.findGeometry(gltfScene, meshName)
      if (geom) this.waterlilyGeoms.set(meshName, geom)
    }

    if (this.waterlilyGeoms.size > 0) {
      let wlTotalV = 0, wlTotalI = 0
      for (const geom of this.waterlilyGeoms.values()) {
        wlTotalV += geom.attributes.position.count
        wlTotalI += geom.index ? geom.index.count : 0
      }

      this.waterlilyMesh = new BatchedMesh(MAX_WATERLILIES, wlTotalV * 2, wlTotalI * 2, material)
      this.waterlilyMesh.castShadow = true
      this.waterlilyMesh.receiveShadow = true
      this.waterlilyMesh.frustumCulled = false
      this.scene.add(this.waterlilyMesh)

      for (const [name, geom] of this.waterlilyGeoms) {
        const geomId = this.waterlilyMesh.addGeometry(geom)
        this.waterlilyGeomIds.set(name, geomId)
      }

      const firstWlGeomId = this.waterlilyGeomIds.values().next().value
      this.waterlilyMesh._dummyInstanceId = this.waterlilyMesh.addInstance(firstWlGeomId)
      this.waterlilyMesh.setColorAt(this.waterlilyMesh._dummyInstanceId, WHITE)
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.waterlilyMesh.setMatrixAt(this.waterlilyMesh._dummyInstanceId, this.dummy.matrix)
    }

    // Load flower geometries
    for (const meshName of FlowerMeshNames) {
      const geom = this.findGeometry(gltfScene, meshName)
      if (geom) this.flowerGeoms.set(meshName, geom)
    }

    if (this.flowerGeoms.size > 0) {
      let flTotalV = 0, flTotalI = 0
      for (const geom of this.flowerGeoms.values()) {
        flTotalV += geom.attributes.position.count
        flTotalI += geom.index ? geom.index.count : 0
      }

      this.flowerMesh = new BatchedMesh(MAX_FLOWERS, flTotalV * 2, flTotalI * 2, material)
      this.flowerMesh.castShadow = true
      this.flowerMesh.receiveShadow = true
      this.flowerMesh.frustumCulled = false
      this.scene.add(this.flowerMesh)

      for (const [name, geom] of this.flowerGeoms) {
        const geomId = this.flowerMesh.addGeometry(geom)
        this.flowerGeomIds.set(name, geomId)
      }

      const firstFlGeomId = this.flowerGeomIds.values().next().value
      this.flowerMesh._dummyInstanceId = this.flowerMesh.addInstance(firstFlGeomId)
      this.flowerMesh.setColorAt(this.flowerMesh._dummyInstanceId, WHITE)
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.flowerMesh.setMatrixAt(this.flowerMesh._dummyInstanceId, this.dummy.matrix)
    }

    // Load rock geometries
    for (const meshName of RockMeshNames) {
      const geom = this.findGeometry(gltfScene, meshName)
      if (geom) this.rockGeoms.set(meshName, geom)
    }

    if (this.rockGeoms.size > 0) {
      let rkTotalV = 0, rkTotalI = 0
      for (const geom of this.rockGeoms.values()) {
        rkTotalV += geom.attributes.position.count
        rkTotalI += geom.index ? geom.index.count : 0
      }

      this.rockMesh = new BatchedMesh(MAX_ROCKS, rkTotalV * 2, rkTotalI * 2, material)
      this.rockMesh.castShadow = true
      this.rockMesh.receiveShadow = true
      this.rockMesh.frustumCulled = false
      this.scene.add(this.rockMesh)

      for (const [name, geom] of this.rockGeoms) {
        const geomId = this.rockMesh.addGeometry(geom)
        this.rockGeomIds.set(name, geomId)
      }

      const firstRkGeomId = this.rockGeomIds.values().next().value
      this.rockMesh._dummyInstanceId = this.rockMesh.addInstance(firstRkGeomId)
      this.rockMesh.setColorAt(this.rockMesh._dummyInstanceId, WHITE)
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.rockMesh.setMatrixAt(this.rockMesh._dummyInstanceId, this.dummy.matrix)
    }

    // Load hill geometries
    for (const meshName of HillMeshNames) {
      const geom = this.findGeometry(gltfScene, meshName)
      if (geom) this.hillGeoms.set(meshName, geom)
    }

    if (this.hillGeoms.size > 0) {
      let hlTotalV = 0, hlTotalI = 0
      for (const geom of this.hillGeoms.values()) {
        hlTotalV += geom.attributes.position.count
        hlTotalI += geom.index ? geom.index.count : 0
      }

      this.hillMesh = new BatchedMesh(MAX_HILLS, hlTotalV * 2, hlTotalI * 2, material)
      this.hillMesh.castShadow = true
      this.hillMesh.receiveShadow = true
      this.hillMesh.frustumCulled = false
      this.scene.add(this.hillMesh)

      for (const [name, geom] of this.hillGeoms) {
        const geomId = this.hillMesh.addGeometry(geom)
        this.hillGeomIds.set(name, geomId)
      }

      const firstHlGeomId = this.hillGeomIds.values().next().value
      this.hillMesh._dummyInstanceId = this.hillMesh.addInstance(firstHlGeomId)
      this.hillMesh.setColorAt(this.hillMesh._dummyInstanceId, WHITE)
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.hillMesh.setMatrixAt(this.hillMesh._dummyInstanceId, this.dummy.matrix)
    }

    // Load mountain geometries
    for (const meshName of MountainMeshNames) {
      const geom = this.findGeometry(gltfScene, meshName)
      if (geom) this.mountainGeoms.set(meshName, geom)
    }

    if (this.mountainGeoms.size > 0) {
      let mtTotalV = 0, mtTotalI = 0
      for (const geom of this.mountainGeoms.values()) {
        mtTotalV += geom.attributes.position.count
        mtTotalI += geom.index ? geom.index.count : 0
      }

      this.mountainMesh = new BatchedMesh(MAX_MOUNTAINS, mtTotalV * 2, mtTotalI * 2, material)
      this.mountainMesh.castShadow = true
      this.mountainMesh.receiveShadow = true
      this.mountainMesh.frustumCulled = false
      this.scene.add(this.mountainMesh)

      for (const [name, geom] of this.mountainGeoms) {
        const geomId = this.mountainMesh.addGeometry(geom)
        this.mountainGeomIds.set(name, geomId)
      }

      const firstMtGeomId = this.mountainGeomIds.values().next().value
      this.mountainMesh._dummyInstanceId = this.mountainMesh.addInstance(firstMtGeomId)
      this.mountainMesh.setColorAt(this.mountainMesh._dummyInstanceId, WHITE)
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.mountainMesh.setMatrixAt(this.mountainMesh._dummyInstanceId, this.dummy.matrix)
    }
  }

  findGeometry(gltfScene, meshName, { center = false } = {}) {
    let geom = null
    gltfScene.traverse((child) => {
      if (child.name === meshName && child.geometry) {
        geom = child.geometry.clone()
        geom.computeBoundingBox()
        if (center) {
          // Center on bounding box center (for rotation pivots)
          const { min, max } = geom.boundingBox
          geom.translate(-(min.x + max.x) / 2, -(min.y + max.y) / 2, -(min.z + max.z) / 2)
        } else {
          // Sit on ground
          geom.translate(0, -geom.boundingBox.min.y, 0)
        }
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

      // Position at tile center with random offset (local coords since mesh is in group)
      const rotationY = random() * Math.PI * 2
      const ox = (random() - 0.5) * 1.0
      const oz = (random() - 0.5) * 1.0
      this.dummy.position.set(
        localPos.x + ox,
        tile.level * LEVEL_HEIGHT + TILE_SURFACE,
        localPos.z + oz
      )
      this.dummy.rotation.y = rotationY
      this.dummy.scale.setScalar(1)
      this.dummy.updateMatrix()

      this.treeMesh.setMatrixAt(instanceId, this.dummy.matrix)
      this.trees.push({ tile, meshName, instanceId, rotationY, ox, oz })
    }
  }

  populateBuildings(hexTiles, hexGrid, gridRadius, options = {}) {
    this.clearBuildings()

    if (!this.buildingMesh || this.buildingGeomIds.size === 0) return

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1
    const maxBuildings = options.maxBuildings ?? Math.floor(random() * 11)
    const maxRuralBuildings = Math.floor(random() * 4)  // 0-3
    const buildingNames = [...BuildingMeshNames].filter(n => this.buildingGeomIds.has(n))
    const ruralNames = [...RuralBuildingMeshNames].filter(n => this.buildingGeomIds.has(n))
    const hasWindmill = WindmillMeshNames.every(n => this.buildingGeomIds.has(n))

    // Direction to Y-rotation mapping (building front is +Z, atan2(worldX, worldZ) for each hex dir)
    const dirToAngle = {
      'NE': 5 * Math.PI / 6,
      'E': Math.PI / 2,
      'SE': Math.PI / 6,
      'SW': -Math.PI / 6,
      'W': -Math.PI / 2,
      'NW': -5 * Math.PI / 6,
    }

    const deadEndCandidates = []
    const roadAdjacentCandidates = []
    const flatGrassCandidates = []
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

      if (roadAngle !== null) {
        roadAdjacentCandidates.push({ tile, roadAngle })
      } else if (tile.level === 0) {
        // Flat grass with no road neighbor — lowest priority
        const randomAngle = random() * Math.PI * 2
        flatGrassCandidates.push({ tile, roadAngle: randomAngle })
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
    for (let i = flatGrassCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[flatGrassCandidates[i], flatGrassCandidates[j]] = [flatGrassCandidates[j], flatGrassCandidates[i]]
    }

    // Dead-ends first, then road-adjacent (no flat grass for road buildings)
    const candidates = [...deadEndCandidates, ...roadAdjacentCandidates]

    // Place road buildings
    for (let i = 0; i < Math.min(maxBuildings, candidates.length); i++) {
      const { tile, roadAngle } = candidates[i]

      const localPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      const baseY = tile.level * LEVEL_HEIGHT + TILE_SURFACE

      // Small chance of windmill instead of regular building
      const isWindmill = hasWindmill && random() < 0.1

      if (isWindmill) {
        // Place windmill base
        const baseGeomId = this.buildingGeomIds.get('building_windmill_yellow')
        const baseInstanceId = this.buildingMesh.addInstance(baseGeomId)
        this.buildingMesh.setColorAt(baseInstanceId, WHITE)
        this.dummy.position.set(localPos.x, baseY, localPos.z)
        this.dummy.rotation.y = roadAngle
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()
        this.buildingMesh.setMatrixAt(baseInstanceId, this.dummy.matrix)
        this.buildings.push({ tile, meshName: 'building_windmill_yellow', instanceId: baseInstanceId, rotationY: roadAngle, oy: 0 })

        // Place windmill top (offset relative to base, rotated by roadAngle)
        const topGeomId = this.buildingGeomIds.get('building_windmill_top_yellow')
        const topInstanceId = this.buildingMesh.addInstance(topGeomId)
        this.buildingMesh.setColorAt(topInstanceId, WHITE)
        const cosA = Math.cos(roadAngle), sinA = Math.sin(roadAngle)
        const topOx = WINDMILL_TOP_OFFSET.x * cosA + WINDMILL_TOP_OFFSET.z * sinA
        const topOz = -WINDMILL_TOP_OFFSET.x * sinA + WINDMILL_TOP_OFFSET.z * cosA
        this.dummy.position.set(localPos.x + topOx, baseY + WINDMILL_TOP_OFFSET.y, localPos.z + topOz)
        this.dummy.rotation.y = roadAngle
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()
        this.buildingMesh.setMatrixAt(topInstanceId, this.dummy.matrix)
        this.buildings.push({ tile, meshName: 'building_windmill_top_yellow', instanceId: topInstanceId, rotationY: roadAngle, oy: WINDMILL_TOP_OFFSET.y })

        // Place windmill fan (offset relative to base, rotated by roadAngle)
        const fanGeomId = this.buildingGeomIds.get('building_windmill_top_fan_yellow')
        const fanInstanceId = this.buildingMesh.addInstance(fanGeomId)
        this.buildingMesh.setColorAt(fanInstanceId, WHITE)
        const fanOx = WINDMILL_FAN_OFFSET.x * cosA + WINDMILL_FAN_OFFSET.z * sinA
        const fanOz = -WINDMILL_FAN_OFFSET.x * sinA + WINDMILL_FAN_OFFSET.z * cosA
        const fanX = localPos.x + fanOx
        const fanY = baseY + WINDMILL_FAN_OFFSET.y
        const fanZ = localPos.z + fanOz
        this.dummy.position.set(fanX, fanY, fanZ)
        this.dummy.rotation.y = roadAngle
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()
        this.buildingMesh.setMatrixAt(fanInstanceId, this.dummy.matrix)
        this.buildings.push({ tile, meshName: 'building_windmill_top_fan_yellow', instanceId: fanInstanceId, rotationY: roadAngle, oy: WINDMILL_FAN_OFFSET.y, oz: fanOz, ox: fanOx })
        const fan = { instanceId: fanInstanceId, x: fanX, y: fanY, z: fanZ, baseRotationY: roadAngle, spin: { angle: 0 } }
        fan.tween = gsap.to(fan.spin, {
          angle: Math.PI * 2,
          duration: 4,
          repeat: -1,
          ease: 'none',
          onUpdate: () => {
            this.dummy.position.set(fan.x, fan.y, fan.z)
            this.dummy.rotation.set(0, fan.baseRotationY, 0)
            this.dummy.rotateZ(fan.spin.angle)
            this.dummy.scale.setScalar(1)
            this.dummy.updateMatrix()
            try { this.buildingMesh.setMatrixAt(fan.instanceId, this.dummy.matrix) } catch (_) {}
          }
        })
        this.windmillFans.push(fan)
      } else {
        const meshName = weightedPick(BuildingDefs)
        const geomId = this.buildingGeomIds.get(meshName)
        const instanceId = this.buildingMesh.addInstance(geomId)
        this.buildingMesh.setColorAt(instanceId, WHITE)

        this.dummy.position.set(localPos.x, baseY, localPos.z)
        this.dummy.rotation.y = roadAngle
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()

        this.buildingMesh.setMatrixAt(instanceId, this.dummy.matrix)
        this.buildings.push({ tile, meshName, instanceId, rotationY: roadAngle })
      }
    }

    // Place rural buildings (shrine, tent, well) on flat grass away from roads
    if (ruralNames.length > 0) {
      for (let i = 0; i < Math.min(maxRuralBuildings, flatGrassCandidates.length); i++) {
        const { tile, roadAngle } = flatGrassCandidates[i]
        const localPos = HexTileGeometry.getWorldPosition(
          tile.gridX - gridRadius,
          tile.gridZ - gridRadius
        )
        const baseY = tile.level * LEVEL_HEIGHT + TILE_SURFACE

        const meshName = weightedPick(RuralBuildingDefs)
        const geomId = this.buildingGeomIds.get(meshName)
        const instanceId = this.buildingMesh.addInstance(geomId)
        this.buildingMesh.setColorAt(instanceId, WHITE)

        this.dummy.position.set(localPos.x, baseY, localPos.z)
        this.dummy.rotation.y = roadAngle
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()

        this.buildingMesh.setMatrixAt(instanceId, this.dummy.matrix)
        this.buildings.push({ tile, meshName, instanceId, rotationY: roadAngle })
      }
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

  populateWaterlilies(hexTiles, gridRadius) {
    this.clearWaterlilies()

    if (!this.waterlilyMesh || this.waterlilyGeomIds.size === 0) return

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1
    const lilyNames = [...this.waterlilyGeomIds.keys()]

    for (const tile of hexTiles) {
      // River tiles (not crossings — those have bridges) and coast tiles
      const tileName = TILE_LIST[tile.type]?.name
      if (!tileName) continue
      const isRiver = tileName.startsWith('RIVER_') && !tileName.startsWith('RIVER_CROSSING')
      const isCoast = tileName.startsWith('COAST_')
      if (!isRiver && !isCoast) continue

      // Random chance to skip (not every river tile gets lilies)
      if (random() > 0.075) continue

      if (this.waterlilies.length >= MAX_WATERLILIES - 1) break

      const meshName = lilyNames[Math.floor(random() * lilyNames.length)]
      const geomId = this.waterlilyGeomIds.get(meshName)
      const instanceId = this.waterlilyMesh.addInstance(geomId)
      this.waterlilyMesh.setColorAt(instanceId, WHITE)

      const localPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      const ox = (random() - 0.5) * 0.3
      const oz = (random() - 0.5) * 0.3
      const rotationY = random() * Math.PI * 2

      this.dummy.position.set(localPos.x + ox, tile.level * LEVEL_HEIGHT + TILE_SURFACE, localPos.z + oz)
      this.dummy.rotation.y = rotationY
      this.dummy.scale.setScalar(2)
      this.dummy.updateMatrix()

      this.waterlilyMesh.setMatrixAt(instanceId, this.dummy.matrix)
      this.waterlilies.push({ tile, meshName, instanceId, rotationY, ox: ox, oz: oz })
    }
  }

  populateFlowers(hexTiles, gridRadius) {
    this.clearFlowers()

    if (!this.flowerMesh || this.flowerGeomIds.size === 0) return

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1
    const flowerNames = [...this.flowerGeomIds.keys()]
    const { x: offsetX, z: offsetZ } = this.worldOffset
    const hasNoise = globalNoiseA && globalNoiseB

    // Exclude tiles with buildings only (flowers can share with trees)
    const buildingTileIds = new Set(this.buildings.map(b => b.tile.id))

    // Score candidate tiles by noise value
    const candidates = []
    for (const tile of hexTiles) {
      if (tile.type !== TileType.GRASS) continue
      if (buildingTileIds.has(tile.id)) continue

      const localPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      let noise = random()
      if (hasNoise) {
        const worldX = localPos.x + offsetX
        const worldZ = localPos.z + offsetZ
        noise = Math.max(globalNoiseA.scaled2D(worldX, worldZ), globalNoiseB.scaled2D(worldX, worldZ))
      }
      candidates.push({ tile, localPos, noise })
    }

    // Sort by closeness to just below tree threshold (tight forest edges)
    const target = currentTreeThreshold + 0.05
    candidates.sort((a, b) => Math.abs(a.noise - target) - Math.abs(b.noise - target))
    const budget = 7 + Math.floor(random() * 15)  // 7-21
    const selected = candidates.slice(0, budget)

    for (const { tile, localPos, noise } of selected) {
      // Higher noise = more flowers per tile (1-3)
      const count = 1 + Math.floor(noise * 2.99)

      for (let f = 0; f < count; f++) {
        if (this.flowers.length >= MAX_FLOWERS - 1) break

        const meshName = flowerNames[Math.floor(random() * flowerNames.length)]
        const geomId = this.flowerGeomIds.get(meshName)
        const instanceId = this.flowerMesh.addInstance(geomId)
        this.flowerMesh.setColorAt(instanceId, WHITE)

        const ox = (random() - 0.5) * 1.6
        const oz = (random() - 0.5) * 1.6
        const rotationY = random() * Math.PI * 2

        this.dummy.position.set(localPos.x + ox, tile.level * LEVEL_HEIGHT + TILE_SURFACE, localPos.z + oz)
        this.dummy.rotation.y = rotationY
        this.dummy.scale.setScalar(2)
        this.dummy.updateMatrix()

        this.flowerMesh.setMatrixAt(instanceId, this.dummy.matrix)
        this.flowers.push({ tile, meshName, instanceId, rotationY, ox, oz })
      }
    }
  }

  populateRocks(hexTiles, gridRadius) {
    this.clearRocks()

    if (!this.rockMesh || this.rockGeomIds.size === 0) return

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1
    const rockNames = [...this.rockGeomIds.keys()]
    const treeTileIds = new Set(this.trees.map(t => t.tile.id))

    // Collect candidate tiles: cliffs, coasts, rivers, tree tiles
    const candidates = []
    for (const tile of hexTiles) {
      const def = TILE_LIST[tile.type]
      if (!def) continue
      const name = def.name
      const isCliff = name.includes('CLIFF')
      const isCoast = name.startsWith('COAST_')
      const isRiver = name.startsWith('RIVER_') && !name.startsWith('RIVER_CROSSING')
      const hasTree = treeTileIds.has(tile.id)
      if (!isCliff && !isCoast && !isRiver && !hasTree) continue
      candidates.push(tile)
    }

    // Shuffle and pick up to 20 tiles
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }
    const budget = Math.min(10, candidates.length)

    for (let i = 0; i < budget; i++) {
      const tile = candidates[i]
      const localPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      const count = 1 + Math.floor(random() * 2)  // 1-2 per tile

      for (let r = 0; r < count; r++) {
        if (this.rocks.length >= MAX_ROCKS - 1) break

        const meshName = rockNames[Math.floor(random() * rockNames.length)]
        const geomId = this.rockGeomIds.get(meshName)
        const instanceId = this.rockMesh.addInstance(geomId)
        this.rockMesh.setColorAt(instanceId, WHITE)

        const ox = (random() - 0.5) * 1.2
        const oz = (random() - 0.5) * 1.2
        const rotationY = random() * Math.PI * 2

        this.dummy.position.set(localPos.x + ox, tile.level * LEVEL_HEIGHT + TILE_SURFACE, localPos.z + oz)
        this.dummy.rotation.y = rotationY
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()

        this.rockMesh.setMatrixAt(instanceId, this.dummy.matrix)
        this.rocks.push({ tile, meshName, instanceId, rotationY, ox, oz })
      }
    }
  }

  populateHillsAndMountains(hexTiles, gridRadius) {
    this.clearHills()
    this.clearMountains()

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1
    const hillNames = [...this.hillGeomIds.keys()]
    const mountainNames = [...this.mountainGeomIds.keys()]
    const hasHills = this.hillMesh && hillNames.length > 0
    const hasMountains = this.mountainMesh && mountainNames.length > 0

    if (!hasHills && !hasMountains) return

    for (const tile of hexTiles) {
      const def = TILE_LIST[tile.type]
      if (!def) continue

      const isCliff = def.levelIncrement && def.name.includes('CLIFF')
      const isRiverEnd = def.name === 'RIVER_M'
      const isHighGrass = def.name === 'GRASS' && tile.level >= 2

      if (!isCliff && !isRiverEnd && !isHighGrass) continue

      // 10% for cliffs, 30% for river ends, 15% for high grass
      const chance = isRiverEnd ? 0.3 : isHighGrass ? 0.15 : 0.1
      if (random() > chance) continue

      const localPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      const baseY = tile.level * LEVEL_HEIGHT + TILE_SURFACE
      const rotationY = -tile.rotation * Math.PI / 3

      // High grass gets mountains
      if (isHighGrass && hasMountains) {
        if (this.mountains.length >= MAX_MOUNTAINS - 1) continue

        const meshName = weightedPick(MountainDefs)
        const geomId = this.mountainGeomIds.get(meshName)
        const instanceId = this.mountainMesh.addInstance(geomId)
        this.mountainMesh.setColorAt(instanceId, WHITE)

        this.dummy.position.set(localPos.x, baseY, localPos.z)
        this.dummy.rotation.y = random() * Math.PI * 2
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()
        this.mountainMesh.setMatrixAt(instanceId, this.dummy.matrix)
        this.mountains.push({ tile, meshName, instanceId, rotationY: this.dummy.rotation.y })
        continue
      }

      // River ends get hills
      if (isRiverEnd && hasHills) {
        if (this.hills.length >= MAX_HILLS - 1) continue

        const meshName = weightedPick(HillDefs)
        const geomId = this.hillGeomIds.get(meshName)
        const instanceId = this.hillMesh.addInstance(geomId)
        this.hillMesh.setColorAt(instanceId, WHITE)

        this.dummy.position.set(localPos.x, baseY, localPos.z)
        this.dummy.rotation.y = rotationY
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()
        this.hillMesh.setMatrixAt(instanceId, this.dummy.matrix)
        this.hills.push({ tile, meshName, instanceId, rotationY })
        continue
      }

      if (def.levelIncrement >= 2 && hasMountains) {
        if (this.mountains.length >= MAX_MOUNTAINS - 1) continue

        const meshName = weightedPick(MountainDefs)
        const geomId = this.mountainGeomIds.get(meshName)
        const instanceId = this.mountainMesh.addInstance(geomId)
        this.mountainMesh.setColorAt(instanceId, WHITE)

        this.dummy.position.set(localPos.x, baseY, localPos.z)
        this.dummy.rotation.y = rotationY
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()
        this.mountainMesh.setMatrixAt(instanceId, this.dummy.matrix)
        this.mountains.push({ tile, meshName, instanceId, rotationY })
      } else if (def.levelIncrement === 1 && hasHills) {
        if (this.hills.length >= MAX_HILLS - 1) continue

        const meshName = weightedPick(HillDefs)
        const geomId = this.hillGeomIds.get(meshName)
        const instanceId = this.hillMesh.addInstance(geomId)
        this.hillMesh.setColorAt(instanceId, WHITE)

        this.dummy.position.set(localPos.x, baseY, localPos.z)
        this.dummy.rotation.y = rotationY
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()
        this.hillMesh.setMatrixAt(instanceId, this.dummy.matrix)
        this.hills.push({ tile, meshName, instanceId, rotationY })
      }
    }
  }

  clear() {
    this.clearTrees()
    this.clearBuildings()
    this.clearBridges()
    this.clearWaterlilies()
    this.clearFlowers()
    this.clearRocks()
    this.clearHills()
    this.clearMountains()
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
    for (const fan of this.windmillFans) {
      if (fan.tween) fan.tween.kill()
    }
    this.windmillFans = []
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

  clearWaterlilies() {
    if (!this.waterlilyMesh) return
    for (const lily of this.waterlilies) {
      this.waterlilyMesh.deleteInstance(lily.instanceId)
    }
    this.waterlilies = []
  }

  clearFlowers() {
    if (!this.flowerMesh) return
    for (const flower of this.flowers) {
      this.flowerMesh.deleteInstance(flower.instanceId)
    }
    this.flowers = []
  }

  clearRocks() {
    if (!this.rockMesh) return
    for (const rock of this.rocks) {
      this.rockMesh.deleteInstance(rock.instanceId)
    }
    this.rocks = []
  }

  clearHills() {
    if (!this.hillMesh) return
    for (const hill of this.hills) {
      this.hillMesh.deleteInstance(hill.instanceId)
    }
    this.hills = []
  }

  clearMountains() {
    if (!this.mountainMesh) return
    for (const mountain of this.mountains) {
      this.mountainMesh.deleteInstance(mountain.instanceId)
    }
    this.mountains = []
  }

  /**
   * Add a bridge on a single tile if it's a river crossing
   * @param {HexTile} tile - Tile to check
   * @param {number} gridRadius - Grid radius for position calculation
   */
  addBridgeAt(tile, gridRadius) {
    if (!this.bridgeMesh || this.bridgeGeomIds.size === 0) return
    if (tile.type !== TileType.RIVER_CROSSING_A &&
        tile.type !== TileType.RIVER_CROSSING_B) return

    const LEVEL_HEIGHT = 0.5
    const meshName = tile.type === TileType.RIVER_CROSSING_A
      ? 'building_bridge_A'
      : 'building_bridge_B'

    const geomId = this.bridgeGeomIds.get(meshName)
    if (geomId === undefined) return

    const instanceId = this.bridgeMesh.addInstance(geomId)
    this.bridgeMesh.setColorAt(instanceId, WHITE)

    const localPos = HexTileGeometry.getWorldPosition(
      tile.gridX - gridRadius,
      tile.gridZ - gridRadius
    )
    this.dummy.position.set(localPos.x, tile.level * LEVEL_HEIGHT, localPos.z)
    this.dummy.rotation.y = -tile.rotation * Math.PI / 3
    this.dummy.scale.setScalar(1)
    this.dummy.updateMatrix()

    this.bridgeMesh.setMatrixAt(instanceId, this.dummy.matrix)
    this.bridges.push({ tile, meshName, instanceId })
  }

  /**
   * Remove decorations only on a specific tile position
   * @param {number} gridX - Tile grid X
   * @param {number} gridZ - Tile grid Z
   */
  clearDecorationsAt(gridX, gridZ) {
    if (this.treeMesh) {
      const removed = []
      this.trees = this.trees.filter(tree => {
        if (tree.tile.gridX === gridX && tree.tile.gridZ === gridZ) {
          this.treeMesh.deleteInstance(tree.instanceId)
          return false
        }
        return true
      })
    }
    if (this.buildingMesh) {
      this.buildings = this.buildings.filter(building => {
        if (building.tile.gridX === gridX && building.tile.gridZ === gridZ) {
          this.buildingMesh.deleteInstance(building.instanceId)
          return false
        }
        return true
      })
    }
    if (this.bridgeMesh) {
      this.bridges = this.bridges.filter(bridge => {
        if (bridge.tile.gridX === gridX && bridge.tile.gridZ === gridZ) {
          this.bridgeMesh.deleteInstance(bridge.instanceId)
          return false
        }
        return true
      })
    }
    if (this.waterlilyMesh) {
      this.waterlilies = this.waterlilies.filter(lily => {
        if (lily.tile.gridX === gridX && lily.tile.gridZ === gridZ) {
          this.waterlilyMesh.deleteInstance(lily.instanceId)
          return false
        }
        return true
      })
    }
    if (this.flowerMesh) {
      this.flowers = this.flowers.filter(flower => {
        if (flower.tile.gridX === gridX && flower.tile.gridZ === gridZ) {
          this.flowerMesh.deleteInstance(flower.instanceId)
          return false
        }
        return true
      })
    }
    if (this.rockMesh) {
      this.rocks = this.rocks.filter(rock => {
        if (rock.tile.gridX === gridX && rock.tile.gridZ === gridZ) {
          this.rockMesh.deleteInstance(rock.instanceId)
          return false
        }
        return true
      })
    }
    if (this.hillMesh) {
      this.hills = this.hills.filter(hill => {
        if (hill.tile.gridX === gridX && hill.tile.gridZ === gridZ) {
          this.hillMesh.deleteInstance(hill.instanceId)
          return false
        }
        return true
      })
    }
    if (this.mountainMesh) {
      this.mountains = this.mountains.filter(mountain => {
        if (mountain.tile.gridX === gridX && mountain.tile.gridZ === gridZ) {
          this.mountainMesh.deleteInstance(mountain.instanceId)
          return false
        }
        return true
      })
    }
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

    if (this.waterlilyMesh) {
      this.scene.remove(this.waterlilyMesh)
      this.waterlilyMesh.dispose()
      this.waterlilyMesh = null
    }

    if (this.flowerMesh) {
      this.scene.remove(this.flowerMesh)
      this.flowerMesh.dispose()
      this.flowerMesh = null
    }

    if (this.rockMesh) {
      this.scene.remove(this.rockMesh)
      this.rockMesh.dispose()
      this.rockMesh = null
    }

    if (this.hillMesh) {
      this.scene.remove(this.hillMesh)
      this.hillMesh.dispose()
      this.hillMesh = null
    }

    if (this.mountainMesh) {
      this.scene.remove(this.mountainMesh)
      this.mountainMesh.dispose()
      this.mountainMesh = null
    }

    this.treeGeoms.clear()
    this.treeGeomIds.clear()
    this.buildingGeoms.clear()
    this.buildingGeomIds.clear()
    this.bridgeGeoms.clear()
    this.bridgeGeomIds.clear()
    this.waterlilyGeoms.clear()
    this.waterlilyGeomIds.clear()
    this.flowerGeoms.clear()
    this.flowerGeomIds.clear()
    this.rockGeoms.clear()
    this.rockGeomIds.clear()
    this.hillGeoms.clear()
    this.hillGeomIds.clear()
    this.mountainGeoms.clear()
    this.mountainGeomIds.clear()
  }
}
