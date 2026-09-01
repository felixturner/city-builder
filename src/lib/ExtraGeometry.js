import { Box3, Vector3, Matrix4 } from 'three/webgpu'
import { GLTFLoader } from 'three/examples/jsm/Addons.js'

/**
 * Geometry pulled out of game-extra.glb - the soldier unit and the pickup star.
 *
 * GEOMETRY ONLY. The file's own materials are ignored: the unit is textured and
 * the star ships a grey base colour, and the rest of the city is flat untextured
 * colour, so anything wearing its authored look reads as imported from a
 * different game. Callers keep their existing materials and just swap the shape.
 *
 * Each shape is baked into a normalised, ready-to-place geometry: the node's own
 * transform applied (the star carries a rotation and a half scale in the file),
 * centred on XZ, and scaled to a size that suits the board.
 */
export class ExtraGeometry {
  static unit = null // soldier body, base at y=0
  static star = null // loot pickup, standing on edge, centred on the origin
  static rocks = [] // boulder variants, base at y=0

  static async init(cellUnit = 2) {
    if (this.unit) return
    let gltf
    try {
      gltf = await new GLTFLoader().loadAsync('./assets/models/game-extra.glb')
    } catch (e) {
      console.warn('game-extra.glb load failed:', e)
      return
    }
    gltf.scene.updateMatrixWorld(true)
    const find = (name) => {
      let hit = null
      gltf.scene.traverse((o) => { if (!hit && o.isMesh && o.name === name) hit = o })
      return hit
    }

    const unit = find('unit_red_full')
    if (unit) this.unit = this._bake(unit, { height: cellUnit * 0.9, sitOnGround: true })

    const star = find('star_red')
    if (star) this.star = this._bake(star, { height: cellUnit * 0.75, standUp: true })

    // Boulders, scaled by FOOTPRINT rather than height: they are wider than they
    // are tall and are meant to fill a cell, so matching heights would leave the
    // flat ones sprawling over their neighbours.
    this.rocks = []
    for (const name of ['rock_single_A', 'rock_single_B', 'rock_single_C',
      'rock_single_D', 'rock_single_E']) {
      const mesh = find(name)
      if (mesh) this.rocks.push(this._bake(mesh, { width: cellUnit * 1.14, sitOnGround: true }))
    }
  }

  /**
   * Bake a mesh's world transform into its geometry and normalise it.
   *
   * `standUp` turns the shape so its thinnest axis is HORIZONTAL - the star is a
   * flat cutout, and it has to stand on its edge for a spin about Y to sweep it
   * round the way a pickup should. Lying flat, the same spin just turns it in its
   * own plane like a starfish.
   *
   * It measures the shape rather than hard-coding a rotation, so it stays correct
   * if the model is re-exported at a different orientation.
   */
  static _bake(mesh, { height, width, sitOnGround = false, standUp = false }) {
    const geo = mesh.geometry.clone()
    geo.applyMatrix4(mesh.matrixWorld)
    if (!geo.attributes.normal) geo.computeVertexNormals()
    geo.deleteAttribute('uv') // textures are ignored; don't ship the coords

    if (standUp) {
      const size = new Box3().setFromBufferAttribute(geo.attributes.position).getSize(new Vector3())
      // Only act if the flat face is currently pointing up; if the thin axis is
      // already X or Z the shape is standing already.
      if (size.y < size.x && size.y < size.z) {
        geo.applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2))
      }
    }

    const box = new Box3().setFromBufferAttribute(geo.attributes.position)
    const size = box.getSize(new Vector3())
    const centre = box.getCenter(new Vector3())
    const scale = height ? height / (size.y || 1) : width / (Math.max(size.x, size.z) || 1)
    // Centre on XZ, then either stand it on the ground or centre it in Y too.
    geo.translate(-centre.x, sitOnGround ? -box.min.y : -centre.y, -centre.z)
    geo.scale(scale, scale, scale)
    return geo
  }
}
