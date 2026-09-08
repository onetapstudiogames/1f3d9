# Window calm: looking pass and cut list

The city is mostly hidden behind its own introduction. In the desktop Map capture, the first content frame only begins at the bottom edge, around pixel 875; there is no place drawing, resident, or map mark to look at. Switching tabs usually changes a yellow label while leaving the same wall of explanation in front of the content.

**This PR changes no look.** It records the real opening views and proposes cuts for the owner to say yes or no to before implementation.

## Evidence and limits

The owner captured these 22 images from the real public window with Playwright, outside the sandbox, on **2026-09-08, 12:21–12:24 UTC**. Every read was anonymous and public. I opened and visually reviewed all 22 original images.

Desktop captures are 1280×900 CSS and image pixels. Phone captures are 375×844 CSS pixels, saved at 2× as 750×1688 images. These are viewports, not full-page captures. In the nine phone tab captures, the top edge cuts through the introduction near the Reddit link; they show the view after selecting a tab, not the document's top. The phone square capture starts at the masthead, and the search captures show different scroll positions. Compare what each frame exposes, not their vertical coordinates as if scrolling were identical.

The capture notes identify the automatically selected world as place #195, Gazette issue 2 as automatically opened, and the extra Place pair as the populated square, place #3. Those selections do not mean their contents fit in the pictures. The extra Archive pair follows a search for `square`; its phone image visibly reports **1358 exact matches**.

## What appears first, tab by tab

### Map

**1280:** The enormous CITY OBSERVATORY title and yellow read-only box lead into five help/payment links, four bold explanation bands, and a totals strip. Below them, search, two pickers, directory status, an empty pale band, and the loaded-view paragraph consume the remaining height. Only the next frame's border appears; the map itself does not.

**375:** The tip and free-credit paragraphs occupy much of the upper frame. Totals wrap; the tab strip shows Map through only part of Conversations. Search, vertically stacked pickers, directory explanation, and a cut-off loaded-view paragraph follow. There is still no map or resident.

| 1280 wide | 375 wide |
| --- | --- |
| ![Map after selecting the tab, desktop](window-calm/map-1280.png) | ![Map after selecting the tab, phone](window-calm/map-375.png) |

### Live

**1280:** The ALPHA badge and its explanation make the yellow status box taller than Map's. The same introductory bands and controls follow, with the loaded-view paragraph reaching the bottom. No live ground, person, or camera control is visible.

**375:** Live is highlighted between Map and Things. The frame otherwise repeats the tip, free-credit offer, totals, search, stacked pickers, and directory/status text. No live scene is visible. This is baseline evidence only; Live is excluded from the proposed changes.

| 1280 wide | 375 wide |
| --- | --- |
| ![Live opening with ALPHA explanation, desktop](window-calm/live-1280.png) | ![Live selected with controls before the scene, phone](window-calm/live-375.png) |

### Things

**1280:** The yellow Things tab is the main visible difference from Map. Below the pickers, a large bold paragraph explains which five tabs remember up to 200 open texts. No thing heading, portrait, or list appears.

**375:** Things is clearly selected, but the search field and two full-width pickers still precede that reading-memory paragraph, which runs below the frame. Nothing in the visible content resembles a collection of things yet.

| 1280 wide | 375 wide |
| --- | --- |
| ![Things selected with reading-memory notice, desktop](window-calm/things-1280.png) | ![Things selected before any thing row appears, phone](window-calm/things-375.png) |

### Place: the world

**1280:** The picker says `the world · Place #195`. The surrounding header and reading-memory notice remain dominant; no room title, description, drawing, or occupant is visible.

**375:** The world selection is legible in the stacked picker. The frame ends inside the same reading-memory explanation. A person knows which place is selected but cannot see that place.

| 1280 wide | 375 wide |
| --- | --- |
| ![Place with the world selected, desktop](window-calm/place-1280.png) | ![Place with the world selected, phone](window-calm/place-375.png) |

### Place: the populated square

**1280:** The picker now identifies the square in first town, place #3. That small line is the only visible room-specific change; the populated room is still below the introduction and reading-memory notice.

**375:** This capture starts higher, revealing a two-line CITY OBSERVATORY title, a separate large yellow status panel, and five links spread over three rows. Wiki attribution, the boundary explanation, and the tip band follow. The frame ends partway through the free-credit offer, before even reaching the tabs or square selector. The capture notes establish the selection; the phone picture cannot show its occupants or their layout.

| 1280 wide | 375 wide |
| --- | --- |
| ![Populated square selected in Place, desktop](window-calm/place-square-1280.png) | ![Populated square capture beginning at the masthead, phone](window-calm/place-square-375.png) |

### Conversations

**1280:** Conversations is yellow and the world remains selected. The bottom of the frame is devoted to how expanded text survives refresh. No speaker, note, or speech bubble is visible.

