/**
 * EconLog - a per-round record of where the energy went, for balancing.
 *
 * The economy has three moving parts that only meet in a real run: what the
 * generators earn, what the player finds to spend it on, and what the creeps
 * knock down that has to be bought again. Modelling it on paper got the income
 * right and the damage badly wrong - a spreadsheet has no idea how many blocks
 * actually come off a wall in a round.
 *
 * The number that matters most is `wasted`: energy that arrived while the bar
 * was already full. It measures the overflow directly instead of inferring it
 * from income, and it is zero in a healthy economy.
 *
 * Dev-only. Nothing here runs unless ?dev is on the URL. The rounds live on
 * window.__econ for the console, and are written to disk as part of the run file
 * (RunRecorder) rather than a log of their own - they describe one run, and
 * splitting them let a replay append rounds to a file no run owned.
 */
import { TopType, isTurret, isBarracks, isShield, isGrey } from '../blockTypes.js'

export class EconLog {
  constructor(demo) {
    this.demo = demo
    this.rounds = []
    this._round = null
    window.__econ = this.rounds
  }

  /** Totals for the round that is starting. */
  begin(level) {
    this._round = {
      level,
      lots: this.demo.city.visibleLots,
      cap: this.demo.mana.max,
      earned: 0, // energy actually banked
      wasted: 0, // income that arrived at a full bar
      spentPlace: 0, // new tiles from the palette
      spentFloor: 0, // levelling something already standing
      blocksLost: 0, // blocks creeps knocked off
      blocksPlaced: 0,
      seconds: 0,
      // The two failure modes, measured in seconds rather than inferred: pinned
      // at the ceiling with income falling on the floor, or stuck at nothing
      // with the board asking to be built on. A good round has little of either.
      atCap: 0,
      atZero: 0,
      startEnergy: Math.round(this.demo.mana.current),
      minEnergy: Math.round(this.demo.mana.current),
    }
  }

  /** Fold the round that just ended into the log and print it. */
  end() {
    const r = this._round
    if (!r) return
    const c = this.demo.city
    r.enclosedCells = c.enclosure?.enclosedCells
      ? c.enclosure.enclosedCells.reduce((n, v) => n + v, 0) : 0
    r.incomePerSec = +(c.energy?.incomePerSec() || 0).toFixed(2)
    r.pathGenMana = +(c.energy?.pathGenMana || 0).toFixed(1)
    r.enclosureGenMana = +(c.energy?.enclosureGenMana || 0).toFixed(1)
    r.endEnergy = Math.round(this.demo.mana.current)
    r.spent = r.spentPlace + r.spentFloor
    // What was standing when the round ended, so income can be read against the
    // build that produced it rather than guessed at.
    let path = 0, enc = 0, turret = 0, barracks = 0, shield = 0, wallBlocks = 0
    for (const t of c.towers) {
      if (!t.visible || t.numFloors < 1) continue
      if (t.typeTop === TopType.PATH_GENERATOR) path++
      else if (t.typeTop === TopType.ENCLOSURE_GENERATOR) enc++
      else if (isTurret(t)) turret++
      else if (isBarracks(t)) barracks++
      else if (isShield(t)) shield++
      else if (isGrey(t)) wallBlocks += t.numFloors
    }
    r.pathGens = path
    r.encGens = enc
    r.turrets = turret
    r.barracks = barracks
    r.shields = shield
    r.wallBlocks = wallBlocks
    r.atCapPct = r.seconds > 0 ? Math.round((100 * r.atCap) / r.seconds) : 0
    r.atZeroPct = r.seconds > 0 ? Math.round((100 * r.atZero) / r.seconds) : 0
    // The headline: of everything the generators produced this round, how much
    // fell on the floor because the bar was already full.
    r.wastePct = r.earned + r.wasted > 0
      ? Math.round((100 * r.wasted) / (r.earned + r.wasted)) : 0
    this.rounds.push(r)
    // On playback, say whether this round came out the way it was recorded.
    this.demo.run?.checkRound(r, this.rounds.length - 1)
    console.log(
      `[econ] L${r.level} lots ${r.lots} cap ${r.cap} | earned ${Math.round(r.earned)}`
      + ` wasted ${Math.round(r.wasted)} (${r.wastePct}%)`
      + ` | full ${r.atCapPct}% of round, broke ${r.atZeroPct}%`
      + ` | energy ${r.startEnergy}->${r.endEnergy} (low ${r.minEnergy})`
      + ` | spent ${r.spent} (${r.spentPlace} place / ${r.spentFloor} floors)`
      + ` | blocks +${r.blocksPlaced} -${r.blocksLost}`
      + ` | income ${r.incomePerSec}/s (path ${r.pathGenMana} enc ${r.enclosureGenMana})`
      + ` | built: ${path} path, ${enc} enc, ${turret} turret, ${barracks} brk,`
      + ` ${shield} shld, ${wallBlocks} wall blocks, ${r.enclosedCells} cells sealed`
    )
    this._round = null
    // The run file carries the rounds now - see RunRecorder.toJSON. Saving here
    // means a crashed run still has everything up to its last round.
    this.demo.run?.save()
  }

  tick(dt) {
    const r = this._round
    if (!r) return
    r.seconds += dt
    const m = this.demo.mana
    if (m.current >= m.max) r.atCap += dt
    if (m.current < 1) r.atZero += dt
    if (m.current < r.minEnergy) r.minEnergy = Math.round(m.current)
  }
  earn(amount, wasted) {
    if (!this._round) return
    this._round.earned += amount
    this._round.wasted += wasted
  }
  spend(amount, isFloor) {
    if (!this._round) return
    if (isFloor) this._round.spentFloor += amount
    else this._round.spentPlace += amount
  }
  blockLost() { if (this._round) this._round.blocksLost++ }
  blockPlaced(n = 1) { if (this._round) this._round.blocksPlaced += n }
}
