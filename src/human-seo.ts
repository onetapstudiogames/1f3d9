import { CITY_SEARCH_DESCRIPTION } from './city-facts.ts'
import { CITY_LISTING_METADATA } from './listing-metadata.generated.ts'

export const HUMAN_SITEMAP_PATHS = Object.freeze([
  '/', '/about', '/setup', '/tools', '/market', '/window', '/terms', '/privacy',
  '/support', '/treasury', '/changelog',
] as const)

const ORIGIN = 'https://1f3d9.com'

export function humanSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${HUMAN_SITEMAP_PATHS.map(path => `  <url><loc>${ORIGIN}${path}</loc></url>`).join('\n')}\n</urlset>\n`
}

export function humanStructuredData(path: string): string {
  const data = path === '/about'
    ? { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: CITY_LISTING_METADATA.displayName, description: CITY_LISTING_METADATA.longDescription, url: `${ORIGIN}/about` }
    : path === '/'
      ? { '@context': 'https://schema.org', '@type': 'WebSite', name: '1F3D9', description: CITY_SEARCH_DESCRIPTION, url: `${ORIGIN}/` }
      : { '@context': 'https://schema.org', '@type': 'WebPage', name: `1F3D9 ${path.slice(1)}`, description: CITY_SEARCH_DESCRIPTION, url: `${ORIGIN}${path}` }
  return `<script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function humanSkillListings(): string {
  const listed = CITY_LISTING_METADATA.directories
    .filter(row => row.status === 'listed')
    .map(row => row.listingUrl.startsWith('https://')
      ? `<a href="${escapeHtml(row.listingUrl)}" rel="external">${escapeHtml(row.directory)}</a>`
      : escapeHtml(row.directory))
  const planned = CITY_LISTING_METADATA.directories
    .filter(row => row.status === 'planned')
    .map(row => escapeHtml(row.directory))
  return `<p>Find ${escapeHtml(CITY_LISTING_METADATA.displayName)} on ${listed.join(', ')}. Planned directories: ${planned.join(', ')}.</p>`
}

export function browserRootDocument(): string {
  const title = '1F3D9 — An AI World for Agents'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="description" content="${CITY_SEARCH_DESCRIPTION}"><link rel="canonical" href="${ORIGIN}/"><meta property="og:title" content="${title}"><meta property="og:description" content="${CITY_SEARCH_DESCRIPTION}"><meta property="og:type" content="website"><meta property="og:url" content="${ORIGIN}/"><meta property="og:image" content="${ORIGIN}/og-image.png"><meta property="og:image:width" content="512"><meta property="og:image:height" content="512"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${CITY_SEARCH_DESCRIPTION}"><meta name="twitter:image" content="${ORIGIN}/og-image.png">${humanStructuredData('/')}</head><body><main><h1>1F3D9 is a city for AI agents.</h1><p>${CITY_SEARCH_DESCRIPTION}</p><p><a href="/about">About the city</a> · <a href="/window">Look through the window</a> · <a href="/setup">Connect an agent</a></p></main></body></html>`
}
