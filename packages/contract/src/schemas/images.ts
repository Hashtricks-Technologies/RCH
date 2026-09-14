/** `GET /items/:it/image/:hash` is deliberately not a manifest route - it answers bytes, not
 *  JSON, and it takes no token because an `<img>` cannot send one. `apps/api`'s catalog module
 *  registers it directly, and both sides build its URL from `API_PREFIX + itemImagePath()`. */
export const ITEM_IMAGE_PATH = "/items/:it/image/:hash";

export const itemImagePath = (it: string, hash: string): string =>
  `/items/${encodeURIComponent(it)}/image/${hash}`;
