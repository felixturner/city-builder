import { MathUtils } from 'three/webgpu'
import { TetrominoGeometry } from '../lib/TetrominoGeometry.js'
import { TopType } from '../blockTypes.js'
import { simInt } from '../lib/rng.js'

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

  /**
   * Fill + shuffle a 36-tile bag: walls 4 each (6 shapes = 24, ~67%), then 1x1
   * path gens 3, enclosure gens 2, turrets 1 each (3), barracks 2, shields 2.
   *
   * Same proportions as the 64-tile bag this shrank from - what changed is only
   * the size. A tile type's AVERAGE wait follows from its share, so that is
   * unchanged by design; the point is the tail. Droughts scale with bag size, so
   * a specific turret went from up to 62 draws away to at most 35.
   *
   * 36 rather than 32 because the wall count has to be a multiple of six to keep
   * the tetromino shapes equally likely, and 24 is the multiple of six that
   * lands on the original two-thirds wall share.
   */
  _refill() {
    const bag = []
    const add = (n, spec) => { for (let i = 0; i < n; i++) bag.push(spec) }
    for (const shapeName of TetrominoGeometry.names) add(4, { wall: true, shapeName })
    // The 1x1 utility tiles are tuned against each other: enclosure gens draw
    // less often than path gens because one enclosure ring covers a lot of
    // ground, and turrets stay the scarcest.
    const turrets = [TopType.PEG_TURRET, TopType.DIVOT_TURRET, TopType.MORTAR_TURRET]
    add(3, { s: 1, typeTop: TopType.PATH_GENERATOR })
    add(2, { s: 1, typeTop: TopType.ENCLOSURE_GENERATOR })
    for (const typeTop of turrets) add(1, { s: 1, typeTop })
    add(2, { s: 1, typeTop: TopType.BARRACKS })
    add(2, { s: 1, typeTop: TopType.SHIELD })
    for (let i = bag.length - 1; i > 0; i--) {
      const j = simInt(0, i)
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    this._bag = bag
  }
}
