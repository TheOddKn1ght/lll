import { useEffect, useSyncExternalStore } from "react";
import type {
  Card,
  Library,
  Rating,
  ReviewEvent,
  SyncResponse,
  User,
} from "./shared/types";
import { SCHEDULER_VERSION } from "./shared/types";
import { descendantDeckIds, replayCard } from "./shared/scheduler";
import { isSecureAccountOrigin } from "./shared/transport";
export { cardPresentation, getQueue } from "./shared/scheduler";

export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
const publicAuth = (path: string) =>
  /^\/api\/auth\/(me|login|register|setup)(?:\?|$)/.test(path);
const accountHeaders = (id: string) => ({ "X-Account-ID": id });
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (typeof location !== "undefined") {
    const page = new URL(location.href);
    if (!isSecureAccountOrigin(page))
      throw new APIError(
        "Open this app over HTTPS to protect your account.",
        403,
        "INSECURE_TRANSPORT",
      );
    const target = new URL(path, page);
    if (target.origin !== page.origin || target.username || target.password)
      throw new APIError(
        "Account requests must stay on this app’s origin.",
        403,
        "INVALID_API_ORIGIN",
      );
  }
  const headers = new Headers(init.headers);
  if (!publicAuth(path) && state.user && !headers.has("X-Account-ID"))
    headers.set("X-Account-ID", state.user.id);
  if (typeof init.body === "string" && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const data = await response.json();
      message = data.error || message;
      code = data.code;
    } catch {
      /* Preserve the HTTP error. */
    }
    if (code === "ACCOUNT_CHANGED") queueMicrotask(() => void refresh());
    throw new APIError(message, response.status, code);
  }
  const expected = headers.get("X-Account-ID");
  const actual = response.headers.get("X-Account-ID");
  if (expected && actual && expected !== actual)
    throw new APIError(
      "The signed-in account changed. Reload to continue.",
      409,
      "ACCOUNT_CHANGED",
    );
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (/^\/api\/auth\/(login|register|setup)$/.test(path)) signInProof = true;
  return data as T;
}

