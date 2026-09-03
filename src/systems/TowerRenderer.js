import { MathUtils, Color } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { Tower } from '../Tower.js'
import { ACCENT_COLORS, SHIELD_LINE } from '../palette.js'
import { Buffs } from '../buffs.js'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TopType, isTurret, isGenerator, isBarracks, isShield, isGrey, roofGeomIndex, genColorIndex, maxFloorsFor, KING_HEALTH, SHIELD_COLOR } from '../blockTypes.js'
import { simInt, simPick } from '../lib/rng.js'

// Fallback only - the king normally wears one of the three accents.
// Damage rattle on a tile that just took a blow. World units of horizontal
// jitter, decaying to nothing over HIT_SHAKE_TIME.
const HIT_SHAKE = 0.18
const HIT_SHAKE_TIME = 0.18
// Hit points of a single tower block. All combat runs on one rule: an attack
// carries a damage number, a thing has hit points, and damage accumulates until
// it covers them - then a creep dies or a tower loses a floor. A regular creep
// bite is 1 damage, so three of them cost a block.
const BLOCK_HP = 3

const KING_COLOR = ACCENT_COLORS[0]


/**
 * TowerRenderer - runtime tower visual state on the shared BatchedMesh: accent
 * coloring of special towers, distance-based visibility, in-place reroll of a
 * tower's type/colors, and the destroy lifecycle. Operates on the mesh/state
 * held by City; one-time mesh construction stays in City.initTowers().
 */
export class TowerRenderer {
  constructor(city) {
    this.city = city
    this.turretColor = new Color(0xbbbbbb) // grey shade for turret tower blocks
    this._shade = new Color()
  }

  /**
   * Accent-colour special towers: path generators (plus) and adjacency
   * generators (holes) go fully accent; turrets get a stashed laser colour.
   */
  applyLitTowers() {
    const city = this.city
    for (const tower of city.towers) {
      tower.isLit = tower.typeTop === TopType.PATH_GENERATOR
      if (tower.isLit) {
        const accent = city.accentColors[tower.colorIndex]
        tower.litColor = accent.clone()
        city.setTowerColor(tower, accent)
      } else {
        tower.litColor = null
        if (isTurret(tower)) {
          this.colorTurretTower(tower)
          city.setTowerColor(tower, tower.baseColor)
        }
      }
    }
  }

  /** Turrets keep grey blocks but stash the lot accent on laserColor. */
  colorTurretTower(tower) {
    tower.laserColor = this.city.accentColors[tower.colorIndex].clone()
    tower.baseColor = this.turretColor
    tower.topColor = this.turretColor
  }

  /** Hide towers based on distance-weighted skip chance (dormant/empty stay hidden). */
  recalculateVisibility() {
    const city = this.city
    if (!city.towerMesh) return
    const gridCenterX = city.actualGridWidth / 2
    const gridCenterY = city.actualGridHeight / 2
    const maxDist = Math.hypot(gridCenterX, gridCenterY)

    for (const tower of city.towers) {
      if (tower.dormant || tower.empty) { tower.visible = false; continue }
      const center = tower.box.getCenter(city.towerCenter)
      const dist = Math.hypot(center.x - gridCenterX, center.y - gridCenterY)
      const distFactor = Math.pow(dist / maxDist, 2) // 0 centre, 1 corner
      const effectiveSkipChance = city.skipChance + distFactor * 1.2
      tower.visible = tower.skipFactor >= effectiveSkipChance
    }
    city.updateMatrices() // visibility applied here based on tower.visible
  }

  /**
   * Re-randomize a tower's tile in place after it's destroyed. Footprint stays;
   * rolls a fresh top type (respecting footprint constraints) + new colours, and
   * points the instances at the new geometries.
   */
  rerollTower(tower) {
    // Rectangular tops only (no quart). Pick from the rect set, then demote
    // footprint-constraint violators to a plain grey rect.
    const pool = [TopType.SQUARE, TopType.PEG_TURRET, TopType.DIVOT_TURRET, TopType.PATH_GENERATOR]
    tower.typeTop = simPick(pool)
    const size = tower.box.getSize(this.city.towerSize)
    const w = Math.round(size.x / this.city.cellUnit)
    const h = Math.round(size.y / this.city.cellUnit)
    // Generators only on squares, turrets only on 1x1 (capped 2/lot).
    if (tower.typeTop === TopType.PATH_GENERATOR && w !== h) tower.typeTop = TopType.SQUARE
    if (isTurret(tower) && (!(w === 1 && h === 1) || this.countLotTurrets(tower) >= 2)) {
      tower.typeTop = TopType.SQUARE
    }
    tower.setTopColorIndex(simInt(0, Tower.COLORS.length - 1))
    this.applyTypeVisuals(tower)
  }

