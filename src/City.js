import {
  Line2NodeMaterial,
  MathUtils,
  Vector2,
  Vector3,
  Object3D,
  BatchedMesh,
  MeshPhysicalNodeMaterial,
  Color,
  GridHelper,
  PlaneGeometry,
  Mesh,
  BufferGeometry,
  Float32BufferAttribute,
  MeshBasicNodeMaterial,
  AdditiveBlending,
  ArrowHelper,
  CircleGeometry,
  Group,
} from 'three/webgpu'
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import gsap from 'gsap'
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture, mrt, uv, fract, step, min, float, attribute, output } from 'three/tsl'
import { Tower } from './Tower.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { TetrominoGeometry } from './lib/TetrominoGeometry.js'
import { Debris } from './lib/Debris.js'
import { Sounds } from './lib/Sounds.js'
import FastSimplexNoise from '@webvoxel/fast-simplex-noise'
import { EnergySystem } from './systems/EnergySystem.js'
import { RangeVisuals } from './systems/RangeVisuals.js'
import { LotGrowth } from './systems/LotGrowth.js'
import { TowerInteraction } from './systems/TowerInteraction.js'
import { CityGenerator } from './systems/CityGenerator.js'
import { TowerRenderer } from './systems/TowerRenderer.js'
import { ACCENT_COLORS } from './palette.js'
import { Buffs } from './buffs.js'
import { TopType, isTurret, isGenerator, towerArea, towerTopY, roofGeomIndex, isEnclosureGenerator, isGrey, isShield, claimsEnclosure, tileColorIndex, shieldRadiusCells, GEN_LEVEL_BUDGET, KING_HEALTH } from './blockTypes.js'

