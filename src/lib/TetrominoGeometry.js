import { BoxGeometry, BufferGeometry, Float32BufferAttribute } from 'three/webgpu'

// Base cell layouts (grid offsets) for the tetrominoes (O removed - too plain).
const BASE = {
  I: [[0, 0], [1, 0], [2, 0], [3, 0]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  L: [[0, 0], [0, 1], [0, 2], [1, 2]],
  J: [[1, 0], [1, 1], [1, 2], [0, 2]],
  T: [[0, 0], [1, 0], [2, 0], [1, 1]],
}

function normalize(cells) {
  const minX = Math.min(...cells.map((c) => c[0]))
  const minY = Math.min(...cells.map((c) => c[1]))
  return cells.map(([x, y]) => [x - minX, y - minY])
}

/** 90deg rotation (NOT a transpose - that would mirror chiral pieces J/L/S/Z).
 *  The 3D geometry + placement use the rotated shape so they read the same as the
 *  flat 2D icon under the isometric camera; the icon itself stays un-rotated. */
function placeOrient(cells) {
  const r = cells.map(([x, y]) => [-y, x]) // 90deg CCW
  const minX = Math.min(...r.map((c) => c[0]))
  const minY = Math.min(...r.map((c) => c[1]))
  return r.map(([x, y]) => [x - minX, y - minY])
}

/** Distinct 90deg-CW rotation states of a base shape (dedupes symmetric ones). */
function rotationStates(base) {
  const states = []
  const seen = new Set()
  let cur = base
  for (let r = 0; r < 4; r++) {
    const n = normalize(cur)
    const k = n.map((c) => c.join(',')).sort().join(';')
    if (!seen.has(k)) { seen.add(k); states.push(n) }
    // [x,y] -> [-y,x]. On the icon's canvas axes (x right, y DOWN) this sends
    // right to down, i.e. clockwise on screen. The old [y,-x] sent right to up,
    // which read as anticlockwise however it's labelled.
    cur = cur.map(([x, y]) => [-y, x])
  }
  return states
}

/**
 * Procedural tetromino block geometries (square-edged), built in code from unit
 * boxes — a merged body (unit height, centred in Y) + a thin roof cap per shape
 * and rotation. Cells are in grid offsets from the shape's min corner; the
 * geometry's local origin is that min corner. Bevel can be added later by
 * swapping the box for an extruded outline (or in Blender).
 */
export class TetrominoGeometry {
  static names = Object.keys(BASE) // ['I','S','Z','L','J','T']
  static states = {} // name -> [ cells[], ... ] per rotation (icon orientation)
  static roofHalf = 0.15

  /**
   * Centroid of a cell set, rounded to a cell. Tiles anchor here rather than at
   * the bounding-box centre so a rotation pivots about the middle of the SHAPE:
   * a T is 4 cells in a 3x2 box, and its bbox centre isn't on the piece at all,
   * so rotating about it visibly threw the tile sideways.
   */
  static anchor(cells) {
    let sx = 0, sy = 0
    for (const [x, y] of cells) { sx += x; sy += y }
    return [Math.round(sx / cells.length), Math.round(sy / cells.length)]
  }

  /** Placement/geometry cells for a rotation state (rotated 90deg vs the icon). */
  static placeCells(stateCells) {
    return placeOrient(stateCells)
  }

  /** Build every shape/rotation. Returns a flat list of { name, rot, body, roof }.
   *  Geometry is built from the rotated cells (see placeCells / placeOrient). */
  static build(cellUnit) {
    const list = []
    for (const name of this.names) {
      const states = rotationStates(BASE[name])
      this.states[name] = states
      states.forEach((cells, rot) => {
        const gc = placeOrient(cells) // 3D + placement orientation
        list.push({
          name, rot,
          body: this._merge(gc, cellUnit, 1), // unit height, centred in Y
          roof: this._merge(gc, cellUnit, this.roofHalf * 2), // thin cap
        })
      })
    }
    return list
  }

  /** Merge `cells` unit boxes (height h, centred in Y) into one indexed geometry.
   *  Keeps position/normal/uv so it stays attribute-consistent with the GLB
   *  blocks in the shared BatchedMesh. */
  static _merge(cells, cu, h) {
    // Centre the shape on its bounding box so rotation/scale animations pivot
    // around the centre (like rectangular blocks).
    const bw = Math.max(...cells.map((c) => c[0])) + 1
    const bh = Math.max(...cells.map((c) => c[1])) + 1
    const posArrays = []
    const normArrays = []
    const uvArrays = []
    let total = 0
    for (const [cx, cy] of cells) {
      const tx = cx * cu + cu / 2 - (bw * cu) / 2
      const tz = cy * cu + cu / 2 - (bh * cu) / 2
      const b = new BoxGeometry(cu, h, cu).translate(tx, 0, tz).toNonIndexed()
      posArrays.push(b.attributes.position.array)
      normArrays.push(b.attributes.normal.array)
      uvArrays.push(b.attributes.uv.array)
      total += b.attributes.position.count
    }
    const pos = new Float32Array(total * 3)
    const norm = new Float32Array(total * 3)
    const uv = new Float32Array(total * 2)
    let o3 = 0, o2 = 0
    for (let i = 0; i < posArrays.length; i++) {
      pos.set(posArrays[i], o3)
      norm.set(normArrays[i], o3)
      o3 += posArrays[i].length
      uv.set(uvArrays[i], o2)
      o2 += uvArrays[i].length
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    g.setAttribute('normal', new Float32BufferAttribute(norm, 3))
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
    g.setIndex([...Array(total).keys()]) // trivial index (BatchedMesh wants indexed)
    return g
  }
}
