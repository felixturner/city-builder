/**
 * WFC Web Worker
 * Runs WFC solver in a separate thread to prevent UI freezing
 */

// ============================================================================
// Inline SeededRandom (from SeededRandom.js)
// ============================================================================

let rng = Math.random
let currentSeed = null

function setSeed(seed) {
  currentSeed = seed
  if (seed === null) {
    rng = Math.random
  } else {
    // Mulberry32 seeded PRNG
    let s = seed
    rng = () => {
      s |= 0
      s = s + 0x6D2B79F5 | 0
      let t = Math.imul(s ^ s >>> 15, 1 | s)
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
      return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
  }
}

function random() {
  return rng()
}

// ============================================================================
// Inline HexTiles definitions (from HexTiles.js)
// ============================================================================

const HexTileType = {
  GRASS: 0, WATER: 1,
  ROAD_A: 10, ROAD_B: 11, ROAD_C: 12, ROAD_D: 13, ROAD_E: 14, ROAD_F: 15,
  ROAD_G: 16, ROAD_H: 17, ROAD_I: 18, ROAD_J: 19, ROAD_K: 20, ROAD_L: 21, ROAD_M: 22,
  RIVER_A: 30, RIVER_A_CURVY: 31, RIVER_B: 32, RIVER_C: 33, RIVER_D: 34, RIVER_E: 35,
  RIVER_F: 36, RIVER_G: 37, RIVER_H: 38, RIVER_I: 39, RIVER_J: 40, RIVER_K: 41,
  RIVER_L: 42, RIVER_M: 43,
  COAST_A: 50, COAST_B: 51, COAST_C: 52, COAST_D: 53, COAST_E: 54,
  RIVER_CROSSING_A: 60, RIVER_CROSSING_B: 61,
  GRASS_SLOPE_HIGH: 70, ROAD_A_SLOPE_HIGH: 71, GRASS_CLIFF: 72, GRASS_CLIFF_B: 73,
  GRASS_CLIFF_C: 74, GRASS_SLOPE_LOW: 75, ROAD_A_SLOPE_LOW: 76, GRASS_CLIFF_LOW: 77,
  GRASS_CLIFF_LOW_B: 78, GRASS_CLIFF_LOW_C: 79,
}

const HexDir = ['NE', 'E', 'SE', 'SW', 'W', 'NW']

const HexOpposite = {
  NE: 'SW', E: 'W', SE: 'NW', SW: 'NE', W: 'E', NW: 'SE',
}

const HexNeighborOffsets = {
  even: {
    NE: { dx: 0, dz: -1 }, E: { dx: 1, dz: 0 }, SE: { dx: 0, dz: 1 },
    SW: { dx: -1, dz: 1 }, W: { dx: -1, dz: 0 }, NW: { dx: -1, dz: -1 },
  },
  odd: {
    NE: { dx: 1, dz: -1 }, E: { dx: 1, dz: 0 }, SE: { dx: 1, dz: 1 },
    SW: { dx: 0, dz: 1 }, W: { dx: -1, dz: 0 }, NW: { dx: 0, dz: -1 },
  },
}

function getHexNeighborOffset(x, z, dir) {
  const parity = (z % 2 === 0) ? 'even' : 'odd'
  return HexNeighborOffsets[parity][dir]
}

function rotateHexEdges(edges, rotation) {
  const rotated = {}
  for (let i = 0; i < 6; i++) {
    const fromDir = HexDir[i]
    const toDir = HexDir[(i + rotation) % 6]
    rotated[toDir] = edges[fromDir]
  }
  return rotated
}

const HexTileDefinitions = {
  [HexTileType.GRASS]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 300 },
  [HexTileType.WATER]: { edges: { NE: 'ocean', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'ocean', NW: 'ocean' }, weight: 50 },
  [HexTileType.ROAD_A]: { edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' }, weight: 10 },
  [HexTileType.ROAD_B]: { edges: { NE: 'road', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' }, weight: 8 },
  [HexTileType.ROAD_C]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'road' }, weight: 1 },
  [HexTileType.ROAD_D]: { edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'grass', W: 'road', NW: 'grass' }, weight: 2 },
  [HexTileType.ROAD_E]: { edges: { NE: 'road', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' }, weight: 2 },
  [HexTileType.ROAD_F]: { edges: { NE: 'grass', E: 'road', SE: 'road', SW: 'grass', W: 'road', NW: 'grass' }, weight: 2 },
  [HexTileType.ROAD_G]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'road', W: 'road', NW: 'road' }, weight: 2 },
  [HexTileType.ROAD_H]: { edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'road', W: 'road', NW: 'road' }, weight: 2 },
  [HexTileType.ROAD_I]: { edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'road', W: 'grass', NW: 'road' }, weight: 2 },
  [HexTileType.ROAD_J]: { edges: { NE: 'grass', E: 'road', SE: 'road', SW: 'road', W: 'road', NW: 'grass' }, weight: 1 },
  [HexTileType.ROAD_K]: { edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'road', W: 'road', NW: 'road' }, weight: 1 },
  [HexTileType.ROAD_L]: { edges: { NE: 'road', E: 'road', SE: 'road', SW: 'road', W: 'road', NW: 'road' }, weight: 1 },
  [HexTileType.ROAD_M]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' }, weight: 4 },
  [HexTileType.RIVER_A]: { edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' }, weight: 20 },
  [HexTileType.RIVER_A_CURVY]: { edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' }, weight: 20 },
  [HexTileType.RIVER_B]: { edges: { NE: 'river', E: 'grass', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' }, weight: 60 },
  [HexTileType.RIVER_C]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'river', NW: 'river' }, weight: 8 },
  [HexTileType.RIVER_D]: { edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'grass', W: 'river', NW: 'grass' }, weight: 4 },
  [HexTileType.RIVER_E]: { edges: { NE: 'river', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' }, weight: 4 },
  [HexTileType.RIVER_F]: { edges: { NE: 'grass', E: 'river', SE: 'river', SW: 'grass', W: 'river', NW: 'grass' }, weight: 4 },
  [HexTileType.RIVER_G]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'river', W: 'river', NW: 'river' }, weight: 4 },
  [HexTileType.RIVER_H]: { edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'river', W: 'river', NW: 'river' }, weight: 2 },
  [HexTileType.RIVER_I]: { edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'river', W: 'grass', NW: 'river' }, weight: 2 },
  [HexTileType.RIVER_J]: { edges: { NE: 'grass', E: 'river', SE: 'river', SW: 'river', W: 'river', NW: 'grass' }, weight: 2 },
  [HexTileType.RIVER_K]: { edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'river', W: 'river', NW: 'river' }, weight: 2 },
  [HexTileType.RIVER_L]: { edges: { NE: 'river', E: 'river', SE: 'river', SW: 'river', W: 'river', NW: 'river' }, weight: 2 },
  [HexTileType.RIVER_M]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' }, weight: 8 },
  [HexTileType.COAST_A]: { edges: { NE: 'grass', E: 'coast', SE: 'ocean', SW: 'coast', W: 'grass', NW: 'grass' }, weight: 20 },
  [HexTileType.COAST_B]: { edges: { NE: 'grass', E: 'coast', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'grass' }, weight: 15 },
  [HexTileType.COAST_C]: { edges: { NE: 'coast', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'grass' }, weight: 15 },
  [HexTileType.COAST_D]: { edges: { NE: 'ocean', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'coast' }, weight: 15 },
  [HexTileType.COAST_E]: { edges: { NE: 'grass', E: 'grass', SE: 'coast', SW: 'coast', W: 'grass', NW: 'grass' }, weight: 10 },
  [HexTileType.RIVER_CROSSING_A]: { edges: { NE: 'grass', E: 'river', SE: 'road', SW: 'grass', W: 'river', NW: 'road' }, weight: 4 },
  [HexTileType.RIVER_CROSSING_B]: { edges: { NE: 'road', E: 'river', SE: 'grass', SW: 'road', W: 'river', NW: 'grass' }, weight: 4 },
  [HexTileType.GRASS_SLOPE_HIGH]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 100, highEdges: ['NE', 'E', 'SE'], levelIncrement: 2 },
  [HexTileType.ROAD_A_SLOPE_HIGH]: { edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' }, weight: 60, highEdges: ['NE', 'E', 'SE'], levelIncrement: 2 },
  [HexTileType.GRASS_CLIFF]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 30, highEdges: ['NE', 'E', 'SE'], levelIncrement: 2 },
  [HexTileType.GRASS_CLIFF_B]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 30, highEdges: ['NE', 'E', 'SE', 'SW'], levelIncrement: 2 },
  [HexTileType.GRASS_CLIFF_C]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 30, highEdges: ['E'], levelIncrement: 2 },
  [HexTileType.GRASS_SLOPE_LOW]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 100, highEdges: ['NE', 'E', 'SE'], levelIncrement: 1 },
  [HexTileType.ROAD_A_SLOPE_LOW]: { edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' }, weight: 60, highEdges: ['NE', 'E', 'SE'], levelIncrement: 1 },
  [HexTileType.GRASS_CLIFF_LOW]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 30, highEdges: ['NE', 'E', 'SE'], levelIncrement: 1 },
  [HexTileType.GRASS_CLIFF_LOW_B]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 30, highEdges: ['NE', 'E', 'SE', 'SW'], levelIncrement: 1 },
  [HexTileType.GRASS_CLIFF_LOW_C]: { edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' }, weight: 30, highEdges: ['E'], levelIncrement: 1 },
}

