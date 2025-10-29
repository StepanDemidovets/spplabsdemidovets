(async function(){
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

  function setCookie(name, value, days=1){
    const d = new Date();
    d.setTime(d.getTime() + days*24*60*60*1000);
    document.cookie = name + '=' + value + '; path=/; expires=' + d.toUTCString();
  }

  async function graphql(query, variables){
    const res = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      credentials: 'same-origin'
    });
    return res.json();
  }

  async function checkAuth(){
    const q = `query { me { userId email } }`;
    const r = await graphql(q, {});
    if (!r || r.errors || !r.data || !r.data.me) {
      userArea.innerText = 'Not logged';
      logoutBtn.style.display = 'none';
      showRegisterBtn.style.display = 'inline-block';
    } else {
      userArea.innerText = r.data.me.email;
      logoutBtn.style.display = 'inline-block';
      showRegisterBtn.style.display = 'none';
    }
  }

  function renderTasks(items){
    const f = filter.value;
    const filtered = items.filter(it => f === 'all' ? true : it.status === f);
    tasksList.innerHTML = '';
    if (!filtered.length) tasksList.innerHTML = '<li>No tasks</li>';
    filtered.forEach(it => {
      const li = document.createElement('li');
      li.className = 'task ' + (it.status || '');
      li.innerHTML = `
        <div class="info">
          <strong>${escapeHtml(it.title)}</strong> <em>(${it.status})</em>
          <div>Due: ${it.dueDate || '-'}</div>
          <div class="attachments">${it.attachments && it.attachments.length ? 'Attachments: ' + it.attachments.map(a => '<a href="/api/tasks/'+it.id+'/files/'+a.filename+'">'+escapeHtml(a.originalname)+'</a>').join(', ') : ''}</div>
        </div>
        <div>
          <button data-id="${it.id}" class="toggle">${it.status === 'done' ? 'Mark pending' : 'Mark done'}</button>
          <button data-id="${it.id}" class="del">Delete</button>
        </div>
      `;
      tasksList.appendChild(li);
    });
  }

  function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }

  // WebSocket for realtime updates
  let ws;
  function connectWS(){
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/updates');
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (Array.isArray(data)) renderTasks(data);
        } catch(e){}
      };
      ws.onclose = () => setTimeout(connectWS, 1000);
    } catch(e){
      console.warn('WS failed', e);
    }
  }
  connectWS();

  async function loadTasks(){
    const q = `query { tasks { id title status dueDate attachments { filename originalname } } }`;
    const r = await graphql(q, {});
    if (r && r.data && r.data.tasks) renderTasks(r.data.tasks);
    if (r && r.errors && r.errors[0] && r.errors[0].message && r.errors[0].message.includes('Unauthorized')) showLogin();
  }

  // Events
  refreshBtn.addEventListener('click', loadTasks);

  filter.addEventListener('change', loadTasks);

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const title = fd.get('title');
    const status = fd.get('status');
    const dueDate = fd.get('dueDate') || null;
    const fileInput = form.querySelector('input[type=file]');
    const file = fileInput && fileInput.files && fileInput.files[0];
    let fileObj = null;
    if (file) {
      fileObj = await readFileAsBase64(file);
      fileObj.originalname = file.name;
    }
    const m = `mutation($input: CreateTaskInput!){ createTask(input:$input){ id title status dueDate attachments{ filename originalname } } }`;
    const variables = { input: { title, status, dueDate, file: fileObj } };
    const res = await graphql(m, variables);
    if (res && res.errors && res.errors[0] && res.errors[0].message.includes('Unauthorized')) { showLogin(); return; }
    form.reset();
    // tasks will be updated via ws broadcast
    loadTasks();
  });

  tasksList.addEventListener('click', async (e) => {
    const id = Number(e.target.dataset.id);
    if (!id) return;
    if (e.target.classList.contains('toggle')) {
      const q = `query { tasks { id status } }`;
      const r = await graphql(q, {});
      if (!r || r.errors) { showLogin(); return; }
      const it = r.data.tasks.find(x => x.id == id);
      if (!it) return;
      const newStatus = it.status === 'done' ? 'pending' : 'done';
      const m = `mutation($input: UpdateTaskInput!){ updateTask(input:$input){ id status } }`;
      const res = await graphql(m, { input: { id, status: newStatus }});
      if (res && res.errors && res.errors[0] && res.errors[0].message.includes('Unauthorized')) { showLogin(); return; }
      loadTasks();
    } else if (e.target.classList.contains('del')) {
      if (!confirm('Delete?')) return;
      const m = `mutation($id: ID!){ deleteTask(id:$id){ message } }`;
      const res = await graphql(m, { id });
      if (res && res.errors && res.errors[0] && res.errors[0].message.includes('Unauthorized')) { showLogin(); return; }
      loadTasks();
    }
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    const body = { email: fd.get('email'), password: fd.get('password') };
    const m = `mutation($email:String!,$password:String!){ login(email:$email,password:$password){ token } }`;
    const r = await graphql(m, { email: body.email, password: body.password });
    if (r && r.data && r.data.login && r.data.login.token) {
      setCookie('token', r.data.login.token);
      hideLogin();
      checkAuth();
      loadTasks();
    } else {
      alert('Login failed');
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(registerForm);
    const body = { email: fd.get('email'), password: fd.get('password') };
    const m = `mutation($email:String!,$password:String!){ register(email:$email,password:$password){ token } }`;
    const r = await graphql(m, { email: body.email, password: body.password });
    if (r && r.data && r.data.register && r.data.register.token) {
      setCookie('token', r.data.register.token);
      hideRegister();
      checkAuth();
      loadTasks();
    } else {
      alert('Registration failed');
    }
  });

  logoutBtn.addEventListener('click', async () => {
    const m = `mutation{ logout{ ok } }`;
    await graphql(m, {});
    document.cookie = 'token=; Max-Age=0; path=/;';
    userArea.innerText = 'Not logged';
    logoutBtn.style.display = 'none';
    checkAuth();
    loadTasks();
  });

  showRegisterBtn.addEventListener('click', showRegister);

  function readFileAsBase64(file){
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = fr.result;
        const parts = s.split(',');
        resolve({ data: parts[1] });
      };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  // initial load
  checkAuth();
  loadTasks();

})();