#!/usr/bin/env node
// PreToolUse gate for Bash commands (Claude Code hook).
//
// Enforces branch governance mechanically, before a command runs.
// Reads .claude/governance.json for repo-specific config.
//
// Governance config shape (.claude/governance.json):
//   {
//     "ownRepo": "owner/repo",
//     "protectedBranchesFile": ".githooks/protected-branches",
//     "verifyPrPath": null
//   }
//
// Exit 0 = allow. Exit 2 = block.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.claude', 'governance.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

const REPO_ROOT = findRepoRoot();
const config = loadConfig(REPO_ROOT);

const VERIFY_PR = config.verifyPrPath
  ? path.resolve(REPO_ROOT, config.verifyPrPath)
  : path.join(__dirname, 'verify-pr.js');

const BRANCH_LIST = config.protectedBranchesFile
  ? path.join(REPO_ROOT, config.protectedBranchesFile)
  : path.join(REPO_ROOT, '.githooks', 'protected-branches');

const OWN_REPO = config.ownRepo || null;

function protectedBranches() {
  try {
    return fs.readFileSync(BRANCH_LIST, 'utf8').split('\n')
      .map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  } catch {
    return ['devline', 'main'];
  }
}

function block(msg) {
  console.error(`BLOCKED (gate-pr-merge): ${msg}`);
  process.exit(2);
}

function extractLeadingCwd(cmd) {
  const beforePush = cmd.split(/git\s+push/)[0];
  if (!beforePush) return null;
  const cdMatches = beforePush.match(/cd\s+["']?([^"';&|]+)["']?/g);
  if (!cdMatches || cdMatches.length === 0) return null;
  const m = cdMatches[cdMatches.length - 1].match(/cd\s+["']?([^"';&|]+)["']?/);
  return m ? m[1].trim() : null;
}

