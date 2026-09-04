# TODO

## LATE GAME IDEAS
- allow late game to handle mouse clcking date vs creep onslaught
- add new more pwerful cards later in the game
- some cards add a tile to your hand that can be played later - eg airstrike
- allow clicking adds 2 levels not one
- ramp up turret ROF later
- different bosses variations

## LATE GAME CARD IDEAS
- Rubble Crews — walls destroyed during a wave come back at one floor when it clears. Answers "can't rebuild in time" directly, without a repair action during play.
- Last Stand — when the king drops below half height, everything gains a block of HP and turrets fire double for 20s. Turns the grind into a climax.
- Airstrike — one-shot, clears one approach. Buys the run you'd otherwise have lost, once.
- Conscription — every wall inside the king's ring becomes a barracks for one wave.
- Nuke

## LATE GAME TOWERS
- flamethrower
- air bases


## STRATEGY
- more variety - game is monolithic all feels the same???
- make more about building less about defeinding
- make the trails do more. hurt bad guys?
- needs more strtegy for tile placement
	- closed walls are stronger?
	- diff colored area gens? limit on area gen size to encorage different plots?
- add more unit types like 9 kings (adjancy boosters)
- add more turret types
- more creep types
- add difficulty level setting at the start like 9 kings?
- lots more tile varity like 9 kings? introduce them over time with a card explaing what they do?
- allow saving points/pieces for attack waves
- add 3 difficulty levels - chill, regular, hard
- make completing wall rings more important. buff walls that are completed x2 def.
- make walls have 2 sides inside /outside?
- add big guns like heavy crossbows thta go thru multiple enemeys high damage
- add more high powered creeps

## FIXES
- update tute imgs
- fix balancing
- improve high score table
- check timing on attacks / knocks + sounds
- fix kings and shields look the same - add a new color?
- allow board bigger?
- add dec or indicator when at top height
- remove 3rd party blender file. start new clean repo?
- optimize sounds
- readd add double swarm dir for later on?
- mark gaps? (too easy?)
- readd big gens?
- make connected path generetors pulse at same time
- nicer energy spawn sound
- add back 3 colors per gen type?

## BUGS
- WINDOW RESIZE HANGS/STALLS, worse the later the level. ~10s freeze resizing up
  at level 6; a fullscreen->windowed toggle at level 21 locked the tab for good.
  Not a leak - PostFX.render allocates nothing per frame and GTAO's per-frame
  setSize early-outs when unchanged. One resize disposes and recreates the whole
  post chain (scene MRT pass targets, GTAO's half-res target, the blur
  temporaries, the bloom mip chain, plus the mask/overlay/glow targets), and
  every bind group in the scene is rebuilt on the next frame - which is a stall,
  but should not be a permanent hang. Demo.onResize now debounces the expensive
  half by 150ms (helps drags, does nothing for a single toggle) and
  Demo._watchDevice logs device.lost / uncapturederror with the game state, so
  the next occurrence should say whether it is a lost device or a validation
  error. Next step: reproduce with the console open and read the [gpu] line.

## ART
- name game - add splash screen + logo
- add card art 
- do a sound mix with all volume sliders
- get low poly artist to build models <-
- make creeps low poly spider mecha (bugs)
- add screen shake, barrel blur etc


