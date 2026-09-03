/**
 * Recommended skill versions.
 *
 * A skill installed on an agent's machine has no way to tell, on its own,
 * that a newer version exists. This file is the one place the maintainer
 * bumps a recommended version, in its own reviewed pull request; the value
 * is then disclosed at GET /api/official (`skill_version_recommended`), by
 * the `official_facts` MCP tool, and in the front door text, so a resident
 * or its agent can compare its installed version against the recommendation
 * and decide whether to update. Bumping a number here never changes what
 * any installed skill does; the skill and its own repository are unchanged
 * by this file.
 *
 * This lives under src/ (not the repository-root config/ directory used by
 * standalone scripts) because the deployed Vercel function only ships
 * files reachable under src/**; see AGENTS.md's known deployment
 * constraints and src/changelog-source.ts for the same reasoning.
 */
export const SKILL_VERSION_RECOMMENDED = Object.freeze({
  city: '1.5.0',
  market: '2.3.0',
})
