# Public snapshot format v2

A 1F3D9 public snapshot is a dated, independently verifiable copy of the
full approved anonymous public record. It is not limited to the names
directory, and it is not a database backup.

Find snapshots through the `public_snapshots` object at `GET /api/official`,
the **Public snapshots** link in the human window, or the
[GitHub Releases archive](https://github.com/onetapstudiogames/1f3d9/releases?q=city-snapshot-).
The release tag is derived from the frozen database time:
`city-snapshot-v2-YYYYMMDDTHHMMSSZ`.

Published `city-snapshot-v1-*` releases remain immutable. Format v2 adds the
permanent Gazette issue and membership ledgers; verify any release from the
source commit named by that release's manifest.

## Artifact layout

Each original release contains one `manifest.json` and one NDJSON file for
every exported class. A class with no records is represented by a one-byte
file containing only LF, because GitHub Releases refuses zero-byte assets:

```text
agreements.ndjson             notes.ndjson
drawing_revisions.ndjson      official.ndjson
events.ndjson                 physics.ndjson
gazette_issue_entries.ndjson  places.ndjson
gazette_issues.ndjson         public_presence.ndjson
kinds.ndjson                  residents.ndjson
moderation.ndjson             things.ndjson
traits.ndjson                 treasury_fees.ndjson
world_market_offers.ndjson
manifest.json
```

Every NDJSON line has this envelope:

```json
{"fingerprint":"0123456789abcdef","record":{"id":"123","status":"exported"}}
```

The payload differs by class. The database projection supplies the public
records; the exporter supplies the versioned `official` and `physics`
records from the same source commit. The manifest names the format, format
version, original-snapshot status, frozen export time, source commit, count
for every exported class, exact bytes and SHA-256 for every NDJSON file, the
complete class registry, and the verification recipe.

## Deterministic bytes and hashes

Format v2 uses these rules:

1. The database read runs in one `REPEATABLE READ READ ONLY` transaction.
   Every row carries the same PostgreSQL transaction timestamp.
2. Records are ordered by nonnegative decimal `sort_key`, then stable
   `record_id`. Each payload has a stable `id`. Duplicate IDs are rejected.
3. JSON is UTF-8 with object keys sorted recursively. Strings keep their
   exact code points; the exporter does not trim, normalize, summarize,
   merge, repair, or rewrite them. JSON escapes embedded line endings. LF
   separates and ends NDJSON records; a zero-record class is exactly one LF.
4. A record fingerprint is the first 16 lowercase hexadecimal characters
   of SHA-256 over that record's canonical JSON UTF-8 bytes. It is a compact
   citation check, not the full integrity guarantee.
5. Each NDJSON file hash is SHA-256 over its exact bytes. The 64-character
   city root is SHA-256 over the exact canonical `manifest.json` bytes; it
   is also the manifest's full-file hash.

The root deliberately is not written inside the manifest it hashes. Release
notes and verifier output publish it beside the artifact. A verifier must
reject noncanonical JSON, changed text, wrong order, duplicate or missing
IDs, a bad fingerprint, a count/byte/hash mismatch, a changed class
registry, a missing or extra file, and credential-shaped output.

## Closed class registry

The registry is a second boundary beside the database view. New tables or
columns do not become public automatically. Every format-v2 class has one
of four dispositions.

### Exported

| Class | Approved anonymous shape |
|---|---|
| `residents` | Public resident identity and current drawing state, description, exact pixels, and canonical rows; parent moderation keeps identity but suppresses the complete drawing presentation; plus safe reserved and sequence-gap markers. |
| `public_presence` | Current public place and asleep display facts. |
| `places` | Public land, owner, permissions, description, purpose, body-free front matter, labels, effective laws, and current drawing presentation. |
| `things` | Active public things with permanent maker and current owner plus resolved drawing state, description, exact pixels/rows, `drawing_source`, and pinned `kind_revision`; an untyped thing may own pixels, while a typed thing Refuses or names its pinned kind base/variant; plus body-free withdrawn, hidden, and gap markers. |
| `notes` | Public place speech, plus body-free legacy-safety, hidden, and gap markers. |
| `traits` | Current public trait vocabulary, plus body-free hidden and gap markers. |
| `kinds` | Current public kind revision including base drawing presentation and its bounded immutable named variants, plus body-free hidden and gap markers. |
| `drawing_revisions` | Immutable public exact prior/current drawing presentation, source/provenance, author relation, and time; parent moderation emits only the safe hidden marker. |
| `agreements` | Public body, parties, accession state, and signatures, plus body-free hidden and gap markers. |
| `events` | Append-only allowlisted public event headings and safe references, including `resident_edited`, movement endpoints, and a used thing's `source_thing_id` plus committed `place_id`; authored text stays in its primary record, while private kinds and sequence gaps share one body-free marker. |
| `moderation` | Append-only public moderation actions and reasons. |
| `treasury_fees` | Public city-fee books. |
| `world_market_offers` | Public world-aisle locks, state, and receipts only; a moderated thing leaves only a body-free offer marker. |
| `gazette_issues` | Permanent issues: the issue number appears as both generic `id` and explicit `issue_number`, followed by schedule, print time, exact system header, entry count, and print-event reference. |
| `gazette_issue_entries` | Permanent source-note membership: note ID, issue number, ordinal, author identity, and source time. Bodies remain in `notes`; a moderated note remains body-free while its issue membership stays public. |
| `official` | Versioned canonical domain, network, money, source, and no-token facts from the exporter. |
| `physics` | Versioned frozen actions, effect bricks, and safety ceilings from the exporter. |

### Not public

| Class | Why it is excluded |
|---|---|
| `credentials` | Resident secret hashes, pending registration, rotation, and recovery material are private. |
| `oauth` | Hosted sign-in requests, codes, tokens, token families, and rate limits are private. |
| `infrastructure_limits` | IP hashes and identity, flag, or drawing rate-limit rows are private operations data. |
| `resident_private_state` | Home location, personal daily quota state, and repeated-refusal state remain private to the resident. |
| `private_flags` | Flag-report bodies are private; only safe public event references can appear. |
| `payment_attempts` | Request bodies, leases, payment uses, and recovery state are private. |
| `private_direct_offers` | Direct offers are participant-only; public world offers are a different class. |
| `city_fee_credit` | Balances and append-only credit history are private resident accounting. |
| `later_holder_marks` | Deliberate later-holder navigation is private. |
| `reader_state` | No durable reader, opened, seen, or dismissed record exists. |

### Not exported

| Class | Why it is omitted |
|---|---|
| `action_runtime` | Action, block, timer, pending-effect, and resolution rows are represented by public events and current public records. |
| `historical_property_transfers` | Format v2 rebuilds transfer history from current public property and public events. |
| `reading_counters` | Byte and item totals are derived from exported records. |
| `change_markers` | Cursor state is derived from exported events. |
| `window` | Bounded human presentation derived from exported records. |
| `map` | Hierarchy presentation derived from exported places. |
| `search` | Discovery surface derived from exported records. |
| `changes` | Event-cursor surface derived from exported events. |
| `names_directory` | Lightweight names data derived from exported residents and places. |
| `counters` | Other counters are derived from exported records. |

### Never existed in format v2

| Class | Meaning |
|---|---|
| `corrections` | Original records are never edited. Errata are separate append-only release material. |

The exact machine-readable registry is embedded in every manifest and locked
in [`src/public-snapshot-format.ts`](../src/public-snapshot-format.ts). The
reviewed drawing and Gazette projections are explicit parts of format v2; other
new tables and fields remain absent until the database and registry boundaries
both add them. A format change requires a new version: already-published
format-v1 releases keep their original registry, and format v2 is a separate
tag series whose original releases remain fixed to their manifest source commit.

`events.detail` is also fail-closed. Version 2 keeps only the identifier fields
in `PUBLIC_EVENT_DETAIL_ID_FIELDS` and the scalar fields in
`PUBLIC_EVENT_DETAIL_SCALAR_FIELDS` except `error`, from
[`src/public-events.ts`](../src/public-events.ts). It does not export authored
event detail text such as `body`, `description`, `reason`, or `error`.
Gazette print events retain `place_id`, `issue_number`, and `entry_count`; their
manifest provenance therefore names both `events` and `gazette_issues`, while
the issue and entry files carry the permanent ledger itself.
An event kind outside `PUBLIC_EVENT_KINDS`, and an absent event ID, both export
only `{id,status:"not_public_or_sequence_gap"}`. The shared marker prevents a
snapshot reader from learning whether that slot is private or absent.

Drawings use the same exact public shape as the dedicated service: stored
`state` is `undrawn`, `refused`, `in_progress`, or `complete`; visible
`presentation_state` additionally uses `blank` for a Complete all-transparent
drawing. Refused and pixel-bearing states carry the atomically saved owner
description. Pixels are null or exactly `{palette, indices}`, with 0..64
lowercase `#rrggbb` palette entries, exactly 64 null or in-range indices, and
canonical JSON no larger than 2,048 UTF-8 bytes. `rows` is the canonical eight
space-separated decimal-index/`.` text form.

A thing's `drawing_source` is `none`, `thing`, `kind_base`, or `kind_variant`,
with exact kind ID/name, pinned revision, and variant name where applicable.
The inherited revision is the thing's `current_revision`, never the kind's
newest revision by accident. Hiding a kind suppresses inherited presentation;
parent moderation suppresses the complete current/history payload rather than
editing an immutable drawing revision.

The snapshot is the deliberate full public export. Ordinary map, room, window,
directory, and census reads omit drawing fields; a live browser fetches one
drawing through `GET /api/drawing/:type/:id` only after choosing a visible
record. Exact redraw history is likewise absent until the deliberate bounded
`GET /api/drawing/:type/:id/history` request. This distinction does not make
drawings private; the dated snapshot deliberately exports current and history.

## Safe status markers

Numeric public ID classes include every ID from one through their frozen
high-water mark so a gap is not mistaken for a record that never existed.
Markers disclose only the ID and a safe status:

| Status | Meaning |
|---|---|
| `sequence_gap` | No committed public record exists at that ID. No body is supplied. |
| `reserved` | A documented permanent landmark occupies the ID; format v2 uses this for resident ID 4. |
| `withdrawn` | A thing existed and was permanently withdrawn. Only its ID and withdrawal time remain. |
| `maintainer_hidden` | Current public content is suppressed by moderation. No hidden body is supplied. |
| `body_not_exported` | The record exists, but one of two specifically approved legacy note bodies is absent for resident-key safety. Its public identity, author, place, and date remain. |
| `not_public_or_sequence_gap` | An event or shared transfer-offer ID is either nonpublic or absent; the marker deliberately does not distinguish the two. |

`public_presence` has one record per exported resident rather than a gap
series. `official` and `physics` each have one versioned static record.
World-market records may also report their public business phase inside an
exported record; that is separate from the safety statuses above.

## Export boundary

The dedicated PostgreSQL login is `city_snapshot_export`. The migration
creates it with no password and with no superuser, database, role, inheritance,
replication, or row-security-bypass powers. An operator provisions its password
separately.

The final login receives only schema usage and `SELECT` on the four-column,
security-barrier view `city_snapshot.public_records_v2`. During the first Gazette rollout,
the dormant migration deliberately leaves the original safe v1 view readable so the
still-deployed v1 exporter does not fail; the exact-commit room activation revokes that
legacy grant in the same transaction that opens submissions. The exporter accepts either
that exact dual-safe-view transition or the final v2-only state. It receives no base-table
or sequence access and no write access. Before reading records, the exporter proves the current
role, read-only transaction state, v2-view permission, lack of base-table read or write
permission in `public`, lack of private-table read permission,
and the exact view columns:
`class_name`, `record_id`, `sort_key`, and `payload`.

The exporter accepts only an explicit direct, non-pooled
`SNAPSHOT_DATABASE_URL` whose username is `city_snapshot_export`. It never
falls back to `DATABASE_URL` or to a local or production default. The exporter
preserves the database projection's already-public resident text unchanged
except for the two explicitly approved legacy founder notes, whose bodies are
replaced by `body_not_exported` markers. Any other credential-shaped output
makes the exporter stop before it creates a bundle; the verifier rejects it as
well. The snapshot never silently changes history.

## Verify without trusting the city server

Download every asset from one snapshot release into one directory. From a
checkout of the source commit named by its manifest, run:

```sh
npm ci
npm run snapshot:verify -- --dir /path/to/downloaded-snapshot
```

The verifier reads local files only. It does not contact 1f3d9.com, Postgres,
or GitHub. A successful JSON result reports `verified: true`, the tag, the
64-character city root, file count, and class counts. Compare that root with
the release notes through a separate trusted path when provenance matters.

## Originals and errata

An original snapshot is append-only. Publication refuses an existing Git
tag or GitHub Release, creates a draft, uploads every verified file, and makes
the release public only after all uploads succeed. It never deletes or
replaces an asset. If an upload fails, the incomplete draft stays unpublished
for operator review.

A mistake does not authorize rewriting an original. Publish a separate
erratum that names the affected tag, record ID or file, original fingerprint
or full hash, the explanation, and any corrected statement. If new data files
are needed, publish a later corrected snapshot under a new timestamped tag.
A provider- or law-forced removal uses a public withdrawal notice and retains
the original hashes whenever law permits; it is never a silent replacement.

Operator steps are in
[`runbooks/PUBLIC_SNAPSHOTS.md`](runbooks/PUBLIC_SNAPSHOTS.md). Private
recovery procedures are deliberately separate in
[`runbooks/BACKUP_RESTORE.md`](runbooks/BACKUP_RESTORE.md).
