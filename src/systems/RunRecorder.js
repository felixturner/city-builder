import { currentSeed } from '../lib/rng.js'

/**
 * RunRecorder - writes down a run so it can be played back exactly.
 *
 * A run is two things and nothing else:
 *
 *   1. the seed the sim RNG started from (lib/rng.js), and
 *   2. every action the player took, stamped with the SIM TICK it happened on.
 *
 * Ticks, not seconds. The simulation advances by a constant `Demo.SIM_DT` every
 * frame, so tick 740 is the same moment in the world however long the frame took
 * to draw. Recording wall-clock time would put a placement in a different world
 * on playback, which is the whole problem this exists to avoid.
 *
 * There are only eight actions that change the world, and each is one line here
 * and one line in `apply()`: placing a tile, adding a floor, demolishing,
 * discarding a tile, rerolling the tray, clicking a dormant lot, taking a card,
 * and skipping the clock forward. Everything else that happens in a run - what
 * tiles the bag deals, which creeps spawn where, which cards are offered, where
 * a soldier wanders - already comes off the seeded stream, so it follows free.
 *
 * Deliberately NOT recorded, because they change nothing the sim depends on:
 * pausing (which stops the sim rather than altering it), the rotate key (its
 * effect arrives with the placement, which carries its own rotation), the flow
 * overlay, and the camera.
 *
 * Cosmetic randomness deliberately does NOT: debris, hit-flash jitter and sound
 * pitch still use Math.random, so two playbacks of the same run look slightly
 * different frame to frame while being identical in every way that matters.
 */
export class RunRecorder {
  constructor(demo) {
    this.demo = demo
    this.tick = 0
    this.events = []
    this.seed = currentSeed()
    // One id for the whole run, so every save rewrites the same file rather
    // than leaving one per round. Sortable, second resolution, filename-safe.
    this.id = new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-')
    this.replaying = false
    this._replayIndex = 0
    // Console handles: __run.save() to write the current run out mid-game,
    // __run.toJSON() to look at it.
    window.__run = this
  }

  /** Called once per simulated frame, before anything else steps. */
  advance() {
    this.tick++
    if (this.replaying) this._applyDue()
  }

  /** Note an action. Ignored while replaying - playback drives them instead. */
  record(action, data) {
    if (this.replaying) return
    this.events.push({ t: this.tick, a: action, ...data })
  }

  /**
   * The whole run as one object: what happened, and what it cost.
   *
   * The economy figures ride along rather than living in their own file - they
   * describe this run and nothing else, and keeping them together is what stops
   * a replay quietly appending a second set of rounds to a log the run file
   * knows nothing about.
   */
  toJSON() {
    return {
      id: this.id,
      seed: this.seed,
      ticks: this.tick,
      replay: this.replaying, // a played-back run, not a fresh one
      rounds: this.demo.econ?.rounds || [],
      events: this.events,
    }
  }

  /**
   * Ship the run to the dev server, which writes logs/run-<id>.json
   * (see vite.config.js).
   *
   * Called at the end of every round and again at game over: a run that crashes
   * still has everything up to its last round, which is the failure worth
   * insuring against, and rewriting one file costs nothing.
   */
  save() {
    try {
      fetch('/__run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.toJSON()),
        keepalive: true,
      }).catch(() => {})
    } catch { /* dev only */ }
    return this.events.length
  }

  // ---- playback --------------------------------------------------------------

  /**
   * Start driving the game from a recording.
   *
   * Does NOT seed - main.js already did, before the world was built. Seeding
   * here would rewind the stream to its start AFTER the rocks and the tile bag
   * had drawn from it, so every later draw would repeat a value the board build
   * had already consumed, and the replay would diverge immediately.
   */
  load(run) {
    this.seed = run.seed
    this.events = run.events.slice()
    this.expected = run.rounds || [] // to check playback against, round by round
    this.tick = 0
    this._replayIndex = 0
    this.replaying = true
  }

  /**
   * Compare a round of playback against the same round of the recording.
   *
   * A replay that drifts shows up as "a few blocks were different at the end",
   * which says nothing about WHERE it went wrong. Checking each round against
   * what the recording says happened turns that into a round number and a set of
   * figures that stopped matching - and the first mismatch is the one worth
   * looking at, because everything after it follows from the same cause.
   *
   * Only the numbers that describe the world: what was earned and spent, what
   * was built and lost. Not timings, which legitimately vary.
   */
  checkRound(actual, index) {
    if (!this.replaying) return
    const want = this.expected[index]
    if (!want) return
    const keys = ['earned', 'spent', 'blocksPlaced', 'blocksLost', 'incomePerSec']
    const diffs = keys
      .filter((k) => Math.round(want[k]) !== Math.round(actual[k]))
      .map((k) => `${k} ${Math.round(want[k])} -> ${Math.round(actual[k])}`)
    if (!diffs.length) {
      if (!this._diverged) console.log(`[run] L${actual.level} matches`)
      return
    }
    if (!this._diverged) {
      this._diverged = true
      console.warn(`[run] DIVERGED at level ${actual.level} (round ${index + 1}):`,
        diffs.join(', '))
    }
  }

  /** Fire everything scheduled for the tick just reached. */
  _applyDue() {
    while (this._replayIndex < this.events.length
      && this.events[this._replayIndex].t <= this.tick) {
      this.apply(this.events[this._replayIndex++])
    }
  }

  /**
   * Perform one recorded action.
   *
   * Deliberately calls the same methods the player's input calls, rather than
   * reaching into state - so a replay exercises the real code paths, including
   * the affordability checks. If a run diverges, the first action that fails to
   * apply is where it went wrong.
   */
  apply(e) {
    const demo = this.demo
    const city = demo.city
    switch (e.a) {
      case 'place':
        demo.tilePalette?.placeRecorded?.(e)
        break
      case 'floor': {
        const tower = city.towerAtCell?.(e.gx, e.gy)
        if (tower) city.interaction.buildFloor(tower)
        break
      }
      case 'demolish': {
        const tower = city.towerAtCell?.(e.gx, e.gy)
        if (tower && !tower.king) city.interaction.demolishTower(tower)
        break
      }
      case 'reroll':
        demo.tilePalette?._rerollAll?.()
        break
      case 'discard':
        demo.tilePalette?._discard?.(e.slot)
        break
      case 'lot':
        city.lotGrowth.clickLot(e.x, e.z)
        break
      case 'card':
        demo.powerUps?.pickRecorded?.(e.id)
        break
      case 'skip':
        demo.skipAhead()
        break
      default:
        console.warn('[run] unknown action', e.a)
    }
  }
}
