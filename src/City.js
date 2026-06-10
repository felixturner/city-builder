import {
  MathUtils,
  Vector2,
  Vector3,
  Object3D,
  BatchedMesh,
  MeshPhysicalNodeMaterial,
  Color,
  GridHelper,
  PlaneGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  RingGeometry,
  LineSegments,
  LineBasicNodeMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  Box3,
} from 'three/webgpu'
import gsap from 'gsap'
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture, mrt, uv, fract, step, min, float } from 'three/tsl'
import { Tower } from './Tower.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { Debris } from './lib/Debris.js'
import { Sounds } from './lib/Sounds.js'
import FastSimplexNoise from '@webvoxel/fast-simplex-noise'

// Rotate a vec3 around Y axis by angle (in radians)
const rotateY = (v, angle) => {
  const c = cos(angle)
  const s = sin(angle)
  return vec3(
    v.x.mul(c).add(v.z.mul(s)),
    v.y,
    v.z.mul(c).sub(v.x.mul(s))
  )
}

export class City {
  // City size in lots (7x7 = 49 lots). Change this to resize the city.
  static CITY_SIZE_LOTS = 7

  constructor(scene, params) {
    this.scene = scene
    this.params = params

    this.towers = []
    this.towerMesh = null
    this.towerMaterial = null
    this.dummy = new Object3D()
    this.towerSize = new Vector2(1, 1)
    this.towerCenter = new Vector2()

    // City height distribution noise - lower frequency for larger "neighborhoods"
    this.noiseFrequency = params.scene.noiseScale
    this.cityNoise = new FastSimplexNoise({
      frequency: this.noiseFrequency,
      octaves: 3,
      min: 0,
      max: 1,
      persistence: 0.6,
    })
    this.heightNoiseScale = params.scene.noiseHeight
    this.randHeightAmount = params.scene.randHeight
    this.randHeightPower = params.scene.randHeightPower
    this.noiseSubtract = params.scene.noiseSubtract
    this.centerFalloff = params.scene.centerFalloff
    this.skipChance = params.scene.skipChance

    this.actualGridWidth = 0
    this.actualGridHeight = 0

    // Hover state
    this.hoveredTower = null
    // Accent colors for lit towers, trails, and new floors
    const baseAccentColors = [
      new Color('#FC238D'),
      new Color('#D2E253'),
      new Color('#1BB3F6'),
    ]
    // Transform colors: boost saturation slightly, increase lightness
    this.accentColors = baseAccentColors.map(c => {
      const hsl = {}
      c.getHSL(hsl)
      return new Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.min(1, hsl.l + 0.2))
    })
    this.instanceToTower = new Map() // Maps instance ID to tower
    this.turretColor = new Color(0xbbbbbb) // grey shade for turret tower blocks
    this.emptyTowerOutlines = new Map() // tower -> grey floor-outline mesh

    // Floor stacking config
    this.maxFloors = 10
    this.floorHeight = 2

    // Click state (for drag detection)
    this.pressedTower = null
    this.pointerDownPos = new Vector2()
    this.dragThreshold = 5 // pixels

    // Debris system
    this.debris = new Debris(scene, params.material)

    // Resource meter (set by Demo). Each build click spends 1 mana.
    this.mana = null

    // Power-line connectors (Trails instance set by Demo).
    this.trails = null
    this.activeConnectorCount = 0
    this.connectorMana = 0 // mana per tick from connectors (height/area weighted)
    this.connectorContribution = new Map() // tower -> its share of connectorMana
    // Monastery scoring: clustered plain towers swap to the Hole_Top (type 2)
    // and earn points per adjacent monastery.
    this.monasteryMana = 0
    this.monasteryClusters = [] // [{members, energy, cx, cy, cz}] generating hole groups
    this.litMonasteries = new Set() // built hole blocks that pulse-glow on the tick
    // Scheduled per-tower generation flashes: {tower, t, amt, sound}. Each fires
    // its glow + caption + sound together at its own offset within the cycle.
    this.pulseEvents = []
    this.manaTimer = 0 // Accumulates toward mana generation from connectors
    this.greyManaTimer = 0 // Accumulates toward passive mana from grey blocks

    // Floating "+N" energy captions (FloatingText instance set by Demo).
    this.floatingText = null

    // Towers currently part of an active connector pulse to show they're live
    this.connectedTowers = new Set()
    // Per-tower flash envelopes live on each tower (tower.pulseEnv), set to 1
    // when that tower's scheduled generation event fires (see pulseEvents).
    this._pulseColor = new Color()

    // Lot growth: a developed lot spreads into an empty neighbour once its
    // total built height (sum of floors) crosses this threshold.
    this.lots = []
    // Points (neighbours + clicks) a dormant lot needs to spawn. Tunable via GUI.
    this.lotSpawnThreshold = 15
    // Lots spawn on neighbour points; clicking a lot's rect adds bonus points.
    this.lotClickValue = 5 // points added per direct click on a dormant lot
    // When true, clicks (build/destroy/spawn) don't cost mana (GUI toggle).
    this.freeClicks = false

    // Active reroll build-wheel timers (right-click): {tower, ring, mat, t, step}.
    this.rerollTimers = []
    this.rerollDuration = 5 // seconds for a rerolled block to spawn
    this.rerollSteps = 48 // discrete fill steps of the build-wheel ring
    // Cached ring-fill geometries (step -> RingGeometry). NEVER disposed: in the
    // WebGPU backend disposing a live geometry / swapping a mesh's .geometry
    // triggers a setIndexBuffer crash, so we keep them and rebuild the mesh.
    this.rerollRingGeos = new Map()

