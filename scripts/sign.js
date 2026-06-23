/**
 * sign.js — Windows 代码签名辅助模块
 *
 * 在 afterPack 阶段对 HClaw.exe 进行数字签名，使 Windows 智能应用控制 (SAC)
 * 不再拦截应用运行。
 *
 * 支持的签名方式（按优先级）：
 *   1. 环境变量方式（CI/CD 推荐）— 通过以下环境变量配置
 *   2. 配置文件方式（本地开发）— 通过 config/sign.json 配置
 *
 * 环境变量:
 *   SIGN_METHOD          — "cert" (文件证书) 或 "azure" (Azure Trusted Signing)
 *
 *   # 方式1: 文件证书 (PFX/P12)
 *   SIGN_CERT_FILE       — 证书文件路径 (.pfx/.p12)
 *   SIGN_CERT_PASSWORD   — 证书密码
 *   SIGN_TIMESTAMP_URL   — 时间戳服务器（可选，默认 http://timestamp.digicert.com）
 *   SIGN_DUAL_SIGN       — 是否双重签名（可选，true/false）
 *
 *   # 方式2: Azure Trusted Signing（无需管理证书文件）
 *   AZURE_TENANT_ID      — Azure 租户 ID
 *   AZURE_CLIENT_ID      — Azure 客户端 ID（服务主体）
 *   AZURE_CLIENT_SECRET  — Azure 客户端密钥
 *   AZURE_ACCOUNT_NAME   — Azure Trusted Signing 账户名
 *   AZURE_CERT_PROFILE   — 证书配置文件
 *
 * 使用示例:
 *   # 方式1: PFX 证书
 *   set SIGN_METHOD=cert
 *   set SIGN_CERT_FILE=C:\certs\hclaw.pfx
 *   set SIGN_CERT_PASSWORD=xxxx
 *   npm run make
 *
 *   # 方式2: Azure Trusted Signing
 *   set SIGN_METHOD=azure
 *   set AZURE_TENANT_ID=xxx
 *   set AZURE_CLIENT_ID=xxx
 *   set AZURE_CLIENT_SECRET=xxx
 *   set AZURE_ACCOUNT_NAME=HClawSign
 *   set AZURE_CERT_PROFILE=HClawProfile
 *   npm run make
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Windows SDK 默认路径（signtool.exe）
const SIGNTOOL_CANDIDATES = [
  // Windows SDK 10/11
  'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe',
  'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22621.0\\x64\\signtool.exe',
  'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22000.0\\x64\\signtool.exe',
  'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.20348.0\\x64\\signtool.exe',
  'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.19041.0\\x64\\signtool.exe',
  // 旧版路径
  'C:\\Program Files (x86)\\Microsoft SDKs\\ClickOnce\\SignTool\\signtool.exe',
  // 通过 where 命令查找
];

/**
 * 查找 signtool.exe
 */
function findSignTool() {
  for (const candidate of SIGNTOOL_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 尝试通过 where 命令查找
  try {
    const result = execSync('where signtool 2>nul', { encoding: 'utf8', timeout: 5000 });
    const lines = result.trim().split('\n').filter(Boolean);
    if (lines.length > 0 && fs.existsSync(lines[0])) {
      return lines[0];
    }
  } catch {
    // 没找到
  }

  return null;
}

/**
 * 加载配置文件（config/sign.json）
 */
function loadConfig() {
  const configPath = path.resolve(__dirname, '..', 'config', 'sign.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.warn(`[sign] WARN: Failed to parse config/sign.json: ${e.message}`);
    }
  }
  return {};
}

/**
 * 检查签名环境是否可用
 */
function isSigningAvailable() {
  const method = process.env.SIGN_METHOD || '';

  if (method === 'cert') {
    return !!(process.env.SIGN_CERT_FILE && fs.existsSync(process.env.SIGN_CERT_FILE));
  }

  if (method === 'azure') {
    return !!(
      process.env.AZURE_TENANT_ID &&
      process.env.AZURE_CLIENT_ID &&
      process.env.AZURE_CLIENT_SECRET &&
      process.env.AZURE_ACCOUNT_NAME &&
      process.env.AZURE_CERT_PROFILE
    );
  }

  // 检查配置文件
  const config = loadConfig();
  if (config.method === 'cert') {
    return !!(config.certFile && fs.existsSync(config.certFile));
  }
  if (config.method === 'azure') {
    return !!(config.azure?.tenantId && config.azure?.clientId);
  }

  return false;
}

/**
 * 对指定的 exe/dll 文件进行签名
 *
 * @param {string} filePath - 待签名文件的完整路径
 * @returns {boolean} 签名是否成功
 */
function signFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[sign] SKIP: ${filePath} not found`);
    return false;
  }

  const signtool = findSignTool();
  if (!signtool) {
    console.log('[sign] SKIP: signtool.exe not found (install Windows SDK)');
    return false;
  }

  const method = process.env.SIGN_METHOD || loadConfig().method || '';
  if (!method) {
    console.log('[sign] SKIP: SIGN_METHOD not set (cert or azure)');
    return false;
  }

  console.log(`[sign] Signing ${path.basename(filePath)} using "${method}" method...`);

  let args = [];

  if (method === 'cert') {
    // PFX/P12 证书方式
    const certFile = process.env.SIGN_CERT_FILE || loadConfig().certFile;
    const password = process.env.SIGN_CERT_PASSWORD || loadConfig().certPassword || '';
    const timestampUrl = process.env.SIGN_TIMESTAMP_URL
      || loadConfig().timestampUrl
      || 'http://timestamp.digicert.com';

    args = [
      'sign',
      '/fd', 'SHA256',
      '/f', `"${certFile}"`,
      '/p', `"${password}"`,
      '/tr', timestampUrl,
      '/td', 'SHA256',
      // 启用页面散列（Page Hashing），对大文件更高效
      '/ph',
      // 必须以 /a 结尾（自动选择最佳证书）
      '/a',
      `"${filePath}"`,
    ];

    // 双重签名（兼容 Windows 7/8 和 SHA256 验证）
    const dualSign = process.env.SIGN_DUAL_SIGN === 'true' || loadConfig().dualSign === true;
    if (dualSign) {
      args = [
        'sign',
        '/fd', 'SHA1',
        '/f', `"${certFile}"`,
        '/p', `"${password}"`,
        '/t', 'http://timestamp.digicert.com',
        '/a',
        `"${filePath}"`,
        ...args, // 再加 SHA256 签名
      ];
    }
  } else if (method === 'azure') {
    // Azure Trusted Signing（推荐，无需管理证书文件）
    // 使用 Azure 的 Trusted Signing SDK 或第三方封装
    // 需要安装: npm install -g @azure/trusted-signing
    // 
    // 或使用 AzureSignTool (推荐): dotnet tool install --global AzureSignTool
    //
    // 示例命令:
    //   AzureSignTool sign ...
    const tenantId = process.env.AZURE_TENANT_ID || loadConfig().azure?.tenantId;
    const clientId = process.env.AZURE_CLIENT_ID || loadConfig().azure?.clientId;
    const clientSecret = process.env.AZURE_CLIENT_SECRET || loadConfig().azure?.clientSecret;
    const accountName = process.env.AZURE_ACCOUNT_NAME || loadConfig().azure?.accountName;
    const certProfile = process.env.AZURE_CERT_PROFILE || loadConfig().azure?.certProfile;

    // 检查是否装了 AzureSignTool
    try {
      execSync('AzureSignTool --version 2>nul', { encoding: 'utf8', timeout: 5000 });
    } catch {
      console.log('[sign] SKIP: AzureSignTool not installed. Run: dotnet tool install --global AzureSignTool');
      return false;
    }

    const timestampUrl = process.env.SIGN_TIMESTAMP_URL
      || loadConfig().timestampUrl
      || 'http://timestamp.digicert.com';

    const result = spawnSync('AzureSignTool', [
      'sign',
      '--azure-key-vault-tenant-id', tenantId,
      '--azure-key-vault-client-id', clientId,
      '--azure-key-vault-client-secret', clientSecret,
      '--azure-key-vault-account-name', accountName,
      '--azure-key-vault-certificate-profile', certProfile,
      '--timestamp-rfc3161', timestampUrl,
      '--timestamp-digest', 'SHA256',
      '--page-hashing',
      `"${filePath}"`,
    ], {
      stdio: 'pipe',
      shell: true,
      timeout: 60000,
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim();
      console.error(`[sign] FAILED: ${stderr || 'AzureSignTool error'}`);
      return false;
    }

    console.log(`[sign] OK: ${path.basename(filePath)} signed via Azure Trusted Signing`);
    return true;
  } else {
    console.log(`[sign] SKIP: Unknown SIGN_METHOD "${method}" (use "cert" or "azure")`);
    return false;
  }

  // 执行 signtool
  const cmd = `"${signtool}" ${args.join(' ')}`;
  console.log(`[sign] Running: ${cmd.substring(0, 200)}...`);

  const result = spawnSync(cmd, [], {
    stdio: 'pipe',
    shell: true,
    timeout: 60000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    const stdout = result.stdout?.toString().trim();
    console.error(`[sign] FAILED (exit ${result.status})`);
    if (stderr) console.error(`[sign] stderr: ${stderr}`);
    if (stdout) console.error(`[sign] stdout: ${stdout}`);
    return false;
  }

  console.log(`[sign] OK: ${path.basename(filePath)} signed successfully`);
  return true;
}

module.exports = {
  findSignTool,
  isSigningAvailable,
  signFile,
};