const DATABASE = "lll-offline-v1";
// Reuse the former store in existing installations: pending answers and device
// sequences must continue to be shared with tabs opened before the rename.
const LEGACY_DATABASE = "recall-offline-v1";
let database: Promise<IDBDatabase> | undefined;
async function openDatabase(): Promise<IDBDatabase> {
  let name = DATABASE;
  if (typeof indexedDB.databases === "function") {
    const names = (await indexedDB.databases()).map((item) => item.name);
    if (!names.includes(DATABASE) && names.includes(LEGACY_DATABASE))
      name = LEGACY_DATABASE;
  } else {
    const legacy = await new Promise<IDBDatabase | null>((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DATABASE);
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        request.error?.name === "AbortError"
          ? resolve(null)
          : reject(request.error);
    });
    if (legacy) return legacy;
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(
          "Local storage is unavailable. Enable browser storage to study safely.",
        ),
      );
  });
}
function db(): Promise<IDBDatabase> {
  return (database ??= openDatabase());
}
async function read<T>(name: string): Promise<T | undefined> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const request = connection.transaction("kv").objectStore("kv").get(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

interface Store {
  user: User | null;
  setupRequired: boolean;
  loading: boolean;
  error: string | null;
  library: Library | null;
  online: boolean;
  pending: number;
  syncing: boolean;
  lastSync: number | null;
  downloaded: string[];
}
interface AccountMarker {
  id: string;
  generation: string;
  status: "active" | "signingOut";
}
let state: Store = {
  user: null,
  setupRequired: false,
  loading: true,
  error: null,
  library: null,
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  pending: 0,
  syncing: false,
  lastSync: null,
  downloaded: [],
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function update(patch: Partial<Store>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
const key = (user: string, name: string) => `user:${user}:${name}`;
let clockOffset = 0;
let initialized = false;
let accountGeneration: string | null = null;
let accountEpoch = 0;
let refreshSequence = 0;
let signingOut = false;
let signInProof = false;
let inFlight: Promise<void> | null = null;
let syncRequested = false;
const urls = new Map<string, string>();
const undoStack: ReviewEvent[] = [];
let channel: BroadcastChannel | undefined;
function sameAccount(id: string, generation: string | null, epoch: number) {
  return (
    state.user?.id === id &&
    accountGeneration === generation &&
    accountEpoch === epoch
  );
}
function clearAccountMemory() {
  accountEpoch++;
  undoStack.length = 0;
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  accountGeneration = null;
}
function offlineSnapshot(
  library: Library,
  downloaded = state.downloaded,
): Library {
  const ids = new Set(downloaded);
  return {
    ...library,
    notes: library.notes.filter((note) => ids.has(note.deckId)),
    cards: library.cards.filter((card) => ids.has(card.deckId)),
  };
}

export function mergePending(
  library: Library,
  pending: ReviewEvent[],
): Library {
  const events = new Map(library.reviews.map((event) => [event.id, event]));
  for (const event of pending) events.set(event.id, event);
  const reviews = [...events.values()];
  const changed = new Set(pending.map((event) => event.cardId));
  return {
    ...library,
    reviews,
    cards: library.cards.map((card) =>
      changed.has(card.id)
        ? {
            ...card,
            state: replayCard(
              card.createdAt,
              reviews.filter((event) => event.cardId === card.id),
            ),
          }
        : card,
    ),
  };
}

/** A slow response cannot replace a newer acknowledged snapshot. */
export function reconcileSnapshot(
  saved: Library | undefined,
  incoming: Library,
  pending: ReviewEvent[],
): Library {
  return mergePending(
    saved && saved.cursor > incoming.cursor ? saved : incoming,
    pending,
  );
}

interface AccountData {
  library?: Library;
  outbox: ReviewEvent[];
  downloaded: string[];
  marker?: AccountMarker;
  lastUser?: User;
  sequence: number;
  deviceId?: string;
  lastSync?: number;
  clockOffset?: number;
}
type TxControl<T> = {
  store: IDBObjectStore;
  done: (result: T) => void;
  abort: (message: string) => void;
};
/** Every account write and logout lock uses this one serialized IDB transaction. */
async function accountTransaction<T>(
  userId: string,
  run: (data: AccountData, control: TxControl<T>) => void,
): Promise<T> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction("kv", "readwrite", {
      durability: "strict",
    });
    const store = transaction.objectStore("kv");
    const library = store.get(key(userId, "library"));
    const outbox = store.get(key(userId, "outbox"));
    const downloads = store.get(key(userId, "downloads"));
    const marker = store.get("activeAccount");
    const lastUser = store.get("lastUser");
    const sequence = store.get(key(userId, "sequence"));
    const deviceId = store.get("deviceId");
    const lastSync = store.get(key(userId, "lastSync"));
    const offset = store.get(key(userId, "clockOffset"));
    let result: T;
    let failure: Error | undefined;
    let completed = false;
    const abort = (message: string) => {
      failure = new Error(message);
      transaction.abort();
    };
    offset.onsuccess = () => {
      try {
        run(
          {
            library: library.result,
            outbox: outbox.result || [],
            downloaded: downloads.result || [],
            marker: marker.result,
            lastUser: lastUser.result,
            sequence: sequence.result || 0,
            deviceId: deviceId.result,
            lastSync: lastSync.result,
            clockOffset: offset.result,
          },
          {
            store,
            done: (value) => {
              result = value;
              completed = true;
            },
            abort,
          },
        );
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
      }
    };
    transaction.oncomplete = () =>
      completed
        ? resolve(result!)
        : reject(new Error("Local operation did not complete."));
    transaction.onerror = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("Could not save locally. Check available device storage."),
      );
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("Local save was interrupted; please try again."),
      );
  });
}
function requireMarker(
  data: AccountData,
  userId: string,
  generation: string | null,
  abort: (message: string) => void,
): boolean {
  if (
    signingOut ||
    !generation ||
    data.marker?.id !== userId ||
    data.marker.generation !== generation ||
    data.marker.status !== "active"
  ) {
    abort("This account changed or is signing out. Reload before continuing.");
    return false;
  }
  return true;
}
const mediaIds = (text: string) =>
  [...text.matchAll(/\[\[(?:image|audio):([a-f\d]{64})\]\]/g)].map(
    (match) => match[1]!,
  );
