/**
 * CommandList - 命令列表组件
 * 从插件和用户自定义命令合并加载，支持搜索过滤和键盘导航
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {fuzzyFilter} from '../../lib/search';
import {CopyButton} from '../common/CopyButton';
import {Command} from './CommandPalette';

interface DisplayCommand extends Command {
    source: 'plugin' | 'user' | 'skill' | 'agent';
    pluginName?: string;
    enabled: boolean;
}

interface DisplayGroup {
    label: string;
    source: 'plugin' | 'user' | 'skill' | 'agent';
    commands: DisplayCommand[];
}

/** Source-specific visual config: icon, header/icon-ring/tag class, and tag label */
const SOURCE_STYLE: Record<string, { icon: string; header: string; iconRing: string; tag: string }> = {
    user: {
        icon: '⚡',
        header: 'text-[var(--brand-primary)] bg-[var(--brand-muted)]',
        iconRing: 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]',
        tag: 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]',
    },
    skill: {
        icon: '🧠',
        header: 'text-[#8b5cf6] bg-[#8b5cf6]/10',
        iconRing: 'bg-[#8b5cf6]/10 text-[#8b5cf6]',
        tag: 'bg-[#8b5cf6]/10 text-[#8b5cf6]',
    },
    agent: {
        icon: '🤖',
        header: 'text-[#0ea5e9] bg-[#0ea5e9]/10',
        iconRing: 'bg-[#0ea5e9]/10 text-[#0ea5e9]',
        tag: 'bg-[#0ea5e9]/10 text-[#0ea5e9]',
    },
    plugin: {
        icon: '⚡',
        header: 'text-[var(--text-muted)] bg-[var(--surface-muted)]',
        iconRing: 'bg-[var(--surface-muted)] text-[var(--text-muted)]',
        tag: 'bg-[var(--surface-muted)] text-[var(--text-muted)]',
    },
}

const SOURCE_TAG_LABEL: Record<string, string> = {
    user: '命令',
    plugin: '命令',
    skill: '技能',
    agent: '代理',
}

interface CommandListProps {
    searchQuery: string;
    onCommandClick: (command: Command) => void;
    selectedIndex: number;
    onCommandsLoaded?: (commands: Command[]) => void;
    onFilteredCommandsChange?: (commands: Command[]) => void;
}

