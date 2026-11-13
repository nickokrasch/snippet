// ---------- Einstellungen ----------
const CLIENT_ID = window.SPOTIFY_CLIENT_ID;
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-top-read",
  "user-read-recently-played",
  "user-library-read",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

const STAGES = [0.1, 0.5, 1, 2, 4, 8, 16];            // Sekunden pro Versuch
const POINTS = [150, 100, 80, 60, 40, 20, 10];       // Punkte je nach Versuch
const SONGS_PER_GAME = 10;
const MIN_SONGS = 5;
const VOLUME = 0.8;

const SOURCES = [
  { key: "all", label: "Alles" },
  { key: "top_short", label: "Top 4 Wochen" },
  { key: "top_medium", label: "Top 6 Monate" },
  { key: "top_long", label: "Top Allzeit" },
  { key: "recent", label: "Zuletzt gehört" },
  { key: "saved", label: "Lieblingssongs" },
];

// Grobe Genre-Gruppen; Spotify-Genres werden per Stichwort zugeordnet
const GENRES = [
  { key: "pop", label: "Pop", match: ["pop"] },
  { key: "hiphop", label: "Hip-Hop", match: ["hip hop", "rap", "trap", "drill", "grime"] },
  { key: "rock", label: "Rock", match: ["rock", "punk", "grunge"] },
  { key: "metal", label: "Metal", match: ["metal", "core"] },
  { key: "electronic", label: "Electronic", match: ["edm", "house", "techno", "electro", "dance", "trance", "dubstep", "drum and bass"] },
  { key: "rnb", label: "R&B / Soul", match: ["r&b", "soul", "funk", "motown"] },
  { key: "indie", label: "Indie", match: ["indie", "alternative"] },
  { key: "latin", label: "Latin", match: ["latin", "reggaeton", "urbano", "salsa", "bachata"] },
  { key: "country", label: "Country / Folk", match: ["country", "folk", "americana"] },
  { key: "deutsch", label: "Deutsch", match: ["german", "deutsch", "schlager"] },
];

const DECADES = [
  { key: "60", label: "60er & älter", from: 0, to: 1969 },
  { key: "70", label: "70er", from: 1970, to: 1979 },
  { key: "80", label: "80er", from: 1980, to: 1989 },
  { key: "90", label: "90er", from: 1990, to: 1999 },
  { key: "00", label: "2000er", from: 2000, to: 2009 },
  { key: "10", label: "2010er", from: 2010, to: 2019 },
  { key: "20", label: "2020er", from: 2020, to: 9999 },
];

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Auth (PKCE, kein Server nötig) ----------
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function sha256base64url(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function login() {
  const verifier = randomString(64);
  localStorage.setItem("pkce_verifier", verifier);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: await sha256base64url(verifier),
  });
  window.location.href = "https://accounts.spotify.com/authorize?" + params;
}

function saveToken(data) {
  localStorage.setItem("access_token", data.access_token);
  if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
  localStorage.setItem("expires_at", String(Date.now() + data.expires_in * 1000 - 60_000));
}

async function tokenRequest(body) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) throw new Error("Token-Anfrage fehlgeschlagen: " + (await res.text()));
  saveToken(await res.json());
}

async function handleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (params.get("error")) alert("Spotify-Login abgebrochen: " + params.get("error"));
  if (!code) return;
  await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: localStorage.getItem("pkce_verifier"),
  });
  localStorage.removeItem("pkce_verifier");
  window.history.replaceState({}, "", REDIRECT_URI);
}

async function getToken() {
  if (Date.now() > Number(localStorage.getItem("expires_at") || 0)) {
    const refresh = localStorage.getItem("refresh_token");
    if (!refresh) return null;
    try {
      await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
    } catch {
      logout();
      return null;
    }
  }
  return localStorage.getItem("access_token");
}

function logout() {
  ["access_token", "refresh_token", "expires_at"].forEach((k) => localStorage.removeItem(k));
  window.location.href = REDIRECT_URI;
}

