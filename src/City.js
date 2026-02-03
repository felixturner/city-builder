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
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture, mrt, uv, fract, step, min, float } from 'three/tsl'
import { Tower } from './Tower.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { Debris } from './lib/Debris.js'
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
  }

  async init() {
    await BlockGeometry.init()
    this.initGrid()
    await this.initTowers()
    this.updateMatrices()
    this.recalculateVisibility()
  }

  initGrid() {
    // Lot layout: 10x10 building cells with 4-cell roads between lots
    this.lotSize = 10
    this.roadWidth = 4
    this.cellSize = this.lotSize + this.roadWidth // 14 cells per lot unit

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

    // Iterate over each lot and fill it with buildings
    for (let lotY = 0; lotY < this.numLotsY; lotY++) {
      for (let lotX = 0; lotX < this.numLotsX; lotX++) {
        // Calculate the bounds of this lot (excluding roads)
        const startX = lotX * this.cellSize
        const startY = lotY * this.cellSize
        const endX = startX + this.lotSize
        const endY = startY + this.lotSize

        // Fill this lot with buildings
        this.fillLot(startX, startY, endX, endY)
      }
    }

    this.finalizeGrid()
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

  fillLot(startX, startY, endX, endY) {
    const width = endX - startX
    const height = endY - startY

    // Occupied grid for this city block
    const occupied = Array.from({ length: width }, () => Array(height).fill(-1))

    const maxBlockSize = new Vector2(5, 5)
    maxBlockSize.x = MathUtils.randInt(2, 5)
    maxBlockSize.y = maxBlockSize.x

    const squareChance = 0.5
    let px = 0
    let py = 0

    while (py < height) {
      while (px < width) {
        // Find available width
        let maxW = 0
        const end = Math.min(width, px + maxBlockSize.x)
        for (let i = px; i < end; i++) {
          if (occupied[i][py] != -1) break
          maxW++
        }
        // Skip if not enough room for minimum 2x2 tower
        if (maxW < 2) {
          px++
          continue
        }

        const tower = new Tower()
        const isSquare = MathUtils.randFloat(0, 1) < squareChance
        tower.typeTop = isSquare ? MathUtils.randInt(0, 5) : 0
        tower.typeBottom = BlockGeometry.topToBottom.get(tower.typeTop)
        tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))

        const sx = MathUtils.randInt(2, maxW)
        const sy = isSquare ? sx : MathUtils.randInt(2, Math.min(maxBlockSize.y, height - py))

        // Skip towers that extend outside the lot bounds (creates empty areas)
        if (px + sx > width || py + sy > height) {
          px++
          continue
        }

        // Convert local coords to global grid coords
        const globalX = startX + px
        const globalY = startY + py
        tower.box.min.set(globalX, globalY)
        tower.box.max.set(globalX + sx, globalY + sy)

        // Store noise and random values
        const centerX = globalX + sx / 2
        const centerY = globalY + sy / 2
        tower.cityNoiseVal = this.cityNoise.scaled2D(centerX, centerY)
        tower.randFactor = MathUtils.randFloat(0, 1)
        tower.skipFactor = MathUtils.randFloat(0, 1) // For realtime visibility
        tower.rotation = isSquare
          ? (MathUtils.randInt(0, 4) * Math.PI) / 2
          : MathUtils.randInt(0, 2) * Math.PI
        tower.colorIndex = MathUtils.randInt(0, 2)

        this.towers.push(tower)

        // Mark cells as occupied (local coords)
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

      // Randomly vary max block size within city block
      if (MathUtils.randFloat(0, 1) > 0.8) {
        maxBlockSize.x = MathUtils.randFloat(0, 1) > 0.5 ? 2 : 5
        maxBlockSize.y = MathUtils.randFloat(0, 1) > 0.5 ? 2 : 5
      }
    }
  }

  finalizeGrid() {
    console.log('Tower count:', this.towers.length, 'instances:', this.towers.length * 2)
    this.recalculateHeights()
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
    // Cross_Top is index 5 in BlockGeometry.geoms
    const CROSS_TYPE = 5
    for (const tower of this.towers) {
      tower.isLit = tower.typeTop === CROSS_TYPE
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
      tower.height = (noiseHeight + randHeight) * distFactor
    }
    this.updateMatrices()
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

      // Calculate number of floors based on height
      const numFloors = Math.max(0, Math.floor(tower.height / this.floorHeight))

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
      this.hoveredTower.animateHoverColor(this.towerMesh, false, this.floorHeight)
    }

    // Hover new tower
    this.hoveredTower = tower
    if (tower) {
      tower.animateHoverColor(this.towerMesh, true, this.floorHeight)
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

    if (!tower || !tower.visible) return false

    this.pressedTower = tower
    this.pointerDownPos.set(clientX, clientY)

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
        tower.handleClick(this, this.floorHeight, this.maxFloors, this.debris,
          this.towers, () => this.updateTowerMatrices(tower))
      }
      return
    }

    if (!this.pressedTower) return

    const tower = this.pressedTower
    this.pressedTower = null

    tower.handleClick(this, this.floorHeight, this.maxFloors, this.debris,
      this.towers, () => this.updateTowerMatrices(tower))
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

    tower.handleRightClick(this, this.floorHeight, this.debris,
      this.towers, () => this.updateTowerMatrices(tower))
  }

  /**
   * Update per-frame systems (debris physics)
   */
  update(dt) {
    this.debris.update(dt)
  }

  /**
   * Update matrices for a single tower
   */
  updateTowerMatrices(tower) {
    const { dummy, towerMesh } = this
    const center = tower.box.getCenter(this.towerCenter)
    const size = tower.box.getSize(this.towerSize)
    const numFloors = Math.max(0, Math.floor(tower.height / this.floorHeight))

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
    // Fine cell grid - centered at origin (same as lot grid)
    const cellGrid = new GridHelper(this.actualGridWidth, this.actualGridWidth, 0x888888, 0x888888)
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

    // Procedural dots at grid intersections
    const cellCoord = uv().mul(this.actualGridWidth)
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
  }
}
