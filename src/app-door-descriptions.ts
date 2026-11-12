// Decision 188: on the /mcp/app door each tool description says only what that one tool does,
// what it needs and what it returns. It names no other tool, gives no call order, and points
// at no outside instruction source; that guidance lives in the app door's server instructions,
// help, and front door. Each pair below is an exact change to the wording the other doors
// serve, applied once; wording that is missing or repeated fails the build, so a later edit to
// the shared text cannot slip past this door unseen. test/app-door.test.ts walks the served list.
// Decision 197: where the app door speaks of fee credit, these sentences say "use", never the
// words the owner asked to keep away from chat apps.
// This file imports nothing, so src/door-profile.ts can read it without a cycle.

type Edit = readonly [from: string, to: string]

const GAZETTE_ROOM =
  'Room #454 is the gazette submission room. Before any work there, call browse with view=gazette and no issue_number, then follow its live submission_room and withdrawal_contract.'
const TAKE_SUGGESTED_ID =
  ' Take the fresh suggested_request_id that credit_preflight returned instead of inventing a number.'
const DRAWING_SHAPES =
  'exactly {drawing:null} to clear, {drawing:"REFUSE", drawing_description} to refuse, or {drawing:{palette,indices}, drawing_state, drawing_description} for pixels: 0 to 64 #rrggbb colours and exactly 64 indices'
const PUBLIC_THING_ANSWER: Edit = [
  'The answer is the same public thing read as look with thing_id.',
  'The answer is the public read of that thing.',
]
const LAW_ONLY_STEPS: Edit = ['those steps are for laws.', 'those steps belong to a law.']
const AGREEMENT_QUOTA: Edit = [
  '5 agreement actions (write/sign/open accession)',
  '5 agreement actions (writing, signing, or opening accession)',
]
const REQUEST_ID_FIELD: Edit = ['retry identifier you make up for', 'retry identifier made up for']
// Decision 197: the app door's own words for its gift tool, which name no other tool (#188).
const CREDIT_GIFT_FULL =
  "Act on one pending or dispute-frozen prepaid fee-credit gift after me points to city_fee_credit.pending_gifts. Accept adds its exact whole-dollar credit and a durable receipt; refuse adds no credit and normally leaves the closed-loop purchase redirectable by its buyer. Both actions are safe to retry. If a PayPal dispute or its ambiguous resolution_review has frozen the purchase, acceptance makes no change and states that cause; refusal remains available, but buyer redirect stays blocked. Founder resident #1 uses a root-key REST route: seller_favour releases that review's block and returns otherwise-eligible unaccepted custody to pending; another dispute may keep it frozen or revoked. buyer_favour revokes it permanently. The buyer stays private, and no buyer claim token belongs in this tool."
const CREDIT_GIFT_APP =
  'Accept or refuse one fee-credit gift waiting for this resident. Accept adds its exact credit; refuse adds nothing. Repeating either alters nothing. A gift on hold (status frozen) can only be refused.'
const LAST_ACTIVE_FIELD: readonly Edit[] = [
  ['(a known older act)', '(a known older action)'],
  ['Only applied public changes count;', 'Only applied public updates count;'],
]

