import { BlockGeometry } from './lib/BlockGeometry.js'
import { Buffs } from './buffs.js'

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
  HOLE: 2, // Hole_Top - unused gameplay slot, kept for geometry index alignment
  PEG_TURRET: 3, // bullet turret
  DIVOT_TURRET: 4, // laser turret
  PATH_GENERATOR: 5, // Cross_Top "plus" block - connects to others via trails
  ENCLOSURE_GENERATOR: 6, // generates mana when sealed inside an enclosure
  MORTAR_TURRET: 7, // lobs an AoE mortar; heavy damage, slow fire
  BARRACKS: 8, // spawns soldiers that patrol nearby and fight creeps
  SHIELD: 9, // projects a radius in which everything takes double punishment
}

// Role -> top geometry index (decoupled). All three turrets render the divot top;
// the enclosure generator renders the (freed) peg top; the barracks takes the
// triangular Quart_Top, which nothing else uses.
// ...and the shield takes the true triangular Tri_Top (geometry 9), which the
// barracks' curved Quart_Top is not.
const ROOF_GEOM = [0, 1, 2, 4, 4, 5, 3, 4, 1, 9]
export const roofGeomIndex = (typeTop) => ROOF_GEOM[typeTop]

// Each generator type has ONE fixed accent colour (index into City.accentColors:
// 0 pink, 1 yellow, 2 blue). Path = blue, enclosure = yellow.
const GEN_COLOR = {
  [TopType.PATH_GENERATOR]: 2,    // blue
  [TopType.ENCLOSURE_GENERATOR]: 0, // pink
}
/** Fixed accent index for a generator type, or undefined for non-generators. */
export const genColorIndex = (typeTop) => GEN_COLOR[typeTop]

/** Accent index for any accent-coloured tile (generators and the barracks).
 *  Falls back to 0 so callers never index the palette with undefined. */
export const tileColorIndex = (typeTop) =>
  typeTop === TopType.BARRACKS ? BARRACKS_COLOR
    : typeTop === TopType.SHIELD ? SHIELD_COLOR
      : (GEN_COLOR[typeTop] ?? 0)

/** Accent index for the barracks (the one accent no generator uses). */
export const BARRACKS_COLOR = 1
/** Shields share the yellow accent - their ring is the thing that identifies
 *  them, and the palette only has three colours to spend. */
export const SHIELD_COLOR = 1

/** Shield radius in CELLS for a shield of `floors` storeys - the same height
 *  rule a turret's range uses. Shared by the ring that draws it and the test
 *  that decides what crosses it, so the circle never lies. */
export const shieldRadiusCells = (floors) => floors * 2 + 1 + Buffs.shieldRadius

/** Charges a shield carries per storey. Each creep that crosses the perimeter
 *  is burned for one; when they run out the barrier is spent and goes dark. */
export const SHIELD_HITS_PER_FLOOR = 5

/** Charges a shield has left: 5 per floor, minus what's been spent.
 *  Buffs.shieldRadius used to be added HERE, which made "Wider Aegis" hand out
 *  charges instead of radius - it belongs in shieldRadiusCells above. */
export const shieldCharges = (t) =>
  Math.max(0, t.numFloors * SHIELD_HITS_PER_FLOOR - (t.shieldUsed || 0))

export const isBarracks = (t) => t.typeTop === TopType.BARRACKS
export const isShield = (t) => t.typeTop === TopType.SHIELD
export const isPathGenerator = (t) => t.typeTop === TopType.PATH_GENERATOR
export const isEnclosureGenerator = (t) => t.typeTop === TopType.ENCLOSURE_GENERATOR
/**
 * Anything that behaves as an enclosure generator: the hole block, and the king.
 * The king earns from the area it seals on exactly the same terms and claims its
 * enclosure the same way, so only one of the two can occupy any given region.
 *
 * Deliberately separate from isEnclosureGenerator rather than folding the king
 * into it - that predicate also feeds isGenerator, which would hand the king a
 * lifespan, a countdown pie and a slot in the MAX_GENS cap.
 */
export const claimsEnclosure = (t) => isEnclosureGenerator(t) || !!t.king
export const isTurret = (t) =>
  t.typeTop === TopType.PEG_TURRET || t.typeTop === TopType.DIVOT_TURRET || t.typeTop === TopType.MORTAR_TURRET
export const isPegTurret = (t) => t.typeTop === TopType.PEG_TURRET
export const isDivotTurret = (t) => t.typeTop === TopType.DIVOT_TURRET

/** Any accent-coloured generator (path / enclosure). */
export const isGenerator = (t) =>
  t.typeTop === TopType.PATH_GENERATOR ||
  t.typeTop === TopType.ENCLOSURE_GENERATOR

/** A plain "grey" tower: not a generator, turret, barracks, or the king.
 *  Grey towers are walls - they block creep pathing rather than attracting it. */
export const isGrey = (t) => !isGenerator(t) && !isTurret(t) && !isBarracks(t) && !isShield(t) && !t.king


/**
 * Height caps. Everything on the board stops at MAX_FLOORS except turrets,
 * which get two storeys more.
 *
 * Range scales with height ((floors * 2 + 1) cells - see Turrets), so letting a
 * gun outbuild the wall in front of it is the whole point: two extra storeys is
 * four extra cells of reach, and it means a turret can always see over the maze
 * you built around it rather than being capped level with it.
 *
 * A pure function of typeTop, deliberately - there is no per-tower cap to keep
 * in sync, and towers are recycled out of a pool and re-typed constantly.
 */
export const MAX_FLOORS = 5
export const TURRET_EXTRA_FLOORS = 2
export const maxFloorsFor = (t) => MAX_FLOORS + (isTurret(t) ? TURRET_EXTRA_FLOORS : 0)

/** World-space Y of the very top of a tower (roof block top), given floorHeight. */
export const towerTopY = (tower, floorHeight) =>
  tower.numFloors * floorHeight + 2 * BlockGeometry.halfHeights[roofGeomIndex(tower.typeTop)]

/** Footprint area of a tower in cells (1x1 = 1, 2x2 = 4, ...). */
export const towerArea = (tower, cellUnit, sizeScratch) => {
  // Cells the tower actually OCCUPIES, not its bounding box. A tetromino is
  // always 4 cells, but only the I piece has a 4-cell box - the other five are
  // 3x2 or 2x3, so pricing off the box charged 6 for an L and 4 for an I, and
  // made growing a wall dearer than buying one. Pre-built centre-lot towers have
  // no cell list, and they are true rectangles, so the box is right for them.
  if (tower.cells) return tower.cells.length
  const size = tower.box.getSize(sizeScratch)
  return Math.max(1, Math.round((size.x / cellUnit) * (size.y / cellUnit)))
}


/** Floors the central king starts with = creep hits needed to lose the game.
 *  Shared so TowerRenderer can scale its damage feedback against it without
 *  keeping a second copy of the number. */
export const KING_HEALTH = 5

/** Floors at or below which the king raises its own alarm. */
export const KING_WARN_FLOORS = 2
