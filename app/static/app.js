"use strict";

// ---------- Session ----------
const SESSION_KEY = "calib_session_id";
function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}
const SESSION_ID = getSessionId();
document.getElementById("session-id").textContent = SESSION_ID;

// ---------- State ----------
let analysis = null;
let stability = null; // 排名稳定性实验结果（纯前端临时态，不持久化）
let ruleDraft = null; // 规则编辑器草稿（数组），DOM 是输入中的真实来源
let rulePreviewData = null; // 最近一次规则预览结果（只读，不落库）
let rulePreviewStale = false; // 草稿在预览后又被修改
let comparison = null; // 双选手对比结果（只读派生，不落库、不另存评分）
let compareReqId = 0; // 对比请求序号，过期响应直接丢弃
let comparePending = null; // 进行中的请求 {a, b, reqId}，防止连点选择时错配旧结果

const $ = (sel) => document.querySelector(sel);
const dashboard = $("#dashboard");
const emptyState = $("#empty-state");

// ---------- Helpers ----------
function fmt(v, digits = 2) {
  if (v === null || v === undefined) return "-";
  return Number(v).toFixed(digits);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function deltaHtml(d) {
  if (d > 0) return `<span class="delta-up">↑${d}</span>`;
  if (d < 0) return `<span class="delta-down">↓${-d}</span>`;
  return `<span class="delta-flat">—</span>`;
}
let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 4000 : 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch (_) { /* keep default */ }
    throw new Error(detail);
  }
  return res.json();
}

