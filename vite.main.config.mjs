import {defineConfig} from 'vite';
import path from 'path';
import fs from 'fs';

let nodeModulesCopied = false;

export default defineConfig({
    define: {
        // 双重保险：只有当 HCLAW_DEV_MODE=true 且有实际 URL 时才使用 dev server
        // 生产构建即使父进程继承了 HCLAW_DEV_SERVER_URL，只要没设 HCLAW_DEV_MODE=true，就始终用 undefined
        'MAIN_WINDOW_VITE_DEV_SERVER_URL': process.env.HCLAW_DEV_MODE === 'true' && process.env.HCLAW_DEV_SERVER_URL
            ? JSON.stringify(process.env.HCLAW_DEV_SERVER_URL)
            : 'undefined',
        'MAIN_WINDOW_VITE_NAME': JSON.stringify('main_window'),
    },
  build: {
      ssr: true,
    outDir: '.vite/main',
      rolldownOptions: {
      input: {
        index: path.resolve(__dirname, 'src/main/index.ts'),
        worker: path.resolve(__dirname, 'src/main/agent/worker.ts'),
          mcpWorker: path.resolve(__dirname, 'src/main/agent/mcpWorker.ts'),
          schedulerWorker: path.resolve(__dirname, 'src/main/scheduler/worker.ts'),
      },
          output: {
              entryFileNames: '[name].js',
              chunkFileNames: '[name].js',
              assetFileNames: '[name][extname]',
          },
      },
  },
    ssr: {
        external: ['electron', '@photostructure/sqlite', 'esbuild'],
        noExternal: true,
  },
    plugins: [
        {
            name: 'fix-electron-esm-interop',
            apply: 'build',
            enforce: 'post',
            generateBundle(_, bundles) {
                for (const [, chunk] of Object.entries(bundles)) {
                    if (chunk.type !== 'chunk') continue
                    // fix #1: electron named imports → default import + destructure
                    // Electron 的 package.json 没有 "exports" 字段，Node ESM 的 CJS 静态分析
                    // 无法可靠检测其具名导出。必须转成: import __el from "electron"; const {X}=__el;
                    chunk.code = chunk.code.replace(
                        /import\s+\{([^}]+)\}\s+from\s+"electron";?/g,
                        (_, exportsList) => {
                            const named = exportsList.split(',').map((s) => s.trim()).filter(Boolean)
                            const bindings = named.map((e => {
                                const [orig, alias] = e.split(/\s+as\s+/).map((s) => s.trim())
                                return alias ? `${alias}: ${orig}` : orig
                            })).join(', ')
                            return `import __el from "electron"; const { ${bindings} } = __el;`
                        },
                    )
                    // fix #2: inject __filename/__dirname for ESM compat
                    if (!chunk.code.includes('__filename') && !chunk.code.includes('__dirname')) continue
                    const firstImportEnd = chunk.code.indexOf('\n', chunk.code.indexOf('import ')) + 1
                    const pathAlias = chunk.code.match(/import\s+\*\s+as\s+(path\$\d+)\s+from\s+"path"/)?.[1] || 'path'
                    const urlToPath = `fileURLToPath(import.meta.url)`
                    chunk.code =
                        chunk.code.slice(0, firstImportEnd) +
                        `import{fileURLToPath}from"url";const __dirname=${pathAlias}.dirname(${urlToPath});const __filename=${urlToPath};\n` +
                        chunk.code.slice(firstImportEnd)
                }
            },
        },
        {
            name: 'copy-sqlite-migrations',
            apply: 'build',
            closeBundle() {
                const srcMigrations = path.join(__dirname, 'src', 'main', 'repositories', 'sqlite', 'migrations');
                const destMigrations = path.join(__dirname, '.vite', 'main', 'repositories', 'sqlite', 'migrations');

                if (fs.existsSync(srcMigrations)) {
                    fs.mkdirSync(destMigrations, {recursive: true});
                    const files = fs.readdirSync(srcMigrations).filter(f => f.endsWith('.sql'));
                    for (const file of files) {
                        fs.copyFileSync(path.join(srcMigrations, file), path.join(destMigrations, file));
                    }
                }
            }
        },
        {
            name: 'copy-native-node-modules',
            apply: 'build',
            closeBundle() {
                if (nodeModulesCopied) return;
                nodeModulesCopied = true;

                const destDir = path.join(__dirname, '.vite', 'node_modules');
                const packages = ['@photostructure/sqlite', 'node-addon-api', 'node-gyp-build', '@larksuiteoapi/node-sdk'];

                for (const pkg of packages) {
                    const src = path.join(__dirname, 'node_modules', pkg);
                    const dest = path.join(destDir, pkg);
                    if (fs.existsSync(src)) {
                        try {
                            if (fs.existsSync(dest)) {
                                fs.rmSync(dest, {recursive: true, force: true});
                            }
                            fs.cpSync(src, dest, {recursive: true});
                            console.log(`[copy-native-modules] Copied ${pkg} to ${dest}`);
                        } catch (err) {
                            console.warn(`[copy-native-modules] Skip ${pkg} (${err.code || err.message})`);
                        }
                    } else {
                        console.warn(`[copy-native-modules] Source not found: ${src}`);
                    }
                }
            }
        },
        {
            name: 'emit-esm-package-json',
            apply: 'build',
            closeBundle() {
                const destDir = path.join(__dirname, '.vite', 'main');
                fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify({type: 'module'}, null, 2));
                console.log('[emit-esm-package-json] Wrote package.json with type=module');
            }
        },
        {
            name: 'bundle-channel-worker',
            apply: 'build',
            async closeBundle() {
                const esbuild = await import('esbuild');
                esbuild.buildSync({
                    entryPoints: ['src/main/channel/worker.ts'],
                    outfile: '.vite/main/channelWorker.cjs',
                    bundle: true,
                    platform: 'node',
                    format: 'cjs',
                    target: 'es2020',
                    // electron、native addon 等必须 external，Worker 线程不需要这些模块
                    // format:cjs 下 esbuild 会生成 require()，CJS 互操作无问题
                    external: [
                        'electron',
                        '@photostructure/sqlite',
                        '@larksuiteoapi/node-sdk',
                        'axios',
                        'form-data',
                        'combined-stream',
                    ],
                    alias: {
                        '@shared': path.resolve(__dirname, 'src/shared'),
                    },
                });
                console.log('[channel-worker] Bundled channelWorker.cjs (CJS format)');
            }
        },
        {
            name: 'bundle-scheduler-agent-worker',
            apply: 'build',
            async closeBundle() {
                const esbuild = await import('esbuild');
                esbuild.buildSync({
                    entryPoints: ['src/main/scheduler/schedulerAgentWorker.ts'],
                    outfile: '.vite/main/schedulerAgentWorker.cjs',
                    bundle: true,
                    platform: 'node',
                    format: 'cjs',
                    target: 'es2020',
                    external: ['electron', '@photostructure/sqlite'],
                    alias: {
                        '@shared': path.resolve(__dirname, 'src/shared'),
                    },
                });
                console.log('[scheduler-agent-worker] Bundled schedulerAgentWorker.js');
            }
        }
    ],
  optimizeDeps: {
      exclude: ['gray-matter'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
      modules: [path.resolve(__dirname, 'src'), 'node_modules'],
  },
});
