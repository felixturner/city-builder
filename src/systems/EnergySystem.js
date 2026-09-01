import { Vector2, Color } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { ENERGY_COLOR } from '../Mana.js'
import { Buffs } from '../buffs.js'
import {
  isPathGenerator, claimsEnclosure, isGrey, towerArea, towerTopY,
} from '../blockTypes.js'

const GEN_INTERVAL = 2 // seconds between generator mana ticks
const GREY_INTERVAL = 5 // seconds between passive grey-block mana ticks
const PULSE_DECAY = 0.8 // seconds for a tower's flash to fade back to baseline
// The enclosure floor gets its own, much faster envelope. Riding the tower's
// 0.8s decay never worked once income became a stream: units can arrive every
// MIN_SPAWN_GAP (0.07s) and each one resets the envelope to 1, so it never got
// near baseline and the floor just sat bright. At 0.22s each arrival reads as a
// distinct blink at ordinary rates, and only a very rich enclosure glows solid.
const FLOOR_PULSE_DECAY = 0.22
// Mana per (enclosed cell x generator floor) for the pink area generators.
// Cut 20% from 0.2: their output scales with enclosed AREA, so it climbs much
// faster than the blue path generators as a city grows.
// 0.08 -> 0.056 (-30%, so a sealed ring plus a couple of support towers stopped
// being enough to make energy a non-issue) -> 0.07 (+25%) -> 0.056 (-20%) once
// PROD_FACTOR had been raised twice and area generators were out-earning again.
const ENCLOSURE_RATE = 0.056
const PATH_RATE = 0.2 // mana per (footprint cell x trail length)
// Volume of the per-arrival income blip. It fires several times a second at a
// developed economy, so it sits well under the one-off cues.
const INCOME_BLIP_VOLUME = 0.54
// Global generator-production scale, multiplying BOTH generator types. Raised
// from 0.2 (+30%) when grey walls stopped generating - generators became the only
// thing producing energy besides the king's trickle - then 0.26 -> 0.325 -> 0.39
// (+25%, then +20%) to pay for levelling up towers, which went from 2 a floor to
// the full tile price once the two were unified.
const PROD_FACTOR = 0.39
// Slow bonus the king trickles every GREY_INTERVAL, separate from what it earns
// by sealing an enclosure. Smaller than the old flat income now that the king
// has a real earning mechanic - it's the floor you can recover from, not a wage.
const KING_BONUS = 4
// Income arrives one unit at a time rather than as a lump, so a generator's
// output is audible as a RATE: 2 energy a tick trickles, 12 rattles.
//
// The cadence is derived from the amount (one unit per span/amt), floored at
// MIN_SPAWN_GAP so a huge generator can't spawn hundreds of captions. Capping
// the COUNT instead - which is what this used to do - flattened the cadence:
// everything at or above the cap emitted at exactly the same speed and only the
// number on the caption changed, so big generators stopped sounding bigger.
// What a building runs at with no support tower linked to it. Blue path
// generators are the supply network: they still produce energy themselves, and
// now a trail reaching a turret, area generator or shield is what brings that
// building up to full speed.
const SUPPORT_PENALTY = 0.5
// Path generators are blue; the connect burst reads as coming from them.
const SUPPORT_ACCENT = 2

const MIN_SPAWN_GAP = 0.07 // seconds between units at full tilt
const MAX_SPAWNS_PER_TICK = 40 // hard backstop on captions per tower per tick

/**
 * EnergySystem - all energy generation and the visual/audio feedback for it.
 *
 *  - Path generators (plus blocks) connect to same-colour neighbours within
 *    combined-height reach, drawing trails and generating height*area mana.
 *  - Adjacency generators (hole blocks) form orthogonal clusters; each cluster
 *    is one unit that generates 1 mana per built member and glows together.
 *  - Grey walls generate nothing; they only raise the energy cap.
 *
 * Each generating unit schedules a "flash" at a random offset within the tick
 * so its glow, "+N" caption and sound all fire together but stagger across the
 * cycle (see pulseEvents).
 */