// ---------- Rendering ----------
let lastAnalysisRef = null; // 上一次 render 看到的 analysis 对象；对象换了说明数据/裁决已更新
function render() {
  if (analysis !== lastAnalysisRef) {
    lastAnalysisRef = analysis;
    comparison = null; // 对比是 analysis 的只读派生视图，分析更新即作废并重取
    comparePending = null;
    compareReqId++;
  }
  if (!analysis || analysis.counts.scores === 0) {
    dashboard.hidden = true;
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;
  dashboard.hidden = false;

  const ref = analysis.reference;
  $("#reference-info").innerHTML =
    `校准范围：<b>${esc(analysis.scope_label)}</b><br>` +
    `对每个校准分组计算中位数与 MAD：<code>Z = (原始分 − 中位数) / (MAD × ${ref.mad_k})</code>，` +
    `再映射回全局尺度：<code>校准分 = ${fmt(ref.global_median, 3)} + Z × ${fmt(ref.global_mad, 3)}</code>` +
    `（全局中位数 ${fmt(ref.global_median, 3)}，全局 MAD ${fmt(ref.global_mad, 3)}）。` +
    `分组 MAD 为 0（无离散度）时取 Z = 0。`;

  const c = analysis.counts;
  $("#stats-row").innerHTML = [
    ["选手", c.contestants], ["评委", c.judges], ["项目", c.items],
    ["评分条数", c.scores], ["保留原分裁决", c.decisions],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");

  renderGroups();
  renderReversals();
  renderRanks();
  initRuleDraft();
  renderDetails();
  renderStability();
  renderCompare();
}

// ---------- Ranking stability experiment ----------
const stabilityTypeSel = $("#stability-type");
const stabilityNameSel = $("#stability-name");
const stabilityBtnRun = $("#btn-stability-run");
const stabilityBtnClear = $("#btn-stability-clear");

function setStabilityMsg(text, cls = "") {
  const el = $("#stability-msg");
  el.textContent = text;
  el.className = "msg " + cls;
}

// Discard the what-if result and return to the baseline table.
function clearStability(silent = false) {
  stability = null;
  setStabilityMsg("");
  renderStability();
  if (!silent) toast("已恢复基线排名");
}

function syncStabilityControls() {
  const hasData = !!(analysis && analysis.counts.scores > 0);
  const type = stabilityTypeSel.value;
  const names = hasData ? (type === "judge" ? analysis.judges : analysis.items) : [];
  const prev = stabilityNameSel.value;
  stabilityNameSel.innerHTML =
    `<option value="" disabled${names.length ? "" : " selected"}>请选择${type === "judge" ? "评委" : "项目"}…</option>` +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if (names.includes(prev)) stabilityNameSel.value = prev;
  stabilityBtnRun.disabled = !hasData;
  stabilityNameSel.disabled = !hasData;
  stabilityTypeSel.disabled = !hasData;
  stabilityBtnClear.disabled = stability === null;
}

function signedNum(d, digits = 2) {
  if (d === null || d === undefined) return "-";
  return (d > 0 ? "+" : d < 0 ? "−" : "") + fmt(Math.abs(d), digits);
}

function totalDeltaHtml(d) {
  if (d === null || d === undefined) return `<span class="delta-flat">-</span>`;
  if (d > 0) return `<span class="delta-up">${signedNum(d)}</span>`;
  if (d < 0) return `<span class="delta-down">${signedNum(d)}</span>`;
  return `<span class="delta-flat">0.00</span>`;
}

function renderStability() {
  const panel = $("#stability-result");
  syncStabilityControls();
  if (!stability) {
    panel.innerHTML = "";
    return;
  }
  const ex = stability.exclusion;
  const s = stability.summary;

  const head = `
    <tr>
      <th class="num">基线<br>最终名次</th><th>选手</th><th class="num">受影响<br>评分数</th>
      <th class="num">原始<br>基线总分</th><th class="num">实验<br>原始总分</th><th class="num">原始<br>总分变化</th>
      <th class="num">基线<br>原始名次</th><th class="num">实验<br>原始名次</th><th class="num">原始<br>名次变化</th>
      <th class="num">校准<br>基线总分</th><th class="num">实验<br>校准总分</th><th class="num">校准<br>总分变化</th>
      <th class="num">基线<br>校准名次</th><th class="num">实验<br>校准名次</th><th class="num">校准<br>名次变化</th>
      <th class="num">最终<br>基线总分</th><th class="num">实验<br>最终总分</th><th class="num">最终<br>总分变化</th>
      <th class="num">基线<br>最终名次</th><th class="num">实验<br>最终名次</th><th class="num">最终<br>名次变化</th>
    </tr>`;

  const rows = stability.contestants.map((r) => {
    if (!r.present) {
      return `<tr class="gone-row"><td class="num"><b>${r.baseline.eff_rank}</b></td>
        <td><span class="gone-name">${esc(r.contestant)}</span></td>
        <td class="num">${r.affected_scores}</td>
        <td class="num">${fmt(r.baseline.raw_total)}</td>
        <td colspan="17" class="num gone-note">无剩余评分，无法计算名次（校准分 / 最终分同样不可计算）</td></tr>`;
    }
    const b = r.baseline, sc = r.scenario;
    const cls = r.eff_rank_delta && r.eff_rank_delta !== 0 ? "rank-shift-row" : "";
    return `
    <tr class="${cls}">
      <td class="num"><b>${b.eff_rank}</b></td>
      <td>${esc(r.contestant)}</td>
      <td class="num"><b>${r.affected_scores}</b></td>
      <td class="num">${fmt(b.raw_total)}</td><td class="num">${fmt(sc.raw_total)}</td><td class="num">${totalDeltaHtml(r.raw_total_delta)}</td>
      <td class="num">${b.raw_rank}</td><td class="num">${sc.raw_rank}</td><td class="num">${deltaHtml(r.raw_rank_delta)}</td>
      <td class="num">${fmt(b.cal_total)}</td><td class="num">${fmt(sc.cal_total)}</td><td class="num">${totalDeltaHtml(r.cal_total_delta)}</td>
      <td class="num">${b.cal_rank}</td><td class="num">${sc.cal_rank}</td><td class="num">${deltaHtml(r.cal_rank_delta)}</td>
      <td class="num"><b>${fmt(b.eff_total)}</b></td><td class="num"><b>${fmt(sc.eff_total)}</b></td><td class="num">${totalDeltaHtml(r.eff_total_delta)}</td>
      <td class="num">${b.eff_rank}</td><td class="num"><b>${sc.eff_rank}</b></td><td class="num">${deltaHtml(r.eff_rank_delta)}</td>
    </tr>`;
  }).join("");

  panel.innerHTML = `
    <div class="stability-banner">
      实验：临时排除${ex.type_label} <b>${esc(ex.name)}</b>（校准范围：${esc(stability.scope_label)}）｜
      共移除 <b>${stability.removed_scores}</b> 条评分（${stability.baseline_counts.scores} → ${stability.scenario_counts.scores}）。
      最终名次变化：<b class="${s.eff_rank_changed ? "delta-down" : "delta-flat"}">${s.eff_rank_changed}</b> 位
      <span class="delta-up">↑${s.eff_moved_up}</span> / <span class="delta-down">↓${s.eff_moved_down}</span>；
      原始名次变化 ${s.raw_rank_changed} 位，校准名次变化 ${s.cal_rank_changed} 位；
      最终总分最大绝对变化 ${fmt(s.max_eff_total_delta_abs)}。
      <span class="stability-note">本结果为临时模拟，不写入会话裁决或数据库。</span>
    </div>
    <div class="table-wrap stability-table-wrap"><table>${head}${rows}</table></div>`;
}

function renderGroups() {
  const byItem = analysis.scope === "judge_item";
  const head = byItem
    ? `<tr><th>评委</th><th>项目</th><th class="num">条数</th><th class="num">中位数</th><th class="num">MAD</th><th class="num">MAD×1.4826</th></tr>`
    : `<tr><th>评委</th><th class="num">条数</th><th class="num">中位数</th><th class="num">MAD</th><th class="num">MAD×1.4826</th></tr>`;
  const rows = analysis.groups.map((g) => {
    const flat = g.mad === 0 ? ' <span class="zline">(无离散度)</span>' : "";
    return byItem
      ? `<tr><td>${esc(g.judge)}</td><td>${esc(g.item)}</td><td class="num">${g.n}</td><td class="num">${fmt(g.median)}</td><td class="num">${fmt(g.raw_mad, 3)}${flat}</td><td class="num">${fmt(g.mad, 3)}</td></tr>`
      : `<tr><td>${esc(g.judge)}</td><td class="num">${g.n}</td><td class="num">${fmt(g.median)}</td><td class="num">${fmt(g.raw_mad, 3)}${flat}</td><td class="num">${fmt(g.mad, 3)}</td></tr>`;
  }).join("");
  $("#group-table-wrap").innerHTML = `<table>${head}${rows}</table>`;
}

function renderReversals() {
  const rvs = analysis.reversals;
  const badge = $("#reversal-count");
  badge.textContent = rvs.length;
  badge.className = "badge" + (rvs.length === 0 ? " zero" : "");
  const panel = $("#reversal-panel");
  if (rvs.length === 0) {
    panel.innerHTML = `<p class="no-reversal">✓ 标准化前后未检测到选手对名次反转。</p>`;
    return;
  }
  panel.innerHTML = rvs.map((r) => `
    <div class="reversal-card">
      <b>${esc(r.winner_before)}</b>（原始第 ${r.raw_rank_before} 名）
      <span class="arrow">→ 反超 →</span>
      <b>${esc(r.winner_after)}</b>（原始第 ${r.raw_rank_loser} 名）
      <br>
      <small>校准后：<b>${esc(r.winner_after)}</b> 第 ${r.cal_rank_winner} 名，${esc(r.winner_before)} 第 ${r.cal_rank_loser} 名；
      原始分差 ${fmt(r.raw_gap)}，校准后反向分差 ${fmt(r.cal_gap)}</small>
    </div>`).join("");
}

function renderRanks() {
  const head = `<tr>
    <th class="num">最终名次</th><th>选手</th>
    <th class="num">原始总分</th><th class="num">原始名次</th>
    <th class="num">校准总分</th><th class="num">校准名次</th>
    <th class="num">校准后变化</th>
    <th class="num">最终总分</th><th class="num">保留原分条数</th>
  </tr>`;
  // Show final-rank ordering; blocks already arrive sorted by eff_rank.
  const rows = analysis.contestants.map((b) => `
    <tr>
      <td class="num"><b>${b.eff_rank}</b></td>
      <td>${esc(b.contestant)}</td>
      <td class="num">${fmt(b.raw_total)}</td>
      <td class="num">${b.raw_rank}</td>
      <td class="num">${fmt(b.cal_total)}</td>
      <td class="num">${b.cal_rank}</td>
      <td class="num">${deltaHtml(b.rank_delta)}</td>
      <td class="num"><b>${fmt(b.eff_total)}</b></td>
      <td class="num">${b.raw_overrides}</td>
    </tr>`).join("");
  $("#rank-table-wrap").innerHTML = `<table>${head}${rows}</table>`;
}

function renderDetails() {
  const panel = $("#detail-panel");
  panel.innerHTML = analysis.contestants.map((b, idx) => {
    const items = b.items.map((ib) => {
      const scores = ib.scores.map((s) => {
        const flat = s.group_mad === 0;
        const useCal = !s.use_raw;
        return `
        <div class="score-row" data-id="${s.id}">
          <div class="who">${esc(s.judge)}<small>${esc(ib.item)}</small></div>
          <div class="score-val">
            <span class="raw">原分 ${fmt(s.raw)}</span><br>
            <span class="cal">校准 ${fmt(s.calibrated)}</span>
            <small>（Z=${fmt(s.z, 2)}，中位数 ${fmt(s.group_median)}）</small>
            ${flat ? '<br><span class="zline">该分组 MAD=0，校准分恒等于全局中位数</span>' : ""}
          </div>
          <div class="score-val muted">
            最终分<br><span class="eff">${fmt(s.effective)}</span>
          </div>
          <div class="choice">
            <label><input type="radio" name="choice-${s.id}" value="cal" ${useCal ? "checked" : ""}> 采用校准分</label>
            <label><input type="radio" name="choice-${s.id}" value="raw" ${s.use_raw ? "checked" : ""}> 保留原分</label>
            <input type="text" class="reason-input" data-id="${s.id}" maxlength="2000"
                   placeholder="理由（可选，将写入审计导出）" value="${esc(s.reason)}">
          </div>
        </div>`;
      }).join("");
      return `<div style="margin:6px 0 12px;"><b>${esc(ib.item)}</b>
        <small style="color:var(--muted)">（原始均分 ${fmt(ib.raw_avg)} → 校准均分 ${fmt(ib.cal_avg)} → 最终均分 ${fmt(ib.eff_avg)}）</small>
        ${scores}</div>`;
    }).join("");
    return `
      <div class="contestant-block ${idx > 1 ? "collapsed" : ""}" data-contestant="${esc(b.contestant)}">
        <div class="contestant-head">
          <h4>${esc(b.contestant)}</h4>
          <span class="meta">最终名次 ${b.eff_rank} ｜ 最终总分 ${fmt(b.eff_total)} ｜ 原始名次 ${b.raw_rank} → 校准名次 ${b.cal_rank} ｜ ${b.item_count} 个项目（点击折叠）</span>
        </div>
        <div class="contestant-body">${items}</div>
      </div>`;
  }).join("");

  panel.querySelectorAll(".contestant-head").forEach((h) => {
    h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed"));
  });
  panel.querySelectorAll('input[type="radio"]').forEach((radio) => {
    radio.addEventListener("change", onChoiceChange);
  });
  panel.querySelectorAll(".reason-input").forEach((input) => {
    input.addEventListener("input", onReasonInput);
  });
}

// ---------- Batch adjudication rules ----------
const rulesEditor = $("#rules-editor");
const rulesPreviewEl = $("#rules-preview");

function setRulesMsg(text, cls = "") {
  const el = $("#rules-msg");
  el.textContent = text;
  el.className = "msg " + cls;
}

function emptyRule() {
  return {
    name: "", judge: "", item: "",
    raw_min: "", raw_max: "", cal_min: "", cal_max: "",
    use_raw: false, reason_template: "", priority: 100,
  };
}

// Load drafts once per data set: prefer unsaved drafts, then server rules.
function initRuleDraft() {
  if (ruleDraft) return;
  const saved = (analysis.batch_rules || []).map((r) => ({
    name: r.name || "",
    judge: r.judge || "",
    item: r.item || "",
    raw_min: r.raw_min === null || r.raw_min === undefined ? "" : r.raw_min,
    raw_max: r.raw_max === null || r.raw_max === undefined ? "" : r.raw_max,
    cal_min: r.cal_min === null || r.cal_min === undefined ? "" : r.cal_min,
    cal_max: r.cal_max === null || r.cal_max === undefined ? "" : r.cal_max,
    use_raw: !!r.use_raw,
    reason_template: r.reason_template || "",
    priority: r.priority,
  }));
  ruleDraft = saved.length ? saved : [emptyRule()];
  renderRulesEditor();
}

function renderRulesEditor() {
  const judgeOpts = [`<option value="">（不限评委）</option>`]
    .concat(analysis.judges.map((j) => `<option value="${esc(j)}">${esc(j)}</option>`)).join("");
  const itemOpts = [`<option value="">（不限项目）</option>`]
    .concat(analysis.items.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`)).join("");

  rulesEditor.innerHTML = ruleDraft.map((r, idx) => `
    <div class="rule-row" data-idx="${idx}">
      <div class="rule-head">
        <span class="rule-index">#${idx + 1}</span>
        <input type="text" class="rule-name" placeholder="规则名称（可选，便于审计）" value="${esc(r.name)}">
        <label class="rule-choice">
          裁决：
          <select class="rule-use-raw">
            <option value="cal"${r.use_raw ? "" : " selected"}>采用校准分</option>
            <option value="raw"${r.use_raw ? " selected" : ""}>保留原分</option>
          </select>
        </label>
        <label class="rule-prio">优先级（小者优先）
          <input type="number" class="rule-priority" min="0" max="1000000" step="1" value="${esc(String(r.priority))}">
        </label>
        <button type="button" class="btn btn-ghost-card rule-del" title="删除该规则">删除</button>
      </div>
      <div class="rule-conds">
        <label>评委<select class="rule-judge">${judgeOpts}</select></label>
        <label>项目<select class="rule-item">${itemOpts}</select></label>
        <label>原始分 ≥<input type="number" class="rule-raw-min" step="any" value="${esc(r.raw_min)}"></label>
        <label>原始分 ≤<input type="number" class="rule-raw-max" step="any" value="${esc(r.raw_max)}"></label>
        <label>校准分 ≥<input type="number" class="rule-cal-min" step="any" value="${esc(r.cal_min)}"></label>
        <label>校准分 ≤<input type="number" class="rule-cal-max" step="any" value="${esc(r.cal_max)}"></label>
      </div>
      <input type="text" class="rule-reason" maxlength="2000"
             placeholder="理由模板，支持 {judge} {item} {raw} {calibrated}（留空则不写理由）"
             value="${esc(r.reason_template)}">
    </div>`).join("");

  rulesEditor.querySelectorAll(".rule-row").forEach((row) => {
    const idx = Number(row.dataset.idx);
    const sel = (cls) => row.querySelector("." + cls);
    const bind = (cls, key) => {
      sel(cls).addEventListener("input", (ev) => {
        ruleDraft[idx][key] = ev.target.value;
        markRulesChanged();
      });
    };
    bind("rule-name", "name");
    bind("rule-reason", "reason_template");
    bind("rule-priority", "priority");
    bind("rule-judge", "judge");
    bind("rule-item", "item");
    bind("rule-raw-min", "raw_min");
    bind("rule-raw-max", "raw_max");
    bind("rule-cal-min", "cal_min");
    bind("rule-cal-max", "cal_max");
    sel("rule-use-raw").addEventListener("change", (ev) => {
      ruleDraft[idx].use_raw = ev.target.value === "raw";
      markRulesChanged();
    });
    sel("rule-del").addEventListener("click", () => {
      ruleDraft.splice(idx, 1);
      if (ruleDraft.length === 0) ruleDraft.push(emptyRule());
      markRulesChanged();
      renderRulesEditor();
    });
  });
}

// After a preview, any edit to the draft invalidates it until re-previewed.
function markRulesChanged() {
  if (rulePreviewData) {
    rulePreviewStale = true;
    renderRulesPreview();
  }
}

function collectRules() {
  return ruleDraft.map((r) => ({
    name: r.name,
    judge: r.judge || null,
    item: r.item || null,
    raw_min: r.raw_min === "" ? null : Number(r.raw_min),
    raw_max: r.raw_max === "" ? null : Number(r.raw_max),
    cal_min: r.cal_min === "" ? null : Number(r.cal_min),
    cal_max: r.cal_max === "" ? null : Number(r.cal_max),
    use_raw: r.use_raw,
    reason_template: r.reason_template,
    priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
  }));
}

function condSummary(r) {
  const parts = [];
  parts.push(r.judge ? `评委=${esc(r.judge)}` : "评委不限");
  parts.push(r.item ? `项目=${esc(r.item)}` : "项目不限");
  const iv = (lo, hi, label) => {
    if (lo === null || lo === undefined) {
      return hi === null || hi === undefined ? `${label}不限` : `${label}≤${fmt(hi)}`;
    }
    return hi === null || hi === undefined ? `${label}≥${fmt(lo)}` : `${fmt(lo)}≤${label}≤${fmt(hi)}`;
  };
  parts.push(iv(r.raw_min, r.raw_max, "原分"));
  parts.push(iv(r.cal_min, r.cal_max, "校准"));
  return parts.join("，");
}

function renderRulesPreview() {
  if (!rulePreviewData) {
    rulesPreviewEl.innerHTML = "";
    return;
  }
  const p = rulePreviewData;
  const banner = `
    <div class="rules-banner">
      预览（校准范围：<b>${esc(p.scope_label)}</b>，只读不落库）｜
      共 <b>${p.total_scores}</b> 条评分：命中 <b class="delta-up">${p.matched}</b>，
      未命中 <b>${p.unmatched}</b>；其中被多条规则同时命中（冲突）<b class="delta-down">${p.conflicted}</b> 条，
      已按优先级数字小者优先、同值按顺序前者优先裁决出唯一结果。
      相对当前裁决，预计实际变更 <b>${p.would_change}</b> 条。
      本次提交 ${p.rules_submitted} 条规则，库中已保存 ${p.rules_saved} 条。
      ${rulePreviewStale ? '<div class="stale-warn">⚠ 规则在预览后又被修改，以下结果已过期；应用前请重新预览。</div>' : ""}
    </div>`;

  const ruleRows = p.rules.map((r, i) => {
    const src = ruleDraft[i] || {};
    const conflictCls = r.conflicts > 0 ? " has-conflict" : "";
    return `
    <tr class="${conflictCls}">
      <td class="num">#${i + 1}</td>
      <td>${esc(src.name || "")}</td>
      <td class="num"><b>${r.priority}</b></td>
      <td>${condSummary({
        judge: src.judge, item: src.item,
        raw_min: src.raw_min === "" || src.raw_min === undefined ? null : Number(src.raw_min),
        raw_max: src.raw_max === "" || src.raw_max === undefined ? null : Number(src.raw_max),
        cal_min: src.cal_min === "" || src.cal_min === undefined ? null : Number(src.cal_min),
        cal_max: src.cal_max === "" || src.cal_max === undefined ? null : Number(src.cal_max),
      })}</td>
      <td>${r.use_raw ? "保留原分" : "采用校准分"}</td>
      <td class="num"><b>${r.hits}</b></td>
      <td class="num">${r.misses}</td>
      <td class="num">${r.conflicts ? `<span class="delta-down">${r.conflicts}</span>` : "0"}</td>
      <td class="num"><b>${r.wins}</b></td>
    </tr>`;
  }).join("");

  const matchedA = p.assignments.filter((a) => a.matched);
  const unmatchedA = p.assignments.filter((a) => !a.matched);
  const detailRows = matchedA.map((a) => {
    const winners = a.winner_index + 1;
    const conflictNote = a.matched_rule_indexes.length > 1
      ? `<span class="conflict-tag">冲突 ${a.matched_rule_indexes.length} 条，#${winners} 胜出</span>`
      : "";
    return `
    <tr class="matched-row">
      <td class="num">#${winners}</td>
      <td>${esc(a.contestant)}</td><td>${esc(a.judge)}</td><td>${esc(a.item)}</td>
      <td class="num">${fmt(a.raw)}</td><td class="num">${fmt(a.calibrated)}</td>
      <td><b>${a.use_raw ? "保留原分" : "采用校准分"}</b> ${conflictNote}</td>
      <td>${esc(a.reason)}</td>
    </tr>`;
  }).join("");

  rulesPreviewEl.innerHTML = banner + `
    <div class="table-wrap">
      <table>
        <tr><th class="num">#</th><th>规则名称</th><th class="num">优先级</th><th>条件</th><th>裁决</th>
        <th class="num">命中数</th><th class="num">未命中数</th><th class="num">冲突数</th><th class="num">胜出数</th></tr>
        ${ruleRows}
      </table>
    </div>
    <details class="assign-details" ${matchedA.length ? "open" : ""}>
      <summary>逐条裁决预览（命中 ${matchedA.length} 条 / 未命中 ${unmatchedA.length} 条，未命中评分保持现有裁决不变）</summary>
      <div class="table-wrap">
        <table>
          <tr><th class="num">胜出规则</th><th>选手</th><th>评委</th><th>项目</th>
          <th class="num">原始分</th><th class="num">校准分</th><th>裁决结果</th><th>理由</th></tr>
          ${detailRows || '<tr><td colspan="8" class="no-reversal">没有任何评分被命中。</td></tr>'}
        </table>
      </div>
    </details>`;
}

$("#btn-rule-add").addEventListener("click", () => {
  ruleDraft.push(emptyRule());
  markRulesChanged();
  renderRulesEditor();
});

$("#btn-rule-preview").addEventListener("click", async () => {
  setRulesMsg("预览计算中…");
  try {
    rulePreviewData = await api(`/api/sessions/${SESSION_ID}/rules/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: collectRules() }),
    });
    rulePreviewStale = false;
    setRulesMsg("预览完成：未保存任何数据。", "ok");
    renderRulesPreview();
  } catch (err) {
    rulePreviewData = null;
    renderRulesPreview();
    setRulesMsg(err.message, "error");
    toast("预览失败：" + err.message, true);
  }
});

$("#btn-rule-save").addEventListener("click", async () => {
  try {
    const r = await api(`/api/sessions/${SESSION_ID}/rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: collectRules() }),
    });
    setRulesMsg(`已保存 ${r.saved} 条规则（未改动任何裁决）。`, "ok");
    toast(`已保存 ${r.saved} 条规则`);
  } catch (err) {
    setRulesMsg(err.message, "error");
    toast("保存规则失败：" + err.message, true);
  }
});

