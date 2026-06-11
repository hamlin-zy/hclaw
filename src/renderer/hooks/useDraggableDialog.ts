/**
 * useDraggableDialog — Shared hook for global dialogs
 *
 * Provides:
 * - Centered positioning (requestAnimationFrame)
 * - Draggable (mouse + touch)
 * - Drag shadow feedback
 * - Boundary constraints (prevent dragging out of viewport)
 * - Position persistence (optional, via storageKey)
 *
 * Shared by (or available for):
 * - AskUserModal
 * - CompactToolPopup
 * - PermissionConfirmModal
 */

import {useCallback, useEffect, useRef, useState} from 'react'

// ═══════════════════════════════════════════════════════════
// Type definitions
// ═══════════════════════════════════════════════════════════

interface DraggableDialogOptions {
    /** Whether the dialog is visible (triggers centered positioning) */
    visible: boolean
    /** Optional: localStorage key for persisting dialog position */
    storageKey?: string
    /** Optional: id of the element that labels this dialog (for aria-labelledby) */
    ariaLabelledBy?: string
}

interface DraggableDialogResult {
    dialogRef: React.RefObject<HTMLDivElement | null>
    position: {x: number; y: number}
    isDragging: boolean
    handleDragStart: (e: React.MouseEvent | React.TouchEvent) => void
}

// Drag coordinates (compatible with MouseEvent and TouchEvent)
interface DragCoords {
    clientX: number
    clientY: number
}

// ═══════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════

/** Drag boundary constraint configuration */
const CONSTRAINTS = {
    /** Minimum X coordinate (distance from left edge of viewport) */
    minX: 8,
    /** Minimum Y coordinate (distance from top of viewport) */
    minY: 8,
    /** Margin from right edge of viewport */
    marginRight: 8,
    /** Margin from bottom of viewport */
    marginBottom: 8,
} as const

// ═══════════════════════════════════════════════════════════
// Utility functions
// ═══════════════════════════════════════════════════════════

/**
 * Extract client coordinates from MouseEvent or TouchEvent
 * Uses type guards/assertions to ensure type safety
 */
function getClientCoords(e: MouseEvent | TouchEvent): DragCoords {
    if ('touches' in e && e.touches.length > 0) {
        return {clientX: e.touches[0].clientX, clientY: e.touches[0].clientY}
    }
    if ('changedTouches' in e && e.changedTouches.length > 0) {
        return {clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY}
    }
    const me = e as MouseEvent
    return {clientX: me.clientX, clientY: me.clientY}
}

/**
 * Extract client coordinates from a React synthetic event (MouseEvent or TouchEvent)
 */
function getClientCoordsFromReactEvent(e: React.MouseEvent | React.TouchEvent): DragCoords {
    if ('touches' in e) {
        return {clientX: e.touches[0].clientX, clientY: e.touches[0].clientY}
    }
    return {clientX: e.clientX, clientY: e.clientY}
}

/**
 * Calculate drag boundary constraints
 * @param dialogWidth Dialog width
 * @param dialogHeight Dialog height
 * @returns Boundary constraints
 */
function calculateBounds(dialogWidth: number, dialogHeight: number) {
    const maxX = window.innerWidth - dialogWidth - CONSTRAINTS.marginRight
    const maxY = window.innerHeight - dialogHeight - CONSTRAINTS.marginBottom
    return {
        minX: CONSTRAINTS.minX,
        minY: CONSTRAINTS.minY,
        maxX: Math.max(CONSTRAINTS.minX, maxX),
        maxY: Math.max(CONSTRAINTS.minY, maxY),
    }
}

/**
 * Clamp position within boundary constraints
 * @param x Target X coordinate
 * @param y Target Y coordinate
 * @param dialogWidth Dialog width
 * @param dialogHeight Dialog height
 * @returns Clamped coordinates
 */
function clampPosition(x: number, y: number, dialogWidth: number, dialogHeight: number) {
    const {minX, minY, maxX, maxY} = calculateBounds(dialogWidth, dialogHeight)
    return {
        x: Math.min(Math.max(x, minX), maxX),
        y: Math.min(Math.max(y, minY), maxY),
    }
}

/**
 * Load saved position from localStorage
 */
function loadPosition(storageKey: string): {x: number; y: number} | null {
    try {
        const saved = localStorage.getItem(storageKey)
        if (saved) {
            const parsed = JSON.parse(saved)
            if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
                return parsed
            }
        }
    } catch {
        // ignore parse errors
    }
    return null
}

/**
 * Save position to localStorage
 */
function savePosition(storageKey: string, x: number, y: number): void {
    try {
        localStorage.setItem(storageKey, JSON.stringify({x, y}))
    } catch {
        // ignore storage errors (e.g., private browsing quota)
    }
}

// ═══════════════════════════════════════════════════════════
// Main Hook
// ═══════════════════════════════════════════════════════════

