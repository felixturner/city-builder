import { Group, Vector3, ArrowHelper } from 'three/webgpu'
import { isGrey } from '../blockTypes.js'

/**
 * Creep pathfinding: a multi-source BFS flow field over the cell grid, plus the
 * debug arrows that draw it.
 *
 * Lifted out of City, which had grown to hold the grid, the tile bag, the king,
 * the enclosure fill, the intro animation and this. None of it was shared - the
 * arrays are read only by Creeps - so it makes a cleaner seam than most.
 *
 * TWO fields are maintained, not one. Big creeps need a 2-cell corridor, so they
 * navigate a mask with every 1-cell gap closed off; everything else uses the
 * plain one. `fields(big)` hands out the right set, which is what callers want -
 * they used to pick between eight arrays with four parallel ternaries.
 */
export class FlowField {
  constructor(city) {
    this.city = city
    this.debugEnabled = false
    // Bumped on every rebuild, so anything drawing the field can tell
    // "unchanged" from "recomputed" without diffing the arrays.
    this.version = 0
  }

  /** True once a field has been built at least once. */
  get ready() { return !!this.dist }

  /**
   * The four parallel arrays for a creep of this size:
   *   dist   - BFS distance to the nearest goal, or -1 for no path
   *   dx/dz  - the step from a cell toward that goal
   *   toKing - 1 if this cell's flow leads to the king, 0 if to a generator
   */
  fields(big) {
    return big
      ? { dist: this.distBig, dx: this.dxBig, dz: this.dzBig, toKing: this.toKingBig }
      : { dist: this.dist, dx: this.dx, dz: this.dz, toKing: this.toKing }
  }

  /**
   * Build a creep flow field (multi-source BFS) over the cell grid. Goals are the
   * king (tier 1) then generators/turrets (tier 2, only filling cells the king
   * can't reach); built grey walls (>=1 floor) are impassable. Each reachable cell
   * stores a step (flowDX, flowDZ) toward the nearest goal; flowDist < 0 = no path.
   */
  compute() {
    const W = this.city.gridCellsX, H = this.city.gridCellsY, N = W * H
    if (!this.dx) {
      this.dx = new Int8Array(N)
      this.dz = new Int8Array(N)
      this.dist = new Int32Array(N)
      this.toKing = new Uint8Array(N) // 1 = this cell's flow leads to the king, 0 = to a gen
      // Big creeps need a 2-wide corridor: their own field treats 1-cell gaps as walls.
      this.dxBig = new Int8Array(N)
      this.dzBig = new Int8Array(N)
      this.distBig = new Int32Array(N)
      this.toKingBig = new Uint8Array(N)
      this._wall = new Uint8Array(N)
      this._block = new Uint8Array(N) // obstacle mask for the current pass
      this._base = new Uint8Array(N) // pre-pinch snapshot of that mask
      this._queue = new Int32Array(N)
    }
    const wall = this._wall; wall.fill(0)
    const kingGoals = [], genGoals = []
    for (const t of this.city.towers) {
      if (!t.visible || !t.cells) continue
      for (const [dx, dy] of t.cells) {
        const x = t.cellX + dx, y = t.cellY + dy
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const i = y * W + x
        if (t.king) kingGoals.push(i) // primary goal
        else if (isGrey(t)) wall[i] = 1 // walls block; creeps route around / smash through gaps
        else genGoals.push(i) // gens/turrets: second-priority goals
      }
    }
    const DDX = [1, -1, 0, 0], DDZ = [0, 0, 1, -1]
    const q = this._queue
    const block = this._block, base = this._base

    // Fill `block` with a pass's obstacle mask: walls (+ gens for the king pass),
    // plus — for big creeps — any free cell pinched between obstacles on opposite
    // sides, so a 2-wide body can't slip through a 1-cell gap (off-grid = open).
    const buildMask = (blockGens, big) => {
      base.set(wall)
      if (blockGens) for (const gi of genGoals) base[gi] = 1
      if (!big) { block.set(base); return }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (base[i]) { block[i] = 1; continue }
        const L = x > 0 && base[i - 1], R = x < W - 1 && base[i + 1]
        const U = y > 0 && base[i - W], D = y < H - 1 && base[i + W]
        block[i] = ((L && R) || (U && D)) ? 1 : 0
      }
    }

