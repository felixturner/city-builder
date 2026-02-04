import {
  Object3D,
  BatchedMesh,
  MeshPhysicalNodeMaterial,
  GridHelper,
  PlaneGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardMaterial,
} from 'three/webgpu'
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture, mrt, uv, fract, step, min, float, texture } from 'three/tsl'
import { Tile, TileGeometry, TileDefinitions, TileType, rotateExits } from './Tiles.js'

// Rotate a vec3 around Y axis by angle (in radians)
const rotateY = (v, angle) => {
  const c = cos(angle)
  const s = sin(angle)
  return vec3(
    v.x.mul(c).add(v.z.mul(s)),
    v.y,
    v.z.mul(c).sub(v.x.mul(s))
  )
}

// Rotate a vec3 around X axis by angle (in radians)
const rotateX = (v, angle) => {
  const c = cos(angle)
  const s = sin(angle)
  return vec3(
    v.x,
    v.y.mul(c).sub(v.z.mul(s)),
    v.y.mul(s).add(v.z.mul(c))
  )
}

export class City {
  constructor(scene, params) {
    this.scene = scene
    this.params = params

    // Road tile system (zone-based: each zone is 2x2 cells)
    this.zoneGrids = [] // Array of 2D grids, one per layer [layer][x][z]
    this.maxLayers = 5 // Max layers for BatchedMesh allocation
    this.numLayers = 1 // Actual layers to generate (set by GUI)
    this.zoneGridSize = 15 // 15 zones = 30 cells
    this.zoneSize = 2 // Each zone is 2x2 cells
    this.roadMesh = null
    this.roadMaterial = null
    this.tiles = []
    this.dummy = new Object3D()

    // Alias for Demo.js compatibility (raycasting)
    this.towerMesh = null

    // Environment rotation uniforms
    this.envRotation = uniform(0)  // Y axis (horizontal spin)
    this.envRotationX = uniform(0) // X axis (vertical tilt)

    // Grid dimensions for other systems (in cells, not zones)
    this.actualGridWidth = 30
    this.actualGridHeight = 30
  }

  async init() {
    await TileGeometry.init()
    this.createFloor()
    await this.initRoads()
    this.initRoadGrid()
    this.updateRoadMatrices()

    // Set towerMesh alias for raycasting compatibility
    this.towerMesh = this.roadMesh
  }

  /**
   * Create a floor plane under the grid
   */
  createFloor() {
    const floorSize = this.zoneGridSize * this.zoneSize + 20
    const floorGeometry = new PlaneGeometry(floorSize, floorSize)
    floorGeometry.rotateX(-Math.PI / 2)

    const floorMaterial = new MeshStandardMaterial({
      color: 0x333333,
      roughness: 0.9,
      metalness: 0.0
    })

    this.floor = new Mesh(floorGeometry, floorMaterial)
    this.floor.position.y = -0.01 // Slightly below tiles
    this.floor.receiveShadow = true
    this.scene.add(this.floor)
  }

  /**
   * Initialize the zone grids with random road generation for each layer
   */
  initRoadGrid() {
    const size = this.zoneGridSize
    this.tiles = []

    // numLayers is set directly by GUI, fallback to default if not set
    if (this.numLayers < 1) this.numLayers = 3

    // Create grid for each layer
    this.zoneGrids = []
    this.layerOffsets = [] // Random XZ offsets per layer
    for (let layer = 0; layer < this.numLayers; layer++) {
      this.zoneGrids[layer] = Array.from({ length: size }, () => Array(size).fill(null))
      // Random offset in range 3-8 cells, positive or negative
      const randOffset = () => (3 + Math.random() * 5) * (Math.random() < 0.5 ? -1 : 1)
      this.layerOffsets[layer] = layer === 0 ? { x: 0, z: 0 } : { x: randOffset(), z: randOffset() }
    }

    // Alias for backwards compatibility (ground layer)
    this.zoneGrid = this.zoneGrids[0]

    const maxTiles = this.params?.roads?.maxTiles ?? 150

    // Generate roads for each layer
    for (let layer = 0; layer < this.numLayers; layer++) {
      this.currentLayer = layer
      this.generateRandomRoads(Math.floor(maxTiles / this.numLayers), layer)
    }
    this.currentLayer = 0
  }

