# WickedAFDok - Agent Guide

This is the always-loaded entry point. It contains universal rules and essential project context. Detailed guidance is split into focused files under `docs/` so it is loaded only when relevant.

## Instruction loading (read first)

CRITICAL: When you encounter a reference such as `@docs/apps.md`, use the Read tool to load that file when it is relevant to the task. Do not preload every document. Once loaded, treat its content as mandatory instructions that extend this file. Follow further `@` references recursively when a loaded document points to another.

| When working on | Load |
| --- | --- |
| Startup, setup, storage paths, networking, file handling, permissions, security, known limitations | `@docs/architecture.md` |
| Dashboard, Containers, Images, Projects/Sources, Dok Settings, Logs, legacy backups | `@docs/features.md` |
| App creation, compose builder, Apps, App Library, OC Assist, app data, compose management | `@docs/apps.md` |
| Dok Maintenance, nginx-proxy, cloudflared, Authentik, Authelia, DNS, Email, Host Helper, OpenCode core service | `@docs/core-services.md` |
| REST or terminal API changes | `@docs/api.md` |
| HTML/JS UI, selectors, tabs, modals | `@docs/ui.md` |
| PTY/WebSocket terminal, HTTP fallback transport, OpenCode session config | `@docs/terminal.md` |
| Code changes, verification, Docker-in-Docker testing | `@docs/development.md` |
| Building an app for the Dok App Library | `@server/app-agents.md` (source of the generated `apps/AGENTS.md`) |

## Overview

- **Name:** WickedAFDok
- **Purpose:** Self-hosted Docker/container management UI running in a container with access to `/var/run/docker.sock`. Provides a web interface to manage containers, images, deploy apps, and configure core services.
- **Stack:** Node.js 24 (ESM), Express.js, Dockerode + Docker CLI, vanilla HTML/CSS/JS, `node-pty` + `ws` + xterm.js for the browser terminal, OpenCode CLI for on-demand AI sessions
- **Entry Point:** `server/index.js` - serves REST API, terminal WebSocket, and static files from `public/`
- **Port:** 8080 (default, configurable via `PORT` env var)
- **Volumes:** `./data`, `./sources`, `./uploads`, `./apps`, `./core`

## Quick Start

```bash
# Prepare permissions and runtime directories once
sudo ./setup.sh

# Preferred method using start script
./start.sh

# Or with docker compose from repo root
docker compose up -d --build

# Or build and run manually
docker build -t wickedafdok .
docker run -d --name wickedafdok -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/sources:/app/sources \
  -v $(pwd)/uploads:/app/uploads \
  -v $(pwd)/apps:/app/apps \
  -v $(pwd)/core:/app/core \
  wickedafdok
```

Startup, setup, socket-GID, and managed-compose details: `@docs/architecture.md`.

## Critical non-negotiables

- There is no authentication or authorization middleware. Every API route is open, and the mounted Docker socket gives root-equivalent Docker control. Keep Dok behind a trusted network or authenticated reverse proxy. `/api/auth` is a settings placeholder only.
- Never expose, log, print, or commit secrets. Registry/git connection secrets and service secrets in `data/settings.json` are AES-256-GCM encrypted with `data/.credentials-key`; API responses expose only `*Set`/`hasSecret` flags.
- App persistent data is user data. Never delete, reset, truncate, or overwrite an app-root `data/` directory or `.env*` files during creation, import, restore, deploy, update, or repair.
- Apps are always saved to the library **stopped**. Only Deploy (or an explicit test launch that is always stopped again) starts an app.
- With nginx-proxy installed, a routed app must use `VIRTUAL_HOST` + the matching container-port `VIRTUAL_PORT` on the same service and no published host ports; keep it on the default Dok network.
- Protected core containers require typing the exact container name (`confirmName`) before removal. Core services are managed from the Core Services UI.
- Do not silently remove existing functionality, weaken security, discard user data, or change established behavior merely to simplify implementation.
- There is no automated test suite or lint script. Verify with syntax/build checks (for example `node --check server/index.js`) and API smoke tests. See `@docs/development.md`.

Security, permission, and secret-storage details: `@docs/architecture.md`.

## General Engineering Principles and Proactive Problem-Solving

### 1. Take Ownership of the Intended Outcome

When given a task by the user, take ownership of achieving the user's intended outcome, not merely following the literal wording of their instructions.

Understand what the user is trying to accomplish, why the requested change matters, and how it fits into the existing project. Use your own logic, reasoning, technical knowledge, and engineering judgment to determine what is needed to deliver a complete, reliable, secure, and usable solution.

Treat the user's explicit instructions as the primary requirements, but recognize that users may not know every technical detail, dependency, prerequisite, edge case, or supporting feature necessary to achieve their goals.

Do not interpret incomplete instructions as a requirement to produce an incomplete solution.

### 2. Proactively Identify Missing Requirements

Before implementing a task, independently consider what may have been overlooked or left unstated.

Depending on the task, evaluate:

