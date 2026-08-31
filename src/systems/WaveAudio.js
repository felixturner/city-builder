import { Sounds, BOSS_HORN_PREROLL, MAX_RISER_PREROLL } from '../lib/Sounds.js'

/**
 * The score around a wave: countdown ticker, riser, horn, and the music bed.
 *
 * Split out of Creeps because none of it is simulation - it reads the wave clock
 * and decides what to play, and it was the single largest thing in that file
 * that nothing else touched. Creeps owns the clock; this owns the cueing state,
 * which is really a set of "have I already fired this for wave N?" latches.
 *
 * Those latches are why pausing has to reach in here: the wave clock stops with
 * the game, so a countdown bed left running would drift out of sync with the
 * wave it is counting down to. `resetCues()` drops them so the next wave re-cues
 * from scratch.
 */
export class WaveAudio {
  constructor(creeps) {
    /** Called with the wave index when the board goes quiet after a round. */
    this.onRoundCleared = null
    this.creeps = creeps
    // Latches: "have I already fired this for wave N?" _activeNow tracks whether
    // the board is hot, which is what picks the music bed.
    this.reset()
  }

  /** Forget which wave has been cued, so the next one starts its run-up again.
   *  Pausing calls this; a countdown bed left running would drift out of sync
   *  with the wave clock it is counting down to, which stops with the game. */
  resetCues() {
    this._cuedWave = -1
    this._riser = null
    this._riserWave = -1
  }

  /** Full reset for a new run: cues, plus which wave last fired and played. */
  reset() {
    this.resetCues()
    this._audioWave = -1
    this._bossCuedWave = -1
    this._activeNow = false
  }

  /**
   * Schedule the audio around wave boundaries. Called once per frame from
   * update() - deliberately NOT from advanceSpawns(), which skipAhead() runs in
   * a tight loop (that would fire a horn per simulated step).
   *
   * Timeline for a wave that starts at T:
   *    T-10  boss clock + riser begin (ticks pitched down) [boss waves]
   *    T-6   normal clock + riser begin                  [normal waves]
   *    T-2.5 boss horn starts, so its 2.5s swell peaks at T
   *    T     wave horn + spawns
   */
  update(dt) {
    if (!this.creeps.spawnEnabled) return

    // One cycle = build then attack, so a single index covers both halves: the
    // wave being counted down while you build, and the wave on the board once
    // it lands.
    const clock = this.creeps.clock
    const wave = clock.waveNumber
    const away = clock.timeToWave // <= 0 once this cycle's wave has landed
    const bossNext = clock.isBossWave(wave)
    const spawning = clock.isSpawning

    // Countdown bed, seeked so the final tick lands on the spawn. A mechanical
    // clock rather than a digital alarm - it fills the breather with tension
    // instead of nagging - with a soft riser layered over it for the build.
    const lead = clock.leadFor(wave)
    if (away <= lead && this._cuedWave !== wave) {
      this._cuedWave = wave
      // No stab ahead of the clock - the ticker starting IS the "incoming" cue,
      // and a horn in front of it just stepped on the build-up.
      if (bossNext) Sounds.countdown('tick-fast', away, 0.28, 0.92)
      else Sounds.countdown('tick-fast', away, 0.22)
    }

    // Riser: armed early (its pre-roll is up to ~11s, longer than the tick
    // lead) and fired when its own measured peak lines up with the spawn, so
    // the swell tops out on the horn rather than after it.
    if (away <= MAX_RISER_PREROLL + 1 && this._riserWave !== wave) {
      this._riserWave = wave
      this._riser = Sounds.pickRiser(bossNext)
    }
    if (this._riser && away <= this._riser.peak) {
      const r = this._riser
      this._riser = null
      Sounds.play(r.name, 1.0, 0, r.volume * (bossNext ? 1.25 : 1.0))
    }

    // Boss horn pre-roll: start early so the swell peaks as the giants land.
    if (bossNext && away <= BOSS_HORN_PREROLL && this._bossCuedWave !== wave) {
      this._bossCuedWave = wave
      const { rate, volume } = this.creeps.bossHornVoice(wave)
      Sounds.play('horn-boss', rate, 0.02, volume)
    }

    // Wave horn on the boundary. Boss waves already have their horn running.
    if (spawning && wave !== this._audioWave) {
      this._audioWave = wave
      if (!clock.isBossWave(wave)) Sounds.play('horn', 1.0, 0.06, 0.55)
    }

    // A round is not over when the spawns stop - it's over when the last creep
    // of it is dead. Dropping to the build bed at the end of the spawn window
    // put calm music over a field still full of creeps, so combat holds until
    // the board is actually clear.
    const creepsOnBoard = this.creeps.creeps.length > 0
    const inCombat = spawning || creepsOnBoard
    if (inCombat !== this._activeNow) {
      this._activeNow = inCombat
      // The stab marks the real end of the round, so it moves with it.
      if (!inCombat) {
        // 5.5s fanfare peaking at 1.3s - it plays out across the quiet gap and
        // has decayed by the time the build bed eases back in.
        Sounds.play('level-complete', 1.0, 0, 0.7)
        this.creeps._quietTimer = this.creeps.roundEndQuiet
        // The wave that just finished - 0-based, so the first boss round
        // (level 4) is index 3. Demo hangs the upgrade screen off this.
        this.onRoundCleared?.(this._audioWave)
      }
    }

    // Background music follows the same state: calm while you build, a fight
    // track (drawn from the bucket, so it varies round to round) while the
    // board is hot, and the boss bed on boss rounds.
    if (this.creeps._quietTimer > 0) this.creeps._quietTimer -= dt
    const quiet = !inCombat && this.creeps._quietTimer > 0
    const mode = inCombat ? (clock.isBossWave(this._audioWave) ? 'boss' : 'fight')
      : (quiet ? 'quiet' : 'build')
    // Drop to silence quickly so the sting is exposed; ease back in slowly.
    Sounds.setBedMode(mode, inCombat ? 1.5 : (quiet ? 0.9 : 2.5))
  }
}
