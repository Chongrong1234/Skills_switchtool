/* Skills SwitchTool 前端:状态对象 + render 函数,全部操作走 fetch 调 API */

// ---------- 全局状态 ----------
const state = {
  view: 'projects',        // 'projects' | 'skills' | 'mcps' | 'catalog' | 'global'
  agents: [],              // [{id, displayName, detected, capabilities}]
  projects: [],
  activeProjectId: null,
  skills: [],
  mcps: [],                // MCP server 中央注册表
  global: null,            // 全局(用户级)共享档案 {skills, agents, applyMode, lastAppliedAt}
  selectedProjectId: null, // 主区当前展示的项目
  catalog: null,           // 推荐库缓存 {categories, items},null = 未加载/已失效
  catalogCategory: '',     // 推荐库当前分类过滤('' = 全部)
  catalogQuery: '',        // 推荐库当前搜索词
  serverCwd: null,         // /api/meta 缓存:服务进程 cwd,新建项目预填路径用
};

// ---------- 工具 ----------
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      // 前端兜底超时:大于服务端 git 超时(默认 120s),正常情况下服务端的明确错误先到
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    // 超时/断连也要抛出可读错误,否则按钮永远停在"安装中…"
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('请求超时:服务 180s 无响应(若是安装操作,多为网络无法访问 GitHub,请检查网络/代理)');
    }
    throw new Error(`无法连接服务: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, type = 'ok') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- git 进度条(安装/导入等长任务:轮询 /api/progress 渲染 clone/pull 进度) ----------
const progressUI = {
  inflight: 0, // 进行中的长任务数;归 0 才停止轮询并隐藏面板
  timer: null,
  start() {
    this.inflight++;
    if (this.timer) return;
    const tick = async () => {
      try {
        const { jobs } = await api('GET', '/api/progress');
        this.render(jobs);
      } catch { /* 轮询失败不影响主流程 */ }
    };
    tick();
    this.timer = setInterval(tick, 400);
  },
  stop() {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.inflight) return;
    clearInterval(this.timer);
    this.timer = null;
    this.render([]);
  },
  render(jobs) {
    const root = document.getElementById('progress-root');
    if (!jobs.length) { root.style.display = 'none'; root.innerHTML = ''; return; }
    root.style.display = 'flex';
    root.innerHTML = jobs.map((j) => `
      <div class="prog">
        <div class="prog-label">${esc(j.label)}</div>
        ${j.pct === null ? '' : `<div class="prog-bar"><div class="prog-fill" style="width:${j.pct}%"></div></div>`}
        <div class="prog-text">${esc(j.phase ? `${j.phase} ${j.pct}%` : '')} ${esc(j.text)}</div>
      </div>`).join('');
  },
};

/** 带进度条的 api:clone/pull 类长任务(github 安装、迁移码/配置库导入)用,期间轮询渲染 git 进度 */
async function apiWithProgress(method, url, body) {
  progressUI.start();
  try { return await api(method, url, body); }
  finally { progressUI.stop(); }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function run(fn) {
  try { await fn(); } catch (err) { toast(err.message, 'err'); }
}

// ---------- 主题 ----------
// 选择持久化在 localStorage;首屏恢复由 index.html head 里的内联脚本完成(避免闪烁)
const THEME_KEY = 'ssw-theme';
function getTheme() {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
}

// ---------- 数据加载 ----------
async function loadAll() {
  const [agents, pdata, skills, mcps, gprofile] = await Promise.all([
    api('GET', '/api/agents'),
    api('GET', '/api/projects'),
    api('GET', '/api/skills'),
    api('GET', '/api/mcps'),
    api('GET', '/api/global'),
  ]);
  state.agents = agents;
  state.projects = pdata.projects;
  state.activeProjectId = pdata.activeProjectId;
  state.skills = skills;
  state.mcps = mcps;
  state.global = gprofile;
  if (!state.selectedProjectId && state.projects.length) {
    state.selectedProjectId = state.activeProjectId || state.projects[0].id;
  }
}

// ---------- 渲染入口 ----------
function render() {
  document.querySelectorAll('.view-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view));
  document.getElementById('sidebar-projects').style.display = state.view === 'projects' ? '' : 'none';
  document.getElementById('btn-new-project').style.display = state.view === 'projects' ? '' : 'none';
  renderSidebarProjects();
  if (state.view === 'projects') renderProjectDetail();
  else if (state.view === 'catalog') renderCatalog();
  else if (state.view === 'mcps') renderMcpLibrary();
  else if (state.view === 'global') renderGlobal();
  else renderSkillLibrary();
}

function agentTag(id) {
  const a = state.agents.find((x) => x.id === id);
  return `<span class="tag agent">${esc(a ? a.displayName : id)}</span>`;
}

function renderSidebarProjects() {
  const box = document.getElementById('sidebar-projects');
  if (!state.projects.length) {
    box.innerHTML = '<div class="empty">还没有项目<br>点击下方按钮新建</div>';
    return;
  }
  box.innerHTML = state.projects.map((p) => {
    const cls = ['project-card'];
    if (p.id === state.selectedProjectId) cls.push('selected');
    if (p.id === state.activeProjectId) cls.push('active');
    return `
      <div class="${cls.join(' ')}" data-project-id="${p.id}">
        <div class="pname">${esc(p.name)} ${p.id === state.activeProjectId ? '<span class="badge-active">当前</span>' : ''}</div>
        <div class="ppath">${esc(p.path)}</div>
        <div class="ptags">${p.agents.map(agentTag).join('')}</div>
      </div>`;
  }).join('');
  box.querySelectorAll('.project-card').forEach((el) =>
    el.addEventListener('click', () => {
      state.selectedProjectId = el.dataset.projectId;
      render();
    }));
}

// ---------- 项目详情 ----------
function renderProjectDetail() {
  const main = document.getElementById('main');
  const p = state.projects.find((x) => x.id === state.selectedProjectId);
  if (!p) {
    main.innerHTML = '<div class="empty">请选择或新建一个项目</div>';
    return;
  }
  const isActive = p.id === state.activeProjectId;
  const projectSkills = state.skills.filter((s) => p.skills.includes(s.id));
  const projectMcps = state.mcps.filter((m) => (p.mcps || []).includes(m.name));

  main.innerHTML = `
    <div class="main-title">
      ${esc(p.name)}
      ${isActive ? '<span class="badge-active">已激活</span>' : ''}
    </div>
    <div class="main-sub">${esc(p.path)} · apply 模式: ${p.applyMode}</div>

    <div class="section">
      <h3>目标 Agents(未检测到的不可选)</h3>
      <div class="agent-checks">
        ${state.agents.map((a) => `
          <label class="agent-check ${a.detected ? '' : 'disabled'}">
            <input type="checkbox" data-agent-id="${a.id}"
              ${p.agents.includes(a.id) ? 'checked' : ''} ${a.detected ? '' : 'disabled'} />
            ${esc(a.displayName)}${a.detected ? '' : '(未检测到)'}
          </label>`).join('')}
      </div>
    </div>

    <div class="section">
      <h3>技能集(${projectSkills.length})</h3>
      <div class="panel">
        ${projectSkills.length ? projectSkills.map((s) => `
          <div class="skill-row">
            <div>
              <div class="sname">${esc(s.name)}</div>
              <div class="sdesc">${esc(s.description)}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-remove-skill="${esc(s.id)}">移除</button>
          </div>`).join('') : '<div class="empty">尚未绑定技能,点击右上角按钮从库中添加</div>'}
      </div>
      <div class="toolbar">
        <button class="btn" id="btn-add-skill">+ 从库中添加</button>
      </div>
    </div>

    <div class="section">
      <h3>MCP 服务集(${projectMcps.length})</h3>
      <div class="panel">
        ${projectMcps.length ? projectMcps.map((m) => `
          <div class="skill-row">
            <div>
              <div class="sname">${esc(m.name)} <span class="tag">${esc(m.transport)}</span></div>
              <div class="sdesc">${esc(m.transport === 'stdio' ? `${m.command} ${(m.args || []).join(' ')}` : m.url)}${m.description ? ` · ${esc(m.description)}` : ''}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-remove-mcp="${esc(m.name)}">移除</button>
          </div>`).join('') : '<div class="empty">尚未绑定 MCP 服务,点击下方按钮从库中添加</div>'}
      </div>
      <div class="toolbar">
        <button class="btn" id="btn-add-mcp">+ 从库中添加</button>
      </div>
    </div>

    <div class="actions">
      ${isActive ? '' : '<button class="btn btn-primary" id="btn-switch">切换到此项目</button>'}
      <button class="btn btn-primary" id="btn-apply">应用配置</button>
      <button class="btn" id="btn-unapply">取消应用</button>
      <button class="btn" id="btn-rollback">回滚</button>
      <button class="btn btn-danger" id="btn-delete-project">删除项目</button>
    </div>
  `;

  // agents 勾选
  main.querySelectorAll('input[data-agent-id]').forEach((cb) =>
    cb.addEventListener('change', () => run(async () => {
      const agents = [...main.querySelectorAll('input[data-agent-id]:checked')].map((x) => x.dataset.agentId);
      await api('PATCH', `/api/projects/${p.id}`, { agents });
      await loadAll();
      render();
      toast('目标 agents 已更新');
    })));

  // 移除技能
  main.querySelectorAll('[data-remove-skill]').forEach((btn) =>
    btn.addEventListener('click', () => run(async () => {
      const sid = btn.dataset.removeSkill;
      await api('POST', `/api/projects/${p.id}/skills`, { skillIds: p.skills.filter((x) => x !== sid) });
      await loadAll();
      render();
      toast('已移除');
    })));

  // 移除 MCP 绑定
  main.querySelectorAll('[data-remove-mcp]').forEach((btn) =>
    btn.addEventListener('click', () => run(async () => {
      const name = btn.dataset.removeMcp;
      await api('POST', `/api/projects/${p.id}/mcps`, { mcpNames: (p.mcps || []).filter((x) => x !== name) });
      await loadAll();
      render();
      toast('已移除');
    })));

  document.getElementById('btn-add-mcp').addEventListener('click', () => openAddMcpModal(p));
  document.getElementById('btn-add-skill').addEventListener('click', () => openAddSkillModal(p));
  document.getElementById('btn-apply').addEventListener('click', () => run(async () => {
    const r = await api('POST', `/api/projects/${p.id}/apply`);
    await loadAll();
    render();
    toast(`已应用 skills ${r.applied.length} 项、MCP ${(r.mcpApplied || []).length} 项${r.warnings.length ? `,${r.warnings.length} 条警告` : ''}`);
    r.warnings.forEach((w) => toast(w, 'err'));
  }));
  document.getElementById('btn-unapply').addEventListener('click', () => run(async () => {
    const r = await api('POST', `/api/projects/${p.id}/unapply`);
    toast(`已移除 ${r.removed.length} 项`);
  }));
  document.getElementById('btn-rollback').addEventListener('click', () => run(async () => {
    const r = await api('POST', `/api/projects/${p.id}/rollback`);
    toast(r.detail, r.restored ? 'ok' : 'err');
  }));
  const switchBtn = document.getElementById('btn-switch');
  if (switchBtn) switchBtn.addEventListener('click', () => run(async () => {
    await api('POST', `/api/projects/${p.id}/switch`);
    await loadAll();
    render();
    toast(`已切换到「${p.name}」并应用配置`);
  }));
  document.getElementById('btn-delete-project').addEventListener('click', () => run(async () => {
    if (!confirm(`确定删除项目「${p.name}」?(不会删除磁盘文件)`)) return;
    await api('DELETE', `/api/projects/${p.id}`);
    state.selectedProjectId = null;
    await loadAll();
    render();
    toast('项目已删除');
  }));
}

// ---------- 弹窗基础 ----------
function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-mask').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-mask')) closeModal();
  });
  return root.querySelector('.modal');
}
function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

function agentCheckboxList(selected = []) {
  return state.agents.map((a) => `
    <label class="agent-check ${a.detected ? '' : 'disabled'}">
      <input type="checkbox" name="m-agent" value="${a.id}"
        ${selected.includes(a.id) ? 'checked' : ''} ${a.detected ? '' : 'disabled'} />
      ${esc(a.displayName)}${a.detected ? '' : '(未检测到)'}
    </label>`).join('');
}

// ---------- 设置 ----------
function openSettingsModal() {
  const cur = getTheme();
  const modal = openModal(`
    <h2>设置</h2>
    <div class="form-row"><label>界面主题</label>
      <div class="radio-group">
        <label><input type="radio" name="st-theme" value="dark" ${cur === 'dark' ? 'checked' : ''} /> 深色</label>
        <label><input type="radio" name="st-theme" value="light" ${cur === 'light' ? 'checked' : ''} /> 浅色</label>
      </div>
    </div>
    <div class="form-row"><label>AI 推荐(模型读本地技能库,新建项目时按需求推荐技能)</label>
      <div class="ai-form">
        <div class="ai-row"><span class="ai-label">预设</span>
          <select id="st-ai-preset"></select>
        </div>
        <div class="ai-row"><span class="ai-label">baseUrl</span>
          <input type="text" id="st-ai-baseurl" placeholder="https://api.moonshot.cn/v1 或中转站地址" />
        </div>
        <div class="ai-row"><span class="ai-label">模型</span>
          <input type="text" id="st-ai-model" list="st-ai-models" placeholder="kimi-k2-0905-preview" />
          <datalist id="st-ai-models"></datalist>
        </div>
        <div class="ai-row"><span class="ai-label">API Key</span>
          <input type="password" id="st-ai-key" placeholder="加载中…" autocomplete="off" />
        </div>
        <div class="ai-row">
          <button class="btn btn-sm btn-primary" id="st-ai-save">保存</button>
          <button class="btn btn-sm" id="st-ai-test">测试连接</button>
          <span class="rdesc" id="st-ai-status"></span>
        </div>
        <div class="rdesc">兼容 OpenAI chat 接口的官方端点或中转站均可;Key 只存在本机数据目录,服务不对外网开放</div>
      </div>
    </div>
    <div class="form-row"><label>环境自检(数据目录 / git / agent 检测 / 数据文件)</label>
      <div id="st-doctor"><div class="loading-text">自检中…</div></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="m-rerun-doctor">重新自检</button>
      <button class="btn" id="m-close">关闭</button>
    </div>
  `);
  modal.querySelector('#m-close').addEventListener('click', closeModal);
  modal.querySelectorAll('input[name="st-theme"]').forEach((r) =>
    r.addEventListener('change', () => setTheme(r.value)));

  // ---- AI 配置:预设只负责预填 baseUrl/model,保存/测试都按表单当前值走 ----
  const aiEls = {
    preset: modal.querySelector('#st-ai-preset'),
    baseUrl: modal.querySelector('#st-ai-baseurl'),
    model: modal.querySelector('#st-ai-model'),
    models: modal.querySelector('#st-ai-models'),
    key: modal.querySelector('#st-ai-key'),
    status: modal.querySelector('#st-ai-status'),
  };
  let aiPresets = [];
  const aiFormBody = () => ({
    baseUrl: aiEls.baseUrl.value.trim(),
    model: aiEls.model.value.trim(),
    // key 留空 = 保持不变(保存语义);测试时同理回落到已存 key
    ...(aiEls.key.value.trim() ? { apiKey: aiEls.key.value.trim() } : {}),
  });
  api('GET', '/api/ai/config').then((cfg) => {
    aiPresets = cfg.presets || [];
    aiEls.preset.innerHTML =
      aiPresets.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('') +
      '<option value="">自定义(中转站)</option>';
    aiEls.baseUrl.value = cfg.baseUrl;
    aiEls.model.value = cfg.model;
    // 命中预设则回显选中,否则落"自定义"
    const hit = aiPresets.find((p) => p.baseUrl === cfg.baseUrl);
    aiEls.preset.value = hit ? hit.id : '';
    aiEls.models.innerHTML = (hit ? hit.models : []).map((m) => `<option value="${esc(m)}"></option>`).join('');
    aiEls.key.placeholder = cfg.hasKey ? `已保存(${esc(cfg.apiKeyMask)}),留空保持不变` : '填 API Key';
    aiEls.status.textContent = cfg.hasKey ? '' : '尚未配置 API Key,AI 推荐不可用';
  }).catch(() => { aiEls.status.textContent = 'AI 配置加载失败'; });
  aiEls.preset.addEventListener('change', () => {
    const p = aiPresets.find((x) => x.id === aiEls.preset.value);
    if (!p) return; // 自定义:不动用户已填内容
    aiEls.baseUrl.value = p.baseUrl;
    aiEls.model.value = p.models[0] || '';
    aiEls.models.innerHTML = p.models.map((m) => `<option value="${esc(m)}"></option>`).join('');
  });
  modal.querySelector('#st-ai-save').addEventListener('click', () => run(async () => {
    const body = aiFormBody();
    if (!body.baseUrl || !body.model) { aiEls.status.textContent = 'baseUrl 与模型必填'; return; }
    const cfg = await api('PUT', '/api/ai/config', body);
    aiEls.key.value = '';
    aiEls.key.placeholder = cfg.hasKey ? `已保存(${esc(cfg.apiKeyMask)}),留空保持不变` : '填 API Key';
    aiEls.status.textContent = '已保存';
    toast('AI 配置已保存');
  }));
  modal.querySelector('#st-ai-test').addEventListener('click', () => run(async () => {
    aiEls.status.textContent = '测试连接中…';
    const r = await api('POST', '/api/ai/test', aiFormBody());
    aiEls.status.textContent = `${r.ok ? '✓' : '✗'} ${r.message}`;
  }));

  // 环境自检:与 ssw doctor / TUI d 键同一份报告(GET /api/doctor)
  const box = modal.querySelector('#st-doctor');
  const runDoctorCheck = () => {
    box.innerHTML = '<div class="loading-text">自检中…</div>';
    api('GET', '/api/doctor')
      .then((d) => {
        const icon = { ok: '✓', warn: '⚠', error: '✗' };
        box.innerHTML =
          d.checks.map((c) => `
            <div class="rdesc">${icon[c.level] || ''} ${esc(c.label)}${c.hint ? `<br>&nbsp;&nbsp;&nbsp;建议: ${esc(c.hint)}` : ''}</div>
          `).join('') +
          `<div class="rdesc" style="margin-top:6px">版本 v${esc(d.version)} · skills ${d.stats.skills} / MCP ${d.stats.mcps} / 项目 ${d.stats.projects}${d.stats.activeProject ? `(当前激活: ${esc(d.stats.activeProject)})` : ''}</div>`;
      })
      .catch((err) => {
        box.innerHTML = `<div class="empty">自检失败: ${esc(err.message)}</div>`;
      });
  };
  modal.querySelector('#m-rerun-doctor').addEventListener('click', runDoctorCheck);
  runDoctorCheck();
}

/** 热度徽标:stars(社区热度)+ 使用次数(本机历史) */
function hotTags(s) {
  return `${s.stars ? `<span class="tag">★ ${s.stars}</span>` : ''}${s.useCount ? `<span class="tag">用 ${s.useCount} 次</span>` : ''}`;
}

// ---------- 从库中添加技能(热度排序:常用 > 贴合本项目 > 高星) ----------
function openAddSkillModal(project) {
  const modal = openModal(`
    <h2>从库中添加技能 → ${esc(project.name)}</h2>
    <div id="ask-body"><div class="spinner"></div><div class="loading-text">按热度排序中…</div></div>
    <div class="modal-actions"><button class="btn" id="m-close">关闭</button></div>
  `);
  modal.querySelector('#m-close').addEventListener('click', closeModal);
  run(async () => {
    // 服务端按热度排好序(带本项目的技术栈/名词上下文);不走 state.skills 缓存,保证 stars/用量新鲜
    const ranked = await api('GET', `/api/skills?rank=1&forProject=${encodeURIComponent(project.id)}`);
    const available = ranked.filter((s) => !project.skills.includes(s.id));
    const body = modal.querySelector('#ask-body');
    body.innerHTML = available.length ? `<div class="rec-list">
      ${available.map((s) => `
        <div class="rec-item">
          <div class="rhead">
            <span class="rname">${esc(s.name)} ${hotTags(s)}</span>
            <button class="btn btn-sm btn-primary" data-add="${esc(s.id)}">添加</button>
          </div>
          <div class="rdesc">${esc(s.description)}</div>
        </div>`).join('')}
    </div>` : '<div class="empty">库中没有更多可添加的技能</div>';
    body.querySelectorAll('[data-add]').forEach((btn) =>
      btn.addEventListener('click', () => run(async () => {
        await api('POST', `/api/projects/${project.id}/skills`, { skillIds: [...project.skills, btn.dataset.add] });
        await loadAll();
        closeModal();
        render();
        toast('已添加到项目技能集');
      })));
  });
}

// ---------- 从库中添加 MCP ----------
function openAddMcpModal(project) {
  const available = state.mcps.filter((m) => !(project.mcps || []).includes(m.name));
  const modal = openModal(`
    <h2>从库中添加 MCP 服务 → ${esc(project.name)}</h2>
    ${available.length ? `<div class="rec-list">
      ${available.map((m) => `
        <div class="rec-item">
          <div class="rhead">
            <span class="rname">${esc(m.name)} <span class="tag">${esc(m.transport)}</span></span>
            <button class="btn btn-sm btn-primary" data-add="${esc(m.name)}">添加</button>
          </div>
          <div class="rdesc">${esc(m.transport === 'stdio' ? `${m.command} ${(m.args || []).join(' ')}` : m.url)}</div>
        </div>`).join('')}
    </div>` : '<div class="empty">库中没有更多可添加的 MCP 服务(可在「MCP 服务」页添加)</div>'}
    <div class="modal-actions"><button class="btn" id="m-close">关闭</button></div>
  `);
  modal.querySelector('#m-close').addEventListener('click', closeModal);
  modal.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => run(async () => {
      await api('POST', `/api/projects/${project.id}/mcps`, { mcpNames: [...(project.mcps || []), btn.dataset.add] });
      await loadAll();
      closeModal();
      render();
      toast('已添加到项目 MCP 服务集');
    })));
}

// ---------- 新建项目(含推荐流程) ----------
/** 新建项目后的 AI 推荐区:模型读本地技能库,按需求挑技能,勾选后并入项目技能集 */
async function loadAiRecommend(modal, project, requirement) {
  const box = modal.querySelector('#np-ai');
  box.innerHTML = '<div class="spinner"></div><div class="loading-text">AI 正在阅读本地技能库并匹配需求…</div>';
  let rec;
  try {
    rec = await api('POST', '/api/ai/recommend', { requirement, projectName: project.name });
  } catch (err) {
    box.innerHTML = `<div class="empty">AI 推荐失败: ${esc(err.message)}</div>`;
    return;
  }
  if (!rec.items.length) {
    box.innerHTML = `<div class="empty">${esc(rec.message || 'AI 暂无推荐')}</div>`;
    return;
  }
  box.innerHTML = `
    <h3 style="margin:14px 0 8px">AI 从本地技能库推荐(${esc(rec.model || '')})</h3>
    <div class="rec-list">
      ${rec.items.map((r) => `
        <div class="rec-item">
          <div class="rhead">
            <label class="ai-pick"><input type="checkbox" data-ai-id="${esc(r.id)}" checked /> <span class="rname">${esc(r.name)}</span> ${hotTags(r)}</label>
          </div>
          <div class="rdesc">${esc(r.description)}</div>
          ${r.reason ? `<div class="rreason">${esc(r.reason)}</div>` : ''}
        </div>`).join('')}
    </div>
    <div class="rbtns" style="margin-top:8px">
      <button class="btn btn-sm btn-primary" id="np-ai-bind">绑定选中技能到项目</button>
    </div>`;
  box.querySelector('#np-ai-bind').addEventListener('click', () => run(async () => {
    const picked = [...box.querySelectorAll('input[data-ai-id]:checked')].map((x) => x.dataset.aiId);
    if (!picked.length) return toast('未勾选任何技能', 'err');
    const latest = await api('GET', `/api/projects/${project.id}`);
    await api('POST', `/api/projects/${project.id}/skills`, {
      skillIds: [...new Set([...latest.skills, ...picked])],
    });
    await loadAll();
    box.querySelector('#np-ai-bind').disabled = true;
    box.querySelector('#np-ai-bind').textContent = `已绑定 ${picked.length} 个 ✓`;
    toast(`已绑定 ${picked.length} 个技能,点「应用配置」生效`);
  }));
}

function openNewProjectModal() {
  const modal = openModal(`
    <h2>新建项目</h2>
    <div class="form-row"><label>项目名称</label><input type="text" id="np-name" placeholder="my-app" /></div>
    <div class="form-row"><label>目录路径(留空取服务启动目录)</label><input type="text" id="np-path" placeholder="/home/me/my-app" /></div>
    <div class="form-row"><label>应用模式</label>
      <div class="radio-group">
        <label><input type="radio" name="np-mode" value="symlink" checked /> symlink(推荐,改动即时生效)</label>
        <label><input type="radio" name="np-mode" value="copy" /> copy</label>
      </div>
    </div>
    <div class="form-row"><label>目标 Agents</label>
      <div class="agent-checks">${agentCheckboxList(state.agents.filter((a) => a.detected && a.id !== 'agents').map((a) => a.id))}</div>
      <div class="rdesc">已默认勾选本机检测到的 agent;通用互操作目录 agents 可按需手动勾选</div>
    </div>
    <div class="form-row"><label>开发需求(可选;AI 将读本地技能库,按需求推荐匹配技能——需先在「设置」里配置模型与 API Key)</label>
      <textarea id="np-ai-req" rows="2" placeholder="例如:React + TypeScript 的后台管理系统,需要代码审查与测试"></textarea></div>
    <div id="np-ai"></div>
    <div id="np-recommend"></div>
    <div class="modal-actions">
      <button class="btn" id="np-cancel">取消</button>
      <button class="btn btn-primary" id="np-submit">创建并获取推荐</button>
    </div>
  `);
  // 路径自动填充:取服务进程的工作目录(ssw serve / 桌面版的启动目录,通常就是项目根);
  // 打开弹窗即填,勾选 agent 时若仍为空也会补上,均可再手改
  const fillDefaultPath = () => run(async () => {
    if (!state.serverCwd) state.serverCwd = (await api('GET', '/api/meta')).cwd;
    const input = modal.querySelector('#np-path');
    if (!input.value.trim()) input.value = state.serverCwd;
  });
  fillDefaultPath();
  modal.querySelectorAll('input[name="m-agent"]').forEach((cb) =>
    cb.addEventListener('change', fillDefaultPath));
  modal.querySelector('#np-cancel').addEventListener('click', closeModal);
  modal.querySelector('#np-submit').addEventListener('click', () => run(async () => {
    const name = modal.querySelector('#np-name').value.trim();
    const projPath = modal.querySelector('#np-path').value.trim();
    const requirement = modal.querySelector('#np-ai-req').value.trim();
    const applyMode = modal.querySelector('input[name="np-mode"]:checked').value;
    const agents = [...modal.querySelectorAll('input[name="m-agent"]:checked')].map((x) => x.value);
    if (!name) return toast('名称必填', 'err');

    const body = { name, agents, applyMode };
    if (projPath) body.path = projPath; // 留空时由服务端取 process.cwd()
    const project = await api('POST', '/api/projects', body);
    state.selectedProjectId = project.id;
    await loadAll();
    // 允许同名项目,但同名会让寻址歧义,主动提醒
    if (state.projects.some((p) => p.name === project.name && p.id !== project.id)) {
      toast(`已存在同名项目「${project.name}」,注意区分`, 'err');
    }

    // 创建成功后拉推荐(加载态 spinner)
    const box = modal.querySelector('#np-recommend');
    box.innerHTML = '<div class="spinner"></div><div class="loading-text">正在检测技术栈并搜索 GitHub 推荐…</div>';
    modal.querySelector('#np-submit').disabled = true;

    // GitHub 在线推荐(失败/无结果都不阻塞后面的 AI 推荐)
    try {
      const rec = await api('GET', `/api/recommend?projectId=${encodeURIComponent(project.id)}`);
      if (!rec.items.length) {
        box.innerHTML = `<div class="empty">${esc(rec.message || '暂无推荐')}</div>`;
      } else {
        box.innerHTML = `
          <h3 style="margin:14px 0 8px">为你推荐(按 star 排序)</h3>
          <div class="rec-list">
            ${rec.items.map((r) => `
              <div class="rec-item">
                <div class="rhead">
                  <span class="rname">${esc(r.name)}</span>
                  <span class="rstars">★ ${r.stars}</span>
                </div>
                <div class="rdesc">${esc(r.description)}</div>
                <div class="rreason">${esc(r.reason)} · ${esc(r.repo)}</div>
                <div class="rbtns"><button class="btn btn-sm btn-primary" data-rec-url="${esc(r.url)}">加入库并绑定</button></div>
              </div>`).join('')}
          </div>`;
        box.querySelectorAll('[data-rec-url]').forEach((btn) =>
          btn.addEventListener('click', () => run(async () => {
            btn.disabled = true;
            btn.textContent = '安装中…';
            try {
              const installed = await apiWithProgress('POST', '/api/skills', { source: 'github', uri: btn.dataset.recUrl });
              const latest = (await api('GET', `/api/projects/${project.id}`));
              await api('POST', `/api/projects/${project.id}/skills`, {
                skillIds: [...latest.skills, ...installed.map((s) => s.id)],
              });
              await loadAll();
              btn.textContent = '已加入 ✓';
              toast(`已安装 ${installed.length} 个 skill 并绑定到项目`);
            } catch (err) {
              // 失败必须恢复按钮,否则会永远停在"安装中…";错误继续抛给 run() 弹 toast
              btn.disabled = false;
              btn.textContent = '加入库并绑定';
              throw err;
            }
          })));
      }
    } catch (err) {
      box.innerHTML = `<div class="empty">推荐加载失败: ${esc(err.message)}</div>`;
    }

    // AI 推荐本地技能库:填了开发需求才触发(独立 try 之外,不受 GitHub 推荐成败影响)
    if (requirement) await loadAiRecommend(modal, project, requirement);
  }));
}

// ---------- 技能库视图 ----------
function renderSkillLibrary() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="main-title">技能库</div>
    <div class="main-sub">中央库是唯一事实来源,共 ${state.skills.length} 个 skill</div>
    <div class="toolbar">
      <button class="btn btn-primary" id="sk-github">从 GitHub 安装</button>
      <button class="btn" id="sk-local">从本地路径安装</button>
      <button class="btn" id="sk-init">新建我的 Skill</button>
      <button class="btn" id="sk-adopt">收养 agent 技能</button>
      <button class="btn" id="sk-export">导出迁移码</button>
      <button class="btn" id="sk-import">导入迁移码</button>
      <button class="btn" id="sk-profile-export">导出配置库</button>
      <button class="btn" id="sk-profile-import">导入配置库</button>
    </div>
    <div class="skills-grid">
      ${state.skills.map((s) => `
        <div class="skill-card">
          <div class="sname">${esc(s.name)}</div>
          <div class="sdesc">${esc(s.description)}</div>
          <div class="smeta">
            <span class="tag">${esc(s.source.type)}</span>
            ${(s.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
          </div>
          <div><button class="btn btn-sm btn-danger" data-del-skill="${esc(s.id)}">删除</button></div>
        </div>`).join('') || '<div class="empty">库还是空的,从上面的入口添加吧</div>'}
    </div>
  `;
  document.getElementById('sk-github').addEventListener('click', openInstallGithubModal);
  document.getElementById('sk-local').addEventListener('click', openInstallLocalModal);
  document.getElementById('sk-init').addEventListener('click', openInitSkillModal);
  document.getElementById('sk-adopt').addEventListener('click', openAdoptModal);
  document.getElementById('sk-export').addEventListener('click', openExportModal);
  document.getElementById('sk-import').addEventListener('click', openImportModal);
  document.getElementById('sk-profile-export').addEventListener('click', exportProfileFile);
  document.getElementById('sk-profile-import').addEventListener('click', openProfileImportModal);
  main.querySelectorAll('[data-del-skill]').forEach((btn) =>
    btn.addEventListener('click', () => run(async () => {
      if (!confirm(`确定从库中删除「${btn.dataset.delSkill}」?`)) return;
      await api('DELETE', `/api/skills/${encodeURIComponent(btn.dataset.delSkill)}`);
      await loadAll();
      render();
      toast('已删除');
    })));
}

function openInstallGithubModal() {
  const modal = openModal(`
    <h2>从 GitHub 安装</h2>
    <div class="form-row"><label>仓库地址(完整 URL 或 owner/repo)</label>
      <input type="text" id="gh-uri" placeholder="https://github.com/owner/repo" /></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">安装</button>
    </div>
  `);
  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', () => run(async () => {
    const uri = modal.querySelector('#gh-uri').value.trim();
    if (!uri) return toast('请输入仓库地址', 'err');
    const btn = modal.querySelector('#m-ok');
    btn.disabled = true; btn.textContent = '安装中…';
    try {
      const installed = await apiWithProgress('POST', '/api/skills', { source: 'github', uri });
      await loadAll();
      closeModal();
      render();
      toast(`已安装 ${installed.length} 个 skill,到项目页绑定后 apply 生效`);
    } catch (err) {
      // 失败恢复按钮可重试(弹窗保持打开);错误继续抛给 run() 弹 toast
      btn.disabled = false; btn.textContent = '安装';
      throw err;
    }
  }));
}

