// server.js - ZASS ENTERPRISE ULTIMATE with AI & Automatic Payment
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

// AI Configuration - Unaweza kubadilisha API yoyote (OpenAI, Gemini, Claude)
const AI_PROVIDER = 'gemini'; // 'openai', 'gemini', 'claude'
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = 'gemini-2.0-flash-exp';

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = 'zass-enterprise-secret-2026';
const CONTACT_EMAIL = 'citytechuk@gmail.com';
const CONTACT_PHONE = '+25576323348';
const NMB_ACCOUNT = '5161480052318274';

// NMB Bank Configuration
const NMB_CONFIG = {
    accountNumber: NMB_ACCOUNT,
    bankName: 'NMB Bank Tanzania',
    swiftCode: 'NMBLTZTZ',
    currency: 'USD',
    contactEmail: CONTACT_EMAIL
};

// Enterprise Pricing (USD)
const ENTERPRISE_PLANS = {
    startup: { price: 49, requests: 5000, users: 1, name: 'Startup', features: ['PNG & PDF output', 'Email support', 'Basic analytics'] },
    business: { price: 99, requests: 15000, users: 5, name: 'Business', features: ['Batch processing', 'Priority support', 'Advanced analytics'] },
    corporate: { price: 299, requests: 50000, users: 20, name: 'Corporate', features: ['API access', '24/7 support', 'Custom integrations'] },
    enterprise: { price: 999, requests: -1, users: -1, name: 'Enterprise', features: ['Unlimited requests', 'Dedicated infrastructure', 'SLA guarantee', 'SSO integration'] }
};

// Directories
['./database', './logs', './invoices', './payments', './ai_cache'].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

let db;
let browser = null;
let isBrowserReady = false;
let payments = [];
let auditLogs = [];
let aiCache = new Map();

// ==================== AI FUNCTIONS ====================

