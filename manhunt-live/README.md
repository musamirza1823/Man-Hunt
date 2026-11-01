# Manhunt Live

Runners vs catchers in real life, played on phones.

1. **Profile.** Everyone picks a username and a profile picture (take a photo, choose one, or pick an emoji).
2. **Group.** The host taps **Create a group** and gets a **QR code**, an invite link and a 6-character **group code**. Friends scan the QR with their phone camera or type the code.
3. **Dice.** The host taps **Roll the dice**. Every player rolls a die; the lowest rolls become **catchers**, everyone else is a **runner**. The number of catchers is automatic (about one per four players) or set by the host.
4. **Location.** Right after roles are given out, each phone asks for location.
5. **Countdown.** The host starts the round: a **10-second countdown** on every screen while runners run. Catchers wait.
6. **Chase.** Runners are hidden for **15 minutes**, then appear live on the catchers’ map for **5 minutes**. This repeats until the game ends.
7. **Catch.** A catcher who catches a runner taps **Catch**, takes a photo of them, and it’s posted in the **group chat**. That runner is **eliminated**.
8. **Win.** Catchers win when every runner is out. Runners win if anyone is still free when the game time ends.

The host can change the times (lead, hidden, shown, game length), the number of catchers, lock the group, remove someone, bring back a runner who was eliminated by mistake, end a round, and play again.

No database and no extra packages: it runs on plain Node.js. The QR codes are made by the app itself (`public/qr.js`), so they work offline too.

---

## Run it on your computer (Windows)

You need [Node.js](https://nodejs.org) 18 or newer. In **cmd**:

```
node -v
```
If that says "not recognized", install Node, then close and reopen cmd:
```
winget install OpenJS.NodeJS.LTS
```
Go to the folder and start the server:
```
cd %USERPROFILE%\Downloads
tar -xf manhunt-live.zip
cd manhunt-live
npm start
```
You’ll see:
```
Manhunt Live is running on http://localhost:3000
Other devices on your Wi-Fi: http://192.168.x.x:3000
```
Open a **second** cmd window and run `start "" http://localhost:3000`. For a second test player: `start chrome --incognito http://localhost:3000`.

Stop the server with **Ctrl+C**. Run the automatic test with `npm test` (it plays full rounds with fake players: 37 checks).

### About phones and location
- When you run it on your computer, the invite QR uses your computer’s Wi-Fi address, so **phones on the same Wi-Fi can scan it and join** (profile, QR, dice, chat and photos all work).
- **Location needs https.** Phones only share location with secure sites, so the map only works on phones once the game is online (next section). On the computer itself, `http://localhost` is allowed.
- If phones can’t open the Wi-Fi address, Windows Firewall may be blocking Node. Allow it when Windows asks, or allow "Node.js" in Windows Defender Firewall.

---

## Put it online (free) with Render

1. Create a free account on [GitHub](https://github.com) and upload this folder as a new repository.
2. Create a free account on [Render](https://render.com) and sign in with GitHub.
3. In Render choose **New → Blueprint**, pick your repository, and confirm. Render reads `render.yaml` and sets everything up.
   (Or **New → Web Service** with *Build command* `npm install` and *Start command* `npm start`.)
4. Render gives you a link like `https://manhunt-live.onrender.com`. Open it on your phone, create a group, and show friends the QR code.

Good to know about the free plan:
- The server sleeps when nobody has used it for a while, so the first visit can take up to a minute. Open it a few minutes before you play.
- Groups, photos and locations are kept only in the server’s memory. If the server restarts, groups in progress end.
- Run it as **one** server instance only.

---

## Tips for playing

- Keep the app open on screen during the round. Phones pause location for pages in the background.
- Agree on the play area before you start, and play away from roads.
- If a catch photo is posted by mistake, the host can tap **Bring back** next to that runner.

## Privacy and safety

- Locations, profile pictures and catch photos are visible only to members of the same group. Runners never see catchers; catchers see runners only during the 5-minute reveals.
- Nothing is saved to disk. A group, its photos and its locations are deleted when everyone leaves, after 15 minutes with nobody connected, or after 8 hours at most.
- Anyone can turn off **Share my location** in Settings, which removes their position for everyone.
- The host can **lock** a group and remove anyone who shouldn’t be there.
- Ask before taking someone’s photo, and play with an adult who knows where you are.

---

## How the code is organised

| File | What it does |
| --- | --- |
| `server.js` | Game server: groups and codes, profile pictures, dice roll, lead and reveal timers, who-can-see-whom rules, catches with photos, group chat. Live updates use Server-Sent Events. |
| `public/index.html` | The page: landing page (with profile, create and join), game screen, pop-ups. |
| `public/site.js` | Landing page motion: scroll reveals, parallax, scroll progress line. |
| `public/img/` | Original artwork: painted scenes, brush and torn-edge shapes, logo mark. |
| `public/style.css` | The look: dark horror style with blood-red brush strokes, torn edges and engraved headings, built for phones first. |
| `public/app.js` | The phone side: profile picture, QR invite, dice animation, GPS, map (Leaflet + OpenStreetMap), catch camera, chat. |
| `public/qr.js` | A small QR code generator (no outside library). |
| `test/game-test.js` | Automatic test that plays full rounds. |
| `render.yaml` | Settings for hosting on Render. |
