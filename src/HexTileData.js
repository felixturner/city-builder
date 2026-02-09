/**
 * Pure tile data - no browser/Three.js dependencies
 * This file can be safely imported by web workers
 */

/**
 * Number of elevation levels in the WFC system
 */
export const LEVELS_COUNT = 3

/**
 * Hex tile type enum - matches Blender mesh names
 */
export const HexTileType = {
  // Base
  GRASS: 0,
  WATER: 1,

  // Roads (10-29)
  ROAD_A: 10,
  ROAD_B: 11,
  ROAD_C: 12,
  ROAD_D: 13,
  ROAD_E: 14,
  ROAD_F: 15,
  ROAD_G: 16,
  ROAD_H: 17,
  ROAD_I: 18,
  ROAD_J: 19,
  ROAD_K: 20,
  ROAD_L: 21,
  ROAD_M: 22,

  // Rivers (30-49)
  RIVER_A: 30,
  RIVER_A_CURVY: 31,
  RIVER_B: 32,
  RIVER_C: 33,
  RIVER_D: 34,
  RIVER_E: 35,
  RIVER_F: 36,
  RIVER_G: 37,
  RIVER_H: 38,
  RIVER_I: 39,
  RIVER_J: 40,
  RIVER_K: 41,
  RIVER_L: 42,
  RIVER_M: 43,

  // Coasts (50-59)
  COAST_A: 50,
  COAST_B: 51,
  COAST_C: 52,
  COAST_D: 53,
  COAST_E: 54,

  // Crossings (60-69)
  RIVER_CROSSING_A: 60,
  RIVER_CROSSING_B: 61,

  // Slopes (70-89)
  GRASS_SLOPE_HIGH: 70,
  ROAD_A_SLOPE_HIGH: 71,
  GRASS_CLIFF: 72,
  GRASS_CLIFF_B: 73,
  GRASS_CLIFF_C: 74,
  GRASS_SLOPE_LOW: 75,
  ROAD_A_SLOPE_LOW: 76,
  GRASS_CLIFF_LOW: 77,
  GRASS_CLIFF_LOW_B: 78,
  GRASS_CLIFF_LOW_C: 79,
}

/**
 * Hex directions (6 edges) for pointy-top orientation
 */
export const HexDir = ['NE', 'E', 'SE', 'SW', 'W', 'NW']

export const HexOpposite = {
  NE: 'SW',
  E: 'W',
  SE: 'NW',
  SW: 'NE',
  W: 'E',
  NW: 'SE',
}

/**
 * Hex neighbor offsets for odd-r offset coordinates (pointy-top)
 */
export const HexNeighborOffsets = {
  even: {
    NE: { dx: 0, dz: -1 },
    E:  { dx: 1, dz: 0 },
    SE: { dx: 0, dz: 1 },
    SW: { dx: -1, dz: 1 },
    W:  { dx: -1, dz: 0 },
    NW: { dx: -1, dz: -1 },
  },
  odd: {
    NE: { dx: 1, dz: -1 },
    E:  { dx: 1, dz: 0 },
    SE: { dx: 1, dz: 1 },
    SW: { dx: 0, dz: 1 },
    W:  { dx: -1, dz: 0 },
    NW: { dx: 0, dz: -1 },
  },
}

/**
 * Get neighbor offset for a hex position
 */
export function getHexNeighborOffset(x, z, dir) {
  const parity = (z % 2 === 0) ? 'even' : 'odd'
  return HexNeighborOffsets[parity][dir]
}

/**
 * Rotate hex edges by N steps (each step = 60°)
 */
export function rotateHexEdges(edges, rotation) {
  const rotated = {}
  for (let i = 0; i < 6; i++) {
    const fromDir = HexDir[i]
    const toDir = HexDir[(i + rotation) % 6]
    rotated[toDir] = edges[fromDir]
  }
  return rotated
}

/**
 * Tile definitions with edge patterns
 */
