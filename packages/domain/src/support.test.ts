import { describe, expect, it } from "vitest";
import type { TicketStatus } from "@rch/contract";
import { canTransition, mayRate, mayUserSet, statusAfterReply, SUPPORT_TRANSITIONS } from "./index.js";

const ALL: TicketStatus[] = ["Open", "With support", "Waiting on you", "Resolved", "Closed"];

describe("what a person at a screen may do to their own ticket", () => {
  it("lets them resolve and close it, and nothing else", () => {
    expect(ALL.filter(mayUserSet)).toEqual(["Resolved", "Closed"]);
  });

  it("puts a reply back with support when the desk was waiting on them, or had called it done", () => {
    expect(statusAfterReply("Waiting on you")).toBe("With support");
    expect(statusAfterReply("Resolved")).toBe("With support");
    // A ticket already with support, or newly opened, is not moved by a second message.
    expect(statusAfterReply("With support")).toBe("With support");
    expect(statusAfterReply("Open")).toBe("Open");
    // Closed is closed: replying to it is refused by the service, so the table never sees it.
    expect(statusAfterReply("Closed")).toBe("Closed");
  });

  it("takes a rating only once the desk says it is done", () => {
    expect(ALL.filter(mayRate)).toEqual(["Resolved", "Closed"]);
  });
});

describe("the support desk's transition table", () => {
  it("lets a resolved ticket be reopened and a closed one stay closed", () => {
    expect(canTransition(SUPPORT_TRANSITIONS, "Resolved", "With support")).toBe(true);
    expect(canTransition(SUPPORT_TRANSITIONS, "Resolved", "Closed")).toBe(true);
    expect(canTransition(SUPPORT_TRANSITIONS, "Closed", "With support")).toBe(false);
    expect(canTransition(SUPPORT_TRANSITIONS, "Closed", "Resolved")).toBe(false);
  });

  it("names every status exactly once, so a new word cannot be added without an edge", () => {
    expect(Object.keys(SUPPORT_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });
});
