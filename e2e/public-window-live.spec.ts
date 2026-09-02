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
    ] as const) {
      const pattern = new RegExp(`function ${functionName}\\([^)]*\\) \\{`, 'u')
      const matches = body.match(new RegExp(pattern.source, 'gu')) ?? []
      if (matches.length !== 1) {
        throw new Error(`expected one ${functionName} function in the served Live client`)
      }
      body = body.replace(pattern, match => `${match}\n` +
        `    window.__liveRenderWork.${counter} += 1`)
    }
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
    const replayCatchUpBranch = '    if (!animates) {'
    if (body.split(replayCatchUpBranch).length !== 2) {
      throw new Error('expected one replay catch-up branch in the served Live client')
    }
    body = body.replace(
      replayCatchUpBranch,
      '    window.__liveRenderWork.replayCatchUpRecords += caughtUpAdditions.length\n' +
      replayCatchUpBranch,
    )
    const replayStartPattern = /^(\s*)starts\.push\(Object\.freeze\(\{ actor, key, duration \}\)\)$/gmu
    if ((body.match(replayStartPattern) ?? []).length !== 2) {
      throw new Error('expected two replay start recordings in the served Live client')
    }
    body = body.replace(replayStartPattern, (match, indent: string) =>
      match + '\n' +
      indent + 'window.__liveReplayStarts.push(Object.freeze({\n' +
      indent + '  key, actor,\n' +
      indent + "  fromPlaceId: String(active[actor]?.fromPlaceId || ''),\n" +
      indent + "  toPlaceId: String(active[actor]?.toPlaceId || ''),\n" +
      indent + '}))')
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
      (plot as HTMLElement).dataset.liveDetailMounted === 'true' &&
      Boolean(plot.querySelector('.live-plot-terrain')))
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
      viewport.boundingBox(),
      target.boundingBox(),
    ])
    if (!viewportBox || !targetBox) throw new Error('live camera target has no geometry')
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

async function expectProofDrawingContract(page: Page): Promise<void> {
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
    { type: 'thing', id: 9401 },
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
  await expect(proof.locator('.drawing-canonical-rows, .drawing-history')).toHaveCount(0)
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

function replayThingRows(now: number, placeId: number) {
  return replayThings.map(thing => ({
    ...thing, place_id: thing.id === 9 ? 4 : placeId, body: 'a steady mark',
    maker_id: 5, made_by: 'map-walker', current_owner_id: 5,
    current_owner: 'map-walker', owner: 'map-walker', open_to_use: true,
    kind: 'lantern', traits: [], created_at: new Date(now - 120_000).toISOString(),
    moderated: false, kind_moderated: false,
    has_drawing: true,
  }))
}

function replaySnapshot(now: number, published: boolean, marker: string) {
  const residentPlaceId = published ? 4 : 2
  const thingPlaceId = published ? 3 : 2
  const residents = replayResidentRows(now, residentPlaceId)
  const things = replayThingRows(now, thingPlaceId)
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
    drawingDelayMs?: number
    drawingPlaceCount?: number
    drawingParentId?: number
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
  }> = {},
) {
  let published = false
  let thingPageRequests = 0
  let residentPageRequests = 0
  let openingEventRequests = 0
  let windowRequests = 0
  let changeRequests = 0
  const changeCursors: Array<string | null> = []
  const changeLimits: Array<string | null> = []
  let thingNamesUnavailable = Boolean(controls.thingFailure)
  const openingBeforeIds: Array<string | null> = []
  const thingWithinPlaceIds: Array<string | null> = []
  const thingLimits: Array<string | null> = []
  let activeNoteRequests = 0
  let maximumNoteRequests = 0
  let activeDrawingRequests = 0
  let maximumDrawingRequests = 0
  let drawingRequests = 0
  let thumbnailRequests = 0
  let focusedPlaceRequests = 0
  let focusedPlaceFailuresRemaining = controls.focusedPlaceFailures ?? 0
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
  const currentMarker = () => published
    ? controls.simultaneousMoves
      ? String(1_000 + controls.simultaneousMoves)
      : controls.secondArrival ? '17' : '16'
    : '10'
  const controlledResidentRows = (marker: string) => {
    const baseRows = replayResidentRows(
      now,
      marker === '10'
        ? controls.initialResidentPlaceId ?? (controls.openingMovement ? 3 : 2)
        : 4,
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
      const things = replayThingRows(now, placeId)
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
    const ordinarySnapshot = replaySnapshot(now, marker !== '10', marker)
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
        ...(place.id === (controls.drawingParentId ?? 1) ? drawingRows : []),
      ],
    })
    const baseSnapshot = drawingPlaces.length
      ? {
          ...ordinarySnapshot,
          places: ordinarySnapshot.places.map(appendDrawingPlaces),
          totals: {
            ...ordinarySnapshot.totals,
            places: ordinarySnapshot.totals.places + drawingPlaces.length,
          },
          live_survey: [
            ...ordinarySnapshot.live_survey,
            ...drawingPlaces.map(place => ({ ...place, things: 0 })),
          ],
        }
      : ordinarySnapshot
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
              created_at: new Date(now).toISOString(),
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
    if (since === '10' && published) {
      const publishedMarker = currentMarker()
      const publishedChanges = [{
            change_id: '11', created_at: new Date(now - (
              controls.staggeredArrivalDeadlines ? 1_792_300 : 0
            )).toISOString(), kind: 'action',
            actor: 'map-walker', detail: {
              action: 'move', status: 'applied', from_place_id: 2, to_place_id: 4,
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
          'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
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
    changeRequests: () => changeRequests,
    changeCursors: () => [...changeCursors],
    changeLimits: () => [...changeLimits],
    activeNoteRequests: () => activeNoteRequests,
    maximumNoteRequests: () => maximumNoteRequests,
    activeDrawingRequests: () => activeDrawingRequests,
    maximumDrawingRequests: () => maximumDrawingRequests,
    drawingRequests: () => drawingRequests,
    drawingRequestPaths: () => [...drawingRequestPaths],
    thumbnailRequests: () => thumbnailRequests,
    thumbnailRequestPaths: () => [...thumbnailRequestPaths],
    focusedPlaceRequests: () => focusedPlaceRequests,
    holdNextEmptyChange: () => {
      heldEmptyChangeGate = new Promise<void>(resolve => {
        releaseHeldEmptyChange = resolve
      })
    },
    heldEmptyChangeRequests: () => heldEmptyChangeRequests,
    releaseHeldEmptyChange: () => releaseHeldEmptyChange(),
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
  fixture.publish()
  await expect.poll(async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    return fixture.changeRequests()
  }).toBeGreaterThan(requestsBeforePublish)
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
  await expect(target).toBeVisible()
  await target.scrollIntoViewIfNeeded()
  const result = await target.evaluate(node => {
    const box = node.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    const hitElement = hit as HTMLElement | null
    return {
      exposed: hit === node || Boolean(hit && node.contains(hit)),
      targetBox: {
        left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      },
      hit: hitElement?.className || hitElement?.tagName || null,
    }
  })
  expect(result.exposed, JSON.stringify(result)).toBe(true)
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
    const cinderDrawing = page.getByRole('button', {
      name: 'Open current drawing for Cinder lane',
    }).first()
    await panLiveTargetIntoView(page, mapWalker)
    await expectControlsDoNotOverlap(cinderDrawing, mapWalker)
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
  const harborDrawing = plot.getByRole('button', {
    name: 'Open current drawing for Harbor room',
  })
  await panLiveTargetIntoView(page, thing)
  await expectControlsDoNotOverlap(harborDrawing, thing)
  await thing.hover()
  await expect(thing).toHaveCSS('z-index', '45')
  await page.locator('#live-viewport').focus()
  await thing.focus()
  await expect(thing).toHaveCSS('z-index', '45')

  await panLiveTargetIntoView(page, harborDrawing)
  await harborDrawing.click()
  const detail = page.locator('#record-detail')
  await expect(detail.locator('#record-detail-title')).toHaveText('Harbor room')
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(detail).toBeHidden()
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
  await expect(residentTag).toHaveAttribute('data-live-raised', 'true')
  await expect.poll(async () => residentTag.evaluate(tag => {
    const own = Number(getComputedStyle(tag).zIndex)
    const peers = [...tag.parentElement!.querySelectorAll<HTMLElement>('.live-resident-tag')]
      .filter(peer => peer !== tag)
      .map(peer => Number(getComputedStyle(peer).zIndex))
    return own > Math.max(0, ...peers)
  })).toBe(true)
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')

  await touch(resident)
  await expect(page.locator('#live-focus-status')).toContainText('Focused on harbor-1')

  const thing = page.locator('[data-live-thing-id="9"]').first()
  await thing.evaluate(node => node.addEventListener('click', event => {
    ;(node as HTMLElement).dataset.testDefaultPrevented = String(event.defaultPrevented)
    event.preventDefault()
  }))
  await touch(thing)
  await expect(thing).toHaveAttribute('data-live-raised', 'true')
  await expect(thing).toHaveAttribute('data-test-default-prevented', 'true')
  await touch(thing)
  await expect(thing).toHaveAttribute('data-test-default-prevented', 'false')
  await expect(thing).toHaveAttribute('href', '/api/thing/9')

  const plot = page.locator('.live-plot[data-place-id="2"]')
  const open = plot.locator('.live-plot-open')
  const urlBeforeFirstPlaceTap = page.url()
  await touch(open)
  await expect(plot).toHaveAttribute('data-live-raised', 'true')
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
    mountedDetailNodes: plots.reduce((count, plot) => count + plot.querySelectorAll(
      '.live-plot-terrain, .live-plot-owner, .live-portrait-grid, .live-thing-shelf',
    ).length, 0),
  }))
  expect(retainedBudget.detailedPlots).toBeLessThanOrEqual(21)
  expect(retainedBudget.mountedDetailNodes).toBeLessThanOrEqual(
    retainedBudget.detailedPlots * 4,
  )

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
  await expect(harbor.locator(
    '.live-plot-terrain, .live-plot-owner, .live-portrait-grid, .live-thing-shelf',
  )).toHaveCount(0)
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

