import { Mesh, MeshBasicNodeMaterial, Raycaster, Plane, Vector2, Vector3, Color, MathUtils } from 'three/webgpu'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TetrominoGeometry } from '../lib/TetrominoGeometry.js'
import { Sounds } from '../lib/Sounds.js'
import { Tower } from '../Tower.js'
import { TopType, isTurret, isGenerator, roofGeomIndex } from '../blockTypes.js'

const SLOTS = 6
const REFILL_TIME = 2.5 // seconds for a used/discarded palette slot to refill
const ICON = 72 // palette icon canvas size (px)
const CELL = 20 // px per footprint cell (rects); tetrominoes shrink to fit
const LONG_PRESS = 0.5 // seconds to hold a tile to discard it
const DRAG_THRESH = 6 // px of movement before a press becomes a drag
const WALL_CHANCE = 0.5 // share of tiles that are grey tetromino walls
const REROLL_COST = 5 // mana to discard/reroll a palette tile

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
    // R rotates the held tile 90deg CW while dragging.
    window.addEventListener('keydown', (e) => {
      if (!this.drag || (e.key !== 'r' && e.key !== 'R')) return
      this.drag.rot = (this.drag.rot + 1) % 4
      this._setGhostGeom() // tetrominoes use a distinct geometry per rotation
      if (this.drag.lastX != null) this._dragMove({ clientX: this.drag.lastX, clientY: this.drag.lastY })
    })

    this._buildDOM()
    for (let i = 0; i < SLOTS; i++) this._setTile(i, this.randomTile())
  }

  // ---- random tiles -----------------------------------------------------------

  randomTile() {
    const topColorIndex = MathUtils.randInt(0, Tower.COLORS.length - 1)
    if (Math.random() < WALL_CHANCE) {
      // Grey tetromino wall.
      const shapeName = TetrominoGeometry.names[MathUtils.randInt(0, TetrominoGeometry.names.length - 1)]
      return { wall: true, shapeName, topColorIndex }
    }
    // Generator / turret on a square footprint (turrets only on 1x1).
    const r = Math.random()
    const s = r < 0.6 ? 1 : (r < 0.9 ? 2 : 3)
    const types = s === 1
      ? [TopType.ADJ_GENERATOR, TopType.PATH_GENERATOR, TopType.ENCLOSURE_GENERATOR, TopType.PEG_TURRET, TopType.DIVOT_TURRET, TopType.MORTAR_TURRET]
      : [TopType.ADJ_GENERATOR, TopType.PATH_GENERATOR, TopType.ENCLOSURE_GENERATOR]
    const typeTop = types[MathUtils.randInt(0, types.length - 1)]
    return { w: s, h: s, typeTop, colorIndex: MathUtils.randInt(0, 2), topColorIndex }
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
    if (isGenerator(tile)) {
      out.copy(this.city.accentColors[tile.colorIndex])
    } else if (isTurret(tile)) {
      out.set(0x9aa0aa)
    } else {
      out.copy(Tower.COLORS[tile.topColorIndex])
    }
    return out
  }

  /** Energy cost to place this tile: cells x (wall ? 1 : 2). */
  _tileCost(tile) {
    return this._cells(tile, 0).length * (tile.wall ? 1 : 2)
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
    for (let i = 0; i < SLOTS; i++) {
      const el = document.createElement('div')
      Object.assign(el.style, {
        width: `${ICON}px`, height: `${ICON}px`,
        cursor: 'grab', touchAction: 'none',
      })
      const canvas = document.createElement('canvas')
      canvas.width = ICON
      canvas.height = ICON
      el.appendChild(canvas)
      const idx = i
      el.addEventListener('pointerdown', (e) => this._pointerDown(e, idx))
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); this._discard(idx) })
      wrap.appendChild(el)
      this.slots.push({ tile: null, refill: 0, el, canvas })
    }
    document.body.appendChild(wrap)
    this.el = wrap
  }

  _setTile(i, tile) {
    const slot = this.slots[i]
    slot.tile = tile
    slot.refill = 0
    slot.pending = null
    slot.el.style.cursor = 'grab'
    this._drawTile(slot)
  }

  // ---- icon drawing -----------------------------------------------------------

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
    } else if (tile.typeTop === TopType.ADJ_GENERATOR) {
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.beginPath(); ctx.arc(cx, cy, m * 0.26, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
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
    } else if (tile.typeTop === TopType.ENCLOSURE_GENERATOR) {
      // Raised peg disc.
      ctx.fillStyle = raised
      ctx.beginPath(); ctx.arc(cx, cy, m * 0.24, 0, Math.PI * 2); ctx.fill()
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
    for (let i = 0; i < SLOTS; i++) {
      const slot = this.slots[i]
      if (slot.tile) continue
      // A rolled tile waits (empty slot) until the player can afford it.
      if (slot.pending) {
        if (this._affordable(slot.pending)) this._setTile(i, slot.pending)
        continue
      }
      if (slot.refill <= 0) continue
      slot.refill -= dt
      if (slot.refill <= 0) {
        const tile = this.randomTile()
        if (this._affordable(tile)) this._setTile(i, tile)
        else { slot.pending = tile; this._clearCanvas(slot) } // hold until affordable
      } else {
        this._drawRing(slot, 1 - slot.refill / REFILL_TIME)
      }
    }
  }

  _clearCanvas(slot) {
    slot.canvas.getContext('2d').clearRect(0, 0, ICON, ICON)
  }

  _consume(i) {
    const slot = this.slots[i]
    slot.tile = null
    slot.pending = null
    slot.refill = REFILL_TIME
    slot.el.style.cursor = 'default'
    this._drawRing(slot, 0)
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
    this.drag = { slot: i, tile, ghost, mat, target: null, base, hi, rot: 0, lastX: null, lastY: null }
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
    return { gx, gy, cells, w, h, valid: city.fits(gx, gy, cells, claimColor) }
  }

  _dragMove(e) {
    this.drag.lastX = e.clientX
    this.drag.lastY = e.clientY
    const { tile, ghost, mat } = this.drag
    const city = this.city
    const t = this._pickTarget(e.clientX, e.clientY)
    this.drag.target = t
    if (!t) { ghost.visible = false; return }
    ghost.visible = true
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
    city.scene.remove(ghost)
    if (this.demo.controls) this.demo.controls.enabled = true
    const restore = () => { this.slots[slot].el.style.cursor = 'grab'; this._drawTile(this.slots[slot]) }
    if (target && target.valid) {
      // Placement cost: walls 1/cell, generators/turrets 2/cell. Always affordable
      // here - the slot is locked when unaffordable, and energy only rises mid-drag.
      const cost = target.cells.length * (tile.wall ? 1 : 2)
      const opts = tile.wall
        ? {
          tetro: { name: tile.shapeName, rot: rot % TetrominoGeometry.states[tile.shapeName].length },
          typeTop: TopType.SQUARE, colorIndex: 0, topColorIndex: tile.topColorIndex,
        }
        : { typeTop: tile.typeTop, colorIndex: tile.colorIndex, topColorIndex: tile.topColorIndex }
      const placed = city.placeTileFree(target.gx, target.gy, target.cells, opts)
      if (placed) { city.mana?.spend(cost); this._consume(slot) }
      else restore() // pool exhausted: restore icon, no charge
    } else {
      restore() // drag cancelled: restore icon
    }
    this.drag = null
  }
}
