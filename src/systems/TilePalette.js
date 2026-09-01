import { Mesh, MeshBasicNodeMaterial, Raycaster, Plane, Vector2, Vector3, Color, MathUtils } from 'three/webgpu'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TetrominoGeometry } from '../lib/TetrominoGeometry.js'
import { Sounds } from '../lib/Sounds.js'
import { Buffs } from '../buffs.js'
import { ENERGY_COLOR, AMMO_COLOR } from '../palette.js'
import { Tower } from '../Tower.js'
import { ICON, CELL, drawTile, drawRing, tileColor, cellBounds } from './tileIcons.js'
import { costKey, priceOfTile } from './tileCost.js'
import { TopType, isTurret, isGenerator, isBarracks, isShield, roofGeomIndex, tileColorIndex, BARRACKS_COLOR } from '../blockTypes.js'

const SLOTS = 4
const REFILL_TIME = 1.33 // seconds for a used/discarded palette slot to refill
const LONG_PRESS = 0.5 // seconds to hold a tile to discard it
const DRAG_THRESH = 6 // px of movement before a press becomes a drag
// Tray opacity while a tile is in hand, so the ghost stays readable through it.
const TRAY_DRAG_OPACITY = '0.25'
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
    this._onStickyDown = (e) => this._stickyDown(e)
    // Esc drops a stuck tile back into its slot.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drag && this.drag.sticky) this._cancelDrag()
    })
    // R rotates the held tile 90deg CW while dragging.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'r' || e.key === 'R') this.rotateHeld()
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
    if (spec.wall) {
      // Random orientation per tile, so the hand isn't four copies of the same
      // shape. The offset that made this look broken was the board's grid
      // centring, not rotation - see City.initGrid.
      const states = TetrominoGeometry.states[spec.shapeName].length
      return { wall: true, shapeName: spec.shapeName, topColorIndex, rot: MathUtils.randInt(0, states - 1) }
    }
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
    return costKey({ isWall: !!tile.wall, typeTop: tile.typeTop, colorIndex: tile.colorIndex })
  }

  /** Energy cost to place this tile - see systems/tileCost.js. Shared with the
   *  click-to-add-a-floor path so the two can never disagree again. */
  _tileCost(tile) {
    return priceOfTile(this.city, tile)
  }

  /** Can the player currently afford to place this tile? */
  _affordable(tile) {
    return !this.city.mana || this.city.mana.current >= this._tileCost(tile)
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
      position: 'absolute', top: '-18px', right: '-18px',
      width: '44px', height: '44px', borderRadius: '50%', padding: '0',
      background: 'rgba(40,40,52,0.95)', color: '#fff', border: '1px solid rgba(255,255,255,0.45)',
      font: '700 30px ui-monospace, monospace', lineHeight: '1', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '1',
    })
    reroll.addEventListener('click', () => { if (!this.demo.buildLocked) this._rerollAll() })
    wrap.appendChild(reroll)

    // Price tag under the button. The cost was only in the tooltip, which is no
    // use on touch and no use at a glance - and rerolling is the one action here
    // whose cost isn't already printed on the thing you're clicking.
    const cost = document.createElement('div')
    cost.textContent = `${REROLL_COST}`
    Object.assign(cost.style, {
      position: 'absolute', top: '26px', right: '-18px', width: '44px',
      textAlign: 'center', pointerEvents: 'none',
      font: '700 12px ui-monospace, monospace', color: '#fff',
      textShadow: '0 1px 3px rgba(0,0,0,0.9)',
    })
    wrap.appendChild(cost)
    document.body.appendChild(wrap)
    this.el = wrap
    this._buildRotateButton()
    this.layout()
    window.addEventListener('resize', () => this.layout())
  }

  /**
   * Rotate control for touch, where there's no R key. Bottom-left, styled as
   * the tray is so it reads as part of the same furniture.
   *
   * It turns the HELD tile mid-drag, which is the only moment rotation means
   * anything - so it has to be reachable with the other thumb while one is
   * already down on the board.
   */
  _buildRotateButton() {
    const btn = document.createElement('button')
    btn.setAttribute('aria-label', 'Rotate tile')
    Object.assign(btn.style, {
      position: 'fixed', bottom: '18px', left: '18px',
      width: '58px', height: '58px', padding: '0',
      background: 'rgba(20,20,28,0.7)', border: '1px solid rgba(255,255,255,0.25)',
      borderRadius: '14px', backdropFilter: 'blur(4px)',
      display: 'none', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', zIndex: '551', touchAction: 'manipulation', color: '#fff',
    })
    // 90-degree rotation arrow: a three-quarter arc with a head on the end.
    btn.innerHTML = `
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 12a8 8 0 1 1-2.34-5.66"/>
        <polyline points="20 4 20 10 14 10"/>
      </svg>`
    // pointerdown, not click: a drag already owns the primary pointer, and a
    // click wouldn't fire until release - by which time the tile is dropped.
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.rotateHeld()
    })
    document.body.appendChild(btn)
    this.rotateBtn = btn
  }

  /**
   * Place the rotate button, and get out of the tray's way when the screen is
   * too narrow to sit beside it.
   *
   * Shown on touch devices only - on a mouse the R key already does this and a
   * permanent button is clutter.
   */
  layout() {
    const btn = this.rotateBtn
    if (!btn) return
    const touch = matchMedia('(pointer: coarse)').matches
    btn.style.display = touch ? 'flex' : 'none'
    if (!touch) return

    const tray = this.el.getBoundingClientRect()
    const BTN = 58, GAP = 18
    // Room to the left of the tray? Sit beside it. Otherwise stack above it,
    // still on the left edge, so it never overlaps the tiles.
    if (tray.left >= BTN + GAP * 2) {
      btn.style.bottom = `${GAP}px`
    } else {
      btn.style.bottom = `${GAP + tray.height + 10}px`
    }
  }

  /** Turn the tile currently in hand. Shared by the R key and the on-screen
   *  button so the two can't drift apart. */
  rotateHeld() {
    if (!this.drag) return
    this.drag.rot = (this.drag.rot + 1) % 4
    this._setGhostGeom() // tetrominoes use a distinct geometry per rotation
    // Corner roofs reuse one geometry, so _setGhostGeom bails and the turn has
    // to be applied to the mesh directly.
    this.drag.ghost.rotation.y = this._roofRotation(this.drag.tile, this.drag.rot)
    // Rotating changes the footprint, so the re-pick below often lands on a new
    // cell and would fire its own tick. Suppress that one and play the rotate
    // tick instead - a turn is one action, not two.
    this.drag.suppressSnap = true
    if (this.drag.lastX != null) this._dragMove({ clientX: this.drag.lastX, clientY: this.drag.lastY })
    this.drag.suppressSnap = false
    Sounds.play('snap', 1.3, 0.05, 0.22)
  }

  /** Reroll every slot at once (costs REROLL_COST): clear each tile and run its
   *  refill-ring timer, same as discarding them all. */
  _rerollAll() {
    if (this.city.mana && !this.city.mana.spend(REROLL_COST)) {
      Sounds.play('error', 1.0, 0.06, 0.35)
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
    drawTile(slot, this.city.accentColors)
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
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!this.demo.buildLocked) this._discard(idx)
    })
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
      else drawRing(slot, 1 - slot.refill / (REFILL_TIME * Buffs.refillRate))
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
    drawRing(slot, 0)
    if (slot.costEl) slot.costEl.textContent = ''
  }

  // ---- press / long-press / drag ---------------------------------------------

  _pointerDown(e, i) {
    if (e.button !== 0) return // left button only; right-click discards
    if (this.demo.buildLocked) return // paused / game over: the tray is inert
    if (!this.slots[i].tile || this.pending || this.drag) return
    e.preventDefault()
    // Remember WHICH pointer owns this drag. On touch a second finger (tapping
    // rotate) raises its own pointerup on window, and without this check that
    // release ended the drag and sent the tile back to the tray - which is
    // exactly what made the rotate button look broken.
    this.pending = { i, x: e.clientX, y: e.clientY, done: false, id: e.pointerId }
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
      Sounds.play('error', 1.0, 0.06, 0.35)
      return
    }
    this._consume(i)
    Sounds.play('clink', 0.8, 0.1, 0.4)
  }

  _pointerMove(e) {
    const owner = this.drag ? this.drag.pointerId : (this.pending && this.pending.id)
    if (owner !== undefined && e.pointerId !== undefined && e.pointerId !== owner) return
    if (this.drag) { this._dragMove(e); return }
    if (!this.pending || this.pending.done) return
    if (Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y) > DRAG_THRESH) {
      clearTimeout(this.pending.lpTimer)
      const tile = this.slots[this.pending.i].tile
      if (tile && !this._affordable(tile)) {
        // Too expensive to even pick up. Same cue as any other "you can't
        // afford that" - error is for a move that's wrong, not one you're
        // merely too poor to make.
        Sounds.play('error', 1.0, 0.06, 0.35)
        this.pending.done = true
        return
      }
      this._beginDrag(this.pending.i)
      this._dragMove(e)
    }
  }

  _pointerUp(e) {
    // Only the pointer that started the drag can end it.
    const owner = this.drag ? this.drag.pointerId : (this.pending && this.pending.id)
    if (e && owner !== undefined && e.pointerId !== owner) return
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
    // This listener is on window in CAPTURE phase, so it runs before the
    // buttons' own handlers. Without this the rotate button was never really
    // clicked: the capture handler saw the press first and dropped the held
    // tile at the button's screen position. Let UI presses through to the UI.
    if (this._overUI(e.clientX, e.clientY)) return
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
    this._setTrayFaded(false)
    this.city.scene.remove(ghost)
    if (this.demo.controls) this.demo.controls.enabled = true
    this.slots[slot].el.style.cursor = 'grab'
    drawTile(this.slots[slot], this.city.accentColors)
    this.drag = null
    Sounds.play('clink', 0.9, 0.1, 0.3)
  }

  /**
   * World Y rotation for a non-wall tile's roof, in radians.
   *
   * Only the two corner-shaped roofs have a facing worth turning - shield
   * (triangle) and barracks (quarter circle). It is NEGATIVE because a tile's
   * quarter turns run the opposite way to three.js's Y rotation: the tetromino
   * states step +X -> +Z, whereas rotation.y = +90deg sends +X -> -Z.
   */
  _roofRotation(tile, rot) {
    if (tile.typeTop !== TopType.SHIELD && tile.typeTop !== TopType.BARRACKS) return 0
    const turns = ((rot % 4) + 4) % 4
    return -turns * (Math.PI / 2)
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



  /**
   * Quarter turns to add to a dragged tile so it lands on the board looking the
   * way it does in its tray icon.
   *
   * The icon and the placed geometry were lined up by hand for the OPENING
   * camera - that is the whole job of the fixed quarter turn in
   * TetrominoGeometry.placeOrient. Orbit away from that angle and the two drift
   * apart: drag an L out after a quarter turn of the camera and a differently
   * oriented L arrives on the board.
   *
   * Rotating the camera is a whole-board turn, and the board is square, so the
   * fix is to snap the orbit to the nearest quarter turn and pre-turn the tile
   * by that much. The sign is negative because the two turn opposite ways:
   * orbiting the camera +90deg makes a fixed world axis sweep -90deg across the
   * screen, so the tile has to turn the other way to appear to hold still.
   *
   * Note the opening camera is not itself axis-aligned (it sits ~34deg off),
   * which is exactly why this rounds rather than divides - the tile matches its
   * icon at the four orbit positions a player actually rests at.
   */
  get camQuarterTurns() {
    const { controls, baseAzimuth } = this.demo
    if (!controls || baseAzimuth === undefined) return 0
    const turns = Math.round((controls.getAzimuthalAngle() - baseAzimuth) / (Math.PI / 2))
    return ((-turns) % 4 + 4) % 4
  }

  _beginDrag(i) {
    const tile = this.slots[i].tile
    const mat = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.55, depthTest: false })
    // The tile's own rotation, NOT 0. Walls now come out of the tray pre-turned,
    // and hardcoding 0 here built the ghost mesh for one rotation while
    // _pickTarget sized and placed the footprint for another - which is the
    // half-cell offset between the ghost and where the tile actually landed.
    // Pre-turned to the camera, so the ghost, the footprint and the tile that
    // finally lands all agree with the tray icon whichever way the board is
    // facing. Everything downstream reads drag.rot, so this is the only place
    // the camera has to be consulted.
    const rot = (tile.rot || 0) + this.camQuarterTurns
    const ghost = new Mesh(this._ghostGeomFor(tile, rot), mat)
    ghost.rotation.y = this._roofRotation(tile, rot)
    ghost.renderOrder = 5
    this.city.scene.add(ghost)
    // Hide the icon in its slot while it's being dragged.
    this.slots[i].canvas.getContext('2d').clearRect(0, 0, ICON, ICON)
    this.slots[i].el.style.cursor = 'grabbing'
    if (this.demo.controls) this.demo.controls.enabled = false
    // Get the tray out of the way: the ghost is a scene object drawn UNDER the
    // DOM panel, so at full opacity you would be placing blind over the bottom
    // of the board. Pointer events stay on - the slots still take a press, and
    // the rotate button still works.
    this._setTrayFaded(true)
    const base = this._tileColor3(tile, new Color())
    const hi = base.clone().lerp(this._white, 0.45)
    this.drag = { slot: i, tile, ghost, mat, target: null, base, hi, rot, lastX: null, lastY: null, lastCell: null, sticky: false, pointerId: this.pending ? this.pending.id : undefined }
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
    const [w, h] = cellBounds(cells)
    // Anchor the SHAPE's centroid under the cursor, not the bounding box's
    // centre. For a T the bbox centre isn't even on the piece, so rotating
    // about it threw the tile sideways; about the centroid it turns in place.
    const [ax, ay] = TetrominoGeometry.anchor(cells)
    const gx = c.gx - ax
    const gy = c.gy - ay
    // Coloured generators are subject to the enclosure colour-claim rule.
    const claimColor = !tile.wall && isGenerator(tile) ? tile.colorIndex : -1
    let valid = city.fits(gx, gy, cells, claimColor)
    // One enclosure generator per enclosure: block placing into an already-claimed area.
    // One claimant per enclosure - and the king counts, so you can't drop a hole
    // block into the region the king is already earning from.
    if (valid && tile.typeTop === TopType.ENCLOSURE_GENERATOR && city.enclosure.cellClaim) {
      for (const [dx, dy] of cells) {
        if (city.enclosure.cellClaim[(gy + dy) * city.gridCellsX + (gx + dx)] >= 0) { valid = false; break }
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

  /**
   * True over chrome a drag must not resolve a board target under.
   *
   * That is now the rotate button ONLY. The tray used to count too, which made
   * the bottom-centre of the screen a dead zone: cells behind the panel could
   * not be built on at all, and the tray sits over the part of the board you are
   * most often working in. It is a DOM overlay, not a mouse blocker - the drag
   * listens on window and this is a hand-rolled rect test - so nothing forced
   * that, it was policy.
   *
   * Dropping there used to mean "put it back". Right-click and Esc still do, and
   * _beginDrag fades the tray out of the way so the ghost stays visible under
   * the cursor.
   */
  _overUI(x, y) {
    const b = this.rotateBtn
    if (!b || b.style.display === 'none') return false
    const r = b.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }

  _dragMove(e) {
    this.drag.lastX = e.clientX
    this.drag.lastY = e.clientY
    const { tile, ghost, mat, slot } = this.drag
    const city = this.city
    // Over the rotate button: show the tile back in its slot + hide the ghost
    // (release here puts it back). Re-hide the slot icon when moving back onto
    // the grid. The tray no longer counts - dragging across it targets the board
    // underneath like anywhere else.
    const overUI = this._overUI(e.clientX, e.clientY)
    if (overUI !== this.drag.overUI) {
      this.drag.overUI = overUI
      if (overUI) drawTile(this.slots[slot], this.city.accentColors)
      else this._clearCanvas(this.slots[slot])
    }
    if (overUI) { ghost.visible = false; this.drag.target = null; return }
    const t = this._pickTarget(e.clientX, e.clientY)
    this.drag.target = t
    if (!t) {
      ghost.visible = false
      this.drag.lastCell = null
      return
    }
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
      // Corner-shaped roofs have a facing; the symmetric ones don't care.
      ghost.rotation.y = this._roofRotation(tile, this.drag.rot)
    }
    if (t.valid) { mat.color.copy(this.drag.hi); mat.opacity = 0.92 }
    else { mat.color.copy(this.drag.base); mat.opacity = 0.5 }
  }

  /** Dim the tray so a ghost dragged over it stays readable. */
  _setTrayFaded(on) {
    if (!this.el) return
    this.el.style.transition = 'opacity 0.12s ease'
    this.el.style.opacity = on ? TRAY_DRAG_OPACITY : '1'
  }

  _dropDrag() {
    const { slot, tile, ghost, target, rot } = this.drag
    const city = this.city
    const finish = () => {
      this._endSticky()
      this._setTrayFaded(false)
      city.scene.remove(ghost)
      if (this.demo.controls) this.demo.controls.enabled = true
      this.slots[slot].el.style.cursor = 'grab'
      this.drag = null
    }
    const restore = () => { finish(); drawTile(this.slots[slot], this.city.accentColors) }
    // Released over the rotate button: put it back rather than trying to resolve
    // a board cell underneath it. The tray itself is a normal drop target now -
    // release over it and the tile lands on the board underneath.
    if (this._overUI(this.drag.lastX, this.drag.lastY)) { restore(); return }
    if (target && target.valid) {
      // Escalating placement cost (per-type standing count); validity already
      // confirmed it's affordable.
      const cost = this._tileCost(tile)
      const opts = tile.wall
        ? {
          tetro: { name: tile.shapeName, rot: rot % TetrominoGeometry.states[tile.shapeName].length },
          typeTop: TopType.SQUARE, colorIndex: 0, topColorIndex: tile.topColorIndex,
        }
        : {
          typeTop: tile.typeTop, colorIndex: tile.colorIndex, topColorIndex: tile.topColorIndex,
          rotation: this._roofRotation(tile, rot),
        }
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
