import { GLTFLoader } from 'three/examples/jsm/Addons.js'

export class BlockGeometry {
  static geoms = []

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
    const gltf = await loader.loadAsync(file, (progress) => {
      console.log((progress.loaded / progress.total) * 100 + '% blocks loaded')
    })

    const bottomBlock = this.findGeometry(gltf, 'Square_Base')
    const bottomQuart = this.findGeometry(gltf, 'Quart_Base')
    const bottomHole = this.findGeometry(gltf, 'Hole_Base')

    const topSquare = this.findGeometry(gltf, 'Square_Top')
    const topQuart = this.findGeometry(gltf, 'Quart_Top')
    const topHole = this.findGeometry(gltf, 'Hole_Top')
    const topPeg = this.findGeometry(gltf, 'Peg_Top')
    const topDivot = this.findGeometry(gltf, 'Divot_Top')
    const topCross = this.findGeometry(gltf, 'Cross_Top')

    this.geoms.push(topSquare)
    this.geoms.push(topQuart)
    this.geoms.push(topHole)
    this.geoms.push(topPeg)
    this.geoms.push(topDivot)
    this.geoms.push(topCross)

    this.geoms.push(bottomBlock)
    this.geoms.push(bottomQuart)
    this.geoms.push(bottomHole)
  }

  static findGeometry(gltf, name) {
    return gltf.scene.children.find((child) => child.name === name).geometry
  }
}
