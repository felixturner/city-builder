import { Mesh, MeshBasicNodeMaterial, Raycaster, Plane, Vector2, Vector3, Color, MathUtils } from 'three/webgpu'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TetrominoGeometry } from '../lib/TetrominoGeometry.js'
import { Sounds } from '../lib/Sounds.js'
import { Buffs } from '../buffs.js'
import { ENERGY_COLOR, AMMO_COLOR } from '../palette.js'
import { Tower } from '../Tower.js'
import { TopType, isTurret, isGenerator, isBarracks, isShield, roofGeomIndex, tileColorIndex, BARRACKS_COLOR } from '../blockTypes.js'

const SLOTS = 4
const REFILL_TIME = 1.9 // seconds for a used/discarded palette slot to refill
const ICON = 72 // palette icon canvas size (px)
const CELL = 20 // px per footprint cell (rects); tetrominoes shrink to fit
const LONG_PRESS = 0.5 // seconds to hold a tile to discard it
const DRAG_THRESH = 6 // px of movement before a press becomes a drag
const REROLL_COST = 5 // mana to discard/reroll a palette tile
const COST_GROWTH = 1.2 // gens/turrets: each placed tower of a bucket makes the next 20% pricier
const WALL_COST_GROWTH = 1.01 // walls are one bucket drawn ~58% of the time (fills ~18x faster
// than a gen bucket), so they need a tiny ~1% ramp to climb at a comparable pace
const INCOME_PRICE_FACTOR = 0.02 // every +1 income/sec raises all prices by 2% (global surplus brake)

/**
 * TilePalette - a bottom-center hand of random tiles drawn top-down. 66% are grey
 * tetromino walls; the rest are generators/turrets on square footprints. Drag a
 * tile onto the grid (a real 3D ghost snaps to cells) to place it; R rotates;
 * long-press discards. A consumed slot shows a clockwise ring timer, then refills.
 */