function resolveRemoteRepo(remoteName, cwd) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', remoteName], {
      encoding: 'utf8',
      cwd: cwd || undefined,
    }).trim();
    const m = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function protectedBranchAlreadyExistsOnRemote(remoteRepo, branchName) {
  try {
    execFileSync('gh', ['api', `repos/${remoteRepo}/branches/${branchName}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (e) {
    const stderr = String(e.stderr || e.message || '');
    if (/HTTP 404|Not Found/i.test(stderr)) return false;
    return true;
  }
}

function isGenesisBranchPush(cmd, branchName) {
  const pushTarget = cmd.match(/git\s+push\s+(?:-{1,2}\S+\s+)*(\S+)\s+/);
  if (!pushTarget) return false;
  const cwd = extractLeadingCwd(cmd);
  if (!cwd) return false;
  const remoteRepo = resolveRemoteRepo(pushTarget[1], cwd);
  if (!remoteRepo) return false;
  return !protectedBranchAlreadyExistsOnRemote(remoteRepo, branchName);
}

function buildGovernanceConfigArgs() {
  const configPath = path.join(REPO_ROOT, '.claude', 'governance.json');
  if (fs.existsSync(configPath)) return ['--governance-config', configPath];
  return [];
}

function runVerify(target, repo) {
  const args = [VERIFY_PR, target];
  if (repo) args.push(repo);
  args.push(...buildGovernanceConfigArgs());
  try {
    const out = execFileSync('node', args, { encoding: 'utf8', cwd: REPO_ROOT });
    process.stdout.write(out);
    process.exit(0);
  } catch (e) {
    console.error('BLOCKED (gate-pr-merge): verify-pr did not return READY.');
    console.error(String(e.stdout || '').trim());
    console.error(String(e.stderr || '').trim());
    process.exit(2);
  }
}

function evaluate(cmd) {
  const scopePushMatch = cmd.match(/git\s+push\s+(?:-{1,2}\S+\s+)*(\S+)\s+/);
  if (scopePushMatch && OWN_REPO) {
    const scopeCwd = extractLeadingCwd(cmd);
    const scopeRemoteRepo = resolveRemoteRepo(scopePushMatch[1], scopeCwd);
    if (scopeRemoteRepo && scopeRemoteRepo !== OWN_REPO) {
      process.exit(0);
    }
  }

  const P = protectedBranches().map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const AT = '(?:^|[;&|]\\s*|\\n\\s*)';
  const GAP = '[^;&|\\n"\']*';
  const REF = '[\\s:=](' + P + ')(?![\\w./-])';

  if (/PFM_ALLOW_PROTECTED_(PUSH|COMMIT)/.test(cmd)) {
    block('the PFM_ALLOW_PROTECTED_* escape hatches are for Humans-team members at a terminal, not for agent commands.');
  }
  if (new RegExp(AT + 'git\\s+' + GAP + '\\b(commit|push)\\b' + GAP + '--no-verify\\b').test(cmd)) {
    block('--no-verify skips the governance hooks and is prohibited.');
  }
  if (new RegExp(AT + 'git\\b' + GAP + '-c\\s*core\\.hooksPath').test(cmd)) {
    block('overriding core.hooksPath is prohibited — it disarms the governance hooks.');
  }

  const pushMatch = cmd.match(new RegExp(AT + 'git\\s+' + GAP + 'push\\b' + GAP + REF));
  if (pushMatch) {
    const branchName = pushMatch[1];
    if (!isGenesisBranchPush(cmd, branchName)) {
      block('pushing to a protected branch is prohibited. Protected branches advance only via reviewed PR merges on GitHub.');
    }
    console.error(
      `ALLOWED (gate-pr-merge): '${branchName}' does not exist yet on this remote — genesis push exception. The remote branch-governance audit still reviews this commit.`
    );
  }

  if (new RegExp(AT + 'gh\\s+api\\b' + GAP + 'git\\/refs\\/heads\\/(' + P + ')(?![\\w./-])').test(cmd)) {
    block('API rewrites of protected branch refs are prohibited.');
  }
  if (new RegExp(AT + 'gh\\s+api\\b' + GAP + '\\/merges\\b' + GAP + REF).test(cmd)) {
    block('the branch-merge API endpoint may not target protected branches.');
  }

  const contentsWrite = cmd.match(new RegExp(AT + 'gh\\s+api\\b(' + GAP + '\\/contents\\/' + GAP + ')'));
  if (contentsWrite && /(-X|--method)[= ]\s*['"]?(PUT|DELETE)\b/i.test(cmd)) {
    const branchParam = (cmd.match(/\bbranch=([\w.\/-]+)/) || [])[1];
    if (!branchParam || protectedBranches().includes(branchParam)) {
      block(`contents-API writes ${branchParam ? `to '${branchParam}'` : 'without an explicit branch= (which targets the DEFAULT branch)'} are prohibited on protected branches.`);
    }
  }

  const apiPrMerge = cmd.match(new RegExp(AT + 'gh\\s+api\\b' + GAP + '\\/pulls\\/(\\d+)\\/merge\\b'));
  if (apiPrMerge) {
    const repoInPath = (cmd.match(/repos\/([\w.-]+\/[\w.-]+)\/pulls\//) || [])[1];
    runVerify(apiPrMerge[1], repoInPath);
  }

  if (new RegExp(AT + 'gh\\s+pr\\s+merge(\\s|$)').test(cmd)) {
    const target = (cmd.match(new RegExp(AT + 'gh\\s+pr\\s+merge\\s+(?:' + GAP + '\\s)?(https:\\/\\/github\\.com\\/\\S+\\/pull\\/\\d+|\\d+)\\b')) || [])[1];
    if (!target) {
      block('run `gh pr merge` with an explicit PR number or URL so the merge can be verified first.');
    }
    const repoFlag = (cmd.match(/(?:--repo|-R)[= ]\s*([\w.-]+\/[\w.-]+)/) || [])[1];
    runVerify(target, repoFlag);
  }

  process.exit(0);
}

let raw = '';
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  let cmd;
  try {
    cmd = (JSON.parse(raw).tool_input || {}).command;
  } catch {
    process.exit(0);
  }
  if (typeof cmd !== 'string' || cmd === '') process.exit(0);
  try {
    evaluate(cmd);
  } catch (e) {
    console.error(`BLOCKED (gate-pr-merge): internal error while evaluating command — failing closed. ${e.message}`);
    process.exit(2);
  }
});
