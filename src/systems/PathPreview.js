import { Mesh, TubeGeometry, CatmullRomCurve3, Vector3, MeshBasicNodeMaterial } from 'three/webgpu'
import { fxMaterial, glow } from '../fx.js'
import { ACCENT_COLORS } from '../palette.js'

/**
 * A single traced route: the exact path a creep entering from the next wave's
 * edge would walk, all the way to whatever it ends up attacking.
 *
 * This sits alongside FlowFieldView rather than replacing it, and they answer
 * different questions. The field shows where EVERY cell drains to, which is the
 * shape of the whole maze; the line shows the one journey that is actually about
 * to happen, which is what you check before you commit a wall.
 *
 * It is walked one flow-field step at a time - the same loop a creep runs - so
 * it cannot drift out of agreement with the real thing. If the line is wrong,
 * the creeps are wrong too.
 */

const MAX_STEPS = 400 // walk cap, so a pathological field can't spin forever
const TUBE_RADIUS = 0.22
const Y = 0.35 // above the ground grid, below the drag ghost

export class PathPreview {
  constructor(city, creeps) {
    this.city = city
    this.creeps = creeps
    this.meshes = []
    this.enabled = true // on by default - toggle with GUI 'Creep Path'
    this._key = null
  }

  update() {
    const creeps = this.creeps
    if (!this.enabled || !creeps?.started || !this.city.flow.ready) { this._clear(); return }
    // Build phase only - during a fight the creeps themselves show the route.
    if (creeps.creeps.length > 0) { this._clear(); return }

    const edges = creeps.clock.waveEdges(creeps.clock.waveNumber)
    const key = `${edges.join(',')}|${this.city.flow.version}`
    if (key === this._key) return
    this._key = key
    this._clear()
    for (const e of edges) this._build(e)
  }

  /** Walk the flow field from an edge's entry cell and draw what it traces. */
  _build(edge) {
    const city = this.city
    const cu = city.cellUnit
    const W = city.gridCellsX, H = city.gridCellsY
    const { dist, dx, dz } = city.flow.fields(false)

    let gx = edge === 0 ? 0 : edge === 1 ? W - 1 : Math.floor(W / 2)
    let gy = edge === 2 ? 0 : edge === 3 ? H - 1 : Math.floor(H / 2)

    // The middle of that side may be walled; slide along the edge to the nearest
    // cell that has a route, or give up on this side entirely.
    if (!this._hasPath(dist, gx, gy, W, H)) {
      const alongZ = (edge === 0 || edge === 1)
      let found = false
      for (let d = 1; d < Math.max(W, H) && !found; d++) {
        for (const s of [-1, 1]) {
          const tx = alongZ ? gx : gx + s * d
          const ty = alongZ ? gy + s * d : gy
          if (this._hasPath(dist, tx, ty, W, H)) { gx = tx; gy = ty; found = true; break }
        }
      }
      if (!found) return
    }

    const pts = []
    for (let step = 0; step < MAX_STEPS; step++) {
      pts.push(new Vector3(gx * cu + cu / 2 + city.gridOffsetX, Y, gy * cu + cu / 2 + city.gridOffsetZ))
      const i = gy * W + gx
      if (dist[i] <= 0) break // arrived
      const nx = gx + dx[i], ny = gy + dz[i]
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) break
      if (nx === gx && ny === gy) break // no step recorded: stop rather than spin
      gx = nx; gy = ny
    }
    if (pts.length < 2) return

    const curve = new CatmullRomCurve3(pts)
    const geo = new TubeGeometry(curve, Math.min(pts.length * 2, 400), TUBE_RADIUS, 6, false)
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: ACCENT_COLORS[0].clone(), opacity: 0.5,
    }))
    const mesh = glow(new Mesh(geo, mat))
    mesh.renderOrder = 4
    this.city.scene.add(mesh)
    this.meshes.push(mesh)
  }

  _hasPath(dist, gx, gy, W, H) {
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return false
    return dist[gy * W + gx] >= 0
  }

  _clear() {
    for (const m of this.meshes) {
      this.city.scene.remove(m)
      m.geometry.dispose()
      m.material.dispose()
    }
    this.meshes.length = 0
    this._key = null
  }
}