async function api(path, method = "GET", body) {
  const token = await getToken();
  const res = await fetch("https://api.spotify.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Spotify antwortet bei manchen Fehlern mit reinem Text */ }
  if (!res.ok) {
    const err = new Error(data?.error?.message || text || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Songs laden ----------
function yearOf(track) {
  return Number((track.album?.release_date || "").slice(0, 4)) || null;
}

function genreKeys(spotifyGenres) {
  const keys = new Set();
  for (const g of spotifyGenres) {
    for (const def of GENRES) {
      if (def.match.some((m) => g.includes(m))) keys.add(def.key);
    }
  }
  return keys;
}

function toTrack(t) {
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => ({ id: a.id, name: a.name })),
    year: yearOf(t),
    duration_ms: t.duration_ms,
    cover: t.album?.images?.[0]?.url || "",
    genres: new Set(),
    sources: new Set(),
  };
}

// Lädt alle Quellen auf einmal und merkt sich, aus welcher Quelle ein Song stammt
async function loadMyTracks() {
  const fetchers = {
    top_short: () => api("/me/top/tracks?limit=50&time_range=short_term").then((d) => d.items),
    top_medium: () => api("/me/top/tracks?limit=50&time_range=medium_term").then((d) => d.items),
    top_long: () => api("/me/top/tracks?limit=50&time_range=long_term").then((d) => d.items),
    recent: () => api("/me/player/recently-played?limit=50").then((d) => d.items.map((i) => i.track)),
    saved: async () => {
      const out = [];
      for (let offset = 0; offset < 200; offset += 50) {
        const page = await api(`/me/tracks?limit=50&offset=${offset}`);
        out.push(...page.items.map((i) => i.track));
        if (!page.next) break;
      }
      return out;
    },
  };
  const keys = Object.keys(fetchers);
  const results = await Promise.allSettled(keys.map((k) => fetchers[k]()));

  // Alle Anfragen fehlgeschlagen → echten Grund anzeigen statt "zu wenige Songs"
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length === results.length) {
    const err = failed[0].reason;
    if (err.status === 403) {
      throw new Error("Spotify verweigert den Zugriff auf deine Songs. Dein Spotify-Konto muss vom Ersteller des Spiels " +
        "im Spotify-Dashboard unter „User Management“ eingetragen werden (mit der E-Mail-Adresse deines Spotify-Kontos).");
    }
    throw new Error("Songs konnten nicht geladen werden: " + err.message);
  }

  const byId = new Map();
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    for (const t of r.value) {
      if (!t || !t.id || t.type !== "track" || t.is_local) continue;
      if (!byId.has(t.id)) byId.set(t.id, toTrack(t));
      byId.get(t.id).sources.add(keys[i]);
    }
  });
  const tracks = [...byId.values()];
  await addGenres(tracks);
  return tracks;
}

// Genres hängen bei Spotify an den Interpreten, nicht am Song
async function addGenres(tracks) {
  const ids = [...new Set(tracks.flatMap((t) => t.artists.map((a) => a.id)).filter(Boolean))];
  const genresById = new Map();
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const d = await api("/artists?ids=" + ids.slice(i, i + 50).join(","));
      for (const a of d.artists) if (a) genresById.set(a.id, a.genres || []);
    }
  } catch {
    // Sammelabfrage nicht erlaubt → einzeln (begrenzt) nachladen
    const some = ids.filter((id) => !genresById.has(id)).slice(0, 80);
    for (let i = 0; i < some.length; i += 10) {
      const res = await Promise.allSettled(some.slice(i, i + 10).map((id) => api("/artists/" + id)));
      for (const r of res) if (r.status === "fulfilled") genresById.set(r.value.id, r.value.genres || []);
    }
  }
  for (const t of tracks) {
    t.genres = genreKeys(t.artists.flatMap((a) => genresById.get(a.id) || []));
  }
}

// All-Time-Hit bei Spotify suchen
async function resolveHit(hit) {
  const q = `track:"${hit.name.replace(/"/g, "")}" artist:"${hit.artists[0].name}"`;
  const d = await api(`/search?type=track&limit=5&q=${encodeURIComponent(q)}`);
  const items = d.tracks?.items || [];
  const best = items.find((t) => norm(t.name) === norm(hit.name)) || items[0];
  if (!best) return null;
  const t = toTrack(best);
  t.key = hit.id;      // Bezug zur Liste, damit die Auswahl aus den Vorschlägen zählt
  t.year = hit.year;
  t.genres = hit.genres;
  return t;
}

// ---------- Player (Web Playback SDK) ----------
let player = null;
let deviceId = null;
let playerReady = null;

async function hasWidevine() {
  try {
    await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [
      { audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] },
    ]);
    return true;
  } catch {
    return false;
  }
}

