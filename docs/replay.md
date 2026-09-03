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

`logs/run-<timestamp>.json`, one file per run, rewritten as it goes. A PLAYBACK
writes `logs/replay-<timestamp>.json` instead, and `?replay` only ever loads the
newest `run-`: while both were named the same, replaying twice played back the
previous replay and checked itself against a game nobody had played. The
timestamp carries milliseconds, so two pages opened in the same second cannot
share a file.

| field | |
|---|---|
| `seed` | what the simulation's RNG started from |
| `events` | every player action, stamped with the sim TICK |
| `rounds` | the per-round economy figures (EconLog) |
| `commit`, `dirty` | stamped by the dev server when it writes |
| `replay` | true if this run was itself a playback |
| `diedAt` | tick, seconds, level and score when the king fell (null if unfinished) |

Each round carries `ended`: `'cleared'` when the board went quiet, `'died'` for
the round the king fell in. That round used to be missing entirely - rounds were
only closed on a clear - which threw away the one round the economy actually
failed in.

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

## What broke it, and what the rules are

Every divergence found so far was one of three shapes. None was the RNG.

**1. An animation deciding something.** gsap runs on the wall clock, so anything
a tween touches is decided by the frame rate. At 16x the same tween covers
sixteen times as much of the game.

- `City.onTowerChanged` fired when a new floor's emerge tween ended, so creeps
  learned about a wall an animation later.
- A loot crate paid its energy from a gsap timeline, and read the LEVEL at that
  moment - so it could pay a later level's rate.
- A demolished tower rejoined the tower pool from a tween's `onComplete`. The
  pool is a stack, so *when* it returned decided *which* tile object the next
  placement got.

**2. A decision made from rendered state.** Twice, in two files: `hasLOS` in both
`Turrets` and `Creeps` raycast the tower BatchedMesh - whose instance matrices
gsap writes as towers build, shake and fall. What a gun could see depended on
where an animation had got to. Both now walk the line in half-cell steps against
floor counts, which is game state (and cheaper). It also means roof decoration
no longer blocks a shot, which is the behaviour you want anyway.

**3. Playback re-deriving what the player pointed at.** A `floor` action recorded
the tower's origin CELL, and playback resolved it with `towerAtCell` - which
matches bounding BOXES. Tetrominoes are L- and S-shaped, so two tiles sharing no
cells can still have overlapping boxes, and playback built on the neighbour. The
live click resolves the tile by raycast; playback used a different function and
got a different answer. Actions now record the tile's pool INDEX.

A fourth, which was a gameplay bug in its own right: `canBuild` never checked the
tower was still standing, so a click landing as a creep took the last block was
charged for and built onto a pooled tile.

### The rules that follow

- **Animations may be cut short; state may never wait for one.** If a tween's
  callback changes anything the world depends on, it is in the wrong place.
- **Never decide anything from a mesh.** Meshes are a picture of the state, and
  the picture is interpolated. Read the state.
- **Record identity, not a description of it.** An index names one tile. A cell,
  a position or a name has to be resolved, and any second way of resolving it is
  a second chance to disagree.
- **Playback must never need a human.** The upgrade screen pauses the game, and a
  paused game cannot advance to the recorded pick that dismisses it - so it
  deadlocked. Playback takes the recorded card without opening the screen.

### Finding the next one

The run file carries per-tick arrays - `draws` (sim RNG draw count), `hits`
(damage dealt), `board` (a position-weighted hash of every standing tower),
`cool` (turret cooldowns) and `pos` (creep positions) - plus a `trace` every 30
ticks holding the actual tower and creep lists, and a `diverged` report naming
the first tick each of them parted company.

The ORDER they diverge in is the diagnosis. RNG draws first means something drew
an extra value. Damage first, with the draws still level, means combat resolved
differently on identical rolls - which is how both LOS bugs were found. Board
first with no creeps on the field means a build went somewhere else.

Totals are not enough, and that cost a day: two boards with the same tower count
and the same floor count can disagree about which tower is which height, and it
stays invisible until a creep knocks the last block off one of them. Hash the
distribution, not the sum. Sample per TICK, not per window - the first divergence
was usually a single tick that corrected itself on the next one.

## Adding to the game without breaking this

- New randomness: is it something the world depends on? `simRand()`. Is it a
  particle or a pitch? `Math.random`. When unsure, ask whether two playbacks
  differing on it would matter.
- New timers: `Demo.after()`, not `setTimeout`, if it changes anything.
- New player input: one `run.record()` at the point the action is committed
  (after its affordability check), and one case in `RunRecorder.apply()`.
- New animation: never make state wait for it.
