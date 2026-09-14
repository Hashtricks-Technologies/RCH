import { describe, expect, it } from "vitest";
import type { TicketStatus } from "@rch/contract";
import { canTransition, deskStatusAfterReply, mayDeskSet, mayRate, mayReply, mayUserSet, statusAfterReply, SUPPORT_TRANSITIONS } from "./index.js";

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

  it("takes a reply on anything but a closed ticket", () => {
    expect(ALL.filter(mayReply)).toEqual(["Open", "With support", "Waiting on you", "Resolved"]);
    // Replying to a resolved ticket is how it is reopened, so it must stay allowed.
    expect(mayReply("Resolved")).toBe(true);
    expect(mayReply("Closed")).toBe(false);
  });
});

describe("what the admin, answering as the desk, may do to anybody's ticket", () => {
  it("sets any status but open - a ticket is open only until the desk first touches it", () => {
    expect(ALL.filter(mayDeskSet)).toEqual(["With support", "Waiting on you", "Resolved", "Closed"]);
  });

  it("picks an open ticket up with a first reply, and leaves every other status where it is", () => {
    expect(deskStatusAfterReply("Open")).toBe("With support");
    expect(deskStatusAfterReply("With support")).toBe("With support");
    expect(deskStatusAfterReply("Waiting on you")).toBe("Waiting on you");
    // A note on a resolved ticket ("it should hold now") does not reopen it.
    expect(deskStatusAfterReply("Resolved")).toBe("Resolved");
  });

  it("moves it to the status the desk sent the reply with, when it names one", () => {
    expect(deskStatusAfterReply("Open", "Waiting on you")).toBe("Waiting on you");
    expect(deskStatusAfterReply("With support", "Resolved")).toBe("Resolved");
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
