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
let compareData = null; // 双选手对比结果（只读，不落库，每次由当前评分实时计算）
let compareReqId = 0; // 丢弃过期的对比响应
let ruleDraft = null; // 规则编辑器草稿（数组），DOM 是输入中的真实来源
let rulePreviewData = null; // 最近一次规则预览结果（只读，不落库）
let rulePreviewStale = false; // 草稿在预览后又被修改

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
function render() {
  if (!analysis || analysis.counts.scores === 0) {
    dashboard.hidden = true;
    emptyState.hidden = false;
    compareReqId += 1;
    compareData = null;
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
  refreshCompare();
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

// ---------- Head-to-head comparison ----------
const compareASel = $("#compare-a");
const compareBSel = $("#compare-b");

function setCompareMsg(text, cls = "") {
  const el = $("#compare-msg");
  el.textContent = text;
  el.className = "msg " + cls;
}

function fillCompareSelect(sel, prevVal) {
  const blocks = analysis && analysis.counts.scores > 0 ? analysis.contestants : [];
  sel.innerHTML =
    `<option value="" disabled${prevVal ? "" : " selected"}>请选择选手…</option>` +
    blocks
      .map((b) => `<option value="${esc(b.contestant)}">#${b.eff_rank} ${esc(b.contestant)}</option>`)
      .join("");
  if (blocks.some((b) => b.contestant === prevVal)) sel.value = prevVal;
}

function syncCompareControls() {
  const hasData = !!(analysis && analysis.counts.scores > 0);
  fillCompareSelect(compareASel, compareASel.value);
  fillCompareSelect(compareBSel, compareBSel.value);
  compareASel.disabled = !hasData;
  compareBSel.disabled = !hasData;
}

// Recompute the comparison whenever the underlying analysis changes
// (scope switch, decisions, re-upload) — nothing is stored client-side.
function refreshCompare() {
  syncCompareControls();
  const a = compareASel.value;
  const b = compareBSel.value;
  if (!analysis || analysis.counts.scores === 0 || !a || !b || a === b) {
    compareReqId += 1; // invalidate any in-flight response
    compareData = null;
    renderCompare();
    return;
  }
  if (compareData && (compareData.a !== a || compareData.b !== b)) {
    compareData = null; // selection changed; drop the stale pair immediately
    renderCompare();
  }
  const myId = ++compareReqId;
  setCompareMsg("对比计算中…");
  api(`/api/sessions/${SESSION_ID}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
    .then((data) => {
      if (myId !== compareReqId) return; // a newer request superseded this one
      compareData = data;
      setCompareMsg("");
      renderCompare();
    })
    .catch((err) => {
      if (myId !== compareReqId) return;
      compareData = null;
      setCompareMsg(err.message, "error");
      renderCompare();
    });
}

function renderCompare() {
  const panel = $("#compare-result");
  const a = compareASel.value;
  const b = compareBSel.value;
  if (!compareData) {
    if (a && b && a === b) {
      panel.innerHTML = `<p class="hint">选手 A 与选手 B 相同，请选择两名不同的选手。</p>`;
    } else if (a || b) {
      panel.innerHTML = `<p class="hint">再选择一名选手即可开始对比。</p>`;
    } else {
      panel.innerHTML = "";
    }
    return;
  }

  const t = compareData.totals;
  const ranks = compareData.ranks;
  const s = compareData.summary;

  const rankDiff = ranks.b.eff - ranks.a.eff; // >0: A 名次更靠前
  const rankCell =
    rankDiff > 0
      ? `<span class="delta-up">${esc(compareData.a)} 领先 ${rankDiff} 名</span>`
      : rankDiff < 0
        ? `<span class="delta-down">${esc(compareData.b)} 领先 ${-rankDiff} 名</span>`
        : `<span class="delta-flat">并列</span>`;

  const totalsRows = [
    ["原始总分", t.a.raw, t.b.raw, t.delta.raw, false],
    ["校准总分", t.a.cal, t.b.cal, t.delta.cal, false],
    ["最终总分", t.a.eff, t.b.eff, t.delta.eff, true],
  ]
    .map(
      ([label, va, vb, d, bold]) => `
    <tr>
      <td>${label}</td>
      <td class="num">${bold ? `<b>${fmt(va)}</b>` : fmt(va)}</td>
      <td class="num">${bold ? `<b>${fmt(vb)}</b>` : fmt(vb)}</td>
      <td class="num">${totalDeltaHtml(d)}</td>
    </tr>`,
    )
    .join("");

  const totalsTable = `
    <div class="table-wrap compare-totals-wrap"><table>
      <tr><th></th><th class="num">${esc(compareData.a)}</th><th class="num">${esc(compareData.b)}</th><th class="num">差值 (A−B)</th></tr>
      ${totalsRows}
      <tr><td>最终名次</td><td class="num"><b>${ranks.a.eff}</b></td><td class="num"><b>${ranks.b.eff}</b></td><td class="num">${rankCell}</td></tr>
    </table></div>`;

  const eff = s.eff;
  const statText = (k) => `${s[k].a_leads} / ${s[k].b_leads} / ${s[k].ties}`;
  const missing = [];
  if (s.a_only > 0) missing.push(`${s.a_only} 个项目仅 ${esc(compareData.a)} 有评分`);
  if (s.b_only > 0) missing.push(`${s.b_only} 个项目仅 ${esc(compareData.b)} 有评分`);
  const banner = `
    <div class="compare-banner">
      逐项目胜负（按最终分，共 <b>${s.compared}</b> 个可比项目）：
      <b>${esc(compareData.a)}</b> 领先 <b class="delta-up">${eff.a_leads}</b> 项 ｜
      <b>${esc(compareData.b)}</b> 领先 <b class="delta-down">${eff.b_leads}</b> 项 ｜
      持平 <b>${eff.ties}</b> 项。
      <span class="compare-note">（A胜 / B胜 / 持平）按原始分 ${statText("raw")}，按校准分 ${statText("cal")}。${missing.length ? missing.join("，") + "，已标为无数据、不计入差值与胜负统计。" : ""}</span>
    </div>`;

  const valCell = (snap, k, bold) =>
    snap
      ? `<td class="num">${bold ? `<b>${fmt(snap[k])}</b>` : fmt(snap[k])}</td>`
      : `<td class="num nodata">无数据</td>`;
  const deltaCell = (d, k) =>
    d ? `<td class="num">${totalDeltaHtml(d[k])}</td>` : `<td class="num nodata">—</td>`;
  const leadCell = (lead) => {
    if (lead === "a") return `<td><span class="delta-up">${esc(compareData.a)}</span></td>`;
    if (lead === "b") return `<td><span class="delta-down">${esc(compareData.b)}</span></td>`;
    if (lead === "tie") return `<td><span class="delta-flat">持平</span></td>`;
    return `<td><span class="delta-flat">—</span></td>`;
  };

  const head = `
    <tr>
      <th>项目</th>
      <th class="num">${esc(compareData.a)}<br>原始</th><th class="num">${esc(compareData.b)}<br>原始</th><th class="num">原始差<br>(A−B)</th>
      <th class="num">${esc(compareData.a)}<br>校准</th><th class="num">${esc(compareData.b)}<br>校准</th><th class="num">校准差<br>(A−B)</th>
      <th class="num">${esc(compareData.a)}<br>最终</th><th class="num">${esc(compareData.b)}<br>最终</th><th class="num">最终差<br>(A−B)</th>
      <th>领先<br>(最终)</th>
    </tr>`;
  const rows = compareData.items
    .map(
      (r) => `
    <tr>
      <td>${esc(r.item)}</td>
      ${valCell(r.a, "raw")}${valCell(r.b, "raw")}${deltaCell(r.delta, "raw")}
      ${valCell(r.a, "cal")}${valCell(r.b, "cal")}${deltaCell(r.delta, "cal")}
      ${valCell(r.a, "eff", true)}${valCell(r.b, "eff", true)}${deltaCell(r.delta, "eff")}
      ${leadCell(r.lead)}
    </tr>`,
    )
    .join("");

  panel.innerHTML =
    banner +
    totalsTable +
    `<h3 class="sub">逐项目对比（项目内各评委打分的均值）</h3>` +
    `<div class="table-wrap compare-table-wrap"><table>${head}${rows}</table></div>`;
}

compareASel.addEventListener("change", refreshCompare);
compareBSel.addEventListener("change", refreshCompare);

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

// ---------- Init ----------
loadAnalysis();
