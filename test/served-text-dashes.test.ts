import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { PUBLIC_EXACT_READ_BUSY_MESSAGE } from '../src/public-exact-query.ts'

// The rule: long dashes (em dash, en dash, or their HTML entities) are kept out of pages
// people read. Agent-facing text is not checked: the front door, reference and llms
// sources (src/frontdoor.txt, src/reference.txt, src/llms.txt), the generated src/door.ts,
// tool descriptions, MCP server instructions, JSON refusal messages, and text kept in the
// database. A long dash there is harmless, so this test does not look at it.
//
// Text is read from string and template literals with the TypeScript parser, so code
// comments are skipped. The guarded surfaces are the two lists below.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'src')
const DASH = /[–—]|&(?:mdash|ndash|#821[12]|#x201[34]);/iu

// Files that exist only to build what people see in a browser: every literal is checked.
export const PEOPLE_PAGE_FILES: Readonly<Record<string, string>> = {
  'src/window-page.ts': 'the window page (/window)',
  'src/window-style.ts': 'the window stylesheet (CSS content text is drawn on screen)',
  'src/window-sharing.ts': 'window page titles and share titles',
  'src/window-client.ts': 'the window script sent to browsers',
  'src/window-client-safety.ts': 'the window script sent to browsers',
  'src/window-move-in.ts': 'the move-in panel on the window',
  'src/window-move-in-style.ts': 'the move-in panel stylesheet',
  'src/gazette-reading.ts': 'the Gazette reading page (/gazette/N)',
  'src/human-pages.ts': 'the about, market, tools, help and setup pages',
  'src/human-guide-document.ts': 'the shared frame of the guide pages',
  'src/human-guide-response.ts': 'the shared frame of the guide pages',
  'src/guide-style.ts': 'the guide page stylesheet',
  'src/legal.ts': 'the terms, privacy, delete and support pages',
  'src/retirement-page.ts': 'the retire form on the delete page',
  'src/identity-browser.ts': 'the join, rotate and recovery pages',
  'src/browser-identity-ui.ts': 'the shared frame of the join, rotate, recovery and sign-in pages',
  'src/browser-form.ts': 'the shared form parts of the browser pages',
  'src/browser-refusal.ts': 'the refusal parts of the browser pages',
  'src/credit-buy-page.ts': 'the buy page (/buy)',
  'src/credit-buy-client.ts': 'the buy page script sent to browsers',
  'src/credit-buy-return.ts': 'the buy page script sent to browsers',
  'src/credit-buy-style.ts': 'the buy page stylesheet',
  'src/credit-gift-redirect.ts': 'the gift page (/gift-redirect)',
  'src/treasury-page.ts': 'the treasury page (/treasury)',
  'src/community-tools-page.ts': 'the community tools page',
  'src/community-tools.ts': 'the community tool cards on the tools page and the window',
  'src/app-pages.ts': 'the pages the Android app opens',
  'src/changelog-source.ts': 'the changelog page (/changelog) shows this text',
  'src/chatgpt-steps.ts': 'ChatGPT steps shown on the window and the setup page',
  'src/move-in-copy.ts': 'move-in links and prompt shown on the window',
}

// Folders whose files exist only to build what people see.
export const PEOPLE_PAGE_FOLDERS: Readonly<Record<string, string>> = {
  'src/window-client/': 'the window script sent to browsers, including its labels and messages',
  'src/season/': 'season words, slogans and icons stamped into people pages',
}

// Files that serve agents and people both. Only their page parts are checked: any literal
// holding HTML markup, every literal inside the named page functions, and every literal
// passed to the named page calls (following a constant or function of the same file that
// the call names). Their JSON answers for agents are not checked.
type SharedFile = Readonly<{ why: string; pageFunctions?: readonly string[]; pageCalls?: readonly string[] }>
export const SHARED_FILES: Readonly<Record<string, SharedFile>> = {
  'src/index.ts': {
    why: 'the missing-page page and the /treasury page, beside JSON answers for agents',
    pageFunctions: ['missingStreetHtml', 'readTreasury'],
    pageCalls: ['c.html'],
  },
  'src/oauth.ts': {
    why: 'the chat-app sign-in pages, beside the OAuth JSON answers for agents',
    pageFunctions: ['pairingConfirmPage', 'consentPage', 'rootKeyPage', 'resumedRootKeyPage', 'geminiReadyPage'],
    pageCalls: ['html', 'browserError'],
  },
  'src/changelog.ts': {
    why: 'the changelog page, beside the /api/changelog JSON',
    pageFunctions: ['renderInlineMarkdown', 'renderChangelogBody'],
    pageCalls: ['guideDocument', 'c.html'],
  },
  'src/window.ts': {
    why: 'sends the window page, beside the /api/window JSON',
    pageCalls: ['c.html'],
  },
}

const MARKUP = /<(?:!doctype\s+html|\/?(?:html|head|body|main|section|article|header|footer|nav|aside|div|p|h[1-6]|ul|ol|li|dl|dt|dd|a|span|strong|em|small|code|pre|kbd|time|br|img|svg|title|meta|link|style|script|noscript|form|fieldset|legend|label|input|button|select|option|textarea|details|summary|table|thead|tbody|tr|th|td|figure|figcaption)\b)/iu
const SENDS_A_PAGE = /\bc\.html\(|\bguidePage\(|<!doctype html|contentType\.includes\('text\/html'\)/iu

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
}

function literalsIn(node: ts.Node): string[] {
  const found: string[] = []
  const visit = (child: ts.Node): void => {
    if (ts.isStringLiteralLike(child) || ts.isTemplateLiteralToken(child)) found.push(child.text)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function topLevelDeclarations(file: ts.SourceFile): Map<string, ts.Node> {
  const declarations = new Map<string, ts.Node>()
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration)
      }
    }
  }
  return declarations
}

