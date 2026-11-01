'use strict';
/*
 * Plays full rounds with simulated players against the real server.
 * Run with:  npm test
 */
const http = require('http');
const assert = require('assert/strict');
const { server, rooms, revealInfo } = require('../server.js');
const QR = require('../public/qr.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let base = '';
let passed = 0;

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log(`  ✓ ${name}`); });
}

// A real 1x1 JPEG
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

async function post(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const auth = (p) => ({ code: p.code, pid: p.pid, token: p.token });
const action = (p, type, extra = {}) => post('/api/action', { ...auth(p), type, ...extra });
const catchRunner = (p, target, photo) => post('/api/catch', { ...auth(p), target, photo });
const media = (p, params) => fetch(`${base}/api/media?${new URLSearchParams({ ...auth(p), ...params })}`);

// Minimal Server-Sent Events client
function stream(p) {
  const events = [];
  const req = http.get(`${base}/api/stream?${new URLSearchParams(auth(p))}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let type = 'message', data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) events.push({ type, data: JSON.parse(data) });
      }
    });
  });
  req.on('error', () => {});
  return {
    events,
    state() { for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'state') return events[i].data; return null; },
    async waitFor(pred, ms = 4000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const hit = events.find(pred); if (hit) return hit; await sleep(25); }
      throw new Error('timed out waiting for event');
    },
    async waitState(pred, ms = 4000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const s = this.state(); if (s && pred(s)) return s; await sleep(25); }
      throw new Error(`timed out waiting for state; last: ${JSON.stringify(this.state()).slice(0, 400)}`);
    },
    close() { req.destroy(); },
  };
}

const player = (s, id) => s.players.find((x) => x.id === id);
const MIN = 60000;

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log('Manhunt Live game test');

  // ---------------------------------------------------- QR code
  await check('the QR generator makes codes for invite links', () => {
    const qr = QR.encode('https://manhunt-live.onrender.com/?code=K7M2QX');
    assert.ok(qr.size >= 25 && qr.size <= 57);
    assert.match(QR.toSvg(qr), /^<svg[^>]+viewBox/);
  });

  // ---------------------------------------------------- profiles, create & join
  let A, B, C, D;
  await check('host creates a group with an emoji profile picture', async () => {
    const r = await post('/api/create', { name: 'Alice', avatar: { emoji: '🦊' } });
    assert.equal(r.status, 200);
    assert.match(r.body.code, /^[A-HJ-KM-NP-Z2-9]{6}$/);
    A = { ...r.body, name: 'Alice' };
  });
  await check('friends join with the code; one uploads a photo as profile picture', async () => {
    const r1 = await post('/api/join', { name: 'Bob', code: A.code.toLowerCase(), avatar: { photo: JPEG } });
    const r2 = await post('/api/join', { name: ' Cara ', code: ` ${A.code} `, avatar: { emoji: '🐼' } });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r2.status, 200);
    B = { ...r1.body, name: 'Bob' }; C = { ...r2.body, name: 'Cara' };
  });
  await check('a fake image is refused as a profile picture', async () => {
    const r = await post('/api/join', { name: 'Eve', code: A.code, avatar: { photo: 'data:image/png;base64,aGVsbG8gd29ybGQ=' } });
    assert.equal(r.status, 400);
  });
  await check('a wrong code is refused with a clear message', async () => {
    const r = await post('/api/join', { name: 'Eve', code: 'ZZZZZZ' });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /No group found/);
  });

  const sa = stream(A), sb = stream(B), sc = stream(C);
  await sa.waitState((s) => s.players.length === 3 && s.players.every((p) => p.online));

  await check('profile pictures reach the group and only the group', async () => {
    const s = sa.state();
    assert.equal(player(s, A.pid).avatar.emoji, '🦊');
    const v = player(s, B.pid).avatar.photo;
    assert.ok(v);
    const res = await media(C, { avatar: B.pid, v });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    const stranger = await fetch(`${base}/api/media?${new URLSearchParams({ code: A.code, pid: 'nope', token: 'nope', avatar: B.pid })}`);
    assert.notEqual(stranger.status, 200);
  });

  await check('group chat reaches every member', async () => {
    await action(A, 'chat', { text: 'Meet at the gate' });
    await sc.waitFor((e) => e.type === 'chat' && e.data.text === 'Meet at the gate');
    await sb.waitFor((e) => e.type === 'chat' && e.data.text === 'Meet at the gate');
  });

  // ---------------------------------------------------- dice roll
  await check('only the host can roll the dice', async () => {
    assert.equal((await action(B, 'roll')).status, 403);
  });
  await check('team chat isn’t possible before roles are given out', async () => {
    assert.equal((await action(B, 'chat', { text: 'hi team', team: true })).status, 400);
  });
  let catcher, runners;
  await check('the dice roll gives everyone a role; the lowest roll catches', async () => {
    await action(A, 'settings', { catchers: 1 });
    assert.equal((await action(A, 'roll')).status, 200);
    const s = await sa.waitState((s) => s.roll && s.players.every((p) => p.role));
    assert.equal(s.roll.results.length, 3);
    const cs = s.roll.results.filter((r) => r.role === 'catcher');
    const rs = s.roll.results.filter((r) => r.role === 'runner');
    assert.equal(cs.length, 1);
    assert.ok(rs.every((r) => r.die >= cs[0].die));
    assert.ok(s.roll.results.every((r) => r.die >= 1 && r.die <= 6));
    const all = [A, B, C];
    catcher = all.find((p) => p.pid === cs[0].id);
    runners = all.filter((p) => p !== catcher);
    await sb.waitFor((e) => e.type === 'chat' && /Dice rolled/.test(e.data.text));
  });

  await check('someone who joins after the roll blocks the start until the host rolls again', async () => {
    D = { ...(await post('/api/join', { name: 'Dan', code: A.code })).body, name: 'Dan' };
    const r = await action(A, 'start');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Dan joined after the dice roll/);
    await action(A, 'kick', { target: D.pid });
  });

  const streams = { [A.pid]: sa, [B.pid]: sb, [C.pid]: sc };
  const sCatch = () => streams[catcher.pid];
  const sRun = (i) => streams[runners[i].pid];

  // Positions: runner 0 is 30 m from the catcher, runner 1 is ~220 m away.
  const base0 = { lat: 31.5204, lng: 74.3587, acc: 6 };
  await action(catcher, 'loc', base0);
  await action(runners[0], 'loc', { ...base0, lat: base0.lat + 0.00027 });
  await action(runners[1], 'loc', { ...base0, lng: base0.lng + 0.0023 });
  await sa.waitState((s) => s.players.every((p) => p.pos));

  // ---------------------------------------------------- lead
  await check('the round starts with a 10-second countdown for the runners', async () => {
    assert.equal((await action(A, 'start')).status, 200);
    const s = await sa.waitState((s) => s.phase === 'lead');
    const lead = s.times.leadEndsAt - s.times.startedAt;
    assert.equal(lead, 10 * 1000);
  });
  await check('during the lead the catcher can’t see any runner', async () => {
    const s = await sCatch().waitState((s) => s.phase === 'lead');
    runners.forEach((r) => assert.equal(player(s, r.pid).pos, null));
  });
  await check('runners never see the catcher, but see each other', async () => {
    const s = await sRun(0).waitState((s) => s.phase === 'lead');
    assert.equal(player(s, catcher.pid).pos, null);
    assert.ok(player(s, runners[1].pid).pos);
  });
  await check('catching isn’t allowed during the lead', async () => {
    assert.equal((await catchRunner(catcher, runners[0].pid, null)).status, 409);
  });
  await check('nobody new can join once the round has started', async () => {
    assert.equal((await post('/api/join', { name: 'Fay', code: A.code })).status, 409);
  });

  // ---------------------------------------------------- chase: hidden 15 min, shown 5 min
  const room = rooms.get(A.code);
  room.leadEndsAt = Date.now() - 1;
  await check('after the lead the chase starts with runners hidden for 15 minutes', async () => {
    const s = await sCatch().waitState((s) => s.phase === 'chase', 3000);
    assert.equal(s.revealing, false);
    assert.equal(s.times.revealAt - s.times.chaseAt, 15 * MIN);
    assert.equal(s.times.hideAt - s.times.revealAt, 5 * MIN);
    runners.forEach((r) => assert.equal(player(s, r.pid).pos, null));
  });
  await check('reveal windows repeat: 15 minutes hidden, then 5 minutes shown', () => {
    const fake = { phase: 'chase', chaseAt: 0, settings: { hideMin: 15, showMin: 5 } };
    assert.equal(revealInfo(fake, 14 * MIN).revealing, false);
    assert.equal(revealInfo(fake, 15 * MIN).revealing, true);
    assert.equal(revealInfo(fake, 19.9 * MIN).revealing, true);
    assert.equal(revealInfo(fake, 20 * MIN).revealing, false);
    assert.equal(revealInfo(fake, 35 * MIN).revealing, true);
    assert.equal(revealInfo(fake, 20 * MIN).revealAt, 35 * MIN);
  });
  await check('when the reveal starts, the catcher sees the runners live on the map', async () => {
    room.chaseAt = Date.now() - 15 * MIN - 500;
    const s = await sCatch().waitState((s) => s.revealing, 3000);
    runners.forEach((r) => assert.ok(player(s, r.pid).pos));
    await sCatch().waitFor((e) => e.type === 'chat' && /visible on the catchers’ map/.test(e.data.text));
    const moved = { ...base0, lat: base0.lat + 0.0009 };
    await action(runners[1], 'loc', moved);
    await sCatch().waitState((s) => player(s, runners[1].pid).pos && player(s, runners[1].pid).pos.lat === moved.lat);
  });
  await check('the runners still can’t see the catcher during a reveal', async () => {
    assert.equal(player(sRun(0).state(), catcher.pid).pos, null);
  });
  await check('after 5 minutes the runners disappear from the catcher’s map again', async () => {
    room.chaseAt = Date.now() - 20 * MIN - 500;
    const s = await sCatch().waitState((s) => !s.revealing, 3000);
    runners.forEach((r) => assert.equal(player(s, r.pid).pos, null));
    await sCatch().waitFor((e) => e.type === 'chat' && /hidden again/.test(e.data.text));
  });

  // ---------------------------------------------------- catching with a photo
  await check('runners can’t catch', async () => {
    assert.equal((await catchRunner(runners[0], runners[1].pid, null)).status, 403);
  });
  await check('a fake photo is refused', async () => {
    assert.equal((await catchRunner(catcher, runners[0].pid, 'data:image/jpeg;base64,bm90IGEgcGhvdG8=')).status, 400);
  });
  let photoId;
  await check('a catcher sends a photo: it’s posted in the group chat and the runner is eliminated', async () => {
    const r = await catchRunner(catcher, runners[0].pid, JPEG);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const msg = await sRun(1).waitFor((e) => e.type === 'chat' && e.data.catch === runners[0].pid);
    assert.equal(msg.data.text, `Caught ${runners[0].name}!`);
    assert.ok(msg.data.image);
    photoId = msg.data.image;
    await sRun(1).waitFor((e) => e.type === 'chat' && new RegExp(`${runners[0].name} has been eliminated`).test(e.data.text));
    const s = await sa.waitState((s) => player(s, runners[0].pid).out);
    assert.equal(player(s, runners[0].pid).pos, null);
  });
  await check('everyone in the group can open the photo; outsiders can’t', async () => {
    const ok = await media(runners[1], { photo: photoId });
    assert.equal(ok.status, 200);
    assert.ok((await ok.arrayBuffer()).byteLength > 100);
    const bad = await fetch(`${base}/api/media?${new URLSearchParams({ code: A.code, pid: runners[1].pid, token: 'wrong', photo: photoId })}`);
    assert.notEqual(bad.status, 200);
  });
  await check('an eliminated runner can’t be caught twice', async () => {
    await sleep(3100);
    assert.equal((await catchRunner(catcher, runners[0].pid, null)).status, 400);
  });
  await check('the host can bring an eliminated runner back', async () => {
    assert.equal((await action(A, 'revive', { target: runners[0].pid })).status, 200);
    await sa.waitState((s) => !player(s, runners[0].pid).out);
  });
  await check('catching the last runners ends the round: catchers win', async () => {
    assert.equal((await catchRunner(catcher, runners[0].pid, null)).status, 200);
    await sleep(3100);
    assert.equal((await catchRunner(catcher, runners[1].pid, JPEG)).status, 200);
    const s = await sa.waitState((s) => s.phase === 'ended');
    assert.equal(s.winner, 'catchers');
  });
  await check('“Play again” returns to the group lobby, ready for a new dice roll', async () => {
    assert.equal((await action(A, 'lobby')).status, 200);
    const s = await sa.waitState((s) => s.phase === 'lobby');
    assert.equal(s.roll, null);
    assert.ok(s.players.every((p) => p.role === null && !p.out));
  });

  // ---------------------------------------------------- time limit
  await check('if time runs out with runners still free, the runners win', async () => {
    await action(A, 'roll');
    await sa.waitState((s) => s.roll && s.players.every((p) => p.role));
    await action(A, 'start');
    room.leadEndsAt = Date.now() - 1;
    await sa.waitState((s) => s.phase === 'chase', 3000);
    room.endsAt = Date.now() - 1;
    const s = await sa.waitState((s) => s.phase === 'ended', 3000);
    assert.equal(s.winner, 'runners');
    await action(A, 'lobby');
  });

  // ---------------------------------------------------- settings & moderation
  await check('the host can change the timings; made-up values are refused', async () => {
    assert.equal((await action(A, 'settings', { leadSec: 30, hideMin: 10, showMin: 3, gameMin: 0 })).status, 200);
    assert.equal((await action(A, 'settings', { hideMin: 7 })).status, 400);
    assert.equal((await action(B, 'settings', { leadSec: 60 })).status, 403);
    const s = await sa.waitState((s) => s.settings.hideMin === 10);
    assert.equal(s.settings.gameMin, 0);
  });
  await check('a locked group refuses new players', async () => {
    await action(A, 'lock', { locked: true });
    assert.equal((await post('/api/join', { name: 'Gus', code: A.code })).status, 403);
    await action(A, 'lock', { locked: false });
  });
  await check('the host can remove a player, who is told and locked out', async () => {
    assert.equal((await action(A, 'kick', { target: B.pid })).status, 200);
    await sb.waitFor((e) => e.type === 'kicked');
    assert.equal((await action(B, 'chat', { text: 'still here?' })).status, 410);
  });
  await check('when the host leaves, another player becomes host', async () => {
    assert.equal((await action(A, 'leave')).status, 200);
    await sc.waitState((s) => player(s, C.pid).host && s.players.length === 1);
  });

  // ---------------------------------------------------- input safety
  await check('bad input is refused', async () => {
    assert.equal((await action(C, 'loc', { lat: 'x', lng: 5 })).status, 400);
    assert.equal((await action(C, 'nope')).status, 400);
    assert.equal((await action(C, 'chat', { text: '   ' })).status, 400);
    assert.equal((await action({ ...C, token: 'wrong' }, 'chat', { text: 'hi' })).status, 410);
    const big = await post('/api/catch', { ...auth(C), target: C.pid, photo: `data:image/jpeg;base64,${'A'.repeat(2000000)}` });
    assert.equal(big.status, 413);
  });
  await check('the web page and QR script are served; files outside are not', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Manhunt/);
    assert.equal((await fetch(`${base}/qr.js`)).status, 200);
    const res = await new Promise((resolve) => http.get(`${base}/..%2fserver.js`, resolve));
    assert.ok(res.statusCode === 403 || res.statusCode === 404);
  });
  await check('the last player leaving deletes the group, its photos and locations', async () => {
    await action(C, 'leave');
    assert.equal(rooms.has(A.code), false);
  });

  [sa, sb, sc].forEach((s) => s.close());
  server.close();
  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
