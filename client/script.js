/*
 * Brightidy front‑end script
 *
 * This file provides client‑side logic to interact with the Brightidy
 * back‑end.  It manages user authentication, registration, booking
 * creation, message exchange, rating submissions and viewing of data.
 * Communication with the server is performed using the Fetch API.
 */

(() => {
 const baseUrl = 'https://brightidy-backend-b08dcff878ba.herokuapp.com';
  const statusEl = document.getElementById('status');
  const registerSection = document.getElementById('register-section');
  const loginSection = document.getElementById('login-section');
  const dashboardSection = document.getElementById('dashboard-section');
  const userNameSpan = document.getElementById('user-name');
  const userRoleSpan = document.getElementById('user-role');
  const clientActions = document.getElementById('client-actions');
  const cleanerActions = document.getElementById('cleaner-actions');
  const adminActions = document.getElementById('admin-actions');
  const outputEl = document.getElementById('output');

  let authToken = null;
  let currentUser = null;

  /**
   * Utility to display a status message in the header.
   * @param {string} msg
   */
  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  /**
   * Utility to update the dashboard based on the logged in user.
   */
  function updateDashboard() {
    if (authToken && currentUser) {
      registerSection.classList.add('hidden');
      loginSection.classList.add('hidden');
      dashboardSection.classList.remove('hidden');
      userNameSpan.textContent = currentUser.username;
      userRoleSpan.textContent = currentUser.role;
      // Show or hide action panels
      clientActions.classList.toggle('hidden', currentUser.role !== 'client');
      cleanerActions.classList.toggle('hidden', currentUser.role !== 'cleaner');
      adminActions.classList.toggle('hidden', currentUser.role !== 'admin');
    } else {
      registerSection.classList.remove('hidden');
      loginSection.classList.remove('hidden');
      dashboardSection.classList.add('hidden');
      userNameSpan.textContent = '';
      userRoleSpan.textContent = '';
    }
    outputEl.innerHTML = '';
  }

  /**
   * Wrapper around fetch that includes the Authorization header when
   * necessary and handles JSON parsing.
   */
  async function api(method, endpoint, data) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (authToken) {
      opts.headers['Authorization'] = 'Bearer ' + authToken;
    }
    if (data) {
      opts.body = JSON.stringify(data);
    }
    const response = await fetch(baseUrl + endpoint, opts);
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error || 'Request failed');
    }
    return json;
  }

  // Registration
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value.trim();
    const role = document.getElementById('reg-role').value;
    const msgEl = document.getElementById('register-message');
    msgEl.textContent = '';
    try {
      await api('POST', '/register', { username, password, role });
      msgEl.style.color = 'green';
      msgEl.textContent = 'Account created – you can now log in.';
      setStatus('');
    } catch (err) {
      msgEl.style.color = '#d00';
      msgEl.textContent = err.message;
    }
  });

  // Login
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const msgEl = document.getElementById('login-message');
    msgEl.textContent = '';
    try {
      const res = await api('POST', '/login', { username, password });
      authToken = res.token;
      currentUser = res.user;
      updateDashboard();
      setStatus('Logged in');
    } catch (err) {
      msgEl.style.color = '#d00';
      msgEl.textContent = err.message;
    }
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', () => {
    authToken = null;
    currentUser = null;
    setStatus('Logged out');
    updateDashboard();
  });

  // List cleaners
  document.getElementById('list-cleaners-btn').addEventListener('click', async () => {
    try {
      const res = await api('GET', '/cleaners');
      if (res.cleaners.length === 0) {
        outputEl.innerHTML = '<p>No cleaners found.</p>';
        return;
      }
      const list = document.createElement('ul');
      res.cleaners.forEach((c) => {
        const li = document.createElement('li');
        li.textContent = c.username;
        list.appendChild(li);
      });
      outputEl.innerHTML = '<h3>Available Cleaners:</h3>';
      outputEl.appendChild(list);
    } catch (err) {
      outputEl.innerHTML = `<p class="error">${err.message}</p>`;
    }
  });

  // Create booking
  document.getElementById('create-booking-btn').addEventListener('click', async () => {
    const propertyAddress = prompt('Enter property address:');
    if (!propertyAddress) return;
    const propertyType = prompt('Enter property type (home, office, airbnb):');
    if (!propertyType) return;
    const date = prompt('Enter date (YYYY-MM-DD):');
    if (!date) return;
    const time = prompt('Enter start time (HH:MM):');
    if (!time) return;
    const duration = prompt('Enter duration in hours (e.g., 2):');
    if (!duration) return;
    try {
      const res = await api('POST', '/bookings', {
        propertyAddress,
        propertyType,
        date,
        time,
        duration: Number(duration),
      });
      outputEl.innerHTML = `<p>Booking created with ID ${res.booking.id}.</p>`;
    } catch (err) {
      outputEl.innerHTML = `<p class="error">${err.message}</p>`;
    }
  });

  // My bookings
  async function loadBookings(listAll) {
    try {
      const res = await api('GET', '/bookings');
      const bookings = res.bookings;
      if (bookings.length === 0) {
        outputEl.innerHTML = '<p>No bookings found.</p>';
        return;
      }
      const list = document.createElement('ul');
      bookings.forEach((b) => {
        const li = document.createElement('li');
        li.innerHTML = `<strong>ID ${b.id}</strong> – ${b.propertyAddress} (${b.date} ${b.time}, ${b.duration}h) – Status: ${b.status}`;
        if (currentUser.role === 'cleaner' && (!b.cleaner || b.cleaner === currentUser.username)) {
          const btn = document.createElement('button');
          btn.textContent = b.cleaner ? 'Update Status' : 'Accept Booking';
          btn.addEventListener('click', async () => {
            const status = b.cleaner ? prompt('Enter new status (accepted, in_progress, completed):', b.status) : null;
            try {
              const res2 = await api('PUT', '/bookings', { bookingId: b.id, status });
              alert('Booking updated: status=' + res2.booking.status + ', cleaner=' + res2.booking.cleaner);
              loadBookings();
            } catch (err) {
              alert('Error: ' + err.message);
            }
          });
          li.appendChild(btn);
        }
        // Show messages button
        if ((b.cleaner && b.cleaner === currentUser.username) || b.client === currentUser.username) {
          const msgBtn = document.createElement('button');
          msgBtn.textContent = 'Messages';
          msgBtn.addEventListener('click', () => {
            showMessages(b.id);
          });
          li.appendChild(msgBtn);
        }
        list.appendChild(li);
      });
      outputEl.innerHTML = '<h3>Bookings:</h3>';
      outputEl.appendChild(list);
    } catch (err) {
      outputEl.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }
  document.getElementById('my-bookings-btn').addEventListener('click', () => loadBookings());
  document.getElementById('my-assignments-btn').addEventListener('click', () => loadBookings());
  document.getElementById('all-bookings-btn').addEventListener('click', () => loadBookings());

  // Rate booking
  document.getElementById('rate-booking-btn').addEventListener('click', async () => {
    const bookingId = prompt('Enter booking ID to rate:');
    if (!bookingId) return;
    const rating = prompt('Enter rating (1-5):');
    if (!rating) return;
    const tip = prompt('Enter tip amount (optional):');
    try {
      const data = { bookingId: Number(bookingId), rating: Number(rating) };
      if (tip) data.tip = Number(tip);
      const res = await api('POST', '/rate', data);
      outputEl.innerHTML = `<p>Thank you for rating! Rating: ${res.booking.rating}${res.booking.tip ? ', Tip: $' + res.booking.tip : ''}</p>`;
    } catch (err) {
      outputEl.innerHTML = `<p class="error">${err.message}</p>`;
    }
  });

  // Show messages for a booking
  async function showMessages(bookingId) {
    outputEl.innerHTML = '<p>Loading messages…</p>';
    try {
      const res = await api('GET', `/messages?bookingId=${bookingId}`);
      const container = document.createElement('div');
      container.innerHTML = `<h3>Messages for Booking ${bookingId}</h3>`;
      const list = document.createElement('ul');
      res.messages.forEach((m) => {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${m.sender}</strong>: ${m.content} <em>(${new Date(m.timestamp).toLocaleString()})</em>`;
        list.appendChild(li);
      });
      container.appendChild(list);
      // Input for new message
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Type your message...';
      const sendBtn = document.createElement('button');
      sendBtn.textContent = 'Send';
      sendBtn.addEventListener('click', async () => {
        const content = input.value.trim();
        if (!content) return;
        try {
          await api('POST', '/messages', { bookingId, content });
          input.value = '';
          showMessages(bookingId);
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
      container.appendChild(input);
      container.appendChild(sendBtn);
      outputEl.innerHTML = '';
      outputEl.appendChild(container);
    } catch (err) {
      outputEl.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  // Initial UI update
  updateDashboard();
})();
