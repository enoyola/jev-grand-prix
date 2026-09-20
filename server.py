"""Jev Grand Prix: the server.

The browser runs the race (physics, drawing, your car). Several times a second it sends
the Jev car's telemetry here. This server turns the numbers into words (Jev reads text
far better than raw numbers), asks Jev three questions in ONE request, and sends back
its answers:

  line      Choice  where across the track to drive: left_edge, left, centre, right, right_edge
  pedals    Choice  full_throttle, part_throttle, coast, brake, hard_brake
  trouble   Noul    is the car about to leave the track?

Jev is the driver's brain (racing line and pedals). The browser's code is the hands: it
turns the wheel 120 times a second to follow the line Jev picked.

Jev has no memory, so the browser also acts as race engineer: it keeps notes on every
corner (grip used, slides, off-tracks) and at the end of each lap sends them to
POST /api/plan, where Jev decides per corner: try one level faster, stay, or back off.

The API key stays here on the server and never reaches the browser.

    uv run server.py        then open http://localhost:8765
"""

from __future__ import annotations

import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from typesafe_sdk import Choice, Noul, TypeSafeClient, TypeSafeError

ROOT = Path(__file__).parent
PORT = int(os.environ.get("PORT", "8765"))
PRICE_PER_MTOK = 0.042  # jev-1.13 input price in USD; output tokens are free
BRAKE_DECEL = 26.0  # m/s², a little under the game's hard braking, so braking advice has margin


# ---------------------------------------------------------------------------------------
# Numbers -> words. Jev is weak at comparing raw numbers, so code does the math and
# describes the result, the way a race engineer would on the radio.
# ---------------------------------------------------------------------------------------


def speed_words(kmh: float) -> str:
    band = (
        "very slow" if kmh < 60 else "slow" if kmh < 110 else "medium" if kmh < 160 else "fast" if kmh < 220 else "very fast"
    )
    return f"{kmh:.0f} km/h ({band})"


def position_words(offset: float, half_width: float, off_track: bool) -> str:
    side = "left" if offset > 0 else "right"
    distance = abs(offset)
    if off_track:
        return f"OFF THE TRACK on the {side} side, on the grass {distance - half_width:.0f} m beyond the edge"
    if distance < 1.5:
        return "on the centre line"
    if distance < half_width * 0.5:
        return f"a little {side} of centre"
    if distance < half_width * 0.8:
        return f"towards the {side} edge of the track"
    return f"right at the {side} edge of the track, about to go off"


def bend_words(radius: float, direction: str) -> str:
    if radius > 400:
        return "straight"
    if radius > 150:
        return f"curving gently to the {direction}"
    if radius > 60:
        return f"curving to the {direction}"
    if radius > 25:
        return f"curving sharply to the {direction}"
    return f"a hairpin to the {direction}"


def corner_words(corner: dict) -> str:
    what = (
        f"{corner['name']}, a {corner['kind']} {corner['dir']} turn (the inside is the {corner['dir']} side; "
        f"target speed about {corner['target_kmh']:.0f} km/h, lap plan: {corner['plan']})"
    )
    if corner["inside"]:
        return f"in {what}; it ends in {corner['remaining_m']:.0f} m"
    return f"{what}, starting in {corner['distance_m']:.0f} m"


def phase_words(corner: dict) -> str:
    name, side = corner["name"], corner["dir"]
    other = "left" if side == "right" else "right"
    return {
        "straight": f"on a straight; {name} is still a long way off",
        "approach": f"approaching {name}, a {side}-hand corner: its outside is the {other} side of the track",
        "turn_in": f"turning in to {name}: its apex (the inside) is on the {side} side",
        "exit": f"past the apex of {name}: the exit runs out toward the {other} side",
    }[corner["phase"]]


def braking_words(kmh: float, corner: dict) -> str:
    v, safe = kmh / 3.6, corner["target_kmh"] / 3.6
    if corner["inside"]:
        if v > safe * 1.12:
            return "in the corner and too fast for it: the car will slide wide"
        if v < safe * 0.8:
            return "in the corner with grip to spare: you can carry more speed"
        return "in the corner at about the right speed"
    if v <= safe + 2:
        return "no braking needed for the next corner"
    needed = (v * v - safe * safe) / (2 * BRAKE_DECEL)
    distance = corner["distance_m"]
    # Each answer takes ~0.3 s to arrive, so the windows are wide enough not to be skipped.
    if distance > needed + 70:
        return "no braking needed yet"
    if distance > needed + 25:
        return "braking point coming up soon"
    if distance >= needed - 5:
        return "at the braking point for the next corner"
    return "past the braking point: too fast for the next corner"