function readyDownloads(
  store: IDBObjectStore,
  userId: string,
  library: Library,
  downloaded: string[],
  finish: (ready: string[]) => void,
) {
  const existing = new Set(library.decks.map((deck) => deck.id));
  const ready = new Set(downloaded.filter((id) => existing.has(id)));
  const complete = () => {
    // A downloaded parent represents its whole subtree, including newly added children.
    let changed = true;
    while (changed) {
      changed = false;
      for (const deck of library.decks)
        if (deck.parentId && ready.has(deck.parentId) && !ready.has(deck.id)) {
          ready.delete(deck.parentId);
          changed = true;
        }
    }
    finish([...ready]);
  };
  const mediaDecks = new Map<string, Set<string>>();
  for (const note of library.notes)
    if (ready.has(note.deckId))
      for (const id of mediaIds(
        `${note.front}\n${note.back}\n${note.example}`,
      )) {
        if (!mediaDecks.has(id)) mediaDecks.set(id, new Set());
        mediaDecks.get(id)!.add(note.deckId);
      }
  if (!mediaDecks.size) {
    complete();
    return;
  }
  let remaining = mediaDecks.size;
  for (const [id, decks] of mediaDecks) {
    const request = store.get(key(userId, `media:${id}`));
    request.onsuccess = () => {
      if (!(request.result instanceof Blob))
        for (const deckId of decks) ready.delete(deckId);
      if (--remaining === 0) complete();
    };
  }
}
interface SnapshotResult {
  library: Library;
  pending: number;
  downloaded: string[];
  generation: string;
  lastSync?: number;
  clockOffset: number;
}
async function saveSnapshot(
  user: User,
  incoming: Library,
  acknowledged: string[],
  generation: string | null,
  observed?: AccountMarker,
  activate = false,
  unlock = false,
): Promise<SnapshotResult> {
  return accountTransaction(user.id, (data, { store, done, abort }) => {
    if (activate) {
      if (
        data.marker?.generation !== observed?.generation &&
        data.marker?.id !== user.id
      ) {
        abort("The account changed while loading. Try again.");
        return;
      }
      if (data.marker?.status === "signingOut" && !unlock) {
        abort(
          "Sign out is in progress in another tab. Sign in again if that tab was closed.",
        );
        return;
      }
    } else if (!requireMarker(data, user.id, generation, abort)) return;
    const nextGeneration = activate
      ? data.marker?.id === user.id && data.marker.status === "active"
        ? data.marker.generation
        : crypto.randomUUID()
      : generation!;
    const ack = new Set(acknowledged);
    const pending = data.outbox.filter((event) => !ack.has(event.id));
    const library = reconcileSnapshot(data.library, incoming, pending);
    readyDownloads(store, user.id, library, data.downloaded, (downloaded) => {
      const lastSync =
        acknowledged.length || !pending.length ? Date.now() : data.lastSync;
      const offset = incoming.serverTime - Date.now();
      store.put(library, key(user.id, "library"));
      store.put(pending, key(user.id, "outbox"));
      store.put(downloaded, key(user.id, "downloads"));
      store.put(user, key(user.id, "user"));
      store.put(user, "lastUser");
      store.put(
        { id: user.id, generation: nextGeneration, status: "active" },
        "activeAccount",
      );
      if (lastSync) store.put(lastSync, key(user.id, "lastSync"));
      store.put(offset, key(user.id, "clockOffset"));
      done({
        library,
        pending: pending.length,
        downloaded,
        generation: nextGeneration,
        lastSync,
        clockOffset: offset,
      });
    });
  });
}
function applySnapshot(result: SnapshotResult, online = true) {
  accountGeneration = result.generation;
  clockOffset = result.clockOffset;
  update({
    library: online
      ? result.library
      : offlineSnapshot(result.library, result.downloaded),
    pending: result.pending,
    downloaded: result.downloaded,
    loading: false,
    online,
    lastSync: result.lastSync || null,
    error: null,
  });
}

