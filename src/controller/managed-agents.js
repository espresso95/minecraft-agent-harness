import { EXIT, reconnectDelay, MAX_RECONNECTS } from '../startup.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    appendFileSync,
    existsSync,
    openSync,
    closeSync,
    readSync,
    statSync,
    readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentStatus } from './agent-status.js';

export class ManagedAgents {
    constructor({
        agents,
        stateDir,
        authFile,
        host,
        port,
        ledger,
        session,
        spawnWorker = spawn,
        worldRules = () => null,
        onMailboxCommit = () => {},
        onWorkerStop = () => {},
    }) {
        Object.assign(this, {
            stateDir,
            authFile,
            host,
            port,
            ledger,
            session,
            spawnWorker,
            worldRules,
            onMailboxCommit,
            onWorkerStop,
        });
        this.entries = new Map();
        this.closing = false;
        mkdirSync(join(stateDir, 'controller'), { recursive: true, mode: 0o700 });
        for (const config of agents) this.add(config);
    }

    add(config) {
        if (this.entries.has(config.name)) throw new Error('Agent already exists');
        const dir = join(this.stateDir, 'controller', config.name);
        if (existsSync(dir)) {
            for (const file of readdirSync(dir).filter(name => /^run-[a-f0-9-]+\.json$/.test(name))) {
                const previous = JSON.parse(readFileSync(join(dir, file), 'utf8'));
                const entry = {
                    config,
                    run: previous.run,
                    session: previous.session,
                    cursor: { offset: 0, pending: Buffer.alloc(0), file: join(dir, `usage-${previous.run}.jsonl`) },
                };
                while (existsSync(entry.cursor.file) && entry.cursor.offset < statSync(entry.cursor.file).size)
                    this.ingest(entry);
                this.ledger.finishRun(previous.run);
            }
        }
        this.entries.set(config.name, {
            config,
            state: 'stopped',
            child: null,
            pending: new Map(),
            queue: Promise.resolve(),
        });
    }

