# CI without waiting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's last act on a PR is `gh pr merge --auto`; it never polls CI,
and it never has to remember the post-merge close-out.

**Architecture:** Two repo settings plus branch protection turn CI into a real
gate. One new workflow does the close-out (`wip` → `needs-validation`, release
the `claim/<version>` tag) that an absent agent cannot. Two mechanical edits to
`ci.yml` stop superseded PR runs and stop re-downloading Chromium.

**Tech Stack:** GitHub Actions YAML, `gh` CLI, `gh api` for repo settings.

**Spec:** `docs/superpowers/specs/2026-08-06-ci-without-waiting-design.md` ·
**Issue:** #330

## Global Constraints

- **Branch:** `issue-330-ci-without-waiting`, already open as PR #331 against
  `testing`. Add commits to it; do not open a second PR.
- **Version:** `2.20.5`, already claimed and already in `package.json`. Do **not**
  claim another. Extend the existing `## 2.20.5` CHANGELOG entry rather than
  adding a new one.
- **`strict: false`** on required status checks — verbatim from the spec §2.1.
  `strict: true` serialises every open PR behind the last merge.
- **CodeQL (`Analyze (javascript)`) is NOT a required check** — spec §2.1. That
  is #290, undecided.
- **`enforce_admins: false`** — the sole admin must never be locked out.
- **`main` is not protected.** Only `testing`.

---

## Task order is load-bearing — read this before starting

**The settings flip is LAST, and Task 4 is gated.** Two independent reasons,
either one sufficient:

1. **GitHub Actions is in a major outage as this plan is written**
   (2026-08-06T17:40Z, "workflow runs are failing or delayed in starting").
   Enabling branch protection that requires `check` and `e2e` while no job can
   start would make **every** merge in the repo impossible, including the PR
   that adds the close-out workflow. It would brick the repo for merges.
2. **The close-out workflow must be ON `testing` before the first auto-merge
   happens.** A workflow only runs from the default/base branch's ruleset once
   it is merged. Flip auto-merge first and the first PR to land leaves an
   orphaned `wip` label and a live claim tag — precisely the failure the
   workflow exists to prevent (spec §2.2).

Reason 2 holds even after GitHub recovers. Do not reorder.

---

### Task 1: The close-out workflow

**Files:**

- Create: `.github/workflows/pr-closeout.yml`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: a workflow named `PR close-out` with one job, `closeout`. Task 4's
  branch protection must NOT list it as a required check — it runs on
  `pull_request: closed`, which is after the merge decision, so requiring it
  would deadlock.

- [ ] **Step 1: Create the workflow**

```yaml
name: PR close-out

# When a PR merges, do the close-out that the agent who opened it cannot: it is
# gone. Auto-merge (#330) means the session ends at `gh pr merge --auto`, long
# before the merge lands, so the `working-issues` close-out sequence — swap
# `wip` -> `needs-validation`, release the `claim/<version>` tag — has nobody to
# run it. Left undone, the repo fills with live claim tags and `claim-version.sh`
# starts handing out numbers above a trunk nobody is on.
#
# Branch deletion is NOT here: `delete_branch_on_merge` is a repo setting.
#
# Fork safety: this is `pull_request`, not `pull_request_target`. GitHub issues a
# read-only GITHUB_TOKEN for fork PRs, so the write permissions below cannot be
# reached from a fork.

on:
  pull_request:
    types: [closed]

permissions:
  contents: write # delete the claim tag
  issues: write # swap the labels

jobs:
  closeout:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      # The MERGE COMMIT, not the base branch tip. Two PRs merging seconds apart
      # would otherwise both read whichever version won the race, and the loser
      # would delete the winner's live claim tag.
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.merge_commit_sha }}
          fetch-depth: 0

      - name: Swap wip -> needs-validation on the referenced issue
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          BODY: ${{ github.event.pull_request.body }}
        run: |
          set -uo pipefail
          N=$(printf '%s' "$BODY" | grep -oiE 'refs #[0-9]+' | head -1 | grep -oE '[0-9]+')
          if [ -z "${N:-}" ]; then
            echo "No 'Refs #N' in the PR body — nothing to label. Not an error."
            exit 0
          fi
          echo "Referenced issue: #$N"
          gh issue edit "$N" --remove-label wip --add-label needs-validation \
            || echo "Could not relabel #$N (already closed, or the labels are not on it). Not failing."

      - name: Release the claim tag for the version this PR shipped
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -uo pipefail
          V=$(node -p "require('./package.json').version")
          echo "Version at the merge commit: $V"
          if git ls-remote --exit-code --tags origin "refs/tags/claim/$V" >/dev/null 2>&1; then
            git push origin ":refs/tags/claim/$V" && echo "Released claim/$V"
          else
            echo "No claim/$V to release. Not an error — not every PR claims one."
          fi
```

- [ ] **Step 2: Validate the YAML parses before committing**

A workflow with a syntax error does not fail loudly — GitHub silently never
runs it, which is the "silently does nothing and reports success" family this
repo keeps writing down.

Run:

