const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  view: 'overview',
  hackathons: [],
  currentHackathon: null,
  submissions: [],
  selectedSubmission: null,
  batchRows: [],
  batchResults: [],
  batchEvaluating: false,
  criteria: [
    { name: 'Technical execution', description: 'Implementation quality, architecture, reliability and evidence of working engineering.', weight: 30 },
    { name: 'Innovation', description: 'Originality of the approach and quality of the idea.', weight: 25 },
    { name: 'Impact & usefulness', description: 'Problem relevance, user value and plausible real-world impact.', weight: 25 },
    { name: 'Product & demo quality', description: 'Usability, clarity of workflow and strength of demonstrated experience.', weight: 20 }
  ]
};

const escapeHtml = (v = '') => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function toast(message, type = 'info', duration = 4200) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.className = 'toast hidden', duration);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = { error: 'Server returned an unreadable response.' };
  }
  if (!response.ok && response.status !== 502) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return { data, response };
}

function navigate(view) {
  state.view = view;
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== `view-${view}`));
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const titles = {
    overview: ['Judging overview', 'OVERVIEW'],
    organizer: ['Create hackathon', 'PROGRAM SETUP'],
    submit: ['Submit a project', 'SUBMISSION INTAKE'],
    batch: ['Batch CSV evaluate', 'BATCH EVALUATION'],
    dashboard: ['Hackathon dashboard', 'JUDGING RESULTS']
  };
  if (titles[view]) {
    $('#page-title').textContent = titles[view][0];
    $('#crumb').textContent = titles[view][1];
  }
  if (view === 'overview') loadOverview();
  if (view === 'submit') fillHackathonSelect();
  if (view === 'batch') fillBatchHackathonSelect();
}

