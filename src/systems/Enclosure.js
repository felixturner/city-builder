import { Mesh, BufferGeometry, Float32BufferAttribute, MeshBasicNodeMaterial, AdditiveBlending, Color } from 'three/webgpu'
import { mrt, output, vec3, uniform, float, attribute } from 'three/tsl'
import { claimsEnclosure } from '../blockTypes.js'
import { Sounds } from '../lib/Sounds.js'

// Resting opacity of the enclosed-floor glow, before any generator pulse.
const ENCLOSURE_BASE_OPACITY = 0.18

/**
 * The sealed-floor glow, and the flood fill behind it.
 *
 * Wall your city in and the cells you close off light up; an enclosure generator
 * standing inside a sealed region claims it, colours it, and earns from its area.
 * That is one idea, but it was spread across City as a mesh, three vertex
 * buffers, two pulse uniforms, a flood fill, a region labeller and two masks.
 *
 * Two masks come out of the fill, and they answer different questions:
 *   cellClaim    - which generator colour owns this cell, or -1
 *   enclosedCells - is this cell sealed at all, claimed or not
 * Placement needs the first (you cannot claim a claimed cell); loot crates need
 * the second (a crate only opens when it is walled in, by anyone).
 */
export class Enclosure {
  constructor(city) {
    this.city = city
    this.cellClaim = null
    this.enclosedCells = null
  }

