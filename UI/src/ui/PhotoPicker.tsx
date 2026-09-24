import { useRef, useState } from "react";
import { checkPhoto, IMAGE_NOT_PHOTO } from "@rch/domain";
import { IT } from "../data/master";
import { useApp } from "../store";
import { shrinkPhoto } from "../lib/photo";
import { Btn, BtnRow, ItemImage } from "./kit";
import { useCan } from "../lib/selectors";

/**
 * An item's photo with the buttons that set it - shared by the manager's item drawer and the
 * counter's Configure panel. The photo is shrunk and checked here with the domain's own
 * `checkPhoto`, so an obvious refusal costs no upload; the server checks again and decides.
 * On a tablet, the file input offers the camera.
 */
export function PhotoPicker({ it }: { it: string }) {
  const setItemImage = useApp((s) => s.setItemImage);
  const removeItemImage = useApp((s) => s.removeItemImage);
  const notify = useApp((s) => s.notify);
  // `IT` is replaced in place by a refetch; this subscription is what re-renders on it.
  const version = useApp((s) => s.catalogVersion);
  void version;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A role without Product photos sees the photo and no way to change it.
  const may = useCan("item_photos");

  const item = IT[it];
  const has = Boolean(item?.img);
  const retired = item?.active === false;

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const bytes = await shrinkPhoto(file);
      if (!bytes) { notify(IMAGE_NOT_PHOTO); return; }
      const check = checkPhoto(bytes);
      if (!check.ok) { notify(check.refusal); return; }
      await setItemImage(it, bytes);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    await removeItemImage(it);
    setBusy(false);
    setConfirming(false);
  };

  return (
    <div className="photopick">
      <ItemImage it={it} size="card" />
      {may && <>
      <input ref={input} type="file" accept="image/*" hidden aria-label={`Photo of ${item?.n ?? it}`}
        onChange={(e) => void pick(e.target.files?.[0])} />
      <BtnRow>
        {!retired && (
          <Btn variant={has ? "gh" : undefined} disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Working…" : has ? "Change photo" : "Add photo"}
          </Btn>
        )}
        {has && (confirming
          ? <Btn variant="gh" disabled={busy} onClick={() => void remove()}>Press again to remove</Btn>
          : <Btn variant="gh" disabled={busy} onClick={() => setConfirming(true)}>Remove photo</Btn>)}
      </BtnRow>
      </>}
    </div>
  );
}
