import { createHash } from 'node:crypto';

// Immutable program versions and observed outcomes live in the existing shared DB.
export class SkillStore {
    constructor(db, actor) {
        this.db = db;
        this.actor = actor;
        db.exec(`CREATE TABLE IF NOT EXISTS shared_skills (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, author TEXT NOT NULL, path TEXT NOT NULL,
            description TEXT NOT NULL, parameters TEXT NOT NULL, assumptions TEXT NOT NULL,
            gameVersion TEXT NOT NULL, source TEXT NOT NULL, createdAt INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0
        ); CREATE TABLE IF NOT EXISTS shared_skill_runs (
            id INTEGER PRIMARY KEY, skill TEXT NOT NULL REFERENCES shared_skills(id), actor TEXT NOT NULL,
            createdAt INTEGER NOT NULL, success INTEGER NOT NULL, verification TEXT NOT NULL
        ); CREATE INDEX IF NOT EXISTS shared_skill_runs_skill ON shared_skill_runs(skill, id);`);
    }
    save(value) {
        if (
            !/^[a-z][a-z0-9_]{1,47}$/.test(value.name) ||
            typeof value.source !== 'string' ||
            !value.source.trim() ||
            Buffer.byteLength(value.source) > 32768
        )
            throw new TypeError('Use a snake_case name and a Python program of at most 32 KiB');
        const id = createHash('sha256').update(JSON.stringify(value)).digest('hex');
        this.db
            .prepare(
                'INSERT OR IGNORE INTO shared_skills (id,name,author,path,description,parameters,assumptions,gameVersion,source,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
                id,
                value.name,
                this.actor,
                value.path,
                value.description,
                JSON.stringify(value.parameters),
                value.assumptions,
                value.gameVersion,
                value.source,
                Date.now(),
            );
        return this.get(id);
    }
    get(id, contract = null) {
        const row = this.db
            .prepare(
                "SELECT s.*, (SELECT count(*) FROM shared_skill_runs r WHERE r.skill = s.id AND r.success = 1 AND json_extract(r.verification, '$.passed') = 1 AND (? IS NULL OR json_extract(r.verification, '$.contract') = ?)) AS verifiedRuns FROM shared_skills s WHERE id = ?",
            )
            .get(contract, contract, id);
        if (!row) throw new TypeError('Unknown skill version');
        return {
            ...row,
            parameters: JSON.parse(row.parameters),
            retired: Boolean(row.retired),
            status: row.retired ? 'retired' : row.verifiedRuns ? 'verified' : 'candidate',
        };
    }
    search(query = '', includeCandidates = false, contract = null) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        return this.db
            .prepare('SELECT id FROM shared_skills WHERE retired = 0 ORDER BY createdAt DESC')
            .all()
            .map(r => this.get(r.id, contract))
            .filter(
                s =>
                    (includeCandidates || s.status === 'verified') &&
                    terms.every(term => `${s.name} ${s.description} ${s.assumptions}`.toLowerCase().includes(term)),
            )
            .slice(0, 20)
            .map(({ source, ...metadata }) => metadata);
    }
    retire(id) {
        const skill = this.get(id);
        if (skill.author.toLowerCase() !== this.actor.toLowerCase())
            throw new TypeError('Only the author can retire a skill; save a corrected version instead');
        this.db.prepare('UPDATE shared_skills SET retired = 1 WHERE id = ?').run(id);
        return this.get(id);
    }
    record(id, success, verification, contract = null) {
        this.db
            .prepare('INSERT INTO shared_skill_runs(skill,actor,createdAt,success,verification) VALUES (?,?,?,?,?)')
            .run(id, this.actor, Date.now(), Number(success), JSON.stringify(verification));
        return this.get(id, contract);
    }
}
