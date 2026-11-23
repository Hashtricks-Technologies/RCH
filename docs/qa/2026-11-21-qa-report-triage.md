# QA observation reports of 21-Nov-2026 - triage

**Validated:** 23-Nov-2026, against https://rch.hashtrickstechnologies.com (`develop` at `2016e9e`) and the
code at the same commit.
**Reports triaged:**

| Code | File | Outlet / counter | Tester's account |
|---|---|---|---|
| **A** | `issue 3.pdf` | Restaurant (OT-R1), Billing 1 | RC-0012 |
| **B** | `snack.pdf` | Snack Kiosk (OT-GK) | - |
| **C** | `inventoryerror.pdf` | Snack Kiosk (OT-GK), Billing-2 | RC-0013 |

## Summary

The three reports hold about 80 observations, plus two test checklists and a list of 25 suggested
improvements. Many observations describe the same cause seen on different screens, so after
de-duplication they come down to **23 distinct findings**:

| Verdict | Count | IDs |
|---|---|---|
| **Valid - software defect or display inconsistency** | **8** | V1-V8 |
| ↳ already fixed on live since the test (PR #43, merged 23-Nov 00:00 IST) | 2 | V1, V4 |
| ↳ still open | 6 | V2, V3, V5, V6, V7, V8 (data) |
| Not reproducible (device clock) | 1 | V9 |
| Expected behaviour - works as designed | 14 | E1-E14 |
| Feature requests and test checklists (not defects) | - | backlog below |

The analysis also turned up **7 defects QA did not report**, X1-X4 and X6-X9; X5 needed no change (see
below). X9 is the most serious: a voided settlement left the bills it had closed looking settled.

**The root cause behind most of the "mismatch" reports is operational, not a code bug: no Z-report has
ever been taken.** No register session at any outlet has been closed:

| Outlet | Register session open since | Bills in that session |
|---|---|---|
| Coffee Shop - 1 | 28-Sep-2026 21:27 | 55 |
| Restaurant | 12-Nov-2026 14:42 | 8 |
| Snack Kiosk | 15-Nov-2026 17:36 | 5 |

A register runs Z to Z, not midnight to midnight. So every screen that counts "this session" reaches
back days or weeks, while screens that count "today" or "this shift" do not. No seeded role holds Z
reports, so only the super admin can close the day (Admin → Registers).

## How the validation was done

- **Code:** every observation was traced through the code to the figure on screen (file:line below).
- **Live, read-only:**
  - The super admin read each outlet's X report and Z list, the accounts and the roles.
  - Three temporary accounts were created to see the screens through each role's eyes, and were
    deactivated and deleted afterwards: a Restaurant counter, a Snack Kiosk counter and an Outlet
    Manager.
  - Nothing was sold, requested, approved, closed or settled.
  - Each screen's figures were recomputed from the raw API responses (`/register/x`,
    `/bills?days=90`, `/receivables`, `/requests`, `/prod-orders`, `/tickets`, `/items`).
- **Evidence:** screenshots are kept outside the repository, because they show live staff and payer
  names.

## Valid findings

### V1 - Dashboard and Register disagree on the session's takings. FIXED on live (PR #43)

**Seen in:** A1.1-6 (Dashboard ₹285 / 3 bills vs Register ₹1,078 / 8), B "Billed this session ₹4,103 …
Bills: 4, actual 5", C1.1-3.

**Cause:** both dashboards summed the bills held in the browser, which are only the last `BILL_DAYS = 7`
days (`packages/contract/src/schemas/snapshot.ts:58`). The Register counts by register session with no
time limit (`apps/api/src/modules/register/repo.ts:47-58`).

**Live evidence:**
- **Restaurant:** the session opened 12-Nov. Its bills are 3 on 16-Nov (₹205 + ₹20 + ₹60 = **₹285**,
  all cash) plus 5 on 12-13 Nov. On 21-Nov only the 16-Nov three were inside the 7-day window, which
  matches report A to the rupee. The Register's 8 bills come to ₹1,078 (cash ₹575, UPI ₹470, staff
  credit ₹33).
- **Snack Kiosk:** report B's ₹4,103.20 is exactly the session without its first bill (CF/1232, ₹495,
  15-Nov 17:36), which had just aged out of the window. The fifth bill (CF/1259, ₹120, 21-Nov 23:02)
  is the "actual 5".

