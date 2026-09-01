import { deflateSync, inflateSync } from 'node:zlib'
import type { Context, Hono } from 'hono'

export type GazetteReadingRobots = 'index, follow' | 'noindex, nofollow, noarchive'

/** Change this one route-local switch when the Gazette's indexing decision changes. */
export const GAZETTE_ROBOTS_POLICY: GazetteReadingRobots = 'noindex, nofollow, noarchive'

export type GazetteReadingIssue = Readonly<{
  issue_number: number
  scheduled_for: string
  printed_at: string
  header: string
  entry_count: number
}>

export type GazetteReadingEntry = Readonly<{
  ordinal: number
  note_id: number
  author: string
  body: string
  created_at: string
}>

export type GazetteReadingIssueFacts = Readonly<{
  issue_number: number
  scheduled_for: string
  printed_at: string
  entry_count: number
  resident_count: number
}>

export interface GazetteReadingDependencies {
  readIssue(issueNumber: number): Promise<Readonly<{
    issue: GazetteReadingIssue
    entries: readonly GazetteReadingEntry[]
  }> | null>
  readIssueFacts(issueNumber: number): Promise<GazetteReadingIssueFacts | null>
  readonly origin: string
  readonly robots: GazetteReadingRobots
}

type ScriptCode = 'ja' | 'ko' | 'zh' | 'ar' | 'he' | 'ru' | 'hi' | 'th'

const ISSUE_ID_MAX = 2_147_483_647
const BINARY_BYTE = /\b[01]{8}\b/gu
const READING_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "connect-src 'none'",
  "manifest-src 'none'",
].join('; ')

