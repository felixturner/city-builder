import {
  Line2NodeMaterial,
  MathUtils,
  Vector2,
  Vector3,
  Object3D,
  BatchedMesh,
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  MeshPhysicalNodeMaterial,
  Color,
  GridHelper,
  PlaneGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  ArrowHelper,
  CircleGeometry,
  RingGeometry,
  Group,
} from 'three/webgpu'
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import gsap from 'gsap'
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture, mrt, uv, fract, step, min, float, output, positionLocal, smoothstep } from 'three/tsl'
import { Tower } from './Tower.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { ExtraGeometry } from './lib/ExtraGeometry.js'
import { TetrominoGeometry } from './lib/TetrominoGeometry.js'
import { Debris } from './lib/Debris.js'
import { Sounds } from './lib/Sounds.js'
import { EnergySystem } from './systems/EnergySystem.js'
import { FlowField } from './systems/FlowField.js'
import { Occupancy } from './systems/Occupancy.js'
import { Enclosure } from './systems/Enclosure.js'
import { TileBag } from './systems/TileBag.js'
import { Upkeep } from './systems/Upkeep.js'
import { Rocks } from './systems/Rocks.js'
import { RangeVisuals } from './systems/RangeVisuals.js'
import { LotGrowth } from './systems/LotGrowth.js'
import { TowerInteraction } from './systems/TowerInteraction.js'
import { TowerRenderer } from './systems/TowerRenderer.js'
import { ACCENT_COLORS, SHIELD_LINE } from './palette.js'
import { Buffs } from './buffs.js'
import { TopType, isTurret, isGenerator, towerArea, towerTopY, roofGeomIndex, isEnclosureGenerator, isGrey, isShield, claimsEnclosure, shieldRadiusCells, maxFloorsFor, MAX_FLOORS, TURRET_EXTRA_FLOORS, KING_HEALTH, KING_MAX_FLOORS, KING_WARN_FLOORS, KING_WARN_CELLS } from './blockTypes.js'
import { fxMaterial, glow, NO_AO_MRT } from './fx.js'

// Energy pulses a generator fires per floor before that floor crumbles away.
// A generator's life is therefore its height: a 4-storey gen lasts 4x as long as
// a 1-storey one, so building tall is an investment in uptime rather than just
// output. It visibly shrinks as it burns down, and dies when the last floor goes.
const MAX_GENS = 30 // hard cap on simultaneously placed generators
// Lots across at the start, and the most that ever open up. The board is built
// at CITY_SIZE_LOTS (13) so there is always a spawn margin outside the largest
// play area (11).
// Seconds the ground takes to ease outward when a ring opens. Demo paces the
// boss-reward beat against this.
const EXPAND_TIME = 1.2
// The grid flashing in behind the rect once it lands, and how far past its
// resting weight that flash peaks.
const GRID_FLASH_TIME = 0.5
const GRID_FLASH_GAIN = 1.9
// Resting opacities of the board furniture, so the flash knows where to settle.
const CELL_GRID_OPACITY = 0.5
const LOT_GRID_OPACITY = 0.85
// The board outline: white, over ground that steps down in value outside it
// (see Lighting's three ground planes).
const OUTLINE_COLOR = 0xffffff
const OUTLINE_OPACITY = 0.55
const START_VISIBLE_LOTS = 5
const MAX_VISIBLE_LOTS = 11
const LOTS_PER_BOSS = 2 // rings opened per boss round cleared

// Accent index the king always wears: 1 is the yellow of the three city accents.
const KING_COLOR = 1
const KING_MARKER_SIZE = 1.04 // world units across, before the corner-up tilt
const KING_MARKER_HOVER = 1.4 // rest height above the king's roof
// Seconds for a damage flash to fade back to the tower's own colour. The king
// holds its flash longer - its hits are the ones you have to notice from the
// far side of the board, so it stays lit after an ordinary wall has settled.
const KING_HIT_FLASH = 0.45
// Times the low-health siren sounds before it gives up. It is a warning, and a
// warning that never stops is just the music - you have heard it, and you either
// can do something about the king or you cannot. It re-arms if the king is built
// back out of range and driven down again.
const KING_ALARM_PLAYS = 5
// Accent a lot's outline and growth fill wear. Fixed: those only show on dormant
// lots, and there are none - see initGrid.
const LOT_COLOR = 2
// Line width shared by the king's two markers - the ground ring and the beam
// standing on the tile - so they read as one thing rather than two.
const KING_MARK_WIDTH = 0.16
// Seconds after the opening begins before the city starts building. Everything
// else in the intro - the fade, the fall, the stings - happens at once at zero;
// this is the one thing held back, so the board arrives before it fills.
const BUILD_DELAY = 1
const TOWER_HIT_FLASH = 0.22
const WHITE = new Color(0xffffff)

// Rotate a vec3 around Y axis by angle (in radians)
const rotateY = (v, angle) => {
  const c = cos(angle)
  const s = sin(angle)
  return vec3(
    v.x.mul(c).add(v.z.mul(s)),
    v.y,
    v.z.mul(c).sub(v.x.mul(s))
  )
}


export class City {
  // City size in lots (9x9 = 81 lots, 45x45 cells, 90x90 world units).
  //
  // Odd on purpose: an odd count has a true middle lot, so the centre cell
  // (floor(45/2) = 22) is both the centre of the board AND the middle of the
  // centre 5x5 lot, which is where the king wants to be. An even count has
  // neither.
  //
  // Everything downstream derives from this - creep spawn ring, shadow bounds
  // and the zoom-out cap all read actualGridWidth rather than hardcoding it.
  static CITY_SIZE_LOTS = 13

  constructor(scene, params) {
    this.scene = scene
    this.params = params

    this.towers = []
    this.towerMesh = null
    this.towerMaterial = null
    this.dummy = new Object3D()
    this.towerSize = new Vector2(1, 1)
    this.towerCenter = new Vector2()

    this.skipChance = params.scene.skipChance

    this.actualGridWidth = 0
    this.actualGridHeight = 0

    // Accent colors for lit towers, trails, and new floors
    // The lighten pass lives in palette.js so the DOM hexes are the same values.
    this.accentColors = ACCENT_COLORS.map(c => c.clone())
    this.instanceToTower = new Map() // Maps instance ID to tower

    // Floor stacking config
    this.maxFloors = MAX_FLOORS
    // Instance slots allocated per tower. Sized to the TALLEST thing any tower
    // can become, not to the default cap: towers are recycled out of one pool
    // and re-typed on placement, so any of them may end up a turret and need
    // the extra two storeys' worth of blocks.
    this.floorSlots = MAX_FLOORS + TURRET_EXTRA_FLOORS
    this.floorHeight = 2

    // Debris system
    this.debris = new Debris(scene, params.material)

    // Resource meter (set by Demo). Each build click spends 1 mana.
    this.mana = null

    // Power-line connectors / generators (Trails instance set by Demo).
    this.trails = null

    // Floating "+N" energy captions (FloatingText instance set by Demo).
    this.floatingText = null

    // Energy generation + glow/caption feedback (path/adj generators, grey mana).
    this.energy = new EnergySystem(this)
    this.flow = new FlowField(this)
    this.enclosure = new Enclosure(this)
    this.tileBag = new TileBag()
    this.upkeep = new Upkeep(this)
    this.rocks = new Rocks(this)
    this.introDone = false // set when startIntroAnimation's camera move lands
    // Set when the intro's BUILD finishes, which is later than the camera move.
    // The king's beam and danger ring wait for this: they belong to a finished
    // king, and struck in over a half-built one they upstaged the thing they are
    // pointing at.
    this.introBuilt = false
    // The board is BUILT at CITY_SIZE_LOTS but only part of it is in play. The
    // grid, the tower pool and the BatchedMesh are all sized once at init, so
    // the board cannot actually change size at runtime - instead the full one
    // exists from the start and an active region opens up a ring at a time as
    // you clear boss rounds. The outermost ring of the 13 is never opened: it is
    // margin, so creeps always have somewhere to spawn and walk in from.
    this.visibleLots = START_VISIBLE_LOTS

    // The city grid: 2D array of lots (populated by initGrid).
    this.lots = []
    // When true, clicks (build/destroy/spawn) don't cost mana (GUI toggle).
    this.freeClicks = false

    // Outward growth: dormant lots spawn from neighbour strength + clicks, plus
    // the lot outlines / progress fills.
    this.lotGrowth = new LotGrowth(this)

    // Player input (hover/build/destroy/reroll) + the reroll build-wheel.
    this.interaction = new TowerInteraction(this)

    // Procedural lot generation: footprints, types, and heights.

    // Runtime tower visuals: accent coloring, visibility, reroll, empty-tower
    // lifecycle (on the shared BatchedMesh built in initTowers).
    this.renderer = new TowerRenderer(this)

    // Ground rings for zones of control + turret range, and the turret-circle
    // data for the post-process coverage glow.
    // One claim per cell, shared by creeps and soldiers alike.
    this.occupancy = new Occupancy(this)
    this.rangeVisuals = new RangeVisuals(this)
  }

