import gsap from 'gsap'
import { Sounds } from './lib/Sounds.js'
import { ENERGY_COLOR, PINK as PINK_ACCENT, ACCENTS } from './palette.js'
import { TopType, KING_MAX_FLOORS } from './blockTypes.js'
import { Buffs, resetBuffs } from './buffs.js'
import { simRand } from './lib/rng.js'

export { Buffs, resetBuffs }

/**
 * PowerUps - a pick-one-of-four card screen every third wave.
 *
 * Everything a card can change lives in `Buffs` (see buffs.js), which the game
 * systems read at the point of use. That indirection is the whole design: the
 * tunables were module-level consts (PROD_FACTOR, SOLDIER_HP, SLOTS...) that
 * nothing outside their file could touch, and threading a config object through
 * eight systems would have been a far bigger change than the feature deserves.
 * Each system now reads `Buffs.x` where it read a bare constant - one line each.
 */
// Cards dealt onto the choose screen.
const CARDS_OFFERED = 4

const YELLOW = ENERGY_COLOR
const PINK = PINK_ACCENT
const BLUE = ACCENTS[2]

/**
 * The deck. `repeat: false` cards are removed once taken; the rest can come
 * round again and stack. `available` gates a card on the run's state so you're
 * never offered something with nothing to apply to (a soldier buff with no
 * barracks is a wasted pick, and a wasted pick feels like a bug).
 */
export const CARDS = [
  {
    id: 'walls', title: 'Reinforced Walls', color: BLUE,
    desc: 'Every wall block soaks one extra hit.',
    apply: () => { Buffs.wallHits += 1 },
  },
  {
    id: 'king-heal', title: 'Restore the King', color: YELLOW,
    desc: 'Rebuild the king to full height.',
    available: (g) => g.city.king && g.city.king.numFloors < g.kingMaxFloors(),
    apply: (g) => g.healKing(),
  },
  {
    id: 'king-big', title: 'Crown the King', color: YELLOW,
    desc: 'The king gains 2 permanent floors of health.',
    // Gone once the king is as tall as it can get, rather than being offered as
    // a card that would do nothing.
    available: (g) => g.kingMaxFloors() < KING_MAX_FLOORS,
    apply: (g) => g.growKing(2),
  },
  {
    id: 'weak-creeps', title: 'Brittle Swarm', color: PINK,
    desc: 'Creeps arrive with 15% less health.',
    apply: () => { Buffs.creepHp *= 0.85 },
  },
  {
    id: 'gen-rate', title: 'Overclocked Grid', color: YELLOW,
    desc: 'Generators produce 25% more energy.',
    apply: () => { Buffs.genRate *= 1.25 },
  },
  {
    id: 'support-reach', title: 'Long Lines', color: BLUE,
    desc: 'Support towers reach 2 cells further.',
    apply: () => { Buffs.supportReach += 2 },
  },
  {
    id: 'slots', title: 'Wider Hand', color: BLUE,
    desc: 'One more tile slot in the palette.',
    repeat: 3, // a fifth, sixth and seventh slot; past that the bar runs off screen
    apply: (g) => g.addPaletteSlot(),
  },
  {
    id: 'refill', title: 'Fast Supply', color: BLUE,
    desc: 'Palette slots refill 25% faster.',
    apply: () => { Buffs.refillRate *= 0.75 },
  },
  {
    id: 'peg', title: 'Heavy Rounds', color: PINK,
    desc: 'Bullet turrets do +1 damage per shot.',
    apply: () => { Buffs.shotDamage.peg += 1 },
  },
  {
    id: 'laser', title: 'Focused Beam', color: PINK,
    desc: 'Laser turrets do +2 damage per shot.',
    apply: () => { Buffs.shotDamage.laser += 2 },
  },
  {
    id: 'mortar', title: 'Heavier Shells', color: PINK,
    desc: 'Mortars do +4 damage per blast.',
    apply: () => { Buffs.shotDamage.mortar += 4 },
  },
  {
    id: 'firerate', title: 'Rapid Cycling', color: PINK,
    desc: 'All turrets reload 20% faster.',
    apply: () => { Buffs.fireRate *= 0.8 },
  },
  {
    id: 'energy', title: 'Bigger Reserves', color: YELLOW,
    desc: 'Energy capacity +50.',
    apply: () => { Buffs.energyMax += 50 },
  },
  {
    id: 'cheap', title: 'Salvage Crews', color: BLUE,
    desc: 'Everything costs 15% less to build.',
    apply: () => { Buffs.buildCost *= 0.85 },
  },
  {
    id: 'squad', title: 'Larger Garrisons', color: BLUE,
    desc: 'Barracks support one more soldier per floor.',
    available: (g) => g.hasBarracks(),
    apply: () => { Buffs.squadPerFloor += 1 },
  },
  {
    id: 'soldier-hp', title: 'Veterans', color: BLUE,
    desc: 'Soldiers survive 2 more hits.',
    available: (g) => g.hasBarracks(),
    apply: () => { Buffs.soldierHp += 2 },
  },
  {
    id: 'shield', title: 'Wider Aegis', color: YELLOW,
    desc: 'Shields cover 2 more cells of radius.',
    available: (g) => g.hasShield(),
    apply: () => { Buffs.shieldRadius += 2 },
  },
]

