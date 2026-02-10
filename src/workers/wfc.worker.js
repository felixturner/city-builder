/**
 * WFC Web Worker
 * Runs WFC solver in a separate thread to prevent UI freezing
 */

import {
  TILE_LIST,
  HexDir,
  HexOpposite,
  LEVELS_COUNT,
} from '../HexTileData.js'
import { setSeed, random } from '../SeededRandom.js'
import {
  HexWFCCell,
  HexWFCAdjacencyRules,
  CUBE_DIRS,
  cubeKey,
  parseCubeKey,
  cubeToOffset,
} from '../HexWFCCore.js'

// ============================================================================
// WFC Solver (cube-coordinate based)
// ============================================================================

class HexWFCSolver {
  constructor(rules, options = {}) {
    this.rules = rules
    this.options = {
      maxRestarts: options.maxRestarts ?? 10,
      tileTypes: options.tileTypes ?? null,
      weights: options.weights ?? {},
      log: options.log ?? (() => {}),
      attemptNum: options.attemptNum ?? 0,
      previousStates: options.previousStates ?? null,
      grassAnyLevel: options.grassAnyLevel ?? false,
    }
    this.log = this.options.log
    // Map<cubeKey, HexWFCCell> — cells to solve
    this.cells = new Map()
    // Map<cubeKey, {type, rotation, level}> — collapsed neighbors (read-only constraints)
    this.fixedCells = new Map()
    // Map<cubeKey, [{key, dir, returnDir}]> — precomputed neighbors
    this.neighbors = new Map()
    this.propagationStack = []
    this.restartCount = 0
    this.lastContradiction = null
    this.seedingContradiction = null
    this.collapseOrder = []
  }

  init(solveCells, fixedCells) {
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

    // Create solve cells with full possibility space
    this.cells = new Map()
    for (const { q, r, s } of solveCells) {
      const key = cubeKey(q, r, s)
      this.cells.set(key, new HexWFCCell(allStates))
    }

    // Store fixed cells
    this.fixedCells = new Map()
    for (const fc of fixedCells) {
      const key = cubeKey(fc.q, fc.r, fc.s)
      this.fixedCells.set(key, { type: fc.type, rotation: fc.rotation, level: fc.level })
    }

    // Precompute neighbors for all solve cells
    this.neighbors = new Map()
    for (const { q, r, s } of solveCells) {
      const key = cubeKey(q, r, s)
      const nbrs = []
      for (let i = 0; i < 6; i++) {
        const dir = CUBE_DIRS[i]
        const nq = q + dir.dq
        const nr = r + dir.dr
        const ns = s + dir.ds
        const nKey = cubeKey(nq, nr, ns)
        // Neighbor can be in cells (constrainable) or fixedCells (read-only) or absent (open)
        if (this.cells.has(nKey) || this.fixedCells.has(nKey)) {
          nbrs.push({ key: nKey, dir: HexDir[i], returnDir: HexOpposite[HexDir[i]] })
        }
      }
      this.neighbors.set(key, nbrs)
    }

    // Also build neighbor entries for fixed cells (pointing to solve cells only)
    // so propagation FROM fixed cells can constrain adjacent solve cells
    for (const fc of fixedCells) {
      const key = cubeKey(fc.q, fc.r, fc.s)
      const nbrs = []
      for (let i = 0; i < 6; i++) {
        const dir = CUBE_DIRS[i]
        const nq = fc.q + dir.dq
        const nr = fc.r + dir.dr
        const ns = fc.s + dir.ds
        const nKey = cubeKey(nq, nr, ns)
        if (this.cells.has(nKey)) {
          nbrs.push({ key: nKey, dir: HexDir[i], returnDir: HexOpposite[HexDir[i]] })
        }
      }
      this.neighbors.set(key, nbrs)
    }

    this.propagationStack = []

    // Compute edge cells: solve cells that have at least one fixed cell neighbor
    this.edgeCells = new Set()
    for (const { q, r, s } of solveCells) {
      const key = cubeKey(q, r, s)
      const nbrs = this.neighbors.get(key)
      if (nbrs) {
        for (const { key: nKey } of nbrs) {
          if (this.fixedCells.has(nKey)) {
            this.edgeCells.add(key)
            break
          }
        }
      }
    }

    // Store previous states for overlap cell similarity bias
    this.previousStates = new Map()
    if (this.options.previousStates) {
      for (const [key, state] of Object.entries(this.options.previousStates)) {
        this.previousStates.set(key, state)
      }
    }
  }

