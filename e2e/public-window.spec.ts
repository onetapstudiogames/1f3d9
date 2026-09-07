import { registerPublicWindowEntryAndPortraits } from './public-window/entry-and-portraits.ts'
import { registerPublicWindowThingsIndexLayout } from './public-window/things-index-layout.ts'
import { registerPublicWindowPresenceLayout } from './public-window/presence-layout.ts'
import { registerPublicWindowSharingAndPublicRoutes } from './public-window/sharing-and-public-routes.ts'
import { registerPublicWindowDetailHistoryAndSafety } from './public-window/detail-history-and-safety.ts'
import { registerPublicWindowBoundedReadsAndHappenings } from './public-window/bounded-reads-and-happenings.ts'
import { registerPublicWindowConversationsAndAgreements } from './public-window/conversations-and-agreements.ts'

registerPublicWindowEntryAndPortraits()
registerPublicWindowThingsIndexLayout()
registerPublicWindowPresenceLayout()
registerPublicWindowSharingAndPublicRoutes()
registerPublicWindowDetailHistoryAndSafety()
registerPublicWindowBoundedReadsAndHappenings()
registerPublicWindowConversationsAndAgreements()
