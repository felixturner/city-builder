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
import { HighScores } from './HighScores.js'

// Heavy shadow so game-over text stays legible over the live city now that
// there's no scrim behind it.
const TEXT_SHADOW = '0 2px 4px rgba(0,0,0,0.95), 0 0 22px rgba(0,0,0,0.9)'
import { Creeps } from './Creeps.js'
import { Soldiers } from './Soldiers.js'
import { PowerUpScreen, resetBuffs } from './PowerUps.js'
import { LootBoxes } from './LootBoxes.js'
import { Turrets } from './Turrets.js'
import { CreepTimeline } from './CreepTimeline.js'
import { WaveArrows } from './WaveArrows.js'
import { FlowFieldView } from './systems/FlowFieldView.js'
import { FloatingText } from './FloatingText.js'
import { TilePalette } from './systems/TilePalette.js'
import { EconLog } from './systems/EconLog.js'
import { RunRecorder } from './systems/RunRecorder.js'

/** Debug UI (dat.GUI panel + FPS meter) is off for players and on with ?dev.
 *  Any value works - ?dev, ?dev=1 - it's presence that counts. */
export const DEV_MODE = new URLSearchParams(location.search).has('dev')
// Milliseconds of quiet before a resize is actually applied - see onResize.
const RESIZE_SETTLE = 150

/** TEMP: ?clean spawns no rocks and no loot stars - a bare board for shooting
 *  tutorial screenshots. */
export const CLEAN_MODE = new URLSearchParams(location.search).has('clean')

export class Demo {
  static instance = null

  // How much slack past "the grid exactly fills the view" the zoom-out stops at.
  static ZOOM_OUT_MARGIN = 1.12

  // Largest step the sim will take in one frame, in seconds.
  static MAX_DT = 1 / 20
  /**
   * The step the SIMULATION advances by, every frame, regardless of how long the
   * frame actually took.
   *
   * The loop is already gated to 60fps (see the rAF driver in init), so this is
   * what a frame is meant to be - but making it a constant rather than the
   * measured elapsed time is what makes a run reproducible: the same inputs at
   * the same frame numbers produce the same game. Variable dt means a placement
   * recorded "at 12.34 seconds" lands in a different world on replay.
   *
   * The trade is that a genuinely slow frame runs the game slightly in slow
   * motion instead of skipping ahead. MAX_DT already half-did that for stalls;
   * this makes it the rule.
   */
  static SIM_DT = 1 / 60

  // Seconds between a crate bursting and the upgrade cards flying out of it.
  // The boss-reward beat, in seconds: quiet, then the board grows, then cards.
  static BOSS_COOLDOWN = 2.0 // silence after the round-clear sting
  static EXPAND_TIME = 1.2 // how long the board takes to open (see Lighting)
  static CARD_DELAY = 1.5 // pause after the expansion before the menu

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
    this.tabHidden = false // backgrounded: sim and audio suspended
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
    this._watchDevice()
    // DPR 2 with half-res AO gives good quality/perf balance
    this.renderer.setPixelRatio(2)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFSoftShadowMap

