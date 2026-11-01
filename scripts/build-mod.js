import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'mods/companion-mailbox');
if (!existsSync(resolve(directory, 'gradlew')))
    throw new Error('Mod source is missing. Run git submodule update --init --recursive and try again.');
const task = process.argv[2] ?? 'build';
if (!['build', 'runClient', 'runClientGameTest'].includes(task))
    throw new Error('Use build, runClient or runClientGameTest');
const candidates = [
    process.env.JAVA_HOME,
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
].filter(Boolean);
const java = candidates.find(
    home =>
        existsSync(resolve(home, 'bin/java')) &&
        /version "21\./.test(spawnSync(resolve(home, 'bin/java'), ['-version'], { encoding: 'utf8' }).stderr),
);
if (!java) throw new Error('Java 21 is required. Install a JDK 21 and set JAVA_HOME.');
const child = spawn('./gradlew', [task, '--console=plain', ...process.argv.slice(3)], {
    cwd: directory,
    env: { ...process.env, JAVA_HOME: java },
    stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', code => {
    process.exitCode = code ?? 1;
});
child.once('error', error => {
    console.error(error.message);
    process.exitCode = 1;
});
