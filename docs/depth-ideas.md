# Depth Ideas — new mechanics only

Nothing below currently exists in the game, and none of it is recycled from
`gameplay-ideas.md`. Part 1 = new mechanics that slot into the current game.
Part 2 = new directions that change what the game is about.

---

## Part 1 — New mechanics for the current game

### 1. Terrain — the board stops being flat ⭐

Every run generates board features before you place anything: **rock outcrops**
(unbuildable, but block creeps — free wall segments), **rivers** (creeps can't
cross, you can't build; bridges are choke points for both sides), **high
ground** (turrets get +range, walls +1 soak), **fertile ground** (gens +50%),
**cursed ground** (nothing works, creeps speed up). 

- **Why:** right now the opening is identical every run because the board is
  identical every run. Terrain makes the fortress shape *derive from the map* —
  you anchor walls to rocks, fight over bridges, stretch trails to reach
  fertile patches. Placement becomes "fit my tiles to this land."
- **Replayability:** the cheapest big win available — same rules, different
  puzzle every run, like a roguelike floor layout.
- **Fits the code:** flow field and enclosure flood-fill already handle blocked
  cells (walls); rocks and rivers are just cells that arrive pre-blocked.

### 2. Bait & fear — sculpt the flow field with attraction, not just blocking

Walls are the only flow-field tool, and they only *subtract*. Add two cheap
1×1 tiles:

- **Bait totem** — creeps within range prefer paths toward it. Burns out
  after eating N creep-visits.
- **Fear totem** — cells around it cost extra to path through; creeps avoid
  unless there's no other way.

You can now *pull* a wave into a kill corridor instead of fencing everything,
or split a two-edge wave into two streams on purpose. This is a new verb
(herding) on top of the maze verb, it's dirt cheap in the flow-field code
(bias the BFS costs), and it makes the flow overlay — your best UI feature —
the centre of play. Endgame skill looks like ranching: farm waves through a
funnel you baited, harvest the ammo drops.

### 3. The enemy builds back — nests and sorties

Creeps that survive a round don't just linger: they **plant a nest** where the
wave broke through. Nests corrupt nearby cells between rounds, spawn a trickle
of extra creeps *from inside the board*, and grow if ignored. Soldiers get a
**rally flag** (drag it like a tile) so you can send a squad out to burn a
nest down.

- **Why:** the game is 100% defense; there is no reason to ever leave the
  shell, which is why turtling is solved. Nests create an offense clock —
  every round you didn't clean up makes the map worse — and give barracks a
  real job beyond bodyguarding.
- **This is the anti-samey mechanic:** the mid-game stops being "hold the same
  line harder" and becomes a territory tug-of-war that you can visibly lose
  ground in and claw back.

### 4. Demolition is a weapon

Right-click demolish currently just deletes. Instead: a demolished tower
**topples and detonates** — damage scales with floors, falls in a direction
you choose. Now a 5-floor wall stack is also a stored bomb; sacrificing a
building to wipe the giant chewing on it is a real play; and cheap wall
tetrominoes late-game become deliberate traps you build *in the creep path* to
blow. Uses the cannon-es debris system that already exists for the payoff.
Turns a dead input (demolish = admit mistake) into the game's panic button.

### 5. Structural rot — big connected fortresses become a liability

A new late-game creep (the **Rotling**) doesn't knock floors: it *infects* the
wall it touches. Infection spreads along **connected** wall cells every few
seconds until cleansed (click, costs energy) or until it hits a gap or a
non-wall tile. One monolithic shell = one contagion surface; compartmentalized
rings with tower "firebreaks" in the wall line are immune-by-construction.

- **Why:** this punishes the exact solved strategy (one giant enclosure) with
  *placement pressure* rather than stat pressure — and it does it with the
  connectivity data the enclosure system already computes.
- **Tension to design around:** firebreak gaps must not break the seal — let
  any non-wall building (turret, gen) count as part of the enclosure ring but
  not carry infection. That also finally answers "why put turrets *in* the
  wall?"

### 6. Contracts — the game asks you to build somewhere ugly

Every couple of rounds a **contract** appears anchored to a real spot on the
board: "seal this region within 2 rounds", "get a trail to this marker",
"keep a tower alive on this cursed cell for a round". Payout: big energy /
a free tile / a card. Contracts are the quest-log version of loot crates
(which already prove the pattern works — wall the crate in): they force you
out of your comfort zone *spatially*, so the board keeps getting used instead
of everything huddling in the middle.

### 7. Choose your attacker — wave bounties

Before each round, the countdown shows **two wave options** (edge + flavour +
size) and you pick which one comes; the nastier option carries a bounty
(energy/ammo/card). Player-tuned difficulty per round, push-your-luck greed,
and a reason the same run can be played safe or greedy. Cheap: the wave
system is already deterministic and parameterized; this is a UI choice
feeding it.

### 8. Veterancy — buildings remember

A building that survives a combat phase gains a stripe (cap 3): turrets +dmg,
gens +rate, walls +soak. Losing a veteran hurts more than losing energy —
which means *protecting specific buildings* becomes a goal, forward turrets
are a risk/reward bet, and your city accumulates history you can point at.
Zero new UI beyond stripes; pure emotional + strategic texture.

---

## Part 2 — New directions

### V1. The Royal Procession — the king walks ⭐

Every N rounds the king must **travel** — to a shrine that rises somewhere on
the board — then either stays there (new centre) or returns. While he walks,
he's the target: slow, fat, and outside your best defenses.

- The whole game reframes: you're not defending a point, you're defending a
  **route you have to design in advance** through your own maze. Walls, baits
  (idea #2), and turret coverage get judged against a moving asset.
- Every procession forcibly re-poses the "where is my fortress" question, so
  the layout can never be solved once — the anti-samey property built into
  the structure of the run instead of bolted on.
- Escort rounds are natural drama beats for a 20-min arc: build → defend →
  *procession* (the exam) → rebuild around the new seat.

### V2. The Garden City — you don't build it, you grow it

Flip the core fantasy from architect to **gardener**. Tiles are seeds.
Buildings **auto-grow floors over time when fed by a trail** (trails = water);
starved buildings wither back down. You never click-to-add-floors — you route
irrigation, prune (demolish) growth you don't want, and graft (move a tile
once it's mature). Creep waves are pests; the shield is a greenhouse.

- **Strategy** shifts from placement-then-numbers to *routing and timing*:
  what you water first is what's tall when the boss lands.
- **Why it suits this project:** it keeps the Townscaper toy-soul (watch it
  grow is the pleasure) while the TD layer gives growth stakes. Of all the
  directions, this is the one that makes the *building half* the star, and
  it's visually free — the block-stacking animations already sell it.

### V3. Undermine — dig as the dual of build

Add one new verb: **excavate**. Drag on empty ground to dig moats (creeps
can't cross; neither can your soldiers), pits (creeps fall in, turrets get
free shots), and channels that extend rivers (pairs with terrain, idea #1).
Digging costs energy and is slow — a moat is a *planned* defense, not a
panic one. Meanwhile a **tunneler** creep type digs under walls but is
stopped by moats, so the two defense layers (built vs. dug) counter different
threats and neither alone is sufficient. The board becomes a heightfield you
shape in both directions — genuinely new spatial language for a block game,
and a striking look (Townscaper does water beautifully for a reason).

### V4. The Caravan Economy — defend lines, not regions

Income stops being ambient: **caravans** (little vehicles — the roads/cars
TODO, made mechanical) travel between your districts and off-board trade
gates, and *they* carry the energy home. Creeps ambush caravans; lost cargo
is lost income. You defend arteries instead of areas — turret placement
follows your roads, walls shape safe routes, and a blockade (creeps squatting
on a road) strangles you without touching a single building. The map reads
like a living circulatory system, and "where is my economy exposed?" replaces
"is my circle closed?" as the constant question.

---

## Where I'd start

Prototype **#2 (bait & fear totems)** first — smallest code (flow-field cost
bias), immediately makes placement expressive, and every other idea gets
better if herding exists. Then **#1 (terrain)** for per-run variety, then
**#3 (nests)** to break turtling. Of the directions, **V1 (procession)** is
the strongest fit for "casual but strategic in 20 minutes": it keeps
everything already built and adds the one thing the game lacks — a reason the
answer has to change mid-run.
