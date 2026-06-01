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
    this.manaTimer = 0 // Accumulates toward mana generation from connectors
    this.greyManaTimer = 0 // Accumulates toward passive mana from grey blocks

    // Towers currently part of an active connector pulse to show they're live
    this.connectedTowers = new Set()
    this.pulseEnv = 0 // flash envelope, kicked to 1 on each mana-generation tick
    this._pulseColor = new Color()

    // Lot growth: a developed lot spreads into an empty neighbour once its
    // total built height (sum of floors) crosses this threshold.
    this.lots = []
    this.lotSpawnThreshold = 10

    // ZOC circle visuals (one translucent ring outline per visible plus block).
    this.zocCircles = new Map() // tower -> Mesh
    this.zocRingGeos = new Map() // numFloors -> RingGeometry (fixed thickness)
    this._zc = new Vector2()
  }

  async init() {
    await BlockGeometry.init()
    this.initGrid()
    await this.initTowers()
    this.updateMatrices()
    this.recalculateVisibility()
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
        const density = isCenter ? 1 : 0.4

        this.fillLot(startX, startY, startX + this.lotSize, startY + this.lotSize, density)
        this.assignLotPlus(firstTower)

        const towers = this.towers.slice(firstTower)
        for (const t of towers) {
          t.lotX = lotX
          t.lotY = lotY
          t.dormant = !isCenter
          // Visible only if its lot is active AND the slot isn't an empty one.
          t.visible = isCenter && !t.empty
        }
        row.push({ lotX, lotY, towers, active: isCenter })
      }
      this.lots.push(row)
    }

    this.finalizeGrid()
  }

  /**
   * Turn exactly one tower (from index `firstTower` to the end of this.towers)
   * into a plus block. Prefers a square-footprint tower so the cross top isn't stretched.
   */
  assignLotPlus(firstTower) {
    // Only present (non-empty) towers can be the lot's plus block.
    const lotTowers = this.towers.slice(firstTower).filter(t => !t.empty)
    if (lotTowers.length === 0) return

    const size = new Vector2()
    const squares = lotTowers.filter(t => {
      t.box.getSize(size)
      return size.x === size.y
    })
    const pool = squares.length > 0 ? squares : lotTowers
    const plus = pool[MathUtils.randInt(0, pool.length - 1)]
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
        // Plus blocks (type 5) are assigned exactly once per lot in initGrid
        tower.typeTop = isSquare ? MathUtils.randInt(0, 4) : 0
        tower.typeBottom = BlockGeometry.topToBottom.get(tower.typeTop)
        tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))

        const sx = MathUtils.randInt(1, maxW)
        const sy = isSquare ? sx : MathUtils.randInt(1, Math.min(maxBlockSize.y, height - py))

        // Skip towers that extend outside the lot bounds (creates empty areas)
        if (px + sx > width || py + sy > height) {
          px++
          continue
        }

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
    // Game start: every tower begins flat (0 floors = just the thin top block)
    for (const tower of this.towers) {
      tower.numFloors = 0
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
      } else {
        tower.litColor = null
      }
    }
  }

  recalculateHeights() {
    const gridCenterX = this.actualGridWidth / 2
    const gridCenterY = this.actualGridHeight / 2

    for (let i = 0; i < this.towers.length; i++) {
      const tower = this.towers[i]
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
      // Floor to discrete floor count
      tower.numFloors = Math.floor(height / this.floorHeight)
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

    // 1. Store target floor counts, set all to 0
    const towerData = this.towers.map(tower => {
      const targetFloors = tower.numFloors
      const center = tower.box.getCenter(new Vector2())
      const dist = Math.hypot(center.x - gridCenterX, center.y - gridCenterY)
      tower.numFloors = 0
      return { tower, targetFloors, dist }
    })
    this.updateMatrices()

    // 2. Sort by distance (center first)
    towerData.sort((a, b) => a.dist - b.dist)
    const maxDist = towerData[towerData.length - 1]?.dist || 1

    // 3. Animate each tower's floors with stagger
    const staggerDuration = duration * 0.85 // 85% of duration for stagger spread
    const floorDelay = 0.12 // 120ms between floors of same tower

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

    // Unmute sounds and restore debris after intro completes
    setTimeout(() => {
      Sounds.unmute(['stone', 'tick', 'clink'])
      this.debris.enabled = debrisWasEnabled
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
      const top = tower.numFloors * this.floorHeight + this.floorHeight
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
            this.towers, () => this.onTowerChanged(tower))
        }
      } else if (this.pointer) {
        // Tapped empty ground - try to build an empty slot there.
        const p = this.pointer.scenePointer
        this.trySpawnEmptyAt(p.x, p.z)
      }
      return
    }

    const tower = this.pressedTower
    this.pressedTower = null

    if (tower) {
      if (this._tryBuild(tower)) {
        tower.handleClick(this, this.floorHeight, this.maxFloors, this.debris,
          this.towers, () => this.onTowerChanged(tower))
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
    this.trySpawnEmptyAt(p.x, p.z)
  }

  /**
   * Decide whether a build click on `tower` should proceed.
   * Only spends mana when a new block will actually be added (tower not at max).
   * Returns true if the build should happen.
   */
  _tryBuild(tower) {
    if (tower.numFloors >= this.maxFloors) return false
    if (!this.mana) return true
    // Power towers (plus blocks) and turrets cost 2 mana per floor; others 1.
    const cost = (tower.typeTop === 5 || tower.typeTop === 3) ? 2 : 1
    if (!this.mana.spend(cost)) {
      // Out of mana: don't block the build for now, just signal it
      Sounds.play('incorrect')
    }
    return true
  }

  /**
   * Try to build on an empty slot at a ground point (world coords). Finds the
   * hidden empty tower in an active lot whose footprint contains the point and
   * spawns it as a level-0 tower.
   */
  trySpawnEmptyAt(worldX, worldZ) {
    const p = new Vector2(worldX - this.gridOffsetX, worldZ - this.gridOffsetZ)
    for (const row of this.lots) {
      for (const lot of row) {
        if (!lot.active) continue
        for (const t of lot.towers) {
          if (!t.empty || !t.box.containsPoint(p)) continue
          // Spend mana (don't block when empty, just signal)
          if (this.mana && !this.mana.spend(1)) Sounds.play('incorrect')
          t.empty = false
          t.visible = true
          t.numFloors = 0
          this.updateMatrices()
          Sounds.play('pop', 0.8, 0.15)
          this.onTowerChanged(t)
          return true
        }
      }
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
    if (tower.numFloors < 1) return // nothing to destroy, no mana charged

    // Destroying costs mana too (don't block when empty, just signal)
    if (this.mana && !this.mana.spend(1)) {
      Sounds.play('incorrect')
    }

    tower.handleRightClick(this, this.floorHeight, this.debris,
      this.towers, () => {
        // Once the tower has collapsed to level 0, re-roll its tile in place
        this.rerollTower(tower)
        this.onTowerChanged(tower)
      })
  }

  /**
   * Re-randomize a tower's tile in place after it's destroyed. Keeps the same
   * footprint/size, but rolls a fresh top type (0-5, can become a plus block)
   * and new colors, swapping the instance geometries to match.
   */
  rerollTower(tower) {
    const mesh = this.towerMesh

    tower.typeTop = MathUtils.randInt(0, 5) // 5 = Cross_Top plus block
    tower.typeBottom = BlockGeometry.topToBottom.get(tower.typeTop)
    tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))
    tower.colorIndex = MathUtils.randInt(0, this.accentColors.length - 1)

    // Point existing instances at the new geometries (footprint stays the same)
    for (const idx of tower.floorInstances) {
      mesh.setGeometryIdAt(idx, this.geomIds[tower.typeBottom])
    }
    mesh.setGeometryIdAt(tower.roofInstance, this.geomIds[tower.typeTop])

    // Plus blocks get an accent color; everything else uses base/top colors
    tower.isLit = tower.typeTop === 5
    if (tower.isLit) {
      const accent = this.accentColors[tower.colorIndex]
      tower.litColor = accent.clone()
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, accent)
      mesh.setColorAt(tower.roofInstance, accent)
    } else {
      tower.litColor = null
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
    this.updateConnectors()
    this.updateZocCircles()
    this.updateLotFills()
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

  /**
   * Fade in a yellow fill rect over each dormant lot as its built-up neighbours
   * approach the spawn threshold, previewing where growth is about to happen.
   */
  updateLotFills() {
    for (const row of this.lots) {
      for (const lot of row) {
        if (!lot.fillRect) continue
        if (lot.active) { lot.fillRect.visible = false; continue }
        const p = Math.min(1, this.activeNeighbourStrength(lot) / this.lotSpawnThreshold)
        lot.fillRect.visible = p > 0
        lot.fillRect.material.opacity = 0.2 * p
      }
    }
  }

  /** Knock a tower down one floor (creep attack). Returns the new floor count. */
  damageTower(tower) {
    if (!tower || !tower.visible || tower.numFloors < 1) return 0

    // Burst the top block into debris where it sat.
    const center = tower.box.getCenter(this.towerCenter)
    const y = (tower.numFloors - 0.5) * this.floorHeight
    const color = tower.litColor || tower.baseColor
    this.debris.spawn(
      center.x + this.gridOffsetX, y, center.y + this.gridOffsetZ, 0.8, color, 10
    )

    tower.numFloors -= 1
    Sounds.play('break2', 1.0, 0.2)
    this.onTowerChanged(tower)
    return tower.numFloors
  }

  /** Count visible grey blocks: regular unlit towers (not plus blocks). */
  countGreyBlocks() {
    let n = 0
    for (const t of this.towers) {
      if (t.visible && t.numFloors >= 1 && t.typeTop !== 5) n++
    }
    return n
  }

  /** Total built height of a lot (sum of floors across its visible towers). */
  lotStrength(lot) {
    let s = 0
    for (const t of lot.towers) if (t.visible) s += t.numFloors
    return s
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
   * Staggered rise-from-ground build for one lot's towers, mirroring the intro
   * animation: each tower gets a small random target height, starts at 0, and
   * its floors pop up in sequence, ordered from the lot centre outward.
   */
  animateLotBuild(lot) {
    const cx = (lot.lotX + 0.5) * this.cellSize - this.roadWidth / 2
    const cy = (lot.lotY + 0.5) * this.cellSize - this.roadWidth / 2

    const builds = []
    for (const t of lot.towers) {
      t.dormant = false
      t.visible = !t.empty // empty slots stay hidden until clicked
      t.numFloors = 0
      if (t.empty) continue
      const target = MathUtils.randInt(1, 4)
      const center = t.box.getCenter(new Vector2())
      const dist = Math.hypot(center.x - cx, center.y - cy)
      builds.push({ tower: t, target, dist })
    }
    this.updateMatrices()

    builds.sort((a, b) => a.dist - b.dist)
    const maxDist = builds[builds.length - 1]?.dist || 1
    const staggerDuration = 0.6
    const floorDelay = 0.1

    let maxDelay = 0
    for (const { tower, target, dist } of builds) {
      const staggerDelay = (dist / maxDist) * staggerDuration
      const baseColor = tower.isLit && tower.litColor ? tower.litColor : tower.baseColor
      const newFloorColor = Tower.lightenColor(baseColor)
      for (let f = 0; f < target; f++) {
        const delay = staggerDelay + f * floorDelay
        maxDelay = Math.max(maxDelay, delay)
        setTimeout(() => {
          tower.numFloors = f + 1
          const pitch = 0.8 + (f / this.maxFloors) * 1.2
          Sounds.play('pop', pitch, 0.15, 0.4)
          tower.animateNewFloor(
            this.towerMesh,
            this.floorHeight,
            f,
            newFloorColor,
            () => this.updateTowerMatrices(tower),
            null // no debris during the grow-in
          )
        }, delay * 1000)
      }
    }

    // Once the lot has finished rising, refresh connectors/ZOC/fills and let
    // growth cascade into the next dormant neighbour.
    setTimeout(() => {
      this.updateConnectors()
      this.updateZocCircles()
      this.updateLotFills()
      this.trySpawnLots()
    }, (maxDelay + 0.4) * 1000)
  }

  /**
   * Empty-lot pull: each dormant lot looks at its neighbours, and activates
   * itself once an adjacent active lot crosses the strength threshold. This is
   * deterministic/directional - growth follows where you've actually built up,
   * instead of an active lot pushing into a random neighbour. One spawn per
   * change event so growth stays gradual.
   */
  trySpawnLots() {
    if (!this.lots.length) return
    for (const row of this.lots) {
      for (const lot of row) {
        if (lot.active) continue // only empty lots pull
        if (!this.hasStrongActiveNeighbour(lot)) continue
        this.activateLot(lot)
        return
      }
    }
  }

  /** True if the combined active-neighbour strength is over the spawn threshold. */
  hasStrongActiveNeighbour(lot) {
    return this.activeNeighbourStrength(lot) >= this.lotSpawnThreshold
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

    // Each active connector generates 1 mana every 2 seconds. Each generation
    // tick (which plays the pluck sound) also kicks the pulse envelope to 1 so
    // the tower flash stays in sync with the sound.
    if (this.activeConnectorCount > 0 && this.mana) {
      this.manaTimer += dt
      while (this.manaTimer >= 2) {
        this.manaTimer -= 2
        this.mana.add(this.activeConnectorCount)
        this.pulseEnv = 1
      }
    }

    // Grey (regular, unlit) blocks passively generate 1 mana each per 10s.
    if (this.mana) {
      this.greyManaTimer += dt
      while (this.greyManaTimer >= 10) {
        this.greyManaTimer -= 10
        const n = this.countGreyBlocks()
        if (n > 0) this.mana.add(n)
      }
    }

    // Pulse the brightness of connected towers, driven by the flash envelope
    // (sharp attack on the mana tick, then decays out before the next one).
    if (this.connectedTowers.size > 0) {
      this.pulseEnv = Math.max(0, this.pulseEnv - dt / 0.8) // decay over ~0.8s
      const brightness = 0.7 + this.pulseEnv * 0.7 // 0.7..1.4
      for (const tower of this.connectedTowers) {
        if (!tower.litColor) continue
        this._pulseColor.copy(tower.litColor).multiplyScalar(brightness)
        this._setTowerColor(tower, this._pulseColor)
      }
    }
  }

  /**
   * Update matrices for a single tower
   */
  updateTowerMatrices(tower) {
    const { dummy, towerMesh } = this
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

    // Skip roof update if animation is in progress (roof is being controlled by GSAP)
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

    // One outline per lot so it can be shown only when the lot becomes active.
    this.lotOutlineMat = new LineBasicNodeMaterial({ color: 0xffe000 })
    this.lotFillGeo = new PlaneGeometry(this.lotSize, this.lotSize)
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

        const geom = new BufferGeometry()
        geom.setAttribute('position', new Float32BufferAttribute(positions, 3))
        const outline = new LineSegments(geom, this.lotOutlineMat)
        const lot = this.lots[lotY][lotX]
        outline.visible = lot.active
        lot.outline = outline
        this.scene.add(outline)

        // Yellow fill rect that fades in as neighbours build up (dormant lots).
        const center = this.gridToWorld(gx0 + this.lotSize / 2, gz0 + this.lotSize / 2)
        const fillMat = new MeshBasicNodeMaterial({
          color: 0xffe000,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
        const fillRect = new Mesh(this.lotFillGeo, fillMat)
        fillRect.rotation.x = -Math.PI / 2
        fillRect.position.set(center.x, 0.03, center.z)
        fillRect.renderOrder = -2
        fillRect.visible = false
        lot.fillRect = fillRect
        this.scene.add(fillRect)
      }
    }

    // Seed the initial state for the starting (center) lot.
    this.updateZocCircles()
    this.updateLotFills()
  }
}
