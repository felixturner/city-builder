import { Mesh, BufferGeometry, Float32BufferAttribute, MeshBasicNodeMaterial, Color, Vector2 } from 'three/webgpu'
import { fxMaterial, glow } from './fx.js'

/**
 * Arrows on the ground pointing IN from the sides the next wave arrives from.
 *
 * Each warned edge shows the original BIG arrow (head overlapping the board,
 * tail out in the field, exactly where it always sat) plus a trail of SMALLER
 * arrows running the whole way in to the king - innermost tip one cell from
 * it - so the warning reads as the path the swarm will take.
 *
 * House fx material throughout: additive blending (a floor overlay that can
 * never darken the ground) with depthTest on / depthWrite off, so towers can
 * still occlude the inner arrows at low camera angles.
 */
// Length and width are equal on purpose: the arrow sits in a square, so it
// looks the same size whichever side a wave is coming from.
const LENGTH_CELLS = 3.2 // the big edge arrow, tip to tail
const SMALL_CELLS = 2 // the trail arrows
const TRAIL_GAP_CELLS = 1 // daylight between consecutive trail arrows
const KING_CLEARANCE_CELLS = 1 // innermost tip stops this far from the king
const Y = 0.12 // on the floor, above the grid and the flow field
// How far INSIDE the bounds the big arrow sits, in cells. Its tip used to touch
// the outline from outside; overlapping the board a little ties it to the
// ground it is warning about rather than floating off the edge of it.
const OVERLAP_CELLS = 2
// A swarm pouring out of an edge sets that edge's arrows blinking -
// FLASH_PULSES beats over FLASH_TIME, decaying as it goes. Opacity only,
// never scale.
const FLASH_TIME = 1.2
const FLASH_PULSES = 4
const FLASH_ALPHA = 1.0
// ...and BEFORE a swarm arrives, the edge blinks ARRIVAL_FLASHES times across
// FLASH_WINDOW seconds - both the pre-wave countdown and each mid-wave swarm
// (Creeps.nextSwarmIn) get the same warning.
const ARRIVAL_FLASHES = 5
const FLASH_WINDOW = 2.5
const ALPHA_STEADY = 0.7 // "they are over there", not "brace"
const ALPHA_COUNTDOWN = 0.45 // early countdown, before the flashing starts
const ALPHA_LOW = 0.25 // the off half of a flash

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

    this.flashes = [0, 0, 0, 0] // per-edge flash envelope, 1 -> 0
    this.edges = []
    for (let i = 0; i < 4; i++) {
      // One material per edge: the big arrow and its whole trail brighten and
      // blink as one thing. Trail meshes are grown lazily - how many fit
      // depends on how far the board has opened.
      const mat = fxMaterial(new MeshBasicNodeMaterial({ opacity: 0 }))
      const big = glow(new Mesh(this.bigGeo, mat))
      big.visible = false
      big.renderOrder = 4
      big.scale.setScalar(this.city.cellUnit)
      demo.scene.add(big)
      this.edges.push({ big, trail: [], mat })
    }
  }

  /**
   * Distance from the centre to the big arrow's MIDDLE. Half a length past the
   * bounds would put its tip exactly on the outline; OVERLAP_CELLS pulls it
   * back in so the head lies over the board and the tail hangs out in the
   * field the creeps walk in from.
   */
  _radius() {
    return this.city.visibleHalf + (LENGTH_CELLS / 2 - OVERLAP_CELLS) * this.city.cellUnit
  }

  /** Start an edge's arrows blinking - a swarm is pouring out of it. */
  flash(edge) {
    if (edge >= 0 && edge < this.flashes.length) this.flashes[edge] = 1
  }

  /**
   * Brightness of an edge's blink right now, 0..1.
   *
   * A decaying pulse train rather than a single fade: `env` is how much of the
   * warning is left, `pulse` is where it is within the current beat. Multiplied,
   * the arrows blink FLASH_PULSES times and each beat is weaker than the last,
   * so it reads as a countdown running out rather than one thing that happened.
   */
  _flashLevel(edge) {
    const env = this.flashes[edge]
    if (env <= 0) return 0
    const elapsed = (1 - env) * FLASH_TIME
    const pulse = Math.abs(Math.sin((elapsed / FLASH_TIME) * Math.PI * FLASH_PULSES))
    return env * pulse
  }

  /** The trail pool for an edge, grown to `n` meshes on demand. */
  _trailMeshes(edge, n) {
    const e = this.edges[edge]
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

  update(dt = 0) {
    for (let i = 0; i < this.flashes.length; i++) {
      if (this.flashes[i] > 0) this.flashes[i] = Math.max(0, this.flashes[i] - dt / FLASH_TIME)
    }
    const creeps = this.creeps
    if (!creeps || !creeps.started) return this._hideAll()

    const clock = creeps.clock
    const away = clock.timeToWave // <= 0 once this cycle's wave has landed
    const lead = clock.leadFor(clock.waveNumber)
    const spawning = clock.isSpawning
    // Creeps still alive after their spawn window closes carry on into the NEXT
    // cycle's build phase, by which point clock.waveNumber has already ticked
    // over. Pointing at that wave's edges while the survivors of the last one are
    // still walking in from somewhere else is exactly the mismatch you'd see:
    // the arrows are honest about a wave that has not spawned yet.
    const stragglers = !spawning && creeps.creeps.length > 0

    let wave, countdown = false
    if (away <= lead && away >= 0) {
      // A countdown outranks stragglers - what is about to arrive matters more
      // than where the last few came from.
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
    this._colour.set(boss ? 0xff2a4a : 0xcc5500)
    const edges = clock.waveEdges(wave)
    const cu = this.city.cellUnit
    const r = this._radius()

    // The trail aims at the KING, not the board centre - same anchor the old
    // king-side arrow used.
    const king = this.city.king
    const kingOk = king && king.visible && this.city.kingAlive
    const kc = kingOk ? king.box.getCenter(this._kingC) : null
    const kx = kingOk ? kc.x + this.city.gridOffsetX : 0
    const kz = kingOk ? kc.y + this.city.gridOffsetZ : 0

    for (let edge = 0; edge < 4; edge++) {
      const e = this.edges[edge]
      if (!edges.includes(edge)) {
        e.big.visible = false
        for (const m of e.trail) m.visible = false
        continue
      }
      e.mat.color.copy(this._colour)

      // How long until something pours out of THIS edge: the wave countdown
      // covers its opening swarms; mid-wave, each edge's next planned swarm.
      const swarmIn = countdown ? away : creeps.nextSwarmIn(edge)
      let alpha
      if (swarmIn <= FLASH_WINDOW) {
        // ARRIVAL_FLASHES square-wave blinks across the window before it lands.
        const on = ((FLASH_WINDOW - swarmIn) / FLASH_WINDOW) * ARRIVAL_FLASHES % 1 < 0.5
        alpha = on ? FLASH_ALPHA : ALPHA_LOW
      } else {
        alpha = countdown ? ALPHA_COUNTDOWN : ALPHA_STEADY
      }
      // The pouring flash rides OVER whatever the arrows are already doing.
      const f = this._flashLevel(edge)
      e.mat.opacity = f > 0 ? Math.max(alpha, FLASH_ALPHA * f) : alpha

      // Edges 0/1 are the two X sides, 2/3 the two Z sides. Every arrow points
      // the way the creeps will travel.
      let x = 0, z = 0, yaw = 0
      if (edge === 0) { x = -r; yaw = Math.PI / 2 } // from -X, pointing +X
      else if (edge === 1) { x = r; yaw = -Math.PI / 2 }
      else if (edge === 2) { z = -r; yaw = 0 } // from -Z, pointing +Z
      else { z = r; yaw = Math.PI }
      e.big.position.set(x, Y, z)
      e.big.rotation.set(0, yaw, 0)
      e.big.visible = true

      // The trail: small arrows from just short of the big arrow all the way in
      // to the king, TRAIL_GAP_CELLS of daylight apart, innermost tip
      // KING_CLEARANCE_CELLS from the king.
      if (!kingOk) { for (const m of e.trail) m.visible = false; continue }
      const period = (SMALL_CELLS + TRAIL_GAP_CELLS) * cu
      // Distance (along the approach axis) from the king to the first trail
      // arrow's CENTRE, then step outward until we'd run into the big arrow.
      const first = (KING_CLEARANCE_CELLS + SMALL_CELLS / 2) * cu
      const max = r - (LENGTH_CELLS / 2 + TRAIL_GAP_CELLS) * cu
      const n = Math.max(0, Math.floor((max - first) / period) + 1)
      const trail = this._trailMeshes(edge, n)
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
    for (const e of this.edges) {
      e.big.visible = false
      for (const m of e.trail) m.visible = false
    }
  }
}