function openInstallLocalModal() {
  const modal = openModal(`
    <h2>从本地路径安装</h2>
    <div class="form-row"><label>skill 目录(需包含合法 SKILL.md)</label>
      <input type="text" id="lc-uri" placeholder="/path/to/my-skill" /></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">安装</button>
    </div>
  `);
  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', () => run(async () => {
    const uri = modal.querySelector('#lc-uri').value.trim();
    if (!uri) return toast('请输入路径', 'err');
    await api('POST', '/api/skills', { source: 'local', uri });
    await loadAll();
    closeModal();
    render();
    toast('已安装,到项目页绑定后 apply 生效');
  }));
}

function openInitSkillModal() {
  const modal = openModal(`
    <h2>新建我的 Skill</h2>
    <div class="form-row"><label>SKILL.md 内容(可选;直接粘贴别处复制的完整 SKILL.md,可继续编辑修改,frontmatter 会自动带出名称与描述;留空则生成模板)</label>
      <textarea id="init-content" rows="10" placeholder="---&#10;name: my-skill&#10;description: 这个 skill 做什么&#10;---&#10;&#10;在这里粘贴或编写指令内容…"></textarea></div>
    <div class="form-row"><label>名称(小写字母/数字/连字符)</label>
      <input type="text" id="init-name" placeholder="my-skill" /></div>
    <div class="form-row"><label>描述</label>
      <input type="text" id="init-desc" placeholder="这个 skill 做什么" /></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">创建</button>
    </div>
  `);
  // 粘贴完整 SKILL.md 时,解析 frontmatter 自动带出名称/描述(已手填的不覆盖)
  modal.querySelector('#init-content').addEventListener('input', () => {
    const m = modal.querySelector('#init-content').value.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return;
    const fm = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    const nameInput = modal.querySelector('#init-name');
    const descInput = modal.querySelector('#init-desc');
    if (fm.name && !nameInput.value.trim()) nameInput.value = fm.name;
    if (fm.description && !descInput.value.trim()) descInput.value = fm.description;
  });
  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', () => run(async () => {
    const name = modal.querySelector('#init-name').value.trim();
    const description = modal.querySelector('#init-desc').value.trim();
    const content = modal.querySelector('#init-content').value;
    if (!content.trim() && (!name || !description)) return toast('名称与描述必填(或粘贴带 frontmatter 的 SKILL.md)', 'err');
    await api('POST', '/api/skills/init', { name, description, ...(content.trim() ? { content } : {}) });
    await loadAll();
    closeModal();
    render();
    toast('已创建,可在库目录中继续编辑');
  }));
}