window.onSpotifyWebPlaybackSDKReady = () => {
  playerReady = new Promise((resolve, reject) => {
    player = new Spotify.Player({
      name: "Snippet Ratespiel",
      getOAuthToken: async (cb) => cb(await getToken()),
      volume: VOLUME,
    });
    player.addListener("ready", ({ device_id }) => { deviceId = device_id; resolve(); });
    player.addListener("initialization_error", async ({ message }) => {
      const drm = await hasWidevine();
      reject(new Error(drm ? "Player-Fehler: " + message
        : "Dieser Browser kann keine Spotify-Musik abspielen (Widevine/DRM fehlt). " +
          "Öffne das Spiel in Chrome oder Edge – in Firefox unter Einstellungen „DRM-kontrollierte Inhalte wiedergeben“ aktivieren."));
    });
    player.addListener("authentication_error", ({ message }) => reject(new Error(message)));
    player.addListener("account_error", () =>
      reject(new Error("Für die Wiedergabe im Browser brauchst du Spotify Premium.")));
    player.addListener("playback_error", ({ message }) => setStatus("Wiedergabefehler: " + message));
    player.addListener("player_state_changed", onPlayerState);
  });
  playerReady.catch(() => {});
  connectPlayer();
};

let connectStarted = false;
function connectPlayer() {
  if (player && !connectStarted && localStorage.getItem("access_token")) {
    connectStarted = true;
    player.connect();
  }
}

const isCurrent = (s, track) => {
  const cur = s.track_window.current_track;
  return cur && (cur.id === track.id || cur.linked_from?.id === track.id || cur.uri === track.uri);
};

async function waitForState(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await player.getCurrentState();
    if (s && check(s)) return s;
    await sleep(30);
  }
  throw new Error("Song konnte nicht gestartet werden.");
}

let stopTimer = null;
let rafId = null;
let playToken = 0;
let busy = false;          // während wir selbst pausieren/springen
let playing = null;        // null | "snippet" | "full"

// Lädt den Song stumm in den Player, damit der erste Klick sofort spielt
async function preloadTrack(track, startMs) {
  const myToken = ++playToken;
  busy = true;
  try {
    await player.setVolume(0);
    await api(`/me/player/play?device_id=${deviceId}`, "PUT", { uris: [track.uri], position_ms: startMs });
    await waitForState((s) => !s.paused && isCurrent(s, track));
    await player.pause();
    if (myToken !== playToken) return;
    await player.seek(startMs);
  } finally {
    await player.setVolume(VOLUME);
    busy = false;
  }
}

async function playSegment(track, startMs, seconds, onProgress) {
  const myToken = ++playToken;
  clearTimeout(stopTimer);
  cancelAnimationFrame(rafId);
  busy = true;
  try {
    const state = await player.getCurrentState();
    if (state && isCurrent(state, track)) {
      await player.pause();
      await player.seek(startMs);
      await waitForState((s) => Math.abs(s.position - startMs) < 250, 3000);
      await player.resume();
    } else {
      await api(`/me/player/play?device_id=${deviceId}`, "PUT", { uris: [track.uri], position_ms: startMs });
    }
    const s = await waitForState((s) => !s.paused && isCurrent(s, track));
    if (myToken !== playToken) return false;

    const t0 = performance.now() - Math.min(Math.max(0, s.position - startMs), 300);
    const tick = () => {
      if (myToken !== playToken) return;
      const elapsed = (performance.now() - t0) / 1000;
      onProgress?.(elapsed);
      if (elapsed < seconds) rafId = requestAnimationFrame(tick);
    };
    tick();

    if (seconds !== Infinity) {
      const remaining = seconds * 1000 - (performance.now() - t0);
      stopTimer = setTimeout(() => { if (myToken === playToken) stopPlayback(); }, Math.max(0, remaining));
    }
    return true;
  } catch (e) {
    if (myToken === playToken) player.pause();
    throw e;
  } finally {
    setTimeout(() => { busy = false; }, 300);
  }
}

function stopPlayback() {
  playToken++;
  clearTimeout(stopTimer);
  cancelAnimationFrame(rafId);
  player?.pause();
  playing = null;
  setPlayButton("idle");
  setRing(0);
}

// Song ist von selbst zu Ende gelaufen
function onPlayerState(s) {
  if (!s || busy || playing !== "full") return;
  if (s.paused) { playing = null; setPlayButton("idle"); setRing(0); }
}

