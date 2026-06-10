/**
 * CreepTimeline - a horizontal "incoming waves" strip across the top of the
 * screen (50% width). The LEFT edge is the current moment ("now"); time scrolls
 * leftward as the game advances. Red bars mark the creep wave-active windows for
 * the next `windowSeconds` (3 minutes) of gameplay, derived from the Creeps
 * wave schedule (graceTime + n*wavePeriod, each lasting waveActive seconds).
 */
export class CreepTimeline {
  constructor(creeps) {
    this.creeps = creeps
    this.windowSeconds = 180 // show the next 3 minutes
    this.bars = []
    this._build()
  }

  _build() {
    const wrap = document.createElement('div')
    wrap.id = 'creep-timeline'
    Object.assign(wrap.style, {
      position: 'fixed',
      top: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '50vw',
      height: '18px',
      zIndex: '500',
      pointerEvents: 'none',
    })

    // The scrolling track.
    const track = document.createElement('div')
    Object.assign(track.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      top: '4px',
      height: '10px',
      background: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '5px',
      overflow: 'hidden',
    })
    wrap.appendChild(track)

    // Minute tick labels (1m / 2m / 3m) for context.
    for (let m = 1; m <= 3; m++) {
      const tick = document.createElement('div')
      tick.textContent = `${m}m`
      Object.assign(tick.style, {
        position: 'absolute',
        left: `${(m / 3) * 100}%`,
        top: '0',
        transform: 'translateX(-50%)',
        font: '600 9px ui-monospace, Menlo, monospace',
        color: 'rgba(255,255,255,0.35)',
        pointerEvents: 'none',
      })
      track.appendChild(tick)
    }

    // "Now" marker pinned to the left edge.
    const now = document.createElement('div')
    Object.assign(now.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      bottom: '0',
      width: '2px',
      background: '#ffffff',
      boxShadow: '0 0 4px rgba(255,255,255,0.8)',
    })
    track.appendChild(now)

    // Pool of reusable wave bars (window/period + slack).
    for (let i = 0; i < 8; i++) {
      const bar = document.createElement('div')
      Object.assign(bar.style, {
        position: 'absolute',
        top: '0',
        bottom: '0',
        background: 'linear-gradient(180deg, #ff6a3c, #c23415)',
        borderRadius: '2px',
        display: 'none',
      })
      track.appendChild(bar)
      this.bars.push(bar)
    }

    document.body.appendChild(wrap)
    this.el = wrap
    this.track = track
  }

  /** Reposition wave bars for the current time. Cheap; safe to call per frame. */
  update() {
    const c = this.creeps
    const now = c.elapsed
    const win = this.windowSeconds
    const grace = c.graceTime
    const period = c.wavePeriod
    const active = c.waveActive

    // First wave index whose active window could still be visible.
    let n = Math.max(0, Math.floor((now - grace) / period))
    let used = 0
    while (used < this.bars.length) {
      const start = grace + n * period
      if (start >= now + win) break // beyond the visible window
      const end = start + active
      n++
      if (end <= now) continue // already passed

      // Clip the wave window to [now, now+win] and map to 0..100% of the track.
      const vis0 = Math.max(start, now)
      const vis1 = Math.min(end, now + win)
      const left = ((vis0 - now) / win) * 100
      const width = ((vis1 - vis0) / win) * 100

      const bar = this.bars[used++]
      bar.style.left = `${left}%`
      bar.style.width = `${Math.max(0.5, width)}%`
      bar.style.display = 'block'
    }
    for (let i = used; i < this.bars.length; i++) this.bars[i].style.display = 'none'
  }
}
