---
name: pr-xray
description: Open GitHub PRs in PR X-ray (grouped diff + visual explanation) and read the review comments it records, e.g. for retros.
---

# PR X-ray

## Reviewing a PR
- When the user asks to review or "x-ray" a GitHub PR, call the `pr_xray_review` tool with its URL (or run `bb pr-xray review <url>`), then share the returned link. The analysis runs in the background (1–3 minutes) and the page updates live.

## Reading recorded comments (retros)
`bb pr-xray comments --json` returns the user's review comments recorded by PR X-ray:

- `source`: `diff` (posted to GitHub, `githubUrl` set) or `diagram` (design feedback kept in bb only; `diagramNode` set).
- `tag`: one of bug, missing-test, naming, design, error-handling, performance, security, scope, readability, docs, other (`null` while tagging is pending).
- `status`: open, resolved or outdated.

Filters: `--since 30d|12w|<ISO date>` (default 90d), `--repo owner/name`, `--source diff|diagram`, `--tag <tag>`, `--limit <n>` (default 500, max 2000).

Diff comments also carry a hidden `<!-- pr-xray: tag=<tag> -->` marker in their GitHub body, so the tag survives even without this plugin's local data.
