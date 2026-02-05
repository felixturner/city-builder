import {
  HexTileDefinitions,
  HexTileType,
  HexDir,
  HexOpposite,
  getHexNeighborOffset,
  getReturnDirection,
  rotateHexEdges,
} from './HexTiles.js'

/**
 * Check if two edges are compatible (edge type + level must match)
 * @param {string} edgeTypeA - Edge type (grass, road, etc.)
 * @param {number} levelA - Level of edge A
 * @param {string} edgeTypeB - Edge type of neighbor
 * @param {number} levelB - Level of edge B
 */
function edgesCompatible(edgeTypeA, levelA, edgeTypeB, levelB) {
  // Both edge type and level must match
  return edgeTypeA === edgeTypeB && levelA === levelB
}

// Cache for rotated high edges: Map<"type_rotation", Set<dir>>
const highEdgeCache = new Map()

/**
 * Get the level for a specific edge of a tile
 * Slopes have different levels on high vs low edges
 */
function getEdgeLevel(tileType, rotation, dir, baseLevel) {
  const def = HexTileDefinitions[tileType]
  if (!def || !def.highEdges) {
    // Non-slope tile: all edges at base level
    return baseLevel
  }

  // Check cache for rotated high edges
  const cacheKey = `${tileType}_${rotation}`
  let highEdges = highEdgeCache.get(cacheKey)

  if (!highEdges) {
    // Compute and cache rotated high edges
    highEdges = new Set()
    for (const highDir of def.highEdges) {
      const dirIndex = HexDir.indexOf(highDir)
      const rotatedIndex = (dirIndex + rotation) % 6
      highEdges.add(HexDir[rotatedIndex])
    }
    highEdgeCache.set(cacheKey, highEdges)
  }

  // High edges are at baseLevel + 1, low edges at baseLevel
  return highEdges.has(dir) ? baseLevel + 1 : baseLevel
}

/**
 * HexWFCCell - Tracks possibility space for one hex grid cell
 */
export class HexWFCCell {
  constructor(allStates) {
    // Each state is { type, rotation, level } - store as "type_rotation_level" keys
    this.possibilities = new Set(allStates.map(s => HexWFCCell.stateKey(s)))
    this.collapsed = false
    this.tile = null  // { type, rotation, level } when collapsed
  }

  static stateKey(state) {
    return `${state.type}_${state.rotation}_${state.level ?? 0}`
  }

  static parseKey(key) {
    const [type, rotation, level] = key.split('_').map(Number)
    return { type, rotation, level: level ?? 0 }
  }

  get entropy() {
    if (this.collapsed) return 0
    // Shannon entropy simplified + noise for tie-breaking
    return Math.log(this.possibilities.size) + Math.random() * 0.001
  }

  collapse(state) {
    this.possibilities.clear()
    this.possibilities.add(HexWFCCell.stateKey(state))
    this.collapsed = true
    this.tile = state
  }

  remove(stateKey) {
    return this.possibilities.delete(stateKey)
  }

  has(stateKey) {
    return this.possibilities.has(stateKey)
  }
}

/**
 * HexWFCAdjacencyRules - Pre-computed tile compatibility for hex grids
 * Handles offset coordinate asymmetry by indexing by edge type
 */
export class HexWFCAdjacencyRules {
  constructor() {
    // For each state, what states can be placed in each direction (unused now, kept for API)
    this.allowed = new Map()

    // Pre-computed edge info per state: stateKey → { dir: { type, level } }
    this.stateEdges = new Map()

    // 3D index by edge type, direction, AND level: edgeType → dir → level → Set<stateKey>
    // This allows O(1) lookup during propagation instead of O(candidates) filtering
    this.byEdge = new Map()
  }

