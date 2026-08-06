# CI without waiting

**Date** 2026-08-06 · **Issue** #330 · **Against** 2.20.3

Make CI a real gate that nobody watches, and make post-merge close-out
impossible to forget.

---

## 0. The measurement that changes the diagnosis

The report was "GitHub CI is slowing us down" after a docs-only PR (#324) took
~30 minutes and a large share of a session to merge. Measured before designing:

|                             |                                       |
| --------------------------- | ------------------------------------- |
| Last 20 `ci.yml` runs       | **9–11 minutes**, steady              |
| The two outliers (20m, 42m) | today, during a GitHub `major_outage` |
| `check` job                 | 2m57s                                 |
| `e2e` job                   | the long pole, ~8m                    |

**CI is not slow, and the outage is not worth designing around** — it is a
once-a-quarter event that took Actions to `major_outage` for both `Analyze` and
`e2e` simultaneously.

The finding is elsewhere:

```
$ gh api repos/john-guerra/autoPhotoOrganizer/branches/testing/protection
404 Branch not protected

allow_auto_merge        = false
delete_branch_on_merge  = false
concurrency groups      = none in any workflow
```

**`testing` has no branch protection, so CI gates nothing.** It _looks_ like a
gate — red checks, a PR header saying some checks were not successful — and
enforces nothing. That is the worst of the two available states:

- broken code can reach trunk today, and
- an agent seeing red stops and waits for permission that was never being
  withheld.

On #324 an agent spent ~30 minutes polling, re-running jobs into an ongoing
outage, and finally running the whole Playwright suite locally (7.2 min) to
satisfy a check nothing was enforcing. It could have merged at any point.

### The generalisable form

> **The expensive thing is not CI duration. It is an agent synchronously
> blocking on it.**

Eleven minutes of wall-clock costs approximately zero tokens if you fire and
forget. The same eleven minutes costs 30–50k if something polls it, reads its
logs, re-runs its jobs and narrates the result. GitHub already ships the
fire-and-forget primitive (`gh pr merge --auto`); it is disabled on this repo.

---

## 1. What is NOT wrong, so it does not get "fixed"

**The post-merge `push: testing` run is not redundant with the PR run.** It
looks like an obvious 2× saving and it is not. `docs/AGENT-NOTES.md` records
#212: two PRs, each individually green, turned **36 tests red across files they
had never heard of** the moment they were in one tree. The `pull_request` event
tests one PR against base; only the post-merge run tests the tree that actually
exists. It stays.

**The 9–11 minute duration is proportionate** for a suite with a real browser
tier, and `TESTING.md` argues at length why that tier exists. Shortening it by
weakening it would trade a known cost for an unknown one.

**Most of #324's token cost was the audit, not the waiting.** Reading every doc,
63 issues, writing an issue, a PR body and six issue comments is the work. This
design does not claim to reduce that, and should not be judged on it.

---

## 2. Design

### 2.1 Repo settings — no code

| Setting                  | From  | To   | Why                                   |
| ------------------------ | ----- | ---- | ------------------------------------- |
| `allow_auto_merge`       | false | true | the whole point: `gh pr merge --auto` |
| `delete_branch_on_merge` | false | true | 8 stale branches accumulated (#323)   |

Branch protection on **`testing`**, requiring the two `ci.yml` checks:

```
required_status_checks:
  contexts: [check, e2e]     # the two job names in ci.yml
  strict: false              # do NOT require the branch to be up to date
enforce_admins: false
```

**`strict: false` is load-bearing with several agents in this repo.** `strict:
true` requires every PR to be rebased onto the current `testing` before it can
merge, so each merge invalidates every other open PR and re-runs its CI — a
serialised queue where five agents each rebase and wait 11 minutes behind the
one in front. The protection this repo needs is "the checks passed", not "the
checks passed against this exact tip". The #212 case that `strict` would guard
against is already caught by the post-merge `push: testing` run (§1), which is
the right place for it: it reports the problem without blocking four other
agents to prevent it.

**`main` stays unprotected.** John merges `testing` forward by hand and cuts
tags from it; protection there would only obstruct the person it is meant to
protect.

**`enforce_admins: false`** so the sole admin is never locked out of his own
release line.

#### CodeQL is deliberately NOT a required check

`Analyze (javascript)` stays advisory. Two independent reasons:

1. **It is an undecided policy question.** #290 — 16 open
   `js/missing-rate-limiting` alerts, already described as blocking PRs, with no
   decision made. Making it _required_ converts an open question into a hard
   merge block without anyone choosing that.
2. **It failed twice today for reasons unrelated to the code**, in `Set up job`,
   before analysis: `Failed to resolve action download info: Service
Unavailable`.

Revisit once #290 is decided.

### 2.2 The close-out workflow — the part that makes auto-merge safe

Auto-merge breaks an assumption in `working-issues`: the close-out sequence
(swap `wip` → `needs-validation`, release the `claim/x.y.z` tag, delete the
worktree and branch) assumes **the agent is still alive when the merge lands.**
With fire-and-forget it is not.

Left unsolved, this trades 30 minutes of polling for a repo slowly filling with
orphaned `wip` labels and live claim tags — which is precisely the version
collision the tag lock exists to prevent. So the workflow is not an optimisation;
it is what makes the rest of the design safe.

`.github/workflows/pr-closeout.yml`

```
on: pull_request: types: [closed]
if:  github.event.pull_request.merged == true
permissions: { issues: write, contents: write }
```

1. Read `Refs #N` from the PR body → on issue N, remove `wip`, add
   `needs-validation`.
2. Read `version` from `package.json` **at the merge commit** →
   `git push origin :refs/tags/claim/<version>`.
3. Branch deletion is the repo setting, not code.

Step 2 deserves its reasoning written down: the version on `testing` after the
merge **is** the version that PR shipped, and `claim-version.sh` guarantees no
other agent holds that number. So the tag to release is _derivable_, not
guessed. Both steps no-op silently when the PR carries no `Refs` or the tag is
already gone — a close-out that fails loudly on an ordinary PR is worse than no
close-out.

**Scope: merged PRs only.** A closed-unmerged PR is rare, and the existing
12-hour stale-claim rule in `working-issues` already covers it. Building for it
now is speculation.

### 2.3 CI workflow — two mechanical changes

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

The condition is the design, not a detail. PR runs cancel when superseded;
**`push: testing` runs never cancel**, because per §1 that run is the record
that trunk is green.

And a cache on the Playwright browser download, keyed on the lockfile:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
```

`npx playwright install --with-deps chromium` still runs — system deps are not
in that path — but the browser itself stops being re-downloaded.

#### Rejected: `paths-ignore` for docs-only PRs

Tempting, and it would have made #324 a 3-minute PR. Rejected because path
filters are a classic false-green: the day someone bundles a `.svelte` file or a
lockfile with their markdown, the filter silently under-tests it. **#324 itself
had `package-lock.json` in it** and would have been misjudged on day one.

### 2.4 The escape hatch — protection makes an outage _worse_ without one

Today, unprotected, the PR could be merged on local evidence. Protected, it
could not have been. A design that removes that option is a downgrade, so it
ships its own override:

> `gh pr merge --admin` is permitted when CI **cannot run** — never when it
> fails. The bar: local `npm test` and `npm run test:e2e` both green and pasted
> into the merge body, plus a link to the githubstatus incident.

And the distinction that makes the bar usable, which nothing in the repo
currently records:

> **A cancelled CI job is indistinguishable from a failed one in
> `gh pr checks`.** Today's `e2e` reported `fail`; the jobs API says
> `conclusion: cancelled` with **zero steps executed**, and `--log-failed`
> returns empty because there is no log to return. That sends you hunting for a
> test that never ran. The honest signal is only at
> `gh api repos/{owner}/{repo}/actions/jobs/{id}` — check `conclusion` and
> `steps | length` before concluding anything about your code.

### 2.5 Documentation

- **`working-issues/SKILL.md`** — the manual close-out section is replaced by:
  open the PR, `gh pr merge --auto`, stop. Plus the `--admin` bar above.
- **`docs/AGENT-NOTES.md`** — the cancelled-vs-failed distinction, and that
  `testing` is now protected so CI is a real gate.

---

## 3. Testing

**There is no unit tier for a GitHub workflow**, and this design does not
pretend otherwise. `CLAUDE.md` asks for a test at the tier that would have
caught the bug; for YAML executed by GitHub's runner, that tier is driving it.

Verification is one throwaway PR that:

1. auto-merges once `check` and `e2e` are green, with nobody watching;
2. ends with `needs-validation` on its issue, no `claim/*` tag, and no branch.

If either half does not happen, the workflow is wrong and the PR is the failing
test. Stating this plainly rather than writing an assertion that proves nothing
is the same discipline as `AGENT-NOTES`' "never write a comment claiming a test
you did not write".

---

## 4. Known limitation, stated rather than hidden

**Auto-merge means a PR can land while nobody has read it.** #324 contained a
genuine judgement call — deleting a document John had merged the previous day.
Fire-and-forget is right for mechanics and wrong for judgement, and this design
has no way to tell the two apart.

The mitigation is partial and worth naming as partial: agents keep writing
`Refs #N` rather than `Closes #N`, so every merged change still lands in John's
`needs-validation` queue. But that is review _after_ it is on trunk, not before.

If this becomes a real problem, the next step is a `needs-review` label that
suppresses auto-merge — deliberately **not** built now, because nobody has felt
the pain yet and a label nobody applies is worse than no label.

---

## 5. What this does not solve

- **The token cost of substantial work.** #324's bill was the audit, not the
  waiting.
- **#290.** CodeQL policy is still an open decision, and this design routes
  around it rather than settling it.
- **#226.** `claim-version.sh` hardening is orthogonal; the close-out workflow
  makes releasing a claim automatic but does not change how one is acquired.
