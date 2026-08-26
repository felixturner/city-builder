import { MathUtils, Vector2 } from 'three/webgpu'
import FastSimplexNoise from '@webvoxel/fast-simplex-noise'
import { Tower } from '../Tower.js'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TopType, roofGeomIndex } from '../blockTypes.js'

/**
 * CityGenerator - procedural generation of a lot's towers and their heights.
 * Fills lots with random block footprints/types, assigns one path generator per
 * lot, and computes procedural heights from city noise + a skewed random factor
 * attenuated by distance from the centre. Reads the tunable params off City
 * (noiseFrequency, heightNoiseScale, ...).
 */
export class CityGenerator {
  constructor(city) {
    this.city = city
    this._size = new Vector2()
  }

  /** Fill a lot rect [start..end] with random tower footprints/types. */
  fillLot(startX, startY, endX, endY, density = 1) {
    const city = this.city
    const cell = city.cellUnit
    const width = (endX - startX) / cell
    const height = (endY - startY) / cell

    const occupied = Array.from({ length: width }, () => Array(height).fill(-1))
    const maxBlockSize = new Vector2()
    maxBlockSize.x = MathUtils.randInt(1, 3)
    maxBlockSize.y = maxBlockSize.x

    const squareChance = 0.5
    let px = 0, py = 0
    let turretCount = 0 // cap turrets per lot

    while (py < height) {
      while (px < width) {
        let maxW = 0
        const end = Math.min(width, px + maxBlockSize.x)
        for (let i = px; i < end; i++) {
          if (occupied[i][py] != -1) break
          maxW++
        }
        if (maxW < 1) { px++; continue }

        const tower = new Tower()
        const isSquare = MathUtils.randFloat(0, 1) < squareChance
        const sx = MathUtils.randInt(1, maxW)
        const sy = isSquare ? sx : MathUtils.randInt(1, Math.min(maxBlockSize.y, height - py))
        // Skip towers that extend outside the lot (creates empty areas).
        if (px + sx > width || py + sy > height) { px++; continue }

        // Top type (rect tops only, no quart): turrets only on 1x1, holes on any
        // square. Path generators (plus) are assigned per lot in assignLotPlus.
        const is1x1 = sx === 1 && sy === 1
        let tt = TopType.SQUARE
        if (isSquare) {
          const pool = is1x1
            ? [TopType.SQUARE, TopType.PEG_TURRET, TopType.DIVOT_TURRET]
            : [TopType.SQUARE]
          tt = pool[MathUtils.randInt(0, pool.length - 1)]
          if (tt === TopType.PEG_TURRET || tt === TopType.DIVOT_TURRET) {
            if (turretCount >= 2) tt = TopType.SQUARE // extra turrets -> plain
            else turretCount++
          }
        }
        tower.typeTop = tt
        tower.typeBottom = BlockGeometry.topToBottom.get(roofGeomIndex(tower.typeTop))
        tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))

        // Sparse lots: some slots start hidden until the player builds them.
        tower.empty = MathUtils.randFloat(0, 1) > density

        const globalX = startX + px * cell
        const globalY = startY + py * cell
        const worldW = sx * cell
        const worldH = sy * cell
        tower.box.min.set(globalX, globalY)
        tower.box.max.set(globalX + worldW, globalY + worldH)

        tower.cityNoiseVal = city.cityNoise.scaled2D(globalX + worldW / 2, globalY + worldH / 2)
        tower.randFactor = MathUtils.randFloat(0, 1)
        tower.skipFactor = MathUtils.randFloat(0, 1)
        tower.rotation = isSquare
          ? (MathUtils.randInt(0, 4) * Math.PI) / 2
          : MathUtils.randInt(0, 2) * Math.PI
        tower.colorIndex = MathUtils.randInt(0, 2)

        city.towers.push(tower)

        const localEndX = Math.min(width, px + sx)
        const localEndY = Math.min(height, py + sy)
        for (let i = px; i < localEndX; i++) {
          for (let j = py; j < localEndY; j++) occupied[i][j] = tower.id
        }
        px += sx
      }
      py++
      px = 0
      // Occasionally vary the max block size within the lot.
      if (MathUtils.randFloat(0, 1) > 0.8) {
        maxBlockSize.x = MathUtils.randFloat(0, 1) > 0.5 ? 1 : 3
        maxBlockSize.y = MathUtils.randFloat(0, 1) > 0.5 ? 1 : 3
      }
    }
  }

  /** Turn one present square tower in a lot into its path generator (plus block). */
  assignLotPlus(firstTower) {
    const squares = this.city.towers.slice(firstTower).filter(t => {
      if (t.empty) return false
      t.box.getSize(this._size)
      return this._size.x === this._size.y
    })
    if (squares.length === 0) return
    const plus = squares[MathUtils.randInt(0, squares.length - 1)]
    plus.typeTop = TopType.PATH_GENERATOR
    plus.typeBottom = BlockGeometry.topToBottom.get(TopType.PATH_GENERATOR)
  }

  /**
   * Game-start heights: the central lot gets procedural random heights, every
   * other lot starts flat. The intro animation reads numFloors as the target.
   */
  finalizeGrid() {
    const city = this.city
    for (const tower of city.towers) {
      const isCenterLot = tower.lotX === city.centerLotX && tower.lotY === city.centerLotZ
      tower.numFloors = isCenterLot ? this.floorsForTower(tower) : 0
    }
    city.updateMatrices()
  }

  /**
   * Procedural floor count for a tower from city noise + a skewed random factor,
   * attenuated by distance from the city centre. Pure (doesn't mutate).
   */
  floorsForTower(tower) {
    const city = this.city
    const gridCenterX = city.actualGridWidth / 2
    const gridCenterY = city.actualGridHeight / 2
    const center = tower.box.getCenter(this._size)

    const dx = Math.abs(center.x - gridCenterX)
    const dy = Math.abs(center.y - gridCenterY)
    const normalizedDist = Math.max(dx / gridCenterX, dy / gridCenterY)
    const distFactor = 1 - Math.pow(normalizedDist, 2) * city.centerFalloff

    const adjustedNoise = Math.max(0, tower.cityNoiseVal - city.noiseSubtract)
    const noiseHeight = Math.pow(adjustedNoise, 3) * city.heightNoiseScale
    const randHeight = Math.pow(tower.randFactor, city.randHeightPower) * city.randHeightAmount
    const height = (noiseHeight + randHeight) * distFactor
    return Math.floor(height / city.floorHeight)
  }

  /** Recompute every tower's procedural height (GUI sliders). */
  recalculateHeights() {
    for (const tower of this.city.towers) tower.numFloors = this.floorsForTower(tower)
    this.city.updateMatrices()
  }

  /** Rebuild the noise field (new frequency) and reapply heights. */
  recalculateNoise() {
    const city = this.city
    city.cityNoise = new FastSimplexNoise({
      frequency: city.noiseFrequency, octaves: 3, min: 0, max: 1, persistence: 0.6,
    })
    for (const tower of city.towers) {
      const center = tower.box.getCenter(this._size)
      tower.cityNoiseVal = city.cityNoise.scaled2D(center.x, center.y)
    }
    this.recalculateHeights()
  }
}
