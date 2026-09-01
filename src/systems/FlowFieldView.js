import {
  InstancedMesh, BufferGeometry, Float32BufferAttribute, Object3D, Color,
  MeshBasicNodeMaterial,
} from 'three/webgpu'
import { fxMaterial } from '../fx.js'
// Dark orange - reads as a hazard marker without competing with the three city
// accents, which every other coloured thing on the board already uses.
const FLOW_COLOR = new Color(0xcc5500)
// Same hue, well down in value: creeps here can't reach the king and are
// heading for a generator instead.
const FLOW_DIVERTED = new Color(0x5c3a1c)

/**
 * The creep flow field, drawn on the ground as a field of little arrows.
 *
 * The field has always routed creeps around walls - it is the deepest system in
 * the game - but the player had no way to see it, so walls read as "hit points
 * in the way" rather than as a maze you are authoring. With the whole field
 * visible, every tetromino becomes a routing decision you can evaluate BEFORE
 * committing it: lengthen the walk, bend it past your turrets, seal the king off
 * by geometry instead of by hit points.
 *
 * A field rather than a single traced route, because one line only answers "what
 * happens if a creep starts HERE" - and creeps come from four sides and re-path
 * constantly. The field answers it for every cell at once, which is the actual
 * shape of the decision.
 *
 * Arrows are one InstancedMesh, rebuilt only when the field is recomputed (which
 * is on tower changes, not per frame). Colour separates the two destinations the
 * field encodes: cells whose flow leads to the KING, and cells that lead to a
 * generator instead because the king is walled off from them.
 */

const ARROW = 0.52 // arrow length as a fraction of a cell
const Y = 0.06 // just above the ground grid, below everything else

export class FlowFieldView {
  constructor(city, creeps) {
    this.city = city
    this.creeps = creeps
    this.enabled = false // off until asked for - see GUI 'Creep Flow'
    this.mesh = null
    this._key = null
    this._dummy = new Object3D()
    this._colour = new Color()

    // A flat triangle in the XZ plane pointing toward +Z, so a Y rotation of
    // atan2(dx, dz) aims it straight down the flow direction.
    const geo = new BufferGeometry()
    // Wound so the face points UP. Back-face culling goes by winding order, not
    // by the normal attribute below - with the other winding these are all
    // facing the ground and the whole field is invisible from the game camera.
    // Square bounding box: 0.9 long, 0.9 across, so the arrow reads the same
    // whichever of the four directions it is pointing.
    geo.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0.55,
      0.45, 0, -0.35,
      -0.45, 0, -0.35,
    ], 3))
    geo.setAttribute('normal', new Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3))
    this.geo = geo
  }

  update() {
    const city = this.city
    // Shown during the fight too, not just while building. Watching creeps
    // actually follow the arrows is how you check a wall did what you meant, and
    // the fight is the only time you can see that.
    if (!this.enabled || !city.flow.ready) {
      if (this.mesh) this.mesh.visible = false
      return
    }
    // Keyed on the play area too: opening a ring adds cells to draw without
    // necessarily recomputing the field.
    const key = `${city.flow.version}:${city.visibleLots}`
    if (key !== this._key) { this._key = key; this._rebuild() }
    if (this.mesh) this.mesh.visible = true
  }

  _rebuild() {
    const city = this.city
    const W = city.gridCellsX, H = city.gridCellsY
    const cu = city.cellUnit
    const { dist, dx, dz, toKing } = city.flow.fields(false)

    // Count first so the InstancedMesh is sized once. Cells with no route, and
    // the goal cells themselves, get no arrow - there is nowhere to point.
    // Only the cells in play. The field is computed over the whole built grid so
    // creeps can walk in from outside, but drawing those arrows carpets the dark
    // out-of-bounds ground with routes you can do nothing about.
    const inPlay = (i) => city.inPlayArea(i % W, (i - (i % W)) / W)
    let count = 0
    for (let i = 0; i < W * H; i++) if (dist[i] >= 1 && (dx[i] || dz[i]) && inPlay(i)) count++
    if (!this.mesh || this.mesh.count !== count) {
      this._dispose()
      if (count === 0) return
      const mat = fxMaterial(new MeshBasicNodeMaterial({ opacity: 0.5 }))
      // Deliberately NOT on the glow layer: this is a readout, and bloom would
      // smear three thousand arrows into a haze.
      this.mesh = new InstancedMesh(this.geo, mat, count)
      this.mesh.frustumCulled = false
      this.mesh.renderOrder = 3
      city.scene.add(this.mesh)
    }
    if (count === 0) return

    // Longest route on the board, so brightness can fade with distance from the
    // goal - the field then reads as flowing INWARD at a glance.
    let longest = 1
    for (let i = 0; i < W * H; i++) if (dist[i] > longest && inPlay(i)) longest = dist[i]

    const dummy = this._dummy
    // Cells whose flow reaches the KING are the full orange; cells where the king
    // is walled off from them, so creeps divert to a generator instead, are
    // dimmed. That difference is the single most useful thing the field shows -
    // it is how you tell at a glance whether your enclosure has sealed the king
    // and sent the whole wave after your generators.
    const kingCol = FLOW_COLOR
    const genCol = FLOW_DIVERTED
    let k = 0
    for (let gy = 0; gy < H; gy++) {
      for (let gx = 0; gx < W; gx++) {
        const i = gy * W + gx
        if (dist[i] < 1 || (!dx[i] && !dz[i]) || !city.inPlayArea(gx, gy)) continue
        dummy.position.set(gx * cu + cu / 2 + city.gridOffsetX, Y, gy * cu + cu / 2 + city.gridOffsetZ)
        dummy.rotation.set(0, Math.atan2(dx[i], dz[i]), 0)
        dummy.scale.setScalar(cu * ARROW)
        dummy.updateMatrix()
        this.mesh.setMatrixAt(k, dummy.matrix)
        // Bright near the goal, fading out toward the edges of the board.
        const nearness = 1 - dist[i] / longest
        this._colour.copy(toKing[i] ? kingCol : genCol).multiplyScalar(0.25 + nearness * 0.75)
        this.mesh.setColorAt(k, this._colour)
        k++
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  _dispose() {
    if (!this.mesh) return
    this.city.scene.remove(this.mesh)
    this.mesh.material.dispose()
    this.mesh.dispose()
    this.mesh = null
  }
}
