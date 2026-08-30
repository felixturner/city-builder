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
import { ResourceFly } from './lib/ResourceFly.js'
import { ENERGY_COLOR } from './palette.js'

// Heavy shadow so game-over text stays legible over the live city now that
// there's no scrim behind it.
const TEXT_SHADOW = '0 2px 4px rgba(0,0,0,0.95), 0 0 22px rgba(0,0,0,0.9)'
import { Creeps } from './Creeps.js'
import { Soldiers } from './Soldiers.js'
import { PowerUpScreen, resetBuffs } from './PowerUps.js'
import { LootBoxes } from './LootBoxes.js'
import { Turrets } from './Turrets.js'
import { CreepTimeline } from './CreepTimeline.js'
import { FloatingText } from './FloatingText.js'
import { TilePalette } from './systems/TilePalette.js'

/** Debug UI (dat.GUI panel + FPS meter) is off for players and on with ?dev.
 *  Any value works - ?dev, ?dev=1 - it's presence that counts. */
export const DEV_MODE = new URLSearchParams(location.search).has('dev')

export class Demo {
  static instance = null

  // How much slack past "the grid exactly fills the view" the zoom-out stops at.
  static ZOOM_OUT_MARGIN = 1.12

  // Seconds between a crate bursting and the upgrade cards flying out of it.
  static CARD_DELAY = 0.55

  // Seconds between the king dying and the game freezing behind the score panel,
  // so you get to watch the creeps finish the job instead of cutting to a
  // screen the instant the last floor drops.
  static GAME_OVER_DELAY = 3