  // Direction offsets for N/E/S/W
  static DIR_OFFSET = {
    N: { dx: 0, dz: -1 },
    E: { dx: 1, dz: 0 },
    S: { dx: 0, dz: 1 },
    W: { dx: -1, dz: 0 },
  }
  static OPPOSITE_DIR = { N: 'S', E: 'W', S: 'N', W: 'E' }

  /**
   * Generate connected roads by extending from open exits
   * @param {number} maxTiles - Maximum number of tiles to place
   * @param {number} layer - Layer to generate roads on (0 = ground)
   */
  generateRandomRoads(maxTiles, layer = 0) {
    const center = Math.floor(this.zoneGridSize / 2)
    const grid = this.zoneGrids[layer]
    const startTileCount = this.tiles.length

    // Track open exits: { zoneX, zoneZ, direction, straightStreak }
    this.openExits = []
    // Track exits that are blocked (can't extend, need END cap)
    const blockedExits = []

    // 1. Place starting tile (X intersection at center)
    this.placeRoadTile(center, center, TileType.X, 0, layer)

    // 2. Add its 4 open exits
    this.addOpenExits(center, center, TileType.X, 0, null)

    // 3. Process open exits until done
    while ((this.tiles.length - startTileCount) < maxTiles && this.openExits.length > 0) {
      // Find a random exit that can extend (target is empty)
      let foundValid = false
      const shuffled = [...this.openExits].sort(() => Math.random() - 0.5)

      for (const exit of shuffled) {
        const offset = City.DIR_OFFSET[exit.direction]
        const targetX = exit.zoneX + offset.dx
        const targetZ = exit.zoneZ + offset.dz

        // Check if out of bounds - try to downgrade source tile to remove this exit
        if (!this.isValidZone(targetX, targetZ)) {
          this.openExits = this.openExits.filter(e => e !== exit)
          // Try to replace source tile with one that doesn't have this exit
          this.tryDowngradeTile(exit.zoneX, exit.zoneZ, exit.direction, layer)
          continue
        }

        // Check if occupied - try to upgrade the existing tile to create a loop
        if (grid[targetX][targetZ] !== null) {
          const upgraded = this.tryUpgradeTile(targetX, targetZ, exit.direction, layer)
          if (upgraded) {
            // Successfully created a loop! Remove this exit (now connected)
            this.openExits = this.openExits.filter(e => e !== exit)
            foundValid = true
            break
          }
          // Can't upgrade - move to blocked
          this.openExits = this.openExits.filter(e => e !== exit)
          blockedExits.push(exit)
          continue
        }

        // Found valid exit - extend it
        this.openExits = this.openExits.filter(e => e !== exit)

        // Choose what tile to place (weighted random, validated)
        const straightStreak = exit.straightStreak || 0
        const tileChoice = this.chooseTileForExit(exit.direction, targetX, targetZ, straightStreak, layer)

        // Place the tile
        this.placeRoadTile(targetX, targetZ, tileChoice.type, tileChoice.rotation, layer)

        // Track streak: increment if FORWARD, reset otherwise
        const newStreak = (tileChoice.type === TileType.FORWARD) ? straightStreak + 1 : 0

        // Add new open exits from this tile (excluding the entry direction)
        const entryDir = City.OPPOSITE_DIR[exit.direction]
        this.addOpenExits(targetX, targetZ, tileChoice.type, tileChoice.rotation, entryDir, newStreak)

        foundValid = true
        break
      }

      // If no valid exits found, we're stuck
      if (!foundValid) break
    }

    // 4. Cap remaining open exits with END tiles
    // Combine remaining open exits with blocked ones
    const allUncapped = [...this.openExits, ...blockedExits]
    this.openExits = allUncapped
    this.capOpenExits(layer)

    console.log(`Generated ${this.tiles.length - startTileCount} road tiles on layer ${layer}`)
  }

