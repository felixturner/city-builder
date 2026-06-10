import { Mesh, MeshBasicNodeMaterial, Raycaster, Plane, Vector2, Vector3, Color, MathUtils } from 'three/webgpu'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { Sounds } from '../lib/Sounds.js'
import { Tower } from '../Tower.js'
import { TopType, isTurret } from '../blockTypes.js'

const SLOTS = 4
const REFILL_TIME = 2.5 // seconds for a used/discarded palette slot to refill
const ICON = 72 // palette icon canvas size (px)
const CELL = 20 // constant px per footprint cell, so 3x3 fills, 1x1 is small
const LONG_PRESS = 0.5 // seconds to hold a tile to discard it
const DRAG_THRESH = 6 // px of movement before a press becomes a drag

/**
 * TilePalette - a bottom-center hand of 3 random tiles (type + footprint + colour),
 * drawn top-down at a constant cell scale. Drag a tile onto a matching empty slot
 * (a real 3D ghost snaps to valid slots) to place a level-0 block; long-press a
 * tile to discard it. A consumed slot shows a clockwise ring timer, then refills.
 */
export class TilePalette {
  constructor(demo) {
    this.demo = demo
    this.city = demo.city

    this.raycaster = new Raycaster()
    this.ground = new Plane(new Vector3(0, 1, 0), 0) // y = 0
    this._ndc = new Vector2()
    this._hit = new Vector3()
    this._size = new Vector2()
    this._center = new Vector2()
    this._white = new Color(0xffffff)

    this.pending = null // press in progress: { i, x, y, lpTimer, done }
    this.drag = null // active drag: { slot, tile, ghost, mat, target }
    this.slots = [] // { tile, refill, el, canvas }

    this._onMove = (e) => this._pointerMove(e)
    this._onUp = (e) => this._pointerUp(e)

    this._buildDOM()
    for (let i = 0; i < SLOTS; i++) this._setTile(i, this.randomTile())
  }

  // ---- random tiles -----------------------------------------------------------

  randomTile() {
    let w, h
    if (Math.random() < 0.55) {
      const r = Math.random()
      w = h = r < 0.55 ? 1 : (r < 0.9 ? 2 : 3) // square: mostly 1, some 2, rare 3
    } else {
      const long = Math.random() < 0.7 ? 2 : 3
      if (Math.random() < 0.5) { w = 1; h = long } else { w = long; h = 1 }
    }
    const is1x1 = w === 1 && h === 1
    const isSquare = w === h
    let types
    if (is1x1) types = [TopType.SQUARE, TopType.QUART, TopType.ADJ_GENERATOR, TopType.PEG_TURRET, TopType.DIVOT_TURRET, TopType.PATH_GENERATOR]
    else if (isSquare) types = [TopType.SQUARE, TopType.QUART, TopType.ADJ_GENERATOR, TopType.PATH_GENERATOR]
    else types = [TopType.SQUARE, TopType.QUART] // non-square: grey only
    const typeTop = types[MathUtils.randInt(0, types.length - 1)]
    return {
      w, h, typeTop,
      colorIndex: MathUtils.randInt(0, 2), // accent (generators)
      topColorIndex: MathUtils.randInt(0, Tower.COLORS.length - 1), // grey top colour
    }
  }

  /** Top-down colour: accent for generators, the coloured top for grey, grey for turrets. */
  tileColor(tile) {
    if (tile.typeTop === TopType.PATH_GENERATOR || tile.typeTop === TopType.ADJ_GENERATOR) {
      return `#${this.city.accentColors[tile.colorIndex].getHexString()}`
    }
    if (isTurret(tile)) return '#9aa0aa'
    return `#${Tower.COLORS[tile.topColorIndex].getHexString()}` // grey block: coloured top
  }

  // ---- DOM --------------------------------------------------------------------