$$('[data-view]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
$$('[data-go]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.go)));
$('#top-create').addEventListener('click', () => navigate('organizer'));
$('#back-overview').addEventListener('click', () => navigate('overview'));
$('#dashboard-submit').addEventListener('click', () => {
  navigate('submit');
  if (state.currentHackathon) $('#submission-hackathon').value = state.currentHackathon.id;
});
$('#empty-submit').addEventListener('click', () => {
  navigate('submit');
  if (state.currentHackathon) $('#submission-hackathon').value = state.currentHackathon.id;
});

// Delete hackathon buttons
$('#dashboard-delete')?.addEventListener('click', () => {
  if (!state.currentHackathon) return;
  $('#delete-modal-msg').textContent = `This will permanently delete "${state.currentHackathon.name}" (ID ${state.currentHackathon.id}) and all its submissions. This cannot be undone.`;
  $('#delete-modal').classList.remove('hidden');
});

const closeDeleteModal = () => $('#delete-modal')?.classList.add('hidden');
$('#delete-cancel')?.addEventListener('click', closeDeleteModal);
$('#delete-modal-backdrop')?.addEventListener('click', closeDeleteModal);

$('#delete-confirm')?.addEventListener('click', async () => {
  if (!state.currentHackathon) return;
  const btn = $('#delete-confirm');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  try {
    await api(`/api/hackathons/${state.currentHackathon.id}`, { method: 'DELETE' });
    toast(`Hackathon "${state.currentHackathon.name}" deleted.`, 'success');
    closeDeleteModal();
    state.currentHackathon = null;
    navigate('overview');
  } catch (err) {
    toast(`Could not delete: ${err.message}`, 'error', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Yes, delete it';
  }
});

function renderCriteriaEditor() {
  const wrap = $('#criteria-editor');
  wrap.innerHTML = state.criteria.map((c, i) => `
    <div class="criterion-row" data-index="${i}">
      <input class="criterion-name" aria-label="Criterion name" value="${escapeHtml(c.name)}" placeholder="Criterion name">
      <input class="criterion-description" aria-label="Criterion description" value="${escapeHtml(c.description)}" placeholder="What should judges look for?">
      <input class="weight-input" aria-label="Weight percent" type="number" min="1" max="100" value="${num(c.weight)}">
      <button type="button" class="remove-criterion" aria-label="Remove criterion" title="Remove criterion" ${state.criteria.length === 1 ? 'disabled' : ''}>×</button>
    </div>
  `).join('');

  wrap.querySelectorAll('.criterion-row').forEach(row => {
    const i = Number(row.dataset.index);
    row.querySelector('.criterion-name').addEventListener('input', e => {
      state.criteria[i].name = e.target.value;
      renderRubricPreview();
    });
    row.querySelector('.criterion-description').addEventListener('input', e => {
      state.criteria[i].description = e.target.value;
    });
    row.querySelector('.weight-input').addEventListener('input', e => {
      state.criteria[i].weight = num(e.target.value);
      updateWeightTotal();
      renderRubricPreview();
    });
    row.querySelector('.remove-criterion').addEventListener('click', () => {
      state.criteria.splice(i, 1);
      renderCriteriaEditor();
      renderRubricPreview();
    });
  });
  updateWeightTotal();
  renderRubricPreview();
}

function updateWeightTotal() {
  const total = state.criteria.reduce((s, c) => s + num(c.weight), 0);
  const el = $('#weight-total');
  el.textContent = `${total}% total`;
  el.classList.toggle('invalid', Math.abs(total - 100) > .01);
}

function renderRubricPreview() {
  const total = state.criteria.reduce((s, c) => s + num(c.weight), 0) || 1;
  $('#rubric-bars').innerHTML = state.criteria.map(c => `
    <div class="rubric-bar">
      <div class="rubric-bar-head">
        <span>${escapeHtml(c.name || 'Untitled criterion')}</span>
        <span>${num(c.weight)}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.max(0, Math.min(100, num(c.weight) / total * 100))}%"></div>
      </div>
    </div>
  `).join('') || '<p class="muted">Add a criterion to preview your rubric.</p>';
}

$('#add-criterion').addEventListener('click', () => {
  if (state.criteria.length >= 12) {
    toast('Maximum of 12 criteria per hackathon.', 'error');
    return;
  }
  state.criteria.push({ name: 'New criterion', description: 'Describe what good evidence looks like.', weight: 0 });
  renderCriteriaEditor();
  const rows = $$('.criterion-row');
  rows[rows.length - 1]?.querySelector('.criterion-name')?.focus();
});

$('#create-form').addEventListener('submit', async e => {
  e.preventDefault();
  const criteria = state.criteria.map(c => ({ name: c.name.trim(), description: c.description.trim(), weight: num(c.weight) }));
  const total = criteria.reduce((s, c) => s + c.weight, 0);
  if (criteria.some(c => !c.name || c.weight <= 0)) {
    toast('Give every criterion a name and a positive weight.', 'error');
    return;
  }
  if (new Set(criteria.map(c => c.name.toLowerCase())).size !== criteria.length) {
    toast('Criterion names must be unique.', 'error');
    return;
  }
  if (Math.abs(total - 100) > .01) {
    toast(`Weights currently total ${total}%. Adjust them to exactly 100%.`, 'error');
    return;
  }
  const btn = $('#create-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';
  try {
    const { data } = await api('/api/hackathons', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#hack-name').value.trim(),
        track: $('#hack-track').value,
        description: $('#hack-description').value.trim(),
        criteria,
        requirements: $('#requirements').value.split('\n').map(x => x.trim()).filter(Boolean)
      })
    });
    toast(`Hackathon created. Submission ID: ${data.id}`, 'success', 7000);
    $('#create-form').reset();
    state.criteria = [
      { name: 'Technical execution', description: 'Implementation quality, architecture, reliability and evidence of working engineering.', weight: 30 },
      { name: 'Innovation', description: 'Originality of the approach and quality of the idea.', weight: 25 },
      { name: 'Impact & usefulness', description: 'Problem relevance, user value and plausible real-world impact.', weight: 25 },
      { name: 'Product & demo quality', description: 'Usability, clarity of workflow and strength of demonstrated experience.', weight: 20 }
    ];
    renderCriteriaEditor();
    await loadOverview();
    openHackathon(data.id);
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Create hackathon <span>→</span>';
  }
});

async function loadHealth() {
  try {
    const { data } = await api('/api/health');
    if (data.ai_configured) {
      $('#ai-status').textContent = 'AI model configured';
      const keyCount = data.api_keys_loaded ? ` (${data.api_keys_loaded} keys pooled)` : '';
      $('#ai-detail').textContent = (data.ai_model || 'Semantic assessment enabled') + keyCount;
      $('#stat-mode').textContent = 'AI review';
      $('#stat-mode-foot').textContent = 'Semantic scoring via configured endpoint';
    } else {
      $('#ai-status').textContent = 'Evidence baseline mode';
      $('#ai-detail').textContent = 'AI endpoint not configured';
      $('#stat-mode').textContent = 'Baseline';
      $('#stat-mode-foot').textContent = 'Structural signals only · no AI claims';
    }
  } catch {
    $('#ai-status').textContent = 'API unavailable';
    $('#ai-detail').textContent = 'Check the local server';
  }
}

async function loadOverview() {
  try {
    const { data: hacks } = await api('/api/hackathons');
    state.hackathons = hacks;
    let submissions = 0, overrides = 0;
    for (const h of hacks) {
      try {
        const { data } = await api(`/api/hackathons/${h.id}/submissions`);
        submissions += data.length;
        for (const s of data) {
          try {
            const d = await api(`/api/submissions/${s.id}`);
            overrides += (d.data.audit_log || []).filter(a => a.action === 'score_override').length;
          } catch {}
        }
      } catch {}
    }
    $('#stat-hackathons').textContent = hacks.length;
    $('#stat-submissions').textContent = submissions;
    $('#stat-overrides').textContent = overrides;
    $('#hackathon-count').textContent = `${hacks.length} program${hacks.length === 1 ? '' : 's'}`;
    $('#hackathon-list').innerHTML = hacks.map(h => `
      <article class="hackathon-card" data-open-hack="${h.id}">
        <div class="hackathon-card-top">
          <span class="track-tag">${escapeHtml(h.track)}</span>
          <span class="muted">ID ${h.id}</span>
        </div>
        <h4>${escapeHtml(h.name)}</h4>
        <p>${escapeHtml(h.description || 'No description added.')} </p>
        <div class="card-meta">
          <span>◈ ${h.submission_count || 0} submission${h.submission_count === 1 ? '' : 's'}</span>
          <strong>Open dashboard →</strong>
        </div>
      </article>
    `).join('');
    $('#empty-hackathons').classList.toggle('hidden', hacks.length > 0);
    $('#hackathon-list').classList.toggle('hidden', hacks.length === 0);
    $$('[data-open-hack]').forEach(el => el.addEventListener('click', () => openHackathon(Number(el.dataset.openHack))));
    fillHackathonSelect();
    fillBatchHackathonSelect();
  } catch (err) {
    toast(`Could not load workspace: ${err.message}`, 'error');
  }
}

async function fillHackathonSelect() {
  const select = $('#submission-hackathon');
  const prior = select.value;
  try {
    if (!state.hackathons.length) {
      const { data } = await api('/api/hackathons');
      state.hackathons = data;
    }
    select.innerHTML = '<option value="">Select a hackathon…</option>' + state.hackathons.map(h => `<option value="${h.id}">${escapeHtml(h.name)} — ID ${h.id}</option>`).join('');
    if (prior) select.value = prior;
    else if (state.currentHackathon && state.currentHackathon.id) select.value = state.currentHackathon.id;
  } catch {}
}

async function fillBatchHackathonSelect() {
  const select = $('#batch-hackathon');
  if (!select) return;
  const prior = select.value;
  try {
    if (!state.hackathons.length) {
      const { data } = await api('/api/hackathons');
      state.hackathons = data;
    }
    select.innerHTML = '<option value="">Select a hackathon…</option>' + state.hackathons.map(h => `<option value="${h.id}">${escapeHtml(h.name)} — ID ${h.id} (${escapeHtml(h.track)})</option>`).join('');
    if (prior) select.value = prior;
    else if (state.currentHackathon && state.currentHackathon.id) select.value = state.currentHackathon.id;
    updateBatchStartBtn();
  } catch {}
}

$('#batch-hackathon')?.addEventListener('change', updateBatchStartBtn);

async function openHackathon(id) {
  try {
    const [{ data: h }, { data: s }] = await Promise.all([
      api(`/api/hackathons/${id}`),
      api(`/api/hackathons/${id}/submissions`)
    ]);
    state.currentHackathon = h;
    state.submissions = s;
    navigate('dashboard');
    renderDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderDashboard() {
  const h = state.currentHackathon, s = state.submissions;
  $('#dashboard-name').textContent = h.name;
  $('#dashboard-description').textContent = h.description || 'Review submissions against the organiser-defined rubric.';
  $('#dashboard-track').textContent = h.track;
  $('#dash-total').textContent = s.length;
  $('#dash-assessed').textContent = s.filter(x => x.status === 'EVALUATED').length;
  $('#dash-top').textContent = s.length && s[0].score !== null ? Number(s[0].score).toFixed(1) : '—';
  $('#dash-overrides').textContent = '…';
  $('#submission-list').innerHTML = s.map((x, i) => {
    const score = x.score === null || x.score === undefined ? '—' : Number(x.score).toFixed(1);
    const method = x.assessment_method || 'pending';
    return `
      <article class="submission-card">
        <div class="submission-card-head">
          <div>
            <span class="rank-label">RANK #${i + 1} · ${escapeHtml(x.team_name)}</span>
            <h4>${escapeHtml(x.project_name)}</h4>
            <div class="team-line">
              <a href="${escapeHtml(x.github_url)}" target="_blank" rel="noopener noreferrer" style="color:#b8a8ff;text-decoration:none">↗ GitHub repository</a>
              ${x.demo_url ? `· <a href="${escapeHtml(x.demo_url)}" target="_blank" rel="noopener noreferrer" style="color:#b8a8ff;text-decoration:none">Live demo</a>` : ''}
            </div>
          </div>
          <div class="score-block">
            <div class="score-number">${score}<small> / 100</small></div>
            <div class="score-caption">FINAL SCORE</div>
          </div>
        </div>
        <div class="submission-card-foot">
          <div class="submission-meta">
            <span class="method-tag ${method === 'ai' ? '' : 'baseline'}">${method === 'ai' ? 'AI ASSESSMENT' : method === 'evidence-baseline' ? 'STRUCTURAL BASELINE' : escapeHtml(method.toUpperCase())}</span>
            <span class="${x.status === 'ASSESSMENT_ERROR' ? 'status-tag error' : 'status-tag'}">${escapeHtml(x.status.replaceAll('_', ' '))}</span>
            <span>${escapeHtml(new Date(x.created_at).toLocaleString())}</span>
          </div>
          <div class="card-actions">
            <button class="small-button" data-detail="${x.id}">View evidence & scores</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
  $('#empty-submissions').classList.toggle('hidden', s.length > 0);
  $('#submission-list').classList.toggle('hidden', s.length === 0);
  $$('[data-detail]').forEach(b => b.addEventListener('click', () => openSubmission(Number(b.dataset.detail))));
  updateDashboardAuditCount();
}

async function updateDashboardAuditCount() {
  let count = 0;
  for (const s of state.submissions) {
    try {
      const { data } = await api(`/api/submissions/${s.id}`);
      count += (data.audit_log || []).filter(a => a.action === 'score_override').length;
    } catch {}
  }
  $('#dash-overrides').textContent = count;
}

$('#submission-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#evaluate-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Collecting evidence…';
  try {
    const { data, response } = await api('/api/submissions', {
      method: 'POST',
      body: JSON.stringify({
        hackathon_id: $('#submission-hackathon').value,
        team_name: $('#team-name').value.trim(),
        project_name: $('#project-name').value.trim(),
        github_url: $('#github-url').value.trim(),
        demo_url: $('#demo-url').value.trim(),
        notes: $('#submission-notes').value.trim()
      })
    });
    if (response.status === 502 || data.status === 'ASSESSMENT_ERROR') {
      toast('Submission saved, but assessment failed. Open it to inspect the error; no score was invented.', 'error', 7000);
    } else {
      toast(data.assessment_method === 'evidence-baseline' ? 'Assessment complete using structural baseline. Configure an AI endpoint for semantic judging.' : 'Evidence collected and AI assessment complete.', 'success', 7000);
    }
    $('#team-name').value = '';
    $('#project-name').value = '';
    $('#github-url').value = '';
    $('#demo-url').value = '';
    $('#submission-notes').value = '';
    await openHackathon(Number(data.hackathon_id));
    if (data.id) await openSubmission(data.id);
  } catch (err) {
    toast(err.message, 'error', 7000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Collect evidence & evaluate <span>→</span>';
  }
});

function listHtml(items, empty = 'None recorded.') {
  if (!Array.isArray(items) || !items.length) return `<p>${escapeHtml(empty)}</p>`;
  return `<ul>${items.map(x => escapeHtml(typeof x === 'string' ? x : JSON.stringify(x))).map(x => `<li>${x}</li>`).join('')}</ul>`;
}

async function openSubmission(id) {
  try {
    const { data: s } = await api(`/api/submissions/${id}`);
    state.selectedSubmission = s;
    const e = s.evaluation || {}, ev = s.evidence || {}, repo = ev.repository || {}, signals = ev.signals || {};
    const isBaseline = s.assessment_method === 'evidence-baseline';
    $('#detail-content').innerHTML = `
      <div class="detail-head">
        <div class="eyebrow">SUBMISSION #${s.id} · ${escapeHtml(s.team_name)}</div>
        <h2>${escapeHtml(s.project_name)}</h2>
        <p><a href="${escapeHtml(s.github_url)}" target="_blank" rel="noopener noreferrer" style="color:#b8a8ff">Open GitHub repository ↗</a> ${s.demo_url ? ` · <a href="${escapeHtml(s.demo_url)}" target="_blank" rel="noopener noreferrer" style="color:#b8a8ff">Open live demo ↗</a>` : ''}</p>
      </div>
      <div class="detail-score-row">
        <div class="detail-score">${s.score === null || s.score === undefined ? '—' : Number(s.score).toFixed(1)}<small style="font-size:12px;color:#8c82ba"> / 100</small></div>
        <p><b>${isBaseline ? 'Structural baseline — not an AI judgement' : s.assessment_method === 'ai' ? 'AI assessment' : 'Assessment status: ' + s.status}</b><br>${escapeHtml(e.summary || e.error || 'No assessment summary available.')}</p>
      </div>
      ${e.error ? `<div class="caution-note">Assessment error: ${escapeHtml(e.error)}. Check API configuration or repository access, then submit again after fixing the issue.</div>` : ''}
      <div class="evidence-summary">
        <div class="evidence-stat"><b>${num(ev.file_count)}</b><small>TRACKED FILES</small></div>
        <div class="evidence-stat"><b>${num(repo.stars)}</b><small>GITHUB STARS</small></div>
        <div class="evidence-stat"><b>${escapeHtml(repo.language || '—')}</b><small>MAIN LANGUAGE</small></div>
      </div>
      <h3 class="detail-section-title">Criterion-by-criterion assessment</h3>
      ${Array.isArray(e.criteria) && e.criteria.length ? e.criteria.map(c => `
        <div class="criterion-result">
          <div class="criterion-result-head">
            <b>${escapeHtml(c.criterion)} <span style="font-weight:400;color:#8b90a4">· ${num(c.weight)}% weight</span></b>
            <span>${num(c.score).toFixed(1)} / 10</span>
          </div>
          <div class="bar-track" style="margin-top:10px">
            <div class="bar-fill" style="width:${Math.max(0, Math.min(100, num(c.score) * 10))}%"></div>
          </div>
          <p>${escapeHtml(c.rationale || 'No rationale supplied.')}</p>
          ${Array.isArray(c.evidence_refs) && c.evidence_refs.length ? `<div class="evidence-chips">${c.evidence_refs.map(r => `<span class="evidence-chip">${escapeHtml(r)}</span>`).join('')}</div>` : ''}
          ${Array.isArray(c.risks) && c.risks.length ? `<p style="color:#d6a98a">Risks: ${escapeHtml(c.risks.join(' · '))}</p>` : ''}
        </div>
      `).join('') : '<p class="muted">No criterion scores are available.</p>'}
      <div class="detail-grid">
        <div class="detail-box">
          <h4>Repository signals</h4>
          <ul>${Object.entries({ README: signals.has_readme, Tests: signals.has_tests, 'CI workflow': signals.has_ci, 'Dependency manifest': signals.has_dependency_manifest, 'Deployment config': signals.has_deployment_config, License: signals.has_license }).map(([k, v]) => `<li>${escapeHtml(k)}: <b style="color:${v ? '#72e0b0' : '#e2b18c'}">${v ? 'detected' : 'not detected'}</b></li>`).join('')}</ul>
          <p>Files tracked: ${num(ev.file_count)} · Branch: ${escapeHtml(repo.default_branch || '—')} · License: ${escapeHtml(repo.license || '—')}</p>
        </div>
        <div class="detail-box">
          <h4>Live demo check</h4>
          <p>${escapeHtml((ev.demo_inspection || {}).message || 'No demo inspection data.')}</p>
          ${(ev.demo_inspection || {}).title ? `<p>Page title: <b>${escapeHtml(ev.demo_inspection.title)}</b></p>` : ''}
          ${(ev.demo_inspection || {}).text_preview ? `<p>Visible text preview: ${escapeHtml(ev.demo_inspection.text_preview)}</p>` : ''}
        </div>
        <div class="detail-box">
          <h4>Strengths</h4>
          ${listHtml(e.strengths)}
        </div>
        <div class="detail-box">
          <h4>Risks & missing evidence</h4>
          ${listHtml([...(e.risks || []), ...(e.missing_evidence || []), ...((e.mandatory_requirements || []).map(r => `${r.requirement}: ${r.status} — ${r.evidence || ''}`))])}
        </div>
      </div>
      <h3 class="detail-section-title">Human score override</h3>
      <p class="muted">The override changes the final leaderboard score, not the original criterion scores. A reason and audit entry are required.</p>
      <form class="override-form" id="override-form">
        <label>Final score (0–100)<input id="override-score" type="number" min="0" max="100" step="0.1" value="${s.score === null || s.score === undefined ? '' : Number(s.score).toFixed(1)}" required></label>
        <label>Reason for change<input id="override-reason" required maxlength="1000" placeholder="Explain the human judgement"></label>
        <button class="button button-primary" type="submit">Save override</button>
      </form>
      <h3 class="detail-section-title">Audit trail</h3>
      <div id="audit-list">
        ${(s.audit_log || []).length ? s.audit_log.map(a => `<div class="audit-item"><b>${escapeHtml(a.action.replaceAll('_', ' '))}</b> · ${escapeHtml(a.actor)} · ${escapeHtml(a.created_at)}<br>${escapeHtml(a.reason)} ${a.old_value !== '' ? `(${escapeHtml(a.old_value)} → ${escapeHtml(a.new_value)})` : ''}</div>`).join('') : '<p class="muted">No audit events yet.</p>'}
      </div>
    `;
    $('#detail-modal').classList.remove('hidden');
    $('#override-form').addEventListener('submit', saveOverride);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveOverride(e) {
  e.preventDefault();
  const s = state.selectedSubmission;
  const score = $('#override-score').value, reason = $('#override-reason').value.trim();
  try {
    const { data } = await api(`/api/submissions/${s.id}/override`, {
      method: 'POST',
      body: JSON.stringify({ score, reason, actor: 'Human judge' })
    });
    toast('Human override saved and audit trail updated.', 'success');
    await openHackathon(data.hackathon_id);
    await openSubmission(data.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

$$('[data-close-modal]').forEach(el => el.addEventListener('click', () => $('#detail-modal').classList.add('hidden')));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    $('#detail-modal').classList.add('hidden');
    closeDeleteModal();
  }
});

// ═══════════════════════════════════════════════════════════════
// CSV BATCH EVALUATOR CLIENT LOGIC
// ═══════════════════════════════════════════════════════════════

function parseCSV(text) {
  const lines = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(cell.trim());
      if (row.some(c => c.length > 0)) lines.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some(c => c.length > 0)) lines.push(row);
  }
  if (lines.length < 2) return [];

  const headers = lines[0].map(h => h.trim().toLowerCase());
  const findCol = (candidates) => headers.findIndex(h => candidates.some(c => h === c || h.includes(c)));

  const projIdx = findCol(['project name', 'project_name', 'project', 'title', 'app name', 'app']);
  const repoIdx = findCol(['github repository link', 'github link', 'github url', 'github', 'repository link', 'repository', 'repo url', 'repo']);
  const teamIdx = findCol(['team name', 'team_name', 'team', 'author', 'participant', 'name', 'submitted by']);
  const demoIdx = findCol(['live demo url', 'demo url', 'demo link', 'demo', 'website']);
  const notesIdx = findCol(['description', 'notes', 'about', 'summary']);

  if (repoIdx === -1) {
    throw new Error('CSV must contain a GitHub Repository URL column (e.g. "GitHub Repository Link" or "GitHub URL").');
  }

  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i];
    if (!r.length || !r[repoIdx]) continue;
    const repo = r[repoIdx].trim();
    if (!repo) continue;
    const proj = (projIdx !== -1 && r[projIdx] ? r[projIdx].trim() : '') || `Project ${i}`;
    const team = (teamIdx !== -1 && r[teamIdx] ? r[teamIdx].trim() : '') || `Team ${i}`;
    const demo = demoIdx !== -1 && r[demoIdx] ? r[demoIdx].trim() : '';
    const notes = notesIdx !== -1 && r[notesIdx] ? r[notesIdx].trim() : '';
    results.push({
      project_name: proj,
      github_url: repo,
      team_name: team,
      demo_url: demo,
      notes: notes
    });
  }
  return results;
}

function updateBatchStartBtn() {
  const btn = $('#batch-start-btn');
  const hackId = $('#batch-hackathon')?.value;
  if (!btn) return;
  btn.disabled = !hackId || !state.batchRows.length || state.batchEvaluating;
}

function handleCSVFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.csv') && file.type !== 'text/csv' && file.type !== 'application/vnd.ms-excel') {
    toast('Please upload a valid .csv file.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target.result;
      const rows = parseCSV(content);
      if (!rows.length) {
        toast('No valid project rows found in the CSV. Make sure it contains rows with GitHub URLs.', 'error');
        return;
      }
      state.batchRows = rows;
      $('#csv-file-name').textContent = file.name;
      $('#csv-row-count').textContent = `${rows.length} projects`;

      // Render preview table
      const previewRows = rows.slice(0, 5);
      const thead = $('#csv-table thead');
      const tbody = $('#csv-table tbody');
      thead.innerHTML = '<tr><th>#</th><th>Project Name</th><th>Team</th><th>GitHub URL</th></tr>';
      tbody.innerHTML = previewRows.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><b>${escapeHtml(r.project_name)}</b></td>
          <td>${escapeHtml(r.team_name)}</td>
          <td><code style="font-size:0.75rem">${escapeHtml(r.github_url)}</code></td>
        </tr>
      `).join('');
      if (rows.length > 5) {
        tbody.innerHTML += `<tr><td colspan="4" class="muted" style="text-align:center;padding:8px">…and ${rows.length - 5} more projects</td></tr>`;
      }

      $('#csv-preview').classList.remove('hidden');
      updateBatchStartBtn();
      toast(`Loaded ${rows.length} projects from CSV. Ready to evaluate!`, 'success');
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  };
  reader.readAsText(file);
}

const dropZone = $('#csv-drop-zone');
const fileInput = $('#csv-file-input');

dropZone?.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone?.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});
dropZone?.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) {
    handleCSVFile(e.dataTransfer.files[0]);
  }
});
fileInput?.addEventListener('change', () => {
  if (fileInput.files.length) {
    handleCSVFile(fileInput.files[0]);
  }
});

