import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

// One owner-authenticated outbound host connection. Paired LAN clients cannot provide models.
export class HostModels {
    constructor() {
        this.pending = new Map();
        this.events = new EventEmitter();
    }
    attach(server, access, catalog) {
        this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
        server.on('upgrade', (req, socket, head) => {
            if (req.url !== '/internal/models' || !access.authenticate(req.headers.authorization)?.host) {
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, ws => {
                this.socket?.close();
                this.socket = ws;
                ws.on('message', data => {
                    let message;
                    try {
                        message = JSON.parse(data);
                    } catch {
                        return ws.close();
                    }
                    if (message.type === 'catalog' && Array.isArray(message.models))
                        catalog.setClaude?.(message.models);
                    const pending = this.pending.get(message.id);
                    if (!pending || pending.socket !== ws) return;
                    pending.finish(message.error ? new Error(message.error) : null, message.result);
                });
                ws.on('close', () => {
                    if (this.socket === ws) this.socket = null;
                    for (const pending of this.pending.values())
                        if (pending.socket === ws) pending.finish(new Error('Claude Code host disconnected'));
                });
                ws.on('error', () => ws.close());
                this.events.emit('connected');
            });
        });
    }
    async request(method, params, signal) {
        if (method === 'catalog' && this.socket?.readyState !== 1) {
            const timeout = AbortSignal.timeout(15000);
            try {
                await once(this.events, 'connected', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            } catch {
                throw new Error('Claude Code host is offline. Start npm run companions on the Mac.');
            }
        }
        return new Promise((resolve, reject) => {
            const socket = this.socket;
            if (socket?.readyState !== 1)
                return reject(new Error('Claude Code host is offline. Start npm run companions on the Mac.'));
            const id = randomUUID();
            const abort = () => {
                socket.send(JSON.stringify({ type: 'cancel', id }));
                finish(signal.reason ?? new Error('Aborted'));
            };
            const timer = setTimeout(() => {
                socket.send(JSON.stringify({ type: 'cancel', id }));
                finish(new Error('Claude Code request timed out'));
            }, 300000);
            const finish = (error, result) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                this.pending.delete(id);
                if (error) reject(error);
                else resolve(result);
            };
            this.pending.set(id, { socket, finish });
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) return abort();
            socket.send(JSON.stringify({ type: 'request', id, method, params }));
        });
    }
    close() {
        this.socket?.terminate();
        for (const pending of this.pending.values()) pending.finish(new Error('Controller stopping'));
        this.wss?.close();
    }
}
