import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../src/LogDesk.Server/Infrastructure/follow_log.py', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export const remoteCommand = (filename, download = false) => 'python3 -u -c ' + quote(script) + (download ? ' --download ' : ' ') + quote(filename);