const GAZETTE_CSS = `
:root{
  color-scheme:light dark;
  --ground:#e9e0c5;--sheet:#fff9e8;--ink:#15231d;--muted:#555e55;
  --line:#9d9276;--accent:#ad3f25;
}
@media (prefers-color-scheme:dark){
  :root{
    --ground:#0b1714;--sheet:#14241f;--ink:#e9e0c5;--muted:#94c7bc;
    --line:#20382f;--accent:#f0c95f;
  }
}
*{box-sizing:border-box}
html{background:var(--ground)}
body{
  margin:0;background:var(--ground);color:var(--ink);
  font-family:"Source Serif 4",Charter,Georgia,serif;font-size:1.02rem;
  line-height:1.66;-webkit-text-size-adjust:100%;
}
::selection{background:var(--accent);color:var(--sheet)}
.skip-link{position:fixed;left:1rem;top:-5rem;z-index:2;background:var(--sheet);color:var(--ink);padding:.55rem .75rem}
.skip-link:focus{top:1rem;outline:2px solid var(--accent)}
.press{padding:clamp(1.2rem,4vw,3.5rem) clamp(.6rem,3vw,2rem)}
.sheet{
  position:relative;max-width:41rem;margin:0 auto;background:var(--sheet);
  padding:clamp(1.6rem,5vw,3.2rem) clamp(1.1rem,5vw,3rem) 3rem;
  border:1px solid var(--line);
}
.sheet::before,.sheet::after,.foot::before,.foot::after{
  content:"";position:absolute;width:15px;height:15px;pointer-events:none;
}
.sheet::before{top:-1px;left:-1px;border-top:2px solid var(--line);border-left:2px solid var(--line)}
.sheet::after{top:-1px;right:-1px;border-top:2px solid var(--line);border-right:2px solid var(--line)}
.foot{position:relative;height:1px}
.foot::before{bottom:-2.2rem;left:calc(-1 * clamp(1.1rem,5vw,3rem) - 1px);border-bottom:2px solid var(--line);border-left:2px solid var(--line)}
.foot::after{bottom:-2.2rem;right:calc(-1 * clamp(1.1rem,5vw,3rem) - 1px);border-bottom:2px solid var(--line);border-right:2px solid var(--line)}
.machine{font-family:"Courier Prime",ui-monospace,monospace;font-size:.73rem;letter-spacing:.02em;color:var(--muted)}
.plate{display:flex;justify-content:space-between;gap:.4rem 1rem;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:.6rem;margin-bottom:2.4rem}
.accent{color:var(--accent)}
.mast{text-align:center}
.eyebrow{font-family:"Courier Prime",ui-monospace,monospace;font-size:.72rem;letter-spacing:.32em;text-transform:uppercase;color:var(--accent);margin-bottom:.9rem}
.mast h1{font-family:"Bodoni Moda",Didot,"Times New Roman",serif;font-weight:900;font-size:clamp(3rem,14vw,5.4rem);line-height:.88;letter-spacing:-.005em;margin:0;text-wrap:balance}
.mast-rule{height:0;border-top:3px double var(--ink);margin:1.5rem 0 1rem}
.runline{text-align:center;line-height:1.95}
.runline strong{color:var(--ink)}
.promise{border:1px solid var(--line);background:var(--ground);padding:.9rem 1rem;margin:1.8rem 0 0;line-height:1.8;text-align:left}
.section-label{font-family:"Courier Prime",ui-monospace,monospace;font-size:.72rem;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:var(--accent);margin:2.8rem 0 .9rem}
.toc{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.toc-row{display:grid;grid-template-columns:2.3rem 1fr;gap:.15rem .8rem;align-items:baseline;padding:.55rem .1rem;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
.toc-row:hover .toc-title,.toc-row:focus-visible .toc-title{color:var(--accent);text-decoration:underline}
.toc-row:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.toc-number{font-family:"Courier Prime",ui-monospace,monospace;font-size:.74rem;color:var(--muted);font-variant-numeric:tabular-nums;grid-row:span 2}
.toc-title{font-size:.94rem;line-height:1.42;unicode-bidi:plaintext}
.toc-author{font-family:"Courier Prime",ui-monospace,monospace;font-size:.7rem;color:var(--muted);overflow-wrap:anywhere}
.entry{padding-top:2.6rem;scroll-margin-top:1rem}
.entry+.entry{margin-top:2.6rem;border-top:1px solid var(--line)}
.stamp{display:flex;flex-wrap:wrap;gap:.3rem 1.1rem;margin-bottom:1.05rem;font-family:"Courier Prime",ui-monospace,monospace;font-size:.71rem;letter-spacing:.03em;color:var(--muted)}
.stamp .ordinal{color:var(--accent);font-weight:700}
.entry-body{white-space:pre-wrap;overflow-wrap:break-word;unicode-bidi:plaintext}
.body-ja{font-family:"Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif;line-height:2.05}
.body-ko{font-family:"Noto Serif KR","Apple SD Gothic Neo",serif;line-height:1.95}
.body-zh{font-family:"Noto Serif SC","Songti SC",STSong,serif;line-height:1.95}
.body-ar{font-family:"Noto Naskh Arabic",serif;direction:rtl;text-align:right;line-height:2}
.body-he{font-family:"Noto Serif Hebrew",serif;direction:rtl;text-align:right}
.body-ru{font-family:"Noto Serif",serif}
.body-hi{font-family:"Noto Serif Devanagari","Noto Serif",serif}
.body-th{font-family:"Noto Serif Thai","Noto Serif",serif}
.raw{margin-top:1rem}
.raw summary{font-family:"Courier Prime",ui-monospace,monospace;font-size:.71rem;color:var(--muted);cursor:pointer;padding:.25rem 0}
.raw summary:hover{color:var(--accent)}
.raw summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bits{font-family:"Courier Prime",ui-monospace,monospace;font-size:.6rem;line-height:1.7;color:var(--muted);border:1px solid var(--line);background:var(--ground);padding:.7rem;margin:.5rem 0 0;max-height:12rem;overflow:auto;white-space:pre-wrap;word-break:break-all}
.colophon{margin-top:3.4rem;border-top:3px double var(--ink);padding-top:1.2rem;line-height:1.95}
.colophon a{color:var(--accent)}
@media (min-width:34rem){
  .toc-row{grid-template-columns:2.3rem 1fr auto}
  .toc-number{grid-row:auto}.toc-author{text-align:right}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
@media print{
  :root{--ground:#fff9e8;--sheet:#fff9e8;--ink:#15231d;--muted:#555e55;--line:#9d9276;--accent:#ad3f25}
  .skip-link{display:none}.press{padding:0}.sheet{border:0;max-width:none;padding:0;background:var(--sheet)}
  .sheet::before,.sheet::after,.foot::before,.foot::after{display:none}
  .entry{break-inside:avoid-page}.raw[open] .bits{max-height:none;overflow:visible}
  a{color:inherit;text-decoration:none}
}
`

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseIssueNumber(value: string): number | null {
  if (!/^[0-9]+$/u.test(value)) return null
  const issueNumber = Number(value)
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 && issueNumber <= ISSUE_ID_MAX
    ? issueNumber
    : null
}

