import { expect, test, type Locator, type Page, type Request } from '@playwright/test'

function isWrite(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
}

async function installLiveClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copiedShareLinks: string[] = []
    Object.defineProperty(window, '__copiedShareLinks', {
      configurable: true,
      value: copiedShareLinks,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          copiedShareLinks.push(value)
          return Promise.resolve()
        },
      },
    })
  })
}

async function copiedLiveShareLinks(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [
    ...((window as Window & { __copiedShareLinks?: string[] }).__copiedShareLinks ?? []),
  ])
}

type LiveRenderWork = Readonly<{
  renders: number
  stageSurveys: number
  residentLayouts: number
  largeResidentLayouts: number
  residentRowsVisited: number
  residentAnchorMembershipChecks: number
  residentAnchorMembershipRowsVisited: number
  placeAnchorCalls: number
  placeAnchorLookupBuilds: number
  placeAnchorPlaceRowsVisited: number
  placeAnchorMapRowsVisited: number
  placeAnchorChildRowsVisited: number
  placeAnchorResolutionSteps: number
  replayCatchUpRecords: number
  residentReplayPoints: number
  moveGeometries: number
  thingPresentations: number
  plotBuilds: number
  rosterRenders: number
  motionLayerRefreshes: number
  residentLabelMeasurements: number
}>

const emptyLiveRenderWork = (): LiveRenderWork => ({
  renders: 0,
  stageSurveys: 0,
  residentLayouts: 0,
  largeResidentLayouts: 0,
  residentRowsVisited: 0,
  residentAnchorMembershipChecks: 0,
  residentAnchorMembershipRowsVisited: 0,
  placeAnchorCalls: 0,
  placeAnchorLookupBuilds: 0,
  placeAnchorPlaceRowsVisited: 0,
  placeAnchorMapRowsVisited: 0,
  placeAnchorChildRowsVisited: 0,
  placeAnchorResolutionSteps: 0,
  replayCatchUpRecords: 0,
  residentReplayPoints: 0,
  moveGeometries: 0,
  thingPresentations: 0,
  plotBuilds: 0,
  rosterRenders: 0,
  motionLayerRefreshes: 0,
  residentLabelMeasurements: 0,
})

async function installLiveRenderWorkRecorder(page: Page): Promise<void> {
  await page.addInitScript(initial => {
    Object.defineProperty(window, '__liveRenderWork', {
      configurable: true,
      value: { ...initial },
    })
    Object.defineProperty(window, '__liveReplayStarts', {
      configurable: true,
      value: [],
    })
  }, emptyLiveRenderWork())
  await page.route('**/window.js', async route => {
    const response = await route.fetch()
    let body = await response.text()
    for (const [functionName, counter] of [
      ['renderLive', 'renders'],
      ['liveStageSurvey', 'stageSurveys'],
      ['liveResidentReplayPoint', 'residentReplayPoints'],
      ['liveReplayMoveGeometry', 'moveGeometries'],
      ['livePlaceAnchor', 'placeAnchorCalls'],
      ['livePlacePlot', 'plotBuilds'],
      ['renderLiveRoster', 'rosterRenders'],
      ['refreshLiveMotionLayer', 'motionLayerRefreshes'],
    ] as const) {
      const pattern = new RegExp(`function ${functionName}\\([^)]*\\) \\{`, 'u')
      const matches = body.match(new RegExp(pattern.source, 'gu')) ?? []
      if (matches.length !== 1) {
        throw new Error(`expected one ${functionName} function in the served Live client`)
      }
      body = body.replace(pattern, match => `${match}\n` +
        `    window.__liveRenderWork.${counter} += 1`)
    }
    const residentLabelMeasurement =
      '        const portraitRect = portrait.getBoundingClientRect()'
    if (body.split(residentLabelMeasurement).length !== 2) {
      throw new Error('expected one resident label measurement in the served Live client')
    }
    body = body.replace(
      residentLabelMeasurement,
      '        window.__liveRenderWork.residentLabelMeasurements += 1\n' +
        residentLabelMeasurement,
    )
    const residentLayoutStart = '    const ordered = [...residents.filter(resident => ' +
      '!resident.asleep),\n      ...residents.filter(resident => resident.asleep)]'
    if (body.split(residentLayoutStart).length !== 2) {
      throw new Error('expected one resident layout build in the served Live client')
    }
    body = body.replace(residentLayoutStart,
      '    window.__liveRenderWork.residentLayouts += 1\n' +
      '    if (residents.length >= 100) window.__liveRenderWork.largeResidentLayouts += 1\n' +
      '    window.__liveRenderWork.residentRowsVisited += residents.length\n' +
      '    if (window.__liveResidentRowBudget > 0 &&\n' +
      '        window.__liveRenderWork.residentRowsVisited > window.__liveResidentRowBudget &&\n' +
      '        !window.__liveResidentRowBudgetExceededAt) {\n' +
      '      window.__liveResidentRowBudgetExceededAt =\n' +
      '        window.__liveRenderWork.residentRowsVisited\n' +
      '    }\n' +
      residentLayoutStart)
    const legacyAnchorMembership =
      'anchoredResidents.some(candidate => candidate.id === resident.id)'
    const anchoredIdSetBuild =
      'new Set(anchoredResidents.map(candidate => candidate.id))'
    const anchoredIdSetLookup = 'anchoredResidentIds.has(resident.id)'
    const recordMembershipRow =
      'window.__liveRenderWork.residentAnchorMembershipRowsVisited += 1; ' +
      'if (window.__liveResidentAnchorRowBudget > 0 && ' +
      'window.__liveRenderWork.residentAnchorMembershipRowsVisited > ' +
      'window.__liveResidentAnchorRowBudget && ' +
      '!window.__liveResidentAnchorRowBudgetExceededAt) ' +
      'window.__liveResidentAnchorRowBudgetExceededAt = ' +
      'window.__liveRenderWork.residentAnchorMembershipRowsVisited; '
    if (body.includes(legacyAnchorMembership)) {
      body = body.replace(
        legacyAnchorMembership,
        '((window.__liveRenderWork.residentAnchorMembershipChecks += 1), ' +
        'anchoredResidents.some(candidate => { ' + recordMembershipRow +
        'return candidate.id === resident.id }))',
      )
    } else if (body.includes(anchoredIdSetBuild) && body.includes(anchoredIdSetLookup)) {
      body = body.replace(
        anchoredIdSetBuild,
        'new Set(anchoredResidents.map(candidate => { ' + recordMembershipRow +
        'return candidate.id }))',
      )
      body = body.replace(
        anchoredIdSetLookup,
        '((window.__liveRenderWork.residentAnchorMembershipChecks += 1), ' +
        anchoredIdSetLookup + ')',
      )
    } else {
      throw new Error('expected one resident anchor membership path in the served Live client')
    }
    const placeAnchorLookup =
      '    const places = state.snapshot\n' +
      '      ? livePlaceRows(state.snapshot)\n' +
      '      : state.directory.loaded ? state.directory.places : []\n' +
      '    const byId = new Map(places.map(place => [place.id, place]))\n' +
      '    const childIds = new Set(children.map(place => place.id))'
    if (body.split(placeAnchorLookup).length !== 2) {
      throw new Error('expected one place anchor lookup build in the served Live client')
    }
    body = body.replace(
      placeAnchorLookup,
      '    window.__liveRenderWork.placeAnchorLookupBuilds += 1\n' +
      '    const places = state.snapshot\n' +
      '      ? livePlaceRows(state.snapshot)\n' +
      '      : state.directory.loaded ? state.directory.places : []\n' +
      '    window.__liveRenderWork.placeAnchorPlaceRowsVisited += places.length\n' +
      '    const byId = new Map(places.map(place => {\n' +
      '      window.__liveRenderWork.placeAnchorMapRowsVisited += 1\n' +
      '      return [place.id, place]\n' +
      '    }))\n' +
      '    const childIds = new Set(children.map(place => {\n' +
      '      window.__liveRenderWork.placeAnchorChildRowsVisited += 1\n' +
      '      return place.id\n' +
      '    }))',
    )
    const placeAnchorWalkPattern = /^(\s*)while \(current && !seen\.has\(current\.id\)\) \{$/gmu
    if ((body.match(placeAnchorWalkPattern) ?? []).length !== 1) {
      throw new Error('expected one place anchor resolution loop in the served Live client')
    }
    body = body.replace(placeAnchorWalkPattern, (match, indent: string) =>
      match + '\n' + indent +
      '  window.__liveRenderWork.placeAnchorResolutionSteps += 1')
    const replayCompletionSchedule =
      '  function scheduleLiveReplayCompletions(starts) {'
    if (body.split(replayCompletionSchedule).length !== 2) {
      throw new Error('expected one replay completion scheduler in the served Live client')
    }
    body = body.replace(
      replayCompletionSchedule,
      replayCompletionSchedule + '\n' +
      '    window.__liveReplayStarts.push(...starts.map(start => {\n' +
      '      const held = state.live.replayActive[start.actor]\n' +
      '      return Object.freeze({\n' +
      '        key: start.key, actor: start.actor,\n' +
      '        duration: start.duration,\n' +
      "        fromPlaceId: String(held?.fromPlaceId || ''),\n" +
      "        toPlaceId: String(held?.toPlaceId || ''),\n" +
      '      })\n' +
      '    }))',
    )
    const thingPresentationStart =
      '    const things = liveDisplayedThings(snapshot, placeId, focusId, includeDescendants)'
    if (body.split(thingPresentationStart).length !== 2) {
      throw new Error('expected one thing presentation build in the served Live client')
    }
    body = body.replace(thingPresentationStart,
      '    window.__liveRenderWork.thingPresentations += 1\n' + thingPresentationStart)
    await route.fulfill({ response, body })
  })
}

async function resetLiveRenderWork(page: Page): Promise<void> {
  await page.evaluate(empty => {
    Object.assign((window as Window & {
      __liveRenderWork: Record<string, number>
    }).__liveRenderWork, empty)
  }, emptyLiveRenderWork())
}

async function readLiveRenderWork(page: Page): Promise<LiveRenderWork> {
  return page.evaluate(() => ({
    ...(window as Window & {
      __liveRenderWork: LiveRenderWork
    }).__liveRenderWork,
  }))
}

type LiveChildFraming = Readonly<{
  detailedChildren: number
  mountedChildren: number
  safeOpenButtons: number
  scale: number
}>

async function readLiveChildFraming(page: Page): Promise<LiveChildFraming> {
  return page.locator('.live-plot').evaluateAll(plots => {
    const viewport = document.querySelector('#live-viewport') as HTMLElement | null
    const stage = document.querySelector('#live-stage') as HTMLElement | null
    if (!viewport || !stage) {
      return { detailedChildren: 0, mountedChildren: 0, safeOpenButtons: 0, scale: 0 }
    }
    const viewportBox = viewport.getBoundingClientRect()
    const safeInset = 16
    const detailed = plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetail === 'true')
    const mounted = detailed.filter(plot =>
      (plot as HTMLElement).dataset.liveDetailMounted === 'true')
    const safeOpenButtons = mounted.filter(plot => {
      const open = plot.querySelector('.live-plot-open')
      if (!open) return false
      const box = open.getBoundingClientRect()
      const centerX = box.left + box.width / 2
      const centerY = box.top + box.height / 2
      return box.width > 0 && box.height > 0 &&
        centerX >= viewportBox.left + safeInset &&
        centerX <= viewportBox.right - safeInset &&
        centerY >= viewportBox.top + safeInset &&
        centerY <= viewportBox.bottom - safeInset
    })
    return {
      detailedChildren: detailed.length,
      mountedChildren: mounted.length,
      safeOpenButtons: safeOpenButtons.length,
      scale: Number(stage.dataset.liveScale),
    }
  })
}

async function panLiveTargetIntoView(page: Page, target: Locator): Promise<void> {
  const viewport = page.locator('#live-viewport')
  await viewport.scrollIntoViewIfNeeded()
  await viewport.focus()
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const [viewportBox, targetBox] = await Promise.all([
      viewport.evaluate(node => {
        const { x, y, width, height } = node.getBoundingClientRect()
        return { x, y, width, height, connected: node.isConnected }
      }),
      target.evaluate(node => {
        const { x, y, width, height } = node.getBoundingClientRect()
        return { x, y, width, height, connected: node.isConnected }
      }),
    ])
    if (!viewportBox.connected || !targetBox.connected) continue
    if (!(viewportBox.width > 0 && viewportBox.height > 0 &&
        targetBox.width > 0 && targetBox.height > 0)) {
      throw new Error('live camera target has no geometry')
    }
    const margin = 6
    if (targetBox.x >= viewportBox.x + margin && targetBox.y >= viewportBox.y + margin &&
        targetBox.x + targetBox.width <= viewportBox.x + viewportBox.width - margin &&
        targetBox.y + targetBox.height <= viewportBox.y + viewportBox.height - margin) return
    const targetX = targetBox.x + targetBox.width / 2
    const targetY = targetBox.y + targetBox.height / 2
    const viewportX = viewportBox.x + viewportBox.width / 2
    const viewportY = viewportBox.y + viewportBox.height / 2
    if (Math.abs(targetX - viewportX) > 20) {
      await viewport.press(targetX > viewportX ? 'ArrowRight' : 'ArrowLeft')
    }
    if (Math.abs(targetY - viewportY) > 20) {
      await viewport.press(targetY > viewportY ? 'ArrowDown' : 'ArrowUp')
    }
  }
  throw new Error('live camera could not pan the requested target into view')
}

async function panLiveStagePointIntoView(
  page: Page,
  point: Readonly<{ x: number; y: number }>,
): Promise<void> {
  const target = page.locator('[data-e2e-live-stage-target]')
  await page.locator('#live-stage').evaluate((stage, stagePoint) => {
    const marker = document.createElement('span')
    marker.dataset.e2eLiveStageTarget = 'true'
    marker.setAttribute('aria-hidden', 'true')
    Object.assign(marker.style, {
      position: 'absolute',
      left: `${stagePoint.x}px`,
      top: `${stagePoint.y}px`,
      width: '1px',
      height: '1px',
      pointerEvents: 'none',
    })
    stage.append(marker)
  }, point)
  try {
    await panLiveTargetIntoView(page, target)
  } finally {
    await target.evaluateAll(nodes => nodes.forEach(node => node.remove()))
  }
}

const replayPlaces = [{ id: 1, parent_id: null, name: 'the world' },
  { id: 2, parent_id: 1, name: 'Cinder lane' },
  { id: 3, parent_id: 1, name: 'Harbor room' },
  { id: 4, parent_id: 3, name: 'Lantern nook' }]
const maximumReplayHandle = 'a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-aa'
const replayCrowd = Array.from({ length: 7 }, (_, index) => ({
  id: 20 + index,
  handle: `harbor-${index + 1}`,
}))
const replayThings = [20, 21, 22, 23, 24, 25, 26, 9].map(id => ({
  id,
  name: id === 9 ? 'field lantern' : `harbor keepsake ${id}`,
}))
const exactDrawing = Object.freeze({
  palette: Object.freeze(['#174d3c', '#f0c95f']),
  indices: Object.freeze(Array.from(
    { length: 64 }, (_, index) => index % 3 === 0 ? null : index % 2,
  )),
})
const exactDrawingRows = Object.freeze(Array.from({ length: 8 }, (_, row) => (
  exactDrawing.indices.slice(row * 8, row * 8 + 8)
    .map(index => index === null ? '.' : String(index))
    .join(' ')
)))

async function expectProofDrawingContract(
  page: Page,
  panResidentPortrait = false,
): Promise<void> {
  const proof = page.locator('#live-panel[data-live-proof="true"]')
  const cases = [
    { state: 'undrawn', presentation: 'undrawn', label: 'Undrawn' },
    { state: 'refused', presentation: 'refused', label: 'Refused' },
    { state: 'in_progress', presentation: 'in_progress', label: 'In progress' },
    { state: 'complete', presentation: 'blank', label: 'Blank' },
  ] as const
  for (const drawingCase of cases) {
    const drawing = proof.locator(
      `[data-drawing-state="${drawingCase.state}"]` +
      `[data-drawing-presentation-state="${drawingCase.presentation}"]`,
    ).first()
    await expect(drawing).toBeVisible()
    await expect(drawing).toHaveAttribute('aria-label', new RegExp(drawingCase.label, 'u'))
  }
  const canvas = proof.locator(
    'canvas[data-drawing-presentation-state="in_progress"]',
  ).first()
  await expect(canvas).toBeVisible()
  expect(await canvas.evaluate(node => {
    const context = (node as HTMLCanvasElement).getContext('2d')
    return context ? [...context.getImageData(0, 0, 1, 1).data] : []
  })).toHaveLength(4)
  for (const portrait of [
    { type: 'resident', id: 9201 },
    { type: 'thing', id: 9402 },
  ] as const) {
    const shell = proof.locator(
      `.entity-portrait[data-portrait-type="${portrait.type}"]` +
      `[data-portrait-id="${String(portrait.id)}"]`,
    ).first()
    await expect(shell).toHaveCount(1)
    await expect(shell.locator('.entity-portrait-placeholder')).toHaveCount(1)
    expect(await shell.evaluate(node =>
      [...node.attributes].some(attribute => attribute.name.startsWith('data-drawing-')),
    )).toBe(false)
  }
  const transparentShell = proof.locator(
    '.entity-portrait[data-portrait-type="thing"][data-portrait-id="9402"]',
  ).first()
  const transparentDrawing = transparentShell.locator('.entity-portrait-image').first()
  if (panResidentPortrait) {
    await panLiveTargetIntoView(page, transparentShell)
  }
  await expect(transparentDrawing).toBeVisible()
  const alphaEvidence = await transparentDrawing.evaluate(node => {
    const source = node as HTMLCanvasElement | HTMLImageElement
    const canvas = source instanceof HTMLCanvasElement
      ? source
      : document.createElement('canvas')
    if (source instanceof HTMLImageElement) {
      canvas.width = source.naturalWidth
      canvas.height = source.naturalHeight
    }
    const context = canvas.getContext('2d')
    if (!context) return { alphas: [], shellBackground: '', shellBorder: '' }
    if (source instanceof HTMLImageElement) context.drawImage(source, 0, 0)
    const shell = source.closest('.entity-portrait') as HTMLElement | null
    const style = shell ? getComputedStyle(shell) : null
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    return {
      alphas: [...new Set(Array.from(data).filter((_, index) => index % 4 === 3))],
      shellBackground: style?.backgroundColor || '',
      shellBorder: style?.borderTopWidth || '',
    }
  })
  expect(alphaEvidence.alphas).toEqual(expect.arrayContaining([0, 255]))
  expect(alphaEvidence.shellBackground).toBe('rgba(0, 0, 0, 0)')
  expect(alphaEvidence.shellBorder).toBe('0px')

  await expect(proof.locator('.drawing-canonical-rows, .drawing-history')).toHaveCount(0)
  await expect(proof.locator(
    '.drawing-state-label, .drawing-provenance, .drawing-undrawn-label, ' +
    '.live-plot-owner, .live-footnote-mark, .live-action-mark',
  )).toHaveCount(0)
  await expect(proof).not.toContainText(/Palette indices|Drawing history/u)
}
function replayPlaceScopeIds(rootId: number) {
  return new Set(replayPlaces.filter(place => {
    if (place.id === rootId) return true
    let parentId: number | null = place.parent_id
    while (parentId !== null) {
      if (parentId === rootId) return true
      parentId = replayPlaces.find(candidate => candidate.id === parentId)?.parent_id ?? null
    }
    return false
  }).map(place => place.id))
}

function replayResidentRows(now: number, placeId: number) {
  return [{ id: 5, handle: 'map-walker', current_place_id: placeId,
    joined_at: new Date(now - 86_400_000).toISOString(), asleep: false, has_drawing: true },
  ...replayCrowd.map((resident, index) => ({
    ...resident,
    current_place_id: 3,
    joined_at: new Date(now - 86_400_000 - index).toISOString(),
    asleep: false,
    has_drawing: true,
  }))]
}

function replayThingRows(now: number, placeId: number, carriedPlaceId?: number) {
  return replayThings.map(thing => ({
    ...thing, place_id: thing.id === 9 ? 4 : thing.id === 20 && carriedPlaceId
      ? carriedPlaceId
      : placeId, body: 'a steady mark',
    maker_id: 5, made_by: 'map-walker', current_owner_id: 5,
    current_owner: 'map-walker', owner: 'map-walker', open_to_use: true,
    kind: 'lantern', traits: [], created_at: new Date(now - 120_000).toISOString(),
    moderated: false, kind_moderated: false,
    has_drawing: thing.id !== 25,
  }))
}

function replaySnapshot(now: number, published: boolean, marker: string, carryMove = false) {
  const residentPlaceId = published ? 4 : 2
  const thingPlaceId = published ? 3 : 2
  const residents = replayResidentRows(now, residentPlaceId)
  const things = replayThingRows(now, thingPlaceId, published && carryMove ? 4 : undefined)
  return {
    view: 'outline', change_marker: marker,
    places: [{
      id: 1, parent_id: null, name: 'the world', owner: null,
      purpose: '', front_matter: [], places: 3, things: 0, notes: 0,
      moderated: false, children: replayPlaces.filter(place => place.parent_id === 1).map(place => ({
        ...place, owner: place.id === 2 ? 'cinder-owner' : 'harbor-owner',
        purpose: '', front_matter: [], places: place.id === 3 ? 1 : 0,
        things: things.filter(thing => thing.place_id === place.id).length, notes: 0,
        moderated: false, children: place.id === 3 ? [{
          id: 4, parent_id: 3, name: 'Lantern nook', owner: 'harbor-owner',
          purpose: '', front_matter: [], places: 0,
          things: things.filter(thing => thing.place_id === 4).length, notes: 0,
          moderated: false, children: [],
        }] : [],
      })),
    }],
    // The ordinary outline is deliberately bounded. Live uses the compact
    // fixed survey for exact +N while one scoped named-card page loads.
    residents: residents.slice(0, 3),
    notes: [],
    things: things.slice(0, 2),
    agreements: [], events: [],
    totals: { places: 4, residents: residents.length, conversations: 0, things: 8,
      agreements: 0, events: published ? 6 : 0 },
    pages: {
      places: { has_more: false },
      residents: { has_more: true, next_before_id: residents[2]!.id },
      notes: { has_more: false }, things: { has_more: true, next_before_id: things[1]!.id },
      agreements: { has_more: false }, events: { has_more: false },
    },
    live_survey: replayPlaces.map(place => ({
      id: place.id,
      parent_id: place.parent_id,
      things: things.filter(thing => thing.place_id === place.id).length,
    })),
    refreshed_at: new Date(now).toISOString(),
  }
}

const routeBackedLongNoteBody =
  'The newest route-backed note keeps its whole long body: ' + 'x'.repeat(2_400)