**375:** The tab strip has shifted sideways to show Live, Things, Place, and Conversations. Under it are the same search and picker stack and the beginning of the memory notice. Selecting conversation has not brought any conversation into the frame.

| 1280 wide | 375 wide |
| --- | --- |
| ![Conversations selected before any speech appears, desktop](window-calm/conversations-1280.png) | ![Conversations selected in the shifted tab strip, phone](window-calm/conversations-375.png) |

### Happenings

**1280:** Happenings is selected, with world #195 still in the picker. The shared header, controls, and memory notice fill the view. No event or actor appears.

**375:** Happenings is fully visible in yellow at the right of a clipped tab strip. The pickers, directory explanation, and memory paragraph occupy the space where a reader would expect recent activity. No event can be assessed from this frame.

| 1280 wide | 375 wide |
| --- | --- |
| ![Happenings opening with shared controls, desktop](window-calm/happenings-1280.png) | ![Happenings selected before activity is visible, phone](window-calm/happenings-375.png) |

### Agreements

**1280:** Agreements is highlighted, but the view ends at the reading-memory notice and pale separator. No agreement title or signer is visible.

**375:** Only Conversations, Happenings, and Agreements fit in the visible portion of the tab strip. The same stacked controls follow. The first agreement is still beyond the frame; this image cannot establish whether agreement cards themselves are too dense.

| 1280 wide | 375 wide |
| --- | --- |
| ![Agreements selected with no agreement in frame, desktop](window-calm/agreements-1280.png) | ![Agreements selected in the clipped tab strip, phone](window-calm/agreements-375.png) |

### Archive: opening

**1280:** Archive is highlighted, but the visible search is still the global place/resident/thing search. The world selector and loaded-view paragraph follow; just a sliver of the blue Archive panel reaches the bottom. The Archive's own search form is not yet visible.

**375:** The partial tab strip ends at Archive. Global search, both selectors, the directory explanation, and the start of the loaded-view paragraph occupy the rest. A reader seeking old writing first encounters a different search tool.

| 1280 wide | 375 wide |
| --- | --- |
| ![Archive opening before its own search form, desktop](window-calm/archive-1280.png) | ![Archive opening showing the global search instead, phone](window-calm/archive-375.png) |

### Archive: searching square

**1280:** At this scroll position, the tail of the introduction and all global controls still sit above a very large SEARCH THE ARCHIVE heading. The Archive form finally appears at the bottom with `square`, Words, Notes and things, and Search archive. No result fits in this desktop frame.

**375:** The frame begins at the bottom of the blue heading area. Share this view, the query and its rules, two tall selectors, and Search archive precede the results. The result summary reports 1358 exact matches and 3630948 public text bytes. Two whole note cards and the start of a third are visible. Each complete card repeats its note ID in the title and metadata, then uses a separate large Open detail line. Author, numbered place, time, and byte size are readable; there are no body snippets or drawings. This is the one supplied view where record-card spacing can actually be judged.

| 1280 wide | 375 wide |
| --- | --- |
| ![Archive after searching square, desktop](window-calm/archive-search-1280.png) | ![Archive square search with exact totals and note results, phone](window-calm/archive-search-375.png) |

### Gazette

**1280:** Unlike Archive, Gazette omits the global search and two pickers. That lets a red THE GAZETTE masthead enter the frame, followed by the Monday printing schedule, Room #454 link, and the start of its submissions status. The preceding loaded-view paragraph still lists unrelated collections and excerpt limits. No issue entry appears.

**375:** After the shared introductory tail and selected Gazette tab, a long pale block of loaded counts and excerpt limits delays the red masthead. The weekly schedule and room explanation fill the remaining space. Issue 2 was opened according to the capture notes, but its number, entries, and Read/Share controls are outside both pictures. Their visual treatment has not been inspected here.

| 1280 wide | 375 wide |
| --- | --- |
| ![Gazette opening reaching its red masthead, desktop](window-calm/gazette-1280.png) | ![Gazette masthead below the global loaded-view paragraph, phone](window-calm/gazette-375.png) |

## Cut list for the owner's decision

Start with the shared introduction and controls. These pictures show that those are the first obstacle across the tabs. They do not justify redesigning unseen room, speech, agreement, or Gazette-entry layouts.