$('#csv-clear')?.addEventListener('click', () => {
  state.batchRows = [];
  if (fileInput) fileInput.value = '';
  $('#csv-preview').classList.add('hidden');
  updateBatchStartBtn();
});

// START BATCH EVALUATION
$('#batch-start-btn')?.addEventListener('click', async () => {
  const hackId = $('#batch-hackathon')?.value;
  if (!hackId) {
    toast('Please select a target hackathon first.', 'error');
    return;
  }
  if (!state.batchRows.length) {
    toast('Please upload a CSV file with submissions.', 'error');
    return;
  }

  const delaySec = Math.max(1, Math.min(60, Number($('#batch-delay')?.value || 5)));
  state.batchEvaluating = true;
  state.batchResults = [];

  $('#batch-form-body').classList.add('hidden');
  $('#batch-progress-panel').classList.remove('hidden');
  $('#batch-results-panel').classList.add('hidden');

  const total = state.batchRows.length;
  const logEl = $('#batch-live-log');
  logEl.innerHTML = '';

  for (let i = 0; i < total; i++) {
    const item = state.batchRows[i];
    const numDisp = i + 1;

    $('#batch-progress-fraction').textContent = `${numDisp} / ${total}`;
    $('#batch-progress-title').textContent = `Evaluating "${item.project_name}" (${numDisp} of ${total})...`;
    $('#batch-progress-bar').style.width = `${Math.round((i / total) * 100)}%`;

    // Add log entry
    const logItem = document.createElement('div');
    logItem.className = 'log-item evaluating';
    logItem.innerHTML = `<span>⏳ [${numDisp}/${total}]</span> <b>${escapeHtml(item.project_name)}</b> <small>(${escapeHtml(item.team_name)})</small> — analyzing repository...`;
    logEl.prepend(logItem);

    let result = {
      project_name: item.project_name,
      team_name: item.team_name,
      github_url: item.github_url,
      demo_url: item.demo_url,
      score: null,
      status: 'PENDING',
      method: 'unknown',
      error: null
    };

    try {
      const { data, response } = await api('/api/submissions', {
        method: 'POST',
        body: JSON.stringify({
          hackathon_id: hackId,
          team_name: item.team_name,
          project_name: item.project_name,
          github_url: item.github_url,
          demo_url: item.demo_url,
          notes: item.notes
        })
      });

      if (response.status === 502 || data.status === 'ASSESSMENT_ERROR') {
        result.status = 'ERROR';
        result.error = data.evaluation?.error || 'Assessment failed';
        logItem.className = 'log-item error';
        logItem.innerHTML = `<span>⚠️ [${numDisp}/${total}]</span> <b>${escapeHtml(item.project_name)}</b> — assessment error: ${escapeHtml(result.error.substring(0, 80))}`;
      } else {
        result.status = data.status || 'EVALUATED';
        result.score = data.score !== null && data.score !== undefined ? Number(data.score) : 0;
        result.method = data.assessment_method || 'ai';
        result.submission_id = data.id;
        logItem.className = 'log-item done';
        logItem.innerHTML = `<span>✓ [${numDisp}/${total}]</span> <b>${escapeHtml(item.project_name)}</b> — evaluated! <span class="log-score">${result.score.toFixed(1)} / 100</span>`;
      }
    } catch (err) {
      result.status = 'ERROR';
      result.error = err.message;
      logItem.className = 'log-item error';
      logItem.innerHTML = `<span>✕ [${numDisp}/${total}]</span> <b>${escapeHtml(item.project_name)}</b> — network error: ${escapeHtml(err.message)}`;
    }

    state.batchResults.push(result);

    // Rate-limit delay between projects
    if (i < total - 1) {
      const waitNotice = document.createElement('div');
      waitNotice.className = 'log-item';
      waitNotice.style.opacity = '0.6';
      waitNotice.style.fontSize = '0.75rem';
      waitNotice.textContent = `Sleeping ${delaySec}s before next project...`;
      logEl.prepend(waitNotice);
      await sleep(delaySec * 1000);
      waitNotice.remove();
    }
  }

  // Finished!
  $('#batch-progress-bar').style.width = '100%';
  $('#batch-progress-fraction').textContent = `${total} / ${total}`;
  $('#batch-progress-title').textContent = `Batch evaluation complete (${total} projects)!`;
  state.batchEvaluating = false;

  renderBatchResults();
  toast('Batch evaluation finished!', 'success', 6000);
});

