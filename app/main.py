"""FastAPI application: multi-judge score calibration."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import database as db
from .csv_io import CSVParseError, build_audit_csv, parse_scores
from .rules import (
    RuleValidationError,
    evaluate_rules,
    normalize_rules,
    score_rows_from_analysis,
)
from .scoring import SCOPES, SCOPE_JUDGE, analyze, compare_contestants, stability_experiment

SAMPLE_PATH = os.environ.get(
    "CALIB_SAMPLE_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples", "sample_scores.csv"),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="多评委评分校准", version="1.0.0", lifespan=lifespan)


def _build_analysis(conn, session_id: str, scope: str) -> dict[str, Any]:
    records = db.load_scores(conn, session_id)
    decisions = db.load_decisions(conn, session_id)
    result = analyze(records, decisions, scope=scope)
    result["batch_rules"] = db.load_rules(conn, session_id)
    return result


def _resolve_scope(conn, session_id: str, override: str | None) -> str:
    if override is not None:
        if override not in SCOPES:
            raise HTTPException(status_code=400, detail=f"不支持的校准范围: {override}")
        return override
    stored = db.get_scope(conn, session_id)
    return stored or SCOPE_JUDGE


class ScopeBody(BaseModel):
    scope: Literal["judge", "judge_item"]


class DecisionBody(BaseModel):
    use_raw: bool
    reason: str = Field(default="", max_length=2000)


class StabilityBody(BaseModel):
    exclude_type: Literal["judge", "item"]
    exclude_name: str = Field(min_length=1, max_length=200)


class CompareBody(BaseModel):
    contestant_a: str = Field(min_length=1, max_length=200)
    contestant_b: str = Field(min_length=1, max_length=200)


class RuleBody(BaseModel):
    name: str = Field(default="", max_length=200)
    judge: str | None = None
    item: str | None = None
    raw_min: float | None = None
    raw_max: float | None = None
    cal_min: float | None = None
    cal_max: float | None = None
    use_raw: bool = False
    reason_template: str = Field(default="", max_length=2000)
    priority: int = Field(default=100, ge=0, le=1_000_000)


class RuleSetBody(BaseModel):
    rules: list[RuleBody] = Field(default_factory=list)


def _normalize_session_rules(body: RuleSetBody, analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate/normalize submitted rules against the session's judge/item names."""
    try:
        rules = normalize_rules([r.model_dump() for r in body.rules])
    except RuleValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    judges = set(analysis["judges"])
    items = set(analysis["items"])
    for i, rule in enumerate(rules, start=1):
        if rule["judge"] is not None and rule["judge"] not in judges:
            raise HTTPException(
                status_code=400,
                detail=f"第 {i} 条规则引用的评委「{rule['judge']}」不存在，可选：{', '.join(analysis['judges']) or '(无)'}。",
            )
        if rule["item"] is not None and rule["item"] not in items:
            raise HTTPException(
                status_code=400,
                detail=f"第 {i} 条规则引用的项目「{rule['item']}」不存在，可选：{', '.join(analysis['items']) or '(无)'}。",
            )
    return rules


def _rule_preview(analysis: dict[str, Any], rules: list[dict[str, Any]]) -> dict[str, Any]:
    """Run read-only rule matching on top of an analysis result."""
    rows = score_rows_from_analysis(analysis)
    decisions = {
        s["id"]: (s["use_raw"], s["reason"])
        for block in analysis["contestants"]
        for ib in block["items"]
        for s in ib["scores"]
    }
    preview = evaluate_rules(rows, rules, decisions)
    preview["scope"] = analysis["scope"]
    preview["scope_label"] = analysis["scope_label"]
    return preview


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sessions/{session_id}/analysis")
def get_analysis(session_id: str, scope: str | None = None) -> dict[str, Any]:
    with db.get_conn() as conn:
        effective_scope = _resolve_scope(conn, session_id, scope)
        return _build_analysis(conn, session_id, effective_scope)


@app.post("/api/sessions/{session_id}/scope")
def update_scope(session_id: str, body: ScopeBody) -> dict[str, Any]:
    with db.get_conn() as conn:
        db.ensure_session(conn, session_id, body.scope)
        db.set_scope(conn, session_id, body.scope)
        return _build_analysis(conn, session_id, body.scope)


