/**
 * Random value in range [min, max]
 */
export const randRange = (min, max) => min + Math.random() * (max - min)

/**
 * Random value centered around 0: [-range/2, range/2]
 */
export const randCentered = (range) => (Math.random() - 0.5) * range

/**
 * Clamp value symmetrically around 0: [-max, max]
 */
export const clampSym = (v, max) => Math.max(-max, Math.min(max, v))

/**
 * Standard clamp: [min, max]
 */
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
