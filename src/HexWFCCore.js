/**
 * Shared WFC core logic - no browser dependencies
 * Importable by both main thread and web workers
 */

import {
  TILE_LIST,
  HexDir,
  rotateHexEdges,
  LEVELS_COUNT,
} from './HexTileData.js'
import { random } from './SeededRandom.js'

/**
 * Check if two edges are compatible (edge type + level must match)
 * @param {string} edgeTypeA - Edge type (grass, road, etc.)
 * @param {number} levelA - Level of edge A
 * @param {string} edgeTypeB - Edge type of neighbor
 * @param {number} levelB - Level of edge B
 */
export function edgesCompatible(edgeTypeA, levelA, edgeTypeB, levelB) {
  if (edgeTypeA !== edgeTypeB) return false
  // Grass edges can connect at any level (used for seed replacement compatibility)
  if (edgeTypeA === 'grass') return true
  // Other edges (road, water, etc.) must match levels
  return levelA === levelB
}

// Cache for rotated high edges: Map<"type_rotation", Set<dir>>
const highEdgeCache = new Map()

/**
 * Get the level for a specific edge of a tile
 * Slopes have different levels on high vs low edges
 * Uses levelIncrement from tile definition (default 1)
 */
export function getEdgeLevel(tileType, rotation, dir, baseLevel) {
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

/**
 * HexWFCCell - Tracks possibility space for one hex grid cell
 */
export class HexWFCCell {
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

/**
 * HexWFCAdjacencyRules - Pre-computed tile compatibility for hex grids
 * Handles offset coordinate asymmetry by indexing by edge type
 */
export class HexWFCAdjacencyRules {
  constructor() {
    this.allowed = new Map()
    this.stateEdges = new Map()
    // 3D index: edgeType → dir → level → Set<stateKey>
    this.byEdge = new Map()
  }

  /**
   * Build adjacency rules from TILE_LIST
   * @param {number[]} tileTypes - Tile types to include
   */
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