$("#btn-rule-apply").addEventListener("click", async () => {
  let p = rulePreviewData;
  if (!p) {
    toast("请先预览规则再应用。", true);
    return;
  }
  if (rulePreviewStale) {
    toast("规则自上次预览后已修改，请重新预览后再应用。", true);
    return;
  }
  if (!confirm(`确认应用规则批处理？\n命中 ${p.matched} 条评分（其中冲突 ${p.conflicted} 条已按优先级裁决），未命中 ${p.unmatched} 条保持不变，预计实际变更 ${p.would_change} 条。\n规则与全部裁决将在同一个事务中写入。`)) return;
  setRulesMsg("正在一个事务中批量写入…");
  try {
    analysis = await api(`/api/sessions/${SESSION_ID}/rules/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: collectRules() }),
    });
    stability = null; // 裁决已变，稳定性实验结果作废
    rulePreviewData = null;
    rulePreviewStale = false;
    render();
    renderRulesPreview();
    setRulesMsg(
      `已在同一事务中保存 ${analysis.rules_saved} 条规则，写入裁决 ${analysis.written} 条，实际变更 ${analysis.changed} 条；排名已刷新。`,
      "ok",
    );
    toast(`批处理完成：变更 ${analysis.changed} 条，排名已刷新`);
  } catch (err) {
    setRulesMsg(err.message, "error");
    toast("批处理失败（未写入任何数据）：" + err.message, true);
  }
});

$("#btn-rule-clear").addEventListener("click", async () => {
  if (!confirm("清空面板中的全部规则？（仅清空编辑区与已保存规则，不改动已有裁决；如未保存请先应用）")) return;
  try {
    await api(`/api/sessions/${SESSION_ID}/rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: [] }),
    });
    ruleDraft = [emptyRule()];
    rulePreviewData = null;
    renderRulesEditor();
    renderRulesPreview();
    setRulesMsg("已清空全部规则（裁决未改动）。", "ok");
  } catch (err) {
    setRulesMsg(err.message, "error");
    toast("清空规则失败：" + err.message, true);
  }
});

