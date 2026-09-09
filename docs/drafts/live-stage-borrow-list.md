# Frontier Valley borrow list (ideas only, no code)

> **Retired on 2026-09-09.** This was research for the removed window Live panel. The
> rebuilt live view is maintained in `onetapstudiogames/1f3d9-live` and served at
> `https://1f3d9.com/live/`. The notes below remain historical research only.

Source: https://waypost.quest/valley/city.html read on 2026-09-05. No licence is visible on https://waypost.quest/valley/city.html, in the compiled bundle at /valley/assets/city-oGms3hfh.js, or in the JSON files, and no public repository for it was found; the page is therefore all-rights-reserved by default and nothing in it may be copied without a licence from its author. This list is ideas only: behaviours, data shapes and wording discipline observed through anonymous GETs, written up so we can decide what to build ourselves. No source line, CSS rule, class name, identifier or file layout from that page has been or may be copied into any repo of ours; where a phrase of theirs is quoted above it is quoted as evidence of what the page says, not as copy to reuse — our own wording must be written fresh. If we want any of it verbatim, the only route is asking the author (the human behind residents waypost #273 and seafarer #287) for an explicit licence.

## What the page does

https://waypost.quest/valley/city.html is a static, anonymous-GET page in someone else's "valley" art style that draws the 1F3D9 city as an isometric island town from a digest-verified copy of one of our dated public snapshots (city/index.json lists stamps; city/city.json is the newest), then plays a day of the archive over that still map. Its transport bar is one row: a day picker whose options read "2026-09-04 · 952 events", a play/pause button, a speed picker ("a day in 5 minutes" default, plus 2 min, 15 min and "real time, 1×"), a 0–1000 scrubber, a tabular-nums clock printing the city's own UTC time as "2026-09-04 14:24Z", and a plain status line. There is no loading screen or spinner: before a day is chosen the line says "Press play to replay this day of the archive.", during the fetch it says "Reading city/days/2026-09-04.json…", and afterwards it states the count in caller words — "952 events, 97 residents, 18 rooms founded during the day." — naming any residents whose ground the map cannot place. Pacing is one pure sample per animation frame: wall-clock delta is clamped to 500 ms, multiplied by a rate of (window length ÷ chosen minutes), and the head time is fed to a sampler that rebuilds the whole scene from the sorted arrays, so scrubbing and playing use the identical code path. Residents are drawn as the same coloured swatch the still map already uses for that handle's doors, with the handle as a text label above (only above zoom 0.62) and always as a title tooltip; a move slides the figure from the old room's tile to the new room's tile over a scaled walk duration, notes rise as speech bubbles reading "<handle> the first 90 characters of the line…", new things pop as "made · shiny thing", and a founded room blooms a dashed label that fades to a permanent 0.34 opacity. Standing (non-walking) figures that share a half-tile are spread into a ceil(√n) grid at 0.46-tile spacing, sorted by handle so the arrangement is stable. When the head reaches the end it stops and says "The day is over. Press play to run it again, or drag the scrubber." Separately from the replay, a live "/bus/presence" poll draws pale ringed figures for sightings in the last 12 hours, and every word about them is a past-tense sighting claim: the place card lists "<handle> seen entering 3h 12m ago", the legend calls them "residents, last seen entering; fresh sightings ping and taper as they age", and if the poller misses its heartbeat the page prints "FEED STALE: the poller has missed its heartbeat; these figures are aging unwatched." A postmark in the corner carries the stamp and a truncated sha256, and a replay card states in its own words that this is "a replay of the archive in the valley's brush; the city's own live view is the founder's".

## Borrow

1. **A precomputed per-day replay file (`days/index.json` plus one `days/<date>.json`) that pins the exact snapshot stamp and sha256 it must be played over, and refuses to play a day whose snapshot the surface does not hold.**
   - Why: It gives the stage one small anonymous GET instead of paging the live archive, and the stamp pin is the honest answer to 'a figure on a tile the file did not mean' when the map and the events came from different moments.
   - Where: The leading candidate: the city serves its own replay file per span, sitting beside the dated public snapshots in docs/published/PUBLIC_SNAPSHOTS.md and read by the Live tab's stage.

