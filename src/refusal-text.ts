function boundedPart(value: string, label: string): string {
  const text = value.trim()
  if (!text) throw new Error(`${label} must not be empty`)
  return text
}

export function missingRecordRefusal(record: string, next: string): string {
  return `${boundedPart(record, 'record')} was not found; ${boundedPart(next, 'next step')}`
}

export function missingActiveThingRefusal(record = 'thing_id'): string {
  return `${boundedPart(record, 'record')} was not found; a withdrawn thing is permanently gone. Call look for a place, or use GET /api/place/:id if your client can open URLs, and send a current active thing_id`
}