/**
 * The card screen. Freezes the game, deals four cards, applies the chosen one.
 */
export class PowerUpScreen {
  constructor(demo) {
    this.demo = demo
    this.taken = new Map() // card id -> times taken
    this.open = false
  }

  // -- the small API the cards act through ----------------------------------

  get city() { return this.demo.city }
  kingMaxFloors() { return this.demo.city.kingMaxFloors || 5 }
  hasBarracks() { return this.demo.soldiers?.soldiers.length > 0 || this._anyBarracks() }
  _anyBarracks() {
    return this.demo.city.towers.some(t => t.visible && t.typeTop === TopType.BARRACKS && t.numFloors >= 1)
  }
  hasShield() {
    return this.demo.city.towers.some(t => t.visible && t.typeTop === TopType.SHIELD && t.numFloors >= 1)
  }
  healKing() {
    const k = this.demo.city.king
    if (!k) return
    k.numFloors = this.kingMaxFloors()
    k.shieldHits = 0
    this.demo.city.onTowerChanged(k)
  }
  growKing(n) {
    const city = this.demo.city
    // Capped: the king has exactly KING_MAX_FLOORS block instances allocated to
    // it, and a floor past that has nothing to draw it with.
    const max = Math.min(this.kingMaxFloors() + n, KING_MAX_FLOORS)
    const gained = max - this.kingMaxFloors()
    city.kingMaxFloors = max
    if (gained > 0 && city.king) {
      city.king.numFloors = Math.min(city.king.numFloors + gained, max)
      city.onTowerChanged(city.king)
    }
  }
  addPaletteSlot() {
    Buffs.paletteSlots += 1
    this.demo.tilePalette?.addSlot()
  }

  /** Take a card by id - how run playback picks, since a card object cannot be
   *  written to a file but its id can. */
  pickRecorded(id) {
    const card = this._offered?.find((c) => c.id === id) || CARDS.find((c) => c.id === id)
    if (card) this.choose(card)
  }

  /** Deal four distinct, currently-useful cards. */
  deal() {
    const pool = CARDS.filter(c => {
      const times = this.taken.get(c.id) || 0
      const cap = c.repeat === false ? 1 : (typeof c.repeat === 'number' ? c.repeat : Infinity)
      if (times >= cap) return false
      return !c.available || c.available(this)
    })
    const picked = []
    while (picked.length < CARDS_OFFERED && pool.length) {
      picked.push(pool.splice(Math.floor(simRand() * pool.length), 1)[0])
    }
    return picked
  }

  /**
   * @param {{x:number,y:number}|null} origin - screen point the cards fly out
   *   of (the crate that just burst). Null centres them with a plain pop.
   */
  show(origin = null) {
    if (this.open) return
    const cards = this.deal()
    this._offered = cards // run playback picks by id out of this
    if (!cards.length) return
    this.open = true
    this.demo.paused = true
    // Hold the music, but leave the master bus alone: setPauseAudio fades the
    // whole output to zero, which silenced this screen's own sound.
    Sounds.holdBeds(true)
    Sounds.stop('tick-fast')
    Sounds.play('card-reveal', 1.0, 0.02, 0.7)
    this._build(cards, origin)
  }

