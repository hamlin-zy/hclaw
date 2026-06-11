import { clsx } from 'clsx';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * 统一开关组件
 * - 关闭状态: bg-[var(--border-emphasis)]
 * - 开启状态: bg-[var(--brand-primary)]
 * - 支持 loading 旋转动画
 * - 支持 disabled 禁用
 */
export function Switch({ checked, onChange, disabled = false, loading = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || loading}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface)]',
        checked ? 'bg-[var(--brand-primary)]' : 'bg-[var(--border-emphasis)]',
        (disabled || loading) && 'opacity-50 cursor-not-allowed',
      )}
    >
      {loading ? (
        <svg className="mx-auto h-3.5 w-3.5 animate-spin text-white" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      ) : (
        <span
          aria-hidden="true"
          className={clsx(
            'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-in-out',
            checked ? 'translate-x-[17px]' : 'translate-x-[3px]',
          )}
        />
      )}
    </button>
  );
}