// ---------- 迁移码(仅 github 来源可跨机迁移) ----------
function openExportModal() {
  run(async () => {
    const { code, repos } = await api('GET', '/api/skills/export');
    const modal = openModal(`
      <h2>导出迁移码</h2>
      ${repos.length ? `
        <div class="form-row">
          <label>复制这段码,在新环境的「导入迁移码」粘贴即可批量下载(仅含 GitHub 来源,共 ${repos.length} 个仓库)</label>
          <textarea id="exp-code" rows="4" readonly>${esc(code)}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" id="exp-copy">复制</button>
          <button class="btn" id="m-close">关闭</button>
        </div>` : `
        <div class="empty">库中没有 GitHub 来源的 skill,无可导出内容</div>
        <div class="modal-actions"><button class="btn" id="m-close">关闭</button></div>`}
    `);
    modal.querySelector('#m-close').addEventListener('click', closeModal);
    const copyBtn = modal.querySelector('#exp-copy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const ta = modal.querySelector('#exp-code');
      try {
        await navigator.clipboard.writeText(ta.value);
        toast('已复制到剪贴板');
      } catch {
        // clipboard API 在非安全上下文(http 非 localhost)不可用,退化为全选手动复制
        ta.select();
        toast('自动复制失败,已全选,请手动复制', 'err');
      }
    });
  });
}

