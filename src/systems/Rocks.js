import { Mesh, MeshStandardNodeMaterial, Color, MathUtils } from 'three/webgpu'
import { ExtraGeometry } from '../lib/ExtraGeometry.js'

/**
 * Boulders: permanent, immovable terrain you have to build around.
 *
 * NOT towers. They were, briefly - it bought the flow field, the enclosure fill
 * and placement blocking for free, since every one of those already understood a
 * solid grey tower. But a rock shares almost nothing with a tower: no floors, no
 * colour, no roof, no cost, no damage, no upkeep, no animation, no pool. Paying
 * for that reuse meant a `rock` flag leaking into eight places across six files,
 * each one a system saying "except not this kind of tower".
 *
 * So they own a cell mask instead. Anything that needs to know whether ground is
 * blocked asks blocks(gx, gy) - one question, one answer, and nothing else has to
 * know rocks exist.
 *
 * They do NOT block line of sight: turret and creep shots raycast the tower mesh,
 * which a rock is no longer part of, so fire passes over them.
 */

// Kept off the king so the opening is never handed a free fortress, and off the
// outer ring so a rock can't sit where creeps enter.
const KEEP_CLEAR_OF_KING = 3 // cells
const EDGE_MARGIN = 2 // cells in from the edge of the area they scatter over

export class Rocks {
  constructor(city) {
    this.city = city
    this.rocks = [] // { gx, gy, mesh, active }
    this.blocked = null // Uint8 mask over the grid, ACTIVE rocks only
    this.mat = new MeshStandardNodeMaterial({
      // The ground's own colour (Lighting.boundsGround). A boulder is terrain,
      // not a thing you built, so it should read as the floor pushed up rather
      // than as an object sitting on it - the silhouette and its shadow are
      // what make it legible, not a contrasting tint.
      color: new Color(0x999999),
      roughness: 0.95,
      metalness: 0,
    })
  }

  /** True if an active boulder stands on this cell. */
  blocks(gx, gy) {
    if (!this.blocked) return false
    if (gx < 0 || gy < 0 || gx >= this.city.gridCellsX || gy >= this.city.gridCellsY) return false
    return this.blocked[gy * this.city.gridCellsX + gx] === 1
  }

  /** Same question, asked in world space. */
  blocksWorld(wx, wz) {
    const cell = this.city.worldToCell(wx, wz)
    return !!cell && this.blocks(cell.gx, cell.gy)
  }

  /**
   * Scatter `count` boulders. Called once, at city init.
   *
   * Spread across the LARGEST play area the board will ever open up to, not the
   * small one you start on - so the rings that open after each boss round come
   * with terrain already on them, rather than being blank ground with all the
   * obstacles crowded into the middle. The out-of-bounds ones stay switched off
   * until their ring opens (see refresh).
   */
  place(count = 20, overLots = 11) {
    const city = this.city
    if (!ExtraGeometry.rocks.length) return
    const king = city.king
    const halfCells = Math.floor((overLots * city.lotCells) / 2)
    const cx = Math.floor(city.gridCellsX / 2), cy = Math.floor(city.gridCellsY / 2)
    const taken = new Set()

    for (let tries = 0; tries < count * 60 && this.rocks.length < count; tries++) {
      const gx = MathUtils.randInt(cx - halfCells + EDGE_MARGIN, cx + halfCells - 1 - EDGE_MARGIN)
      const gy = MathUtils.randInt(cy - halfCells + EDGE_MARGIN, cy + halfCells - 1 - EDGE_MARGIN)
      const key = gy * city.gridCellsX + gx
      if (taken.has(key)) continue
      if (king && Math.abs(gx - king.cellX) <= KEEP_CLEAR_OF_KING
        && Math.abs(gy - king.cellY) <= KEEP_CLEAR_OF_KING) continue
      if (city.occupied[gy]?.[gx]) continue
      if (city.lootBoxes?.occupiesCell(gx, gy)) continue
      taken.add(key)

      const geo = ExtraGeometry.rocks[MathUtils.randInt(0, ExtraGeometry.rocks.length - 1)]
      const mesh = new Mesh(geo, this.mat)
      const world = city.gridToWorld(gx * city.cellUnit + city.cellUnit / 2,
        gy * city.cellUnit + city.cellUnit / 2)
      mesh.position.set(world.x, 0, world.z)
      mesh.rotation.y = Math.random() * Math.PI * 2 // no two look alike
      mesh.castShadow = true
      mesh.receiveShadow = true
      city.scene.add(mesh)
      this.rocks.push({ gx, gy, mesh, active: false })
    }
    this.refresh()
  }

  /**
   * Rebuild the mask for the part of the board currently in play, and show or
   * hide each boulder to match. Called at init and whenever a ring opens.
   */
  refresh() {
    const city = this.city
    const n = city.gridCellsX * city.gridCellsY
    if (!this.blocked || this.blocked.length !== n) this.blocked = new Uint8Array(n)
    this.blocked.fill(0)
    for (const rock of this.rocks) {
      rock.active = city.inPlayArea(rock.gx, rock.gy)
      rock.mesh.visible = rock.active
      if (rock.active) this.blocked[rock.gy * city.gridCellsX + rock.gx] = 1
    }
    city.flowDirty = true // the wall mask changed
  }
}
