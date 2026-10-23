export type Rating = 1 | 2 | 3 | 4;
export type NoteType = "basic" | "reverse" | "cloze" | "vocabulary";

export interface Preferences {
  timeZone: string;
  newCardsPerDay: number;
  retention: number;
  dailyGoal: number;
  theme: "system" | "light" | "dark";
  typedAnswers: boolean;
}

export interface User {
  id: string;
  username: string;
  admin: boolean;
  preferences: Preferences;
}

export interface Deck {
  id: string;
  name: string;
  description: string;
  color: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  deckId: string;
  type: NoteType;
  front: string;
  back: string;
  example: string;
  tags: string[];
  sourceLang: string;
  targetLang: string;
  sourceId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Dates are epoch milliseconds so browser storage and server JSON agree. */
export interface CardState {
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  learning_steps: number;
  state: number;
  last_review?: number;
}

export interface Card {
  id: string;
  noteId: string;
  deckId: string;
  variant: string;
  suspended: boolean;
  state: CardState;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewEvent {
  id: string;
  kind: "review" | "undo";
  deviceId: string;
  sequence: number;
  cardId: string;
  rating: Rating;
  reviewedAt: number;
  durationMs: number;
  timeZone: string;
  retention: number;
  schedulerVersion: string;
  undoOf?: string;
}

export interface Library {
  decks: Deck[];
  notes: Note[];
  cards: Card[];
  reviews: ReviewEvent[];
  cursor: number;
  serverTime: number;
}

export interface SyncRequest {
  cursor: number;
  events: ReviewEvent[];
}

export interface SyncResponse extends Library {
  acknowledged: string[];
}

export interface ImportNote {
  type: NoteType;
  front: string;
  back: string;
  example?: string;
  tags?: string[];
  sourceLang?: string;
  targetLang?: string;
  sourceId?: string;
  deckName?: string;
}

export interface ImportPreview {
  id: string;
  filename: string;
  notes: ImportNote[];
  warnings: string[];
  skipped: number;
  duplicateCount: number;
  mediaCount: number;
  columns?: string[];
  rows?: string[][];
}

export const DEFAULT_PREFERENCES: Preferences = {
  timeZone: "UTC",
  newCardsPerDay: 20,
  retention: 0.9,
  dailyGoal: 20,
  theme: "system",
  typedAnswers: false,
};

export const DECK_COLORS = [
  "#6d5ce7",
  "#df8953",
  "#319984",
  "#5c88ca",
  "#b86d99",
  "#929947",
];

export const SCHEDULER_VERSION = "ts-fsrs@5.4.2";
