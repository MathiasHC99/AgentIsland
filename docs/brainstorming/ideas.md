# Idea bank

This bank preserves ideas for discussion. Some have now been explored in the prototype; their implemented scope is recorded in the [2026-10-27 session recap](../sessions/2026-10-27.md). The remaining possibilities are not approved commitments. Confirmed requirements are in [vision.md](vision.md).

## The hexagon world

- Start with a small island and expand by attaching hexagons along its edges.
- Give tiles different purposes: open ground, paths, meeting areas, libraries, workshops, gardens, or resource sites.
- Let the user choose what a newly added tile becomes.
- Explore agent-requested expansion: an agent proposes a new location when existing space is insufficient.
- Consider whether hexagons are individual walking spaces or larger areas containing multiple positions.

Questions: Is expansion manual, earned through progress, or automatic? Can multiple agents occupy a tile? Are there blocked tiles or terrain costs?

## Avatars and presence

- Give each agent a distinct appearance, name, and color.
- Show simple activity cues such as walking, working, talking, waiting, or resting.
- Let the user select an avatar to see its current task and recent activity.
- Make identities persist between sessions if a persistent world fits the concept.

Questions: Should avatars be customized by the user, generated, or selected from presets? Should the view be top-down or angled? What visual style feels right?

## Interactions between agents

- Meet at a shared location to discuss a task.
- Ask another agent for help or hand over work.
- Share findings through a library or message board.
- Work together in a workshop.
- Use speech bubbles for brief visible activity, with a readable conversation history available on selection.

Questions: Does proximity enable conversation, or simply visualize it? Can agents communicate across the map? Which interactions involve real agent messages and which are simulated?

## Interactions with the world

- Visit a task board to choose work.
- Use a library to retrieve or contribute knowledge.
- Use a workshop to create an artifact.
- Explore new tiles and discover locations.
- Build or improve shared facilities if construction becomes part of the experience.

Questions: Are resources and buildings meaningful constraints, visual metaphors, or game mechanics? What useful output should an agent's activity produce?

## The user's role

- Observe the island and inspect what each agent is doing.
- Give agents tasks or destinations.
- Add tiles and place locations.
- Pause activity to inspect or rearrange the world.
- Review proposed world changes if agents can suggest construction or expansion.

Questions: How hands-on should the experience be? What can agents decide independently?

## Possible first experience — discussion sketch only

A small hexagon island with a few distinct avatars, a meeting spot, and a workshop. The user gives one agent a task; the agent travels to a relevant place, meets another agent for help, and produces a visible result. The user adds a tile to expand the island.

This is a way to test the concept mentally, not an implementation plan.

## Topics to revisit later

- Extend the implemented helpdesk beyond browser-local questions and resolution into real agent-to-agent help and knowledge sharing.
- Extend the implemented spa beyond preview-agent relaxation and sleep into real agent visits between jobs.
- Travel to the starting workbench to pick up posted jobs; the first workbench and browser-local queue are implemented, while real-agent travel and execution are future work.
- Whether idle agents should visit the spa automatically, and how a new job should wake or summon them; today's preview visits are manually controlled.
- Whether the world continues running while the user is away.
- How agent identities, memory, conversations, and world changes are saved.
- How users understand why an agent moved or acted.
- How to prevent an agent from getting stuck or repeating an unproductive action.
- Whether game events are separate from actual agent work or directly connected to it.
- How many agents the world should support.
- Any rules for external actions, if agents eventually use tools beyond the world.
