import { GLTFLoader } from 'three/examples/jsm/Addons.js'

export class BlockGeometry {
  static geoms = []
  // Half-heights for each geometry (for positioning at center)
  static halfHeights = []

  static async init() {
    await this.loadGeometries()
  }

  static topToBottom = new Map([
    [0, 6],
    [1, 7],
    [2, 8],
    [3, 6],
    [4, 6],
    [5, 6],
  ])

  /**
   * Load the block geometries from the gltf file
   * There's 3 base blocks and 6 top blocks
   * The above map is used to map the top blocks to the bottom blocks in the order they are stored in the "geoms" array
   */
  static async loadGeometries() {
    const file = './assets/models/blocks.glb'
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(file)

    const bottomBlock = this.findAndCenterGeometry(gltf, 'Square_Base')
    const bottomQuart = this.findAndCenterGeometry(gltf, 'Quart_Base')
    const bottomHole = this.findAndCenterGeometry(gltf, 'Hole_Base')

    const topSquare = this.findAndCenterGeometry(gltf, 'Square_Top')
    const topQuart = this.findAndCenterGeometry(gltf, 'Quart_Top')
    const topHole = this.findAndCenterGeometry(gltf, 'Hole_Top')
    const topPeg = this.findAndCenterGeometry(gltf, 'Peg_Top')
    const topDivot = this.findAndCenterGeometry(gltf, 'Divot_Top')
    const topCross = this.findAndCenterGeometry(gltf, 'Cross_Top')

    // Push in same order as before (tops 0-5, bottoms 6-8)
    this.geoms.push(topSquare.geom)
    this.halfHeights.push(topSquare.halfHeight)

    this.geoms.push(topQuart.geom)
    this.halfHeights.push(topQuart.halfHeight)

    this.geoms.push(topHole.geom)
    this.halfHeights.push(topHole.halfHeight)

    this.geoms.push(topPeg.geom)
    this.halfHeights.push(topPeg.halfHeight)

    this.geoms.push(topDivot.geom)
    this.halfHeights.push(topDivot.halfHeight)

    this.geoms.push(topCross.geom)
    this.halfHeights.push(topCross.halfHeight)

    this.geoms.push(bottomBlock.geom)
    this.halfHeights.push(bottomBlock.halfHeight)

    this.geoms.push(bottomQuart.geom)
    this.halfHeights.push(bottomQuart.halfHeight)

    this.geoms.push(bottomHole.geom)
    this.halfHeights.push(bottomHole.halfHeight)

  }

  /**
   * Find geometry by name, center it vertically, and return with half-height
   */
  static findAndCenterGeometry(gltf, name) {
    const geom = gltf.scene.children.find((child) => child.name === name).geometry
    geom.computeBoundingBox()

    const minY = geom.boundingBox.min.y
    const maxY = geom.boundingBox.max.y
    const height = maxY - minY
    const halfHeight = height / 2
    const centerY = (minY + maxY) / 2


    // Translate geometry so center is at Y=0
    const posAttr = geom.attributes.position
    for (let i = 0; i < posAttr.count; i++) {
      posAttr.setY(i, posAttr.getY(i) - centerY)
    }
    posAttr.needsUpdate = true

    // Recompute bounding box after centering
    geom.computeBoundingBox()

    return { geom, halfHeight }
  }
}