async function installReplayRoutes(
  page: Page,
  now: number,
  thingPaging: 'complete' | 'stale' | 'long' = 'complete',
  noteBurst = 0,
  controls: Readonly<{
    residentPaging?: 'complete' | 'long'
    openingPaging?: 'complete' | 'long'
    openingMarker?: string
    secondArrival?: boolean
    movementOnly?: boolean
    carryMove?: boolean
    drawingDelayMs?: number
    drawingPlaceCount?: number
    drawingParentId?: number
    omitDrawingPlacesFromOutline?: boolean
    placeMetadataDelayMs?: number
    malformedMetadataPlaceId?: number
    openingDelayMs?: number
    holdOpeningPage?: boolean
    holdOpeningRequest?: number
    residentDelayMs?: number
    thingDelayMs?: number
    moveBurst?: number
    simultaneousMoves?: number
    useThingId?: number
    manyFocusInteractions?: boolean
    openingMovement?: boolean
    maximumHandle?: string
    staggeredArrivalDeadlines?: boolean
    holdThingPage?: boolean
    surveyTotalMismatch?: boolean
    coercibleSurveyThing?: false | null | '' | '0'
    thingFailure?: boolean
    omitFocusedPlaceFromOutline?: boolean
    omitFocusedPlaceFromSurvey?: boolean
    focusedPlaceAvailable?: boolean
    focusedPlaceFailures?: number
    initialResidentPlaceId?: number
    crowdPlaceId?: number
    residentCrowdSize?: number
    publishedMove?: Readonly<{ fromPlaceId: number; toPlaceId: number }>
    roomNoteCount?: number
    holdRoomNoteRequest?: number
    coveringSnapshotFailures?: number
    publishedPlaceTransferId?: number
    nearExpiryQueuedMove?: boolean
    staggeredMoveTimes?: boolean
  }> = {},
) {
  let published = false
  let thingPageRequests = 0
  let residentPageRequests = 0
  let openingEventRequests = 0
  let windowRequests = 0
  let snapshotRequests = 0
  let snapshotResponses = 0
  let coveringSnapshotResponses = 0
  let changeRequests = 0
  const changeCursors: Array<string | null> = []
  const changeLimits: Array<string | null> = []
  let thingNamesUnavailable = Boolean(controls.thingFailure)
  const openingBeforeIds: Array<string | null> = []
  const thingWithinPlaceIds: Array<string | null> = []
  const thingLimits: Array<string | null> = []
  let activeNoteRequests = 0
  let maximumNoteRequests = 0
  let noteRequests = 0
  let activeDrawingRequests = 0
  let maximumDrawingRequests = 0
  let drawingRequests = 0
  let thumbnailRequests = 0
  let focusedPlaceRequests = 0
  let activePlaceMetadataRequests = 0
  let maximumPlaceMetadataRequests = 0
  const placeMetadataRequestPaths: string[] = []
  const roomNoteRequestPaths: string[] = []
  let releaseHeldRoomNoteRequest = () => {}
  const heldRoomNoteRequest = new Promise<void>(resolve => {
    releaseHeldRoomNoteRequest = resolve
  })
  let focusedPlaceFailuresRemaining = controls.focusedPlaceFailures ?? 0
  let coveringSnapshotFailuresRemaining = controls.coveringSnapshotFailures ?? 0
  let coveringSnapshotFailures = 0
  const drawingRequestPaths: string[] = []
  const thumbnailRequestPaths: string[] = []
  let releaseHeldThingPage = () => {}
  const heldThingPage = new Promise<void>(resolve => {
    releaseHeldThingPage = resolve
  })
  let releaseHeldOpeningPage = () => {}
  const heldOpeningPage = new Promise<void>(resolve => {
    releaseHeldOpeningPage = resolve
  })
  let heldEmptyChangeRequests = 0
  let heldEmptyChangeGate: Promise<void> | null = null
  let releaseHeldEmptyChange = () => {}
  let addRoomNote = () => {}
  const currentMarker = () => published
    ? controls.publishedPlaceTransferId
      ? '18'
      : controls.nearExpiryQueuedMove
        ? '12'
      : noteBurst
        ? String(1_000 + noteBurst)
      : controls.simultaneousMoves
      ? String(1_000 + controls.simultaneousMoves)
      : controls.secondArrival ? '17' : '16'
    : '10'
  const controlledResidentRows = (marker: string) => {
    const baseRows = replayResidentRows(
      now,
      marker === '10'
        ? controls.initialResidentPlaceId ?? controls.publishedMove?.fromPlaceId ??
          (controls.openingMovement ? 3 : 2)
        : controls.publishedMove?.toPlaceId ?? 4,
    )
    const requestedRows = controls.residentCrowdSize === undefined
      ? baseRows
      : [
          baseRows[0]!,
          ...Array.from({ length: controls.residentCrowdSize }, (_, index) => ({
            id: 20 + index,
            handle: `harbor-${index + 1}`,
            current_place_id: 3,
            joined_at: new Date(now - 86_400_000 - index).toISOString(),
            asleep: false,
            has_drawing: true,
          })),
        ]
    return [
      ...requestedRows.map(resident => {
      const placed = controls.secondArrival && resident.id === replayCrowd[0]!.id
        ? { ...resident, current_place_id: marker === '10' ? 2 : 4 }
          : resident
        const crowded = controls.crowdPlaceId && resident.id !== 5
        ? { ...placed, current_place_id: controls.crowdPlaceId }
          : placed
        return controls.maximumHandle && resident.id === replayCrowd[3]!.id
          ? { ...crowded, handle: controls.maximumHandle }
          : crowded
      }),
      ...Array.from({ length: controls.simultaneousMoves ?? 0 }, (_, index) => ({
        id: 1_000 + index,
        handle: `walker-burst-${index + 1}`,
        current_place_id: 3,
        joined_at: new Date(now - 172_800_000 - index).toISOString(),
        asleep: false,
        has_drawing: true,
      })),
      ...Array.from({ length: noteBurst }, (_, index) => ({
        id: 5_000 + index,
        handle: `burst-${index + 1}`,
        current_place_id: 3,
        joined_at: new Date(now - 259_200_000 - index).toISOString(),
        asleep: false,
      })),
    ]
  }
  const drawingPlaces = Array.from({ length: controls.drawingPlaceCount ?? 0 }, (_, index) => ({
    id: 100 + index,
    parent_id: controls.drawingParentId ?? 1,
    name: `Drawing plot ${index + 1}`,
  }))
  const directoryPlaces = [...replayPlaces, ...drawingPlaces]
  await page.route('**/api/map**', async route => {
    focusedPlaceRequests += 1
    const url = new URL(route.request().url())
    const parentId = Number(url.searchParams.get('parent_id'))
    const drawingPlaceIndex = drawingPlaces.findIndex(place => place.id === parentId)
    if (drawingPlaceIndex >= 0) {
      const place = drawingPlaces[drawingPlaceIndex]!
      activePlaceMetadataRequests += 1
      maximumPlaceMetadataRequests = Math.max(
        maximumPlaceMetadataRequests,
        activePlaceMetadataRequests,
      )
      placeMetadataRequestPaths.push(url.pathname + url.search)
      try {
        if (controls.placeMetadataDelayMs) {
          await new Promise(resolve => setTimeout(resolve, controls.placeMetadataDelayMs))
        }
        const metadata = {
          ...place,
          owner: published && controls.publishedPlaceTransferId === place.id
            ? 'new-place-owner'
            : `drawing-owner-${drawingPlaceIndex + 1}`,
          purpose: '',
          front_matter: [],
          places: 0,
          things: 0,
          notes: drawingPlaceIndex + 1,
          moderated: false,
          children: [],
        }
        const placeMetadata = controls.malformedMetadataPlaceId === place.id
          ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'notes'))
          : metadata
        await route.fulfill({ json: { change_marker: currentMarker(), place: placeMetadata } })
      } finally {
        activePlaceMetadataRequests -= 1
      }
      return
    }
    if (controls.focusedPlaceAvailable && parentId === 4 && focusedPlaceFailuresRemaining <= 0) {
      await route.fulfill({ json: {
        change_marker: currentMarker(),
        place: {
          id: 4,
          parent_id: 3,
          name: 'Lantern nook',
          owner: 'harbor-owner',
          purpose: '',
          front_matter: [],
          places: 0,
          things: 1,
          notes: 0,
          moderated: false,
          children: [],
        },
      } })
      return
    }
    focusedPlaceFailuresRemaining = Math.max(0, focusedPlaceFailuresRemaining - 1)
    await route.fulfill({ status: 503, json: { error: 'focused place unavailable' } })
  })
  await page.route('**/api/window**', async route => {
    windowRequests += 1
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      await route.fulfill({ json: {
        view: 'directory', places: directoryPlaces,
        residents: controlledResidentRows(currentMarker()).map(resident => ({
          id: resident.id, handle: resident.handle, has_drawing: resident.has_drawing,
        })),
      } })
      return
    }
    const requested = url.searchParams.get('after_change_marker')
    const marker = requested ?? currentMarker()
    if (url.searchParams.get('collection') === 'things') {
      thingPageRequests += 1
      const withinPlaceId = url.searchParams.get('within_place_id')
      thingWithinPlaceIds.push(withinPlaceId)
      thingLimits.push(url.searchParams.get('limit'))
      if (controls.holdThingPage) await heldThingPage
      if (controls.thingDelayMs) {
        await new Promise(resolve => setTimeout(resolve, controls.thingDelayMs))
      }
      if (thingNamesUnavailable) {
        await route.fulfill({ status: 503, json: { error: 'named things unavailable' } })
        return
      }
      if (thingPaging !== 'complete') {
        if (thingPaging === 'stale' && thingPageRequests <= 2) {
          const [thing] = replayThingRows(now, 2).filter(candidate => candidate.id === 9)
          await route.fulfill({ json: {
            change_marker: marker, things: [thing], total: replayThings.length,
            has_more: true, next_before_id: 9,
          } })
          return
        }
        if (thingPaging === 'long' && thingPageRequests <= 8) {
          const [template] = replayThingRows(now, 2)
          const id = 101 - thingPageRequests
          await route.fulfill({ json: {
            change_marker: marker, things: [{ ...template, id, name: `paged thing ${id}` }],
            total: 100, has_more: true, next_before_id: id,
          } })
          return
        }
        await route.fulfill({ status: 503, json: { error: 'test request limit reached' } })
        return
      }
      const placeId = marker === '10' ? 2 : 3
      const scope = replayPlaceScopeIds(Number(withinPlaceId))
      const things = replayThingRows(
        now,
        placeId,
        published && controls.carryMove ? 4 : undefined,
      )
        .filter(thing => scope.has(thing.place_id))
      await route.fulfill({ json: {
        change_marker: marker,
        things,
        total: things.length,
        has_more: false,
        next_before_id: null,
      } })
      return
    }
    snapshotRequests += 1
    if (published && url.searchParams.has('after_change_marker') &&
        coveringSnapshotFailuresRemaining > 0) {
      coveringSnapshotFailuresRemaining -= 1
      coveringSnapshotFailures += 1
      await route.fulfill({ status: 503, json: { error: 'covering snapshot unavailable' } })
      return
    }
    const ordinarySnapshot = replaySnapshot(
      now,
      controls.carryMove ? published : marker !== '10',
      marker,
      controls.carryMove,
    )
    const roomNoteSnapshot = controls.roomNoteCount === undefined
      ? ordinarySnapshot
      : {
          ...ordinarySnapshot,
          places: ordinarySnapshot.places.map(function withRoomNoteCount(place) {
            return {
              ...place,
              notes: place.id === 3 ? controls.roomNoteCount : place.notes,
              children: place.children.map(withRoomNoteCount),
            }
          }),
        }
    const drawingRows = drawingPlaces.map(extra => ({
      ...extra,
      owner: 'drawing-owner',
      purpose: '',
      front_matter: [],
      places: 0,
      things: 0,
      notes: 0,
      moderated: false,
      children: [],
    }))
    const appendDrawingPlaces = place => ({
      ...place,
      places: place.places + (place.id === (controls.drawingParentId ?? 1)
        ? drawingPlaces.length
        : 0),
      children: [
        ...place.children.map(appendDrawingPlaces),
        ...(place.id === (controls.drawingParentId ?? 1) &&
          !controls.omitDrawingPlacesFromOutline ? drawingRows : []),
      ],
    })
    const baseSnapshot = drawingPlaces.length
      ? {
          ...roomNoteSnapshot,
          places: roomNoteSnapshot.places.map(appendDrawingPlaces),
          totals: {
            ...roomNoteSnapshot.totals,
            places: roomNoteSnapshot.totals.places + drawingPlaces.length,
          },
          live_survey: [
            ...roomNoteSnapshot.live_survey,
            ...drawingPlaces.map(place => ({ ...place, things: 0 })),
          ],
        }
      : roomNoteSnapshot
    const outlinedSnapshot = controls.omitFocusedPlaceFromOutline
      ? {
          ...baseSnapshot,
          places: baseSnapshot.places.map(place => ({
            ...place,
            children: place.children.map(child => child.id === 3
              ? { ...child, children: [] }
              : child),
          })),
        }
      : baseSnapshot
    const surveyedSnapshot = controls.surveyTotalMismatch
      ? {
          ...outlinedSnapshot,
          live_survey: outlinedSnapshot.live_survey.map(place => place.id === 2
            ? { ...place, things: Math.max(0, place.things - 1) }
            : place),
        }
      : outlinedSnapshot
    const focusedPlaceSurveySnapshot = controls.omitFocusedPlaceFromSurvey
      ? {
          ...surveyedSnapshot,
          live_survey: surveyedSnapshot.live_survey.filter(place => place.id !== 4),
        }
      : surveyedSnapshot
    const snapshot = Object.hasOwn(controls, 'coercibleSurveyThing')
      ? {
          ...focusedPlaceSurveySnapshot,
          live_survey: focusedPlaceSurveySnapshot.live_survey.map(place => place.id === 1
            ? { ...place, things: controls.coercibleSurveyThing }
            : place),
        }
      : focusedPlaceSurveySnapshot
    const residents = controlledResidentRows(marker)
    await route.fulfill({ json: {
      ...snapshot,
      residents: residents.slice(0, 3),
      totals: { ...snapshot.totals, residents: residents.length },
      pages: {
        ...snapshot.pages,
        residents: {
          has_more: true,
          next_before_id: residents[2]!.id,
        },
      },
    } })
    snapshotResponses += 1
    if (published && requested && requested !== '10') coveringSnapshotResponses += 1
  })
  await page.route('**/api/changes**', async route => {
    changeRequests += 1
    const url = new URL(route.request().url())
    const since = url.searchParams.get('since')
    changeCursors.push(since)
    changeLimits.push(url.searchParams.get('limit'))
    if (since === null) {
      await route.fulfill({ json: { change_marker: currentMarker() } })
      return
    }
    if (since !== null && !published && heldEmptyChangeGate) {
      const gate = heldEmptyChangeGate
      heldEmptyChangeGate = null
      heldEmptyChangeRequests += 1
      await gate
      await route.fulfill({ json: {
        change_marker: '10', unchanged: true, has_more: false,
        next_since: '10', changes: [],
      } })
      return
    }
    if (since !== null && published && controls.simultaneousMoves) {
      const publishedMarker = currentMarker()
      const startIndex = since === '10' ? 0 : Number(since) - 1_000
      if (Number.isSafeInteger(startIndex) && startIndex >= 0 &&
          startIndex < controls.simultaneousMoves) {
        const endIndex = Math.min(startIndex + 200, controls.simultaneousMoves)
        const publishedChanges = Array.from(
          { length: endIndex - startIndex },
          (_, offset) => {
            const index = startIndex + offset
            const crossesCatchUpCutoff = controls.simultaneousMoves === 1_600 &&
              (index === 1_399 || index === 1_400)
            return {
              change_id: String(1_001 + index),
              created_at: new Date(
                now + (controls.staggeredMoveTimes ? Math.floor(index / 4) : 0),
              ).toISOString(),
              kind: 'action',
              actor: crossesCatchUpCutoff
                ? 'walker-burst-1401'
                : `walker-burst-${index + 1}`,
              detail: {
                action: 'move', status: 'applied',
                from_place_id: index === 1_399 ? 3 : 2,
                to_place_id: index === 1_399 ? 2 : 3,
              },
            }
          },
        )
        const nextSince = String(1_000 + endIndex)
        await route.fulfill({ json: {
          change_marker: publishedMarker,
          unchanged: false,
          has_more: endIndex < controls.simultaneousMoves,
          next_since: nextSince,
          changes: publishedChanges,
        } })
        return
      }
    }
    if (since === '10' && published && noteBurst) {
      const publishedMarker = currentMarker()
      await route.fulfill({ json: {
        change_marker: publishedMarker,
        unchanged: false,
        has_more: false,
        next_since: publishedMarker,
        changes: Array.from({ length: noteBurst }, (_, index) => ({
          change_id: String(1_001 + index),
          created_at: new Date(now).toISOString(),
          kind: 'note',
          actor: `burst-${index + 1}`,
          detail: { place_id: 3, note_id: 1_000 + index },
        })),
      } })
      return
    }
    if (since === '10' && published && controls.nearExpiryQueuedMove) {
      await route.fulfill({ json: {
        change_marker: '12',
        unchanged: false,
        has_more: false,
        next_since: '12',
        changes: [{
          change_id: '11', created_at: new Date(now).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
          },
        }, {
          change_id: '12', created_at: new Date(now - 1_789_000).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'move', status: 'applied', from_place_id: 3, to_place_id: 4,
          },
        }],
      } })
      return
    }
    if (since === '10' && published) {
      const publishedMarker = currentMarker()
      const publishedChanges = [{
            change_id: '11', created_at: new Date(now - (
              controls.staggeredArrivalDeadlines ? 1_792_300 : 0
            )).toISOString(), kind: 'action',
            actor: 'map-walker', detail: {
              action: 'move', status: 'applied',
              from_place_id: controls.publishedMove?.fromPlaceId ?? 2,
              to_place_id: controls.publishedMove?.toPlaceId ?? 4,
              ...(controls.carryMove ? { mode: 'carry', thing_id: 20 } : {}),
            },
          }, ...(controls.movementOnly ? [] : [{
            change_id: '12', created_at: new Date(now).toISOString(), kind: 'note',
            actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
          }, {
            change_id: '13', created_at: new Date(now).toISOString(), kind: 'note',
            actor: 'map-walker', detail: { place_id: 3, note_id: 78 },
          }, {
            change_id: '14', created_at: new Date(now).toISOString(), kind: 'action',
            actor: 'map-walker', detail: {
              action: 'use', status: 'applied',
              place_id: controls.useThingId ? 3 : 4,
              source_thing_id: controls.useThingId ?? 9,
            },
          }, {
            change_id: '15', created_at: new Date(now).toISOString(), kind: 'action',
            actor: 'map-walker', detail: {
              action: 'move', from_place_id: 3, to_place_id: 2,
            },
          }, {
            change_id: '16', created_at: new Date(now - 600_001).toISOString(), kind: 'note',
            actor: 'map-walker', detail: { place_id: 3, note_id: 79 },
          }]), ...(controls.secondArrival ? [{
            change_id: '17', created_at: new Date(now).toISOString(), kind: 'action',
            actor: replayCrowd[0]!.handle, detail: {
              action: 'move', status: 'applied', from_place_id: 2, to_place_id: 4,
            },
          }] : []), ...(controls.publishedPlaceTransferId ? [{
            change_id: '18', created_at: new Date(now).toISOString(), kind: 'transfer',
            actor: 'map-walker', detail: {
              transfer_id: 818, asset_type: 'place',
              asset_id: controls.publishedPlaceTransferId,
            },
          }] : [])]
      await route.fulfill({ json: {
        change_marker: publishedMarker, unchanged: false, has_more: false,
        next_since: publishedMarker,
        changes: publishedChanges,
      } })
      return
    }
    await route.fulfill({ json: {
      change_marker: currentMarker(), unchanged: true, has_more: false,
      next_since: currentMarker(), changes: [],
    } })
  })
  await page.route('**/api/events**', async route => {
    openingEventRequests += 1
    openingBeforeIds.push(new URL(route.request().url()).searchParams.get('before_id'))
    if (controls.holdOpeningPage || controls.holdOpeningRequest === openingEventRequests) {
      await heldOpeningPage
    }
    if (controls.openingDelayMs) {
      await new Promise(resolve => setTimeout(resolve, controls.openingDelayMs))
    }
    if (controls.openingPaging === 'long') {
      if (openingEventRequests <= 8) {
        const id = 901 - openingEventRequests
        await route.fulfill({ json: {
          change_marker: controls.openingMarker ?? currentMarker(),
          has_more: true, next_before_id: id,
          events: [{
            id, change_id: String(11 - openingEventRequests),
            at: new Date(now - openingEventRequests).toISOString(), kind: 'action',
            actor: 'history-walker', detail: {
              action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
            },
          }],
        } })
        return
      }
      if (openingEventRequests === 9) {
        await route.fulfill({ json: {
          change_marker: controls.openingMarker ?? currentMarker(),
          has_more: false, next_before_id: null,
          events: [{
            id: 892, change_id: '2', at: new Date(now - 9).toISOString(), kind: 'action',
            actor: 'history-walker', detail: {
              action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
            },
          }],
        } })
        return
      }
      await route.fulfill({ status: 503, json: { error: 'test request limit reached' } })
      return
    }
    await route.fulfill({ json: {
      change_marker: controls.openingMarker ?? currentMarker(),
      has_more: false, next_before_id: null,
      events: controls.simultaneousMoves && published
        ? Array.from({ length: controls.simultaneousMoves }, (_, index) => ({
            id: 1_000 + index,
            change_id: String(1_001 + index),
            at: new Date(now).toISOString(),
            kind: 'action',
            actor: `walker-burst-${index + 1}`,
            detail: {
              action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
            },
          }))
        : controls.moveBurst ? Array.from({ length: controls.moveBurst }, (_, index) => ({
        id: 500 + index, change_id: String(index + 1),
        at: new Date(now - index).toISOString(), kind: 'action',
        actor: index % (replayCrowd.length + 1) === 0
          ? 'map-walker'
          : replayCrowd[(index - 1) % replayCrowd.length]!.handle,
        detail: {
          action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
        },
      })) : noteBurst ? Array.from({ length: noteBurst }, (_, index) => ({
        id: 300 + index, change_id: String(index + 1),
        at: new Date(now - index).toISOString(), kind: 'note',
        actor: `burst-${index + 1}`,
        detail: { place_id: 3, note_id: 1_000 + index },
      })) : controls.manyFocusInteractions ? [
        ...replayCrowd.map((resident, index) => ({
          id: 400 + index, change_id: String(index + 2),
          at: new Date(now - 30_000 - index).toISOString(), kind: 'transfer',
          actor: index === 0 ? resident.handle : 'map-walker', detail: {
            transfer_id: 100 + index, asset_type: 'thing', asset_id: replayThings[index]!.id,
            resident_id: index === 0 ? 5 : resident.id, place_id: 3,
          },
        })),
        {
          id: 408, change_id: '9', at: new Date(now - 29_000).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'use', status: 'applied', place_id: 3, source_thing_id: 90,
          },
        },
        {
          id: 409, change_id: '10', at: new Date(now - 28_000).toISOString(),
          kind: 'thing_created', actor: 'map-walker', detail: { thing_id: 91, place_id: 3 },
        },
        {
          id: 399, change_id: '1', at: new Date(now - 30_000).toISOString(), kind: 'note',
          actor: controls.maximumHandle ?? replayCrowd[3]!.handle,
          detail: { place_id: 3, note_id: 77 },
        },
      ] : controls.openingMovement ? [{
        id: 398, change_id: '9', at: new Date(now - 120_000).toISOString(), kind: 'action',
        actor: 'map-walker', detail: {
          action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
        },
      }] : [{
        id: 99, change_id: '9', at: new Date(now - 30_000).toISOString(), kind: 'transfer',
        actor: 'map-walker', detail: {
          transfer_id: 44, asset_type: 'thing', asset_id: 26,
          resident_id: replayCrowd.at(-1)!.id, place_id: 2,
        },
      }],
    } })
  })
  await page.route('**/api/residents**', async route => {
    residentPageRequests += 1
    const url = new URL(route.request().url())
    const marker = url.searchParams.get('after_change_marker') ?? currentMarker()
    if (controls.residentDelayMs) {
      await new Promise(resolve => setTimeout(resolve, controls.residentDelayMs))
    }
    if (controls.residentPaging === 'long') {
      if (residentPageRequests <= 8) {
        const id = 20 - residentPageRequests
        await route.fulfill({ json: {
          change_marker: marker,
          residents: [{
            id, handle: `paged-${id}`, current_place_id: 2,
            joined_at: new Date(now - 172_800_000 - residentPageRequests * 1_000).toISOString(),
            asleep: false,
            has_drawing: true,
          }],
          total: 2_000, has_more: true, next_before_id: id,
        } })
        return
      }
      await route.fulfill({ status: 503, json: { error: 'test request limit reached' } })
      return
    }
    const residents = controlledResidentRows(marker)
    const requestedCursor = url.searchParams.get('before_id')
    await route.fulfill({ json: {
      change_marker: marker,
      residents: requestedCursor ? residents.slice(3) : residents,
      total: residents.length, has_more: false, next_before_id: null,
    } })
  })
  if (controls.roomNoteCount !== undefined) {
    let roomNotes = Object.freeze(Array.from({ length: controls.roomNoteCount }, (_, index) => {
      const id = 10_000 + controls.roomNoteCount! - index
      return {
        id,
        place_id: 3,
        author: index % 2 === 0 ? 'map-walker' : 'harbor-owner',
        body: index === 0 ? routeBackedLongNoteBody : `route-backed note ${id}`,
        created_at: new Date(now - index * 1_000).toISOString(),
        moderated: false,
        truncated: false,
      }
    }))
    addRoomNote = () => {
      const id = (roomNotes[0]?.id ?? 10_000) + 1
      roomNotes = Object.freeze([{
        id,
        place_id: 3,
        author: 'new-arrival',
        body: `new route-backed note ${id}`,
        created_at: new Date(now + 1_000).toISOString(),
        moderated: false,
        truncated: false,
      }, ...roomNotes])
    }
    await page.route('**/api/place/3**', async route => {
      const url = new URL(route.request().url())
      roomNoteRequestPaths.push(url.pathname + url.search)
      if (roomNoteRequestPaths.length === controls.holdRoomNoteRequest) {
        await heldRoomNoteRequest
      }
      const beforeId = Number(url.searchParams.get('before_note_id'))
      const eligible = Number.isSafeInteger(beforeId) && beforeId > 0
        ? roomNotes.filter(note => note.id < beforeId)
        : roomNotes
      const notes = eligible.slice(0, 50)
      const hasMore = eligible.length > notes.length
      await route.fulfill({ json: {
        view: 'full',
        place: { id: 3, parent_id: 1, name: 'Harbor room' },
        notes,
        notes_page: {
          total_items: roomNotes.length,
          returned_items: notes.length,
          has_more: hasMore,
          next_before_note_id: hasMore ? notes.at(-1)?.id ?? null : null,
        },
      } })
    })
  }
  await page.route('**/api/note/77', route => route.fulfill({ json: {
    note: { id: 77, body: 'Earlier line\nEarlier detail stays in the ledger.' },
  } }))
  await page.route('**/api/note/78', route => route.fulfill({ json: {
    note: { id: 78, body: 'L'.repeat(61) + '\nLatest detail stays in the ledger.' },
  } }))
  await page.route('**/api/note/79', route => route.fulfill({ json: {
    note: { id: 79, body: 'Too old to replay' },
  } }))
  for (let index = 0; index < noteBurst; index += 1) {
    const noteId = 1_000 + index
    await page.route(`**/api/note/${noteId}`, async route => {
      activeNoteRequests += 1
      noteRequests += 1
      maximumNoteRequests = Math.max(maximumNoteRequests, activeNoteRequests)
      await new Promise(resolve => setTimeout(resolve, 80))
      activeNoteRequests -= 1
      await route.fulfill({ json: { note: { id: noteId, body: `burst note ${noteId}` } } })
    })
  }
  await page.route('**/api/drawing/**', async route => {
    const url = new URL(route.request().url())
    const thumbnailMatch = /^\/api\/drawing\/(place|resident|thing)\/(\d+)\/thumb\.png$/u.exec(
      url.pathname,
    )
    if (thumbnailMatch) {
      thumbnailRequests += 1
      thumbnailRequestPaths.push(url.pathname + url.search)
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALElEQVR42u3OMQ4AIBACMP7/aVyNNzo42BJGEtKke0eGHpNLDjw/AAAAwPcWvX5foS4HRmkAAAAASUVORK5CYII=',
          'base64',
        ),
      })
      return
    }
    const match = /^\/api\/drawing\/(place|resident|thing)\/(\d+)$/u.exec(url.pathname)
    if (!match) {
      await route.fulfill({ status: 404, json: { error: 'drawing not found' } })
      return
    }
    activeDrawingRequests += 1
    drawingRequests += 1
    drawingRequestPaths.push(new URL(route.request().url()).pathname)
    maximumDrawingRequests = Math.max(maximumDrawingRequests, activeDrawingRequests)
    try {
      if (controls.drawingDelayMs) {
        await new Promise(resolve => setTimeout(resolve, controls.drawingDelayMs))
      }
      await route.fulfill({ json: {
        type: match[1],
        id: Number(match[2]),
        state: 'undrawn',
        presentation_state: 'undrawn',
        description: null,
        drawing: null,
        rows: null,
        source: 'none',
        kind_id: null,
        kind_name: null,
        revision: null,
        variant_name: null,
      } })
    } finally {
      activeDrawingRequests -= 1
    }
  })
  return {
    publish: () => { published = true },
    thingPageRequests: () => thingPageRequests,
    thingWithinPlaceIds: () => [...thingWithinPlaceIds],
    thingLimits: () => [...thingLimits],
    residentPageRequests: () => residentPageRequests,
    openingEventRequests: () => openingEventRequests,
    openingBeforeIds: () => [...openingBeforeIds],
    windowRequests: () => windowRequests,
    snapshotRequests: () => snapshotRequests,
    snapshotResponses: () => snapshotResponses,
    coveringSnapshotResponses: () => coveringSnapshotResponses,
    changeRequests: () => changeRequests,
    changeCursors: () => [...changeCursors],
    changeLimits: () => [...changeLimits],
    activeNoteRequests: () => activeNoteRequests,
    maximumNoteRequests: () => maximumNoteRequests,
    noteRequests: () => noteRequests,
    activeDrawingRequests: () => activeDrawingRequests,
    maximumDrawingRequests: () => maximumDrawingRequests,
    drawingRequests: () => drawingRequests,
    drawingRequestPaths: () => [...drawingRequestPaths],
    thumbnailRequests: () => thumbnailRequests,
    thumbnailRequestPaths: () => [...thumbnailRequestPaths],
    focusedPlaceRequests: () => focusedPlaceRequests,
    activePlaceMetadataRequests: () => activePlaceMetadataRequests,
    maximumPlaceMetadataRequests: () => maximumPlaceMetadataRequests,
    placeMetadataRequestPaths: () => [...placeMetadataRequestPaths],
    coveringSnapshotFailures: () => coveringSnapshotFailures,
    roomNoteRequestPaths: () => [...roomNoteRequestPaths],
    releaseHeldRoomNoteRequest,
    holdNextEmptyChange: () => {
      heldEmptyChangeGate = new Promise<void>(resolve => {
        releaseHeldEmptyChange = resolve
      })
    },
    heldEmptyChangeRequests: () => heldEmptyChangeRequests,
    releaseHeldEmptyChange: () => releaseHeldEmptyChange(),
    addRoomNote,
    recoverThingNames: () => { thingNamesUnavailable = false },
    releaseHeldOpeningPage,
    releaseHeldThingPage,
  }
}

async function publishReplayChanges(
  page: Page,
  fixture: Awaited<ReturnType<typeof installReplayRoutes>>,
) {
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect.poll(fixture.changeRequests).toBeGreaterThan(0)
  const requestsBeforePublish = fixture.changeRequests()
  const snapshotsBeforePublish = fixture.snapshotRequests()
  const snapshotResponsesBeforePublish = fixture.snapshotResponses()
  const coveringResponsesBeforePublish = fixture.coveringSnapshotResponses()
  fixture.publish()
  await expect.poll(async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    return fixture.changeRequests()
  }).toBeGreaterThan(requestsBeforePublish)
  await expect.poll(fixture.snapshotRequests).toBeGreaterThan(snapshotsBeforePublish)
  await expect.poll(fixture.snapshotResponses).toBeGreaterThan(snapshotResponsesBeforePublish)
  await expect.poll(fixture.coveringSnapshotResponses).toBeGreaterThan(
    coveringResponsesBeforePublish,
  )
  await page.waitForTimeout(100)
}

async function settleLiveFakeClockAfterPublish(page: Page): Promise<void> {
  await page.clock.runFor(32)
  await page.waitForTimeout(100)
  await page.clock.runFor(32)
}

async function advanceLiveFakeClockUntil(
  page: Page,
  condition: () => Promise<boolean>,
  maximumMs: number,
  stepMs = 32,
): Promise<number> {
  let elapsed = 0
  while (!await condition() && elapsed < maximumMs) {
    const step = Math.min(stepMs, maximumMs - elapsed)
    await page.clock.runFor(step)
    elapsed += step
    await page.waitForTimeout(10)
  }
  return elapsed
}

async function expectMapWalkerSettledAtLantern(page: Page): Promise<void> {
  const row = page.locator('#live-roster .resident-row').filter({
    has: page.locator('[data-live-resident-handle="map-walker"]'),
  })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Lantern nook')
}

async function liveResidentPositions(plot: Locator) {
  return plot.evaluate(node => {
    const plotBox = node.getBoundingClientRect()
    return [...node.querySelectorAll('.live-walker')].map(shell => {
      const box = (shell as HTMLElement).getBoundingClientRect()
      const handle = (shell.querySelector('[data-live-resident-handle]') as HTMLElement | null)
        ?.dataset.liveResidentHandle ?? ''
      return {
        key: handle,
        x: box.left + box.width / 2 - plotBox.left,
        y: box.top + box.height / 2 - plotBox.top,
        width: plotBox.width,
        height: plotBox.height,
      }
    })
  })
}

async function liveResidentLocalPositions(plot: Locator) {
  return plot.evaluate(node => [...node.querySelectorAll<HTMLElement>('.live-walker')]
    .map(shell => ({
      key: shell.querySelector<HTMLElement>('[data-live-resident-handle]')
        ?.dataset.liveResidentHandle ?? '',
      x: Number.parseFloat(shell.style.left),
      y: Number.parseFloat(shell.style.top),
    })))
}

async function liveThingPositions(plot: Locator) {
  return plot.evaluate(node => {
    const plotBox = node.getBoundingClientRect()
    return [...node.querySelectorAll('.live-thing-specimen')].map(thing => {
      const box = (thing as HTMLElement).getBoundingClientRect()
      return {
        key: (thing as HTMLElement).dataset.liveThingId ?? '',
        x: box.left + box.width / 2 - plotBox.left,
        y: box.top + box.height / 2 - plotBox.top,
        width: plotBox.width,
        height: plotBox.height,
      }
    })
  })
}

async function expectControlsDoNotOverlap(residentMore: Locator, thingMore: Locator) {
  const [residentBox, thingBox] = await Promise.all([
    residentMore.boundingBox(),
    thingMore.boundingBox(),
  ])
  expect(residentBox).not.toBeNull()
  expect(thingBox).not.toBeNull()
  if (!residentBox || !thingBox) return
  expect(
    residentBox.x < thingBox.x + thingBox.width &&
      residentBox.x + residentBox.width > thingBox.x &&
      residentBox.y < thingBox.y + thingBox.height &&
      residentBox.y + residentBox.height > thingBox.y,
  ).toBe(false)
}

async function expectTargetCenterExposed(target: Locator) {
  let lastResult: unknown = null
  try {
    await expect.poll(async () => {
      try {
        if (await target.count() !== 1) return false
        await target.scrollIntoViewIfNeeded()
        lastResult = await target.evaluate(node => {
          const box = node.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          const hitElement = hit as HTMLElement | null
          return {
            exposed: box.width > 0 && box.height > 0 &&
              (hit === node || Boolean(hit && node.contains(hit))),
            targetBox: {
              left: box.left, right: box.right, top: box.top, bottom: box.bottom,
            },
            hit: hitElement?.className || hitElement?.tagName || null,
          }
        })
        return (lastResult as { exposed: boolean }).exposed
      } catch (error) {
        if (error instanceof Error && /not attached to the DOM/u.test(error.message)) return false
        throw error
      }
    }).toBe(true)
  } catch (error) {
    throw new Error('Target center remained covered: ' + JSON.stringify(lastResult), {
      cause: error,
    })
  }
}

async function expectEveryTargetCenterExposed(page: Page, targets: Locator) {
  const covered = []
  const count = await targets.count()
  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index)
    await panLiveTargetIntoView(page, target)
    const result = await target.evaluate(node => {
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (hit === node || Boolean(hit && node.contains(hit))) return null
      const element = node as HTMLElement
      const hitElement = hit as HTMLElement | null
      return {
        target: element.dataset.liveItemKey || element.dataset.liveThingId ||
          element.querySelector<HTMLElement>('[data-live-resident-handle]')
            ?.dataset.liveResidentHandle || element.className,
        hit: hitElement?.dataset.liveItemKey || hitElement?.dataset.liveThingId ||
          hitElement?.className || hitElement?.tagName || null,
      }
    })
    if (result) {
      covered.push(result)
      continue
    }
    await target.hover()
    expect(await target.evaluate(node => node.matches(':hover'))).toBe(true)
  }
  expect(covered).toEqual([])
}

async function expectLocatorSetsDoNotOverlap(left: Locator, right: Locator) {
  const [leftBoxes, rightBoxes] = await Promise.all([
    left.evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
    })),
    right.evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
    })),
  ])
  for (const leftBox of leftBoxes) {
    for (const rightBox of rightBoxes) {
      expect(
        leftBox.left < rightBox.right && leftBox.right > rightBox.left &&
          leftBox.top < rightBox.bottom && leftBox.bottom > rightBox.top,
      ).toBe(false)
    }
  }
}

test('Live paints exact surveyed counts and Focus ids while named thing cards load', async ({ page }, testInfo) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    holdThingPage: true,
    manyFocusInteractions: true,
  })
  try {
    await page.goto('/window#view=live')
    await expect.poll(fixture.thingPageRequests).toBe(1)
    expect(fixture.thingWithinPlaceIds()).toEqual(['1'])
    expect(fixture.thingLimits()).toEqual(['50'])

    await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
    await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
      .toHaveText('+5 more')
    await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
      .toHaveAttribute('data-live-overflow-count', '5')
    await expect(page.locator('#live-history-status')).toContainText(
      'Exact +N thing counts come from the fixed survey while newest named cards load',
    )

    await expect(page.locator('#live-history-status')).toContainText('history is complete')
    const mapWalker = page.locator('[data-live-resident-handle="map-walker"]').first()
    const cinderSprite = page.locator(
      '.live-plot[data-place-id="2"] > .live-plot-open',
    )
    await panLiveTargetIntoView(page, mapWalker)
    await expectControlsDoNotOverlap(cinderSprite, mapWalker)
    if (testInfo.project.name === 'mobile-chromium') {
      const mapWalkerShell = mapWalker.locator('xpath=..')
      await mapWalker.tap()
      await expect(mapWalkerShell).toHaveAttribute('data-live-raised', 'true')
      await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
      await mapWalker.tap()
    } else {
      await mapWalker.click()
    }
    await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
    await expect(page.locator('#live-focus-interactions [data-live-focus-thing]')).toHaveCount(9)
    await expect(page.locator('#live-focus-interactions [data-live-focus-thing="23"]'))
      .toContainText('Thing #23 · recorded in Harbor room')
    await expect(page.locator('#live-focus-interactions [data-live-focus-thing="90"]'))
      .toContainText('Thing #90 · recorded in Harbor room')
    await expect(page.locator('#live-focus-interactions [data-live-focus-thing="91"]'))
      .toContainText('Thing #91 · recorded in Harbor room')
  } finally {
    fixture.releaseHeldThingPage()
  }

  await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
    .toHaveText('+2 more')
  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="23"]'))
    .toContainText('harbor keepsake 23 · now in Cinder lane · recorded in Harbor room')

  const harborOpen = page.locator('[data-place-id="3"] .live-plot-open')
  await panLiveTargetIntoView(page, harborOpen)
  await harborOpen.click()
  await expect.poll(fixture.thingPageRequests).toBe(2)
  expect(fixture.thingWithinPlaceIds()).toEqual(['1', '3'])
  expect(fixture.thingLimits()).toEqual(['50', '50'])
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing]')).toHaveCount(9)
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="23"]'))
    .toContainText('Thing #23 · recorded in Harbor room')
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="90"]'))
    .toContainText('Thing #90 · recorded in Harbor room')
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="91"]'))
    .toContainText('Thing #91 · recorded in Harbor room')
})

test('Live uses the complete survey when an unnecessary focused-place detail read fails', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    omitFocusedPlaceFromOutline: true,
  })
  await page.goto('/window/live?place=4')

  await expect(page.locator('.live-plate-title')).toHaveText('Lantern nook')
  await expect(page.locator('#live-plates')).not.toContainText('could not be loaded')
  await expect(page.getByRole('button', { name: 'Retry loading this place' })).toHaveCount(0)
  expect(fixture.focusedPlaceRequests()).toBeLessThanOrEqual(1)
})

test('Live uses the complete survey for a followed resident when place detail fails', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    omitFocusedPlaceFromOutline: true,
    initialResidentPlaceId: 4,
  })
  await page.goto('/window/live?resident=map-walker')

  await expect(page.locator('.live-plate-title')).toHaveText('Lantern nook')
  await expect(page.locator('#live-plates')).not.toContainText('could not be loaded')
  await expect(page.getByRole('button', { name: 'Retry loading this place' })).toHaveCount(0)
  expect(fixture.focusedPlaceRequests()).toBeLessThanOrEqual(1)
})

test('Live still loads a selected place through the focused-place path when the survey does not cover it', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    omitFocusedPlaceFromOutline: true,
    omitFocusedPlaceFromSurvey: true,
    focusedPlaceAvailable: true,
  })
  await page.goto('/window/live?place=4')

  await expect(page.locator('.live-plate-title')).toHaveText('Lantern nook')
  await expect(page.locator('#live-plates')).not.toContainText('could not be loaded')
  await expect(page.getByRole('button', { name: 'Retry loading this place' })).toHaveCount(0)
  await expect.poll(fixture.focusedPlaceRequests).toBeGreaterThan(0)
})

for (const retryCase of [
  {
    name: 'selected place',
    url: '/window/live?place=4',
    controls: {},
  },
  {
    name: 'followed resident place',
    url: '/window/live?resident=map-walker',
    controls: { initialResidentPlaceId: 4 },
  },
] as const) {
  test(`Live ${retryCase.name} Retry starts a fresh place request and recovers`, async ({ page }) => {
    const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
      omitFocusedPlaceFromOutline: true,
      omitFocusedPlaceFromSurvey: true,
      focusedPlaceAvailable: true,
      focusedPlaceFailures: 1,
      ...retryCase.controls,
    })
    await page.goto(retryCase.url)

    const retry = page.getByRole('button', { name: 'Retry loading this place' })
    await expect(retry).toBeVisible()
    const requestsBeforeRetry = fixture.focusedPlaceRequests()
    await retry.click()
    await expect.poll(fixture.focusedPlaceRequests).toBeGreaterThan(requestsBeforeRetry)
    await expect(retry).toHaveCount(0)
    await expect(page.locator('.live-plate-title')).toHaveText('Lantern nook')
    await expect(page.locator('#live-plates')).not.toContainText('could not be loaded')
  })
}

test('Live hover and keyboard focus bring covered places, residents, and things forward', async ({ page }) => {
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const plot = page.locator('.live-plot[data-place-id="3"]')
  const plotOpen = plot.locator('.live-plot-open')
  await panLiveTargetIntoView(page, plotOpen)
  await plotOpen.hover()
  await expect(plot).toHaveCSS('z-index', '60')
  await page.locator('#live-viewport').focus()
  await plotOpen.focus()
  await expect(plot).toHaveCSS('z-index', '60')

  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Zoom in' }).click()
  }
  await expect(page.locator('#live-stage')).toHaveAttribute('data-live-label-mode', 'readable')

  const resident = page.locator('[data-live-resident-handle="harbor-1"]').first()
  const residentShell = resident.locator('xpath=..')
  const residentTag = page.locator(
    '#live-label-layer [data-live-resident-tag="harbor-1"]',
  )
  await panLiveTargetIntoView(page, resident)
  await resident.hover()
  await expect(residentShell).toHaveCSS('z-index', '30')
  await expect(page.locator('#live-viewport')).toHaveJSProperty('scrollTop', 0)
  await expect(residentTag).toBeVisible()
  await expect.poll(async () => residentTag.evaluate(tag => {
    const own = Number(getComputedStyle(tag).zIndex)
    const peers = [...tag.parentElement!.querySelectorAll<HTMLElement>('.live-resident-tag')]
      .filter(peer => peer !== tag)
      .map(peer => Number(getComputedStyle(peer).zIndex))
    return own > Math.max(0, ...peers)
  })).toBe(true)
  await page.locator('#live-viewport').focus()
  await resident.focus()
  await expect(page.locator('#live-viewport')).toHaveJSProperty('scrollTop', 0)
  await expect(residentShell).toHaveCSS('z-index', '30')
  await expect.poll(async () => residentTag.evaluate(tag => {
    const own = Number(getComputedStyle(tag).zIndex)
    const peers = [...tag.parentElement!.querySelectorAll<HTMLElement>('.live-resident-tag')]
      .filter(peer => peer !== tag)
      .map(peer => Number(getComputedStyle(peer).zIndex))
    return own > Math.max(0, ...peers)
  })).toBe(true)

  const thing = page.locator('[data-live-thing-id="9"]').first()
  await panLiveTargetIntoView(page, thing)
  await expectControlsDoNotOverlap(plotOpen, thing)
  await thing.hover()
  await expect(thing).toHaveCSS('z-index', '45')
  await page.locator('#live-viewport').focus()
  await thing.focus()
  await expect(thing).toHaveCSS('z-index', '45')

  await panLiveTargetIntoView(page, plotOpen)
  await plotOpen.focus()
  const popover = page.locator('#live-item-popover[data-live-item-popover="true"]')
  await expect(popover).toBeVisible()
  await expect(popover.locator('.live-item-popover-title')).toContainText('Harbor room')
})