  /**
   * Build adjacency rules from HexTileDefinitions
   * Two tiles are compatible if their edge types AND levels match
   * Only builds byEdge index - propagation uses this directly (O(n) instead of O(n²))
   */
  static fromTileDefinitions(tileTypes = null, maxLevel = 1) {
    const rules = new HexWFCAdjacencyRules()

    // Use provided tile types or all defined types
    const types = tileTypes ?? Object.keys(HexTileDefinitions).map(Number)

    // Generate all (type, rotation, level) combinations
    const allStates = []
    for (const type of types) {
      const def = HexTileDefinitions[type]
      if (!def) continue

      const isSlope = def.highEdges && def.highEdges.length > 0

      for (let rotation = 0; rotation < 6; rotation++) {
        if (isSlope) {
          // Slopes connect level N to N+1
          for (let level = 0; level < maxLevel; level++) {
            allStates.push({ type, rotation, level })
          }
        } else {
          // Flat tiles at all levels
          for (let level = 0; level <= maxLevel; level++) {
            allStates.push({ type, rotation, level })
          }
        }
      }
    }

    // Build 3D edge index: byEdge[edgeType][dir][level] = Set<stateKey>
    // This enables O(1) lookup during propagation (no filtering loop needed)
    // stateEdges: stateKey → { dir: { type, level } }
    for (const state of allStates) {
      const stateKey = HexWFCCell.stateKey(state)
      const edges = rotateHexEdges(HexTileDefinitions[state.type].edges, state.rotation)
      const stateEdgeInfo = {}

      for (const dir of HexDir) {
        const edgeType = edges[dir]
        const edgeLevel = getEdgeLevel(state.type, state.rotation, dir, state.level)
        stateEdgeInfo[dir] = { type: edgeType, level: edgeLevel }

        // Build 3D index: edgeType → dir → level → Set<stateKey>
        if (!rules.byEdge.has(edgeType)) {
          rules.byEdge.set(edgeType, {})
          for (const d of HexDir) rules.byEdge.get(edgeType)[d] = []  // Array indexed by level
        }
        const levelIndex = rules.byEdge.get(edgeType)[dir]
        if (!levelIndex[edgeLevel]) {
          levelIndex[edgeLevel] = new Set()
        }
        levelIndex[edgeLevel].add(stateKey)
      }

      rules.stateEdges.set(stateKey, stateEdgeInfo)
    }

    return rules
  }

  getAllowed(stateKey, direction) {
    return this.allowed.get(stateKey)?.[direction] ?? new Set()
  }

  /**
   * Get states that have a specific edge type, direction, AND level
   * O(1) lookup - used for fast constraint propagation
   */
  getByEdge(edgeType, direction, level) {
    return this.byEdge.get(edgeType)?.[direction]?.[level] ?? new Set()
  }

  isAllowed(stateKeyA, direction, stateKeyB) {
    return this.allowed.get(stateKeyA)?.[direction]?.has(stateKeyB) ?? false
  }
}

/**
 * HexWFCSolver - Wave Function Collapse for hex grids
 * Uses precomputed neighbor relationships instead of offset calculations
 */
export class HexWFCSolver {
  constructor(width, height, rules, options = {}) {
    this.width = width
    this.height = height
    this.rules = rules

    this.options = {
      weights: options.weights ?? {},
      seed: options.seed ?? null,
      maxRestarts: options.maxRestarts ?? 10,
      tileTypes: options.tileTypes ?? null,  // Restrict to certain tile types
      maxLevel: options.maxLevel ?? 1,  // Maximum elevation level
      ...options
    }

    // Seeded RNG or Math.random
    this.rng = this.options.seed !== null
      ? this.createSeededRNG(this.options.seed)
      : Math.random.bind(Math)

    this.grid = []
    this.neighbors = []  // Precomputed neighbor relationships
    this.propagationStack = []
    this.restartCount = 0
    this.collapseOrder = []  // Track order of tile placements for visualization
  }

  /**
   * Initialize grid with all possibilities and precompute neighbors
   */
  init() {
    this.collapseOrder = []  // Reset on each attempt
    // Get tile types to use
    const types = this.options.tileTypes ?? Object.keys(HexTileDefinitions).map(Number)
    const maxLevel = this.options.maxLevel

    // Generate all states (type × 6 rotations × levels)
    const allStates = []
    for (const type of types) {
      const def = HexTileDefinitions[type]
      if (!def) continue

      const isSlope = def.highEdges && def.highEdges.length > 0

      for (let rotation = 0; rotation < 6; rotation++) {
        if (isSlope) {
          // Slopes connect level N to N+1
          for (let level = 0; level < maxLevel; level++) {
            allStates.push({ type, rotation, level })
          }
        } else {
          // Flat tiles at all levels
          for (let level = 0; level <= maxLevel; level++) {
            allStates.push({ type, rotation, level })
          }
        }
      }
    }

    this.grid = []
    this.neighbors = []
    for (let x = 0; x < this.width; x++) {
      this.grid[x] = []
      this.neighbors[x] = []
      for (let z = 0; z < this.height; z++) {
        this.grid[x][z] = new HexWFCCell(allStates)
        // Precompute neighbors for this cell
        this.neighbors[x][z] = this.computeNeighbors(x, z)
      }
    }

    this.propagationStack = []
  }