export class TilePalette {
  constructor(demo) {
    this.demo = demo
    this.city = demo.city

    this.raycaster = new Raycaster()
    this.ground = new Plane(new Vector3(0, 1, 0), 0) // y = 0
    this._ndc = new Vector2()
    this._hit = new Vector3()
    this._white = new Color(0xffffff)

    this.pending = null // press in progress
    this.drag = null // active drag
    this.slots = [] // { tile, refill, el, canvas }

    this._onMove = (e) => this._pointerMove(e)
    this._onUp = (e) => this._pointerUp(e)
    this._onStickyDown = (e) => this._stickyDown(e)
    // Esc drops a stuck tile back into its slot.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drag && this.drag.sticky) this._cancelDrag()
    })
    // R rotates the held tile 90deg CW while dragging.
    window.addEventListener('keydown', (e) => {
      if (!this.drag || (e.key !== 'r' && e.key !== 'R')) return
      this.drag.rot = (this.drag.rot + 1) % 4
      this._setGhostGeom() // tetrominoes use a distinct geometry per rotation
      // Rotating changes the footprint, so the re-pick below often lands on a
      // new cell and would fire its own tick. Suppress that one and play the
      // rotate tick instead - a turn is one action, not two.
      this.drag.suppressSnap = true
      if (this.drag.lastX != null) this._dragMove({ clientX: this.drag.lastX, clientY: this.drag.lastY })
      this.drag.suppressSnap = false
      Sounds.play('snap', 1.3, 0.05, 0.22)
    })

    this._buildDOM()
    for (let i = 0; i < this.slots.length; i++) this._setTile(i, this.randomTile())
  }

  // ---- random tiles -----------------------------------------------------------

  /** Draw the next tile from the ONE shared shuffled bag (owned by City, also
   *  used by the start cluster) so variety is enforced - no long runs. */
  randomTile() {
    const spec = this.city.drawTileSpec()
    const topColorIndex = MathUtils.randInt(0, Tower.COLORS.length - 1)
    if (spec.wall) return { wall: true, shapeName: spec.shapeName, topColorIndex }
    // Generators use their fixed type colour; turrets keep a random accent.
    const colorIndex = tileColorIndex(spec.typeTop)
    return { w: spec.s, h: spec.s, typeTop: spec.typeTop, colorIndex, topColorIndex }
  }

  /** Cell offsets for a tile at a given rotation (tetromino state / transposed rect). */
  _cells(tile, rot) {
    if (tile.wall) {
      const states = TetrominoGeometry.states[tile.shapeName]
      // Transposed to match the geometry (which is built transposed).
      return TetrominoGeometry.placeCells(states[rot % states.length])
    }
    const [w, h] = rot % 2 === 0 ? [tile.h, tile.w] : [tile.w, tile.h] // transposed default
    const cells = []
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) cells.push([i, j])
    return cells
  }

  _bbox(cells) {
    let w = 0, h = 0
    for (const [x, y] of cells) { w = Math.max(w, x + 1); h = Math.max(h, y + 1) }
    return [w, h]
  }

  /** The tile's block colour as a THREE.Color (matches its palette icon). */
  _tileColor3(tile, out) {
    if (tile.wall) { out.copy(Tower.COLORS[tile.topColorIndex]); return out }
    if (isGenerator(tile) || isBarracks(tile) || isShield(tile)) {
      out.copy(this.city.accentColors[tile.colorIndex])
    } else if (isTurret(tile)) {
      out.set(0x9aa0aa)
    } else {
      out.copy(Tower.COLORS[tile.topColorIndex])
    }
    return out
  }

  /** Cost-bucket key for a tile (keys the cumulative placement count that drives
   *  escalating price). Walls share one bucket; gens bucket by type + COLOUR (so
   *  same-colour same-type gens count together, regardless of footprint size);
   *  turrets bucket by type only. */
  _typeKey(tile) {
    if (tile.wall) return 'wall'
    if (isGenerator(tile)) return `gen${tile.typeTop}:${tile.colorIndex}`
    return `turret${tile.typeTop}`
  }

  /** Energy cost to place this tile: base (cells x wall?1:2) x COST_GROWTH^(cumulative
   *  count of that bucket the player has placed). Everything escalates now, so
   *  prices keep climbing even as gens expire and you replace them. */
  _tileCost(tile) {
    const base = this._cells(tile, 0).length * (tile.wall ? 4 / 3 : 8 / 3)
    const count = this.city.placedCount(this._typeKey(tile))
    const growth = tile.wall ? WALL_COST_GROWTH : COST_GROWTH
    // Global income factor on top of per-bucket escalation: the stronger your
    // economy, the pricier everything (fights the runaway energy surplus).
    const income = this.city.energy ? this.city.energy.incomePerSec() : 0
    const incomeFactor = 1 + income * INCOME_PRICE_FACTOR
    return Math.round(base * Math.pow(growth, count) * incomeFactor)
  }

  /** Can the player currently afford to place this tile? */
  _affordable(tile) {
    return !this.city.mana || this.city.mana.current >= this._tileCost(tile)
  }

  /** CSS colour for the 2D icon. */
  tileColor(tile) {
    if (tile.wall) return `#${Tower.COLORS[tile.topColorIndex].getHexString()}`
    if (isGenerator(tile)) return `#${this.city.accentColors[tile.colorIndex].getHexString()}`
    if (isTurret(tile)) return '#9aa0aa'
    return `#${Tower.COLORS[tile.topColorIndex].getHexString()}`
  }

  // ---- DOM --------------------------------------------------------------------

  _buildDOM() {
    const wrap = document.createElement('div')
    wrap.id = 'tile-palette'
    Object.assign(wrap.style, {
      position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
      display: 'flex', gap: '8px', zIndex: '550', padding: '10px',
      background: 'rgba(20,20,28,0.7)', border: '1px solid rgba(255,255,255,0.25)',
      borderRadius: '14px', backdropFilter: 'blur(4px)',
    })
    this.wrap = wrap
    for (let i = 0; i < SLOTS; i++) this._buildSlot()
    // Little reroll-all button in the top-right corner of the tray.
    const reroll = this.rerollBtn = document.createElement('button')
    reroll.textContent = '×'
    reroll.title = `Reroll all tiles (${REROLL_COST})`
    Object.assign(reroll.style, {
      position: 'absolute', top: '-9px', right: '-9px',
      width: '22px', height: '22px', borderRadius: '50%', padding: '0',
      background: 'rgba(40,40,52,0.95)', color: '#fff', border: '1px solid rgba(255,255,255,0.45)',
      font: '700 15px ui-monospace, monospace', lineHeight: '1', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '1',
    })
    reroll.addEventListener('click', () => this._rerollAll())
    wrap.appendChild(reroll)
    document.body.appendChild(wrap)
    this.el = wrap
  }

  /** Reroll every slot at once (costs REROLL_COST): clear each tile and run its
   *  refill-ring timer, same as discarding them all. */
  _rerollAll() {
    if (this.city.mana && !this.city.mana.spend(REROLL_COST)) {
      Sounds.play('error', 1.0, 0.2, 0.5)
      return
    }
    Sounds.play('roll', 1.0, 0.15)
    for (let i = 0; i < this.slots.length; i++) this._consume(i)
  }

  _setTile(i, tile) {
    const slot = this.slots[i]
    slot.tile = tile
    slot.refill = 0
    slot.pending = null
    slot.el.style.cursor = 'grab'
    this._drawTile(slot)
    this._updateCostLabel(slot)
  }

  /** Refresh a slot's cost readout (text = energy cost, red when unaffordable). */
  _updateCostLabel(slot) {
    if (!slot.costEl) return
    if (!slot.tile) { slot.costEl.textContent = ''; return }
    slot.costEl.textContent = `${this._tileCost(slot.tile)}`
    slot.costEl.style.color = this._affordable(slot.tile) ? '#fff' : AMMO_COLOR
  }

  // ---- icon drawing -----------------------------------------------------------

  /** Build one palette slot and append it to the tray. Split out of _buildDOM
   *  so the "Wider Hand" power-up can add a slot mid-run. */
  _buildSlot() {
    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'relative',
      width: `${ICON}px`, height: `${ICON}px`,
      cursor: 'grab', touchAction: 'none',
    })
    const canvas = document.createElement('canvas')
    canvas.width = ICON
    canvas.height = ICON
    el.appendChild(canvas)
    // Live energy-cost readout in the bottom corner of each slot.
    const costEl = document.createElement('div')
    Object.assign(costEl.style, {
      position: 'absolute', bottom: '1px', left: '0', width: '100%', textAlign: 'center',
      font: '700 12px ui-monospace, Menlo, monospace', color: '#fff',
      textShadow: '0 1px 2px rgba(0,0,0,0.95)', pointerEvents: 'none',
    })
    el.appendChild(costEl)
    const idx = this.slots.length
    el.addEventListener('pointerdown', (e) => this._pointerDown(e, idx))
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this._discard(idx) })
    // The reroll button is appended last, so insert before it to keep it in the
    // corner rather than stranded mid-tray.
    if (this.rerollBtn) this.wrap.insertBefore(el, this.rerollBtn)
    else this.wrap.appendChild(el)
    this.slots.push({ tile: null, refill: 0, el, canvas, costEl })
    return this.slots.length - 1
  }

  /** Add a slot at runtime (power-up), pre-filled with a tile. */
  addSlot() {
    const i = this._buildSlot()
    this._setTile(i, this.randomTile())
  }

  _drawTile(slot) {
    const ctx = slot.canvas.getContext('2d')
    ctx.clearRect(0, 0, ICON, ICON)
    const tile = slot.tile
    if (!tile) return
    if (tile.wall) { this._drawTetromino(ctx, tile); return }
    this._drawRectTile(ctx, tile)
  }

  /** Grey tetromino: filled cells with per-cell outlines (rotation 0). */
  _drawTetromino(ctx, tile) {
    const cells = TetrominoGeometry.states[tile.shapeName][0]
    const [w, h] = this._bbox(cells)
    const c = Math.min(CELL, (ICON - 8) / Math.max(w, h))
    const ox = (ICON - w * c) / 2
    const oy = (ICON - h * c) / 2
    ctx.fillStyle = this.tileColor(tile)
    for (const [cx, cy] of cells) ctx.fillRect(ox + cx * c, oy + cy * c, c, c)
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'
    ctx.lineWidth = 1
    for (const [cx, cy] of cells) ctx.strokeRect(ox + cx * c + 0.5, oy + cy * c + 0.5, c - 1, c - 1)
  }

  _drawRectTile(ctx, tile) {
    const fw = tile.w * CELL
    const fh = tile.h * CELL
    const ox = (ICON - fw) / 2
    const oy = (ICON - fh) / 2
    const cx = ICON / 2
    const cy = ICON / 2
    const m = Math.min(fw, fh)
    const raised = 'rgba(255,255,255,0.32)'
    const recess = 'rgba(0,0,0,0.3)'
    ctx.fillStyle = this.tileColor(tile)
    ctx.fillRect(ox, oy, fw, fh)

    if (tile.typeTop === TopType.PATH_GENERATOR) {
      const pe = m * 0.28, pt = m * 0.1
      ctx.fillStyle = recess
      ctx.fillRect(cx - pe, cy - pt, pe * 2, pt * 2)
      ctx.fillRect(cx - pt, cy - pe, pt * 2, pe * 2)
    } else if (tile.typeTop === TopType.PEG_TURRET || tile.typeTop === TopType.DIVOT_TURRET || tile.typeTop === TopType.MORTAR_TURRET) {
      const r = m * 0.26
      ctx.fillStyle = tile.typeTop === TopType.PEG_TURRET ? raised : recess
      ctx.beginPath()
      ctx.moveTo(cx, cy - r)
      ctx.lineTo(cx + r * 0.87, cy + r * 0.5)
      ctx.lineTo(cx - r * 0.87, cy + r * 0.5)
      ctx.closePath()
      ctx.fill()
      // Mortar: a lobbed shell dot above the barrel.
      if (tile.typeTop === TopType.MORTAR_TURRET) {
        ctx.fillStyle = recess
        ctx.beginPath(); ctx.arc(cx, cy - r * 0.9, m * 0.1, 0, Math.PI * 2); ctx.fill()
      }
    } else if (tile.typeTop === TopType.BARRACKS) {
      // A quarter-circle pie - the literal Quart_Top roof shape. Was an arched
      // gable with two soldiers under it, which described what the building
      // DOES but looked like nothing on the board; every other glyph here is
      // the roof you're about to place, so this one is too.
      const r = m * 0.52
      // Corner offset back along both axes so the wedge sits centred in the
      // tile rather than hanging off one side (a quarter disc's centroid is
      // ~0.42r from its corner).
      const kx = cx - r * 0.42, ky = cy + r * 0.42
      ctx.fillStyle = raised
      ctx.beginPath()
      ctx.moveTo(kx, ky)
      ctx.arc(kx, ky, r, -Math.PI / 2, 0) // sweep up-and-right from the corner
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = recess
      ctx.lineWidth = Math.max(1, m * 0.05)
      ctx.stroke()
    } else if (tile.typeTop === TopType.SHIELD) {
      // Just the triangle - it IS the roof (Tri_Top). This used to be a small
      // triangle inside a heavy ring standing for the coverage radius, and the
      // ring won: the tile read as a circle, matching nothing you see on the
      // board. Tall and narrow so it doesn't read as a turret, whose glyph is a
      // squat triangle; the accent-coloured tile behind it separates them too.
      const r = m * 0.42
      ctx.fillStyle = raised
      ctx.beginPath()
      ctx.moveTo(cx, cy - r)
      ctx.lineTo(cx + r * 0.66, cy + r * 0.6)
      ctx.lineTo(cx - r * 0.66, cy + r * 0.6)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = recess
      ctx.lineWidth = Math.max(1, m * 0.05)
      ctx.stroke()
    } else if (tile.typeTop === TopType.ENCLOSURE_GENERATOR) {
      // Peg disc reads purely via its drop shadow (same colour as the tile).
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.8)'
      ctx.shadowBlur = m * 0.16
      ctx.shadowOffsetY = m * 0.07
      ctx.fillStyle = this.tileColor(tile)
      ctx.beginPath(); ctx.arc(cx, cy, m * 0.24, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
    }

    if ((tile.w > 1 || tile.h > 1) && tile.typeTop !== TopType.PATH_GENERATOR) {
      ctx.strokeStyle = 'rgba(0,0,0,0.28)'
      ctx.lineWidth = 1
      for (let i = 1; i < tile.w; i++) {
        ctx.beginPath(); ctx.moveTo(ox + i * CELL, oy); ctx.lineTo(ox + i * CELL, oy + fh); ctx.stroke()
      }
      for (let j = 1; j < tile.h; j++) {
        ctx.beginPath(); ctx.moveTo(ox, oy + j * CELL); ctx.lineTo(ox + fw, oy + j * CELL); ctx.stroke()
      }
    }
  }

  /** Clockwise ring timer on the slot canvas (matches the build-wheel). */
  _drawRing(slot, p) {
    const ctx = slot.canvas.getContext('2d')
    ctx.clearRect(0, 0, ICON, ICON)
    const cx = ICON / 2, cy = ICON / 2
    const rO = ICON * 0.32, rI = ICON * 0.21
    const start = -Math.PI / 2
    ctx.beginPath()
    ctx.arc(cx, cy, rO, 0, Math.PI * 2)
    ctx.arc(cx, cy, rI, Math.PI * 2, 0, true)
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fill('evenodd')
    const end = start + Math.max(0.0001, p) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(cx, cy, rO, start, end, false)
    ctx.arc(cx, cy, rI, end, start, true)
    ctx.closePath()
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fill()
  }

  // ---- per-frame: refill timers ----------------------------------------------

  update(dt) {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]
      if (slot.tile) { this._updateCostLabel(slot); continue }
      if (slot.refill <= 0) continue
      slot.refill -= dt
      // Always show the refilled tile; if it's unaffordable its cost reads red and
      // it can't be dragged (no more holding slots empty until affordable).
      if (slot.refill <= 0) this._setTile(i, this.randomTile())
      else this._drawRing(slot, 1 - slot.refill / (REFILL_TIME * Buffs.refillRate))
    }
  }

  _clearCanvas(slot) {
    slot.canvas.getContext('2d').clearRect(0, 0, ICON, ICON)
    if (slot.costEl) slot.costEl.textContent = ''
  }

  _consume(i) {
    const slot = this.slots[i]
    slot.tile = null
    slot.pending = null
    slot.refill = REFILL_TIME * Buffs.refillRate
    slot.el.style.cursor = 'default'
    this._drawRing(slot, 0)
    if (slot.costEl) slot.costEl.textContent = ''
  }

  // ---- press / long-press / drag ---------------------------------------------

  _pointerDown(e, i) {
    if (e.button !== 0) return // left button only; right-click discards
    if (!this.slots[i].tile || this.pending || this.drag) return
    e.preventDefault()
    this.pending = { i, x: e.clientX, y: e.clientY, done: false }
    this.pending.lpTimer = setTimeout(() => this._longPress(i), LONG_PRESS * 1000)
    window.addEventListener('pointermove', this._onMove)
    window.addEventListener('pointerup', this._onUp)
  }

  _longPress(i) {
    if (!this.pending || this.pending.i !== i || this.pending.done || this.drag) return
    this.pending.done = true
    this._discard(i)
  }

  /** Discard a slot's tile and start its refill ring timer (long-press / right-click).
   *  Costs REROLL_COST mana. */
  _discard(i) {
    if (this.drag || !this.slots[i].tile) return
    if (this.city.mana && !this.city.mana.spend(REROLL_COST)) {
      Sounds.play('error', 1.0, 0.2, 0.5)
      return
    }
    this._consume(i)
    Sounds.play('clink', 0.8, 0.1, 0.4)
  }

  _pointerMove(e) {
    if (this.drag) { this._dragMove(e); return }
    if (!this.pending || this.pending.done) return
    if (Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y) > DRAG_THRESH) {
      clearTimeout(this.pending.lpTimer)
      const tile = this.slots[this.pending.i].tile
      if (tile && !this._affordable(tile)) {
        // Too expensive to even pick up — blip and cancel the gesture.
        Sounds.play('error', 1.0, 0.2, 0.5)
        this.pending.done = true
        return
      }
      this._beginDrag(this.pending.i)
      this._dragMove(e)
    }
  }

  _pointerUp() {
    if (this.pending) clearTimeout(this.pending.lpTimer)
    window.removeEventListener('pointermove', this._onMove)
    window.removeEventListener('pointerup', this._onUp)
    if (this.drag) this._dropDrag()
    else if (this.pending && !this.pending.done) this.slots[this.pending.i].el.style.cursor = 'grab'
    this.pending = null
  }

  /**
   * A rejected drop keeps the tile in hand instead of firing it back to the
   * palette: the ghost follows the cursor with no button held, and the next
   * click tries again. Right-click or Esc puts it back.
   */
  _goSticky() {
    this.drag.sticky = true
    window.addEventListener('pointermove', this._onMove)
    // Capture phase: the retry click must not also reach the canvas, or the
    // city's build/destroy handler fires on the same press.
    window.addEventListener('pointerdown', this._onStickyDown, true)
  }

  _endSticky() {
    if (!this.drag || !this.drag.sticky) return
    window.removeEventListener('pointermove', this._onMove)
    window.removeEventListener('pointerdown', this._onStickyDown, true)
  }

  _stickyDown(e) {
    if (!this.drag || !this.drag.sticky) return
    e.preventDefault()
    e.stopPropagation()
    if (e.button !== 0) { this._cancelDrag(); return } // right/middle click puts it back
    this._dragMove(e) // make sure the target matches where they actually clicked
    this._dropDrag()
  }

  /** Put a held tile back in its slot and clear the drag. */
  _cancelDrag() {
    if (!this.drag) return
    const { slot, ghost } = this.drag
    this._endSticky()
    this.city.scene.remove(ghost)
    if (this.demo.controls) this.demo.controls.enabled = true
    this.slots[slot].el.style.cursor = 'grab'
    this._drawTile(this.slots[slot])
    this.drag = null
    Sounds.play('clink', 0.9, 0.1, 0.3)
  }

  /** Ghost geometry for a tile at a rotation (tetromino body / scaled block). */
  _ghostGeomFor(tile, rot) {
    if (tile.wall) {
      const len = TetrominoGeometry.states[tile.shapeName].length
      return this.city.tetroGeom.get(`${tile.shapeName}:${rot % len}`).body
    }
    return BlockGeometry.geoms[roofGeomIndex(tile.typeTop)]
  }

  /** Rebuild the ghost mesh when its geometry changes (swapping .geometry crashes WebGPU). */
  _setGhostGeom() {
    const geo = this._ghostGeomFor(this.drag.tile, this.drag.rot)
    if (this.drag.ghost.geometry === geo) return
    this.city.scene.remove(this.drag.ghost)
    const ghost = new Mesh(geo, this.drag.mat)
    ghost.renderOrder = 5
    this.city.scene.add(ghost)
    this.drag.ghost = ghost
  }

  _beginDrag(i) {
    const tile = this.slots[i].tile
    const mat = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.55, depthTest: false })
    const ghost = new Mesh(this._ghostGeomFor(tile, 0), mat)
    ghost.renderOrder = 5
    this.city.scene.add(ghost)
    // Hide the icon in its slot while it's being dragged.
    this.slots[i].canvas.getContext('2d').clearRect(0, 0, ICON, ICON)
    this.slots[i].el.style.cursor = 'grabbing'
    if (this.demo.controls) this.demo.controls.enabled = false
    const base = this._tileColor3(tile, new Color())
    const hi = base.clone().lerp(this._white, 0.45)
    this.drag = { slot: i, tile, ghost, mat, target: null, base, hi, rot: 0, lastX: null, lastY: null, lastCell: null, sticky: false }
    mat.color.copy(base)
  }

  /**
   * Where the dragged tile would land: footprint (current rotation) centred on
   * the cursor cell. Returns { gx, gy, cells, w, h, valid } or null if off-grid.
   */
  _pickTarget(clientX, clientY) {
    const city = this.city
    this._ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1)
    this.raycaster.setFromCamera(this._ndc, this.demo.camera)
    if (!this.raycaster.ray.intersectPlane(this.ground, this._hit)) return null
    const c = city.worldToCell(this._hit.x, this._hit.z)
    if (!c) return null
    const tile = this.drag.tile
    const cells = this._cells(tile, this.drag.rot)
    const [w, h] = this._bbox(cells)
    const gx = c.gx - Math.floor(w / 2)
    const gy = c.gy - Math.floor(h / 2)
    // Coloured generators are subject to the enclosure colour-claim rule.
    const claimColor = !tile.wall && isGenerator(tile) ? tile.colorIndex : -1
    let valid = city.fits(gx, gy, cells, claimColor)
    // One enclosure generator per enclosure: block placing into an already-claimed area.
    // One claimant per enclosure - and the king counts, so you can't drop a hole
    // block into the region the king is already earning from.
    if (valid && tile.typeTop === TopType.ENCLOSURE_GENERATOR && city.cellClaim) {
      for (const [dx, dy] of cells) {
        if (city.cellClaim[(gy + dy) * city.gridCellsX + (gx + dx)] >= 0) { valid = false; break }
      }
    }
    // Can't build on a loot crate - see LootBoxes.occupiesCell.
    if (valid && city.lootBoxes) {
      for (const [dx, dy] of cells) {
        if (city.lootBoxes.occupiesCell(gx + dx, gy + dy)) { valid = false; break }
      }
    }
    // Can't drop a block onto a cell a creep is standing in.
    if (valid && city.creeps) {
      for (const [dx, dy] of cells) {
        if (city.creeps.creepInCell(gx + dx, gy + dy)) { valid = false; break }
      }
    }
    // Generator cap: no more than MAX_GENS placed at once.
    if (valid && isGenerator(tile) && !city.canPlaceGen()) valid = false
    // Can't afford the (escalating) cost.
    if (valid && !this._affordable(tile)) valid = false
    return { gx, gy, cells, w, h, valid }
  }

  /** True if a screen point is over the palette bar (drag back here to cancel). */
  _overPalette(x, y) {
    if (x == null) return false
    const r = this.el.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }

  _dragMove(e) {
    this.drag.lastX = e.clientX
    this.drag.lastY = e.clientY
    const { tile, ghost, mat, slot } = this.drag
    const city = this.city
    // Over the palette: show the tile back in its slot + hide the ghost (release
    // here puts it back). Re-hide the slot icon when moving back onto the grid.
    const overPal = this._overPalette(e.clientX, e.clientY)
    if (overPal !== this.drag.overPal) {
      this.drag.overPal = overPal
      if (overPal) this._drawTile(this.slots[slot])
      else this._clearCanvas(this.slots[slot])
    }
    if (overPal) { ghost.visible = false; this.drag.target = null; return }
    const t = this._pickTarget(e.clientX, e.clientY)
    this.drag.target = t
    if (!t) { ghost.visible = false; this.drag.lastCell = null; return }
    ghost.visible = true
    // Tick as the ghost snaps to a new cell, so the grid feels magnetic rather
    // than the tile just sliding. Pitched up when the cell is a legal drop.
    const cellKey = `${t.gx},${t.gy}`
    if (cellKey !== this.drag.lastCell) {
      this.drag.lastCell = cellKey
      if (!this.drag.suppressSnap) Sounds.play('snap', t.valid ? 1.0 : 0.75, 0.06, t.valid ? 0.15 : 0.08)
    }
    const cu = city.cellUnit
    if (tile.wall) {
      // Geometry is centred on its bbox; thin flat preview.
      ghost.position.set(
        t.gx * cu + (t.w * cu) / 2 + city.gridOffsetX,
        0.2,
        t.gy * cu + (t.h * cu) / 2 + city.gridOffsetZ
      )
      ghost.scale.set(1, 0.3, 1)
    } else {
      const roofHalf = BlockGeometry.halfHeights[roofGeomIndex(tile.typeTop)]
      ghost.position.set(
        t.gx * cu + (t.w * cu) / 2 + city.gridOffsetX,
        roofHalf + 0.12,
        t.gy * cu + (t.h * cu) / 2 + city.gridOffsetZ
      )
      ghost.scale.set(t.w * cu, 1, t.h * cu)
    }
    if (t.valid) { mat.color.copy(this.drag.hi); mat.opacity = 0.92 }
    else { mat.color.copy(this.drag.base); mat.opacity = 0.5 }
  }

  _dropDrag() {
    const { slot, tile, ghost, target, rot } = this.drag
    const city = this.city
    const finish = () => {
      this._endSticky()
      city.scene.remove(ghost)
      if (this.demo.controls) this.demo.controls.enabled = true
      this.slots[slot].el.style.cursor = 'grab'
      this.drag = null
    }
    const restore = () => { finish(); this._drawTile(this.slots[slot]) }
    // Released over the palette: drop it back in its slot (no place, no error).
    if (this._overPalette(this.drag.lastX, this.drag.lastY)) { restore(); return }
    if (target && target.valid) {
      // Escalating placement cost (per-type standing count); validity already
      // confirmed it's affordable.
      const cost = this._tileCost(tile)
      const opts = tile.wall
        ? {
          tetro: { name: tile.shapeName, rot: rot % TetrominoGeometry.states[tile.shapeName].length },
          typeTop: TopType.SQUARE, colorIndex: 0, topColorIndex: tile.topColorIndex,
        }
        : { typeTop: tile.typeTop, colorIndex: tile.colorIndex, topColorIndex: tile.topColorIndex }
      const placed = city.placeTileFree(target.gx, target.gy, target.cells, opts)
      if (placed) {
        finish()
        city.mana?.spend(cost)
        city.recordPlacement(this._typeKey(tile)) // bump the cumulative per-type price
        this._consume(slot)
        // Floating "-cost" caption rising from the drop spot (like the gen "+N").
        const cu = city.cellUnit
        const wx = (target.gx + target.w / 2) * cu + city.gridOffsetX
        const wz = (target.gy + target.h / 2) * cu + city.gridOffsetZ
        this.demo.floatingText?.spawn(wx, 2, wz, `-${cost}`, ENERGY_COLOR, 0, null)
      } else restore() // pool exhausted: restore icon, no charge
    } else {
      // Invalid cell (or off-grid): hold onto it so a misjudged drop doesn't
      // cost a trip back to the palette. Click again to retry, Esc to give up.
      Sounds.play('error', 1.0, 0.2, 0.5)
      if (!this.drag.sticky) this._goSticky()
    }
  }
}
