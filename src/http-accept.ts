export function acceptedQuality(accept: string, mediaType: string): number {
  const [wantedType, wantedSubtype] = mediaType.toLowerCase().split('/')
  let best = { specificity: -1, quality: 0 }
  for (const rawRange of accept.split(',')) {
    const [rawMedia = '', ...parameters] = rawRange.trim().split(';')
    const [rangeType, rangeSubtype] = rawMedia.trim().toLowerCase().split('/')
    if (!rangeType || !rangeSubtype) continue
    const specificity = rangeType === wantedType && rangeSubtype === wantedSubtype
      ? 2
      : rangeType === wantedType && rangeSubtype === '*'
        ? 1
        : rangeType === '*' && rangeSubtype === '*'
          ? 0
          : -1
    if (specificity < 0) continue
    const q = parameters
      .map(parameter => /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/iu.exec(parameter))
      .find(match => match !== null)
    const quality = q ? Number(q[1]) : 1
    if (specificity > best.specificity || (specificity === best.specificity && quality > best.quality)) {
      best = { specificity, quality }
    }
  }
  return best.quality
}

function exactQuality(accept: string, mediaType: string): number | null {
  const wanted = mediaType.toLowerCase()
  let quality: number | null = null
  for (const rawRange of accept.split(',')) {
    const [rawMedia = '', ...parameters] = rawRange.trim().split(';')
    if (rawMedia.trim().toLowerCase() !== wanted) continue
    const q = parameters
      .map(parameter => /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/iu.exec(parameter))
      .find(match => match !== null)
    quality = Math.max(quality ?? 0, q ? Number(q[1]) : 1)
  }
  return quality
}

export function prefersHtml(accept: string | undefined, machineType: string): boolean {
  if (!accept) return false
  const xhtmlQuality = exactQuality(accept, 'application/xhtml+xml') ?? 0
  const htmlQuality = Math.max(
    acceptedQuality(accept, 'text/html'),
    xhtmlQuality,
  )
  return htmlQuality > 0 && htmlQuality > acceptedQuality(accept, machineType)
}