test('Live expands 167 residents with one bounded layout pass and no new public reads', async ({ page }) => {
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
    residentLayouts: 10,
    largeResidentLayouts: 1,
    residentRowsVisited: 188,
    residentAnchorMembershipChecks: 8,
    residentAnchorMembershipRowsVisited: 168,
    placeAnchorCalls: 38,
    placeAnchorLookupBuilds: 1,
    placeAnchorPlaceRowsVisited: 4,
    placeAnchorMapRowsVisited: 4,
    placeAnchorChildRowsVisited: 2,
    placeAnchorResolutionSteps: 2,
    replayCatchUpRecords: 0,
    residentReplayPoints: 28,
    moveGeometries: 20,
    thingPresentations: 3,
    plotBuilds: 2,
    rosterRenders: 1,
  })
  const focusedExpansionWork = Object.freeze({
    renders: 1,
    stageSurveys: 1,
    residentLayouts: 2,
    largeResidentLayouts: 1,
    residentRowsVisited: 173,
    residentAnchorMembershipChecks: 1,
    residentAnchorMembershipRowsVisited: 167,
    placeAnchorCalls: 31,
    placeAnchorLookupBuilds: 1,
    placeAnchorPlaceRowsVisited: 4,
    placeAnchorMapRowsVisited: 4,
    placeAnchorChildRowsVisited: 0,
    placeAnchorResolutionSteps: 2,
    replayCatchUpRecords: 0,
    residentReplayPoints: 21,
    moveGeometries: 20,
    thingPresentations: 1,
    plotBuilds: 0,
    rosterRenders: 1,
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
  await resetLiveRenderWork(page)
  await childMore.click()
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
  await resetLiveRenderWork(page)
  await rootMore.click()
  const rootResidentWork = await readLiveRenderWork(page)
  await expect(page.locator('.live-root-walkers .live-walker')).toHaveCount(167)
  await expect(page.locator('.live-root-walkers .live-resident-more')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(readCounts()).toEqual(rootReadsBefore)
  expect(rootResidentWork).toEqual(focusedExpansionWork)

  const residentsBeforeThingExpansion = (await liveResidentPositions(
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
  const rootThingWork = await readLiveRenderWork(page)
  await expect(page.locator('.live-root-thing-shelf .live-thing-specimen')).toHaveCount(7)
  await expect(page.locator('.live-root-thing-shelf .live-thing-more')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await liveResidentPositions(page.locator('.live-root-walkers')))
    .map(({ key, x, y }) => ({
      key,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
    }))).toEqual(residentsBeforeThingExpansion)
  expect(readCounts()).toEqual(thingReadsBefore)
  expect(rootThingWork).toEqual(focusedExpansionWork)
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
  const drawingDetail = cinder.getByRole('button', {
    name: 'Open current drawing for Cinder lane',
  })
  const residentMore = cinder.locator('.live-resident-more')
  const thingMore = cinder.locator('.live-thing-more')
  await expect(drawingDetail).toBeVisible()
  await expect(residentMore).toBeVisible()
  await expect(thingMore).toBeVisible()
  await expectControlsDoNotOverlap(drawingDetail, residentMore)
  await expectControlsDoNotOverlap(drawingDetail, thingMore)
  await expectControlsDoNotOverlap(residentMore, thingMore)
  expect(await drawingDetail.evaluate((button, plot) => {
    const buttonBox = button.getBoundingClientRect()
    const plotBox = (plot as Element).getBoundingClientRect()
    return buttonBox.top >= plotBox.bottom
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
    mountedDetailNodes: plots.reduce((count, plot) => count + plot.querySelectorAll(
      '.live-plot-terrain, .live-plot-owner, .live-portrait-grid, .live-thing-shelf',
    ).length, 0),
  }))
  expect(crowdedDetailBudget.detailedPlots).toBeLessThanOrEqual(2)
  expect(crowdedDetailBudget.mountedDetailNodes).toBeLessThanOrEqual(
    crowdedDetailBudget.detailedPlots * 4,
  )

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
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    openingPaging: 'long',
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-history-status')).toContainText(
    'Automatic recent-history reading pauses after 1,600 public events',
  )
  await expect(page.getByRole('button', { name: 'Continue recent history' })).toBeVisible()
  await expect.poll(fixture.openingEventRequests).toBe(8)
  await page.getByRole('button', { name: 'Continue recent history' }).click()
  await expect.poll(fixture.openingEventRequests).toBe(9)
  expect(fixture.openingBeforeIds().at(-1)).toBe('893')
  await expect(page.locator('#live-history-status')).toContainText(
    'Recent history is complete through the 30-minute trace edge',
  )
})

test('Live paints opening history as residue without replaying stale backlog', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    openingMovement: true,
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-trail')).toHaveCount(1)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
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
  await expect(page.locator('#live-ledger')).toContainText('moved: Cinder lane → Lantern nook')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
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
  await expect(page.locator('#live-ledger')).toContainText('moved: Cinder lane → Lantern nook')
  await page.waitForTimeout(300)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
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
  await expect(page.locator('#live-ledger')).toContainText('moved: Cinder lane → Lantern nook')
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
  await expect(page.locator('#live-ledger')).toContainText('moved: Cinder lane → Lantern nook')

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

test('Live bounds concurrent note detail reads during a visible burst', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 8)
  await page.goto('/window#view=live')

  await expect(page.locator('#live-ledger')).toContainText('note #1000')
  await expect.poll(fixture.activeNoteRequests).toBe(0)
  expect(fixture.maximumNoteRequests()).toBeGreaterThan(0)
  expect(fixture.maximumNoteRequests()).toBeLessThanOrEqual(4)
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

test('Live renders nearby detail and reachable distant markers without drawing the whole world', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingDelayMs: 20,
    drawingPlaceCount: 80,
  })
  await page.goto('/window#view=live')

  await expect.poll(fixture.maximumDrawingRequests).toBeGreaterThan(0)
  await expect.poll(() => page.locator(
    '.live-plot[data-live-detail="true"] .drawing-loading, ' +
    '.live-world-ground .drawing-loading, .live-root-walkers .drawing-loading, ' +
    '.live-root-thing-shelf .drawing-loading',
  ).count(), { timeout: 15_000 }).toBe(0)
  await expect.poll(fixture.activeDrawingRequests).toBe(0)
  await expect(page.locator('.live-plot[data-live-detail="true"]')).not.toHaveCount(0)
  const distantPlots = page.locator('.live-plot[data-live-detail="false"]')
  await expect(distantPlots).not.toHaveCount(0)
  await expect(distantPlots.locator(
    '.live-plot-terrain, .live-plot-owner, .live-portrait-grid, .live-thing-shelf',
  )).toHaveCount(0)
  const initialDetailBudget = await page.locator('.live-plot').evaluateAll(plots => ({
    detailedPlots: plots.filter(plot => (plot as HTMLElement).dataset.liveDetail === 'true').length,
    mountedTerrain: plots.filter(plot => plot.querySelector('.live-plot-terrain')).length,
    mountedDetailNodes: plots.reduce((count, plot) => count + plot.querySelectorAll(
      '.live-plot-terrain, .live-plot-owner, .live-portrait-grid, .live-thing-shelf',
    ).length, 0),
  }))
  expect(initialDetailBudget.mountedTerrain).toBe(initialDetailBudget.detailedPlots)
  expect(initialDetailBudget.detailedPlots).toBeLessThanOrEqual(20)
  expect(initialDetailBudget.mountedDetailNodes).toBeLessThanOrEqual(
    initialDetailBudget.detailedPlots * 4,
  )
  expect(fixture.drawingRequests()).toBeGreaterThan(0)
  expect(fixture.drawingRequests()).toBeLessThan(80)
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
  await expect(markerPlot.locator('.live-plot-terrain')).toHaveCount(1)
  await expect(page.locator('.live-plot[data-live-detail="false"]').locator(
    '.live-plot-terrain, .live-plot-owner, .live-portrait-grid, .live-thing-shelf',
  )).toHaveCount(0)
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
  const now = Date.now()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.clock.install({ time: new Date(now) })
  await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  const proofButton = page.getByRole('button', { name: 'Run preview proof scene' })
  await expect(proofButton).toBeVisible()
  await proofButton.click()
  const proofPanel = page.locator('#live-panel[data-live-proof="true"]')
  await expect(proofPanel).toBeVisible()
  await expectProofDrawingContract(page)

  const retry = page.getByRole('button', { name: 'Retry proof room' })
  await expect(retry).toBeVisible()
  await expectTargetCenterExposed(retry)
  await retry.click()
  await expect(retry).toHaveCount(0)

  const residentMore = proofPanel.getByRole('button', { name: /Show .* more residents/u })
  const thingMore = proofPanel.getByRole('button', { name: /Show .* more things/u })
  await expect(residentMore).toBeVisible()
  await expect(thingMore).toBeVisible()
  await expectTargetCenterExposed(residentMore)
  await expectTargetCenterExposed(thingMore)
  await residentMore.click()
  await thingMore.click()
  await expect(proofPanel.getByRole('dialog')).toHaveCount(0)
  await expect(proofPanel.locator('.live-walker')).toHaveCount(7)
  await expect(proofPanel.locator('.live-thing-specimen')).toHaveCount(7)

  const replays = proofPanel.locator('.live-replay-portrait')
  let concurrentReplayKeys: Array<string | undefined> = []
  await expect.poll(async () => {
    concurrentReplayKeys = await replays.evaluateAll(nodes => nodes.map(node =>
      (node as HTMLElement).dataset.liveReplayKey))
    return new Set(concurrentReplayKeys).size
  }).toBe(2)

  let sawSpeech = false
  let sawUse = false
  for (let elapsed = 0; elapsed < 24_000; elapsed += 500) {
    await page.clock.runFor(500)
    sawSpeech ||= await page.locator('.live-speech-bubble').count() > 0
    sawUse ||= await page.locator('.live-thing-specimen.live-pulse').count() > 0
  }
  expect(sawSpeech).toBe(true)
  expect(sawUse).toBe(true)
  await expect(replays).toHaveCount(0)

  await proofButton.click()
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
  await expectProofDrawingContract(page)
  await expect(proofPanel.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(proofPanel.locator('.live-walker')).not.toHaveCount(0)
  await expect(proofPanel.locator('.live-thing-specimen')).not.toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry proof room' })).toBeVisible()
  await expect(proofPanel.locator('#live-ledger')).toContainText(/moved|spoke|used/u)
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

test('Live opens place and resident current drawings from secondary affordances without eager history reads', async ({ page }) => {
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
  const rootCaptionDrawing = page.getByRole('button', { name: 'Open current drawing for the world' })
  await expect(rootCaptionDrawing).toBeVisible()
  await rootCaptionDrawing.scrollIntoViewIfNeeded()
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

  const cinderPlotDrawing = page.getByRole('button', { name: 'Open current drawing for Cinder lane' }).first()
  await panLiveTargetIntoView(page, cinderPlotDrawing)
  await expect(cinderPlotDrawing).toBeVisible()
  await expect(cinderPlotDrawing).toBeInViewport()
  expect((await cinderPlotDrawing.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await cinderPlotDrawing.click()
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live$/u)
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
  await expect(page).toHaveURL(/\/window\/live$/u)

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const cinderOpen = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  await panLiveTargetIntoView(page, cinderOpen)
  await cinderOpen.click()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(page.locator('.live-plate-title')).toHaveText('Cinder lane')
  const leafCaptionDrawing = page.locator('#live-map-caption')
    .getByRole('button', { name: 'Open current drawing for Cinder lane' })
  await expect(leafCaptionDrawing).toBeVisible()
  await leafCaptionDrawing.scrollIntoViewIfNeeded()
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
  await outsideFocus.getByRole('button', { name: 'Open current drawing for map-walker' }).click()
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(detail.locator('#record-detail-kind')).toHaveText('Public resident · live current drawing')
  await expect(detail.locator('#record-detail-title')).toHaveText('map-walker')
  await expect(detail.locator('[data-share-scope="detail"]')).toBeHidden()
  await expect(detail.locator('.record-detail-meta')).toContainText('resident #5')
  await expect(detail.locator('.error-row')).toContainText('The current drawing could not be read.')
  expect(residentCurrentPaths).toHaveLength(residentReadsBeforeOpen + 1)
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
  expect(residentCurrentPaths).toHaveLength(residentReadsBeforeOpen + 2)
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

test('new change rows replay once in recorded order and leave truthful residue', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await publishReplayChanges(page, fixture)
  const replay = page.locator('.live-replay-portrait')
  await expect(replay).toHaveCount(1)
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:11')
  const duration = Number(await replay.getAttribute('data-replay-duration'))
  expect(duration).toBeGreaterThanOrEqual(3_200)
  expect(duration).toBeLessThanOrEqual(8_000)
  const trail = page.locator('.live-trail')
  await expect(trail).toHaveCount(1)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await replay.locator('.live-portrait').evaluate(node => (node as HTMLButtonElement).click())
  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
  await expect(page.locator('#live-label-layer [data-live-resident-tag="map-walker"]'))
    .toBeVisible()
  await page.evaluate(() => {
    const trackedWindow = window as Window & { liveLabelChildMutations?: number }
    trackedWindow.liveLabelChildMutations = 0
    new MutationObserver(records => {
      trackedWindow.liveLabelChildMutations = Number(trackedWindow.liveLabelChildMutations) +
        records.filter(record => record.type === 'childList').length
    }).observe(document.querySelector('#live-label-layer')!, { childList: true })
  })
  const replayStack = await page.locator('.live-trace-layer').evaluate(layer => ({
    replay: Number(getComputedStyle(layer).zIndex),
    focusedPlot: Number(getComputedStyle(
      document.querySelector('.live-plot[data-live-focus-plot="true"]')!).zIndex),
    neighborPlot: Number(getComputedStyle(
      document.querySelector('.live-plot[data-live-focus-plot="false"]')!).zIndex),
  }))
  expect(replayStack.replay).toBeGreaterThan(replayStack.focusedPlot)
  expect(replayStack.focusedPlot).toBeGreaterThan(replayStack.neighborPlot)
  const start = await replay.evaluate((node, line) => ({
    left: Number.parseFloat((node as HTMLElement).style.left),
    top: Number.parseFloat((node as HTMLElement).style.top),
    x1: Number(line.getAttribute('x1')),
    y1: Number(line.getAttribute('y1')),
    x2: Number(line.getAttribute('x2')),
    y2: Number(line.getAttribute('y2')),
  }), await trail.elementHandle())
  const trailDeltaX = start.x2 - start.x1
  const trailDeltaY = start.y2 - start.y1
  const trailLengthSquared = trailDeltaX ** 2 + trailDeltaY ** 2
  expect(trailLengthSquared).toBeGreaterThan(0)
  const replayProgress = (
    (start.left - start.x1) * trailDeltaX
    + (start.top - start.y1) * trailDeltaY
  ) / trailLengthSquared
  const replayDistanceFromTrail = Math.abs(
    (start.left - start.x1) * trailDeltaY
    - (start.top - start.y1) * trailDeltaX,
  ) / Math.sqrt(trailLengthSquared)
  expect(replayProgress).toBeGreaterThanOrEqual(0)
  expect(replayProgress).toBeLessThan(0.2)
  expect(replayDistanceFromTrail).toBeLessThan(1)

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
  const minimumX = Math.min(start.x1, Number(await trail.getAttribute('x2')))
  const maximumX = Math.max(start.x1, Number(await trail.getAttribute('x2')))
  await expect.poll(async () => (await replayPosition()).x, { timeout: duration })
    .toBeGreaterThan(minimumX + (maximumX - minimumX) * 0.2)
  const midpoint = await replayPosition()
  expect(midpoint.x).toBeGreaterThan(minimumX)
  expect(midpoint.x).toBeLessThan(maximumX)
  expect(midpoint.y).toBeGreaterThan(0)
  const focusedTag = page.locator(
    '#live-label-layer [data-live-resident-tag="map-walker"]',
  )
  await expect.poll(async () => {
    const portraitBounds = await replay.locator('.live-portrait').boundingBox()
    const tagBounds = await focusedTag.boundingBox()
    if (!portraitBounds || !tagBounds) return Number.POSITIVE_INFINITY
    return Math.abs(
      portraitBounds.x + portraitBounds.width / 2 -
      (tagBounds.x + tagBounds.width / 2),
    )
  }).toBeLessThan(3)
  expect(await page.evaluate(() => Number(
    (window as Window & { liveLabelChildMutations?: number }).liveLabelChildMutations,
  ))).toBeLessThanOrEqual(1)
  await replay.locator('.live-portrait').evaluate(node => (node as HTMLButtonElement).click())
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')

  await page.clock.fastForward(duration + 1)
  const absorbedResidents = page.locator('[data-place-id="3"] .live-resident-more')
  await expect(absorbedResidents).toHaveText('+4 more')
  await expect(absorbedResidents).toHaveClass(/live-overflow-absorbing/u)
  await expect(absorbedResidents).toHaveAttribute('data-live-overflow-count', '4')
  await expect(absorbedResidents).toHaveCSS('opacity', '1')
  const thingOverflow = page.locator('[data-place-id="3"] .live-thing-more')
  await expect(thingOverflow).toHaveText('+3 more')
  await expect(thingOverflow).toHaveAttribute('data-live-overflow-count', '3')
  await expect(page.locator('.live-footnote-mark')).toHaveCount(1)
  await expect(page.locator('.live-speech-bubble')).toHaveText('Earlier line')
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)

  await page.clock.fastForward(651)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await expect(page.locator('.live-speech-bubble')).toHaveText('L'.repeat(59) + '…')
  await expect(page.locator('.live-speech-bubble')).toHaveCount(1)
  await expect(page.locator('#live-ledger')).toContainText('Latest detail stays in the ledger.')

  await page.clock.fastForward(651)
  const pulsedThing = page.locator('.live-thing-specimen.live-pulse')
  await expect(pulsedThing).toHaveCount(0)
  const stableLantern = page.locator('[data-place-id="3"] [data-live-thing-id="9"]')
  await expect(stableLantern).toHaveCount(1)
  await expect(stableLantern).not.toHaveClass(/live-pulse/u)
  await expect(page.locator('.live-action-mark')).toHaveCount(0)

  await page.clock.fastForward(600)
  await expect(replay).toHaveCount(0)
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
  expect(Math.abs(settledPoint.x - start.x2)).toBeLessThan(1)
  expect(Math.abs(settledPoint.y - start.y2)).toBeLessThan(1)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await expect(page.locator('#live-ledger')).not.toContainText('Too old to replay')
  await expect(page.locator('#live-ledger')).not.toContainText('moved: Harbor room → Cinder lane')
  const platePortrait = page.locator('#live-plates [data-live-resident-handle="map-walker"]')
  await expect(platePortrait).toHaveAccessibleName(/map-walker/u)
  await expect(platePortrait).not.toHaveAccessibleName(/Earlier|L{10}/u)

  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.clock.fastForward(100)
  await expect(replay).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await page.clock.fastForward(600_001)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
  await expect(trail).toHaveCount(0)
})

test('two arrivals into one crowded plot settle on their own trail endpoints', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    secondArrival: true,
    movementOnly: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('#live-plates .live-walker')).toHaveCount(8)

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const replays = page.locator('.live-replay-portrait[data-replay-duration]')
  await expect(replays).toHaveCount(2)
  const durations = await replays.evaluateAll(nodes => nodes.map(node =>
    Number((node as HTMLElement).dataset.replayDuration)))
  expect(durations.every(duration => duration >= 3_200 && duration <= 8_000)).toBe(true)
  await page.clock.runFor(Math.max(...durations) + 20)
  await expect(replays).toHaveCount(0)

  for (const handle of ['map-walker', replayCrowd[0]!.handle]) {
    const walker = page.locator(
      `.live-replay-portrait:not([data-replay-duration]) ` +
      `[data-live-resident-handle="${handle}"]`,
    )
    const trail = page.locator(`.live-trail[aria-label^="${handle} moved"]`)
    await expect(walker).toHaveCount(1)
    await expect(trail).toHaveCount(1)
    const point = await walker.evaluate(node => {
      const shell = node.closest('.live-walker, .live-replay-portrait') as HTMLElement
      const stage = node.closest('.live-stage') as HTMLElement
      const ground = stage.getBoundingClientRect()
      const box = shell.getBoundingClientRect()
      const scale = ground.width / Number(stage.dataset.liveStageWidth)
      return {
        x: (box.left + box.width / 2 - ground.left) / scale,
        y: (box.bottom - ground.top) / scale,
      }
    })
    expect(Math.abs(point.x - Number(await trail.getAttribute('x2')))).toBeLessThan(1)
    expect(Math.abs(point.y - Number(await trail.getAttribute('y2')))).toBeLessThan(1)
  }
  await page.clock.runFor(900)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
})

test('a later crowded arrival keeps its full absorption window', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    secondArrival: true,
    movementOnly: true,
    staggeredArrivalDeadlines: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('#live-plates .live-walker')).toHaveCount(8)

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
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
  expect(lastDuration).toBe(8_000)
  expect(lastDuration! - firstDuration!).toBeGreaterThanOrEqual(400)
  expect(lastDuration! - firstDuration!).toBeLessThan(900)

  await page.clock.runFor(lastDuration!)
  const absorptionBadge = page.locator('[data-place-id="3"] .live-resident-more')
  await expect(absorptionBadge).toHaveClass(/live-overflow-absorbing/u)
  await page.clock.runFor(250)
  await expect(absorptionBadge).toHaveClass(/live-overflow-absorbing/u)
  await page.clock.runFor(250)
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
  await page.clock.runFor(9_500)
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:14')
  const pinnedThing = page.locator('[data-place-id="3"] [data-live-thing-id="9"]')
  await expect(pinnedThing).toHaveAttribute('data-live-focus-thing', '9')
  await expect(pinnedThing).toHaveClass(/live-pulse/u)
})

