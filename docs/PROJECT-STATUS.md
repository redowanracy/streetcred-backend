# Street Cred backend — what exists, and what multiplayer would need

Last updated 20 September 2026.

This document is for the game developer and the project owner. It describes, in plain terms,
every endpoint the backend provides today, what is deliberately not finished, and what would
have to be added if the game gets multiplayer.

Technical detail lives elsewhere: [API.md](API.md) is the written reference, `openapi.yaml`
is the machine-readable spec, and `streetcred.postman_collection.json` can be imported into
Postman to try every request. While the server runs, `/api/v1/docs` opens a browsable version
of the same thing.

---

## Part 1 — What the backend does today

The backend is **server-authoritative**: the server decides how much money a player has, whether
a mission was really completed, and what a purchase costs. The game client asks; it never decides.
This is the main difference from the earlier prototype, where the phone kept its own balance and
could be edited by anyone.

There are **58 endpoints**. They cover nine areas.

### Accounts and sign-in (14 endpoints)

| What a player does | How it works |
|---|---|
| Plays without signing up | A guest account is created on first launch. Nothing to fill in. |
| Signs up later | Email and password. The guest's progress carries over — same account, nothing lost. |
| Signs in on a new phone | Email and password. |
| Forgets the password | A reset link is emailed. The link works once and expires in 30 minutes. |
| Changes the password | Other devices are signed out. |
| Signs out | One device, or all devices. |
| Deletes the account | Everything is removed. Required by Google Play and the App Store. |

Sessions use two tokens: a short-lived one for normal requests and a long-lived one to get new
short-lived ones. The long-lived token changes every time it is used, so a stolen copy stops
working as soon as the real player plays again.

**Google and Apple sign-in**: the endpoints exist and the account handling behind them is written
and tested. Only the step that checks the token with Google or Apple is missing, so they currently
answer "not implemented". The request format will not change when they are switched on, so the
client can be built against them now.

### The player (4 endpoints)

One request returns everything the game needs at launch: level, XP, cash, gems, stamina, the
vehicles owned, the items held, and any mission still in progress. There is also renaming,
a full history of every coin earned or spent, and account deletion.

### Game settings and catalogs (3 endpoints)

Prices, reward sizes, the XP curve, how fast stamina refills, daily limits — all of it is stored
on the server and sent to the game. **Changing the balance of the game does not require an app
update.** Alongside it are the catalogs of every vehicle and every item.

### Missions (9 endpoints)

| Step | What the server checks |
|---|---|
| Find missions nearby | Real distances, sorted by how close. Each one says whether this player can start it, and if not, why (too low a level, still on cooldown, already done). |
| Start a mission | That the player is actually near it, is high enough level, is not on cooldown, and has enough stamina. Stamina is charged here, and the reward is fixed at this moment. |
| Finish it | That the attempt is still running, has not timed out, and was not finished impossibly fast. The reward is then paid — **once**, no matter how many times the request arrives. |
| Fail or quit | Recorded. Stamina is not refunded. One free retry is offered for a short while, matching how the game already works. |
| Resume | If the player closes the game mid-mission, the app can ask what they were doing and continue. |
| History | Their recent attempts. |

The reward is decided and paid by the server. A player cannot tell the server they won.

### Garage (5 endpoints)

Buy a vehicle, equip it, upgrade speed, acceleration or handling, and save paint and underglow
colours. Upgrade costs rise with each level. The server refuses purchases the player cannot
afford, and an interrupted purchase that is retried never charges twice.

### Items and shop (5 endpoints)

See what the player owns, wear an outfit, sell items for cash, browse the shop and buy offers.
Offers can have a per-player limit and a start and end date.

### Money-related (3 endpoints)

Rewarded ads and the Founders Pass work in development mode so the game can be tested end to end.
**They are not connected to real ad networks or app stores yet**, which is deliberate: a phone
saying "I watched an ad, pay me" is not proof, and neither is "I bought this". Both need the
provider to confirm it directly with our server. The endpoints and the request formats are ready
for that step.

### Admin tools (13 endpoints)

Enough to run the game without touching the database: place and edit missions on the map, manage
the vehicle, item and shop catalogs, change any game setting live, look up a player, correct a
balance (always recorded, with a note), and ban or unban someone.

### Health checks (2 endpoints)

For monitoring, so an outage is noticed before players report it.

### What is deliberately unfinished

| Area | State |
|---|---|
| Google / Apple sign-in | Endpoints and account handling done; token verification missing |
| Password reset emails | Working, but no email provider connected — the link is only logged |
| Real purchases (IAP) | Placeholder; needs store receipt verification |
| Rewarded ads | Development mode only; needs the ad network to confirm views |
| Consumable items | Can be bought, held and sold; using them is not defined yet |
| Multiplayer | Not started — see Part 2 |

### How we know it works

70 automated tests run against a real database and cover every endpoint, including the parts that
are easy to get wrong: two purchases at the same instant cannot overspend, a mission reward cannot
be paid twice, and a stolen session token stops working. Every endpoint has also been called
against a running server, and those real responses are the examples in the Postman collection.

