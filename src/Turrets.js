import {
  Mesh,
  SphereGeometry,
  CylinderGeometry,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
  Quaternion,
  Color,
  Group,
  Box3,
  Raycaster,
} from 'three/webgpu'
import { GLTFLoader } from 'three/examples/jsm/Addons.js'
import { Sounds } from './lib/Sounds.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { roofGeomIndex } from './blockTypes.js'
import { FX_NO_AO_LAYER } from './PostFX.js'

/**
 * Turrets - two kinds of auto-firing tower:
 *  - Peg_Top (typeTop 3): lobs a small glowing sphere at the nearest creep;
 *    several hits destroy it. Range scales with tower height.
 *  - Divot_Top (typeTop 4): a laser turret. Fires less often but hitscans for
 *    2 damage and flashes a quick colored beam from muzzle to creep. Each laser
 *    tower has its own random color (tower.laserColor, assigned by City).
 */
export class Turrets {
  static TURRET_TYPE = 3 // Peg_Top
  static LASER_TYPE = 4 // Divot_Top
  static MORTAR_TYPE = 7 // mortar (AoE)

  constructor(scene, city, creeps) {
    this.scene = scene
    this.city = city
    this.creeps = creeps

    this.projGeo = new SphereGeometry(0.4, 12, 8)
    this.projMat = new MeshStandardNodeMaterial({
      color: new Color(0xfff3c0),
      emissive: new Color(0xffd060),
      roughness: 0.3,
      metalness: 0,
    })

    this.projectiles = []
    this.cooldowns = new Map() // tower -> seconds until next shot

    this.fireCooldown = 0.35 // seconds between Peg shots
    this.projectileSpeed = 50 // world units / sec
    this.hitRadius = 1.0 // sphere considered "on" the creep within this
    this.baseY = 0.8

    // Laser turret config + a small pool of reusable beam cylinders.
    this.laserCooldown = 0.9 // fires less often than the peg turret
    this.laserDamage = 2
    this.beamDuration = 0.16 // seconds the beam flash lingers
    this.beamGeo = new CylinderGeometry(0.28, 0.28, 1, 8) // unit length along Y
    this.beams = []
    for (let i = 0; i < 8; i++) {
      const mat = new MeshBasicNodeMaterial({ transparent: true, opacity: 0, depthWrite: false })
      const mesh = new Mesh(this.beamGeo, mat)
      mesh.visible = false
      mesh.layers.set(FX_NO_AO_LAYER) // no ambient occlusion on beams
      this.scene.add(mesh)
      this.beams.push({ mesh, life: 0, active: false })
    }

    // Mortar turret: lobs an arcing shell that explodes in an AoE.
    this.mortarCooldown = 4.0 // slow fire
    this.mortarDamage = 8 // heavy
    this.mortarRadius = 4 // AoE radius
    this.mortarArc = 8 // peak lob height
    this.mortarDur = 0.6 // travel time (seconds) - shorter so it lands near moving creeps
    this.mortarGeo = new SphereGeometry(0.35, 12, 8)
    this.mortarMat = new MeshStandardNodeMaterial({
      color: new Color(0x808080), roughness: 0.6, metalness: 0.2,
    })
    this._explodeColor = new Color(0xff7a30)
    // Expanding transparent blast dome (sphere at y=0 -> only the top half shows).
    this.explosionGeo = new SphereGeometry(1, 16, 12)
    this.explosionRadius = this.mortarRadius // visual blast matches the AoE
    this.explosions = []

    // Turret models from turrets.glb: Cube.002 = peg (bullet), Cube.006 = laser,
    // Cube.008 = mortar.
    this.pegProto = null
    this.laserProto = null
    this.mortarProto = null
    this.turretModels = new Map() // tower -> placed model clone

    this._tc = new Vector2()
    this._q = new Quaternion()
    this._up = new Vector3(0, 1, 0)
    this._from = new Vector3()
    this._to = new Vector3()
    this._dir = new Vector3()
    this._white = new Color(0xffffff)
    this._losRay = new Raycaster() // line-of-sight raycasts vs the tower mesh
  }

  /** Load the turret models and build normalized prototypes to clone per tower. */
  async init() {
    const loader = new GLTFLoader()
    let gltf
    try {
      gltf = await loader.loadAsync('./assets/models/turrets.glb')
    } catch (e) {
      console.warn('Turret model load failed:', e)
      return
    }
    gltf.scene.updateMatrixWorld(true)
    this.pegProto = this.buildProto(gltf, 'Cube002')
    this.laserProto = this.buildProto(gltf, 'Cube006')
    this.mortarProto = this.buildProto(gltf, 'Cube008')
  }