  /**
   * Check if zone coordinates are valid
   */
  isValidZone(zoneX, zoneZ) {
    return zoneX >= 0 && zoneX < this.zoneGridSize &&
           zoneZ >= 0 && zoneZ < this.zoneGridSize
  }

  /**
   * Try to upgrade an existing tile to add a new exit (creates loops)
   * @param {number} zoneX - Zone X of existing tile
   * @param {number} zoneZ - Zone Z of existing tile
   * @param {string} incomingDir - Direction the new road is coming FROM
   * @param {number} layer - Layer index
   * @returns {boolean} True if upgrade succeeded
   */
  tryUpgradeTile(zoneX, zoneZ, incomingDir, layer = 0) {
    const grid = this.zoneGrids[layer]
    const existingTile = grid[zoneX][zoneZ]
    if (!existingTile) return false

    // The new exit we need to add (opposite of incoming direction)
    const newExitDir = City.OPPOSITE_DIR[incomingDir]

    // Get current exits of the existing tile
    const currentExits = rotateExits(TileDefinitions[existingTile.type].exits, existingTile.rotation)

    // If tile already has this exit, no upgrade needed (already connected)
    if (currentExits[newExitDir]) return true

    // Build required exits: current exits + new exit
    const requiredExits = { ...currentExits }
    requiredExits[newExitDir] = true

    // Count required exits
    const requiredCount = Object.values(requiredExits).filter(v => v).length

    // Find a tile type that has exactly these exits (or more)
    // Prefer tiles with fewer extra exits
    const upgradeCandidates = []

    for (const [typeKey, def] of Object.entries(TileDefinitions)) {
      const type = parseInt(typeKey)
      if (type === TileType.END) continue // END can't be an upgrade target

      // Try all 4 rotations
      for (let rot = 0; rot < 4; rot++) {
        const exits = rotateExits(def.exits, rot)

        // Check if this tile has all required exits
        let hasAllRequired = true
        for (const dir of ['N', 'E', 'S', 'W']) {
          if (requiredExits[dir] && !exits[dir]) {
            hasAllRequired = false
            break
          }
        }

        if (hasAllRequired) {
          // Count total exits
          const totalExits = Object.values(exits).filter(v => v).length
          upgradeCandidates.push({ type, rotation: rot, extraExits: totalExits - requiredCount })
        }
      }
    }

    if (upgradeCandidates.length === 0) return false

    // Sort by fewest extra exits (prefer minimal upgrade)
    upgradeCandidates.sort((a, b) => a.extraExits - b.extraExits)
    const upgrade = upgradeCandidates[0]

    // Replace the tile
    this.replaceTile(zoneX, zoneZ, upgrade.type, upgrade.rotation, layer)

    return true
  }