  async init() {
    await BlockGeometry.init()
    this.initGrid()
    // Soldier and pickup shapes. After initGrid so cellUnit is known, and
    // awaited here so Soldiers/LootBoxes find them ready when Demo builds them.
    await ExtraGeometry.init(this.cellUnit)
    await this.initTowers()
    this.placeKing() // central king piece (must exist before the cluster seeds around it)
    // TEMP: ?clean skips the boulders (and Demo skips the loot stars) - a bare
    // board for tutorial screenshots. Read here directly rather than imported
    // from Demo, which would be a circular import.
    if (!new URLSearchParams(location.search).has('clean')) {
      this.rocks.place(40) // scattered terrain, after the king so it can keep clear of it
    }
    // no starting cluster — player builds from scratch around the king
    this.updateMatrices()
    this.renderer.recalculateVisibility()
    this.energy.refreshManaStats()
  }

  initGrid() {
    // A buildable "cell" is 2 world units (a 2x2 block of the original cells).
    this.cellUnit = 2
    // Lot layout (world units): 10-unit lots (5 cells) separated by 4-unit roads (2 cells)
    this.lotSize = 10
    this.roadWidth = 0 // lots are adjacent (no road gaps): one continuous grid
    this.cellSize = this.lotSize + this.roadWidth // 10 world units per lot pitch

    // City dimensions from static constant
    this.numLotsX = City.CITY_SIZE_LOTS
    this.numLotsY = City.CITY_SIZE_LOTS

    // Store actual grid dimensions for centering
    this.actualGridWidth = this.numLotsX * this.cellSize
    this.actualGridHeight = this.numLotsY * this.cellSize

    // Calculate center lot for positioning
    this.centerLotX = Math.floor(this.numLotsX / 2)
    this.centerLotZ = Math.floor(this.numLotsY / 2)

    // Grid offset: centre the WHOLE BOARD on the origin.
    //
    // This used to centre the centre LOT instead, which is the same thing only
    // when the lot count is odd. At 7 lots both give -35; at 10 there is no
    // middle lot, and centring lot 5 put the board at -55..45 with every cell
    // boundary on an odd world coordinate while the drawn grid (centred, so
    // even) sat 1 unit away - the half-cell offset between tiles and the floor.
    this.gridOffsetX = -this.actualGridWidth / 2
    this.gridOffsetZ = -this.actualGridHeight / 2

    // Buildable cells per lot side (5x5 grid of 1-cell slots), and the single
    // global cell grid spanning the whole city (lots are contiguous, so tiles
    // can straddle lot boundaries). occupied[gy][gx] tracks taken cells.
    this.lotCells = this.lotSize / this.cellUnit
    this.gridCellsX = this.numLotsX * this.lotCells
    this.gridCellsY = this.numLotsY * this.lotCells
    this.occupied = Array.from({ length: this.gridCellsY }, () => Array(this.gridCellsX).fill(false))

    // Only the CENTER lot is pre-generated (the old varied, pre-built model).
    // Every other lot starts as an empty grid the player fills from the tile
    // palette via free placement (see placeTileFree). occupied[][] tracks which
    // cells are taken; the center lot is marked fully occupied (no free-place).
    // Every lot starts empty + active. The starting cluster of tiles is placed in
    // generateStartCluster() (after the tower pool exists), as ordinary placed
    // tiles, so there's no special pre-built center lot anymore.
    this.lots = []
    for (let lotY = 0; lotY < this.numLotsY; lotY++) {
      const row = []
      for (let lotX = 0; lotX < this.numLotsX; lotX++) {
        // Every lot starts ACTIVE, so nothing is ever dormant - and the only two
        // things a lot's colour feeds (its outline and the dashed growth fill)
        // are shown for dormant lots alone. It used to be rolled per lot, 169
        // draws off the random stream to tint things nobody sees.
        row.push({ lotX, lotY, colorIndex: LOT_COLOR, towers: [], active: true })
      }
      this.lots.push(row)
    }
  }

  /**
   * Convert grid coordinates to world coordinates
   * Grid coords: 0 to actualGridWidth/Height
   * World coords: centered at origin
   * @param {number} gridX - X position in grid space
   * @param {number} gridZ - Z position in grid space (note: grid uses Y, world uses Z)
   * @returns {{x: number, z: number}} World position
   */
  /** Half-extent of the playable area, in world units. */
  get visibleHalf() { return (this.visibleLots * this.cellSize) / 2 }

  /** Half-extent of the LARGEST play area the board will ever open up to. */
  get maxPlayHalf() { return (MAX_VISIBLE_LOTS * this.cellSize) / 2 }

  /** True if a cell is inside the part of the board currently in play. */
  inPlayArea(gx, gy) {
    const half = (this.visibleLots * this.lotCells) / 2
    const cx = this.gridCellsX / 2, cy = this.gridCellsY / 2
    return gx >= cx - half && gx < cx + half && gy >= cy - half && gy < cy + half
  }

  /**
   * Open another ring of lots. Called when a boss round is cleared.
   *
   * Everything that draws or measures the board reads visibleLots, so this is
   * just a number change plus a redraw - no grid rebuild, no re-pooling.
   */
  /** Whether another ring is left to open. */
  get canGrowPlayArea() { return this.visibleLots < MAX_VISIBLE_LOTS }

  growPlayArea() {
    if (!this.canGrowPlayArea) return false
    const prevHalf = this.visibleHalf
    this.visibleLots = Math.min(MAX_VISIBLE_LOTS, this.visibleLots + LOTS_PER_BOSS)
    // The ground eases out first so the rect has something to travel over. It
    // has to be started BEFORE the grid rebuild, which sets the ground to its
    // new size instantly - tweening after that ran from the target to the target
    // and the ground simply snapped.
    this.lighting?.setBoardSize(this.visibleHalf, this.cellSize, EXPAND_TIME)
    this.expandGrids(prevHalf)
    this.rocks.refresh() // boulders in the newly opened ring come into play
    this.lootBoxes?.refresh() // ...and so do the crates sitting on it
    this.creeps?.onBoardResized()
    this.onBoardResized?.()
    Sounds.play('board-expand', 1.0, 0, 0.7)
    return true
  }

  /**
   * The board opening up, as a two-beat animation instead of a redraw.
   *
   * 1. The outline rect tweens from the old bounds out to the new ones, over the
   *    ground easing outward under it. The OLD grid is held on screen for the
   *    whole trip - redrawing it up front left the board bare while the rect
   *    travelled, which reads as a glitch rather than as ground being won.
   * 2. The rect lands, the stale grid goes, and the new one flashes in behind
   *    it: blank, a bright overshoot, then its resting weight.
   *
   * Sequenced rather than simultaneous because the rect is the readable part -
   * it is the thing that says how much you gained - and a grid redrawing on the
   * same frame buries it. Demo paces the boss beat (quiet, grow, cards) against
   * EXPAND_TIME, and the flash lands inside the CARD_DELAY that follows.
   */
  expandGrids(prevHalf) {
    const half = this.visibleHalf
    // Detach (don't dispose) the old grid so createGrids builds a fresh set
    // alongside it. The rect is the one piece replaced immediately, because it
    // is the piece that animates.
    const stale = [this.cellGrid, this.dotMesh, this.lotGrid].filter(Boolean)
    this.cellGrid = null
    this.dotMesh = null
    this.lotGrid = null
    this.disposeGridObject(this.boardOutline)
    this.boardOutline = null

    // createGrids sets the ground to its new size instantly. growPlayArea has
    // already started it easing there, and gsap reads a tween's start value on
    // its first tick - which happens AFTER this - so letting the snap through
    // would hand the tween a start equal to its target and the ground would
    // simply jump. Suppressed for the duration of the rebuild.
    this._expanding = true
    this.createGrids()
    this._expanding = false
    this.setGridFade(0) // new grid drawn but blank until the rect lands

    const line = this.boardOutline
    const from = half > 0 ? prevHalf / half : 1
    line.scale.set(from, 1, from)
    // A second expand landing mid-tween would orphan the grid the first one was
    // still holding on screen, so anything pending is dropped here.
    this._expandTween?.kill()
    for (const obj of this._staleGrids || []) this.disposeGridObject(obj)
    this._staleGrids = stale
    this._expandTween = gsap.to(line.scale, {
      x: 1, z: 1, duration: EXPAND_TIME, ease: 'power2.out',
      onComplete: () => {
        for (const obj of this._staleGrids) this.disposeGridObject(obj)
        this._staleGrids = null
        this.flashGrid()
      },
    })
  }

  /**
   * DEV ONLY: put the play area back to its opening size so the expand can be
   * watched again (see Demo.previewBossReward). Anything already built outside
   * the smaller bounds is left standing - this is a preview tool, not a game
   * action, and there is no "give the ground back" rule to be faithful to.
   */
  rewindPlayArea() {
    this.visibleLots = START_VISIBLE_LOTS
    this.rebuildGrids()
    this.lighting?.setBoardSize(this.visibleHalf, this.cellSize)
    this.rocks.refresh()
    this.lootBoxes?.refresh()
    this.creeps?.onBoardResized()
    this.onBoardResized?.()
  }

