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
import { Sounds, BOSS_HORN_PREROLL, MAX_RISER_PREROLL } from './lib/Sounds.js'
import { AMMO_COLOR } from './Mana.js'
import { isShield, shieldCharges, shieldRadiusCells } from './blockTypes.js'

// Damage a shield perimeter does to a creep crossing it.
const SHIELD_DAMAGE = 1
import { Buffs } from './buffs.js'

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
    this.startInterval = 2 // seconds between spawns right after grace
    this.minInterval = 0.45 // fastest spawn cadence late game (~30% more than before)
    this.rampDuration = 600 // seconds to ramp from start -> min (longer ramp)

    // Waves run on a fixed clock: spawn for waveActive secs, then the rest of
    // wavePeriod is the build phase. Creeps left alive past the spawn window
    // eat into that quiet - the next wave still lands on schedule - so a slow
    // clear costs you build time rather than delaying anything.
    this.wavePeriod = 60 // 20s spawn + 40s build
    this.waveActive = 20 // seconds each wave spawns for
    this._lastWave = -1 // last wave index seen (for boss-wave edge detection)

    // Wave audio: a ticking clock fills the breather, then a horn lands on the
    // spawn. Leads are in seconds before the wave starts; the clock bed is
    // seeked so its last tick falls on zero (see Sounds.countdown).
    // The clock runs for this long before a wave, and the riser lands its peak
    // on the spawn inside that window: ~5.5s of riser over the tail of a normal
    // wave's 10s ticker, ~10.7s over a boss's 15s one. The build phase is 30s,
    // so there's still plenty of quiet breather to build in.
    this.countdownLead = 10
    // Boss waves keep the longer lead on purpose: their riser peaks at ~10.7s,
    // so a 10s lead would start the swell before the clock and leave no
    // ticker-only phase at all on the biggest moment of the run.
    this.bossCountdownLead = 15
    this._audioWave = -1 // last wave index whose horn fired
    this._cuedWave = -1 // last wave index whose countdown started
    this._bossCuedWave = -1 // last boss wave whose horn was pre-rolled
    this._waveActiveNow = false // in combat? (spawning, or creeps still alive)
    this._riser = null // riser armed for the next wave, fired at its own peak
    this._riserWave = -1
    // Seconds of near-silence after the last creep of a round dies, before the
    // build bed comes back. The round-clear sting needs somewhere to land, and
    // the upgrade screen (if one is due) opens inside this gap.
    this.roundEndQuiet = 2.2
    this._quietTimer = 0
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
    // Spawn ring, always outside the board: hardcoded to 49 for the old 7-lot
    // city, which would now sit INSIDE a 10-lot one and drop creeps mid-city.
    this.reach = city.actualGridWidth / 2 + 14
    // Half-extent of the buildable grid. Creeps spawn at `reach`, i.e. well
    // outside this, and only count as having arrived once they cross it.
    this.fieldHalf = city.actualGridWidth / 2

    this.knockInterval = 0.45 // seconds between knocks
    this.knocksPerFloor = 3
    this.hitsToKill = 4 // turret sphere hits needed to destroy a creep

    // Ammo boxes: a dying creep leaves one 20% of the time. At 5 a box that's
    // 1.0 ammo per kill on average, which is what Turrets.SHOT_COST is priced
    // against - see the table there.
    this.ammoDropChance = 0.2
    this.ammoDropAmount = 5
    this.ammoBoxGeo = new BoxGeometry(1.1, 1.1, 1.1)
    this.ammoBoxMat = new MeshStandardNodeMaterial({
      color: new Color(AMMO_COLOR),
      emissive: new Color(AMMO_COLOR).multiplyScalar(0.45),
      roughness: 0.35,
      metalness: 0,
    })
    this.ammoBoxes = []

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
    // Heads-up blips for the two threats you can't just out-wall: a bright high
    // one for the airborne bomber, a sharper mid one for the laser. Fixed per
    // type (not randomised) so they stay learnable, and quiet enough to sit
    // under the wave horn. Sounds.js rate-limits them, so a burst of bombers
    // gives one warning rather than five.
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
      // Arrival sound, held until the creep crosses onto the playfield (see
      // updateEntries). Rank-and-file creeps get the short creep-warn tick;
      // spawn.mp3 is loud and full-bodied, so it's reserved for the rare big
      // bodies where an announcement is actually warranted.
      entered: false,
      baseScale: scale, // spawn size; giants shrink from this as they take hits
      baseYSpawn: baseY, // resting height at spawn size, scaled down alongside it
      entrySound: giant || big ? 'spawn' : 'creep-warn',
      entryRate: giant ? 0.4 : (big ? 0.7 : 1.0),
      // spawn.mp3 (big + giant) down 33% - fat arrivals were the loudest thing
      // on the board. Normal creeps use creep-warn and are left alone.
      entryVol: giant ? 0.67 : (big ? 0.31 : 0.22),
      shootTimer: 0,
      baseY,
      maxHits: Math.max(1, Math.round(
        (giant ? this.hitsToKill * 10 : (big ? this.hitsToKill * 2 : this.hitsToKill)) * Buffs.creepHp
      )),
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
  isBossWave(waveIdx) { return waveIdx >= 0 && (waveIdx + 1) % 4 === 0 }
  /** Which boss wave this is (1, 2, 3, ...) = giant count. */
  bossOrdinal(waveIdx) { return (waveIdx + 1) / 4 }

  /**
   * Voice for a boss wave. Each tier gets its own reading of the same low horn:
   * a semitone-ish deeper and a touch louder per boss, so the 5th boss wave is
   * an audibly bigger animal than the 1st without needing five more files.
   * Deliberately quieter than the regular wave horns - it's a 9s sustained
   * swell, so at wave-horn volume it would smother everything under it.
   */
  bossHornVoice(waveIdx) {
    const n = this.bossOrdinal(waveIdx) // 1, 2, 3, ...
    return {
      rate: Math.max(0.6, 1.0 - (n - 1) * 0.1),
      volume: Math.min(0.5, 0.3 + (n - 1) * 0.04),
    }
  }

  /**
   * Fire each creep's arrival sound the moment it crosses onto the playfield.
   *
   * Creeps spawn at `reach` (~14 units outside the grid) and take a couple of
   * seconds to walk in, so playing this at birth put the sound well before
   * there was anything to look at - and during a burst it fired the whole
   * wave's worth at the edge in one clump. On the crossing it tracks what you
   * can actually see arriving.
   */
  updateEntries() {
    const half = this.fieldHalf
    for (const c of this.creeps) {
      if (c.entered) continue
      const p = c.mesh.position
      if (Math.abs(p.x) > half || Math.abs(p.z) > half) continue
      c.entered = true
      Sounds.play(c.entrySound, c.entryRate, 0.12, c.entryVol)
      // Flyers get their own call over the top - they cross the whole map at
      // altitude, so this is the only warning you get that one is up there.
      if (c.bomber) Sounds.play('flyer-warn', 1.0, 0.03, 0.22)
      else if (c.laser) Sounds.play('alert2', 1.0, 0.04, 0.26)
    }
  }

  /**
   * Schedule the audio around wave boundaries. Called once per frame from
   * update() - deliberately NOT from advanceSpawns(), which skipAhead() runs in
   * a tight loop (that would fire a horn per simulated step).
   *
   * Timeline for a wave that starts at T:
   *    T-10  boss clock + riser begin (ticks pitched down) [boss waves]
   *    T-6   normal clock + riser begin                  [normal waves]
   *    T-2.5 boss horn starts, so its 2.5s swell peaks at T
   *    T     wave horn + spawns
   */
  updateWaveAudio(dt) {
    if (!this.spawnEnabled) return
    const t = this.elapsed

    // The wave now in progress (or -1 during the opening grace period).
    const current = t < this.graceTime
      ? -1 : Math.floor((t - this.graceTime) / this.wavePeriod)
    // ...and the next one to arrive.
    const next = current + 1
    const away = (this.graceTime + next * this.wavePeriod) - t
    const bossNext = this.isBossWave(next)

    // Countdown bed, seeked so the final tick lands on the spawn. A mechanical
    // clock rather than a digital alarm - it fills the breather with tension
    // instead of nagging - with a soft riser layered over it for the build.
    const lead = bossNext ? this.bossCountdownLead : this.countdownLead
    if (away <= lead && this._cuedWave !== next) {
      this._cuedWave = next
      // No stab ahead of the clock - the ticker starting IS the "incoming" cue,
      // and a horn in front of it just stepped on the build-up.
      if (bossNext) Sounds.countdown('tick-fast', away, 0.28, 0.92)
      else Sounds.countdown('tick-fast', away, 0.22)
    }

    // Riser: armed early (its pre-roll is up to ~11s, longer than the tick
    // lead) and fired when its own measured peak lines up with the spawn, so
    // the swell tops out on the horn rather than after it.
    if (away <= MAX_RISER_PREROLL + 1 && this._riserWave !== next) {
      this._riserWave = next
      this._riser = Sounds.pickRiser(bossNext)
    }
    if (this._riser && away <= this._riser.peak) {
      const r = this._riser
      this._riser = null
      Sounds.play(r.name, 1.0, 0, r.volume * (bossNext ? 1.25 : 1.0))
    }

    // Boss horn pre-roll: start early so the swell peaks as the giants land.
    if (bossNext && away <= BOSS_HORN_PREROLL && this._bossCuedWave !== next) {
      this._bossCuedWave = next
      const { rate, volume } = this.bossHornVoice(next)
      Sounds.play('horn-boss', rate, 0.02, volume)
    }

    // Wave horn on the boundary. Boss waves already have their horn running.
    if (current >= 0 && current !== this._audioWave) {
      this._audioWave = current
      if (!this.isBossWave(current)) Sounds.play('horn', 1.0, 0.06, 0.55)
    }

    // A round is not over when the spawns stop - it's over when the last creep
    // of it is dead. Dropping to the build bed at the end of the spawn window
    // put calm music over a field still full of creeps, so combat holds until
    // the board is actually clear.
    const spawning = current >= 0 && ((t - this.graceTime) % this.wavePeriod) < this.waveActive
    const inCombat = spawning || this.creeps.length > 0
    if (inCombat !== this._waveActiveNow) {
      this._waveActiveNow = inCombat
      // The stab marks the real end of the round, so it moves with it.
      if (!inCombat) {
        // 5.5s fanfare peaking at 1.3s - it plays out across the quiet gap and
        // has decayed by the time the build bed eases back in.
        Sounds.play('level-complete', 1.0, 0, 0.7)
        this._quietTimer = this.roundEndQuiet
        // `current` is the wave that just finished; 0-based, so wave 3 is idx 2.
        if (current >= 0) this.onRoundCleared?.(current)
      }
    }

    // Background music follows the same state: calm while you build, a fight
    // track (drawn from the bucket, so it varies round to round) while the
    // board is hot, and the boss bed on boss rounds.
    if (this._quietTimer > 0) this._quietTimer -= dt
    const quiet = !inCombat && this._quietTimer > 0
    const mode = inCombat ? (this.isBossWave(current) ? 'boss' : 'fight')
      : (quiet ? 'quiet' : 'build')
    // Drop to silence quickly so the sting is exposed; ease back in slowly.
    Sounds.setBedMode(mode, inCombat ? 1.5 : (quiet ? 0.9 : 2.5))
  }

  /**
   * Shield barriers: a creep that crosses a shield's perimeter is burned for
   * SHIELD_DAMAGE and spends one of the shield's charges.
   *
   * Only INWARD crossings count, and only for creeps seen outside first - the
   * previous-side flag starts undefined, so raising a shield over creeps
   * already inside doesn't nuke them, and a creep loitering on the line can't
   * drain the barrier by jittering across it.
   */
  updateShieldBarriers() {
    const city = this.city
    const cu = city.cellUnit
    for (const t of city.towers) {
      if (!t.visible || !isShield(t) || t.numFloors < 1) continue
      if (shieldCharges(t) <= 0) continue
      const c = t.box.getCenter(this._shieldC || (this._shieldC = new Vector2()))
      const sx = c.x + city.gridOffsetX, sz = c.y + city.gridOffsetZ
      const r = shieldRadiusCells(t.numFloors) * cu

      // Backwards: hit() can kill and splice the creep out from under us.
      for (let i = this.creeps.length - 1; i >= 0; i--) {
        const cr = this.creeps[i]
        if (cr.bomber) continue // flies over the barrier
        const dx = cr.mesh.position.x - sx, dz = cr.mesh.position.z - sz
        const inside = (dx * dx + dz * dz) < r * r
        if (!cr.shieldIn) cr.shieldIn = {}
        const was = cr.shieldIn[t.id]
        cr.shieldIn[t.id] = inside
        if (!inside || was !== false) continue

        t.shieldUsed = (t.shieldUsed || 0) + 1
        Sounds.play('alert3', 1.5, 0.08, 0.3)
        this.hit(cr, SHIELD_DAMAGE)
        if (shieldCharges(t) <= 0) {
          // Spent: the ring goes dark and the barrier stops burning.
          Sounds.play('power-down', 1.2, 0.05, 0.45)
          city.onTowerChanged(t)
          break
        }
      }
    }
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
      entered: false,
      entrySound: 'creep-warn',
      entryRate: 0.8,
      entryVol: 0.3,
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
    Sounds.play('shoot', 0.4, 0.2, 0.27)
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
  /**
   * How close a creep's CENTRE may get to a tower's box before it stops and
   * attacks. Small creeps keep the old half-cell; anything bigger stands off by
   * its own body radius plus a little clearance for the lunge, so a giant hits
   * the wall from outside it instead of standing a metre inside the block it's
   * demolishing. Giants shrink as they're damaged, so a hurt one closes in.
   */
  attackStandoff(c) {
    return Math.max(this.cell * 0.5, Creeps.radiusOf(c) + this.cell * 0.2)
  }

  towerDist(tower, wx, wz) {
    this._p.set(wx - this.city.gridOffsetX, wz - this.city.gridOffsetZ)
    return tower.box.distanceToPoint(this._p)
  }

  /** True if any ground creep currently occupies grid cell (gx, gy). Used to block
   *  placing a block on top of a creep. */
  creepInCell(gx, gy) {
    const cu = this.city.cellUnit
    // Centre of the cell being asked about, in world space.
    const cx = gx * cu + cu / 2 + this.city.gridOffsetX
    const cz = gy * cu + cu / 2 + this.city.gridOffsetZ
    for (const c of this.creeps) {
      if (c.bomber) continue // airborne, ignore
      // Overlap test against the creep's BODY, not just the cell its centre
      // sits in: a giant is 3 units across and spans several cells, and testing
      // only its centre let you drop a block on top of one.
      const r = Creeps.radiusOf(c) + cu / 2
      if (Math.abs(c.mesh.position.x - cx) < r && Math.abs(c.mesh.position.z - cz) < r) return true
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
          if (this.towerDist(tower, nx, nz) < this.attackStandoff(c)) { c.target = tower; return 'attack' }
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
      if (this.towerDist(tower, nx, nz) < this.attackStandoff(c)) {
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
    // Giants visibly wear down: a boss shrinks toward 45% of its spawn size as
    // its health goes, so you can read how close it is from across the map
    // without a health bar. baseY tracks the scale so it stays on the ground,
    // and the seeker dot is counter-scaled to hold its apparent size.
    if (creep.giant && creep.baseScale) {
      const hp = Math.max(0, 1 - creep.hits / creep.maxHits)
      const s = creep.baseScale * (0.45 + 0.55 * hp)
      creep.mesh.scale.setScalar(s)
      creep.baseY = creep.baseYSpawn * (s / creep.baseScale)
      if (creep.typeDot) creep.typeDot.scale.setScalar(1 / s)
    }
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
      Sounds.play('hit', 1.0, 0.2, 0.24)
      // Killing a giant is the biggest thing that happens in a run and until now
      // it sounded exactly like swatting a marcher. Give it a payoff sting, and
      // duck the boss horn if that swell is still running - the fight is over.
      if (creep.giant) {
        Sounds.fadeOut('horn-boss', 0.6)
        Sounds.play('sting', 0.85, 0.04, 0.7)
      }
      this.rollAmmoDrop(creep)
    }
    return true
  }

  /**
   * Chance for a dying creep to leave an ammo box. The ammo is credited straight
   * away - the cube is a pink marker that pops and rises so you can see WHERE it
   * came from, not something to walk over and collect.
   */
  rollAmmoDrop(creep) {
    if (Math.random() >= this.ammoDropChance) return
    const p = creep.mesh.position
    this.city.mana?.addAmmo(this.ammoDropAmount)
    const mesh = new Mesh(this.ammoBoxGeo, this.ammoBoxMat)
    mesh.position.set(p.x, Math.max(0.9, creep.baseY), p.z)
    mesh.rotation.y = Math.PI / 4
    mesh.scale.setScalar(0.01)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.ammoBoxes.push({ mesh, life: 0, y0: mesh.position.y })
    this.city.floatingText?.spawn(
      p.x, Math.max(0.9, creep.baseY) + 1.8, p.z,
      `+${this.ammoDropAmount}`, AMMO_COLOR, 0, 'good'
    )
  }

  /** Pop the ammo cubes in, float them up, fade them out. */
  updateAmmoBoxes(dt) {
    const LIFE = 1.1
    for (let i = this.ammoBoxes.length - 1; i >= 0; i--) {
      const b = this.ammoBoxes[i]
      b.life += dt
      const f = b.life / LIFE
      if (f >= 1) { this.scene.remove(b.mesh); this.ammoBoxes.splice(i, 1); continue }
      // Pop to full in the first 20%, then drift up and shrink away.
      const pop = Math.min(1, f / 0.2)
      b.mesh.scale.setScalar((1 - (1 - pop) * (1 - pop)) * (1 - f * 0.55))
      b.mesh.position.y = b.y0 + f * 2.4
      b.mesh.rotation.y += dt * 2.4
    }
  }

  /**
   * Body radius of a creep in world units - the half-extent of its cube, which
   * is what its live mesh scale already is. Everything that measures "am I
   * touching this creep" goes through here, because a flat radius silently
   * means "2 units inside a giant" and units walk into bosses.
   */
  static radiusOf(c) {
    return (c && c.mesh && c.mesh.scale && c.mesh.scale.x) || 0.7
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
    Sounds.play('shoot', 0.5, 0.2, 0.27)
  }

  /** Laser creep: hitscan a tower for laserDamage + flash a turret-style beam. */
  fireLaser(c, target) {
    this._beamFrom.set(c.mesh.position.x, c.baseY + 0.4, c.mesh.position.z)
    this.towerWorld(target, this._sv)
    const ty = Math.max(0.5, target.numFloors * 0.5) * this.city.floorHeight
    this._beamTo.set(this._sv.x, ty, this._sv.y)
    this.spawnBeam(this._beamFrom, this._beamTo, this.creepLaserColor)
    for (let n = 0; n < this.laserDamage; n++) this.city.renderer.damageTower(target)
    Sounds.play('shoot', 0.6, 0.2, 0.3)
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
    this._audioWave = -1
    this._cuedWave = -1
    this._bossCuedWave = -1
    this._waveActiveNow = false
    this._riser = null
    this._riserWave = -1
    this._quietTimer = 0
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
    this.updateWaveAudio(dt)
    this.updateEntries()

    this.updateShieldBarriers()
    this.updateShots(dt)
    this.updateAmmoBoxes(dt)
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
            // It rolls for ammo like any other death: with turrets dry, creeps
            // reaching your walls become the way back into ammo, so running out
            // is a setback rather than an unrecoverable state.
            this.rollAmmoDrop(c)
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
      if (this._kingWarnTimer <= 0) { Sounds.play('alert2', 1.0, 0, 0.7); this._kingWarnTimer = 1.5 }
    } else {
      this._kingWarnTimer = 0 // ready to fire the instant a creep gets close again
    }
  }
}
