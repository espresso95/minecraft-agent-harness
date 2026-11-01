import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { discoverClaude, completeClaude } from './lib/claude-code.js';

const state = resolve(process.argv[2] ?? '.agent-state');
const file = join(state, 'claude-models.json');
const runtime = await ModelRuntime.create({
    authPath: join(state, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
});
const models = (await discoverClaude()).map(entry => {
    const metadata = runtime.getModel('anthropic', entry.resolvedModel);
    if (!metadata) throw new Error('Update Pi model metadata before using ' + entry.resolvedModel);
    return { ...entry, contextWindow: metadata.contextWindow, maxTokens: metadata.maxTokens };
});
await writeFile(file, JSON.stringify(models), { mode: 0o600 });
if (process.argv.includes('--discover')) process.exit(0);
const pending = new Map();
let stopped = false,
    socket,
    timer;
async function connect() {
    try {
        const { endpoint, token } = JSON.parse(
            await readFile(join(state, 'companions/controller/connection.json'), 'utf8'),
        );
        socket = new WebSocket(endpoint.replace(/^http/, 'ws') + '/internal/models', {
            headers: { authorization: `Bearer ${token}` },
            maxPayload: 32 * 1024 * 1024,
        });
        socket.on('open', () => socket.send(JSON.stringify({ type: 'catalog', models })));
        socket.on('message', async data => {
            let message;
            try {
                message = JSON.parse(data);
            } catch {
                return;
            }
            if (message.type === 'cancel') return pending.get(message.id)?.abort();
            if (message.type !== 'request') return;
            const controller = new AbortController();
            const current = socket;
            pending.set(message.id, controller);
            try {
                const result =
                    message.method === 'catalog'
                        ? models
                        : message.method === 'complete'
                          ? await completeClaude(message.params, controller.signal)
                          : (() => {
                                throw Error('Unknown model method');
                            })();
                if (current.readyState === 1) current.send(JSON.stringify({ id: message.id, result }));
            } catch (error) {
                if (current.readyState === 1) current.send(JSON.stringify({ id: message.id, error: error.message }));
            } finally {
                pending.delete(message.id);
            }
        });
        socket.on('error', () => socket.close());
        socket.on('close', retry);
    } catch {
        retry();
    }
}
function retry() {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    if (!stopped) timer = setTimeout(connect, 2000);
}
function stop() {
    stopped = true;
    clearTimeout(timer);
    socket?.terminate();
    for (const controller of pending.values()) controller.abort();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await connect();
