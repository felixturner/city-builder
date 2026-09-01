import { Howl, Howler } from 'howler'
import gsap from 'gsap'

/**
 * Centralized sound manager.
 *
 * Three kinds of entry:
 *  - SIMPLE   one file, one name. Sounds.play('pop')
 *  - GROUP    several interchangeable files under one name, picked at random
 *             with no immediate repeat. Sounds.play('horn')
 *  - TIMED    long rhythmic beds (tick loops) whose cadence is known, so a
 *             countdown can be started N seconds out and land exactly on zero.
 *             Sounds.countdown('countdown', 6)
 *
 * TRIM values below are measured lead-in silence / usable body (see CADENCE):
 * several Pixabay files start with up to a second of room tone, which would
 * make an event-synced hit feel late. Rather than re-encoding the mp3s we play
 * a Howler sprite that skips the dead air.
 */

// ---------------------------------------------------------------------------
// Measured cadence data
//
// Everything below came out of an envelope/autocorrelation pass over the raw
// files, and the wiring depends on it - re-measure if a file is swapped.
//
//   file            dur     lead   body   beat      notes
//   horn1          4.56s   1.01s  1.68s   -         bright blast, ~1.9kHz
//   horn2          8.50s   0.16s  4.40s   -         deep medieval, ~625Hz
//   horn3          5.90s   0.40s  5.33s   -         viking call, ~730Hz
//   horn-boss     10.73s   0.59s  9.44s   -         slow swell, peaks at 2.54s
//   countdown     16.04s   0.02s 15.52s   1.002s    16 beeps on an exact 1Hz grid
//   tick-fast     20.50s   0.04s 20.47s   0.233s    88 mechanical ticks
//   tick-rapid    25.31s   0.02s 25.33s   0.188s    137 ticks, bright + urgent
//   count         12.93s   1.03s 11.08s   1.170s    11 counts, slightly loose
//   gen-expire     4.44s   0.15s  4.17s   -         deep descending, ~73Hz
// ---------------------------------------------------------------------------

/** Beat period in seconds for the rhythmic beds, and their first-beat offset. */
const CADENCE = {
  countdown: { beat: 1.002, first: 0.024, beats: 16 },
  'tick-fast': { beat: 0.233, first: 0.046, beats: 88 },
  'tick-rapid': { beat: 0.188, first: 0.120, beats: 137 },
  count: { beat: 1.170, first: 1.108, beats: 11 },
}

/** [startMs, durationMs] sprites that skip measured lead-in silence. */
const TRIM = {
  horn1: [1000, 3560],
  horn2: [140, 8360],
  horn3: [380, 5520],
  'horn-boss': [560, 10170],
  'gen-expire': [140, 4300],
}

/** How long the boss horn takes to reach its peak - start it this far ahead of
 *  the spawn so the hit lands with the giants, not after them. */
export const BOSS_HORN_PREROLL = 2.5

/**
 * Continuous background beds. All of them loop for the whole session and are
 * mixed by moving their volume, never started and stopped, so switching mode
 * crossfades instead of cutting.
 *
 * `base` is the playing volume. Source files run hot (most peak near 0dB), so
 * these sit low.
 */
const BEDS_SRC = {
  'build-bed': { base: 0.30 }, // 84.3s - the build phase is 60s, so it rarely loops inside one
  'bed-fight1': { base: 0.20 },
  'bed-fight2': { base: 0.22 },
  'bed-boss': { base: 0.23 },
}

/**
 * Which beds can play in each mode. `fight` is a bucket - a different track is
 * drawn each round (no immediate repeat) so a long game doesn't loop one riff
 * forever. Boss rounds always get their own.
 */
const BED_MODES = {
  // No bed at all - used for the beat of silence after a round is cleared, so
  // the win lands in the quiet instead of straight into the next track.
  quiet: [],
  build: ['build-bed'],
  fight: ['bed-fight1', 'bed-fight2'],
  boss: ['bed-boss'],
}

