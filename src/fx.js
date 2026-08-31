import { AdditiveBlending } from 'three/webgpu'
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
