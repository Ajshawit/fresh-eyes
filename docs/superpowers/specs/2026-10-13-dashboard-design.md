# fresh-eyes dashboard design

Date: 2026-10-13. A local page that shows each pull request's path through the fresh-eyes gate and can label a PR
`automerge`, then merges it once the review of its current head approves.

## Goal

Answer "where is every PR in the pipeline, and what did fresh-eyes say" in one screen, across every repository that
uses the action, and let the operator hand a PR to automerge with one click. Same constraints as the rest of the
project: one dependency-free Node file, readable in a sitting, nothing deployed, no token handling of its own.

## Non-goals

Charts and trends, per-push verdict history, multi-user or hosted use, closing or commenting on PRs, re-running the
review, GitHub native auto-merge. Each is a separate request if wanted.

## Components

| Unit | Does | Used by | Depends on |
|---|---|---|---|
| `dashboard.cjs` | HTTP server on 127.0.0.1; discovers repos; caches PR state; serves the page and JSON; labels; runs the automerge loop | operator, `node dashboard.cjs` | `gh`, `require-review.cjs` (`decide`, `headOf`, `verdictOf`, `MARKER`) |
| inline page | One HTML document with vanilla JS inside `dashboard.cjs`: pipeline rows per PR, review panel, automerge toggle | browser on localhost | the JSON endpoints |
| `test/check.cjs` | Asserts the pure functions: comment parsing, stage derivation, automerge decision, request guard | CI | fixtures under `test/fixtures/dashboard/` |

The server requires `require-review.cjs` rather than copying its parsers: the hook is the authority on what counts
as an approval, and the test already asserts it agrees with `review.cjs`.

## Usage

```
node dashboard.cjs [--repo owner/name ...] [--port 7331] [--method squash|merge|rebase] [--label automerge] [--every 60] [--rediscover]
```

Prints the URL and opens nothing. `--repo` given at least once skips discovery and covers exactly those repos.
`--method` defaults to `squash`. `--label` defaults to `automerge`. `--every` is the refresh and automerge interval in
seconds, minimum 15.

## Data flow

1. **Discovery** (no `--repo`): `gh repo list <me> --no-archived --json nameWithOwner`, then for each repo
   `gh api repos/R/contents/.github/workflows` and the text of every `.yml`/`.yaml` there. A repo is kept when any
   workflow mentions `fresh-eyes`. The result is written to `~/.cache/fresh-eyes/repos.json` with a timestamp and
   reused for 24 hours; `--rediscover` forces a scan. An empty result is an error at startup that names the fix
   (`--repo`), not an empty page.
2. **Refresh** (every `--every` seconds and on `POST /api/refresh`): per repo,
   - `gh pr list --repo R --state all --limit 40 --json number,title,url,author,createdAt,updatedAt,isDraft,state,
     mergedAt,headRefOid,baseRefName,labels,mergeable,mergeStateStatus,statusCheckRollup`;
   - `gh api "repos/R/issues/comments?sort=updated&direction=desc&per_page=100"` (first two pages at most), keeping
     comments by `FRESH_EYES_BOT` (default `github-actions[bot]`) whose body starts with the marker, keyed by issue
     number from `issue_url`.
   Open PRs and the 20 most recently closed are kept. Each PR becomes a row via `stages()` (below). A `gh` failure
   for a repo keeps the previous rows for that repo and sets `error` on the repo, shown in the page header; it never
   produces an approval.
3. **Automerge** (same loop, after refresh): for each open, non-draft PR carrying the label whose `mergeable` is
   `MERGEABLE` and whose review approves its current head (`decide([body], headRefOid) === null`), run
   `gh pr merge <n> --repo R --<method> --match-head-commit <headRefOid>`. GitHub refuses the merge if the head moved
   after the check. Outcome (merged, or the error text) is recorded on the PR row as `automerge.last` with a time and
   shown under the row. A PR whose merge failed is not retried until its head or mergeability changes.
