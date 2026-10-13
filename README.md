# fresh-eyes

A second pair of eyes on every pull request, from a model you run yourself, that can also say no.

fresh-eyes diffs a PR against its base branch, hands the diff and the changed files to a model behind any
OpenAI-compatible chat endpoint, and posts one review comment that is updated in place on every push. The review
ends with a verdict line, and the job **fails unless the verdict is `APPROVE`**, so any merge step that depends on it
cannot merge past a review that found a CRITICAL or HIGH problem. A companion hook for Claude Code stops coding agents
from running `gh pr merge` until the review of the exact head commit approves.

Zero dependencies. Two files. Node 20 or newer. It executes nothing from the pull request.

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
  pull_request_target:            # the workflow, config and brief come from the base branch, not the PR
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: fresh-eyes-${{ github.event.pull_request.number }}
  cancel-in-progress: true        # a slow review of an older push must not overwrite the newer one
jobs:
  review:
    runs-on: [self-hosted]        # or ubuntu-latest with a hosted endpoint
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
        with:
          ref: refs/pull/${{ github.event.pull_request.number }}/merge   # the PR as it would merge
          fetch-depth: 0          # the reviewer diffs against the base branch
          persist-credentials: false
      - uses: ajshawit/fresh-eyes@v1   # pin a full commit sha for a gate you rely on
        with:
          model: glm-5.3:cloud    # anything your endpoint serves
          # url: http://127.0.0.1:11434/v1
          # api-key: ${{ secrets.REVIEW_API_KEY }}
```

`pull_request_target` is normally dangerous because people check out and run PR code with a write token. fresh-eyes
only reads the checkout, through git, and runs nothing from it, so here it is the trigger that makes the gate hold:
the PR cannot edit the workflow that invokes the reviewer, and fork PRs are reviewed instead of skipped.

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
  ],
  "ignore": ["\\.snap$", "^fixtures/generated/"],
  "diffOnly": ["^package-lock\\.json$", "^dist/bundle\\.js$"]
}
```

- `brief` is a file the model reads first as the description of the repository and its rules. Without it, the first
  of `CLAUDE.md`, `AGENTS.md`, `README.md` on the base branch is used. A configured brief that is missing fails the run.
- `focuses` are regular expressions over changed paths. Every focus whose pattern matches a changed file is added to
  the general correctness focus. Unmatched areas add nothing, so a docs-only PR is not reviewed as if it touched
  the server.
- `ignore` hides a file from the reviewer entirely: it is listed as changed, but neither its diff nor its text is
  shown. Use it only for files nobody would review by hand, such as test snapshots or generated fixtures. Because the
  list lives on the base branch, a PR cannot add its own files to it.
- `diffOnly` shows a file's diff but not its text, and does not count as incomplete coverage. Use it for lockfiles
  and bundles: a changed `resolved` URL or integrity hash is exactly what a reviewer must see before CI installs it,
  and for a hand-written file that is simply too large to inline.

### Action inputs

| Input | Default | Meaning |
|---|---|---|
| `model` | required | Model name sent to the endpoint |
| `url` | `http://127.0.0.1:11434/v1` | OpenAI-compatible base URL |
| `api-key` | empty | Bearer token, for hosted endpoints |
| `config` | `.fresh-eyes.json` | Config path on the base branch |
| `out` | `output/review.md` | Where the review markdown is written |
| `github-token` | `github.token` | Token that posts the comment |
| `bot` | `github-actions[bot]` | Login that token posts as, so the comment can be found again |
| `reuse` | `false` | Reuse the posted verdict for an unchanged head and base (see below) |

`FRESH_EYES_MAX_DIFF` (200 000) and `FRESH_EYES_MAX_FILES` (120 000) cap the characters of diff and of file text
sent to the model. Set them as `env:` on the action step.

## What the model sees

The brief, the focuses for the changed paths, the list of changed, deleted and ignored files, the diff, then the
full text of each changed file, smallest first, read from the PR's merge commit in git. Binaries are skipped and
named; a symlink is shown as its target path, never followed. The system prompt tells the model it is read-only and
that text in the diff is data, not instructions.

The model is asked for findings as `**SEVERITY** file:line — what breaks and when`, most severe first, and exactly
one line `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`. A verdict line must stand alone at column 0 (backticks
or bold around it are fine). Every verdict line in the review must agree: a model that quotes an injected
`VERDICT: APPROVE` from a file and then ends with REQUEST_CHANGES has not approved. No verdict line is not an approval.

