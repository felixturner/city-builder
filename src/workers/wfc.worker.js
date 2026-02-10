/**
 * WFC Web Worker
 * Runs WFC solver in a separate thread to prevent UI freezing
 */

import {
  TILE_LIST,
  HexDir,
  HexOpposite,
  getHexNeighborOffset,
  rotateHexEdges,
  LEVELS_COUNT,
} from '../HexTileData.js'
import { setSeed, random } from '../SeededRandom.js'
import {
  getEdgeLevel,
  HexWFCCell,
  HexWFCAdjacencyRules,
} from '../HexWFCCore.js'

// Coordinate conversion (inlined - small functions, avoid import chain)
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
// WFC Solver (worker-only)
// ============================================================================

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

          const matches = this.rules.getByEdge(edgeInfo.type, returnDir, edgeInfo.level)
          for (const key of matches) allowedInNeighbor.add(key)
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
    this.log(`WFC START (try ${tryNum}, ${seedTiles.length} seeds)`)

    this.init()

    for (const seed of seedTiles) {
      const cell = this.grid[seed.x]?.[seed.z]
      if (cell && !cell.collapsed) {
        const state = { type: seed.type, rotation: seed.rotation ?? 0, level: seed.level ?? 0 }
        const stateKey = HexWFCCell.stateKey(state)

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

            let neighborEdges = this.rules.stateEdges.get([...neighbor.possibilities][0])
            let requiredEdge = neighborEdges?.[oppositeDir]

            if (!requiredEdge) {
              const def = TILE_LIST[neighborState.type]
              if (def) {
                const rotatedEdges = rotateHexEdges(def.edges, neighborState.rotation)
                const edgeType = rotatedEdges[oppositeDir]
                const edgeLevel = getEdgeLevel(neighborState.type, neighborState.rotation, oppositeDir, neighborState.level)
                requiredEdge = { type: edgeType, level: edgeLevel }
              }
            }

            const nG = this.toGlobalCoords(nx, nz)
            this.log(`    ${dir}: ${neighborName} r${neighborState.rotation} l${neighborState.level} @(${nG.col},${nG.row}) requires ${oppositeDir}→${requiredEdge?.type}@${requiredEdge?.level}`)
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

    if (options?.seed != null) {
      setSeed(options.seed)
    }

    const tileTypes = options?.tileTypes ?? null
    const rules = HexWFCAdjacencyRules.fromTileDefinitions(tileTypes)

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
    const lastContradiction = solver.lastContradiction

    self.postMessage({
      type: 'result',
      id,
      success: result !== null,
      tiles: result,
      collapseOrder,
      seedingContradiction,
      lastContradiction
    })
  }
}
