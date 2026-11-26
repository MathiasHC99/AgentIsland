# AgentIsland

A small browser island where you can explore, post jobs, and let an AI team work on them.

## Run locally

Requires Node.js 18 or newer. No packages to install.

```sh
npm run dev
```

Open http://localhost:4173. On PowerShell, use `npm.cmd` if `npm` is blocked by the script policy.

## Use the island

- Explore, add or paint land, and press **V** to enter first-person view. Use **WASD** to move and **E** to visit a station.
- At the **Workbench**, post a job, choose a model, and select **Run with AI team**. Standalone HTML results can be previewed or downloaded.
- Visit the **Spa** for ideas, **Helpdesk** for problems, **Showcase** for finished work, and **Noticeboard** for the project plan.

Keep the tab open while the AI team works. Jobs and results are saved in this browser; terrain edits last for the current visit.

## Configure AI and alerts

Put local settings in the ignored `.env` file (see `.env.example`). Set `OPENAI_API_KEY` for OpenAI, or run Ollama locally to use an installed model. Restart the server after changing `.env`.

Email alerts are optional. Set `N8N_WEBHOOK_URL` and `N8N_WEBHOOK_TOKEN` for your existing n8n workflow. Configure the recipient address in n8n. The hosted Site uses its own runtime settings, not the local `.env`.

## Check and build

```sh
npm test
npm run build
```

Source lives in `src/client/` and `src/server/`. `scripts/` handles packaging, `tests/` holds checks, and `TODO.md` seeds the Noticeboard. The build writes the ignored Sites Worker to `dist/server/`. Earlier planning notes are in [docs/](docs/README.md).