test('Live first touch raises covered items and second touch opens them', async ({ page }, testInfo) => {
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const touch = async (target: Locator) => {
    await panLiveTargetIntoView(page, target)
    if (testInfo.project.name === 'mobile-chromium') {
      await target.tap()
      return
    }
    await target.dispatchEvent('pointerdown', { pointerType: 'touch' })
    await target.dispatchEvent('click', { pointerType: 'touch' })
  }

  const resident = page.locator('[data-live-resident-handle="harbor-1"]').first()
  const shell = resident.locator('xpath=..')
  const residentTag = page.locator(
    '#live-label-layer [data-live-resident-tag="harbor-1"]',
  )
  await touch(resident)
  await expect(shell).toHaveAttribute('data-live-raised', 'true')
  await expect(residentTag).toBeVisible()
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  await page.setViewportSize({ width: viewport!.width + 1, height: viewport!.height })
  await expect(resident).toBeVisible()

  await touch(resident)
  await expect(page.locator('#live-focus-status')).toContainText('Focused on harbor-1')
  await expect(residentTag).toHaveAttribute('data-live-raised', 'true')
  await expect.poll(async () => residentTag.evaluate(tag => {
    const own = Number(getComputedStyle(tag).zIndex)
    const peers = [...tag.parentElement!.querySelectorAll<HTMLElement>('.live-resident-tag')]
      .filter(peer => peer !== tag)
      .map(peer => Number(getComputedStyle(peer).zIndex))
    return own > Math.max(0, ...peers)
  })).toBe(true)

  const thing = page.locator('[data-live-thing-id="9"]').first()
  await thing.evaluate(node => node.addEventListener('click', event => {
    ;(node as HTMLElement).dataset.testDefaultPrevented = String(event.defaultPrevented)
    event.preventDefault()
  }))
  await touch(thing)
  await expect(thing).toHaveAttribute('data-live-raised', 'true')
  await expect(thing.locator('.live-thing-name')).toHaveCSS('visibility', 'visible')
  await expect(thing).toHaveAttribute('data-test-default-prevented', 'true')
  await touch(thing)
  await expect(thing).toHaveAttribute('data-test-default-prevented', 'false')
  await expect(thing).toHaveAttribute('href', '/api/thing/9')

  const plot = page.locator('.live-plot[data-place-id="2"]')
  const open = plot.locator('.live-plot-open')
  const urlBeforeFirstPlaceTap = page.url()
  await touch(open)
  await expect(plot).toHaveAttribute('data-live-raised', 'true')
  await expect(open.locator('.live-plot-name')).toHaveCSS('visibility', 'visible')
  expect(page.url()).toBe(urlBeforeFirstPlaceTap)
  await touch(open)
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
})

test('Center returns to one touch-raised child occupant without breaking the detail budget', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installReplayRoutes(page, Date.now(), 'complete', 0, { drawingPlaceCount: 80 })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const touch = async (target: Locator) => {
    await panLiveTargetIntoView(page, target)
    if (testInfo.project.name === 'mobile-chromium') {
      await target.tap()
      return
    }
    await target.dispatchEvent('pointerdown', { pointerType: 'touch' })
    await target.dispatchEvent('click', { pointerType: 'touch' })
  }

  const harbor = page.locator('.live-plot[data-place-id="3"]')
  const resident = harbor.locator('[data-live-resident-handle="harbor-1"]').first()
  const residentShell = resident.locator('xpath=..')
  await panLiveTargetIntoView(page, harbor.locator('.live-plot-open'))
  await expect(harbor).toHaveAttribute('data-live-detail-mounted', 'true')
  await touch(resident)
  await expect(residentShell).toHaveAttribute('data-live-raised', 'true')

  const distantPlot = page.locator('.live-plot[data-place-id="105"]')
  await expect(distantPlot).toHaveAttribute('data-live-detail', 'false')
  const distantOpen = distantPlot.locator('.live-plot-open')
  await panLiveTargetIntoView(page, distantOpen)
  const harborInsideOrdinaryBudget = await harbor.evaluate((plot, overscan) => {
    const stage = document.querySelector('#live-stage') as HTMLElement
    const viewport = document.querySelector('#live-viewport') as HTMLElement
    const scale = Number(stage.dataset.liveScale)
    const left = -Number(stage.dataset.liveOffsetX) / scale
    const top = -Number(stage.dataset.liveOffsetY) / scale
    const right = left + viewport.clientWidth / scale
    const bottom = top + viewport.clientHeight / scale
    const x = Number((plot as HTMLElement).dataset.livePlotX)
    const y = Number((plot as HTMLElement).dataset.livePlotY)
    const width = Number((plot as HTMLElement).dataset.livePlotWidth)
    const height = Number((plot as HTMLElement).dataset.livePlotHeight)
    return x < right + overscan && x + width > left - overscan &&
      y < bottom + overscan && y + height > top - overscan
  }, 160)
  expect(harborInsideOrdinaryBudget).toBe(false)
  await expect(harbor).toHaveAttribute('data-live-detail', 'true')
  await expect(resident).toHaveCount(1)
  const retainedBudget = await page.locator('.live-plot').evaluateAll(plots => ({
    detailedPlots: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetail === 'true').length,
    mountedPlots: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetailMounted === 'true').length,
  }))
  expect(retainedBudget.detailedPlots).toBeLessThanOrEqual(21)
  expect(retainedBudget.mountedPlots).toBe(retainedBudget.detailedPlots)

  await page.getByRole('button', { name: 'Center live view' }).click()
  await expect(page.locator('#live-stage')).toHaveAttribute('data-live-scale', '1')
  await expect.poll(() => resident.evaluate(node => {
    const residentBox = node.getBoundingClientRect()
    const viewportBox = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return residentBox.left >= viewportBox.left && residentBox.right <= viewportBox.right &&
      residentBox.top >= viewportBox.top && residentBox.bottom <= viewportBox.bottom
  })).toBe(true)
  await expect(residentShell).toHaveAttribute('data-live-raised', 'true')

  await panLiveTargetIntoView(page, distantOpen)
  await touch(distantOpen)
  await expect(distantPlot).toHaveAttribute('data-live-raised', 'true')
  await expect(harbor).toHaveAttribute('data-live-detail', 'false')
  await expect(harbor).toHaveAttribute('data-live-detail-mounted', 'false')
  await expect(harbor.locator('.live-portrait-grid, .live-thing-shelf')).toHaveCount(0)
})

test('a cancelled touch does not consume the next keyboard activation', async ({ page }) => {
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const open = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  await open.dispatchEvent('pointerdown', { pointerType: 'touch' })
  await open.dispatchEvent('pointercancel', { pointerType: 'touch' })
  await open.focus()
  await open.evaluate(node => (node as HTMLButtonElement).click())
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
})

test('Live expands 167 residents with bounded layout passes and no new public reads', async ({ page }) => {
  await page.setViewportSize({ width: 923, height: 648 })
  await installLiveRenderWorkRecorder(page)
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    crowdPlaceId: 2,
    initialResidentPlaceId: 3,
    moveBurst: 24,
    residentCrowdSize: 167,
  })
  const readCounts = () => ({
    window: fixture.windowRequests(),
    residents: fixture.residentPageRequests(),
    events: fixture.openingEventRequests(),
    focusedPlace: fixture.focusedPlaceRequests(),
    things: fixture.thingPageRequests(),
  })
  const childExpansionWork = Object.freeze({
    renders: 1,
    stageSurveys: 1,
    residentLayouts: 2,
    largeResidentLayouts: 1,
    residentRowsVisited: 168,
    residentAnchorMembershipChecks: 0,
    residentAnchorMembershipRowsVisited: 0,
    placeAnchorCalls: 10,
    placeAnchorLookupBuilds: 1,
    placeAnchorPlaceRowsVisited: 4,
    placeAnchorMapRowsVisited: 4,
    placeAnchorChildRowsVisited: 2,
    placeAnchorResolutionSteps: 1,
    replayCatchUpRecords: 0,
    residentReplayPoints: 0,
    moveGeometries: 0,
    thingPresentations: 3,
    plotBuilds: 2,
    rosterRenders: 1,
    motionLayerRefreshes: 0,
    residentLabelMeasurements: 0,
  })
  const rootResidentExpansionWork = Object.freeze({
    renders: 2,
    stageSurveys: 2,
    residentLayouts: 2,
    largeResidentLayouts: 2,
    residentRowsVisited: 334,
    residentAnchorMembershipChecks: 0,
    residentAnchorMembershipRowsVisited: 0,
    placeAnchorCalls: 20,
    placeAnchorLookupBuilds: 0,
    placeAnchorPlaceRowsVisited: 0,
    placeAnchorMapRowsVisited: 0,
    placeAnchorChildRowsVisited: 0,
    placeAnchorResolutionSteps: 0,
    replayCatchUpRecords: 0,
    residentReplayPoints: 0,
    moveGeometries: 0,
    thingPresentations: 2,
    plotBuilds: 0,
    rosterRenders: 2,
    motionLayerRefreshes: 0,
    residentLabelMeasurements: 1,
  })
  const rootResidentExpansionWorkAfterSecondLabelPass = Object.freeze({
    ...rootResidentExpansionWork,
    renders: 3,
    stageSurveys: 3,
    residentLayouts: 3,
    largeResidentLayouts: 3,
    residentRowsVisited: 501,
    placeAnchorCalls: 30,
    thingPresentations: 3,
    rosterRenders: 3,
    residentLabelMeasurements: 2,
  })
  const rootThingExpansionWork = Object.freeze({
    renders: 1,
    stageSurveys: 1,
    residentLayouts: 1,
    largeResidentLayouts: 1,
    residentRowsVisited: 167,
    residentAnchorMembershipChecks: 0,
    residentAnchorMembershipRowsVisited: 0,
    placeAnchorCalls: 10,
    placeAnchorLookupBuilds: 0,
    placeAnchorPlaceRowsVisited: 0,
    placeAnchorMapRowsVisited: 0,
    placeAnchorChildRowsVisited: 0,
    placeAnchorResolutionSteps: 0,
    replayCatchUpRecords: 0,
    residentReplayPoints: 0,
    moveGeometries: 0,
    thingPresentations: 1,
    plotBuilds: 0,
    rosterRenders: 1,
    motionLayerRefreshes: 0,
    residentLabelMeasurements: 0,
  })

  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect.poll(fixture.thingPageRequests).toBe(1)

  const cinder = page.locator('.live-plot[data-place-id="2"]')
  const childMore = cinder.getByRole('button', { name: 'Show 163 more residents' })
  await expect(childMore).toBeVisible()
  const childResidentsBefore = (await liveResidentLocalPositions(cinder)).map(({ key, x, y }) => ({
    key,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
  }))
  const childThingsBefore = (await liveThingPositions(cinder)).map(({ key, x, y }) => ({
    key,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
  }))
  const childPlotsBefore = await page.locator('.live-plot').evaluateAll(plots => plots.map(plot => {
    const element = plot as HTMLElement
    return {
      id: element.dataset.placeId,
      x: element.dataset.livePlotX,
      y: element.dataset.livePlotY,
      width: element.dataset.livePlotWidth,
      height: element.dataset.livePlotHeight,
    }
  }))
  const childStageBefore = await page.locator('#live-stage').evaluate(stage => ({
    width: Number((stage as HTMLElement).dataset.liveStageWidth),
    height: Number((stage as HTMLElement).dataset.liveStageHeight),
  }))
  const childReadsBefore = readCounts()
  await expect.poll(() => fixture.activePlaceMetadataRequests() +
    fixture.activeDrawingRequests()).toBe(0)
  await page.waitForTimeout(100)
  await resetLiveRenderWork(page)
  await childMore.click()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  const childWork = await readLiveRenderWork(page)
  expect(childWork).toEqual(childExpansionWork)
  await expect(cinder.locator('.live-walker')).toHaveCount(167)
  await expect(cinder.locator('.live-resident-more')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const childResidentsAfter = (await liveResidentLocalPositions(cinder)).map(({ key, x, y }) => ({
    key,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
  }))
  expect(childResidentsAfter.filter(resident => childResidentsBefore.some(before =>
    before.key === resident.key))).toEqual(childResidentsBefore)
  expect((await liveThingPositions(cinder)).map(({ key, x, y }) => ({
    key,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
  }))).toEqual(childThingsBefore)
  expect(await page.locator('.live-plot').evaluateAll(plots => plots.map(plot => {
    const element = plot as HTMLElement
    return {
      id: element.dataset.placeId,
      x: element.dataset.livePlotX,
      y: element.dataset.livePlotY,
      width: element.dataset.livePlotWidth,
      height: element.dataset.livePlotHeight,
    }
  }))).toEqual(childPlotsBefore)
  const childStageAfter = await page.locator('#live-stage').evaluate(stage => ({
    width: Number((stage as HTMLElement).dataset.liveStageWidth),
    height: Number((stage as HTMLElement).dataset.liveStageHeight),
  }))
  expect(childStageAfter.width).toBe(childStageBefore.width)
  expect(childStageAfter.height).toBeGreaterThan(childStageBefore.height)
  await expect(cinder.locator('.live-portrait[aria-label^="Focus on "]')).toHaveCount(167)
  await cinder.locator('[data-live-resident-handle="harbor-167"]').focus()
  await expect(cinder.locator('[data-live-resident-handle="harbor-167"]')).toBeFocused()
  expect(readCounts()).toEqual(childReadsBefore)

  await page.goto('/window/live?place=2')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect.poll(fixture.thingPageRequests).toBe(2)
  const rootMore = page.locator('.live-root-walkers').getByRole(
    'button', { name: 'Show 163 more residents' },
  )
  await expect(rootMore).toBeVisible()
  const rootReadsBefore = readCounts()
  await expect.poll(() => fixture.activePlaceMetadataRequests() +
    fixture.activeDrawingRequests()).toBe(0)
  await page.waitForTimeout(100)
  await resetLiveRenderWork(page)
  await rootMore.click()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  const rootResidentWork = await readLiveRenderWork(page)
  await expect(page.locator('.live-root-walkers .live-walker')).toHaveCount(167)
  await expect(page.locator('.live-root-walkers .live-resident-more')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(readCounts()).toEqual(rootReadsBefore)
  expect([
    rootResidentExpansionWork,
    rootResidentExpansionWorkAfterSecondLabelPass,
  ]).toContainEqual(rootResidentWork)

  const residentsBeforeThingExpansion = (await liveResidentLocalPositions(
    page.locator('.live-root-walkers'),
  )).map(({ key, x, y }) => ({
    key,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
  }))
  const rootThingMore = page.locator('.live-root-thing-shelf').getByRole(
    'button', { name: 'Show 2 more things' },
  )
  await panLiveTargetIntoView(page, rootThingMore)
  const thingReadsBefore = readCounts()
  await resetLiveRenderWork(page)
  await rootThingMore.click()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  const rootThingWork = await readLiveRenderWork(page)
  await expect(page.locator('.live-root-thing-shelf .live-thing-specimen')).toHaveCount(7)
  await expect(page.locator('.live-root-thing-shelf .live-thing-more')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await liveResidentLocalPositions(page.locator('.live-root-walkers')))
    .map(({ key, x, y }) => ({
      key,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
    }))).toEqual(residentsBeforeThingExpansion)
  expect(readCounts()).toEqual(thingReadsBefore)
  expect(rootThingWork).toEqual(rootThingExpansionWork)
})

test('Live frames a detailed First Town child on initial load and Center', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingPlaceCount: 217,
    drawingParentId: 2,
    residentCrowdSize: 6,
    crowdPlaceId: 2,
    initialResidentPlaceId: 3,
  })
  const results: Array<Readonly<{
    viewport: string
    initial: LiveChildFraming
    centered: LiveChildFraming
  }>> = []

  for (const viewport of [
    { name: 'desktop', width: 923, height: 648 },
    { name: 'mobile', width: 390, height: 844 },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/window/live?place=2')
    await expect(page.locator('#live-history-status')).toContainText('history is complete')
    await expect(page.locator('.live-plot')).toHaveCount(217)
    await expect(page.locator('.live-root-walkers .live-walker')).toHaveCount(6)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /fit/i })).toHaveCount(0)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() =>
      requestAnimationFrame(() => resolve()))))

    const initial = await readLiveChildFraming(page)
    await page.getByRole('button', { name: 'Center live view' }).click()
    const centered = await readLiveChildFraming(page)
    results.push({ viewport: viewport.name, initial, centered })
  }

  expect(results.every(result => [result.initial, result.centered].every(frame =>
    frame.detailedChildren >= 1 && frame.mountedChildren >= 1 &&
    frame.safeOpenButtons >= 1 && frame.scale === 1)), JSON.stringify(results, null, 2)).toBe(true)
})

test('Live ignores a stale raised parent when framing its drilled child plate', async ({ page }) => {
  await page.setViewportSize({ width: 923, height: 648 })
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingPlaceCount: 217,
    drawingParentId: 2,
    residentCrowdSize: 6,
    crowdPlaceId: 2,
    initialResidentPlaceId: 3,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const parentPlot = page.locator('.live-plot[data-place-id="2"]')
  const parentOpen = parentPlot.locator('.live-plot-open')
  await panLiveTargetIntoView(page, parentOpen)
  await parentOpen.dispatchEvent('pointerdown', { pointerType: 'touch' })
  await parentOpen.dispatchEvent('click', { pointerType: 'touch' })
  await expect(parentPlot).toHaveAttribute('data-live-raised', 'true')

  await page.getByRole('button', { name: 'Center live view' }).click()
  await expect.poll(() => parentOpen.evaluate(open => {
    const box = open.getBoundingClientRect()
    const viewport = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return box.width > 0 && box.height > 0 &&
      box.left >= viewport.left && box.right <= viewport.right &&
      box.top >= viewport.top && box.bottom <= viewport.bottom
  })).toBe(true)

  await parentOpen.dispatchEvent('pointerdown', { pointerType: 'touch' })
  await parentOpen.dispatchEvent('click', { pointerType: 'touch' })
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(page.locator('.live-plot')).toHaveCount(217)
  let initial = await readLiveChildFraming(page)
  await expect.poll(async () => {
    initial = await readLiveChildFraming(page)
    return initial.detailedChildren >= 1 && initial.mountedChildren >= 1 &&
      initial.safeOpenButtons >= 1 && initial.scale === 1
  }).toBe(true)
  await page.getByRole('button', { name: 'Center live view' }).click()
  const centered = await readLiveChildFraming(page)
  expect([initial, centered].every(frame =>
    frame.detailedChildren >= 1 && frame.mountedChildren >= 1 &&
    frame.safeOpenButtons >= 1 && frame.scale === 1), JSON.stringify({
      initial,
      centered,
    }, null, 2)).toBe(true)
})

test('Live ignores an outside focus when framing First Town', async ({ page }) => {
  await page.setViewportSize({ width: 923, height: 648 })
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingPlaceCount: 217,
    drawingParentId: 2,
    residentCrowdSize: 6,
    crowdPlaceId: 2,
    initialResidentPlaceId: 3,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const resident = page.locator('[data-live-resident-handle="map-walker"]').first()
  await panLiveTargetIntoView(page, resident)
  await resident.click()
  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
  await page.getByRole('button', { name: 'Center live view' }).click()
  await expect.poll(() => resident.evaluate(node => {
    const box = node.getBoundingClientRect()
    const viewport = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return box.width > 0 && box.height > 0 &&
      box.left >= viewport.left && box.right <= viewport.right &&
      box.top >= viewport.top && box.bottom <= viewport.bottom
  })).toBe(true)

  const parentOpen = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  await panLiveTargetIntoView(page, parentOpen)
  await parentOpen.click()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(page.locator('[data-live-resident-scope="outside"]'))
    .toContainText('map-walker')
  await expect(page.locator('.live-plot')).toHaveCount(217)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() =>
    requestAnimationFrame(() => resolve()))))
  const initial = await readLiveChildFraming(page)
  await page.getByRole('button', { name: 'Center live view' }).click()
  const centered = await readLiveChildFraming(page)
  expect([initial, centered].every(frame =>
    frame.detailedChildren >= 1 && frame.mountedChildren >= 1 &&
    frame.safeOpenButtons >= 1 && frame.scale === 1), JSON.stringify({
      initial,
      centered,
    }, null, 2)).toBe(true)
})

test('Live Show more reveals every loaded resident and thing instead of leaving a dead badge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const harbor = page.locator('.live-plot[data-place-id="3"]')
  const harborBefore = await liveResidentPositions(harbor)
  const harborMore = harbor.getByRole('button', { name: 'Show 3 more residents' })
  await panLiveTargetIntoView(page, harborMore)
  await harborMore.click()
  await expect(harbor.locator('.live-walker')).toHaveCount(7)
  await expect(harbor.locator('.live-resident-more')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(harbor.locator('.live-walker-layer-expanded')).toHaveCount(0)
  await expect(harbor.locator('[data-live-resident-handle="harbor-5"]').first()).toBeVisible()
  await expect(harbor.locator('[data-live-resident-handle="harbor-6"]').first()).toBeVisible()
  await expect(harbor.locator('[data-live-resident-handle="harbor-7"]').first()).toBeVisible()
  const harborAfter = await liveResidentPositions(harbor)
  expect(harborAfter).toHaveLength(7)
  expect(new Set(harborAfter.map(point =>
    `${Math.round(point.x)}:${Math.round(point.y)}`)).size).toBe(harborAfter.length)

  const cinder = page.locator('.live-plot[data-place-id="2"]')
  const cinderBefore = await liveThingPositions(cinder)
  const cinderMore = cinder.getByRole('button', { name: 'Show 2 more things' })
  await panLiveTargetIntoView(page, cinderMore)
  await cinderMore.click()
  await expect(cinder.locator('.live-thing-specimen')).toHaveCount(7)
  await expect(cinder.locator('.live-thing-more')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(cinder.locator('.live-thing-shelf-expanded')).toHaveCount(0)
  await expect(cinder.locator('[data-live-thing-id="22"]').first()).toBeVisible()
  await expect(cinder.locator('[data-live-thing-id="23"]').first()).toBeVisible()
  const cinderAfter = await liveThingPositions(cinder)
  expect(cinderAfter).toHaveLength(7)
  expect(new Set(cinderAfter.map(point =>
    `${Math.round(point.x)}:${Math.round(point.y)}`)).size).toBe(cinderAfter.length)
  expect(cinderAfter.length).toBeGreaterThan(cinderBefore.length)
  const expandedSurfaces = await page.locator(
    '.live-plot[data-place-id="2"] .live-thing-shelf, ' +
    '.live-plot[data-place-id="3"] .live-walker-layer',
  ).evaluateAll(nodes => nodes.map(node => ({
    overflowX: getComputedStyle(node).overflowX,
    overflowY: getComputedStyle(node).overflowY,
  })))
  expect(expandedSurfaces.every(surface =>
    !['auto', 'scroll'].includes(surface.overflowX) &&
    !['auto', 'scroll'].includes(surface.overflowY))).toBe(true)
})

test('phone Live keeps direct residents in readable home ground instead of the far world edge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    initialResidentPlaceId: 1,
    crowdPlaceId: 1,
    drawingPlaceCount: 80,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const homeGeometry = await page.locator('#live-stage').evaluate(stage => {
    const stageBox = stage.getBoundingClientRect()
    const residents = [...stage.querySelectorAll<HTMLElement>(
      '.live-root-walkers .live-walker',
    )].map(resident => {
      const box = resident.getBoundingClientRect()
      return (box.left + box.width / 2 - stageBox.left) /
        Number((stage as HTMLElement).dataset.liveScale ?? '1')
    })
    return {
      stageWidth: (stage as HTMLElement).scrollWidth,
      residentXs: residents,
    }
  })
  expect(homeGeometry.residentXs.length).toBeGreaterThan(0)
  expect(Math.max(...homeGeometry.residentXs)).toBeLessThanOrEqual(1_100)
  expect(Math.max(...homeGeometry.residentXs)).toBeLessThan(homeGeometry.stageWidth / 2)
})

test('phone full-screen Live has a clear exit and browser Back exits before navigating away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  const originalUrl = page.url()

  const enter = page.getByRole('button', { name: 'Enter full-screen Live' })
  await expect(enter).toBeVisible()
  await enter.click()
  const fullScreenPanel = page.locator('#live-panel[data-live-fullscreen="true"]')
  await expect(fullScreenPanel).toBeVisible()
  const fullScreenBounds = await fullScreenPanel.boundingBox()
  expect(fullScreenBounds).not.toBeNull()
  expect(fullScreenBounds!.x).toBeLessThanOrEqual(1)
  expect(fullScreenBounds!.y).toBeLessThanOrEqual(1)
  expect(fullScreenBounds!.width).toBeGreaterThanOrEqual(389)
  expect(fullScreenBounds!.height).toBeGreaterThanOrEqual(843)

  await page.getByRole('button', { name: 'Exit full-screen Live' }).click()
  await expect(page.locator('#live-panel[data-live-fullscreen="true"]')).toHaveCount(0)
  expect(page.url()).toBe(originalUrl)

  await page.getByRole('button', { name: 'Enter full-screen Live' }).click()
  await expect(fullScreenPanel).toBeVisible()
  await page.goBack()
  await expect(page.locator('#live-panel[data-live-fullscreen="true"]')).toHaveCount(0)
  expect(page.url()).toBe(originalUrl)
})

test('desktop full-screen Live gives the hidden roster column back to the scene', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await page.getByRole('button', { name: 'Enter full-screen Live' }).click()

  const geometry = await page.locator('#live-panel').evaluate(panel => {
    const panelBox = panel.getBoundingClientRect()
    const stageBox = panel.querySelector('.live-stage-shell')!.getBoundingClientRect()
    return { panelWidth: panelBox.width, stageWidth: stageBox.width }
  })
  expect(geometry.stageWidth).toBeGreaterThanOrEqual(geometry.panelWidth - 2)
})

test('Live Show more keeps keyboard focus and stays operable while more thing pages remain', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'long', 0, {
    surveyTotalMismatch: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText(
    'Exact +N thing counts are unavailable',
  )

  const residentMore = page.locator('.live-plot[data-place-id="3"] .live-resident-more')
  await residentMore.focus()
  await residentMore.press('Enter')
  await expect(page.locator('.live-plot[data-place-id="3"] .live-walker')).toHaveCount(7)
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe('live-plates')

  const thingMore = page.locator('.live-plot[data-place-id="2"] .live-thing-more')
  await expect.poll(fixture.thingPageRequests).toBe(1)
  await thingMore.focus()
  await thingMore.press('Enter')
  await expect.poll(fixture.thingPageRequests).toBe(2)
  await expect(page.locator('[data-live-thing-id="99"]')).toBeVisible()
  await expect(thingMore).toBeVisible()
  await expect(thingMore).toHaveAttribute('aria-busy', 'false')
  await expect.poll(() => page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.dataset.focusKey ?? null,
  )).toBe('live-thing-overflow:2')
  await thingMore.press('Enter')
  await expect.poll(fixture.thingPageRequests).toBe(3)
})

test('Live keeps both Show more controls separate and operable in one crowded place', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, { crowdPlaceId: 2 })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const cinder = page.locator('.live-plot[data-place-id="2"]')
  const notesControl = cinder.locator('.live-place-notes')
  const residentMore = cinder.locator('.live-resident-more')
  const thingMore = cinder.locator('.live-thing-more')
  await expect(notesControl).toBeVisible()
  await expect(notesControl).toHaveText('notes · 0')
  await expect(residentMore).toBeVisible()
  await expect(thingMore).toBeVisible()
  await expectControlsDoNotOverlap(notesControl, residentMore)
  await expectControlsDoNotOverlap(notesControl, thingMore)
  await expectControlsDoNotOverlap(residentMore, thingMore)
  expect(await notesControl.evaluate((button, plot) => {
    const buttonBox = button.getBoundingClientRect()
    const plotBox = (plot as Element).getBoundingClientRect()
    return buttonBox.left >= plotBox.left && buttonBox.right <= plotBox.right &&
      buttonBox.top >= plotBox.top && buttonBox.bottom <= plotBox.bottom
  }, await cinder.elementHandle())).toBe(true)
  await expectEveryTargetCenterExposed(page, cinder.locator(
    '.live-walker, .live-thing-specimen',
  ))
  await expect(cinder).toHaveAttribute('data-live-detail-mounted', 'true')

  await panLiveTargetIntoView(page, thingMore)
  await thingMore.click()
  await expect(cinder.locator('.live-thing-specimen')).toHaveCount(7)
  const rearrangedResidentMore = cinder.locator('.live-resident-more')
  await panLiveTargetIntoView(page, rearrangedResidentMore)
  await rearrangedResidentMore.click()
  await expect(cinder.locator('.live-walker')).toHaveCount(8)

  const expandedResidents = cinder.locator('.live-portrait-grid[data-live-expanded="true"]')
  const expandedThings = cinder.locator('.live-thing-shelf[data-live-expanded="true"]')
  await expect(expandedResidents).toHaveCount(1)
  await expect(expandedThings).toHaveCount(1)
  await expectLocatorSetsDoNotOverlap(expandedResidents, expandedThings)
  await expectLocatorSetsDoNotOverlap(
    cinder.locator(
      '.live-portrait-grid[data-live-expanded="true"], .live-thing-shelf[data-live-expanded="true"]',
    ),
    page.locator('.live-plot:not([data-place-id="2"])'),
  )
  await expectEveryTargetCenterExposed(page, cinder.locator(
    '.live-walker, .live-thing-specimen',
  ))
  await expect(cinder).toHaveAttribute('data-live-detail-mounted', 'true')
  const crowdedDetailBudget = await page.locator('.live-plot').evaluateAll(plots => ({
    detailedPlots: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetail === 'true').length,
    mountedPlots: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetailMounted === 'true').length,
  }))
  expect(crowdedDetailBudget.detailedPlots).toBeLessThanOrEqual(2)
  expect(crowdedDetailBudget.mountedPlots).toBe(crowdedDetailBudget.detailedPlots)

  const harborOpen = page.locator('.live-plot[data-place-id="3"] .live-plot-open')
  await panLiveTargetIntoView(page, harborOpen)
  await harborOpen.click()
  await expect(page.locator('.live-plate-title')).toHaveText('Harbor room')
})

test('Live keeps focused-place Show more controls separate and operable', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, { crowdPlaceId: 2 })
  await page.goto('/window/live?place=2')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const residentMore = page.locator('.live-root-walkers .live-resident-more')
  const thingMore = page.locator('.live-root-thing-shelf .live-thing-more')
  await expect(residentMore).toBeVisible()
  await expect(thingMore).toBeVisible()
  await expectControlsDoNotOverlap(residentMore, thingMore)
  await expectTargetCenterExposed(thingMore)

  const residentsBeforeThingExpansion = (await liveResidentPositions(
    page.locator('.live-root-walkers'),
  )).map(({ key, x, y }) => ({
    key, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
  }))
  await thingMore.click()
  await expect(page.locator('.live-root-thing-shelf .live-thing-specimen')).toHaveCount(7)
  expect((await liveResidentPositions(page.locator('.live-root-walkers')))
    .map(({ key, x, y }) => ({
      key, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
    }))).toEqual(residentsBeforeThingExpansion)
  const remainingResidentMore = page.locator('.live-root-walkers .live-resident-more')
  await expectTargetCenterExposed(remainingResidentMore)
  await remainingResidentMore.click()
  await expect(page.locator('.live-root-walkers .live-walker')).toHaveCount(8)

  await page.reload()
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const thingsBeforeResidentExpansion = (await liveThingPositions(
    page.locator('.live-root-thing-shelf'),
  )).map(({ key, x, y }) => ({
    key, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
  }))
  const residentFirst = page.locator('.live-root-walkers .live-resident-more')
  await expectTargetCenterExposed(residentFirst)
  await residentFirst.click()
  await expect(page.locator('.live-root-walkers .live-walker')).toHaveCount(8)
  expect((await liveThingPositions(page.locator('.live-root-thing-shelf')))
    .map(({ key, x, y }) => ({
      key, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
    }))).toEqual(thingsBeforeResidentExpansion)
  const remainingThingMore = page.locator('.live-root-thing-shelf .live-thing-more')
  await expectTargetCenterExposed(remainingThingMore)
  await remainingThingMore.click()
  await expect(page.locator('.live-root-thing-shelf .live-thing-specimen')).toHaveCount(7)
})

test('Live refuses exact thing badges when the fixed survey disagrees', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    surveyTotalMismatch: true,
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('#live-history-status')).toContainText(
    'Exact +N thing counts are unavailable',
  )
  await expect(page.locator('.live-thing-more')).toContainText('count unavailable')
  await expect(page.locator('.live-thing-more[data-live-overflow-count]')).toHaveCount(0)
})

test('Live rejects a coercible nonnumeric survey count instead of printing exact badges', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    coercibleSurveyThing: false,
  })
  await page.goto('/window#view=live')

  await expect(page.getByRole('button', { name: 'Retry reading the public city view' }))
    .toBeVisible()
  await expect(page.locator('#live-plates')).toContainText(
    'The current public city view could not be read.',
  )
  await expect(page.locator('.live-thing-more[data-live-overflow-count]')).toHaveCount(0)
})

test('Live keeps exact surveyed counts when newest thing names fail', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    thingFailure: true,
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
    .toHaveText('+5 more')
  await expect(page.locator('#live-history-status')).toContainText(
    'Exact +N thing counts stay verified, but newest named thing cards could not be read',
  )
  await page.getByRole('button', { name: 'Retry named thing cards' }).click()
  await expect.poll(fixture.thingPageRequests).toBe(2)
  await expect(page.getByRole('button', { name: 'Retry named thing cards' })).toBeVisible()
  await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
    .toHaveText('+5 more')
  fixture.recoverThingNames()
  await page.getByRole('button', { name: 'Retry named thing cards' }).click()
  await expect.poll(fixture.thingPageRequests).toBe(3)
  await expect(page.getByRole('button', { name: 'Retry named thing cards' })).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen')).not.toHaveCount(0)
})

test('Live does not chase a repeated cursor after its bounded named thing page', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'stale')
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('#live-history-status')).toContainText('one-page limit of 50')
  await expect.poll(fixture.thingPageRequests).toBe(1)
  await page.waitForTimeout(250)
  expect(fixture.thingPageRequests()).toBe(1)
})

test('Live stops after one named thing page while the fixed survey keeps exact counts', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'long')
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('#live-history-status')).toContainText(
    'exact +N includes every other public thing in this plate',
  )
  await expect.poll(fixture.thingPageRequests).toBe(1)
  await page.waitForTimeout(250)
  expect(fixture.thingPageRequests()).toBe(1)
})

test('Live pauses automatic resident paging after eight valid pages', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    residentPaging: 'long',
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates')).toContainText(
    'Automatic census reading pauses after 1,600 public residents',
  )
  await expect(page.getByRole('button', { name: 'Continue the exact resident census' }))
    .toBeVisible()
  await expect.poll(fixture.residentPageRequests).toBe(8)
})

test('Live pauses automatic opening-history paging after eight valid pages', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    openingPaging: 'long',
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-history-status')).toContainText(
    'Automatic recent-history reading pauses after 1,600 public events',
  )
  await expect(page.getByRole('button', { name: 'Continue recent history' })).toBeVisible()
  await expect.poll(fixture.openingEventRequests).toBe(8)
  await expect(page.locator('#window-status')).toContainText('Watching')
  await page.clock.pauseAt(new Date(now + 10_000))
  const readsBeforePublish = fixture.changeRequests()
  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(fixture.changeRequests).toBeGreaterThan(readsBeforePublish)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await page.getByRole('button', { name: 'Continue recent history' }).click()
  await expect.poll(fixture.openingEventRequests).toBe(9)
  expect(fixture.openingBeforeIds().at(-1)).toBe('893')
  await page.clock.runFor(32)
  await page.waitForTimeout(100)
  await page.clock.runFor(32)
  await expect(page.locator('#live-history-status')).toContainText(
    'Recent history is complete through the 30-minute trace edge',
  )
  await expect(page.locator('.live-replay-portrait')).toHaveAttribute(
    'data-live-replay-key',
    'change:11',
  )
})