---

## Part 2 — If the game gets multiplayer

Nothing below is built yet. It is a description of the work, so the owner can decide what is worth
doing. The important point first:

> **Most of the multiplayer that suits this game does not need players to be online at the same time,
> and does not need a second kind of server.** Only live, see-each-other-move play does.

### The cheap kind: players share a world, not a moment

These run on the existing backend. No new infrastructure, no extra hosting cost.

**Leaderboards** — fastest times per mission, most missions completed, richest crew; weekly and
all-time. The data already exists: every attempt is recorded with its duration. This is mostly
new queries and a screen in the game.

| Endpoint | Purpose |
|---|---|
| `GET /leaderboards/missions/{missionId}` | Fastest completions of one mission |
| `GET /leaderboards/players` | Global and city rankings, weekly or all-time |
| `GET /leaderboards/crews` | Crew rankings |

**Crews** — players form a gang, which the game's whole tone already implies.

| Endpoint | Purpose |
|---|---|
| `POST /crews`, `GET /crews/{id}`, `PATCH /crews/{id}` | Create, view, rename |
| `POST /crews/{id}/invites`, `POST /crews/join` | Invite by code or link, accept |
| `POST /crews/{id}/leave`, `POST /crews/{id}/members/{playerId}/remove` | Leave, kick |
| `GET /me/crew` | The player's own crew and its members |

New data: crews, their members and roles, and pending invites.

**Turf control** — the city is divided into a grid of cells shown on the map in each crew's colour.
Completing missions in a cell earns your crew points there; the crew with the most points holds it;
holding it pays a daily bonus. Scores fade over time, so territory has to be defended.

| Endpoint | Purpose |
|---|---|
| `GET /turf/nearby` | Cells around the player, with the owning crew and colour |
| `GET /turf/{cellId}` | Who holds it, the score standings, recent changes |

No new player actions are needed: finishing the missions that already exist is what moves the map.

**Ghost races** — on the sprint missions, race against a recorded run of the current record holder.
The attempt record already has room to store the route.

| Endpoint | Purpose |
|---|---|
| `GET /missions/{missionId}/ghost` | The recorded run to race against |

**Why this set is the right starting point**: it works with a small number of players. Twenty players
spread across a city still produce a colourful map and a busy leaderboard, because nobody has to be
online at the same time as anybody else. It also reuses the missions that already exist rather than
requiring new gameplay.

### The expensive kind: players in the same moment

Four players shooting the same drone and seeing each other move. This needs a **second server of a
different type** — the current API is not built for it and cannot be made to do it. Positions have to
be exchanged ten to thirty times a second, which is a different technology from normal web requests.

What it would involve:

- A real-time service. Ready-made options exist for Unity (Photon and similar) so it does not have to
  be written from scratch; they are priced by how many players are connected at once.
- Servers placed near the players, because anything above roughly a tenth of a second of delay feels bad.
- A lobby system so players end up in the same match:

| Endpoint | Purpose |
|---|---|
| `POST /lobbies`, `POST /lobbies/{id}/join` | Create and join a match |
| `GET /lobbies/nearby` | Open matches at this location — the natural fit for this game |
| `POST /lobbies/join-by-code` | Private matches with friends |
| `POST /realtime/tickets` | A short-lived pass that lets a player into the real-time server |
| *(server to server)* | The real-time server reports the result back, and the reward is paid through the existing mission flow |

That last line matters: the match result must come from the real-time server directly to our server,
never from the phone. Otherwise the same problem returns — a player claiming a win they did not earn.

**A middle option worth considering**: a shared goal without shared movement. Everyone near a location
fights their own drones for thirty minutes, and all the kills add up to one community target. Players
feel part of something together, the map shows the progress, and no real-time server is needed. This
can be built on the current backend.

### Decisions the owner needs to make first

1. **Crews**: how many members, can a player be in more than one, who can invite and kick?
2. **Turf**: how do points accumulate, how fast do they fade, and what does holding an area pay?
3. **Leaderboards**: reset weekly, monthly, or never? Is there a prize?
4. **Live play**: is seeing other players move actually necessary, or is a shared goal enough?
5. **If live play is wanted**: how many players in one match, cooperating or against each other, and
   do they have to be physically in the same place?
6. **Text**: crew names — and chat, if any — need moderation and a way to report abuse. This is a
   policy decision with legal weight, not a technical one.

### Suggested order

| Step | What it adds | Cost |
|---|---|---|
| 1. Leaderboards | Competition, a reason to replay missions | Small |
| 2. Crews | Players belong somewhere | Small |
| 3. Turf control | The map becomes a living, contested place | Medium |
| 4. Ghost races | Head-to-head feel on sprints | Medium |
| 5. Shared goals | Group events without new infrastructure | Medium |
| 6. Live co-op | Genuine together-in-the-moment play | Large, plus ongoing hosting cost |

Steps 1 to 5 all run on the backend that exists today. Step 6 is a separate project, and it is worth
doing only once there are enough players in the same city at the same time for the matches to fill —
an empty lobby is worse than no lobby at all.
