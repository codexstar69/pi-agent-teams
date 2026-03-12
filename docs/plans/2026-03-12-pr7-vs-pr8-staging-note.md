# PR7 vs PR8 staging note

## Purpose

This is a short internal note on how to stage:

- **PR7** doctor / cleanup support
- **PR8** structured logging / priority scheduling / visibility

The goal is to keep reviews small, preserve debuggability, and avoid destabilizing the runtime while cleanup and scheduling behavior are still evolving.

## Recommended order

### 1. PR7 doctor helpers first

Land the **read-only doctor foundation** before PR8 behavior changes.

Scope:
- stale lock detection
- worktree consistency checks
- stale member / missing session checks
- issue classification (`warning`, `repairable`, `destructive`)

Reason:
- doctor output gives us a stable diagnostic lens before we add more state transitions from PR8
- if later PR8 logging or priority behavior looks wrong, the doctor surface helps explain whether the runtime state is actually bad or just displayed differently

Keep this slice read-only.

---

### 2. PR8 structured logs second

After doctor helpers exist, land **append-only event logs**.

Scope:
- low-volume, operator-relevant events only
- no scheduling changes yet
- no repair automation

Reason:
- logs improve post-mortem debugging without changing core task selection or cleanup semantics
- doctor + logs together provide both current-state inspection and historical transition visibility

This should still be low-risk if logging failures are non-blocking.

---

### 3. PR7 git-aware cleanup third

Only after doctor and logs are in place should cleanup become more powerful.

Scope:
- `git worktree remove` for managed worktrees
- conservative cleanup refusal if state is unsafe
- cleanup remains explicit, not automatic

Reason:
- destructive behavior should come after we have both:
  - doctor output explaining what is wrong now
  - logs showing what happened before cleanup was invoked

This is the point where PR7 can safely move from inspection to action.

---

### 4. PR8 priority scheduling fourth

After diagnostics and cleanup safety are in place, land **read-only priority ordering**.

Scope:
- priority parsed from task metadata
- ordering only among already-claimable tasks
- no mutation API yet

Reason:
- priority changes runtime behavior and can make task order look surprising
- by this point we already have:
  - doctor to inspect current state
  - logs to explain task transitions
  - safer cleanup if tests leave debris behind

This makes priority regressions much easier to diagnose.

---

### 5. PR8 UI visibility fifth

Only then expand widget/panel/task-show surfaces.

Scope:
- show priority / retry / lease / recent-event summaries
- keep footer widget compact
- put detailed state in panel and `/team task show`

Reason:
- visibility should reflect stable runtime state, not race ahead of it
- if UI lands too early, reviews get noisy because reviewers end up debating presentation while runtime semantics are still changing

---

### 6. Repair automation and priority mutation last

Leave these until the end:
- doctor repair flows
- cleanup `--repair`
- task priority mutation commands / tool actions

Reason:
- these are the first slices that both **change state** and **expand operator surface area**
- they become much easier to review once read-only diagnostics, event logs, cleanup safety, and read-only scheduling are already trusted

## Reviewability rules

To keep reviews clean:

### PR7 reviews should separate:
1. doctor/read-only inspection
2. cleanup mutation behavior
3. optional repair automation

Do not combine all three in one PR.

### PR8 reviews should separate:
1. event log plumbing
2. priority ordering logic
3. UI visibility
4. mutation APIs

Do not combine logs + priority + UI + mutation in one PR.

## Stability rule of thumb

If a change can:
- delete files,
- reorder work,
- or silently repair state,

it should land **after** we already have:
- a read-only diagnostic path, and
- a historical event trail.

That means:
- **doctor before cleanup automation**
- **logs before priority mutations**

## Bottom line

Safest staging order:

1. PR7 read-only doctor helpers
2. PR8 structured event logs
3. PR7 git-aware cleanup
4. PR8 read-only priority scheduling
5. PR8 UI visibility
6. PR7 repair flows + PR8 priority mutation last

This order preserves reviewability, gives operators better debugging tools at each step, and keeps runtime risk low while the system is still hardening.
