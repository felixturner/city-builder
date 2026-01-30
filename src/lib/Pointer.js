import { Raycaster, Vector2, Vector3 } from 'three/webgpu'
import { uniform } from 'three/tsl'

/**
 * Helper class to handle pointer position and "down" with output exposed in vector3 and uniforms
 */
export class Pointer {
  constructor(renderer, camera, plane) {
    this.camera = camera
    this.renderer = renderer
    this.rayCaster = new Raycaster()
    this.initPlane = plane
    this.iPlane = plane.clone()
    this.clientPointer = new Vector2()
    this.pointer = new Vector2()
    this.scenePointer = new Vector3()
    this.pointerDown = false
    this.uPointerDown = uniform(0)
    this.uPointer = uniform(new Vector3())

    renderer.domElement.addEventListener('pointerdown', this.onPointerDown.bind(this))
    renderer.domElement.addEventListener('pointerup', this.onPointerUp.bind(this))
    window.addEventListener('pointermove', this.onPointerMove.bind(this))
  }

  onPointerDown(e) {
    if (e.pointerType !== 'mouse' || e.button === 0) {
      this.pointerDown = true
      this.uPointerDown.value = 1
    }
    this.clientPointer.set(e.clientX, e.clientY)
    this.updateScreenPointer(e)
  }

  onPointerUp(e) {
    this.clientPointer.set(e.clientX, e.clientY)
    this.updateScreenPointer(e)
    this.pointerDown = false
    this.uPointerDown.value = 0
  }

  onPointerMove(e) {
    this.clientPointer.set(e.clientX, e.clientY)
    this.updateScreenPointer(e)
  }

  updateScreenPointer(e) {
    if (e == null || e == undefined) {
      e = { clientX: this.clientPointer.x, clientY: this.clientPointer.y }
    }
    this.pointer.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    )
    this.rayCaster.setFromCamera(this.pointer, this.camera)
    this.rayCaster.ray.intersectPlane(this.iPlane, this.scenePointer)
    this.uPointer.value.x = this.scenePointer.x
    this.uPointer.value.y = this.scenePointer.y
    this.uPointer.value.z = this.scenePointer.z
  }

  update(dt, elapsed) {
    this.iPlane.normal.copy(this.initPlane.normal).applyEuler(this.camera.rotation)
    this.updateScreenPointer()
  }
}
