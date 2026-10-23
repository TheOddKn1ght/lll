import { describe, expect, test } from "bun:test";
import { mergePending, reconcileSnapshot } from "../src/client";
import { createCardState, replayCard } from "../src/shared/scheduler";
import { SCHEDULER_VERSION } from "../src/shared/types";
import type { Library, ReviewEvent } from "../src/shared/types";

const createdAt = Date.UTC(2026, 9, 20, 8);
function library(cursor = 1): Library {
  return {
    decks: [],
    notes: [],
    cards: [
      {
        id: "card-test",
        noteId: "note-test",
        deckId: "deck-test",
        variant: "forward",
        suspended: false,
        state: createCardState(createdAt),
        createdAt,
        updatedAt: createdAt,
      },
    ],
    reviews: [],
    cursor,
    serverTime: createdAt,
  };
}
function event(input: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    id: "review-one",
    kind: "review",
    cardId: "card-test",
    deviceId: "device-one",
    sequence: 1,
    rating: 3,
    reviewedAt: createdAt + 60000,
    durationMs: 2000,
    timeZone: "UTC",
    retention: 0.9,
    schedulerVersion: SCHEDULER_VERSION,
    ...input,
  };
}

describe("offline canonical snapshot reconciliation", () => {
  test("keeps an answer made while a refresh response was in flight", () => {
    const incoming = library();
    const pending = event();
    const result = reconcileSnapshot(library(), incoming, [pending]);
    expect(result.reviews).toEqual([pending]);
    expect(result.cards[0]!.state.reps).toBe(1);
    expect(incoming.reviews).toHaveLength(0);
  });
  test("does not roll back an acknowledged review when an older refresh arrives", () => {
    const review = event();
    const saved = mergePending(library(3), [review]);
    const result = reconcileSnapshot(saved, library(2), []);
    expect(result.cursor).toBe(3);
    expect(result.reviews).toEqual([review]);
    expect(result.cards[0]!.state.reps).toBe(1);
  });
  test("deduplicates acknowledged events while preserving a later unsynced answer", () => {
    const first = event();
    const second = event({
      id: "review-two",
      sequence: 2,
      rating: 4,
      reviewedAt: createdAt + 120000,
    });
    const canonical = mergePending(library(4), [first]);
    const result = reconcileSnapshot(library(3), canonical, [first, second]);
    expect(result.reviews).toHaveLength(2);
    expect(result.cards[0]!.state).toEqual(
      replayCard(createdAt, [first, second]),
    );
  });
  test("reconciles offline undo without resurrecting cards deleted on the server", () => {
    const first = event();
    const undo = event({
      id: "undo-one",
      kind: "undo",
      sequence: 2,
      undoOf: first.id,
      reviewedAt: createdAt + 120000,
    });
    const deleted = { ...library(8), cards: [], reviews: [first] };
    const result = reconcileSnapshot(library(7), deleted, [undo]);
    expect(result.cards).toHaveLength(0);
    expect(result.reviews).toHaveLength(2);
    expect(
      mergePending(mergePending(library(), [first]), [undo]).cards[0]!.state
        .reps,
    ).toBe(0);
  });
});
