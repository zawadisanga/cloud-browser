// server.js - PROFESSIONAL VERSION (Inafanya kazi Render/Heroku)
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
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'cloud-browser-super-secret-key-2024';
const SALT_ROUNDS = 10;

// ==================== CREATE DATABASE DIRECTORY ====================
const dbDir = './database';
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log('✅ Database directory created');
}

// ==================== DATABASE SETUP ====================
let db;

async function initDatabase() {
    try {
        db = await open({
            filename: './database/database.sqlite',
            driver: sqlite3.Database
        });
        
        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                full_name TEXT,
                plan TEXT DEFAULT 'free',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                api_key TEXT UNIQUE,
                daily_limit INTEGER DEFAULT 100,
                monthly_limit INTEGER DEFAULT 3000
            )
        `);
        
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
        
        console.log('✅ Database initialized');
        
        const adminExists = await db.get('SELECT * FROM users WHERE email = ?', ['admin@cloudbrowser.com']);
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash('admin123', SALT_ROUNDS);
            const apiKey = 'admin_' + uuidv4().replace(/-/g, '');
            await db.run(
                'INSERT INTO users (email, password, full_name, plan, api_key, daily_limit, monthly_limit) VALUES (?, ?, ?, ?, ?, ?, ?)',
                ['admin@cloudbrowser.com', hashedPassword, 'Administrator', 'enterprise', apiKey, 10000, 100000]
            );
            console.log('✅ Admin user created: admin@cloudbrowser.com / admin123');
        }
        
        return true;
    } catch (error) {
        console.error('Database error:', error);
        return false;
    }
}

// ==================== MIDDLEWARE ====================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Global rate limit exceeded' }
});
app.use('/api/', globalLimiter);

// ==================== BROWSER MANAGER ====================
let browser = null;
let isBrowserReady = false;
let browserStats = {
    requests: 0,
    cacheHits: 0,
    errors: 0,
    startTime: Date.now()
};
let screenshotCache = new Map();

async function initBrowser() {
    console.log('🚀 Starting browser...');
    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--memory-pressure-off',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        
        // Pre-warming browser
        console.log('Pre-warming browser...');
        const page = await browser.newPage();
        await page.goto('about:blank');
        await page.close();
        
        isBrowserReady = true;
        console.log('✅ Browser ready!');
        
        // Clear cache every hour
        setInterval(() => {
            screenshotCache.clear();
            console.log('🧹 Cache cleared');
        }, 3600000);
        
        // Keep-alive ping every 30 seconds
        setInterval(async () => {
            if (browser && isBrowserReady) {
                try {
                    const testPage = await browser.newPage();
                    await testPage.close();
                    console.log('💓 Browser keep-alive ping');
                } catch (e) {
                    console.log('Browser needs restart, reinitializing...');
                    isBrowserReady = false;
                    await initBrowser();
                }
            }
        }, 30000);
        
    } catch (error) {
        console.error('Browser failed:', error);
        setTimeout(initBrowser, 10000);
    }
}

async function takeScreenshot(url, options = {}) {
    browserStats.requests++;
    
    const cacheKey = `${url}:${options.format || 'png'}`;
    if (screenshotCache.has(cacheKey) && !options.skipCache) {
        browserStats.cacheHits++;
        return { data: screenshotCache.get(cacheKey), fromCache: true };
    }
    
    if (!isBrowserReady || !browser) {
        throw new Error('Browser is starting, please wait 30 seconds');
    }
    
    let page = null;
    try {
        page = await browser.newPage();
        await page.setViewportSize({ width: 1280, height: 720 });
        
        await page.goto(url, { 
            waitUntil: 'domcontentloaded', 
            timeout: 120000 
        });
        
        let result;
        if (options.format === 'pdf') {
            result = await page.pdf({ format: 'A4', printBackground: true });
        } else {
            result = await page.screenshot({ fullPage: false, type: 'png' });
        }
        
        screenshotCache.set(cacheKey, result);
        setTimeout(() => screenshotCache.delete(cacheKey), 3600000);
        
        return { data: result, fromCache: false };
    } catch (error) {
        console.error('Screenshot error:', error);
        throw error;
    } finally {
        if (page) await page.close();
    }
}

// ==================== AUTHENTICATION MIDDLEWARE ====================
async function authenticateAPIKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }
    
    try {
        const user = await db.get('SELECT * FROM users WHERE api_key = ?', [apiKey]);
        if (!user) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const todayUsage = await db.get(
            'SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ? AND date(created_at) = ?',
            [user.id, today]
        );
        
        if (todayUsage.count >= user.daily_limit) {
            return res.status(429).json({ error: 'Daily limit exceeded' });
        }
        
        req.user = user;
        req.apiKey = apiKey;
        next();
    } catch (error) {
        res.status(500).json({ error: 'Authentication error' });
    }
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

// ==================== DEMO ENDPOINT (NO API KEY NEEDED - FIXED) ====================
app.get('/api/demo', async (req, res) => {
    const { url, format = 'png' } = req.query;
    
    console.log(`📸 Demo request: ${url} (${format})`);
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
    }
    
    // Validate URL
    try {
        new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    if (!isBrowserReady) {
        return res.status(503).json({ error: 'Browser is starting, please wait 30 seconds' });
    }
    
    try {
        const result = await takeScreenshot(url, { format });
        
        console.log(`✅ Demo screenshot captured: ${url} (from cache: ${result.fromCache})`);
        
        if (format === 'pdf') {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename="document-${Date.now()}.pdf"`);
            res.send(result.data);
        } else {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
            res.send(result.data);
        }
    } catch (error) {
        console.error('Demo error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== AUTH ROUTES ====================
app.post('/api/register', async (req, res) => {
    const { email, password, full_name } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    try {
        const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }
        
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const apiKey = 'ck_' + uuidv4().replace(/-/g, '');
        
        await db.run(
            'INSERT INTO users (email, password, full_name, api_key, plan, daily_limit, monthly_limit) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [email, hashedPassword, full_name || email.split('@')[0], apiKey, 'free', 100, 3000]
        );
        
        res.json({ 
            success: true, 
            message: 'User registered successfully',
            api_key: apiKey,
            plan: 'free',
            daily_limit: 100
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
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
                daily_limit: user.daily_limit
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/user', authenticateJWT, async (req, res) => {
    try {
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
                daily_limit: req.user.daily_limit
            },
            usage: {
                today: todayUsage.count,
                total: totalUsage.count,
                remaining_today: Math.max(0, req.user.daily_limit - todayUsage.count)
            }
        });
    } catch (error) {
        console.error('User info error:', error);
        res.status(500).json({ error: 'Failed to get user info' });
    }
});

// ==================== API ENDPOINTS ====================
app.get('/health', (req, res) => {
    res.json({
        status: isBrowserReady ? 'ready' : 'starting',
        browser: browser ? 'active' : 'inactive',
        timestamp: new Date().toISOString(),
        stats: {
            requests: browserStats.requests,
            cacheHits: browserStats.cacheHits,
            cacheSize: screenshotCache.size,
            uptime: Math.floor((Date.now() - browserStats.startTime) / 1000)
        }
    });
});

app.get('/api/render', authenticateAPIKey, async (req, res) => {
    const startTime = Date.now();
    const { url, format = 'png' } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    try {
        new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    if (!isBrowserReady) {
        return res.status(503).json({ error: 'Browser is starting, please wait 30 seconds' });
    }
    
    try {
        const result = await takeScreenshot(url, { format });
        const responseTime = Date.now() - startTime;
        await logUsage(req.user.id, req.apiKey, '/render', url, format, true, responseTime);
        
        if (format === 'pdf') {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename="document-${Date.now()}.pdf"`);
        } else {
            res.setHeader('Content-Type', 'image/png');
        }
        res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.send(result.data);
    } catch (error) {
        await logUsage(req.user.id, req.apiKey, '/render', url, format, false, Date.now() - startTime);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/batch', authenticateAPIKey, async (req, res) => {
    const startTime = Date.now();
    const { urls, format = 'png' } = req.body;
    
    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: 'URLs array is required' });
    }
    
    if (urls.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 URLs per batch' });
    }
    
    const results = [];
    for (const url of urls) {
        try {
            const result = await takeScreenshot(url, { format, skipCache: false });
            results.push({ url, success: true, data: result.data.toString('base64'), fromCache: result.fromCache });
            await logUsage(req.user.id, req.apiKey, '/batch', url, format, true, 0);
        } catch (error) {
            results.push({ url, success: false, error: error.message });
            await logUsage(req.user.id, req.apiKey, '/batch', url, format, false, 0);
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

app.get('/api/stats', authenticateAPIKey, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const todayUsage = await db.get(
        'SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ? AND date(created_at) = ?',
        [req.user.id, today]
    );
    
    res.json({
        system: {
            requests: browserStats.requests,
            cacheHits: browserStats.cacheHits,
            cacheHitRate: browserStats.requests > 0 ? ((browserStats.cacheHits / browserStats.requests) * 100).toFixed(2) : 0,
            uptime: Math.floor((Date.now() - browserStats.startTime) / 1000),
            browserReady: isBrowserReady
        },
        user: {
            id: req.user.id,
            email: req.user.email,
            plan: req.user.plan,
            daily_used: todayUsage.count,
            daily_limit: req.user.daily_limit,
            remaining: Math.max(0, req.user.daily_limit - todayUsage.count),
            api_key: req.user.api_key
        }
    });
});

// ==================== FRONTEND PAGES ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
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

// ==================== ADDITIONAL ROUTES FOR BUTTONS ====================
app.get('/register', (req, res) => {
    res.redirect('/register.html');
});

app.get('/login', (req, res) => {
    res.redirect('/login.html');
});

app.get('/docs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/docs.html'));
});

app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/contact.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/about.html'));
});

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/privacy.html'));
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/terms.html'));
});

// ==================== START SERVER ====================
async function startServer() {
    console.log('🚀 Starting Cloud Browser Server...');
    
    await initDatabase();
    await initBrowser();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   🌐 CLOUD BROWSER - PROFESSIONAL SYSTEM v3.0                               ║
║   ================================================                          ║
║                                                                              ║
║   Status:     🟢 RUNNING                                                    ║
║   Port:       ${PORT}                                                          ║
║   Browser:    ${isBrowserReady ? '✅ READY' : '⏳ STARTING'}                     ║
║                                                                              ║
║   📱 URL: https://zass.website                                              ║
║                                                                              ║
║   🔑 Admin: admin@cloudbrowser.com / admin123                               ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
        `);
    });
}

startServer().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
