export const PART_02_STATE_AND_NODES = `  const nodes = {
    status: document.getElementById('window-status'),
    counts: document.getElementById('city-counts'),
    scope: document.getElementById('view-scope'),
    scopeStatus: document.getElementById('city-facts-status'),
    readingNotice: document.getElementById('window-reading-notice'),
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
    placeWatchLive: document.getElementById('place-watch-live'),
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
    expandedBodies: readViewerOpenKeys(),
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
  }

`
