import { currentSeed, simDraws, simState } from '../lib/rng.js'

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
/** Level a run is on, for a diagnostic line. 1-based, like the HUD. */
function demoLevel(demo) { return (demo.creeps?.waveNumber ?? 0) + 1 }

export class RunRecorder {
  // Ticks between world fingerprints: 30 is half a second, ~380 samples over a
  // three-minute run. Fine enough to point at a moment, small enough that the
  // trace stays a rounding error in the run file.
  static TRACE_EVERY = 30

  // Field names as they read in the console. The order they diverge in is the
  // diagnosis: draws first means an extra roll, health first means damage,
  // energy alone means a payout landed at a different time.
  static TRACE_LABELS = {
    d: 'rng draws', r: 'rng state', c: 'creeps', ch: 'creep hp',
    cp: 'creep pos', tv: 'towers', tf: 'floors', e: 'energy', sc: 'score',
    w: 'wave clock', tw: 'tower list', cr: 'creep list',
  }

  constructor(demo) {
    this.demo = demo
    this.tick = 0
    this.events = []
    this.seed = currentSeed()
    // One id for the whole run, so every save rewrites the same file rather
    // than leaving one per round - and a DIFFERENT one for every run, so a new
    // game never lands on a file an earlier one owns. Sortable and
    // filename-safe. Milliseconds are kept: at second resolution two pages
    // opened in the same second shared an id and wrote over each other, which
    // is exactly the case a balance pass hits - replay, tweak, reload, replay.
    //
    // LOCAL time, not UTC. These names are read by a person, next to a wall
    // clock, while deciding which of two files is the game they just played;
    // an id seven hours off the clock on the wall is a name you have to do
    // arithmetic on. Built by hand because toISOString is always UTC.
    const d = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    this.id = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      + `T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`
      + `-${String(d.getMilliseconds()).padStart(3, '0')}`
    this.replaying = false
    this._replayIndex = 0
    // Fingerprint of the world every TRACE_EVERY ticks - see _sample().
    this.trace = []
    // The sim RNG's draw count on EVERY tick. One integer a tick, so a whole
    // run is a few tens of kilobytes - cheap enough to always be on, and it
    // pins a stream divergence to the exact tick instead of to a 30-tick
    // window. The full fingerprint stays sampled, because walking every creep
    // and tower once a tick is not free.
    this.draws = []
    this._expectDraws = null
    this._drawsDiverged = false
    // Damage dealt to creeps, per tick, for the same reason as `draws`: when
    // combat diverges BEFORE the RNG does, the rolls are not the cause and the
    // question becomes which tick a hit landed on. A 30-tick window cannot say.
    this.hits = []
    this._expectHits = null
    this._hitsDiverged = false
    // A position-weighted hash of every standing tower, per tick. Totals are
    // blind to distribution: two boards with twenty towers and thirty-eight
    // floors between them can disagree about WHICH tower is which height, and
    // that difference stays invisible until a creep happens to knock the last
    // block off one of them. This sees it on the tick it happens.
    this.board = []
    this._expectBoard = null
    this._boardDiverged = false
    this.cool = []
    this._expectCool = null
    this._coolDiverged = false
    this.pos = []
    this._expectPos = null
    this._posDiverged = false
    this._expectTrace = null
    this._traceDiverged = false
    // Console handles: __run.save() to write the current run out mid-game,
    // __run.toJSON() to look at it.
    window.__run = this

    // Save when the page goes away, not just when a round closes.
    //
    // A run was only written at a round boundary and at game over, so
    // navigating off - the back button, a reload, closing the tab - threw away
    // everything since the last round. A player who went to level five and then
    // hit back to watch the replay got a recording of the first two levels and
    // no indication that was what happened.
    //
    // `pagehide` rather than `unload`, which is unreliable in modern browsers,
    // plus `visibilitychange` because a hidden tab may never fire pagehide at
    // all. Both can fire for one navigation; saving twice writes the same file
    // twice, which costs nothing. The POST is already keepalive, which is what
    // lets it outlive the page.
    this._saveOnExit = (why, exiting) => {
      this.endedBy = this.endedBy || why
      this.save({ exiting })
    }
    window.addEventListener('pagehide', () => this._saveOnExit('pagehide', true))
    document.addEventListener('visibilitychange', () => {
      // A hidden tab freezes the sim (Demo.animate gates on tabHidden), so a
      // run that stops here did not end - it was walked away from, and its
      // last round is wherever the player happened to be. Worth saying in the
      // file, because a truncated run looks exactly like a short one.
      // Not `exiting`: the page is still there, so this can be a full-size
      // save rather than a 64KB-capped one.
      if (document.visibilityState === 'hidden') this._saveOnExit('tab-hidden', false)
    })
  }

