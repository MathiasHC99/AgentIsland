# Technical requirements to consider

Date: 2026-10-07
Status: broader-project proposals, with a visual MVP update below.

Update, 2026-10-27: a visual-only island MVP is now authorized and implemented in `prototype/`. It uses a buildless browser application, Canvas 2D, and an independent axial-coordinate world model. The proposals below remain considerations for the broader project; they are not all part of the MVP.

Workbench update, 2026-10-27: Hex 01 at `(0, 0)` now has the first station. Its browser-local queue validates job availability, agent availability, and assignment ownership, and saves jobs in local storage. A labelled preview agent demonstrates the lifecycle. Connecting independent AI processes will still require a shared authoritative queue and an agent interface; browser storage is not that integration.

Additional stations, 2026-10-27: the helpdesk and spa now share a single browser-local store with the workbench. Help requests have open/resolved states. Agent availability includes relaxing and sleeping; these prevent pickup, and a busy agent cannot rest until its assignment is finished or returned. Existing workbench saves migrate to the extended schema. Station metadata survives terrain edits, and same-origin tabs coordinate through the store and Web Locks when available.

The [2026-10-27 session recap](../sessions/2026-10-27.md) records the final implementation, file responsibilities, persistence limits, private preview, 25 passing automated tests, and browser verification. The remaining sections below describe broader project needs; they should not be read as a list of already implemented features.

The user has confirmed an expandable hexagon world, individual agent avatars, movement, and interaction with agents and the world. The technical choices below are recommendations derived from that concept, not additional confirmed product requirements.

## 1. World representation and expansion

Needed to support the confirmed concept:

- Give every hexagon a unique coordinate and store its properties independently of its visual appearance.
- Find the six neighboring positions for each tile.
- Add tiles during a session without rebuilding or resetting the world.
- Preserve existing agent positions and objects when the world expands.
- Reject duplicate tiles and resolve movement only through existing, traversable terrain.

Suggested approach: axial hex coordinates `(q, r)` and a sparse coordinate-to-tile map. This supports irregular islands without allocating an entire rectangular map.

Prototype choices: flat-top hexagons, adjacent-only additions, and meadow, grove, wildflower, and earth terrain. Still undecided for agent navigation: whether one hex is a walking position or a larger area. Navigation must follow the chosen tile scale.

## 2. Agent identity and state

Needed to support individual avatars and interactions:

- Give each agent a stable ID separate from its display name and avatar artwork.
- Track its position, destination, and current activity.
- Associate visual state with actual simulation state so the avatar communicates what the agent is doing.
- Distinguish an action request from an accepted, completed, or failed action.

Suggested activity states: idle, moving, interacting, and working. Waiting, disconnected, or error states may be useful when external agents are connected.

Personality, long-term memory, inventories, and skills are optional product ideas, not prerequisites for having an avatar.

## 3. Movement and navigation

Needed to support walking:

- Find a route through valid neighboring positions.
- Animate movement between positions while maintaining a clear logical position.
- Handle unreachable destinations without leaving an agent permanently stuck.
- Recheck routes when relevant terrain or destination conditions change.

Suggested approach: A* over the hex grid if movement is tile-to-tile. The pathfinding rules should match terrain costs and permitted movement.

Still undecided: whether agents share tiles, collide, reserve destinations, or queue for occupied locations. Those rules affect navigation and interaction design.

## 4. Actions and interactions

Needed to support agents interacting with the world and one another:

- Define supported actions and the information each action needs.
- Check whether an action is valid in the current world state.
- Apply world changes through one authority that resolves conflicting requests.
- Return a clear outcome so agents can choose their next action.
- Record who interacted with whom or what, and what happened.

Possible actions include moving, inspecting a tile, talking to an agent, and using an object. Exact actions remain undecided.

Interaction range, conversation mechanics, object capabilities, and collaboration rules need product decisions before detailed technical design.

## 5. Agent connection interface

Conditional requirement: this matters if the inhabitants are existing AI agents or independently running processes.

