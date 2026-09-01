import { Buffs } from '../buffs.js'
import { isGenerator, isGrey } from '../blockTypes.js'

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
 * Price = base for the kind, x escalation for how many of that bucket you have
 * placed, x a global income factor, x any build-cost buff.
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

const COST_GROWTH = 1.2 // gens/turrets: each one placed makes the next 20% pricier
const WALL_COST_GROWTH = 1.01 // walls are one bucket drawn ~66% of the time, so
// they fill ~18x faster and need a far gentler curve to reach the same place
const INCOME_PRICE_FACTOR = 0.02 // +2% per point of income/sec (surplus brake)
const FLOOR_DISCOUNT = 0.5 // a floor costs half what the same tile costs new

/**
 * The escalation bucket something belongs to. Generators split by COLOUR as well
 * as type, because the colour is what decides which trails they can join - two
 * colours of path generator are different tools, not the same one twice.
 */
export function costKey({ isWall, typeTop, colorIndex }) {
  if (isWall) return 'wall'
  if (isGenerator({ typeTop })) return `gen${typeTop}:${colorIndex}`
  return `turret${typeTop}`
}

/** Price to place or to raise one floor. `spec` is {isWall, typeTop, colorIndex}. */
export function priceOf(city, spec) {
  const base = spec.isWall ? WALL_BASE_COST : UTILITY_BASE_COST
  const count = city.placedCount(costKey(spec))
  const growth = spec.isWall ? WALL_COST_GROWTH : COST_GROWTH
  const income = city.energy ? city.energy.incomePerSec() : 0
  return Math.max(1, Math.round(
    base * Math.pow(growth, count) * (1 + income * INCOME_PRICE_FACTOR) * Buffs.buildCost
  ))
}

/** Same price, addressed by a palette tile. */
export function priceOfTile(city, tile) {
  return priceOf(city, { isWall: !!tile.wall, typeTop: tile.typeTop, colorIndex: tile.colorIndex })
}

/** Half price, for raising one floor on a tower already on the board. */
export function priceOfTower(city, tower) {
  const full = priceOf(city, {
    isWall: isGrey(tower), typeTop: tower.typeTop, colorIndex: tower.colorIndex,
  })
  return Math.max(1, Math.round(full * FLOOR_DISCOUNT))
}
