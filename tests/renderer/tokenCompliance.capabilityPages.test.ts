// tests/renderer/tokenCompliance.capabilityPages.test.ts
/**
 * 令牌合规护栏：能力管理页（Agents / Skills / Plugin / Commands）及其直接渲染的子组件。
 *
 * 为什么平铺在 tests/renderer/ 根？
 *   仓库惯例：跨切面的护栏平铺在根目录（themeTokenSync.test.ts、noNativeDialogs.test.ts、
 *   priceEditing.test.ts 一类）。按关注点新开 token-compliance/ 子目录不成体系，故与它们并列。
 *
 * 为什么是「目录遍历 + 显式拒绝清单」而不是人工枚举文件？
 *   上一版枚举 15 个文件 + 冻结 EXPECTED_FILE_COUNT：新增文件永远不会变红，护栏会随目录
 *   生长而静默腐化。现在改为默认**纳入**——dialogs/ 与 repo/ 下任何新文件都会自动进扫描集，
 *   要么它是干净的，要么有人必须带理由把它写进 EXCLUDED。拒绝清单里不存在的路径会撞上
 *   元测试，无法变成永久豁免。
 *
 * 为什么 EXCLUDED 里有「既存债务」一组？
 *   目录整体尚未收敛（调色板类名、字面值遍布多处），本轮最小变更不动它们。把它们显式
 *   列出（带理由）而不是靠缩小遍历范围来回避，是为了让债务可见、可审计：每修干净一个文件，
 *   就把它从 EXCLUDED 移出，覆盖只增不减。
 *
 * ── GAP 缺口登记表 ──────────────────────────────────────────────
 * 见下方 GAP 常量：每条「写法 / 为何无既有令牌可映射 / 复评触发点」。这些是**已知且接受**
 * 的偏差，不是遗漏——登记的目的是让它们可被复查，而不是让它们隐形。
 */
import {describe, it, expect} from 'vitest'
import {existsSync, readdirSync, readFileSync, statSync} from 'fs'
import {join} from 'path'
// F2：深色主题清单的声明式唯一权威——变体生效断言遍历它，而非写死字面量
import {DARK_THEMES} from '@shared/types/theme'
import {
  BARE_HEX,
  RGB_HSL,
  VAR_FALLBACK,
  VAR_OPACITY,
  canonicalColorMixViolationIn,
  canonicalColorMixViolations,
  colorMixRole,
  darkVariantMisuseIn,
  darkVariantMisuseViolations,
  describeHit,
  isComment,
  NON_LADDER_COLOR_MIX,
  parseColorMix,
  rel,
  scan,
  scanColorMix,
  violations,
  type ColorMixSite,
  type Hit,
} from './helpers/tokenScan'

const ROOT = process.cwd()
const COMPONENTS = 'src/renderer/components'
const DIALOGS = `${COMPONENTS}/dialogs`
const REPO = `${COMPONENTS}/repo`

// ── 扫描范围：目录遍历 ──────────────────────────────────────────

/** 递归列出目录下全部 .ts/.tsx（排除 `*.d.ts` 声明文件，它们不含源码级类名），返回仓库相对路径（/ 分隔、排序稳定）。 */
function walkDir(relDir: string): string[] {
  const abs = join(ROOT, relDir)
  const out: string[] = []
  for (const name of readdirSync(abs)) {
    const full = join(abs, name)
    if (statSync(full).isDirectory()) out.push(...walkDir(rel(full)))
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel(full))
  }
  return out
}

/** dialogs/ 与 repo/ 的全部源文件——默认全部纳入扫描，除非显式拒绝。 */
const TRAVERSED = [...walkDir(DIALOGS), ...walkDir(REPO)].sort()

/**
 * 显式拒绝清单（每项必须带理由字符串）。
 * 拒绝 ≠ 永久豁免：路径不存在会被元测试抓（防过期白名单），且清单外的**新文件默认进扫描集**。
 */
const DEBT_REASON =
  '既存调色板类名/字面值债务，属全仓统一收敛任务范围；本轮最小变更不触及它（修干净后应把它移出本清单）'

const EXCLUDED: Record<string, string> = {
  // ── 范围决策：能力四页之外，用户已决定本轮不扩范围 ──
  [`${DIALOGS}/ChannelsDialog.tsx`]: '用户已决定本轮不扩范围（能力四页之外的对话框）',
  [`${DIALOGS}/MCPDialog.tsx`]: '用户已决定本轮不扩范围（能力四页之外的对话框）',
  [`${DIALOGS}/ChannelIcons.tsx`]: '用户已决定本轮不扩范围（渠道图标资源组件）',
  [`${DIALOGS}/MCPPluginServerCard.tsx`]: '用户已决定本轮不扩范围（MCP 插件服务器卡片）',
  [`${DIALOGS}/ToolsDialog.tsx`]: '用户已决定本轮不扩范围（工具管理对话框）',
  [`${DIALOGS}/SettingsDialog.tsx`]: '用户已决定本轮不扩范围（设置对话框）',
  // ── 既存债务：遍历命中但尚未收敛的文件 ──
  [`${DIALOGS}/ConversationsDialog.tsx`]: DEBT_REASON,
  [`${DIALOGS}/LLMConfigDialog.tsx`]: DEBT_REASON,
  [`${DIALOGS}/MCPEditCard.tsx`]: DEBT_REASON,
  [`${DIALOGS}/MCPErrorHelper.tsx`]: DEBT_REASON,
  [`${DIALOGS}/MCPToolsOverlay.tsx`]: DEBT_REASON,
  [`${DIALOGS}/MCPUserServerCard.tsx`]: DEBT_REASON,
  [`${DIALOGS}/MCPUtils.ts`]: DEBT_REASON,
  [`${DIALOGS}/MCPVersionBadge.tsx`]: DEBT_REASON,
  [`${DIALOGS}/MemoEditDialog.tsx`]: DEBT_REASON,
  [`${DIALOGS}/ModelSchemeDialog.tsx`]: DEBT_REASON,
  [`${DIALOGS}/PhraseDialog.tsx`]: DEBT_REASON,
  [`${DIALOGS}/PromptConfigDialog.tsx`]: DEBT_REASON,
  [`${DIALOGS}/providerEdit/ModelDetailModal.tsx`]: DEBT_REASON,
  [`${DIALOGS}/providerEdit/ModelTable.tsx`]: DEBT_REASON,
  [`${DIALOGS}/ProviderEditModal.tsx`]: DEBT_REASON,
  [`${DIALOGS}/TaskHistoryDialog.tsx`]: DEBT_REASON,
  [`${DIALOGS}/UpdateNoticeDialog.tsx`]: DEBT_REASON,
}

/**
 * 显式加入扫描集的 common 子集（不在 dialogs/repo 树内，故遍历带不出来）。
 * 含其中被扫为 clean 的文件也照常纳入——护栏覆盖只增不减。
 */
const COMMON_SUBSET = [
  'CapabilityCard',
  // ui-09 复核整改：CapabilityPicker 被 ScheduleEditModal（本窗口）直接 import 并渲染，
  // 却在「公共子集」里缺席——上一版的覆盖只在能力四页上成立，调度窗口这一消费面是盲区。
  // 补进扫描集（覆盖只增不减；它此前因 `bg-amber-500/10 text-amber-500` 一类调色板类名
  // 而不可能变绿，故整改与收录必须同一批完成）。
  'CapabilityPicker',
  'StatusBadge',
  'EmptyState',
  'UpdateDot',
  'CopyButton',
  'Modal',
  'Switch',
  'CollapsibleSection',
  'AsyncBoundary',
  'PluginGroupCard',
].map(n => `${COMPONENTS}/common/${n}.tsx`)

/** 两个组件树的公共根组件（被四页直接渲染）。 */
const ROOT_COMPONENTS = [`${COMPONENTS}/ThemedSelect.tsx`, `${COMPONENTS}/ConfirmDialog.tsx`]

/** 最终扫描集（仓库相对路径，去重排序）。 */
const FILES = [
  ...new Set([...TRAVERSED.filter(f => !(f in EXCLUDED)), ...COMMON_SUBSET, ...ROOT_COMPONENTS]),
].sort()

const ABS_FILES = FILES.map(f => join(ROOT, f))

/** 扫描集文件数下界：防「扫了个空目录」式的假绿。 */
const MIN_SCANNED_FILES = 20
/**
 * 全量渲染层扫描集（VAR_OPACITY 规则）远大于能力页子集，但下界用意相同（防遍历静默缩水）；
 * 按倍数从同一常量派生，避免两套硬编码标准各自漂移。
 */
const MIN_ALL_RENDERER_FILES = MIN_SCANNED_FILES * 5

/**
 * 全量渲染层源文件（`src/renderer` 下全部 .ts/.tsx）——VAR_OPACITY 规则的扫描范围。
 * 该规则与「能力四页」的文件清单无关：它对**所有**文件都成立，故按目录全量遍历，
 * 未来任何新文件自动纳入（这正是上一版按文件基线会静默腐化的反面）。
 */
