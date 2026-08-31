import { MathUtils } from 'three/webgpu'
import { TetrominoGeometry } from '../lib/TetrominoGeometry.js'
import { TopType } from '../blockTypes.js'

/**
 * The shared tile bag the palette draws from.
 *
 * A bag rather than a die: draws are without replacement, so you cannot get five
 * shields in a row and you cannot go a whole game without seeing a mortar. It
 * refills and reshuffles when empty.
 */
export class TileBag {
  constructor() {
    this._bag = null
  }

  /** Draw the next tile spec, refilling + reshuffling when the bag runs out. */
  draw() {
    if (!this._bag || this._bag.length === 0) this._refill()
    return this._bag.pop()
  }

  /** Fill + shuffle the 64-tile bag: walls 7 each (6 shapes = 42, ~66%), then
   *  1x1 path gens 6, enclosure gens 4, turrets 2 each (6), barracks 3,
   *  shields 3. */
  _refill() {
    const bag = []
    const add = (n, spec) => { for (let i = 0; i < n; i++) bag.push(spec) }
    for (const shapeName of TetrominoGeometry.names) add(7, { wall: true, shapeName })
    // Everything that isn't a wall is a single cell. Generators used to also come
    // in 2x2 and 3x3 - they were the only multi-cell blocks in the game besides
    // the tetromino walls - which made footprint a second, inconsistent axis of
    // variation on top of height.
    //
    // Walls sit at 7 per shape and dominate the bag (~66%); the 1x1 utility
    // tiles are tuned against each other. Enclosure gens draw less often than
    // path gens because one enclosure ring covers a lot of ground, and turrets
    // stay the scarcest at 2 apiece.
    const turrets = [TopType.PEG_TURRET, TopType.DIVOT_TURRET, TopType.MORTAR_TURRET]
    add(6, { s: 1, typeTop: TopType.PATH_GENERATOR })
    add(4, { s: 1, typeTop: TopType.ENCLOSURE_GENERATOR })
    for (const typeTop of turrets) add(2, { s: 1, typeTop })
    add(3, { s: 1, typeTop: TopType.BARRACKS })
    add(3, { s: 1, typeTop: TopType.SHIELD })
    for (let i = bag.length - 1; i > 0; i--) {
      const j = MathUtils.randInt(0, i)
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    this._bag = bag
  }
}
