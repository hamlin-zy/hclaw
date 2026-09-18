/** 设置页分节标题（spec §4.1；字号三档之一 text-xs） */
export default function SectionHeader({children}: {children: React.ReactNode}) {
    return <h3 className="text-xs font-semibold text-[var(--text-secondary)] mb-3">{children}</h3>
}