async function restoreOffline(): Promise<boolean> {
  const user = await read<User>("lastUser");
  const marker = await read<AccountMarker>("activeAccount");
  if (!user || marker?.id !== user.id || marker.status !== "active")
    return false;
  const restored = await accountTransaction<{
    library?: Library;
    pending: ReviewEvent[];
    downloaded: string[];
    lastSync?: number;
    offset: number;
  }>(user.id, (data, { done, abort }) => {
    if (
      data.marker?.id !== user.id ||
      data.marker.generation !== marker.generation ||
      data.marker.status !== "active"
    ) {
      abort("The local account changed. Connect to sign in.");
      return;
    }
    done({
      library: data.library,
      pending: data.outbox,
      downloaded: data.downloaded,
      lastSync: data.lastSync,
      offset: data.clockOffset || 0,
    });
  });
  clearAccountMemory();
  accountGeneration = marker.generation;
  clockOffset = restored.offset;
  update({
    user,
    library: restored.library
      ? offlineSnapshot(
          mergePending(restored.library, restored.pending),
          restored.downloaded,
        )
      : null,
    pending: restored.pending.length,
    downloaded: restored.downloaded,
    lastSync: restored.lastSync || null,
    loading: false,
    online: false,
    error: null,
  });
  return true;
}

async function refresh(): Promise<void> {
  if (signingOut) return;
  const serial = ++refreshSequence;
  try {
    const observed = await read<AccountMarker>("activeAccount");
    const auth = await api<{ user: User | null; setupRequired: boolean }>(
      "/api/auth/me",
    );
    if (serial !== refreshSequence) return;
    if (!auth.user) {
      const lastUser = await read<User>("lastUser");
      const pending = lastUser
        ? (await read<ReviewEvent[]>(key(lastUser.id, "outbox")))?.length || 0
        : 0;
      if (serial !== refreshSequence) return;
      clearAccountMemory();
      update({
        user: null,
        library: null,
        setupRequired: auth.setupRequired,
        loading: false,
        online: true,
        pending,
        downloaded: [],
        syncing: false,
      });
      return;
    }
    const user = auth.user;
    if (observed?.status === "signingOut" && !signInProof) {
      clearAccountMemory();
      update({
        user: null,
        library: null,
        loading: false,
        error:
          "Sign out is in progress in another tab. Sign in again if that tab was closed.",
      });
      return;
    }
    const library = await api<Library>("/api/library", {
      headers: accountHeaders(user.id),
    });
    if (serial !== refreshSequence) return;
    const result = await saveSnapshot(
      user,
      library,
      [],
      null,
      observed,
      true,
      signInProof,
    );
    if (serial !== refreshSequence) return;
    const changedAccount =
      state.user?.id !== user.id || accountGeneration !== result.generation;
    if (changedAccount) clearAccountMemory();
    signingOut = false;
    signInProof = false;
    update({
      user,
      setupRequired: false,
      ...(changedAccount ? { syncing: false } : {}),
    });
    applySnapshot(result);
    channel?.postMessage({ account: user.id, generation: result.generation });
    if (result.pending) void sync();
  } catch (error) {
    if (serial !== refreshSequence) return;
    if (error instanceof APIError) {
      if (error.code !== "ACCOUNT_CHANGED")
        update({ loading: false, error: error.message });
      return;
    }
    try {
      if (state.user && state.library && accountGeneration)
        update({
          online: false,
          loading: false,
          library: offlineSnapshot(state.library),
        });
      else if (!(await restoreOffline()))
        update({
          loading: false,
          online: false,
          error:
            "Connect to the server to sign in. Downloaded decks are available after your first login.",
        });
    } catch (storageError) {
      update({ loading: false, error: String(storageError) });
    }
  }
}

