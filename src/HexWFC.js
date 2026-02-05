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
 * HexWFCCell - Tracks possibility space for one hex grid cell
 */
export class HexWFCCell {
  constructor(allStates) {
    // Each state is { type, rotation } - store as "type_rotation" keys
    this.possibilities = new Set(allStates.map(s => HexWFCCell.stateKey(s)))
    this.collapsed = false
    this.tile = null  // { type, rotation } when collapsed
  }

  static stateKey(state) {
    return `${state.type}_${state.rotation}`
  }

  static parseKey(key) {
    const [type, rotation] = key.split('_').map(Number)
    return { type, rotation }
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
    // For each state, what states can be placed in each direction
    // Map<stateKey, { N, NE, SE, S, SW, NW: Set<stateKey> }>
    this.allowed = new Map()

    // Index by edge type and direction: edgeType → dir → Set<stateKey>
    // Used for position-aware constraint lookup
    this.byEdge = new Map()
  }

  /**
   * Build adjacency rules from HexTileDefinitions
   * Two tiles are compatible if their edge types match
   */
  static fromTileDefinitions(tileTypes = null) {
    const rules = new HexWFCAdjacencyRules()

    // Use provided tile types or all defined types
    const types = tileTypes ?? Object.keys(HexTileDefinitions).map(Number)

    // Generate all (type, rotation) combinations
    // Hex tiles have 6 rotations (0-5, each 60°)
    const allStates = []
    for (const type of types) {
      if (HexTileDefinitions[type]) {
        for (let rotation = 0; rotation < 6; rotation++) {
          allStates.push({ type, rotation })
        }
      }
    }

    // Build edge type index: for each (edgeType, direction), which states have that edge type?
    for (const state of allStates) {
      const key = HexWFCCell.stateKey(state)
      const edges = rotateHexEdges(HexTileDefinitions[state.type].edges, state.rotation)

      for (const dir of HexDir) {
        const edgeType = edges[dir]
        if (!rules.byEdge.has(edgeType)) {
          rules.byEdge.set(edgeType, {})
          for (const d of HexDir) rules.byEdge.get(edgeType)[d] = new Set()
        }
        rules.byEdge.get(edgeType)[dir].add(key)
      }
    }

    // For each state pair, check if they're compatible in each direction
    // Using geometric opposites for the base rules
    for (const stateA of allStates) {
      const keyA = HexWFCCell.stateKey(stateA)
      const edgesA = rotateHexEdges(HexTileDefinitions[stateA.type].edges, stateA.rotation)

      const allowed = {}
      for (const dir of HexDir) {
        allowed[dir] = new Set()
      }

      for (const dir of HexDir) {
        const oppDir = HexOpposite[dir]

        for (const stateB of allStates) {
          const keyB = HexWFCCell.stateKey(stateB)
          const edgesB = rotateHexEdges(HexTileDefinitions[stateB.type].edges, stateB.rotation)

          // Compatible if edge types match
          if (edgesA[dir] === edgesB[oppDir]) {
            allowed[dir].add(keyB)
          }
        }
      }

      rules.allowed.set(keyA, allowed)
    }

    return rules
  }

  getAllowed(stateKey, direction) {
    return this.allowed.get(stateKey)?.[direction] ?? new Set()
  }

  /**
   * Get states that have a specific edge type in a specific direction
   * Used for position-aware constraint propagation
   */
  getByEdge(edgeType, direction) {
    return this.byEdge.get(edgeType)?.[direction] ?? new Set()
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

    // Generate all states (type × 6 rotations)
    const allStates = []
    for (const type of types) {
      if (HexTileDefinitions[type]) {
        for (let rotation = 0; rotation < 6; rotation++) {
          allStates.push({ type, rotation })
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

    // Record collapse order for visualization
    this.collapseOrder.push({ gridX: x, gridZ: z, type: state.type, rotation: state.rotation })

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
        // Our edge 'dir' faces neighbor, neighbor's edge 'returnDir' faces us
        // So we need tiles where neighbor's returnDir edge matches our dir edge
        const allowedInNeighbor = new Set()
        for (const stateKey of cell.possibilities) {
          const state = HexWFCCell.parseKey(stateKey)
          const edges = rotateHexEdges(HexTileDefinitions[state.type].edges, state.rotation)
          const ourEdgeType = edges[dir]

          // Find all tiles whose returnDir edge matches ourEdgeType
          const compatible = this.rules.getByEdge(ourEdgeType, returnDir)
          for (const allowedKey of compatible) {
            allowedInNeighbor.add(allowedKey)
          }
        }

        // Remove invalid possibilities from neighbor
        let changed = false
        const toRemove = []
        for (const neighborKey of neighbor.possibilities) {
          if (!allowedInNeighbor.has(neighborKey)) {
            toRemove.push(neighborKey)
          }
        }

        for (const key of toRemove) {
          neighbor.remove(key)
          changed = true
        }

        // Contradiction: no possibilities left
        if (neighbor.possibilities.size === 0) {
          return false
        }

        // If changed, propagate further
        if (changed) {
          this.propagationStack.push({ x: nx, z: nz })
        }
      }
    }

    return true
  }

  /**
   * Main solve loop
   * @returns {Array|null} Array of { gridX, gridZ, type, rotation } or null on failure
   */
  solve(seedTiles = []) {
    this.init()

    // Pre-collapse seeded tiles
    for (const seed of seedTiles) {
      const cell = this.grid[seed.x]?.[seed.z]
      if (cell && !cell.collapsed) {
        const state = { type: seed.type, rotation: seed.rotation ?? 0 }
        cell.collapse(state)
        this.collapseOrder.push({ gridX: seed.x, gridZ: seed.z, type: state.type, rotation: state.rotation })
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
