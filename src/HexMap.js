import {
  Object3D,
  MeshPhysicalNodeMaterial,
  PlaneGeometry,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector2,
} from 'three/webgpu'
import WFCWorker from './workers/wfc.worker.js?worker'
import { uniform, varyingProperty, materialColor, vec3 } from 'three/tsl'
import { CSS2DObject } from 'three/examples/jsm/Addons.js'
import { HexWFCAdjacencyRules, edgesCompatible, getEdgeLevel } from './HexWFC.js'
import { setStatus } from './Demo.js'
import { TILE_LIST, TileType, HexDir, HexOpposite, getHexNeighborOffset, rotateHexEdges } from './HexTileData.js'
import { HexTileGeometry, isInHexRadius } from './HexTiles.js'
import { HexGrid, HexGridState } from './HexGrid.js'
import {
  GridDirection,
  getGridKey,
  parseGridKey,
  getAdjacentGridKey,
  getGridWorldOffset,
  getNeighborSeeds,
  getOppositeDirection,
  filterConflictingSeeds,
  validateSeedConflicts,
  findReplacementTiles,
  worldOffsetToGlobalCube,
  offsetToCube,
  cubeToOffset,
  localToGlobalCoords,
} from './HexGridConnector.js'
import { Demo } from './Demo.js'
import { initGlobalTreeNoise } from './Decorations.js'

/**
 * HexMap - Manages the entire world of multiple HexGrid instances
 *
 * Handles:
 * - Creating and managing multiple HexGrid instances
 * - Grid expansion via placeholder clicks
 * - Shared resources (WFC rules, material)
 *
 * Grids can be in two states:
 * - PLACEHOLDER: Shows clickable button, no tiles yet
 * - POPULATED: Has tiles, shows debug helper when enabled
 */
export class HexMap {
  constructor(scene, params) {
    this.scene = scene
    this.params = params

    this.dummy = new Object3D()

    // Grid management - all grids (both PLACEHOLDER and POPULATED)
    this.grids = new Map()  // key: "x,z" grid coords, value: HexGrid instance
    this.hexGridRadius = 8
    this.roadMaterial = null

    // WFC rules (shared across all grids)
    this.hexWfcRules = null

    // Environment rotation uniforms
    this.envRotation = uniform(0)
    this.envRotationX = uniform(0)

    // Debug tile labels
    this.tileLabels = new Object3D()
    this.tileLabels.visible = false
    this.droppedSeeds = new Set()  // Track global coords of dropped seeds for label highlighting
    this.failedCells = new Set()   // Track global coords of cells that caused WFC failures
    this.replacedSeeds = new Set() // Track global coords of replaced seeds for label highlighting

    // Interaction
    this.raycaster = new Raycaster()
    this.hoveredGrid = null  // HexGrid being hovered

    // Helper visibility state
    this.helpersVisible = false
    this.axesHelpersVisible = false

    // Regeneration state (prevents overlay rendering during disposal)
    this.isRegenerating = false

    // WFC Web Worker
    this.wfcWorker = null
    this.wfcPendingResolvers = new Map()  // Map<requestId, resolver> for concurrent WFC solves
    this.wfcRequestId = 0
  }

  async init() {
    await HexTileGeometry.init('./assets/models/hex-terrain.glb')
    this.createFloor()
    await this.initMaterial()
    this.initWfcRules()
    this.initWfcWorker()
    initGlobalTreeNoise()  // Initialize shared noise for tree placement

    // Create center grid at (0,0) and immediately populate it
    const centerGrid = await this.createGrid(0, 0)
    await this.populateGrid(centerGrid, [])

    // Create placeholder grids around the center
    this.createAdjacentPlaceholders('0,0')

    this.scene.add(this.tileLabels)
  }

  /**
   * Initialize shared material
   */
  async initMaterial() {
    if (!HexTileGeometry.loaded || HexTileGeometry.geoms.size === 0) {
      console.warn('HexTileGeometry not loaded')
      return
    }

    const glbMat = HexTileGeometry.material
    if (glbMat) {
      this.roadMaterial = glbMat
    } else {
      const mat = new MeshPhysicalNodeMaterial()
      mat.color.setHex(0x88aa88)
      mat.roughness = 0.8
      mat.metalness = 0.1
      this.roadMaterial = mat
    }

    // Enable instance colors (multiplied with base material color)
    // BatchedMesh stores per-instance colors in vBatchColor varying
    const batchColor = varyingProperty('vec3', 'vBatchColor')
    this.roadMaterial.colorNode = materialColor.mul(batchColor)
  }

  /**
   * Initialize shared WFC rules
   */
  initWfcRules() {
    const tileTypes = this.getDefaultTileTypes()
    this.hexWfcRules = HexWFCAdjacencyRules.fromTileDefinitions(tileTypes)
  }

  /**
   * Initialize WFC Web Worker
   */
  initWfcWorker() {
    try {
      this.wfcWorker = new WFCWorker()
      this.wfcWorker.onmessage = (e) => this.handleWfcMessage(e)
      this.wfcWorker.onerror = (e) => {
        console.error('WFC Worker error:', e)
        // Resolve all pending requests with failure
        for (const [id, resolve] of this.wfcPendingResolvers) {
          resolve({ success: false, tiles: null, collapseOrder: [] })
        }
        this.wfcPendingResolvers.clear()
      }
    } catch (e) {
      console.warn('Failed to create WFC worker, will use sync solver:', e)
      this.wfcWorker = null
    }
  }

