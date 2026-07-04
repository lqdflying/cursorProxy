# AGENTS.md — cursorProxy

This project's coding rules, conventions, and context live in `.cursor/rules/`.
Any coding agent working on this repo should read those files before making changes.

## Rule files

| File | Scope |
|---|---|
| `project.mdc` | Core project context: architecture, providers, release process, provider implementation checklist |
| `code-conventions.mdc` | Logging tags, module system, security, streaming, Docker Compose, reasoning caching, versioning |
| `adding-provider.mdc` | Checklist for adding a new upstream provider (must update 5+ locations) |
| `api-changes.mdc` | Pre-change documentation verification for provider behavior and API parameters |
| `api-edge-safety.mdc` | Edge Runtime constraints: no `node:*` imports, no `ioredis` in shared modules |
| `azure-foundry.mdc` | Azure OpenAI + Azure Anthropic integration details |
| `cursor-test-cases.mdc` | Manual Cursor test case maintenance |
| `edgeone-deployment.mdc` | EdgeOne Pages Cloud Functions deployment patterns |
| `feature-verification.mdc` | Post-deploy verification, probe-first pattern, KV key stability |
| `github-markdown.mdc` | GitHub Flavored Markdown conventions |
| `review-gating.mdc` | Pre-commit review: full-path trace for every input shape |
| `vercel-log-investigation.mdc` | Vercel production log investigation workflow |

## Quick start for agents

1. Read `.cursor/rules/project.mdc` for architecture overview, release process, and documentation boundaries.
2. Read `.cursor/rules/code-conventions.mdc` for logging, module, and security conventions.
3. If adding a provider, follow `.cursor/rules/adding-provider.mdc`.
4. If touching Azure code, read `.cursor/rules/azure-foundry.mdc`.
5. Wiki docs live in `wiki/` (separate git clone) and are for end users/operators only. Put developer-only implementation guidance in `.cursor/rules/`, not the public wiki.