  /** Called once per simulated frame, before anything else steps. */
  advance() {
    this.tick++
    // Sampled AFTER playback has applied this tick's events, because that is
    // where a live frame sits. An action stamped N-1 ran in the gap after step
    // N-1 finished - before this frame began - so a live sample here already
    // includes it, and playback's has to as well.
    //
    // It matters for exactly one action. A place or a floor draws nothing when
    // it is applied (the tile spec is drawn later, when the palette refills),
    // so the sample position is invisible for those. A +20s skip draws its
    // whole wave immediately - twenty-two values in one go - and sampling a
    // moment too early reported all of them as a divergence that corrected
    // itself on the very next tick.
    if (this.replaying) this._applyDue()
    this._sample()
    this._sampleDraws()
  }

  /**
   * Record the RNG draw count for this tick, and on playback report the first
   * tick it parts company with the recording.
   *
   * The window sampler can only say "somewhere in these 30 ticks", and a
   * divergence that corrects itself inside one window - which is what the last
   * run showed - is nearly invisible to it. This says which tick, so the answer
   * is a line of code rather than a list of suspects.
   */
  _sampleDraws() {
    let h = 0
    for (const c of this.demo.creeps?.creeps || []) h += c.hits || 0
    this.hits.push(h)
    if (this.replaying && !this._hitsDiverged && this._expectHits) {
      const wantH = this._expectHits[this.hits.length - 1]
      if (wantH !== undefined && wantH !== h) {
        this._hitsDiverged = true
        this._report().damage = {
          tick: this.tick,
          seconds: +(this.tick / 60).toFixed(2),
          level: demoLevel(this.demo),
          want: wantH,
          got: h,
        }
        console.warn(`[run] DAMAGE DIVERGED at tick ${this.tick}`
          + ` (${(this.tick / 60).toFixed(2)}s): ${wantH} -> ${h}`)
      }
    }

    // Turret cooldowns, to a thousandth of a second. Damage landing one tick
    // apart with identical rolls and an identical board means a gun fired one
    // tick apart, and the cooldown is the only float that decides that. If
    // this parts company BEFORE the damage does, fire timing is the cause; if
    // it does not, the cause is downstream of the trigger.
    // Creep positions, hashed every tick at full precision. The sampled list is
    // every thirtieth tick and rounded; this says the exact tick a creep first
    // stands somewhere else, which is the difference between "the shot picked
    // the wrong target" and "the target was somewhere else".
    let ch2 = 0
    for (const c of this.demo.creeps?.creeps || []) {
      ch2 = (ch2 + Math.round(c.mesh.position.x * 1000)
        + Math.imul(Math.round(c.mesh.position.z * 1000), 31)) | 0
    }
    this.pos.push(ch2)
    if (this.replaying && !this._posDiverged && this._expectPos) {
      const wantP = this._expectPos[this.pos.length - 1]
      if (wantP !== undefined && wantP !== ch2) {
        this._posDiverged = true
        this._report().positions = {
          tick: this.tick, seconds: +(this.tick / 60).toFixed(2), level: demoLevel(this.demo),
        }
      }
    }

    let cd = 0
    for (const [, v] of this.demo.turrets?.cooldowns || []) cd = (cd + Math.round(v * 1000)) | 0
    this.cool.push(cd)

    let bh = 0
    for (const t of this.demo.city?.towers || []) {
      if (!t.visible || t.numFloors < 1) continue
      // Cheap order-independent mix: each tower contributes its height bound to
      // its cell, so a floor moving between towers changes the total.
      bh = (bh + Math.imul(t.numFloors, 0x9E3779B1 ^ Math.imul(t.cellX + 1, 73856093)
        ^ Math.imul(t.cellY + 1, 19349663))) | 0
    }
    this.board.push(bh)
    if (this.replaying && !this._coolDiverged && this._expectCool) {
      const wantC = this._expectCool[this.cool.length - 1]
      if (wantC !== undefined && wantC !== cd) {
        this._coolDiverged = true
        this._report().cooldowns = {
          tick: this.tick, seconds: +(this.tick / 60).toFixed(2), want: wantC, got: cd,
        }
      }
    }
    if (this.replaying && !this._boardDiverged && this._expectBoard) {
      const wantB = this._expectBoard[this.board.length - 1]
      if (wantB !== undefined && wantB !== bh) {
        this._boardDiverged = true
        this._report().board = {
          tick: this.tick,
          seconds: +(this.tick / 60).toFixed(2),
          level: demoLevel(this.demo),
        }
        console.warn(`[run] BOARD DIVERGED at tick ${this.tick}`
          + ` (${(this.tick / 60).toFixed(2)}s)`)
      }
    }

    const d = simDraws()
    this.draws.push(d)
    if (!this.replaying || this._drawsDiverged || !this._expectDraws) return
    const want = this._expectDraws[this.draws.length - 1]
    if (want === undefined || want === d) return
    this._drawsDiverged = true
    this._report().rng = {
      tick: this.tick,
      seconds: +(this.tick / 60).toFixed(2),
      level: demoLevel(this.demo),
      want,
      got: d,
    }
    console.warn(`[run] RNG DIVERGED at tick ${this.tick}`
      + ` (${(this.tick / 60).toFixed(2)}s, level ${demoLevel(this.demo)}):`
      + ` ${want} draws -> ${d}`)
  }