@app.post("/api/sessions/{session_id}/upload")
async def upload_scores(
    session_id: str,
    file: UploadFile = File(...),
    scope: str = SCOPE_JUDGE,
) -> dict[str, Any]:
    if scope not in SCOPES:
        raise HTTPException(status_code=400, detail=f"不支持的校准范围: {scope}")
    raw = await file.read()
    try:
        records = parse_scores(raw)
    except CSVParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    with db.get_conn() as conn:
        db.ensure_session(conn, session_id, scope)
        db.replace_scores(conn, session_id, records)
        return _build_analysis(conn, session_id, scope)


@app.post("/api/sessions/{session_id}/sample")
def load_sample(session_id: str, scope: str = SCOPE_JUDGE) -> dict[str, Any]:
    if scope not in SCOPES:
        raise HTTPException(status_code=400, detail=f"不支持的校准范围: {scope}")
    try:
        with open(SAMPLE_PATH, "rb") as fh:
            records = parse_scores(fh.read())
    except OSError:
        raise HTTPException(status_code=404, detail="示例数据文件不可用。")
    except CSVParseError as exc:
        raise HTTPException(status_code=500, detail=f"示例数据格式错误: {exc}")
    with db.get_conn() as conn:
        db.ensure_session(conn, session_id, scope)
        db.replace_scores(conn, session_id, records)
        return _build_analysis(conn, session_id, scope)


@app.patch("/api/sessions/{session_id}/scores/{score_id}/decision")
def patch_decision(session_id: str, score_id: int, body: DecisionBody) -> dict[str, Any]:
    with db.get_conn() as conn:
        try:
            db.upsert_decision(conn, session_id, score_id, body.use_raw, body.reason)
        except db.NotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        scope = _resolve_scope(conn, session_id, None)
        return _build_analysis(conn, session_id, scope)


@app.post("/api/sessions/{session_id}/decisions/reset")
def reset_decisions(session_id: str) -> dict[str, Any]:
    with db.get_conn() as conn:
        if db.get_scope(conn, session_id) is None:
            raise HTTPException(status_code=404, detail="会话不存在。")
        removed = db.reset_decisions(conn, session_id)
        scope = _resolve_scope(conn, session_id, None)
        analysis = _build_analysis(conn, session_id, scope)
        analysis["reset_count"] = removed
        return analysis


@app.get("/api/sessions/{session_id}/rules")
def get_rules(session_id: str) -> dict[str, Any]:
    with db.get_conn() as conn:
        return {"rules": db.load_rules(conn, session_id)}


@app.put("/api/sessions/{session_id}/rules")
def save_rules(session_id: str, body: RuleSetBody) -> dict[str, Any]:
    """Persist a rule set without applying it to any scores."""
    with db.get_conn() as conn:
        if db.get_scope(conn, session_id) is None:
            raise HTTPException(status_code=404, detail="会话不存在，请先上传数据。")
        scope = _resolve_scope(conn, session_id, None)
        analysis = _build_analysis(conn, session_id, scope)
        if analysis["counts"]["scores"] == 0:
            raise HTTPException(status_code=400, detail="当前会话没有评分数据，无法保存规则。")
        rules = _normalize_session_rules(body, analysis)
        saved = db.replace_rules(conn, session_id, rules)
    return {"saved": saved, "rules": rules}


@app.post("/api/sessions/{session_id}/rules/preview")
def preview_rules(session_id: str, body: RuleSetBody) -> dict[str, Any]:
    """Read-only dry run: hit/miss/conflict counts and priority resolution.

    Never persists rules and never modifies decisions.
    """
    with db.get_conn() as conn:
        if db.get_scope(conn, session_id) is None:
            raise HTTPException(status_code=404, detail="会话不存在，请先上传数据。")
        scope = _resolve_scope(conn, session_id, None)
        analysis = _build_analysis(conn, session_id, scope)
        if analysis["counts"]["scores"] == 0:
            raise HTTPException(status_code=400, detail="当前会话没有评分数据，无法预览规则。")
        rules = _normalize_session_rules(body, analysis)
        preview = _rule_preview(analysis, rules)
    preview["rules_submitted"] = len(rules)
    preview["rules_saved"] = len(analysis["batch_rules"])
    return preview


