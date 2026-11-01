import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

export async function prepareServer(directory) {
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'bukkit.yml');
    let config = {};
    try {
        config = YAML.parse(await readFile(file, 'utf8')) ?? {};
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    config.settings ??= {};
    // All clients arrive through the local VM/gateway address. IP-based throttling
    // otherwise rejects unrelated players and companions as duplicate connections.
    if (config.settings['connection-throttle'] === 0) return;
    config.settings['connection-throttle'] = 0;
    await writeFile(file + '.tmp', YAML.stringify(config));
    await rename(file + '.tmp', file);
}