  /**
   * Apply visuals for a placed tile. Tetromino walls point their instances at
   * the merged tetromino body/roof geometry and colour grey; everything else
   * falls through to the rectangular type path.
   */
  applyTileVisuals(tower) {
    if (!tower.tetro) { this.applyTypeVisuals(tower); return }
    const city = this.city
    const mesh = city.towerMesh
    const ids = city.tetroGeom.get(`${tower.tetro.name}:${tower.tetro.rot}`)
    for (const idx of tower.floorInstances) mesh.setGeometryIdAt(idx, ids.bodyId)
    mesh.setGeometryIdAt(tower.roofInstance, ids.roofId)
    tower.isLit = false
    tower.litColor = null
    tower.laserColor = null
    tower.topColor = Tower.COLORS[tower.topColorIndex]
    tower.baseColor = tower.topColor // under-blocks match the top
    this.shadeStack(tower)
  }

  /**
   * Colour a tower's floors as a gradient - base colour at the bottom, lighter
   * toward the top - so a tall wall reads as tall at a glance instead of a flat
   * slab. Every floor is already its own instance, so this costs nothing beyond
   * the colour writes.
   *
   * Shades every instance the tower could ever build, not just the built ones,
   * so floors added later come in at the right shade without a recolour pass.
   * The gradient spans the tower's own cap - turrets go two storeys higher than
   * everything else, and a wall shaded over a turret's range would come out
   * washed out at the top.
   */
  shadeStack(tower) {
    const mesh = this.city.towerMesh
    const n = maxFloorsFor(tower)
    // A browned-out building reads as unpowered: drained toward dark grey rather
    // than hidden or removed, so you can see exactly which parts of the city
    // went dark and roughly how far the shutdown reached.
    const dark = this.city.upkeep?.isDark(tower)
    const base = dark ? this._darkShade(tower.baseColor) : tower.baseColor
    for (let f = 0; f < tower.floorInstances.length; f++) {
      Tower.shadeForFloor(base, f, n, this._shade)
      mesh.setColorAt(tower.floorInstances[f], this._shade)
    }
    // The roof caps the stack, so it matches the highest block UNDER it - index
    // numFloors - 1, not numFloors. ROOF_SHADE_BIAS then compensates for the roof mesh catching more
    // light than the wall's side faces.
    Tower.roofShade(tower, base, this._shade)
    mesh.setColorAt(tower.roofInstance, this._shade)
  }

  /** Unpowered tint: most of the colour drained out, most of the light with it. */
  _darkShade(color) {
    if (!this._dark) this._dark = new Color()
    this._dark.copy(color)
    const grey = this._dark.r * 0.3 + this._dark.g * 0.6 + this._dark.b * 0.1
    return this._dark.setRGB(grey, grey, grey).multiplyScalar(0.45)
  }

  /**
   * Point a tower's instances at the geometries for its current typeTop and
   * colour it by type (path/adj generators -> accent, turret -> grey + laser
   * colour, grey -> base/top). Shared by reroll and palette placement.
   */
  applyTypeVisuals(tower) {
    const city = this.city
    const mesh = city.towerMesh
    const g = roofGeomIndex(tower.typeTop) // rendered top geometry (role != geom)
    tower.typeBottom = BlockGeometry.topToBottom.get(g)

    for (const idx of tower.floorInstances) mesh.setGeometryIdAt(idx, city.geomIds[tower.typeBottom])
    mesh.setGeometryIdAt(tower.roofInstance, city.geomIds[g])

    if (tower.king) {
      // The king wears one of the three light city accents, picked in placeKing.
      const accent = city.accentColors[tower.colorIndex] || KING_COLOR
      tower.isLit = false
      tower.litColor = null
      tower.baseColor = accent.clone()
      tower.topColor = accent.clone().multiplyScalar(Tower.ROOF_SHADE_BIAS)
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, tower.baseColor)
      mesh.setColorAt(tower.roofInstance, tower.topColor)
      return
    }

    if (isBarracks(tower)) {
      // Barracks wear turret grey - the rooftop soldier is what identifies them.
      tower.isLit = false
      tower.litColor = null
      tower.laserColor = null
      tower.baseColor = this.turretColor
      tower.topColor = this.turretColor
      this.shadeStack(tower)
      return
    }

    if (isShield(tower)) {
      // Shields wear the dedicated shield red, same as their barrier ring -
      // a hazard colour, deliberately outside the three building accents.
      const accent = new Color(SHIELD_LINE)
      tower.isLit = false
      tower.litColor = null
      tower.laserColor = null
      tower.baseColor = accent.clone()
      tower.topColor = accent.clone()
      this.shadeStack(tower)
      return
    }

