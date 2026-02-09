import {
  Object3D,
  BatchedMesh,
  Group,
  AxesHelper,
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  LineBasicMaterial,
  Color,
} from 'three/webgpu'
import { CSS2DObject } from 'three/examples/jsm/Addons.js'
import gsap from 'gsap'
import { HexWFCSolver, HexWFCAdjacencyRules } from './HexWFC.js'
import { random } from './SeededRandom.js'
import { log } from './Demo.js'
import { Sounds } from './lib/Sounds.js'
import {
  TileType,
  HexDir,
  getHexNeighborOffset,
  TILE_LIST,
  LEVELS_COUNT,
} from './HexTileData.js'
import { HexTile, HexTileGeometry, isInHexRadius } from './HexTiles.js'
import { Decorations } from './Decorations.js'
import { HexGridHelper } from './HexGridHelper.js'
import { Placeholder } from './Placeholder.js'
import { localToGlobalCoords } from './HexGridConnector.js'

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
    this.hexMesh.frustumCulled = false
    this.group.add(this.hexMesh)

    // Register geometries in BatchedMesh
    this.geomIds = new Map()
    for (const [type, geom] of geometries) {
      if (geom) {
        const geomId = this.hexMesh.addGeometry(geom)
        this.geomIds.set(type, geomId)
      }
    }

    // Initialize color buffer with a dummy white instance (fixes WebGPU color sync issue)
    // This ensures setColorAt is called before first render
    const firstGeomId = this.geomIds.values().next().value
    if (firstGeomId !== undefined) {
      const WHITE = new Color(0xffffff)
      this.hexMesh._dummyInstanceId = this.hexMesh.addInstance(firstGeomId)
      this.hexMesh.setColorAt(this.hexMesh._dummyInstanceId, WHITE)
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.hexMesh.setMatrixAt(this.hexMesh._dummyInstanceId, this.dummy.matrix)
    }

    // Initialize decorations for this grid (pass worldOffset for noise sampling)
    this.decorations = new Decorations(this.group, this.worldOffset)
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
   * Set helper visibility (works for both POPULATED and PLACEHOLDER states)
   */
  setHelperVisible(visible) {
    if (this.gridHelper) {
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
   *   - solveWfcAsync: async function to solve WFC via worker (optional)
   *   - onSolveStart: callback when solve starts (for animation)
   *   - onSolveEnd: callback when solve ends (for animation)
   */
  async populate(rules, seedTiles = [], options = {}) {
    // Ensure meshes are initialized
    if (!this.hexMesh) {
      await this.initMeshes(HexTileGeometry.geoms)
    }

    // Keep in PLACEHOLDER state during solve (so spinner is visible)
    // Will transition to POPULATED after solve completes
    const baseSize = this.gridRadius * 2 + 1
    this.hexTiles = []
    this.hexGrid = Array.from({ length: baseSize }, () => Array(baseSize).fill(null))

    const tileTypes = options.tileTypes ?? this.getDefaultTileTypes()
    const weights = { ...options.weights }
    const seed = options.seed ?? null
    const onSeedDropped = options.onSeedDropped ?? null
    const onCellFailed = options.onCellFailed ?? null
    const onTryReplaceSeed = options.onTryReplaceSeed ?? null  // Callback to attempt seed replacement
    let replacedCount = options.replacedCount ?? 0

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

    // Adjust seed positions for padding offset (preserve source info for replacement callback)
    const adjustedSeeds = []
    for (const s of [...internalSeeds, ...neighborSeeds]) {
      adjustedSeeds.push({
        x: s.x + padding,
        z: s.z + padding,
        type: s.type,
        rotation: s.rotation,
        level: s.level ?? 0,
        // Preserve source grid info for replacement callback
        sourceGridKey: s.sourceGridKey,
        sourceX: s.sourceX,
        sourceZ: s.sourceZ,
      })
    }

    // Add center grass seed if no seeds provided
    if (adjustedSeeds.length === 0) {
      const centerX = Math.floor(wfcSize / 2)
      const centerZ = Math.floor(wfcSize / 2)
      adjustedSeeds.push({ x: centerX, z: centerZ, type: TileType.GRASS, rotation: 0, level: 0 })
    }

    // Optionally seed water edge (on internal grid, not padding)
    if (options.seedWaterEdge ?? false) {
      this.addWaterEdgeSeeds(adjustedSeeds, baseSize, padding)
    }

    let currentSeeds = [...adjustedSeeds]
    const initialSeedCount = currentSeeds.length
    let droppedCount = 0
    let result = null
    let resultCollapseOrder = []
    let attempt = 0
    const replacedSeedKeys = new Set()  // Track seeds already replaced

    // Get async solver from options (provided by HexMap)
    const solveWfcAsync = options.solveWfcAsync ?? null

    // Helper to convert seed coords to global (uses shared utility, adjusted for padding)
    const toGlobalCoords = (x, z) => localToGlobalCoords(x - padding, z - padding, this.gridRadius, globalCenterCube)

    // Helper to run WFC and return result
    const runWfc = async () => {
      attempt++
      const solverOptions = {
        attemptNum: attempt,
        weights,
        seed,
        maxRestarts: 1,
        tileTypes,
        padding,
        gridRadius: this.gridRadius,
        globalCenterCube,
        gridId,
      }

      // Filter out dropped seeds for WFC (they failed, don't constrain WFC with them)
      const activeSeeds = currentSeeds.filter(s => !s.dropped)

      if (solveWfcAsync) {
        const workerResult = await solveWfcAsync(wfcSize, wfcSize, activeSeeds, solverOptions)
        if (workerResult.success) {
          return { success: true, tiles: workerResult.tiles, collapseOrder: workerResult.collapseOrder || [] }
        }
        if (workerResult.seedingContradiction) {
          const { failedX, failedZ } = workerResult.seedingContradiction
          const failedGlobal = toGlobalCoords(failedX, failedZ)
          onCellFailed?.(`${failedGlobal.col},${failedGlobal.row}`)
        }
        return { success: false }
      } else {
        const solver = new HexWFCSolver(wfcSize, wfcSize, rules, solverOptions)
        const tiles = solver.solve(activeSeeds, gridId)
        if (tiles) {
          return { success: true, tiles, collapseOrder: solver.collapseOrder }
        }
        if (solver.seedingContradiction) {
          const { failedX, failedZ } = solver.seedingContradiction
          const failedGlobal = toGlobalCoords(failedX, failedZ)
          onCellFailed?.(`${failedGlobal.col},${failedGlobal.row}`)
        }
        return { success: false }
      }
    }

    // Shuffle seeds for random order
    const shuffleArray = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    }

    // Notify solve start (for placeholder animation)
    options.onSolveStart?.()

    try {
      // Initial WFC attempt
      log(`WFC Phase 0: Initial attempt`, 'color: gray')
      const initialResult = await runWfc()
      if (initialResult.success) {
        result = initialResult.tiles
        resultCollapseOrder = initialResult.collapseOrder
      } else {
        // Phase 1: Try replacing each seed one by one
        log(`WFC Phase 1: Trying replacements (${currentSeeds.length} seeds)`, 'color: gray')
        const shuffledForReplace = shuffleArray([...currentSeeds])

        for (const seedToReplace of shuffledForReplace) {
          if (result) break

          const seedGlobal = toGlobalCoords(seedToReplace.x, seedToReplace.z)
          const globalKey = `${seedGlobal.col},${seedGlobal.row}`

          // Skip if already replaced
          if (replacedSeedKeys.has(globalKey)) continue

          // Try replacement
          if (onTryReplaceSeed) {
            const replaced = onTryReplaceSeed(seedToReplace, currentSeeds)
            if (replaced) {
              log(`Phase 1: Replaced seed (${globalKey})`, 'color: orange')
              replacedCount++
              replacedSeedKeys.add(globalKey)

              // Run WFC after replacement
              const wfcResult = await runWfc()
              if (wfcResult.success) {
                result = wfcResult.tiles
                resultCollapseOrder = wfcResult.collapseOrder
              }
            }
          }
        }

        // Phase 2: Try dropping each seed one by one
        if (!result) {
          log(`WFC Phase 2: Trying drops`, 'color: gray')
          const shuffledForDrop = shuffleArray(
            currentSeeds.filter(s => !s.dropped)
          )

          for (const seedToDrop of shuffledForDrop) {
            if (result) break

            const seedGlobal = toGlobalCoords(seedToDrop.x, seedToDrop.z)
            const globalKey = `${seedGlobal.col},${seedGlobal.row}`

            log(`Phase 2: Dropping seed (${globalKey})`, 'color: red')
            onSeedDropped?.(globalKey)
            droppedCount++
            seedToDrop.dropped = true

            // Run WFC after drop
            const wfcResult = await runWfc()
            if (wfcResult.success) {
              result = wfcResult.tiles
              resultCollapseOrder = wfcResult.collapseOrder
            }
          }
        }
      }
    } finally {
      // Notify solve end (for placeholder animation)
      options.onSolveEnd?.()
    }

    if (!result) {
      log(`WFC FAILED - Grid not populated`, 'color: red')
      Sounds.play('incorrect')
      return false
    }

    // Log final status
    const stats = [`${initialSeedCount} seeds`]
    if (replacedCount > 0) stats.push(`${replacedCount} replaced`)
    if (droppedCount > 0) stats.push(`${droppedCount} dropped`)
    log(`WFC SUCCESS - ${stats.join(', ')}`, 'color: green')

    // Transition to POPULATED state now that solve succeeded
    this.state = HexGridState.POPULATED
    this.updateVisibility()

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

    // Get WFC collapse order for animation (filtered and adjusted for padding)
    const collapseOrder = resultCollapseOrder.filter(p => {
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

    // Use filteredResult for placement, collapseOrder for animation
    const placements = filteredResult

    // Place all tiles first (synchronously in both paths)
    for (const placement of placements) {
      this.placeTile(placement)
    }
    this.updateMatrices()
    this.populateDecorations()

    if (animate) {
      // Hide everything, then animate tiles dropping in (using WFC collapse order)
      this.hideAllInstances()
      this.animatePlacements(collapseOrder, animateDelay)
    }

    return true
  }

  /**
   * Get default tile types for WFC
   */
  getDefaultTileTypes() {
    return TILE_LIST.map((_, i) => i)
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
          seedTiles.push({ x: col + padding, z: row + padding, type: TileType.WATER, rotation: 0, level: 0 })
        }
      }
    }
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

  /**
   * Find the seed nearest to a given cell position
   * Uses hex distance (max of cube coord differences)
   */
  findNearestSeed(seeds, cellX, cellZ) {
    if (seeds.length === 0) return null

    let nearest = null
    let minDist = Infinity

    for (const seed of seeds) {
      // Calculate hex distance using offset coords
      const dx = seed.x - cellX
      const dz = seed.z - cellZ
      // Approximate hex distance (good enough for comparison)
      const dist = Math.abs(dx) + Math.abs(dz) + Math.abs(dx + dz)

      if (dist < minDist) {
        minDist = dist
        nearest = seed
      }
    }

    return nearest
  }

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
    tile.updateLevelColor()
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
   * Replace an existing tile with a different type/rotation
   * Used by neighbor tile replacement to fix seed conflicts
   */
  replaceTile(gridX, gridZ, newType, newRotation, newLevel = 0) {
    const oldTile = this.hexGrid[gridX]?.[gridZ]
    if (!oldTile) {
      console.warn(`[replaceTile] No tile at (${gridX}, ${gridZ})`)
      return null
    }

    // Update tile data
    oldTile.type = newType
    oldTile.rotation = newRotation
    oldTile.level = newLevel
    oldTile.updateLevelColor()

    // Update BatchedMesh geometry
    if (this.hexMesh && this.geomIds.has(newType) && oldTile.instanceId !== undefined) {
      const newGeomId = this.geomIds.get(newType)
      this.hexMesh.setGeometryIdAt(oldTile.instanceId, newGeomId)
      this.hexMesh.setColorAt(oldTile.instanceId, oldTile.color)

      // Update matrix for new rotation
      const LEVEL_HEIGHT = 0.5
      const offsetCol = gridX - this.gridRadius
      const offsetRow = gridZ - this.gridRadius
      const pos = HexTileGeometry.getWorldPosition(offsetCol, offsetRow)
      this.dummy.position.set(pos.x, oldTile.level * LEVEL_HEIGHT, pos.z)
      this.dummy.rotation.y = -oldTile.rotation * Math.PI / 3
      this.dummy.scale.setScalar(1)
      this.dummy.updateMatrix()
      this.hexMesh.setMatrixAt(oldTile.instanceId, this.dummy.matrix)
    }

    return oldTile
  }

  /**
   * Hide all tile and decoration instances (for animation start)
   */
  hideAllInstances() {
    const dummy = this.dummy
    dummy.scale.setScalar(0)
    dummy.updateMatrix()

    // Hide tiles
    for (const tile of this.hexTiles) {
      if (tile.instanceId !== null) {
        this.hexMesh.setMatrixAt(tile.instanceId, dummy.matrix)
      }
    }

    // Hide decorations
    if (this.decorations) {
      for (const tree of this.decorations.trees) {
        this.decorations.treeMesh.setMatrixAt(tree.instanceId, dummy.matrix)
      }
      for (const building of this.decorations.buildings) {
        this.decorations.buildingMesh.setMatrixAt(building.instanceId, dummy.matrix)
      }
      for (const bridge of this.decorations.bridges) {
        this.decorations.bridgeMesh.setMatrixAt(bridge.instanceId, dummy.matrix)
      }
    }
  }

  /**
   * Animate tile placements with GSAP drop-in (tiles already placed but hidden)
   * Each decoration drops 0.5s after its tile
   */
  animatePlacements(collapseOrder, delay) {
    const LEVEL_HEIGHT = 0.5
    const DROP_HEIGHT = 5
    const ANIM_DURATION = 0.4
    const DEC_DELAY = 400 // Decoration drops after its tile
    const dummy = new Object3D()

    // Build decoration lookup by tile position
    const decsByTile = this.buildDecorationMap()

    let i = 0
    const step = () => {
      if (i >= collapseOrder.length) return

      const placement = collapseOrder[i]
      const tile = this.hexGrid[placement.gridX]?.[placement.gridZ]

      if (tile && tile.instanceId !== null) {
        const pos = HexTileGeometry.getWorldPosition(
          tile.gridX - this.gridRadius,
          tile.gridZ - this.gridRadius
        )
        const targetY = tile.level * LEVEL_HEIGHT
        const rotationY = -tile.rotation * Math.PI / 3

        // Animate tile from above
        const anim = { y: targetY + DROP_HEIGHT, scale: 1 }
        gsap.to(anim, {
          y: targetY,
          duration: ANIM_DURATION,
          ease: 'power1.out',
          onUpdate: () => {
            dummy.position.set(pos.x, anim.y, pos.z)
            dummy.rotation.y = rotationY
            dummy.scale.setScalar(anim.scale)
            dummy.updateMatrix()
            this.hexMesh.setMatrixAt(tile.instanceId, dummy.matrix)
          }
        })

        // Schedule decoration for this tile 0.5s later
        const tileKey = `${tile.gridX},${tile.gridZ}`
        const decs = decsByTile.get(tileKey)
        if (decs) {
          setTimeout(() => {
            this.animateDecoration(decs)
          }, DEC_DELAY)
        }
      }

      i++
      setTimeout(step, delay)
    }
    step()
  }

  /**
   * Build a map of tile position -> decorations on that tile
   */
  buildDecorationMap() {
    const map = new Map()
    if (!this.decorations) return map

    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1

    for (const tree of this.decorations.trees) {
      const key = `${tree.tile.gridX},${tree.tile.gridZ}`
      const pos = HexTileGeometry.getWorldPosition(
        tree.tile.gridX - this.gridRadius,
        tree.tile.gridZ - this.gridRadius
      )
      if (!map.has(key)) map.set(key, [])
      map.get(key).push({
        mesh: this.decorations.treeMesh,
        instanceId: tree.instanceId,
        x: pos.x,
        y: tree.tile.level * LEVEL_HEIGHT + TILE_SURFACE,
        z: pos.z,
        rotationY: tree.rotationY ?? 0
      })
    }

    for (const building of this.decorations.buildings) {
      const key = `${building.tile.gridX},${building.tile.gridZ}`
      const pos = HexTileGeometry.getWorldPosition(
        building.tile.gridX - this.gridRadius,
        building.tile.gridZ - this.gridRadius
      )
      if (!map.has(key)) map.set(key, [])
      map.get(key).push({
        mesh: this.decorations.buildingMesh,
        instanceId: building.instanceId,
        x: pos.x,
        y: building.tile.level * LEVEL_HEIGHT + TILE_SURFACE,
        z: pos.z,
        rotationY: building.rotationY ?? 0
      })
    }

    for (const bridge of this.decorations.bridges) {
      const key = `${bridge.tile.gridX},${bridge.tile.gridZ}`
      const pos = HexTileGeometry.getWorldPosition(
        bridge.tile.gridX - this.gridRadius,
        bridge.tile.gridZ - this.gridRadius
      )
      if (!map.has(key)) map.set(key, [])
      map.get(key).push({
        mesh: this.decorations.bridgeMesh,
        instanceId: bridge.instanceId,
        x: pos.x,
        y: bridge.tile.level * LEVEL_HEIGHT,
        z: pos.z,
        rotationY: -bridge.tile.rotation * Math.PI / 3
      })
    }

    return map
  }

  /**
   * Animate a single decoration or array of decorations dropping in
   */
  animateDecoration(items) {
    const DROP_HEIGHT = 4
    const ANIM_DURATION = 0.3
    const dummy = new Object3D()

    const list = Array.isArray(items) ? items : [items]
    for (const item of list) {
      const anim = { y: item.y + DROP_HEIGHT, scale: 0.5 }
      gsap.to(anim, {
        y: item.y,
        scale: 1,
        duration: ANIM_DURATION,
        ease: 'power1.out',
        onUpdate: () => {
          dummy.position.set(item.x, anim.y, item.z)
          dummy.rotation.y = item.rotationY
          dummy.scale.setScalar(anim.scale)
          dummy.updateMatrix()
          item.mesh.setMatrixAt(item.instanceId, dummy.matrix)
        }
      })
    }
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
   * Update all tile colors (for debug level visualization toggle)
   */
  updateTileColors() {
    if (!this.hexMesh) return
    for (const tile of this.hexTiles) {
      tile.updateLevelColor()
      if (tile.instanceId !== null) {
        this.hexMesh.setColorAt(tile.instanceId, tile.color)
      }
    }
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
