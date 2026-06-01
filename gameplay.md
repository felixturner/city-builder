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

## Ref games:
- [Townscaper](https://oskarstalberg.com/Townscaper/)
- King is watching (create blocks to gather resources)
- Plants versus Zombies 
- Ball x Pit
- Tower defense (what is attacking?) asteroids? birds?

