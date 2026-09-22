/**
 * CommandPalette - 命令选择弹窗主组件
 *
 * 提供命令搜索和选择界面，支持：
 * - 搜索过滤
 * - 按插件分组显示
 * - 选中能力后回调 onSelectCapability，由 InputArea 显示能力徽标
 *   用户在主输入框写正文，回车发送时正文作为命令 args 填入模板
 */

import React, {useCallback, useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {AnimatePresence, motion} from 'framer-motion';
import {fade, scaleFade} from '../../lib/motionPresets';
import {INPUT_FOCUS} from '../../lib/inputFocus';
import {CommandList} from './CommandList';
import {nextPaletteTab, PALETTE_TABS, PaletteTab, TAB_SOURCES} from '../../lib/paletteTabs';

export interface Command {
  id: string;
  name: string;
  description?: string;
  hasArgs: boolean;
  content?: string; // 命令模板，包含 $ARGUMENTS 占位符
  source?: 'plugin' | 'user' | 'skill' | 'agent';
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * 选中能力回调（不再打开参数弹窗，改为内联到输入框）
   * @param commandId - 命令 ID（plugin:command 格式）
   * @param type - 能力类型（'command' | 'plugin' | 'skill' | 'agent'）
   * @param name - 能力名称（用于显示徽标）
   */
  onSelectCapability: (commandId: string, type: 'command' | 'plugin' | 'skill' | 'agent', name: string) => void;
}

export function CommandPalette({ isOpen, onClose, onSelectCapability }: CommandPaletteProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<PaletteTab>('all');

  // 扁平化所有命令，用于键盘导航
  const [allCommands, setAllCommands] = useState<Command[]>([]);

  // 过滤后的命令列表（用于搜索场景）
  const [filteredCommands, setFilteredCommands] = useState<Command[]>([]);

  // 监听命令列表加载完成
  const handleCommandsLoaded = useCallback((commands: Command[]) => {
    setAllCommands(commands);
    setSelectedIndex(0);
  }, []);

  // 重置状态
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSelectedIndex(0);
      setActiveTab('all');
    }
  }, [isOpen]);

  // 处理命令点击：选中能力后关闭面板，由 InputArea 显示徽标
  const handleCommandClick = useCallback((command: Command) => {
    // 'user' 命令归一化为 'command' 类型（与 SelectedCapability.type 对齐）
    const type = command.source === 'user' ? 'command' : (command.source ?? 'command')
    onSelectCapability(command.id, type, command.name)
    onClose()
  }, [onSelectCapability, onClose]);

  // 执行当前选中的命令
  const executeSelectedCommand = useCallback(() => {
    const currentList = filteredCommands.length > 0 ? filteredCommands : allCommands;
    if (currentList.length > 0 && selectedIndex >= 0) {
      const command = currentList[selectedIndex];
      if (command) {
        handleCommandClick(command);
      }
    }
  }, [filteredCommands, allCommands, selectedIndex, handleCommandClick]);

  // 搜索词或 tab 切换时重置选中索引（列表内容已变化）
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery, activeTab]);

  // 接收 CommandList 过滤后的扁平列表（与 selectedIndex 保持同步）
  const handleFilteredCommandsChange = useCallback((commands: Command[]) => {
    setFilteredCommands(commands);
  }, []);

  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const currentList = filteredCommands.length > 0 ? filteredCommands : allCommands;

    // tab 切换：Alt+← / Alt+→（循环）
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setActiveTab(prev => nextPaletteTab(prev, e.key === 'ArrowRight' ? 1 : -1));
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => {
          if (currentList.length === 0) return 0;
          return prev < currentList.length - 1 ? prev + 1 : 0;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => {
          if (currentList.length === 0) return 0;
          return prev > 0 ? prev - 1 : currentList.length - 1;
        });
        break;
      case 'Enter':
        e.preventDefault();
        executeSelectedCommand();
        break;
      case 'Escape':
        e.preventDefault();
        e.nativeEvent.stopPropagation();
        onClose();
        break;
    }
  }, [filteredCommands, allCommands, executeSelectedCommand, onClose]);

  return createPortal(
    <>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            {...fade}
            className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
            onClick={onClose}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            <motion.div
              {...scaleFade}
              transition={{ duration: 0.15 }}
              className="w-full max-w-2xl bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Search Input */}
              <div className="p-4 border-b border-[var(--border-muted)]">
                <div className="relative">
                  <svg
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-muted)]"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    placeholder={PALETTE_TABS.find(t => t.id === activeTab)!.placeholder}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className={`w-full pl-10 pr-4 py-2.5 bg-[var(--surface-muted)] rounded-lg
                             text-[var(--text-primary)] placeholder-[var(--text-muted)] ${INPUT_FOCUS}`}
                    autoFocus
                  data-name="command-palette-input"/>
                </div>

                {/* Tab 栏 */}
                <div className="mt-3 flex items-center gap-1">
                  {PALETTE_TABS.map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`px-3 py-1.5 text-sm rounded-lg transition-colors focus:outline-none ${
                        activeTab === tab.id
                          ? 'bg-[color-mix(in_srgb,var(--brand-primary)_15%,transparent)] text-[var(--text-brand)] font-medium'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]'
                      }`}
                     data-name="command-palette-button">
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Command List */}
              <CommandList
                searchQuery={searchQuery}
                onCommandClick={handleCommandClick}
                selectedIndex={selectedIndex}
                onCommandsLoaded={handleCommandsLoaded}
                onFilteredCommandsChange={handleFilteredCommandsChange}
                sourceFilter={TAB_SOURCES[activeTab]}
                tab={activeTab}
              />

              {/* 键盘操作提示 */}
              <div className="px-4 py-2 border-t border-[var(--border-muted)]">
                <div className="text-center text-[10px] text-[var(--text-secondary)]">
                  Alt+←/→ 切换标签 · ↑/↓ 选择 · Enter 执行
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </>,
    document.body
  );
}

export default CommandPalette;
