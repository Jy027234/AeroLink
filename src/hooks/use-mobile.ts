import * as React from "react"

const MOBILE_BREAKPOINT = 768

function getEffectiveViewportWidth() {
  if (typeof window === 'undefined') return Number.POSITIVE_INFINITY;
  const layoutWidth = document.documentElement?.offsetWidth;
  return layoutWidth && layoutWidth > 0
    ? Math.min(window.innerWidth, layoutWidth)
    : window.innerWidth;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(getEffectiveViewportWidth() < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    window.addEventListener("resize", onChange)
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(onChange)
      : undefined;
    resizeObserver?.observe(document.documentElement);
    onChange();
    return () => {
      mql.removeEventListener("change", onChange)
      window.removeEventListener("resize", onChange)
      resizeObserver?.disconnect();
    }
  }, [])

  return !!isMobile
}
