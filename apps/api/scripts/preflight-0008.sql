-- Pre-flight for migration 0008_integrity. Read-only: every statement below is a SELECT.
--
--   psql "$DATABASE_URL" -f apps/api/scripts/preflight-0008.sql
--
-- 0008 adds a foreign key and nine CHECK constraints, and Postgres validates each of them
-- against the rows already in the table. On a database that already holds documents - dev does;
-- a fresh staging or production database has nothing to reject - one bad row refuses the whole
-- migration. A refused migration is an initContainer that never completes, which presents as a
-- deploy that hangs rather than as bad data, so probe first and read the summary.
--
-- **Every row of the summary must read `clear`.** If one does not, the fix is a decision, not a
-- delete: deploy/RUNBOOK.md §1 (*Migration workflow*) says what to do about each, and §11.1 is
-- the go-live step that calls for this pass. The detail queries below the summary hand you the
-- offending rows themselves, each labelled with the constraint it would refuse.
--
-- Safe on either side of the migration: it reads only columns that have existed since 0000, so
-- it runs against a database still at 0007 as well as one already carrying 0008 (where every
-- probe is clear by construction). Nothing here writes, so run it against a restored copy when
-- the production window is tight.
--
-- §1 and §11.1 both name five of these as the ones a real database could plausibly trip, and
-- they are marked `§11` in the summary's `named_in_runbook` column. The other five are here
-- because 0008 validates them too, and a constraint nobody warned you about is the one that
-- stops the rollout at two in the morning.
--
-- One query worth running on the same pass is deliberately **not** here: §1's check for a
-- purchase order sitting at `Received` with a rejected line. That is not a 0008 constraint, it
-- cannot refuse the migration, and its rows are a correction to make with the buyer watching
-- rather than a blocker to clear. Read it out of §1 when you run this.

-- ---------------------------------------------------------------------------------------------
-- Summary. Read this first.
-- ---------------------------------------------------------------------------------------------
with probes (constraint_name, named_in_runbook, what_would_refuse, offending) as (
  select 'stock_moves_qty_ck', '§11', 'a stock move of zero',
         (select count(*) from stock_moves where qty = 0)
  union all
  select 'reservations_ticket_fk', '§11', 'a hold pointing at a ticket that does not exist',
         (select count(*) from reservations r left join tickets t on t.id = r.ticket_id where t.id is null)
  union all
  select 'tickets_from_to_ck', '§11', 'a ticket from a location to itself',
         (select count(*) from tickets where from_loc = to_loc)
  union all
  select 'po_lines_receipt_ck', '§11', 'more rejected than received, or a negative arrival',
         (select count(*) from po_lines where rejected_qty < 0 or received_qty < 0 or rejected_qty > received_qty)
  union all
  select 'batches_made_ck', '§11', 'a batch that yielded more than it started, or less than none',
         (select count(*) from batches where made_qty < 0 or made_qty > started_qty)
  union all
  select 'reservations_qty_ck', '', 'a hold for nothing, or for a negative quantity',
         (select count(*) from reservations where qty <= 0)
  union all
  select 'tickets_otp_digits_ck', '', 'a ticket code that is not six digits',
         (select count(*) from tickets where otp !~ '^[0-9]{6}$')
  union all
  select 'requisition_lines_ordered_ck', '', 'a claim larger than what the buyer approved',
         (select count(*) from requisition_lines where ordered_qty < 0 or ordered_qty > approved_qty)
  union all
  select 'support_tickets_rating_ck', '', 'a rating outside one to five',
         (select count(*) from support_tickets where rating is not null and (rating < 1 or rating > 5))
  union all
  select 'sequences_next_ck', '', 'a series that has run back to zero',
         (select count(*) from sequences where next <= 0)
)
select constraint_name,
       named_in_runbook,
       what_would_refuse,
       offending,
       case when offending = 0 then 'clear' else 'BLOCKS 0008' end as verdict
from probes
order by offending desc, constraint_name;

-- ---------------------------------------------------------------------------------------------
-- Detail. Each returns nothing when its probe is clear.
-- ---------------------------------------------------------------------------------------------

-- stock_moves_qty_ck - a move of zero is not a movement. It reads as "this location carries the
-- line" on every stock screen without anything ever having been carried (M12).
select 'stock_moves_qty_ck' as refused_by, m.* from stock_moves m where m.qty = 0;

-- reservations_ticket_fk - a hold nothing can ever release, because the ticket that placed it is
-- not there. Closing it will raise that location's free-to-promise, so tell them.
select 'reservations_ticket_fk' as refused_by, r.*
from reservations r left join tickets t on t.id = r.ticket_id
where t.id is null;

-- tickets_from_to_ck - a ticket from a location to itself moves nothing and can never be received.
select 'tickets_from_to_ck' as refused_by, t.* from tickets t where t.from_loc = t.to_loc;

-- po_lines_receipt_ck - `received_qty` is the gross that arrived and `rejected_qty` the part of it
-- turned away, so the second can never be the larger of the two.
select 'po_lines_receipt_ck' as refused_by, l.*
from po_lines l
where l.rejected_qty < 0 or l.received_qty < 0 or l.rejected_qty > l.received_qty;

-- batches_made_ck - the ingredients went against what was started, so a yield above it would be
-- stock nothing was ever consumed for.
select 'batches_made_ck' as refused_by, b.*
from batches b
where b.made_qty < 0 or b.made_qty > b.started_qty;

-- reservations_qty_ck - a hold for nothing is not a hold.
select 'reservations_qty_ck' as refused_by, r.* from reservations r where r.qty <= 0;

-- tickets_otp_digits_ck - six digits, spelled out. Note this one reads the same before and after
-- the `char(6)` → `varchar(6)` change in 0008: the cast drops the blank padding, so a code that
-- was short is short on both sides of it.
select 'tickets_otp_digits_ck' as refused_by, t.id, t.status, t.otp
from tickets t
where t.otp !~ '^[0-9]{6}$';

-- requisition_lines_ordered_ck - a purchase order can only claim what the buyer approved.
select 'requisition_lines_ordered_ck' as refused_by, l.*
from requisition_lines l
where l.ordered_qty < 0 or l.ordered_qty > l.approved_qty;

-- support_tickets_rating_ck - five stars or none.
select 'support_tickets_rating_ck' as refused_by, s.id, s.status, s.rating
from support_tickets s
where s.rating is not null and (s.rating < 1 or s.rating > 5);

-- sequences_next_ck - a series that had run back to zero would re-issue a number already printed.
select 'sequences_next_ck' as refused_by, q.* from sequences q where q.next <= 0;