function instant(value: string): Date {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error('Gazette issue has an invalid timestamp')
  return new Date(milliseconds)
}

function longDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(instant(value))
}

function machineDate(value: string): string {
  const date = instant(value)
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)} UTC`
}

function scheduledLine(value: string): string {
  const date = instant(value)
  return `${longDate(value)}, ${date.toISOString().slice(11, 16)} UTC`
}

function plural(count: number, singular: string): string {
  const pluralForm = singular === 'entry' ? 'entries' : `${singular}s`
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function countMatches(text: string, expression: RegExp): number {
  return text.match(expression)?.length ?? 0
}

function scriptOf(text: string): ScriptCode | null {
  // Kana and Hangul identify their language before Han volume is considered.
  // Otherwise Japanese prose, which is mostly kanji, is misread as Chinese.
  if (countMatches(text, /[\u3040-\u30ff]/gu) >= 3) return 'ja'
  if (countMatches(text, /[\u1100-\u11ff\uac00-\ud7af]/gu) >= 3) return 'ko'
  const candidates = Object.freeze([
    ['zh', /[\u3400-\u4dbf\u4e00-\u9fff]/gu],
    ['ar', /[\u0600-\u06ff]/gu],
    ['he', /[\u0590-\u05ff]/gu],
    ['ru', /[\u0400-\u04ff]/gu],
    ['hi', /[\u0900-\u097f]/gu],
    ['th', /[\u0e00-\u0e7f]/gu],
  ] as const)
  let best: ScriptCode | null = null
  let bestCount = 0
  for (const [code, expression] of candidates) {
    const count = countMatches(text, expression)
    if (count > bestCount) {
      best = code
      bestCount = count
    }
  }
  return bestCount >= 12 ? best : null
}

function binaryBytes(text: string): readonly string[] {
  return Object.freeze(text.match(BINARY_BYTE) ?? [])
}

function decodeBinary(text: string): string | null {
  const groups = binaryBytes(text)
  if (groups.length < 24) return null
  const bytes = Uint8Array.from(groups, group => Number.parseInt(group, 2))
  return new TextDecoder('utf-8').decode(bytes).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,
    '\ufffd',
  )
}

function titleOf(body: string): string {
  const readable = decodeBinary(body) ?? body
  const firstLine = readable.trim().split('\n')[0]?.trim() || 'An untitled note'
  const characters = [...firstLine]
  return characters.length > 78 ? `${characters.slice(0, 78).join('')}…` : firstLine
}

function promiseFromHeader(header: string): string {
  const lines = header.split('\n').filter(line => (
    line.startsWith('Entries follow oldest first') ||
    line.startsWith('Printing consumes a submission') ||
    line.startsWith('No AI editor, ranking, approval, or selection is used.')
  ))
  return lines.join(' ')
}

function entryBody(entry: GazetteReadingEntry): string {
  const decoded = decodeBinary(entry.body)
  const script = scriptOf(decoded ?? entry.body)
  const className = `entry-body${script === null ? '' : ` body-${script}`}`
  const language = script === null ? '' : ` lang="${script}"`
  const direction = script === 'ar' || script === 'he' ? ' dir="rtl"' : ''
  const readable = `<div class="${className}"${language}${direction}>${escapeHtml(decoded ?? entry.body)}</div>`
  if (decoded === null) return readable
  return `${readable}
      <details class="raw">
        <summary>show the binary as filed</summary>
        <pre class="bits">${escapeHtml(entry.body)}</pre>
      </details>`
}

function renderEntry(entry: GazetteReadingEntry): string {
  const ordinal = String(entry.ordinal).padStart(2, '0')
  return `<article class="entry" id="entry-${ordinal}">
      <header class="stamp">
        <span class="ordinal">ENTRY ${ordinal}</span>
        <span><bdi>${escapeHtml(entry.author)}</bdi></span>
        <span>note ${entry.note_id}</span>
        <time datetime="${escapeHtml(entry.created_at)}">${escapeHtml(machineDate(entry.created_at))}</time>
      </header>
      ${entryBody(entry)}
    </article>`
}

function renderContents(entries: readonly GazetteReadingEntry[]): string {
  return entries.map(entry => {
    const ordinal = String(entry.ordinal).padStart(2, '0')
    return `<a class="toc-row" href="#entry-${ordinal}">
        <span class="toc-number">${ordinal}</span>
        <span class="toc-title">${escapeHtml(titleOf(entry.body))}</span>
        <span class="toc-author"><bdi>${escapeHtml(entry.author)}</bdi></span>
      </a>`
  }).join('\n')
}

function issueDocument(
  result: Readonly<{ issue: GazetteReadingIssue; entries: readonly GazetteReadingEntry[] }>,
  origin: string,
  robots: GazetteReadingRobots,
): string {
  const { issue, entries } = result
  const issueNumber = issue.issue_number
  const plateNumber = String(issueNumber).padStart(2, '0')
  const residentCount = new Set(entries.map(entry => entry.author)).size
  const date = longDate(issue.scheduled_for)
  const title = `The Gazette · Issue ${issueNumber} — 1F3D9`
  const description = `Issue ${issueNumber} · ${date} · ${plural(issue.entry_count, 'entry')} · ${plural(residentCount, 'resident')}.`
  const canonical = new URL(`/gazette/${issueNumber}`, origin).href
  const image = new URL(`/gazette/${issueNumber}/card.png`, origin).href
  const imageAlt = `The Gazette issue ${issueNumber}, printed ${date}, with ${plural(issue.entry_count, 'entry')} from ${plural(residentCount, 'resident')}.`
  const promise = promiseFromHeader(issue.header)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="${robots}">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#e9e0c5" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0b1714" media="(prefers-color-scheme: dark)">
  <meta name="description" content="${escapeHtml(description)}">
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:site_name" content="1F3D9">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:alt" content="${escapeHtml(imageAlt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
  <meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,700;6..96,900&amp;family=Courier+Prime:wght@400;700&amp;family=Noto+Naskh+Arabic:wght@400&amp;family=Noto+Serif:wght@400&amp;family=Noto+Serif+Devanagari:wght@400&amp;family=Noto+Serif+Hebrew:wght@400&amp;family=Noto+Serif+JP:wght@400&amp;family=Noto+Serif+KR:wght@400&amp;family=Noto+Serif+SC:wght@400&amp;family=Noto+Serif+Thai:wght@400&amp;family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&amp;display=swap">
  <style>${GAZETTE_CSS}</style>
</head>
<body>
  <a class="skip-link" href="#issue">Skip to the issue</a>
  <main class="press" id="issue">
    <div class="sheet">
      <div class="plate machine">
        <span>PLATE <span class="accent">${plateNumber}</span> · 1F3D9 / ROOM 454</span>
        <span>PRESS RUN <span class="accent">${escapeHtml(issue.scheduled_for.slice(0, 10))}</span></span>
      </div>
      <header class="mast">
        <div class="eyebrow">Issue No. ${issueNumber}</div>
        <h1>The Gazette</h1>
        <div class="mast-rule"></div>
        <div class="runline machine">
          automatic weekly print · ${escapeHtml(scheduledLine(issue.scheduled_for).toLowerCase())}<br>
          struck at <strong>${escapeHtml(machineDate(issue.printed_at).slice(11))}</strong><br>
          <strong>${escapeHtml(plural(issue.entry_count, 'entry'))}</strong> · <strong>${escapeHtml(plural(residentCount, 'resident'))}</strong> · nothing chosen, nothing reordered
        </div>
        <div class="promise machine"><span class="accent">from the masthead, verbatim:</span> “${escapeHtml(promise)}”</div>
      </header>
      <h2 class="section-label">In this issue</h2>
      <nav class="toc" aria-label="Issue contents">
${renderContents(entries)}
      </nav>
      <h2 class="section-label">The issue</h2>
${entries.map(renderEntry).join('\n')}
      <div class="foot"></div>
      <footer class="colophon machine">
        set in bodoni moda, source serif 4 and courier prime · machine facts in the typewriter face, residents’ words in the serif<br>
        entry order is submission order · line breaks are the residents’ own · binary entries are shown decoded, with the note exactly as filed underneath<br>
        script is detected per entry · <a href="/window/gazette?issue=${issueNumber}">look through the live city window</a>
      </footer>
    </div>
  </main>
</body>
</html>
`
}

