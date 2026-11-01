import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { decodeMessage, messageMetadata } from './messages.js';
import { WorkProjection, WORK_ROWS } from './work.js';
import { SkillStore } from './skills.js';

const NAME = /^[A-Za-z0-9_]{1,16}(?![\s\S])/;
const CONVERSATION = "COALESCE(json_extract(d.metadata, '$.type'),'message') = 'message'";
const DM_READ = `EXISTS (SELECT 1 FROM mailbox_dm_reads r
    WHERE r.owner = d.recipient AND r.peer = d.sender AND r.message_id = d.id)`;

function validName(value) {
    if (typeof value !== 'string' || !NAME.test(value)) {
        throw new TypeError('Minecraft name must contain 1-16 letters, digits, or underscores');
    }
    return value;
}

function validText(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
        throw new TypeError('Message text must be nonblank and at most 2000 characters');
    }
    return value;
}

function enableWAL(db) {
    const deadline = Date.now() + 10000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
        try {
            db.exec('PRAGMA journal_mode = WAL');
            return;
        } catch (error) {
            if (error.errcode !== 5 || Date.now() >= deadline) throw error;
            Atomics.wait(wait, 0, 0, 20);
        }
    }
}

function validPage(after, limit, minimumAfter = -1) {
    if (!Number.isSafeInteger(after) || after < minimumAfter) {
        throw new TypeError(
            `after must be ${minimumAfter === -2 ? '-2 (latest), ' : ''}-1 (unread) or a nonnegative safe integer`,
        );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('limit must be an integer between 1 and 50');
    }
}

export class MailboxStore {
    #db;
    #self;
    #mention;
    #onCommit;
    #work;

