import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import mineflayer from 'mineflayer';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { summarizeTeamEvaluation, auditWorld, assertEvaluationHealthy } from './lib/team-evaluation.js';
const { values: options } = parseArgs({
    options: {
        out: { type: 'string' },
        image: { type: 'string' },
        world: { type: 'string' },
        scenario: { type: 'string' },
        history: { type: 'string' },
        profiles: { type: 'string', default: '.agent-state/companions/controller/settings.json' },
        reference: { type: 'string' },
        auth: { type: 'string', default: '.agent-state/auth.json' },
        seconds: { type: 'string' },
        port: { type: 'string', default: '25569' },
        'controller-port': { type: 'string', default: '8779' },
        help: { type: 'boolean' },
    },
});
if (options.help) {
    console.log(
        'node scripts/evaluate-team.js --out DIR --image IMAGE --world SERVER_COPY --scenario SCENARIO.json [--profiles settings.json] [--history FROZEN_COMPANIONS] [--auth .agent-state/auth.json] [--reference prior/protocol.json] [--seconds 1200] [--port 25569 --controller-port 8779]',
    );
    process.exit(0);
}
if (!options.out || !options.image || !options.world || !options.scenario)
    throw Error('out, image, world and scenario are required');
const reference = options.reference ? JSON.parse(readFileSync(options.reference)) : null;
const scenario = JSON.parse(readFileSync(options.scenario));
const root = resolve(options.out),
    image = options.image,
    source = resolve(options.world);
const outputFromSource = relative(source, root);
if (outputFromSource !== '..' && !outputFromSource.startsWith(`..${sep}`) && !isAbsolute(outputFromSource))
    throw Error('Evaluation output must be outside the frozen server fixture');
if (reference?.scenario && !isDeepStrictEqual(reference.scenario, scenario))
    throw Error('Audit scenario differs from reference');
const project = 'minecraft-eval-' + createHash('sha256').update(root).digest('hex').slice(0, 12);
const mcPort = Number(options.port),
    controllerPort = Number(options['controller-port']);
const durationSeconds = Number(options.seconds ?? reference?.durationSeconds ?? 1200);
if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 10 ||
    durationSeconds > 7200 ||
    ![mcPort, controllerPort].every(n => Number.isInteger(n) && n > 1024 && n < 65536) ||
    mcPort === controllerPort
)
    throw Error('Invalid duration or ports');