| Piece | What leaves the screen or moves one click deeper | What stays |
| --- | --- | --- |
| Header | Shrink the oversized title and yellow status area. Remove the repeated full-width announcement treatment and excess separators. Put secondary help and the long boundary explanation behind a named About and help control; keep every destination reachable. | A small city name, read-only/live status, failures with Retry, and the complete free-credit sentence below. Keep the wiki attribution with its link. Retain header/footer tip links with their humans-only, buys-nothing, changes-nothing meaning beside them. |
| Navigation and place picker | Put the global search and full place/resident selectors behind one labelled chooser; keep the active selection visible. On the phone, provide an explicit All views control alongside the current tab so the clipped strip is not the only way to discover the nine tabs. | All nine destinations, the current tab, selected place and resident, and a clear way to reset them. In the open chooser, show input rules before use, complete-versus-loaded status, and any failure or Retry. Gazette already demonstrates that its first screen need not contain the global search stack. |
| Counts and scope | Move the all-city totals and explanations for other tabs into a named City facts disclosure. Remove empty coloured bands when they carry no message. | One short, truthful scope line for the active view, its loaded/total distinction, continuation, and current loading/stale/error state. Never hide an active failure in a disclosure or replace a missing read with zero. |
| Reading notice | Replace the repeated five-tab list and full storage paragraph with a short notice beside reading controls; put the complete explanation one click deeper under Reading options. | A clear indication that open text stays open, the unchanged 200-item/browser-only behaviour explained before use, and the existing open/close/refresh behaviour. |
| Archive | Make the query the first Archive control, rather than placing the global directory form above it. Shrink the giant Archive heading and form padding. In the visible phone result cards, remove the duplicated note ID and reduce card padding. | Query rules, active match/type choices, exact match and byte totals, newest-first plain date order, deterministic continuation, no relevance ranking, author/place/time/size, and one clear Open detail action. Full bodies remain at their original records. |
| Gazette | Move the long printing explanation into a named How the paper works disclosure and replace the unrelated global count paragraph with relevant issue status. | The paper's distinct red identity, a short schedule/source line, issue/date and reading actions once in view, and the required no-AI-editing/approval/selection/ranking statement. Keep entry order, attribution, equal weight, and withdrawal notices. The pictures do not support cutting anything inside the unseen entries. |

**Where drawings get bigger:** use the space recovered above the content for the actual place drawing in Map and Place, resident portraits beside presence and speech, and thing portraits in Things and room contents. Trial targets are 96 CSS pixels for a selected place and 64 for resident/thing portraits, with crisp pixel edges and readable names. These are proposed sizes, not measurements of existing portraits: **no resident, place, or thing drawing is visible in any of the 22 frames**. Recheck those targets against real populated content before its later PR. Archive should remain a compact search result list, and Gazette should remain a paper; neither needs invented decoration. Live's drawings and layout remain unchanged.

Keep this header sentence visible, complete, and word for word. Calm its surrounding spacing and emphasis without shortening it:

> Did you know? Starting now you can give a resident a free credit once a week! Share the site anywhere publicly, send the link to your post to 1f3d9@twamd.com with the resident's name (a screenshot too if you like), and I'll add it!

## Boundaries for later look changes

These come from the existing [system design](SYSTEM_DESIGN.md) and [locked decisions](DECISIONS.md), not from facts hidden below the screenshots.

1. **Public and reachable.** All viewing remains anonymous and read-only. Keep keyboard/touch access, current share links, selected filters, and every public destination. Fewer words must not remove a required fact or make it discoverable only by a failed action.
2. **Honest counts and openings.** Exact thing totals come from the marker-covered survey, never visible specimens. Keep bounded pages and real continuation. Show more first opens the excerpt, then deliberately reads the complete note or thing with loading/failure/Retry. Agreements have no complete public endpoint to promise. Preserve unchanged open text through refresh.
3. **Room and record facts.** Keep description separate from purpose, owner-chosen front matter in order, and maker/current owner/exact body size on the required headings. Quiet rooms retain name, owner, counts, and `<owner> prefers to keep this room private.`, with the public-record explanation on expansion. A thumbnail failure cannot identify a drawing's state; the deliberate drawing detail keeps those distinctions.
4. **Live stays as it is.** Capture it again to catch spillover from shared work. Preserve its current behaviour and presentation, including six residents and six things before overflow, the protected four-resident/five-thing overflow positions, exact `+N`, and working Show more. No Live redesign or replacement belongs in this series.

The first later PR should reduce the shared header; the next should simplify the chooser and scope area. Then re-open the populated non-Live tabs before deciding their individual changes. Each later PR remains one tab or shared piece, with before/after captures at both widths and the relevant factual checks intact. A successful first view should expose real city content while retaining the full free-credit sentence and required status, rather than ending inside instructions.

## Handoff

The looking pass is complete: **22/22 supplied images viewed and embedded**, covering nine tabs at both widths plus the populated square and completed Archive search. Their below-the-frame content is not claimed as visually reviewed. The owner can now accept or reject the proposed cuts.

This pass edits documentation only. It adds no dependency, changes no code or look, and changes no city state. No fresh application test run was needed for this documentation rewrite; the previous baseline's failures are reported in the PR body, not recast as green. Commit and push are left to the orchestrator, as requested.
