'use strict';
/*
 * Manhunt Live - game server
 *
 * How a round works
 *   1. Everyone picks a name and a profile picture, then creates a group or joins one
 *      with a QR code, an invite link or a 6-character code.
 *   2. The host rolls the dice. Every player rolls a die; the lowest rolls become
 *      catchers, everyone else is a runner.
 *   3. Phones ask for location once roles are given out.
 *   4. The host starts the round: a 10-second countdown gives runners a lead.
 *   5. The chase: runners are hidden for 15 minutes, then shown live on the catchers'
 *      map for 5 minutes, and so on (times can be changed by the host).
 *   6. A catcher who catches a runner sends a photo of them to the group chat and the
 *      runner is eliminated. Catchers win when every runner is out.
 *
 * No database and no npm packages: everything lives in memory and is deleted when a
 * game is empty. Live updates use Server-Sent Events; phones send actions with POST.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- settings

const LIMITS = {
  maxPlayers: 20,
  maxRooms: 200,
  nameLen: 20,
  chatLen: 300,
  chatHistory: 150,
  actionBytes: 4 * 1024,
  joinBytes: 160 * 1024,          // name + profile picture
  catchBytes: 1600 * 1024,        // catch photo
  avatarBytes: 90 * 1024,         // decoded profile picture
  photoBytes: 1100 * 1024,        // decoded catch photo
  photosPerRoom: 60,
  roomImageBytes: 30 * 1024 * 1024,
  streamsPerPlayer: 3,
};

const COLORS = ['#ffb547', '#ff6b8b', '#4cc9f0', '#7ee081', '#b892ff', '#ff8a4c', '#5ee6d0', '#f4e04d', '#ff9ecf', '#9ad1ff'];
const EMOJIS = ['🦊', '🐯', '🐼', '🐸', '🦁', '🐨', '🐙', '🦄', '🐺', '🐵', '🐲', '🦉'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I, L, O, 0, 1

const OPTIONS = {
  catchers: [0, 1, 2, 3, 4, 5, 6],   // 0 = automatic (about one catcher per four players)
  leadSec: [10, 30, 60, 120, 300, 600],
  hideMin: [1, 2, 5, 10, 15, 20, 30],
  showMin: [1, 2, 3, 5, 10],
  gameMin: [0, 20, 30, 45, 60, 90, 120], // 0 = no time limit
};
const DEFAULTS = { catchers: 0, leadSec: 10, hideMin: 15, showMin: 5, gameMin: 60 };

const TIMING = {
  tickMs: 1000,
  broadcastEveryTicks: 2,
  heartbeatMs: 20000,
  resendAfterMs: 10000,
  hostHandoverMs: 120000,
  lobbyDropMs: 5 * 60000,
  roomIdleMs: 15 * 60000,
  roomMaxAgeMs: 8 * 3600000,
};

// ---------------------------------------------------------------- state

/** @type {Map<string, any>} */
const rooms = new Map();
const now = () => Date.now();

function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 6; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no free code');
}
const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function createRoom() {
  const room = {
    code: newCode(),
    createdAt: now(),
    lastActive: now(),
    hostId: null,
    phase: 'lobby',            // lobby | lead | chase | ended
    locked: false,
    settings: { ...DEFAULTS },
    players: new Map(),
    chat: [],
    chatSeq: 0,
    roll: null,                // {seq, at, results: [{id, die, role}]}
    rollSeq: 0,
    startedAt: null,
    leadEndsAt: null,
    chaseAt: null,
    endsAt: null,
    revealing: false,
    winner: null,              // catchers | runners | none
    images: new Map(),         // photo id -> {buf, type}
    imageBytes: 0,
    tick: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function pickColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[crypto.randomInt(COLORS.length)];
}

function addPlayer(room, name, avatar) {
  const p = {
    id: newId(),
    token: newToken(),
    name,
    color: pickColor(room),
    avatar,                    // {emoji} or {buf, type, v}
    role: null,                // runner | catcher | null (before the dice roll)
    out: false,                // eliminated runner
    joinedAt: now(),
    lastSeen: now(),
    pos: null,                 // {lat, lng, acc, t}
    streams: new Set(),
    rate: { chat: [], locAt: 0, catchAt: 0 },
  };
  room.players.set(p.id, p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

// ---------------------------------------------------------------- validation

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
const cleanName = (v) => cleanText(v, LIMITS.nameLen);
const cleanCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : '');

function cleanPos(b) {
  const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.acc);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    acc: Number.isFinite(acc) ? Math.max(0, Math.min(5000, Math.round(acc))) : 50,
    t: now(),
  };
}

