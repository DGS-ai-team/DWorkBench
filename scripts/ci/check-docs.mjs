import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

// Static, offline checks only. Supports Markdown inline/image links and reference
// definitions. Does not validate heading anchors, external URLs, HTML links,
// generated MDX or dynamically constructed links.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\0').filter(Boolean);
const failures = [];
let markdownCount = 0;
let localLinkCount = 0;

function fail(file, line, message) {
  failures.push(`${file}:${line}: ${message}`);
}

function withoutCode(source) {
  let fence = null;
  const text = source.split('\n').map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.character && match[1].length >= fence.length && match[2].trim() === '') fence = null;
      return '';
    }
    if (match) {
      fence = { character: match[1][0], length: match[1].length };
      return '';
    }
    return line;
  }).join('\n');
  // Preserve line numbers while ignoring inline code and HTML comments.
  return text.replace(/(`+)([\s\S]*?)\1(?!`)|<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '));
}

function checkTarget(file, line, raw) {
  let target = raw.replace(/\\(.)/g, (escape, character) =>
    /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/.test(character) ? character : escape).trim();
  if (!target || target.startsWith('#') || target.startsWith('?')
    || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) return;
  target = target.split(/[?#]/, 1)[0];
  try { target = decodeURIComponent(target); }
  catch { fail(file, line, `Invalid URL encoding in local link: ${JSON.stringify(raw)}`); return; }
  if (!target) return;
  localLinkCount += 1;
  const destination = target.startsWith('/')
    ? resolve(root, `.${target}`)
    : resolve(root, dirname(file), target);
  const within = relative(root, destination);
  if (within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) {
    fail(file, line, `Local link leaves the repository: ${JSON.stringify(raw)}`);
    return;
  }
  try { statSync(destination); }
  catch { fail(file, line, `Missing local link target: ${JSON.stringify(raw)}`); }
}

// Extract a destination after '(' or after a reference definition ':'. Balanced
// parentheses and angle-bracket paths are supported; optional titles are ignored.
function destinationAt(text, start, inline) {
  let index = start;
  while (/\s/.test(text[index] || '') && index < text.length) index += 1;
  if (text[index] === '<') {
    const begin = ++index;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index] === '>') return { target: text.slice(begin, index), end: index + 1 };
      if (text[index] === '\n') return null;
      index += 1;
    }
    return null;
  }
  const begin = index;
  let nesting = 0;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') { index += 1; continue; }
    if (char === '(') nesting += 1;
    else if (char === ')') {
      if (nesting === 0) return inline ? { target: text.slice(begin, index), end: index } : null;
      nesting -= 1;
    } else if (/\s/.test(char)) {
      return nesting === 0 ? { target: text.slice(begin, index), end: index } : null;
    }
  }
  return nesting === 0 && !inline ? { target: text.slice(begin), end: index } : null;
}

for (const file of tracked) {
  let buffer;
  try { buffer = readFileSync(resolve(root, file)); }
  catch (error) {
    fail(file, 1, `Cannot read tracked file (${error.code || error.name})`);
    continue;
  }
  if (buffer.includes(0)) continue;
  const source = buffer.toString('utf8');
  source.split('\n').forEach((line, index) => {
    if (/^(?:<{7}(?: |$)|={7}\s*$|>{7}(?: |$)|\|{7}(?: |$))/.test(line)) {
      fail(file, index + 1, 'Unresolved merge-conflict marker');
    }
  });
  if (!/\.md$/i.test(file)) continue;
  markdownCount += 1;
  const text = withoutCode(source);
  for (const match of text.matchAll(/!?\[(?:\\.|[^\]\\\n])*\]\(/g)) {
    const parsed = destinationAt(text, match.index + match[0].length, true);
    if (parsed) checkTarget(file, text.slice(0, match.index).split('\n').length, parsed.target);
  }
  for (const match of text.matchAll(/^ {0,3}\[(?:\\.|[^\]\\\n])+\]:[ \t]*/gm)) {
    const parsed = destinationAt(text, match.index + match[0].length, false);
    if (parsed) checkTarget(file, text.slice(0, match.index).split('\n').length, parsed.target);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  console.error(`Documentation/static checks failed: ${failures.length} issue(s).`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${markdownCount} Markdown files, ${localLinkCount} local links and conflict markers in tracked text files.`);
  console.log('External URLs, heading anchors and HTML/MDX links are outside this static check.');
}