function sharedPageLiterals(name: string, text: string, rule: SharedFile): string[] {
  const file = parse(name, text)
  const declarations = topLevelDeclarations(file)
  const picked = new Set<ts.Node>()
  const pick = (node: ts.Node): void => {
    if (picked.has(node)) return
    picked.add(node)
    const follow = (child: ts.Node): void => {
      if (ts.isIdentifier(child)) {
        const declaration = declarations.get(child.text)
        if (declaration) pick(declaration)
      }
      ts.forEachChild(child, follow)
    }
    follow(node)
  }
  for (const functionName of rule.pageFunctions ?? []) {
    const declaration = declarations.get(functionName)
    assert.ok(declaration, `${name}: page function ${functionName} was not found; update SHARED_FILES`)
    pick(declaration)
  }
  const calls = new Set(rule.pageCalls ?? [])
  const findCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calls.has(node.expression.getText(file))) node.arguments.forEach(pick)
    ts.forEachChild(node, findCalls)
  }
  findCalls(file)
  const markup = literalsIn(file).filter(literal => MARKUP.test(literal))
  return [...markup, ...[...picked].flatMap(literalsIn)]
}

// The literals of one source that people read; an empty list for agent-facing sources.
export function peopleLiterals(name: string, text: string): string[] {
  if (Object.hasOwn(PEOPLE_PAGE_FILES, name)) return literalsIn(parse(name, text))
  if (Object.keys(PEOPLE_PAGE_FOLDERS).some(folder => name.startsWith(folder))) return literalsIn(parse(name, text))
  const shared = SHARED_FILES[name]
  return shared ? sharedPageLiterals(name, text, shared) : []
}

export function dashOffenders(name: string, text: string): string[] {
  return peopleLiterals(name, text)
    .filter(literal => DASH.test(literal))
    .map(literal => `${name}: ${literal.trim().slice(0, 120)}`)
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|txt)$/u.test(entry.name) ? [path] : []
  })
}

function sourceName(path: string): string {
  return relative(ROOT, path).replaceAll('\\', '/')
}

function readSource(name: string): string {
  return readFileSync(join(ROOT, name), 'utf8')
}

test('no page people read carries an em dash or en dash', () => {
  const offenders = sourceFiles(SOURCE).flatMap(path => {
    const name = sourceName(path)
    return dashOffenders(name, readFileSync(path, 'utf8'))
  })
  assert.deepEqual(offenders, [])
})