test('changes learned on Map stay settled when paused opening history later continues', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    openingPaging: 'long',
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.openingEventRequests).toBe(8)
  await expect(page.locator('#live-history-status')).toContainText(
    'Automatic recent-history reading pauses after 1,600 public events',
  )
  await expect(page.getByRole('button', { name: 'Continue recent history' })).toBeVisible()
  await page.getByRole('tab', { name: 'Map' }).click()

  const readsBeforePublish = fixture.changeRequests()
  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(fixture.changeRequests).toBeGreaterThan(readsBeforePublish)
  await page.getByRole('tab', { name: 'Live' }).click()
  await page.getByRole('button', { name: 'Continue recent history' }).click()
  await expect(page.locator('#live-history-status')).toContainText(
    'Recent history is complete through the 30-minute trace edge',
  )
  await page.clock.runFor(64)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-trail, .live-footstep, .live-speech-bubble')).toHaveCount(0)
})

test('Live opens on settled positions without replay residue', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    openingMovement: true,
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator(
    '.live-plot[data-place-id="3"] [data-live-resident-handle="map-walker"]',
  ).first()).toBeVisible()
  await expect(page.locator('.live-trail')).toHaveCount(0)
  await expect(page.locator('.live-footstep')).toHaveCount(0)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(0)
  await expect(page.locator('.live-action-mark')).toHaveCount(0)
  await expect(page.locator('[marker-end]')).toHaveCount(0)
})

test('place notes use bounded explicit paging and reopen from their sparse deep link', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    roomNoteCount: 52,
    holdRoomNoteRequest: 2,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const notesControl = page.locator('[data-live-notes-place-id="3"]').first()
  await expect(notesControl).toHaveText('notes · 52')
  await notesControl.focus()
  await expect(notesControl).toBeFocused()
  await notesControl.press('Enter')

  const notesPanel = page.locator('#live-notes-panel')
  await expect(notesPanel).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live\?place=3&notes=open$/u)
  await expect.poll(() => fixture.roomNoteRequestPaths().length).toBe(1)
  const firstRequest = new URL(fixture.roomNoteRequestPaths()[0]!, 'https://example.test')
  expect(firstRequest.searchParams.get('view')).toBe('full')
  expect(firstRequest.searchParams.get('subplace_limit')).toBe('1')
  expect(firstRequest.searchParams.get('thing_limit')).toBe('1')
  expect(firstRequest.searchParams.get('note_limit')).toBe('50')
  expect(firstRequest.searchParams.get('note_text_limit_bytes')).toBe('655360')
  expect(firstRequest.searchParams.has('before_note_id')).toBe(false)
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(50)
  await expect(notesPanel.locator('[data-live-note-id="10052"] .live-note-body'))
    .toHaveText(routeBackedLongNoteBody)
  expect(await notesPanel.locator('[data-live-note-id]').evaluateAll(rows => rows.map(row =>
    Number((row as HTMLElement).dataset.liveNoteId))))
    .toEqual(Array.from({ length: 50 }, (_, index) => 10_052 - index))

  const continueNotes = notesPanel.getByRole('button', { name: 'Continue' })
  await expect(continueNotes).toBeVisible()
  await page.waitForTimeout(250)
  expect(fixture.roomNoteRequestPaths()).toHaveLength(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await continueNotes.click()
  await page.waitForTimeout(100)
  expect(fixture.roomNoteRequestPaths()).toHaveLength(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(100)
  expect(fixture.roomNoteRequestPaths()).toHaveLength(1)
  await continueNotes.click()
  await expect.poll(() => fixture.roomNoteRequestPaths().length).toBe(2)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  fixture.releaseHeldRoomNoteRequest()
  await page.waitForTimeout(100)
  expect(fixture.roomNoteRequestPaths()).toHaveLength(2)
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(50)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(continueNotes).toBeVisible()
  await continueNotes.click()
  await expect.poll(() => fixture.roomNoteRequestPaths().length).toBe(3)
  const resumedRequest = new URL(fixture.roomNoteRequestPaths()[2]!, 'https://example.test')
  expect(resumedRequest.searchParams.get('before_note_id')).toBe('10003')
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(52)
  await expect(notesPanel).toContainText('Showing 52 of 52 direct room notes, newest first.')
  await expect(continueNotes).toHaveCount(0)

  await page.reload()
  await expect(page).toHaveURL(/\/window\/live\?place=3&notes=open$/u)
  await expect(notesPanel).toBeVisible()
  await expect.poll(() => fixture.roomNoteRequestPaths().length).toBe(4)
  const reloadRequest = new URL(fixture.roomNoteRequestPaths()[3]!, 'https://example.test')
  expect(reloadRequest.searchParams.has('before_note_id')).toBe(false)
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(50)
  await expect(notesPanel.locator('[data-live-note-id="10052"] .live-note-body'))
    .toHaveText(routeBackedLongNoteBody)
})

test('an incoming room note invalidates an in-flight Continue page before rereading page one', async ({ page }) => {
  const now = Date.now()
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    roomNoteCount: 52,
    holdRoomNoteRequest: 2,
  })
  await page.goto('/window/live?place=3&notes=open')
  const notesPanel = page.locator('#live-notes-panel')
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(50)

  await notesPanel.getByRole('button', { name: 'Continue' }).click()
  await expect.poll(() => fixture.roomNoteRequestPaths().length).toBe(2)
  await publishReplayChanges(page, fixture)
  await expect.poll(() => fixture.roomNoteRequestPaths().length).toBeGreaterThanOrEqual(3)
  fixture.releaseHeldRoomNoteRequest()
  await page.waitForTimeout(150)

  await expect(notesPanel.locator('#live-notes-list [data-live-note-id]')).toHaveCount(50)
  expect(await notesPanel.locator('#live-notes-list [data-live-note-id]').evaluateAll(rows =>
    rows.map(row => Number((row as HTMLElement).dataset.liveNoteId))))
    .toEqual(Array.from({ length: 50 }, (_, index) => 10_052 - index))
  const freshRequest = new URL(fixture.roomNoteRequestPaths().at(-1)!, 'https://example.test')
  expect(freshRequest.searchParams.has('before_note_id')).toBe(false)
})

test('notes Continue repairs newer head rows without auto-following a cursor', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    roomNoteCount: 52,
  })
  await page.goto('/window/live?place=3&notes=open')
  const notesPanel = page.locator('#live-notes-panel')
  const continueNotes = notesPanel.getByRole('button', { name: 'Continue' })
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(50)

  fixture.addRoomNote()
  await continueNotes.click()
  await expect.poll(() => fixture.roomNoteRequestPaths().length).toBe(2)
  const tailRequest = new URL(fixture.roomNoteRequestPaths()[1]!, 'https://example.test')
  expect(tailRequest.searchParams.get('before_note_id')).toBe('10003')
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(52)
  await expect(notesPanel).toContainText('Showing 52 of 53 direct room notes, newest first.')
  await expect(continueNotes).toBeVisible()
  await page.waitForTimeout(250)
  expect(fixture.roomNoteRequestPaths()).toHaveLength(2)

  await continueNotes.click()
  await expect.poll(() => fixture.roomNoteRequestPaths().length).toBe(3)
  const headRepair = new URL(fixture.roomNoteRequestPaths()[2]!, 'https://example.test')
  expect(headRepair.searchParams.has('before_note_id')).toBe(false)
  expect(headRepair.searchParams.get('note_limit')).toBe('50')
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(53)
  await expect(notesPanel.locator('[data-live-note-id="10053"]')).toContainText(
    'new route-backed note 10053',
  )
  await expect(notesPanel).toContainText('Showing 53 of 53 direct room notes, newest first.')
  await expect(continueNotes).toHaveCount(0)
  expect(fixture.roomNoteRequestPaths().every(path =>
    new URL(path, 'https://example.test').searchParams.get('note_limit') === '50')).toBe(true)
})

test('notes controls expose panel state and Escape restores the opener', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, { roomNoteCount: 2 })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const notesControl = page.locator('[data-live-notes-place-id="3"]').first()
  await expect(notesControl).toHaveAttribute('aria-controls', 'live-notes-panel')
  await expect(notesControl).toHaveAttribute('aria-expanded', 'false')
  await notesControl.focus()
  await notesControl.press('Enter')
  await expect(page.locator('#live-notes-panel')).toBeVisible()
  await expect(notesControl).toHaveAttribute('aria-expanded', 'true')
  await page.locator('#live-notes-close').focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('#live-notes-panel')).toBeHidden()
  await expect(notesControl).toHaveAttribute('aria-expanded', 'false')
  await expect(notesControl).toBeFocused()
})

test('Live does not continue resident census reads while hidden and resumes when visible', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    residentPaging: 'long', residentDelayMs: 500,
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.residentPageRequests).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(650)
  expect(fixture.residentPageRequests()).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(fixture.residentPageRequests).toBeGreaterThan(1)
})

test('Live does not continue opening-history reads while hidden and resumes when visible', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    openingPaging: 'long', openingMarker: '12', openingDelayMs: 500,
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.openingEventRequests).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hiddenReadCounts = {
    windows: fixture.windowRequests(),
    changes: fixture.changeRequests(),
  }
  await page.waitForTimeout(650)
  expect(fixture.openingEventRequests()).toBe(1)
  expect({
    windows: fixture.windowRequests(),
    changes: fixture.changeRequests(),
  }).toEqual(hiddenReadCounts)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(fixture.openingEventRequests).toBeGreaterThan(1)
})

test('Live catches up after a hidden tab without replaying the hidden backlog', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const readsBeforeCatchUp = fixture.changeRequests()
  fixture.publish()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })

  await expect.poll(fixture.changeRequests).toBeGreaterThan(readsBeforeCatchUp)
  await expectMapWalkerSettledAtLantern(page)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-trail, .live-footstep, .live-speech-bubble')).toHaveCount(0)
})

test('Live cancels an in-flight sprite animation while the document is hidden', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    movementOnly: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(1)
  await expect.poll(() => page.locator('#live-panel').evaluate(node =>
    node.getAnimations({ subtree: true }).filter(animation =>
      animation.playState === 'running').length)).toBeGreaterThan(0)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => page.locator('#live-panel').evaluate(node =>
    node.getAnimations({ subtree: true }).filter(animation =>
      animation.playState === 'running').length)).toBe(0)
  await page.clock.runFor(1_000)
  expect(await page.locator('#live-panel').evaluate(node =>
    node.getAnimations({ subtree: true }).filter(animation =>
      animation.playState === 'running').length)).toBe(0)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(32)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
})

test('Live moves a carried thing with its owner and names the carry', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    carryMove: true,
    movementOnly: true,
  })
  await page.goto('/window#view=live')
  const carriedThing = page.locator('[data-live-thing-id="20"]')
  await expect(page.locator('[data-place-id="2"] [data-live-thing-id="20"]')).toHaveCount(1)

  await publishReplayChanges(page, fixture)

  await expect(page.locator('[data-place-id="2"] [data-live-thing-id="20"]')).toHaveCount(0)
  await expect(carriedThing).toHaveCount(1)
  await carriedThing.focus()
  await expect(page.locator(
    '#live-item-popover [data-live-popover-field="last-action"]',
  )).toContainText(
    'map-walker moved carrying Thing #20: Cinder lane → Lantern nook',
  )
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0, { timeout: 9_000 })
  const harborOpen = page.locator('.live-plot[data-place-id="3"] > .live-plot-open')
  await harborOpen.focus()
  await expect(harborOpen).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-place-id="4"] [data-live-thing-id="20"]')).toHaveCount(1)
})

test('an empty read already in flight cannot consume hidden-backlog suppression', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  fixture.holdNextEmptyChange()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(fixture.heldEmptyChangeRequests).toBe(1)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  fixture.publish()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const readsBeforeRelease = fixture.changeRequests()
  fixture.releaseHeldEmptyChange()

  await expect.poll(fixture.changeRequests).toBeGreaterThan(readsBeforeRelease)
  await expectMapWalkerSettledAtLantern(page)
  await page.waitForTimeout(300)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-trail, .live-footstep, .live-speech-bubble')).toHaveCount(0)
})

test('a final opening page completed while hidden cannot release queued stale motion', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    holdOpeningPage: true,
    openingMarker: '10',
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.openingEventRequests).toBe(1)

  fixture.publish()
  const readsBeforePublish = fixture.changeRequests()
  await expect.poll(async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    return fixture.changeRequests()
  }).toBeGreaterThan(readsBeforePublish)
  await expectMapWalkerSettledAtLantern(page)
  await expect(page.locator('#window-status')).toContainText('Watching')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const readsBeforeVisibleCatchUp = fixture.changeRequests()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(fixture.changeRequests).toBeGreaterThan(readsBeforeVisibleCatchUp)
  await expect(page.locator('#window-status')).toContainText('Watching')
  fixture.releaseHeldOpeningPage()
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await page.waitForTimeout(300)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-trail, .live-footstep, .live-speech-bubble')).toHaveCount(0)
})

test('a hidden multi-page opening continuation keeps pre-hide pending changes static', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    openingPaging: 'long',
    openingMarker: '10',
    openingDelayMs: 100,
    holdOpeningRequest: 2,
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.openingEventRequests).toBe(2)

  fixture.publish()
  const readsBeforePublish = fixture.changeRequests()
  await expect.poll(async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    return fixture.changeRequests()
  }).toBeGreaterThan(readsBeforePublish)
  await expectMapWalkerSettledAtLantern(page)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  fixture.releaseHeldOpeningPage()
  await page.waitForTimeout(150)
  expect(fixture.openingEventRequests()).toBe(2)

  const readsBeforeVisibleCatchUp = fixture.changeRequests()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(fixture.changeRequests).toBeGreaterThan(readsBeforeVisibleCatchUp)
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect.poll(fixture.openingEventRequests).toBe(9)

  await page.waitForTimeout(300)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-trail, .live-footstep, .live-speech-bubble')).toHaveCount(0)
})

test('Live finishes one named thing page while hidden and does not start another', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'long', 0, {
    thingDelayMs: 500,
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.thingPageRequests).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(650)
  expect(fixture.thingPageRequests()).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(650)
  expect(fixture.thingPageRequests()).toBe(1)
})

test('Live opening note residue starts no eager detail reads or bubbles', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 8)
  await page.goto('/window#view=live')

  await expect.poll(fixture.activeNoteRequests).toBe(0)
  expect(fixture.maximumNoteRequests()).toBe(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
})

test('Live stage portraits stay unboxed on the ground and when focused', async ({ page }) => {
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const portrait = page.locator('.live-walker .live-portrait').first()
  await portrait.scrollIntoViewIfNeeded()
  const shell = portrait.locator('.entity-portrait')
  await expect(shell).toHaveAttribute('data-portrait-state', 'loaded')
  expect(await portrait.evaluate(button => {
    const buttonStyle = getComputedStyle(button)
    const portraitShell = button.querySelector('.entity-portrait')
    const placeholder = button.querySelector('.entity-portrait-placeholder')
    const shellStyle = portraitShell ? getComputedStyle(portraitShell) : null
    const placeholderStyle = placeholder ? getComputedStyle(placeholder) : null
    return {
      buttonBackgroundColor: buttonStyle.backgroundColor,
      buttonBackgroundImage: buttonStyle.backgroundImage,
      buttonBorderStyle: buttonStyle.borderStyle,
      buttonBoxShadow: buttonStyle.boxShadow,
      shellBackgroundColor: shellStyle?.backgroundColor ?? null,
      shellBackgroundImage: shellStyle?.backgroundImage ?? null,
      placeholderBackgroundColor: placeholderStyle?.backgroundColor ?? null,
      placeholderBackgroundImage: placeholderStyle?.backgroundImage ?? null,
    }
  })).toEqual({
    buttonBackgroundColor: 'rgba(0, 0, 0, 0)',
    buttonBackgroundImage: 'none',
    buttonBorderStyle: 'none',
    buttonBoxShadow: 'none',
    shellBackgroundColor: 'rgba(0, 0, 0, 0)',
    shellBackgroundImage: 'none',
    placeholderBackgroundColor: 'rgba(0, 0, 0, 0)',
    placeholderBackgroundImage: 'none',
  })

  await portrait.click()
  await expect(portrait.locator('..')).toHaveAttribute('data-live-focus-resident')
  expect(await portrait.evaluate(button => {
    const style = getComputedStyle(button)
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })).toEqual({
    boxShadow: 'none',
    outlineStyle: 'solid',
    outlineWidth: '4px',
  })
})

test('Live opens a 40-resident fixture with 3 full drawing reads and 10 thumbnails', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    crowdPlaceId: 2,
    residentCrowdSize: 40,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const roster = page.locator('#live-roster .resident-row')
  await expect(roster).toHaveCount(41)
  await roster.nth(11).scrollIntoViewIfNeeded()
  await expect.poll(fixture.thumbnailRequests).toBe(8)
  for (let step = 0; step < 100 && fixture.thumbnailRequests() < 10; step += 1) {
    await page.evaluate(() => window.scrollBy(0, 8))
    await page.waitForTimeout(16)
  }
  await expect.poll(fixture.thumbnailRequests).toBe(10)
  await expect.poll(fixture.activeDrawingRequests).toBe(0)

  expect(fixture.drawingRequests()).toBe(3)
  expect(fixture.thumbnailRequests()).toBe(10)
})

test('rapid crowd hover keeps popover drawing metadata inside the bounded read queue', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    crowdPlaceId: 2,
    residentCrowdSize: 40,
    drawingDelayMs: 400,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect.poll(fixture.activeDrawingRequests).toBe(0)

  const cinder = page.locator('.live-plot[data-place-id="2"]')
  await cinder.locator('.live-resident-more').click()
  const portraits = cinder.locator('.live-walker .live-portrait')
  await expect(portraits).toHaveCount(41)
  await portraits.evaluateAll(nodes => {
    for (const node of nodes.slice(0, 10)) {
      node.dispatchEvent(new PointerEvent('pointerenter'))
    }
  })

  await expect.poll(fixture.drawingRequests).toBeGreaterThan(3)
  await expect.poll(fixture.activeDrawingRequests).toBe(0)
  expect(fixture.maximumDrawingRequests()).toBeLessThanOrEqual(4)
})

test('crowded live speech reads and redraws only the active detail budget', async ({ page }) => {
  await installLiveRenderWorkRecorder(page)
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 20)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await panLiveTargetIntoView(page, page.locator('.live-plot[data-place-id="3"]'))
  await resetLiveRenderWork(page)

  await publishReplayChanges(page, fixture)
  await expect.poll(fixture.noteRequests).toBeGreaterThan(0)
  await page.waitForTimeout(750)
  await expect.poll(fixture.activeNoteRequests).toBe(0)
  expect(fixture.noteRequests()).toBe(6)
  expect(fixture.maximumNoteRequests()).toBeLessThanOrEqual(4)
  const bubbles = page.locator('.live-speech-bubble')
  await expect(bubbles).toHaveCount(6)
  const bubbleActors = new Set(await bubbles.evaluateAll(nodes => nodes.map(node =>
    node.closest('.live-portrait-wrap')?.querySelector<HTMLElement>(
      '[data-live-resident-handle]',
    )?.dataset.liveResidentHandle)))
  expect(bubbleActors.size).toBe(6)

  const promotedActor = Array.from({ length: 20 }, (_, index) => `burst-${index + 1}`)
    .find(actor => !bubbleActors.has(actor))
  expect(promotedActor).toBeTruthy()
  await page.locator(
    `#live-roster [data-live-resident-handle="${promotedActor}"]`,
  ).click()
  await expect(page.locator('#live-focus-status')).toContainText(`Focused on ${promotedActor}`)
  await expect.poll(fixture.noteRequests).toBe(7)
  await expect.poll(fixture.activeNoteRequests).toBe(0)
  await expect(page.locator(
    `.live-portrait-wrap:has([data-live-resident-handle="${promotedActor}"]) ` +
    '.live-speech-bubble',
  )).toBeVisible()
  await expect(bubbles).toHaveCount(7)
  expect((await readLiveRenderWork(page)).renders).toBeLessThanOrEqual(8)
})

test('distant place note controls settle past the bounded metadata queue with exact counts', async ({ page }) => {
  await page.addInitScript(() => {
    const inexactControls: string[] = []
    Object.defineProperty(window, '__inexactLiveNotesControls', {
      configurable: true,
      value: inexactControls,
    })
    Object.defineProperty(window, '__livePlaceMetadataLoadCalls', {
      configurable: true,
      writable: true,
      value: 0,
    })
    const inspect = () => {
      for (const control of document.querySelectorAll('.live-place-notes')) {
        const text = control.textContent?.trim() ?? ''
        if (!/^notes · \d+$/u.test(text)) inexactControls.push(text)
      }
    }
    new MutationObserver(inspect).observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  })
  await page.route('**/window.js', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const signature = '  function loadLivePlaceMetadata(placeId, force = false) {'
    expect(source.split(signature)).toHaveLength(2)
    let body = source.replace(signature, signature + '\n' +
      '    window.__livePlaceMetadataLoadCalls += 1')
    await route.fulfill({ response, body })
  })
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingPlaceCount: 80,
    omitDrawingPlacesFromOutline: true,
    placeMetadataDelayMs: 20,
  })
  await page.goto('/window#view=live')

  const distantPlot = page.locator('.live-plot[data-live-detail="false"]').last()
  await expect(distantPlot).toBeAttached()
  const placeId = Number(await distantPlot.getAttribute('data-place-id'))
  expect(placeId).toBeGreaterThanOrEqual(100)
  const notes = distantPlot.locator('.live-place-notes')
  await expect(notes, 'the far place resolves after the first 32 queued reads')
    .toHaveText('notes · ' + String(placeId - 99), { timeout: 15_000 })
  await expect(notes).toBeEnabled()
  await expect(notes).toHaveAttribute('data-live-notes-count', String(placeId - 99))
  await expect(page.locator('.live-place-notes-pending, .live-place-notes-retry'))
    .toHaveCount(0, { timeout: 15_000 })
  const exactControls = await page.locator('#live-plates').evaluate(plates => {
    const expected = plates.querySelectorAll('.live-plot, .live-root-place-item').length
    const controls = [...plates.querySelectorAll<HTMLButtonElement>('.live-place-notes')]
    return {
      expected,
      actual: controls.length,
      exactAndOperable: controls.every(control =>
        /^notes · \d+$/u.test(control.textContent?.trim() ?? '') && !control.disabled),
    }
  })
  expect(exactControls).toEqual({
    expected: exactControls.expected,
    actual: exactControls.expected,
    exactAndOperable: true,
  })
  expect(await page.evaluate(() => [
    ...((window as Window & { __inexactLiveNotesControls?: string[] })
      .__inexactLiveNotesControls ?? []),
  ])).toEqual([])
  expect(fixture.focusedPlaceRequests()).toBeGreaterThan(32)
  expect(fixture.maximumPlaceMetadataRequests()).toBeGreaterThan(0)
  expect(fixture.maximumPlaceMetadataRequests()).toBeLessThanOrEqual(3)
  expect(fixture.activePlaceMetadataRequests()).toBe(0)
  expect(fixture.placeMetadataRequestPaths()).toHaveLength(80)
  expect(await page.evaluate(() => (window as Window & {
    __livePlaceMetadataLoadCalls?: number
  }).__livePlaceMetadataLoadCalls ?? 0)).toBeLessThanOrEqual(240)
  expect(fixture.placeMetadataRequestPaths().every(path => {
    const url = new URL(path, 'https://example.test')
    return url.searchParams.get('view') === 'outline' &&
      url.searchParams.get('after_change_marker') === '10'
  })).toBe(true)

  const metadataReadsBeforeUnrelatedActivity = fixture.placeMetadataRequestPaths().length
  await publishReplayChanges(page, fixture)
  await expect(page.locator('.live-replay-portrait')).not.toHaveCount(0)
  await expect.poll(fixture.activePlaceMetadataRequests).toBe(0)
  expect(fixture.placeMetadataRequestPaths()).toHaveLength(
    metadataReadsBeforeUnrelatedActivity,
  )

  await distantPlot.locator('.live-plot-open').focus()
  await expect(page.locator(
    '#live-item-popover [data-live-popover-field="owner"]',
  )).toContainText('drawing-owner-' + String(placeId - 99))
})

test('malformed room metadata never becomes a false exact zero note count', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingPlaceCount: 1,
    omitDrawingPlacesFromOutline: true,
    malformedMetadataPlaceId: 100,
  })
  await page.goto('/window#view=live')

  const plot = page.locator('.live-plot[data-place-id="100"]')
  await expect(plot.locator('.live-place-notes-retry')).toHaveText('Retry notes')
  await expect(plot.locator('.live-place-notes')).toHaveCount(0)
  await expect(plot).not.toContainText('notes · 0')
})

test('a place transfer selectively refreshes that place popover without a metadata storm', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingPlaceCount: 2,
    omitDrawingPlacesFromOutline: true,
    publishedPlaceTransferId: 100,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('.live-plot[data-place-id="100"]')).toBeAttached()
  await expect(page.locator('.live-place-notes-pending')).toHaveCount(0)
  await expect.poll(() => fixture.placeMetadataRequestPaths().length).toBe(2)

  const transferred = page.locator('.live-plot[data-place-id="100"] .live-plot-open')
  await transferred.focus()
  const owner = page.locator('#live-item-popover [data-live-popover-field="owner"]')
  await expect(owner).toContainText('drawing-owner-1')
  await publishReplayChanges(page, fixture)
  await expect.poll(() => fixture.placeMetadataRequestPaths().length).toBe(3)
  const refreshed = new URL(fixture.placeMetadataRequestPaths()[2]!, 'https://example.test')
  expect(refreshed.searchParams.get('parent_id')).toBe('100')
  expect(refreshed.searchParams.get('after_change_marker')).toBe('18')
  await expect(owner).toContainText('new-place-owner')
})

test('Live renders nearby detail and distant place sprites with bounded drawing reads', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingDelayMs: 20,
    drawingPlaceCount: 80,
  })
  await page.goto('/window#view=live')

  await expect.poll(fixture.maximumDrawingRequests).toBeGreaterThan(0)
  await expect.poll(() => page.locator(
    '.live-plot[data-live-detail="true"] .drawing-loading, ' +
    '.live-root-place-sprite .drawing-loading, .live-root-walkers .drawing-loading, ' +
    '.live-root-thing-shelf .drawing-loading',
  ).count(), { timeout: 15_000 }).toBe(0)
  await expect.poll(fixture.activeDrawingRequests).toBe(0)
  await expect(page.locator('.live-plot[data-live-detail="true"]')).not.toHaveCount(0)
  const distantPlots = page.locator('.live-plot[data-live-detail="false"]')
  await expect(distantPlots).not.toHaveCount(0)
  expect(await distantPlots.evaluateAll(plots => plots.every(plot =>
    (plot as HTMLElement).dataset.liveDetailMounted === 'false'))).toBe(true)
  await expect(distantPlots.locator('.live-portrait-grid, .live-thing-shelf')).toHaveCount(0)
  const initialDetailBudget = await page.locator('.live-plot').evaluateAll(plots => ({
    detailedPlots: plots.filter(plot => (plot as HTMLElement).dataset.liveDetail === 'true').length,
    mountedPlots: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetailMounted === 'true').length,
  }))
  expect(initialDetailBudget.mountedPlots).toBe(initialDetailBudget.detailedPlots)
  expect(initialDetailBudget.detailedPlots).toBeLessThanOrEqual(20)
  expect(fixture.drawingRequests()).toBeGreaterThan(0)
  expect(fixture.drawingRequests()).toBe(
    new Set(fixture.drawingRequestPaths()).size,
  )
  expect(fixture.drawingRequests()).toBeLessThanOrEqual(90)
  expect(fixture.maximumDrawingRequests()).toBeLessThanOrEqual(4)

  const markerPlaceId = await distantPlots.first().getAttribute('data-place-id')
  expect(markerPlaceId).not.toBeNull()
  const markerPlot = page.locator(`.live-plot[data-place-id="${markerPlaceId}"]`)
  const markerTarget = markerPlot.locator('.live-plot-open')
  const markerBox = await markerTarget.boundingBox()
  expect(markerBox).not.toBeNull()
  expect(markerBox!.width).toBeGreaterThanOrEqual(44)
  expect(markerBox!.height).toBeGreaterThanOrEqual(44)

  await panLiveTargetIntoView(page, markerTarget)
  await expect(markerPlot).toHaveAttribute('data-live-detail', 'true')
  await expect(markerPlot).toHaveAttribute('data-live-detail-mounted', 'true')
  expect(await page.locator('.live-plot[data-live-detail="false"]').evaluateAll(plots =>
    plots.every(plot => (plot as HTMLElement).dataset.liveDetailMounted === 'false')))
    .toBe(true)
  await expect(page.locator('.live-plot[data-live-detail="false"]')
    .locator('.live-portrait-grid, .live-thing-shelf')).toHaveCount(0)
  await expect.poll(() => page.locator(
    '.live-plot[data-live-detail="true"]',
  ).count()).toBeLessThanOrEqual(20)
})

test('record detail closes on its backdrop but stays open for clicks inside the record', async ({ page }) => {
  await installReplayRoutes(page, Date.now())
  await page.route('**/api/thing/9', route => route.fulfill({ json: {
    thing: {
      id: 9, place_id: 3, name: 'field lantern', body: 'a steady mark',
      made_by: 'map-walker', current_owner: 'map-walker', moderated: false,
    },
  } }))
  await page.goto('/window/thing/9')

  const detail = page.locator('#record-detail')
  await expect(detail).toBeVisible()
  await detail.locator('article').click()
  await expect(detail).toBeVisible()

  await page.mouse.click(4, 4)
  await expect(detail).toBeHidden()

  await page.goto('/window/thing/9')
  await expect(detail).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).toBeHidden()
})

test('Live drops queued drawings from the old plate before reading a newly opened plate', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingDelayMs: 2_000,
    drawingPlaceCount: 80,
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.activeDrawingRequests).toBe(4)

  await page.locator('.live-plot[data-place-id="179"] .live-plot-open')
    .evaluate(node => (node as HTMLButtonElement).click())
  await expect(page).toHaveURL(/\/window\/live\?place=179$/u)
  await expect.poll(
    () => fixture.drawingRequestPaths().includes('/api/drawing/place/179'),
    { timeout: 3_000 },
  ).toBe(true)
  expect(fixture.maximumDrawingRequests()).toBeLessThanOrEqual(4)
})

