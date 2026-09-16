-- A consultant is a fourth kind of payer, alongside the in-patient, the member of staff and the
-- cost centre. On its own in this file on purpose: Postgres will run `alter type ... add value`
-- inside a transaction, but it refuses any statement in that same transaction that *uses* the
-- value it just added. Everything that names a doctor - the rate card's seed rows, the payer
-- register - is therefore in 0022.
ALTER TYPE "payer_kind" ADD VALUE IF NOT EXISTS 'doctor';
