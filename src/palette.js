import { Color } from 'three/webgpu'

/**
 * Every colour in the game, in one file.
 *
 * The rule the palette encodes: everything the PLAYER owns is drawn from three
 * accents and nothing else - towers, generators, the king, energy, HUD,
 * captions. Orange, red and purple belong to the enemy - creeps, their shots,
 * their blasts. Colour alone tells you whose thing you are looking at.
 *
 * They live here rather than next to the thing that draws them because a
 * palette is only a palette if you can see it all at once. Tweaking the enemy's
 * orange meant finding five literals in three files, and the two that were
 * missed drifted.
 */

/** Authored accents, before the lighten pass. */
export const BASE = ['#FC238D', '#D2E253', '#1BB3F6']

/** Lighten each base colour: saturation x1.1, lightness +0.2. */
function lighten(hex) {
  const c = new Color(hex)
  const hsl = {}
  c.getHSL(hsl)
  return new Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.min(1, hsl.l + 0.2))
}

/**
 * On-screen accents as three.js Colors, and the matching CSS hex for the DOM.
 *
 * Both from the SAME three.js transform rather than a hand-computed table:
 * three lightens in linear space, so an sRGB HSL calculation in JS lands on
 * visibly different values and the DOM drifts away from the towers.
 */
export const ACCENT_COLORS = BASE.map(lighten)
export const ACCENTS = ACCENT_COLORS.map(c => `#${c.getHexString()}`)

export const PINK = ACCENTS[0]
export const LIME = ACCENTS[1]
export const BLUE = ACCENTS[2]

/** Accent INDEX by name, for the fields that store an index into ACCENT_COLORS
 *  (tower.colorIndex, tile specs, the enclosure claim map). */
export const ACCENT = { PINK: 0, LIME: 1, BLUE: 2 }

/** Build currency: every energy figure, caption and pulse. */
export const ENERGY_COLOR = LIME

/** Shield pink - the tile, the barrier ring, and the flash a creep takes
 *  crossing it: the same pink the king wears, the two defensive centrepieces
 *  sharing one colour. */
export const SHIELD_LINE = PINK

/**
 * The player's side: neutral greys for walls and ground.
 *
 * Walls are deliberately colourless. They are most of what you build, and the
 * three accents have to stay legible against a board covered in them.
 */
export const CITY = {
  /** A freshly placed wall block. Light on purpose - shadeForFloor only ever
   *  darkens from here, so the lighter the base the more range a tall stack
   *  has. Dropped a tenth from 0xbcbcbc, which sat almost exactly on the
   *  board's own value and vanished into the floor it stood on. */
  wall: 0xa3a3a3,
  /** Turret tower blocks: a shade off the wall grey so a gun reads as hardware
   *  rather than masonry. */
  turret: 0xbbbbbb,
  soldier: 0x999999,
  rock: 0x8a8a8a,
  debris: 0x888888,
  /** The white outline marking the edge of the playable board. */
  outline: 0xffffff,
  /** Ground grid lines, fine and coarse. */
  grid: 0x888888,
  /** A tile in hand that cannot be placed where the cursor is. */
  ghostBlocked: 0x9aa0aa,
}

/**
 * The enemy's side: orange through red for the things that attack, purple for
 * the ones that fly.
 */
export const CREEP = {
  body: 0xd2531e,
  bodyLight: 0xef8a4d,
  dark: 0x5a0f12,
  black: 0x080808,
  eye: 0x1a1a20,
  /** Flash a creep takes when hit - hot orange, brighter than any creep body,
   *  so a hit reads even against a clump of them. */
  hitFlash: 0xff7a1a,
  /** Shooters: the block they lob, and its glow. */
  shot: 0xff5a3c,
  shotGlow: 0x822010,
  /** Laser creeps: the gun, and the beam it fires. */
  laser: 0xb01f4a,
  laserBeam: 0xff2e5e,
  /** Bombers fly, and flying is purple. */
  bomber: 0x7d2fb0,
  bomberGlow: 0x2a0d44,
  bomb: 0x141018,
  bombGlow: 0x6a1f8c,
  spawnMarker: 0x7b2ff7,
}

/** Turret hardware and what it throws. */
export const TURRET = {
  projectile: 0xfff3c0,
  projectileGlow: 0xffd060,
  barrel: 0x808080,
  blast: 0xff7a30,
}

/** Warnings and debug overlays. */
export const WARN = {
  /** Incoming-wave arrows: a boss wave is red, an ordinary one orange. */
  arrowBoss: 0xff2a4a,
  arrow: 0xcc5500,
  /** Flow-field debug: cells that reach the king vs cells that do not. */
  flowOk: 0x22ff22,
  flowBlocked: 0xff2020,
}

/** The world outside the board, and the lights on it. */
export const WORLD = {
  /** Three grounds, receding: the play area, the field around it, and the
   *  dark plane beyond that. */
  ground: 0x999999,
  field: 0x4a4a4e,
  beyond: 0x2b2b31,
  sun: 0xffffff,
  skyFill: 0xffffff,
  groundFill: 0x444444,
}

/**
 * Hex, like everything else here - fine for `new Color(x)`, GridHelper and
 * setClearColor, but NOT for anything that reads .r/.g/.b. `lerp(WHITE, t)`
 * silently produces NaN and renders black; make a Color first.
 */
export const WHITE = 0xffffff
export const BLACK = 0x000000
