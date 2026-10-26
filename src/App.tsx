import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type FormEvent,
  type CSSProperties,
} from "react";
import { api, useLibrary, getQueue, cardPresentation } from "./client";
import { schedule, intervalLabel, studyDay } from "./shared/scheduler";
import {
  DECK_COLORS,
  type Card,
  type Deck,
  type ImportPreview,
  type Library,
  type Note,
  type NoteType,
  type Preferences,
  type Rating,
  type User,
} from "./shared/types";
import { Brand, Icon, type IconName } from "./components/Icon";
import { Modal } from "./components/Modal";
import { CardContent } from "./components/CardContent";
import "./index.css";

type Page = "today" | "library" | "analytics" | "settings";
const nav: { id: Page; label: string; icon: IconName }[] = [
  { id: "today", label: "Study", icon: "cards" },
  { id: "library", label: "Decks", icon: "library" },
  { id: "analytics", label: "Statistics", icon: "chart" },
  { id: "settings", label: "Settings", icon: "settings" },
];
const emptyLibrary: Library = {
  decks: [],
  notes: [],
  cards: [],
  reviews: [],
  cursor: 0,
  serverTime: 0,
};
const json = (data: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";
function activeReviews(library: Library) {
  const undone = new Set(
    library.reviews.filter((r) => r.kind === "undo").map((r) => r.undoOf),
  );
  return library.reviews.filter(
    (r) => r.kind === "review" && !undone.has(r.id),
  );
}
function dayOffset(day: string, offset: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function getStats(library: Library, user: User) {
  const reviews = activeReviews(library),
    today = studyDay(Date.now(), user.preferences.timeZone),
    byDay: Record<string, number> = {};
  for (const r of reviews) {
    const d = studyDay(r.reviewedAt, r.timeZone);
    byDay[d] = (byDay[d] || 0) + 1;
  }
  let streak = 0;
  let cursor = byDay[today] ? today : dayOffset(today, -1);
  while (byDay[cursor]) {
    streak++;
    cursor = dayOffset(cursor, -1);
  }
  let longest = 0,
    run = 0,
    prev = "";
  for (const day of Object.keys(byDay).sort()) {
    run = prev && dayOffset(prev, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }
  const todays = reviews.filter(
    (r) => studyDay(r.reviewedAt, r.timeZone) === today,
  );
  return {
    reviews,
    today,
    byDay,
    streak,
    longest,
    todays,
    minutes: Math.round(todays.reduce((a, r) => a + r.durationMs, 0) / 60000),
  };
}
function plainCardText(text: string) {
  return text
    .replace(/\[\[(?:image|audio):[^\]]+\]\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function countLabel(n: number, singular: string, plural = `${singular}s`) {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}
function shortNumber(n: number) {
  return n >= 10000
    ? `${(n / 1000).toFixed(0)}k`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
}
function dateLabel(at: number) {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
function Button({
  children,
  onClick,
  kind = "primary",
  icon,
  disabled = false,
  type = "button",
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`button button-${kind} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <Icon name={icon} size={17} />}
      <span>{children}</span>
    </button>
  );
}
function Empty({
  title,
  detail,
  children,
}: {
  icon?: IconName;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{detail}</p>
      {children && <div className="inline-actions">{children}</div>}
    </div>
  );
}

export function App() {
  const store = useLibrary(),
    {
      user,
      loading,
      setupRequired,
      library: rawLibrary,
      online,
      pending,
      syncing,
      lastSync,
      downloaded,
    } = store;
  const library = rawLibrary || emptyLibrary;
  const [page, setPage] = useState<Page>(() => {
    const p = location.hash.slice(1);
    return nav.some((n) => n.id === p) ? (p as Page) : "today";
  });
  const [deckId, setDeckId] = useState<string | null>(null),
    [deckDialog, setDeckDialog] = useState<Deck | "new" | null>(null),
    [noteDialog, setNoteDialog] = useState<Note | "new" | null>(null),
    [importOpen, setImportOpen] = useState(false),
    [reviewOpen, setReviewOpen] = useState(false),
    [reviewDeck, setReviewDeck] = useState<string | undefined>(),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false);
  function notify(t: string) {
    setToast(t);
  }
  function navigate(p: Page) {
    setPage(p);
    location.hash = p;
    if (p !== "library") setDeckId(null);
  }
  useEffect(() => {
    const f = () => {
      const p = location.hash.slice(1);
      if (nav.some((n) => n.id === p)) setPage(p as Page);
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page, deckId]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    document.documentElement.dataset.theme =
      user?.preferences.theme || "system";
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const updateBrowserTheme = () => {
      const background = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg")
        .trim();
      if (background)
        document
          .querySelector('meta[name="theme-color"]')
          ?.setAttribute("content", background);
    };
    updateBrowserTheme();
    preference.addEventListener("change", updateBrowserTheme);
    return () => preference.removeEventListener("change", updateBrowserTheme);
  }, [user?.preferences.theme]);
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (pending) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [pending]);
  const stats = useMemo(
    () => (user ? getStats(library, user) : null),
    [library, user],
  );
  const queue = useMemo(
    () => (user ? getQueue(library, user) : []),
    [library, user],
  );
  async function mutate(action: () => Promise<unknown>, success?: string) {
    try {
      setBusy(true);
      await action();
      await store.refresh();
      if (success) notify(success);
    } catch (e) {
      notify(message(e));
    } finally {
      setBusy(false);
    }
  }
  function addCard() {
    if (library.decks.length) setNoteDialog("new");
    else setDeckDialog("new");
  }
  function study(id?: string) {
    setReviewDeck(id);
    setReviewOpen(true);
  }
  if (loading && !user)
    return (
      <div className="initial-loader">
        <Brand />
        <div className="spinner" />
        <p>Opening your library…</p>
      </div>
    );
  if (!user)
    return <Auth setup={setupRequired} onSuccess={() => store.refresh()} />;
  const selectedDeck = library.decks.find((d) => d.id === deckId);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand-link"
          href="#today"
          onClick={() => navigate("today")}
          aria-label="lll home"
        >
          <Brand />
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${page === n.id ? "active" : ""}`}
              aria-current={page === n.id ? "page" : undefined}
              onClick={() => navigate(n.id)}
            >
              <span>{n.label}</span>
              {n.id === "today" && queue.length > 0 && (
                <span className="nav-count">{queue.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sync-status">
            <span
              className={`status-dot ${!online ? "offline" : pending ? "pending" : ""}`}
            />
            <span>
              {!online
                ? "Offline"
                : syncing
                  ? "Syncing…"
                  : pending
                    ? `${pending} pending ${pending === 1 ? "review" : "reviews"}`
                    : "Synced"}
            </span>
            {online && pending > 0 && (
              <button
                aria-label="Sync now"
                onClick={() => store.sync().catch((e) => notify(message(e)))}
              >
                <Icon name="undo" size={14} />
              </button>
            )}
          </div>
          <button
            className="profile-button"
            onClick={() => navigate("settings")}
          >
            <span>{user.username}</span>
          </button>
        </div>
      </aside>
      <div className="main-area">
        {!online && (
          <div className="offline-banner">
            <Icon name="wifi" size={16} />
            You’re offline. Downloaded decks are ready to study; reviews will
            sync when you reconnect.
          </div>
        )}
        {store.error && (
          <div className="error-banner" role="alert">
            {store.error}
            <button onClick={() => store.refresh()}>Try again</button>
          </div>
        )}
        <main className={`content page-${page}`}>
          {page === "today" && stats && (
            <Today
              user={user}
              library={library}
              stats={stats}
              queue={queue}
              study={study}
              openDeck={(id) => {
                navigate("library");
                setDeckId(id);
              }}
              onAdd={addCard}
              onNewDeck={() => setDeckDialog("new")}
              onImport={() => setImportOpen(true)}
              online={online}
            />
          )}
          {page === "library" && (
            <LibraryPage
              user={user}
              library={library}
              selected={selectedDeck}
              select={setDeckId}
              study={study}
              onNewDeck={() => setDeckDialog("new")}
              onEditDeck={setDeckDialog}
              onAdd={addCard}
              onEditNote={setNoteDialog}
              onImport={() => setImportOpen(true)}
              onMutate={mutate}
              busy={busy}
              online={online}
              downloaded={downloaded}
              download={(id) =>
                store
                  .downloadDeck(id)
                  .then(() => notify("Deck is available offline"))
                  .catch((e) => notify(message(e)))
              }
              removeDownload={(id) =>
                store.removeDownload(id).catch((e) => notify(message(e)))
              }
            />
          )}
          {page === "analytics" && <Analytics library={library} user={user} />}
          {page === "settings" && (
            <Settings
              user={user}
              online={online}
              pending={pending}
              lastSync={lastSync}
              syncing={syncing}
              downloaded={downloaded.length}
              onSave={(prefs) =>
                mutate(
                  () => api("/api/preferences", json(prefs, "PUT")),
                  "Preferences saved",
                )
              }
              onLogout={async () => {
                if (
                  pending &&
                  !confirm(
                    `You have ${countLabel(pending, "unsynced review")}. Keep this account open until they sync, or log out anyway?`,
                  )
                )
                  return;
                await store.logout();
              }}
              sync={() => store.sync().catch((e) => notify(message(e)))}
              notify={notify}
            />
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.map((n) => (
          <button
            key={n.id}
            className={page === n.id ? "active" : ""}
            aria-current={page === n.id ? "page" : undefined}
            onClick={() => navigate(n.id)}
          >
            <Icon name={n.icon} size={21} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
      {deckDialog && (
        <DeckEditor
          deck={deckDialog === "new" ? undefined : deckDialog}
          decks={library.decks}
          onClose={() => setDeckDialog(null)}
          onSave={async (data) => {
            await api(
              `/api/decks${deckDialog === "new" ? "" : `/${deckDialog.id}`}`,
              json(data, deckDialog === "new" ? "POST" : "PUT"),
            );
            await store.refresh();
            setDeckDialog(null);
            notify(deckDialog === "new" ? "Deck created" : "Deck updated");
          }}
        />
      )}
      {noteDialog && (
        <NoteEditor
          note={noteDialog === "new" ? undefined : noteDialog}
          decks={library.decks}
          defaultDeckId={deckId || library.decks[0]?.id || ""}
          onClose={() => setNoteDialog(null)}
          onSave={async (data, keepOpen) => {
            await api(
              `/api/notes${noteDialog === "new" ? "" : `/${noteDialog.id}`}`,
              json(data, noteDialog === "new" ? "POST" : "PUT"),
            );
            await store.refresh();
            notify(noteDialog === "new" ? "Card added" : "Card updated");
            if (!keepOpen) setNoteDialog(null);
          }}
        />
      )}
      {importOpen && (
        <ImportDialog
          decks={library.decks}
          defaultDeckId={deckId || ""}
          onClose={() => setImportOpen(false)}
          onSuccess={async () => {
            await store.refresh();
            setImportOpen(false);
            notify("Import complete");
          }}
        />
      )}
      {reviewOpen && (
        <Review
          library={library}
          user={user}
          deckId={reviewDeck}
          answer={store.answer}
          undo={store.undo}
          pending={pending}
          onClose={() => setReviewOpen(false)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function Auth({
  setup,
  onSuccess,
}: {
  setup: boolean;
  onSuccess: () => Promise<void>;
}) {
  const invite =
    new URLSearchParams(location.hash.slice(1)).get("invite") ||
    new URLSearchParams(location.search).get("invite");
  const [register, setRegister] = useState(!!invite),
    [bootstrapToken, setBootstrapToken] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api(
        `/api/auth/${setup ? "setup" : register ? "register" : "login"}`,
        json({
          username,
          password,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          invite,
          bootstrapToken,
        }),
      );
      setPassword("");
      setBootstrapToken("");
      if (invite) history.replaceState({}, "", location.pathname);
      await onSuccess();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-panel">
        <h2>
          {setup
            ? "Create administrator account"
            : register
              ? "Create an account"
              : "Sign in"}
        </h2>
        {(setup || register) && (
          <p className="muted">
            {setup
              ? "Create the first account for this lll instance."
              : register
                ? "Create an account with your invitation."
                : ""}
          </p>
        )}
        <form onSubmit={submit}>
          {setup && (
            <label>
              Setup token <span className="optional">if configured</span>
              <input
                type="password"
                value={bootstrapToken}
                onChange={(e) => setBootstrapToken(e.target.value)}
                autoComplete="off"
                placeholder="Token from your administrator"
              />
            </label>
          )}
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              minLength={3}
              maxLength={40}
              required
              placeholder="Your username"
              autoFocus
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={
                setup || register ? "new-password" : "current-password"
              }
              maxLength={256}
              minLength={setup || register ? 12 : 1}
              required
              placeholder={
                setup || register
                  ? "At least 12 characters"
                  : "Enter your password"
              }
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="full-width">
            {busy
              ? "Please wait…"
              : setup
                ? "Create account"
                : register
                  ? "Create account"
                  : "Sign in"}
          </Button>
        </form>
        {!setup && invite && (
          <button
            className="text-button auth-switch"
            onClick={() => setRegister(!register)}
          >
            {register
              ? "Already have an account? Sign in"
              : "Create an account with this invitation"}
          </button>
        )}
      </section>
    </div>
  );
}

function Today({
  user,
  library,
  stats,
  queue,
  study,
  openDeck,
  onAdd,
  onNewDeck,
  onImport,
  online,
}: {
  user: User;
  library: Library;
  stats: ReturnType<typeof getStats>;
  queue: Card[];
  study: (id?: string) => void;
  openDeck: (id: string) => void;
  onAdd: () => void;
  onNewDeck: () => void;
  onImport: () => void;
  online: boolean;
}) {
  const due = queue.filter((c) => c.state.reps > 0).length,
    newCount = queue.filter((c) => !c.state.reps).length,
    goal = user.preferences.dailyGoal;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Study</h1>
        </div>
        <Button kind="secondary" icon="plus" onClick={onAdd} disabled={!online}>
          Add cards
        </Button>
      </div>
      <section className="study-summary" aria-label="Study queue">
        <div>
          <h2>
            {queue.length
              ? `${countLabel(queue.length, "card")} to study`
              : library.cards.length
                ? "No cards due"
                : "No cards yet"}
          </h2>
          <p>
            {queue.length
              ? `${countLabel(due, "review")} due · ${newCount} new`
              : library.cards.length
                ? "Scheduled cards will appear here when they are due."
                : "Create a deck or import an Anki, CSV, or TSV file."}
          </p>
        </div>
        <div className="inline-actions">
          {queue.length ? (
            <Button onClick={() => study()}>Study now</Button>
          ) : !library.decks.length ? (
            <Button onClick={onNewDeck} disabled={!online}>
              Create deck
            </Button>
          ) : (
            <Button onClick={onAdd} disabled={!online}>
              Add cards
            </Button>
          )}
          {!library.cards.length && (
            <Button kind="secondary" onClick={onImport} disabled={!online}>
              Import
            </Button>
          )}
        </div>
      </section>
      <dl className="study-totals" aria-label="Today’s study">
        <div>
          <dt>Reviewed today</dt>
          <dd>{stats.todays.length}</dd>
        </div>
        <div>
          <dt>Study time</dt>
          <dd>{stats.minutes} min</dd>
        </div>
        <div>
          <dt>Streak</dt>
          <dd>{countLabel(stats.streak, "day")}</dd>
        </div>
      </dl>
      <div className="today-progress">
        <label htmlFor="today-goal">
          Daily goal{" "}
          <span>
            {stats.todays.length} / {goal}
          </span>
        </label>
        <progress
          id="today-goal"
          value={Math.min(stats.todays.length, goal)}
          max={goal}
        />
      </div>
      <div className="section-heading">
        <h2>
          Decks <span className="heading-count">{library.decks.length}</span>
        </h2>
        <button className="text-button" onClick={onNewDeck} disabled={!online}>
          <Icon name="plus" size={16} /> New deck
        </button>
      </div>
      {library.decks.length ? (
        <div className="deck-list">
          {library.decks.map((deck) => (
            <DeckTile
              key={deck.id}
              deck={deck}
              library={library}
              user={user}
              onOpen={() => openDeck(deck.id)}
              onStudy={() => study(deck.id)}
            />
          ))}
        </div>
      ) : (
        <p className="small-muted">No decks yet.</p>
      )}
    </>
  );
}
function DeckTile({
  deck,
  library,
  user,
  onOpen,
  onStudy,
}: {
  deck: Deck;
  library: Library;
  user: User;
  onOpen: () => void;
  onStudy: () => void;
}) {
  const cards = library.cards.filter((c) => c.deckId === deck.id),
    queue = getQueue(library, user, deck.id),
    due = queue.filter((c) => c.state.reps > 0).length,
    newCount = queue.length - due;
  return (
    <article
      className="deck-tile"
      style={{ "--deck-color": deck.color } as CSSProperties}
    >
      <button
        className="deck-open"
        onClick={onOpen}
        aria-label={`Open ${deck.name}`}
      >
        <strong className="deck-name">{deck.name}</strong>
        {deck.description && (
          <span className="deck-description">{deck.description}</span>
        )}
        <span className="deck-meta">{countLabel(cards.length, "card")}</span>
      </button>
      <div className="deck-counts" aria-label={`${due} due, ${newCount} new`}>
        <span>
          <strong>{due}</strong> due
        </span>
        <span>
          <strong>{newCount}</strong> new
        </span>
      </div>
      <button
        className="deck-study"
        onClick={onStudy}
        disabled={!queue.length}
        aria-label={`Study ${deck.name}`}
      >
        Study
      </button>
    </article>
  );
}

function LibraryPage({
  user,
  library,
  selected,
  select,
  study,
  onNewDeck,
  onEditDeck,
  onAdd,
  onEditNote,
  onImport,
  onMutate,
  busy,
  online,
  downloaded,
  download,
  removeDownload,
}: {
  user: User;
  library: Library;
  selected?: Deck;
  select: (id: string | null) => void;
  study: (id?: string) => void;
  onNewDeck: () => void;
  onEditDeck: (d: Deck) => void;
  onAdd: () => void;
  onEditNote: (n: Note) => void;
  onImport: () => void;
  onMutate: (action: () => Promise<unknown>, success?: string) => Promise<void>;
  busy: boolean;
  online: boolean;
  downloaded: string[];
  download: (id: string) => Promise<void>;
  removeDownload: (id: string) => Promise<void>;
}) {
  const [search, setSearch] = useState(""),
    [type, setType] = useState("all"),
    [tag, setTag] = useState(""),
    [tab, setTab] = useState<"decks" | "cards">("decks"),
    [actionNote, setActionNote] = useState<Note | null>(null),
    [downloadBusy, setDownloadBusy] = useState(false);
  const notes = library.notes.filter(
    (n) =>
      (!selected || n.deckId === selected.id) &&
      (!search ||
        `${n.front} ${n.back} ${n.tags.join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (type === "all" || n.type === type) &&
      (!tag || n.tags.includes(tag)),
  );
  const matchingDecks = library.decks.filter((d) =>
    `${d.name} ${d.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  const tags = [
    ...new Set(
      library.notes
        .filter((n) => !selected || n.deckId === selected.id)
        .flatMap((n) => n.tags),
    ),
  ].sort();
  const queue = selected ? getQueue(library, user, selected.id) : [];
  function deleteDeck() {
    if (
      !selected ||
      !confirm(
        `Delete “${selected.name}” and all its cards? Review history will be kept.`,
      )
    )
      return;
    const id = selected.id;
    onMutate(
      () => api(`/api/decks/${id}`, { method: "DELETE" }),
      "Deck deleted",
    ).then(() => select(null));
  }
  return (
    <>
      <div className="page-heading">
        <div>
          {selected && (
            <button className="back-link" onClick={() => select(null)}>
              ← All decks
            </button>
          )}
          <h1>{selected ? selected.name : "Decks"}</h1>
          <p>
            {selected
              ? selected.description ||
                `${countLabel(library.cards.filter((c) => c.deckId === selected.id).length, "card")}`
              : `${countLabel(library.decks.length, "deck")} · ${countLabel(library.cards.length, "card")}`}
          </p>
        </div>
        <div className="inline-actions">
          <Button
            kind="secondary"
            icon="upload"
            onClick={onImport}
            disabled={!online}
          >
            Import
          </Button>
          <Button
            icon="plus"
            onClick={selected ? onAdd : onNewDeck}
            disabled={!online}
          >
            {selected ? "Add cards" : "New deck"}
          </Button>
        </div>
      </div>
      {selected && (
        <div
          className="deck-detail-banner"
          style={{ "--deck-color": selected.color } as CSSProperties}
        >
          <div>
            <strong>{countLabel(queue.length, "card")} ready</strong>
            <p>
              {downloaded.includes(selected.id)
                ? "Available offline on this device"
                : "Download this deck to study offline"}
            </p>
          </div>
          <div className="inline-actions">
            <button
              className="icon-button"
              title="Edit deck"
              aria-label="Edit deck"
              onClick={() => onEditDeck(selected)}
              disabled={!online}
            >
              <Icon name="edit" />
            </button>
            <button
              className="icon-button danger-text"
              title="Delete deck"
              aria-label="Delete deck"
              onClick={deleteDeck}
              disabled={!online || busy}
            >
              <Icon name="trash" />
            </button>
            <Button
              kind="secondary"
              icon={downloaded.includes(selected.id) ? "check" : "download"}
              disabled={
                downloadBusy || (!online && !downloaded.includes(selected.id))
              }
              onClick={async () => {
                setDownloadBusy(true);
                try {
                  if (downloaded.includes(selected.id)) {
                    if (
                      confirm(
                        "Remove this deck’s offline download? Pending reviews will be kept.",
                      )
                    )
                      await removeDownload(selected.id);
                  } else await download(selected.id);
                } finally {
                  setDownloadBusy(false);
                }
              }}
            >
              {downloadBusy
                ? "Downloading…"
                : downloaded.includes(selected.id)
                  ? "Downloaded"
                  : "Download"}
            </Button>
            <Button
              icon="play"
              disabled={!queue.length}
              onClick={() => study(selected.id)}
            >
              Study deck
            </Button>
          </div>
        </div>
      )}
      <div className="library-toolbar">
        <div className="segmented">
          {!selected && (
            <>
              <button
                className={tab === "decks" ? "selected" : ""}
                onClick={() => setTab("decks")}
              >
                <Icon name="library" size={16} />
                Decks
              </button>
              <button
                className={tab === "cards" ? "selected" : ""}
                onClick={() => setTab("cards")}
              >
                <Icon name="cards" size={16} />
                Cards
              </button>
            </>
          )}
          {selected && (
            <span className="toolbar-label">
              Notes <span className="heading-count">{notes.length}</span>
            </span>
          )}
        </div>
        <label className="search-field">
          <Icon name="search" size={18} />
          <input
            aria-label={
              selected || tab === "cards" ? "Search cards" : "Search decks"
            }
            placeholder={
              selected || tab === "cards"
                ? "Search cards, words, tags…"
                : "Search your decks…"
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {(selected || tab === "cards") && (
          <>
            <select
              aria-label="Filter by card type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="all">All types</option>
              <option value="basic">Basic</option>
              <option value="reverse">Reverse</option>
              <option value="vocabulary">Vocabulary</option>
              <option value="cloze">Cloze</option>
            </select>
            {tags.length > 0 && (
              <select
                aria-label="Filter by tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
              >
                <option value="">All tags</option>
                {tags.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            )}
          </>
        )}
      </div>
      {!selected && tab === "decks" ? (
        library.decks.length ? (
          <div className="deck-list">
            {matchingDecks.map((d) => (
              <DeckTile
                key={d.id}
                deck={d}
                library={library}
                user={user}
                onOpen={() => select(d.id)}
                onStudy={() => study(d.id)}
              />
            ))}
            {!matchingDecks.length && (
              <p className="small-muted">No matching decks.</p>
            )}
          </div>
        ) : (
          <div className="panel">
            <Empty
              icon="library"
              title="No decks yet."
              detail="Create a deck or import an existing collection."
            >
              <Button icon="plus" onClick={onNewDeck} disabled={!online}>
                Create a deck
              </Button>
              <Button
                kind="secondary"
                icon="upload"
                onClick={onImport}
                disabled={!online}
              >
                Import
              </Button>
            </Empty>
          </div>
        )
      ) : (
        <>
          <div className="card-table panel">
            <div className="card-table-head">
              <span>FRONT / WORD</span>
              <span>BACK / ANSWER</span>
              <span>TYPE & STATUS</span>
              <span />
            </div>
            {notes.length ? (
              notes.map((n) => {
                const cards = library.cards.filter((c) => c.noteId === n.id),
                  suspended = cards.every((c) => c.suspended),
                  due = cards.some(
                    (c) => c.state.reps && c.state.due <= Date.now(),
                  );
                return (
                  <div className="card-row" key={n.id}>
                    <button
                      className="card-front-cell"
                      onClick={() => onEditNote(n)}
                      disabled={!online}
                    >
                      <strong>
                        {n.front.replace(
                          /\[\[(image|audio):[^\]]+\]\]/g,
                          "[media]",
                        )}
                      </strong>
                      <span>
                        {n.tags.length
                          ? n.tags.map((t) => `#${t}`).join("  ")
                          : library.decks.find((d) => d.id === n.deckId)?.name}
                      </span>
                    </button>
                    <span className="card-back-cell">
                      {n.back.replace(
                        /\[\[(image|audio):[^\]]+\]\]/g,
                        "[media]",
                      ) ||
                        n.example ||
                        "Cloze deletion"}
                    </span>
                    <span className="card-status-cell">
                      <span className="type-tag">{n.type}</span>
                      <span
                        className={`card-state ${suspended ? "suspended" : due ? "due" : ""}`}
                      >
                        {suspended
                          ? "Suspended"
                          : cards.every((c) => !c.state.reps)
                            ? "New"
                            : due
                              ? "Due"
                              : `Next ${dateLabel(Math.min(...cards.map((c) => c.state.due)))}`}
                      </span>
                    </span>
                    <div className="row-actions">
                      <button
                        className="icon-button"
                        aria-label={`Edit ${n.front}`}
                        title="Edit card"
                        onClick={() => onEditNote(n)}
                        disabled={!online}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`${suspended ? "Resume" : "Suspend"} ${n.front}`}
                        title={suspended ? "Resume card" : "Suspend card"}
                        onClick={() =>
                          onMutate(() =>
                            Promise.all(
                              cards.map((c) =>
                                api(
                                  `/api/cards/${c.id}`,
                                  json({ suspended: !suspended }, "PATCH"),
                                ),
                              ),
                            ),
                          )
                        }
                        disabled={!online || busy}
                      >
                        <Icon name={suspended ? "play" : "pause"} size={16} />
                      </button>
                      <button
                        className="icon-button danger-text"
                        aria-label={`Delete ${n.front}`}
                        title="Delete card"
                        onClick={() => {
                          if (confirm("Delete this note and its cards?"))
                            onMutate(
                              () =>
                                api(`/api/notes/${n.id}`, { method: "DELETE" }),
                              "Card deleted",
                            );
                        }}
                        disabled={!online || busy}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                      <button
                        className="icon-button card-more"
                        aria-label={`Actions for ${n.front}`}
                        onClick={() => setActionNote(n)}
                        disabled={!online}
                      >
                        <Icon name="more" size={19} />
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <Empty
                icon="search"
                title={search || tag ? "No matching cards." : "No cards yet."}
                detail={
                  search || tag
                    ? "Try a different search or filter."
                    : "Add a card or import a list into this deck."
                }
              >
                {!search && !tag && (
                  <Button icon="plus" onClick={onAdd} disabled={!online}>
                    Add a card
                  </Button>
                )}
              </Empty>
            )}
          </div>
          {selected && (
            <div className="export-row">
              <span>
                {countLabel(notes.length, "note")} ·{" "}
                {countLabel(
                  library.cards.filter((c) => c.deckId === selected.id).length,
                  "card",
                )}
              </span>
              <div>
                <a
                  href={`/api/exports?deckId=${encodeURIComponent(selected.id)}&format=csv`}
                  download
                >
                  Export CSV <Icon name="download" size={14} />
                </a>
                <a
                  href={`/api/exports?deckId=${encodeURIComponent(selected.id)}&format=bundle`}
                  download
                >
                  Portable backup <Icon name="download" size={14} />
                </a>
              </div>
            </div>
          )}
        </>
      )}
      {actionNote && (
        <Modal
          title="Card actions"
          subtitle={plainCardText(actionNote.front).slice(0, 100)}
          onClose={() => setActionNote(null)}
        >
          <div className="card-action-list">
            <Button
              kind="secondary"
              icon="edit"
              onClick={() => {
                onEditNote(actionNote);
                setActionNote(null);
              }}
            >
              Edit or move card
            </Button>
            <Button
              kind="secondary"
              icon={
                library.cards
                  .filter((c) => c.noteId === actionNote.id)
                  .every((c) => c.suspended)
                  ? "play"
                  : "pause"
              }
              onClick={async () => {
                const cards = library.cards.filter(
                    (c) => c.noteId === actionNote.id,
                  ),
                  suspended = cards.every((c) => c.suspended);
                await onMutate(() =>
                  Promise.all(
                    cards.map((c) =>
                      api(
                        `/api/cards/${c.id}`,
                        json({ suspended: !suspended }, "PATCH"),
                      ),
                    ),
                  ),
                );
                setActionNote(null);
              }}
            >
              {library.cards
                .filter((c) => c.noteId === actionNote.id)
                .every((c) => c.suspended)
                ? "Resume card"
                : "Suspend card"}
            </Button>
            <Button
              kind="danger"
              icon="trash"
              onClick={async () => {
                if (!confirm("Delete this note and its cards?")) return;
                await onMutate(
                  () =>
                    api(`/api/notes/${actionNote.id}`, { method: "DELETE" }),
                  "Card deleted",
                );
                setActionNote(null);
              }}
            >
              Delete card
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function DeckEditor({
  deck,
  decks,
  onClose,
  onSave,
}: {
  deck?: Deck;
  decks: Deck[];
  onClose: () => void;
  onSave: (data: unknown) => Promise<void>;
}) {
  const [name, setName] = useState(deck?.name || ""),
    [description, setDescription] = useState(deck?.description || ""),
    [color, setColor] = useState(deck?.color || DECK_COLORS[0]!),
    [parentId, setParentId] = useState(deck?.parentId || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        color,
        parentId: parentId || null,
      });
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={deck ? "Edit deck" : "Create deck"}
      subtitle={
        deck
          ? "Change the name, description, or parent deck."
          : "Choose a name and optional parent deck."
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        <label>
          Deck name
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Everyday Italian"
          />
        </label>
        <label>
          Description <span className="optional">optional</span>
          <textarea
            rows={2}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you learning?"
          />
        </label>
        <div className="form-row">
          <label>
            Parent deck
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">None · top-level deck</option>
              {decks
                .filter((d) => d.id !== deck?.id)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </label>
          <fieldset className="color-field">
            <legend>Deck color</legend>
            <div className="color-options">
              {DECK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  style={{ background: c }}
                  className={color === c ? "selected" : ""}
                  onClick={() => setColor(c)}
                >
                  {color === c && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : deck ? "Save changes" : "Create deck"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function NoteEditor({
  note,
  decks,
  defaultDeckId,
  onClose,
  onSave,
}: {
  note?: Note;
  decks: Deck[];
  defaultDeckId: string;
  onClose: () => void;
  onSave: (data: unknown, keepOpen: boolean) => Promise<void>;
}) {
  const [type, setType] = useState<NoteType>(note?.type || "vocabulary"),
    [deckId, setDeckId] = useState(note?.deckId || defaultDeckId),
    [front, setFront] = useState(note?.front || ""),
    [back, setBack] = useState(note?.back || ""),
    [example, setExample] = useState(note?.example || ""),
    [tags, setTags] = useState(note?.tags.join(", ") || ""),
    [sourceLang, setSourceLang] = useState(note?.sourceLang || ""),
    [targetLang, setTargetLang] = useState(note?.targetLang || ""),
    [keepOpen, setKeepOpen] = useState(!note),
    [mediaTarget, setMediaTarget] = useState<"front" | "back">("back"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const frontRef = useRef<HTMLTextAreaElement>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(
        {
          deckId,
          type,
          front: front.trim(),
          back: back.trim(),
          example: example.trim(),
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          sourceLang,
          targetLang,
        },
        keepOpen && !note,
      );
      if (keepOpen && !note) {
        setFront("");
        setBack("");
        setExample("");
        frontRef.current?.focus();
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(file?: File) {
    if (!file) return;
    try {
      setBusy(true);
      const f = new FormData();
      f.append("file", file);
      const media = await api<{ id: string; mime: string }>("/api/media", {
        method: "POST",
        body: f,
      });
      (mediaTarget === "front" ? setFront : setBack)(
        (prev) =>
          `${prev}${prev ? "\n" : ""}[[${media.mime.startsWith("audio/") ? "audio" : "image"}:${media.id}]]`,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={note ? "Edit card" : "Add a card"}
      subtitle={
        note
          ? "Changes keep this card’s learning progress."
          : "Choose a deck and enter the card’s content."
      }
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="form-stack">
        <div className="form-row">
          <label>
            Deck
            <select
              required
              value={deckId}
              onChange={(e) => setDeckId(e.target.value)}
            >
              <option value="" disabled>
                Select a deck
              </option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Card type
            <select
              value={type}
              onChange={(e) => setType(e.target.value as NoteType)}
            >
              <option value="vocabulary">Vocabulary</option>
              <option value="basic">Basic · front → back</option>
              <option value="reverse">Reverse · both directions</option>
              <option value="cloze">Cloze · fill in the blank</option>
            </select>
          </label>
        </div>
        {!decks.length && (
          <p className="form-error">
            Create a deck in your library before adding cards.
          </p>
        )}
        <label>
          {type === "vocabulary"
            ? "Word or expression"
            : type === "cloze"
              ? "Text with cloze deletions"
              : "Front"}
          <textarea
            ref={frontRef}
            autoFocus
            rows={3}
            required
            maxLength={50000}
            value={front}
            onChange={(e) => setFront(e.target.value)}
            placeholder={
              type === "vocabulary"
                ? "e.g. indimenticabile"
                : type === "cloze"
                  ? "The capital of {{c1::Italy}} is {{c2::Rome}}."
                  : "A question or something to remember"
            }
          />
          {type === "cloze" && (
            <small className="field-hint">
              Use {"{{c1::answer}}"} to hide a phrase. Different numbers create
              separate cards.
            </small>
          )}
        </label>
        <label>
          {type === "vocabulary"
            ? "Translation or meaning"
            : type === "cloze"
              ? "Extra answer information"
              : "Back"}
          {type === "cloze" && <span className="optional">optional</span>}
          <textarea
            rows={3}
            required={type !== "cloze"}
            maxLength={50000}
            value={back}
            onChange={(e) => setBack(e.target.value)}
            placeholder={
              type === "vocabulary"
                ? "e.g. unforgettable"
                : "The answer or explanation"
            }
          />
        </label>
        <div className="attachment-row">
          <select
            className="media-target"
            aria-label="Media destination"
            value={mediaTarget}
            onChange={(e) => setMediaTarget(e.target.value as "front" | "back")}
          >
            <option value="front">To front</option>
            <option value="back">To back</option>
          </select>
          <label className="attachment-button">
            <Icon name="upload" size={15} />
            Attach image or audio
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/ogg,audio/wav,audio/mp4"
              onChange={(e) => {
                upload(e.target.files?.[0]);
                e.target.value = "";
              }}
              disabled={busy}
            />
          </label>
          <span className="small-muted">Stored with your cards</span>
        </div>
        {type === "vocabulary" && (
          <>
            <label>
              Example sentence <span className="optional">optional</span>
              <textarea
                rows={2}
                maxLength={5000}
                value={example}
                onChange={(e) => setExample(e.target.value)}
                placeholder="An optional sentence using this word"
              />
            </label>
            <div className="form-row">
              <label>
                Word language
                <input
                  value={sourceLang}
                  onChange={(e) => setSourceLang(e.target.value)}
                  placeholder="e.g. it-IT"
                  maxLength={40}
                />
              </label>
              <label>
                Translation language
                <input
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  placeholder="e.g. en-US"
                  maxLength={40}
                />
              </label>
            </div>
          </>
        )}
        <label>
          Tags <span className="optional">comma separated</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="travel, everyday, chapter 1"
            maxLength={500}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <label className="checkbox-label">
            {!note && (
              <>
                <input
                  type="checkbox"
                  checked={keepOpen}
                  onChange={(e) => setKeepOpen(e.target.checked)}
                />
                Keep adding
              </>
            )}
          </label>
          <div className="inline-actions">
            <Button kind="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !deckId} icon="plus">
              {busy ? "Saving…" : note ? "Save changes" : "Add card"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function ImportDialog({
  decks,
  defaultDeckId,
  onClose,
  onSuccess,
}: {
  decks: Deck[];
  defaultDeckId: string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"file" | "paste">("file"),
    [text, setText] = useState(""),
    [file, setFile] = useState<File>(),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [deckId, setDeckId] = useState(defaultDeckId),
    [deckName, setDeckName] = useState(""),
    [mapping, setMapping] = useState<Record<string, number>>({
      front: 0,
      back: 1,
    }),
    [ack, setAck] = useState(false),
    [mappingDirty, setMappingDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      let result: ImportPreview;
      if (mode === "file") {
        if (!file) throw new Error("Choose a deck or spreadsheet first.");
        const form = new FormData();
        form.append("file", file);
        result = await api("/api/imports/preview", {
          method: "POST",
          body: form,
        });
      } else
        result = await api(
          "/api/imports/preview",
          json({ text, filename: "Pasted list.tsv" }),
        );
      setPreview(result);
      setMapping(
        (result as ImportPreview & { mapping?: Record<string, number> })
          .mapping || { front: 0, back: 1 },
      );
      setMappingDirty(false);
      setAck(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function remap() {
    setBusy(true);
    setError("");
    try {
      if (!preview) return;
      const p = await api<ImportPreview>(
        `/api/imports/${preview.id}/preview`,
        json({ columnMapping: mapping }),
      );
      setPreview(p);
      setMappingDirty(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/imports/${preview.id}/commit`,
        json({
          deckId: deckId || undefined,
          deckName: deckName.trim() || undefined,
          skipUnsupported: true,
        }),
      );
      await onSuccess();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={preview ? "Import preview" : "Import cards"}
      subtitle={
        preview
          ? "Review the cards and choose where they belong."
          : "Anki .apkg, CSV, TSV, or a lll portable backup."
      }
      onClose={onClose}
      wide
    >
      {!preview ? (
        <>
          <div className="segmented import-tabs">
            <button
              className={mode === "file" ? "selected" : ""}
              onClick={() => setMode("file")}
            >
              <Icon name="upload" size={16} />
              Upload a file
            </button>
            <button
              className={mode === "paste" ? "selected" : ""}
              onClick={() => setMode("paste")}
            >
              <Icon name="edit" size={16} />
              Paste a list
            </button>
          </div>
          {mode === "file" ? (
            <label className={`drop-zone ${file ? "has-file" : ""}`}>
              <strong>{file ? file.name : "Choose a deck to import"}</strong>
              <span>
                {file
                  ? `${(file.size / 1024 / 1024).toFixed(1)} MB · Click to change file`
                  : "Anki .apkg, CSV, TSV, or lll .zip backup"}
              </span>
              <input
                type="file"
                accept=".apkg,.csv,.tsv,.txt,.zip,.lll,.recall"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </label>
          ) : (
            <label className="paste-label">
              One card per line, with a tab or semicolon between front and back
              <textarea
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "ciao\thello\ngrazie\tthank you\narrivederci\tgoodbye"
                }
              />
            </label>
          )}
          <div className="import-info">
            <Icon name="help" size={17} />
            <p>
              Basic, reverse, vocabulary, and Cloze cards are supported. Imports
              start with fresh study progress. You’ll see unsupported content
              before anything is saved.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="import-summary">
            <div>
              <strong>{preview.notes.length}</strong>
              <span>notes found</span>
            </div>
            <div>
              <strong>{preview.mediaCount}</strong>
              <span>media files</span>
            </div>
            <div>
              <strong>{preview.duplicateCount}</strong>
              <span>duplicates</span>
            </div>
            <div>
              <strong>{preview.skipped}</strong>
              <span>unsupported</span>
            </div>
          </div>
          {preview.columns && (
            <div className="mapping-section">
              <div className="section-top">
                <h3>Match your columns</h3>
                <button className="text-button" onClick={remap} disabled={busy}>
                  Update preview
                </button>
              </div>
              <div className="form-row">
                {["front", "back", "example", "tags"].map((field) => (
                  <label key={field} className="capitalize">
                    {field}
                    <select
                      value={mapping[field] ?? -1}
                      onChange={(e) => {
                        const next = { ...mapping };
                        if (Number(e.target.value) < 0) delete next[field];
                        else next[field] = Number(e.target.value);
                        setMapping(next);
                        setMappingDirty(true);
                      }}
                    >
                      {field !== "front" && field !== "back" && (
                        <option value={-1}>Not included</option>
                      )}
                      {preview.columns!.map((c, i) => (
                        <option key={i} value={i}>
                          {c || `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="import-preview-table">
            <div className="import-preview-head">
              <span>FRONT</span>
              <span>BACK</span>
            </div>
            {preview.notes.slice(0, 5).map((n, i) => (
              <div key={i}>
                <span>{n.front.slice(0, 160)}</span>
                <span>{n.back.slice(0, 160) || "Cloze deletion"}</span>
              </div>
            ))}
            {preview.notes.length > 5 && (
              <p className="small-muted">
                And {preview.notes.length - 5} more notes
              </p>
            )}
          </div>
          <div className="form-stack">
            <label>
              Destination deck
              <select
                value={deckId}
                onChange={(e) => setDeckId(e.target.value)}
              >
                <option value="">
                  Keep source decks / create default deck
                </option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {!deckId && (
              <label>
                New deck name{" "}
                <span className="optional">
                  optional · blank preserves source hierarchy
                </span>
                <input
                  value={deckName}
                  onChange={(e) => setDeckName(e.target.value)}
                  maxLength={100}
                  placeholder="Use source deck names"
                />
              </label>
            )}
          </div>
          {preview.warnings.length > 0 && (
            <div className="import-warnings">
              <strong>Please review</strong>
              {preview.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
          {(preview.skipped > 0 || preview.warnings.length > 0) && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I’ve reviewed the warnings and accept skipped content.
            </label>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button
          kind="ghost"
          onClick={preview ? () => setPreview(null) : onClose}
        >
          {preview ? "Back" : "Cancel"}
        </Button>
        <Button
          icon={preview ? "check" : "arrow"}
          disabled={
            busy ||
            (!preview && (mode === "file" ? !file : !text.trim())) ||
            (!!preview &&
              (!preview.notes.length ||
                mappingDirty ||
                ((preview.skipped > 0 || preview.warnings.length > 0) && !ack)))
          }
          onClick={preview ? commit : inspect}
        >
          {busy
            ? "Working…"
            : preview
              ? mappingDirty
                ? "Update preview first"
                : "Import cards"
              : "Preview import"}
        </Button>
      </div>
    </Modal>
  );
}

function Review({
  library,
  user,
  deckId,
  answer,
  undo,
  pending,
  onClose,
}: {
  library: Library;
  user: User;
  deckId?: string;
  answer: (card: Card, rating: Rating, duration: number) => Promise<void>;
  undo: () => Promise<void>;
  pending: number;
  onClose: () => void;
}) {
  const queue = getQueue(library, user, deckId),
    card = queue[0],
    note = library.notes.find((n) => n.id === card?.noteId),
    deck = library.decks.find((d) => d.id === (deckId || card?.deckId));
  const [revealed, setRevealed] = useState(false),
    [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [completed, setCompleted] = useState(0),
    [ratings, setRatings] = useState<number[]>([]),
    [initialCount] = useState(queue.length),
    [durations, setDurations] = useState<number[]>([]);
  const timer = useRef({
      elapsed: 0,
      visibleSince:
        document.visibilityState === "visible"
          ? performance.now()
          : (null as number | null),
      paused: false,
    }),
    dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    const cancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.current?.addEventListener("cancel", cancel);
    return () => {
      dialog.current?.removeEventListener("cancel", cancel);
      dialog.current?.close();
      prev?.focus();
    };
  }, []);
  useEffect(() => {
    setRevealed(false);
    setTyped("");
    timer.current = {
      elapsed: 0,
      visibleSince:
        document.visibilityState === "visible" ? performance.now() : null,
      paused: false,
    };
    input.current?.focus();
  }, [card?.id]);
  useEffect(() => {
    if (
      !revealed &&
      note?.type === "vocabulary" &&
      user.preferences.typedAnswers
    )
      input.current?.focus();
  }, [card?.id, revealed, user.preferences.typedAnswers]);
  useEffect(() => {
    const visibility = () => {
      const current = timer.current;
      if (document.visibilityState === "hidden") {
        if (current.visibleSince !== null)
          current.elapsed += performance.now() - current.visibleSince;
        current.visibleSince = null;
      } else if (!current.paused) current.visibleSince = performance.now();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  function pauseTimer() {
    const current = timer.current;
    if (current.visibleSince !== null)
      current.elapsed += performance.now() - current.visibleSince;
    current.visibleSince = null;
    current.paused = true;
    return Math.min(60000, Math.max(0, Math.round(current.elapsed)));
  }
  function resumeTimer() {
    timer.current.paused = false;
    timer.current.visibleSince =
      document.visibilityState === "visible" ? performance.now() : null;
  }
  async function grade(rating: Rating) {
    if (!card || busy || !revealed) return;
    setBusy(true);
    setError("");
    const duration = pauseTimer();
    try {
      await answer(card, rating, duration);
      setCompleted((n) => n + 1);
      setRatings((r) => [...r, rating]);
      setDurations((d) => [...d, duration]);
      setRevealed(false);
      setTyped("");
    } catch (e) {
      setError(message(e));
      resumeTimer();
    } finally {
      setBusy(false);
    }
  }
  async function back() {
    if (busy || !completed) return;
    setBusy(true);
    pauseTimer();
    try {
      await undo();
      setCompleted((n) => Math.max(0, n - 1));
      setRatings((r) => r.slice(0, -1));
      setDurations((d) => d.slice(0, -1));
      setRevealed(false);
    } catch (e) {
      setError(message(e));
      resumeTimer();
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,textarea,select")) {
        if (e.code === "Enter" && !revealed) {
          e.preventDefault();
          setRevealed(true);
        }
        return;
      }
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        if (card && !revealed) setRevealed(true);
      }
      if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        grade(Number(e.key) as Rating);
      }
      if (
        e.key.toLowerCase() === "z" &&
        (e.metaKey || e.ctrlKey || !e.altKey)
      ) {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [revealed, card, busy, completed]);
  const presentation =
      note && card ? cardPresentation(note, card.variant) : null,
    now = Date.now();
  const correct = ratings.filter((r) => r > 1).length,
    sessionDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const progress = initialCount
    ? Math.min(100, (completed / initialCount) * 100)
    : 100;
  function pronounce() {
    if (!note || !window.speechSynthesis) return;
    const speech = new SpeechSynthesisUtterance(
      plainCardText(card?.variant === "reverse" ? note.back : note.front),
    );
    speech.lang =
      card?.variant === "reverse" ? note.targetLang : note.sourceLang;
    speech.rate = 0.85;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(speech);
  }
  return (
    <dialog ref={dialog} className="review-dialog" aria-label="Study session">
      <div className="review-shell">
        <header className="review-header">
          <Brand />
          <div className="review-deck-label">
            <Icon name="library" size={16} />
            {deck?.name || "All decks"}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="End study session"
          >
            <Icon name="close" size={23} />
          </button>
        </header>
        <div className="review-progress">
          <span style={{ width: `${progress}%` }} />
        </div>
        {card && note && presentation ? (
          <>
            <div className="review-meta">
              <span>
                {completed + 1}{" "}
                <span className="muted">
                  of {Math.max(initialCount, completed + queue.length)}
                </span>
              </span>
              <div>
                <span className="review-new-dot" />
                {!card.state.reps ? "New card" : "Review"}
                <span className="meta-divider">·</span>
                <span className="capitalize">{note.type}</span>
              </div>
              <button
                className="text-button"
                disabled={!completed || busy}
                onClick={back}
              >
                <Icon name="undo" size={16} />
                Undo <kbd>Z</kbd>
              </button>
            </div>
            <section className={`study-card ${revealed ? "is-revealed" : ""}`}>
              <div className="study-card-top">
                <span className="study-label">
                  {note.type === "vocabulary"
                    ? note.sourceLang || "Vocabulary"
                    : "Question"}
                </span>
                {note.type === "vocabulary" && "speechSynthesis" in window && (
                  <button
                    className="icon-button"
                    title="Pronounce with device voice"
                    aria-label="Pronounce word"
                    onClick={pronounce}
                  >
                    <Icon name="volume" size={20} />
                  </button>
                )}
              </div>
              <div className="study-question">
                <CardContent text={presentation.front} />
              </div>
              {note.type === "vocabulary" &&
                user.preferences.typedAnswers &&
                !revealed && (
                  <div className="typed-answer">
                    <input
                      ref={input}
                      aria-label="Type your answer"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder="Type what you remember…"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                    />
                    <small>
                      Your answer is a guide. You choose the rating.
                    </small>
                  </div>
                )}
              {revealed ? (
                <div className="study-answer">
                  <span className="answer-rule" />
                  <div className="study-label">Answer</div>
                  <div className="study-answer-text">
                    <CardContent text={presentation.back} />
                  </div>
                  {typed && (
                    <div
                      className={`typed-result ${plainCardText(typed).toLocaleLowerCase() === plainCardText(presentation.back).toLocaleLowerCase() ? "matched" : ""}`}
                    >
                      {plainCardText(typed).toLocaleLowerCase() ===
                      plainCardText(presentation.back).toLocaleLowerCase() ? (
                        <Icon name="check" size={16} />
                      ) : null}
                      <span>You typed: {typed}</span>
                    </div>
                  )}
                  {note.example && (
                    <p className="study-example">
                      <CardContent text={note.example} />
                    </p>
                  )}
                </div>
              ) : (
                <div className="study-prompt">
                  Think of the answer before revealing it.
                </div>
              )}
              {note.tags.length > 0 && (
                <div className="study-tags">
                  {note.tags.map((t) => (
                    <span key={t}>#{t}</span>
                  ))}
                </div>
              )}
            </section>
            <div className="review-controls">
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              {revealed ? (
                <>
                  <p className="review-hint">How well did you remember?</p>
                  <div className="grade-buttons">
                    {(
                      [
                        {
                          r: 1,
                          label: "Again",
                          hint: "Forgot it",
                          className: "again",
                        },
                        {
                          r: 2,
                          label: "Hard",
                          hint: "With effort",
                          className: "hard",
                        },
                        {
                          r: 3,
                          label: "Good",
                          hint: "Got it",
                          className: "good",
                        },
                        {
                          r: 4,
                          label: "Easy",
                          hint: "Knew it",
                          className: "easy",
                        },
                      ] as const
                    ).map((g) => {
                      let interval = "";
                      try {
                        interval = intervalLabel(
                          schedule(
                            card.state,
                            g.r,
                            now,
                            user.preferences.retention,
                          ).due,
                          now,
                        );
                      } catch {}
                      return (
                        <button
                          key={g.r}
                          disabled={busy}
                          onClick={() => grade(g.r)}
                          className={`grade-button ${g.className}`}
                        >
                          <span className="grade-interval">{interval}</span>
                          <strong>{g.label}</strong>
                          <span className="grade-description">{g.hint}</span>
                          <kbd>{g.r}</kbd>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <Button
                    onClick={() => setRevealed(true)}
                    className="reveal-button"
                  >
                    Show answer <kbd>space</kbd>
                  </Button>
                  <p className="keyboard-hint">Space to reveal · 1–4 to rate</p>
                </>
              )}
            </div>
          </>
        ) : (
          <section className="session-complete">
            <h1>{completed ? "Session complete" : "No cards due"}</h1>
            <p>
              {completed
                ? "Your answers have been saved."
                : "There are no cards ready for review right now."}
            </p>
            {completed > 0 && (
              <div className="session-stats">
                <div>
                  <strong>{completed}</strong>
                  <span>{completed === 1 ? "card" : "cards"} reviewed</span>
                </div>
                <div>
                  <strong>
                    {sessionDuration < 60000
                      ? "<1"
                      : Math.floor(sessionDuration / 60000)}
                    <small> min</small>
                  </strong>
                  <span>time spent</span>
                </div>
                <div>
                  <strong>
                    {Math.round((correct / completed) * 100)}
                    <small>%</small>
                  </strong>
                  <span>self-rated recall</span>
                </div>
              </div>
            )}
            <Button onClick={onClose} icon="arrow">
              Back to Study
            </Button>
            {completed > 0 && (
              <button
                className="text-button complete-undo"
                disabled={busy}
                onClick={back}
              >
                <Icon name="undo" size={16} />
                Undo last answer
              </button>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <span className="session-sync">
              <Icon name={pending ? "clock" : "check"} size={14} />
              {pending
                ? `${countLabel(pending, "review")} saved on this device, waiting to sync`
                : "Your progress is saved"}
            </span>
          </section>
        )}
        <footer className="review-footer">
          <span>
            Esc to finish <span>·</span> Space to reveal <span>·</span> 1–4 to
            rate
          </span>
        </footer>
      </div>
    </dialog>
  );
}

function Analytics({ library, user }: { library: Library; user: User }) {
  const [range, setRange] = useState("30"),
    [deckId, setDeckId] = useState("");
  const all = getStats(library, user),
    cutoff = Date.now() - Number(range) * 86400000;
  const cardIds = new Set(
      library.cards
        .filter((c) => !deckId || c.deckId === deckId)
        .map((c) => c.id),
    ),
    reviews = all.reviews.filter(
      (r) => r.reviewedAt >= cutoff && (!deckId || cardIds.has(r.cardId)),
    ),
    cards = library.cards.filter(
      (c) => !c.suspended && (!deckId || c.deckId === deckId),
    );
  const reviewDays = new Set(
      reviews.map((r) => studyDay(r.reviewedAt, r.timeZone)),
    ),
    retention = reviews.length
      ? Math.round(
          (reviews.filter((r) => r.rating > 1).length / reviews.length) * 100,
        )
      : 0,
    totalTime = Math.round(
      reviews.reduce((sum, r) => sum + r.durationMs, 0) / 60000,
    );
  const heatDays = Array.from({ length: 112 }, (_, i) =>
      dayOffset(all.today, i - 111),
    ),
    heatByDay: Record<string, number> = {};
  all.reviews
    .filter((r) => !deckId || cardIds.has(r.cardId))
    .forEach((r) => {
      const day = studyDay(r.reviewedAt, r.timeZone);
      heatByDay[day] = (heatByDay[day] || 0) + 1;
    });
  const maxHeat = Math.max(1, ...Object.values(heatByDay));
  const bars = Array.from({ length: Math.min(Number(range), 30) }, (_, i) =>
      dayOffset(all.today, i - Math.min(Number(range), 30) + 1),
    ),
    barValues = bars.map(
      (d) =>
        reviews.filter((r) => studyDay(r.reviewedAt, r.timeZone) === d).length,
    ),
    maxBar = Math.max(1, ...barValues);
  const mature = cards.filter(
      (c) => c.state.reps && c.state.scheduled_days >= 21,
    ).length,
    young = cards.filter(
      (c) => c.state.reps && c.state.scheduled_days < 21,
    ).length,
    newCards = cards.filter((c) => !c.state.reps).length;
  const upcoming = Array.from({ length: 7 }, (_, i) => ({
      day: dayOffset(all.today, i),
      count: cards.filter(
        (c) =>
          c.state.reps &&
          studyDay(c.state.due, user.preferences.timeZone) <=
            dayOffset(all.today, i) &&
          (i === 0 ||
            studyDay(c.state.due, user.preferences.timeZone) >
              dayOffset(all.today, i - 1)),
      ).length,
    })),
    maxDue = Math.max(1, ...upcoming.map((d) => d.count));
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Statistics</h1>
          <p>Review history, study time, and upcoming cards.</p>
        </div>
        <div className="inline-actions">
          <select
            aria-label="Statistics deck"
            value={deckId}
            onChange={(e) => setDeckId(e.target.value)}
          >
            <option value="">All decks</option>
            {library.decks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Statistics period"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
          </select>
        </div>
      </div>
      <div className="analytics-metrics">
        <StatCard
          label="Total reviews"
          value={shortNumber(reviews.length)}
          note={`${reviewDays.size} active ${reviewDays.size === 1 ? "day" : "days"}`}
        />
        <StatCard
          label="Self-rated recall"
          value={reviews.length ? `${retention}%` : "—"}
          note="Hard, Good, or Easy ratings"
        />
        <StatCard
          label="Study time"
          value={`${totalTime}`}
          suffix="min"
          note="Active time, excluding idle periods"
        />
        <StatCard
          label="Longest streak"
          value={String(all.longest)}
          suffix={all.longest === 1 ? "day" : "days"}
          note={`${all.streak} day current streak · all decks`}
        />
      </div>
      <section className="panel activity-panel">
        <div className="section-top">
          <div>
            <h3>Review activity</h3>
            <p className="small-muted">Reviews over the last 16 weeks</p>
          </div>
          <span className="activity-count">
            <strong>
              {Object.values(heatByDay)
                .reduce((a, b) => a + b, 0)
                .toLocaleString()}
            </strong>{" "}
            {Object.values(heatByDay).reduce((a, b) => a + b, 0) === 1
              ? "review"
              : "reviews"}{" "}
            across {deckId ? "this deck" : "all decks"}
          </span>
        </div>
        <div className="heatmap-wrap">
          <div className="heatmap-days">
            <span>Mon</span>
            <span>Wed</span>
            <span>Fri</span>
          </div>
          <div
            className="heatmap"
            role="img"
            aria-label="Review activity heatmap for the last 16 weeks"
          >
            {heatDays.map((d) => {
              const n = heatByDay[d] || 0,
                level = n ? Math.max(1, Math.ceil((n / maxHeat) * 4)) : 0;
              return (
                <div
                  tabIndex={0}
                  key={d}
                  className={`heat-cell heat-${level}`}
                  title={`${d}: ${countLabel(n, "review")}`}
                  aria-label={`${d}: ${n} reviews`}
                />
              );
            })}
          </div>
        </div>
        <div className="heatmap-footer">
          <span>
            {dateLabel(new Date(`${heatDays[0]}T12:00:00`).getTime())} –{" "}
            {dateLabel(Date.now())}
          </span>
          <div>
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((n) => (
              <i key={n} className={`heat-cell heat-${n}`} />
            ))}
            <span>More</span>
          </div>
        </div>
      </section>
      <div className="analytics-grid">
        <section className="panel review-chart-panel">
          <div className="section-top">
            <div>
              <h3>Daily reviews</h3>
              <p className="small-muted">
                Cards reviewed per day
                {Number(range) > 30 ? " · most recent 30 days" : ""}
              </p>
            </div>
            <span className="chart-legend">
              <i />
              Reviews
            </span>
          </div>
          <div className="review-chart">
            <div className="chart-axis">
              <span>{maxBar}</span>
              <span>{Math.floor(maxBar / 2)}</span>
              <span>0</span>
            </div>
            <div className="review-chart-bars">
              {bars.map((d, i) => (
                <div
                  key={d}
                  className="review-chart-col"
                  title={`${d}: ${countLabel(barValues[i] || 0, "review")}`}
                >
                  <span
                    style={{ height: `${(barValues[i]! / maxBar) * 100}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="chart-date-labels">
            <span>{dateLabel(new Date(`${bars[0]}T12:00:00`).getTime())}</span>
            <span>Today</span>
          </div>
          {!reviews.length && (
            <p className="chart-empty-note">No reviews in this period.</p>
          )}
        </section>
        <section className="panel maturity-panel">
          <div className="section-top">
            <div>
              <h3>Card states</h3>
              <p className="small-muted">
                {countLabel(cards.length, "active card")}
              </p>
            </div>
          </div>
          <div className="maturity-total">
            <strong>{cards.length.toLocaleString()}</strong>
            <span>
              {cards.length === 1 ? "active flashcard" : "active flashcards"}
            </span>
          </div>
          <div className="maturity-bar">
            {[
              { n: newCards, color: "var(--chart-new)" },
              { n: young, color: "var(--chart-learning)" },
              { n: mature, color: "var(--chart-mature)" },
            ].map((s, i) => (
              <span
                key={i}
                style={{
                  width: `${cards.length ? (s.n / cards.length) * 100 : 0}%`,
                  background: s.color,
                }}
              />
            ))}
          </div>
          <div className="maturity-legend">
            <div>
              <i style={{ background: "var(--chart-new)" }} />
              <span>New</span>
              <strong>{newCards}</strong>
            </div>
            <div>
              <i style={{ background: "var(--chart-learning)" }} />
              <span>Learning</span>
              <strong>{young}</strong>
            </div>
            <div>
              <i style={{ background: "var(--chart-mature)" }} />
              <span>
                Mature <small>21+ day interval</small>
              </span>
              <strong>{mature}</strong>
            </div>
          </div>
        </section>
      </div>
      <section className="panel forecast-panel">
        <div className="section-top">
          <div>
            <h3>Upcoming reviews</h3>
            <p className="small-muted">
              Scheduled reviews for the next 7 days · estimates change as you
              study
            </p>
          </div>
          <span className="small-muted">
            {countLabel(
              upcoming.reduce((s, d) => s + d.count, 0),
              "scheduled card",
            )}
          </span>
        </div>
        <div className="forecast-list">
          {upcoming.map((d, i) => (
            <div key={d.day} className="forecast-item">
              <span>
                {i === 0
                  ? "Today"
                  : new Date(`${d.day}T12:00:00`).toLocaleDateString("en-US", {
                      weekday: "short",
                    })}
              </span>
              <div>
                <i style={{ width: `${(d.count / maxDue) * 100}%` }} />
              </div>
              <strong>{d.count}</strong>
            </div>
          ))}
        </div>
      </section>
      <p className="analytics-note">
        <Icon name="help" size={15} />
        Self-rated recall is based on your own ratings, not a test of long-term
        knowledge. New cards and suspended cards are excluded from the forecast.
      </p>
    </>
  );
}
function StatCard({
  label,
  value,
  suffix,
  note,
}: {
  label: string;
  value: string;
  suffix?: string;
  note: string;
}) {
  return (
    <div className="stat-card">
      <div>
        <span>{label}</span>
      </div>
      <strong>
        {value}
        <small>{suffix}</small>
      </strong>
      <p>{note}</p>
    </div>
  );
}

function Settings({
  user,
  online,
  pending,
  lastSync,
  syncing,
  downloaded,
  onSave,
  onLogout,
  sync,
  notify,
}: {
  user: User;
  online: boolean;
  pending: number;
  lastSync: number | null;
  syncing: boolean;
  downloaded: number;
  onSave: (p: Partial<Preferences>) => Promise<void>;
  onLogout: () => Promise<void>;
  sync: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [prefs, setPrefs] = useState(user.preferences),
    [saving, setSaving] = useState(false),
    [invite, setInvite] = useState(""),
    [invites, setInvites] = useState<
      { id: string; createdAt: number; expiresAt: number; usedAt?: number }[]
    >([]),
    [resetName, setResetName] = useState(""),
    [resetPass, setResetPass] = useState(""),
    [adminBusy, setAdminBusy] = useState(false),
    [error, setError] = useState(""),
    [installEvent, setInstallEvent] = useState<any>(null);
  useEffect(() => {
    const f = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e);
    };
    window.addEventListener("beforeinstallprompt", f);
    return () => window.removeEventListener("beforeinstallprompt", f);
  }, []);
  useEffect(() => {
    setPrefs(user.preferences);
  }, [user.preferences]);
  async function refreshInvites() {
    if (user.admin && online)
      try {
        const data = await api<{ invites: typeof invites }>(
          "/api/admin/invites",
        );
        setInvites(data.invites);
      } catch (e) {
        setError(message(e));
      }
  }
  useEffect(() => {
    refreshInvites();
  }, [user.admin, online]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(prefs);
    } finally {
      setSaving(false);
    }
  }
  async function createInvite() {
    setAdminBusy(true);
    setError("");
    try {
      const data = await api<{ invite: { token: string } }>(
        "/api/admin/invites",
        json({}),
      );
      setInvite(
        `${location.origin}${location.pathname}#invite=${encodeURIComponent(data.invite.token)}`,
      );
      await refreshInvites();
    } catch (e) {
      setError(message(e));
    } finally {
      setAdminBusy(false);
    }
  }
  async function reset(e: FormEvent) {
    e.preventDefault();
    setAdminBusy(true);
    setError("");
    try {
      await api(
        "/api/admin/reset-password",
        json({ username: resetName, password: resetPass }),
      );
      setResetPass("");
      notify(
        "Password reset. The account’s existing sessions have been revoked.",
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setAdminBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Manage your account and study preferences.</p>
        </div>
      </div>
      <div className="settings-layout">
        <form onSubmit={save} className="settings-main">
          <section className="panel settings-section">
            <div className="settings-section-title">
              <div>
                <h3>Study</h3>
                <p>Set your daily limits and scheduling preferences.</p>
              </div>
            </div>
            <div className="form-row">
              <label>
                New cards per day
                <input
                  type="number"
                  min={0}
                  max={1000}
                  required
                  value={prefs.newCardsPerDay}
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      newCardsPerDay: Number(e.target.value),
                    })
                  }
                />
                <small className="field-hint">
                  Across all your decks. Due reviews come first.
                </small>
              </label>
              <label>
                Daily review goal
                <input
                  type="number"
                  min={1}
                  max={10000}
                  required
                  value={prefs.dailyGoal}
                  onChange={(e) =>
                    setPrefs({ ...prefs, dailyGoal: Number(e.target.value) })
                  }
                />
                <small className="field-hint">
                  A target for the number of cards reviewed each day.
                </small>
              </label>
            </div>
            <div className="form-row">
              <label>
                Desired retention
                <select
                  value={prefs.retention}
                  onChange={(e) =>
                    setPrefs({ ...prefs, retention: Number(e.target.value) })
                  }
                >
                  {[0.8, 0.85, 0.9, 0.95, 0.97].map((r) => (
                    <option key={r} value={r}>
                      {Math.round(r * 100)}%{r === 0.9 ? " · Recommended" : ""}
                    </option>
                  ))}
                </select>
                <small className="field-hint">
                  Higher retention means more frequent reviews.
                </small>
              </label>
              <label>
                Study timezone
                <input
                  required
                  list="timezones"
                  value={prefs.timeZone}
                  onChange={(e) =>
                    setPrefs({ ...prefs, timeZone: e.target.value })
                  }
                />
                <datalist id="timezones">
                  {[
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                    "UTC",
                    "Europe/London",
                    "Europe/Moscow",
                    "America/New_York",
                    "America/Los_Angeles",
                    "Asia/Tokyo",
                    "Asia/Singapore",
                    "Australia/Sydney",
                  ]
                    .filter((s, i, a) => a.indexOf(s) === i)
                    .map((t) => (
                      <option key={t} value={t} />
                    ))}
                </datalist>
                <small className="field-hint">
                  Your study day starts at midnight.
                </small>
              </label>
            </div>
            <div className="switch-row">
              <div>
                <strong>Type vocabulary answers</strong>
                <p>Write what you remember before revealing the answer.</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="Type vocabulary answers"
                  checked={prefs.typedAnswers}
                  onChange={(e) =>
                    setPrefs({ ...prefs, typedAnswers: e.target.checked })
                  }
                />
                <span />
              </label>
            </div>
          </section>
          <section className="panel settings-section">
            <div className="settings-section-title">
              <div>
                <h3>Appearance</h3>
                <p>Choose your display theme.</p>
              </div>
            </div>
            <label>
              Theme
              <select
                value={prefs.theme}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    theme: e.target.value as Preferences["theme"],
                  })
                }
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </label>
          </section>
          <div className="settings-save">
            <span className="small-muted">
              Changes apply to this account on every device.
            </span>
            <Button type="submit" disabled={saving || !online} icon="check">
              {saving ? "Saving…" : "Save preferences"}
            </Button>
          </div>
        </form>
        <aside className="settings-aside">
          <section className="panel settings-section account-panel">
            <h3>{user.username}</h3>
            <p>{user.admin ? "Administrator" : "Account"}</p>
            <Button
              kind="secondary"
              icon="logout"
              onClick={() => onLogout().catch((e) => notify(message(e)))}
            >
              Sign out
            </Button>
          </section>
          <section className="panel settings-section">
            <div className="section-top">
              <h3>Offline study</h3>
              <Icon name="wifi" size={18} />
            </div>
            <p className="settings-copy">
              Download a deck from your library to study without a connection.
            </p>
            <div className="sync-details">
              <span>
                Connection<strong>{online ? "Online" : "Offline"}</strong>
              </span>
              <span>
                Offline decks<strong>{downloaded}</strong>
              </span>
              <span>
                Pending reviews<strong>{pending}</strong>
              </span>
              <span>
                Last synced
                <strong>
                  {lastSync
                    ? new Date(lastSync).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "Not yet"}
                </strong>
              </span>
            </div>
            <Button
              kind="secondary"
              icon="undo"
              disabled={!online || syncing}
              onClick={sync}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          </section>
          <section className="install-tip">
            <h3>Install lll</h3>
            <p>Install on your home screen for a dedicated app window.</p>
            {installEvent ? (
              <Button
                kind="secondary"
                onClick={async () => {
                  await installEvent.prompt();
                  setInstallEvent(null);
                }}
              >
                Install lll
              </Button>
            ) : (
              <p className="small-muted">
                Use your browser’s Install app or Add to Home Screen option. On
                iPhone, open Share in Safari.
              </p>
            )}
          </section>
        </aside>
      </div>
      {user.admin && (
        <section className="panel admin-panel">
          <div className="settings-section-title">
            <div>
              <h3>Instance administration</h3>
              <p>Create invitations and manage account access.</p>
            </div>
          </div>
          <div className="admin-grid">
            <div>
              <div className="section-top">
                <h3>Invitations</h3>
                <Button
                  kind="secondary"
                  icon="plus"
                  onClick={createInvite}
                  disabled={adminBusy || !online}
                >
                  Create invite
                </Button>
              </div>
              {invite && (
                <div className="invite-link">
                  <p>
                    Copy this invitation now. Its secret link is shown only
                    once.
                  </p>
                  <input
                    readOnly
                    value={invite}
                    onFocus={(e) => e.target.select()}
                    aria-label="New invitation link"
                  />
                  <button
                    className="text-button"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(invite)
                        .then(() => notify("Invitation link copied"))
                        .catch(() =>
                          notify("Select the link and copy it manually"),
                        )
                    }
                  >
                    <Icon name="copy" size={15} />
                    Copy link
                  </button>
                </div>
              )}
              <div className="invite-list">
                {invites.slice(0, 5).map((i) => (
                  <div key={i.id}>
                    <span>Created {dateLabel(i.createdAt)}</span>
                    <span className={i.usedAt ? "muted" : "success-text"}>
                      {i.usedAt
                        ? "Used"
                        : i.expiresAt < Date.now()
                          ? "Expired"
                          : `Expires ${dateLabel(i.expiresAt)}`}
                    </span>
                  </div>
                ))}
                {!invites.length && (
                  <p className="small-muted">No invitations created yet.</p>
                )}
              </div>
            </div>
            <form onSubmit={reset} className="form-stack">
              <h3>Reset an account password</h3>
              <label>
                Username
                <input
                  value={resetName}
                  onChange={(e) => setResetName(e.target.value)}
                  required
                  autoComplete="off"
                />
              </label>
              <label>
                New password
                <input
                  type="password"
                  minLength={12}
                  maxLength={256}
                  value={resetPass}
                  onChange={(e) => setResetPass(e.target.value)}
                  placeholder="At least 12 characters"
                  required
                  autoComplete="new-password"
                />
              </label>
              <Button
                kind="secondary"
                type="submit"
                disabled={adminBusy || !online}
              >
                Reset password
              </Button>
            </form>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </>
  );
}
export default App;
