import { createServer as httpServer, request } from 'node:http';
import { createServer as tcpServer, connect } from 'node:net';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? '.agent-state');
const directory = join(root, 'companions/controller');
const webPort = Number(process.env.COMPANION_WEB_PORT ?? 8767);
const listeners = new Map();
let stopped = false,
    reconciling = false,
    previous = '';
const privateIp = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
function proxy(host, endpoint) {
    return (req, res) => {
        let authority;
        try {
            authority = new URL('http://' + req.headers.host).hostname;
        } catch {
            res.writeHead(400).end();
            return;
        }
        if (
            ![host, ...(host === '127.0.0.1' ? ['localhost'] : []), hostname().toLowerCase()].includes(
                authority.toLowerCase(),
            )
        ) {
            res.writeHead(403).end();
            return;
        }
        if (!req.url.startsWith('/') || req.url.startsWith('//')) {
            res.writeHead(400).end();
            return;
        }
        const target = new URL(endpoint);
        const upstream = request(
            {
                hostname: target.hostname,
                port: target.port,
                path: req.url,
                method: req.method,
                headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress },
            },
            response => {
                res.writeHead(response.statusCode, response.headers);
                response.pipe(res);
            },
        );
        upstream.setTimeout(65000, () => upstream.destroy(new Error('Controller timeout')));
        upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Local controller is unavailable' }));
        });
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
    };
}
async function listen(server, port, host) {
    await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, host, ok);
    });
    const sockets = new Set();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    return { server, sockets };
}
function close(listener) {
    listener.server.close();
    for (const socket of listener.sockets) socket.destroy();
}
async function reconcile() {
    if (stopped || reconciling) return;
    reconciling = true;
    try {
        const connection = JSON.parse(readFileSync(join(directory, 'connection.json'), 'utf8'));
        const access = JSON.parse(readFileSync(join(directory, 'access.json'), 'utf8'));
        const hosts = ['127.0.0.1'];
        if (access.lanEnabled)
            for (const values of Object.values(networkInterfaces()))
                for (const item of values ?? [])
                    if (item.family === 'IPv4' && !item.internal && privateIp(item.address)) hosts.push(item.address);
        const desired = new Set();
        for (const host of new Set(hosts)) {
            const key = 'web:' + host;
            desired.add(key);
            if (!listeners.has(key))
                listeners.set(key, await listen(httpServer(proxy(host, connection.endpoint)), webPort, host));
            if (host !== '127.0.0.1') {
                const gameKey = 'game:' + host;
                desired.add(gameKey);
                if (!listeners.has(gameKey))
                    listeners.set(
                        gameKey,
                        await listen(
                            tcpServer(socket => {
                                const upstream = connect(connection.minecraftPort, '127.0.0.1');
                                socket.on('error', () => upstream.destroy());
                                upstream.on('error', () => socket.destroy());
                                socket.on('close', () => upstream.destroy());
                                upstream.on('close', () => socket.destroy());
                                socket.pipe(upstream).pipe(socket);
                            }),
                            connection.minecraftPort,
                            host,
                        ),
                    );
            }
        }
        for (const [key, value] of listeners)
            if (!desired.has(key)) {
                close(value);
                listeners.delete(key);
            }
        const lan = hosts.filter(h => h !== '127.0.0.1');
        const runtime = {
            webUrl: `http://127.0.0.1:${webPort}`,
            lanUrls: lan.map(h => `http://${h}:${webPort}`),
            gameAddresses: lan.map(h => `${h}:${connection.minecraftPort}`),
            activeLan: access.lanEnabled && lan.length > 0,
        };
        const value = JSON.stringify(runtime);
        if (value + access.code !== previous) {
            writeFileSync(join(directory, 'access-runtime.json.tmp'), value, { mode: 0o600 });
            renameSync(join(directory, 'access-runtime.json.tmp'), join(directory, 'access-runtime.json'));
            previous = value + access.code;
            console.log(`Web UI: ${runtime.webUrl}. Pairing code: ${access.code}`);
            for (const url of runtime.lanUrls) console.log('LAN controls: ' + url);
            for (const address of runtime.gameAddresses) console.log('LAN Minecraft: ' + address);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Local access:', error.message);
    } finally {
        reconciling = false;
    }
}
const timer = setInterval(() => void reconcile(), 2000);
void reconcile();
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
        stopped = true;
        clearInterval(timer);
        for (const value of listeners.values()) close(value);
    });
