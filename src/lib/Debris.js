import * as CANNON from 'cannon-es'
import { Object3D, BoxGeometry, InstancedMesh, Color, DynamicDrawUsage, MeshPhysicalMaterial, Vector2, MathUtils } from 'three/webgpu'
import { Sounds } from './Sounds.js'

/**
 * Debris system - spawns physics-enabled brick particles on tower clicks
 * Uses cannon-es for physics, InstancedMesh for rendering
 */
export class Debris {
  static POOL_SIZE = 50 // Max debris particles at once
  static BRICK_SIZE = 0.3 // Size of each brick cube (0.3 cell)
  static LIFETIME = 2.0 // Seconds before fade out
  static FADE_DURATION = 0.5 // Fade out duration

  constructor(scene, materialParams) {
    this.scene = scene
    this.enabled = true

    // Physics world
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -30, 0) // Heavier gravity
    })
    this.world.defaultContactMaterial.restitution = 0.2
    this.world.defaultContactMaterial.friction = 0.6

    // Ground plane
    this.groundBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane()
    })
    this.groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
    this.world.addBody(this.groundBody)

    // Tower collision bodies (static) for nearby towers
    this.towerBodies = []

    // Debris pool
    this.pool = []
    this.activeCount = 0

    // Material matching tower material
    this.material = new MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: materialParams?.roughness ?? 0.8,
      metalness: materialParams?.metalness ?? 0.0,
      clearcoat: materialParams?.clearcoat ?? 0,
      clearcoatRoughness: materialParams?.clearcoatRoughness ?? 0,
      iridescence: materialParams?.iridescence ?? 0
    })

    // Three.js instanced mesh for rendering (square brick)
    const geometry = new BoxGeometry(Debris.BRICK_SIZE, Debris.BRICK_SIZE, Debris.BRICK_SIZE)
    this.mesh = new InstancedMesh(geometry, this.material, Debris.POOL_SIZE)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.count = Debris.POOL_SIZE
    scene.add(this.mesh)

    // Pre-compute hidden matrix for inactive particles
    const hiddenDummy = new Object3D()
    hiddenDummy.scale.set(0, 0, 0)
    hiddenDummy.updateMatrix()
    this.hiddenMatrix = hiddenDummy.matrix.clone()

    // Hide all instances initially
    for (let i = 0; i < Debris.POOL_SIZE; i++) {
      this.mesh.setMatrixAt(i, this.hiddenMatrix)
      this.mesh.setColorAt(i, new Color(0x888888))
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true

    // Initialize pool - create bodies lazily to avoid init overhead
    for (let i = 0; i < Debris.POOL_SIZE; i++) {
      this.pool.push({
        body: null, // Created lazily
        inWorld: false, // Track if body is in physics world
        active: false,
        age: 0,
        color: new Color(),
        dummy: new Object3D()
      })
    }

    // Reusable temp objects to avoid allocations
    this.tempVec2 = new Vector2()
    this.tempColor = new Color()
  }

  /**
   * Set up collision bodies for nearby towers
   * @param {Tower} clickedTower - The tower that was clicked (exclude from collisions)
   * @param {Tower[]} allTowers - All towers in the scene
   * @param {number} floorHeight - Height of each floor
   * @param {City} city - City instance for coordinate conversion
   * @param {number} radius - Radius to check for nearby towers
   */
  setupNearbyCollisions(clickedTower, allTowers, floorHeight, city, radius = 15) {
    // Remove old tower bodies
    for (const body of this.towerBodies) {
      this.world.removeBody(body)
    }
    this.towerBodies = []

    const clickedCenter = clickedTower.box.getCenter(this.tempVec2)
    const clickedCenterX = clickedCenter.x
    const clickedCenterY = clickedCenter.y
    // All roof types have the same height (0.25)
    const roofHeight = 0.25

    for (const tower of allTowers) {
      if (!tower.visible || tower === clickedTower) continue

      const center = tower.box.getCenter(this.tempVec2)
      const centerX = center.x
      const centerY = center.y
      const dx = centerX - clickedCenterX
      const dz = centerY - clickedCenterY
      const dist = Math.sqrt(dx * dx + dz * dz)

      if (dist > radius) continue

      const size = tower.box.getSize(this.tempVec2)
      const numFloors = Math.max(0, Math.floor(tower.height / floorHeight))
      // Include roof height in collision body
      const height = numFloors * floorHeight + roofHeight

      // Convert to world coordinates using city helper
      const world = city.gridToWorld(centerX, centerY)

      const body = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(size.x / 2, height / 2, size.y / 2)),
        position: new CANNON.Vec3(world.x, height / 2, world.z)
      })
      this.world.addBody(body)
      this.towerBodies.push(body)
    }
  }

  /**
   * Spawn debris at a position (called when floor is added)
   * @param {number} x - World X position (center)
   * @param {number} y - World Y position (height of new floor)
   * @param {number} z - World Z position (center)
   * @param {number} radius - Tower radius for spawning at perimeter
   * @param {Color} color - Color for debris (matches tower hover color)
   * @param {number} [numParticles] - Optional override for number of particles
   */
  spawn(x, y, z, radius, color, numParticles) {
    if (!this.enabled) return

    // Number of bricks based on tower size, or use override
    const count = numParticles ?? Math.floor(MathUtils.randFloat(radius, radius * 3)) + 2

    for (let i = 0; i < count; i++) {
      // Find inactive particle
      let particle = null
      for (const p of this.pool) {
        if (!p.active) {
          particle = p
          break
        }
      }

      // If pool is full, steal oldest
      if (!particle) {
        let oldest = this.pool[0]
        for (const p of this.pool) {
          if (p.age > oldest.age) oldest = p
        }
        particle = oldest
      }

      // Activate particle
      particle.active = true
      particle.age = 0
      particle.color.copy(color)

      // Create body lazily if needed
      if (!particle.body) {
        particle.body = new CANNON.Body({
          mass: 1.0, // Heavier so they don't float
          shape: new CANNON.Box(new CANNON.Vec3(
            Debris.BRICK_SIZE / 2,
            Debris.BRICK_SIZE / 2,
            Debris.BRICK_SIZE / 2
          )),
          linearDamping: 0.2,
          angularDamping: 0.4
        })
        // Play clink sound on collision, volume based on impact
        particle.body.addEventListener('collide', (event) => {
          const impact = Math.abs(event.contact.getImpactVelocityAlongNormal())
          if (impact > 3) {
            const volume = Math.min(0.15, impact * 0.01)
            Sounds.play('clink', 1.5, 0.4, volume)
          }
        })
      }

      // Add body to world if not already
      if (!particle.inWorld) {
        this.world.addBody(particle.body)
        particle.inWorld = true
      }

      // Each brick spawns at random angle around perimeter
      const angle = Math.random() * Math.PI * 2

      // Spawn at edge of tower (perimeter)
      const spawnX = x + Math.cos(angle) * radius
      const spawnZ = z + Math.sin(angle) * radius

      particle.body.position.set(
        spawnX + MathUtils.randFloatSpread(0.1),
        y + MathUtils.randFloat(2, 4),
        spawnZ + MathUtils.randFloatSpread(0.1)
      )

      // Shoot outward from spawn position (same direction as spoke angle)
      const hSpeed = MathUtils.randFloat(2, 4)
      const vx = Math.cos(angle) * hSpeed
      const vz = Math.sin(angle) * hSpeed

      particle.body.velocity.set(
        vx,
        MathUtils.randFloat(4, 8),
        vz
      )

      // Random spin (reduced)
      particle.body.angularVelocity.set(
        MathUtils.randFloatSpread(5),
        MathUtils.randFloatSpread(5),
        MathUtils.randFloatSpread(5)
      )

      particle.body.wakeUp()
      this.activeCount++
    }

    return count
  }

  /**
   * Update physics and rendering
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    if (this.activeCount === 0) return

    // Step physics
    this.world.step(1 / 60, dt, 3)

    // Update each particle
    let instanceIndex = 0
    for (const particle of this.pool) {
      if (!particle.active) {
        // Hide inactive using pre-computed matrix
        this.mesh.setMatrixAt(instanceIndex, this.hiddenMatrix)
        instanceIndex++
        continue
      }

      particle.age += dt

      // Check if should deactivate
      if (particle.age > Debris.LIFETIME + Debris.FADE_DURATION) {
        particle.active = false
        particle.body.sleep()
        this.activeCount--

        this.mesh.setMatrixAt(instanceIndex, this.hiddenMatrix)
        instanceIndex++
        continue
      }

      // Calculate fade
      let alpha = 1
      if (particle.age > Debris.LIFETIME) {
        alpha = 1 - (particle.age - Debris.LIFETIME) / Debris.FADE_DURATION
      }

      // Update transform from physics
      const pos = particle.body.position
      const quat = particle.body.quaternion

      particle.dummy.position.set(pos.x, pos.y, pos.z)
      particle.dummy.quaternion.set(quat.x, quat.y, quat.z, quat.w)
      particle.dummy.scale.setScalar(alpha) // Scale down as fade
      particle.dummy.updateMatrix()

      this.mesh.setMatrixAt(instanceIndex, particle.dummy.matrix)

      // Update color with alpha (darken as it fades) - reuse temp color
      this.tempColor.copy(particle.color).multiplyScalar(alpha)
      this.mesh.setColorAt(instanceIndex, this.tempColor)

      instanceIndex++
    }

    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /**
   * Dispose of resources
   */
  dispose() {
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()

    // Remove all bodies from world
    for (const particle of this.pool) {
      if (particle.body && this.world.bodies.includes(particle.body)) {
        this.world.removeBody(particle.body)
      }
    }
    for (const body of this.towerBodies) {
      this.world.removeBody(body)
    }
    this.world.removeBody(this.groundBody)
  }
}
