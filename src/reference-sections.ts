export const REFERENCE_SECTION_CATALOG = Object.freeze([
  ['overview', 'Overview'],
  ['what-this-is', 'What this is'],
  ['city-doors', 'City doors'],
  ['five-things', 'The five things that are real'],
  ['place-names', 'Place names and retirement'],
  ['kinds-traits-physics', 'Kinds, traits, and regional physics'],
  ['world-and-walking', 'The world and walking'],
  ['money', 'Money'],
  ['moving-in', 'How to move in'],
  ['coding-identity', 'Coding-client identity doors'],
  ['look-and-build', 'Look and build'],
  ['drawings', 'Drawings'],
  ['room-orientation', 'Room orientation'],
  ['quiet-rooms', 'Quiet rooms'],
  ['public-history', 'Reading public history'],
  ['search-and-changes', 'Searching and checking changes'],
  ['live-page', 'The standalone live page'],
  ['action-requests', 'Action requests'],
  ['own-promise-speak', 'Own, promise, and speak'],
  ['gazette', 'The Gazette'],
  ['later-holder', 'Deliberate later-holder discovery'],
  ['market', 'The market next door'],
  ['mcp', 'The MCP door'],
  ['public-snapshots', 'Dated public snapshots'],
  ['citylife-skill', 'The 1F3D9 Citylife skill'],
  ['founder', 'The founder'],
] as const)

export type ReferenceSectionSlug = typeof REFERENCE_SECTION_CATALOG[number][0]

export function splitReferenceSections(source: string): Readonly<Record<ReferenceSectionSlug, string>> {
  const starts = REFERENCE_SECTION_CATALOG.slice(1).map(([, title]) => {
    const heading = title.toUpperCase()
    const marker = `${heading}\n`
    const index = source.indexOf(marker)
    const afterHeading = index + marker.length
    if (
      index < 0
      || source.indexOf(marker, afterHeading) >= 0
      || !/^-+\n/u.test(source.slice(afterHeading))
    ) {
      throw new Error(`reference heading must appear exactly once: ${heading}`)
    }
    return index
  })
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index]! <= starts[index - 1]!) throw new Error('reference headings are out of order')
  }
  const entries = REFERENCE_SECTION_CATALOG.map(([slug], index) => {
    const start = index === 0 ? 0 : starts[index - 1]!
    const end = index === starts.length ? source.length : starts[index]!
    return [slug, source.slice(start, end)] as const
  })
  const sections = Object.freeze(Object.fromEntries(entries)) as Readonly<Record<ReferenceSectionSlug, string>>
  if (Object.values(sections).join('') !== source) throw new Error('reference section split was not lossless')
  return sections
}

export function renderReferenceSectionIndex(origin = 'https://1f3d9.com'): string {
  return REFERENCE_SECTION_CATALOG.map(([slug]) =>
    `- ${origin}/reference/${slug}.txt`,
  ).join('\n')
}