  /** Set the whole grid's visible weight, 0 = blank, 1 = resting. */
  setGridFade(f) {
    if (this.cellGrid) this.cellGrid.material.opacity = CELL_GRID_OPACITY * f
    if (this.lotGrid) this.lotGrid.material.opacity = LOT_GRID_OPACITY * f
    if (this.gridFade) this.gridFade.value = f
  }

  /**
   * Flash the new grid in: up past its resting weight, then back down to it.
   *
   * GridHelper bakes its colour into vertex colours, so brightness here can only
   * be opacity - which is why the resting weights are held below 1 (see
   * LOT_GRID_OPACITY): a line already at full alpha has nowhere to flash to.
   * The dots go through a uniform instead, and being alpha-tested they pop in
   * partway up the ramp rather than fading, which suits the beat.
   */
  flashGrid() {
    const up = GRID_FLASH_TIME * 0.35, down = GRID_FLASH_TIME * 0.65
    const ramp = (target, key, peak, rest) => {
      gsap.timeline()
        .to(target, { [key]: peak, duration: up, ease: 'power2.out' })
        .to(target, { [key]: rest, duration: down, ease: 'power2.inOut' })
    }
    if (this.cellGrid) ramp(this.cellGrid.material, 'opacity', 1, CELL_GRID_OPACITY)
    if (this.lotGrid) ramp(this.lotGrid.material, 'opacity', 1, LOT_GRID_OPACITY)
    if (this.gridFade) ramp(this.gridFade, 'value', GRID_FLASH_GAIN, 1)
    // The rect pulses with it rather than from zero - it has been on screen for
    // the whole tween and blinking it out would undo the move it just made.
    if (this.boardOutline) ramp(this.boardOutline.material, 'opacity', 1, OUTLINE_OPACITY)
  }

  gridToWorld(gridX, gridZ) {
    return {
      x: gridX + this.gridOffsetX,
      z: gridZ + this.gridOffsetZ
    }
  }

  /** Map a world-space ground point to a global cell (gx,gy), or null if OOB. */
  worldToCell(worldX, worldZ) {
    const gx = Math.floor((worldX - this.gridOffsetX) / this.cellUnit)
    const gy = Math.floor((worldZ - this.gridOffsetZ) / this.cellUnit)
    if (gx < 0 || gy < 0 || gx >= this.gridCellsX || gy >= this.gridCellsY) return null
    return { gx, gy }
  }

  /** The lot that owns a global cell. */
  cellLot(gx, gy) {
    return this.lots[Math.floor(gy / this.lotCells)][Math.floor(gx / this.lotCells)]
  }

  /**
   * Whether a footprint (list of [dx,dy] cell offsets) anchored at global cell
   * (gx,gy) is free, in-bounds, and entirely within active lots.
   */
  fits(gx, gy, cells, claimColor = -1) {
    for (const [dx, dy] of cells) {
      const x = gx + dx, y = gy + dy
      if (x < 0 || y < 0 || x >= this.gridCellsX || y >= this.gridCellsY) return false
      if (!this.inPlayArea(x, y)) return false // outside the open part of the board
      if (this.rocks.blocks(x, y)) return false // a boulder is standing there
      if (this.occupied[y][x]) return false
      if (!this.cellLot(x, y).active) return false
      // A coloured tile can't enter a region already claimed by another colour.
      if (claimColor >= 0 && this.cellClaim) {
        const cc = this.cellClaim[y * this.gridCellsX + x]
        if (cc >= 0 && cc !== claimColor) return false
      }
    }
    return true
  }

  /**
   * Place a palette tile freely into empty cells. `cells` is the footprint
   * (offsets from gx,gy); `opts` carries render info: { tetro?: {name,rot},
   * typeTop, colorIndex, topColorIndex }. Grabs a pooled tower and builds it at
   * level 1 - a tile is a block with a roof on it or it is nothing at all, so
   * there is no roof-only state to place into. Returns the tower or null if the
   * pool is exhausted.
   */
  placeTileFree(gx, gy, cells, opts, silent = false) {
    const t = this.towerPool.pop()
    if (!t) return null

    const w = Math.max(...cells.map((c) => c[0])) + 1
    const h = Math.max(...cells.map((c) => c[1])) + 1
    const x0 = gx * this.cellUnit
    const z0 = gy * this.cellUnit
    t.box.min.set(x0, z0)
    t.box.max.set(x0 + w * this.cellUnit, z0 + h * this.cellUnit)
    const lot = this.cellLot(gx, gy) // lot membership by anchor cell
    t.lotX = lot.lotX
    t.lotY = lot.lotY
    t.cellX = gx
    t.cellY = gy
    t.cells = cells
    t.tetro = opts.tetro || null // { name, rot } for tetromino walls, else null
    t.king = opts.king || false // the central king piece (lose it = game over)
    t.startCluster = false // player tiles count toward escalating cost; start cluster doesn't
    t.dormant = false
    t.empty = false
    t.emptyTower = false
    t.placed = true
    t.visible = true
    t.numFloors = 1 // one block + roof: the smallest a live tile ever gets
    t.rotation = opts.rotation || 0 // corner-shaped roofs (shield/barracks) have a facing
    t.resetAnimation() // belt and braces: nothing in-flight from a previous life
    t.skipFactor = 2 // always passes visibility
    t.colorIndex = opts.colorIndex
    t.typeTop = opts.typeTop
    t.setTopColorIndex(opts.topColorIndex)

    for (const [dx, dy] of cells) this.occupied[gy + dy][gx + dx] = true
    lot.towers.push(t)

    this.renderer.applyTileVisuals(t)
    this.updateTowerMatrices(t)
    if (!silent) Sounds.play('pop', 0.8, 0.15, 0.7)
    this.onTowerChanged(t)
    this.enclosure.update()
    return t
  }

  /** Demolish a freely-placed tower (right-click): debris + free its cells. */
  demolishPlaced(tower) {
    const center = tower.box.getCenter(this.towerCenter)
    const y = Math.max(0.5, tower.numFloors - 0.5) * this.floorHeight
    this.debris.spawn(center.x + this.gridOffsetX, y, center.y + this.gridOffsetZ, 0.8,
      tower.litColor || tower.baseColor, 12)
    Sounds.play('break2', 1.0, 0.2)
    this.freePlacedTower(tower)
  }

  /** Free a placed tower's cells and return it to the pool (no debris/sound). */
  freePlacedTower(tower, opts = {}) {
    for (const [dx, dy] of tower.cells) this.occupied[tower.cellY + dy][tower.cellX + dx] = false
    const lot = this.lots[tower.lotY][tower.lotX]
    const k = lot.towers.indexOf(tower)
    if (k >= 0) lot.towers.splice(k, 1)

    tower.placed = false
    tower.dormant = true
    tower.tetro = null
    tower.visible = false
    tower.numFloors = 0
    if (opts.animate) {
      // Its instances are mid-fall. Leave them alone and hold the tower out of
      // the pool until the animation lands, or the next tile to be dealt this
      // slot inherits a half-finished tween and the old footprint scale.
      this._fallingTowers = (this._fallingTowers || new Set()).add(tower)
    } else {
      // Land any running animation before the tower goes back in the pool.
      tower.resetAnimation()
      this.updateTowerMatrices(tower)
      this.towerPool.push(tower)
    }
    this.onTowerChanged(tower)
    this.enclosure.update()
  }

  /**
   * Run the fall animation on a tower that has already been removed.
   *
   * Reads the height BEFORE the caller zeroes it, and returns the tower to the
   * pool once it lands - the one thing that genuinely has to wait for the
   * animation, because the instances are what is being animated.
   */
  _playDemolishFall(tower) {
    const floors = tower.numFloors
    tower.animateDelete(this.towerMesh, this.floorHeight, floors, () => {
      tower.resetAnimation()
      tower.visible = false
      tower.numFloors = 0
      this.updateTowerMatrices(tower)
      if (this._fallingTowers?.delete(tower)) this.towerPool.push(tower)
    })
  }

  /** Free a tower's cells and remove it (no debris). Placed tiles return to the
   *  pool; pre-built center-lot towers free their footprint and hide. */
  demolishTower(tower, opts = {}) {
    // Play the fall BEFORE the tower is freed - it needs the instances, and it
    // needs their current heights. The removal itself does not wait for it (see
    // TowerInteraction.demolishTower for why): the animation is handed the
    // instances for the length of the fall, and the tower is not returned to the
    // pool until it lands.
    if (opts.animate) this._playDemolishFall(tower)
    if (tower.placed) { this.freePlacedTower(tower, opts); return }
    const cu = this.cellUnit
    const gx0 = Math.round(tower.box.min.x / cu), gy0 = Math.round(tower.box.min.y / cu)
    const tw = Math.round((tower.box.max.x - tower.box.min.x) / cu)
    const th = Math.round((tower.box.max.y - tower.box.min.y) / cu)
    for (let j = 0; j < th; j++) {
      for (let i = 0; i < tw; i++) {
        const x = gx0 + i, y = gy0 + j
        if (x >= 0 && y >= 0 && x < this.gridCellsX && y < this.gridCellsY) this.occupied[y][x] = false
      }
    }
    tower.visible = false
    tower.numFloors = 0
    this.onTowerChanged(tower)
    this.enclosure.update()
  }

