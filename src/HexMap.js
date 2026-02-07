import {
  Object3D,
  MeshPhysicalNodeMaterial,
  PlaneGeometry,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector2,
} from 'three/webgpu'
import { uniform } from 'three/tsl'
import { CSS2DObject } from 'three/examples/jsm/Addons.js'
import { HexWFCAdjacencyRules } from './HexWFC.js'
import { HexTileGeometry, HexTileType, HexTileDefinitions, isInHexRadius } from './HexTiles.js'
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
  findReplacementTile,
  worldOffsetToGlobalCube,
  offsetToCube,
  cubeToOffset,
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

    // Interaction
    this.raycaster = new Raycaster()
    this.hoveredGrid = null  // HexGrid being hovered

    // Helper visibility state
    this.helpersVisible = false
    this.axesHelpersVisible = false

    // Regeneration state (prevents overlay rendering during disposal)
    this.isRegenerating = false
  }

  async init() {
    await HexTileGeometry.init('./assets/models/hex-terrain.glb')
    this.createFloor()
    await this.initMaterial()
    this.initWfcRules()
    initGlobalTreeNoise()  // Initialize shared noise for tree placement

    // Create center grid at (0,0) and immediately populate it
    const centerGrid = await this.createGrid(0, 0)
    await this.populateGrid(centerGrid)

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
  }

  /**
   * Initialize shared WFC rules
   */
  initWfcRules() {
    const tileTypes = this.getDefaultTileTypes()
    const levelsCount = 3
    this.hexWfcRules = HexWFCAdjacencyRules.fromTileDefinitions(tileTypes, levelsCount)
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
      HexTileType.ROAD_M,
      // Rivers
      HexTileType.RIVER_A,
      HexTileType.RIVER_A_CURVY,
      HexTileType.RIVER_B,
      HexTileType.RIVER_D,
      HexTileType.RIVER_E,
      HexTileType.RIVER_F,
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
   * @param {Object} options - Optional WFC options (animate, animateDelay, levelsCount, etc.)
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

    // Filter out conflicting seeds (from different sources that ended up adjacent)
    let validSeeds = filterConflictingSeeds(neighborSeeds, grid.gridRadius, gridKey, grid.globalCenterCube)

    // Helper to convert seed local coords to global
    const seedToGlobal = (s) => {
      const localCube = offsetToCube(s.x - grid.gridRadius, s.z - grid.gridRadius)
      const globalCube = {
        q: localCube.q + grid.globalCenterCube.q,
        r: localCube.r + grid.globalCenterCube.r,
        s: localCube.s + grid.globalCenterCube.s
      }
      return cubeToOffset(globalCube.q, globalCube.r, globalCube.s)
    }

    // Pre-validate: try replacement before removal for seed conflicts
    let validation = validateSeedConflicts(validSeeds, this.hexWfcRules, grid.gridRadius, gridKey, grid.globalCenterCube)
    while (!validation.valid && validSeeds.length > 1) {
      const conflict = validation.conflicts[0]
      let replaced = false

      // Try to replace each conflicting seed in order
      for (let seedIdx = 0; seedIdx < conflict.seeds.length && !replaced; seedIdx++) {
        const conflictSeedInfo = conflict.seeds[seedIdx]
        const reqStr = conflict.requirements[seedIdx]

        // Find the actual seed object
        const actualSeed = validSeeds.find(s => {
          const g = seedToGlobal(s)
          return `${g.col},${g.row}` === conflictSeedInfo.global
        })

        if (!actualSeed?.sourceGridKey) continue

        const sourceGrid = this.grids.get(actualSeed.sourceGridKey)
        if (!sourceGrid?.hexGrid) continue

        // Parse the conflict direction from requirement (e.g., "SW=road@0")
        if (!reqStr) continue
        const [conflictDir] = reqStr.split('=')

        // Try to find replacement with different edge types
        let replacement = null
        for (const tryEdgeType of ['grass', 'road', 'river', 'coast']) {
          replacement = findReplacementTile(
            actualSeed,
            sourceGrid.hexGrid,
            sourceGrid.gridRadius,
            tryEdgeType,
            actualSeed.level ?? 0,
            conflictDir,
            this.hexWfcRules
          )
          if (replacement) break
        }

        if (replacement) {
          // Replace tile in source grid
          sourceGrid.replaceTile(actualSeed.sourceX, actualSeed.sourceZ, replacement.type, replacement.rotation, replacement.level)

          // Update seed to match
          actualSeed.type = replacement.type
          actualSeed.rotation = replacement.rotation
          actualSeed.level = replacement.level

          const typeName = Object.entries(HexTileType).find(([,v]) => v === replacement.type)?.[0] || replacement.type
          console.log(`%cReplaced tile (${conflictSeedInfo.global}) with ${typeName} rot=${replacement.rotation}`, 'color: red')
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
        console.log(`%cDropping seed (${conflictSeedInfo.global}) ${conflictSeedInfo.type} - ${validSeeds.length} seeds remain`, 'color: orange')
      }

      validation = validateSeedConflicts(validSeeds, this.hexWfcRules, grid.gridRadius, gridKey, grid.globalCenterCube)
    }

    // Populate this grid with neighbor seeds
    await this.populateGrid(grid, validSeeds)

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

    // Create reverse map: type number -> name
    const typeNames = {}
    for (const [name, value] of Object.entries(HexTileType)) {
      typeNames[value] = name
    }

    for (const [key, grid] of this.grids) {
      const gridRadius = grid.gridRadius
      const { x: offsetX, z: offsetZ } = grid.worldOffset

      for (const tile of grid.hexTiles) {
        const pos = HexTileGeometry.getWorldPosition(
          tile.gridX - gridRadius,
          tile.gridZ - gridRadius
        )

        // Check if tile is a slope
        const def = HexTileDefinitions[tile.type]
        const isSlope = def?.highEdges?.length > 0

        // Calculate global offset coordinates using cube coords (no stagger issues)
        const localOffsetCol = tile.gridX - gridRadius
        const localOffsetRow = tile.gridZ - gridRadius
        const localCube = offsetToCube(localOffsetCol, localOffsetRow)
        const globalCenterCube = grid.globalCenterCube ?? { q: 0, r: 0, s: 0 }
        const globalCube = {
          q: localCube.q + globalCenterCube.q,
          r: localCube.r + globalCenterCube.r,
          s: localCube.s + globalCenterCube.s
        }
        const globalOffset = cubeToOffset(globalCube.q, globalCube.r, globalCube.s)

        // Create label element
        const div = document.createElement('div')
        div.className = 'tile-label'
        // Show cell offset coords (col,row) to match conflict log output
        div.textContent = `${globalOffset.col},${globalOffset.row}`
        const bgColor = isSlope ? 'rgba(200,0,0,0.5)' : 'rgba(0,0,0,0.3)'
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
        const slopeOffset = isSlope ? 1 : 0
        label.position.set(
          pos.x + offsetX,
          (tile.level ?? 0) * LEVEL_HEIGHT + TILE_SURFACE + slopeOffset,
          pos.z + offsetZ
        )
        this.tileLabels.add(label)
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
   * Only applies to POPULATED grids
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
