import {
  Mesh,
  BoxGeometry,
  MeshStandardNodeMaterial,
  Vector2,
  Color,
} from 'three/webgpu'
import { Sounds } from './lib/Sounds.js'

/**
 * Creeps - abstract enemy nodes. Black diamonds (cubes rotated 45deg off the
 * grid so they read as "wrong") that spawn at the map edge and march toward
 * the city one grid cell at a time. They home in on the TALLEST tower, and
 * when they reach one they stop and knock it: every 3 knocks drops it a floor,
 * then the creep vanishes. Spawn frequency ramps up after a grace period.
 */
export class Creeps {
  constructor(scene, city) {
    this.scene = scene
    this.city = city
    this.creeps = []

    this.geo = new BoxGeometry(2, 2, 2)
    this.mat = new MeshStandardNodeMaterial({
      color: new Color(0x0a0a0e),
      roughness: 0.55,
      metalness: 0,
    })
    // Shooter creeps read deep orange so they're distinguishable from marchers.
    this.shooterMat = new MeshStandardNodeMaterial({
      color: new Color(0xd2531e),
      roughness: 0.5,
      metalness: 0,
    })
    // Little blocks shooters lob at towers.
    this.shotGeo = new BoxGeometry(0.55, 0.55, 0.55)
    this.shotMat = new MeshStandardNodeMaterial({
      color: new Color(0xff5a3c),
      emissive: new Color(0x822010),
      roughness: 0.4,
      metalness: 0,
    })
    this.shots = []

    // Bomber creeps: fly across the map at altitude and drop bombs.
    this.bomberMat = new MeshStandardNodeMaterial({
      color: new Color(0x7d2fb0),
      emissive: new Color(0x2a0d44),
      roughness: 0.5,
      metalness: 0,
    })
    // Bombs they drop (fall straight down, damage the tower they land on).
    this.bombGeo = new BoxGeometry(0.7, 0.7, 0.7)
    this.bombMat = new MeshStandardNodeMaterial({
      color: new Color(0x141018),
      emissive: new Color(0x6a1f8c),
      roughness: 0.4,
      metalness: 0,
    })
    this.bombs = []

    this.cell = city.cellUnit // grid step size (world units)
    this.baseY = 0.8

    // Held until the player presses Start (see start()); no creeps before then.
    this.started = false
    // Toggle for new spawns (GUI). Existing creeps keep moving when off.
    this.spawnEnabled = true

    // Spawn pacing: grace period, then interval ramps from slow -> fast.
    this.elapsed = 0
    this.graceTime = 30 // first wave starts ~30s in (build-up grace period)
    this.spawnTimer = 0
    this.startInterval = 2 // seconds between spawns right after grace
    this.minInterval = 0.3 // fastest spawn cadence late game
    this.rampDuration = 240 // seconds to ramp from start -> min

    // Waves: spawn for waveActive secs, then wait until the next wavePeriod.
    this.wavePeriod = 40 // 20s spawn + 20s wait
    this.waveActive = 20 // seconds each wave spawns for
    this.bigChance = 0.1 // fraction of creeps that are big (once they unlock)
    this.bigUnlockTime = 90 // no big creeps until this many seconds in

    // Shooter creeps: stop at range and lob little blocks at towers.
    this.shooterChance = 0.1 // fraction of creeps that are shooters
    this.shooterUnlockTime = 150 // grace + 3 wave cycles; shooters from wave 4

    // Bomber creeps: fly across the map at altitude and carpet-drop bombs.
    this.bomberChance = 0.1 // fraction of creeps that fly in as bombers
    this.bomberUnlockTime = 120 // no bombers until this many seconds in
    this.bomberY = 14 // flight altitude (world units)
    this.flySpeed = 16 // horizontal flight speed (world units/sec)
    this.bombInterval = 1.3 // seconds between bomb drops
    this.bombGravity = 32 // bomb fall acceleration (world units/sec^2)
    this.shootRange = 5 * this.city.cellUnit // 5 cells, world units
    this.shootInterval = 2.8 // seconds between shots
    this.shotSpeed = 28 // shot travel speed (world units/sec)

    this.stepDuration = 0.30 // seconds to move one cell
    this.hopHeight = 0.6
    this.reach = 49 // ~half the map (7 lots * 14 / 2)

    this.knockInterval = 0.45 // seconds between knocks
    this.knocksPerFloor = 3
    this.hitsToKill = 4 // turret sphere hits needed to destroy a creep

    this._p = new Vector2()
    this._sv = new Vector2()
    this._black = new Color(0x080808)
  }

