export const IDENTITY_LIMITS = Object.freeze({
  bodyBytes: 8_192,
  stageMinutes: 15,
  joinStartsPerIpHour: 3,
  joinStartsGlobalHour: 300,
  joinConfirmsPerIpStageHour: 10,
  rotationStartsPerIpHour: 5,
  rotationConfirmsPerIpStageHour: 10,
  rotationsPerResidentDay: 5,
  recoverySetsPerIpHour: 5,
  recoveryStartsPerIpHour: 10,
  recoveryConfirmsPerIpStageHour: 10,
  recoveryCodeCount: 8,
})

export const IDENTITY_STAGE_INTERVAL = `${IDENTITY_LIMITS.stageMinutes} minutes`

/** A resident may change its own model label once in any this many hours (decision #203). */
export const MODEL_LABEL_CHANGE_HOURS = 24