test('an unshown thing never consumes visible replay time', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, { useThingId: 22 })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('[data-place-id="3"] .live-thing-more')).toHaveText('+3 more')
  await expect(page.locator('[data-place-id="3"] [data-live-thing-id="22"]')).toHaveCount(0)
  const movement = page.locator('.live-replay-portrait[data-live-replay-key="change:11"]')
  const movementDuration = Number(await movement.getAttribute('data-replay-duration'))
  await page.clock.runFor(movementDuration + 1 + 650 + 1 + 650 + 1)
  await expect(page.locator('.live-replay-portrait[data-live-replay-key="change:14"]'))
    .toHaveCount(0)
  await expect(page.locator('#live-ledger')).toContainText('used thing #22')
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

  await page.locator('[data-place-id="3"] .live-plot-open').click()
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
  const rootBubbleBounds = await page.locator('.live-root-walkers .live-speech-bubble')
    .first().evaluate(node => {
      const bubble = node.getBoundingClientRect()
      const viewport = document.querySelector('#live-viewport')!.getBoundingClientRect()
      return {
        top: bubble.top >= viewport.top - 1,
        bottom: bubble.bottom <= viewport.bottom + 1,
      }
    })
  expect(rootBubbleBounds).toEqual({ top: true, bottom: true })

  await page.locator('#resident-filter').selectOption('harbor-7')
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
  expect(await page.evaluate(() => localStorage.getItem('1f3d9:window:live-focus'))).toBeNull()
  const filteredResident = page.locator('[data-live-resident-handle="harbor-7"]').first()
  await panLiveTargetIntoView(page, filteredResident)
  await filteredResident.click()
  await expect(page.locator('#live-focus-status')).toContainText('Focused on harbor-7')
  await expect(page).toHaveURL(/\/window\/live\?place=3$/u)
})

