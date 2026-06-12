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
import { Sounds } from './lib/Sounds.js'
import { GUIManager } from './GUI.js'
import { City } from './City.js'
import { Lighting } from './Lighting.js'
import { Trails } from './lib/Trails.js'
import { PostFX } from './PostFX.js'
import { Mana } from './Mana.js'
import { Creeps } from './Creeps.js'
import { Turrets } from './Turrets.js'
import { CreepTimeline } from './CreepTimeline.js'
import { FloatingText } from './FloatingText.js'
import { TilePalette } from './systems/TilePalette.js'

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
    // Gameplay stays frozen until the player presses Start (see main.js).
    this.started = false
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
    this.city.onGameOver = () => this.gameOver()
    // Let interaction read the ground-plane pointer for empty-slot building
    this.city.interaction.pointer = this.pointerHandler

    // Energy/population HUD - grey blocks generate energy and raise its cap
    this.mana = new Mana(100, 100)
    this.city.mana = this.mana

    await this.lighting.init()
    await this.city.init()

    // Set up hover and click detection on city blocks
    this.pointerHandler.setRaycastTargets(
      [this.city.towerMesh],
      {
        onHover: (intersection) => this.city.interaction.onHover(intersection),
        onPointerDown: (intersection, x, y, isTouch) => this.city.interaction.onPointerDown(intersection, x, y, isTouch),
        onPointerUp: (isTouch, touchIntersection) => this.city.interaction.onPointerUp(isTouch, touchIntersection),
        onPointerMove: (x, y) => this.city.interaction.onPointerMove(x, y),
        onRightClick: (intersection) => this.city.interaction.onRightClick(intersection),
        // Bounding-box picking so plus-block holes are still clickable
        pick: (ray) => this.city.interaction.pickTowerBox(ray)
      }
    )

    // Create grid helpers (cell grid, dots, lot grid)
    this.city.createGrids()

    // Origin helper (hidden by default, toggled via GUI)
    this.axesHelper = new AxesHelper(5)
    this.axesHelper.position.set(0, 1, 0)
    this.axesHelper.visible = false
    this.scene.add(this.axesHelper)

    // Glowing trails (power lines) between towers - built during gameplay, none at init
    this.trails = new Trails(this.scene, this.city)
    this.city.trails = this.trails

    // Enemy creeps marching in from the map edges
    this.creeps = new Creeps(this.scene, this.city)

    // Incoming-wave timeline strip across the top of the screen
    this.creepTimeline = new CreepTimeline(this.creeps)

    // Floating "+N" energy captions above buildings
    this.floatingText = new FloatingText()
    this.city.floatingText = this.floatingText

    // Bottom-center hand of draggable tiles to fill spawned empty slots
    this.tilePalette = new TilePalette(this)

    // Peg_Top / Divot_Top towers act as turrets that shoot creeps
    this.turrets = new Turrets(this.scene, this.city, this.creeps)
    await this.turrets.init()

    // Initialize GUI after modules are ready
    this.gui = new GUIManager(this)
    this.gui.init()
    this.gui.applyParams()

    // Play/pause toggle button at the bottom of the screen
    this._buildPauseButton()
    this._buildFastForwardButton()

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
    this.perspCamera.position.set(-22.0998, 60, -15.012)
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
    this.stats.dom.style.top = 'auto'
    this.stats.dom.style.bottom = '0'
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

    if (this.postFX) this.postFX.resize()
  }

  animate() {
    this.stats.begin()

    const { controls, clock, postFX } = this

    const dt = clock.getDelta()

    controls.update(dt)
    // Clamp target Y to prevent panning under the city
    if (controls.target.y < 0) controls.target.y = 0
    this.lighting.updateShadowCamera(this.controls.target, this.camera, this.orthoCamera, this.perspCamera)

    // Game systems freeze before Start and while paused; camera + rendering
    // keep going so the scene is visible/orbitable on the start screen.
    if (this.started && !this.paused && !this.isGameOver) {
      this.stepGame(dt)
    }

    this.creepTimeline.update()
    this.floatingText.update(this.camera, dt)
    this.tilePalette.update(dt)

    // Feed turret range circles to the coverage-glow mask.
    if (!this._turretCircles) this._turretCircles = []
    postFX.setTurretCircles(this.city.getTurretCircles(this._turretCircles))

    postFX.render()

    this.stats.end()
  }

  /** Advance all game systems by `dt` seconds. */
  stepGame(dt) {
    this.city.update(dt)
    this.trails.update(dt)
    this.creeps.update(dt)
    this.turrets.update(dt)
  }

  /** Floating play/pause button at the bottom-center of the screen. */
  _buildPauseButton() {
    this.paused = false
    const btn = document.createElement('button')
    btn.id = 'pause-toggle'
    btn.textContent = '⏸ Pause'
    Object.assign(btn.style, {
      position: 'fixed',
      top: '9px',
      right: 'calc(50% + 17vw + 10px)', // just left of the 34vw centered timeline
      zIndex: '600',
      padding: '5px 12px',
      font: '600 13px system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(20,20,28,0.8)',
      border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '999px',
      cursor: 'pointer',
      backdropFilter: 'blur(4px)',
    })
    btn.addEventListener('click', () => {
      this.paused = !this.paused
      btn.textContent = this.paused ? '▶ Play' : '⏸ Pause'
    })
    document.body.appendChild(btn)
    this.pauseButton = btn
  }

  /** The king died: freeze the game, play a stinger, and show the overlay. */
  gameOver() {
    if (this.isGameOver) return
    this.isGameOver = true
    Sounds.play('power-down', 1.0, 0.05, 0.9)

    const el = document.createElement('div')
    el.id = 'game-over'
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2000',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '28px', background: 'rgba(10,8,6,0.82)', backdropFilter: 'blur(5px)',
    })
    const title = document.createElement('div')
    title.textContent = 'GAME OVER'
    Object.assign(title.style, {
      color: '#ff7000', font: '800 72px ui-monospace, Menlo, monospace',
      letterSpacing: '2px', textShadow: '0 3px 18px rgba(0,0,0,0.8)',
    })
    const btn = document.createElement('button')
    btn.textContent = 'Restart'
    Object.assign(btn.style, {
      padding: '12px 36px', font: '600 18px ui-monospace, monospace', color: '#fff',
      background: 'transparent', border: '2px solid #fff', borderRadius: '24px', cursor: 'pointer',
    })
    btn.addEventListener('click', () => location.reload())
    el.appendChild(title)
    el.appendChild(btn)
    document.body.appendChild(el)
  }

  /** Fast-forward button (right of the creep timeline): advance the wave clock 30s. */
  _buildFastForwardButton() {
    const btn = document.createElement('button')
    btn.id = 'fast-forward'
    btn.textContent = '⏩ +30s'
    Object.assign(btn.style, {
      position: 'fixed',
      top: '9px',
      left: 'calc(50% + 17vw + 10px)', // just right of the 34vw centered timeline
      zIndex: '600',
      padding: '5px 12px',
      font: '600 13px system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(20,20,28,0.8)',
      border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '999px',
      cursor: 'pointer',
      backdropFilter: 'blur(4px)',
    })
    btn.addEventListener('click', () => {
      // Jump the creep wave schedule forward 30s, sliding the timeline over.
      this.creeps.skipAhead(30)
      this.creepTimeline.tweenTo(this.creeps.elapsed)
    })
    document.body.appendChild(btn)
    this.fastForwardButton = btn
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
