import {
  Mesh,
  BoxGeometry,
  MathUtils,
  Raycaster,
  SphereGeometry,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
  Color,
} from 'three/webgpu'
import { Sounds, BOSS_HORN_PREROLL, MAX_RISER_PREROLL } from './lib/Sounds.js'
import { isShield, shieldCharges, shieldRadiusCells, KING_WARN_CELLS } from './blockTypes.js'
import { SHIELD_LINE } from './palette.js'

// Flyers read as smaller than ground creeps - they are further from the camera
// and not a thing you can wall against, so they should not loom.
const BOMBER_SCALE = 0.7

// Cell-neighbour offsets, in the same order for both axes (right, left, down, up).
const STEP_DX = [1, -1, 0, 0]
const STEP_DZ = [0, 0, 1, -1]
// How often a creep takes a step that doesn't get it closer - a wander, not
// broken pathfinding. Off for now: with it on, creeps visibly drift off a clear
// line to the king. The random tie-break in pickFlowStep still spreads a column
// into staircases without ever costing a step.
const MISSTEP_CHANCE = 0

// Swarming. A wave used to arrive as an even trickle from random points down a
// whole side, which read as weather rather than as an attack - nothing to brace
// for and nothing to aim at. Creeps now arrive in clumps: several at once, from
// one spot, then a lull.
const SWARM_SIZE = [4, 9] // target creeps per clump - sets how MANY clumps a
// wave splits into, not how big any one of them is (see _planWave)
// ...but never so few clumps that a wave arrives all at once.
const MIN_SWARMS = 3
const SWARM_SPREAD_CELLS = 2.5 // cells either side of the clump's entry point
const SWARM_GAP = 0.11 // seconds between creeps inside one clump
const SWARM_SLOT_SPAN = 0.85 // clump slots stop this far through the attack window
// Clear seconds between one swarm finishing its pour and the next starting. A
// swarm is the unit the wave is read in, so two of them running together read
// as one shapeless push - the lull is what makes them countable.
const SWARM_LULL = 0.8

// Creeps claim the cell they are walking into and won't enter a claimed one, so
// a swarm queues rather than stacking. After this many blocked attempts a creep
// barges through anyway - see planStep.
const MAX_WAIT_STEPS = 20

// Shots a shooter or laser creep gets before it burns out. A magazine, so one
// that nothing can reach can't stall the round forever.
const MAX_CREEP_SHOTS = 12

// The horn each clump after the first announces itself with. Pitched above the
// wave horn (1.0) and well under its volume (0.55).
const SWARM_HORN_RATE = 1.35
const SWARM_HORN_VOLUME = 0.3

// What a shield perimeter burns a creep for on its own - the rate an unsupported
// shield has always run at. Each support tower reaching it adds another point
// (see EnergySystem.shieldBonus).
const SHIELD_DAMAGE = 1
// Damage the king's own ring does to a creep crossing into it. Unlike a shield
// it has no charges to spend, so it burns every arrival for the whole run.
const KING_RING_DAMAGE = 2
// Health a creep loses for each floor it knocks down. Walls charge an entry fee
// rather than being free to chew through.
const WALL_BITE = 2
// Damage one dropped bomb does to the tower it lands on - the same heavy hit a
// creep laser lands, and twice what a bite is worth.
const BOMB_DAMAGE = 2
// Damage one melee bite does to the block it lands on. This is the unit the
// rest of the numbers are priced against: a block has 3 hit points, so three
// bites cost a floor.
const BITE_DAMAGE = 1

// What a big creep shrinks to once it is down to half health: 0.5 of its spawn
// size, which is exactly a normal marcher.
const BIG_HURT_SCALE = 0.5

// Damage flash: hot orange, and how long it lingers.
const HIT_FLASH_COLOR = 0xff7a1a
const HIT_FLASH_TIME = 0.14
// ...and the rattle that goes with it. A tilt rather than a positional nudge:
// the march rewrites mesh.position outright every frame, so an offset would be
// erased on marching creeps and accumulate into a random walk on stationary
// ones. Nothing else touches a creep's X/Z rotation, so it is free to use.
const HIT_SHAKE_TIME = 0.18
const HIT_SHAKE_ANGLE = 0.3 // radians of tilt at the start of the shake