const ALL_RENDERER_FILES = walkDir('src/renderer')
const ABS_ALL_RENDERER = ALL_RENDERER_FILES.map(f => join(ROOT, f))

/**
 * `[var(--x)]/NN` 在 Tailwind 3.4.19 下**零 CSS 产出**：withAlphaVariable 的 parseColor
 * 只认 hex/rgb/hsl，var() 返回 null → 整条 utility 被省略。全仓已统一改写为
 * `[color-mix(in_srgb,var(--x)_NN%,transparent)]`（加深语义用 `_85%,black`），实测可编译。
 * 故此处强制 0（不再有「按文件冻结基线」）。
 * 复评触发点 = 升级 Tailwind v4（届时任意色值的 `/NN` 重新可用，本规则可放宽）。
 */
const VAR_OPACITY_ALLOWED = 0

// ── alpha 阶梯（color-mix 档位白名单）────────────────────────────
/**
 * 背景：Tailwind 3.4 无法对 var() 套 `/NN`，全仓改用
 * `[color-mix(in_srgb,var(--x)_NN%,transparent)]`（实底 hover 加深用 `_NN%,black`）。
 * 改写后 alpha 以字面量散落在各处，若无护栏必然再次漂移——本表把 spec §3 的目标阶梯
 * 固化为可执行约束：**同一 alpha 在不同属性上视觉强度不同，故按「角色」定义，而非单一数值轴**。
 *
 * 每条规则 = (role, alphas, form[, tokens])，中文注释说明其语义。role 由 colorMixRole() 机械判定。
 * 关键设计：单例独立角色**必须带 token 约束**（如 `bg 40%` 只允许 `--text-muted`），
 * 以免把白名单悄悄放宽成「整个角色都能用这个档位」——那是把护栏退化成橡皮图章。
 */
interface AlphaRule {
  /** 角色（colorMixRole 的返回值） */
  role: string
  /** 允许的 alpha 档位 */
  alphas: number[]
  /** 混合目标（默认 transparent=淡化；black=实底加深） */
  form?: 'transparent' | 'black'
  /** 令牌约束（仅单例独立角色使用，防止档位外溢到整个角色） */
  tokens?: string[]
  /** 中文语义注记（便于日后复评） */
  note: string
}

const ALPHA_LADDER: AlphaRule[] = [
  // ── 填充档 bg：静息底阶梯（spec §3.1，现状即目标）──
  {role: 'bg', alphas: [5], note: 'wash-subtle：装饰光晕 / 内联 code 底 / 提示面板底'},
  {role: 'bg', alphas: [10], note: 'wash：静息淡底（默认档）'},
  {role: 'bg', alphas: [15], note: 'wash-selected：选中项底（下拉/选项/行选中）'},
  {role: 'bg', alphas: [20], note: 'wash-strong：强底，也是「hover on wash」的下一档'},
  {role: 'bg', alphas: [30], note: 'wash-emph：强调条（拖拽把手等）'},
  {role: 'bg', alphas: [92], note: 'overlay-glass：毛玻璃浮层底（配 backdrop-blur）'},
  {
    role: 'bg',
    alphas: [40],
    tokens: ['text-muted'],
    note: '独立角色·时间轴静息圆点（2 处同族）：4px 节点圆点的「未运行」填充，是 marker 而非容器底，与 wash 系列语义不同，故单列并限定 --text-muted',
  },
  {
    role: 'bg',
    alphas: [50],
    tokens: ['surface-muted'],
    note: '独立角色·中性表头条/分组条底（同族多处，不写死计数以免漂移）：比 wash 更实的中性底，靠 --surface-muted 而非品牌色，语义是「结构性分区底」，故单列并限定 --surface-muted',
  },

  // ── 交互档 hover:bg（spec §3.2，现状即目标）──
  {role: 'hover:bg', alphas: [10], note: 'hover on 透明静息（ghost 图标按钮 / 菜单项）'},
  {role: 'hover:bg', alphas: [20], note: 'hover on 10% wash 静息（已着色 chip/徽章）'},
  {role: 'hover:bg', alphas: [85], form: 'black', note: '实底 hover 加深：85% + black（必须 black，transparent 会变淡而非加深）'},
  {
    role: 'hover:bg',
    alphas: [30],
    tokens: ['brand-primary'],
    note: '独立角色·列分隔拖拽把手的 hover 高亮（UsageWindow:534）：1 处；是「可拖拽列边界」的交互提示，非通用 hover 底',
  },
  {
    role: 'hover:bg',
    alphas: [40],
    tokens: ['surface-muted'],
    note: '独立角色·设置行 hover 底（ShortcutRow:70）：1 处；token 为 --surface-muted 而非品牌色，来源是中性行高亮',
  },
  {
    role: 'hover:bg',
    alphas: [60],
    tokens: ['border'],
    note: '独立角色·行高拖拽把手的 hover 高亮（LlmLogsWindow:427）：1 处；token 为 --border，是结构性把手的交互提示',
  },

  // ── 边框档（spec §3.3，归位到 3 档）──
  // 注：`focus:border` 的 color-mix 档位**已整体退役**（原 50% 单档）。焦点边框已收敛到
  // src/renderer/lib/inputFocus.ts 的 INPUT_FOCUS（`focus:border-[var(--border-emphasis)]`，
  // 纯令牌、不经 color-mix），全仓零 color-mix 站点 → 不再登记任何档位，
  // 任何 `focus:border-[color-mix(...)]` 一律判违规（由下方 ALPHA_LADDER 自洽用例看守）。
  {role: 'border', alphas: [20], note: 'edge：常规/静息边框（同时是状态边框的默认档）'},
  {role: 'border', alphas: [30], note: 'edge-hover：选中 chip 边框与 spinner 环轨等次要边框（spec §5）'},
  {role: 'border', alphas: [45], note: 'edge-strong：状态/校验边框（error / success）'},
  {
    role: 'border',
    alphas: [10],
    tokens: ['brand-primary'],
    note: '独立角色·极淡提示面板边框（PermissionRulesPanel:182）：1 处；spec §5 明示「10% 为极淡面板边框」，与 edge 20% 不同档',
  },
  {role: 'hover:border', alphas: [30], note: 'hover 边框：统一到 30%（spec §3.3；全仓 6 处站点均为 30，与静态 edge-hover 同档）'},

  // ── 焦点环档（spec §3.4，归位到 2 档；暗色主题单列更低档）──
  {role: 'ring.light', alphas: [30, 50], note: '焦点环·浅色：30=常规焦点环（focus/ring/focus-visible/focus-within），50=强调焦点环（大控件/卡片级可聚焦项）'},
  {role: 'ring.dark', alphas: [20, 30], note: '焦点环·暗色（dark-all:，覆盖 .dark 与 .yuanshandai）：同一 alpha 在暗色下视觉更亮，故整体降一档（常规 20 / 强调 30）'},

  // ── 文字档（spec §3.5，归位到 3 档）──
  {role: 'text', alphas: [50, 70, 80], note: 'ink：50=禁用/不可用文字，70=次级品牌文字，80=hover 文字'},
  {role: 'hover:text', alphas: [80], note: 'hover 文字：统一到 80%（全仓 5 处站点均为 80）'},
  {role: 'marker:text', alphas: [70], note: '列表标记符：统一到 70%（全仓 2 处站点均为 70）'},

  // ── 单例档（spec §5 明确「保持现状」）──
  {
    role: 'decoration',
    alphas: [60],
    tokens: ['error'],
    note: '独立角色·删除线（AgentsDialog:250 禁停工具标签的 line-through 颜色）：1 处，spec §5 明示保持现状',
  },
  {
    role: 'to',
    alphas: [60],
    tokens: ['brand-primary'],
    note: '独立角色·渐变色标终点（MessageBubble:270 品牌图标底部的 to-）：1 处，spec §5 明示保持现状',
  },
]

/** 角色中文名（违规信息用） */
const ROLE_LABEL: Record<string, string> = {
  bg: '填充',
  'hover:bg': '悬停填充',
  border: '边框',
  'hover:border': '悬停边框',
  'focus:border': '焦点边框',
  'ring.light': '焦点环',
  'ring.dark': '焦点环（暗色主题）',
  text: '文字',
  'hover:text': '悬停文字',
  'marker:text': '列表标记符',
  decoration: '删除线',
  to: '渐变终点',
}

/** 某角色登记的全部 alpha 档（用于违规信息里的「允许 x/y」） */
function allowedAlphas(role: string): number[] {
  const set = new Set<number>()
  for (const r of ALPHA_LADDER) if (r.role === role) for (const a of r.alphas) set.add(a)
  return [...set].sort((a, b) => a - b)
}

/** 命中白名单则返回 true。token 约束与 form 都必须满足。 */
function isAllowed(site: ColorMixSite): boolean {
  const role = colorMixRole(site)
  const form = site.target
  return ALPHA_LADDER.some(
    r =>
      r.role === role &&
      r.alphas.includes(site.alpha) &&
      (r.form ?? 'transparent') === form &&
      (!r.tokens || r.tokens.includes(site.token)),
  )
}

