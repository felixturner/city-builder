import { Mesh, RingGeometry, MeshBasicNodeMaterial, Vector2 } from 'three/webgpu'
import { isTurret, isPathGenerator } from '../blockTypes.js'

/**
 * A pool of flat ground rings (one per tower). Geometry is cached per radius
 * bucket and NEVER disposed; when a tower's radius changes the mesh is rebuilt
 * (swapping a live mesh's .geometry triggers a WebGPU setIndexBuffer crash).
 */
class RingLayer {
  constructor(scene, makeMaterial, radiusFor, { thickness = 0.12, y = 0.07 } = {}) {
    this.scene = scene
    this.makeMaterial = makeMaterial // () => material (one per mesh, reused)
    this.radiusFor = radiusFor // (numFloors) => world radius
    this.thickness = thickness
    this.y = y
    this.meshes = new Map() // tower -> Mesh
    this.geos = new Map() // numFloors -> RingGeometry
  }

  geoFor(numFloors) {
    let g = this.geos.get(numFloors)
    if (!g) {
      const r = this.radiusFor(numFloors)
      g = new RingGeometry(r - this.thickness / 2, r + this.thickness / 2, 64)
      this.geos.set(numFloors, g)
    }
    return g
  }

  /** Place/update a tower's ring at world (x,z); returns the mesh for tweaks. */
  place(tower, x, z) {
    const geo = this.geoFor(tower.numFloors)
    let m = this.meshes.get(tower)
    if (!m || m.geometry !== geo) {
      const mat = m ? m.material : this.makeMaterial()
      if (m) this.scene.remove(m)
      m = new Mesh(geo, mat)
      m.rotation.x = -Math.PI / 2
      m.renderOrder = -1
      this.scene.add(m)
      this.meshes.set(tower, m)
    }
    m.position.set(x, this.y, z)
    return m
  }

  hideUnseen(seen) {
    for (const [t, m] of this.meshes) if (!seen.has(t)) m.visible = false
  }
}

/**
 * RangeVisuals - ground rings showing zones of control (path generators) and
 * turret firing range, plus the turret-circle data for the coverage glow.
 */
export class RangeVisuals {
  constructor(city) {
    this.city = city
    this.showTurretRanges = false // turret rings hidden; the coverage glow shows range
    this._zc = new Vector2()

    this.zoc = new RingLayer(
      city.scene,
      () => new MeshBasicNodeMaterial({ transparent: true, opacity: 0.6, depthWrite: false }),
      // Link reach, in world units. Two path generators connect when the gap
      // between their centres is less than (a.numFloors + b.numFloors) CELLS -
      // one cell per floor - so a generator's own half of that is numFloors
      // cells. Drawn at exactly that, so two rings touching is precisely the
      // moment the link forms.
      (n) => n * city.cellUnit,
      { thickness: 0.15, y: 0.06 }
    )
    this.range = new RingLayer(
      city.scene,
      () => new MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }),
      (n) => (n * 2 + 1) * city.cellUnit,
      { thickness: 0.12, y: 0.07 }
    )
  }

  refresh() {
    this.updateZocCircles()
    this.updateTurretRanges()
  }

  /** One accent disc per path generator, sized to its zone of control. */
  updateZocCircles() {
    const city = this.city
    const seen = new Set()
    for (const t of city.towers) {
      if (!t.visible || !isPathGenerator(t) || t.numFloors < 1) continue
      seen.add(t)
      t.box.getCenter(this._zc)
      const m = this.zoc.place(t, this._zc.x + city.gridOffsetX, this._zc.y + city.gridOffsetZ)
      m.material.color.copy(city.accentColors[t.colorIndex])
      m.visible = true
    }
    this.zoc.hideUnseen(seen)
  }

  /** One ring per turret showing firing range ((numFloors + 1) cells). */
  updateTurretRanges() {
    const city = this.city
    const seen = new Set()
    for (const t of city.towers) {
      if (!t.visible || !isTurret(t)) continue
      seen.add(t)
      t.box.getCenter(this._zc)
      const m = this.range.place(t, this._zc.x + city.gridOffsetX, this._zc.y + city.gridOffsetZ)
      m.visible = this.showTurretRanges
    }
    this.range.hideUnseen(seen)
  }

  /** World centres + range radii of every visible turret (for the coverage glow). */
  getTurretCircles(out = []) {
    const city = this.city
    out.length = 0
    for (const t of city.towers) {
      if (!t.visible || !isTurret(t)) continue
      t.box.getCenter(this._zc)
      out.push({
        x: this._zc.x + city.gridOffsetX,
        z: this._zc.y + city.gridOffsetZ,
        r: (t.numFloors * 2 + 1) * city.cellUnit,
      })
    }
    return out
  }
}
