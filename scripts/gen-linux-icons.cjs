/**
 * 从 1024x1024 源图生成 Linux 多尺寸图标（hicolor 标准档位）。
 *
 * electron-builder 的 app-builder --format set 模式对单张 png 只产出原图尺寸一条目，
 * 不会自动 resize。Deepin/GNOME 的 hicolor 主题不声明 1024x1024 目录，
 * 导致 deb 安装后图标查找 miss、启动器显示占位图。
 *
 * 解决：提供预 resize 好的多尺寸 png，electron-builder 遍历目录按文件名解析尺寸。
 * 运行：node scripts/gen-linux-icons.cjs（或 npm run gen:linux-icons）
 */
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const SRC = path.join(__dirname, "..", "public", "icon.png");
const OUT_DIR = path.join(__dirname, "..", "build", "icons");

// hicolor 标准档位（不含 1024 — 不在 hicolor index.theme 声明里）
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

fs.mkdirSync(OUT_DIR, { recursive: true });

Promise.all(
  SIZES.map(async (s) => {
    const file = path.join(OUT_DIR, `${s}x${s}.png`);
    await sharp(SRC)
      .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(file);
    const stat = fs.statSync(file);
    console.log(`  ${s}x${s}.png  (${(stat.size / 1024).toFixed(1)} KB)`);
  })
).then(() => console.log("done."));
