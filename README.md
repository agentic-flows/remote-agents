# Remote Agents

Run OpenCode coding agents remotely on Cloudflare infrastructure. Chat with an orchestrator to launch, monitor, and manage agents that work on Linear issues in isolated containers.

## Architecture

```
You (chat/dashboard)
  ↓ WebSocket
Orchestrator (AIChatAgent DO)
  ├── lb tools (find work, read issues, track status)
  ├── container tools (launch, check, message, abort)
  └── this.state.agents (persistent agent registry)
        ↓ Sandbox DO per agent
      Container (opencode serve + lb + gh + git)
```

- **Orchestrator**: A persistent Cloudflare Durable Object Agent (`AIChatAgent`) that you chat with. It has tools for running `lb` commands and managing containers.
- **Containers**: Each coding agent runs in an isolated Cloudflare Container with `opencode serve`, `lb`, `gh`, and `git`. One container per Linear issue.
- **lb**: The same issue tracking CLI used locally. Runs in both the orchestrator and each container. Syncs to Linear.

## Quick Start

1. Copy `.dev.vars.example` to `.dev.vars` and fill in your keys:

```bash
cp .dev.vars.example .dev.vars
```

2. Install dependencies and run:

```bash
npm install
npm run dev
```

3. Open http://localhost:8787 — chat with the orchestrator to launch agents.

## Required Secrets

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | LLM API access for orchestrator + agents |
| `GH_TOKEN` | GitHub token for pushing branches and creating PRs |
| `LINEAR_API_KEY` | Linear API access for `lb` issue tracking |

## Project Tracking

This project uses [lb (linear-beads)](https://github.com/anomalyco/linear-beads) for issue tracking. All tasks live in Linear under the **AGE** team.

```bash
lb sync        # Pull latest from Linear
lb ready       # See available work
lb show AGE-XX # Read issue details
```

## License

MIT
