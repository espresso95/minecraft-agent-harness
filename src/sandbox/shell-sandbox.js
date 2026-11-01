import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');

export async function installRelayFiles(workdir, tools, toolsFile) {
    const opt = path.join(workdir, '.harness');
    await fs.mkdir(path.join(workdir, 'bin'), { recursive: true });
    await fs.mkdir(opt, { recursive: true });
    for (const name of ['relay.cjs', 'agent_tools.py'])
        await fs.copyFile(path.join(ASSETS, name), path.join(opt, name));
    await fs.writeFile(path.join(opt, 'tools.json'), JSON.stringify(tools));
    const cli = (await fs.readFile(path.join(ASSETS, 'tool'), 'utf8')).replaceAll(
        '/opt/harness/tools.json',
        toolsFile ?? path.join(opt, 'tools.json'),
    );
    await fs.writeFile(path.join(workdir, 'bin', 'tool'), cli, { mode: 0o755 });
    return opt;
}
export const cap = (text, max) => (Buffer.byteLength(text) > max ? `${text.slice(0, max)}\n…[truncated]` : text);

export function startPoller({ relayUrl, token, invoke, log, onDead }) {
    const controller = new AbortController();
    void (async () => {
        let backoff = 500,
            streak = 0;
        while (!controller.signal.aborted) {
            try {
                const r = await fetch(`${relayUrl}/next`, {
                    headers: { 'x-token': token },
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
                });
                if (r.status === 204) {
                    backoff = 500;
                    streak = 0;
                    continue;
                }
                if (!r.ok) throw new Error(`relay ${r.status}`);
                backoff = 500;
                streak = 0;
                const job = await r.json();
                let out;
                try {
                    out = { id: job.id, ok: true, result: await invoke(job.name, job.args ?? {}) };
                } catch (e) {
                    out = { id: job.id, ok: false, error: String(e?.message ?? e).slice(0, 4000) };
                }
                await fetch(`${relayUrl}/result`, {
                    method: 'POST',
                    headers: { 'x-token': token, 'content-type': 'application/json' },
                    body: JSON.stringify(out),
                    signal: AbortSignal.timeout(10000),
                });
            } catch (e) {
                if (controller.signal.aborted) break;
                log?.(`relay poll error: ${String(e?.message ?? e)}`);
                if (++streak >= 3 && onDead) {
                    streak = 0;
                    try {
                        await onDead();
                        if (controller.signal.aborted) break;
                        log?.('relay restarted');
                        backoff = 500;
                        continue;
                    } catch (e2) {
                        log?.(`relay restart failed: ${String(e2?.message ?? e2)}`);
                    }
                }
                await new Promise(r => setTimeout(r, backoff));
                backoff = Math.min(backoff * 2, 10000);
            }
        }
    })();
    return () => controller.abort();
}

export async function waitHealthy(relayUrl, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try {
            const r = await fetch(`${relayUrl}/health`, { signal: AbortSignal.timeout(2000) });
            if (r.ok) return;
        } catch {}
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('relay did not become healthy');
}