    window.addEventListener('resize', this.onResize.bind(this))
    // Background tab: freeze the game and silence everything. rAF already stops
    // when hidden in most browsers, but not all - some just throttle it - so the
    // step is gated explicitly rather than assumed.
    document.addEventListener('visibilitychange', () => {
      this.tabHidden = document.hidden
      Sounds.setSuspended(this.tabHidden)
      // Coming back, drop the delta that accumulated while away. Without this
      // the first frame carries the whole absence as one dt and the sim jumps.
      if (!this.tabHidden) this.clock.getDelta()
    })
    // Press F to toggle the creep flow-field debug overlay.
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'f' || e.key === 'F') && this.city) {
        this.city.flow.debugEnabled = !this.city.flow.debugEnabled
        this.city.computeFlowField()
      }
      if (e.key === 'Escape') this.toggleMenu()
    })

    // Initialize params from defaults before creating modules
    this.params = JSON.parse(JSON.stringify(GUIManager.defaultParams))

    this.initCamera()
    this.initPostProcessing()
    this.initStats()

    // Straight to the applied path at startup: the debounce is for drags, and
    // waiting 150ms to size the canvas for the first time would show a frame at
    // the wrong size.
    this.updateOrthoFrustum()
    this.updatePerspFrustum()
    this._applyResize(new Vector2(window.innerWidth, window.innerHeight))
    this.pointerHandler = new Pointer(
      this.renderer,
      this.camera,
      new Plane(new Vector3(0, 1, 0), 0)
    )

    // Initialize modules
    this.lighting = new Lighting(this.scene, this.renderer, this.params)
    this.city = new City(this.scene, this.params)
    // Back-reference, so the systems City owns (interaction, lot growth) can
    // reach the run recorder without being handed it one by one.
    this.city.demo = this
    // The board's ground plane grows with the play area, so City needs to reach
    // the lighting rig that owns it.
    this.city.lighting = this.lighting
    this.city.onGameOver = () => this.gameOver()
    // Let interaction read the ground-plane pointer for empty-slot building
    this.city.interaction.pointer = this.pointerHandler

    // Energy/population HUD - grey blocks generate energy and raise its cap
    // Start on 100 against a 150 cap, so the opening build has room to work with
    // but there is still headroom to bank into before the first wave.
    // No flat base: the cap is the board size (see Mana.setStats), which starts
    // at ~156 - about where the old flat 150 was - and grows as rings open.
    this.mana = new Mana(0, 100)
    // TEMP (?clean): infinite energy so screenshots aren't gated on the economy.
    if (CLEAN_MODE) { this.mana.infinite = true; this.mana.current = 99999 }
    // Per-round economy record, for balancing. ?dev only; see EconLog.
    // The run recorder owns the file both of these end up in, so it goes first -
    // EconLog saves through it at the end of every round.
    if (DEV_MODE) {
      this.run = new RunRecorder(this) // seed + every player action, by sim tick
      this.econ = new EconLog(this) // per-round economy figures
      this.mana.econ = this.econ
    }
    // Sim steps per frame while replaying (?speed=N). One is real time.
    this.replaySpeed = 1
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
        // Building is gated here rather than inside TowerInteraction because
        // Demo is what owns `paused` - and the power-up screen sets the same
        // flag, so the card menu blocks the board for free. Hover and move stay
        // live so nothing gets stuck highlighted when you pause mid-gesture.
        onPointerDown: (intersection, x, y, isTouch) => this.buildLocked
          ? false : this.city.interaction.onPointerDown(intersection, x, y, isTouch),
        onPointerUp: (isTouch, touchIntersection) => {
          if (this.buildLocked) return
          this.city.interaction.onPointerUp(isTouch, touchIntersection)
        },
        onPointerMove: (x, y) => this.city.interaction.onPointerMove(x, y),
        onRightClick: (intersection) => {
          if (this.buildLocked) return
          this.city.interaction.onRightClick(intersection)
        },
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
    // Draws the creep flow field on the ground, so walls read as a maze you are
    // authoring rather than as hit points in the way.
    this.city.flowView = new FlowFieldView(this.city, this.creeps)
    // ...and the single traced route for the wave that's actually next.

    // Friendly units raised by barracks tiles
    this.soldiers = new Soldiers(this.scene, this.city, this.creeps)
    this.city.soldiers = this.soldiers

    // Pick-one-of-four upgrade screen, paid out by clearing a boss round.
    // Crates used to hand these out; they pay resources now (see LootBoxes).
    resetBuffs()
    this.powerUps = new PowerUpScreen(this)
    this.lootBoxes = new LootBoxes(this.scene, this.city, this)
    this.city.lootBoxes = this.lootBoxes // placement checks read it
    if (!CLEAN_MODE) this.lootBoxes.place()
    this.lootBoxes.refresh() // switch off the ones outside the opening play area
    // Cards come from surviving a boss round, not from crates. It fires when the
    // board actually goes quiet - not when the spawn window shuts - so the menu
    // never opens over a field still full of creeps.
    this.creeps.audio.onRoundCleared = (waveIdx) => {
      // Close the round's economy record before anything else - the boss reward
      // opens a menu and grows the board, which would land in the next round's
      // numbers rather than this one's.
      // Nothing to close if the king already died - that round was written down
      // and stamped 'died' at the moment it happened.
      if (!this.kingDead) {
        this.econ?.end()
        this.econ?.begin(waveIdx + 2) // the level now being built for, 1-based
      }
      if (!this.creeps.isBossWave(waveIdx)) return
      if (this.isGameOver || this.kingDead) return
      this._runBossReward()
    }

    // Incoming-wave timeline strip across the top of the screen
    this.creepTimeline = new CreepTimeline(this.creeps)
    if (CLEAN_MODE) this.creepTimeline.el.style.display = 'none'
    // Screen-edge warning arrows for the side the next wave comes from. Creeps
    // reaches back for it to flash the arrow a clump is pouring out of.
    this.waveArrows = new WaveArrows(this)
    this.creeps.waveArrows = this.waveArrows
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
    // Opening framing, pulled back from the original (-22.0998, 60, -15.012) in
    // three steps: +20%, +30%, then +20% again to bring the wave arrows into
    // frame - they sit a half-arrow OUTSIDE the board bounds, so a framing that
    // just fits the board cuts off the thing telling you where the wave lands.
    // 123 units out, against a maxDistance around 319 - wide, with room left.
    this.perspCamera.position.set(-41.3708, 112.32, -28.1024)
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
    // The azimuth the tray icons and the placed-tile geometry were lined up
    // against (see TetrominoGeometry.placeOrient). TilePalette measures the
    // current orbit against this to work out how many quarter turns a dragged
    // tile needs so it lands looking like its icon.
    this.baseAzimuth = this.controls.getAzimuthalAngle()
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
    // Frames the OPEN part of the board, not the full built grid - otherwise the
    // opening 5x5 sits as a speck in the middle of a 13x13 of empty space.
    const span = this.city.visibleHalf * 2
    const halfDiag = Math.hypot(span, span) / 2
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
    this.bloomEnabled = this.postFX.bloomEnabled
    this.bloomPass = this.postFX.bloomPass
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

  /**
   * Say something when the GPU gives up, instead of freezing in silence.
   *
   * A hung tab is the one bug with no evidence: the render loop stops, nothing
   * is logged, and by the time anyone looks the state is gone. WebGPU does tell
   * you - a lost device resolves `device.lost`, and validation failures surface
   * through the uncaptured-error handler - but only if someone is listening.
   *
   * Both paths print what the game was doing at the time, because "it froze
   * after a resize at level 21" and "it froze" are very different bug reports.
   */
  _watchDevice() {
    const device = this.renderer.backend?.device
    if (!device) return
    const state = () => ({
      level: this.creeps?.waveNumber != null ? this.creeps.waveNumber + 1 : '?',
      creeps: this.creeps?.creeps.length ?? '?',
      towers: this.city?.towers.length ?? '?',
      size: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
    })
    device.lost?.then((info) => {
      console.error('[gpu] device lost:', info.reason, info.message, state())
    })
    device.addEventListener?.('uncapturederror', (e) => {
      // First one only: a broken pipeline re-errors every frame, and a thousand
      // identical stack traces buries the one that mattered.
      if (this._gpuErrored) return
      this._gpuErrored = true
      console.error('[gpu] uncaptured error:', e.error?.message || e.error, state())
    })
  }

  /**
   * Window resized.
   *
   * The expensive half is DEBOUNCED. Dragging a window edge fires this ~60 times
   * a second, and every call reallocates the swap chain plus three render
   * targets - the half-res mask, the full-res overlay and the two-attachment
   * glow target. On WebGPU each of those destroys and recreates GPU textures
   * while frames are still in flight, and on a late-game board (a full batched
   * mesh, a hundred creeps, all their effect meshes) the driver cannot keep up:
   * the tab locks solid. Once, after the drag settles, costs the same as one of
   * those sixty and is indistinguishable to look at.
   *
   * The camera frusta are updated immediately - they are pure maths, and they
   * are what keeps the picture from stretching while the drag is in progress.
   */
  onResize(_e, toSize) {
    const size = new Vector2(window.innerWidth, window.innerHeight)
    if (toSize) size.copy(toSize)

    this.updateOrthoFrustum()
    this.updatePerspFrustum()

    clearTimeout(this._resizeTimer)
    this._resizeTimer = setTimeout(() => this._applyResize(size), RESIZE_SETTLE)
  }

  /** The costly part of a resize: the swap chain and the post-processing targets. */
  _applyResize(size) {
    // Nothing to do if we already ran at this size - a resize event can fire
    // without the window actually changing (devtools docking, mobile chrome).
    if (this._sizedTo && this._sizedTo.equals(size)) return
    this._sizedTo = size.clone()

    const { renderer } = this
    renderer.setSize(size.x, size.y)
    renderer.domElement.style.width = `${size.x}px`
    renderer.domElement.style.height = `${size.y}px`
    this.city?.onResize?.(size.x, size.y) // Line2 outline measures in pixels
    if (this.postFX) this.postFX.resize()
  }

  animate() {
    this.stats.begin()

    const { controls, clock, postFX } = this

    // Real elapsed time, clamped: a stall (alt-tab, a breakpoint, a long GC)
    // otherwise arrives as one enormous dt. Used for the CAMERA, which should
    // track the wall clock however the frame went.
    const dt = Math.min(clock.getDelta(), Demo.MAX_DT)

    controls.update(dt)
    this.lighting.updateShadowCamera(this.controls.target, this.camera, this.orthoCamera, this.perspCamera)

    // Game systems freeze before Start, while paused, and once the game-over
    // panel is up. The king dying does NOT freeze anything on its own - the city
    // keeps running for GAME_OVER_DELAY seconds first (see kingDead below).
    if (this.started && !this.paused && !this.isGameOver && !this.tabHidden) {
      // Several sim steps per rendered frame when a recording is being fast-
      // forwarded. This is what the fixed timestep buys: the world does not care
      // how often it is drawn, so playback can run as fast as the machine can
      // simulate while still producing exactly the same run.
      const steps = this.run?.replaying ? this.replaySpeed : 1
      for (let i = 0; i < steps; i++) {
        if (this.isGameOver) break // it can end partway through a batch
        // Before the world moves: playback fires anything recorded for this
        // tick, so an action lands in the same state it was taken in.
        this.run?.advance()
        this.stepGame(Demo.SIM_DT)
        // Inside the loop, not after it. The king's death does not stop the
        // city - it runs on for GAME_OVER_DELAY while the creeps finish the job
        // - so this countdown is world time like everything else. Ticked once a
        // FRAME it fell behind a fast-forwarded replay by exactly the replay
        // speed, handing the creeps four times as long to knock things down
        // after the run had already ended.
        if (this.kingDead && !this.isGameOver) {
          this.gameOverDelay -= Demo.SIM_DT
          if (this.gameOverDelay <= 0) this.showGameOver()
        }
      }
    }

    this.creepTimeline.update()
    this.waveArrows.update(dt)
    this.floatingText.update(this.camera, dt)

    // Feed turret range circles to the coverage-glow mask.
    if (!this._turretCircles) this._turretCircles = []
    postFX.setTurretCircles(this.city.getTurretCircles(this._turretCircles))

    postFX.render()

    this.stats.end()
  }

  /**
   * Run anything scheduled with `after()` that is now due.
   *
   * Sim time, not wall clock: these fire things that change the world - the
   * board opening after a boss round, the upgrade screen - and a setTimeout
   * would put them at a different point in the game depending on the frame rate
   * or the replay speed.
   */
  _pumpTimers() {
    if (!this._timers?.length) return
    this.simTime += Demo.SIM_DT
    for (let i = this._timers.length - 1; i >= 0; i--) {
      const t = this._timers[i]
      if (this.simTime < t.at) continue
      this._timers.splice(i, 1)
      t.fn()
    }
  }

  /** Call `fn` after `seconds` of SIM time. Returns a handle for cancel(). */
  after(seconds, fn) {
    if (!this._timers) { this._timers = []; this.simTime = this.simTime || 0 }
    const t = { at: this.simTime + seconds, fn }
    this._timers.push(t)
    return t
  }

  /** Drop a scheduled callback that has not fired yet. */
  cancelAfter(handle) {
    const i = this._timers?.indexOf(handle) ?? -1
    if (i >= 0) this._timers.splice(i, 1)
  }

  /** Advance all game systems by `dt` seconds. */
  stepGame(dt) {
    this._pumpTimers()
    // The score stops the moment the king dies, not when the panel appears -
    // the run ended at the death, the extra seconds are just the aftermath.
    if (!this.kingDead) this.mana.tick(dt)
    this.mana.setLevel(this.creeps.waveNumber + 1)
    this.econ?.tick(dt)
    this.city.update(dt)
    this.trails.update(dt)
    // Clean screenshot mode: the wave clock never runs, so no creeps ever come.
    if (!CLEAN_MODE) this.creeps.update(dt)
    this.lootBoxes.update(dt)
    this.soldiers.update(dt)
    this.turrets.update(dt)
    // The palette belongs to the SIM, not the frame: its refill timer decides
    // which tile is in which slot, so a recorded placement only finds the tile
    // it was recorded with if the timer advanced by the same clock the world
    // did. Ticked per frame on real time, a 4x replay refilled four times too
    // slowly and placed whatever happened to be there instead.
    this.tilePalette.update(dt)
  }

  /** True while the board should ignore build/destroy input. */
  get buildLocked() {
    return this.paused || this.isGameOver || this.kingDead
  }

  /**
   * The beat after a boss round: quiet, then the board opens, then the cards.
   *
   * Three payoffs used to land on top of each other - the round-clear fanfare,
   * the board growing, and the upgrade menu - which turned the best moment in the
   * run into a mess. Spaced out they read as a sequence: you survived, you gained
   * ground, now choose.
   */
  _runBossReward() {
    const alive = () => !this.isGameOver && !this.kingDead
    this._cancelBossReward()
    // 1. Let the fanfare and the last debris settle.
    // Sim time, not setTimeout: growing the board changes the energy cap, the
    // spawn ring and the play area, so it has to happen at the same point in the
    // GAME every time rather than a fixed number of milliseconds later.
    this._bossTimers = []
    this._bossTimers.push(this.after(Demo.BOSS_COOLDOWN, () => {
      if (!alive()) return
      // 2. The board opens up.
      if (this.city.growPlayArea()) this.updateZoomLimit()
    }))
    // 3. ...and once that has played, the choice.
    this._cardTimer = this.after(Demo.BOSS_COOLDOWN + Demo.EXPAND_TIME + Demo.CARD_DELAY, () => {
      this._cardTimer = null
      if (alive()) this.powerUps.show()
    })
  }

  /** Drop any boss beat still in flight, so a second one can't stack on it. */
  _cancelBossReward() {
    for (const t of this._bossTimers || []) this.cancelAfter(t)
    this._bossTimers = []
    if (this._cardTimer) this.cancelAfter(this._cardTimer)
    this._cardTimer = null
  }

  /**
   * DEV: play the whole boss-clear beat on demand - the fanfare, the quiet, the
   * board opening, the cards - without surviving to a boss round. Wired to the
   * GUI button, because the expand animation is otherwise four minutes of play
   * away from every tweak to it.
   *
   * Rewinds the play area first once the board has run out of rings, so the
   * sequence stays watchable however many times you press it.
   */
  previewBossReward() {
    if (!this.city.canGrowPlayArea) this.city.rewindPlayArea()
    // Exactly what WaveAudio fires on a real boss clear, so the beat starts the
    // same way rather than drifting from it.
    this.creeps.audio.playRoundClear(true)
    this.creeps._quietTimer = this.creeps.roundEndQuiet
    this._runBossReward()
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
      font: '600 13px Inter, system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(20,20,28,0.8)',
      border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '999px',
      cursor: 'pointer',
      backdropFilter: 'blur(4px)',
    })
    // Opens (or closes) the same pause menu Esc does, rather than silently
    // freezing the game - the menu IS the paused state.
    btn.addEventListener('click', () => this.toggleMenu())
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
      this.creeps?.audio.resetCues()
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
    // Close the round the king died in. Rounds are otherwise only closed when
    // the board goes quiet, so the one that actually ended the run - the one
    // worth reading - was the one round never written down.
    this.econ?.end('died')
    if (this.run) {
      this.run.diedAt = {
        tick: this.run.tick,
        seconds: Math.round(this.run.tick * Demo.SIM_DT),
        level: this.creeps.waveNumber + 1,
        score: Math.floor(this.mana.elapsed),
      }
    }
    // Plays out across the GAME_OVER_DELAY window while the creeps finish the
    // job, and has decayed by the time the score panel goes up.
    Sounds.play('game-over', 1.0, 0, 0.85)
  }

  /** Freeze the game and show the score panel. */
  showGameOver() {
    if (this.isGameOver) return
    this.isGameOver = true
    // The run is over: write it out. A recording is only worth having if it
    // survives the tab, and the interesting runs are the ones that end.
    this.run?.save()
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
      // A light scrim: the city you just lost stays visible behind the text,
      // dimmed just enough to lift the labels off it.
      background: 'rgba(0,0,0,0.15)',
      pointerEvents: 'none',
    })
    const title = document.createElement('div')
    title.textContent = 'GAME OVER'
    Object.assign(title.style, {
      color: ENERGY_COLOR, font: '800 72px Inter, system-ui, sans-serif',
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
      color: '#fff', font: '700 30px Inter, system-ui, sans-serif', textShadow: TEXT_SHADOW,
    })
    const bestEl = document.createElement('div')
    bestEl.textContent = isBest ? `★ new best ★` : `best: ${best}`
    Object.assign(bestEl.style, {
      color: isBest ? ENERGY_COLOR : '#dfdfdf', font: '600 20px Inter, system-ui, sans-serif',
      textShadow: TEXT_SHADOW,
    })
    stats.appendChild(scoreEl)
    stats.appendChild(bestEl)

    const btn = document.createElement('button')
    btn.textContent = 'Restart'
    Object.assign(btn.style, {
      padding: '12px 36px', font: '600 18px Inter, system-ui, sans-serif', color: '#fff',
      background: 'rgba(0,0,0,0.35)', border: '2px solid #fff', borderRadius: '24px',
      cursor: 'pointer', textShadow: TEXT_SHADOW,
      pointerEvents: 'auto', // the panel itself is click-through; the button isn't
    })
    btn.addEventListener('click', () => location.reload())
    el.appendChild(title)
    el.appendChild(stats)
    // Shared leaderboard between the stats and the button. Fills in async;
    // adds nothing at all when the API is unreachable (e.g. local dev).
    const board = document.createElement('div')
    el.appendChild(board)
    new HighScores().buildInto(board, final)
    el.appendChild(btn)
    document.body.appendChild(el)
  }

  /**
   * Esc pause menu - same shape as the game-over panel: big title, score +
   * best underneath, buttons at the bottom. Esc toggles it; opening pauses the
   * game, Resume unpauses, New game reloads.
   */
  toggleMenu() {
    if (!this.started || this.isGameOver || this.kingDead) return
    if (this.powerUps?.open) return // the card screen owns the freeze
    if (this.tilePalette?.drag) return // Esc there cancels the held tile instead
    if (this.menuEl) this._hideMenu()
    else this._showMenu()
  }

  _showMenu() {
    this.paused = true
    this.setPauseAudio(true)
    if (this.pauseButton) this.pauseButton.textContent = '▶ Play'

    const el = document.createElement('div')
    el.id = 'game-menu'
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2000',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '28px',
      // Same as the game-over panel: a light scrim to lift the text off the
      // city without hiding it.
      background: 'rgba(0,0,0,0.15)',
      pointerEvents: 'none',
    })
    const title = document.createElement('div')
    title.textContent = 'PAUSED'
    Object.assign(title.style, {
      color: ENERGY_COLOR, font: '800 72px Inter, system-ui, sans-serif',
      letterSpacing: '2px', textShadow: TEXT_SHADOW,
    })

    const score = Math.floor(this.mana?.elapsed || 0)
    let best = 0
    try { best = parseInt(localStorage.getItem('cityBuilderHighScore') || '0', 10) || 0 } catch (e) { /* storage blocked */ }

    const stats = document.createElement('div')
    Object.assign(stats.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
    })
    const scoreEl = document.createElement('div')
    scoreEl.textContent = `score: ${score}`
    Object.assign(scoreEl.style, {
      color: '#fff', font: '700 30px Inter, system-ui, sans-serif', textShadow: TEXT_SHADOW,
    })
    const bestEl = document.createElement('div')
    bestEl.textContent = `best: ${Math.max(best, score)}`
    Object.assign(bestEl.style, {
      color: '#dfdfdf', font: '600 20px Inter, system-ui, sans-serif', textShadow: TEXT_SHADOW,
    })
    stats.appendChild(scoreEl)
    stats.appendChild(bestEl)

    const buttons = document.createElement('div')
    Object.assign(buttons.style, { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '16px' })
    const buttonStyle = {
      padding: '12px 36px', font: '600 18px Inter, system-ui, sans-serif', color: '#fff',
      background: 'rgba(0,0,0,0.35)', border: '2px solid #fff', borderRadius: '24px',
      cursor: 'pointer', textShadow: TEXT_SHADOW,
      pointerEvents: 'auto', // the panel itself is click-through; the buttons aren't
    }
    const resume = document.createElement('button')
    resume.textContent = 'Resume game'
    Object.assign(resume.style, buttonStyle)
    resume.addEventListener('click', () => this._hideMenu())
    const restart = document.createElement('button')
    restart.textContent = 'New game'
    Object.assign(restart.style, buttonStyle)
    // ?play skips the start menu after the reload, straight into the new run.
    restart.addEventListener('click', () => {
      const url = new URL(location.href)
      url.searchParams.set('play', '1')
      location.replace(url)
    })
    const tute = document.createElement('button')
    tute.textContent = 'Tutorial'
    Object.assign(tute.style, buttonStyle)
    // The slideshow opens over this menu (higher z-index); its last click just
    // closes it again and lands back here, still paused.
    tute.addEventListener('click', () => this.tutorial?.show(() => {}))
    buttons.appendChild(resume)
    buttons.appendChild(restart)
    buttons.appendChild(tute)

    el.appendChild(title)
    el.appendChild(stats)
    el.appendChild(buttons)
    document.body.appendChild(el)
    this.menuEl = el
  }

  _hideMenu() {
    if (!this.menuEl) return
    document.body.removeChild(this.menuEl)
    this.menuEl = null
    this.paused = false
    this.setPauseAudio(false)
    if (this.pauseButton) this.pauseButton.textContent = '⏸ Pause'
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
      font: '600 13px Inter, system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(20,20,28,0.8)',
      border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '999px',
      cursor: 'pointer',
      backdropFilter: 'blur(4px)',
    })
    btn.addEventListener('click', () => this.skipAhead())
    this.fastForwardButton = btn
    document.body.appendChild(btn)
  }

  /**
   * Jump the wave schedule forward 20 seconds.
   *
   * A player action like any other, so it is recorded - a replay that skipped
   * the same twenty seconds sees a different wave arrive at a different tick,
   * and diverges from there.
   */
  skipAhead() {
    const SKIP = 20
    this.run?.record('skip', {})
    this.creeps.skipAhead(SKIP)
    this.creepTimeline.tweenTo(this.creeps.elapsed)
    // Credit the skipped time to the survival-score clock.
    this.mana.elapsed += SKIP
    this.mana.render()
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