  /**
   * Try to downgrade a tile to remove an exit (for edge-of-map cases)
   * @param {number} zoneX - Zone X of tile to downgrade
   * @param {number} zoneZ - Zone Z of tile to downgrade
   * @param {string} exitToRemove - Direction of exit to remove
   * @param {number} layer - Layer index
   * @returns {boolean} True if downgrade succeeded
   */
  tryDowngradeTile(zoneX, zoneZ, exitToRemove, layer = 0) {
    const grid = this.zoneGrids[layer]
    const existingTile = grid[zoneX][zoneZ]
    if (!existingTile) return false

    // Get current exits
    const currentExits = rotateExits(TileDefinitions[existingTile.type].exits, existingTile.rotation)

    // If tile doesn't have this exit, nothing to do
    if (!currentExits[exitToRemove]) return true

    // Find required exits: exits that connect to existing neighbors (must keep)
    const requiredExits = { N: false, E: false, S: false, W: false }
    for (const dir of ['N', 'E', 'S', 'W']) {
      if (!currentExits[dir]) continue
      if (dir === exitToRemove) continue // This is the one we want to remove

      const offset = City.DIR_OFFSET[dir]
      const nx = zoneX + offset.dx
      const nz = zoneZ + offset.dz

      // Check if neighbor exists and connects back
      if (this.isValidZone(nx, nz)) {
        const neighbor = grid[nx][nz]
        if (neighbor) {
          const neighborExits = rotateExits(TileDefinitions[neighbor.type].exits, neighbor.rotation)
          const oppositeDir = City.OPPOSITE_DIR[dir]
          if (neighborExits[oppositeDir]) {
            // Neighbor connects to us - must keep this exit
            requiredExits[dir] = true
          }
        }
      }
    }

    // Find a tile that has all required exits but NOT the exit to remove
    const downgradeCandidates = []

    for (const [typeKey, def] of Object.entries(TileDefinitions)) {
      const type = parseInt(typeKey)

      for (let rot = 0; rot < 4; rot++) {
        const exits = rotateExits(def.exits, rot)

        // Must NOT have the exit we want to remove
        if (exits[exitToRemove]) continue

        // Must have all required exits
        let hasAllRequired = true
        for (const dir of ['N', 'E', 'S', 'W']) {
          if (requiredExits[dir] && !exits[dir]) {
            hasAllRequired = false
            break
          }
        }

        if (hasAllRequired) {
          // Count extra exits (prefer fewer)
          const requiredCount = Object.values(requiredExits).filter(v => v).length
          const totalExits = Object.values(exits).filter(v => v).length
          downgradeCandidates.push({ type, rotation: rot, extraExits: totalExits - requiredCount })
        }
      }
    }

    if (downgradeCandidates.length === 0) return false

    // Sort by fewest extra exits
    downgradeCandidates.sort((a, b) => a.extraExits - b.extraExits)
    const downgrade = downgradeCandidates[0]

    // Replace the tile
    this.replaceTile(zoneX, zoneZ, downgrade.type, downgrade.rotation, layer)

    return true
  }

  /**
   * Replace an existing tile with a new type/rotation
   */
  replaceTile(zoneX, zoneZ, newType, newRotation, layer = 0) {
    const grid = this.zoneGrids[layer]
    const existingTile = grid[zoneX][zoneZ]
    if (!existingTile) return

    // Remove old instance from mesh
    if (this.roadMesh && existingTile.instanceId !== null) {
      this.roadMesh.deleteInstance(existingTile.instanceId)
    }

    // Remove from tiles array
    this.tiles = this.tiles.filter(t => t !== existingTile)

    // Place new tile
    this.placeRoadTile(zoneX, zoneZ, newType, newRotation, layer)
  }

  /**
   * Place a road tile directly (no validation, used during generation)
   */
  placeRoadTile(zoneX, zoneZ, type, rotation, layer = 0) {
    const grid = this.zoneGrids[layer]
    const tile = new Tile(zoneX, zoneZ, type, rotation, layer)
    grid[zoneX][zoneZ] = tile
    this.tiles.push(tile)

    // Add instance to BatchedMesh if available
    if (this.roadMesh && type < TileGeometry.geoms.length && TileGeometry.geoms[type]) {
      tile.instanceId = this.roadMesh.addInstance(type)
      this.roadMesh.setColorAt(tile.instanceId, tile.color)
    }

    return tile
  }

  /**
   * Add open exits from a placed tile to the queue
   * @param {string|null} excludeDir - Direction to exclude (entry point)
   * @param {number} straightStreak - How many straights in a row (for weight adjustment)
   */
  addOpenExits(zoneX, zoneZ, type, rotation, excludeDir, straightStreak = 0) {
    const exits = rotateExits(TileDefinitions[type].exits, rotation)

    for (const dir of ['N', 'E', 'S', 'W']) {
      if (exits[dir] && dir !== excludeDir) {
        this.openExits.push({ zoneX, zoneZ, direction: dir, straightStreak })
      }
    }
  }