/** 判定单个站点：合规返回 null，违规返回可读信息。 */
function colorMixViolation(site: ColorMixSite): string | null {
  if (isAllowed(site)) return null
  const role = colorMixRole(site)
  const label = ROLE_LABEL[role] ?? role
  // 若「角色+alpha」存在但 form/token 不合：给出更精确的提示（如 85% 只许 black）
  const sameAlpha = ALPHA_LADDER.filter(r => r.role === role && r.alphas.includes(site.alpha))
  const detail =
    sameAlpha.length > 0
      ? `该档位仅允许 ${sameAlpha
          .map(r => `${r.form ?? 'transparent'}${r.tokens ? `@${r.tokens.join('/')}` : ''}`)
          .join(' 或 ')}`
      : `允许 ${allowedAlphas(role).join('/') || '无（该角色未登记）'}`
  const form = site.target
  return `${site.file}:${site.line}: 角色=${label} alpha=${site.alpha}%（${detail}，当前 form=${form}${site.token ? `，token=--${site.token}` : ''}）: ${site.text.trim()}`
}

/** 扫描文件集的 color-mix 站点并返回全部违规（排除整行注释）。 */
function colorMixViolations(files: readonly string[]): string[] {
  return scanColorMix(files)
    .filter(s => !isComment(s))
    .map(colorMixViolation)
    .filter((v): v is string => v !== null)
}

/**
 * color-mix 站点数下界：防「扫描器坏掉/遍历缩水」式的假绿。
 *
 * 计数口径（此前两位复核者报出 222 vs 189，差异来自口径，不是扫描结果不一致）：
 *   - **222** = `COLOR_MIX` 正则的**匹配数（站点数）**：同一行出现多个 color-mix 会各计一次。
 *   - **~188/189** = **含 `color-mix(` 的行数**（一行多站点只计一行）；实测 188，与 189 差 1，
 *     差异来自是否把注释行 / `src/renderer` 之外的文件算进去，不影响下界。
 *   本下界以**站点数**为准（222 为实测）。
 * 下界 = 实测值 − 余量：222 − 22 = 200。余量用于容忍重构（合并/删除少量站点），
 * 但不足以容忍「扫描器坏了」式的塌缩。
 */
const MIN_COLOR_MIX_SITES = 200

// ── 反模式定义（与 project-manager 护栏同源，见 helpers/tokenScan）──

/**
 * Tailwind 调色板类名（含变体前缀、`!`、透明度后缀、数字梯度）。
 * 前缀覆盖 `shadow`/`drop-shadow`（阴影颜色也是颜色）与方向性边框 `border-[trblxy]`、
 * `divide-[xy]`（`border-l-red-500` 这类变体不能漏）。
 * 变体前缀含 `dark-all`（深色主题变体，见 tailwind.config）：不写进表就只能靠「前缀段可空」
 * 的偶然性命中（`dark-all:bg-red-500` 会被当作以 `all:bg-red-500` 匹配），属脆弱，故显式列出。
 *
 * 起始负向后顾 `(?<![\w-])`：本正则要抓的是 **Tailwind 调色板类名**，不是长令牌名里的字面子串。
 * 令牌集中有 `--text-brand`（C7 授权的**文字级**令牌，见 `scripts/audit-contrast.mjs:49`），
 * 其写法 `text-[var(--text-brand)]` 内含字面子串 `text-brand` → 旧版会误判成调色板类名 `text-brand`。
 * 而真正要抓的 `var(--brand-primary)` 恰好**不**命中（`brand-primary` 不满足 `(?:-\d{2,3})?`），
 * 即旧版「假阳性 + 假阴性」同时存在。负向后顾要求匹配起点前不得是词字符或 `-`，
 * 于是 `--text-brand` 里的 `text-brand`（前一位是 `-`）不再命中，裸类名（前一位是引号/空格/`:`）照抓。
 * 回归断言见 `paletteViolations` 的自检用例。
 */
const PALETTE =
  /(?<![\w-])(?:(?:hover|focus|focus-visible|active|disabled|group-hover|group-focus|dark-all|dark|sm|md|lg|xl):)*!?(?:bg|text|border|border-[trblxy]|divide|divide-[xy]|ring|ring-offset|outline|fill|stroke|placeholder|from|via|to|accent|decoration|caret|shadow|drop-shadow)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|brand)(?:-\d{2,3})?(?:\/\d{1,3})?\b/g

// ── 豁免机制（谓词数组 + 理由，逐 token 判定，不设整文件白名单）──────

/** 品牌/语义实底的 bg 令牌（白字压在其上才可豁免）。含 --brand-ink*：设计系统规定的承白字实底。 */
const BRAND_BG = /bg-\[var\(--(?:brand-primary|brand-ink|brand-ink-hover|error|warning|success)\)\]/
/** 阴影颜色 token（`shadow-black/20` 一类；仓库实测只出现 black/white，其它色相照抓） */
const SHADOW_COLOR =
  /^(?:[a-z-]+:)*shadow-(?:black|white)(?:-\d{2,3})?(?:\/\d{1,3})?$/

/**
 * 判定单个调色板 token 是否可豁免。返回豁免理由（字符串）或 null（= 违规）。
 * 每个谓词都写明「为何无既有令牌可映射」，且判定范围是**同一行**——不做全局放行。
 * 注意：同行共现 ≠ 同一元素，这是可接受的近似（见 GAP）。
 */
function exemptReason(token: string, line: string): string | null {
  // 豁免 1：品牌/语义实底上的白字。
  // 无 on-brand 前景令牌可用：--text-inverse 在深色主题下本身就是深色，
  // 压在实底上会失去对比，不能替代 text-white。故只在同一行同时出现
  // 品牌/语义 bg 实底（含 --brand-ink*）时放行；单独出现的 text-white 照抓。
  if (/(?:^|:)text-white$/.test(token) && BRAND_BG.test(line)) {
    return '白字压在品牌/语义实底（--brand-primary/--brand-ink/--error/--warning/--success）上，无 on-brand 前景令牌可映射'
  }
  // 豁免 2：模态遮罩。
  // 无匹配既有令牌：半透明黑遮罩需要一个「overlay scrim」语义令牌，现有令牌集里没有，
  // 且新增令牌会牵动四处同步（globals.css ↔ 3 个 HTML 内联表 ↔ ROOT_CSS_VARS）。
  // 放宽为「同行含 inset-0 且含 bg-black/40|50」——仓库里 Modal.tsx 的写法是
  // `absolute inset-0 bg-black/50`（fixed 在父级），同样是合法 scrim，不能因少了 fixed 就漏判。
  if (
    /^(?:[a-z-]+:)*bg-black\/(?:40|50)$/.test(token) &&
    /\binset-0\b/.test(line) &&
    /\bbg-black\/(?:40|50)\b/.test(line)
  ) {
    return '模态遮罩固定层（inset-0 + bg-black/40|50，fixed 可以在父级），无 overlay scrim 令牌可映射'
  }
  // 豁免 3：阴影颜色。
  // 仓库无阴影**颜色**令牌——`--shadow-*` 是整条 box-shadow（含偏移/模糊/颜色），
  // 无法拆出一个颜色来喂给 `shadow-<color>`。见 GAP 表。
  if (SHADOW_COLOR.test(token)) {
    return '阴影颜色类（如 shadow-black/20）：仓库无阴影颜色令牌，--shadow-* 是整条 shadow，不可映射'
  }
  // 豁免 4：Switch 加载态 spinner。
  // loading 时 spinner 恒白，压在其父级 button 的实底上；同行没有 bg 类是因为 bg 在父元素，
  // 不是「白字悬空」。用 token+animate-spin 的谓词精确放行，不做整文件白名单。
  if (/(?:^|:)text-white$/.test(token) && /\banimate-spin\b/.test(line)) {
    return '加载态 spinner 恒白，实底在父级 button 上（同行无 bg 类，属可接受近似）'
  }
  // 豁免 5：Switch 滑块。
  // 开关滑块必须恒白：--surface/--text-inverse 在暗色主题下是深色，替代后滑块会「消失」。
  // 谓词要求同行同时出现 `rounded-full` 与独立的 `transform` 类，锁定圆形滑块语义。
  if (/(?:^|:)bg-white$/.test(token) && /\brounded-full\b/.test(line) && /(?:^|\s)transform(?:\s|$)/.test(line)) {
    return '开关滑块恒白（须在暗色主题下仍为白），--surface/--text-inverse 暗色下为深色，不可替代'
  }
  return null
}

/**
 * 逐 token 判定一行里的 PALETTE 命中：豁免的 token 剔除，剩下的构成违规。
 * 返回违规 token 列表（空数组 = 该行合规）。
 */
function paletteViolations(line: string): string[] {
  PALETTE.lastIndex = 0
  const tokens = line.match(PALETTE) ?? []
  const bad: string[] = []
  for (const token of tokens) {
    if (exemptReason(token, line) === null) bad.push(token)
  }
  return bad
}