  /**
   * Gather all sub-meshes of a GLB node (by sanitized name prefix) into one
   * normalized prototype Group: centered on XZ, base at y=0, footprint ~1 cell.
   * GLTFLoader strips dots from names, so 'Cube.002' is matched as 'Cube002'.
   */
  buildProto(gltf, prefix) {
    const parts = []
    gltf.scene.traverse((o) => {
      if (o.isMesh && o.name.replace(/[\s.]/g, '').startsWith(prefix)) parts.push(o)
    })
    if (parts.length === 0) {
      console.warn(`${prefix} meshes not found in turrets.glb`)
      return null
    }
    const inner = new Group()
    for (const p of parts) {
      if (!p.geometry.attributes.normal) p.geometry.computeVertexNormals()
      inner.attach(p)
    }
    const box = new Box3().setFromObject(inner)
    const size = new Vector3()
    const center = new Vector3()
    box.getSize(size)
    box.getCenter(center)
    inner.position.set(-center.x, -box.min.y, -center.z)

    const proto = new Group()
    proto.add(inner)
    const maxXZ = Math.max(size.x, size.z) || 1
    proto.scale.setScalar((this.city.cellUnit * 1.1) / maxXZ)
    proto.traverse((o) => { if (o.isMesh) o.castShadow = true })
    return proto
  }

