/**
 * package.js — 打包 Electron 应用到目录（不生成安装包）
 * 相当于旧的 `electron-forge package`
 *
 * 平台自适应：根据当前运行平台选择正确的打包目标
 *   macOS  → --mac
 *   Windows → --win
 *   Linux   → --linux
 *
 * 用法: node scripts/package.js [--dir dist/debug]
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 根据当前平台获取 electron-builder 平台参数 */
function getPlatformFlag() {
  switch (process.platform) {
    case 'darwin':
      return '--mac';
    case 'win32':
      return '--win';
    case 'linux':
      return '--linux';
    default:
      // 兜底：使用当前平台
      console.warn(`[package] Unknown platform "${process.platform}", defaulting to --win`);
      return '--win';
  }
}

/** 根据平台获取输出目录提示信息 */
function getOutputHint(flag) {
  const map = {
    '--mac': 'dist/mac*/',
    '--win': 'dist/win-unpacked/',
    '--linux': 'dist/linux-unpacked/',
  };
  return map[flag] || 'dist/';
}

async function main() {
  const platformFlag = getPlatformFlag();
  const outputHint = getOutputHint(platformFlag);

  console.log(`\n📦 Packaging HClaw for ${process.platform}...\n`);

  const args = [platformFlag, '--dir'];

  const builder = spawn('npx', ['electron-builder', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      DEBUG: process.env.DEBUG || 'electron-builder',
    },
  });

  builder.on('close', (code) => {
    if (code === 0) {
      console.log(`\n✅ Packaging complete! Output: ${outputHint}\n`);
    } else {
      console.error(`\n❌ Packaging failed with exit code ${code}\n`);
    }
    process.exit(code);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
