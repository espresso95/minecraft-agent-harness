import { DatabaseSync } from 'node:sqlite';

const number = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);

export class UsageLedger {
    constructor(file) {
        this.db = new DatabaseSync(file);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
            CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY, agent TEXT NOT NULL, run TEXT NOT NULL, session TEXT NOT NULL,
                model TEXT, thinking TEXT, started TEXT, finished TEXT, response TEXT UNIQUE,
                status TEXT NOT NULL, input INTEGER, cached INTEGER, output INTEGER, reasoning INTEGER, total INTEGER
            );
            CREATE INDEX IF NOT EXISTS usage_agent ON requests(agent, session);
        `);
    }

    ingest(event, { agent, run, session }) {
        if (typeof event.id !== 'string') return;
        this.db
            .prepare(
                `INSERT OR IGNORE INTO requests (id,agent,run,session,model,thinking,started,status)
            VALUES (?,?,?,?,?,?,?,'pending')`,
            )
            .run(event.id, agent, run, session, event.model ?? null, event.thinking ?? null, event.at);
        if (event.event === 'request_start') return;
        if (event.event === 'response_usage') {
            const u = event.usage ?? {};
            const input = number(u.input_tokens),
                output = number(u.output_tokens),
                total = number(u.total_tokens);
            const cached = number(u.input_tokens_details?.cached_tokens),
                reasoning = number(u.output_tokens_details?.reasoning_tokens);
            const valid =
                input !== null &&
                output !== null &&
                total === input + output &&
                (cached === null || cached <= input) &&
                (reasoning === null || reasoning <= output);
            this.db
                .prepare(
                    `UPDATE requests SET response=?,model=COALESCE(?,model),finished=?,status=?,input=?,cached=?,output=?,reasoning=?,total=? WHERE id=?`,
                )
                .run(
                    event.responseId ?? null,
                    event.model ?? null,
                    event.at,
                    valid ? 'reported' : 'unknown',
                    valid ? input : null,
                    valid ? cached : null,
                    valid ? output : null,
                    valid ? reasoning : null,
                    valid ? total : null,
                    event.id,
                );
        } else if (['usage_unavailable', 'request_error'].includes(event.event)) {
            this.db
                .prepare("UPDATE requests SET status='unknown',finished=? WHERE id=? AND status!='reported'")
                .run(event.at, event.id);
        }
    }

    finishRun(run) {
        this.db.prepare("UPDATE requests SET status='unknown' WHERE run=? AND status='pending'").run(run);
    }

    totals(agent, session = null) {
        const clauses = [],
            args = [];
        if (agent) {
            clauses.push('agent=?');
            args.push(agent);
        }
        if (session) {
            clauses.push('session=?');
            args.push(session);
        }
        const sums = ['input', 'cached', 'output', 'reasoning', 'total'].map(
            key => `COALESCE(SUM(${key}) FILTER (WHERE status='reported'),0) AS ${key}`,
        );
        return this.db
            .prepare(
                `SELECT ${sums.join(',')},
            COUNT(*) FILTER (WHERE status='reported') AS reported,
            COUNT(*) FILTER (WHERE status='pending') AS pending,
            COUNT(*) FILTER (WHERE status='unknown') AS unknown,
            COUNT(*) FILTER (WHERE status='reported' AND reasoning IS NOT NULL) AS reasoningKnown,
            COUNT(*) FILTER (WHERE status='reported' AND cached IS NOT NULL) AS cachedKnown,
            COALESCE(SUM(total) FILTER (WHERE status='reported' AND julianday(finished)>=julianday(?)),0) AS tokensLastMinute
            FROM requests ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
        `,
            )
            .get(new Date(Date.now() - 60000).toISOString(), ...args);
    }

    close() {
        this.db.close();
    }
}