/** Accepts a data URL for a JPEG, PNG or WebP image. Returns {buf, type} or throws. */
function decodeImage(dataUrl, maxBytes, what) {
  if (typeof dataUrl !== 'string') throw new GameError(`The ${what} is missing.`);
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new GameError(`The ${what} must be a JPEG, PNG or WebP image.`);
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new GameError(`The ${what} is empty.`);
  if (buf.length > maxBytes) throw new GameError(`The ${what} is too large.`, 413);
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  const type = m[1];
  if ((type === 'image/jpeg' && !isJpeg) || (type === 'image/png' && !isPng) || (type === 'image/webp' && !isWebp)) {
    throw new GameError(`The ${what} isn’t a valid image.`);
  }
  return { buf, type };
}

function cleanAvatar(a) {
  if (a && typeof a === 'object' && typeof a.photo === 'string') {
    const img = decodeImage(a.photo, LIMITS.avatarBytes, 'profile picture');
    return { ...img, v: crypto.randomInt(1e9) };
  }
  if (a && typeof a === 'object' && EMOJIS.includes(a.emoji)) return { emoji: a.emoji };
  return { emoji: EMOJIS[crypto.randomInt(EMOJIS.length)] };
}

// ---------------------------------------------------------------- reveal windows

/** During the chase: hidden for hideMin, then visible for showMin, repeating. */
function revealInfo(room, t = now()) {
  if (room.phase !== 'chase' || room.chaseAt == null) return null;
  const hide = room.settings.hideMin * 60000;
  const cycle = hide + room.settings.showMin * 60000;
  const k = Math.floor(Math.max(0, t - room.chaseAt) / cycle);
  const start = room.chaseAt + k * cycle + hide;
  const end = room.chaseAt + (k + 1) * cycle;
  return { revealing: t >= start, revealAt: start, hideAt: end };
}

// ---------------------------------------------------------------- views

const online = (p) => p.streams.size > 0;
const activeRunner = (p) => p.role === 'runner' && !p.out;

/** May `viewer` see `target`'s position right now? */
function canSee(room, viewer, target) {
  if (viewer === target) return true;
  if (room.phase === 'lobby' || room.phase === 'ended') return true;
  if (viewer.out || target.out) return false;
  if (viewer.role === target.role) return true;                              // teammates
  if (viewer.role === 'catcher' && target.role === 'runner') return room.revealing;
  return false;                                                               // runners never see catchers
}

function avatarView(p) {
  return p.avatar.emoji ? { emoji: p.avatar.emoji } : { photo: p.avatar.v };
}

function viewFor(room, viewer) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      color: p.color,
      avatar: avatarView(p),
      role: p.role,
      out: p.out,
      online: online(p),
      host: p.id === room.hostId,
      pos: canSee(room, viewer, p) && p.pos ? p.pos : null,
    });
  }
  const r = revealInfo(room);
  return {
    code: room.code,
    me: viewer.id,
    phase: room.phase,
    locked: room.locked,
    winner: room.winner,
    settings: room.settings,
    roll: room.roll,
    times: {
      startedAt: room.startedAt,
      leadEndsAt: room.leadEndsAt,
      chaseAt: room.chaseAt,
      endsAt: room.endsAt,
      revealAt: r ? r.revealAt : null,
      hideAt: r ? r.hideAt : null,
    },
    revealing: room.revealing,
    players,
  };
}

// ---------------------------------------------------------------- streaming

function sseSend(stream, event, data) {
  try { stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* closed */ }
}

