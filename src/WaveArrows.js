import { Mesh, BufferGeometry, Float32BufferAttribute, MeshBasicNodeMaterial, Color, Vector2 } from 'three/webgpu'
import { fxMaterial, glow } from './fx.js'

/**
 * Big arrows on the ground pointing IN from the sides the next wave arrives
 * from, sitting just outside the city.
 *
 * These used to be small triangles pinned to the edge of the viewport. Screen
 * space is the wrong place for them: you read the board, not the bezel, and an
 * arrow at the edge of the window tells you a compass direction rather than a
 * place. On the floor they sit in the same space as the thing they are warning
 * about, and you can see at a glance which of your walls is about to be tested.
 *
 * They sit on the EDGE OF THE BOUNDS - tip touching the white outline, body out
 * in the walkable field beyond it. The bounds are what reads as "the board", so
 * an arrow coming in off one names a side of the thing you are defending, and it
 * moves with the board when a ring opens. Inside the line they sat on top of the
 * tiles you are trying to read while you build.
 *
 * They used to ride a radius derived from how far you had BUILT, which wandered
 * as the city grew: build compactly and the arrows sat in empty dark ground
 * nowhere near anything, and they moved every time you placed a tile.
 */
// Length and width are equal on purpose: the arrow sits in a square, so it
// looks the same size whichever side a wave is coming from.
const LENGTH_CELLS = 3.2 // arrow length, tip to tail
const WIDTH_CELLS = 3.2 // arrow width across the barbs
const Y = 0.12 // on the floor, above the grid and the flow field
// A swarm about to pour out of an edge sets that arrow blinking - FLASH_PULSES
// beats over FLASH_TIME, decaying as it goes. The horn says a swarm is coming;
// this says which side, which the horn alone cannot. A single fade read as
// something that had already happened; a blink reads as a countdown.
const FLASH_TIME = 1.2
const FLASH_PULSES = 4
const FLASH_ALPHA = 1.0 // opacity a beat peaks at, over the steady 0.7
// How far INSIDE the bounds the arrow sits, in cells. Its tip used to touch the
// outline from outside; overlapping the board a little ties it to the ground it
// is warning about rather than floating off the edge of it.
const OVERLAP_CELLS = 2
// A second, smaller arrow beside the king, pointing the same way. The edge arrow
// says which side; this one says it again where you are actually looking, which
// on a full board is the middle.
const KING_ARROW_SCALE = 0.5
const KING_ARROW_CELLS = 2 // how far from the king it sits, toward the incoming side

export class WaveArrows {
  constructor(demo) {
    this.demo = demo
    this.creeps = demo.creeps
    this.city = demo.city
    this._colour = new Color()

    // A plain triangle pointing toward +Z, wound face-up so it isn't back-face
    // culled by a camera looking down at the board.
    const L = LENGTH_CELLS / 2, W = WIDTH_CELLS / 2
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute([
      0, 0, L,
      W, 0, -L,
      -W, 0, -L,
    ], 3))
    geo.computeVertexNormals()
    this.geo = geo

