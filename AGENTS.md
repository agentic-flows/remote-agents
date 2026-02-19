# Remote Agents

Run OpenCode coding agents remotely on Cloudflare infrastructure. Chat with an orchestrator to launch, monitor, and manage agents that work on Linear issues in isolated containers.

## Project Overview

This project builds a **Cloudflare Durable Object Agent** (the "Orchestrator") that manages remote coding agents. Each agent runs `opencode serve` inside a Cloudflare Container (via the Sandbox SDK), working on a specific Linear issue.

### Architecture

```
You (chat/dashboard)
  ↓ WebSocket
Orchestrator (AIChatAgent DO)
  ├── lb tools (lb_ready, lb_show, lb_blocked, lb_sync, ...)
  ├── container tools (launch_agent, check_agent, message_agent, ...)
  └── this.state.agents (persistent agent registry)
        ↓ Sandbox DO per agent
      Container (opencode serve + lb + gh + git)
        ├── opencode session (AI coding agent)
        ├── lb sync (issue tracking → Linear)
        └── git + gh (branches, commits, PRs)
```

### Key Components

| Component | File | Role |
|-----------|------|------|
| **Orchestrator** | `src/orchestrator.ts` | AIChatAgent DO — the brain. You chat with it. |
| **Worker** | `src/index.ts` | Entrypoint, routes requests via `routeAgentRequest` |
| **lb tools** | `src/tools/lb.ts` | AI SDK tools wrapping lb commands |
| **Container tools** | `src/tools/container.ts` | AI SDK tools for Sandbox container lifecycle |
| **Dashboard** | `src/dashboard/` | React chat UI using `useAgentChat` |
| **Container image** | `Dockerfile` | Ubuntu + opencode + lb + gh + git |
| **Entrypoint** | `entrypoint.sh` | Container startup: clone repo, lb sync, opencode serve |

### Technology Stack

- **Cloudflare Workers** — Worker entrypoint
- **Cloudflare Durable Objects** — Orchestrator (AIChatAgent) + Sandbox (container management)
- **Cloudflare Containers** — isolated environments for each agent
- **Agents SDK** (`agents`, `@cloudflare/ai-chat`) — persistent chat agent with tools
- **AI SDK** (`ai`, `@ai-sdk/anthropic`) — LLM integration with tool calling
- **Sandbox SDK** (`@cloudflare/sandbox`) — container lifecycle, opencode integration
- **OpenCode SDK** (`@opencode-ai/sdk`) — programmatic access to opencode server
- **lb** (linear-beads) — issue tracking CLI, syncs to Linear

### How lb Fits In

`lb` is the persistence layer for all agent state — same tool used locally in tmux workflows.

- **Orchestrator** runs lb to find work (`lb ready`), read issues (`lb show`), check deps (`lb blocked`)
- **Each container** runs lb to track its own progress (`lb update --status in_progress`, `lb update --status in_review`)
- **Linear** is the source of truth — lb syncs bidirectionally with offline-first outbox queue
- **The orchestrator's state** (`this.state.agents`) only tracks container ↔ issue mapping. Issue state lives in Linear.

### Configuration