- Required supporting functionality, dependencies, integrations, and configuration.
- Connections between the requested change and existing components, services, APIs, databases, and workflows.
- Data validation, error handling, permissions, authentication, authorization, and security implications.
- Data persistence, state management, concurrency, retries, recovery, and failure handling.
- User feedback, usability, accessibility, and expected behavior in normal and exceptional situations.
- Installation, deployment, environment variables, migrations, documentation, and operational requirements.
- Backwards compatibility, existing functionality, regressions, and interactions with other features.
- Testing requirements and how the finished result can be verified.

These are considerations, not a checklist that must be implemented identically for every task. Apply judgment based on the actual requirements and risks.

Identify both what the user explicitly requested and what must reasonably be true for the requested functionality to work as intended.

### 3. Inspect Before Assuming

Do not make decisions based solely on assumptions when relevant evidence is available.

Inspect the existing codebase, project structure, related implementations, configuration, dependencies, documentation, and tests before deciding how to proceed.

Follow established project conventions where appropriate. Reuse existing functionality and dependencies when doing so produces a sound solution.

When you identify a potential missing requirement, determine whether it is genuinely necessary, already implemented elsewhere, intentionally excluded, or merely an optional enhancement.

Do not duplicate existing functionality or introduce redundant infrastructure because you overlooked what the project already provides.

### 4. Implement the Smallest Complete Solution

When a missing requirement is clearly necessary or strongly implied by the user's goal, address it proactively as part of the task when it falls within the authorized scope.

Do not wait for the user to explicitly request every supporting implementation detail.

Prefer the smallest complete, maintainable solution that achieves the intended outcome. Include necessary integration, configuration, validation, error handling, and tests rather than delivering an isolated code change that does not work in practice.

However, proactive problem-solving does not authorize unnecessary feature development, unrelated refactoring, architectural redesigns, or speculative improvements.

Distinguish between:

- **Essential:** Necessary for the requested functionality to work correctly. Include it.
- **Important and directly relevant:** Materially improves reliability, security, maintainability, or usability. Include it when proportionate to the task and within scope.
- **Optional enhancement:** Potentially useful but not necessary to achieve the intended outcome. Mention it when worthwhile, but do not automatically implement it.
- **Out of scope or consequential:** Changes that materially expand the task, affect unrelated systems, incur significant costs, or introduce destructive or externally visible effects. Obtain approval when appropriate.

Never silently remove existing functionality, weaken security, discard user data, or change established behavior merely to simplify implementation.

### 5. Use Independent Judgment and Anticipate Problems

Do not blindly follow an implementation approach if inspection reveals that it will not achieve the user's goal.

Identify technical problems, contradictions, missing prerequisites, flawed assumptions, and foreseeable failure scenarios. If the user's proposed approach is likely to fail, explain why and choose a better approach when the intended outcome and authorization are clear.

Consider realistic edge cases and failure conditions relevant to the task, such as invalid input, missing configuration, unavailable services, network interruptions, permission failures, partial operations, and inconsistent state.

Add appropriate validation, error handling, logging, recovery, and user feedback where justified.

Make reasonable technical decisions independently. Do not ask the user to decide routine implementation details that can be resolved through sound engineering judgment.

### 6. Ask Questions Only When They Matter

Do not interrupt progress with unnecessary clarification requests when the intended outcome is clear and reasonable assumptions are sufficient.

Proceed using the best-supported assumptions when uncertainty is minor and the consequences of being wrong are low. Document important assumptions when they affect the implementation.

Ask the user for clarification or approval when:

- Multiple plausible interpretations would lead to materially different results.
- A missing decision cannot reasonably be resolved from the codebase, documentation, or context.
- A decision could cause significant data loss, security exposure, expense, downtime, or irreversible changes.
- The proposed implementation would materially expand the scope or conflict with the user's stated requirements.
- Required credentials, permissions, or authorization are unavailable.

When clarification is necessary, ask a focused question that explains the specific decision and why it matters. Do not offload the entire problem-solving process to the user.

### 7. Plan Around the Complete Task

Before making changes, establish:

1. The user's intended outcome and what success looks like.
2. The relevant existing implementation and project conventions.
3. The explicit requirements and necessary implied requirements.
4. Dependencies, integration points, edge cases, and risks.
5. The implementation steps and appropriate verification methods.

For complex tasks, communicate a concise plan before substantial implementation when useful. For straightforward tasks, perform this reasoning without unnecessary planning overhead.

As work progresses, update the approach when new evidence reveals overlooked requirements or a better solution.

### 8. Verify Functionality, Not Just Code Changes

Do not consider a task complete simply because the requested code has been written or the application compiles.

Perform appropriate verification based on the task, such as:

- Running relevant automated tests and adding tests for important new behavior.
- Checking linting, type checking, builds, and configuration validity when applicable.
- Exercising important workflows, integration points, and realistic edge cases.
- Checking that error handling and failure recovery behave appropriately.
- Reviewing changes for regressions, security issues, unintended side effects, and incomplete integration.
- Confirming that required configuration, migrations, dependencies, and documentation are addressed.