function pushState(room, force = false) {
  const t = now();
  for (const p of room.players.values()) {
    if (!p.streams.size) continue;
    const view = viewFor(room, p);
    const key = JSON.stringify(view);
    for (const s of p.streams) {
      if (!force && key === s.lastKey && t - s.lastAt < TIMING.resendAfterMs) continue;
      s.lastKey = key;
      s.lastAt = t;
      sseSend(s, 'state', { ...view, now: t });
    }
  }
}

const msgVisibleTo = (msg, p) => !msg.team || msg.team === p.role;

function postChat(room, msg) {
  msg.id = ++room.chatSeq;
  msg.t = now();
  room.chat.push(msg);
  if (room.chat.length > LIMITS.chatHistory) room.chat.splice(0, room.chat.length - LIMITS.chatHistory);
  for (const p of room.players.values()) {
    if (!msgVisibleTo(msg, p)) continue;
    for (const s of p.streams) sseSend(s, 'chat', msg);
  }
}
const system = (room, text) => postChat(room, { sys: true, text });

function closeStreams(p, event) {
  for (const s of p.streams) {
    if (event) sseSend(s, event, {});
    try { s.res.end(); } catch (_) { /* ignore */ }
  }
  p.streams.clear();
}

// ---------------------------------------------------------------- game flow

const minutes = (m) => `${m} minute${m === 1 ? '' : 's'}`;
const seconds = (s) => (s < 60 ? `${s}-second` : `${s / 60}-minute`);
const listNames = (arr) => (arr.length ? arr.map((p) => p.name).join(', ') : 'nobody');

function autoCatchers(n) { return Math.max(1, Math.min(n - 1, Math.round(n / 4))); }

function rollDice(room) {
  const list = [...room.players.values()];
  const n = list.length;
  const want = room.settings.catchers || autoCatchers(n);
  const k = Math.max(1, Math.min(n - 1, want));
  const rolls = list.map((p) => ({ p, die: crypto.randomInt(1, 7), tie: crypto.randomInt(1e9) }));
  rolls.sort((a, b) => a.die - b.die || a.tie - b.tie);           // lowest rolls catch
  rolls.forEach((r, i) => { r.p.role = i < k ? 'catcher' : 'runner'; r.p.out = false; });
  room.roll = {
    seq: ++room.rollSeq,
    at: now(),
    results: rolls.map((r) => ({ id: r.p.id, die: r.die, role: r.p.role })),
  };
  const catchers = rolls.filter((r) => r.p.role === 'catcher').map((r) => r.p);
  const runners = rolls.filter((r) => r.p.role === 'runner').map((r) => r.p);
  system(room, `🎲 Dice rolled! Catchers: ${listNames(catchers)}. Runners: ${listNames(runners)}.`);
}

function clearRoles(room) {
  for (const p of room.players.values()) { p.role = null; p.out = false; }
  room.roll = null;
}

function startRound(room) {
  const t = now();
  room.phase = 'lead';
  room.winner = null;
  room.startedAt = t;
  room.leadEndsAt = t + room.settings.leadSec * 1000;
  room.chaseAt = null;
  room.endsAt = room.settings.gameMin ? room.leadEndsAt + room.settings.gameMin * 60000 : null;
  room.revealing = false;
  system(room, `The round has started! Runners have a ${seconds(room.settings.leadSec)} lead. Catchers, wait for the countdown.`);
}

function endGame(room, winner) {
  room.phase = 'ended';
  room.winner = winner;
  room.revealing = false;
  if (winner === 'catchers') system(room, 'Game over! The catchers caught every runner.');
  else if (winner === 'runners') {
    const left = [...room.players.values()].filter(activeRunner);
    system(room, `Game over! The runners win. Still free: ${listNames(left)}.`);
  } else system(room, 'The host ended the round.');
  pushState(room, true);
}

function checkEnd(room) {
  if (room.phase !== 'lead' && room.phase !== 'chase') return;
  const all = [...room.players.values()];
  if (!all.some(activeRunner)) endGame(room, 'catchers');
  else if (!all.some((p) => p.role === 'catcher')) endGame(room, 'runners');
}

