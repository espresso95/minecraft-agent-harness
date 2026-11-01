import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { defaultProfile } from '../src/controller/profiles.js';
import { prepareServer } from './prepare-server.js';

const exec = promisify(execFile);
const root = resolve('.agent-state/verification/companions', new Date().toISOString().replace(/[:.]/g, '-'));
const env = {
    ...process.env,
    DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock`,
    LOCAL_STATE_DIR: root,
    LOCAL_UID: String(process.getuid()),
    LOCAL_GID: String(process.getgid()),
    COMPANION_AUTO_START: '1',
};
const docker = async args => (await exec('docker', args, { env, timeout: 180000, maxBuffer: 2e6 })).stdout;
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
const command = async (...args) =>
    stripVTControlCharacters(await docker(['exec', 'minecraft-companions-server-1', 'rcon-cli', ...args])).trim();
const waitFor = async (condition, label, timeout = 120000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await condition()) return;
        await delay(250);
    }
    throw new Error('Timed out: ' + label);
};
assert.equal(
    (await docker(['ps', '-q', '--filter', 'label=com.docker.compose.project=minecraft-companions'])).trim(),
    '',
    'Stop the companion stack before running the isolated test',
);
env.DOCKER_SOCKET_GID = (
    await exec('colima', ['--profile', 'default', 'ssh', '--', 'stat', '-c', '%g', '/var/run/docker.sock'])
).stdout.trim();
await exec(process.execPath, ['scripts/build-mod.js'], { timeout: 180000, maxBuffer: 2e6 });
await mkdir(root, { recursive: true });
await exec('cp', ['-cR', resolve('.agent-state/server'), join(root, 'server')]);
await rm(join(root, 'server/plugins/CompanionRules'), { recursive: true, force: true });
const plugin = join(root, 'server/plugins/CompanionRules');
await mkdir(plugin, { recursive: true });
await writeFile(join(plugin, 'config.yml'), 'permanent-death: false\n');
await copyFile(
    'mods/companion-mailbox/build/libs/companion-rules-0.1.0+1.21.6.jar',
    join(root, 'server/plugins/companion-rules.jar'),
);
await prepareServer(join(root, 'server'));
await mkdir(join(root, 'companions/controller'), { recursive: true });
await writeFile(
    join(root, 'companions/controller/settings.json'),
    JSON.stringify({ agents: ['Scout', 'Builder', 'Watcher'].map(name => ({ ...defaultProfile, name })) }),
);
const override = join(root, 'compose-test.yaml');
await writeFile(
    override,
    `services:\n  controller:\n    environment:\n      COMPANION_AUTH_FILE: ${JSON.stringify(resolve('.agent-state/auth.json'))}\n    volumes:\n      - ${JSON.stringify(resolve('.agent-state') + ':' + resolve('.agent-state'))}\n`,
);
compose.push('-f', override);
console.log('Isolated world:', root);
await docker(['build', '-q', '-f', 'Dockerfile.local', '-t', 'minecraft-companions:local', '.']);
let connection, ui, gateway;
const bots = new Set();
const proof = { testedAt: new Date().toISOString(), isolatedWorld: root, checks: [] };
const api = async (
    path,
    body,
    method = body ? 'POST' : 'GET',
    token = connection.token,
    endpoint = connection.endpoint,
) => {
    const response = await fetch(endpoint + path, {
        method,
        signal: AbortSignal.timeout(30000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`API ${response.status}: ${value.error}`);
    return value;
};
const settings = (difficulty, permanentDeath) =>
    api('/v1/server', { player: 'RuleTester', settings: { difficulty, permanentDeath } }, 'PATCH');
const connect = async (name, host = '127.0.0.1') => {
    const bot = mineflayer.createBot({
        host,
        port: 25565,
        username: name,
        auth: 'offline',
        version: '1.21.6',
        respawn: false,
    });
    bots.add(bot);
    await new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('Bot login timed out')), 20000);
        bot.once('spawn', () => {
            clearTimeout(timer);
            ok();
        });
        bot.once('error', fail);
        bot.once('kicked', reason => fail(new Error(JSON.stringify(reason))));
    });
    return bot;
};
const die = async (bot, mode) => {
    await delay(3500);
    await command('kill', bot.username);
    await waitFor(() => !bot.isAlive, 'death of ' + bot.username, 10000);
    bot.respawn();
    await waitFor(() => bot.health > 0 && bot.game.gameMode === mode, 'respawn as ' + mode, 15000);
};
const quit = bot => {
    bot.quit();
    bots.delete(bot);
};
try {
    await docker([...compose, 'up', '-d', '--no-build', 'server', 'controller']);
    await waitFor(async () => {
        try {
            connection = JSON.parse(await readFile(join(root, 'companions/controller/connection.json'), 'utf8'));
            return (await api('/v1/state')).server.available;
        } catch {
            return false;
        }
    }, 'server/controller readiness');
    await waitFor(async () => (await api('/v1/state')).agents.every(a => a.state === 'paused'), 'three paused workers');
    // SQLite must only be opened by Linux while the controller/workers are live.
    await docker([
        'exec',
        'minecraft-companions-controller-1',
        'node',
        '--input-type=module',
        '-e',
        `import { MailboxStore } from './src/comms/mailbox-store.js'; const store = new MailboxStore(${JSON.stringify(join(root, 'companions/shared/mailbox.sqlite'))}, 'Watcher'); store.sendMany(['Builder'], 'Fixture coordination message', 'fixture-message-0001'); store.close();`,
    ]);
    gateway = spawn(process.execPath, ['scripts/local-web.js', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', chunk =>
        process.stdout.write(chunk.toString().replace(/Pairing code: \w+/g, 'Pairing code: [private]')),
    );
    gateway.stderr.pipe(process.stderr);
    await waitFor(async () => {
        try {
            return (await fetch('http://127.0.0.1:8767/health')).ok;
        } catch {
            return false;
        }
    }, 'Mac web gateway');
    ui = spawn(process.execPath, ['scripts/build-mod.js', 'runClientGameTest'], {
        stdio: 'inherit',
        env: {
            ...process.env,
            COMPANION_CONNECTION_FILE: join(root, 'companions/controller/connection.json'),
            COMPANION_APPEARANCES_FILE: join(plugin, 'appearances.json'),
        },
    });
    const timer = setTimeout(() => ui.kill('SIGTERM'), 300000);
    const uiCode = await new Promise((ok, fail) => {
        ui.once('exit', ok);
        ui.once('error', fail);
    });
    clearTimeout(timer);
    assert.equal(uiCode, 0, 'native Minecraft UI test');
    proof.checks.push(
        'Native roster add/remove/scroll, model effort and personality editing, signed live skin texture, chat/filter/usage/rule/access screens at two window sizes',
    );
    await waitFor(
        async () => (await api('/v1/state')).agents.every(a => a.state === 'paused'),
        'paused workers after UI edits',
    );
    const before = await api('/v1/state');
    await delay(3500);
    await command('kill', 'Scout');
    await delay(4000);
    const afterDeath = await api('/v1/state');
    assert.equal(afterDeath.agents.find(a => a.name === 'Scout').state, 'paused');
    assert.match(await command('data', 'get', 'entity', 'Scout', 'Health'), /20/);
    await settings('normal', true);
    assert.deepEqual(
        (await api('/v1/state')).agents.map(a => a.startedAt),
        before.agents.map(a => a.startedAt),
    );
    await waitFor(async () => {
        const log = await readFile(join(root, 'companions/Scout/telemetry.jsonl'), 'utf8');
        return log
            .split('\n')
            .filter(Boolean)
            .map(l => JSON.parse(l))
            .some(e => e.event === 'owner_control' && e.configuration?.permanentDeath === true);
    }, 'live rule IPC in actual worker');
    await delay(3500);
    await command('kill', 'Scout');
    await waitFor(
        async () => (await api('/v1/state')).agents.find(a => a.name === 'Scout').state === 'dead',
        'permanent companion death',
    );
    const oldScout = (await api('/v1/state')).agents.find(a => a.name === 'Scout');
    await assert.rejects(
        api('/v1/control', { player: 'RuleTester', agents: ['Scout'], action: 'resume' }),
        /permanent death/,
    );
    await api('/v1/agents/Scout', { player: 'RuleTester' }, 'DELETE');
    const config = Object.fromEntries(
        ['name', 'model', 'thinking', 'objective', 'personality', 'skin'].map(k => [k, oldScout[k]]),
    );
    await api('/v1/agents', { player: 'RuleTester', agent: config });
    await assert.rejects(
        api('/v1/control', { player: 'RuleTester', agents: ['Scout'], action: 'resume' }),
        /permanent death/,
    );
    proof.checks.push(
        'Actual paused worker stays paused after respawn; live permanent-death policy does not restart sessions; retired identity cannot bypass death by remove/re-add',
    );
    await settings('peaceful', false);
    let human = await connect('HumanTester');
    await die(human, 'survival');
    await settings('normal', true);
    await die(human, 'spectator');
    quit(human);
    human = await connect('HumanTester');
    assert.equal(human.game.gameMode, 'spectator');
    quit(human);
    await settings('normal', false);
    await command('difficulty', 'easy');
    await waitFor(async () => (await api('/v1/state')).server.difficulty === 'easy', 'console difficulty observation');
    await waitFor(
        async () => /^difficulty=easy$/m.test(await readFile(join(root, 'server/server.properties'), 'utf8')),
        'native difficulty persistence',
    );
    await docker(['restart', 'minecraft-companions-server-1']);
    await waitFor(async () => {
        try {
            return JSON.parse(await command('companionsrules', 'status')).difficulty === 'easy';
        } catch {
            return false;
        }
    }, 'native difficulty after restart');
    await waitFor(
        async () => (await api('/v1/state')).agents.filter(a => a.name !== 'Scout').every(a => a.state === 'paused'),
        'bounded paused reconnect after server restart',
    );
    human = await connect('HumanTester');
    assert.equal(human.game.gameMode, 'spectator');
    quit(human);
    proof.checks.push(
        'Human Survival/Spectator deaths, persisted death identity, native console difficulty and server restart persistence, paused worker reconnection',
    );
    await api('/v1/access', { player: 'RuleTester', access: { lanEnabled: true } }, 'PATCH');
    await waitFor(async () => (await api('/v1/state')).access.activeLan, 'LAN interfaces');
    const access = (await api('/v1/state')).access;
    const endpoint = access.lanUrls[0],
        host = new URL(endpoint).hostname;
    const unauth = await fetch(endpoint + '/v1/state');
    assert.equal(unauth.status, 401);
    const paired = await api(
        '/v1/pair',
        { player: 'WifiTester', code: access.pairingCode, kind: 'web' },
        'POST',
        '',
        endpoint,
    );
    assert.equal((await api('/v1/state', null, 'GET', paired.token, endpoint)).agents.length, 3);
    await assert.rejects(
        api('/v1/agents', { player: 'SomeoneElse', agent: { name: 'Forgery' } }, 'POST', paired.token, endpoint),
        /paired with/,
    );
    await api('/v1/agents', { player: 'WifiTester', agent: { name: 'WifiMate' } }, 'POST', paired.token, endpoint);
    await api('/v1/agents/WifiMate', { player: 'WifiTester' }, 'DELETE', paired.token, endpoint);
    const wifi = await connect('WifiTester', host);
    quit(wifi);
    await api('/v1/access', { player: 'RuleTester', access: { rotateCode: true, lanEnabled: false } }, 'PATCH');
    await waitFor(async () => !(await api('/v1/state')).access.activeLan, 'LAN shutdown');
    await assert.rejects(fetch(endpoint + '/health', { signal: AbortSignal.timeout(2000) }));
    assert.equal(
        (await fetch('http://127.0.0.1:8767/v1/state', { headers: { authorization: 'Bearer ' + paired.token } }))
            .status,
        401,
    );
    proof.checks.push(
        'Mac private-IP web and Minecraft forwarding, authenticated shared controls, paired player binding, revocation and LAN socket shutdown; no physical second device tested',
    );
    const final = await api('/v1/state');
    for (const key of ['total', 'reported', 'pending', 'unknown']) assert.equal(final.usage[key], 0);
    proof.usage = final.usage;
    proof.passed = true;
    if (process.env.COMPANION_VERIFY_HOLD === '1') {
        await writeFile(
            'output/companions/test-stack.json',
            JSON.stringify({ root, endpoint: 'http://127.0.0.1:8767' }),
        );
        console.log('VERIFICATION_READY_FOR_BROWSER');
        await new Promise(done => {
            process.once('SIGTERM', done);
            process.once('SIGINT', done);
        });
    }
} finally {
    for (const bot of bots) bot.quit();
    ui?.kill('SIGTERM');
    gateway?.kill('SIGTERM');
    await docker([...compose, 'down']);
    await mkdir('output/companions', { recursive: true });
    await writeFile('output/companions/verification.json', JSON.stringify(proof, null, 2) + '\n');
    const screenshots = resolve('mods/companion-mailbox/build/run/clientGameTest/screenshots');
    for (const name of await readdir(screenshots))
        if (
            /^\d+_companions-.*\.png$/.test(name) &&
            (await stat(join(screenshots, name))).mtimeMs >= Date.parse(proof.testedAt)
        )
            await copyFile(join(screenshots, name), join('output/companions', name.replace(/^\d+_/, '')));
}
console.log(JSON.stringify(proof, null, 2));