  /**
   * Check if a tile placement would create valid exits
   * All new exits must either point to empty zones OR connect to matching neighbor exits
   */
  validateTileExits(type, zoneX, zoneZ, rotation, entryDir, layer = 0) {
    const grid = this.zoneGrids[layer]
    const exits = rotateExits(TileDefinitions[type].exits, rotation)

    for (const dir of ['N', 'E', 'S', 'W']) {
      if (!exits[dir]) continue // No exit in this direction
      if (dir === entryDir) continue // Entry direction is fine (connects back)

      const offset = City.DIR_OFFSET[dir]
      const nx = zoneX + offset.dx
      const nz = zoneZ + offset.dz

      // Out of bounds = blocked (will need END later, but OK for now)
      if (!this.isValidZone(nx, nz)) continue

      const neighbor = grid[nx][nz]
      if (neighbor === null) continue // Empty = can extend later, OK

      // Neighbor exists - check if it has a matching exit pointing back
      const neighborExits = rotateExits(TileDefinitions[neighbor.type].exits, neighbor.rotation)
      const oppositeDir = City.OPPOSITE_DIR[dir]
      if (!neighborExits[oppositeDir]) {
        // Neighbor doesn't have matching exit - this would create a visual clash
        return false
      }
    }
    return true
  }

  /**
   * Choose tile type and rotation for extending from an open exit
   * Validates that the choice won't create dead-end clashes
   * @param {string} incomingDir - Direction the road is heading (N/E/S/W)
   * @param {number} targetX - Target zone X
   * @param {number} targetZ - Target zone Z
   * @param {number} straightStreak - How many straights in a row (increases turn chance)
   * @param {number} layer - Layer index
   */
  chooseTileForExit(incomingDir, targetX, targetZ, straightStreak = 0, layer = 0) {
    const entryDir = City.OPPOSITE_DIR[incomingDir]

    // Adjust weights based on straight streak (if cumulative weights enabled)
    const useCumulative = this.params?.roads?.cumulativeWeights ?? true
    const streakPenalty = useCumulative ? straightStreak * 15 : 0
    const streakBonus = useCumulative ? straightStreak * 5 : 0

    const forwardWeight = Math.max(10, 60 - streakPenalty)
    const turnWeight = 15 + streakBonus

    // Build list of possible tiles with weights
    const candidates = [
      { type: TileType.FORWARD, rotation: this.getRotationForForward(entryDir), weight: forwardWeight },
      { type: TileType.TURN_90, rotation: this.getRotationForTurn(entryDir, true), weight: turnWeight },
      { type: TileType.TURN_90, rotation: this.getRotationForTurn(entryDir, false), weight: turnWeight },
      { type: TileType.T, rotation: this.getRotationForT(entryDir), weight: 22 },
    ]

    // Filter to only valid candidates
    const valid = candidates.filter(c =>
      this.validateTileExits(c.type, targetX, targetZ, c.rotation, entryDir, layer)
    )

    if (valid.length === 0) {
      // No valid options - must use END
      return { type: TileType.END, rotation: this.getRotationForEnd(entryDir) }
    }

    // Weighted random selection from valid options
    const totalWeight = valid.reduce((sum, c) => sum + c.weight, 0)
    let roll = Math.random() * totalWeight
    for (const c of valid) {
      roll -= c.weight
      if (roll <= 0) return { type: c.type, rotation: c.rotation }
    }
    return valid[valid.length - 1]
  }

  /**
   * Get rotation for FORWARD tile entering from entryDir
   * FORWARD has exits N and S at rotation 0
   */
  getRotationForForward(entryDir) {
    const rotations = { S: 0, W: 1, N: 2, E: 3 }
    return rotations[entryDir]
  }