function backToLobby(room) {
  clearRoles(room);
  Object.assign(room, {
    phase: 'lobby', winner: null, startedAt: null, leadEndsAt: null, chaseAt: null, endsAt: null, revealing: false,
  });
  system(room, 'Back in the group lobby. The host can roll the dice for a new round.');
}

function removePlayer(room, p, reason) {
  closeStreams(p, reason === 'kicked' ? 'kicked' : 'gone');
  room.players.delete(p.id);
  if (room.hostId === p.id) {
    const next = [...room.players.values()].sort((a, b) => online(b) - online(a) || a.joinedAt - b.joinedAt)[0];
    room.hostId = next ? next.id : null;
    if (next) system(room, `${next.name} is now the host.`);
  }
  if (reason === 'kicked') system(room, `${p.name} was removed by the host.`);
  else if (reason === 'left') system(room, `${p.name} left the group.`);
  else if (reason === 'idle') system(room, `${p.name} was offline too long and left the group.`);
  if (!room.players.size) { deleteRoom(room); return; }
  if (room.phase === 'lobby' && room.roll) room.roll.results = room.roll.results.filter((r) => r.id !== p.id);
  checkEnd(room);
}

function deleteRoom(room) {
  for (const p of room.players.values()) closeStreams(p, 'gone');
  room.images.clear();
  rooms.delete(room.code);
}

function tickRoom(room, t) {
  if (room.phase === 'lead' && t >= room.leadEndsAt) {
    room.phase = 'chase';
    room.chaseAt = t;
    room.revealing = false;
    const s = room.settings;
    system(room, `Catchers, go! Runners stay hidden for ${minutes(s.hideMin)}, then show on the map for ${minutes(s.showMin)}.`);
    pushState(room, true);
  }
  if (room.phase === 'chase') {
    if (room.endsAt && t >= room.endsAt) { endGame(room, 'runners'); return; }
    const r = revealInfo(room, t);
    if (r.revealing !== room.revealing) {
      room.revealing = r.revealing;
      if (r.revealing) system(room, `📡 Runners are visible on the catchers’ map for the next ${minutes(room.settings.showMin)}!`);
      else system(room, `Runners are hidden again. Next reveal in ${minutes(room.settings.hideMin)}.`);
      pushState(room, true);
    }
  }

  const host = room.players.get(room.hostId);
  if (host && !online(host) && t - host.lastSeen > TIMING.hostHandoverMs) {
    const next = [...room.players.values()].filter(online).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) { room.hostId = next.id; system(room, `${next.name} is now the host.`); }
  }

  if (room.phase === 'lobby') {
    for (const p of [...room.players.values()]) {
      if (!online(p) && t - p.lastSeen > TIMING.lobbyDropMs) removePlayer(room, p, 'idle');
      if (!rooms.has(room.code)) return;
    }
  }

  const anyOnline = [...room.players.values()].some(online);
  if (anyOnline) room.lastActive = t;
  if ((!anyOnline && t - room.lastActive > TIMING.roomIdleMs) || t - room.createdAt > TIMING.roomMaxAgeMs) {
    deleteRoom(room);
    return;
  }

  room.tick++;
  if (room.tick % TIMING.broadcastEveryTicks === 0) pushState(room);
}

setInterval(() => {
  const t = now();
  for (const room of [...rooms.values()]) {
    try { tickRoom(room, t); } catch (err) { console.error('tick error', room.code, err); }
  }
}, TIMING.tickMs).unref();

setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      for (const s of p.streams) { try { s.res.write(': keep-alive\n\n'); } catch (_) { /* ignore */ } }
    }
  }
}, TIMING.heartbeatMs).unref();

// ---------------------------------------------------------------- rate limits

const ipHits = new Map();
function ipAllowed(ip, limit = 40, windowMs = 10 * 60000) {
  const t = now();
  const list = (ipHits.get(ip) || []).filter((x) => t - x < windowMs);
  if (list.length >= limit) { ipHits.set(ip, list); return false; }
  list.push(t);
  ipHits.set(ip, list);
  return true;
}
setInterval(() => {
  const t = now();
  for (const [ip, list] of ipHits) if (!list.some((x) => t - x < 10 * 60000)) ipHits.delete(ip);
}, 60000).unref();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------- actions

