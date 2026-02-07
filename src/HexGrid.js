import {
  Object3D,
  BatchedMesh,
  Group,
  AxesHelper,
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  LineBasicMaterial,
} from 'three/webgpu'
import { CSS2DObject } from 'three/examples/jsm/Addons.js'
import gsap from 'gsap'
import { HexWFCSolver, HexWFCAdjacencyRules } from './HexWFC.js'
import { random } from './SeededRandom.js'
import {
  HexTile,
  HexTileGeometry,
  HexTileType,
  HexTileDefinitions,
  HexDir,
  getHexNeighborOffset,
  isInHexRadius,
} from './HexTiles.js'
import { Decorations } from './Decorations.js'
import { HexGridHelper } from './HexGridHelper.js'
import { Placeholder } from './Placeholder.js'

/**
 * HexGrid states
 */
export const HexGridState = {
  PLACEHOLDER: 'placeholder',  // Not yet populated, shows clickable button
  POPULATED: 'populated',      // Has tiles, shows helper when debug enabled
}

/**
 * HexGrid - Self-contained hex grid with its own BatchedMesh instances
 *
 * Each grid manages:
 * - hexMesh (tiles)
 * - decorations (trees, buildings, bridges)
 * - gridHelper (debug visualization)
 * - placeholder (clickable expansion button)
 *
 * State determines what's visible:
 * - PLACEHOLDER: Shows Placeholder, hides Helper
 * - POPULATED: Hides Placeholder, shows Helper (if debug enabled)
 */
export class HexGrid {
  constructor(scene, material, gridRadius, worldOffset = { x: 0, z: 0 }) {
    this.scene = scene
    this.material = material
    this.gridRadius = gridRadius
    this.worldOffset = worldOffset

    // Container group positioned at worldOffset
    this.group = new Group()
    this.group.position.set(worldOffset.x, 0, worldOffset.z)
    this.scene.add(this.group)

    // State management
    this.state = HexGridState.PLACEHOLDER

    // Hex dimensions
    this.hexWidth = 2
    this.hexHeight = 2 / Math.sqrt(3) * 2

    this.hexTiles = []
    this.hexGrid = null  // 2D array
    this.hexMesh = null
    this.decorations = null
    this.gridHelper = null
    this.placeholder = null
    this.axesHelper = null   // Always visible
    this.outline = null      // Always visible

    // Callback for placeholder click
    this.onClick = null

    this.dummy = new Object3D()
  }

  /**
   * Initialize the grid (creates placeholder and helper, but doesn't populate tiles yet)
   * @param {Map} geometries - HexTileGeometry.geoms (optional, only needed for population)
   */
  async init(geometries = null) {
    // Create axes helper (always visible)
    this.axesHelper = new AxesHelper(5)
    this.axesHelper.position.set(0, 2, 0)
    this.group.add(this.axesHelper)

    // Create outline (always visible, renders through terrain)
    this.createOutline()

    // Create always-visible grid coordinate label
    const gridKey = this.gridCoords ? `${this.gridCoords.x},${this.gridCoords.z}` : '?'
    this.gridLabel = this.createGridLabel(gridKey)
    this.group.add(this.gridLabel)

    // Create placeholder (visible in PLACEHOLDER state)
    this.placeholder = new Placeholder(this.gridRadius, this.hexWidth, this.hexHeight)
    this.placeholder.group.userData.hexGrid = this  // Reference for raycasting
    this.group.add(this.placeholder.group)

    // Create grid helper (visible in POPULATED state when debug enabled)
    this.gridHelper = new HexGridHelper(this.gridRadius, this.hexWidth, this.hexHeight)
    this.gridHelper.create()
    this.gridHelper.hide()  // Hidden by default
    this.group.add(this.gridHelper.group)

    // Set initial visibility based on state
    this.updateVisibility()

    // Only initialize meshes if geometries provided (for immediate population)
    if (geometries && geometries.size > 0) {
      await this.initMeshes(geometries)
    }

    return true
  }