Use available tools and practical tests to establish whether the implementation works. Do not claim to have run tests, inspected systems, or verified behavior unless you actually did so.

If verification is blocked or unavailable, explain what remains unverified and why. Do not disguise uncertainty as success.

### 9. Definition of Done

A task is complete when:

- The intended outcome has been achieved to a reasonable, verifiable standard.
- Explicit requirements and necessary supporting requirements have been addressed.
- The implementation integrates correctly with the existing project.
- Relevant edge cases, failure conditions, security considerations, and regressions have been considered.
- Appropriate verification has been performed, or remaining verification limitations have been disclosed.
- No unnecessary scope expansion or unauthorized consequential changes have been introduced.
- Any remaining limitations, important assumptions, or recommended follow-up work are communicated clearly.

If a task cannot be completed fully, deliver the most useful safe progress possible and explicitly identify what remains outstanding.

### 10. Report Results Clearly

When finishing a task, summarize:

- What was implemented.
- What additional supporting requirements or overlooked issues were addressed.
- What tests and verification were actually performed and their results.
- Any remaining limitations, assumptions, risks, or follow-up actions.

Keep reports proportionate to the task. Prioritize meaningful results and outstanding issues over a lengthy account of routine implementation steps.

**Guiding principle:** Think like an engineer responsible for delivering the outcome, not a code generator responsible only for executing instructions. Use initiative to discover and address necessary missing pieces, evidence to guide decisions, restraint to avoid unnecessary complexity, and verification to establish whether the solution actually works.

## Directory Structure

```
.
├── .dockerignore        # Keeps runtime data and node_modules out of image builds
├── .gitignore           # Keeps runtime data, node_modules, and generated files out of git
├── docs/                # Focused agent guidance loaded on demand (see Instruction loading)
├── server/index.js      # Main server with all API routes and business logic
├── server/host-agent.js # Legacy privileged helper socket (superseded by Maintenance)
├── server/assist-register.mjs # OC Assist helper that registers/deploys an app via finalize API
├── server/app-agents.md # OC Assist app-library contract; written to apps/AGENTS.md on startup
├── maintenance/         # Dok Maintenance container (server, shared lib, compose)
├── public/              # Frontend
│   ├── index.html       # UI structure
│   ├── css/style.css    # Styles
│   ├── js/app.js        # Frontend logic
│   ├── js/manual.js     # In-app manual, section help, and field labels/tooltips
│   └── maintenance/     # Maintenance installer/tools UI
├── apps/                # Deployed apps (each app in its own subdirectory with compose)
├── core/                # Installed core services (nginx-proxy, cloudflared, authentik, authelia, dns, mailpit, stalwart)
├── data/                # Persistent data (registry, settings, backups, logs, managed compose)
│   ├── registries.json  # Encrypted registry and git connection credentials
│   ├── .credentials-key # 0600 AES-256-GCM key used for registry and settings secrets
│   ├── designer/        # Uploaded Designer logo files
│   ├── docker-config/   # Generated Docker auth config used for pulls (0700/0600)
│   ├── backups/         # Local full/app backup archives + metadata
│   ├── logs/            # server.log
│   ├── host-helper/     # Host helper token and agent socket
│   └── opencode/        # Per-mode OpenCode config/state + shared provider auth/data
├── sources/             # Projects/sources for manual browsing/editing
├── uploads/             # Temporary upload staging area
├── setup.sh             # Host permission/Docker socket setup script
└── start.sh             # Startup helper script
```

Dok's persistent data root, storage relocation, and Maintenance storage layout: `@docs/architecture.md`.

## Important Conventions

- Apps are always managed via their directory in `apps/<name>/` with compose files
- "Launch" functionality has evolved into "App Creation" - the flow is create/configure/manage through the App Creation tab and Apps tab
- Git operations are generic (support any git host), not hardcoded to GitHub API
- If no compose/Dockerfile found in git/upload, route to Projects/Sources
- Core nginx-proxy is managed as a single instance from Core Services; additional instances can be created differently
- Default network migrated to `wicked`
- When modifying UI, update both `public/index.html` and `public/js/app.js`
- No TypeScript; the project is vanilla ESM JavaScript. Do not add comments unless asked.

##-------------------------------------Tasks-----------------------------------

# Do these tasks 1 at a time and focus on the single task at hand. Do a task, push to github, Update AGENTS.md and remove the task, inform the user that you are ready to start the next task.

- OC Assist is now successfully creating apps. However it still fails to to display a usable terminal or opencode chat. Rethink the method being used to display them and implement a functional one.

- App Creator methods should examine any given repository links for information on configuration to create the best possible compose file

- App Library: Add an option to deploy without saving. That way it will keep the base config.

- Add authelia user management button to the dashboard Core Services section

- OC Assist: If an app has different images for different versions Ubuntu, debian et.. Add a dropdown selection for version tags in the compose editor.
