import { Sounds } from './lib/Sounds.js'
import { ENERGY_COLOR, AMMO_COLOR } from './palette.js'
import { Buffs } from './buffs.js'

// Set false to remove the energy cap (energy is balanced by spend, not a ceiling).
const CAP_ENABLED = true

// Score blips every N seconds survived. Every second would be a metronome; 10s
// makes the score feel like it's ticking over without nagging.
const SCORE_BLIP_EVERY = 10

// Resource colours come from the shared three-accent palette; re-exported here
// because most callers already import them from Mana.
export { ENERGY_COLOR, AMMO_COLOR } from './palette.js'

/**
 * Mana - resource HUD (top-left): two metered resources plus the score.
 *   energy: current / max  (max = baseMax + population)  - spent on building
 *   ammo:   current / max                                - spent by turrets
 *   score:  whole seconds survived (ticks up during play, freezes on game over)
 *   level:  wave number, 1-based (Creeps.waveNumber + 1)
 *
 * Each resource gets a progress bar directly above its readout. Grey blocks
 * generate energy and raise its cap (City calls setStats); ammo comes only from
 * boxes dropped by dying creeps, so sustained fire depends on killing things.
 */
export class Mana {
  constructor(baseMax = 100, initial = 100, ammoMax = 50, ammoInitial = 30) {
    this.baseMax = baseMax
    this.population = 0
    this.max = baseMax
    this.current = Math.min(initial, this.max)
    this.ammoMax = ammoMax
    // Ammo is fractional under the hood (a peg shot costs a quarter) but only
    // ever displayed rounded down - see render().
    this.ammo = Math.min(ammoInitial, ammoMax)
    this.elapsed = 0 // survival time = score
    this.level = 1 // 1-based wave number, pushed in by Demo each frame
    this._build()
    this.render()
  }

  _build() {
    const el = document.createElement('div')
    el.id = 'mana-meter'
    Object.assign(el.style, {
      position: 'fixed',
      left: '20px',
      top: '20px',
      zIndex: '500',
      pointerEvents: 'none',
      font: '600 13px Inter, system-ui, sans-serif', // matches the pause / fast-forward chips
      color: '#fff',
      textShadow: '0 1px 3px rgba(0,0,0,0.7)',
      lineHeight: '1.5',
      whiteSpace: 'pre',
      minWidth: '172px',
    })

    const bar = (color) => {
      const track = document.createElement('div')
      Object.assign(track.style, {
        width: '100%', height: '7px', marginBottom: '3px',
        background: 'rgba(255,255,255,0.10)',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: '4px', overflow: 'hidden',
      })
      const fill = document.createElement('div')
      Object.assign(fill.style, {
        width: '0%', height: '100%', background: color,
        boxShadow: `0 0 6px ${color}`,
        transition: 'width 0.18s linear',
      })
      track.appendChild(fill)
      return { track, fill }
    }

    const e = bar(ENERGY_COLOR)
    const a = bar(AMMO_COLOR)
    this.energyFill = e.fill
    this.ammoFill = a.fill
    this.energyBar = e.track // ResourceFly aims income boxes at these
    this.ammoBar = a.track

    this.energyEl = document.createElement('div')
    this.ammoEl = document.createElement('div')
    this.scoreEl = document.createElement('div')
    this.levelEl = document.createElement('div')
    this.energyEl.style.color = ENERGY_COLOR
    this.ammoEl.style.color = AMMO_COLOR

    // Each bar sits directly above the number it describes.
    el.appendChild(e.track)
    el.appendChild(this.energyEl)
    el.appendChild(a.track)
    el.appendChild(this.ammoEl)
    el.appendChild(this.scoreEl)
    el.appendChild(this.levelEl)

    document.body.appendChild(el)
    this.el = el
    this.layout()
    window.addEventListener('resize', () => this.layout())
  }

  /**
   * Keep the meters clear of the incoming-wave strip.
   *
   * The strip is centred and 34vw wide, so on a narrow screen its left edge
   * reaches back over the meters in the top-left corner. When that happens the
   * meters drop below it rather than overlapping.
   */
  layout() {
    const strip = document.getElementById('creep-timeline')
    if (!strip) return
    const r = strip.getBoundingClientRect()
    const overlaps = r.left < 20 + this.el.offsetWidth + 12
    this.el.style.top = overlaps ? `${r.bottom + 12}px` : '20px'
  }

  render() {
    const ammoCap = this.ammoMax + Buffs.ammoMax
    this.energyEl.textContent = `energy: ${Math.floor(this.current)} /${this.max}`
    this.ammoEl.textContent = `ammo:   ${Math.floor(this.ammo)} /${ammoCap}`
    this.scoreEl.textContent = `score:  ${Math.floor(this.elapsed)}`
    this.levelEl.textContent = `level:  ${this.level}`
    const pct = (v, m) => `${Math.max(0, Math.min(100, (v / m) * 100))}%`
    this.energyFill.style.width = pct(this.current, this.max)
    this.ammoFill.style.width = pct(this.ammo, ammoCap)
  }

  /** Set the displayed level (1-based wave). No-op when unchanged. */
  setLevel(level) {
    if (level === this.level) return
    this.level = level
    this.render()
  }

  /** Advance the survival-time score. Called each frame while the game runs. */
  tick(dt) {
    const before = this.elapsed
    this.elapsed += dt
    // Soft blip each time the score crosses another SCORE_BLIP_EVERY seconds.
    if (Math.floor(this.elapsed / SCORE_BLIP_EVERY) > Math.floor(before / SCORE_BLIP_EVERY)) {
      Sounds.play('score-up')
    }
    this.render()
  }

  /** Update grey-block-derived stats: population sets the energy cap. */
  setStats(population) {
    this.population = population
    this.max = this.baseMax + population + Buffs.energyMax
    if (CAP_ENABLED && this.current > this.max) this.current = this.max
    this.render()
  }

  /** Spend energy. Returns true if there was enough, false otherwise.
   *  `silent` skips the HUD blip for spends that have their own feedback. */
  spend(amount = 1, silent = false) {
    if (this.current < amount) return false
    this.current -= amount
    // Player-driven spends are discrete, so this one isn't rate-limited.
    if (!silent) Sounds.play('energy-down')
    this.render()
    return true
  }

  /** Add energy, capped at max. */
  add(amount = 1) {
    const before = this.current
    const wasFull = CAP_ENABLED && before >= this.max
    this.current = CAP_ENABLED ? Math.min(this.max, before + amount) : before + amount
    const gained = this.current - before
    // Sitting at the cap, income arrives but nothing is gained - stay quiet
    // rather than blipping on every tick for energy you're actually wasting.
    if (gained > 0) {
      // Hitting the ceiling is the interesting moment, so it gets its own
      // brighter blip and the ordinary gain blip stands down.
      if (CAP_ENABLED && !wasFull && this.current >= this.max) Sounds.play('energy-full')
      else Sounds.play('energy-up') // throttled in Sounds.js
    }
    this.render()
  }

  // -- Ammo -------------------------------------------------------------------

  /** Spend ammo. Silent: turrets fire several times a second and the gunfire is
   *  the feedback. Returns false when there isn't enough. */
  spendAmmo(amount = 1) {
    if (this.ammo < amount) return false
    this.ammo -= amount
    this.render()
    return true
  }

  /** Collect an ammo box. */
  addAmmo(amount = 5) {
    this.ammo = Math.min(this.ammoMax + Buffs.ammoMax, this.ammo + amount)
    this.render()
  }
}
