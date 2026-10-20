# Shadow Harbor

Online hidden-movement chase game for 2–6 players, played on a 3D board. One random player is the Shadow;
everyone else is a detective. Runs in any phone or desktop browser. Empty seats can be filled with computer players.

## Run it on your computer
    npm install
    npm start
Open http://localhost:3000. For phones on the same Wi-Fi, use http://YOUR-COMPUTER-IP:3000.

## Put it online (so your PC doesn't need to run it)
1. Push this folder to a GitHub repository (`node_modules` is ignored).
2. On https://render.com choose New → Blueprint (or Web Service) and pick the repo. `render.yaml` already
   sets build `npm install` and start `npm start`.
3. Render gives you a public https link. Share it; anyone can create a room and join with the 4-letter code.
Railway or Fly.io work the same way. Free Render services sleep after ~15 minutes idle, so the first load
can take about a minute. Game rooms live in server memory and are lost on a restart or redeploy.

## Computer players
In the lobby the host taps "+ Add computer player" (✕ removes one). Two people plus two computers makes a 4-player game.
Computers only use information a human has: detective bots track where the Shadow could be from its ticket trail and
the stations where it surfaced; the Shadow bot sees the detectives' positions like everyone else.

## Files
- server.js  — rooms, rules, turn order, hidden information, computer players
- map.js     — generates the original city map (change the seed in buildMap() for a different board)
- public/    — the game screen (index.html + app.js, 3D with three.js in public/vendor/)

## Easy tweaks (server.js)
- TOTAL_MOVES / REVEALS: game length and when the Shadow surfaces
- detective tickets in startGame(): { walk: 10, bus: 8, tram: 4 }
- BOT_DELAY_MS (environment variable): how long computer players pause before moving (default 900)