export class EnergySystem {
  constructor(city) {
    this.city = city

    // Path generators (trail-connected plus blocks)
    this.pathGenMana = 0
    this.pathGenContribution = new Map() // tower -> its share of the tick
    this.connectedTowers = new Set()
    this.activeConnectorCount = 0
    this._connectorSig = null
    this._connectorKeys = null

    // Enclosure generators (sealed inside a coloured enclosure)
    this.enclosureGenMana = 0
    this.enclosureGens = [] // built enclosure generators producing mana

    // Scheduled flashes: {members, t, amt, sound, color, cx, cy, cz}
    this.pulseEvents = []
    this.floorPulse = 0 // enclosure-floor flash envelope (own decay, see above)
    this.manaTimer = 0
    this.greyManaTimer = 0

    this._pulseColor = new Color()
    this._ca = new Vector2()
    this._cb = new Vector2()
    this._size = new Vector2()
    this._c = new Vector2()
  }

  /** A building just came under a support tower: ring out from it and label the
   *  speed it just gained. */
  announceSupport(t) {
    const city = this.city
    const c = t.box.getCenter(this._c)
    const x = c.x + city.gridOffsetX, z = c.y + city.gridOffsetZ
    const color = city.accentColors[SUPPORT_ACCENT]
    city.spawnSupportRing?.(x, z, color)
    city.floatingText?.spawn(
      x, towerTopY(t, city.floorHeight) + 1.0, z,
      `x${Math.round(1 / SUPPORT_PENALTY)}`, `#${color.getHexString()}`, 0, 'gen-online'
    )
  }

  /**
   * Support factor for a building: 1 when a support tower's trail reaches it,
   * SUPPORT_PENALTY when nothing does. Turrets, area generators and shields all
   * run through this, so an unsupported one works but at half pace.
   */
  support(tower) {
    return this.supported && this.supported.has(tower) ? 1 : SUPPORT_PENALTY
  }

  /** Recompute generator networks (called when a tower changes). */
  refresh() {
    this.updatePathGenerators()
    this.updateEnclosureGenerators()
    this.refreshManaStats()
  }

  /** Enclosure generators: mana = enclosed-region size x floor height x rate.
   *  Uses tower.enclosureRegionCells set by City.updateEnclosure. */
  updateEnclosureGenerators() {
    let mana = 0
    this.enclosureGens = []
    for (const t of this.city.towers) {
      if (!t.visible || !claimsEnclosure(t)) continue
      const cells = t.enclosureRegionCells || 0
      if (cells <= 0 || t.numFloors < 1 || this.city.upkeep.isDark(t)) { t.enclosureMana = 0; continue }
      t.enclosureMana = Math.max(1, Math.round(
        cells * t.numFloors * ENCLOSURE_RATE * PROD_FACTOR * Buffs.genRate * this.support(t)
      ))
      mana += t.enclosureMana
      this.enclosureGens.push(t)
    }
    this.enclosureGenMana = mana
  }

  /** Push the current grey-block population to the energy/population HUD. */
  refreshManaStats() {
    if (this.city.mana) this.city.mana.setStats(this.countGreyBlocks())
  }

  /** Total grey blocks = sum of heights over visible grey towers. */
  countGreyBlocks() {
    let n = 0
    for (const t of this.city.towers) {
      if (!t.visible || t.numFloors < 1 || !isGrey(t)) continue
      n += t.numFloors
    }
    return n
  }

  area(tower) {
    return towerArea(tower, this.city.cellUnit, this._size)
  }

