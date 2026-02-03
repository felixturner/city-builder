import {
  Clock,
  OrthographicCamera,
  PerspectiveCamera,
  Vector2,
  Vector3,
  Scene,
  ACESFilmicToneMapping,
  Plane,
  WebGPURenderer,
  PCFSoftShadowMap,
  AxesHelper,
} from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/Addons.js'
import Stats from 'three/addons/libs/stats.module.js'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'
import { Pointer } from './lib/Pointer.js'
import { GUIManager } from './GUI.js'
import { City } from './City.js'
import { Lighting } from './Lighting.js'
import { Trails } from './lib/Trails.js'
import { PostFX } from './PostFX.js'

export class Demo {
  static instance = null

  constructor(canvas) {
    this.canvas = canvas
    this.renderer = null
    this.orthoCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
    this.perspCamera = new PerspectiveCamera(30, 1, 0.1, 1000)
    this.camera = this.perspCamera
    this.controls = null
    this.postFX = null
    this.scene = new Scene()
    this.pointerHandler = null
    this.clock = new Clock(false)
    this.targetFPS = 60
    this.frameInterval = 1 / 60
    this.lastFrameTime = 0
    this.resizeTimeout = null

    // Module instances
    this.gui = null
    this.city = null
    this.lighting = null
    this.trails = null
    this.params = null

    if (Demo.instance != null) {
      console.warn('Demo instance already exists')
      return null
    }
    Demo.instance = this
  }

  async init() {
    if (WebGPU.isAvailable() === false) {
      return
    }

    this.renderer = new WebGPURenderer({ canvas: this.canvas, antialias: true })
    await this.renderer.init()
    // DPR 2 with half-res AO gives good quality/perf balance
    this.renderer.setPixelRatio(2)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFSoftShadowMap

    window.addEventListener('resize', this.onResize.bind(this))

    // Initialize params from defaults before creating modules
    this.params = JSON.parse(JSON.stringify(GUIManager.defaultParams))

    this.initCamera()
    this.initPostProcessing()
    this.initStats()

    this.onResize()
    this.pointerHandler = new Pointer(
      this.renderer,
      this.camera,
      new Plane(new Vector3(0, 1, 0), 0)
    )

    // Initialize modules
    this.lighting = new Lighting(this.scene, this.renderer, this.params)
    this.city = new City(this.scene, this.params)

    await this.lighting.init()
    await this.city.init()

    // Set up hover and click detection on city blocks
    this.pointerHandler.setRaycastTargets(
      [this.city.towerMesh],
      {
        onHover: (intersection) => this.city.onHover(intersection),
        onPointerDown: (intersection, x, y, isTouch) => this.city.onPointerDown(intersection, x, y, isTouch),
        onPointerUp: (isTouch, touchIntersection) => this.city.onPointerUp(isTouch, touchIntersection),
        onPointerMove: (x, y) => this.city.onPointerMove(x, y),
        onRightClick: (intersection) => this.city.onRightClick(intersection)
      }
    )

    // Create grid helpers (cell grid, dots, lot grid)
    this.city.createGrids()

    // Origin helper (hidden by default, toggled via GUI)
    this.axesHelper = new AxesHelper(5)
    this.axesHelper.position.set(0, 1, 0)
    this.axesHelper.visible = false
    this.scene.add(this.axesHelper)

    // Glowing trails between towers
    this.trails = new Trails(this.scene, this.city)
    this.trails.generatePaths(30)

    // Initialize GUI after modules are ready
    this.gui = new GUIManager(this)
    this.gui.init()
    this.gui.applyParams()

    this.clock.start()

    // Frame rate limiting with drift compensation
    const targetFPS = 60
    const frameInterval = 1000 / targetFPS
    let lastFrameTime = 0

    const loop = (currentTime) => {
      requestAnimationFrame(loop)
      const delta = currentTime - lastFrameTime
      if (delta >= frameInterval) {
        lastFrameTime = currentTime - (delta % frameInterval)
        this.animate()
      }
    }
    requestAnimationFrame(loop)
  }

