import { Mesh, BufferGeometry, Float32BufferAttribute, MeshBasicNodeMaterial, Color, Vector2 } from 'three/webgpu'
import gsap from 'gsap'
import { fxMaterial, glow, stutter } from './fx.js'
import { WARN } from './palette.js'

/**
 * Arrows on the ground pointing IN from the sides the next wave arrives from.
 *
 * Each warned edge shows the original BIG arrow (head overlapping the board,
 * tail out in the field) plus a trail of SMALLER arrows running the whole way
 * in to the king - innermost tip one cell from it - so the warning reads as
 * the path the swarm will take.
 *
 * Opacity is driven by gsap, one clear behaviour at a time:
 *   - the arrows STRIKE IN with a stutter when their countdown starts
 *   - an incoming swarm STUTTERS them, on the king beam's timing, as it pours
 *   - an open king USED TO override everything with a steady alarm blink. Off
 *     for now: it ran until the king was sealed, which is most of a bad round,
 *     and drowned out the one flicker that means something is coming.
 * Between tweens the opacity rests at a steady base level set per frame.
 *
 * House fx material throughout: additive blending with depthTest on /
 * depthWrite off, so towers can occlude the inner arrows at low angles.
 */
const LENGTH_CELLS = 3.2 // the big edge arrow, tip to tail
// The trail arrows. One cell long with one cell of daylight, so the period is
// two whole cells - and since the king stands on a cell centre and the first
// arrow is a whole number of cells from it, every arrow lands on a cell centre
// too. Any fractional size or gap and the trail drifts against the grid it is
// drawn over.
const SMALL_CELLS = 1
const TRAIL_GAP_CELLS = 1
const KING_CLEARANCE_CELLS = 1 // cells from the king to the first trail arrow
const Y = 0.12 // on the floor, above the grid and the flow field
// How far the big arrow's tail sits OUTSIDE the play area, in cells. It used to
// overlap the board by two, which put the thing announcing an attack on top of
// the ground you are defending; out in the field it reads as coming from
// somewhere else.
const OUTSET_CELLS = 0
const FLICK = 0.15 // seconds per leg of the exposed-alarm blink
const BLEEP_PERIOD = 0.7 // seconds between exposed-alarm blinks (matches the siren)
const ALPHA_STEADY = 0.7 // "they are over there", not "brace"
const ALPHA_COUNTDOWN = 0.45 // during the pre-wave countdown

