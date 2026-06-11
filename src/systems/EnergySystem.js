import { Vector2, Color } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import {
  isPathGenerator, isAdjGenerator, isEnclosureGenerator, isGrey, towerArea, towerTopY,
} from '../blockTypes.js'

const GEN_INTERVAL = 2 // seconds between generator mana ticks
const GREY_INTERVAL = 5 // seconds between passive grey-block mana ticks
const PULSE_DECAY = 0.8 // seconds for a tower's flash to fade back to baseline
const ENCLOSURE_RATE = 0.2 // mana per (enclosed cell x generator floor)
const PATH_RATE = 0.2 // mana per (footprint cell x trail length)
const PROD_FACTOR = 0.3 // global energy-production scale (applied to every source)

/**
 * EnergySystem - all energy generation and the visual/audio feedback for it.
 *
 *  - Path generators (plus blocks) connect to same-colour neighbours within
 *    combined-height reach, drawing trails and generating height*area mana.
 *  - Adjacency generators (hole blocks) form orthogonal clusters; each cluster
 *    is one unit that generates 1 mana per built member and glows together.
 *  - Grey blocks trickle passive mana.
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

    // Adjacency generators (hole-block clusters)
    this.adjGenMana = 0
    this.adjGenClusters = [] // [{members, energy, cx, cy, cz}]
    this.litAdjGens = new Set() // built hole blocks that pulse-glow

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

  /** Recompute both generator networks (called when a tower changes). */
  refresh() {
    this.updatePathGenerators()
    this.updateAdjGenerators()
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
        const combinedReach = a.numFloors + b.numFloors
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
    if (newConnection) Sounds.play('dink')
    if (lostConnection) Sounds.play('power-down')
    this._connectorKeys = pairKeys

    // Restore steady colour on towers that just lost all their connections.
    const connected = new Set()
    for (const [a, b] of pairs) { connected.add(a); connected.add(b) }
    for (const t of this.connectedTowers) {
      if (!connected.has(t) && t.isLit && t.litColor) city.setTowerColor(t, t.litColor)
    }
    this.connectedTowers = connected
  }

  /** Orthogonal (edge-sharing) adjacency - excludes diagonal corner touches. */
  orthAdjacent(a, b, tol) {
    const ba = a.box, bb = b.box
    const sepX = Math.max(bb.min.x - ba.max.x, ba.min.x - bb.max.x)
    const sepZ = Math.max(bb.min.y - ba.max.y, ba.min.y - bb.max.y)
    const closeX = sepX <= tol, closeZ = sepZ <= tol
    const overlapX = sepX < -tol, overlapZ = sepZ < -tol
    return (overlapX && closeZ) || (overlapZ && closeX)
  }

  /**
   * Adjacency generators: hole blocks generate only in clusters. A connected
   * group of orthogonally-adjacent holes is one unit that generates 1 mana per
   * built member, pops a single centred "+N", and pulse-glows together.
   */
  updateAdjGenerators() {
    const city = this.city
    const tol = city.cellUnit * 0.5
    const clusters = []
    const lit = new Set()
    let mana = 0
    let clusteredCount = 0 // holes that are part of an adjacency group (size >= 2)

    // Clustering is global (tiles are placed freely and may straddle lots).
    const holes = city.towers.filter(t => t.visible && isAdjGenerator(t))
    // Reset every hole to static accent; the per-frame pulse re-brightens
    // only the generating ones, so one that stops generating doesn't freeze.
    for (const t of holes) city.setTowerColor(t, city.accentColors[t.colorIndex])

    if (holes.length >= 2) {
      const visited = new Set()
      for (const start of holes) {
        if (visited.has(start)) continue
        const stack = [start]
        visited.add(start)
        const cluster = []
        while (stack.length) {
          const cur = stack.pop()
          cluster.push(cur)
          for (const o of holes) {
            if (!visited.has(o) && this.orthAdjacent(cur, o, tol)) {
              visited.add(o)
              stack.push(o)
            }
          }
        }
        if (cluster.length < 2) continue
        clusteredCount += cluster.length

        let blocks = 0, sx = 0, sz = 0, topY = 0
        for (const m of cluster) {
          blocks += m.numFloors // combined block count (sum of all levels in the cluster)
          const c = m.box.getCenter(this._c)
          sx += c.x + city.gridOffsetX
          sz += c.y + city.gridOffsetZ
          topY = Math.max(topY, towerTopY(m, city.floorHeight))
        }
        const energy = Math.round(blocks * PROD_FACTOR)
        if (energy > 0) {
          mana += energy
          for (const m of cluster) lit.add(m)
          clusters.push({
            members: cluster.slice(), energy,
            cx: sx / cluster.length, cy: topY + 0.5, cz: sz / cluster.length,
          })
        }
      }
    }
    this.adjGenMana = mana
    this.adjGenClusters = clusters
    this.litAdjGens = lit

    // New adjacency formed: play energy-2 when more holes become clustered (skip
    // the first pass so the initial city doesn't trigger it).
    if (this._adjClusteredCount !== undefined && clusteredCount > this._adjClusteredCount) {
      Sounds.play('energy-2')
    }
    this._adjClusteredCount = clusteredCount
  }

  /** Per-frame: advance mana ticks, fire scheduled flashes, decay pulses. */
  update(dt) {
    const city = this.city
    if (!city.mana) return

    // Generator mana tick: schedule each unit's flash at a random offset.
    const genMana = this.pathGenMana + this.adjGenMana + this.enclosureGenMana
    if (genMana > 0) {
      this.manaTimer += dt
      while (this.manaTimer >= GEN_INTERVAL) {
        this.manaTimer -= GEN_INTERVAL
        city.mana.add(genMana)
        for (const [tower, amt] of this.pathGenContribution) {
          if (amt > 0 && tower.visible) {
            const c = tower.box.getCenter(this._c)
            this.pulseEvents.push({
              members: [tower], t: Math.random(), amt, sound: 'dink',
              color: city.accentColors[tower.colorIndex],
              cx: c.x + city.gridOffsetX,
              cy: towerTopY(tower, city.floorHeight) + 0.5,
              cz: c.y + city.gridOffsetZ,
            })
          }
        }
        for (const cl of this.adjGenClusters) {
          this.pulseEvents.push({
            members: cl.members, t: Math.random(), amt: cl.energy, sound: 'dink',
            color: city.accentColors[cl.members[0].colorIndex],
            cx: cl.cx, cy: cl.cy, cz: cl.cz,
          })
        }
        for (const t of this.enclosureGens) {
          if (!t.visible || !t.enclosureMana) continue
          const c = t.box.getCenter(this._c)
          this.pulseEvents.push({
            members: [t], t: Math.random(), amt: t.enclosureMana, sound: 'dink',
            color: city.accentColors[t.colorIndex],
            cx: c.x + city.gridOffsetX,
            cy: towerTopY(t, city.floorHeight) + 0.5,
            cz: c.y + city.gridOffsetZ,
          })
        }
      }
    }

    // Fire scheduled flashes: glow + caption + sound together at each offset.
    for (let i = this.pulseEvents.length - 1; i >= 0; i--) {
      const e = this.pulseEvents[i]
      e.t -= dt
      if (e.t <= 0) {
        for (const m of e.members) if (m.visible) m.pulseEnv = 1
        this.spawnTextAt(e.cx, e.cy, e.cz, `+${e.amt}`, e.color, e.sound)
        this.pulseEvents.splice(i, 1)
      }
    }

    // Grey blocks trickle passive mana; their captions spread across the cycle.
    this.greyManaTimer += dt
    while (this.greyManaTimer >= GREY_INTERVAL) {
      this.greyManaTimer -= GREY_INTERVAL
      const n = this.countGreyBlocks()
      if (n > 0) city.mana.add(Math.round(n * PROD_FACTOR))
      for (const t of city.towers) {
        if (!t.visible || t.numFloors < 1 || !isGrey(t)) continue
        this.spawnTowerText(t, `+${t.numFloors}`, '#dfe6ff', 'dink', Math.random() * GREY_INTERVAL)
      }
    }

    // Brightness pulse, driven by each tower's own decaying flash envelope.
    for (const tower of this.connectedTowers) this._pulseTower(tower, dt)
    for (const tower of this.litAdjGens) this._pulseTower(tower, dt)
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