  choose(card) {
    this.demo.run?.record('card', { id: card.id })
    card.apply(this)
    this.taken.set(card.id, (this.taken.get(card.id) || 0) + 1)
    Sounds.play('good', 1.0, 0.05, 0.7)
    // Buffs are read all over the place but recalculated nowhere, so the board
    // has to be rebuilt for the card to visibly do anything.
    this.demo.city.refreshAfterBuff()
    this._close()
  }

  _close() {
    if (this.el) { document.body.removeChild(this.el); this.el = null }
    this.open = false
    this.demo.paused = false
    // Asymmetric with show() on purpose: show() only holds the beds, but this
    // is the superset (releases the beds AND restores the master bus), so it
    // also cleans up if the game was paused underneath the cards.
    this.demo.setPauseAudio?.(false)
  }

  _build(cards, origin = null) {
    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2500',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: '22px',
      background: 'rgba(8,10,14,0.55)', backdropFilter: 'blur(3px)',
      font: '600 16px Inter, system-ui, sans-serif',
    })

    const title = document.createElement('div')
    title.textContent = 'CHOOSE AN UPGRADE'
    Object.assign(title.style, {
      color: '#fff', font: '800 28px Inter, system-ui, sans-serif',
      letterSpacing: '3px', textShadow: '0 2px 12px rgba(0,0,0,0.9)',
    })
    el.appendChild(title)

    const row = document.createElement('div')
    Object.assign(row.style, { display: 'flex', gap: '16px', flexWrap: 'wrap', justifyContent: 'center' })
    el.appendChild(row)

    for (const c of cards) {
      const card = document.createElement('button')
      Object.assign(card.style, {
        width: '180px', minHeight: '150px', padding: '18px 16px',
        display: 'flex', flexDirection: 'column', gap: '10px', textAlign: 'left',
        background: 'rgba(16,18,24,0.92)',
        border: `2px solid ${c.color}`, borderRadius: '14px',
        cursor: 'pointer', color: '#fff', font: 'inherit',
        boxShadow: `0 0 0 rgba(0,0,0,0)`, transition: 'transform 0.12s, box-shadow 0.12s',
      })
      const h = document.createElement('div')
      h.textContent = c.title
      Object.assign(h.style, { color: c.color, font: '700 16px Inter, system-ui, sans-serif' })
      const d = document.createElement('div')
      d.textContent = c.desc
      Object.assign(d.style, {
        color: '#cfd4dd', font: '500 13px Inter, system-ui, sans-serif',
        lineHeight: '1.45', whiteSpace: 'normal',
      })
      card.appendChild(h)
      card.appendChild(d)

      card.addEventListener('pointerenter', () => {
        card.style.transform = 'translateY(-4px)'
        card.style.boxShadow = `0 8px 26px ${c.color}55`
        Sounds.play('snap', 1.1, 0.05, 0.12)
      })
      card.addEventListener('pointerleave', () => {
        card.style.transform = 'none'
        card.style.boxShadow = '0 0 0 rgba(0,0,0,0)'
      })
      card.addEventListener('click', () => this.choose(c))
      row.appendChild(card)
    }

    document.body.appendChild(el)
    this.el = el
    this._flyOut(el, row, origin)
  }

  /**
   * Deal the cards out of the crate: each starts collapsed at the crate's
   * screen position and springs to its laid-out spot.
   *
   * The layout is left to flexbox and only then read back with
   * getBoundingClientRect - animating position directly would mean duplicating
   * the row's centring maths, and it would drift the moment the card size or
   * gap changed. Each card is offset BACK to the origin and released.
   */
  _flyOut(el, row, origin) {
    const cards = [...row.children]
    // Fade the backdrop in regardless; it shouldn't snap on.
    gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'power2.out' })

    if (!origin) {
      gsap.fromTo(cards,
        { scale: 0.8, y: 16, opacity: 0 },
        { scale: 1, y: 0, opacity: 1, duration: 0.32, stagger: 0.06, ease: 'back.out(1.6)' })
      return
    }

    for (const card of cards) {
      const r = card.getBoundingClientRect()
      const dx = origin.x - (r.left + r.width / 2)
      const dy = origin.y - (r.top + r.height / 2)
      gsap.fromTo(card,
        { x: dx, y: dy, scale: 0.15, rotation: (Math.random() - 0.5) * 90, opacity: 0 },
        {
          x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
          duration: 0.62, ease: 'back.out(1.35)',
          delay: 0.05 + cards.indexOf(card) * 0.07,
        })
    }
  }
}
