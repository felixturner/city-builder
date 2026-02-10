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
import { HexWFCAdjacencyRules, HexWFCCell, CUBE_DIRS, cubeKey, parseCubeKey, cubeCoordsInRadius, cubeDistance, offsetToCube, cubeToOffset, localToGlobalCoords, edgesCompatible, getEdgeLevel } from './HexWFCCore.js'
import { setStatus } from './Demo.js'
import { TILE_LIST, TileType, HexDir, HexOpposite, rotateHexEdges, LEVELS_COUNT } from './HexTileData.js'
import { HexTile, HexTileGeometry, isInHexRadius } from './HexTiles.js'
import { HexGrid, HexGridState } from './HexGrid.js'
import {
  GridDirection,
  getGridKey,
  parseGridKey,
  getAdjacentGridKey,
  getGridWorldOffset,
  worldOffsetToGlobalCube,
} from './HexGridConnector.js'
import { Demo } from './Demo.js'
import { initGlobalTreeNoise } from './Decorations.js'
import { random, getSeed } from './SeededRandom.js'

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

    // Global cell map — all collapsed cells across all grids
    // key: "q,r,s" cube coords, value: { q, r, s, type, rotation, level, gridKey }
    this.globalCells = new Map()

    // Debug tile labels
    this.tileLabels = new Object3D()
    this.tileLabels.visible = false
    this.tileLabelMode = 'coords'
    this.failedCells = new Set()   // Track global coords of cells that caused WFC failures
    this.replacedCells = new Set() // Track global coords of replaced fixed cells (orange labels)
    this.droppedCells = new Set()  // Track global coords of dropped fixed cells (red labels)

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
      // Worker logs handled by populateGrid status updates
    } else if (type === 'result') {
      // Resolve pending promise by ID
      const resolve = this.wfcPendingResolvers.get(id)
      if (resolve) {
        const { seedingContradiction, lastContradiction } = e.data
        resolve({ success, tiles, collapseOrder, seedingContradiction, lastContradiction })
        this.wfcPendingResolvers.delete(id)
      }
    }
  }

  /**
   * Solve WFC using Web Worker (async, cube-coordinate based)
   * @param {Array} solveCells - [{q,r,s}] cells to solve
   * @param {Array} fixedCells - [{q,r,s,type,rotation,level}] collapsed neighbor constraints
   * @param {Object} options - WFC options (seed, tileTypes, weights, initialCollapses, etc.)
   * @returns {Promise<{success, tiles, collapseOrder}>}
   */
  solveWfcAsync(solveCells, fixedCells, options) {
    return new Promise((resolve) => {
      if (!this.wfcWorker) {
        resolve({ success: false, tiles: null, collapseOrder: [] })
        return
      }

      const id = `wfc_${++this.wfcRequestId}`

      // Set up timeout (10 seconds)
      const timeout = setTimeout(() => {
        console.warn('WFC worker timeout')
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
        solveCells,
        fixedCells,
        options
      })
    })
  }

  /**
   * Add solved tiles to the global cell map
   * @param {string} gridKey - Grid key for tracking
   * @param {Array} tiles - [{q,r,s,type,rotation,level}] solved tiles
   */
  addToGlobalCells(gridKey, tiles) {
    for (const tile of tiles) {
      const key = cubeKey(tile.q, tile.r, tile.s)
      this.globalCells.set(key, {
        q: tile.q, r: tile.r, s: tile.s,
        type: tile.type, rotation: tile.rotation, level: tile.level,
        gridKey
      })
    }
  }

  /**
   * Get fixed cells (collapsed neighbors) for a set of solve cells
   * Checks 6 cube neighbors of each solve cell in globalCells
   * @param {Array} solveCells - [{q,r,s}] cells to solve
   * @returns {Array} [{q,r,s,type,rotation,level}] unique fixed cells
   */
  getFixedCellsForRegion(solveCells) {
    const solveSet = new Set(solveCells.map(c => cubeKey(c.q, c.r, c.s)))
    const fixedMap = new Map()

    for (const { q, r, s } of solveCells) {
      for (const dir of CUBE_DIRS) {
        const nq = q + dir.dq
        const nr = r + dir.dr
        const ns = s + dir.ds
        const nKey = cubeKey(nq, nr, ns)

        // Skip if this neighbor is also a solve cell
        if (solveSet.has(nKey)) continue
        // Skip if already added
        if (fixedMap.has(nKey)) continue

        const existing = this.globalCells.get(nKey)
        if (existing) {
          fixedMap.set(nKey, {
            q: nq, r: nr, s: ns,
            type: existing.type, rotation: existing.rotation, level: existing.level
          })
        }
      }
    }

    return [...fixedMap.values()]
  }

  /**
   * Find replacement tiles for a fixed cell that preserve compatibility with its neighbors in globalCells
   * Adapted from old findReplacementTiles() — uses globalCells instead of source grid hexGrid array
   * @param {number} q - Cell cube q
   * @param {number} r - Cell cube r
   * @param {number} s - Cell cube s
   * @param {number} currentType - Current tile type
   * @param {number} currentRotation - Current rotation
   * @param {number} currentLevel - Current level
   * @returns {Array} Shuffled replacement candidates [{ type, rotation, level }]
   */
  findReplacementTilesForCell(q, r, s, currentType, currentRotation, currentLevel) {
    // Find which edges connect to actual neighbors in globalCells
    // These edges are "locked" — replacement must match them
    const lockedEdges = {} // dir -> { type, level }
    for (let i = 0; i < 6; i++) {
      const dir = CUBE_DIRS[i]
      const nq = q + dir.dq
      const nr = r + dir.dr
      const ns = s + dir.ds
      const nKey = cubeKey(nq, nr, ns)
      const neighbor = this.globalCells.get(nKey)

      if (neighbor) {
        // Read the NEIGHBOR's edge facing back toward us
        const neighborDef = TILE_LIST[neighbor.type]
        if (!neighborDef) continue
        const neighborEdges = rotateHexEdges(neighborDef.edges, neighbor.rotation)
        const oppositeDir = HexOpposite[HexDir[i]]
        const neighborEdgeType = neighborEdges[oppositeDir]
        const neighborEdgeLevel = getEdgeLevel(neighbor.type, neighbor.rotation, oppositeDir, neighbor.level ?? 0)

        // Lock this edge to match what neighbor requires
        if (neighborEdgeType === 'grass') {
          lockedEdges[HexDir[i]] = { type: neighborEdgeType, level: null }  // null = any level OK
        } else {
          lockedEdges[HexDir[i]] = { type: neighborEdgeType, level: neighborEdgeLevel }
        }
      }
    }

    // Search active tile types and rotations for replacements
    const candidates = []

    for (let tileType = 0; tileType < TILE_LIST.length; tileType++) {
      const def = TILE_LIST[tileType]

      // Skip same tile type entirely to avoid oscillation
      if (tileType === currentType) continue

      // Skip if currentLevel is invalid for this tile type
      const isSlope = def.highEdges?.length > 0
      if (isSlope) {
        const increment = def.levelIncrement ?? 1
        const maxBaseLevel = LEVELS_COUNT - 1 - increment
        if (currentLevel > maxBaseLevel) continue
      }

      for (let rot = 0; rot < 6; rot++) {
        const edges = rotateHexEdges(def.edges, rot)

        // Check if this tile matches all locked edges
        let matchesLocked = true
        for (const [dir, required] of Object.entries(lockedEdges)) {
          const edgeType = edges[dir]
          const edgeLevel = getEdgeLevel(tileType, rot, dir, currentLevel)
          // Type must match; level must match unless it's grass (null = any level OK)
          if (edgeType !== required.type) {
            matchesLocked = false
            break
          }
          if (required.level !== null && edgeType !== 'grass' && edgeLevel !== required.level) {
            matchesLocked = false
            break
          }
        }

        if (matchesLocked) {
          candidates.push({ type: tileType, rotation: rot, level: currentLevel })
        }
      }
    }

    // Shuffle candidates to avoid bias toward early-defined tile types
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }

    return candidates
  }

  /**
   * Filter fixed cells that conflict with each other (incompatible adjacent edges)
   * Happens when fixed cells from different source grids end up adjacent
   * @param {Array} fixedCells - [{q,r,s,type,rotation,level}]
   * @returns {Object} { validCells, conflicts }
   */
  filterConflictingFixedCells(fixedCells) {
    if (fixedCells.length <= 1) return { validCells: fixedCells, conflicts: [] }

    const cellMap = new Map()
    const validCells = []
    const conflicts = []

    for (const cell of fixedCells) {
      const key = cubeKey(cell.q, cell.r, cell.s)

      // Check adjacency with already-validated cells
      let hasConflict = false
      let conflictInfo = null
      for (let i = 0; i < 6; i++) {
        const dir = CUBE_DIRS[i]
        const nq = cell.q + dir.dq
        const nr = cell.r + dir.dr
        const ns = cell.s + dir.ds
        const nKey = cubeKey(nq, nr, ns)
        const neighborCell = cellMap.get(nKey)

        if (neighborCell) {
          const cellEdges = rotateHexEdges(TILE_LIST[cell.type]?.edges || {}, cell.rotation)
          const neighborEdges = rotateHexEdges(TILE_LIST[neighborCell.type]?.edges || {}, neighborCell.rotation)

          const cellEdge = cellEdges[HexDir[i]]
          const neighborEdge = neighborEdges[HexOpposite[HexDir[i]]]

          const cellEdgeLevel = getEdgeLevel(cell.type, cell.rotation, HexDir[i], cell.level ?? 0)
          const neighborEdgeLevel = getEdgeLevel(neighborCell.type, neighborCell.rotation, HexOpposite[HexDir[i]], neighborCell.level ?? 0)

          if (!edgesCompatible(cellEdge, cellEdgeLevel, neighborEdge, neighborEdgeLevel)) {
            hasConflict = true
            const reason = cellEdge !== neighborEdge ? 'edge type' : 'edge level'
            conflictInfo = {
              cell,
              neighbor: neighborCell,
              dir: HexDir[i],
              cellEdge: `${cellEdge}@${cellEdgeLevel}`,
              neighborEdge: `${neighborEdge}@${neighborEdgeLevel}`,
              reason,
            }
            break
          }
        }
      }

      if (!hasConflict) {
        validCells.push(cell)
        cellMap.set(key, cell)
      } else if (conflictInfo) {
        conflictInfo.cellObj = cell
        conflicts.push(conflictInfo)
      }
    }

    return { validCells, conflicts }
  }

  /**
   * Validate that fixed cells don't create unsolvable constraints for solve cells between them
   * A conflict occurs when a solve cell is adjacent to 2+ fixed cells whose edge requirements
   * can't be satisfied by any single tile.
   * @param {Array} solveCells - [{q,r,s}] cells to solve
   * @param {Array} fixedCells - [{q,r,s,type,rotation,level}] fixed constraints
   * @returns {Object} { valid, conflicts }
   */
  validateFixedCellConflicts(solveCells, fixedCells) {
    if (fixedCells.length <= 1) return { valid: true, conflicts: [] }

    const fixedMap = new Map()
    for (const fc of fixedCells) {
      fixedMap.set(cubeKey(fc.q, fc.r, fc.s), fc)
    }

    const solveSet = new Set(solveCells.map(c => cubeKey(c.q, c.r, c.s)))

    // Find all solve cells adjacent to 2+ fixed cells
    const cellNeighbors = new Map() // cubeKey -> [{ fixedCell, dir }]
    for (const fc of fixedCells) {
      for (let i = 0; i < 6; i++) {
        const dir = CUBE_DIRS[i]
        const nq = fc.q + dir.dq
        const nr = fc.r + dir.dr
        const ns = fc.s + dir.ds
        const nKey = cubeKey(nq, nr, ns)

        // Only check solve cells (not other fixed cells)
        if (!solveSet.has(nKey)) continue
        if (fixedMap.has(nKey)) continue

        if (!cellNeighbors.has(nKey)) {
          cellNeighbors.set(nKey, [])
        }
        // dir from solve cell back toward the fixed cell
        cellNeighbors.get(nKey).push({ fixedCell: fc, dir: HexOpposite[HexDir[i]] })
      }
    }

    const conflicts = []

    for (const [cellKey, neighbors] of cellNeighbors) {
      if (neighbors.length < 2) continue

      // Build edge requirements from all adjacent fixed cells
      const requirements = neighbors.map(({ fixedCell, dir }) => {
        const fcEdges = rotateHexEdges(TILE_LIST[fixedCell.type]?.edges || {}, fixedCell.rotation)
        const edgeType = fcEdges[HexOpposite[dir]] // Edge the fixed cell is presenting
        const edgeLevel = getEdgeLevel(fixedCell.type, fixedCell.rotation, HexOpposite[dir], fixedCell.level ?? 0)
        return { edgeType, edgeLevel, dir, fixedCell }
      })

      // Find tiles that match ALL requirements (intersection)
      let compatible = null
      for (const { edgeType, edgeLevel, dir } of requirements) {
        const matches = this.hexWfcRules.getByEdge(edgeType, dir, edgeLevel)
        if (compatible === null) {
          compatible = new Set(matches)
        } else {
          const filtered = new Set()
          for (const k of compatible) {
            if (matches.has(k)) filtered.add(k)
          }
          compatible = filtered
        }
        if (compatible.size === 0) break
      }

      if (!compatible || compatible.size === 0) {
        const { q, r, s } = parseCubeKey(cellKey)
        const co = cubeToOffset(q, r, s)
        conflicts.push({
          cell: { q, r, s, global: `${co.col},${co.row}` },
          fixedCells: neighbors.map(({ fixedCell }) => {
            const fo = cubeToOffset(fixedCell.q, fixedCell.r, fixedCell.s)
            return {
              q: fixedCell.q, r: fixedCell.r, s: fixedCell.s,
              global: `${fo.col},${fo.row}`,
              type: TILE_LIST[fixedCell.type]?.name || fixedCell.type,
              rotation: fixedCell.rotation,
              level: fixedCell.level ?? 0,
            }
          }),
          requirements: requirements.map(r => `${r.dir}=${r.edgeType}@${r.edgeLevel}`),
        })
      }
    }

    return { valid: conflicts.length === 0, conflicts }
  }

  /**
   * Try to replace a fixed cell with a compatible alternative
   * Updates both globalCells and the rendered tile in the source grid
   * @param {Object} fixedCell - {q,r,s,type,rotation,level} the cell to replace
   * @param {Array} fixedCells - Current list of fixed cells (for adjacency checks)
   * @param {Set} replacedKeys - Already-replaced cell keys (avoid replacing twice)
   * @returns {boolean} True if replacement was found and applied
   */
  tryReplaceFixedCell(fixedCell, fixedCells, replacedKeys) {
    const key = cubeKey(fixedCell.q, fixedCell.r, fixedCell.s)
    if (replacedKeys.has(key)) return false

    const candidates = this.findReplacementTilesForCell(
      fixedCell.q, fixedCell.r, fixedCell.s,
      fixedCell.type, fixedCell.rotation, fixedCell.level
    )

    // Build a map of other fixed cells for adjacency checks
    const fixedMap = new Map()
    for (const fc of fixedCells) {
      if (fc !== fixedCell) {
        fixedMap.set(cubeKey(fc.q, fc.r, fc.s), fc)
      }
    }

    for (const replacement of candidates) {
      const replacementEdges = rotateHexEdges(TILE_LIST[replacement.type]?.edges || {}, replacement.rotation)
      let compatibleWithFixed = true

      // Check compatibility with adjacent fixed cells
      for (let i = 0; i < 6; i++) {
        const dir = CUBE_DIRS[i]
        const nq = fixedCell.q + dir.dq
        const nr = fixedCell.r + dir.dr
        const ns = fixedCell.s + dir.ds
        const nKey = cubeKey(nq, nr, ns)
        const adjacentFixed = fixedMap.get(nKey)

        if (adjacentFixed) {
          const myEdge = replacementEdges[HexDir[i]]
          const myLevel = getEdgeLevel(replacement.type, replacement.rotation, HexDir[i], replacement.level)
          const adjacentEdges = rotateHexEdges(TILE_LIST[adjacentFixed.type]?.edges || {}, adjacentFixed.rotation)
          const theirEdge = adjacentEdges[HexOpposite[HexDir[i]]]
          const theirLevel = getEdgeLevel(adjacentFixed.type, adjacentFixed.rotation, HexOpposite[HexDir[i]], adjacentFixed.level ?? 0)

          if (!edgesCompatible(myEdge, myLevel, theirEdge, theirLevel)) {
            compatibleWithFixed = false
            break
          }
        }
      }

      if (compatibleWithFixed) {
        const co = cubeToOffset(fixedCell.q, fixedCell.r, fixedCell.s)
        this.replacedCells.add(`${co.col},${co.row}`)

        // Update globalCells
        const existing = this.globalCells.get(key)
        if (existing) {
          existing.type = replacement.type
          existing.rotation = replacement.rotation
          existing.level = replacement.level

          // Update rendered tile in source grid
          const sourceGrid = this.grids.get(existing.gridKey)
          if (sourceGrid) {
            // Convert global cube to local grid coords
            const localCube = {
              q: fixedCell.q - sourceGrid.globalCenterCube.q,
              r: fixedCell.r - sourceGrid.globalCenterCube.r,
              s: fixedCell.s - sourceGrid.globalCenterCube.s,
            }
            const localOffset = cubeToOffset(localCube.q, localCube.r, localCube.s)
            const gridX = localOffset.col + sourceGrid.gridRadius
            const gridZ = localOffset.row + sourceGrid.gridRadius
            sourceGrid.replaceTile(gridX, gridZ, replacement.type, replacement.rotation, replacement.level)
          }
        }

        // Update the fixedCell object in place
        fixedCell.type = replacement.type
        fixedCell.rotation = replacement.rotation
        fixedCell.level = replacement.level
        replacedKeys.add(key)
        return true
      }
    }

    return false
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
   * Populate a grid using global cube coordinates
   * Includes Phase 0/1/2 retry loop for contradiction recovery
   * @param {HexGrid} grid - Grid to populate
   * @param {Object} options - { animate, animateDelay, initialCollapses }
   */
  async populateGrid(grid, seedTiles = [], options = {}) {
    if (grid.state === HexGridState.POPULATED) {
      console.warn('Grid already populated')
      return
    }

    const params = Demo.instance?.params ?? this.params
    const gridKey = getGridKey(grid.gridCoords.x, grid.gridCoords.z)
    const center = grid.globalCenterCube

    // Generate solve cells: all cells in hex radius around grid center
    const solveCells = cubeCoordsInRadius(center.q, center.r, center.s, this.hexGridRadius)

    // Get fixed cells from already-populated neighbors
    let fixedCells = this.getFixedCellsForRegion(solveCells)

    // Build initial collapses for first grid
    const initialCollapses = options.initialCollapses ?? []

    // If no fixed cells and no initial collapses, seed center with grass
    if (fixedCells.length === 0 && initialCollapses.length === 0) {
      initialCollapses.push({ q: center.q, r: center.r, s: center.s, type: TileType.GRASS, rotation: 0, level: 0 })

      // Optionally seed water edge
      this.addWaterEdgeSeeds(initialCollapses, center, this.hexGridRadius)
    }

    const initialFixedCount = fixedCells.length
    let replacedCount = 0
    let droppedCount = 0

    console.log(`%c[${gridKey}] POPULATING GRID (${solveCells.length} cells, ${initialFixedCount} fixed)`, 'color: blue')
    setStatus(`[${gridKey}] Solving WFC...`)

    // ---- Pre-WFC: Filter adjacent fixed cell conflicts ----
    if (fixedCells.length > 1) {
      const filterResult = this.filterConflictingFixedCells(fixedCells)
      const conflicts = filterResult.conflicts
      const preReplacedKeys = new Set()

      // Try replacing conflicting cells, drop if irreplaceable
      for (const conflict of conflicts) {
        const cell = conflict.cellObj
        if (this.tryReplaceFixedCell(cell, fixedCells, preReplacedKeys)) {
          filterResult.validCells.push(cell)
          replacedCount++
        } else {
          const co = cubeToOffset(cell.q, cell.r, cell.s)
          this.droppedCells.add(`${co.col},${co.row}`)
          droppedCount++
        }
      }
      fixedCells = filterResult.validCells
    }

    // ---- Pre-WFC: Validate multi-fixed-cell conflicts ----
    if (fixedCells.length > 1) {
      let validation = this.validateFixedCellConflicts(solveCells, fixedCells)
      const preReplacedKeys = new Set()
      let maxIterations = 50

      while (!validation.valid && fixedCells.length > 1 && maxIterations-- > 0) {
        const conflict = validation.conflicts[0]
        let replaced = false

        // Try replacing each conflicting fixed cell
        for (const fcInfo of conflict.fixedCells) {
          const actualCell = fixedCells.find(fc =>
            fc.q === fcInfo.q && fc.r === fcInfo.r && fc.s === fcInfo.s
          )
          if (actualCell && this.tryReplaceFixedCell(actualCell, fixedCells, preReplacedKeys)) {
            replaced = true
            replacedCount++
            break
          }
        }

        // Fall back to dropping if no replacement found
        if (!replaced) {
          const fcInfo = conflict.fixedCells[0]
          fixedCells = fixedCells.filter(fc =>
            !(fc.q === fcInfo.q && fc.r === fcInfo.r && fc.s === fcInfo.s)
          )
          this.droppedCells.add(fcInfo.global)
          droppedCount++
        }

        validation = this.validateFixedCellConflicts(solveCells, fixedCells)
      }
    }

    // Start placeholder spinning
    grid.placeholder?.startSpinning()

    // ---- Phase 0/1/2 WFC retry loop ----
    const tileTypes = this.getDefaultTileTypes()
    const phaseReplacedKeys = new Set()
    let result = null
    let resultCollapseOrder = []
    let attempt = 0

    // Shuffle helper
    const shuffleArray = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    }

    // Helper to run WFC
    const runWfc = async () => {
      attempt++
      const activeFixed = fixedCells.filter(fc => !fc.dropped)
      const wfcResult = await this.solveWfcAsync(solveCells, activeFixed, {
        tileTypes,
        weights: options.weights ?? {},
        maxRestarts: initialFixedCount === 0 ? 10 : 1,
        initialCollapses,
        gridId: gridKey,
        attemptNum: attempt,
        seed: getSeed(),
      })

      if (wfcResult.success) {
        return { success: true, tiles: wfcResult.tiles, collapseOrder: wfcResult.collapseOrder || [] }
      }

      // Track failed cell
      const contradiction = wfcResult.seedingContradiction || wfcResult.lastContradiction
      if (contradiction) {
        this.failedCells.add(`${contradiction.failedCol},${contradiction.failedRow}`)
      }
      return {
        success: false,
        failedCell: contradiction ? { q: contradiction.failedQ, r: contradiction.failedR, s: contradiction.failedS } : null,
      }
    }

    // Helper: find fixed cells adjacent to a failed cell
    const findAdjacentFixed = (failedQ, failedR, failedS) => {
      const adjacent = []
      for (let i = 0; i < 6; i++) {
        const dir = CUBE_DIRS[i]
        const nq = failedQ + dir.dq
        const nr = failedR + dir.dr
        const ns = failedS + dir.ds
        const nKey = cubeKey(nq, nr, ns)
        const fc = fixedCells.find(c => !c.dropped && cubeKey(c.q, c.r, c.s) === nKey)
        if (fc) adjacent.push(fc)
      }
      return adjacent
    }

    // Phase 0: Initial attempt
    const initialResult = await runWfc()
    if (initialResult.success) {
      result = initialResult.tiles
      resultCollapseOrder = initialResult.collapseOrder
    } else {
      // Phase 1: Replace fixed cells, prioritizing those adjacent to failed cells
      const shuffledFallback = shuffleArray([...fixedCells])
      let fallbackIndex = 0
      let lastFailedCell = initialResult.failedCell

      while (!result) {
        let wfcResult = null

        // First: try fixed cells adjacent to the last failed cell
        if (lastFailedCell) {
          const adjacent = findAdjacentFixed(lastFailedCell.q, lastFailedCell.r, lastFailedCell.s)
          for (const fc of adjacent) {
            if (this.tryReplaceFixedCell(fc, fixedCells, phaseReplacedKeys)) {
              replacedCount++
              // Re-validate after replacement
              const activeFixed = fixedCells.filter(c => !c.dropped)
              const validation = this.validateFixedCellConflicts(solveCells, activeFixed)
              if (!validation.valid) {
                for (const conflict of validation.conflicts) {
                  const fcInfo = conflict.fixedCells[0]
                  const toDropFC = fixedCells.find(c =>
                    c.q === fcInfo.q && c.r === fcInfo.r && c.s === fcInfo.s && !c.dropped
                  )
                  if (toDropFC) {
                    toDropFC.dropped = true
                    droppedCount++
                    this.droppedCells.add(fcInfo.global)
                  }
                }
              }
              wfcResult = await runWfc()
              if (wfcResult) break
            }
          }
        }

        // Fallback: try next fixed cell from shuffled list
        if (!wfcResult) {
          while (fallbackIndex < shuffledFallback.length) {
            const candidate = shuffledFallback[fallbackIndex++]
            if (candidate.dropped) continue
            if (this.tryReplaceFixedCell(candidate, fixedCells, phaseReplacedKeys)) {
              replacedCount++
              wfcResult = await runWfc()
              if (wfcResult) break
            }
          }
        }

        if (!wfcResult) break  // No more cells to try

        if (wfcResult.success) {
          result = wfcResult.tiles
          resultCollapseOrder = wfcResult.collapseOrder
        } else {
          lastFailedCell = wfcResult.failedCell
        }
      }

      // Phase 2: Try dropping fixed cells one by one
      if (!result) {
        const shuffledForDrop = shuffleArray(
          fixedCells.filter(fc => !fc.dropped)
        )

        for (const fcToDrop of shuffledForDrop) {
          if (result) break

          const co = cubeToOffset(fcToDrop.q, fcToDrop.r, fcToDrop.s)
          this.droppedCells.add(`${co.col},${co.row}`)
          fcToDrop.dropped = true
          droppedCount++

          const wfcResult = await runWfc()
          if (wfcResult.success) {
            result = wfcResult.tiles
            resultCollapseOrder = wfcResult.collapseOrder
          }
        }
      }
    }

    // Stop placeholder spinning
    grid.placeholder?.stopSpinning()

    if (!result) {
      console.log(`%c[${gridKey}] WFC FAILED`, 'color: red')
      setStatus(`[${gridKey}] WFC FAILED`)
      const { Sounds } = await import('./lib/Sounds.js')
      Sounds.play('incorrect')
      return
    }

    // Log final status
    const stats = [`${initialFixedCount} neighbours`]
    if (attempt > 1) stats.push(`${attempt} attempts`)
    if (replacedCount > 0) stats.push(`${replacedCount} replaced`)
    if (droppedCount > 0) stats.push(`${droppedCount} dropped`)
    const statusMsg = `[${gridKey}] WFC SUCCESS (${stats.join(', ')})`
    if (droppedCount > 0) {
      const prefix = stats.slice(0, -1).join(', ')
      console.log(`%c[${gridKey}] WFC SUCCESS (${prefix}, %c${droppedCount} dropped%c)`, 'color: green', 'color: red', 'color: green')
    } else {
      console.log(`%c${statusMsg}`, 'color: green')
    }
    setStatus(statusMsg)

    // Add results to global cell map
    this.addToGlobalCells(gridKey, result)

    // Populate grid from cube results
    const animate = options.animate ?? (params?.roads?.animateWFC ?? false)
    const animateDelay = options.animateDelay ?? (params?.roads?.animateDelay ?? 20)

    await grid.populateFromCubeResults(result, resultCollapseOrder, center, {
      animate,
      animateDelay,
    })

    // Apply current helper visibility state
    grid.setHelperVisible(this.helpersVisible)
  }

  /**
   * Add water edge seeds for first grid (50% chance, 1 random edge)
   * @param {Array} initialCollapses - Array to push water seeds into
   * @param {Object} center - {q,r,s} grid center cube coords
   * @param {number} radius - Grid radius
   */
  addWaterEdgeSeeds(initialCollapses, center, radius) {
    if (random() >= 0.5) return

    const selectedEdge = Math.floor(random() * 6)

    // Get all cells at the edge of the hex radius
    const edgeCells = cubeCoordsInRadius(center.q, center.r, center.s, radius).filter(c => {
      return cubeDistance(c.q, c.r, c.s, center.q, center.r, center.s) === radius
    })

    for (const cell of edgeCells) {
      // Determine which "edge sector" (0-5) this cell is in by angle from center
      const dq = cell.q - center.q
      const dr = cell.r - center.r
      // Convert cube delta to approximate world angle
      // For pointy-top hex: q axis ~ east, r axis ~ south-east
      const wx = dq + dr * 0.5
      const wz = dr * (Math.sqrt(3) / 2)
      const angle = Math.atan2(wz, wx)
      const normalizedAngle = (angle + Math.PI) / (Math.PI * 2)
      const edgeIndex = Math.floor(normalizedAngle * 6) % 6

      if (edgeIndex === selectedEdge) {
        initialCollapses.push({ q: cell.q, r: cell.r, s: cell.s, type: TileType.WATER, rotation: 0, level: 0 })
      }
    }
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
    const params = Demo.instance?.params

    await this.populateGrid(grid, [], {
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
   * Auto-expand grids in a given order (for testing/replay)
   * @param {Array<[number,number]>} order - Array of [gridX, gridZ] pairs
   */
  async autoExpand(order) {
    for (const [gx, gz] of order) {
      const key = getGridKey(gx, gz)
      const grid = this.grids.get(key)
      if (!grid) {
        console.warn(`autoExpand: grid ${key} not found, creating placeholder`)
        await this.createGrid(gx, gz)
        const g = this.grids.get(key)
        if (g) await this.onGridClick(g)
      } else if (grid.state === HexGridState.PLACEHOLDER) {
        await this.onGridClick(grid)
      }
    }
    console.log('autoExpand: done')
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

    this.raycaster.setFromCamera(pointer, camera)

    // Check placeholders first
    if (placeholderClickables.length > 0) {
      const intersects = this.raycaster.intersectObjects(placeholderClickables)
      if (intersects.length > 0) {
        const clickable = intersects[0].object
        if (clickable.userData.isPlaceholder) {
          const ownerGrid = clickable.userData.owner?.group?.userData?.hexGrid
          if (ownerGrid && ownerGrid.onClick) {
            ownerGrid.onClick()
            return true
          }
        }
      }
    }

    // Check hex tile meshes for debug logging
    const hexMeshes = []
    const meshToGrid = new Map()
    for (const grid of this.grids.values()) {
      if (grid.state === HexGridState.POPULATED && grid.hexMesh) {
        hexMeshes.push(grid.hexMesh)
        meshToGrid.set(grid.hexMesh, grid)
      }
    }
    if (hexMeshes.length > 0) {
      const intersects = this.raycaster.intersectObjects(hexMeshes)
      if (intersects.length > 0) {
        const hit = intersects[0]
        const grid = meshToGrid.get(hit.object)
        const batchId = hit.batchId ?? hit.instanceId
        if (grid && batchId !== undefined) {
          const tile = grid.hexTiles.find(t => t.instanceId === batchId)
          if (tile) {
            const def = TILE_LIST[tile.type]
            const globalCube = grid.globalCenterCube ?? { q: 0, r: 0, s: 0 }
            const global = localToGlobalCoords(tile.gridX, tile.gridZ, grid.gridRadius, globalCube)
            console.log(
              `%c[TILE CLICK] (${global.col},${global.row}) ${def?.name || '?'} type=${tile.type} rot=${tile.rotation} level=${tile.level}`,
              'color: blue'
            )
          }
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

    // Clear global state
    this.globalCells.clear()
    this.failedCells.clear()
    this.replacedCells.clear()
    this.droppedCells.clear()

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
          div.textContent = this.tileLabelMode === 'levels' ? `${baseLevel}` : `${globalOffset.col},${globalOffset.row}`
          const globalKey = `${globalOffset.col},${globalOffset.row}`
          const isFailed = this.failedCells.has(globalKey)
          const isReplaced = this.replacedCells.has(globalKey)
          const isDropped = this.droppedCells.has(globalKey)
          // Purple = failed cell, Orange = replaced, Red = dropped, Gray = normal
          const bgColor = isFailed ? 'rgba(150,50,200,0.9)'
            : isDropped ? 'rgba(200,50,50,0.9)'
            : isReplaced ? 'rgba(220,140,20,0.9)'
            : 'rgba(0,0,0,0.5)'
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
            div.textContent = this.tileLabelMode === 'levels' ? `-` : `${globalOffset.col},${globalOffset.row}`
            const globalKey = `${globalOffset.col},${globalOffset.row}`
            const isFailed = this.failedCells.has(globalKey)
            const isReplaced = this.replacedCells.has(globalKey)
            const isDropped = this.droppedCells.has(globalKey)
            const isHighlighted = isFailed || isReplaced || isDropped
            // Purple = failed cell, Orange = replaced, Red = dropped, Gray = normal
            const bgColor = isFailed ? 'rgba(150,50,200,0.9)'
              : isDropped ? 'rgba(200,50,50,0.9)'
              : isReplaced ? 'rgba(220,140,20,0.9)'
              : 'rgba(0,0,0,0.3)'
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
    // Toggle material texture so instance colors fully override (not multiply)
    const mat = HexTileGeometry.material
    if (mat) {
      if (HexTile.debugLevelColors) {
        if (!mat._savedMap) mat._savedMap = mat.map
        mat.map = null
        mat.needsUpdate = true
      } else if (mat._savedMap) {
        mat.map = mat._savedMap
        mat._savedMap = null
        mat.needsUpdate = true
      }
    }
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
