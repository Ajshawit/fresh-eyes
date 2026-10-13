# fresh-eyes design

Date: 2026-10-13. Extracted from a single-repo CI harness into a reusable GitHub Action plus a Claude Code hook.

## Goal

An independent model reviews every pull request and can block the merge. The PR must not be able to change how it is
judged. The whole thing stays two dependency-free Node files so it can be read in one sitting and vendored by hand.

## Components

| Unit | Does | Used by | Depends on |
|---|---|---|---|
| `review.cjs` | Diff + files + brief to a chat endpoint; post one comment; exit 1 unless `VERDICT: APPROVE` | `action.yml`, manual runs | git, `fetch`, GitHub REST |
| `require-review.cjs` | PreToolUse hook: allow `gh pr merge` only when the review comment approves the current head | Claude Code | `gh` |
| `action.yml` | Composite action mapping inputs to the env `review.cjs` reads | consumer workflows | `review.cjs` |
| `.fresh-eyes.json` | Optional per-repo brief path and path-matched focuses, read from the base branch | `review.cjs` | — |
| `test/check.cjs` | Pure unit checks with fixtures under `test/fixtures/` | CI | — |

## Decisions

- **Action, not npm package.** The action pins the reviewer by tag so the PR cannot edit it, which the original
  achieved with `git show origin/base:review.cjs`. Publishing to npm adds a release pipeline nothing needs yet.
- **Config from the base branch.** Same reason: a PR's change to `.fresh-eyes.json` is content under review, never
  the rule it is reviewed by.
- **Hook is self-contained.** It duplicates the marker and two three-line parsers from `review.cjs` so a consumer
  installs it by copying one file. The test asserts both copies agree.
- **Any OpenAI-compatible endpoint.** The original only knew ollama, but the call was already the OpenAI chat shape.
  One optional bearer header covers hosted APIs. ollama stays the documented default because it needs no secret.
- **Fail closed everywhere.** No verdict is not an approval; verdict lines that disagree are not an approval; a
  cut-off stream throws; a diff or file the model could not see in full means the run does not approve, whatever
  the model said; an unreadable PR blocks the merge; an unfetched base branch is a clear error, not an empty diff.
- **Read through git, execute nothing.** Changed files are read with `git show HEAD:path`, so a symlink is its target
  text and no code from the checkout runs. That is what lets the recommended trigger be `pull_request_target`, where
  the workflow file itself comes from the base branch and a PR cannot edit the job that judges it.
- **Generated files are ignored by base-branch config.** Lockfiles would otherwise spend the budget and force the
  coverage rule to block every dependency bump.

## Data flow

1. Workflow (on `pull_request_target`) checks out `refs/pull/N/merge` with full history and calls the action.
2. `review.cjs` verifies `origin/<base>` exists, reads config and brief from `origin/<base>`, lists changed, deleted
   and ignored files.
3. Prompt = brief + focuses(changed paths) + file lists + diff (≤200k chars) + file text from `HEAD:` (≤120k chars,
   smallest first). Anything cut or omitted is recorded as partial coverage.
4. Streamed completion; SSE frames are reassembled, `[DONE]` required, error frames throw.
5. Verdict = the single value every verdict line agrees on, or none. Partial coverage replaces it with
   REQUEST_CHANGES and an explanation.
6. Comment = marker + head sha + review + footer, cut to GitHub's limit with the verdict re-stated last; written to
   `out` and posted as a new or updated comment by the configured bot login.
7. Exit 1 unless the verdict is APPROVE, after posting so the comment explains the red check.
8. Later, the hook reads the bot's comments for the PR, matches marker and head, and lets `gh pr merge
   --match-head-commit <head>` through only on APPROVE. The MCP merge tool cannot pin a head and is always refused.

## Out of scope for 1.0

Inline review comments, multiple models voting, re-review on base change, a hosted service, an npm CLI.

## Testing

`node test/check.cjs` runs without a model or network. CI runs it on Ubuntu with Node 22 and, on pushes to main,
runs `review.cjs --dry` against an empty diff to exercise argument handling. Live behaviour is proven by consuming
the action in a real repository.