test('resident tags follow zoom and intent while terrain and camera writes stay bounded', async ({ page }) => {
  const now = Date.now()
  await installReplayRoutes(page, now, 'complete', 0, { maximumHandle: maximumReplayHandle })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const stage = page.locator('#live-stage')
  await expect(stage).toHaveAttribute('data-live-label-mode', 'far')
  await expect(page.locator('.live-world-ground > .drawing-grid')).toHaveCount(1)
  await expect(page.locator('.live-plot-terrain > .drawing-grid')).toHaveCount(2)

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
  await expect(focusedTag).toHaveText(maximumReplayHandle)
  await expect(focusedTag).toHaveCSS('text-overflow', 'clip')
  await expect(focusedTag).toHaveCSS('overflow', 'visible')
  await expect(focusedTag).toHaveCSS('white-space', 'nowrap')

  await focusedWalker.click()
  await page.mouse.move(1, 1)
  await expect(focusedTag).toBeVisible()
  await focusedWalker.evaluate(node => {
    const bubble = document.createElement('span')
    bubble.className = 'live-speech-bubble'
    bubble.textContent = 'A bubble must leave the full name readable.'
    node.closest('.live-walker')!.append(bubble)
  })
  const neighborWalker = page.locator(
    '#live-plates [data-live-resident-handle="harbor-3"]',
  ).first()
  await panLiveTargetIntoView(page, neighborWalker)
  await neighborWalker.focus()
  const neighborTag = page.locator('#live-label-layer [data-live-resident-tag="harbor-3"]')
  await expect(neighborTag).toBeVisible()
  const labelsOverlap = await focusedTag.evaluate((node, neighbor) => {
    const first = node.getBoundingClientRect()
    const second = neighbor.getBoundingClientRect()
    return first.left < second.right && first.right > second.left &&
      first.top < second.bottom && first.bottom > second.top
  }, await neighborTag.elementHandle())
  expect(labelsOverlap).toBe(false)
  const tagCoversBubble = await focusedTag.evaluate(node => {
    const tag = node.getBoundingClientRect()
    const bubble = document.querySelector('.live-speech-bubble')!.getBoundingClientRect()
    return tag.left < bubble.right && tag.right > bubble.left &&
      tag.top < bubble.bottom && tag.bottom > bubble.top
  })
  expect(tagCoversBubble).toBe(false)
  const [focusedZ, neighborZ] = await Promise.all([
    focusedTag.evaluate(node => Number(getComputedStyle(node).zIndex)),
    neighborTag.evaluate(node => Number(getComputedStyle(node).zIndex)),
  ])
  expect(focusedZ).toBeGreaterThan(neighborZ)

  const plotNameplate = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
  await expect(plotNameplate).toHaveAttribute('title', 'Open the live plate for Cinder lane')
  await expect(plotNameplate.locator('.live-plot-name')).toHaveCSS('text-overflow', 'ellipsis')

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
  expect(cameraAttributeWrites).toBeLessThanOrEqual(5)

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
  await expect(stage).toHaveAttribute('data-live-label-mode', 'readable')
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
    const tags = [...document.querySelectorAll<HTMLElement>('#live-label-layer .live-resident-tag')]
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
      allPacked: tagRects.every(tag => tag.packed === 'true'),
      allReadable: tagRects.every(tag => tag.fontSize >= 11),
      allFull: tagRects.every(tag => tag.full),
      collisions,
      bubbleCollisions,
    }
  })
  expect(packedLabels.tagHandles).toEqual(packedLabels.handles)
  expect(packedLabels.allPacked).toBe(true)
  expect(packedLabels.allReadable).toBe(true)
  expect(packedLabels.allFull).toBe(true)
  expect(packedLabels.collisions).toEqual([])
  expect(packedLabels.bubbleCollisions).toEqual([])

  const fixedPlotState = await page.locator('.live-plot[data-place-id="3"]').evaluate(plot => ({
    left: (plot as HTMLElement).style.left,
    top: (plot as HTMLElement).style.top,
    overflow: plot.querySelector('.live-resident-more')?.textContent,
  }))
  const viewport = page.locator('#live-viewport')
  await viewport.focus()
  for (let index = 0; index < 16; index += 1) await viewport.press('ArrowRight')
  await expect.poll(() => page.locator('.live-plot[data-live-detail="false"]').count())
    .toBeGreaterThan(0)
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
  const residentOverlap = await page.locator(
    '[data-place-id="3"] .live-walker',
  ).evaluateAll((nodes, badge) => {
    const count = badge.getBoundingClientRect()
    return nodes.some(node => {
      const pin = node.getBoundingClientRect()
      return pin.left < count.right && pin.right > count.left &&
        pin.top < count.bottom && pin.bottom > count.top
    })
  }, await residentBadge.elementHandle())
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
  const thingOverlaps = await page.locator(
    '[data-place-id="3"] .live-thing-specimen',
  ).evaluateAll((nodes, badge) => {
    const count = badge.getBoundingClientRect()
    return nodes.some(node => {
      const thing = node.getBoundingClientRect()
      return thing.left < count.right && thing.right > count.left &&
        thing.top < count.bottom && thing.bottom > count.top
    })
  }, await thingBadge.elementHandle())
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
  const harbor = page.locator('.live-plot[data-place-id="3"]')
  const stableResidentsBefore = await liveResidentLocalPositions(harbor)

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('.live-trail')).toHaveCount(1)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  const latestNoteMark = page.locator('.live-footnote-mark[data-live-key="change:13"]')
  await expect(latestNoteMark).toBeVisible()
  await expect(latestNoteMark).toHaveAccessibleName("Show map-walker's note in the plate ledger")
  const bubble = latestNoteMark.locator('.live-speech-bubble')
  await expect(bubble).toBeVisible()
  await expect(bubble).toHaveText('L'.repeat(59) + '…')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await expect(bubble).toHaveCSS('animation-name', 'none')
  expect(await liveResidentLocalPositions(harbor)).toEqual(stableResidentsBefore)
})