  constructor(canvas) {
    this.canvas = canvas
    this.renderer = null
    // near=0.1 against far=1000 spends nearly the whole depth buffer on the
    // first few units in front of the camera, leaving almost no precision at
    // the far plane - which is why the ground and the flat overlays on it
    // (enclosure glow, rings, dot grid, all within 0.07 of y=0) z-fought when
    // zoomed out. Depth precision scales with near/far, so lifting near by 50x
    // is the fix. Safe: the camera never gets closer than minDistance 40.
    this.orthoCamera = new OrthographicCamera(-1, 1, 1, -1, 5, 1000)
    this.perspCamera = new PerspectiveCamera(30, 1, 5, 1000)
    this.camera = this.perspCamera
    this.controls = null
    this.postFX = null
    this.scene = new Scene()
    this.pointerHandler = null
    this.clock = new Clock(false)
    // Gameplay stays frozen until the player presses Start (see main.js).
    this.started = false
    this.kingDead = false // king lost; game still running out the clock
    this.gameOverDelay = 0
    this.isGameOver = false // panel up, everything frozen
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
    // Press F to toggle the creep flow-field debug overlay.
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'f' || e.key === 'F') && this.city) {
        this.city.flowDebugEnabled = !this.city.flowDebugEnabled
        this.city.computeFlowField()
      }
    })

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
    this.mana = new Mana(100, 50) // cap 100, start on half so the opening build has a cost
    this.city.mana = this.mana
    // Income boxes flying from generators to the HUD meters. City needs the live
    // camera to project their launch point.
    this.resourceFly = new ResourceFly()
    this.city.resourceFly = this.resourceFly
    this.city.camera = this.camera

    await this.lighting.init()
    await this.city.init()
    // City now knows its grid size, so the zoom-out cap can be derived. (The
    // earlier onResize ran before the city existed and bailed out.)
    this.updateZoomLimit()

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
    this.city.creeps = this.creeps // let placement checks query creep positions

    // Friendly units raised by barracks tiles
    this.soldiers = new Soldiers(this.scene, this.city, this.creeps)
    this.city.soldiers = this.soldiers

    // Pick-one-of-four upgrade screen, paid out by walling in a loot crate
    // rather than by surviving N waves.
    resetBuffs()
    this.powerUps = new PowerUpScreen(this)
    this.lootBoxes = new LootBoxes(this.scene, this.city, this)
    this.city.lootBoxes = this.lootBoxes // placement checks read it
    this.lootBoxes.place()
    this.lootBoxes.onOpened = (screenPos) => {
      if (this.isGameOver || this.kingDead) return
      // A short beat after the burst so the confetti reads before the menu.
      this._cardTimer = setTimeout(() => {
        this._cardTimer = null
        if (!this.isGameOver && !this.kingDead) this.powerUps.show(screenPos)
      }, Demo.CARD_DELAY * 1000)
    }

    // Incoming-wave timeline strip across the top of the screen
    this.creepTimeline = new CreepTimeline(this.creeps)
    // Mana was built before the strip existed, so its first layout pass found
    // nothing to avoid. Re-run it now the strip is measurable.
    this.mana.layout()

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
    if (!DEV_MODE) this.gui.gui?.hide()
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
    // Opening framing, pulled back twice from the original (-22.0998, 60,
    // -15.012): +20%, then +30% again. 102.5 units out, against a maxDistance
    // that lands around 319 - so it starts wide but with plenty of room left.
    this.perspCamera.position.set(-34.4757, 93.6, -23.4187)
    this.perspCamera.fov = 20
    this.updatePerspFrustum()

    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.1
    this.controls.enableRotate = true
    // Stock OrbitControls bindings: left orbits, middle dollies, right pans;
    // one finger orbits, two pinch-zoom and pan. Panning is back on.
    this.controls.enablePan = true
    // Pan along the ground plane rather than the screen plane - the board is
    // flat, and screen-space panning drifts the camera off it as you drag.
    this.controls.screenSpacePanning = false
    // Zoom limits. minDistance is fixed; maxDistance is recomputed from the grid
    // size and the window aspect in updateZoomLimit().
    this.controls.minDistance = 40
    // Polar angle limits (vertical tilt) - prevent going below horizon
    // Orbit on the up axis only: pitch is pinned to the opening framing, so
    // dragging can swing you around the city but never tip it toward the
    // horizon. Panning and zoom are unaffected.
    const pol = Math.acos(
      this.perspCamera.position.y / this.perspCamera.position.length()
    )
    this.controls.minPolarAngle = pol
    this.controls.maxPolarAngle = pol
    // The orbit centre is the middle of the city and stays there for good.
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
    this.city?.onResize?.(window.innerWidth, window.innerHeight)
    this.perspCamera.aspect = window.innerWidth / window.innerHeight
    this.perspCamera.updateProjectionMatrix()
    this.updateZoomLimit()
  }

  /**
   * Cap zoom-out at "the whole build grid, plus a little". Derived rather than a
   * fixed number: the fov is VERTICAL, so a tall/narrow window needs to pull
   * back much further to fit the same ground area, and a hardcoded distance that
   * frames the grid on desktop leaves it cropped on a phone.
   *
   * The worst case is the grid presented corner-on (orbit is free), so the extent
   * to fit is its half-diagonal, with the vertical squashed by the camera pitch.
   */
  updateZoomLimit() {
    if (!this.controls || !this.city) return
    const cam = this.perspCamera
    const halfDiag = Math.hypot(this.city.actualGridWidth, this.city.actualGridHeight) / 2
    const pitch = this.controls.minPolarAngle || 0 // pitch is locked, so this is exact
    const needV = halfDiag * Math.cos(pitch) + this.city.maxFloors * this.city.floorHeight * 0.5
    const needH = halfDiag
    const tan = Math.tan((cam.fov * Math.PI / 180) / 2)
    const dist = Math.max(needV, needH / cam.aspect) / tan
    this.controls.maxDistance = Math.min(900, dist * Demo.ZOOM_OUT_MARGIN)
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
    // Built either way so animate()'s begin/end calls need no guard; just not
    // shown to players.
    if (DEV_MODE) document.body.appendChild(this.stats.dom)
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
    this.lighting.updateShadowCamera(this.controls.target, this.camera, this.orthoCamera, this.perspCamera)

    // Game systems freeze before Start, while paused, and once the game-over
    // panel is up. The king dying does NOT freeze anything on its own - the city
    // keeps running for GAME_OVER_DELAY seconds first (see kingDead below).
    if (this.started && !this.paused && !this.isGameOver) {
      this.stepGame(dt)
    }

    // Countdown from the king's death to the panel.
    if (this.kingDead && !this.isGameOver) {
      this.gameOverDelay -= dt
      if (this.gameOverDelay <= 0) this.showGameOver()
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
    // The score stops the moment the king dies, not when the panel appears -
    // the run ended at the death, the extra seconds are just the aftermath.
    if (!this.kingDead) this.mana.tick(dt)
    this.city.update(dt)
    this.trails.update(dt)
    this.creeps.update(dt)
    this.lootBoxes.update(dt)
    this.soldiers.update(dt)
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
      this.setPauseAudio(this.paused)
    })
    document.body.appendChild(btn)
    this.pauseButton = btn
  }

  /** Silence (or restore) everything for a pause - shared by the pause button
   *  and the upgrade screen, which freezes the game the same way. */
  /**
   * Silence (or restore) everything for a freeze. Shared by the pause button and
   * the upgrade screen, which stops the game the same way.
   *
   * The wave clock stops with the game, so a running countdown bed would drift
   * out of sync with it - it's cut and re-cues on the next wave.
   */
  setPauseAudio(paused) {
    if (paused) {
      Sounds.stop('tick-fast')
      Sounds.fadeOut('horn-boss', 0.3)
      if (this.creeps) {
        this.creeps._cuedWave = -1
        this.creeps._riserWave = -1
        this.creeps._riser = null
      }
      Sounds.holdBeds(true)
      // Fade the master bus out so one-shots already in flight go quiet too,
      // not just the beds.
      Sounds.fadeMaster(0, 0.25)
    } else {
      Sounds.fadeMaster(1, 0.25)
      Sounds.holdBeds(false)
    }
  }

  /**
   * The king died. The game keeps running for GAME_OVER_DELAY seconds - creeps
   * carry on overrunning the city - and only then does showGameOver() freeze it
   * and put the panel up.
   */
  gameOver() {
    if (this.kingDead) return
    this.kingDead = true
    this.gameOverDelay = Demo.GAME_OVER_DELAY
    // 3.2s long, peaking at 1.46s - it plays out across the GAME_OVER_DELAY
    // window and lands just as the panel appears.
    Sounds.play('game-over', 1.0, 0, 0.85)
  }

  /** Freeze the game and show the score panel. */
  showGameOver() {
    if (this.isGameOver) return
    this.isGameOver = true
    // Now that everything really has stopped, take the wave audio down with it.
    Sounds.stop('tick-fast')
    Sounds.fadeOut('horn-boss', 0.5)
    Sounds.stopBeds(1.2)

    const el = document.createElement('div')
    el.id = 'game-over'
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2000',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '28px',
      // No scrim: the city you just lost stays fully visible behind the text.
      // Each label carries its own shadow instead so it reads over any scene.
      background: 'transparent',
      pointerEvents: 'none',
    })
    const title = document.createElement('div')
    title.textContent = 'GAME OVER'
    Object.assign(title.style, {
      color: ENERGY_COLOR, font: '800 72px ui-monospace, Menlo, monospace',
      letterSpacing: '2px', textShadow: TEXT_SHADOW,
    })

    // Final score + persisted high score (localStorage).
    const final = Math.floor(this.mana?.elapsed || 0)
    let best = 0
    try { best = parseInt(localStorage.getItem('cityBuilderHighScore') || '0', 10) || 0 } catch (e) { /* storage blocked */ }
    const isBest = final > best
    if (isBest) { best = final; try { localStorage.setItem('cityBuilderHighScore', String(best)) } catch (e) { /* storage blocked */ } }

    const stats = document.createElement('div')
    Object.assign(stats.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
    })
    const scoreEl = document.createElement('div')
    scoreEl.textContent = `score: ${final}`
    Object.assign(scoreEl.style, {
      color: '#fff', font: '700 30px ui-monospace, Menlo, monospace', textShadow: TEXT_SHADOW,
    })
    const bestEl = document.createElement('div')
    bestEl.textContent = isBest ? `★ new best ★` : `best: ${best}`
    Object.assign(bestEl.style, {
      color: isBest ? ENERGY_COLOR : '#dfdfdf', font: '600 20px ui-monospace, Menlo, monospace',
      textShadow: TEXT_SHADOW,
    })
    stats.appendChild(scoreEl)
    stats.appendChild(bestEl)

    const btn = document.createElement('button')
    btn.textContent = 'Restart'
    Object.assign(btn.style, {
      padding: '12px 36px', font: '600 18px ui-monospace, monospace', color: '#fff',
      background: 'rgba(0,0,0,0.35)', border: '2px solid #fff', borderRadius: '24px',
      cursor: 'pointer', textShadow: TEXT_SHADOW,
      pointerEvents: 'auto', // the panel itself is click-through; the button isn't
    })
    btn.addEventListener('click', () => location.reload())
    el.appendChild(title)
    el.appendChild(stats)
    el.appendChild(btn)
    document.body.appendChild(el)
  }

  /** Fast-forward button (right of the creep timeline): advance the wave clock 20s. */
  _buildFastForwardButton() {
    const btn = document.createElement('button')
    btn.id = 'fast-forward'
    btn.textContent = '⏩ +20s'
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
      // Jump the creep wave schedule forward 20s, sliding the timeline over, and
      // credit the skipped time to the survival-score clock.
      const SKIP = 20
      this.creeps.skipAhead(SKIP)
      this.creepTimeline.tweenTo(this.creeps.elapsed)
      this.mana.elapsed += SKIP
      this.mana.render()
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
