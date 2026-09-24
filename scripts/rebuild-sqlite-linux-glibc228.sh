#!/usr/bin/env bash
#
# 重建 @photostructure/sqlite 的 Linux x64 原生模块，产出 glibc 2.28 基线产物。
#
# 背景：该包上游预编译产物在 Debian 11（glibc 2.31）环境构建，要求 GLIBC_2.29 符号。
# 在 deepin v20 / UOS 20 / 麒麟 V10 等 glibc 2.28 系统上，动态链接器会直接报
#   version `GLIBC_2.29' not found (required by .../@photostructure+sqlite.glibc.node)
# 导致主进程启动即崩溃（应用商店审核环境即此类系统）。
# 本脚本在 glibc 2.28 容器内用包内自带源码重建，产物只要求目标系统自带的符号版本。
#
# 用法：bash scripts/rebuild-sqlite-linux-glibc228.sh
# 依赖：docker；工作区已执行 npm ci
# 可选环境变量：
#   SQLITE_BUILD_IMAGE  构建镜像（默认 node:20-buster，Debian 10 => glibc 2.28）
#   NODE_DIST_URL       node-gyp 下载 headers 的源（国内网络可指向镜像站）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_REL="node_modules/@photostructure/sqlite"
TARGET_REL="$PKG_REL/prebuilds/linux-x64/@photostructure+sqlite.glibc.node"
IMAGE="${SQLITE_BUILD_IMAGE:-node:20-buster}"
MAX_GLIBC="2.28"

cd "$ROOT"

if [ ! -f "$TARGET_REL" ]; then
    echo "[sqlite-glibc] 未找到 $TARGET_REL，请先执行 npm ci" >&2
    exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
    echo "[sqlite-glibc] 未找到 docker，无法在 glibc 2.28 环境中构建" >&2
    exit 1
fi

BEFORE="$(grep -aoE 'GLIBC_2\.[0-9]+' "$TARGET_REL" | sort -uV | tail -1)"
echo "[sqlite-glibc] 上游产物最高符号要求：$BEFORE（目标基线 glibc $MAX_GLIBC）"

docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    ${NODE_DIST_URL:+-e NODE_DIST_URL="$NODE_DIST_URL"} \
    -v "$ROOT:/w" \
    -w "/w/$PKG_REL" \
    "$IMAGE" bash -s <<'INNER'
set -euo pipefail
echo "[sqlite-glibc] 构建环境：$(ldd --version | head -1 | cut -d' ' -f1-2) / $(node -v) / $(g++ --version | head -1 | cut -d' ' -f1-2)"

# node-gyp 固定 9.x：10.x 自带的 gyp-next 使用 Python 3.8+ 语法（海象运算符），
# 而 glibc 2.28 基线镜像（Debian 10）自带 Python 3.7，会在 configure 阶段 SyntaxError。
# 9.4.1 同时满足 Node 20 headers 对 node-gyp 的最低版本要求。
npx --yes node-gyp@9.4.1 rebuild ${NODE_DIST_URL:+--dist-url="$NODE_DIST_URL"}

# 用新产物覆盖上游预编译文件，并移除 build/：
# node-gyp-build 优先加载 build/Release，移除后运行时才会落到 prebuilds ——
# 即发布包内唯一携带、也是审核环境实际加载的那份文件。
cp -f build/Release/phstr_sqlite.node prebuilds/linux-x64/@photostructure+sqlite.glibc.node
rm -rf build

cat > /tmp/smoke.js <<'SMOKE'
const { DatabaseSync } = require('/w/node_modules/@photostructure/sqlite');
const db = new DatabaseSync(':memory:');
db.exec('create table t(a)');
db.exec('insert into t values (1)');
db.exec('create virtual table f using fts5(x)');
db.exec("insert into f values ('hello world')");
const rows = db.prepare('select count(*) c from t').get();
const fts = db.prepare("select count(*) c from f where f match 'hello'").get();
const ver = db.prepare('select sqlite_version() v').get();
console.log('[sqlite-glibc] 冒烟通过', JSON.stringify({ rows: rows.c, fts5: fts.c, sqlite: ver.v }));
SMOKE
node /tmp/smoke.js
INNER

AFTER="$(grep -aoE 'GLIBC_2\.[0-9]+' "$TARGET_REL" | sort -uV | tail -1)"
if [ "$(printf '%s\n%s\n' "${AFTER#GLIBC_}" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
    echo "[sqlite-glibc] 断言失败：产物要求 $AFTER，超出目标基线 glibc $MAX_GLIBC" >&2
    exit 1
fi

echo "[sqlite-glibc] 完成：$BEFORE -> $AFTER"