class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function requireHost(room, p) { if (room.hostId !== p.id) throw new GameError('Only the host can do that.', 403); }
function requirePhase(room, ...phases) {
  if (!phases.includes(room.phase)) throw new GameError('That can’t be done at this point in the game.', 409);
}
function findTarget(room, id) {
  const t = room.players.get(typeof id === 'string' ? id : '');
  if (!t) throw new GameError('That player isn’t in this group anymore.', 404);
  return t;
}

const actions = {
  loc(room, p, b) {
    const t = now();
    if (t - p.rate.locAt < 800) return {};
    const pos = cleanPos(b);
    if (!pos) throw new GameError('That location doesn’t look right.');
    p.rate.locAt = t;
    p.pos = pos;
    return {};
  },

  noloc(room, p) {
    p.pos = null;
    pushState(room, true);
    return {};
  },

  chat(room, p, b) {
    const text = cleanText(b.text, LIMITS.chatLen);
    if (!text) throw new GameError('Type a message first.');
    if (b.team && !p.role) throw new GameError('You don’t have a team yet. Wait for the dice roll.');
    const t = now();
    p.rate.chat = p.rate.chat.filter((x) => t - x < 10000);
    if (p.rate.chat.length >= 6) throw new GameError('You’re sending messages too fast. Wait a few seconds.', 429);
    p.rate.chat.push(t);
    postChat(room, { from: p.id, name: p.name, color: p.color, text, team: b.team ? p.role : null });
    return {};
  },

  settings(room, p, b) {
    requireHost(room, p);
    requirePhase(room, 'lobby');
    for (const [key, allowed] of Object.entries(OPTIONS)) {
      if (b[key] === undefined) continue;
      const v = Number(b[key]);
      if (!allowed.includes(v)) throw new GameError('That setting isn’t available.');
      room.settings[key] = v;
    }
    pushState(room, true);
    return {};
  },

  roll(room, p) {
    requireHost(room, p);
    requirePhase(room, 'lobby');
    if (room.players.size < 2) throw new GameError('You need at least 2 players. Share the QR code or the group code.');
    rollDice(room);
    pushState(room, true);
    return {};
  },

  start(room, p) {
    requireHost(room, p);
    requirePhase(room, 'lobby');
    const list = [...room.players.values()];
    if (list.length < 2) throw new GameError('You need at least 2 players. Share the QR code or the group code.');
    const noRole = list.filter((x) => !x.role);
    if (noRole.length) throw new GameError(`${listNames(noRole)} joined after the dice roll. Roll again so everyone gets a role.`);
    if (!list.some((x) => x.role === 'catcher') || !list.some((x) => x.role === 'runner')) {
      throw new GameError('Roll the dice so there is at least one catcher and one runner.');
    }
    startRound(room);
    pushState(room, true);
    return {};
  },

  revive(room, p, b) {
    requireHost(room, p);
    requirePhase(room, 'lead', 'chase');
    const target = findTarget(room, b.target);
    if (target.role !== 'runner' || !target.out) throw new GameError(`${target.name} isn’t eliminated.`);
    target.out = false;
    system(room, `The host brought ${target.name} back into the game.`);
    pushState(room, true);
    return {};
  },

  lock(room, p, b) {
    requireHost(room, p);
    room.locked = !!b.locked;
    system(room, room.locked ? 'The host locked the group. No one new can join.' : 'The host unlocked the group. Friends can join again.');
    pushState(room, true);
    return {};
  },

  kick(room, p, b) {
    requireHost(room, p);
    const target = findTarget(room, b.target);
    if (target === p) throw new GameError('You can’t remove yourself. Use Leave group instead.');
    removePlayer(room, target, 'kicked');
    pushState(room, true);
    return {};
  },

  end(room, p) {
    requireHost(room, p);
    requirePhase(room, 'lead', 'chase');
    endGame(room, 'none');
    return {};
  },

  lobby(room, p) {
    requireHost(room, p);
    requirePhase(room, 'ended', 'lead', 'chase');
    backToLobby(room);
    pushState(room, true);
    return {};
  },

  leave(room, p) {
    removePlayer(room, p, 'left');
    if (rooms.has(room.code)) pushState(room, true);
    return {};
  },
};