// ---------- Spielzustand ----------
const state = {
  mode: "mine",
  source: "all",
  genres: new Set(),
  decades: new Set(),
  myTracks: null,         // alle eigenen Songs (einmal geladen)
  myTracksPromise: null,
  me: null,
};

const game = {
  mode: "mine",
  rounds: [],
  index: 0,
  current: null,
  startMs: 0,
  stage: 0,
  history: [],
  finished: false,
  score: 0,
  suggestPool: [],
  preload: null,
  filterLabel: "",
};

const norm = (s) => s.toLowerCase()
  .replace(/\s*[\(\[].*?[\)\]]/g, "")
  .replace(/\s+-\s+.*$/, "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]/g, "");

const label = (t) => `${t.name} – ${t.artists.map((a) => a.name).join(", ")}`;
const fmtSec = (s) => String(s).replace(".", ",");

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function setStatus(text) { $("gameStatus").textContent = text || ""; }

function show(view) {
  for (const v of ["loginView", "hudView", "gameView", "endView", "boardView"]) {
    $(v).classList.toggle("hidden", v !== view);
  }
  window.scrollTo(0, 0);
}

// ---------- HUD ----------
function filterTracks(list) {
  return list.filter((t) => {
    if (state.mode === "mine" && state.source !== "all" && !t.sources.has(state.source)) return false;
    if (state.genres.size && ![...state.genres].some((g) => t.genres.has(g))) return false;
    if (state.decades.size) {
      const d = DECADES.find((d) => t.year >= d.from && t.year <= d.to);
      if (!d || !state.decades.has(d.key)) return false;
    }
    return true;
  });
}

function baseList() {
  return state.mode === "mine" ? (state.myTracks || []) : window.ALL_TIME_SONGS;
}

function chip(text, on, onClick, count) {
  const b = document.createElement("button");
  b.className = "chip" + (on ? " on" : "");
  b.textContent = text;
  if (count !== undefined) {
    const s = document.createElement("small");
    s.textContent = count;
    b.appendChild(s);
    if (count === 0 && !on) b.disabled = true;
  }
  b.addEventListener("click", onClick);
  return b;
}

function toggleIn(set, key) { set.has(key) ? set.delete(key) : set.add(key); renderHud(); }

function renderHud() {
  document.querySelectorAll(".mode").forEach((m) => m.classList.toggle("active", m.dataset.mode === state.mode));
  $("sourceGroup").classList.toggle("hidden", state.mode !== "mine");

  const loading = state.mode === "mine" && !state.myTracks;
  const base = baseList();
  // Zähler: wie viele Songs blieben übrig, wenn man diesen Chip zusätzlich wählt
  const countWith = (patch) => {
    const saved = { source: state.source, genres: state.genres, decades: state.decades };
    Object.assign(state, patch);
    const n = filterTracks(base).length;
    Object.assign(state, saved);
    return n;
  };

  const src = $("sourceChips");
  src.innerHTML = "";
  for (const s of SOURCES) {
    const n = loading ? undefined : countWith({ source: s.key });
    src.appendChild(chip(s.label, state.source === s.key, () => { state.source = s.key; renderHud(); }, n));
  }

  const hasGenres = base.some((t) => t.genres.size);
  $("genreNote").textContent = !loading && !hasGenres ? "– Spotify liefert für deine Songs keine Genres" : "";
  const gc = $("genreChips");
  gc.innerHTML = "";
  gc.appendChild(chip("Alle", state.genres.size === 0, () => { state.genres.clear(); renderHud(); }));
  for (const g of GENRES) {
    const n = loading ? undefined : countWith({ genres: new Set([g.key]) });
    gc.appendChild(chip(g.label, state.genres.has(g.key), () => toggleIn(state.genres, g.key), n));
  }

  const dc = $("decadeChips");
  dc.innerHTML = "";
  dc.appendChild(chip("Alle", state.decades.size === 0, () => { state.decades.clear(); renderHud(); }));
  for (const d of DECADES) {
    const n = loading ? undefined : countWith({ decades: new Set([d.key]) });
    dc.appendChild(chip(d.label, state.decades.has(d.key), () => toggleIn(state.decades, d.key), n));
  }

  if (loading) {
    $("poolInfo").textContent = "Lade deine Songs…";
    $("startBtn").disabled = true;
    return;
  }
  const n = filterTracks(base).length;
  $("poolInfo").textContent = `${n} Songs passen`;
  $("startBtn").disabled = n < MIN_SONGS;
  if (n < MIN_SONGS) $("poolInfo").textContent += ` – mind. ${MIN_SONGS} nötig`;
}

function ensureMyTracks() {
  if (state.myTracksPromise) return state.myTracksPromise;
  state.myTracksPromise = loadMyTracks()
    .then((tracks) => { state.myTracks = tracks; renderHud(); })
    .catch((e) => {
      state.myTracks = [];
      $("hudStatus").textContent = e.message;
      renderHud();
    });
  return state.myTracksPromise;
}

function filterLabel() {
  const parts = [];
  if (state.mode === "mine" && state.source !== "all") parts.push(SOURCES.find((s) => s.key === state.source).label);
  for (const g of GENRES) if (state.genres.has(g.key)) parts.push(g.label);
  for (const d of DECADES) if (state.decades.has(d.key)) parts.push(d.label);
  return parts.join(" · ") || "Alle Songs";
}

// ---------- Spielablauf ----------
async function startGame() {
  const btn = $("startBtn");
  btn.disabled = true;
  $("hudStatus").textContent = "";
  try {
    player?.activateElement?.(); // Autoplay freischalten (muss im Klick passieren)
    if (!playerReady) throw new Error("Spotify-Player lädt noch – bitte gleich nochmal versuchen.");
    await playerReady;

    const candidates = shuffle(filterTracks(baseList()));
    let rounds;
    if (state.mode === "mine") {
      rounds = candidates.slice(0, SONGS_PER_GAME);
      game.suggestPool = state.myTracks;
    } else {
      $("poolInfo").textContent = "Lade Songs…";
      rounds = [];
      for (let i = 0; i < candidates.length && rounds.length < SONGS_PER_GAME; i += 5) {
        const res = await Promise.allSettled(candidates.slice(i, i + 5).map(resolveHit));
        for (const r of res) if (r.status === "fulfilled" && r.value) rounds.push(r.value);
      }
      rounds = rounds.slice(0, SONGS_PER_GAME);
      game.suggestPool = window.ALL_TIME_SONGS;
      if (rounds.length < MIN_SONGS) throw new Error("Songs konnten bei Spotify nicht gefunden werden.");
    }

    game.mode = state.mode;
    game.rounds = rounds;
    game.score = 0;
    game.filterLabel = filterLabel();
    $("roundTotal").textContent = rounds.length;
    show("gameView");
    startRound(0);
  } catch (e) {
    $("hudStatus").textContent = e.message;
  } finally {
    renderHud();
  }
}

function startRound(i) {
  stopPlayback();
  game.index = i;
  game.current = game.rounds[i];
  game.stage = 0;
  game.history = [];
  game.finished = false;

  const dur = game.current.duration_ms;
  game.startMs = $("randomStart").checked && dur > 60_000
    ? Math.floor(Math.random() * (dur - 16_000 - 20_000)) + 10_000
    : 0;

  $("guessInput").value = "";
  selectedTrack = null;
  hideSuggestions();
  $("guessArea").classList.remove("hidden");
  $("resultArea").classList.add("hidden");
  $("cover").classList.add("hidden");
  $("cover").parentElement.classList.remove("revealed");
  document.querySelector(".game-card").classList.remove("win");
  setStatus("");
  renderGame();

  // Song im Hintergrund vorladen
  setPlayButton("loading");
  game.preload = preloadTrack(game.current, game.startMs)
    .catch((e) => setStatus(e.message))
    .finally(() => { if (!playing) setPlayButton("idle"); });
}

function renderGame() {
  $("roundNo").textContent = game.index + 1;
  $("score").textContent = game.score;

  const st = $("stages");
  st.innerHTML = "";
  STAGES.forEach((sec, i) => {
    const el = document.createElement("div");
    const h = game.history[i];
    el.className = "stage " + (h ? h.type : (i === game.stage && !game.finished ? "current" : ""));
    el.innerHTML = `<i></i><span>${fmtSec(sec)}s</span>`;
    st.appendChild(el);
  });

  const gl = $("guessList");
  gl.innerHTML = "";
  for (const h of game.history) {
    if (h.type === "right") continue;
    const li = document.createElement("li");
    li.className = h.type;
    li.textContent = h.type === "skipped" ? `Übersprungen (${fmtSec(STAGES[game.history.indexOf(h)])}s)` : "✗ " + h.text;
    gl.appendChild(li);
  }

  if (!game.finished) {
    $("playHint").textContent = `Du hörst ${fmtSec(STAGES[game.stage])} Sekunden · ${POINTS[game.stage]} Punkte möglich`;
    const next = STAGES[game.stage + 1];
    $("skipBtn").textContent = next ? `Überspringen (+${fmtSec(+(next - STAGES[game.stage]).toFixed(1))}s)` : "Aufgeben";
  }
}

// Play-Button: Zustand + Fortschrittsring
function setPlayButton(mode) {
  const b = $("playBtn");
  b.classList.toggle("playing", mode === "playing");
  b.classList.toggle("loading", mode === "loading");
  b.setAttribute("aria-label", mode === "playing" ? "Stoppen" : "Abspielen");
}

function setRing(fraction) {
  $("ringFg").style.strokeDashoffset = String(289 * (1 - Math.min(1, Math.max(0, fraction))));
}

async function onPlayClick() {
  if (!game.current) return;
  if (playing) { stopPlayback(); return; }
  if (game.finished) return playFull();
  await playSnippet();
}

async function playSnippet() {
  const seconds = STAGES[game.stage];
  setPlayButton("loading");
  try {
    await game.preload;
    playing = "snippet";
    const ok = await playSegment(game.current, game.startMs, seconds, (t) => setRing(t / seconds));
    if (ok && playing) setPlayButton("playing");
  } catch (e) {
    playing = null;
    setPlayButton("idle");
    setStatus(e.message);
  }
}

async function playFull() {
  const dur = game.current.duration_ms || 1;
  setPlayButton("loading");
  try {
    playing = "full";
    const ok = await playSegment(game.current, 0, Infinity, (t) => setRing((t * 1000) / dur));
    if (ok && playing) setPlayButton("playing");
  } catch (e) {
    playing = null;
    setPlayButton("idle");
    setStatus(e.message);
  }
}

function isCorrect(guess) {
  const t = game.current;
  if (guess.id === t.id || (t.key && guess.id === t.key)) return true;
  return norm(guess.name) === norm(t.name) && norm(guess.artists[0].name) === norm(t.artists[0].name);
}

function addAttempt(entry) {
  game.history.push(entry);
  if (entry.type === "right") return finish(true);
  if (game.stage >= STAGES.length - 1) return finish(false);
  game.stage++;
  renderGame();
  playSnippet();
}

function submitGuess() {
  if (game.finished) return;
  const guess = selectedTrack || findByText($("guessInput").value);
  if (!guess) { setStatus("Wähle einen Song aus der Liste."); return; }
  setStatus("");
  $("guessInput").value = "";
  selectedTrack = null;
  hideSuggestions();
  addAttempt({ type: isCorrect(guess) ? "right" : "wrong", text: label(guess) });
}

function skip() {
  if (!game.finished) addAttempt({ type: "skipped" });
}

function finish(won) {
  game.finished = true;
  stopPlayback();
  const t = game.current;
  const pts = won ? POINTS[game.stage] : 0;
  game.score += pts;
  renderGame();

  $("guessArea").classList.add("hidden");
  $("resultArea").classList.remove("hidden");
  $("playHint").textContent = "";
  const rt = $("resultText");
  rt.className = "result-text " + (won ? "win" : "lose");
  rt.textContent = won ? `Richtig nach ${fmtSec(STAGES[game.stage])}s · +${pts} Punkte` : "Leider nicht erraten";
  $("resultTitle").textContent = t.name;
  $("resultArtist").textContent = t.artists.map((a) => a.name).join(", ");
  $("nextBtn").textContent = game.index + 1 < game.rounds.length ? "Nächster Song" : "Ergebnis anzeigen";

  const cover = $("cover");
  cover.src = t.cover || "";
  cover.classList.toggle("hidden", !t.cover);
  cover.parentElement.classList.add("revealed");

  if (won) {
    const card = document.querySelector(".game-card");
    card.classList.remove("win");
    void card.offsetWidth;
    card.classList.add("win");
    if (game.stage === 0) celebrate();
  }
  playFull(); // Song direkt abspielen
}

function nextSong() {
  if (game.index + 1 < game.rounds.length) startRound(game.index + 1);
  else endGame();
}

// ---------- Feier-Animation (0,1 s) ----------
function celebrate() {
  const wrap = $("celebrate");
  const canvas = $("confetti");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);

  // Text-Animation neu starten
  const text = wrap.querySelector(".celebrate-text");
  text.style.animation = "none";
  void text.offsetWidth;
  text.style.animation = "";
  wrap.classList.remove("hidden");

  const colors = ["#1ed760", "#ffd166", "#5ad1ff", "#ff5470", "#ffffff", "#b388ff"];
  const parts = [];
  for (let i = 0; i < 220; i++) {
    const fromLeft = i % 2 === 0;
    parts.push({
      x: fromLeft ? -10 : innerWidth + 10,
      y: innerHeight * (0.55 + Math.random() * 0.3),
      vx: (fromLeft ? 1 : -1) * (6 + Math.random() * 10),
      vy: -(10 + Math.random() * 12),
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 10,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[i % colors.length],
    });
  }
  const start = performance.now();
  const frame = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, 1 - t / 3200);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (t < 3200) requestAnimationFrame(frame);
    else wrap.classList.add("hidden");
  };
  requestAnimationFrame(frame);
}