function openImportModal() {
  const modal = openModal(`
    <h2>导入迁移码</h2>
    <div class="form-row"><label>粘贴迁移码(ssw1:...),将从 GitHub 批量安装</label>
      <textarea id="imp-code" rows="4" placeholder="ssw1:owner/repo,owner2/repo2"></textarea></div>
    <div id="imp-result"></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">关闭</button>
      <button class="btn btn-primary" id="m-ok">导入</button>
    </div>
  `);
  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', () => run(async () => {
    const code = modal.querySelector('#imp-code').value.trim();
    if (!code) return toast('请粘贴迁移码', 'err');
    const btn = modal.querySelector('#m-ok');
    btn.disabled = true; btn.textContent = '导入中…';
    let r;
    try {
      r = await apiWithProgress('POST', '/api/skills/import', { code });
    } catch (err) {
      // 失败恢复按钮可重试;错误继续抛给 run() 弹 toast
      btn.disabled = false; btn.textContent = '导入';
      throw err;
    }
    await loadAll();
    render(); // 主区卡片刷新;弹窗保持打开展示明细
    const lines = [
      ...r.installed.map((x) => `✓ ${x}  已安装`),
      ...r.skipped.map((x) => `- ${x}  已在库中,跳过`),
      ...r.failed.map((f) => `✗ ${f.repo}  ${f.message}`),
    ];
    modal.querySelector('#imp-result').innerHTML = lines.length
      ? `<div class="rec-list">${lines.map((l) => `<div class="rec-item"><div class="rdesc">${esc(l)}</div></div>`).join('')}</div>`
      : '<div class="empty">迁移码为空</div>';
    btn.textContent = '已导入';
    toast(`导入完成:新装 ${r.installed.length},跳过 ${r.skipped.length},失败 ${r.failed.length}`,
      r.failed.length ? 'err' : 'ok');
  }));
}

