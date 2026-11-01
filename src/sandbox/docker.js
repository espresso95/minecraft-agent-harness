import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cap, installRelayFiles, startPoller, waitHealthy } from './shell-sandbox.js';

export const DOCKER_IMAGE = 'node:22-bookworm';
const HOME = '/home/agent';
const SHARED = '/opt/shared';
const RELAY_PORT = 7777;

export function dockerAvailable(bin = 'docker') {
    try {
        return (
            spawnSync(bin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000, stdio: 'ignore' }).status === 0
        );
    } catch {
        return false;
    }
}

export function containerName(agentName, workdir) {
    const slug =
        String(agentName)
            .toLowerCase()
            .replace(/[^a-z0-9_.-]/g, '-')
            .slice(0, 32) || 'agent';
    const hash = crypto.createHash('sha256').update(path.resolve(workdir)).digest('hex').slice(0, 8);
    return `minecraft-agent-${slug}-${hash}`;
}

export function dockerExec(args, { timeoutMs = 120000, signal } = {}) {
    return new Promise(resolve => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '',
            stderr = '',
            killed = false;
        child.stdout.on('data', d => {
            stdout += d;
        });
        child.stderr.on('data', d => {
            stderr += d;
        });
        const kill = () => {
            killed = true;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(kill, timeoutMs);
        signal?.addEventListener('abort', kill, { once: true });
        child.on('error', e => {
            stderr += String(e?.message ?? e);
        });
        child.on('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', kill);
            resolve({ code: code ?? -1, stdout, stderr, killed });
        });
    });
}

export function createDockerBackend({
    agentName,
    workdir,
    sharedDir,
    image = DOCKER_IMAGE,
    memory = '2g',
    cpus = '2',
    exec = dockerExec,
    user = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined,
}) {
    const name = containerName(agentName, workdir);
    let token, relayUrl, stopPoll;
    const docker = async (args, opts) => {
        const r = await exec(args, opts);
        if (r.code !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
        return r.stdout.trim();
    };
    const state = async () => {
        const r = await exec(['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 30000 });
        if (r.code !== 0) return 'missing';
        return r.stdout.trim() === 'true' ? 'running' : 'stopped';
    };
    const ensureContainer = async log => {
        let s = await state();
        if (s !== 'missing') {
            const mounts = JSON.parse(await docker(['inspect', '-f', '{{json .Mounts}}', name]));
            const source = destination => mounts.find(m => m.Destination === destination)?.Source;
            if (
                source(HOME) !== path.resolve(workdir) ||
                source(SHARED) !== (sharedDir ? path.resolve(sharedDir) : undefined)
            ) {
                log?.(`recreating ${name} to apply workspace mounts; persistent files are retained`);
                await docker(['rm', '-f', name]);
                s = 'missing';
            }
        }
        if (s === 'running') return;
        if (s === 'stopped') {
            await docker(['start', name], { timeoutMs: 60000 });
            return;
        }
        log?.(`creating container ${name} from ${image}`);
        await docker(
            [
                'run',
                '-d',
                '--name',
                name,
                '--hostname',
                name.slice(0, 63),
                '--label',
                'minecraft-agent-harness=1',
                '--label',
                `minecraft-agent-harness.agent=${agentName}`,
                '--init',
                '--memory',
                String(memory),
                '--cpus',
                String(cpus),
                '--pids-limit',
                '1024',
                '-p',
                `127.0.0.1::${RELAY_PORT}`,
                '-v',
                `${path.resolve(workdir)}:${HOME}`,
                ...(sharedDir ? ['-v', `${path.resolve(sharedDir)}:${SHARED}`] : []),
                ...(user ? ['--user', user] : []),
                '-e',
                `HOME=${HOME}`,
                '-w',
                HOME,
                image,
                'sleep',
                'infinity',
            ],
            { timeoutMs: 600000 },
        );
    };
    const startRelay = async () => {
        await exec(['exec', name, 'pkill', '-f', 'harness/relay.cjs'], { timeoutMs: 15000 });
        await docker(['exec', '-d', name, 'node', `${HOME}/.harness/relay.cjs`, String(RELAY_PORT), token], {
            timeoutMs: 30000,
        });
        const mapped = await docker(['port', name, `${RELAY_PORT}/tcp`], { timeoutMs: 15000 });
        const hostPort = mapped.split('\n')[0].split(':').pop();
        relayUrl = `http://127.0.0.1:${hostPort}`;
        await waitHealthy(relayUrl);
    };
    return {
        kind: 'docker',
        name,
        async start({ invoke, tools, log }) {
            token = crypto.randomBytes(16).toString('hex');
            if (sharedDir) await fs.mkdir(path.join(sharedDir, 'tools'), { recursive: true });
            await installRelayFiles(workdir, tools, `${HOME}/.harness/tools.json`);
            await ensureContainer(log);
            await startRelay();
            stopPoll = startPoller({ relayUrl, token, invoke, log, onDead: startRelay });
        },
        env() {
            return {
                HOME,
                PYTHONPATH: `${HOME}/.harness`,
                PATH: `${HOME}/bin:${sharedDir ? `${SHARED}/tools:` : ''}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
                TOOL_API_TOKEN: token,
                TOOL_RELAY_URL: `http://127.0.0.1:${RELAY_PORT}`,
                SHARED_TOOLS: sharedDir ? `${SHARED}/tools` : '',
            };
        },
        async run(cmd, { timeoutMs, signal, outputBytes }) {
            const id = crypto.randomBytes(6).toString('hex');
            const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
            const envArgs = Object.entries({ ...this.env(), HARNESS_CMD: cmd }).flatMap(([k, v]) => [
                '-e',
                `${k}=${v}`,
            ]);
            const onAbort = () => {
                void exec(['exec', name, 'bash', '-c', `kill -TERM "$(cat /tmp/.run-${id}.pid)" 2>/dev/null`], {
                    timeoutMs: 15000,
                });
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            const r = await exec(
                [
                    'exec',
                    '-w',
                    HOME,
                    ...envArgs,
                    name,
                    'bash',
                    '-c',
                    `echo $$ > /tmp/.run-${id}.pid; exec timeout -k 2 ${seconds} bash -c "$HARNESS_CMD"`,
                ],
                { timeoutMs: timeoutMs + 15000, signal },
            );
            signal?.removeEventListener('abort', onAbort);
            void exec(['exec', name, 'rm', '-f', `/tmp/.run-${id}.pid`], { timeoutMs: 15000 });
            const timedOut = r.code === 124 || r.code === 137 || r.killed;
            return {
                exitCode: timedOut ? 124 : r.code,
                timedOut,
                stdout: cap(r.stdout, outputBytes),
                stderr: cap(r.stderr, outputBytes),
            };
        },
        async writeFile(rel, content) {
            const p = path.join(workdir, rel);
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.writeFile(p, content);
        },
        async close() {
            stopPoll?.();
            await exec(['stop', '-t', '3', name], { timeoutMs: 30000 });
        },
    };
}
