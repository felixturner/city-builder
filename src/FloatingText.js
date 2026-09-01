import { Vector3 } from 'three/webgpu'
import gsap from 'gsap'
import { Sounds } from './lib/Sounds.js'
import { ENERGY_COLOR } from './palette.js'

/**
 * FloatingText - short-lived "+N" captions that rise from a world position and
 * fade out (combat-text style). Spawned in world space (e.g. a building top),
 * projected to the screen each frame via the active camera. DOM-based so the
 * text stays crisp at any zoom. Each caption pops in (gsap expo scale) and can
 * trigger a sound the instant it appears.
 */
// A second caption spawned at the same spot queues UNDER the first: this far
// down the screen, and this long after it. Several bonuses can land on one tower
// in a single frame - connect a support tower to a shield inside another shield
// and three of them fire at once - and stacked on the same pixel they were one
// illegible smear.
const STACK_ROW_PX = 40
const STACK_DELAY = 0.12 // seconds between each queued caption popping in
const STACK_MAX = 4 // rows deep before they start sharing the bottom row
// How close two anchors have to be to count as "the same place", in world units.
// Matching exact coordinates did not work: captions from one tower come from
// different heights (towerTopY + 0.5 here, + 1.0 there, and the top itself moves
// as the tower grows), so nothing ever matched and they all landed on one row.
// Grouping by COLUMN - x and z, ignoring y - is what "on this tile" means.
const STACK_RADIUS = 1.5

export class FloatingText {
  constructor() {
    this.items = []
    this.duration = 1.0 // seconds each caption lives
    this.pixelRise = 70 // SCREEN pixels it floats up (zoom-independent 2D motion)
    this._v = new Vector3()

    const c = document.createElement('div')
    Object.assign(c.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: '480',
    })
    document.body.appendChild(c)
    this.container = c
  }

  /**
   * Spawn a caption at a world position.
   * @param {string} [sound] - sound name played the instant the caption pops in.
   * @param {number} [delay] - holds it hidden for N seconds before popping in.
   */
  spawn(x, y, z, text, color = ENERGY_COLOR, delay = 0, sound = null) {
    const el = document.createElement('div')
    el.textContent = text
    Object.assign(el.style, {
      position: 'absolute',
      transform: 'translate(-50%, -50%) scale(0)',
      font: '700 22px Inter, system-ui, sans-serif',
      color,
      textShadow: '0 1px 3px rgba(0,0,0,0.85)',
      whiteSpace: 'nowrap',
      willChange: 'left, top, opacity, transform',
      display: 'none',
    })
    this.container.appendChild(el)
    // Queue behind anything already floating over this column, and take the
    // first one's HEIGHT as well as its place in the queue. The row offset is in
    // screen pixels, so two captions anchored at different world heights - the
    // "-6" charged before a floor goes on and the "x3 energy" fired after it -
    // are already separated on screen by however much a floor is worth at this
    // zoom, and the offset lands the second one back on top of the first as
    // often as not. Sharing a baseline makes the row the only thing between them.
    const q = this._queueAt(x, z)
    const row = Math.min(q.count, STACK_MAX)
    this.items.push({
      el, x, y: q.count > 0 ? q.y : y, z, life: 0,
      delay: delay + row * STACK_DELAY, sound,
      started: false, scale: { s: 0 }, row,
    })
  }

  /**
   * Captions already floating over this column: how many, and the world height
   * the first of them is anchored at. `items` is chronological, so the first
   * match is the oldest - the one that set the baseline.
   */
  _queueAt(x, z) {
    let count = 0, y = 0
    for (const it of this.items) {
      if (Math.abs(it.x - x) >= STACK_RADIUS || Math.abs(it.z - z) >= STACK_RADIUS) continue
      if (count === 0) y = it.y
      count++
    }
    return { count, y }
  }

  /** Project + animate captions. Safe to call every frame (even while paused). */
  update(camera, dt) {
    if (!camera || this.items.length === 0) return
    const w = window.innerWidth
    const h = window.innerHeight
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      it.life += dt
      if (it.life < it.delay) continue // still waiting (kept hidden)

      // Pop-in: the instant the delay elapses, scale in (expo out) + play sound.
      if (!it.started) {
        it.started = true
        it.el.style.display = 'block'
        if (it.sound) Sounds.play(it.sound, 1.0, 0.2, 0.4)
        gsap.to(it.scale, { s: 1, duration: 0.45, ease: 'expo.out' })
      }

      const p = (it.life - it.delay) / this.duration
      if (p >= 1) {
        this.container.removeChild(it.el)
        this.items.splice(i, 1)
        continue
      }
      // Project the world anchor once, then travel in SCREEN pixels so the rise
      // distance is the same whether zoomed in or out (2D motion).
      this._v.set(it.x, it.y, it.z)
      this._v.project(camera)
      if (this._v.z > 1) { it.el.style.display = 'none'; continue } // behind camera
      it.el.style.display = 'block'
      const sx = (this._v.x * 0.5 + 0.5) * w
      // Its own row, so a queued caption starts below the one before it rather
      // than on top of it, and rises from there.
      const sy = (-this._v.y * 0.5 + 0.5) * h - this.pixelRise * p + it.row * STACK_ROW_PX
      it.el.style.left = `${sx}px`
      it.el.style.top = `${sy}px`
      it.el.style.transform = `translate(-50%, -50%) scale(${it.scale.s})`
      it.el.style.opacity = String(Math.min(1, (1 - p) * 2.5)) // hold opaque, fade only at the end
    }
  }
}
