import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const run = args => {
    const result = spawnSync(process.execPath, [cli, 'icon', ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
};

// Only generate image resources; this command never builds native packages.
run(['assets/branding/icon-manifest.json', '--output', 'src-tauri/icons']);
run(['assets/branding/app-icon.png', '--output', 'public/icons', '--png', '32', '--png', '180', '--png', '192', '--png', '512']);
fs.copyFileSync(path.join(root, 'src-tauri/icons/icon.ico'), path.join(root, 'public/favicon.ico'));

// Tauri writes into an initialized Android project when one exists. Keep the
// canonical resources in sync as well, including adaptive round launchers.
const androidProject = path.join(root, 'src-tauri/gen/android/app/src/main/res');
const androidIcons = path.join(root, 'src-tauri/icons/android');
const generated = fs.existsSync(androidProject) ? androidProject : androidIcons;
const adaptive = path.join(generated, 'mipmap-anydpi-v26');
fs.copyFileSync(path.join(adaptive, 'ic_launcher.xml'), path.join(adaptive, 'ic_launcher_round.xml'));
if (generated !== androidIcons) {
    for (const dir of fs.readdirSync(generated).filter(name => name.startsWith('mipmap-'))) {
        for (const file of fs.readdirSync(path.join(generated, dir)).filter(name => /^ic_launcher(?:_\w+)?\.(?:png|xml)$/.test(name))) {
            fs.mkdirSync(path.join(androidIcons, dir), { recursive: true });
            fs.copyFileSync(path.join(generated, dir, file), path.join(androidIcons, dir, file));
        }
    }
}
