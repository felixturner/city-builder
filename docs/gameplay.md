# Modular City Incremental: Game Design Document

## 1. Core Interaction Model
* **Two Primary Inputs:**
    * **Add Floor:** Increases the height of a building at the cost of resources.
    * **Delete Building:** Removes a tower and replaces it with a **random** Level 1 building (Gacha mechanic).
* **Adjacency Bonus:** Identical building types (color-matched) placed next to each other create a production multiplier.
* **Block Completion:** Once the resource targets (Red, Blue, Green) are met, the block "completes" and a new empty grid spawns adjacent to it.
* **Different effectx per Block Type:** For example:
    * **grow blocks** slowly grow up adajacent block
    * **generator blocks** generate resources
    * **turrets** shoot bad guys
    * **healers** heal tower damage

---

## 2. Resource & Height Mechanics
The Z-axis (height) and spatial layout determine efficiency through specific limiters:

| Resource | Primary Limiter | Height / Spatial Logic |
| :--- | :--- | :--- |
| **Heat (Red)** | **Saturation** | Requires a **Cooling Tower** that is **taller** than the source building to drain heat via gravity. |
| **Electricity (Blue)** | **Resistance** | The signal **fades** over distance; requires local towers or "hubs" to maintain power across the grid. |
| **Data (Green)** | **Congestion** | Each tower has a **limited number of links**; exceeding this capacity slows down production. |

---

## 3. Macro-Strategy & Inter-Block Play
* **Energy Links:** Visual lines link towers across the city.
* **Siphoning:** Players can draw links between different city blocks to balance resources. 
* **The Skyline Puzzle:** Success involves using one block as a "sink" or "utility farm" (e.g., a block of tall cooling towers) to support a high-production industrial block nearby.
* **Dynamic Balancing:** Players must constantly add and delete floors to maintain the correct height differentials for cooling and power distribution. Power flows from higher towers to lower?

---

## 4. Twitch gameplay
* **Side Scroller:** city moves horizontally on a track. you need to build stuff before bbad guys come in or you hit stuff (like Plants versus Zombies, Ball x Pit). turrets shoot bullets to kill bad guys.

## 5. Threats / Negative Pressure (counter to exponential growth)
A clicker needs a downside to fight against. Three abstract options (all reuse existing systems: colors, connectors, ZOC pulses, lot spawning):

* **Entropy / Grey Blight (lead candidate):** Grey desaturation creeps inward from the map edges, one cell at a time. It eats empty slots first, then un-powered towers (knock them to level 0, then to a dead grey state). **Immunity:** a tower inside an active connector's pulse is shielded. So your power network *is* your defense. Negative feedback to sprawl: more area = more perimeter to defend. Pure color logic (grey = absence of color), no sprites. Goal = push the blight back until the whole grid is lit.
* **Color Imbalance (economy layer):** Three mana pools (R/G/B). Each colored plus block drains its own pool to stay lit. If a pool hits zero, that color's connectors snap and those towers decay. Forces balancing all three colors instead of spamming one. Tension is internal/self-inflicted rather than an external enemy.
* **Creep Nodes (tower-defense flavor):** Abstract "anti-blocks" (black diamonds) spawn on the frontier and march toward the core along roads. A plus block whose ZOC covers a creep zaps it. Closest to a classic TD loop, but abstract.