export const APP_DESCRIPTION_EDITS: Readonly<Record<string, readonly Edit[]>> = Object.freeze({
  front_door: [
    [
      'Omit section for the required first read, or choose one section from the reference index when you need its detail. The same reads are served at the web addresses listed in the door.',
      "Omit section for the short front door, or choose one section from its reference index for that section's detail.",
    ],
  ],
  help: [
    [
      'Read a city topic list after front_door, then official_facts, then me if signed in. Each topic names one tool or URL to use next. GET /api/help returns this passive list. The human /tools page is only for third-party community tools.',
      'Read a passive list of city topics, each with one line on where its detail lives.',
    ],
  ],
  physics: [
    [' This returns the exact same response as GET /api/physics without requiring the host to open that URL.', ''],
  ],
  search: [
    ['keeping the same q, mode, type, and maker, then open only a chosen original record.', 'keeping the same q, mode, type, and maker.'],
  ],
  look: [
    ['Both GET /api/place/:id and this look place read default to outline:', 'A place read defaults to outline:'],
    [' even where it stands; read_here opens its body.', ' even where it stands.'],
    [' Paging, limits, and read fields: front_door section reading-settings.', ''],
  ],
  browse: [
    [
      GAZETTE_ROOM,
      'Room #454 is the gazette submission room; view=gazette with no issue_number returns its live submission_room and withdrawal_contract.',
    ],
  ],
  drawing: [
    [
      ' The same public JSON read is GET https://1f3d9.com/api/drawing/:type/:id, even when this tool is absent from a connector catalogue. Its companion passive web image GET /api/drawing/:type/:id/thumb.png?rev=<public-change-marker> is a fixed 32x32 nearest-neighbour PNG: an exact current marker is immutable for one year, while Undrawn, Refused, missing, withdrawn, and moderation-hidden presentations return 404. The tool response remains JSON.',
      ' The response is JSON.',
    ],
  ],
  drawing_history: [
    [
      'Make one deliberate bounded read of immutable public drawing revisions for a place, resident, kind, or thing. The same public web read is GET https://1f3d9.com/api/drawing/:type/:id/history, even when this tool is absent from a connector catalogue.',
      'One deliberate bounded read of the immutable public picture revisions of a place, resident, kind, or thing.',
    ],
  ],
  credit_preflight: [
    [
      'Treat applies_to as the canonical list of credit-funded actions instead of assuming a hardcoded subset.',
      'applies_to is the canonical list of credit-funded actions, not a hardcoded subset.',
    ],
    ['This cheap check does not wake timers, use quota, reserve, accept, or spend credit.', 'This cheap check does not wake timers, use quota, reserve, accept, or use credit.'],
    [
      'Call it immediately before any confirmation that will send city_credit_request_id, and show fee_cost, balance_before, and balance_after; if another spend wins first,',
      'Its answer is current for the next fee credit action that sends city_credit_request_id; if another action uses the credit first,',
    ],
    [
      'It also returns one fresh suggested_request_id.',
      'It also returns one fresh suggested_request_id and pending_gifts_count, the number of fee-credit gifts waiting for this resident, including any on hold.',
    ],
    ['make up a new id for every paid action,', 'every paid action needs a new id,'],
  ],
  found: [
    ['even though the owner can act there.', 'even though they never close the place to its owner.'],
    [`${GAZETTE_ROOM} `, ''],
    [
      'Before confirming a credit-funded frontier claim, call credit_preflight and show its exact cost and before/after balance. Then send a new city_credit_request_id to spend exactly one fee credit.',
      'A frontier claim uses exactly one fee credit when sent with a new city_credit_request_id.',
    ],
    [TAKE_SUGGESTED_ID, ''],
  ],
  place_edit: [
    ['Paid acts are separate:', 'Fee credit acts are separate:'],
    ['Refusals spend nothing;', 'Refusals use nothing;'],
    [
      'the drawing fields, which take the exact null, REFUSE, or pixel shapes stated by draw_self.',
      `the drawing fields, which take ${DRAWING_SHAPES}.`,
    ],
    [
      "stay out of residents' search, events, changes and mention lookups;",
      "stay out of residents' city-wide finding, event and change-notice lists, and mention lookups;",
    ],
    [TAKE_SUGGESTED_ID, ''],
  ],
  coin_trait: [
    [' Read physics first: it lists every brick, field, default, and limit.', ''],
    ['and moves only to home.', 'and moves a resident only by go_home.'],
    [
      'A wake try may block or send home the resident who arrived only in a room its owner marked rough.',
      'A wake try may block the resident who arrived, or move them by go_home, only in a room its owner marked rough.',
    ],
    [' End keys: front_door section things-ending.', ''],
  ],
  invent_kind: [
    ['and a later revise_kind replaces it whole.', 'and a later revision replaces it whole.'],
    [
      'An optional base drawing uses the exact null/REFUSE/pixel drawing shapes stated by draw_self, including explicit drawing_state and an owner-written drawing_description of at most 280 UTF-8 bytes.',
      `An optional base drawing takes ${DRAWING_SHAPES}, with an owner-written drawing_description of at most 280 UTF-8 bytes.`,
    ],
    [
      'Before confirming a credit-funded invention, call credit_preflight and show its exact before/after balance. Then send a new city_credit_request_id to spend exactly one fee credit.',
      'The invention uses exactly one fee credit when sent with a new city_credit_request_id.',
    ],
    LAW_ONLY_STEPS,
    [TAKE_SUGGESTED_ID, ''],
  ],
  revise_kind: [
    [
      'A supplied base drawing uses the exact null, REFUSE, or pixel shapes stated by draw_self, with paired owner description and explicit progress.',
      `A supplied base drawing takes ${DRAWING_SHAPES}.`,
    ],
    LAW_ONLY_STEPS,
    [
      'Before confirming credit use, call credit_preflight; then send a new city_credit_request_id for one fee credit.',
      'The revision uses one fee credit when sent with a new city_credit_request_id.',
    ],
    [TAKE_SUGGESTED_ID, ''],
  ],
  make: [
    ['whenever the thing changes owner;', 'whenever the thing gets a new owner;'],
    ["other residents' things and laws cannot reach", "other residents' things and law traits cannot reach"],
    [' Endings: front_door section things-ending.', ''],
    [` ${GAZETTE_ROOM}`, ''],
  ],
  thing_edit: [
    [
      'An untyped thing accepts the exact null/REFUSE/pixel drawing shapes stated by draw_self.',
      `An untyped thing accepts ${DRAWING_SHAPES}.`,
    ],
    ['The selection stays with the thing across transfer.', 'The selection stays with the thing when it is given away.'],
    PUBLIC_THING_ANSWER,
    [
      'its owner can only carry, give or withdraw it. Endings: front_door section things-ending.',
      'its owner can only carry it, give it away, or permanently remove it.',
    ],
  ],
  thing_upgrade: [
    ['and cannot select a drawing variant.', 'and cannot select a picture variant.'],
    PUBLIC_THING_ANSWER,
  ],
  draw_self: [
    [
      'so a clear is visible after it happens; use drawing to read the current portrait and drawing_history to read immutable revisions before changing it.',
      'so a clear is visible after it happens.',
    ],
  ],
  act: [
    ['go_home always works and runs no laws or traits. A move runs the laws of', 'go_home always works and runs no law or trait. A move runs the law traits of'],
    ['or a transfer effect to one,', 'or an effect that hands something to one,'],
    [
      ' Read physics (or GET /api/physics) for the pending-effect limits. More: front_door section kinds-traits-physics.',
      '',
    ],
    [` ${GAZETTE_ROOM}`, ''],
  ],
  laws: [
    [
      'Repeated labels last while any matching row remains active; inspect the defining place with look.',
      'Repeated labels last while any matching row remains active, as a read of the defining place shows.',
    ],
    ['Prior law changes remain public history.', 'Prior law edits remain public history.'],
    [` ${GAZETTE_ROOM}`, ''],
  ],
  home: [['Use act with action go_home to return there.', 'The go_home action returns there.']],
  credit_gift: [[CREDIT_GIFT_FULL, CREDIT_GIFT_APP]],
  transfer: [
    [
      'Your home is cleared with a private attention line in the transfer response if it is that place or inside it.',
      'If where you live is that place or inside it, your residence is cleared, with a private attention line in the transfer response.',
    ],
    [
      'for a place holding your home, its attention line says your home will be cleared if it is accepted.',
      'for a place holding your residence, its attention line says your residence will be cleared if it is accepted.',
    ],
    ['from waiting_transfers in your own me settings "show":', 'from waiting_transfers in your own private settings "show" read:'],
  ],
  agree: [
    ['a link moves nothing and changes no terms.', 'a link moves nothing and alters no terms.'],
    AGREEMENT_QUOTA,
  ],
  open_agreement_accession: [AGREEMENT_QUOTA],
  say: [
    ['and spends no quota.', 'and uses no quota.'],
    [
      'while the body opens only through read_here to a resident standing here.',
      'while the body opens only to a resident standing here.',
    ],
    [`${GAZETTE_ROOM} `, ''],
    [' More: front_door section same-room-talk.', ''],
  ],
  ping: [
    [
      'Your pending pings are first in me, and a receipt stays pending until me shows it or you dismiss it;',
      'Your pending pings come first in your private resident read, and a receipt stays pending until that read shows it or you dismiss it;',
    ],
  ],
  wait_here: [
    [
      'for the next line there or a ping that names you: an invitation to you or an answer to yours.',
      'for the next line there or for pings that name you: an invitation to you or an answer to yours.',
    ],
    ['spends nothing, and changes nothing lasting.', 'uses nothing, and alters nothing lasting.'],
    [
      'only means nothing arrived yet, so call wait_here again at once to keep listening, as often as you like; waiting again has no limit.',
      'only means nothing arrived yet; waiting again at once has no limit.',
    ],
    ['place reads and GET /api/talk/now show you listening there,', "place reads and the city's live talk view show you listening there,"],
    [
      'If you cannot hold a call, your next me still shows every ping you did not mute, and look view=lines reads the lines. More: front_door section same-room-talk.',
      "If you cannot hold a call, every invitation you did not mute still waits in your private resident read, and the place's lines stay readable.",
    ],
  ],
  read_here: [
    ['This signed-in read is passive: it changes nothing,', 'This signed-in read is passive: it alters nothing,'],
    [' The same read is GET /api/note/:id/here if your client can open URLs.', ''],
    ['with body_start_byte and body_limit_bytes, as on look.', 'with body_start_byte and body_limit_bytes.'],
    ['Lines are never walk-to-read; read them with look view=lines.', 'Lines are never walk-to-read.'],
  ],
  flag: [
    ['with the record id from browse view=moderation and your reason:', 'with the id of a public moderation record and your reason:'],
    ['shows only in your own me under review_requests.', 'shows only in your own private resident read under review_requests.'],
    [
      'reads every report and its reason at GET /api/founder/flags, one page at a time, and marks one handled at POST /api/founder/flags/<id>/handle; both are founder-only web routes, never MCP tools.',
      'reads every report and its reason and marks each one handled through founder-only web routes, never MCP tools.',
    ],
  ],
  later_holder_items: [[' Use look with thing_id only after choosing one body to read.', '']],
  me: [
    ['and changes since your last visit.', 'and what is new since your last visit.'],
    [' More: front_door section reading-settings.', ''],
    [` ${GAZETTE_ROOM}`, ''],
    ['into permanent city changes.', 'into permanent city updates.'],
  ],
})

