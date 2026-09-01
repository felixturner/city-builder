import { Mesh, BufferGeometry, Float32BufferAttribute, MeshBasicNodeMaterial, Color } from 'three/webgpu'
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

    this.arrows = []
    for (let i = 0; i < 4; i++) {
      const mat = fxMaterial(new MeshBasicNodeMaterial({ opacity: 0 }))
      const mesh = glow(new Mesh(geo, mat))
      mesh.visible = false
      mesh.renderOrder = 4
      demo.scene.add(mesh)
      this.arrows.push({ mesh, mat })
    }
  }

  /**
   * Distance from the centre to an arrow's MIDDLE. The arrow is drawn centred on
   * its own length, so pushing it half a length past the bounds lands its tip on
   * the outline with the rest of it sitting outside - between the board edge and
   * the ring creeps actually spawn on (bounds + one lot), so it never overlaps
   * either.
   */
  _radius() {
    return this.city.visibleHalf + (LENGTH_CELLS / 2) * this.city.cellUnit
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
      mesh.scale.setScalar(this.city.cellUnit)
      mat.color.copy(this._colour)
      mat.opacity = alpha
      mesh.visible = true
    }
  }

  _hideAll() {
    for (const { mesh } of this.arrows) mesh.visible = false
  }
}