if (reference && durationSeconds !== reference.durationSeconds) throw Error('Duration differs from reference');
const env = {
    ...process.env,
    DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock`,
    LOCAL_STATE_DIR: root,
    LOCAL_UID: String(process.getuid()),
    LOCAL_GID: String(process.getgid()),
    DOCKER_SOCKET_GID: '991',
    LOCAL_MC_PORT: String(mcPort),
    COMPANION_PORT: String(controllerPort),
};
delete env.OPENAI_API_KEY;
const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const docker = args => {
    const p = spawnSync('docker', args, { env, encoding: 'utf8', maxBuffer: 8e6 });
    if (p.status !== 0) throw Error(p.stderr || p.stdout);
    return p.stdout.trim();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hashTree = dir => {
    const h = createHash('sha256');
    const walk = d => {
        for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else {
                h.update(p.slice(dir.length));
                h.update(readFileSync(p));
            }
        }
    };
    walk(dir);
    return h.digest('hex');
};
import { readdirSync } from 'node:fs';
if (existsSync(root) && readdirSync(root).length) throw Error('Evaluation output directory must be empty');
mkdirSync(root, { recursive: true, mode: 0o700 });
cpSync(source, join(root, 'server'), { recursive: true });
mkdirSync(join(root, 'server/plugins'), { recursive: true });
cpSync('mods/companion-mailbox/build/libs/companion-rules.jar', join(root, 'server/plugins/companion-rules.jar'));
writeFileSync(join(root, 'server/bukkit.yml'), 'settings:\n  connection-throttle: 0\n');
// OAuth refresh tokens rotate. All workers use the same lockable credential store,
// mounted as a directory so atomic file replacement remains visible.
const authPath = resolve(options.auth);
if (!existsSync(authPath)) throw Error('Subscription credential file is missing; run npm run login');
const profiles = reference?.profiles ?? JSON.parse(readFileSync(options.profiles)).agents;
const historySource = options.history ?? reference?.historySource;
if (historySource) {
    for (const agent of profiles)
        for (const name of ['pi-sessions', 'workspace']) {
            const from = resolve(historySource, agent.name, name);
            if (existsSync(from)) cpSync(from, join(root, 'companions', agent.name, name), { recursive: true });
        }
    const shared = resolve(historySource, 'shared');
    if (existsSync(shared)) cpSync(shared, join(root, 'companions/shared'), { recursive: true });
}
const startingHistoryHash = historySource ? hashTree(join(root, 'companions')) : null;
if (reference && startingHistoryHash !== (reference.startingHistoryHash ?? null))
    throw Error('Starting history differs from reference');
const needsClaude = profiles.some(profile => profile.model.startsWith('claude-code/'));
if (needsClaude) cpSync(resolve('.agent-state/claude-models.json'), join(root, 'claude-models.json'));
mkdirSync(join(root, 'companions/controller'), { recursive: true, mode: 0o700 });
save('companions/controller/settings.json', { agents: profiles });
const objective = reference?.objective ?? scenario.objective;
if (typeof objective !== 'string' || !objective.trim() || objective.length > 2000)
    throw Error('Use a scenario objective of at most 2000 characters');
const override = {
    services: {
        controller: {
            image,
            environment: {
                MC_PORT: String(mcPort),
                COMPANION_PORT: String(controllerPort),
                COMPANION_SERVER_CONTAINER: project + '-server-1',
                COMPANION_AUTH_FILE: authPath,
            },
            volumes: [`${dirname(authPath)}:${dirname(authPath)}`],
        },
        server: { environment: { MAX_PLAYERS: '10' } },
    },
};
save('compose.json', override);
const dc = (...args) =>
    docker([
        'compose',
        '--profile',
        'companions',
        '-p',
        project,
        '-f',
        resolve('compose.local.yaml'),
        '-f',
        join(root, 'compose.json'),
        ...args,
    ]);
const protocol = {
    createdAt: new Date().toISOString(),
    historySource: historySource ? resolve(historySource) : null,
    startingHistoryHash,
    durationSeconds,
    scenario,
    image,
    imageId: docker(['image', 'inspect', '-f', '{{.Id}}', image]),
    startingWorldHash: hashTree(join(root, 'server/world')),
    profiles,
    objective,
    project,
    mcPort,
    controllerPort,
    comparison:
        'Isolated scenario; no inherited memories or tasks. Models, effort and instruction copied from reference when supplied. Only a single pilot per revision; not statistical qualification.',
};
save('protocol.json', protocol);
if (reference && protocol.startingWorldHash !== reference.startingWorldHash)
    throw Error('Starting world differs from reference');
let modelHost,
    connection,
    finished = false,
    stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
        stopping = true;
    });
const call = async (path, body) => {
    connection ??= JSON.parse(readFileSync(join(root, 'companions/controller/connection.json')));
    const r = await fetch(connection.endpoint + path, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const v = await r.json();
    if (!r.ok) throw Error(v.error);
    return v;
};
async function audit() {
    const bot = mineflayer.createBot({
        host: '127.0.0.1',
        port: mcPort,
        username: 'WorldAudit',
        version: '1.21.6',
        auth: 'offline',
    });
    bot.on('error', () => {});
    await new Promise((ok, no) => {
        bot.once('spawn', ok);
        bot.once('error', no);
        setTimeout(() => no(Error('Audit spawn timeout')), 30000).unref();
    });
    const command = async text => docker(['exec', project + '-server-1', 'rcon-cli', text]);
    try {
        await command('gamemode creative WorldAudit');
        save(
            'world-audit.json',
            await auditWorld({ bot, scenario, command, profiles, serverDir: join(root, 'server') }),
        );
    } finally {
        bot.quit();
        await sleep(500);
    }
}

try {
    console.log('Starting isolated evaluation server:', project);
    dc('up', '-d', '--no-build', '--wait', 'server');
    if (needsClaude) {
        modelHost = spawn(process.execPath, ['scripts/claude-host.js', root], { stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [modelHost.stdout, modelHost.stderr])
            stream.on('data', data => appendFileSync(join(root, 'model-host.log'), data));
    }
    dc('up', '-d', '--no-build', 'controller');
    const deadline = Date.now() + 180000;
    let state;
    while (!stopping && Date.now() < deadline) {
        try {
            state = await call('/v1/state');
            if (state.agents.length === profiles.length && state.agents.every(a => a.state === 'paused')) break;
        } catch {}
        await sleep(2000);
    }
    if (stopping) throw Error('Evaluation cancelled before measurement');
    if (!state || state.agents.length !== profiles.length || !state.agents.every(a => a.state === 'paused'))
        throw Error('Agents did not become ready and paused');
    save('initial-state.json', state);
    if (profiles.length)
        await call('/v1/messages', {
            player: 'Evaluator',
            recipients: profiles.map(a => a.name),
            text: objective,
            submissionId: randomUUID(),
        });
    const startedAt = Date.now();
    save('timing.json', {
        startedAt: new Date(startedAt).toISOString(),
        expectedEnd: new Date(startedAt + durationSeconds * 1000).toISOString(),
    });
    if (profiles.length)
        await call('/v1/control', { player: 'Evaluator', agents: profiles.map(a => a.name), action: 'resume' });
    console.log('Measurement started:', new Date(startedAt).toISOString());
    while (!stopping && Date.now() - startedAt < durationSeconds * 1000) {
        state = await call('/v1/state');
        assertEvaluationHealthy(
            state,
            Date.now() - startedAt,
            profiles.map(a => a.name),
        );
        appendFileSync(join(root, 'samples.jsonl'), JSON.stringify(state) + '\n', { mode: 0o600 });
        await sleep(Math.min(5000, Math.max(1, durationSeconds * 1000 - (Date.now() - startedAt))));
    }
    if (profiles.length)
        await call('/v1/control', { player: 'Evaluator', agents: profiles.map(a => a.name), action: 'stop' });
    save('final-state.json', await call('/v1/state'));
    save('messages.json', await call('/v1/messages?limit=200'));
    try {
        save('work.json', await call('/v1/work'));
    } catch {}
    save('timing.json', {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedSeconds: (Date.now() - startedAt) / 1000,
    });
    await audit();
    finished = !stopping;
    console.log('Evaluation complete:', root);
} catch (error) {
    save('failure.json', { at: new Date().toISOString(), message: error.message });
    throw error;
} finally {
    modelHost?.kill('SIGTERM');
    try {
        writeFileSync(join(root, 'containers.log'), dc('logs', '--no-color'));
    } catch {}
    try {
        dc('down');
    } catch {}
    save('result.json', { finished, at: new Date().toISOString() });
    if (finished) await summarizeTeamEvaluation(root);
}
