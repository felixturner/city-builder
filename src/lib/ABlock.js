import { Box2, Color } from 'three/webgpu'

/**
 * ABlock class
 * contains infos about a block, that is one top and one bottom mesh
 */
export class ABlock {
  static LIGHT_COLORS = [
    new Color(0xffffff),
    new Color(0xcccccc),
    new Color(0xaaaaaa),
    new Color(0x999999),
    new Color(0x086ff0),
  ]

  static DARK_COLORS = [
    new Color(0x666666),
    new Color(0x777777),
    new Color(0x888888),
    new Color(0x999999),
    new Color(0xbbbbbb),
  ]

  static ID = 0
  static LIGHT_BASE_COLOR = new Color(0x999999)
  static DARK_BASE_COLOR = new Color(0x666666)

  constructor() {
    this.id = ABlock.ID++
    this.typeBottom = 0
    this.typeTop = 0
    this.box = new Box2()
    this.height = 1
    this.rotation = 0
    this.topColorIndex = 0
    this.topColor = ABlock.DARK_COLORS[this.topColorIndex]
    this.baseColor = ABlock.DARK_BASE_COLOR
    // For dynamic height recalculation
    this.cityNoiseVal = 0
    this.randFactor = 0
    this.skipFactor = 0 // For realtime visibility toggle
  }

  setTopColorIndex(index) {
    this.topColorIndex = index
    this.topColor = ABlock.DARK_COLORS[this.topColorIndex]
  }
}