  /**
   * Get rotation for ANGLE/TURN_90 tile entering from entryDir
   * ANGLE/TURN_90 has exits S and E at rotation 0
   * After rotation: 0=S,E  1=N,E  2=N,W  3=S,W
   */
  getRotationForTurn(entryDir, turnLeft) {
    const map = {
      'S-left': 3,   // Enter S, exit W (rot 3: S,W)
      'S-right': 0,  // Enter S, exit E (rot 0: S,E)
      'W-left': 2,   // Enter W, exit N (rot 2: N,W)
      'W-right': 3,  // Enter W, exit S (rot 3: S,W)
      'N-left': 1,   // Enter N, exit E (rot 1: N,E)
      'N-right': 2,  // Enter N, exit W (rot 2: N,W)
      'E-left': 0,   // Enter E, exit S (rot 0: S,E)
      'E-right': 1,  // Enter E, exit N (rot 1: N,E)
    }
    return map[`${entryDir}-${turnLeft ? 'left' : 'right'}`]
  }

  /**
   * Get rotation for T tile entering from entryDir
   * T has exits E, S, W at rotation 0 (NOT N)
   * After rotation: 0=E,S,W  1=S,W,N  2=W,N,E  3=N,E,S
   */
  getRotationForT(entryDir) {
    const rotations = { S: 1, W: 2, N: 3, E: 0 }
    return rotations[entryDir]
  }

  /**
   * Get rotation for END tile entering from entryDir
   * END has exit S at rotation 0 (cap at N)
   * After rotation: 0=S  1=E  2=N  3=W
   */
  getRotationForEnd(entryDir) {
    const rotations = { S: 0, E: 1, N: 2, W: 3 }
    return rotations[entryDir]
  }

  /**
   * Cap all remaining open exits with END tiles
   */
  capOpenExits(layer = 0) {
    const grid = this.zoneGrids[layer]
    for (const exit of this.openExits) {
      const offset = City.DIR_OFFSET[exit.direction]
      const targetX = exit.zoneX + offset.dx
      const targetZ = exit.zoneZ + offset.dz

      // Skip if out of bounds or occupied
      if (!this.isValidZone(targetX, targetZ)) continue
      if (grid[targetX][targetZ] !== null) continue

      // Place END tile
      const entryDir = City.OPPOSITE_DIR[exit.direction]
      const rotation = this.getRotationForEnd(entryDir)
      this.placeRoadTile(targetX, targetZ, TileType.END, rotation, layer)
    }
    this.openExits = []
  }

  /**
   * Initialize road tile BatchedMesh
   */
  async initRoads() {
    if (TileGeometry.geoms.length === 0) {
      console.warn('TileGeometry not loaded, skipping road init')
      return
    }

    // Material for roads - grey material
    const mat = new MeshPhysicalNodeMaterial()
    mat.color.setHex(0x888888)
    mat.roughness = 0.8
    mat.metalness = 0.1
    this.roadMaterial = mat
    this.towerMaterial = mat // Alias for GUI compatibility

    // Setup environment rotation for material
    this.setupEnvRotation()

    // Calculate geometry requirements
    const geoms = TileGeometry.geoms
    let totalV = 0
    let totalI = 0
    for (const g of geoms) {
      if (!g) continue
      totalV += g.attributes.position.count
      totalI += g.index ? g.index.count : 0
    }

    // Max instances = zone grid size squared * max layers (pre-allocate for GUI changes)
    const maxInstances = this.zoneGridSize * this.zoneGridSize * this.maxLayers

    // Create BatchedMesh with enough capacity
    this.roadMesh = new BatchedMesh(maxInstances, totalV * 2, totalI * 2, mat)
    this.roadMesh.sortObjects = false
    this.roadMesh.receiveShadow = true
    this.roadMesh.castShadow = true

    // Position road mesh centered (offset so grid center is at origin)
    // Total grid size in cells = zoneGridSize * zoneSize
    const totalCells = this.zoneGridSize * this.zoneSize
    const roadGridOffset = -totalCells / 2
    this.roadMesh.position.x = roadGridOffset
    this.roadMesh.position.z = roadGridOffset
    this.scene.add(this.roadMesh)

    // Add geometries to BatchedMesh
    const geomIds = []
    for (const g of geoms) {
      if (g) {
        geomIds.push(this.roadMesh.addGeometry(g))
      } else {
        geomIds.push(-1)
      }
    }

    // Create instances for each tile
    for (const tile of this.tiles) {
      if (geomIds[tile.type] === -1) continue
      tile.instanceId = this.roadMesh.addInstance(geomIds[tile.type])
      this.roadMesh.setColorAt(tile.instanceId, tile.color)
    }

    console.log(`Road mesh: ${this.tiles.length} instances created`)
  }