  /** Current seconds-between-spawns, ramping down after the grace period. */
  get spawnInterval() {
    const since = Math.max(0, this.elapsed - this.graceTime)
    // Quadratic ease-in: stays slow early, ramps up gradually toward the min.
    const t = Math.min(1, since / this.rampDuration)
    const k = t * t
    return this.startInterval + (this.minInterval - this.startInterval) * k
  }

  /** How many creeps to spawn per tick - grows slowly over time (caps at 3). */
  get spawnBurst() {
    return Math.min(3, 1 + Math.floor(this.elapsed / 150))
  }

  snap(v) {
    return Math.round(v / this.cell) * this.cell
  }

  spawn() {
    // Some creeps are "big": 2x size, 2x HP, knock 2 floors per kill. They only
    // start appearing later in the run, and stay rare.
    const big = this.elapsed >= this.bigUnlockTime && Math.random() < this.bigChance
    // Shooters (not big) stop at range and lob little blocks at towers.
    const shooter = !big && this.elapsed >= this.shooterUnlockTime && Math.random() < this.shooterChance
    // Bombers (not big/shooter) fly across at altitude and drop bombs.
    const bomber = !big && !shooter && this.elapsed >= this.bomberUnlockTime && Math.random() < this.bomberChance
    if (bomber) { this.spawnBomber(); return }
    const scale = big ? 1.4 : 0.7
    const baseY = big ? 1.5 : 0.8

    const mesh = new Mesh(this.geo, shooter ? this.shooterMat : this.mat)
    mesh.castShadow = true
    mesh.scale.setScalar(scale)
    mesh.rotation.y = Math.PI / 4 // diamond footprint, off-grid

    // Pick a random point along one of the four map edges, snapped to the grid.
    const r = this.reach
    const t = this.snap((Math.random() * 2 - 1) * r)
    const edge = Math.floor(Math.random() * 4)
    let x, z
    if (edge === 0) { x = -r; z = t }
    else if (edge === 1) { x = r; z = t }
    else if (edge === 2) { x = t; z = -r }
    else { x = t; z = r }
    x = this.snap(x)
    z = this.snap(z)

    mesh.position.set(x, baseY, z)
    this.scene.add(mesh)
    Sounds.play('spawn', big ? 0.7 : 1.0, 0.15, big ? 0.25 : 0.15)

    this.creeps.push({
      mesh,
      fromX: x, fromZ: z,
      toX: x, toZ: z,
      t: 1, // 1 = idle, ready to pick next step
      state: 'march',
      target: null,
      knocks: 0,
      attackTimer: 0,
      hits: 0, // turret sphere hits taken
      big,
      shooter,
      shootTimer: 0,
      baseY,
      maxHits: big ? this.hitsToKill * 2 : this.hitsToKill,
      knockFloors: big ? 2 : 1,
    })
  }