    this.flashes = [0, 0, 0, 0] // per-edge flash envelope, 1 -> 0
    this._lastT = 0
    const makeArrow = () => {
      const mat = fxMaterial(new MeshBasicNodeMaterial({ opacity: 0 }))
      const mesh = glow(new Mesh(geo, mat))
      mesh.visible = false
      mesh.renderOrder = 4
      demo.scene.add(mesh)
      return { mesh, mat }
    }
    this.arrows = []
    for (let i = 0; i < 4; i++) this.arrows.push(makeArrow())
    // The king's own marker: same arrow, half size, sitting just off the king on
    // the side the wave is coming from.
    this.kingArrow = makeArrow()
  }

  /**
   * Distance from the centre to an arrow's MIDDLE. The arrow is drawn centred on
   * its own length, so half a length past the bounds would put its tip exactly on
   * the outline; OVERLAP_CELLS pulls it back in so the head lies over the board
   * and the tail hangs out in the field the creeps walk in from.
   */
  _radius() {
    return this.city.visibleHalf + (LENGTH_CELLS / 2 - OVERLAP_CELLS) * this.city.cellUnit
  }

  /** Start an edge's arrow blinking - a swarm is about to pour out of it. */
  flash(edge) {
    if (edge >= 0 && edge < this.flashes.length) this.flashes[edge] = 1
  }

  /**
   * Brightness of an edge's blink right now, 0..1.
   *
   * A decaying pulse train rather than a single fade: `env` is how much of the
   * warning is left, `pulse` is where it is within the current beat. Multiplied,
   * the arrow blinks FLASH_PULSES times and each beat is weaker than the last,
   * so it reads as a countdown running out rather than one thing that happened.
   */
  _flashLevel(edge) {
    const env = this.flashes[edge]
    if (env <= 0) return 0
    const elapsed = (1 - env) * FLASH_TIME
    const pulse = Math.abs(Math.sin((elapsed / FLASH_TIME) * Math.PI * FLASH_PULSES))
    return env * pulse
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

    let wave, alpha
    if (away <= lead && away >= 0) {
      // A countdown outranks stragglers - what is about to arrive matters more
      // than where the last few came from.
      wave = clock.waveNumber
      const urgency = 1 - away / lead
      alpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(away * (1.4 + urgency * 4) * Math.PI * 2))
    } else if (spawning) {
      wave = clock.waveNumber
      alpha = 0.7 // steady: "they are over there", not "brace"
    } else if (stragglers && creeps._lastWave >= 0) {
      wave = creeps._lastWave // the wave the survivors actually came from
      alpha = 0.7
    } else {
      return this._hideAll()
    }

    const boss = clock.isBossWave(wave)
    this._colour.set(boss ? 0xff2a4a : 0xcc5500)
    const edges = clock.waveEdges(wave)
    const r = this._radius()

    for (let edge = 0; edge < 4; edge++) {
      const { mesh, mat } = this.arrows[edge]
      if (!edges.includes(edge)) { mesh.visible = false; continue }
      // Edges 0/1 are the two X sides, 2/3 the two Z sides. Place the arrow out
      // along that axis and turn it to point back at the city - the direction
      // the creeps will travel, not the direction they are from.
      let x = 0, z = 0, yaw = 0
      if (edge === 0) { x = -r; yaw = Math.PI / 2 } // from -X, pointing +X
      else if (edge === 1) { x = r; yaw = -Math.PI / 2 }
      else if (edge === 2) { z = -r; yaw = 0 } // from -Z, pointing +Z
      else { z = r; yaw = Math.PI }
      mesh.position.set(x, Y, z)
      mesh.rotation.set(0, yaw, 0)
      mat.color.copy(this._colour)
      // The flash rides OVER whatever the arrow is already doing, so a clump
      // pouring during the steady phase still reads as an event.
      const f = this._flashLevel(edge)
      mat.opacity = f > 0 ? Math.max(alpha, FLASH_ALPHA * f) : alpha
      // A touch bigger at the peak: opacity alone is easy to miss on a board
      // with a hundred things moving on it.
      mesh.scale.setScalar(this.city.cellUnit * (1 + 0.25 * f))
      mesh.visible = true
      this._placeKingArrow(edge, yaw, mat.opacity, f)
    }
  }

  /**
   * The small arrow beside the king, pointing the way the wave will come.
   *
   * Offset toward the incoming side rather than centred on the king, so it reads
   * as something arriving from over there rather than a decoration on the tile.
   * Shares the edge arrow's colour, alpha and flash - it is the same warning,
   * repeated where the eye already is.
   */
  _placeKingArrow(edge, yaw, alpha, flash) {
    const king = this.city.king
    const { mesh, mat } = this.kingArrow
    if (!king || !king.visible || !this.city.kingAlive) { mesh.visible = false; return }
    const c = king.box.getCenter(this._kingC || (this._kingC = new Vector2()))
    const d = KING_ARROW_CELLS * this.city.cellUnit
    // Back along the arrow's own facing: it points at the city, so stepping the
    // other way puts it on the side the creeps are coming from.
    let x = c.x + this.city.gridOffsetX, z = c.y + this.city.gridOffsetZ
    if (edge === 0) x -= d
    else if (edge === 1) x += d
    else if (edge === 2) z -= d
    else z += d
    mesh.position.set(x, Y, z)
    mesh.rotation.set(0, yaw, 0)
    mat.color.copy(this._colour)
    mat.opacity = alpha
    mesh.scale.setScalar(this.city.cellUnit * KING_ARROW_SCALE * (1 + 0.25 * flash))
    mesh.visible = true
  }

  _hideAll() {
    for (const { mesh } of this.arrows) mesh.visible = false
    this.kingArrow.mesh.visible = false
  }
}
