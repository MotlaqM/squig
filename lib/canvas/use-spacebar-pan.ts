import { useState, useEffect, useCallback } from 'react'

/**
 * Check if the target element should block spacebar pan mode
 * Returns true for interactive elements that use spacebar natively
 */
function shouldBlockSpacebar(target: HTMLElement): boolean {
  const tagName = target.tagName

  // Form inputs
  if (tagName === 'INPUT' || tagName === 'TEXTAREA') return true
  if (target.isContentEditable) return true

  // Buttons and interactive elements
  if (tagName === 'BUTTON' || tagName === 'SELECT') return true

  // Elements with button/menu roles
  const role = target.getAttribute('role')
  if (role === 'button' || role === 'menuitem' || role === 'option' || role === 'tab') return true

  // Links
  if (tagName === 'A') return true

  return false
}

/**
 * Hook to track spacebar state for temporary pan mode
 * When spacebar is held, enables pan mode with grab cursor
 */
export function useSpacebarPan() {
  const [isSpacebarHeld, setIsSpacebarHeld] = useState(false)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.code !== 'Space') return

    // Always prevent default scroll behavior when space is pressed
    // (unless on an interactive element)
    const target = e.target as HTMLElement
    if (shouldBlockSpacebar(target)) return

    e.preventDefault()

    // Only update state on first press (not repeats)
    if (!e.repeat) {
      setIsSpacebarHeld(true)
    }
  }, [])

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.code === 'Space') {
      setIsSpacebarHeld(false)
    }
  }, [])

  // Handle window blur to reset state if user tabs away while holding space
  const handleBlur = useCallback(() => {
    setIsSpacebarHeld(false)
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [handleKeyDown, handleKeyUp, handleBlur])

  return { isSpacebarHeld }
}
