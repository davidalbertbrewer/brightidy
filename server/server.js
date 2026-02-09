/*
 * Brightidy server
 *
 * A very simple cleaning‑services marketplace backend implemented without
 * external dependencies.  It uses Node’s built‑in modules to serve a set
 * of JSON endpoints and stores data in a JSON file on disk.  While this
 * implementation is intentionally minimalistic for demonstration purposes,
 * the API surface models many of the key features offered by services such
 * as Cleanster: account creation, login, listing available cleaners,
 * booking appointments, messaging and rating/ tipping.
 *
 * To run the server locally you can execute `node server.js` inside
 * the ``brightidy/server`` directory.  The server will listen on port
 * 3000 by default.  If you restart the process the JSON database will
 * persist across runs.  When used in production you should replace the
 * simple authentication and storage mechanisms with more secure
 * implementations and add protections such as CORS policies and
 * validation.
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Location of our simple JSON database on disk.  If the file does
// not yet exist it will be created lazily when the server starts.
const DB_PATH = path.join(__dirname, 'db.json');

// In‑memory token table mapping auth tokens to usernames.  Tokens are
// generated at login and are removed when the server restarts.
const sessions = {};

/**
 * Load the JSON database from disk.  If the file does not exist
 * return a fresh set of default collections.  This function will
 * synchronously read from the filesystem; since it is only called
 * during request handling performance is adequate for small projects.
 */
function loadDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    return {
      users: [],
      bookings: [],
      messages: [],
    };
  }
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Failed to read database:', err);
    return { users: [], bookings: [], messages: [] };
  }
}

/**
 * Save the JSON database to disk.  Writes are atomic: the file
 * contents are first written to a temporary location and then
 * renamed into place.  This reduces the chance of corruption if
 * the process exits mid‑write.
 */
function saveDatabase(db) {
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

/**
 * Generate a secure random token for session authentication.  The
 * returned string is URL‑safe and does not reveal any secrets on its
 * own.  Tokens are 32 bytes long (64 characters when hex encoded).
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a plaintext password using SHA‑256.  Note: this simple
 * implementation does not salt the hash.  In a real application you
 * should use a proper password hashing algorithm (e.g. bcrypt or
 * Argon2) with unique salts for each user.
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Extract JSON from the request body.  Returns a promise that
 * resolves to an object.  If the body cannot be parsed it will
 * resolve to null.
 */
function parseRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const obj = body ? JSON.parse(body) : {};
        resolve(obj);
      } catch (err) {
        resolve(null);
      }
    });
  });
}

/**
 * Send a JSON response.  If `data` is an object it will be stringified.
 * The response will include appropriate headers for content type and
 * CORS.  For security the CORS policy is deliberately permissive to
 * facilitate development; you may restrict `Access-Control-Allow-Origin`
 * in production.
 */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

/**
 * Middleware to handle CORS preflight requests.  If the request
 * method is OPTIONS we simply respond with an empty 204 response.
 */
function handleCors(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return true;
  }
  return false;
}

/**
 * Authenticate a request using a Bearer token.  Returns the
 * corresponding user object if the token is valid or null otherwise.
 * The Authorization header must be in the form "Bearer <token>".
 */
function authenticate(req, db) {
  const authHeader = req.headers['authorization'] || '';
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    const token = parts[1];
    const username = sessions[token];
    if (username) {
      return db.users.find((u) => u.username === username) || null;
    }
  }
  return null;
}

/**
 * Route handler: register a new user.  Expects a JSON body
 * containing ``username``, ``password`` and ``role`` (either
 * ``client`` or ``cleaner``).  Returns 201 on success or 400 if the
 * username is taken or the input is invalid.
 */
async function handleRegister(req, res, db) {
  const data = await parseRequestBody(req);
  if (!data || !data.username || !data.password || !data.role) {
    return sendJson(res, 400, { error: 'Missing username, password or role' });
  }
  if (!['client', 'cleaner', 'admin'].includes(data.role)) {
    return sendJson(res, 400, { error: 'Invalid role' });
  }
  if (db.users.some((u) => u.username === data.username)) {
    return sendJson(res, 400, { error: 'Username already exists' });
  }
  const user = {
    id: db.users.length + 1,
    username: data.username,
    passwordHash: hashPassword(data.password),
    role: data.role,
  };
  db.users.push(user);
  saveDatabase(db);
  return sendJson(res, 201, { message: 'User created' });
}

/**
 * Route handler: login a user.  Expects a JSON body with
 * ``username`` and ``password``.  On success returns a token and
 * basic user information (excluding the password hash).  On failure
 * returns 401.
 */
