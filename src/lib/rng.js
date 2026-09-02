/**
 * Seeded randomness for anything the SIMULATION depends on.
 *
 * Two streams, and the split is the important part:
 *
 *   simRand()  - creep types, spawn offsets, wave edges, card deals, pathing
 *                choices. Seeded, logged, and reproducible.
 *   Math.random - debris velocities, hit-flash jitter, sound pitch variation,
 *                 anything purely cosmetic.
 *
 * They have to be separate. If a particle burst drew from the same stream, then
 * turning particles off - or dropping a frame that would have spawned some -
 * would shift every subsequent sim roll and the run would diverge. Cosmetic
 * randomness is allowed to differ between two plays of the same recording; the
 * game state is not.
 *
 * mulberry32: 32-bit state, one multiply and a few shifts per call, and a period
 * long enough that a run will never see it repeat. Nothing here needs crypto
 * quality - it needs to be the same twice.
 */

let state = 0
let initialSeed = 0

/** Start (or restart) the sim stream. Returns the seed, for the run log. */
export function seedSim(seed = (Math.random() * 0xffffffff) >>> 0) {
  state = seed >>> 0
  initialSeed = state
  return state
}

/** The seed the stream was last started with - the one a recording replays. */
export function currentSeed() { return initialSeed }

export function simRand() {
  state |= 0
  state = (state + 0x6D2B79F5) | 0
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Integer in [lo, hi], inclusive - the shape most callers actually want. */
export function simInt(lo, hi) {
  return lo + Math.floor(simRand() * (hi - lo + 1))
}

/** Float in [-range/2, range/2), matching MathUtils.randFloatSpread. */
export function simSpread(range) {
  return (simRand() - 0.5) * range
}

/**
 * A shuffled COPY of an array - Fisher-Yates off the sim stream.
 *
 * Not `[...arr].sort(() => rand() - 0.5)`: that is not a shuffle (comparator
 * results have to be consistent or the sort is undefined), and it consumes an
 * unpredictable number of random values, which is fatal for a stream that has to
 * replay identically.
 */
export function simShuffle(arr) {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = simInt(0, i)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** A random element, or undefined for an empty list. */
export function simPick(arr) {
  return arr.length ? arr[Math.floor(simRand() * arr.length)] : undefined
}

seedSim()