  _buildDOM() {
    const wrap = document.createElement('div')
    wrap.id = 'tile-palette'
    Object.assign(wrap.style, {
      position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
      display: 'flex', gap: '12px', zIndex: '550',
    })
    for (let i = 0; i < SLOTS; i++) {
      const el = document.createElement('div')
      Object.assign(el.style, {
        width: `${ICON}px`, height: `${ICON}px`, borderRadius: '10px',
        background: 'rgba(20,20,28,0.7)', border: '1px solid rgba(255,255,255,0.25)',
        cursor: 'grab', touchAction: 'none', backdropFilter: 'blur(4px)',
      })
      const canvas = document.createElement('canvas')
      canvas.width = ICON
      canvas.height = ICON
      el.appendChild(canvas)
      const idx = i
      el.addEventListener('pointerdown', (e) => this._pointerDown(e, idx))
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
    slot.el.style.cursor = 'grab'
    this._drawTile(slot)
  }

  /** Draw a tile top-down at constant cell scale, matching the real block shape. */
  _drawTile(slot) {
    const ctx = slot.canvas.getContext('2d')
    ctx.clearRect(0, 0, ICON, ICON)
    const tile = slot.tile
    if (!tile) return
    const fw = tile.w * CELL
    const fh = tile.h * CELL
    const ox = (ICON - fw) / 2
    const oy = (ICON - fh) / 2
    const cx = ICON / 2
    const cy = ICON / 2
    const m = Math.min(fw, fh)
    const raised = 'rgba(255,255,255,0.32)' // raised feature highlight
    const recess = 'rgba(0,0,0,0.3)' // recessed feature shadow
    ctx.fillStyle = this.tileColor(tile)

    if (tile.typeTop === TopType.QUART) {
      this._quartPath(ctx, ox, oy, fw, fh)
      ctx.fill()
    } else {
      ctx.fillRect(ox, oy, fw, fh) // square footprint
      if (tile.typeTop === TopType.PATH_GENERATOR) {
        // Small inset plus carved into the centre of the block.
        const pe = m * 0.28 // half-length of each arm from centre
        const pt = m * 0.1 // half-thickness of each arm
        ctx.fillStyle = recess
        ctx.fillRect(cx - pe, cy - pt, pe * 2, pt * 2) // horizontal bar
        ctx.fillRect(cx - pt, cy - pe, pt * 2, pe * 2) // vertical bar
      } else if (tile.typeTop === TopType.ADJ_GENERATOR) {
        // Circular hole cut through the tile.
        ctx.save()
        ctx.globalCompositeOperation = 'destination-out'
        ctx.beginPath(); ctx.arc(cx, cy, m * 0.26, 0, Math.PI * 2); ctx.fill()
        ctx.restore()
      } else if (tile.typeTop === TopType.PEG_TURRET || tile.typeTop === TopType.DIVOT_TURRET) {
        // Turret: inset triangle. Peg raised (highlight), divot recessed (shadow).
        const r = m * 0.26
        ctx.fillStyle = tile.typeTop === TopType.PEG_TURRET ? raised : recess
        ctx.beginPath()
        ctx.moveTo(cx, cy - r)
        ctx.lineTo(cx + r * 0.87, cy + r * 0.5)
        ctx.lineTo(cx - r * 0.87, cy + r * 0.5)
        ctx.closePath()
        ctx.fill()
      }
      // SQUARE: plain flat block (no feature).
    }

    // Cell grid lines (a 2x2 shows a central H + V line), clipped to the tile
    // shape so curved (quart) tiles still show their grid. Skipped on the cross,
    // where they'd clash with the plus.
    if ((tile.w > 1 || tile.h > 1) && tile.typeTop !== TopType.PATH_GENERATOR) {
      ctx.save()
      if (tile.typeTop === TopType.QUART) {
        this._quartPath(ctx, ox, oy, fw, fh)
        ctx.clip()
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.28)'
      ctx.lineWidth = 1
      for (let i = 1; i < tile.w; i++) {
        ctx.beginPath(); ctx.moveTo(ox + i * CELL, oy); ctx.lineTo(ox + i * CELL, oy + fh); ctx.stroke()
      }
      for (let j = 1; j < tile.h; j++) {
        ctx.beginPath(); ctx.moveTo(ox, oy + j * CELL); ctx.lineTo(ox + fw, oy + j * CELL); ctx.stroke()
      }
      ctx.restore()
    }
  }

  /** Clockwise ring timer on the slot canvas (matches the build-wheel). */
  _drawRing(slot, p) {
    const ctx = slot.canvas.getContext('2d')
    ctx.clearRect(0, 0, ICON, ICON)
    const cx = ICON / 2, cy = ICON / 2
    const rO = ICON * 0.32, rI = ICON * 0.21
    const start = -Math.PI / 2 // 12 o'clock
    // Faint full track.
    ctx.beginPath()
    ctx.arc(cx, cy, rO, 0, Math.PI * 2)
    ctx.arc(cx, cy, rI, Math.PI * 2, 0, true)
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fill('evenodd')
    // Filled wedge, growing clockwise.
    const end = start + Math.max(0.0001, p) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(cx, cy, rO, start, end, false)
    ctx.arc(cx, cy, rI, end, start, true)
    ctx.closePath()
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fill()
  }

  _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  /**
   * Quarter-circle path with the right angle at the bottom-RIGHT corner (curve
   * bulges to the top-left). H-mirrored so it matches the placed 3D tile.
   */
  _quartPath(ctx, ox, oy, fw, fh) {
    ctx.beginPath()
    ctx.moveTo(ox + fw, oy + fh) // right-angle corner
    ctx.lineTo(ox + fw, oy) // up the right edge
    ctx.ellipse(ox + fw, oy + fh, fw, fh, 0, -Math.PI / 2, -Math.PI, true)
    ctx.closePath()
  }

  // ---- per-frame: refill timers ----------------------------------------------

  update(dt) {
    for (let i = 0; i < SLOTS; i++) {
      const slot = this.slots[i]
      if (slot.tile || slot.refill <= 0) continue
      slot.refill -= dt
      if (slot.refill <= 0) this._setTile(i, this.randomTile())
      else this._drawRing(slot, 1 - slot.refill / REFILL_TIME)
    }
  }

  /** Empty a slot and start its refill ring. */
  _consume(i) {
    const slot = this.slots[i]
    slot.tile = null
    slot.refill = REFILL_TIME
    slot.el.style.cursor = 'default'
    this._drawRing(slot, 0)
  }

  // ---- press / long-press / drag ---------------------------------------------

  _pointerDown(e, i) {
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
    this._consume(i) // discard -> refill ring -> new tile after timeout
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

  _pointerUp(e) {
    if (this.pending) clearTimeout(this.pending.lpTimer)
    window.removeEventListener('pointermove', this._onMove)
    window.removeEventListener('pointerup', this._onUp)
    if (this.drag) this._dropDrag()
    else if (this.pending && !this.pending.done) this.slots[this.pending.i].el.style.cursor = 'grab'
    this.pending = null
  }

  /** The tile's actual block colour as a THREE.Color (matches its palette icon). */
  _tileColor3(tile, out) {
    if (tile.typeTop === TopType.PATH_GENERATOR || tile.typeTop === TopType.ADJ_GENERATOR) {
      out.copy(this.city.accentColors[tile.colorIndex])
    } else if (isTurret(tile)) {
      out.set(0x9aa0aa)
    } else {
      out.copy(Tower.COLORS[tile.topColorIndex])
    }
    return out
  }

  _beginDrag(i) {
    const tile = this.slots[i].tile
    const geo = BlockGeometry.geoms[tile.typeTop]
    const mat = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.55, depthTest: false })
    const ghost = new Mesh(geo, mat)
    ghost.renderOrder = 5
    this.city.scene.add(ghost)
    this.slots[i].el.style.cursor = 'grabbing'
    if (this.demo.controls) this.demo.controls.enabled = false
    // Regular colour = the tile's real colour; highlight = brighter (over a slot).
    const base = this._tileColor3(tile, new Color())
    const hi = base.clone().lerp(this._white, 0.45)
    this.drag = { slot: i, tile, ghost, mat, target: null, base, hi }
    mat.color.copy(base)
  }

