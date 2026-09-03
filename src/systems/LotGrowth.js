import { Vector2, BufferGeometry, Float32BufferAttribute, LineSegments, LineBasicNodeMaterial } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { ENERGY_COLOR } from '../palette.js'
import { isWall, towerArea } from '../blockTypes.js'

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/**
 * LotGrowth - the city spreads outward by spawning dormant lots. A dormant lot
 * accumulates "points" from its active orthogonal neighbours' grey-block strength
 * (plus bonus points from direct clicks); once the total crosses a threshold it
 * activates and its towers animate up from the ground. Also owns the dashed lot
 * outlines and the neighbour-progress fill indicators.
 */
export class LotGrowth {
  constructor(city) {
    this.city = city
    this.spawnThreshold = 15 // points a dormant lot needs to spawn
    this.clickValue = 5 // bonus points per direct click on a dormant lot
    this.outlineMats = null
    this.fillGeo = null
  }

  /** Lot "points" = sum over walls of height * footprint area. */
  lotStrength(lot) {
    let pts = 0
    for (const t of lot.towers) {
      if (!t.visible || t.numFloors < 1 || !isWall(t)) continue
      pts += t.numFloors * towerArea(t, this.city.cellUnit, this.city.towerSize)
    }
    return pts
  }

  /** Combined strength of all active orthogonal neighbours of a lot. */
  activeNeighbourStrength(lot) {
    let sum = 0
    for (const n of this.neighbours(lot)) if (n.active) sum += this.lotStrength(n)
    return sum
  }

  /** Total spawn progress: neighbour points + bonus points from clicks. */
  lotProgress(lot) {
    return this.activeNeighbourStrength(lot) + (lot.clickPoints || 0)
  }

  hasActiveNeighbour(lot) {
    for (const n of this.neighbours(lot)) if (n.active) return true
    return false
  }

