import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const backend = spawn(process.execPath, ['scripts/companions-local.js', 'up'], { stdio: 'inherit' });
let backendExited = false,
    client,
    stopping = false;
backend.once('exit', () => {
    backendExited = true;
});
const stop = () => {
    if (stopping) return;
    stopping = true;
    client?.kill('SIGTERM');
    backend.kill('SIGINT');
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
try {
    let connection;
    for (let i = 0; i < 600; i++) {
        if (backendExited) throw new Error('The local server stopped before it was ready');
        try {
            connection = JSON.parse(await readFile('.agent-state/companions/controller/connection.json', 'utf8'));
            const health = await fetch(connection.endpoint + '/health', { signal: AbortSignal.timeout(1000) });
            if (health.ok) break;
        } catch {}
        connection = null;
        await delay(1000);
    }
    if (!connection) throw new Error('The local server did not become ready');
    console.log('Waiting for the companions to join…');
    for (let i = 0; i < 45; i++) {
        const response = await fetch(connection.endpoint + '/v1/state', {
            signal: AbortSignal.timeout(2000),
            headers: { authorization: 'Bearer ' + connection.token },
        });
        const state = await response.json();
        if (state.agents.every(agent => !['starting', 'reconnecting'].includes(agent.state))) break;
        await delay(1000);
    }
    const game = resolve('mods/companion-mailbox/run');
    await mkdir(resolve(game, 'config'), { recursive: true });
    await writeFile(resolve(game, 'config/companion-mailbox.json'), JSON.stringify(connection), { mode: 0o600 });
    const optionsFile = resolve(game, 'options.txt');
    let options;
    try {
        options = await readFile(optionsFile, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        options = '';
    }
    // Only the development client: its first-launch welcome screen blocks Quick Play.
    options = options.replace(/^onboardAccessibility:.*$/m, 'onboardAccessibility:false');
    if (!/^onboardAccessibility:/m.test(options)) options += '\nonboardAccessibility:false\n';
    await writeFile(optionsFile, options);
    console.log('Opening the Fabric development client as LocalPlayer. Press K, then Resume to begin model requests.');
    client = spawn(
        process.execPath,
        ['scripts/build-mod.js', 'runClient', '--args=--username LocalPlayer --quickPlayMultiplayer 127.0.0.1:25565'],
        { stdio: 'inherit' },
    );
    const code = await new Promise((resolveExit, reject) => {
        client.once('exit', resolveExit);
        client.once('error', reject);
    });
    process.exitCode = stopping ? 0 : (code ?? 1);
} finally {
    stop();
}
