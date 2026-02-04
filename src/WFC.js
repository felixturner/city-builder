import { TileDefinitions, TileType, rotateExits } from './Tiles.js'

/**
 * WFCCell - Tracks possibility space for one grid cell
 */
export class WFCCell {
  constructor(allStates) {
    // Each state is { type, rotation } - store as "type_rotation" keys
    this.possibilities = new Set(allStates.map(s => WFCCell.stateKey(s)))
    this.collapsed = false
    this.tile = null // { type, rotation } when collapsed
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
    // Shannon entropy simplified for uniform weights: log(count)
    // Add small noise for tie-breaking
    return Math.log(this.possibilities.size) + Math.random() * 0.001
  }

  collapse(state) {
    this.possibilities.clear()
    this.possibilities.add(WFCCell.stateKey(state))
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
 * WFCAdjacencyRules - Pre-computed tile compatibility rules
 */
export class WFCAdjacencyRules {
  constructor() {
    // For each state, what states can be placed in each direction
    // Map<stateKey, { N: Set, E: Set, S: Set, W: Set }>
    this.allowed = new Map()
  }

  /**
   * Build adjacency rules from TileDefinitions
   * Two tiles are compatible if their exits match:
   * - If tile A has exit in direction D, tile B must have exit in opposite(D)
   * - If tile A has no exit in D, tile B must have no exit in opposite(D)
   */
  static fromTileDefinitions() {
    const rules = new WFCAdjacencyRules()
    const directions = ['N', 'E', 'S', 'W']
    const opposite = { N: 'S', E: 'W', S: 'N', W: 'E' }

    // Generate all (type, rotation) combinations
    const allStates = []
    for (const typeKey of Object.keys(TileDefinitions)) {
      const type = parseInt(typeKey)
      for (let rotation = 0; rotation < 4; rotation++) {
        allStates.push({ type, rotation })
      }
    }

    // For each state, compute allowed neighbors in each direction
    for (const stateA of allStates) {
      const keyA = WFCCell.stateKey(stateA)
      const exitsA = rotateExits(TileDefinitions[stateA.type].exits, stateA.rotation)

      const allowed = { N: new Set(), E: new Set(), S: new Set(), W: new Set() }

      for (const dir of directions) {
        const oppDir = opposite[dir]

        for (const stateB of allStates) {
          const keyB = WFCCell.stateKey(stateB)
          const exitsB = rotateExits(TileDefinitions[stateB.type].exits, stateB.rotation)

          // Compatible if: A's exit in dir matches B's exit in opposite dir
          // (both have exit, or both don't have exit)
          if (exitsA[dir] === exitsB[oppDir]) {
            allowed[dir].add(keyB)
          }
        }
      }

      rules.allowed.set(keyA, allowed)
    }

    return rules
  }

  /**
   * Get all states allowed in direction from stateKey
   */
  getAllowed(stateKey, direction) {
    return this.allowed.get(stateKey)?.[direction] ?? new Set()
  }

  /**
   * Check if stateA allows stateB in direction
   */
  isAllowed(stateKeyA, direction, stateKeyB) {
    return this.allowed.get(stateKeyA)?.[direction]?.has(stateKeyB) ?? false
  }
}

/**
 * WFCSolver - Wave Function Collapse algorithm
 */
export class WFCSolver {
  constructor(width, height, rules, options = {}) {
    this.width = width
    this.height = height
    this.rules = rules

    this.options = {
      weights: options.weights ?? {},
      seed: options.seed ?? null,
      maxRestarts: options.maxRestarts ?? 10,
      ...options
    }

    // Seeded RNG or Math.random
    this.rng = this.options.seed !== null
      ? this.createSeededRNG(this.options.seed)
      : Math.random.bind(Math)

    this.grid = []
    this.propagationStack = []
    this.restartCount = 0
  }

  /**
   * Initialize grid with all possibilities
   */
  init() {
    // Generate all states
    const allStates = []
    for (const typeKey of Object.keys(TileDefinitions)) {
      const type = parseInt(typeKey)
      for (let rotation = 0; rotation < 4; rotation++) {
        allStates.push({ type, rotation })
      }
    }

    this.grid = []
    for (let x = 0; x < this.width; x++) {
      this.grid[x] = []
      for (let z = 0; z < this.height; z++) {
        this.grid[x][z] = new WFCCell(allStates)
      }
    }

    this.propagationStack = []
  }

  /**
   * Find cell with lowest entropy (most constrained)
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
      const state = WFCCell.parseKey(key)
      return this.options.weights[state.type] ?? 1
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

    cell.collapse(WFCCell.parseKey(selectedKey))
    this.propagationStack.push({ x, z })

    return true
  }

  /**
   * Propagate constraints to neighbors
   * @returns {boolean} true if successful, false if contradiction
   */
  propagate() {
    const directions = [
      { dir: 'N', dx: 0, dz: -1 },
      { dir: 'E', dx: 1, dz: 0 },
      { dir: 'S', dx: 0, dz: 1 },
      { dir: 'W', dx: -1, dz: 0 },
    ]

    while (this.propagationStack.length > 0) {
      const { x, z } = this.propagationStack.pop()
      const cell = this.grid[x][z]

      for (const { dir, dx, dz } of directions) {
        const nx = x + dx
        const nz = z + dz

        // Skip out of bounds
        if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue

        const neighbor = this.grid[nx][nz]
        if (neighbor.collapsed) continue

        // Calculate what neighbor can still be
        const allowedInNeighbor = new Set()
        for (const stateKey of cell.possibilities) {
          const allowed = this.rules.getAllowed(stateKey, dir)
          for (const allowedKey of allowed) {
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
  solve() {
    this.init()

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
          console.warn(`WFC: max restarts (${this.options.maxRestarts}) reached`)
          return null
        }
        console.log(`WFC: contradiction, restarting (${this.restartCount}/${this.options.maxRestarts})`)
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