  /**
   * Handle messages from WFC worker
   */
  handleWfcMessage(e) {
    const { type, id, message, success, tiles, collapseOrder } = e.data

    if (type === 'log') {
      // Stream log to status bar
      console.log('[WFC Worker]', message)
      setStatus(message)
    } else if (type === 'result') {
      // Resolve pending promise by ID
      const resolve = this.wfcPendingResolvers.get(id)
      if (resolve) {
        const { seedingContradiction } = e.data
        resolve({ success, tiles, collapseOrder, seedingContradiction })
        this.wfcPendingResolvers.delete(id)
      }
    }
  }

  /**
   * Solve WFC using Web Worker (async)
   * Returns promise that resolves with { success, tiles, collapseOrder }
   */
  solveWfcAsync(width, height, seeds, options) {
    return new Promise((resolve) => {
      if (!this.wfcWorker) {
        // No worker available, resolve with null to trigger fallback
        resolve({ success: false, tiles: null, collapseOrder: [] })
        return
      }

      const id = `wfc_${++this.wfcRequestId}`

      // Set up timeout (10 seconds)
      const timeout = setTimeout(() => {
        console.warn('WFC worker timeout, falling back to sync')
        if (this.wfcPendingResolvers.has(id)) {
          this.wfcPendingResolvers.get(id)({ success: false, tiles: null, collapseOrder: [] })
          this.wfcPendingResolvers.delete(id)
        }
      }, 10000)

      // Store resolver with timeout cleanup
      this.wfcPendingResolvers.set(id, (result) => {
        clearTimeout(timeout)
        resolve(result)
      })

      this.wfcWorker.postMessage({
        type: 'solve',
        id,
        width,
        height,
        seeds,
        options
      })
    })
  }

  /**
   * Get default tile types for WFC
   */
  getDefaultTileTypes() {
    return TILE_LIST.map((_, i) => i)
  }

  createFloor() {
    const floorGeometry = new PlaneGeometry(296, 296)
    floorGeometry.rotateX(-Math.PI / 2)

    const floorMaterial = new MeshStandardMaterial({
      color: 0x999999,
      roughness: 0.9,
      metalness: 0.0
    })

    this.floor = new Mesh(floorGeometry, floorMaterial)
    this.floor.receiveShadow = true
    this.scene.add(this.floor)
  }

  /**
   * Create a new HexGrid at grid coordinates (starts in PLACEHOLDER state)
   * @param {number} gridX - Grid X coordinate
   * @param {number} gridZ - Grid Z coordinate
   * @returns {HexGrid} The created grid
   */
  async createGrid(gridX, gridZ) {
    const key = getGridKey(gridX, gridZ)
    if (this.grids.has(key)) {
      console.warn(`Grid already exists at ${key}`)
      return this.grids.get(key)
    }

    // Calculate world offset and global cube center
    const worldOffset = this.calculateWorldOffset(gridX, gridZ)
    const globalCenterCube = worldOffsetToGlobalCube(worldOffset)

    // Create grid in PLACEHOLDER state
    const grid = new HexGrid(this.scene, this.roadMaterial, this.hexGridRadius, worldOffset)
    grid.gridCoords = { x: gridX, z: gridZ }
    grid.globalCenterCube = globalCenterCube
    grid.onClick = () => this.onGridClick(grid)

    await grid.init()  // Don't pass geometries - stays in PLACEHOLDER state

    // Apply current axes helper visibility
    if (grid.axesHelper) {
      grid.axesHelper.visible = this.axesHelpersVisible
    }

    // Apply current grid label visibility
    grid.setGridLabelVisible(this.tileLabels.visible)

    this.grids.set(key, grid)

    // Set triangle indicators for populated neighbors
    const neighborDirs = this.getPopulatedNeighborDirections(key)
    grid.setPlaceholderNeighbors(neighborDirs)

    return grid
  }

