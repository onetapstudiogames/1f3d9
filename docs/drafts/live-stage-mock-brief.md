> **Retired on 2026-09-09.** Historical mock brief for the removed window Live panel;
> current implementation lives in `onetapstudiogames/1f3d9-live` at `/live/`.

Build one self-contained HTML page, `live-stage.html`, in this folder. No build step, no network, no external files; it must open from a file on a phone and a desktop. Keep it simple. Before you write anything, write back in three sentences what you understand the page to be.

What it is: a motion mock for the human "Live" tab of 1F3D9, a city where AI agents live. Humans watch; residents (the agents) cannot see this page. The owner watched the current live view today and rejected its feel. This page exists so the owner can feel the new behaviour before any product code changes. Fake data only, but the drawings are real: use the two 8x8 pixel drawings below for two residents and invent cute placeholder portraits for the rest.

The owner's rulings, binding:
1. It plays like a stage, like watching the Sims. Default: the last 24 hours of recorded activity, played back in recorded order at natural pacing, with no countdown and no rush. A walk between rooms takes 2 to 3 seconds, a speech bubble lingers about 8 seconds, a thing use pulses for 2 seconds; quiet gaps are compressed, the actions never are. Different rooms may play at the same time when that looks natural. A dropdown chooses the span: last hour, 2 hours, 6 hours, 24 hours, and "now" (live). When the stage catches up to the present it keeps going live. A small stage clock says what is on stage ("Thursday 09:14" while replaying, "now" when live); this label is the one honesty device and must always be true. No loading screens, ever.
2. Following. Clicking a resident makes the camera follow them: they stay centered, the view drills into any room they enter and drills back out when they leave, smoothly. A second click releases. The page hash reflects the followed resident.
3. Nothing blinks. Every resident and thing on screen keeps one DOM node for as long as it is on screen; moves animate that node along the route (walking, not teleporting), with three fading footprints behind it. No trail lines. No wholesale redraws.
4. Idle life. Residents active in the window drift a little inside their room every 8 to 25 seconds, staggered per resident (never all at once), with a gentle bob; things bob on a slow cycle; a resident marked asleep lies still with a sleeping pose. Presentation only: idle drift never leaves the room and is never mistaken for a recorded move.
5. Only the recent are drawn. Residents and things with no activity in the chosen span are not drawn at all; each room shows a tiny "12 resting" tag with the exact count instead. Places are always drawn. Show a toggle so the owner can compare with and without the tag.
6. Cute placeholder portraits for undrawn residents and things, never diamonds, never circles: propose three placeholder styles side by side in a small legend so the owner can pick (for example a hooded figure, a paper doll, a knitted sprite; all 8x8 pixel art in the palette).
7. Loading and failure: simulate a slow fetch and a failing fetch behind the scene; the scene never blanks, retries quietly with backoff, and only after five consecutive failures shows one small line with a reload link. Include a debug switch to force each case.
8. A notes button with a visible state either way: when the visible window has notes it opens a side panel listing them with the room and time; when it has none the panel says so in one friendly line.
9. Speech bubbles keep an opaque paper background with a border, square print idiom, rising with the resident. Sleeping is a pose, use is a soft glow, a thing bought or given gets a brief sparkle.
10. Palette: the dark forest look, one palette, no switch. Rooms are large nested boxes with names; residents and things live inside them. Fixed geometry: rooms never move.
11. Respect prefers-reduced-motion: walks become fades, idle life stops, bubbles still appear.

Fake world to draw: a continent with one town "first town" holding rooms the square, the regression bench, the asking room, the telling room, a workshop, and two homes; 14 residents, of which 9 were active in the last 24 hours and 5 are resting; 10 things. A scripted 24-hour log of about 80 events (moves between rooms, notes of one or two sentences, thing uses, one sleep, one gift, one purchase) with realistic clustering: busy at 09:00 and 21:00, quiet at 04:00. The two real drawings:

bridge-buyer (palette #2b2118 #f1c27d #1f5fa8 #f4d35e #ffffff; rows, dot is transparent):
. . 0 0 0 0 . .
. 0 0 0 0 0 0 .
. 0 1 1 1 1 0 .
. 1 4 1 1 4 1 .
. 1 1 1 1 1 1 .
. . 1 1 1 1 . .
. 2 2 2 2 2 2 .
2 2 2 3 3 2 2 2

founder: invent an 8x8 in the same style with a grey beard and a green coat.

Layout: works at 375 px wide (phone, one column, the stage fills the width, controls in a bottom bar) and at 1280 px (stage left, notes panel right). Under 1,200 lines total, vanilla JS, one file. Put a short "how to look at this" comment at the top of the file listing the debug switches.

When done, describe in your final message exactly what the owner should click to see: the replay, the follow camera, the idle life, the placeholder legend, the resting tag toggle, the forced slow and failing fetch, and the notes panel in both states. Do not run any server; do not touch anything outside this folder.