  /** In-bounds orthogonal neighbour lots of `lot`. */
  neighbours(lot) {
    const { lots, numLotsX, numLotsY } = this.city
    const out = []
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = lot.lotX + dx, ny = lot.lotY + dy
      if (nx < 0 || ny < 0 || nx >= numLotsX || ny >= numLotsY) continue
      out.push(lots[ny][nx])
    }
    return out
  }

  /** Grow the dashed fill indicator on each dormant lot toward the threshold. */
  updateLotFills() {
    const minScale = this.city.cellUnit / this.city.lotSize
    for (const row of this.city.lots) {
      for (const lot of row) {
        if (!lot.fillRect) continue
        if (lot.active) { lot.fillRect.visible = false; continue }
        const p = Math.min(1, this.lotProgress(lot) / this.spawnThreshold)
        lot.fillRect.visible = p > 0
        if (lot.outline) lot.outline.visible = p > 0
        const s = minScale + (1 - minScale) * p
        lot.fillRect.scale.set(s, 1, s)
        lot.fillRect.material.opacity = 0.8
      }
    }
  }

  /**
   * Click a dormant lot's rect to add bonus spawn points; spawns once total
   * progress crosses the threshold. Returns true if it landed on an eligible lot.
   */
  clickLot(worldX, worldZ) {
    const city = this.city
    city.demo?.run?.record('lot', { x: worldX, z: worldZ })
    const gx = worldX - city.gridOffsetX
    const gz = worldZ - city.gridOffsetZ
    const lotX = Math.floor(gx / city.cellSize)
    const lotY = Math.floor(gz / city.cellSize)
    if (lotX < 0 || lotY < 0 || lotX >= city.numLotsX || lotY >= city.numLotsY) return false
    // Ignore clicks in the road gap between lots.
    if (gx - lotX * city.cellSize > city.lotSize || gz - lotY * city.cellSize > city.lotSize) return false

    const lot = city.lots[lotY][lotX]
    if (lot.active || !this.hasActiveNeighbour(lot)) return false

    // Each click costs 1 mana; out of mana - block and signal (consume click).
    if (!city.freeClicks && city.mana && !city.mana.spend(1)) {
      Sounds.play('error', 1.0, 0.06, 0.35)
      return true
    }
    if (!city.freeClicks && city.floatingText) city.floatingText.spawn(worldX, 1.5, worldZ, '-1', ENERGY_COLOR, 0, null)

    lot.clickPoints = (lot.clickPoints || 0) + this.clickValue
    Sounds.play('clink', 1.0, 0.1, 0.7)
    if (this.lotProgress(lot) >= this.spawnThreshold) this.activateLot(lot)
    else this.updateLotFills()
    return true
  }

  /**
   * Empty-lot pull: every dormant lot with a strong-enough active neighbour
   * activates. Collected first, then activated, so one event can spawn a full
   * ring without a freshly activated lot stalling its neighbours.
   */
  trySpawnLots() {
    if (!this.city.lots.length) return
    const toSpawn = []
    for (const row of this.city.lots) {
      for (const lot of row) {
        if (lot.active) continue
        if (this.lotProgress(lot) >= this.spawnThreshold) toSpawn.push(lot)
      }
    }
    for (const lot of toSpawn) this.activateLot(lot)
  }

  /**
   * Activate a dormant lot. Grown lots start EMPTY (no pre-baked towers) - the
   * player fills the 5x5 grid from the tile palette via free placement. Just
   * reveal the outline and refresh dependent visuals.
   */
  activateLot(lot) {
    lot.active = true
    if (lot.outline) lot.outline.visible = true
    if (lot.fillRect) lot.fillRect.visible = false
    Sounds.play('good')

    const city = this.city
    city.energy.refresh()
    city.rangeVisuals.updateZocCircles()
    this.updateLotFills()
  }

  /** Dashed square outline + grow-fill indicator for every lot. */
  createLotOutlines() {
    const city = this.city
    const y = 0.04
    const dash = 0.6, gap = 0.4, period = dash + gap

    const dashEdge = (positions, ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az)
      const dx = (bx - ax) / len, dz = (bz - az) / len
      for (let d = 0; d < len; d += period) {
        const end = Math.min(d + dash, len)
        positions.push(ax + dx * d, y, az + dz * d, ax + dx * end, y, az + dz * end)
      }
    }

    this.outlineMats = city.accentColors.map(c => new LineBasicNodeMaterial({ color: c.clone() }))

    // Centred dashed square (XZ plane) reused for every neighbour-progress fill.
    const half = city.lotSize / 2
    const fillPositions = []
    dashEdge(fillPositions, -half, -half, half, -half)
    dashEdge(fillPositions, half, -half, half, half)
    dashEdge(fillPositions, half, half, -half, half)
    dashEdge(fillPositions, -half, half, -half, -half)
    this.fillGeo = new BufferGeometry()
    this.fillGeo.setAttribute('position', new Float32BufferAttribute(fillPositions, 3))

    for (let lotY = 0; lotY < city.numLotsY; lotY++) {
      for (let lotX = 0; lotX < city.numLotsX; lotX++) {
        const gx0 = lotX * city.cellSize
        const gz0 = lotY * city.cellSize
        const a = city.gridToWorld(gx0, gz0)
        const b = city.gridToWorld(gx0 + city.lotSize, gz0 + city.lotSize)
        const positions = []
        dashEdge(positions, a.x, a.z, b.x, a.z)
        dashEdge(positions, b.x, a.z, b.x, b.z)
        dashEdge(positions, b.x, b.z, a.x, b.z)
        dashEdge(positions, a.x, b.z, a.x, a.z)

        const lot = city.lots[lotY][lotX]
        const geom = new BufferGeometry()
        geom.setAttribute('position', new Float32BufferAttribute(positions, 3))
        const outline = new LineSegments(geom, this.outlineMats[lot.colorIndex])
        outline.visible = false // lot outlines hidden (continuous build surface)
        lot.outline = outline
        city.scene.add(outline)

        const center = city.gridToWorld(gx0 + city.lotSize / 2, gz0 + city.lotSize / 2)
        const fillMat = new LineBasicNodeMaterial({
          color: city.accentColors[lot.colorIndex].clone(),
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
        const fillRect = new LineSegments(this.fillGeo, fillMat)
        fillRect.position.set(center.x, 0.03, center.z)
        fillRect.renderOrder = -2
        fillRect.visible = false
        lot.fillRect = fillRect
        city.scene.add(fillRect)
      }
    }

    // Seed the initial state for the starting (center) lot.
    city.rangeVisuals.refresh()
    this.updateLotFills()
  }
}
