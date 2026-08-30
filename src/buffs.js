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
export const Buffs = {
  wallHits: 0, // extra hits a grey wall absorbs per floor
  creepHp: 1, // multiplier on creep max hits (lower = weaker)
  genRate: 1, // multiplier on generator output
  supportReach: 0, // extra cells of support-tower reach
  shotDamage: { peg: 0, laser: 0, mortar: 0 }, // additive turret damage
  fireRate: 1, // multiplier on turret cooldowns (lower = faster)
  paletteSlots: 0, // extra palette slots
  refillRate: 1, // multiplier on palette refill time (lower = faster)
  ammoMax: 0, // extra ammo capacity
  energyMax: 0, // extra energy capacity
  soldierHp: 0, // extra soldier hit points
  squadPerFloor: 0, // extra soldiers per barracks floor
  shieldRadius: 0, // extra shield radius in cells
  buildCost: 1, // multiplier on build/placement cost
}

/** Reset every buff to its neutral value (new game). */
export function resetBuffs() {
  Buffs.wallHits = 0
  Buffs.creepHp = 1
  Buffs.genRate = 1
  Buffs.supportReach = 0
  Buffs.shotDamage = { peg: 0, laser: 0, mortar: 0 }
  Buffs.fireRate = 1
  Buffs.paletteSlots = 0
  Buffs.refillRate = 1
  Buffs.ammoMax = 0
  Buffs.energyMax = 0
  Buffs.soldierHp = 0
  Buffs.squadPerFloor = 0
  Buffs.shieldRadius = 0
  Buffs.buildCost = 1
}