// ---------- Decision updates ----------
let inflight = false;
let queued = null;

function currentState(scoreId) {
  for (const b of analysis.contestants) {
    for (const ib of b.items) {
      for (const s of ib.scores) {
        if (s.id === scoreId) return s;
      }
    }
  }
  return null;
}

async function pushDecision(scoreId, useRaw, reason) {
  if (inflight) {
    queued = { scoreId, useRaw, reason };
    return;
  }
  inflight = true;
  try {
    analysis = await api(
      `/api/sessions/${SESSION_ID}/scores/${scoreId}/decision`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ use_raw: useRaw, reason }),
      }
    );
    stability = null; // 裁决变化会改变最终总分，实验结果作废
    rulePreviewData = null;
    render();
    renderRulesPreview();
    toast("排名已实时重算");
  } catch (err) {
    toast("保存失败：" + err.message, true);
    await loadAnalysis(); // resync from server
  } finally {
    inflight = false;
    if (queued) {
      const q = queued;
      queued = null;
      pushDecision(q.scoreId, q.useRaw, q.reason);
    }
  }
}

function onChoiceChange(ev) {
  const row = ev.target.closest(".score-row");
  const scoreId = Number(row.dataset.id);
  const useRaw = ev.target.value === "raw";
  const reasonInput = row.querySelector(".reason-input");
  pushDecision(scoreId, useRaw, reasonInput.value);
}