/** 扫描整个扫描集的调色板违规，返回 `file:line: [tokens] 原文` */
function scanPalette(): string[] {
  const out: string[] = []
  for (const file of ABS_FILES) {
    readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
      const h: Hit = {file: rel(file), line: i + 1, text: line}
      if (isComment(h)) return
      const bad = paletteViolations(line)
      if (bad.length > 0) out.push(`${h.file}:${i + 1}: [${bad.join(', ')}] ${line.trim()}`)
    })
  }
  return out
}

// ── 缺口登记表 ─────────────────────────────────────────────────

interface Gap {
  /** 写法 */
  pattern: string
  /** 为何无既有令牌可映射 */
  why: string
  /** 复评触发点 */
  revisit: string
}

/** 已知且接受的偏差。结构由下方 it() 断言，内容随测试输出可见。 */
export const GAP: Gap[] = [
  {
    pattern: 'bg-black/40 | bg-black/50（模态遮罩）',
    why: '无 overlay/scrim 语义令牌；新增需同步 globals.css 与 3 处 HTML 内联变量表',
    revisit: '设计系统引入 --overlay-scrim 并在四主题定义时',
  },
  {
    pattern: 'common/Switch.tsx:43 滑块 bg-white',
    why: '--surface / --text-inverse 在暗色主题下是深色，替代后白色滑块会消失；恒白是滑块语义',
    revisit: '设计系统引入 knob / on-brand-surface 专用令牌时',
  },
  {
    pattern: 'shadow-black/20（ThemedSelect.tsx:163 等全仓 8 处）',
    why: '仓库无阴影**颜色**令牌：--shadow-* 是整条 box-shadow，不能拆出颜色喂给 shadow-<color>',
    revisit: 'Tailwind shadow-color 令牌化，或设计系统引入 --shadow-color 时',
  },
  {
    pattern: 'components/ThemedCombobox.tsx:138（border-gray-200 hover:border-gray-300 focus:border-brand-300）',
    why: 'ThemedSelect 同族控件，但本轮范围外未收敛；已收敛的 ThemedSelect 与它形成已知分叉',
    revisit: 'ThemedSelect 收敛任务复评、或下一轮把 ThemedCombobox 纳入扫描集时',
  },
  {
    pattern:
      "dialogs/ToolsDialog.tsx:288 inline style borderColor: 'color-mix(in srgb, var(--warning) 20%, transparent)'",
    why:
      '这是 JS 对象里的 CSS 值（真实空格、非 Tailwind 类），任何基于 className / 任意值 `[...]` 的护栏都覆盖不到；' +
      '该文件本轮在 EXCLUDED（用户已决定不扩范围）。',
    revisit: 'ToolsDialog 纳入扫描集、或引入「内联 style 里的 color-mix」专用正则护栏时',
  },
  {
    pattern: 'className 之外的 color-mix（非 Tailwind 任意值上下文，如 style={{...}} 字符串）',
    why:
      '护栏只解析 `[ ... color-mix(...) ]` 任意值。注意：嵌套在**更大任意值内部**的写法' +
      '（如 shadow-[...color-mix(...)...]）**已由 F2 形态白名单拦下**（外层任意值非规范形态即违规），' +
      '故这里只登记真正无 className 可依赖的残余盲区。',
    revisit: '出现 className 之外、又需要强制规范的 color-mix 用法，或需要扫描 style={{...}} 时',
  },
  {
    pattern: 'COLOR_MIX_ARBITRARY 的 `[^[\\]]*` 无法跨越同一任意值内的另一对 `[]`',
    why:
      'F2 形态白名单用 `[^[\\]]*` 界定「任意值内」，若同一任意值再嵌一对 `[]`，该构造会整体漏出（既不被识别为 color-mix、也不被判违规）。' +
      '此写法在 Tailwind 里极罕见，故登记为已知残余盲区，而非放宽扫描器为括号配对。',
    revisit: '出现 Tailwind 任意值内嵌方括号的真实站点、或需要稳健解析任意值边界时（改用括号配对扫描）',
  },
  {
    pattern: 'CSS 转义标识符（`ring-[\\43OLOR-MIX(...)]`、`ring-[co\\6cor-mix(...)]`）',
    why:
      'Tailwind 把任意值原样产出，浏览器按 CSS 转义规范解析出有效 `color-mix`，而扫描器全盲' +
      '（正则按字面 `color-mix` 匹配，转义形态不命中）。诚实写明：**这是刻意书写才能构造的形态**' +
      '（无人会「不小心」写出 `\\43OLOR`），护栏的防御目标是**事故性漂移**，而非对抗性规避；' +
      '与 `style={{}}` 内联 color-mix 同属「已知且接受」的作用域外盲区。',
    revisit: '真实代码里出现 CSS 转义标识符，或护栏升级为对抗性校验时',
  },
  {
    pattern: '嵌套方括号变体（`[&[data-x].dark]:ring-[...]`）',
    why:
      'CLASS_COLOR_MIX 的变体段用 `\\[[^\\]\\s]+\\]` 界定，不跨内层 `]`；故 `[&[data-x].dark]:ring-[...]`' +
      ' 的变体链会在内层 `]` 处断裂，漏掉其中的内建 `.dark`。若该站点形态规范 + α 合法，则**静默通过**' +
      '（F4 漏判，且暗色降档在远山黛失效）。属已知残余盲区。',
    revisit: '出现真实嵌套方括号变体，或 Tailwind 改变任意变体语法时',
  },
]

// ── 测试 ──────────────────────────────────────────────────────

describe('令牌合规：能力管理页及子组件', () => {
  it('范围自洽：每个遍历到的文件都在「扫描集 or EXCLUDED」中，且两者不相交', () => {
    // 新增文件默认进扫描集 → 要么干净、要么必须有人带理由把它写进 EXCLUDED。没有第三种可能。
    const covered = new Set([...FILES, ...Object.keys(EXCLUDED)])
    const orphans = TRAVERSED.filter(f => !covered.has(f))
    expect(
      orphans,
      `以下文件既未被扫描也未被显式拒绝——新增文件必须有人做决定（修干净或带理由进 EXCLUDED）:\n${orphans.join('\n')}`,
    ).toEqual([])

    const overlap = FILES.filter(f => f in EXCLUDED)
    expect(overlap, `以下文件同时出现在扫描集与 EXCLUDED（语义冲突）:\n${overlap.join('\n')}`).toEqual([])
  })

  it('EXCLUDED 每项都真实存在（防过期白名单变成永久豁免）', () => {
    const ghosts = Object.keys(EXCLUDED).filter(f => !existsSync(join(ROOT, f)))
    expect(ghosts, `EXCLUDED 里列了不存在的文件（路径写错或文件已删/改名）:\n${ghosts.join('\n')}`).toEqual([])
    const blank = Object.entries(EXCLUDED).filter(([, reason]) => !reason || reason.trim().length < 5)
    expect(blank, `EXCLUDED 条目缺理由（拒绝必须有据可查）:\n${blank.map(([f]) => f).join('\n')}`).toEqual([])
  })

  it('扫描集不空且达到下界（防扫空目录假绿）', () => {
    expect(FILES.filter(f => !existsSync(join(ROOT, f))), '扫描集含不存在的文件').toEqual([])
    expect(
      FILES.length,
      `扫描集只有 ${FILES.length} 个文件，低于下界 ${MIN_SCANNED_FILES}——遍历是不是坏了？`,
    ).toBeGreaterThanOrEqual(MIN_SCANNED_FILES)
  })

  it('禁止 `var(--x, #hex)` / `var(--x, rgb(...))` 兜底写法', () => {
    const hits = violations(ABS_FILES, VAR_FALLBACK)
    expect(hits, `发现带字面值兜底的 var() 用法:\n${hits.join('\n')}`).toEqual([])
  })

  it('禁止裸 hex 颜色字面值', () => {
    const hits = violations(ABS_FILES, BARE_HEX)
    expect(hits, `发现裸 hex 字面值:\n${hits.join('\n')}`).toEqual([])
  })

  it('禁止 rgb()/rgba()/hsl()/hsla() 字面值', () => {
    const hits = violations(ABS_FILES, RGB_HSL)
    expect(hits, `发现函数式颜色字面值:\n${hits.join('\n')}`).toEqual([])
  })

  it('禁止 Tailwind 调色板类名（brand/gray/red/orange/... 数字梯度不是令牌）', () => {
    const hits = scanPalette()
    expect(hits, `发现调色板类名（应改用 var(--token)）:\n${hits.join('\n')}`).toEqual([])
  })

  it('PALETTE 既不误伤 var(--token) 引用，也不放过裸调色板类名', () => {
    // 令牌引用不是类名：`--text-brand` 是 C7 授权的文字级令牌（audit-contrast.mjs:49），
    // 其类名写法 text-[var(--text-brand)] 内含子串 text-brand，旧版正则会误判。
    expect(
      paletteViolations('className="text-[var(--text-brand)]"'),
      'var(--text-brand) 引用被误判为调色板类名（PALETTE 假阳性回归）',
    ).toEqual([])
    expect(paletteViolations('hover:[color:var(--text-brand)]')).toEqual([])
    // 反向：真正的裸调色板类名必须照抓（含变体前缀与数字梯度）。
    expect(paletteViolations('className="text-brand"')).toEqual(['text-brand'])
    expect(paletteViolations('className="hover:bg-red-500"')).toEqual(['hover:bg-red-500'])
    expect(paletteViolations('className="dark-all:text-blue-300"')).toEqual(['dark-all:text-blue-300'])
  })
})