/**
 * Risers, with the measured time from file start to peak. A riser only works if
 * its peak lands on the downbeat it's building to, and these three peak at very
 * different points, so each carries its own pre-roll rather than sharing one.
 *
 *   riser1  12.80s  peak 5.38s   quiet source (-14dB), needs the volume
 *   riser2  16.01s  peak 10.80s
 *   riser3  16.02s  peak 10.60s
 */
const RISERS = {
  // `long` splits them by how much runway they need. The short one fits inside
  // the tail of a normal wave's ticker; the two Titans need ~11s, so they're
  // reserved for boss waves where there's room for a build that size.
  riser1: { peak: 5.38, volume: 0.63, long: false },
  riser2: { peak: 10.80, volume: 0.28, long: true },
  riser3: { peak: 10.60, volume: 0.28, long: true },
}

/** Longest pre-roll any riser needs - arm the pick at least this far out. */
export const MAX_RISER_PREROLL = 11

/**
 * Files that may not be on disk yet. They load like any other sound, but a
 * failed load just marks them unavailable instead of logging - play() then
 * skips them silently, so the game runs fine with the slot empty and starts
 * using the sound the moment the file appears.
 */
const OPTIONAL = new Set([
  'reveal', // reveal sting over the opening build period
  ...Object.keys(BEDS_SRC),
  ...Object.keys(RISERS),
])

/**
 * Named voices: one short sample re-pitched into several distinct roles, so the
 * HUD blips stay obviously related to each other without needing a file each.
 * `play()` takes these names like any other sound and applies the defaults.
 */
const VOICES = {
  'energy-down': { sample: 'pluck', rate: 0.72, volume: 0.62, variation: 0.05 },
  'energy-up': { sample: 'pluck', rate: 1.15, volume: 0.50, variation: 0.05 },
  'energy-full': { sample: 'pluck', rate: 1.45, volume: 0.85, variation: 0.0 },
  'score-up': { sample: 'pluck', rate: 2.0, volume: 0.45, variation: 0.08 },
}
// Those volumes look high next to the rest of the game and have to be: pluck.mp3
// only peaks at 0.31, so "volume 0.2" lands at an effective 0.06 while pop.mp3
// hits 1.07. Judge these by ear, not by the number.

/**
 * Sounds needed in the first moments: the intro, and everything a player can
 * trigger by building before the first wave lands at 30s. These preload.
 *
 * Everything else - combat, waves, the music beds - is fetched in the
 * background by loadDeferred() once the game is up. It used to all preload
 * eagerly, which put ~9MB of audio (the build bed alone is 2.7MB) between the player
 * and the Start button.
 *
 * A deferred sound played before its fetch finishes is not an error: Howler
 * queues the play and fires it on load, so the worst case is one late blip.
 */
const CORE = new Set([
  'intro', 'reveal', 'pop', 'tick', 'pluck', 'roll', 'good', 'dink', 'energy',
  'snap', 'error', 'success',
  'stone-01', 'stone-02', 'stone-03', 'stone-04', 'stone-05',
  'clink01', 'clink02', 'clink03', 'clink04', 'clink05', 'clink06', 'clink07', 'clink08',
])

/**
 * Declared once, played nowhere. Kept out of the load set rather than deleted -
 * the files are still on disk if a cue wants them back - because loading them
 * cost 1.6MB up front, tick-rapid and count being 1.2MB of that between them:
 *
 *   break  burn  count  debris  energy-2  gen-expire
 *   incorrect  round-end  round-start  tick-rapid
 */
const SIMPLE = [
  'pop', 'tick', 'roll', 'good', 'intro', 'error', 'pluck',
  'energy', 'power-down', 'spawn', 'step1', 'step2', 'break2', 'hit', 'dink',
  'mortar-shoot', 'mortar-hit', 'warning1', 'success', 'shield-hit', 'king-warning', 'pick-up',
  'board-expand',
  // long-form event sounds
  'horn-boss', 'countdown', 'tick-fast', 'gen-online', 'sting',
  'creep-alert', 'creep-alert-2', 'flyer-warn', 'snap', 'game-over', 'king-hit', 'king-danger', 'level-complete', 'boss-complete', 'card-reveal',
  // short blips, addressed individually so each meaning is learnable
  // energy-down.mp3 is deliberately NOT loaded: 'energy-down' is a voice above,
  // and _resolve checks VOICES first, so the file could never be reached.
  'alert2', 'energy-down-2',
]

