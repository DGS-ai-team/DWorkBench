// Read-only lookup. Only an exact-commit, successful main push can supply a release.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const tag = process.env.RELEASE_TAG;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
  throw new Error('GITHUB_REPOSITORY and an Actions-read token are required.');
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? ''))
  throw new Error('A stable vMAJOR.MINOR.PATCH release tag is required.');
const version = tag.slice(1);
const project = readFileSync('src/DWorkBench.Server/DWorkBench.Server.csproj', 'utf8');
const versions = [...project.matchAll(/<Version>\s*([^<]+?)\s*<\/Version>/g)];
const client = JSON.parse(readFileSync('src/DWorkBench.Client/package.json', 'utf8'));
if (versions.length !== 1 || versions[0][1] !== version || client.version !== version)
  throw new Error('Release tag, server version and client version must match.');
if (!readFileSync(`docs/releases/${tag}.md`, 'utf8').trim())
  throw new Error('Release notes must not be empty.');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = git('rev-parse', 'HEAD^{commit}');
if (!/^[a-f0-9]{40}$/.test(commit) || git('rev-parse', `refs/tags/${tag}^{commit}`) !== commit)
  throw new Error('The checkout must point to the requested release tag commit.');
try { git('merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'); }
catch { throw new Error('The release commit must be on origin/main.'); }

const base = new URL(process.env.GITHUB_API_URL || 'https://api.github.com');
if (base.protocol !== 'https:') throw new Error('GitHub API must use HTTPS.');
const repoPath = `/repos/${repository}`;
const started = Date.now();
const deadline = started + 10 * 60 * 1000;
const discoveryDeadline = started + 30 * 1000;
class LookupDeadline extends Error {}
async function api(path) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LookupDeadline();
  let response;
  try {
    response = await fetch(`${base.href.replace(/\/$/, '')}${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      redirect: 'error',
    });
  } catch (error) {
    if (Date.now() >= deadline) throw new LookupDeadline();
    throw error;
  }
  if (!response.ok) throw new Error(`GitHub candidate lookup failed (HTTP ${response.status}).`);
  return response.json();
}
async function list(path, key) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(data[key])) throw new Error(`Unexpected GitHub ${key} response.`);
    all.push(...data[key]);
    if (data[key].length < 100 || all.length >= data.total_count) return all;
  }
  // A partial result could omit a newer attempt; never guess from truncated data.
  throw new Error(`GitHub ${key} pagination exceeded the bounded lookup.`);
}
function exactMainRun(run) {
  return run.event === 'push' && run.head_branch === 'main' && run.head_sha === commit &&
    run.repository?.full_name?.toLowerCase() === repository.toLowerCase() &&
    run.head_repository?.full_name?.toLowerCase() === repository.toLowerCase() &&
    run.name === 'CI' && run.path?.split('@')[0] === '.github/workflows/ci.yml';
}
function output(values) {
  const entries = Object.entries({ commit, reusable: 'false', run_id: '', artifact_id: '', ...values });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  appendFileSync(process.env.GITHUB_OUTPUT, entries.map(([key, value]) => `${key}=${value}\n`).join(''));
}
let candidate;
try {
while (Date.now() < deadline - 15_000) {
  const runs = (await list(`${repoPath}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${commit}`, 'workflow_runs'))
    .filter(exactMainRun).sort((a, b) => b.id - a.id);
  for (const run of runs.filter(item => item.status === 'completed' && item.conclusion === 'success')) {
    if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)
      throw new Error('Unexpected workflow run identity.');
    // Use the latest attempt, never a successful marker from an earlier attempt.
    const jobs = await list(`${repoPath}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
    const qualified = jobs.filter(job => job.name === 'Release qualification');
    if (qualified.length !== 1 || qualified[0].status !== 'completed' || qualified[0].conclusion !== 'success') continue;
    const artifacts = (await list(`${repoPath}/actions/runs/${run.id}/artifacts?name=DWorkBench-win-x64`, 'artifacts'))
      .filter(item => item.name === 'DWorkBench-win-x64' && item.expired === false &&
        Date.parse(item.expires_at) > Date.now() + 15 * 60 * 1000 && item.size_in_bytes > 0 &&
        item.workflow_run?.id === run.id && item.workflow_run?.head_sha === commit &&
        item.workflow_run?.head_branch === 'main');
    if (artifacts.length !== 1) continue;
    if (!Number.isSafeInteger(artifacts[0].id)) throw new Error('Unexpected artifact identity.');
    // Re-fetch the run so a concurrently started rerun cannot qualify an old result.
    const current = await api(`${repoPath}/actions/runs/${run.id}`);
    if (!exactMainRun(current) || current.run_attempt !== run.run_attempt ||
        current.status !== 'completed' || current.conclusion !== 'success') continue;
    candidate = { reusable: 'true', run_id: String(run.id), artifact_id: String(artifacts[0].id) };
    break;
  }
  if (candidate) break;
  const pending = runs.some(run => run.status !== 'completed');
  if (!pending && (runs.length > 0 || Date.now() >= discoveryDeadline)) break;
  console.log(pending ? 'Waiting for CI on the release commit to finish…' : 'Waiting briefly for the main CI run to appear…');
  await delay(Math.min(15_000, Math.max(0, deadline - Date.now() - 15_000)));
}
} catch (error) {
  if (!(error instanceof LookupDeadline)) throw error;
  // A pending main run may outlast the wait budget; rebuild instead of reusing it.
  candidate = undefined;
}
output(candidate ?? {});
console.log(candidate ? `Reusing qualified main CI run ${candidate.run_id}, artifact ${candidate.artifact_id}.` :
  'No reusable qualified artifact is available; the release workflow will run the full baseline.');