export const HexTileDefinitions = {
  [HexTileType.GRASS]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 300,
  },
  [HexTileType.WATER]: {
    edges: { NE: 'ocean', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'ocean', NW: 'ocean' },
    weight: 50,
  },
  [HexTileType.ROAD_A]: {
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 10,
  },
  [HexTileType.ROAD_B]: {
    edges: { NE: 'road', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 8,
  },
  [HexTileType.ROAD_C]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'road' },
    weight: 1,
  },
  [HexTileType.ROAD_D]: {
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.ROAD_E]: {
    edges: { NE: 'road', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.ROAD_F]: {
    edges: { NE: 'grass', E: 'road', SE: 'road', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.ROAD_G]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'road', W: 'road', NW: 'road' },
    weight: 2,
  },
  [HexTileType.ROAD_H]: {
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'road', W: 'road', NW: 'road' },
    weight: 2,
  },
  [HexTileType.ROAD_I]: {
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'road', W: 'grass', NW: 'road' },
    weight: 2,
  },
  [HexTileType.ROAD_J]: {
    edges: { NE: 'grass', E: 'road', SE: 'road', SW: 'road', W: 'road', NW: 'grass' },
    weight: 1,
  },
  [HexTileType.ROAD_K]: {
    edges: { NE: 'road', E: 'grass', SE: 'road', SW: 'road', W: 'road', NW: 'road' },
    weight: 1,
  },
  [HexTileType.ROAD_L]: {
    edges: { NE: 'road', E: 'road', SE: 'road', SW: 'road', W: 'road', NW: 'road' },
    weight: 1,
  },
  [HexTileType.ROAD_M]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 4,
  },
  [HexTileType.RIVER_A]: {
    edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 20,
  },
  [HexTileType.RIVER_A_CURVY]: {
    edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 20,
  },
  [HexTileType.RIVER_B]: {
    edges: { NE: 'river', E: 'grass', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 60,
  },
  [HexTileType.RIVER_C]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'river', NW: 'river' },
    weight: 8,
  },
  [HexTileType.RIVER_D]: {
    edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 4,
  },
  [HexTileType.RIVER_E]: {
    edges: { NE: 'river', E: 'river', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 4,
  },
  [HexTileType.RIVER_F]: {
    edges: { NE: 'grass', E: 'river', SE: 'river', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 4,
  },
  [HexTileType.RIVER_G]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'river', W: 'river', NW: 'river' },
    weight: 4,
  },
  [HexTileType.RIVER_H]: {
    edges: { NE: 'grass', E: 'river', SE: 'grass', SW: 'river', W: 'river', NW: 'river' },
    weight: 2,
  },
  [HexTileType.RIVER_I]: {
    edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'river', W: 'grass', NW: 'river' },
    weight: 2,
  },
  [HexTileType.RIVER_J]: {
    edges: { NE: 'grass', E: 'river', SE: 'river', SW: 'river', W: 'river', NW: 'grass' },
    weight: 2,
  },
  [HexTileType.RIVER_K]: {
    edges: { NE: 'river', E: 'grass', SE: 'river', SW: 'river', W: 'river', NW: 'river' },
    weight: 2,
  },
  [HexTileType.RIVER_L]: {
    edges: { NE: 'river', E: 'river', SE: 'river', SW: 'river', W: 'river', NW: 'river' },
    weight: 2,
  },
  [HexTileType.RIVER_M]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'river', NW: 'grass' },
    weight: 8,
  },
  [HexTileType.COAST_A]: {
    edges: { NE: 'grass', E: 'coast', SE: 'ocean', SW: 'coast', W: 'grass', NW: 'grass' },
    weight: 20,
  },
  [HexTileType.COAST_B]: {
    edges: { NE: 'grass', E: 'coast', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'grass' },
    weight: 15,
  },
  [HexTileType.COAST_C]: {
    edges: { NE: 'coast', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'grass' },
    weight: 15,
  },
  [HexTileType.COAST_D]: {
    edges: { NE: 'ocean', E: 'ocean', SE: 'ocean', SW: 'ocean', W: 'coast', NW: 'coast' },
    weight: 15,
  },
  [HexTileType.COAST_E]: {
    edges: { NE: 'grass', E: 'grass', SE: 'coast', SW: 'coast', W: 'grass', NW: 'grass' },
    weight: 10,
  },
  [HexTileType.RIVER_CROSSING_A]: {
    edges: { NE: 'grass', E: 'river', SE: 'road', SW: 'grass', W: 'river', NW: 'road' },
    weight: 4,
  },
  [HexTileType.RIVER_CROSSING_B]: {
    edges: { NE: 'road', E: 'river', SE: 'grass', SW: 'road', W: 'river', NW: 'grass' },
    weight: 4,
  },
  [HexTileType.GRASS_SLOPE_HIGH]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 100,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 2,
  },
  [HexTileType.ROAD_A_SLOPE_HIGH]: {
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 60,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 2,
  },
  [HexTileType.GRASS_CLIFF]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 30,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 2,
  },
  [HexTileType.GRASS_CLIFF_B]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 30,
    highEdges: ['NE', 'E', 'SE', 'SW'],
    levelIncrement: 2,
  },
  [HexTileType.GRASS_CLIFF_C]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 30,
    highEdges: ['E'],
    levelIncrement: 2,
  },
  [HexTileType.GRASS_SLOPE_LOW]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 100,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 1,
  },
  [HexTileType.ROAD_A_SLOPE_LOW]: {
    edges: { NE: 'grass', E: 'road', SE: 'grass', SW: 'grass', W: 'road', NW: 'grass' },
    weight: 60,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 1,
  },
  [HexTileType.GRASS_CLIFF_LOW]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 30,
    highEdges: ['NE', 'E', 'SE'],
    levelIncrement: 1,
  },
  [HexTileType.GRASS_CLIFF_LOW_B]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 30,
    highEdges: ['NE', 'E', 'SE', 'SW'],
    levelIncrement: 1,
  },
  [HexTileType.GRASS_CLIFF_LOW_C]: {
    edges: { NE: 'grass', E: 'grass', SE: 'grass', SW: 'grass', W: 'grass', NW: 'grass' },
    weight: 30,
    highEdges: ['E'],
    levelIncrement: 1,
  },
}

