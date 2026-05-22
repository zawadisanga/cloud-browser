// Cloud Browser - Professional System with Authentication
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { chromium } = require('playwright');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'cloud-browser-super-secret-key-2024';
const SALT_ROUNDS = 10;

// ==================== DATABASE SETUP ====================
let db;

async function initDatabase() {
    // Create database directory if not exists
    // Badilisha hii kwenye server.js:
const fs = require('fs');
const dbPath = process.env.DATABASE_URL || './database/database.sqlite';

// Create database directory if not exists (Heroku ina filesystem inayoandikika)
if (!fs.existsSync('./database')) {
    fs.mkdirSync('./database', { recursive: true });
}

db = await open({
    filename: dbPath,
    driver: sqlite3.Database
});
    
    // Users table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            full_name TEXT,
            plan TEXT DEFAULT 'free',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            api_key TEXT UNIQUE,
            daily_limit INTEGER DEFAULT 50,
            monthly_limit INTEGER DEFAULT 1000
        )
    `);
    
    // Usage logs table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS usage_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            api_key TEXT,
            endpoint TEXT,
            url TEXT,
            format TEXT,
            success BOOLEAN,
            response_time INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    
    // API keys table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            key TEXT UNIQUE NOT NULL,
            name TEXT,
            last_used DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    
    console.log('✅ Database initialized');
    
    // Create default admin user if not exists
    const adminExists = await db.get('SELECT * FROM users WHERE email = ?', ['admin@cloudbrowser.com']);
    if (!adminExists) {
        const hashedPassword = await bcrypt.hash('admin123', SALT_ROUNDS);
        const apiKey = 'admin_' + uuidv4();
        await db.run(
            'INSERT INTO users (email, password, full_name, plan, api_key, daily_limit, monthly_limit) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ['admin@cloudbrowser.com', hashedPassword, 'Administrator', 'enterprise', apiKey, 10000, 100000]
        );
        console.log('✅ Admin user created: admin@cloudbrowser.com / admin123');
    }
}

// ==================== MIDDLEWARE ====================
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Global rate limiter
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Global rate limit exceeded' }
});
app.use('/api/', globalLimiter);

// ==================== AUTHENTICATION MIDDLEWARE ====================
async function authenticateAPIKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required. Get your key at /register' });
    }
    
    const user = await db.get('SELECT * FROM users WHERE api_key = ?', [apiKey]);
    if (!user) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Check daily limits
    const today = new Date().toISOString().split('T')[0];
    const todayUsage = await db.get(
        'SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ? AND date(created_at) = ?',
        [user.id, today]
    );
    
    if (todayUsage.count >= user.daily_limit) {
        return res.status(429).json({ error: 'Daily limit exceeded. Upgrade your plan.' });
    }
    
    req.user = user;
    req.apiKey = apiKey;
    next();
}

async function authenticateJWT(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await db.get('SELECT * FROM users WHERE id = ?', [decoded.userId]);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ==================== BROWSER POOL MANAGER ====================
class BrowserPool {
    constructor() {
        this.available = [];
        this.busy = new Set();
        this.maxSize = parseInt(process.env.MAX_WORKERS) || 3;
        this.stats = {
            totalRequests: 0,
            cacheHits: 0,
            errors: 0,
            startTime: Date.now()
        };
        this.cache = new Map();
    }

    async init() {
        console.log(`🚀 Initializing ${this.maxSize} browser workers...`);
        for (let i = 0; i < this.maxSize; i++) {
            this.available.push(await this.createBrowser());
        }
        console.log(`✅ ${this.maxSize} browsers ready`);
        setInterval(() => this.cleanCache(), 3600000);
    }

    async createBrowser() {
        return await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
    }

    async acquire() {
        if (this.available.length > 0) {
            const browser = this.available.pop();
            this.busy.add(browser);
            return browser;
        }
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.available.length > 0) {
                    clearInterval(checkInterval);
                    const browser = this.available.pop();
                    this.busy.add(browser);
                    resolve(browser);
                }
            }, 100);
        });
    }

    release(browser) {
        this.busy.delete(browser);
        this.available.push(browser);
    }

    async capture(url, options = {}) {
        this.stats.totalRequests++;
        
        const cacheKey = `${url}:${options.format || 'png'}`;
        if (this.cache.has(cacheKey) && !options.skipCache) {
            this.stats.cacheHits++;
            return { data: this.cache.get(cacheKey), fromCache: true };
        }
        
        const browser = await this.acquire();
        let page = null;
        
        try {
            page = await browser.newPage();
            await page.setViewportSize({ width: options.width || 1920, height: options.height || 1080 });
            await page.goto(url, { waitUntil: 'networkidle', timeout: options.timeout || 30000 });
            
            let result;
            if (options.format === 'pdf') {
                result = await page.pdf({ format: options.paperFormat || 'A4', printBackground: true });
            } else {
                result = await page.screenshot({ fullPage: options.fullPage !== false, type: options.type || 'png', quality: options.quality || 90 });
            }
            
            this.cache.set(cacheKey, result);
            setTimeout(() => this.cache.delete(cacheKey), 3600000);
            
            return { data: result, fromCache: false };
        } catch (error) {
            this.stats.errors++;
            throw error;
        } finally {
            if (page) await page.close();
            this.release(browser);
        }
    }

    cleanCache() {
        this.cache.clear();
        console.log('🧹 Cache cleared');
    }

    getStats() {
        return {
            requests: this.stats.totalRequests,
            cacheHits: this.stats.cacheHits,
            errors: this.stats.errors,
            cacheHitRate: this.stats.totalRequests > 0 ? ((this.stats.cacheHits / this.stats.totalRequests) * 100).toFixed(2) : 0,
            uptime: Math.floor((Date.now() - this.stats.startTime) / 1000),
            workers: { available: this.available.length, busy: this.busy.size, total: this.available.length + this.busy.size, max: this.maxSize },
            cacheSize: this.cache.size
        };
    }
}

const browserPool = new BrowserPool();

// ==================== LOG USAGE ====================
async function logUsage(userId, apiKey, endpoint, url, format, success, responseTime) {
    try {
        await db.run(
            'INSERT INTO usage_logs (user_id, api_key, endpoint, url, format, success, response_time) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, apiKey, endpoint, url, format, success ? 1 : 0, responseTime]
        );
    } catch (error) {
        console.error('Log error:', error);
    }
}

// ==================== AUTH ROUTES ====================

// Register new user
app.post('/api/register', async (req, res) => {
    const { email, password, full_name } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUser) {
        return res.status(400).json({ error: 'User already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const apiKey = 'ck_' + uuidv4().replace(/-/g, '');
    
    await db.run(
        'INSERT INTO users (email, password, full_name, api_key, plan, daily_limit, monthly_limit) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [email, hashedPassword, full_name || email.split('@')[0], apiKey, 'free', 50, 1000]
    );
    
    res.json({ 
        success: true, 
        message: 'User registered successfully',
        api_key: apiKey,
        plan: 'free',
        daily_limit: 50
    });
});

// Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
        success: true,
        token,
        user: {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            plan: user.plan,
            api_key: user.api_key,
            daily_limit: user.daily_limit,
            monthly_limit: user.monthly_limit
        }
    });
});

// Get user info
app.get('/api/user', authenticateJWT, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const todayUsage = await db.get(
        'SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ? AND date(created_at) = ?',
        [req.user.id, today]
    );
    
    const totalUsage = await db.get(
        'SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ?',
        [req.user.id]
    );
    
    res.json({
        user: {
            id: req.user.id,
            email: req.user.email,
            full_name: req.user.full_name,
            plan: req.user.plan,
            api_key: req.user.api_key,
            daily_limit: req.user.daily_limit,
            monthly_limit: req.user.monthly_limit
        },
        usage: {
            today: todayUsage.count,
            total: totalUsage.count,
            remaining_today: req.user.daily_limit - todayUsage.count
        }
    });
});

// ==================== API ENDPOINTS (Protected) ====================

// Health check (public)
app.get('/health', (req, res) => {
    const stats = browserPool.getStats();
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        service: 'Cloud Browser API',
        ...stats
    });
});

// Screenshot endpoint
app.get('/api/screenshot', authenticateAPIKey, async (req, res) => {
    const startTime = Date.now();
    const { url, fullPage = 'true', width, height, quality } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    try {
        new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    try {
        const result = await browserPool.capture(url, {
            format: 'png',
            fullPage: fullPage === 'true',
            width: parseInt(width),
            height: parseInt(height),
            quality: parseInt(quality)
        });
        
        const responseTime = Date.now() - startTime;
        await logUsage(req.user.id, req.apiKey, '/screenshot', url, 'png', true, responseTime);
        
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.setHeader('X-Remaining-Requests', req.user.daily_limit - responseTime);
        res.send(result.data);
    } catch (error) {
        await logUsage(req.user.id, req.apiKey, '/screenshot', url, 'png', false, Date.now() - startTime);
        res.status(500).json({ error: error.message });
    }
});

// PDF endpoint
app.get('/api/pdf', authenticateAPIKey, async (req, res) => {
    const startTime = Date.now();
    const { url, format = 'A4' } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    try {
        const result = await browserPool.capture(url, { format: 'pdf', paperFormat: format });
        const responseTime = Date.now() - startTime;
        await logUsage(req.user.id, req.apiKey, '/pdf', url, 'pdf', true, responseTime);
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="document-${Date.now()}.pdf"`);
        res.send(result.data);
    } catch (error) {
        await logUsage(req.user.id, req.apiKey, '/pdf', url, 'pdf', false, Date.now() - startTime);
        res.status(500).json({ error: error.message });
    }
});

