import { Vector2, Color } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { ENERGY_COLOR, PINK, BLUE } from '../palette.js'
import { Buffs } from '../buffs.js'
import {
  isSupport, claimsEnclosure, isWall, isShield, isTurret, isBarracks, towerArea, towerTopY,
  shieldRadiusCells, shieldCharges,
} from '../blockTypes.js'
import { simRand } from '../lib/rng.js'

const GEN_INTERVAL = 2 // seconds between generator mana ticks
const GREY_INTERVAL = 5 // seconds between passive grey-block mana ticks
const PULSE_DECAY = 0.8 // seconds for a tower's flash to fade back to baseline
// The enclosure floor gets its own, much faster envelope. Riding the tower's
// 0.8s decay never worked once income became a stream: units can arrive every
// MIN_SPAWN_GAP (0.07s) and each one resets the envelope to 1, so it never got
// near baseline and the floor just sat bright. At 0.22s each arrival reads as a
// distinct blink at ordinary rates, and only a very rich enclosure glows solid.
const FLOOR_PULSE_DECAY = 0.22
// Energy per (enclosed cell x generator floor) for the pink area generators.
//
// Sealing ground is meant to be the PRIMARY way a city earns, and a measured
// run had it at 32% of generator income against the blue network's 68%. This
// carries that correction.
//
// The whole rate, not a share of one: there used to be a global PROD_FACTOR in
// front of both generator types and a BASE_FACTOR of 0.5 behind them, so this
// number meant about a sixth of what it said. Both are folded in now. What a
// generator earns is this, times its cells, times its floors - and then only
// the support and card multipliers, which are bonuses rather than scale.
const ENCLOSURE_RATE = 0.00928
// Energy per (footprint cell x longest link) for the blue support generators.
//
// Deliberately well below what a sealed enclosure earns, because a blue tile is
// a SUPPORT tower that happens to pay a little, not a generator. What it is for
// is the trails it throws to turrets, shields, barracks and area generators;
// the energy is a retainer, and sealing ground is how a city actually earns.
//
// It also scales the wrong way to be the main income: link length grows with
// the board and with tower height, while a sealed region is capped by how much
// ground you can hold. Left near parity the network just wins the late game -
// 68% path against 32% enclosure in a measured run at level 12.
//
// Same note as above: this is the whole rate, with PROD_FACTOR folded in.
const PATH_LINK_RATE = 0.0582

// Volume of the per-arrival income blip. It fires several times a second at a
// developed economy, so it sits well under the one-off cues.
const INCOME_BLIP_VOLUME = 0.54
// Slow bonus the king trickles every GREY_INTERVAL, separate from what it earns
// by sealing an enclosure. Smaller than the old flat income now that the king
// has a real earning mechanic - it's the floor you can recover from, not a wage.
const KING_BONUS = 5
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
// What one connected support tower adds, and they STACK - a building reached by
// three trails gets three times the bonus. Percentages are of what the building
// does UNSUPPORTED, which is now simply its base rate: ENCLOSURE_RATE for an
// area generator, fireCooldown for a turret.
//
// There used to be a BASE_FACTOR of 0.5 in front of both, left over from when
// support was a flag rather than a count and one trail doubled a building's
// output. Folded away here - the base rates below absorbed it exactly, so
// nothing changed - because it made every rate in this file mean half of what
// it said, and that is a bad thing for numbers that exist to be tuned.
const SUPPORT_FIRE_RATE = 0.25 // +25% turret fire rate each
const SUPPORT_SHIELD_DAMAGE = 1 // +1 shield burn damage each
const SUPPORT_GEN_RATE = 0.15 // +15% enclosure generator output each
const SUPPORT_SQUAD = 1 // +1 soldier in a barracks' garrison each
// Hit points a shield ring adds to every block of every tower standing in it.
const SHIELD_COVER_HP = 1
// Caption colours by what the bonus DOES, not by which building granted it, so
// the board teaches one vocabulary: pink is violence, yellow is income, blue is
// staying up. Gains and losses share a colour and are told apart by the sign,
// the sound and the ring.
const LABEL_ATTACK = PINK
const LABEL_ENERGY = ENERGY_COLOR
const LABEL_HP = BLUE
// Support generators are blue; the connect burst reads as coming from them.
const SUPPORT_ACCENT = 2

const MIN_SPAWN_GAP = 0.07 // seconds between units at full tilt
const MAX_SPAWNS_PER_TICK = 40 // hard backstop on captions per tower per tick