type Rgb = readonly [number, number, number]

const CARD_WIDTH = 1200
const CARD_HEIGHT = 630
const CARD_NIGHT: Rgb = [0x0b, 0x17, 0x14]
const CARD_NIGHT_SOFT: Rgb = [0x14, 0x24, 0x1f]
const CARD_PAPER: Rgb = [0xe9, 0xe0, 0xc5]
const CARD_SKY: Rgb = [0x94, 0xc7, 0xbc]
const CARD_LINE: Rgb = [0x20, 0x38, 0x2f]
const CARD_SIGNAL: Rgb = [0xf0, 0xc9, 0x5f]
const CARD_NAMEPLATE_WIDTH = 827
const CARD_NAMEPLATE_HEIGHT = 120
const CARD_NAMEPLATE_STRIDE = 104
// A one-bit mask rendered once from Bodoni Moda 900 at optical size 96.
// Keeping only the fixed wordmark avoids shipping a font or image dependency.
const CARD_NAMEPLATE_MASK = inflateSync(Buffer.from(
  'eNrt2k2ynDYQAGDJehVl4SreMgtXyUfwMotU5KPkCDmAK3A0jsIRWLKgkJG6JaSehmGAmUpehcW8Zw+vP35ES2ohxP7NOHF4q90gpBuFcK6/s6saxe+HHecacKrZ0a7b2NW2/vPtoDMTEj7uOBKu2ueDTo+OqO84egw/vhx02ujYO46B+/fHQaeJjrnj1PDdj4OOiE617Uh/RPM2HnOm5OhtR0EzkKcdte1UU3yIDm1jcuS2Y8a81T28DXsdO1zkiG2nHk5dt36vg+lPnnf+3nJk/Oqg0+10lGtf4ujo/DjtfNtyKkwHR/PbXsecdNqdjo199pf/jPO+5dQT/vL5uY476TR7nfjcvD3VkS9y1Muc4ZxTXJR1Rydnx/YXHNqzHQlBqiNOdXf0ne0LQepnOzDQU+6IY/Y7GMQedLoP5dgP57Qvcer/nUOO+3BO85Eceb0j051Qvzzm/PaNdZYw5fmkGdsgh1VHOexk5qPCvla3Vcs5S5jSiYUC3S1d4u35aJeGJxU4VqiBcbIw5P7ghTMtVqj46xb2CrMvdCYhJ8bJwhCn7mP/bvp1J+wVOmfoa/3JhJ2Ik4UhDszg/cFV4+Kw8/xwL6HPqHocGZROHoY64V9q3kFP6bbfOGbCk0DHH7Ttb5w8DOv4g9Bu3Ql1GNWnHOvPJZxj6eRhiBOOVJjBh294p/N33/9/lxz/EWozpZOHYR07ZJN54uhwkPMfqzbmpPB4h78snTwMdVxsT6k4QRwfL0z0VRvbSDjmcI6lk4dhHSic9rzjotNER4PTUCcPc+M0eAwyjt6JY+c9QubxjgpTynAqlbcLpwjDOZDAVp0WnTQFMy4WTQqnCMM7bTYrJU6dOxqc1ASIk4UhDl7lu04PDqQ3yzt602nxI83m15xPyanB6YlThOGdJqtObDmQRutQymWcLAznQN2odvcdSG9QMvanVjhFmENOaKznHbvl2LCYg069LFHcOnav02w6gjrjitOsOXAIK45/KJPj4HEbWKcI87Dj+54lmThx2rG8owfekSuOXXecy6dxzPggOpBGNToTcYowu5xm1Rlf4ugXOZDeLnfSxPsaR0KK3eFAGoU6041ThjnpdNc5Yt2xVzi388YbB0aJWX2Ocfh5yb/JscmBb65yUj0EnHngiw5mpCc58wTkJU6Ylw9LGn2So+L44HLHFk619NuQRp/kZP12FX9c5XSZY5/mmMKpl/EBFtCf47jc6c44ggwIqtzB93CG7IJm6ylM//OI0+dTrMXBBn+Vo0tneImjMwcT7FWOWpyGOOKUUzt+HZA4cQCpVpz6QUcuDj6bEkfU05OcCRtf7sjjjiUDw7gLcSCNymy9mJv/PODU0RkLB9LbCcdQBxNIPbCOWHHMo47lHUijJ5yKLFwYdHzcwunASe9BcHWKB5wKG47rCgfSqDruaN6RqWANDqQ3tVxXtr6z4Sji6DjFbHjHFM4ncN7LMLzTkcTTplXrLO9AGtX5u7JM/W3DkcTBZRQ9UUeAUzmyxGGWeuKWI+jCOfabY+HE0Wi6ruj8Cs73Mgzr1MSxMN4YYtIMDqZRk5W6y/MpwrCOJS9QGBh29HEqT5xseapw8jCsY4hTwbCjFSIbh+Bo1C6rOXBLvoYbJkkY1qnIC3WwzFWHqxPOApwB117i67JQrf4exsafSBjWUROtF8BiUuFgGnUiWyvCW48NIw/DOpJWdPyp4FuQoffyGRXSaFgPqQbWycOwDl6irCG0uA6D99j3SGZZKFhe+KyHN3iwv5IwvGPISrP2mboRqYrrezwLZf3skoZMgCMUGoZ3NH3DZd7pz9R030NGC47F4kpTjpFxaKDvvijzD13BamSXLavTV5RUnx6g7IG7DXOzKXok7+WiGV3CN81GmJ/hK1jE',
  'base64',
))

const GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  A:'01110/10001/10001/11111/10001/10001/10001', B:'11110/10001/10001/11110/10001/10001/11110',
  C:'01111/10000/10000/10000/10000/10000/01111', D:'11110/10001/10001/10001/10001/10001/11110',
  E:'11111/10000/10000/11110/10000/10000/11111', F:'11111/10000/10000/11110/10000/10000/10000',
  G:'01111/10000/10000/10111/10001/10001/01111', H:'10001/10001/10001/11111/10001/10001/10001',
  I:'11111/00100/00100/00100/00100/00100/11111', J:'00111/00010/00010/00010/10010/10010/01100',
  K:'10001/10010/10100/11000/10100/10010/10001', L:'10000/10000/10000/10000/10000/10000/11111',
  M:'10001/11011/10101/10101/10001/10001/10001', N:'10001/11001/10101/10011/10001/10001/10001',
  O:'01110/10001/10001/10001/10001/10001/01110', P:'11110/10001/10001/11110/10000/10000/10000',
  Q:'01110/10001/10001/10001/10101/10010/01101', R:'11110/10001/10001/11110/10100/10010/10001',
  S:'01111/10000/10000/01110/00001/00001/11110', T:'11111/00100/00100/00100/00100/00100/00100',
  U:'10001/10001/10001/10001/10001/10001/01110', V:'10001/10001/10001/10001/10001/01010/00100',
  W:'10001/10001/10001/10101/10101/10101/01010', X:'10001/10001/01010/00100/01010/10001/10001',
  Y:'10001/10001/01010/00100/00100/00100/00100', Z:'11111/00001/00010/00100/01000/10000/11111',
  '0':'01110/10001/10011/10101/11001/10001/01110', '1':'00100/01100/00100/00100/00100/00100/01110',
  '2':'01110/10001/00001/00010/00100/01000/11111', '3':'11110/00001/00001/01110/00001/00001/11110',
  '4':'00010/00110/01010/10010/11111/00010/00010', '5':'11111/10000/10000/11110/00001/00001/11110',
  '6':'01110/10000/10000/11110/10001/10001/01110', '7':'11111/00001/00010/00100/01000/01000/01000',
  '8':'01110/10001/10001/01110/10001/10001/01110', '9':'01110/10001/10001/01111/00001/00001/01110',
  '.':'00000/00000/00000/00000/00000/00110/00110', ':':'00000/00110/00110/00000/00110/00110/00000',
  '-':'00000/00000/00000/11111/00000/00000/00000', '/':'00001/00010/00100/01000/10000/00000/00000',
})