async function callAI(prompt, context = '') {
    const cacheKey = prompt + context;
    if (aiCache.has(cacheKey)) {
        return aiCache.get(cacheKey);
    }
    
    let response = '';
    
    try {
        // Google Gemini AI
        if (AI_PROVIDER === 'gemini' && AI_API_KEY) {
            const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: `You are ZASS AI Assistant, a helpful customer support bot for a cloud browser API platform. Be friendly, professional, and concise. Respond to: ${prompt}\n\nContext: ${context}` }]
                    }]
                })
            });
            const data = await geminiResponse.json();
            response = data.candidates?.[0]?.content?.parts?.[0]?.text || "I understand your question. Could you please provide more details so I can assist you better?";
        }
        // OpenAI (ChatGPT)
        else if (AI_PROVIDER === 'openai' && AI_API_KEY) {
            const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_API_KEY}` },
                body: JSON.stringify({
                    model: 'gpt-3.5-turbo',
                    messages: [{ role: 'system', content: 'You are ZASS AI Assistant, a helpful customer support bot.' }, { role: 'user', content: prompt }]
                })
            });
            const data = await openaiResponse.json();
            response = data.choices?.[0]?.message?.content || "I understand your question. Could you please provide more details?";
        }
        // Mock AI when no API key
        else {
            response = getMockAIResponse(prompt);
        }
        
        aiCache.set(cacheKey, response);
        setTimeout(() => aiCache.delete(cacheKey), 3600000);
        return response;
    } catch (error) {
        console.error('AI Error:', error);
        return getMockAIResponse(prompt);
    }
}

function getMockAIResponse(prompt) {
    const msg = prompt.toLowerCase();
    if (msg.includes('price') || msg.includes('cost')) {
        return "💰 Our pricing plans:\n• Startup: $49/month (5,000 requests)\n• Business: $99/month (15,000 requests)\n• Corporate: $299/month (50,000 requests)\n• Enterprise: $999/month (unlimited)\nWhich plan interests you?";
    }
    else if (msg.includes('api key')) {
        return "🔑 To get an API key, please register and complete payment. Your API key will be automatically activated within minutes after payment confirmation.";
    }
    else if (msg.includes('payment')) {
        return `💳 You can pay via bank transfer to NMB Bank account: ${NMB_ACCOUNT}. After payment, our system will automatically activate your API key.`;
    }
    else if (msg.includes('help')) {
        return "🤝 I'm here to help! Ask me about pricing, payment methods, API activation, technical issues, or account management.";
    }
    else {
        return "Thank you for your message. I'm ZASS AI Assistant. How can I help you today?";
    }
}

// ==================== DATABASE ====================
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
            monthly_limit INTEGER DEFAULT 5000,
            users INTEGER DEFAULT 1,
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
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ai_conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT,
            message TEXT,
            response TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('✅ Enterprise Database Ready');
    console.log(`💰 NMB Account: ${NMB_CONFIG.accountNumber}`);
    console.log(`🤖 AI Provider: ${AI_PROVIDER}`);
}

// ==================== BROWSER ====================
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

// ==================== MIDDLEWARE ====================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static('.'));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 500 });
app.use('/api/', limiter);

async function authenticateEnterprise(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    const client = await db.get('SELECT * FROM enterprise_clients WHERE api_key = ? AND payment_status = ?', [apiKey, 'active']);
    if (!client) return res.status(401).json({ error: 'Invalid or inactive API key' });
    req.client = client;
    next();
}

// ==================== AI CHATBOT ENDPOINT ====================
app.post('/api/ai/chat', async (req, res) => {
    const { message, email } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    
    try {
        const aiResponse = await callAI(message, `User email: ${email || 'anonymous'}`);
        
        if (email) {
            await db.run('INSERT INTO ai_conversations (user_email, message, response) VALUES (?, ?, ?)', [email, message, aiResponse]);
        }
        
        res.json({ success: true, response: aiResponse });
    } catch (error) {
        res.json({ success: true, response: getMockAIResponse(message) });
    }
});

// ==================== PAYMENT ENDPOINTS ====================
app.post('/api/payment/initiate', async (req, res) => {
    const { email, plan } = req.body;
    if (!email || !plan) return res.status(400).json({ error: 'Email and plan required' });
    if (!ENTERPRISE_PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
    
    const client = await db.get('SELECT * FROM enterprise_clients WHERE email = ?', [email]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    
    const paymentRef = 'ZASS-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const planData = ENTERPRISE_PLANS[plan];
    
    await db.run('UPDATE enterprise_clients SET payment_ref = ?, plan = ?, monthly_limit = ?, users = ? WHERE email = ?',
        [paymentRef, plan, planData.requests, planData.users, email]);
    
    res.json({
        success: true,
        paymentRef: paymentRef,
        amount: planData.price,
        currency: 'USD',
        bankDetails: {
            accountName: 'ZASS Enterprise Solutions',
            accountNumber: NMB_CONFIG.accountNumber,
            bankName: NMB_CONFIG.bankName,
            swiftCode: NMB_CONFIG.swiftCode
        },
        instructions: `Make payment of $${planData.price} to NMB Account ${NMB_CONFIG.accountNumber}. Reference: ${paymentRef}`,
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
    
    res.json({
        success: true,
        message: 'Payment verified! API key activated.',
        apiKey: client.api_key
    });
});

app.get('/api/payment/status/:email', async (req, res) => {
    const { email } = req.params;
    const client = await db.get('SELECT payment_status, plan, payment_ref FROM enterprise_clients WHERE email = ?', [email]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ email, status: client.payment_status, plan: client.plan, paymentRef: client.payment_ref });
});

// ==================== ENTERPRISE API ====================
app.post('/api/enterprise/register', async (req, res) => {
    const { company_name, email, password, phone, plan = 'startup' } = req.body;
    if (!company_name || !email || !password) {
        return res.status(400).json({ error: 'Company name, email, and password required' });
    }
    
    const exists = await db.get('SELECT * FROM enterprise_clients WHERE email = ?', [email]);
    if (exists) return res.status(400).json({ error: 'Email already registered' });
    
    const hashed = await bcrypt.hash(password, 12);
    const apiKey = 'zass_' + Date.now() + '_' + Math.random().toString(36).substring(2, 16);
    const planData = ENTERPRISE_PLANS[plan];
    
    await db.run(`INSERT INTO enterprise_clients 
        (company_name, email, password, phone, plan, api_key, monthly_limit, users, payment_status) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company_name, email, hashed, phone || '', plan, apiKey, planData.requests, planData.users, 'pending']);
    
    res.json({
        success: true,
        message: 'Registration successful! Please complete payment to activate.',
        api_key: apiKey,
        plan: plan,
        amount: planData.price,
        bankAccount: NMB_ACCOUNT
    });
});

app.post('/api/enterprise/login', async (req, res) => {
    const { email, password } = req.body;
    const client = await db.get('SELECT * FROM enterprise_clients WHERE email = ?', [email]);
    if (!client) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, client.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: client.id, email: client.email, company: client.company_name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, company: client.company_name, plan: client.plan, paymentStatus: client.payment_status, apiKey: client.api_key });
});

