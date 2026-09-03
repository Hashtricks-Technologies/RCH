import { pgTable, smallint, text } from "drizzle-orm/pg-core";
import { messageFromEnum, productReqStatusEnum, roleEnum, supportPriorityEnum, supportStatusEnum, supportTopicEnum } from "./enums.js";
import { items, locations, ts, users } from "./master.js";

export const supportTickets = pgTable("support_tickets", {
  id: text("id").primaryKey(),
  topic: supportTopicEnum("topic").notNull(),
  subject: text("subject").notNull(),
  priority: supportPriorityEnum("priority").notNull(),
  status: supportStatusEnum("status").notNull(),
  byUser: text("by_user").notNull().references(() => users.id),
  role: roleEnum("role").notNull(),
  loc: text("loc").notNull().references(() => locations.key),
  at: ts("at").notNull().defaultNow(),
  screen: text("screen").notNull().default(""),
  rating: smallint("rating"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const supportMessages = pgTable("support_messages", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => supportTickets.id),
  from: messageFromEnum("from").notNull(),
  who: text("who").notNull(),
  at: ts("at").notNull().defaultNow(),
  body: text("body").notNull(),
});
export const productRequests = pgTable("product_requests", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  why: text("why").notNull().default(""),
  forLoc: text("for_loc").notNull().references(() => locations.key),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: productReqStatusEnum("status").notNull(),
  note: text("note"),
  itemKey: text("item_key").references(() => items.key),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
