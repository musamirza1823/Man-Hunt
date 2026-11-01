(() => {
  'use strict';

  // ------------------------------------------------------------------ constants
  const EMOJIS = ['🦊', '🐯', '🐼', '🐸', '🦁', '🐨', '🐙', '🦄', '🐺', '🐵', '🐲', '🦉'];
  const OPTIONS = {
    catchers: [0, 1, 2, 3, 4, 5, 6],
    leadSec: [10, 30, 60, 120, 300, 600],
    hideMin: [1, 2, 5, 10, 15, 20, 30],
    showMin: [1, 2, 3, 5, 10],
    gameMin: [0, 20, 30, 45, 60, 90, 120],
  };
  const autoCatchers = (n) => Math.max(1, Math.min(Math.max(1, n - 1), Math.round(n / 4)));
  const OPTION_LABEL = {
    catchers: (v) => (v === 0 ? `Auto (${autoCatchers(S ? S.players.length : 2)})` : String(v)),
    leadSec: (v) => (v < 60 ? `${v} sec` : `${v / 60} min`),
    hideMin: (v) => `${v} min`,
    showMin: (v) => `${v} min`,
    gameMin: (v) => (v === 0 ? 'No limit' : `${v} min`),
  };
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const DIE_TURN = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
  const LEAFLET_SOURCES = ['https://unpkg.com/leaflet@1.9.4/dist/', 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/'];

  // ------------------------------------------------------------------ helpers
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };
  const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const initial = (name) => (Array.from(name || '?')[0] || '?').toUpperCase();
  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) { /* ignore */ } };
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mmss(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
  }
  function clock(t) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function distanceM(a, b) {
    const R = 6371000, r = (d) => (d * Math.PI) / 180;
    const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    const r = (d) => (d * Math.PI) / 180;
    const y = Math.sin(r(b.lng - a.lng)) * Math.cos(r(b.lat));
    const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lng - a.lng));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
  const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

  /** A countdown span that the timer loop keeps up to date. */
  function until(t) {
    const s = el('span', 'countdown', mmss(t - serverNow()));
    s.dataset.until = t;
    return s;
  }

  function dieFace(n, cls = 'die') {
    const d = el('span', cls);
    d.setAttribute('role', 'img');
    d.setAttribute('aria-label', `rolled ${n}`);
    for (let i = 0; i < 9; i++) d.append(el('i', PIPS[n] && PIPS[n].includes(i) ? 'on' : ''));
    return d;
  }

  // ------------------------------------------------------------------ elements
  const home = $('#home'), game = $('#game');
  const nameInput = $('#name'), emojiGrid = $('#emoji-grid'), avatarPreview = $('#avatar-preview');
  const photoInput = $('#photo-input'), photoClear = $('#photo-clear'), invited = $('#invited');
  const createBtn = $('#create-btn'), joinForm = $('#join-form'), joinCode = $('#join-code'), joinBtn = $('#join-btn');
  const homeError = $('#home-error');
  const codeText = $('#code-text'), phaseBox = $('#phase-box'), phaseText = $('#phase-text'), timerText = $('#timer-text'), connDot = $('#conn-dot');
  const roleBadge = $('#role-badge'), banners = $('#banners'), bigCount = $('#big-count');
  const mapEl = $('#map'), mapFallback = $('#map-fallback');
  const playerList = $('#player-list'), playerCount = $('#player-count'), myStatus = $('#my-status');
  const hostLobby = $('#host-lobby'), rollBtn = $('#roll-btn'), startBtn = $('#start-btn'), hostHint = $('#host-hint');
  const chatList = $('#chat-list'), chatForm = $('#chat-form'), chatInput = $('#chat-input'), unreadEl = $('#unread');
  const settingsNote = $('#settings-note');
  const hostControls = $('#host-controls'), lockToggle = $('#lock-toggle'), endBtn = $('#end-btn'), lobbyBtn = $('#lobby-btn');
  const shareLocToggle = $('#share-loc-toggle'), geoStatusEl = $('#geo-status'), leaveBtn = $('#leave-btn');
  const overlay = $('#overlay'), overlayBody = $('#overlay-body'), overlayClose = $('#overlay-close');
  const toasts = $('#toasts');

  // ------------------------------------------------------------------ state
  let profile = Object.assign({ name: '', emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)], photo: null }, store.get('mh.profile') || {});
  if (!EMOJIS.includes(profile.emoji)) profile.emoji = EMOJIS[0];

  let session = null;          // {code, pid, token}
  let S = null;                // latest game state from the server
  let clockOffset = 0;
  let es = null, connected = false, disconnectedAt = 0;
  let chat = [], unread = 0, channel = 'all', activeTab = 'group';
  let armedKey = null, armedTimer = null;
  let overlayKind = null, overlayClosable = true;
  let lanOrigin = null;

  let shareLoc = store.get('mh.shareLoc') !== false;
  let geoWatch = null, geoState = 'idle', geoPermission = 'unknown', myPos = null;
  let lastSent = null, lastSentAt = 0, sending = false;

  let map = null, markers = new Map(), accCircle = null, fittedFor = '';
  let wakeLock = null;

  const serverNow = () => Date.now() + clockOffset;
  const me = () => (S ? S.players.find((p) => p.id === S.me) : null);
  const isHost = () => !!(me() && me().host);
  const playing = () => !!S && (S.phase === 'lead' || S.phase === 'chase');
  const activeRunner = (p) => p.role === 'runner' && !p.out;

  // ------------------------------------------------------------------ network
  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (_) {
      const e = new Error('No connection. Check your internet and try again.');
      e.status = 0;
      throw e;
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok || data.ok === false) {
      const e = new Error(data.error || 'Something went wrong. Try again.');
      e.status = res.status;
      throw e;
    }
    return data;
  }

  const authBody = () => ({ code: session.code, pid: session.pid, token: session.token });

  async function act(type, extra = {}, { quiet = false } = {}) {
    if (!session) return null;
    try {
      return await api('/api/action', { ...authBody(), type, ...extra });
    } catch (err) {
      if (err.status === 410) { exitGame('That group has ended or you’re no longer in it.'); return null; }
      if (!quiet) toast(err.message, 'bad');
      return null;
    }
  }

  function mediaUrl(params) {
    const q = new URLSearchParams({ ...authBody(), ...params });
    return `/api/media?${q}`;
  }

  function connect() {
    if (es) es.close();
    const q = new URLSearchParams(authBody());
    es = new EventSource(`/api/stream?${q}`);
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));
    es.addEventListener('state', (e) => onState(JSON.parse(e.data)));
    es.addEventListener('history', (e) => { chat = JSON.parse(e.data); renderChat(); });
    es.addEventListener('chat', (e) => onChat(JSON.parse(e.data)));
    es.addEventListener('kicked', () => exitGame('The host removed you from that group.'));
    es.addEventListener('gone', () => exitGame('That group has ended or expired. Create a new one or join with a code.'));
  }

  function setConnected(on) {
    if (connected && !on) disconnectedAt = Date.now();
    connected = on;
    connDot.classList.toggle('on', on);
    connDot.title = on ? 'Connected' : 'Reconnecting';
    renderBanners();
  }

  // ------------------------------------------------------------------ avatars
  function avatarEl(p, extra = '') {
    const a = el('span', `avatar ${extra}`.trim());
    if (p && p.color) a.style.setProperty('--c', p.color);
    if (p && p.avatar && p.avatar.photo && session) {
      const img = el('img');
      img.alt = '';
      img.decoding = 'async';
      img.width = 96;           // a small, fixed intrinsic size so it never shows up huge
      img.height = 96;
      img.src = mediaUrl({ avatar: p.id, v: p.avatar.photo });
      a.append(img);
    } else if (p && p.avatar && p.avatar.emoji) {
      a.textContent = p.avatar.emoji;
    } else {
      a.textContent = initial(p && p.name);
    }
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  // ------------------------------------------------------------------ home: profile
  function renderProfile() {
    avatarPreview.textContent = '';
    if (profile.photo) {
      const img = el('img');
      img.alt = '';
      img.src = profile.photo;
      avatarPreview.append(img);
    } else {
      avatarPreview.textContent = profile.emoji;
    }
    photoClear.hidden = !profile.photo;
    emojiGrid.textContent = '';
    EMOJIS.forEach((e) => {
      const b = el('button', 'emoji-btn', e);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(!profile.photo && e === profile.emoji));
      b.setAttribute('aria-label', `Avatar ${e}`);
      b.addEventListener('click', () => { profile.emoji = e; profile.photo = null; saveProfile(); renderProfile(); });
      emojiGrid.append(b);
    });
  }

  function saveProfile() {
    profile.name = nameInput.value.trim();
    store.set('mh.profile', profile);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || 'image/')) { reject(new Error('Choose a picture file.')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture couldn’t be opened. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }

  function squareThumb(img, size) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.82);
  }

  function shrinkPhoto(img) {
    for (const [max, q] of [[1280, 0.72], [1024, 0.65], [800, 0.6]]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', q);
      if (url.length < 1300000) return url;
    }
    throw new Error('That photo is too large. Try again.');
  }

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files && photoInput.files[0];
    photoInput.value = '';
    if (!file) return;
    try {
      const img = await loadImage(file);
      profile.photo = squareThumb(img, 192);
      saveProfile();
      renderProfile();
    } catch (err) { homeMessage(err.message); }
  });
  photoClear.addEventListener('click', () => { profile.photo = null; saveProfile(); renderProfile(); });

  function homeMessage(text) {
    homeError.textContent = text || '';
    homeError.hidden = !text;
  }

  function needName() {
    const name = nameInput.value.trim();
    if (!name) { homeMessage('Pick a username first.'); nameInput.focus(); return null; }
    return name;
  }

  const avatarPayload = () => (profile.photo ? { photo: profile.photo } : { emoji: profile.emoji });

  createBtn.addEventListener('click', async () => {
    const name = needName();
    if (!name) return;
    saveProfile();
    homeMessage('');
    createBtn.disabled = true;
    try {
      const r = await api('/api/create', { name, avatar: avatarPayload() });
      enterGame({ code: r.code, pid: r.pid, token: r.token });
      openInvite();
    } catch (err) { homeMessage(err.message); } finally { createBtn.disabled = false; }
  });

  joinCode.addEventListener('input', () => {
    const v = cleanCode(joinCode.value);
    if (v !== joinCode.value) joinCode.value = v;
  });

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = needName();
    if (!name) return;
    const code = cleanCode(joinCode.value);
    if (code.length !== 6) { homeMessage('Group codes have 6 letters and numbers. Ask your host for theirs.'); joinCode.focus(); return; }
    saveProfile();
    homeMessage('');
    joinBtn.disabled = true;
    try {
      const r = await api('/api/join', { code, name, avatar: avatarPayload() });
      enterGame({ code: r.code, pid: r.pid, token: r.token });
    } catch (err) { homeMessage(err.message); } finally { joinBtn.disabled = false; }
  });
  nameInput.addEventListener('change', saveProfile);

  // ------------------------------------------------------------------ enter / exit
  function enterGame(sess) {
    session = sess;
    store.set('mh.session', sess);
    try { history.replaceState(null, '', `/?code=${sess.code}`); } catch (_) { /* ignore */ }
    S = null; chat = []; unread = 0; fittedFor = '';
    home.hidden = true;
    game.hidden = false;
    codeText.textContent = sess.code;
    renderChat();
    renderUnread();
    showTab('group');
    connect();
    shareLocToggle.checked = shareLoc;
    renderGeo();
    loadLeaflet().then(initMap).catch(() => { mapFallback.hidden = false; });
    requestWakeLock();
  }

  function exitGame(message) {
    if (es) { es.close(); es = null; }
    stopGeo(false);
    geoState = 'idle';
    session = null; S = null;
    store.del('mh.session');
    closeOverlay(true);
    if (map) { map.remove(); map = null; }
    markers = new Map(); accCircle = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    try { history.replaceState(null, '', '/'); } catch (_) { /* ignore */ }
    game.hidden = true;
    home.hidden = false;
    invited.hidden = true;
    homeMessage(message || '');
  }

  // ------------------------------------------------------------------ state updates
  function onState(next) {
    const prev = S;
    clockOffset = next.now - Date.now();
    S = next;
    if (prev) announceChanges(prev, next);
    maybePlayRoll(prev, next);
    syncLocation();
    renderAll();
  }

  function announceChanges(prev, next) {
    const pm = prev.players.find((p) => p.id === prev.me);
    const nm = next.players.find((p) => p.id === next.me);
    if (!nm) return;
    if (prev.phase !== next.phase) {
      fittedFor = '';
      if (next.phase === 'lead') {
        toast(nm.role === 'runner' ? 'Run! You have a head start.' : 'Wait here until the countdown ends.', 'beam');
        vibrate([200, 80, 200]);
      } else if (next.phase === 'chase') {
        toast(nm.role === 'catcher' ? 'Go! Start chasing.' : 'The catchers are coming!', 'beam');
        vibrate([300, 100, 300]);
      } else if (next.phase === 'ended') {
        toast(winnerText(next.winner), 'beam');
        vibrate(400);
      } else if (next.phase === 'lobby') toast('Back in the group lobby.');
    } else if (next.phase === 'chase' && prev.revealing !== next.revealing) {
      if (next.revealing) {
        if (nm.role === 'catcher') toast('Runners are on your map now!', 'beam');
        else if (activeRunner(nm)) { toast('Catchers can see you on the map!', 'bad'); vibrate([150, 80, 150, 80, 150]); }
      } else {
        toast(nm.role === 'catcher' ? 'Runners are hidden again.' : 'You’re hidden again.');
      }
    }
    if (pm && !pm.out && nm.out) { toast('You were caught! You’re out of this round.', 'bad'); vibrate(600); }
    if (pm && pm.out && !nm.out) toast('The host brought you back into the game.', 'beam');
    if (pm && !pm.host && nm.host) toast('You’re the host now.');
  }

  const winnerText = (w) => (w === 'catchers' ? 'Catchers win!' : w === 'runners' ? 'Runners win!' : 'Round over.');

  function renderAll() {
    if (!S) return;
    renderTop();
    renderStatus();
    renderPlayers();
    renderSettings();
    renderMap();
    renderBanners();
    renderChannel();
    renderTimers();
  }

  // ------------------------------------------------------------------ top bar & timers
  function renderTop() {
    const m = me();
    playerCount.textContent = String(S.players.length);
    const names = { lobby: 'Group', lead: 'Countdown', chase: S.revealing ? 'Reveal' : 'Chase', ended: 'Round over' };
    phaseText.textContent = names[S.phase] || '';
    phaseBox.classList.toggle('reveal', S.phase === 'chase' && S.revealing);
    if (m && m.role) {
      roleBadge.hidden = false;
      roleBadge.className = `role-badge ${m.out ? 'out' : m.role}`;
      roleBadge.textContent = m.out ? 'Out' : m.role === 'catcher' ? 'Catcher' : 'Runner';
    } else roleBadge.hidden = true;
  }

  function renderTimers() {
    if (!S) return;
    const t = serverNow();
    let text = '';
    if (S.phase === 'lobby') text = `${S.players.length} player${S.players.length === 1 ? '' : 's'}`;
    else if (S.phase === 'lead') text = `catchers go in ${mmss(S.times.leadEndsAt - t)}`;
    else if (S.phase === 'chase') text = S.revealing ? `hidden in ${mmss(S.times.hideAt - t)}` : `reveal in ${mmss(S.times.revealAt - t)}`;
    else if (S.phase === 'ended') text = winnerText(S.winner);
    timerText.textContent = text;
    document.querySelectorAll('[data-until]').forEach((n) => { n.textContent = mmss(Number(n.dataset.until) - t); });
    renderBigCount(t);
  }
  setInterval(renderTimers, 250);

  // Big 10-9-8… countdown over the map for the last 10 seconds before the chase, then GO!
  function renderBigCount(t) {
    let show = '';
    if (S.phase === 'lead') {
      const left = Math.ceil((S.times.leadEndsAt - t) / 1000);
      if (left >= 1 && left <= 10) show = String(left);
    } else if (S.phase === 'chase' && S.times.chaseAt && t - S.times.chaseAt < 2000) {
      show = 'GO!';
    }
    if (!show) { bigCount.hidden = true; bigCount.textContent = ''; return; }
    if (bigCount.textContent !== show) {
      bigCount.textContent = show;
      bigCount.classList.toggle('go', show === 'GO!');
      bigCount.classList.remove('tick');
      void bigCount.offsetWidth; // restart the pop animation for each new number
      bigCount.classList.add('tick');
      if (show !== 'GO!' && Number(show) <= 3) vibrate(60);
    }
    bigCount.hidden = false;
  }

  // ------------------------------------------------------------------ banners
  function banner(cls, ...parts) {
    const b = el('div', `banner ${cls}`);
    parts.forEach((p) => b.append(typeof p === 'string' ? document.createTextNode(p) : p));
    banners.append(b);
    return b;
  }

  function locationNeeded() {
    const m = me();
    return !!(m && m.role && !m.out && S.phase !== 'ended');
  }

  function renderBanners() {
    banners.textContent = '';
    if (!session) return;
    if (!connected && disconnectedAt && Date.now() - disconnectedAt > 2500) banner('', 'Reconnecting…');
    const m = me();
    if (!S || !m) return;

    if (S.phase === 'ended') {
      banner(`big ${S.winner === 'catchers' ? 'catchers' : S.winner === 'runners' ? 'runners' : ''}`, winnerText(S.winner));
      return;
    }
    if (locationNeeded() && (!shareLoc || ['idle', 'off', 'denied', 'unavailable', 'unsupported', 'insecure'].includes(geoState))) {
      const b = el('button', 'banner warn');
      b.type = 'button';
      b.textContent = geoState === 'denied'
        ? 'Location is blocked. Allow it for this site in your browser settings, then tap here.'
        : geoState === 'insecure' ? 'Location needs the https:// version of this site.'
          : 'Location is off. Tap here to turn it on.';
      b.addEventListener('click', turnOnLocation);
      banners.append(b);
    }
    if (m.out && playing()) { banner('', 'You’ve been caught. Follow the round in the chat.'); return; }

    if (S.phase === 'lead') {
      if (m.role === 'runner') banner('warn', 'Run and hide! Catchers start in ', until(S.times.leadEndsAt));
      else banner('info', 'Wait here. You can start chasing in ', until(S.times.leadEndsAt));
    } else if (S.phase === 'chase') {
      if (S.revealing && m.role === 'runner') banner('danger pulse', 'You’re visible on the catchers’ map! Hidden again in ', until(S.times.hideAt));
      else if (S.revealing && m.role === 'catcher') banner('danger', 'Runners are on your map for ', until(S.times.hideAt));
      else if (m.role === 'runner' && S.times.revealAt - serverNow() < 60000) banner('warn', 'Reveal in ', until(S.times.revealAt), '. Find a new spot!');
    }
  }

  // ------------------------------------------------------------------ status card
  function renderStatus() {
    const m = me();
    myStatus.textContent = '';
    if (!m) return;
    myStatus.className = `my-status ${m.out ? 'out' : m.role || ''}`;
    const p = el('p');
    const head = (t) => p.append(el('b', '', t));
    const sub = (...parts) => {
      const s = el('span', 'sub');
      parts.forEach((x) => s.append(typeof x === 'string' ? document.createTextNode(x) : x));
      p.append(s);
    };
    const host = isHost();
    const myRoll = S.roll && S.roll.results.find((r) => r.id === m.id);

    if (S.phase === 'lobby') {
      if (!S.roll) {
        head(host ? 'Invite everyone, then roll the dice.' : 'Waiting for the host to roll the dice.');
        sub('Friends join by scanning the QR code or entering the group code.');
      } else if (!m.role) {
        head('You joined after the dice roll.');
        sub(host ? 'Roll again so you get a role.' : 'The host needs to roll again so you get a role.');
      } else {
        head(`You rolled ${myRoll ? myRoll.die : '?'}: you’re a ${m.role}.`);
        sub(host ? 'Start the round when everyone has location on.' : 'Waiting for the host to start the round.');
      }
    } else if (S.phase === 'lead') {
      if (m.role === 'runner') { head('Run and hide!'); sub('Catchers start in ', until(S.times.leadEndsAt), '.'); } else { head('Wait at the start point.'); sub('You can start chasing in ', until(S.times.leadEndsAt), '.'); }
    } else if (S.phase === 'chase') {
      if (m.out) { head('You’re out.'); sub('You were caught this round. Keep following the chat.'); } else if (m.role === 'catcher') {
        head('Find the runners.');
        if (S.revealing) sub('They’re on your map now for ', until(S.times.hideAt), '. Tap Catch next to a runner you get.');
        else sub('Next reveal in ', until(S.times.revealAt), '. Tap Catch next to a runner you get.');
      } else {
        head('Stay free!');
        if (S.revealing) sub('Catchers can see you for ', until(S.times.hideAt), '.');
        else sub('Next reveal in ', until(S.times.revealAt), '.');
      }
      if (S.times.endsAt) sub('Game ends in ', until(S.times.endsAt), '.');
    } else if (S.phase === 'ended') {
      head(winnerText(S.winner));
      sub(host ? 'Play again to roll new roles.' : 'Waiting for the host to start another round.');
    }
    myStatus.append(p);

    if (S.phase === 'ended' && host) {
      const b = el('button', 'btn btn-beam btn-small', 'Play again');
      b.type = 'button';
      b.addEventListener('click', () => act('lobby'));
      myStatus.append(b);
    }
  }

  // two-step button: first tap arms, second tap confirms (no pop-up dialogs)
  function armButton(key, label, confirmLabel, cls, onConfirm) {
    const armed = armedKey === key;
    const b = el('button', `${cls}${armed ? ' armed' : ''}`, armed ? confirmLabel : label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (armedKey === key) { disarm(); onConfirm(); return; }
      armedKey = key;
      clearTimeout(armedTimer);
      armedTimer = setTimeout(disarm, 3500);
      renderAll();
      renderLeave();
    });
    return b;
  }
  function disarm() {
    armedKey = null;
    clearTimeout(armedTimer);
    renderAll();
    renderLeave();
  }

  // ------------------------------------------------------------------ players
  function arrowIcon(deg) {
    const s = el('span', 'arrow');
    s.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 0l5 13-5-3-5 3z"/></svg>';
    s.style.transform = `rotate(${Math.round(deg)}deg)`;
    return s;
  }

  function roleChip(p) {
    if (!p.role) return el('span', 'role-chip none', 'No role yet');
    if (p.out) return el('span', 'role-chip out', 'Out');
    return el('span', `role-chip ${p.role}`, p.role === 'catcher' ? 'Catcher' : 'Runner');
  }

  function renderPlayers() {
    const m = me();
    if (!m) return;
    const host = isHost();
    const rank = (p) => (p.id === m.id ? 0 : p.role === 'catcher' ? 1 : p.role === 'runner' && !p.out ? 2 : 3);
    const list = [...S.players].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const myFix = myPos && shareLoc ? myPos : null;

    playerList.textContent = '';
    for (const p of list) {
      const li = el('li', `player ${p.role || ''}${p.online ? '' : ' offline'}${p.out ? ' is-out' : ''}`);
      const info = el('div', 'pinfo');
      const nm = el('div', 'pname', p.name);
      if (p.id === m.id) nm.append(el('span', 'tag', ' (you)'));
      if (p.host) nm.append(el('span', 'tag', ' · host'));
      info.append(nm);

      const meta = el('div', 'pmeta');
      const roll = S.phase === 'lobby' && S.roll && S.roll.results.find((r) => r.id === p.id);
      if (roll) meta.append(dieFace(roll.die));
      meta.append(roleChip(p));
      if (!p.online) meta.append(el('span', '', 'offline'));
      if (p.id !== m.id && !p.out) {
        if (p.pos && myFix) {
          const deg = bearing(myFix, p.pos);
          const w = el('span', 'where');
          w.append(arrowIcon(deg), document.createTextNode(`${fmtDist(distanceM(myFix, p.pos))} ${compass(deg)}`));
          meta.append(w);
        } else if (!p.pos && playing() && p.role !== m.role) meta.append(el('span', '', 'hidden'));
      }
      info.append(meta);

      const actions = el('div', 'pactions');
      if (S.phase === 'chase' && m.role === 'catcher' && !m.out && activeRunner(p)) {
        const c = el('button', 'btn btn-danger btn-small', 'Catch');
        c.type = 'button';
        c.addEventListener('click', () => openCatch(p.id));
        actions.append(c);
      }
      if (host && playing() && p.role === 'runner' && p.out) {
        actions.append(armButton(`revive:${p.id}`, 'Bring back', 'Confirm', 'btn btn-line btn-small', () => act('revive', { target: p.id })));
      }
      if (host && p.id !== m.id && S.phase === 'lobby') {
        const k = armButton(`kick:${p.id}`, '×', 'Remove', 'icon-btn', () => act('kick', { target: p.id }));
        k.setAttribute('aria-label', `Remove ${p.name}`);
        actions.append(k);
      }

      li.append(avatarEl(p), info, actions);
      playerList.append(li);
    }

    // host lobby controls
    hostLobby.hidden = !(host && S.phase === 'lobby');
    if (host && S.phase === 'lobby') {
      const n = S.players.length;
      const k = Math.max(1, Math.min(n - 1, S.settings.catchers || autoCatchers(n)));
      rollBtn.textContent = S.roll ? '🎲 Roll again' : '🎲 Roll the dice';
      rollBtn.className = `btn btn-big ${S.roll ? 'btn-line' : 'btn-beam'}`;
      rollBtn.disabled = n < 2;
      startBtn.hidden = !S.roll;
      const missing = S.players.filter((p) => !p.role);
      startBtn.disabled = !!missing.length;
      if (n < 2) hostHint.textContent = 'You need at least 2 players. Show the QR code to your friends.';
      else if (S.roll && missing.length) hostHint.textContent = `${missing.map((p) => p.name).join(', ')} joined after the roll. Roll again so everyone gets a role.`;
      else hostHint.textContent = `Everyone rolls a die. The lowest ${k === 1 ? 'roll becomes the catcher' : `${k} rolls become catchers`}; change how many in Settings.`;
    }
  }

  rollBtn.addEventListener('click', async () => { rollBtn.disabled = true; await act('roll'); rollBtn.disabled = false; });
  startBtn.addEventListener('click', async () => { startBtn.disabled = true; await act('start'); startBtn.disabled = false; });
  $('#invite-btn').addEventListener('click', () => openInvite());
  $('#code-chip').addEventListener('click', () => openInvite());

  // ------------------------------------------------------------------ settings
  function fillSettings() {
    for (const [key, values] of Object.entries(OPTIONS)) {
      const sel = $(`#s-${key}`);
      sel.textContent = '';
      for (const v of values) sel.append(new Option(OPTION_LABEL[key](v), String(v)));
      sel.addEventListener('change', () => act('settings', { [key]: Number(sel.value) }));
    }
  }

  function renderSettings() {
    const host = isHost();
    const editable = host && S.phase === 'lobby';
    const catchersSel = $('#s-catchers');
    catchersSel.options[0].textContent = OPTION_LABEL.catchers(0);
    for (const key of Object.keys(OPTIONS)) {
      const sel = $(`#s-${key}`);
      if (document.activeElement !== sel) sel.value = String(S.settings[key]);
      sel.disabled = !editable;
    }
    settingsNote.textContent = editable ? '' : host ? '(change these in the lobby)' : '(the host sets these)';
    hostControls.hidden = !host;
    lockToggle.checked = !!S.locked;
    endBtn.hidden = !playing();
    lobbyBtn.hidden = S.phase === 'lobby';
  }

  lockToggle.addEventListener('change', () => act('lock', { locked: lockToggle.checked }));
  endBtn.addEventListener('click', () => act('end'));
  lobbyBtn.addEventListener('click', () => act('lobby'));

  function renderLeave() {
    const armed = armedKey === 'leave';
    leaveBtn.textContent = armed ? 'Tap again to leave' : 'Leave group';
    leaveBtn.classList.toggle('armed', armed);
  }
  leaveBtn.addEventListener('click', async () => {
    if (armedKey !== 'leave') {
      armedKey = 'leave';
      clearTimeout(armedTimer);
      armedTimer = setTimeout(disarm, 3500);
      renderLeave();
      return;
    }
    disarm();
    await act('leave', {}, { quiet: true });
    exitGame('You left the group.');
  });

  // ------------------------------------------------------------------ tabs
  function showTab(name) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    ['group', 'chat', 'game'].forEach((n) => { $(`#panel-${n}`).hidden = n !== name; });
    if (name === 'chat') { unread = 0; renderUnread(); scrollChat(true); }
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ------------------------------------------------------------------ overlays
  function openOverlay(kind, nodes, { closable = true } = {}) {
    overlayKind = kind;
    overlayClosable = closable;
    overlayBody.textContent = '';
    nodes.forEach((n) => overlayBody.append(n));
    overlayClose.hidden = !closable;
    overlay.hidden = false;
  }
  function closeOverlay(force) {
    if (!force && !overlayClosable) return;
    overlay.hidden = true;
    overlayKind = null;
    overlayBody.textContent = '';
  }
  overlayClose.addEventListener('click', () => closeOverlay());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeOverlay(); });

  // ---- invite with QR code
  async function inviteOrigin() {
    const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname);
    if (!local) return { origin: location.origin, local: false };
    if (lanOrigin === null) {
      try {
        const r = await fetch('/api/info');
        const d = await r.json();
        lanOrigin = (d.lan && d.lan[0]) || '';
      } catch (_) { lanOrigin = ''; }
    }
    return { origin: lanOrigin || location.origin, local: true, lan: !!lanOrigin };
  }

  async function openInvite() {
    if (!session) return;
    const code = session.code;
    const { origin, local, lan } = await inviteOrigin();
    if (!session || session.code !== code) return;
    const url = `${origin}/?code=${code}`;
    const wrap = el('div', 'ov');
    const title = el('h2', '', 'Invite friends');
    title.id = 'overlay-title';
    wrap.append(title, el('p', '', 'Friends scan this with their phone camera, or enter the code on the home screen.'));
    const qrBox = el('div', 'qr-box');
    try { qrBox.innerHTML = window.QR.toSvg(window.QR.encode(url)); } catch (_) { qrBox.textContent = 'QR code unavailable. Use the code below.'; }
    wrap.append(qrBox, el('div', 'big-code', code));

    const row = el('div', 'actions-row');
    const share = el('button', 'btn btn-beam', 'Share invite');
    share.type = 'button';
    share.addEventListener('click', () => {
      const data = { title: 'Join my Manhunt group', text: `Join my Manhunt group! Code: ${code}`, url };
      if (navigator.share) navigator.share(data).catch(() => {});
      else copy();
    });
    const copyBtn = el('button', 'btn btn-line', 'Copy link');
    copyBtn.type = 'button';
    const link = el('input', 'invite-link');
    link.type = 'text';
    link.readOnly = true;
    link.value = url;
    link.setAttribute('aria-label', 'Invite link');
    function copy() {
      const fallback = () => { link.focus(); link.select(); toast('Link selected. Copy it from the box.'); };
      try { navigator.clipboard.writeText(url).then(() => toast('Invite link copied.'), fallback); } catch (_) { fallback(); }
    }
    copyBtn.addEventListener('click', copy);
    row.append(share, copyBtn);
    wrap.append(row, link);

    if (local && lan) wrap.append(el('p', 'note-warn', 'You’re running this on your computer. Phones on the same Wi-Fi can join with this QR code, but location only works on the online (https) version.'));
    else if (local) wrap.append(el('p', 'note-warn', 'This QR code points to this computer only. Put the game online so friends’ phones can open it.'));

    const done = el('button', 'btn btn-line btn-big', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => closeOverlay());
    wrap.append(done);
    openOverlay('invite', [wrap]);
  }

  // ---- dice roll and role reveal
  function seenRollKey() { return `mh.roll.${session ? session.code : ''}`; }
  function seenRoll() { try { return Number(sessionStorage.getItem(seenRollKey())) || 0; } catch (_) { return 0; } }
  function markRollSeen(seq) { try { sessionStorage.setItem(seenRollKey(), String(seq)); } catch (_) { /* ignore */ } }

  function maybePlayRoll(prev, next) {
    if (!next.roll || next.phase !== 'lobby') return;
    if (next.roll.seq <= seenRoll()) return;
    if (prev && prev.roll && prev.roll.seq === next.roll.seq) return;
    markRollSeen(next.roll.seq);
    const mine = next.roll.results.find((r) => r.id === next.me);
    if (mine) playRoll(next.roll, mine);
  }

  function build3dDie() {
    const scene = el('div', 'dice-scene');
    const cube = el('div', 'die3d');
    for (let f = 1; f <= 6; f++) {
      const face = el('div', `face f${f}`);
      for (let i = 0; i < 9; i++) face.append(el('i', PIPS[f].includes(i) ? 'on' : ''));
      cube.append(face);
    }
    scene.append(cube);
    return { scene, cube };
  }

  function playRoll(roll, mine) {
    const wrap = el('div', 'ov');
    const title = el('h2', '', 'Rolling the dice…');
    title.id = 'overlay-title';
    const { scene, cube } = build3dDie();
    const after = el('div', 'stack');
    after.hidden = true;
    wrap.append(title, scene, after);
    openOverlay('roll', [wrap], { closable: false });
    vibrate([40, 40, 40, 40, 40]);

    const [rx, ry] = DIE_TURN[mine.die];
    const reveal = () => {
      title.textContent = `You rolled ${mine.die}`;
      fillRollResult(after, roll, mine);
      after.hidden = false;
      overlayClosable = true;
      overlayClose.hidden = false;
      vibrate(mine.role === 'catcher' ? [250, 100, 250] : 200);
    };
    if (reducedMotion()) {
      cube.style.transform = `rotateX(${rx - 12}deg) rotateY(${ry + 12}deg)`;
      reveal();
      return;
    }
    void cube.offsetWidth; // lay out the starting angle first so the spin animates
    requestAnimationFrame(() => {
      cube.classList.add('rolling');
      cube.style.transform = `rotateX(${1080 + rx - 12}deg) rotateY(${1440 + ry + 12}deg)`;
    });
    setTimeout(reveal, 2500);
  }

  function fillRollResult(box, roll, mine) {
    box.textContent = '';
    const role = mine.role;
    box.append(el('div', `role-reveal ${role}`, role === 'catcher' ? 'Catcher' : 'Runner'));
    box.append(el('p', '', role === 'catcher'
      ? 'Lowest rolls catch. Wait out the runners’ lead, then chase them down and snap a photo when you catch one.'
      : 'Run and hide when the round starts. Every so often the catchers see you on their map, so keep moving.'));

    // location is requested now that roles are assigned
    const geoBox = el('div', 'stack');
    geoBox.id = 'ov-geo';
    box.append(geoBox);
    renderOverlayGeo();

    const list = el('ul', 'results');
    const players = new Map((S ? S.players : []).map((p) => [p.id, p]));
    [...roll.results].sort((a, b) => a.die - b.die).forEach((r) => {
      const p = players.get(r.id) || { name: '?', id: r.id };
      const li = el('li', r.id === mine.id ? 'me' : '');
      li.append(dieFace(r.die), avatarEl(p, `avatar-sm ${r.role}`), el('span', 'rname', p.name), el('span', `role-chip ${r.role}`, r.role === 'catcher' ? 'Catcher' : 'Runner'));
      list.append(li);
    });
    box.append(list);

    const done = el('button', 'btn btn-line btn-big', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => closeOverlay());
    box.append(done);
  }

  function renderOverlayGeo() {
    const box = document.getElementById('ov-geo');
    if (!box) return;
    box.textContent = '';
    const m = me();
    const runner = !m || m.role !== 'catcher';
    if (geoState === 'on') {
      box.append(el('p', 'hint', 'Location is on. You’re ready.'));
      return;
    }
    box.append(el('p', '', runner
      ? 'Catchers see runners on the map during reveals, so the game needs your location.'
      : 'Turn on location to see yourself on the map next to the runners.'));
    const b = el('button', 'btn btn-beam btn-big', geoState === 'asking' ? 'Waiting for permission…' : 'Turn on location');
    b.type = 'button';
    b.disabled = geoState === 'asking';
    b.addEventListener('click', turnOnLocation);
    box.append(b);
    if (geoState === 'denied') box.append(el('p', 'note-warn', 'Location is blocked. Allow it for this site in your browser’s site settings, then try again.'));
    if (geoState === 'insecure') box.append(el('p', 'note-warn', 'Location only works on the https:// version of this site.'));
  }

  // ---- catch a runner (photo goes to the group chat)
  function openCatch(targetId) {
    const target = S && S.players.find((p) => p.id === targetId);
    if (!target) return;
    let photo = null;
    const wrap = el('div', 'ov');
    const title = el('h2', '', `Catch ${target.name}`);
    title.id = 'overlay-title';
    const av = avatarEl(target, 'avatar-xl runner');
    const msg = el('p', '', `Take a photo of ${target.name} as proof. It’s posted in the group chat and ${target.name} is eliminated.`);
    const input = el('input', 'sr-only');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.id = 'catch-input';
    const take = el('label', 'btn btn-beam btn-big', 'Take a photo');
    take.htmlFor = 'catch-input';
    const preview = el('div', 'catch-preview');
    preview.hidden = true;
    const send = el('button', 'btn btn-danger btn-big', `Send photo & eliminate ${target.name}`);
    send.type = 'button';
    send.hidden = true;
    const err = el('p', 'error');
    err.hidden = true;
    const noPhoto = el('button', 'btn btn-line', 'Catch without a photo');
    noPhoto.type = 'button';
    let npArmed = false, npTimer = null;
    noPhoto.addEventListener('click', () => {
      if (npArmed) { clearTimeout(npTimer); submit(null); return; }
      npArmed = true;
      noPhoto.textContent = `Tap again to eliminate ${target.name}`;
      noPhoto.classList.add('armed');
      npTimer = setTimeout(() => { npArmed = false; noPhoto.textContent = 'Catch without a photo'; noPhoto.classList.remove('armed'); }, 3500);
    });

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      try {
        const img = await loadImage(file);
        photo = shrinkPhoto(img);
        preview.textContent = '';
        const pi = el('img');
        pi.alt = `Photo of ${target.name}`;
        pi.src = photo;
        preview.append(pi);
        preview.hidden = false;
        send.hidden = false;
        take.textContent = 'Retake photo';
        take.className = 'btn btn-line';
        av.hidden = true;
        err.hidden = true;
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    });

    async function submit(data) {
      send.disabled = true;
      noPhoto.disabled = true;
      send.textContent = 'Sending…';
      err.hidden = true;
      try {
        await api('/api/catch', { ...authBody(), target: target.id, photo: data });
        closeOverlay(true);
        toast(`You caught ${target.name}!`, 'beam');
        vibrate([100, 50, 100]);
      } catch (e) {
        if (e.status === 410) { exitGame('That group has ended or you’re no longer in it.'); return; }
        err.textContent = e.message;
        err.hidden = false;
        send.disabled = false;
        noPhoto.disabled = false;
        send.textContent = `Send photo & eliminate ${target.name}`;
      }
    }
    send.addEventListener('click', () => submit(photo));

    const stack = el('div', 'stack');
    stack.append(preview, take, input, send, err, noPhoto);
    wrap.append(title, av, msg, stack);
    openOverlay('catch', [wrap]);
  }

  function openPhoto(url, caption) {
    const wrap = el('div', 'ov lightbox');
    const img = el('img');
    img.src = url;
    img.alt = caption;
    const t = el('p', '', caption);
    t.id = 'overlay-title';
    wrap.append(img, t);
    openOverlay('photo', [wrap]);
  }

  // ------------------------------------------------------------------ chat
  function chatItem(m) {
    const mine = S && m.from === S.me;
    const li = el('li', `msg${m.sys ? ' sys' : ''}${mine ? ' mine' : ''}${m.catch ? ' catch' : ''}`);
    if (m.sys) { li.textContent = m.text; return li; }
    const sender = S && S.players.find((p) => p.id === m.from);
    li.append(avatarEl(sender || { name: m.name, color: m.color }, `avatar-sm ${sender && sender.role ? sender.role : ''}`));
    const head = el('div', 'msg-head');
    const n = el('span', 'msg-name', mine ? 'You' : m.name);
    n.style.setProperty('--c', m.color);
    head.append(n);
    if (m.team) head.append(el('span', `msg-team ${m.team}`, m.team === 'catcher' ? 'Catchers only' : 'Runners only'));
    head.append(el('span', 'msg-time', clock(m.t - clockOffset)));
    const body = el('div', 'msg-body');
    body.append(el('div', 'msg-text', m.text));
    if (m.image && session) {
      const url = mediaUrl({ photo: m.image });
      const b = el('button', 'msg-photo');
      b.type = 'button';
      b.setAttribute('aria-label', 'Open photo');
      const img = el('img');
      img.alt = m.text;
      img.loading = 'lazy';
      img.src = url;
      img.addEventListener('load', () => scrollChat(false));
      b.append(img);
      b.addEventListener('click', () => openPhoto(url, `${m.name}: ${m.text}`));
      body.append(b);
    }
    li.append(head, body);
    return li;
  }

  function renderChat() {
    chatList.textContent = '';
    if (!chat.length) chatList.append(el('li', 'chat-empty', 'No messages yet. Say hi to your group.'));
    chat.forEach((m) => chatList.append(chatItem(m)));
    scrollChat(true);
  }
  function nearBottom() {
    const panel = $('#panel-chat');
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
  }
  function scrollChat(force) {
    const panel = $('#panel-chat');
    if (force || nearBottom()) panel.scrollTop = panel.scrollHeight;
  }
  function onChat(m) {
    const stick = nearBottom();
    chat.push(m);
    if (chat.length > 160) chat.shift();
    const empty = chatList.querySelector('.chat-empty');
    if (empty) empty.remove();
    chatList.append(chatItem(m));
    if (chatList.children.length > 160) chatList.firstElementChild.remove();
    const mine = S && m.from === S.me;
    if (activeTab !== 'chat' && !m.sys && !mine) { unread++; renderUnread(); }
    if (m.catch && S && m.catch !== S.me && !mine) toast(`${m.name} caught someone! See the chat.`);
    if (stick || mine) scrollChat(true);
  }
  function renderUnread() {
    unreadEl.hidden = unread === 0;
    unreadEl.textContent = unread > 99 ? '99+' : String(unread);
  }
  function renderChannel() {
    const m = me();
    const teamBtn = document.querySelector('.channel-btn[data-channel="team"]');
    teamBtn.disabled = !(m && m.role);
    if (teamBtn.disabled && channel === 'team') channel = 'all';
    document.querySelectorAll('.channel-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.channel === channel)));
    const team = m && m.role === 'catcher' ? 'the catchers' : 'the runners';
    chatInput.placeholder = channel === 'team' ? `Message ${team} only` : 'Message everyone';
  }
  document.querySelectorAll('.channel-btn').forEach((b) => b.addEventListener('click', () => { channel = b.dataset.channel; renderChannel(); chatInput.focus(); }));

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    const r = await act('chat', { text, team: channel === 'team' });
    if (!r) chatInput.value = text;
  });

  // ------------------------------------------------------------------ location
  // Location is asked for once roles are given out (after the dice roll).
  function syncLocation() {
    const m = me();
    if (!m) return;
    if (m.out && geoWatch !== null) { stopGeo(false); return; }
    if (locationNeeded() && shareLoc && geoWatch === null && geoPermission === 'granted') startGeo();
  }

  function turnOnLocation() {
    shareLoc = true;
    store.set('mh.shareLoc', true);
    shareLocToggle.checked = true;
    if (geoWatch !== null && geoState !== 'denied') return;
    if (geoWatch !== null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
    startGeo();
  }

  function startGeo() {
    if (geoWatch !== null) return;
    if (!window.isSecureContext) { geoState = 'insecure'; renderGeo(); return; }
    if (!('geolocation' in navigator)) { geoState = 'unsupported'; renderGeo(); return; }
    geoState = 'asking';
    renderGeo();
    geoWatch = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  function stopGeo(tellServer) {
    if (geoWatch !== null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
    myPos = null;
    geoState = 'off';
    if (tellServer) act('noloc', {}, { quiet: true });
    renderGeo();
  }

  function onPosition(p) {
    myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy || 50 };
    const was = geoState;
    geoState = 'on';
    geoPermission = 'granted';
    if (was !== 'on') renderGeo();
    sendPos(false);
    if (S) { renderMap(); renderPlayers(); renderBanners(); }
  }

  function onGeoError(err) {
    if (err.code === 1) { geoState = 'denied'; geoPermission = 'denied'; } else if (err.code === 2) geoState = 'unavailable';
    else if (geoState !== 'on') geoState = 'waiting';
    renderGeo();
    renderBanners();
  }

  async function sendPos(force) {
    if (!session || !shareLoc || !myPos || sending) return;
    const m = me();
    if (m && m.out) return;
    const t = Date.now();
    const moved = lastSent ? distanceM(lastSent, myPos) : Infinity;
    if (!force && t - lastSentAt < 1500) return;
    if (!force && moved < 4 && t - lastSentAt < 8000) return;
    sending = true;
    lastSent = { ...myPos };
    lastSentAt = t;
    await act('loc', myPos, { quiet: true });
    sending = false;
  }
  setInterval(() => sendPos(false), 4000);

  function renderGeo() {
    const msgs = {
      idle: 'Your phone asks for location after the dice roll gives you a role.',
      asking: 'Asking for your location… Tap Allow when your phone asks.',
      waiting: 'Looking for a GPS signal…',
      on: myPos ? `Sharing your location with this group (accurate to about ${Math.round(myPos.acc)} m).` : 'Sharing your location with this group.',
      denied: 'Location is blocked. Allow location for this site in your browser settings, then try again.',
      unavailable: 'Your phone can’t find your location right now. Try moving outside, away from tall buildings.',
      unsupported: 'This browser can’t share location. Try Chrome or Safari.',
      insecure: 'Location only works when the site is opened with https://.',
      off: 'You’re not sharing your location.',
    };
    geoStatusEl.textContent = msgs[geoState] || '';
    renderOverlayGeo();
    if (S) renderBanners();
  }

  shareLocToggle.addEventListener('change', () => {
    shareLoc = shareLocToggle.checked;
    store.set('mh.shareLoc', shareLoc);
    if (shareLoc) startGeo(); else stopGeo(true);
    if (S) renderAll();
  });

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((st) => {
      geoPermission = st.state;
      st.onchange = () => { geoPermission = st.state; if (S) syncLocation(); };
      if (S) syncLocation();
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ map
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    const tryFrom = (base) => new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${base}leaflet.css`;
      document.head.insertBefore(css, document.querySelector('link[href^="/style.css"]'));
      const s = document.createElement('script');
      s.src = `${base}leaflet.js`;
      const timer = setTimeout(() => fail(), 12000);
      function fail() { clearTimeout(timer); css.remove(); s.remove(); reject(new Error('leaflet')); }
      s.onload = () => { clearTimeout(timer); if (window.L) resolve(); else fail(); };
      s.onerror = fail;
      document.head.append(s);
    });
    return LEAFLET_SOURCES.reduce((chain, base) => chain.catch(() => tryFrom(base)), Promise.reject());
  }

  function initMap() {
    if (!window.L || map || !session) return;
    mapFallback.hidden = true;
    map = L.map(mapEl, { zoomControl: false, attributionControl: true, worldCopyJump: true }).setView([20, 10], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      referrerPolicy: 'strict-origin-when-cross-origin', // OpenStreetMap blocks tiles that don't say which site asked
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    setTimeout(() => map && map.invalidateSize(), 50);
    renderMap();
  }

  function makeIcon(p, isMe) {
    const wrap = el('div', `pin ${p.role || ''}${isMe ? ' me' : ''}${p.online ? '' : ' offline'}`);
    wrap.append(avatarEl(p), el('span', 'pin-label', isMe ? 'You' : p.name));
    return L.divIcon({ html: wrap, className: 'mh-icon', iconSize: [40, 40], iconAnchor: [20, 20] });
  }

  function renderMap() {
    if (!map || !S) return;
    const m = me();
    const seen = new Set();
    for (const p of S.players) {
      const isMe = m && p.id === m.id;
      const pos = isMe ? (shareLoc && myPos && !p.out ? myPos : null) : p.pos;
      if (!pos) continue;
      seen.add(p.id);
      const key = [p.name, p.color, p.role, p.online, JSON.stringify(p.avatar), isMe].join('|');
      let mk = markers.get(p.id);
      if (!mk) {
        mk = L.marker([pos.lat, pos.lng], { icon: makeIcon(p, isMe), keyboard: false, zIndexOffset: isMe ? 1000 : 0 }).addTo(map);
        mk._mhKey = key;
        markers.set(p.id, mk);
      } else {
        mk.setLatLng([pos.lat, pos.lng]);
        if (mk._mhKey !== key) { mk.setIcon(makeIcon(p, isMe)); mk._mhKey = key; }
      }
    }
    for (const [id, mk] of markers) if (!seen.has(id)) { mk.remove(); markers.delete(id); }

    if (shareLoc && myPos) {
      if (!accCircle) accCircle = L.circle([myPos.lat, myPos.lng], { radius: myPos.acc, color: '#4cc9f0', weight: 1, opacity: 0.4, fillOpacity: 0.07, interactive: false }).addTo(map);
      else { accCircle.setLatLng([myPos.lat, myPos.lng]); accCircle.setRadius(myPos.acc); }
    } else if (accCircle) { accCircle.remove(); accCircle = null; }

    const fitKey = `${S.phase}:${S.revealing}`;
    if (fittedFor !== fitKey && markers.size) { fittedFor = fitKey; fitAll(); }
  }

  function fitAll() {
    if (!map) return;
    let b = null;
    for (const mk of markers.values()) {
      const ll = mk.getLatLng();
      b = b ? b.extend(ll) : L.latLngBounds(ll, ll);
    }
    if (!b) return;
    const ne = b.getNorthEast(), sw = b.getSouthWest();
    if (ne.lat === sw.lat && ne.lng === sw.lng) map.setView(ne, 17);
    else map.fitBounds(b, { padding: [50, 50], maxZoom: 18 });
  }
  $('#recenter-btn').addEventListener('click', () => { if (map) fitAll(); });
  window.addEventListener('resize', () => { if (map) map.invalidateSize(); });

  // ------------------------------------------------------------------ toasts & wake lock
  function toast(text, kind) {
    const t = el('div', `toast ${kind || ''}`, text);
    t.setAttribute('role', 'status');
    toasts.append(t);
    while (toasts.children.length > 3) toasts.firstElementChild.remove();
    setTimeout(() => t.remove(), 4200);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && session) wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) { /* not allowed here; fine */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session) { requestWakeLock(); sendPos(true); }
  });

  // ------------------------------------------------------------------ boot
  function boot() {
    nameInput.value = profile.name || '';
    renderProfile();
    fillSettings();
    renderChannel();
    renderLeave();
    const urlCode = cleanCode(new URLSearchParams(location.search).get('code'));
    const saved = store.get('mh.session');
    if (saved && saved.code && saved.pid && saved.token && (!urlCode || urlCode === saved.code)) {
      enterGame(saved);
      return;
    }
    if (urlCode) {
      joinCode.value = urlCode;
      invited.textContent = '';
      invited.append(document.createTextNode('You’re invited to group '), el('b', '', urlCode), document.createTextNode('. Set up your profile, then tap Join.'));
      invited.hidden = false;
      joinBtn.className = 'brush-btn';
    }
  }

  boot();
})();
