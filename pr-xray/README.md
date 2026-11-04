# PR X-ray for bb

Self-review GitHub pull requests before asking for review:

- **Diff tab**: hunks grouped by concern and ordered as a reading path (noise last), with viewed checkmarks, split/unified view and GitHub-style inline comments: single comments, start/submit a review, suggestions, replies, editing your posted comments and resolve.
- **Explain tab**: a summary informed by the linked Notion ticket and its parent project, a walkthrough, "where to look closely", and interactive diagrams. Click a node to leave a design comment (kept in bb only).
- **Fix with agents**: fix one thread, fix all your open review comments, or redesign from all diagram comments (plan first, then waits for your approval). Each start shows a toast with a link to the thread.
- **Retro feed**: tag comments yourself or click “AI tag”; `bb pr-xray comments --json` exports them.

## Install

```sh
bb plugin install git:github.com/AlsoKnownAs-Ax/bb-plugins --subdirectory pr-xray
```

Open it with the command palette (**PR X-ray: Review a pull request**; bind a shortcut in Settings → Keyboard), from the **PR X-ray** page in the nav rail, by asking any agent to "x-ray <PR url>", or with `bb pr-xray review <url>`.

## Setup

- **GitHub**: uses your `gh` login by default. To use a token instead, create a fine-grained token with *Pull requests: read & write* and *Contents: read*, then set it under Settings → Plugins → PR X-ray (or `bb plugin config pr-xray set githubToken <token>`).
- **Notion**: the analysis agent reads the ticket through your agent provider's Notion connection, so Notion must be connected for the provider you analyse with. The ticket is the first link matching *Ticket URL pattern* in the PR description (default: `notion.so` / `notion.com` links), and the parent project is followed through the *Notion parent project property* relation (default `Project`).
- **Models**: PR X-ray uses your bb default model unless you choose others under Settings → Plugins → PR X-ray. Analysis and chat share one setting, and AI tagging has its own.
- **Repository context**: when a bb project's git remote matches the PR's repository, the analysis and chat agents read a disposable worktree of the PR branch, never your own checkout. bb removes it after the agent's thread is archived, and PR X-ray then deletes its local branch. An open chat keeps its worktree until you reset the chat. Fork PRs, and projects where the worktree can't be created, use the diff only, and analyses show a badge saying so. Fix threads also run in a worktree, and aren't available for fork PRs.

## Security

PR titles, descriptions, diffs and branch files are untrusted, and a malicious PR can try to prompt-inject the agents that read them. Those agents run in a disposable worktree, or with no repository, and are told to treat PR content as data and stay off the network. That instruction is not a security boundary.

**With Codex, analysis and chat agents have network access.** bb's Codex workspace sandbox always allows it and PR X-ray can't turn it off, so an injected agent could reach the internet, run `gh` with your login and read files on your machine. Other providers depend on their own sandbox and approval settings, so don't treat those as a hard boundary either.

Only analyse or chat about PRs whose author you trust. This matters most for PRs from people outside your team.

## `bb pr-xray comments --json`

```json
{ "since": "...", "count": 1, "comments": [
  { "id": "cm_…", "source": "diff|diagram", "repo": "owner/name", "pr": 123,
    "tag": "missing-test", "status": "open|resolved|outdated", "body": "…",
    "path": "src/x.ts", "line": 42, "diagramNode": null,
    "githubUrl": "https://github.com/…", "createdAt": "2026-10-23T…" } ] }
```

Options: `--since 30d|12w|<ISO date>`, `--repo`, `--source`, `--tag`, `--limit`.

## Develop

```sh
npm install --include=dev
bb plugin install .
bb plugin dev
```

Run `npm run check` for linting (oxlint), type checking and tests.
