import { ENERGY_COLOR } from './palette.js'

/**
 * HighScores - client of the shared top-20 table served by the Pages Function
 * at /api/scores (see functions/api/scores.js).
 *
 * The whole feature degrades to nothing when the API is unreachable - the dev
 * server has no Pages Functions, and the game-over screen is complete without
 * a leaderboard - so every network failure just renders nothing.
 */

const SHADOW = '0 2px 4px rgba(0,0,0,0.95), 0 0 22px rgba(0,0,0,0.9)'
const NAME_KEY = 'cityBuilderName'
const SHOW = 10

export class HighScores {
  async fetchTop() {
    try {
      const r = await fetch('/api/scores')
      if (!r.ok) return null
      return (await r.json()).scores
    } catch (e) { return null }
  }

  async submit(name, score) {
    try {
      const r = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, score }),
      })
      if (!r.ok) return null
      return (await r.json()).scores
    } catch (e) { return null }
  }

  /**
   * Mount the leaderboard block into the game-over panel: a name + submit row,
   * then the top-10 list. Appends nothing until the first fetch succeeds, so an
   * unreachable API leaves the panel exactly as it was.
   */
  async buildInto(container, finalScore) {
    const scores = await this.fetchTop()
    if (!scores) return

    const wrap = document.createElement('div')
    Object.assign(wrap.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
      pointerEvents: 'auto',
    })

    // Name + submit row.
    const form = document.createElement('div')
    Object.assign(form.style, { display: 'flex', gap: '8px' })
    const input = document.createElement('input')
    input.maxLength = 16
    input.placeholder = 'your name'
    try { input.value = localStorage.getItem(NAME_KEY) || '' } catch (e) { /* storage blocked */ }
    Object.assign(input.style, {
      padding: '8px 14px', font: '600 15px Inter, system-ui, sans-serif',
      color: '#fff', background: 'rgba(0,0,0,0.35)', border: '2px solid #fff',
      borderRadius: '18px', outline: 'none', width: '150px', textAlign: 'center',
    })
    const btn = document.createElement('button')
    btn.textContent = 'Submit score'
    Object.assign(btn.style, {
      padding: '8px 18px', font: '600 15px Inter, system-ui, sans-serif', color: '#fff',
      background: 'rgba(0,0,0,0.35)', border: '2px solid #fff', borderRadius: '18px',
      cursor: 'pointer', textShadow: SHADOW,
    })
    btn.addEventListener('click', async () => {
      const name = input.value.trim()
      if (!name) { input.focus(); return }
      try { localStorage.setItem(NAME_KEY, name) } catch (e) { /* storage blocked */ }
      btn.disabled = true
      btn.textContent = '...'
      const updated = await this.submit(name, finalScore)
      form.style.display = 'none'
      if (updated) this._renderList(list, updated, name, finalScore)
    })
    form.appendChild(input)
    form.appendChild(btn)

    const list = document.createElement('div')
    Object.assign(list.style, {
      display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '280px',
    })
    this._renderList(list, scores)

    wrap.appendChild(form)
    wrap.appendChild(list)
    container.appendChild(wrap)
  }

  /**
   * Fullscreen leaderboard overlay for the menus: title, top 20, Close.
   * Sits above every menu (they stay put underneath and are back on close).
   */
  async showBoard() {
    const scores = await this.fetchTop()
    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2700',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '24px', background: 'rgba(0,0,0,0.55)',
    })
    const title = document.createElement('div')
    title.textContent = 'LEADERBOARD'
    Object.assign(title.style, {
      color: ENERGY_COLOR, font: '600 48px Inter, system-ui, sans-serif',
      letterSpacing: '2px', textShadow: SHADOW,
    })
    const list = document.createElement('div')
    Object.assign(list.style, {
      display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '280px',
    })
    if (scores && scores.length) this._renderList(list, scores, null, null, scores.length)
    else {
      const empty = document.createElement('div')
      empty.textContent = scores ? 'no scores yet' : 'leaderboard unavailable'
      Object.assign(empty.style, {
        color: '#dfdfdf', font: '500 16px Inter, system-ui, sans-serif',
        textAlign: 'center', textShadow: SHADOW,
      })
      list.appendChild(empty)
    }
    const close = document.createElement('button')
    close.textContent = 'Close'
    close.className = 'menu-btn' // the one shared menu-button style (index.html)
    close.addEventListener('click', () => document.body.removeChild(el))
    el.appendChild(title)
    el.appendChild(list)
    el.appendChild(close)
    document.body.appendChild(el)
  }

  _renderList(list, scores, ownName = null, ownScore = null, show = SHOW) {
    list.innerHTML = ''
    scores.slice(0, show).forEach((s, i) => {
      const row = document.createElement('div')
      // Highlight the entry the player just posted (first matching row).
      const mine = ownName !== null && s.name === ownName && s.score === ownScore
      if (mine) { ownName = null }
      Object.assign(row.style, {
        display: 'flex', justifyContent: 'space-between', gap: '24px',
        color: mine ? ENERGY_COLOR : '#fff',
        font: `${mine ? 700 : 500} 16px Inter, system-ui, sans-serif`,
        textShadow: SHADOW,
      })
      const name = document.createElement('span')
      name.textContent = `${i + 1}. ${s.name}`
      const score = document.createElement('span')
      score.textContent = s.score
      row.appendChild(name)
      row.appendChild(score)
      list.appendChild(row)
    })
  }
}