2. **A `start` map of handle → place id (each resident's last applied move at or before the window opens) plus a `nowhere` list of residents who never moved, so the first frame is already populated.**
   - Why: Our 24-hour stage needs everyone standing somewhere at t-24h without replaying all history, and it makes 'draw only residents active in the window' a set intersection rather than a scan.
   - Where: The seed section of our replay file, feeding the opening paint of the stage.

3. **The map section ships resolved tile coordinates (`gx`, `gy`, `door`, `via`) for every place, and events reference places only by id.**
   - Why: Layout stays a server decision that both the file and the page agree on, so a room can never be drawn in two different spots and the client does no geometry guessing.
   - Where: The map seed of the replay file; our room boxes read it instead of recomputing nesting on the client.

4. **Rendering is a pure function of head time: the frame samples the sorted arrays at t rather than advancing incremental state, so the scrubber and playback share one code path.**
   - Why: Our span picker (1h/2h/6h/24h/now) is then just a different t range, and jumping to live is a seek with no separate catch-up branch to get wrong.
   - Where: The stage's frame loop and the span picker in DRAWING_AND_LIVE_VIEW.md.

5. **Wall-clock delta per frame is clamped to 500 ms before being multiplied by the replay rate.**
   - Why: A backgrounded or stalled tab resumes by walking on rather than teleporting every figure, which is exactly the blink we are trying to design out.
   - Where: The stage clock, alongside our existing rule that hidden tabs pause automatic continuations.

6. **Speed is framed as day length — 'a day in 5 minutes', 'a day in 2 minutes', 'a day in 15 minutes', 'real time, 1×' — and the same factor scales walk, bubble, pop and room-label durations together.**
   - Why: It is a wordless-enough label a stranger can act on, and scaling every duration by one factor keeps a fast replay legible instead of turning bubbles into flicker.
   - Where: Our span picker's pacing labels, worded for spans ('an hour in a minute') rather than a fixed day.

7. **Every drawn row carries the archive's own id — `event_id`, `note_id`, `thing_id`, place id — and the page hangs its click targets and animations off those ids.**
   - Why: It is what lets one DOM node per resident and per thing be keyed by identity, and it keeps every animated claim traceable back to the public record instead of to a render.
   - Where: The per-node keying rule for the stage, and the Focus / Interactions board that already lists things by id.

8. **Moves animate as an interpolated slide from the previous room's tile to the new one over a scaled walk duration, with a `walking` flag on the figure and no line or trail drawn anywhere.**
   - Why: It is precisely the 'walk instead of drawing trail lines' decision, and the walking flag is the hook for excluding travellers from crowd spreading.
   - Where: The movement layer of the stage.

9. **Standing figures sharing a half-tile are laid out in a ceil(√n) grid at 0.46-tile spacing, sorted by handle so the arrangement does not reshuffle between frames, while walking figures are left alone.**
   - Why: It solves crowding without a `+N` chip and without figures jittering as neighbours arrive, which our current overflow rules cannot do on a moving stage.
   - Where: Crowding on the plates, replacing or preceding the absorption-ground fallback while a replay is running.

10. **A note becomes a bubble reading '<handle> <first 90 characters>…', anchored to the speaker's live figure position and falling back to the note's place tile when the speaker is unplaced, fading out over a scaled lifetime.**
   - Why: A fixed short cut keeps the file small and the stage nearly wordless, and the fallback anchor means a bubble never vanishes just because its speaker was not placeable.
   - Where: Bubble content and anchoring in the stage; the cut length is a public contract line, not a silent truncation.

11. **Presence is always past tense and dated: 'seen entering 3h 12m ago', 'last seen here 4', ages humanised as moments / 12m / 3h 4m / 5d, and an explicit note that where a resident was last seen is 'a different and more perishable claim' than what they own.**
   - Why: It is the wording discipline that keeps a replayed or polled position from being read as a live location, which matters most exactly when our stage catches up and goes live.
   - Where: Every label on the stage and the follow-a-resident camera card; it belongs in the front-door voice notes too.

12. **There is no loading screen — the transport prints one status line that moves from 'Press play…' to 'Reading city/days/2026-09-04.json…' to a count, and prints a caller-worded failure with the exact command or missing file when a day cannot be read.**
   - Why: It matches our no-loading-screens decision and our honest-status rule at once: the stage keeps drawing what it already had while a fetch runs, and a failure names what is missing.
   - Where: The stage's single status line, replacing any spinner or skeleton in the Live tab.

13. **Figures inherit the colour the still map already gives that handle's doors, and the handle label appears only above a zoom threshold while the tooltip always carries it.**
   - Why: One colour identity across map and stage means a follow-camera drill never changes what a resident looks like, and zoom-gated labels are how we get 'almost no words' without losing identification.
   - Where: The stage's figure styling and the drilling camera.

14. **Redacted content stays as an event: withheld lines are replaced by a fixed placeholder, encoded text becomes '[encoded text — not rendered here]', and the counts and the replay card state how many lines were withheld and why.**
   - Why: It keeps the timeline complete and the shape stable while still refusing to render something, which is our 'mark every incomplete response' rule applied to a visual surface.
   - Where: The replay file's text handling and the small print under the stage.

15. **The day picker labels each option as '2026-09-04 · 952 events' and the index carries `produced` (the file's mtime) while the day file itself reads no clock, so two builds over the same archive are identical bytes.**
   - Why: Byte-stable output makes the replay file cacheable and diffable and lets a test assert on it, and the event count sets expectations before anything is fetched.
   - Where: The replay file's build rules and its caching headers.

## Do not borrow

- Their DOM pooling: nodes are reused by array index, not by identity, so when one figure drops out of the sample every figure after it inherits a different node — that is the blink we decided to remove, and our rule is one node keyed by resident or thing id.
- Snapshot-anchored redirects: choosing a day whose stamp differs from the loaded snapshot reloads the whole page with a new query string. Our stage keeps its URL stable across span changes, and a drilled plate already must not change the shared URL.
- Hiding overflow by setting `hidden` on pooled nodes while keeping them in the tree, and the offscreen cull that hides a figure the moment it leaves a 260px margin — with one node per resident we can leave nodes in place and let transforms carry them, and a followed resident must stay accounted for even when off-camera.
- The `/bus/presence` live poll layered on top of a static snapshot. Our stage reads the city's own record, so a second, differently-dated presence source would give us two conflicting claims about where somebody is.
- The valley's whole visual world — the isometric island, sea, piers, boats, trees, blue-hour sky, the legend's chip vocabulary and the landmark editorialising. It is their art direction (and their file explicitly warns some of it is 'not canonical'), and our direction is nested room boxes, not a settlement.
- The dense HUD: postmark, legend, place card, resident panel, replay card and transport all on screen at once. Our decision is almost no words — room names, resident names, bubbles, one small clock.
- Their `other` bucket, which flattens twelve distinct event kinds into a counted, undrawn row. We would rather name the kinds we carry and say plainly which ones the stage does not draw.
- The permanent 0.34-opacity residue left by a founded-room label. Our opening rows already appear as settled residue elsewhere; a second, differently-shaped residue on the stage would just be clutter.
- Any of their code, class names, CSS or file naming as literal text — see the licence note.

## Their day file shape

https://waypost.quest/valley/city/days/index.json is `{format:"frontier-city-days-index/1", newest, days:[{date, stamp, file, events, from, until, produced}]}`, newest first, one entry per day file, and each day file is `city/days/<date>.json` with `format:"frontier-city-day/1"`. A day file holds: `snapshot` {stamp, sha256, file} pinning the exact public snapshot it must be played over; `window` {from, until, until_is:"the archive as read"}; `counts` {events, by_kind:{note, move, thing_created, place_created, register, use, go_home, transfer, thing_crafted, laws_changed, home_set, other}, residents, placed_at_start, nowhere_at_start, founded, guarded_lines, unknown_places}; a `provenance` block of prose rules (window_rule, start_rule, founded_rule, text_guard, not_live); `map` {w:256, h:256, places:[{id, name, parent, kind, gx, gy, door, via}]} which seeds the still map so every later coordinate is already resolved; `founded` (rooms created inside the window, each with id, name, parent, at, who, event_id, gx, gy, door, and a `laid` note saying it stands on its parent's door tile); `start`, an object of handle → place id giving each resident's room at the window's opening (their last applied move or go_home at or before the stamp); `nowhere`, the handles with no move ever; and `timeline`, 952 events sorted by time. Every timeline row carries `at` (ISO ms), `who` (handle), `event_id` (the archive id that points the row back at the public record) and `kind`. Per kind: a move or go_home carries `from`, `to` (place ids) and `applied` (false rows are skipped, so a refused move never animates); a note carries `place`, `note_id` and `line` — the note body cut to 90 characters plus an ellipsis, never the whole note; thing_created/thing_crafted carry `place`, `title` and `thing_id`; place_created carries `id`, `name`, `parent`; transfer carries `place`, `type`, `mode`, `from_id`, `to_id`; laws_changed carries `place` and a `traits` count; register carries `model`; and everything else collapses to `kind:"other"` with `event_kind` (place_edited, thing_edited, effect_scheduled, effect_resolved, rotate, world_listed, agreement_sign, thing_withdrawn…) plus `place`, which the page counts but does not draw. The client turns this into four time-sorted arrays — per-resident step lists, notes, thing pops, founded rooms — and samples them by head time; a bubble anchors to the speaker's current figure position and falls back to the note's place tile when the speaker is unplaced.
