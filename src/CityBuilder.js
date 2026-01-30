import {
  Box2,
  MathUtils,
  Vector2,
  Object3D,
  BatchedMesh,
  MeshPhysicalNodeMaterial,
  Color,
} from 'three/webgpu'
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture } from 'three/tsl'
import { Tower } from './Tower.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
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

export class CityBuilder {
  constructor(scene, params) {
    this.scene = scene
    this.params = params

    this.towers = []
    this.gridZone = new Box2(new Vector2(0, 0), new Vector2(154, 154)) // 11x11 lots at 14 cells each
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
    // Base hover colors - transformed to lighter/less saturated versions
    const baseHoverColors = [
      new Color('#FC238D'),
      new Color('#D2E253'),
      new Color('#1BB3F6'),
    ]
    // Transform colors: reduce saturation, increase lightness (50% of previous transform)
    this.hoverColors = baseHoverColors.map(c => {
      const hsl = {}
      c.getHSL(hsl)
      return new Color().setHSL(hsl.h, hsl.s * 0.8, Math.min(1, hsl.l + 0.1))
    })
    this.instanceToTower = new Map() // Maps instance ID to tower

    // Click state
    this.pressedTower = null
    this.pointerDownPos = new Vector2()
    this.dragThreshold = 5 // pixels

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
    const lotSize = 10
    const roadWidth = 4
    const cellSize = lotSize + roadWidth // 14 cells per lot unit

    // Calculate number of lots that fit in the grid
    const numLotsX = Math.floor(this.gridZone.max.x / cellSize)
    const numLotsY = Math.floor(this.gridZone.max.y / cellSize)

    // Store actual grid dimensions for centering
    this.actualGridWidth = numLotsX * cellSize
    this.actualGridHeight = numLotsY * cellSize

    // Iterate over each lot and fill it with buildings
    for (let lotY = 0; lotY < numLotsY; lotY++) {
      for (let lotX = 0; lotX < numLotsX; lotX++) {
        // Calculate the bounds of this lot (excluding roads)
        const startX = lotX * cellSize
        const startY = lotY * cellSize
        const endX = startX + lotSize
        const endY = startY + lotSize

        // Fill this lot with buildings
        this.fillLot(startX, startY, endX, endY)
      }
    }

    this.finalizeGrid()
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
        if (maxW == 0) {
          px++
          continue
        }

        const tower = new Tower()
        const isSquare = MathUtils.randFloat(0, 1) < squareChance
        tower.typeTop = isSquare ? MathUtils.randInt(0, 5) : 0
        tower.typeBottom = BlockGeometry.topToBottom.get(tower.typeTop)
        tower.setTopColorIndex(MathUtils.randInt(0, Tower.LIGHT_COLORS.length - 1))

        const sx = MathUtils.randInt(1, maxW)
        const sy = isSquare ? sx : MathUtils.randInt(1, Math.min(maxBlockSize.y, height - py))

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

    // Floor stacking: each tower needs up to maxFloors base instances + 1 roof
    this.maxFloors = 20
    this.floorHeight = 2

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
    this.towerMesh.position.x = -this.actualGridWidth * 0.5
    this.towerMesh.position.z = -this.actualGridHeight * 0.5
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
      const numFloors = Math.max(1, Math.floor(tower.height / this.floorHeight))

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
      // Get the instance ID from batchId (BatchedMesh uses batchId for instance index)
      const instanceId = intersection.batchId
      tower = this.instanceToTower.get(instanceId)
    }

    // No change
    if (tower === this.hoveredTower) return

    // Unhover previous tower
    if (this.hoveredTower) {
      this.animateTowerColor(this.hoveredTower, false)
    }

    // Hover new tower
    this.hoveredTower = tower
    if (tower) {
      this.animateTowerColor(tower, true)
    }
  }

  /**
   * Animate tower color to/from hover state
   * @param {Tower} tower - The tower to animate
   * @param {boolean} isHovering - True to animate to hover color, false to restore
   */
  animateTowerColor(tower, isHovering) {
    const targetColor = isHovering ? this.hoverColors[tower.colorIndex] : null
    tower.animateHoverColor(this.towerMesh, targetColor, this.floorHeight)
  }

  /**
   * Handle pointer down on a tower - push it down
   * @param {Object|null} intersection - Three.js intersection object or null
   * @param {number} clientX - pointer X position
   * @param {number} clientY - pointer Y position
   */
  onPointerDown(intersection, clientX, clientY) {
    let tower = null
    if (intersection && intersection.batchId !== undefined) {
      tower = this.instanceToTower.get(intersection.batchId)
    }

    if (!tower || !tower.visible) return

    this.pressedTower = tower
    this.pointerDownPos.set(clientX, clientY)

    Sounds.play('tick', 1.0, 0)

    // Push the tower down by 0.25 floor height
    const pushAmount = this.floorHeight * 0.25
    this.animateTowerOffset(tower, -pushAmount, 0.1)
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
      // Cancel the click - animate back to normal
      const tower = this.pressedTower
      this.pressedTower = null
      this.animateTowerOffset(tower, 0, 0.15)
    }
  }

  /**
   * Handle pointer up - add a floor and animate it rising
   */
  onPointerUp() {
    if (!this.pressedTower) return

    const tower = this.pressedTower
    this.pressedTower = null

    const numFloors = Math.max(1, Math.floor(tower.height / this.floorHeight))

    // Check if we can add another floor
    if (numFloors >= this.maxFloors) {
      // Just animate back to normal position
      this.animateTowerOffset(tower, 0, 0.2)
      return
    }

    // Set height to exact floor count + 1 (align to floor boundaries)
    tower.height = (numFloors + 1) * this.floorHeight

    Sounds.play('pop', 1.0, 0.3)

    // Animate the tower back up with the new floor emerging
    this.animateNewFloor(tower, numFloors)
  }

  /**
   * Animate tower vertical offset (for press down effect)
   */
  animateTowerOffset(tower, offset, duration, onComplete) {
    tower.animateOffset(this.towerMesh, this.floorHeight, this.maxFloors, offset, duration, onComplete)
  }

  /**
   * Animate adding a new floor with roof pop-off effect
   */
  animateNewFloor(tower, oldNumFloors) {
    const hoverColor = this.hoverColors[tower.colorIndex]
    tower.animateNewFloor(this.towerMesh, this.floorHeight, oldNumFloors, hoverColor, () => {
      this.updateTowerMatrices(tower)
    }, () => {
      Sounds.play('stone', 1.0, 0.4, 0.2)
    })
  }

  /**
   * Update matrices for a single tower
   */
  updateTowerMatrices(tower) {
    const { dummy, towerMesh } = this
    const center = tower.box.getCenter(this.towerCenter)
    const size = tower.box.getSize(this.towerSize)
    const numFloors = Math.max(1, Math.floor(tower.height / this.floorHeight))

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
}
