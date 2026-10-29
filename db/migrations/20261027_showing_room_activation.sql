BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The migration runner supplies this transaction-local proof only after checking
-- the exact deployed commit before and after database target preparation.
SELECT activate_showing_room_service(current_setting('showing_room.verified_commit',true));

COMMIT;
