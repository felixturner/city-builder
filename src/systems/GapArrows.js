import { Mesh, MeshBasicNodeMaterial, Color } from 'three/webgpu'
import { fxMaterial, glow, triangle } from '../fx.js'
import { WARN } from '../palette.js'

/**
 * A yellow arrow on every cell that is one tile short of sealing a ring.
 *
 * Enclosure._findGaps does the finding; this only draws it. The arrow sits in
 * the cell OUTSIDE the hole and points in at it, so it reads as "a wall goes
 * there" rather than as something happening inside the ring.
 *
 * Advice, not an alarm - so it is yellow rather than the wave arrows' orange,
 * and it breathes on a slow sine instead of the wave arrows' stutter. Anything
 * sharper would compete with the warnings that actually mean something is
 * coming.
 */
const SIZE_CELLS = 1
const Y = 0.13 // just above the wave arrows, which sit at 0.12
const ALPHA_LOW = 0.35
const ALPHA_HIGH = 0.8
const PULSE = 1.6 // seconds for a full breath

export class GapArrows {
  constructor(demo) {
    this.demo = demo
    this.city = demo.city
    this.geo = triangle(SIZE_CELLS)
    this.mat = fxMaterial(new MeshBasicNodeMaterial({
      color: new Color(WARN.gap), opacity: ALPHA_LOW,
    }))
    this.pool = []
    this.shown = 0
    this.t = 0
    this._version = -1
  }

  /** Grow the pool to `n` arrows; they are hidden, not destroyed, when unused. */
  _ensure(n) {
    while (this.pool.length < n) {
      const m = new Mesh(this.geo, this.mat)
      m.rotation.x = 0
      m.visible = false
      glow(m)
      this.city.scene.add(m)
      this.pool.push(m)
    }
  }

  update(dt) {
    const enc = this.city.enclosure
    const gaps = enc?.gaps
    // The list only changes when the board does, so place the arrows then and
    // spend the other frames on the pulse alone.
    if (enc && enc.gapsVersion !== this._version) {
      this._version = enc.gapsVersion
      this._place(gaps || [])
    }
    if (!this.shown) return
    this.t += dt
    const k = (Math.sin((this.t / PULSE) * Math.PI * 2) + 1) / 2
    this.mat.opacity = ALPHA_LOW + (ALPHA_HIGH - ALPHA_LOW) * k
  }

  _place(gaps) {
    this._ensure(gaps.length)
    const city = this.city
    const cu = city.cellUnit
    for (let i = 0; i < this.pool.length; i++) {
      const m = this.pool[i]
      const g = gaps[i]
      if (!g) { m.visible = false; continue }
      // Centre of the gap cell, then one cell back OUT along the inward axis.
      const cx = (g.gx + 0.5) * cu + city.gridOffsetX - g.ix * cu
      const cz = (g.gy + 0.5) * cu + city.gridOffsetZ - g.iy * cu
      m.position.set(cx, Y, cz)
      // The triangle points at +Z, so yaw it onto (ix, iy).
      m.rotation.y = Math.atan2(g.ix, g.iy)
      m.visible = true
    }
    this.shown = gaps.length
  }

  hideAll() {
    for (const m of this.pool) m.visible = false
    this.shown = 0
    this._version = -1
  }
}
