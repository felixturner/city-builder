import { Vector2, Color } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { ENERGY_COLOR } from '../Mana.js'
import {
  isPathGenerator, isEnclosureGenerator, isGrey, towerArea, towerTopY,
} from '../blockTypes.js'

const GEN_INTERVAL = 2 // seconds between generator mana ticks
const GREY_INTERVAL = 5 // seconds between passive grey-block mana ticks
const PULSE_DECAY = 0.8 // seconds for a tower's flash to fade back to baseline
const ENCLOSURE_RATE = 0.2 // mana per (enclosed cell x generator floor)
const PATH_RATE = 0.2 // mana per (footprint cell x trail length)
// Global generator-production scale. Raised from 0.2 (+30%) when grey walls
// stopped generating: generators are now the only thing producing energy besides
// the king's trickle, so they carry the income walls used to supply.
const PROD_FACTOR = 0.26
const KING_INCOME = 8 // baseline mana the king trickles every GREY_INTERVAL (safety net)
// Income arrives one unit at a time rather than as a lump, so a generator's
// output is audible as a RATE: 2 energy a tick trickles, 12 rattles.
//
// The cadence is derived from the amount (one unit per span/amt), floored at
// MIN_SPAWN_GAP so a huge generator can't spawn hundreds of captions. Capping
// the COUNT instead - which is what this used to do - flattened the cadence:
// everything at or above the cap emitted at exactly the same speed and only the
// number on the caption changed, so big generators stopped sounding bigger.
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
    this.manaTimer = 0
    this.greyManaTimer = 0

    this._pulseColor = new Color()
    this._ca = new Vector2()
    this._cb = new Vector2()
    this._size = new Vector2()
    this._c = new Vector2()
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
      if (!t.visible || !isEnclosureGenerator(t)) continue
      const cells = t.enclosureRegionCells || 0
      if (cells <= 0 || t.numFloors < 1) { t.enclosureMana = 0; continue }
      t.enclosureMana = Math.max(1, Math.round(cells * t.numFloors * ENCLOSURE_RATE * PROD_FACTOR))
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
        const combinedReach = a.numFloors + b.numFloors // 1 cell of reach per floor
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
      const pa = Math.max(1, Math.round(this.area(a) * dist * PATH_RATE * PROD_FACTOR))
      const pb = Math.max(1, Math.round(this.area(b) * dist * PATH_RATE * PROD_FACTOR))
      mana += pa + pb
      contrib.set(a, (contrib.get(a) || 0) + pa)
      contrib.set(b, (contrib.get(b) || 0) + pb)
    }
    this.pathGenMana = mana
    this.pathGenContribution = contrib

    // Only rebuild trail meshes when the actual connection set changes (disposing
    // WebGPU node materials leaks, so we avoid rebuilding every tower change).
    const pairKeys = new Set()
    const keyList = []
    for (const [a, b] of pairs) {
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`
      pairKeys.add(key)
      keyList.push(key)
    }
    keyList.sort()
    const sig = keyList.join(',')
    if (sig === this._connectorSig) return
    this._connectorSig = sig

    city.trails.setConnectors(pairs)

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
   * used to be one-per-tick and genLife counts ticks, so decrementing per
   * arrival would burn generators down eight times too fast.
   */
  scheduleIncome(tower, amt, span = GEN_INTERVAL) {
    const city = this.city
    // One unit per slot, until the slots would be closer together than
    // MIN_SPAWN_GAP; past that each slot carries more than 1.
    const n = Math.max(1, Math.min(amt, Math.floor(span / MIN_SPAWN_GAP), MAX_SPAWNS_PER_TICK))
    const per = amt / n
    const gap = span / n
    const c = tower.box.getCenter(this._c)
    const cx = c.x + city.gridOffsetX
    const cy = towerTopY(tower, city.floorHeight) + 0.5
    const cz = c.y + city.gridOffsetZ
    if (tower.genLife !== undefined) tower.genLife -= 1
    let left = amt
    for (let i = 0; i < n; i++) {
      // Integer amounts that still sum to exactly `amt`.
      const give = i === n - 1 ? left : Math.max(1, Math.round(per))
      left -= give
      this.pulseEvents.push({
        members: [tower], t: i * gap, amt: give, sound: 'dink',
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
      + (city.king && city.king.visible ? KING_INCOME : 0) / GREY_INTERVAL
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
        }
        // The energy lands at the moment its caption pops, not up front, so the
        // bar climbs in step with the bleeps.
        city.mana.add(e.amt)
        this.spawnTextAt(e.cx, e.cy, e.cz, `+${e.amt}`, e.color, e.sound)
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
      // The king itself trickles a baseline income, so you can always recover even
      // with no generators standing. Emitted one unit at a time like a generator
      // (spread over its own 5s tick, not the 2s generator one) so it bleeps and
      // flies to the meter the same way rather than landing as a silent lump.
      if (city.king && city.king.visible) {
        this.scheduleIncome(city.king, KING_INCOME, GREY_INTERVAL)
      }
    }

    // Brightness pulse, driven by each tower's own decaying flash envelope.
    for (const tower of this.connectedTowers) this._pulseTower(tower, dt)
    for (const tower of this.enclosureGens) this._pulseTower(tower, dt)

    // Pulse the enclosure floor with its generators' flash (strongest one wins).
    if (city.enclosureOpacity) {
      let encPulse = 0
      for (const t of this.enclosureGens) encPulse = Math.max(encPulse, t.pulseEnv || 0)
      city.enclosureOpacity.value = 0.2 + encPulse * 0.3
    }
  }

  _pulseTower(tower, dt) {
    if (!tower.litColor) return
    tower.pulseEnv = Math.max(0, (tower.pulseEnv || 0) - dt / PULSE_DECAY)
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