test('discoverable preview proof scene visibly demonstrates every Live behavior and Retry', async ({ page }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  const proofButton = page.getByRole('button', { name: 'Run preview proof scene' })
  await expect(proofButton).toBeVisible()
  await page.clock.pauseAt(new Date(now + 10_000))
  await proofButton.click()
  await page.clock.runFor(32)
  const proofPanel = page.locator('#live-panel[data-live-proof="true"]')
  await expect(proofPanel).toBeVisible()
  await expect(proofPanel).toHaveAttribute('data-live-proof-phase', 'opening')
  await expect(proofPanel.locator(
    '.live-replay-portrait, .live-trail, .live-footstep, .live-speech-bubble, ' +
    '[marker-end], .live-footnote-mark, .live-action-mark',
  )).toHaveCount(0)
  await expectProofDrawingContract(page)
  expect(fixture.thumbnailRequestPaths().some(path =>
    /\/(?:9201|9402)\/thumb\.png/u.test(path))).toBe(false)

  const retry = page.getByRole('button', { name: 'Retry proof room' })
  await expect(retry).toBeVisible()
  await expectTargetCenterExposed(retry)
  await retry.click()
  await page.clock.runFor(32)
  await expect(retry).toHaveCount(0)

  const proofAlexSettled = proofPanel.locator(
    '.live-walker [data-live-resident-handle="proof-alex"]',
  ).first()
  await proofAlexSettled.focus()
  const popover = page.locator('#live-item-popover[data-live-item-popover="true"]')
  await expect(popover).toBeVisible()
  await expect(popover.locator('[data-live-popover-field="state"]')).toContainText('Complete')
  await expect(popover.locator('[data-live-popover-field="maker"]')).toContainText('proof-alex')
  await expect(popover.locator('[data-live-popover-field="owner"]')).toContainText('proof-alex')
  await expect(popover.locator('[data-live-popover-field="size"]')).toContainText('8 × 8 pixels')
  await expect(popover.locator('[data-live-popover-field="last-action"]')).toContainText(
    'Not present in this bounded Live read',
  )
  const notesControl = proofPanel.locator('[data-live-notes-place-id="9101"]').first()
  await expect(notesControl).toHaveText('notes · 52')
  await notesControl.focus()
  await expect(popover).toBeHidden()
  await notesControl.press('Enter')
  await page.clock.runFor(32)
  const notesPanel = page.locator('#live-notes-panel')
  await expect(notesPanel).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live\?place=9101&notes=open$/u)
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(50)
  await expect(notesPanel.locator('[data-live-note-id="9852"] .live-note-body')).toHaveText(
    'The newest proof note keeps its whole long body: ' + 'x'.repeat(2_400),
  )
  await expect(notesPanel).toContainText('Showing 50 of 52 direct room notes, newest first.')
  const continueNotes = notesPanel.getByRole('button', { name: 'Continue' })
  await continueNotes.click()
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(52)
  await expect(notesPanel).toContainText('Showing 52 of 52 direct room notes, newest first.')
  await expect(continueNotes).toHaveCount(0)
  await notesPanel.getByRole('button', { name: 'Close notes' }).click()
  await page.clock.runFor(32)
  await expect(notesPanel).toBeHidden()

  const stage = proofPanel.locator('#live-stage')
  const thingName = proofPanel.locator('.live-plot .live-thing-name').first()
  await expect(stage).toHaveAttribute('data-live-label-mode', 'far')
  expect(await thingName.evaluate(node => getComputedStyle(node).visibility)).toBe('hidden')
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Zoom in' }).click()
  }
  await page.clock.runFor(32)
  await expect(stage).toHaveAttribute('data-live-label-mode', 'readable')
  expect(await thingName.evaluate(node => getComputedStyle(node).visibility)).toBe('visible')
  expect(await thingName.evaluate(node => ({
    overflow: getComputedStyle(node).overflow,
    textOverflow: getComputedStyle(node).textOverflow,
    whiteSpace: getComputedStyle(node).whiteSpace,
  }))).toEqual({ overflow: 'visible', textOverflow: 'clip', whiteSpace: 'normal' })
  expect(await proofPanel.locator('.live-plot-name').first().evaluate(
    node => getComputedStyle(node).visibility,
  )).toBe('visible')

  await proofButton.click()
  await page.clock.runFor(32)
  await expect(proofPanel).toHaveAttribute('data-live-proof-phase', 'opening')
  await page.getByRole('button', { name: 'Play live actions' }).click()
  await page.clock.runFor(32)
  await expect(proofPanel).toHaveAttribute('data-live-proof-phase', 'movement')

  const replays = proofPanel.locator('.live-replay-portrait')
  let concurrentReplayKeys: Array<string | undefined> = []
  await expect.poll(async () => {
    concurrentReplayKeys = await replays.evaluateAll(nodes => nodes.map(node =>
      (node as HTMLElement).dataset.liveReplayKey))
    return new Set(concurrentReplayKeys).size
  }).toBe(64)
  await expect(proofPanel.locator(
    '.live-replay-portrait[data-live-movement="detail"]',
  )).toHaveCount(6)
  await expect(proofPanel.locator(
    '.live-replay-portrait[data-live-movement="simple"]',
  )).toHaveCount(58)
  let proofFootsteps = 0
  for (let elapsed = 0; elapsed < 1_300 && proofFootsteps < 12; elapsed += 100) {
    await page.clock.runFor(100)
    proofFootsteps = await proofPanel.locator('.live-footstep').count()
  }
  expect(proofFootsteps).toBeGreaterThanOrEqual(12)

  const proofAlex = proofPanel.locator(
    '.live-replay-portrait [data-live-resident-handle="proof-alex"]',
  )
  await proofAlex.evaluate(node => (node as HTMLButtonElement).click())
  await page.clock.runFor(32)
  await expect(proofPanel.locator('.live-trail')).toHaveCount(0)
  await expect(proofPanel.locator(
    '.live-replay-portrait[data-live-movement="detail"]',
  )).toHaveCount(7)
  await proofAlex.evaluate(node => (node as HTMLButtonElement).click())
  await page.clock.runFor(32)

  await page.getByRole('button', { name: 'Follow proof-alex while crowd moves' }).click()
  await page.clock.runFor(32)
  await expect(replays).toHaveCount(64)
  await expect(proofPanel.locator('.live-trail[data-live-actor="proof-alex"]')).toHaveCount(1)
  await expect(proofPanel.locator(
    '.live-replay-portrait[data-live-movement="detail"]',
  )).toHaveCount(7)
  await expect(proofPanel.locator(
    '.live-replay-portrait[data-live-movement="simple"]',
  )).toHaveCount(57)
  await expect(proofPanel.locator(
    '#live-label-layer [data-live-resident-tag="proof-alex"]',
  )).toBeVisible()

  for (let frameWindow = 0; frameWindow < 16; frameWindow += 1) {
    await page.clock.runFor(500)
  }
  await expect(replays).toHaveCount(0)

  const playInteractions = page.getByRole('button', {
    name: 'Play live speech and thing use',
  })
  await expect(playInteractions).toBeEnabled()
  await playInteractions.click()
  await page.clock.runFor(32)
  await expect(proofPanel).toHaveAttribute('data-live-proof-phase', 'interactions')
  const bubble = proofPanel.locator('.live-speech-bubble[data-live-note-id="9301"]')
  for (let elapsed = 0; elapsed < 2_000 && await bubble.count() === 0; elapsed += 100) {
    await page.clock.runFor(100)
  }
  await expect(bubble).toBeVisible()
  expect(await bubble.evaluate(node => {
    const style = getComputedStyle(node)
    return {
      background: style.backgroundColor,
      border: [style.borderTopWidth, style.borderRightWidth,
        style.borderBottomWidth, style.borderLeftWidth],
      boxShadow: style.boxShadow,
      textShadow: style.textShadow,
    }
  })).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    border: ['0px', '0px', '0px', '0px'],
    boxShadow: 'none',
    textShadow: expect.not.stringMatching(/^none$/u),
  })

  const viewport = page.locator('#live-viewport')
  await viewport.focus()
  for (let pan = 0; pan < 24; pan += 1) await viewport.press('ArrowRight')
  await page.clock.runFor(300)
  await expect(bubble).toHaveCount(0)
  for (let pan = 0; pan < 24; pan += 1) await viewport.press('ArrowLeft')
  await page.clock.runFor(300)
  await expect(bubble).toBeVisible()
  await expect(bubble).toHaveAttribute('data-live-offscreen', 'false')

  await page.evaluate(() => {
    const panel = document.querySelector('#live-notes-panel')!
    const observer = new MutationObserver(() => {
      const target = panel.querySelector('[data-live-note-id="9301"]')
      const status = panel.querySelector('#live-notes-status')?.textContent || ''
      const continueButton = panel.querySelector<HTMLButtonElement>('.live-notes-continue')
      if (!target || !status.includes('Showing 50 of 52') || !continueButton) return
      observer.disconnect()
      ;(panel as HTMLElement).dataset.liveFocusRaceTriggered = 'true'
      continueButton.click()
    })
    observer.observe(panel, { childList: true, subtree: true, characterData: true })
  })
  await bubble.evaluate(node => (node as HTMLButtonElement).click())
  await page.clock.runFor(32)
  await expect(notesPanel).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live\?place=9103&notes=open$/u)
  const spokenNote = notesPanel.locator('[data-live-note-id="9301"]')
  await expect(notesPanel).toHaveAttribute('data-live-focus-race-triggered', 'true')
  await expect(notesPanel).toContainText('Showing 52 of 52 direct room notes, newest first.')
  await expect(spokenNote).toBeFocused()
  await expect(spokenNote.locator('.live-note-body')).toHaveText(
    'spoke: sixty-four residents move together while this message appears.',
  )
  await expect(notesPanel.locator('#live-notes-list [data-live-note-id]')).toHaveCount(52)
  await expect(notesPanel.locator('[data-live-note-id]')).toHaveCount(52)
  await expect(notesPanel.getByRole('button', { name: 'Continue' })).toHaveCount(0)
  await notesPanel.getByRole('button', { name: 'Close notes' }).click()

  const useReplay = proofPanel.locator('.live-use-replay').first()
  const pulsingThing = proofPanel.locator('.live-thing-specimen.live-pulse').first()
  for (let elapsed = 0; elapsed < 20_000 && await useReplay.count() === 0; elapsed += 200) {
    await page.clock.runFor(200)
  }
  await expect(useReplay).toBeVisible()
  await expect(pulsingThing).toBeVisible()
  const useDistance = await useReplay.evaluate((resident, selector) => {
    const thing = document.querySelector<HTMLElement>(selector as string)
    if (!thing) return Number.POSITIVE_INFINITY
    const residentBox = resident.getBoundingClientRect()
    const thingBox = thing.getBoundingClientRect()
    return Math.hypot(
      residentBox.left + residentBox.width / 2 - (thingBox.left + thingBox.width / 2),
      residentBox.top + residentBox.height / 2 - (thingBox.top + thingBox.height / 2),
    )
  }, '[data-live-thing-id="' + await useReplay.getAttribute('data-live-use-thing-id') + '"]')
  expect(useDistance).toBeLessThan(140)
  await viewport.focus()
  for (let pan = 0; pan < 24; pan += 1) await viewport.press('ArrowRight')
  await page.clock.runFor(300)
  await expect(pulsingThing).toHaveAttribute('data-live-offscreen', 'true')
  expect(await pulsingThing.evaluate(node =>
    node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
  )).toBe(0)
  for (let pan = 0; pan < 24; pan += 1) await viewport.press('ArrowLeft')
  await page.clock.runFor(2_000)
  await expect(useReplay).toHaveCount(0)
  await expect(proofPanel.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)

  const residentMore = proofPanel.getByRole('button', { name: /Show .* more residents/u })
  const thingMore = proofPanel.getByRole('button', { name: /Show .* more things/u })
  await expect(residentMore).toBeVisible()
  await expect(thingMore).toBeVisible()
  await expectTargetCenterExposed(residentMore)
  await expectTargetCenterExposed(thingMore)
  await residentMore.click()
  await page.clock.runFor(32)
  await expectTargetCenterExposed(thingMore)
  await thingMore.click()
  await page.clock.runFor(32)
  await expect(proofPanel.getByRole('dialog')).toHaveCount(0)
  await expect(proofPanel.locator('.live-thing-specimen')).toHaveCount(7)
  const representedResidents = await proofPanel.locator(
    '.live-walker [data-live-resident-handle]',
  ).evaluateAll(nodes => new Set(nodes.map(node =>
    (node as HTMLElement).dataset.liveResidentHandle)).size)
  expect(representedResidents).toBe(151)

  await proofButton.click()
  await page.clock.runFor(32)
  await expect(proofPanel).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry proof room' })).toBeVisible()
})

test('exiting the preview proof scene restores ordinary place choices without a reload', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const optionValues = () => page.locator('#place-filter option').evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value))
  const ordinaryOptions = await optionValues()
  expect(ordinaryOptions).toContain('2')
  expect(ordinaryOptions).not.toContain('9102')

  const proofButton = page.getByRole('button', { name: 'Run preview proof scene' })
  await proofButton.click()
  await expect(page.locator('#live-panel')).toHaveAttribute('data-live-proof', 'true')
  await expect.poll(optionValues).toEqual(['', '9101', '9102', '9103', '9104'])

  const windowRequestsBeforeExit = fixture.windowRequests()
  const exit = page.getByRole('button', { name: 'Exit preview proof scene' })
  await exit.focus()
  await expect(exit).toBeFocused()
  await exit.press('Enter')
  await page.clock.runFor(32)
  await expect(page.locator('#live-panel')).not.toHaveAttribute('data-live-proof', 'true')
  expect(fixture.windowRequests()).toBe(windowRequestsBeforeExit)
  expect(await optionValues()).toEqual(ordinaryOptions)
  await expect(proofButton).toBeFocused()
  await expect(page.locator('.live-plot[data-place-id="2"]')).toHaveCount(1)
  await expect(page.locator('.live-plot[data-place-id="9102"]')).toHaveCount(0)
})

test('preview proof scene has a static reduced-motion alternative', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await page.getByRole('button', { name: 'Run preview proof scene' }).click()

  const proofPanel = page.locator('#live-panel[data-live-proof="true"]')
  await expect(proofPanel).toBeVisible()
  await expect(proofPanel).toHaveAttribute('data-live-proof-phase', 'opening')
  await expectProofDrawingContract(page, true)
  await expect(proofPanel.locator(
    '.live-replay-portrait, .live-trail, .live-footstep, .live-speech-bubble, [marker-end]',
  )).toHaveCount(0)
  await expect(proofPanel.locator('.live-walker')).not.toHaveCount(0)
  await expect(proofPanel.locator('.live-thing-specimen')).not.toHaveCount(0)
  const retry = page.getByRole('button', { name: 'Retry proof room' })
  await expect(retry).toBeVisible()
  await expect(proofPanel.locator('#live-ledger')).toHaveCount(0)

  await retry.focus()
  await retry.press('Enter')
  const playActions = page.getByRole('button', { name: 'Play live actions' })
  await playActions.focus()
  await playActions.press('Enter')
  await expect(proofPanel).toHaveAttribute('data-live-proof-phase', 'movement')
  await expect(proofPanel.locator('.live-replay-portrait, .live-trail')).toHaveCount(0)
  await expect.poll(() => proofPanel.locator('.live-footstep').count()).toBeGreaterThan(0)
  await expect.poll(() => proofPanel.evaluate(node =>
    node.getAnimations({ subtree: true }).filter(animation =>
      animation.playState === 'running').length)).toBe(0)

  const playInteractions = page.getByRole('button', {
    name: 'Play live speech and thing use',
  })
  await expect(playInteractions).toBeEnabled()
  await playInteractions.focus()
  await playInteractions.press('Enter')
  await expect(proofPanel).toHaveAttribute('data-live-proof-phase', 'interactions')
  await expect(proofPanel.locator('.live-replay-portrait[data-replay-duration]')).toHaveCount(0)
  await expect(proofPanel.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  const bubble = proofPanel.locator('.live-speech-bubble[data-live-note-id="9301"]')
  await expect(bubble).toBeVisible()

  const usedThing = proofPanel.locator('[data-live-thing-id="9401"]').first()
  await usedThing.focus()
  const popover = page.locator('#live-item-popover[data-live-item-popover="true"]')
  await expect(popover.locator('[data-live-popover-field="last-action"]'))
    .toContainText('used thing #9401')

  await bubble.focus()
  await expect(bubble).toBeFocused()
  await page.keyboard.press('Enter')
  const notesPanel = page.locator('#live-notes-panel')
  await expect(notesPanel).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live\?place=9103&notes=open$/u)
  await expect(notesPanel.locator('[data-live-note-id="9301"] .live-note-body')).toHaveText(
    'spoke: sixty-four residents move together while this message appears.',
  )
  await expect(proofPanel.locator('#live-ledger')).toHaveCount(0)
})

test('drawing details reveal exact authored readback and fetch bounded history only on request', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installReplayRoutes(page, Date.now())
  const historyUrls: URL[] = []
  let historyAttempts = 0
  const undrawn = Object.freeze({
    state: 'undrawn', presentation_state: 'undrawn', description: null,
    drawing: null, rows: null, source: 'none', kind_id: null, kind_name: null,
    revision: null, variant_name: null,
  })
  const current = Object.freeze({
    state: 'complete', presentation_state: 'complete',
    description: 'An ember-glow lantern chosen by its owner.',
    drawing: exactDrawing, rows: exactDrawingRows, source: 'kind_variant',
    kind_id: 7, kind_name: 'lantern', revision: 3, variant_name: 'ember glow',
  })

  await page.route('**/api/thing/9', route => route.fulfill({ json: {
    thing: {
      id: 9, place_id: 3, name: 'field lantern', body: 'a steady mark',
      made_by: 'map-walker', current_owner: 'map-walker', moderated: false,
    },
  } }))
  await page.route('**/api/drawing/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/drawing/thing/9/history') {
      historyAttempts += 1
      historyUrls.push(url)
      if (historyAttempts === 1) {
        await route.fulfill({ status: 503, json: { error: 'drawing history unavailable' } })
        return
      }
      const before = url.searchParams.get('before')
      await route.fulfill({ json: before ? {
        type: 'thing', id: 9,
        revisions: [{
          id: 16, slot_variant_name: 'ember glow', previous: undrawn,
          current: { ...current, state: 'in_progress', presentation_state: 'in_progress',
            description: 'The first ember pixels.', },
          author: { id: 5, handle: 'map-walker', relation: 'owner' },
          created_at: '2026-08-27T12:00:00.000Z',
        }],
        page: { limit: 20, has_more: false, next_before: null },
      } : {
        type: 'thing', id: 9,
        revisions: [{
          id: 18, slot_variant_name: 'ember glow', previous: {
            ...current, state: 'in_progress', presentation_state: 'in_progress',
            description: 'The first ember pixels.',
          }, current,
          author: { id: 5, handle: 'map-walker', relation: 'owner' },
          created_at: '2026-08-28T12:00:00.000Z',
        }],
        page: { limit: 20, has_more: true, next_before: 17 },
      } })
      return
    }
    if (url.pathname === '/api/drawing/thing/9') {
      await route.fulfill({ json: { type: 'thing', id: 9, ...current } })
      return
    }
    await route.fallback()
  })

  await page.goto('/window/map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  expect(historyUrls).toEqual([])
  await page.getByRole('tab', { name: 'Live' }).click()
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  expect(historyUrls).toEqual([])

  await page.goto('/window/thing/9')
  const detail = page.locator('#record-detail')
  await expect(detail).toBeVisible()
  await expect(detail.locator('#record-detail-title')).toHaveText('field lantern')
  const drawing = detail.locator('.drawing-detail')
  await expect(drawing.locator('.drawing-state-label')).toHaveText('Complete')
  await expect(drawing.locator('.drawing-provenance')).toHaveText(
    'Kind lantern · revision 3 · variant ember glow',
  )
  await expect(drawing.locator('.drawing-owner-description')).toHaveText(
    'An ember-glow lantern chosen by its owner.',
  )
  await expect(drawing.locator('[data-drawing-palette]')).toHaveText('#174d3c #f0c95f')
  await expect(drawing.locator('[data-drawing-indices]')).toHaveText(
    JSON.stringify(exactDrawing.indices),
  )
  await expect(drawing.locator('[data-drawing-row]')).toHaveText(exactDrawingRows)
  const pixels = await drawing.locator('canvas.drawing-authored').evaluate(node => {
    const canvas = node as HTMLCanvasElement
    const context = canvas.getContext('2d')!
    const sample = (column: number) => [...context.getImageData(
      Math.floor(canvas.width * (column + 0.5) / 8),
      Math.floor(canvas.height / 16),
      1,
      1,
    ).data]
    return [sample(1), sample(2)]
  })
  expect(pixels).toEqual([[240, 201, 95, 255], [23, 77, 60, 255]])
  expect(historyUrls).toEqual([])

  const showHistory = drawing.getByRole('button', { name: 'Show drawing history' })
  await expect(showHistory).toHaveAttribute('aria-expanded', 'false')
  await showHistory.click()
  await expect(drawing.getByRole('button', { name: 'Retry drawing history' })).toBeVisible()
  expect(historyUrls).toHaveLength(1)
  expect(historyUrls[0]!.searchParams.get('limit')).toBe('20')

  await drawing.getByRole('button', { name: 'Retry drawing history' }).click()
  await expect(drawing.locator('.drawing-history-revision')).toHaveCount(1)
  await expect(drawing.locator('.drawing-history')).toContainText('The first ember pixels.')
  await expect(drawing.locator('.drawing-history')).toContainText(
    'An ember-glow lantern chosen by its owner.',
  )
  const earlier = drawing.getByRole('button', { name: 'Load earlier drawing revisions' })
  await earlier.click()
  await expect(drawing.locator('.drawing-history-revision')).toHaveCount(2)
  expect(historyUrls).toHaveLength(3)
  expect(historyUrls[2]!.searchParams.get('before')).toBe('17')
  expect(historyUrls[2]!.searchParams.get('limit')).toBe('20')
})

test('Live opens current drawings from ground sprites and the outside-resident board without eager history reads', async ({ page }) => {
  await installLiveClipboardRecorder(page)
  const fixture = await installReplayRoutes(page, Date.now())
  const placeHistoryUrls: URL[] = []
  const residentHistoryUrls: URL[] = []
  const placeCurrentPaths: string[] = []
  const residentCurrentPaths: string[] = []
  let residentDetailShouldFailOnce = false
  await page.setViewportSize({ width: 390, height: 844 })
  const exactDrawing = {
    palette: ['#174d3c', '#f0c95f'],
    indices: Array.from({ length: 64 }, (_, index) => index % 2),
  }
  const exactDrawingRows = Array.from({ length: 8 }, (_, row) =>
    exactDrawing.indices.slice(row * 8, (row + 1) * 8).join(' '),
  )
  await page.route('**/api/drawing/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/drawing/place/1') {
      placeCurrentPaths.push(url.pathname)
      await route.fulfill({ json: {
        type: 'place',
        id: 1,
        state: 'complete',
        presentation_state: 'complete',
        description: 'Owner-authored world drawing.',
        drawing: exactDrawing,
        rows: exactDrawingRows,
        source: 'place',
        kind_id: null,
        kind_name: null,
        revision: null,
        variant_name: null,
      } })
      return
    }
    if (url.pathname === '/api/drawing/place/1/history') {
      placeHistoryUrls.push(url)
      await route.fulfill({ json: {
        type: 'place',
        id: 1,
        revisions: [],
        page: { limit: 20, has_more: false, next_before: null },
      } })
      return
    }
    if (url.pathname === '/api/drawing/place/2') {
      placeCurrentPaths.push(url.pathname)
      await route.fulfill({ json: {
        type: 'place',
        id: 2,
        state: 'complete',
        presentation_state: 'complete',
        description: 'Owner-authored place drawing.',
        drawing: exactDrawing,
        rows: exactDrawingRows,
        source: 'place',
        kind_id: null,
        kind_name: null,
        revision: null,
        variant_name: null,
      } })
      return
    }
    if (url.pathname === '/api/drawing/place/2/history') {
      placeHistoryUrls.push(url)
      await route.fulfill({ json: {
        type: 'place',
        id: 2,
        revisions: [{
          id: 18,
          slot_variant_name: null,
          previous: {
            type: 'place',
            id: 2,
            state: 'in_progress',
            presentation_state: 'in_progress',
            description: 'The first place pixels.',
            drawing: exactDrawing,
            rows: exactDrawingRows,
            source: 'place',
            kind_id: null,
            kind_name: null,
            revision: null,
            variant_name: null,
          },
          current: {
            type: 'place',
            id: 2,
            state: 'complete',
            presentation_state: 'complete',
            description: 'Owner-authored place drawing.',
            drawing: exactDrawing,
            rows: exactDrawingRows,
            source: 'place',
            kind_id: null,
            kind_name: null,
            revision: null,
            variant_name: null,
          },
          author: { id: 5, handle: 'map-walker', relation: 'owner' },
          created_at: '2026-08-28T12:00:00.000Z',
        }],
        page: { limit: 20, has_more: false, next_before: null },
      } })
      return
    }
    if (url.pathname === '/api/drawing/resident/5') {
      residentCurrentPaths.push(url.pathname)
      if (residentDetailShouldFailOnce) {
        residentDetailShouldFailOnce = false
        await route.fulfill({ status: 503, json: { error: 'resident drawing unavailable' } })
        return
      }
      await route.fulfill({ json: {
        type: 'resident',
        id: 5,
        state: 'complete',
        presentation_state: 'complete',
        description: 'Owner-authored resident drawing.',
        drawing: exactDrawing,
        rows: exactDrawingRows,
        source: 'resident',
        kind_id: null,
        kind_name: null,
        revision: null,
        variant_name: null,
      } })
      return
    }
    if (url.pathname === '/api/drawing/resident/5/history') {
      residentHistoryUrls.push(url)
      await route.fulfill({ json: {
        type: 'resident',
        id: 5,
        revisions: [],
        page: { limit: 20, has_more: false, next_before: null },
      } })
      return
    }
    await route.fallback()
  })

  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-plate-title')).toHaveText('the world')
  expect(placeHistoryUrls).toEqual([])
  expect(residentHistoryUrls).toEqual([])
  const rootPlaceReadsBeforeOpen = placeCurrentPaths.filter(path => path === '/api/drawing/place/1').length
  const placeReadsBeforeOpen = placeCurrentPaths.filter(path => path === '/api/drawing/place/2').length
  const residentReadsBeforeOpen = residentCurrentPaths.length
  const rootCaptionDrawing = page.locator('.live-root-place-sprite')
  await expect(rootCaptionDrawing).toBeVisible()
  await panLiveTargetIntoView(page, rootCaptionDrawing)
  await expect(rootCaptionDrawing).toBeInViewport()
  expect((await rootCaptionDrawing.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await rootCaptionDrawing.click()
  const detail = page.locator('#record-detail')
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live$/u)
  await expect(detail.locator('#record-detail-kind')).toHaveText('Public place · live current drawing')
  await expect(detail.locator('#record-detail-title')).toHaveText('the world')
  await expect(detail.locator('.record-detail-meta')).toContainText('the world · nobody owns it · transit only')
  const rootDrawing = detail.locator('.drawing-detail')
  await expect(rootDrawing.locator('.drawing-state-label')).toHaveText('Complete')
  await expect(rootDrawing.locator('.drawing-owner-description')).toHaveText(
    'Owner-authored world drawing.',
  )
  expect(placeCurrentPaths.filter(path => path === '/api/drawing/place/1').length)
    .toBeGreaterThanOrEqual(rootPlaceReadsBeforeOpen)
  expect(placeHistoryUrls).toEqual([])
  await rootDrawing.getByRole('button', { name: 'Show drawing history' }).click()
  await expect(rootDrawing.locator('.drawing-history')).toContainText(
    'No drawing changes have been recorded yet.',
  )
  expect(placeHistoryUrls).toHaveLength(1)
  expect(placeHistoryUrls[0]!.pathname).toBe('/api/drawing/place/1/history')
  await page.locator('#record-detail-close').click()
  await expect(detail).toBeHidden()

  const mapWalker = page.locator('#live-roster [data-live-resident-handle="map-walker"]').first()
  await mapWalker.click()
  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')

  const cinderPlotSprite = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  await panLiveTargetIntoView(page, cinderPlotSprite)
  await expect(cinderPlotSprite).toBeVisible()
  await expect(cinderPlotSprite).toBeInViewport()
  expect((await cinderPlotSprite.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await cinderPlotSprite.click()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(page.locator('.live-plate-title')).toHaveText('Cinder lane')
  const cinderRootSprite = page.locator('.live-root-place-sprite')
  await expect(cinderRootSprite).toBeVisible()
  await panLiveTargetIntoView(page, cinderRootSprite)
  await cinderRootSprite.click()
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(detail.locator('#record-detail-kind')).toHaveText('Public place · live current drawing')
  await expect(detail.locator('#record-detail-title')).toHaveText('Cinder lane')
  await expect(detail.locator('.record-detail-meta')).toContainText('kept by cinder-owner')
  const placeDrawing = detail.locator('.drawing-detail')
  await expect(placeDrawing.locator('.drawing-state-label')).toHaveText('Complete')
  await expect(placeDrawing.locator('.drawing-provenance')).toHaveText('Own drawing')
  await expect(placeDrawing.locator('.drawing-owner-description')).toHaveText(
    'Owner-authored place drawing.',
  )
  await expect(placeDrawing.locator('canvas[role=\"img\"]')).toHaveAttribute(
    'aria-describedby',
    'drawing-description-place-2-current',
  )
  await expect(placeDrawing.locator('#drawing-description-place-2-current')).toHaveText(
    'Owner-authored place drawing.',
  )
  await expect(placeDrawing.locator('[data-drawing-palette]')).toHaveText('#174d3c #f0c95f')
  await expect(placeDrawing.locator('[data-drawing-row]')).toHaveText(exactDrawingRows)
  const placeShare = detail.locator('[data-share-scope="detail"]')
  await expect(placeShare).toBeVisible()
  await expect(placeShare).toHaveText('Share this place')
  await placeShare.click()
  const placeShareLink = new URL('/window/place/2', page.url()).href
  await expect.poll(() => copiedLiveShareLinks(page)).toEqual([placeShareLink])
  await expect(detail.locator('#record-detail-share-status')).toHaveText(
    'Link copied: ' + placeShareLink,
  )
  expect(placeCurrentPaths.length).toBeGreaterThanOrEqual(placeReadsBeforeOpen)
  expect(placeHistoryUrls).toHaveLength(1)
  await placeDrawing.getByRole('button', { name: 'Show drawing history' }).click()
  await expect(placeDrawing.locator('.drawing-history-revision')).toHaveCount(1)
  expect(placeHistoryUrls).toHaveLength(2)
  expect(placeHistoryUrls[1]!.pathname).toBe('/api/drawing/place/2/history')
  expect(placeHistoryUrls[1]!.searchParams.get('limit')).toBe('20')
  await page.locator('#record-detail-close').click()
  await expect(detail).toBeHidden()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(page.locator('.live-plate-title')).toHaveText('Cinder lane')
  const leafCaptionDrawing = page.locator('.live-root-place-sprite')
  await expect(leafCaptionDrawing).toBeVisible()
  await panLiveTargetIntoView(page, leafCaptionDrawing)
  await expect(leafCaptionDrawing).toBeInViewport()
  expect((await leafCaptionDrawing.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  const outsideFocus = page.locator(
    '#live-focus-interactions [data-live-focus-resident="map-walker"]' +
    '[data-live-resident-scope="outside"]',
  )
  await expect(outsideFocus).toContainText('Outside this plate · Lantern nook')

  const placeCaptionReadsBeforeOpen = placeCurrentPaths.filter(path => path === '/api/drawing/place/2').length
  const placeHistoryBeforeLeafCaptionOpen = placeHistoryUrls.length
  await leafCaptionDrawing.click()
  await expect(detail).toBeVisible()
  await expect(detail.locator('#record-detail-title')).toHaveText('Cinder lane')
  expect(placeCurrentPaths.filter(path => path === '/api/drawing/place/2').length)
    .toBeGreaterThanOrEqual(placeCaptionReadsBeforeOpen)
  expect(placeHistoryUrls).toHaveLength(placeHistoryBeforeLeafCaptionOpen)
  await page.locator('#record-detail-close').click()
  await expect(detail).toBeHidden()

  residentDetailShouldFailOnce = true
  const residentReadsBeforeDetailOpen = residentCurrentPaths.length
  await outsideFocus.getByRole('button', { name: 'Open current drawing for map-walker' }).click()
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(detail.locator('#record-detail-kind')).toHaveText('Public resident · live current drawing')
  await expect(detail.locator('#record-detail-title')).toHaveText('map-walker')
  await expect(detail.locator('[data-share-scope="detail"]')).toBeHidden()
  await expect(detail.locator('.record-detail-meta')).toContainText('resident #5')
  await expect(detail.locator('.error-row')).toContainText('The current drawing could not be read.')
  expect(residentCurrentPaths).toHaveLength(residentReadsBeforeDetailOpen + 1)
  expect(residentHistoryUrls).toEqual([])
  await detail.getByRole('button', { name: 'Retry current drawing' }).click()
  const residentDrawing = detail.locator('.drawing-detail')
  await expect(residentDrawing.locator('.drawing-state-label')).toHaveText('Complete')
  await expect(residentDrawing.locator('.drawing-provenance')).toHaveText('Own drawing')
  await expect(residentDrawing.locator('.drawing-owner-description')).toHaveText(
    'Owner-authored resident drawing.',
  )
  await expect(residentDrawing.locator('canvas[role=\"img\"]')).toHaveAttribute(
    'aria-describedby',
    'drawing-description-resident-5-current',
  )
  await expect(residentDrawing.locator('#drawing-description-resident-5-current')).toHaveText(
    'Owner-authored resident drawing.',
  )
  await expect(residentDrawing.locator('[data-drawing-indices]')).toHaveText(
    JSON.stringify(exactDrawing.indices),
  )
  expect(residentCurrentPaths).toHaveLength(residentReadsBeforeDetailOpen + 2)
  expect(residentHistoryUrls).toEqual([])
  await residentDrawing.getByRole('button', { name: 'Show drawing history' }).click()
  await expect(residentDrawing.locator('.drawing-history')).toContainText(
    'No drawing changes have been recorded yet.',
  )
  expect(residentHistoryUrls).toHaveLength(1)
  expect(residentHistoryUrls[0]!.searchParams.get('limit')).toBe('20')

  await page.locator('#record-detail-close').click()
  await expect(detail).toBeHidden()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)

  const recipientNavigation = await page.goto(placeShareLink)
  expect(recipientNavigation?.status()).toBe(200)
  await expect(page).toHaveURL(placeShareLink)
  await expect(page.locator('#record-detail')).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Place', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('#place-panel')).toBeVisible()
  await expect(page.locator('#place-panel')).toContainText('Cinder lane')
})

test('parent moderation leaves current drawing and its history unavailable in details', async ({ page }) => {
  await installReplayRoutes(page, Date.now())
  const historyUrls: string[] = []
  await page.route('**/api/thing/9', route => route.fulfill({ json: {
    thing: {
      id: 9, place_id: 3, name: 'field lantern', body: 'a steady mark',
      made_by: 'map-walker', current_owner: 'map-walker', moderated: true,
    },
  } }))
  await page.route('**/api/drawing/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/drawing/thing/9/history') historyUrls.push(url.href)
    if (url.pathname === '/api/drawing/thing/9' ||
        url.pathname === '/api/drawing/thing/9/history') {
      await route.fulfill({ status: 404, json: { error: 'drawing record not found' } })
      return
    }
    await route.fallback()
  })

  await page.goto('/window/thing/9')
  const detail = page.locator('#record-detail')
  await expect(detail.locator('#record-detail-title')).toHaveText('field lantern')
  await expect(detail.locator('.drawing-unavailable')).toContainText('Drawing unavailable')
  await expect(detail.getByRole('button', { name: 'Show drawing history' })).toHaveCount(0)
  expect(historyUrls).toEqual([])
})

test('preview proof failure stays with the Retry room instead of covering the crowd', async ({ page }) => {
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await page.getByRole('button', { name: 'Run preview proof scene' }).click()

  await page.locator('#place-filter').selectOption('9103')
  await expect(page.locator('.live-plate-title')).toHaveText('Crowded activity workshop')
  await expect(page.locator('.live-proof-load')).toHaveCount(0)

  await page.locator('#place-filter').selectOption('9104')
  await expect(page.locator('.live-plate-title')).toHaveText('Retry room')
  const retry = page.getByRole('button', { name: 'Retry proof room' })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect(page.locator('.live-proof-load-ready')).toContainText('loaded on Retry')
})

test('a failed covering snapshot keeps queued movement settled and gated through another render', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await page.addInitScript(() => {
    Object.defineProperty(window, '__liveReplayGateStates', {
      configurable: true,
      value: [],
    })
    Object.defineProperty(window, '__liveReplayAfterStarts', {
      configurable: true,
      value: [],
    })
  })
  await page.route('**/window.js', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const signature = '  function startLiveReplays() {'
    expect(source.split(signature)).toHaveLength(2)
    let body = source.replace(signature, signature + '\n' +
      '    window.__liveReplayGateStates.push(Object.freeze({\n' +
      '      changeMarker: state.changeMarker, streamMarker: state.live.streamMarker,\n' +
      '      queued: Object.values(state.live.replayQueues).reduce((n, q) => n + q.length, 0),\n' +
      '    }))')
    const afterStart = '    scheduleLiveReplayCompletions(starts)'
    expect(body.split(afterStart)).toHaveLength(2)
    body = body.replace(afterStart,
      '    window.__liveReplayAfterStarts.push(Object.freeze({\n' +
      '      starts: starts.map(start => ({ ...start })),\n' +
      '      active: Object.fromEntries(Object.entries(active).map(([actor, held]) =>\n' +
      '        [actor, { key: held.key, type: held.type }])),\n' +
      '      queued: Object.values(queues).reduce((n, q) => n + q.length, 0),\n' +
      '    }))\n' + afterStart)
    await route.fulfill({ response, body })
  })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    movementOnly: true,
    coveringSnapshotFailures: 1,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect.poll(fixture.changeRequests).toBeGreaterThan(0)
  const readsBeforePublish = fixture.changeRequests()
  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(fixture.changeRequests).toBeGreaterThan(readsBeforePublish)
  await expect.poll(fixture.coveringSnapshotFailures).toBe(1)
  const retry = page.getByRole('button', { name: 'Retry reading the public city view' })
  await expect(retry).toBeVisible()
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)

  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.clock.runFor(32)
  const gateStates = await page.evaluate(() => [
    ...((window as Window & { __liveReplayGateStates?: Array<{
      changeMarker: string | null
      streamMarker: string | null
      queued: number
    }> }).__liveReplayGateStates ?? []),
  ])
  expect(gateStates.at(-1)).toMatchObject({ changeMarker: '10', streamMarker: '10', queued: 1 })
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator(
    '.live-plot[data-place-id="2"] [data-live-resident-handle="map-walker"]',
  ).first()).toBeVisible()

  const readsBeforeRetry = fixture.changeRequests()
  const snapshotResponsesBeforeRetry = fixture.snapshotResponses()
  const coveringResponsesBeforeRetry = fixture.coveringSnapshotResponses()
  await retry.click()
  await expect.poll(fixture.changeRequests).toBeGreaterThan(readsBeforeRetry)
  await expect.poll(() => fixture.changeCursors().at(-1)).toBe('10')
  await expect.poll(fixture.snapshotResponses).toBeGreaterThan(snapshotResponsesBeforeRetry)
  await expect.poll(fixture.coveringSnapshotResponses).toBeGreaterThan(
    coveringResponsesBeforeRetry,
  )
  await settleLiveFakeClockAfterPublish(page)
  const retryGateStates = await page.evaluate(() => [
    ...((window as Window & { __liveReplayGateStates?: Array<{
      changeMarker: string | null
      streamMarker: string | null
      queued: number
    }> }).__liveReplayGateStates ?? []),
  ])
  expect(retryGateStates.at(-1), JSON.stringify(retryGateStates, null, 2)).toMatchObject({
    changeMarker: '16', streamMarker: '16', queued: 1,
  })
  const afterStarts = await page.evaluate(() => [
    ...((window as Window & { __liveReplayAfterStarts?: unknown[] })
      .__liveReplayAfterStarts ?? []),
  ])
  expect(afterStarts.at(-1), JSON.stringify(afterStarts, null, 2)).toMatchObject({
    starts: [{ actor: 'map-walker', key: 'change:11' }],
    active: { 'map-walker': { key: 'change:11', type: 'move' } },
    queued: 0,
  })
})