/**
 * EnergySystem - all energy generation and the visual/audio feedback for it.
 *
 *  - Support generators (plus blocks) connect to same-colour neighbours within
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

    // Support generators (trail-connected plus blocks)
    this.supportMana = 0
    this.supportContribution = new Map() // tower -> its share of the tick
    this.connectedTowers = new Set()
    this.activeConnectorCount = 0
    this._connectorSig = null
    this._connectorKeys = null

    // Enclosure generators (sealed inside a coloured enclosure)
    this.encGenMana = 0
    this.encGens = [] // built enclosure generators producing mana

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

  /**
   * What one support trail is worth to this building, as the caption to float
   * over it. A count told you a trail had landed but not what it bought, and the
   * three bonuses are different enough that "+2" meant nothing on its own.
   */
  supportLabel(t) {
    if (isTurret(t)) return { text: `${Math.round(SUPPORT_FIRE_RATE * 100)}% speed`, color: LABEL_ATTACK }
    if (isShield(t)) return { text: `${SUPPORT_SHIELD_DAMAGE} burn`, color: LABEL_ATTACK }
    if (isBarracks(t)) return { text: `${SUPPORT_SQUAD} soldier`, color: LABEL_ATTACK }
    if (claimsEnclosure(t)) return { text: `${Math.round(SUPPORT_GEN_RATE * 100)}% energy`, color: LABEL_ENERGY }
    return null // nothing else takes a bonus, so nothing else gets a caption
  }

  /**
   * A support trail landed on a building, or was cut.
   *
   * Gaining rings the building and floats what it just gained; losing floats the
   * same figure as a minus, in the warning colour, and rings nothing - a loss is
   * something to notice, not to celebrate.
   */
  announceSupport(t, gained) {
    const label = this.supportLabel(t)
    if (label) this.announceBonus(t, gained, label.text, label.color)
    // A shield's ring is sized by height, so a trail landing on one changed
    // what it did without changing anything on screen. Pulse the ring.
    if (isShield(t)) this.city.rangeVisuals?.flashShield(t)
  }

  /**
   * Float "+15% energy" (or "-1 HP") over a building whose bonuses just changed.
   *
   * Gaining rings the building as well; losing does not - a loss is something to
   * notice, not to celebrate - and the two carry different sounds. The colour
   * says which KIND of bonus moved, so it stays the same either way.
   */
  announceBonus(t, gained, text, color) {
    const city = this.city
    const c = t.box.getCenter(this._c)
    const x = c.x + city.gridOffsetX, z = c.y + city.gridOffsetZ
    // The ring takes the TOWER's own colour, so the pulse reads as coming from
    // that building rather than from a system. It used to be one fixed accent
    // for every building, which made a shield lighting up and a generator
    // lighting up look like the same event.
    if (gained) {
      city.spawnSupportRing?.(x, z, city.accentColors[t.colorIndex ?? SUPPORT_ACCENT])
    }
    city.floatingText?.spawn(
      x, towerTopY(t, city.floorHeight) + 1.0, z,
      `${gained ? '+' : '-'}${text}`, color, 0,
      gained ? 'gen-online' : 'power-down'
    )
  }

  /**
   * How many support-tower trails reach this building.
   *
   * It used to be a yes/no that halved everything it did not reach, which made
   * the first support tower enormous and the second one worth nothing. Now it is
   * a count, and each bonus stacks off it: turrets fire faster, shields burn
   * harder, area generators earn more. Zero is the building on its own, at the
   * rate an unsupported one has always run.
   */
  supportCount(tower) {
    return (this.supported && this.supported.get(tower)) || 0
  }

  /** Turret fire-rate multiplier: 1 on its own, +25% per trail. */
  fireRateFactor(tower) {
    return 1 + SUPPORT_FIRE_RATE * this.supportCount(tower)
  }

  /** Enclosure-generator output multiplier: same shape, +15% per trail. */
  genRateFactor(tower) {
    return 1 + SUPPORT_GEN_RATE * this.supportCount(tower)
  }

  /** Extra burn damage a shield gets from support: +1 per trail. */
  shieldBonus(tower) {
    return SUPPORT_SHIELD_DAMAGE * this.supportCount(tower)
  }

  /** Extra soldiers a barracks' garrison gets from support: +1 per trail. */
  squadBonus(tower) {
    return SUPPORT_SQUAD * this.supportCount(tower)
  }

  /** Recompute generator networks (called when a tower changes). */
  refresh() {
    this.updatePathGenerators()
    this.updateShieldCover()
    this.updateEnclosureGenerators()
    this.refreshManaStats()
  }

  /**
   * How many live shield rings each tower stands inside.
   *
   * A shield used to do one thing - burn what crossed its line - which made it
   * worth nothing at all once creeps were already inside. Covering the buildings
   * in the ring gives it a second, quieter job: every non-wall tile under it is
   * harder to knock down, so a shield is a reason to build INSIDE something
   * rather than a fence you hope holds.
   *
   * Counted rather than flagged, so overlapping rings stack the way support
   * trails do. Rebuilt on every tower change (not per frame) - the same beat the
   * trail network is rebuilt on, since both answer "what is connected to what".
   */
  updateShieldCover() {
    const city = this.city
    const cover = new Map() // tower -> how many shield rings cover it
    for (const sh of city.towers) {
      if (!sh.visible || !isShield(sh) || sh.numFloors < 1) continue
      // A spent or browned-out shield draws no ring, so it covers nothing.
      if (shieldCharges(sh) <= 0 || city.upkeep.isDark(sh)) continue
      const r = shieldRadiusCells(sh.numFloors) * city.cellUnit
      sh.box.getCenter(this._ca)
      for (const t of city.towers) {
        if (t === sh || !t.visible || t.numFloors < 1) continue
        // Walls are excluded. A wall maze is already the cheapest hit points on
        // the board and there are dozens of them under one ring; hardening the
        // BUILDINGS is what makes a shield worth the tile, and it keeps the
        // bonus to things you placed one at a time and care about individually.
        if (isWall(t)) continue
        t.box.getCenter(this._cb)
        if (this._ca.distanceTo(this._cb) < r) cover.set(t, (cover.get(t) || 0) + 1)
      }
    }
    // Same diff the support trails get: announce what changed, both directions,
    // rather than firing per ring on every rebuild.
    const prev = this.shieldCover
    this.shieldCover = cover
    if (prev) {
      for (const [t, n] of cover) {
        if (n > (prev.get(t) || 0)) this.announceBonus(t, true, `${SHIELD_COVER_HP} HP`, LABEL_HP)
      }
      for (const [t, n] of prev) {
        if (t.visible && n > (cover.get(t) || 0)) {
          this.announceBonus(t, false, `${SHIELD_COVER_HP} HP`, LABEL_HP)
        }
      }
    }
  }

  /** Extra hit points per block from the shield rings a tower stands in. */
  shieldCoverCount(tower) {
    return (this.shieldCover && this.shieldCover.get(tower)) || 0
  }

  /** Enclosure generators: mana = enclosed-region size x floor height x rate.
   *  Uses tower.enclosureRegionCells set by City.updateEnclosure. */
  updateEnclosureGenerators() {
    let mana = 0
    this.encGens = []
    for (const t of this.city.towers) {
      if (!t.visible || !claimsEnclosure(t)) continue
      const cells = t.enclosureRegionCells || 0
      if (cells <= 0 || t.numFloors < 1 || this.city.upkeep.isDark(t)) { t.encMana = 0; continue }
      t.encMana = Math.max(1, Math.round(
        cells * t.numFloors * ENCLOSURE_RATE * Buffs.genRate
        * this.genRateFactor(t)
      ))
      mana += t.encMana
      this.encGens.push(t)
    }
    this.encGenMana = mana
  }

  /**
   * Push the current board size to the energy cap.
   *
   * The cap used to be the number of grey BLOCKS standing, which made it
   * farmable and enormous: height counted, so five floors on one cell raised it
   * as much as five walls, and an 80%-built full board reached a cap of ~12,000
   * against tiles costing tens. It also fell whenever creeps took a wall, which
   * clamped away energy you had already banked.
   *
   * Board size is the honest driver. It only grows when a boss round is cleared,
   * so it tracks progress, cannot be built toward, and never drops.
   */
  refreshManaStats() {
    if (this.city.mana) this.city.mana.setStats(this.playAreaCells())
  }

  /** Cells inside the open part of the board. */
  playAreaCells() {
    const side = this.city.visibleLots * this.city.lotCells
    return side * side
  }

  area(tower) {
    return towerArea(tower, this.city.cellUnit, this._size)
  }

  /**
   * Re-evaluate connectors between support generators. Two same-colour plus blocks
   * connect when the centre distance (in cells) is less than the sum of their
   * heights. Mana per tick = sum over connectors of both towers' height*area
   * scaled by the trail length, so generators further apart generate more.
   */
  updatePathGenerators() {
    const city = this.city
    if (!city.trails) return

    const plus = city.towers.filter(t => t.visible && isSupport(t))
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

    // A generator earns off its LONGEST link. One rule, no bonus term:
    //
    //     mana = footprint cells x longest link (cells) x rate
    //
    // It used to be paid in full for EVERY link it had, and links form between
    // every pair in range - so n generators in one cluster made n(n-1)/2 links
    // and income grew with the square of n. Eight of them out-earned a maximal
    // sealed enclosure five times over, and each one added was worth more than
    // the last. Paying for one link makes a network's income linear in the
    // number of generators: more still earns more, and it is the same amount
    // more every time.
    //
    // Height is NOT a factor - it is already baked into reach, since taller
    // towers connect over longer trails and the trail length is what is paid
    // for. Fractional, and deliberately not floored at 1 per generator: that
    // floor paid a whole unit however short or small the link was, so the rate
    // barely mattered. Fractions accumulate per generator and pay out as whole
    // units when they reach one (see update).
    const best = new Map() // gen -> longest link it has, in cells
    for (const [a, b, dist] of pairs) {
      for (const t of [a, b]) best.set(t, Math.max(best.get(t) || 0, dist))
    }
    let mana = 0
    const contrib = new Map()
    for (const [t, gap] of best) {
      const p = this.area(t) * gap * PATH_LINK_RATE * Buffs.genRate
      mana += p
      contrib.set(t, p)
    }
    this.supportMana = mana
    this.supportContribution = contrib

    // Support trails: on top of the energy-bearing links above, every path
    // generator also runs a line to any non-wall building inside its OWN reach
    // (numFloors * 2 cells - the other end pays nothing, unlike a gen-to-gen
    // link). These earn no energy; what they do is make the building at the far
    // end better at its job, and they stack (see supportCount).
    const drawn = pairs.slice()
    // Rebuilt every time the network changes, so a support tower losing height
    // or being demolished drops everything it was carrying.
    const supported = new Map() // building -> how many support trails reach it
    for (const a of plus) {
      const reach = a.numFloors * 2 + Buffs.supportReach
      if (reach <= 0) continue
      a.box.getCenter(this._ca)
      for (const b of city.towers) {
        if (b === a || !b.visible || b.numFloors < 1) continue
        if (city.upkeep.isDark(b)) continue // a dark building can't be supported
        if (isWall(b)) continue // walls are the thing trails route AROUND
        // Same-colour gen pairs are already linked above; don't double-draw.
        if (isSupport(b) && b.colorIndex === a.colorIndex) continue
        b.box.getCenter(this._cb)
        const dist = this._ca.distanceTo(this._cb) / cell
        if (dist < reach) {
          drawn.push([a, b, dist])
          supported.set(b, (supported.get(b) || 0) + 1)
        }
      }
    }

    // A trail from a support tower isn't decoration: every one that reaches a
    // building makes it better at its job, and they stack. Same geometry, same
    // links - the line you can see IS the supply.
    //
    // Announce the ones that just gained a trail. Diffed against the previous
    // counts rather than fired per link, so re-running the network (which happens
    // on every tower change) doesn't re-announce what was already connected.
    const prev = this.supported
    this.supported = supported
    if (prev) {
      for (const [t, n] of supported) {
        if (n > (prev.get(t) || 0)) this.announceSupport(t, true)
      }
      // Losses are read off the OLD map: a building that lost its last trail is
      // not in the new one at all, so iterating the new one would miss exactly
      // the case worth announcing.
      for (const [t, n] of prev) {
        if (t.visible && n > (supported.get(t) || 0)) this.announceSupport(t, false)
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
    if (lostConnection) Sounds.play('support-lost', 1.0, 0.15, 0.25)
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
  scheduleIncome(tower, amt, span = GEN_INTERVAL, src = 'support') {
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
    // Seeded: the phase decides WHEN each unit of energy lands, and a click is
    // only affordable if the energy has arrived - so this decides whether a
    // recorded action succeeds, which makes it simulation, not decoration.
    if (tower.incomePhase === undefined) tower.incomePhase = simRand()
    const phase = tower.incomePhase * span
    const c = tower.box.getCenter(this._c)
    const cx = c.x + city.gridOffsetX
    const cz = c.y + city.gridOffsetZ
    // Out of the middle of the king's floating cube rather than off its roof.
    // The cube is what reads as the king from across the board, and energy
    // leaving from under it looked like it came from the tile it hovers over.
    // Its Y is driven on sim time (City.updateKingMarker), so reading it here
    // is reproducible.
    const cy = tower.king
      ? city.kingVisuals.markerY
      : towerTopY(tower, city.floorHeight) + 0.5
    let left = amt
    for (let i = 0; i < n; i++) {
      // Integer amounts that still sum to exactly `amt`.
      const give = i === n - 1 ? left : Math.max(1, Math.round(per))
      left -= give
      this.pulseEvents.push({
        members: [tower], t: phase + i * gap, amt: give, sound: 'dink',
        color: ENERGY_COLOR, cx, cy, cz, src,
      })
    }
  }

  /** Per-frame: advance mana ticks, fire scheduled flashes, decay pulses. */
  update(dt) {
    const city = this.city
    if (!city.mana) return

    // The king is dead: the economy stops with it. The city keeps running for a
    // few seconds after the loss (see Demo's GAME_OVER_DELAY) and generators
    // went on paying into it the whole time - energy arriving, cubes popping,
    // the bar climbing - over a run that had already ended. Anything already
    // scheduled is dropped too, so nothing lands after the fact.
    if (!city.kingAlive) {
      if (this.pulseEvents.length) this.pulseEvents.length = 0
      this.incomePerSecValue = 0
      return
    }

    // Generator mana tick: schedule each unit's flash at a random offset.
    const genMana = this.supportMana + this.encGenMana
    // Cache live income/sec for price scaling. Both generator types count now
    // that they both pay energy - path output used to be ammo, which had no
    // business inflating prices paid in the other currency.
    this.incomePerSecValue = genMana / GEN_INTERVAL
      + (city.king && city.king.visible ? KING_BONUS : 0) / GREY_INTERVAL
    if (genMana > 0) {
      this.manaTimer += dt
      while (this.manaTimer >= GEN_INTERVAL) {
        this.manaTimer -= GEN_INTERVAL
        // Path-generator output is fractional, so it is carried on the generator
        // until it adds up to a whole unit. Rounding each tick would either
        // round a small network down to nothing forever, or round it up to a
        // unit a tick - which is the flood this replaced.
        for (const [tower, amt] of this.supportContribution) {
          if (!(amt > 0) || !tower.visible) continue
          tower.manaCarry = (tower.manaCarry || 0) + amt
          const whole = Math.floor(tower.manaCarry)
          if (whole >= 1) {
            tower.manaCarry -= whole
            this.scheduleIncome(tower, whole, GEN_INTERVAL, 'support')
          }
        }
        for (const t of this.encGens) {
          if (t.visible && t.encMana) this.scheduleIncome(t, t.encMana, GEN_INTERVAL, 'enc')
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
        // The resource lands at the moment its caption pops, not up front, so
        // the bar climbs in step with the bleeps.
        city.mana.econ?.earnFrom(e.src, city.mana.add(e.amt))
        // No "+N" caption here any more: the flying box and the bar climbing
        // already say it, and at full income the board was carpeted in them.
        // The sound the caption used to carry fires on its own.
        if (e.sound) Sounds.play(e.sound, undefined, undefined, INCOME_BLIP_VOLUME)
        // ...and a little yellow box pops up out of the generator.
        city.resourceFly?.spawn(e.cx, e.cy, e.cz, e.color)
        this.pulseEvents.splice(i, 1)
      }
    }

    // Walls no longer generate anything - they're defence, not income, and a
    // city full of them was out-earning actual generators. They no longer raise
    // the energy cap either; that follows the board size now (refreshManaStats).
    // Only the king trickles on this timer now.
    this.greyManaTimer += dt
    while (this.greyManaTimer >= GREY_INTERVAL) {
      this.greyManaTimer -= GREY_INTERVAL
      // The king earns from its enclosure like any hole block (see
      // updateEnclosureGenerators); this is a slow bonus trickle ON TOP, so an
      // unsealed king still brings in enough to rebuild from. Emitted one unit
      // at a time over its own 5s tick rather than as a silent lump.
      if (city.king && city.king.visible) {
        this.scheduleIncome(city.king, KING_BONUS, GREY_INTERVAL, 'king')
      }
    }

    // Brightness pulse, driven by each tower's own decaying flash envelope.
    for (const tower of this.connectedTowers) this._pulseTower(tower, dt)
    for (const tower of this.encGens) this._pulseTower(tower, dt)

    // Pulse the enclosure floor with its claimant's flash (strongest wins). The
    // king is in encGens now, so its enclosure lights up on every unit it
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