async function sync(): Promise<void> {
  if (inFlight) {
    syncRequested = true;
    return inFlight;
  }
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch;
  if (!user || !generation || signingOut || !navigator.onLine) return;
  let again = false;
  inFlight = (async () => {
    update({ syncing: true });
    try {
      const outbox = (await read<ReviewEvent[]>(key(user.id, "outbox"))) || [];
      if (!sameAccount(user.id, generation, epoch)) return;
      const response = await api<SyncResponse>("/api/sync", {
        method: "POST",
        headers: accountHeaders(user.id),
        body: JSON.stringify({
          cursor: state.library?.cursor || 0,
          events: outbox.slice(0, 1000),
        }),
      });
      if (!sameAccount(user.id, generation, epoch)) return;
      const merged = await saveSnapshot(
        user,
        response,
        response.acknowledged,
        generation,
      );
      if (!sameAccount(user.id, generation, epoch)) return;
      applySnapshot(merged);
      again = merged.pending > 0;
      channel?.postMessage({ userId: user.id, generation });
    } catch (error) {
      if (!sameAccount(user.id, generation, epoch)) return;
      if (error instanceof APIError && error.status === 401) {
        clearAccountMemory();
        update({
          user: null,
          library: null,
          error:
            "Your login expired. Sign in to the same account to sync your saved reviews.",
        });
      } else if (!(
        error instanceof APIError && error.code === "ACCOUNT_CHANGED"
      ))
        update({
          error:
            error instanceof Error
              ? error.message
              : "Sync failed. Your reviews are saved on this device.",
          online: error instanceof APIError,
        });
    } finally {
      if (sameAccount(user.id, generation, epoch) || !state.user)
        update({ syncing: false });
    }
  })();
  try {
    await inFlight;
  } finally {
    inFlight = null;
    const requested = syncRequested;
    syncRequested = false;
    if (requested || (again && sameAccount(user.id, generation, epoch)))
      queueMicrotask(() => void sync());
  }
}

