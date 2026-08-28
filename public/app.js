/* Skills SwitchTool 前端:状态对象 + render 函数,全部操作走 fetch 调 API */

// ---------- 全局状态 ----------
const state = {
  view: 'projects',        // 'projects' | 'skills'
  agents: [],              // [{id, displayName, detected, capabilities}]
  projects: [],
  activeProjectId: null,
  skills: [],
  selectedProjectId: null, // 主区当前展示的项目
};

// ---------- 工具 ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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
  const [agents, pdata, skills] = await Promise.all([
    api('GET', '/api/agents'),
    api('GET', '/api/projects'),
    api('GET', '/api/skills'),
  ]);
  state.agents = agents;
  state.projects = pdata.projects;
  state.activeProjectId = pdata.activeProjectId;
  state.skills = skills;
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

  document.getElementById('btn-add-skill').addEventListener('click', () => openAddSkillModal(p));
  document.getElementById('btn-apply').addEventListener('click', () => run(async () => {
    const r = await api('POST', `/api/projects/${p.id}/apply`);
    await loadAll();
    render();
    toast(`已应用 ${r.applied.length} 项${r.warnings.length ? `,${r.warnings.length} 条警告` : ''}`);
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
    <div class="modal-actions"><button class="btn" id="m-close">关闭</button></div>
  `);
  modal.querySelector('#m-close').addEventListener('click', closeModal);
  modal.querySelectorAll('input[name="st-theme"]').forEach((r) =>
    r.addEventListener('change', () => setTheme(r.value)));
}

// ---------- 从库中添加技能 ----------
function openAddSkillModal(project) {
  const available = state.skills.filter((s) => !project.skills.includes(s.id));
  const modal = openModal(`
    <h2>从库中添加技能 → ${esc(project.name)}</h2>
    ${available.length ? `<div class="rec-list">
      ${available.map((s) => `
        <div class="rec-item">
          <div class="rhead">
            <span class="rname">${esc(s.name)}</span>
            <button class="btn btn-sm btn-primary" data-add="${esc(s.id)}">添加</button>
          </div>
          <div class="rdesc">${esc(s.description)}</div>
        </div>`).join('')}
    </div>` : '<div class="empty">库中没有更多可添加的技能</div>'}
    <div class="modal-actions"><button class="btn" id="m-close">关闭</button></div>
  `);
  modal.querySelector('#m-close').addEventListener('click', closeModal);
  modal.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => run(async () => {
      await api('POST', `/api/projects/${project.id}/skills`, { skillIds: [...project.skills, btn.dataset.add] });
      await loadAll();
      closeModal();
      render();
      toast('已添加到项目技能集');
    })));
}

// ---------- 新建项目(含推荐流程) ----------
function openNewProjectModal() {
  const modal = openModal(`
    <h2>新建项目</h2>
    <div class="form-row"><label>项目名称</label><input type="text" id="np-name" placeholder="my-app" /></div>
    <div class="form-row"><label>目录路径(绝对路径)</label><input type="text" id="np-path" placeholder="/home/me/my-app" /></div>
    <div class="form-row"><label>应用模式</label>
      <div class="radio-group">
        <label><input type="radio" name="np-mode" value="symlink" checked /> symlink(推荐,改动即时生效)</label>
        <label><input type="radio" name="np-mode" value="copy" /> copy</label>
      </div>
    </div>
    <div class="form-row"><label>目标 Agents</label>
      <div class="agent-checks">${agentCheckboxList()}</div>
    </div>
    <div id="np-recommend"></div>
    <div class="modal-actions">
      <button class="btn" id="np-cancel">取消</button>
      <button class="btn btn-primary" id="np-submit">创建并获取推荐</button>
    </div>
  `);
  modal.querySelector('#np-cancel').addEventListener('click', closeModal);
  modal.querySelector('#np-submit').addEventListener('click', () => run(async () => {
    const name = modal.querySelector('#np-name').value.trim();
    const projPath = modal.querySelector('#np-path').value.trim();
    const applyMode = modal.querySelector('input[name="np-mode"]:checked').value;
    const agents = [...modal.querySelectorAll('input[name="m-agent"]:checked')].map((x) => x.value);
    if (!name || !projPath) return toast('名称与路径必填', 'err');

    const project = await api('POST', '/api/projects', { name, path: projPath, agents, applyMode });
    state.selectedProjectId = project.id;
    await loadAll();

    // 创建成功后拉推荐(加载态 spinner)
    const box = modal.querySelector('#np-recommend');
    box.innerHTML = '<div class="spinner"></div><div class="loading-text">正在检测技术栈并搜索 GitHub 推荐…</div>';
    modal.querySelector('#np-submit').disabled = true;

    let rec;
    try {
      rec = await api('GET', `/api/recommend?projectId=${encodeURIComponent(project.id)}`);
    } catch (err) {
      box.innerHTML = `<div class="empty">推荐加载失败: ${esc(err.message)}</div>`;
      return;
    }
    if (!rec.items.length) {
      box.innerHTML = `<div class="empty">${esc(rec.message || '暂无推荐')}</div>`;
      return;
    }
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
        const installed = await api('POST', '/api/skills', { source: 'github', uri: btn.dataset.recUrl });
        const latest = (await api('GET', `/api/projects/${project.id}`));
        await api('POST', `/api/projects/${project.id}/skills`, {
          skillIds: [...latest.skills, ...installed.map((s) => s.id)],
        });
        await loadAll();
        btn.textContent = '已加入 ✓';
        toast(`已安装 ${installed.length} 个 skill 并绑定到项目`);
      })));
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
    const installed = await api('POST', '/api/skills', { source: 'github', uri });
    await loadAll();
    closeModal();
    render();
    toast(`已安装 ${installed.length} 个 skill`);
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
    toast('已安装');
  }));
}

function openInitSkillModal() {
  const modal = openModal(`
    <h2>新建我的 Skill</h2>
    <div class="form-row"><label>名称(小写字母/数字/连字符)</label>
      <input type="text" id="init-name" placeholder="my-skill" /></div>
    <div class="form-row"><label>描述</label>
      <input type="text" id="init-desc" placeholder="这个 skill 做什么" /></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">创建</button>
    </div>
  `);
  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', () => run(async () => {
    const name = modal.querySelector('#init-name').value.trim();
    const description = modal.querySelector('#init-desc').value.trim();
    if (!name || !description) return toast('名称与描述必填', 'err');
    await api('POST', '/api/skills/init', { name, description });
    await loadAll();
    closeModal();
    render();
    toast('脚手架已创建,可在库目录中继续编辑');
  }));
}

// ---------- 启动 ----------
document.querySelectorAll('.view-btn').forEach((b) =>
  b.addEventListener('click', () => { state.view = b.dataset.view; render(); }));
document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);
document.getElementById('btn-settings').addEventListener('click', openSettingsModal);

run(async () => {
  await loadAll();
  render();
});