test('the plate hard-caps trail ink and removes it at the fade edge without trimming the ledger', async ({ page }) => {
  const now = Date.now()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date(now) })
  await installReplayRoutes(page, now, 'complete', 0, {
    moveBurst: 120,
    openingMarker: '120',
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await expect.poll(() => page.locator('.live-trail').count()).toBeGreaterThan(0)
  expect(await page.locator('.live-trail').count()).toBe(96)
  await expect(page.locator('.live-ledger-row')).toHaveCount(120)
  await page.clock.fastForward(4_501)
  await expect(page.locator('.live-trail')).toHaveCount(0)
  await expect(page.locator('.live-ledger-row')).toHaveCount(120)
})

test('sixty-four simultaneous walks complete in one painted batch', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    simultaneousMoves: 64,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await publishReplayChanges(page, fixture)
  const replays = page.locator('.live-replay-portrait')
  let durations: number[] = []
  await expect.poll(async () => {
    durations = await replays.evaluateAll(nodes => nodes.map(node =>
      Number((node as HTMLElement).dataset.replayDuration)))
    return durations.length
  }).toBe(64)
  expect(new Set(durations).size).toBe(1)
  await page.locator('#live-viewport').evaluate(async viewport => {
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
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
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
  await page.waitForTimeout(750)
  const labelGeometryReads = await page.evaluate(() => {
    const heldWindow = window as typeof window & {
      liveLabelGeometryReads?: number
      liveOriginalClientRect?: typeof Element.prototype.getBoundingClientRect
    }
    Element.prototype.getBoundingClientRect = heldWindow.liveOriginalClientRect!
    return heldWindow.liveLabelGeometryReads ?? 0
  })
  expect(labelGeometryReads).toBeLessThan(1_000)
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

  await page.clock.fastForward(durations[0]! + 20)
  await expect(replays).toHaveCount(0)
  const completionMutations = await page.evaluate(() => {
    const heldWindow = window as typeof window & {
      liveCompletionMutations?: number
      liveCompletionObserver?: MutationObserver
    }
    heldWindow.liveCompletionObserver?.disconnect()
    return heldWindow.liveCompletionMutations ?? 0
  })
  expect(completionMutations).toBeLessThanOrEqual(2)
  await expect(page.locator('.live-ledger-row')).toHaveCount(64)
  await expect(page.locator('.live-trail')).toHaveCount(64)
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
    { length: 200 }, (_, index) => `change:${2_401 + index}`,
  )
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
    () => fixture.changeCursors().slice(changeCursorOffset),
    { timeout: 45_000 },
  ).toEqual(expectedPageCursors)
  expect(fixture.changeLimits().slice(changeCursorOffset)).toEqual(
    expectedPageCursors.map(() => '200'),
  )

  const replays = page.locator('.live-replay-portrait')
  await expect(page.locator('.live-ledger-row')).toHaveCount(actorCount, { timeout: 45_000 })
  await expect(replays).toHaveCount(expectedTransientReplayKeys.length)
  const stableResidentsDuring = await stableResidentPositions()
  const fixedPlotsDuring = await fixedPlotPositions()
  await page.clock.fastForward(2_000)
  type TransientReplay = Readonly<{
    key: string
    actor: string
    fromPlaceId: string
    toPlaceId: string
  }>
  let transientReplays: TransientReplay[] = []
  await expect.poll(async () => {
    transientReplays = await page.evaluate(() => [...((window as Window & {
      __liveReplayStarts?: TransientReplay[]
    }).__liveReplayStarts ?? [])])
    return transientReplays.length
  }).toBe(expectedTransientReplayKeys.length)
  const transientReplayKeys = transientReplays.map(replay => replay.key)
  expect(transientReplayKeys).toEqual(expectedTransientReplayKeys)
  expect(transientReplayKeys).not.toContain('change:2400')
  expect(transientReplays[0]).toEqual({
    key: 'change:2401',
    actor: 'walker-burst-1401',
    fromPlaceId: '2',
    toPlaceId: '3',
  })
  const transientReplayCount = transientReplayKeys.length
  const newestTrail = page.locator('.live-trail[data-live-key="change:2600"]')
  await expect(newestTrail).toHaveAttribute(
    'aria-label', 'walker-burst-1600 moved from 2 to 3',
  )
  expect(transientReplays.at(-1)).toEqual({
    key: 'change:2600',
    actor: 'walker-burst-1600',
    fromPlaceId: '2',
    toPlaceId: '3',
  })
  await expect(replays).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('.live-trail')).toHaveCount(96)
  const stableResidentsAfter = await stableResidentPositions()
  const fixedPlotsAfter = await fixedPlotPositions()

  const ledgerRows = await page.locator('.live-ledger-row').evaluateAll(rows =>
    rows.map(row => ({
      key: (row as HTMLElement).dataset.liveKey,
      copy: row.querySelector('.live-ledger-copy')?.textContent ?? '',
    })))
  const expectedLedgerKeys = Array.from(
    { length: actorCount }, (_, index) => `change:${2_600 - index}`,
  )
  const repeatedActorLedger = ledgerRows
    .filter(row => row.copy.startsWith('walker-burst-1401 moved:'))
  expect(repeatedActorLedger).toEqual([{
    key: 'change:2401',
    copy: 'walker-burst-1401 moved: Cinder lane → Harbor room',
  }, {
    key: 'change:2400',
    copy: 'walker-burst-1401 moved: Harbor room → Cinder lane',
  }])
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
    work.replayCatchUpRecords === actorCount - 200 &&
    transientReplayCount <= 200 &&
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
    JSON.stringify(ledgerRows.map(row => row.key)) === JSON.stringify(expectedLedgerKeys) &&
    ledgerRows.some(row => row.copy.startsWith('walker-burst-1600 moved:')) &&
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
      ledgerRowCount: ledgerRows.length,
      repeatedActorLedger,
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
  await returningReplay.evaluate((node, handle) => {
    const shell = node as HTMLElement
    const stage = document.querySelector('#live-stage') as HTMLElement
    const viewport = document.querySelector('#live-viewport') as HTMLElement
    const scale = Number(stage.dataset.liveScale)
    const offsetX = Number(stage.dataset.liveOffsetX)
    const offsetY = Number(stage.dataset.liveOffsetY)
    shell.style.animation = 'none'
    shell.style.left = String((viewport.clientWidth / 2 - offsetX) / scale) + 'px'
    shell.style.top = String((viewport.clientHeight / 2 - offsetY) / scale) + 'px'
    shell.dataset.liveFocusResident = String(handle)
    ;(node.querySelector('.live-portrait') as HTMLElement).focus()
  }, returningHandle)
  await expect(page.locator(
    `#live-label-layer [data-live-resident-tag="${returningHandle}"]`,
  )).toBeVisible()
  await replays.evaluateAll(nodes => nodes.forEach(node => {
    ;(node as HTMLElement).style.display = 'none'
  }))
  await page.waitForTimeout(50)
  await returningReplay.evaluate(node => {
    ;(node as HTMLElement).style.display = ''
  })
  expect(await returningReplay.evaluate(node => {
    const portrait = node.getBoundingClientRect()
    const viewport = document.querySelector('#live-label-layer')!.getBoundingClientRect()
    return portrait.right > viewport.left && portrait.left < viewport.right &&
      portrait.bottom > viewport.top && portrait.top < viewport.bottom
  })).toBe(true)

  await expect(page.locator(
    `#live-label-layer [data-live-resident-tag="${returningHandle}"]`,
  )).toBeVisible({ timeout: 750 })
})