async function saveEvent(
  event: Omit<ReviewEvent, "deviceId" | "sequence">,
): Promise<ReviewEvent> {
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch;
  if (!user || !state.library || signingOut)
    throw new Error("Sign in before studying.");
  const result = await accountTransaction<{
    saved: ReviewEvent;
    library: Library;
    pending: number;
    downloaded: string[];
  }>(user.id, (data, { store, done, abort }) => {
    if (
      !sameAccount(user.id, generation, epoch) ||
      !requireMarker(data, user.id, generation, abort)
    ) {
      if (!sameAccount(user.id, generation, epoch))
        abort("The account changed before this answer could be saved.");
      return;
    }
    const canonical = data.library;
    if (
      !canonical ||
      !canonical.cards.some((card) => card.id === event.cardId)
    ) {
      abort("This card is no longer available. Refresh your library.");
      return;
    }
    const saved: ReviewEvent = {
      ...event,
      deviceId: data.deviceId || crypto.randomUUID(),
      sequence: data.sequence + 1,
    };
    const pending = [...data.outbox, saved];
    const library = mergePending(canonical, pending);
    store.put(saved.deviceId, "deviceId");
    store.put(saved.sequence, key(user.id, "sequence"));
    store.put(pending, key(user.id, "outbox"));
    store.put(library, key(user.id, "library"));
    done({
      saved,
      library,
      pending: pending.length,
      downloaded: data.downloaded,
    });
  });
  if (sameAccount(user.id, generation, epoch))
    update({
      library: state.online
        ? result.library
        : offlineSnapshot(result.library, result.downloaded),
      pending: result.pending,
      error: null,
    });
  channel?.postMessage({ userId: user.id, generation });
  return result.saved;
}
async function answer(
  card: Card,
  rating: Rating,
  durationMs: number,
): Promise<void> {
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch;
  if (!user) throw new Error("Sign in to continue.");
  const reviewedAt = Math.max(
    Date.now() + clockOffset,
    card.createdAt,
    (card.state.last_review || 0) + 1,
  );
  const event = await saveEvent({
    id: crypto.randomUUID(),
    kind: "review",
    cardId: card.id,
    rating,
    reviewedAt,
    durationMs: Math.max(0, Math.min(60000, Math.round(durationMs))),
    timeZone: user.preferences.timeZone,
    retention: user.preferences.retention,
    schedulerVersion: SCHEDULER_VERSION,
  });
  if (sameAccount(user.id, generation, epoch)) {
    undoStack.push(event);
    if (state.online) void sync();
  }
}
async function undo(): Promise<void> {
  const previous = undoStack.at(-1);
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch;
  if (!previous || !user)
    throw new Error("There is no answer to undo in this session.");
  await saveEvent({
    ...previous,
    id: crypto.randomUUID(),
    kind: "undo",
    undoOf: previous.id,
    reviewedAt: Math.max(Date.now() + clockOffset, previous.reviewedAt + 1),
    durationMs: 0,
  });
  if (sameAccount(user.id, generation, epoch)) {
    undoStack.pop();
    if (state.online) void sync();
  }
}

