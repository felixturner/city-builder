/**
 * Buffs - the single mutable bag of run-modifiers that power-up cards write and
 * the game systems read at the point of use.
 *
 * Deliberately dependency-free. It lives apart from PowerUps.js because
 * blockTypes.js needs to read it, PowerUps.js needs to read blockTypes.js, and
 * putting the state in PowerUps made those two import each other. Module cycles
 * happen to work here (every read is inside a function), but only by luck of
 * evaluation order - a single top-level read would have broken it silently.
 *
 * Values are multipliers where the underlying number is a rate, and additive
 * where it is a count, so "x0.85 twice" compounds sensibly but "+1 slot twice"
 * doesn't collapse to +1.
 */
/** Neutral values - what every buff is worth before a card touches it. */
const DEFAULTS = {
  wallHits: 0, // extra hits a grey wall absorbs per floor
  creepHp: 1, // multiplier on creep max hits (lower = weaker)
  genRate: 1, // multiplier on generator output
  supportReach: 0, // extra cells of support-tower reach
  shotDamage: { peg: 0, laser: 0, mortar: 0 }, // additive turret damage
  fireRate: 1, // multiplier on turret cooldowns (lower = faster)
  paletteSlots: 0, // extra palette slots
  refillRate: 1, // multiplier on palette refill time (lower = faster)
  energyMax: 0, // extra energy capacity
  soldierHp: 0, // extra soldier hit points
  squadPerFloor: 0, // extra soldiers per barracks floor
  shieldRadius: 0, // extra shield radius in cells
  buildCost: 1, // multiplier on build/placement cost
  floorsPerBuild: 1, // floors a single build click raises (each one charged for)
  rebuildPerRound: 0, // walls handed a free floor when a round is cleared
}

export const Buffs = structuredClone(DEFAULTS)

/**
 * Reset every buff to its neutral value (new game).
 *
 * Derived from DEFAULTS rather than written out a second time. The two lists
 * used to be separate, and a new buff added to one and not the other leaked
 * across runs - a card taken in one game still applied in the next.
 */
export function resetBuffs() {
  Object.assign(Buffs, structuredClone(DEFAULTS))
}
