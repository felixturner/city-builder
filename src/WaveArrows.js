import { Vector3 } from 'three/webgpu'
import { ACCENTS } from './palette.js'

/**
 * Small triangles around the edge of the viewport during a wave's countdown,
 * pointing at the side of the board the wave will arrive from.
 *
 * Waves commit to their edges up front (Creeps.waveEdges), which only helps if
 * you know which before they land. The board is bigger than the screen at most
 * zooms and the camera can be orbited any way round, so an on-board marker is no
 * use - the warning has to live in screen space and point at where the threat
 * is, whether or not that part of the world is on screen.
 *
 * Each arrow is PROJECTED from the world every frame, so it slides around the
 * viewport edge as you orbit and always points at the real direction rather than
 * at a fixed corner of the screen.
 *
 * They come up when the countdown ticker starts (see WaveAudio, same lead
 * values) and STAY up for as long as the wave is on the board. The direction
 * matters more during the fight than before it - it is what tells you which side
 * to look at when creeps are already chewing on something - so they only go away
 * once the board is clear again.
 *
 * They read differently in the two phases: an urgent blink while you are waiting,
 * accelerating as the wave closes, then a steady hold once it has landed. A
 * flashing arrow means "brace", a solid one means "they are over there".
 */

const W = 14 // triangle half-width, px (1.5x)
const H = 23 // triangle height, px (1.5x)
const MARGIN = 30 // inset from the viewport edge - a touch more, for the bigger arrow

export class WaveArrows {
  constructor(demo) {
    this.demo = demo
    this.creeps = demo.creeps
    this._v = new Vector3()
    this.arrows = []

    const wrap = document.createElement('div')
    wrap.id = 'wave-arrows'
    Object.assign(wrap.style, {
      position: 'fixed', inset: '0', zIndex: '520',
      pointerEvents: 'none', overflow: 'hidden',
    })
    // One per board edge; only the ones the next wave uses are shown. Built from
    // CSS borders rather than a glyph so the shape is identical on every
    // platform - a font triangle picks up whatever the system font has.
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div')
      Object.assign(el.style, {
        position: 'absolute', width: '0', height: '0',
        marginLeft: `${-W}px`, marginTop: `${-H / 2}px`,
        borderLeft: `${W}px solid transparent`,
        borderRight: `${W}px solid transparent`,
        borderBottom: `${H}px solid ${ACCENTS[2]}`,
        filter: 'drop-shadow(0 0 5px rgba(0,0,0,0.9))',
        opacity: '0', transformOrigin: `${W}px ${H / 2}px`,
      })
      wrap.appendChild(el)
      this.arrows.push(el)
    }
    document.body.appendChild(wrap)
    this.el = wrap
  }

  /**
   * World point at the middle of a board edge - what the arrow points AT.
   * Matches the spawn ring in Creeps: 0/1 are the two X sides, 2/3 the Z sides.
   */
  _edgePoint(edge, out) {
    const r = this.creeps.reach
    if (edge === 0) out.set(-r, 0, 0)
    else if (edge === 1) out.set(r, 0, 0)
    else if (edge === 2) out.set(0, 0, -r)
    else out.set(0, 0, r)
    return out
  }

  update() {
    const creeps = this.creeps
    const cam = this.demo.camera
    if (!creeps || !cam || !creeps.started) return this._hideAll()

    // One cycle covers both halves, so one wave index serves the countdown and
    // the fight. A round is over when the last creep of it dies, not when the
    // spawn window shuts - the same rule the music uses, so the arrows and the
    // fight bed drop together.
    const clock = creeps.clock
    const wave = clock.waveNumber
    const away = clock.timeToWave // <= 0 once this cycle's wave has landed
    const lead = clock.leadFor(wave)
    const inCombat = clock.isSpawning || creeps.creeps.length > 0

    let blink
    if (inCombat) {
      blink = 0.85 // steady: "they are over there", not "brace"
    } else if (away <= lead && away >= 0) {
      // Flash faster as it closes, so urgency reads without checking a clock.
      const urgency = 1 - away / lead
      blink = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(away * (1.4 + urgency * 4) * Math.PI * 2))
    } else {
      return this._hideAll()
    }

    const colour = clock.isBossWave(wave) ? ACCENTS[0] : ACCENTS[2]
    const edges = clock.waveEdges(wave)
    const vw = window.innerWidth, vh = window.innerHeight
    for (let i = 0; i < 4; i++) {
      const el = this.arrows[i]
      if (!edges.includes(i)) { el.style.opacity = '0'; continue }

      // Project the edge midpoint to get its on-screen direction from centre.
      // Points behind the camera project mirrored, so flip those first.
      this._v.copy(this._edgePoint(i, this._v)).project(cam)
      const flip = this._v.z > 1 ? -1 : 1
      let sx = this._v.x * flip, sy = this._v.y * flip
      const len = Math.hypot(sx, sy) || 1
      sx /= len; sy /= len

      // Push that unit direction out to whichever viewport edge it hits first.
      const t = Math.min(
        (vw / 2 - MARGIN) / Math.max(Math.abs(sx), 1e-6),
        (vh / 2 - MARGIN) / Math.max(Math.abs(sy), 1e-6)
      )
      el.style.left = `${vw / 2 + sx * t}px`
      el.style.top = `${vh / 2 - sy * t}px` // screen y is inverted vs NDC
      // The triangle is drawn pointing up, so 0deg already means "toward the top
      // of the screen"; rotate it onto the same direction it was placed along.
      el.style.transform = `rotate(${Math.atan2(sx, sy) * 180 / Math.PI}deg)`
      el.style.borderBottomColor = colour
      el.style.opacity = String(blink)
    }
  }

  _hideAll() {
    for (const el of this.arrows) el.style.opacity = '0'
  }
}