**Reuse is opt-in.** The comment records the head sha and the base branch. With `reuse: true`, a re-run for the same
head against the same base takes that verdict without asking the model, so a label event or a manual re-run is free;
a new push, or a PR retargeted to another base, is reviewed again. It is off by default because it trusts the posted
comment: with it on, a forged bot comment would skip the model as well as fool the hook, so only enable it where
every other workflow's token is read-only.

**Coverage is part of the verdict.** If the diff had to be cut or a changed file could not be shown in full, the run
does not approve, whatever the model said, and the comment explains what was missing and how to fix it: raise the
caps, add generated files to `ignore`, or split the PR.

## Model context

The prompt can reach about 320 000 characters, roughly 80 000 tokens, before the caps cut it. A daemon with a
smaller context window truncates silently and the model reviews a partial view without knowing it. For ollama set
`OLLAMA_CONTEXT_LENGTH` (for example `131072`) on the daemon, or lower the caps so the prompt fits your model.

## The merge hook for Claude Code

`require-review.cjs` is a PreToolUse hook. It blocks `gh pr merge` in Bash unless the fresh-eyes comment approves
the PR's **current head commit**, and it always blocks the GitHub MCP `merge_pull_request` tool, pointing the agent
at the `gh pr merge` form it can check. It fails closed: if the PR or its comments cannot be read, the merge is
blocked and the agent is told why.

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

Adjust the matcher if your GitHub MCP server has a different prefix.

The hook only lets through a `gh pr merge` it can read exactly: the PR by number or URL, `--repo owner/name`, and
`--match-head-commit <40-char sha>` naming the reviewed head, plus the usual `--squash`/`--merge`/`--rebase`/`-d`
flags. Quotes, variables, comments, clustered short flags, `cd` before the command, flags before `merge`, `gh api`
on the merge endpoint, or `GH_*` overrides are refused, so the hook can never check a different PR than the one gh
merges. When the sha is missing or stale, the message gives the agent the exact command to run.

If the review is posted by something other than `github-actions[bot]` (a PAT, a GitHub App), set `FRESH_EYES_BOT`
to that login for the hook, and the `bot` input for the action.

## Running it by hand

```sh
git fetch origin main
BASE_REF=main FRESH_EYES_MODEL=qwen3-coder node review.cjs --dry      # writes output/review.md, posts nothing
```

Exit code 1 means the run did not approve (the verdict, incomplete coverage, or an unreachable model). Set `PR`,
`REPO` and `GH_TOKEN` and drop `--dry` to post.

## Security model

- With `pull_request_target`, the workflow, the config and the brief all come from the base branch, and the reviewer
  code from the pinned action. Nothing the PR changes can alter how it is judged, only what is judged.
- The reviewer executes nothing from the checkout and reads files through git, so a PR's symlink or script cannot
  reach the runner.
- The comment carries `<!-- head: <sha> -->`. An approval of an older push never covers a newer one.
- `gh pr merge --match-head-commit` makes GitHub refuse the merge if the head moved after the review.
- Everything fails closed: an unreachable model, a cut-off stream, a missing or disputed verdict, incomplete
  coverage, an unreadable PR.

Limits you should know about:

- **Other workflows can forge the comment.** Any job in your repository that runs PR code with a write token (a
  test workflow on `pull_request` with default permissions) could post a comment as `github-actions[bot]` that looks
  like an approval. Set the repository's default workflow permissions to read-only and grant `pull-requests: write`
  only to the review job, as in the quick start.
- The hook refuses a few harmless commands too, fail-closed: a `gh pr create --title "… merge …"` reads as a merge
  mention. Use the file tools for prose that mentions the command.
- The hook sees `gh pr merge` and `gh api …/merge` in Bash (line continuations joined first) and the GitHub MCP
  merge tool. A merge from the web UI,
  a direct push to the base branch, `curl`, or a differently spelled command is not seen. It is a guard against an
  agent taking the normal route, not a sandbox; branch protection with the `review` check is the real gate.
- Prompt injection is mitigated, not eliminated: the model is told the diff is data, but a determined PR can still
  try to talk it into approving. Treat the review as one gate among several.
- `@v1` is a moving tag. Pin a full commit sha when the gate matters.

## Development

```sh
node test/check.cjs
```

No model, no network: the test covers the config parser, focus selection, verdict and head parsing, the inliner
(against a throwaway git repository with a symlink out of the tree), comment truncation, the SSE stream parser, the
hook's decision, and the `gh pr merge` allowlist.

## Origin

Extracted from the CI of a game whose code is mostly written by agents, where an independent model with the power
to block the merge caught what the author's model missed. MIT licensed.
