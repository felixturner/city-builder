/**
 * WFC Web Worker
 * Runs WFC solver in a separate thread to prevent UI freezing
 */

// Import from pure data module (no browser dependencies)
import {
  TILE_LIST,
  HexDir,
  HexOpposite,
  getHexNeighborOffset,
  rotateHexEdges,
  LEVELS_COUNT,
} from '../HexTileData.js'

import { setSeed, random } from '../SeededRandom.js'

// ============================================================================
// Coordinate conversion (inlined - small functions, avoid import chain)
// ============================================================================

function offsetToCube(col, row) {
  const q = col - Math.floor(row / 2)
  const r = row
  const s = -q - r
  return { q, r, s }
}

function cubeToOffset(q, r, s) {
  const col = q + Math.floor(r / 2)
  const row = r
  return { col, row }
}

// ============================================================================
// Edge level calculation (inlined to avoid importing HexWFC.js which has browser dependencies)
// ============================================================================

// Cache for rotated high edges: Map<"type_rotation", Set<dir>>
const highEdgeCache = new Map()

/**
 * Get the level for a specific edge of a tile
 * Slopes have different levels on high vs low edges
 */
function getEdgeLevel(tileType, rotation, dir, baseLevel) {
  const def = TILE_LIST[tileType]
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

// ============================================================================
// WFC Classes (worker-specific versions with message posting for logs)
// ============================================================================

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

  static fromTileDefinitions(tileTypes = null) {
    const rules = new HexWFCAdjacencyRules()
    const types = tileTypes ?? TILE_LIST.map((_, i) => i)

    const allStates = []
    for (const type of types) {
      const def = TILE_LIST[type]
      if (!def) continue

      const isSlope = def.highEdges && def.highEdges.length > 0

      for (let rotation = 0; rotation < 6; rotation++) {
        if (isSlope) {
          const increment = def.levelIncrement ?? 1
          const maxBaseLevel = LEVELS_COUNT - 1 - increment
          for (let level = 0; level <= maxBaseLevel; level++) {
            allStates.push({ type, rotation, level })
          }
        } else {
          for (let level = 0; level < LEVELS_COUNT; level++) {
            allStates.push({ type, rotation, level })
          }
        }
      }
    }

    for (const state of allStates) {
      const stateKey = HexWFCCell.stateKey(state)
      const edges = rotateHexEdges(TILE_LIST[state.type].edges, state.rotation)
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
      maxRestarts: options.maxRestarts ?? 10,
      tileTypes: options.tileTypes ?? null,
      padding: options.padding ?? 0,
      gridRadius: options.gridRadius ?? 0,
      globalCenterCube: options.globalCenterCube ?? { q: 0, r: 0, s: 0 },
      weights: options.weights ?? {},
      log: options.log ?? (() => {}),
      attemptNum: options.attemptNum ?? 0,
    }
    this.log = this.options.log
    this.grid = []
    this.neighbors = []
    this.propagationStack = []
    this.restartCount = 0
    this.lastContradiction = null
    this.seedingContradiction = null
    this.collapseOrder = []
  }

  toGlobalCoords(x, z) {
    const padding = this.options.padding
    const gridRadius = this.options.gridRadius
    const globalCenterCube = this.options.globalCenterCube

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
    const types = this.options.tileTypes ?? TILE_LIST.map((_, i) => i)

    const allStates = []
    for (const type of types) {
      const def = TILE_LIST[type]
      if (!def) continue

      const isSlope = def.highEdges && def.highEdges.length > 0

      for (let rotation = 0; rotation < 6; rotation++) {
        if (isSlope) {
          const increment = def.levelIncrement ?? 1
          const maxBaseLevel = LEVELS_COUNT - 1 - increment
          for (let level = 0; level <= maxBaseLevel; level++) {
            allStates.push({ type, rotation, level })
          }
        } else {
          for (let level = 0; level < LEVELS_COUNT; level++) {
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
      if (nx >= 0 && nx < this.width && nz >= 0 && nz < this.height) {
        neighbors.push({ x: nx, z: nz, dir, returnDir: HexOpposite[dir] })
      }
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
      const defaultWeight = TILE_LIST[state.type]?.weight ?? 1
      return customWeight ?? defaultWeight
    })
    const totalWeight = weights.reduce((a, b) => a + b, 0)
    let r = random() * totalWeight
    let selectedKey = possArray[0]
    for (let i = 0; i < possArray.length; i++) {
      r -= weights[i]
      if (r <= 0) {
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

      for (const { x: nx, z: nz, dir, returnDir } of this.neighbors[x][z]) {
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

          // Grass edges can connect at any level
          if (edgeInfo.type === 'grass') {
            for (let level = 0; level < LEVELS_COUNT; level++) {
              const matches = this.rules.getByEdge(edgeInfo.type, returnDir, level)
              for (const key of matches) allowedInNeighbor.add(key)
            }
          } else {
            const matches = this.rules.getByEdge(edgeInfo.type, returnDir, edgeInfo.level)
            for (const key of matches) allowedInNeighbor.add(key)
          }
        }

        let changed = false
        for (const neighborKey of [...neighbor.possibilities]) {
          if (!allowedInNeighbor.has(neighborKey)) {
            neighbor.possibilities.delete(neighborKey)
            changed = true
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
              const name = TILE_LIST[s.type]?.name || s.type
              return `${name} r${s.rotation} l${s.level}`
            })
          }
          return false
        }

        if (changed) {
          this.propagationStack.push({ x: nx, z: nz })
        }
      }
    }
    return true
  }

  solve(seedTiles = [], gridId = '?') {
    const baseAttempt = this.options.attemptNum || 0
    const tryNum = baseAttempt + this.restartCount
    this.log(`WFC START (try ${tryNum}, ${seedTiles.length} seeds, levelsCount=${LEVELS_COUNT})`)

    this.init()

    for (const seed of seedTiles) {
      const cell = this.grid[seed.x]?.[seed.z]
      if (cell && !cell.collapsed) {
        const state = { type: seed.type, rotation: seed.rotation ?? 0, level: seed.level ?? 0 }
        const stateKey = HexWFCCell.stateKey(state)

        // Validate that this state exists in the rules
        if (!this.rules.stateEdges.has(stateKey)) {
          const tileName = TILE_LIST[state.type]?.name || state.type
          this.log(`  WARNING: Seed state "${stateKey}" (${tileName} r${state.rotation} l${state.level}) not in rules!`)
        }

        cell.collapse(state)
        this.collapseOrder.push({ gridX: seed.x, gridZ: seed.z, type: state.type, rotation: state.rotation, level: state.level })
        this.propagationStack.push({ x: seed.x, z: seed.z })
      }
    }

    if (seedTiles.length > 0 && !this.propagate()) {
      this.seedingContradiction = this.lastContradiction
      this.log('WFC failed - propagation failed after seeding')
      if (this.seedingContradiction) {
        const c = this.lastContradiction
        const failG = this.toGlobalCoords(c.failedX, c.failedZ)
        this.log(`  FAILED CELL: (${failG.col},${failG.row})`)

        // Log what each neighbor requires of the failed cell
        this.log(`  REQUIRED EDGES:`)
        for (const dir of HexDir) {
          const offset = getHexNeighborOffset(c.failedX, c.failedZ, dir)
          const nx = c.failedX + offset.dx
          const nz = c.failedZ + offset.dz
          const neighbor = this.grid[nx]?.[nz]
          if (neighbor && neighbor.collapsed) {
            const neighborState = HexWFCCell.parseKey([...neighbor.possibilities][0])
            const neighborName = TILE_LIST[neighborState.type]?.name || neighborState.type
            const oppositeDir = HexOpposite[dir]

            // Try stateEdges first, fallback to computing directly from tile definition
            let neighborEdges = this.rules.stateEdges.get([...neighbor.possibilities][0])
            let requiredEdge = neighborEdges?.[oppositeDir]

            if (!requiredEdge) {
              // Compute edge directly from tile definition
              const def = TILE_LIST[neighborState.type]
              if (def) {
                const rotatedEdges = rotateHexEdges(def.edges, neighborState.rotation)
                const edgeType = rotatedEdges[oppositeDir]
                const edgeLevel = getEdgeLevel(neighborState.type, neighborState.rotation, oppositeDir, neighborState.level)
                requiredEdge = { type: edgeType, level: edgeLevel }
              }
            }

            const nG = this.toGlobalCoords(nx, nz)
            const levelNote = requiredEdge?.type === 'grass' ? ' (any level)' : ''
            this.log(`    ${dir}: ${neighborName} r${neighborState.rotation} l${neighborState.level} @(${nG.col},${nG.row}) requires ${oppositeDir}→${requiredEdge?.type}@${requiredEdge?.level}${levelNote}`)
          }
        }
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
    const rules = HexWFCAdjacencyRules.fromTileDefinitions(tileTypes)

    // Create solver with log callback that sends messages to main thread
    const solver = new HexWFCSolver(width, height, rules, {
      ...options,
      log: (message) => {
        if (currentRequestId === id) {
          self.postMessage({ type: 'log', id, message })
        }
      }
    })

    const result = solver.solve(seeds, options?.gridId)
    const collapseOrder = solver.collapseOrder || []
    const seedingContradiction = solver.seedingContradiction

    self.postMessage({
      type: 'result',
      id,
      success: result !== null,
      tiles: result,
      collapseOrder,
      seedingContradiction
    })
  }
}
