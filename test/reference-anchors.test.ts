import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { REFERENCE, REFERENCE_INDEX, REFERENCE_SECTIONS } from '../src/door.ts'
import {
  annotateReferenceAnchors,
  assertReferenceAnchorCatalog,
  REFERENCE_ANCHOR_CATALOG,
  referenceCitation,
  renderReferenceIndex,
  splitReferenceSections,
  type ReferenceAnchor,
} from '../src/reference-sections.ts'

const referenceSource = readFileSync(new URL('../src/reference.txt', import.meta.url), 'utf8')

const citedHeadings = (page: string): readonly { heading: string; citation: string }[] => {
  const lines = page.split('\n')
  const found: { heading: string; citation: string }[] = []
  for (const [index, line] of lines.entries()) {
    if (!/^(?:={3,}|-{3,}|~{3,})$/u.test(line)) continue
    const heading = lines[index - 1]
    const cite = lines[index + 1]
    assert.ok(heading !== undefined && heading.trim() !== '', `underline with no heading: ${line}`)
    assert.ok(cite !== undefined && cite.startsWith('cite: '), `heading without an anchor: ${heading}`)
    found.push({ heading, citation: cite.slice('cite: '.length) })
  }
  return found
}

const FIRST_PAGE: readonly ReferenceAnchor[] = Object.freeze([
  { anchor: 'front', page: 'front', heading: 'FRONT' },
  { anchor: 'pick-a-name', page: 'front', heading: 'PICK A NAME' },
  { anchor: 'back', page: 'back', heading: 'BACK' },
])
const FIRST_SOURCE = 'FRONT\n-----\nfront text\n\nPICK A NAME\n~~~~~~~~~~~\nname text\n\nBACK\n----\nback text\n'
const MOVED_SOURCE = 'FRONT\n-----\nfront text\n\nBACK\n----\nback text\n\nPICK A NAME\n~~~~~~~~~~~\nname text\n'

const pagesOf = (source: string, catalog: readonly ReferenceAnchor[]) =>
  splitReferenceSections(annotateReferenceAnchors(source, catalog), catalog, 'https://1f3d9.com')

test('every reference page prints one permanent anchor at every section', () => {
  assertReferenceAnchorCatalog()
  const citations = new Set<string>()
  const headings = new Set<string>()
  for (const [page, text] of Object.entries(REFERENCE_SECTIONS)) {
    const sections = citedHeadings(text)
    assert.ok(sections.length >= 1, page)
    assert.equal(sections[0]!.citation, page, `${page} must open with its own anchor`)
    for (const section of sections) {
      assert.ok(!citations.has(section.citation), `duplicate citation ${section.citation}`)
      assert.ok(!headings.has(section.heading), `duplicate heading ${section.heading}`)
      citations.add(section.citation)
      headings.add(section.heading)
      const entry = REFERENCE_ANCHOR_CATALOG.find(row => referenceCitation(row) === section.citation)
      assert.ok(entry !== undefined, `citation ${section.citation} is not in the registry`)
      assert.equal(entry.heading, section.heading)
      assert.equal(entry.page, page)
    }
  }
  assert.equal(citations.size, REFERENCE_ANCHOR_CATALOG.length)
  assert.deepEqual(
    citedHeadings(REFERENCE).map(section => section.citation),
    REFERENCE_ANCHOR_CATALOG.map(entry => referenceCitation(entry)),
  )
  assert.equal(
    citedHeadings(annotateReferenceAnchors(referenceSource)).length,
    REFERENCE_ANCHOR_CATALOG.length,
  )
})

test('a reworded heading keeps its anchor and prints the wording it had before', () => {
  const live = REFERENCE_SECTIONS['live-page']!
  assert.match(live, /^THE STANDALONE LIVE PAGE\n-+\ncite: live-page\nwas: THE LIVE CARTOGRAPHIC PLATE\n/u)
})

