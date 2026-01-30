import {
  Box2,
  MathUtils,
  Vector2,
  Object3D,
  BatchedMesh,
  MeshPhysicalNodeMaterial,
} from 'three/webgpu'
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture } from 'three/tsl'
import { ABlock } from './lib/ABlock.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
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

    this.blocks = []
    this.gridZone = new Box2(new Vector2(0, 0), new Vector2(148, 148))
    this.blockMesh = null
    this.blockMaterial = null
    this.dummy = new Object3D()
    this.blockSize = new Vector2(1, 1)
    this.blockCenter = new Vector2()

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
  }

  async init() {
    await BlockGeometry.init()
    this.initGrid()
    await this.initBlocks()
    this.updateMatrices()
    this.recalculateVisibility()
  }

  initGrid() {
    // Lot layout: 10x10 building cells with 3-cell roads between lots
    const lotSize = 10
    const roadWidth = 3
    const cellSize = lotSize + roadWidth // 13 cells per lot unit

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

        const block = new ABlock()
        const isSquare = MathUtils.randFloat(0, 1) < squareChance
        block.typeTop = isSquare ? MathUtils.randInt(0, 5) : 0
        block.typeBottom = BlockGeometry.topToBottom.get(block.typeTop)
        block.setTopColorIndex(MathUtils.randInt(0, ABlock.LIGHT_COLORS.length - 1))

        const sx = MathUtils.randInt(1, maxW)
        const sy = isSquare ? sx : MathUtils.randInt(1, Math.min(maxBlockSize.y, height - py))

        // Skip blocks that extend outside the city block bounds (creates empty areas)
        if (px + sx > width || py + sy > height) {
          px++
          continue
        }

        // Convert local coords to global grid coords
        const globalX = startX + px
        const globalY = startY + py
        block.box.min.set(globalX, globalY)
        block.box.max.set(globalX + sx, globalY + sy)

        // Store noise and random values
        const centerX = globalX + sx / 2
        const centerY = globalY + sy / 2
        block.cityNoiseVal = this.cityNoise.scaled2D(centerX, centerY)
        block.randFactor = MathUtils.randFloat(0, 1)
        block.skipFactor = MathUtils.randFloat(0, 1) // For realtime visibility
        block.rotation = isSquare
          ? (MathUtils.randInt(0, 4) * Math.PI) / 2
          : MathUtils.randInt(0, 2) * Math.PI

        this.blocks.push(block)

        // Mark cells as occupied (local coords)
        const localEndX = Math.min(width, px + sx)
        const localEndY = Math.min(height, py + sy)
        for (let i = px; i < localEndX; i++) {
          for (let j = py; j < localEndY; j++) {
            occupied[i][j] = block.id
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
    console.log('Block count:', this.blocks.length, 'instances:', this.blocks.length * 2)
    this.recalculateHeights()
  }

  async initBlocks() {
    // Material values set by applyParams
    const mat = new MeshPhysicalNodeMaterial()
    this.blockMaterial = mat

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

    // Floor stacking: each building needs up to maxFloors base instances + 1 roof
    this.maxFloors = 20
    this.floorHeight = 1

    // Calculate total geometry needed for all buildings with max floors
    let totalV = 0
    let totalI = 0
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]
      // maxFloors base instances + 1 roof instance per building
      totalV += vCounts[block.typeBottom] * this.maxFloors
      totalV += vCounts[block.typeTop]
      totalI += iCounts[block.typeBottom] * this.maxFloors
      totalI += iCounts[block.typeTop]
    }

    const maxInstances = this.blocks.length * (this.maxFloors + 1)
    this.blockMesh = new BatchedMesh(maxInstances, totalV, totalI, mat)
    this.blockMesh.sortObjects = false
    this.blockMesh.castShadow = true
    this.blockMesh.receiveShadow = true
    this.blockMesh.position.x = -this.actualGridWidth * 0.5
    this.blockMesh.position.z = -this.actualGridHeight * 0.5
    this.scene.add(this.blockMesh)

    const geomIds = []
    for (let i = 0; i < geoms.length; i++) {
      geomIds.push(this.blockMesh.addGeometry(geoms[i]))
    }

    // Create instances for each building: maxFloors base + 1 roof
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]
      block.floorInstances = []

      // Create floor instances (base geometry)
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = this.blockMesh.addInstance(geomIds[block.typeBottom])
        this.blockMesh.setColorAt(idx, block.baseColor)
        this.blockMesh.setVisibleAt(idx, false)
        block.floorInstances.push(idx)
      }

      // Create roof instance (top geometry)
      block.roofInstance = this.blockMesh.addInstance(geomIds[block.typeTop])
      this.blockMesh.setColorAt(block.roofInstance, block.topColor)
      this.blockMesh.setVisibleAt(block.roofInstance, false)
    }

    console.log('Block count:', this.blocks.length, 'Max instances:', maxInstances)
  }

  recalculateHeights() {
    const gridCenterX = this.actualGridWidth / 2
    const gridCenterY = this.actualGridHeight / 2

    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]
      const center = block.box.getCenter(this.blockCenter)

      // Distance from center falloff using max axis distance (0 at center, 1 at any edge)
      const dx = Math.abs(center.x - gridCenterX)
      const dy = Math.abs(center.y - gridCenterY)
      const normalizedDist = Math.max(dx / gridCenterX, dy / gridCenterY)
      const distFactor = 1 - Math.pow(normalizedDist, 2) * this.centerFalloff

      // Subtract from noise, clamp to 0, then cube for contrast
      const adjustedNoise = Math.max(0, block.cityNoiseVal - this.noiseSubtract)
      const noiseHeight = Math.pow(adjustedNoise, 3) * this.heightNoiseScale
      // Power > 1 skews distribution: most buildings short, few tall outliers
      const randHeight = Math.pow(block.randFactor, this.randHeightPower) * this.randHeightAmount
      block.height = (noiseHeight + randHeight) * distFactor
    }
    this.updateMatrices()
  }

  updateMatrices() {
    if (!this.blockMesh) return
    const { dummy, blockMesh, blocks } = this

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]

      // Hide all instances if block is not visible
      if (block.visible === false) {
        for (let f = 0; f < this.maxFloors; f++) {
          blockMesh.setVisibleAt(block.floorInstances[f], false)
        }
        blockMesh.setVisibleAt(block.roofInstance, false)
        continue
      }

      const center = block.box.getCenter(this.blockCenter)
      const size = block.box.getSize(this.blockSize)

      // Calculate number of floors based on height
      const numFloors = Math.max(1, Math.floor(block.height / this.floorHeight))

      // Position and show floor instances
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = block.floorInstances[f]
        if (f < numFloors) {
          dummy.position.set(center.x, f * this.floorHeight, center.y)
          dummy.scale.set(size.x, this.floorHeight, size.y)
          dummy.rotation.y = block.rotation
          dummy.updateMatrix()
          blockMesh.setMatrixAt(idx, dummy.matrix)
          blockMesh.setVisibleAt(idx, true)
        } else {
          blockMesh.setVisibleAt(idx, false)
        }
      }

      // Position roof on top
      dummy.position.set(center.x, numFloors * this.floorHeight, center.y)
      dummy.scale.set(size.x, 1, size.y)
      dummy.rotation.y = block.rotation
      dummy.updateMatrix()
      blockMesh.setMatrixAt(block.roofInstance, dummy.matrix)
      blockMesh.setVisibleAt(block.roofInstance, true)
    }
  }

  recalculateVisibility() {
    if (!this.blockMesh) return
    const gridCenterX = this.actualGridWidth / 2
    const gridCenterY = this.actualGridHeight / 2
    const maxDist = Math.sqrt(gridCenterX * gridCenterX + gridCenterY * gridCenterY)

    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]
      const center = block.box.getCenter(this.blockCenter)

      // Increase skip chance based on distance from center
      const dx = center.x - gridCenterX
      const dy = center.y - gridCenterY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const distFactor = Math.pow(dist / maxDist, 2) // 0 at center, 1 at corners, squared
      const effectiveSkipChance = this.skipChance + distFactor * 1.2 // adds up to 1.2 at edges

      block.visible = block.skipFactor >= effectiveSkipChance
    }
    // Visibility is applied in updateMatrices based on block.visible
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
    // Recalculate noise values for all blocks
    let minNoise = Infinity
    let maxNoise = -Infinity
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]
      const center = block.box.getCenter(this.blockCenter)
      block.cityNoiseVal = this.cityNoise.scaled2D(center.x, center.y)
      minNoise = Math.min(minNoise, block.cityNoiseVal)
      maxNoise = Math.max(maxNoise, block.cityNoiseVal)
    }
    console.log('Noise range:', minNoise, '-', maxNoise)
    this.recalculateHeights()
  }

  setupEnvRotation() {
    const mat = this.blockMaterial
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
}
