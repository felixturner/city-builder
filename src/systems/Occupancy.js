/**
 * Occupancy - one claim per cell, shared by everything that walks the board.
 *
 * Creeps and soldiers used to keep separate registers: creeps a Set of cell
 * indices rebuilt each frame, soldiers an O(n^2) scan over their own list. They
 * could not see each other, so a soldier and a creep happily stood in the same
 * cell, and the creeps' own register was consulted only by the flow-following
 * branch - a bulldozing creep queued for nobody.
 *
 * A claim is on the cell a unit is walking INTO, not the one it is standing in.
 * A unit mid-hop is between two cells, and it is the destination that has to be
 * reserved: claiming on arrival lets two units commit to the same cell on the
 * same frame and land on top of each other.
 *
 * A unit claims a BLOCK of cells, not one: `unit.cellSpan` cells on a side, so a
 * giant holds 3x3 and a big creep 2x2. Claiming a single cell for a body six
 * world units across let a marcher walk clean through a boss.
 *
 * Buildings are NOT in here. City.occupied already carries the tower footprints
 * and Rocks its own mask, and the two are checked separately - a creep's step
 * INTO its goal tile is how it reaches the king, so "a building is here" has to
 * stay a different question from "another unit is going here".
 */
export class Occupancy {
  constructor(city) {
    this.city = city
    this._claims = new Map() // cell index -> the unit holding it
  }

  _index(gx, gy) { return gy * this.city.gridCellsX + gx }

  /** Cells on a side for a unit: 3 for a giant, 2 for a big, 1 for everything. */
  static spanOf(unit) { return (unit && unit.cellSpan) || 1 }

  /**
   * Run `fn(gx, gy)` over the block a unit of `span` anchored at (gx, gy) covers.
   *
   * Odd spans centre on the anchor cell (3 -> -1..+1); even ones start at it
   * (2 -> 0..+1), because there is no centre cell to sit on. Off-board cells are
   * skipped, so a unit walking in from the spawn ring claims only what is on the
   * board. Returns true as soon as `fn` does, for the "is any of this taken" use.
   */
  _overBlock(gx, gy, span, fn) {
    const W = this.city.gridCellsX, H = this.city.gridCellsY
    const lo = -Math.floor((span - 1) / 2)
    for (let j = lo; j < lo + span; j++) {
      for (let i = lo; i < lo + span; i++) {
        const x = gx + i, y = gy + j
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        if (fn(x, y)) return true
      }
    }
    return false
  }

  /** Drop every claim. Called once a frame, before units plan their steps. */
  clear() { this._claims.clear() }

  /** Claim the block around a world point for `unit` (no-op off-board). */
  claimWorld(wx, wz, unit) {
    const cell = this.city.worldToCell(wx, wz)
    if (!cell) return
    this._overBlock(cell.gx, cell.gy, Occupancy.spanOf(unit), (x, y) => {
      this._claims.set(this._index(x, y), unit)
      return false
    })
  }

  /** Release the block around a world point, wherever `unit` is the holder. */
  releaseWorld(wx, wz, unit) {
    const cell = this.city.worldToCell(wx, wz)
    if (!cell) return
    this._overBlock(cell.gx, cell.gy, Occupancy.spanOf(unit), (x, y) => {
      const i = this._index(x, y)
      if (this._claims.get(i) === unit) this._claims.delete(i)
      return false
    })
  }

  /**
   * True if any cell of the block `except` would cover at (gx, gy) is held by
   * somebody else - so a big creep needs a clear 2x2 to move into, not a cell.
   */
  taken(gx, gy, except) {
    return this._overBlock(gx, gy, Occupancy.spanOf(except), (x, y) => {
      const held = this._claims.get(this._index(x, y))
      return held !== undefined && held !== except
    })
  }

  /** taken(), addressed by world position. Off-board cells read as free. */
  takenWorld(wx, wz, except) {
    const cell = this.city.worldToCell(wx, wz)
    return cell ? this.taken(cell.gx, cell.gy, except) : false
  }

  /**
   * Rebuild from scratch: every ground unit claims the cell it is heading for.
   *
   * Wholesale rather than incrementally, so a unit dying or being spliced out
   * can never leave a phantom claim that blocks a cell for the rest of the run.
   * Bombers are left out: they are airborne, and nothing on the ground has to
   * make room for them.
   */
  rebuild(creeps, soldiers) {
    this.clear()
    for (const c of creeps) {
      if (c.bomber) continue
      this.claimWorld(c.toX, c.toZ, c)
    }
    for (const s of soldiers) this.claimWorld(s.toX, s.toZ, s)
  }
}
