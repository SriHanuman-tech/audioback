// server.js
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Create uploads directory
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
  console.log('✅ Created uploads directory');
}

// Initialize SQLite Database
const db = new sqlite3.Database('./audio_uploads.db', (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
  } else {
    console.log('✅ Connected to SQLite database');
    initDatabase();
  }
});

// Create tables
function initDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('❌ Error creating users table:', err);
    else console.log('✅ Users table ready');
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS audio_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER,
      file_path TEXT NOT NULL,
      upload_type TEXT DEFAULT 'file',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `, (err) => {
    if (err) console.error('❌ Error creating audio_files table:', err);
    else console.log('✅ Audio files table ready');
  });
}

// Configure Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files allowed.'));
    }
  }
});

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// ===== ROUTES =====

// Test route
app.get('/', (req, res) => {
  res.json({ 
    message: '🎵 Audio Upload API is running!',
    endpoints: {
      register: 'POST /api/auth/register',
      login: 'POST /api/auth/login',
      upload: 'POST /api/upload/audio',
      getAudio: 'GET /api/audio',
      testUpload: 'POST /api/test-upload'
    }
  });
});

// Register
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password} = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username or email already exists' });
          }
          return res.status(500).json({ error: 'Registration failed' });
        }
        
        const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: this.lastID, username, email } });
      }
    );
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Server error' });
    }
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ 
      token, 
      user: { id: user.id, username: user.username, email: user.email } 
    });
  });
});

// TEST Upload (No Auth)
app.post('/api/test-upload', upload.single('audioFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { title } = req.body;

  if (!title) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Title is required' });
  }

  console.log('✅ Test upload successful:', req.file.filename);

  res.json({
    success: true,
    message: 'Upload successful!',
    file: {
      title,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      url: `http://localhost:${PORT}/uploads/${req.file.filename}`
    }
  });
});

// Upload (With Auth)
app.post('/api/upload/audio', authenticateToken, upload.single('audioFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { title, description } = req.body;
  const userId = req.user.id;

  if (!title) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Title required' });
  }

  db.run(
    `INSERT INTO audio_files (user_id, title, description, filename, original_name, file_size, file_path, upload_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, title, description || '', req.file.filename, req.file.originalname, 
     req.file.size, req.file.path, 'file'],
    function(err) {
      if (err) {
        console.error('❌ Database error:', err);
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ error: 'Failed to save' });
      }

      console.log('✅ Audio saved to database');
      res.json({
        message: 'Upload successful',
        audio: {
          id: this.lastID,
          title,
          description,
          url: `http://localhost:${PORT}/uploads/${req.file.filename}`
        }
      });
    }
  );
});

// Get user's audio files
app.get('/api/audio', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.all(
    'SELECT * FROM audio_files WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to fetch' });
      }

      const audioFiles = rows.map(row => ({
        ...row,
        url: `http://localhost:${PORT}/uploads/${row.filename}`
      }));

      res.json({ audioFiles });
    }
  );
});

// Start server
// app.listen(PORT, () => {
//   console.log(`
//   ╔════════════════════════════════════════╗
//   ║  🎵 Audio Upload Server Running!      ║
//   ║  📡 http://localhost:${PORT}            ║
//   ║  ✅ Ready to accept uploads            ║
//   ╚════════════════════════════════════════╝
//   `);
// });






// const https = require('https');
 app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
// const httpsOptions = {
//   key: fs.readFileSync('/etc/letsencrypt/live/api.maybeart.app/privkey.pem'),
//   cert: fs.readFileSync('/etc/letsencrypt/live/api.maybeart.app/fullchain.pem')
// };

// Start HTTPS server
// https.createServer(httpsOptions, app).listen(3002, () => {
//   console.log('HTTPS Server running on port 3002');
// });







// Graceful shutdown
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error(err.message);
    console.log('\n👋 Server stopped');
    process.exit(0);
  });
});