const reasonTimers = new Map();
function onReasonInput(ev) {
  const scoreId = Number(ev.target.dataset.id);
  clearTimeout(reasonTimers.get(scoreId));
  reasonTimers.set(scoreId, setTimeout(() => {
    const s = currentState(scoreId);
    if (s) pushDecision(scoreId, s.use_raw, ev.target.value);
  }, 500));
}

// ---------- Data actions ----------
async function loadAnalysis() {
  try {
    analysis = await api(`/api/sessions/${SESSION_ID}/analysis`);
    stability = null;
    render();
  } catch (_) {
    analysis = null;
    stability = null;
    ruleDraft = null;
    rulePreviewData = null;
    render();
  }
}

function setMsg(text, cls = "") {
  const el = $("#import-msg");
  el.textContent = text;
  el.className = "msg " + cls;
}

$("#file-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const scope = document.querySelector('input[name="scope"]:checked').value;
  setMsg("上传中…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    analysis = await api(`/api/sessions/${SESSION_ID}/upload?scope=${encodeURIComponent(scope)}`, {
      method: "POST",
      body: fd,
    });
    stability = null;
    ruleDraft = null;
    rulePreviewData = null;
    render();
    renderRulesPreview();
    setMsg(`已导入 ${analysis.counts.scores} 条评分`, "ok");
    toast("上传成功，已完成稳健标准化");
  } catch (err) {
    setMsg(err.message, "error");
    toast("上传失败：" + err.message, true);
  } finally {
    ev.target.value = "";
  }
});