  /**
   * Initialize BatchedMesh for tiles (called before population)
   * @param {Map} geometries - HexTileGeometry.geoms
   */
  async initMeshes(geometries) {
    if (!geometries || geometries.size === 0) {
      console.warn('HexGrid.initMeshes: No geometries provided')
      return false
    }

    // Calculate total vertices/indices for BatchedMesh
    let totalV = 0
    let totalI = 0
    for (const geom of geometries.values()) {
      if (!geom) continue
      totalV += geom.attributes.position.count
      totalI += geom.index ? geom.index.count : 0
    }

    const maxInstances = 25 * 25

    // Create BatchedMesh for hex tiles (positioned at 0,0,0 local - group handles offset)
    this.hexMesh = new BatchedMesh(maxInstances, totalV * 2, totalI * 2, this.material)
    this.hexMesh.sortObjects = false
    this.hexMesh.receiveShadow = true
    this.hexMesh.castShadow = true
    this.group.add(this.hexMesh)

    // Register geometries in BatchedMesh
    this.geomIds = new Map()
    for (const [type, geom] of geometries) {
      if (geom) {
        const geomId = this.hexMesh.addGeometry(geom)
        this.geomIds.set(type, geomId)
      }
    }

    // Initialize decorations for this grid (using group offset)
    this.decorations = new Decorations(this.group, { x: 0, z: 0 })
    await this.decorations.init(HexTileGeometry.gltfScene, this.material)

    return true
  }

  /**
   * Create outline showing grid boundary (always visible, renders through terrain)
   */
  createOutline() {
    const d = this.gridRadius * 2 + 1
    const halfW = (d * this.hexWidth) / 2
    const halfH = (d * this.hexHeight * 0.75) / 2

    // 6 vertices of flat-top hex
    const verts = [
      halfW, 0, 0,
      halfW * 0.5, 0, -halfH,
      -halfW * 0.5, 0, -halfH,
      -halfW, 0, 0,
      -halfW * 0.5, 0, halfH,
      halfW * 0.5, 0, halfH,
    ]
    const lineVerts = []
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6
      lineVerts.push(verts[i*3], verts[i*3+1], verts[i*3+2])
      lineVerts.push(verts[j*3], verts[j*3+1], verts[j*3+2])
    }

    const geom = new BufferGeometry()
    geom.setAttribute('position', new Float32BufferAttribute(lineVerts, 3))
    const material = new LineBasicMaterial({ color: 0xffffff })
    material.depthTest = false
    material.depthWrite = false  // Exclude from AO (no depth contribution)