function renderBatchResults() {
  $('#batch-results-panel').classList.remove('hidden');
  const tbody = $('#batch-results-body');
  if (!tbody) return;

  // Sort descending by score
  const sorted = [...state.batchResults].sort((a, b) => (b.score || 0) - (a.score || 0));

  tbody.innerHTML = sorted.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    const scoreVal = r.score !== null ? r.score.toFixed(1) : '—';
    const scoreClass = r.score >= 80 ? 'high' : r.score >= 60 ? 'mid' : 'low';
    const isError = r.status === 'ERROR';

    return `
      <tr>
        <td><span class="rank-medal">${medal}</span></td>
        <td>
          <b>${escapeHtml(r.project_name)}</b><br>
          <a href="${escapeHtml(r.github_url)}" target="_blank" rel="noopener noreferrer" style="color:#b8a8ff;font-size:0.75rem">↗ GitHub repo</a>
        </td>
        <td>${escapeHtml(r.team_name)}</td>
        <td>
          ${isError ? '<span class="status-tag error">ERROR</span>' : `<span class="score-pill ${scoreClass}">${scoreVal} / 100</span>`}
        </td>
        <td><span class="${isError ? 'status-tag error' : 'status-tag'}">${escapeHtml(r.status)}</span></td>
        <td><span class="method-badge ${r.method === 'evidence-baseline' ? 'baseline' : ''}">${escapeHtml(r.method)}</span></td>
      </tr>
    `;
  }).join('');
}

