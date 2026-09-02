import { Buffs } from '../buffs.js'
import { isGrey } from '../blockTypes.js'

/**
 * What anything costs to build - ONE function, used by both the palette and the
 * click-to-add-a-floor path.
 *
 * They used to price separately, and drifted: the palette charged a flat 4 for a
 * wall while adding a floor charged per bounding-box cell, so growing an L-shaped
 * wall cost 6 against the 4 it cost to buy one. Same building, two prices, and
 * only the I piece happened to agree. A single function is the only way that
 * stays fixed.
 *
 * Price = base for the kind, x a straight-line escalation for the LEVEL, x any
 * build-cost buff. No ceiling and no second regime: prices rise at the same rate
 * for as long as a run goes.
 *
 * It has been priced off placements (each one making the next dearer) and off
 * live income. Both went wrong the same way: they multiplied against a board
 * that grows, so a wall reached 42 at level 5 for a player who had simply built
 * well. The level is the one input that rises at a rate the game controls.
 *
 * Adding a FLOOR then takes half of that. Both actions are priced off the same
 * curve, so they can't drift apart again, but growing something you already own
 * is meant to be the cheaper move than buying another - otherwise there is no
 * reason to build up rather than out.
 */

// Flat base prices, NOT per cell - a wall tile costs the same whichever
// tetromino it happens to be.
export const WALL_BASE_COST = 4
export const UTILITY_BASE_COST = 8 // generators and turrets

// What each LEVEL adds to a price, as a multiple of the base. Straight lines, no
// ceiling: prices track the energy cap for as long as a run goes and never stop
// moving.
//
// Walls climb at HALF the rate. They are the bulk purchase - the thing you place
// a dozen of in a round and rebuild after every wave - so pricing them like an
// investment tile made the opening rounds about affording a maze rather than
// designing one. The utilities carry the sink instead.
const COST_PER_LEVEL = 0.4
const WALL_COST_PER_LEVEL = 0.2
// Levels before the ramp starts. The opening is where energy is scarcest and
// there is least standing to earn with, so the first two rounds are always at
// base price - you cannot get going otherwise.
const COST_GRACE_LEVELS = 1

const FLOOR_DISCOUNT = 0.5 // a floor costs half what the same tile costs new

/** Price to place or to raise one floor. `spec` is {isWall, typeTop}. */
export function priceOf(city, spec) {
  const base = spec.isWall ? WALL_BASE_COST : UTILITY_BASE_COST
  const rate = spec.isWall ? WALL_COST_PER_LEVEL : COST_PER_LEVEL
  // waveNumber is 0-based, so this is the displayed level minus one.
  const level = city.creeps ? city.creeps.waveNumber : 0
  const escalation = 1 + Math.max(0, level - COST_GRACE_LEVELS) * rate
  return Math.max(1, Math.round(base * escalation * Buffs.buildCost))
}

/** Same price, addressed by a palette tile. */
export function priceOfTile(city, tile) {
  return priceOf(city, { isWall: !!tile.wall, typeTop: tile.typeTop })
}

/** Half price, for raising one floor on a tower already on the board. */
export function priceOfTower(city, tower) {
  const full = priceOf(city, { isWall: isGrey(tower), typeTop: tower.typeTop })
  return Math.max(1, Math.round(full * FLOOR_DISCOUNT))
}