4. **Review panel**: `GET /api/review?repo=R&pr=N` returns the cached comment body; the page posts it to
   `gh api markdown -f mode=gfm -f context=R -f text=@-` through `GET /api/review?...&html=1` and renders the result
   in a panel beside the list, with the PR link. No comment: the panel says so.
5. **Label**: `POST /api/label` with `{repo, pr, on}` runs `gh pr edit <n> --repo R --add-label|--remove-label <label>`
   then refreshes that repo. If the label does not exist in the repo, it is created once with
   `gh label create <label> --repo R --color 0E8A16 --description "fresh-eyes dashboard: merge when the review approves"`.

### Stage derivation (`stages(pr, comment)`)

Pure. Returns the ordered chips the page draws:

| Stage | Values | From |
|---|---|---|
| opened | author, age | `author.login`, `createdAt` |
| review check | `none`, `pending`, `pass`, `fail` | `statusCheckRollup` entry whose name contains `fresh-eyes` or `review` (first match); `none` when absent |
| verdict | `none`, `APPROVE`, `REQUEST_CHANGES`, `stale` (comment head ≠ `headRefOid`), `unparsed` (marker but no agreeing verdict) | the comment via `headOf`/`verdictOf`; counts of `**CRITICAL**` and `**HIGH**` lines |
| automerge | `off`, `waiting` (label on, not yet approved or not mergeable), `merging` (conditions met this loop), `merged`, `failed` | labels, `mergeable`, verdict, `automerge.last` |
| end | `open`, `draft`, `merged`, `closed` | `isDraft`, `state`, `mergedAt` |

### Automerge decision (`shouldMerge(pr, comment, label)`)

Pure. True only when every one of: state `OPEN`, not draft, label present, `mergeable === 'MERGEABLE'`,
`decide([comment], pr.headRefOid)` is null, and no `automerge.last` failure for this same head. Any missing field is
false.

## Safety

- Bound to `127.0.0.1`; `--port` only, never a host flag.
- `POST` endpoints require the header `x-fresh-eyes: 1`. No CORS headers are sent and `OPTIONS` returns 404, so a
  page on another origin cannot label or merge through a running dashboard. `GET` endpoints return JSON only.
- Repo and PR in a request must match a discovered or given repo and a cached PR number; anything else is 400.
  `gh` is always called with `execFileSync` and an argument array, never a shell string.
- Fails closed: an unreadable comment, a `gh` error, a head mismatch or a disagreeing verdict is never a merge. The
  merge pins the head it checked.
- The dashboard trusts the posted bot comment, like the hook does and like `reuse: true`. The README states that the
  bot login's comments must not be postable by other workflows if automerge is used.

## Page

One column of repos, each a list of PR rows: number and title linking to GitHub, then the five stage chips, then the
automerge toggle. Clicking a row opens the review panel on the right. Header shows last refresh time, repo errors,
and a Refresh button. Polls `GET /api/state` every 30 seconds. Dark and light by `prefers-color-scheme`. No build
step, no external assets.

## Error handling

Startup errors (no `gh`, not logged in, no repos found) exit 1 with the fix in the message. Loop errors are caught
per repo and surfaced in the state, never crashing the server. Label and merge errors return the `gh` stderr first
line as the response and are shown inline.

## Testing

`test/check.cjs` gains a section that requires `dashboard.cjs` with `DASHBOARD_NO_START=1` and asserts:
- `parseComment` on the existing review fixture and on a stale-head and a disagreeing-verdict body;
- `stages` on fixture PR JSON for each row of the stage table;
- `shouldMerge` over the cases: label off, draft, closed, `CONFLICTING`, stale head, `REQUEST_CHANGES`, prior failure
  for the same head, and the one passing case;
- `guard` (the request check) rejects a missing header, an unknown repo and an unknown PR.
No network, no `gh`. Live behaviour is proven by running it against a real repo.
