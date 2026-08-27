import { Color } from 'three/webgpu'

/**
 * The city's colour palette - three accents and nothing else.
 *
 * Everything the player owns (towers, generators, the king, energy, ammo, HUD,
 * captions) is drawn from these three. Orange, red and black are reserved for
 * the enemy side - creeps, giants, their shots and blasts - so colour alone
 * tells you whose thing you're looking at.
 *
 * BASE is the authored palette. ACCENT_COLORS are the lightened versions used on
 * screen, and ACCENTS the matching CSS hex. Both come from the SAME three.js
 * transform rather than a hand-computed table: three lightens in linear space,
 * so an sRGB HSL calculation in JS lands on visibly different values and the DOM
 * drifts away from the towers.
 */

/** Authored palette, before the lighten pass. */
export const BASE = ['#FC238D', '#D2E253', '#1BB3F6']

/** Lighten each base colour: saturation x1.1, lightness +0.2. */
function lighten(hex) {
  const c = new Color(hex)
  const hsl = {}
  c.getHSL(hsl)
  return new Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.min(1, hsl.l + 0.2))
}

/** On-screen accents as three.js Colors. City uses these directly. */
export const ACCENT_COLORS = BASE.map(lighten)

/** The same three, as CSS hex, for the DOM layers. Index-matched. */
export const ACCENTS = ACCENT_COLORS.map(c => `#${c.getHexString()}`)

export const PINK = ACCENTS[0]
export const LIME = ACCENTS[1]
export const BLUE = ACCENTS[2]

/** Resource colours, drawn from the same three. */
export const ENERGY_COLOR = LIME // build currency
export const AMMO_COLOR = PINK // turret ammunition
