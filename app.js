(async function(){
  const api = (path, opts={}) => fetch(path, Object.assign({ credentials: 'same-origin' }, opts))
    .then(async res => {
      if (res.status === 401) {
        showLogin();
        throw { status:401 };
      }
      const ct = res.headers.get('content-type')||'';
      if (ct.includes('json')) return res.json();
      return res;
    });

  const qs = s => document.querySelector(s);
  const tasksList = qs('#tasks-list');
  const filter = qs('#filter');
  const refreshBtn = qs('#refresh');
  const createForm = qs('#create-form');
  const loginModal = qs('#login-modal');
  const loginForm = qs('#login-form');
  const registerModal = qs('#register-modal');
  const registerForm = qs('#register-form');
  const userArea = qs('#user-area');
  const logoutBtn = qs('#logout');
  const showRegisterBtn = qs('#show-register');

  function showLogin(){ loginModal.style.display = 'flex'; }
  function hideLogin(){ loginModal.style.display = 'none'; }
  function showRegister(){ registerModal.style.display = 'flex'; }
  function hideRegister(){ registerModal.style.display = 'none'; }

  async function checkAuth(){
    try {
      const me = await api('/api/me');
      userArea.innerText = me.email;
      logoutBtn.style.display = 'inline-block';
      showRegisterBtn.style.display = 'none';
    } catch(e){
      userArea.innerText = 'Not logged';
      logoutBtn.style.display = 'none';
      showRegisterBtn.style.display = 'inline-block';
    }
  }

  async function loadTasks(){
    tasksList.innerHTML = 'Loading...';
    try {
      const items = await api('/api/tasks');
      renderTasks(items);
    } catch(e){
      if (e.status === 401) return;
      tasksList.innerHTML = '<li>Error loading</li>';
    }
  }

  function renderTasks(items){
    const f = filter.value;
    const filtered = items.filter(it => f==='all' ? true : it.status === f);
    tasksList.innerHTML = '';
    if (!filtered.length) tasksList.innerHTML = '<li>No tasks</li>';
    filtered.forEach(it => {
      const li = document.createElement('li');
      li.className = 'task';
      li.innerHTML = `
        <strong>${escapeHtml(it.title)}</strong> <em>(${it.status})</em>
        <div>Due: ${it.dueDate || '-'}</div>
        <div class="attach">${it.attachments && it.attachments.length ? 'Attachments: ' + it.attachments.map(a => '<a href="/api/tasks/'+it.id+'/files/'+a.filename+'">'+escapeHtml(a.originalname)+'</a>').join(', ') : ''}</div>
        <div>
          <button data-id="${it.id}" class="toggle">${it.status==='done'?'Mark pending':'Mark done'}</button>
          <button data-id="${it.id}" class="del">Delete</button>
        </div>
      `;
      tasksList.appendChild(li);
    });
  }

  function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }

  // events
  refreshBtn.addEventListener('click', loadTasks);
  filter.addEventListener('change', loadTasks);

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    try {
      await api('/api/tasks', { method: 'POST', body: fd });
      form.reset();
      await loadTasks();
    } catch(err){ if (err.status!==401) alert('Error creating'); }
  });

  tasksList.addEventListener('click', async (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    if (e.target.classList.contains('toggle')) {
      try {
        const items = await api('/api/tasks');
        const it = items.find(x=>x.id==id);
        const newStatus = it.status === 'done' ? 'pending' : 'done';
        await api('/api/tasks/'+id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }) });
        await loadTasks();
      } catch(err){ if (err.status!==401) alert('Error updating'); }
    } else if (e.target.classList.contains('del')) {
      if (!confirm('Delete?')) return;
      try {
        await api('/api/tasks/'+id, { method: 'DELETE' });
        await loadTasks();
      } catch(err){ if (err.status!==401) alert('Error deleting'); }
    }
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    const body = { email: fd.get('email'), password: fd.get('password') };
    try {
      await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      hideLogin();
      await checkAuth();
      await loadTasks();
    } catch(err){ alert('Login failed'); }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(registerForm);
    const body = { email: fd.get('email'), password: fd.get('password') };
    try {
      await api('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      hideRegister();
      await checkAuth();
      await loadTasks();
    } catch(err){ 
      try { const j = await err; } catch(e) {}
      alert('Registration failed');
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    userArea.innerText = 'Not logged';
    logoutBtn.style.display = 'none';
    await loadTasks();
  });

  showRegisterBtn.addEventListener('click', showRegister);

  // initial
  await checkAuth();
  await loadTasks();
})();
