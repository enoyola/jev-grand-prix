# Jev Grand Prix 🏁

A racing game where TypeSafe's **Jev** drives an F1 car live, and you can race it.

```bash
uv run server.py
```

Then open **http://localhost:8765** and press **Start race**. Tick *Race Jev yourself* to
drive your own car with the arrow keys (`C` switches the camera). The default 8 laps lets you watch the race engineer find the limit of every corner.

## How it works: Jev is the brain, code is the body

```
browser (120×/s)                          server.py                      Jev
car physics, your car, drawing   ──►   numbers → words   ──►   3 questions, 1 request
      ▲                                                                  │
      └──────── racing line + pedals + "trouble?" (~0.27 s) ◄────────────┘
```

Several times a second, the game sends the Jev car's telemetry to the server. The server
turns it into the words a race engineer would use ("176 km/h, towards the left edge,
past the apex of Turn 2: the exit runs out toward the left side, at the right speed")
and asks Jev three questions in one request:

| Question | Type | Options |
| --- | --- | --- |
| Where across the track should the car aim? | `Choice` | far left · left · centre · right · far right |
| Which pedal? | `Choice` | full throttle · part throttle · coast · brake · hard brake |
| Is the car about to leave the track? | `Noul` | probability (the "Trouble?" meter) |

**Jev decides** the racing line and when to brake or accelerate. **Code does** what a
driver's hands and the car's electronics do: it steers toward the chosen line 120 times a
second, and "brake-by-wire" stops braking once the car reaches the corner's speed.

Why the split: an answer takes about 0.27 s to arrive, and at 250 km/h the car travels
about 19 m in that time. When Jev steered the wheel directly, the car weaved and left
the track (9 off-tracks in the first test lap). With Jev choosing the line instead, it
drives clean laps. This is the same pattern as the Pokémon and Minecraft bots: Jev picks
the goal, code executes it.

## The race engineer: making Jev improve lap after lap

Jev has no memory, and it never changes while you play. So the **code remembers** for it:

1. During each lap, the code times every corner (braking zone + corner) and notes any off-tracks.
2. At the line, the code turns the notes into sentences and does the comparisons itself
   ("'push' is 0.24 s quicker than 'normal'; 'attack' has not been tried here yet").
3. One request, one question per corner: go one level **faster**, stay the **same**, or go **slower**.
4. The code moves each corner one step along a ladder of target speeds, named by percentage of
   the grip limit the code *calculates* from the centre line: `80% 87% 94% 100% 106% 112% 118% 124% 130%`.
   Every corner starts at 100%, the formula's "limit".

Why go above 100%? The formula assumes the car follows the centre line, but Jev drives a
racing line that uses the whole track, which makes corners gentler. A code-only test driver
(same physics, no API calls) showed the real edge: clean laps up to 118% (50.4 s), then
off-tracks from 124% (Turn 2 first).

The *Race engineer* panel shows each corner's history, last sector time, and the next-lap plan.

**Test run (8 laps, real Jev, starting at 100%):**

| Lap | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Time (s) | 59.2* | 55.5 | 53.6 | 52.9 | 52.9 | 51.7 | 52.5 | **50.9** |

\* standing start, worth about 3 s.

What Jev found, corner by corner (target level per lap, ✗ = went off):

```
T1   100 106 112 118 124 130✗ 124 124    edge between 124% and 130%
T2   100 106 112 118 124✗ 118 118 118    edge at 124%, same as the code test driver found
T5   100 106 112 118 124 130 130 130     clean all the way to the top of the ladder
T7   100 106 100 100 ...                 106% was slower here, so it stayed at 100%
T8   100 100 106 112 118 124 130✗ 124    edge between 124% and 130%
```

About 5 s gained from learning (plus ~3 s from the flying start), 3 off-tracks while
searching for the edges, $0.06 for the whole run.

What didn't work first (useful lessons):
- Telling Jev about brief **slides** made it back off too much. Sector time is the honest signal.
- Overlapping option descriptions ("normal: if it's the fastest so far" was *always* true after
  lap 1) made Jev stick to "normal". Clear, non-overlapping options fixed it. TypeSafe lists
  contradictory criteria as a known weak spot.
- A level named "maximum" (118%) made Jev refuse to go faster: it read the word literally as
  "the top". Naming levels by percentage fixed it (and made the plans easier to read).

## Test results before the engineer (real Jev, jev-1.13)

| | First version (Jev steering directly) | Jev picks line + pedals |
| --- | --- | --- |
| Lap | DNF: 9 off-tracks, 1 crash | **61.1 s, then 58.3 s** |
| Mistakes | 9 off / 1 crash | **0 off / 0 crashes** |
| Corner speeds | far below what's possible | within ~1–2 km/h of each corner's limit |

It chose textbook racing lines, for example Turn 4 (left hairpin): outside (right) on
approach, apex (left) through the corner, back out right on exit.

About 3.5 decisions per second, ~0.27 s each, **~$0.009 per lap** (~$0.05 for a 5-lap
race). The panel shows the running cost.

## Safety for your wallet

- The race pauses automatically when the tab is hidden.
- Every race stops at 10 minutes.
- The API key stays in `.env` on the server; the browser never sees it.

## Ideas to take it further

- **Race engineer mode:** tyre wear, rain and pit stops, with Jev making strategy calls.
- **Ghost car** of Jev's best lap.
- **Trace the real Monza or Interlagos** layout into `CONTROL` in `web/game.js`.
- Film Jev vs you for your channel. The "What Jev sees" panel explains every decision on screen.

Files: `server.py` (numbers → words, the questions, the API call) · `web/game.js`
(track, physics, auto-steer, drawing, the decision loop) · `web/index.html`, `web/style.css`.