  /**
   * DEBUG: wipe every tile off the board - king included - with none of the
   * per-removal side effects (lot growth, enclosure payouts, captions). One
   * batch of cell-freeing + hiding, then a single refresh at the end.
   */
  clearBoard() {
    const cu = this.cellUnit
    for (const t of [...this.towers]) {
      if (!t.visible) continue
      if (t.placed) {
        for (const [dx, dy] of t.cells) this.occupied[t.cellY + dy][t.cellX + dx] = false
        const lot = this.lots[t.lotY]?.[t.lotX]
        const k = lot ? lot.towers.indexOf(t) : -1
        if (k >= 0) lot.towers.splice(k, 1)
        t.resetAnimation()
        t.placed = false
        t.dormant = true
        t.tetro = null
        this.towerPool.push(t)
      } else {
        const gx0 = Math.round(t.box.min.x / cu), gy0 = Math.round(t.box.min.y / cu)
        const tw = Math.round((t.box.max.x - t.box.min.x) / cu)
        const th = Math.round((t.box.max.y - t.box.min.y) / cu)
        for (let j = 0; j < th; j++) {
          for (let i = 0; i < tw; i++) {
            const x = gx0 + i, y = gy0 + j
            if (x >= 0 && y >= 0 && x < this.gridCellsX && y < this.gridCellsY) this.occupied[y][x] = false
          }
        }
      }
      t.king = false // a pooled ex-king must come back as an ordinary tile
      t.visible = false
      t.numFloors = 0
      this.updateTowerMatrices(t)
    }
    // The king is gone: drop the reference and its ornaments, or the next tile
    // to reuse its pooled tower would inherit the marker and beam.
    this.king = null
    if (this.kingMarker) this.kingMarker.visible = false
    if (this.kingBeam) this.kingBeam.visible = false
    if (this.kingRing) this.kingRing.visible = false
    this.enclosure.update()
    this.updateTowerVisuals()
    this.flowDirty = true
  }

  /** The shared bag lives in TileBag; this is the name TilePalette already uses. */
  drawTileSpec() { return this.tileBag.draw() }

  /** Place the king: a 1x1 tower at the exact centre with the hole roof, in a
   *  random light accent colour. Losing it
   *  (creeps knock it to 0 floors) ends the game. */
  placeKing() {
    // Middle of the board in cells. Derived from the cell grid rather than from
    // a "centre lot", which doesn't exist for an even lot count.
    const ccx = Math.floor(this.gridCellsX / 2)
    const ccy = Math.floor(this.gridCellsY / 2)
    // Always yellow. It used to draw one of the three accents per run, which
    // meant the thing you are defending shared a colour with ordinary towers -
    // and a different one each game, so it never became recognisable. Fixed now,
    // and the beam takes it too (see createKingBeam).
    const kingColor = KING_COLOR
    // HOLE is an otherwise-unused top type, so the king gets a distinct roof
    // without being picked up by isGenerator/isTurret anywhere.
    const t = this.placeTileFree(ccx, ccy, [[0, 0]], {
      typeTop: TopType.HOLE, colorIndex: kingColor, topColorIndex: kingColor, king: true,
    }, true)
    if (!t) return
    // The king can outgrow the pool's per-tower allocation (Crown the King adds
    // floors permanently), so give it the extra block instances up front - a
    // floor with no instance behind it draws nothing and throws on any colour
    // write, which read as a gap under the roof.
    this.growTowerSlots(t, KING_MAX_FLOORS)
    t.numFloors = Math.min(this.kingMaxFloors || KING_HEALTH, KING_MAX_FLOORS)
    this.updateTowerMatrices(t)
    this.king = t
    this.kingAlive = true
    this.createKingBeam()
    this.createKingRing()
    this.createKingMarker()
  }

