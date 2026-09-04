import { z } from "zod";
import { CollectionSchema } from "./writes.js";

/** `GET /events` is deliberately not a manifest route (see routes.ts) — it is a stream with no
 *  JSON response to serialise. `apps/api/src/plugins/sse.ts` registers it directly, and both
 *  sides build its URL from `API_PREFIX + EVENTS_PATH`. */
export const EVENTS_PATH = "/events";
/** One notice per changed collection, so a live client refetches the same slice a write's own
 *  `changed` array would have named. */
export const EventNoticeSchema = z.strictObject({ collection: CollectionSchema, at: z.string() });
export type EventNotice = z.infer<typeof EventNoticeSchema>;