// EXPORT RESULTS AS CSV
$('#batch-export-btn')?.addEventListener('click', () => {
  if (!state.batchResults.length) {
    toast('No batch results to export.', 'error');
    return;
  }
  const sorted = [...state.batchResults].sort((a, b) => (b.score || 0) - (a.score || 0));
  const headers = ['Rank', 'Project Name', 'Team Name', 'Score', 'Status', 'Assessment Method', 'GitHub URL', 'Live Demo URL', 'Error Details'];
  const rows = sorted.map((r, idx) => [
    idx + 1,
    `"${(r.project_name || '').replace(/"/g, '""')}"`,
    `"${(r.team_name || '').replace(/"/g, '""')}"`,
    r.score !== null ? r.score.toFixed(1) : '',
    `"${r.status || ''}"`,
    `"${r.method || ''}"`,
    `"${(r.github_url || '').replace(/"/g, '""')}"`,
    `"${(r.demo_url || '').replace(/"/g, '""')}"`,
    `"${(r.error || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `hackjudge_batch_results_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('Downloaded batch evaluation results CSV.', 'success');
});

// RUN ANOTHER BATCH
$('#batch-run-again')?.addEventListener('click', () => {
  state.batchRows = [];
  state.batchResults = [];
  if (fileInput) fileInput.value = '';
  $('#csv-preview')?.classList.add('hidden');
  $('#batch-progress-panel')?.classList.add('hidden');
  $('#batch-results-panel')?.classList.add('hidden');
  $('#batch-form-body')?.classList.remove('hidden');
  updateBatchStartBtn();
});

renderCriteriaEditor();
loadHealth();
loadOverview();
