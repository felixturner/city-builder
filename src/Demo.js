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
} from 'three/tsl'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { OrbitControls } from 'three/examples/jsm/Addons.js'
import Stats from 'three/addons/libs/stats.module.js'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'
import { Pointer } from './lib/Pointer.js'
import { GUIManager } from './GUI.js'
import { CityBuilder } from './CityBuilder.js'
import { Lighting } from './Lighting.js'

export class Demo {
  static instance = null

  constructor(canvas) {
    this.canvas = canvas
    this.renderer = null
    this.orthoCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 500)
    this.perspCamera = new PerspectiveCamera(30, 1, 0.1, 500)
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
    this.fxaaEnabled = uniform(1)
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
    const withVignette = mix(vec3(0, 0, 0), withAO, vignetteMultiplier)

    // Apply FXAA (when enabled)
    const withFXAA = fxaa(withVignette)
    const finalOutput = mix(withVignette, withFXAA, this.fxaaEnabled)

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

    renderer.setPixelRatio(1)
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
