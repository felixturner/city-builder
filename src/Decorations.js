import { Object3D, BatchedMesh } from 'three/webgpu'
import { HexTileGeometry, HexTileType, HexTileDefinitions } from './HexTiles.js'
import FastSimplexNoise from '@webvoxel/fast-simplex-noise'

// Check if a tile type has any road edges
function hasRoadEdge(tileType) {
  const def = HexTileDefinitions[tileType]
  if (!def) return false
  return Object.values(def.edges).some(edge => edge === 'road')
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

export class Decorations {
  constructor(scene) {
    this.scene = scene
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
    // Separate noise fields for each tree type (different seeds via random)
    this.noiseA = new FastSimplexNoise({ frequency: 0.05, min: 0, max: 1, random: () => 0.1 })
    this.noiseB = new FastSimplexNoise({ frequency: 0.05, min: 0, max: 1, random: () => 0.9 })
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

    const maxTrees = 300
    this.treeMesh = new BatchedMesh(maxTrees, totalV * 2, totalI * 2, material)
    this.treeMesh.castShadow = true
    this.treeMesh.receiveShadow = true
    this.scene.add(this.treeMesh)

    // Register geometries
    for (const [name, geom] of this.treeGeoms) {
      const geomId = this.treeMesh.addGeometry(geom)
      this.treeGeomIds.set(name, geomId)
    }

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

      const maxBuildings = 20
      this.buildingMesh = new BatchedMesh(maxBuildings, bTotalV * 2, bTotalI * 2, material)
      this.buildingMesh.castShadow = true
      this.buildingMesh.receiveShadow = true
      this.scene.add(this.buildingMesh)

      for (const [name, geom] of this.buildingGeoms) {
        const geomId = this.buildingMesh.addGeometry(geom)
        this.buildingGeomIds.set(name, geomId)
      }
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

      const maxBridges = 20
      this.bridgeMesh = new BatchedMesh(maxBridges, brTotalV * 2, brTotalI * 2, material)
      this.bridgeMesh.castShadow = true
      this.bridgeMesh.receiveShadow = true
      this.scene.add(this.bridgeMesh)

      for (const [name, geom] of this.bridgeGeoms) {
        const geomId = this.bridgeMesh.addGeometry(geom)
        this.bridgeGeomIds.set(name, geomId)
      }
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

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1  // Height of tile mesh surface above base
    const threshold = options.threshold ?? 0.5  // noise > threshold = tree

    for (const tile of hexTiles) {
      // Only flat grass tiles (not slopes)
      if (tile.type !== HexTileType.GRASS) continue

      // Sample noise at tile position
      const worldPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      const noiseA = this.noiseA.scaled2D(worldPos.x, worldPos.z)
      const noiseB = this.noiseB.scaled2D(worldPos.x, worldPos.z)

      const aAbove = noiseA >= threshold
      const bAbove = noiseB >= threshold

      // Skip if neither noise field is above threshold
      if (!aAbove && !bAbove) continue

      // Determine tree type: if both overlap, randomly pick one
      let treeType, noiseVal
      if (aAbove && bAbove) {
        treeType = Math.random() < 0.5 ? 'A' : 'B'
        noiseVal = treeType === 'A' ? noiseA : noiseB
      } else if (aAbove) {
        treeType = 'A'
        noiseVal = noiseA
      } else {
        treeType = 'B'
        noiseVal = noiseB
      }

      // Map noise value to density tier (0-3)
      // threshold..1.0 maps to single -> small -> medium -> large
      const normalizedNoise = (noiseVal - threshold) / (1 - threshold)  // 0..1
      const tierIndex = Math.min(3, Math.floor(normalizedNoise * 4))
      const meshName = TreesByType[treeType][tierIndex]
      const geomId = this.treeGeomIds.get(meshName)
      const instanceId = this.treeMesh.addInstance(geomId)

      // Position at tile center, on top of tile surface
      this.dummy.position.set(
        worldPos.x,
        tile.level * LEVEL_HEIGHT + TILE_SURFACE,
        worldPos.z
      )
      this.dummy.rotation.y = Math.random() * Math.PI * 2
      this.dummy.scale.setScalar(1)
      this.dummy.updateMatrix()

      this.treeMesh.setMatrixAt(instanceId, this.dummy.matrix)
      this.trees.push({ tile, meshName, instanceId })
    }
  }

  populateBuildings(hexTiles, hexGrid, gridRadius, options = {}) {
    this.clearBuildings()

    if (!this.buildingMesh || this.buildingGeomIds.size === 0) return

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1
    const maxBuildings = options.maxBuildings ?? 8
    const buildingNames = [...this.buildingGeomIds.keys()]

    // Find grass tiles, preferring those adjacent to roads
    const candidates = []
    const size = gridRadius * 2 + 1

    // Get tiles that already have trees
    const treeTileIds = new Set(this.trees.map(t => t.tile.id))

    for (const tile of hexTiles) {
      if (tile.type !== HexTileType.GRASS) continue

      // Skip tiles that already have trees
      if (treeTileIds.has(tile.id)) continue

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
        candidates.push({ tile, roadAngle })
      }
    }

    // Shuffle candidates
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }

    // Place buildings
    for (let i = 0; i < Math.min(maxBuildings, candidates.length); i++) {
      const { tile, roadAngle } = candidates[i]
      const meshName = buildingNames[Math.floor(Math.random() * buildingNames.length)]
      const geomId = this.buildingGeomIds.get(meshName)
      const instanceId = this.buildingMesh.addInstance(geomId)

      const worldPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )

      this.dummy.position.set(
        worldPos.x,
        tile.level * LEVEL_HEIGHT + TILE_SURFACE,
        worldPos.z
      )
      // Face the road
      this.dummy.rotation.y = roadAngle
      this.dummy.scale.setScalar(1)
      this.dummy.updateMatrix()

      this.buildingMesh.setMatrixAt(instanceId, this.dummy.matrix)
      this.buildings.push({ tile, meshName, instanceId })
    }
  }

  populateBridges(hexTiles, gridRadius) {
    this.clearBridges()

    if (!this.bridgeMesh || this.bridgeGeomIds.size === 0) return

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1

    for (const tile of hexTiles) {
      // Only river crossing tiles
      if (tile.type !== HexTileType.RIVER_CROSSING_A &&
          tile.type !== HexTileType.RIVER_CROSSING_B) continue

      // Pick matching bridge mesh
      const meshName = tile.type === HexTileType.RIVER_CROSSING_A
        ? 'building_bridge_A'
        : 'building_bridge_B'

      const geomId = this.bridgeGeomIds.get(meshName)
      if (geomId === undefined) continue

      const instanceId = this.bridgeMesh.addInstance(geomId)

      const worldPos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )

      this.dummy.position.set(
        worldPos.x,
        tile.level * LEVEL_HEIGHT,
        worldPos.z
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
}
