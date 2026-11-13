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
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");
// Erhöhen, wenn neue Berechtigungen dazukommen → alle melden sich einmal neu an
const SCOPE_VERSION = "2";

const STAGES = [0.1, 0.5, 1, 2, 4, 8, 16];            // Sekunden pro Versuch
const POINTS = [150, 100, 80, 60, 40, 20, 10];       // Punkte je nach Versuch
const MIN_SONGS = 5;
const VOLUME = 0.8;

const SOURCES = [
  { key: "all", label: "Alles" },
  { key: "top_short", label: "Top 4 Wochen" },
  { key: "top_medium", label: "Top 6 Monate" },
  { key: "top_long", label: "Top Allzeit" },
  { key: "recent", label: "Zuletzt gehört" },
  { key: "saved", label: "Lieblingssongs" },
  { key: "playlists", label: "Playlists" },
];

// Grobe Genre-Gruppen; Genres von Spotify/Deezer werden per Stichwort zugeordnet
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

// ---------- Diagnose-Protokoll ----------
const diag = [];
function log(msg) {
  diag.push(new Date().toLocaleTimeString("de-DE") + "  " + msg);
  if (diag.length > 400) diag.shift();
  if (!$("diagView").classList.contains("hidden")) $("diagLog").textContent = diag.join("\n");
}
window.addEventListener("error", (e) => log("JS-Fehler: " + e.message));
window.addEventListener("unhandledrejection", (e) => log("JS-Fehler: " + (e.reason?.message || e.reason)));

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
  localStorage.setItem("scope_version", SCOPE_VERSION);
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

