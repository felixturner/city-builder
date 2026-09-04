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
/** Row text: the game-over panel's list sits under a score and buttons and stays
 *  small; the full-screen board is the only thing on its screen, so it reads
 *  half again as big - until the screen is a phone in portrait, where the same
 *  fifteen rows have to fit between the title and Close. Hence the vw clamp
 *  rather than a second fixed size. */
const ROW_PX = '16px'
const BOARD_ROW_PX = 'clamp(14px, 4.4vw, 24px)'

/** Placeholder table, dev builds only. The dev server has no Pages Functions,
 *  so every fetch here fails and the board renders 'unavailable' - which is
 *  nothing to style against. Never served in a production build. */
const FAKE_SCORES = [
  { name: 'MAYOR_M', score: 2140 },
  { name: 'brickhead', score: 1985 },
  { name: 'Tessellator', score: 1802 },
  { name: 'felix', score: 1685 },
  { name: 'CRANE OPERATOR', score: 1540 },
  { name: 'zoning_board', score: 1477 },
  { name: 'hodpad', score: 1310 },
  { name: 'Vera', score: 1204 },
  { name: 'ninestorey', score: 1096 },
  { name: 'gridlock', score: 980 },
  { name: 'RC', score: 874 },
  { name: 'plaza', score: 812 },
  { name: 'burghermeister', score: 735 },
  { name: 'Nell', score: 690 },
  { name: 'scaffold', score: 611 },
]

export class HighScores {
  async fetchTop() {
    try {
      const r = await fetch('/api/scores')
      if (r.ok) return (await r.json()).scores
    } catch (e) { /* offline, or no Functions runtime */ }
    return import.meta.env.DEV ? FAKE_SCORES : null
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
   *
   * `hideEl` is the menu that opened it: the board REPLACES that screen rather
   * than stacking over it, and Close puts it back. Two full-screen panels in
   * the same place read as one broken one, and the pause menu's buttons showed
   * through the board's scrim.
   */
  async showBoard(hideEl = null) {
    const prevDisplay = hideEl ? hideEl.style.display : null
    if (hideEl) hideEl.style.display = 'none'
    const scores = await this.fetchTop()
    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2700',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      // Opaque: the board is a SCREEN, not an overlay - whatever menu it was
      // opened from stays hidden behind it rather than showing through.
      background: '#000',
      // Everything below is the phone case: a portrait handset has to hold the
      // title, fifteen rows and Close between the safe edges, so the gaps give
      // way before the text does, and the whole column scrolls if it still
      // cannot fit.
      gap: 'clamp(14px, 4vh, 40px)', padding: '24px 16px',
      boxSizing: 'border-box', overflowY: 'auto',
    })
    const title = document.createElement('div')
    title.textContent = 'LEADERBOARD'
    Object.assign(title.style, {
      // Same size and weight as the main menu's CITY BUILDER (#menu-title) on a
      // desktop; it shrinks with the viewport so LEADERBOARD stays on one line.
      color: ENERGY_COLOR, fontFamily: 'Inter, system-ui, sans-serif',
      fontWeight: '600', fontSize: 'clamp(30px, 9vw, 72px)',
      letterSpacing: '2px', textShadow: SHADOW, textAlign: 'center',
    })
    const list = document.createElement('div')
    Object.assign(list.style, {
      // As wide as LEADERBOARD renders at 72px, so the title and the table read
      // as one block - but never wider than the screen it is on.
      display: 'flex', flexDirection: 'column', gap: 'clamp(5px, 1.4vh, 14px)',
      width: 'min(520px, 100%)', padding: '12px 0',
    })
    if (scores && scores.length) this._renderList(list, scores, null, null, scores.length, BOARD_ROW_PX)
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
    close.addEventListener('click', () => {
      document.body.removeChild(el)
      if (hideEl) hideEl.style.display = prevDisplay
    })
    // Centred, except when the content is taller than the screen: 'safe center'
    // falls back to the top so a short phone scrolls to the title instead of
    // clipping it. Assigned after the block above so a browser that does not
    // know the keyword simply keeps plain 'center'.
    el.style.justifyContent = 'safe center'
    el.appendChild(title)
    el.appendChild(list)
    el.appendChild(close)
    document.body.appendChild(el)
  }

  _renderList(list, scores, ownName = null, ownScore = null, show = SHOW, px = ROW_PX) {
    list.innerHTML = ''
    scores.slice(0, show).forEach((s, i) => {
      const row = document.createElement('div')
      // Highlight the entry the player just posted (first matching row).
      const mine = ownName !== null && s.name === ownName && s.score === ownScore
      if (mine) { ownName = null }
      Object.assign(row.style, {
        display: 'flex', justifyContent: 'space-between', gap: '24px',
        color: mine ? ENERGY_COLOR : '#fff',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontWeight: mine ? '700' : '500', fontSize: px,
        textShadow: SHADOW,
      })
      const name = document.createElement('span')
      name.textContent = `${i + 1}. ${s.name}`
      // A long name gives way rather than pushing the score off a phone screen.
      Object.assign(name.style, {
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0',
      })
      const score = document.createElement('span')
      score.textContent = s.score
      row.appendChild(name)
      row.appendChild(score)
      list.appendChild(row)
    })
  }
}
