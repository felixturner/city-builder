import { isTurret, isGenerator, isBarracks, isShield, isWall } from '../blockTypes.js'
import { Sounds } from '../lib/Sounds.js'

/**
 * Running costs, and the brownout that happens when you can't pay them.
 *
 * The economy used to solve itself: seal one decent enclosure, link a couple of
 * support towers, and energy stopped being something you could run out of - so
 * every decision after the first minute was free. Upkeep puts a standing cost on
 * everything you own, which turns "what do I build" into "what can I afford to
 * KEEP", and makes sprawl a liability rather than pure upside.
 *
 * Nothing dies when you fall short. Buildings go DARK - they stop producing,
 * firing and shielding, and light back up when income recovers. Decay would open
 * a death spiral (lose income -> lose buildings -> lose more income); a brownout
 * is self-correcting, because switching something off is itself the fix.
 *
 * They go dark FURTHEST FROM THE KING FIRST. That gives the shutdown a shape you
 * can read at a glance - your outskirts brown out while the core holds - and it
 * quietly makes distance from the king matter when you choose where to build.
 *
 * DISABLED (see ENABLED below). As written it deadlocks, and the claim above
 * that a brownout cannot spiral is simply wrong:
 *
 *   Darkening by distance from the king darkens GENERATORS, because path
 *   generators want to be spread out - long trails are how they earn. A dark
 *   generator produces nothing, so shedding it makes the deficit worse, not
 *   better. Once enough are dark, income is zero, the pool can never climb back
 *   to the relight threshold, and nothing can be shed to recover because walls
 *   are free. Energy falls forever with no move available to the player.
 *
 * The fix is that the shutdown must never switch off the thing that pays for it:
 * only CONSUMERS (turrets, barracks, shields) may brown out, generators never -
 * and there should be a floor income the king trickles regardless, so there is
 * always a way back up. Left in place rather than deleted because the mechanic
 * itself is worth another go with that ordering.
 */

// Off. Turn this on only together with the fix described above.
const ENABLED = false

// Energy per second, PER FLOOR. Height is power, so height is also cost.
//
// Walls are free on purpose: they are 2/3 of every draw and the material you
// maze with, and taxing them would tax the one thing the game most wants you to
// experiment with.
const UPKEEP_PER_FLOOR = {
  turret: 0.10,
  generator: 0.04,
  barracks: 0.08,
  shield: 0.06,
}

// Fraction of the energy cap you must climb back to before anything relights.
// Without a gap, a city sitting exactly at break-even flickers: relight, tip
// back into deficit, go dark, repeat, every frame.
const RELIGHT_AT = 0.25

export function upkeepOf(tower) {
  if (!tower.visible || tower.king || isWall(tower)) return 0
  const floors = Math.max(1, tower.numFloors)
  if (isTurret(tower)) return floors * UPKEEP_PER_FLOOR.turret
  if (isGenerator(tower)) return floors * UPKEEP_PER_FLOOR.generator
  if (isBarracks(tower)) return floors * UPKEEP_PER_FLOOR.barracks
  if (isShield(tower)) return floors * UPKEEP_PER_FLOOR.shield
  return 0
}

export class Upkeep {
  constructor(city) {
    this.city = city
    this.total = 0 // energy/sec owed across the whole city
    this.dark = new Set() // towers currently browned out
    this._debt = 0 // sub-unit upkeep carried between frames
  }

  /** True if this tower is switched off for want of energy. */
  isDark(tower) { return ENABLED && this.dark.has(tower) }

  /** Recompute what the city owes. Cheap; called when towers change. */
  refresh() {
    let total = 0
    for (const t of this.city.towers) {
      if (this.dark.has(t) && !t.visible) this.dark.delete(t)
      if (!this.dark.has(t)) total += upkeepOf(t)
    }
    this.total = total
  }

  update(dt) {
    if (!ENABLED) return
    const mana = this.city.mana
    if (!mana) return
    this.refresh()

    // Charge in whole units so the meter reads as a number ticking down rather
    // than as fractional noise; the remainder rides along to the next frame.
    this._debt += this.total * dt
    const due = Math.floor(this._debt)
    if (due > 0) {
      this._debt -= due
      const paid = Math.min(due, Math.floor(mana.current))
      if (paid > 0) mana.spend(paid, true)
      if (paid < due) this._blackout(due - paid)
    }

    // Recovered: bring the outskirts back, one building per frame, so the city
    // relights as a visible sweep instead of snapping on all at once.
    if (this.dark.size && mana.current > mana.max * RELIGHT_AT) this._relight()
  }

  /**
   * Couldn't pay: switch buildings off, furthest from the king first, until the
   * bill would have been covered.
   */
  _blackout(shortfall) {
    const lit = this.city.towers
      .filter(t => t.visible && !this.dark.has(t) && upkeepOf(t) > 0)
      .sort((a, b) => this._kingDist(b) - this._kingDist(a))
    let freed = 0
    for (const t of lit) {
      if (freed >= shortfall) break
      this.dark.add(t)
      freed += upkeepOf(t)
      this.city.onTowerChanged(t)
    }
    if (freed > 0) Sounds.play('power-down', 0.9, 0.05, 0.5)
  }

  /** Relight the darkened building NEAREST the king - the core comes back first. */
  _relight() {
    let best = null, bestD = Infinity
    for (const t of this.dark) {
      const d = this._kingDist(t)
      if (d < bestD) { bestD = d; best = t }
    }
    if (!best) return
    this.dark.delete(best)
    this.city.onTowerChanged(best)
    Sounds.play('gen-online', 1.0, 0.05, 0.35)
  }

  /** Squared cell distance from the king, for ordering. */
  _kingDist(tower) {
    const king = this.city.king
    if (!king) return 0
    const dx = tower.cellX - king.cellX, dy = tower.cellY - king.cellY
    return dx * dx + dy * dy
  }

  /** Drop all brownout state (new game). */
  reset() {
    this.dark.clear()
    this._debt = 0
    this.total = 0
  }
}
