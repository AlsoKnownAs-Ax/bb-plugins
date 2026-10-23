# PR X-ray for bb

Self-review GitHub pull requests before asking for review:

- **Diff tab**: hunks grouped by concern and ordered as a reading path (noise last), with viewed checkmarks, split/unified view and GitHub-style inline comments: single comments, start/submit a review, suggestions, replies and resolve.
- **Explain tab**: a summary informed by the linked Notion ticket and its parent project, a walkthrough, "where to look closely", and interactive diagrams. Click a node to leave a design comment (kept in bb only).
- **Fix with agents**: fix one thread, fix all your open review comments, or redesign from all diagram comments (plan first, then waits for your approval).
- **Retro feed**: every comment is auto-tagged; `bb pr-xray comments --json` exports them.

## Install

```sh
bb plugin install git:github.com/<you>/bb-plugin-pr-xray
```

Open it with the command palette (**PR X-ray: Review a pull request**; bind a shortcut in Settings → Keyboard), from the **PR X-ray** page in the nav rail, by asking any agent to "x-ray <PR url>", or with `bb pr-xray review <url>`.

## Setup

- **GitHub**: uses your `gh` login by default. To use a token instead, create a fine-grained token with *Pull requests: read & write* and *Contents: read*, then set it under Settings → Plugins → PR X-ray (or `bb plugin config pr-xray set githubToken <token>`).
- **Notion**: the analysis agent reads the ticket through your agent provider's Notion connection, so Notion must be connected for the provider you analyse with. The ticket is the first link matching *Ticket URL pattern* in the PR description (default: `notion.so` / `notion.com` links), and the parent project is followed through the *Notion parent project property* relation (default `Project`).
- **Model**: Settings → Plugins → PR X-ray → *Analysis model*. The recommended default is Sonnet 5.5 at medium reasoning.
- **Repository context**: when a bb project's git remote matches the PR's repository, the analysis agent reads that checkout (read-only). Otherwise the analysis uses the diff only, and the page shows a badge saying so.

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