// Batch endpoint
app.post('/api/batch', authenticateAPIKey, async (req, res) => {
    const startTime = Date.now();
    const { urls, fullPage = true } = req.body;
    
    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: 'URLs array is required' });
    }
    
    if (urls.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 URLs per batch' });
    }
    
    const results = [];
    for (const url of urls) {
        try {
            const result = await browserPool.capture(url, { fullPage, skipCache: false });
            results.push({ url, success: true, data: result.data.toString('base64'), fromCache: result.fromCache });
            await logUsage(req.user.id, req.apiKey, '/batch', url, 'png', true, 0);
        } catch (error) {
            results.push({ url, success: false, error: error.message });
            await logUsage(req.user.id, req.apiKey, '/batch', url, 'png', false, 0);
        }
    }
    
    res.json({
        batchId: Date.now(),
        processingTime: Date.now() - startTime,
        total: urls.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
    });
});

// Stats endpoint (authenticated)
app.get('/api/stats', authenticateAPIKey, async (req, res) => {
    const stats = browserPool.getStats();
    
    const today = new Date().toISOString().split('T')[0];
    const todayUsage = await db.get(
        'SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ? AND date(created_at) = ?',
        [req.user.id, today]
    );
    
    res.json({
        system: stats,
        user: {
            plan: req.user.plan,
            daily_used: todayUsage.count,
            daily_limit: req.user.daily_limit,
            remaining: req.user.daily_limit - todayUsage.count,
            api_key: req.user.api_key
        }
    });
});

