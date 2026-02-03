import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Vector2,
  Vector3,
  Box2,
  DoubleSide,
  AdditiveBlending,
  MeshBasicNodeMaterial,
} from 'three/webgpu'
import { uniform, uv, smoothstep, mix, vec3, float, fract, abs, min, max, clamp, select, Fn, mrt, output } from 'three/tsl'

// RGB to HSV conversion in TSL
const rgb2hsv = Fn(([rgb]) => {
  const r = rgb.x
  const g = rgb.y
  const b = rgb.z
  const maxC = max(max(r, g), b)
  const minC = min(min(r, g), b)
  const delta = maxC.sub(minC)

  // Hue calculation
  const h = select(
    delta.lessThan(0.00001),
    float(0),
    select(
      maxC.equal(r),
      g.sub(b).div(delta).mod(6).mul(1 / 6),
      select(
        maxC.equal(g),
        b.sub(r).div(delta).add(2).mul(1 / 6),
        r.sub(g).div(delta).add(4).mul(1 / 6)
      )
    )
  )

  // Saturation
  const s = select(maxC.lessThan(0.00001), float(0), delta.div(maxC))

  // Value
  const v = maxC

  return vec3(h, s, v)
})

// HSV to RGB conversion in TSL
const hsv2rgb = Fn(([hsv]) => {
  const h = hsv.x
  const s = hsv.y
  const v = hsv.z

  const i = h.mul(6).floor()
  const f = h.mul(6).sub(i)
  const p = v.mul(float(1).sub(s))
  const q = v.mul(float(1).sub(f.mul(s)))
  const t = v.mul(float(1).sub(float(1).sub(f).mul(s)))

  const iMod = i.mod(6)

  return select(
    iMod.lessThan(1),
    vec3(v, t, p),
    select(
      iMod.lessThan(2),
      vec3(q, v, p),
      select(
        iMod.lessThan(3),
        vec3(p, v, t),
        select(
          iMod.lessThan(4),
          vec3(p, q, v),
          select(
            iMod.lessThan(5),
            vec3(t, p, v),
            vec3(v, p, q)
          )
        )
      )
    )
  )
})

/**
 * Trails - Renders animated glowing paths between towers
 * Uses right-angle walks along roads connecting tower centers
 */
export class Trails {
  constructor(scene, cityBuilder) {
    this.scene = scene
    this.city = cityBuilder
    this.paths = []
    this.meshes = []

    // Grid layout constants (from City)
    this.lotSize = 10
    this.roadWidth = 4
    this.cellSize = this.lotSize + this.roadWidth // 14

    // Path visual settings
    this.pathWidth = 0.4
    this.pathHeight = 0.05 // Slightly above ground

    // Time uniform for animation
    this.uTime = uniform(0)

    // Trail colors - match tower hover colors (pink, yellow, cyan)
    // Original hex hover colors from City: #FC238D, #D2E253, #1BB3F6
    this.trailColors = [
      vec3(0xFC / 255, 0x23 / 255, 0x8D / 255),  // #FC238D - Hot pink
      vec3(0xD2 / 255, 0xE2 / 255, 0x53 / 255),  // #D2E253 - Lime/yellow-green
      vec3(0x1B / 255, 0xB3 / 255, 0xF6 / 255),  // #1BB3F6 - Cyan/blue
    ]
  }

  /**
   * Get lot indices for a tower based on its center position
   */
  getTowerLot(tower) {
    const center = tower.box.getCenter(new Vector2())
    return {
      x: Math.floor(center.x / this.cellSize),
      y: Math.floor(center.y / this.cellSize)
    }
  }

