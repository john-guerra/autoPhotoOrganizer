---
name: working-issues
description: Use when picking up, working on, or finishing a GitHub issue in this repo — before claiming an issue, before setting a version in package.json, before opening a PR, or any time another agent may be working this repo in parallel.
---

# Working GitHub issues in parallel

## Overview

Several agents work this repo at once. Exactly **two** resources collide when
they do, and both are claimed before work starts and released after merge:

| Resource              | Claimed by                         | Released by                                  |
| --------------------- | ---------------------------------- | -------------------------------------------- |
| The **issue**         | `wip` label + a claim comment      | swapping `wip` → `needs-validation` at merge |
| The **patch version** | a remote `claim/<version>` git tag | `git push origin :refs/tags/claim/<version>` |

Everything else (worktree, branch, PR) is naturally private to one agent.

**Core principle: never start work you have not claimed, and never claim work
without checking it is free first.** A duplicate claim wastes a whole session;
the check costs one command.

## When this fires

**Load this before touching an issue — including when John hands you the issue
number himself.** He cannot see which agents are live; you can. "He told me to
do #176" is not evidence that #176 is free.

Fires when you are about to:

- pick up, triage, or start any issue
- create a branch or worktree for issue work
- **set the version in `package.json`** — the claim protocol is not optional
- open a PR that references an issue, or comment results on one

Does not fire for: questions that change no files, reading an issue to answer
something, a doc edit John asks for inline in the main checkout, or a fix he is
driving interactively at his own keyboard.

**Asked to do something substantive with no issue number?** Search first —
`gh issue list --search "<keywords>" --state open` — because John files a lot
and a duplicate splits the discussion. If genuinely nothing matches, small work
needs no issue; just say out loud that you are working unclaimed, so a second
agent starting the same thing is John's decision rather than a surprise.

## Who you are

Claim comments and version tags carry `<label>#<key>` from `agent-id.sh`:

```bash
WHO=$(.claude/skills/working-github-issues/agent-id.sh)   # skill-agent-collaboration#e70a532e
```

- **`key`** (8 hex chars of the session id) is what every check matches on. It
  never changes.
- **`label`** is the conversation's custom title if John renamed it, else Claude
  Code's codename for the session (`clever-nibbling-sunbeam`). It is for reading,
  never for matching — John can rename a conversation mid-flight, and a claim
  keyed on a mutable label would strand itself.

Never hand-write an identifier, and never use `$CLAUDE_SESSION_ID` — that
variable does not exist (it is `CLAUDE_CODE_SESSION_ID`), and reading it
silently yields an empty string rather than failing.

## The loop

```
check free → claim issue → claim version → worktree → commit often
  → progress comments → PR (Refs #N) → merge → needs-validation → John closes → clean up
```

## 1. Check it is free — MANDATORY, before anything else

Never skip this, including when John names the issue explicitly. He can't see
which agents are live; you can.

```bash
N=176   # the issue number

gh issue view $N --json state,labels,comments \
  -q '{state, labels: [.labels[].name], claims: [.comments[] | select(.body|test("^🤖 CLAIMED")) | .body]}'
git ls-remote --heads origin "refs/heads/issue-$N-*"    # someone's branch already up?
gh pr list --search "$N" --state open                    # someone's PR already open?
```

**Any of `wip` / a `🤖 CLAIMED` comment / a live branch / an open PR means
another agent holds it.** Do not start. See _Already claimed_ below.

## 2. Claim the issue

```bash
WHO=$(.claude/skills/working-github-issues/agent-id.sh)

gh issue edit $N --add-label wip
gh issue comment $N --body "🤖 CLAIMED by \`$WHO\`
- branch: \`issue-$N-<slug>\`
- started: $(date -u +%FT%TZ)

Will post progress here. Release me if this branch has no new commit in 4h."
```

## 3. Claim a version — never hand-pick one

Two agents both editing `package.json` to `2.18.8` is the collision this
protocol exists to stop. `claim-version.sh` takes an atomic lock on a version
number by creating a remote tag — the one operation GitHub makes a real
compare-and-swap. Verified under 3-way concurrency: three agents starting from
`2.18.7` got `2.18.8`, `2.18.9`, `2.18.10`.

```bash
VERSION=$(.claude/skills/working-github-issues/claim-version.sh $N)   # add --minor only when cutting a packaged build
```

- **Never `git push --force` a `claim/*` tag.** Force _succeeds_ — it silently
  steals another agent's live version. There is no recovering the other agent's
  half-written CHANGELOG entry.
- **Never hand-write `claim/…` tags** or read the "next" version off
  `package.json` yourself. Read-then-write is exactly the race the tag closes.
- Claims are monotonic. An abandoned claim leaves a gap in the version
  sequence; gaps are harmless and cost nothing. Do not backfill them.
