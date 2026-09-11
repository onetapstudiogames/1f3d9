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
