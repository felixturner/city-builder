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
/*
 * Captions over one spot QUEUE, and the queue is made of time, not rows.
 *
 * Rows were the first attempt: count what is already floating here, start the
 * new one that many rows lower. It failed as soon as the captions came fast -
 * spam the build key and the count runs past the row cap, so everything lands on
 * the bottom row together; and a row freed by an expiry gets handed to a new
 * caption while the old occupant is still on screen.
 *
 * Spacing them in TIME has no such state to get wrong. They all rise at the same
 * pixels-per-second, so holding each one back until the previous has climbed a
 * row leaves exactly a row between them, however many are queued and whatever
 * expired in between. The column remembers only when the next one may pop.
 */
// Seconds between pops in a column: one row of rise at `pixelRise` per second.
const QUEUE_GAP = 40 / 70
// Longest a caption will sit waiting. Past this the queue stops growing and they
// start doubling up - at that rate the exact spacing is not the readable part
// any more, and a caption that appears seconds after the click it belongs to is
// worse than one that overlaps.
const QUEUE_MAX_WAIT = 1.2
// Captions still waiting in a queue MERGE when they say the same kind of thing:
// clicking a tower up four floors becomes one "-24" rather than four "-6"s
// fighting for the same air. Only pending ones merge - a caption already on
// screen is not rewritten under the player's eye.
const MERGEABLE = /^([+-])(\d+(?:\.\d+)?)(.*)$/
// Size of a "column" in world units: captions binned to the same cell of this
// grid queue behind each other. Grouping by x/z and ignoring y is what "on this
// tile" means - captions from one tower come from different heights (towerTopY
// + 0.5 here, + 1.0 there, and the top itself moves as the tower grows).
const COLUMN_SIZE = 3

export class FloatingText {
  constructor() {
    this.items = []
    this.time = 0 // seconds since start, for the per-column queues
    this._columns = new Map() // column key -> { nextPopAt, y }
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
    // Merge into a pending caption of the same kind before taking a slot.
    if (this._merge(x, z, text, color)) { el.remove(); return }
    this.container.appendChild(el)
    const q = this._enqueue(x, y, z, delay)
    this.items.push({
      el, x, y: q.y, z, life: 0, delay: q.delay, sound, color,
      started: false, scale: { s: 0 },
    })
  }

  /**
   * Fold a new caption into one still waiting in the same column, if the two say
   * the same thing about the same quantity: same sign, same trailing words, same
   * colour. Returns true if it was absorbed.
   */
  _merge(x, z, text, color) {
    const m = MERGEABLE.exec(text)
    if (!m) return false
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (it.started) continue // already on screen; leave it alone
      if (Math.abs(it.x - x) >= COLUMN_SIZE || Math.abs(it.z - z) >= COLUMN_SIZE) continue
      // The colour as PASSED, not el.style.color - the DOM normalises a hex
      // string to rgb(), so comparing against the style never matched and
      // nothing ever merged.
      if (it.color !== color) continue
      const p = MERGEABLE.exec(it.el.textContent)
      if (!p || p[1] !== m[1] || p[3] !== m[3]) continue
      const sum = parseFloat(p[2]) + parseFloat(m[2])
      it.el.textContent = `${p[1]}${Math.round(sum * 100) / 100}${p[3]}`
      return true
    }
    return false
  }

  /**
   * Book this caption a slot in its column's queue.
   *
   * Returns the delay to hold it for and the height to anchor it at - the
   * height of whatever started the queue, so a stream rises from one point
   * rather than stepping around as the tower under it grows.
   */
  _enqueue(x, y, z, delay) {
    const key = `${Math.round(x / COLUMN_SIZE)}:${Math.round(z / COLUMN_SIZE)}`
    const col = this._columns.get(key)
    const now = this.time
    let popAt = now + delay
    let anchorY = y
    // A column whose queue has already drained starts a fresh one at this
    // caption's own height; one still running holds the height it began with.
    if (col && col.nextPopAt > popAt) {
      popAt = Math.min(col.nextPopAt, now + delay + QUEUE_MAX_WAIT)
      anchorY = col.y
    }
    this._columns.set(key, { nextPopAt: popAt + QUEUE_GAP, y: anchorY })
    if (this._columns.size > 64) this._pruneColumns()
    return { delay: popAt - now, y: anchorY }
  }

  /** Forget columns whose queues drained a while ago. */
  _pruneColumns() {
    for (const [key, col] of this._columns) {
      if (col.nextPopAt < this.time - QUEUE_GAP) this._columns.delete(key)
    }
  }

  /** Project + animate captions. Safe to call every frame (even while paused). */
  update(camera, dt) {
    this.time += dt // the queue clock runs whether or not anything is floating
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
      const sy = (-this._v.y * 0.5 + 0.5) * h - this.pixelRise * p
      it.el.style.left = `${sx}px`
      it.el.style.top = `${sy}px`
      it.el.style.transform = `translate(-50%, -50%) scale(${it.scale.s})`
      it.el.style.opacity = String(Math.min(1, (1 - p) * 2.5)) // hold opaque, fade only at the end
    }
  }
}