test('new observed records animate once in order and settle to positions plus fading evidence', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator(
    '.live-replay-portrait, .live-trail, .live-footstep, .live-speech-bubble',
  )).toHaveCount(0)

  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  const replay = page.locator('.live-replay-portrait')
  await expect(replay).toHaveCount(1)
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:11')
  await expect(replay).toHaveAttribute('data-live-movement', 'detail')
  const duration = Number(await replay.getAttribute('data-replay-duration'))
  expect(duration).toBeGreaterThanOrEqual(3_200)
  expect(duration).toBeLessThanOrEqual(8_000)
  const trail = page.locator('.live-trail')
  await expect(trail).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)

  const routePoints = await replay.evaluate(node => {
    const values = (node as HTMLElement).style.offsetPath.match(/-?\d+(?:\.\d+)?/gu)
      ?.map(Number) ?? []
    return Array.from({ length: Math.floor(values.length / 2) }, (_, index) => ({
      x: values[index * 2]!,
      y: values[index * 2 + 1]!,
    }))
  })
  expect(routePoints.length).toBeGreaterThanOrEqual(3)
  expect(Number(await replay.getAttribute('data-live-route-point-count')))
    .toBeGreaterThanOrEqual(routePoints.length)
  const routeEnd = routePoints.at(-1)!
  const finalPoint = {
    x: Number(await replay.getAttribute('data-live-final-x')),
    y: Number(await replay.getAttribute('data-live-final-y')),
  }
  expect(Number.isFinite(finalPoint.x) && Number.isFinite(finalPoint.y)).toBe(true)
  const replayPosition = () => replay.evaluate(node => {
    const stage = node.closest('.live-stage') as HTMLElement
    const ground = stage.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    const scale = ground.width / Number(stage.dataset.liveStageWidth)
    return {
      x: (box.left + box.width / 2 - ground.left) / scale,
      y: (box.bottom - ground.top) / scale,
    }
  })
  const routeStart = routePoints[0]!
  const routeLength = routePoints.slice(1).reduce((total, point, index) =>
    total + Math.hypot(
      point.x - routePoints[index]!.x,
      point.y - routePoints[index]!.y,
    ), 0)
  const start = await replayPosition()
  expect(Math.hypot(start.x - routeStart.x, start.y - routeStart.y))
    .toBeLessThan(routeLength * 0.2)

  // Browser-local Focus promotes movement detail, but only Follow overrides the zoom label rule.
  await replay.locator('.live-portrait').evaluate(node => (node as HTMLButtonElement).click())
  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
  await expect(trail).toHaveCount(0)
  await expect(replay).toHaveAttribute('data-live-movement', 'detail')
  const replayStack = await page.locator('.live-trace-layer').evaluate(layer => ({
    replay: Number(getComputedStyle(layer).zIndex),
    focusedPlot: Number(getComputedStyle(
      document.querySelector('.live-plot[data-live-focus-plot="true"]')!).zIndex),
    neighborPlot: Number(getComputedStyle(
      document.querySelector('.live-plot[data-live-focus-plot="false"]')!).zIndex),
  }))
  expect(replayStack.replay).toBeGreaterThan(replayStack.focusedPlot)
  expect(replayStack.focusedPlot).toBeGreaterThan(replayStack.neighborPlot)
  await page.clock.runFor(Math.ceil(duration / 2))
  const midpoint = await replayPosition()
  expect(Math.hypot(midpoint.x - start.x, midpoint.y - start.y))
    .toBeGreaterThan(5)
  expect(Math.hypot(midpoint.x - routeEnd.x, midpoint.y - routeEnd.y))
    .toBeGreaterThan(5)
  expect(midpoint.y).toBeGreaterThan(0)
  await replay.locator('.live-portrait').evaluate(node => (node as HTMLButtonElement).click())
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
  await panLiveStagePointIntoView(page, finalPoint)

  await page.clock.fastForward(Math.floor(duration / 2) + 50)
  const absorbedResidents = page.locator('[data-place-id="3"] .live-resident-more')
  await expect(absorbedResidents).toHaveText('+4 more')
  await expect(absorbedResidents).toHaveAttribute('data-live-overflow-count', '4')
  await expect(absorbedResidents).toHaveCSS('opacity', '1')
  const thingOverflow = page.locator('[data-place-id="3"] .live-thing-more')
  await expect(thingOverflow).toHaveText('+3 more')
  await expect(thingOverflow).toHaveAttribute('data-live-overflow-count', '3')
  await expect(page.locator('.live-footstep')).toHaveCount(3)
  const bubble = page.locator('.live-speech-bubble')
  const firstBubbleDelay = await advanceLiveFakeClockUntil(
    page,
    async () => await bubble.count() === 1 && await bubble.textContent() === 'Earlier line',
    4_064,
  )
  await expect(bubble).toHaveText('Earlier line')
  expect(firstBubbleDelay).toBeLessThanOrEqual(4_064)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)

  const latestLine = 'L'.repeat(59) + '…'
  const latestBubbleDelay = await advanceLiveFakeClockUntil(
    page,
    async () => await bubble.count() === 1 && await bubble.textContent() === latestLine,
    4_064,
  )
  await expect(bubble).toHaveText(latestLine)
  expect(latestBubbleDelay).toBeLessThanOrEqual(4_064)
  await expect(bubble).toHaveCount(1)
  await expect(page.locator('#live-ledger, .live-footnote-mark, .live-action-mark'))
    .toHaveCount(0)

  await page.clock.fastForward(651)
  const pulsedThing = page.locator('.live-thing-specimen.live-pulse')
  await expect(pulsedThing).toHaveCount(0)
  const stableLantern = page.locator('[data-place-id="3"] [data-live-thing-id="9"]')
  await expect(stableLantern).toHaveCount(1)
  await expect(stableLantern).not.toHaveClass(/live-pulse/u)

  const settlementDelay = await advanceLiveFakeClockUntil(
    page,
    async () => await replay.count() === 0,
    4_064,
  )
  await expect(replay).toHaveCount(0)
  expect(settlementDelay).toBeLessThanOrEqual(4_064)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  const settledWalker = page.locator(
    '[data-place-id="3"] [data-live-resident-handle="map-walker"]',
  ).first()
  const settledPoint = await settledWalker.evaluate(node => {
    const shell = node.closest('.live-walker') as HTMLElement
    const stage = node.closest('.live-stage') as HTMLElement
    const ground = stage.getBoundingClientRect()
    const box = shell.getBoundingClientRect()
    const scale = ground.width / Number(stage.dataset.liveStageWidth)
    return {
      x: (box.left + box.width / 2 - ground.left) / scale,
      y: (box.bottom - ground.top) / scale,
    }
  })
  const settlementEvidence = JSON.stringify({ settledPoint, finalPoint })
  expect(Math.abs(settledPoint.x - finalPoint.x), settlementEvidence).toBeLessThan(1)
  expect(Math.abs(settledPoint.y - finalPoint.y), settlementEvidence).toBeLessThan(1)
  const platePortrait = page.locator('#live-plates [data-live-resident-handle="map-walker"]')
  await expect(platePortrait).toHaveAccessibleName(/map-walker/u)
  await expect(platePortrait).not.toHaveAccessibleName(/Earlier|L{10}/u)

  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.clock.fastForward(100)
  await expect(replay).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await page.clock.fastForward(600_001)
  await expect(page.locator('.live-footstep')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
  await expect(trail).toHaveCount(0)
})

test('linked-note focus does not return after the watcher chooses another notes control', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)

  const replay = page.locator('.live-replay-portrait')
  await expect(replay).toHaveCount(1)
  const duration = Number(await replay.getAttribute('data-replay-duration'))
  const finalPoint = {
    x: Number(await replay.getAttribute('data-live-final-x')),
    y: Number(await replay.getAttribute('data-live-final-y')),
  }
  await replay.locator('.live-portrait').evaluate(node => (node as HTMLButtonElement).click())
  await page.clock.runFor(Math.ceil(duration / 2))
  await replay.locator('.live-portrait').evaluate(node => (node as HTMLButtonElement).click())
  await panLiveStagePointIntoView(page, finalPoint)
  await page.clock.fastForward(Math.floor(duration / 2) + 50)

  const bubble = page.locator('.live-speech-bubble')
  const latestLine = 'L'.repeat(59) + '…'
  await advanceLiveFakeClockUntil(
    page,
    async () => await bubble.count() === 1 && await bubble.textContent() === latestLine,
    10_000,
  )
  await expect(bubble).toHaveAttribute('data-live-note-id', '78')
  let releaseRoomNotes = () => {}
  const heldRoomNotes = new Promise<void>(resolve => {
    releaseRoomNotes = resolve
  })
  await page.route('**/api/place/3**', async route => {
    await heldRoomNotes
    await route.fallback()
  })
  await bubble.evaluate(node => (node as HTMLButtonElement).click())

  const notesPanel = page.locator('#live-notes-panel')
  const linkedNote = notesPanel.locator('[data-live-note-id="78"]')
  const closeNotes = notesPanel.getByRole('button', { name: 'Close notes' })
  await expect(linkedNote).toBeFocused()
  await closeNotes.focus()
  await expect(closeNotes).toBeFocused()
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.clock.runFor(32)
  await expect(closeNotes).toBeFocused()
  releaseRoomNotes()
})

test('two arrivals always glide and settle on their own detailed route endpoints', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    secondArrival: true,
    movementOnly: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('#live-plates .live-walker')).toHaveCount(8)
  const pagingBeforePublish = {
    residents: fixture.residentPageRequests(),
    things: fixture.thingPageRequests(),
    snapshots: fixture.snapshotResponses(),
  }

  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  const replays = page.locator('.live-replay-portrait[data-replay-duration]')
  await expect(replays).toHaveCount(2)
  const durations = await replays.evaluateAll(nodes => nodes.map(node =>
    Number((node as HTMLElement).dataset.replayDuration)))
  expect(durations.every(duration => duration >= 3_200 && duration <= 8_000)).toBe(true)
  expect(await replays.evaluateAll(nodes => nodes.every(node =>
    (node as HTMLElement).dataset.liveMovement === 'detail'))).toBe(true)
  const destinations = await replays.evaluateAll(nodes => Object.fromEntries(nodes.map(node => {
    const shell = node as HTMLElement
    const actor = node.querySelector<HTMLElement>('[data-live-resident-handle]')
      ?.dataset.liveResidentHandle ?? ''
    return [actor, {
      x: Number(shell.dataset.liveFinalX),
      y: Number(shell.dataset.liveFinalY),
    }]
  })))
  const pagingAtRoute = {
    residents: fixture.residentPageRequests(),
    things: fixture.thingPageRequests(),
    snapshots: fixture.snapshotResponses(),
  }
  expect(Object.keys(destinations).sort()).toEqual(['harbor-1', 'map-walker'])
  await expect(page.locator('.live-trail')).toHaveCount(0)
  await page.clock.runFor(Math.max(...durations) + 20)
  await expect(replays).toHaveCount(0)
  expect(await page.locator('.live-footstep').count()).toBeLessThanOrEqual(6)
  const pagingAtSettlement = {
    residents: fixture.residentPageRequests(),
    things: fixture.thingPageRequests(),
    snapshots: fixture.snapshotResponses(),
  }
  for (const handle of ['map-walker', replayCrowd[0]!.handle]) {
    const walker = page.locator(
      '.live-replay-portrait:not([data-replay-duration])',
    ).filter({
      has: page.locator(`[data-live-resident-handle="${handle}"]`),
    })
    await expect(walker).toHaveCount(1)
    const endpointEvidence = await walker.evaluate(node => {
      const shell = node as HTMLElement
      const stage = node.closest('.live-stage') as HTMLElement
      const ground = stage.getBoundingClientRect()
      const box = shell.getBoundingClientRect()
      const scale = ground.width / Number(stage.dataset.liveStageWidth)
      return {
        point: {
          x: (box.left + box.width / 2 - ground.left) / scale,
          y: (box.bottom - ground.top) / scale,
        },
        left: shell.style.left,
        top: shell.style.top,
        transform: getComputedStyle(shell).transform,
        offsetPath: shell.style.offsetPath,
      }
    })
    const routeEnd = destinations[handle]!
    const evidence = JSON.stringify({
      handle,
      routeEnd,
      endpointEvidence,
      pagingBeforePublish,
      pagingAtRoute,
      pagingAtSettlement,
    })
    expect(Math.abs(endpointEvidence.point.x - Number(routeEnd.x)), evidence).toBeLessThan(1)
    expect(Math.abs(endpointEvidence.point.y - Number(routeEnd.y)), evidence).toBeLessThan(1)
  }
  await page.clock.runFor(2_001)
  await expect(page.locator('.live-footstep, .live-replay-portrait')).toHaveCount(0)
})

test('a move between nested places sharing one plotted ground still takes its doorway route', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    movementOnly: true,
    publishedMove: { fromPlaceId: 3, toPlaceId: 4 },
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await panLiveTargetIntoView(page, page.locator(
    '[data-place-id="3"] [data-live-resident-handle="map-walker"]',
  ))
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)

  const replay = page.locator(
    '.live-replay-portrait[data-live-replay-key="change:11"]',
  )
  await expect(replay).toHaveCount(1)
  await expect(replay).toHaveAttribute('data-live-movement', 'detail')
  expect(Number(await replay.getAttribute('data-live-route-point-count'))).toBeGreaterThanOrEqual(3)
  await expect(replay).toHaveAttribute('data-from-place-id', '3')
  await expect(replay).toHaveAttribute('data-to-place-id', '4')
})

test('Follow animates an arrival from outside the new plate through its boundary doorway', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    movementOnly: true,
  })
  await page.goto('/window/live?resident=map-walker')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)

  await expect(page.locator('.live-plate-title')).toHaveText('Lantern nook')
  const replay = page.locator(
    '.live-replay-portrait[data-live-replay-key="change:11"]',
  )
  await expect(replay).toHaveCount(1)
  await expect(replay).toHaveAttribute('data-live-movement', 'detail')
  expect(Number(await replay.getAttribute('data-live-route-point-count'))).toBeGreaterThanOrEqual(3)
  await expect(replay).toHaveAttribute('data-from-place-id', '2')
  await expect(replay).toHaveAttribute('data-to-place-id', '4')
  const trail = page.locator('.live-trail[data-live-actor="map-walker"]')
  await expect(trail).toHaveCount(1)
  await expect(trail).toHaveAccessibleName('map-walker moved from 2 to 4')
  await expect(trail).toHaveAttribute('marker-end', 'url(#live-trace-arrow)')
  await trail.focus()
  await expect(trail).toHaveAttribute('data-highlighted', 'true')
  await trail.press('Enter')
  await expect(trail).toHaveAttribute('data-highlighted', 'false')
  await trail.press('Space')
  await expect(trail).toHaveAttribute('data-highlighted', 'true')
})

test('a route crossing the camera owns no sprite animation before it enters', async ({ page }) => {
  const now = Date.now()
  await page.setViewportSize({ width: 500, height: 400 })
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    movementOnly: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await panLiveTargetIntoView(page, page.locator('[data-place-id="3"] .live-plot-open'))
  const sourceGround = page.locator('.live-plot[data-place-id="2"]')
  const viewport = page.locator('#live-viewport')
  const sourceHasReplayClearance = () => sourceGround.evaluate(node => {
    const source = node.getBoundingClientRect()
    const camera = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return source.right <= camera.left - 32
  })
  await viewport.focus()
  for (let attempt = 0; attempt < 24 && !await sourceHasReplayClearance(); attempt += 1) {
    await viewport.press('ArrowRight')
    await page.clock.runFor(32)
  }
  await expect.poll(sourceHasReplayClearance).toBe(true)
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)

  const replay = page.locator(
    '.live-replay-portrait[data-live-replay-key="change:11"]',
  )
  await expect(replay).toHaveCount(0)
  const elapsed = await advanceLiveFakeClockUntil(
    page,
    async () => await replay.count() === 1,
    8_000,
  )
  await expect(replay).toHaveCount(1)
  const duration = Number(await replay.getAttribute('data-replay-duration'))
  expect(elapsed).toBeGreaterThan(32)
  expect(elapsed).toBeLessThan(duration)
  await expect(replay).toHaveAttribute('data-live-movement', 'detail')
})

test('completed movement residue is removed and idle when its ground leaves the camera', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: 7,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await panLiveTargetIntoView(page, page.locator(
    '.live-plot[data-place-id="3"] .live-plot-open',
  ))
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)

  const replays = page.locator('.live-replay-portrait[data-replay-duration]')
  const replayStartElapsed = await advanceLiveFakeClockUntil(
    page,
    async () => await replays.count() === 7,
    8_000,
  )
  expect(replayStartElapsed).toBeLessThan(8_000)
  await expect(replays).toHaveCount(7)
  await page.clock.runFor(650)
  await expect.poll(() => page.locator('.live-footstep').count()).toBeGreaterThan(0)
  const longestDuration = Math.max(...await replays.evaluateAll(nodes => nodes.map(node =>
    Number((node as HTMLElement).dataset.replayDuration))))
  await advanceLiveFakeClockUntil(
    page,
    async () => await replays.count() === 0,
    longestDuration + 500,
    100,
  )
  await expect(replays).toHaveCount(0)

  const harborPlot = page.locator('.live-plot[data-place-id="3"]')
  await page.getByRole('button', { name: 'Center live view' }).click()
  await expect(harborPlot.locator('.live-plot-open')).toBeVisible()
  await harborPlot.evaluate(node => { (node as HTMLElement).dataset.liveFocusPlot = 'true' })
  const absorption = harborPlot.locator('.live-resident-more')
  await expect(absorption).toBeVisible()
  const absorptionViewport = page.locator('#live-viewport')
  const absorptionGeometry = () => absorption.evaluate(node => {
    const target = node.getBoundingClientRect()
    const camera = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return {
      intersects: target.right > camera.left && target.left < camera.right &&
        target.bottom > camera.top && target.top < camera.bottom,
      horizontal: target.left + target.width / 2 - (camera.left + camera.width / 2),
      vertical: target.top + target.height / 2 - (camera.top + camera.height / 2),
    }
  })
  await absorptionViewport.focus()
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const geometry = await absorptionGeometry()
    if (geometry.intersects) break
    if (Math.abs(geometry.horizontal) > 20) {
      await absorptionViewport.press(geometry.horizontal > 0 ? 'ArrowRight' : 'ArrowLeft')
    }
    if (Math.abs(geometry.vertical) > 20) {
      await absorptionViewport.press(geometry.vertical > 0 ? 'ArrowDown' : 'ArrowUp')
    }
    await page.clock.runFor(32)
  }
  await expect.poll(async () => (await absorptionGeometry()).intersects).toBe(true)
  await absorption.evaluate(node => {
    node.classList.remove('live-overflow-absorbing')
    void (node as HTMLElement).offsetWidth
    node.classList.add('live-overflow-absorbing')
  })
  await page.clock.runFor(32)
  await expect.poll(() => absorption.evaluate(node =>
    node.getAnimations().filter(animation => animation.playState === 'running').length,
  )).toBeGreaterThan(0)

  const viewport = page.locator('#live-viewport')
  await viewport.evaluate(node => {
    for (let index = 0; index < 80; index += 1) {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    }
  })
  await page.clock.runFor(300)
  await expect(page.locator('.live-footstep, .live-trail, .live-speech-bubble')).toHaveCount(0)
  await expect(absorption).toHaveAttribute('data-live-offscreen', 'true')
  expect(await absorption.evaluate(node =>
    node.getAnimations().filter(animation => animation.playState === 'running').length,
  )).toBe(0)
  expect(await page.locator('#live-panel').evaluate(panel =>
    panel.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
  )).toBe(0)
})

test('a move accepted near the history edge still glides after an earlier queued move', async ({ page }) => {
  const now = Date.now()
  await installLiveRenderWorkRecorder(page)
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    movementOnly: true,
    nearExpiryQueuedMove: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)

  const replay = page.locator('.live-replay-portrait[data-replay-duration]')
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:11')
  const firstDuration = Number(await replay.getAttribute('data-replay-duration'))
  await page.clock.runFor(firstDuration + 2_000)
  const secondMove = await page.evaluate(() => (
    window as Window & { __liveReplayStarts?: Array<Record<string, unknown>> }
  ).__liveReplayStarts?.find(start => start.key === 'change:12'))
  expect(secondMove).toMatchObject({
    actor: 'map-walker',
    fromPlaceId: '3',
    toPlaceId: '4',
  })
  expect(Number(secondMove?.duration)).toBeGreaterThanOrEqual(3_200)
})

test('an expiring Follow route hands keyboard focus back to the Live viewport', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    movementOnly: true,
  })
  await page.goto('/window/live?resident=map-walker')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)

  const activeReplay = page.locator('.live-replay-portrait[data-replay-duration]')
  await expect(activeReplay).toHaveCount(1)
  const duration = Number(await activeReplay.getAttribute('data-replay-duration'))
  const trail = page.locator('.live-trail[data-live-actor="map-walker"]')
  await expect(trail).toHaveAccessibleName('map-walker moved from 2 to 4')
  await trail.focus()
  await expect(trail).toBeFocused()

  await page.clock.runFor(duration + 4_501)
  await expect(activeReplay).toHaveCount(0)
  await expect(trail).toHaveCount(0)
  await expect(page.locator('#live-viewport')).toBeFocused()
})

test('a later crowded arrival keeps its full absorption window', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await page.clock.pauseAt(new Date(now + 500))
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    secondArrival: true,
    movementOnly: true,
    staggeredArrivalDeadlines: true,
  })
  await page.goto('/window#view=live')
  await expect.poll(async () => {
    await page.clock.runFor(32)
    await page.waitForTimeout(25)
    return page.locator('#live-history-status').textContent()
  }).toContain('history is complete')
  await expect(page.locator('#live-plates .live-walker')).toHaveCount(8)
  const harborPlot = page.locator('[data-place-id="3"]')

  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  const replays = page.locator('.live-replay-portrait[data-replay-duration]')
  await expect(replays).toHaveCount(1)
  await expect(replays).toHaveAttribute('data-live-replay-key', 'change:11')
  await page.clock.runFor(4_100)
  let durations: number[] = []
  await expect.poll(async () => {
    durations = await replays.evaluateAll(nodes => nodes.map(node =>
      Number((node as HTMLElement).dataset.replayDuration)))
    return durations.length
  }).toBe(2)
  const [firstDuration, lastDuration] = [...durations].sort((left, right) => left - right)
  expect(firstDuration).toBeGreaterThanOrEqual(3_200)
  expect(lastDuration).toBeLessThanOrEqual(8_000)

  const absorptionBadge = harborPlot.locator('.live-resident-more')
  await expect(absorptionBadge).toBeVisible()
  const viewport = page.locator('#live-viewport')
  const badgeFraming = () => absorptionBadge.evaluate(node => {
    const badge = node.getBoundingClientRect()
    const plot = node.closest('.live-plot') as HTMLElement
    const stage = node.closest('.live-stage') as HTMLElement
    const stageBox = stage.getBoundingClientRect()
    const scale = stageBox.width / Number(stage.dataset.liveStageWidth)
    const logicalX = stageBox.left + (
      Number(plot.dataset.livePlotX) + Number(plot.dataset.livePlotWidth) - 28
    ) * scale
    const logicalY = stageBox.top + (
      Number(plot.dataset.livePlotY) + Number(plot.dataset.livePlotHeight) - 10
    ) * scale
    const target = {
      left: Math.min(badge.left, logicalX),
      right: Math.max(badge.right, logicalX),
      top: Math.min(badge.top, logicalY),
      bottom: Math.max(badge.bottom, logicalY),
    }
    const camera = document.querySelector('#live-viewport')!.getBoundingClientRect()
    const margin = 6
    return {
      framed: target.left >= camera.left + margin && target.right <= camera.right - margin &&
        target.top >= camera.top + margin && target.bottom <= camera.bottom - margin,
      horizontal: target.left < camera.left + margin
        ? { key: 'ArrowLeft', count: Math.ceil((camera.left + margin - target.left) / 48) }
        : target.right > camera.right - margin
          ? { key: 'ArrowRight', count: Math.ceil((target.right - camera.right + margin) / 48) }
          : null,
      vertical: target.top < camera.top + margin
        ? { key: 'ArrowUp', count: Math.ceil((camera.top + margin - target.top) / 48) }
        : target.bottom > camera.bottom - margin
          ? { key: 'ArrowDown', count: Math.ceil((target.bottom - camera.bottom + margin) / 48) }
          : null,
    }
  })
  await viewport.focus()
  for (let attempt = 0; attempt < 4 && !(await badgeFraming()).framed; attempt += 1) {
    const geometry = await badgeFraming()
    await viewport.evaluate((node, directions) => {
      for (const direction of [directions.horizontal, directions.vertical]) {
        if (!direction) continue
        for (let index = 0; index < direction.count; index += 1) {
          node.dispatchEvent(new KeyboardEvent('keydown', {
            key: direction.key,
            bubbles: true,
          }))
        }
      }
    }, geometry)
    await page.clock.runFor(32)
  }
  await expect.poll(async () => (await badgeFraming()).framed).toBe(true)
  const remainingDuration = Math.max(...await replays.evaluateAll(nodes => nodes.map(node =>
    Number.parseFloat((node as HTMLElement).style.animationDuration))))
  expect(remainingDuration).toBeGreaterThan(0)
  expect(remainingDuration).toBeLessThanOrEqual(lastDuration!)
  await page.clock.runFor(remainingDuration)
  await page.clock.runFor(32)
  await expect(absorptionBadge).toHaveClass(/live-overflow-absorbing/u)
  await page.clock.runFor(250)
  await expect(absorptionBadge).toHaveClass(/live-overflow-absorbing/u)
  await page.clock.runFor(500)
  await expect(absorptionBadge).toHaveClass(/live-overflow-absorbing/u)
  await page.clock.runFor(150)
  await expect(absorptionBadge).not.toHaveClass(/live-overflow-absorbing/u)
})

test('focused use pulses the exact pinned nested thing', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const mapWalker = page.locator('[data-live-resident-handle="map-walker"]').first()
  await panLiveTargetIntoView(page, mapWalker)
  await mapWalker.click()

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const replay = page.locator('.live-replay-portrait')
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:11')
  const useReplay = page.locator(
    '.live-use-replay[data-live-use-thing-id="9"] [data-live-resident-handle="map-walker"]',
  )
  const pinnedThing = page.locator('[data-place-id="3"] [data-live-thing-id="9"]')
  await panLiveTargetIntoView(page, page.locator('[data-place-id="3"]'))
  await page.clock.runFor(32)
  await expect(pinnedThing).toBeVisible()
  await panLiveTargetIntoView(page, pinnedThing)
  await page.clock.runFor(32)
  let sawUse = false
  for (let elapsed = 0; elapsed < 20_000 && !sawUse; elapsed += 200) {
    await page.clock.runFor(200)
    sawUse = await pinnedThing.evaluate(node => node.classList.contains('live-pulse'))
  }
  expect(sawUse).toBe(true)
  await expect(pinnedThing).toHaveAttribute('data-live-focus-thing', '9')
  await expect(pinnedThing).toHaveClass(/live-pulse/u)
  await expect(pinnedThing).toBeVisible()
  await expect(useReplay).toBeVisible()
  const separation = await useReplay.evaluate((residentNode, thingSelector) => {
    const resident = residentNode.closest('.live-use-replay')!.getBoundingClientRect()
    const thing = document.querySelector(thingSelector)!.getBoundingClientRect()
    return Math.max(
      thing.left - resident.right,
      resident.left - thing.right,
      thing.top - resident.bottom,
      resident.top - thing.bottom,
    )
  }, '[data-place-id="3"] [data-live-thing-id="9"]')
  expect(separation).toBeGreaterThanOrEqual(8)
  expect(separation).toBeLessThanOrEqual(24)
})

test('use brings an overflowed exact thing and its resident into the visible replay', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, { useThingId: 25 })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const exactThing = page.locator('[data-place-id="3"] [data-live-thing-id="25"]')
  await expect(exactThing).toHaveCount(0)

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('[data-place-id="3"] .live-thing-more')).toHaveText('+3 more')
  await expect(exactThing).toHaveCount(1)
  await expect(exactThing).toHaveAttribute('data-live-focus-thing', '25')
  await expect(exactThing).not.toHaveClass(/live-pulse/u)
  let sawUse = false
  for (let elapsed = 0; elapsed < 20_000 && !sawUse; elapsed += 200) {
    await page.clock.runFor(200)
    sawUse = await exactThing.count() === 1 &&
      await exactThing.evaluate(node => node.classList.contains('live-pulse'))
  }
  expect(sawUse).toBe(true)
  await panLiveTargetIntoView(page, exactThing)
  await expect(page.locator(
    '.live-use-replay[data-live-use-thing-id="25"] ' +
    '[data-live-resident-handle="map-walker"]',
  )).toBeVisible()
  await exactThing.focus()
  const popover = page.locator('#live-item-popover[data-live-item-popover="true"]')
  await expect(popover).toBeVisible()
  await expect(exactThing.locator('.live-neutral-marker')).toBeVisible()
  await expect(popover.locator('[data-live-popover-field="state"]')).toContainText('Undrawn')
  await expect(popover.locator('[data-live-popover-field="maker"]')).toContainText('map-walker')
  await expect(popover.locator('[data-live-popover-field="owner"]')).toContainText('map-walker')
  await expect(popover.locator('[data-live-popover-field="size"]')).toContainText('8 × 8 pixels')
  await expect(popover.locator('[data-live-popover-field="last-action"]'))
    .toContainText('map-walker used thing #25')
})

test('focus keeps every exact interaction visible outside finite plate slots', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await installReplayRoutes(page, now, 'complete', 0, {
    manyFocusInteractions: true,
    maximumHandle: maximumReplayHandle,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const mapWalker = page.locator('[data-live-resident-handle="map-walker"]').first()
  await panLiveTargetIntoView(page, mapWalker)
  await mapWalker.click()
  await expect(page.locator('#live-roster [data-live-focus-partner]')).toHaveCount(7)
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing]')).toHaveCount(9)
  const thingIds = await page.locator('#live-focus-interactions [data-live-focus-thing]')
    .evaluateAll(nodes => nodes.map(node => Number((node as HTMLElement).dataset.liveFocusThing)))
  expect([...thingIds].sort((left, right) => left - right))
    .toEqual([20, 21, 22, 23, 24, 25, 26, 90, 91])
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="90"]'))
    .toContainText('Thing #90 · recorded in Harbor room')
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="91"]'))
    .toContainText('Thing #91 · recorded in Harbor room')
  const focusedThingLink = page.locator(
    '#live-focus-interactions [data-live-focus-thing="21"]',
  )
  await focusedThingLink.focus()
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await expect(focusedThingLink).toBeFocused()

  const plotWalkersOverlap = await page.locator('[data-place-id="3"] .live-walker')
    .evaluateAll(nodes => nodes.some((node, index) => {
      const first = node.getBoundingClientRect()
      return nodes.slice(index + 1).some(other => {
        const second = other.getBoundingClientRect()
        return first.left < second.right && first.right > second.left &&
          first.top < second.bottom && first.bottom > second.top
      })
    }))
  expect(plotWalkersOverlap).toBe(false)

  const harborOpen = page.locator('[data-place-id="3"] .live-plot-open')
  await panLiveTargetIntoView(page, harborOpen)
  await harborOpen.click()
  const rootWalkersOverlap = await page.locator('.live-root-walkers .live-walker')
    .evaluateAll(nodes => nodes.some((node, index) => {
      const first = node.getBoundingClientRect()
      return nodes.slice(index + 1).some(other => {
        const second = other.getBoundingClientRect()
        return first.left < second.right && first.right > second.left &&
          first.top < second.bottom && first.bottom > second.top
      })
    }))
  expect(rootWalkersOverlap).toBe(false)
  const maximumHandlePortrait = page.locator(
    `.live-root-walkers [data-live-resident-handle="${maximumReplayHandle}"]`,
  )
  await expect(maximumHandlePortrait).toHaveAttribute('aria-label', `Focus on ${maximumReplayHandle}`)
  const [maximumHandleShellHeight, shortHandleShellHeight] = await page.locator(
    '.live-root-walkers',
  ).evaluate((root, handles) => handles.map(handle => root.querySelector(
    `[data-live-resident-handle="${handle}"]`,
  )!.closest('.live-walker')!.getBoundingClientRect().height), [maximumReplayHandle, 'harbor-5'])
  expect(Math.abs(maximumHandleShellHeight - shortHandleShellHeight)).toBeLessThanOrEqual(1)
  await expect(page.locator('.live-root-walkers .live-speech-bubble')).toHaveCount(0)

  await page.locator('#resident-filter').selectOption('harbor-7')
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
  expect(await page.evaluate(() => localStorage.getItem('1f3d9:window:live-focus'))).toBeNull()
  const filteredResident = page.locator('[data-live-resident-handle="harbor-7"]').first()
  await panLiveTargetIntoView(page, filteredResident)
  await filteredResident.click()
  await expect(page.locator('#live-focus-status')).toContainText('Focused on harbor-7')
  await expect(page).toHaveURL(/\/window\/live\?place=3$/u)
})

