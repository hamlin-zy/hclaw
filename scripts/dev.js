// HClaw dev script — Vite 8 build + renderer HMR + Electron launch
const {spawn, execSync} = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${RENDERER_PORT}`;

async function main() {
    console.log(`\n🔧 HClaw Dev Mode — Vite 8 + Electron\n`);

    // Step 1: Build main + preload with DEV_SERVER_URL defined
    console.log('[1/3] Building main process (dev)...');
    execSync(`npx vite build --config vite.main.config.mjs`, {
        cwd: ROOT,
        stdio: 'inherit',
        env: {...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL, HCLAW_DEV_SERVER_URL: DEV_SERVER_URL, HCLAW_DEV_MODE: 'true'},
    });

    console.log('[2/3] Building preload (dev)...');
    execSync(`npx vite build --config vite.preload.config.mjs`, {
        cwd: ROOT,
        stdio: 'inherit',
    });

    // Step 2: Start renderer dev server
    console.log(`[3/3] Starting renderer dev server on :${RENDERER_PORT}...\n`);
    const renderer = spawn('npx', ['vite', '--config', 'vite.renderer.config.mjs'], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
        env: {...process.env, NODE_OPTIONS: '--max-old-space-size=4096'},
    });

    // Step 3: Wait briefly then launch Electron
    setTimeout(() => {
        console.log('\n🚀 Launching Electron...\n');
        const electron = spawn('npx', ['electron', '.', '--js-flags=--max-old-space-size=2048,--max-semi-space-size=64,--gc-interval=2048'], {
            cwd: ROOT,
            stdio: 'inherit',
            shell: true,
            env: Object.fromEntries(Object.entries({
                ...process.env,
                VITE_DEV_SERVER_URL: DEV_SERVER_URL,
                HCLAW_DEV_SERVER_URL: DEV_SERVER_URL,
                HCLAW_DEV_MODE: 'true',
            }).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
        });

        // If Electron exits, kill renderer server
        electron.on('close', () => {
            renderer.kill();
            process.exit(0);
        });
    }, 3000); // Give renderer dev server 3s to start

    process.on('SIGINT', () => {
        renderer.kill();
        process.exit(0);
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