// ============================================================================
// Coordinate conversion (from HexGridConnector.js)
// ============================================================================

function offsetToCube(col, row) {
  const q = col - Math.floor(row / 2)
  const r = row
  const s = -q - r
  return { q, r, s }
}

function cubeToOffset(q, r, _s) {
  const col = q + Math.floor(r / 2)
  const row = r
  return { col, row }
}

// ============================================================================
// WFC Classes (from HexWFC.js)
// ============================================================================

// Cache for rotated high edges
const highEdgeCache = new Map()

function getEdgeLevel(tileType, rotation, dir, baseLevel) {
  const def = HexTileDefinitions[tileType]
  if (!def || !def.highEdges) {
    return baseLevel
  }

  const cacheKey = `${tileType}_${rotation}`
  let highEdges = highEdgeCache.get(cacheKey)

  if (!highEdges) {
    highEdges = new Set()
    for (const highDir of def.highEdges) {
      const dirIndex = HexDir.indexOf(highDir)
      const rotatedIndex = (dirIndex + rotation) % 6
      highEdges.add(HexDir[rotatedIndex])
    }
    highEdgeCache.set(cacheKey, highEdges)
  }

  const levelIncrement = def.levelIncrement ?? 1
  return highEdges.has(dir) ? baseLevel + levelIncrement : baseLevel
}