export function createLocalBackend({ workdir, sharedDir }) {
    let relay, token, relayUrl, stopPoll, home;
    return {
        kind: 'local',
        async start({ invoke, tools, log }) {
            token = crypto.randomBytes(16).toString('hex');
            home = workdir;
            if (sharedDir) await fs.mkdir(path.join(sharedDir, 'tools'), { recursive: true });
            const opt = await installRelayFiles(home, tools);
            const port = 20000 + Math.floor(Math.random() * 20000);
            relay = spawn(process.execPath, [path.join(opt, 'relay.cjs'), String(port), token], { stdio: 'ignore' });
            relayUrl = `http://127.0.0.1:${port}`;
            await waitHealthy(relayUrl);
            stopPoll = startPoller({ relayUrl, token, invoke, log });
        },
        env() {
            return {
                HOME: home,
                PYTHONPATH: path.join(home, '.harness'),
                PATH: `${path.join(home, 'bin')}:${sharedDir ? path.join(sharedDir, 'tools') + ':' : ''}${process.env.PATH}`,
                TOOL_API_TOKEN: token,
                TOOL_RELAY_URL: relayUrl,
                SHARED_TOOLS: sharedDir ? path.join(sharedDir, 'tools') : '',
            };
        },
        run(cmd, { timeoutMs, signal, outputBytes }) {
            return new Promise(resolve => {
                const env = this.env();
                const child = spawn('bash', ['-lc', `export PATH=${JSON.stringify(env.PATH)}; ${cmd}`], {
                    cwd: home,
                    env,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stdout = '',
                    stderr = '',
                    timedOut = false;
                child.stdout.on('data', d => {
                    stdout += d;
                });
                child.stderr.on('data', d => {
                    stderr += d;
                });
                const timer = setTimeout(() => {
                    timedOut = true;
                    child.kill('SIGKILL');
                }, timeoutMs);
                const onAbort = () => child.kill('SIGKILL');
                signal?.addEventListener('abort', onAbort, { once: true });
                child.on('close', code => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    resolve({
                        exitCode: timedOut ? 124 : (code ?? -1),
                        timedOut,
                        stdout: cap(stdout, outputBytes),
                        stderr: cap(stderr, outputBytes),
                    });
                });
            });
        },
        async writeFile(rel, content) {
            const p = path.join(home, rel);
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.writeFile(p, content);
        },
        close() {
            stopPoll?.();
            relay?.kill('SIGKILL');
            return Promise.resolve();
        },
    };
}

async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        return null;
    }
}