test('the reference index states the citing rule and lists every anchor', () => {
  assert.match(REFERENCE_INDEX, /name the page, and for a section inside that page/u)
  assert.match(REFERENCE_INDEX, /moving-in#pick-your-name/u)
  assert.match(REFERENCE_INDEX, /Cite anchors, never line numbers or a quoted sentence/u)
  for (const entry of REFERENCE_ANCHOR_CATALOG) {
    assert.ok(REFERENCE_INDEX.includes(`    cite: ${referenceCitation(entry)}\n`), entry.anchor)
  }
})

test('a section moved to another page keeps its anchor and the old page points forward', () => {
  const before = pagesOf(FIRST_SOURCE, FIRST_PAGE)
  assert.ok(before['front']!.includes('cite: front#pick-a-name'))
  assert.ok(!before['back']!.includes('pick-a-name'))

  const moved: readonly ReferenceAnchor[] = [
    { anchor: 'front', page: 'front', heading: 'FRONT' },
    { anchor: 'back', page: 'back', heading: 'BACK' },
    { anchor: 'pick-a-name', page: 'back', heading: 'PICK A NAME', movedFrom: ['front'] },
  ]
  const after = pagesOf(MOVED_SOURCE, moved)
  assert.ok(after['back']!.includes('cite: back#pick-a-name'), 'the anchor survives the move')
  assert.ok(after['back']!.includes('name text'), 'the text moved with it')
  assert.ok(
    after['front']!.includes('moved: pick-a-name is now cited as back#pick-a-name'),
    'the old page says where the section went',
  )
  assert.ok(after['front']!.includes('and is read at https://1f3d9.com/reference/back.txt'))
})

test('the build refuses a duplicated, recycled, or unregistered anchor', () => {
  const duplicated: readonly ReferenceAnchor[] = [
    ...FIRST_PAGE,
    { anchor: 'front', page: 'back', heading: 'AGAIN' },
  ]
  assert.throws(
    () => assertReferenceAnchorCatalog(duplicated),
    /anchor front is used twice/u,
  )

  const recycled: readonly ReferenceAnchor[] = [
    { anchor: 'front', page: 'front', heading: 'FRONT' },
    { anchor: 'pick-a-name', page: 'front', heading: 'CHOOSE A NAME', formerHeadings: ['PICK A NAME'] },
    { anchor: 'back', page: 'back', heading: 'BACK' },
    { anchor: 'second-name', page: 'back', heading: 'PICK A NAME' },
  ]
  assert.throws(
    () => assertReferenceAnchorCatalog(recycled),
    /heading PICK A NAME belongs to anchor pick-a-name/u,
  )

  assert.throws(
    () => annotateReferenceAnchors(`${FIRST_SOURCE}\nEXTRA\n-----\nextra text\n`, FIRST_PAGE),
    /4 headings for 3 anchors/u,
  )
  assert.throws(
    () => annotateReferenceAnchors(FIRST_SOURCE, FIRST_PAGE.slice(0, 2)),
    /3 headings for 2 anchors/u,
  )
})

test('a renamed heading keeps its citation and the index keeps the anchor', () => {
  const renamed: readonly ReferenceAnchor[] = [
    { anchor: 'front', page: 'front', heading: 'FRONT' },
    { anchor: 'pick-a-name', page: 'front', heading: 'CHOOSE A NAME', formerHeadings: ['PICK A NAME'] },
    { anchor: 'back', page: 'back', heading: 'BACK' },
  ]
  const source = FIRST_SOURCE.replace('PICK A NAME\n~~~~~~~~~~~', 'CHOOSE A NAME\n~~~~~~~~~~~~~')
  const pages = pagesOf(source, renamed)
  assert.ok(pages['front']!.includes('cite: front#pick-a-name'))
  assert.ok(pages['front']!.includes('was: PICK A NAME'))
  assert.ok(renderReferenceIndex('https://1f3d9.com', renamed).includes('    cite: front#pick-a-name'))
})
