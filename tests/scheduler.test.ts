import { describe, expect, test } from "bun:test";
import {
  activeReviews,
  cardPresentation,
  cardVariants,
  createCardState,
  getQueue,
  replayCard,
  schedule,
  studyDay,
} from "../src/shared/scheduler";
import {
  DEFAULT_PREFERENCES,
  SCHEDULER_VERSION,
  type Card,
  type Library,
  type Note,
  type ReviewEvent,
  type User,
} from "../src/shared/types";
const time = Date.UTC(2026, 9, 1, 12);
const event = (
  id: string,
  reviewedAt = time,
  rating: 1 | 2 | 3 | 4 = 3,
): ReviewEvent => ({
  id,
  cardId: "card",
  deviceId: "device",
  sequence: Number(id.replace(/\D/g, "")) || 1,
  kind: "review",
  rating,
  reviewedAt,
  durationMs: 1000,
  timeZone: "UTC",
  retention: 0.9,
  schedulerVersion: SCHEDULER_VERSION,
});
const note: Note = {
  id: "note",
  deckId: "deck",
  type: "reverse",
  front: "bonjour",
  back: "hello",
  example: "",
  tags: [],
  sourceLang: "fr",
  targetLang: "en",
  createdAt: time,
  updatedAt: time,
};
const card: Card = {
  id: "card",
  noteId: "note",
  deckId: "deck",
  variant: "forward",
  suspended: false,
  createdAt: time,
  updatedAt: time,
  state: createCardState(time),
};
const user: User = {
  id: "u",
  username: "user",
  admin: false,
  preferences: { ...DEFAULT_PREFERENCES, newCardsPerDay: 1 },
};
const library = (cards: Card[], reviews: ReviewEvent[] = []): Library => ({
  decks: [],
  notes: [note],
  cards,
  reviews,
  cursor: 0,
  serverTime: time,
});
describe("scheduler", () => {
  test("ratings produce real different deterministic intervals", () => {
    const again = schedule(createCardState(time), 1, time);
    const easy = schedule(createCardState(time), 4, time);
    expect(again.due).toBeGreaterThan(time);
    expect(easy.due).toBeGreaterThan(again.due);
    expect(easy.reps).toBe(1);
    expect(schedule(createCardState(time), 4, time)).toEqual(easy);
  });
  test("late and simultaneous device events converge independent of arrival order", () => {
    const a = event("a1"),
      b = { ...event("b2", time + 86400000), deviceId: "second" };
    expect(replayCard(time, [b, a])).toEqual(replayCard(time, [a, b]));
    expect(replayCard(time, [a, b]).reps).toBe(2);
  });
  test("undo replays remaining reviews without deleting history", () => {
    const review = event("r1");
    const undo = {
      ...event("u2", time + 1),
      kind: "undo" as const,
      undoOf: review.id,
    };
    expect(activeReviews([review, undo])).toEqual([]);
    expect(replayCard(time, [review, undo])).toEqual(createCardState(time));
  });
  test("cloze produces one stable card per distinct deletion and preserves hints", () => {
    const cloze = {
      ...note,
      type: "cloze" as const,
      front: "{{c1::Paris::city}} is in {{c2::France}}. {{c1::Paris}}",
      back: "Geography",
    };
    expect(cardVariants(cloze)).toEqual(["c1", "c2"]);
    expect(cardPresentation(cloze, "c1")).toEqual({
      front: "[city] is in France. […]",
      back: "Paris is in France. Paris\n\nGeography",
    });
    expect(cardPresentation(note, "reverse")).toEqual({
      front: "hello",
      back: "bonjour",
    });
  });
  test("timezone and daylight saving boundaries use local calendar dates", () => {
    expect(studyDay(Date.UTC(2026, 9, 1, 22, 30), "Europe/Moscow")).toBe(
      "2026-10-02",
    );
    expect(studyDay(Date.UTC(2026, 10, 1, 5, 30), "America/New_York")).toBe(
      "2026-11-01",
    );
    expect(studyDay(Date.UTC(2026, 10, 1, 6, 30), "America/New_York")).toBe(
      "2026-11-01",
    );
  });
  test("new-card daily limit spans decks and undo releases quota", () => {
    const reviewed = event("r1");
    const fresh = { ...card, id: "fresh", noteId: "note2" };
    const data = {
      ...library([fresh], [reviewed]),
      notes: [note, { ...note, id: "note2" }],
    };
    expect(getQueue(data, user, undefined, time + 1000)).toHaveLength(0);
    data.reviews.push({
      ...event("u2", time + 1),
      kind: "undo",
      undoOf: reviewed.id,
    });
    expect(getQueue(data, user, undefined, time + 1000)).toHaveLength(1);
  });
  test("siblings are buried but a failed card can be relearned when due", () => {
    const reviewed = event("r1", time, 1);
    const failed = { ...card, state: schedule(card.state, 1, time) };
    const sibling = { ...card, id: "reverse", variant: "reverse" };
    expect(
      getQueue(
        library([failed, sibling], [reviewed]),
        user,
        undefined,
        time + 120000,
      ).map((card) => card.id),
    ).toEqual(["card"]);
  });
});