@app.post("/api/sessions/{session_id}/rules/apply")
def apply_rules(session_id: str, body: RuleSetBody) -> dict[str, Any]:
    """Persist rules and write all adjudications in a single transaction."""
    with db.get_conn() as conn:
        if db.get_scope(conn, session_id) is None:
            raise HTTPException(status_code=404, detail="会话不存在，请先上传数据。")
        scope = _resolve_scope(conn, session_id, None)
        pre_analysis = _build_analysis(conn, session_id, scope)
        if pre_analysis["counts"]["scores"] == 0:
            raise HTTPException(status_code=400, detail="当前会话没有评分数据，无法应用规则。")
        rules = _normalize_session_rules(body, pre_analysis)
        preview = _rule_preview(pre_analysis, rules)
        # Everything below commits together; any failure rolls the whole batch back.
        db.replace_rules(conn, session_id, rules)
        written = db.apply_batch_decisions(conn, session_id, preview["assignments"])
        analysis = _build_analysis(conn, session_id, scope)
    analysis["rules_saved"] = len(rules)
    analysis["written"] = written
    analysis["matched"] = preview["matched"]
    analysis["unmatched"] = preview["unmatched"]
    analysis["conflicted"] = preview["conflicted"]
    analysis["changed"] = preview["would_change"]
    analysis["rule_preview"] = {
        k: preview[k]
        for k in ("total_scores", "matched", "unmatched", "conflicted", "would_change", "rules")
    }
    return analysis


@app.post("/api/sessions/{session_id}/stability")
def stability_check(session_id: str, body: StabilityBody) -> dict[str, Any]:
    """Temporary what-if run: exclude one judge/item and diff ranks/totals.

    Pure read-only computation — no scores, decisions or session state are
    modified. The client discards the result when returning to baseline.
    """
    with db.get_conn() as conn:
        if db.get_scope(conn, session_id) is None:
            raise HTTPException(status_code=404, detail="会话不存在，请先上传数据。")
        scope = _resolve_scope(conn, session_id, None)
        records = db.load_scores(conn, session_id)
        decisions = db.load_decisions(conn, session_id)
    if not records:
        raise HTTPException(status_code=404, detail="当前会话没有评分数据，无法进行实验。")
    try:
        return stability_experiment(
            records, decisions, scope, body.exclude_type, body.exclude_name.strip()
        )
    except LookupError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/sessions/{session_id}/compare")
def compare_two(session_id: str, body: CompareBody) -> dict[str, Any]:
    """Read-only two-contestant comparison derived from the current analysis.

    Never persists anything: the comparison follows the stored scores, the
    active calibration scope and all human adjudications at request time.
    """
    with db.get_conn() as conn:
        if db.get_scope(conn, session_id) is None:
            raise HTTPException(status_code=404, detail="会话不存在，请先上传数据。")
        scope = _resolve_scope(conn, session_id, None)
        analysis = _build_analysis(conn, session_id, scope)
    if analysis["counts"]["scores"] == 0:
        raise HTTPException(status_code=400, detail="当前会话没有评分数据，无法进行对比。")
    try:
        return compare_contestants(
            analysis, body.contestant_a.strip(), body.contestant_b.strip()
        )
    except LookupError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/api/sessions/{session_id}")
def clear_session(session_id: str) -> dict[str, Any]:
    with db.get_conn() as conn:
        existed = db.delete_session(conn, session_id)
    return {"cleared": existed}


@app.get("/api/sessions/{session_id}/export")
def export_audit(session_id: str) -> Response:
    with db.get_conn() as conn:
        if db.get_scope(conn, session_id) is None:
            raise HTTPException(status_code=404, detail="会话不存在，请先上传数据。")
        scope = _resolve_scope(conn, session_id, None)
        analysis = _build_analysis(conn, session_id, scope)
    if analysis["counts"]["scores"] == 0:
        raise HTTPException(status_code=400, detail="当前会话没有可导出的数据。")
    payload = build_audit_csv(analysis)
    headers = {"Content-Disposition": 'attachment; filename="calibration_audit.csv"'}
    return Response(content=payload, media_type="text/csv; charset=utf-8", headers=headers)


# Frontend (served last so /api routes take precedence).
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