async function api(path, method = "GET", body, attempt = 0) {
  const token = await getToken();
  const res = await fetch("https://api.spotify.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Zu viele Anfragen → kurz warten und nochmal
  if (res.status === 429 && attempt < 4) {
    await sleep((Number(res.headers.get("Retry-After")) || 1) * 1000 + 200);
    return api(path, method, body, attempt + 1);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Spotify antwortet bei manchen Fehlern mit reinem Text */ }
  if (!res.ok) {
    log(`API ${method} ${path.split("?")[0]} → ${res.status} ${(data?.error?.message || text || "").slice(0, 120)}`);
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
// Holt alle Seiten einer Liste: erst Seite 1 (verrät die Gesamtzahl), dann den Rest parallel
async function fetchAll(path, limit, onItems) {
  const sep = path.includes("?") ? "&" : "?";
  const first = await api(`${path}${sep}limit=${limit}&offset=0`);
  onItems(first.items || []);
  const total = first.total || 0;
  const offsets = [];
  for (let o = limit; o < total; o += limit) offsets.push(o);
  let failedPages = 0;
  for (let i = 0; i < offsets.length; i += 4) {
    const pages = await Promise.allSettled(
      offsets.slice(i, i + 4).map((o) => api(`${path}${sep}limit=${limit}&offset=${o}`)));
    for (const p of pages) {
      if (p.status === "fulfilled") onItems(p.value.items || []);
      else failedPages++;
    }
  }
  if (!path.startsWith("/playlists/")) {
    log(`${path}: Spotify meldet ${total} Einträge, ${offsets.length + 1} Seiten, ${failedPages} fehlgeschlagen`);
  }
  return total;
}

const itemTrack = (i) => i?.track || i?.item || null;

async function loadMyTracks(onProgress) {
  const byId = new Map();
  const add = (source) => (tracks) => {
    for (const t of tracks) {
      if (!t || !t.id || (t.type && t.type !== "track") || t.is_local) continue;
      if (!byId.has(t.id)) byId.set(t.id, toTrack(t));
      byId.get(t.id).sources.add(source);
    }
    onProgress?.(byId.size);
  };

  const top = (range) => async () => {
    // Spotify gibt pro Zeitraum höchstens ~100 Top-Songs heraus
    const res = await Promise.allSettled([0, 49].map((o) =>
      api(`/me/top/tracks?limit=50&offset=${o}&time_range=${range}`)));
    if (res.every((r) => r.status === "rejected")) throw res[0].reason;
    for (const r of res) if (r.status === "fulfilled") add("top_" + range.split("_")[0])(r.value.items);
  };

  const fetchers = {
    top_short: top("short_term"),
    top_medium: top("medium_term"),
    top_long: top("long_term"),
    recent: () => api("/me/player/recently-played?limit=50").then((d) => add("recent")(d.items.map(itemTrack))),
    saved: () => fetchAll("/me/tracks", 50, (items) => add("saved")(items.map(itemTrack))),
    playlists: async () => {
      const lists = [];
      await fetchAll("/me/playlists", 50, (items) => lists.push(...items.filter(Boolean)));
      let ok = 0;
      for (let i = 0; i < lists.length; i += 3) {
        await Promise.allSettled(lists.slice(i, i + 3).map(async (pl) => {
          const onItems = (items) => add("playlists")(items.map(itemTrack));
          try {
            try {
              await fetchAll(`/playlists/${pl.id}/items`, 50, onItems);
            } catch {
              await fetchAll(`/playlists/${pl.id}/tracks`, 50, onItems);
            }
            ok++;
          } catch (e) {
            log(`Playlist „${pl.name}“: nicht lesbar (${e.status || ""} ${e.message.slice(0, 80)})`);
          }
        }));
      }
      log(`Playlists: ${lists.length} gefunden, ${ok} gelesen`);
    },
  };
  const keys = Object.keys(fetchers);
  const results = await Promise.allSettled(keys.map((k) => fetchers[k]()));
  results.forEach((r, i) => {
    const n = [...byId.values()].filter((t) => t.sources.has(keys[i])).length;
    log(r.status === "fulfilled"
      ? `Quelle ${keys[i]}: ${n} Songs`
      : `Quelle ${keys[i]}: FEHLER ${r.reason?.status || ""} ${r.reason?.message?.slice(0, 120)}`);
  });
  log(`Insgesamt ${byId.size} verschiedene Songs`);

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

  return [...byId.values()];
}

// ---------- Genres ----------
// Spotify liefert für Apps im Testmodus meist keine Genres → Deezer als Quelle.
// Ergebnisse werden pro Interpret im Browser gespeichert, damit es nur einmal dauert.
const GENRE_CACHE_KEY = "genre_cache_v1";
const genreCache = (() => {
  try { return JSON.parse(localStorage.getItem(GENRE_CACHE_KEY) || "{}"); } catch { return {}; }
})();
function saveGenreCache() {
  try { localStorage.setItem(GENRE_CACHE_KEY, JSON.stringify(genreCache)); } catch { /* voll */ }
}

// Deezer erlaubt keine direkten Anfragen aus dem Browser, aber JSONP
let jsonpId = 0;
let jsonpNext = 0;
async function jsonp(url) {
  // max. ~8 Anfragen pro Sekunde (Deezer-Limit: 50 pro 5 s)
  const wait = Math.max(0, jsonpNext - Date.now());
  jsonpNext = Math.max(Date.now(), jsonpNext) + 125;
  if (wait) await sleep(wait);
  return new Promise((resolve, reject) => {
    const cb = "__dz" + (++jsonpId);
    const s = document.createElement("script");
    const cleanup = () => { clearTimeout(timer); delete window[cb]; s.remove(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
    window[cb] = (d) => { cleanup(); resolve(d); };
    s.onerror = () => { cleanup(); reject(new Error("jsonp")); };
    s.src = url + (url.includes("?") ? "&" : "?") + "output=jsonp&callback=" + cb;
    document.head.appendChild(s);
  });
}

async function deezerGenres(artist, title) {
  const q = (s) => encodeURIComponent(s);
  let res = await jsonp(`https://api.deezer.com/search?limit=1&q=${q(`artist:"${artist}" track:"${title}"`)}`);
  let albumId = res.data?.[0]?.album?.id;
  if (!albumId) {
    res = await jsonp(`https://api.deezer.com/search?limit=1&q=${q(artist)}`);
    albumId = res.data?.[0]?.album?.id;
  }
  if (!albumId) return [];
  const album = await jsonp(`https://api.deezer.com/album/${albumId}`);
  return (album.genres?.data || []).map((g) => g.name.toLowerCase());
}

function applyGenres(tracks) {
  for (const t of tracks) {
    t.genres = genreKeys(t.artists.flatMap((a) => genreCache[a.name.toLowerCase()] || []));
  }
}

// Läuft im Hintergrund; das Menü aktualisiert sich zwischendurch
async function enrichGenres(tracks, onProgress) {
  // 1) Spotify versuchen (klappt nur, wenn Spotify Genres liefert)
  const ids = [...new Set(tracks.flatMap((t) => t.artists.map((a) => a.id)).filter(Boolean))];
  let spotifyGenres = 0;
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const d = await api("/artists?ids=" + ids.slice(i, i + 50).join(","));
      for (const a of d.artists || []) {
        if (a?.genres?.length) { genreCache[a.name.toLowerCase()] = a.genres; spotifyGenres++; }
      }
    }
    log(`Genres von Spotify: ${spotifyGenres} von ${ids.length} Interpreten`);
  } catch (e) {
    log(`Genres von Spotify: nicht verfügbar (${e.status || e.message})`);
  }

  // 2) Für alle übrigen Hauptinterpreten Deezer fragen
  const todo = new Map();
  for (const t of tracks) {
    const name = t.artists[0].name.toLowerCase();
    if (!(name in genreCache) && !todo.has(name)) todo.set(name, t);
  }
  applyGenres(tracks);
  let done = 0;
  let found = 0;
  let empty = 0;
  let failed = 0;
  const total = todo.size;
  log(`Deezer: ${total} Interpreten ohne Genre, ${Object.keys(genreCache).length} schon gespeichert`);
  onProgress?.(done, total);
  const queue = [...todo.entries()];
  const worker = async () => {
    while (queue.length) {
      const [name, t] = queue.shift();
      try {
        const g = await deezerGenres(t.artists[0].name, t.name);
        genreCache[name] = g;
        g.length ? found++ : empty++;
      } catch (e) {
        failed++;
        if (failed <= 3) log(`Deezer-Fehler bei „${t.artists[0].name}“: ${e.message}`);
      }
      done++;
      if (done % 15 === 0 || done === total) {
        applyGenres(tracks);
        saveGenreCache();
        onProgress?.(done, total);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  applyGenres(tracks);
  saveGenreCache();
  log(`Deezer fertig: ${found} mit Genre, ${empty} ohne Genre, ${failed} Fehler · ` +
    `${tracks.filter((t) => t.genres.size).length} von ${tracks.length} Songs haben jetzt ein Genre`);
  onProgress?.(total, total);
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
    player.addListener("playback_error", ({ message }) => {
      log("SDK playback_error: " + message);
      setStatus("Wiedergabefehler: " + message);
    });
    player.addListener("not_ready", () => log("SDK: Player nicht mehr bereit (not_ready)"));
    player.addListener("autoplay_failed", () => log("SDK: Autoplay vom Browser blockiert"));
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

// Spielt einen Abschnitt. Startet immer frisch an der gewünschten Stelle –
// Zurückspulen im pausierten Song meldet Spotify nicht zuverlässig zurück.
async function playSegment(track, startMs, seconds, onProgress) {
  const myToken = ++playToken;
  clearTimeout(stopTimer);
  cancelAnimationFrame(rafId);
  busy = true;
  const tClick = performance.now();
  try {
    await api(`/me/player/play?device_id=${deviceId}`, "PUT", { uris: [track.uri], position_ms: startMs });
    const s = await waitForState((s) => !s.paused && isCurrent(s, track) && s.position < startMs + 3000);
    if (myToken !== playToken) {
      if (!playing) player.pause(); // während des Ladens gestoppt
      return false;
    }

    // "Läuft" heißt noch nicht "Ton ist da": warten, bis sich die Position wirklich bewegt
    let moving = null;
    const until = performance.now() + 2000;
    while (performance.now() < until) {
      const s2 = await player.getCurrentState();
      if (myToken !== playToken) {
        if (!playing) player.pause();
        return false;
      }
      if (s2 && !s2.paused && s2.position > s.position + 15) { moving = s2; break; }
      await sleep(15);
    }
    const ref = moving || s;
    const playedMs = Math.max(0, ref.position - startMs);
    const t0 = performance.now() - Math.min(playedMs, 1000);
    log(`Start: soll ${seconds === Infinity ? "ganzer Song" : seconds + " s"}, ` +
      `Verzögerung ${Math.round(performance.now() - tClick)} ms, ` +
      (moving ? `Ton läuft seit ${playedMs} ms` : "Position bewegt sich nicht (Schätzung)"));

    // Fortschritt + Stopp: Position von Spotify und Uhr – was zuerst das Ende erreicht
    const endPos = startMs + seconds * 1000;
    (async () => {
      while (myToken === playToken) {
        const wall = performance.now() - t0;
        onProgress?.(wall / 1000);
        if (seconds !== Infinity) {
          let pos = startMs + wall;
          if (moving) {
            const st = await player.getCurrentState();
            if (myToken !== playToken) return;
            if (st) pos = Math.max(pos, st.position);
          }
          if (pos >= endPos - 15) {
            stopPlayback();
            await sleep(200);
            const end = await player.getCurrentState();
            if (end) log(`Gestoppt: soll ${seconds} s, laut Spotify gespielt ${((end.position - startMs) / 1000).toFixed(2)} s`);
            return;
          }
        }
        await sleep(seconds === Infinity ? 100 : 8);
      }
    })();
    return true;
  } catch (e) {
    if (myToken === playToken) player.pause();
    throw e;
  } finally {
    setTimeout(() => { busy = false; }, 300);
  }
}

function stopPlayback() {
  const myToken = ++playToken;
  clearTimeout(stopTimer);
  cancelAnimationFrame(rafId);
  playing = null;
  setPlayButton("idle");
  setRing(0);
  if (player) ensurePaused(myToken);
}

// Spotify ignoriert eine Pause manchmal (v. a. beim allerersten Abspielen) → prüfen und wiederholen
async function ensurePaused(token) {
  for (let i = 0; i < 4; i++) {
    await player.pause().catch(() => {});
    await sleep(i === 0 ? 60 : 250);
    if (token !== playToken) return; // inzwischen wurde neu gestartet
    const s = await player.getCurrentState();
    if (!s || s.paused) return;
    log(`Pause wurde ignoriert – neuer Versuch (${i + 2})`);
    if (i >= 1) await api(`/me/player/pause?device_id=${deviceId}`, "PUT").catch(() => {});
  }
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
  for (const v of ["loginView", "hudView", "gameView", "endView", "boardView", "historyView", "diagView"]) {
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
  $("genreNote").textContent = state.mode !== "mine" || loading ? ""
    : state.genreProgress || (!hasGenres ? "– keine Genre-Infos gefunden" : "");
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
  const onLoad = (n) => {
    if (state.mode === "mine" && !state.myTracks) $("poolInfo").textContent = `Lade deine Songs… ${n}`;
  };
  state.myTracksPromise = loadMyTracks(onLoad)
    .then((tracks) => {
      state.myTracks = tracks;
      applyGenres(tracks);
      renderHud();
      enrichGenres(tracks, (done, total) => {
        state.genreProgress = done < total ? `– Genres werden ermittelt… ${done}/${total}` : "";
        renderHud();
      }).catch(() => {});
    })
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

    game.mode = state.mode;
    game.candidates = filterTracks(baseList());
    game.queue = [];
    game.suggestPool = state.mode === "mine" ? state.myTracks : window.ALL_TIME_SONGS;
    game.results = [];
    game.score = 0;
    game.index = -1;
    game.filterLabel = filterLabel();

    $("poolInfo").textContent = "Lade Song…";
    // Browser-Player bei Spotify schon jetzt als aktives Gerät anmelden (ohne Ton),
    // damit der erste Klick nicht mit der Geräteübernahme kollidiert
    await api("/me/player", "PUT", { device_ids: [deviceId], play: false })
      .catch((e) => log("Gerät aktivieren fehlgeschlagen: " + e.message));
    const first = await prepareNext();
    preloadNext();
    show("gameView");
    startRound(first);
  } catch (e) {
    $("hudStatus").textContent = e.message;
  } finally {
    renderHud();
  }
}

// Endlos: alle passenden Songs gemischt nacheinander, danach neu gemischt
function takeCandidate() {
  if (!game.queue.length) game.queue = shuffle([...game.candidates]);
  return game.queue.pop();
}

async function prepareNext() {
  if (game.mode === "mine") return takeCandidate();
  for (let tries = 0; tries < 8; tries++) {
    const hit = takeCandidate();
    const t = await resolveHit(hit).catch(() => null);
    if (t) return t;
    log(`All-Time-Hit nicht bei Spotify gefunden: ${hit.name} – ${hit.artists[0].name}`);
  }
  throw new Error("Songs konnten bei Spotify nicht gefunden werden.");
}

function startRound(track) {
  stopPlayback();
  game.index++;
  game.current = track;
  game.stage = 0;
  game.history = [];
  game.finished = false;
  game.roundStartedAt = null;

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
  setPlayButton("idle");
  setRing(0);
  renderGame();
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
    $("skipBtn").textContent = next ? `Mehr hören (+${fmtSec(+(next - STAGES[game.stage]).toFixed(1))} s)` : "Aufgeben";
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
    game.roundStartedAt ??= performance.now(); // Bedenkzeit läuft ab dem ersten Abspielen
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
  renderGame(); // nächster Ausschnitt erst auf Klick
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

// Ganzen Song überspringen → direkt zum nächsten (keine Punkte, kommt als "übersprungen" in die Bibliothek)
function skipSong() {
  if (game.finished) return nextSong();
  game.finished = true;
  stopPlayback();
  const r = {
    track: game.current,
    won: false,
    skipped: true,
    seconds: STAGES[game.stage],
    points: 0,
    thinkMs: game.roundStartedAt ? performance.now() - game.roundStartedAt : 0,
  };
  game.results.push(r);
  History.add(r);
  nextSong();
}

function finish(won) {
  game.finished = true;
  stopPlayback();
  const t = game.current;
  const pts = won ? POINTS[game.stage] : 0;
  game.score += pts;
  game.results.push({
    track: t,
    won,
    seconds: STAGES[game.stage],
    points: pts,
    thinkMs: game.roundStartedAt ? performance.now() - game.roundStartedAt : 0,
  });
  History.add(game.results[game.results.length - 1]);
  renderGame();

  $("guessArea").classList.add("hidden");
  $("resultArea").classList.remove("hidden");
  $("playHint").textContent = "";
  const rt = $("resultText");
  rt.className = "result-text " + (won ? "win" : "lose");
  rt.textContent = won ? `Richtig nach ${fmtSec(STAGES[game.stage])}s · +${pts} Punkte` : "Leider nicht erraten";
  $("resultTitle").textContent = t.name;
  $("resultArtist").textContent = t.artists.map((a) => a.name).join(", ");

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

// Nächsten Song im Hintergrund vorbereiten: Daten + Cover
function preloadNext() {
  game.next = prepareNext();
  game.next.then((t) => { if (t?.cover) new Image().src = t.cover; }).catch(() => {});
}

async function nextSong() {
  const btn = $("nextBtn");
  btn.disabled = true;
  try {
    const track = await game.next;
    preloadNext();
    startRound(track);
  } catch (e) {
    setStatus(e.message);
    preloadNext();
  } finally {
    btn.disabled = false;
  }
}

// "Beenden": Ergebnis zeigen, wenn schon etwas gespielt wurde
function quitGame() {
  if (game.results.length) endGame();
  else goHud();
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
    s.textContent = `${e.songs ? e.songs + " Songs · " : ""}${e.filters} · ${new Date(e.date).toLocaleDateString("de-DE")}`;
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
    songs: game.results.length,
    date: Date.now(),
  };
  const before = (await Board.list(game.mode).catch(() => [])).map(cleanEntry);
  const myBest = Math.max(0, ...before.filter((e) => e.name === entry.name).map((e) => e.score));
  await Board.add(game.mode, entry).catch(() => {});

  $("endScore").textContent = game.score;
  const n = game.results.length;
  const right = game.results.filter((r) => r.won).length;
  $("endInfo").textContent = (game.score > myBest && before.length ? "Neuer persönlicher Rekord! · " : "") +
    `${right} von ${n} Songs erraten · ${game.filterLabel}`;
  show("endView");
  renderRecap();
  renderBoard($("endBoard"), game.mode, entry.date);
}

function fmtThink(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`;
}

// Alle Songs der Runde mit Ergebnis und Bedenkzeit
function renderRecap() {
  const list = $("recap");
  list.innerHTML = "";
  for (const r of game.results) list.appendChild(recapItem(r));
}

// ---------- Verlauf (alle jemals gespielten Songs) ----------
const HISTORY_KEY = "history_v1";
const History = {
  all() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; }
  },
  add(r) {
    const list = this.all();
    list.push({
      name: r.track.name,
      artists: r.track.artists.map((a) => a.name),
      cover: r.track.cover || "",
      won: r.won,
      skipped: !!r.skipped,
      seconds: r.seconds,
      points: r.points,
      thinkMs: Math.round(r.thinkMs),
      mode: game.mode,
      date: Date.now(),
    });
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-5000))); } catch { /* voll */ }
  },
};

const histTrack = (h) => ({ name: h.name, artists: h.artists.map((name) => ({ name })), cover: h.cover });
const statusOf = (h) => (h.won ? "won" : h.skipped ? "skipped" : "lost");

// Gleicher Song = gleicher Titel + Hauptinterpret
function librarySongs(all) {
  const map = new Map();
  for (const h of all) {
    const key = norm(h.name) + "|" + norm(h.artists[0] || "");
    let s = map.get(key);
    if (!s) {
      s = { name: h.name, artists: h.artists, cover: h.cover, plays: 0, wins: 0, skips: 0, best: null, fastestMs: null, last: 0 };
      map.set(key, s);
    }
    s.plays++;
    if (h.cover) s.cover = h.cover;
    if (h.won) {
      s.wins++;
      if (s.best === null || h.seconds < s.best) s.best = h.seconds;
      if (s.fastestMs === null || h.thinkMs < s.fastestMs) s.fastestMs = h.thinkMs;
    }
    if (h.skipped) s.skips++;
    s.last = Math.max(s.last, h.date);
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}

let historyView = "songs";
let historyFilter = "all";

function openHistory() {
  show("historyView");
  renderHistory();
}

function renderHistory() {
  document.querySelectorAll("[data-hview]").forEach((t) => t.classList.toggle("active", t.dataset.hview === historyView));
  document.querySelectorAll("[data-hfilter]").forEach((t) => t.classList.toggle("on", t.dataset.hfilter === historyFilter));

  const all = History.all();
  const songs = librarySongs(all);
  const played = all.filter((h) => !h.skipped);
  $("hsSongs").textContent = songs.length;
  $("hsRate").textContent = played.length ? Math.round((played.filter((h) => h.won).length / played.length) * 100) + " %" : "0 %";
  $("hsFast").textContent = all.filter((h) => h.won && h.seconds === STAGES[0]).length;

  const q = $("libSearch").value.trim().toLowerCase();
  const matchText = (x) => !q || (x.name + " " + x.artists.join(" ")).toLowerCase().includes(q);
  const list = $("historyList");
  list.innerHTML = "";
  const empty = (text) => {
    const li = document.createElement("li");
    li.className = "history-day";
    li.textContent = text;
    list.appendChild(li);
  };
  if (!all.length) return empty("Noch keine Songs – spiel eine Runde!");

  if (historyView === "songs") {
    const shown = songs.filter((s) => matchText(s) && (
      historyFilter === "all" ||
      (historyFilter === "won" && s.wins > 0) ||
      (historyFilter === "lost" && s.wins === 0 && s.plays > s.skips) ||
      (historyFilter === "skipped" && s.skips > 0)));
    if (!shown.length) return empty("Keine passenden Songs.");
    for (const s of shown.slice(0, 1000)) list.appendChild(libraryItem(s));
    return;
  }

  const shown = all.filter((h) => matchText(h) && (historyFilter === "all" || statusOf(h) === historyFilter)).reverse();
  if (!shown.length) return empty("Keine passenden Einträge.");
  let lastDay = "";
  for (const h of shown.slice(0, 1000)) {
    const day = new Date(h.date).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (day !== lastDay) {
      const d = document.createElement("li");
      d.className = "history-day";
      d.textContent = day;
      list.appendChild(d);
      lastDay = day;
    }
    list.appendChild(recapItem({ ...h, track: histTrack(h) }, h.date));
  }
}

// Eintrag in der Songs-Ansicht der Bibliothek
function libraryItem(s) {
  const li = document.createElement("li");
  li.className = s.wins ? "won" : s.plays === s.skips ? "skipped" : "lost";
  const img = document.createElement("img");
  img.alt = "";
  if (s.cover) img.src = s.cover;
  const info = document.createElement("div");
  info.className = "info";
  const b = document.createElement("b");
  b.textContent = s.name;
  const small = document.createElement("small");
  small.textContent = s.artists.join(", ");
  info.append(b, small);
  const res = document.createElement("div");
  res.className = "res";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = s.wins ? `Bestzeit ${fmtSec(s.best)} s` : s.plays === s.skips ? "übersprungen" : "nie erraten";
  const stats = document.createElement("small");
  stats.textContent = `${s.plays}× gespielt · ${s.wins}× erraten`;
  res.append(badge, stats);
  li.append(img, info, res);
  return li;
}

function recapItem(r, date) {
  {
    const li = document.createElement("li");
    li.className = r.won ? "won" : r.skipped ? "skipped" : "lost";

    const img = document.createElement("img");
    img.alt = "";
    if (r.track.cover) img.src = r.track.cover;

    const info = document.createElement("div");
    info.className = "info";
    const b = document.createElement("b");
    b.textContent = r.track.name;
    const small = document.createElement("small");
    small.textContent = r.track.artists.map((a) => a.name).join(", ");
    info.append(b, small);

    const res = document.createElement("div");
    res.className = "res";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = r.won ? `✓ ${fmtSec(r.seconds)} s` : r.skipped ? "übersprungen" : "✗";
    const time = document.createElement("small");
    time.textContent = (r.won ? `+${r.points} · ` : "") + fmtThink(r.thinkMs) +
      (date ? " · " + new Date(date).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "");
    res.append(badge, time);

    li.append(img, info, res);
    return li;
  }
}

let boardMode = "mine";
function openBoard() {
  show("boardView");
  document.querySelectorAll("[data-board]").forEach((t) => t.classList.toggle("active", t.dataset.board === boardMode));
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
  $("diagBtn").addEventListener("click", () => {
    show("diagView");
    $("diagLog").textContent = diag.join("\n") || "Noch keine Einträge.";
  });
  $("diagBackBtn").addEventListener("click", goHud);
  $("diagCopyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(diag.join("\n"));
      $("diagCopyBtn").textContent = "Kopiert ✓";
    } catch {
      $("diagCopyBtn").textContent = "Kopieren nicht möglich – Text markieren";
    }
    setTimeout(() => { $("diagCopyBtn").textContent = "Protokoll kopieren"; }, 2000);
  });
  $("boardBackBtn").addEventListener("click", goHud);
  document.querySelectorAll("[data-board]").forEach((t) => t.addEventListener("click", () => {
    boardMode = t.dataset.board;
    openBoard();
  }));
  $("historyBtn").addEventListener("click", openHistory);
  $("historyBackBtn").addEventListener("click", goHud);
  document.querySelectorAll("[data-hfilter]").forEach((t) => t.addEventListener("click", () => {
    historyFilter = t.dataset.hfilter;
    renderHistory();
  }));
  document.querySelectorAll("[data-hview]").forEach((t) => t.addEventListener("click", () => {
    historyView = t.dataset.hview;
    renderHistory();
  }));
  $("libSearch").addEventListener("input", renderHistory);
  $("skipSongBtn").addEventListener("click", skipSong);

  $("quitBtn").addEventListener("click", quitGame);
  $("gameMenuBtn").addEventListener("click", goHud);
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

  // Neue Berechtigungen (z. B. Playlists) → einmal neu anmelden
  if (localStorage.getItem("access_token") && localStorage.getItem("scope_version") !== SCOPE_VERSION) {
    ["access_token", "refresh_token", "expires_at"].forEach((k) => localStorage.removeItem(k));
    $("loginNote").classList.remove("hidden");
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