**wrangler.jsonc** — defines Sandbox container binding + Orchestrator DO binding
**Dockerfile** — extends `cloudflare/sandbox:0.7.4` with opencode, lb, gh
**.dev.vars** — secrets: `ANTHROPIC_API_KEY`, `GH_TOKEN`, `LINEAR_API_KEY`

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start wrangler dev server (builds Docker on first run)
npm run deploy       # Deploy to Cloudflare
npm run typecheck    # TypeScript type checking
npm run types        # Generate wrangler types
```

## Linear Project

- **Team**: AGE
- **Project**: remote-agents
- **Scope**: project-based (`repo_scope: "project"` in `.lb/config.jsonc`)

---

## CRITICAL: Task Tracking with `lb`

> **STOP. READ THIS CAREFULLY.**
>
> **DO NOT use your built-in todo/task tracking tools for this repo.**
> **No todo lists, no task trackers, no scratchpads - ONLY `lb`.**
>
> Need to track subtasks or steps? Create subissues:
> ```bash
> lb create "Step 1: ..." --parent LIN-XXX
> lb create "Step 2: ..." --parent LIN-XXX
> ```
>
> `lb` IS your todo list. There is no other.

This repo uses `lb` for all task management. All tasks live in Linear.

### Every Session (MANDATORY)

Run these commands at the **start of every session**, before doing anything else:

```bash
lb sync        # Pull latest issues from Linear
lb ready       # See what's available to work on
```

If you discover bugs or issues while working, create them **immediately** — do not wait:

```bash
lb create "Found: <description>" --discovered-from LIN-XXX -d "Details..."
```

Before ending a session:

```bash
lb sync        # Push any changes back to Linear
```

### Issue Pipeline

Every issue flows through these statuses:

```
todo_needs_refinement → todo_refined → in_progress → in_review → done
                                  ↗
                        todo_bug
```

| Status | Meaning |
|--------|---------|
| `todo_needs_refinement` | New idea/feature/task — needs implementation details |
| `todo_refined` | Refined with details, ready to pick up (shown by `lb ready`) |
| `todo_bug` | Bug found by agent while working, ready to pick up (shown by `lb ready`) |
| `in_progress` | Actively being worked on |
| `in_review` | PR open, waiting for human review |
| `done` | Merged and complete |

### Two Paths Into the Pipeline

**Human or agent writes a story:**
1. `lb create "title"` → status `todo_needs_refinement`
2. Agent runs `lb refine` to find issues needing refinement
3. Agent runs `lb refine ID` to see the issue + refinement checklist
4. Agent adds implementation details, acceptance criteria, technical approach
5. Agent moves to `todo_refined`: `lb update ID --status todo_refined`
6. Agent picks up from `lb ready` → normal coding flow

**Agent discovers a bug/issue while working:**
1. Agent creates issue with full context → goes straight to `todo_bug`
   ```bash
   lb create "Found: race condition in auth" --discovered-from LIN-XXX -d "Details..."
   ```
2. Shows up in `lb ready` immediately for any agent to pick up

### Coding Workflow (Main Session = Coordinator)

1. `lb sync` → `lb ready` - Find unblocked `todo_refined` and `todo_bug` work
2. `lb update ID --status in_progress` - Claim it
3. Create a worktree for the issue:
   ```bash
   lb worktree create ID-short-description
   ```
   This automatically: creates the git worktree as a sibling directory, copies all `.env` files, symlinks `node_modules/` and `.opencode/`, and runs `lb onboard` + `lb sync`.
4. A new agent session opens in the worktree — it handles the implementation
5. The worktree session opens a PR, then: `lb update ID --status in_review`
6. Clean up when finished:
   ```bash
   lb worktree delete ID-short-description
   ```
7. Human merges → `lb close ID --reason "why"`

**All coding happens in worktrees**, never directly on main.
The main session is the **coordinator** — it claims issues and delegates to worktree sessions.

### Worktree Sessions (When You Start Inside a Worktree)

If your branch name starts with an issue ID (e.g. `AGE-99-fix-auth`), you are a **worktree agent**.
Your job is to implement that specific issue. Follow these steps:

1. `lb sync` — pull all issues from Linear
2. Extract the issue ID from your branch name (e.g. `AGE-99` from `AGE-99-fix-auth`)
3. `lb show AGE-99` — read the full issue description
4. `lb update AGE-99 --status in_progress` — claim it
5. **Start working immediately.** You know what to do from `lb show`.
6. When done, open a PR and `lb update AGE-99 --status in_review`

### Worktree Management

```bash
# Create a worktree (copies .env, symlinks node_modules/.opencode, runs lb onboard + sync)
lb worktree create AGE-42-fix-auth

# Create from a specific base branch
lb worktree create AGE-42-fix-auth --base develop