$("#btn-sample").addEventListener("click", async () => {
  const scope = document.querySelector('input[name="scope"]:checked').value;
  setMsg("载入示例中…");
  try {
    analysis = await api(`/api/sessions/${SESSION_ID}/sample?scope=${encodeURIComponent(scope)}`, {
      method: "POST",
    });
    stability = null;
    ruleDraft = null;
    rulePreviewData = null;
    render();
    renderRulesPreview();
    setMsg(`示例数据已载入（${analysis.counts.scores} 条评分）`, "ok");
    toast("示例数据已载入");
  } catch (err) {
    setMsg(err.message, "error");
    toast("载入失败：" + err.message, true);
  }
});

document.querySelectorAll('input[name="scope"]').forEach((radio) => {
  radio.addEventListener("change", async (ev) => {
    if (!analysis || analysis.counts.scores === 0) return;
    try {
      analysis = await api(`/api/sessions/${SESSION_ID}/scope`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: ev.target.value }),
      });
      stability = null; // 实验按校准范围重算，旧结果与新基线无关
      rulePreviewData = null; // 校准分依赖范围，区间命中结果需重新预览
      render();
      renderRulesPreview();
      toast("校准范围已切换");
    } catch (err) {
      toast("切换失败：" + err.message, true);
      loadAnalysis();
    }
  });
});

$("#btn-reset-decisions").addEventListener("click", async () => {
  if (!confirm("确定清除全部「保留原分」裁决与理由，统一恢复为采用校准分？")) return;
  try {
    analysis = await api(`/api/sessions/${SESSION_ID}/decisions/reset`, { method: "POST" });
    stability = null;
    rulePreviewData = null;
    render();
    renderRulesPreview();
    toast("已全部恢复为采用校准分");
  } catch (err) {
    toast("操作失败：" + err.message, true);
  }
});

$("#btn-export").addEventListener("click", () => {
  window.location.href = `/api/sessions/${SESSION_ID}/export`;
});

$("#btn-clear").addEventListener("click", async () => {
  if (!confirm("确定清空当前会话？\n将删除本会话上传的全部评分、裁决与理由（数据仅保存在容器卷中，不可恢复）。")) return;
  try {
    await api(`/api/sessions/${SESSION_ID}`, { method: "DELETE" });
    analysis = null;
    stability = null;
    ruleDraft = null;
    rulePreviewData = null;
    render();
    renderRulesPreview();
    setMsg("会话已清空。");
    toast("会话已清空");
  } catch (err) {
    toast("清空失败：" + err.message, true);
  }
});

