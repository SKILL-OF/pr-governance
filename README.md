# @pfm/pr-governance

Extracted PFM PR governance machinery — parameterized for multi-repo use.

## What this is

Two tools extracted from `PlayFieldMultiplier/pfm-org` to make them reusable across all PFM repos without hardcoding repo-specific config:

- **`lib/verify-pr.js`** — Deterministic PR readiness verifier. Two approval tiers (FORMAL for main/pfm-org; CONVENTION for feature→devline). Reads `.claude/governance.json` for repo-specific config.
- **`lib/gate-pr-merge.js`** — Claude Code PreToolUse hook. Blocks pushes to protected branches, force-pushes, `--no-verify`, and `gh pr merge` calls that aren't READY. Calls `verify-pr` before allowing any merge.

## Installation

```bash
npm install github:SKILL-OF/pr-governance
```

Or when published to npm:
```bash
npm install @pfm/pr-governance
```

## Configuration

Create `.claude/governance.json` in your repo root:

```json
{
  "ownRepo": "owner/repo",
  "formalApprovalRepos": ["owner/repo"],
  "formalApprovalBases": ["main"],
  "protectedBranchesFile": ".githooks/protected-branches"
}
```

All fields are optional. Defaults:
- `ownRepo`: null (gate governs any push it sees)
- `formalApprovalRepos`: `[]`
- `formalApprovalBases`: `["main"]`
- `protectedBranchesFile`: `.githooks/protected-branches` (falls back to `["devline", "main"]` if missing)

## Usage

**Claude Code hook** (`.claude/settings.json`):
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "node node_modules/@pfm/pr-governance/lib/gate-pr-merge.js"
      }]
    }]
  }
}
```

**CLI** (verify a PR before merging):
```bash
npx verify-pr 42 owner/repo
npx verify-pr https://github.com/owner/repo/pull/42
npx verify-pr 42 owner/repo --post-merge
```

## Extracted from

`PlayFieldMultiplier/pfm-org` — see issue [#119](https://github.com/PlayFieldMultiplier/pfm-org/issues/119) for extraction rationale and design.

The parameterization removes hardcoded values from the originals:
- `FORMAL_APPROVAL_REPOS` → `governance.json.formalApprovalRepos`
- `FORMAL_APPROVAL_BASES` → `governance.json.formalApprovalBases`
- `OWN_REPO` (gate scope) → `governance.json.ownRepo`
- `BRANCH_LIST` path → `governance.json.protectedBranchesFile`
- `VERIFY_PR` path → resolved from this package (or `governance.json.verifyPrPath` override)
