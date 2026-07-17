import {
  Mesh,
  BoxGeometry,
  SphereGeometry,
  CylinderGeometry,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
  Quaternion,
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
    // King-seekers read near-black; gen-seekers a slightly lighter dark grey.
    this.mat = new MeshStandardNodeMaterial({
      color: new Color(0x0a0a0e),
      roughness: 0.55,
      metalness: 0,
    })
    this.matGen = new MeshStandardNodeMaterial({
      color: new Color(0x33333a),
      roughness: 0.55,
      metalness: 0,
    })
    // F-mode seeker dot above each creep: red = king-seeker, green = gen-seeker.
    // depthTest off so it stays visible even when the creep is behind a tower.
    this.dotGeo = new SphereGeometry(0.34, 12, 8)
    this.dotKingMat = new MeshBasicNodeMaterial({ color: new Color(0xff2020), depthTest: false })
    this.dotGenMat = new MeshBasicNodeMaterial({ color: new Color(0x22ff22), depthTest: false })

    // Laser creeps: stop at range and fire a turret-style beam at towers.
    this.laserMat = new MeshStandardNodeMaterial({ color: new Color(0xb01f4a), roughness: 0.4, metalness: 0.15 })
    this.creepLaserColor = new Color(0xff2e5e) // the beam colour
    this.laserDamage = 1
    this.beamDuration = 0.16 // seconds a beam flash lingers
    this.beamGeo = new CylinderGeometry(0.16, 0.16, 1, 8) // unit length along Y
    this.beams = []
    for (let i = 0; i < 8; i++) {
      const mat = new MeshBasicNodeMaterial({ transparent: true, opacity: 0, depthWrite: false })
      const mesh = new Mesh(this.beamGeo, mat)
      mesh.visible = false
      this.scene.add(mesh)
      this.beams.push({ mesh, life: 0, active: false })
    }
    this._beamFrom = new Vector3()
    this._beamTo = new Vector3()
    this._beamDir = new Vector3()
    this._beamUp = new Vector3(0, 1, 0)
    this._beamQ = new Quaternion()
    // Shooter creeps read deep orange so they're distinguishable from marchers;
    // gen-seeker shooters are a lighter orange (matching the body lightness rule).
    this.shooterMat = new MeshStandardNodeMaterial({
      color: new Color(0xd2531e),
      roughness: 0.5,
      metalness: 0,
    })
    this.shooterMatGen = new MeshStandardNodeMaterial({
      color: new Color(0xef8a4d),
      roughness: 0.5,
      metalness: 0,
    })
    // Boss giants: a menacing dark red, much larger and tankier than any creep.
    this.giantMat = new MeshStandardNodeMaterial({
      color: new Color(0x5a0f12),
      roughness: 0.45,
      metalness: 0.1,
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
    this._lastWave = -1 // last wave index seen (for boss-wave edge detection)
    this.startInterval = 2 // seconds between spawns right after grace
    this.minInterval = 0.45 // fastest spawn cadence late game (~30% more than before)
    this.rampDuration = 600 // seconds to ramp from start -> min (longer ramp)

    // Waves: spawn for waveActive secs, then wait until the next wavePeriod.
    this.wavePeriod = 40 // 20s spawn + 20s wait
    this.waveActive = 20 // seconds each wave spawns for
    this.bigChance = 0.1 // fraction of creeps that are big (once they unlock)
    this.bigUnlockTime = 90 // no big creeps until this many seconds in
    // Fraction of creeps that doggedly smash toward the king (ignoring gens) when
    // it's walled off, rather than diverting to a reachable gen.
    this.kingSeekerChance = 0.5

    // Shooter creeps: stop at range and lob little blocks at towers.
    this.shooterChance = 0.1 // fraction of creeps that are shooters
    this.shooterUnlockTime = 150 // grace + 3 wave cycles; shooters from wave 4

    // Laser creeps: stop at range and fire a turret-style beam at towers.
    this.laserChance = 0.1
    this.laserUnlockTime = 150

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

  /** How many creeps to spawn per tick - stays 1 for the first ~5 min, then
   *  climbs slowly (2 @ 5min, 3 @ 10min) so late-game waves keep escalating. */
  get spawnBurst() {
    return Math.min(3, 1 + Math.floor(this.elapsed / 300))
  }

  snap(v) {
    return Math.round(v / this.cell) * this.cell
  }

  /**
   * Spawn a ground creep. opts.giant -> a 5x5 boss; opts.forceShooter -> a shooter
   * regardless of unlock/roll; opts.edge -> force the spawn edge (so a boss group
   * arrives from one side).
   */
  spawn(opts = {}) {
    const giant = !!opts.giant
    const forceShooter = !!opts.forceShooter
    // Some creeps are "big": 2x size, 2x HP, knock 2 floors per kill. Late + rare.
    const big = !giant && !forceShooter && this.elapsed >= this.bigUnlockTime && Math.random() < this.bigChance
    // Shooters stop at range and lob little blocks at towers.
    const shooter = !giant && (forceShooter || (!big && this.elapsed >= this.shooterUnlockTime && Math.random() < this.shooterChance))
    // Laser creeps stop at range and fire a turret-style beam at towers.
    const laser = !giant && !forceShooter && !big && !shooter && this.elapsed >= this.laserUnlockTime && Math.random() < this.laserChance
    // Bombers fly across at altitude and drop bombs.
    const bomber = !giant && !forceShooter && !big && !shooter && !laser && this.elapsed >= this.bomberUnlockTime && Math.random() < this.bomberChance
    if (bomber) { this.spawnBomber(); return }
    const scale = giant ? 3 : (big ? 1.4 : 0.7)
    const baseY = giant ? 3 : (big ? 1.5 : 0.8)

    // King-seekers ignore the gen flow and smash walls toward the king when it's
    // sealed; giants always bee-line the king (too big to use gaps anyway).
    const kingSeeker = giant ? true : Math.random() < this.kingSeekerChance
    const bodyMat = giant ? this.giantMat
      : laser ? this.laserMat
        : shooter ? (kingSeeker ? this.shooterMat : this.shooterMatGen)
          : (kingSeeker ? this.mat : this.matGen)
    const mesh = new Mesh(this.geo, bodyMat)
    mesh.castShadow = true
    mesh.scale.setScalar(scale)
    mesh.rotation.y = Math.PI / 4 // diamond footprint, off-grid

    // Pick a point along one of the four map edges (forced for boss groups).
    const r = this.reach
    const t = this.snap((Math.random() * 2 - 1) * r)
    const edge = opts.edge ?? Math.floor(Math.random() * 4)
    let x, z
    if (edge === 0) { x = -r; z = t }
    else if (edge === 1) { x = r; z = t }
    else if (edge === 2) { x = t; z = -r }
    else { x = t; z = r }
    x = this.snap(x)
    z = this.snap(z)

    mesh.position.set(x, baseY, z)
    this.scene.add(mesh)
    Sounds.play('spawn', giant ? 0.4 : (big ? 0.7 : 1.0), 0.12, giant ? 0.5 : (big ? 0.25 : 0.15))

    // F-mode seeker dot above the creep (red = king-seeker, green = gen-seeker).
    // Counter-scaled so it reads the same on big/small creeps.
    const typeDot = new Mesh(this.dotGeo, kingSeeker ? this.dotKingMat : this.dotGenMat)
    typeDot.position.set(0, 2.6, 0)
    typeDot.scale.setScalar(1 / scale)
    typeDot.renderOrder = 11
    typeDot.visible = !!this.city.flowDebugEnabled
    mesh.add(typeDot)

    this.creeps.push({
      mesh,
      typeDot,
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
      laser,
      giant,
      shootTimer: 0,
      baseY,
      maxHits: giant ? this.hitsToKill * 10 : (big ? this.hitsToKill * 2 : this.hitsToKill),
      knockFloors: giant ? 4 : (big ? 2 : 1),
      stepMul: giant ? 2.2 : 1, // giants lumber slower
      kingSeeker,
    })
  }

  /** Boss wave: a same-side group of `bossOrdinal` giants + 5 shooter buddies. */
  spawnBossWave(waveIdx) {
    const giants = this.bossOrdinal(waveIdx)
    const edge = Math.floor(Math.random() * 4) // all come in from the same side
    for (let i = 0; i < giants; i++) this.spawn({ giant: true, edge })
    for (let i = 0; i < 5; i++) this.spawn({ forceShooter: true, edge })
  }

  /** Every 5th wave (1-based) is a boss wave. */
  isBossWave(waveIdx) { return waveIdx >= 0 && (waveIdx + 1) % 5 === 0 }
  /** Which boss wave this is (1, 2, 3, ...) = giant count. */
  bossOrdinal(waveIdx) { return (waveIdx + 1) / 5 }

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

  /** Distance (world units) from a world point to a tower's footprint edge. */
  towerDist(tower, wx, wz) {
    this._p.set(wx - this.city.gridOffsetX, wz - this.city.gridOffsetZ)
    return tower.box.distanceToPoint(this._p)
  }

  /** True if any ground creep currently occupies grid cell (gx, gy). Used to block
   *  placing a block on top of a creep. */
  creepInCell(gx, gy) {
    for (const c of this.creeps) {
      if (c.bomber) continue // airborne, ignore
      const cell = this.city.worldToCell(c.mesh.position.x, c.mesh.position.z)
      if (cell && cell.gx === gx && cell.gy === gy) return true
    }
    return false
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
   * Plan the next cell. Follow the city flow field around walls toward the king
   * (gens/turrets are second-priority goals); attack a tower stepped into. Falls
   * back to a greedy beeline that smashes walls toward the king when no flow path
   * exists. Returns 'move', 'attack', or 'done'.
   */
  planStep(c) {
    const city = this.city
    // Giants are too big for gaps: they bulldoze straight toward the king.
    if (c.giant) return this._planStepGreedy(c)
    const cell = city.worldToCell(c.toX, c.toZ)
    if (cell && city.flowDist) {
      const i = cell.gy * city.gridCellsX + cell.gx
      // Big creeps use the wide-corridor field (1-cell gaps closed off).
      const dist = c.big ? city.flowDistBig : city.flowDist
      const fdx = c.big ? city.flowDXBig : city.flowDX
      const fdz = c.big ? city.flowDZBig : city.flowDZ
      const ftk = c.big ? city.flowToKingBig : city.flowToKing
      // King-seekers ignore gen flow (they'd rather smash toward the king); others
      // follow whatever flow exists (king if reachable, else nearest gen).
      const followFlow = dist[i] >= 1 && (ftk[i] || !c.kingSeeker)
      if (followFlow) {
        const nx = c.toX + fdx[i] * this.cell
        const nz = c.toZ + fdz[i] * this.cell
        for (const tower of city.towers) {
          if (!tower.visible) continue
          if (this.towerDist(tower, nx, nz) < this.cell * 0.5) { c.target = tower; return 'attack' }
        }
        c.fromX = c.toX; c.fromZ = c.toZ; c.toX = nx; c.toZ = nz; c.t = 0
        return 'move'
      }
    }
    return this._planStepGreedy(c)
  }

  /** Greedy beeline toward the king, smashing through whatever's in the way (one
   *  axis at a time). Used when the flow field has no path (king fully sealed). */
  _planStepGreedy(c) {
    const king = this.city.king
    if (!king || !king.visible) return 'done'
    const tw = new Vector2()
    this.towerWorld(king, tw)
    const goalX = tw.x, goalZ = tw.y

    const x = c.toX
    const z = c.toZ
    const dx = goalX - x
    const dz = goalZ - z

    if (Math.abs(dx) < this.cell && Math.abs(dz) < this.cell) {
      c.target = king
      return 'attack'
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

  /** Laser creep: hitscan a tower for laserDamage + flash a turret-style beam. */
  fireLaser(c, target) {
    this._beamFrom.set(c.mesh.position.x, c.baseY + 0.4, c.mesh.position.z)
    this.towerWorld(target, this._sv)
    const ty = Math.max(0.5, target.numFloors * 0.5) * this.city.floorHeight
    this._beamTo.set(this._sv.x, ty, this._sv.y)
    this.spawnBeam(this._beamFrom, this._beamTo, this.creepLaserColor)
    for (let n = 0; n < this.laserDamage; n++) this.city.renderer.damageTower(target)
    Sounds.play('shoot', 0.6, 0.2, 0.45)
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
    this._beamDir.copy(to).sub(from)
    const len = this._beamDir.length() || 0.001
    m.position.copy(from).addScaledVector(this._beamDir, 0.5)
    this._beamDir.divideScalar(len)
    this._beamQ.setFromUnitVectors(this._beamUp, this._beamDir)
    m.quaternion.copy(this._beamQ)
    m.scale.set(1, len, 1)
  }

  /** Fade out / retire active beam flashes. */
  updateBeams(dt) {
    for (const b of this.beams) {
      if (!b.active) continue
      b.life += dt
      if (b.life >= this.beamDuration) { b.active = false; b.mesh.visible = false }
      else b.mesh.material.opacity = 1 - b.life / this.beamDuration
    }
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
    this._lastWave = -1
  }

  /**
   * Advance the wave clock by `dt` and run the spawn schedule. Waves: after the
   * grace period, spawn only during the first `waveActive` seconds of each
   * `wavePeriod`-second cycle; the rest is a breather.
   */
  advanceSpawns(dt) {
    this.elapsed += dt
    if (this.spawnEnabled && this.elapsed >= this.graceTime) {
      // At each new wave boundary, fire a boss group if it's a boss wave.
      const waveIdx = Math.floor((this.elapsed - this.graceTime) / this.wavePeriod)
      if (waveIdx !== this._lastWave) {
        this._lastWave = waveIdx
        if (this.isBossWave(waveIdx)) this.spawnBossWave(waveIdx)
      }
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
    // Rebuild the creep flow field when the city changed (cheap, shared by all).
    if (!this.city.flowDist || this.city.flowDirty) this.city.computeFlowField()
    this.advanceSpawns(dt)

    this.updateShots(dt)
    this.updateBombs(dt)
    this.updateBeams(dt)

    // King-proximity siren: warn while any creep is within 3 tiles of the king.
    let kingWX = 0, kingWZ = 0, kingHere = false
    if (this.city.king && this.city.king.visible) {
      this.towerWorld(this.city.king, this._sv)
      kingWX = this._sv.x; kingWZ = this._sv.y; kingHere = true
    }
    const warnR2 = (3 * this.cell) * (3 * this.cell)
    let creepNearKing = false

    const showTypeArrows = !!this.city.flowDebugEnabled
    for (let i = this.creeps.length - 1; i >= 0; i--) {
      const c = this.creeps[i]
      if (c.typeDot) c.typeDot.visible = showTypeArrows
      if (c.giant) c.mesh.rotation.y += dt * 0.18 // very slow, ominous spin

      if (kingHere) {
        const ddx = c.mesh.position.x - kingWX, ddz = c.mesh.position.z - kingWZ
        if (ddx * ddx + ddz * ddz <= warnR2) creepNearKing = true
      }

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
          if (c.laser) this.fireLaser(c, target)
          else this.fireShot(c, target)
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
        // Shooters / laser creeps stop and open fire once a target is in range.
        if (c.shooter || c.laser) {
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

      c.t = Math.min(1, c.t + dt / (this.stepDuration * (c.stepMul || 1)))
      const e = c.t * c.t * (3 - 2 * c.t) // smoothstep ease
      c.mesh.position.x = c.fromX + (c.toX - c.fromX) * e
      c.mesh.position.z = c.fromZ + (c.toZ - c.fromZ) * e
      c.mesh.position.y = c.baseY + Math.sin(c.t * Math.PI) * this.hopHeight
      if (!c.giant) c.mesh.rotation.y = Math.PI / 4 + c.t * (Math.PI / 2) // quarter-turn per hop (giants spin slowly instead)
    }

    // Re-arm / fire the king-proximity siren on a cooldown.
    this._kingWarnTimer = (this._kingWarnTimer || 0) - dt
    if (creepNearKing) {
      if (this._kingWarnTimer <= 0) { Sounds.play('warning2', 1.0, 0, 0.7); this._kingWarnTimer = 1.5 }
    } else {
      this._kingWarnTimer = 0 // ready to fire the instant a creep gets close again
    }
  }
}