/**
 * 全仓 renderer 通用规则：与「能力四页」的文件清单无关，对 `src/renderer` 下**所有**文件成立。
 * 独立成 describe 是刻意的——它不属于能力页范围，混在能力页 describe 里会误导读者以为作用域相同。
 */
describe('令牌合规：全仓 renderer 通用规则', () => {
  it(`全量 src/renderer 禁止 var()+不透明度死类（命中数必须为 ${VAR_OPACITY_ALLOWED}）`, () => {
    // 与文件清单无关的独立规则：该写法在 Tailwind 3.4 下零 CSS 产出，
    // 统一改用 `[color-mix(in_srgb,var(--x)_NN%,transparent)]`（加深语义用 `_85%,black`）。
    // 见文件头 VAR_OPACITY_ALLOWED 的注释与 helpers/tokenScan 的 VAR_OPACITY 定义。
    expect(
      ALL_RENDERER_FILES.length,
      `全量渲染层扫描集只扫到 ${ALL_RENDERER_FILES.length} 个文件，低于下界 ${MIN_ALL_RENDERER_FILES}——遍历是不是坏了？`,
    ).toBeGreaterThanOrEqual(MIN_ALL_RENDERER_FILES)
    const hits = scan(ABS_ALL_RENDERER, VAR_OPACITY).filter(h => !isComment(h))
    expect(
      hits.map(describeHit),
      '发现 var()+不透明度死类（Tailwind 3.4 下零产出）。' +
        '改用 `[color-mix(in_srgb,var(--x)_NN%,transparent)]`；若语义是 hover 加深，用 `[color-mix(in_srgb,var(--x)_85%,black)]`。',
    ).toHaveLength(VAR_OPACITY_ALLOWED)
  })
})

/**
 * 全仓 renderer 通用规则：`color-mix` 的 alpha 档位必须落在「角色白名单」(ALPHA_LADDER) 内。
 * 扫描范围与 VAR_OPACITY 同域（全量 src/renderer）——归位站点横跨多个目录，不限于能力页子集。
 * 独立成 describe 的理由同 VAR_OPACITY：它对所有文件成立，作用域与能力四页无关。
 */
describe('令牌合规：全仓 renderer 通用规则 · alpha 阶梯', () => {
  it('color-mix 的 alpha 档位必须落在角色白名单内', () => {
    expect(
      ALL_RENDERER_FILES.length,
      `全量渲染层扫描集只扫到 ${ALL_RENDERER_FILES.length} 个文件，低于下界 ${MIN_ALL_RENDERER_FILES}——遍历是不是坏了？`,
    ).toBeGreaterThanOrEqual(MIN_ALL_RENDERER_FILES)

    const sites = scanColorMix(ABS_ALL_RENDERER).filter(s => !isComment(s))
    console.log(`\n[alpha-ladder] 全仓 color-mix 站点数（COLOR_MIX 匹配数，实测）= ${sites.length}`)
    expect(
      sites.length,
      `全仓只扫到 ${sites.length} 处 color-mix 站点，低于下界 ${MIN_COLOR_MIX_SITES}——扫描器是不是坏了？`,
    ).toBeGreaterThanOrEqual(MIN_COLOR_MIX_SITES)

    const bad = colorMixViolations(ABS_ALL_RENDERER)
    expect(
      bad,
      'color-mix 的 alpha 档位超出角色白名单（ALPHA_LADDER）：' +
        '请确认是既有语义角色，否则归位到 spec §3 的阶梯，不要随手放宽白名单。\n' +
        bad.join('\n'),
    ).toEqual([])
  })

  it('color-mix 形态必须严格规范（不认识的形态 = 违规，而非忽略）', () => {
    // 覆盖 Verification 实测的三种绕过：in_SRGB（颜色空间大小写）、in_oklab（非 srgb 色彩空间）、
    // var(--x,#hex)（带 fallback）；以及 `45 %` 这类**非法百分比**（浏览器会静默丢弃声明）。
    // 这些写法 Tailwind 都能编译出有效 CSS，却逃过一切基于「规范形态」的规则——故反向白名单。
    const bad = canonicalColorMixViolations(ABS_ALL_RENDERER)
    expect(
      bad,
      '发现非规范 color-mix 形态（含嵌套在更大任意值内部者）。' +
        '只允许 `[color-mix(in_srgb,var(--token)_<整数>%,transparent|black)]`：\n' +
        bad.join('\n'),
    ).toEqual([])
  })

  it('深色降档必须用 dark-all:，不得用内建 dark:', () => {
    // 内建 dark: 只命中 .dark，不命中 .yuanshandai：ring/border 的深色降档若用 dark:，
    // 会让远山黛停在浅色档（真漂移、零报警）。
    const bad = darkVariantMisuseViolations(ABS_ALL_RENDERER)
    expect(
      bad,
      'ring/border 的 color-mix 站点用了内建 dark:/[&.dark]:（只命中 .dark，远山黛会漂移）。' +
        '深色主题请改用 dark-all:：\n' +
        bad.join('\n'),
    ).toEqual([])
  })

  it('ALPHA_LADDER 自洽：每条规则都必须被 ≥1 个真实站点命中', () => {
    // 防止白名单随时间膨胀成橡皮图章：每条留下的档位都必须有真实站点撑着。
    // **无条件**成立——不存在「预留」「文档登记」这类例外通道（上一轮的 reserved 双向语义
    // 会让诊断路径漏过滤它，直接说谎；本轮彻底删除，改回硬约束）。
    const sites = scanColorMix(ABS_ALL_RENDERER).filter(s => !isComment(s))
    const unmatched = ALPHA_LADDER.filter(r => {
      const hits = sites.filter(
        s =>
          colorMixRole(s) === r.role &&
          r.alphas.includes(s.alpha) &&
          (r.form ?? 'transparent') === s.target &&
          (!r.tokens || r.tokens.includes(s.token)),
      )
      return hits.length === 0
    }).map(r => `${r.role} @${r.alphas.join('/')}${r.form ? ` ${r.form}` : ''}${r.tokens ? ` @${r.tokens.join('/')}` : ''}`)
    expect(
      unmatched,
      '以下白名单规则零站点——要么删掉，要么（若确为有意预留）为其找到真实站点：\n' + unmatched.join('\n'),
    ).toEqual([])
  })
})

/**
 * dark-all 变体「真的生效」断言（Code Reviewer M3）。
 * 护栏此前只解析 className 里的数字，**不校验 dark-all 是否已在 Tailwind 注册、是否真产出 CSS**：
 * 若日后有人改名/打错字，8 处类名会静默退化为 no-op，而所有护栏照绿。
 * 仓里已有 themeTokenSync.test.ts 守令牌四处同步，变体却无等价守护——本用例补上。
 */
describe('令牌合规：dark-all 变体生效断言（防静默退化）', () => {
  it('tailwind.config 注册 dark-all，且为 DARK_THEMES 里每个深色主题编译出对应选择器', async () => {
    // 选择「真实编译 + 产物断言」而非「require 配置断言 addVariant 字符串」：
    // 后者只证明「配置里写了这个字符串」，变体名改错 / 选择器少写 .yuanshandai 仍可能骗过它；
    // 前者跑的是与生产同一套 Tailwind 编译器 + 同一份 tailwind.config.js，能把
    // 「变体未注册/已改名/选择器漏掉某个深色主题 ⇒ 深色降档失效」变成编译级红灯。
    //
    // F2：断言**不写死字面量**，而是遍历声明式权威 `DARK_THEMES`（@shared/types/theme）。
    // 若有人只改了 theme.ts 的 DARK_THEMES、漏改 tailwind.config.js 的 addVariant 选择器列表，
    // 新增主题在产物里缺少对应选择器 → 本用例变红（见下方 in-memory 红绿灯验证）。
    const postcss = (await import('postcss')).default
    const tailwindcss = (await import('tailwindcss')).default
    const {createRequire} = await import('module')
    const requireCfg = createRequire(import.meta.url)
    const config = requireCfg('../../tailwind.config.js')
    const probe = 'dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]'
    const result = await postcss([
      tailwindcss({...config, content: [{raw: `<div class="${probe}"></div>`, extension: 'html'}]}),
    ]).process('@tailwind utilities;', {from: undefined})
    const css = result.css
    expect(DARK_THEMES.length, 'DARK_THEMES 至少应含一套深色主题').toBeGreaterThanOrEqual(2)
    for (const t of DARK_THEMES) {
      expect(
        css,
        `dark-all 选择器不含 .${t}：该深色主题的深色降档已失效（产物中缺失 \`.${t} .dark-all\\:focus-visible\\:ring\`）`,
      ).toContain(`.${t} .dark-all\\:focus-visible\\:ring`)
    }
  })
})