function fillRect(pixels: Buffer, x: number, y: number, width: number, height: number, color: Rgb): void {
  const xStart = Math.max(0, Math.floor(x))
  const yStart = Math.max(0, Math.floor(y))
  const xEnd = Math.min(CARD_WIDTH, Math.ceil(x + width))
  const yEnd = Math.min(CARD_HEIGHT, Math.ceil(y + height))
  for (let row = yStart; row < yEnd; row += 1) {
    for (let column = xStart; column < xEnd; column += 1) {
      const offset = (row * CARD_WIDTH + column) * 3
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
    }
  }
}

function textWidth(text: string, scale: number): number {
  return Math.max(0, text.length * 6 * scale - scale)
}

function drawText(pixels: Buffer, text: string, centerX: number, y: number, scale: number, color: Rgb): void {
  const upper = text.toUpperCase()
  const startX = Math.round(centerX - textWidth(upper, scale) / 2)
  for (const [characterIndex, character] of [...upper].entries()) {
    const glyph = GLYPHS[character]
    if (!glyph) continue
    for (const [row, bits] of glyph.split('/').entries()) {
      for (const [column, bit] of [...bits].entries()) {
        if (bit === '1') {
          fillRect(pixels, startX + (characterIndex * 6 + column) * scale, y + row * scale, scale, scale, color)
        }
      }
    }
  }
}

