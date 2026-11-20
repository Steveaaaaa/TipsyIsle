import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keygen, pack, runCli } from '../packages/plugin-sdk/packager.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(root, 'releases', 'plugins');
const args = process.argv.slice(2);
try {
    if (args[0] === 'examples') {
        const key = path.join(root, '.runtime', 'plugin-examples.pem');
        try { await keygen(key); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        for (const name of ['action-options', 'story-journal']) {
            await pack(path.join(root, 'examples', 'plugins', name), key, path.join(outputDirectory, `${name}.tipsy-plugin`));
        }
    } else await runCli(args, { defaultKey: path.join(root, '.runtime', 'plugin-publisher.pem'), outputDirectory });
} catch (error) { console.error(`插件打包失败：${error.message}`); process.exitCode = 1; }