// ---------- MCP 服务库视图 ----------
function renderMcpLibrary() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="main-title">MCP 服务库</div>
    <div class="main-sub">中央注册表共 ${state.mcps.length} 个 MCP server;绑定到项目后,apply 时写入各 agent 的项目级配置(.mcp.json / mcp.json / config.toml)</div>
    <div class="toolbar">
      <button class="btn btn-primary" id="mc-add">添加 MCP server</button>
    </div>
    <div class="skills-grid">
      ${state.mcps.map((m) => `
        <div class="skill-card">
          <div class="sname">${esc(m.name)}</div>
          <div class="sdesc">${esc(m.transport === 'stdio' ? `${m.command} ${(m.args || []).join(' ')}` : m.url)}</div>
          ${m.description ? `<div class="sdesc">${esc(m.description)}</div>` : ''}
          <div class="smeta"><span class="tag">${esc(m.transport)}</span></div>
          <div>
            <button class="btn btn-sm" data-edit-mcp="${esc(m.name)}">设置</button>
            <button class="btn btn-sm btn-danger" data-del-mcp="${esc(m.name)}">删除</button>
          </div>
        </div>`).join('') || '<div class="empty">库还是空的,点上面按钮添加</div>'}
    </div>
  `;
  document.getElementById('mc-add').addEventListener('click', () => openMcpServerModal());
  main.querySelectorAll('[data-edit-mcp]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const entry = state.mcps.find((m) => m.name === btn.dataset.editMcp);
      if (entry) openMcpServerModal(entry);
    }));
  main.querySelectorAll('[data-del-mcp]').forEach((btn) =>
    btn.addEventListener('click', () => run(async () => {
      if (!confirm(`确定从库中删除「${btn.dataset.delMcp}」?(各项目的绑定会一并解除)`)) return;
      await api('DELETE', `/api/mcps/${encodeURIComponent(btn.dataset.delMcp)}`);
      await loadAll();
      render();
      toast('已删除');
    })));
}

/** 添加/配置 MCP server:stdio(本地命令)与 http/sse(远端)字段按类型切换;
 *  传 existing 进入配置模式(名称是唯一键,锁定不可改),保存走 POST /api/mcps 同名 upsert */
function openMcpServerModal(existing) {
  const edit = !!existing;
  const m = existing || {};
  // KEY=V 逗号分隔 <-> 对象,与提交时的解析互逆(值里含 = 也能往返,提交按首个 = 切)
  const kvJoin = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join(',');
  const isStdio = (m.transport || 'stdio') === 'stdio';
  const modal = openModal(`
    <h2>${edit ? `配置 MCP server: ${esc(m.name)}` : '添加 MCP server'}</h2>
    <div class="form-row"><label>名称(字母/数字/下划线/连字符)</label>
      <input type="text" id="mcp-name" placeholder="filesystem" value="${esc(m.name || '')}" ${edit ? 'disabled' : ''} />
      ${edit ? '<div class="rdesc">名称是唯一键,不可修改;改动在下次 apply 时写入各 agent 配置</div>' : ''}</div>
    <div class="form-row"><label>描述(可选)</label>
      <input type="text" id="mcp-desc" placeholder="这个服务做什么" value="${esc(m.description || '')}" /></div>
    <div class="form-row"><label>传输类型</label>
      <div class="radio-group">
        <label><input type="radio" name="mcp-transport" value="stdio" ${isStdio ? 'checked' : ''} /> stdio(本地命令)</label>
        <label><input type="radio" name="mcp-transport" value="http" ${m.transport === 'http' ? 'checked' : ''} /> http(远端)</label>
        <label><input type="radio" name="mcp-transport" value="sse" ${m.transport === 'sse' ? 'checked' : ''} /> sse(远端,旧式)</label>
      </div>
    </div>
    <div id="mcp-stdio-fields"${isStdio ? '' : ' style="display:none"'}>
      <div class="form-row"><label>启动命令</label>
        <input type="text" id="mcp-command" placeholder="npx" value="${esc(m.command || '')}" /></div>
      <div class="form-row"><label>参数(逗号分隔,可空)</label>
        <input type="text" id="mcp-args" placeholder="-y,@modelcontextprotocol/server-filesystem,/tmp" value="${esc((m.args || []).join(','))}" /></div>
      <div class="form-row"><label>环境变量(KEY=V 逗号分隔,可空)</label>
        <input type="text" id="mcp-env" placeholder="API_KEY=xxx" value="${esc(kvJoin(m.env))}" /></div>
    </div>
    <div id="mcp-remote-fields"${isStdio ? ' style="display:none"' : ''}>
      <div class="form-row"><label>端点 URL</label>
        <input type="text" id="mcp-url" placeholder="https://mcp.example.com/mcp" value="${esc(m.url || '')}" /></div>
      <div class="form-row"><label>请求头(KEY=V 逗号分隔,可空)</label>
        <input type="text" id="mcp-headers" placeholder="Authorization=Bearer xxx" value="${esc(kvJoin(m.headers))}" /></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">${edit ? '保存' : '添加'}</button>
    </div>
  `);
  // 按传输类型切换字段区
  modal.querySelectorAll('input[name="mcp-transport"]').forEach((r) =>
    r.addEventListener('change', () => {
      const stdio = modal.querySelector('input[name="mcp-transport"]:checked').value === 'stdio';
      modal.querySelector('#mcp-stdio-fields').style.display = stdio ? '' : 'none';
      modal.querySelector('#mcp-remote-fields').style.display = stdio ? 'none' : '';
    }));
  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', () => run(async () => {
    const name = modal.querySelector('#mcp-name').value.trim();
    const description = modal.querySelector('#mcp-desc').value.trim();
    const transport = modal.querySelector('input[name="mcp-transport"]:checked').value;
    if (!name) return toast('名称必填', 'err');
    const body = { name, transport };
    if (description) body.description = description;
    if (transport === 'stdio') {
      const command = modal.querySelector('#mcp-command').value.trim();
      if (!command) return toast('stdio 类型必填启动命令', 'err');
      body.command = command;
      const args = modal.querySelector('#mcp-args').value.trim();
      if (args) body.args = args.split(',').map((s) => s.trim()).filter(Boolean);
      const env = modal.querySelector('#mcp-env').value.trim();
      if (env) body.env = Object.fromEntries(env.split(',').map((p) => p.split(/=(.*)/).slice(0, 2)));
    } else {
      const url = modal.querySelector('#mcp-url').value.trim();
      if (!url) return toast('远端类型必填 URL', 'err');
      body.url = url;
      const headers = modal.querySelector('#mcp-headers').value.trim();
      if (headers) body.headers = Object.fromEntries(headers.split(',').map((p) => p.split(/=(.*)/).slice(0, 2)));
    }
    await api('POST', '/api/mcps', body);
    await loadAll();
    closeModal();
    render();
    toast(edit ? `已保存 MCP server: ${name}` : `已添加 MCP server: ${name}`);
  }));
}

// ---------- 推荐库视图 ----------
async function loadCatalog() {
  state.catalog = await api('GET', '/api/catalog');
}

/** 当前过滤条件下的条目(分类 + 关键词均在本地过滤,数据来自一次拉取) */
function catalogFiltered() {
  const q = state.catalogQuery.trim().toLowerCase();
  return state.catalog.items
    .filter((e) => !state.catalogCategory || e.category === state.catalogCategory)
    .filter((e) => !q || `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(q));
}