describe('令牌合规：缺口登记表（GAP）', () => {
  it('GAP 结构完整（每条都有写法/原因/复评触发点）', () => {
    // 原 5 条：`[var(--x)]/NN` 一条已由全仓 color-mix 统一任务消解（见 VAR_OPACITY_ALLOWED），故下界为 4。
    expect(GAP.length).toBeGreaterThanOrEqual(4)
    for (const g of GAP) {
      expect(g.pattern, 'GAP.pattern 不能为空').toBeTruthy()
      expect(g.why.length, `GAP「${g.pattern}」缺少「为何无既有令牌可映射」`).toBeGreaterThan(10)
      expect(g.revisit.length, `GAP「${g.pattern}」缺少复评触发点`).toBeGreaterThan(5)
    }
    // 便于 review 时直接看到全表（vitest 会打印 stdout）
    console.log(
      '\n[token-compliance GAP]\n' +
        GAP.map(g => `- ${g.pattern}\n    原因: ${g.why}\n    复评: ${g.revisit}`).join('\n'),
    )
  })
})

describe('令牌合规：护栏自检（防退化）', () => {
  const hitPalette = (s: string) => {
    PALETTE.lastIndex = 0
    return PALETTE.test(s)
  }

  it('PALETTE 能命中已知坏样本（含 shadow / 方向性边框），且不误伤 var() 令牌', () => {
    expect(hitPalette('bg-red-500'), 'bg-red-500 应被命中').toBe(true)
    expect(hitPalette('hover:bg-gray-100'), 'hover:bg-gray-100 应被命中').toBe(true)
    expect(hitPalette('border-brand-300'), 'border-brand-300（raw hex 梯度，非令牌）应被命中').toBe(true)
    expect(hitPalette('text-green-500'), 'text-green-500 应被命中').toBe(true)
    expect(hitPalette('bg-white'), 'bg-white 应被命中').toBe(true)
    expect(hitPalette('shadow-black/20'), 'shadow-black/20（阴影颜色）应被命中').toBe(true)
    expect(hitPalette('border-l-red-500'), 'border-l-red-500（方向性边框）应被命中').toBe(true)
    expect(hitPalette('divide-x-gray-200'), 'divide-x-gray-200 应被命中').toBe(true)
    expect(hitPalette('dark-all:bg-red-500'), 'dark-all: 变体前缀应被命中').toBe(true)
    // var() 令牌不是调色板
    expect(hitPalette('bg-[var(--surface)]'), 'var() 令牌不应被命中').toBe(false)
    expect(hitPalette('text-[var(--text-primary)]'), 'var() 令牌不应被命中').toBe(false)
    // 已知不过宽：这些实测全 miss
    expect(hitPalette('divide-y'), 'divide-y 不应被命中').toBe(false)
    expect(hitPalette('border-t'), 'border-t 不应被命中').toBe(false)
    expect(hitPalette('ring-offset-2'), 'ring-offset-2 不应被命中').toBe(false)
    expect(hitPalette('from-transparent'), 'from-transparent 不应被命中').toBe(false)
    expect(hitPalette('outline-none'), 'outline-none 不应被命中').toBe(false)
  })

  it('BARE_HEX / RGB_HSL / VAR_FALLBACK / VAR_OPACITY 正则命中已知样本', () => {
    expect(BARE_HEX.test('#fff')).toBe(true)
    expect(BARE_HEX.test('var(--x)')).toBe(false)
    expect(RGB_HSL.test('rgba(0,0,0,0.5)')).toBe(true)
    expect(RGB_HSL.test('hsl(1 2% 3%)')).toBe(true)
    expect(RGB_HSL.test('var(--surface)')).toBe(false)
    expect(VAR_FALLBACK.test('var(--bg-secondary, #252526)')).toBe(true)
    expect(VAR_FALLBACK.test('var(--surface, rgb(1 2 3))')).toBe(true)
    expect(VAR_FALLBACK.test('var(--surface)')).toBe(false)
    // 盲区规则：只认 var()+不透明度，不误伤纯 var() 令牌
    expect(VAR_OPACITY.test('hover:bg-[var(--x)]/80'), 'var()+不透明度应被命中').toBe(true)
    expect(VAR_OPACITY.test('bg-[var(--x)]/10')).toBe(true)
    // 同族同命形态（均实测零产出），必须一并命中
    expect(VAR_OPACITY.test('bg-[var(--x)]/[0.5]'), '方括号小数不透明度应被命中').toBe(true)
    expect(VAR_OPACITY.test('bg-[var(--x)]/[.3]'), '省略整数位的方括号不透明度应被命中').toBe(true)
    expect(VAR_OPACITY.test('text-[color:var(--x)]/50'), 'color: 类型前缀形态应被命中').toBe(true)
    expect(VAR_OPACITY.test('bg-[var(--x,transparent)]/50'), '带兜底值的 var() 形态应被命中').toBe(true)
    expect(VAR_OPACITY.test('bg-[var(--x)]'), '纯 var() 令牌不应被命中').toBe(false)
    expect(VAR_OPACITY.test('text-[var(--text-muted)]'), '纯 var() 令牌不应被命中').toBe(false)
    // 关键负样本：本轮统一改用的正确写法不得被误判为死类
    expect(
      VAR_OPACITY.test('bg-[color-mix(in_srgb,var(--x)_10%,transparent)]'),
      'color-mix 形态不应被命中（那是正确写法）',
    ).toBe(false)
    expect(
      VAR_OPACITY.test('bg-[color-mix(in_srgb,var(--brand-primary)_85%,black)]'),
      'color-mix 加深形态不应被命中',
    ).toBe(false)
  })

  it('豁免谓词：单独的 text-white 判违规，压品牌实底才放行', () => {
    expect(exemptReason('text-white', 'className="text-white"')).toBeNull()
    expect(paletteViolations('className="text-white"')).toEqual(['text-white'])
    expect(exemptReason('text-white', 'className="bg-[var(--brand-primary)] text-white"')).not.toBeNull()
    expect(paletteViolations('className="bg-[var(--brand-primary)] text-white"')).toEqual([])
    // --brand-ink 是设计系统规定的承白字实底
    expect(paletteViolations('className="bg-[var(--brand-ink)] text-white"')).toEqual([])
    // 同行共现 ≠ 同一元素，但不能让其它 token 搭便车溜走
    expect(paletteViolations('className="bg-red-500 text-white"')).toEqual(['bg-red-500', 'text-white'])
  })

  it('豁免谓词：遮罩要求同行 inset-0，且接受 absolute 写法', () => {
    expect(exemptReason('bg-black/50', 'className="bg-black/50"')).toBeNull()
    expect(paletteViolations('className="bg-black/50"')).toEqual(['bg-black/50'])
    // fixed 在父级的写法（Modal.tsx:90）必须放行
    expect(exemptReason('bg-black/50', 'className="absolute inset-0 bg-black/50"')).not.toBeNull()
    expect(exemptReason('bg-black/40', 'className="fixed inset-0 bg-black/40"')).not.toBeNull()
    // 非 scrim 行的 bg-black/50 必须抓
    expect(paletteViolations('className="rounded bg-black/50 px-2"')).toEqual(['bg-black/50'])
  })

  it('豁免谓词：Switch 的 spinner/slider 恒白放行，但白底不得扩散到任意 bg-white', () => {
    // Switch.tsx:35 loading spinner
    expect(
      exemptReason('text-white', '<svg className="mx-auto h-3.5 w-3.5 animate-spin text-white">'),
    ).not.toBeNull()
    // Switch.tsx:43 slider
    expect(
      exemptReason('bg-white', "'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0'"),
    ).not.toBeNull()
    // 任意其它 bg-white 不放行
    expect(paletteViolations('className="rounded-xl bg-white border"')).toEqual(['bg-white'])
    expect(paletteViolations('className="rounded-full bg-white p-1"')).toEqual(['bg-white'])
  })

  it('豁免谓词：阴影颜色放行但不吞并同行的其它调色板 token', () => {
    expect(exemptReason('shadow-black/20', 'className="shadow-2xl shadow-black/20"')).not.toBeNull()
    expect(paletteViolations('className="shadow-black/20 shadow-brand-500"')).toEqual(['shadow-brand-500'])
  })

  // ── alpha 阶梯自检：证明规则不是恒真 ──────────────────────────
  /** 对单串 className 断言：返回违规信息数组（空 = 合规）。 */
  const badIn = (s: string): string[] =>
    parseColorMix(s, 'self.tsx', 1)
      .map(colorMixViolation)
      .filter((v): v is string => v !== null)

  it('alpha 阶梯：能命中已知坏样本（红灯可见）', () => {
    // 焦点环 45%：既不在浅色 30/50，也不在暗色 20/30
    expect(badIn('ring-[color-mix(in_srgb,var(--brand-primary)_45%,transparent)]')).toHaveLength(1)
    expect(badIn('focus:ring-[color-mix(in_srgb,var(--brand-primary)_45%,transparent)]')).toHaveLength(1)
    expect(badIn('focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_25%,transparent)]')).toHaveLength(1)
    // 暗色环放 40%（应只在 20/30）
    expect(
      badIn('dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_40%,transparent)]'),
    ).toHaveLength(1)
    // 填充 45%（不在 5/10/15/20/30/92）
    expect(badIn('bg-[color-mix(in_srgb,var(--brand-primary)_45%,transparent)]')).toHaveLength(1)
    // 边框 35%（不在 20/30/45/50）
    expect(badIn('border-[color-mix(in_srgb,var(--error)_35%,transparent)]')).toHaveLength(1)
    // 文字 30%（不在 50/70/80）
    expect(badIn('text-[color-mix(in_srgb,var(--text-muted)_30%,transparent)]')).toHaveLength(1)
    // hover:bg 85% 但用 transparent（必须 black）
    expect(badIn('hover:bg-[color-mix(in_srgb,var(--brand-primary)_85%,transparent)]')).toHaveLength(1)
    // 单例独立角色的 token 约束：bg 40% 只许 --text-muted，换成别的必须违规
    expect(badIn('bg-[color-mix(in_srgb,var(--brand-primary)_40%,transparent)]')).toHaveLength(1)
    // F3：白名单已对齐到「阶梯」而非「历史并集」——把刚收敛的档位改回去必须变红
    expect(badIn('hover:border-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]'), 'hover 边框应统一 30%').toHaveLength(1)
    // 焦点边框的 color-mix 档位已整体退役（收敛到 INPUT_FOCUS 的 --border-emphasis，
    // 纯令牌、不经 color-mix）→ 原 50% 档与任何其它档都必须变红。
    expect(badIn('focus:border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]'), '焦点边框的 color-mix 档位已退役').toHaveLength(1)
    expect(badIn('focus:border-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]'), '焦点边框的 color-mix 档位已退役').toHaveLength(1)
    expect(badIn('hover:text-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]'), 'hover 文字应统一 80%').toHaveLength(1)
    expect(badIn('marker:text-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]'), '列表标记符应统一 70%').toHaveLength(1)
  })

  it('alpha 阶梯：不误伤合法写法', () => {
    // 浅色焦点环 30 / 50
    expect(badIn('focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]')).toEqual([])
    expect(badIn('focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]')).toEqual([])
    // 暗色焦点环 20 / 30
    expect(
      badIn('dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]'),
    ).toEqual([])
    expect(badIn('dark-all:focus:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]')).toEqual([])
    // 实底 hover 85% + black
    expect(badIn('hover:bg-[color-mix(in_srgb,var(--brand-primary)_85%,black)]')).toEqual([])
    // 填充 / 边框 / 文字常规档
    expect(badIn('bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]')).toEqual([])
    expect(badIn('border-[color-mix(in_srgb,var(--error)_45%,transparent)]')).toEqual([])
    expect(badIn('text-[color-mix(in_srgb,var(--text-muted)_50%,transparent)]')).toEqual([])
    // 单例独立角色（带 token 约束）
    expect(badIn('bg-[color-mix(in_srgb,var(--surface-muted)_50%,transparent)]')).toEqual([])
    expect(badIn('bg-[color-mix(in_srgb,var(--text-muted)_40%,transparent)]')).toEqual([])
    expect(badIn('hover:bg-[color-mix(in_srgb,var(--border)_60%,transparent)]')).toEqual([])
    expect(badIn('decoration-[color-mix(in_srgb,var(--error)_60%,transparent)]')).toEqual([])
    expect(badIn('to-[color-mix(in_srgb,var(--brand-primary)_60%,transparent)]')).toEqual([])
    // F3：收敛后的阶梯档位合法
    expect(badIn('hover:border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]')).toEqual([])
    // （focus:border 的 color-mix 档位已退役，不再有「合法写法」——见上一用例）
    expect(badIn('hover:text-[color-mix(in_srgb,var(--brand-primary)_80%,transparent)]')).toEqual([])
    expect(badIn('marker:text-[color-mix(in_srgb,var(--brand-primary)_70%,transparent)]')).toEqual([])
    // F1：静态边框 50 未被任何规则允许（border@50 已删除，其语义由 INPUT_FOCUS 的 --border-emphasis 承担）→ 必须变红。
    // 全仓静态 border@50 零站点，故此处删除不误伤存量。
    expect(badIn('border-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]'), 'border 50% 不应被任何规则允许').toHaveLength(1)
    // 边界自洽：违规文案不得把 50 列进 border 的「允许」列表（诊断不得说谎）
    const border50Msg = badIn('border-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]')[0]
    expect(border50Msg, 'border 的允许集应只列 10/20/30/45').toMatch(/允许 10\/20\/30\/45，/)
    expect(border50Msg, '不得再对被拦的 border 说「该档位仅允许 transparent」').not.toContain('该档位仅允许')
  })

  it('alpha 阶梯：不被 VAR_OPACITY 死类写法干扰（两种形态互不相认）', () => {
    expect(parseColorMix('[var(--brand-primary)]/30')).toEqual([])
    expect(parseColorMix('bg-[var(--brand-primary)]/30')).toEqual([])
    expect(parseColorMix('text-[color:var(--x)]/50')).toEqual([])
    // 只有正确的 color-mix 形态才被提取
    expect(parseColorMix('bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]')).toHaveLength(1)
  })

  it('alpha 阶梯：解析出的变体/utility/token 正确（防正则错位）', () => {
    const [s] = parseColorMix('dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]')
    expect(s.variants).toEqual(['dark-all', 'focus-visible'])
    expect(s.utility).toBe('ring')
    expect(s.token).toBe('brand-primary')
    expect(s.alpha).toBe(20)
    expect(s.target).toBe('transparent')
    expect(colorMixRole(s)).toBe('ring.dark')
    const [b] = parseColorMix('hover:bg-[color-mix(in_srgb,var(--brand-primary)_85%,black)]')
    expect(b.utility).toBe('bg')
    expect(b.target).toBe('black')
    expect(colorMixRole(b)).toBe('hover:bg')
  })

  it('F2 important 前缀：变体段不再在 `!` 处截断（消除双向偏差）', () => {
    // 解析层：`dark:!ring` 必须被完整解析为 variants=['dark'] + utility='ring'，
    // 而非在 `!` 处断裂成「无变体的浅色 ring」。
    const [s] = parseColorMix('dark:!ring-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]')
    expect(s.variants).toEqual(['dark'])
    expect(s.utility).toBe('ring')
    // 方向一（修前=静默放行/绿）：dark:!ring-[...50%] 修后由 F4 拦截 → 红
    expect(
      darkVariantMisuseIn('dark:!ring-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]'),
      'dark:!ring 50% 应被 F4 拦（内建 dark 只能命中 .dark，远山黛漂移）',
    ).toHaveLength(1)
    // 方向二（修前=过度拦截）：dark:!ring-[...20%] 修后仍由 F4 拦 → 红（理由正确，不再误报成「浅色档越界」）
    expect(
      darkVariantMisuseIn('dark:!ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]'),
      'dark:!ring 20% 应被 F4 拦',
    ).toHaveLength(1)
    // 正确写法 dark-all:!ring 不得被 F4 误伤，且解析为 ring.dark
    expect(darkVariantMisuseIn('dark-all:!ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]')).toEqual([])
    const [d] = parseColorMix('dark-all:!ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]')
    expect(d.variants).toEqual(['dark-all'])
    expect(d.utility).toBe('ring')
    expect(colorMixRole(d)).toBe('ring.dark')
  })

  it('F2 形态白名单：能拦住 Verification 实测的四种绕过，且不误伤规范形态', () => {
    const bad = (s: string) => canonicalColorMixViolationIn(s)
    // ① 颜色空间大小写（CSS 色彩空间大小写不敏感，Tailwind 仍能编译）
    expect(bad('bg-[color-mix(in_SRGB,var(--brand-primary)_45%,transparent)]'), 'in_SRGB 应被拦').toHaveLength(1)
    // ② 非 srgb 色彩空间
    expect(bad('bg-[color-mix(in_oklab,var(--brand-primary)_45%,transparent)]'), 'in_oklab 应被拦').toHaveLength(1)
    // ③ var() 带 fallback
    expect(
      bad('bg-[color-mix(in_srgb,var(--brand-primary,#123456)_45%,transparent)]'),
      'var fallback 应被拦',
    ).toHaveLength(1)
    // ④ 非法百分比（`45 %`：浏览器会静默丢弃声明）
    expect(bad('bg-[color-mix(in_srgb,var(--brand-primary)_45_%,transparent)]'), '非法百分比应被拦').toHaveLength(1)
    // ⑤ 嵌在更大任意值内部（外层非规范形态）
    expect(
      bad('shadow-[0_1px_2px_color-mix(in_srgb,var(--brand-primary)_10%,transparent)]'),
      '嵌套在更大任意值内部应被拦',
    ).toHaveLength(1)

    // F1：函数名大小写不敏感——`COLOR-MIX` / `Color-Mix` 必须被检出，否则「换个大小写」即击穿白名单。
    // 覆盖 ≥3 角色：ring / bg / shadow 嵌套 / text。
    expect(bad('ring-[COLOR-MIX(in_srgb,var(--brand-primary)_30%,transparent)]'), 'COLOR-MIX（ring）应被拦').toHaveLength(1)
    expect(bad('bg-[COLOR-MIX(in_srgb,var(--brand-primary)_10%,transparent)]'), 'COLOR-MIX（bg）应被拦').toHaveLength(1)
    expect(bad('ring-[Color-Mix(in_srgb,var(--brand-primary)_30%,transparent)]'), 'Color-Mix（ring）应被拦').toHaveLength(1)
    expect(bad('text-[COLOR-MIX(in_srgb,var(--text-muted)_50%,transparent)]'), 'COLOR-MIX（text）应被拦').toHaveLength(1)
    expect(
      bad('shadow-[0_1px_2px_COLOR-MIX(in_srgb,var(--brand-primary)_10%,transparent)]'),
      'COLOR-MIX（shadow 嵌套）应被拦',
    ).toHaveLength(1)
    // F1：判定仍按小写——参数大小写非常规一律判违规
    expect(bad('bg-[color-mix(in_SRGB,var(--brand-primary)_10%,transparent)]'), 'in_SRGB 参数应被拦').toHaveLength(1)
    expect(bad('bg-[color-mix(in_srgb,var(--brand-primary)_10%,TRANSPARENT)]'), 'TRANSPARENT 参数应被拦').toHaveLength(1)
    expect(bad('bg-[color-mix(in_srgb,var(--brand-primary)_85%,BLACK)]'), 'BLACK 参数应被拦').toHaveLength(1)

    // F3：违规文案须分两类——「大小写非常规 / 形态非法（写错了）」vs「非阶梯用途未登记」
    expect(bad('ring-[COLOR-MIX(in_srgb,var(--brand-primary)_30%,transparent)]')[0]).toContain('函数名大小写非常规')
    expect(bad('text-[color-mix(in_srgb,var(--text-muted)_50%,TRANSPARENT)]')[0]).toContain('参数大小写非常规')
    expect(bad('bg-[color-mix(in_srgb,var(--brand-primary)_45_%,transparent)]')[0]).toContain('形态非法')
    expect(bad('bg-[color-mix(in_srgb,var(--a)_50%,var(--b))]')[0], '双色渐变属非阶梯用途').toContain('非阶梯用途未登记')
    expect(bad('bg-[color-mix(in_oklab,var(--brand-primary)_45%,transparent)]')[0], '非 srgb 色彩空间属非阶梯用途').toContain(
      '非阶梯用途未登记',
    )

    // 规范形态不得误伤
    expect(bad('bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]')).toEqual([])
    expect(bad('hover:bg-[color-mix(in_srgb,var(--brand-primary)_85%,black)]')).toEqual([])
    // 非 Tailwind 任意值（如 inline style 字符串）不在此规则作用域内（属 GAP）
    expect(bad("borderColor: 'color-mix(in srgb, var(--warning) 20%, transparent)'")).toEqual([])
  })

  it('F4 NON_LADDER 登记表：空表零放行；登记项只放行被登记的那一条字面形态', () => {
    const site = 'bg-[color-mix(in_oklab,var(--brand-primary)_45%,transparent)]'
    // 登记表匹配的是**任意值本身**（`[...]`，不含 utility 前缀），与 COLOR_MIX_ARBITRARY 的命中口径一致。
    const literal = '[color-mix(in_oklab,var(--brand-primary)_45%,transparent)]'
    // 空表：非阶梯用途一律红，且文案点名登记入口（常量名 + 所在文件）
    expect(NON_LADDER_COLOR_MIX, '登记表应默认为空').toHaveLength(0)
    const before = canonicalColorMixViolationIn(site)
    expect(before).toHaveLength(1)
    expect(before[0], '文案应点名登记入口常量名').toContain('NON_LADDER_COLOR_MIX')
    expect(before[0], '文案应点名登记入口所在文件').toContain('tokenScan.ts')
    // 临时登记该字面形态：仅这一条放行
    NON_LADDER_COLOR_MIX.push({pattern: literal, why: '自检用例临时登记', revisit: '自检结束即还原'})
    try {
      expect(canonicalColorMixViolationIn(site), '登记后该字面形态放行').toEqual([])
      // 只放行被登记的那一条：token 不同（字面不同）的同类形态仍红
      expect(
        canonicalColorMixViolationIn('bg-[color-mix(in_oklab,var(--text-muted)_45%,transparent)]'),
        '未登记的字面形态仍红',
      ).toHaveLength(1)
    } finally {
      NON_LADDER_COLOR_MIX.length = 0
    }
    // 还原后零放行
    expect(canonicalColorMixViolationIn(site)).toHaveLength(1)
  })

  it('F4 内建 dark 误用：dark: 与 [&.dark]: / 函数式伪类被拦，dark-all: 放行', () => {
    const bad = (s: string) => darkVariantMisuseIn(s)
    expect(bad('dark:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]'), 'dark: 应被拦').toHaveLength(1)
    expect(bad('dark:border-[color-mix(in_srgb,var(--error)_30%,transparent)]'), 'dark: 应被拦').toHaveLength(1)
    // F4：utility 覆盖面扩到阶梯全部角色——bg / text / decoration / to 也必须拦
    expect(
      bad('dark:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]'),
      'dark:bg 也应被拦（此前静默通过）',
    ).toHaveLength(1)
    expect(bad('dark:text-[color-mix(in_srgb,var(--text-muted)_50%,transparent)]'), 'dark:text 应被拦').toHaveLength(1)
    expect(bad('dark:decoration-[color-mix(in_srgb,var(--error)_60%,transparent)]'), 'dark:decoration 应被拦').toHaveLength(1)
    expect(bad('dark:to-[color-mix(in_srgb,var(--brand-primary)_60%,transparent)]'), 'dark:to 应被拦').toHaveLength(1)
    expect(
      bad('[&.dark]:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]'),
      '[&.dark]: 应被拦',
    ).toHaveLength(1)
    expect(
      bad('[.dark_&]:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]'),
      '[.dark_&]: 应被拦',
    ).toHaveLength(1)
    // F5：函数式伪类里的 .dark（前导为 `(` / `,` / `:`）也必须被拦
    expect(
      bad('[&:is(.dark)]:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]'),
      '[&:is(.dark)]: 应被拦',
    ).toHaveLength(1)
    expect(
      bad('[&:where(.dark)]:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]'),
      '[&:where(.dark)]: 应被拦',
    ).toHaveLength(1)
    // F1：函数名大小写不敏感，否则 dark: 误用可被「换大小写」逃逸
    expect(
      bad('dark:ring-[COLOR-MIX(in_srgb,var(--brand-primary)_30%,transparent)]'),
      'dark: + COLOR-MIX 应被拦',
    ).toHaveLength(1)
    // dark-all 是正确写法，不得误伤
    expect(bad('dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]')).toEqual([])
    // 非 dark 变体、且非阶梯角色（如 fill）不拦
    expect(bad('hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]')).toEqual([])
    // 更长标识符不得误伤：`.darktheme` / `.dark-foo` 不是 .dark
    expect(bad('[&.darktheme]:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]')).toEqual([])
    expect(bad('[&.dark-foo]:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]')).toEqual([])
  })

  it('F6 isComment：认 JSX 注释 {/* ... */}，注释掉的 color-mix 不误报', () => {
    const h = (text: string): Hit => ({file: 'x', line: 1, text})
    expect(isComment(h('{/* bg-[color-mix(in_srgb,var(--x)_10%,transparent)] */}'))).toBe(true)
    expect(isComment(h('  {/* 注释 */}'))).toBe(true)
    expect(isComment(h('  { /* 带空格 */ }'))).toBe(true)
    expect(isComment(h('<div className="bg-[color-mix(in_srgb,var(--x)_10%,transparent)]" />'))).toBe(false)
  })

  it('F7 行内 / 行尾 JSX 注释：color-mix 一族不再误报（剥掉注释片段）', () => {
    const commented = '<Foo/>{/* 旧: bg-[color-mix(in_srgb,var(--x)_45_%,transparent)] */}'
    // 行首不是注释 → isComment 不认（已知边界，见 isComment JSDoc）
    expect(isComment({file: 'x', line: 1, text: commented})).toBe(false)
    // 但 color-mix 一族先剥掉注释片段 → 不误报
    expect(parseColorMix(commented)).toEqual([])
    expect(canonicalColorMixViolationIn(commented)).toEqual([])
    expect(darkVariantMisuseIn('<Foo/>{/* 旧: dark:ring-[color-mix(in_srgb,var(--x)_30%,transparent)] */}')).toEqual([])
    // 反例：未注释的同样写法仍被判违规（证明不是「一律放行」）
    expect(canonicalColorMixViolationIn('<Foo/> bg-[color-mix(in_srgb,var(--x)_45_%,transparent)]')).toHaveLength(1)
    expect(parseColorMix('<Foo/> bg-[color-mix(in_srgb,var(--x)_30%,transparent)]', 'x', 1)).toHaveLength(1)
  })
})