test('resident labels follow zoom and intent while ground sprites and camera writes stay bounded', async ({ page }) => {
  const now = Date.now()
  await installReplayRoutes(page, now, 'complete', 0, { maximumHandle: maximumReplayHandle })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const stage = page.locator('#live-stage')
  await expect(stage).toHaveAttribute('data-live-label-mode', 'far')
  await expect(page.locator('.live-root-place-sprite > .drawing-grid')).toHaveCount(1)
  await expect(page.locator('.live-world-ground > .drawing-grid')).toHaveCount(0)
  await expect(page.locator('.live-plot-open > .drawing-grid')).toHaveCount(2)
  await expect(page.locator('.live-plot-terrain, .live-plot-owner')).toHaveCount(0)

  const focusedWalker = page.locator(
    `#live-plates [data-live-resident-handle="${maximumReplayHandle}"]`,
  ).first()
  const focusedTag = page.locator(
    `#live-label-layer [data-live-resident-tag="${maximumReplayHandle}"]`,
  )
  await expect(focusedTag).toHaveCount(0)
  await panLiveTargetIntoView(page, focusedWalker)
  await focusedWalker.hover()
  await expect(focusedTag).toBeVisible()
  await page.mouse.move(1, 1)
  await page.locator('#live-viewport').focus()
  await expect(focusedTag).toHaveCount(0)
  await focusedWalker.focus()
  await expect(focusedTag).toBeVisible()
  await page.locator('#live-viewport').focus()
  await expect(focusedTag).toHaveCount(0)
  await focusedWalker.evaluate(node => (node as HTMLButtonElement).click())
  await page.locator('#live-viewport').focus()
  await expect(focusedTag).toHaveCount(0)
  await page.locator('#resident-filter').selectOption(maximumReplayHandle)
  await expect(stage).toHaveAttribute('data-live-label-mode', 'far')
  await panLiveTargetIntoView(page, focusedWalker)
  await expect(focusedTag).toBeVisible()
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Zoom in' }).click()
  }
  await expect(stage).toHaveAttribute('data-live-label-mode', 'readable')
  await panLiveTargetIntoView(page, focusedWalker)
  await expect(focusedTag).toBeVisible()
  await expect(focusedTag).toHaveText(maximumReplayHandle)
  await expect(focusedTag).toHaveCSS('text-overflow', 'clip')
  await expect(focusedTag).toHaveCSS('overflow', 'visible')
  await expect(focusedTag).toHaveCSS('white-space', 'nowrap')

  await page.locator('#resident-filter').selectOption('')
  await focusedWalker.evaluate(node => (node as HTMLButtonElement).click())
  await expect(page.locator('#live-focus-status')).toContainText(
    `Focused on ${maximumReplayHandle}`,
  )
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Zoom out' }).click()
  }
  await expect(stage).toHaveAttribute('data-live-label-mode', 'far')
  await page.getByRole('button', { name: 'Center live view' }).click()
  await panLiveTargetIntoView(page, page.locator(
    '.live-plot[data-place-id="3"] .live-plot-open',
  ))
  const visibleHandles = await page.locator(
    '#live-plates .live-walker [data-live-resident-handle]',
  ).evaluateAll(nodes => {
    const viewport = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return nodes.flatMap(node => {
      const rect = node.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0 && rect.right > viewport.left &&
        rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom
      return visible ? [(node as HTMLElement).dataset.liveResidentHandle!] : []
    }).slice(0, 2)
  })
  expect(visibleHandles).toHaveLength(2)
  const firstIntentWalker = page.locator(
    `#live-plates [data-live-resident-handle="${visibleHandles[0]}"]`,
  ).first()
  const secondIntentWalker = page.locator(
    `#live-plates [data-live-resident-handle="${visibleHandles[1]}"]`,
  ).first()
  await firstIntentWalker.dispatchEvent('pointerdown', { pointerType: 'touch' })
  await firstIntentWalker.dispatchEvent('click', { pointerType: 'touch' })
  await expect(firstIntentWalker.locator('xpath=..')).toHaveAttribute('data-live-raised', 'true')
  await secondIntentWalker.focus()
  await expect(secondIntentWalker).toBeFocused()
  const firstIntentTag = page.locator(
    `#live-label-layer [data-live-resident-tag="${visibleHandles[0]}"]`,
  )
  const secondIntentTag = page.locator(
    `#live-label-layer [data-live-resident-tag="${visibleHandles[1]}"]`,
  )
  await expect(firstIntentTag).toBeVisible()
  await expect(secondIntentTag).toBeVisible()
  const labelsOverlap = await firstIntentTag.evaluate((node, neighbor) => {
    const first = node.getBoundingClientRect()
    const second = neighbor.getBoundingClientRect()
    return first.left < second.right && first.right > second.left &&
      first.top < second.bottom && first.bottom > second.top
  }, await secondIntentTag.elementHandle())
  expect(labelsOverlap).toBe(false)

  const plotNameplate = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  await expect(plotNameplate).toHaveAttribute('title', 'Open the live plate for Cinder lane')
  await expect(plotNameplate.locator('.live-plot-name')).toHaveCSS('text-overflow', 'clip')
  await expect(plotNameplate.locator('.live-plot-name')).toHaveCSS('overflow', 'visible')

  const cameraAttributeWrites = await page.locator('#live-viewport').evaluate(async viewport => {
    const liveStage = document.querySelector('#live-stage')!
    let writes = 0
    const observer = new MutationObserver(records => { writes += records.length })
    observer.observe(liveStage, { attributes: true })
    for (let index = 0; index < 32; index += 1) {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, clientX: 320, clientY: 220, deltaY: -4,
      }))
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    observer.disconnect()
    return writes
  })
  expect(cameraAttributeWrites).toBeLessThanOrEqual(12)

  await page.locator('#live-viewport').evaluate(viewport => {
    const rect = viewport.getBoundingClientRect()
    for (let index = 0; index < 12; index += 1) {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        deltaY: -160,
      }))
    }
  })
  await page.clock.runFor(500)
  await expect(stage).toHaveAttribute('data-live-label-mode', 'readable')
  await expect.poll(() => page.locator('#live-viewport').evaluate(() => {
    const viewport = document.querySelector('#live-label-layer')!.getBoundingClientRect()
    const visibleHandles = [...document.querySelectorAll<HTMLElement>(
      '#live-plates .live-portrait[data-live-resident-handle]',
    )].flatMap(portrait => {
      const rect = portrait.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.right > viewport.left &&
        rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom
        ? [portrait.dataset.liveResidentHandle!]
        : []
    }).sort()
    const packedHandles = [...document.querySelectorAll<HTMLElement>(
      '#live-label-layer .live-resident-tag[data-live-packed="true"]',
    )].map(tag => tag.dataset.liveResidentTag!).sort()
    return JSON.stringify(packedHandles) === JSON.stringify(visibleHandles)
  })).toBe(true)
  const packedLabels = await page.locator('#live-viewport').evaluate(() => {
    const viewport = document.querySelector('#live-label-layer')!.getBoundingClientRect()
    const handles = [...document.querySelectorAll<HTMLElement>(
      '#live-plates .live-portrait[data-live-resident-handle]',
    )].flatMap(portrait => {
      const rect = portrait.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.right > viewport.left &&
        rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom
        ? [portrait.dataset.liveResidentHandle!]
        : []
    }).sort()
    const tags = [...document.querySelectorAll<HTMLElement>(
      '#live-label-layer .live-resident-tag[data-live-packed="true"]',
    )]
    const tagRects = tags.map(tag => ({
      handle: tag.dataset.liveResidentTag!,
      rect: tag.getBoundingClientRect(),
      packed: tag.dataset.livePacked,
      fontSize: Number.parseFloat(getComputedStyle(tag).fontSize),
      full: tag.scrollWidth <= tag.clientWidth && getComputedStyle(tag).textOverflow === 'clip',
    }))
    const collisions = tagRects.flatMap((left, index) => tagRects.slice(index + 1)
      .filter(right => left.rect.left < right.rect.right && left.rect.right > right.rect.left &&
        left.rect.top < right.rect.bottom && left.rect.bottom > right.rect.top)
      .map(right => [left.handle, right.handle]))
    const bubbles = [...document.querySelectorAll<HTMLElement>('.live-speech-bubble')]
      .map(bubble => bubble.getBoundingClientRect())
    const bubbleCollisions = tagRects.filter(tag => bubbles.some(bubble =>
      tag.rect.left < bubble.right && tag.rect.right > bubble.left &&
      tag.rect.top < bubble.bottom && tag.rect.bottom > bubble.top)).map(tag => tag.handle)
    return {
      handles,
      tagHandles: tagRects.map(tag => tag.handle).sort(),
      allReadable: tagRects.every(tag => tag.fontSize >= 11),
      allFull: tagRects.every(tag => tag.full),
      collisions,
      bubbleCollisions,
    }
  })
  expect(packedLabels.tagHandles).toEqual(packedLabels.handles)
  expect(packedLabels.allReadable).toBe(true)
  expect(packedLabels.allFull).toBe(true)
  expect(packedLabels.collisions).toEqual([])
  expect(packedLabels.bubbleCollisions).toEqual([])

  const fixedPlotState = await page.locator('.live-plot[data-place-id="3"]').evaluate(plot => ({
    left: (plot as HTMLElement).style.left,
    top: (plot as HTMLElement).style.top,
    overflow: plot.querySelector('.live-resident-more')?.textContent,
  }))
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Center live view' })).toBeVisible()
  await expect(page.getByRole('button', { name: /fit/i })).toHaveCount(0)
  await page.getByRole('button', { name: 'Center live view' }).click()
  const centeredFocus = await focusedWalker.evaluate(node => {
    const resident = node.getBoundingClientRect()
    const viewportBox = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return {
      x: Math.abs((resident.left + resident.width / 2) -
        (viewportBox.left + viewportBox.width / 2)),
      y: Math.abs((resident.top + resident.height / 2) -
        (viewportBox.top + viewportBox.height / 2)),
    }
  })
  expect(centeredFocus.x).toBeLessThanOrEqual(80)
  expect(centeredFocus.y).toBeLessThanOrEqual(80)
  expect(Number(await stage.getAttribute('data-live-scale'))).toBeGreaterThanOrEqual(0.8)
  await expect(page.locator('#live-focus-status')).toContainText(`Focused on ${maximumReplayHandle}`)
  expect(await page.locator('.live-plot[data-place-id="3"]').evaluate(plot => ({
    left: (plot as HTMLElement).style.left,
    top: (plot as HTMLElement).style.top,
    overflow: plot.querySelector('.live-resident-more')?.textContent,
  }))).toEqual(fixedPlotState)
})

test('a compact far place marker reveals its whole label for hover, focus, and raise', async ({ page }) => {
  await installReplayRoutes(page, Date.now())
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  const plot = page.locator('.live-plot[data-place-id="2"]')
  const open = plot.locator('.live-plot-open')
  const name = open.locator('.live-plot-name')
  await panLiveTargetIntoView(page, open)
  await plot.evaluate(node => { (node as HTMLElement).dataset.liveDetail = 'false' })
  await expect(name).not.toBeVisible()

  for (const reveal of [
    () => open.hover(),
    () => open.focus(),
    () => plot.evaluate(node => { (node as HTMLElement).dataset.liveRaised = 'true' }),
  ]) {
    await reveal()
    await expect(name).toBeVisible()
    expect(await name.evaluate(node => {
      const rect = node.getBoundingClientRect()
      return rect.width > 1 && rect.height > 1 && getComputedStyle(node).clip === 'auto'
    })).toBe(true)
    await page.mouse.move(1, 1)
    await page.locator('#live-viewport').focus()
  }

  await plot.evaluate(node => { delete (node as HTMLElement).dataset.liveRaised })
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Zoom in' }).click()
  }
  await expect(page.locator('#live-stage')).toHaveAttribute('data-live-label-mode', 'readable')
  await plot.evaluate(node => { (node as HTMLElement).dataset.liveDetail = 'false' })
  await expect(name).toBeVisible()
  expect(await name.evaluate(node => ({
    clip: getComputedStyle(node).clip,
    height: getComputedStyle(node).height,
    overflow: getComputedStyle(node).overflow,
    width: getComputedStyle(node).width,
    whiteSpace: getComputedStyle(node).whiteSpace,
  }))).toMatchObject({ clip: 'auto', overflow: 'visible', whiteSpace: 'normal' })
})

test('readable crowd labels reuse rejected measurements between bounded refreshes', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await installLiveRenderWorkRecorder(page)
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: 7,
    residentCrowdSize: 150,
    crowdPlaceId: 3,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Zoom in' }).click()
  }
  await expect(page.locator('#live-stage')).toHaveAttribute('data-live-label-mode', 'readable')
  await page.clock.runFor(32)
  await resetLiveRenderWork(page)
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  await page.clock.runFor(1_000)
  await expect(page.locator('.live-replay-portrait[data-replay-duration]')).toHaveCount(7)
  expect((await readLiveRenderWork(page)).residentLabelMeasurements)
    .toBeLessThanOrEqual(800)
})

test('focus keeps a truthful specimen visible after its resident leaves the drilled plate', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const cinderOpen = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  await panLiveTargetIntoView(page, cinderOpen)
  await cinderOpen.click()
  const mapWalker = page.locator(
    '#live-roster [data-live-resident-handle="map-walker"]',
  ).first()
  await expect(mapWalker).toBeVisible()
  await mapWalker.click()
  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
  const outsideFocus = page.locator(
    '#live-focus-interactions [data-live-focus-resident="map-walker"]' +
    '[data-live-resident-scope="outside"]',
  )
  await expect(outsideFocus).toContainText('Outside this plate · Lantern nook')
  await expect(page.locator('#live-plates [data-live-focus-resident="map-walker"]')).toHaveCount(0)
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
})

test('resident focus persists locally, pins exact interactions, and camera zoom stays viewer-only', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const walker = page.locator('[data-live-resident-handle="map-walker"]').first()
  await panLiveTargetIntoView(page, walker)
  await walker.click()
  await expect(page.locator('#live-focus-status')).toContainText('map-walker')
  await expect(page.locator(
    '#live-plates [data-live-focus-resident="map-walker"]',
  )).toHaveCount(1)
  await expect(page.locator(
    '#live-roster [data-live-focus-resident="map-walker"]',
  )).toHaveCount(1)
  const interactionPartner = page.locator(
    '#live-plates [data-live-focus-partner="harbor-7"]',
  )
  await expect(interactionPartner).toHaveCount(1)
  await expect(page.locator(
    '#live-roster [data-live-focus-partner="harbor-7"]',
  )).toHaveCount(1)
  await expect(page.locator(
    '[data-place-id="2"] [data-live-focus-thing="26"]',
  )).toHaveCount(1)
  const residentBadge = page.locator('[data-place-id="3"] .live-resident-more')
  await expect(residentBadge).toHaveCount(1)
  const residentOverlap = await page.locator('[data-place-id="3"]').evaluate(plot => {
    const badge = plot.querySelector('.live-resident-more')
    if (!badge) return null
    const count = badge.getBoundingClientRect()
    return [...plot.querySelectorAll('.live-walker')].some(node => {
      const pin = node.getBoundingClientRect()
      return pin.left < count.right && pin.right > count.left &&
        pin.top < count.bottom && pin.bottom > count.top
    })
  })
  expect(residentOverlap).toBe(false)
  const residentPairOverlap = await page.locator(
    '[data-place-id="3"] .live-walker',
  ).evaluateAll(nodes => nodes.some((node, index) => {
    const first = node.getBoundingClientRect()
    return nodes.slice(index + 1).some(other => {
      const second = other.getBoundingClientRect()
      return first.left < second.right && first.right > second.left &&
        first.top < second.bottom && first.bottom > second.top
    })
  }))
  expect(residentPairOverlap).toBe(false)
  await expect(page).toHaveURL(/\/window\/live$/u)

  const stage = page.locator('#live-stage')
  const startingScale = Number(await stage.getAttribute('data-live-scale'))
  await page.locator('#live-viewport').dispatchEvent('wheel', {
    clientX: 320, clientY: 220, deltaY: -240,
  })
  await expect.poll(async () => Number(await stage.getAttribute('data-live-scale')))
    .toBeGreaterThan(startingScale)
  const wheelScale = Number(await stage.getAttribute('data-live-scale'))
  const viewport = page.locator('#live-viewport')
  await viewport.focus()
  const keyboardStartX = Number(await stage.getAttribute('data-live-offset-x'))
  await viewport.press('ArrowRight')
  await expect.poll(async () => Number(await stage.getAttribute('data-live-offset-x')))
    .toBeLessThan(keyboardStartX)
  await viewport.press('+')
  await expect.poll(async () => Number(await stage.getAttribute('data-live-scale')))
    .toBeGreaterThan(wheelScale)
  await viewport.dispatchEvent('pointerdown', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 240, clientY: 220,
  })
  await viewport.dispatchEvent('pointerdown', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 360, clientY: 220,
  })
  await viewport.dispatchEvent('pointermove', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 430, clientY: 220,
  })
  await expect.poll(async () => Number(await stage.getAttribute('data-live-scale')))
    .toBeGreaterThan(wheelScale)
  await viewport.dispatchEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 240, clientY: 220,
  })
  await viewport.dispatchEvent('pointerup', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 430, clientY: 220,
  })
  await page.getByRole('button', { name: 'Center live view' }).click()

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const replay = page.locator('.live-replay-portrait')
  await expect(replay).toHaveCount(1)
  const pinnedThing = page.locator('[data-place-id="3"] [data-live-thing-id="9"]')
  await expect(pinnedThing).toHaveCount(1)
  await expect(pinnedThing).toHaveAttribute('data-live-focus-thing', '9')
  const pinnedThingBounds = await pinnedThing.evaluate(node => {
    const thing = node.getBoundingClientRect()
    const plot = node.closest('.live-plot')!.getBoundingClientRect()
    return {
      thing: { left: thing.left, right: thing.right, top: thing.top, bottom: thing.bottom },
      plot: { left: plot.left, right: plot.right, top: plot.top, bottom: plot.bottom },
    }
  })
  expect(pinnedThingBounds.thing.left).toBeGreaterThanOrEqual(pinnedThingBounds.plot.left - 1)
  expect(pinnedThingBounds.thing.right).toBeLessThanOrEqual(pinnedThingBounds.plot.right + 1)
  expect(pinnedThingBounds.thing.top).toBeGreaterThanOrEqual(pinnedThingBounds.plot.top - 1)
  expect(pinnedThingBounds.thing.bottom).toBeLessThanOrEqual(pinnedThingBounds.plot.bottom + 1)
  const thingBadge = page.locator('[data-place-id="3"] .live-thing-more')
  await expect(thingBadge).toHaveText('+3 more')
  const thingOverlaps = await page.locator('[data-place-id="3"]').evaluate(plot => {
    const badge = plot.querySelector('.live-thing-more')
    if (!badge) return null
    const count = badge.getBoundingClientRect()
    return [...plot.querySelectorAll('.live-thing-specimen')].some(node => {
      const thing = node.getBoundingClientRect()
      return thing.left < count.right && thing.right > count.left &&
        thing.top < count.bottom && thing.bottom > count.top
    })
  })
  expect(thingOverlaps).toBe(false)

  await page.reload()
  await expect(page.locator('#live-focus-status')).toContainText('map-walker')
  await expect(page.locator(
    '#live-plates [data-live-focus-resident="map-walker"]',
  )).toHaveCount(1)
  const focusedWalker = page.locator('[data-live-resident-handle="map-walker"]').first()
  await expectTargetCenterExposed(focusedWalker)
  await focusedWalker.click()
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')

  await focusedWalker.click()
  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
  const clearFocus = page.getByRole('button', { name: 'Clear resident focus' })
  await expectTargetCenterExposed(clearFocus)
  await clearFocus.click()
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
  expect(await page.evaluate(() => localStorage.getItem('1f3d9:window:live-focus'))).toBeNull()
  await focusedWalker.click()
  await expect(page.locator('#live-focus-status')).toContainText('map-walker')

  await page.getByRole('button', { name: 'Clear resident focus' }).click()
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
  await page.reload()
  await expect(page.locator('[data-live-focus-resident]')).toHaveCount(0)
})

test('reduced motion shows new records statically without replay animation', async ({ page }) => {
  const now = Date.now()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator(
    '.live-replay-portrait, .live-trail, .live-footstep, .live-speech-bubble',
  )).toHaveCount(0)

  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  await expect.poll(() => page.locator('.live-footstep').count()).toBeGreaterThan(0)
  expect(await page.locator('.live-footstep').count()).toBeLessThanOrEqual(3)
  await expect(page.locator('.live-trail')).toHaveCount(0)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await expectMapWalkerSettledAtLantern(page)
  expect(await page.locator('#live-panel').evaluate(panel =>
    panel.getAnimations({ subtree: true }).filter(animation =>
      animation.playState === 'running').length)).toBe(0)
  await expect(page.locator('#live-ledger, .live-footnote-mark, .live-action-mark'))
    .toHaveCount(0)
})

test('reduced motion does not mint bubbles for records outside the watched plate', async ({ page }) => {
  const now = Date.now()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window/live?place=2')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)

  await page.locator('#place-filter').selectOption('')
  await page.clock.runFor(32)
  await expect(page.locator('.live-plate-title')).toHaveText('the world')
  await page.waitForTimeout(250)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
})

test('an observed crowd bounds footstep detail and removes it after two seconds', async ({ page }) => {
  const now = Date.now()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: 120,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-footstep, .live-trail, .live-replay-portrait'))
    .toHaveCount(0)

  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  await expect.poll(() => page.locator('.live-footstep').count()).toBeGreaterThan(0)
  expect(await page.locator('.live-footstep').count()).toBeLessThanOrEqual(18)
  await expect(page.locator('.live-trail')).toHaveCount(0)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('#live-ledger')).toHaveCount(0)
  await page.clock.fastForward(2_001)
  await expect(page.locator('.live-footstep')).toHaveCount(0)
  const movedRows = page.locator('#live-roster .resident-row').filter({ hasText: 'Harbor room' })
  expect(await movedRows.count()).toBeGreaterThanOrEqual(120)
})

test('a 150-resident plate reports honest frame work while 64 residents move', async ({ page }, testInfo) => {
  test.setTimeout(30_000)
  const now = Date.now()
  await page.setViewportSize({ width: 1_280, height: 800 })
  await installLiveRenderWorkRecorder(page)
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: 64,
    staggeredMoveTimes: true,
    residentCrowdSize: 150,
    crowdPlaceId: 3,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('#live-roster .resident-row')).toHaveCount(215)
  await resetLiveRenderWork(page)
  await page.evaluate(() => {
    const heldWindow = window as Window & {
      __liveBenchmark?: {
        frameTimes: number[]
        running: boolean
        maxReplayPortraits: number
        addedNodes: number
        removedNodes: number
        cameraMoves: number
        panTimer: number
        observer: MutationObserver
      }
    }
    const benchmark = {
      frameTimes: [] as number[],
      running: true,
      maxReplayPortraits: 0,
      addedNodes: 0,
      removedNodes: 0,
      cameraMoves: 0,
      panTimer: 0,
      observer: new MutationObserver(() => {}),
    }
    benchmark.observer = new MutationObserver(records => {
      for (const record of records) {
        benchmark.addedNodes += record.addedNodes.length
        benchmark.removedNodes += record.removedNodes.length
      }
    })
    benchmark.observer.observe(document.querySelector('#live-plates')!, {
      childList: true,
      subtree: true,
    })
    const sample = (at: number) => {
      if (!benchmark.running) return
      benchmark.frameTimes.push(at)
      benchmark.maxReplayPortraits = Math.max(
        benchmark.maxReplayPortraits,
        document.querySelectorAll('.live-replay-portrait').length,
      )
      requestAnimationFrame(sample)
    }
    heldWindow.__liveBenchmark = benchmark
    requestAnimationFrame(sample)
    const viewport = document.querySelector<HTMLElement>('#live-viewport')!
    benchmark.panTimer = window.setInterval(() => {
      if (benchmark.cameraMoves >= 60) {
        window.clearInterval(benchmark.panTimer)
        benchmark.panTimer = 0
        return
      }
      viewport.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: benchmark.cameraMoves < 30 ? 'ArrowRight' : 'ArrowLeft',
      }))
      benchmark.cameraMoves += 1
    }, 50)
  })

  await publishReplayChanges(page, fixture)
  await page.waitForTimeout(5_000)
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __liveReplayStarts?: unknown[]
  }).__liveReplayStarts?.length ?? 0)).toBe(64)
  const frameWork = await page.evaluate(() => {
    const heldWindow = window as Window & {
      __liveBenchmark?: {
        frameTimes: number[]
        running: boolean
        maxReplayPortraits: number
        addedNodes: number
        removedNodes: number
        cameraMoves: number
        panTimer: number
        observer: MutationObserver
      }
      __liveReplayStarts?: unknown[]
    }
    const benchmark = heldWindow.__liveBenchmark!
    benchmark.running = false
    window.clearInterval(benchmark.panTimer)
    benchmark.observer.disconnect()
    const frameGaps = benchmark.frameTimes.slice(1).map((at, index) =>
      at - benchmark.frameTimes[index]!)
    const ordered = [...frameGaps].sort((left, right) => left - right)
    const p95Index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1)
    return {
      sampledFrames: benchmark.frameTimes.length,
      p95FrameMs: Number((ordered[p95Index] ?? 0).toFixed(2)),
      maximumFrameMs: Number((ordered.at(-1) ?? 0).toFixed(2)),
      droppedFrameEquivalents: frameGaps.reduce((total, gap) =>
        total + Math.max(0, Math.round(gap / (1_000 / 60)) - 1), 0),
      maxReplayPortraits: benchmark.maxReplayPortraits,
      addedNodes: benchmark.addedNodes,
      removedNodes: benchmark.removedNodes,
      cameraMoves: benchmark.cameraMoves,
      replayStarts: heldWindow.__liveReplayStarts?.length ?? 0,
    }
  })
  const result = Object.freeze({
    fixtureResidents: 215,
    observedMovers: 64,
    recordedTimeGroups: 16,
    sampleWindowMs: 5_000,
    ...frameWork,
    renderWork: await readLiveRenderWork(page),
  })
  await testInfo.attach('live-crowd-frame-work.json', {
    body: Buffer.from(JSON.stringify(result, null, 2)),
    contentType: 'application/json',
  })
  console.info('LIVE_CROWD_FRAME_WORK ' + JSON.stringify(result))
  expect(result.replayStarts).toBe(64)
  expect(result.cameraMoves).toBe(60)
  expect(result.sampledFrames).toBeGreaterThan(120)
  expect(result.p95FrameMs).toBeLessThanOrEqual(100)
  expect(result.renderWork.renders).toBeLessThanOrEqual(18)
  expect(result.renderWork.motionLayerRefreshes).toBeLessThanOrEqual(64)
  expect(result.addedNodes).toBeLessThanOrEqual(400)
  expect(result.removedNodes).toBeLessThanOrEqual(400)
})

test('sixty-four simultaneous walks complete in one painted batch', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await installLiveRenderWorkRecorder(page)
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: 64,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  const replays = page.locator('.live-replay-portrait')
  let durations: number[] = []
  await expect.poll(async () => {
    durations = await replays.evaluateAll(nodes => nodes.map(node =>
      Number((node as HTMLElement).dataset.replayDuration)))
    return durations.length
  }).toBe(64)
  expect(new Set(durations).size).toBe(1)
  await page.locator('#live-viewport').evaluate(viewport => {
    const anchor = document.querySelector('.live-replay-portrait')!.getBoundingClientRect()
    for (let index = 0; index < 12; index += 1) {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: anchor.left + anchor.width / 2,
        clientY: anchor.top + anchor.height / 2,
        deltaY: -160,
      }))
    }
  })
  await page.clock.runFor(32)
  await expect(page.locator('#live-stage')).toHaveAttribute('data-live-label-mode', 'readable')
  await expect.poll(() => page.locator(
    '#live-label-layer [data-live-packed="true"][data-live-resident-tag^="walker-burst-"]',
  ).count()).toBeGreaterThan(0)
  await page.evaluate(() => {
    const heldWindow = window as typeof window & {
      liveLabelGeometryReads?: number
      liveOriginalClientRect?: typeof Element.prototype.getBoundingClientRect
    }
    heldWindow.liveLabelGeometryReads = 0
    heldWindow.liveOriginalClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches(
        '#live-label-layer, .live-portrait, .live-speech-bubble, .live-resident-tag',
      )) heldWindow.liveLabelGeometryReads! += 1
      return heldWindow.liveOriginalClientRect!.call(this)
    }
  })
  await page.clock.runFor(750)
  const labelGeometryReads = await page.evaluate(() => {
    const heldWindow = window as typeof window & {
      liveLabelGeometryReads?: number
      liveOriginalClientRect?: typeof Element.prototype.getBoundingClientRect
    }
    Element.prototype.getBoundingClientRect = heldWindow.liveOriginalClientRect!
    return heldWindow.liveLabelGeometryReads ?? 0
  })
  expect(labelGeometryReads).toBeLessThan(1_000)
  await page.clock.runFor(Math.max(0, durations[0]! - 900))
  await page.evaluate(() => {
    const heldWindow = window as typeof window & {
      liveCompletionMutations?: number
      liveCompletionObserver?: MutationObserver
    }
    heldWindow.liveCompletionMutations = 0
    heldWindow.liveCompletionObserver = new MutationObserver(records => {
      heldWindow.liveCompletionMutations! += records.length
    })
    heldWindow.liveCompletionObserver.observe(document.querySelector('#live-plates')!, {
      childList: true,
    })
  })

  await resetLiveRenderWork(page)

  await page.clock.runFor(200)
  await expect(page.locator('.live-replay-portrait[data-replay-duration]')).toHaveCount(0)
  const completionMutations = await page.evaluate(() => {
    const heldWindow = window as typeof window & {
      liveCompletionMutations?: number
      liveCompletionObserver?: MutationObserver
    }
    heldWindow.liveCompletionObserver?.disconnect()
    return heldWindow.liveCompletionMutations ?? 0
  })
  const completionWork = await readLiveRenderWork(page)
  expect(completionWork.renders).toBeLessThanOrEqual(1)
  expect(completionMutations).toBeLessThanOrEqual(18)
  await expect(page.locator('.live-trail')).toHaveCount(0)
  expect(await page.locator('.live-footstep').count()).toBeLessThanOrEqual(18)
})

test('crowded movement spends detail per mover while every resident keeps gliding', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await installLiveRenderWorkRecorder(page)
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: 7,
    residentCrowdSize: 150,
    crowdPlaceId: 3,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)

  const replays = page.locator('.live-replay-portrait[data-replay-duration]')
  const detailed = page.locator(
    '.live-replay-portrait[data-replay-duration][data-live-movement="detail"]',
  )
  const simple = page.locator(
    '.live-replay-portrait[data-replay-duration][data-live-movement="simple"]',
  )
  await expect(replays).toHaveCount(7)
  await expect(detailed).toHaveCount(6)
  await expect(simple).toHaveCount(1)
  await page.clock.runFor(2)
  await expect.poll(() => page.locator('.live-footstep').count()).toBeGreaterThanOrEqual(12)
  const footstepCount = await page.locator('.live-footstep').count()
  expect(footstepCount).toBeLessThanOrEqual(18)
  await expect(page.locator('.live-trail')).toHaveCount(0)
  await expect(simple.locator('.live-speech-bubble'))
    .toHaveCount(0)
  expect(await detailed
    .evaluateAll(nodes => nodes.every(node =>
      Number((node as HTMLElement).dataset.liveRoutePointCount) >= 4))).toBe(true)
  await page.clock.runFor(100)
  await page.evaluate(() => {
    const heldWindow = window as Window & {
      liveFootstepPlateMutations?: number
      liveFootstepPlateObserver?: MutationObserver
    }
    heldWindow.liveFootstepPlateMutations = 0
    heldWindow.liveFootstepPlateObserver = new MutationObserver(records => {
      heldWindow.liveFootstepPlateMutations! += records.length
    })
    heldWindow.liveFootstepPlateObserver.observe(document.querySelector('#live-plates')!, {
      childList: true,
      subtree: true,
    })
  })
  await page.clock.runFor(2_300)
  const visibleFootsteps = await page.locator('.live-footstep').evaluateAll(nodes =>
    nodes.filter(node => Number(getComputedStyle(node).opacity) > 0.05).length)
  expect(visibleFootsteps).toBeGreaterThanOrEqual(12)
  expect(visibleFootsteps).toBeLessThanOrEqual(18)
  const footstepPlateMutations = await page.evaluate(() => {
    const heldWindow = window as Window & {
      liveFootstepPlateMutations?: number
      liveFootstepPlateObserver?: MutationObserver
    }
    heldWindow.liveFootstepPlateObserver?.disconnect()
    return heldWindow.liveFootstepPlateMutations ?? 0
  })
  expect(footstepPlateMutations).toBe(0)

  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      try {
        sheet.insertRule(
          '.live-replay-portrait { animation-play-state: paused !important; }',
          sheet.cssRules.length,
        )
        return
      } catch {
        // Keep looking for a same-origin stylesheet whose rules are writable.
      }
    }
    throw new Error('no writable stylesheet could freeze replay animations')
  })
  await page.clock.runFor(32)

  const replayStagePoint = (handle: string) => page.locator(
    `.live-replay-portrait [data-live-resident-handle="${handle}"]`,
  ).evaluate(node => {
    const shell = node.closest('.live-replay-portrait') as HTMLElement
    const stage = node.closest('.live-stage') as HTMLElement
    const stageBox = stage.getBoundingClientRect()
    const shellBox = shell.getBoundingClientRect()
    const scale = stageBox.width / Number(stage.dataset.liveStageWidth)
    return {
      x: (shellBox.left + shellBox.width / 2 - stageBox.left) / scale,
      y: (shellBox.bottom - stageBox.top) / scale,
    }
  })

  const hovered = simple.locator('.live-portrait').first()
  const hoveredHandle = await hovered.getAttribute('data-live-resident-handle')
  const beforeHover = await replayStagePoint(hoveredHandle || '')
  await hovered.dispatchEvent('pointerover', { pointerType: 'mouse' })
  await page.clock.runFor(32)
  const afterHover = await replayStagePoint(hoveredHandle || '')
  expect(Math.hypot(afterHover.x - beforeHover.x, afterHover.y - beforeHover.y))
    .toBeLessThan(8)
  await expect(detailed).toHaveCount(7)
  await expect(replays).toHaveCount(7)
  await page.locator(
    `.live-replay-portrait [data-live-resident-handle="${hoveredHandle}"]`,
  ).dispatchEvent('pointerout', { pointerType: 'mouse' })
  await page.clock.runFor(32)
  await expect(detailed).toHaveCount(6)

  const focused = page.locator(
    `.live-replay-portrait [data-live-resident-handle="${hoveredHandle}"]`,
  )
  await focused.focus()
  await page.clock.runFor(32)
  await expect(detailed).toHaveCount(7)
  await page.locator('#live-viewport').focus()
  await page.clock.runFor(32)
  await expect(detailed).toHaveCount(6)
  const beforeFocus = await replayStagePoint(hoveredHandle || '')
  await focused.evaluate(node => (node as HTMLButtonElement).click())
  await page.clock.runFor(32)
  const afterFocus = await replayStagePoint(hoveredHandle || '')
  expect(Math.hypot(afterFocus.x - beforeFocus.x, afterFocus.y - beforeFocus.y))
    .toBeLessThan(8)
  await expect(detailed).toHaveCount(7)
  await expect(page.locator('.live-trail')).toHaveCount(0)

  await focused.focus()
  const viewport = page.locator('#live-viewport')
  await viewport.evaluate(node => {
    for (let index = 0; index < 80; index += 1) {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    }
  })
  await page.clock.runFor(32)
  await expect(replays).toHaveCount(0)
  await expect(viewport).toBeFocused()
  expect(await page.locator('#live-panel').evaluate(panel =>
    panel.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
  )).toBe(0)

  await viewport.evaluate(node => {
    for (let index = 0; index < 80; index += 1) {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    }
  })
  await page.clock.runFor(300)
  await expect(replays).toHaveCount(7)

  await page.getByRole('tab', { name: 'Map' }).click()
  await expect(page.locator('#live-panel')).toBeHidden()
  expect(await page.locator('#live-panel').evaluate(panel =>
    panel.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
  )).toBe(0)
})

