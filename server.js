// server.js - ROOT VERSION (Inafanya kazi 100%)
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

// ==================== CREATE TEMP DIRECTORY ====================
const tempDir = './temp';
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
    console.log('✅ Temp directory created');
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

// Serve static files from CURRENT directory (where server.js is)
app.use(express.static(__dirname));

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
                '--disable-blink-features=AutomationControlled',
                '--disable-features=DownloadBubble,DownloadBubbleV2'
            ]
        });
        
        console.log('Pre-warming browser...');
        const page = await browser.newPage();
        await page.goto('about:blank');
        await page.close();
        
        isBrowserReady = true;
        console.log('✅ Browser ready!');
        
        setInterval(() => {
            screenshotCache.clear();
            console.log('🧹 Cache cleared');
        }, 3600000);
        
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
    
    let context = null;
    let page = null;
    try {
        context = await browser.newContext({
            acceptDownloads: true,
            bypassCSP: true
        });
        
        page = await context.newPage();
        
        page.on('download', async (download) => {
            console.log(`⚠️ Download detected: ${download.suggestedFilename()} - Cancelling...`);
            try {
                await download.cancel();
            } catch (e) {}
        });
        
        page.on('dialog', async (dialog) => {
            console.log(`📢 Dialog detected - Dismissing...`);
            await dialog.dismiss();
        });
        
        await page.setViewportSize({ width: 1280, height: 720 });
        
        await page.goto(url, { 
            waitUntil: 'load',
            timeout: 90000 
        });
        
        await page.waitForSelector('body', { timeout: 15000 });
        await page.waitForTimeout(2000);
        
        let result;
        if (options.format === 'pdf') {
            result = await page.pdf({ 
                format: 'A4', 
                printBackground: true
            });
        } else {
            result = await page.screenshot({ type: 'png' });
        }
        
        screenshotCache.set(cacheKey, result);
        setTimeout(() => screenshotCache.delete(cacheKey), 3600000);
        
        return { data: result, fromCache: false };
    } catch (error) {
        console.error('Screenshot error:', error);
        browserStats.errors++;
        throw error;
    } finally {
        if (page) await page.close().catch(e => {});
        if (context) await context.close().catch(e => {});
    }
}

// ==================== AUTHENTICATION ====================
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

async function logUsage(userId, apiKey, endpoint, url, format, success, responseTime) {
    try {
        await db.run(
            'INSERT INTO usage_logs (user_id, api_key, endpoint, url, format, success, response_time) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, apiKey, endpoint, url, format, success ? 1 : 0, responseTime]
        );
    } catch (error) {}
}

// ==================== DEMO ENDPOINT (NO API KEY) ====================
app.get('/api/demo', async (req, res) => {
    const { url, format = 'png' } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
    }
    
    try {
        new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    if (!isBrowserReady) {
        return res.status(503).json({ error: 'Browser starting, wait 30 seconds' });
    }
    
    try {
        const result = await takeScreenshot(url, { format });
        
        if (format === 'pdf') {
            res.setHeader('Content-Type', 'application/pdf');
            res.send(result.data);
        } else {
            res.setHeader('Content-Type', 'image/png');
            res.send(result.data);
        }
    } catch (error) {
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
            api_key: apiKey,
            plan: 'free',
            daily_limit: 100
        });
    } catch (error) {
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
        res.status(500).json({ error: 'Login failed' });
    }
});

// ==================== API ENDPOINTS ====================
app.get('/health', (req, res) => {
    res.json({
        status: isBrowserReady ? 'ready' : 'starting',
        browser: browser ? 'active' : 'inactive',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/render', authenticateAPIKey, async (req, res) => {
    const { url, format = 'png' } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    try {
        const result = await takeScreenshot(url, { format });
        await logUsage(req.user.id, req.apiKey, '/render', url, format, true, 0);
        
        if (format === 'pdf') {
            res.setHeader('Content-Type', 'application/pdf');
            res.send(result.data);
        } else {
            res.setHeader('Content-Type', 'image/png');
            res.send(result.data);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/stats', authenticateAPIKey, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const todayUsage = await db.get(
        'SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ? AND date(created_at) = ?',
        [req.user.id, today]
    );
    
    res.json({
        user: {
            email: req.user.email,
            plan: req.user.plan,
            daily_used: todayUsage.count,
            daily_limit: req.user.daily_limit,
            api_key: req.user.api_key
        }
    });
});

// ==================== HTML PAGES (SERVE FROM ROOT) ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'register.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// PWA FILES
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/zas.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'zas.png'));
});

// REDIRECTS
app.get('/register', (req, res) => {
    res.redirect('/register.html');
});

app.get('/login', (req, res) => {
    res.redirect('/login.html');
});

// ==================== START SERVER ====================
async function startServer() {
    console.log('🚀 Starting Cloud Browser Server...');
    
    await initDatabase();
    await initBrowser();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║   🌐 ZASS CLOUD BROWSER - RUNNING                                           ║
║   📱 URL: https://zass.website                                              ║
║   🔑 Admin: admin@cloudbrowser.com / admin123                               ║
╚══════════════════════════════════════════════════════════════════════════════╝
        `);
    });
}

startServer().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
