import gsap from 'gsap'
import {
  Vector3,
  Box3,
  PlaneGeometry,
  Mesh,
  EquirectangularReflectionMapping,
  DirectionalLight,
  HemisphereLight,
  DirectionalLightHelper,
  MeshStandardNodeMaterial,
} from 'three/webgpu'
import { RGBELoader } from 'three/examples/jsm/Addons.js'

export class Lighting {
  constructor(scene, renderer, params) {
    this.scene = scene
    this.renderer = renderer
    this.params = params

    this.dirLight = null
    this.dirLightOffset = null
    this.dirLightHelper = null
    this.hemiLight = null
    this.sceneBounds = null
  }

  async init() {
    const { scene, params } = this

    // Load HDR from params
    const texture = await new RGBELoader()
      .setPath('./assets/hdr/')
      .loadAsync(params.lighting.hdr)
    texture.mapping = EquirectangularReflectionMapping
    texture.needsUpdate = true
    scene.background = texture
    scene.environment = texture

    // Three grounds, stacked, each a step darker as it leaves play:
    //
    //   BOUNDS      the buildable board. Grid, dots and outline are drawn on it.
    //   OUTER FIELD one lot of apron. Creeps walk in across it; you cannot build
    //               on it. 20% darker than the bounds, so where your board stops
    //               is readable without needing to find the outline.
    //   BEYOND      everything else, darker again - out of the game entirely.
    //
    // Each sits slightly lower than the one on top of it; at equal heights they
    // z-fight. Both inner planes are unit-sized and scaled by setBoardSize.
    const plane = (color, y, size = 1) => {
      const geom = new PlaneGeometry(size, size, 1, 1)
      geom.rotateX(-Math.PI * 0.5)
      const mesh = new Mesh(geom, new MeshStandardNodeMaterial({ color }))
      mesh.position.y = y
      mesh.receiveShadow = true
      scene.add(mesh)
      return mesh
    }
    this.beyondGround = plane(0x44444a, -0.04, 420)
    this.outerField = plane(0x7a7a7a, -0.02)
    this.boundsGround = plane(0x999999, 0)

    // Scene bounds for shadow calculation (7x7 lots, centered on middle lot, ~98x98, buildings up to ~50 height)
    // Wide enough for a 10-lot board (100x100, so -50..50) plus the creep
    // spawn ring outside it; too tight and shadows clip at the edges.
    this.sceneBounds = new Box3(
      new Vector3(-70, 0, -70),
      new Vector3(70, 50, 70)
    )

    // Directional light for key shadows/highlights (values set by applyParams)
    this.dirLight = new DirectionalLight(0xffffff, 1)
    this.dirLightOffset = new Vector3(50, 100, 50)
    this.dirLight.position.copy(this.dirLightOffset)
    this.dirLight.castShadow = true
    this.dirLight.shadow.mapSize.width = 4096
    this.dirLight.shadow.mapSize.height = 4096
    this.dirLight.shadow.bias = -0.0005
    scene.add(this.dirLight)
    scene.add(this.dirLight.target) // Required for dynamic target positioning

    // Update shadow frustum based on scene bounds and light position
    this.updateShadowFrustum()

    // Light helper to visualize direction (visibility set by applyParams)
    this.dirLightHelper = new DirectionalLightHelper(this.dirLight, 10)
    scene.add(this.dirLightHelper)

    // Hemisphere light for soft sky/ground fill (values set by applyParams)
    this.hemiLight = new HemisphereLight(0xffffff, 0x444444, 1)
    scene.add(this.hemiLight)
  }

  async loadHDR(filename) {
    const texture = await new RGBELoader()
      .setPath('./assets/hdr/')
      .loadAsync(filename)
    texture.mapping = EquirectangularReflectionMapping
    texture.needsUpdate = true
    this.scene.background = texture
    this.scene.environment = texture
  }

  // Compute shadow camera frustum to cover scene from any light angle
  /**
   * Size the two inner grounds: the bounds to `half`, and the outer field to
   * `half + margin`. Called at init and whenever the play area grows.
   */
  setBoardSize(half, margin = 0, duration = 0) {
    if (!this.boundsGround) return
    const bounds = half * 2
    const outer = (half + margin) * 2
    if (duration <= 0) {
      this.boundsGround.scale.set(bounds, 1, bounds)
      this.outerField.scale.set(outer, 1, outer)
      return
    }
    // Ease the ground outward rather than snapping. Growing the board is one of
    // the few unambiguously good things that happens in a run - it should look
    // like ground being won, not like a frame dropped.
    this._growTween?.kill()
    this._growTween = gsap.to([this.boundsGround.scale, this.outerField.scale], {
      duration,
      // Expo: nearly all the travel is over in the first third, so the ground
      // reads as thrown outward and then settling, rather than as a slide.
      ease: 'expo.out',
      x: (i) => (i === 0 ? bounds : outer),
      z: (i) => (i === 0 ? bounds : outer),
    })
  }