// ---------- Leaderboard ----------
const Board = {
  remote: (window.LEADERBOARD_URL || "").replace(/\/+$/, ""),

  async list(mode) {
    if (this.remote) {
      const res = await fetch(`${this.remote}/scores/${mode}.json`);
      if (!res.ok) throw new Error("Leaderboard nicht erreichbar.");
      const data = (await res.json()) || {};
      return Object.values(data);
    }
    try { return JSON.parse(localStorage.getItem("board_" + mode) || "[]"); } catch { return []; }
  },

  async add(mode, entry) {
    if (this.remote) {
      await fetch(`${this.remote}/scores/${mode}.json`, { method: "POST", body: JSON.stringify(entry) });
      return;
    }
    const list = await this.list(mode);
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    try { localStorage.setItem("board_" + mode, JSON.stringify(list.slice(0, 50))); } catch { /* egal */ }
  },
};

function cleanEntry(e) {
  return {
    name: String(e?.name || "?").slice(0, 40),
    score: Number(e?.score) || 0,
    filters: String(e?.filters || "").slice(0, 80),
    date: Number(e?.date) || 0,
    songs: Number(e?.songs) || 0,
  };
}

async function renderBoard(listEl, mode, highlightDate) {
  listEl.innerHTML = "";
  let entries;
  try {
    entries = (await Board.list(mode)).map(cleanEntry).sort((a, b) => b.score - a.score).slice(0, 20);
  } catch (e) {
    entries = [];
  }
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Noch keine Einträge – spiel die erste Runde!";
    listEl.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    if (highlightDate && e.date === highlightDate) li.classList.add("me");
    const who = document.createElement("div");
    who.className = "who";
    const b = document.createElement("b");
    b.textContent = e.name;
    const s = document.createElement("small");
    s.textContent = `${e.filters} · ${new Date(e.date).toLocaleDateString("de-DE")}`;
    who.append(b, s);
    const pts = document.createElement("span");
    pts.className = "pts";
    pts.textContent = e.score;
    li.append(who, pts);
    listEl.appendChild(li);
  }
}

