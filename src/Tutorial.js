/**
 * Tutorial - the intro slideshow shown between loading and the game intro.
 *
 * Content is LIVE from public/assets/tutorial/tutorial.md, fetched and parsed
 * at load - edit the md (or swap the pngs) and reload, no code change needed.
 *
 * Format: blocks separated by "# SLIDE" lines. If a block's first line looks
 * like an image filename it becomes the slide's (70vw, centered) image; every
 * other line is caption text, leading "- " bullets stripped. A block with no
 * image centers its text on black instead (the controls page).
 *
 * The DOM lives in index.html (#tute) so the overlay needs no build step.
 */
export class Tutorial {
  constructor() {
    this.el = document.getElementById('tute')
    this.img = document.getElementById('tute-img')
    this.text = document.getElementById('tute-text')
    this.next = document.getElementById('tute-next')
    this.pages = []
    this.page = 0
    this.onDone = null
    this.next.addEventListener('click', () => {
      if (this.page < this.pages.length - 1) this._showPage(this.page + 1)
      else { this.hide(); this.onDone?.() }
    })
  }

  /** Fetch + parse the md. Idempotent; show() awaits it, init() can warm it. */
  async load() {
    if (this._loaded) return
    try {
      const res = await fetch('assets/tutorial/tutorial.md')
      this.pages = this._parse(await res.text())
    } catch (e) {
      console.warn('tutorial.md load failed:', e)
      this.pages = []
    }
    this._loaded = true
  }

  _parse(md) {
    const pages = []
    for (const block of md.split(/^#\s*SLIDE\s*$/m)) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
      if (!lines.length) continue
      let img = null
      if (/\.(png|jpe?g|webp|gif)$/i.test(lines[0])) img = `assets/tutorial/${lines.shift()}`
      const text = lines.map((l) => l.replace(/^-\s+/, '')).join('\n')
      pages.push({ img, text })
    }
    return pages
  }

  /** Open the slideshow; calls onDone after the last page's Done click - both
   *  menus return the player where they came from rather than starting play. */
  async show(onDone, doneLabel = 'Done') {
    this.onDone = onDone
    this.doneLabel = doneLabel
    await this.load()
    if (!this.pages.length) { onDone?.(); return } // md missing: straight to the game
    // Decode the first image BEFORE revealing the overlay - showing first paints
    // a caption-on-black frame that the image then pops into, which reads as a
    // flash.
    if (this.pages[0].img) {
      this.img.src = this.pages[0].img
      try { await this.img.decode() } catch (e) { /* undecodable: show anyway */ }
    }
    this._showPage(0)
    this.el.style.display = 'block'
    // Preload the rest so each Next swaps instantly.
    for (const p of this.pages.slice(1)) if (p.img) new Image().src = p.img
  }

  hide() {
    this.el.style.display = 'none'
  }

  _showPage(i) {
    this.page = i
    const page = this.pages[i]
    this.img.style.display = page.img ? 'block' : 'none'
    if (page.img) this.img.src = page.img
    this.el.classList.toggle('no-img', !page.img)
    this.text.textContent = page.text
    this.next.textContent = i === this.pages.length - 1 ? (this.doneLabel || 'Done') : 'Next'
  }
}
