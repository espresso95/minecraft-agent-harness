import { resolve } from 'node:path';
import { createCompanionController } from '../src/controller/server.js';
import { connectedModelCatalog } from '../src/controller/model-catalog.js';
import { ServerRules } from '../src/controller/server-rules.js';
import { Appearances } from '../src/controller/appearances.js';

delete process.env.OPENAI_API_KEY;
const stateDir = resolve(process.env.COMPANION_STATE_DIR ?? '.agent-state/companions');
const authFile = resolve(process.env.COMPANION_AUTH_FILE ?? '.agent-state/auth.json');
const serverRules = new ServerRules({
    stateFile: resolve(process.env.COMPANION_SERVER_DIR ?? '.agent-state/server', 'plugins/CompanionRules/state.json'),
    container: process.env.COMPANION_SERVER_CONTAINER ?? 'minecraft-companions-server-1',
});
await serverRules.ready();
const controller = await createCompanionController({
    stateDir,
    authFile,
    port: Number(process.env.COMPANION_PORT ?? 8766),
    mcPort: Number(process.env.MC_PORT ?? 25565),
    autoStart: process.env.COMPANION_AUTO_START !== '0',
    serverRules,
    appearances: new Appearances({
        file: resolve(
            process.env.COMPANION_SERVER_DIR ?? '.agent-state/server',
            'plugins/CompanionRules/appearances.json',
        ),
        serverRules,
    }),
    catalog: await connectedModelCatalog(authFile),
});
console.log(`Companions controller listening locally on ${controller.endpoint}`);
console.log('Pair the Minecraft mod with npm run companions:pair. Press K in your local world.');
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => void controller.close().then(() => process.exit(0)));
