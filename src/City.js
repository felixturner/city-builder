import {
  Object3D,
  BatchedMesh,
  MeshPhysicalNodeMaterial,
  PlaneGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  LineBasicNodeMaterial,
  Matrix4,
} from 'three/webgpu'
import { uniform, vec3, uv, step, min, float } from 'three/tsl'
import gsap from 'gsap'
import { HexWFCSolver, HexWFCAdjacencyRules } from './HexWFC.js'
import { HexTile, HexTileGeometry, HexTileType } from './HexTiles.js'
import { Demo } from './Demo.js'

export class City {
  constructor(scene, params) {
    this.scene = scene
    this.params = params

    this.dummy = new Object3D()

    // Hex grid state
    this.hexTiles = []
    this.hexGrid = null
    this.hexGridRadius = 8
    this.hexMesh = null
    this.roadMaterial = null

    // Environment rotation uniforms
    this.envRotation = uniform(0)
    this.envRotationX = uniform(0)
  }

  async init() {
    await HexTileGeometry.init('./assets/models/hex-terrain.glb')
    this.createFloor()
    await this.initHexRoads()
    this.generateHexRoadsWFC()
    this.updateHexMatrices()
    this.createHexGridHelper()
  }

  createFloor() {
    const hexW = HexTileGeometry.HEX_WIDTH || 2
    const hexH = HexTileGeometry.HEX_HEIGHT || 2
    const floorSize = Math.max(
      this.hexGridRadius * 2 * hexW + 10,
      this.hexGridRadius * 2 * hexH + 10
    )

    const floorGeometry = new PlaneGeometry(floorSize, floorSize)
    floorGeometry.rotateX(-Math.PI / 2)

    const floorMaterial = new MeshStandardMaterial({
      color: 0x333333,
      roughness: 0.9,
      metalness: 0.0
    })

    this.floor = new Mesh(floorGeometry, floorMaterial)
    this.floor.position.y = -0.01
    this.floor.receiveShadow = true
    this.scene.add(this.floor)
  }

  isInHexRadius(col, row, radius) {
    const r = row
    const q = col - Math.floor(row / 2)
    if (q < -radius || q > radius) return false
    const r1 = Math.max(-radius, -q - radius)
    const r2 = Math.min(radius, -q + radius)
    return r >= r1 && r <= r2
  }

  generateHexRoadsWFC(options = {}) {
    const gridRadius = this.hexGridRadius
    const size = gridRadius * 2 + 1
    this.wfcGridRadius = gridRadius
    this.hexTiles = []
    this.hexGrid = Array.from({ length: size }, () => Array(size).fill(null))

    const tileTypes = options.tileTypes ?? [
      // Base
      HexTileType.GRASS,
      // Roads
      HexTileType.ROAD_A,
      HexTileType.ROAD_B,
      HexTileType.ROAD_C,
      HexTileType.ROAD_D,
      HexTileType.ROAD_E,
      HexTileType.ROAD_F,
      HexTileType.ROAD_G,
      HexTileType.ROAD_H,
      HexTileType.ROAD_I,
      HexTileType.ROAD_J,
      HexTileType.ROAD_K,
      HexTileType.ROAD_L,
      HexTileType.ROAD_M,
      // Rivers
      HexTileType.RIVER_A,
      HexTileType.RIVER_A_CURVY,
      HexTileType.RIVER_B,
      HexTileType.RIVER_C,
      HexTileType.RIVER_D,
      HexTileType.RIVER_E,
      HexTileType.RIVER_F,
      HexTileType.RIVER_G,
      HexTileType.RIVER_H,
      HexTileType.RIVER_I,
      HexTileType.RIVER_J,
      HexTileType.RIVER_K,
      HexTileType.RIVER_L,
      // Crossings
      HexTileType.RIVER_CROSSING_A,
      HexTileType.RIVER_CROSSING_B,
      // Coasts & Water
      HexTileType.WATER,
      HexTileType.COAST_A,
      HexTileType.COAST_B,
      HexTileType.COAST_C,
      HexTileType.COAST_D,
      HexTileType.COAST_E,
    ]

    if (!this.hexWfcRules) {
      this.hexWfcRules = HexWFCAdjacencyRules.fromTileDefinitions(tileTypes)
    }

    const weights = { ...options.weights }

    const params = Demo.instance?.params ?? this.params
    const seed = options.seed ?? params?.roads?.wfcSeed ?? null

    const solver = new HexWFCSolver(size, size, this.hexWfcRules, {
      weights,
      seed,
      maxRestarts: options.maxRestarts ?? 10,
      tileTypes,
    })

    // Seed center tile with grass
    const centerX = Math.floor(size / 2)
    const centerZ = Math.floor(size / 2)
    const seedTiles = [{ x: centerX, z: centerZ, type: HexTileType.GRASS, rotation: 0 }]

    const startTime = performance.now()
    const result = solver.solve(seedTiles)
    const elapsed = performance.now() - startTime

    if (!result) {
      console.warn(`Hex WFC failed after ${solver.restartCount} retries (${elapsed.toFixed(1)}ms)`)
      return
    }

    console.log(`Hex WFC: ${solver.restartCount} retries, ${elapsed.toFixed(1)}ms`)

    // Use collapse order for visualization, or result for instant placement
    const animate = options.animate ?? false
    const animateDelay = options.animateDelay ?? 20
    const placements = animate ? solver.collapseOrder : result

    if (animate) {
      this.animatePlacements(placements, gridRadius, animateDelay)
    } else {
      for (const placement of placements) {
        this.placeTile(placement, gridRadius)
      }
      this.updateHexMatrices()
    }
  }

