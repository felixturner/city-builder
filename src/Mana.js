import { Sounds } from './lib/Sounds.js'

/**
 * Mana - text HUD (top-left) showing two stats:
 *   energy:     current / max  (max = baseMax + population)
 *   population: total grey blocks (sum of grey tower heights)
 * Energy is spent on builds/lot-clicks; grey blocks generate it and raise the
 * cap. City calls setStats() whenever grey-block totals change.
 */
export class Mana {
  constructor(baseMax = 50, initial = 50) {
    this.baseMax = baseMax
    this.population = 0
    this.max = baseMax
    this.current = Math.min(initial, this.max)
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
      font: '600 16px ui-monospace, Menlo, monospace',
      color: '#fff',
      textShadow: '0 1px 3px rgba(0,0,0,0.7)',
      lineHeight: '1.5',
      whiteSpace: 'pre',
    })

    this.energyEl = document.createElement('div')
    this.popEl = document.createElement('div')
    el.appendChild(this.energyEl)
    el.appendChild(this.popEl)

    document.body.appendChild(el)
    this.el = el
  }

  render() {
    this.energyEl.textContent = `energy: ${Math.floor(this.current)} /${this.max}`
    this.popEl.textContent = `population: ${this.population}`
  }

  /** Update grey-block-derived stats: population sets the energy cap. */
  setStats(population) {
    this.population = population
    this.max = this.baseMax + population
    if (this.current > this.max) this.current = this.max
    this.render()
  }

  /** Spend energy. Returns true if there was enough, false otherwise. */
  spend(amount = 1) {
    if (this.current < amount) return false
    this.current -= amount
    this.render()
    return true
  }

  /** Add energy, capped at max. */
  add(amount = 1) {
    Sounds.play('pluck')
    this.current = Math.min(this.max, this.current + amount)
    this.render()
  }
}