function catalogCardsHtml() {
  const items = catalogFiltered();
  if (!items.length) return '<div class="empty">没有匹配的条目</div>';
  const catName = (id) => (state.catalog.categories.find((c) => c.id === id) || {}).name || id;
  return items.map((e) => {
    const isMcp = e.kind === 'mcp';
    // 动作文案:skill 是 git clone("安装");MCP 是写中央注册表("添加");stars 0(托管 MCP)不显示 ★
    const btnText = isMcp
      ? (e.installed ? '已添加' : '添加')
      : (e.installed ? `已安装(${e.installedCount})` : '安装');
    return `
    <div class="skill-card">
      <div class="chead">
        <span class="sname">${esc(e.name)}</span>
        ${e.stars ? `<span class="rstars">★ ${e.stars}</span>` : ''}
      </div>
      <div class="sdesc">${esc(e.description)}</div>
      ${isMcp ? `<div class="sdesc">${esc(e.mcp.transport === 'stdio' ? `${e.mcp.command} ${(e.mcp.args || []).join(' ')}` : e.mcp.url)}</div>` : ''}
      <div class="smeta">
        <span class="tag">${esc(catName(e.category))}</span>
        <span class="tag">${isMcp ? `MCP · ${esc(e.mcp.transport)}` : 'skills'}</span>
        <span class="tag">${esc(e.id)}</span>
      </div>
      <div class="cbtns">
        <button class="btn btn-sm btn-primary" data-cat-install="${esc(e.id)}" ${e.installed ? 'disabled' : ''}>${btnText}</button>
        <a class="btn btn-sm" href="${esc(e.url)}" target="_blank" rel="noopener">${isMcp ? '文档' : '仓库'} ↗</a>
      </div>
    </div>`;
  }).join('');
}