  /** Place / aim a turret model on top of every visible turret tower. */
  updateTurretModels(dt) {
    if (!this.pegProto && !this.laserProto && !this.mortarProto) return
    const seen = new Set()
    for (const tower of this.city.towers) {
      if (!tower.visible) continue
      const isLaser = tower.typeTop === Turrets.LASER_TYPE
      const isPeg = tower.typeTop === Turrets.TURRET_TYPE
      const isMortar = tower.typeTop === Turrets.MORTAR_TYPE
      if (!isPeg && !isLaser && !isMortar) continue
      const proto = isMortar ? this.mortarProto : isLaser ? this.laserProto : this.pegProto
      if (!proto) continue
      seen.add(tower)

      let m = this.turretModels.get(tower)
      // Rebuild the clone if the tower's turret type changed (e.g. via reroll).
      if (m && m.userData.kind !== tower.typeTop) {
        this.scene.remove(m)
        m = null
      }
      if (!m) {
        m = proto.clone(true)
        m.userData.kind = tower.typeTop
        // Yaw-then-pitch order so the up/down tilt is applied in the yawed frame.
        m.rotation.order = 'YXZ'
        this.scene.add(m)
        this.turretModels.set(tower, m)
      }

      tower.box.getCenter(this._tc)
      const wx = this._tc.x + this.city.gridOffsetX
      const wz = this._tc.y + this.city.gridOffsetZ
      // Sit on top of the roof block. While the roof is animating (new-block
      // pop), follow its live center so the turret moves with it.
      const roofHalf = BlockGeometry.halfHeights[roofGeomIndex(tower.typeTop)]
      const roofTop = tower.roofAnimating
        ? tower.roofAnim.y + roofHalf
        : tower.numFloors * this.city.floorHeight + 2 * roofHalf
      m.position.set(wx, roofTop, wz)

      // Smoothly turn to face the nearest creep (yaw + pitch, shortest path).
      const target = this.nearestCreep(wx, wz, Infinity)
      if (target) {
        const tx = target.mesh.position.x - wx
        const tz = target.mesh.position.z - wz
        const ty = target.mesh.position.y - roofTop
        const yaw = Math.atan2(tx, tz)
        let diff = yaw - m.rotation.y
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)) // wrap to [-PI, PI]
        m.rotation.y += diff * Math.min(1, dt * 8) // ease toward target
        // Pitch down toward the creep on the ground (barrel aims along +Z).
        const horiz = Math.hypot(tx, tz)
        const pitch = Math.atan2(-ty, horiz)
        m.rotation.x += (pitch - m.rotation.x) * Math.min(1, dt * 8)
      }
      m.visible = true
    }
    for (const [t, m] of this.turretModels) if (!seen.has(t)) m.visible = false
  }

  /** World x/z/top-y of a turret tower. */
  turretMuzzle(tower, out) {
    tower.box.getCenter(this._tc)
    out.set(
      this._tc.x + this.city.gridOffsetX,
      tower.numFloors * this.city.floorHeight + this.city.floorHeight,
      this._tc.y + this.city.gridOffsetZ
    )
    return out
  }

  /** Nearest live creep within `range` world-units of (x,z), or null. When a
   *  `losMuzzle` (Vector3) is given, ground creeps must have clear line-of-sight
   *  from it (flying bombers ignore LOS). */
  nearestCreep(x, z, range, losMuzzle = null) {
    let best = null
    let bestD = range * range
    for (const c of this.creeps.creeps) {
      const dx = c.mesh.position.x - x
      const dz = c.mesh.position.z - z
      const d = dx * dx + dz * dz
      if (d >= bestD) continue
      if (losMuzzle && c.state !== 'fly' && !this.hasLOS(losMuzzle, c.mesh.position)) continue
      bestD = d
      best = c
    }
    return best
  }

  /** True if a clear 3D line runs from `from` to `to` - i.e. no tower mesh is
   *  between them (raycast against the tower BatchedMesh). */
  hasLOS(from, to) {
    const mesh = this.city.towerMesh
    if (!mesh) return true
    this._dir.copy(to).sub(from)
    const dist = this._dir.length()
    const margin = this.city.cellUnit * 0.7 // skip the firing tower / the target's cell
    if (dist <= margin * 2) return true
    this._dir.divideScalar(dist)
    this._losRay.set(from, this._dir)
    this._losRay.near = margin
    this._losRay.far = dist - margin
    return this._losRay.intersectObject(mesh, false).length === 0
  }

  /** Projectile material tinted to a turret's accent color (cached per color). */
  projMatFor(ci) {
    if (!this._projMats) this._projMats = new Map()
    let m = this._projMats.get(ci)
    if (!m) {
      const col = this.city.accentColors[ci]
      m = new MeshStandardNodeMaterial({
        color: col.clone(),
        emissive: col.clone().multiplyScalar(0.5),
        roughness: 0.3,
        metalness: 0,
      })
      this._projMats.set(ci, m)
    }
    return m
  }

  fire(tower) {
    const muzzle = new Vector3()
    this.turretMuzzle(tower, muzzle)
    // Range in cells equals the tower's height in floors.
    const range = (tower.numFloors + 1) * this.city.cellUnit
    const target = this.nearestCreep(muzzle.x, muzzle.z, range, muzzle)
    if (!target) return false

    const mesh = new Mesh(this.projGeo, this.projMatFor(tower.colorIndex))
    mesh.position.copy(muzzle)
    mesh.castShadow = true
    mesh.layers.set(FX_NO_AO_LAYER) // no ambient occlusion on projectiles
    this.scene.add(mesh)
    this.projectiles.push({ mesh, target, life: 0 })
    Sounds.play('shoot', 1.0, 0.2, 0.5)
    return true
  }

  /** Laser turret: hitscan the nearest creep for 2 damage + flash a beam. */
  fireLaser(tower) {
    const muzzle = this._from
    this.turretMuzzle(tower, muzzle)
    const range = (tower.numFloors + 1) * this.city.cellUnit
    const target = this.nearestCreep(muzzle.x, muzzle.z, range, muzzle)
    if (!target) return false

    this._to.copy(target.mesh.position)
    this.spawnBeam(muzzle, this._to, tower.laserColor || this._white)
    this.creeps.hit(target, this.laserDamage)
    Sounds.play('shoot', 0.65, 0.2, 0.5)
    return true
  }

  /** Light up a pooled beam cylinder stretched from `from` to `to`. */
  spawnBeam(from, to, color) {
    const b = this.beams.find(x => !x.active) || this.beams[0]
    b.active = true
    b.life = 0
    const m = b.mesh
    m.material.color.copy(color)
    m.material.opacity = 1
    m.visible = true

    this._dir.copy(to).sub(from)
    const len = this._dir.length() || 0.001
    m.position.copy(from).addScaledVector(this._dir, 0.5)
    this._dir.divideScalar(len)
    this._q.setFromUnitVectors(this._up, this._dir)
    m.quaternion.copy(this._q)
    m.scale.set(1, len, 1)
  }

  update(dt) {
    // Fade out / retire active beam flashes.
    for (const b of this.beams) {
      if (!b.active) continue
      b.life += dt
      if (b.life >= this.beamDuration) {
        b.active = false
        b.mesh.visible = false
      } else {
        b.mesh.material.opacity = 1 - b.life / this.beamDuration
      }
    }

    // Blast domes: pop scale to max fast (~0.12s ease-out), fade over ~0.45s.
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i]
      e.life += dt
      const dur = 0.45
      const f = e.life / dur
      const popF = Math.min(1, e.life / 0.12)
      const scale = this.explosionRadius * (1 - (1 - popF) * (1 - popF)) // ease-out to max
      e.mesh.scale.setScalar(Math.max(0.001, scale))
      e.mat.opacity = Math.max(0, 1 - f) * 0.6
      if (f >= 1) {
        this.scene.remove(e.mesh)
        e.mat.dispose()
        this.explosions.splice(i, 1)
      }
    }

    // Advance projectiles, resolve hits.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]

      // Mortar shells arc to a fixed point and explode (AoE) on landing.
      if (p.mortar) {
        p.t += dt
        const f = Math.min(1, p.t / p.dur)
        const x = p.start.x + (p.end.x - p.start.x) * f
        const z = p.start.z + (p.end.z - p.start.z) * f
        const baseY = p.start.y + (p.end.y - p.start.y) * f
        p.mesh.position.set(x, baseY + Math.sin(Math.PI * f) * this.mortarArc, z)
        if (f >= 1) {
          this.mortarExplode(p.end.x, p.end.z)
          this.scene.remove(p.mesh)
          this.projectiles.splice(i, 1)
        }
        continue
      }

      p.life += dt

      // Target gone or projectile too old: drop it.
      if (p.life > 2 || !this.creeps.isAlive(p.target)) {
        this.scene.remove(p.mesh)
        this.projectiles.splice(i, 1)
        continue
      }

      const tp = p.target.mesh.position
      const dx = tp.x - p.mesh.position.x
      const dy = tp.y - p.mesh.position.y
      const dz = tp.z - p.mesh.position.z
      const dist = Math.hypot(dx, dy, dz) || 1
      const step = this.projectileSpeed * dt

      if (dist <= this.hitRadius + step) {
        // Reached the creep: land a hit and consume the projectile.
        this.creeps.hit(p.target)
        this.scene.remove(p.mesh)
        this.projectiles.splice(i, 1)
        continue
      }

      p.mesh.position.x += (dx / dist) * step
      p.mesh.position.y += (dy / dist) * step
      p.mesh.position.z += (dz / dist) * step
    }

    // Keep the turret models seated on their towers (runs even with no creeps).
    this.updateTurretModels(dt)

    if (this.creeps.creeps.length === 0) return

    // Fire turrets whose cooldown has elapsed.
    for (const tower of this.city.towers) {
      if (!tower.visible) continue
      const isPeg = tower.typeTop === Turrets.TURRET_TYPE
      const isLaser = tower.typeTop === Turrets.LASER_TYPE
      const isMortar = tower.typeTop === Turrets.MORTAR_TYPE
      if (!isPeg && !isLaser && !isMortar) continue

      let cd = (this.cooldowns.get(tower) ?? 0) - dt
      if (cd <= 0) {
        const fired = isMortar ? this.fireMortar(tower) : isLaser ? this.fireLaser(tower) : this.fire(tower)
        if (fired) cd = isMortar ? this.mortarCooldown : isLaser ? this.laserCooldown : this.fireCooldown
        else cd = 0.15 // nothing in range; re-check soon
      }
      this.cooldowns.set(tower, cd)
    }
  }

  /** Mortar turret: lob an arcing shell at the nearest creep (ignores LOS - it
   *  arcs over walls); it explodes in an AoE on landing. */
  fireMortar(tower) {
    const muzzle = this._from
    this.turretMuzzle(tower, muzzle)
    const range = (tower.numFloors + 1) * this.city.cellUnit
    const target = this.nearestCreep(muzzle.x, muzzle.z, range) // no LOS: arcs over
    if (!target) return false

    const mesh = new Mesh(this.mortarGeo, this.mortarMat)
    mesh.position.copy(muzzle)
    mesh.castShadow = true
    mesh.layers.set(FX_NO_AO_LAYER) // no ambient occlusion on the shell
    this.scene.add(mesh)
    const end = new Vector3(target.mesh.position.x, 0.4, target.mesh.position.z)
    this.projectiles.push({ mesh, mortar: true, start: muzzle.clone(), end, t: 0, dur: this.mortarDur })
    Sounds.play('mortar-shoot', 1.0, 0.15, 0.6)
    return true
  }

  /** AoE blast: damage every ground creep within `mortarRadius` of (x,z), and
   *  pop an expanding transparent dome. */
  mortarExplode(x, z) {
    const r2 = this.mortarRadius * this.mortarRadius
    for (const c of this.creeps.creeps) {
      if (c.state === 'fly') continue // bombers are at altitude
      const dx = c.mesh.position.x - x, dz = c.mesh.position.z - z
      if (dx * dx + dz * dz <= r2) this.creeps.hit(c, this.mortarDamage)
    }
    // Blast dome: sphere centered at ground (y=0) so only the top half shows;
    // pops its scale up fast then fades out (animated in update()).
    const mat = new MeshBasicNodeMaterial({
      color: this._explodeColor.clone(), transparent: true, opacity: 0.6, depthWrite: false,
    })
    const mesh = new Mesh(this.explosionGeo, mat)
    mesh.position.set(x, 0, z)
    mesh.scale.setScalar(0.001)
    mesh.layers.set(FX_NO_AO_LAYER)
    this.scene.add(mesh)
    this.explosions.push({ mesh, mat, life: 0 })
    Sounds.play('mortar-hit', 1.0, 0.15, 0.7)
  }
}