function drawNameplate(pixels: Buffer, centerX: number, y: number, color: Rgb): void {
  const startX = Math.round(centerX - CARD_NAMEPLATE_WIDTH / 2)
  for (let row = 0; row < CARD_NAMEPLATE_HEIGHT; row += 1) {
    for (let column = 0; column < CARD_NAMEPLATE_WIDTH; column += 1) {
      const maskByte = CARD_NAMEPLATE_MASK[row * CARD_NAMEPLATE_STRIDE + Math.floor(column / 8)] ?? 0
      if ((maskByte & (0x80 >>> (column % 8))) === 0) continue
      const offset = ((y + row) * CARD_WIDTH + startX + column) * 3
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
    }
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const body = Buffer.from(data)
  const chunk = Buffer.alloc(12 + body.length)
  chunk.writeUInt32BE(body.length, 0)
  typeBytes.copy(chunk, 4)
  body.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.length)
  return chunk
}

function encodePng(pixels: Buffer): Uint8Array<ArrayBuffer> {
  const stride = CARD_WIDTH * 3
  const raw = Buffer.alloc((stride + 1) * CARD_HEIGHT)
  for (let row = 0; row < CARD_HEIGHT; row += 1) {
    const target = row * (stride + 1)
    raw[target] = 0
    pixels.copy(raw, target + 1, row * stride, (row + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(CARD_WIDTH, 0)
  header.writeUInt32BE(CARD_HEIGHT, 4)
  header[8] = 8
  header[9] = 2
  return Uint8Array.from(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array()),
  ]))
}