/**
 * Interchangeable variants picked at random (no immediate repeat).
 *
 * The short alert blips split by brightness, which turned out to map cleanly
 * onto meaning: the dull low ones (640-920Hz) read as power draining away, the
 * bright ones (1.5-3.7kHz) read as an incoming threat. Same family of sounds,
 * opposite ends of the spectrum, so the two never get confused in play.
 */
const GROUPS = {
  stone: ['stone-01', 'stone-02', 'stone-03', 'stone-04', 'stone-05'],
  clink: ['clink01', 'clink02', 'clink03', 'clink04', 'clink05', 'clink06', 'clink07', 'clink08'],
  shoot: ['shoot1', 'shoot2', 'shoot3'],
  // Wave horns: three distinct calls so consecutive waves don't sound identical.
  horn: ['horn1', 'horn2', 'horn3'],
  // Every blow landed on something, from either side. attack2/attack3 were
  // already on disk and never registered; all three are the same length and
  // within 3dB of each other, so they interchange cleanly.
  attack: ['attack', 'attack2', 'attack3'],
  // Generator "about to expire": low + dull, 0.86s-2.35s.
  'gen-warn': ['gen-warn1', 'gen-warn2', 'gen-warn3'],
}

/** Minimum seconds between repeats, for sounds that would otherwise stack up
 *  when many entities fire the same event in one frame. */
const COOLDOWN = {
  // Fires on every dud click (max height, can't afford); spamming a wall you
  // can't build on shouldn't stutter.
  error: 0.35,
  'gen-warn': 0.6,
  horn: 1.0,
  'horn-boss': 1.0,
  'gen-expire': 0.25,
  'gen-online': 0.4,
  sting: 0.5,
  // Threat blips: several can fire in the same burst, and one per event would
  // machine-gun. One per second is enough of a heads-up.
  // The king-in-danger siren. It re-fires on its own 1.5s timer, so this only
  // guards against a second source ever sharing it.
  alert2: 1.2,
  'energy-down-2': 1.2,
  // A swarm crosses the boundary within a second or two of itself; one blip per
  // creep would machine-gun.
  'creep-alert': 0.9,
  'creep-alert-2': 0.9,
  // Generators tick income constantly, so the energy-gain blip has to be
  // throttled hard or it becomes a drone. Spending is player-driven and
  // discrete, so it stays ungated.
  'energy-up': 0.5,
  'energy-full': 2.0,
  snap: 0.04, // fast drags cross cells quickly; just enough to stop a buzz

  spawn: 0.25, // now only big/giant, which are rare - it can breathe
  'flyer-warn': 1.2,
}

class SoundsManager {
  constructor() {
    this.mutedSounds = new Set() // Sounds to mute (by name)
    this.sounds = {}
    this.groups = {}
    this._lastPick = {} // group -> last index played (to avoid immediate repeats)
    this._lastAt = {} // name -> timestamp of last play (cooldown gate)
    this._active = {} // name -> Howler sound id, for stoppable long sounds

    this._trimmed = new Set(Object.keys(TRIM))
    this._unavailable = new Set() // optional sounds whose file isn't there (yet)
    this._beds = {} // name -> { id, level } for the looping background layers
    this._bedMode = null // 'build' | 'fight' | 'boss'
    this._musicOn = true // 'Music' toggle in the GUI
    this._bedsHeld = false // game paused - beds hold their position
    this._suspended = false // tab in the background - everything silent
    this._lastBed = null // last fight bed drawn (avoid immediate repeat)
    this._lastRiser = null
    const all = new Set([...SIMPLE, ...OPTIONAL])
    for (const members of Object.values(GROUPS)) for (const m of members) all.add(m)
    for (const name of all) {
      const opts = { src: [`assets/sfx/${name}.mp3`], preload: CORE.has(name) }
      if (TRIM[name]) opts.sprite = { play: TRIM[name] }
      if (BEDS_SRC[name]) { opts.loop = true; opts.volume = 0 }
      if (OPTIONAL.has(name)) {
        opts.onloaderror = () => this._unavailable.add(name)
      }
      this.sounds[name] = new Howl(opts)
    }
    for (const [group, members] of Object.entries(GROUPS)) {
      this.groups[group] = members
    }
  }

