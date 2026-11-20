import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');
const temp = path.join(runtime, 'build-temp');
fs.mkdirSync(temp, { recursive: true });
const env = { ...process.env, TEMP: temp, TMP: temp };
const build = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(build.status ?? 1);
const inUse = port => new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
});
const processes = [];
for (const service of [
    { name: 'gateway', port: 5180, args: ['server/gateway.mjs'] },
    { name: 'compatibility', port: 5181, args: ['server/compatibility-host.mjs'] },
    { name: 'web', port: 5179, args: ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5179', '--strictPort'] },
]) {
    if (await inUse(service.port)) { console.log(`${service.name}: port ${service.port} already in use; existing service kept.`); continue; }
    const out = fs.openSync(path.join(runtime, `${service.name}.log`), 'a');
    const err = fs.openSync(path.join(runtime, `${service.name}-error.log`), 'a');
    const child = spawn(process.execPath, service.args, { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', out, err] });
    fs.closeSync(out); fs.closeSync(err);
    child.unref(); processes.push({ name: service.name, port: service.port, pid: child.pid });
    console.log(`${service.name}: started on ${service.port}, PID ${child.pid}`);
}
fs.writeFileSync(path.join(runtime, 'local-processes.json'), JSON.stringify({ updatedAt: new Date().toISOString(), processes }, null, 2));
console.log('Open http://localhost:5179 . See .runtime/*-error.log for startup errors.');
