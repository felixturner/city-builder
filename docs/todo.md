# TODO

## STRATEGY
- make ammo meaningfull
- encorage smallr lots?
- too easy
- needs more strategy??/
- more variety - game is monolithic all feels the same???
- attack is overwhelming no idea whats happening - less creeps? creeps come from one side?
- ammo never runs out?
- make more about building less about defeinding
- make the trails do more.hurt bad guys?
- needs more strtegy for tile placement
	- closed walls are stronger?
	- diff colored area gens? limit on area gen size to encorage different plots?
- add more unit types like 9 kings (adjancy boosters)
- add more turret types
- more creep types
- ammo generators tiles
- make things morre expensive later? add more things to buy?
- add difficulty level setting like 9 kings?
- lots more tile varity like 9 kings? introduce them over time with a card explaing what they do?
- allow saving points/pieces for attack waves
- add 3 difficulty levels - chill, regular, hard
- make completing wall rings more important. buff walls that are completed x2 def.

## FIXES
- fix balancing
- allow board bigger?
- make droppable vs blocked ghosts easier to see at small sizes
- fix timing on attacks / knocks + sounds
- improve high score table
- check swarm arrow flashing
- new encluosre sound sounds like power down?
- keep attacks swarms in one dir until boss level
- add dec or indicator when at top height
- remove 3rd party blender file. start new clean repo?
- make trails + floors glow less - gets too bright later
- wierd sound when a star is enclosed
- optimize sounds
- do kings scale same as enc gens?
- readd add double swarm dir for later on?
- mark gaps? (too easy?)
- readd big gens?
- make connected path generetors pulse at same time
- make walls have 2 sides inside /outside?
- add big guns like heavy crossbows thta go thru multiple enemeys high damage
- add more high powered creeps
- nicer energy spawn sound
- add back 3 colors per gen type?
- make mobile friendly (right click + R key)

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
- do a sound mix with all volume sliders
- get low poly artist to build models
- make creeps low poly spider mecha (bugs)
- add screen shake, barrel blur etc