  placeTile(placement, gridRadius) {
    if (!this.isInHexRadius(placement.gridX - gridRadius, placement.gridZ - gridRadius, gridRadius)) return null

    const tile = new HexTile(placement.gridX, placement.gridZ, placement.type, placement.rotation)
    this.hexGrid[placement.gridX][placement.gridZ] = tile
    this.hexTiles.push(tile)

    if (this.hexMesh && HexTileGeometry.geomIds.has(placement.type)) {
      const geomId = HexTileGeometry.geomIds.get(placement.type)
      tile.instanceId = this.hexMesh.addInstance(geomId)
      this.hexMesh.setColorAt(tile.instanceId, tile.color)
      // Hide initially (will be shown by animation or updateHexMatrices)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.hexMesh.setMatrixAt(tile.instanceId, this.dummy.matrix)
    }
    return tile
  }

  animatePlacements(placements, gridRadius, delay) {
    let i = 0
    const dropHeight = 5
    const animDuration = 0.4

    const step = () => {
      if (i >= placements.length) {
        return
      }
      const tile = this.placeTile(placements[i], gridRadius)
      if (tile && tile.instanceId !== null) {
        // Get world position for tile
        const pos = HexTileGeometry.getWorldPosition(
          tile.gridX - gridRadius,
          tile.gridZ - gridRadius
        )
        const rotation = -tile.rotation * Math.PI / 3  // Negative to match updateHexMatrices

        // Start above and animate down
        const anim = { y: dropHeight, scale: 0.5 }
        const dummy = this.dummy
        const mesh = this.hexMesh
        const instanceId = tile.instanceId

        gsap.to(anim, {
          y: 0,
          scale: 1,
          duration: animDuration,
          ease: 'power2.out',
          onUpdate: () => {
            dummy.position.set(pos.x, anim.y, pos.z)
            dummy.rotation.y = rotation
            dummy.scale.setScalar(anim.scale)
            dummy.updateMatrix()
            mesh.setMatrixAt(instanceId, dummy.matrix)
          }
        })
      }
      i++
      setTimeout(step, delay)
    }
    step()
  }

  async initHexRoads() {
    if (!HexTileGeometry.loaded || HexTileGeometry.geoms.size === 0) {
      console.warn('HexTileGeometry not loaded, skipping hex init')
      return
    }

    if (!this.roadMaterial) {
      const glbMat = HexTileGeometry.material
      if (glbMat) {
        this.roadMaterial = glbMat
      } else {
        const mat = new MeshPhysicalNodeMaterial()
        mat.color.setHex(0x88aa88)
        mat.roughness = 0.8
        mat.metalness = 0.1
        this.roadMaterial = mat
      }
    }

    let totalV = 0
    let totalI = 0
    for (const geom of HexTileGeometry.geoms.values()) {
      if (!geom) continue
      totalV += geom.attributes.position.count
      totalI += geom.index ? geom.index.count : 0
    }

    const maxInstances = 25 * 25

    this.hexMesh = new BatchedMesh(maxInstances, totalV * 2, totalI * 2, this.roadMaterial)
    this.hexMesh.sortObjects = false
    this.hexMesh.receiveShadow = true
    this.hexMesh.castShadow = true
    this.hexMesh.position.set(0, 0, 0)
    this.scene.add(this.hexMesh)

    HexTileGeometry.geomIds.clear()
    for (const [type, geom] of HexTileGeometry.geoms) {
      if (geom) {
        const geomId = this.hexMesh.addGeometry(geom)
        HexTileGeometry.geomIds.set(type, geomId)
      }
    }
  }

  updateHexMatrices() {
    if (!this.hexMesh || !this.hexTiles) return

    const dummy = this.dummy
    const rotationAngles = [0, 1, 2, 3, 4, 5].map(r => -r * Math.PI / 3)
    const gridRadius = this.wfcGridRadius ?? 0

    for (const tile of this.hexTiles) {
      if (tile.instanceId === null) continue

      const pos = HexTileGeometry.getWorldPosition(
        tile.gridX - gridRadius,
        tile.gridZ - gridRadius
      )
      dummy.position.set(pos.x, 0, pos.z)
      dummy.scale.set(1, 1, 1)
      dummy.rotation.y = rotationAngles[tile.rotation]
      dummy.updateMatrix()

      this.hexMesh.setMatrixAt(tile.instanceId, dummy.matrix)
      this.hexMesh.setVisibleAt(tile.instanceId, true)
    }
  }