export const APP_ARGUMENT_DESCRIPTION_EDITS: Readonly<Record<string, Readonly<Record<string, readonly Edit[]>>>> = Object.freeze({
  front_door: { section: [['optional section slug from /reference.txt', "optional section slug from the front door's reference index"]] },
  look: { place_id: LAST_ACTIVE_FIELD },
  browse: {
    resident_view: LAST_ACTIVE_FIELD,
    after_change_marker: [[' Use /api/changes?since= to window by change id.', '']],
  },
  found: {
    parent_id: [['for a paid frontier continent', 'for a frontier continent']],
    city_credit_request_id: [REQUEST_ID_FIELD],
  },
  place_edit: {
    city_credit_request_id: [REQUEST_ID_FIELD],
    growth_share_per_family: [['copies one family may make here', 'copies one family may produce here']],
    rough_room: [['block or send home a resident who arrives or speaks,', 'block a resident who arrives or speaks, or move them by go_home,']],
    wake_label_seconds: [['changing it changes only stickers put on afterward', 'a new value applies only to stickers put on afterward']],
  },
  invent_kind: { city_credit_request_id: [REQUEST_ID_FIELD] },
  revise_kind: { city_credit_request_id: [REQUEST_ID_FIELD] },
  make: {
    open_to_reach: [["things and laws reach", "things and law traits reach"]],
    open_to_convert: [["things and laws turn", "things and law traits turn"]],
  },
  act: { to_handle: [['recipient for give or transfer effects', 'recipient for give or for effects that hand something over']] },
  transfer: { waiting_id: [['from waiting_transfers in your me settings "show"', 'from waiting_transfers in your own private settings "show" read']] },
  agree: {
    accession_open: [['to accede when they sign.', 'to accede when they add their signature.']],
    thing_links: [['a link moves nothing and changes no terms', 'a link moves nothing and alters no terms']],
  },
  say: { walk_to_read: [['the body opens through read_here to a resident', 'the body opens only to a resident']] },
  me: {
    settings: [
      ['or false changes focus mode;', 'or false sets focus mode;'],
      ['; front_door section reading-settings says what each does', ''],
    ],
  },
})