- Claim tags are `claim/x.y.z`, deliberately **not** `vx.y.z` — `release.yml`
  triggers on `v*`, so a claim must never look like a release tag.

## 4. Work in a worktree, commit often

```bash
git worktree add .claude/worktrees/issue-$N-<slug> -b issue-$N-<slug> origin/main
```

Then per `CLAUDE.md`: every stable state is a checkpoint commit — a slice that
builds with tests green gets committed right then, not batched. Reference the
issue in the subject: `fix(places): resolve major cities to themselves (#175)`.

Bump `package.json` to your **claimed** `$VERSION` and add its `CHANGELOG.md`
entry in the same commit that closes out the work — not as a separate chore.

## 5. Comment progress, citing commits and tests

Post at real milestones (root cause found, slice landed, approach changed) —
not per commit, and never a bare "working on it". Each one carries **evidence**:

```markdown
**Root cause.** `descendantGroups` read `groupBy` from a stale closure, so a
regroup during an open tree kept the previous dimension's node ids. (abc1234)

**Fix.** Pass `groupBy` as an argument instead of capturing it. (def5678)

**Validated by** `npm test` — 3 new cases in `tree.test.js` covering
regroup-while-expanded. Reverted the fix to confirm they go red first (they do,
all 3); restored. Full suite 1101/1101.
```

The revert-to-confirm-red step is not optional — `CLAUDE.md` requires it, and a
test that never failed proves nothing.

## 6. Finish: PR → validation → close

```bash
gh pr create --title "fix(tree): … (#$N)" --body "Refs #$N

<what the user can now do, why, and the evidence>"
```

**Use `Refs #N`, never `Closes #N`.** John validates by hand at
`localhost:5173`; merging must not close the issue out from under him.

Before marking ready, rebase on `main` and check two things:

- `CHANGELOG.md` conflicts with any PR merged since you branched. Resolution is
  mechanical: keep both entries, newest version on top.
- **If `main`'s version has passed your claim**, your number is now stale.
  Release it and re-claim: `git push origin :refs/tags/claim/$VERSION` then
  re-run `claim-version.sh`. The lock guarantees _uniqueness_, not that claim
  order matches merge order.

Once merged:

```bash
gh issue edit $N --remove-label wip --add-label needs-validation
gh issue comment $N --body "$(cat evidence.md)"     # what changed, why, how verified, test counts
git push origin ":refs/tags/claim/$VERSION"          # release the version lock
git worktree remove .claude/worktrees/issue-$N-<slug>
git branch -d issue-$N-<slug>
```

**You do not close the issue. John does**, after validating. Leave it open with
`needs-validation` — that label is his queue.

## Already claimed / stale claims

<!-- John: this policy block is the one judgment call here — how you want your
     fleet to behave on contention. Rewrite it to taste. -->

- **Held and alive** (claim comment or branch commit within 12h): do not start.
  Report to John which agent holds it and pick a different unclaimed issue.
- **Held but stale** (no commit on its branch for 12h+): you may take it. Comment
  the takeover on the issue, naming the stale session and its last commit, so
  the record shows why. Never silently re-claim.
- **Never** delete another agent's claim tag, force-push its branch, or push to
  its worktree. Stealing a live claim destroys uncommitted work.

Check liveness with: `git log -1 --format=%cr origin/issue-$N-<slug>`

## Red flags — stop

- "I'll just check the issue after I start looking at the code" — the check is
  first, always. Reading code is starting.
- "John told me to do #176, so it must be free" — he can't see live agents.
- "I'll bump to the obvious next patch, claiming is overkill" — that is the
  exact read-then-write race. Run the script.
- "`--force` will fix this tag" — it steals a live claim. Never on `claim/*`.
- "I'll add `Closes #N`, John can reopen if it's wrong" — he chose validation
  before close. Reopening loses the queue.
- "It's merged, I'll clean up the worktree later" — locked worktrees and live
  claim tags accumulate and block the next agent.

## Common mistakes

| Mistake                                          | What happens                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Counting `ls-remote` claim tags naively          | Annotated tags list twice (`claim/x` and `claim/x^{}`) — every claim counts double. Strip `^{}`. |
| Hand-picking the version                         | Two PRs ship the same `x.y.z`; one CHANGELOG entry silently overwrites the other.                |
| `Closes #N` in the PR body                       | Issue auto-closes unvalidated; John never sees it.                                               |
| Leaving `wip` on after merge                     | Next agent reads the issue as still in flight and skips real work.                               |
| Never releasing the claim tag                    | Version numbers drift upward forever and the registry stops being readable.                      |
| Progress comment with no commit SHA or test name | Unverifiable — the comment is the audit trail, not a status ping.                                |
