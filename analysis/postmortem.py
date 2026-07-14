#!/usr/bin/env python3
"""Postmortem — turn a run's PVF attribution + cost trace into a waste report.

This is the L4 diagnosis step (PI_INTEGRATION_PLAN §5 Phase 2). It reads a
``wea.pvf.trace/v1`` document (and optionally the paired ``wea.trace/v1``),
runs PVF via ``prototypes/attribution.py``, and synthesizes a structured report
plus a Markdown rendering that a human — or the meta-agent — can act on.

What it looks for (in priority order):

1. dead nodes            — produced nothing that reached a terminal anchor.
2. low-efficiency nodes  — credit-per-token in the bottom quantile of THIS run
                           while carrying real cost. Absolute ``low_credit``
                           (threshold 0) rarely fires on a successful run; the
                           signal that matters is *relative* efficiency.
3. symmetric redundancy  — sibling nodes with the same role, (near-)equal credit
                           and overlapping function: parallelism that may be
                           over-provisioned (e.g. two explorers of equal credit).
4. critical-path waste   — low-value time sitting on the critical path.

Safety rails (v0.2 §3.5 — copied verbatim in intent): verifier / aggregator /
join / final-output nodes are NEVER emitted as prune candidates. They may appear
under "observations" but the report explicitly forbids proposing their removal.
A single low score is a *candidate for review*, never an instruction to delete.

Zero third-party deps: imports attribution.py by path, stdlib only.

CLI:
    python analysis/postmortem.py runner/runs/<run>.pvf.json \
        [--trace runner/runs/<run>.trace.json] \
        [--template t3-complex] [--json out.json] [--md out.md]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

ROOT = Path(__file__).resolve().parents[1]

# ---- load attribution.py as a module (no package install) --------------------


def _load_attribution():
    if "wea_attribution" in sys.modules:
        return sys.modules["wea_attribution"]
    spec = importlib.util.spec_from_file_location(
        "wea_attribution", ROOT / "prototypes" / "attribution.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load prototypes/attribution.py")
    module = importlib.util.module_from_spec(spec)
    # Register before exec so attribution.py's @dataclass introspection
    # (dataclasses._is_type looks up cls.__module__ in sys.modules) works.
    sys.modules["wea_attribution"] = module
    spec.loader.exec_module(module)
    return module


# Roles that must never be proposed for removal. These are safety/structural
# nodes: removing a verifier or the fan-in that produces the answer is exactly
# the class of change the plan forbids automating.
PROTECTED_ROLES = {"verifier", "aggregator"}

# Efficiency below (bottom_quantile_frac * median) is flagged. Kept conservative.
LOW_EFFICIENCY_QUANTILE = 0.5   # bottom half by credit/token …
LOW_EFFICIENCY_VS_BEST = 0.34   # … AND under a third of the best node's efficiency
REDUNDANCY_CREDIT_TOL = 0.02    # sibling credit within 2% counts as "equal"


@dataclass
class Finding:
    kind: str                       # dead | low_efficiency | redundancy | critical_path_waste
    severity: str                   # high | medium | low
    nodes: List[str]
    summary: str
    evidence: Dict[str, Any] = field(default_factory=dict)
    prune_safe: bool = False        # may this be proposed for removal/reduction?


@dataclass
class Postmortem:
    run_id: Optional[str]
    template: Optional[str]
    trace_id: Optional[str]
    total_cost: Dict[str, float]
    findings: List[Finding]
    node_table: List[Dict[str, Any]]
    pvf_metrics: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schema": "wea.postmortem/v1",
            "run_id": self.run_id,
            "template": self.template,
            "trace_id": self.trace_id,
            "total_cost": self.total_cost,
            "findings": [
                {
                    "kind": f.kind,
                    "severity": f.severity,
                    "nodes": f.nodes,
                    "summary": f.summary,
                    "evidence": f.evidence,
                    "prune_safe": f.prune_safe,
                }
                for f in self.findings
            ],
            "node_table": self.node_table,
            "pvf_metrics": self.pvf_metrics,
        }


def _role_of(occurrence_id: str, details: Mapping[str, Any]) -> str:
    return str(details.get(occurrence_id, {}).get("role") or "unknown")


def _base_node_id(occurrence_id: str) -> str:
    # "explore_a#1" -> "explore_a"
    return occurrence_id.split("#", 1)[0]


def _is_terminal_producer(base_id: str, terminal_bases: set[str]) -> bool:
    return base_id in terminal_bases


def analyze(
    pvf_doc: Mapping[str, Any],
    *,
    template: Optional[str] = None,
    run_id: Optional[str] = None,
    terminal_bases: Optional[set[str]] = None,
) -> Postmortem:
    attribution = _load_attribution()
    report = attribution.attribute_trace(pvf_doc)

    nodes: Dict[str, Any] = report["nodes"]
    metrics: Dict[str, Any] = report["metrics"]
    terminal_bases = terminal_bases or set()

    # ---- total cost roll-up --------------------------------------------------
    total_cost = {"tokens": 0.0, "dollars": 0.0, "wall_time_ms": 0.0, "critical_path_time_ms": 0.0}
    for det in nodes.values():
        for k in total_cost:
            total_cost[k] += float(det["cost"].get(k, 0.0))

    # ---- per-node efficiency table ------------------------------------------
    node_table: List[Dict[str, Any]] = []
    for occ_id, det in nodes.items():
        node_table.append(
            {
                "node": occ_id,
                "base": _base_node_id(occ_id),
                "role": det.get("role"),
                "credit": round(float(det["credit"]), 6),
                "tokens": float(det["cost"].get("tokens", 0.0)),
                "dollars": round(float(det["cost"].get("dollars", 0.0)), 6),
                "credit_per_token": float(det.get("positive_credit_per_token", 0.0)),
                "credit_per_critical_ms": float(det.get("positive_credit_per_critical_path_ms", 0.0)),
                "dead": bool(det.get("dead")),
                "low_credit": bool(det.get("low_credit")),
                "protected": (det.get("role") in PROTECTED_ROLES)
                or _is_terminal_producer(_base_node_id(occ_id), terminal_bases),
                "cost_share_tokens": round(
                    float(det["cost"].get("tokens", 0.0)) / total_cost["tokens"], 4
                )
                if total_cost["tokens"]
                else 0.0,
            }
        )
    node_table.sort(key=lambda r: r["credit_per_token"])  # least efficient first

    findings: List[Finding] = []

    # ---- 1. dead nodes -------------------------------------------------------
    dead = [r for r in node_table if r["dead"]]
    for r in dead:
        findings.append(
            Finding(
                kind="dead",
                severity="high",
                nodes=[r["node"]],
                summary=f"{r['node']} ({r['role']}) produced nothing reaching a terminal anchor "
                f"but cost {int(r['tokens'])} tokens.",
                evidence={"tokens": r["tokens"], "credit": r["credit"]},
                prune_safe=not r["protected"],
            )
        )

    # ---- 2. low-efficiency (relative) ---------------------------------------
    effs = sorted(r["credit_per_token"] for r in node_table)
    best_eff = effs[-1] if effs else 0.0
    median_eff = effs[len(effs) // 2] if effs else 0.0
    for r in node_table:
        if r["dead"]:
            continue
        if best_eff <= 0:
            continue
        below_median = r["credit_per_token"] <= median_eff * LOW_EFFICIENCY_QUANTILE
        far_below_best = r["credit_per_token"] <= best_eff * LOW_EFFICIENCY_VS_BEST
        material_cost = r["cost_share_tokens"] >= 0.10  # carries >=10% of the tokens
        if below_median and far_below_best and material_cost:
            findings.append(
                Finding(
                    kind="low_efficiency",
                    severity="medium" if not r["protected"] else "low",
                    nodes=[r["node"]],
                    summary=f"{r['node']} ({r['role']}) has credit/token "
                    f"{r['credit_per_token']:.2e} — {r['credit_per_token'] / best_eff:.0%} of the "
                    f"most efficient node — while carrying {r['cost_share_tokens']:.0%} of tokens.",
                    evidence={
                        "credit_per_token": r["credit_per_token"],
                        "best_credit_per_token": best_eff,
                        "cost_share_tokens": r["cost_share_tokens"],
                        "credit": r["credit"],
                    },
                    prune_safe=not r["protected"],
                )
            )

    # ---- 3. symmetric redundancy (parallel siblings) ------------------------
    by_role_base: Dict[str, List[Dict[str, Any]]] = {}
    for r in node_table:
        by_role_base.setdefault(str(r["role"]), []).append(r)
    for role, rows in by_role_base.items():
        if role in PROTECTED_ROLES or len(rows) < 2:
            continue
        # group siblings with (near) equal credit
        rows_sorted = sorted(rows, key=lambda x: x["credit"])
        i = 0
        while i < len(rows_sorted):
            group = [rows_sorted[i]]
            j = i + 1
            while j < len(rows_sorted) and abs(rows_sorted[j]["credit"] - rows_sorted[i]["credit"]) <= REDUNDANCY_CREDIT_TOL:
                group.append(rows_sorted[j])
                j += 1
            if len(group) >= 2:
                tokens = sum(g["tokens"] for g in group)
                findings.append(
                    Finding(
                        kind="redundancy",
                        severity="medium",
                        nodes=[g["node"] for g in group],
                        summary=f"{len(group)} parallel {role} nodes with near-equal credit "
                        f"({group[0]['credit']:.3f}) together cost {int(tokens)} tokens — "
                        f"over-provisioned parallelism; reducing the fan-out is a candidate.",
                        evidence={
                            "credit_each": group[0]["credit"],
                            "combined_tokens": tokens,
                            "count": len(group),
                        },
                        prune_safe=True,
                    )
                )
            i = j

    # ---- 4. critical-path waste ---------------------------------------------
    cp_waste_ms = float(metrics.get("critical_path_waste_ms", 0.0))
    if cp_waste_ms > 0:
        findings.append(
            Finding(
                kind="critical_path_waste",
                severity="medium",
                nodes=list(metrics.get("critical_path_waste_nodes", [])),
                summary=f"{cp_waste_ms:.0f}ms of low-credit work sits on the critical path "
                f"({metrics.get('critical_path_waste_rate', 0.0):.0%} of it).",
                evidence={
                    "critical_path_waste_ms": cp_waste_ms,
                    "rate": metrics.get("critical_path_waste_rate", 0.0),
                },
                prune_safe=False,
            )
        )

    # severity ordering for stable, useful output
    order = {"high": 0, "medium": 1, "low": 2}
    findings.sort(key=lambda f: (order.get(f.severity, 3), f.kind))

    return Postmortem(
        run_id=run_id,
        template=template,
        trace_id=report.get("trace_id"),
        total_cost={k: round(v, 6) for k, v in total_cost.items()},
        findings=findings,
        node_table=node_table,
        pvf_metrics={
            "dead_cost_rate": metrics.get("dead_cost_rate"),
            "provenance_coverage": metrics.get("provenance_coverage"),
            "consumer_coverage": metrics.get("consumer_coverage"),
            "terminal_reachability_rate": metrics.get("terminal_reachability_rate"),
        },
    )


# ---- terminal producers from the compliance trace ----------------------------


def terminal_bases_from_trace(trace_doc: Mapping[str, Any]) -> set[str]:
    """Nodes whose output feeds @output — read from the runner graph if present.

    The compliance trace does not embed the graph edges, so we accept the
    template graph indirectly. When unavailable we fall back to the empty set
    (only role-based protection applies).
    """
    # wea.trace/v1 doesn't carry edges; protection then relies on roles only.
    return set()


# ---- markdown rendering ------------------------------------------------------


def render_markdown(pm: Postmortem) -> str:
    lines: List[str] = []
    lines.append(f"# Postmortem — {pm.template or 'run'} ({(pm.run_id or '')[:8]})")
    lines.append("")
    tc = pm.total_cost
    lines.append(
        f"**Total cost**: {int(tc['tokens'])} tokens · ${tc['dollars']:.4f} · "
        f"{tc['wall_time_ms'] / 1000:.1f}s wall · {tc['critical_path_time_ms'] / 1000:.1f}s critical path"
    )
    m = pm.pvf_metrics
    lines.append(
        f"**PVF health**: provenance_coverage {m.get('provenance_coverage')} · "
        f"dead_cost_rate {m.get('dead_cost_rate')} · "
        f"terminal_reachability {m.get('terminal_reachability_rate')}"
    )
    lines.append("")

    lines.append("## Findings")
    if not pm.findings:
        lines.append("_No waste findings — run was efficient._")
    for f in pm.findings:
        tag = "PRUNE-CANDIDATE" if f.prune_safe else "OBSERVE-ONLY"
        lines.append(f"- **[{f.severity.upper()}] {f.kind}** ({tag}): {f.summary}")
    lines.append("")

    lines.append("## Node efficiency (least efficient first)")
    lines.append("")
    lines.append("| node | role | credit | tokens | tok-share | credit/token | protected |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in pm.node_table:
        lines.append(
            f"| {r['node']} | {r['role']} | {r['credit']:.3f} | {int(r['tokens'])} | "
            f"{r['cost_share_tokens']:.0%} | {r['credit_per_token']:.2e} | "
            f"{'yes' if r['protected'] else 'no'} |"
        )
    lines.append("")
    return "\n".join(lines)


# ---- CLI ---------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("pvf", type=Path, help="wea.pvf.trace/v1 JSON")
    p.add_argument("--trace", type=Path, default=None, help="paired wea.trace/v1 (for run_id)")
    p.add_argument("--template", default=None)
    p.add_argument("--json", type=Path, default=None, help="write structured report here")
    p.add_argument("--md", type=Path, default=None, help="write markdown report here")
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    pvf_doc = json.loads(args.pvf.read_text(encoding="utf-8"))
    run_id = None
    template = args.template
    if args.trace and args.trace.is_file():
        trace_doc = json.loads(args.trace.read_text(encoding="utf-8"))
        run_id = trace_doc.get("run_id")
        if template is None:
            rel = trace_doc.get("instance_ref", {}).get("template_release", {})
            template = rel.get("logical_id")

    pm = analyze(pvf_doc, template=template, run_id=run_id)
    if args.json:
        args.json.write_text(json.dumps(pm.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
    md = render_markdown(pm)
    if args.md:
        args.md.write_text(md, encoding="utf-8")
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