    start(name, { paused = false, retrying = false } = {}) {
        const entry = this.entries.get(name);
        if (!entry) throw new Error('Unknown agent');
        if (entry.child || this.closing) return;
        if (this.isDead(name)) {
            entry.state = 'dead';
            entry.error = 'This companion died with permanent death enabled';
            return false;
        }
        const rules = this.worldRules();
        if (rules && !rules.available) throw new Error('Server rules unavailable; companion has not started');
        clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
        entry.stopping = false;
        entry.desiredPaused = paused;
        if (!retrying) entry.retries = 0;
        const run = randomUUID();
        const dir = join(this.stateDir, 'controller', name);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const configFile = join(dir, 'agent.json');
        const usageFile = join(dir, `usage-${run}.jsonl`);
        writeFileSync(join(dir, `run-${run}.json`), JSON.stringify({ agent: name, run, session: this.session }), {
            mode: 0o600,
        });
        writeFileSync(
            configFile,
            JSON.stringify(
                {
                    ...entry.config,
                    host: this.host,
                    port: this.port,
                    stateDir: this.stateDir,
                    auth: 'offline',
                    gameMode: 'survival',
                    team: true,
                    playerChat: true,
                    peers: [...this.entries.keys()].filter(n => n !== name),
                    modelAuthFile: this.authFile,
                    subscriptionOnly: true,
                    sandbox: 'docker',
                    dockerMemory: '512m',
                    dockerCpus: '1',
                    reconnect: false,
                    startPaused: paused,
                    respawn: !rules?.permanentDeath,
                },
                null,
                2,
            ),
            { mode: 0o600 },
        );
        const env = Object.fromEntries(
            Object.entries(process.env).filter(
                ([key]) =>
                    !key.startsWith('AGENT_') &&
                    !['MC_HOST', 'MC_PORT', 'MC_AUTH', 'MODEL_BASE_URL', 'OPENAI_API_KEY', 'E2B_API_KEY'].includes(key),
            ),
        );
        env.MINECRAFT_AGENT_WORKER = '1';
        env.MINECRAFT_AGENT_ATTEMPT = String(entry.retries);
        env.AGENT_USAGE_FILE = usageFile;
        env.NODE_OPTIONS = `--disable-warning=ExperimentalWarning --import=${fileURLToPath(new URL('../../scripts/usage-observer.js', import.meta.url))}`;
        entry.run = run;
        entry.cursor = { offset: 0, pending: Buffer.alloc(0), file: usageFile };
        entry.logFile = join(dir, 'runtime.log');
        entry.state = 'starting';
        entry.ready = false;
        entry.startedAt = new Date().toISOString();
        entry.error = null;
        const child = this.spawnWorker(
            process.execPath,
            [fileURLToPath(new URL('../../bin/minecraft-agent.js', import.meta.url)), 'run', '--config', configFile],
            { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
        );
        entry.child = child;
        let workerError;
        entry.exited = new Promise(resolveExit => {
            let ended = false;
            const finish = (code, error) => {
                if (ended) return;
                ended = true;
                this.ingest(entry);
                this.ledger.finishRun(run);
                for (const pending of entry.pending.values()) pending.reject(new Error('Agent disconnected'));
                entry.pending.clear();
                entry.child = null;
                let recoveryError;
                try {
                    this.onWorkerStop(name);
                } catch (error) {
                    recoveryError = error.message;
                }
                entry.state = this.isDead(name) ? 'dead' : code === 0 || entry.stopping ? 'stopped' : 'failed';
                entry.exitCode = code;
                entry.error =
                    error ??
                    recoveryError ??
                    (code ? (workerError ?? `Agent exited with code ${code}; see runtime.log`) : null);
                if (Date.now() - Date.parse(entry.startedAt) > 120000) entry.retries = 0;
                if (
                    code === EXIT.reconnect &&
                    !entry.stopping &&
                    !this.closing &&
                    !this.isDead(name) &&
                    entry.retries < MAX_RECONNECTS
                ) {
                    entry.retries++;
                    entry.state = 'reconnecting';
                    entry.error = 'Connection interrupted; reconnecting automatically';
                    entry.retryTimer = setTimeout(
                        () => this.start(name, { paused: entry.desiredPaused, retrying: true }),
                        reconnectDelay(entry.retries),
                    );
                }
                resolveExit(code);
            };
            child.once('error', error => finish(1, error.message));
            child.once('exit', code => finish(code ?? 1));
        });
        for (const stream of [child.stdout, child.stderr])
            stream?.on('data', chunk => appendFileSync(entry.logFile, chunk, { mode: 0o600 }));
        child.on('message', message => {
            if (message?.type === 'companion_stopping' && entry.child === child && typeof message.message === 'string')
                workerError = message.message.slice(0, 500);
            if (message?.type === 'mailbox_committed' && entry.child === child) this.onMailboxCommit();
            if (message?.type === 'companion_ready' && entry.child === child && !entry.stopping) {
                entry.ready = true;
                entry.state = message.paused ? 'paused' : 'running';
                void this.command(name, 'configure').catch(error => {
                    entry.error = error.message;
                });
            }
            if (message?.type === 'companion_ack') {
                const pending = entry.pending.get(message.id);
                if (!pending) return;
                entry.pending.delete(message.id);
                if (message.ok) pending.resolve();
                else pending.reject(new Error(message.error ?? 'Control failed'));
            }
        });
        return true;
    }

    isDead(name) {
        return (
            existsSync(join(this.stateDir, name, 'retired.json')) ||
            this.worldRules()?.deadPlayers?.some(p => p.name.toLowerCase() === name.toLowerCase())
        );
    }

    async configure() {
        await Promise.all(
            [...this.entries]
                .filter(([, e]) => e.child && e.ready && !e.stopping)
                .map(async ([name, entry]) => {
                    try {
                        await this.command(name, 'configure');
                    } catch (error) {
                        entry.error = error.message;
                    }
                }),
        );
    }

    ingest(entry) {
        const cursor = entry.cursor;
        if (!cursor || !existsSync(cursor.file)) return;
        const size = statSync(cursor.file).size;
        if (size <= cursor.offset) return;
        const fd = openSync(cursor.file, 'r');
        try {
            const chunk = Buffer.alloc(Math.min(size - cursor.offset, 4e6));
            const bytes = readSync(fd, chunk, 0, chunk.length, cursor.offset);
            cursor.offset += bytes;
            const buffer = Buffer.concat([cursor.pending, chunk.subarray(0, bytes)]);
            const last = buffer.lastIndexOf(10);
            if (last < 0) {
                cursor.pending = buffer;
                return;
            }
            cursor.pending = buffer.subarray(last + 1);
            for (const line of buffer.subarray(0, last).toString('utf8').split('\n').filter(Boolean)) {
                const event = JSON.parse(line);
                this.ledger.ingest(event, {
                    agent: entry.config.name,
                    run: entry.run,
                    session: entry.session ?? this.session,
                });
            }
        } finally {
            closeSync(fd);
        }
    }

    async command(name, action) {
        const entry = this.entries.get(name);
        if (!entry) throw new Error('Unknown agent');
        const execute = async () => {
            if (!['pause', 'resume', 'stop', 'configure'].includes(action)) throw new Error('Unknown control action');
            if (action === 'stop') {
                entry.stopping = true;
                clearTimeout(entry.retryTimer);
                entry.retryTimer = null;
                if (!entry.child) {
                    entry.state = 'stopped';
                    entry.error = null;
                    return;
                }
            }
            if (action === 'resume' && !entry.child) {
                if (!this.start(name)) throw new Error(entry.error ?? 'Companion could not start');
                return;
            }
            if (action === 'stop' && !entry.child) return;
            if (!entry.child || !entry.ready) {
                if (action !== 'stop') throw new Error('Agent is not ready yet');
                entry.child.kill('SIGTERM');
            } else if (action === 'stop') {
                entry.child.send({ type: 'companion_control', id: randomUUID(), action }, () => {});
            } else {
                const id = randomUUID();
                await new Promise((resolveAck, rejectAck) => {
                    const timer = setTimeout(() => {
                        entry.pending.delete(id);
                        rejectAck(new Error('Agent control timed out'));
                    }, 12000);
                    entry.pending.set(id, {
                        resolve: () => {
                            clearTimeout(timer);
                            resolveAck();
                        },
                        reject: error => {
                            clearTimeout(timer);
                            rejectAck(error);
                        },
                    });
                    const configuration =
                        action === 'configure'
                            ? {
                                  peers: [...this.entries.keys()].filter(n => n !== name),
                                  permanentDeath: Boolean(this.worldRules()?.permanentDeath),
                              }
                            : undefined;
                    entry.child.send({ type: 'companion_control', id, action, configuration }, error => {
                        if (error) entry.pending.get(id)?.reject(error);
                    });
                });
                if (action === 'pause' || action === 'resume') {
                    entry.desiredPaused = action === 'pause';
                    entry.state = entry.desiredPaused ? 'paused' : 'running';
                }
            }
            if (action === 'stop') {
                const child = entry.child;
                const deadline = setTimeout(() => child?.kill('SIGKILL'), 12000);
                await entry.exited;
                clearTimeout(deadline);
            }
        };
        const task = entry.queue.then(execute);
        entry.queue = task.catch(() => {});
        return task;
    }

    snapshot() {
        return [...this.entries.values()].map(entry => {
            if (!entry.child && this.isDead(entry.config.name)) {
                entry.state = 'dead';
                entry.error = 'This companion died with permanent death enabled';
            }
            this.ingest(entry);
            let runtime = null,
                activity = [];
            try {
                runtime = JSON.parse(
                    readFileSync(join(this.stateDir, entry.config.name, 'runtime-status.json'), 'utf8'),
                );
            } catch {}
            try {
                activity = tailFile(join(this.stateDir, entry.config.name, 'telemetry.jsonl'))
                    .trim()
                    .split('\n')
                    .slice(-100)
                    .map(l => JSON.parse(l))
                    .filter(r => r.event === 'tool')
                    .slice(-6)
                    .map(({ time, tool, success, failureCode, timeMs }) => ({
                        time,
                        tool,
                        success,
                        failureCode,
                        timeMs,
                    }));
            } catch {}
            const state = entry.state === 'running' && runtime?.standby ? 'standby' : entry.state;
            runtime = entry.child && entry.state !== 'starting' ? runtime : null;
            const usage = this.ledger.totals(entry.config.name, this.session);
            return {
                ...entry.config,
                state,
                status: agentStatus(state, runtime, usage),
                startedAt: entry.startedAt ?? null,
                error: entry.error ?? null,
                controls:
                    entry.state === 'dead'
                        ? []
                        : entry.child
                          ? entry.ready
                              ? [entry.desiredPaused ? 'resume' : 'pause', 'stop']
                              : ['stop']
                          : entry.retryTimer
                            ? ['stop']
                            : ['resume'],
                runtime,
                activity,
                usage,
                lifetimeUsage: this.ledger.totals(entry.config.name),
            };
        });
    }

    notifyMailbox(recipients) {
        for (const name of recipients) {
            const entry = [...this.entries].find(
                ([registered]) => registered.toLowerCase() === name.toLowerCase(),
            )?.[1];
            if (entry?.child && entry.ready && !entry.stopping)
                entry.child.send({ type: 'mailbox_available' }, () => {});
        }
    }

    async close() {
        this.closing = true;
        await Promise.allSettled([...this.entries.keys()].map(name => this.command(name, 'stop')));
    }
}

function tailFile(file) {
    const size = statSync(file).size;
    const start = Math.max(0, size - 65536);
    const fd = openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        const text = buffer.toString('utf8');
        return text.slice(start ? text.indexOf('\n') + 1 : 0, text.lastIndexOf('\n') + 1);
    } finally {
        closeSync(fd);
    }
}
