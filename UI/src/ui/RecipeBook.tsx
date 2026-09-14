import { useMemo, useState } from "react";
import { canBeIngredient, carriesRecipe, recipeCost, recipeRefusal } from "@rch/domain";
import { IT, LOC, RCP } from "../data/master";
import { activeItems } from "../lib/selectors";
import { money, U } from "../lib/fmt";
import { useApp } from "../store";
import {
  Alert, Btn, Card, DataTable, DraftLineInput, Field, Grid, PageHead, Pill, TableFoot, Toolbar, useLineKeys,
} from "./kit";
import type { Item } from "../types";

/**
 * The recipe book — the kitchen's and the outlet manager's, one screen for both, which is why it
 * lives here rather than under either role.
 *
 * A recipe used to arrive only with the seed, so a hospital started clean could list a
 * made-to-order item and never sell it. This is its one door: pick a finished good or a
 * made-to-order item, list what one unit takes, save. The editor previews with the server's own
 * rule (`recipeRefusal`) and its own costing (`recipeCost`), so the Save button is greyed for
 * exactly the recipes `PUT /recipes/:it` would refuse, and the sentence under it is the refusal.
 */

const TYPE_LABEL: Partial<Record<Item["t"], string>> = { FG: "Finished good", MTO: "Made to order" };
type Line = { it: string; qty: number };

/** The live master — what a rule is asked against, so a retired line reads as one the master no
 *  longer has, exactly the way the server's `loadItems` answers it. */
const liveItems = (): Record<string, Item> => Object.fromEntries(activeItems().map((k) => [k, IT[k]]));
const byName = (items: Record<string, Item>) => (a: string, b: string) => items[a].n.localeCompare(items[b].n);

export default function RecipeBook() {
  // `IT` and `RCP` are module-level registries replaced in place, so `catalogVersion` is the
  // signal that either moved — a recipe saved here, or one saved in another browser over SSE.
  const catalogVersion = useApp((s) => s.catalogVersion);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);

  const live = useMemo(() => { void catalogVersion; return liveItems(); }, [catalogVersion]);
  const made = Object.keys(live).filter((k) => carriesRecipe(live[k])).sort(byName(live));
  const term = q.trim().toLowerCase();
  const rows = made.filter((k) => !term || live[k].n.toLowerCase().includes(term) || live[k].c.toLowerCase().includes(term));
  const missing = made.filter((k) => !RCP[k]).length;
  const master = { items: live, locations: LOC, recipes: RCP };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Masters", "Recipes"]}
        title="Recipes"
        sub="What one unit of every made item takes, and what it costs."
      />

      <Alert tone="i" label="RECIPES">
        A <b>made-to-order</b> item is sold by its recipe — every sale draws these ingredients off the
        counter's own shelf — and a <b>finished good</b> is batched from it in the kitchen. An item with
        no recipe cannot be sold or made until it has one.
      </Alert>

      <Grid cols="g21">
        <Card title="Made items" sub={`${made.length} on the master · ${missing} without a recipe`} flush className="mtop">
          <Toolbar placeholder="Search by name or code…" value={q} onSearch={setQ} />
          <div className="lgrid">
            <DataTable
              cols={[{ h: "Item", cls: "nm", w: "34%" }, { h: "Type" }, { h: "Recipe" }, { h: "Cost a unit" }, { h: "", w: "14%" }]}
              rows={rows.map((k) => {
                const r = RCP[k];
                return {
                  key: k,
                  cells: [
                    <>{live[k].n}<div className="mini mono">{live[k].c}</div></>,
                    TYPE_LABEL[live[k].t] ?? live[k].t,
                    r ? `${r.l.length} ingredient${r.l.length === 1 ? "" : "s"}` : <Pill tone="mu">No recipe</Pill>,
                    r ? money(recipeCost(master, k)) : "—",
                    <Btn size="xs" title={`Recipe for ${live[k].n}`} onClick={() => setSel(k)}>{r ? "Edit" : "Write"}</Btn>,
                  ],
                };
              })}
              empty={term
                ? { title: `No made item matches "${q.trim()}"`, sub: "Clear the search to see them all." }
                : { title: "Nothing on the master carries a recipe yet", sub: "Add a finished good or a made-to-order item from Add Product, then give it its recipe here." }}
            />
          </div>
          <TableFoot count={rows.length} />
        </Card>

        {sel && live[sel]
          ? <RecipeEditor key={sel} it={sel} live={live} onClose={() => setSel(null)} />
          : (
            <Card title="Pick an item" className="mtop">
              <span className="dim">Choose an item on the left to write its recipe or change the one it has.</span>
            </Card>
          )}
      </Grid>
    </>
  );
}

