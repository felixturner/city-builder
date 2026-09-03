import { Mesh, BoxGeometry, MeshBasicNodeMaterial, Color } from 'three/webgpu'
import gsap from 'gsap'
import { ENERGY_COLOR } from '../palette.js'
import { fxMaterial, glow } from '../fx.js'

/**
 * ResourceFly - little glowing boxes that pop out of a generator, rise, and
 * burst, so income reads as something being produced rather than a number
 * quietly changing in the corner.
 *
 * These are WORLD-SPACE meshes now, not DOM elements. The old version
 * projected the spawn point once and animated a fixed-size div, so the boxes
 * appeared to change size against the city as the camera zoomed. A real box in
 * the scene scales with everything else - and it picks up the same additive
 * fx material and bloom layer as the rest of the effects for free.
 */
// World units the box rises before it bursts (the old version rose 51px).
const RISE = 4
// Box edge in world units - about a quarter of a cell.
const SIZE = 0.55

export class ResourceFly {
  constructor(scene) {
    this.scene = scene
    this.geo = new BoxGeometry(1, 1, 1)
  }

  /**
   * Pop a box out of a world position.
   * @param {string} color - CSS colour (the DOM heritage; converted here)
   * @param {number} [size] - box edge in world units
   * @param {number} [delay] - seconds to wait before launching
   */
  spawn(x, y, z, color = ENERGY_COLOR, size = SIZE, delay = 0) {
    if (!this.scene) return
    // Per-box material: the burst animates opacity, which lives on the material.
    const mat = fxMaterial(new MeshBasicNodeMaterial({ color: new Color(color) }))
    const mesh = glow(new Mesh(this.geo, mat))
    mesh.position.set(x, y, z)
    mesh.rotation.y = Math.PI / 4 // corner toward the iso camera, like the units
    mesh.scale.setScalar(0.001)
    this.scene.add(mesh)

    const done = () => {
      this.scene.remove(mesh)
      mat.dispose()
    }
    // Pop up, then burst. Three beats: it appears, it leaves the building, it
    // goes off. The rise is straight up in world space.
    const tl = gsap.timeline({ delay, onComplete: done })
    tl.to(mesh.scale, { x: size, y: size, z: size, duration: 0.14, ease: 'back.out(2.5)' })
      .to(mesh.position, { y: y + RISE, duration: 0.3, ease: 'power2.out' }, 0)
      // The burst overshoots well past full size as it goes transparent, so the
      // eye reads a flash rather than a box shrinking away.
      .to(mesh.scale, { x: size * 1.8, y: size * 1.8, z: size * 1.8, duration: 0.22, ease: 'power2.out' }, 0.3)
      .to(mat, { opacity: 0, duration: 0.22, ease: 'power2.out' }, 0.3)
  }
}