/** 只刷新卡片区(搜索/切分类时不动输入框,避免丢失焦点) */
function refreshCatalogCards(main) {
  main.querySelector('#cat-list').innerHTML = catalogCardsHtml();
  bindCatalogInstalls(main);
}

function bindCatalogInstalls(main) {
  main.querySelectorAll('[data-cat-install]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const item = state.catalog.items.find((i) => i.id === btn.dataset.catInstall);
      const isMcp = item && item.kind === 'mcp';
      btn.disabled = true;
      btn.textContent = isMcp ? '添加中…' : '安装中…';
      try {
        if (isMcp) {
          // MCP 条目:写入中央注册表(密钥占位符后续在 MCP 服务页替换)
          await api('POST', '/api/mcps', { name: item.id, description: item.description, ...item.mcp });
          await loadAll();
          state.catalog = null;
          toast(`已添加 MCP server: ${item.id}(如有密钥占位符请到「MCP 服务」页替换)`);
          render();
        } else {
          const body = { source: 'github', uri: item ? item.url : btn.dataset.catInstall };
          if (item && item.subdir) body.subdir = item.subdir; // 合集仓库:以 skills/ 子目录为扫描根
          const installed = await apiWithProgress('POST', '/api/skills', body);
          await loadAll();
          state.catalog = null; // installed 标记已变化,触发重拉
          toast(`已安装 ${installed.length} 个 skill,到项目页绑定后 apply 生效`);
          render();
        }
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = isMcp ? '添加' : '安装';
      }
    }));
}

function renderCatalog() {
  const main = document.getElementById('main');
  if (!state.catalog) {
    main.innerHTML = '<div class="main-title">推荐库</div><div class="spinner"></div><div class="loading-text">正在加载推荐库…</div>';
    run(async () => { await loadCatalog(); render(); });
    return;
  }
  main.innerHTML = `
    <div class="main-title">推荐库</div>
    <div class="main-sub">精选高 star 的 skills 仓库与常用 MCP 服务:skill 一键安装到中央库(整仓登记);MCP 一键加入中央注册表,绑定项目后 apply 写入各 agent 配置</div>
    <div class="cat-toolbar">
      <input type="text" id="cat-q" placeholder="搜索名称 / 描述 / 仓库…" value="${esc(state.catalogQuery)}" />
    </div>
    <div class="cat-tabs">
      <button class="cat-tab ${state.catalogCategory === '' ? 'active' : ''}" data-cat="">全部 (${state.catalog.items.length})</button>
      ${state.catalog.categories.map((c) => {
        // 条数优先用服务端统计;旧服务端无 count 字段时退回本地计数
        const n = c.count ?? state.catalog.items.filter((e) => e.category === c.id).length;
        return `
        <button class="cat-tab ${state.catalogCategory === c.id ? 'active' : ''}" data-cat="${esc(c.id)}">${esc(c.name)} (${n})</button>`;
      }).join('')}
    </div>
    <div class="skills-grid" id="cat-list">${catalogCardsHtml()}</div>
  `;
  main.querySelector('#cat-q').addEventListener('input', (e) => {
    state.catalogQuery = e.target.value;
    refreshCatalogCards(main);
  });
  main.querySelectorAll('.cat-tab').forEach((t) =>
    t.addEventListener('click', () => {
      state.catalogCategory = t.dataset.cat;
      main.querySelectorAll('.cat-tab').forEach((x) => x.classList.toggle('active', x === t));
      refreshCatalogCards(main);
    }));
  bindCatalogInstalls(main);
}

// ---------- 全局共享视图(用户级:物化到 ~/.<agent>/skills,所有项目共享) ----------
function renderGlobal() {
  const main = document.getElementById('main');
  const g = state.global || { skills: [], agents: [], applyMode: 'symlink' };
  const globalSkills = state.skills.filter((s) => g.skills.includes(s.id));

  main.innerHTML = `
    <div class="main-title">全局共享</div>
    <div class="main-sub">物化到各 agent 的用户级 skills 目录(~/.claude/skills、~/.agents/skills 等),一次配置,该 agent 的所有项目共享</div>

    <div class="section">
      <h3>目标 Agents(未检测到的不可选)</h3>
      <div class="agent-checks">
        ${state.agents.map((a) => `
          <label class="agent-check ${a.detected ? '' : 'disabled'}">
            <input type="checkbox" data-agent-id="${a.id}"
              ${g.agents.includes(a.id) ? 'checked' : ''} ${a.detected ? '' : 'disabled'} />
            ${esc(a.displayName)}${a.detected ? '' : '(未检测到)'}
          </label>`).join('')}
      </div>
    </div>

    <div class="section">
      <h3>共享技能集(${globalSkills.length})</h3>
      <div class="panel">
        ${globalSkills.length ? globalSkills.map((s) => `
          <div class="skill-row">
            <div>
              <div class="sname">${esc(s.name)}</div>
              <div class="sdesc">${esc(s.description)}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-remove-skill="${esc(s.id)}">移除</button>
          </div>`).join('') : '<div class="empty">尚未绑定技能,点击下方按钮从库中添加</div>'}
      </div>
      <div class="toolbar">
        <button class="btn" id="btn-add-skill">+ 从库中添加</button>
      </div>
    </div>

    <div class="section">
      <h3>应用模式</h3>
      <div class="radio-group">
        <label><input type="radio" name="g-mode" value="symlink" ${g.applyMode === 'symlink' ? 'checked' : ''} /> symlink(推荐,改动即时生效)</label>
        <label><input type="radio" name="g-mode" value="copy" ${g.applyMode === 'copy' ? 'checked' : ''} /> copy</label>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" id="g-apply">应用全局共享</button>
      <button class="btn" id="g-unapply">取消应用</button>
      <button class="btn" id="g-rollback">回滚</button>
      <span class="main-sub" style="align-self:center">上次 apply: ${esc(g.lastAppliedAt ? g.lastAppliedAt.replace('T', ' ').slice(0, 19) : '(从未)')}</span>
    </div>
  `;

  main.querySelectorAll('input[data-agent-id]').forEach((cb) =>
    cb.addEventListener('change', () => run(async () => {
      const agents = [...main.querySelectorAll('input[data-agent-id]:checked')].map((x) => x.dataset.agentId);
      await api('PUT', '/api/global', { agents });
      await loadAll();
      render();
      toast('目标 agents 已更新');
    })));

  main.querySelectorAll('input[name="g-mode"]').forEach((r) =>
    r.addEventListener('change', () => run(async () => {
      await api('PUT', '/api/global', { applyMode: r.value });
      await loadAll();
      toast('应用模式已更新');
    })));

  main.querySelectorAll('[data-remove-skill]').forEach((btn) =>
    btn.addEventListener('click', () => run(async () => {
      const sid = btn.dataset.removeSkill;
      await api('PUT', '/api/global', { skills: g.skills.filter((x) => x !== sid) });
      await loadAll();
      render();
      toast('已移除');
    })));

  document.getElementById('btn-add-skill').addEventListener('click', openAddGlobalSkillModal);
  document.getElementById('g-apply').addEventListener('click', () => run(async () => {
    const r = await api('POST', '/api/global/apply');
    await loadAll();
    render();
    toast(`已全局应用 ${r.applied.length} 项${r.warnings.length ? `,${r.warnings.length} 条警告` : ''}`);
    r.warnings.forEach((w) => toast(w, 'err'));
  }));
  document.getElementById('g-unapply').addEventListener('click', () => run(async () => {
    const r = await api('POST', '/api/global/unapply');
    toast(`已移除 ${r.removed.length} 项(全局共享)`);
  }));
  document.getElementById('g-rollback').addEventListener('click', () => run(async () => {
    const r = await api('POST', '/api/global/rollback');
    toast(r.detail, r.restored ? 'ok' : 'err');
  }));
}