```bash
node -e "
const fs=require('fs');
const s=fs.readFileSync('.github/workflows/pr-closeout.yml','utf8');
if(!/^name:/m.test(s)) throw new Error('no name');
if(!/pull_request/.test(s)) throw new Error('no trigger');
console.log('shape ok,', s.split('\n').length, 'lines');
"
npx prettier --check .github/workflows/pr-closeout.yml
```

Expected: `shape ok` and prettier reporting the file is formatted. If prettier
complains, run `npx prettier --write` on it.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr-closeout.yml
git commit -m "ci: do the post-merge close-out an absent agent cannot (#330)"
```

---

### Task 2: `ci.yml` — cancel superseded PR runs, cache the browser

**Files:**

- Modify: `.github/workflows/ci.yml` — add a top-level `concurrency` block after
  the `on:` block; add a cache step to the `e2e` job before
  `npx playwright install`.

**Interfaces:**

- Consumes: nothing.
- Produces: job names `check` and `e2e` are **unchanged** — Task 4 references
  them verbatim as required-check contexts. Do not rename them.

- [ ] **Step 1: Add the concurrency block**

Insert immediately after the existing `on:` block, before `jobs:`:

```yaml
# Cancel a PR run that a newer push has superseded — but NEVER cancel the
# post-merge run on `testing`. That run is the record that trunk is green, and
# it is the only thing that catches two individually-green PRs going red once
# they are in one tree (#212: 36 tests, across files neither PR had heard of).
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

- [ ] **Step 2: Cache the Playwright browser download**

In the `e2e` job, insert this step **between** the `setup-node` step and the
`npx playwright install --with-deps chromium` step:

```yaml
# The browser binary is ~130MB and is re-downloaded on every run otherwise.
# `--with-deps` still runs below: the system libraries it installs are not
# under this path.
- uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
```

- [ ] **Step 3: Verify the job names did not change**

Run:

```bash
node -e "
const s=require('fs').readFileSync('.github/workflows/ci.yml','utf8');
for (const j of ['check','e2e']) {
  if (!new RegExp('^  '+j+':','m').test(s)) throw new Error('job renamed: '+j);
}
if (!/^concurrency:/m.test(s)) throw new Error('no concurrency block');
if (!/ms-playwright/.test(s)) throw new Error('no browser cache');
console.log('ci.yml ok — check and e2e still named as Task 4 expects');
"
npx prettier --check .github/workflows/ci.yml
```