  /** Spawn a bomber: enters from one edge, flies straight across at altitude. */
  spawnBomber() {
    const r = this.reach
    const mesh = new Mesh(this.geo, this.bomberMat)
    mesh.castShadow = true
    mesh.scale.setScalar(1.0)

    // Fly along one axis, crossing the map. The cross-axis offset stays within
    // the center lot (world origin) so the path always passes over the middle.
    const off = this.snap((Math.random() * 2 - 1) * this.city.lotSize * 0.4)
    const alongX = Math.random() < 0.5
    const dir = Math.random() < 0.5 ? 1 : -1
    let x, z, vx = 0, vz = 0
    if (alongX) { x = -dir * r; z = off; vx = dir * this.flySpeed }
    else { x = off; z = -dir * r; vz = dir * this.flySpeed }

    mesh.position.set(x, this.bomberY, z)
    mesh.rotation.set(Math.PI / 4, alongX ? 0 : Math.PI / 2, Math.PI / 4)
    this.scene.add(mesh)
    Sounds.play('spawn', 0.55, 0.15, 0.3)

    this.creeps.push({
      mesh,
      fromX: x, fromZ: z, toX: x, toZ: z,
      t: 1,
      state: 'fly',
      target: null,
      knocks: 0,
      attackTimer: 0,
      hits: 0,
      big: false,
      shooter: false,
      bomber: true,
      vx, vz,
      bombTimer: this.bombInterval * 0.5,
      bob: Math.random() * Math.PI * 2,
      shootTimer: 0,
      baseY: this.bomberY,
      maxHits: this.hitsToKill,
      knockFloors: 1,
    })
  }

  /** Bomber releases a bomb that falls straight down from its position. */
  dropBomb(c) {
    const mesh = new Mesh(this.bombGeo, this.bombMat)
    mesh.castShadow = true
    mesh.position.set(c.mesh.position.x, c.mesh.position.y - 1, c.mesh.position.z)
    mesh.rotation.set(Math.PI / 4, 0, Math.PI / 4)
    this.scene.add(mesh)
    this.bombs.push({ mesh, x: mesh.position.x, z: mesh.position.z, y: mesh.position.y, vy: 0 })
    Sounds.play('shoot', 0.4, 0.2, 0.4)
  }

