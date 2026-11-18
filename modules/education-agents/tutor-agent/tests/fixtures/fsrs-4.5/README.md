# FSRS-4.5 golden sequences

`golden.json` holds 54 review sequences (450 reviews) produced by the **reference implementation**
[py-fsrs](https://github.com/open-spaced-repetition/py-fsrs) **2.5.1** (PyPI `fsrs==2.5.1`, MIT).
2.5.1 is the last py-fsrs release that implements FSRS-4.5: it ships the 17 FSRS-4.5 default weights
(`0.4872, 1.4003, 3.7145, 13.8206, …, 2.8755`), `DECAY = -0.5`, `FACTOR = 0.9^(1/DECAY) - 1 = 19/81`.
py-fsrs 3.0.0 switched to FSRS-5 (19 weights). The reference was run in a throw-away venv under the
git-ignored `.data/fsrs-ref/`; it is **not** a dependency of this repository.

`tests/fsrs-golden.unit.test.ts` replays every sequence through `src/domain/fsrs.ts` and requires
stability and difficulty to agree within 1e-9 (relative) and intervals, reps and lapses to be equal.

## What the sequences cover
First review with each grade followed by on-schedule "good" reviews; all-easy and all-hard chains;
lapses and repeated lapses; reviews 3× overdue and 0.3× early; non-whole-day gaps (+7 h, floor
behaviour); same-day reviews (elapsed 0); desired retention 0.8/0.85/0.9/0.95; 40 seeded random
sequences (grades weighted 2:2:5:2, gaps 0–200 days plus 0/5/23 hours).

## Mode
The product has no same-day learning steps, so the generator drives the reference in long-term mode:
after the first review the reference card is put in the `Review` state before each `repeat()`, which is
the reference's own Review-state path (memory-state update, `hard ≤ good < easy` interval ordering,
whole elapsed days). Recorded values are taken from the reference's output, not recomputed.
- First review: the reference schedules only "easy" in days (others enter minute-level learning steps);
  the fixture records the reference `next_interval(S)` for every grade, and the product uses that.
- "Again" in review: the reference enters minute-level relearning (`intervalDays: null`); the product
  schedules the next day. Stability/difficulty after the lapse are the reference values.

## Discrepancies found in the previous implementation (fixed)
Against this fixture the earlier scheduler mismatched stability in 273/450 reviews and intervals in
171/450 (difficulty matched): (1) it used fractional elapsed days (the reference uses whole days);
(2) it clamped post-lapse stability to the previous stability (an FSRS-5 change, not in FSRS-4.5);
(3) it lacked the reference interval ordering (`hard = min(hard, good)`, `good ≥ hard + 1`,
`easy ≥ good + 1`). Intervals now also round half-to-even like the reference.

## Regenerating
```bash
python -m venv .data/fsrs-ref/venv
.data/fsrs-ref/venv/Scripts/python -m pip install --no-deps fsrs==2.5.1     # bin/ on Linux/macOS
.data/fsrs-ref/venv/Scripts/python -I .data/fsrs-ref/gen.py modules/education-agents/tutor-agent/tests/fixtures/fsrs-4.5/golden.json
```
`gen.py` (kept out of the repository with the venv) is reproduced below so the fixture can be rebuilt.