function RecipeEditor({ it, live, onClose }: { it: string; live: Record<string, Item>; onClose: () => void }) {
  const saveRecipe = useApp((s) => s.saveRecipe);
  const had = RCP[it];
  const item = live[it];
  const [ov, setOv] = useState(had?.ov ?? 12);
  const [lines, setLines] = useState<Line[]>(() => (had?.l ?? []).map(([g, n]) => ({ it: g, qty: n })));
  const [keys, drop] = useLineKeys(lines.length);
  const [busy, setBusy] = useState(false);

  const used = new Set(lines.map((l) => l.it));
  const offer = Object.keys(live).filter((k) => k !== it && canBeIngredient(live[k]) && !used.has(k)).sort(byName(live));
  const refusal = recipeRefusal(live, it, { ov, lines });
  const draft = { ov, l: lines.map((l) => [l.it, l.qty] as [string, number]) };
  const unit = recipeCost({ items: live, locations: LOC, recipes: { [it]: draft } }, it);
  const raw = lines.reduce((t, l) => t + l.qty * (live[l.it]?.cost ?? 0), 0);

  const setQty = (i: number, qty: number) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, qty } : l)));
  const remove = (i: number) => { drop(i); setLines((ls) => ls.filter((_, j) => j !== i)); };
  // The form is kept whatever the answer: a saved recipe comes back through the refetch as
  // exactly what is on screen, and a refused one stays to be corrected rather than typed again.
  const save = async () => {
    setBusy(true);
    try { await saveRecipe(it, { ov, lines }); } finally { setBusy(false); }
  };

  return (
    <Card
      title={item.n}
      sub={had ? "Change the recipe — the next batch and the next sale use it" : "No recipe yet — write the first one"}
      right={<Btn size="xs" onClick={onClose}>Close</Btn>}
      className="mtop"
    >
      <Field label="Overhead %" hint="Labour, gas and wastage on top of the ingredients, 0–100%.">
        <DraftLineInput value={ov} min={0} max={100} step={0.5} ariaLabel={`Overhead percent for ${item.n}`} onCommit={setOv} />
      </Field>

      <DataTable
        cols={[{ h: "Ingredient", cls: "nm", w: "40%" }, { h: `In one ${U(it)}` }, { h: "Cost" }, { h: "", w: "12%" }]}
        rows={lines.map((l, i) => {
          const g = live[l.it];
          return {
            key: String(keys[i]),
            cells: [
              <>{g?.n ?? l.it}<div className="mini mono">{g?.c ?? ""}</div></>,
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <DraftLineInput value={l.qty} min={0} step={0.001} ariaLabel={`Quantity of ${g?.n ?? l.it} in one ${item.n}`} onCommit={(n) => setQty(i, n)} />
                <span className="mini">{U(l.it)}</span>
              </span>,
              money(l.qty * (g?.cost ?? 0)),
              <Btn size="xs" variant="dg" onClick={() => remove(i)}>Remove</Btn>,
            ],
          };
        })}
        empty={{ title: "No ingredients yet", sub: "Add the first one below." }}
      />

      <Field label="Add an ingredient" hint="Anything a shelf holds — a made-to-order item has no stock to draw on.">
        <select
          aria-label={`Add an ingredient to ${item.n}`}
          value=""
          onChange={(e) => { const g = e.target.value; if (g) setLines((ls) => [...ls, { it: g, qty: 0 }]); }}
        >
          <option value="">{offer.length ? "Choose an ingredient…" : "Nothing left to add"}</option>
          {offer.map((k) => <option key={k} value={k}>{live[k].n} ({U(k)})</option>)}
        </select>
      </Field>

      <p>
        One {U(it)} costs <b>{money(unit)}</b>
        <span className="mini"> — ingredients {money(raw)} plus {ov}% overhead</span>
      </p>
      {refusal && <div className="hint" role="status">{refusal}</div>}
      <Btn wide disabled={Boolean(refusal) || busy} onClick={() => void save()}>
        {busy ? "Saving…" : had ? "Save the recipe" : "Save the first recipe"}
      </Btn>
    </Card>
  );
}