  /**
   * Precompute neighbors for a cell at (x, z)
   * Returns array of { dir, returnDir, nx, nz } for each valid neighbor
   * - dir: direction from this cell to neighbor (edge of THIS cell that faces neighbor)
   * - returnDir: direction from neighbor to this cell (edge of NEIGHBOR that faces us)
   * - nx, nz: neighbor grid coordinates
   */
  computeNeighbors(x, z) {
    const neighbors = []

    for (const dir of HexDir) {
      const offset = getHexNeighborOffset(x, z, dir)
      const nx = x + offset.dx
      const nz = z + offset.dz

      // Skip out of bounds
      if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue

      // Compute the return direction: which direction from neighbor reaches us?
      const returnDir = this.findReturnDirection(x, z, nx, nz)

      neighbors.push({ dir, returnDir, nx, nz })
    }

    return neighbors
  }

  /**
   * Find which direction from (nx, nz) leads back to (x, z)
   */
  findReturnDirection(x, z, nx, nz) {
    for (const dir of HexDir) {
      const offset = getHexNeighborOffset(nx, nz, dir)
      if (nx + offset.dx === x && nz + offset.dz === z) {
        return dir
      }
    }
    // Fallback to geometric opposite (shouldn't happen)
    return HexOpposite[HexDir[0]]
  }

