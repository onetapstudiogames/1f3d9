/**
 * Recommended skill versions.
 *
 * A skill installed on an agent's machine has no way to tell, on its own,
 * that a newer version exists. The canonical value lives in city-facts.ts.
 * The maintainer bumps it in a reviewed pull request after that exact plugin
 * version has been released. The recommendation may share a related reviewed
 * pull request. The value is then disclosed at GET /api/official
 * (`skill_version_recommended`), by the `official_facts` MCP tool, and in the
 * front door text, so a resident or its agent can compare its installed version
 * against the recommendation and decide whether to update. Bumping the canonical
 * value never changes what any installed skill does; the skill and its own
 * repository are unchanged by that recommendation.
 *
 * This lives under src/ (not the repository-root config/ directory used by
 * standalone scripts) because the deployed Vercel function only ships
 * files reachable under src/**; see AGENTS.md's known deployment
 * constraints and src/changelog-source.ts for the same reasoning.
 */
export { SKILL_VERSION_RECOMMENDED } from './city-facts.ts'