def describe(t: dict) -> dict:
    """The state Jev sees: one short sentence per fact."""
    return {
        "goal": "Drive the car around the circuit as fast as possible without leaving the track.",
        "speed": speed_words(t["speed_kmh"]),
        "position_on_track": position_words(t["offset_m"], t["half_width_m"], t["off_track"]),
        "road_just_ahead": bend_words(t["ahead"]["radius_m"], t["ahead"]["dir"]),
        "next_corner": corner_words(t["corner"]),
        "corner_phase": phase_words(t["corner"]),
        "braking": braking_words(t["speed_kmh"], t["corner"]),
    }


# ---------------------------------------------------------------------------------------
# The questions. All three go to Jev in one request.
# ---------------------------------------------------------------------------------------

QUESTIONS = {
    "line": Choice(
        instructions=(
            "Where across the track should the car aim right now? Drive the racing line: before a corner, move "
            "to the outside; through the corner, aim for the inside (the apex); on the exit, let the car run "
            "back out to the outside. On a straight with no corner close, stay near the centre. "
            "Use `corner_phase`, `next_corner` and `position_on_track`."
        ),
        criteria={
            "left_edge": "Far left: the outside before a right-hand corner, the apex of a left-hand corner, or the exit of a right-hand corner.",
            "left": "Left of centre: moving across toward the left, or a gentler version of the far-left line.",
            "centre": "The middle: on a straight with no corner close, or when the car is off the track or in trouble.",
            "right": "Right of centre: moving across toward the right, or a gentler version of the far-right line.",
            "right_edge": "Far right: the outside before a left-hand corner, the apex of a right-hand corner, or the exit of a left-hand corner.",
        },
    ),
    "pedals": Choice(
        instructions=(
            "Which pedal input should the driver use right now to be as fast as possible while still making the "
            "next corner? Use `speed`, `next_corner` and `braking`."
        ),
        criteria={
            "full_throttle": "Flat out: on straights, leaving a corner, or whenever no braking is needed yet.",
            "part_throttle": "Gentle throttle: holding a steady speed through a corner, or while the car is off the track.",
            "coast": "Off both pedals: shed a little speed just before a corner, or when slightly too fast.",
            "brake": "Firm braking: at the braking point before a corner, or in a corner when a bit too fast.",
            "hard_brake": "Maximum braking: past the braking point and much too fast for the next corner.",
        },
    ),
    "trouble": Noul(instructions="Is the car off the track, or about to leave it within the next second?"),
}


# ---------------------------------------------------------------------------------------
# The race engineer's debrief: one request per lap, one question per corner.
# ---------------------------------------------------------------------------------------

STEP_CRITERIA = {
    "faster": (
        "Go one level faster next lap: the current level was clean and quicker than, or about the same as, "
        "the level below it (or no slower level has been tried), and the next faster level has not gone off "
        "the track here. Not possible when the current level is already the fastest level."
    ),
    "same": (
        "Stay at the current level: it is the quickest clean level so far, and the next faster level was "
        "slower or went off the track here, or the current level is already the fastest level."
    ),
    "slower": (
        "Go one level slower: the car went off the track at the current level, or the current level is "
        "clearly slower than the level below it."
    ),
}


def compare_words(faster: str, slower: str, by_level: dict) -> str | None:
    """Code compares the averages (Jev is weak at comparing numbers) and states the result in words."""
    a, b = by_level.get(faster), by_level.get(slower)
    if not a or not b or not a["clean"] or not b["clean"]:
        return None
    gap = sum(b["clean"]) / len(b["clean"]) - sum(a["clean"]) / len(a["clean"])
    if abs(gap) <= 0.05:
        return f"'{faster}' is about the same as '{slower}'"
    return f"'{faster}' is {abs(gap):.2f} s {'quicker' if gap > 0 else 'slower'} than '{slower}'"


