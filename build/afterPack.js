/**
 * electron-builder afterPack hook
 *
 * 打包完成后执行：
 * 1. 修剪语言包（只保留中英文）
 * 2. 删除调试符号文件
 */
const path = require('path');
const fs = require('fs');

exports.default = async function (context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const platform = electronPlatformName === 'win32' ? 'win32'
    : electronPlatformName === 'darwin' ? 'darwin'
    : 'linux';

  console.log(`[afterPack] Processing ${appOutDir} (${platform})`);

  // 1. 修剪原生模块预编译文件（只保留当前平台）
  pruneNativePrebuilds(appOutDir, platform);

  // 2. 修剪语言包（只保留中英文）
  trimLocales(appOutDir);

  // 3. 清理调试文件
  cleanupDebugFiles(appOutDir);

  // 4. 嵌入图标到 .exe（Windows 专用）
  if (platform === 'win32') {
    await embedIcon(context);
  }
};

/**
 * 只保留当前平台的 .node 预编译文件
 *
 * 各平台保留的预编译标识：
 *   win32  → win32-x64, win32-ia32
 *   darwin → darwin-arm64, darwin-x64
 *   linux  → linux-x64, linux-arm64
 */
function pruneNativePrebuilds(appDir, platform) {
  const keepMap = {
    win32: ['win32-x64', 'win32-ia32'],
    darwin: ['darwin-arm64', 'darwin-x64'],
    linux: ['linux-x64', 'linux-arm64'],
  };
  const keep = keepMap[platform] || [];

  let removedCount = 0;

  // 递归查找 prebuilds 和 bin 目录
  function scanDir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath)) {
      const fullPath = path.join(dirPath, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;

      // 检查是否是 prebuilds 或 bin 目录
      if (entry === 'prebuilds' || entry === 'bin') {
        for (const file of fs.readdirSync(fullPath)) {
          const filePath = path.join(fullPath, file);
          if (!keep.some(k => file.includes(k))) {
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
              fs.rmSync(filePath, { recursive: true, force: true });
            } else {
              fs.rmSync(filePath, { force: true });
            }
            removedCount++;
          }
        }
      } else {
        scanDir(fullPath);
      }
    }
  }

  // 查找包含 node_modules 的目录
  const resourcesDir = path.join(appDir, 'resources');
  if (fs.existsSync(resourcesDir)) {
    for (const entry of fs.readdirSync(resourcesDir)) {
      const fullPath = path.join(resourcesDir, entry);
      if (entry.endsWith('.asar')) continue; // asar 文件里我们不需要处理
      if (fs.statSync(fullPath).isDirectory()) {
        scanDir(fullPath);
      }
    }
  }

  if (removedCount > 0) {
    console.log(`[prune-native] Removed ${removedCount} prebuild file(s) for other platforms (keeping ${platform})`);
  }
}

/**
 * 只保留中英文语言包
 */
function trimLocales(appDir) {
  const localesPaths = [
    path.join(appDir, 'locales'),
  ];

  // 也在 resources 目录下查找
  const resourcesLocales = path.join(appDir, 'resources', 'locales');
  if (fs.existsSync(resourcesLocales)) {
    localesPaths.push(resourcesLocales);
  }
  // 检查 app.asar 同级的 locales
  const appDir2 = path.join(appDir, 'resources', 'app');
  const appLocales = path.join(appDir2, 'locales');
  if (fs.existsSync(appLocales)) {
    localesPaths.push(appLocales);
  }

  const keep = ['en-US.pak', 'zh-CN.pak'];
  let removed = 0;
  let kept = 0;

  for (const localesDir of localesPaths) {
    if (!fs.existsSync(localesDir)) continue;

    for (const file of fs.readdirSync(localesDir)) {
      if (!keep.includes(file)) {
        const filePath = path.join(localesDir, file);
        try {
          fs.rmSync(filePath, { force: true });
          removed++;
        } catch (e) {
          // 忽略权限错误
        }
      } else {
        kept++;
      }
    }
  }

  console.log(`[trim-locales] Kept ${kept} locale(s), removed ${removed} locale(s)`);
}