/**
 * Tile types to include in WFC - THE MASTER LIST
 */
export const TILE_LIST = new Set([
  // Base
  HexTileType.GRASS,
  // Roads
  HexTileType.ROAD_A,
  HexTileType.ROAD_B,
  HexTileType.ROAD_D,
  HexTileType.ROAD_E,
  HexTileType.ROAD_F,
  HexTileType.ROAD_H,
  HexTileType.ROAD_J,
  HexTileType.ROAD_M,
  // Rivers
  HexTileType.RIVER_A,
  HexTileType.RIVER_A_CURVY,
  HexTileType.RIVER_B,
  HexTileType.RIVER_D,
  HexTileType.RIVER_E,
  HexTileType.RIVER_F,
  HexTileType.RIVER_G,
  HexTileType.RIVER_H,
  // Crossings
  HexTileType.RIVER_CROSSING_A,
  HexTileType.RIVER_CROSSING_B,
  // Coasts & Water
  HexTileType.WATER,
  HexTileType.COAST_A,
  HexTileType.COAST_B,
  HexTileType.COAST_C,
  HexTileType.COAST_D,
  HexTileType.COAST_E,
  // High slopes
  HexTileType.GRASS_SLOPE_HIGH,
  HexTileType.ROAD_A_SLOPE_HIGH,
  HexTileType.GRASS_CLIFF,
  HexTileType.GRASS_CLIFF_B,
  HexTileType.GRASS_CLIFF_C,
  // Low slopes
  HexTileType.GRASS_SLOPE_LOW,
  HexTileType.ROAD_A_SLOPE_LOW,
  HexTileType.GRASS_CLIFF_LOW,
  HexTileType.GRASS_CLIFF_LOW_B,
  HexTileType.GRASS_CLIFF_LOW_C,
])
