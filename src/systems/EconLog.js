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
import { TopType, isTurret, isBarracks, isShield, isWall } from '../blockTypes.js'

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
      // ...and where that came from. `earned` alone cannot say whether a run
      // was carried by support generators or by sealed ground, and the per-round
      // supportMana / encGenMana figures below are only a SNAPSHOT at the
      // moment the round closed - they read zero for a whole round whose walls
      // happened to be open at the end, however much it earned earlier.
      from: { support: 0, enc: 0, king: 0, crate: 0 },
      spentPlace: 0, // new tiles from the palette
      spentFloor: 0, // levelling something already standing
      blocksLost: 0, // blocks creeps knocked off
      blocksPlaced: 0,
      // The fight, so the economy can be read against what shaped it. Total
      // damage and shots fired are not here on purpose: both are derivable
      // (damage is kills x health, shots are turrets x rate x uptime) and
      // neither would change a decision. These three are not derivable.
      //
      // spawned/killed is the number a run turns on. The level where kills stop
      // keeping up with spawns is the level the city starts losing ground, and
      // without the counters it can only be inferred from how the round felt.
      spawned: 0,
      killed: 0,
      // Which defence is actually carrying the round. Turrets are single-target
      // and mortars and shields are not, so a late round where the crowd
      // weapons take the bulk is the case for more of them.
      killedBy: { rifle: 0, laser: 0, mortar: 0, soldier: 0, shield: 0, king: 0, wall: 0 },
      // blocksLost says how much came off; this says WHAT. Losing walls is the
      // game working - they are there to be chewed. Losing generators is the
      // death spiral, because the income that rebuilds them dies with them.
      lostBy: { wall: 0, encGen: 0, support: 0, turret: 0, barracks: 0, shield: 0, king: 0 },
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

  /**
   * Fold the round that just ended into the log and print it.
   *
   * `why` says how it ended: 'cleared' when the board went quiet, 'died' when
   * the king fell partway through. The round you die in is the most interesting
   * one in a run - it is the one the economy failed in - and it used to be
   * thrown away, because a round was only ever closed on a clear.
   */
  end(why = 'cleared') {
    const r = this._round
    if (!r) return
    r.ended = why
    const c = this.demo.city
    r.enclosedCells = c.enclosure?.enclosedCells
      ? c.enclosure.enclosedCells.reduce((n, v) => n + v, 0) : 0
    r.incomePerSec = +(c.energy?.incomePerSec() || 0).toFixed(2)
    r.supportMana = +(c.energy?.supportMana || 0).toFixed(1)
    r.encGenMana = +(c.energy?.encGenMana || 0).toFixed(1)
    r.endEnergy = Math.round(this.demo.mana.current)
    r.spent = r.spentPlace + r.spentFloor
    // What was standing when the round ended, so income can be read against the
    // build that produced it rather than guessed at.
    let support = 0, enc = 0, turret = 0, barracks = 0, shield = 0, wallBlocks = 0
    for (const t of c.towers) {
      if (!t.visible || t.numFloors < 1) continue
      if (t.typeTop === TopType.SUPPORT) support++
      else if (t.typeTop === TopType.ENC_GEN) enc++
      else if (isTurret(t)) turret++
      else if (isBarracks(t)) barracks++
      else if (isShield(t)) shield++
      else if (isWall(t)) wallBlocks += t.numFloors
    }
    r.supportGens = support
    r.encGens = enc
    r.turrets = turret
    r.barracks = barracks
    r.shields = shield
    r.wallBlocks = wallBlocks
    r.killPct = r.spawned > 0 ? Math.round((100 * r.killed) / r.spawned) : 0
    r.atCapPct = r.seconds > 0 ? Math.round((100 * r.atCap) / r.seconds) : 0
    r.atZeroPct = r.seconds > 0 ? Math.round((100 * r.atZero) / r.seconds) : 0
    // The headline: of everything the generators produced this round, how much
    // fell on the floor because the bar was already full.
    r.wastePct = r.earned + r.wasted > 0
      ? Math.round((100 * r.wasted) / (r.earned + r.wasted)) : 0
    this.rounds.push(r)
    // On playback, say whether this round came out the way it was recorded.
    this.demo.run?.checkRound(r, this.rounds.length - 1)
    // Empty buckets are noise in a line this long - name only what happened.
    const nonzero = (o) => Object.entries(o).filter(([, v]) => v > 0)
      .map(([k, v]) => `${v} ${k}`).join(' ') || 'none'
    console.log(
      `[econ] L${r.level} lots ${r.lots} cap ${r.cap} | earned ${Math.round(r.earned)}`
      + ` wasted ${Math.round(r.wasted)} (${r.wastePct}%)`
      + ` | full ${r.atCapPct}% of round, broke ${r.atZeroPct}%`
      + ` | energy ${r.startEnergy}->${r.endEnergy} (low ${r.minEnergy})`
      + ` | spent ${r.spent} (${r.spentPlace} place / ${r.spentFloor} floors)`
      + ` | blocks +${r.blocksPlaced} -${r.blocksLost}`
      + ` | creeps ${r.killed}/${r.spawned} killed (${r.killPct}%) by ${nonzero(r.killedBy)}`
      + ` | lost ${nonzero(r.lostBy)}`
      + ` | income ${r.incomePerSec}/s (support ${r.supportMana} enc ${r.encGenMana})`
      + ` | banked: ${Math.round(r.from.support)} support, ${Math.round(r.from.enc)} enc,`
      + ` ${Math.round(r.from.king)} king, ${Math.round(r.from.crate)} crate`
      + ` | built: ${support} support, ${enc} enc, ${turret} turret, ${barracks} brk,`
      + ` ${shield} shld, ${wallBlocks} wall blocks, ${r.enclosedCells} cells sealed`
      + (why === 'died' ? ' | DIED HERE' : '')
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
  /** Attribute energy that was actually banked to whatever produced it. */
  earnFrom(src, gained) {
    if (!this._round || !(gained > 0)) return
    const f = this._round.from
    if (src in f) f[src] += gained
  }
  spend(amount, isFloor) {
    if (!this._round) return
    if (isFloor) this._round.spentFloor += amount
    else this._round.spentPlace += amount
  }
  blockLost(tower) {
    const r = this._round
    if (!r) return
    r.blocksLost++
    const k = this._lostKey(tower)
    if (k) r.lostBy[k]++
  }
  blockPlaced(n = 1) { if (this._round) this._round.blocksPlaced += n }
  creepSpawned(n = 1) { if (this._round) this._round.spawned += n }
  creepKilled(cause) {
    const r = this._round
    if (!r) return
    r.killed++
    if (cause in r.killedBy) r.killedBy[cause]++
  }

  /** Which bucket a destroyed block belongs to - the census order end() uses. */
  _lostKey(t) {
    if (!t) return null
    if (t.king) return 'king'
    if (t.typeTop === TopType.SUPPORT) return 'support'
    if (t.typeTop === TopType.ENC_GEN) return 'encGen'
    if (isTurret(t)) return 'turret'
    if (isBarracks(t)) return 'barracks'
    if (isShield(t)) return 'shield'
    if (isWall(t)) return 'wall'
    return null
  }
}
