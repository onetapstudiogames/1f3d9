export const PART_38_REFRESH_CITY = `  async function refreshCity() {
    if (state.refreshing || state.live.proofScene) return
    const hadSnapshot = state.hasSnapshot
    const navigationRevisionAtStart = navigationRevision
    state = { ...state, refreshing: true }
    if (!state.hasSnapshot) setStatus('Loading the current public city view…', 'working')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let nextDelay = BASE_REFRESH_MS
    try {
      // A confirmed unchanged marker lets the window avoid downloading the
      // same authored text. Presence is refreshed separately because asleep is
      // time-derived and can change without a database event. If the marker or
      // presence read is unavailable, the complete bounded snapshot remains the
      // safe fallback.
      const changeState = await checkPublicChanges()
      if (state.live.proofScene) return
      nextDelay = commitLiveChangeRead(changeState)
      if (state.hasSnapshot && changeState.status === 'unchanged' &&
          state.changeMarker === changeState.marker) {
        try {
          const residents = await refreshUnchangedPresence(
            controller.signal,
            changeState.marker,
          )
          if (navigationRevision !== navigationRevisionAtStart) {
            await finishWatchingPublicStreets()
            return
          }
          const residentPresentationChanged =
            residentPresentationKey({ residents }) !== residentPresentationKey(state.snapshot)
          if (!residentPresentationChanged) {
            state = {
              ...state,
              changeMarker: changeState.marker,
              failures: 0,
            }
            await finishWatchingPublicStreets()
            return
          }
          const snapshot = Object.freeze({
            ...state.snapshot,
            residents,
            shown: Object.freeze({ ...state.snapshot.shown, residents: residents.length }),
            refreshedAt: new Date(),
          })
          state = {
            ...state,
            snapshot,
            changeMarker: changeState.marker,
            failures: 0,
          }
          populateFilters(snapshot)
          renderAll()
          void ensureFocusedSelection({ forceResident: true })
          await finishWatchingPublicStreets()
          return
        } catch {
          // Presence is time-derived. If its small read fails, continue into a
          // marker-covered authored snapshot instead of retaining an unproven
          // mixed refresh.
        }
      }
      const requiredMarker = changeState.marker || state.changeMarker
      const payload = await getSnapshot(controller.signal, requiredMarker)
      if (state.live.proofScene) return
      const freshSnapshot = normalizeSnapshot(payload)
      if (requiredMarker && !markerCovers(freshSnapshot.changeMarker, requiredMarker)) {
        throw new Error('public snapshot does not cover the requested change marker')
      }
      const replaceAuthored = !state.hasSnapshot || !state.changeMarker ||
        changeState.status === 'changed' || freshSnapshot.changeMarker !== state.changeMarker
      const navigation = replaceAuthored
        ? freshSnapshotNavigation(freshSnapshot)
        : await mergeFreshNavigation(freshSnapshot, controller.signal)
      if (navigationRevision !== navigationRevisionAtStart) {
        await finishWatchingPublicStreets()
        return
      }
      const snapshot = navigation.snapshot
      const histories = replaceAuthored
        ? freshSnapshotHistories(snapshot)
        : mergeUnchangedSnapshotHistories(snapshot)
      const archive = replaceAuthored
        ? {
            ...state.archive,
            results: [], totalItems: 0, totalTextBytes: 0, nextBefore: null,
            hasMore: false, loading: false, initialized: false, error: null,
          }
        : state.archive
      const invalidateSnapshotCaches = hadSnapshot && replaceAuthored &&
        changeState.status !== 'changed'
      if (replaceAuthored) authoredRevision += 1
      state = {
        ...state,
        snapshot,
        branches: navigation.branches,
        residentPaging: navigation.residentPaging,
        histories,
        archive,
        thingIndex: replaceAuthored
          ? {
              scopeKey: '', rows: [], nextBeforeId: null, hasMore: false,
              loading: false, initialized: false, error: false,
            }
          : state.thingIndex,
        thingLookup: replaceAuthored
          ? { query: '', rows: [], hasMore: false, loading: false, error: false }
          : state.thingLookup,
        live: invalidateSnapshotCaches
          ? {
              ...state.live,
              drawings: {},
              noteBodies: {},
            }
          : state.live,
        fullBodies: replaceAuthored ? {} : state.fullBodies,
        details: replaceAuthored ? {} : state.details,
        detailDrawings: replaceAuthored ? {} : state.detailDrawings,
        detailDrawingHistories: replaceAuthored ? {} : state.detailDrawingHistories,
        changeMarker: freshSnapshot.changeMarker || requiredMarker,
        hasSnapshot: true,
        failures: 0,
      }
      populateFilters(snapshot)
      renderAll()
      void ensureDetail(replaceAuthored)
      loadSharedArchiveQuestion()
      if (hadSnapshot && replaceAuthored &&
          (state.directory.loaded || state.directory.error) && !state.directory.loading) {
        void loadDirectory(true)
      }
      void ensureFocusedSelection({ forcePlace: replaceAuthored, forceResident: true })
      refreshFilteredViews()
      await finishWatchingPublicStreets()
    } catch {
      const failures = state.failures + 1
      state = {
        ...state,
        failures,
        live: {
          ...state.live,
          // A failed snapshot did not prove the new rows belong to a completed
          // view. Re-read them from the last completed marker; queued keys stay
          // held and cannot replay twice when the covering snapshot succeeds.
          streamMarker: state.changeMarker,
        },
      }
      nextDelay = Math.min(BASE_REFRESH_MS * Math.pow(2, failures), MAX_REFRESH_MS)
      if (state.hasSnapshot) {
        renderGlobalReadRetry(
          'The updated public city view could not be read. Showing the previous completed view.',
          'stale',
        )
      } else {
        renderGlobalReadFailure()
      }
    } finally {
      window.clearTimeout(timeout)
      state = { ...state, refreshing: false }
      scheduleRefresh(nextDelay)
    }
  }

`