// A plain triangle pointing toward +Z, wound face-up so it isn't back-face
// culled by a camera looking down at the board.
function triangle(sizeCells) {
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

export class WaveArrows {
  constructor(demo) {
    this.demo = demo
    this.creeps = demo.creeps
    this.city = demo.city
    this._colour = new Color()
    this._kingC = new Vector2()

    this.bigGeo = triangle(LENGTH_CELLS)
    this.smallGeo = triangle(SMALL_CELLS)

    this.edges = []
    for (let i = 0; i < 4; i++) {
      // One material per edge: the big arrow and its whole trail act as one.
      const mat = fxMaterial(new MeshBasicNodeMaterial({ opacity: 0 }))
      const big = glow(new Mesh(this.bigGeo, mat))
      big.visible = false
      big.renderOrder = 4
      big.scale.setScalar(this.city.cellUnit)
      demo.scene.add(big)
      this.edges.push({
        big, trail: [], mat,
        shown: false, // fade-in played for the current appearance
        flicker: null, // active incoming-flicker timeline
        alarm: null, // active exposed-alarm timeline
        base: ALPHA_STEADY, // opacity a flicker returns to; set per frame
      })
    }
  }

  _radius() {
    return this.city.visibleHalf + (LENGTH_CELLS / 2 + OUTSET_CELLS) * this.city.cellUnit
  }

  /**
   * A swarm is pouring NOW - Creeps calls this from _release. The single
   * trigger for the stutter.
   *
   * There used to be a second, PREDICTIVE one: update() polled Creeps for how
   * far off the next swarm was, every frame, and started the stutter early so
   * it finished as the swarm landed - with this as a fallback for when that
   * missed.
   * That was worth its complexity while the stutter ran 1.5s. At 0.36s "just
   * before" and "as it lands" are the same moment, so the prediction bought
   * nothing - and once the lead-in and the stutter became the same length it
   * ended exactly as this fired, so every swarm was stuttered twice.
   */
  flash(edge) {
    const e = this.edges[edge]
    if (e && e.shown && !e.flicker && !e.alarm) this._startFlicker(e)
  }

  /**
   * The king's stutter, on an arrow (City.flickerKingBeam).
   *
   * Uneven on/off times, each gap longer than the last, so it reads as
   * something struggling to catch rather than as a strobe - which is what an
   * even five-cycle blink looked like. Same timing as the beam striking in and
   * as a shield taking a support trail, so a flicker means one thing across the
   * whole board.
   */
  _startFlicker(e) {
    e.flicker?.kill()
    // Blinks back to the edge's current level, not to 1 - the arrows rest
    // dimmer during a countdown than they do mid-wave.
    // Blinks back to the edge's current level, not to 1 - the arrows rest
    // dimmer during a countdown than they do mid-wave.
    e.flicker = stutter(gsap, e.mat, {
      prop: 'opacity', on: e.base, off: 0,
      onComplete: () => { e.flicker = null },
    })
  }

  /** The open-king alarm: one quick blink per bleep, forever until sealed. */
  _startAlarm(e) {
    e.flicker?.kill(); e.flicker = null
    e.alarm = gsap.timeline({ repeat: -1, repeatDelay: BLEEP_PERIOD - FLICK * 2 })
      .to(e.mat, { opacity: 0, duration: FLICK, ease: 'none' })
      .to(e.mat, { opacity: 1, duration: FLICK, ease: 'none' })
  }

  _stopAlarm(e) {
    e.alarm?.kill()
    e.alarm = null
  }

  /** Hide an edge and reset its animation state. */
  _hideEdge(e) {
    if (!e.shown && !e.big.visible) return
    e.flicker?.kill(); e.flicker = null
    this._stopAlarm(e)
    gsap.killTweensOf(e.mat)
    e.mat.opacity = 0
    e.shown = false
    e.big.visible = false
    for (const m of e.trail) m.visible = false
  }

  /** The trail pool for an edge, grown to `n` meshes on demand. */
  _trailMeshes(e, n) {
    while (e.trail.length < n) {
      const mesh = glow(new Mesh(this.smallGeo, e.mat))
      mesh.visible = false
      mesh.renderOrder = 4
      mesh.scale.setScalar(this.city.cellUnit)
      this.demo.scene.add(mesh)
      e.trail.push(mesh)
    }
    return e.trail
  }

  update() {
    const creeps = this.creeps
    if (!creeps || !creeps.started) return this._hideAll()

    const clock = creeps.clock
    const away = clock.timeToWave // <= 0 once this cycle's wave has landed
    const lead = clock.leadFor(clock.waveNumber)
    const spawning = clock.isSpawning
    // Creeps still alive after their spawn window closes carry on into the NEXT
    // cycle's build phase, by which point clock.waveNumber has already ticked
    // over - the arrows stay honest about a wave that has not spawned yet.
    const stragglers = !spawning && creeps.creeps.length > 0

    let wave, countdown = false
    if (away <= lead && away >= 0) {
      wave = clock.waveNumber
      countdown = true
    } else if (spawning) {
      wave = clock.waveNumber
    } else if (stragglers && creeps._lastWave >= 0) {
      wave = creeps._lastWave // the wave the survivors actually came from
    } else {
      return this._hideAll()
    }

    const boss = clock.isBossWave(wave)
    this._colour.set(boss ? WARN.arrowBoss : WARN.arrow)
    const edges = clock.waveEdges(wave)
    const cu = this.city.cellUnit
    const r = this._radius()

    // The trail aims at the KING, not the board centre.
    const king = this.city.king
    const kingOk = king && king.visible && this.city.kingAlive
    const kc = kingOk ? king.box.getCenter(this._kingC) : null
    const kx = kingOk ? kc.x + this.city.gridOffsetX : 0
    const kz = kingOk ? kc.y + this.city.gridOffsetZ : 0

    for (let edge = 0; edge < 4; edge++) {
      const e = this.edges[edge]
      if (!edges.includes(edge)) { this._hideEdge(e); continue }
      e.mat.color.copy(this._colour)

      const base = countdown ? ALPHA_COUNTDOWN : ALPHA_STEADY
      e.base = base // the stutter blinks back to this

      // First frame of this appearance: strike in with the stutter, the same way
      // the king's beam does and the same way a swarm pouring reads. A half
      // second fade said "something is gradually becoming true"; these arrows
      // are an alarm going off.
      if (!e.shown) {
        e.shown = true
        this._startFlicker(e)
      }

      // The open-king alarm is off for now - it ran forever until the king was
      // sealed and drowned out the one flicker that means something is coming.
      // _startAlarm is left in place for when it comes back.
      if (e.alarm) { this._stopAlarm(e); e.mat.opacity = base }

      // Steady level between animations.
      if (!e.flicker && !gsap.isTweening(e.mat)) e.mat.opacity = base

      // Placement. Edges 0/1 are the two X sides, 2/3 the two Z sides; every
      // arrow points the way the creeps will travel.
      let x = 0, z = 0, yaw = 0
      if (edge === 0) { x = -r; yaw = Math.PI / 2 } // from -X, pointing +X
      else if (edge === 1) { x = r; yaw = -Math.PI / 2 }
      else if (edge === 2) { z = -r; yaw = 0 } // from -Z, pointing +Z
      else { z = r; yaw = Math.PI }
      e.big.position.set(x, Y, z)
      e.big.rotation.set(0, yaw, 0)
      e.big.visible = true

      // The trail: small arrows from just short of the big one all the way in
      // to the king, every other cell centre.
      if (!kingOk) { for (const m of e.trail) m.visible = false; continue }
      const period = (SMALL_CELLS + TRAIL_GAP_CELLS) * cu
      // Whole cells from the king, so each arrow centres on a cell centre.
      const first = KING_CLEARANCE_CELLS * cu
      const max = r - (LENGTH_CELLS / 2 + TRAIL_GAP_CELLS) * cu
      const n = Math.max(0, Math.floor((max - first) / period) + 1)
      const trail = this._trailMeshes(e, n)
      for (let k = 0; k < trail.length; k++) {
        const mesh = trail[k]
        if (k >= n) { mesh.visible = false; continue }
        const d = first + k * period
        let tx = kx, tz = kz
        if (edge === 0) tx -= d
        else if (edge === 1) tx += d
        else if (edge === 2) tz -= d
        else tz += d
        mesh.position.set(tx, Y, tz)
        mesh.rotation.set(0, yaw, 0)
        mesh.visible = true
      }
    }
  }

  _hideAll() {
    for (const e of this.edges) this._hideEdge(e)
  }
}