// ---------- Ranking stability experiment actions ----------
stabilityTypeSel.addEventListener("change", syncStabilityControls);

stabilityBtnRun.addEventListener("click", async () => {
  const type = stabilityTypeSel.value;
  const name = stabilityNameSel.value;
  if (!name) {
    setStabilityMsg(`请先选择要排除的${type === "judge" ? "评委" : "项目"}。`, "error");
    return;
  }
  setStabilityMsg("计算中…");
  try {
    stability = await api(`/api/sessions/${SESSION_ID}/stability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exclude_type: type, exclude_name: name }),
    });
    setStabilityMsg("实验完成（临时结果，未保存）", "ok");
    renderStability();
  } catch (err) {
    stability = null;
    setStabilityMsg(err.message, "error");
    renderStability();
    toast("实验失败：" + err.message, true);
  }
});

stabilityBtnClear.addEventListener("click", () => clearStability());

// ---------- Two-contestant comparison ----------
const compareSelA = $("#compare-a");
const compareSelB = $("#compare-b");
const compareResultEl = $("#compare-result");

function setCompareMsg(text, cls = "") {
  const el = $("#compare-msg");
  el.textContent = text;
  el.className = "msg " + cls;
}

// Refresh both selects from the current contestant list, keeping selections.
function syncCompareSelects() {
  const names = analysis && analysis.counts.scores > 0
    ? analysis.contestants.map((b) => b.contestant)
    : [];
  const prevA = compareSelA.value;
  const prevB = compareSelB.value;
  const opts =
    `<option value="" disabled selected>请选择选手…</option>` +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  compareSelA.innerHTML = opts;
  compareSelB.innerHTML = opts;
  if (names.includes(prevA)) compareSelA.value = prevA;
  else if (names.length) compareSelA.value = names[0];
  if (names.includes(prevB)) compareSelB.value = prevB;
  else if (names.length > 1) compareSelB.value = names[1];
  const enabled = names.length >= 2;
  compareSelA.disabled = !enabled;
  compareSelB.disabled = !enabled;
}

function renderCompare() {
  syncCompareSelects();
  const a = compareSelA.value;
  const b = compareSelB.value;
  // 任何「不展示」分支都让在途请求作废，避免其返回后覆盖面板。
  const abortView = (msg = "", isError = false) => {
    comparison = null;
    comparePending = null;
    compareReqId++;
    compareResultEl.innerHTML = "";
    setCompareMsg(msg, isError ? "error" : "");
  };
  if (!analysis || analysis.counts.scores === 0) {
    abortView();
    return;
  }
  if (analysis.counts.contestants < 2) {
    abortView("当前数据不足两名选手，无法对比。");
    return;
  }
  if (!a || !b) {
    abortView("请在两侧各选择一名选手。");
    return;
  }
  if (a === b) {
    abortView("请选择两名不同的选手。", true);
    return;
  }
  // 选择有效：结果与当前选择不符且没有对应请求在途时，发起/补发展示请求。
  const matches = (x) => x && x.a === a && x.b === b;
  if (!matches(comparison)) {
    if (!matches(comparePending)) requestCompare(a, b); // 在途的是别的选择：作废旧请求并发起新请求
    return; // 同一对选手的请求仍在途则等其返回
  }
  renderCompareResult();
}

async function requestCompare(a, b) {
  const reqId = ++compareReqId;
  comparePending = { a, b, reqId };
  setCompareMsg("计算中…");
  try {
    const data = await api(`/api/sessions/${SESSION_ID}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contestant_a: a, contestant_b: b }),
    });
    if (!comparePending || comparePending.reqId !== reqId) {
      return; // 已有更新的选择或数据刷新，过期响应丢弃
    }
    comparePending = null;
    comparison = data;
    setCompareMsg("");
    renderCompareResult();
  } catch (err) {
    if (!comparePending || comparePending.reqId !== reqId) return;
    comparePending = null;
    comparison = null;
    compareResultEl.innerHTML = "";
    setCompareMsg(err.message, "error");
  }
}

function compareVal(v) {
  return v === null || v === undefined
    ? `<span class="compare-nodata">无数据</span>`
    : fmt(v);
}

// Difference = A − B; null when either side lacks the item.
function compareDiff(diff) {
  if (diff === null || diff === undefined) {
    return `<span class="compare-nodata">—</span>`;
  }
  if (diff > 0) return `<span class="delta-up">${signedNum(diff)}</span>`;
  if (diff < 0) return `<span class="delta-down">${signedNum(diff)}</span>`;
  return `<span class="delta-flat">0.00（持平）</span>`;
}

function leaderText(leader, aName, bName) {
  if (leader === "a") return `<span class="delta-up">${esc(aName)} 领先</span>`;
  if (leader === "b") return `<span class="delta-down">${esc(bName)} 领先</span>`;
  if (leader === "tie") return `<span class="delta-flat">持平</span>`;
  return `<span class="compare-nodata">无数据</span>`;
}

function summaryPill(kind, label, st, aName, bName) {
  return `<span class="compare-pill compare-pill-${kind}">
      <b>${label}</b>：
      <span class="delta-up">${esc(aName)} ${st.a_leads}</span> 项领先 ／
      <span class="delta-down">${esc(bName)} ${st.b_leads}</span> 项领先 ／
      <span class="delta-flat">持平 ${st.ties}</span> 项 ／
      <span class="compare-nodata">无数据 ${st.no_data}</span> 项
    </span>`;
}

