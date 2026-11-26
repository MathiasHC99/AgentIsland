# AgentIsland — working vision

Started: 2026-10-07
Phase: visual world MVP with workbench, helpdesk, and spa stations, authorized on 2026-10-27. Real-agent integration remains in brainstorming.

“AgentIsland” is a working name taken from the workspace folder, not a confirmed product name.

See the [2026-10-27 session recap](../sessions/2026-10-27.md) for the accepted prototype, verification, and handoff. The user approved the current appearance and station behavior and ended the session with documentation.

## The idea

A game-like program where the user's agents inhabit a shared world. Each agent has its own avatar and can move around, interact with other agents, and interact with the world.

## Requirements stated by the user

- The world is made of hexagons.
- It must be possible to add more hexagons and expand the world.
- Every agent has its own avatar.
- Agents can walk around.
- Agents can interact with one another and with the world.
- Begin with brainstorming; on 2026-10-27 the user authorized a small visual prototype of the island.
- Make the starting hexagons playful and attractive, with grass, dirt, and optionally trees.
- Put a workbench station on Hex 01, the starting hexagon, where jobs are posted for available agents to pick up.
- Consider other stations such as a helpdesk and a spa for resting or sleeping between jobs; start by implementing the workbench.
- After approving the workbench, the user requested more stations; the helpdesk and spa were implemented and approved as part of the prototype.
- Maintain Markdown files containing ideas and what has been discussed.

## Possible direction — not decided

The island could be a shared workspace represented as a game world. Locations give agents reasons to move: visiting a library to find knowledge, meeting another agent to collaborate, or entering a workshop to work on a task.

Another possibility is a simulation focused on exploration and social behavior. We have not decided whether the world should support actual agent work, simulated activities, or both.

## Questions that shape the concept

- What agents will inhabit it: existing coding or assistant agents, newly created characters, or both?
- What does an interaction accomplish: a conversation, a shared task, a change to the world, or an animation?
- How much freedom should agents have to choose their actions?
- What role does the user play: observer, direct controller, world builder, or task assigner?
- What causes the world to expand, and who can add tiles?

The visual prototype uses a buildless browser application with Canvas 2D, an angled miniature-island style, and a renderer-independent hexagon model. These are prototype choices, not a final product stack or architecture. The initial world includes 23 tiles, trees, wildflowers, and exposed soil, with controls for viewing, expanding, and painting the island. Hex 01 at `(0, 0)` hosts the workbench, Hex 03 at `(-2, 1)` hosts the helpdesk, and Hex 16 at `(1, 1)` hosts the spa. The stations share browser-local jobs, help requests, and preview-agent availability. Real-agent integration remains undecided.

Technical considerations are recorded in [technical-requirements.md](technical-requirements.md). They are proposals and derived needs, not an approved implementation plan.
