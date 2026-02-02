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

## Ref games:
- [Townscaper](https://oskarstalberg.com/Townscaper/)
- King is watching (create blocks to gather resources)
- Plants versus Zombies 
- Ball x Pit
- Tower defense (what is attacking?) asteroids? birds?

