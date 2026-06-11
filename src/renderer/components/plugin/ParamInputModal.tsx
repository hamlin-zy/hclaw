/**
 * ParamInputModal - 参数输入独立弹窗
 * 显示命令模板预览并输入参数执行
 */
import React, {useState, useRef, useEffect} from 'react';
import {AnimatePresence, motion} from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

interface Command {
  id: string;
  name: string;
  description?: string;
  content?: string;
}

interface ParamInputModalProps {
  isOpen: boolean;
  command: Command | null;
  onSubmit: (commandId: string, args: string) => void;
  onCancel: () => void;
}

// 常量提取
const CloseIcon = () => (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
    </svg>
);

export function ParamInputModal({ isOpen, command, onSubmit, onCancel }: ParamInputModalProps) {
  const [paramValue, setParamValue] = useState('');
  const [descExpanded, setDescExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 打开弹窗时重置输入
  useEffect(() => {
    if (isOpen) setParamValue('');
  }, [isOpen]);

  // 输入值变化时同步 textarea 高度
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setParamValue(e.target.value);
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };

  if (!isOpen || !command) return null;

  const handleSubmit = () => onSubmit(command.id, paramValue);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') onCancel();
  };

  // 渲染命令模板（支持 Markdown）
  const renderTemplate = (content: string) => {
    const parts = content.split(/\$ARGUMENTS/gi);
    return parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <code className="param-highlight">{paramValue || '请输入...'}</code>}
          {part && <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{part}</ReactMarkdown>}
      </React.Fragment>
    ));
  };

  return (
    <AnimatePresence>
      <motion.div className="param-modal-overlay" onClick={onCancel}>
        <motion.div className="param-modal-content" onClick={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
          {/* Header */}
          <header className="param-modal-header">
            <div className="param-header-content">
              <h2 className="param-header-title">{command.name}</h2>
              {command.description && (
                  <div className={`param-desc-wrapper ${descExpanded ? 'expanded' : ''}`}>
                    <p className={`param-desc ${descExpanded ? 'expanded' : ''}`}>
                    {command.description}
                  </p>
                    {command.description.length > 50 && (
                        <button onClick={() => setDescExpanded(v => !v)} className="param-toggle-btn">
                          {descExpanded ? '收起' : '展开'}
                        </button>
                    )}
                  </div>
              )}
            </div>
            <button onClick={onCancel} className="param-icon-btn"><CloseIcon/></button>
          </header>

          {/* Content */}
          <div className="param-modal-body">
            {command.content && (
                <section className="param-preview-section">
                  <div className="param-section-label">命令预览</div>
                  <div className="param-preview-box">
                    {renderTemplate(command.content)}
                  </div>
                </section>
            )}
            <section className="param-input-section">
              <label>任务内容</label>
              <textarea
                  ref={textareaRef}
                  value={paramValue}
                  onChange={handleTextareaChange}
                  placeholder="在此输入..."
                  autoFocus
              />
            </section>
          </div>

          {/* Footer */}
          <footer className="param-modal-footer">
            <button onClick={onCancel} className="param-btn param-btn-secondary">取消</button>
            <button onClick={handleSubmit} className="param-btn param-btn-primary">执行命令</button>
          </footer>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

export default ParamInputModal;