  createHexGridHelper() {
    const hexWidth = 2
    const hexHeight = 2 / Math.sqrt(3) * 2
    const hexRadius = 2 / Math.sqrt(3)
    const gridRadius = this.hexGridRadius

    const allHexVerts = []

    for (let q = -gridRadius; q <= gridRadius; q++) {
      const r1 = Math.max(-gridRadius, -q - gridRadius)
      const r2 = Math.min(gridRadius, -q + gridRadius)
      for (let r = r1; r <= r2; r++) {
        const col = q + Math.floor(r / 2)
        const row = r
        const worldX = col * hexWidth + (Math.abs(row) % 2) * hexWidth * 0.5
        const worldZ = row * hexHeight * 0.75

        const hexVerts = []
        for (let i = 0; i < 6; i++) {
          const angle = i * Math.PI / 3
          const vx = worldX + Math.sin(angle) * hexRadius
          const vz = worldZ + Math.cos(angle) * hexRadius
          hexVerts.push(vx, 1.01, vz)
        }

        for (let i = 0; i < 6; i++) {
          const j = (i + 1) % 6
          allHexVerts.push(hexVerts[i * 3], hexVerts[i * 3 + 1], hexVerts[i * 3 + 2])
          allHexVerts.push(hexVerts[j * 3], hexVerts[j * 3 + 1], hexVerts[j * 3 + 2])
        }
      }
    }

    const hexLineGeom = new BufferGeometry()
    hexLineGeom.setAttribute('position', new Float32BufferAttribute(allHexVerts, 3))
    const hexLineMat = new LineBasicNodeMaterial({ color: 0x666666 })
    hexLineMat.depthTest = false
    this.hexGridLines = new LineSegments(hexLineGeom, hexLineMat)
    this.hexGridLines.renderOrder = 999
    this.scene.add(this.hexGridLines)

    const planeSize = gridRadius * 2 * hexWidth + hexWidth
    const hexDotPlaneGeom = new PlaneGeometry(planeSize, planeSize)
    hexDotPlaneGeom.rotateX(-Math.PI / 2)

    const hexDotMat = new MeshBasicNodeMaterial()
    hexDotMat.transparent = true
    hexDotMat.alphaTest = 0.5
    hexDotMat.side = 2
    hexDotMat.depthTest = false

    const worldPos = uv().sub(0.5).mul(planeSize)
    const wx = worldPos.x
    const wz = worldPos.y

    const hWidth = float(hexWidth)
    const hHeight = float(hexHeight)
    const hRadius = float(hexRadius)

    const rowF = wz.div(hHeight.mul(0.75))
    const row = rowF.round()
    const rowMod = row.mod(2).abs()
    const colOffset = rowMod.mul(hWidth.mul(0.5))
    const colF = wx.sub(colOffset).div(hWidth)
    const col = colF.round()

    const hexCenterX = col.mul(hWidth).add(colOffset)
    const hexCenterZ = row.mul(hHeight.mul(0.75))

    const dotRadius = float(0.04)
    let dotMask = float(0)
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3
      const vx = hexCenterX.add(float(Math.sin(angle)).mul(hRadius))
      const vz = hexCenterZ.add(float(Math.cos(angle)).mul(hRadius))
      const dx = wx.sub(vx)
      const dz = wz.sub(vz)
      const dist = dx.mul(dx).add(dz.mul(dz)).sqrt()
      dotMask = dotMask.add(float(1).sub(step(dotRadius, dist)))
    }
    dotMask = min(dotMask, float(1))

    const dotColor = vec3(0.267, 0.267, 0.267)
    hexDotMat.colorNode = dotColor
    hexDotMat.opacityNode = dotMask

    this.hexGridDots = new Mesh(hexDotPlaneGeom, hexDotMat)
    this.hexGridDots.position.set(0, 1.015, 0)
    this.hexGridDots.renderOrder = 998
    this.scene.add(this.hexGridDots)
  }

  regenerate(options = {}) {
    this.regenerateHex(options)
  }

  async regenerateHex(options = {}) {
    if (this.hexMesh) {
      for (const tile of this.hexTiles) {
        if (tile.instanceId !== null) {
          this.hexMesh.deleteInstance(tile.instanceId)
        }
      }
    }
    this.hexTiles = []

    if (this.hexGridLines) {
      this.scene.remove(this.hexGridLines)
      this.hexGridLines.geometry.dispose()
      this.hexGridLines = null
    }
    if (this.hexGridDots) {
      this.scene.remove(this.hexGridDots)
      this.hexGridDots.geometry.dispose()
      this.hexGridDots = null
    }

    if (!this.hexMesh) {
      await this.initHexRoads()
    }

    // Clear cached rules to pick up any changes
    this.hexWfcRules = null

    this.generateHexRoadsWFC(options)
    // Only update immediately if not animating (animation handles its own updates)
    if (!options.animate) {
      this.updateHexMatrices()
    }
    this.createHexGridHelper()
  }

  update(_dt) {
    // Future: animate tiles
  }

  // Stub methods for Demo.js compatibility
  onHover() {}
  onPointerDown() { return false }
  onPointerMove() {}
  onPointerUp() {}
  onRightClick() {}
  startIntroAnimation() {}
}