async function endGame() {
  stopPlayback();
  const entry = {
    name: state.me?.display_name || state.me?.id || "Spieler",
    score: game.score,
    filters: game.filterLabel,
    songs: game.rounds.length,
    date: Date.now(),
  };
  const before = (await Board.list(game.mode).catch(() => [])).map(cleanEntry);
  const myBest = Math.max(0, ...before.filter((e) => e.name === entry.name).map((e) => e.score));
  await Board.add(game.mode, entry).catch(() => {});

  $("endScore").textContent = game.score;
  const max = game.rounds.length * POINTS[0];
  $("endInfo").textContent = (game.score > myBest && before.length ? "Neuer persönlicher Rekord! · " : "") +
    `${game.score} von ${max} möglichen Punkten · ${game.filterLabel}`;
  show("endView");
  renderBoard($("endBoard"), game.mode, entry.date);
}

let boardMode = "mine";
function openBoard() {
  show("boardView");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.board === boardMode));
  $("boardNote").textContent = Board.remote ? "" : "Dieses Leaderboard wird nur in diesem Browser gespeichert.";
  renderBoard($("board"), boardMode);
}

// ---------- Suche / Vorschläge ----------
let selectedTrack = null;
let activeIndex = -1;
let currentMatches = [];

function findByText(text) {
  const q = text.trim().toLowerCase();
  return game.suggestPool.find((t) => label(t).toLowerCase() === q) || null;
}

