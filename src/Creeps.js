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

    this.cell = city.cellUnit // grid step size (world units)
    this.baseY = 0.8

    // Held until the player presses Start (see start()); no creeps before then.
    this.started = false

    // Spawn pacing: grace period, then interval ramps from slow -> fast.
    this.elapsed = 0
    this.graceTime = 12 // seconds before the first wave
    this.spawnTimer = 0
    this.startInterval = 4 // seconds between spawns right after grace
    this.minInterval = 1 // fastest spawn cadence (never quicker than 1s)
    this.rampDuration = 75 // seconds to ramp from start -> min

    // Waves: a new wave every wavePeriod seconds, spawning for waveActive secs.
    this.wavePeriod = 60 // seconds between wave starts
    this.waveActive = 20 // seconds each wave spawns for
    this.bigChance = 0.1 // fraction of creeps that are big (once they unlock)
    this.bigUnlockTime = 90 // no big creeps until this many seconds in

    this.stepDuration = 0.30 // seconds to move one cell
    this.hopHeight = 0.6
    this.reach = 49 // ~half the map (7 lots * 14 / 2)

    this.knockInterval = 0.45 // seconds between knocks
    this.knocksPerFloor = 3
    this.hitsToKill = 4 // turret sphere hits needed to destroy a creep

    this._p = new Vector2()
    this._black = new Color(0x080808)
  }

  /** Current seconds-between-spawns, ramping down after the grace period. */
  get spawnInterval() {
    const since = Math.max(0, this.elapsed - this.graceTime)
    const k = Math.min(1, since / this.rampDuration)
    return this.startInterval + (this.minInterval - this.startInterval) * k
  }

  snap(v) {
    return Math.round(v / this.cell) * this.cell
  }

  spawn() {
    // Some creeps are "big": 2x size, 2x HP, knock 2 floors per kill. They only
    // start appearing later in the run, and stay rare.
    const big = this.elapsed >= this.bigUnlockTime && Math.random() < this.bigChance
    const scale = big ? 1.4 : 0.7
    const baseY = big ? 1.5 : 0.8

    const mesh = new Mesh(this.geo, this.mat)
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
      baseY,
      maxHits: big ? this.hitsToKill * 2 : this.hitsToKill,
      knockFloors: big ? 2 : 1,
    })
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
      if (!tower.visible || tower.numFloors < 1) continue
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
    if (!target || !target.visible || target.numFloors < 1) {
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
      if (!tower.visible || tower.numFloors < 1) continue
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

  /** Apply one turret-sphere hit; explode + remove the creep at its max HP. */
  hit(creep) {
    creep.hits++
    if (creep.hits < creep.maxHits) {
      Sounds.play('tick', 1.4, 0.2, 0.4)
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

  /** Burst of black debris where a creep died. */
  explode(c) {
    const debris = this.city.debris
    if (!debris) return
    debris.spawn(c.mesh.position.x, c.baseY, c.mesh.position.z, c.big ? 1.0 : 0.6, this._black, c.big ? 14 : 8)
  }

  /** Begin spawning (called when the player starts the game). */
  start() {
    this.started = true
    this.elapsed = 0
    this.spawnTimer = 0
  }

  update(dt) {
    if (!this.started) return
    this.elapsed += dt

    // Waves: after the grace period, spawn only during the first `waveActive`
    // seconds of each `wavePeriod`-second cycle; the rest is a breather.
    if (this.elapsed >= this.graceTime) {
      const phase = (this.elapsed - this.graceTime) % this.wavePeriod
      if (phase < this.waveActive) {
        this.spawnTimer += dt
        if (this.spawnTimer >= this.spawnInterval) {
          this.spawnTimer -= this.spawnInterval
          this.spawn()
        }
      } else {
        this.spawnTimer = 0
      }
    }

    for (let i = this.creeps.length - 1; i >= 0; i--) {
      const c = this.creeps[i]

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
          this.city.damageTower(victim)
        }
        continue
      }

      if (c.state === 'attack') {
        const target = c.target
        if (!target || !target.visible || target.numFloors < 1) {
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
            for (let n = 0; n < c.knockFloors; n++) this.city.damageTower(target)
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