class HexWFCCell {
  constructor(allStates) {
    this.possibilities = new Set(allStates.map(s => HexWFCCell.stateKey(s)))
    this.collapsed = false
    this.tile = null
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
    return Math.log(this.possibilities.size) + random() * 0.001
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

class HexWFCAdjacencyRules {
  constructor() {
    this.allowed = new Map()
    this.stateEdges = new Map()
    this.byEdge = new Map()
  }

  static fromTileDefinitions(tileTypes = null, levelsCount = 2) {
    const rules = new HexWFCAdjacencyRules()
    const types = tileTypes ?? Object.keys(HexTileDefinitions).map(Number)

    const allStates = []
    for (const type of types) {
      const def = HexTileDefinitions[type]
      if (!def) continue

      const isSlope = def.highEdges && def.highEdges.length > 0

      for (let rotation = 0; rotation < 6; rotation++) {
        if (isSlope) {
          const increment = def.levelIncrement ?? 1
          const maxBaseLevel = levelsCount - 1 - increment
          for (let level = 0; level <= maxBaseLevel; level++) {
            allStates.push({ type, rotation, level })
          }
        } else {
          for (let level = 0; level < levelsCount; level++) {
            allStates.push({ type, rotation, level })
          }
        }
      }
    }

    for (const state of allStates) {
      const stateKey = HexWFCCell.stateKey(state)
      const edges = rotateHexEdges(HexTileDefinitions[state.type].edges, state.rotation)
      const stateEdgeInfo = {}

      for (const dir of HexDir) {
        const edgeType = edges[dir]
        const edgeLevel = getEdgeLevel(state.type, state.rotation, dir, state.level)
        stateEdgeInfo[dir] = { type: edgeType, level: edgeLevel }

        if (!rules.byEdge.has(edgeType)) {
          rules.byEdge.set(edgeType, {})
          for (const d of HexDir) rules.byEdge.get(edgeType)[d] = []
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

  getByEdge(edgeType, direction, level) {
    return this.byEdge.get(edgeType)?.[direction]?.[level] ?? new Set()
  }
}

class HexWFCSolver {
  constructor(width, height, rules, options = {}) {
    this.width = width
    this.height = height
    this.rules = rules

    this.options = {
      weights: options.weights ?? {},
      seed: options.seed ?? null,
      maxRestarts: options.maxRestarts ?? 10,
      tileTypes: options.tileTypes ?? null,
      levelsCount: options.levelsCount ?? 2,
      padding: options.padding ?? 0,
      gridRadius: options.gridRadius ?? 0,
      worldOffset: options.worldOffset ?? { x: 0, z: 0 },
      log: options.log ?? ((msg) => postMessage({ type: 'log', message: msg })),
      ...options
    }

    this.grid = []
    this.neighbors = []
    this.propagationStack = []
    this.restartCount = 0
    this.collapseOrder = []
    this.lastContradiction = null
  }

  log(message) {
    this.options.log(message)
  }

  toGlobalCoords(x, z) {
    const { padding, gridRadius, globalCenterCube } = this.options
    const localCol = x - padding - gridRadius
    const localRow = z - padding - gridRadius
    const localCube = offsetToCube(localCol, localRow)
    const globalCube = {
      q: localCube.q + globalCenterCube.q,
      r: localCube.r + globalCenterCube.r,
      s: localCube.s + globalCenterCube.s
    }
    return cubeToOffset(globalCube.q, globalCube.r, globalCube.s)
  }

  init() {
    this.collapseOrder = []
    const types = this.options.tileTypes ?? Object.keys(HexTileDefinitions).map(Number)
    const levelsCount = this.options.levelsCount

    const allStates = []
    for (const type of types) {
      const def = HexTileDefinitions[type]
      if (!def) continue

      const isSlope = def.highEdges && def.highEdges.length > 0

      for (let rotation = 0; rotation < 6; rotation++) {
        if (isSlope) {
          const increment = def.levelIncrement ?? 1
          const maxBaseLevel = levelsCount - 1 - increment
          for (let level = 0; level <= maxBaseLevel; level++) {
            allStates.push({ type, rotation, level })
          }
        } else {
          for (let level = 0; level < levelsCount; level++) {
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
        this.neighbors[x][z] = this.computeNeighbors(x, z)
      }
    }

    this.propagationStack = []
  }

  computeNeighbors(x, z) {
    const neighbors = []

    for (const dir of HexDir) {
      const offset = getHexNeighborOffset(x, z, dir)
      const nx = x + offset.dx
      const nz = z + offset.dz

      if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue

      const returnDir = this.findReturnDirection(x, z, nx, nz)
      neighbors.push({ dir, returnDir, nx, nz })
    }

    return neighbors
  }

  findReturnDirection(x, z, nx, nz) {
    for (const dir of HexDir) {
      const offset = getHexNeighborOffset(nx, nz, dir)
      if (nx + offset.dx === x && nz + offset.dz === z) {
        return dir
      }
    }
    return HexOpposite[HexDir[0]]
  }

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

  collapse(x, z) {
    const cell = this.grid[x][z]
    if (cell.collapsed || cell.possibilities.size === 0) return false

    const possArray = Array.from(cell.possibilities)
    const weights = possArray.map(key => {
      const state = HexWFCCell.parseKey(key)
      const customWeight = this.options.weights[state.type]
      const defaultWeight = HexTileDefinitions[state.type]?.weight ?? 1
      return customWeight ?? defaultWeight
    })
    const totalWeight = weights.reduce((a, b) => a + b, 0)

    let roll = random() * totalWeight
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

    this.collapseOrder.push({ gridX: x, gridZ: z, type: state.type, rotation: state.rotation, level: state.level })

    return true
  }

  propagate() {
    while (this.propagationStack.length > 0) {
      const { x, z } = this.propagationStack.pop()
      const cell = this.grid[x][z]

      for (const { dir, returnDir, nx, nz } of this.neighbors[x][z]) {
        const neighbor = this.grid[nx][nz]
        if (neighbor.collapsed) continue

        const allowedInNeighbor = new Set()
        const lookedUp = {}

        for (const stateKey of cell.possibilities) {
          const edgeInfo = this.rules.stateEdges.get(stateKey)?.[dir]
          if (!edgeInfo) continue

          const typeCache = lookedUp[edgeInfo.type]
          if (typeCache?.[edgeInfo.level]) continue
          if (!typeCache) lookedUp[edgeInfo.type] = {}
          lookedUp[edgeInfo.type][edgeInfo.level] = true

          const candidates = this.rules.getByEdge(edgeInfo.type, returnDir, edgeInfo.level)
          for (const key of candidates) {
            allowedInNeighbor.add(key)
          }
        }

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

        const sizeBefore = neighbor.possibilities.size
        for (const neighborKey of neighbor.possibilities) {
          if (!allowedInNeighbor.has(neighborKey)) {
            neighbor.possibilities.delete(neighborKey)
          }
        }

        if (neighbor.possibilities.size === 0) {
          const sourceState = cell.collapsed ? HexWFCCell.parseKey([...cell.possibilities][0]) : null
          this.lastContradiction = {
            sourceX: x, sourceZ: z,
            sourceState,
            failedX: nx, failedZ: nz,
            dir,
            allowedEdges: [...new Set([...cell.possibilities].map(k => {
              const e = this.rules.stateEdges.get(k)?.[dir]
              return e ? `${e.type}@${e.level}` : '?'
            }))],
            lastAllowed: [...allowedInNeighbor].slice(0, 10).map(k => {
              const s = HexWFCCell.parseKey(k)
              const name = Object.entries(HexTileType).find(([, v]) => v === s.type)?.[0] || s.type
              return `${name} r${s.rotation} l${s.level}`
            })
          }
          return false
        }

        if (neighbor.possibilities.size < sizeBefore) {
          this.propagationStack.push({ x: nx, z: nz })
        }
      }
    }

    return true
  }

  solve(seedTiles = [], gridId = '') {
    const baseAttempt = this.options.attemptNum ?? 1
    const tryNum = baseAttempt + this.restartCount
    this.log(`WFC START (try ${tryNum}, ${seedTiles.length} seeds)`)

    this.init()

    for (const seed of seedTiles) {
      const cell = this.grid[seed.x]?.[seed.z]
      if (cell && !cell.collapsed) {
        const state = { type: seed.type, rotation: seed.rotation ?? 0, level: seed.level ?? 0 }
        cell.collapse(state)
        this.collapseOrder.push({ gridX: seed.x, gridZ: seed.z, type: state.type, rotation: state.rotation, level: state.level })
        this.propagationStack.push({ x: seed.x, z: seed.z })
      }
    }

    if (seedTiles.length > 0 && !this.propagate()) {
      this.log('WFC failed - propagation failed after seeding')
      if (this.lastContradiction) {
        const c = this.lastContradiction
        const failG = this.toGlobalCoords(c.failedX, c.failedZ)
        this.log(`  FAILED CELL: (${failG.col},${failG.row})`)
      }
      return null
    }

    while (true) {
      const target = this.findLowestEntropyCell()

      if (!target) {
        return this.extractResult()
      }

      if (!this.collapse(target.x, target.z)) {
        return null
      }

      if (!this.propagate()) {
        this.restartCount++
        this.log(`${gridId} WFC fail (contradiction)`)
        if (this.restartCount >= this.options.maxRestarts) {
          return null
        }
        return this.solve(seedTiles, gridId)
      }
    }
  }

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
}

// ============================================================================
// Worker Message Handler
// ============================================================================

let currentRequestId = null

self.onmessage = function(e) {
  const { type, id, width, height, seeds, options } = e.data

  if (type === 'solve') {
    currentRequestId = id

    // Set seed if provided
    if (options?.seed != null) {
      setSeed(options.seed)
    }

    // Build rules
    const tileTypes = options?.tileTypes ?? null
    const levelsCount = options?.levelsCount ?? 2
    const rules = HexWFCAdjacencyRules.fromTileDefinitions(tileTypes, levelsCount)

    // Create solver with log callback that sends messages to main thread
    const solver = new HexWFCSolver(width, height, rules, {
      ...options,
      log: (message) => {
        postMessage({ type: 'log', id, message })
      }
    })

    // Run solver
    const result = solver.solve(seeds || [], options?.gridId || '')

    // Send result (include lastContradiction for seed dropping on failure)
    postMessage({
      type: 'result',
      id,
      success: result !== null,
      tiles: result,
      collapseOrder: solver.collapseOrder,
      lastContradiction: solver.lastContradiction
    })

    currentRequestId = null
  }
}
