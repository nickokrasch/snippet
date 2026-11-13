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

const STAGES = [0.5, 1, 2, 4, 8, 16];        // Sekunden pro Versuch
const POINTS = [100, 80, 60, 40, 20, 10];    // Punkte je nach Versuch
const MAX_SEC = STAGES[STAGES.length - 1];

const $ = (id) => document.getElementById(id);

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
async function loadTracks(source) {
  const fetchers = {
    top_short: () => api("/me/top/tracks?limit=50&time_range=short_term").then((d) => d.items),
    top_medium: () => api("/me/top/tracks?limit=50&time_range=medium_term").then((d) => d.items),
    top_long: () => api("/me/top/tracks?limit=50&time_range=long_term").then((d) => d.items),
    recent: () => api("/me/player/recently-played?limit=50").then((d) => d.items.map((i) => i.track)),
    saved: async () => {
      const a = await api("/me/tracks?limit=50");
      const b = a.next ? await api("/me/tracks?limit=50&offset=50") : { items: [] };
      return [...a.items, ...b.items].map((i) => i.track);
    },
  };
  const keys = source === "mix" ? Object.keys(fetchers) : [source];
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
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const t of r.value) {
      if (t && t.id && t.type === "track" && !t.is_local) byId.set(t.id, t);
    }
  }
  return [...byId.values()];
}

// ---------- Player (Web Playback SDK) ----------
let player = null;
let deviceId = null;
let playerReady = null; // Promise, die beim "ready" auflöst