  /**
   * Fetch everything outside CORE, a few at a time. Called once the game is up,
   * so the download runs against an idle network instead of competing with the
   * models and shaders the first frame needs.
   *
   * Batched rather than fired at once: ~50 parallel requests starve each other.
   * Soonest-needed first, since the wave audio is what a player hits next.
   */
  loadDeferred(batch = 4, gapMs = 300) {
    const queue = Object.keys(this.sounds).filter(n => !CORE.has(n) && !this._unavailable.has(n))
    const priority = ['build-bed', 'tick-fast', 'horn1', 'horn2', 'horn3', 'riser1',
      'creep-alert', 'spawn', 'step1', 'step2', 'shoot1', 'shoot2', 'shoot3']
    queue.sort((a, b) => {
      const ia = priority.indexOf(a), ib = priority.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    let i = 0
    const pump = () => {
      for (let n = 0; n < batch && i < queue.length; n++, i++) {
        const snd = this.sounds[queue[i]]
        if (snd && snd.state() === 'unloaded') snd.load()
      }
      if (i < queue.length) setTimeout(pump, gapMs)
    }
    pump()
  }

  /** Resolve a name to a concrete { sound, key }, expanding groups with a
   *  no-repeat pick so the same variant never fires twice in a row, and voices
   *  to the sample they re-pitch. */
  _resolve(name) {
    const voice = VOICES[name]
    if (voice) return { sound: this.sounds[voice.sample], key: voice.sample }
    const members = this.groups[name]
    if (!members) return { sound: this.sounds[name], key: name }
    let i = Math.floor(Math.random() * members.length)
    if (members.length > 1 && i === this._lastPick[name]) i = (i + 1) % members.length
    this._lastPick[name] = i
    return { sound: this.sounds[members[i]], key: members[i] }
  }

  /** True if `name` is still inside its cooldown window. */
  _onCooldown(name) {
    const cd = COOLDOWN[name]
    if (!cd) return false
    const now = performance.now() / 1000
    if (this._lastAt[name] !== undefined && now - this._lastAt[name] < cd) return true
    this._lastAt[name] = now
    return false
  }

  /**
   * Play a sound with optional rate variation and volume.
   *
   * `name` may be a plain sound, a group (stone, clink, shoot, horn, gen-warn)
   * or a voice (energy-up, score-up, ...). Voices supply their own rate/volume,
   * so calling play('energy-up') with no other arguments is the normal use;
   * pass arguments only to override.
   *
   * @param {string} name - Sound, group or voice name
   * @param {number} baseRate - Base playback rate (default 1.0, or the voice's)
   * @param {number} variation - Random variation amount (default 0.2, or the voice's)
   * @param {number} volume - Volume 0-1 (default 1.0, or the voice's)
   */
  play(name, baseRate, variation, volume) {
    // Skip muted sounds
    if (this.mutedSounds.has(name) || this._unavailable.has(name)) return
    if (this._onCooldown(name)) return

    const voice = VOICES[name]
    baseRate = baseRate ?? voice?.rate ?? 1.0
    variation = variation ?? voice?.variation ?? 0.2
    volume = volume ?? voice?.volume ?? 1.0

    const { sound, key } = this._resolve(name)
    if (!sound) {
      console.warn(`Sound "${name}" not found`)
      return
    }
    // Trimmed sounds are addressed through their 'play' sprite.
    const id = this._trimmed.has(key) ? sound.play('play') : sound.play()
    sound.rate(baseRate - variation / 2 + Math.random() * variation, id)
    sound.volume(volume, id)
    this._active[name] = { sound, id }
    return id
  }

  /**
   * Start a rhythmic bed so its LAST beat lands `seconds` from now (i.e. it runs
   * out exactly as the event fires). Seeks into the file rather than playing it
   * from the top, so a 16-beat clock can serve a 6-second countdown.
   *
   * @param {string} name - a key in CADENCE ('countdown', 'tick-fast', ...)
   * @param {number} seconds - how far out the event is
   * @returns {number|undefined} Howler sound id, or undefined if it can't fit
   */
  countdown(name, seconds, volume = 0.5, rate = 1.0) {
    if (this.mutedSounds.has(name)) return
    const cad = CADENCE[name]
    const sound = this.sounds[name]
    if (!cad || !sound) {
      console.warn(`Sound "${name}" has no cadence data`)
      return
    }
    // How many whole beats fit in the window, capped at what the file holds.
    const beats = Math.min(cad.beats, Math.floor(seconds / cad.beat))
    if (beats < 1) return
    const offset = cad.first + (cad.beats - beats) * cad.beat
    const id = sound.play()
    sound.seek(offset, id)
    sound.rate(rate, id)
    sound.volume(volume, id)
    this._active[name] = { sound, id }
    return id
  }

  /** Beat period (seconds) of a rhythmic bed, or 0 if it isn't one. */
  beatOf(name) { return CADENCE[name]?.beat || 0 }

  // -- Background beds ------------------------------------------------------

  /**
   * Start every available bed looping at silence. Must be called from a user
   * gesture (the Start button) or the browser will refuse to open the audio
   * context. Beds with no file are skipped, and one already running is left
   * alone, so this is safe to call more than once.
   */
  startBeds() {
    for (const name of Object.keys(BEDS_SRC)) {
      if (this._unavailable.has(name) || this._beds[name]) continue
      const sound = this.sounds[name]
      if (!sound) continue
      const id = sound.play()
      sound.volume(0, id)
      this._beds[name] = { id, level: 0, held: false }
    }
    this._applyBedState()
  }

  /**
   * Switch the background to 'build', 'fight' or 'boss', crossfading from
   * whatever was playing. Modes with more than one bed draw a different track
   * each time they're entered, so repeated rounds don't reuse the same riff.
   * Re-entering the mode already playing does nothing.
   */
  setBedMode(mode, fade = 2.0) {
    if (mode === this._bedMode) return
    this._bedMode = mode

    const pool = (BED_MODES[mode] || []).filter(n => this._beds[n])
    let pick = null
    if (pool.length) {
      let i = Math.floor(Math.random() * pool.length)
      if (pool.length > 1 && pool[i] === this._lastBed) i = (i + 1) % pool.length
      pick = pool[i]
      this._lastBed = pick
    }

    for (const name of Object.keys(this._beds)) {
      this._fadeBed(name, name === pick ? BEDS_SRC[name].base : 0, fade)
    }
    return pick
  }

  /** Fade one bed to an absolute volume. */
  _fadeBed(name, target, fade) {
    const bed = this._beds[name]
    if (!bed || Math.abs(target - bed.level) < 0.005) return
    // While held (paused / music off) just record where the level should be;
    // _applyBedState restores it on resume.
    if (bed.held) { bed.level = target; return }
    this.sounds[name].fade(bed.level, target, Math.max(0.01, fade) * 1000, bed.id)
    bed.level = target
  }

  /**
   * Beds are silenced by two independent switches - the Music toggle and the
   * game being paused - so both feed one place. Pausing the Howl (rather than
   * stopping it) keeps the playhead, so unpausing resumes mid-phrase instead of
   * restarting the track.
   */
  _applyBedState() {
    // Three independent switches can silence the beds: the Music toggle, a game
    // pause, and the tab being in the background. They all land here so none of
    // them can un-silence what another one is holding.
    const silent = !this._musicOn || this._bedsHeld || this._suspended
    for (const [name, bed] of Object.entries(this._beds)) {
      const sound = this.sounds[name]
      if (silent) {
        if (!bed.held) { sound.pause(bed.id); bed.held = true }
      } else if (bed.held) {
        sound.play(bed.id)
        sound.volume(bed.level, bed.id)
        bed.held = false
      }
    }
  }

  /**
   * Fade the whole Howler output to `target` (0..1). Used by pause: holding the
   * beds silences the music, but a mortar or a horn already mid-flight would
   * play on over a frozen game, so the master bus goes with it.
   */
  fadeMaster(target, secs = 0.25) {
    if (this._masterTween) this._masterTween.kill()
    const state = { v: Howler.volume() }
    this._masterTween = gsap.to(state, {
      v: target, duration: secs, ease: 'linear',
      onUpdate: () => Howler.volume(state.v),
    })
  }

  /** GUI 'Music' checkbox. Off pauses every bed; one-shot sfx are unaffected. */
  setMusicEnabled(on) {
    this._musicOn = !!on
    this._applyBedState()
  }

  musicEnabled() { return this._musicOn }

  /**
   * Background the whole mixer when the tab loses focus.
   *
   * Two different tools, because they solve different halves: Howler.mute kills
   * one-shots instantly (a fade is pointless when nobody's watching), while the
   * beds are PAUSED rather than muted so they don't advance through minutes of
   * track while you're away and come back somewhere else entirely.
   */
  setSuspended(on) {
    this._suspended = !!on
    Howler.mute(!!on)
    this._applyBedState()
  }

  /** Hold/release the beds for a game pause, keeping their playhead. */
  holdBeds(held) {
    this._bedsHeld = !!held
    this._applyBedState()
  }

  /** Fade every bed out and stop them (game over, or leaving play). */
  stopBeds(fade = 1.5) {
    for (const [name, bed] of Object.entries(this._beds)) {
      const sound = this.sounds[name]
      sound.fade(bed.level, 0, fade * 1000, bed.id)
      setTimeout(() => sound.stop(bed.id), fade * 1000)
    }
    this._beds = {}
    this._bedMode = null
  }

  // -- Risers ---------------------------------------------------------------

  /**
   * Choose a riser for an upcoming beat. `long` picks from the big ~11s builds
   * (boss waves) rather than the short one. Returns { name, peak, volume } -
   * start it `peak` seconds before the moment it should land on, or null. Picking and playing are separate calls because the
   * caller has to know the pre-roll before the time to fire arrives.
   */
  pickRiser(long = false) {
    let avail = Object.keys(RISERS).filter(n => !this._unavailable.has(n) && RISERS[n].long === long)
    // Fall back to any riser rather than going silent if that bucket is empty.
    if (!avail.length) avail = Object.keys(RISERS).filter(n => !this._unavailable.has(n))
    if (!avail.length) return null
    let i = Math.floor(Math.random() * avail.length)
    if (avail.length > 1 && avail[i] === this._lastRiser) i = (i + 1) % avail.length
    this._lastRiser = avail[i]
    return { name: avail[i], ...RISERS[avail[i]] }
  }

  /** Stop a sound started by play()/countdown(). Safe to call when not playing. */
  stop(name) {
    const a = this._active[name]
    if (!a) return
    a.sound.stop(a.id)
    delete this._active[name]
  }

  /** Fade a sound out over `secs` then stop it. */
  fadeOut(name, secs = 0.4) {
    const a = this._active[name]
    if (!a) return
    const from = a.sound.volume(a.id)
    a.sound.fade(from, 0, secs * 1000, a.id)
    delete this._active[name]
  }

  /**
   * Mute specific sounds by name
   * @param {string[]} names - Array of sound names to mute
   */
  mute(names) {
    names.forEach(name => this.mutedSounds.add(name))
  }

  /**
   * Unmute specific sounds by name
   * @param {string[]} names - Array of sound names to unmute
   */
  unmute(names) {
    names.forEach(name => this.mutedSounds.delete(name))
  }
}

export const Sounds = new SoundsManager()