/** 从库中添加技能到全局共享集(热度排序:常用 > 高星;全局无项目上下文) */
function openAddGlobalSkillModal() {
  const g = state.global || { skills: [] };
  const modal = openModal(`
    <h2>从库中添加技能 → 全局共享</h2>
    <div id="ask-body"><div class="spinner"></div><div class="loading-text">按热度排序中…</div></div>
    <div class="modal-actions"><button class="btn" id="m-close">关闭</button></div>
  `);
  modal.querySelector('#m-close').addEventListener('click', closeModal);
  run(async () => {
    const ranked = await api('GET', '/api/skills?rank=1');
    const available = ranked.filter((s) => !g.skills.includes(s.id));
    const body = modal.querySelector('#ask-body');
    body.innerHTML = available.length ? `<div class="rec-list">
      ${available.map((s) => `
        <div class="rec-item">
          <div class="rhead">
            <span class="rname">${esc(s.name)} ${hotTags(s)}</span>
            <button class="btn btn-sm btn-primary" data-add="${esc(s.id)}">添加</button>
          </div>
          <div class="rdesc">${esc(s.description)}</div>
        </div>`).join('')}
    </div>` : '<div class="empty">库中没有更多可添加的技能</div>';
    body.querySelectorAll('[data-add]').forEach((btn) =>
      btn.addEventListener('click', () => run(async () => {
        await api('PUT', '/api/global', { skills: [...g.skills, btn.dataset.add] });
        await loadAll();
        closeModal();
        render();
        toast('已添加到全局技能集');
      })));
  });
}

// ---------- 收养 agent 技能(逆向于 apply:agent 目录 → 中央库) ----------
function openAdoptModal() {
  const modal = openModal(`
    <h2>收养 agent 技能</h2>
    <div class="form-row"><label>从哪个 agent 的 skills 目录收养</label>
      <select id="ad-agent">
        ${state.agents.map((a) => `<option value="${a.id}">${esc(a.displayName)}(${a.id})${a.detected ? '' : ' — 未检测到'}</option>`).join('')}
      </select>
    </div>
    <div class="form-row"><label>作用域</label>
      <div class="radio-group">
        <label><input type="radio" name="ad-scope" value="project" checked /> 项目级(随项目目录)</label>
        <label><input type="radio" name="ad-scope" value="user" /> 用户级(~/.&lt;agent&gt;/skills)</label>
      </div>
    </div>
    <div class="form-row" id="ad-path-row"><label>项目根目录(留空取服务启动目录)</label>
      <input type="text" id="ad-path" placeholder="/home/me/my-app" /></div>
    <div id="ad-result"></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">关闭</button>
      <button class="btn btn-primary" id="m-ok">收养</button>
    </div>
  `);
  modal.querySelectorAll('input[name="ad-scope"]').forEach((r) =>
    r.addEventListener('change', () => {
      modal.querySelector('#ad-path-row').style.display =
        modal.querySelector('input[name="ad-scope"]:checked').value === 'project' ? '' : 'none';
    }));
  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', () => run(async () => {
    const agent = modal.querySelector('#ad-agent').value;
    const scope = modal.querySelector('input[name="ad-scope"]:checked').value;
    const projectPath = modal.querySelector('#ad-path').value.trim();
    const btn = modal.querySelector('#m-ok');
    btn.disabled = true; btn.textContent = '收养中…';
    let r;
    try {
      r = await api('POST', '/api/skills/adopt', { agent, scope, ...(projectPath ? { projectPath } : {}) });
    } catch (err) {
      btn.disabled = false; btn.textContent = '收养';
      throw err;
    }
    await loadAll();
    render(); // 主区卡片刷新;弹窗保持打开展示明细
    const lines = [
      ...r.adopted.map((s) => `✓ ${s.id}  已收养`),
      ...r.skipped.map((n) => `- ${n}  已在库中,跳过`),
      ...r.invalid.map((i) => `✗ ${i.dir}  ${i.reason}`),
    ];
    modal.querySelector('#ad-result').innerHTML = lines.length
      ? `<div class="rec-list">${lines.map((l) => `<div class="rec-item"><div class="rdesc">${esc(l)}</div></div>`).join('')}</div>`
      : '<div class="empty">该目录下没有可收养的 skill</div>';
    btn.disabled = false; btn.textContent = '收养';
    toast(`收养完成:新收 ${r.adopted.length},跳过 ${r.skipped.length},非法 ${r.invalid.length}`, r.invalid.length ? 'err' : 'ok');
  }));
}

// ---------- 配置库 profile 导出/导入(完整配置跨机器/跨平台共享) ----------
function exportProfileFile() {
  run(async () => {
    const { bundle, warnings } = await api('GET', '/api/profile/export');
    // 浏览器侧直接落盘为下载文件,不经服务端文件系统
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ssw-profile.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出配置库(skills ${bundle.skills.length}、MCP ${(bundle.mcps || []).length}、项目 ${(bundle.projects?.projects || []).length})`);
    (warnings || []).forEach((w) => toast(w, 'err'));
  });
}

function openProfileImportModal() {
  const modal = openModal(`
    <h2>导入配置库</h2>
    <div class="form-row"><label>选择 profile JSON 文件(含 skills/MCP/项目档案/全局共享;已在库中的会跳过)</label>
      <input type="file" id="pf-file" accept="application/json,.json" /></div>
    <div id="pf-result"></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">关闭</button>
      <button class="btn btn-primary" id="m-ok">导入</button>
    </div>
  `);
  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', () => run(async () => {
    const file = modal.querySelector('#pf-file').files[0];
    if (!file) return toast('请选择 profile JSON 文件', 'err');
    let bundle;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      return toast('文件不是合法 JSON', 'err');
    }
    const btn = modal.querySelector('#m-ok');
    btn.disabled = true; btn.textContent = '导入中…';
    let r;
    try {
      r = await apiWithProgress('POST', '/api/profile/import', { bundle });
    } catch (err) {
      // 失败恢复按钮可重试;错误继续抛给 run() 弹 toast
      btn.disabled = false; btn.textContent = '导入';
      throw err;
    }
    await loadAll();
    render(); // 主区刷新;弹窗保持打开展示明细
    const lines = [
      ...r.installedRepos.map((x) => `✓ ${x}  已安装`),
      ...r.skippedRepos.map((x) => `- ${x}  已在库中,跳过`),
      ...r.failed.map((f) => `✗ ${f.repo}  ${f.message}`),
      `local 技能还原 ${r.localRestored.length} 个;项目新增 ${r.projectsAdded} 个(同名跳过 ${r.projectsSkipped});MCP 新增 ${r.mcpsAdded} 个${r.globalImported ? ';全局档案已导入' : ''}`,
      ...(r.warnings || []).map((w) => `警告: ${w}`),
    ];
    modal.querySelector('#pf-result').innerHTML =
      `<div class="rec-list">${lines.map((l) => `<div class="rec-item"><div class="rdesc">${esc(l)}</div></div>`).join('')}</div>`;
    btn.textContent = '已导入';
    toast(`导入完成:仓库新装 ${r.installedRepos.length},失败 ${r.failed.length}`, r.failed.length ? 'err' : 'ok');
  }));
}

// ---------- 启动 ----------
document.querySelectorAll('.view-btn').forEach((b) =>
  b.addEventListener('click', () => {
    state.view = b.dataset.view;
    if (state.view === 'catalog') state.catalog = null; // 每次进入重拉,保证 installed 标记新鲜
    render();
  }));
document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);
document.getElementById('btn-settings').addEventListener('click', openSettingsModal);

run(async () => {
  await loadAll();
  render();
});