window.onSpotifyWebPlaybackSDKReady = () => {
  playerReady = new Promise((resolve, reject) => {
    player = new Spotify.Player({
      name: "Snippet Ratespiel",
      getOAuthToken: async (cb) => cb(await getToken()),
      volume: 0.8,
    });
    player.addListener("ready", ({ device_id }) => { deviceId = device_id; resolve(); });
    player.addListener("initialization_error", async ({ message }) => {
      const drm = await hasWidevine();
      reject(new Error(drm ? "Player-Fehler: " + message
        : "Dieser Browser kann keine Spotify-Musik abspielen (Widevine/DRM fehlt). " +
          "Öffne http://127.0.0.1:8888/ in Chrome oder Edge – in Firefox unter Einstellungen „DRM-kontrollierte Inhalte wiedergeben“ aktivieren."));
    });
    player.addListener("authentication_error", ({ message }) => reject(new Error(message)));
    player.addListener("account_error", () =>
      reject(new Error("Für die Wiedergabe im Browser brauchst du Spotify Premium.")));
    player.addListener("playback_error", ({ message }) => setStatus("Wiedergabefehler: " + message));
  });
  playerReady.catch(() => {}); // Fehler wird beim Spielstart angezeigt
  connectPlayer();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let connectStarted = false;
function connectPlayer() {
  if (player && !connectStarted && localStorage.getItem("access_token")) {
    connectStarted = true;
    player.connect();
  }
}

// Wartet, bis der Player-Zustand die Bedingung erfüllt
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

async function playSegment(track, startMs, seconds, onProgress) {
  const myToken = ++playToken;
  clearTimeout(stopTimer);
  cancelAnimationFrame(rafId);
  try {
    await startSegment(track, startMs, seconds, onProgress, myToken);
  } catch (e) {
    // Sicherheitsnetz: nie weiterlaufen lassen, wenn etwas schiefging
    if (myToken === playToken) player.pause();
    throw e;
  }
}

async function startSegment(track, startMs, seconds, onProgress, myToken) {
  const state = await player.getCurrentState();
  const loaded = state && state.track_window.current_track?.id === track.id;
  if (loaded) {
    // Song ist schon geladen: zurückspulen und erst weiterspielen, wenn der Sprung angekommen ist
    await player.pause();
    await player.seek(startMs);
    await waitForState((s) => Math.abs(s.position - startMs) < 250, 3000);
    await player.resume();
  } else {
    await api(`/me/player/play?device_id=${deviceId}`, "PUT", {
      uris: [track.uri],
      position_ms: startMs,
    });
  }

  const s = await waitForState((s) => !s.paused && s.track_window.current_track?.id === track.id);
  if (myToken !== playToken) return;
  const offset = Math.min(Math.max(0, s.position - startMs), 300);
  const t0 = performance.now() - offset;

  if (onProgress) {
    const tick = () => {
      const elapsed = (performance.now() - t0) / 1000;
      onProgress(Math.min(elapsed, seconds));
      if (elapsed < seconds) rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  if (seconds !== Infinity) {
    const remaining = seconds * 1000 - (performance.now() - t0);
    stopTimer = setTimeout(() => { if (myToken === playToken) player.pause(); }, Math.max(0, remaining));
  }
}

function stopPlayback() {
  playToken++;
  clearTimeout(stopTimer);
  cancelAnimationFrame(rafId);
  player?.pause();
}

// ---------- Spiel ----------
const game = {
  pool: [],
  queue: [],
  current: null,
  startMs: 0,
  stage: 0,
  history: [],
  finished: false,
  score: 0,
  round: 0,
  streak: 0,
  playing: false,
};

const norm = (s) => s.toLowerCase()
  .replace(/\s*[\(\[].*?[\)\]]/g, "")      // (feat. …), [Remastered]
  .replace(/\s+-\s+.*$/, "")               // " - Remastered 2011"
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]/g, "");

const label = (t) => `${t.name} – ${t.artists.map((a) => a.name).join(", ")}`;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function fmtSec(s) { return String(s).replace(".", ","); }

function setStatus(text) { $("gameStatus").textContent = text || ""; }

function nextRound() {
  stopPlayback();
  setListening(false);
  if (game.queue.length === 0) game.queue = shuffle([...game.pool]);
  game.current = game.queue.pop();
  game.stage = 0;
  game.history = [];
  game.finished = false;
  game.round++;

  const dur = game.current.duration_ms;
  game.startMs = $("randomStart").checked && dur > 60_000
    ? Math.floor(Math.random() * (dur - MAX_SEC * 1000 - 20_000)) + 10_000
    : 0;

  $("guessInput").value = "";
  selectedTrack = null;
  $("guessArea").classList.remove("hidden");
  $("resultArea").classList.add("hidden");
  setStatus("");
  render();
}

function render() {
  $("score").textContent = game.score;
  $("round").textContent = game.round;
  $("streak").textContent = game.streak;

  const list = $("attempts");
  list.innerHTML = "";
  for (let i = 0; i < STAGES.length; i++) {
    const li = document.createElement("li");
    const h = game.history[i];
    if (h) {
      li.className = h.type;
      li.textContent = h.type === "skipped" ? "Übersprungen" : (h.type === "right" ? "✓ " : "✗ ") + h.text;
    }
    list.appendChild(li);
  }

  const unlocked = game.finished ? MAX_SEC : STAGES[game.stage];
  $("barUnlocked").style.width = (unlocked / MAX_SEC) * 100 + "%";
  $("barProgress").style.width = "0";
  $("unlockedLabel").textContent = fmtSec(unlocked) + "s";

  const nextStage = STAGES[game.stage + 1];
  $("skipBtn").innerHTML = nextStage
    ? `Überspringen (+${fmtSec(nextStage - STAGES[game.stage])}s)`
    : "Aufgeben";
}

function drawTicks() {
  const ticks = $("barTicks");
  ticks.innerHTML = "";
  for (const s of STAGES.slice(0, -1)) {
    const el = document.createElement("span");
    el.style.left = (s / MAX_SEC) * 100 + "%";
    ticks.appendChild(el);
  }
}

async function playCurrent() {
  if (!game.current) return;
  const seconds = game.finished ? MAX_SEC : STAGES[game.stage];
  try {
    await playSegment(game.current, game.startMs, seconds, (t) => {
      $("barProgress").style.width = (t / MAX_SEC) * 100 + "%";
    });
  } catch (e) {
    setStatus(e.message);
  }
}

function addAttempt(entry) {
  game.history.push(entry);
  if (entry.type === "right") return finish(true);
  if (game.stage >= STAGES.length - 1) return finish(false);
  game.stage++;
  render();
}

function isCorrect(guess) {
  const t = game.current;
  if (guess.id === t.id) return true;
  // gleicher Song auf anderem Album / als Single zählt auch
  return norm(guess.name) === norm(t.name) && guess.artists[0]?.id === t.artists[0]?.id;
}

function submitGuess() {
  if (game.finished) return;
  const guess = selectedTrack || findByText($("guessInput").value);
  if (!guess) { setStatus("Wähle einen Song aus der Liste."); return; }
  setStatus("");
  addAttempt({ type: isCorrect(guess) ? "right" : "wrong", text: label(guess) });
  $("guessInput").value = "";
  selectedTrack = null;
  hideSuggestions();
  if (!game.finished) playCurrent();
}

function skip() {
  if (game.finished) return;
  addAttempt({ type: "skipped" });
  if (!game.finished) playCurrent();
}

function finish(won) {
  game.finished = true;
  stopPlayback();
  const t = game.current;
  if (won) {
    game.score += POINTS[game.stage];
    game.streak++;
  } else {
    game.streak = 0;
  }
  render();

  $("guessArea").classList.add("hidden");
  $("resultArea").classList.remove("hidden");
  const rt = $("resultText");
  rt.className = "result-text " + (won ? "win" : "lose");
  rt.textContent = won
    ? `Richtig nach ${fmtSec(STAGES[game.stage])}s! +${POINTS[game.stage]} Punkte`
    : "Leider nicht erraten.";
  $("resultTitle").textContent = t.name;
  $("resultArtist").textContent = t.artists.map((a) => a.name).join(", ");
  $("cover").src = t.album.images?.[0]?.url || "";
}

let listening = false;

function setListening(on) {
  listening = on;
  $("listenBtn").textContent = on ? "Stopp" : "Song anhören";
}

async function toggleListen() {
  if (listening) {
    stopPlayback();
    setListening(false);
    return;
  }
  setListening(true);
  try {
    await playSegment(game.current, 0, Infinity, null);
  } catch (e) {
    setListening(false);
    setStatus(e.message);
  }
}

// ---------- Suche / Vorschläge ----------
let selectedTrack = null;
let activeIndex = -1;
let currentMatches = [];

function findByText(text) {
  const q = text.trim().toLowerCase();
  return game.pool.find((t) => label(t).toLowerCase() === q) || null;
}

function updateSuggestions() {
  selectedTrack = null;
  const q = $("guessInput").value.trim().toLowerCase();
  const box = $("suggestions");
  if (q.length < 1) return hideSuggestions();

  const words = q.split(/\s+/);
  currentMatches = game.pool
    .filter((t) => { const l = label(t).toLowerCase(); return words.every((w) => l.includes(w)); })
    .sort((a, b) => label(a).localeCompare(label(b)))
    .slice(0, 30);

  activeIndex = -1;
  box.innerHTML = "";
  if (currentMatches.length === 0) return hideSuggestions();
  currentMatches.forEach((t, i) => {
    const li = document.createElement("li");
    li.innerHTML = `${escapeHtml(t.name)} <small>– ${escapeHtml(t.artists.map((a) => a.name).join(", "))}</small>`;
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- UI-Verdrahtung ----------
function show(view) {
  for (const v of ["loginView", "setupView", "gameView"]) $(v).classList.toggle("hidden", v !== view);
}

async function startGame() {
  const btn = $("startBtn");
  btn.disabled = true;
  $("setupStatus").textContent = "Lade deine Songs…";
  try {
    player?.activateElement?.(); // Autoplay im Browser freischalten (muss im Klick passieren)
    if (!playerReady) throw new Error("Spotify-Player lädt noch – bitte gleich nochmal versuchen.");
    await playerReady;

    game.pool = await loadTracks($("sourceSelect").value);
    if (game.pool.length < 3) throw new Error("Zu wenige Songs gefunden. Probier eine andere Quelle.");
    game.queue = shuffle([...game.pool]);
    game.score = 0; game.round = 0; game.streak = 0;

    $("setupStatus").textContent = "";
    show("gameView");
    drawTicks();
    nextRound();
  } catch (e) {
    $("setupStatus").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function bindEvents() {
  $("loginBtn").addEventListener("click", login);
  $("logoutBtn").addEventListener("click", () => { stopPlayback(); player?.disconnect(); logout(); });
  $("startBtn").addEventListener("click", startGame);
  $("playBtn").addEventListener("click", playCurrent);
  $("skipBtn").addEventListener("click", skip);
  $("submitBtn").addEventListener("click", submitGuess);
  $("nextBtn").addEventListener("click", () => { nextRound(); playCurrent(); });
  $("listenBtn").addEventListener("click", toggleListen);

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
    const me = await api("/me");
    $("userName").textContent = me.display_name || me.id;
    $("userBox").classList.remove("hidden");
  } catch (e) {
    console.warn(e);
  }
  // Falls das SDK schon vor dem Login geladen wurde
  connectPlayer();
  show("setupView");
}

init();
