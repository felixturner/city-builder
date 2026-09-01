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
// Waves before this one always arrive on a single side (see waveEdges).
const TWO_FRONT_FROM_WAVE = 2

export class WaveClock {
  constructor() {
    this.elapsed = 0
    this.wavePeriod = 80 // one full cycle
    this.waveActive = 20 // seconds of spawning, at the END of the cycle

    // How long before a wave lands the countdown starts. Bosses get a longer
    // lead because their riser needs more runway - see WaveAudio.
    this.countdownLead = 10
    this.bossCountdownLead = 15
  }

  advance(dt) { this.elapsed += dt }
  reset() { this.elapsed = 0 }

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
   * Which board edges a wave comes in from. Deterministic, so it can be shown
   * before it happens - the incoming arrows have to know the direction while the
   * wave is still being counted down, so it cannot be rolled at spawn time.
   *
   * The hash is a cheap deterministic scramble on the wave index: same wave,
   * same answer however many times it is asked, and the arrows ask every frame.
   * Boss rounds stay on a single side - the whole point of a boss group is that
   * it arrives as one mass.
   */
  waveEdges(waveIdx) {
    if (waveIdx < 0) return [0]
    const hash = Math.abs(Math.imul(waveIdx + 1, 2654435761)) // Knuth
    const first = hash % 4
    // Every third wave opens a second front, on any other edge - including the
    // opposite one, so a wave can genuinely come at you from both sides.
    // A second front needs enough creeps to actually fill both, and the opening
    // waves do not have them - level 1 is eight creeps, barely two clumps, so
    // two arrows promised an attack from a side nothing ever came from. Held
    // back until waves are big enough to split.
    if (waveIdx < TWO_FRONT_FROM_WAVE) return [first]
    if (this.isBossWave(waveIdx) || (hash >> 4) % 3 !== 0) return [first]
    return [first, (first + 1 + ((hash >> 8) % 3)) % 4]
  }
}
