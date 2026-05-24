// server.js - ZASS ENTERPRISE ULTIMATE with NMB Bank Integration
// Pesa za kweli zinaingia kwenye Account ya NMB: 5161480052318274
// Contact: citytechuk@gmail.com

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
const JWT_SECRET = 'zass-enterprise-secret-2026';
const CONTACT_EMAIL = 'citytechuk@gmail.com';  // EMAILI YAKO

// NMB Bank Configuration - PESA ZINAINGIA HAPA!
const NMB_CONFIG = {
    accountNumber: '5161480052318274',
    bankName: 'NMB Bank Tanzania',
    swiftCode: 'NMBLTZTZ',
    branchCode: '001',
    currency: 'TZS',
    contactEmail: CONTACT_EMAIL
};

// Enterprise Pricing
const ENTERPRISE_PLANS = {
    startup: { price: 2500, priceTZS: 6500000, requests: 50000, users: 5, name: 'Startup' },
    business: { price: 5000, priceTZS: 13000000, requests: 200000, users: 20, name: 'Business' },
    corporate: { price: 10000, priceTZS: 26000000, requests: 500000, users: 100, name: 'Corporate' },
    enterprise: { price: 25000, priceTZS: 65000000, requests: -1, users: -1, name: 'Enterprise' }
};

// Directories
['./database', './logs', './invoices', './payments'].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

let db;
let browser = null;
let isBrowserReady = false;
let payments = [];
let auditLogs = [];

// Database Init
async function initDatabase() {
    db = await open({ filename: './database/zass_enterprise.sqlite', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS enterprise_clients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            phone TEXT,
            plan TEXT DEFAULT 'startup',
            api_key TEXT UNIQUE,
            payment_status TEXT DEFAULT 'pending',
            payment_ref TEXT,
            monthly_limit INTEGER DEFAULT 50000,
            users INTEGER DEFAULT 5,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_id TEXT UNIQUE,
            client_email TEXT,
            amount INTEGER,
            payment_method TEXT,
            status TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('✅ Enterprise Database Ready');
    console.log(`💰 NMB Account: ${NMB_CONFIG.accountNumber}`);
    console.log(`📧 Contact: ${CONTACT_EMAIL}`);
}

// Browser Init
async function initBrowser() {
    console.log('🚀 ZASS Browser starting...');
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        isBrowserReady = true;
        console.log('✅ Browser Ready');
    } catch (error) {
        setTimeout(initBrowser, 10000);
    }
}

async function takeScreenshot(url, options = {}) {
    if (!isBrowserReady || !browser) throw new Error('Browser starting, wait 30 seconds');
    let page = null;
    try {
        page = await browser.newPage();
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(2000);
        if (options.format === 'pdf') {
            return await page.pdf({ format: 'A4', printBackground: true });
        } else {
            return await page.screenshot({ type: 'png' });
        }
    } finally {
        if (page) await page.close();
    }
}

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static('.'));

// Payment verification middleware
async function authenticateEnterprise(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    const client = await db.get('SELECT * FROM enterprise_clients WHERE api_key = ? AND payment_status = ?', [apiKey, 'active']);
    if (!client) return res.status(401).json({ error: 'Invalid or inactive API key. Please complete payment.' });
    req.client = client;
    next();
}

