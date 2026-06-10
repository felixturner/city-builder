import {
  MathUtils,
  Vector2,
  Object3D,
  BatchedMesh,
  MeshPhysicalNodeMaterial,
  Color,
  GridHelper,
  PlaneGeometry,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu'
import gsap from 'gsap'
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture, mrt, uv, fract, step, min, float } from 'three/tsl'
import { Tower } from './Tower.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { Debris } from './lib/Debris.js'
import { Sounds } from './lib/Sounds.js'
import FastSimplexNoise from '@webvoxel/fast-simplex-noise'
import { EnergySystem } from './systems/EnergySystem.js'
import { RangeVisuals } from './systems/RangeVisuals.js'
import { LotGrowth } from './systems/LotGrowth.js'
import { TowerInteraction } from './systems/TowerInteraction.js'
import { CityGenerator } from './systems/CityGenerator.js'
import { TowerRenderer } from './systems/TowerRenderer.js'
import { TopType, isGrey, isTurret, towerArea } from './blockTypes.js'

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

    // Floor stacking config
    this.maxFloors = 10
    this.floorHeight = 2

    // Debris system
    this.debris = new Debris(scene, params.material)

    // Resource meter (set by Demo). Each build click spends 1 mana.
    this.mana = null

    // Power-line connectors / generators (Trails instance set by Demo).
    this.trails = null

    // Floating "+N" energy captions (FloatingText instance set by Demo).
    this.floatingText = null

    // Energy generation + glow/caption feedback (path/adj generators, grey mana).
    this.energy = new EnergySystem(this)

    // The city grid: 2D array of lots (populated by initGrid).
    this.lots = []
    // When true, clicks (build/destroy/spawn) don't cost mana (GUI toggle).
    this.freeClicks = false

    // Outward growth: dormant lots spawn from neighbour strength + clicks, plus
    // the lot outlines / progress fills.
    this.lotGrowth = new LotGrowth(this)

    // Player input (hover/build/destroy/reroll) + the reroll build-wheel.
    this.interaction = new TowerInteraction(this)

    // Procedural lot generation: footprints, types, and heights.
    this.generator = new CityGenerator(this)

    // Runtime tower visuals: accent coloring, visibility, reroll, empty-tower
    // lifecycle (on the shared BatchedMesh built in initTowers).
    this.renderer = new TowerRenderer(this)

    // Ground rings for zones of control + turret range, and the turret-circle
    // data for the post-process coverage glow.
    this.rangeVisuals = new RangeVisuals(this)
  }

  async init() {
    await BlockGeometry.init()
    this.initGrid()
    await this.initTowers()
    this.updateMatrices()
    this.renderer.recalculateVisibility()
    this.energy.refreshManaStats()
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

    // Buildable cells per lot side (5x5 grid of 1-cell slots).
    this.lotCells = this.lotSize / this.cellUnit

    // Only the CENTER lot is pre-generated (the old varied, pre-built model).
    // Every other lot starts as an empty grid the player fills from the tile
    // palette via free placement (see placeTileFree). occupied[][] tracks which
    // cells are taken; the center lot is marked fully occupied (no free-place).
    this.lots = []
    for (let lotY = 0; lotY < this.numLotsY; lotY++) {
      const row = []
      for (let lotX = 0; lotX < this.numLotsX; lotX++) {
        const isCenter = lotX === this.centerLotX && lotY === this.centerLotZ
        const lotColorIndex = MathUtils.randInt(0, this.accentColors.length - 1)
        const occupied = Array.from({ length: this.lotCells }, () => Array(this.lotCells).fill(isCenter))

        let towers = []
        if (isCenter) {
          const startX = lotX * this.cellSize
          const startY = lotY * this.cellSize
          const firstTower = this.towers.length
          this.generator.fillLot(startX, startY, startX + this.lotSize, startY + this.lotSize, 0.8)
          this.generator.assignLotPlus(firstTower)
          towers = this.towers.slice(firstTower)
          for (const t of towers) {
            t.lotX = lotX
            t.lotY = lotY
            t.colorIndex = lotColorIndex
            t.dormant = false
            t.visible = !t.empty
          }
        }
        row.push({ lotX, lotY, colorIndex: lotColorIndex, towers, active: isCenter, occupied })
      }
      this.lots.push(row)
    }

    this.generator.finalizeGrid()
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

  /**
   * Map a world-space ground point to its lot + cell (0..lotCells-1). Returns
   * null for road gaps or out-of-bounds.
   */
  worldToLotCell(worldX, worldZ) {
    const gx = worldX - this.gridOffsetX
    const gz = worldZ - this.gridOffsetZ
    const lotX = Math.floor(gx / this.cellSize)
    const lotY = Math.floor(gz / this.cellSize)
    if (lotX < 0 || lotY < 0 || lotX >= this.numLotsX || lotY >= this.numLotsY) return null
    const inX = gx - lotX * this.cellSize
    const inZ = gz - lotY * this.cellSize
    if (inX > this.lotSize || inZ > this.lotSize) return null // road gap
    return {
      lot: this.lots[lotY][lotX],
      cx: Math.min(this.lotCells - 1, Math.floor(inX / this.cellUnit)),
      cy: Math.min(this.lotCells - 1, Math.floor(inZ / this.cellUnit)),
    }
  }

  /** Whether a w×h footprint anchored at (cx,cy) fits free within a lot. */
  fits(lot, cx, cy, w, h) {
    if (cx < 0 || cy < 0 || cx + w > this.lotCells || cy + h > this.lotCells) return false
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (lot.occupied[cy + j][cx + i]) return false
      }
    }
    return true
  }

  /**
   * Place a palette tile freely into a lot's empty cells. Grabs a pooled tower,
   * sizes its footprint to the cells, builds it at level 0. Returns the tower or
   * null if the pool is exhausted.
   */
  placeTileFree(lot, cx, cy, w, h, typeTop, colorIndex, topColorIndex) {
    const t = this.towerPool.pop()
    if (!t) return null

    const x0 = lot.lotX * this.cellSize + cx * this.cellUnit
    const z0 = lot.lotY * this.cellSize + cy * this.cellUnit
    t.box.min.set(x0, z0)
    t.box.max.set(x0 + w * this.cellUnit, z0 + h * this.cellUnit)
    t.lotX = lot.lotX
    t.lotY = lot.lotY
    t.cellX = cx
    t.cellY = cy
    t.cellW = w
    t.cellH = h
    t.dormant = false
    t.empty = false
    t.emptyTower = false
    t.placed = true
    t.visible = true
    t.numFloors = 0
    t.rotation = 0
    t.skipFactor = 2 // always passes visibility
    t.colorIndex = colorIndex
    t.typeTop = typeTop
    t.setTopColorIndex(topColorIndex)

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) lot.occupied[cy + j][cx + i] = true
    }
    lot.towers.push(t)

    this.renderer.applyTypeVisuals(t)
    this.updateTowerMatrices(t)
    Sounds.play('pop', 0.8, 0.15)
    this.onTowerChanged(t)
    return t
  }

  /** Demolish a freely-placed tower (right-click): debris + free its cells. */
  demolishPlaced(tower) {
    const center = tower.box.getCenter(this.towerCenter)
    const y = Math.max(0.5, tower.numFloors - 0.5) * this.floorHeight
    this.debris.spawn(center.x + this.gridOffsetX, y, center.y + this.gridOffsetZ, 0.8,
      tower.litColor || tower.baseColor, 12)
    Sounds.play('break2', 1.0, 0.2)
    this.freePlacedTower(tower)
  }

  /** Free a placed tower's cells and return it to the pool (no debris/sound). */
  freePlacedTower(tower) {
    const lot = this.lots[tower.lotY][tower.lotX]
    for (let j = 0; j < tower.cellH; j++) {
      for (let i = 0; i < tower.cellW; i++) lot.occupied[tower.cellY + j][tower.cellX + i] = false
    }
    const k = lot.towers.indexOf(tower)
    if (k >= 0) lot.towers.splice(k, 1)

    tower.placed = false
    tower.dormant = true
    tower.visible = false
    tower.numFloors = 0
    this.updateTowerMatrices(tower)
    this.towerPool.push(tower)
    this.onTowerChanged(tower)
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

    // Geometry buffer = the unique block geometries (added once, shared by all
    // instances). Instances (center towers + the free-placement pool) reference
    // them by id and add no vertices.
    let totalV = 0
    let totalI = 0
    for (let i = 0; i < geoms.length; i++) { totalV += vCounts[i]; totalI += iCounts[i] }

    // Center-lot towers + a pool of generic towers grabbed on free placement.
    this.poolSize = 900
    const totalTowers = this.towers.length + this.poolSize
    const maxInstances = totalTowers * (this.maxFloors + 1) + 10
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

    // Free-placement pool: generic hidden towers, each pre-allocated maxFloors+1
    // instances. A tile drop grabs one (placeTileFree); demolish returns it.
    this.towerPool = []
    const defBottom = BlockGeometry.topToBottom.get(0)
    for (let p = 0; p < this.poolSize; p++) {
      const t = new Tower()
      t.dormant = true
      t.visible = false
      t.placed = false
      t.typeTop = 0
      t.typeBottom = defBottom
      t.floorInstances = []
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = this.towerMesh.addInstance(geomIds[defBottom])
        this.towerMesh.setColorAt(idx, t.baseColor)
        this.towerMesh.setVisibleAt(idx, false)
        t.floorInstances.push(idx)
        this.instanceToTower.set(idx, t)
      }
      t.roofInstance = this.towerMesh.addInstance(geomIds[0])
      this.towerMesh.setColorAt(t.roofInstance, t.topColor)
      this.towerMesh.setVisibleAt(t.roofInstance, false)
      this.instanceToTower.set(t.roofInstance, t)
      this.towers.push(t)
      this.towerPool.push(t)
    }

    console.log('Tower count:', this.towers.length, 'Max instances:', maxInstances)

    // Light up all plus/cross towers with hover colors
    this.renderer.applyLitTowers()
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

  regenerate() {
    // Re-randomize all tower properties and recalculate the city. Skip the free-
    // placement pool (dormant) and player-placed tiles - only the pre-built
    // center lot regenerates.
    for (const tower of this.towers) {
      if (tower.dormant || tower.placed) continue
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
    this.generator.recalculateNoise()
    this.renderer.recalculateVisibility()
    // Re-apply lit towers
    this.renderer.applyLitTowers()
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
   * Called after a tower's floor count changes (build or destroy).
   * Updates its matrices and re-evaluates power-line connectors.
   */
  onTowerChanged(tower) {
    this.updateTowerMatrices(tower)
    this.lotGrowth.trySpawnLots()
    this.updateTowerVisuals()
  }

  /**
   * Refresh connector lines, ZOC circles, and lot fills (no matrix update or
   * lot spawning). Called the instant a block is added so the radius/connections
   * grow with the new block instead of lagging behind its emerge animation.
   */
  updateTowerVisuals() {
    this.energy.refresh()
    this.rangeVisuals.refresh()
    this.lotGrowth.updateLotFills()
  }

  /** Turret range circles for the post-process coverage glow (called by Demo). */
  getTurretCircles(out = []) {
    return this.rangeVisuals.getTurretCircles(out)
  }

  /** Set every instance color of a tower to a single color. */
  setTowerColor(tower, color) {
    const mesh = this.towerMesh
    for (const idx of tower.floorInstances) mesh.setColorAt(idx, color)
    mesh.setColorAt(tower.roofInstance, color)
  }

  /** Per-frame: debris, reroll build-wheels, and the energy system. */
  update(dt) {
    this.debris.update(dt)
    this.interaction.update(dt)
    this.energy.update(dt)
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

    this.lotGrowth.createLotOutlines()
  }

}
