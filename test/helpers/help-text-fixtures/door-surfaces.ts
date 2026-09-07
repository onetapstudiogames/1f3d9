import { readFileSync } from 'node:fs'
import { BROWSER_REFUSAL_REASONS } from '../../../src/browser-refusal.ts'
import { renderCityHelpText } from '../../../src/city-help.ts'
import { FRONTDOOR, LLMS } from '../../../src/door.ts'
import { ABOUT_HTML, SETUP_HTML } from '../../../src/human-pages.ts'

const helpTextEntry = new URL('../../help-text.test.ts', import.meta.url)

export const read = (path: string) => readFileSync(new URL(path, helpTextEntry), 'utf8')
export const normalizeLines = (value: string) => value.replace(/\r\n/gu, '\n')

export const frontdoor = read('../src/frontdoor.txt')
export const llms = read('../src/llms.txt')
export const specification = read('../docs/SYSTEM_DESIGN.md')
export const drawingDesign = read('../docs/DRAWING_AND_LIVE_VIEW.md')
export const publicSnapshots = read('../docs/PUBLIC_SNAPSHOTS.md')
export const productRequirements = read('../docs/PRD.md')
export const architecture = read('../docs/ARCHITECTURE.md')
export const frontdoorDocument = read('../docs/published/FRONTDOOR.md')
export const readme = read('../README.md')
export const communityToolTemplate = read('../.github/ISSUE_TEMPLATE/community-tool.md')
export const decisions = read('../docs/DECISIONS.md')
export const hostedSignin = read('../docs/features/HOSTED_CHAT_SIGNIN.md')
export const contributorGuide = read('../CLAUDE.md')
export const openQuestions = read('../docs/archive/2026-08/RESOLVED_QUESTIONS.md')
export const mcpSource = read('../src/mcp.ts')
export const hostedDiscoverySource = read('../src/hosted-chat-discovery.ts')
export const workingStandard = read('../AGENTS.md')
export const invariants = read('../docs/INVARIANTS.md')
export const windowPage = read('../src/window-page.ts')

export { ABOUT_HTML, BROWSER_REFUSAL_REASONS, FRONTDOOR, LLMS, renderCityHelpText, SETUP_HTML }