export function useDraggableDialog({
    visible,
    storageKey,
    ariaLabelledBy,
}: DraggableDialogOptions): DraggableDialogResult {
    const dialogRef = useRef<HTMLDivElement>(null)
    const [position, setPosition] = useState<{x: number; y: number}>(() => {
        if (storageKey) {
            const saved = loadPosition(storageKey)
            if (saved) return saved
        }
        return {x: 0, y: 0}
    })
    const [isDragging, setIsDragging] = useState(false)

    // Drag state refs
    const dragRef = useRef({startX: 0, startY: 0, startPosX: 0, startPosY: 0})
    const isTouchDragRef = useRef(false)
    // Store position ref for useEffect dependencies
    const positionRef = useRef(position)
    positionRef.current = position

    // ── Bounds cache: avoids recalculating calculateBounds() on every mouse move ──
    const boundsCacheRef = useRef<{width: number; height: number; bounds: ReturnType<typeof calculateBounds>} | null>(null)

    // Invalidate bounds cache on window resize
    useEffect(() => {
        const handleResize = () => { boundsCacheRef.current = null }
        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [])

    // Cached version of clampPosition — reuses bounds until dimensions or window size change
    const clampPositionCached = useCallback((x: number, y: number, w: number, h: number) => {
        const cache = boundsCacheRef.current
        if (!cache || cache.width !== w || cache.height !== h) {
            boundsCacheRef.current = {width: w, height: h, bounds: calculateBounds(w, h)}
        }
        const {minX, minY, maxX, maxY} = boundsCacheRef.current!.bounds
        return {
            x: Math.min(Math.max(x, minX), maxX),
            y: Math.min(Math.max(y, minY), maxY),
        }
    }, [])

    // ── Set ARIA attributes on the dialog element ──
    useEffect(() => {
        const el = dialogRef.current
        if (!el) return
        el.setAttribute('role', 'dialog')
        el.setAttribute('aria-modal', 'true')
        if (ariaLabelledBy) {
            el.setAttribute('aria-labelledby', ariaLabelledBy)
        } else {
            el.removeAttribute('aria-labelledby')
        }
    }, [ariaLabelledBy])

    // ── Centered positioning (executes when visible transitions false→true) ──
    useEffect(() => {
        if (!visible || !dialogRef.current) return
        requestAnimationFrame(() => {
            if (!dialogRef.current) return
            const {offsetWidth: w, offsetHeight: h} = dialogRef.current

            // Prefer saved position (storageKey), otherwise center
            let targetX: number
            let targetY: number

            if (storageKey) {
                const saved = loadPosition(storageKey)
                if (saved) {
                    targetX = saved.x
                    targetY = saved.y
                } else {
                    targetX = Math.max((window.innerWidth - w) / 2, CONSTRAINTS.minX)
                    targetY = Math.max((window.innerHeight - h) / 2, 80)
                }
            } else {
                targetX = Math.max((window.innerWidth - w) / 2, CONSTRAINTS.minX)
                targetY = Math.max((window.innerHeight - h) / 2, 80)
            }

            // Apply boundary constraints
            const clamped = clampPositionCached(targetX, targetY, w, h)
            setPosition(clamped)
        })
    }, [visible, storageKey, clampPositionCached])

    // ── Drag start ──
    const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
        if (isTouchDragRef.current) {
            isTouchDragRef.current = false
            return
        }

        const isTouch = 'touches' in e
        if (isTouch) isTouchDragRef.current = true

        const {clientX, clientY} = getClientCoordsFromReactEvent(e)
        const currentPos = positionRef.current
        dragRef.current = {startX: clientX, startY: clientY, startPosX: currentPos.x, startPosY: currentPos.y}
        setIsDragging(true)
    }, [])

    // ── Drag move + end ──
    useEffect(() => {
        if (!isDragging) return

        const handleMove = (e: MouseEvent | TouchEvent) => {
            const {clientX, clientY} = getClientCoords(e)
            const deltaX = clientX - dragRef.current.startX
            const deltaY = clientY - dragRef.current.startY
            const rawX = dragRef.current.startPosX + deltaX
            const rawY = dragRef.current.startPosY + deltaY

            const dialogEl = dialogRef.current
            if (dialogEl) {
                const {offsetWidth: w, offsetHeight: h} = dialogEl
                const clamped = clampPositionCached(rawX, rawY, w, h)
                setPosition(clamped)
            } else {
                setPosition({x: rawX, y: rawY})
            }
        }

        const handleEnd = () => {
            // Reset touch drag flag after drag ends (delayed to avoid interfering with next click)
            if (isTouchDragRef.current) {
                setTimeout(() => {
                    isTouchDragRef.current = false
                }, 0)
            }

            // Persist position
            if (storageKey) {
                savePosition(storageKey, positionRef.current.x, positionRef.current.y)
            }

            setIsDragging(false)
        }

        document.addEventListener('mousemove', handleMove)
        document.addEventListener('mouseup', handleEnd)
        document.addEventListener('touchmove', handleMove, {passive: true})
        document.addEventListener('touchend', handleEnd)

        return () => {
            document.removeEventListener('mousemove', handleMove)
            document.removeEventListener('mouseup', handleEnd)
            document.removeEventListener('touchmove', handleMove)
            document.removeEventListener('touchend', handleEnd)
        }
    }, [isDragging, storageKey, clampPositionCached])

    return {dialogRef, position, isDragging, handleDragStart}
}