export function CommandList({
                                searchQuery,
                                onCommandClick,
                                selectedIndex,
                                onCommandsLoaded,
                                onFilteredCommandsChange
                            }: CommandListProps) {
    const [displayGroups, setDisplayGroups] = useState<DisplayGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // 加载命令数据
    const loadCommands = async () => {
        try {
            setLoading(true);
            setError(null);

            const api = window.electronAPI;
            const groups: DisplayGroup[] = [];

            // 加载用户命令
            const userCommandsResult = await api?.command?.getUserCommands?.();
            const userCommands: any[] = Array.isArray(userCommandsResult) ? userCommandsResult : (userCommandsResult as any)?.data ?? [];
            const enabledUserCmds = userCommands
                .filter((cmd: any) => cmd.enabled)
                .map((cmd: any) => mapToDisplayCommand('user')(cmd));

            if (enabledUserCmds.length > 0) {
                groups.push({label: '自定义命令', source: 'user', commands: enabledUserCmds});
            }

            // 获取禁用的插件命令
            const disabledIds = await getDisabledPluginCommandIds(api);

            // 加载插件命令
            const pluginCommands = await api?.plugin?.getCommands?.() ?? {};
            for (const [pluginName, cmds] of Object.entries<any[]>(pluginCommands)) {
                const enabledCmds = cmds
                    .filter((cmd: any) => !disabledIds.has(cmd.id))
                    .map((cmd: any) => mapToDisplayCommand('plugin')(cmd, pluginName));

                if (enabledCmds.length > 0) {
                    groups.push({label: `插件: ${pluginName}`, source: 'plugin', commands: enabledCmds});
                }
            }

            // 加载技能命令
            const skillCommands = await api?.command?.getSkillCommands?.() ?? [];
            if (Array.isArray(skillCommands) && skillCommands.length > 0) {
                const skillCmds = skillCommands.map(mapToExternalCommand('skill'));
                groups.push({label: '技能', source: 'skill', commands: skillCmds});
            }

            // 加载 Agent 命令
            const agentCommands = await api?.command?.getAgentCommands?.() ?? [];
            if (Array.isArray(agentCommands) && agentCommands.length > 0) {
                const agentCmds = agentCommands.map(mapToExternalCommand('agent'));
                groups.push({label: '代理', source: 'agent', commands: agentCmds});
            }

            setDisplayGroups(groups);
        } catch {
            setError('加载命令失败');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadCommands();
    }, []);

    // 通知父组件命令列表变化
    useEffect(() => {
        if (!loading && displayGroups.length > 0 && onCommandsLoaded) {
            const flatCommands = displayGroups.flatMap(g =>
                g.commands.map(({id, name, description, hasArgs, content, source}) => ({
                    id, name, description, hasArgs, content, source
                }))
            );
            onCommandsLoaded(flatCommands);
        }
    }, [loading, displayGroups, onCommandsLoaded]);

    // 扁平所有命令，无搜索时按名称排序，有搜索时按相关度排序（不同类型交叉显示）
    const flatCommands = useMemo(() => {
        // 展平所有命令
        const all: DisplayCommand[] = [];
        for (const group of displayGroups) {
            for (const cmd of group.commands) {
                all.push(cmd);
            }
        }

        if (!searchQuery.trim()) {
            // 无搜索：按名称字母序排列，不同类型交叉显示
            all.sort((a, b) => a.name.localeCompare(b.name));
            return all;
        }

        // 有搜索：过滤 + 跨类型按相关度排序
        const query = searchQuery.trim().toLowerCase();

        function isSubsequence(text: string): boolean {
            let qi = 0;
            for (let ti = 0; ti < text.length && qi < query.length; ti++) {
                if (text[ti] === query[qi]) qi++;
            }
            return qi === query.length;
        }

        function rank(cmd: DisplayCommand): number {
            const name = cmd.name.toLowerCase();
            const desc = (cmd.description || '').toLowerCase();
            return name.startsWith(query) ? 100 :
                name.includes(query) ? 80 :
                    isSubsequence(name) ? 60 :
                        desc.startsWith(query) ? 50 :
                            desc.includes(query) ? 30 : 10;
        }

        const matched = fuzzyFilter(all, searchQuery, ['name', 'description']);
        matched.sort((a, b) => rank(b) - rank(a));

        return matched;
    }, [displayGroups, searchQuery]);

    // 选中项变化时自动滚动到可视区域
    useEffect(() => {
        if (selectedIndex < 0 || selectedIndex >= flatCommands.length) return;
        const container = scrollRef.current;
        if (!container) return;
        const button = container.querySelector(`[data-flat-index="${selectedIndex}"]`) as HTMLElement | null;
        if (button) {
            button.scrollIntoView({block: 'nearest'});
        }
    }, [selectedIndex, flatCommands]);

    // 扁平命令列表（与父组件保持 selectedIndex 同步）
    const filteredFlatCommands = useMemo(() => {
        if (loading) return [];
        return flatCommands.map(({id, name, description, hasArgs, content, source}) => ({
            id, name, description, hasArgs, content, source
        }));
    }, [flatCommands, loading]);

    useEffect(() => {
        if (!loading && onFilteredCommandsChange) {
            onFilteredCommandsChange(filteredFlatCommands);
        }
    }, [filteredFlatCommands, loading, onFilteredCommandsChange]);

    // 空状态
    if (loading) return (
        <div className="p-8 text-center">
            <div
                className="inline-block w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
            <div className="mt-2 text-sm text-[var(--text-muted)]">加载中...</div>
        </div>
    );

    if (error) return (
        <div className="p-8 text-center">
            <div className="text-sm text-[var(--error)]">{error}</div>
            <button onClick={loadCommands} className="mt-2 text-xs text-[var(--brand-primary)] hover:underline">重试
            </button>
        </div>
    );

    if (flatCommands.length === 0) return (
        <div className="p-8 text-center">
            <div className="text-sm text-[var(--text-muted)]">
                {searchQuery ? '未找到匹配的命令' : '暂无可用命令'}
            </div>
        </div>
    );

    return (
        <div ref={scrollRef} className="max-h-96 overflow-y-auto">
            {flatCommands.map((cmd, flatIdx) => {
                const style = SOURCE_STYLE[cmd.source] ?? SOURCE_STYLE.plugin
                const tagLabel = SOURCE_TAG_LABEL[cmd.source]
                const isSelected = flatIdx === selectedIndex

                return (
                    <button
                        key={cmd.id}
                        data-flat-index={flatIdx}
                        onClick={() => onCommandClick(cmd)}
                        className={`w-full px-4 py-2.5 flex items-center gap-3 text-left transition-colors focus:outline-none border-b border-[var(--border)] last:border-0 ${isSelected ? 'bg-[var(--brand-primary)]/20 border-l-2 border-l-[var(--brand-primary)]' : 'hover:bg-[var(--surface-muted)]'}`}
                    >
                    <span
                        className={`flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-sm ${isSelected ? 'bg-[var(--brand-primary)] text-white' : style.iconRing}`}>
                      {style.icon}
                    </span>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                        <span
                            className={`font-medium truncate ${isSelected ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'}`}>
                          {cmd.name}
                        </span>
                                <CopyButton name={cmd.name} size="sm" />
                                {tagLabel && (
                                    <span
                                        className={`text-[10px] px-1 py-0.5 rounded ${style.tag}`}>{tagLabel}</span>
                                )}
                            </div>
                            {cmd.description && (
                                <div
                                    className="text-sm text-[var(--text-muted)] truncate">{cmd.description}</div>
                            )}
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

// 辅助函数：获取禁用的插件命令ID集合
async function getDisabledPluginCommandIds(api: any): Promise<Set<string>> {
    const disabledIds = new Set<string>();
    try {
        const overrides = await api?.pluginCommand?.getOverrides?.() ?? [];
        overrides.forEach((ov: any) => {
            if (ov.pluginCommandId && !ov.enabled) disabledIds.add(ov.pluginCommandId);
        });
    } catch { /* silent */
    }
    return disabledIds;
}

// 辅助函数：映射外部命令（技能/Agent）到 DisplayCommand
function mapToExternalCommand(source: 'skill' | 'agent') {
    return (cmd: any): DisplayCommand => ({
        id: cmd.id,
        name: cmd.name,
        description: cmd.description || '',
        hasArgs: false,
        content: '',
        source,
        enabled: true,
    });
}

// 辅助函数：映射命令到DisplayCommand
function mapToDisplayCommand(source: 'plugin' | 'user') {
    return (cmd: any, pluginName?: string): DisplayCommand => ({
        id: cmd.id,
        name: cmd.name,
        description: cmd.description,
        hasArgs: (cmd.args?.length ?? 0) > 0 || /\$ARGUMENTS/gi.test(cmd.content || ''),
        content: cmd.content,
        source,
        pluginName,
        enabled: true,
    });
}

export default CommandList;