  findLowestEntropyCell() {
    let minEntropy = Infinity
    let minKey = null

    for (const [key, cell] of this.cells) {
      if (!cell.collapsed && cell.possibilities.size > 0) {
        const entropy = cell.entropy
        if (entropy < minEntropy) {
          minEntropy = entropy
          minKey = key
        }
      }
    }

    return minKey
  }

  collapse(key) {
    const cell = this.cells.get(key)
    if (!cell || cell.collapsed || cell.possibilities.size === 0) return false

    const possArray = Array.from(cell.possibilities)
    const weights = possArray.map(k => {
      const state = HexWFCCell.parseKey(k)
      const customWeight = this.options.weights[state.type]
      const defaultWeight = TILE_LIST[state.type]?.weight ?? 1
      return customWeight ?? defaultWeight
    })

    // Boost weight of overlap cell's original tile to reduce visual churn
    const prevState = this.previousStates?.get(key)
    if (prevState) {
      const prevStateKey = HexWFCCell.stateKey(prevState)
      for (let i = 0; i < possArray.length; i++) {
        if (possArray[i] === prevStateKey) {
          weights[i] *= 100
        }
      }
    }

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
    this.propagationStack.push(key)
    const { q, r: cr, s } = parseCubeKey(key)
    this.collapseOrder.push({ q, r: cr, s, type: state.type, rotation: state.rotation, level: state.level })

    return true
  }

  /**
   * Get edge info for a given state at a given direction.
   * Works for both solve cells (by stateKey) and fixed cells (by stored data).
   */
  getFixedCellEdge(key, dir) {
    const fc = this.fixedCells.get(key)
    if (!fc) return null
    const stateKey = HexWFCCell.stateKey(fc)
    const edgeInfo = this.rules.stateEdges.get(stateKey)?.[dir]
    return edgeInfo
  }

