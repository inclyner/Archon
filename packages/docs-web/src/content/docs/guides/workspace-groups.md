---
title: Workspace Groups (Cross-Repo Workflows)
description: Run a workflow against a non-git parent directory containing N sibling git repositories, with per-repo PRs and one shared AI session.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 10
---

A **workspace group** is a non-git parent directory containing N sibling git repositories. When you run a workflow against a group, **one AI session edits across all members** in a single coherent change. Each member's edits land in its own git worktree, so each repo gets its own commits and its own PR — there is no shared "group PR."

Use this when the change is **one logical thing that crosses repos** (add OAuth: backend route + frontend button + shared types). For "run the same change once per repo," use the per-repo CLI loop instead.

## Mental model

```
~/dev/my-platform/                ← parent dir (NOT a git repo, has its own CLAUDE.md)
├── service-api/                  ← git repo
├── service-web/                  ← git repo
├── shared/                       ← git repo
└── infra/                        ← git repo
```

When you run a workflow against this group, Archon materializes:

```
~/.archon/workspace-groups/my-platform/worktrees/<branch>/
├── CLAUDE.md                     ← copied from parent (file-copy, not symlink)
├── service-api/                  ← `git worktree add` of source service-api on <branch>
├── service-web/                  ← `git worktree add` of source service-web on <branch>
├── shared/                       ← `git worktree add` of source shared on <branch>
└── infra/                        ← `git worktree add` of source infra on <branch>
```

The AI session runs with `cwd` = the group dir. It sees the parent CLAUDE.md (parent context) and each child's CLAUDE.md (per-repo context) by walking down. It can read and write any file across all four. Commits land in each child's git history because each child is a real git worktree.

**Key safety property:** the source repos are never edited. All AI work happens in the group worktree.

## Setup

Register a parent dir as a workspace group:

```bash
archon group register ~/dev/my-platform
# Walks one level deep, registers each git child as its own codebase, then
# creates the group + member junction.
```

Inspect what's registered:

```bash
archon group list
archon group show my-platform
```

## Running a workflow

```bash
# CLI
archon workflow run <workflow-name> --group my-platform "Add OAuth across all repos"

# CLI with auto-PR after success: pushes each child branch and opens one PR per repo
archon workflow run <workflow-name> --group my-platform --auto-pr "Add OAuth"

# Web UI
# Open /groups/my-platform → click "Run workflow against this group"

# Slack / Telegram / GitHub
/workflow run <workflow-name> --group my-platform "Add OAuth"
```

The auto-generated branch name is `<workflow-name>-<timestamp>` and is the same across all member repos.

## Substitution variables

Workflows that target groups can reference these variables in `prompt:`, `bash:`, `script:`, `command:`, and `args:` fields:

| Variable | Example value | Purpose |
|---|---|---|
| `$GROUP` | `my-platform` | The group name |
| `$GROUP_DIR` | `/Users/.../workspace-groups/my-platform/worktrees/feat-oauth/` | Absolute path to the group worktree |
| `$REPOS` | `/.../service-api\n/.../service-web\n/.../shared\n/.../infra` | Newline-separated list of all member worktree paths |
| `$REPO_<NAME>_DIR` | `/.../service-api` for member `service-api` | Absolute path to one specific member's worktree. The name is the member's relative path uppercased with non-`[A-Z0-9_]` chars replaced by `_` (`service-api` → `SERVICE_API`). |

These are pre-substituted into the workflow definition before the executor sees it, so they work uniformly in prompt nodes (text the AI reads) and in bash/script nodes (text the subprocess executes).

## Bundled `archon-cross-repo-orient` workflow

A simple default to verify your setup:

```bash
archon workflow run archon-cross-repo-orient --group my-platform "go"
```

It lists every CLAUDE.md the AI can see at depth ≤3 under `$GROUP_DIR`, then summarizes each member repo's role. **No file edits.** Use it as the cheapest possible smoke test before running anything that mutates code.

## Pushing + per-repo PRs

After a successful run, the group worktree stays on disk. Push each child's branch and (optionally) open one PR per repo:

```bash
# Preview what would happen
archon group push my-platform --branch <branch> --dry-run

# Push only
archon group push my-platform --branch <branch>

# Push + open one PR per repo, with sibling PRs cross-linked in PR bodies
archon group push my-platform --branch <branch> --pr
```

Every PR opens **from its own child repo's worktree** (`gh pr create` uses that worktree's `origin`), so each PR lands in its own repo's GitHub project. PR bodies include a "Sibling PRs in this group" section listing the other PR URLs for reviewer context.

## Cleanup

```bash
# Preview cleanup candidates
archon group cleanup my-platform --all

# Remove a specific worktree
archon group cleanup my-platform --branch <branch> --force

# Remove all worktrees for the group
archon group cleanup my-platform --all --force

# Default mode: removes worktrees with mtime older than --days (default 7)
archon group cleanup my-platform --days 14 --force
```

For each member's worktree, `git worktree remove --force` is called against its source repo so the source's `.git/worktrees/` pointers are also cleaned up. The group dir is then removed from disk.

To unregister the group entirely (member codebases stay registered):

```bash
archon group remove my-platform
```

## Failure semantics

- **Setup phase failures roll back atomically.** If branch creation fails on the 4th member, branches in members 1–3 are deleted before the error is raised. If `git worktree add` fails on the 4th member, worktrees on 1–3 are removed and the group dir is rm'd. You never see partial on-disk state.
- **Workflow execution failures leave the worktree on disk.** Same as a single-repo failure: you can `cd` in and inspect what the AI did.
- **Push phase is the gate for `--auto-pr`/`--pr`.** If any member's `git push` fails, PR creation is skipped entirely; the partial pushed state is surfaced so you can finish manually.

## Limitations

- **Single base branch.** All members share one base branch detected from the first member (typically `main`). If your repos have different defaults, ensure the chosen base exists in all of them or pin via the worktree config.
- **Workflow discovery cwd is the first member's source repo.** Repo-scoped workflows from other members aren't auto-discovered when invoked via `/groups/:name/run` (the web/chat path). The CLI uses bundled defaults plus the cwd you launched from.
- **No cross-org PR linking format.** PR bodies link sibling URLs as plain GitHub links; if your repos span multiple GitHub orgs the format still works but reviewer expectations may differ.

## Related

- [Authoring Workflows](./authoring-workflows.md) — workflow YAML reference for `prompt:`, `bash:`, `script:`, etc.
- [Global Workflows, Commands, and Scripts](./global-workflows.md) — user-level workflow placement.