  /**
   * Populate a grid (transition from PLACEHOLDER to POPULATED)
   * @param {HexGrid} grid - Grid to populate
   * @param {Array} seedTiles - Optional seed tiles for WFC (including neighbor seeds)
   * @param {Object} options - Optional WFC options (animate, animateDelay, etc.)
   */
  async populateGrid(grid, seedTiles = [], options = {}) {
    if (grid.state === HexGridState.POPULATED) {
      console.warn('Grid already populated')
      return
    }

    const params = Demo.instance?.params ?? this.params

    await grid.populate(this.hexWfcRules, seedTiles, {
      seed: params?.roads?.wfcSeed ?? null,
      seedWaterEdge: seedTiles.length === 0,
      tileTypes: this.getDefaultTileTypes(),
      onSeedDropped: (globalCoord) => this.droppedSeeds.add(globalCoord),
      onCellFailed: (globalCoord) => this.failedCells.add(globalCoord),
      // Try to replace a seed tile instead of dropping it
      onTryReplaceSeed: (seed, currentSeeds) => {
        if (!seed?.sourceGridKey) return false
        const sourceGrid = this.grids.get(seed.sourceGridKey)
        if (!sourceGrid?.hexGrid) return false

        // Get all replacement candidates that match the source grid's interior
        const candidates = findReplacementTiles(
          seed,
          sourceGrid.hexGrid,
          sourceGrid.gridRadius,
          sourceGrid.globalCenterCube
        )

        // Helper to get global coords for a seed
        const seedToGlobal = (s) => {
          if (s.sourceGridKey) {
            const sg = this.grids.get(s.sourceGridKey)
            if (sg) return localToGlobalCoords(s.sourceX, s.sourceZ, sg.gridRadius, sg.globalCenterCube)
          }
          return { col: '?', row: '?' }
        }
        const seedGlobalStr = (s) => {
          const g = seedToGlobal(s)
          return `(${g.col},${g.row})`
        }

        // Try each candidate until we find one compatible with adjacent seeds
        for (const replacement of candidates) {
          const replacementEdges = rotateHexEdges(TILE_LIST[replacement.type]?.edges || {}, replacement.rotation)
          let compatibleWithSeeds = true
          const typeName = TILE_LIST[replacement.type]?.name

          // Log all 6 directions for this candidate
          const seedGlobal = seedToGlobal(seed)
          console.log(`%c    [WFC] Testing ${typeName} rot=${replacement.rotation} at ${seedGlobalStr(seed)}`, 'color: blue')

          for (const dir of HexDir) {
            const offset = getHexNeighborOffset(seed.x, seed.z, dir)
            const nx = seed.x + offset.dx
            const nz = seed.z + offset.dz

            // Find if there's another seed at this adjacent position
            const adjacentSeed = currentSeeds?.find(s => s.x === nx && s.z === nz && s !== seed)
            const myEdge = replacementEdges[dir]
            const myLevel = getEdgeLevel(replacement.type, replacement.rotation, dir, replacement.level)

            if (adjacentSeed) {
              // Check edge compatibility
              const adjacentEdges = rotateHexEdges(TILE_LIST[adjacentSeed.type]?.edges || {}, adjacentSeed.rotation)
              const theirEdge = adjacentEdges[HexOpposite[dir]]
              const theirLevel = getEdgeLevel(adjacentSeed.type, adjacentSeed.rotation, HexOpposite[dir], adjacentSeed.level ?? 0)

              const adjTypeName = TILE_LIST[adjacentSeed.type]?.name
              const isMatch = edgesCompatible(myEdge, myLevel, theirEdge, theirLevel)
              const droppedFlag = adjacentSeed.dropped ? ' [DROPPED]' : ''
              console.log(`%c      ${dir}: ${myEdge}@${myLevel} vs ${adjTypeName}${seedGlobalStr(adjacentSeed)}${droppedFlag} ${HexOpposite[dir]}→${theirEdge}@${theirLevel} ${isMatch ? '✓' : '✗'}`, isMatch ? 'color: blue' : 'color: red')

              if (!isMatch) {
                compatibleWithSeeds = false
                break
              }
            } else {
              console.log(`%c      ${dir}: ${myEdge}@${myLevel} → no seed`, 'color: gray')
            }
          }

          if (compatibleWithSeeds) {
            console.log(`%c    [WFC] ✓ APPLYING: ${typeName} rot=${replacement.rotation}`, 'color: green; font-weight: bold')
            // Found a compatible replacement
            const seedGlobal = localToGlobalCoords(seed.sourceX, seed.sourceZ, sourceGrid.gridRadius, sourceGrid.globalCenterCube)
            this.replacedSeeds.add(`${seedGlobal.col},${seedGlobal.row}`)

            // Update source grid tile
            sourceGrid.replaceTile(seed.sourceX, seed.sourceZ, replacement.type, replacement.rotation, replacement.level)
            // Update seed in place
            seed.type = replacement.type
            seed.rotation = replacement.rotation
            seed.level = replacement.level
            return true
          }
        }
        return false  // No compatible candidate found for this edge type
      },
      // Pass worker solve function
      solveWfcAsync: this.wfcWorker ? (w, h, s, o) => this.solveWfcAsync(w, h, s, o) : null,
      // Animation callbacks
      onSolveStart: () => grid.placeholder?.startSpinning(),
      onSolveEnd: () => grid.placeholder?.stopSpinning(),
      ...options,  // Allow caller to override defaults
    })

    // Apply current helper visibility state
    grid.setHelperVisible(this.helpersVisible)
  }