  /**
   * Find where the dragged tile would land: the lot/cell under the cursor, with
   * the footprint centred on it. Tries both orientations (rotation) for
   * non-square tiles. Returns { lot, cx, cy, w, h } or null if it doesn't fit.
   */
  _pickTarget(clientX, clientY) {
    const city = this.city
    this._ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1)
    this.raycaster.setFromCamera(this._ndc, this.demo.camera)
    if (!this.raycaster.ray.intersectPlane(this.ground, this._hit)) return null
    const lc = city.worldToLotCell(this._hit.x, this._hit.z)
    if (!lc || !lc.lot.active) return null
    const tile = this.drag.tile
    // Preferred orientation is transposed (tile h -> world X) so the placement
    // reads the same as the flat palette icon under the iso camera; fall back to
    // the other orientation when it's needed to fit.
    const orients = tile.w === tile.h ? [[tile.w, tile.h]] : [[tile.h, tile.w], [tile.w, tile.h]]
    for (const [w, h] of orients) {
      const ax = lc.cx - Math.floor(w / 2) // centre the footprint on the cursor cell
      const ay = lc.cy - Math.floor(h / 2)
      if (city.fits(lc.lot, ax, ay, w, h)) return { lot: lc.lot, cx: ax, cy: ay, w, h }
    }
    return null
  }

  _dragMove(e) {
    const { tile, ghost, mat } = this.drag
    const city = this.city
    const target = this._pickTarget(e.clientX, e.clientY)
    this.drag.target = target
    const roofHalf = BlockGeometry.halfHeights[tile.typeTop]
    if (target) {
      const x0 = target.lot.lotX * city.cellSize + target.cx * city.cellUnit
      const z0 = target.lot.lotY * city.cellSize + target.cy * city.cellUnit
      ghost.position.set(
        x0 + (target.w * city.cellUnit) / 2 + city.gridOffsetX,
        roofHalf + 0.12,
        z0 + (target.h * city.cellUnit) / 2 + city.gridOffsetZ
      )
      ghost.scale.set(target.w * city.cellUnit, 1, target.h * city.cellUnit)
      mat.color.copy(this.drag.hi) // highlight over a valid spot
      mat.opacity = 0.92
    } else {
      ghost.position.set(this._hit.x, roofHalf + 0.12, this._hit.z)
      ghost.scale.set(tile.h * city.cellUnit, 1, tile.w * city.cellUnit) // transposed to match the icon
      mat.color.copy(this.drag.base) // regular tile colour
      mat.opacity = 0.5
    }
  }

  _dropDrag() {
    const { slot, tile, ghost, target } = this.drag
    this.city.scene.remove(ghost)
    if (this.demo.controls) this.demo.controls.enabled = true
    if (target) {
      const placed = this.city.placeTileFree(
        target.lot, target.cx, target.cy, target.w, target.h,
        tile.typeTop, tile.colorIndex, tile.topColorIndex
      )
      if (placed) this._consume(slot)
      else this.slots[slot].el.style.cursor = 'grab' // pool exhausted
    } else {
      this.slots[slot].el.style.cursor = 'grab'
    }
    this.drag = null
  }
}
