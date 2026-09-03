import { Sounds } from '../lib/Sounds.js'
import { HighScores } from '../HighScores.js'
import { ENERGY_COLOR } from '../palette.js'

/**
 * Every screen and button the player touches outside the board: the pause and
 * fast-forward chips, the game-over panel, and the menu behind it.
 *
 * All DOM, and none of it simulation - it reads Demo's state and calls Demo's
 * methods, and nothing in the game loop reads anything from here. It came out of
 * Demo.js, where two hundred lines of element styling sat between the fixed
 * timestep and the boss-round sequencing, so the file could not be skimmed for
 * either.
 *
 * The elements it owns stay here (`pauseButton`, `fastForwardButton`,
 * `menuEl`); everything else is reached through `this.demo`.
 */
export class DemoUI {
  constructor(demo) {
    this.demo = demo
    this.pauseButton = null
    this.fastForwardButton = null
    this.menuEl = null
  }

  /** Build the on-screen chips. Called once, after the DOM exists. */
  build() {
    this._buildPauseButton()
    this._buildFastForwardButton()
  }

  /** Floating play/pause button at the bottom-center of the screen. */
  _buildPauseButton() {
    this.demo.paused = false
    const btn = document.createElement('button')
    btn.id = 'pause-toggle'
    btn.textContent = '⏸ Pause'
    Object.assign(btn.style, {
      position: 'fixed',
      top: '9px',
      right: 'calc(50% + 17vw + 10px)', // just left of the 34vw centered timeline
      zIndex: '600',
      padding: '5px 12px',
      font: '600 13px Inter, system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(20,20,28,0.8)',
      border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '999px',
      cursor: 'pointer',
      backdropFilter: 'blur(4px)',
    })
    // Opens (or closes) the same pause menu Esc does, rather than silently
    // freezing the game - the menu IS the paused state.
    btn.addEventListener('click', () => this.toggleMenu())
    document.body.appendChild(btn)
    this.pauseButton = btn
  }

