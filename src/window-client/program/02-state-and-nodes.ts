export const PART_02_STATE_AND_NODES = `  const nodes = {
    status: document.getElementById('window-status'),
    counts: document.getElementById('city-counts'),
    scope: document.getElementById('view-scope'),
    liveAlpha: document.getElementById('live-alpha'),
    liveAlphaNote: document.getElementById('live-alpha-note'),
    liveClock: document.getElementById('live-clock'),
    liveBreadcrumbs: document.getElementById('live-breadcrumbs'),
    liveHistoryStatus: document.getElementById('live-history-status'),
    liveViewport: document.getElementById('live-viewport'),
    liveStage: document.getElementById('live-stage'),
    liveLabelLayer: document.getElementById('live-label-layer'),
    liveItemPopover: document.getElementById('live-item-popover'),
    liveWorldGround: document.querySelector('#live-stage > .live-world-ground'),
    liveZoomIn: document.getElementById('live-zoom-in'),
    liveZoomOut: document.getElementById('live-zoom-out'),
    liveCenter: document.getElementById('live-center'),
    liveFullscreen: document.getElementById('live-fullscreen'),
    liveProof: document.getElementById('live-proof'),
    livePause: document.getElementById('live-pause'),
    liveFocusStatus: document.getElementById('live-focus-status'),
    liveMapCaption: document.getElementById('live-map-caption'),
    livePlates: document.getElementById('live-plates'),
    liveLedger: document.getElementById('live-ledger'),
    liveRoster: document.getElementById('live-roster'),
    liveResidentPage: document.getElementById('live-resident-page'),
    map: document.getElementById('place-map'),
    roster: document.getElementById('resident-roster'),
    residentPage: document.getElementById('resident-page'),
    thingsSummary: document.getElementById('things-summary'),
    thingsList: document.getElementById('things-list'),
    thingsPage: document.getElementById('things-page'),
    directorySearch: document.getElementById('directory-search'),
    directorySearchResults: document.getElementById('directory-search-results'),
    directorySearchStatus: document.getElementById('directory-search-status'),
    placeFilter: document.getElementById('place-filter'),
    residentFilter: document.getElementById('resident-filter'),
    directoryStatus: document.getElementById('directory-status'),
    shareStatus: document.getElementById('share-status'),
    detailShareStatus: document.getElementById('record-detail-share-status'),
    detail: document.getElementById('record-detail'),
    detailKind: document.getElementById('record-detail-kind'),
    detailTitle: document.getElementById('record-detail-title'),
    detailBody: document.getElementById('record-detail-body'),
    detailClose: document.getElementById('record-detail-close'),
    placeTitle: document.getElementById('place-focus-title'),
    placeSummary: document.getElementById('place-focus-summary'),
    placeDescription: document.getElementById('place-description'),
    placePurposeLabel: document.getElementById('place-purpose-title'),
    placePurpose: document.getElementById('place-purpose'),
    placeFrontMatterLabel: document.getElementById('place-front-matter-title'),
    placeFrontMatter: document.getElementById('place-front-matter'),
    occupants: document.getElementById('place-occupants'),
    placeThings: document.getElementById('place-things'),
    placeThingsPage: document.getElementById('place-things-page'),
    placeConversation: document.getElementById('place-conversation'),
    placeNotesPage: document.getElementById('place-notes-page'),
    conversationMode: document.getElementById('conversation-mode'),
    conversations: document.getElementById('conversation-stream'),
    conversationPage: document.getElementById('conversation-page'),
    activity: document.getElementById('activity-list'),
    happeningsPage: document.getElementById('happenings-page'),
    agreements: document.getElementById('agreement-list'),
    agreementsPage: document.getElementById('agreements-page'),
    archiveForm: document.getElementById('archive-form'),
    archiveQuery: document.getElementById('archive-query'),
    archiveMode: document.getElementById('archive-mode'),
    archiveType: document.getElementById('archive-type'),
    archiveSearch: document.getElementById('archive-search'),
    archiveResults: document.getElementById('archive-results'),
    archivePage: document.getElementById('archive-page'),
    gazetteRead: document.getElementById('gazette-read'),
    gazetteShare: document.getElementById('gazette-share'),
    gazetteSubmissionStatus: document.getElementById('gazette-submission-status'),
    gazetteIssueList: document.getElementById('gazette-issue-list'),
    gazetteIssuesPage: document.getElementById('gazette-issues-page'),
    gazetteIssue: document.getElementById('gazette-issue'),
    gazetteEntriesPage: document.getElementById('gazette-entries-page'),
    directorySearchField: document.querySelector('.directory-search-field'),
    viewFilters: document.querySelector('.view-filters'),
  }
  const tabs = [...document.querySelectorAll('[role="tab"][data-view]')]
  const panels = [...document.querySelectorAll('[role="tabpanel"]')]
  const viewShareButtons = [...document.querySelectorAll('[data-share-scope="view"]')]
  const detailShareButton = document.querySelector('[data-share-scope="detail"]')
  let bodyIdSequence = 0
  let branchRefreshOffset = 0
  let navigationRevision = 0
  let authoredRevision = 0
  let archiveRequestRevision = 0
  let thingLookupRequestRevision = 0
  let thingLookupController = null
  let thingLookupTimer = null
  let scheduledThingLookupQuery = ''
  let gazetteListRequestRevision = 0
  let gazetteListRequestPromise = null
  let gazetteDetailRequestRevision = 0
  let detailRequestRevision = 0
  let detailDrawingRequestRevision = 0
  let detailDrawingHistoryRequestRevision = 0
  let shareFeedbackRevision = 0
  let state = {
    failures: 0,
    refreshing: false,
    hasSnapshot: false,
    pollTimer: 0,
    changeMarker: null,
    snapshot: null,
    directory: {
      places: [], residents: [], loaded: false, loading: false, error: false,
      marker: null, recheckTimer: 0,
    },
    focusedPlaces: {},
    focusedResidents: {},
    histories: { notes: {}, things: {}, agreements: {}, events: {} },
    branches: {},
    residentPaging: {
      initialized: false, hasMore: false, nextBeforeId: null, loading: false, error: false,
      seenBeforeIds: [], automaticPageCount: 0, automaticPaused: false,
    },
    collapsedPlaceIds: [],
    sleeperPlaceIds: [],
    expandedBodies: [],
    fullBodies: {},
    detail: null,
    details: {},
    detailDrawings: {},
    detailDrawingHistories: {},
    archive: {
      query: '', mode: 'words', type: 'all', results: [], totalItems: 0,
      totalTextBytes: 0, nextBefore: null, hasMore: false, loading: false,
      initialized: false, error: null,
    },
    thingIndex: {
      scopeKey: '', rows: [], nextBeforeId: null, hasMore: false,
      loading: false, initialized: false, error: false,
    },
    thingLookup: {
      query: '', rows: [], hasMore: false, loading: false, error: false,
    },
    gazette: {
      firstPrintAt: null,
      submissionsOpen: null,
      issues: [],
      nextBeforeIssueNumber: null,
      hasMoreIssues: false,
      listLoading: false,
      listInitialized: false,
      listError: null,
      listRetryMode: 'initial',
      issue: null,
      entries: [],
      nextAfterOrdinal: null,
      hasMoreEntries: false,
      detailBudgetCut: null,
      detailLoading: false,
      detailInitialized: false,
      detailError: null,
    },
    gazetteIssueId: null,
    view: 'map',
    directorySearch: '',
    directorySearchIndex: -1,
    placeId: null,
    resident: null,
    conversationContext: false,
    live: {
      openingMarker: null, openingEvents: [], openingLoaded: false, openingLoading: false,
      openingComplete: false, openingPaused: false, openingError: false,
      openingReplaySuppressed: false,
      openingNextBeforeId: null, streamError: false, streamMarker: null,
      changes: [], drawings: {}, noteBodies: {},
      highlightedKey: null, quietReads: 0, nextReadAt: null,
      lastChangeAt: null, clockTimer: 0,
      replayQueues: {}, replayActive: {}, replayPositions: {},
      replayReadyAtByActor: {},
      replaySeenKeys: [], replayRevealedKeys: [], residueKeys: [], residueKeySet: new Set(),
      focusResident: null, paused: false, absorptionEndsAtByPlaceId: {}, trailStarts: {},
      raisedItemKey: null, expandedResidentPlaceIds: [], expandedThingPlaceIds: [],
      focusRestoreKey: null, focusRestoreFallbackId: null,
      suppressReplayOnNextRead: false,
      proofScene: false, proofFailure: false, proofRetrySucceeded: false,
    },
  }
  let liveCamera = Object.freeze({
    scale: LIVE_CAMERA_CENTER_SCALE, offsetX: 0, offsetY: 0, stageId: null,
    panStart: null, pinchStart: null,
  })
  let liveFullscreenHistoryEntry = false
  let liveProofRestore = null
  let liveProofScriptedMoveTimer = 0
  let liveCameraFrame = 0
  let liveLabelFrame = 0
  let liveLabelNeedsFullRefresh = true
  let liveLabelLastFullRefresh = 0
  let liveLabelRefreshTimer = 0
  const liveLabelDimensions = new WeakMap()
  let liveReplayCompletionFrame = 0
  let liveReplayCompletions = Object.freeze([])
  let liveReplayStartTimer = 0
  let liveVisibilityRevision = 0
  let liveWasHidden = document.hidden
  let liveTrailExpiryTimer = 0
  let livePointers = Object.freeze({})
  // Step 4: the single reusable Live item popover's own anchor/key/rect,
  // deliberately module-level rather than state.live -- every state
  // replacement feeds render paths, and opening a popover must never
  // schedule a plate render.
  let liveItemPopoverAnchor = null
  let liveItemPopoverKey = null
  let liveItemPopoverRect = null
  let liveItemPopoverSuppressOpen = false
  let liveItemPopoverPressWasInside = false
  let liveResidentVisibleIdsByPlaceId = Object.freeze({})
  let liveThingVisibleIdsByPlaceId = Object.freeze({})
  let liveResidentPointsByPlaceId = Object.freeze({})
  let liveThingPointsByPlaceId = Object.freeze({})
  let livePlotDetailContext = null
  let livePendingRevealPlaceId = null
  let livePendingRevealTarget = null
  let liveNoteQueue = Object.freeze([])
  let liveNoteFetches = 0
  const LIVE_PROOF_ROOT_ID = 9101
  const LIVE_PROOF_GARDEN_ID = 9102
  const LIVE_PROOF_WORKSHOP_ID = 9103
  const LIVE_PROOF_RETRY_ROOM_ID = 9104
  const LIVE_PROOF_SCRIPTED_MOVE_DELAY_MS = 5000

`