  /**
   * Check if a grid position is within the valid bounds (2 rings = 19 grids)
   * @param {number} gridX - Grid X coordinate
   * @param {number} gridZ - Grid Z coordinate
   * @returns {boolean} True if position is valid
   */
  isValidGridPosition(gridX, gridZ) {
    // Convert flat-top hex odd-q offset to cube coordinates
    const q = gridX
    const r = gridZ - Math.floor((gridX - (gridX & 1)) / 2)
    const s = -q - r
    // Hex distance = max of absolute cube coords
    const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(s))
    return ring <= 2
  }

  /**
   * Count how many populated neighbors a grid position has
   * @param {string} gridKey - Grid key to check
   * @returns {number} Number of populated neighbors
   */
  countPopulatedNeighbors(gridKey) {
    let count = 0
    for (let dir = 0; dir < 6; dir++) {
      const adjacentKey = getAdjacentGridKey(gridKey, dir)
      const adjacentGrid = this.grids.get(adjacentKey)
      if (adjacentGrid?.state === HexGridState.POPULATED) {
        count++
      }
    }
    return count
  }

  /**
   * Get directions (0-5) that have populated neighbors for a grid position
   * @param {string} gridKey - Grid key to check
   * @returns {number[]} Array of directions with populated neighbors
   */
  getPopulatedNeighborDirections(gridKey) {
    const directions = []
    for (let dir = 0; dir < 6; dir++) {
      const adjacentKey = getAdjacentGridKey(gridKey, dir)
      const adjacentGrid = this.grids.get(adjacentKey)
      if (adjacentGrid?.state === HexGridState.POPULATED) {
        directions.push(dir)
      }
    }
    return directions
  }

  /**
   * Count how many grids are populated
   * @returns {number} Number of populated grids
   */
  countPopulatedGrids() {
    let count = 0
    for (const grid of this.grids.values()) {
      if (grid.state === HexGridState.POPULATED) count++
    }
    return count
  }

  /**
   * Update triangle indicators on all placeholder grids
   * Call this after a grid is populated to update adjacent placeholders
   */
  updateAllPlaceholderTriangles() {
    for (const [key, grid] of this.grids) {
      if (grid.state === HexGridState.PLACEHOLDER) {
        const neighborDirs = this.getPopulatedNeighborDirections(key)
        grid.setPlaceholderNeighbors(neighborDirs)
      }
    }
  }

  /**
   * Remove placeholder grids that are outside bounds or don't have enough neighbors
   * After first expansion, placeholders need 2+ populated neighbors
   */
  pruneInvalidPlaceholders() {
    const populatedCount = this.countPopulatedGrids()
    const isFirstExpansion = populatedCount <= 1

    const toRemove = []
    for (const [key, grid] of this.grids) {
      if (grid.state === HexGridState.PLACEHOLDER) {
        const { x, z } = parseGridKey(key)

        // Outside bounds
        if (!this.isValidGridPosition(x, z)) {
          toRemove.push(key)
          continue
        }

        // After first expansion, require 2+ neighbors
        if (!isFirstExpansion) {
          const neighborCount = this.countPopulatedNeighbors(key)
          if (neighborCount < 2) {
            toRemove.push(key)
          }
        }
      }
    }

    for (const key of toRemove) {
      const grid = this.grids.get(key)
      if (grid) {
        grid.dispose()
        this.grids.delete(key)
      }
    }
  }

  /**
   * Create placeholder grids around a populated grid
   * Only creates within valid bounds (2 rings = 19 grids max)
   * After first expansion, only creates placeholders with 2+ populated neighbors
   * @param {string} centerKey - Grid key of the populated grid
   */
  createAdjacentPlaceholders(centerKey) {
    const populatedCount = this.countPopulatedGrids()
    const isFirstExpansion = populatedCount <= 1

    for (let dir = 0; dir < 6; dir++) {
      const adjacentKey = getAdjacentGridKey(centerKey, dir)
      if (this.grids.has(adjacentKey)) continue  // Already exists

      const { x: gridX, z: gridZ } = parseGridKey(adjacentKey)

      // Must be within bounds
      if (!this.isValidGridPosition(gridX, gridZ)) continue

      // After first expansion, require 2+ neighbors
      if (!isFirstExpansion) {
        const neighborCount = this.countPopulatedNeighbors(adjacentKey)
        if (neighborCount < 2) continue
      }

      this.createGrid(gridX, gridZ)  // Creates in PLACEHOLDER state
    }
  }

  /**
   * Handle click on a grid (placeholder button clicked)
   * @param {HexGrid} grid - Grid that was clicked
   */
  async onGridClick(grid) {
    if (grid.state !== HexGridState.PLACEHOLDER) return

    // Clear debug tracking from previous grid generation
    this.droppedSeeds.clear()
    this.failedCells.clear()
    this.replacedSeeds.clear()

    const gridKey = getGridKey(grid.gridCoords.x, grid.gridCoords.z)

    // Find ALL populated neighbors and collect their edge tiles as seeds
    const neighborSeeds = []
    for (let dir = 0; dir < 6; dir++) {
      const adjacentKey = getAdjacentGridKey(gridKey, dir)
      const adjacentGrid = this.grids.get(adjacentKey)
      if (adjacentGrid?.state === HexGridState.POPULATED) {
        // Get neighbor edge tiles as seeds
        // 'dir' is the direction FROM new grid TO neighbor
        // Pass cube coords for coordinate transformation (no stagger issues)
        const seeds = getNeighborSeeds(
          adjacentGrid.hexGrid,
          adjacentGrid.gridRadius,
          dir,
          adjacentGrid.globalCenterCube,  // source grid's cube center
          grid.globalCenterCube,          // new grid's cube center
          adjacentKey                     // source grid key for tile replacement
        )
        neighborSeeds.push(...seeds)
      }
    }

    console.log(`%c[${gridKey}] POPULATING GRID (${neighborSeeds.length} seeds)`, 'color: blue')
    console.log('%c--------------------------------', 'color: blue')

    // Helper to convert seed local coords to global (uses shared utility)
    const seedToGlobal = (s) => localToGlobalCoords(s.x, s.z, grid.gridRadius, grid.globalCenterCube)

    // Filter and detect adjacent seed conflicts (seeds from different grids that ended up next to each other)
    const filterResult = filterConflictingSeeds(neighborSeeds, grid.gridRadius, gridKey, grid.globalCenterCube)
    let validSeeds = filterResult.validSeeds
    const adjacentConflicts = filterResult.conflicts

    const replacedSeeds = new Set()  // Track seeds already replaced to avoid infinite loops
    let maxIterations = 50  // Safety limit

    // Helper to try replacing a seed tile
    const tryReplaceSeed = (seed) => {
      if (!seed?.sourceGridKey) {
        console.log(`%c  → No sourceGridKey for seed`, 'color: gray')
        return false
      }
      const sourceGrid = this.grids.get(seed.sourceGridKey)
      if (!sourceGrid?.hexGrid) {
        console.log(`%c  → Source grid not found: ${seed.sourceGridKey}`, 'color: gray')
        return false
      }

      const seedGlobal = seedToGlobal(seed)
      const globalKey = `${seedGlobal.col},${seedGlobal.row}`

      // Skip if already replaced
      if (replacedSeeds.has(globalKey)) return false

      // Get all replacement candidates that match source grid's interior
      const candidates = findReplacementTiles(
        seed,
        sourceGrid.hexGrid,
        sourceGrid.gridRadius,
        sourceGrid.globalCenterCube
      )

      // Try each candidate until we find one compatible with adjacent seeds
      for (const replacement of candidates) {
        const replacementEdges = rotateHexEdges(TILE_LIST[replacement.type]?.edges || {}, replacement.rotation)
        let compatibleWithSeeds = true

        for (const dir of HexDir) {
          const offset = getHexNeighborOffset(seed.x, seed.z, dir)
          const nx = seed.x + offset.dx
          const nz = seed.z + offset.dz

          // Find if there's another seed at this adjacent position
          const adjacentSeed = neighborSeeds.find(s => s.x === nx && s.z === nz && s !== seed)
          if (adjacentSeed) {
            const adjacentEdges = rotateHexEdges(TILE_LIST[adjacentSeed.type]?.edges || {}, adjacentSeed.rotation)
            const myEdge = replacementEdges[dir]
            const theirEdge = adjacentEdges[HexOpposite[dir]]
            const myLevel = getEdgeLevel(replacement.type, replacement.rotation, dir, replacement.level)
            const theirLevel = getEdgeLevel(adjacentSeed.type, adjacentSeed.rotation, HexOpposite[dir], adjacentSeed.level ?? 0)

            if (!edgesCompatible(myEdge, myLevel, theirEdge, theirLevel)) {
              compatibleWithSeeds = false
              break
            }
          }
        }

        if (compatibleWithSeeds) {
          replacedSeeds.add(globalKey)
          this.replacedSeeds.add(globalKey)  // Track for label highlighting
          sourceGrid.replaceTile(seed.sourceX, seed.sourceZ, replacement.type, replacement.rotation, replacement.level)
          seed.type = replacement.type
          seed.rotation = replacement.rotation
          seed.level = replacement.level
          const typeName = TILE_LIST[replacement.type]?.name || replacement.type
          console.log(`%cReplaced tile (${globalKey}) with ${typeName} rot=${replacement.rotation}`, 'color: blue')
          return true
        }
      }
      return false
    }

    // Phase 1: Handle adjacent seed conflicts (try replacement, add to validSeeds if fixed)
    for (const conflict of adjacentConflicts) {
      if (maxIterations-- <= 0) break

      const seed = conflict.seedObj
      const seedGlobal = `${conflict.seed.global}`

      // Try replacing the conflicting seed
      if (tryReplaceSeed(seed)) {
        // Seed was replaced, add it to valid seeds
        validSeeds.push(seed)
      } else {
        // Couldn't replace - drop it
        this.droppedSeeds.add(seedGlobal)
        console.log(`%cDropping seed (${seedGlobal}) ${conflict.seed.type} - adjacent conflict`, 'color: orange')
      }
    }

    // Phase 2: Handle multi-seed cell conflicts (validateSeedConflicts)
    let validation = validateSeedConflicts(validSeeds, this.hexWfcRules, grid.gridRadius, gridKey, grid.globalCenterCube)
    while (!validation.valid && validSeeds.length > 1 && maxIterations-- > 0) {
      const conflict = validation.conflicts[0]
      let replaced = false

      // Try to replace each conflicting seed in order (skip already-replaced seeds)
      for (let seedIdx = 0; seedIdx < conflict.seeds.length && !replaced; seedIdx++) {
        const conflictSeedInfo = conflict.seeds[seedIdx]

        // Find the actual seed object
        const actualSeed = validSeeds.find(s => {
          const g = seedToGlobal(s)
          return `${g.col},${g.row}` === conflictSeedInfo.global
        })

        if (actualSeed && tryReplaceSeed(actualSeed)) {
          replaced = true
        }
      }

      // Fall back to removal if no replacement found
      if (!replaced) {
        const conflictSeedInfo = conflict.seeds[0]
        const actualSeed = validSeeds.find(s => {
          const g = seedToGlobal(s)
          return `${g.col},${g.row}` === conflictSeedInfo.global
        })
        validSeeds = validSeeds.filter(s => s !== actualSeed)
        this.droppedSeeds.add(conflictSeedInfo.global)
        console.log(`%cDropping seed (${conflictSeedInfo.global}) ${conflictSeedInfo.type} - ${validSeeds.length} seeds remain`, 'color: orange')
      }

      validation = validateSeedConflicts(validSeeds, this.hexWfcRules, grid.gridRadius, gridKey, grid.globalCenterCube)
    }

    if (maxIterations <= 0) {
      console.warn('Seed conflict resolution hit max iterations limit')
    }

    // DEBUG: Final check for any remaining adjacent conflicts before WFC
    console.log(`%c=== PRE-WFC SEED CHECK (${validSeeds.length} seeds) ===`, 'color: dodgerblue; font-weight: bold')
    const seedMapDebug = new Map()
    for (const seed of validSeeds) {
      seedMapDebug.set(`${seed.x},${seed.z}`, seed)
    }
    for (const seed of validSeeds) {
      for (const dir of HexDir) {
        const offset = getHexNeighborOffset(seed.x, seed.z, dir)
        const neighborKey = `${seed.x + offset.dx},${seed.z + offset.dz}`
        const neighborSeed = seedMapDebug.get(neighborKey)
        if (neighborSeed && neighborSeed !== seed) {
          const seedEdges = rotateHexEdges(TILE_LIST[seed.type]?.edges || {}, seed.rotation)
          const neighborEdges = rotateHexEdges(TILE_LIST[neighborSeed.type]?.edges || {}, neighborSeed.rotation)
          const seedEdge = seedEdges[dir]
          const neighborEdge = neighborEdges[HexOpposite[dir]]
          const seedLevel = getEdgeLevel(seed.type, seed.rotation, dir, seed.level ?? 0)
          const neighborLevel = getEdgeLevel(neighborSeed.type, neighborSeed.rotation, HexOpposite[dir], neighborSeed.level ?? 0)
          if (!edgesCompatible(seedEdge, seedLevel, neighborEdge, neighborLevel)) {
            const sGlobal = seedToGlobal(seed)
            const nGlobal = seedToGlobal(neighborSeed)
            const sType = TILE_LIST[seed.type]?.name
            const nType = TILE_LIST[neighborSeed.type]?.name
            console.log(`%c  CONFLICT: (${sGlobal.col},${sGlobal.row}) ${sType} ${dir}→${seedEdge}@${seedLevel} vs (${nGlobal.col},${nGlobal.row}) ${nType} ${HexOpposite[dir]}→${neighborEdge}@${neighborLevel}`, 'color: red')
          }
        }
      }
    }
    console.log(`%c=== END PRE-WFC CHECK ===`, 'color: blue')

    // Populate this grid with neighbor seeds
    const params = Demo.instance?.params
    await this.populateGrid(grid, validSeeds, {
      replacedCount: replacedSeeds.size,
      animate: params?.roads?.animateWFC ?? false,
      animateDelay: params?.roads?.animateDelay ?? 20,
    })

    // Create placeholders around this newly populated grid
    this.createAdjacentPlaceholders(gridKey)

    // Remove placeholders outside bounds
    this.pruneInvalidPlaceholders()

    // Update triangle indicators on all remaining placeholders
    this.updateAllPlaceholderTriangles()

    // Refresh tile labels if visible
    if (this.tileLabels.visible) {
      this.createTileLabels()
    }
  }

  /**
   * Calculate world offset for grid coordinates
   * Traverses from origin using getGridWorldOffset for consistency
   */
  calculateWorldOffset(gridX, gridZ) {
    if (gridX === 0 && gridZ === 0) {
      return { x: 0, z: 0 }
    }

    const hexWidth = HexTileGeometry.HEX_WIDTH || 2
    const hexHeight = HexTileGeometry.HEX_HEIGHT || (2 / Math.sqrt(3) * 2)

    // Traverse from (0,0) to (gridX, gridZ) using flat-top hex directions
    let totalX = 0
    let totalZ = 0
    let currentX = 0
    let currentZ = 0

    while (currentX !== gridX || currentZ !== gridZ) {
      const dx = gridX - currentX
      const dz = gridZ - currentZ
      const isOddCol = Math.abs(currentX) % 2 === 1

      let direction = null
      let nextX = currentX
      let nextZ = currentZ

      // For flat-top hex, pick direction based on where we need to go
      // N/S for vertical, NE/SE/SW/NW for diagonal
      if (dx === 0) {
        // Pure vertical movement
        if (dz < 0) {
          direction = GridDirection.N
          nextZ -= 1
        } else {
          direction = GridDirection.S
          nextZ += 1
        }
      } else if (dx > 0) {
        // Need to go right (positive x)
        if (dz < 0 || (dz === 0 && !isOddCol)) {
          direction = GridDirection.NE
          nextX += 1
          nextZ += isOddCol ? 0 : -1
        } else {
          direction = GridDirection.SE
          nextX += 1
          nextZ += isOddCol ? 1 : 0
        }
      } else {
        // Need to go left (negative x)
        if (dz < 0 || (dz === 0 && !isOddCol)) {
          direction = GridDirection.NW
          nextX -= 1
          nextZ += isOddCol ? 0 : -1
        } else {
          direction = GridDirection.SW
          nextX -= 1
          nextZ += isOddCol ? 1 : 0
        }
      }

      if (direction !== null) {
        const offset = getGridWorldOffset(this.hexGridRadius, direction, hexWidth, hexHeight)
        totalX += offset.x
        totalZ += offset.z
        currentX = nextX
        currentZ = nextZ
      }

      // Safety check
      if (Math.abs(currentX) > 100 || Math.abs(currentZ) > 100) {
        console.warn('calculateWorldOffset: loop limit reached')
        break
      }
    }

    return { x: totalX, z: totalZ }
  }

  /**
   * Handle pointer move for placeholder hover
   * @param {Vector2} pointer - Normalized device coordinates
   * @param {Camera} camera - Scene camera
   */
  onPointerMove(pointer, camera) {
    // Collect all placeholder clickables (buttons + triangles) from grids in PLACEHOLDER state
    const placeholderClickables = []
    for (const grid of this.grids.values()) {
      if (grid.state === HexGridState.PLACEHOLDER) {
        placeholderClickables.push(...grid.getPlaceholderClickables())
      }
    }

    if (placeholderClickables.length === 0) return

    // Raycast against placeholder clickables
    this.raycaster.setFromCamera(pointer, camera)
    const intersects = this.raycaster.intersectObjects(placeholderClickables)

    // Clear previous hover
    if (this.hoveredGrid) {
      this.hoveredGrid.setHover(false)
      this.hoveredGrid = null
    }

    // Set new hover
    if (intersects.length > 0) {
      const clickable = intersects[0].object
      if (clickable.userData.isPlaceholder) {
        // Find the grid that owns this clickable
        const ownerGrid = clickable.userData.owner?.group?.userData?.hexGrid
        if (ownerGrid) {
          this.hoveredGrid = ownerGrid
          ownerGrid.setHover(true)
        }
      }
    }
  }

  /**
   * Handle pointer down for placeholder click
   * @param {Vector2} pointer - Normalized device coordinates
   * @param {Camera} camera - Scene camera
   * @returns {boolean} True if a placeholder was clicked
   */
  onPointerDown(pointer, camera) {
    // Collect all placeholder clickables (buttons + triangles) from grids in PLACEHOLDER state
    const placeholderClickables = []
    for (const grid of this.grids.values()) {
      if (grid.state === HexGridState.PLACEHOLDER) {
        placeholderClickables.push(...grid.getPlaceholderClickables())
      }
    }

    if (placeholderClickables.length === 0) return false

    this.raycaster.setFromCamera(pointer, camera)
    const intersects = this.raycaster.intersectObjects(placeholderClickables)

    if (intersects.length > 0) {
      const clickable = intersects[0].object
      if (clickable.userData.isPlaceholder) {
        // Find the grid that owns this clickable
        const ownerGrid = clickable.userData.owner?.group?.userData?.hexGrid
        if (ownerGrid && ownerGrid.onClick) {
          ownerGrid.onClick()
          return true
        }
      }
    }

    return false
  }

  async regenerate(options = {}) {
    await this.regenerateAll(options)
  }

  async regenerateAll(options = {}) {
    // Set flag to prevent overlay rendering during disposal
    this.isRegenerating = true

    // Clear debug tracking
    this.droppedSeeds.clear()
    this.failedCells.clear()
    this.replacedSeeds.clear()

    // Clear labels first (they reference grid data)
    this.clearTileLabels()

    // Collect grids to dispose, then clear map FIRST
    // (so getOverlayObjects() won't return disposed objects)
    const gridsToDispose = [...this.grids.values()]
    this.grids.clear()

    // Remove all grid groups from scene BEFORE waiting
    // (so they won't be rendered during the wait)
    for (const grid of gridsToDispose) {
      this.scene.remove(grid.group)
    }

    // Defer disposal to ensure GPU queue has finished with textures
    setTimeout(() => {
      for (const grid of gridsToDispose) {
        grid.dispose()
      }
    }, 500)

    // Clear WFC rules to pick up any changes
    this.initWfcRules()

    // Create center grid and populate it
    const centerGrid = await this.createGrid(0, 0)
    await this.populateGrid(centerGrid, [], options)

    // Create placeholders around center
    this.createAdjacentPlaceholders('0,0')

    // Refresh labels if visible
    if (this.tileLabels.visible) {
      this.createTileLabels()
    }

    // Clear regeneration flag
    this.isRegenerating = false
  }

  update(_dt) {
    // Future: animate tiles
  }

  // === Accessors for backward compatibility ===

  /**
   * Get all hex tiles across all grids
   */
  get hexTiles() {
    const allTiles = []
    for (const grid of this.grids.values()) {
      allTiles.push(...grid.hexTiles)
    }
    return allTiles
  }

  /**
   * Get hex grid (returns center grid for compatibility)
   */
  get hexGrid() {
    return this.grids.get('0,0')?.hexGrid ?? null
  }

  /**
   * Get WFC grid radius
   */
  get wfcGridRadius() {
    return this.hexGridRadius
  }

  // === Debug tile labels ===

  clearTileLabels() {
    while (this.tileLabels.children.length > 0) {
      const label = this.tileLabels.children[0]
      this.tileLabels.remove(label)
      if (label.element) label.element.remove()
    }
  }

  createTileLabels() {
    this.clearTileLabels()
    const LEVEL_HEIGHT = 0.5
    const TILE_SURFACE = 1
    for (const [key, grid] of this.grids) {
      const gridRadius = grid.gridRadius
      const { x: offsetX, z: offsetZ } = grid.worldOffset
      const globalCenterCube = grid.globalCenterCube ?? { q: 0, r: 0, s: 0 }

      // For populated grids, show labels on tiles
      // For placeholder grids, show labels for all cell positions
      if (grid.state === HexGridState.POPULATED) {
        for (const tile of grid.hexTiles) {
          const pos = HexTileGeometry.getWorldPosition(
            tile.gridX - gridRadius,
            tile.gridZ - gridRadius
          )

          const def = TILE_LIST[tile.type]
          const isSlope = def?.highEdges?.length > 0
          const baseLevel = tile.level ?? 0

          const localOffsetCol = tile.gridX - gridRadius
          const localOffsetRow = tile.gridZ - gridRadius
          const localCube = offsetToCube(localOffsetCol, localOffsetRow)
          const globalCube = {
            q: localCube.q + globalCenterCube.q,
            r: localCube.r + globalCenterCube.r,
            s: localCube.s + globalCenterCube.s
          }
          const globalOffset = cubeToOffset(globalCube.q, globalCube.r, globalCube.s)

          const div = document.createElement('div')
          div.className = 'tile-label'
          div.textContent = `${globalOffset.col},${globalOffset.row}`
          const globalKey = `${globalOffset.col},${globalOffset.row}`
          const isDropped = this.droppedSeeds.has(globalKey)
          const isFailed = this.failedCells.has(globalKey)
          const isReplaced = this.replacedSeeds.has(globalKey)
          // Purple = failed cell, Red = dropped seed, Orange = replaced seed, Gray = normal
          const bgColor = isFailed ? 'rgba(150,50,200,0.9)' : isDropped ? 'rgba(200,0,0,0.8)' : isReplaced ? 'rgba(255,140,0,0.9)' : 'rgba(0,0,0,0.5)'
          div.style.cssText = `
            color: white;
            font-family: monospace;
            font-size: 9px;
            background: ${bgColor};
            padding: 2px 4px;
            border-radius: 2px;
            white-space: pre;
            text-align: center;
            line-height: 1.2;
          `

          const label = new CSS2DObject(div)
          const slopeOffset = isSlope ? 0.5 : 0
          label.position.set(
            pos.x + offsetX,
            baseLevel * LEVEL_HEIGHT + TILE_SURFACE + slopeOffset,
            pos.z + offsetZ
          )
          this.tileLabels.add(label)
        }
      } else {
        // Placeholder grid - show labels for all cell positions
        const size = gridRadius * 2 + 1
        for (let col = 0; col < size; col++) {
          for (let row = 0; row < size; row++) {
            const offsetCol = col - gridRadius
            const offsetRow = row - gridRadius
            if (!isInHexRadius(offsetCol, offsetRow, gridRadius)) continue

            const pos = HexTileGeometry.getWorldPosition(offsetCol, offsetRow)
            const localCube = offsetToCube(offsetCol, offsetRow)
            const globalCube = {
              q: localCube.q + globalCenterCube.q,
              r: localCube.r + globalCenterCube.r,
              s: localCube.s + globalCenterCube.s
            }
            const globalOffset = cubeToOffset(globalCube.q, globalCube.r, globalCube.s)

            const div = document.createElement('div')
            div.className = 'tile-label'
            div.textContent = `${globalOffset.col},${globalOffset.row}`
            const globalKey = `${globalOffset.col},${globalOffset.row}`
            const isDropped = this.droppedSeeds.has(globalKey)
            const isFailed = this.failedCells.has(globalKey)
            const isReplaced = this.replacedSeeds.has(globalKey)
            const isHighlighted = isFailed || isDropped || isReplaced
            // Purple = failed cell, Red = dropped seed, Orange = replaced seed, Gray = normal
            const bgColor = isFailed ? 'rgba(150,50,200,0.9)' : isDropped ? 'rgba(200,0,0,0.8)' : isReplaced ? 'rgba(255,140,0,0.9)' : 'rgba(0,0,0,0.3)'
            div.style.cssText = `
              color: ${isHighlighted ? 'white' : 'rgba(255,255,255,0.6)'};
              font-family: monospace;
              font-size: 9px;
              background: ${bgColor};
              padding: 2px 4px;
              border-radius: 2px;
              white-space: pre;
              text-align: center;
              line-height: 1.2;
            `

            const label = new CSS2DObject(div)
            label.position.set(
              pos.x + offsetX,
              TILE_SURFACE,
              pos.z + offsetZ
            )
            this.tileLabels.add(label)
          }
        }
      }
    }
  }

  setTileLabelsVisible(visible) {
    if (visible) {
      this.createTileLabels()
    } else {
      this.clearTileLabels()
    }
    this.tileLabels.visible = visible

    // Also update grid labels on all grids
    for (const grid of this.grids.values()) {
      grid.setGridLabelVisible(visible)
    }
  }

  /**
   * Set visibility of all hex helpers (grid lines and dots)
   * Applies to both POPULATED and PLACEHOLDER grids
   * @param {boolean} visible
   */
  setHelpersVisible(visible) {
    this.helpersVisible = visible
    for (const grid of this.grids.values()) {
      grid.setHelperVisible(visible)
    }
  }

  /**
   * Set visibility of all axes helpers on grids
   * @param {boolean} visible
   */
  setAxesHelpersVisible(visible) {
    this.axesHelpersVisible = visible
    for (const grid of this.grids.values()) {
      if (grid.axesHelper) {
        grid.axesHelper.visible = visible
      }
    }
  }

  /**
   * Toggle visibility of grid outlines
   */
  setOutlinesVisible(visible) {
    for (const grid of this.grids.values()) {
      if (grid.outline) {
        grid.outline.visible = visible
      }
    }
  }

  /**
   * Repopulate decorations (trees, buildings, bridges) on all populated grids
   */
  repopulateDecorations() {
    for (const grid of this.grids.values()) {
      if (grid.state === HexGridState.POPULATED) {
        grid.populateDecorations()
      }
    }
  }

  /**
   * Update tile colors on all populated grids (for debug level visualization)
   */
  updateTileColors() {
    for (const grid of this.grids.values()) {
      if (grid.state === HexGridState.POPULATED) {
        grid.updateTileColors()
      }
    }
  }

  /**
   * Get all overlay objects that should bypass AO (placeholders, helpers)
   * @returns {Object3D[]} Array of overlay groups
   */
  getOverlayObjects() {
    // Return empty during regeneration to prevent rendering disposed objects
    if (this.isRegenerating) return []

    const overlays = []
    for (const grid of this.grids.values()) {
      // Placeholder group (button + triangles)
      if (grid.placeholder?.group) {
        overlays.push(grid.placeholder.group)
      }
      // Grid helper group (debug lines + dots)
      if (grid.gridHelper?.group) {
        overlays.push(grid.gridHelper.group)
      }
      // Outline (always visible, should also bypass AO)
      if (grid.outline) {
        overlays.push(grid.outline)
      }
      // Axes helper
      if (grid.axesHelper) {
        overlays.push(grid.axesHelper)
      }
    }
    return overlays
  }

  // Stub methods for Demo.js compatibility
  onHover() {}
  onPointerUp() {}
  onRightClick() {}
  startIntroAnimation() {}
}