test('eight legal change pages settle 1,600 actors without rebuilding crowd membership', async ({ page }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  const actorCount = 1_600
  const drawingPlaceCount = 215
  const detailedPlotCount = 217
  const placeRowCount = replayPlaces.length + drawingPlaceCount
  const residentRowBudget = actorCount * 16 + 10_000
  const anchorMembershipRowBudget = actorCount * 16 + 10_000
  const expectedPageCursors = [
    '10', '1200', '1400', '1600', '1800', '2000', '2200', '2400',
  ]
  const expectedTransientReplayKeys = Array.from(
    { length: actorCount }, (_, index) => `change:${1_001 + index}`,
  )
  const initiallyActiveActorCount = actorCount - 1
  const stableResidentPositions = async () => (await liveResidentLocalPositions(
    page.locator('.live-plot[data-place-id="3"]'),
  )).map(({ key, x, y }) => ({
    key,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
  }))
  const fixedPlotPositions = () => page.locator('.live-plot').evaluateAll(plots =>
    plots.map(plot => {
      const element = plot as HTMLElement
      return {
        id: element.dataset.placeId,
        x: element.dataset.livePlotX,
        y: element.dataset.livePlotY,
        width: element.dataset.livePlotWidth,
        height: element.dataset.livePlotHeight,
      }
    }))
  await page.clock.install({ time: new Date(now) })
  await installLiveRenderWorkRecorder(page)
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: actorCount,
    drawingPlaceCount,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  const stableResidentsBefore = await stableResidentPositions()
  const fixedPlotsBefore = await fixedPlotPositions()
  expect(fixedPlotsBefore).toHaveLength(detailedPlotCount)
  expect(stableResidentsBefore.length).toBeGreaterThan(0)
  expect(stableResidentsBefore.every(resident =>
    !resident.key.startsWith('walker-burst-'))).toBe(true)
  const harborPlot = page.locator('.live-plot[data-place-id="3"]')
  const harborClearance = () => harborPlot.evaluate(node => {
    const harbor = node.getBoundingClientRect()
    const camera = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return camera.left - harbor.right
  })
  const massViewport = page.locator('#live-viewport')
  await massViewport.focus()
  for (let attempt = 0; attempt < 48 && await harborClearance() < 64; attempt += 1) {
    await massViewport.press('ArrowRight')
  }
  const suppressedClearance = await harborClearance()
  expect(suppressedClearance).toBeGreaterThanOrEqual(64)
  expect(suppressedClearance).toBeLessThan(144)
  expect(await stableResidentPositions()).toEqual(stableResidentsBefore)
  await page.clock.pauseAt(new Date(now + 120_000))

  await resetLiveRenderWork(page)
  await page.evaluate(({ residentBudget, anchorBudget }) => {
    const heldWindow = window as Window & {
      __liveResidentRowBudget?: number
      __liveResidentRowBudgetExceededAt?: number | null
      __liveResidentAnchorRowBudget?: number
      __liveResidentAnchorRowBudgetExceededAt?: number | null
    }
    heldWindow.__liveResidentRowBudget = residentBudget
    heldWindow.__liveResidentRowBudgetExceededAt = null
    heldWindow.__liveResidentAnchorRowBudget = anchorBudget
    heldWindow.__liveResidentAnchorRowBudgetExceededAt = null
  }, { residentBudget: residentRowBudget, anchorBudget: anchorMembershipRowBudget })
  const changeCursorOffset = fixture.changeCursors().length
  await publishReplayChanges(page, fixture)
  await expect.poll(
    () => fixture.changeCursors().slice(
      changeCursorOffset,
      changeCursorOffset + expectedPageCursors.length,
    ),
    { timeout: 45_000 },
  ).toEqual(expectedPageCursors)
  expect(fixture.changeLimits().slice(
    changeCursorOffset,
    changeCursorOffset + expectedPageCursors.length,
  )).toEqual(
    expectedPageCursors.map(() => '200'),
  )
  expect(fixture.changeCursors().slice(
    changeCursorOffset + expectedPageCursors.length,
  ).every(cursor => cursor === '2600')).toBe(true)
  await settleLiveFakeClockAfterPublish(page)
  const replays = page.locator('.live-replay-portrait')
  type TransientReplay = Readonly<{
    key: string
    actor: string
    duration: number
    fromPlaceId: string
    toPlaceId: string
  }>
  let transientReplays: TransientReplay[] = []
  await expect.poll(async () => {
    transientReplays = await page.evaluate(() => [...((window as Window & {
      __liveReplayStarts?: TransientReplay[]
    }).__liveReplayStarts ?? [])])
    return transientReplays.length
  }, { timeout: 45_000 }).toBe(initiallyActiveActorCount)
  await expect(replays).toHaveCount(0)
  const stableResidentsDuring = await stableResidentPositions()
  const fixedPlotsDuring = await fixedPlotPositions()
  await page.clock.fastForward(2_000)
  await page.clock.runFor(20_000)
  await expect.poll(async () => {
    transientReplays = await page.evaluate(() => [...((window as Window & {
      __liveReplayStarts?: TransientReplay[]
    }).__liveReplayStarts ?? [])])
    return transientReplays.length
  }).toBe(actorCount)
  const transientReplayKeys = transientReplays.map(replay => replay.key)
  expect([...transientReplayKeys].sort((left, right) =>
    Number(left.slice(7)) - Number(right.slice(7)))).toEqual(expectedTransientReplayKeys)
  expect(transientReplays[0]).toMatchObject({
    key: 'change:1001',
    actor: 'walker-burst-1',
    fromPlaceId: '2',
    toPlaceId: '3',
  })
  expect(transientReplays[0]!.duration).toBeGreaterThanOrEqual(3_200)
  const transientReplayCount = transientReplayKeys.length
  await expect(page.locator('.live-trail')).toHaveCount(0)
  expect(await page.locator('.live-footstep').count()).toBeLessThanOrEqual(18)
  expect(transientReplays.filter(replay => replay.actor === 'walker-burst-1401')
    .map(({ key, actor, fromPlaceId, toPlaceId }) => ({
      key, actor, fromPlaceId, toPlaceId,
    })))
    .toEqual([{
      key: 'change:2400', actor: 'walker-burst-1401',
      fromPlaceId: '3', toPlaceId: '2',
    }, {
      key: 'change:2401', actor: 'walker-burst-1401',
      fromPlaceId: '2', toPlaceId: '3',
    }])
  await expect(replays).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('.live-trail')).toHaveCount(0)
  expect(await page.locator('.live-footstep').count()).toBeLessThanOrEqual(18)
  const stableResidentsAfter = await stableResidentPositions()
  const fixedPlotsAfter = await fixedPlotPositions()

  const rosterOutcomes = await page.locator('#live-roster .resident-row').evaluateAll(rows =>
    rows.flatMap(row => {
      const handle = row.querySelector<HTMLElement>('[data-live-resident-handle]')
        ?.dataset.liveResidentHandle
      return handle?.startsWith('walker-burst-')
        ? [{ handle, atHarbor: row.textContent?.includes('Harbor room') === true }]
        : []
    }))
  const rosterActorSet = new Set(rosterOutcomes.map(outcome => outcome.handle))
  const missingRosterActors = Array.from({ length: actorCount }, (_, index) =>
    `walker-burst-${index + 1}`).filter(actor => !rosterActorSet.has(actor))
  const wrongCurrentPlaces = rosterOutcomes
    .filter(outcome => !outcome.atHarbor)
    .map(outcome => outcome.handle)

  const work = await readLiveRenderWork(page)
  const exceeded = await page.evaluate(() => {
    const heldWindow = window as Window & {
      __liveResidentRowBudgetExceededAt?: number | null
      __liveResidentAnchorRowBudgetExceededAt?: number | null
    }
    return {
      residentRows: heldWindow.__liveResidentRowBudgetExceededAt ?? null,
      anchorMembershipRows: heldWindow.__liveResidentAnchorRowBudgetExceededAt ?? null,
    }
  })
  const crowdedLayoutBudget = work.renders * 2
  const anchorMembershipCheckBudget = actorCount * Math.max(2, work.renders * 2)
  const placeAnchorLookupBudget = work.renders * 2
  const placeAnchorPlaceRowBudget = placeRowCount * placeAnchorLookupBudget
  const placeAnchorChildRowBudget = detailedPlotCount * placeAnchorLookupBudget
  const placeAnchorResolutionBudget = work.renders * 32
  expect(work.largeResidentLayouts <= crowdedLayoutBudget &&
    work.residentRowsVisited <= residentRowBudget &&
    exceeded.residentRows === null &&
    work.replayCatchUpRecords === 0 &&
    transientReplayCount === actorCount &&
    work.residentAnchorMembershipChecks <= anchorMembershipCheckBudget &&
    work.residentAnchorMembershipRowsVisited <= anchorMembershipRowBudget &&
    exceeded.anchorMembershipRows === null &&
    work.placeAnchorLookupBuilds <= placeAnchorLookupBudget &&
    work.placeAnchorPlaceRowsVisited <= placeAnchorPlaceRowBudget &&
    work.placeAnchorMapRowsVisited <= placeAnchorPlaceRowBudget &&
    work.placeAnchorChildRowsVisited <= placeAnchorChildRowBudget &&
    work.placeAnchorResolutionSteps <= placeAnchorResolutionBudget &&
    stableResidentsDuring.length === stableResidentsBefore.length &&
    stableResidentsDuring.every((resident, index) =>
      JSON.stringify(resident) === JSON.stringify(stableResidentsBefore[index])) &&
    stableResidentsAfter.length === stableResidentsBefore.length &&
    stableResidentsAfter.every((resident, index) =>
      JSON.stringify(resident) === JSON.stringify(stableResidentsBefore[index])) &&
    JSON.stringify(fixedPlotsDuring) === JSON.stringify(fixedPlotsBefore) &&
    JSON.stringify(fixedPlotsAfter) === JSON.stringify(fixedPlotsBefore) &&
    rosterOutcomes.length === actorCount && missingRosterActors.length === 0 &&
    wrongCurrentPlaces.length === 0, JSON.stringify({
      renders: work.renders,
      largeResidentLayouts: work.largeResidentLayouts,
      crowdedLayoutBudget,
      residentRowsVisited: work.residentRowsVisited,
      residentRowBudget,
      residentRowBudgetExceededAt: exceeded.residentRows,
      replayCatchUpRecords: work.replayCatchUpRecords,
      residentAnchorMembershipChecks: work.residentAnchorMembershipChecks,
      anchorMembershipCheckBudget,
      residentAnchorMembershipRowsVisited: work.residentAnchorMembershipRowsVisited,
      anchorMembershipRowBudget,
      anchorMembershipRowBudgetExceededAt: exceeded.anchorMembershipRows,
      placeAnchorCalls: work.placeAnchorCalls,
      placeAnchorLookupBuilds: work.placeAnchorLookupBuilds,
      placeAnchorLookupBudget,
      placeAnchorPlaceRowsVisited: work.placeAnchorPlaceRowsVisited,
      placeAnchorMapRowsVisited: work.placeAnchorMapRowsVisited,
      placeAnchorPlaceRowBudget,
      placeAnchorChildRowsVisited: work.placeAnchorChildRowsVisited,
      placeAnchorChildRowBudget,
      placeAnchorResolutionSteps: work.placeAnchorResolutionSteps,
      placeAnchorResolutionBudget,
      transientReplayCount,
      transientReplayKeys: transientReplayKeys.slice(0, 3)
        .concat(['…'], transientReplayKeys.slice(-3)),
      stableResidentsBefore,
      stableResidentsDuring,
      stableResidentsAfter,
      rosterActorCount: rosterOutcomes.length,
      missingRosterActors: missingRosterActors.slice(0, 10),
      wrongCurrentPlaces: wrongCurrentPlaces.slice(0, 10),
    }, null, 2)).toBe(true)
})

test('a moving resident returning to readable ground receives a bounded label refresh', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: 64,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  const replays = page.locator('.live-replay-portrait')
  await expect.poll(() => replays.count()).toBeGreaterThan(0)
  await expect(replays).toHaveCount(64)
  await page.locator('#live-viewport').evaluate(async viewport => {
    const rect = viewport.getBoundingClientRect()
    for (let index = 0; index < 12; index += 1) {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        deltaY: -160,
      }))
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const returningReplay = replays.first()
  const returningHandle = await returningReplay.locator('[data-live-resident-handle]')
    .getAttribute('data-live-resident-handle')
  expect(returningHandle).not.toBeNull()
  await returningReplay.locator('[data-live-resident-handle]').evaluate(node => {
    ;(node as HTMLButtonElement).click()
  })
  await page.getByRole('button', { name: 'Center live view' }).click()
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Zoom in' }).click()
  }
  await page.clock.runFor(32)
  const focusedReplay = page.locator(
    `.live-replay-portrait:has([data-live-resident-handle="${returningHandle}"])`,
  )
  expect(await focusedReplay.evaluate(node => {
    const portrait = node.getBoundingClientRect()
    const viewport = document.querySelector('#live-label-layer')!.getBoundingClientRect()
    return portrait.right > viewport.left && portrait.left < viewport.right &&
      portrait.bottom > viewport.top && portrait.top < viewport.bottom
  })).toBe(true)

  await expect(page.locator(
    `#live-label-layer [data-live-resident-tag="${returningHandle}"]`,
  )).toBeVisible({ timeout: 750 })
})

test('turning on reduced motion mid-walk preserves the final fading footsteps', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await page.clock.pauseAt(new Date(now + 10_000))
  await publishReplayChanges(page, fixture)
  await settleLiveFakeClockAfterPublish(page)
  const replay = page.locator('.live-replay-portrait')
  await expect.poll(() => replay.count()).toBeGreaterThan(0)
  await expect(replay).toHaveCount(1)
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:11')

  await page.clock.runFor(2_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(100)
  await page.clock.runFor(32)
  await expect(page.locator('.live-replay-portrait[data-replay-duration]')).toHaveCount(0)
  expect(await page.locator('#live-panel').evaluate(panel =>
    panel.getAnimations({ subtree: true }).filter(animation =>
      animation.playState === 'running').length)).toBe(0)
  await expect.poll(() => page.locator('.live-footstep').count()).toBeGreaterThan(0)
  expect(await page.locator('.live-footstep').count()).toBeLessThanOrEqual(3)
  const remainingFootstepLifetime = await page.locator('.live-footstep').evaluateAll(nodes =>
    Math.max(...nodes.map(node =>
      Number((node as HTMLElement).dataset.liveAt) +
      Number((node as HTMLElement).dataset.liveLifetime) - Date.now())))
  expect(remainingFootstepLifetime).toBeGreaterThan(100)
  expect(remainingFootstepLifetime).toBeLessThanOrEqual(2_000)
  await expect(page.locator('.live-trail')).toHaveCount(0)
  await page.clock.runFor(remainingFootstepLifetime - 100)
  await expect.poll(() => page.locator('.live-footstep').count()).toBeGreaterThan(0)
  await page.clock.runFor(101)
  await expect(page.locator('.live-footstep')).toHaveCount(0)
})

test('the Live tab draws stored place sprites and keeps surveyed plots fixed through new places', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const worldDrawingRequests: string[] = []
  const changeCursors: Array<string | null> = []
  const eventWindows: Array<string | null> = []
  const snapshotMarkers: Array<string | null> = []
  const writes: string[] = []
  let moderationPublished = false
  let latestReadUnavailable = false
  page.on('request', request => {
    if (isWrite(request)) writes.push(request.method() + ' ' + request.url())
  })

  const places = [{ id: 1, parent_id: null, name: 'the world' },
    { id: 2, parent_id: 1, name: 'Cinder lane' },
    { id: 3, parent_id: 1, name: 'Harbor room' },
    { id: 4, parent_id: 2, name: 'Lantern nook' }]
  const residents = [{ id: 5, handle: 'map-walker', current_place_id: 3,
    joined_at: new Date(now - 86_400_000).toISOString(), asleep: false }]

  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      await route.fulfill({ json: {
        view: 'directory', places,
        residents: residents.map(({ id, handle }) => ({ id, handle })),
      } })
      return
    }
    snapshotMarkers.push(url.searchParams.get('after_change_marker'))
    await route.fulfill({ json: {
      view: 'outline',
      change_marker: url.searchParams.get('after_change_marker') ?? '10',
      places: [{
        id: 1, parent_id: null, name: 'the world', owner: null,
        purpose: '', front_matter: [], places: moderationPublished ? 3 : 2,
        things: 0, notes: 0, moderated: false,
        children: [{
          id: 2, parent_id: 1, name: 'Cinder lane', owner: 'cinder-owner',
          purpose: '', front_matter: [], places: 1, things: 1, notes: 1,
          moderated: false, children: [{
            id: 4, parent_id: 2, name: 'Lantern nook', owner: 'cinder-owner',
            purpose: '', front_matter: [], places: 0, things: 0, notes: 0,
            moderated: false, children: [],
          }],
        }, {
          id: 3, parent_id: 1, name: 'Harbor room', owner: 'harbor-owner',
          purpose: '', front_matter: [], places: 0, things: 0, notes: 0,
          moderated: false, children: [],
        }, ...(moderationPublished ? [{
          id: 5, parent_id: 1, name: 'New observatory', owner: 'new-owner',
          purpose: '', front_matter: [], places: 0, things: 0, notes: 0,
          moderated: false, children: [],
        }] : [])],
      }],
      residents,
      notes: [],
      things: [{
        id: 9, place_id: 2, name: 'field lantern', body: 'a steady mark',
        maker_id: 5, made_by: 'map-walker', current_owner_id: 5,
        current_owner: 'map-walker', owner: 'map-walker', open_to_use: true,
        kind: 'lantern', traits: [], created_at: new Date(now - 120_000).toISOString(),
        moderated: false, kind_moderated: false,
      }],
      agreements: [], events: [],
      totals: { places: moderationPublished ? 5 : 4, residents: 1, conversations: 0,
        things: 1, agreements: 0, events: 2 },
      pages: {
        places: { has_more: false }, residents: { has_more: false },
        notes: { has_more: false }, things: { has_more: false },
        agreements: { has_more: false }, events: { has_more: false },
      },
      refreshed_at: new Date(now).toISOString(),
    } })
  })

  await page.route('**/api/changes**', async route => {
    const url = new URL(route.request().url())
    const since = url.searchParams.get('since')
    changeCursors.push(since)
    if (latestReadUnavailable && since === '16') {
      await route.fulfill({ status: 503, json: { error: 'public changes unavailable' } })
      return
    }
    if (since === null) {
      await route.fulfill({ json: { change_marker: '10' } })
      return
    }
    if (since === '10') {
      await route.fulfill({ json: {
        change_marker: '13', unchanged: false, has_more: true, next_since: '11',
        changes: [{
          change_id: '11', created_at: new Date(now - 120_000).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
          },
        }],
      } })
      return
    }
    if (since === '11') {
      await route.fulfill({ json: {
        // A write lands while the client is paging. The first page's marker
        // remains the held boundary; #14 belongs to the next poll.
        change_marker: '16', unchanged: false, has_more: false, next_since: '16',
        changes: [{
          change_id: '12', created_at: new Date(now - 60_000).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
        }, {
          change_id: '13', created_at: new Date(now - 30_000).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'use', status: 'applied', place_id: 3, source_thing_id: 9,
          },
        }, {
          change_id: '14', created_at: new Date(now).toISOString(), kind: 'place_created',
          actor: 'new-owner', detail: { place_id: 5, parent_id: 1 },
        }],
      } })
      return
    }
    if (since === '13' && moderationPublished) {
      await route.fulfill({ json: {
        change_marker: '16', unchanged: false, has_more: false, next_since: '16',
        changes: [{
          change_id: '14', created_at: new Date(now).toISOString(), kind: 'place_created',
          actor: 'new-owner', detail: { place_id: 5, parent_id: 1 },
        }, {
          change_id: '15', created_at: new Date(now).toISOString(), kind: 'moderation',
          actor: 'founder', detail: { target_type: 'place', target_id: 2 },
        }, {
          change_id: '16', created_at: new Date(now).toISOString(), kind: 'moderation',
          actor: 'founder', detail: { target_type: 'note', target_id: 77 },
        }],
      } })
      return
    }
    await route.fulfill({ json: {
      change_marker: since || '13', unchanged: true, has_more: false,
      next_since: since || '13', changes: [],
    } })
  })
  await page.route('**/api/events**', async route => {
    eventWindows.push(new URL(route.request().url()).searchParams.get('within_seconds'))
    await route.fulfill({ json: {
      change_marker: '13', has_more: false, next_before_id: null,
      events: [{
        id: 103, change_id: '13', at: new Date(now - 30_000).toISOString(), kind: 'action',
        actor: 'map-walker', detail: {
          action: 'use', status: 'applied', place_id: 3, source_thing_id: 9,
        },
      }, {
        id: 102, change_id: '12', at: new Date(now - 60_000).toISOString(), kind: 'note',
        actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
      }, {
        id: 101, change_id: '11', at: new Date(now - 120_000).toISOString(), kind: 'action',
        actor: 'map-walker', detail: {
          action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
        },
      }, {
        id: 100, change_id: '10', at: new Date(now - 590_000).toISOString(), kind: 'note',
        actor: 'archive-walker', detail: { place_id: 2, note_id: 78 },
      }, {
        id: 99, change_id: '9', at: new Date(now - 600_000).toISOString(),
        kind: 'place_created', actor: 'cinder-owner',
        detail: { place_id: 2, parent_id: 1 },
      }],
    } })
  })
  await page.route('**/api/residents**', async route => {
    const url = new URL(route.request().url())
    await route.fulfill({ json: {
      change_marker: url.searchParams.get('after_change_marker') ?? '16',
      residents,
      total: residents.length,
      has_more: false,
      next_before_id: null,
    } })
  })
  await page.route('**/api/note/77', async route => {
    if (moderationPublished) {
      await route.fulfill({ status: 404, json: { error: 'note not found' } })
      return
    }
    await route.fulfill({ json: { note: { id: 77, body: 'A bell answers\nThe second line stays below.' } } })
  })
  await page.route('**/api/note/78', async route => {
    await route.fulfill({ json: { note: { id: 78, body: 'An older mark' } } })
  })
  await page.route('**/api/drawing/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/drawing/place/1') worldDrawingRequests.push(pathname)
    const match = /^\/api\/drawing\/(place|resident|thing)\/(\d+)$/u.exec(pathname)
    if (!match) {
      await route.fulfill({ status: 404, json: { error: 'drawing not found' } })
      return
    }
    const type = match[1]
    const id = Number(match[2])
    if (moderationPublished && type === 'place' && id === 2) {
      await route.fulfill({ status: 404, json: { error: 'drawing not found' } })
      return
    }
    const authored = (type === 'place' && (id === 1 || id === 2)) || type === 'thing'
    const drawing = authored
      ? { palette: ['#174d3c', '#f0c95f'], indices: Array.from({ length: 64 }, (_, index) => index % 2) }
      : null
    await route.fulfill({ json: {
      type,
      id,
      state: authored ? 'complete' : 'undrawn',
      presentation_state: authored ? 'complete' : 'undrawn',
      description: authored ? `Owner-authored ${type} drawing.` : null,
      drawing,
      rows: drawing
        ? Array.from({ length: 8 }, (_, row) => drawing.indices.slice(row * 8, (row + 1) * 8).join(' '))
        : null,
      source: authored ? type : 'none',
      kind_id: null,
      kind_name: null,
      revision: null,
      variant_name: null,
    } })
  })

  await page.goto('/window#view=map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('#live-alpha')).toBeHidden()
  await page.getByRole('tab', { name: 'Live' }).click()
  await expect(page.locator('#live-alpha')).toBeVisible()
  await expect(page.locator('#live-alpha')).toHaveText('ALPHA')
  await expect(page.locator('#live-alpha-note')).toContainText('if it disagrees with them, they are right')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-plate-title')).toHaveText('the world')
  await expect.poll(() => worldDrawingRequests.length).toBeGreaterThan(0)
  await page.clock.runFor(32)
  const captionClearOfViewport = await page.locator('#live-map-caption').evaluate(node => {
    const caption = node.getBoundingClientRect()
    const viewport = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return caption.bottom <= viewport.top + 1
  })
  expect(captionClearOfViewport).toBe(true)
  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator(
    '.live-replay-portrait, .live-trail, .live-footstep, .live-speech-bubble, ' +
    '.live-thing-specimen.live-pulse, [marker-end]',
  )).toHaveCount(0)
  await expect(page.locator('#live-ledger, .live-footnote-mark, .live-action-mark'))
    .toHaveCount(0)
  const worldDrawing = page.locator('.live-root-place-sprite .drawing-authored').first()
  await expect(worldDrawing).toBeVisible()
  await expect(page.locator('.live-root-place-sprite > .drawing-grid')).toHaveCount(1)
  await expect(page.locator('.live-world-ground > .drawing-grid')).toHaveCount(0)
  const worldPixels = await worldDrawing.evaluate(node => {
    const canvas = node as HTMLCanvasElement
    return {
      tag: canvas.tagName,
      width: canvas.width,
      height: canvas.height,
      first: [...canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data],
    }
  })
  expect(worldPixels).toEqual({
    tag: 'CANVAS',
    width: 8,
    height: 8,
    first: [23, 77, 60, 255],
  })
  const harbor = page.locator('.live-plot[data-place-id="3"]')
  await expect(harbor).toHaveAttribute('data-place-kind', 'continent')
  const harborMarker = harbor.locator('.live-plot-open > .live-neutral-marker')
  await expect(harborMarker).toBeVisible()
  await expect(harborMarker).toHaveAccessibleName(/Harbor room · Undrawn/u)
  const cinderOpen = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  const cinderSprite = cinderOpen.locator('.drawing-authored-shell')
  await expect(cinderSprite).toBeVisible()
  await expect(cinderSprite.locator('canvas.drawing-authored')).toHaveAttribute('width', '8')
  await expect(cinderSprite.locator('canvas.drawing-authored')).toHaveAttribute('height', '8')
  await expect(cinderSprite).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(cinderSprite).toHaveCSS('border-top-width', '0px')
  await expect(cinderOpen.locator('.live-plot-name')).not.toHaveCSS('text-shadow', 'none')
  await expect(page.locator(
    '.live-plot-owner, .drawing-state-label, .drawing-provenance, .drawing-undrawn-label',
  )).toHaveCount(0)
  await expect(cinderOpen).toHaveAttribute('aria-describedby', 'live-item-popover')
  await cinderOpen.focus()
  const popover = page.locator('#live-item-popover[data-live-item-popover="true"]')
  await expect(popover).toBeVisible()
  await expect(popover.locator('[data-live-popover-field="state"]')).toContainText('Complete')
  await expect(popover.locator('[data-live-popover-field="maker"]')).toContainText('cinder-owner')
  await expect(popover.locator('[data-live-popover-field="owner"]')).toContainText('cinder-owner')
  await expect(popover.locator('[data-live-popover-field="size"]')).toContainText('8 × 8 pixels')
  await expect(popover.locator('[data-live-popover-field="last-action"]'))
    .toContainText('map-walker moved')
  await expect(page.locator('.live-place-notes[data-live-notes-place-id="2"]'))
    .toHaveAttribute('data-live-notes-count', '1')
  expect(changeCursors.slice(0, 3)).toEqual([null, '10', '11'])
  expect(eventWindows).toEqual(['1800'])
  await expect.poll(() => snapshotMarkers).toContain('13')
  expect(worldDrawingRequests).toEqual(['/api/drawing/place/1'])

  const originalPlots = await page.locator('.live-plot').evaluateAll(plots => plots.map(plot => ({
    id: plot.getAttribute('data-place-id'),
    left: (plot as HTMLElement).style.left,
    top: (plot as HTMLElement).style.top,
    width: (plot as HTMLElement).style.width,
    height: (plot as HTMLElement).style.height,
  })))
  const stableOccupants = page.locator(
    '.live-plot[data-place-id="3"] .live-walker[data-live-item-key="resident:map-walker"], ' +
    '.live-plot[data-place-id="2"] .live-thing-specimen[data-live-item-key="thing:9"]',
  )
  await expect(stableOccupants).toHaveCount(2)
  const originalOccupants = await stableOccupants.evaluateAll(nodes => nodes.map(node => ({
    key: (node as HTMLElement).dataset.liveItemKey,
    left: (node as HTMLElement).style.left,
    top: (node as HTMLElement).style.top,
  })).sort((left, right) => String(left.key).localeCompare(String(right.key))))
  await page.locator('#live-viewport').focus()
  await expect(popover).toBeHidden()
  await page.clock.fastForward(6_000)
  await expect(page.locator(
    '.live-replay-portrait, .live-trail, .live-footstep, .live-speech-bubble',
  )).toHaveCount(0)

  moderationPublished = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(cinderOpen.locator('.drawing-authored-shell')).toHaveCount(0)
  const unavailableCinder = cinderOpen.locator('.drawing-unavailable.live-neutral-marker')
  await expect(unavailableCinder).toBeVisible()
  await expect(unavailableCinder).toHaveAccessibleName('Cinder lane drawing could not be read')
  await expect(page.locator('#live-ledger, .live-speech-bubble')).toHaveCount(0)
  await expect(page.locator('#live-plates .live-plot')).toHaveCount(3)
  await expect(page.locator('#live-plates')).toContainText('New observatory')
  const expandedPlots = await page.locator('.live-plot').evaluateAll(plots => plots.map(plot => ({
    id: plot.getAttribute('data-place-id'),
    left: (plot as HTMLElement).style.left,
    top: (plot as HTMLElement).style.top,
    width: (plot as HTMLElement).style.width,
    height: (plot as HTMLElement).style.height,
  })))
  expect(expandedPlots.filter(plot => plot.id !== '5')).toEqual(originalPlots)
  await expect(stableOccupants).toHaveCount(2)
  expect(await stableOccupants.evaluateAll(nodes => nodes.map(node => ({
    key: (node as HTMLElement).dataset.liveItemKey,
    left: (node as HTMLElement).style.left,
    top: (node as HTMLElement).style.top,
  })).sort((left, right) => String(left.key).localeCompare(String(right.key))))).toEqual(
    originalOccupants,
  )

  latestReadUnavailable = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const latestReadRetry = page.getByRole('button', { name: 'Retry the latest read' })
  await expect(latestReadRetry).toBeVisible()
  latestReadUnavailable = false
  await latestReadRetry.click()
  await expect(latestReadRetry).toHaveCount(0)
  await expect(page.locator('#live-history-status')).not.toContainText(
    'The latest change pages could not be completed',
  )

  await page.setViewportSize({ width: 700, height: 900 })
  const resizedDetailBudget = await page.locator('.live-plot').evaluateAll(plots => ({
    detailedPlots: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetail === 'true').length,
    mountedPlots: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetailMounted === 'true').length,
    allDistantUnmounted: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetail === 'false').every(plot =>
      (plot as HTMLElement).dataset.liveDetailMounted === 'false'),
    distantDetailNodes: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetail === 'false').reduce((count, plot) =>
      count + plot.querySelectorAll('.live-portrait-grid, .live-thing-shelf').length, 0),
  }))
  expect(resizedDetailBudget.detailedPlots).toBeGreaterThan(0)
  expect(resizedDetailBudget.detailedPlots).toBeLessThanOrEqual(3)
  expect(resizedDetailBudget.mountedPlots).toBe(resizedDetailBudget.detailedPlots)
  expect(resizedDetailBudget.allDistantUnmounted).toBe(true)
  expect(resizedDetailBudget.distantDetailNodes).toBe(0)
  const stackedGeometry = await page.locator('.live-layout').evaluate(layout => {
    const stage = layout.querySelector('.live-stage-shell')?.getBoundingClientRect()
    const roster = layout.querySelector('.live-roster-board')?.getBoundingClientRect()
    return stage && roster
      ? { stageBottom: stage.bottom, rosterTop: roster.top }
      : null
  })
  expect(stackedGeometry).not.toBeNull()
  expect(stackedGeometry!.rosterTop).toBeGreaterThanOrEqual(stackedGeometry!.stageBottom - 1)

  await page.setViewportSize({ width: 320, height: 720 })
  const narrowStage = page.locator('#live-stage')
  const naturalStageHeight = await narrowStage.evaluate(stage => ({
    style: (stage as HTMLElement).style.getPropertyValue('--live-stage-height'),
    data: (stage as HTMLElement).dataset.liveStageHeight ?? '',
  }))
  await narrowStage.evaluate(stage => {
    ;(stage as HTMLElement).style.setProperty('--live-stage-height', '20000px')
    ;(stage as HTMLElement).dataset.liveStageHeight = '20000'
  })
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Center live view' })).toBeVisible()
  await expect(page.getByRole('button', { name: /fit/i })).toHaveCount(0)
  const narrowViewport = page.locator('#live-viewport')
  const readNarrowScale = async () => Number(await narrowStage.getAttribute('data-live-scale'))
  const minimumReadableScale = 0.8
  for (let index = 0; index < 24; index += 1) {
    await page.getByRole('button', { name: 'Zoom out' }).click()
  }
  expect(await readNarrowScale()).toBeGreaterThanOrEqual(minimumReadableScale)
  await narrowViewport.dispatchEvent('wheel', { clientX: 160, clientY: 240, deltaY: 240 })
  expect(await readNarrowScale()).toBeGreaterThanOrEqual(minimumReadableScale)

  await narrowViewport.focus()
  await narrowViewport.press('-')
  expect(await readNarrowScale()).toBeGreaterThanOrEqual(minimumReadableScale)

  await narrowViewport.dispatchEvent('pointerdown', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 80, clientY: 240,
  })
  await narrowViewport.dispatchEvent('pointerdown', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 240, clientY: 240,
  })
  await narrowViewport.dispatchEvent('pointermove', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 200, clientY: 240,
  })
  expect(await readNarrowScale()).toBeGreaterThanOrEqual(minimumReadableScale)
  await narrowViewport.dispatchEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 80, clientY: 240,
  })
  await narrowViewport.dispatchEvent('pointerup', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 200, clientY: 240,
  })
  await page.getByRole('button', { name: 'Center live view' }).click()
  expect(await readNarrowScale()).toBeGreaterThanOrEqual(minimumReadableScale)
  const centeredWorld = await narrowStage.evaluate(stage => {
    const world = stage.getBoundingClientRect()
    const viewport = stage.closest('#live-viewport')!.getBoundingClientRect()
    return world.width > viewport.width * 1.5 || world.height > viewport.height * 1.5
  })
  expect(centeredWorld).toBe(true)
  await expect(page.locator('.live-plot[data-live-detail="true"]')).not.toHaveCount(0)
  await expect(page.locator('.live-plot[data-live-detail="false"]')).not.toHaveCount(0)

  await expect(page.locator('.live-plot-owner')).toHaveCount(0)
  await narrowStage.evaluate((stage, naturalHeight) => {
    const liveStage = stage as HTMLElement
    if (naturalHeight.style) {
      liveStage.style.setProperty('--live-stage-height', naturalHeight.style)
    } else {
      liveStage.style.removeProperty('--live-stage-height')
    }
    if (naturalHeight.data) {
      liveStage.dataset.liveStageHeight = naturalHeight.data
    } else {
      delete liveStage.dataset.liveStageHeight
    }
  }, naturalStageHeight)
  await page.getByRole('button', { name: 'Center live view' }).click()
  await panLiveTargetIntoView(page, cinderOpen)
  await cinderOpen.click()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(page.locator('.live-breadcrumb[aria-current="location"]')).toHaveText('Cinder lane')
  const thingSpecimen = page.locator('.live-thing-specimen')
  await expect(thingSpecimen).toContainText('field lantern')
  await thingSpecimen.focus()
  await page.setViewportSize({ width: 701, height: 900 })
  await expect(thingSpecimen).toBeFocused()
  expect(writes).toEqual([])
})

test('a focused sprite popover refreshes when its delayed drawing read settles', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, { drawingDelayMs: 400 })
  await page.goto('/window#view=live')
  const cinderOpen = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  await cinderOpen.focus()
  await expect(cinderOpen).toBeFocused()
  const popover = page.locator('#live-item-popover[data-live-item-popover="true"]')
  const drawingState = popover.locator('[data-live-popover-field="state"]')
  await expect(drawingState).toContainText('Reading drawing record')
  await expect(drawingState).toContainText('Undrawn')
  await expect(cinderOpen).toBeFocused()
})