function renderCompareResult() {
  const cmp = comparison;
  if (!cmp) {
    compareResultEl.innerHTML = "";
    return;
  }
  const aName = cmp.a.contestant;
  const bName = cmp.b.contestant;

  const head = `
    <div class="compare-head">
      <div class="compare-side compare-side-a">
        <span class="compare-side-tag">选手 A</span>
        <b class="compare-name">${esc(aName)}</b>
        <small>最终名次 ${cmp.totals.eff.a_rank} ｜ ${cmp.a.item_count} 个项目 ｜ 保留原分 ${cmp.a.raw_overrides} 条</small>
      </div>
      <div class="compare-vsbig">VS</div>
      <div class="compare-side compare-side-b">
        <span class="compare-side-tag">选手 B</span>
        <b class="compare-name">${esc(bName)}</b>
        <small>最终名次 ${cmp.totals.eff.b_rank} ｜ ${cmp.b.item_count} 个项目 ｜ 保留原分 ${cmp.b.raw_overrides} 条</small>
      </div>
    </div>`;

  // 三类总分对比（差值均为 A − B；总分各自只汇总本人有评分的项目）
  const totalRows = (["raw", "cal", "eff"]).map((kind) => {
    const t = cmp.totals[kind];
    return `
      <tr>
        <th>${cmp.kind_labels[kind]}总分</th>
        <td class="num${t.leader === "a" ? " lead-cell" : ""}">${fmt(t.a)}<br><small>名次 ${t.a_rank}</small></td>
        <td class="num${t.leader === "b" ? " lead-cell" : ""}">${fmt(t.b)}<br><small>名次 ${t.b_rank}</small></td>
        <td class="num">${compareDiff(t.diff)}</td>
        <td>${leaderText(t.leader, aName, bName)}</td>
      </tr>`;
  }).join("");

  const totalsTable = `
    <h3 class="sub">总分对比 <small style="font-weight:400">（差值＝A−B）</small></h3>
    <div class="table-wrap"><table class="compare-total-table">
      <tr><th></th><th class="num">${esc(aName)}（A）</th><th class="num">${esc(bName)}（B）</th>
      <th class="num">差值</th><th>领先方</th></tr>
      ${totalRows}
    </table></div>`;

  // 逐项目对比；缺项标无数据，不参与差值/胜负
  const itemRows = cmp.items.map((r) => {
    const missingNote = !r.a_present || !r.b_present
      ? `<br><small class="compare-nodata">${!r.a_present ? esc(aName) + " 无此项目评分" : ""}${!r.a_present && !r.b_present ? "；" : ""}${!r.b_present ? esc(bName) + " 无此项目评分" : ""}</small>`
      : "";
    return `
    <tr${(!r.a_present || !r.b_present) ? ' class="nodata-row"' : ""}>
      <td><b>${esc(r.item)}</b>
        <small style="color:var(--muted)">（A ${r.a_n_scores} 位评委 ／ B ${r.b_n_scores} 位评委）</small>${missingNote}</td>
      <td class="num${r.raw_leader === "a" ? " lead-cell" : ""}">${compareVal(r.a_raw)}</td>
      <td class="num${r.raw_leader === "b" ? " lead-cell" : ""}">${compareVal(r.b_raw)}</td>
      <td class="num">${compareDiff(r.raw_diff)}</td>
      <td>${leaderText(r.raw_leader, aName, bName)}</td>
      <td class="num${r.cal_leader === "a" ? " lead-cell" : ""}">${compareVal(r.a_cal)}</td>
      <td class="num${r.cal_leader === "b" ? " lead-cell" : ""}">${compareVal(r.b_cal)}</td>
      <td class="num">${compareDiff(r.cal_diff)}</td>
      <td>${leaderText(r.cal_leader, aName, bName)}</td>
      <td class="num${r.eff_leader === "a" ? " lead-cell" : ""}">${compareVal(r.a_eff)}</td>
      <td class="num${r.eff_leader === "b" ? " lead-cell" : ""}">${compareVal(r.b_eff)}</td>
      <td class="num">${compareDiff(r.eff_diff)}</td>
      <td>${leaderText(r.eff_leader, aName, bName)}</td>
    </tr>`;
  }).join("");

  const itemTable = cmp.items.length ? `
    <h3 class="sub">逐项目得分与差值 <small style="font-weight:400">（项目均分为各评委打分均值；缺项标无数据，不按零分计）</small></h3>
    <div class="table-wrap"><table class="compare-item-table">
      <tr>
        <th rowspan="2">项目</th>
        <th colspan="4" class="compare-group-head compare-group-raw">原始分</th>
        <th colspan="4" class="compare-group-head compare-group-cal">校准分</th>
        <th colspan="4" class="compare-group-head compare-group-eff">最终分</th>
      </tr>
      <tr>
        <th class="num">A</th><th class="num">B</th><th class="num">差值</th><th>领先</th>
        <th class="num">A</th><th class="num">B</th><th class="num">差值</th><th>领先</th>
        <th class="num">A</th><th class="num">B</th><th class="num">差值</th><th>领先</th>
      </tr>
      ${itemRows}
    </table></div>` : "";

  const banner = `
    <div class="compare-banner">
      校准范围：<b>${esc(cmp.scope_label)}</b> ｜ 逐项目胜负仅统计双方都有评分的项目
      （无数据不计零、不计入胜负）；总分按各人实际有评分的项目均分求和后直接相减：<br>
      ${summaryPill("raw", "原始", cmp.summary.raw, aName, bName)}
      ${summaryPill("cal", "校准", cmp.summary.cal, aName, bName)}
      ${summaryPill("eff", "最终", cmp.summary.eff, aName, bName)}
    </div>`;

  compareResultEl.innerHTML = head + totalsTable + itemTable + banner;
}

compareSelA.addEventListener("change", () => renderCompare());
compareSelB.addEventListener("change", () => renderCompare());

// ---------- Init ----------
loadAnalysis();