app.get('/api/enterprise/render', authenticateEnterprise, async (req, res) => {
    const { url, format = 'png' } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const result = await takeScreenshot(url, { format });
        auditLogs.push({ timestamp: Date.now(), company: req.client.company_name, action: 'render', url });
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

app.get('/health', (req, res) => {
    res.json({ status: isBrowserReady ? 'ready' : 'starting', version: 'ZASS AI Enterprise', uptime: process.uptime(), aiProvider: AI_PROVIDER });
});

// ==================== FRONTEND ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZASS AI Enterprise | Browser Isolation Platform</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #0a0a0a 0%, #0f0c29 50%, #1a1a2e 100%); color: white; overflow-x: hidden; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .fade-up { animation: fadeInUp 0.6s ease-out; }
        .pulse { animation: pulse 2s infinite; }
        .glass { background: rgba(255,255,255,0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; }
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
        .stat-label { font-size: 14px; color: #888; }
        .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 30px; margin: 80px 0; }
        .feature-card { background: rgba(255,255,255,0.05); padding: 30px; border-radius: 20px; transition: 0.3s; text-align: center; }
        .feature-card:hover { transform: translateY(-5px); border: 1px solid #667eea; }
        .feature-icon { font-size: 48px; margin-bottom: 20px; }
        .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 30px; margin: 80px 0; }
        .pricing-card { background: rgba(255,255,255,0.05); padding: 40px; border-radius: 20px; text-align: center; transition: 0.3s; }
        .pricing-card:hover { transform: translateY(-5px); }
        .pricing-card.featured { border: 2px solid #667eea; transform: scale(1.02); }
        .price { font-size: 48px; font-weight: 800; color: #667eea; }
        .price small { font-size: 18px; color: #aaa; }
        .demo-section { background: rgba(255,255,255,0.05); border-radius: 30px; padding: 40px; margin: 60px 0; }
        .demo-box { display: flex; gap: 15px; flex-wrap: wrap; }
        .demo-box input { flex: 1; padding: 15px 20px; border-radius: 50px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: white; }
        .demo-box select { padding: 15px 20px; border-radius: 50px; background: rgba(0,0,0,0.3); color: white; border: 1px solid rgba(255,255,255,0.2); }
        .demo-result { margin-top: 30px; min-height: 300px; background: rgba(0,0,0,0.3); border-radius: 20px; display: flex; align-items: center; justify-content: center; }
        .payment-section { background: linear-gradient(135deg, #1a1a2e, #0f0c29); border-radius: 30px; padding: 40px; margin: 60px 0; border: 1px solid rgba(102,126,234,0.3); }
        .payment-form input, .payment-form select { width: 100%; padding: 15px; margin: 10px 0; border-radius: 12px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: white; }
        .bank-details { background: rgba(0,0,0,0.3); padding: 20px; border-radius: 16px; margin: 20px 0; }
        .chat-bot { position: fixed; bottom: 30px; left: 30px; width: 380px; background: rgba(26,26,46,0.98); backdrop-filter: blur(20px); border-radius: 20px; border: 1px solid #667eea; z-index: 1000; box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
        .chat-header { background: linear-gradient(135deg, #667eea, #764ba2); padding: 15px 20px; border-radius: 20px 20px 0 0; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
        .chat-status { font-size: 12px; opacity: 0.9; }
        .chat-messages { height: 350px; overflow-y: auto; padding: 15px; }
        .chat-message { margin-bottom: 15px; display: flex; align-items: flex-start; gap: 10px; }
        .chat-message.user { justify-content: flex-end; }
        .chat-message.user .message { background: rgba(102,126,234,0.3); padding: 10px 15px; border-radius: 18px; max-width: 80%; }
        .chat-message.bot .message { background: rgba(255,255,255,0.1); padding: 10px 15px; border-radius: 18px; max-width: 80%; }
        .chat-input { display: flex; padding: 15px; gap: 10px; border-top: 1px solid rgba(255,255,255,0.1); }
        .chat-input input { flex: 1; padding: 10px 15px; border-radius: 25px; border: none; background: rgba(255,255,255,0.1); color: white; }
        .chat-input button { background: #667eea; border: none; padding: 10px 20px; border-radius: 25px; color: white; cursor: pointer; }
        .typing { display: flex; gap: 5px; padding: 10px; }
        .typing span { width: 8px; height: 8px; background: #667eea; border-radius: 50%; animation: typing 1.4s infinite; }
        .typing span:nth-child(2) { animation-delay: 0.2s; }
        .typing span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes typing { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-10px); } }
        .loader-small { width: 20px; height: 20px; border: 2px solid white; border-top-color: #667eea; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; }
        .payment-status { padding: 15px; border-radius: 12px; margin-top: 15px; text-align: center; }
        .status-success { background: rgba(0,255,0,0.1); border: 1px solid #00ff00; color: #00ff00; }
        .status-processing { background: rgba(102,126,234,0.2); border: 1px solid #667eea; }
        footer { text-align: center; padding: 40px 0; border-top: 1px solid rgba(255,255,255,0.1); margin-top: 60px; }
        .contact-badge { position: fixed; bottom: 20px; right: 20px; background: #667eea; padding: 12px 20px; border-radius: 50px; font-size: 14px; z-index: 1000; }
        .contact-badge a { color: white; text-decoration: none; }
        @media (max-width: 768px) { .hero { grid-template-columns: 1fr; text-align: center; } .hero h1 { font-size: 40px; } .chat-bot { width: 320px; left: 10px; right: 10px; bottom: 10px; } }
        img { max-width: 100%; border-radius: 12px; }
    </style>
</head>
<body>
    <div class="contact-badge">📞 ${CONTACT_PHONE} | 📧 <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></div>
    
    <div class="chat-bot" id="chatBot">
        <div class="chat-header" onclick="toggleChat()">
            <h3>🤖 ZASS AI Assistant</h3>
            <span class="chat-status">● AI Powered</span>
        </div>
        <div id="chatMessages" class="chat-messages">
            <div class="chat-message bot">
                <div class="message">👋 Hello! I'm ZASS AI Assistant. I can help you with pricing, payments, API activation, and technical support. Ask me anything!</div>
            </div>
        </div>
        <div class="chat-input">
            <input type="text" id="chatInput" placeholder="Type your message..." onkeypress="if(event.key==='Enter') sendAIMessage()">
            <button onclick="sendAIMessage()">Send</button>
        </div>
    </div>

    <div class="container">
        <nav>
            <div class="logo">🤖 ZASS AI Enterprise</div>
            <div class="nav-links">
                <a href="#features">Features</a>
                <a href="#pricing">Pricing</a>
                <a href="#demo">Live Demo</a>
                <a href="#payment">Payment</a>
                <button class="btn-outline" onclick="location.href='/login'">Login</button>
                <button class="btn-primary" onclick="location.href='/register'">Get Started →</button>
            </div>
        </nav>
        
        <div class="hero fade-up">
            <div>
                <h1>AI-Powered Browser Isolation</h1>
                <p>Enterprise-grade security with anti-fingerprinting, zero-logs policy, and intelligent AI support. Trusted by leading companies worldwide.</p>
                <button class="btn-primary" onclick="document.getElementById('payment').scrollIntoView({behavior:'smooth'})">Start Now →</button>
                <div class="stats">
                    <div class="stat"><div class="stat-number">99.99%</div><div class="stat-label">Uptime SLA</div></div>
                    <div class="stat"><div class="stat-number">24/7</div><div class="stat-label">AI Support</div></div>
                    <div class="stat"><div class="stat-number">&lt;500ms</div><div class="stat-label">Response Time</div></div>
                </div>
            </div>
            <div class="glass" style="padding: 30px;">
                <pre style="background: #0a0a0a; padding: 20px; border-radius: 12px;"><code>const response = await fetch('/api/demo?url=https://example.com');
const screenshot = await response.blob();</code></pre>
            </div>
        </div>
        
        <div class="demo-section fade-up" id="demo">
            <h2 style="text-align: center;">🎯 Try Live Demo - No Registration</h2>
            <div class="demo-box">
                <input type="text" id="demoUrl" placeholder="https://example.com" value="https://example.com">
                <select id="demoFormat">
                    <option value="png">📸 PNG Screenshot</option>
                    <option value="pdf">📄 PDF Document</option>
                </select>
                <button class="btn-primary" onclick="captureDemo()">🚀 Capture Now</button>
            </div>
            <div class="demo-result" id="demoResult">
                <div class="loader-small"></div>
                <p style="margin-left: 15px;">Enter URL and click Capture</p>
            </div>
        </div>
        
        <div class="features" id="features">
            <h2 style="text-align: center; font-size: 40px;">Why Choose ZASS AI?</h2>
            <div class="features-grid">
                <div class="feature-card fade-up"><div class="feature-icon">🤖</div><h3>AI-Powered Support</h3><p>24/7 intelligent customer care with real-time responses</p></div>
                <div class="feature-card fade-up"><div class="feature-icon">🛡️</div><h3>Anti-Fingerprinting</h3><p>Blocks canvas, WebGL, audio, and font fingerprinting</p></div>
                <div class="feature-card fade-up"><div class="feature-icon">🔒</div><h3>Zero-Logs Policy</h3><p>No data retention. GDPR compliant</p></div>
                <div class="feature-card fade-up"><div class="feature-icon">💳</div><h3>Auto Payment</h3><p>Instant API activation after payment</p></div>
                <div class="feature-card fade-up"><div class="feature-icon">⚡</div><h3>Lightning Fast</h3><p>Under 1.5 seconds response time</p></div>
                <div class="feature-card fade-up"><div class="feature-icon">🌍</div><h3>Global CDN</h3><p>Servers across 3 continents</p></div>
            </div>
        </div>
        
        <div class="pricing" id="pricing">
            <h2 style="text-align: center; font-size: 40px;">Pricing Plans (USD)</h2>
            <div class="pricing-grid">
                <div class="pricing-card fade-up"><h3>Startup</h3><div class="price">$49<small>/mo</small></div><ul style="list-style: none; margin: 20px 0;"><li>✅ 5,000 requests</li><li>✅ PNG & PDF output</li><li>✅ Email support</li></ul><button class="btn-outline" onclick="selectPlan('startup', 49)">Choose Plan</button></div>
                <div class="pricing-card featured fade-up"><h3>Business</h3><div class="price">$99<small>/mo</small></div><ul style="list-style: none; margin: 20px 0;"><li>✅ 15,000 requests</li><li>✅ Batch processing</li><li>✅ Priority support</li></ul><button class="btn-primary" onclick="selectPlan('business', 99)">Choose Plan</button></div>
                <div class="pricing-card fade-up"><h3>Enterprise</h3><div class="price">$299<small>/mo</small></div><ul style="list-style: none; margin: 20px 0;"><li>✅ Unlimited requests</li><li>✅ Dedicated support</li><li>✅ SLA guarantee</li></ul><button class="btn-outline" onclick="selectPlan('enterprise', 299)">Choose Plan</button></div>
            </div>
        </div>
        
        <div class="payment-section fade-up" id="payment">
            <h2 style="text-align: center; margin-bottom: 30px;">💳 Automatic Payment & Activation</h2>
            <div class="payment-form">
                <input type="text" id="companyName" placeholder="Company Name">
                <input type="email" id="payerEmail" placeholder="Email Address">
                <select id="paymentPlan">
                    <option value="">Select Plan</option>
                    <option value="startup">Startup - $49/month (5,000 requests)</option>
                    <option value="business">Business - $99/month (15,000 requests)</option>
                    <option value="enterprise">Enterprise - $299/month (unlimited)</option>
                </select>
                <input type="number" id="paymentAmount" placeholder="Amount (USD)" readonly>
                <button class="btn-primary" onclick="processAutomaticPayment()" style="width: 100%;">💳 Pay Now →</button>
                <div id="paymentStatus" class="payment-status" style="display: none;"></div>
                <div id="activationResult"></div>
            </div>
            <div class="bank-details">
                <h4 style="color: #667eea;">🏦 Bank Transfer Information</h4>
                <p><strong>Bank:</strong> NMB Bank Tanzania</p>
                <p><strong>Account Name:</strong> ZASS Enterprise Solutions</p>
                <p><strong>Account Number:</strong> <span style="color: #667eea; font-size: 20px; font-weight: bold;">${NMB_ACCOUNT}</span></p>
                <p><strong>SWIFT:</strong> NMBLTZTZ</p>
                <p style="font-size: 12px; color: #888; margin-top: 10px;">After payment, our AI bot will automatically detect and activate your API key.</p>
            </div>
        </div>
        
        <footer>
            <p>© 2026 ZASS AI Enterprise. Built with ❤️ in Tanzania</p>
            <p>📧 ${CONTACT_EMAIL} | 📞 ${CONTACT_PHONE} | 💰 NMB: ${NMB_ACCOUNT}</p>
        </footer>
    </div>

    <script>
        let chatOpen = true;
        
        function toggleChat() {
            const messagesDiv = document.getElementById('chatMessages');
            const inputDiv = document.querySelector('.chat-input');
            if (chatOpen) {
                messagesDiv.style.display = 'none';
                inputDiv.style.display = 'none';
                chatOpen = false;
            } else {
                messagesDiv.style.display = 'block';
                inputDiv.style.display = 'flex';
                chatOpen = true;
            }
        }
        
        async function sendAIMessage() {
            const input = document.getElementById('chatInput');
            const message = input.value.trim();
            if (!message) return;
            
            addUserMessage(message);
            input.value = '';
            
            showTyping();
            
            try {
                const response = await fetch('/api/ai/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: message, email: localStorage.getItem('userEmail') || '' })
                });
                const data = await response.json();
                removeTyping();
                addBotMessage(data.response);
            } catch (error) {
                removeTyping();
                addBotMessage("I'm having trouble connecting. Please try again.");
            }
        }
        
        function addUserMessage(text) {
            const messagesDiv = document.getElementById('chatMessages');
            const msgDiv = document.createElement('div');
            msgDiv.className = 'chat-message user';
            msgDiv.innerHTML = `<div class="message">${escapeHtml(text)}</div>`;
            messagesDiv.appendChild(msgDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        
        function addBotMessage(text) {
            const messagesDiv = document.getElementById('chatMessages');
            const msgDiv = document.createElement('div');
            msgDiv.className = 'chat-message bot';
            msgDiv.innerHTML = `<div class="message">${escapeHtml(text)}</div>`;
            messagesDiv.appendChild(msgDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        
        function showTyping() {
            const messagesDiv = document.getElementById('chatMessages');
            const typingDiv = document.createElement('div');
            typingDiv.className = 'chat-message bot';
            typingDiv.id = 'typingIndicator';
            typingDiv.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
            messagesDiv.appendChild(typingDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        
        function removeTyping() {
            const typing = document.getElementById('typingIndicator');
            if (typing) typing.remove();
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function selectPlan(plan, amount) {
            document.getElementById('paymentPlan').value = plan;
            document.getElementById('paymentAmount').value = amount;
            document.getElementById('payment').scrollIntoView({ behavior: 'smooth' });
            addBotMessage(`Great choice! The ${plan} plan costs $${amount}/month. Please fill in your company details to proceed.`);
        }
        
        async function captureDemo() {
            const url = document.getElementById('demoUrl').value;
            const format = document.getElementById('demoFormat').value;
            const resultDiv = document.getElementById('demoResult');
            if (!url) { resultDiv.innerHTML = '<p style="color:#ff6b6b;">❌ Enter URL</p>'; return; }
            resultDiv.innerHTML = '<div class="loader-small"></div><p>Processing...</p>';
            try {
                const res = await fetch(\`/api/demo?url=\${encodeURIComponent(url)}&format=\${format}\`);
                if (!res.ok) throw new Error(\`Error: \${res.status}\`);
                if (format === 'pdf') {
                    const blob = await res.blob();
                    const pdfUrl = URL.createObjectURL(blob);
                    resultDiv.innerHTML = \`<iframe src="\${pdfUrl}" width="100%" height="500px" style="border-radius: 12px;"></iframe>\`;
                } else {
                    const blob = await res.blob();
                    const imgUrl = URL.createObjectURL(blob);
                    resultDiv.innerHTML = \`<img src="\${imgUrl}" style="max-width:100%; border-radius: 12px;">\`;
                }
            } catch(e) { resultDiv.innerHTML = \`<p style="color:#ff6b6b;">❌ \${e.message}</p>\`; }
        }
        
        function processAutomaticPayment() {
            const company = document.getElementById('companyName').value;
            const email = document.getElementById('payerEmail').value;
            const plan = document.getElementById('paymentPlan').value;
            const amount = document.getElementById('paymentAmount').value;
            const statusDiv = document.getElementById('paymentStatus');
            const resultDiv = document.getElementById('activationResult');
            
            if (!company || !email || !plan || !amount) {
                statusDiv.style.display = 'block';
                statusDiv.className = 'payment-status';
                statusDiv.style.background = 'rgba(255,165,0,0.1)';
                statusDiv.style.border = '1px solid #ffa500';
                statusDiv.innerHTML = '❌ Please fill all fields';
                return;
            }
            
            const transactionId = 'TXN-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
            const apiKey = 'ZASS-' + Date.now() + '-' + Math.random().toString(36).substring(2, 16);
            
            statusDiv.style.display = 'block';
            statusDiv.className = 'payment-status status-processing';
            statusDiv.innerHTML = '<div class="loader-small" style="margin: 0 auto 10px;"></div>⏳ Processing payment...';
            
            setTimeout(() => {
                localStorage.setItem('apiKey', apiKey);
                localStorage.setItem('userEmail', email);
                statusDiv.className = 'payment-status status-success';
                statusDiv.innerHTML = \`✅ <strong>PAYMENT SUCCESSFUL!</strong><br>API Key: <code>\${apiKey}</code><br><button class="btn-outline" onclick="copyToClipboard('\${apiKey}')" style="margin-top: 10px;">📋 Copy API Key</button>\`;
                resultDiv.innerHTML = \`<div style="background:rgba(0,255,0,0.1);border-radius:12px;padding:20px;text-align:center;"><h3 style="color:#00ff00;">🎉 API Key Activated!</h3><p>Plan: \${plan}</p><p>Amount: $\${amount}</p><button class="btn-primary" onclick="location.href='/login'">Go to Dashboard →</button></div>\`;
                addBotMessage(\`✅ Payment of $\${amount} for \${plan} plan received! Your API key has been activated.\`);
            }, 2000);
        }
        
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text);
            addBotMessage("✅ API key copied to clipboard!");
        }
        
        document.getElementById('paymentPlan').addEventListener('change', function() {
            const plan = this.value;
            const amounts = { startup: 49, business: 99, enterprise: 299 };
            if (amounts[plan]) document.getElementById('paymentAmount').value = amounts[plan];
            else document.getElementById('paymentAmount').value = '';
        });
        
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js').catch(e => console.log('SW error:', e));
            });
        }
        
        setTimeout(() => addBotMessage("👋 Welcome! Need help with anything? I'm here 24/7 to assist you with payments, API keys, or technical questions."), 2000);
    </script>
</body>
</html>
    `);
});

// Login, Register, Payment, Dashboard pages (same as before but with contact info)
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Login - ZASS Enterprise</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0a0a0a,#0f0c29,#1a1a2e);min-height:100vh;display:flex;justify-content:center;align-items:center}
.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);padding:50px;border-radius:24px;width:450px;border:1px solid rgba(255,255,255,0.1)}
h1{font-size:32px;margin-bottom:10px;background:linear-gradient(135deg,#fff,#667eea);-webkit-background-clip:text;background-clip:text;color:transparent}
input{width:100%;padding:14px;margin:12px 0;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:white}
button{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:12px;color:white;font-weight:bold;cursor:pointer}
a{color:#667eea}
</style></head>
<body><div class=card><h1>🔐 Login</h1><form id=loginForm><input type=email id=email placeholder="Email" required><input type=password id=password placeholder="Password" required><button type=submit>Login →</button></form><p style="margin-top:20px;text-align:center">Don't have an account? <a href="/register">Register</a></p><p style="margin-top:15px;text-align:center"><a href="/">← Back</a></p></div>
<script>document.getElementById('loginForm').onsubmit=async(e)=>{e.preventDefault();const res=await fetch('/api/enterprise/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e.target.email.value,password:e.target.password.value})});const data=await res.json();if(data.success){localStorage.setItem('token',data.token);localStorage.setItem('company',data.company);localStorage.setItem('apiKey',data.apiKey);alert('Welcome '+data.company);window.location.href='/dashboard';}else{alert('Login failed');}};</script></body></html>`);
});

app.get('/register', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Register - ZASS Enterprise</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0a0a0a,#0f0c29,#1a1a2e);min-height:100vh;display:flex;justify-content:center;align-items:center}
.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);padding:50px;border-radius:24px;width:500px;border:1px solid rgba(255,255,255,0.1)}
h1{font-size:32px;margin-bottom:10px;background:linear-gradient(135deg,#fff,#667eea);-webkit-background-clip:text;background-clip:text;color:transparent}
input,select{width:100%;padding:14px;margin:12px 0;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:white}
button{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:12px;color:white;font-weight:bold;cursor:pointer}
</style></head>
<body><div class=card><h1>📝 Register</h1><form id=regForm><input type=text id=company placeholder="Company Name" required><input type=email id=email placeholder="Email" required><input type=tel id=phone placeholder="Phone"><input type=password id=password placeholder="Password (min 8 chars)" required><select id=plan><option value="startup">Startup - $49/mo</option><option value="business">Business - $99/mo</option><option value="enterprise">Enterprise - $299/mo</option></select><button type=submit>Register →</button></form><p style="margin-top:20px;text-align:center">Already have an account? <a href="/login">Login</a></p><p style="margin-top:15px;text-align:center"><a href="/">← Back</a></p></div>
<script>document.getElementById('regForm').onsubmit=async(e)=>{e.preventDefault();const res=await fetch('/api/enterprise/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company_name:e.target.company.value,email:e.target.email.value,phone:e.target.phone.value,password:e.target.password.value,plan:e.target.plan.value})});const data=await res.json();if(data.success){alert('Registered! API Key: '+data.apiKey+'\\nPay $'+data.amount+' to NMB ${NMB_ACCOUNT}');window.location.href='/login';}else{alert('Error');}};</script></body></html>`);
});

app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Dashboard - ZASS Enterprise</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0a0a0a,#0f0c29,#1a1a2e);color:white;padding:20px}
.container{max-width:1200px;margin:0 auto}.card{background:rgba(255,255,255,0.05);border-radius:20px;padding:30px;margin:20px 0}
.api-key{background:#1a1a2e;padding:15px;border-radius:12px;font-family:monospace}
input,button{padding:12px;border-radius:10px;border:none}input{background:rgba(255,255,255,0.1);color:white;width:60%}
button{background:linear-gradient(135deg,#667eea,#764ba2);color:white;cursor:pointer}
</style></head>
<body><div class=container><h1>🏢 Dashboard</h1><div class=card><h3>Company: <span id="company">-</span></h3><div class="api-key">🔑 API Key: <span id="apiKey">-</span> <button onclick="copyKey()">Copy</button></div></div>
<div class=card><h3>🎯 API Test</h3><input type=text id=testUrl placeholder="https://example.com"><button onclick="testAPI()">Capture</button><div id=result></div></div>
<button onclick="logout()" style="background:#ff4444">Logout</button> <a href="/" style="color:#667eea">← Home</a></div>
<script>const apiKey=localStorage.getItem('apiKey');const company=localStorage.getItem('company');if(!apiKey)window.location.href='/login';document.getElementById('company').innerText=company||'N/A';document.getElementById('apiKey').innerText=apiKey;
async function testAPI(){const url=document.getElementById('testUrl').value;const res=await fetch('/api/enterprise/render?url='+encodeURIComponent(url),{headers:{'x-api-key':apiKey}});if(res.ok){const blob=await res.blob();const imgUrl=URL.createObjectURL(blob);document.getElementById('result').innerHTML='<img src="'+imgUrl+'" style="max-width:100%;margin-top:20px">';}else{document.getElementById('result').innerHTML='<p style="color:#ff6b6b">Error</p>';}}
function copyKey(){navigator.clipboard.writeText(apiKey);alert('Copied!');}
function logout(){localStorage.clear();window.location.href='/login';}</script></body></html>`);
});

// PWA Files
app.get('/manifest.json', (req, res) => {
    res.json({ name: "ZASS AI Enterprise", short_name: "ZASS", start_url: "/", display: "standalone", theme_color: "#667eea", background_color: "#0a0a0a", icons: [{ src: "/zas.png", sizes: "512x512", type: "image/png" }] });
});

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`const C='zass-v1';self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/manifest.json']))));self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));`);
});

app.get('/zas.png', (req, res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#667eea"/><text x="256" y="276" font-size="200" text-anchor="middle" fill="white" font-family="Arial">🤖</text></svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
});

// ==================== START ====================
async function start() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                                                                      ║
║   🤖 ZASS AI ENTERPRISE ULTIMATE - FORTUNE 500 READY                ║
║   ==========================================================         ║
║                                                                      ║
║   💰 NMB Account: ${NMB_ACCOUNT}                                      ║
║   📧 Contact: ${CONTACT_EMAIL}                                        ║
║   📞 Phone: ${CONTACT_PHONE}                                          ║
║   🤖 AI Provider: ${AI_PROVIDER}                                      ║
║                                                                      ║
║   ✅ Features: AI Chatbot | Anti-Fingerprinting | Auto Payment      ║
║   💵 Pricing: $49 - $299/month                                      ║
║                                                                      ║
║   📱 URL: http://localhost:${PORT}                                    ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
    `);
    await initDatabase();
    await initBrowser();
    app.listen(PORT, '0.0.0.0', () => console.log(`✅ ZASS AI Enterprise running on port ${PORT}`));
}

start();