# List active worktrees
lb worktree list

# Remove a worktree (checks for uncommitted/unpushed work)
lb worktree delete AGE-42-fix-auth

# Force remove (skip safety checks)
lb worktree delete AGE-42-fix-auth --force
```

### Dependencies & Blocking

`lb` tracks relationships between issues. `lb ready` only shows unblocked issues.

```bash
# This issue blocks another
lb create "Must do first" --blocks LIN-123

# This issue is blocked by another
lb create "Depends on auth" --blocked-by LIN-100

# Found while working on another issue
lb create "Found: race condition" --discovered-from LIN-50 -d "Details..."

# General relation (doesn't block)
lb create "Related work" --related LIN-200

# Manage deps after creation
lb dep add LIN-A --blocks LIN-B
lb dep remove LIN-A LIN-B
lb dep tree LIN-A
```

### Labels

Labels are arbitrary tags that flow through to Linear. They are **auto-created** if they don't already exist.

```bash
lb create "Fix login bug" -l bug -l frontend
lb update LIN-XXX --label urgent
lb update LIN-XXX --unlabel frontend
lb list --label frontend
```

### Planning Work (SUBISSUES, NOT BUILT-IN TODOS)

When you need to break down a task, **create subissues in lb**:

```bash
lb create "Step 1: Do X" --parent LIN-XXX -d "Details..."
lb create "Step 2: Do Y" --parent LIN-XXX -d "Details..."
lb create "Step 3: Do Z" --parent LIN-XXX --blocked-by LIN-YYY
```

### Key Commands

| Command | Purpose |
|---------|---------|
| `lb sync` | Sync with Linear |
| `lb ready` | Show unblocked `todo_refined` + `todo_bug` issues |
| `lb refine` | List issues needing refinement |
| `lb refine ID` | Show issue + refinement checklist |
| `lb blocked` | Show blocked issues with blockers |
| `lb show ID` | Full issue details + relationships |
| `lb create "Title" -d "..."` | Create issue (defaults to `todo_needs_refinement`) |
| `lb create "Title" -l label` | Create with label |
| `lb create "Title" --parent ID` | Create subtask |
| `lb update ID --status in_progress` | Claim work |
| `lb update ID --status in_review` | PR opened |
| `lb update ID --status todo_refined` | Refinement done |
| `lb update ID --label name` | Add label |
| `lb update ID --unlabel name` | Remove label |
| `lb list --status todo_refined` | Filter by status |
| `lb list --label name` | Filter by label |
| `lb close ID --reason "why"` | Mark done |
| `lb dep add ID --blocks OTHER` | Add dependency |
| `lb dep tree ID` | Show dependency tree |
| `lb worktree create BRANCH` | Create worktree (full setup) |
| `lb worktree delete BRANCH` | Remove worktree (safety checks) |
| `lb worktree list` | List active worktrees |

### Rules

1. **NEVER use built-in task/todo tools** - ONLY `lb`
   - Not for planning, not for tracking, not for anything
   - Your memory can be wiped - `lb` tickets are persistent
   - If you need subtasks: `lb create "..." --parent LIN-XXX`
   - There is NO exception to this rule
2. **Always `lb sync` then `lb ready`** at the start of every session
3. **Always `lb show`** to read the full description before starting
4. **Always use `lb worktree create`** to delegate work — never code directly on main
5. **Create issues immediately** when you discover bugs — use `--discovered-from`
6. **Set `in_review` when opening a PR**, not `done`
7. **Include descriptions** with enough context for handoff
8. **Close with reasons** explaining what was done
9. **Always `lb sync`** before ending a session

### Critical for AI Agents: Memory is Ephemeral

**Your memory can be wiped at any time.** Offload everything to `lb` tickets:
- Design decisions, context, research findings
- Implementation notes and code snippets
- Blockers and dependencies
- "Where I left off" checkpoints

**`lb` is your persistent brain.** Your memory is cache, `lb` is database.