    constructor(file, self, { onCommit } = {}) {
        this.#self = validName(self);
        this.#onCommit = onCommit;
        if (typeof file !== 'string' || !file || file.includes('\0')) {
            throw new TypeError('A database file path is required');
        }
        this.#mention = new RegExp(`(^|[^A-Za-z0-9_@])@${self}(?![A-Za-z0-9_])`, 'i');
        this.#db = new DatabaseSync(file);
        try {
            this.#db.exec('PRAGMA busy_timeout = 10000');
            enableWAL(this.#db);
            this.#db.exec(`
                PRAGMA synchronous = FULL;
                PRAGMA foreign_keys = ON;
            `);
            this.#transaction(() =>
                this.#db.exec(`
                CREATE TABLE IF NOT EXISTS mailbox_dm (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender TEXT NOT NULL COLLATE NOCASE,
                    recipient TEXT NOT NULL COLLATE NOCASE,
                    text TEXT NOT NULL,
                    createdAt INTEGER NOT NULL,
                    metadata TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS mailbox_dm_recipient ON mailbox_dm(recipient, id);
                CREATE INDEX IF NOT EXISTS mailbox_dm_sender ON mailbox_dm(sender, id);
                CREATE TABLE IF NOT EXISTS mailbox_dm_reads (
                    owner TEXT NOT NULL COLLATE NOCASE,
                    peer TEXT NOT NULL COLLATE NOCASE,
                    message_id INTEGER NOT NULL REFERENCES mailbox_dm(id),
                    PRIMARY KEY (owner, peer, message_id)
                );
                CREATE TABLE IF NOT EXISTS mailbox_chat (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    observer TEXT NOT NULL COLLATE NOCASE,
                    sender TEXT NOT NULL COLLATE NOCASE,
                    text TEXT NOT NULL,
                    createdAt INTEGER NOT NULL,
                    mention INTEGER NOT NULL,
                    is_read INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS mailbox_chat_observer ON mailbox_chat(observer, id);
                CREATE TABLE IF NOT EXISTS mailbox_chat_goals (
                    message_id INTEGER PRIMARY KEY REFERENCES mailbox_chat(id),
                    goal_id INTEGER NOT NULL REFERENCES mailbox_dm(id)
                );
                CREATE TABLE IF NOT EXISTS mailbox_submissions (
                    id TEXT PRIMARY KEY,
                    sender TEXT NOT NULL COLLATE NOCASE,
                    digest TEXT NOT NULL,
                    message_ids TEXT NOT NULL
                );
            `),
            );
            this.#db.exec(`CREATE INDEX IF NOT EXISTS mailbox_board_events ON mailbox_dm(id) WHERE ${WORK_ROWS}`);
            this.#work = new WorkProjection(this.#db);
            this.skills = new SkillStore(this.#db, this.#self);
        } catch (error) {
            this.close();
            throw error;
        }
    }

    #transaction(fn) {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.#db.exec('COMMIT');
            return result;
        } catch (error) {
            this.#db.exec('ROLLBACK');
            this.#work?.invalidate();
            throw error;
        }
    }

    #insertDM(sender, to, text, options) {
        validName(to);
        validText(text);
        const metadata = messageMetadata(options);
        const result = this.#db
            .prepare(
                `
            INSERT INTO mailbox_dm (sender, recipient, text, createdAt, metadata) VALUES (?, ?, ?, ?, ?)
        `,
            )
            .run(sender, to, text, Date.now(), JSON.stringify(metadata));
        const id = Number(result.lastInsertRowid);
        return id;
    }

    #committed(value) {
        try {
            this.#onCommit?.();
        } catch {
            /* Durable messages remain available to repair scans. */
        }
        return value;
    }

    observeContainer({ dimension, chest, contents }) {
        if (
            typeof dimension !== 'string' ||
            !['x', 'y', 'z'].every(k => Number.isInteger(chest[k])) ||
            !contents ||
            Object.entries(contents).some(
                ([name, count]) => !/^[a-z0-9_]+$/.test(name) || !Number.isInteger(count) || count < 0,
            )
        )
            throw new TypeError('Invalid container observation');
        const resource = { key: `${dimension}:${chest.x},${chest.y},${chest.z}`, dimension, location: chest, contents };
        return this.#committed(
            this.#transaction(() => {
                this.#record('Container observed', { type: 'observation', resource });
                return resource;
            }),
        );
    }

    sendDM(to, text, options) {
        return this.#committed(this.#transaction(() => this.#insertDM(this.#self, to, text, options)));
    }

    sendMany(recipients, text, submissionId, options) {
        if (!Array.isArray(recipients) || !recipients.length || recipients.length > 16)
            throw new TypeError('Choose 1-16 recipients');
        recipients.forEach(validName);
        validText(text);
        if (typeof submissionId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(submissionId))
            throw new TypeError('A valid submission ID is required');
        const unique = [...new Set(recipients.map(n => n.toLowerCase()))];
        if (unique.length !== recipients.length) throw new TypeError('Duplicate recipient');
        const digest = createHash('sha256')
            .update(JSON.stringify([unique.sort(), text]))
            .digest('hex');
        return this.#committed(
            this.#transaction(() => {
                const previous = this.#db.prepare('SELECT * FROM mailbox_submissions WHERE id = ?').get(submissionId);
                if (previous) {
                    if (previous.sender.toLowerCase() !== this.#self.toLowerCase() || previous.digest !== digest)
                        throw new TypeError('Submission ID already used for a different message');
                    return JSON.parse(previous.message_ids);
                }
                const ids = recipients.map(to => this.#insertDM(this.#self, to, text, options));
                this.#db
                    .prepare('INSERT INTO mailbox_submissions VALUES (?, ?, ?, ?)')
                    .run(submissionId, this.#self, digest, JSON.stringify(ids));
                return ids;
            }),
        );
    }

    receiveDM(sender, text, options) {
        validName(sender);
        return this.#committed(this.#transaction(() => this.#insertDM(sender, this.#self, text, options)));
    }

    receiveChat(sender, text) {
        validName(sender);
        validText(text);
        const result = this.#db
            .prepare(
                `
            INSERT INTO mailbox_chat (observer, sender, text, createdAt, mention, is_read) VALUES (?, ?, ?, ?, ?, ?)
        `,
            )
            .run(
                this.#self,
                sender,
                text,
                Date.now(),
                Number(this.#mention.test(text)),
                Number(sender.toLowerCase() === this.#self.toLowerCase()),
            );
        return Number(result.lastInsertRowid);
    }

    summary() {
        const rows = this.#db
            .prepare(
                `
            SELECT 'dm' AS kind, d.sender AS sender, count(*) AS count, 0 AS mentions
            FROM mailbox_dm d
            WHERE d.recipient = ? AND ${CONVERSATION} AND NOT ${DM_READ} GROUP BY d.sender
            UNION ALL
            SELECT 'chat', '', count(*), coalesce(sum(mention), 0)
            FROM mailbox_chat WHERE observer = ? AND is_read = 0
            ORDER BY kind, sender
        `,
            )
            .all(this.#self, this.#self);
        const chat = rows.find(row => row.kind === 'chat');
        const dms = rows
            .filter(row => row.kind === 'dm')
            .map(row => `${row.sender}=${row.count}`)
            .join(', ');
        return `Unread DMs: ${dms || '0'}; public chat: ${chat.count} (mentions: ${chat.mentions}).`;
    }

    unreadMessages({ after = 0, limit = 20, priority = false } = {}) {
        validPage(after, limit, 0);
        return this.#db
            .prepare(
                `
            SELECT d.* FROM mailbox_dm d
            WHERE d.recipient = ? AND ${CONVERSATION} AND d.id > ? AND NOT ${DM_READ} ORDER BY ${
                priority ? `coalesce(json_extract(d.metadata, '$.urgent'), 0) DESC, ` : ''
            }d.id LIMIT ?
        `,
            )
            .all(this.#self, after, limit)
            .map(decodeMessage);
    }

    #markRead(ids) {
        const mark = this.#db.prepare(`INSERT OR IGNORE INTO mailbox_dm_reads (owner, peer, message_id)
            SELECT recipient, sender, id FROM mailbox_dm WHERE id = ? AND recipient = ?`);
        for (const id of ids) mark.run(id, this.#self);
    }

    acknowledge(ids) {
        if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1))
            throw new TypeError('Invalid message IDs');
        this.#transaction(() => this.#markRead(ids));
    }

    work() {
        return this.#work.snapshot();
    }

    resources() {
        return this.work().resources;
    }

    #record(text, metadata) {
        const result = this.#db
            .prepare('INSERT INTO mailbox_dm (sender,recipient,text,createdAt,metadata) VALUES (?,?,?,?,?)')
            .run(this.#self, this.#self, text, Date.now(), JSON.stringify(metadata));
        return Number(result.lastInsertRowid);
    }

    messageSource(messageId) {
        const row = this.#db
            .prepare('SELECT * FROM mailbox_dm WHERE id = ? AND recipient = ?')
            .get(messageId, this.#self);
        if (!row) throw new TypeError('Choose a message addressed to you');
        return decodeMessage(row);
    }

    chatSource(messageId) {
        const row = this.#db
            .prepare('SELECT * FROM mailbox_chat WHERE id = ? AND observer = ?')
            .get(messageId, this.#self);
        if (!row) throw new TypeError('Choose a public chat record you observed');
        return row;
    }

    #linkChat(source, goalId) {
        if (source)
            this.#db
                .prepare(
                    `INSERT OR IGNORE INTO mailbox_chat_goals(message_id,goal_id)
            SELECT c.id, ? FROM mailbox_chat c WHERE c.sender = ? AND c.text = ?
            AND NOT EXISTS(SELECT 1 FROM mailbox_chat_goals g WHERE g.message_id = c.id)`,
                )
                .run(goalId, source.sender, source.text);
    }

    setGoal({ id, title, scope, state, sourceMessageId, sourceChatId }) {
        for (const value of [title, scope]) if (value !== undefined) validText(value);
        if (state !== undefined && !['active', 'completed', 'cancelled'].includes(state))
            throw new TypeError('Invalid goal state');
        if (id !== undefined && (!Number.isSafeInteger(id) || id < 1)) throw new TypeError('Invalid goal ID');
        if (sourceMessageId !== undefined && sourceChatId !== undefined)
            throw new TypeError('Choose one instruction source');
        if (id && (sourceMessageId !== undefined || sourceChatId !== undefined))
            throw new TypeError('A goal keeps its instruction source');
        return this.#committed(
            this.#transaction(() => {
                const goals = this.work().goals;
                if (id) {
                    const goal = goals.find(g => g.id === id);
                    if (!goal) throw new TypeError('Unknown goal');
                    const patch = Object.fromEntries(
                        Object.entries({ title, scope, state }).filter(
                            ([key, value]) => value !== undefined && value !== goal[key],
                        ),
                    );
                    if (Object.keys(patch).length)
                        this.#record(title ?? goal.title, { type: 'revised', taskId: id, task: patch });
                    return this.work().goals.find(g => g.id === id);
                }
                validText(title);
                validText(scope);
                const chat = sourceChatId !== undefined ? this.chatSource(sourceChatId) : null;
                let source;
                if (chat) {
                    const linked = this.#db
                        .prepare('SELECT goal_id FROM mailbox_chat_goals WHERE message_id = ?')
                        .get(sourceChatId);
                    if (linked) return goals.find(g => g.id === linked.goal_id);
                    source =
                        'chat:' +
                        createHash('sha256')
                            .update(JSON.stringify([chat.sender.toLowerCase(), chat.text]))
                            .digest('hex');
                }
                if (sourceMessageId !== undefined) {
                    this.messageSource(sourceMessageId);
                    const submission = this.#db
                        .prepare('SELECT s.id FROM mailbox_submissions s, json_each(s.message_ids) m WHERE m.value = ?')
                        .get(sourceMessageId);
                    source = submission ? `submission:${submission.id}` : `message:${sourceMessageId}`;
                }
                const existing = source && goals.find(g => g.source === source && (!chat || g.state === 'active'));
                if (existing) {
                    this.#linkChat(chat, existing.id);
                    return existing;
                }
                const goalId = this.#record(title, {
                    type: 'request',
                    task: { kind: 'goal', shared: true, scope, source, state: state ?? 'active' },
                });
                this.#linkChat(chat, goalId);
                return this.work().goals.find(g => g.id === goalId);
            }),
        );
    }

    reportWork({ goalId, status, activity, blocker, evidence }) {
        if (!['working', 'blocked', 'idle', 'completed'].includes(status))
            throw new TypeError('Invalid activity status');
        validText(activity);
        if (blocker !== undefined) validText(blocker);
        if (evidence !== undefined) validText(evidence);
        if (status === 'blocked' && !blocker) throw new TypeError('Describe the actual blocker');
        if (status !== 'blocked' && blocker !== undefined) throw new TypeError('Only blocked activity has a blocker');
        return this.#committed(
            this.#transaction(() => {
                if (goalId !== undefined && !this.work().goals.some(g => g.id === goalId))
                    throw new TypeError('Unknown goal');
                const value = {
                    status,
                    activity,
                    ...(goalId !== undefined ? { goalId } : {}),
                    ...(blocker ? { blocker } : {}),
                    ...(evidence ? { evidence } : {}),
                };
                const previous = this.work().activities.find(a => a.agent.toLowerCase() === this.#self.toLowerCase());
                const previousValue =
                    previous &&
                    Object.fromEntries(
                        Object.entries(previous).filter(([key]) => !['id', 'agent', 'updatedAt'].includes(key)),
                    );
                if (JSON.stringify(previousValue) !== JSON.stringify(value))
                    this.#record(activity, { type: 'activity', activity: value });
                return this.work().activities.find(a => a.agent.toLowerCase() === this.#self.toLowerCase());
            }),
        );
    }

    recoverWork(reason) {
        const activity = this.work().activities.find(a => a.agent.toLowerCase() === this.#self.toLowerCase());
        if (activity?.status === 'working') this.reportWork({ ...activity, status: 'blocked', blocker: reason });
    }

    readDMs(peer = '', after = -1, limit = 20) {
        if (peer !== '') validName(peer);
        validPage(after, limit);
        return this.#transaction(() => {
            const where =
                after === -1 ? `d.recipient = ? AND NOT ${DM_READ}` : `(d.sender = ? OR d.recipient = ?) AND d.id > ?`;
            const params = after === -1 ? [this.#self] : [this.#self, this.#self, after];
            const peerFilter =
                peer === '' ? '' : ' AND ((d.sender = ? AND d.recipient = ?) OR (d.sender = ? AND d.recipient = ?))';
            if (peer !== '') params.push(this.#self, peer, peer, this.#self);
            const rows = this.#db
                .prepare(
                    `
                SELECT d.* FROM mailbox_dm d
                WHERE (${where}) AND ${CONVERSATION}${peerFilter} ORDER BY d.id LIMIT ?
            `,
                )
                .all(...params, limit + 1);
            const messages = rows.slice(0, limit).map(decodeMessage);
            this.#markRead(messages.map(message => message.id));
            return { messages, nextAfter: messages.at(-1)?.id ?? after, hasMore: rows.length > limit };
        });
    }

    #latestChat(limit, since = 0) {
        return this.#db
            .prepare(
                `
            SELECT id, sender, text, createdAt, mention FROM mailbox_chat
            WHERE observer = ? AND createdAt >= ? ORDER BY id DESC LIMIT ?
        `,
            )
            .all(this.#self, since, limit);
    }

    recentChat() {
        const since = Date.now() - 5 * 60 * 1000;
        const messages = this.#latestChat(6, since)
            .reverse()
            .map(row => ({
                ...row,
                mention: Boolean(row.mention),
                text: row.text.length > 300 ? row.text.slice(0, 300) + '…' : row.text,
            }));
        return { since, messages };
    }

    readChat(after = -1, limit = 20) {
        validPage(after, limit, -2);
        return this.#transaction(() => {
            const where = after === -1 ? 'is_read = 0' : 'id > ?';
            const params = after === -1 ? [this.#self] : [this.#self, after];
            const rows =
                after === -2
                    ? this.#latestChat(limit + 1)
                    : this.#db
                          .prepare(
                              `
                SELECT id, sender, text, createdAt, mention FROM mailbox_chat
                WHERE observer = ? AND ${where} ORDER BY id LIMIT ?
            `,
                          )
                          .all(...params, limit + 1);
            const selected = rows.slice(0, limit);
            if (after === -2) selected.reverse();
            const messages = selected.map(row => ({ ...row, mention: Boolean(row.mention) }));
            const mark = this.#db.prepare('UPDATE mailbox_chat SET is_read = 1 WHERE observer = ? AND id = ?');
            for (const message of messages) mark.run(this.#self, message.id);
            return {
                messages,
                nextAfter: messages.at(-1)?.id ?? after,
                hasMore: after !== -2 && rows.length > limit,
                ...(after === -2 ? { olderAvailable: rows.length > limit } : {}),
            };
        });
    }

    close() {
        if (this.#db) {
            this.#db.close();
            this.#db = undefined;
        }
    }
}

export class MailboxObserver {
    #db;
    #work;
    constructor(file) {
        this.#db = new DatabaseSync(file, { readOnly: true });
        this.#db.exec('PRAGMA busy_timeout = 3000');
        this.#work = new WorkProjection(this.#db);
    }
    work() {
        return this.#work.snapshot();
    }
    workRevision() {
        this.work();
        return this.#work.revision;
    }
    participants() {
        return this.#db
            .prepare(
                'SELECT sender AS name FROM mailbox_dm UNION SELECT recipient AS name FROM mailbox_dm ORDER BY name COLLATE NOCASE',
            )
            .all()
            .map(r => r.name);
    }

    latestId() {
        return this.#db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM mailbox_dm').get().id;
    }

    unreadRecipients() {
        return this.#db
            .prepare(`SELECT DISTINCT d.recipient AS name FROM mailbox_dm d WHERE ${CONVERSATION} AND NOT ${DM_READ}`)
            .all()
            .map(row => row.name);
    }

    messages({
        participants = [],
        sender,
        recipient,
        before = 0,
        after,
        agents = [],
        agentsOnly = false,
        limit = 100,
    } = {}) {
        if (![0, 1, 2].includes(participants.length)) throw new TypeError('Choose zero, one or two participants');
        participants.forEach(validName);
        if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            throw new TypeError('Invalid message page');
        if (
            (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || before !== 0)) ||
            typeof agentsOnly !== 'boolean'
        )
            throw new TypeError('Invalid message cursor or agent filter');
        const names = [...new Set(agents.map(validName))];
        const conversation = '(d.sender IN (SELECT name FROM agents) AND d.recipient IN (SELECT name FROM agents))';
        const where = [CONVERSATION],
            params = [];
        if (agentsOnly) where.push(conversation);
        if (after !== undefined) {
            where.push('d.id > ?');
            params.push(after);
        }
        if (before) {
            where.push('d.id < ?');
            params.push(before);
        }
        for (const [column, name] of [
            ['sender', sender],
            ['recipient', recipient],
        ]) {
            if (name !== undefined) {
                validName(name);
                where.push(`d.${column} = ?`);
                params.push(name);
            }
        }
        if (participants.length === 1) {
            where.push('(d.sender = ? OR d.recipient = ?)');
            params.push(participants[0], participants[0]);
        }
        if (participants.length === 2) {
            where.push('((d.sender = ? AND d.recipient = ?) OR (d.sender = ? AND d.recipient = ?))');
            params.push(...participants, ...[...participants].reverse());
        }
        const rows = this.#db
            .prepare(
                `
            WITH agents(name) AS (${names.length ? 'VALUES ' + names.map(() => '(?)').join(',') : 'SELECT NULL WHERE 0'})
            SELECT d.*, ${conversation} AS agentConversation,
                ${DM_READ} AS readByRecipient
            FROM mailbox_dm d ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY d.id ${after === undefined ? 'DESC' : 'ASC'} LIMIT ?
        `,
            )
            .all(...names, ...params, limit + 1);
        const page = rows.slice(0, limit);
        if (after === undefined) page.reverse();
        return {
            messages: page.map(r => ({
                ...decodeMessage(r),
                readByRecipient: Boolean(r.readByRecipient),
                agentConversation: Boolean(r.agentConversation),
            })),
            hasOlder: after === undefined && rows.length > limit,
            ...(after === undefined ? {} : { nextAfter: page.at(-1)?.id ?? after, hasMore: rows.length > limit }),
        };
    }

    close() {
        this.#db.close();
    }
}