Expected: `ci.yml ok`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: cancel superseded PR runs, cache the browser (#330)"
```

---

### Task 3: Documentation

**Files:**

- Modify: `.claude/skills/working-issues/SKILL.md` — the close-out block in §6.
- Modify: `docs/AGENT-NOTES.md` — a new section before "Where the deep context
  lives".
- Modify: `CHANGELOG.md` — extend the existing `## 2.20.5` entry.

**Interfaces:**

- Consumes: the workflow from Task 1 (its behaviour is what the docs describe).
- Produces: nothing later tasks read.

- [ ] **Step 1: Replace the manual close-out in `SKILL.md` §6**

Find the block beginning "Once merged:" with the four-command list
(`gh issue edit … needs-validation`, `gh issue comment`,
`git push origin ":refs/tags/claim/$VERSION"`, `git worktree remove`). Replace
the label-swap and tag-release commands with:

````markdown
Then **stop watching**. Do not poll CI:

```bash
gh pr merge --auto --merge   # GitHub merges it the moment the checks pass
```

**The close-out is automatic** (#330). `.github/workflows/pr-closeout.yml`
swaps `wip` → `needs-validation` from your `Refs #N`, releases
`claim/<version>`, and the branch is deleted by a repo setting. You do **not**
run those commands, and you do **not** wait around to run them. All that is
left for you is your own machine:

```bash
git worktree remove .claude/worktrees/issue-$N-<slug>
git branch -D issue-$N-<slug>
```

**`--admin` is permitted only when CI CANNOT RUN — never when it fails.** The
bar: local `npm test` and `npm run test:e2e` both green and pasted into the
merge body, plus a link to the githubstatus incident. And check which one you
are looking at first: a **cancelled** job is rendered identically to a failed
one (see `docs/AGENT-NOTES.md`).
````

- [ ] **Step 2: Add the section to `docs/AGENT-NOTES.md`**

Insert immediately before `## Where the deep context lives`:

````markdown
## A cancelled CI job looks exactly like a failed one

`gh pr checks` renders a **cancelled** job as `fail`, and `--log-failed`
returns nothing at all because there is no log — so it reads as a test that
broke, and you go hunting for the test. There is no test. It never started.

The honest signal is only in the jobs API:

```bash
gh api repos/{owner}/{repo}/actions/jobs/<id> \
  -q '"\(.status) / \(.conclusion) — steps: \(.steps|length)"'
# completed / cancelled — steps: 0   <- never ran; not your code
```

`steps: 0` means the runner never picked it up. During the 2026-08-06 Actions
outage this cost a real detour: `e2e` reported `fail` on PR #324 having
executed zero steps, while CodeQL failed in `Set up job` with
`Failed to resolve action download info: Service Unavailable`. Neither was the
code. **Check githubstatus before diagnosing a red board you cannot explain.**

## CI on `testing` is a real gate now, and nobody watches it

Branch protection requires `check` and `e2e` (#330). So:

- **Never poll CI.** `gh pr merge --auto --merge` and end your turn. GitHub
  merges when green. Watching an 11-minute run costs 30–50k tokens and buys
  nothing.
- **The post-merge close-out is a workflow**, not your job —
  `.github/workflows/pr-closeout.yml`.
- **`strict` is deliberately false.** Your PR does not need rebasing onto the
  current `testing` to merge. Turning it on would serialise every open PR
  behind the last merge, which with several agents here is a queue of
  11-minute waits.
- **CodeQL is advisory, not required** — that is #290, undecided.
````

- [ ] **Step 3: Extend the `## 2.20.5` CHANGELOG entry**

Replace the existing single bullet under `## 2.20.5` with:

```markdown
- Internal: CI is now a real gate that nobody has to watch — branch protection
  plus auto-merge, so an agent opens a PR and walks away; a workflow does the
  post-merge close-out an absent agent cannot; superseded PR runs cancel; and
  the e2e browser download is cached (#330). Nothing user-facing.
```

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write CHANGELOG.md docs/AGENT-NOTES.md
git add -A
git commit -m "docs: never poll CI; the close-out is a workflow now (2.20.5, #330)"
```

---

### Task 4: The settings — GATED, and last

**Files:** none. This is `gh api` against the repo.

**Interfaces:**

- Consumes: Task 1's workflow must be **merged to `testing`** before this runs.
- Produces: the gate. After this, `gh pr merge --auto` is available.

- [ ] **Step 1: Enable the two harmless settings NOW**

These do not gate anything, so they are safe during an outage.

```bash
gh api -X PATCH repos/john-guerra/autoPhotoOrganizer \
  -F allow_auto_merge=true -F delete_branch_on_merge=true \
  -q '"auto_merge=\(.allow_auto_merge) delete_branch=\(.delete_branch_on_merge)"'
```

Expected: `auto_merge=true delete_branch=true`.

- [ ] **Step 2: STOP. Check both preconditions before Step 3**

Branch protection is the irreversible-feeling one: get it wrong while Actions is
down and no PR in the repo can merge.

```bash
# (a) Is Actions healthy?
curl -s https://www.githubstatus.com/api/v2/summary.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const c=JSON.parse(s).components.find(c=>c.name==='Actions');
      console.log('Actions:', c.status);
    })"

# (b) Has a real CI run gone green on testing since the workflows changed?
gh run list --workflow=ci.yml --branch testing --limit 3
```

**Proceed only if (a) prints `operational` AND (b) shows a `success`.** If
either fails, stop here and leave the plan unfinished — Steps 1's settings are
useful on their own and harmless. Say so out loud rather than pressing on.

- [ ] **Step 3: Enable branch protection on `testing`**

```bash
gh api -X PUT repos/john-guerra/autoPhotoOrganizer/branches/testing/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["check", "e2e"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Note `required_pull_request_reviews: null` — requiring a human review would
block every agent PR and is not what the spec asked for.

- [ ] **Step 4: Verify the gate is real, and that `main` was not touched**

```bash
gh api repos/john-guerra/autoPhotoOrganizer/branches/testing/protection \
  -q '"contexts=\(.required_status_checks.contexts) strict=\(.required_status_checks.strict) admins=\(.enforce_admins.enabled)"'
gh api repos/john-guerra/autoPhotoOrganizer/branches/main/protection 2>&1 | head -1
```

Expected: `contexts=["check","e2e"] strict=false admins=false`, and `main`
returning **`Branch not protected`** — that 404 is the pass condition, not a
failure.

---

## Task 5: Verify by driving it — the only tier that exists

There is no unit test for a GitHub workflow (spec §3). The verification is a
real PR.

- [ ] **Step 1: Confirm the close-out actually fired on this very PR**

PR #331 carries `Refs #330` and ships version `2.20.5`, so it is its own first
test case — but **only if Task 1 is merged before #331 merges**, which it is
not, since they are the same PR. So check on the NEXT PR instead, and say
plainly that #331 could not test itself.

After the next PR with a `Refs #N` merges:

```bash
gh run list --workflow=pr-closeout.yml --limit 3
gh issue view <N> --json labels -q '[.labels[].name]'      # expect needs-validation, no wip
git ls-remote --tags origin 'refs/tags/claim/*' | sed 's#.*claim/##' | sort -u
```

Expected: the workflow ran and succeeded; the issue carries `needs-validation`
and not `wip`; that PR's claim tag is gone.

- [ ] **Step 2: If the close-out did NOT fire, do not paper over it**

Read its log (`gh run view --log`). The two likely faults are a PR body with no
`Refs #N` (working as designed — it exits 0 and says so) and a missing label on
the issue (also non-fatal by design). A genuine failure is any non-zero exit,
and that is a bug in Task 1, not a reason to go back to manual close-out.
