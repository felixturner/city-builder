# Cards

A pick-one-of-four screen, dealt on every boss round cleared - bosses are every
fourth level, so levels 4, 8, 12, 16 and on. Cards are the only thing in the
game that changes a rule rather than a number on the board.

Everything a card touches lives in `Buffs` (`src/buffs.js`), which the systems
read at the point of use; the cards themselves are `CARDS` in
`src/PowerUps.js`. Adding one is a `Buffs` field and an entry in that list.

`repeat` caps how many times a card can be taken - blank is unlimited. A card
with an `available()` gate is held out of the deal when it would do nothing, so
a soldier buff never appears with no barracks standing.

**Dev:** the *🃏 Cards* button in the Gameplay folder opens the screen on
demand, late cards included, whatever level you are on. It deals from the sim
RNG, so a run recorded after pressing it will not replay.

## The deck

| card | copy | effect | repeat |
|---|---|---|---|
| **Reinforced Walls** | Every wall block soaks one extra hit. | `wallHits +1` | — |
| **Work Crew** | Adds a floor to 20 random walls. | 20 walls, +1 floor | — |
| **Master Builder** | Adds a floor to 10 random buildings. | 10 non-walls, +1 floor | — |
| **Restore the King** | Rebuild the king to full height. | king to max floors | — |
| **Crown the King** | The king gains 2 permanent floors of health. | king max +2 | — |
| **Brittle Swarm** | Creeps arrive with 15% less health. | `creepHp ×0.85` | — |
| **Overclocked Grid** | Generators produce 25% more energy. | `genRate ×1.25` | — |
| **Long Lines** | Support towers reach 2 cells further. | `supportReach +2` | — |
| **Wider Hand** | One more tile slot in the palette. | `paletteSlots +1` | 3 |
| **Fast Supply** | Palette slots refill 25% faster. | `refillRate ×0.75` | — |
| **Heavy Rounds** | Bullet turrets do +1 damage per shot. | `shotDamage.peg +1` | — |
| **Focused Beam** | Laser turrets do +2 damage per shot. | `shotDamage.laser +2` | — |
| **Heavier Shells** | Mortars do +4 damage per blast. | `shotDamage.mortar +4` | — |
| **Rapid Cycling** | All turrets reload 20% faster. | `fireRate ×0.8` | — |
| **Bigger Reserves** | Energy capacity +50. | `energyMax +50` | — |
| **Salvage Crews** | Everything costs 15% less to build. | `buildCost ×0.85` | — |
| **Larger Garrisons** | Barracks support one more soldier per floor. | `squadPerFloor +1` | — |
| **Veterans** | Soldiers survive 2 more hits. | `soldierHp +2` | — |
| **Wider Aegis** | Shields cover 2 more cells of radius. | `shieldRadius +2` | — |

## Late game - level 12 and up

Held out of the deal until level 12, which is where the board stops growing: it
opens two lots per boss cleared and caps at eleven, so 4, 8 and 12 are the last
of them. From 13 on the only thing that can still grow is what is already
standing, while the creeps keep ramping.

Every card above is a few percent of something. These change the shape of a
last stand rather than its numbers, so the ending differs run to run.

| card | copy | effect | repeat |
|---|---|---|---|
| **Double Time** | Every build click raises two floors. You pay for both. | `floorsPerBuild = 2` | once |
| **Rubble Crews** | Ten walls come back a floor at the end of every round. | `rebuildPerRound +10` | 2 |
| **Field Guns** | Every gun hits one harder - rifles, lasers and mortars. | +1 damage to all three | once |

**Double Time** is the only card that buys ACTIONS. The late game does not run
out of energy - a logged run finished level 17 with the bar healthy - it runs
out of clicks, because walls come down faster than hands can replace them.
Charging for both floors keeps it a conversion of surplus energy into speed
rather than a discount.

**Rubble Crews** is recurring rather than one-shot, so it answers that same
failure for the rest of the run instead of once.

**Field Guns** is the three single-gun damage cards at once, which is what a
level-17 wave is priced against.

## What is deliberately not here

A card that fires during a wave. Every card lands on a cleared board, so
anything that needs live creeps - an airstrike, a panic button - does nothing
at the moment it is picked. Held cards would need a slot in the tile palette to
play from, which is a bigger change than the deck.