    tower.isLit = tower.typeTop === TopType.PATH_GENERATOR
    if (isGenerator(tower)) {
      // Generators always use their fixed accent colour — no per-instance colour variation.
      tower.colorIndex = genColorIndex(tower.typeTop) ?? 0
      const accent = city.accentColors[tower.colorIndex]
      tower.litColor = accent.clone()
      tower.baseColor = accent.clone()
      tower.topColor = accent.clone()
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, accent)
      mesh.setColorAt(tower.roofInstance, this._shade.copy(accent).multiplyScalar(Tower.ROOF_SHADE_BIAS))
    } else {
      tower.litColor = null
      if (isTurret(tower)) {
        this.colorTurretTower(tower)
      } else {
        tower.laserColor = null
        tower.baseColor = Tower.BASE_COLOR
        tower.topColor = Tower.COLORS[tower.topColorIndex]
      }
      this.shadeStack(tower)
    }
  }

  /**
   * Deal `dmg` to a tower: knock it down one floor once the damage on its top
   * block covers BLOCK_HP. Taking the LAST block destroys the tile outright -
   * there is no roof-only level 0 to sit at, so a tower is either standing with
   * at least one floor or gone. Returns the new floor count; destroyed tiles
   * free their cells and vanish (no empty slots).
   */
  damageTower(tower, dmg = 1) {
    const city = this.city
    if (!tower || !tower.visible) return 0

    // Every blow rattles the tile AND flashes it white, whether or not it takes
    // a floor with it - a hit that only bites into the block's health is still a
    // hit landing, and it is the one case with no other visual tell at all.
    // The king flashes longer; Creeps kicks that one itself.
    this.shakeTower(tower)
    if (!tower.king) city.flashTower(tower)

    // Two things raise a block's hit points, and neither hands the tower extra
    // floors - so a tower never keeps phantom health after a buff is
    // recalculated. Reinforced walls thicken GREY blocks; a shield ring hardens
    // the BUILDINGS standing in it (+1 a block per ring, stacking where two
    // overlap, walls excluded). Damage carries over between floors: overkill on
    // the last block of a level is spent on the next one rather than thrown
    // away.
    const blockHp = BLOCK_HP + (isGrey(tower) ? Buffs.wallHits : 0)
      + city.energy.shieldCoverCount(tower)
    tower.dmg = (tower.dmg || 0) + dmg
    if (tower.dmg < blockHp) {
      Sounds.play('dink', 1.6, 0.1, 0.35)
      return tower.numFloors
    }
    tower.dmg -= blockHp
    city.mana?.econ?.blockLost()

    const center = tower.box.getCenter(city.towerCenter)
    const y = Math.max(0.5, tower.numFloors - 0.5) * city.floorHeight
    const color = tower.litColor || tower.baseColor
    city.debris.spawn(center.x + city.gridOffsetX, y, center.y + city.gridOffsetZ, 0.8, color, 10)
    if (!tower.king) Sounds.play('break2', 1.0, 0.2)

    if (tower.numFloors > 1) {
      tower.numFloors -= 1
      city.onTowerChanged(tower)
      if (tower.king) {
        // Every block the king loses is its own hit, pitched up as its health
        // goes so the last one sounds frantic. This replaces the generic break
        // thunk, which is suppressed for the king above.
        const hurt = 1 - tower.numFloors / KING_HEALTH // 0 fresh .. 1 dead
        Sounds.play('king-block-lost', 0.92 + hurt * 0.5, 0.03, 0.6 + hurt * 0.3)
        // The low-health siren is a STATE, not an event: City.updateKingAlarm
        // keeps it looping for as long as the king is down here, so there is
        // nothing to fire on the crossing.
      }
      return tower.numFloors
    }
    // That was the last block: the tile goes, whatever it is - wall, generator,
    // turret or king. Losing the king's last block IS the loss, so the game-over
    // hook fires here rather than at some roof-only state below it.
    if (tower.king) city.triggerGameOver()
    // Free its cell(s) and remove it (debris already spawned above).
    city.demolishTower(tower)
    return 0
  }

  /** Rattle a tile that just took a hit, settling back to its resting pose. */
  shakeTower(tower) {
    const city = this.city
    tower.shakeHit(city.towerMesh, city.floorHeight, HIT_SHAKE, HIT_SHAKE_TIME,
      () => city.updateTowerMatrices(tower))
  }

  /** Count turret towers in a tower's lot, excluding itself. */
  countLotTurrets(tower) {
    const lot = this.city.lots?.[tower.lotY]?.[tower.lotX]
    if (!lot) return 0
    let n = 0
    for (const t of lot.towers) {
      if (t !== tower && isTurret(t)) n++
    }
    return n
  }
}