  propagate() {
    while (this.propagationStack.length > 0) {
      const key = this.propagationStack.pop()

      // Determine if this is a solve cell or fixed cell
      const cell = this.cells.get(key)
      const isFixed = !cell
      let possibilities

      if (isFixed) {
        // Fixed cell: create a single-element set from its state
        const fc = this.fixedCells.get(key)
        if (!fc) continue
        possibilities = new Set([HexWFCCell.stateKey(fc)])
      } else {
        possibilities = cell.possibilities
      }

      const nbrs = this.neighbors.get(key)
      if (!nbrs) continue

      for (const { key: nKey, dir, returnDir } of nbrs) {
        const neighbor = this.cells.get(nKey)
        // Only constrain solve cells (never modify fixed cells)
        if (!neighbor || neighbor.collapsed) continue

        const allowedInNeighbor = new Set()
        const lookedUp = {}

        for (const stateKey of possibilities) {
          const edgeInfo = this.rules.stateEdges.get(stateKey)?.[dir]
          if (!edgeInfo) continue

          const typeCache = lookedUp[edgeInfo.type]
          if (typeCache?.[edgeInfo.level]) continue
          if (!typeCache) lookedUp[edgeInfo.type] = {}
          lookedUp[edgeInfo.type][edgeInfo.level] = true

          const isEdge = isFixed || this.edgeCells.has(nKey)
          if ((this.options.grassAnyLevel || isEdge) && edgeInfo.type === 'grass') {
            // Grass can connect at any level — aggregate all levels from the index
            const levelIndex = this.rules.byEdge.get('grass')?.[returnDir]
            if (levelIndex) {
              for (const lvlSet of levelIndex) {
                if (lvlSet) for (const k of lvlSet) allowedInNeighbor.add(k)
              }
            }
          } else {
            const matches = this.rules.getByEdge(edgeInfo.type, returnDir, edgeInfo.level)
            for (const k of matches) allowedInNeighbor.add(k)
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
          const { q, r, s } = parseCubeKey(nKey)
          const failedOffset = cubeToOffset(q, r, s)
          this.lastContradiction = {
            failedKey: nKey,
            failedQ: q, failedR: r, failedS: s,
            failedCol: failedOffset.col, failedRow: failedOffset.row,
            sourceKey: key,
            dir,
          }
          return false
        }

        if (changed) {
          this.propagationStack.push(nKey)
        }
      }
    }
    return true
  }

  solve(solveCells, fixedCells, initialCollapses = []) {
    const baseAttempt = this.options.attemptNum || 0
    const tryNum = baseAttempt + this.restartCount
    this.log(`WFC START (try ${tryNum})`)

    this.init(solveCells, fixedCells)

    // Apply initial collapses (e.g. center grass, water edge for first grid)
    for (const ic of initialCollapses) {
      const key = cubeKey(ic.q, ic.r, ic.s)
      const cell = this.cells.get(key)
      if (cell && !cell.collapsed) {
        const state = { type: ic.type, rotation: ic.rotation ?? 0, level: ic.level ?? 0 }
        cell.collapse(state)
        this.collapseOrder.push({ q: ic.q, r: ic.r, s: ic.s, type: state.type, rotation: state.rotation, level: state.level })
        this.propagationStack.push(key)
      }
    }

    // Propagate from fixed cells into adjacent solve cells
    for (const fc of fixedCells) {
      const key = cubeKey(fc.q, fc.r, fc.s)
      this.propagationStack.push(key)
    }

    // Propagate initial constraints from fixed cells + initial collapses
    if ((fixedCells.length > 0 || initialCollapses.length > 0) && !this.propagate()) {
      this.seedingContradiction = this.lastContradiction
      if (this.lastContradiction) {
        const c = this.lastContradiction
        this.log(`Seeding contradiction at (${c.failedCol},${c.failedRow}) key=${c.failedKey}`)
      }
      return null
    }

    while (true) {
      const targetKey = this.findLowestEntropyCell()

      if (!targetKey) {
        return this.extractResult()
      }

      if (!this.collapse(targetKey)) {
        return null
      }

      if (!this.propagate()) {
        this.restartCount++
        this.log(`WFC fail (contradiction)`)
        if (this.restartCount >= this.options.maxRestarts) {
          return null
        }
        return this.solve(solveCells, fixedCells, initialCollapses)
      }
    }
  }

  extractResult() {
    const result = []
    for (const [key, cell] of this.cells) {
      if (cell.tile) {
        const { q, r, s } = parseCubeKey(key)
        result.push({
          q, r, s,
          type: cell.tile.type,
          rotation: cell.tile.rotation,
          level: cell.tile.level,
        })
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
  const { type, id } = e.data

  if (type === 'solve') {
    currentRequestId = id
    const { solveCells, fixedCells, options } = e.data

    if (options?.seed != null) {
      setSeed(options.seed)
    }

    const tileTypes = options?.tileTypes ?? null
    const rules = HexWFCAdjacencyRules.fromTileDefinitions(tileTypes)

    const solver = new HexWFCSolver(rules, {
      ...options,
      log: (message) => {
        if (currentRequestId === id) {
          self.postMessage({ type: 'log', id, message })
        }
      }
    })

    const result = solver.solve(
      solveCells,
      fixedCells,
      options?.initialCollapses ?? []
    )
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