async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export function createE2bBackend({
    apiKey,
    template,
    agentName,
    sandboxTimeoutMs = 3600000,
    sharedDir,
    privateDir,
    loadSandbox,
    relayScheme = 'https',
    idlePauseMs = 180000,
    capWaitMs = 600000,
    cohort,
    statePath,
    persist = true,
}) {
    let sbx, token, relayUrl, stopPoll, relayHandle, Sandbox, keepalive, restarting, pollArgs;
    let paused = false,
        busy = 0,
        idleTimer = null,
        pausing = null,
        waking = null;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const atCap = e => /concurrent|rate limit|429|too many/i.test(String(e?.message ?? e));
    const withCapRetry = async (fn, log) => {
        const until = Date.now() + capWaitMs;
        for (let wait = 5000; ; wait = Math.min(wait * 2, 30000)) {
            try {
                return await fn();
            } catch (e) {
                if (!atCap(e) || Date.now() + wait > until) throw e;
                log?.(`e2b at concurrency cap; retrying in ${wait / 1000}s`);
                await sleep(wait);
            }
        }
    };
    const refresh = async () => {
        if (paused || pausing) return;
        try {
            await sbx.setTimeout(sandboxTimeoutMs);
        } catch {}
    };
    const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = null;
        if (!idlePauseMs || busy > 0 || paused || !sbx) return;
        idleTimer = setTimeout(() => {
            pauseNow().catch(() => {});
        }, idlePauseMs);
        idleTimer.unref?.();
    };
    const pauseNow = () =>
        (pausing ??= (async () => {
            if (busy > 0 || paused || !sbx) return;
            stopPoll?.();
            stopPoll = null;
            try {
                await (sbx.pause ? sbx.pause() : sbx.betaPause());
                paused = true;
                pollArgs?.log?.(`e2b sandbox ${sbx.sandboxId} paused after idle`);
            } catch (e) {
                pollArgs?.log?.(`e2b pause failed: ${String(e?.message ?? e).slice(0, 160)}`);
                if (pollArgs) stopPoll = startPoller({ relayUrl, token, ...pollArgs, onDead: restartRelay });
            }
        })().finally(() => {
            pausing = null;
        }));
    const wake = async () => {
        if (pausing) await pausing;
        if (!paused) return;
        await (waking ??= (async () => {
            const id = sbx.sandboxId;
            sbx = await withCapRetry(() => Sandbox.connect(id, { apiKey, timeoutMs: sandboxTimeoutMs }), pollArgs?.log);
            paused = false;
            try {
                await sbx.commands.run("pkill -f '/opt/harness/relay.cjs' || true", { timeoutMs: 15000 });
            } catch {}
            await startRelay();
            stopPoll = startPoller({ relayUrl, token, ...pollArgs, onDead: restartRelay });
            pollArgs?.log?.(`e2b sandbox ${id} resumed`);
        })().finally(() => {
            waking = null;
        }));
    };
    const awake = async fn => {
        busy++;
        clearTimeout(idleTimer);
        try {
            await wake();
            return await fn();
        } finally {
            busy--;
            armIdle();
        }
    };
    const startRelay = async () => {
        relayHandle = await sbx.commands.run(`node /opt/harness/relay.cjs 7777 ${token}`, {
            background: true,
            timeoutMs: 0,
        });
        await waitHealthy(relayUrl, 30000);
    };
    const restartRelay = () =>
        (restarting ??= (async () => {
            try {
                await relayHandle?.kill();
            } catch {}
            await startRelay();
        })().finally(() => {
            restarting = null;
        }));
    return {
        kind: 'e2b',
        get sandboxId() {
            return sbx?.sandboxId;
        },
        async start({ invoke, tools, log }) {
            Sandbox = loadSandbox ? await loadSandbox() : (await import('e2b')).Sandbox;
            token = crypto.randomBytes(16).toString('hex');
            pollArgs = { invoke, log };
            const saved = persist && statePath ? await readJson(statePath) : null;
            if (saved?.sandboxId)
                try {
                    sbx = await withCapRetry(
                        () => Sandbox.connect(saved.sandboxId, { apiKey, timeoutMs: sandboxTimeoutMs }),
                        log,
                    );
                    log?.(`e2b sandbox ${saved.sandboxId} resumed from the last run`);
                    try {
                        await sbx.commands.run("pkill -f '/opt/harness/relay.cjs' || true", { timeoutMs: 15000 });
                    } catch {}
                } catch (e) {
                    sbx = null;
                    log?.(
                        `e2b sandbox ${saved.sandboxId} could not be resumed (${String(e?.message ?? e).slice(0, 160)}); creating a new one`,
                    );
                }
            if (!sbx) {
                const opts = {
                    apiKey,
                    timeoutMs: sandboxTimeoutMs,
                    metadata: { agent: agentName, cohort: cohort || '' },
                    ...(persist ? { lifecycle: { onTimeout: 'pause' } } : {}),
                };
                sbx = await withCapRetry(() => (template ? Sandbox.create(template, opts) : Sandbox.create(opts)), log);
            }
            if (persist && statePath)
                await writeJson(statePath, {
                    sandboxId: sbx.sandboxId,
                    agent: agentName,
                    updatedAt: new Date().toISOString(),
                });
            await sbx.commands.run(
                'sudo mkdir -p /opt/harness /shared/tools && sudo chmod -R a+rwx /opt/harness /shared && mkdir -p ~/bin',
                { timeoutMs: 30000 },
            );
            await sbx.files.write('/opt/harness/relay.cjs', await fs.readFile(path.join(ASSETS, 'relay.cjs'), 'utf8'));
            await sbx.files.write(
                '/opt/harness/agent_tools.py',
                await fs.readFile(path.join(ASSETS, 'agent_tools.py'), 'utf8'),
            );
            await sbx.files.write('/opt/harness/tools.json', JSON.stringify(tools));
            await sbx.files.write('/opt/harness/tool', await fs.readFile(path.join(ASSETS, 'tool'), 'utf8'));
            await sbx.commands.run('chmod +x /opt/harness/tool && ln -sf /opt/harness/tool ~/bin/tool', {
                timeoutMs: 30000,
            });
            relayUrl = `${relayScheme}://${sbx.getHost(7777)}`;
            await startRelay();
            stopPoll = startPoller({ relayUrl, token, invoke, log, onDead: restartRelay });
            keepalive = setInterval(refresh, Math.max(60000, Math.floor(sandboxTimeoutMs / 3)));
            keepalive.unref?.();
            await this.syncShared();
            await this.pushPrivate();
            armIdle();
        },
        get paused() {
            return paused;
        },
        env() {
            return {
                PATH: '/home/user/bin:/shared/tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                TOOL_API_TOKEN: token,
                TOOL_RELAY_URL: 'http://127.0.0.1:7777',
                PYTHONPATH: '/opt/harness',
                SHARED_TOOLS: '/shared/tools',
            };
        },
        async syncShared() {
            if (!sharedDir) return;
            const dir = path.join(sharedDir, 'tools');
            let names = [];
            try {
                names = await fs.readdir(dir);
            } catch {
                return;
            }
            for (const n of names) {
                if (/^[a-z][a-z0-9_-]{0,39}$/.test(n)) {
                    await sbx.files.write(`/shared/tools/${n}`, await fs.readFile(path.join(dir, n), 'utf8'));
                }
            }
            if (names.length)
                await sbx.commands.run('chmod +x /shared/tools/* 2>/dev/null || true', { timeoutMs: 15000 });
        },
        async pushPrivate() {
            if (!privateDir) return;
            let names = [];
            try {
                names = await fs.readdir(privateDir);
            } catch {
                return;
            }
            for (const n of names) {
                if (/^[a-z][a-z0-9_-]{0,39}$/.test(n))
                    await sbx.files.write(`/home/user/bin/${n}`, await fs.readFile(path.join(privateDir, n), 'utf8'));
            }
            if (names.length)
                await sbx.commands.run('chmod +x /home/user/bin/* 2>/dev/null || true', { timeoutMs: 15000 });
        },
        async pullDir(remote, localDir) {
            await fs.mkdir(localDir, { recursive: true });
            let entries = [];
            try {
                entries = await sbx.files.list(remote);
            } catch {
                return;
            }
            for (const e of entries) {
                if (String(e.type).toLowerCase() === 'file' && /^[a-z][a-z0-9_-]{0,39}$/.test(e.name)) {
                    await fs.writeFile(path.join(localDir, e.name), await sbx.files.read(e.path), { mode: 0o755 });
                }
            }
        },
        async pullShared() {
            if (!sharedDir) return;
            const dir = path.join(sharedDir, 'tools');
            await fs.mkdir(dir, { recursive: true });
            let entries = [];
            try {
                entries = await sbx.files.list('/shared/tools');
            } catch {
                return;
            }
            for (const e of entries) {
                if (String(e.type).toLowerCase() === 'file' && /^[a-z][a-z0-9_-]{0,39}$/.test(e.name)) {
                    await fs.writeFile(path.join(dir, e.name), await sbx.files.read(e.path), { mode: 0o755 });
                }
            }
        },
        run(cmd, opts) {
            return awake(() => this.runAwake(cmd, opts));
        },
        async runAwake(cmd, { timeoutMs, signal, outputBytes }) {
            await refresh();
            try {
                const r = await sbx.commands.run(`export PATH="${this.env().PATH}"; ${cmd}`, {
                    envs: this.env(),
                    timeoutMs,
                    signal,
                    cwd: '/home/user',
                });
                await this.pullShared().catch(() => {});
                if (privateDir) await this.pullDir('/home/user/bin', privateDir).catch(() => {});
                return {
                    exitCode: r.exitCode,
                    timedOut: false,
                    stdout: cap(r.stdout, outputBytes),
                    stderr: cap(r.stderr, outputBytes),
                };
            } catch (e) {
                if (e?.name === 'CommandExitError' || typeof e?.exitCode === 'number')
                    return {
                        exitCode: e.exitCode,
                        timedOut: false,
                        stdout: cap(e.stdout ?? '', outputBytes),
                        stderr: cap(e.stderr ?? '', outputBytes),
                    };
                if (e?.name === 'TimeoutError' || /timeout/i.test(String(e?.message)))
                    return {
                        exitCode: 124,
                        timedOut: true,
                        stdout: '',
                        stderr: `command timed out after ${timeoutMs}ms`,
                    };
                throw e;
            }
        },
        writeFile(rel, content) {
            return awake(() => sbx.files.write(path.posix.join('/home/user', rel), content));
        },
        async close() {
            clearTimeout(idleTimer);
            idleTimer = null;
            stopPoll?.();
            clearInterval(keepalive);
            if (pausing) await pausing.catch(() => {});
            try {
                await relayHandle?.kill();
            } catch {}
            if (persist && !paused) {
                try {
                    await (sbx?.pause ? sbx.pause() : sbx?.betaPause());
                    paused = true;
                    return;
                } catch {}
            }
            if (persist) return;
            try {
                await sbx?.kill();
            } catch {}
        },
    };
}