/** A catcher caught a runner: optional photo goes to the group chat, the runner is out. */
function catchRunner(room, p, b) {
  requirePhase(room, 'chase');
  if (p.role !== 'catcher') throw new GameError('Only catchers can catch runners.', 403);
  const target = findTarget(room, b.target);
  if (!activeRunner(target)) throw new GameError(`${target.name} isn’t a runner who is still in the game.`);
  const t = now();
  if (t - p.rate.catchAt < 3000) throw new GameError('Wait a moment before catching again.', 429);

  let imageId = null;
  if (b.photo) {
    const img = decodeImage(b.photo, LIMITS.photoBytes, 'photo');
    if (room.images.size >= LIMITS.photosPerRoom || room.imageBytes + img.buf.length > LIMITS.roomImageBytes) {
      throw new GameError('This group can’t store more photos. Catch without a photo instead.', 507);
    }
    imageId = newId();
    room.images.set(imageId, img);
    room.imageBytes += img.buf.length;
  }
  p.rate.catchAt = t;
  target.out = true;
  target.pos = null;
  postChat(room, {
    from: p.id, name: p.name, color: p.color,
    text: `Caught ${target.name}!`,
    image: imageId,
    catch: target.id,
  });
  const left = [...room.players.values()].filter(activeRunner).length;
  system(room, `${target.name} has been eliminated. ${left} runner${left === 1 ? '' : 's'} left.`);
  checkEnd(room);
  pushState(room, true);
  return {};
}

// ---------------------------------------------------------------- http helpers

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',   // OpenStreetMap requires the site address on map requests
  'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function sendJson(res, status, obj) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        chunks = null;                                   // stop keeping it, but let the upload finish
        if (size > limit * 4) req.destroy();             // so the phone gets a clear answer
        return;
      }
      if (chunks) chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks) { reject(new GameError('That upload is too large. Try a smaller photo.', 413)); return; }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch (_) { reject(new GameError('That request wasn’t valid.')); }
    });
    req.on('error', reject);
  });
}

function auth(code, pid, token) {
  const room = rooms.get(cleanCode(code || ''));
  const p = room && room.players.get(typeof pid === 'string' ? pid : '');
  if (!room || !p || !safeEqual(token, p.token)) throw new GameError('This game has ended or you’re no longer in it.', 410);
  return { room, p };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (_) { res.writeHead(400); res.end(); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const cache = type.startsWith('image/') ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': cache });
    res.end(data);
  });
}

/** Addresses other phones on the same Wi-Fi can use to reach this computer. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ---------------------------------------------------------------- routes

function openStream(req, res, url) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let room, p;
  try { ({ room, p } = auth(url.searchParams.get('code'), url.searchParams.get('pid'), url.searchParams.get('token') || '')); } catch (_) {
    res.write('event: gone\ndata: {}\n\n');
    res.end();
    return;
  }
  if (p.streams.size >= LIMITS.streamsPerPlayer) {
    const oldest = p.streams.values().next().value;
    try { oldest.res.end(); } catch (_) { /* ignore */ }
    p.streams.delete(oldest);
  }
  const stream = { res, lastKey: '', lastAt: 0 };
  p.streams.add(stream);
  p.lastSeen = now();
  room.lastActive = now();

  sseSend(stream, 'history', room.chat.filter((m) => msgVisibleTo(m, p)));
  pushState(room, true);

  req.on('close', () => {
    p.streams.delete(stream);
    p.lastSeen = now();
    if (rooms.has(room.code)) pushState(room);
  });
}

