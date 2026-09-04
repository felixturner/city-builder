import { AdditiveBlending, BufferGeometry, Float32BufferAttribute } from 'three/webgpu'
import { mrt, output, vec3 } from 'three/tsl'

/**
 * MRT node that writes a flat "up" normal instead of the real one.
 *
 * GTAO reads the normal buffer, so a translucent effect that writes its true
 * geometric normal gets occluded like solid geometry - a beam or a ground disc
 * picks up AO from whatever it happens to overlap. Claiming to face straight up
 * makes the AO pass see a flat surface and leave it essentially alone.
 */
export const NO_AO_MRT = () => mrt({ output: output, normal: vec3(0, 1, 0) })

/**
 * The house style for coloured FX: trails, rings, circle pulses, beams, blasts.
 *
 * Only walls and blocks are supposed to take ambient occlusion. Effects are
 * light, so they get:
 *   - additive blending - light adds, it never subtracts. This is the fix for
 *     the fade-out artefact: an alpha-blended disc easing to zero opacity still
 *     multiplies whatever is behind it and reads as a dark smudge, whereas an
 *     additive one contributes literally nothing at zero.
 *   - the flat-normal MRT above, so AO skips them.
 *   - depthTest on / depthWrite off - they sort against blocks (a ring behind a
 *     tower stays behind it) without occluding each other.
 *
 * Mutates and returns the material so it can wrap a constructor call inline.
 */
export function fxMaterial(material) {
  material.transparent = true
  material.blending = AdditiveBlending
  material.depthWrite = false
  material.depthTest = true
  material.mrtNode = NO_AO_MRT()
  return material
}

/**
 * Camera layer for objects that should BLOOM.
 *
 * Bloom used to run a luminance high-pass over the whole scene, which meant a
 * thing glowed because it happened to be bright - so the soldiers and the
 * emissive material inside turrets.glb flared without anyone asking, and the
 * only control was a threshold that traded one wrong answer for another.
 *
 * Now glow is opt-in: these objects are rendered a second time into their own
 * target and only THAT is bloomed. Objects stay on layer 0 as well, so this
 * costs them nothing in the main pass - it is an extra pass over a handful of
 * meshes, not a replacement.
 */
export const FX_GLOW_LAYER = 2

/** Opt an object (and its children) into the bloom pass. */
export function glow(object) {
  object.layers.enable(FX_GLOW_LAYER)
  if (object.children) for (const c of object.children) glow(c)
  return object
}

/** Take it back out again - for things that only glow for a moment. */
export function unglow(object) {
  object.layers.disable(FX_GLOW_LAYER)
  if (object.children) for (const c of object.children) unglow(c)
  return object
}

/**
 * The house stutter: a hard on/off flicker, like a tube light striking.
 *
 * Three things use it and they should read as one language - the king's beam
 * and ring coming on, an incoming-swarm arrow, and a shield taking or losing a
 * support trail. It was written out three times, so a change to the rhythm
 * meant finding all three.
 *
 * Uneven gaps, each longer than the last: an even blink reads as a strobe, and
 * a single one reads as a rendering glitch.
 */
export const STUTTER = [
  [0, true], [0.05, false], [0.09, true], [0.14, false],
  [0.22, true], [0.26, false], [0.36, true],
]

/** Seconds the stutter runs for. */
export const STUTTER_TIME = 0.36

/**
 * Play it on `target`, writing `prop` - `visible` for a whole mesh, `opacity`
 * for a material that has to blink back to a level rather than to 1.
 *
 * Hard cuts, not tweens: `gsap.set` at each beat. Returns the timeline so a
 * caller can kill it, and takes `onComplete` for anything that has to be put
 * back afterwards.
 *
 * `repeat` runs it again after `gap` seconds - two strikes in succession read
 * as more urgent than one without being a different animation.
 */
export function stutter(gsap, target, {
  prop = 'visible', on = true, off = false, onComplete,
  repeat = 0, gap = 0.22,
} = {}) {
  gsap.killTweensOf(target)
  const tl = gsap.timeline({ onComplete })
  for (let n = 0; n <= repeat; n++) {
    const at = n * (STUTTER_TIME + gap)
    for (const [t, lit] of STUTTER) tl.set(target, { [prop]: lit ? on : off }, at + t)
  }
  return tl
}

// A plain triangle pointing toward +Z, wound face-up so it isn't back-face
// culled by a camera looking down at the board.
export function triangle(sizeCells) {
  const L = sizeCells / 2, W = sizeCells / 2
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute([
    0, 0, L,
    W, 0, -L,
    -W, 0, -L,
  ], 3))
  geo.computeVertexNormals()
  return geo
}