  updateShadowFrustum() {
    const light = this.dirLight
    const bounds = this.sceneBounds

    // Get scene center and radius (bounding sphere covers from any angle)
    const center = new Vector3()
    bounds.getCenter(center)
    const radius = bounds.min.distanceTo(bounds.max) / 2

    // Point light at scene center
    light.target.position.copy(center)
    light.target.updateMatrixWorld()

    // Position light along offset direction from center
    light.position.copy(center).add(this.dirLightOffset)
    light.updateMatrixWorld()

    // Shadow camera frustum sized to bounding sphere (works from any angle)
    const shadowCam = light.shadow.camera
    shadowCam.left = -radius
    shadowCam.right = radius
    shadowCam.top = radius
    shadowCam.bottom = -radius
    shadowCam.near = 0.5
    shadowCam.far = this.dirLightOffset.length() + radius
    shadowCam.updateProjectionMatrix()

    // Update helper if visible
    if (this.dirLightHelper) {
      this.dirLightHelper.update()
    }
  }

  // Called every frame to update shadow camera based on camera view
  updateShadowCamera(cameraTarget, camera, orthoCamera, perspCamera) {
    if (!this.dirLight) return

    const target = cameraTarget
    const offset = this.dirLightOffset

    // Position light relative to camera target (sun follows view)
    this.dirLight.position.set(target.x + offset.x, offset.y, target.z + offset.z)
    this.dirLight.target.position.copy(target)
    this.dirLight.target.updateMatrixWorld()
    this.dirLight.updateMatrixWorld()

    // Get shadow camera and its view matrix
    const shadowCam = this.dirLight.shadow.camera
    shadowCam.updateMatrixWorld()
    const lightViewMatrix = shadowCam.matrixWorldInverse

    // Calculate shadow area size based on camera view
    let halfSize
    if (camera === orthoCamera) {
      const cam = orthoCamera
      const zoom = cam.zoom || 1
      halfSize = Math.max((cam.right - cam.left), (cam.top - cam.bottom)) / 2 / zoom
    } else {
      const cam = perspCamera
      const distance = cam.position.distanceTo(target)
      const vFov = (cam.fov * Math.PI) / 180
      const vHalf = Math.tan(vFov / 2) * distance  // vertical half-height
      const hHalf = vHalf * cam.aspect              // horizontal half-width
      halfSize = Math.max(vHalf, hHalf)             // use larger extent for portrait/landscape
    }
    // Clamp to reasonable range - allow smaller when zoomed in for better resolution
    halfSize = Math.max(8, Math.min(halfSize * 1.2, 120))
    const height = 60  // max building height + margin

    // 8 corners of the shadow bounding box in world space
    const corners = [
      new Vector3(target.x - halfSize, 0, target.z - halfSize),
      new Vector3(target.x + halfSize, 0, target.z - halfSize),
      new Vector3(target.x - halfSize, 0, target.z + halfSize),
      new Vector3(target.x + halfSize, 0, target.z + halfSize),
      new Vector3(target.x - halfSize, height, target.z - halfSize),
      new Vector3(target.x + halfSize, height, target.z - halfSize),
      new Vector3(target.x - halfSize, height, target.z + halfSize),
      new Vector3(target.x + halfSize, height, target.z + halfSize),
    ]

    // Transform corners to light space and find AABB
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    for (const corner of corners) {
      corner.applyMatrix4(lightViewMatrix)
      minX = Math.min(minX, corner.x)
      maxX = Math.max(maxX, corner.x)
      minY = Math.min(minY, corner.y)
      maxY = Math.max(maxY, corner.y)
      minZ = Math.min(minZ, corner.z)
      maxZ = Math.max(maxZ, corner.z)
    }

    // Set shadow camera frustum from light-space AABB
    // Use proportional padding - smaller when zoomed in for better resolution
    const padding = Math.max(2, halfSize * 0.1)
    shadowCam.left = minX - padding
    shadowCam.right = maxX + padding
    shadowCam.top = maxY + padding
    shadowCam.bottom = minY - padding
    shadowCam.near = -maxZ - padding  // Z is negative in view space
    shadowCam.far = -minZ + padding
    shadowCam.updateProjectionMatrix()

    // Update light helper if visible
    if (this.dirLightHelper) {
      this.dirLightHelper.update()
    }
  }
}