// Seconds a creep glows shield-yellow after a barrier burns it.
const SHIELD_FLASH_TIME = 0.28
import { Buffs } from './buffs.js'
import { fxMaterial, glow, unglow, NO_AO_MRT } from './fx.js'
import { BeamPool } from './lib/BeamPool.js'
import { advanceHop, towerWorldCenter } from './lib/gridUnit.js'
import { WaveAudio } from './systems/WaveAudio.js'
import { WaveClock } from './systems/WaveClock.js'

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
    // Two kinds of creep, and the colour is the tell:
    //   SMASHERS (near-black) bulldoze - a straight line at the king, attacking
    //     whatever stands on it, so your walls are something they chew through.
    //   SEEKERS (purple) read the flow field - they thread the gaps you left to
    //     reach the king, and peel off to a generator if you have sealed it.
    // Half a wave is each, and every giant is a smasher.
    this.smasherMat = new MeshStandardNodeMaterial({
      color: new Color(0x1a1a20),
      roughness: 0.55,
      metalness: 0,
    })
    this.seekerMat = new MeshStandardNodeMaterial({
      color: new Color(0x7b2ff7),
      roughness: 0.55,
      metalness: 0,
    })
    // F-mode type dot above each creep: red = smasher, green = seeker.
    // depthTest off so it stays visible even when the creep is behind a tower.
    this.dotGeo = new SphereGeometry(0.34, 12, 8)
    this.dotSmasherMat = new MeshBasicNodeMaterial({ color: new Color(0xff2020), depthTest: false })
    this.dotSeekerMat = new MeshBasicNodeMaterial({ color: new Color(0x22ff22), depthTest: false })

    // Laser creeps: stop at range and fire a turret-style beam at towers.
    this.laserMat = new MeshStandardNodeMaterial({ color: new Color(0xb01f4a), roughness: 0.4, metalness: 0.15 })
    this.creepLaserColor = new Color(0xff2e5e) // the beam colour
    this.laserDamage = 2 // heavier than a bite: two of these take a block
    this.beamPool = new BeamPool(scene, { radius: 0.16, duration: 0.16 })
    this._beamFrom = new Vector3()
    this._beamTo = new Vector3()
    // Shooter creeps read deep orange so they're distinguishable from marchers;
    // seeker shooters are a lighter orange (matching the body lightness rule).
    this.shooterSmasherMat = new MeshStandardNodeMaterial({
      color: new Color(0xd2531e),
      roughness: 0.5,
      metalness: 0,
    })
    this.shooterSeekerMat = new MeshStandardNodeMaterial({
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

    // The wave schedule lives in WaveClock; this file owns what SPAWNS, not when.
    this.clock = new WaveClock()

    // The wave currently being poured out: a plan drawn up when the attack phase
    // opens (see _planWave), and the clumps from it that are mid-release.
    this._plan = null
    this._planIndex = 0
    this._released = 0
    this._bombers = null
    this._bomberIndex = 0
    this._active = []

    // Creeps in a wave, as a straight line: creepsBase at level 1, plus
    // creepsPerWave for every level after. Uncapped.
    //
    // The line used to be 8 + 7n, which roughly DOUBLED the opening levels
    // against the spawn-gap curve it replaced (that one gave ~7, 8, 10, 11 for
    // levels 1-4 against 8, 15, 22, 29). The reason for the rewrite was the far
    // END of the old curve - a gap ramp is a hyperbola in count, so level 7
    // alone added more creeps than levels 1-6 together - and the early numbers
    // came along for the ride. 6 + 3n keeps the straight line and puts the first
    // few levels back where they were; the per-creep health and swing ramp
    // (hpPerWave / attackPerWave) is what carries the late game.
    this.creepsBase = 6
    this.creepsPerWave = 3

    // Creeps left alive past the spawn window eat into the next build phase -
    // the following wave still lands on schedule - so a slow clear costs you
    // build time rather than delaying anything.
    this._lastWave = -1 // last wave index seen (for boss-wave edge detection)

    // Wave audio: a ticking clock fills the breather, then a horn lands on the
    // spawn. Leads are in seconds before the wave starts; the clock bed is
    // seeked so its last tick falls on zero (see Sounds.countdown).
    // The clock runs for this long before a wave, and the riser lands its peak
    // on the spawn inside that window: ~5.5s of riser over the tail of a normal
    // wave's 10s ticker, ~10.7s over a boss's 15s one. The build phase is 60s,
    // so there's still plenty of quiet breather to build in.
    // Boss waves keep the longer lead on purpose: their riser peaks at ~10.7s,
    // so a 10s lead would start the swell before the clock and leave no
    // ticker-only phase at all on the biggest moment of the run.
    // Everything about what a wave SOUNDS like lives in WaveAudio; this file
    // owns the clock it reads.
    this.audio = new WaveAudio(this)
    // Seconds of near-silence after the last creep of a round dies, before the
    // build bed comes back. The round-clear sting needs somewhere to land, and
    // the upgrade screen (if one is due) opens inside this gap.
    this.roundEndQuiet = 2.2
    this._quietTimer = 0
    this.bigChance = 0.1 // fraction of creeps that are big (once they unlock)
    this.bigUnlockWave = 1 // no big creeps before this wave (level 2)
    // Fraction of creeps that are SMASHERS: a greedy beeline at the king through
    // whatever is in the way. The rest are seekers, who path around it.
    this.smasherChance = 0.5

    // Shooter creeps: stop at range and lob little blocks at towers.
    this.shooterChance = 0.1 // fraction of creeps that are shooters
    this.shooterUnlockWave = 3 // shooters from level 4

    // Laser creeps: stop at range and fire a turret-style beam at towers.
    this.laserChance = 0.1
    this.laserUnlockWave = 3 // same level as shooters

    // Bomber creeps: fly across the map at altitude and carpet-drop bombs.
    this.bomberChance = 0.1 // fraction of creeps that fly in as bombers
    this.bomberUnlockWave = 2 // bombers from level 3, between bigs and shooters
    this.bomberY = 14 // flight altitude (world units)
    this.flySpeed = 16 // horizontal flight speed (world units/sec)
    this.bombInterval = 1.3 // seconds between bomb drops
    this.bombGravity = 32 // bomb fall acceleration (world units/sec^2)
    this.shootRange = 5 * this.city.cellUnit // 5 cells, world units
    this.shootInterval = 2.8 // seconds between shots
    this.shotSpeed = 28 // shot travel speed (world units/sec)

    this.stepDuration = 0.30 // seconds to move one cell
    this.hopHeight = 0.6
    // Spawn ring: one lot outside whatever part of the board is currently open.
    // It is a SQUARE ring (creeps appear at x = +/-reach or z = +/-reach), so it
    // only has to clear the half-extent, not the corner distance.
    //
    // It TRACKS the play area rather than sitting at a fixed radius: the board
    // opens up a ring at a time as boss rounds are cleared, and creeps should
    // always walk in from just beyond the edge you can see - not from where the
    // edge used to be, and not from out in the dark.
    this.onBoardResized()

    this.knockInterval = 0.45 // seconds between knocks, for a normal creep at level 1
    // One rule for all combat: attacks carry damage, things have hit points, and
    // damage accumulates until it covers them. A regular creep bite is 1 damage
    // and a block has 3 hit points, so three bites cost a floor.
    //
    // 4 is what a regular creep is worth against the turret line: a peg shot is
    // 1 damage, so it takes four of them, and that is the number the fire rates
    // were priced against. Bigs and giants are the same creep with more of it
    // (x2 and x8 below), and the per-level ramp multiplies this rather than
    // replacing it.
    this.hitPoints = 4 // damage needed to destroy a regular creep

    /**
     * Per-creep difficulty ramp, straight-line and uncapped: a creep is
     * (1 + level x rate) times its base. Waves already arrive thicker over time
     * (see creepsThisWave), but each individual creep used to be identical at
     * wave 30 to wave 1 - so a city that could hold once could hold forever, and
     * the only pressure was volume.
     *
     * Additive, not compounding, so the curve stays readable: level 10 is 2.4x,
     * not 4.4x. These used to stop at 3x, which combined with a spawn-rate floor
     * meant the game reached a steady state you could hold forever.
     */
    this.hpPerWave = 0.16 // +16% of base health per level
    this.attackPerWave = 0.14 // +14% of base swing rate per level

    this._p = new Vector2()
    this._sv = new Vector2()
    this._black = new Color(0x080808)
    // One shared material for the burn flash. Creeps already share materials by
    // TYPE, so tinting a creep's own material would light up every creep of that
    // type at once; swapping the reference is per-creep and allocates nothing.
    this.shieldFlashMat = new MeshStandardNodeMaterial({
      color: new Color(SHIELD_LINE),
      emissive: new Color(SHIELD_LINE).multiplyScalar(0.7),
      roughness: 0.4,
      metalness: 0,
    })
    // Both flash materials get drawn into the glow target, which has two colour
    // attachments - a material with no mrtNode writes one, and a pipeline whose
    // outputs don't cover the attachments takes the whole command buffer down.
    this.shieldFlashMat.mrtNode = NO_AO_MRT()
    // Ordinary damage flash: hot orange, bright enough to bloom. Creeps are near
    // black, so a hit had no visual tell at all beyond the stone thunk - you
    // could not see which of a dozen creeps your turrets were actually working
    // on. Emissive over 1 puts it on the glow layer's side of the threshold.
    this.hitFlashMat = new MeshStandardNodeMaterial({
      color: new Color(HIT_FLASH_COLOR),
      emissive: new Color(HIT_FLASH_COLOR).multiplyScalar(1.4),
      roughness: 0.4,
      metalness: 0,
    })
    this.hitFlashMat.mrtNode = NO_AO_MRT()
  }

  /**
   * Re-derive the spawn ring after the play area grows. Called by City.
   * One lot of run-up outside the visible edge - enough to see them coming and
   * for the arrows to point somewhere, without a long walk in.
   */
  onBoardResized() {
    this.fieldHalf = this.city.visibleHalf
    this.reach = this.fieldHalf + this.city.cellSize
  }

  // --- wave schedule: all of it lives in this.clock -------------------------
  get elapsed() { return this.clock.elapsed }
  set elapsed(v) { this.clock.elapsed = v }
  get wavePeriod() { return this.clock.wavePeriod }
  get waveActive() { return this.clock.waveActive }
  get waveNumber() { return this.clock.waveNumber }
  get waveProgress() { return this.clock.progress }
  get isSpawning() { return this.clock.isSpawning }
  isBossWave(n) { return this.clock.isBossWave(n) }
  bossOrdinal(n) { return this.clock.bossOrdinal(n) }
  waveEdges(n) { return this.clock.waveEdges(n) }

  /** Health and attack multipliers for a creep spawning right now. */
  rampMul() {
    const w = this.waveNumber
    return {
      hp: 1 + w * this.hpPerWave,
      atk: 1 + w * this.attackPerWave,
    }
  }

  /**
   * How many creeps this wave sends - a straight line in the LEVEL number.
   *
   * This is the number the player actually experiences, so this is the number
   * that gets ramped. It used to be derived the other way round: the gap between
   * spawns was ramped linearly and the count fell out as waveActive/gap. But a
   * count is the reciprocal of a gap, so a straight line in one is a hyperbola
   * in the other - every level subtracted the same 0.33s, which was a 14% cut
   * early on and a 45% cut by level 7. Levels 1-6 added 18 creeps between them;
   * level 7 alone added 22, and it landed like a wall.
   *
   * Boss levels get their bump from spawnBossWave, which drops its giants and
   * escorts ON TOP of this - so the every-fourth-level spike is a separate,
   * deliberate thing rather than an accident of the curve.
   */
  get creepsThisWave() {
    return this.creepsBase + this.creepsPerWave * this.waveNumber
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
    const w = this.waveNumber
    const big = !giant && !forceShooter && w >= this.bigUnlockWave && Math.random() < this.bigChance
    // Shooters stop at range and lob little blocks at towers.
    const shooter = !giant && (forceShooter || (!big && w >= this.shooterUnlockWave && Math.random() < this.shooterChance))
    // Laser creeps stop at range and fire a turret-style beam at towers.
    const laser = !giant && !forceShooter && !big && !shooter && w >= this.laserUnlockWave && Math.random() < this.laserChance
    // Bombers fly across at altitude and drop bombs.

    // Heads-up blips for the two threats you can't just out-wall: a bright high
    // one for the airborne bomber, a sharper mid one for the laser. Fixed per
    // type (not randomised) so they stay learnable, and quiet enough to sit
    // under the wave horn. Sounds.js rate-limits them, so a burst of bombers
    // gives one warning rather than five.
    const ramp = this.rampMul()

    const scale = giant ? 3 : (big ? 1.4 : 0.7)
    const baseY = giant ? 3 : (big ? 1.5 : 0.8)

    // Giants are always smashers - too big to use the gaps a seeker threads.
    const smasher = giant ? true : Math.random() < this.smasherChance
    const bodyMat = giant ? this.giantMat
      : laser ? this.laserMat
        : shooter ? (smasher ? this.shooterSmasherMat : this.shooterSeekerMat)
          : (smasher ? this.smasherMat : this.seekerMat)
    const mesh = new Mesh(this.geo, bodyMat)
    mesh.castShadow = true
    mesh.scale.setScalar(scale)
    mesh.rotation.y = Math.PI / 4 // diamond footprint, off-grid

    // Pick a point along one of the four map edges (forced for boss groups).
    // opts.offset pins the along-edge coordinate so a swarm arrives as a clump
    // instead of being scattered down the whole side; without it, anywhere.
    const r = this.reach
    const t = opts.offset === undefined
      ? this.snap((Math.random() * 2 - 1) * r)
      : this.snap(MathUtils.clamp(
        opts.offset + MathUtils.randFloatSpread(SWARM_SPREAD_CELLS * this.cell), -r, r))
    const edge = opts.edge ?? this.currentWaveEdge()
    let x, z
    if (edge === 0) { x = -r; z = t }
    else if (edge === 1) { x = r; z = t }
    else if (edge === 2) { x = t; z = -r }
    else { x = t; z = r }
    x = this.snap(x)
    z = this.snap(z)

    mesh.position.set(x, baseY, z)
    this.scene.add(mesh)

    // F-mode type dot above the creep (red = smasher, green = seeker).
    // Counter-scaled so it reads the same on big/small creeps.
    const typeDot = new Mesh(this.dotGeo, smasher ? this.dotSmasherMat : this.dotSeekerMat)
    typeDot.position.set(0, 2.6, 0)
    typeDot.scale.setScalar(1 / scale)
    typeDot.renderOrder = 11
    typeDot.visible = !!this.city.flow.debugEnabled
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
      // updateEntries) - not fired at spawn, which happens off the board. Three
      // tiers, so what arrived is audible without looking: rank-and-file get
      // creep-alert, bigs the heavier creep-alert-2, and a giant the horn.
      entered: false,
      baseScale: scale, // spawn size; giants shrink from this as they take hits
      baseYSpawn: baseY, // resting height at spawn size, scaled down alongside it
      // A giant crossing onto the board gets the viking call - it is the one
      // arrival worth stopping to look at, and a short blip undersold it. Bigs
      // keep the blip, normal creeps the quiet warn.
      entrySound: giant ? 'horn3' : (big ? 'creep-alert-2' : 'creep-alert'),
      entryRate: giant ? 0.85 : (big ? 0.7 : 1.0),
      entryVol: giant ? 0.8 : (big ? 0.31 : 0.22),
      shootTimer: 0,
      shotsFired: 0,
      baseY,
      // Cells on a side this body claims in the occupancy register. A giant is
      // six world units across and a big nearly three, so one cell each let
      // marchers walk straight through them.
      cellSpan: giant ? 3 : (big ? 2 : 1),
      maxHits: Math.max(1, Math.round(
        (giant ? this.hitPoints * 8 : (big ? this.hitPoints * 2 : this.hitPoints))
        * Buffs.creepHp * ramp.hp
      )),
      // Every bite is BITE_DAMAGE, whatever the creep. Size and level buy a
      // FASTER swing rather than a bigger one: floors-per-hit multiplied out badly, because it
      // multiplied against the attack ramp too - by level 12 a big took a whole
      // five-storey tower off in a single blow, which is a deletion, not a
      // fight. Speed scales the same pressure without the discontinuity.
      //
      // Giants swing at the same 2x as bigs, not 4x. At 4x their rate compounded
      // with the level ramp into a level-16 giant stripping a five-storey tower
      // in half a second - two independent 4x advantages multiplying. Their 8x
      // health is what makes them a boss; the swing does not need to as well.
      attackRate: giant || big ? 2 : 1, // swings per second, relative to normal
      atkSpeed: ramp.atk, // the level ramp, also a rate
      stepMul: giant ? 1.8 : 1, // giants lumber slower (was 2.2 - turrets got too long on them)
      smasher,
    })
  }

  /** Boss wave: a same-side group of `bossOrdinal` giants + 5 shooter buddies. */
  /**
   * Boss group. The escort and the giants' toughness both scale with the boss
   * ordinal, because a FIXED group stops being a spike: normal waves grow from
   * 12 creeps to hundreds, so 1-3 giants plus 5 shooters went from a serious
   * threat to noise. Boss 1 used to be easier than the ordinary wave two later.
   */
  spawnBossWave(waveIdx) {
    const o = this.bossOrdinal(waveIdx)
    const edge = this.waveEdges(waveIdx)[0] // all come in from the same side
    // Just the giants. A boss round is an ordinary round with bosses ADDED - it
    // used to also throw in 3 + 4n shooter escorts, which made boss levels a
    // spike in ordinary creeps as well and muddied what the round actually was.
    // The normal wave still runs alongside this on its usual schedule.
    for (let i = 0; i < o; i++) this.spawn({ giant: true, edge })
  }

  /**
   * Where along an edge a clump enters.
   *
   * Two random numbers rather than one, which gives a triangular distribution
   * peaked at the middle of the side. Flat, clumps landed out by the corners as
   * often as in front of you - so the arrow pointed at a side while the creeps
   * came in around its far end. Measured against the visible half, not the spawn
   * ring, so nothing enters beyond the board's own corners.
   */
  edgeOffset() {
    const spread = (Math.random() + Math.random() - 1) // -1..1, peaked at 0
    return this.snap(spread * this.fieldHalf)
  }

  /** An edge for a creep spawning in the wave now in progress. */
  currentWaveEdge() {
    const edges = this.waveEdges(this.waveNumber)
    return edges[Math.floor(Math.random() * edges.length)]
  }

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
      // Laser creeps used to double up with alert2 here; that sound is the
      // king-in-danger siren and nothing else now, so it can't be diluted by a
      // routine arrival.
      if (c.bomber) Sounds.play('flyer-warn', 1.0, 0.03, 0.22)
    }
  }

  /**
   * Shield barriers: a creep that crosses a shield's perimeter is burned for
   * SHIELD_DAMAGE and spends one of the shield's charges. Each support tower
   * reaching the shield adds a point of burn - see EnergySystem.shieldBonus().
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
      if (shieldCharges(t) <= 0 || city.upkeep.isDark(t)) continue
      const c = t.box.getCenter(this._shieldC || (this._shieldC = new Vector2()))
      const r = shieldRadiusCells(t.numFloors) * cu
      this.burnRing(
        t, c.x + city.gridOffsetX, c.y + city.gridOffsetZ, r,
        // Charges are spent either way; support trails only make the burn hotter.
        SHIELD_DAMAGE + city.energy.shieldBonus(t),
        () => {
          t.shieldUsed = (t.shieldUsed || 0) + 1
          if (shieldCharges(t) > 0) return false
          // Spent: the ring goes dark and the barrier stops burning.
          Sounds.play('power-down', 1.2, 0.05, 0.45)
          city.onTowerChanged(t)
          return true // stop scanning: this barrier is done
        }
      )
    }
  }

  /**
   * The king's own barrier: the yellow ring on the ground is a real perimeter,
   * not a label for the siren's radius.
   *
   * Same rule as a shield, without the charges - the king cannot be topped up,
   * and a last line that runs out is a last line that isn't there when it counts.
   * It is the only defence a bare king has, so a wave that walks the whole way in
   * arrives already burned.
   */
  updateKingBarrier() {
    const city = this.city
    const king = city.king
    if (!king || !king.visible || !city.kingAlive) return
    const c = king.box.getCenter(this._shieldC || (this._shieldC = new Vector2()))
    this.burnRing(
      king, c.x + city.gridOffsetX, c.y + city.gridOffsetZ,
      KING_WARN_CELLS * city.cellUnit, KING_RING_DAMAGE
    )
  }

  /**
   * Burn every creep that crosses INTO the circle (owner, sx, sz, r) this frame.
   *
   * Inward crossings only, and only for creeps seen outside first: the previous
   * side is remembered per owner on the creep, so raising a barrier over creeps
   * already inside it doesn't burn them, and standing on the line doesn't burn
   * them over and over.
   *
   * `onBurn` runs after each burn; returning true stops the scan (a shield that
   * has just spent its last charge). Returns true if it stopped early.
   */
  burnRing(owner, sx, sz, r, dmg, onBurn) {
    // Backwards: hit() can kill and splice the creep out from under us.
    for (let i = this.creeps.length - 1; i >= 0; i--) {
      const cr = this.creeps[i]
      if (cr.bomber) continue // flies over the barrier
      const dx = cr.mesh.position.x - sx, dz = cr.mesh.position.z - sz
      const inside = (dx * dx + dz * dz) < r * r
      if (!cr.shieldIn) cr.shieldIn = {}
      const was = cr.shieldIn[owner.id]
      cr.shieldIn[owner.id] = inside
      if (!inside || was !== false) continue

      // Its own sound, not the generic alert blip: a barrier burn was the one
      // damage source with no audible identity of its own - hit() plays the
      // same stone thunk for it as for a bullet.
      Sounds.play('shield-hit', 1.0, 0.08, 0.8)
      this.burnFlash(cr)
      this.hit(cr, dmg)
      if (onBurn && onBurn()) return true
    }
    return false
  }

  /** Spawn a bomber: enters from one edge, flies straight across at altitude. */
  spawnBomber() {
    const r = this.reach
    const mesh = new Mesh(this.geo, this.bomberMat)
    mesh.castShadow = true
    mesh.scale.setScalar(BOMBER_SCALE)

    // Enter anywhere on the ring and cross to the far side, aimed just off the
    // centre. They used to fly one of four axis-aligned lanes, so every bomber
    // run looked like the last and you could learn the four lines; a free
    // heading means the diagonal crossings are the common case.
    const angle = Math.random() * Math.PI * 2
    const x = Math.cos(angle) * r
    const z = Math.sin(angle) * r
    const aim = this.city.lotSize * 0.4
    const dx = (Math.random() * 2 - 1) * aim - x
    const dz = (Math.random() * 2 - 1) * aim - z
    const len = Math.hypot(dx, dz) || 1
    const vx = (dx / len) * this.flySpeed
    const vz = (dz / len) * this.flySpeed

    mesh.position.set(x, this.bomberY, z)
    // Yaw onto the heading; the 45deg tilts are what give the body its diamond
    // silhouette from above.
    mesh.rotation.set(Math.PI / 4, Math.atan2(dx, dz), Math.PI / 4)
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
      entrySound: 'creep-alert',
      entryRate: 0.8,
      entryVol: 0.3,
      vx, vz,
      bombTimer: this.bombInterval * 0.5,
      bob: Math.random() * Math.PI * 2,
      shootTimer: 0,
      baseY: this.bomberY,
      maxHits: Math.max(1, Math.round(this.hitPoints * Buffs.creepHp * this.rampMul().hp)),
      attackRate: 1,
      atkSpeed: 1,
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
        if (tower) this.city.renderer.damageTower(tower, BOMB_DAMAGE)
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
    return towerWorldCenter(tower, this.city, out)
  }

  /** Distance (world units) from a world point to a tower's footprint edge. */
  /**
   * How close a creep's CENTRE may get to a tower's box before it stops and
   * attacks. Small creeps keep the old half-cell; anything bigger stands off by
   * its own body radius plus a little clearance for the lunge, so a giant hits
   * the wall from outside it instead of standing a metre inside the block it's
   * demolishing. Giants shrink as they're damaged, so a hurt one closes in.
   */
  /**
   * Seconds between this creep's blows.
   *
   * Both scalars are RATES - bigger means faster - so they divide. Naming them
   * as multipliers on the interval instead reads backwards, which is how a 4x
   * giant got tuned in without anyone noticing what it multiplied out to.
   */
  knockTime(c) {
    return this.knockInterval / ((c.attackRate || 1) * (c.atkSpeed || 1))
  }

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
    // Shooters and lasers stand off and fire, so they need a clear line; melee
    // creeps attack whatever they walk into and don't.
    const needLOS = c.shooter || c.laser
    let best = null
    let bestScore = -Infinity
    const tw = new Vector2()
    for (const tower of this.city.towers) {
      if (!tower.visible) continue
      this.towerWorld(tower, tw)
      if (needLOS && !this.hasLOS(c, tower)) continue // shooting through a wall
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
   * Clear line from a creep to a tower - no other tower standing between them.
   *
   * Turrets have had this since they existed (Turrets.hasLOS); the creeps that
   * shoot back did not, so they happily fired through your walls. Same approach:
   * raycast the tower BatchedMesh, with a margin at each end so the shooter's own
   * cell and the target's don't count as blockers.
   */
  hasLOS(c, tower) {
    const mesh = this.city.towerMesh
    if (!mesh) return true
    if (!this._losRay) {
      this._losRay = new Raycaster()
      this._losFrom = new Vector3()
      this._losDir = new Vector3()
    }
    this.towerWorld(tower, this._sv)
    const ty = Math.max(0.5, tower.numFloors * 0.5) * this.city.floorHeight
    this._losFrom.set(c.mesh.position.x, c.baseY + 0.6, c.mesh.position.z)
    this._losDir.set(this._sv.x - this._losFrom.x, ty - this._losFrom.y, this._sv.y - this._losFrom.z)
    const dist = this._losDir.length()
    const margin = this.city.cellUnit * 0.7
    if (dist <= margin * 2) return true
    this._losDir.divideScalar(dist)
    this._losRay.set(this._losFrom, this._losDir)
    this._losRay.near = margin
    this._losRay.far = dist - margin
    return this._losRay.intersectObject(mesh, false).length === 0
  }

  /**
   * Plan the next cell. Two behaviours, decided per creep at spawn:
   *
   *  - SMASHERS (near-black, half the wave, and every giant) bulldoze: a greedy
   *    beeline at the king that stops and smashes whatever stands on the line,
   *    wall or not. They used to do this only when the king was sealed off, so
   *    with an open board every creep in the game was a flow-follower and the
   *    walls you built between them and the king were simply walked around.
   *  - SEEKERS (purple) follow the flow field: around walls to the king if it is
   *    reachable, to the nearest generator if it is not.
   *
   * Returns 'move', 'attack', 'wait' or 'done'.
   */
  planStep(c) {
    const city = this.city
    if (c.smasher) return this._planStepGreedy(c)
    const cell = city.worldToCell(c.toX, c.toZ)
    if (cell && city.flow.ready) {
      const i = cell.gy * city.gridCellsX + cell.gx
      // Big creeps get the wide-corridor field (1-cell gaps closed off).
      const { dist, dx: fdx, dz: fdz } = city.flow.fields(c.big)
      if (dist[i] >= 1) {
        // A creep that has been stuck for a while stops respecting the queue.
        // Two creeps can want each other's cell and each wait on the other, and
        // one stalled creep would hold up everything behind it - better a rare
        // overlap than a column frozen for the rest of the round.
        const desperate = (c.waited || 0) >= MAX_WAIT_STEPS
        const step = this.pickFlowStep(c, cell, i, dist, fdx, fdz, desperate)
        if (!step) { c.waited = (c.waited || 0) + 1; return 'wait' }
        c.waited = 0
        const nx = c.toX + step[0] * this.cell
        const nz = c.toZ + step[1] * this.cell
        // Attack only what is actually IN THE WAY - the tile the creep is about
        // to step into. This used to be a standoff test against every tower on
        // the board, and the standoff (1.1 world units for a normal creep) is
        // wider than the half cell of clearance a road has, so a creep walking
        // past a wall stopped and chewed on it even with an open road to the
        // king. The flow field already routes around walls, so the only tower a
        // flow step can walk into is a goal: the king, or a generator.
        const blocking = this.towerAt(nx, nz)
        if (blocking) { c.target = blocking; return 'attack' }
        this.claimStep(c, nx, nz)
        return 'move'
      }
    }
    return this._planStepGreedy(c)
  }

  /**
   * True if another unit is already walking into the block this creep covers.
   *
   * The register is City.occupancy, shared with the soldiers - a cell holds one
   * unit whatever kind it is, and a body wider than a cell holds several (3x3
   * for a giant, 2x2 for a big). Only bombers are exempt: they are in the air.
   */
  cellTaken(gx, gy, c) {
    if (c && c.bomber) return false
    return this.city.occupancy.taken(gx, gy, c)
  }

  /**
   * Commit a creep to (nx, nz): release the cell it is leaving and claim the one
   * it is entering, straight away, so a creep planned later in the same frame
   * sees this one as taken.
   */
  claimStep(c, nx, nz) {
    const occ = this.city.occupancy
    if (!c.bomber) {
      occ.releaseWorld(c.toX, c.toZ, c)
      occ.claimWorld(nx, nz, c)
    }
    c.fromX = c.toX; c.fromZ = c.toZ; c.toX = nx; c.toZ = nz; c.t = 0
  }

  /**
   * Pick the next cell to step into, given the flow field.
   *
   * The field stores ONE step per cell and its BFS breaks ties in a fixed
   * neighbour order, so every creep crossing a region inherits the same turn.
   * That is what makes them file onto the board's centre axes and march up in a
   * column: anywhere a creep is diagonal from the goal there are TWO neighbours
   * genuinely closer to it, and the field always names the same one, so the path
   * comes out as a long leg along X then a long leg along Z.
   *
   * Choosing between those equally-good neighbours at random turns the same
   * column into a spread of staircases, for free - every step still strictly
   * reduces the distance to the goal, so nothing gets slower or dumber.
   *
   * On top of that, MISSTEP_CHANCE occasionally takes a step that does NOT
   * improve the distance. That is the part that reads as a crowd rather than a
   * queue: it breaks the lockstep that sets in once several creeps do share a
   * corridor. They are walking, not pathfinding, and it costs one cell.
   */
  pickFlowStep(c, cell, i, dist, fdx, fdz, ignoreTaken = false) {
    const W = this.city.gridCellsX, H = this.city.gridCellsY
    const here = dist[i]
    const closer = [], worse = []
    for (let d = 0; d < 4; d++) {
      const nx = cell.gx + STEP_DX[d], ny = cell.gy + STEP_DZ[d]
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const nd = dist[ny * W + nx]
      if (nd < 0) continue // wall, or no path from there
      if (!ignoreTaken && this.cellTaken(nx, ny, c)) continue // someone's already going there
      ;(nd < here ? closer : worse).push(d)
    }
    // Every way forward is either walled or spoken for: hold position and try
    // again next step. Waiting a beat is what makes a swarm queue up behind its
    // own front rank instead of piling into one cell.
    if (closer.length === 0 && worse.length === 0) return null
    const pool = (closer.length === 0 || (worse.length && Math.random() < MISSTEP_CHANCE))
      ? worse : closer
    const pick = pool[Math.floor(Math.random() * pool.length)]
    return [STEP_DX[pick], STEP_DZ[pick]]
  }

  /**
   * Greedy beeline toward the king, smashing through whatever's in the way (one
   * axis at a time). What the smashers - half the wave, plus every giant - walk.
   *
   * It respects the same one-unit-per-cell register the flow-followers do: the
   * preferred axis first, the other axis if that cell is spoken for, and a wait
   * if both are. Without that a bulldozing column walked straight through its
   * own front rank and stacked several creeps on one tile.
   */
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
    const preferX = Math.abs(dx) >= Math.abs(dz)
    let nx = x + (preferX ? Math.sign(dx) * this.cell : 0)
    let nz = z + (preferX ? 0 : Math.sign(dz) * this.cell)
    // The other axis, for when the first choice is rock or spoken for.
    const ax = x + (preferX ? 0 : Math.sign(dx) * this.cell)
    const az = z + (preferX ? Math.sign(dz) * this.cell : 0)
    const altIsStep = ax !== x || az !== z // false when the goal is axis-aligned

    // Rocks are indestructible, so walking into one and attacking it would stall
    // the creep for the rest of the run. Try the other axis instead; if that is
    // rock too (two boulders cornering a creep - rare) take the first step
    // anyway, since a moment of overlap beats a permanent stall.
    if (this.city.rocks.blocksWorld(nx, nz)) {
      if (altIsStep && !this.city.rocks.blocksWorld(ax, az)) { nx = ax; nz = az }
    }

    // Someone is already walking into that cell: take the other axis, or hold.
    // Waiting a beat is what makes a column queue behind its own front rank.
    const occ = this.city.occupancy
    if (occ.takenWorld(nx, nz, c)) {
      const altFree = altIsStep && !this.city.rocks.blocksWorld(ax, az)
        && !occ.takenWorld(ax, az, c)
      if (altFree) { nx = ax; nz = az }
      else if ((c.waited || 0) < MAX_WAIT_STEPS) { c.waited = (c.waited || 0) + 1; return 'wait' }
      // Stuck behind the queue for too long: shove through rather than freeze
      // for the rest of the round.
    }
    c.waited = 0

    // If the next cell is occupied by a standing tower, attack it instead.
    for (const tower of this.city.towers) {
      if (!tower.visible) continue
      if (this.towerDist(tower, nx, nz) < this.attackStandoff(c)) {
        c.target = tower
        return 'attack'
      }
    }

    this.claimStep(c, nx, nz)
    return 'move'
  }

  /**
   * Resize a creep to `f` of its spawn size, keeping it on the ground (baseY
   * tracks the scale) and its type dot at a constant apparent size.
   */
  _rescale(creep, f) {
    const s = creep.baseScale * f
    creep.mesh.scale.setScalar(s)
    creep.baseY = creep.baseYSpawn * f
    if (creep.typeDot) creep.typeDot.scale.setScalar(1 / s)
  }

  /** Apply turret damage; explode + remove the creep once it reaches max HP. */
  hit(creep, dmg = 1) {
    creep.hits += dmg
    this.hitFlash(creep)
    creep.shakeT = HIT_SHAKE_TIME
    // Random stone thunk on every hit (slight pitch variation for variety).
    Sounds.play('stone', 0.9 + Math.random() * 0.3, 0.2, 0.6)
    // Giants visibly wear down: a boss shrinks toward 45% of its spawn size as
    // its health goes, so you can read how close it is from across the map
    // without a health bar. baseY tracks the scale so it stays on the ground,
    // and the type dot is counter-scaled to hold its apparent size.
    if (creep.giant && creep.baseScale) {
      this._rescale(creep, 0.45 + 0.55 * Math.max(0, 1 - creep.hits / creep.maxHits))
    } else if (creep.big && creep.baseScale) {
      // A big does it in one step at half health rather than on a curve: it is
      // small enough that a gradual squeeze reads as nothing, and dropping it to
      // exactly a marcher's size makes "this one is nearly dead" a shape you
      // already know rather than a size you have to compare against its friends.
      if (creep.hits >= creep.maxHits / 2) this._rescale(creep, BIG_HURT_SCALE)
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
    }
    return true
  }

  /** Barrier burn: sparks off the creep and it glows shield-yellow briefly.
   *  update() puts its own material back when the timer runs out. */
  burnFlash(c) {
    const p = c.mesh.position
    this.city.debris?.spawn(p.x, p.y, p.z, 0.5, new Color(SHIELD_LINE), 8)
    if (!c.flashMat) c.flashMat = c.mesh.material // remember what to restore
    c.mesh.material = this.shieldFlashMat
    glow(c.mesh)
    c.flashT = SHIELD_FLASH_TIME
  }

  /**
   * Flash a creep orange for a moment when it takes damage.
   *
   * Swaps the shared material rather than tinting: creeps share one material per
   * TYPE, so tinting would light up every creep of that type at once. A shield
   * burn does the same thing in yellow, and wins if both land - being burned is
   * the rarer event and the one worth reading.
   */
  hitFlash(c) {
    if (c.flashT > 0 && c.mesh.material === this.shieldFlashMat) return
    if (!c.flashMat) c.flashMat = c.mesh.material // remember what to restore
    c.mesh.material = this.hitFlashMat
    glow(c.mesh) // on the bloom layer for as long as the flash lasts
    c.flashT = HIT_FLASH_TIME
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
    this.beamPool.fire(this._beamFrom, this._beamTo, this.creepLaserColor)
    this.city.renderer.damageTower(target, this.laserDamage)
    Sounds.play('shoot', 0.6, 0.2, 0.3)
  }

  /** Light up a pooled beam cylinder stretched from `from` to `to`. */
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
    this.clock.reset()
    this._plan = null
    this._planIndex = 0
    this._released = 0
    this._bombers = null
    this._bomberIndex = 0
    this._active = []
    this._lastWave = -1
    this._quietTimer = 0
    this._exposedAlarm = false
    this.audio.reset()
  }

  /**
   * Advance the wave clock by `dt` and run the spawn schedule: build for
   * buildTime seconds, then spawn for the remaining waveActive.
   */
  advanceSpawns(dt) {
    this.clock.advance(dt)
    if (!this.spawnEnabled) return

    if (!this.isSpawning) {
      this._plan = null // next attack phase draws up a fresh one
      this._bombers = null
      this._active.length = 0
      return
    }

    // First frame of this cycle's attack phase: draw up the wave, and drop a
    // boss group on top if it's a boss round.
    const waveIdx = this.waveNumber
    if (waveIdx !== this._lastWave) {
      this._lastWave = waveIdx
      this._planWave()
      if (this.isBossWave(waveIdx)) this.spawnBossWave(waveIdx)
    }

    const phase = this.clock.cyclePhase - this.clock.buildTime // 0..waveActive
    // Release any swarm whose slot has arrived. Slots are spaced so the previous
    // swarm has finished pouring first (see _planWave), so in practice this
    // releases one at a time - the loop stays a while because a squeezed
    // late-game schedule can still land two on the same frame.
    while (this._plan && this._planIndex < this._plan.length
      && this._plan[this._planIndex].at <= phase) {
      this._release(this._plan[this._planIndex++])
    }

    while (this._bombers && this._bomberIndex < this._bombers.length
      && this._bombers[this._bomberIndex] <= phase) {
      this._bomberIndex++
      this.spawnBomber()
    }

    for (let i = this._active.length - 1; i >= 0; i--) {
      const clump = this._active[i]
      clump.timer += dt
      while (clump.left > 0 && clump.timer >= SWARM_GAP) {
        clump.timer -= SWARM_GAP
        this.spawn({ edge: clump.edge, offset: clump.offset })
        clump.left--
      }
      if (clump.left <= 0) this._active.splice(i, 1)
    }
  }

  /**
   * Draw up this wave: split creepsThisWave into clumps and give each a slot in
   * the attack window.
   *
   * The whole wave is decided up front rather than dribbled out against a
   * running average. That average was the previous approach - a spawn interval,
   * with clump sizes and rests derived from it so the mean rate worked out - and
   * it only ever approximated the intended count, since whatever was mid-pour
   * when the window shut simply never arrived. Planning it means the number that
   * spawns is exactly the number the level says.
   *
   * Slots stop at SPREAD of the way through so the last clump finishes inside
   * the window instead of trailing into your build time.
   */
  _planWave() {
    const total = this.creepsThisWave
    // Decide how many clumps first, then split the wave EVENLY between them.
    //
    // It used to fill clumps greedily off the front - take a random 4..9, repeat
    // until the wave runs out - which left whatever didn't divide as a final
    // clump of its own. On a small level that meant one big swarm followed by a
    // lone creep wandering in, and the last slot of the window (the one that
    // should land while you're busiest) was the emptiest thing in the wave.
    //
    // SWARM_SIZE is now the target size used to pick the COUNT; the actual sizes
    // come out of the division, so every push in a wave is the same weight and
    // the wave never ends on a straggler.
    const target = (SWARM_SIZE[0] + SWARM_SIZE[1]) / 2
    const n = Math.min(total, Math.max(MIN_SWARMS, Math.round(total / target)))
    // Even split; anything left over goes one extra creep per clump from the
    // front, so sizes differ by at most one.
    const sizes = Array.from({ length: n }, (_, i) =>
      Math.floor(total / n) + (i < total % n ? 1 : 0))
    const span = this.waveActive * SWARM_SLOT_SPAN

    // Slot times. Evenly across the window is the shape we want, but a slot is
    // only honest if the previous swarm has finished arriving - so each start is
    // pushed to at least "the one before it has poured, plus a lull". A swarm of
    // 7 takes 7 x SWARM_GAP to come out of the gate; overlapping that with the
    // next one turns two readable pushes into one blur.
    const even = n > 1 ? span / (n - 1) : 0
    const starts = []
    for (let i = 0, t = 0; i < n; i++) {
      starts.push(t)
      t += Math.max(even, sizes[i] * SWARM_GAP + SWARM_LULL)
    }
    // ...and if a late wave has more swarms than the window can hold apart, the
    // whole schedule is squeezed back into the window rather than spilling into
    // the next build phase. That is the one case where they do overlap, and it
    // is the case where the wave is meant to feel relentless anyway.
    const last = starts[n - 1]
    if (last > span) for (let i = 0; i < n; i++) starts[i] *= span / last

    // Round-robin across the wave's edges rather than rolling each clump: with a
    // random pick, a two-front wave could send every clump down one side and
    // leave the other arrow pointing at nothing.
    const edges = this.waveEdges(this.waveNumber)
    this._plan = sizes.map((size, i) => ({
      size,
      at: starts[i],
      edge: edges[i % edges.length],
      offset: this.edgeOffset(),
    }))
    this._planIndex = 0
    this._released = 0

    // Bombers are scheduled here rather than rolled per creep inside a clump.
    // Rolled, they inherited the clumps' timing and arrived in a knot near the
    // start of the wave; a flyer's whole job is to turn up when you are already
    // busy, so they get their own slots evenly across the WHOLE window.
    this._bombers = []
    if (this.waveNumber >= this.bomberUnlockWave) {
      const n = Math.round(total * this.bomberChance)
      for (let i = 0; i < n; i++) {
        const t = ((i + 0.5) / n) * this.waveActive
        this._bombers.push(t + MathUtils.randFloatSpread(this.waveActive / (n * 2)))
      }
    }
    this._bomberIndex = 0
  }

  /** Start a planned clump pouring, and sound its horn. */
  _release(clump) {
    this._active.push({ ...clump, left: clump.size, timer: SWARM_GAP })
    // A war horn per clump, but not the first of a wave: that one lands on the
    // same frame as the wave horn, and two at once is a muddle.
    if (this._released > 0) Sounds.play('horn', SWARM_HORN_RATE, 0.06, SWARM_HORN_VOLUME)
    this._released++
  }

  /**
   * Fast-forward: replay the spawn schedule across `seconds` in fine steps, so
   * every creep that WOULD have spawned in that window is created now - they all
   * arrive at once. Spawn cadence/types ramp with wave progress, so step finely.
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
    if (!this.city.flow.ready || this.city.flowDirty) this.city.flow.compute()
    this.advanceSpawns(dt)
    this.audio.update(dt)
    this.updateEntries()

    // One shared cell register for the frame, rebuilt after this tick's spawns
    // and before anything plans a step. Soldiers are in it too - a cell holds
    // one unit, whatever kind it is.
    this.city.occupancy.rebuild(this.creeps, this.city.soldiers?.soldiers || [])
    this.updateShieldBarriers()
    this.updateKingBarrier()
    this.updateShots(dt)
    this.updateBombs(dt)
    this.beamPool.update(dt)

    // King-proximity siren: warn while any creep is within 3 tiles of the king.
    let kingWX = 0, kingWZ = 0, kingHere = false
    if (this.city.king && this.city.king.visible) {
      this.towerWorld(this.city.king, this._sv)
      kingWX = this._sv.x; kingWZ = this._sv.y; kingHere = true
    }
    // Same radius the yellow ring on the ground draws (City.createKingRing), so
    // the siren fires exactly when a creep crosses the line you can see.
    const warnR = KING_WARN_CELLS * this.cell
    const warnR2 = warnR * warnR
    let creepNearKing = false

    const showTypeArrows = !!this.city.flow.debugEnabled
    for (let i = this.creeps.length - 1; i >= 0; i--) {
      const c = this.creeps[i]
      if (c.typeDot) c.typeDot.visible = showTypeArrows
      // Shield burn fading - hand the creep its own material back.
      if (c.flashT > 0) {
        c.flashT -= dt
        if (c.flashT <= 0 && c.flashMat) {
          c.mesh.material = c.flashMat
          c.flashMat = null
          unglow(c.mesh) // stop blooming once it's back to its own colour
        }
      }
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
          // Shooters carry a magazine. Without one, a shooter parked out of reach
          // of every turret and soldier plinks away for the rest of the run - the
          // round never ends, the music never drops, and there is nothing you can
          // do about it. Spent, it goes up like any other death.
          if (++c.shotsFired >= MAX_CREEP_SHOTS) {
            this.explode(c)
            this.scene.remove(c.mesh)
            this.creeps.splice(i, 1)
          }
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
        const phase = Math.min(1, c.attackTimer / this.knockTime(c))
        const lunge = Math.sin(phase * Math.PI) * this.cell * 0.35
        c.mesh.position.x = c.toX + (dx / len) * lunge
        c.mesh.position.z = c.toZ + (dz / len) * lunge
        c.mesh.position.y = c.baseY

        if (c.attackTimer >= this.knockTime(c)) {
          c.attackTimer -= this.knockTime(c)
          // Every blow goes through damageTower, which owns the one rule for how
          // many knocks a floor costs - creeps used to keep a second count of
          // their own, so a bite that didn't happen to be the third one never
          // reached the tile at all and it sat there unflashed and unshaken
          // while a creep visibly chewed on it.
          if (target.king) {
            Sounds.play('king-hit', 1.0, 0.06, 0.55)
            this.city.flashKing() // visible tell for the one tower that matters
          } else Sounds.play('attack', 1.0, 0.2, 0.6)
          const before = target.numFloors
          const after = this.city.renderer.damageTower(target, BITE_DAMAGE)
          // A floor came off - or the tile was a bare roof and went entirely,
          // which costs the creep the same as any other block.
          if (after < before || !target.visible) {
            // Take the floor and keep going. Creeps used to burst after landing
            // a single one, which made health almost meaningless against your
            // walls: a giant with eight times the hit points still traded itself
            // for exactly one block, same as the weakest creep on the board. Now
            // a creep keeps swinging until something kills it, so HP is what
            // decides how much damage it gets to do.
            //
            // Breaking a floor costs the creep health, the same way a soldier
            // and a creep both bleed when they trade blows. Without it a creep
            // that reached your walls was pure profit for the attacker: it could
            // level a whole city given time, and only your turrets could ever
            // say otherwise. Now a wall is worth something even undefended - it
            // charges an entry fee - while still not being the free one-for-one
            // trade it was when creeps burst after a single floor.
            if (this.hit(c, WALL_BITE)) continue // it died on the last block
            // Its target may have just been destroyed outright - go and find
            // something else rather than swinging at a hole.
            if (!target.visible) { c.state = 'march'; c.target = null; c.t = 1 }
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
        if (r === 'wait') continue // nowhere free to step; hold and retry next frame
        // freshly entered the new cell: footstep
        Sounds.play(Math.random() < 0.5 ? 'step1' : 'step2', 1.0, 0.2, 0.4)
      }

      advanceHop(c, dt, {
        duration: this.stepDuration * (c.stepMul || 1),
        baseY: c.baseY,
        hopHeight: this.hopHeight,
        spin: !c.giant, // giants spin slowly on their own instead
      })
    }

    // Damage rattle, after everything else has moved the creeps - the march
    // writes mesh.position and rotation.y from the path every frame, so this has
    // to be the last word or it gets overwritten on half the creeps and not the
    // other half. Re-rolled per frame, which at 60fps is a fast judder, and
    // eased out by the remaining time so it settles rather than stopping dead.
    for (const c of this.creeps) {
      if (!(c.shakeT > 0)) continue
      c.shakeT -= dt
      const a = c.shakeT > 0 ? (c.shakeT / HIT_SHAKE_TIME) * HIT_SHAKE_ANGLE : 0
      c.mesh.rotation.x = (Math.random() * 2 - 1) * a
      c.mesh.rotation.z = (Math.random() * 2 - 1) * a
    }

    this.updateExposedAlarm()

    // Re-arm / fire the king-proximity siren on a cooldown. Held while the
    // exposed-king alarm is running: same sound, and two of it at once is a
    // mess rather than twice the warning.
    this._kingWarnTimer = (this._kingWarnTimer || 0) - dt
    if (creepNearKing && !this._exposedAlarm) {
      // alert2 rather than a pitched-down 'spawn': this is a threat blip, and it
      // was borrowing a sound whose job is announcing arrivals.
      if (this._kingWarnTimer <= 0) { Sounds.play('alert2', 1.0, 0.04, 0.7); this._kingWarnTimer = 1.5 }
    } else {
      this._kingWarnTimer = 0 // ready to fire the instant a creep gets close again
    }
  }

  /**
   * The king-is-open siren: alert2 on a loop for as long as a fight is running
   * with no wall sealing the king.
   *
   * A state, not an event. Breaching the enclosure already plays a one-shot
   * (Enclosure), but that fires at the moment the hole appears - which is
   * usually while you are building, calmly, with nothing on the board. What
   * matters is going into a wave still open, and that is exactly when nothing
   * was telling you.
   *
   * Off the moment the seal closes or the round ends, so sealing mid-fight is
   * audible as the alarm stopping.
   */
  updateExposedAlarm() {
    const city = this.city
    const battle = this.started && (this.clock.isSpawning || this.creeps.length > 0)
    const open = !!city.king && city.king.visible && city.kingAlive
      && city.enclosure.kingEnclosed === false
    const on = battle && open
    if (on === !!this._exposedAlarm) return // no change
    this._exposedAlarm = on
    if (on) Sounds.loop('alert2', 0.5)
    else Sounds.fadeOut('alert2', 0.3)
  }
}
