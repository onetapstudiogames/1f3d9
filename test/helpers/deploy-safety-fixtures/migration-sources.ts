import { readFileSync } from 'node:fs'

export const fullSchema = readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8')

export const oauthMigration = readFileSync(
  new URL('../../../db/migrations/20260813_hosted_chat_signin.sql', import.meta.url),
  'utf8',
)

export const agreementAccessionMigration = readFileSync(
  new URL('../../../db/migrations/20260814_agreement_accession.sql', import.meta.url),
  'utf8',
)

export const openToUseMigrationUrl = new URL(
  '../../../db/migrations/20260815_open_to_use.sql',
  import.meta.url,
)

export const sharedUseMayDestroyMigrationUrl = new URL(
  '../../../db/migrations/20260916_shared_use_may_destroy.sql',
  import.meta.url,
)

export const noteWalkToReadMigrationUrl = new URL(
  '../../../db/migrations/20260922_note_walk_to_read.sql',
  import.meta.url,
)

export const abilitiesWakeChanceWriteMigrationUrl = new URL(
  '../../../db/migrations/20260922_abilities_wake_chance_write.sql',
  import.meta.url,
)

export const abilitiesCopyReachConvertMigrationUrl = new URL(
  '../../../db/migrations/20260922_abilities_copy_reach_convert.sql',
  import.meta.url,
)

export const sameRoomTalkMigrationUrl = new URL(
  '../../../db/migrations/20260924_same_room_talk.sql',
  import.meta.url,
)

export const paymentAttemptsMigrationUrl = new URL(
  '../../../db/migrations/20260816_payment_attempts.sql',
  import.meta.url,
)

export const paymentResponseReplayMigrationUrl = new URL(
  '../../../db/migrations/20260816_payment_response_replay.sql',
  import.meta.url,
)

export const paymentResponseBodyReplayMigrationUrl = new URL(
  '../../../db/migrations/20260817_payment_response_body_replay.sql',
  import.meta.url,
)

export const paymentResponseBodyRolloutMigrationUrl = new URL(
  '../../../db/migrations/20260818_payment_response_body_rollout.sql',
  import.meta.url,
)

export const paymentResponseBodyValidationMigrationUrl = new URL(
  '../../../db/migrations/20260818_payment_response_body_validate.sql',
  import.meta.url,
)

export const identityRecoveryMigrationUrl = new URL(
  '../../../db/migrations/20260816_identity_recovery.sql',
  import.meta.url,
)

export const identityRotationMigrationUrl = new URL(
  '../../../db/migrations/20260816_identity_rotation.sql',
  import.meta.url,
)

export const initialRecoveryCodesMigrationUrl = new URL(
  '../../../db/migrations/20260817_initial_recovery_codes.sql',
  import.meta.url,
)

export const resumableRegistrationMigrationUrl = new URL(
  '../../../db/migrations/20260826_resumable_registration.sql',
  import.meta.url,
)

export const paymentRecoveryTriggerRepairMigrationUrl = new URL(
  '../../../db/migrations/20260823_payment_recovery_trigger_repair.sql',
  import.meta.url,
)

export const paymentLateFinalityRecheckMigrationUrl = new URL(
  '../../../db/migrations/20260825_payment_late_finality_recheck.sql',
  import.meta.url,
)
