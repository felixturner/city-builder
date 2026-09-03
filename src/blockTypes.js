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
  KING: 2,      // the king. Named HOLE for the geometry it once wore; it
                //  renders the divot top now, and its pink, beam and marker
                //  are what set it apart
  RIFLE: 3,     // turret: a travelling pellet, fine-grained damage
  LASER: 4,     // turret: hitscan, twice the damage at half the rate
  MORTAR: 7,    // turret: an arcing shell with an AoE blast
  ENC_GEN: 6,   // enclosure generator: earns from the ground it seals
  SUPPORT: 5,   // support generator: trails to buildings and improves them
  BARRACKS: 8,  // spawns soldiers that patrol nearby and fight creeps
  SHIELD: 9,    // a barrier ring that burns what crosses inward
}

/**
 * What each role WEARS, kept apart from what it IS.
 *
 * Several roles share a mesh - all three turrets and the barracks wear the
 * divot top, and the king does too, with its pink, its beam and its marker
 * doing the telling apart. Indexed by TopType, into BlockGeometry's load order:
 *
 *   0 Square_Top  1 Quart_Top  2 Hole_Top  3 Peg_Top  4 Divot_Top  5 Cross_Top
 */
const ROOF_GEOM = {
  [TopType.SQUARE]: 0,
  [TopType.QUART]: 1,
  [TopType.KING]: 4,     // divot
  [TopType.RIFLE]: 4,
  [TopType.LASER]: 4,
  [TopType.SUPPORT]: 5,  // the "plus" cross top
  [TopType.ENC_GEN]: 3,  // peg
  [TopType.MORTAR]: 4,
  [TopType.BARRACKS]: 4,
  [TopType.SHIELD]: 2,   // hole
}
export const roofGeomIndex = (typeTop) => ROOF_GEOM[typeTop]

// Each generator type has ONE fixed accent colour (index into City.accentColors:
// 0 pink, 1 yellow, 2 blue). Path = blue, enclosure = yellow.
const GEN_COLOR = {
  [TopType.SUPPORT]: 2,    // blue
  [TopType.ENC_GEN]: 1, // yellow - pink belongs to the king now
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
/** Shields wear the king's pink - the two defensive centrepieces share a colour,
 *  and SHIELD_LINE draws the barrier ring in the same one. This was left on 1
 *  (yellow) when shields turned pink, so the tile, its ring and the support
 *  pulse over it were three different colours. */
export const SHIELD_COLOR = 0

/** Shield radius in CELLS for a shield of `floors` storeys. Shared by the ring
 *  that draws it and the test that decides what crosses it, so the circle never
 *  lies.
 *
 *  Was `floors * 2 + 1`, i.e. 3 cells at one storey out to 11 at the cap - a
 *  disc big enough that one tall shield covered most of what mattered. One cell
 *  a storey makes height a slower, more expensive way to widen it. */
export const shieldRadiusCells = (floors) => floors + 1 + Buffs.shieldRadius

/**
 * Turret firing range in CELLS for a turret of `floors` storeys.
 *
 * One function because four places used to spell the formula out - the three
 * guns, the range ring and the coverage-glow disc - and a ring that disagrees
 * with the gun is a lie you cannot see until something walks through it.
 *
 * Fractional on purpose: at 2 cells a storey the difference between a 5 and a 6
 * was four cells of reach, which made height the only decision worth making.
 */
export const TURRET_RANGE_PER_FLOOR = 1.5
export const turretRangeCells = (floors) => floors * TURRET_RANGE_PER_FLOOR

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
/** The two kinds of generator. Both earn; an ENC_GEN earns from the area it
 *  seals, which is the primary income, while a SUPPORT earns a retainer for its
 *  longest link and exists for the trails it throws. */
export const isEncGen = (t) => t.typeTop === TopType.ENC_GEN
export const isSupport = (t) => t.typeTop === TopType.SUPPORT
/**
 * Anything that earns from sealed ground: a generator, and the king.
 *
 * The king earns from the area it seals on exactly the same terms and claims its
 * region the same way, so only one of the two can be paid for any given region.
 *
 * Deliberately NOT folded into isEncGen, because that feeds isGenerator -
 * which would put the king in the placement cap and give it an upkeep bill.
 */
export const claimsEnclosure = (t) => isEncGen(t) || !!t.king
export const isTurret = (t) =>
  t.typeTop === TopType.RIFLE || t.typeTop === TopType.LASER || t.typeTop === TopType.MORTAR
export const isRifle = (t) => t.typeTop === TopType.RIFLE
export const isLaser = (t) => t.typeTop === TopType.LASER

/**
 * Any generator, of either kind.
 *
 * They differ in almost everything they DO and share what makes them
 * generators: a fixed accent of their own, a slot in the placement cap, an
 * upkeep bill, and energy arriving from them rather than from you.
 */
export const isGenerator = (t) => isEncGen(t) || isSupport(t)

/**
 * A wall: the grey tetromino tiles that make up most of a city.
 *
 * Defined by exclusion, which is a known weakness - a new tile type is a wall
 * until someone remembers to add it here. It stays this way because walls are
 * the DEFAULT: every tile that is not something in particular is one, and
 * listing the six shapes instead would be the same statement upside down.
 */
export const isWall = (t) => !isGenerator(t) && !isTurret(t) && !isBarracks(t) && !isShield(t) && !t.king


/**
 * Height caps. Everything on the board stops at MAX_FLOORS except turrets,
 * which get one storey more.
 *
 * Range scales with height ((floors * 2 + 1) cells - see Turrets), so letting a
 * gun outbuild the wall in front of it is the whole point: the extra storey is
 * two extra cells of reach, and it means a turret can always see over the maze
 * you built around it rather than being capped level with it.
 *
 * A pure function of typeTop, deliberately - there is no per-tower cap to keep
 * in sync, and towers are recycled out of a pool and re-typed constantly.
 */
export const MAX_FLOORS = 5
export const TURRET_EXTRA_FLOORS = 1
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

/**
 * Ceiling on the king's height, however many Crown cards are taken.
 *
 * Every tower is pre-allocated a fixed number of block instances in the batched
 * mesh, so a king taller than its allocation has floors with nothing to draw
 * them with: the stack renders with a gap under the roof and any colour write to
 * the missing instance throws. The king gets its own allocation up to this, and
 * the card stops handing out floors past it.
 */
export const KING_MAX_FLOORS = 9

/** Floors at or below which the king raises its own alarm. */
export const KING_WARN_FLOORS = 2

/** Radius, in cells, of the king's danger zone: a creep inside it sets off the
 *  proximity siren, and the yellow ring on the ground draws exactly this. */
export const KING_WARN_CELLS = 3
