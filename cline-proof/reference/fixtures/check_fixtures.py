"""Prep-only helper: confirms each fixture fails the way the demo expects. Not part of the app."""
import json, subprocess, sys, pathlib
for d in sorted(p for p in pathlib.Path(__file__).parent.iterdir() if p.is_dir()):
    spec = json.loads((d / "tests.json").read_text())
    if "build" in spec:
        b = subprocess.run(spec["build"], shell=True, cwd=d, capture_output=True, text=True)
        if b.returncode: print(d.name, "BUILD FAILED", b.stderr); continue
        if b.stderr.strip(): print(f"[{d.name}] compiler says: {b.stderr.strip()}")
    for t in spec["tests"]:
        r = subprocess.run(spec["run"], shell=True, cwd=d, input=t["input"], capture_output=True, text=True, timeout=5)
        got = r.stdout.strip()
        print(f"[{d.name}] {t['name']:15} expected={t['expected']!r:8} got={got!r:8} {'PASS' if got == t['expected'] else 'FAIL'}")
