export function windowLiveCenterCamera(
  viewportWidth: number,
  viewportHeight: number,
  targetX: number,
  targetY: number,
  preferredScale: number,
  minimumScale: number,
  maximumScale: number,
): Readonly<{ scale: number; offsetX: number; offsetY: number }> | null {
  if (![viewportWidth, viewportHeight, targetX, targetY, preferredScale,
    minimumScale, maximumScale].every(Number.isFinite) ||
      viewportWidth <= 0 || viewportHeight <= 0 || targetX < 0 || targetY < 0 ||
      minimumScale <= 0 || maximumScale < minimumScale) return null
  const scale = windowLiveClampZoomScale(preferredScale, minimumScale, maximumScale)
  return Object.freeze({
    scale,
    offsetX: viewportWidth / 2 - targetX * scale,
    offsetY: viewportHeight / 2 - targetY * scale,
  })
}

export function windowLiveRevealCamera(
  viewportWidth: number,
  viewportHeight: number,
  targetX: number,
  targetY: number,
  targetWidth: number,
  targetHeight: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  safeInset: number,
): Readonly<{ scale: number; offsetX: number; offsetY: number }> | null {
  if (![viewportWidth, viewportHeight, targetX, targetY, targetWidth, targetHeight,
    scale, offsetX, offsetY, safeInset].every(Number.isFinite) ||
      viewportWidth <= 0 || viewportHeight <= 0 || scale <= 0 ||
      targetWidth < 0 || targetHeight < 0 || safeInset < 0 ||
      safeInset * 2 >= viewportWidth || safeInset * 2 >= viewportHeight) return null
  const safeCenter = (
    current: number,
    viewportSize: number,
    scaledTargetSize: number,
  ) => {
    const half = scaledTargetSize / 2
    const available = viewportSize - safeInset * 2
    const canFit = scaledTargetSize <= available
    const inwardGuard = canFit
      ? Math.min(0.01, Math.max(0, available - scaledTargetSize) / 2)
      : 0
    const minimum = canFit ? safeInset + half + inwardGuard : safeInset
    const maximum = canFit
      ? viewportSize - safeInset - half - inwardGuard
      : viewportSize - safeInset
    return Math.max(minimum, Math.min(maximum, current))
  }
  const screenX = targetX * scale + offsetX
  const screenY = targetY * scale + offsetY
  const revealedX = safeCenter(screenX, viewportWidth, targetWidth * scale)
  const revealedY = safeCenter(screenY, viewportHeight, targetHeight * scale)
  return Object.freeze({
    scale,
    offsetX: revealedX - targetX * scale,
    offsetY: revealedY - targetY * scale,
  })
}

export function windowLiveClampZoomScale(
  requestedScale: number,
  minimumScale: number,
  maximumScale: number,
): number {
  if (![minimumScale, maximumScale].every(Number.isFinite) ||
      minimumScale <= 0 || maximumScale < minimumScale) return 1
  if (!Number.isFinite(requestedScale)) return minimumScale
  return Math.max(minimumScale, Math.min(maximumScale, requestedScale))
}

export function windowLiveResidentLabelMode(
  scale: number,
  readableThreshold: number,
): 'far' | 'readable' {
  if (!Number.isFinite(scale) || scale <= 0 ||
      !Number.isFinite(readableThreshold) || readableThreshold <= 0) return 'far'
  return scale >= readableThreshold ? 'readable' : 'far'
}
