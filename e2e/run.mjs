// Boots the stub-API harness, runs the wizard tests against the real site
// files, and shuts the harness down again.
import { spawn } from 'node:child_process';
import path from 'node:path';

const dir = import.meta.dirname;
const harness = spawn(process.execPath, [path.join(dir, 'server.mjs')], { stdio: 'inherit' });
const stop = () => { try { harness.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

await new Promise((r) => setTimeout(r, 1200));
const tests = spawn(process.execPath, [path.join(dir, 'flows.spec.mjs')], { stdio: 'inherit' });
tests.on('exit', (code) => { stop(); process.exit(code ?? 1); });
