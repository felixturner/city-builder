# Recording and replaying a run

A run can be written down and played back exactly - same board, same tiles, same
creeps, same outcome - at up to 60x speed. It exists for balance work: changing a
rate and replaying the *same* run is the only way to see what the change did
rather than what a different game did.

## Using it

```
?dev                  play, recording to logs/run-<id>.json
?dev&replay           play back the newest recording (4x)
?dev&replay&speed=16  ...faster. 1-60; music goes quiet above 4
```

The file is written at the end of every round and again at game over, so a run
that crashes still has everything up to its last round. In the console,
`__run.save()` writes it out mid-game and `__econ` holds the per-round figures.

Playback checks itself. Each round is compared against the recording and the
first mismatch is logged:

```
[run] L1 matches
[run] L2 matches
[run] DIVERGED at level 3 (round 3): spent 383 -> 341, blocksPlaced 71 -> 64
```

## What is in a run file

`logs/run-<timestamp>.json`, one file per run, rewritten as it goes:

| field | |
|---|---|
| `seed` | what the simulation's RNG started from |
| `events` | every player action, stamped with the sim TICK |
| `rounds` | the per-round economy figures (EconLog) |
| `commit`, `dirty` | stamped by the dev server when it writes |
| `replay` | true if this run was itself a playback |

The economy figures live here rather than in a log of their own: they describe
one run, and when they were separate a replay appended rounds to a file no run
owned.

## How it works

Three things have to hold, and each of them was a bug before it was a feature.

### 1. Seeded randomness, split in two

`src/lib/rng.js` provides `simRand()` and friends. Everything the world depends
on draws from it: creep types and sizes, spawn offsets, wave edges, the tile bag
shuffle, palette draws, card deals, soldier wandering, tile rerolls, generator
income phase.

Cosmetic randomness stays on `Math.random` **deliberately**: debris velocities,
hit-flash jitter, sound pitch, particle spin. If they shared a stream, a dropped
particle - or turning effects off - would shift every later sim roll and the run
would diverge. Two playbacks of one recording look slightly different frame to
frame and are identical in every way that matters.

Two traps worth knowing:

- `[...arr].sort(() => rand() - 0.5)` is not a shuffle, and it consumes an
  unpredictable number of values. Use `simShuffle`.
- Anything that draws from the stream **changes the position of everything after
  it**, even if what it draws is invisible. A per-lot colour roll nobody could
  see cost 169 draws and desynced every run; it was removed rather than seeded.

### 2. A fixed simulation step

`Demo.SIM_DT` is 1/60, and the world advances by exactly that every frame however
long the frame took. That is what makes a tick a reproducible moment - and what
lets playback run N steps per rendered frame.

The camera still moves on real elapsed time. The cost is that a genuinely slow
frame runs the game slightly in slow motion rather than skipping ahead.

### 3. Game state separated from animation

This was where the real bugs were, and they were gameplay bugs, not just replay
artefacts:

- **A build click** applied its floor inside a 100ms press-down tween, with a
  guard voiding it if anything had changed meanwhile. Two quick clicks on one
  tower landed inside the same press and the second was silently thrown away.
- **A demolished tower** was only removed when its fall animation finished, so it
  went on blocking creep paths and sealing enclosures for most of a second.
- **The board opening** after a boss round, the upgrade screen, and the intro
  build all ran on `setTimeout`. Board size sets the energy cap and the spawn
  ring; the intro sets the king's floors and arms its damage ring.
- **The death countdown** ticked once a frame rather than once a step, handing
  the creeps N times as long to work after the run had already ended.

The rule that came out of it: **anything that changes the world runs on sim time;
animations are what you watch afterwards.** Where something genuinely must wait
for an animation - returning a tower's instances to the pool, since the animation
is drawing to them - it waits for that alone, and the state change does not.

`Demo.after(seconds, fn)` is the sim-time scheduler for anything that used to be
a `setTimeout`.

## What is recorded

Eight actions, each one line to record and one to replay
(`src/systems/RunRecorder.js`):

place a tile · add a floor · demolish · discard a tile · reroll the tray · click
a dormant lot · take a card · skip the clock forward

Everything else follows from the seed. Playback calls the same methods player
input calls, affordability checks included, so a replay that cannot afford
something fails exactly where the original would have - which is the signal that
a run has diverged.

Deliberately not recorded: pausing (it stops the sim rather than altering it),
the rotate key (its effect arrives with the placement, which carries its own
rotation), the flow overlay, and the camera.

## Adding to the game without breaking this

- New randomness: is it something the world depends on? `simRand()`. Is it a
  particle or a pitch? `Math.random`. When unsure, ask whether two playbacks
  differing on it would matter.
- New timers: `Demo.after()`, not `setTimeout`, if it changes anything.
- New player input: one `run.record()` at the point the action is committed
  (after its affordability check), and one case in `RunRecorder.apply()`.
- New animation: never make state wait for it.