function updateSuggestions() {
  selectedTrack = null;
  const q = $("guessInput").value.trim().toLowerCase();
  const box = $("suggestions");
  if (!q) return hideSuggestions();

  const words = q.split(/\s+/);
  currentMatches = game.suggestPool
    .filter((t) => { const l = label(t).toLowerCase(); return words.every((w) => l.includes(w)); })
    .sort((a, b) => label(a).localeCompare(label(b)))
    .slice(0, 30);

  activeIndex = -1;
  box.innerHTML = "";
  if (!currentMatches.length) return hideSuggestions();
  currentMatches.forEach((t, i) => {
    const li = document.createElement("li");
    li.textContent = t.name + " ";
    const small = document.createElement("small");
    small.textContent = "– " + t.artists.map((a) => a.name).join(", ");
    li.appendChild(small);
    li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
    box.appendChild(li);
  });
  box.classList.remove("hidden");
}

function pick(i) {
  selectedTrack = currentMatches[i];
  $("guessInput").value = label(selectedTrack);
  hideSuggestions();
}

function hideSuggestions() { $("suggestions").classList.add("hidden"); }

function highlight() {
  [...$("suggestions").children].forEach((li, i) => li.classList.toggle("active", i === activeIndex));
  $("suggestions").children[activeIndex]?.scrollIntoView({ block: "nearest" });
}