  /**
   * Generate paths between lit towers of matching colors
   */
  generatePaths(numPaths = 50) {
    this.clear()

    // Get lit towers grouped by color index
    const litByColor = [[], [], []] // 3 color indices
    for (const tower of this.city.towers) {
      if (tower.visible && tower.isLit) {
        litByColor[tower.colorIndex].push(tower)
      }
    }

    const numLotsX = Math.floor(this.city.actualGridWidth / this.cellSize)
    const numLotsY = Math.floor(this.city.actualGridHeight / this.cellSize)

    let pathsCreated = 0
    let attempts = 0
    const maxAttempts = numPaths * 5

    while (pathsCreated < numPaths && attempts < maxAttempts) {
      attempts++

      // Pick a random color that has at least 2 lit towers
      const validColors = litByColor
        .map((towers, idx) => ({ towers, idx }))
        .filter(c => c.towers.length >= 2)

      if (validColors.length === 0) break

      const colorData = validColors[Math.floor(Math.random() * validColors.length)]
      const colorIndex = colorData.idx
      const litTowers = colorData.towers

      // Pick a random start tower
      const startTower = litTowers[Math.floor(Math.random() * litTowers.length)]
      const startLot = this.getTowerLot(startTower)

      // Find lit towers of same color in nearby lots (1-2 away)
      const nearbyLitTowers = litTowers.filter(t => {
        if (t === startTower) return false
        const lot = this.getTowerLot(t)
        const dx = Math.abs(lot.x - startLot.x)
        const dy = Math.abs(lot.y - startLot.y)
        return dx <= 2 && dy <= 2 && (dx > 0 || dy > 0)
      })

      if (nearbyLitTowers.length === 0) continue

      // Pick a random nearby tower
      const targetTower = nearbyLitTowers[Math.floor(Math.random() * nearbyLitTowers.length)]

      const path = this.findPath(startTower, targetTower)
      if (path && path.length >= 2) {
        this.paths.push(path)
        this.createPathMesh(path, pathsCreated, colorIndex)
        pathsCreated++
      }
    }

    console.log(`Total paths created: ${pathsCreated} (from ${attempts} attempts)`)
  }

  /**
   * Build a grid of tower bounding boxes for collision detection
   */
  buildTowerGrid() {
    this.towerBoxes = []
    for (const tower of this.city.towers) {
      if (!tower.visible) continue
      // Clone the box for collision testing
      this.towerBoxes.push({
        tower,
        box: tower.box.clone()
      })
    }
  }

  /**
   * Check if a path intersects any towers (except start/end towers)
   */
  pathIntersectsTowers(path, startTower, endTower) {
    const { gridOffsetX, gridOffsetZ } = this.city

    // Check each segment of the path
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i]
      const p2 = path[i + 1]

      // Convert world coords back to grid coords
      const g1x = p1.x - gridOffsetX
      const g1z = p1.z - gridOffsetZ
      const g2x = p2.x - gridOffsetX
      const g2z = p2.z - gridOffsetZ

      // Create a thin box along the segment
      const minX = Math.min(g1x, g2x) - 0.1
      const maxX = Math.max(g1x, g2x) + 0.1
      const minZ = Math.min(g1z, g2z) - 0.1
      const maxZ = Math.max(g1z, g2z) + 0.1

      const segmentBox = new Box2(
        new Vector2(minX, minZ),
        new Vector2(maxX, maxZ)
      )