/** Profile pictures and catch photos, only for players in the same group. */
function serveMedia(req, res, url) {
  try {
    const { room } = auth(url.searchParams.get('code'), url.searchParams.get('pid'), url.searchParams.get('token') || '');
    let img = null;
    const avatarOf = url.searchParams.get('avatar');
    const photo = url.searchParams.get('photo');
    if (avatarOf) {
      const owner = room.players.get(avatarOf);
      if (owner && owner.avatar.buf) img = owner.avatar;
    } else if (photo) img = room.images.get(photo) || null;
    if (!img) throw new GameError('Not found.', 404);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': img.type,
      'Content-Length': img.buf.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(img.buf);
  } catch (err) {
    res.writeHead(err.status || 404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  try {
    if (url.pathname === '/api/create') {
      if (!ipAllowed(ip)) throw new GameError('Too many groups from this connection. Try again in a few minutes.', 429);
      const b = await readJson(req, LIMITS.joinBytes);
      const name = cleanName(b.name);
      if (!name) throw new GameError('Enter your name first.');
      if (rooms.size >= LIMITS.maxRooms) throw new GameError('The server is full right now. Try again later.', 503);
      const avatar = cleanAvatar(b.avatar);
      const room = createRoom();
      const p = addPlayer(room, name, avatar);
      system(room, `${p.name} created the group. Friends can scan the QR code or enter code ${room.code}.`);
      return sendJson(res, 200, { ok: true, code: room.code, pid: p.id, token: p.token });
    }

    if (url.pathname === '/api/join') {
      if (!ipAllowed(ip)) throw new GameError('Too many tries from this connection. Wait a few minutes and try again.', 429);
      const b = await readJson(req, LIMITS.joinBytes);
      const name = cleanName(b.name);
      const code = cleanCode(b.code);
      if (!name) throw new GameError('Enter your name first.');
      if (code.length !== 6) throw new GameError('Group codes have 6 letters and numbers.');
      const room = rooms.get(code);
      if (!room) throw new GameError(`No group found with code ${code}. Check the code with your host.`, 404);
      if (room.locked) throw new GameError('The host has locked this group.', 403);
      if (room.phase !== 'lobby') throw new GameError('This round has already started. Ask the host to go back to the lobby, then join.', 409);
      if (room.players.size >= LIMITS.maxPlayers) throw new GameError(`This group is full (${LIMITS.maxPlayers} players).`, 409);
      const avatar = cleanAvatar(b.avatar);
      const p = addPlayer(room, name, avatar);
      system(room, room.roll ? `${p.name} joined the group. Roll the dice again so ${p.name} gets a role.` : `${p.name} joined the group.`);
      pushState(room, true);
      return sendJson(res, 200, { ok: true, code: room.code, pid: p.id, token: p.token });
    }

    if (url.pathname === '/api/catch') {
      const b = await readJson(req, LIMITS.catchBytes);
      const { room, p } = auth(b.code, b.pid, b.token);
      p.lastSeen = now();
      return sendJson(res, 200, { ok: true, ...catchRunner(room, p, b) });
    }

    if (url.pathname === '/api/action') {
      const b = await readJson(req, LIMITS.actionBytes);
      const { room, p } = auth(b.code, b.pid, b.token);
      const fn = Object.prototype.hasOwnProperty.call(actions, b.type) ? actions[b.type] : null;
      if (!fn) throw new GameError('Unknown action.');
      p.lastSeen = now();
      return sendJson(res, 200, { ok: true, ...(fn(room, p, b) || {}) });
    }

    throw new GameError('Not found.', 404);
  } catch (err) {
    if (err instanceof GameError) return sendJson(res, err.status, { ok: false, error: err.message });
    console.error(err);
    return sendJson(res, 500, { ok: false, error: 'Something went wrong on the server. Try again.' });
  }
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400); res.end(); return; }

  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size });
  if (url.pathname === '/api/info' && req.method === 'GET') {
    const port = server.address() ? server.address().port : PORT;
    return sendJson(res, 200, { ok: true, lan: lanAddresses().map((a) => `http://${a}:${port}`) });
  }
  if (url.pathname === '/api/stream' && req.method === 'GET') return openStream(req, res, url);
  if (url.pathname === '/api/media' && req.method === 'GET') return serveMedia(req, res, url);
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST.' });
    return handleApi(req, res, url);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  return serveStatic(req, res, url.pathname);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Manhunt Live is running on http://localhost:${PORT}`);
    for (const a of lanAddresses()) console.log(`Other devices on your Wi-Fi: http://${a}:${PORT}`);
  });
}

module.exports = { server, rooms, TIMING, revealInfo };