  /**
   * A shaft of light standing on the king and running straight up out of the
   * board, in whatever accent the king drew this run.
   *
   * The king is a single 1x1 tile in the middle of a city that fills the screen,
   * and once walls go up around it there is nothing to say where it is. The beam
   * is readable from any camera angle and at any zoom, which a marker on the
   * ground is not.
   *
   * Additive and AO-free like every other coloured effect (see fx.js), and depth
   * tested, so towers in front of it occlude it rather than it hanging over the
   * whole city.
   */
  createKingBeam() {
    if (!this.king) return
    const H = 160 // tall enough to leave frame at every zoom level
    // Open-ended: the caps would read as bright discs from a high camera.
    // Radius matches the ring's 0.16 width, and the colour matches it too: the
    // beam and the ring are one marker seen from two angles, and they were a
    // different yellow and twice the thickness apart.
    const geo = new CylinderGeometry(KING_MARK_WIDTH / 2, KING_MARK_WIDTH / 2, H, 12, 1, true)
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: new Color(SHIELD_LINE),
      side: DoubleSide, // an open tube shows its inside wall from most angles
    }))
    // Solid where it leaves the roof, gone by the top - a hard cut in the sky
    // would read as a cylinder rather than a beam. positionLocal.y runs
    // -H/2..H/2, so this is just that remapped and flipped.
    const tY = positionLocal.y.div(H).add(0.5)
    mat.opacityNode = smoothstep(1.0, 0.0, tY).mul(0.55)
    const mesh = glow(new Mesh(geo, mat))
    mesh.frustumCulled = false // it is taller than its own bounding sphere suggests
    mesh.renderOrder = 4
    this.scene.add(mesh)
    this.kingBeam = mesh
    this.kingBeamHeight = H
    this.updateKingBeam()
  }

  /** Keep the beam standing on the king's roof as the king loses floors. */
  updateKingBeam() {
    const beam = this.kingBeam
    if (!beam) return
    const king = this.king
    // Held back until the opening build-up finishes: the beam is a marker for a
    // city that exists, and firing it up while the towers are still rising drew
    // the eye away from the one animation that only plays once.
    if (!king || !king.visible || !this.kingAlive || !this.introBuilt) {
      beam.visible = false
      if (this.kingRing) this.kingRing.visible = false
      this._kingShown = false
      return
    }
    // First frame it is allowed to show: kick it in rather than having it appear
    // between one frame and the next.
    if (!this._kingShown) { this._kingShown = true; this.flickerKingBeam() }
    // While the flicker is running it owns visibility - this would otherwise
    // switch the beam back on between the timeline's own frames.
    if (!this._kingFlicker) beam.visible = true
    const c = king.box.getCenter(this.towerCenter)
    // Rooted at ground level rather than on the roof, so it reads as coming out
    // of the tower rather than hovering above it - and it no longer bobs up and
    // down as the king loses and regains floors.
    beam.position.set(
      c.x + this.gridOffsetX,
      this.kingBeamHeight / 2,
      c.y + this.gridOffsetZ
    )
    // The danger ring shares the beam's fate: same king, same visibility rules,
    // and the board can grow underneath both of them.
    if (this.kingRing) {
      if (!this._kingFlicker) this.kingRing.visible = true
      this.kingRing.position.set(c.x + this.gridOffsetX, 0.04, c.y + this.gridOffsetZ)
    }
  }

  /**
   * Strike the king's beam and danger ring in like a tube light coming on.
   *
   * The beam is the one thing on the board that says "this is what you are
   * defending", and it used to simply be there the frame the intro finished.
   * A few stutters and a chime make it an event you look at - and it lights the
   * ring at the same time, so the two read as one thing switching on.
   */
  flickerKingBeam() {
    const parts = [this.kingBeam, this.kingRing].filter(Boolean)
    if (!parts.length) return
    this._kingFlicker = true
    Sounds.play('good')
    // Uneven on/off times: an even stutter reads as a strobe rather than
    // something struggling to catch.
    const tl = gsap.timeline({ onComplete: () => { this._kingFlicker = false } })
    for (const [t, on] of [
      [0, true], [0.05, false], [0.09, true], [0.14, false],
      [0.22, true], [0.26, false], [0.36, true],
    ]) tl.set(parts, { visible: on }, t)
  }

  /**
   * The king's danger zone, drawn as a thin yellow ring on the ground.
   *
   * The proximity siren fires when a creep is within KING_WARN_CELLS of the
   * king, and until now that line was audible only - you heard that something
   * had got close without being able to see where "close" started. Same radius,
   * same constant, so the ring is the sound made visible.
   */
  createKingRing() {
    if (!this.king) return
    const r = KING_WARN_CELLS * this.cellUnit
    const geo = new RingGeometry(r - KING_MARK_WIDTH / 2, r + KING_MARK_WIDTH / 2, 96)
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: new Color(SHIELD_LINE), opacity: 0.75,
    }))
    const mesh = glow(new Mesh(geo, mat))
    mesh.rotation.x = -Math.PI / 2 // RingGeometry lives in XY; lie it flat
    mesh.renderOrder = -1 // under the turret/shield rings, like the other ground art
    this.scene.add(mesh)
    this.kingRing = mesh
  }

  /** Fire the game-over hook once (the king died). */
  triggerGameOver() {
    if (!this.kingAlive) return
    this.kingAlive = false
    // Kill the last-two-floors alarm if it's still ringing: it warns about a
    // king that is about to die, and once it has, it is playing over the
    // game-over sting and saying something that stopped being true.
    Sounds.fadeOut('king-warning', 0.25)
    // The king-is-open siren too: the systems that would switch it off stop
    // being ticked once the game-over panel takes over, so it would ring on
    // over the score screen.
    Sounds.fadeOut('alert2', 0.25)
    this.onGameOver?.()
  }

  async initTowers() {
    // Material values set by applyParams
    const mat = new MeshPhysicalNodeMaterial()
    this.towerMaterial = mat

    // Environment rotation uniform (radians)
    this.envRotation = uniform(0)

    // Custom environment node with rotation support
    // We'll set this up after the scene environment is loaded
    this.setupEnvRotation()

    const geoms = []
    for (let i = 0; i < BlockGeometry.geoms.length; i++) {
      geoms.push(BlockGeometry.geoms[i])
    }

    const vCounts = []
    const iCounts = []
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i]
      vCounts.push(g.attributes.position.count)
      iCounts.push(g.index.count)
    }

    // Procedural tetromino geometries (grey wall tiles) added alongside the GLB
    // blocks. Each entry has a body (stacked per floor) + a thin roof cap.
    const tetroList = TetrominoGeometry.build(this.cellUnit)

    // Geometry buffer = the unique block geometries (added once, shared by all
    // instances). Instances (center towers + the free-placement pool) reference
    // them by id and add no vertices.
    let totalV = 0
    let totalI = 0
    for (let i = 0; i < geoms.length; i++) { totalV += vCounts[i]; totalI += iCounts[i] }
    for (const e of tetroList) {
      totalV += e.body.attributes.position.count + e.roof.attributes.position.count
      totalI += e.body.index.count + e.roof.index.count
    }

    // Center-lot towers + a pool of generic towers grabbed on free placement.
    this.poolSize = 900
    const totalTowers = this.towers.length + this.poolSize
    // The spare covers the king's extra floors (see growTowerSlots) plus slack.
    const maxInstances = totalTowers * (this.floorSlots + 1) + KING_MAX_FLOORS + 10
    this.towerMesh = new BatchedMesh(maxInstances, totalV, totalI, mat)
    this.towerMesh.sortObjects = false
    this.towerMesh.castShadow = true
    this.towerMesh.receiveShadow = true
    // Center the middle lot at the origin (use pre-calculated offset)
    this.towerMesh.position.x = this.gridOffsetX
    this.towerMesh.position.z = this.gridOffsetZ
    this.scene.add(this.towerMesh)

    const geomIds = []
    for (let i = 0; i < geoms.length; i++) {
      geomIds.push(this.towerMesh.addGeometry(geoms[i]))
    }
    this.geomIds = geomIds // kept for runtime tile re-rolls on destroy

    // Register tetromino geometries; lookup by `${name}:${rot}`.
    this.tetroGeom = new Map()
    for (const e of tetroList) {
      this.tetroGeom.set(`${e.name}:${e.rot}`, {
        bodyId: this.towerMesh.addGeometry(e.body),
        roofId: this.towerMesh.addGeometry(e.roof),
        cells: e.cells,
        body: e.body, // standalone geometry, reused for the drag ghost
      })
    }

    // Create instances for each tower: floorSlots base + 1 roof
    for (let i = 0; i < this.towers.length; i++) {
      const tower = this.towers[i]
      tower.floorInstances = []

      // Create floor instances (base geometry)
      for (let f = 0; f < this.floorSlots; f++) {
        const idx = this.towerMesh.addInstance(geomIds[tower.typeBottom])
        this.towerMesh.setColorAt(idx, tower.baseColor)
        this.towerMesh.setVisibleAt(idx, false)
        tower.floorInstances.push(idx)
        this.instanceToTower.set(idx, tower)
      }

      // Create roof instance (top geometry)
      tower.roofInstance = this.towerMesh.addInstance(geomIds[roofGeomIndex(tower.typeTop)])
      this.towerMesh.setColorAt(tower.roofInstance, tower.topColor)
      this.towerMesh.setVisibleAt(tower.roofInstance, false)
      this.instanceToTower.set(tower.roofInstance, tower)
    }

    // Free-placement pool: generic hidden towers, each pre-allocated floorSlots+1
    // instances. A tile drop grabs one (placeTileFree); demolish returns it.
    this.towerPool = []
    const defBottom = BlockGeometry.topToBottom.get(0)
    for (let p = 0; p < this.poolSize; p++) {
      const t = new Tower()
      t.dormant = true
      t.visible = false
      t.placed = false
      t.typeTop = 0
      t.typeBottom = defBottom
      t.floorInstances = []
      for (let f = 0; f < this.floorSlots; f++) {
        const idx = this.towerMesh.addInstance(geomIds[defBottom])
        this.towerMesh.setColorAt(idx, t.baseColor)
        this.towerMesh.setVisibleAt(idx, false)
        t.floorInstances.push(idx)
        this.instanceToTower.set(idx, t)
      }
      t.roofInstance = this.towerMesh.addInstance(geomIds[0])
      this.towerMesh.setColorAt(t.roofInstance, t.topColor)
      this.towerMesh.setVisibleAt(t.roofInstance, false)
      this.instanceToTower.set(t.roofInstance, t)
      this.towers.push(t)
      this.towerPool.push(t)
    }

    console.log('Tower count:', this.towers.length, 'Max instances:', maxInstances)

    // Light up all plus/cross towers with hover colors
    this.renderer.applyLitTowers()
  }

  /**
   * Intro animation: build all towers from ground up, staggered from center outward
   * @param {Camera} camera - The camera to animate
   * @param {OrbitControls} controls - OrbitControls instance
   * @param {number} duration - Total animation duration in seconds
   */
  startIntroAnimation(camera, controls, duration = 4) {
    const gridCenterX = this.actualGridWidth / 2
    const gridCenterY = this.actualGridHeight / 2

    // Mute build sounds during intro (except pop) and disable debris
    this.introBuilt = false // replaying the intro hides the beam again
    Sounds.mute(['stone', 'tick', 'clink'])
    const debrisWasEnabled = this.debris.enabled
    this.debris.enabled = false

    // 1. Store target floor counts, set all to 0. Only visible towers build;
    //    hidden slots (empty/dormant) keep targetFloors 0 so they aren't flashed
    //    in and then erased when updateTowerMatrices re-hides them.
    const towerData = this.towers.map(tower => {
      const targetFloors = tower.visible ? tower.numFloors : 0
      const center = tower.box.getCenter(new Vector2())
      const dist = Math.hypot(center.x - gridCenterX, center.y - gridCenterY)
      tower.numFloors = 0
      return { tower, targetFloors, dist }
    }).filter(Boolean)
    this.updateMatrices()

    // 2. Sort by distance (center first). Normalize the stagger against the
    //    farthest *building* tower (not the whole-city diagonal), so the active
    //    lot ripples across the full stagger window instead of starting at once.
    towerData.sort((a, b) => a.dist - b.dist)
    const building = towerData.filter(t => t.targetFloors > 0)
    const maxDist = building[building.length - 1]?.dist || 1

    // 3. Animate each tower's floors with stagger, held for BUILD_DELAY so the
    //    camera and the stings have the opening to themselves. Built at once,
    //    the one thing on the board went up somewhere in the distance and was
    //    over by the time you could see it - it is worth watching.
    const buildStart = BUILD_DELAY
    const staggerDuration = duration * 0.85 // 85% of duration for stagger spread
    const floorDelay = 0.25 // 250ms between floors of same tower

    let maxDelay = 0
    towerData.forEach(({ tower, targetFloors, dist }) => {
      if (targetFloors === 0) return

      const staggerDelay = (dist / maxDist) * staggerDuration

      // Animate each floor sequentially (no debris during intro)
      const baseColor = tower.isLit && tower.litColor ? tower.litColor : tower.baseColor
      const floorShade = new Color()
      // Volume fades based on distance (0 at 3 lots away)
      const maxSoundDist = this.cellSize * 3 // 3 lots
      const volume = Math.max(0, 1 - dist / maxSoundDist) * 0.35
      for (let f = 0; f < targetFloors; f++) {
        const delay = buildStart + staggerDelay + f * floorDelay
        maxDelay = Math.max(maxDelay, delay)
        // Sim time, not setTimeout: this sets numFloors, which is game state -
        // and the timer below flips introBuilt, which arms the king's damage
        // ring. On wall clock both landed at a different point in the game
        // depending on the frame rate, so the ring started burning creeps
        // earlier or later than it did in the run being replayed.
        this.demo.after(delay, () => {
          tower.numFloors = f + 1
          // Play pop sound with pitch based on floor height, volume based on distance
          const pitch = 0.8 + (f / maxFloorsFor(tower)) * 1.2
          if (volume > 0) Sounds.play('pop', pitch, 0.15, volume)
          // Each block goes in at its own shade in the stack gradient - no
          // brighten-then-settle, which during the intro read as the city
          // flickering as it built.
          Tower.shadeForFloor(baseColor, f, maxFloorsFor(tower), floorShade)
          tower.animateNewFloor(
            this.towerMesh,
            this.floorHeight,
            f,
            floorShade,
            () => this.updateTowerMatrices(tower),
            null // no debris
          )
        })
      }
    })

    // Unmute sounds and restore debris after intro completes. Also refresh
    // tower visuals once so monasteries/connectors reflect the settled city
    // (the intro builds via updateTowerMatrices, which skips that pass).
    this.demo.after(maxDelay + 1, () => {
      Sounds.unmute(['stone', 'tick', 'clink'])
      this.debris.enabled = debrisWasEnabled
      this.updateTowerVisuals()
      // The last block is up: the king's beam and ring may strike in now.
      this.introBuilt = true
    })

    // 4. Camera zoom animation (angle-based distance)
    const target = controls.target.clone()
    const direction = camera.position.clone().sub(target).normalize()
    const endDist = camera.position.distanceTo(target)
    // How far back the fall starts, as a multiple of the resting distance.
    const startDist = endDist * 2

    // Set initial zoomed-out position
    camera.position.copy(target).addScaledVector(direction, startDist)

    // Lift the zoom-out clamp for the duration of the move.
    //
    // OrbitControls.update() clamps the camera to maxDistance EVERY frame, and
    // Demo calls it every frame whether the controls are enabled or not.
    // maxDistance is only 1.12x the resting distance (it exists to stop you
    // zooming out past the board), so a move starting at 6x was clamped straight
    // back to 1.12x: the camera sat still for the first four fifths of the tween
    // and only began to move once `dist` fell under the clamp. That read exactly
    // like the zoom waiting for the fade to finish.
    const prevMaxDistance = controls.maxDistance
    controls.maxDistance = Math.max(prevMaxDistance, startDist)

    // Disable user input during the zoom tween - gsap and OrbitControls fighting
    // over the camera leaves the controls in a bad state (pan reads as rotate).
    controls.enabled = false

    // Fade, fall and the opening sting all start together on the click. Beds are
    // already running by now, so the audio context is unlocked and this needs no
    // user gesture of its own.
    //
    // 'reveal' used to play under this one. Two stings landing together on a
    // board with nothing on it read as a pair of alerts rather than an opening.
    Sounds.play('intro')

    const animState = { dist: startDist }
    gsap.to(animState, {
      dist: endDist,
      duration: duration,
      ease: 'power2.out',
      onUpdate: () => {
        camera.position.copy(target).addScaledVector(direction, animState.dist)
        controls.update()
      },
      onComplete: () => {
        controls.maxDistance = prevMaxDistance
        controls.enabled = true
        this.introDone = true
      },
    })
  }

  updateMatrices() {
    if (!this.towerMesh) return
    const { dummy, towerMesh, towers } = this

    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i]

      // Hide all instances if tower is not visible
      if (tower.visible === false) {
        for (let f = 0; f < tower.floorInstances.length; f++) {
          towerMesh.setVisibleAt(tower.floorInstances[f], false)
        }
        towerMesh.setVisibleAt(tower.roofInstance, false)
        continue
      }

      // Tetromino walls: geometry encodes the multi-cell shape at cell scale,
      // centred on the bounding box. No footprint scaling or rotation.
      if (tower.tetro) {
        const c = tower.box.getCenter(this.towerCenter)
        const ax = c.x, az = c.y
        const nf = tower.numFloors
        const fhh = this.floorHeight / 2
        for (let f = 0; f < tower.floorInstances.length; f++) {
          const idx = tower.floorInstances[f]
          if (f < nf) {
            dummy.position.set(ax, f * this.floorHeight + fhh, az)
            dummy.scale.set(1, this.floorHeight, 1)
            dummy.rotation.y = 0
            dummy.updateMatrix()
            towerMesh.setMatrixAt(idx, dummy.matrix)
            towerMesh.setVisibleAt(idx, true)
          } else {
            towerMesh.setVisibleAt(idx, false)
          }
        }
        dummy.position.set(ax, nf * this.floorHeight + TetrominoGeometry.roofHalf, az)
        dummy.scale.set(1, 1, 1)
        dummy.rotation.y = 0
        dummy.updateMatrix()
        towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
        towerMesh.setVisibleAt(tower.roofInstance, true)
        continue
      }

      const center = tower.box.getCenter(this.towerCenter)
      const size = tower.box.getSize(this.towerSize)
      const numFloors = tower.numFloors

      // Half-heights for centered geometries
      const floorHalfHeight = this.floorHeight / 2 // Base geom is 1 unit, scaled to floorHeight
      const roofHalfHeight = BlockGeometry.halfHeights[roofGeomIndex(tower.typeTop)]

      // Position and show floor instances (geometry centered, so add halfHeight)
      for (let f = 0; f < tower.floorInstances.length; f++) {
        const idx = tower.floorInstances[f]
        if (f < numFloors) {
          dummy.position.set(center.x, f * this.floorHeight + floorHalfHeight, center.y)
          dummy.scale.set(size.x, this.floorHeight, size.y)
          dummy.rotation.y = tower.rotation
          dummy.updateMatrix()
          towerMesh.setMatrixAt(idx, dummy.matrix)
          towerMesh.setVisibleAt(idx, true)
        } else {
          towerMesh.setVisibleAt(idx, false)
        }
      }

      // Position roof on top (geometry centered, so add halfHeight)
      dummy.position.set(center.x, numFloors * this.floorHeight + roofHalfHeight, center.y)
      dummy.scale.set(size.x, 1, size.y)
      dummy.rotation.y = tower.rotation
      dummy.updateMatrix()
      towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
      towerMesh.setVisibleAt(tower.roofInstance, true)
    }
  }

  setupEnvRotation() {
    const mat = this.towerMaterial
    const angle = this.envRotation

    // Get the environment texture from scene
    const envTexture = this.scene.environment
    if (!envTexture) {
      console.warn('Environment texture not yet loaded')
      return
    }

    // Create rotated reflection vector for specular
    // Reflection is computed in view space, transform to world, then rotate
    const reflectView = positionViewDirection.negate().reflect(normalWorld)
    const reflectWorld = reflectView.transformDirection(cameraViewMatrix)
    const rotatedReflectWorld = rotateY(reflectWorld, angle)

    // Create PMREM texture node with rotated UV direction
    const envMapNode = pmremTexture(envTexture, rotatedReflectWorld, roughness)

    // Set as the material's environment node
    mat.envNode = envMapNode
  }

  /**
   * Called after a tower's floor count changes (build or destroy).
   * Updates its matrices and re-evaluates power-line connectors.
   */
  onTowerChanged(tower) {
    this.updateTowerMatrices(tower)
    // The roof takes the shade of the floor it sits on, so the stack gradient
    // has to be redrawn whenever the height changes.
    if (isGrey(tower)) this.renderer.shadeStack(tower)
    this.lotGrowth.trySpawnLots()
    this.updateTowerVisuals()
    this.flowDirty = true // creep pathing depends on walls/goals
  }

  /** Creep pathfinding lives in FlowField; kept here as the name callers use. */
  computeFlowField() { this.flow.compute() }

  /**
   * Refresh connector lines, ZOC circles, and lot fills (no matrix update or
   * lot spawning). Called the instant a block is added so the radius/connections
   * grow with the new block instead of lagging behind its emerge animation.
   */
  updateTowerVisuals() {
    this.energy.refresh()
    this.rangeVisuals.refresh()
    this.lotGrowth.updateLotFills()
  }

  /**
   * Recompute everything a power-up can have changed, and redraw it.
   *
   * A card mutates Buffs and nothing recalculates: a longer support reach does
   * not relink trails until the next tower change, a wider shield keeps drawing
   * its old ring because ring geometry is cached by floor count, and a bigger
   * energy cap does not move the meter. Rather than have each card remember what
   * it has to poke, this rebuilds the lot - it happens once, on a screen that is
   * already paused.
   */
  refreshAfterBuff() {
    this.rangeVisuals.invalidate() // cached ring geometry is now the wrong size
    this.updateTowerVisuals() // relink trails, redraw rings, recompute income
    this.enclosure.update()
    this.energy.refreshManaStats() // energy cap
    this.mana?.render()
    for (const tower of this.towers) this.updateTowerMatrices(tower)
  }

  /** Turret range circles for the post-process coverage glow (called by Demo). */
  getTurretCircles(out = []) {
    return this.rangeVisuals.getTurretCircles(out)
  }


  /**
   * Ring that bursts out of a building the moment a support tower reaches it.
   *
   * Expo-out so it snaps wide immediately and eases to a stop, fading bright to
   * nothing - the point is to say "this just changed" at a glance across a board
   * that may have a hundred creeps on it.
   */
  spawnSupportRing(x, z, color) {
    if (!this._supportRingGeo) {
      // Unit disc, scaled per burst. Flat on the ground, drawn over it.
      this._supportRingGeo = new CircleGeometry(1, 40)
      this._supportRingGeo.rotateX(-Math.PI / 2)
    }
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: color.clone(), opacity: 0.85,
    }))
    const mesh = glow(new Mesh(this._supportRingGeo, mat))
    mesh.position.set(x, 0.09, z)
    mesh.scale.setScalar(0.01)
    mesh.renderOrder = 5
    this.scene.add(mesh)
    gsap.to(mesh.scale, {
      x: this.cellUnit * 3.2, y: 1, z: this.cellUnit * 3.2,
      duration: 0.75, ease: 'expo.out',
    })
    gsap.to(mat, {
      opacity: 0, duration: 0.75, ease: 'expo.out',
      onComplete: () => { this.scene.remove(mesh); mat.dispose() },
    })
  }

  /** Set every instance color of a tower to a single color. */
  /**
   * Flash a tower white when it takes a blow, fading back over its own duration.
   *
   * A tile being chewed on had no colour tell at all - only the shake and a
   * thunk - so a wall under attack looked the same as one nobody had touched.
   * The tint can't go through the generators' pulse path, which needs a
   * `litColor` that walls and the king don't have: lerp the tower's own base
   * colour toward white by the envelope instead.
   */
  updateHitFlashes(dt) {
    if (!this._hitFlashes || this._hitFlashes.size === 0) return
    if (!this._flashColor) this._flashColor = new Color()
    for (const [tower, f] of this._hitFlashes) {
      // A flashing tile can be destroyed mid-fade - its instances go back to the
      // pool and are handed straight out as some other tower, so writing colours
      // to them would tint an unrelated tile.
      if (!tower.visible) { this._hitFlashes.delete(tower); continue }
      f.t = Math.max(0, f.t - dt / f.dur)
      this._flashColor.copy(tower.baseColor).lerp(WHITE, f.t * 0.85)
      this.setTowerColor(tower, this._flashColor)
      // Back to its own shading once the flash is spent, so the stack gradient
      // returns rather than the whole tower being left one flat colour.
      if (f.t === 0) {
        this.renderer.shadeStack(tower)
        this._hitFlashes.delete(tower)
      }
    }
  }

  /** Kick a tower's damage flash to full. Called from damageTower. */
  flashTower(tower, dur = TOWER_HIT_FLASH) {
    if (!tower || !tower.visible) return
    if (!this._hitFlashes) this._hitFlashes = new Map()
    const f = this._hitFlashes.get(tower)
    if (f) { f.t = 1; f.dur = dur } else this._hitFlashes.set(tower, { t: 1, dur })
  }

  /** Kick the king's (longer) damage flash to full. */
  flashKing() { this.flashTower(this.king, KING_HIT_FLASH) }

  /**
   * The king's low-health siren: KING_ALARM_PLAYS times, then quiet.
   *
   * It used to fire once on the crossing into the last two floors, which said
   * "this just happened" about a condition that then sat there for the rest of
   * the round. It now starts when the king drops to KING_WARN_FLOORS and repeats
   * a few times before giving up - long enough to be unmissable, short of
   * becoming the soundtrack.
   *
   * The latch is what keeps it from restarting the moment the run of plays ends:
   * it re-arms only when the king climbs back out of range, so a king built up
   * and knocked down again gets a fresh alarm. Being built back up also cuts the
   * siren mid-run, and dying fades it out under the sting (triggerGameOver).
   */
  updateKingAlarm() {
    const king = this.king
    // introBUILT, not introDone: the intro empties every tower to zero floors and
    // rebuilds them, and the camera lands well before the king is back up. Armed
    // on the camera landing, this siren fired every single game - the king was
    // genuinely on one floor at the time, it just had not been knocked there.
    const low = !!king && king.visible && this.kingAlive && this.introBuilt
      && king.numFloors <= KING_WARN_FLOORS
    if (!low) {
      this._kingAlarmFired = false
      Sounds.stop('king-warning')
      return
    }
    if (this._kingAlarmFired) return
    this._kingAlarmFired = true
    Sounds.loop('king-warning', 0.45, 1.0, KING_ALARM_PLAYS)
  }

  /**
   * A cube standing on its corner, hovering and spinning over the king.
   *
   * The king is a one-cell tile in the middle of a board that fills the screen,
   * and once walls go up around it there is nothing at eye level to say which
   * tile it is - the beam reads from far away, but not up close, and the tile
   * itself is the same yellow as barracks and shields. This is the near marker:
   * the same corner-up spin the loot crates wore before they became stars, so
   * the shape already reads as "the thing that matters here".
   */
  createKingMarker() {
    if (!this.king) return
    const geo = new BoxGeometry(KING_MARKER_SIZE, KING_MARKER_SIZE, KING_MARKER_SIZE)
    // No emissive and NOT on the glow layer: it sits right over the king, and a
    // bloomed marker smeared over the tile it is meant to point at.
    const mat = new MeshStandardNodeMaterial({
      // Matched to the king's ROOF, not its base accent. The stack is shaded by
      // floor and the roof takes the shade of the block under it, so the flat
      // accent came out the colour of the king's ground floor - the marker read
      // as a chip off the bottom of the tower rather than a thing sitting on top
      // of it. Re-derived whenever the king's height changes (updateKingMarker).
      color: new Color(),
      roughness: 0.35,
      metalness: 0.1,
    })
    mat.mrtNode = NO_AO_MRT()
    const mesh = new Mesh(geo, mat)
    // 45deg about Z stands it on an EDGE, then atan(1/sqrt2) about X tips that
    // edge onto a POINT. YXZ order so both tilts land before the Y spin, which
    // then turns it about world up instead of tumbling it.
    mesh.rotation.order = 'YXZ'
    mesh.rotation.set(-Math.atan(1 / Math.SQRT2), 0, Math.PI / 4)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.kingMarker = mesh
    this.refreshKingMarkerColor()
  }

  /** Take the marker's colour from the king's roof block, whatever height it is. */
  refreshKingMarkerColor() {
    const king = this.king
    if (!this.kingMarker || !king) return
    Tower.roofShade(king, king.topColor || king.baseColor, this.kingMarker.material.color)
  }

  /**
   * Hover, bob and spin the marker; parks it on the king's current roof.
   *
   * It rides the roof's ANIMATED height while the roof is in flight, not the
   * height its floor count implies. The two are different during a build: the
   * floor count goes up the instant a block is added, while the roof mesh tweens
   * to its new position over the next fraction of a second - so the marker
   * teleported a storey and waited there for the roof to catch up.
   *
   * The roof is one instance of a BatchedMesh, not an Object3D, so the marker
   * cannot be parented to it. Reading `roofAnim.y` - the same value the roof
   * tween writes each frame - is as close as this gets, and it costs nothing.
   */
  updateKingMarker(dt) {
    const marker = this.kingMarker
    if (!marker) return
    const king = this.king
    if (!king || !king.visible || !this.kingAlive) { marker.visible = false; return }
    marker.visible = true
    this._markerT = (this._markerT || 0) + dt
    const c = king.box.getCenter(this.towerCenter)
    const roofHalf = BlockGeometry.halfHeights[roofGeomIndex(king.typeTop)]
    const top = king.roofAnimating && king.roofAnim.y > 0
      ? king.roofAnim.y + roofHalf
      : towerTopY(king, this.floorHeight)
    marker.position.set(
      c.x + this.gridOffsetX,
      top + KING_MARKER_HOVER + Math.sin(this._markerT * 1.6) * 0.22,
      c.y + this.gridOffsetZ
    )
    marker.rotation.y += 0.9 * dt
    // The roof's shade depends on the floor count, so it moves as the king is
    // built up or knocked down.
    if (this._markerFloors !== king.numFloors) {
      this._markerFloors = king.numFloors
      this.refreshKingMarkerColor()
    }
  }

  /**
   * Give a tower enough block instances to stand `slots` floors tall.
   *
   * Towers are pre-allocated floorSlots instances each at startup; this tops one
   * up afterwards, out of the spare capacity reserved in the batched mesh.
   */
  growTowerSlots(tower, slots) {
    while (tower.floorInstances.length < slots) {
      const idx = this.towerMesh.addInstance(this.geomIds[tower.typeBottom])
      this.towerMesh.setColorAt(idx, tower.baseColor)
      this.towerMesh.setVisibleAt(idx, false)
      tower.floorInstances.push(idx)
      this.instanceToTower.set(idx, tower)
    }
  }

  /**
   * The visible tower whose footprint covers a grid cell, or null.
   *
   * Used by run playback to name a tower without depending on object identity,
   * which cannot survive being written to a file. A cell pair does.
   */
  towerAtCell(gx, gy) {
    const cu = this.cellUnit
    const x = gx * cu + cu / 2, y = gy * cu + cu / 2
    for (const t of this.towers) {
      if (!t.visible) continue
      if (x >= t.box.min.x && x <= t.box.max.x && y >= t.box.min.y && y <= t.box.max.y) return t
    }
    return null
  }

  setTowerColor(tower, color) {
    const mesh = this.towerMesh
    for (const idx of tower.floorInstances) mesh.setColorAt(idx, color)
    mesh.setColorAt(tower.roofInstance, color)
  }

  /** Per-frame: debris, reroll build-wheels, and the energy system. */
  update(dt) {
    this.debris.update(dt)
    this.interaction.update(dt)
    this.energy.update(dt)
    this.upkeep.update(dt)
    this.updateHitFlashes(dt)
    this.updateKingAlarm()
    this.updateKingMarker(dt)
    this.flowView?.update()
    this.updateKingBeam()
  }

  /** Count currently-placed generators (for the MAX_GENS cap). */
  countGens() {
    let n = 0
    for (const t of this.towers) if (t.visible && isGenerator(t)) n++
    return n
  }

  /** Whether another generator may be placed (under the cap). */
  canPlaceGen() {
    return this.countGens() < MAX_GENS
  }

  /**
   * Generators used to burn down: a countdown pie on top, a floor lost every
   * N energy pulses, and a lifetime cap on how many floors one would accept.
   * All removed - a generator is an ordinary tower now: it stays up and can
   * be built back to full height whenever you like. What gates its output
   * instead is whether it's linked to a support tower.
   */

  /** True if a generator is actively producing mana right now (so its lifespan
   *  should tick): needs height and to be in one of the energy system's active
   *  sets — connected path or a claimed enclosure. */
  genIsProducing(t) {
    if (t.numFloors < 1) return false
    const e = this.energy
    return e.connectedTowers.has(t) || e.enclosureGens.includes(t)
  }

  /**
   * Update matrices for a single tower
   */
  updateTowerMatrices(tower) {
    const { dummy, towerMesh } = this

    // Hidden tower: hide all of its instances (floors + roof) and bail.
    if (tower.visible === false) {
      for (let f = 0; f < tower.floorInstances.length; f++) {
        towerMesh.setVisibleAt(tower.floorInstances[f], false)
      }
      towerMesh.setVisibleAt(tower.roofInstance, false)
      return
    }

    // Tetromino walls: geometry at cell scale, centred on the bounding box.
    if (tower.tetro) {
      const c = tower.box.getCenter(this.towerCenter)
      const ax = c.x, az = c.y
      const nf = tower.numFloors
      const fhh = this.floorHeight / 2
      for (let f = 0; f < tower.floorInstances.length; f++) {
        const idx = tower.floorInstances[f]
        if (f < nf) {
          dummy.position.set(ax, f * this.floorHeight + fhh, az)
          dummy.scale.set(1, this.floorHeight, 1)
          dummy.rotation.y = 0
          dummy.updateMatrix()
          towerMesh.setMatrixAt(idx, dummy.matrix)
          towerMesh.setVisibleAt(idx, true)
        } else {
          towerMesh.setVisibleAt(idx, false)
        }
      }
      towerMesh.setVisibleAt(tower.roofInstance, true)
      if (tower.roofAnimating) return
      dummy.position.set(ax, nf * this.floorHeight + TetrominoGeometry.roofHalf, az)
      dummy.scale.set(1, 1, 1)
      dummy.rotation.y = 0
      dummy.updateMatrix()
      towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
      return
    }

    const center = tower.box.getCenter(this.towerCenter)
    const size = tower.box.getSize(this.towerSize)
    const numFloors = tower.numFloors

    // Half-heights for centered geometries
    const floorHalfHeight = this.floorHeight / 2
    const roofHalfHeight = BlockGeometry.halfHeights[roofGeomIndex(tower.typeTop)]

    for (let f = 0; f < tower.floorInstances.length; f++) {
      const idx = tower.floorInstances[f]
      if (f < numFloors) {
        dummy.position.set(center.x, f * this.floorHeight + floorHalfHeight, center.y)
        dummy.scale.set(size.x, this.floorHeight, size.y)
        dummy.rotation.y = tower.rotation
        dummy.updateMatrix()
        towerMesh.setMatrixAt(idx, dummy.matrix)
        towerMesh.setVisibleAt(idx, true)
      } else {
        towerMesh.setVisibleAt(idx, false)
      }
    }

    // A visible tower always shows its roof.
    towerMesh.setVisibleAt(tower.roofInstance, true)

    // Skip roof matrix if animation is in progress (roof controlled by GSAP)
    if (tower.roofAnimating) return

    // Roof on top
    dummy.position.set(center.x, numFloors * this.floorHeight + roofHalfHeight, center.y)
    dummy.scale.set(size.x, 1, size.y)
    dummy.rotation.y = tower.rotation
    dummy.updateMatrix()
    towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
  }

  /**
   * Create debug grid helpers aligned with the city
   */
  /**
   * A 2px outline round the buildable area.
   *
   * Line2 rather than a LineLoop or a thin quad: WebGPU (like WebGL) ignores
   * linewidth on ordinary lines, so a plain line is always 1px, and a
   * world-space quad border would grow and shrink with zoom. Line2NodeMaterial
   * with worldUnits:false measures the width in screen pixels, so the outline
   * stays 2px whether you're zoomed all the way in or out.
   */
  createBoardOutline() {
    const hw = this.visibleHalf, hh = this.visibleHalf
    const y = 0.02
    const geom = new LineGeometry()
    geom.setPositions([
      -hw, y, -hh,
      hw, y, -hh,
      hw, y, hh,
      -hw, y, hh,
      -hw, y, -hh, // closed
    ])
    const mat = new Line2NodeMaterial({
      color: OUTLINE_COLOR,
      linewidth: 2, // screen pixels, because worldUnits is false
      worldUnits: false,
      transparent: true,
      opacity: OUTLINE_OPACITY,
      depthWrite: false,
    })
    // Line2 needs the viewport to convert pixel width into clip space.
    mat.resolution = new Vector2(window.innerWidth, window.innerHeight)
    const line = new Line2(geom, mat)
    line.computeLineDistances()
    line.renderOrder = 4
    line.frustumCulled = false
    this.scene.add(line)
    this.boardOutline = line
  }

  /** Keep the outline's pixel width correct across resizes. */
  onResize(w, h) {
    if (this.boardOutline) this.boardOutline.material.resolution.set(w, h)
  }

  /**
   * Tear down the board's grid furniture and draw it again at the current size.
   *
   * Rebuilt rather than rescaled because the dot shader bakes the cell count
   * into its UV multiply and GridHelper bakes its divisions into geometry -
   * scaling either one would stretch the cells instead of adding more.
   */
  rebuildGrids() {
    for (const key of ['boardOutline', 'cellGrid', 'dotMesh', 'lotGrid']) {
      this.disposeGridObject(this[key])
      this[key] = null
    }
    this.createGrids()
  }

  /** Pull one piece of grid furniture out of the scene and free it. */
  disposeGridObject(obj) {
    if (!obj) return
    this.scene.remove(obj)
    obj.geometry?.dispose()
    obj.material?.dispose()
  }

  createGrids() {
    // Snap the ground to the new size - except mid-expand, where it is already
    // being tweened there (see expandGrids).
    if (!this._expanding) this.lighting?.setBoardSize(this.visibleHalf, this.cellSize)
    this.createBoardOutline()
    // One dial the expand flash drives the dots with (see flashGrid). Rebuilt
    // with the grid, because the material it feeds is rebuilt with it too.
    this.gridFade = uniform(1)
    const span = this.visibleHalf * 2
    // Fine cell grid - centered at origin (same as lot grid). One line per buildable cell.
    const cellGrid = new GridHelper(span, span / this.cellUnit, 0x888888, 0x888888)
    cellGrid.material.transparent = true
    cellGrid.material.opacity = CELL_GRID_OPACITY
    cellGrid.position.set(0, 0.01, 0)
    this.scene.add(cellGrid)
    this.cellGrid = cellGrid

    // Grid intersection dots using procedural plane shader
    const dotPlaneGeometry = new PlaneGeometry(span, span)
    dotPlaneGeometry.rotateX(-Math.PI / 2)
    const dotMaterial = new MeshBasicNodeMaterial()
    dotMaterial.transparent = true
    dotMaterial.alphaTest = 0.5
    dotMaterial.side = 2 // DoubleSide

    // Procedural dots at grid intersections (one per buildable cell, matching cell grid)
    const cellCoord = uv().mul(span / this.cellUnit)
    const fractCoord = fract(cellCoord)
    const toGridX = min(fractCoord.x, float(1).sub(fractCoord.x))
    const toGridY = min(fractCoord.y, float(1).sub(fractCoord.y))
    const dist = toGridX.mul(toGridX).add(toGridY.mul(toGridY)).sqrt()
    const dotRadius = float(0.04)
    const dotMask = float(1).sub(step(dotRadius, dist))

    const dotColor = vec3(0.267, 0.267, 0.267)
    // Colour rides the fade as well as alpha: the dots are alpha-TESTED, so
    // opacity alone would only pop them in at the halfway point and the flash's
    // overshoot would do nothing to them. Brightness makes them part of it.
    const dotLit = dotColor.mul(this.gridFade)
    dotMaterial.colorNode = dotLit
    dotMaterial.opacityNode = dotMask.mul(this.gridFade)
    dotMaterial.mrtNode = mrt({
      output: dotLit,
      normal: vec3(0, 1, 0)
    })

    this.dotMesh = new Mesh(dotPlaneGeometry, dotMaterial)
    this.dotMesh.position.set(0, 0.015, 0)
    this.scene.add(this.dotMesh)

    // Coarse lot grid - centered at origin, lines at lot spacing intervals.
    // Held just under full alpha so the expand flash has somewhere to go.
    const lotGrid = new GridHelper(span, this.visibleLots, 0x888888, 0x888888)
    lotGrid.material.transparent = true
    lotGrid.material.opacity = LOT_GRID_OPACITY
    lotGrid.position.set(0, 0.02, 0)
    this.scene.add(lotGrid)
    this.lotGrid = lotGrid

    this.lotGrowth.createLotOutlines()
    this.enclosure.build()
  }

}