test('every listed page source exists and every source that sends a page is listed', () => {
  for (const name of [...Object.keys(PEOPLE_PAGE_FILES), ...Object.keys(SHARED_FILES)]) {
    assert.ok(existsSync(join(ROOT, name)), `${name} is listed but missing; update the lists`)
  }
  for (const folder of Object.keys(PEOPLE_PAGE_FOLDERS)) {
    assert.ok(existsSync(join(ROOT, folder)), `${folder} is listed but missing; update the lists`)
  }
  const unlisted = sourceFiles(SOURCE)
    .map(sourceName)
    .filter(name => name.endsWith('.ts') && SENDS_A_PAGE.test(readSource(name)))
    .filter(name => !Object.hasOwn(PEOPLE_PAGE_FILES, name) && !Object.hasOwn(SHARED_FILES, name))
    .filter(name => !Object.keys(PEOPLE_PAGE_FOLDERS).some(folder => name.startsWith(folder)))
  assert.deepEqual(unlisted, [], 'a source that sends a page must be in PEOPLE_PAGE_FILES or SHARED_FILES')
})

test('a long dash added to a page people read fails the check', () => {
  const cases: Array<[string, string]> = [
    ['src/legal.ts', "\nexport const SCRATCH_TERMS = 'Terms — scratch'\n"],
    ['src/window-page.ts', '\nexport const SCRATCH_TITLE = `<title>Scratch &mdash; 1F3D9</title>`\n'],
    ['src/window-client/directory.ts', "\nexport const SCRATCH_LABEL = 'place – in lobby'\n"],
    ['src/oauth.ts', "\nconst SCRATCH_REFUSAL = 'Sign-in stopped — scratch'\nfunction scratch(c: Context) { return browserError(c, 400, 'credential_rejected', SCRATCH_REFUSAL) }\n"],
    ['src/oauth.ts', "\nfunction scratch(c: Context) { return html(c, 200, 'Scratch — title', '') }\n"],
    ['src/index.ts', "\nfunction scratchPage() { return '<p>Scratch &#8212; page</p>' }\n"],
  ]
  for (const [name, addition] of cases) {
    assert.deepEqual(dashOffenders(name, readSource(name)), [], `${name} must start clean`)
    assert.equal(dashOffenders(name, readSource(name) + addition).length, 1, `${name}: ${addition.trim()}`)
  }
})

test('a long dash added to agent-facing text does not fail the check', () => {
  const cases: Array<[string, string]> = [
    ['src/frontdoor.txt', '\n1F3D9 — SCRATCH LINE\n'],
    ['src/reference.txt', '\nScratch — a reference line for agents.\n'],
    ['src/llms.txt', '\nScratch — an llms line.\n'],
    ['src/door.ts', "\nexport const SCRATCH_DOOR = 'Scratch — generated door text'\n"],
    ['src/mcp.ts', "\nexport const SCRATCH_TOOL = { description: 'Look around — scratch tool description' }\n"],
    ['src/city-help.ts', "\nexport const SCRATCH_HELP = 'Help — scratch'\n"],
    ['src/public-exact-query.ts', "\nexport const SCRATCH_REFUSAL = 'busy — scratch refusal'\n"],
    ['src/index.ts', "\nfunction scratchRefusal(c: Context) { return c.json({ error: 'scratch — JSON refusal' }, 400) }\n"],
    ['src/oauth.ts', "\nfunction scratchToken(c: Context) { return c.json({ error_description: 'scratch — token error' }, 400) }\n"],
  ]
  for (const [name, addition] of cases) {
    assert.deepEqual(dashOffenders(name, readSource(name) + addition), [], `${name}: ${addition.trim()}`)
  }
})

test('the busy answer for public lists is in caller words with a next step', () => {
  assert.doesNotMatch(PUBLIC_EXACT_READ_BUSY_MESSAGE, /exact|totals|temporarily/iu)
  assert.match(PUBLIC_EXACT_READ_BUSY_MESSAGE, /busy right now/u)
  assert.match(PUBLIC_EXACT_READ_BUSY_MESSAGE, /Try again in a moment\./u)
  assert.match(PUBLIC_EXACT_READ_BUSY_MESSAGE, /one kind/u)
})