  /**
   * Update road tile matrices (position and rotation)
   */
  updateRoadMatrices() {
    if (!this.roadMesh || !this.tiles) return

    const dummy = this.dummy
    // Simple rotations: 0°, 90°, 180°, 270° CCW
    const rotations = [0, Math.PI / 2, Math.PI, Math.PI * 1.5]
    const zoneSize = this.zoneSize

    for (const tile of this.tiles) {
      if (tile.instanceId === null) continue

      // Place tiles at their grid positions (centered at world origin)
      // Each zone is zoneSize cells, meshOffset compensates for roadMesh.position
      const layerOffset = this.layerOffsets?.[tile.layer] || { x: 0, z: 0 }
      const worldX = tile.gridX * zoneSize + zoneSize / 2 + layerOffset.x
      const worldZ = tile.gridZ * zoneSize + zoneSize / 2 + layerOffset.z
      const worldY = tile.layer * Tile.LAYER_HEIGHT // Elevated layers at 1.0 per layer
      dummy.position.set(worldX, worldY, worldZ)
      dummy.scale.set(1, 1, 1)
      dummy.rotation.y = rotations[tile.rotation]
      dummy.updateMatrix()

      this.roadMesh.setMatrixAt(tile.instanceId, dummy.matrix)
      this.roadMesh.setVisibleAt(tile.instanceId, true)
    }
  }

  /**
   * Setup environment rotation for the material
   */
  setupEnvRotation() {
    const mat = this.roadMaterial
    const angleY = this.envRotation
    const angleX = this.envRotationX

    // Get the environment texture from scene
    const envTexture = this.scene.environment
    if (!envTexture) {
      console.warn('Environment texture not yet loaded')
      return
    }

    // Create rotated reflection vector for specular
    const reflectView = positionViewDirection.negate().reflect(normalWorld)
    const reflectWorld = reflectView.transformDirection(cameraViewMatrix)
    // Apply both rotations: first Y (horizontal), then X (vertical tilt)
    const rotatedY = rotateY(reflectWorld, angleY)
    const rotatedReflectWorld = rotateX(rotatedY, angleX)

    // Create PMREM texture node with rotated UV direction
    const envMapNode = pmremTexture(envTexture, rotatedReflectWorld, roughness)

    // Set as the material's environment node
    mat.envNode = envMapNode
  }

  /**
   * Regenerate the road grid with new random placement
   */
  regenerate() {
    // Delete existing instances from mesh (not just hide)
    if (this.roadMesh) {
      for (const tile of this.tiles) {
        if (tile.instanceId !== null) {
          this.roadMesh.deleteInstance(tile.instanceId)
        }
      }
    }

    // Re-init the grid (this also creates new instances via placeRoadTile)
    this.initRoadGrid()

    this.updateRoadMatrices()
  }

  /**
   * Check if a tile can be placed at the given zone position
   * Validates bounds, empty zone, and edge connections with neighbors
   */
  canPlaceTile(type, zoneX, zoneZ, rotation) {
    const size = this.zoneGridSize

    // Check bounds
    if (zoneX < 0 || zoneX >= size || zoneZ < 0 || zoneZ >= size) {
      return false
    }

    // Check zone is empty
    if (this.zoneGrid[zoneX][zoneZ] !== null) {
      return false
    }

    // Check edge connections with neighbors
    return this.checkConnections(type, zoneX, zoneZ, rotation)
  }

  /**
   * Validate that tile edges match with adjacent tiles
   * Road exits must connect to road exits, empty edges to empty edges
   */
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
      const nx = zoneX + dx
      const nz = zoneZ + dz

      // Skip out of bounds neighbors
      if (nx < 0 || nx >= this.zoneGridSize || nz < 0 || nz >= this.zoneGridSize) {
        continue
      }