    this.outline = new LineSegments(geom, material)
    this.outline.position.set(0, 1, 0)
    this.outline.renderOrder = 999
    this.group.add(this.outline)
  }

  /**
   * Update visibility based on current state
   */
  updateVisibility() {
    if (this.state === HexGridState.PLACEHOLDER) {
      this.placeholder?.show()
      this.gridHelper?.hide()
    } else {
      this.placeholder?.hide()
      // gridHelper visibility controlled separately via setHelperVisible()
    }
  }

  /**
   * Set helper visibility (only applies in POPULATED state)
   */
  setHelperVisible(visible) {
    if (this.state === HexGridState.POPULATED && this.gridHelper) {
      if (visible) {
        this.gridHelper.show()
      } else {
        this.gridHelper.hide()
      }
    }
  }

  /**
   * Set hover state on placeholder button
   */
  setHover(isHovered) {
    this.placeholder?.setHover(isHovered)
  }

  /**
   * Get the placeholder button for raycasting
   */
  getPlaceholderButton() {
    return this.placeholder?.getButton()
  }

  /**
   * Get all placeholder clickables (button + triangles) for raycasting
   */
  getPlaceholderClickables() {
    return this.placeholder?.getClickables() ?? []
  }

  /**
   * Create always-visible grid coordinate label
   */
  createGridLabel(gridKey) {
    const div = document.createElement('div')
    div.className = 'grid-label'
    div.textContent = gridKey
    div.style.cssText = `
      color: yellow;
      font-family: monospace;
      font-size: 16px;
      font-weight: bold;
      background: rgba(0,0,0,0.7);
      padding: 4px 8px;
      border-radius: 4px;
      white-space: nowrap;
      pointer-events: none;
    `
    const label = new CSS2DObject(div)
    label.position.set(0, 3, 0)
    label.visible = false  // Hidden by default
    return label
  }

  /**
   * Set grid label visibility
   */
  setGridLabelVisible(visible) {
    if (this.gridLabel) {
      this.gridLabel.visible = visible
    }
  }

  /**
   * Update placeholder triangle indicators for neighbor directions
   * @param {number[]} directions - Array of directions (0-5) that have populated neighbors
   */
  setPlaceholderNeighbors(directions) {
    this.placeholder?.setNeighborDirections(directions)
  }

  /**
   * Populate the grid using WFC
   * @param {HexWFCAdjacencyRules} rules - WFC adjacency rules
   * @param {Array} seedTiles - Seed tiles for WFC [{ x, z, type, rotation, level }]
   *   Seeds can include neighbor tiles from adjacent grids (may be outside hex radius)
   * @param {Object} options - Options for WFC and animation
   */
  async populate(rules, seedTiles = [], options = {}) {
    // Ensure meshes are initialized
    if (!this.hexMesh) {
      await this.initMeshes(HexTileGeometry.geoms)
    }

    // Transition to POPULATED state
    this.state = HexGridState.POPULATED
    this.updateVisibility()
    const baseSize = this.gridRadius * 2 + 1
    this.hexTiles = []
    this.hexGrid = Array.from({ length: baseSize }, () => Array(baseSize).fill(null))

    const tileTypes = options.tileTypes ?? this.getDefaultTileTypes()
    const levelsCount = options.levelsCount ?? 2
    const weights = { ...options.weights }
    const seed = options.seed ?? null

    // Separate neighbor seeds (outside grid) from internal seeds
    const neighborSeeds = []
    const internalSeeds = []
    for (const s of seedTiles) {
      const offsetCol = s.x - this.gridRadius
      const offsetRow = s.z - this.gridRadius
      if (isInHexRadius(offsetCol, offsetRow, this.gridRadius)) {
        internalSeeds.push(s)
      } else {
        neighborSeeds.push(s)
      }
    }

    // Grid identifier for logging
    const gridId = this.gridCoords ? `${this.gridCoords.x},${this.gridCoords.z}` : '?'

    const globalCenterCube = this.globalCenterCube ?? { q: 0, r: 0, s: 0 }

    // Calculate padding needed to include neighbor seeds
    // IMPORTANT: Use even padding to preserve row parity (hex neighbor rules depend on row parity)
    let padding = 0
    if (neighborSeeds.length > 0) {
      for (const s of neighborSeeds) {
        const overflowX = Math.max(0, s.x - (baseSize - 1), -s.x)
        const overflowZ = Math.max(0, s.z - (baseSize - 1), -s.z)
        padding = Math.max(padding, overflowX, overflowZ, 1)
      }
      // Round up to even number to preserve row parity
      if (padding % 2 !== 0) padding++
    }

    // Expanded grid size with padding
    const wfcSize = baseSize + padding * 2

    // Adjust seed positions for padding offset
    const adjustedSeeds = []
    for (const s of [...internalSeeds, ...neighborSeeds]) {
      adjustedSeeds.push({
        x: s.x + padding,
        z: s.z + padding,
        type: s.type,
        rotation: s.rotation,
        level: s.level ?? 0
      })
    }

    // Add center grass seed if no seeds provided
    if (adjustedSeeds.length === 0) {
      const centerX = Math.floor(wfcSize / 2)
      const centerZ = Math.floor(wfcSize / 2)
      adjustedSeeds.push({ x: centerX, z: centerZ, type: HexTileType.GRASS, rotation: 0, level: 0 })
    }

    // Optionally seed water edge (on internal grid, not padding)
    if (options.seedWaterEdge ?? false) {
      this.addWaterEdgeSeeds(adjustedSeeds, baseSize, padding)
    }

    const solver = new HexWFCSolver(wfcSize, wfcSize, rules, {
      weights,
      seed,
      maxRestarts: options.maxRestarts ?? 10,
      tileTypes,
      levelsCount,
      // Coord conversion for logging (using cube coords - no stagger issues)
      padding,
      gridRadius: this.gridRadius,
      globalCenterCube,
    })

    let currentSeeds = [...adjustedSeeds]
    let result = null
    let attempt = 0
    const maxAttempts = 10

    // Graduated retry: remove problem seeds one at a time
    while (!result && attempt < maxAttempts) {
      attempt++

      const solver = new HexWFCSolver(wfcSize, wfcSize, rules, {
        attemptNum: attempt,
        weights,
        seed,
        maxRestarts: options.maxRestarts ?? 10,
        tileTypes,
        levelsCount,
        padding,
        gridRadius: this.gridRadius,
        globalCenterCube,
      })

      result = solver.solve(currentSeeds, gridId)

      if (!result && solver.lastContradiction && currentSeeds.length > 0) {
        // Find seeds adjacent to the failed cell
        const { failedX, failedZ } = solver.lastContradiction
        const problemSeeds = this.findAdjacentSeeds(currentSeeds, failedX, failedZ)

        if (problemSeeds.length > 0) {
          // Pick first neighbor to remove
          const seedToRemove = problemSeeds[0]
          const seedGlobal = solver.toGlobalCoords(seedToRemove.x, seedToRemove.z)
          const failedGlobal = solver.toGlobalCoords(failedX, failedZ)
          const typeName = Object.entries(HexTileType).find(([,v]) => v === seedToRemove.type)?.[0] || seedToRemove.type
          console.log(`%cRemoving seed (${seedGlobal.col},${seedGlobal.row}) ${typeName} near failed cell (${failedGlobal.col},${failedGlobal.row}) [${problemSeeds.length} candidates]`, 'color: red')
          currentSeeds = currentSeeds.filter(s => s !== seedToRemove)
        } else {
          // No adjacent seeds found, can't fix - break out
          console.log(`%cNo adjacent seeds to remove, giving up`, 'color: red')
          break
        }
      } else if (!result) {
        // Failed but no contradiction info or no seeds left
        break
      }
    }

    // Last resort: fall back to center grass (disconnected from neighbors)
    if (!result) {
      console.log(`%cFalling back to center grass seed`, 'color: red')
      const fallbackSolver = new HexWFCSolver(baseSize, baseSize, rules, {
        weights,
        seed,
        maxRestarts: options.maxRestarts ?? 10,
        tileTypes,
        levelsCount,
        padding: 0,
        gridRadius: this.gridRadius,
        globalCenterCube,
      })
      const centerX = Math.floor(baseSize / 2)
      const centerZ = Math.floor(baseSize / 2)
      result = fallbackSolver.solve([{ x: centerX, z: centerZ, type: HexTileType.GRASS, rotation: 0, level: 0 }], `${gridId} fallback`)
      padding = 0
    }

    if (!result) {
      return false
    }

    // Filter results to only include tiles within original hex radius (exclude padding)
    const filteredResult = result.filter(p => {
      const origX = p.gridX - padding
      const origZ = p.gridZ - padding
      const offsetCol = origX - this.gridRadius
      const offsetRow = origZ - this.gridRadius
      return isInHexRadius(offsetCol, offsetRow, this.gridRadius)
    }).map(p => ({
      ...p,
      gridX: p.gridX - padding,
      gridZ: p.gridZ - padding
    }))

    // Place tiles
    const animate = options.animate ?? false
    const animateDelay = options.animateDelay ?? 20
    const placements = animate ? solver.collapseOrder : filteredResult

    if (animate) {
      this.animatePlacements(placements, animateDelay)
    } else {
      for (const placement of placements) {
        this.placeTile(placement)
      }
      this.updateMatrices()
      this.populateDecorations()
    }

    return true
  }

  /**
   * Get default tile types for WFC
   */
  getDefaultTileTypes() {
    return [
      // Base
      HexTileType.GRASS,
      // Roads
      HexTileType.ROAD_A,
      HexTileType.ROAD_B,
      HexTileType.ROAD_D,
      HexTileType.ROAD_E,
      HexTileType.ROAD_F,
      HexTileType.ROAD_H,
      HexTileType.ROAD_J,
      HexTileType.ROAD_M,
      // Rivers
      HexTileType.RIVER_A,
      HexTileType.RIVER_A_CURVY,
      HexTileType.RIVER_B,
      HexTileType.RIVER_D,
      HexTileType.RIVER_E,
      HexTileType.RIVER_F,
      HexTileType.RIVER_G,
      HexTileType.RIVER_H,
      // Crossings
      HexTileType.RIVER_CROSSING_A,
      HexTileType.RIVER_CROSSING_B,
      // Coasts & Water
      HexTileType.WATER,
      HexTileType.COAST_A,
      HexTileType.COAST_B,
      HexTileType.COAST_C,
      HexTileType.COAST_D,
      HexTileType.COAST_E,
      // High slopes
      HexTileType.GRASS_SLOPE_HIGH,
      HexTileType.ROAD_A_SLOPE_HIGH,
      HexTileType.GRASS_CLIFF,
      HexTileType.GRASS_CLIFF_C,
      // Low slopes
      HexTileType.GRASS_SLOPE_LOW,
      HexTileType.ROAD_A_SLOPE_LOW,
      HexTileType.GRASS_CLIFF_LOW,
    ]
  }

  /**
   * Add water edge seeds (50% chance, 1 random edge)
   */
  addWaterEdgeSeeds(seedTiles, size, padding = 0) {
    if (random() >= 0.5) return

    const gridRadius = this.gridRadius
    const selectedEdge = Math.floor(random() * 6)

    for (let col = 0; col < size; col++) {
      for (let row = 0; row < size; row++) {
        const offsetCol = col - gridRadius
        const offsetRow = row - gridRadius
        if (!isInHexRadius(offsetCol, offsetRow, gridRadius)) continue

        // Check if edge tile
        const neighborOffsets = (row % 2 === 0)
          ? [[-1, -1], [0, -1], [-1, 0], [1, 0], [-1, 1], [0, 1]]
          : [[0, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [1, 1]]

        let isEdge = false
        for (const [dx, dz] of neighborOffsets) {
          if (!isInHexRadius(offsetCol + dx, offsetRow + dz, gridRadius)) {
            isEdge = true
            break
          }
        }
        if (!isEdge) continue

        // Get world position and determine which edge (0-5) based on angle
        const worldPos = HexTileGeometry.getWorldPosition(offsetCol, offsetRow)
        const angle = Math.atan2(worldPos.z, worldPos.x)
        const normalizedAngle = (angle + Math.PI) / (Math.PI * 2)
        const edgeIndex = Math.floor(normalizedAngle * 6) % 6

        if (edgeIndex === selectedEdge) {
          // Add padding offset for WFC grid coordinates
          seedTiles.push({ x: col + padding, z: row + padding, type: HexTileType.WATER, rotation: 0, level: 0 })
        }
      }
    }
  }

  /**
   * TEMP TEST: Add water seeds for ALL edge tiles to make island grids
   */
  addAllEdgeWaterSeeds(seedTiles, size) {
    const gridRadius = this.gridRadius
    const usedPositions = new Set(seedTiles.map(s => `${s.x},${s.z}`))

    for (let col = 0; col < size; col++) {
      for (let row = 0; row < size; row++) {
        const offsetCol = col - gridRadius
        const offsetRow = row - gridRadius
        if (!isInHexRadius(offsetCol, offsetRow, gridRadius)) continue

        // Check if edge tile (has at least one neighbor outside grid)
        const neighborOffsets = (row % 2 === 0)
          ? [[-1, -1], [0, -1], [-1, 0], [1, 0], [-1, 1], [0, 1]]
          : [[0, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [1, 1]]

        let isEdge = false
        for (const [dx, dz] of neighborOffsets) {
          if (!isInHexRadius(offsetCol + dx, offsetRow + dz, gridRadius)) {
            isEdge = true
            break
          }
        }
        if (!isEdge) continue

        // Skip if already seeded
        const posKey = `${col},${row}`
        if (usedPositions.has(posKey)) continue
        usedPositions.add(posKey)

        seedTiles.push({ x: col, z: row, type: HexTileType.WATER, rotation: 0, level: 0 })
      }
    }

    console.log(`[Island Test] Seeded ${seedTiles.length} edge tiles with water`)
  }

  /**
   * Find seeds adjacent to a given cell position
   * Used for graduated retry - identifies which seeds to remove when WFC fails
   */
  findAdjacentSeeds(seeds, cellX, cellZ) {
    const adjacent = []
    for (const seed of seeds) {
      // Check if seed is adjacent to the failed cell
      for (const dir of HexDir) {
        const offset = getHexNeighborOffset(cellX, cellZ, dir)
        if (seed.x === cellX + offset.dx && seed.z === cellZ + offset.dz) {
          adjacent.push(seed)
          break
        }
      }
    }
    return adjacent
  }

  // /**
  //  * Pick which seed to remove from problem seeds
  //  * Priority: 1) seeds with level mismatch, 2) grass over road/river
  //  */
  // pickSeedToRemove(problemSeeds, solver) {
  //   if (problemSeeds.length === 1) return problemSeeds[0]
  //
  //   // Score each seed (lower = remove first)
  //   const scored = problemSeeds.map(seed => {
  //     let score = 0
  //     const def = HexTileDefinitions[seed.type]
  //     const edges = def?.edges || {}
  //
  //     // Prefer removing seeds at non-zero levels (level mismatches are less visible)
  //     if (seed.level > 0) score -= 10
  //
  //     // Prefer removing grass over interesting features
  //     const hasRoad = Object.values(edges).includes('road')
  //     const hasRiver = Object.values(edges).includes('river')
  //     if (hasRoad) score += 5
  //     if (hasRiver) score += 5
  //
  //     return { seed, score }
  //   })
  //
  //   // Sort by score ascending (lowest score = remove first)
  //   scored.sort((a, b) => a.score - b.score)
  //   return scored[0].seed
  // }

  /**
   * Place a single tile
   */
  placeTile(placement) {
    const gridRadius = this.gridRadius
    const offsetCol = placement.gridX - gridRadius
    const offsetRow = placement.gridZ - gridRadius
    if (!isInHexRadius(offsetCol, offsetRow, gridRadius)) return null

    const tile = new HexTile(placement.gridX, placement.gridZ, placement.type, placement.rotation)
    tile.level = placement.level ?? 0
    this.hexGrid[placement.gridX][placement.gridZ] = tile
    this.hexTiles.push(tile)

    if (this.hexMesh && this.geomIds.has(placement.type)) {
      const geomId = this.geomIds.get(placement.type)
      tile.instanceId = this.hexMesh.addInstance(geomId)
      this.hexMesh.setColorAt(tile.instanceId, tile.color)
      // Hide initially
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.hexMesh.setMatrixAt(tile.instanceId, this.dummy.matrix)
    }
    return tile
  }

  /**
   * Animate tile placements
   */
  animatePlacements(placements, delay) {
    let i = 0
    const dropHeight = 5
    const animDuration = 0.4
    const LEVEL_HEIGHT = 0.5

    const step = () => {
      if (i >= placements.length) {
        this.updateMatrices()
        this.populateDecorations()
        return
      }
      const tile = this.placeTile(placements[i])
      if (tile && tile.instanceId !== null) {
        const pos = HexTileGeometry.getWorldPosition(
          tile.gridX - this.gridRadius,
          tile.gridZ - this.gridRadius
        )
        const rotation = -tile.rotation * Math.PI / 3
        const targetY = tile.level * LEVEL_HEIGHT

        const anim = { y: dropHeight + targetY, scale: 0.5 }
        const dummy = this.dummy
        const mesh = this.hexMesh
        const instanceId = tile.instanceId

        gsap.to(anim, {
          y: targetY,
          scale: 1,
          duration: animDuration,
          ease: 'power2.out',
          onUpdate: () => {
            dummy.position.set(pos.x, anim.y, pos.z)
            dummy.rotation.y = rotation
            dummy.scale.setScalar(anim.scale)
            dummy.updateMatrix()
            mesh.setMatrixAt(instanceId, dummy.matrix)
          }
        })
      }
      i++
      setTimeout(step, delay)
    }
    step()
  }

  /**
   * Update all tile matrices
   */
  updateMatrices() {
    if (!this.hexMesh || !this.hexTiles) return

    const dummy = this.dummy
    const rotationAngles = [0, 1, 2, 3, 4, 5].map(r => -r * Math.PI / 3)
    const gridRadius = this.gridRadius
    const LEVEL_HEIGHT = 0.5

    for (const tile of this.hexTiles) {
      if (tile.instanceId === null) continue

      const pos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      dummy.position.set(pos.x, tile.level * LEVEL_HEIGHT, pos.z)
      dummy.scale.set(1, 1, 1)
      dummy.rotation.y = rotationAngles[tile.rotation]
      dummy.updateMatrix()

      this.hexMesh.setMatrixAt(tile.instanceId, dummy.matrix)
      this.hexMesh.setVisibleAt(tile.instanceId, true)
    }
  }

  /**
   * Populate decorations (trees, buildings, bridges)
   */
  populateDecorations() {
    if (!this.decorations) return
    this.decorations.populate(this.hexTiles, this.gridRadius)
    this.decorations.populateBuildings(this.hexTiles, this.hexGrid, this.gridRadius)
    this.decorations.populateBridges(this.hexTiles, this.gridRadius)
  }

  /**
   * Clear all tiles
   */
  clearTiles() {
    if (this.hexMesh) {
      for (const tile of this.hexTiles) {
        if (tile.instanceId !== null) {
          this.hexMesh.deleteInstance(tile.instanceId)
        }
      }
    }
    this.hexTiles = []
    this.hexGrid = null
  }

  /**
   * Dispose of all resources
   */
  dispose() {
    this.clearTiles()

    if (this.decorations) {
      this.decorations.dispose()
      this.decorations = null
    }

    if (this.gridHelper) {
      this.gridHelper.dispose()
      this.gridHelper = null
    }

    if (this.placeholder) {
      this.placeholder.dispose()
      this.placeholder = null
    }

    if (this.axesHelper) {
      this.axesHelper.dispose()
      this.axesHelper = null
    }

    if (this.gridLabel) {
      this.gridLabel.element?.remove()
      this.gridLabel = null
    }

    if (this.outline) {
      this.outline.geometry?.dispose()
      this.outline.material?.dispose()
      this.outline = null
    }

    if (this.hexMesh) {
      this.hexMesh.dispose()
      this.hexMesh = null
    }

    // Remove group from scene
    this.scene.remove(this.group)

    this.geomIds?.clear()
  }
}