def corner_notes(corner: dict, levels: list[str]) -> str:
    level, history = corner["level"], corner["history"]
    by_level = {}
    for entry in history:
        runs = by_level.setdefault(entry["push"], {"clean": [], "off": []})
        (runs["off"] if entry["off"] else runs["clean"]).append(entry["lap"] if entry["off"] else entry["time"])

    lines = [f"{corner['name']}, a {corner['kind']} {corner['dir']}-hand corner. Current level: '{level}'."]
    for name in levels:
        runs = by_level.get(name)
        if not runs:
            continue
        bits = []
        if runs["clean"]:
            bits.append(f"{sum(runs['clean']) / len(runs['clean']):.2f} s average over {len(runs['clean'])} clean lap(s)")
        if runs["off"]:
            bits.append(f"went OFF the track on lap {', '.join(map(str, runs['off']))}")
        lines.append(f"'{name}': {'; '.join(bits)}.")

    i = levels.index(level)
    if i > 0 and (comparison := compare_words(level, levels[i - 1], by_level)):
        lines.append(comparison + ".")
    if i + 1 == len(levels):
        lines.append(f"'{level}' is already the fastest level.")
    else:
        above = levels[i + 1]
        runs = by_level.get(above)
        if not runs:
            lines.append(f"'{above}' has not been tried here yet.")
        elif runs["off"]:
            lines.append(f"'{above}' went off the track here before.")
        elif comparison := compare_words(above, level, by_level):
            lines.append(comparison + ".")
    last = history[-1]
    lines.append(f"Last lap at '{last['push']}': {'went OFF the track' if last['off'] else 'clean'}.")
    return " ".join(lines)


def plan(body: dict) -> tuple[dict, dict]:
    state = {"task": "After each lap, decide per corner whether to try a faster level, stay, or back off. Goal: the fastest lap without leaving the track."}
    questions = {}
    for corner in body["corners"]:
        key = corner["name"].lower().replace(" ", "_")  # "Turn 4" -> "turn_4"
        state[key] = corner_notes(corner, body["levels"])
        questions[corner["name"]] = Choice(
            instructions=f"Reading the notes in `{key}`, what should the driver do at {corner['name']} on the next lap?",
            criteria=STEP_CRITERIA,
        )
    return state, questions


# ---------------------------------------------------------------------------------------
# HTTP: serve the game from ./web and answer POST /api/decide
# ---------------------------------------------------------------------------------------


def load_key() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and not line.lstrip().startswith("#"):
                os.environ.setdefault(key.strip(), value.strip().strip("'\""))
    if not os.environ.get("TYPESAFE_API_KEY", "").strip():
        sys.exit("TYPESAFE_API_KEY is not set. Put TYPESAFE_API_KEY=... in a .env file next to server.py.")


def decide(jev: TypeSafeClient, telemetry: dict) -> dict:
    state = describe(telemetry)
    start = time.perf_counter()
    r = jev.system_one(state=state, questions=QUESTIONS)
    latency_ms = (time.perf_counter() - start) * 1000
    line, pedals = r.choices["line"], r.choices["pedals"]
    tokens = r.usage.input_tokens or 0
    return {
        "line": line.choice,
        "line_probabilities": line.probabilities,
        "pedals": pedals.choice,
        "pedals_probabilities": pedals.probabilities,
        "confidence": min(line.confidence, pedals.confidence),
        "trouble": r.nouls["trouble"].noul,
        "latency_ms": round(latency_ms),
        "tokens": tokens,
        "cost": tokens * PRICE_PER_MTOK / 1_000_000,
        "model": r.model,
        "state": state,
    }


def plan_lap(jev: TypeSafeClient, body: dict) -> dict:
    state, questions = plan(body)
    start = time.perf_counter()
    r = jev.system_one(state=state, questions=questions)
    tokens = r.usage.input_tokens or 0
    return {
        "steps": {name: answer.choice for name, answer in r.choices.items()},
        "confidence": {name: answer.confidence for name, answer in r.choices.items()},
        "latency_ms": round((time.perf_counter() - start) * 1000),
        "tokens": tokens,
        "cost": tokens * PRICE_PER_MTOK / 1_000_000,
        "state": state,
    }


class Handler(SimpleHTTPRequestHandler):
    jev: TypeSafeClient

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def log_message(self, *args) -> None:  # keep the terminal quiet
        pass

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        routes = {"/api/decide": decide, "/api/plan": plan_lap}
        if self.path not in routes:
            return self.send_json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            self.send_json(200, routes[self.path](self.jev, body))
        except TypeSafeError as error:
            self.send_json(502, {"error": f"TypeSafe: {error}"})
        except (KeyError, TypeError, ValueError) as error:
            self.send_json(400, {"error": f"bad telemetry: {error!r}"})


def main() -> None:
    load_key()
    with TypeSafeClient(timeout=10.0) as jev:
        jev.models.list()  # warm up the connection so the first decision isn't slowed by the handshake
        Handler.jev = jev
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        print(f"Jev Grand Prix running at http://localhost:{PORT}  (Ctrl-C to stop)")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