  /**
   * Find cell with lowest entropy
   */
  findLowestEntropyCell() {
    let minEntropy = Infinity
    let minCell = null
    let minX = -1, minZ = -1

    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.height; z++) {
        const cell = this.grid[x][z]
        if (!cell.collapsed && cell.possibilities.size > 0) {
          const entropy = cell.entropy
          if (entropy < minEntropy) {
            minEntropy = entropy
            minCell = cell
            minX = x
            minZ = z
          }
        }
      }
    }

    return minCell ? { cell: minCell, x: minX, z: minZ } : null
  }

  /**
   * Collapse a cell to a single state (weighted random)
   */
  collapse(x, z) {
    const cell = this.grid[x][z]
    if (cell.collapsed || cell.possibilities.size === 0) return false

    // Weighted random selection
    const possArray = Array.from(cell.possibilities)
    const weights = possArray.map(key => {
      const state = HexWFCCell.parseKey(key)
      // Use custom weight or default from tile definition
      const customWeight = this.options.weights[state.type]
      const defaultWeight = HexTileDefinitions[state.type]?.weight ?? 1
      return customWeight ?? defaultWeight
    })
    const totalWeight = weights.reduce((a, b) => a + b, 0)

    let roll = this.rng() * totalWeight
    let selectedKey = possArray[possArray.length - 1]
    for (let i = 0; i < possArray.length; i++) {
      roll -= weights[i]
      if (roll <= 0) {
        selectedKey = possArray[i]
        break
      }
    }

    const state = HexWFCCell.parseKey(selectedKey)
    cell.collapse(state)
    this.propagationStack.push({ x, z })

    // Record collapse order for visualization (includes level)
    this.collapseOrder.push({ gridX: x, gridZ: z, type: state.type, rotation: state.rotation, level: state.level })

    return true
  }

  /**
   * Propagate constraints to neighbors using precomputed neighbor relationships
   * @returns {boolean} true if successful, false if contradiction
   */
  propagate() {
    while (this.propagationStack.length > 0) {
      const { x, z } = this.propagationStack.pop()
      const cell = this.grid[x][z]

      // Use precomputed neighbors
      for (const { dir, returnDir, nx, nz } of this.neighbors[x][z]) {
        const neighbor = this.grid[nx][nz]
        if (neighbor.collapsed) continue

        // Calculate what neighbor can still be
        // Cache lookups by (edgeType, level) to avoid redundant work
        // Many possibilities share the same edge - only look up unique combinations
        const allowedInNeighbor = new Set()
        const lookedUp = {}  // Nested object: lookedUp[type][level] = true

        for (const stateKey of cell.possibilities) {
          const edgeInfo = this.rules.stateEdges.get(stateKey)?.[dir]
          if (!edgeInfo) continue

          // Skip if we already looked up this edge type + level combination
          const typeCache = lookedUp[edgeInfo.type]
          if (typeCache?.[edgeInfo.level]) continue
          if (!typeCache) lookedUp[edgeInfo.type] = {}
          lookedUp[edgeInfo.type][edgeInfo.level] = true

          // Direct O(1) lookup - index already filtered by type, direction, AND level
          const candidates = this.rules.getByEdge(edgeInfo.type, returnDir, edgeInfo.level)
          for (const key of candidates) {
            allowedInNeighbor.add(key)
          }
        }

        // Early exit: if allowed set covers all neighbor possibilities, nothing to remove
        if (allowedInNeighbor.size >= neighbor.possibilities.size) {
          let allAllowed = true
          for (const key of neighbor.possibilities) {
            if (!allowedInNeighbor.has(key)) {
              allAllowed = false
              break
            }
          }
          if (allAllowed) continue
        }

        // Remove invalid possibilities directly (safe to delete during Set iteration)
        const sizeBefore = neighbor.possibilities.size
        for (const neighborKey of neighbor.possibilities) {
          if (!allowedInNeighbor.has(neighborKey)) {
            neighbor.possibilities.delete(neighborKey)
          }
        }

        // Contradiction: no possibilities left
        if (neighbor.possibilities.size === 0) {
          return false
        }

        // If changed, propagate further
        if (neighbor.possibilities.size < sizeBefore) {
          this.propagationStack.push({ x: nx, z: nz })
        }
      }
    }

    return true
  }

  /**
   * Main solve loop
   * @returns {Array|null} Array of { gridX, gridZ, type, rotation, level } or null on failure
   */
  solve(seedTiles = []) {
    this.init()

    // Pre-collapse seeded tiles
    for (const seed of seedTiles) {
      const cell = this.grid[seed.x]?.[seed.z]
      if (cell && !cell.collapsed) {
        const state = { type: seed.type, rotation: seed.rotation ?? 0, level: seed.level ?? 0 }
        cell.collapse(state)
        this.collapseOrder.push({ gridX: seed.x, gridZ: seed.z, type: state.type, rotation: state.rotation, level: state.level })
        this.propagationStack.push({ x: seed.x, z: seed.z })
      }
    }
    // Propagate seed constraints
    if (seedTiles.length > 0 && !this.propagate()) {
      console.warn('HexWFC: seed tiles caused contradiction')
      return null
    }

    while (true) {
      const target = this.findLowestEntropyCell()

      // All collapsed - success!
      if (!target) {
        return this.extractResult()
      }

      // Collapse the cell
      if (!this.collapse(target.x, target.z)) {
        return null
      }

      // Propagate constraints
      if (!this.propagate()) {
        // Contradiction - restart
        this.restartCount++
        if (this.restartCount >= this.options.maxRestarts) {
          console.warn(`HexWFC: max restarts (${this.options.maxRestarts}) reached`)
          return null
        }
        this.init()
      }
    }
  }

  /**
   * Extract result from collapsed grid
   */
  extractResult() {
    const result = []
    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.height; z++) {
        const cell = this.grid[x][z]
        if (cell.tile) {
          result.push({
            gridX: x,
            gridZ: z,
            type: cell.tile.type,
            rotation: cell.tile.rotation,
            level: cell.tile.level,
          })
        }
      }
    }
    return result
  }

  /**
   * Mulberry32 seeded PRNG
   */
  createSeededRNG(seed) {
    let s = seed
    return () => {
      s |= 0
      s = s + 0x6D2B79F5 | 0
      let t = Math.imul(s ^ s >>> 15, 1 | s)
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
      return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
  }
}
