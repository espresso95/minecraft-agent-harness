import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile, copyFile, readdir, chmod, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareServer } from './prepare-server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const action = process.argv[2] ?? 'up';
const state = resolve('.agent-state');
const env = {
    ...process.env,
    DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock`,
    LOCAL_UID: String(process.getuid()),
    LOCAL_GID: String(process.getgid()),
    LOCAL_STATE_DIR: state,
};
delete env.OPENAI_API_KEY;
const docker = args => {
    const result = spawnSync('docker', args, { env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Docker command failed');
};
const compose = [
    'compose',
    '--profile',
    'companions',
    '-p',
    'minecraft-companions',
    '-f',
    'compose.local.yaml',
    '-f',
    'compose.companions.yaml',
];

if (action === 'pair') {
    const game = resolve(process.argv[3] ?? join(homedir(), 'Library/Application Support/minecraft'));
    const connection = JSON.parse(await readFile(join(state, 'companions/controller/connection.json'), 'utf8'));
    await mkdir(join(game, 'config'), { recursive: true });
    await mkdir(join(game, 'mods'), { recursive: true });
    const config = join(game, 'config/companion-mailbox.json');
    await writeFile(config, JSON.stringify(connection, null, 2) + '\n', { mode: 0o600 });
    await chmod(config, 0o600);
    const build = resolve('mods/companion-mailbox/build/libs');
    const candidates = (await readdir(build)).filter(
        name => name.startsWith('companion-mailbox-') && name.endsWith('.jar') && !name.endsWith('-sources.jar'),
    );
    const jars = await Promise.all(
        candidates.map(async name => ({ name, time: (await stat(join(build, name))).mtimeMs })),
    );
    const jar = jars.sort((a, b) => b.time - a.time)[0]?.name;
    if (!jar) throw new Error('Build the mod first: npm run mod:build');
    await copyFile(join(build, jar), join(game, 'mods', jar));
    console.log(`Installed ${jar} and paired the controller in ${game}`);
    console.log('Use Fabric for Minecraft 1.21.6, with Fabric API 0.128.2+1.21.6. Open the mailbox with K.');
    process.exit(0);
}

if (!['up', 'down', 'logs'].includes(action)) throw new Error('Use up, down, logs or pair [Minecraft game directory]');
if (action === 'up') {
    await readFile(join(state, 'auth.json'));
    await prepareServer(join(state, 'server'));
    const build = spawnSync(process.execPath, ['scripts/build-mod.js'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('Companion mod/server plugin build failed');
    const plugins = join(state, 'server/plugins');
    await mkdir(plugins, { recursive: true });
    await copyFile(
        resolve('mods/companion-mailbox/build/libs/companion-rules.jar'),
        join(plugins, 'companion-rules.jar'),
    );
    if (spawnSync('colima', ['--profile', 'default', 'status'], { stdio: 'ignore' }).status !== 0) {
        const result = spawnSync(
            'colima',
            ['start', 'default', '--cpu', '6', '--memory', '8', '--save-config=false', '--activate=false'],
            { stdio: 'inherit' },
        );
        if (result.status !== 0) throw new Error('Colima failed to start');
    }
    const discovery = spawnSync(process.execPath, ['scripts/claude-host.js', state, '--discover'], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 30000,
    });
    if (discovery.status !== 0) console.log('Claude Code is unavailable; OpenAI companions remain available.');
    docker(['build', '-q', '-f', 'Dockerfile.local', '-t', 'minecraft-companions:local', '.']);
    console.log('Saved companions join paused. Open K to manage the roster, then Start or Resume when ready.');
    console.log('Join localhost:25565 with Fabric Minecraft 1.21.6.');
    console.log('Press Ctrl+C to stop. The world, mailbox and token history are saved locally.');
}
const group = spawnSync('colima', ['--profile', 'default', 'ssh', '--', 'stat', '-c', '%g', '/var/run/docker.sock'], {
    encoding: 'utf8',
});
env.DOCKER_SOCKET_GID = group.stdout.trim() || '991';
const args =
    action === 'up'
        ? [
              ...compose,
              'up',
              '--no-build',
              '--abort-on-container-exit',
              '--exit-code-from',
              'controller',
              'server',
              'controller',
          ]
        : action === 'down'
          ? [...compose, 'down']
          : [...compose, 'logs', '--follow', '--tail', '60'];
const child = spawn('docker', args, { env, stdio: 'inherit' });
const gateway =
    action === 'up' ? spawn(process.execPath, ['scripts/local-web.js', state], { env, stdio: 'inherit' }) : null;
const claude =
    action === 'up'
        ? spawn(process.execPath, ['scripts/claude-host.js', state], { env, stdio: ['ignore', 'ignore', 'pipe'] })
        : null;
claude?.stderr.on('data', chunk => process.stderr.write(chunk));
claude?.on('error', error => console.error('Claude Code:', error.message));
let stopping = false;
function stop(signal) {
    if (stopping) return;
    stopping = true;
    gateway?.kill('SIGTERM');
    claude?.kill('SIGTERM');
    if (action !== 'up') {
        child.kill(signal);
        return;
    }
    // Docker's CLI plugin can outlive a signal sent to its parent process.
    // Use the same explicit shutdown as companions:stop so closing the game
    // also stops the workers and saves the server.
    const shutdown = spawn('docker', [...compose, 'down'], { env, stdio: 'inherit' });
    shutdown.once('error', error => {
        console.error(error.message);
        child.kill('SIGTERM');
    });
    shutdown.once('exit', () => child.kill('SIGTERM'));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
child.once('exit', code => {
    gateway?.kill('SIGTERM');
    claude?.kill('SIGTERM');
    process.exitCode = code ?? 1;
});
child.once('error', error => {
    gateway?.kill('SIGTERM');
    claude?.kill('SIGTERM');
    console.error(error.message);
    process.exitCode = 1;
});

gateway?.once('error', error => {
    console.error('Web UI:', error.message);
    child.kill('SIGTERM');
    process.exitCode = 1;
});