**Direction:** Entropy (#1) as the core threat + Color Imbalance (#2) as the resource economy. Entropy = something to defend; pools = something to balance.

## 6. Height Differential (water-pressure flow)
Connectors should respect height like water pressure: **energy flows from a TALLER plus block to a SHORTER one** (high → low). Implications:
* A trail only forms/flows if there's a height drop between the two plus blocks (equal height = no flow, or a weak trickle).
* Production scales with the height *differential*, not just proximity — steeper drop = stronger flow.
* Creates a build puzzle: you need tall "source" towers feeding shorter "sink" towers, and must keep re-tuning heights (ties into the Cooling/gravity logic in §2).
* Visual: trail animation direction = downhill; could fade/taper toward the low end.

## 7. Combat / Wave Pacing (TODO)
Now that we have defenses (turrets, power-line frys, grey walls), the threat side needs structure:

* **Big enemies:** add larger/tankier creep types (mini-bosses) alongside the small diamonds — more hits to kill, knock more floors, maybe slower. Variety so it's not a uniform trickle.
* **Waves, not a constant stream:** spawn creeps in discrete waves with a lull between them, so the player gets a breather to rebuild/expand. Escalating wave size/difficulty.
* **Build phase vs. enemy phase (maybe):** consider turn-based-ish pacing — a calm "build" phase, then an "enemy" phase where a wave attacks. Clear rhythm of prepare → defend → prepare.

## 8. Lot Spawning — make it deliberate, not random (TODO)
Current logic spreads from a *grown* lot into a *random* empty neighbour, which feels arbitrary. Flip the ownership:

* **Empty lots pull, don't get pushed.** Each empty (dormant) lot looks at its own neighbours; when an adjacent active lot crosses a level/strength threshold, *that* empty lot activates itself. Deterministic and directional — growth follows where you've actually built up, instead of a random coin-flip among neighbours.

## 9. Why build grey blocks? (TODO)
Grey (plain) blocks need a real purpose beyond mana trickle + lot points. Ideas, ranked by synergy with existing systems:

* **Walls that channel creeps (lead):** tall grey blocks become *impassable* — creeps path around them instead of just bonking them. Greys turn into maze-walls that funnel creeps into turret range rings. Height = wall strength. Gives greys a spatial job and ties into turret placement.
* **Adjacency buffs:** a grey block next to a turret/generator boosts it (e.g. +1 turret range or +fire rate, +mana to a generator). Reuses neighbour logic; rewards packing greys around key blocks.
* **Mana capacity:** each grey block raises *max* mana (e.g. +5 cap). Generators fill the pool; greys size it. Build-up loop: more greys → bigger reserve → bigger spend bursts.
* **Shields / line-of-sight:** grey blocks block shooter-creep shots to the towers behind them. Build ramparts in front of generators/turrets so shooters waste shots on the wall.
* **Population = the stakes:** total grey count/height is your score; creeps eroding them to empty-towers is the loss pressure. Pure stakes, no new mechanic.

**Direction:** Walls (#1) + adjacency buff (#2) together — walls give greys a tactical job, adjacency makes you *want* clusters around turrets. Both reuse pathfinding + neighbour logic.

## 10. Player Agency: Choose-from-3 + Build Timer (NEW direction)
The pure-random gacha (knock down → get a random Level 1 building) gives no agency. Replace/augment it with deliberate choice, gated by cost and time so it's not free spam.

* **Choose from 3:** when building (or rebuilding a knocked-down slot), the player is offered **3 random options** and picks one. Randomness still *proposes* (you don't get a free pick of anything), but the player *disposes* (you choose among the three). Turns "matching colors" from luck into a real puzzle.
* **Reroll/knockdown costs energy:** knocking down a building costs energy (not free), making it a resource decision rather than infinite re-rolling.
* **Build wheel timer:** building/rerolling also takes **time** — show a small radial timer (a ring that fills clockwise) over the slot while it builds. Gates the action-per-second rate and adds a moment of commitment/anticipation. The slot is locked until the ring completes.

## 11. Building Variety + Resource Types (TODO / discussion)
Current building types are thin: generator / turret / grey. Need more variety, ideally tied to a richer resource economy.

* **Beyond one resource:** promote the existing R/G/B color matching into **3 distinct resources** (already designed in §1/§2/§5 as Heat/Electricity/Data, currently collapsed into a single `energy` pool). Each color generator feeds its own pool; different buildings cost/consume different colors.
* **More building types:** beyond generator/turret/grey, consider healers (§1), cooling towers (§2), walls (§9), hubs/relays (§2 resistance), converters (turn one resource into another), etc. Each should have a clear job that interacts with the resource economy and/or the threat side.
* **Open question:** how many resources keeps it "super simple"? 3 (R/G/B) maps cleanly onto the colors already in play; more than that risks complexity creep.

## 12. Carcassonne Scoring Model (lead building strategy)
The building game becomes a **Carcassonne-style spatial puzzle**: three independent point strategies, each rewarding a *different shape*. The player picks which to chase (or mixes all three), and skill is in placing blocks to maximize each feature's scoring rule. The strategies compete for the same grid space, which is where the tension/depth comes from — roads want long lines, monasteries want dense clusters, cities want closed loops.

The three strategies, mapped to Carcassonne features:

* **Energy trails = Roads (score by length).** The longer a connected energy trail runs, the more energy/points it generates — like a road scoring per tile of length. Rewards stretching connections into long routes rather than short stubs. Maps onto the existing power-line trails between generators.
* **Dot blocks = Monasteries / Cloisters (score by density / being surrounded).** A "dot" block scores more the more it's clustered — surrounded by / packed near other blocks (Carcassonne cloisters score for the 8 surrounding tiles being filled). Rewards tight, dense neighborhoods — the opposite spatial goal from roads.
* **Grey walls = Cities (score by matching / enclosing).** Grey walls score city-style: edges must **match up and connect** to form enclosed regions, and a completed/sealed city scores big. Rewards careful edge-alignment so wall segments join into closed loops.

**Why it works:** each strategy wants a different shape, and they contend for the same space, so the player constantly trades off "extend the road vs. close the wall vs. pack the cloister."

**Open questions to nail down:**
* Dot/monastery scoring — count *adjacent filled neighbors* (the 8-surround rule), or *proximity to other dot blocks specifically*?
* Grey-wall "matching" — edges literally lining up to enclose an area, or just same-type walls being adjacent?

## Ref games:
- [Carcassonne](https://en.wikipedia.org/wiki/Carcassonne_(board_game)) (roads/cloisters/cities = 3 spatial scoring strategies)
- [Townscaper](https://oskarstalberg.com/Townscaper/)
- King is watching (create blocks to gather resources)
- Plants versus Zombies 
- Ball x Pit
- Tower defense (what is attacking?) asteroids? birds?

