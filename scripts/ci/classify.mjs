import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

// Keep the workflow running for every PR: this step selects jobs, and the final
// CI result job gives branch protection one stable required check.
const jobNames = ['linux', 'browser', 'windows', 'postgres', 'package', 'load'];
const selected = Object.fromEntries(jobNames.map(name => [name, false]));
let profile = 'selective';
let reason = '';
let changedFiles = [];

function full(why, name = 'full') {
  for (const job of jobNames) selected[job] = true;
  profile = name;
  reason = why;
}

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commit(value) {
  // Only object IDs may enter git arguments. Paths always come from NUL-delimited
  // git output, never from a shell command or a whitespace-delimited list.
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/i.test(value) || /^0+$/.test(value)) {
    throw new Error('missing-or-invalid-diff-commit');
  }
  return value;
}

function readChanges(eventName, event) {
  let base;
  let head;
  if (eventName === 'pull_request') {
    head = commit(event.pull_request?.head?.sha);
    base = git('merge-base', commit(event.pull_request?.base?.sha), head).trim();
    commit(base);
  } else if (eventName === 'push') {
    base = commit(event.before);
    head = commit(event.after);
  } else {
    throw new Error('unsupported-event');
  }

  // --no-renames reports an old path as deleted and the new path as added.
  // Both sides must be classified, including a file moved out of a critical area.
  const fields = git('diff', '--name-status', '-z', '--no-renames', base, head, '--').split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) throw new Error('invalid-diff-output');
  const paths = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (!/^[ACDMTUXB]$/.test(fields[index]) || !fields[index + 1]) {
      throw new Error('invalid-diff-entry');
    }
    paths.push(fields[index + 1]);
  }
  return [...new Set(paths)].sort();
}

function classifyPath(path) {
  if (path.startsWith('deploy/')
    || /^scripts\/(Publish-Windows|Collect-Licenses)\.ps1$/.test(path)
    || path.startsWith('third-party/')
    || path === 'LICENSE'
    || /^docs\/(DEPLOYMENT|VALIDATION|PERFORMANCE)\.md$/.test(path)
    || path.startsWith('docs/releases/')
    || path.startsWith('docs/benchmarks/')) {
    selected.package = true;
    return true;
  }

  // Restrict the lightweight path to prose and inert design assets. A script
  // added below docs/ must not accidentally avoid compilation and regression.
  if (path === 'README.md'
    || /^docs\/(?:[^/]+\/)*[^/]+\.md$/i.test(path)
    || /^docs\/design\/(?:[^/]+\/)*[^/]+\.(?:png|jpe?g|gif|webp|svg|avif|pdf)$/i.test(path)) {
    return true;
  }

  if (/^src\/DWorkBench\.Client\/src\/.+\.(?:[cm]?[jt]sx?|css|svg|png|jpe?g|gif|webp|woff2?)$/.test(path)
    || path === 'src/DWorkBench.Client/index.html') {
    selected.linux = selected.browser = true;
    return true;
  }

  if (/^src\/DWorkBench\.Server\/.+\.cs$/.test(path)) {
    selected.linux = selected.windows = selected.postgres = true;
    if (/\/(?:Program|Application\/(?:Endpoints|Security|Workspaces)|Domain\/Models)\.cs$/.test(path)) {
      selected.browser = true;
    }
    if (/\/(?:Program|Domain\/Models|Infrastructure\/(?:RemoteLogs|SftpLogFollower|SharedLogBroker)|Application\/(?:LogsHub|ScanCoordinator))\.cs$/.test(path)) {
      selected.load = true;
    }
    return true;
  }

  // Dependencies, project/configuration files, CI, shared scripts/tests and
  // newly introduced paths intentionally fall through to the full profile.
  return false;
}

try {
  const requestedProfile = process.env.CI_PROFILE || 'auto';
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  if (requestedProfile === 'full' || requestedProfile === 'extended') {
    full(`requested-${requestedProfile}`, requestedProfile);
  } else if (requestedProfile !== 'auto') {
    full('unknown-requested-profile');
  } else {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    changedFiles = readChanges(eventName, event);
    if (changedFiles.length === 0) {
      full('empty-diff');
    } else if (changedFiles.some(path => !classifyPath(path))) {
      full('unmapped-or-shared-change');
    } else if (eventName === 'push' && event.ref === 'refs/heads/main' && jobNames.some(job => selected[job])) {
      full('main-runtime-or-package-change');
    } else if (eventName === 'push' && event.ref !== 'refs/heads/main') {
      full('non-main-push');
    } else if (jobNames.every(job => !selected[job])) {
      profile = 'docs';
      reason = 'ordinary-documentation-only';
    } else {
      reason = 'mapped-pull-request-changes';
    }
  }
} catch (error) {
  // Missing history and new branches are expected conservative fallbacks.
  // Unexpected exceptions also enable every check instead of silently skipping.
  full('classification-failed-full-fallback');
  console.warn(`Classification could not narrow checks; running full CI (${error instanceof Error ? error.name : 'error'}).`);
}

const outputs = { ...selected, profile, reason };
const output = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n');
console.log(output);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const enabled = jobNames.filter(job => selected[job]);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '## CI scope',
    '',
    `- Profile: **${profile}**`,
    `- Reason: \`${reason}\``,
    `- Changed paths: ${changedFiles.length || 'not available'}`,
    `- Selected checks: ${enabled.join(', ') || 'documentation only'}`,
    '- Documentation links and conflict markers are checked for every scope.',
    '',
  ].join('\n'));
}
