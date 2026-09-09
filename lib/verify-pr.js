#!/usr/bin/env node
// Deterministic PR readiness verification for pfm repos.
//
// Usage:   node verify-pr.js <pr-number|pr-url> [owner/repo] [--post-merge]
//          node verify-pr.js <pr-number|pr-url> [owner/repo] --governance-config <path>
// Exit:    0 = READY, 1 = NOT READY, 2 = usage/API error
//
// Governance config (loaded from --governance-config path, or auto-detected
// .claude/governance.json walking up from cwd):
//   {
//     "formalApprovalRepos": ["owner/repo"],
//     "formalApprovalBases": ["main"],
//     "approvalMarker": "^✅ \\*\\*Code Review Approved\\*\\*"
//   }
//
// Two approval tiers:
//   FORMAL: base branch in formalApprovalBases, or repo in formalApprovalRepos.
//     Requires a formal GitHub review APPROVED from an identity other than the author.
//   CONVENTION: everything else.
//     Formal APPROVED also satisfies it, or a PR comment matching approvalMarker.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function loadConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`warning: could not load governance config at ${configPath}: ${e.message}`);
    return {};
  }
}

function findDefaultConfig() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.claude', 'governance.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const POST_MERGE = process.argv.includes('--post-merge');
const configFlagIdx = process.argv.indexOf('--governance-config');
const configPath = configFlagIdx !== -1 ? process.argv[configFlagIdx + 1] : findDefaultConfig();
const config = loadConfig(configPath);

const FORMAL_APPROVAL_REPOS = config.formalApprovalRepos || [];
const FORMAL_APPROVAL_BASES = config.formalApprovalBases || ['main'];
const APPROVAL_MARKER = config.approvalMarker
  ? new RegExp(config.approvalMarker, 'm')
  : /^✅ \*\*Code Review Approved\*\*/m;

const argvPositional = process.argv.filter(
  (a, i) => a !== '--post-merge' && a !== '--governance-config'
    && process.argv[i - 1] !== '--governance-config'
);

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function parseArgs(argv) {
  const target = argv[2];
  if (!target || target === '--help' || target === '-h') {
    console.log('usage: verify-pr.js <pr-number|pr-url> [owner/repo] [--post-merge] [--governance-config <path>]');
    process.exit(target ? 0 : 2);
  }
  const urlMatch = target.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) return { owner: urlMatch[1], name: urlMatch[2], number: Number(urlMatch[3]) };
  const number = Number(target);
  if (!Number.isInteger(number)) {
    console.error(`error: '${target}' is not a PR number or URL`);
    process.exit(2);
  }
  const repo = argv[3] || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const [owner, name] = repo.split('/');
  return { owner, name, number };
}

const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      isDraft
      state
      title
      baseRefName
      author { login }
      reviewDecision
      latestOpinionatedReviews(first: 50) { nodes { author { login } state } }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 1) { nodes { author { login } body } }
        }
      }
      comments(last: 100) { nodes { author { login } body } }
    }
  }
}`;

const { owner, name, number } = parseArgs(argvPositional);
const repoFullName = `${owner}/${name}`;

let pr;
try {
  const raw = gh(['api', 'graphql',
    '-f', `query=${QUERY}`,
    '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]);
  pr = JSON.parse(raw).data.repository.pullRequest;
} catch (e) {
  console.error(`error: could not fetch PR #${number} in ${repoFullName}`);
  console.error(String(e.stderr || e.message).trim());
  process.exit(2);
}

const prAuthor = pr.author ? pr.author.login : '?';
const requireFormal = FORMAL_APPROVAL_REPOS.includes(repoFullName)
  || FORMAL_APPROVAL_BASES.includes(pr.baseRefName);

const blockers = [];
const warnings = [];

if (pr.isDraft) blockers.push('PR is a draft');
const okStates = POST_MERGE ? ['MERGED'] : ['OPEN'];
if (!okStates.includes(pr.state)) {
  blockers.push(`PR state is ${pr.state}, expected ${okStates.join('/')}`);
}

const opinionated = pr.latestOpinionatedReviews.nodes;
const changesRequested = opinionated.filter(r => r.state === 'CHANGES_REQUESTED');
for (const r of changesRequested) {
  blockers.push(`latest opinionated review from ${r.author.login} is CHANGES_REQUESTED`);
}
if (pr.reviewDecision === 'CHANGES_REQUESTED' && changesRequested.length === 0) {
  blockers.push('GitHub reviewDecision is CHANGES_REQUESTED (not visible in latest opinionated reviews)');
}

const formalApproval = opinionated.filter(r => r.state === 'APPROVED' && r.author.login !== prAuthor);

const unresolved = pr.reviewThreads.nodes.filter(t => !t.isResolved);
const threadsAreWarnings = POST_MERGE && formalApproval.length > 0;
for (const t of unresolved) {
  const first = t.comments.nodes[0] || {};
  const snippet = (first.body || '').replace(/\s+/g, ' ').slice(0, 100);
  const where = t.line ? `${t.path}:${t.line}` : t.path;
  const msg = `unresolved thread at ${where} (${first.author ? first.author.login : '?'}): "${snippet}"`;
  (threadsAreWarnings ? warnings : blockers).push(msg);
}

const markerComments = pr.comments.nodes.filter(c => APPROVAL_MARKER.test(c.body));
const independentMarkers = markerComments.filter(c => c.author && c.author.login !== prAuthor);
const selfSignedMarkers = markerComments.filter(c => !c.author || c.author.login === prAuthor);

if (requireFormal) {
  if (formalApproval.length === 0) {
    blockers.push(`this ${FORMAL_APPROVAL_REPOS.includes(repoFullName) ? 'repository' : `base branch (${pr.baseRefName})`} requires a formal APPROVED review from an identity other than the PR author (${prAuthor})`);
  }
} else if (formalApproval.length === 0 && markerComments.length === 0) {
  blockers.push('no approval signal: no formal APPROVED review and no "Code Review Approved" comment');
}
if (selfSignedMarkers.length > 0 && formalApproval.length === 0 && independentMarkers.length === 0) {
  warnings.push(`approval comment is SELF-SIGNED (author ${prAuthor} approving own PR) — convention only`);
}

console.log(`PR #${number} (${repoFullName}): ${pr.title}`);
console.log(`  author:              ${prAuthor}`);
console.log(`  base branch:         ${pr.baseRefName} [${requireFormal ? 'FORMAL approval tier' : 'convention tier'}]`);
console.log(`  review decision:     ${pr.reviewDecision || 'n/a'}`);
console.log(`  formal approvals:    ${formalApproval.map(r => r.author.login).join(', ') || 'none'}`);
console.log(`  approval comments:   ${markerComments.length === 0 ? 'none' : `${independentMarkers.length} independent, ${selfSignedMarkers.length} self-signed`}`);
console.log(`  changes requested:   ${changesRequested.length}`);
console.log(`  unresolved threads:  ${unresolved.length} of ${pr.reviewThreads.nodes.length}`);

if (warnings.length > 0) {
  console.log('\nWarnings:');
  for (const w of warnings) console.log(`  - ${w}`);
}

if (blockers.length > 0) {
  console.log('\nBlockers:');
  for (const b of blockers) console.log(`  - ${b}`);
  console.log('\nVERDICT: NOT READY');
  process.exit(1);
}

console.log('\nVERDICT: READY');
process.exit(0);