async function handleLogin(req, res, db) {
  const data = await parseRequestBody(req);
  if (!data || !data.username || !data.password) {
    return sendJson(res, 400, { error: 'Missing username or password' });
  }
  const user = db.users.find((u) => u.username === data.username);
  if (!user || user.passwordHash !== hashPassword(data.password)) {
    return sendJson(res, 401, { error: 'Invalid credentials' });
  }
  // Generate token and store mapping
  const token = generateToken();
  sessions[token] = user.username;
  return sendJson(res, 200, {
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
}

/**
 * Route handler: list all cleaners.  Public endpoint – no
 * authentication required.  Returns an array of user objects with
 * role ``cleaner``.  Password hashes are excluded from the output.
 */
function handleListCleaners(req, res, db) {
  const cleaners = db.users
    .filter((u) => u.role === 'cleaner')
    .map((u) => ({ id: u.id, username: u.username, role: u.role }));
  return sendJson(res, 200, { cleaners });
}

/**
 * Route handler: create a booking.  Only clients may create bookings.
 * Expects ``propertyAddress``, ``propertyType``, ``date``, ``time`` and
 * ``duration`` in the body.  The booking is created with status
 * ``pending`` and no cleaner assigned.  Returns the booking record.
 */
async function handleCreateBooking(req, res, db, user) {
  if (user.role !== 'client') {
    return sendJson(res, 403, { error: 'Only clients can create bookings' });
  }
  const data = await parseRequestBody(req);
  const requiredFields = ['propertyAddress', 'propertyType', 'date', 'time', 'duration'];
  if (!data || requiredFields.some((f) => !data[f])) {
    return sendJson(res, 400, { error: 'Missing booking fields' });
  }
  const booking = {
    id: db.bookings.length + 1,
    client: user.username,
    cleaner: null,
    propertyAddress: data.propertyAddress,
    propertyType: data.propertyType,
    date: data.date,
    time: data.time,
    duration: data.duration,
    status: 'pending',
    rating: null,
    tip: null,
  };
  db.bookings.push(booking);
  saveDatabase(db);
  return sendJson(res, 201, { booking });
}

/**
 * Route handler: list bookings relevant to the authenticated user.
 * Clients see bookings they created; cleaners see bookings assigned
 * to them; admins see all bookings.  Returns an array of bookings.
 */
function handleListBookings(req, res, db, user) {
  let bookings;
  if (user.role === 'client') {
    bookings = db.bookings.filter((b) => b.client === user.username);
  } else if (user.role === 'cleaner') {
    bookings = db.bookings.filter((b) => b.cleaner === user.username);
  } else {
    bookings = db.bookings;
  }
  return sendJson(res, 200, { bookings });
}

/**
 * Route handler: assign or update booking status.  Only cleaners can
 * accept bookings (when status is ``pending``) or mark them as
 * ``completed``.  Expects ``bookingId`` and optionally ``status`` in
 * the request body.  If no status is provided ``accepted`` is used
 * when accepting a pending booking.  The booking’s cleaner will be
 * set to the authenticated cleaner.  Returns the updated booking.
 */
async function handleUpdateBooking(req, res, db, user) {
  if (user.role !== 'cleaner') {
    return sendJson(res, 403, { error: 'Only cleaners can update bookings' });
  }
  const data = await parseRequestBody(req);
  if (!data || !data.bookingId) {
    return sendJson(res, 400, { error: 'Missing bookingId' });
  }
  const booking = db.bookings.find((b) => b.id === Number(data.bookingId));
  if (!booking) {
    return sendJson(res, 404, { error: 'Booking not found' });
  }
  // A cleaner can accept a pending booking
  if (!booking.cleaner) {
    booking.cleaner = user.username;
    booking.status = 'accepted';
  }
  // Cleaners can update status to completed
  if (data.status && ['accepted', 'in_progress', 'completed'].includes(data.status)) {
    booking.status = data.status;
  }
  saveDatabase(db);
  return sendJson(res, 200, { booking });
}

/**
 * Route handler: create a message within a booking.  Any party
 * involved in the booking (client or cleaner) may send a message.
 * Expects ``bookingId``, ``content``.  The message recipient is
 * inferred from the sender’s role.  Returns the created message.
 */
async function handleCreateMessage(req, res, db, user) {
  const data = await parseRequestBody(req);
  if (!data || !data.bookingId || !data.content) {
    return sendJson(res, 400, { error: 'Missing bookingId or content' });
  }
  const booking = db.bookings.find((b) => b.id === Number(data.bookingId));
  if (!booking) {
    return sendJson(res, 404, { error: 'Booking not found' });
  }
  // Determine recipient: if sender is client the recipient is the cleaner and vice versa
  let recipient;
  if (user.username === booking.client) {
    recipient = booking.cleaner;
  } else if (user.username === booking.cleaner) {
    recipient = booking.client;
  } else {
    return sendJson(res, 403, { error: 'Not part of the booking' });
  }
  const message = {
    id: db.messages.length + 1,
    bookingId: booking.id,
    sender: user.username,
    recipient,
    content: data.content,
    timestamp: new Date().toISOString(),
  };
  db.messages.push(message);
  saveDatabase(db);
  return sendJson(res, 201, { message });
}

/**
 * Route handler: list messages for a booking.  The authenticated
 * user must be part of the booking.  Returns an array of messages
 * sorted by timestamp.
 */
function handleListMessages(req, res, db, user) {
  const parsedUrl = url.parse(req.url, true);
  const bookingId = Number(parsedUrl.query.bookingId);
  if (!bookingId) {
    return sendJson(res, 400, { error: 'Missing bookingId query parameter' });
  }
  const booking = db.bookings.find((b) => b.id === bookingId);
  if (!booking) {
    return sendJson(res, 404, { error: 'Booking not found' });
  }
  if (user.username !== booking.client && user.username !== booking.cleaner && user.role !== 'admin') {
    return sendJson(res, 403, { error: 'Not authorised to view messages' });
  }
  const messages = db.messages
    .filter((m) => m.bookingId === bookingId)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return sendJson(res, 200, { messages });
}

/**
 * Route handler: submit a rating and optional tip for a booking.
 * Only the client may rate a booking once it has been completed by
 * the cleaner.  Expects ``bookingId``, ``rating`` (1‑5) and
 * optional ``tip`` amount.  Returns the updated booking.
 */
async function handleRateBooking(req, res, db, user) {
  if (user.role !== 'client') {
    return sendJson(res, 403, { error: 'Only clients can rate bookings' });
  }
  const data = await parseRequestBody(req);
  if (!data || !data.bookingId || !data.rating) {
    return sendJson(res, 400, { error: 'Missing bookingId or rating' });
  }
  const booking = db.bookings.find((b) => b.id === Number(data.bookingId));
  if (!booking) {
    return sendJson(res, 404, { error: 'Booking not found' });
  }
  if (booking.client !== user.username) {
    return sendJson(res, 403, { error: 'Not your booking' });
  }
  if (booking.status !== 'completed') {
    return sendJson(res, 400, { error: 'Booking not completed yet' });
  }
  if (booking.rating !== null) {
    return sendJson(res, 400, { error: 'Booking already rated' });
  }
  const rating = Number(data.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, { error: 'Rating must be an integer between 1 and 5' });
  }
  booking.rating = rating;
  if (data.tip) {
    booking.tip = Number(data.tip);
  }
  saveDatabase(db);
  return sendJson(res, 200, { booking });
}

/**
 * Primary request handler.  Dispatches to specific route handlers
 * based on method and path.  Unrecognised routes return 404.
 */
async function handleRequest(req, res) {
  // Handle CORS preflight
  if (handleCors(req, res)) {
    return;
  }
  const parsedUrl = url.parse(req.url, true);
  const db = loadDatabase();
  // Public routes
  if (req.method === 'POST' && parsedUrl.pathname === '/register') {
    return handleRegister(req, res, db);
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/login') {
    return handleLogin(req, res, db);
  }
  if (req.method === 'GET' && parsedUrl.pathname === '/cleaners') {
    return handleListCleaners(req, res, db);
  }
  // Protected routes require authentication
  const user = authenticate(req, db);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorised' });
  }
  // Bookings
  if (req.method === 'POST' && parsedUrl.pathname === '/bookings') {
    return handleCreateBooking(req, res, db, user);
  }
  if (req.method === 'GET' && parsedUrl.pathname === '/bookings') {
    return handleListBookings(req, res, db, user);
  }
  if (req.method === 'PUT' && parsedUrl.pathname === '/bookings') {
    return handleUpdateBooking(req, res, db, user);
  }
  // Messages
  if (req.method === 'POST' && parsedUrl.pathname === '/messages') {
    return handleCreateMessage(req, res, db, user);
  }
  if (req.method === 'GET' && parsedUrl.pathname === '/messages') {
    return handleListMessages(req, res, db, user);
  }
  // Rating
  if (req.method === 'POST' && parsedUrl.pathname === '/rate') {
    return handleRateBooking(req, res, db, user);
  }
  // Default: not found
  return sendJson(res, 404, { error: 'Not found' });
}

// Create and start the server
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('Unexpected error:', err);
    sendJson(res, 500, { error: 'Internal server error' });
  });
});
server.listen(PORT, () => {
  console.log(`Brightidy server listening on port ${PORT}`);
});