// Admin endpoints
app.get('/api/admin/users', authenticateJWT, async (req, res) => {
    if (req.user.email !== 'admin@cloudbrowser.com') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    const users = await db.all('SELECT id, email, full_name, plan, api_key, daily_limit, monthly_limit, created_at FROM users');
    res.json({ users });
});

app.get('/api/admin/usage', authenticateJWT, async (req, res) => {
    if (req.user.email !== 'admin@cloudbrowser.com') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    const usage = await db.all(`
        SELECT u.email, u.full_name, COUNT(l.id) as total_requests,
               SUM(CASE WHEN date(l.created_at) = date('now') THEN 1 ELSE 0 END) as today_requests
        FROM users u
        LEFT JOIN usage_logs l ON u.id = l.user_id
        GROUP BY u.id
        ORDER BY total_requests DESC
    `);
    res.json({ usage });
});

// ==================== FRONTEND ROUTES (IMEBORESHA) ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/register.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Catch-all for other HTML files
app.get('*.html', (req, res) => {
    const filePath = path.join(__dirname, 'public', req.path);
    res.sendFile(filePath);
});

// ==================== START SERVER ====================
async function startServer() {
    await initDatabase();
    await browserPool.init();
    
    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   🌐 CLOUD BROWSER - PROFESSIONAL SYSTEM v2.0                               ║
║   ================================================                          ║
║                                                                              ║
║   Status:     🟢 RUNNING                                                    ║
║   Port:       ${PORT}                                                          ║
║   Workers:    ${browserPool.maxSize}                                            ║
║                                                                              ║
║   📱 Frontend:                                                              ║
║   ├── Home:        http://localhost:${PORT}/                                 ║
║   ├── Dashboard:   http://localhost:${PORT}/dashboard.html                   ║
║   ├── Login:       http://localhost:${PORT}/login.html                       ║
║   ├── Register:    http://localhost:${PORT}/register.html                    ║
║   └── Admin:       http://localhost:${PORT}/admin.html                       ║
║                                                                              ║
║   🔑 Test Accounts:                                                         ║
║   ├── Admin:      admin@cloudbrowser.com / admin123                         ║
║   └── Register new user at /register.html                                   ║
║                                                                              ║
║   📡 API Endpoints:                                                         ║
║   ├── GET  /api/screenshot?url=...                                          ║
║   ├── GET  /api/pdf?url=...                                                 ║
║   ├── POST /api/batch                                                       ║
║   ├── GET  /api/stats                                                       ║
║   └── GET  /health                                                          ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
        `);
    });
}

startServer();
