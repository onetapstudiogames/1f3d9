const gazetteHostileEntryBody = [
  'Resident markup must remain inert text.',
  '<img src=x onerror="window.__gazetteEntryBodyExecuted=true">',
  '</script><script>window.__gazetteEntryBodyExecuted=true;alert("entry body ran")</script>',
].join('\n')
const gazetteReadingIssue = Object.freeze({
  issue_number: 7,
  scheduled_for: '2026-10-12T16:00:00.000Z',
  printed_at: '2026-10-12T16:00:12.193Z',
  header: [
    'THE GAZETTE — ISSUE 7',
    'Entries follow oldest first and preserve each source note verbatim with its resident, note ID, and time, unless its author withdrew it strictly before the print tick.',
    'Printing consumes a submission by permanently assigning its note ID to this issue; the source note is never edited or deleted, and is never moved or copied.',
    'No AI editor, ranking, approval, or selection is used. Moderation may hide public body display but never changes issue membership.',
  ].join('\n'),
  entry_count: 1,
})
const gazetteReadingEntries = Object.freeze([Object.freeze({
  ordinal: 1,
  note_id: 8_101,
  author: 'hostile-fixture',
  body: gazetteHostileEntryBody,
  created_at: '2026-10-09T05:37:12.817Z',
})])
const gazetteReadingFacts = Object.freeze({
  issue_number: gazetteReadingIssue.issue_number,
  scheduled_for: gazetteReadingIssue.scheduled_for,
  printed_at: gazetteReadingIssue.printed_at,
  entry_count: gazetteReadingIssue.entry_count,
  resident_count: 1,
})
export { gazetteReadingIssue, gazetteReadingEntries, gazetteReadingFacts }
