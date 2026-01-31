import {
  Clock,
  OrthographicCamera,
  PerspectiveCamera,
  Vector2,
  Vector3,
  Scene,
  ACESFilmicToneMapping,
  Plane,
  PostProcessing,
  WebGPURenderer,
  PCFSoftShadowMap,
  GridHelper,
  PlaneGeometry,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu'
import {
  pass,
  output,
  mrt,
  normalView,
  viewportUV,
  clamp,
  uniform,
  select,
  mix,
  float,
  vec3,
  uv,
  fract,
  step,
  min,
} from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { OrbitControls } from 'three/examples/jsm/Addons.js'
import Stats from 'three/addons/libs/stats.module.js'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'
import { Pointer } from './lib/Pointer.js'
import { GUIManager } from './GUI.js'
import { CityBuilder } from './CityBuilder.js'
import { Lighting } from './Lighting.js'
import { Trails } from './lib/Trails.js'

export class Demo {
  static instance = null

  constructor(canvas) {
    this.canvas = canvas
    this.renderer = null
    this.orthoCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
    this.perspCamera = new PerspectiveCamera(30, 1, 0.1, 1000)
    this.camera = this.perspCamera
    this.controls = null
    this.post = null
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
    // DPR defaults to 1 for performance, adjustable via GUI
    this.renderer.setPixelRatio(1)
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
    this.city = new CityBuilder(this.scene, this.params)

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

    // Add grid lines - fine cell grid (light) and coarse lot grid (darker)
    const gridSize = this.city.actualGridWidth

    // Fine cell grid (semi-transparent)
    // Use integer division to ensure gridSize matches divisions exactly
    const cellDivisions = Math.floor(gridSize)
    const cellGrid = new GridHelper(cellDivisions, cellDivisions, 0x888888, 0x888888)
    cellGrid.material.transparent = true
    cellGrid.material.opacity = 0.5
    cellGrid.position.y = 0.01
    this.scene.add(cellGrid)

    // Grid intersection dots using procedural plane shader
    const dotPlaneGeometry = new PlaneGeometry(cellDivisions, cellDivisions)
    dotPlaneGeometry.rotateX(-Math.PI / 2)
    const dotMaterial = new MeshBasicNodeMaterial()
    dotMaterial.transparent = true
    dotMaterial.alphaTest = 0.5
    dotMaterial.side = 2 // DoubleSide

    // Procedural dots at grid intersections
    // UV goes 0-1, scale to cell coordinates
    const cellCoord = uv().mul(cellDivisions)
    // Distance from nearest integer grid intersection
    const fractCoord = fract(cellCoord)
    const toGridX = min(fractCoord.x, float(1).sub(fractCoord.x))
    const toGridY = min(fractCoord.y, float(1).sub(fractCoord.y))
    const dist = toGridX.mul(toGridX).add(toGridY.mul(toGridY)).sqrt()
    // Dot radius in cell units
    const dotRadius = float(0.04)
    // Alpha mask: 1 inside dot, 0 outside
    const dotMask = float(1).sub(step(dotRadius, dist))

    // Color 0x444444
    const dotColor = vec3(0.267, 0.267, 0.267)
    dotMaterial.colorNode = dotColor
    dotMaterial.opacityNode = dotMask

    // MRT output for post-processing
    dotMaterial.mrtNode = mrt({
      output: dotColor,
      normal: vec3(0, 1, 0)
    })

    this.dotMesh = new Mesh(dotPlaneGeometry, dotMaterial)
    this.dotMesh.position.y = 0.015
    this.scene.add(this.dotMesh)

    // Coarse lot grid (every 14 cells = lot + road)
    // Offset by 2 cells so grid runs down middle of roads
    const lotSpacing = 14 // lotSize (10) + roadWidth (4)
    const lotDivisions = Math.floor(gridSize / lotSpacing)
    const lotGridSize = lotDivisions * lotSpacing
    const lotGrid = new GridHelper(lotGridSize, lotDivisions, 0x888888, 0x888888)
    lotGrid.position.set(-2, 0.02, -2) // Offset to center on roads
    this.scene.add(lotGrid)

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
    // Initial camera position (values from params via applyParams)
    this.perspCamera.position.set(-21.975, 51.205, -4.502)
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
    this.controls.target.set(-3.401, 0.777, 8.115)
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
    this.post = new PostProcessing(this.renderer)

    // Effect toggle uniforms (values set by applyParams)
    this.aoEnabled = uniform(1)
    this.vignetteEnabled = uniform(1)
    // Debug view: 0=final, 1=color, 2=depth, 3=normal, 4=AO
    this.debugView = uniform(0)

    const scenePass = pass(this.scene, this.camera)
    scenePass.setMRT(
      mrt({
        output: output,
        normal: normalView,
      })
    )

    const scenePassColor = scenePass.getTextureNode('output')
    const scenePassNormal = scenePass.getTextureNode('normal')
    const scenePassDepth = scenePass.getTextureNode('depth')

    this.aoPass = ao(scenePassDepth, scenePassNormal, this.camera)
    this.aoPass.distanceExponent.value = 1
    this.aoPass.distanceFallOff.value = 0.1
    this.aoPass.radius.value = 1.0
    this.aoPass.scale.value = 1.5
    this.aoPass.thickness.value = 1
    const aoPass = this.aoPass

    // AO texture for debug view
    const aoTexture = aoPass.getTextureNode()

    // Blur the AO to reduce banding artifacts (value set by applyParams)
    this.aoBlurAmount = uniform(1)
    const blurredAO = gaussianBlur(aoTexture, this.aoBlurAmount, 4) // sigma, radius

    // Soften AO: raise to power < 1 to reduce harshness, then blend
    // pow(0.5) makes shadows less dark, mix with 1 to control intensity (value set by applyParams)
    this.aoIntensity = uniform(1)
    const softenedAO = blurredAO.pow(0.5) // Square root makes it softer
    const blendedAO = mix(float(1), softenedAO, this.aoIntensity) // Mix with white based on intensity
    const withAO = mix(scenePassColor, scenePassColor.mul(blendedAO), this.aoEnabled)

    // Vignette: darken edges toward black
    const vignetteFactor = float(1).sub(
      clamp(viewportUV.sub(0.5).length().mul(1.4), 0.0, 1.0).pow(1.5)
    )
    const vignetteMultiplier = mix(float(1), vignetteFactor, this.vignetteEnabled)
    const finalOutput = mix(vec3(0, 0, 0), withAO, vignetteMultiplier)

    // Debug views
    const depthViz = vec3(scenePassDepth)
    const normalViz = scenePassNormal.mul(0.5).add(0.5)
    const aoViz = vec3(blurredAO)

    // Select output based on debug view
    const debugOutput = select(
      this.debugView.lessThan(0.5),
      finalOutput,
      select(
        this.debugView.lessThan(1.5),
        scenePassColor,
        select(
          this.debugView.lessThan(2.5),
          depthViz,
          select(this.debugView.lessThan(3.5), normalViz, aoViz)
        )
      )
    )

    this.post.outputNode = debugOutput
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

    const { controls, clock, post } = this

    const dt = clock.getDelta()

    controls.update(dt)
    // Clamp target Y to prevent panning under the city
    if (controls.target.y < 0) controls.target.y = 0
    this.lighting.updateShadowCamera(this.controls.target, this.camera, this.orthoCamera, this.perspCamera)

    // Update debris physics
    this.city.update(dt)

    // Update trails animation
    this.trails.update(dt)

    post.render()

    this.stats.end()
  }

  exportPNG() {
    // Render one frame to ensure canvas is up to date
    this.post.render()

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
}
