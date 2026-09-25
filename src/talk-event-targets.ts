// Pure SQL and event-kind facts for moderated talk. This file imports nothing, so
// public read builders such as public-pagination.ts can use it without loading the
// resident, input, or database modules.
export type TalkTargetType = 'line' | 'ping'

export const TALK_EVENT_TARGETS = Object.freeze({
  line_said: Object.freeze(['line', 'line_id'] as const),
  ping_sent: Object.freeze(['ping', 'ping_id'] as const),
  ping_answered: Object.freeze(['ping', 'ping_id'] as const),
})

export function talkEventRemovedSql(eventAlias: string): string {
  const targets = Object.entries(TALK_EVENT_TARGETS)
  const targetTypeCases = targets.map(([kind, [targetType]]) => (
    `WHEN '${kind}' THEN '${targetType}'`
  )).join('\n')
  const targetIdCases = targets.map(([kind, [, idField]]) => (
    `WHEN ${eventAlias}.kind = '${kind}' AND ${eventAlias}.detail ->> '${idField}' ~ '^[0-9]{1,9}$' THEN (${eventAlias}.detail ->> '${idField}')::integer`
  )).join('\n')

  return `EXISTS (
    SELECT 1
    FROM moderation_actions action
    WHERE action.target_type = CASE ${eventAlias}.kind
      ${targetTypeCases}
    END
      AND action.target_id = CASE
        ${targetIdCases}
      END
      AND action.action = 'remove'
      AND action.id = (
        SELECT latest.id
        FROM moderation_actions latest
        WHERE latest.target_type = action.target_type
          AND latest.target_id = action.target_id
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
  )`
}
