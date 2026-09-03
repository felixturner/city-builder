import { Mesh, BufferGeometry, Float32BufferAttribute, MeshBasicNodeMaterial, Color } from 'three/webgpu'
import { fxMaterial, glow } from './fx.js'

/**
 * Arrows on the ground pointing IN from the sides the next wave arrives from.
 *
 * Each warned edge shows the original BIG arrow sitting just outside the
 * outline (tip touching it), plus a short trail of SMALLER arrows continuing
 * inward toward the king - the warning reads as the path the swarm will take.
 *
 * House fx material throughout: additive blending (a floor overlay that can
 * never darken the ground) with depthTest on / depthWrite off, so towers can
 * still occlude the inner arrows at low camera angles.
 */
// The big arrow: length and width equal so it reads the same from every side.
const BIG_CELLS = 3.2
// The trail: 2-cell arrows every other 2 cells (2 of arrow, 2 of gap),
// marching inward from the outline toward the king.
const SMALL_CELLS = 2
const TRAIL_COUNT = 2
const TRAIL_PERIOD_CELLS = 4 // arrow + gap
const Y = 0.12 // on the floor, above the grid and the flow field
// A clump pouring out of an edge kicks that edge's arrows to full brightness
// and lets them fall back over FLASH_TIME - opacity only, never scale.
const FLASH_TIME = 0.7
const FLASH_ALPHA = 1.0
// Opacity blinks in the window before a swarm arrives on an edge - both the
// pre-wave countdown and each mid-wave swarm get the same warning.
const ARRIVAL_FLASHES = 5
const FLASH_WINDOW = 2.5 // seconds of flashing = ARRIVAL_FLASHES at 2Hz
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

    this.bigGeo = triangle(BIG_CELLS)
    this.smallGeo = triangle(SMALL_CELLS)

    this.flashes = [0, 0, 0, 0] // per-edge clump-flash envelope, 1 -> 0
    this.edges = []
    for (let i = 0; i < 4; i++) {
      // One material per edge: the big arrow and its trail flash as one thing.
      const mat = fxMaterial(new MeshBasicNodeMaterial({ opacity: 0 }))
      const meshes = []
      for (let k = 0; k <= TRAIL_COUNT; k++) {
        const mesh = glow(new Mesh(k === 0 ? this.bigGeo : this.smallGeo, mat))
        mesh.visible = false
        mesh.renderOrder = 4
        mesh.scale.setScalar(this.city.cellUnit)
        demo.scene.add(mesh)
        meshes.push(mesh)
      }
      this.edges.push({ meshes, mat })
    }
  }

  /** Kick an edge's arrows to full - a clump just started pouring out of it. */
  flash(edge) {
    if (edge >= 0 && edge < this.flashes.length) this.flashes[edge] = 1
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
    const half = this.city.visibleHalf
    // Big arrow centred half a length past the bounds: tip on the outline.
    const rBig = half + (BIG_CELLS / 2) * cu

    for (let edge = 0; edge < 4; edge++) {
      const { meshes, mat } = this.edges[edge]
      if (!edges.includes(edge)) { for (const m of meshes) m.visible = false; continue }
      mat.color.copy(this._colour)

      // How long until something pours out of THIS edge: the wave countdown
      // covers its opening swarms; mid-wave, each edge's next planned swarm.
      const swarmIn = countdown ? away : creeps.nextSwarmIn(edge)
      let alpha
      if (swarmIn <= FLASH_WINDOW) {
        // ARRIVAL_FLASHES square-wave blinks across the window - discrete
        // opacity flashes, not a throb, and never scale.
        const on = ((FLASH_WINDOW - swarmIn) / FLASH_WINDOW) * ARRIVAL_FLASHES % 1 < 0.5
        alpha = on ? FLASH_ALPHA : ALPHA_LOW
      } else {
        alpha = countdown ? ALPHA_COUNTDOWN : ALPHA_STEADY
      }
      // The clump flash rides OVER whatever the arrows are already doing, so a
      // clump pouring during the steady phase still reads as an event.
      const f = this.flashes[edge]
      mat.opacity = f > 0 ? Math.max(alpha, FLASH_ALPHA * f) : alpha

      // Edges 0/1 are the two X sides, 2/3 the two Z sides. The big arrow sits
      // outside the outline; the small trail continues inward toward the king.
      // Every arrow points the way the creeps will travel.
      for (let k = 0; k < meshes.length; k++) {
        const mesh = meshes[k]
        // k=0: the big arrow. k>=1: small arrow centred (k*period - 1) cells
        // INSIDE the outline (2 gap + 2 arrow per period).
        const r = k === 0 ? rBig : half - (k * TRAIL_PERIOD_CELLS - 1) * cu
        let x = 0, z = 0, yaw = 0
        if (edge === 0) { x = -r; yaw = Math.PI / 2 } // from -X, pointing +X
        else if (edge === 1) { x = r; yaw = -Math.PI / 2 }
        else if (edge === 2) { z = -r; yaw = 0 } // from -Z, pointing +Z
        else { z = r; yaw = Math.PI }
        mesh.position.set(x, Y, z)
        mesh.rotation.set(0, yaw, 0)
        mesh.visible = true
      }
    }
  }

  _hideAll() {
    for (const { meshes } of this.edges) for (const m of meshes) m.visible = false
  }
}