test('turning on reduced motion mid-walk preserves the final fading trail', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await publishReplayChanges(page, fixture)
  const replay = page.locator('.live-replay-portrait')
  await expect.poll(() => replay.count()).toBeGreaterThan(0)
  await expect(replay).toHaveCount(1)
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:11')

  await page.clock.runFor(2_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-trail')).toHaveCount(1)
  await page.clock.runFor(4_400)
  await expect(page.locator('.live-trail')).toHaveCount(1)
  await page.clock.runFor(101)
  await expect(page.locator('.live-trail')).toHaveCount(0)
})

test('the Live tab draws stored world ground and keeps surveyed plots fixed through new places', async ({ page }) => {
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
  const captionClearOfViewport = await page.locator('#live-map-caption').evaluate(node => {
    const caption = node.getBoundingClientRect()
    const viewport = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return caption.bottom <= viewport.top + 1
  })
  expect(captionClearOfViewport).toBe(true)
  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('.live-trail')).toHaveCount(1)
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(1)
  await expect(page.locator('.live-speech-bubble')).toHaveText('A bell answers')
  await expect(page.locator('#live-ledger')).toContainText('A bell answers')
  await expect(page.locator('#live-ledger')).toContainText('moved: Cinder lane → Harbor room')
  await expect(page.locator('#live-ledger')).toContainText('used thing #9 in Harbor room')
  await expect(page.locator('#live-ledger')).not.toContainText('used thing #9 in Cinder lane')
  const worldDrawing = page.locator('.live-world-ground .drawing-authored').first()
  await expect(worldDrawing).toBeVisible()
  await expect(page.locator('.live-world-ground > .drawing-grid')).toHaveCount(1)
  const worldPixels = await worldDrawing.evaluate(node => {
    const canvas = node as HTMLCanvasElement
    const stage = canvas.closest('#live-stage') as HTMLElement
    return {
      tag: canvas.tagName,
      width: canvas.width,
      height: canvas.height,
      stageWidth: Number(stage.dataset.liveStageWidth),
      stageHeight: Number(stage.dataset.liveStageHeight),
      first: [...canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data],
    }
  })
  expect(worldPixels).toEqual({
    tag: 'CANVAS',
    width: Math.ceil(worldPixels.stageWidth / 56) * 8,
    height: Math.ceil(worldPixels.stageHeight / 56) * 8,
    stageWidth: worldPixels.stageWidth,
    stageHeight: worldPixels.stageHeight,
    first: [23, 77, 60, 255],
  })
  const harbor = page.locator('.live-plot[data-place-id="3"]')
  await expect(harbor).toHaveAttribute('data-undrawn', 'true')
  await expect(harbor).toHaveAttribute('data-place-kind', 'continent')
  await expect(harbor.locator('.live-plot-owner')).toHaveText('undrawn · kept by harbor-owner')
  const cinderTerrain = page.locator('.live-plot[data-place-id="2"] .live-plot-terrain')
  await expect(cinderTerrain.locator('.drawing-authored').first()).toBeVisible()
  await expect(cinderTerrain.locator('canvas.drawing-authored')).toHaveAttribute('width', '64')
  await expect(cinderTerrain.locator('canvas.drawing-authored')).toHaveAttribute('height', '40')
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
  const trailCoordinates = await page.locator('.live-trail').evaluate(line => ({
    x1: Number(line.getAttribute('x1')),
    x2: Number(line.getAttribute('x2')),
  }))
  expect(trailCoordinates.x1).not.toBe(trailCoordinates.x2)

  await page.locator('.live-trail').focus()
  await expect(page.locator('.live-trail')).toBeFocused()
  await page.locator('.live-trail').evaluate(node => {
    const lifetime = Number((node as HTMLElement).dataset.liveLifetime)
    ;(node as HTMLElement).dataset.liveAt = String(Date.now() - lifetime - 1)
  })
  await page.clock.runFor(1_001)
  await expect(page.locator('.live-trail')).toHaveCount(0)
  const pairedLedgerRow = page.locator('#live-ledger [data-live-key="change:11"]')
  await expect(pairedLedgerRow).toBeFocused()
  await pairedLedgerRow.evaluate(node => {
    const lifetime = Number((node as HTMLElement).dataset.liveLifetime)
    ;(node as HTMLElement).dataset.liveAt = String(Date.now() - lifetime - 1)
  })
  await page.clock.runFor(1_001)
  await expect(page.locator('#live-viewport')).toBeFocused()
  await page.clock.fastForward(6_000)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(1)
  await expect(page.locator('#live-ledger')).not.toContainText('An older mark')

  moderationPublished = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(cinderTerrain.locator('.drawing-authored')).toHaveCount(0)
  await expect(cinderTerrain.locator('.drawing-unavailable').first()).toBeVisible()
  await expect(page.locator('#live-ledger')).toContainText("map-walker's note #77 could not be read.")
  await expect(page.locator('#live-ledger')).not.toContainText('A bell answers')
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
    mountedTerrain: plots.filter(plot => plot.querySelector('.live-plot-terrain')).length,
    distantDetailNodes: plots.filter(plot =>
      (plot as HTMLElement).dataset.liveDetail === 'false').reduce((count, plot) =>
      count + plot.querySelectorAll(
        '.live-plot-terrain, .live-plot-owner, .live-portrait-grid, .live-thing-shelf',
      ).length, 0),
  }))
  expect(resizedDetailBudget.detailedPlots).toBeGreaterThan(0)
  expect(resizedDetailBudget.detailedPlots).toBeLessThanOrEqual(3)
  expect(resizedDetailBudget.mountedTerrain).toBe(resizedDetailBudget.detailedPlots)
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

  const cinderOwner = page.locator('.live-plot[data-place-id="2"] .live-plot-owner')
  await expect(cinderOwner).toHaveCSS('pointer-events', 'none')
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
  const cinderOpen = page.locator('.live-plot[data-place-id="2"] .live-plot-open')
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
