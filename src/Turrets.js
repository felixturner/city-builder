import {
  Mesh,
  SphereGeometry,
  MeshStandardNodeMaterial,
  Vector2,
  Vector3,
  Color,
} from 'three/webgpu'
import { Sounds } from './lib/Sounds.js'

/**
 * Turrets - any visible Peg_Top tower (typeTop === 3) is a turret. It auto-fires
 * a small glowing sphere at the nearest creep in range; three hits destroy the
 * creep (Creeps.hit handles the explosion). Range scales with tower height.
 */
export class Turrets {
  static TURRET_TYPE = 3 // Peg_Top

  constructor(scene, city, creeps) {
    this.scene = scene
    this.city = city
    this.creeps = creeps

    this.projGeo = new SphereGeometry(0.2, 12, 8)
    this.projMat = new MeshStandardNodeMaterial({
      color: new Color(0xfff3c0),
      emissive: new Color(0xffd060),
      roughness: 0.3,
      metalness: 0,
    })

    this.projectiles = []
    this.cooldowns = new Map() // tower -> seconds until next shot

    this.fireCooldown = 0.7 // seconds between shots
    this.projectileSpeed = 50 // world units / sec
    this.hitRadius = 1.0 // sphere considered "on" the creep within this
    this.baseY = 0.8

    this._tc = new Vector2()
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

  /** Nearest live creep within `range` world-units of (x,z), or null. */
  nearestCreep(x, z, range) {
    let best = null
    let bestD = range * range
    for (const c of this.creeps.creeps) {
      const dx = c.mesh.position.x - x
      const dz = c.mesh.position.z - z
      const d = dx * dx + dz * dz
      if (d < bestD) { bestD = d; best = c }
    }
    return best
  }

  fire(tower) {
    const muzzle = new Vector3()
    this.turretMuzzle(tower, muzzle)
    // Range in cells equals the tower's height in floors.
    const range = tower.numFloors * this.city.cellUnit
    const target = this.nearestCreep(muzzle.x, muzzle.z, range)
    if (!target) return false

    const mesh = new Mesh(this.projGeo, this.projMat)
    mesh.position.copy(muzzle)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.projectiles.push({ mesh, target, life: 0 })
    Sounds.play('shoot', 1.0, 0.2, 0.5)
    return true
  }

  update(dt) {
    // Advance projectiles, resolve hits.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]
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

    if (this.creeps.creeps.length === 0) return

    // Fire turrets whose cooldown has elapsed.
    for (const tower of this.city.towers) {
      if (!tower.visible || tower.typeTop !== Turrets.TURRET_TYPE) continue
      let cd = (this.cooldowns.get(tower) ?? 0) - dt
      if (cd <= 0) {
        if (this.fire(tower)) cd = this.fireCooldown
        else cd = 0.15 // nothing in range; re-check soon
      }
      this.cooldowns.set(tower, cd)
    }
  }
}
