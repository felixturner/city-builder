import { Mesh, CylinderGeometry, MeshBasicNodeMaterial, Vector3, Quaternion } from 'three/webgpu'
import { fxMaterial, glow } from '../fx.js'

/**
 * A small pool of reusable beam cylinders - the flash a laser leaves behind.
 *
 * Turrets and laser creeps shoot the same kind of beam at each other, and both
 * had their own byte-identical copy of this: the same pool of eight, the same
 * stretch-a-unit-cylinder-between-two-points maths, the same fade loop. The only
 * things that ever differed are the numbers below.
 *
 * The cylinder is built one unit long along Y and then rotated onto the shot
 * direction and scaled to length, so a single geometry serves every beam.
 */
export class BeamPool {
  /**
   * @param {Scene} scene
   * @param {Object} [opts]
   * @param {number} [opts.radius=0.2] - beam thickness
   * @param {number} [opts.duration=0.16] - seconds a flash lingers
   * @param {number} [opts.count=8] - pool size; the oldest is reused past this
   */
  constructor(scene, { radius = 0.2, duration = 0.16, count = 8 } = {}) {
    this.scene = scene
    this.duration = duration
    this.geo = new CylinderGeometry(radius, radius, 1, 8) // unit length along Y
    this.beams = []
    for (let i = 0; i < count; i++) {
      const mat = fxMaterial(new MeshBasicNodeMaterial({ opacity: 0 }))
      const mesh = glow(new Mesh(this.geo, mat))
      mesh.visible = false
      scene.add(mesh)
      this.beams.push({ mesh, life: 0, active: false })
    }
    this._dir = new Vector3()
    this._up = new Vector3(0, 1, 0)
    this._q = new Quaternion()
  }

  /** Light up a pooled cylinder stretched from `from` to `to`. */
  fire(from, to, color) {
    // Pool exhausted: steal the oldest rather than allocate. A ninth beam in a
    // 0.16s window is not something anyone can follow anyway.
    const beam = this.beams.find(b => !b.active) || this.beams[0]
    beam.active = true
    beam.life = 0
    const mesh = beam.mesh
    mesh.material.color.copy(color)
    mesh.material.opacity = 1
    mesh.visible = true
    this._dir.copy(to).sub(from)
    const len = this._dir.length() || 0.001
    mesh.position.copy(from).addScaledVector(this._dir, 0.5)
    this._dir.divideScalar(len)
    this._q.setFromUnitVectors(this._up, this._dir)
    mesh.quaternion.copy(this._q)
    mesh.scale.set(1, len, 1)
  }

  /** Fade out and retire active flashes. */
  update(dt) {
    for (const b of this.beams) {
      if (!b.active) continue
      b.life += dt
      if (b.life >= this.duration) { b.active = false; b.mesh.visible = false }
      else b.mesh.material.opacity = 1 - b.life / this.duration
    }
  }
}