    // Multi-source BFS over `block`, writing step vectors into the output arrays.
    const bfs = (sources, toKing, dist, fdx, fdz, ftk) => {
      let head = 0, tail = 0
      for (const i of sources) {
        if (dist[i] >= 0 || block[i]) continue
        dist[i] = 0; ftk[i] = toKing; q[tail++] = i
      }
      while (head < tail) {
        const i = q[head++]
        const x = i % W, y = (i - x) / W
        for (let d = 0; d < 4; d++) {
          const nx = x + DDX[d], ny = y + DDZ[d]
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const ni = ny * W + nx
          if (block[ni] || dist[ni] >= 0) continue
          dist[ni] = dist[i] + 1; ftk[ni] = toKing
          fdx[ni] = -DDX[d]; fdz[ni] = -DDZ[d] // step from ni back toward i (nearer the goal)
          q[tail++] = ni
        }
      }
    }

    // King pass (gens/turrets seal the king like walls), then gen pass (gens
    // passable) — once for the normal field, once for the big-creep field.
    this.dist.fill(-1)
    buildMask(true, false); bfs(kingGoals, 1, this.dist, this.dx, this.dz, this.toKing)
    buildMask(false, false); bfs(genGoals, 0, this.dist, this.dx, this.dz, this.toKing)

    this.distBig.fill(-1)
    buildMask(true, true); bfs(kingGoals, 1, this.distBig, this.dxBig, this.dzBig, this.toKingBig)
    buildMask(false, true); bfs(genGoals, 0, this.distBig, this.dxBig, this.dzBig, this.toKingBig)

    this.city.flowDirty = false
    this.version++
    this.updateDebug()
  }

  /** Debug overlay (toggle flowDebugEnabled, key F): a pooled red ArrowHelper per
   *  reachable cell pointing along the flow toward the nearest goal. Unreachable
   *  cells (walls / no path) get no arrow. */
  updateDebug() {
    const enabled = !!this.debugEnabled
    if (!enabled && !this._arrowGroup) return
    if (!this._arrowGroup) {
      this._arrowGroup = new Group()
      this.city.scene.add(this._arrowGroup)
      this._arrows = []
      this._goalArrows = []
      this._arrDir = new Vector3()
      this._upDir = new Vector3(0, 1, 0)
    }
    this._arrowGroup.visible = enabled
    if (!enabled || !this.dist) {
      for (const ar of this._arrows) ar.visible = false
      for (const ar of this._goalArrows) ar.visible = false
      return
    }
    const W = this.city.gridCellsX, H = this.city.gridCellsY, cu = this.city.cellUnit
    // Draw debug arrows over everything (goal arrows sit inside their towers).
    const noDepth = (ar) => {
      ar.line.material.depthTest = false; ar.cone.material.depthTest = false
      ar.line.renderOrder = 11; ar.cone.renderOrder = 11
    }
    let a = 0, m = 0
    for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
      const idx = gy * W + gx
      const d = this.dist[idx]
      if (d < 0) continue // unreachable / wall
      const cx = gx * cu + cu / 2 + this.city.gridOffsetX
      const cz = gy * cu + cu / 2 + this.city.gridOffsetZ
      // Colour by flow target: red = leads to the king, green = leads to a gen/turret.
      const col = this.toKing[idx] ? 0xff2020 : 0x22ff22
      if (d === 0) { // goal cell: tall up-arrow (where the flow converges)
        let g = this._goalArrows[m]
        if (!g) {
          g = new ArrowHelper(this._upDir, new Vector3(cx, 0.1, cz), cu * 1.6, col, cu * 0.5, cu * 0.4)
          noDepth(g)
          this._goalArrows.push(g)
          this._arrowGroup.add(g)
        } else { g.position.set(cx, 0.1, cz); g.visible = true }
        g.setColor(col)
        m++
        continue
      }
      // flow arrow toward the nearest goal
      this._arrDir.set(this.dx[idx], 0, this.dz[idx])
      let arrow = this._arrows[a]
      if (!arrow) {
        arrow = new ArrowHelper(this._arrDir, new Vector3(cx, 0.35, cz), cu * 0.49, col, cu * 0.22, cu * 0.15)
        noDepth(arrow)
        this._arrows.push(arrow)
        this._arrowGroup.add(arrow)
      } else {
        arrow.position.set(cx, 0.35, cz)
        arrow.setDirection(this._arrDir)
        arrow.visible = true
      }
      arrow.setColor(col)
      a++
    }
    for (let k = a; k < this._arrows.length; k++) this._arrows[k].visible = false
    for (let k = m; k < this._goalArrows.length; k++) this._goalArrows[k].visible = false
  }
}