async function mediaBlob(id: string, userId: string): Promise<Blob> {
  const response = await fetch(`/api/media/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
    cache: "no-store",
    headers: accountHeaders(userId),
  });
  if (!response.ok) {
    if (response.status === 409) queueMicrotask(() => void refresh());
    throw new Error(
      "A media file could not be loaded. Reconnect and try again.",
    );
  }
  if (response.headers.get("X-Account-ID") !== userId)
    throw new Error("The account changed while loading media.");
  return response.blob();
}
async function downloadDeck(deckId: string): Promise<void> {
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch,
    library = state.library;
  if (!user || !library || !generation || signingOut)
    throw new Error("Sign in and load your library first.");
  if (!navigator.onLine) throw new Error("Connect to download this deck.");
  const deckIds = descendantDeckIds(library.decks, deckId);
  const ids = new Set<string>();
  for (const note of library.notes.filter((note) => deckIds.has(note.deckId)))
    for (const id of mediaIds(`${note.front}\n${note.back}\n${note.example}`))
      ids.add(id);
  const media = new Map<string, Blob>();
  for (const id of ids) {
    media.set(id, await mediaBlob(id, user.id));
    if (!sameAccount(user.id, generation, epoch))
      throw new Error("The account changed during download.");
  }
  const result = await accountTransaction<{
    downloaded: string[];
    library: Library;
  }>(user.id, (data, { store, done, abort }) => {
    if (
      !sameAccount(user.id, generation, epoch) ||
      !requireMarker(data, user.id, generation, abort)
    ) {
      if (!sameAccount(user.id, generation, epoch))
        abort("The account changed during download.");
      return;
    }
    const canonical = data.library;
    if (!canonical) {
      abort("Load the library before downloading.");
      return;
    }
    for (const [id, blob] of media)
      store.put(blob, key(user.id, `media:${id}`));
    const latest = mergePending(canonical, data.outbox);
    const requested = [...new Set([...data.downloaded, ...deckIds])];
    readyDownloads(store, user.id, latest, requested, (downloaded) => {
      if ([...deckIds].some((id) => !downloaded.includes(id))) {
        abort(
          "This deck changed during download. Download it again to include all media.",
        );
        return;
      }
      store.put(downloaded, key(user.id, "downloads"));
      store.put(latest, key(user.id, "library"));
      done({ downloaded, library: latest });
    });
  });
  if (sameAccount(user.id, generation, epoch))
    update({
      downloaded: result.downloaded,
      library: state.online
        ? result.library
        : offlineSnapshot(result.library, result.downloaded),
    });
  if (navigator.storage?.persist) void navigator.storage.persist();
}
async function removeDownload(deckId: string): Promise<void> {
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch;
  if (!user) return;
  const downloaded = await accountTransaction<string[]>(
    user.id,
    (data, { store, done, abort }) => {
      if (!requireMarker(data, user.id, generation, abort)) return;
      if (!data.library) {
        done(data.downloaded);
        return;
      }
      const ids = descendantDeckIds(data.library.decks, deckId);
      const cards = new Set(
        data.library.cards
          .filter((card) => ids.has(card.deckId))
          .map((card) => card.id),
      );
      if (data.outbox.some((event) => cards.has(event.cardId))) {
        abort("Sync this deck’s pending reviews before removing its download.");
        return;
      }
      const removed = new Set(ids);
      let changed = true;
      while (changed) {
        changed = false;
        for (const deck of data.library.decks)
          if (
            removed.has(deck.id) &&
            deck.parentId &&
            !removed.has(deck.parentId)
          ) {
            removed.add(deck.parentId);
            changed = true;
          }
      }
      const remaining = data.downloaded.filter((id) => !removed.has(id));
      // Removing a download must actually release its offline media. Shared
      // assets are retained while another downloaded deck still needs them.
      const keepMedia = new Set(
        data.library.notes
          .filter((note) => remaining.includes(note.deckId))
          .flatMap((note) =>
            mediaIds(`${note.front}\n${note.back}\n${note.example}`),
          ),
      );
      const prefix = key(user.id, "media:");
      const cursor = store.openCursor(
        IDBKeyRange.bound(prefix, `${prefix}\uffff`),
      );
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (!keepMedia.has(String(entry.key).slice(prefix.length)))
          entry.delete();
        entry.continue();
      };
      store.put(remaining, key(user.id, "downloads"));
      done(remaining);
    },
  );
  if (sameAccount(user.id, generation, epoch))
    update({
      downloaded,
      library:
        state.library && !state.online
          ? offlineSnapshot(state.library, downloaded)
          : state.library,
    });
}
export async function localMediaUrl(id: string): Promise<string> {
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch;
  if (!user) throw new Error("Sign in to load media.");
  const name = key(user.id, `media:${id}`);
  if (urls.has(name)) return urls.get(name)!;
  const blob = (await read<Blob>(name)) || (await mediaBlob(id, user.id));
  if (!sameAccount(user.id, generation, epoch))
    throw new Error("The account changed while loading media.");
  const existing = urls.get(name);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  urls.set(name, url);
  return url;
}

async function logout(): Promise<void> {
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch;
  if (!user || !generation || signingOut) return;
  if (state.pending) await sync();
  if (inFlight) await inFlight;
  if (!sameAccount(user.id, generation, epoch))
    throw new Error(
      "The account changed. Check the current account before signing out.",
    );
  await accountTransaction(user.id, (data, { store, done, abort }) => {
    if (!requireMarker(data, user.id, generation, abort)) return;
    if (data.outbox.length) {
      abort(
        "Your reviews are saved here but have not synced. Reconnect and sync before signing out.",
      );
      return;
    }
    store.put(
      { id: user.id, generation, status: "signingOut" },
      "activeAccount",
    );
    done(undefined);
  });
  signingOut = true;
  try {
    await api("/api/auth/logout", {
      method: "POST",
      headers: accountHeaders(user.id),
    });
    await accountTransaction(user.id, (data, { store, done, abort }) => {
      if (
        data.marker?.id === user.id &&
        (data.marker.generation !== generation ||
          data.marker.status !== "signingOut")
      ) {
        done(undefined);
        return;
      }
      if (data.outbox.length) {
        abort("A pending review was found. Local data has been kept.");
        return;
      }
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) {
          done(undefined);
          return;
        }
        const name = String(entry.key);
        if (
          name.startsWith(`user:${user.id}:`) &&
          name !== key(user.id, "sequence")
        )
          entry.delete();
        if (
          (name === "lastUser" && data.lastUser?.id === user.id) ||
          (name === "activeAccount" &&
            data.marker?.id === user.id &&
            data.marker.generation === generation)
        )
          entry.delete();
        entry.continue();
      };
    });
    if (sameAccount(user.id, generation, epoch)) {
      clearAccountMemory();
      update({
        user: null,
        library: null,
        pending: 0,
        downloaded: [],
        lastSync: null,
        error: null,
        syncing: false,
      });
    }
    channel?.postMessage({ logout: user.id, generation });
  } catch (error) {
    await accountTransaction(user.id, (data, { store, done }) => {
      if (
        data.marker?.id === user.id &&
        data.marker.generation === generation &&
        data.marker.status === "signingOut"
      )
        store.put({ ...data.marker, status: "active" }, "activeAccount");
      done(undefined);
    });
    throw error;
  } finally {
    signingOut = false;
  }
}

async function receiveAccountUpdate(data: any) {
  if (data.logout === state.user?.id && data.generation === accountGeneration) {
    clearAccountMemory();
    update({
      user: null,
      library: null,
      downloaded: [],
      pending: 0,
      syncing: false,
    });
    return;
  }
  if (
    data.account &&
    (data.account !== state.user?.id || data.generation !== accountGeneration)
  ) {
    void refresh();
    return;
  }
  const user = state.user,
    generation = accountGeneration,
    epoch = accountEpoch;
  if (data.userId !== user?.id || data.generation !== generation || !user)
    return;
  const snapshot = await accountTransaction<AccountData>(
    user.id,
    (value, { done, abort }) => {
      if (!requireMarker(value, user.id, generation, abort)) return;
      done(value);
    },
  );
  if (sameAccount(user.id, generation, epoch) && snapshot.library) {
    const library = mergePending(snapshot.library, snapshot.outbox);
    update({
      library: state.online
        ? library
        : offlineSnapshot(library, snapshot.downloaded),
      pending: snapshot.outbox.length,
      downloaded: snapshot.downloaded,
      lastSync: snapshot.lastSync || null,
    });
  }
}
function initialize() {
  if (initialized) return;
  initialized = true;
  void refresh();
  window.addEventListener("online", () => {
    update({ online: true });
    void refresh();
  });
  window.addEventListener("offline", () =>
    update({
      online: false,
      library: state.library ? offlineSnapshot(state.library) : null,
    }),
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.user) void sync();
  });
  window.setInterval(() => {
    if (
      document.visibilityState === "visible" &&
      state.user &&
      navigator.onLine
    )
      void sync();
  }, 45000);
  if ("BroadcastChannel" in window) {
    // Keep already-open tabs informed of account changes during the rename.
    channel = new BroadcastChannel("recall-sync");
    channel.onmessage = ({ data }) => {
      void receiveAccountUpdate(data).catch(() => {
        /* The next refresh checks account generation. */
      });
    };
  }
  if (
    "serviceWorker" in navigator &&
    (location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1")
  ) {
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* Retry installation next load. */
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }
}
export function useLibrary() {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(initialize, [initialize]);
  return {
    ...snapshot,
    refresh,
    sync,
    downloadDeck,
    removeDownload,
    answer,
    undo,
    logout,
  };
}
