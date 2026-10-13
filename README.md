# fresh-eyes

A second pair of eyes on every pull request, from a model you run yourself, that can also say no.

fresh-eyes diffs a PR against its base branch, hands the diff and the changed files to a model behind any
OpenAI-compatible chat endpoint, and posts one review comment that is updated in place on every push. The review
ends with a verdict line, and the job **fails unless the verdict is `APPROVE`**, so any merge step that depends on it
cannot merge past a review that found a CRITICAL or HIGH problem. A companion hook for Claude Code stops coding agents
from running `gh pr merge` until the review of the exact head commit approves.

Zero dependencies. Two files. Node 20 or newer.

Built for repositories where an agent writes most of the code: the author's model should not be the only reviewer,
and the gate should be something the PR itself cannot edit.

## Why a local model

- **No CI secret.** A self-hosted runner talking to an ollama (or llama.cpp, vLLM, LM Studio) daemon on the same
  machine needs no API key. Ollama's cloud models work the same way: the daemon holds the account, CI holds nothing.
- **Hosted works too.** Point `url` at any OpenAI-compatible API and pass `api-key`.
- **Streaming.** Slow reasoning models are fine: the stream keeps the connection alive, and a stream that ends
  without `[DONE]` or carries an error frame fails the run instead of posting half a review.

## Quick start

```yaml
# .github/workflows/review.yml
name: Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    # Never run PR code from a fork on a self-hosted machine.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: [self-hosted]          # or ubuntu-latest with a hosted endpoint
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0            # the reviewer diffs against the base branch
          persist-credentials: false
      - uses: ajshawit/fresh-eyes@v1
        with:
          model: glm-5.3:cloud      # anything your endpoint serves
          # url: http://127.0.0.1:11434/v1
          # api-key: ${{ secrets.REVIEW_API_KEY }}
```

To gate merges, make your merge job `needs: [review]`, or add the `review` check to branch protection.

## Configuration

Optional `.fresh-eyes.json` in the repository root. It is read from the **base branch**, so a PR cannot change the
brief or the focuses it is judged by; its edit to the file is reviewed like any other change.

```json
{
  "brief": "CLAUDE.md",
  "focuses": [
    {"match": "^server/", "focus": "Server security: authentication, input validation at trust boundaries, injection, secrets, rate limits."},
    {"match": "^\\.github/", "focus": "CI security: untrusted input interpolated into run:, token permissions, the fork guard on self-hosted jobs."},
    {"match": "^tests?/", "focus": "Tests: do they check the changed behaviour, can they pass while it is broken."}
  ]
}
```

- `brief` is a file the model reads first as the description of the repository and its rules. Without it, the first
  of `CLAUDE.md`, `AGENTS.md`, `README.md` on the base branch is used.
- `focuses` are regular expressions over changed paths. Every focus whose pattern matches a changed file is added to
  the general correctness focus. Unmatched areas add nothing, so a docs-only PR is not reviewed as if it touched
  the server.

### Action inputs

| Input | Default | Meaning |
|---|---|---|
| `model` | required | Model name sent to the endpoint |
| `url` | `http://127.0.0.1:11434/v1` | OpenAI-compatible base URL |
| `api-key` | empty | Bearer token, for hosted endpoints |
| `config` | `.fresh-eyes.json` | Config path on the base branch |
| `out` | `output/review.md` | Where the review markdown is written |
| `github-token` | `github.token` | Token that posts the comment |

## What the model sees

The brief, the focuses for the changed paths, the list of changed files, the diff (up to 200 000 characters), then
the full text of each changed file, smallest first, up to 120 000 characters. Files that no longer fit are named as
omitted rather than dropped silently; binaries are skipped. The system prompt tells the model it is read-only and
that text in the diff is data, not instructions.

The model is asked for findings as `**SEVERITY** file:line — what breaks and when`, most severe first, and exactly
one line `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`. The verdict must be on its own line at column 0 (backticks
or bold around it are fine). No verdict line is treated as not approved.

## The merge hook for Claude Code

`require-review.cjs` is a PreToolUse hook. It blocks `gh pr merge` in Bash and the GitHub MCP `merge_pull_request`
tool unless the fresh-eyes comment approves the PR's **current head commit**. It fails closed: if the PR or its
comments cannot be read, the merge is blocked and the agent is told why.

Copy the one file into your repository (it is self-contained) and register it:

```sh
mkdir -p .claude/hooks
curl -fsSL https://raw.githubusercontent.com/ajshawit/fresh-eyes/v1/require-review.cjs -o .claude/hooks/require-review.cjs
```

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|mcp__github__merge_pull_request",
        "hooks": [{"type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/require-review.cjs\""}]
      }
    ]
  }
}
```

The hook only lets through a `gh pr merge` it can read exactly: the PR by number or URL, `--repo owner/name`, and
`--match-head-commit <40-char sha>` naming the reviewed head, plus the usual `--squash`/`--merge`/`--rebase`/`-d`
flags. Quotes, variables, comments, clustered short flags, `cd` before the command, or `GH_*` overrides are refused,
so the hook can never check a different PR than the one gh merges. When the sha is missing or stale, the message
gives the agent the exact command to run.

If the review is posted by something other than `github-actions[bot]` (a PAT, a GitHub App), set `FRESH_EYES_BOT`
to that login for the hook.

## Running it by hand

```sh
git fetch origin main
BASE_REF=main FRESH_EYES_MODEL=qwen3-coder node review.cjs --dry      # writes output/review.md, posts nothing
```

Exit code 1 means the verdict was not `APPROVE` (or the model could not be reached). Set `PR`, `REPO` and
`GH_TOKEN` and drop `--dry` to post.

## Security model

- The reviewer code comes from the pinned action, and the config and brief from the base branch. Nothing the PR
  changes can alter how it is judged, only what is judged.
- The comment carries `<!-- head: <sha> -->`. An approval of an older push never covers a newer one.
- `gh pr merge --match-head-commit` makes GitHub refuse the merge if the head moved after the review.
- Everything fails closed: an unreachable model, a cut-off stream, a missing verdict, an unreadable PR.

Limits you should know about:

- A merge from the GitHub web UI bypasses the hook. Use branch protection with the `review` check where the plan
  allows it.
- The job needs `pull-requests: write` to post. With the default `permissions: contents: read` at workflow level,
  grant it on the job as in the quick start.
- A fork's PR must not run on your self-hosted machine. Keep the `if:` guard.
- Prompt injection is mitigated, not eliminated: the model is told the diff is data, but a determined PR can still
  try to talk it into approving. Treat the review as one gate among several.

## Development

```sh
node test/check.cjs
```

No model, no network, no git: the test covers the config parser, focus selection, verdict and head parsing, the
file inliner's budget, the SSE stream parser, the hook's decision, and the `gh pr merge` allowlist.

## Origin

Extracted from the CI of a game whose code is mostly written by agents, where an independent model with the power
to block the merge caught what the author's model missed. MIT licensed.