```python
"""
Generate golden FSRS-4.5 review sequences from the reference implementation py-fsrs 2.5.1
(open-spaced-repetition/py-fsrs; last release implementing FSRS-4.5 with 17 default weights;
3.0.0 moved to FSRS-5). Run in an isolated venv:

  python -m venv .data/fsrs-ref/venv
  .data/fsrs-ref/venv/Scripts/python -m pip install --no-deps fsrs==2.5.1
  .data/fsrs-ref/venv/Scripts/python -I .data/fsrs-ref/gen.py <out.json>

Long-term mode: the product has no same-day learning steps, so after the first review every review
is driven through the reference's Review-state path (card.state forced to Review), which is what the
reference does for any card in long-term review. Memory state (S, D) and Review-state intervals come
straight from the reference's `repeat()`.
"""
import json
import random
import sys
from datetime import datetime, timedelta, timezone

import fsrs
from fsrs import FSRS, Card, Rating, State

START = datetime(2026, 1, 5, 9, 0, tzinfo=timezone.utc)


def run_sequence(name, steps, retention=0.9):
    """steps: list of (grade, gap) where gap is a timedelta from the previous review (ignored for the first)."""
    f = FSRS(request_retention=retention)
    card = Card(due=START)
    now = START
    out = []
    for i, (grade, gap) in enumerate(steps):
        if i > 0:
            now = now + gap
            card.state = State.Review  # long-term mode: every later review is a Review-state review
        before_state = card.state
        info = f.repeat(card, now)[Rating(grade)]
        card = info.card
        if before_state == State.New:
            # New-state reference only schedules days for Easy; use the reference next_interval for all
            interval = f.next_interval(card.stability)
            if grade == 4:
                assert interval == card.scheduled_days
        else:
            interval = card.scheduled_days if grade != 1 else None  # Again -> relearning (minutes) in the reference
        out.append({
            "grade": grade,
            "at": now.isoformat().replace("+00:00", "Z"),
            "elapsedDays": card.elapsed_days if before_state != State.New else 0,
            "stability": card.stability,
            "difficulty": card.difficulty,
            "intervalDays": interval,
            "reps": card.reps,
            "lapses": card.lapses,
        })
    return {"name": name, "desiredRetention": retention, "steps": out}


def scheduled_sequence(name, grades, late_factor=1.0, extra_hours=0, retention=0.9):
    """Each review happens `late_factor` x the scheduled interval after the previous one."""
    f = FSRS(request_retention=retention)
    steps = []
    card = Card(due=START)
    now = START
    for i, g in enumerate(grades):
        if i == 0:
            steps.append((g, timedelta(0)))
        else:
            steps.append((g, gap))
            now = now + gap
            card.state = State.Review
        info = f.repeat(card, now)[Rating(g)]
        card = info.card
        sched = card.scheduled_days if card.scheduled_days else f.next_interval(card.stability)
        if g == 1:
            sched = 1
        gap = timedelta(days=max(1, round(sched * late_factor)), hours=extra_hours)
    return run_sequence(name, steps, retention)


def main(path):
    seqs = []
    for g in (1, 2, 3, 4):
        seqs.append(scheduled_sequence(f"first {g} then good x8 on schedule", [g] + [3] * 8))
    seqs.append(scheduled_sequence("all easy x10", [4] * 10))
    seqs.append(scheduled_sequence("all hard x10", [2] * 10))
    seqs.append(scheduled_sequence("good with lapses", [3, 3, 3, 1, 3, 3, 1, 1, 3, 4, 3]))
    seqs.append(scheduled_sequence("repeated lapses", [3, 1, 1, 1, 2, 3, 3]))
    seqs.append(scheduled_sequence("overdue 3x", [3, 3, 3, 3, 2, 3], late_factor=3.0))
    seqs.append(scheduled_sequence("early 0.3x", [3, 3, 3, 4, 3], late_factor=0.3))
    seqs.append(scheduled_sequence("partial days (+7h) floor", [3, 3, 2, 3, 1, 3], extra_hours=7))
    seqs.append(scheduled_sequence("retention 0.85", [3, 3, 4, 2, 1, 3, 3], retention=0.85))
    seqs.append(scheduled_sequence("retention 0.95", [3, 3, 4, 2, 1, 3, 3], retention=0.95))
    seqs.append(run_sequence("same-day reviews", [(3, timedelta(0)), (3, timedelta(hours=2)), (1, timedelta(hours=3)), (3, timedelta(days=1))]))
    rng = random.Random(4_5_2026)
    for k in range(40):
        n = rng.randint(2, 14)
        steps = []
        for i in range(n):
            g = rng.choices([1, 2, 3, 4], weights=[2, 2, 5, 2])[0]
            gap = timedelta(days=rng.choice([0, 1, 1, 2, 3, 5, 8, 13, 21, 40, 90, 200]), hours=rng.choice([0, 0, 5, 23]))
            steps.append((g, gap))
        seqs.append(run_sequence(f"random #{k}", steps, retention=rng.choice([0.9, 0.9, 0.8, 0.85, 0.95])))
    doc = {
        "reference": {"package": "fsrs (py-fsrs)", "version": fsrs.__version__ if hasattr(fsrs, "__version__") else "2.5.1", "algorithm": "FSRS-4.5",
                       "weights": list(FSRS().p.w), "maximumInterval": FSRS().p.maximum_interval, "mode": "long-term (Review-state after first review)"},
        "sequences": seqs,
    }
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write('{"reference": ' + json.dumps(doc["reference"]) + ',\n "sequences": [\n')
        for i, sq in enumerate(seqs):
            fh.write('  {"name": ' + json.dumps(sq["name"]) + ', "desiredRetention": ' + json.dumps(sq["desiredRetention"]) + ', "steps": [\n')
            fh.write(',\n'.join('   ' + json.dumps(st) for st in sq["steps"]))
            fh.write('\n  ]}' + (',' if i < len(seqs) - 1 else '') + '\n')
        fh.write(' ]}\n')
    print(f"wrote {len(seqs)} sequences, {sum(len(s['steps']) for s in seqs)} reviews")


if __name__ == "__main__":
    main(sys.argv[1])
```
