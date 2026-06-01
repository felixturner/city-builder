import { Sounds } from './lib/Sounds.js'

/**
 * Mana - vertical resource meter shown on the left of the screen.
 * A 1-wide column of cells that fill from the bottom up to show current mana.
 */
export class Mana {
  constructor(max = 50, initial = 20) {
    this.max = max
    this.current = initial
    this.color = '#1BB3F6' // blue block accent color
    this._build()
    this.render()
  }

  _build() {
    const el = document.createElement('div')
    el.id = 'mana-meter'
    Object.assign(el.style, {
      position: 'fixed',
      left: '20px',
      top: '50%',
      transform: 'translateY(-50%)',
      display: 'flex',
      flexDirection: 'column-reverse',
      gap: '2px',
      zIndex: '500',
      pointerEvents: 'none',
    })

    this.cells = []
    for (let i = 0; i < this.max; i++) {
      const cell = document.createElement('div')
      Object.assign(cell.style, {
        width: '20px',
        height: '10px',
        border: `1px solid ${this.color}`,
        borderRadius: '2px',
        transition: 'background 0.15s',
      })
      el.appendChild(cell)
      this.cells.push(cell)
    }

    document.body.appendChild(el)
    this.el = el
  }

  render() {
    for (let i = 0; i < this.max; i++) {
      this.cells[i].style.background = i < this.current ? this.color : 'transparent'
    }
  }

  /** Spend mana. Returns true if there was enough, false otherwise. */
  spend(amount = 1) {
    if (this.current < amount) return false
    this.current -= amount
    this.render()
    return true
  }

  /** Add mana, capped at max. Plays the mana-up sound even when already full. */
  add(amount = 1) {
    Sounds.play('pluck')
    this.current = Math.min(this.max, this.current + amount)
    this.render()
  }
}