      const neighbor = this.zoneGrid[nx][nz]
      if (neighbor) {
        const neighborExits = rotateExits(TileDefinitions[neighbor.type].exits, neighbor.rotation)
        // Road must connect to road, empty to empty
        if (exits[dir] !== neighborExits[opposite]) {
          return false
        }
      }
    }

    return true
  }

  /**
   * Place a tile at the given zone position (with validation)
   * Returns the tile if placed, null if invalid
   */
  placeTile(type, zoneX, zoneZ, rotation) {
    if (!this.canPlaceTile(type, zoneX, zoneZ, rotation)) {
      return null
    }

    const tile = new Tile(zoneX, zoneZ, type, rotation)
    this.zoneGrid[zoneX][zoneZ] = tile
    this.tiles.push(tile)

    // Add instance to BatchedMesh if available
    if (this.roadMesh && type < TileGeometry.geoms.length && TileGeometry.geoms[type]) {
      tile.instanceId = this.roadMesh.addInstance(type)
      this.roadMesh.setColorAt(tile.instanceId, tile.color)

      // Update matrix for this tile (geometry already baked at import)
      const rotations = [0, -Math.PI / 2, -Math.PI, -Math.PI * 1.5]
      const zoneSize = this.zoneSize
      const worldX = tile.gridX * zoneSize + zoneSize / 2
      const worldZ = tile.gridZ * zoneSize + zoneSize / 2
      this.dummy.position.set(worldX, 0, worldZ)
      this.dummy.scale.set(1, 1, 1)
      this.dummy.rotation.y = rotations[tile.rotation]
      this.dummy.updateMatrix()
      this.roadMesh.setMatrixAt(tile.instanceId, this.dummy.matrix)
      this.roadMesh.setVisibleAt(tile.instanceId, true)
    }

    return tile
  }

  /**
   * Update per-frame (placeholder for future animations)
   */
  update(dt) {
    // Future: animate tiles, etc.
  }

  /**
   * Create debug grid helpers
   */
  createGrids() {
    const gridSize = this.zoneGridSize * this.zoneSize // Total cells

    // Fine cell grid
    const cellGrid = new GridHelper(gridSize, gridSize, 0x888888, 0x888888)
    cellGrid.material.transparent = true
    cellGrid.material.opacity = 0.5
    cellGrid.position.set(0, 0.01, 0)
    this.scene.add(cellGrid)
    this.cellGrid = cellGrid

    // Grid intersection dots
    const dotPlaneGeometry = new PlaneGeometry(gridSize, gridSize)
    dotPlaneGeometry.rotateX(-Math.PI / 2)
    const dotMaterial = new MeshBasicNodeMaterial()
    dotMaterial.transparent = true
    dotMaterial.alphaTest = 0.5
    dotMaterial.side = 2

    const cellCoord = uv().mul(gridSize)
    const fractCoord = fract(cellCoord)
    const toGridX = min(fractCoord.x, float(1).sub(fractCoord.x))
    const toGridY = min(fractCoord.y, float(1).sub(fractCoord.y))
    const dist = toGridX.mul(toGridX).add(toGridY.mul(toGridY)).sqrt()
    const dotRadius = float(0.04)
    const dotMask = float(1).sub(step(dotRadius, dist))

    const dotColor = vec3(0.267, 0.267, 0.267)
    dotMaterial.colorNode = dotColor
    dotMaterial.opacityNode = dotMask
    dotMaterial.mrtNode = mrt({
      output: dotColor,
      normal: vec3(0, 1, 0)
    })

    this.dotMesh = new Mesh(dotPlaneGeometry, dotMaterial)
    this.dotMesh.position.set(0, 0.015, 0)
    this.scene.add(this.dotMesh)
  }

  // Stub methods for Demo.js compatibility
  onHover() {}
  onPointerDown() { return false }
  onPointerMove() {}
  onPointerUp() {}
  onRightClick() {}
  startIntroAnimation() {}
}