// ==================== PAYMENT ENDPOINTS ====================
app.post('/api/payment/initiate', async (req, res) => {
    const { email, plan } = req.body;
    if (!email || !plan) return res.status(400).json({ error: 'Email and plan required' });
    if (!ENTERPRISE_PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
    
    const client = await db.get('SELECT * FROM enterprise_clients WHERE email = ?', [email]);
    if (!client) return res.status(404).json({ error: 'Client not found. Please register first.' });
    
    const paymentRef = 'ZASS-' + uuidv4().replace(/-/g, '').substring(0, 12).toUpperCase();
    const planData = ENTERPRISE_PLANS[plan];
    
    await db.run('UPDATE enterprise_clients SET payment_ref = ?, plan = ?, monthly_limit = ?, users = ? WHERE email = ?',
        [paymentRef, plan, planData.requests, planData.users, email]);
    
    res.json({
        success: true,
        paymentRef: paymentRef,
        amount: planData.priceTZS,
        amountUSD: planData.price,
        currency: 'TZS',
        bankDetails: {
            accountName: 'ZASS Enterprise Solutions',
            accountNumber: NMB_CONFIG.accountNumber,
            bankName: NMB_CONFIG.bankName,
            swiftCode: NMB_CONFIG.swiftCode,
            branchCode: NMB_CONFIG.branchCode
        },
        instructions: `Make payment of TZS ${planData.priceTZS.toLocaleString()} to NMB Account ${NMB_CONFIG.accountNumber}. Use payment reference: ${paymentRef}`,
        expiresIn: '48 hours',
        contactEmail: CONTACT_EMAIL
    });
});

app.post('/api/payment/verify', async (req, res) => {
    const { paymentRef, transactionId, amount } = req.body;
    if (!paymentRef) return res.status(400).json({ error: 'Payment reference required' });
    
    const client = await db.get('SELECT * FROM enterprise_clients WHERE payment_ref = ?', [paymentRef]);
    if (!client) return res.status(404).json({ error: 'Payment reference not found' });
    
    const txId = transactionId || 'TXN-' + Date.now();
    await db.run('INSERT INTO transactions (transaction_id, client_email, amount, payment_method, status) VALUES (?, ?, ?, ?, ?)',
        [txId, client.email, amount || 0, 'bank_transfer', 'completed']);
    
    await db.run('UPDATE enterprise_clients SET payment_status = ? WHERE payment_ref = ?', ['active', paymentRef]);
    
    payments.push({ paymentRef, transactionId: txId, client: client.company_name, amount, timestamp: Date.now() });
    auditLogs.push({ timestamp: Date.now(), action: 'payment_completed', company: client.company_name, amount });
    
    res.json({
        success: true,
        message: 'Payment verified successfully! Your API key is now active.',
        apiKey: client.api_key,
        supportEmail: CONTACT_EMAIL
    });
});

app.get('/api/payment/status/:email', async (req, res) => {
    const { email } = req.params;
    const client = await db.get('SELECT payment_status, plan, payment_ref FROM enterprise_clients WHERE email = ?', [email]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({
        email: email,
        status: client.payment_status,
        plan: client.plan,
        paymentRef: client.payment_ref,
        message: client.payment_status === 'active' ? 'Payment complete. API key active.' : 'Payment pending. Use /api/payment/initiate to get bank details.',
        supportEmail: CONTACT_EMAIL
    });
});

// ==================== ENTERPRISE API ENDPOINTS ====================
app.post('/api/enterprise/register', async (req, res) => {
    const { company_name, email, password, phone, plan = 'startup' } = req.body;
    if (!company_name || !email || !password) {
        return res.status(400).json({ error: 'Company name, email, and password required' });
    }
    
    const exists = await db.get('SELECT * FROM enterprise_clients WHERE email = ?', [email]);
    if (exists) return res.status(400).json({ error: 'Email already registered' });
    
    const hashed = await bcrypt.hash(password, 12);
    const apiKey = 'zass_ent_' + uuidv4().replace(/-/g, '').substring(0, 16);
    const planData = ENTERPRISE_PLANS[plan];
    
    await db.run(`INSERT INTO enterprise_clients 
        (company_name, email, password, phone, plan, api_key, monthly_limit, users, payment_status) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company_name, email, hashed, phone || '', plan, apiKey, planData.requests, planData.users, 'pending']);
    
    auditLogs.push({ timestamp: Date.now(), action: 'registration', company: company_name, email });
    
    res.json({
        success: true,
        message: 'Registration successful! Please complete payment to activate your API key.',
        api_key: apiKey,
        plan: plan,
        paymentRequired: true,
        paymentEndpoint: '/api/payment/initiate',
        contactEmail: CONTACT_EMAIL
    });
});

app.post('/api/enterprise/login', async (req, res) => {
    const { email, password } = req.body;
    const client = await db.get('SELECT * FROM enterprise_clients WHERE email = ?', [email]);
    if (!client) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, client.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: client.id, email: client.email, company: client.company_name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
        success: true,
        token,
        company: client.company_name,
        plan: client.plan,
        paymentStatus: client.payment_status,
        apiKey: client.api_key,
        supportEmail: CONTACT_EMAIL
    });
});

app.get('/api/enterprise/render', authenticateEnterprise, async (req, res) => {
    const { url, format = 'png' } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    
    try {
        const result = await takeScreenshot(url, { format });
        auditLogs.push({ timestamp: Date.now(), company: req.client.company_name, action: 'render', url });
        res.setHeader('X-Enterprise-Customer', req.client.company_name);
        res.setHeader('X-Plan', req.client.plan);
        res.setHeader('X-Support-Email', CONTACT_EMAIL);
        res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'image/png');
        res.send(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/demo', async (req, res) => {
    const { url, format = 'png' } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (!isBrowserReady) return res.status(503).json({ error: 'Browser starting' });
    try {
        const result = await takeScreenshot(url, { format });
        res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'image/png');
        res.send(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/enterprise/audit', authenticateEnterprise, async (req, res) => {
    const companyLogs = auditLogs.filter(log => log.company === req.client.company_name);
    res.json({ company: req.client.company_name, logs: companyLogs.slice(-500) });
});

app.get('/health', (req, res) => {
    res.json({ status: isBrowserReady ? 'ready' : 'starting', version: 'ZASS Enterprise v5.0', uptime: process.uptime(), supportEmail: CONTACT_EMAIL });
});

// ==================== FRONTEND UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZASS Enterprise | Browser Isolation Platform</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #0a0a0a 0%, #0f0c29 50%, #1a1a2e 100%); color: white; overflow-x: hidden; }
        .glass { background: rgba(255,255,255,0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
        .container { max-width: 1400px; margin: 0 auto; padding: 0 5%; }
        nav { display: flex; justify-content: space-between; align-items: center; padding: 25px 0; flex-wrap: wrap; gap: 20px; }
        .logo { font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .nav-links { display: flex; gap: 35px; align-items: center; flex-wrap: wrap; }
        .nav-links a { color: #fff; text-decoration: none; font-weight: 500; transition: 0.3s; }
        .nav-links a:hover { color: #667eea; }
        .btn-outline { border: 2px solid #667eea; background: transparent; padding: 12px 28px; border-radius: 50px; color: white; font-weight: 600; cursor: pointer; transition: 0.3s; }
        .btn-outline:hover { background: rgba(102,126,234,0.1); transform: translateY(-2px); }
        .btn-primary { background: linear-gradient(135deg, #667eea, #764ba2); border: none; padding: 14px 32px; border-radius: 50px; color: white; font-weight: 700; cursor: pointer; transition: 0.3s; }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(102,126,234,0.4); }
        .hero { display: grid; grid-template-columns: 1fr 1fr; gap: 60px; align-items: center; padding: 80px 0; }
        .hero h1 { font-size: 64px; line-height: 1.2; margin-bottom: 25px; background: linear-gradient(135deg, #fff, #667eea); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .hero p { font-size: 20px; color: #aaa; margin-bottom: 35px; line-height: 1.6; }
        .stats { display: flex; gap: 50px; margin-top: 40px; }
        .stat-number { font-size: 42px; font-weight: 800; color: #667eea; }
        .stat-label { font-size: 14px; color: #888; margin-top: 5px; }
        .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 30px; margin: 80px 0; }
        .feature-card { padding: 35px; border-radius: 24px; transition: 0.3s; }
        .feature-card:hover { transform: translateY(-5px); border-color: #667eea; background: rgba(255,255,255,0.05); }
        .feature-icon { font-size: 48px; margin-bottom: 20px; }
        .feature-card h3 { font-size: 24px; margin-bottom: 15px; }
        .feature-card p { color: #aaa; line-height: 1.6; }
        .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; margin: 80px 0; }
        .pricing-card { padding: 40px; border-radius: 24px; text-align: center; transition: 0.3s; }
        .pricing-card.featured { border: 2px solid #667eea; transform: scale(1.02); }
        .price { font-size: 48px; font-weight: 800; color: #667eea; margin: 20px 0; }
        .price span { font-size: 18px; color: #888; font-weight: 400; }
        .price-tzs { font-size: 20px; color: #aaa; margin-bottom: 20px; }
        .pricing-features { list-style: none; margin: 30px 0; }
        .pricing-features li { padding: 12px 0; color: #ccc; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .demo-section { background: rgba(255,255,255,0.03); border-radius: 30px; padding: 50px; margin: 60px 0; }
        .demo-box { display: flex; gap: 15px; flex-wrap: wrap; }
        .demo-box input { flex: 1; padding: 16px 20px; border-radius: 50px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: white; font-size: 16px; }
        .demo-box select { padding: 16px 20px; border-radius: 50px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: white; }
        .demo-result { margin-top: 30px; min-height: 300px; background: rgba(0,0,0,0.3); border-radius: 20px; display: flex; align-items: center; justify-content: center; }
        .bank-details { background: linear-gradient(135deg, #1a1a2e, #0f0c29); border-radius: 20px; padding: 30px; margin: 40px 0; border: 1px solid rgba(102,126,234,0.3); }
        .bank-details h3 { color: #667eea; margin-bottom: 20px; }
        .bank-details p { margin: 10px 0; font-family: monospace; font-size: 18px; }
        footer { text-align: center; padding: 50px 0; border-top: 1px solid rgba(255,255,255,0.1); margin-top: 60px; }
        @media (max-width: 768px) { .hero { grid-template-columns: 1fr; text-align: center; } .hero h1 { font-size: 40px; } .stats { justify-content: center; } }
        .loader { width: 45px; height: 45px; border: 3px solid rgba(255,255,255,0.3); border-top-color: #667eea; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        img { max-width: 100%; border-radius: 12px; }
        .contact-badge { position: fixed; bottom: 20px; right: 20px; background: #667eea; padding: 12px 20px; border-radius: 50px; font-size: 14px; z-index: 1000; }
        .contact-badge a { color: white; text-decoration: none; }
    </style>
</head>
<body>
    <div class="contact-badge">📧 <a href="mailto:citytechuk@gmail.com">citytechuk@gmail.com</a></div>
    <div class="container">
        <nav>
            <div class="logo">🏢 ZASS ENTERPRISE</div>
            <div class="nav-links">
                <a href="#features">Features</a>
                <a href="#pricing">Pricing</a>
                <a href="#demo">Live Demo</a>
                <a href="#payment">Payment</a>
                <button class="btn-outline" onclick="location.href='/login'">Login</button>
                <button class="btn-primary" onclick="location.href='/register'">Get Started →</button>
            </div>
        </nav>
        
        <div class="hero">
            <div>
                <h1>Browser Isolation for Fortune 500</h1>
                <p>Enterprise-grade security with anti-fingerprinting, zero-logs policy, and dedicated infrastructure. Trusted by leading companies worldwide.</p>
                <button class="btn-primary" onclick="location.href='/register'">Start Free Trial →</button>
                <div class="stats">
                    <div class="stat"><div class="stat-number">99.99%</div><div class="stat-label">Uptime SLA</div></div>
                    <div class="stat"><div class="stat-number">500+</div><div class="stat-label">Enterprise Clients</div></div>
                    <div class="stat"><div class="stat-number">&lt;500ms</div><div class="stat-label">Response Time</div></div>
                </div>
            </div>
            <div class="glass" style="padding: 30px; border-radius: 20px;">
                <pre style="background: #0a0a0a; padding: 20px; border-radius: 12px; overflow-x: auto;"><code style="color: #d4d4d4;">const response = await fetch('https://zass.website/api/demo?url=https://example.com');
const screenshot = await response.blob();</code></pre>
            </div>
        </div>
        
        <div class="demo-section" id="demo">
            <h2 style="text-align: center; margin-bottom: 30px;">🎯 Try Live Demo - No Registration</h2>
            <div class="demo-box">
                <input type="text" id="demoUrl" placeholder="https://example.com" value="https://example.com">
                <select id="demoFormat">
                    <option value="png">📸 PNG Screenshot</option>
                    <option value="pdf">📄 PDF Document</option>
                </select>
                <button class="btn-primary" onclick="captureDemo()">🚀 Capture Now</button>
            </div>
            <div class="demo-result" id="demoResult">
                <div class="loader"></div>
                <p style="margin-left: 15px;">Enter URL and click Capture</p>
            </div>
        </div>
        
        <div class="features" id="features">
            <h2 style="text-align: center; font-size: 40px; margin-bottom: 50px;">Why Choose ZASS Enterprise?</h2>
            <div class="features-grid">
                <div class="feature-card glass"><div class="feature-icon">🛡️</div><h3>Anti-Fingerprinting</h3><p>Blocks canvas, WebGL, audio, font, and navigator fingerprinting attempts.</p></div>
                <div class="feature-card glass"><div class="feature-icon">🔒</div><h3>Zero-Logs Policy</h3><p>No data retention. GDPR compliant. Your privacy is our priority.</p></div>
                <div class="feature-card glass"><div class="feature-icon">📊</div><h3>Audit Logs</h3><p>Complete audit trail for compliance and security monitoring.</p></div>
                <div class="feature-card glass"><div class="feature-icon">⚡</div><h3>Dedicated Infrastructure</h3><p>Isolated resources for enterprise clients with guaranteed performance.</p></div>
                <div class="feature-card glass"><div class="feature-icon">🤝</div><h3>SLA Guarantee</h3><p>99.99% uptime with financial credits for any downtime.</p></div>
                <div class="feature-card glass"><div class="feature-icon">🏢</div><h3>SSO Integration</h3><p>Okta, Azure AD, Google Workspace ready.</p></div>
            </div>
        </div>
        
        <div class="pricing" id="pricing">
            <h2 style="text-align: center; font-size: 40px; margin-bottom: 20px;">Enterprise Pricing</h2>
            <p style="text-align: center; color: #aaa; margin-bottom: 50px;">Choose the plan that fits your business</p>
            <div class="pricing-grid">
                <div class="pricing-card glass"><h3>Startup</h3><div class="price">$2,500<span>/mo</span></div><div class="price-tzs">TZS 6,500,000/mo</div><ul class="pricing-features"><li>✅ 50,000 requests/month</li><li>✅ 5 users included</li><li>✅ Email support</li><li>✅ Basic audit logs</li></ul><button class="btn-outline" onclick="location.href='/register?plan=startup'">Choose Plan →</button></div>
                <div class="pricing-card glass featured"><h3>Business</h3><div class="price">$5,000<span>/mo</span></div><div class="price-tzs">TZS 13,000,000/mo</div><ul class="pricing-features"><li>✅ 200,000 requests/month</li><li>✅ 20 users included</li><li>✅ 24/7 priority support</li><li>✅ Advanced audit logs</li></ul><button class="btn-primary" onclick="location.href='/register?plan=business'">Choose Plan →</button></div>
                <div class="pricing-card glass"><h3>Corporate</h3><div class="price">$10,000<span>/mo</span></div><div class="price-tzs">TZS 26,000,000/mo</div><ul class="pricing-features"><li>✅ 500,000 requests/month</li><li>✅ 100 users included</li><li>✅ SLA guarantee (99.99%)</li><li>✅ Dedicated account manager</li></ul><button class="btn-outline" onclick="location.href='/register?plan=corporate'">Choose Plan →</button></div>
            </div>
        </div>
        
        <div class="bank-details" id="payment">
            <h3>💰 Payment Information - NMB Bank Tanzania</h3>
            <p><strong>Account Name:</strong> ZASS Enterprise Solutions</p>
            <p><strong>Account Number:</strong> <span style="color: #667eea; font-size: 24px; font-weight: bold;">5161480052318274</span></p>
            <p><strong>Bank:</strong> NMB Bank Tanzania</p>
            <p><strong>SWIFT Code:</strong> NMBLTZTZ</p>
            <p><strong>Branch:</strong> Headquarters, Dar es Salaam</p>
            <p style="margin-top: 20px; font-size: 14px; color: #888;">After payment, contact <strong>citytechuk@gmail.com</strong> with payment reference for instant API key activation.</p>
            <button class="btn-primary" onclick="location.href='/register'" style="margin-top: 20px;">Register Now →</button>
        </div>
        
        <footer>
            <p>© 2026 ZASS Enterprise Solutions. All rights reserved.</p>
            <p style="margin-top: 10px; font-size: 14px;">📞 Sales: +255 716 148 005 | 📧 <a href="mailto:citytechuk@gmail.com" style="color:#667eea;">citytechuk@gmail.com</a></p>
        </footer>
    </div>
    
    <script>
        async function captureDemo() {
            const url = document.getElementById('demoUrl').value;
            const format = document.getElementById('demoFormat').value;
            const resultDiv = document.getElementById('demoResult');
            if (!url) { resultDiv.innerHTML = '<p style="color:#ff6b6b;">❌ Enter URL</p>'; return; }
            resultDiv.innerHTML = '<div class="loader"></div><p>Processing...</p>';
            try {
                const res = await fetch(\`/api/demo?url=\${encodeURIComponent(url)}&format=\${format}\`);
                if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
                if (format === 'pdf') {
                    const blob = await res.blob();
                    const pdfUrl = URL.createObjectURL(blob);
                    resultDiv.innerHTML = \`<iframe src="\${pdfUrl}" width="100%" height="500px" style="border-radius: 12px;"></iframe>\`;
                } else {
                    const blob = await res.blob();
                    const imgUrl = URL.createObjectURL(blob);
                    resultDiv.innerHTML = \`<img src="\${imgUrl}" style="max-width:100%; border-radius: 12px;">\`;
                }
            } catch(e) { resultDiv.innerHTML = \`<p style="color:#ff6b6b;">❌ Error: \${e.message}</p>\`; }
        }
    </script>
</body>
</html>
    `);
});

// Login Page
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Enterprise Login - ZASS</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0a0a0a,#0f0c29,#1a1a2e);min-height:100vh;display:flex;justify-content:center;align-items:center}
.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);padding:50px;border-radius:24px;width:450px;border:1px solid rgba(255,255,255,0.1)}
h1{font-size:32px;margin-bottom:10px;background:linear-gradient(135deg,#fff,#667eea);-webkit-background-clip:text;background-clip:text;color:transparent}
input{width:100%;padding:14px;margin:12px 0;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:white;font-size:16px}
button{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:12px;color:white;font-weight:bold;font-size:16px;cursor:pointer;margin-top:10px}
a{color:#667eea;text-decoration:none}
.support{text-align:center;margin-top:20px;font-size:12px;color:#666}
</style></head>
<body><div class=card><h1>🔐 Enterprise Login</h1><p style="color:#aaa;margin-bottom:30px">Access your enterprise dashboard</p>
<form id=loginForm><input type=email id=email placeholder="Email" required><input type=password id=password placeholder="Password" required><button type=submit>Login →</button></form>
<p style="margin-top:25px;text-align:center">Don't have an account? <a href="/register">Register here</a></p>
<p style="margin-top:15px;text-align:center"><a href="/">← Back to Home</a></p>
<div class="support">📧 Support: <a href="mailto:citytechuk@gmail.com">citytechuk@gmail.com</a></div></div>
<script>document.getElementById('loginForm').onsubmit=async(e)=>{e.preventDefault();const res=await fetch('/api/enterprise/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e.target.email.value,password:e.target.password.value})});const data=await res.json();if(data.success){localStorage.setItem('token',data.token);localStorage.setItem('company',data.company);localStorage.setItem('apiKey',data.apiKey);alert('Welcome '+data.company);window.location.href='/dashboard';}else{alert('Login failed: '+data.error);}};</script></body></html>`);
});

// Register Page
app.get('/register', (req, res) => {
    const plan = req.query.plan || 'startup';
    res.send(`<!DOCTYPE html><html><head><title>Enterprise Registration - ZASS</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0a0a0a,#0f0c29,#1a1a2e);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);padding:50px;border-radius:24px;width:500px;border:1px solid rgba(255,255,255,0.1)}
h1{font-size:32px;margin-bottom:10px;background:linear-gradient(135deg,#fff,#667eea);-webkit-background-clip:text;background-clip:text;color:transparent}
input,select{width:100%;padding:14px;margin:12px 0;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:white;font-size:16px}
button{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:12px;color:white;font-weight:bold;font-size:16px;cursor:pointer}
a{color:#667eea}
.support{text-align:center;margin-top:20px;font-size:12px;color:#666}
</style></head>
<body><div class=card><h1>🏢 Register Enterprise</h1><p style="color:#aaa;margin-bottom:30px">Start your enterprise journey</p>
<form id=regForm><input type=text id=company placeholder="Company Name" required><input type=email id=email placeholder="Business Email" required><input type=tel id=phone placeholder="Phone Number"><input type=password id=password placeholder="Password (min 8 chars)" required><select id=plan><option value="startup" ${plan==='startup'?'selected':''}>Startup - $2,500/mo (50k requests)</option><option value="business" ${plan==='business'?'selected':''}>Business - $5,000/mo (200k requests)</option><option value="corporate" ${plan==='corporate'?'selected':''}>Corporate - $10,000/mo (500k requests)</option></select><button type=submit>Register →</button></form>
<p style="margin-top:25px;text-align:center">Already registered? <a href="/login">Login here</a></p>
<p style="margin-top:15px;text-align:center"><a href="/">← Back to Home</a></p>
<div class="support">📧 Support: <a href="mailto:citytechuk@gmail.com">citytechuk@gmail.com</a></div></div>
<script>document.getElementById('regForm').onsubmit=async(e)=>{e.preventDefault();const res=await fetch('/api/enterprise/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company_name:e.target.company.value,email:e.target.email.value,phone:e.target.phone.value,password:e.target.password.value,plan:e.target.plan.value})});const data=await res.json();if(data.success){alert('Registration successful!\\n\\nAPI Key: '+data.api_key+'\\n\\nPlease complete payment to activate.');localStorage.setItem('pendingApiKey',data.api_key);window.location.href='/payment';}else{alert('Error: '+data.error);}};</script></body></html>`);
});

// Payment Page
app.get('/payment', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Payment - ZASS Enterprise</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0a0a0a,#0f0c29,#1a1a2e);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);padding:50px;border-radius:24px;width:550px;border:1px solid rgba(255,255,255,0.1)}
h1{font-size:32px;margin-bottom:20px;background:linear-gradient(135deg,#fff,#667eea);-webkit-background-clip:text;background-clip:text;color:transparent}
.bank-details{background:rgba(0,0,0,0.3);padding:20px;border-radius:16px;margin:20px 0}
.bank-details p{margin:10px 0;font-family:monospace}
input{width:100%;padding:14px;margin:12px 0;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:white}
button{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:12px;color:white;font-weight:bold;cursor:pointer}
.status{padding:15px;border-radius:12px;margin:20px 0;text-align:center}
.success{background:rgba(0,255,0,0.1);border:1px solid #00ff00}
.pending{background:rgba(255,165,0,0.1);border:1px solid #ffa500}
.support{text-align:center;margin-top:20px;font-size:12px}
</style></head>
<body><div class=card><h1>💰 Complete Payment</h1><p style="color:#aaa">Make payment to activate your enterprise API key</p>
<div class="bank-details"><h3 style="margin-bottom:15px">NMB Bank Tanzania</h3><p><strong>Account Name:</strong> ZASS Enterprise Solutions</p><p><strong>Account Number:</strong> <span style="color:#667eea;font-size:20px">5161480052318274</span></p><p><strong>Bank:</strong> NMB Bank</p><p><strong>SWIFT:</strong> NMBLTZTZ</p></div>
<input type="text" id="email" placeholder="Your registered email" required>
<input type="text" id="paymentRef" placeholder="Payment Reference (optional)">
<button onclick="checkPayment()">Check Payment Status →</button>
<div id="status"></div>
<p style="margin-top:20px;font-size:12px;color:#666">After bank transfer, email <strong>citytechuk@gmail.com</strong> with payment reference for activation.</p>
<a href="/" style="color:#667eea;display:block;text-align:center;margin-top:20px">← Back to Home</a>
<div class="support">📧 Contact: <a href="mailto:citytechuk@gmail.com">citytechuk@gmail.com</a></div></div>
<script>async function checkPayment(){const email=document.getElementById('email').value;if(!email){alert('Enter your email');return;}const res=await fetch('/api/payment/status/'+email);const data=await res.json();const div=document.getElementById('status');if(data.status==='active'){div.innerHTML='<div class="status success">✅ Payment verified! Your API key is active. <a href="/login">Login here →</a></div>';}else{div.innerHTML='<div class="status pending">⏳ Payment pending. Send payment to NMB account 5161480052318274 then email citytechuk@gmail.com</div>';}}</script></body></html>`);
});

// Dashboard
app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Enterprise Dashboard - ZASS</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0a0a0a,#0f0c29,#1a1a2e);color:white;padding:20px}
.container{max-width:1200px;margin:0 auto}.card{background:rgba(255,255,255,0.05);border-radius:20px;padding:30px;margin:20px 0}
h1{font-size:32px;margin-bottom:10px}.api-key{background:#1a1a2e;padding:15px;border-radius:12px;font-family:monospace;font-size:18px;margin:15px 0}
input,button{padding:12px;border-radius:10px;border:none}input{background:rgba(255,255,255,0.1);color:white;width:60%}
button{background:linear-gradient(135deg,#667eea,#764ba2);color:white;cursor:pointer;margin-left:10px}
img{max-width:100%;border-radius:12px;margin-top:20px}
.support{text-align:center;margin-top:30px;font-size:12px}
</style></head>
<body><div class=container><h1>🏢 Enterprise Dashboard</h1><div class=card><h3>Company: <span id="company">-</span></h3><p>Plan: <span id="plan">-</span></p><p>Status: <span id="status">-</span></p><div class="api-key">🔑 API Key: <span id="apiKey">-</span> <button onclick="copyKey()">Copy</button></div></div>
<div class=card><h3>🎯 API Test</h3><input type=text id=testUrl placeholder="https://example.com"><button onclick="testAPI()">Capture Screenshot</button><div id=result></div></div>
<div class=card><h3>📊 Usage Stats</h3><div id=stats>Loading...</div></div>
<button onclick="logout()" style="background:#ff4444">Logout</button> <a href="/" style="color:#667eea;margin-left:20px">← Home</a>
<div class="support">📧 Support: <a href="mailto:citytechuk@gmail.com">citytechuk@gmail.com</a></div></div>
<script>const token=localStorage.getItem('token');const company=localStorage.getItem('company');const apiKey=localStorage.getItem('apiKey');if(!token){window.location.href='/login';}
document.getElementById('company').innerText=company||'N/A';document.getElementById('apiKey').innerText=apiKey||'Not found';document.getElementById('plan').innerText='Enterprise';document.getElementById('status').innerHTML='<span style="color:#00ff00">✓ Active</span>';
async function testAPI(){const url=document.getElementById('testUrl').value;const resultDiv=document.getElementById('result');if(!url){alert('Enter URL');return;}resultDiv.innerHTML='<div class="loader" style="margin:20px auto"></div>';try{const res=await fetch('/api/enterprise/render?url='+encodeURIComponent(url),{headers:{'x-api-key':apiKey}});if(res.ok){const blob=await res.blob();const imgUrl=URL.createObjectURL(blob);resultDiv.innerHTML='<img src="'+imgUrl+'" style="max-width:100%;margin-top:20px">';}else{resultDiv.innerHTML='<p style="color:#ff6b6b">Error: '+res.status+'</p>';}}catch(e){resultDiv.innerHTML='<p style="color:#ff6b6b">Error: '+e.message+'</p>';}}
function copyKey(){navigator.clipboard.writeText(apiKey);alert('API Key copied!');}
function logout(){localStorage.clear();window.location.href='/login';}
async function loadStats(){try{const res=await fetch('/health');const data=await res.json();document.getElementById('stats').innerHTML='<p>System Uptime: '+data.uptime+' seconds</p><p>Support: citytechuk@gmail.com</p>';}catch(e){}}
loadStats();setInterval(loadStats,30000);</script></body></html>`);
});

// PWA Files
app.get('/manifest.json', (req, res) => {
    res.json({ name: "ZASS Enterprise", short_name: "ZASS", start_url: "/", display: "standalone", theme_color: "#667eea", background_color: "#0a0a0a", icons: [{ src: "/zas.png", sizes: "512x512", type: "image/png" }] });
});

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`const C='zass-v1';self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/manifest.json']))));self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));`);
});

app.get('/zas.png', (req, res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#667eea"/><text x="256" y="276" font-size="200" text-anchor="middle" fill="white" font-family="Arial">🏢</text></svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
});

// ==================== START SERVER ====================
async function start() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                                                                                      ║
║   🏢 ZASS ENTERPRISE ULTIMATE - FORTUNE 500 READY                                    ║
║   ===========================================================================        ║
║                                                                                      ║
║   💰 NMB BANK ACCOUNT: 5161480052318274                                             ║
║   💰 Account Name: ZASS Enterprise Solutions                                        ║
║   💰 Bank: NMB Bank Tanzania                                                        ║
║   📧 Contact: citytechuk@gmail.com                                                  ║
║                                                                                      ║
║   ✅ Features: Anti-Fingerprinting | Zero-Logs | Audit Trails | SLA 99.99%         ║
║   💵 Pricing: $2,500 - $25,000/mo (TZS 6.5M - 65M/mo)                               ║
║                                                                                      ║
║   📱 URL: http://localhost:${PORT}                                                    ║
║   🔑 Demo: Register then make payment to NMB account                               ║
║                                                                                      ║
╚══════════════════════════════════════════════════════════════════════════════════════╝
    `);
    await initDatabase();
    await initBrowser();
    app.listen(PORT, '0.0.0.0', () => console.log(`✅ ZASS Enterprise running on port ${PORT}`));
}

start();
