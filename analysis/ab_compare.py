#!/usr/bin/env python3
"""Paired A/B comparison of two templates on the SAME task, N times.

Phase 2 acceptance needs paired evidence, not a single run (v0.2 §11.3: one trace
is weak; report medians over paired runs). For each of N pairs this:
  1. resets the sandbox git repo to its initial (buggy) state,
  2. runs template A, records billed tokens / cost / pass,
  3. resets again,
  4. runs template B, records the same,
and finally reports per-arm medians and the paired deltas.

"Billed tokens" = sum over attempts of input+output tokens from the wea.trace/v1
cost field — the same number validate_ir.py budgets against. "Pass" = trace
status == success AND the sandbox test command exits 0 afterwards.

Usage:
  python analysis/ab_compare.py \
    --a t3-complex --b "t3-complex@1.0.1" \
    --repo /tmp/wea-sandbox2 --test "node test.js" \
    --task "..." --n 3 --out runner/runs/ab
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "runner"
NODE_BIN = os.path.expanduser("~/.local/opt/node-v22.17.0-linux-x64/bin")


def reset_repo(repo: str) -> None:
    subprocess.run(["git", "-C", repo, "checkout", "."], check=False, capture_output=True)
    subprocess.run(["git", "-C", repo, "clean", "-fd"], check=False, capture_output=True)


def sandbox_passes(repo: str, test_cmd: str) -> bool:
    r = subprocess.run(test_cmd, cwd=repo, shell=True, capture_output=True, env=_node_env())
    return r.returncode == 0


def _node_env() -> dict:
    env = dict(os.environ)
    env["PATH"] = NODE_BIN + os.pathsep + env.get("PATH", "")
    return env


def run_template(template: str, task: str, repo: str, out_dir: str) -> Path:
    """Run the runner once; return the produced trace.json path."""
    before = set(glob.glob(f"{out_dir}/*.trace.json"))
    cmd = [
        "npx", "tsx", "src/run.ts",
        "--task", task,
        "--template", template,
        "--repo", repo,
        "--out", out_dir,
    ]
    r = subprocess.run(cmd, cwd=RUNNER, capture_output=True, text=True, env=_node_env(), timeout=900)
    if r.returncode != 0:
        sys.stderr.write(r.stdout[-2000:] + "\n" + r.stderr[-2000:])
        raise RuntimeError(f"runner failed for {template}")
    after = set(glob.glob(f"{out_dir}/*.trace.json"))
    new = after - before
    if not new:
        raise RuntimeError(f"no new trace produced for {template}")
    return Path(max(new, key=lambda p: os.path.getmtime(p)))


def trace_metrics(trace_path: Path) -> dict:
    t = json.loads(trace_path.read_text())
    atts = t["attempts"]
    tokens = sum(a["cost"]["input_tokens"] + a["cost"]["output_tokens"] for a in atts)
    money = sum(a["cost"]["monetary_microunits"] for a in atts)
    nodes = sorted({a["runtime_node"]["runtime_node_id"] for a in atts})
    return {
        "status": t["status"],
        "tokens": tokens,
        "dollars": round(money / 1e6, 4),
        "attempts": len(atts),
        "n_nodes": len(nodes),
        "trace": str(trace_path),
    }


def one_arm(template: str, task: str, repo: str, test_cmd: str, out_dir: str) -> dict:
    reset_repo(repo)
    trace = run_template(template, task, repo, out_dir)
    m = trace_metrics(trace)
    m["passed"] = m["status"] == "success" and sandbox_passes(repo, test_cmd)
    return m


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--a", required=True, help="baseline template")
    p.add_argument("--b", required=True, help="candidate template")
    p.add_argument("--repo", required=True)
    p.add_argument("--test", required=True, help="sandbox test command, e.g. 'node test.js'")
    p.add_argument("--task", required=True)
    p.add_argument("--n", type=int, default=3)
    p.add_argument("--out", default=str(RUNNER / "runs" / "ab"))
    p.add_argument("--json", type=Path, default=None)
    args = p.parse_args()

    Path(args.out).mkdir(parents=True, exist_ok=True)
    rows = {"a": [], "b": []}
    for i in range(args.n):
        print(f"--- pair {i + 1}/{args.n} ---", flush=True)
        # A pair only counts if BOTH arms produce a trace; a timeout on either
        # arm (slow endpoint) drops the pair rather than aborting the whole run.
        try:
            a = one_arm(args.a, args.task, args.repo, args.test, args.out)
            print(f"  A {args.a:20s} tokens={a['tokens']:6d} ${a['dollars']:.4f} pass={a['passed']} attempts={a['attempts']}", flush=True)
            b = one_arm(args.b, args.task, args.repo, args.test, args.out)
            print(f"  B {args.b:20s} tokens={b['tokens']:6d} ${b['dollars']:.4f} pass={b['passed']} attempts={b['attempts']}", flush=True)
        except (subprocess.TimeoutExpired, RuntimeError) as exc:
            print(f"  pair {i + 1} dropped: {type(exc).__name__}: {str(exc)[:120]}", flush=True)
            continue
        rows["a"].append(a)
        rows["b"].append(b)

    if not rows["a"]:
        print("\nno complete pairs (endpoint too slow?). No verdict.", flush=True)
        return 2

    def med(arm, key):
        return statistics.median(r[key] for r in rows[arm])

    a_tok, b_tok = med("a", "tokens"), med("b", "tokens")
    a_usd, b_usd = med("a", "dollars"), med("b", "dollars")
    a_pass = sum(r["passed"] for r in rows["a"])
    b_pass = sum(r["passed"] for r in rows["b"])

    print("\n================ A/B RESULT (medians over %d pairs) ================" % args.n)
    print(f"  arm A ({args.a}): tokens={a_tok:.0f}  ${a_usd:.4f}  pass={a_pass}/{args.n}")
    print(f"  arm B ({args.b}): tokens={b_tok:.0f}  ${b_usd:.4f}  pass={b_pass}/{args.n}")
    print(f"  median token delta: {b_tok - a_tok:+.0f} ({100 * (b_tok - a_tok) / a_tok:+.1f}%)")
    print(f"  median cost  delta: {b_usd - a_usd:+.4f} ({100 * (b_usd - a_usd) / a_usd:+.1f}%)")
    print(f"  quality: A {a_pass}/{args.n} vs B {b_pass}/{args.n} pass (non-inferiority: B >= A ⇒ {b_pass >= a_pass})")

    out = {
        "a_template": args.a, "b_template": args.b, "n": args.n,
        "runs": rows,
        "medians": {"a_tokens": a_tok, "b_tokens": b_tok, "a_dollars": a_usd, "b_dollars": b_usd,
                    "a_pass": a_pass, "b_pass": b_pass},
    }
    if args.json:
        args.json.write_text(json.dumps(out, indent=2))
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
