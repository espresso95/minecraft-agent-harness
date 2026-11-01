import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanionController } from '../../src/controller/server.js';
import { ManagedAgents } from '../../src/controller/managed-agents.js';
import { defaultProfile } from '../../src/controller/profiles.js';
import { modelCatalog } from '../../src/controller/model-catalog.js';
import { validateServerRules } from '../../src/controller/server-rules.js';

export const profiles = ['Scout', 'Builder', 'Watcher'].map(name => ({ ...defaultProfile, name }));
export const catalog = modelCatalog([
    {
        provider: 'openai',
        api: 'openai-responses',
        id: 'gpt-6-luna',
        name: 'Luna',
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: 'max' },
    },
]);
export const initialRules = {
    available: true,
    difficulties: ['peaceful', 'easy', 'normal', 'hard'],
    difficulty: 'peaceful',
    permanentDeath: false,
    nativeHardcore: false,
    deadPlayers: [],
    onlinePlayers: ['Player'],
};
export async function fixture(t, options = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'companions-'));
    const launches = [],
        commands = [],
        notifications = [];
    let rules = structuredClone(initialRules);
    const controller = await createCompanionController({
        stateDir: dir,
        authFile: join(dir, 'auth.json'),
        port: 0,
        autoStart: false,
        catalog,
        agents: profiles,
        serverRules: {
            snapshot: () => rules,
            async apply(value) {
                rules = { ...rules, ...validateServerRules(value, rules) };
                return rules;
            },
        },
        managerFactory: ({ configs, ledger, session, onMailboxCommit }) =>
            new ManagedAgents({
                agents: configs,
                ledger,
                session,
                stateDir: dir,
                authFile: join(dir, 'auth.json'),
                host: '127.0.0.1',
                port: 25565,
                worldRules: () => rules,
                onMailboxCommit,
                spawnWorker(command, args) {
                    const child = new EventEmitter();
                    child.stdout = new PassThrough();
                    child.stderr = new PassThrough();
                    launches.push({ child, config: JSON.parse(readFileSync(args.at(-1), 'utf8')) });
                    child.kill = () => {
                        queueMicrotask(() => child.emit('exit', 0));
                        return true;
                    };
                    child.send = (message, callback) => {
                        if (message.type === 'mailbox_available') {
                            notifications.push(launches.find(l => l.child === child).config.name);
                            callback?.();
                            return;
                        }
                        commands.push([launches.find(l => l.child === child).config.name, message]);
                        queueMicrotask(() => {
                            child.emit('message', { type: 'companion_ack', id: message.id, ok: true });
                            if (message.action === 'stop') child.emit('exit', 0);
                        });
                        callback?.();
                    };
                    queueMicrotask(() =>
                        child.emit('message', { type: 'companion_ready', paused: launches.at(-1).config.startPaused }),
                    );
                    return child;
                },
            }),
        ...options,
    });
    t.after(async () => {
        await controller.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const call = async (path, body, token = controller.token, headers = {}, method = body ? 'POST' : 'GET') => {
        const response = await fetch(controller.endpoint + path, {
            method,
            headers: { authorization: 'Bearer ' + token, ...headers },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, value: await response.json() };
    };
    return { c: controller, dir, call, commands, notifications, launches };
}