  /** Advance falling bombs; on landing, damage the tower at the impact cell. */
  updateBombs(dt) {
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i]
      b.vy -= this.bombGravity * dt
      b.y += b.vy * dt
      b.mesh.position.y = b.y
      b.mesh.rotation.x += dt * 8
      b.mesh.rotation.z += dt * 6
      if (b.y <= 0.4) {
        const tower = this.towerAt(b.x, b.z)
        if (tower) this.city.renderer.damageTower(tower)
        const debris = this.city.debris
        if (debris) debris.spawn(b.x, 0.5, b.z, 0.9, this._black, 10)
        Sounds.play('break2', 0.9, 0.2)
        this.scene.remove(b.mesh)
        this.bombs.splice(i, 1)
      }
    }
  }

  /** Visible tower whose footprint contains the world point (x,z), or null. */
  towerAt(wx, wz) {
    this._p.set(wx - this.city.gridOffsetX, wz - this.city.gridOffsetZ)
    for (const t of this.city.towers) {
      if (!t.visible) continue
      if (t.box.containsPoint(this._p)) return t
    }
    return null
  }

  /** World position of a tower's footprint center. */
  towerWorld(tower, out) {
    tower.box.getCenter(out)
    out.x += this.city.gridOffsetX
    out.y += this.city.gridOffsetZ // Vector2.y == world z
    return out
  }

  /** Index of the power-line under (x,z), or -1 if none. */
  onPowerLine(x, z) {
    const trails = this.city.trails
    if (!trails || !trails.paths) return -1
    const hit = this.cell * 0.6 // contact radius
    const hit2 = hit * hit
    for (let p = 0; p < trails.paths.length; p++) {
      const path = trails.paths[p]
      for (let i = 0; i < path.length - 1; i++) {
        if (this.distToSeg2(x, z, path[i], path[i + 1]) <= hit2) return p
      }
    }
    return -1
  }

  /** Squared XZ distance from a point to a segment (path points are {x,z}). */
  distToSeg2(px, pz, a, b) {
    const ax = a.x, az = a.z
    const bx = b.x, bz = b.z
    const dx = bx - ax, dz = bz - az
    const lenSq = dx * dx + dz * dz
    let t = lenSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0
    t = Math.max(0, Math.min(1, t))
    const cx = ax + t * dx, cz = az + t * dz
    const ex = px - cx, ez = pz - cz
    return ex * ex + ez * ez
  }

  /** Distance (world units) from a world point to a tower's footprint edge. */
  towerDist(tower, wx, wz) {
    this._p.set(wx - this.city.gridOffsetX, wz - this.city.gridOffsetZ)
    return tower.box.distanceToPoint(this._p)
  }

  /** Pick the tallest standing tower, lightly biased toward nearby ones. */
  acquireTarget(c) {
    let best = null
    let bestScore = -Infinity
    const tw = new Vector2()
    for (const tower of this.city.towers) {
      if (!tower.visible) continue
      this.towerWorld(tower, tw)
      const dx = tw.x - c.toX
      const dz = tw.y - c.toZ
      const distCells = Math.sqrt(dx * dx + dz * dz) / this.cell
      // Nearest-tall: tall towers are alluring, but distance matters a lot, so
      // a tall tower right in front beats a taller one across the map. This lets
      // the player build "walls" that intercept creeps locally.
      const score = tower.numFloors / (distCells + 1)
      if (score > bestScore) { bestScore = score; best = tower }
    }
    c.target = best
    return best
  }

  /**
   * Plan the next cell to step toward the current target (one axis at a time).
   * Returns 'move' (stepping), 'attack' (blocked by a tower), or 'done'.
   */
  planStep(c) {
    let target = c.target
    if (!target || !target.visible) {
      target = this.acquireTarget(c)
    }

    // No towers left to hit: trickle toward the core, despawn at center.
    let goalX = 0
    let goalZ = 0
    if (target) {
      const tw = new Vector2()
      this.towerWorld(target, tw)
      goalX = tw.x
      goalZ = tw.y
    }

    const x = c.toX
    const z = c.toZ
    const dx = goalX - x
    const dz = goalZ - z

    if (Math.abs(dx) < this.cell && Math.abs(dz) < this.cell) {
      return target ? 'attack' : 'done'
    }

    // Step along whichever axis is further from the goal (ties -> x).
    let stepX = 0
    let stepZ = 0
    if (Math.abs(dx) >= Math.abs(dz)) stepX = Math.sign(dx) * this.cell
    else stepZ = Math.sign(dz) * this.cell

    const nx = x + stepX
    const nz = z + stepZ

    // If the next cell is occupied by a standing tower, attack it instead.
    for (const tower of this.city.towers) {
      if (!tower.visible) continue
      if (this.towerDist(tower, nx, nz) < this.cell * 0.5) {
        c.target = tower
        return 'attack'
      }
    }

    c.fromX = x
    c.fromZ = z
    c.toX = nx
    c.toZ = nz
    c.t = 0
    return 'move'
  }

  /** Apply turret damage; explode + remove the creep once it reaches max HP. */
  hit(creep, dmg = 1) {
    creep.hits += dmg
    // Random stone thunk on every hit (slight pitch variation for variety).
    Sounds.play('stone', 0.9 + Math.random() * 0.3, 0.2, 0.6)
    // Float a "-N" damage caption above the creep.
    const ft = this.city.floatingText
    if (ft) {
      const p = creep.mesh.position
      ft.spawn(p.x, p.y + 1.5, p.z, `-${dmg}`, '#ff5a5a')
    }
    if (creep.hits < creep.maxHits) {
      return false
    }
    const i = this.creeps.indexOf(creep)
    if (i !== -1) {
      this.explode(creep)
      this.scene.remove(creep.mesh)
      this.creeps.splice(i, 1)
      Sounds.play('hit', 1.0, 0.2, 0.6)
    }
    return true
  }

  /** Whether a creep is still alive (present in the active list). */
  isAlive(creep) {
    return this.creeps.indexOf(creep) !== -1
  }

  /** Shooter lobs a little block toward a tower. */
  fireShot(c, target) {
    const mesh = new Mesh(this.shotGeo, this.shotMat)
    mesh.position.set(c.mesh.position.x, c.baseY + 0.6, c.mesh.position.z)
    this.scene.add(mesh)
    this.shots.push({ mesh, target, life: 0 })
    Sounds.play('shoot', 0.5, 0.2, 0.4)
  }

  /** Advance shooter projectiles; knock a tower floor on contact. */
  updateShots(dt) {
    const fh = this.city.floorHeight
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      s.life += dt
      const target = s.target
      if (!target || !target.visible || s.life > 3) {
        this.scene.remove(s.mesh)
        this.shots.splice(i, 1)
        continue
      }
      this.towerWorld(target, this._sv)
      const p = s.mesh.position
      const dx = this._sv.x - p.x
      const dy = target.numFloors * fh - p.y
      const dz = this._sv.y - p.z
      const dist = Math.hypot(dx, dy, dz) || 1
      const step = this.shotSpeed * dt
      if (dist <= 1.0 + step) {
        this.city.renderer.damageTower(target)
        this.scene.remove(s.mesh)
        this.shots.splice(i, 1)
        continue
      }
      p.x += (dx / dist) * step
      p.y += (dy / dist) * step
      p.z += (dz / dist) * step
      s.mesh.rotation.x += dt * 6
      s.mesh.rotation.y += dt * 5
    }
  }

  /** Burst of debris (coloured to match the creep) where it died. */
  explode(c) {
    const debris = this.city.debris
    if (!debris) return
    const color = c.mesh.material.color || this._black
    debris.spawn(c.mesh.position.x, c.baseY, c.mesh.position.z, c.big ? 1.0 : 0.6, color, c.big ? 14 : 8)
  }

  /** Begin spawning (called when the player starts the game). */
  start() {
    this.started = true
    this.elapsed = 0
    this.spawnTimer = 0
  }

  /**
   * Advance the wave clock by `dt` and run the spawn schedule. Waves: after the
   * grace period, spawn only during the first `waveActive` seconds of each
   * `wavePeriod`-second cycle; the rest is a breather.
   */
  advanceSpawns(dt) {
    this.elapsed += dt
    if (this.spawnEnabled && this.elapsed >= this.graceTime) {
      const phase = (this.elapsed - this.graceTime) % this.wavePeriod
      if (phase < this.waveActive) {
        this.spawnTimer += dt
        if (this.spawnTimer >= this.spawnInterval) {
          this.spawnTimer -= this.spawnInterval
          for (let k = 0; k < this.spawnBurst; k++) this.spawn()
        }
      } else {
        this.spawnTimer = 0
      }
    }
  }

  /**
   * Fast-forward: replay the spawn schedule across `seconds` in fine steps, so
   * every creep that WOULD have spawned in that window is created now - they all
   * arrive at once. Spawn cadence/types ramp with elapsed, so step finely.
   */
  skipAhead(seconds) {
    if (!this.started) return
    const stepDt = 0.05
    let remaining = seconds
    while (remaining > 0) {
      const dt = Math.min(stepDt, remaining)
      this.advanceSpawns(dt)
      remaining -= dt
    }
  }

  update(dt) {
    if (!this.started) return
    this.advanceSpawns(dt)

    this.updateShots(dt)
    this.updateBombs(dt)

    for (let i = this.creeps.length - 1; i >= 0; i--) {
      const c = this.creeps[i]

      // Bombers fly across the map at altitude, dropping bombs on an interval,
      // and despawn once they pass the far edge. They ignore ground pathing and
      // power lines (airborne).
      if (c.bomber) {
        c.mesh.position.x += c.vx * dt
        c.mesh.position.z += c.vz * dt
        c.mesh.position.y = c.baseY + Math.sin(this.elapsed * 2.5 + c.bob) * 0.4
        // Only release a bomb when a tower is directly underneath; otherwise
        // hold the (ready) timer so it drops the instant one passes below.
        c.bombTimer += dt
        if (c.bombTimer >= this.bombInterval) {
          if (this.towerAt(c.mesh.position.x, c.mesh.position.z)) {
            c.bombTimer -= this.bombInterval
            this.dropBomb(c)
          } else {
            c.bombTimer = this.bombInterval
          }
        }
        const lim = this.reach + this.cell * 2
        if (Math.abs(c.mesh.position.x) > lim || Math.abs(c.mesh.position.z) > lim) {
          this.scene.remove(c.mesh)
          this.creeps.splice(i, 1)
        }
        continue
      }

      // Touching an active power line fries the creep on the spot, but the
      // overload also knocks a block off one of the towers feeding that line.
      const lineIdx = this.onPowerLine(c.mesh.position.x, c.mesh.position.z)
      if (lineIdx >= 0) {
        this.explode(c)
        this.scene.remove(c.mesh)
        this.creeps.splice(i, 1)
        Sounds.play('burn', 1.0, 0.2, 0.6)
        const pair = this.city.trails.pathTowers[lineIdx]
        if (pair) {
          const victim = pair[0].numFloors >= pair[1].numFloors ? pair[0] : pair[1]
          this.city.renderer.damageTower(victim)
        }
        continue
      }

      if (c.state === 'shoot') {
        const target = c.target
        if (!target || !target.visible) {
          c.state = 'march'
          c.target = null
          c.t = 1
          continue
        }
        c.mesh.position.y = c.baseY
        c.shootTimer += dt
        if (c.shootTimer >= this.shootInterval) {
          c.shootTimer -= this.shootInterval
          this.fireShot(c, target)
        }
        continue
      }

      if (c.state === 'attack') {
        const target = c.target
        if (!target || !target.visible) {
          c.state = 'march'
          c.target = null
          c.t = 1
          continue
        }

        // Lunge toward the target on each knock.
        const tw = new Vector2()
        this.towerWorld(target, tw)
        const dx = tw.x - c.toX
        const dz = tw.y - c.toZ
        const len = Math.hypot(dx, dz) || 1

        c.attackTimer += dt
        const phase = Math.min(1, c.attackTimer / this.knockInterval)
        const lunge = Math.sin(phase * Math.PI) * this.cell * 0.35
        c.mesh.position.x = c.toX + (dx / len) * lunge
        c.mesh.position.z = c.toZ + (dz / len) * lunge
        c.mesh.position.y = c.baseY

        if (c.attackTimer >= this.knockInterval) {
          c.attackTimer -= this.knockInterval
          Sounds.play('attack', 1.0, 0.2, 0.6)
          c.knocks++
          if (c.knocks >= this.knocksPerFloor) {
            // Big creeps hit harder (knock multiple floors).
            for (let n = 0; n < c.knockFloors; n++) this.city.renderer.damageTower(target)
            // Job done: the creep bursts into debris after landing its kill.
            this.explode(c)
            this.scene.remove(c.mesh)
            this.creeps.splice(i, 1)
            continue
          }
        }
        continue
      }

      // march
      if (c.t >= 1) {
        // Shooters stop and open fire once a target is within shooting range.
        if (c.shooter) {
          const tgt = (c.target && c.target.visible && c.target.numFloors >= 1)
            ? c.target : this.acquireTarget(c)
          if (tgt && this.towerDist(tgt, c.toX, c.toZ) <= this.shootRange) {
            c.target = tgt
            c.state = 'shoot'
            c.shootTimer = this.shootInterval // fire on the first frame
            continue
          }
        }
        const r = this.planStep(c)
        if (r === 'done') {
          this.scene.remove(c.mesh)
          this.creeps.splice(i, 1)
          continue
        }
        if (r === 'attack') {
          c.state = 'attack'
          c.attackTimer = 0
          continue
        }
        // freshly entered the new cell: footstep
        Sounds.play(Math.random() < 0.5 ? 'step1' : 'step2', 1.0, 0.2, 0.4)
      }

      c.t = Math.min(1, c.t + dt / this.stepDuration)
      const e = c.t * c.t * (3 - 2 * c.t) // smoothstep ease
      c.mesh.position.x = c.fromX + (c.toX - c.fromX) * e
      c.mesh.position.z = c.fromZ + (c.toZ - c.fromZ) * e
      c.mesh.position.y = c.baseY + Math.sin(c.t * Math.PI) * this.hopHeight
      c.mesh.rotation.y = Math.PI / 4 + c.t * (Math.PI / 2) // quarter-turn per hop
    }
  }
}
