import {
  createEmptyCard,
  fsrs,
  type Card as FSRSCard,
  type Grade,
  type State,
} from "ts-fsrs";
import type {
  Card,
  CardState,
  Library,
  Note,
  Rating,
  ReviewEvent,
  User,
} from "./types";

function serialize(card: FSRSCard): CardState {
  return {
    ...card,
    due: card.due.getTime(),
    last_review: card.last_review?.getTime(),
  };
}

function deserialize(card: CardState): FSRSCard {
  return {
    ...card,
    due: new Date(card.due),
    last_review:
      card.last_review === undefined ? undefined : new Date(card.last_review),
    state: card.state as State,
  };
}

export function createCardState(at: number = Date.now()): CardState {
  return serialize(createEmptyCard(new Date(at)));
}

export function schedule(
  card: CardState,
  rating: Rating,
  at: number,
  retention = 0.9,
): CardState {
  const scheduler = fsrs({
    request_retention: retention,
    enable_fuzz: false,
    learning_steps: ["1m", "10m"],
    relearning_steps: ["10m"],
  });
  return serialize(
    scheduler.next(deserialize(card), new Date(at), rating as Grade).card,
  );
}

export function activeReviews(events: ReviewEvent[]): ReviewEvent[] {
  const undone = new Set(
    events
      .filter((event) => event.kind === "undo")
      .map((event) => event.undoOf),
  );
  return events.filter(
    (event) => event.kind === "review" && !undone.has(event.id),
  );
}

export function replayCard(
  createdAt: number,
  events: ReviewEvent[],
): CardState {
  let state = createCardState(createdAt);
  const reviews = activeReviews(events).sort(
    (a, b) =>
      a.reviewedAt - b.reviewedAt ||
      a.deviceId.localeCompare(b.deviceId) ||
      a.sequence - b.sequence ||
      a.id.localeCompare(b.id),
  );
  for (const event of reviews)
    state = schedule(
      state,
      event.rating,
      Math.max(createdAt, event.reviewedAt),
      event.retention,
    );
  return state;
}

export function cardVariants(note: Pick<Note, "type" | "front">): string[] {
  if (note.type === "reverse") return ["forward", "reverse"];
  if (note.type === "cloze")
    return [
      ...new Set(
        [...note.front.matchAll(/\{\{c([1-9]\d*)::[\s\S]*?\}\}/g)].map(
          (match) => `c${match[1]}`,
        ),
      ),
    ].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return ["forward"];
}

export function cardPresentation(
  note: Note,
  variant: string,
): { front: string; back: string } {
  if (variant === "reverse") return { front: note.back, back: note.front };
  if (note.type !== "cloze") return { front: note.front, back: note.back };
  const pattern = /\{\{c([1-9]\d*)::([\s\S]*?)(?:::(.*?))?\}\}/g;
  return {
    front: note.front.replace(
      pattern,
      (_, index: string, text: string, hint: string) =>
        variant === `c${index}` ? `[${hint || "…"}]` : text,
    ),
    back:
      note.front.replace(pattern, (_, _index: string, text: string) => text) +
      (note.back ? `\n\n${note.back}` : ""),
  };
}

export function studyDay(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function descendantDeckIds(
  decks: Library["decks"],
  deckId: string,
): Set<string> {
  const ids = new Set([deckId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const deck of decks)
      if (deck.parentId && ids.has(deck.parentId) && !ids.has(deck.id)) {
        ids.add(deck.id);
        changed = true;
      }
  }
  return ids;
}

export function getQueue(
  library: Library,
  user: User,
  deckId?: string,
  now = Date.now(),
): Card[] {
  const reviews = activeReviews(library.reviews);
  const today = studyDay(now, user.preferences.timeZone);
  const firstReviews = new Map<string, ReviewEvent>();
  const reviewedToday = new Set<string>();
  for (const review of reviews) {
    const first = firstReviews.get(review.cardId);
    if (!first || review.reviewedAt < first.reviewedAt)
      firstReviews.set(review.cardId, review);
    if (studyDay(review.reviewedAt, review.timeZone) === today)
      reviewedToday.add(review.cardId);
  }
  const newStudied = [...firstReviews.values()].filter(
    (review) => studyDay(review.reviewedAt, review.timeZone) === today,
  ).length;
  const noteByCard = new Map(
    library.cards.map((card) => [card.id, card.noteId]),
  );
  const buriedNotes = new Set(
    [...reviewedToday].map((id) => noteByCard.get(id)).filter(Boolean),
  );
  const deckIds = deckId ? descendantDeckIds(library.decks, deckId) : null;
  const notes = new Set(library.notes.map((note) => note.id));
  const candidates = library.cards.filter(
    (card) =>
      !card.suspended &&
      notes.has(card.noteId) &&
      (!deckIds || deckIds.has(card.deckId)) &&
      (!buriedNotes.has(card.noteId) || reviewedToday.has(card.id)),
  );
  const due = candidates
    .filter((card) => card.state.state !== 0 && card.state.due <= now)
    .sort((a, b) => {
      const priority = (card: Card) =>
        card.state.state === 1 || card.state.state === 3 ? 0 : 1;
      return (
        priority(a) - priority(b) ||
        a.state.due - b.state.due ||
        a.id.localeCompare(b.id)
      );
    });
  const fresh = candidates
    .filter((card) => card.state.state === 0)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  // Only one sibling is introduced per day, even before the first rating.
  const seenNotes = new Set(due.map((card) => card.noteId));
  return [
    ...due,
    ...fresh
      .filter((card) => {
        if (seenNotes.has(card.noteId)) return false;
        seenNotes.add(card.noteId);
        return true;
      })
      .slice(0, Math.max(0, user.preferences.newCardsPerDay - newStudied)),
  ];
}

export function intervalLabel(due: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((due - now) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  const days = Math.round(minutes / 1440);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}
