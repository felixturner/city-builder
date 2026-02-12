import {
  Object3D,
  MeshPhysicalNodeMaterial,
  PlaneGeometry,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector2,
  TextureLoader,
  SRGBColorSpace,
} from 'three/webgpu'
import WFCWorker from './workers/wfc.worker.js?worker'
import { uniform, varyingProperty, materialColor, diffuseColor, materialOpacity, vec3, vec4, texture, uv, mix, select, positionWorld, positionLocal, positionGeometry, mx_noise_float, float, clamp, time as tslTime, sin, cos, modelWorldMatrix } from 'three/tsl'
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
import { Weather } from './Weather.js'
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
    this.overlapRings = 1  // Number of overlap rings (neighbor cells made solvable)
    this.roadMaterial = null



    // WFC rules (shared across all grids)
    this.hexWfcRules = null

    // Global cell map — all collapsed cells across all grids
    // key: "q,r,s" cube coords, value: { q, r, s, type, rotation, level, gridKey }
    this.globalCells = new Map()

    // Debug tile labels
    this.tileLabels = new Object3D()
    this.tileLabels.visible = false
    this.tileLabelMode = 'coords'
    this.failedCells = new Set()   // Track global coords of cells that caused WFC failures (purple labels)
    this.overlapChangedCells = new Set() // Track global coords of overlap cells changed by WFC (orange labels)
    this.droppedCells = new Set() // Track global coords of dropped fixed cells (red labels)
    this.replacedCells = new Set() // Track global coords of replaced fixed cells (orange labels)

    // Interaction
    this.raycaster = new Raycaster()
    this.hoveredGrid = null  // HexGrid being hovered

    // Helper visibility state
    this.helpersVisible = false
    this.axesHelpersVisible = false

    // Weather
    this.weather = null

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

    this.weather = new Weather()
    this.weather.init()
    this.scene.add(this.weather.group)

    // Create center grid at (0,0) and immediately populate it
    const centerGrid = await this.createGrid(0, 0)
    const initAnimDuration = await this.populateGrid(centerGrid, []) || 0

    // Create placeholder grids around the center
    await this.createAdjacentPlaceholders('0,0', initAnimDuration + 300)

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

    const mat = new MeshPhysicalNodeMaterial()
    mat.roughness = 0.5
    mat.metalness = 0
    this.roadMaterial = mat

    // Override setupDiffuseColor to skip the automatic batchColor multiply.
    // We read vBatchColor ourselves in the colorNode for level data, not as a tint.
    this.roadMaterial.setupDiffuseColor = function(builder) {
      const colorNode = this.colorNode ? vec4(this.colorNode) : materialColor
      diffuseColor.assign(colorNode)
      const opacityNode = this.opacityNode ? float(this.opacityNode) : materialOpacity
      diffuseColor.a.assign(diffuseColor.a.mul(opacityNode))
    }

    // Clone material for trees (separate so we can add wind sway positionNode)
    this.treeMaterial = this.roadMaterial.clone()
    this.treeMaterial.setupDiffuseColor = this.roadMaterial.setupDiffuseColor

    // Load season textures and set up noise-blended colorNode
    await this._initTextureBlend()

    this.roadMaterial.colorNode = this._combinedColor
    this.treeMaterial.colorNode = this._combinedColor

    // Wind sway — override setupPosition to add displacement AFTER batching.
    // Nodes must be built inside setupPosition so positionLocal references the
    // post-batch value (built outside, it resolves to the raw attribute).
    this._windStrength = uniform(0.0375)
    this._windSpeed = uniform(1.46)
    this._windFreq = uniform(0.902)
    const time = tslTime
    const windStrength = this._windStrength
    const windSpeed = this._windSpeed
    const windFreq = this._windFreq

    // positionNode is evaluated after batching in Three.js pipeline.
    // The isPositionNodeInput context makes positionLocal resolve to post-batch value.
    const worldPos = modelWorldMatrix.mul(vec4(positionLocal, float(1))).xyz
    const phase = worldPos.x.mul(windFreq).add(worldPos.z.mul(windFreq).mul(0.6))
    const swayMask = positionGeometry.y.mul(windStrength)
    const swayX = sin(time.mul(windSpeed).add(phase)).mul(swayMask)
    const swayZ = sin(time.mul(windSpeed).mul(0.85).add(phase).add(1.5)).mul(swayMask)

    this.treeMaterial.positionNode = positionLocal.add(vec3(swayX, float(0), swayZ))

  }

  /**
   * Load season textures and build the TSL blend node
   */
  async _initTextureBlend() {
    // Load both season textures
    const loader = new TextureLoader()
    const loadTex = (path) => new Promise((resolve) => {
      loader.load(path, (tex) => {
        tex.flipY = false  // GLB geometry UVs expect non-flipped textures
        tex.colorSpace = SRGBColorSpace
        tex.needsUpdate = true
        resolve(tex)
      })
    })

    const [texA, texB] = await Promise.all([
      loadTex('./assets/textures/moody.png'),
      loadTex('./assets/textures/winter.png'),
    ])

    this._texA = texA
    this._texB = texB

    // Sample both textures at the same UVs (store nodes for runtime swapping)
    const texCoord = uv()
    this._texNodeA = texture(texA, texCoord)
    this._texNodeB = texture(texB, texCoord)
    const sampleA = this._texNodeA
    const sampleB = this._texNodeB

    // Tile level stored as greyscale in instance color (0 at level 0, 1 at level 3)
    // setupDiffuseColor override prevents auto-multiply, so this is pure data
    const batchColor = varyingProperty('vec3', 'vBatchColor')
    const levelBlend = batchColor.r
    // Raw geometry Y (before batch transform) for slope gradient
    // Tile surface is at geomY=1.0, each 0.5u above = +1 level, max 3 levels
    // So slope contribution = (geomY - 1.0) / 0.5 / 3 = (geomY - 1.0) * 2/3
    const rawGeomPos = positionGeometry.varying('vRawGeomPos')
    const slopeContrib = rawGeomPos.y.sub(1.0).mul(2.0 / 3.0)
    // Level bias shifts the blend ramp up or down (-1 to 1)
    this._levelBias = uniform(0)
    const blendFactor = clamp(levelBlend.add(slopeContrib).add(this._levelBias), 0, 1)

    // Blended season textures (normal mode)
    const blendedColor = mix(sampleA, sampleB, blendFactor)

    // Debug HSL gradient (level colors mode): hue 0 (red) → 250/360 (blue)
    const hue = blendFactor.mul(250.0 / 360.0)
    const h6 = hue.mul(6.0)
    const hslR = clamp(h6.sub(3.0).abs().sub(1.0), 0, 1)
    const hslG = clamp(float(2.0).sub(h6.sub(2.0).abs()), 0, 1)
    const hslB = clamp(float(2.0).sub(h6.sub(4.0).abs()), 0, 1)
    const debugColor = vec3(hslR, hslG, hslB)

    // Mode uniform: 0 = normal (blended textures), 1 = debug HSL, 2 = white
    this._colorMode = uniform(0)
    const isDebug = this._colorMode.equal(1)
    const isWhite = this._colorMode.equal(2)
    this._combinedColor = select(isWhite, vec3(1, 1, 1), select(isDebug, debugColor, blendedColor))

    this.roadMaterial.needsUpdate = true
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
      console.log(`%c${e.data.message}`, `color: ${e.data.color || 'black'}`)
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
      const existing = this.globalCells.get(key)
      if (existing) {
        // Update tile data in-place, keep original gridKey (overlap cells stay owned by source grid)
        existing.type = tile.type
        existing.rotation = tile.rotation
        existing.level = tile.level
      } else {
        this.globalCells.set(key, {
          q: tile.q, r: tile.r, s: tile.s,
          type: tile.type, rotation: tile.rotation, level: tile.level,
          gridKey
        })
      }
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
   * Get overlap cells (N rings, solvable) and fixed cells (1 ring beyond overlap, immutable)
   * Uses this.overlapRings to control depth.
   * @param {Array} solveCells - [{q,r,s}] core cells to solve
   * @returns {{ overlapCells: Array, fixedCells: Array }}
   */
  getFixedAndOverlapCells(solveCells) {
    const solveSet = new Set(solveCells.map(c => cubeKey(c.q, c.r, c.s)))
    const overlapMap = new Map()

    // Build overlap rings iteratively
    // Each ring expands from the previous frontier (ring 0 frontier = solveCells)
    let frontier = solveCells
    const allClaimed = new Set(solveSet) // solve + overlap keys

    for (let ring = 0; ring < this.overlapRings; ring++) {
      const nextFrontier = []
      for (const { q, r, s } of frontier) {
        for (const dir of CUBE_DIRS) {
          const nq = q + dir.dq
          const nr = r + dir.dr
          const ns = s + dir.ds
          const nKey = cubeKey(nq, nr, ns)
          if (allClaimed.has(nKey)) continue
          const existing = this.globalCells.get(nKey)
          if (existing) {
            const cell = {
              q: nq, r: nr, s: ns,
              type: existing.type, rotation: existing.rotation, level: existing.level,
              gridKey: existing.gridKey
            }
            overlapMap.set(nKey, cell)
            allClaimed.add(nKey)
            nextFrontier.push(cell)
          }
        }
      }
      frontier = nextFrontier
    }

    // Fixed ring: 1 ring beyond the outermost overlap ring
    const fixedMap = new Map()
    for (const { q, r, s } of frontier) {
      for (const dir of CUBE_DIRS) {
        const nq = q + dir.dq
        const nr = r + dir.dr
        const ns = s + dir.ds
        const nKey = cubeKey(nq, nr, ns)
        if (allClaimed.has(nKey)) continue
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

    return {
      overlapCells: [...overlapMap.values()],
      fixedCells: [...fixedMap.values()]
    }
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
    if (candidates.length === 0) return false

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
        const rco = cubeToOffset(fixedCell.q, fixedCell.r, fixedCell.s)
        this.replacedCells.add(`${rco.col},${rco.row}`)
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
    const grid = new HexGrid(this.scene, this.roadMaterial, this.hexGridRadius, worldOffset, this.treeMaterial)
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

    // Generate core solve cells: all cells in hex radius around grid center
    const coreSolveCells = cubeCoordsInRadius(center.q, center.r, center.s, this.hexGridRadius)

    // Get overlap cells (ring 1, solvable) and fixed cells (ring 2, immutable)
    const { overlapCells, fixedCells: outerFixed } = this.getFixedAndOverlapCells(coreSolveCells)
    const solveCells = [...coreSolveCells, ...overlapCells.map(c => ({ q: c.q, r: c.r, s: c.s }))]
    let fixedCells = outerFixed

    // Build initial collapses for first grid
    const initialCollapses = options.initialCollapses ?? []

    // If no fixed cells, no overlap cells, and no initial collapses, seed center with grass
    if (fixedCells.length === 0 && overlapCells.length === 0 && initialCollapses.length === 0) {
      initialCollapses.push({ q: center.q, r: center.r, s: center.s, type: TileType.GRASS, rotation: 0, level: 0 })

      // Optionally seed water edge
      this.addWaterEdgeSeeds(initialCollapses, center, this.hexGridRadius)
    }

    let overlapChangedCount = 0

    console.log(`%c[${gridKey}] POPULATING GRID (${coreSolveCells.length} cells, ${overlapCells.length} neighbours)`, 'color: blue')
    setStatus(`[${gridKey}] Solving WFC...`)

    // Start placeholder spinning
    grid.placeholder?.startSpinning()

    // ---- WFC solve (overlap handles boundary flexibility) ----
    const tileTypes = this.getDefaultTileTypes()

    // Build previousStates from overlap cells so WFC can bias toward keeping them
    const previousStates = {}
    for (const oc of overlapCells) {
      previousStates[cubeKey(oc.q, oc.r, oc.s)] = {
        type: oc.type, rotation: oc.rotation, level: oc.level
      }
    }

    const wfcResult = await this.solveWfcAsync(solveCells, fixedCells, {
      tileTypes,
      weights: options.weights ?? {},
      maxRestarts: 10,
      initialCollapses,
      gridId: gridKey,
      attemptNum: 1,
      seed: getSeed(),
      previousStates,
      grassAnyLevel: params.roads.grassAnyLevel,
    })

    let result = null
    let resultCollapseOrder = []

    if (wfcResult.success) {
      result = wfcResult.tiles
      resultCollapseOrder = wfcResult.collapseOrder || []
    } else {
      // Only mark purple cell for seeding contradictions (genuine fixed cell conflicts)
      if (wfcResult.seedingContradiction) {
        const c = wfcResult.seedingContradiction
        this.failedCells.add(`${c.failedCol},${c.failedRow}`)
      }

      // ---- Fallback Phase 1: replace fixed cells one by one and retry ----
      if (fixedCells.length > 0) {
        console.log(`%cWFC failed, trying replace fallback`, 'color: red')
        const replacedKeys = new Set()
        let attemptNum = wfcResult.seedingContradiction ? 1 : 10

        // Sort fixed cells: neighbors of failed cell first
        const sc = wfcResult.seedingContradiction || wfcResult.lastContradiction
        const sortedFixed = [...fixedCells]
        if (sc) {
          const failedNeighborKeys = new Set(
            CUBE_DIRS.map(d => cubeKey(sc.failedQ + d.dq, sc.failedR + d.dr, sc.failedS + d.ds))
          )
          sortedFixed.sort((a, b) => {
            const aIsNear = failedNeighborKeys.has(cubeKey(a.q, a.r, a.s)) ? 0 : 1
            const bIsNear = failedNeighborKeys.has(cubeKey(b.q, b.r, b.s)) ? 0 : 1
            return aIsNear - bIsNear
          })
        }

        for (const fc of sortedFixed) {
          if (result) break
          if (this.tryReplaceFixedCell(fc, fixedCells, replacedKeys)) {
            attemptNum++
            console.log(`%cReplaced ${replacedKeys.size} cells`, 'color: red')
            const replaceResult = await this.solveWfcAsync(solveCells, fixedCells, {
              tileTypes, weights: options.weights ?? {}, maxRestarts: 1,
              initialCollapses, gridId: gridKey, attemptNum,
              seed: getSeed(), previousStates, grassAnyLevel: params.roads.grassAnyLevel,
              quietSeeding: true,
            })
            if (replaceResult.success) {
              result = replaceResult.tiles
              resultCollapseOrder = replaceResult.collapseOrder || []
            }
          }
        }

        // ---- Fallback Phase 2: drop fixed cells one by one and retry ----
        if (!result) {
          console.log(`%cReplace failed, trying drop fallback`, 'color: red')
          const droppedKeys = new Set()
          for (const fc of sortedFixed) {
            if (result) break
            const fcKey = cubeKey(fc.q, fc.r, fc.s)
            droppedKeys.add(fcKey)
            const dco = cubeToOffset(fc.q, fc.r, fc.s)
            this.droppedCells.add(`${dco.col},${dco.row}`)
            const reducedFixed = fixedCells.filter(f => !droppedKeys.has(cubeKey(f.q, f.r, f.s)))
            attemptNum++
            console.log(`%cDropped ${droppedKeys.size} cells`, 'color: red')

            const dropResult = await this.solveWfcAsync(solveCells, reducedFixed, {
              tileTypes, weights: options.weights ?? {}, maxRestarts: 1,
              initialCollapses, gridId: gridKey, attemptNum,
              seed: getSeed(), previousStates, grassAnyLevel: params.roads.grassAnyLevel,
              quietSeeding: true,
            })
            if (dropResult.success) {
              result = dropResult.tiles
              resultCollapseOrder = dropResult.collapseOrder || []
            }
          }
        }
      }
    }

    // Stop placeholder spinning
    grid.placeholder?.stopSpinning()

    if (!result) {
      console.log(`%c[${gridKey}] WFC FAILED (all recovery attempts exhausted)`, 'color: red')
      setStatus(`[${gridKey}] WFC FAILED`)
      const { Sounds } = await import('./lib/Sounds.js')
      Sounds.play('incorrect')
      return
    }

    // ---- Handle overlap cell changes ----
    // Build result lookup from WFC results
    const resultMap = new Map()
    for (const tile of result) {
      resultMap.set(cubeKey(tile.q, tile.r, tile.s), tile)
    }

    // Compare overlap cells: check if WFC re-solved them differently
    for (const oc of overlapCells) {
      const key = cubeKey(oc.q, oc.r, oc.s)
      const solved = resultMap.get(key)
      if (!solved) continue

      // Check if tile changed
      if (solved.type !== oc.type || solved.rotation !== oc.rotation || solved.level !== oc.level) {
        overlapChangedCount++
        const co = cubeToOffset(oc.q, oc.r, oc.s)
        this.overlapChangedCells.add(`${co.col},${co.row}`)

        // Update globalCells with new tile data (keeps original gridKey)
        const existing = this.globalCells.get(key)
        if (existing) {
          existing.type = solved.type
          existing.rotation = solved.rotation
          existing.level = solved.level

          // Update rendered tile in source grid
          const sourceGrid = this.grids.get(existing.gridKey)
          if (sourceGrid) {
            const localCube = {
              q: oc.q - sourceGrid.globalCenterCube.q,
              r: oc.r - sourceGrid.globalCenterCube.r,
              s: oc.s - sourceGrid.globalCenterCube.s,
            }
            const localOffset = cubeToOffset(localCube.q, localCube.r, localCube.s)
            const gridX = localOffset.col + sourceGrid.gridRadius
            const gridZ = localOffset.row + sourceGrid.gridRadius
            sourceGrid.replaceTile(gridX, gridZ, solved.type, solved.rotation, solved.level)
            // Remove old decorations and add bridge if new tile is a crossing
            sourceGrid.decorations?.clearDecorationsAt(gridX, gridZ)
            const replacedTile = sourceGrid.hexGrid[gridX]?.[gridZ]
            if (replacedTile) {
              sourceGrid.decorations?.addBridgeAt(replacedTile, sourceGrid.gridRadius)
            }
          }
        }
      }
    }

    // Log final status
    const stats = [`${overlapCells.length} neighbours`]
    if (overlapChangedCount > 0) stats.push(`${overlapChangedCount} changed`)
    const statusMsg = `WFC SUCCESS (${stats.join(', ')})`
    console.log(`%c${statusMsg}`, 'color: green')
    setStatus(statusMsg)

    // Filter result to only core cells (overlap cells already handled via replaceTile)
    const coreSolveSet = new Set(coreSolveCells.map(c => cubeKey(c.q, c.r, c.s)))
    const coreResult = result.filter(tile => coreSolveSet.has(cubeKey(tile.q, tile.r, tile.s)))

    // Add core results to global cell map
    this.addToGlobalCells(gridKey, coreResult)

    // Populate grid from core cube results only
    const animate = options.animate ?? (params?.roads?.animateWFC ?? false)
    const animateDelay = options.animateDelay ?? (params?.roads?.animateDelay ?? 20)

    const animDuration = await grid.populateFromCubeResults(coreResult, resultCollapseOrder, center, {
      animate,
      animateDelay,
    })

    // Apply current helper visibility state
    grid.setHelperVisible(this.helpersVisible)

    return animDuration
  }

  /**
   * Add water edge seeds for first grid (50% chance, 1 random edge)
   * @param {Array} initialCollapses - Array to push water seeds into
   * @param {Object} center - {q,r,s} grid center cube coords
   * @param {number} radius - Grid radius
   */
  addWaterEdgeSeeds(initialCollapses, center, radius) {
    if (random() >= 0.5) {
      console.log('%c[Water seed] skipped (50% roll)', 'color: blue')
      return
    }
    console.log('%c[Water seed] triggered', 'color: blue')

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
        grid.fadeOut()
        setTimeout(() => {
          this.grids.delete(key)
          grid.dispose()
        }, 300)
      }
    }
  }

  /**
   * Create placeholder grids around a populated grid
   * Only creates within valid bounds (2 rings = 19 grids max)
   * After first expansion, only creates placeholders with 2+ populated neighbors
   * @param {string} centerKey - Grid key of the populated grid
   */
  async createAdjacentPlaceholders(centerKey, fadeDelay = 0) {
    const populatedCount = this.countPopulatedGrids()
    const isFirstExpansion = populatedCount <= 1

    const createPromises = []

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

      createPromises.push(this.createGrid(gridX, gridZ))
    }

    const newGrids = await Promise.all(createPromises)

    // Fade in new placeholders + outlines after WFC animation
    if (fadeDelay > 0) {
      for (const grid of newGrids) {
        grid?.fadeIn(fadeDelay)
      }
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

    const animDuration = await this.populateGrid(grid, [], {
      animate: params?.roads?.animateWFC ?? false,
      animateDelay: params?.roads?.animateDelay ?? 20,
    }) || 0

    // Create placeholders around this newly populated grid, fade in after animation
    await this.createAdjacentPlaceholders(gridKey, animDuration + 300)

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
    this.overlapChangedCells.clear()
    this.droppedCells.clear()
    this.replacedCells.clear()

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
    await this.createAdjacentPlaceholders('0,0')

    // Refresh labels if visible
    if (this.tileLabels.visible) {
      this.createTileLabels()
    }

    // Clear regeneration flag
    this.isRegenerating = false
  }

  update(dt) {
    if (this.weather) {
      const demo = Demo.instance
      const target = demo?.controls?.target
      const camera = demo?.camera
      this.weather.update(dt, target, camera)
    }
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
          const isDropped = this.droppedCells.has(globalKey)
          const isReplaced = this.replacedCells.has(globalKey)
          const isOverlapChanged = this.overlapChangedCells.has(globalKey)
          // Purple = failed cell, Red = dropped, Orange = replaced/overlap changed, Gray = normal
          const bgColor = isFailed ? 'rgba(150,50,200,0.9)'
            : isDropped ? 'rgba(200,50,50,0.9)'
            : (isReplaced || isOverlapChanged) ? 'rgba(220,140,20,0.9)'
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
            const isDropped = this.droppedCells.has(globalKey)
            const isReplaced = this.replacedCells.has(globalKey)
            const isOverlapChanged = this.overlapChangedCells.has(globalKey)
            const isHighlighted = isFailed || isDropped || isReplaced || isOverlapChanged
            // Purple = failed cell, Red = dropped, Orange = replaced/overlap changed, Gray = normal
            const bgColor = isFailed ? 'rgba(150,50,200,0.9)'
              : isDropped ? 'rgba(200,50,50,0.9)'
              : (isReplaced || isOverlapChanged) ? 'rgba(220,140,20,0.9)'
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
   * Toggle white mode — strips texture so everything renders as flat white
   */
  setWhiteMode(enabled) {
    this._whiteMode = enabled
    this._updateColorNode()
  }

  /**
   * Update the material color mode: 0 = normal, 1 = debug HSL, 2 = white
   */
  _updateColorNode() {
    if (!this._colorMode) return
    if (this._whiteMode) {
      this._colorMode.value = 2
    } else if (HexTile.debugLevelColors) {
      this._colorMode.value = 1
    } else {
      this._colorMode.value = 0
    }
  }

  /**
   * Swap a biome texture at runtime (lo or hi)
   * @param {'lo'|'hi'} slot - Which texture to replace
   * @param {string} path - Texture file path (e.g. './assets/textures/summer.png')
   */
  swapBiomeTexture(slot, path) {
    const node = slot === 'lo' ? this._texNodeA : this._texNodeB
    if (!node) return
    const ref = this._texA // use existing texture settings as reference
    const loader = new TextureLoader()
    loader.load(path, (tex) => {
      if (ref) {
        tex.flipY = ref.flipY
        tex.colorSpace = ref.colorSpace
        tex.wrapS = ref.wrapS
        tex.wrapT = ref.wrapT
        tex.channel = ref.channel
      }
      tex.needsUpdate = true
      node.value = tex
      if (slot === 'lo') this._texA = tex
      else this._texB = tex
      this.roadMaterial.needsUpdate = true
      if (this.treeMaterial) this.treeMaterial.needsUpdate = true
    })
  }

  /**
   * Update tile colors on all populated grids (for debug level visualization)
   */
  updateTileColors() {
    this._updateColorNode()
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
    if (this.weather) overlays.push(...this.weather.getOverlayObjects())
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
