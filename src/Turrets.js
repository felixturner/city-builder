import {
  Mesh,
  SphereGeometry,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
  Color,
  Group,
  Box3,
  Raycaster,
} from 'three/webgpu'
import { GLTFLoader } from 'three/examples/jsm/Addons.js'
import { Sounds } from './lib/Sounds.js'
import { Creeps } from './Creeps.js'
import { Buffs } from './buffs.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { roofGeomIndex } from './blockTypes.js'
import { fxMaterial, NO_AO_MRT, glow } from './fx.js'
import { BeamPool } from './lib/BeamPool.js'

// Write a fake "up" normal to the MRT so GTAO treats the FX as flat and barely
// darkens them - keeps beams/projectiles/explosions AO-free while staying in the
// main scene (so they depth-sort against blocks). Same trick the trails/floor use.
const NO_AO = NO_AO_MRT

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

  /**
   * Ammo each shot costs. Turrets fire from the ammo pool, not the energy pool -
   * energy builds the city, ammo defends it, and they refill from completely
   * different places.
   *
   * Balanced against the drop rate: a dying creep leaves an ammo box 20% of the
   * time worth 5, so kills pay for themselves at ~1.0 ammo each on average. A
   * normal creep has 4 HP, so the costs below make a clean kill cost about 1.0
   * whichever gun does it:
   *   peg     1 dmg x 4 shots x 0.25 = 1.0
   *   laser   2 dmg x 2 shots x 0.5  = 1.0
   *   mortar  8 dmg, one shot        = 1.0, and better than break-even whenever
   *                                    the blast catches more than one creep
   * Big creeps (2x HP) and giants (10x) cost proportionally more than they drop,
   * so the pressure builds exactly where it should.
   */
  static SHOT_COST = { peg: 0.25, laser: 0.5, mortar: 1.0 }

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
    this.projMat.mrtNode = NO_AO()

    this.projectiles = []
    this.cooldowns = new Map() // tower -> seconds until next shot

    this.fireCooldown = 0.35 // seconds between Peg shots
    this.projectileSpeed = 100 // world units / sec
    this.hitRadius = 1.0 // sphere considered "on" the creep within this
    this.baseY = 0.8

    // Laser turret config + a small pool of reusable beam cylinders.
    this.laserCooldown = 0.9 // fires less often than the peg turret
    this.laserDamage = 2
    this.beamPool = new BeamPool(scene, { radius: 0.28, duration: 0.16 })

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
    this.mortarMat.mrtNode = NO_AO()
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
      // turrets.glb ships the 'Blosm' material with an emissive factor of
      // (1, 0.74, 0). That was harmless before, but with bloom in the pipeline
      // every turret on the board flares. Only the loot crate is meant to glow.
      for (const mat of Array.isArray(p.material) ? p.material : [p.material]) {
        if (mat && mat.emissive) mat.emissive.setScalar(0)
      }
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
      if (this.city.upkeep.isDark(tower)) continue // browned out: no power, no shots
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
      // Distance to the creep's EDGE, so a giant whose body is inside the range
      // ring but whose centre isn't is still a valid target.
      const d = Math.max(0, Math.hypot(dx, dz) - Creeps.radiusOf(c)) ** 2
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
      m.mrtNode = NO_AO()
      this._projMats.set(ci, m)
    }
    return m
  }

  /** Try to pay a shot's ammo. Returns false when the magazine is empty. */
  payForShot(kind) {
    const city = this.city
    if (city.freeClicks || !city.mana) return true
    if (city.mana.spendAmmo(Turrets.SHOT_COST[kind])) return true
    this.dryFire()
    return false
  }

  /** Turrets going quiet because you're out of ammo is otherwise invisible -
   *  give it a dry click, throttled so a field of dry turrets doesn't rattle. */
  dryFire() {
    const now = performance.now() / 1000
    if (this._lastDry !== undefined && now - this._lastDry < 1.5) return
    this._lastDry = now
    Sounds.play('dink', 0.5, 0.05, 0.35)
  }

  fire(tower) {
    const muzzle = new Vector3()
    this.turretMuzzle(tower, muzzle)
    // Range in cells equals the tower's height in floors.
    const range = (tower.numFloors * 2 + 1) * this.city.cellUnit
    const target = this.nearestCreep(muzzle.x, muzzle.z, range, muzzle)
    if (!target) return false
    if (!this.payForShot('peg')) return false

    const mesh = new Mesh(this.projGeo, this.projMatFor(tower.colorIndex))
    mesh.position.copy(muzzle)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.projectiles.push({ mesh, target, life: 0 })
    Sounds.play('shoot', 1.0, 0.2, 0.34)
    return true
  }

  /** Laser turret: hitscan the nearest creep for 2 damage + flash a beam. */
  fireLaser(tower) {
    const muzzle = this._from
    this.turretMuzzle(tower, muzzle)
    const range = (tower.numFloors * 2 + 1) * this.city.cellUnit
    const target = this.nearestCreep(muzzle.x, muzzle.z, range, muzzle)
    if (!target) return false
    if (!this.payForShot('laser')) return false

    this._to.copy(target.mesh.position)
    this.beamPool.fire(muzzle, this._to, tower.laserColor || this._white)
    this.creeps.hit(target, this.laserDamage + Buffs.shotDamage.laser)
    Sounds.play('shoot', 0.65, 0.2, 0.34)
    return true
  }

  update(dt) {
    this.beamPool.update(dt)

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

      // Hit against the creep's BODY, not a fixed radius around its centre. A
      // giant is 3 world units across; with a flat 1.0 the shell had to reach
      // 2 units INSIDE the model before it registered, so shots visibly passed
      // through bosses. Giants shrink as they take damage, so this tightens
      // with them.
      const hitR = Math.max(this.hitRadius, Creeps.radiusOf(p.target))
      if (dist <= hitR + step) {
        // Reached the creep: land a hit and consume the projectile.
        this.creeps.hit(p.target, 1 + Buffs.shotDamage.peg)
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
        if (fired) {
          const base = isMortar ? this.mortarCooldown : isLaser ? this.laserCooldown : this.fireCooldown
          // No support tower reaching this turret => half rate, i.e. double the
          // gap between shots. support() is 1 or SUPPORT_PENALTY and doesn't
          // stack, so a second support tower changes nothing.
          cd = base * Buffs.fireRate / this.city.energy.support(tower)
        } else cd = 0.15 // nothing in range or out of energy; re-check soon
      }
      this.cooldowns.set(tower, cd)
    }
  }

  /** Mortar turret: lob an arcing shell at the nearest creep (ignores LOS - it
   *  arcs over walls); it explodes in an AoE on landing. */
  fireMortar(tower) {
    const muzzle = this._from
    this.turretMuzzle(tower, muzzle)
    const range = (tower.numFloors * 2 + 1) * this.city.cellUnit
    const target = this.nearestCreep(muzzle.x, muzzle.z, range) // no LOS: arcs over
    if (!target) return false
    if (!this.payForShot('mortar')) return false

    const mesh = new Mesh(this.mortarGeo, this.mortarMat)
    mesh.position.copy(muzzle)
    mesh.castShadow = true
    this.scene.add(mesh)
    const end = new Vector3(target.mesh.position.x, 0.4, target.mesh.position.z)
    this.projectiles.push({ mesh, mortar: true, start: muzzle.clone(), end, t: 0, dur: this.mortarDur })
    Sounds.play('mortar-shoot', 1.0, 0.15, 0.4)
    return true
  }

  /** AoE blast: damage every ground creep within `mortarRadius` of (x,z), and
   *  pop an expanding transparent dome. */
  mortarExplode(x, z) {
    const r2 = this.mortarRadius * this.mortarRadius
    for (const c of this.creeps.creeps) {
      if (c.state === 'fly') continue // bombers are at altitude
      const dx = c.mesh.position.x - x, dz = c.mesh.position.z - z
      // Same for the blast: measure to the creep's edge, so a shell landing
      // beside a giant still catches it.
      const rr = this.mortarRadius + Creeps.radiusOf(c)
      if (dx * dx + dz * dz <= rr * rr) this.creeps.hit(c, this.mortarDamage + Buffs.shotDamage.mortar)
    }
    // Blast dome: sphere centered at ground (y=0) so only the top half shows;
    // pops its scale up fast then fades out (animated in update()).
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: this._explodeColor.clone(), opacity: 0.6,
    }))
    const mesh = glow(new Mesh(this.explosionGeo, mat))
    mesh.position.set(x, 0, z)
    mesh.scale.setScalar(0.001)
    this.scene.add(mesh)
    this.explosions.push({ mesh, mat, life: 0 })
    Sounds.play('mortar-hit', 1.0, 0.15, 0.47)
  }
}
