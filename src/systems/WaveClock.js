import { simInt } from '../lib/rng.js'
/**
 * The wave schedule, in one place.
 *
 * One cycle is BUILD then ATTACK - `buildTime` seconds to build, then
 * `waveActive` seconds of that cycle's wave spawning. The build half comes
 * first, including on the very first cycle, so there is no grace period: the
 * build phase IS the grace period, and having it as a separate thing only meant
 * the opening round had a different shape from every round after it.
 *
 * Everything that reads the schedule goes through this object - the spawner, the
 * wave audio, the timeline strip, the incoming arrows, the path preview. They
 * each used to re-derive it from `elapsed` with their own copy of the
 * arithmetic, which meant every change to the shape of a round had to be made in
 * five places and kept in step by hand.
 */
export class WaveClock {
  constructor() {
    this.elapsed = 0
    this.wavePeriod = 70 // one full cycle: 50s of build, then the wave
    this.waveActive = 20 // seconds of spawning, at the END of the cycle

    // How long before a wave lands the countdown starts. Bosses get a longer
    // lead because their riser needs more runway - see WaveAudio.
    this.countdownLead = 10
    this.bossCountdownLead = 15

    // Seed for the edge hash, re-rolled per run. The hash has to stay a pure
    // function of the wave index - the arrows and the spawner both ask for it
    // every frame and have to agree - but nothing says every RUN should get the
    // same answers. Without this, wave 1 came from the same side every game.
    this.rerollSeed()
  }

  advance(dt) { this.elapsed += dt }

  /** New run: back to zero, and a fresh set of sides to be attacked from. */
  reset() {
    this.elapsed = 0
    this.rerollSeed()
  }

  // Off the sim stream, so a recorded run gets the same sequence of attack sides.
  rerollSeed() { this.seed = simInt(0, 0xffff) }

  /** Seconds of build at the start of each cycle, before the wave lands. */
  get buildTime() { return this.wavePeriod - this.waveActive }

  /**
   * Cycles elapsed as a FRACTION - 2.5 is halfway through cycle 2. The spawn
   * cadence reads this rather than waveNumber so difficulty keeps sliding
   * smoothly instead of stepping once per cycle.
   */
  get progress() { return this.elapsed / this.wavePeriod }

  /** Index of the cycle we're in: the wave built against, then fought. */
  get waveNumber() { return Math.floor(this.progress) }

  /** Where we are inside the current cycle, 0..wavePeriod. */
  get cyclePhase() { return this.elapsed % this.wavePeriod }

  /** True while this cycle's wave is spawning - the last waveActive seconds. */
  get isSpawning() { return this.cyclePhase >= this.buildTime }

  /** Seconds until this cycle's wave lands; <= 0 once it has. */
  get timeToWave() { return this.buildTime - this.cyclePhase }

  /** World time at which wave `n` starts spawning. */
  waveStart(waveIdx) { return waveIdx * this.wavePeriod + this.buildTime }

  /** Countdown lead for a given wave (bosses get longer). */
  leadFor(waveIdx) {
    return this.isBossWave(waveIdx) ? this.bossCountdownLead : this.countdownLead
  }

  /** Every 4th wave (1-based) is a boss wave. */
  isBossWave(waveIdx) { return waveIdx >= 0 && (waveIdx + 1) % 4 === 0 }

  /** Which boss wave this is (1, 2, 3, ...) = giant count. */
  bossOrdinal(waveIdx) { return (waveIdx + 1) / 4 }

  /**
   * Which board edge a wave comes in from. Returns an array because callers
   * round-robin over it; there is only ever one.
   *
   * Deterministic, so it can be shown before it happens - the incoming arrows
   * have to know the direction while the wave is still being counted down, so it
   * cannot be rolled at spawn time. The hash is a cheap scramble on the wave
   * index plus this run's seed: same wave, same answer however many times it is
   * asked (the arrows ask every frame), but a different sequence of sides from
   * one run to the next.
   *
   * ONE side, always. Every third wave used to open a second front, and a fight
   * on two edges of a board this size cannot be watched - you pick a side and
   * find out afterwards what happened on the other one. A wave you can stand and
   * watch is worth more than one that is technically harder.
   */
  waveEdges(waveIdx) {
    if (waveIdx < 0) return [0]
    const hash = Math.abs(Math.imul(waveIdx + 1 + this.seed, 2654435761)) // Knuth
    return [hash % 4]
  }
}