// ---------- UI-Verdrahtung ----------
function goHud() {
  stopPlayback();
  show("hudView");
  renderHud();
}

function bindEvents() {
  $("loginBtn").addEventListener("click", login);
  $("logoutBtn").addEventListener("click", () => { stopPlayback(); player?.disconnect(); logout(); });
  $("logoBtn").addEventListener("click", () => { if (state.me) goHud(); });

  document.querySelectorAll(".mode").forEach((m) => m.addEventListener("click", () => {
    state.mode = m.dataset.mode;
    if (state.mode === "mine") ensureMyTracks();
    renderHud();
  }));
  $("startBtn").addEventListener("click", startGame);
  $("boardBtn").addEventListener("click", openBoard);
  $("boardBackBtn").addEventListener("click", goHud);
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    boardMode = t.dataset.board;
    openBoard();
  }));

  $("quitBtn").addEventListener("click", goHud);
  $("playBtn").addEventListener("click", onPlayClick);
  $("skipBtn").addEventListener("click", skip);
  $("submitBtn").addEventListener("click", submitGuess);
  $("nextBtn").addEventListener("click", nextSong);
  $("againBtn").addEventListener("click", () => { show("hudView"); startGame(); });
  $("menuBtn").addEventListener("click", goHud);

  const input = $("guessInput");
  input.addEventListener("input", updateSuggestions);
  input.addEventListener("blur", () => setTimeout(hideSuggestions, 100));
  input.addEventListener("keydown", (e) => {
    const open = !$("suggestions").classList.contains("hidden");
    if (e.key === "ArrowDown" && open) { activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1); highlight(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && open) { activeIndex = Math.max(activeIndex - 1, 0); highlight(); e.preventDefault(); }
    else if (e.key === "Enter") {
      if (open && activeIndex >= 0) pick(activeIndex);
      else submitGuess();
      e.preventDefault();
    } else if (e.key === "Escape") hideSuggestions();
  });
}

async function init() {
  bindEvents();
  if (!CLIENT_ID || CLIENT_ID.startsWith("HIER_")) {
    show("loginView");
    $("configWarn").classList.remove("hidden");
    $("loginBtn").disabled = true;
    return;
  }
  try {
    await handleRedirect();
  } catch (e) {
    alert(e.message);
  }

  if (!(await getToken())) return show("loginView");

  try {
    state.me = await api("/me");
    $("userName").textContent = state.me.display_name || state.me.id;
    $("userBox").classList.remove("hidden");
  } catch (e) {
    console.warn(e);
  }
  connectPlayer();
  show("hudView");
  renderHud();
  ensureMyTracks(); // eigene Songs schon im Menü vorladen
}

init();
