import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { validName } from './profiles.js';

const equal = (a, b) => {
    const x = Buffer.from(String(a)),
        y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
};
export class LocalAccess {
    constructor({ file, runtimeFile, secret }) {
        Object.assign(this, { file, runtimeFile, secret });
        this.failed = [];
        try {
            this.settings = JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            this.settings = { lanEnabled: false, code: this.code(), epoch: randomBytes(24).toString('base64url') };
            this.save();
        }
    }
    code() {
        return randomBytes(4).toString('hex').toUpperCase();
    }
    save() {
        writeFileSync(this.file + '.tmp', JSON.stringify(this.settings), { mode: 0o600 });
        renameSync(this.file + '.tmp', this.file);
    }
    snapshot() {
        let runtime = {};
        try {
            runtime = JSON.parse(readFileSync(this.runtimeFile, 'utf8'));
        } catch {}
        return { ...runtime, lanEnabled: this.settings.lanEnabled, pairingCode: this.settings.code };
    }
    update(value) {
        if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).some(k => !['lanEnabled', 'rotateCode'].includes(k)) ||
            (value.lanEnabled !== undefined && typeof value.lanEnabled !== 'boolean') ||
            (value.rotateCode !== undefined && typeof value.rotateCode !== 'boolean')
        )
            throw new Error('Invalid network setting');
        const previous = { ...this.settings };
        if (value.lanEnabled !== undefined) this.settings.lanEnabled = value.lanEnabled;
        if (value.rotateCode) {
            this.settings.code = this.code();
            this.settings.epoch = randomBytes(24).toString('base64url');
            this.failed = [];
        }
        try {
            this.save();
        } catch (error) {
            this.settings = previous;
            throw error;
        }
        return this.snapshot();
    }
    signature(payload) {
        return createHmac('sha256', this.secret).update(payload).digest('base64url');
    }
    authenticate(header) {
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
        const token = String(header ?? '').replace(/^Bearer /, '');
        if (equal(token, this.secret)) return { host: true };
        const [payload, signature, extra] = token.split('.');
        if (!payload || !signature || extra || token.length > 1024 || !equal(signature, this.signature(payload)))
            return null;
        try {
            const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            return value.epoch === this.settings.epoch && validName(value.player) ? value : null;
        } catch {
            return null;
        }
    }
    pair(code, player) {
        this.failed = this.failed.filter(time => time > Date.now() - 60000);
        if (this.failed.length >= 5) throw new Error('Too many pairing attempts. Try again in a minute.');
        if (typeof code !== 'string' || !equal(code.trim().toUpperCase(), this.settings.code) || !validName(player)) {
            this.failed.push(Date.now());
            throw new Error('Invalid pairing code or player name');
        }
        const payload = Buffer.from(JSON.stringify({ player, epoch: this.settings.epoch })).toString('base64url');
        return payload + '.' + this.signature(payload);
    }
}