  /**
   * A low-opacity glow per enclosed cell (white = unclaimed, accent = claimed by
   * an enclosure generator), one merged ground mesh with per-vertex colours.
   *
   * Idempotent, because createGrids calls it on every grid rebuild - opening a
   * ring, or taking a card. It used to add a second mesh each time and leave the
   * old one in the scene, still drawing whatever the board looked like when it
   * was replaced. Nothing updated those copies again, so after the first board
   * expand a sealed region went on glowing under the live mesh however many
   * walls you knocked out of it.
   *
   * There is nothing to rebuild in any case: the buffers are sized off
   * gridCellsX/Y, and the grid is built once at full size - only the part of it
   * that is IN PLAY grows.
   */
  build() {
    if (this.mesh) { this.update(); return }
    this._maxVerts = this.city.gridCellsX * this.city.gridCellsY * 6 // 2 tris/cell
    this._encPos = new Float32Array(this._maxVerts * 3)
    const normals = new Float32Array(this._maxVerts * 3)
    for (let i = 0; i < this._maxVerts; i++) normals[i * 3 + 1] = 1 // all up
    const geom = new BufferGeometry()
    this._encPosAttr = new Float32BufferAttribute(this._encPos, 3)
    this._encPos = this._encPosAttr.array // Float32BufferAttribute copies; write the real buffer
    this._encColAttr = new Float32BufferAttribute(new Float32Array(this._maxVerts * 3), 3)
    this._encCol = this._encColAttr.array
    // 1 where a claimant (area generator, or the king) holds the region, 0 for
    // enclosed-but-unclaimed cells. The energy pulse is one uniform for the
    // whole mesh, so without a per-vertex gate every sealed area flashed -
    // including plain white ones with nothing generating in them.
    this._encClaimAttr = new Float32BufferAttribute(new Float32Array(this._maxVerts), 1)
    this._encClaim = this._encClaimAttr.array
    geom.setAttribute('position', this._encPosAttr)
    geom.setAttribute('normal', new Float32BufferAttribute(normals, 3))
    geom.setAttribute('color', this._encColAttr)
    geom.setAttribute('claimed', this._encClaimAttr)
    geom.setDrawRange(0, 0)
    this._encGeom = geom
    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: true, // occluded by blocks in front (depthWrite off: don't self-occlude)
      depthWrite: false,
      blending: AdditiveBlending,
      side: 2,
    })
    // Per-cell white / accent, scaled by a pulse uniform so the sealed floor
    // visibly brightens on every unit of energy its claimant earns. Opacity
    // alone only made it denser; this makes it flash.
    this.bright = uniform(0) // pulse AMOUNT, 0 = resting
    const claimed = attribute('claimed')
    mat.colorNode = attribute('color').mul(float(1).add(this.bright.mul(claimed)))
    // Write a fake "up" normal to the MRT so GTAO treats the floor as flat and
    // barely darkens it (same trick the path trails use). Stays in the main scene
    // so it depth-sorts against blocks for free.
    mat.mrtNode = mrt({ output: output, normal: vec3(0, 1, 0) })
    // Opacity driven by a uniform so the floor can pulse with its generator.
    this.opacity = uniform(0) // pulse AMOUNT on top of the base opacity
    mat.opacityNode = float(ENCLOSURE_BASE_OPACITY).add(this.opacity.mul(claimed))
    this.mesh = new Mesh(geom, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3 // over the ground, under the drag ghost (5)
    this.city.scene.add(this.mesh)
    this.update()
  }

  /** Mark the footprint cells of a tower into a Uint8 mask. */
  _markCells(t, mask, W, H) {
    const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 1 }
    if (t.cells) {
      for (const [dx, dy] of t.cells) set(t.cellX + dx, t.cellY + dy)
    } else {
      const gx0 = Math.round(t.box.min.x / this.city.cellUnit)
      const gy0 = Math.round(t.box.min.y / this.city.cellUnit)
      const tw = Math.round((t.box.max.x - t.box.min.x) / this.city.cellUnit)
      const th = Math.round((t.box.max.y - t.box.min.y) / this.city.cellUnit)
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) set(gx0 + i, gy0 + j)
    }
  }

  /**
   * Recompute enclosures: flood-fill the grid; cells walled off from the boundary
   * are enclosed. Walls = any visible tower EXCEPT enclosure generators (those are
   * the "contents" sealed inside). Enclosed cells are grouped into connected
   * regions; a region is claimed (coloured) by an enclosure generator inside it.
   * Drives the floor glow, per-cell claim colour (placement), and generator mana.
   */
  update() {
    if (!this.mesh) return
    const W = this.city.gridCellsX, H = this.city.gridCellsY

    // 1. Wall mask = visible towers except enclosure generators.
    const wall = new Uint8Array(W * H)
    for (const t of this.city.towers) {
      if (!t.visible || claimsEnclosure(t)) continue
      this._markCells(t, wall, W, H)
    }

    // Boulders are NOT walls here, though creeps cannot walk through them - an
    // enclosure is meant to be something you built, and terrain that happens to
    // close a ring for you is a free enclosure you never paid for. They still
    // block pathing (see FlowField), so a rock-sealed pocket is unreachable
    // without being claimable.

    // 2. Flood-fill "outside" from the boundary through non-wall cells.
    const outside = new Uint8Array(W * H)
    const stack = []
    const seed = (x, y) => {
      const idx = y * W + x
      if (!wall[idx] && !outside[idx]) { outside[idx] = 1; stack.push(idx) }
    }
    for (let x = 0; x < W; x++) { seed(x, 0); seed(x, H - 1) }
    for (let y = 0; y < H; y++) { seed(0, y); seed(W - 1, y) }
    while (stack.length) {
      const idx = stack.pop()
      const x = idx % W, y = (idx - x) / W
      if (x > 0) seed(x - 1, y)
      if (x < W - 1) seed(x + 1, y)
      if (y > 0) seed(x, y - 1)
      if (y < H - 1) seed(x, y + 1)
    }

    // King seal: the king is "enclosed" while no neighbouring cell is reachable
    // from the boundary. success on a fresh seal, king-enc-lost when breached.
    if (this.city.king && this.city.king.visible) {
      const kx = this.city.king.cellX, ky = this.city.king.cellY
      let kingExposed = false
      const nb = [[kx - 1, ky], [kx + 1, ky], [kx, ky - 1], [kx, ky + 1]]
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || outside[ny * W + nx]) { kingExposed = true; break }
      }
      const enclosed = !kingExposed
      if (this._kingEnclosed !== undefined) {
        // Its own sound, not the one a cut support trail plays: that is a small
        // blip about one building, and this is the ring around the king being
        // broken open.
        if (this._kingEnclosed && !enclosed) Sounds.play('king-enc-lost')
        else if (!this._kingEnclosed && enclosed) Sounds.play('king-sealed') // king newly sealed
      }
      this._kingEnclosed = enclosed
      // Read by Creeps for the king-is-open siren. Undefined until the first
      // fill runs, which is why callers test it against `false` rather than
      // falsiness - "not computed yet" is not the same as "wide open".
      this.kingEnclosed = enclosed
    }

    // 3. Group enclosed cells (non-wall && unreachable) into connected regions.
    const region = new Int32Array(W * H).fill(-1)
    const regions = [] // { count, color }
    const rstack = []
    for (let i = 0; i < W * H; i++) {
      if (wall[i] || outside[i] || region[i] !== -1) continue
      const rid = regions.length
      regions.push({ count: 0, color: -1 })
      region[i] = rid
      rstack.push(i)
      while (rstack.length) {
        const idx = rstack.pop()
        regions[rid].count++
        const x = idx % W, y = (idx - x) / W
        const nb = (nx, ny) => {
          const ni = ny * W + nx
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && !wall[ni] && !outside[ni] && region[ni] === -1) {
            region[ni] = rid
            rstack.push(ni)
          }
        }
        nb(x - 1, y); nb(x + 1, y); nb(x, y - 1); nb(x, y + 1)
      }
    }

    // 4. Claim colour from enclosure generators inside a region; set mana size.
    //
    // ONE claimant per region earns, not all of them. Every generator standing
    // in a region used to be handed the region's full cell count, so three of
    // them in one enclosure billed the same ground three times - and the way to
    // arrange that was to seal three small enclosures, put a generator in each,
    // then knock the inner walls down and have all three inherit the merged
    // area. Sealing ground is the thing being paid for, and it can only be
    // sealed once.
    //
    // The tallest wins, ties by tower id so the answer is stable across
    // rebuilds rather than depending on iteration order. The losers get zero
    // cells, which stops them pulsing - the same tell an unconnected generator
    // already gives.
    const winners = new Map() // region id -> the claimant earning off it
    for (const t of this.city.towers) {
      t.enclosureRegionCells = 0
      if (!claimsEnclosure(t) || !t.visible) continue
      const rid = region[t.cellY * W + t.cellX]
      if (rid < 0) continue
      const held = winners.get(rid)
      const better = !held || t.numFloors > held.numFloors
        || (t.numFloors === held.numFloors && t.id < held.id)
      if (better) winners.set(rid, t)
    }
    for (const [rid, t] of winners) {
      regions[rid].color = t.colorIndex
      t.enclosureRegionCells = regions[rid].count
    }

    // Region count change: energy.mp3 on a new enclosure, power-down on a lost one
    // (skip the first computation so the initial city doesn't trigger it).
    if (this._enclosureCount !== undefined) {
      if (regions.length > this._enclosureCount) Sounds.play('energy')
      else if (regions.length < this._enclosureCount) Sounds.play('power-down')
    }
    this._enclosureCount = regions.length

    // 5. Per-cell claim colour for placement checks (-1 = unclaimed / not enclosed).
    if (!this.cellClaim) this.cellClaim = new Int8Array(W * H)
    this.cellClaim.fill(-1)
    // enclosedCells is a separate mask because cellClaim can't answer "is this
    // sealed?": an enclosed region with no generator in it has colour -1, which
    // is the same value as open ground. Loot boxes need sealed-or-not, not
    // claimed-by-whom.
    if (!this.enclosedCells) this.enclosedCells = new Uint8Array(W * H)
    this.enclosedCells.fill(0)
    for (let i = 0; i < W * H; i++) {
      const rid = region[i]
      if (rid >= 0) { this.cellClaim[i] = regions[rid].color; this.enclosedCells[i] = 1 }
    }

    // 6. Render: a glow quad per enclosed cell (white unclaimed, accent claimed).
    const pos = this._encPos, col = this._encCol
    const cu = this.city.cellUnit, yp = 0.06
    let v = 0
    for (let y = 0; y < H && v + 6 <= this._maxVerts; y++) {
      for (let x = 0; x < W; x++) {
        const rid = region[y * W + x]
        if (rid < 0) continue
        let cr = 1, cg = 1, cb = 1 // unclaimed = white
        const c = regions[rid].color
        if (c >= 0) { const ac = this.city.accentColors[c]; cr = ac.r; cg = ac.g; cb = ac.b }
        const claimFlag = c >= 0 ? 1 : 0
        const x0 = x * cu + this.city.gridOffsetX, z0 = y * cu + this.city.gridOffsetZ
        const x1 = x0 + cu, z1 = z0 + cu
        const q = [x0, z0, x1, z0, x1, z1, x0, z0, x1, z1, x0, z1]
        for (let k = 0; k < 6; k++) {
          pos[v * 3] = q[k * 2]; pos[v * 3 + 1] = yp; pos[v * 3 + 2] = q[k * 2 + 1]
          col[v * 3] = cr; col[v * 3 + 1] = cg; col[v * 3 + 2] = cb
          this._encClaim[v] = claimFlag
          v++
        }
        if (v + 6 > this._maxVerts) break
      }
    }
    this._encPosAttr.needsUpdate = true
    this._encColAttr.needsUpdate = true
    this._encClaimAttr.needsUpdate = true
    this._encGeom.setDrawRange(0, v)
    this.mesh.visible = v > 0

    // Region sizes just changed -> recompute enclosure-generator mana.
    this.city.energy.updateEnclosureGenerators()
  }
}
