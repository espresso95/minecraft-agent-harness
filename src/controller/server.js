import { HostModels } from './host-models.js';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MailboxStore, MailboxObserver } from '../comms/mailbox-store.js';
import { UsageLedger } from './usage-ledger.js';
import { ManagedAgents } from './managed-agents.js';
import { CompanionRoster } from './roster.js';
import { LocalAccess } from './access.js';
import { workView } from './work-view.js';

export async function createCompanionController({
    stateDir,
    authFile,
    port = 8766,
    host = '127.0.0.1',
    mcHost = '127.0.0.1',
    mcPort = 25565,
    autoStart = true,
    startPaused = true,
    managerFactory,
    catalog,
    serverRules,
    appearances,
    agents,
} = {}) {
    if (!['127.0.0.1', '::1'].includes(host) || !['localhost', '127.0.0.1', '::1'].includes(mcHost))
        throw new Error('Companions requires local-only addresses');
    if (!catalog?.validate || !catalog?.snapshot)
        throw new Error('Connect a model catalog before starting the controller');
    stateDir = resolve(stateDir);
    const root = join(stateDir, 'controller');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(stateDir, 'shared'), { recursive: true, mode: 0o700 });
    const tokenFile = join(root, 'token');
    const token = existsSync(tokenFile)
        ? readFileSync(tokenFile, 'utf8').trim()
        : randomBytes(32).toString('base64url');
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) throw new Error('Invalid saved controller token');
    if (!existsSync(tokenFile)) writeFileSync(tokenFile, token, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    const session = randomUUID();
    let ledger, observer, manager, server, poll;
    const hostModels = new HostModels();
    try {
        ledger = new UsageLedger(join(root, 'usage.sqlite'));
        const mailboxFile = join(stateDir, 'shared/mailbox.sqlite');
        new MailboxStore(mailboxFile, 'Controller').close();
        observer = new MailboxObserver(mailboxFile);
        let workRevision = observer.workRevision();
        const routeMailbox = () => {
            if (!manager) return;
            try {
                const revision = observer.workRevision();
                const recipients = observer.unreadRecipients();
                if (revision !== workRevision) recipients.push(...manager.entries.keys());
                workRevision = revision;
                manager.notifyMailbox([...new Set(recipients)]);
            } catch (error) {
                console.error('Mailbox notification delayed:', error.message);
            }
        };
        const roster = new CompanionRoster({
            file: join(root, 'settings.json'),
            catalog,
            agents,
            appearances,
            onlinePlayers: () => serverRules?.snapshot().onlinePlayers ?? [],
            createManager: configs =>
                managerFactory?.({
                    configs,
                    ledger,
                    session,
                    onMailboxCommit: routeMailbox,
                    onWorkerStop: recoverWork,
                }) ??
                new ManagedAgents({
                    agents: configs,
                    hostModels,
                    stateDir,
                    authFile,
                    host: mcHost,
                    port: mcPort,
                    ledger,
                    session,
                    worldRules: () => serverRules?.snapshot(),
                    modelProblem: id => catalog.snapshot().models.find(model => model.id === id)?.compaction?.reason,
                    onMailboxCommit: routeMailbox,
                    onWorkerStop: recoverWork,
                }),
        });
        manager = roster.manager;
        function recoverWork(name) {
            const store = new MailboxStore(mailboxFile, name, { onCommit: routeMailbox });
            try {
                store.recoverTasks(
                    'The worker stopped. Verify the saved checkpoint and world before releasing or resuming this work.',
                );
            } finally {
                store.close();
            }
        }
        await roster.syncSkins();
        const access = new LocalAccess({
            file: join(root, 'access.json'),
            runtimeFile: join(root, 'access-runtime.json'),
            secret: token,
        });
        let changes = Promise.resolve(),
            closing = false;
        const mutate = fn => {
            const result = changes.then(() => {
                if (closing) throw new Error('Controller is stopping');
                return fn();
            });
            changes = result.catch(() => {});
            return result;
        };
        const json = (res, status, value) => {
            res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
            });
            res.end(JSON.stringify(value));
        };
        server = createServer(async (req, res) => {
            try {
                const url = new URL(req.url, 'http://127.0.0.1');
                if (req.method === 'GET' && url.pathname === '/favicon.ico') {
                    res.writeHead(204);
                    return res.end();
                }
                if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: 1 });
                const assets = {
                    '/': ['index.html', 'text/html'],
                    '/app.js': ['app.js', 'text/javascript'],
                    '/style.css': ['style.css', 'text/css'],
                };
                if (req.method === 'GET' && assets[url.pathname]) {
                    const [file, type] = assets[url.pathname];
                    res.writeHead(200, {
                        'content-type': type + '; charset=utf-8',
                        'cache-control': 'no-store',
                        'x-content-type-options': 'nosniff',
                        'content-security-policy':
                            "default-src 'self'; img-src 'self' https://textures.minecraft.net; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
                    });
                    return res.end(readFileSync(new URL('../web/' + file, import.meta.url)));
                }
                if (req.headers.origin) {
                    const origin = new URL(req.headers.origin);
                    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host)
                        return json(res, 403, { error: 'Origin refused' });
                }
                const principal = access.authenticate(req.headers.authorization);
                if (!principal && !(req.method === 'POST' && url.pathname === '/v1/pair'))
                    return json(res, 401, { error: 'Pair this device with the local controller' });
                if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, catalog.snapshot());
                if (req.method === 'GET' && url.pathname === '/v1/state') {
                    const tasks = observer.tasks();
                    const snapshot = roster.snapshot().map(agent => ({
                        ...agent,
                        work: workView(tasks, agent.name, agent.runtime?.waitReason, observer.resources()),
                    }));
                    return json(res, 200, {
                        session,
                        modelCatalogVersion: catalog.snapshot().version,
                        access: access.snapshot(),
                        capturedAt: new Date().toISOString(),
                        server: { host: mcHost, port: mcPort, ...(serverRules?.snapshot() ?? { available: false }) },
                        agents: snapshot,
                        work: workView(tasks, null, null, observer.resources()),
                        participants: observer.participants(),
                        usage: ledger.totals(null, session),
                        lifetimeUsage: ledger.totals(null),
                        usageScope:
                            'Reported tokens. Cached input is part of input; reasoning is part of output. Pending or interrupted requests are not zero-cost. Subscription deductions are not exposed here.',
                    });
                }
                if (req.method === 'GET' && url.pathname === '/v1/tasks')
                    return json(res, 200, { tasks: observer.tasks() });
                if (req.method === 'GET' && url.pathname === '/v1/messages') {
                    const params = url.searchParams;
                    const filter = params.get('agentsOnly');
                    if (filter !== null && !['true', 'false'].includes(filter)) throw new Error('Invalid agent filter');
                    const cursor = params.get('after');
                    return json(res, 200, {
                        session,
                        ...observer.messages({
                            participants: params.get('participants')?.split(',') ?? [],
                            sender: params.get('sender') || undefined,
                            recipient: params.get('recipient') || undefined,
                            before: Number(params.get('before') ?? 0),
                            after:
                                cursor === null
                                    ? undefined
                                    : cursor === 'latest'
                                      ? observer.latestId()
                                      : Number(cursor),
                            agents: roster.names(),
                            agentsOnly: filter === 'true',
                            limit: Number(params.get('limit') ?? 100),
                        }),
                    });
                }
                if (!['POST', 'PATCH', 'DELETE'].includes(req.method))
                    return json(res, 404, { error: 'Unknown endpoint' });
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 32768) {
                        json(res, 413, { error: 'Request is too large' });
                        req.destroy();
                        return;
                    }
                    chunks.push(chunk);
                }
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                roster.human(body.player);
                if (url.pathname === '/v1/pair' && req.method === 'POST') {
                    if (
                        body.kind === 'minecraft' &&
                        !serverRules?.snapshot().onlinePlayers?.some(n => n.toLowerCase() === body.player.toLowerCase())
                    )
                        throw new Error('Join this Minecraft server before pairing');
                    return json(res, 200, { token: access.pair(body.code, body.player), minecraftPort: mcPort });
                }
                if (!principal.host && body.player !== principal.player)
                    throw new Error('Use the player name this device paired with');
                if (url.pathname === '/v1/access' && req.method === 'PATCH')
                    return json(res, 200, await mutate(() => access.update(body.access)));
                if (req.method === 'PATCH' && url.pathname === '/v1/server') {
                    if (!serverRules) throw new Error('Server controls are not connected');
                    return json(
                        res,
                        200,
                        await mutate(async () => {
                            const value = await serverRules.apply(body.settings);
                            await manager.configure();
                            return { server: value };
                        }),
                    );
                }
                if (req.method === 'POST' && url.pathname === '/v1/agents') {
                    return json(
                        res,
                        201,
                        await mutate(async () => ({ agent: await roster.add(body.agent, body.player) })),
                    );
                }
                const agentRoute = /^\/v1\/agents\/([A-Za-z0-9_]{1,16})$/.exec(url.pathname);
                if (agentRoute && req.method === 'PATCH')
                    return json(
                        res,
                        200,
                        await mutate(async () => ({ agent: await roster.update(agentRoute[1], body.agent) })),
                    );
                if (agentRoute && req.method === 'DELETE')
                    return json(
                        res,
                        200,
                        await mutate(async () => {
                            await roster.remove(agentRoute[1]);
                            return { ok: true };
                        }),
                    );
                if (req.method === 'POST' && url.pathname === '/v1/messages') {
                    if (!Array.isArray(body.recipients)) throw new Error('Choose recipients');
                    const recipients = body.recipients.map(n => roster.exact(n));
                    const store = new MailboxStore(mailboxFile, body.player, { onCommit: routeMailbox });
                    try {
                        return json(res, 200, {
                            ids: store.sendMany(recipients, body.text, body.submissionId, { urgent: true }),
                        });
                    } finally {
                        store.close();
                    }
                }
                if (req.method === 'POST' && url.pathname === '/v1/control') {
                    if (!['pause', 'resume', 'stop'].includes(body.action)) throw new Error('Unknown control');
                    if (!Array.isArray(body.agents) || !body.agents.length || body.agents.length > 16)
                        throw new Error('Choose agents');
                    const names = [...new Set(body.agents.map(n => roster.exact(n)))];
                    await mutate(() => Promise.all(names.map(name => manager.command(name, body.action))));
                    return json(res, 200, { ok: true });
                }
                return json(res, 404, { error: 'Unknown endpoint' });
            } catch (error) {
                if (!res.headersSent) json(res, 400, { error: String(error.message).slice(0, 300) });
            }
        });
        hostModels.attach(server, access, catalog);
        server.requestTimeout = 20000;
        await new Promise((resolveListen, reject) => {
            server.once('error', reject);
            server.listen(port, host, resolveListen);
        });
        const endpoint = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
        writeFileSync(
            join(root, 'connection.json'),
            JSON.stringify({ endpoint, token, minecraftPort: mcPort, serverKey: 'loopback:' + mcPort }),
            { mode: 0o600 },
        );
        poll = setInterval(() => {
            try {
                manager.snapshot();
                routeMailbox();
            } catch (error) {
                console.error('Usage collection:', error.message);
            }
        }, 1000);
        for (const name of new Set(
            observer
                .tasks()
                .map(t => t.owner)
                .filter(Boolean),
        ))
            recoverWork(name);
        if (autoStart) for (const name of roster.names()) manager.start(name, { paused: startPaused });
        return {
            server,
            manager,
            roster,
            access,
            ledger,
            observer,
            token,
            endpoint,
            session,
            async close() {
                if (closing) return;
                closing = true;
                clearInterval(poll);
                await changes;
                hostModels.close();
                await manager.close();
                await new Promise(resolveClose => server.close(resolveClose));
                observer.close();
                ledger.close();
            },
        };
    } catch (error) {
        clearInterval(poll);
        hostModels.close();
        await manager?.close();
        if (server?.listening) await new Promise(done => server.close(done));
        observer?.close();
        ledger?.close();
        throw error;
    }
}
