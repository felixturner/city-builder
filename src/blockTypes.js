import { BlockGeometry } from './lib/BlockGeometry.js'

/**
 * Named top-block types (the roof geometry on a tower) and small predicates /
 * geometry helpers shared across the city systems. Replaces the magic typeTop
 * numbers that were scattered through the codebase.
 *
 * Top geometries (see BlockGeometry load order):
 *   0 Square_Top, 1 Quart_Top, 2 Hole_Top, 3 Peg_Top, 4 Divot_Top, 5 Cross_Top
 */
export const TopType = {
  SQUARE: 0,
  QUART: 1,
  ADJ_GENERATOR: 2, // Hole_Top - generates when orthogonally adjacent to others
  PEG_TURRET: 3, // bullet turret
  DIVOT_TURRET: 4, // laser turret
  PATH_GENERATOR: 5, // Cross_Top "plus" block - connects to others via trails
  ENCLOSURE_GENERATOR: 6, // generates mana when sealed inside an enclosure
  MORTAR_TURRET: 7, // lobs an AoE mortar; heavy damage, slow fire
}

// Role -> top geometry index (decoupled). All three turrets render the divot top;
// the enclosure generator renders the (freed) peg top.
const ROOF_GEOM = [0, 1, 2, 4, 4, 5, 3, 4]
export const roofGeomIndex = (typeTop) => ROOF_GEOM[typeTop]

// Each generator type has ONE fixed accent colour (index into City.accentColors:
// 0 pink, 1 yellow, 2 blue). Path = blue, adjacency = pink, enclosure = yellow.
const GEN_COLOR = {
  [TopType.PATH_GENERATOR]: 2,
  [TopType.ADJ_GENERATOR]: 0,
  [TopType.ENCLOSURE_GENERATOR]: 1,
}
/** Fixed accent index for a generator type, or undefined for non-generators. */
export const genColorIndex = (typeTop) => GEN_COLOR[typeTop]

export const isPathGenerator = (t) => t.typeTop === TopType.PATH_GENERATOR
export const isAdjGenerator = (t) => t.typeTop === TopType.ADJ_GENERATOR
export const isEnclosureGenerator = (t) => t.typeTop === TopType.ENCLOSURE_GENERATOR
export const isTurret = (t) =>
  t.typeTop === TopType.PEG_TURRET || t.typeTop === TopType.DIVOT_TURRET || t.typeTop === TopType.MORTAR_TURRET
export const isPegTurret = (t) => t.typeTop === TopType.PEG_TURRET
export const isDivotTurret = (t) => t.typeTop === TopType.DIVOT_TURRET

/** Any accent-coloured generator (path / adjacency / enclosure). */
export const isGenerator = (t) =>
  t.typeTop === TopType.PATH_GENERATOR ||
  t.typeTop === TopType.ADJ_GENERATOR ||
  t.typeTop === TopType.ENCLOSURE_GENERATOR

/** A plain "grey" tower: not a generator, turret, or the king. */
export const isGrey = (t) => !isGenerator(t) && !isTurret(t) && !t.king

/** World-space Y of the very top of a tower (roof block top), given floorHeight. */
export const towerTopY = (tower, floorHeight) =>
  tower.numFloors * floorHeight + 2 * BlockGeometry.halfHeights[roofGeomIndex(tower.typeTop)]

/** Footprint area of a tower in cells (1x1 = 1, 2x2 = 4, ...). */
export const towerArea = (tower, cellUnit, sizeScratch) => {
  const size = tower.box.getSize(sizeScratch)
  return Math.max(1, Math.round((size.x / cellUnit) * (size.y / cellUnit)))
}

/** True if the tower's footprint is square (w === h in cells). */
export const isSquareTower = (tower, cellUnit, sizeScratch) => {
  const size = tower.box.getSize(sizeScratch)
  return Math.round(size.x / cellUnit) === Math.round(size.y / cellUnit)
}