      // Check against all towers
      for (const { tower, box } of this.towerBoxes) {
        if (tower === startTower || tower === endTower) continue
        if (box.intersectsBox(segmentBox)) {
          return true
        }
      }
    }

    return false
  }

  /**
   * Find a strict right-angle path between two towers using roads
   * Ensures the path exits perpendicular from tower edge by at least 1 cell
   */
  findPath(tower1, tower2) {
    const { gridOffsetX, gridOffsetZ } = this.city

    // Get tower centers and sizes in grid coords
    const center1 = tower1.box.getCenter(new Vector2())
    const center2 = tower2.box.getCenter(new Vector2())
    const size1 = tower1.box.getSize(new Vector2())
    const size2 = tower2.box.getSize(new Vector2())

    // Determine which edge of each tower to exit from based on relative positions
    const dx = center2.x - center1.x
    const dz = center2.y - center1.y

    const path = []

    // Tower 1: determine exit direction (perpendicular first)
    let exit1Dir, exit1Edge
    if (Math.abs(dx) > Math.abs(dz)) {
      // Towers are more horizontal - exit from X edge
      exit1Dir = Math.sign(dx)
      exit1Edge = new Vector3(
        center1.x + exit1Dir * size1.x / 2 + gridOffsetX,
        this.pathHeight,
        center1.y + gridOffsetZ
      )
    } else {
      // Towers are more vertical - exit from Z edge
      exit1Dir = Math.sign(dz)
      exit1Edge = new Vector3(
        center1.x + gridOffsetX,
        this.pathHeight,
        center1.y + exit1Dir * size1.y / 2 + gridOffsetZ
      )
    }

    path.push(exit1Edge)

    // Go perpendicular from tower edge for at least 1 cell before turning
    const minPerpendicularDist = this.roadWidth + 1 // At least into the road
    let perpPoint1
    if (Math.abs(dx) > Math.abs(dz)) {
      // Exiting horizontally - continue in X direction
      perpPoint1 = new Vector3(
        exit1Edge.x + exit1Dir * minPerpendicularDist,
        this.pathHeight,
        exit1Edge.z
      )
    } else {
      // Exiting vertically - continue in Z direction
      perpPoint1 = new Vector3(
        exit1Edge.x,
        this.pathHeight,
        exit1Edge.z + exit1Dir * minPerpendicularDist
      )
    }
    path.push(perpPoint1)

    // Tower 2: determine entry direction (from opposite side)
    let entry2Dir, entry2Edge
    if (Math.abs(dx) > Math.abs(dz)) {
      // Towers are more horizontal - enter from X edge
      entry2Dir = -Math.sign(dx)
      entry2Edge = new Vector3(
        center2.x + entry2Dir * size2.x / 2 + gridOffsetX,
        this.pathHeight,
        center2.y + gridOffsetZ
      )
    } else {
      // Towers are more vertical - enter from Z edge
      entry2Dir = -Math.sign(dz)
      entry2Edge = new Vector3(
        center2.x + gridOffsetX,
        this.pathHeight,
        center2.y + entry2Dir * size2.y / 2 + gridOffsetZ
      )
    }

    // Perpendicular point before entering tower 2
    let perpPoint2
    if (Math.abs(dx) > Math.abs(dz)) {
      perpPoint2 = new Vector3(
        entry2Edge.x + entry2Dir * minPerpendicularDist,
        this.pathHeight,
        entry2Edge.z
      )
    } else {
      perpPoint2 = new Vector3(
        entry2Edge.x,
        this.pathHeight,
        entry2Edge.z + entry2Dir * minPerpendicularDist
      )
    }

    // Now connect perpPoint1 to perpPoint2 with right-angle path
    // Strategy: go in the perpendicular direction first, then parallel
    if (Math.abs(dx) > Math.abs(dz)) {
      // Main direction is X, so we need to align Z first, then X
      // From perpPoint1, go in Z direction to match perpPoint2's Z
      if (Math.abs(perpPoint1.z - perpPoint2.z) > 0.01) {
        path.push(new Vector3(perpPoint1.x, this.pathHeight, perpPoint2.z))
      }
      // Then go in X direction to reach perpPoint2
      if (Math.abs(path[path.length - 1].x - perpPoint2.x) > 0.01) {
        path.push(perpPoint2.clone())
      }
    } else {
      // Main direction is Z, so we need to align X first, then Z
      if (Math.abs(perpPoint1.x - perpPoint2.x) > 0.01) {
        path.push(new Vector3(perpPoint2.x, this.pathHeight, perpPoint1.z))
      }
      if (Math.abs(path[path.length - 1].z - perpPoint2.z) > 0.01) {
        path.push(perpPoint2.clone())
      }
    }

    // Add entry edge
    path.push(entry2Edge)

    // Remove duplicate consecutive points
    const cleanPath = [path[0]]
    for (let i = 1; i < path.length; i++) {
      if (path[i].distanceTo(cleanPath[cleanPath.length - 1]) > 0.01) {
        cleanPath.push(path[i])
      }
    }

    // Add rounded corners
    return this.addRoundedCorners(cleanPath)
  }

  /**
   * Add rounded corners to a path by inserting arc segments at each corner
   * Corners curve OUTWARD (away from the corner point)
   */
  addRoundedCorners(path) {
    if (path.length < 3) return path

    const cornerRadius = 1.0 // Radius of the rounded corners
    const arcSegments = 5 // Number of segments per corner arc

    const result = [path[0].clone()]

    for (let i = 1; i < path.length - 1; i++) {
      const prev = path[i - 1]
      const curr = path[i]
      const next = path[i + 1]

      // Get directions FROM current point TO prev and next
      const toPrev = prev.clone().sub(curr)
      const toNext = next.clone().sub(curr)

      toPrev.y = 0
      toNext.y = 0
      const lenPrev = toPrev.length()
      const lenNext = toNext.length()

      if (lenPrev < 0.01 || lenNext < 0.01) {
        result.push(curr.clone())
        continue
      }

      toPrev.normalize()
      toNext.normalize()

      // Check if directions are roughly perpendicular (it's a corner)
      const dot = toPrev.dot(toNext)
      if (Math.abs(dot) > 0.1) {
        // Not a 90° corner, just add the point
        result.push(curr.clone())
        continue
      }

      // Calculate how far back to place the arc start/end
      const arcDist = Math.min(cornerRadius, lenPrev * 0.4, lenNext * 0.4)

      // Arc start (on the segment coming from prev)
      const arcStart = curr.clone().add(toPrev.clone().multiplyScalar(arcDist))
      // Arc end (on the segment going to next)
      const arcEnd = curr.clone().add(toNext.clone().multiplyScalar(arcDist))

      // Add arc start
      result.push(arcStart)

      // For a smooth interior curve, interpolate along a quadratic bezier
      // Control point is the corner itself, which creates a smooth 90° turn
      for (let s = 1; s < arcSegments; s++) {
        const t = s / arcSegments
        // Quadratic bezier: P = (1-t)²·P0 + 2(1-t)t·P1 + t²·P2
        // P0 = arcStart, P1 = curr (corner), P2 = arcEnd
        const mt = 1 - t
        const arcPoint = new Vector3(
          mt * mt * arcStart.x + 2 * mt * t * curr.x + t * t * arcEnd.x,
          this.pathHeight,
          mt * mt * arcStart.z + 2 * mt * t * curr.z + t * t * arcEnd.z
        )
        result.push(arcPoint)
      }

      // Add arc end
      result.push(arcEnd)
    }

    // Add final point
    result.push(path[path.length - 1].clone())

    return result
  }

  /**
   * Create a mesh for a path with glowing animated material
   */
  createPathMesh(path, pathIndex, colorIndex) {
    if (path.length < 2) return

    // Calculate total path length for UV mapping
    let totalLength = 0
    const segmentLengths = []
    for (let i = 0; i < path.length - 1; i++) {
      const len = path[i].distanceTo(path[i + 1])
      segmentLengths.push(len)
      totalLength += len
    }

    if (totalLength < 0.1) return

    // Build geometry as a ribbon (quad strip)
    const positions = []
    const uvs = []
    const indices = []

    let accumulatedLength = 0

    for (let i = 0; i < path.length; i++) {
      const p = path[i]

      // Get direction for this segment - use incoming direction to avoid kinks at corners
      let dir
      if (i === 0) {
        dir = path[1].clone().sub(path[0])
      } else {
        // Use direction from previous point (incoming direction)
        dir = path[i].clone().sub(path[i - 1])
      }

      dir.y = 0
      if (dir.length() > 0.001) {
        dir.normalize()
      } else {
        dir.set(1, 0, 0)
      }

      // Perpendicular direction (for ribbon width) - rotate 90° in XZ plane
      const perp = new Vector3(-dir.z, 0, dir.x).multiplyScalar(this.pathWidth / 2)

      // Two vertices per point (left and right edge of ribbon)
      const left = p.clone().add(perp)
      const right = p.clone().sub(perp)

      positions.push(left.x, left.y, left.z)
      positions.push(right.x, right.y, right.z)

      // UV: x = cross position (0-1), y = actual distance along path (in world units)
      // This allows shader to create consistent gradient spacing regardless of path length
      uvs.push(0, accumulatedLength)
      uvs.push(1, accumulatedLength)

      // Update accumulated length for next vertex
      if (i < path.length - 1) {
        accumulatedLength += segmentLengths[i]
      }

      // Build quad indices
      if (i > 0) {
        const base = (i - 1) * 2
        indices.push(base, base + 1, base + 2)
        indices.push(base + 1, base + 3, base + 2)
      }
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()

    // Create glowing animated material
    const material = this.createGlowMaterial(pathIndex, colorIndex)

    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 1 // Render above dots (which have default renderOrder 0)
    this.scene.add(mesh)
    this.meshes.push(mesh)
  }

  /**
   * Create animated glow material using TSL
   * Gradient from tower color to white, no opacity fade
   */
  createGlowMaterial(pathIndex, colorIndex) {
    const material = new MeshBasicNodeMaterial()
    material.transparent = true
    material.side = DoubleSide
    material.depthWrite = false
    material.blending = AdditiveBlending

    // UV.y is actual distance along path in world units
    // UV.x is position across path width (0-1, 0.5 = center)
    const pathDist = uv().y
    const crossPos = uv().x

    // Get the trail color for this path (one of the tower colors)
    const trailColor = this.trailColors[colorIndex]

    // Animated position walking down the path (in world units)
    const speed = 5.0 // World units per second
    const phaseOffset = float(pathIndex).mul(2.0) // Offset each path's animation
    const animPos = this.uTime.mul(speed).add(phaseOffset)

    // Gradient spacing in world units - roughly one gradient per 2 world units
    const gradientSpacing = 2.0

    // Position within the repeating gradient pattern (0-1)
    const patternPos = fract(pathDist.sub(animPos).div(gradientSpacing))

    // Color gradient: smooth sine wave between bright and dark
    // Creates equal light/dark sections with smooth transitions throughout
    const wave = patternPos.mul(Math.PI * 2).sin().mul(0.5).add(0.5) // 0-1 sine wave

    // Dark color: lower value using HSV
    const hsv = rgb2hsv(trailColor)
    const darkHsv = vec3(
      hsv.x, // Keep hue
      clamp(hsv.y.mul(1.2), 0, 1), // Boost saturation slightly
      hsv.z.mul(0.7) // Lower value by 30%
    )
    const darkColor = hsv2rgb(darkHsv)
    const color = mix(trailColor, darkColor, wave)

    // Edge softness (smoother in center of ribbon width)
    const centerDist = crossPos.sub(0.5).abs().mul(2) // 0 at center, 1 at edges
    const edgeFade = smoothstep(float(1), float(0.3), centerDist)

    material.colorNode = color
    material.opacityNode = edgeFade // Only edge fade, no band opacity fade

    // Output to MRT with upward normal - prevents AO from darkening trails
    material.mrtNode = mrt({
      output: output,
      normal: vec3(0, 1, 0)
    })

    return material
  }

  /**
   * Update animation
   */
  update(dt) {
    this.uTime.value += dt
  }

  /**
   * Clear all paths
   */
  clear() {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    this.meshes = []
    this.paths = []
  }

  /**
   * Dispose of resources
   */
  dispose() {
    this.clear()
  }
}