**Fix:** `1ed1adc` (PR #43) takes billed, cash, card/UPI, charged, bill count and average from the X's
own totals. Verified on live on 23-Nov: the Restaurant reads ₹1,078 / 8 and the kiosk ₹4,598 / 5 on
both the dashboard and the Register. What remains is **X8**.

### V2 - Bills screen shows "No bill raised at this counter today" while the dashboard shows the session's bills. OPEN

**Seen in:** A2, C9.1-4, C12 (Bills screen with zero records).

**Cause:** `UI/src/roles/counter/Bills.tsx:33-35` filters on `isToday(b.iso)`, the IST calendar day.
The dashboard and the Register count the open register session. A session that started on an earlier
day therefore shows its bills on the dashboard but not on Bills.

**Live evidence:** on 23-Nov, the kiosk dashboard shows 5 bills / ₹4,598, and Bills shows "No bill
raised at this counter today", "Billed ₹0".

**Fix:**
- Default the counter's Bills screen to the open register session, the same `openedAt` window the
  dashboard reads off `readXReport`.
- Add a *This session / Today* switch.
- Have the empty state name its window ("No bill in this register session - open since 15-Nov 17:36").
- A role without X reports keeps *Today*.
- When the session reaches back past the 7 days of bills the browser holds, read them with
  `GET /bills?days=N` (the route already accepts up to 90) rather than showing a partial list.

### V3 - Whole-rupee tiles next to two-decimal detail. OPEN

**Seen in:** B4, B6, B "₹4,103 vs ₹4,103.20", C1.6, C1.7, C6.1-2, C6.7.

**Cause:** the headline tiles use `money0`, which rounds to whole rupees, while the detail lines and
the slips use `money`:
- `UI/src/ui/RegisterPanel.tsx`: Nett sales, Collected, Credit sales, Old bills and Tax;
- `UI/src/roles/counter/Dashboard.tsx:165-169`: Billed, Cash and Average.

The SGST/CGST split itself is correct. The second half is the remainder, so the two lines always add
up to the tax total (`apps/api/src/modules/register/service.ts:59-62`).

**Live evidence (kiosk, 23-Nov):**
- Nett ₹4,598 vs ₹4,598.20.
- Tax ₹211 vs SGST ₹105.43 + CGST ₹105.43 = ₹210.86.
- Average ₹920 vs ₹919.64.

**Fix:**
- Print takings and tax figures with `money` (two decimals) on the Register and on both dashboards.
- Separately, the till prints `money(tax / 2)` for both GST lines (`UI/src/roles/counter/Pos.tsx:435-436`),
  which can differ by a paisa from the register's split. Move the split into one `@rch/domain` helper
  that the server and the till both call.

### V4 - Register reads "7 tenders" for 4 bills. FIXED on live (PR #43)

**Seen in:** B5, C6.3, C12 issue 3.

**Cause:** the tile printed `tenders.length`, and the X lists every tender type, used or not, so it
always printed 7. A bill carries exactly one tender (`bills.tender`); there is no split payment.

**Fix:** `1ed1adc` names the tenders that took money. Live now reads "Collected ₹4,598 · Cash".

### V5 - "Open stock requests" leaves out kitchen orders. OPEN

**Seen in:** A3.3 (dashboard shows zero open requests while one is visible).

**Cause:**
- The counter dashboard counts only central-store requests (`UI/src/roles/counter/Dashboard.tsx`
  `openReq`).
- Kitchen orders (`PRD-…`) are counted on no dashboard and no footer.
- The counter's two screens also use different "open" rules: the dashboard says *not settled*, and
  the Requests footer uses `isReqOpen` (`UI/src/lib/selectors.ts:370`), which means *still
  cancellable*.

**Live evidence:**
- **Restaurant:** "Requests raised 1 · 0 still open", which is correct for REQ-2026-0916 (Closed).
  But kitchen order **PRD-2026-034** has been *New* since 17-Nov and is counted nowhere.
- **Snack Kiosk:** 7 kitchen orders (PRD-2026-035 … 041) have been *New* since 21-Nov, and none is
  counted.

**Fix:**
- Add one predicate in `@rch/domain` for "still in progress" (any request status that is not final in
  `REQUEST_TRANSITIONS`) and use it on both counter screens.
- Add a "Kitchen orders open" figure next to it (New, Accepted, In kitchen, Ready).
- Label the bell badge and the manager queue "awaiting approval", which is what they count.

### V6 - Credit: "45%" read as credit utilisation. OPEN (labelling)

**Seen in:** B3, C7.7-8.

**Cause:** the column headed **On** (`UI/src/roles/manager/Credit.tsx:232,254`) prints the payer's
discount rate and credit ceiling. For payer STF1 these are a personal 45% discount and a ₹10,000 limit,
set as an exception over the staff category's 10% and ₹3,000. Nothing on the screen shows utilisation.
462 / 10,000 = 4.62% would be correct if it did.

**Fix:**
- Head the column "Discount · Limit".
- Print it as "45% off · ₹10,000 limit · ₹9,538 left", using `creditRoom` from `@rch/domain`.

### V7 - "Products switched off" counts out-of-stock items, and lists only four reasons. OPEN

**Seen in:** B8, C1.10, C2.5.

**Cause:**
- The counter dashboard counts every menu item `availOf` refuses. That includes items that simply
  have no stock (`UI/src/roles/counter/Dashboard.tsx` `off`).
- The reason list is an `AlertStack`, capped at 4 with "…and N more." (`UI/src/ui/kit.tsx:436-452`),
  and nothing opens the rest.

**Live evidence:** the kiosk shows "22 of 94 switched off". 1 is switched off by hand (Bisuits
(Sunfeast)) and 21 are out of stock. The manager dashboard already splits them: "1 switched off · 21
out of stock".

**Fix:**
- Rename the tile "Products unavailable".
- Show the same *switched off / out of stock* split the manager dashboard does.
- Make "…and N more" open Stock in Hand filtered to *Low & out*.

Availability does flip automatically when stock reaches zero or returns; nothing is stored (B8's
question).

### V8 - Misspelt and misclassified items in the item master. OPEN (data, not code)

**Seen in:** B (Bisuits, Sanwidges, Coco cola, Pomogranate, VANNILA).

**Cause:** these names were typed into the live item master. None of them is in the code or the seed
data, and the live box was seeded `--bare`.

| Item code | Type | Name on live | Should read |
|---|---|---|---|
| `BISUITSSUNFE` | MRP | Bisuits (Sunfeast) | Biscuits (Sunfeast) |
| `SANWIDGES` | FG | Sanwidges | Sandwiches |
| `SANDWIDGES` | FG | SANDWIDGES | Sandwiches (a duplicate of the line above - retire one) |
| `FG-4001` | FG | Coco cola ½ lit | Coca-Cola ½ litre |
| `MT-5059` | MTO | Pomogranate juice | Pomegranate juice |
| `FG-4012` | FG | MM FRENCH VANNILA | MM French Vanilla |

**Second data issue, which matters more:** several bought, packaged goods are typed **FG** (made in our
own kitchen) instead of **MRP**: Coco cola ½ lit, Good Day Fruit & Nuts, Marigold 43G, Milkbikis,
Banana Chips, Masala Tapioca Chips and others. Because of that:
- a counter's request for them goes to the **kitchen**, not the central store, which is why the
  kiosk's seven orders sit *New* on the kitchen board;
- they carry the "batch" tag (C2.16);
- they cannot be bought on a purchase order.

**Fix:**
- The Store Keeper (item master) corrects the names in the item drawer, or the Outlet Manager sets a
  counter display name.
- The type of an item already in use cannot be changed in place. Open each packaged good again as an
  MRP item with its printed price, move the menu listing, and retire the FG item once nothing holds it.

### V9 - Credit "oldest bill 17-Sep-2026, 302 days old". NOT REPRODUCIBLE

**Seen in:** B1, C7.6.

**What we found:**
- Live on 23-Nov shows "17-Sep-2026 · **67 days old**" for both payers, which is correct.
- The formula (`UI/src/roles/manager/Credit.tsx:57-59`) computes the age in the **browser**, from the
  device's clock, and gives 65 on 21-Nov.
- Both payers' oldest bills fall on 17-Sep, so one wrong device clock explains the same 302 on both
  rows. 17-Sep + 302 days = 16-Jul-2027, so the testing device's clock was most likely set wrong.

**Hardening (recommended):** have the server send the age in IST days with the receivables
(`apps/api/src/modules/receivables/service.ts`), so a device clock can no longer change it. Add a test
pinned to 21-Nov that expects "65 days old".

## Defects found during the analysis (not in the reports)

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| **X1** | Credit "Open bills" and "Oldest" also count bills that are already settled. That contradicts the contract ("how many bills are still open … absent when nothing is open"). It will show after the first settlement; live has none yet. | `apps/api/src/modules/receivables/repo.ts:63-72` | Count, and take the oldest, only over bills with an unsettled balance, with the same rule as `openBillsFor` (`apps/api/src/lib/credit.ts`). |
| **X2** | Days of cover becomes a huge number for an item held with no par. | `UI/src/lib/selectors.ts:338-339` | Show "-" when par is 0. |
| **X3** | The Stock in Hand footer always reads "Showing N of N", even when a filter hides cards. | `UI/src/roles/counter/Stock.tsx:203` | Print the unfiltered count second. |
| **X4** | Pick Tickets adds approved quantities across different units, and shows real names where a counter screen should show its display names. | `UI/src/roles/counter/Tickets.tsx:106,116` | `unitTotal`, `counterNameOf`. |
| **X6** | The stock request's *Submit* is greyed out until the quantity box is left, so a press made straight after typing is lost. This is the trap `UI/CLAUDE.md` names. | `UI/src/roles/counter/Requests.tsx:296` | `<span onMouseDown={commitTyping}>`, and refuse an empty request in the handler with a sentence. |
| **X7** | The manager dashboard prints "since it first opened, 09:33" (the current time) for an outlet with no open session. Every session window is printed with no date, so a session open since 28-Sep reads "21:27". | Live, 23-Nov: Coffee Shop 2-5 · `UI/src/roles/manager/Dashboard.tsx:126-131`, `UI/src/roles/counter/Dashboard.tsx` `since` | Check `sessionId` ("nothing open"). Print the date and time of the session's opening, the way the Register does (`stamp`). |
| **X8** | After PR #43, when every bill in a session is older than the browser's 7 days, the counter dashboard says "8 bills raised" next to "Nothing billed in this session", "Nothing billed at this counter yet" and "last bill -". | Live, 23-Nov, Restaurant | Read the session's bills (`GET /bills?days=N`, N = the session's age, at most 90) for Items sold, Top 5 and Last 5. Where they still fall short, the empty states say the session's bills are older than the window, not that nothing was billed. |

| **X9** | **Voiding a settlement did not reopen the bills it closed.** `openBillsFor` summed every settlement line on a bill, including the lines of a voided settlement. The balance came back ("owes ₹200 again"), but the statement listed no open bill, and the next payment had nothing to land on. Found while fixing X1; the existing test checked the balance only. | `apps/api/src/lib/credit.ts` (`openBillsFor`); reproduced by a test that failed before the fix | Sum only lines whose settlement is live (`filter (where settlements.id is not null)`). |

(X5 - the counter dashboard gated on X reports but not on Bills - needs no change: since PR #43 the
takings come from the X itself.)

## Expected behaviour (not defects)

| ID | Observation | Why it is correct |
|---|---|---|
| E1 | Close Shift shows ₹0.00 and 0 bills while the dashboard shows ₹4,478.20 (C1.1-4, C5.1-3, C12 issue 1) | A shift is **one operator's own bills, at this counter, since they signed in** (`apps/api/src/lib/shifts.ts:51-82`). RC-0013's shift at the kiosk opened 21-Nov 11:39. All four kiosk bills then on the register were raised on 15-Nov, so ₹0 is right. The dialog's tip says "what you billed since you signed in here". *Suggested:* one extra line in the dialog giving the register session's total for context. |
| E2 | Register session opened 15-Nov 17:36, but Close Shift starts 21-Nov 11:39 (C1.5, C6.4, C12 issue 2) | The register runs Z to Z and the shift starts at sign-in. They are different windows on purpose. The 15-Nov date is the symptom of no Z having been taken (see Summary). |
| E3 | Stock in Hand: all 22 "Not stocked", on hand "-", cover "-", stock at cost ₹0 (B2, C2.7-10, C2.12, C12 issue 4) | Nothing has ever been received at the Snack Kiosk, so no balance exists. "Not stocked" means "never held here"; an item held and then sold out reads **Out**. |
| E4 | 55 items sold while nothing is stocked (C2.15) | Made-to-order items (meals, juices, Veg Biryani) hold no stock and are not on Stock in Hand. A counted item with no stock cannot be sold (`apps/api/src/lib/sale.ts:120`). |
| E5 | Default request 12; par 2 or 3 on some items (C2.13-14) | 12 is the fallback for an item with no par. Items with a par request up to it (`UI/src/roles/counter/Stock.tsx:46-50`). |
| E6 | "Batch information without stock quantities" (C2.16) | It is the **type tag** for an FG (kitchen-made) item, not batch data. See V8: most of these are packaged goods typed FG by mistake. |
| E7 | Kitchen request shows no required-by date (A3.2) | The date is optional and was left blank on PRD-2026-034. The kiosk's orders, where it was filled in, show it. |
| E8 | Two Good Day Fruit & Nuts requests, 25 and 15 (B7) | Two separate kitchen orders raised three minutes apart: PRD-2026-036 (×15) and PRD-2026-039 (×25, urgent). Not a duplicate made by the system. |
| E9 | Empty bill shows "Pay · ₹0.00" (B, Point of Sale) | The button is disabled with no lines (`UI/src/roles/counter/Pos.tsx:515`). The server also refuses an empty bill (`PayBodySchema.lines.min(1)`). |
| E10 | No pick tickets; request lists empty (C3.11-12, C4.1-10, C12 issues 5-6) | At the time of testing nothing had been approved for the kiosk. Its two requests (REQ-2026-0919/0920) were raised later that evening and still await the Outlet Manager. The Restaurant's ticket TKT-0446 shows every field QA asked for: ID, request, source, approved quantity, status. |
| E11 | Last five bills shows four (C1.8) | The session had four bills then. |
| E12 | Credit summary: 3 accounts, 2 owing, ₹570 outstanding (C7.1-5) | Correct. A payer owing ₹0 is not counted as owing; "At / near the ceiling" counts payers with a limit and ≤ 20% of it left. |
| E13 | Bills and tenders - multiple tenders per bill? (B5, C6.3) | A bill has exactly one tender. The "7" was the label defect V4. |
| E14 | Support module (C8.1-12) | Checklist items only, with no defect reported. It works as described: `SUP-00nn` IDs, the subject is required, replies arrive live over the event stream. |

## Operational actions (no code)

1. **Take a Z at every outlet.** Admin → Registers → each outlet → *Close register & take Z*. Then
   either do it daily, or give the Outlet Manager role `z_report` so a manager can close the day. This
   is what makes "session", "today" and "shift" line up again.
2. **Correct the item master** (V8): spellings, and re-create packaged goods as MRP items.
3. **Clear the queues.** 4 requests have been waiting on the Outlet Manager since 17-Nov. 9 kitchen
   orders (PRD-2026-033 … 041) are *New*, most of them for packaged goods the kitchen does not make.
4. **Testing devices:** set the date, time and time zone automatically (V9).

## Feature requests and checklists (backlog)

These are suggestions or test steps, not defects. They are listed so nothing is lost:
- Cash denomination count and a closing-cash reconciliation (C5.4, C10.46, C10.49).
- A warning before closing a shift whose figures differ from the register (C5.5-6).
- An explicit *Open till* step before the first bill (C9.7). Today the first sale opens the register
  session.
- Printer connectivity and status messages for X-report and slip printing (C6.8-9).
- Tax shown on the dashboard (C6.6).
- Automatic replenishment suggestions and alerts from sales and par (C2.12-14, C11).
- Request form polish: product picker visible before *Add item*, help text for *Items ready* and Notes
  (C3.1-8).
- B's end-to-end workflow list and C's §10 checklist. These are test plans; run them on a non-live
  environment, because they need writes.

## How to read the screens (for the testers)

| Screen | Window it counts |
|---|---|
| Dashboard, Register | The **register session**: from the last Z (or the first sale) until now, every operator at that counter. |
| Close Shift | **Your own** bills at this counter since **you** signed in. |
| Bills | Today's bills (IST calendar day) - until V2 is fixed. |

- **Stock in Hand** lists only counted items. Made-to-order items never appear, and their sales move
  no stock.
- An **empty list** with no request, approval or ticket behind it is expected, not a defect. Confirm a
  suspected mismatch with the same outlet, the same register session and the same instant.

## Fix status (branch `fix/qa-2026-11-21`)

| Finding | Status |
|---|---|
| V1, V4 | Fixed on live before this triage (PR #43, `1ed1adc`) |
| X1, X9, V9 (server age), V3 (shared GST split) | Fixed - `apps/api` receivables and credit, `@rch/domain` `istDaysBetween` / `splitGst` |
| V2, V3, V5, V6, V7, V9 (UI), X2, X3, X4, X6, X7, X8 | Fixed - UI, with `isRequestInProgress` / `isProdOrderOpen` in `@rch/domain` |
| V8 | Data - for the Store Keeper and the Outlet Manager on live (see V8) |
| Operational actions 1-4 | For the super admin and the managers - no code |

Each fix has a test that fails without it: `apps/api/src/modules/receivables/receivables.test.ts`,
`packages/domain/src/{format,transitions}.test.ts`, `UI/src/__tests__/manager-credit.test.tsx` and
`UI/src/__tests__/qa-2026-11-21.test.tsx`. The full gate (typecheck, lint with knip and the
boundary checks, and every package's tests with its coverage floor) passes.