    // ZOC circle visuals (one translucent ring outline per visible plus block).
    this.zocCircles = new Map() // tower -> Mesh
    this.zocRingGeos = new Map() // numFloors -> RingGeometry (fixed thickness)
    // Turret range circles (one white ring per visible turret tower). Hidden by
    // default now that the post-process coverage gradient shows range instead.
    this.showTurretRanges = false
    this.rangeCircles = new Map() // tower -> Mesh
    this.rangeRingGeos = new Map() // numFloors -> RingGeometry ((n+1) cells radius)
    this._zc = new Vector2()
  }

  async init() {
    await BlockGeometry.init()
    this.initGrid()
    await this.initTowers()
    this.updateMatrices()
    this.recalculateVisibility()
    this.refreshManaStats()
  }

  initGrid() {
    // A buildable "cell" is 2 world units (a 2x2 block of the original cells).
    this.cellUnit = 2
    // Lot layout (world units): 10-unit lots (5 cells) separated by 4-unit roads (2 cells)
    this.lotSize = 10
    this.roadWidth = 4
    this.cellSize = this.lotSize + this.roadWidth // 14 world units per lot pitch

    // City dimensions from static constant
    this.numLotsX = City.CITY_SIZE_LOTS
    this.numLotsY = City.CITY_SIZE_LOTS

    // Store actual grid dimensions for centering
    this.actualGridWidth = this.numLotsX * this.cellSize
    this.actualGridHeight = this.numLotsY * this.cellSize

    // Calculate center lot for positioning
    this.centerLotX = Math.floor(this.numLotsX / 2)
    this.centerLotZ = Math.floor(this.numLotsY / 2)

    // Grid offset: position mesh so center of center lot is at origin
    this.gridOffsetX = -(this.centerLotX * this.cellSize + this.lotSize / 2)
    this.gridOffsetZ = -(this.centerLotZ * this.cellSize + this.lotSize / 2)

    // Pre-generate every lot in the city so the BatchedMesh has instances for
    // all of them. Only the central 3x3 starts "active" (visible/buildable);
    // the rest are dormant (hidden) until the player grows into them. Spawned
    // lots reveal their pre-baked sparse fill. Center lot is full; everything
    // else is sparse so growth radiates from a dense core.
    this.lots = []
    for (let lotY = 0; lotY < this.numLotsY; lotY++) {
      const row = []
      for (let lotX = 0; lotX < this.numLotsX; lotX++) {
        const startX = lotX * this.cellSize
        const startY = lotY * this.cellSize
        const firstTower = this.towers.length

        // Only the center lot starts active; its 8 neighbours (and everything
        // beyond) grow in via the normal lot-spawning logic.
        const isCenter = lotX === this.centerLotX && lotY === this.centerLotZ
        const density = isCenter ? 0.8 : 0.5

        this.fillLot(startX, startY, startX + this.lotSize, startY + this.lotSize, density)
        this.assignLotPlus(firstTower)

        // Each lot has one of the 3 accent colors; its colored blocks (plus
        // blocks and turrets), outline, and growth square all use it.
        const lotColorIndex = MathUtils.randInt(0, this.accentColors.length - 1)

        const towers = this.towers.slice(firstTower)
        for (const t of towers) {
          t.lotX = lotX
          t.lotY = lotY
          t.colorIndex = lotColorIndex // all colored blocks match the lot
          t.dormant = !isCenter
          // Visible only if its lot is active AND the slot isn't an empty one.
          t.visible = isCenter && !t.empty
        }
        row.push({ lotX, lotY, colorIndex: lotColorIndex, towers, active: isCenter })
      }
      this.lots.push(row)
    }

    this.finalizeGrid()
  }

  /**
   * Turn exactly one SQUARE tower into the lot's plus block (generator). Plus
   * blocks (Cross_Top) only go on square footprints; if a lot has no square,
   * it gets no generator.
   */
  assignLotPlus(firstTower) {
    // Only present (non-empty) square towers can be the lot's plus block.
    const size = new Vector2()
    const squares = this.towers.slice(firstTower).filter(t => {
      if (t.empty) return false
      t.box.getSize(size)
      return size.x === size.y
    })
    if (squares.length === 0) return

    const plus = squares[MathUtils.randInt(0, squares.length - 1)]
    plus.typeTop = 5 // Cross_Top
    plus.typeBottom = BlockGeometry.topToBottom.get(5)
  }

  /**
   * Convert grid coordinates to world coordinates
   * Grid coords: 0 to actualGridWidth/Height
   * World coords: centered at origin
   * @param {number} gridX - X position in grid space
   * @param {number} gridZ - Z position in grid space (note: grid uses Y, world uses Z)
   * @returns {{x: number, z: number}} World position
   */
  gridToWorld(gridX, gridZ) {
    return {
      x: gridX + this.gridOffsetX,
      z: gridZ + this.gridOffsetZ
    }
  }

  fillLot(startX, startY, endX, endY, density = 1) {
    const cell = this.cellUnit // world units per buildable cell
    // Lot dimensions in cells
    const width = (endX - startX) / cell
    const height = (endY - startY) / cell

    // Occupied grid for this lot (in cells)
    const occupied = Array.from({ length: width }, () => Array(height).fill(-1))

    const maxBlockSize = new Vector2()
    maxBlockSize.x = MathUtils.randInt(1, 3)
    maxBlockSize.y = maxBlockSize.x

    const squareChance = 0.5
    let px = 0
    let py = 0
    let turretCount = 0 // cap turrets (Peg=3 / Divot=4) per lot

    while (py < height) {
      while (px < width) {
        // Find available width (in cells)
        let maxW = 0
        const end = Math.min(width, px + maxBlockSize.x)
        for (let i = px; i < end; i++) {
          if (occupied[i][py] != -1) break
          maxW++
        }
        // Skip if no room for even a 1x1 cell tower
        if (maxW < 1) {
          px++
          continue
        }

        const tower = new Tower()
        const isSquare = MathUtils.randFloat(0, 1) < squareChance

        const sx = MathUtils.randInt(1, maxW)
        const sy = isSquare ? sx : MathUtils.randInt(1, Math.min(maxBlockSize.y, height - py))

        // Skip towers that extend outside the lot bounds (creates empty areas)
        if (px + sx > width || py + sy > height) {
          px++
          continue
        }

        // Top type: turrets (Peg=3 / Divot=4) only on 1x1 blocks; holes (2) and
        // bigger decorative tops on any square. Plus blocks (5) set in initGrid.
        const is1x1 = sx === 1 && sy === 1
        let tt = isSquare ? MathUtils.randInt(0, is1x1 ? 4 : 2) : 0
        if (tt === 3 || tt === 4) {
          // Allow at most 2 turrets per lot; extras become plain towers.
          if (turretCount >= 2) tt = MathUtils.randInt(0, 2)
          else turretCount++
        }
        tower.typeTop = tt
        tower.typeBottom = BlockGeometry.topToBottom.get(tower.typeTop)
        tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))

        // Sparse lots: some slots start "empty" - the block size is locked in
        // here, but it's hidden until the player clicks that ground to build it.
        tower.empty = MathUtils.randFloat(0, 1) > density

        // Convert local cell coords to world grid coords
        const globalX = startX + px * cell
        const globalY = startY + py * cell
        const worldW = sx * cell
        const worldH = sy * cell
        tower.box.min.set(globalX, globalY)
        tower.box.max.set(globalX + worldW, globalY + worldH)

        // Store noise and random values
        const centerX = globalX + worldW / 2
        const centerY = globalY + worldH / 2
        tower.cityNoiseVal = this.cityNoise.scaled2D(centerX, centerY)
        tower.randFactor = MathUtils.randFloat(0, 1)
        tower.skipFactor = MathUtils.randFloat(0, 1) // For realtime visibility
        tower.rotation = isSquare
          ? (MathUtils.randInt(0, 4) * Math.PI) / 2
          : MathUtils.randInt(0, 2) * Math.PI
        tower.colorIndex = MathUtils.randInt(0, 2)

        this.towers.push(tower)

        // Mark cells as occupied (local cell coords)
        const localEndX = Math.min(width, px + sx)
        const localEndY = Math.min(height, py + sy)
        for (let i = px; i < localEndX; i++) {
          for (let j = py; j < localEndY; j++) {
            occupied[i][j] = tower.id
          }
        }
        px += sx
      }
      py++
      px = 0

      // Randomly vary max block size within the lot
      if (MathUtils.randFloat(0, 1) > 0.8) {
        maxBlockSize.x = MathUtils.randFloat(0, 1) > 0.5 ? 1 : 3
        maxBlockSize.y = MathUtils.randFloat(0, 1) > 0.5 ? 1 : 3
      }
    }
  }

  finalizeGrid() {
    console.log('Tower count:', this.towers.length, 'instances:', this.towers.length * 2)
    // Game start: the central lot gets procedural random heights; every other
    // lot begins flat (0 floors = just the thin top block) until grown into.
    // The intro animation reads numFloors as each tower's target build height.
    for (const tower of this.towers) {
      const isCenterLot = tower.lotX === this.centerLotX && tower.lotY === this.centerLotZ
      tower.numFloors = isCenterLot ? this.floorsForTower(tower) : 0
    }
    this.updateMatrices()
  }

  async initTowers() {
    // Material values set by applyParams
    const mat = new MeshPhysicalNodeMaterial()
    this.towerMaterial = mat

    // Environment rotation uniform (radians)
    this.envRotation = uniform(0)

    // Custom environment node with rotation support
    // We'll set this up after the scene environment is loaded
    this.setupEnvRotation()

    const geoms = []
    for (let i = 0; i < BlockGeometry.geoms.length; i++) {
      geoms.push(BlockGeometry.geoms[i])
    }

    const vCounts = []
    const iCounts = []
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i]
      vCounts.push(g.attributes.position.count)
      iCounts.push(g.index.count)
    }

    // Calculate total geometry needed for all towers with max floors
    let totalV = 0
    let totalI = 0
    for (let i = 0; i < this.towers.length; i++) {
      const tower = this.towers[i]
      // maxFloors base instances + 1 roof instance per tower
      totalV += vCounts[tower.typeBottom] * this.maxFloors
      totalV += vCounts[tower.typeTop]
      totalI += iCounts[tower.typeBottom] * this.maxFloors
      totalI += iCounts[tower.typeTop]
    }

    const maxInstances = this.towers.length * (this.maxFloors + 1) + 10 // +10 for debug instances
    this.towerMesh = new BatchedMesh(maxInstances, totalV, totalI, mat)
    this.towerMesh.sortObjects = false
    this.towerMesh.castShadow = true
    this.towerMesh.receiveShadow = true
    // Center the middle lot at the origin (use pre-calculated offset)
    this.towerMesh.position.x = this.gridOffsetX
    this.towerMesh.position.z = this.gridOffsetZ
    this.scene.add(this.towerMesh)

    const geomIds = []
    for (let i = 0; i < geoms.length; i++) {
      geomIds.push(this.towerMesh.addGeometry(geoms[i]))
    }
    this.geomIds = geomIds // kept for runtime tile re-rolls on destroy

    // Create instances for each tower: maxFloors base + 1 roof
    for (let i = 0; i < this.towers.length; i++) {
      const tower = this.towers[i]
      tower.floorInstances = []

      // Create floor instances (base geometry)
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = this.towerMesh.addInstance(geomIds[tower.typeBottom])
        this.towerMesh.setColorAt(idx, tower.baseColor)
        this.towerMesh.setVisibleAt(idx, false)
        tower.floorInstances.push(idx)
        this.instanceToTower.set(idx, tower)
      }

      // Create roof instance (top geometry)
      tower.roofInstance = this.towerMesh.addInstance(geomIds[tower.typeTop])
      this.towerMesh.setColorAt(tower.roofInstance, tower.topColor)
      this.towerMesh.setVisibleAt(tower.roofInstance, false)
      this.instanceToTower.set(tower.roofInstance, tower)
    }

    console.log('Tower count:', this.towers.length, 'Max instances:', maxInstances)

    // Light up all plus/cross towers with hover colors
    this.applyLitTowers()
  }

  /**
   * Light up all plus/cross shaped towers (typeTop === 5) with hover colors
   */
  applyLitTowers() {
    for (const tower of this.towers) {
      tower.isLit = tower.typeTop === 5 // Cross_Top
      if (tower.isLit) {
        const accentColor = this.accentColors[tower.colorIndex]
        // Store the lit color on the tower for hover restore
        tower.litColor = accentColor.clone()
        // Apply accent color to all floor instances
        for (const idx of tower.floorInstances) {
          this.towerMesh.setColorAt(idx, accentColor)
        }
        // Apply to roof too
        this.towerMesh.setColorAt(tower.roofInstance, accentColor)
      } else if (tower.typeTop === 2) {
        // Hole block: whole tower the lot accent; litColor enables the glow.
        const accent = this.accentColors[tower.colorIndex]
        tower.litColor = accent.clone()
        tower.baseColor = accent.clone()
        tower.topColor = accent.clone()
        this._setTowerColor(tower, accent)
      } else {
        tower.litColor = null
        // Peg (3) and Divot (4) towers are turrets - give them one accent color.
        if (tower.typeTop === 3 || tower.typeTop === 4) {
          this.colorTurretTower(tower)
          this._setTowerColor(tower, tower.baseColor)
        }
      }
    }
  }

  /**
   * Turret towers keep grey blocks, but stash the lot's accent color on
   * laserColor so the laser beam / projectiles still read colored.
   */
  colorTurretTower(tower) {
    tower.laserColor = this.accentColors[tower.colorIndex].clone()
    tower.baseColor = this.turretColor
    tower.topColor = this.turretColor
  }

  /**
   * Compute a tower's procedural floor count from city noise + a skewed random
   * factor, attenuated by distance from the city center. Pure: returns the
   * floor count without mutating the tower.
   */
  floorsForTower(tower) {
    const gridCenterX = this.actualGridWidth / 2
    const gridCenterY = this.actualGridHeight / 2
    const center = tower.box.getCenter(this.towerCenter)

    // Distance from center falloff using max axis distance (0 at center, 1 at any edge)
    const dx = Math.abs(center.x - gridCenterX)
    const dy = Math.abs(center.y - gridCenterY)
    const normalizedDist = Math.max(dx / gridCenterX, dy / gridCenterY)
    const distFactor = 1 - Math.pow(normalizedDist, 2) * this.centerFalloff

    // Subtract from noise, clamp to 0, then cube for contrast
    const adjustedNoise = Math.max(0, tower.cityNoiseVal - this.noiseSubtract)
    const noiseHeight = Math.pow(adjustedNoise, 3) * this.heightNoiseScale
    // Power > 1 skews distribution: most towers short, few tall outliers
    const randHeight = Math.pow(tower.randFactor, this.randHeightPower) * this.randHeightAmount
    const height = (noiseHeight + randHeight) * distFactor
    return Math.floor(height / this.floorHeight)
  }

  recalculateHeights() {
    for (let i = 0; i < this.towers.length; i++) {
      this.towers[i].numFloors = this.floorsForTower(this.towers[i])
    }
    this.updateMatrices()
  }

  /**
   * Intro animation: build all towers from ground up, staggered from center outward
   * @param {Camera} camera - The camera to animate
   * @param {OrbitControls} controls - OrbitControls instance
   * @param {number} duration - Total animation duration in seconds
   */
  startIntroAnimation(camera, controls, duration = 4) {
    const gridCenterX = this.actualGridWidth / 2
    const gridCenterY = this.actualGridHeight / 2

    // Mute build sounds during intro (except pop) and disable debris
    Sounds.mute(['stone', 'tick', 'clink'])
    const debrisWasEnabled = this.debris.enabled
    this.debris.enabled = false

    // 1. Store target floor counts, set all to 0. Only visible towers build;
    //    hidden slots (empty/dormant) keep targetFloors 0 so they aren't flashed
    //    in and then erased when updateTowerMatrices re-hides them.
    const towerData = this.towers.map(tower => {
      const targetFloors = tower.visible ? tower.numFloors : 0
      const center = tower.box.getCenter(new Vector2())
      const dist = Math.hypot(center.x - gridCenterX, center.y - gridCenterY)
      tower.numFloors = 0
      return { tower, targetFloors, dist }
    })
    this.updateMatrices()

    // 2. Sort by distance (center first). Normalize the stagger against the
    //    farthest *building* tower (not the whole-city diagonal), so the active
    //    lot ripples across the full stagger window instead of starting at once.
    towerData.sort((a, b) => a.dist - b.dist)
    const building = towerData.filter(t => t.targetFloors > 0)
    const maxDist = building[building.length - 1]?.dist || 1

    // 3. Animate each tower's floors with stagger
    const staggerDuration = duration * 0.85 // 85% of duration for stagger spread
    const floorDelay = 0.25 // 250ms between floors of same tower

    let maxDelay = 0
    towerData.forEach(({ tower, targetFloors, dist }) => {
      if (targetFloors === 0) return

      const staggerDelay = (dist / maxDist) * staggerDuration

      // Animate each floor sequentially (no debris during intro)
      const baseColor = tower.isLit && tower.litColor ? tower.litColor : tower.baseColor
      const newFloorColor = Tower.lightenColor(baseColor)
      // Volume fades based on distance (0 at 3 lots away)
      const maxSoundDist = this.cellSize * 3 // 3 lots
      const volume = Math.max(0, 1 - dist / maxSoundDist) * 0.5
      for (let f = 0; f < targetFloors; f++) {
        const delay = staggerDelay + f * floorDelay
        maxDelay = Math.max(maxDelay, delay)
        setTimeout(() => {
          tower.numFloors = f + 1
          // Play pop sound with pitch based on floor height, volume based on distance
          const pitch = 0.8 + (f / this.maxFloors) * 1.2
          if (volume > 0) Sounds.play('pop', pitch, 0.15, volume)
          tower.animateNewFloor(
            this.towerMesh,
            this.floorHeight,
            f,
            newFloorColor,
            () => this.updateTowerMatrices(tower),
            null // no debris
          )
        }, delay * 1000)
      }
    })

    // Unmute sounds and restore debris after intro completes. Also refresh
    // tower visuals once so monasteries/connectors reflect the settled city
    // (the intro builds via updateTowerMatrices, which skips that pass).
    setTimeout(() => {
      Sounds.unmute(['stone', 'tick', 'clink'])
      this.debris.enabled = debrisWasEnabled
      this.updateTowerVisuals()
    }, (maxDelay + 1) * 1000)

    // 4. Camera zoom animation (angle-based distance)
    const target = controls.target.clone()
    const direction = camera.position.clone().sub(target).normalize()
    const endDist = camera.position.distanceTo(target)
    const startDist = endDist * 3

    // Set initial zoomed-out position
    camera.position.copy(target).addScaledVector(direction, startDist)

    // Animate distance only
    const animState = { dist: startDist }
    gsap.to(animState, {
      dist: endDist,
      duration: duration,
      ease: 'power2.out',
      onUpdate: () => {
        camera.position.copy(target).addScaledVector(direction, animState.dist)
        controls.update()
      }
    })
  }

  updateMatrices() {
    if (!this.towerMesh) return
    const { dummy, towerMesh, towers } = this

    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i]

      // Hide all instances if tower is not visible
      if (tower.visible === false) {
        for (let f = 0; f < this.maxFloors; f++) {
          towerMesh.setVisibleAt(tower.floorInstances[f], false)
        }
        towerMesh.setVisibleAt(tower.roofInstance, false)
        continue
      }

      const center = tower.box.getCenter(this.towerCenter)
      const size = tower.box.getSize(this.towerSize)
      const numFloors = tower.numFloors

      // Half-heights for centered geometries
      const floorHalfHeight = this.floorHeight / 2 // Base geom is 1 unit, scaled to floorHeight
      const roofHalfHeight = BlockGeometry.halfHeights[tower.typeTop]

      // Position and show floor instances (geometry centered, so add halfHeight)
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = tower.floorInstances[f]
        if (f < numFloors) {
          dummy.position.set(center.x, f * this.floorHeight + floorHalfHeight, center.y)
          dummy.scale.set(size.x, this.floorHeight, size.y)
          dummy.rotation.y = tower.rotation
          dummy.updateMatrix()
          towerMesh.setMatrixAt(idx, dummy.matrix)
          towerMesh.setVisibleAt(idx, true)
        } else {
          towerMesh.setVisibleAt(idx, false)
        }
      }

      // Position roof on top (geometry centered, so add halfHeight)
      dummy.position.set(center.x, numFloors * this.floorHeight + roofHalfHeight, center.y)
      dummy.scale.set(size.x, 1, size.y)
      dummy.rotation.y = tower.rotation
      dummy.updateMatrix()
      towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
      towerMesh.setVisibleAt(tower.roofInstance, true)
    }
  }

  recalculateVisibility() {
    if (!this.towerMesh) return
    const gridCenterX = this.actualGridWidth / 2
    const gridCenterY = this.actualGridHeight / 2
    const maxDist = Math.sqrt(gridCenterX * gridCenterX + gridCenterY * gridCenterY)

    for (let i = 0; i < this.towers.length; i++) {
      const tower = this.towers[i]
      // Dormant (un-spawned lot) or empty (unbuilt slot) towers stay hidden.
      if (tower.dormant || tower.empty) {
        tower.visible = false
        continue
      }
      const center = tower.box.getCenter(this.towerCenter)

      // Increase skip chance based on distance from center
      const dx = center.x - gridCenterX
      const dy = center.y - gridCenterY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const distFactor = Math.pow(dist / maxDist, 2) // 0 at center, 1 at corners, squared
      const effectiveSkipChance = this.skipChance + distFactor * 1.2 // adds up to 1.2 at edges

      tower.visible = tower.skipFactor >= effectiveSkipChance
    }
    // Visibility is applied in updateMatrices based on tower.visible
    this.updateMatrices()
  }

  regenerate() {
    // Re-randomize all tower properties and recalculate the city
    for (const tower of this.towers) {
      tower.randFactor = MathUtils.randFloat(0, 1)
      tower.skipFactor = MathUtils.randFloat(0, 1)
      tower.colorIndex = MathUtils.randInt(0, 2)
      tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))
      // Reset to base colors first
      tower.isLit = false
      for (const idx of tower.floorInstances) {
        this.towerMesh.setColorAt(idx, tower.baseColor)
      }
      this.towerMesh.setColorAt(tower.roofInstance, tower.topColor)
    }
    // Regenerate noise with new seed
    this.recalculateNoise()
    this.recalculateVisibility()
    // Re-apply lit towers
    this.applyLitTowers()
  }

  recalculateNoise() {
    // Recreate noise with new frequency
    this.cityNoise = new FastSimplexNoise({
      frequency: this.noiseFrequency,
      octaves: 3,
      min: 0,
      max: 1,
      persistence: 0.6,
    })
    // Recalculate noise values for all towers
    let minNoise = Infinity
    let maxNoise = -Infinity
    for (let i = 0; i < this.towers.length; i++) {
      const tower = this.towers[i]
      const center = tower.box.getCenter(this.towerCenter)
      tower.cityNoiseVal = this.cityNoise.scaled2D(center.x, center.y)
      minNoise = Math.min(minNoise, tower.cityNoiseVal)
      maxNoise = Math.max(maxNoise, tower.cityNoiseVal)
    }
    console.log('Noise range:', minNoise, '-', maxNoise)
    this.recalculateHeights()
  }

  setupEnvRotation() {
    const mat = this.towerMaterial
    const angle = this.envRotation

    // Get the environment texture from scene
    const envTexture = this.scene.environment
    if (!envTexture) {
      console.warn('Environment texture not yet loaded')
      return
    }

    // Create rotated reflection vector for specular
    // Reflection is computed in view space, transform to world, then rotate
    const reflectView = positionViewDirection.negate().reflect(normalWorld)
    const reflectWorld = reflectView.transformDirection(cameraViewMatrix)
    const rotatedReflectWorld = rotateY(reflectWorld, angle)

    // Create PMREM texture node with rotated UV direction
    const envMapNode = pmremTexture(envTexture, rotatedReflectWorld, roughness)

    // Set as the material's environment node
    mat.envNode = envMapNode
  }

  /**
   * Pick the nearest tower by its axis-aligned bounding box (ignores the actual
   * block geometry, so the hole in plus blocks is still clickable). Returns a
   * lightweight intersection-like object ({ batchId }) or null.
   * @param {import('three').Ray} ray - world-space ray from the pointer
   */
  pickTowerBox(ray) {
    if (!this._pickBox) {
      this._pickBox = new Box3()
      this._pickHit = new Vector3()
    }
    let nearest = null
    let nearestDist = Infinity
    for (const tower of this.towers) {
      if (!tower.visible) continue
      // Top of the actual geometry: floors plus the roof tile's real thickness.
      // (A 0-floor tower is just the thin roof tile, so its hit zone is short.)
      const roofHalf = BlockGeometry.halfHeights[tower.typeTop]
      const top = tower.numFloors * this.floorHeight + 2 * roofHalf
      this._pickBox.min.set(
        tower.box.min.x + this.gridOffsetX, 0, tower.box.min.y + this.gridOffsetZ
      )
      this._pickBox.max.set(
        tower.box.max.x + this.gridOffsetX, top, tower.box.max.y + this.gridOffsetZ
      )
      const hit = ray.intersectBox(this._pickBox, this._pickHit)
      if (!hit) continue
      const d = ray.origin.distanceToSquared(hit)
      if (d < nearestDist) {
        nearestDist = d
        nearest = tower
      }
    }
    return nearest ? { batchId: nearest.roofInstance } : null
  }

  /**
   * Handle hover from raycast intersection
   * @param {Object|null} intersection - Three.js intersection object or null if no hit
   */
  onHover(intersection) {
    let tower = null

    if (intersection && intersection.batchId !== undefined) {
      tower = this.instanceToTower.get(intersection.batchId)
    }

    // No change
    if (tower === this.hoveredTower) return

    // Unhover previous tower
    if (this.hoveredTower) {
      this.hoveredTower.animateHoverColor(this.towerMesh, false)
    }

    // Hover new tower
    this.hoveredTower = tower
    if (tower) {
      tower.animateHoverColor(this.towerMesh, true)
    }
  }

  /**
   * Handle pointer down on a tower - store for click detection
   * @param {Object|null} intersection - Three.js intersection object or null
   * @param {number} clientX - pointer X position
   * @param {number} clientY - pointer Y position
   * @param {boolean} isTouch - true if this is a touch event
   */
  onPointerDown(intersection, clientX, clientY, isTouch) {
    // For touch, we handle everything on pointerup to avoid interfering with pan
    if (isTouch) return false

    let tower = null
    if (intersection && intersection.batchId !== undefined) {
      tower = this.instanceToTower.get(intersection.batchId)
    }

    // Record down position for drag detection (used for empty-slot taps too).
    this.pointerDownPos.set(clientX, clientY)

    if (!tower || !tower.visible) {
      this.pressedTower = null
      return false
    }

    this.pressedTower = tower

    return false // Don't stop propagation - let OrbitControls handle drag
  }

  /**
   * Handle pointer move - cancel click if dragged
   * @param {number} clientX - pointer X position
   * @param {number} clientY - pointer Y position
   */
  onPointerMove(clientX, clientY) {
    if (!this.pressedTower) return

    const dx = clientX - this.pointerDownPos.x
    const dy = clientY - this.pointerDownPos.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist > this.dragThreshold) {
      // Cancel the click
      this.pressedTower = null
    }
  }

  /**
   * Handle pointer up - add a floor to the tower
   * @param {boolean} isTouch - true if this is a touch event
   * @param {Object|null} touchIntersection - intersection from touch start (touch only)
   */
  onPointerUp(isTouch, touchIntersection) {
    // For touch, handle the full tap sequence here
    if (isTouch) {
      let tower = null
      if (touchIntersection && touchIntersection.batchId !== undefined) {
        tower = this.instanceToTower.get(touchIntersection.batchId)
      }
      if (tower && tower.visible) {
        if (this._tryBuild(tower)) {
          tower.handleClick(this, this.floorHeight, this.maxFloors, this.debris,
            this.towers, () => this.onTowerChanged(tower), () => this.updateTowerVisuals())
        }
      } else if (this.pointer) {
        // Tapped empty ground - click a dormant lot, else build an empty slot.
        const p = this.pointer.scenePointer
        if (!this.clickLot(p.x, p.z)) this.trySpawnEmptyAt(p.x, p.z)
      }
      return
    }

    const tower = this.pressedTower
    this.pressedTower = null

    if (tower) {
      if (this._tryBuild(tower)) {
        tower.handleClick(this, this.floorHeight, this.maxFloors, this.debris,
          this.towers, () => this.onTowerChanged(tower), () => this.updateTowerVisuals())
      }
      return
    }

    // No tower pressed: if this wasn't a drag, try the empty slot under the cursor.
    if (!this.pointer) return
    const up = this.pointer.clientPointer
    const dx = up.x - this.pointerDownPos.x
    const dy = up.y - this.pointerDownPos.y
    if (Math.sqrt(dx * dx + dy * dy) > this.dragThreshold) return
    const p = this.pointer.scenePointer
    if (!this.clickLot(p.x, p.z)) this.trySpawnEmptyAt(p.x, p.z)
  }

  /**
   * Decide whether a build click on `tower` should proceed.
   * Only spends mana when a new block will actually be added (tower not at max).
   * Returns true if the build should happen.
   */
  _tryBuild(tower) {
    if (tower.numFloors >= this.maxFloors) {
      // Already at max height: nothing to build, signal it.
      Sounds.play('incorrect')
      return false
    }
    if (!this.mana) return true
    // Power towers (plus) and turrets (peg/laser) cost 2 per floor; else 1.
    // Cost scales with footprint area (a 2x2 tower costs 4x a 1x1).
    const colored = tower.typeTop === 5 || tower.typeTop === 3 || tower.typeTop === 4
    const cost = (colored ? 2 : 1) * this.towerArea(tower)
    if (!this.freeClicks && !this.mana.spend(cost)) {
      // Out of mana: block the build and signal it.
      Sounds.play('incorrect')
      return false
    }
    return true
  }

  /**
   * Click on the ground: if it lands on an empty tower (a demolished tile shown
   * as a grey outline), regenerate a new random level-0 tile there. Pre-baked
   * empty slots are permanent gaps and are NOT clickable.
   */
  trySpawnEmptyAt(worldX, worldZ) {
    const p = new Vector2(worldX - this.gridOffsetX, worldZ - this.gridOffsetZ)
    for (const t of this.towers) {
      if (!t.emptyTower || !t.box.containsPoint(p)) continue
      this.regenEmptyTower(t)
      return true
    }
    return false
  }

  /**
   * Handle right-click - delete tower floors
   * @param {Object} intersection - Three.js intersection object
   */
  onRightClick(intersection) {
    let tower = null
    if (intersection && intersection.batchId !== undefined) {
      tower = this.instanceToTower.get(intersection.batchId)
    }

    if (!tower || !tower.visible) return

    // Reroll: knock the tower down (no energy refund), then a build-wheel timer
    // spins for `rerollDuration` seconds before a fresh random block appears.
    if (tower.numFloors >= 1) {
      tower.handleRightClick(this, this.floorHeight, this.debris,
        this.towers, () => this.beginReroll(tower))
    } else {
      // Level-0 tower: nothing to animate, start the timer straight away.
      this.beginReroll(tower)
    }
  }

  /**
   * Start a reroll: hide the tower and spin a radial build-wheel timer over its
   * slot. When the ring fills (see update()), a new random block spawns.
   */
  beginReroll(tower) {
    tower.visible = false
    tower.numFloors = 0
    this.updateTowerMatrices(tower)
    this.onTowerChanged(tower)

    const center = tower.box.getCenter(this.towerCenter)
    const mat = new MeshBasicNodeMaterial({
      color: this.accentColors[tower.colorIndex].clone(),
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    })
    const ring = new Mesh(this.rerollRingGeoFor(0), mat)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(center.x + this.gridOffsetX, 0.12, center.y + this.gridOffsetZ)
    ring.renderOrder = 6
    this.scene.add(ring)
    this.rerollTimers.push({ tower, ring, mat, t: 0, step: 0 })
  }

  /**
   * Cached pie-wedge annulus filled clockwise from the top for a discrete fill
   * step (0..rerollSteps). Cached and never disposed (see rerollRingGeos).
   */
  rerollRingGeoFor(step) {
    let g = this.rerollRingGeos.get(step)
    if (!g) {
      const inner = this.cellUnit * 0.26
      const outer = this.cellUnit * 0.42
      const len = Math.max(0.0001, (step / this.rerollSteps) * Math.PI * 2)
      const start = Math.PI / 2 - len // grow clockwise from 12 o'clock
      g = new RingGeometry(inner, outer, 48, 1, start, len)
      this.rerollRingGeos.set(step, g)
    }
    return g
  }

  /** Finish a reroll: reveal the slot with a fresh random block. */
  finishReroll(tower) {
    tower.emptyTower = false
    tower.visible = true
    tower.numFloors = 0
    this.rerollTower(tower)
    this.updateTowerMatrices(tower)
    Sounds.play('pop', 0.8, 0.15)
    this.onTowerChanged(tower)
  }

  /**
   * Re-randomize a tower's tile in place after it's destroyed. Keeps the same
   * footprint/size, but rolls a fresh top type (0-5, can become a plus block)
   * and new colors, swapping the instance geometries to match.
   */
  rerollTower(tower) {
    const mesh = this.towerMesh

    tower.typeTop = MathUtils.randInt(0, 5) // 5 = Cross_Top plus block
    // Footprint constraints: generators (5) only on squares, turrets (3/4) only
    // on 1x1 blocks and capped at 2 per lot. Demote violators to plain towers.
    const size = tower.box.getSize(this.towerSize)
    const w = Math.round(size.x / this.cellUnit)
    const h = Math.round(size.y / this.cellUnit)
    if (tower.typeTop === 5 && w !== h) {
      tower.typeTop = MathUtils.randInt(0, 2)
    }
    if (tower.typeTop === 3 || tower.typeTop === 4) {
      if (!(w === 1 && h === 1) || this.countLotTurrets(tower) >= 2) {
        tower.typeTop = MathUtils.randInt(0, 2)
      }
    }
    // Hole blocks (2) only on square footprints (like generators).
    if (tower.typeTop === 2 && w !== h) tower.typeTop = MathUtils.randInt(0, 1)
    tower.typeBottom = BlockGeometry.topToBottom.get(tower.typeTop)
    tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))
    // colorIndex stays the lot's color (set at init), so colored blocks match.

    // Point existing instances at the new geometries (footprint stays the same)
    for (const idx of tower.floorInstances) {
      mesh.setGeometryIdAt(idx, this.geomIds[tower.typeBottom])
    }
    mesh.setGeometryIdAt(tower.roofInstance, this.geomIds[tower.typeTop])

    // Plus blocks + hole blocks get an accent color; everything else uses base/top.
    tower.isLit = tower.typeTop === 5
    if (tower.isLit) {
      const accent = this.accentColors[tower.colorIndex]
      tower.litColor = accent.clone()
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, accent)
      mesh.setColorAt(tower.roofInstance, accent)
    } else if (tower.typeTop === 2) {
      // Hole block: whole tower the lot accent; litColor lets it pulse-glow
      // when it's generating (orthogonally adjacent to another hole).
      const accent = this.accentColors[tower.colorIndex]
      tower.litColor = accent.clone()
      tower.baseColor = accent.clone()
      tower.topColor = accent.clone()
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, accent)
      mesh.setColorAt(tower.roofInstance, accent)
    } else {
      tower.litColor = null
      if (tower.typeTop === 3 || tower.typeTop === 4) {
        // Became a turret: assign one accent color.
        this.colorTurretTower(tower)
      } else {
        // Plain tower: reset to default grey base/top colors.
        tower.laserColor = null
        tower.baseColor = Tower.BASE_COLOR
        tower.topColor = Tower.COLORS[tower.topColorIndex]
      }
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, tower.baseColor)
      mesh.setColorAt(tower.roofInstance, tower.topColor)
    }
  }

  /**
   * Called after a tower's floor count changes (build or destroy).
   * Updates its matrices and re-evaluates power-line connectors.
   */
  onTowerChanged(tower) {
    this.updateTowerMatrices(tower)
    this.trySpawnLots()
    this.updateTowerVisuals()
  }

  /**
   * Refresh connector lines, ZOC circles, and lot fills (no matrix update or
   * lot spawning). Called the instant a block is added so the radius/connections
   * grow with the new block instead of lagging behind its emerge animation.
   */
  updateTowerVisuals() {
    this.updateConnectors()
    this.updateMonasteries()
    this.updateZocCircles()
    this.updateTurretRanges()
    this.updateLotFills()
    this.refreshManaStats()
  }

  /**
   * Maintain a white ring on each visible turret (peg/laser) showing its firing
   * range (radius = (numFloors + 1) cells, matching Turrets.nearestCreep).
   */
  updateTurretRanges() {
    const thickness = 0.12
    const ringFor = (numFloors) => {
      let g = this.rangeRingGeos.get(numFloors)
      if (!g) {
        const r = (numFloors + 1) * this.cellUnit
        g = new RingGeometry(r - thickness / 2, r + thickness / 2, 64)
        this.rangeRingGeos.set(numFloors, g)
      }
      return g
    }
    const seen = new Set()
    for (const t of this.towers) {
      if (!t.visible || (t.typeTop !== 3 && t.typeTop !== 4)) continue
      seen.add(t)
      const geo = ringFor(t.numFloors)
      let m = this.rangeCircles.get(t)
      if (!m || m.geometry !== geo) {
        const mat = m ? m.material : new MeshBasicNodeMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
        })
        if (m) this.scene.remove(m)
        m = new Mesh(geo, mat)
        m.rotation.x = -Math.PI / 2
        m.renderOrder = -1
        this.scene.add(m)
        this.rangeCircles.set(t, m)
      }
      t.box.getCenter(this._zc)
      m.position.set(this._zc.x + this.gridOffsetX, 0.07, this._zc.y + this.gridOffsetZ)
      m.visible = this.showTurretRanges
    }
    for (const [t, m] of this.rangeCircles) if (!seen.has(t)) m.visible = false
  }

  /**
   * Maintain one low-opacity ground disc per visible plus block, colored to
   * match the tower and sized to its zone of control (radius = height in cells).
   */
  updateZocCircles() {
    // Ring outline with a fixed world-unit thickness regardless of radius.
    // Radii are discrete (numFloors * cellUnit), so cache one geometry per
    // floor count and reuse it - never dispose (avoids WebGPU buffer crashes).
    const thickness = 0.15
    const ringFor = (numFloors) => {
      let g = this.zocRingGeos.get(numFloors)
      if (!g) {
        const r = numFloors * this.cellUnit
        g = new RingGeometry(r - thickness / 2, r + thickness / 2, 64)
        this.zocRingGeos.set(numFloors, g)
      }
      return g
    }
    const seen = new Set()
    for (const t of this.towers) {
      if (!t.visible || t.typeTop !== 5 || t.numFloors < 1) continue
      seen.add(t)
      const geo = ringFor(t.numFloors)
      let m = this.zocCircles.get(t)
      // Build a mesh, or replace it when the radius changed. We never swap
      // .geometry on a live mesh (that leaves a stale GPU index buffer in the
      // WebGPU backend -> setIndexBuffer crash); we rebuild the mesh instead,
      // reusing the same material and a cached (never-disposed) geometry.
      if (!m || m.geometry !== geo) {
        const mat = m ? m.material : new MeshBasicNodeMaterial({
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
        })
        if (m) this.scene.remove(m)
        m = new Mesh(geo, mat)
        m.rotation.x = -Math.PI / 2
        m.renderOrder = -1
        this.scene.add(m)
        this.zocCircles.set(t, m)
      }
      t.box.getCenter(this._zc)
      m.position.set(this._zc.x + this.gridOffsetX, 0.06, this._zc.y + this.gridOffsetZ)
      m.material.color.copy(this.accentColors[t.colorIndex])
      m.visible = true
    }
    for (const [t, m] of this.zocCircles) if (!seen.has(t)) m.visible = false
  }

  /** World centres + range radii of every visible turret (for the coverage glow). */
  getTurretCircles(out = []) {
    out.length = 0
    for (const t of this.towers) {
      if (!t.visible || (t.typeTop !== 3 && t.typeTop !== 4)) continue
      t.box.getCenter(this._zc)
      out.push({
        x: this._zc.x + this.gridOffsetX,
        z: this._zc.y + this.gridOffsetZ,
        r: (t.numFloors + 1) * this.cellUnit,
      })
    }
    return out
  }

  /** Combined built-up strength of all active orthogonal neighbours of a lot. */
  activeNeighbourStrength(lot) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let sum = 0
    for (const [dx, dy] of dirs) {
      const nx = lot.lotX + dx
      const ny = lot.lotY + dy
      if (nx < 0 || ny < 0 || nx >= this.numLotsX || ny >= this.numLotsY) continue
      const n = this.lots[ny][nx]
      if (n.active) sum += this.lotStrength(n)
    }
    return sum
  }

  /** Total spawn progress: neighbour points + bonus points from direct clicks. */
  lotProgress(lot) {
    return this.activeNeighbourStrength(lot) + (lot.clickPoints || 0)
  }

  /** True if any orthogonal neighbour lot is active. */
  hasActiveNeighbour(lot) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    for (const [dx, dy] of dirs) {
      const nx = lot.lotX + dx
      const ny = lot.lotY + dy
      if (nx < 0 || ny < 0 || nx >= this.numLotsX || ny >= this.numLotsY) continue
      if (this.lots[ny][nx].active) return true
    }
    return false
  }

  /**
   * Grow a fill rect over each dormant lot as its active neighbours' combined
   * points approach the spawn threshold; reaching full size = about to spawn.
   */
  updateLotFills() {
    const minScale = this.cellUnit / this.lotSize
    for (const row of this.lots) {
      for (const lot of row) {
        if (!lot.fillRect) continue
        if (lot.active) { lot.fillRect.visible = false; continue }
        const p = Math.min(1, this.lotProgress(lot) / this.lotSpawnThreshold)
        lot.fillRect.visible = p > 0
        if (lot.outline) lot.outline.visible = p > 0
        const s = minScale + (1 - minScale) * p
        lot.fillRect.scale.set(s, 1, s)
        lot.fillRect.material.opacity = 0.8
      }
    }
  }

  /**
   * Click on a dormant lot's rect to add bonus spawn points (on top of its
   * neighbour points). Spawns once total progress crosses the threshold.
   * Returns true if the click landed on an eligible lot.
   */
  clickLot(worldX, worldZ) {
    const gx = worldX - this.gridOffsetX
    const gz = worldZ - this.gridOffsetZ
    const lotX = Math.floor(gx / this.cellSize)
    const lotY = Math.floor(gz / this.cellSize)
    if (lotX < 0 || lotY < 0 || lotX >= this.numLotsX || lotY >= this.numLotsY) return false
    // Ignore clicks that land in the road gap between lots.
    const inLotX = gx - lotX * this.cellSize
    const inLotZ = gz - lotY * this.cellSize
    if (inLotX > this.lotSize || inLotZ > this.lotSize) return false

    const lot = this.lots[lotY][lotX]
    if (lot.active || !this.hasActiveNeighbour(lot)) return false

    // Each click costs 1 mana; out of mana - block and signal (consume click).
    if (!this.freeClicks && this.mana && !this.mana.spend(1)) {
      Sounds.play('incorrect')
      return true
    }

    lot.clickPoints = (lot.clickPoints || 0) + this.lotClickValue
    Sounds.play('clink', 1.0, 0.1, 0.7)
    if (this.lotProgress(lot) >= this.lotSpawnThreshold) {
      this.activateLot(lot)
    } else {
      this.updateLotFills()
    }
    return true
  }

  /**
   * Knock a tower down. Removes one floor, or - if it's already a level-0 tower
   * (just the thin block) - destroys it into an empty tower. Returns new floors.
   */
  damageTower(tower) {
    if (!tower || !tower.visible || tower.emptyTower) return 0

    // Burst the top block into debris where it sat.
    const center = tower.box.getCenter(this.towerCenter)
    const y = Math.max(0.5, tower.numFloors - 0.5) * this.floorHeight
    const color = tower.litColor || tower.baseColor
    this.debris.spawn(
      center.x + this.gridOffsetX, y, center.y + this.gridOffsetZ, 0.8, color, 10
    )
    Sounds.play('break2', 1.0, 0.2)

    if (tower.numFloors >= 1) {
      tower.numFloors -= 1
      this.onTowerChanged(tower)
      return tower.numFloors
    }
    // Level-0 tower destroyed -> empty tower (grey outline).
    this.setEmptyTower(tower)
    this.onTowerChanged(tower)
    return 0
  }

  /** Convert a tower into an empty tower: all blocks gone, grey floor outline. */
  setEmptyTower(tower) {
    tower.emptyTower = true
    tower.numFloors = 0
    tower.visible = false
    this.updateTowerMatrices(tower) // hides every instance
    this.showEmptyTowerOutline(tower)
  }

  /** Click an empty tower to regenerate a new random level-0 tile in its spot. */
  regenEmptyTower(tower) {
    tower.emptyTower = false
    tower.visible = true
    tower.numFloors = 0
    this.rerollTower(tower) // new random top (turret/generator/etc), colors, geom
    this.clearEmptyTowerOutline(tower)
    this.updateTowerMatrices(tower)
    Sounds.play('pop', 0.8, 0.15)
    this.onTowerChanged(tower)
  }

  /** Show (building lazily) the grey floor outline for an empty tower. */
  showEmptyTowerOutline(tower) {
    let o = this.emptyTowerOutlines.get(tower)
    if (!o) {
      // LineSegments (not LineLoop) - LineLoop doesn't render in this WebGPU
      // build; the lot outlines use LineSegments and show fine.
      if (!this.emptyTowerMat) {
        this.emptyTowerMat = new LineBasicNodeMaterial({
          color: 0xffffff, depthTest: false,
        })
      }
      const x0 = tower.box.min.x + this.gridOffsetX
      const z0 = tower.box.min.y + this.gridOffsetZ
      const x1 = tower.box.max.x + this.gridOffsetX
      const z1 = tower.box.max.y + this.gridOffsetZ
      const y = 0.08
      const geom = new BufferGeometry()
      geom.setAttribute('position', new Float32BufferAttribute([
        x0, y, z0, x1, y, z0,
        x1, y, z0, x1, y, z1,
        x1, y, z1, x0, y, z1,
        x0, y, z1, x0, y, z0,
      ], 3))
      o = new LineSegments(geom, this.emptyTowerMat)
      o.renderOrder = 3
      this.scene.add(o)
      this.emptyTowerOutlines.set(tower, o)
    }
    o.visible = true
  }

  /** Hide an empty tower's floor outline. */
  clearEmptyTowerOutline(tower) {
    const o = this.emptyTowerOutlines.get(tower)
    if (o) o.visible = false
  }

  /** Count turret towers (peg/divot) in a tower's lot, excluding itself. */
  countLotTurrets(tower) {
    const lot = this.lots?.[tower.lotY]?.[tower.lotX]
    if (!lot) return 0
    let n = 0
    for (const t of lot.towers) {
      if (t === tower) continue
      if (t.typeTop === 3 || t.typeTop === 4) n++
    }
    return n
  }

  /** True if a tower is a grey block (regular - not a generator, turret, or monastery). */
  isGreyTower(t) {
    return t.typeTop !== 5 && t.typeTop !== 3 && t.typeTop !== 4 && t.typeTop !== 2
  }

  /**
   * Orthogonal (edge-sharing) adjacency only - excludes diagonal corner touches.
   * Two boxes share an edge when they touch on one axis and overlap on the other.
   */
  towersOrthAdjacent(a, b, tol) {
    const ba = a.box, bb = b.box
    const sepX = Math.max(bb.min.x - ba.max.x, ba.min.x - bb.max.x) // >0 apart, <0 overlap
    const sepZ = Math.max(bb.min.y - ba.max.y, ba.min.y - bb.max.y)
    const closeX = sepX <= tol, closeZ = sepZ <= tol
    const overlapX = sepX < -tol, overlapZ = sepZ < -tol
    return (overlapX && closeZ) || (overlapZ && closeX)
  }

  /**
   * Hole blocks (typeTop 2, spawned randomly like any block) generate energy
   * only in clusters: a connected group of orthogonally-adjacent holes is one
   * unit that generates a single summed energy (1 per built member) and whose
   * members pulse-glow together. A hole with no orthogonal hole neighbour pays
   * nothing.
   */
  updateMonasteries() {
    const tol = this.cellUnit * 0.5
    const clusters = [] // {members, energy, cx, cy, cz}
    const lit = new Set()     // built hole blocks that pulse-glow
    let mana = 0

    for (const row of this.lots) {
      for (const lot of row) {
        if (!lot.active) continue
        const holes = lot.towers.filter(t => t.visible && t.typeTop === 2)
        // Reset every hole to static accent; the per-frame pulse re-brightens
        // only the generating ones, so a hole that stops generating doesn't
        // freeze at its last pulsed brightness.
        for (const t of holes) this._setTowerColor(t, this.accentColors[t.colorIndex])
        if (holes.length < 2) continue

        const visited = new Set()
        for (const start of holes) {
          if (visited.has(start)) continue
          const stack = [start]
          visited.add(start)
          const cluster = []
          while (stack.length) {
            const cur = stack.pop()
            cluster.push(cur)
            for (const o of holes) {
              if (!visited.has(o) && this.towersOrthAdjacent(cur, o, tol)) {
                visited.add(o)
                stack.push(o)
              }
            }
          }

          // Cluster of >= 2 (orthogonally adjacent) generates; energy = 1 per
          // built member, summed. EVERY hole in the group (built + flat) pulses
          // together, and a single "+N" caption pops at the centre of the group.
          if (cluster.length < 2) continue
          let energy = 0, sx = 0, sz = 0, topY = 0
          for (const m of cluster) {
            if (m.numFloors >= 1) energy++ // only built members produce energy
            const c = m.box.getCenter(this.towerCenter)
            sx += c.x + this.gridOffsetX
            sz += c.y + this.gridOffsetZ
            const roofHalf = BlockGeometry.halfHeights[m.typeTop]
            topY = Math.max(topY, m.numFloors * this.floorHeight + 2 * roofHalf)
          }
          if (energy > 0) {
            mana += energy
            for (const m of cluster) lit.add(m) // whole group glows together
            clusters.push({
              members: cluster.slice(), energy,
              cx: sx / cluster.length, cy: topY + 0.5, cz: sz / cluster.length,
            })
          }
        }
      }
    }
    this.monasteryMana = mana
    this.monasteryClusters = clusters
    this.litMonasteries = lit
  }

  /** Total grey blocks = sum of heights over visible grey towers. */
  countGreyBlocks() {
    let n = 0
    for (const t of this.towers) {
      if (!t.visible || t.numFloors < 1 || !this.isGreyTower(t)) continue
      n += t.numFloors
    }
    return n
  }

  /** Push the current grey-block totals to the energy/population HUD. */
  refreshManaStats() {
    if (this.mana) this.mana.setStats(this.countGreyBlocks())
  }

  /** Float a "+N" caption at a world position. */
  spawnTextAt(x, y, z, text, color, sound, delay = 0) {
    if (!this.floatingText) return
    const css = color && color.getHexString ? `#${color.getHexString()}` : color
    this.floatingText.spawn(x, y, z, text, css, delay, sound)
  }

  /**
   * Float a "+N" caption rising from the top of a tower. `delay` staggers the
   * pop-in (default random spread); pass 0 to sync exactly with the tick/glow.
   */
  spawnTowerText(tower, text, color, sound = 'pluck', delay = Math.random()) {
    const c = tower.box.getCenter(this.towerCenter)
    const roofHalf = BlockGeometry.halfHeights[tower.typeTop]
    const topY = tower.numFloors * this.floorHeight + 2 * roofHalf
    this.spawnTextAt(c.x + this.gridOffsetX, topY + 0.5, c.y + this.gridOffsetZ, text, color, sound, delay)
  }

  /** Footprint area of a tower in cells (1x1 = 1, 2x2 = 4, etc). */
  towerArea(tower) {
    const size = tower.box.getSize(this.towerSize)
    return Math.max(1, Math.round((size.x / this.cellUnit) * (size.y / this.cellUnit)))
  }

  /**
   * Lot "points" for neighbour spawning = sum over GREY towers of
   * height * footprint area (generators and turrets don't count).
   */
  lotStrength(lot) {
    let pts = 0
    for (const t of lot.towers) {
      if (!t.visible || t.numFloors < 1 || !this.isGreyTower(t)) continue
      pts += t.numFloors * this.towerArea(t)
    }
    return pts
  }

  /** Empty (un-spawned) orthogonal neighbour lots of the given lot. */
  emptyNeighbourLots(lot) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const out = []
    for (const [dx, dy] of dirs) {
      const nx = lot.lotX + dx
      const ny = lot.lotY + dy
      if (nx < 0 || ny < 0 || nx >= this.numLotsX || ny >= this.numLotsY) continue
      const n = this.lots[ny][nx]
      if (!n.active) out.push(n)
    }
    return out
  }

  /** Reveal a dormant lot and animate its towers up from the ground. */
  activateLot(lot) {
    lot.active = true
    if (lot.outline) lot.outline.visible = true
    if (lot.fillRect) lot.fillRect.visible = false
    Sounds.play('good')
    this.animateLotBuild(lot)
  }

  /**
   * Spawn a lot's towers at level 0, staggering each block in (centre outward)
   * so the lot pops into existence one block at a time instead of all at once.
   */
  animateLotBuild(lot) {
    const cx = (lot.lotX + 0.5) * this.cellSize - this.roadWidth / 2
    const cy = (lot.lotY + 0.5) * this.cellSize - this.roadWidth / 2

    const blocks = []
    for (const t of lot.towers) {
      t.dormant = false
      t.numFloors = 0
      t.visible = false // hidden until its staggered reveal (empty stays hidden)
      if (t.empty) continue
      const center = t.box.getCenter(new Vector2())
      const dist = Math.hypot(center.x - cx, center.y - cy)
      blocks.push({ tower: t, dist })
    }
    this.updateMatrices()

    blocks.sort((a, b) => a.dist - b.dist)
    const maxDist = blocks[blocks.length - 1]?.dist || 1
    const staggerDuration = 0.7

    let maxDelay = 0
    for (const { tower, dist } of blocks) {
      const delay = (dist / maxDist) * staggerDuration
      maxDelay = Math.max(maxDelay, delay)
      setTimeout(() => {
        tower.visible = true
        this.updateTowerMatrices(tower)
        Sounds.play('pop', 0.9, 0.15, 0.4)
      }, delay * 1000)
    }

    // Once the lot has finished appearing, refresh connectors/ZOC/fills. We do
    // NOT re-run trySpawnLots here: a fresh lot is all level-0 (0 strength), and
    // re-triggering off the still-strong source lot would chain-spawn lots.
    setTimeout(() => {
      this.updateConnectors()
      this.updateMonasteries()
      this.updateZocCircles()
      this.updateLotFills()
    }, (maxDelay + 0.4) * 1000)
  }

  /**
   * Empty-lot pull: each dormant lot looks at its neighbours, and activates
   * itself once an adjacent active lot's combined points cross the threshold.
   * One spawn per change event so growth stays gradual.
   */
  trySpawnLots() {
    if (!this.lots.length) return
    // Collect every eligible dormant lot first, then activate them - so a full
    // rect never stalls waiting for the next change (a fresh lot is level 0, so
    // activating it doesn't retroactively push its neighbours over threshold).
    const toSpawn = []
    for (const row of this.lots) {
      for (const lot of row) {
        if (lot.active) continue // only empty lots pull
        if (this.hasStrongActiveNeighbour(lot)) toSpawn.push(lot)
      }
    }
    for (const lot of toSpawn) this.activateLot(lot)
  }

  /** True if the lot's total progress (neighbours + clicks) is over threshold. */
  hasStrongActiveNeighbour(lot) {
    return this.lotProgress(lot) >= this.lotSpawnThreshold
  }

  /**
   * Re-evaluate connectors between plus blocks. Two same-color plus blocks are
   * connected when their zones of control overlap. A plus block's ZOC is a circle
   * with radius equal to its height in cells, so the circles overlap when the
   * center distance (in cells) is less than the sum of the two heights.
   */
  updateConnectors() {
    if (!this.trails) return

    const plus = this.towers.filter(t => t.visible && t.typeTop === 5)
    const cell = this.cellUnit
    const ca = new Vector2()
    const cb = new Vector2()
    const pairs = []

    for (let i = 0; i < plus.length; i++) {
      for (let j = i + 1; j < plus.length; j++) {
        const a = plus[i]
        const b = plus[j]
        if (a.colorIndex !== b.colorIndex) continue
        const combinedReach = a.numFloors + b.numFloors // cells
        if (combinedReach <= 0) continue
        a.box.getCenter(ca)
        b.box.getCenter(cb)
        const distCells = ca.distanceTo(cb) / cell
        if (distCells < combinedReach) pairs.push([a, b])
      }
    }

    this.activeConnectorCount = pairs.length

    // Mana per generation tick = sum over connectors of both plus towers'
    // points (height * footprint area, so a 2x2 tower yields 4x a 1x1). Also
    // attribute each tower's share so we can float "+N" above it on each tick.
    let mana = 0
    const contrib = new Map()
    for (const [a, b] of pairs) {
      const pa = a.numFloors * this.towerArea(a)
      const pb = b.numFloors * this.towerArea(b)
      mana += pa + pb
      contrib.set(a, (contrib.get(a) || 0) + pa)
      contrib.set(b, (contrib.get(b) || 0) + pb)
    }
    this.connectorMana = mana
    this.connectorContribution = contrib

    // Build a stable signature of the connector set. Rebuilding the trail meshes
    // every tower change leaks (disposed WebGPU node materials aren't fully
    // freed), so only rebuild when the actual set of connections changes.
    const pairKeys = new Set()
    const keyList = []
    for (const [a, b] of pairs) {
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`
      pairKeys.add(key)
      keyList.push(key)
    }
    keyList.sort()
    const sig = keyList.join(',')
    if (sig === this._connectorSig) return // unchanged - skip the rebuild
    this._connectorSig = sig

    this.trails.setConnectors(pairs)

    // Play a zap when a brand-new connection forms (pair absent last time).
    let newConnection = false
    for (const key of pairKeys) {
      if (!this._connectorKeys || !this._connectorKeys.has(key)) newConnection = true
    }
    if (newConnection) Sounds.play('energy')
    this._connectorKeys = pairKeys

    // Track which towers are connected so update() can pulse them. Restore the
    // steady accent color on any tower that just lost all its connections.
    const connected = new Set()
    for (const [a, b] of pairs) {
      connected.add(a)
      connected.add(b)
    }
    for (const t of this.connectedTowers) {
      if (!connected.has(t) && t.isLit && t.litColor) {
        this._setTowerColor(t, t.litColor)
      }
    }
    this.connectedTowers = connected
  }

  /** Set every instance color of a tower to a single color. */
  _setTowerColor(tower, color) {
    const mesh = this.towerMesh
    for (const idx of tower.floorInstances) mesh.setColorAt(idx, color)
    mesh.setColorAt(tower.roofInstance, color)
  }

  /**
   * Update per-frame systems (debris physics, connector mana generation)
   */
  update(dt) {
    this.debris.update(dt)

    // Advance reroll build-wheels; fill the ring clockwise, spawn on completion.
    for (let i = this.rerollTimers.length - 1; i >= 0; i--) {
      const rt = this.rerollTimers[i]
      rt.t += dt
      const p = Math.min(1, rt.t / this.rerollDuration)
      // Swap to the next cached fill geometry by REBUILDING the mesh (never swap
      // .geometry on a live mesh or dispose it -> WebGPU setIndexBuffer crash).
      const step = Math.min(this.rerollSteps, Math.floor(p * this.rerollSteps))
      if (step !== rt.step) {
        rt.step = step
        const old = rt.ring
        const ring = new Mesh(this.rerollRingGeoFor(step), rt.mat)
        ring.rotation.copy(old.rotation)
        ring.position.copy(old.position)
        ring.renderOrder = old.renderOrder
        this.scene.add(ring)
        this.scene.remove(old)
        rt.ring = ring
      }
      if (p >= 1) {
        this.scene.remove(rt.ring)
        this.rerollTimers.splice(i, 1)
        this.finishReroll(rt.tower)
      }
    }

    // Each active connector/monastery generates mana every 2 seconds. Rather
    // than flashing everything at once, schedule each tower's flash at its own
    // random offset within the cycle; when it fires, its glow + caption + sound
    // all happen together (see the firing loop below).
    const genMana = this.connectorMana + this.monasteryMana
    if (genMana > 0 && this.mana) {
      this.manaTimer += dt
      while (this.manaTimer >= 2) {
        this.manaTimer -= 2
        this.mana.add(genMana)
        // Generators: each flashes itself, caption above its own top.
        for (const [tower, amt] of this.connectorContribution) {
          if (amt > 0 && tower.visible) {
            const c = tower.box.getCenter(this.towerCenter)
            const roofHalf = BlockGeometry.halfHeights[tower.typeTop]
            const topY = tower.numFloors * this.floorHeight + 2 * roofHalf
            this.pulseEvents.push({
              members: [tower], t: Math.random(), amt, sound: 'pluck',
              color: this.accentColors[tower.colorIndex],
              cx: c.x + this.gridOffsetX, cy: topY + 0.5, cz: c.y + this.gridOffsetZ,
            })
          }
        }
        // Hole clusters: the whole group flashes together, caption at its centre.
        for (const cl of this.monasteryClusters) {
          this.pulseEvents.push({
            members: cl.members, t: Math.random(), amt: cl.energy, sound: 'dink',
            color: this.accentColors[cl.members[0].colorIndex],
            cx: cl.cx, cy: cl.cy, cz: cl.cz,
          })
        }
      }
    }

    // Fire scheduled flashes: glow (per-tower envelope), caption, and sound all
    // trigger together at the moment the event's offset elapses.
    for (let i = this.pulseEvents.length - 1; i >= 0; i--) {
      const e = this.pulseEvents[i]
      e.t -= dt
      if (e.t <= 0) {
        for (const m of e.members) if (m.visible) m.pulseEnv = 1
        this.spawnTextAt(e.cx, e.cy, e.cz, `+${e.amt}`, e.color, e.sound)
        this.pulseEvents.splice(i, 1)
      }
    }

    // Grey (regular, unlit) blocks passively generate 1 mana each per 10s.
    if (this.mana) {
      this.greyManaTimer += dt
      while (this.greyManaTimer >= 10) {
        this.greyManaTimer -= 10
        const n = this.countGreyBlocks()
        if (n > 0) this.mana.add(n)
        // Float "+height" above each grey block, each offset by a random amount
        // up to the full 10s interval so they spread out across the whole cycle
        // instead of all popping right after the tick.
        for (const t of this.towers) {
          if (!t.visible || t.numFloors < 1 || !this.isGreyTower(t)) continue
          this.spawnTowerText(t, `+${t.numFloors}`, '#dfe6ff', 'pluck', Math.random() * 10)
        }
      }
    }

    // Brightness of connected towers + lit monasteries, driven by each tower's
    // OWN flash envelope (set to 1 when its scheduled event fires, decaying back
    // to the 0.7 baseline) so flashes stagger with their captions/sounds.
    if (this.connectedTowers.size > 0 || this.litMonasteries.size > 0) {
      for (const tower of this.connectedTowers) this._pulseTower(tower, dt)
      for (const tower of this.litMonasteries) this._pulseTower(tower, dt)
    }
  }

  /** Decay a tower's flash envelope and apply its pulsed brightness. */
  _pulseTower(tower, dt) {
    if (!tower.litColor) return
    tower.pulseEnv = Math.max(0, (tower.pulseEnv || 0) - dt / 0.8) // decay ~0.8s
    const brightness = 0.7 + tower.pulseEnv * 0.7 // 0.7..1.4
    this._pulseColor.copy(tower.litColor).multiplyScalar(brightness)
    this._setTowerColor(tower, this._pulseColor)
  }

  /**
   * Update matrices for a single tower
   */
  updateTowerMatrices(tower) {
    const { dummy, towerMesh } = this

    // Hidden tower: hide all of its instances (floors + roof) and bail.
    if (tower.visible === false) {
      for (let f = 0; f < this.maxFloors; f++) {
        towerMesh.setVisibleAt(tower.floorInstances[f], false)
      }
      towerMesh.setVisibleAt(tower.roofInstance, false)
      return
    }

    const center = tower.box.getCenter(this.towerCenter)
    const size = tower.box.getSize(this.towerSize)
    const numFloors = tower.numFloors

    // Half-heights for centered geometries
    const floorHalfHeight = this.floorHeight / 2
    const roofHalfHeight = BlockGeometry.halfHeights[tower.typeTop]

    for (let f = 0; f < this.maxFloors; f++) {
      const idx = tower.floorInstances[f]
      if (f < numFloors) {
        dummy.position.set(center.x, f * this.floorHeight + floorHalfHeight, center.y)
        dummy.scale.set(size.x, this.floorHeight, size.y)
        dummy.rotation.y = tower.rotation
        dummy.updateMatrix()
        towerMesh.setMatrixAt(idx, dummy.matrix)
        towerMesh.setVisibleAt(idx, true)
      } else {
        towerMesh.setVisibleAt(idx, false)
      }
    }

    // A visible tower always shows its roof (even at level 0, roof-only).
    towerMesh.setVisibleAt(tower.roofInstance, true)

    // Skip roof matrix if animation is in progress (roof controlled by GSAP)
    if (tower.roofAnimating) return

    // Roof on top
    dummy.position.set(center.x, numFloors * this.floorHeight + roofHalfHeight, center.y)
    dummy.scale.set(size.x, 1, size.y)
    dummy.rotation.y = tower.rotation
    dummy.updateMatrix()
    towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
  }

  /**
   * Create debug grid helpers aligned with the city
   */
  createGrids() {
    // Fine cell grid - centered at origin (same as lot grid). One line per buildable cell.
    const cellGrid = new GridHelper(this.actualGridWidth, this.actualGridWidth / this.cellUnit, 0x888888, 0x888888)
    cellGrid.material.transparent = true
    cellGrid.material.opacity = 0.5
    cellGrid.position.set(0, 0.01, 0)
    this.scene.add(cellGrid)
    this.cellGrid = cellGrid

    // Grid intersection dots using procedural plane shader
    const dotPlaneGeometry = new PlaneGeometry(this.actualGridWidth, this.actualGridHeight)
    dotPlaneGeometry.rotateX(-Math.PI / 2)
    const dotMaterial = new MeshBasicNodeMaterial()
    dotMaterial.transparent = true
    dotMaterial.alphaTest = 0.5
    dotMaterial.side = 2 // DoubleSide

    // Procedural dots at grid intersections (one per buildable cell, matching cell grid)
    const cellCoord = uv().mul(this.actualGridWidth / this.cellUnit)
    const fractCoord = fract(cellCoord)
    const toGridX = min(fractCoord.x, float(1).sub(fractCoord.x))
    const toGridY = min(fractCoord.y, float(1).sub(fractCoord.y))
    const dist = toGridX.mul(toGridX).add(toGridY.mul(toGridY)).sqrt()
    const dotRadius = float(0.04)
    const dotMask = float(1).sub(step(dotRadius, dist))

    const dotColor = vec3(0.267, 0.267, 0.267)
    dotMaterial.colorNode = dotColor
    dotMaterial.opacityNode = dotMask
    dotMaterial.mrtNode = mrt({
      output: dotColor,
      normal: vec3(0, 1, 0)
    })

    this.dotMesh = new Mesh(dotPlaneGeometry, dotMaterial)
    this.dotMesh.position.set(0, 0.015, 0)
    this.scene.add(this.dotMesh)

    // Coarse lot grid - centered at origin, lines at lot spacing intervals
    const lotGrid = new GridHelper(this.actualGridWidth, this.numLotsX, 0x888888, 0x888888)
    lotGrid.position.set(0, 0.02, 0)
    this.scene.add(lotGrid)
    this.lotGrid = lotGrid

    this.createLotOutlines()
  }

  /**
   * Yellow dashed square outline around each lot's buildable area.
   */
  createLotOutlines() {
    const y = 0.04
    const dash = 0.6
    const gap = 0.4
    const period = dash + gap

    // Emit dash segments from (ax,az) to (bx,bz) along one straight edge
    const dashEdge = (positions, ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az)
      const dx = (bx - ax) / len
      const dz = (bz - az) / len
      for (let d = 0; d < len; d += period) {
        const start = d
        const end = Math.min(d + dash, len)
        positions.push(ax + dx * start, y, az + dz * start)
        positions.push(ax + dx * end, y, az + dz * end)
      }
    }

    // One line material per accent color; each lot uses its own color.
    this.lotOutlineMats = this.accentColors.map(c => new LineBasicNodeMaterial({ color: c.clone() }))

    // Dashed square (centered at origin, XZ plane) for the neighbour-progress
    // indicator. Same dash style as the lot outline; scaled per-lot by progress.
    const half = this.lotSize / 2
    const fillPositions = []
    dashEdge(fillPositions, -half, -half, half, -half)
    dashEdge(fillPositions, half, -half, half, half)
    dashEdge(fillPositions, half, half, -half, half)
    dashEdge(fillPositions, -half, half, -half, -half)
    this.lotFillGeo = new BufferGeometry()
    this.lotFillGeo.setAttribute('position', new Float32BufferAttribute(fillPositions, 3))
    for (let lotY = 0; lotY < this.numLotsY; lotY++) {
      for (let lotX = 0; lotX < this.numLotsX; lotX++) {
        const gx0 = lotX * this.cellSize
        const gz0 = lotY * this.cellSize
        const a = this.gridToWorld(gx0, gz0)
        const b = this.gridToWorld(gx0 + this.lotSize, gz0 + this.lotSize)
        const positions = []
        dashEdge(positions, a.x, a.z, b.x, a.z)
        dashEdge(positions, b.x, a.z, b.x, b.z)
        dashEdge(positions, b.x, b.z, a.x, b.z)
        dashEdge(positions, a.x, b.z, a.x, a.z)

        const lot = this.lots[lotY][lotX]
        const geom = new BufferGeometry()
        geom.setAttribute('position', new Float32BufferAttribute(positions, 3))
        const outline = new LineSegments(geom, this.lotOutlineMats[lot.colorIndex])
        outline.visible = lot.active
        lot.outline = outline
        this.scene.add(outline)

        // Dashed line square (lot color) that grows as neighbours build up.
        const center = this.gridToWorld(gx0 + this.lotSize / 2, gz0 + this.lotSize / 2)
        const fillMat = new LineBasicNodeMaterial({
          color: this.accentColors[lot.colorIndex].clone(),
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
        const fillRect = new LineSegments(this.lotFillGeo, fillMat)
        fillRect.position.set(center.x, 0.03, center.z)
        fillRect.renderOrder = -2
        fillRect.visible = false
        lot.fillRect = fillRect
        this.scene.add(fillRect)
      }
    }

    // Seed the initial state for the starting (center) lot.
    this.updateZocCircles()
    this.updateTurretRanges()
    this.updateLotFills()
  }
}
