/**
 * build-prod.js — 生产构建脚本
 *
 * Vite config 自身有双重保险（要求 HCLAW_DEV_MODE=true 才启用 dev URL），
 * 本脚本仅确保构建环境干净，不做复杂 env 过滤。
 * 开发模式下由 dev.js 主动设置 HCLAW_DEV_MODE=true。
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

console.log('\n🔨 Production build\n');

function runVite(config) {
    execSync(`npx vite build --config ${config}`, {
        cwd: ROOT,
        stdio: 'inherit',
    });
}

console.log('[1/3] Building main process...');
runVite('vite.main.config.mjs');

console.log('[2/3] Building preload...');
runVite('vite.preload.config.mjs');

console.log('[3/3] Building renderer...');
runVite('vite.renderer.config.mjs');

console.log('\n✅ Production build complete\n');