/**
 * 清理调试符号等无用文件
 */
function cleanupDebugFiles(appDir) {
  // 删除 .pdb 调试文件
  const pdbFiles = findFiles(appDir, (name) => name.endsWith('.pdb'));
  for (const file of pdbFiles) {
    try {
      const size = fs.statSync(file).size;
      fs.rmSync(file, { force: true });
      console.log(`[cleanup] Removed ${path.basename(file)} (${Math.round(size / 1024)} KB)`);
    } catch (e) {
      // 忽略
    }
  }
}

/**
 * 使用 rcedit 将图标嵌入 .exe 文件
 *
 * 电子构建器的 signAndEditExecutable 设置为 false（为避免触发有缺陷的
 * winCodeSign 下载管道），所以需要在此手动完成图标嵌入。
 */
async function embedIcon(context) {
  const { appOutDir, packager } = context;
  const exeFileName = `${packager.appInfo.productFilename}.exe`;
  const exePath = path.join(appOutDir, exeFileName);
  const iconPath = path.resolve(__dirname, '..', 'public', 'icon.ico');

  if (!fs.existsSync(exePath)) {
    console.log(`[embed-icon] SKIP: ${exePath} not found`);
    return;
  }
  if (!fs.existsSync(iconPath)) {
    console.log(`[embed-icon] SKIP: ${iconPath} not found`);
    return;
  }

  // electron-winstaller 是 @electron-forge/maker-squirrel 的间接依赖，
  // 其中包含 rcedit.exe 工具
  const rceditCandidates = [
    path.resolve(__dirname, '..', 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    path.resolve(__dirname, '..', 'node_modules', '.electron-winstaller-A1tVdjxZ', 'vendor', 'rcedit.exe'),
  ];

  let rceditPath = null;
  for (const candidate of rceditCandidates) {
    if (fs.existsSync(candidate)) {
      rceditPath = candidate;
      break;
    }
  }

  if (!rceditPath) {
    console.log('[embed-icon] SKIP: rcedit.exe not found in node_modules');
    return;
  }

  const { spawnSync } = require('child_process');
  const appInfo = packager.appInfo;
  const versionStr = appInfo.shortVersion || appInfo.buildVersion || '0.0.0';

  // rcedit args: icon + version strings（与 signAndEditResources 一致）
  const args = [
    exePath,
    '--set-icon', iconPath,
    '--set-version-string', 'FileDescription', appInfo.productName,
    '--set-version-string', 'ProductName', appInfo.productName,
    '--set-version-string', 'LegalCopyright', appInfo.copyright || '',
    '--set-file-version', versionStr,
    '--set-product-version', appInfo.getVersionInWeirdWindowsForm(),
  ];

  if (appInfo.companyName) {
    args.push('--set-version-string', 'CompanyName', appInfo.companyName);
  }

  const result = spawnSync(rceditPath, args, {
    stdio: 'pipe',
    timeout: 30000,
  });

  if (result.error) {
    console.log(`[embed-icon] FAILED: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    console.log(`[embed-icon] FAILED (exit ${result.status}): ${stderr || 'unknown error'}`);
    return;
  }

  console.log(`[embed-icon] OK: icon + version strings set (${path.basename(iconPath)})`);
}

/**
 * 递归查找文件
 */
function findFiles(dir, predicate) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  try {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          // 跳过 asar 文件内部
          if (!entry.endsWith('.asar')) {
            results.push(...findFiles(fullPath, predicate));
          }
        } else if (predicate(entry)) {
          results.push(fullPath);
        }
      } catch (e) {
        // 跳过权限错误的文件
      }
    }
  } catch (e) {
    // 跳过权限错误的目录
  }

  return results;
}