// Energy pulses a generator fires per floor before that floor crumbles away.
// A generator's life is therefore its height: a 4-storey gen lasts 4x as long as
// a 1-storey one, so building tall is an investment in uptime rather than just
// output. It visibly shrinks as it burns down, and dies when the last floor goes.
const GEN_PULSES_PER_FLOOR = 8
const MAX_GENS = 30 // hard cap on simultaneously placed generators

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
  // City size in lots (10x10 = 100 lots, 50x50 cells, 100x100 world units).
  // Everything downstream derives from this - creep spawn ring, shadow bounds
  // and the zoom-out cap all read actualGridWidth rather than hardcoding it.
  static CITY_SIZE_LOTS = 10

  constructor(scene, params) {
    this.scene = scene
    this.params = params

    this.towers = []
    this.towerMesh = null
    this.towerMaterial = null
    this.dummy = new Object3D()
    this.towerSize = new Vector2(1, 1)
    this.towerCenter = new Vector2()

    // City height distribution noise - lower frequency for larger "neighborhoods"
    this.noiseFrequency = params.scene.noiseScale
    this.cityNoise = new FastSimplexNoise({
      frequency: this.noiseFrequency,
      octaves: 3,
      min: 0,
      max: 1,
      persistence: 0.6,
    })
    this.heightNoiseScale = params.scene.noiseHeight
    this.randHeightAmount = params.scene.randHeight
    this.randHeightPower = params.scene.randHeightPower
    this.noiseSubtract = params.scene.noiseSubtract
    this.centerFalloff = params.scene.centerFalloff
    this.skipChance = params.scene.skipChance

    this.actualGridWidth = 0
    this.actualGridHeight = 0

    // Accent colors for lit towers, trails, and new floors
    // The lighten pass lives in palette.js so the DOM hexes are the same values.
    this.accentColors = ACCENT_COLORS.map(c => c.clone())
    this.instanceToTower = new Map() // Maps instance ID to tower

    // Floor stacking config
    this.maxFloors = 5
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
    this.generator = new CityGenerator(this)

    // Runtime tower visuals: accent coloring, visibility, reroll, empty-tower
    // lifecycle (on the shared BatchedMesh built in initTowers).
    this.renderer = new TowerRenderer(this)

    // Ground rings for zones of control + turret range, and the turret-circle
    // data for the post-process coverage glow.
    this.rangeVisuals = new RangeVisuals(this)
  }

  async init() {
    await BlockGeometry.init()
    this.initGrid()
    await this.initTowers()
    this.placeKing() // central king piece (must exist before the cluster seeds around it)
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
        const lotColorIndex = MathUtils.randInt(0, this.accentColors.length - 1)
        row.push({ lotX, lotY, colorIndex: lotColorIndex, towers: [], active: true })
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
   * typeTop, colorIndex, topColorIndex }. Grabs a pooled tower, builds it at
   * level 0. Returns the tower or null if the pool is exhausted.
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
    t.numFloors = 0
    t.rotation = 0
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
    this.updateEnclosure()
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
  freePlacedTower(tower) {
    tower.genLife = undefined // clear lifespan + pie so a reused pool tower starts fresh
    tower.genWarned = false
    tower.genOnline = false
    tower.genLevelsAdded = 0
    this._removeGenPie(tower)
    for (const [dx, dy] of tower.cells) this.occupied[tower.cellY + dy][tower.cellX + dx] = false
    const lot = this.lots[tower.lotY][tower.lotX]
    const k = lot.towers.indexOf(tower)
    if (k >= 0) lot.towers.splice(k, 1)

    tower.placed = false
    tower.dormant = true
    tower.tetro = null
    tower.visible = false
    tower.numFloors = 0
    this.updateTowerMatrices(tower)
    this.towerPool.push(tower)
    this.onTowerChanged(tower)
    this.updateEnclosure()
  }

  /** Free a tower's cells and remove it (no debris). Placed tiles return to the
   *  pool; pre-built center-lot towers free their footprint and hide. */
  demolishTower(tower) {
    if (tower.placed) { this.freePlacedTower(tower); return }
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
    this.updateEnclosure()
  }

  // ---- starting cluster -------------------------------------------------------

  /** Build a starting tile ({ cells, cost, opts }) from a bag spec. Walls cost
   *  = cells, generators/turrets cost = cells x 2. */
  _rollStartTile() {
    const spec = this.drawTileSpec()
    const topColorIndex = MathUtils.randInt(0, Tower.COLORS.length - 1)
    if (spec.wall) {
      const states = TetrominoGeometry.states[spec.shapeName]
      const rot = MathUtils.randInt(0, states.length - 1)
      const cells = TetrominoGeometry.placeCells(states[rot])
      return { cells, cost: cells.length, opts: { tetro: { name: spec.shapeName, rot }, typeTop: TopType.SQUARE, colorIndex: 0, topColorIndex } }
    }
    const cells = []
    for (let j = 0; j < spec.s; j++) for (let i = 0; i < spec.s; i++) cells.push([i, j])
    const colorIndex = tileColorIndex(spec.typeTop)
    return { cells, cost: cells.length * 2, opts: { typeTop: spec.typeTop, colorIndex, topColorIndex } }
  }

  /** Draw the next tile spec from the ONE shared shuffled bag - used by both the
   *  start cluster and the palette - refilling + reshuffling when empty. */
  drawTileSpec() {
    if (!this._tileBag || this._tileBag.length === 0) this._fillTileBag()
    return this._tileBag.pop()
  }

  /** Fill + shuffle the 66-tile bag: walls 6 each (6 shapes = 36, ~55%), 1x1
   *  gens/turrets 3 each (6), 2x2 gens 3 each (3), 3x3 1 each (3). */
  _fillTileBag() {
    const bag = []
    const add = (n, spec) => { for (let i = 0; i < n; i++) bag.push(spec) }
    for (const shapeName of TetrominoGeometry.names) add(7, { wall: true, shapeName })
    // Everything that isn't a wall is a single cell. Generators used to also come
    // in 2x2 and 3x3 - they were the only multi-cell blocks in the game besides
    // the tetromino walls - which made footprint a second, inconsistent axis of
    // variation on top of height.
    //
    // Counts keep the old mix: 14 generator tiles to 9 turret tiles, and 23
    // non-wall tiles overall, the same as when the big ones were in the bag. Drop
    // those numbers and walls would go from ~68% of draws to ~77%.
    const gens = [TopType.PATH_GENERATOR, TopType.ENCLOSURE_GENERATOR]
    const turrets = [TopType.PEG_TURRET, TopType.DIVOT_TURRET, TopType.MORTAR_TURRET]
    for (const typeTop of gens) add(7, { s: 1, typeTop })
    for (const typeTop of turrets) add(3, { s: 1, typeTop })
    add(4, { s: 1, typeTop: TopType.BARRACKS })
    add(3, { s: 1, typeTop: TopType.SHIELD })
    for (let i = bag.length - 1; i > 0; i--) {
      const j = MathUtils.randInt(0, i)
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    this._tileBag = bag
  }

  /** Find a spot where `cells` fits within ~2 cells of the cluster, near the
   *  centre, preferring a gap (not touching existing tiles); falls back to any
   *  fit so the cluster always fills. */
  _findClusterSpot(cells, cluster, ccx, ccy) {
    const W = this.gridCellsX, H = this.gridCellsY
    const R = 2
    const cand = []
    const seen = new Set()
    for (const key of cluster) {
      const x = key % W, y = (key - x) / W
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const nk = ny * W + nx
          if (this.occupied[ny][nx] || seen.has(nk)) continue
          seen.add(nk)
          cand.push({ x: nx, y: ny, d: (nx - ccx) ** 2 + (ny - ccy) ** 2 + Math.random() * 6 })
        }
      }
    }
    cand.sort((a, b) => a.d - b.d)
    const touches = (gx, gy) => cells.some(([dx, dy]) => {
      const x = gx + dx, y = gy + dy
      return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([ax, ay]) =>
        ax >= 0 && ay >= 0 && ax < W && ay < H && cluster.has(ay * W + ax))
    })
    for (const gappy of [true, false]) {
      for (const c of cand) {
        for (const [dx, dy] of cells) {
          const gx = c.x - dx, gy = c.y - dy
          if (!this.fits(gx, gy, cells)) continue
          if (gappy && touches(gx, gy)) continue
          return { gx, gy }
        }
      }
    }
    return null
  }

  /** Place a roughly circular, gappy starting cluster of tiles centred on the
   *  middle (point budget: walls 1/cell, generators/turrets 2/cell), each given a
   *  procedural noise height (the old generation method - mostly flat, a few
   *  tall). The intro builds them up staggered from the centre. */
  generateStartCluster(budget = 50) {
    // Middle of the board in cells. Derived from the cell grid rather than from
    // a "centre lot", which doesn't exist for an even lot count.
    const ccx = Math.floor(this.gridCellsX / 2)
    const ccy = Math.floor(this.gridCellsY / 2)
    const W = this.gridCellsX
    const cluster = new Set()
    const placed = []
    const add = (gx, gy, cells) => { for (const [dx, dy] of cells) cluster.add((gy + dy) * W + (gx + dx)) }

    // The king (placed first, at the centre) is the seed - the city grows around it.
    cluster.add(ccy * W + ccx)

    let tries = 0
    while (budget > 0 && tries < 800) {
      tries++
      const tile = this._rollStartTile()
      if (tile.cost > budget) continue
      const pos = this._findClusterSpot(tile.cells, cluster, ccx, ccy)
      if (!pos) continue
      const t = this.placeTileFree(pos.gx, pos.gy, tile.cells, tile.opts, true)
      if (!t) continue
      t.startCluster = true // pre-existing: excluded from the per-type cost count
      add(pos.gx, pos.gy, tile.cells)
      placed.push(t)
      budget -= tile.cost
    }

    // Procedural noise heights (mostly flat, a few tall); the intro builds them
    // up staggered from the centre.
    for (const t of placed) {
      const c = t.box.getCenter(this.towerCenter)
      t.cityNoiseVal = this.cityNoise.scaled2D(c.x, c.y)
      t.randFactor = Math.random()
      t.numFloors = this.generator.floorsForTower(t)
    }
  }

  /** Place the king: a 1x1 tower at the exact centre with the hole roof, in a
   *  random light accent colour. Losing it
   *  (creeps knock it to 0 floors) ends the game. */
  placeKing() {
    // Middle of the board in cells. Derived from the cell grid rather than from
    // a "centre lot", which doesn't exist for an even lot count.
    const ccx = Math.floor(this.gridCellsX / 2)
    const ccy = Math.floor(this.gridCellsY / 2)
    // One of the three light city accents, drawn per game, so the piece you're
    // defending isn't the same colour every run.
    const kingColor = MathUtils.randInt(0, this.accentColors.length - 1)
    // HOLE is an otherwise-unused top type, so the king gets a distinct roof
    // without being picked up by isGenerator/isTurret anywhere.
    const t = this.placeTileFree(ccx, ccy, [[0, 0]], {
      typeTop: TopType.HOLE, colorIndex: kingColor, topColorIndex: kingColor, king: true,
    }, true)
    if (!t) return
    t.numFloors = this.kingMaxFloors || KING_HEALTH
    this.updateTowerMatrices(t)
    this.king = t
    this.kingAlive = true
  }

  /** Fire the game-over hook once (the king died). */
  triggerGameOver() {
    if (!this.kingAlive) return
    this.kingAlive = false
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
    const maxInstances = totalTowers * (this.maxFloors + 1) + 10
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

    // Create instances for each tower: maxFloors base + 1 roof
    for (let i = 0; i < this.towers.length; i++) {
      const tower = this.towers[i]
      tower.floorInstances = []

      // Create floor instances (base geometry)
      for (let f = 0; f < this.maxFloors; f++) {
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

    // Free-placement pool: generic hidden towers, each pre-allocated maxFloors+1
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
      for (let f = 0; f < this.maxFloors; f++) {
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
    })
    this.updateMatrices()

    // 2. Sort by distance (center first). Normalize the stagger against the
    //    farthest *building* tower (not the whole-city diagonal), so the active
    //    lot ripples across the full stagger window instead of starting at once.
    towerData.sort((a, b) => a.dist - b.dist)
    const building = towerData.filter(t => t.targetFloors > 0)
    const maxDist = building[building.length - 1]?.dist || 1

    // 3. Animate each tower's floors with stagger
    const staggerDuration = duration * 0.85 // 85% of duration for stagger spread
    const floorDelay = 0.25 // 250ms between floors of same tower

    let maxDelay = 0
    towerData.forEach(({ tower, targetFloors, dist }) => {
      if (targetFloors === 0) return

      const staggerDelay = (dist / maxDist) * staggerDuration

      // Animate each floor sequentially (no debris during intro)
      const baseColor = tower.isLit && tower.litColor ? tower.litColor : tower.baseColor
      const newFloorColor = Tower.lightenColor(baseColor)
      // Volume fades based on distance (0 at 3 lots away)
      const maxSoundDist = this.cellSize * 3 // 3 lots
      const volume = Math.max(0, 1 - dist / maxSoundDist) * 0.35
      for (let f = 0; f < targetFloors; f++) {
        const delay = staggerDelay + f * floorDelay
        maxDelay = Math.max(maxDelay, delay)
        setTimeout(() => {
          tower.numFloors = f + 1
          // Play pop sound with pitch based on floor height, volume based on distance
          const pitch = 0.8 + (f / this.maxFloors) * 1.2
          if (volume > 0) Sounds.play('pop', pitch, 0.15, volume)
          tower.animateNewFloor(
            this.towerMesh,
            this.floorHeight,
            f,
            newFloorColor,
            () => this.updateTowerMatrices(tower),
            null // no debris
          )
        }, delay * 1000)
      }
    })

    // Unmute sounds and restore debris after intro completes. Also refresh
    // tower visuals once so monasteries/connectors reflect the settled city
    // (the intro builds via updateTowerMatrices, which skips that pass).
    setTimeout(() => {
      Sounds.unmute(['stone', 'tick', 'clink'])
      this.debris.enabled = debrisWasEnabled
      this.updateTowerVisuals()
    }, (maxDelay + 1) * 1000)

    // 4. Camera zoom animation (angle-based distance)
    const target = controls.target.clone()
    const direction = camera.position.clone().sub(target).normalize()
    const endDist = camera.position.distanceTo(target)
    const startDist = endDist * 3

    // Set initial zoomed-out position
    camera.position.copy(target).addScaledVector(direction, startDist)

    // Disable user input during the zoom tween - gsap and OrbitControls fighting
    // over the camera leaves the controls in a bad state (pan reads as rotate).
    controls.enabled = false

    // Animate distance only
    const animState = { dist: startDist }
    gsap.to(animState, {
      dist: endDist,
      duration: duration,
      ease: 'power2.out',
      onUpdate: () => {
        camera.position.copy(target).addScaledVector(direction, animState.dist)
        controls.update()
      },
      onComplete: () => { controls.enabled = true },
    })
  }

  updateMatrices() {
    if (!this.towerMesh) return
    const { dummy, towerMesh, towers } = this

    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i]

      // Hide all instances if tower is not visible
      if (tower.visible === false) {
        for (let f = 0; f < this.maxFloors; f++) {
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
        for (let f = 0; f < this.maxFloors; f++) {
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
      for (let f = 0; f < this.maxFloors; f++) {
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

  regenerate() {
    // Re-randomize all tower properties and recalculate the city. Skip the free-
    // placement pool (dormant) and player-placed tiles - only the pre-built
    // center lot regenerates.
    for (const tower of this.towers) {
      if (tower.dormant || tower.placed) continue
      tower.randFactor = MathUtils.randFloat(0, 1)
      tower.skipFactor = MathUtils.randFloat(0, 1)
      tower.colorIndex = MathUtils.randInt(0, 2)
      tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))
      // Reset to base colors first
      tower.isLit = false
      for (const idx of tower.floorInstances) {
        this.towerMesh.setColorAt(idx, tower.baseColor)
      }
      this.towerMesh.setColorAt(tower.roofInstance, tower.topColor)
    }
    // Regenerate noise with new seed
    this.generator.recalculateNoise()
    this.renderer.recalculateVisibility()
    // Re-apply lit towers
    this.renderer.applyLitTowers()
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

  /**
   * Build a creep flow field (multi-source BFS) over the cell grid. Goals are the
   * king (tier 1) then generators/turrets (tier 2, only filling cells the king
   * can't reach); built grey walls (>=1 floor) are impassable. Each reachable cell
   * stores a step (flowDX, flowDZ) toward the nearest goal; flowDist < 0 = no path.
   */
  computeFlowField() {
    const W = this.gridCellsX, H = this.gridCellsY, N = W * H
    if (!this.flowDX) {
      this.flowDX = new Int8Array(N)
      this.flowDZ = new Int8Array(N)
      this.flowDist = new Int32Array(N)
      this.flowToKing = new Uint8Array(N) // 1 = this cell's flow leads to the king, 0 = to a gen
      // Big creeps need a 2-wide corridor: their own field treats 1-cell gaps as walls.
      this.flowDXBig = new Int8Array(N)
      this.flowDZBig = new Int8Array(N)
      this.flowDistBig = new Int32Array(N)
      this.flowToKingBig = new Uint8Array(N)
      this._flowWall = new Uint8Array(N)
      this._flowBlock = new Uint8Array(N) // obstacle mask for the current pass
      this._flowBase = new Uint8Array(N) // pre-pinch snapshot of that mask
      this._flowQueue = new Int32Array(N)
    }
    const wall = this._flowWall; wall.fill(0)
    const kingGoals = [], genGoals = []
    for (const t of this.towers) {
      if (!t.visible || !t.cells) continue
      for (const [dx, dy] of t.cells) {
        const x = t.cellX + dx, y = t.cellY + dy
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const i = y * W + x
        if (t.king) kingGoals.push(i) // primary goal
        else if (isGrey(t)) wall[i] = 1 // walls block; creeps route around / smash through gaps
        else genGoals.push(i) // gens/turrets: second-priority goals
      }
    }
    const DDX = [1, -1, 0, 0], DDZ = [0, 0, 1, -1]
    const q = this._flowQueue
    const block = this._flowBlock, base = this._flowBase

    // Fill `block` with a pass's obstacle mask: walls (+ gens for the king pass),
    // plus — for big creeps — any free cell pinched between obstacles on opposite
    // sides, so a 2-wide body can't slip through a 1-cell gap (off-grid = open).
    const buildMask = (blockGens, big) => {
      base.set(wall)
      if (blockGens) for (const gi of genGoals) base[gi] = 1
      if (!big) { block.set(base); return }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (base[i]) { block[i] = 1; continue }
        const L = x > 0 && base[i - 1], R = x < W - 1 && base[i + 1]
        const U = y > 0 && base[i - W], D = y < H - 1 && base[i + W]
        block[i] = ((L && R) || (U && D)) ? 1 : 0
      }
    }

    // Multi-source BFS over `block`, writing step vectors into the output arrays.
    const bfs = (sources, toKing, dist, fdx, fdz, ftk) => {
      let head = 0, tail = 0
      for (const i of sources) {
        if (dist[i] >= 0 || block[i]) continue
        dist[i] = 0; ftk[i] = toKing; q[tail++] = i
      }
      while (head < tail) {
        const i = q[head++]
        const x = i % W, y = (i - x) / W
        for (let d = 0; d < 4; d++) {
          const nx = x + DDX[d], ny = y + DDZ[d]
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const ni = ny * W + nx
          if (block[ni] || dist[ni] >= 0) continue
          dist[ni] = dist[i] + 1; ftk[ni] = toKing
          fdx[ni] = -DDX[d]; fdz[ni] = -DDZ[d] // step from ni back toward i (nearer the goal)
          q[tail++] = ni
        }
      }
    }

    // King pass (gens/turrets seal the king like walls), then gen pass (gens
    // passable) — once for the normal field, once for the big-creep field.
    this.flowDist.fill(-1)
    buildMask(true, false); bfs(kingGoals, 1, this.flowDist, this.flowDX, this.flowDZ, this.flowToKing)
    buildMask(false, false); bfs(genGoals, 0, this.flowDist, this.flowDX, this.flowDZ, this.flowToKing)

    this.flowDistBig.fill(-1)
    buildMask(true, true); bfs(kingGoals, 1, this.flowDistBig, this.flowDXBig, this.flowDZBig, this.flowToKingBig)
    buildMask(false, true); bfs(genGoals, 0, this.flowDistBig, this.flowDXBig, this.flowDZBig, this.flowToKingBig)

    this.flowDirty = false
    this.updateFlowDebug()
  }

  /** Debug overlay (toggle flowDebugEnabled, key F): a pooled red ArrowHelper per
   *  reachable cell pointing along the flow toward the nearest goal. Unreachable
   *  cells (walls / no path) get no arrow. */
  updateFlowDebug() {
    const enabled = !!this.flowDebugEnabled
    if (!enabled && !this._flowArrowGroup) return
    if (!this._flowArrowGroup) {
      this._flowArrowGroup = new Group()
      this.scene.add(this._flowArrowGroup)
      this._flowArrows = []
      this._flowGoalArrows = []
      this._arrDir = new Vector3()
      this._upDir = new Vector3(0, 1, 0)
    }
    this._flowArrowGroup.visible = enabled
    if (!enabled || !this.flowDist) {
      for (const ar of this._flowArrows) ar.visible = false
      for (const ar of this._flowGoalArrows) ar.visible = false
      return
    }
    const W = this.gridCellsX, H = this.gridCellsY, cu = this.cellUnit
    // Draw debug arrows over everything (goal arrows sit inside their towers).
    const noDepth = (ar) => {
      ar.line.material.depthTest = false; ar.cone.material.depthTest = false
      ar.line.renderOrder = 11; ar.cone.renderOrder = 11
    }
    let a = 0, m = 0
    for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
      const idx = gy * W + gx
      const d = this.flowDist[idx]
      if (d < 0) continue // unreachable / wall
      const cx = gx * cu + cu / 2 + this.gridOffsetX
      const cz = gy * cu + cu / 2 + this.gridOffsetZ
      // Colour by flow target: red = leads to the king, green = leads to a gen/turret.
      const col = this.flowToKing[idx] ? 0xff2020 : 0x22ff22
      if (d === 0) { // goal cell: tall up-arrow (where the flow converges)
        let g = this._flowGoalArrows[m]
        if (!g) {
          g = new ArrowHelper(this._upDir, new Vector3(cx, 0.1, cz), cu * 1.6, col, cu * 0.5, cu * 0.4)
          noDepth(g)
          this._flowGoalArrows.push(g)
          this._flowArrowGroup.add(g)
        } else { g.position.set(cx, 0.1, cz); g.visible = true }
        g.setColor(col)
        m++
        continue
      }
      // flow arrow toward the nearest goal
      this._arrDir.set(this.flowDX[idx], 0, this.flowDZ[idx])
      let arrow = this._flowArrows[a]
      if (!arrow) {
        arrow = new ArrowHelper(this._arrDir, new Vector3(cx, 0.35, cz), cu * 0.49, col, cu * 0.22, cu * 0.15)
        noDepth(arrow)
        this._flowArrows.push(arrow)
        this._flowArrowGroup.add(arrow)
      } else {
        arrow.position.set(cx, 0.35, cz)
        arrow.setDirection(this._arrDir)
        arrow.visible = true
      }
      arrow.setColor(col)
      a++
    }
    for (let k = a; k < this._flowArrows.length; k++) this._flowArrows[k].visible = false
    for (let k = m; k < this._flowGoalArrows.length; k++) this._flowGoalArrows[k].visible = false
  }

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

  /** Turret range circles for the post-process coverage glow (called by Demo). */
  getTurretCircles(out = []) {
    return this.rangeVisuals.getTurretCircles(out)
  }


  /** Set every instance color of a tower to a single color. */
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
    this.updateGenLifespans(dt)
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

  /** Cumulative count of how many of a cost-bucket key the PLAYER has placed over
   *  the whole game (only ever rises - expiry/demolish don't lower it), so the
   *  escalating price keeps climbing even though gens expire. */
  recordPlacement(key) {
    if (!this._placedCounts) this._placedCounts = new Map()
    this._placedCounts.set(key, (this._placedCounts.get(key) || 0) + 1)
  }

  placedCount(key) {
    return this._placedCounts ? (this._placedCounts.get(key) || 0) : 0
  }

  /**
   * Generators have a limited lifespan: each ticks down a countdown shown as a
   * little pie wheel (in its accent colour) on top of it, then expires and is
   * removed. This keeps the energy economy from running away — gens must be
   * continually replaced rather than accumulating forever.
   */
  updateGenLifespans(dt) {
    if (!this._genPies) this._genPies = new Map() // tower -> { mesh, step }
    const seen = this._genPies
    const cu = this.cellUnit
    for (const t of this.towers) {
      if (!t.visible || !isGenerator(t)) continue
      if (t.genLife === undefined) {
        t.genLife = GEN_PULSES_PER_FLOOR + Buffs.genLife
        t.genLifeMax = t.genLife
        t.genWarned = false; t.genOnline = false
      }
      // genLife counts down one tick per energy spawn (EnergySystem) and measures
      // the CURRENT floor only. Spend it and the gen drops a storey; run out of
      // storeys and it's gone. The pie therefore reads as progress through the
      // floor you're burning, and the tower itself shows how many are left.
      if (t.genLife <= 0) {
        t.genLife = GEN_PULSES_PER_FLOOR + Buffs.genLife
        // Out of floors: the gen only truly dies once its level budget is spent.
        // With budget left it collapses to a stub you can build back up, which
        // is what makes GEN_LEVEL_BUDGET a second life rather than a hard timer.
        if (t.numFloors <= 1 && (t.genLevelsAdded || 0) >= GEN_LEVEL_BUDGET) {
          this._removeGenPie(t); this.expireGen(t); continue
        }
        if (t.numFloors <= 0) { this._removeGenPie(t); continue }
        // Burning down is the generator spending itself, not taking damage, so
        // no debris: the block just goes. Debris here read as "something hit
        // this", which is the wrong story for a gen running out of fuel.
        t.numFloors -= 1
        this.onTowerChanged(t)
        Sounds.play('alert1', 1.0, 0.1, 0.4)
        // Down to its last floor: this is the "replace me" moment.
        if (t.numFloors === 1 && !t.genWarned && this.genIsProducing(t)) {
          t.genWarned = true
          Sounds.play('gen-warn', 1.0, 0.1, 0.45)
        }
      }
      if (!this.genIsProducing(t)) {
        const idle = seen.get(t)
        if (idle) idle.mesh.visible = false
        continue
      }
      // First time this gen actually produces: a short charge-up, so hooking a
      // generator into a network has an audible "it's alive" moment to answer
      // the power-down when it later dies.
      if (!t.genOnline) {
        t.genOnline = true
        Sounds.play('gen-online', 1.0, 0.08, 0.4)
      }

      const frac = t.genLife / t.genLifeMax
      let pie = seen.get(t)
      if (pie) pie.mesh.visible = true
      if (!pie) {
        const mat = new MeshBasicNodeMaterial({ color: this.accentColors[t.colorIndex].clone(), depthWrite: false })
        mat.mrtNode = mrt({ output: output, normal: vec3(0, 1, 0) }) // flat up-normal -> skip AO
        const mesh = new Mesh(this._genPieGeo(frac), mat)
        mesh.rotation.x = -Math.PI / 2 // lie flat, facing up
        mesh.renderOrder = 6
        this.scene.add(mesh)
        pie = { mesh, step: -1 }
        seen.set(t, pie)
      }
      // Re-tessellate the wedge only when the quantised fraction changes (cheap).
      const stepN = Math.round(frac * 32)
      if (stepN !== pie.step) {
        pie.step = stepN
        pie.mesh.geometry.dispose()
        pie.mesh.geometry = this._genPieGeo(frac)
      }
      // Small wedge tucked into the tower's bottom-right (+x/+z) top corner.
      const c = t.box.getCenter(this._pieCenter || (this._pieCenter = new Vector2()))
      const r = cu * 0.22 // pie radius
      const hx = (t.box.max.x - t.box.min.x) / 2, hz = (t.box.max.y - t.box.min.y) / 2
      pie.mesh.position.set(
        c.x + this.gridOffsetX + (hx - r),
        towerTopY(t, this.floorHeight) + 0.25,
        c.y + this.gridOffsetZ + (hz - r)
      )
      pie.mesh.scale.setScalar(r)
    }
    // Drop pies for gens that vanished without expiring (demolished by the player).
    for (const [t, pie] of seen) {
      if (!t.visible || !isGenerator(t)) { this.scene.remove(pie.mesh); pie.mesh.geometry.dispose(); seen.delete(t); t.genLife = undefined; t.genWarned = false; t.genOnline = false }
    }
  }

  /** True if a generator is actively producing mana right now (so its lifespan
   *  should tick): needs height and to be in one of the energy system's active
   *  sets — connected path or a claimed enclosure. */
  genIsProducing(t) {
    if (t.numFloors < 1) return false
    const e = this.energy
    return e.connectedTowers.has(t) || e.enclosureGens.includes(t)
  }

  /** A CircleGeometry wedge covering `frac` of a full turn, starting at 12 o'clock. */
  _genPieGeo(frac) {
    return new CircleGeometry(1, Math.max(3, Math.ceil(32 * frac)), Math.PI / 2, Math.PI * 2 * Math.max(0, frac))
  }

  _removeGenPie(t) {
    const pie = this._genPies?.get(t)
    if (pie) { this.scene.remove(pie.mesh); pie.mesh.geometry.dispose(); this._genPies.delete(t) }
  }

  /** A generator reached the end of its lifespan: remove it (debris-free). */
  expireGen(tower) {
    tower.genLife = undefined
    tower.genWarned = false
    tower.genOnline = false
    tower.genLevelsAdded = 0
    Sounds.play('break2', 1.15, 0.15, 0.45)
    this.demolishTower(tower)
  }

  /**
   * Update matrices for a single tower
   */
  updateTowerMatrices(tower) {
    const { dummy, towerMesh } = this

    // Hidden tower: hide all of its instances (floors + roof) and bail.
    if (tower.visible === false) {
      for (let f = 0; f < this.maxFloors; f++) {
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
      for (let f = 0; f < this.maxFloors; f++) {
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

    for (let f = 0; f < this.maxFloors; f++) {
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

    // A visible tower always shows its roof (even at level 0, roof-only).
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
    const hw = this.actualGridWidth / 2, hh = this.actualGridHeight / 2
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
      color: 0xffffff,
      linewidth: 2, // screen pixels, because worldUnits is false
      worldUnits: false,
      transparent: true,
      opacity: 0.55,
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

  createGrids() {
    this.createBoardOutline()
    // Fine cell grid - centered at origin (same as lot grid). One line per buildable cell.
    const cellGrid = new GridHelper(this.actualGridWidth, this.actualGridWidth / this.cellUnit, 0x888888, 0x888888)
    cellGrid.material.transparent = true
    cellGrid.material.opacity = 0.5
    cellGrid.position.set(0, 0.01, 0)
    this.scene.add(cellGrid)
    this.cellGrid = cellGrid

    // Grid intersection dots using procedural plane shader
    const dotPlaneGeometry = new PlaneGeometry(this.actualGridWidth, this.actualGridHeight)
    dotPlaneGeometry.rotateX(-Math.PI / 2)
    const dotMaterial = new MeshBasicNodeMaterial()
    dotMaterial.transparent = true
    dotMaterial.alphaTest = 0.5
    dotMaterial.side = 2 // DoubleSide

    // Procedural dots at grid intersections (one per buildable cell, matching cell grid)
    const cellCoord = uv().mul(this.actualGridWidth / this.cellUnit)
    const fractCoord = fract(cellCoord)
    const toGridX = min(fractCoord.x, float(1).sub(fractCoord.x))
    const toGridY = min(fractCoord.y, float(1).sub(fractCoord.y))
    const dist = toGridX.mul(toGridX).add(toGridY.mul(toGridY)).sqrt()
    const dotRadius = float(0.04)
    const dotMask = float(1).sub(step(dotRadius, dist))

    const dotColor = vec3(0.267, 0.267, 0.267)
    dotMaterial.colorNode = dotColor
    dotMaterial.opacityNode = dotMask
    dotMaterial.mrtNode = mrt({
      output: dotColor,
      normal: vec3(0, 1, 0)
    })

    this.dotMesh = new Mesh(dotPlaneGeometry, dotMaterial)
    this.dotMesh.position.set(0, 0.015, 0)
    this.scene.add(this.dotMesh)

    // Coarse lot grid - centered at origin, lines at lot spacing intervals
    const lotGrid = new GridHelper(this.actualGridWidth, this.numLotsX, 0x888888, 0x888888)
    lotGrid.position.set(0, 0.02, 0)
    this.scene.add(lotGrid)
    this.lotGrid = lotGrid

    this.lotGrowth.createLotOutlines()
    this.createEnclosureLayer()
  }

  /** A low-opacity glow per enclosed cell (white = unclaimed, accent = claimed by
   *  an enclosure generator), one merged ground mesh with per-vertex colours. */
  createEnclosureLayer() {
    this.enclosureMaxVerts = this.gridCellsX * this.gridCellsY * 6 // 2 tris/cell
    this._encPos = new Float32Array(this.enclosureMaxVerts * 3)
    const normals = new Float32Array(this.enclosureMaxVerts * 3)
    for (let i = 0; i < this.enclosureMaxVerts; i++) normals[i * 3 + 1] = 1 // all up
    const geom = new BufferGeometry()
    this._encPosAttr = new Float32BufferAttribute(this._encPos, 3)
    this._encPos = this._encPosAttr.array // Float32BufferAttribute copies; write the real buffer
    this._encColAttr = new Float32BufferAttribute(new Float32Array(this.enclosureMaxVerts * 3), 3)
    this._encCol = this._encColAttr.array
    geom.setAttribute('position', this._encPosAttr)
    geom.setAttribute('normal', new Float32BufferAttribute(normals, 3))
    geom.setAttribute('color', this._encColAttr)
    geom.setDrawRange(0, 0)
    this._encGeom = geom
    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: true, // occluded by blocks in front (depthWrite off: don't self-occlude)
      depthWrite: false,
      blending: AdditiveBlending,
      side: 2,
    })
    // Per-cell white / accent, scaled by a pulse uniform so the sealed floor
    // visibly brightens on every unit of energy its claimant earns. Opacity
    // alone only made it denser; this makes it flash.
    this.enclosureBright = uniform(1)
    mat.colorNode = attribute('color').mul(this.enclosureBright)
    // Write a fake "up" normal to the MRT so GTAO treats the floor as flat and
    // barely darkens it (same trick the path trails use). Stays in the main scene
    // so it depth-sorts against blocks for free.
    mat.mrtNode = mrt({ output: output, normal: vec3(0, 1, 0) })
    // Opacity driven by a uniform so the floor can pulse with its generator.
    this.enclosureOpacity = uniform(0.2)
    mat.opacityNode = this.enclosureOpacity
    this.enclosureMesh = new Mesh(geom, mat)
    this.enclosureMesh.frustumCulled = false
    this.enclosureMesh.renderOrder = 3 // over the ground, under the drag ghost (5)
    this.scene.add(this.enclosureMesh)
    this.updateEnclosure()
  }

  /** Mark the footprint cells of a tower into a Uint8 mask. */
  _markTowerCells(t, mask, W, H) {
    const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 1 }
    if (t.cells) {
      for (const [dx, dy] of t.cells) set(t.cellX + dx, t.cellY + dy)
    } else {
      const gx0 = Math.round(t.box.min.x / this.cellUnit)
      const gy0 = Math.round(t.box.min.y / this.cellUnit)
      const tw = Math.round((t.box.max.x - t.box.min.x) / this.cellUnit)
      const th = Math.round((t.box.max.y - t.box.min.y) / this.cellUnit)
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) set(gx0 + i, gy0 + j)
    }
  }

  /**
   * Recompute enclosures: flood-fill the grid; cells walled off from the boundary
   * are enclosed. Walls = any visible tower EXCEPT enclosure generators (those are
   * the "contents" sealed inside). Enclosed cells are grouped into connected
   * regions; a region is claimed (coloured) by an enclosure generator inside it.
   * Drives the floor glow, per-cell claim colour (placement), and generator mana.
   */
  updateEnclosure() {
    if (!this.enclosureMesh) return
    const W = this.gridCellsX, H = this.gridCellsY

    // 1. Wall mask = visible towers except enclosure generators.
    const wall = new Uint8Array(W * H)
    for (const t of this.towers) {
      if (!t.visible || claimsEnclosure(t)) continue
      this._markTowerCells(t, wall, W, H)
    }

    // 2. Flood-fill "outside" from the boundary through non-wall cells.
    const outside = new Uint8Array(W * H)
    const stack = []
    const seed = (x, y) => {
      const idx = y * W + x
      if (!wall[idx] && !outside[idx]) { outside[idx] = 1; stack.push(idx) }
    }
    for (let x = 0; x < W; x++) { seed(x, 0); seed(x, H - 1) }
    for (let y = 0; y < H; y++) { seed(0, y); seed(W - 1, y) }
    while (stack.length) {
      const idx = stack.pop()
      const x = idx % W, y = (idx - x) / W
      if (x > 0) seed(x - 1, y)
      if (x < W - 1) seed(x + 1, y)
      if (y > 0) seed(x, y - 1)
      if (y < H - 1) seed(x, y + 1)
    }

    // King seal: the king is "enclosed" while no neighbouring cell is reachable
    // from the boundary. success on a fresh seal, warning1 when it gets breached.
    if (this.king && this.king.visible) {
      const kx = this.king.cellX, ky = this.king.cellY
      let kingExposed = false
      const nb = [[kx - 1, ky], [kx + 1, ky], [kx, ky - 1], [kx, ky + 1]]
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || outside[ny * W + nx]) { kingExposed = true; break }
      }
      const enclosed = !kingExposed
      if (this._kingEnclosed !== undefined) {
        if (this._kingEnclosed && !enclosed) Sounds.play('warning1') // enclosure breached
        else if (!this._kingEnclosed && enclosed) Sounds.play('success') // king newly sealed
      }
      this._kingEnclosed = enclosed
    }

    // 3. Group enclosed cells (non-wall && unreachable) into connected regions.
    const region = new Int32Array(W * H).fill(-1)
    const regions = [] // { count, color }
    const rstack = []
    for (let i = 0; i < W * H; i++) {
      if (wall[i] || outside[i] || region[i] !== -1) continue
      const rid = regions.length
      regions.push({ count: 0, color: -1 })
      region[i] = rid
      rstack.push(i)
      while (rstack.length) {
        const idx = rstack.pop()
        regions[rid].count++
        const x = idx % W, y = (idx - x) / W
        const nb = (nx, ny) => {
          const ni = ny * W + nx
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && !wall[ni] && !outside[ni] && region[ni] === -1) {
            region[ni] = rid
            rstack.push(ni)
          }
        }
        nb(x - 1, y); nb(x + 1, y); nb(x, y - 1); nb(x, y + 1)
      }
    }

    // 4. Claim colour from enclosure generators inside a region; set mana size.
    for (const t of this.towers) {
      if (!claimsEnclosure(t)) continue
      t.enclosureRegionCells = 0
      if (!t.visible) continue
      const rid = region[t.cellY * W + t.cellX]
      if (rid >= 0) {
        regions[rid].color = t.colorIndex
        t.enclosureRegionCells = regions[rid].count
      }
    }

    // Region count change: energy.mp3 on a new enclosure, power-down on a lost one
    // (skip the first computation so the initial city doesn't trigger it).
    if (this._enclosureCount !== undefined) {
      if (regions.length > this._enclosureCount) Sounds.play('energy')
      else if (regions.length < this._enclosureCount) Sounds.play('power-down')
    }
    this._enclosureCount = regions.length

    // 5. Per-cell claim colour for placement checks (-1 = unclaimed / not enclosed).
    if (!this.cellClaim) this.cellClaim = new Int8Array(W * H)
    this.cellClaim.fill(-1)
    // enclosedCells is a separate mask because cellClaim can't answer "is this
    // sealed?": an enclosed region with no generator in it has colour -1, which
    // is the same value as open ground. Loot boxes need sealed-or-not, not
    // claimed-by-whom.
    if (!this.enclosedCells) this.enclosedCells = new Uint8Array(W * H)
    this.enclosedCells.fill(0)
    for (let i = 0; i < W * H; i++) {
      const rid = region[i]
      if (rid >= 0) { this.cellClaim[i] = regions[rid].color; this.enclosedCells[i] = 1 }
    }

    // 6. Render: a glow quad per enclosed cell (white unclaimed, accent claimed).
    const pos = this._encPos, col = this._encCol
    const cu = this.cellUnit, yp = 0.06
    let v = 0
    for (let y = 0; y < H && v + 6 <= this.enclosureMaxVerts; y++) {
      for (let x = 0; x < W; x++) {
        const rid = region[y * W + x]
        if (rid < 0) continue
        let cr = 1, cg = 1, cb = 1 // unclaimed = white
        const c = regions[rid].color
        if (c >= 0) { const ac = this.accentColors[c]; cr = ac.r; cg = ac.g; cb = ac.b }
        const x0 = x * cu + this.gridOffsetX, z0 = y * cu + this.gridOffsetZ
        const x1 = x0 + cu, z1 = z0 + cu
        const q = [x0, z0, x1, z0, x1, z1, x0, z0, x1, z1, x0, z1]
        for (let k = 0; k < 6; k++) {
          pos[v * 3] = q[k * 2]; pos[v * 3 + 1] = yp; pos[v * 3 + 2] = q[k * 2 + 1]
          col[v * 3] = cr; col[v * 3 + 1] = cg; col[v * 3 + 2] = cb
          v++
        }
        if (v + 6 > this.enclosureMaxVerts) break
      }
    }
    this._encPosAttr.needsUpdate = true
    this._encColAttr.needsUpdate = true
    this._encGeom.setDrawRange(0, v)
    this.enclosureMesh.visible = v > 0

    // Region sizes just changed -> recompute enclosure-generator mana.
    this.energy.updateEnclosureGenerators()
  }

}