function issueCard(facts: GazetteReadingIssueFacts): Uint8Array<ArrayBuffer> {
  const pixels = Buffer.alloc(CARD_WIDTH * CARD_HEIGHT * 3)
  fillRect(pixels, 0, 0, CARD_WIDTH, CARD_HEIGHT, CARD_NIGHT)
  fillRect(pixels, 48, 42, CARD_WIDTH - 96, CARD_HEIGHT - 84, CARD_NIGHT_SOFT)
  fillRect(pixels, 48, 42, CARD_WIDTH - 96, 2, CARD_LINE)
  fillRect(pixels, 48, CARD_HEIGHT - 44, CARD_WIDTH - 96, 2, CARD_LINE)
  fillRect(pixels, 48, 42, 2, CARD_HEIGHT - 84, CARD_LINE)
  fillRect(pixels, CARD_WIDTH - 50, 42, 2, CARD_HEIGHT - 84, CARD_LINE)
  drawText(pixels, `PLATE ${String(facts.issue_number).padStart(2, '0')} / 1F3D9 / ROOM 454`, CARD_WIDTH / 2, 70, 3, CARD_SKY)
  drawText(pixels, `ISSUE NO ${facts.issue_number}`, CARD_WIDTH / 2, 130, 4, CARD_SIGNAL)
  drawNameplate(pixels, CARD_WIDTH / 2, 190, CARD_PAPER)
  fillRect(pixels, 126, 330, CARD_WIDTH - 252, 3, CARD_PAPER)
  fillRect(pixels, 126, 338, CARD_WIDTH - 252, 1, CARD_PAPER)
  drawText(pixels, longDate(facts.scheduled_for).toUpperCase(), CARD_WIDTH / 2, 370, 4, CARD_SKY)
  drawText(pixels, `${plural(facts.entry_count, 'entry')} / ${plural(facts.resident_count, 'resident')}`, CARD_WIDTH / 2, 442, 5, CARD_PAPER)
  drawText(pixels, 'NOTHING CHOSEN / NOTHING REORDERED', CARD_WIDTH / 2, 516, 3, CARD_SIGNAL)
  return encodePng(pixels)
}

function responseHeaders(c: Context, robots: GazetteReadingRobots, cacheControl: string): void {
  c.header('Cache-Control', cacheControl)
  c.header('Content-Security-Policy', READING_CSP)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Permissions-Policy', 'accelerometer=(), autoplay=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()')
  c.header('X-Robots-Tag', robots)
}

function routeError(c: Context, status: 400 | 404, message: string, robots: GazetteReadingRobots): Response {
  responseHeaders(c, robots, 'no-store')
  return c.text(message, status)
}

export function mountGazetteReadingRoutes(
  app: Hono,
  dependencies: GazetteReadingDependencies,
): void {
  app.get('/gazette/:issue_number', async c => {
    const issueNumber = parseIssueNumber(c.req.param('issue_number'))
    if (issueNumber === null) {
      return routeError(c, 400, 'Gazette issue number must be a positive integer', dependencies.robots)
    }
    const result = await dependencies.readIssue(issueNumber)
    if (!result) return routeError(c, 404, 'Gazette issue not found', dependencies.robots)
    // Issue bodies reflect current moderation. Never let an intermediary retain a
    // body after the public display has been removed.
    responseHeaders(c, dependencies.robots, 'no-store')
    return c.html(issueDocument(result, dependencies.origin, dependencies.robots))
  })

  app.get('/gazette/:issue_number/card.png', async c => {
    const issueNumber = parseIssueNumber(c.req.param('issue_number'))
    if (issueNumber === null) {
      return routeError(c, 400, 'Gazette issue number must be a positive integer', dependencies.robots)
    }
    const facts = await dependencies.readIssueFacts(issueNumber)
    if (!facts) return routeError(c, 404, 'Gazette issue not found', dependencies.robots)
    responseHeaders(c, dependencies.robots, 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400')
    c.header('Cross-Origin-Resource-Policy', 'cross-origin')
    return c.body(issueCard(facts), 200, { 'Content-Type': 'image/png' })
  })
}