  /** Freeze the game and show the score panel. */
  showGameOver() {
    if (this.demo.isGameOver) return
    this.demo.isGameOver = true
    // The run is over: write it out. A recording is only worth having if it
    // survives the tab, and the interesting runs are the ones that end.
    if (this.demo.run) this.demo.run.endedBy = 'gameover'
    this.demo.run?.save()
    // Now that everything really has stopped, take the wave audio down with it.
    Sounds.stop('tick-fast')
    Sounds.fadeOut('horn-boss', 0.5)
    Sounds.stopBeds(1.2)

    const el = document.createElement('div')
    el.id = 'game-over'
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2000',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '28px',
      // A light scrim: the city you just lost stays visible behind the text,
      // dimmed just enough to lift the labels off it.
      background: 'rgba(0,0,0,0.15)',
      pointerEvents: 'none',
    })
    const title = document.createElement('div')
    title.textContent = 'GAME OVER'
    Object.assign(title.style, {
      color: ENERGY_COLOR, font: '600 72px Inter, system-ui, sans-serif',
      letterSpacing: '2px', textShadow: TEXT_SHADOW,
    })

    // Final score + persisted high score (localStorage).
    const final = Math.floor(this.demo.mana?.elapsed || 0)
    let best = 0
    try { best = parseInt(localStorage.getItem('cityBuilderHighScore') || '0', 10) || 0 } catch (e) { /* storage blocked */ }
    const isBest = final > best
    if (isBest) { best = final; try { localStorage.setItem('cityBuilderHighScore', String(best)) } catch (e) { /* storage blocked */ } }

    const stats = document.createElement('div')
    Object.assign(stats.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
    })
    const scoreEl = document.createElement('div')
    scoreEl.textContent = `score: ${final}`
    Object.assign(scoreEl.style, {
      color: '#fff', font: '700 30px Inter, system-ui, sans-serif', textShadow: TEXT_SHADOW,
    })
    const bestEl = document.createElement('div')
    bestEl.textContent = isBest ? `★ new best ★` : `best: ${best}`
    Object.assign(bestEl.style, {
      color: isBest ? ENERGY_COLOR : '#dfdfdf', font: '600 20px Inter, system-ui, sans-serif',
      textShadow: TEXT_SHADOW,
    })
    stats.appendChild(scoreEl)
    stats.appendChild(bestEl)

    const btn = document.createElement('button')
    btn.textContent = 'Restart'
    btn.className = 'menu-btn' // the one shared menu-button style (index.html)
    btn.addEventListener('click', () => location.reload())
    el.appendChild(title)
    el.appendChild(stats)
    // Shared leaderboard between the stats and the button. Fills in async;
    // adds nothing at all when the API is unreachable (e.g. local dev).
    const board = document.createElement('div')
    el.appendChild(board)
    new HighScores().buildInto(board, final)
    el.appendChild(btn)
    document.body.appendChild(el)
  }

  /**
   * Esc pause menu - same shape as the game-over panel: big title, score +
   * best underneath, buttons at the bottom. Esc toggles it; opening pauses the
   * game, Resume unpauses, New game reloads.
   */
  toggleMenu() {
    if (!this.demo.started || this.demo.isGameOver || this.demo.kingDead) return
    if (this.demo.powerUps?.open) return // the card screen owns the freeze
    if (this.demo.tilePalette?.drag) return // Esc there cancels the held tile instead
    if (this.menuEl) this._hideMenu()
    else this._showMenu()
  }

  _showMenu() {
    this.demo.paused = true
    this.demo.setPauseAudio(true)
    if (this.pauseButton) this.pauseButton.textContent = '▶ Play'

    const el = document.createElement('div')
    el.id = 'game-menu'
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2000',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '28px',
      // Same as the game-over panel: a light scrim to lift the text off the
      // city without hiding it.
      background: 'rgba(0,0,0,0.15)',
      pointerEvents: 'none',
    })
    const title = document.createElement('div')
    title.textContent = 'PAUSED'
    Object.assign(title.style, {
      color: ENERGY_COLOR, font: '600 72px Inter, system-ui, sans-serif',
      letterSpacing: '2px', textShadow: TEXT_SHADOW,
    })

    const score = Math.floor(this.demo.mana?.elapsed || 0)
    let best = 0
    try { best = parseInt(localStorage.getItem('cityBuilderHighScore') || '0', 10) || 0 } catch (e) { /* storage blocked */ }

    const stats = document.createElement('div')
    Object.assign(stats.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
    })
    const scoreEl = document.createElement('div')
    scoreEl.textContent = `score: ${score}`
    Object.assign(scoreEl.style, {
      color: '#fff', font: '700 30px Inter, system-ui, sans-serif', textShadow: TEXT_SHADOW,
    })
    const bestEl = document.createElement('div')
    bestEl.textContent = `best: ${Math.max(best, score)}`
    Object.assign(bestEl.style, {
      color: '#dfdfdf', font: '600 20px Inter, system-ui, sans-serif', textShadow: TEXT_SHADOW,
    })
    stats.appendChild(scoreEl)
    stats.appendChild(bestEl)

    const buttons = document.createElement('div')
    Object.assign(buttons.style, { display: 'flex', flexDirection: 'column', gap: '16px' })
    // All four wear the one shared .menu-btn style (index.html), same as every
    // other menu screen.
    const resume = document.createElement('button')
    resume.textContent = 'Resume game'
    resume.className = 'menu-btn'
    resume.addEventListener('click', () => this._hideMenu())
    const restart = document.createElement('button')
    restart.textContent = 'New game'
    restart.className = 'menu-btn'
    // ?play skips the start menu after the reload, straight into the new run.
    restart.addEventListener('click', () => {
      const url = new URL(location.href)
      url.searchParams.set('play', '1')
      location.replace(url)
    })
    const tute = document.createElement('button')
    tute.textContent = 'Tutorial'
    tute.className = 'menu-btn'
    // The slideshow opens over this menu (higher z-index); its last click just
    // closes it again and lands back here, still paused.
    tute.addEventListener('click', () => this.demo.tutorial?.show(() => {}))
    const board = document.createElement('button')
    board.textContent = 'View leaderboard'
    board.className = 'menu-btn'
    board.addEventListener('click', () => new HighScores().showBoard())
    buttons.appendChild(resume)
    buttons.appendChild(restart)
    buttons.appendChild(tute)
    buttons.appendChild(board)

    el.appendChild(title)
    el.appendChild(stats)
    el.appendChild(buttons)
    document.body.appendChild(el)
    this.menuEl = el
  }

  _hideMenu() {
    if (!this.menuEl) return
    document.body.removeChild(this.menuEl)
    this.menuEl = null
    this.demo.paused = false
    this.demo.setPauseAudio(false)
    if (this.pauseButton) this.pauseButton.textContent = '⏸ Pause'
  }

  /** Fast-forward button (right of the creep timeline): advance the wave clock 20s. */
  _buildFastForwardButton() {
    const btn = document.createElement('button')
    btn.id = 'fast-forward'
    btn.textContent = '⏩ +20s'
    Object.assign(btn.style, {
      position: 'fixed',
      top: '9px',
      left: 'calc(50% + 17vw + 10px)', // just right of the 34vw centered timeline
      zIndex: '600',
      padding: '5px 12px',
      font: '600 13px Inter, system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(20,20,28,0.8)',
      border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '999px',
      cursor: 'pointer',
      backdropFilter: 'blur(4px)',
    })
    btn.addEventListener('click', () => this.demo.skipAhead())
    this.fastForwardButton = btn
    document.body.appendChild(btn)
  }
}
