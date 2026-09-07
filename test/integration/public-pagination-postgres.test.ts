import { registerMigrationsTests } from './public-pagination-tests/migrations.ts'
import { registerSearchTests } from './public-pagination-tests/search.ts'
import { registerChangesTests } from './public-pagination-tests/changes.ts'
import { registerAdmissionAndPaginationTests } from './public-pagination-tests/admission-and-pagination.ts'
import { registerDenseRoomTests } from './public-pagination-tests/dense-room.ts'
import { registerZeroFitRoomTests } from './public-pagination-tests/zero-fit-room.ts'
import { registerOutlineRoomsTests } from './public-pagination-tests/outline-rooms.ts'
import { registerWriterMeterTests } from './public-pagination-tests/writer-meter.ts'
import { registerResidentsAndMapTests } from './public-pagination-tests/residents-and-map.ts'
import { registerWindowTests } from './public-pagination-tests/window.ts'
import { registerTotalsAndCatalogsTests } from './public-pagination-tests/totals-and-catalogs.ts'
import { registerEventFiltersTests } from './public-pagination-tests/event-filters.ts'
import { registerInsidePlaceHistoryTests } from './public-pagination-tests/inside-place-history.ts'
import { registerLookupAgreementsContextTests } from './public-pagination-tests/lookup-agreements-context.ts'
import { registerPublicPaginationTests } from '../helpers/public-pagination-fixtures/postgres.ts'

registerPublicPaginationTests(async function registerPaginationConcernTests(t, postgres, city) {
  await registerMigrationsTests(t, postgres, city)
  await registerSearchTests(t, postgres, city)
  await registerChangesTests(t, postgres, city)
  await registerAdmissionAndPaginationTests(t, postgres, city)
  await registerDenseRoomTests(t, postgres, city)
  await registerZeroFitRoomTests(t, postgres, city)
  await registerOutlineRoomsTests(t, postgres, city)
  await registerWriterMeterTests(t, postgres, city)
  await registerResidentsAndMapTests(t, postgres, city)
  await registerWindowTests(t, postgres, city)
  await registerTotalsAndCatalogsTests(t, postgres, city)
  await registerEventFiltersTests(t, postgres, city)
  await registerInsidePlaceHistoryTests(t, postgres, city)
  await registerLookupAgreementsContextTests(t, postgres, city)
})