  /**
   * Re-evaluate connectors between path generators. Two same-colour plus blocks
   * connect when the centre distance (in cells) is less than the sum of their
   * heights. Mana per tick = sum over connectors of both towers' height*area
   * scaled by the trail length, so generators further apart generate more.
   */
  updatePathGenerators() {
    const city = this.city
    if (!city.trails) return

    const plus = city.towers.filter(t => t.visible && isPathGenerator(t))
    const cell = city.cellUnit
    const pairs = []
    for (let i = 0; i < plus.length; i++) {
      for (let j = i + 1; j < plus.length; j++) {
        const a = plus[i], b = plus[j]
        if (a.colorIndex !== b.colorIndex) continue
        const combinedReach = (a.numFloors + b.numFloors) * 2 // 2 cells of reach per floor
        if (combinedReach <= 0) continue
        a.box.getCenter(this._ca)
        b.box.getCenter(this._cb)
        const dist = this._ca.distanceTo(this._cb) / cell
        if (dist < combinedReach) pairs.push([a, b, dist])
      }
    }
    this.activeConnectorCount = pairs.length

    // Mana = footprint cells x trail length x factor. Height is NOT a factor -
    // it's already baked into reach (taller towers connect over longer trails).
    let mana = 0
    const contrib = new Map()
    for (const [a, b, dist] of pairs) {
      const pa = Math.max(1, Math.round(this.area(a) * dist * PATH_RATE * PROD_FACTOR * Buffs.genRate))
      const pb = Math.max(1, Math.round(this.area(b) * dist * PATH_RATE * PROD_FACTOR * Buffs.genRate))
      mana += pa + pb
      contrib.set(a, (contrib.get(a) || 0) + pa)
      contrib.set(b, (contrib.get(b) || 0) + pb)
    }
    this.pathGenMana = mana
    this.pathGenContribution = contrib

    // Decorative trails: on top of the mana-bearing links above, every path
    // generator also runs a line to any non-wall building inside its OWN reach
    // (numFloors * 2 cells - the other end contributes nothing, unlike a
    // gen-to-gen link). Purely cosmetic for now: these are appended after the
    // mana loop, so they light up the city without paying anything.
    const drawn = pairs.slice()
    // Rebuilt every time the network changes, so a support tower losing height
    // or being demolished drops everything it was carrying.
    const supported = new Set()
    for (const a of plus) {
      const reach = a.numFloors * 2 + Buffs.supportReach
      if (reach <= 0) continue
      a.box.getCenter(this._ca)
      for (const b of city.towers) {
        if (b === a || !b.visible || b.numFloors < 1) continue
        if (city.upkeep.isDark(b)) continue // a dark building can't be supported
        if (isGrey(b)) continue // walls are the thing trails route AROUND
        // Same-colour gen pairs are already linked above; don't double-draw.
        if (isPathGenerator(b) && b.colorIndex === a.colorIndex) continue
        b.box.getCenter(this._cb)
        const dist = this._ca.distanceTo(this._cb) / cell
        if (dist < reach) { drawn.push([a, b, dist]); supported.add(b) }
      }
    }

    // A trail from a support tower isn't only decoration any more: reaching a
    // building is what brings it up to full speed. Same geometry, same links -
    // the line you can see IS the supply.
    //
    // Announce the ones that just came online. Diffed against the previous set
    // rather than fired per link, so re-running the network (which happens on
    // every tower change) doesn't re-announce buildings that were already
    // supported.
    const prev = this.supported
    this.supported = supported
    if (prev) {
      for (const t of supported) {
        if (!prev.has(t)) this.announceSupport(t)
      }
    }

    // Only rebuild trail meshes when the actual connection set changes (disposing
    // WebGPU node materials leaks, so we avoid rebuilding every tower change).
    const pairKeys = new Set()
    const keyList = []
    for (const [a, b] of drawn) {
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`
      pairKeys.add(key)
      keyList.push(key)
    }
    keyList.sort()
    const sig = keyList.join(',')
    if (sig === this._connectorSig) return
    this._connectorSig = sig

    city.trails.setConnectors(drawn)

    let newConnection = false
    for (const key of pairKeys) {
      if (!this._connectorKeys || !this._connectorKeys.has(key)) newConnection = true
    }
    let lostConnection = false
    if (this._connectorKeys) {
      for (const key of this._connectorKeys) if (!pairKeys.has(key)) lostConnection = true
    }
    // Both fire on every rewiring of the trail network, which happens constantly
    // as you build - kept well down so they read as feedback, not events.
    if (newConnection) Sounds.play('energy', 1.0, 0.15, 0.3) // distinct from the per-tick 'dink'
    if (lostConnection) Sounds.play('warning1', 1.0, 0.15, 0.25)
    this._connectorKeys = pairKeys

    // Restore steady colour on towers that just lost all their connections.
    const connected = new Set()
    for (const [a, b] of pairs) { connected.add(a); connected.add(b) }
    for (const t of this.connectedTowers) {
      if (!connected.has(t) && t.isLit && t.litColor) city.setTowerColor(t, t.litColor)
    }
    this.connectedTowers = connected
  }

  /**
   * Break one source's tick into individual +1 arrivals spaced evenly across
   * `span` seconds, so income reads (and sounds) as a stream whose rate tracks
   * how much you're producing rather than a lump every tick.
   *
   * The generator's lifespan is charged ONCE here, not per arrival - the pulses
   * used to be one-per-tick, so this is where a per-tick charge would go.
   */
  scheduleIncome(tower, amt, span = GEN_INTERVAL) {
    const city = this.city
    // One unit per slot, until the slots would be closer together than
    // MIN_SPAWN_GAP; past that each slot carries more than 1.
    const n = Math.max(1, Math.min(amt, Math.floor(span / MIN_SPAWN_GAP), MAX_SPAWNS_PER_TICK))
    const per = amt / n
    const gap = span / n
    // Every generator's tick is driven off the SAME shared manaTimer, so without
    // this they all opened their stream on the same frame and the board flashed
    // in unison - one loud chord instead of a rhythm. A stable per-tower phase
    // decorrelates them while keeping each generator's own beat steady.
    if (tower.incomePhase === undefined) tower.incomePhase = Math.random()
    const phase = tower.incomePhase * span
    const c = tower.box.getCenter(this._c)
    const cx = c.x + city.gridOffsetX
    const cy = towerTopY(tower, city.floorHeight) + 0.5
    const cz = c.y + city.gridOffsetZ
    let left = amt
    for (let i = 0; i < n; i++) {
      // Integer amounts that still sum to exactly `amt`.
      const give = i === n - 1 ? left : Math.max(1, Math.round(per))
      left -= give
      this.pulseEvents.push({
        members: [tower], t: phase + i * gap, amt: give, sound: 'dink',
        color: ENERGY_COLOR, cx, cy, cz,
      })
    }
  }

  /** Per-frame: advance mana ticks, fire scheduled flashes, decay pulses. */
  update(dt) {
    const city = this.city
    if (!city.mana) return

    // Generator mana tick: schedule each unit's flash at a random offset.
    const genMana = this.pathGenMana + this.enclosureGenMana
    // Cache live income/sec (gens + grey trickle + king) for price scaling.
    this.incomePerSecValue = genMana / GEN_INTERVAL
      + (city.king && city.king.visible ? KING_BONUS : 0) / GREY_INTERVAL
    if (genMana > 0) {
      this.manaTimer += dt
      while (this.manaTimer >= GEN_INTERVAL) {
        this.manaTimer -= GEN_INTERVAL
        for (const [tower, amt] of this.pathGenContribution) {
          if (amt > 0 && tower.visible) this.scheduleIncome(tower, amt)
        }
        for (const t of this.enclosureGens) {
          if (t.visible && t.enclosureMana) this.scheduleIncome(t, t.enclosureMana)
        }
      }
    }

    // Fire scheduled flashes: glow + caption + sound together at each offset.
    for (let i = this.pulseEvents.length - 1; i >= 0; i--) {
      const e = this.pulseEvents[i]
      e.t -= dt
      if (e.t <= 0) {
        for (const m of e.members) {
          if (!m.visible) continue
          m.pulseEnv = 1
          // Any claimant pulses, king included. Which CELLS light up is gated
          // per-vertex by the 'claimed' attribute (see City.updateEnclosure),
          // so unclaimed white floor stays still.
          if (claimsEnclosure(m)) this.floorPulse = 1
        }
        // The energy lands at the moment its caption pops, not up front, so the
        // bar climbs in step with the bleeps.
        city.mana.add(e.amt)
        // No "+N" caption here any more: the flying box and the bar climbing
        // already say it, and at full income the board was carpeted in them.
        // The sound the caption used to carry fires on its own.
        if (e.sound) Sounds.play(e.sound, undefined, undefined, INCOME_BLIP_VOLUME)
        // ...and a little yellow box flies from the generator up to the meter.
        city.resourceFly?.spawn(e.cx, e.cy, e.cz, city.camera, city.mana.energyBar, ENERGY_COLOR)
        this.pulseEvents.splice(i, 1)
      }
    }

    // Walls no longer generate anything - they're defence, not income, and a
    // city full of them was out-earning actual generators. They still count as
    // population, so building raises the energy CAP (see refreshManaStats).
    // Only the king trickles on this timer now.
    this.greyManaTimer += dt
    while (this.greyManaTimer >= GREY_INTERVAL) {
      this.greyManaTimer -= GREY_INTERVAL
      // The king earns from its enclosure like any hole block (see
      // updateEnclosureGenerators); this is a slow bonus trickle ON TOP, so an
      // unsealed king still brings in enough to rebuild from. Emitted one unit
      // at a time over its own 5s tick rather than as a silent lump.
      if (city.king && city.king.visible) {
        this.scheduleIncome(city.king, KING_BONUS, GREY_INTERVAL)
      }
    }

    // Brightness pulse, driven by each tower's own decaying flash envelope.
    for (const tower of this.connectedTowers) this._pulseTower(tower, dt)
    for (const tower of this.enclosureGens) this._pulseTower(tower, dt)

    // Pulse the enclosure floor with its claimant's flash (strongest wins). The
    // king is in enclosureGens now, so its enclosure lights up on every unit it
    // earns too. Swings much wider than before - each +1 arrival should visibly
    // flash the sealed area, not just nudge it.
    this.floorPulse = Math.max(0, this.floorPulse - dt / FLOOR_PULSE_DECAY)
    if (city.enclosure.opacity) {
      const p = this.floorPulse
      city.enclosure.opacity.value = p * 0.16
      if (city.enclosure.bright) city.enclosure.bright.value = p * 0.25
    }
  }

  _pulseTower(tower, dt) {
    // Decay ALWAYS, even with no lit colour to tint. This used to bail out
    // first, which meant the king - whose litColor is null - had its pulseEnv
    // set to 1 on its first arrival and never brought back down, pinning
    // anything reading the envelope (the enclosure floor) permanently on.
    tower.pulseEnv = Math.max(0, (tower.pulseEnv || 0) - dt / PULSE_DECAY)
    if (!tower.litColor) return
    const brightness = 0.7 + tower.pulseEnv * 0.7 // 0.7..1.4
    this._pulseColor.copy(tower.litColor).multiplyScalar(brightness)
    this.city.setTowerColor(tower, this._pulseColor)
  }

  /** Live income per second (cached each update), for price scaling. */
  incomePerSec() { return this.incomePerSecValue || 0 }

  /** Float a "+N" caption at a world position. */
  spawnTextAt(x, y, z, text, color, sound, delay = 0) {
    const ft = this.city.floatingText
    if (!ft) return
    const css = color && color.getHexString ? `#${color.getHexString()}` : color
    ft.spawn(x, y, z, text, css, delay, sound)
  }

  /** Float a "+N" caption from the top of a tower. */
  spawnTowerText(tower, text, color, sound = 'dink', delay = Math.random()) {
    const city = this.city
    const c = tower.box.getCenter(this._c)
    this.spawnTextAt(
      c.x + city.gridOffsetX, towerTopY(tower, city.floorHeight) + 0.5, c.y + city.gridOffsetZ,
      text, color, sound, delay
    )
  }
}