  /**
   * Fingerprint the world, every TRACE_EVERY ticks.
   *
   * A per-ROUND check says a replay diverged somewhere inside seventy seconds,
   * which is four thousand steps and every system in the game. This narrows it
   * to half a second and, more usefully, to a QUANTITY: if the RNG draw count
   * parts company first, something drew from the sim stream that did not draw
   * last time; if the draw count still agrees but creep health does not, the
   * damage arithmetic diverged with the same rolls; if only energy moves,
   * something paid out at a different moment.
   *
   * Taken here, before the step, so a sample is the state the step is about to
   * act on - the same point in the cycle every time, live or replayed.
   */
  _sample() {
    if (this.tick % RunRecorder.TRACE_EVERY) return
    const demo = this.demo
    const creeps = demo.creeps?.creeps || []
    let ch = 0, cp = 0
    for (const c of creeps) {
      // Damage TAKEN, not capacity: it moves every time a shot lands, so it is
      // the field that catches the combat arithmetic drifting.
      ch += c.hits || 0
      // Positions carry the pathing decisions, which is where a stream shift
      // shows up as behaviour rather than as a number. Rounded to 1/100 of a
      // world unit: exact enough to catch a diverted creep, coarse enough not
      // to report a difference nobody could see.
      cp += Math.round((c.mesh.position.x + c.mesh.position.z) * 100)
    }
    let tv = 0, tf = 0
    for (const t of demo.city?.towers || []) {
      if (!t.visible || t.numFloors < 1) continue
      tv++
      tf += t.numFloors
    }
    const s = {
      t: this.tick,
      d: simDraws(),
      r: simState(),
      c: creeps.length,
      ch,
      cp,
      tv,
      tf,
      e: Math.round(demo.mana?.current ?? 0),
      // The score, because it is the number on screen: when a replay "looks
      // wrong" this is usually what was read, and it was the one figure the
      // trace could not answer for.
      sc: Math.floor(demo.mana?.elapsed ?? 0),
      w: Math.round((demo.creeps?.clock?.elapsed ?? 0) * 100),
      // The actual board and the actual creeps, not just counts.
      //
      // Totals hide the thing that matters. Two boards with the same tower
      // count and the same floor count can disagree about WHICH tower is which
      // height, and that stays invisible until a creep knocks the last block
      // off one of them - by which point the run has been diverging for
      // thousands of ticks with nothing to show for it. Listing them means a
      // single recorded run answers "which tower, which creep", instead of
      // another run being needed for every question.
      //
      // Cost is a few hundred numbers every half second: worth it for a
      // dev-only file that exists to be diffed.
      tw: (demo.city?.towers || [])
        .filter((t) => t.visible && t.numFloors >= 1)
        .map((t) => [t.cellX, t.cellY, t.numFloors])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      // Positions to a thousandth of a unit. At a tenth, which is what this
      // rounded to first, two creeps several ticks of travel apart printed as
      // the same number - so "identical positions, different damage" could not
      // be trusted, and it was the whole basis for calling this a targeting
      // problem rather than a movement one.
      cr: creeps.map((c) => [
        Math.round(c.mesh.position.x * 1000),
        Math.round(c.mesh.position.z * 1000),
        c.hits || 0,
      ]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    }
    this.trace.push(s)
    this._checkSample(s)
  }

  /**
   * On playback, compare one sample against the recording and report the FIRST
   * tick that disagrees, naming every field that moved.
   *
   * Only the first: everything after a divergence follows from it, and a
   * thousand lines of consequences bury the one line that matters.
   */
  _checkSample(got) {
    if (!this.replaying || this._traceDiverged || !this._expectTrace) return
    const want = this._expectTrace[this.trace.length - 1]
    if (!want || want.t !== got.t) return
    // Compared by VALUE, because two of these fields are arrays - the tower
    // list and the creep list - and `!==` on arrays is true for every pair of
    // them, so every sample reported a divergence that was not one.
    const same = (a, b) => (Array.isArray(a) || Array.isArray(b)
      ? JSON.stringify(a) === JSON.stringify(b) : a === b)
    const show = (v) => (Array.isArray(v) ? `${v.length} entries` : v)
    const diffs = Object.keys(got)
      .filter((k) => k !== 't' && !same(want[k], got[k]))
      .map((k) => `${RunRecorder.TRACE_LABELS[k] || k} ${show(want[k])} -> ${show(got[k])}`)
    if (!diffs.length) return
    this._traceDiverged = true
    this._report().state = {
      tick: got.t,
      seconds: +(got.t / 60).toFixed(2),
      level: demoLevel(this.demo),
      fields: diffs,
    }
    const prev = this._expectTrace[this.trace.length - 2]
    console.warn(`[run] STATE DIVERGED in ticks ${prev ? prev.t : 0}-${got.t}`
      + ` (${(got.t / 60).toFixed(1)}s, level ${(demoLevel(this.demo))}): ${diffs.join(', ')}`)
  }

  /** The divergence report, created on first use. Absent when nothing differed. */
  _report() { return (this.report = this.report || {}) }

  /**
   * Hand back the card this run picked, for playback to apply immediately.
   *
   * The upgrade screen pauses the game while it is up, and a paused game does
   * not advance the tick - so playback could never REACH the recorded `card`
   * event that would have dismissed it. The replay stopped dead on the boss
   * round and waited for a human, who then had to remember which card they
   * took, and picking a different one forked the run from there.
   *
   * Taken out of the queue here rather than left for `_applyDue`, so it is not
   * applied twice.
   */
  takeCard() {
    if (!this.replaying) return null
    for (let i = this._replayIndex; i < this.events.length; i++) {
      if (this.events[i].a !== 'card') continue
      const [e] = this.events.splice(i, 1)
      return e.id
    }
    return null
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
      // When and where the king fell: sim tick, seconds of game time, the level
      // reached and the score. Absent on a run that has not ended.
      diedAt: this.diedAt || null,
      rounds: this.demo.econ?.rounds || [],
      events: this.events,
      // Sampled world fingerprints. Diagnostic only - a replay reads them to
      // say where it stopped matching, and nothing in the game reads them.
      trace: this.trace,
      draws: this.draws,
      hits: this.hits,
      board: this.board,
      cool: this.cool,
      pos: this.pos,
      // Only present on a playback that found something. `null` means this
      // replay matched the run it came from on every measure.
      diverged: this.replaying ? this.report : undefined,
      // The recording this playback came from, so a pair can never be mismatched
      // by hand again.
      source: this.source || undefined,
      // Playback does not stop when the actions run out - it carries on
      // simulating a game nobody played. Past this point the two runs are not
      // comparable, and the scores will differ for that reason alone.
      overran: this.replaying && this.tick > this.sourceTicks
        ? this.tick - this.sourceTicks : undefined,
      // How the run stopped: 'gameover' is a real ending; anything else means
      // the file is a snapshot of a game still in progress.
      endedBy: this.endedBy || 'in-progress',
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
  save({ exiting = false } = {}) {
    // Nothing happened: do not write. Saving on pagehide means every tab that
    // is merely opened and closed - a replay tab, a reload - would otherwise
    // leave an empty `run-` file behind, and since `?replay` takes the newest
    // run by name, one of those could become the baseline and there would be
    // nothing to play back.
    if (!this.events.length && !this.demo.econ?.rounds?.length) return 0
    try {
      fetch('/__run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.toJSON()),
        // keepalive ONLY when the page is going away, and that is not a
        // preference - the Fetch spec caps a keepalive body at 64KB and
        // rejects anything larger before it leaves the browser. Once the
        // per-tick draw and damage arrays went in, a full run crossed that
        // line, and every save from then on failed in total silence: the
        // reject was swallowed here, the run on screen reached game over, and
        // the file on disk stopped at whichever round last fit.
        //
        // An ordinary save has no such limit. Only the exit path needs
        // keepalive to outlive the page, and if a long run exceeds 64KB there
        // it is the last save that is lost, not every one of them.
        keepalive: exiting,
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
    this._expectTrace = run.trace || null // ...and tick by tick, if it has one
    // Which recording this is a playback OF, and how long it was. Two runs were
    // compared by seed by hand today, and twice the wrong pair got compared.
    this.source = run.id || null
    this.sourceTicks = run.ticks || 0
    this.tick = 0
    this._replayIndex = 0
    this.trace = []
    this.draws = []
    this._expectDraws = run.draws || null
    this.hits = []
    this._expectHits = run.hits || null
    this._hitsDiverged = false
    this.board = []
    this._expectBoard = run.board || null
    this._boardDiverged = false
    this.cool = []
    this._expectCool = run.cool || null
    this._coolDiverged = false
    this.pos = []
    this._expectPos = run.pos || null
    this._posDiverged = false
    this._traceDiverged = false
    this._drawsDiverged = false
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
    const r = this._report()
    ;(r.rounds = r.rounds || []).push({ level: actual.level, diffs })
    if (!this._diverged) {
      this._diverged = true
      console.warn(`[run] DIVERGED at level ${actual.level} (round ${index + 1}):`,
        diffs.join(', '))
    }
  }

  /**
   * Fire everything recorded for a tick EARLIER than the one about to run.
   *
   * Strictly `<`. A live click runs in a DOM handler between frames, so
   * whatever it starts - a palette refill timer, a floor, a generator - first
   * advances in step N+1, while it is stamped with N, the last tick that
   * finished. Applying it here on `<=` ran it inside step N instead, handing
   * every timer it started one extra step. Measured, that is exactly two RNG
   * draws (a tile spec: colour and rotation) arriving one tick early, over and
   * over, each time resyncing on the following tick.
   *
   * Harmless on its own - the values are the same, only their tick moves - but
   * it is a live fault line. Anything that samples the stream at a moment
   * (a destroyed tile rerolling its type, an affordability check at low energy,
   * a swarm release slot during a +20s skip) can land on the wrong side of it,
   * and then the two runs genuinely fork.
   */
  _applyDue() {
    while (this._replayIndex < this.events.length
      && this.events[this._replayIndex].t < this.tick) {
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
  /**
   * The tile an event refers to: by pool index when the recording carries one,
   * falling back to the cell for runs recorded before indices existed.
   *
   * The cell alone is ambiguous. `towerAtCell` resolves it against bounding
   * BOXES, and tetrominoes are L- and S-shaped, so two tiles that share no
   * cells can still overlap there - playback then built on whichever came
   * first in the array rather than the one that was clicked.
   */
  _towerOf(e) {
    const city = this.demo.city
    if (e.i != null) {
      const t = city.towers[e.i]
      if (t && t.visible) return t
    }
    return city.towerAtCell?.(e.gx, e.gy)
  }

  apply(e) {
    const demo = this.demo
    const city = demo.city
    switch (e.a) {
      case 'place':
        demo.tilePalette?.placeRecorded?.(e)
        break
      case 'floor': {
        const tower = this._towerOf(e)
        if (tower) city.interaction.buildFloor(tower)
        break
      }
      case 'demolish': {
        const tower = this._towerOf(e)
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
        // Nothing to do here. A card is claimed by PowerUps.show() through
        // takeCard(), at the moment the screen would have opened - which is
        // the only moment the choice can be applied coherently.
        //
        // This case used to apply it too, and the two raced: once a replay
        // drifted enough that the boss screen came up LATER than the tick the
        // card was recorded on, this fired first, the card was spent, and the
        // screen then opened with nothing left to claim and waited for a human.
        break
      case 'skip':
        demo.skipAhead()
        break
      default:
        console.warn('[run] unknown action', e.a)
    }
  }
}
