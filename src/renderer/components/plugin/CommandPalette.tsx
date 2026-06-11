/**
 * CommandPalette - 命令选择弹窗主组件
 *
 * 提供命令搜索和选择界面，支持：
 * - 搜索过滤
 * - 按插件分组显示
 * - 无参数命令直接执行
 * - 有参数命令打开独立 ParamInputModal
 *
 * 优化：用户消息显示 /commandName [args]，而不是完整的提示词模板
 */

import React, {useCallback, useEffect, useState} from 'react';
import {AnimatePresence, motion} from 'framer-motion';
import {CommandList} from './CommandList';
import {ParamInputModal} from './ParamInputModal';

export interface Command {
  id: string;
  name: string;
  description?: string;
  hasArgs: boolean;
  content?: string; // 命令模板，包含 $ARGUMENTS 占位符
}

export interface CommandGroup {
  pluginName: string;
  commands: Command[];
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  /** 
   * 执行命令
   * @param commandId - 命令 ID（plugin:command 格式）
   * @param args - 用户输入的参数
   * @param displayMessage - UI 显示用的简洁消息（/commandName [args]）
   */
  onExecuteCommand: (commandId: string, args: string | undefined, displayMessage: string) => void;
}

/**
 * 从命令列表中根据 commandId 查找命令
 */
function findCommandById(commands: Command[], commandId: string): Command | undefined {
  return commands.find(cmd => cmd.id === commandId)
}

export function CommandPalette({ isOpen, onClose, onExecuteCommand }: CommandPaletteProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 扁平化所有命令，用于键盘导航
  const [allCommands, setAllCommands] = useState<Command[]>([]);

  // 过滤后的命令列表（用于搜索场景）
  const [filteredCommands, setFilteredCommands] = useState<Command[]>([]);

  // 参数输入弹窗状态
  const [paramModalOpen, setParamModalOpen] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState<Command | null>(null);

    // 监听命令列表加载完成，获取所有命令（用于参数弹窗中的 findCommandById）
  const handleCommandsLoaded = useCallback((commands: Command[]) => {
    setAllCommands(commands);
    setSelectedIndex(0);
  }, []);

  // 重置状态
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSelectedIndex(0);
      setParamModalOpen(false);
      setSelectedCommand(null);
    }
  }, [isOpen]);

  // 生成显示用消息：/commandName [args]
  const getDisplayMessage = useCallback((command: Command, args?: string): string => {
    const base = `/${command.name}`
    if (args) {
      return `${base} ${args}`
    }
    return base
  }, [])

  // 处理命令点击
  const handleCommandClick = useCallback((command: Command) => {
    // 所有命令都打开参数输入弹窗，允许用户填写参数或直接发送
    setSelectedCommand(command);
    setParamModalOpen(true);
  }, []);

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

  // 重置选中索引当搜索query改变时
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

    // 接收 CommandList 过滤后的扁平列表（与 selectedIndex 保持同步）
    const handleFilteredCommandsChange = useCallback((commands: Command[]) => {
        setFilteredCommands(commands);
    }, []);

  // 参数弹窗回调
  const handleParamSubmit = useCallback((commandId: string, args: string) => {
    // 根据 commandId 找到命令，获取显示名称
    const command = findCommandById(allCommands, commandId)
    const displayMessage = command ? getDisplayMessage(command, args) : `/${commandId} ${args}`
    onExecuteCommand(commandId, args, displayMessage)
    onClose();
    setParamModalOpen(false);
    setSelectedCommand(null);
  }, [onExecuteCommand, onClose, allCommands, getDisplayMessage]);

  const handleParamCancel = useCallback(() => {
    setParamModalOpen(false);
    setSelectedCommand(null);
  }, []);

  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 参数弹窗开启时，键盘事件由 ParamInputModal 处理
    if (paramModalOpen) {
      return;
    }

    const currentList = filteredCommands.length > 0 ? filteredCommands : allCommands;

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
  }, [paramModalOpen, filteredCommands, allCommands, executeSelectedCommand, onClose]);

  return (
    <>
      <AnimatePresence>
        {isOpen && !paramModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
            onClick={onClose}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-2xl bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Search Input */}
              <div className="p-4 border-b border-[var(--border)]">
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
                    placeholder="搜索命令..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-[var(--surface-muted)] rounded-lg
                             text-[var(--text-primary)] placeholder-[var(--text-muted)]
                             focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                    autoFocus
                  />
                </div>
              </div>

              {/* Command List */}
              <CommandList
                searchQuery={searchQuery}
                onCommandClick={handleCommandClick}
                selectedIndex={selectedIndex}
                onCommandsLoaded={handleCommandsLoaded}
                onFilteredCommandsChange={handleFilteredCommandsChange}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 独立的参数输入弹窗 */}
      <ParamInputModal
        isOpen={paramModalOpen}
        command={selectedCommand}
        onSubmit={handleParamSubmit}
        onCancel={handleParamCancel}
      />
    </>
  );
}

export default CommandPalette;