- Provide a defined way to observe relevant world state, submit actions, receive outcomes, and exchange messages.
- Keep connection-specific code behind adapters so different agent systems can use the same world rules.
- Handle slow responses, timeouts, reconnects, and repeated requests without duplicating world changes.
- Keep credentials outside avatar data and world files if external services need authentication.

Suggested boundary: an agent requests an action; the world validates and executes it. Agents should not directly rewrite shared world state.

If the inhabitants are internal game characters, a simpler controller interface can fulfill the same conceptual role. No specific external agent platform has been selected or verified as compatible.

## 6. Simulation and rendering

Recommended foundation:

- Separate world rules, agent controllers, and visual presentation.
- Keep one authoritative world state; this could be in the local application and does not imply a hosted server.
- Advance logical activity through a simulation clock or event scheduler.
- Animate avatars smoothly between logical updates.
- Allow long-running agent work to finish asynchronously without blocking movement or the interface.

Model calls, if used, should happen for meaningful decisions or conversations rather than on every animation frame.

This separation would make it possible to change the visual style or agent provider without rewriting the world rules.

## 7. Saving and recovery

Recommended if the island should persist between sessions:

- Save tile coordinates, tile properties, agent identities, avatar selections, and logical positions.
- Save enough activity information to recover into a valid state.
- Version the save format so future world features can be introduced deliberately.
- Define whether unfinished actions resume, cancel, or require reconciliation when reopening.

An external job may still be running after the application closes. Saving an avatar's activity alone would not establish whether that job completed.

The accepted prototype persists browser-local station data. Persistent terrain/world saves, background operation, and recovery of external jobs remain unimplemented and undecided.

## 8. User interface and visibility

Recommended for understanding and managing the island:

- Pan and zoom around the map.
- Select an agent or tile to inspect its state.
- Preview a proposed new tile and show whether placement is valid.
- Show agent activity and interaction history in readable form.
- Surface failed or waiting actions instead of showing indefinite movement or work animations.

If pause is included, define its scope: pausing the world does not necessarily stop an external agent or its tools.

## 9. Performance and extensibility

Requirements need agreed scale targets before selecting infrastructure:

- Expected number of simultaneous agents.
- Typical and maximum tile counts.
- Expected interaction frequency and conversation volume.
- Whether the program runs locally, in a browser, or on a hosted service.
- Whether one user or multiple users can edit the same world.

Recommended design considerations:

- Draw the visible portion of a large map where practical.
- Avoid recalculating every path on every visual frame.
- Bound retained activity history and concurrent agent work.
- If model APIs are involved, define call frequency, concurrency, and cost limits.
- Represent tile types and interaction definitions as extensible data where appropriate.

The prototype runs in a browser and has a private Sites preview. Production hosting architecture, scale targets, performance benchmarks, and multiplayer requirements remain undecided.

## 10. Future verification criteria

These are candidate acceptance checks for the broader project. The implemented subset and its verification are recorded in the session recap:

- Adding a tile preserves existing tiles and agent positions.
- Every existing agent has a distinct ID and an associated avatar.
- Agents can reach accessible destinations and report inaccessible ones.
- An agent-to-agent interaction has a visible result and a recorded outcome.
- A world interaction produces a valid state change or a clear rejection.
- Concurrent requests cannot corrupt shared world state.
- If persistence is included, reopening restores a consistent world.
- If external agents are included, a slow or disconnected agent does not freeze the interface.

## Suggested conceptual structure

1. Presentation: map, avatars, animation, and inspection controls.
2. World simulation: tiles, positions, navigation, and interaction rules.
3. Agent controllers or adapters: observations, decisions, actions, and messages.
4. Storage, if persistent sessions are chosen.

These are logical responsibilities, not a recommendation to create separate services.

## Open decisions for the full project

- Existing work-performing agents, internal simulated characters, or both?
- Browser application, desktop application, or another format?
- Tile-to-tile walking or free movement within larger hexagonal areas?
- Visual style and camera: top-down 2D, angled 2D, or 3D?
- Single-user local world or shared online world?
- Persistent sessions or temporary sessions?

The largest unresolved dependency is what “agents” means here. That determines how much integration infrastructure the project needs.