  initCamera() {
    // Isometric camera setup
    const isoAngle = Math.PI / 4 // 45 degrees
    const isoDist = 150

    const camPos = new Vector3(
      Math.cos(isoAngle) * isoDist,
      isoDist * 0.8,
      Math.sin(isoAngle) * isoDist
    )

    // Set up orthographic camera
    this.orthoCamera.position.copy(camPos)
    this.updateOrthoFrustum()

    // Set up perspective camera (closer position for FOV 30)
    // Initial camera position - same rotation but targeting origin
    this.perspCamera.position.set(-18.574, 50.428, -12.617)
    this.perspCamera.fov = 20
    this.updatePerspFrustum()

    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.1
    this.controls.enableRotate = true
    // Swap mouse buttons: left=pan, right=rotate (like Townscaper)
    this.controls.mouseButtons = {
      LEFT: 2,  // PAN
      MIDDLE: 1, // DOLLY
      RIGHT: 0   // ROTATE
    }
    // Touch: 1 finger=pan, 2 fingers=rotate+zoom
    // TOUCH constants: ROTATE=0, PAN=1, DOLLY_PAN=2, DOLLY_ROTATE=3
    this.controls.touches = {
      ONE: 1,  // TOUCH.PAN
      TWO: 3   // TOUCH.DOLLY_ROTATE
    }
    // Zoom limits (distance from target)
    this.controls.minDistance = 40
    this.controls.maxDistance = 470
    // Polar angle limits (vertical tilt) - prevent going below horizon
    this.controls.maxPolarAngle = 1.53  // ~88° - above horizon
    // Pan parallel to ground plane instead of screen
    this.controls.screenSpacePanning = false
    this.controls.target.set(0, 0, 0)
    this.controls.update()
  }

  updateOrthoFrustum() {
    const frustumSize = 100
    const aspect = window.innerWidth / window.innerHeight
    this.orthoCamera.left = -frustumSize * aspect / 2
    this.orthoCamera.right = frustumSize * aspect / 2
    this.orthoCamera.top = frustumSize / 2
    this.orthoCamera.bottom = -frustumSize / 2
    this.orthoCamera.updateProjectionMatrix()
  }

  updatePerspFrustum() {
    this.perspCamera.aspect = window.innerWidth / window.innerHeight
    this.perspCamera.updateProjectionMatrix()
  }

  switchCamera(usePerspective) {
    const oldCamera = this.camera
    this.camera = usePerspective ? this.perspCamera : this.orthoCamera

    // Copy position and target from old camera
    this.camera.position.copy(oldCamera.position)
    if (usePerspective) {
      this.updatePerspFrustum()
    } else {
      this.updateOrthoFrustum()
    }

    // Update controls to use new camera
    this.controls.object = this.camera
    this.controls.update()

    // Reinitialize post-processing with new camera
    this.initPostProcessing()
  }

  initPostProcessing() {
    this.postFX = new PostFX(this.renderer, this.scene, this.camera)
    this.postFX.fadeOpacity.value = 0 // Start black

    // Expose uniforms for GUI access (aliased from PostFX)
    this.aoEnabled = this.postFX.aoEnabled
    this.vignetteEnabled = this.postFX.vignetteEnabled
    this.debugView = this.postFX.debugView
    this.aoBlurAmount = this.postFX.aoBlurAmount
    this.aoIntensity = this.postFX.aoIntensity
    this.aoPass = this.postFX.aoPass
  }

  initStats() {
    this.stats = new Stats()
    this.stats.showPanel(0) // 0: fps, 1: ms, 2: mb
    document.body.appendChild(this.stats.dom)
  }

  onResize(_e, toSize) {
    const { renderer } = this
    const size = new Vector2(window.innerWidth, window.innerHeight)
    if (toSize) size.copy(toSize)

    this.updateOrthoFrustum()
    this.updatePerspFrustum()

    renderer.setSize(size.x, size.y)
    renderer.domElement.style.width = `${size.x}px`
    renderer.domElement.style.height = `${size.y}px`
  }

  animate() {
    this.stats.begin()

    const { controls, clock, postFX } = this

    const dt = clock.getDelta()

    controls.update(dt)
    // Clamp target Y to prevent panning under the city
    if (controls.target.y < 0) controls.target.y = 0
    this.lighting.updateShadowCamera(this.controls.target, this.camera, this.orthoCamera, this.perspCamera)

    // Update debris physics
    this.city.update(dt)

    // Update trails animation
    this.trails.update(dt)

    postFX.render()

    this.stats.end()
  }

  exportPNG() {
    // Render one frame to ensure canvas is up to date
    this.postFX.render()

    // Get canvas data
    const canvas = this.renderer.domElement
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `city-${Date.now()}.png`
      link.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  fadeIn(duration = 1000) {
    const start = performance.now()
    const animate = () => {
      const elapsed = performance.now() - start
      const t = Math.min(elapsed / duration, 1)
      this.postFX.fadeOpacity.value = t
      if (t < 1) requestAnimationFrame(animate)
    }
    requestAnimationFrame(animate)
  }
}
