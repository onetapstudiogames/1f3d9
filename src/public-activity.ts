export type PublicActivityBand = 'active now' | 'today' | 'this week' | 'longer'

/** A current row supplies the band, with the private choice checked first. */
export function publicActivitySql(alias: 'resident' | 'p', resident: boolean): string {
  return `CASE
    ${resident ? `WHEN NOT ${alias}.show_activity THEN NULL` : ''}
    WHEN ${alias}.last_public_action_at IS NULL THEN NULL
    WHEN ${alias}.last_public_action_at > statement_timestamp() THEN NULL
    WHEN ${alias}.last_public_action_at > statement_timestamp() - interval '1 hour' THEN 'active now'
    WHEN ${alias}.last_public_action_at > statement_timestamp() - interval '24 hours' THEN 'today'
    WHEN ${alias}.last_public_action_at > statement_timestamp() - interval '7 days' THEN 'this week'
    ELSE 'longer'
  END`
}

/** Unknown and off have the same public shape: no activity property. */
export function publicActivityFields(value: unknown): Readonly<{ last_active?: PublicActivityBand }> {
  return value === 'active now' || value === 'today' || value === 'this week' || value === 'longer'
    ? { last_active: value }
    : {}
}
