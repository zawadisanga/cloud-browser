// Cloud Browser - Professional Screenshot API System
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== CONFIGURATION ====================
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS) || 3;
const CACHE_TTL = 3600000; // 1 hour in milliseconds
const REQUEST_TIMEOUT = 30000; // 30 seconds

// ==================== MIDDLEWARE ====================
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Rate limit exceeded. Please try again later.' }
});
app.use('/api/', limiter);

// ==================== BROWSER POOL MANAGER ====================
class BrowserPool {
    constructor() {
        this.available = [];
        this.busy = new Set();
        this.maxSize = MAX_WORKERS;
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
        
        // Clean cache every hour
        setInterval(() => this.cleanCache(), CACHE_TTL);
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
        
        // Wait for available browser
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
        
        // Check cache
        const cacheKey = `${url}:${options.format || 'png'}`;
        if (this.cache.has(cacheKey) && !options.skipCache) {
            this.stats.cacheHits++;
            return { data: this.cache.get(cacheKey), fromCache: true };
        }
        
        const browser = await this.acquire();
        let page = null;
        
        try {
            page = await browser.newPage();
            await page.setViewportSize({ 
                width: options.width || 1920, 
                height: options.height || 1080 
            });
            
            await page.goto(url, { 
                waitUntil: 'networkidle',
                timeout: options.timeout || REQUEST_TIMEOUT
            });
            
            let result;
            if (options.format === 'pdf') {
                result = await page.pdf({ 
                    format: options.paperFormat || 'A4',
                    printBackground: true
                });
            } else {
                result = await page.screenshot({ 
                    fullPage: options.fullPage !== false,
                    type: options.type || 'png',
                    quality: options.quality || 90
                });
            }
            
            // Store in cache
            this.cache.set(cacheKey, result);
            setTimeout(() => this.cache.delete(cacheKey), CACHE_TTL);
            
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
            cacheHitRate: this.stats.totalRequests > 0 
                ? ((this.stats.cacheHits / this.stats.totalRequests) * 100).toFixed(2) 
                : 0,
            uptime: Math.floor((Date.now() - this.stats.startTime) / 1000),
            workers: {
                available: this.available.length,
                busy: this.busy.size,
                total: this.available.length + this.busy.size,
                max: this.maxSize
            },
            cacheSize: this.cache.size
        };
    }
}

// Initialize browser pool
const browserPool = new BrowserPool();

// ==================== API ENDPOINTS ====================

// Health check
app.get('/health', (req, res) => {
    const stats = browserPool.getStats();
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        service: 'Cloud Browser API',
        ...stats
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

// Screenshot endpoint
app.get('/api/screenshot', async (req, res) => {
    const { url, fullPage = 'true', width, height, quality } = req.query;
    
    if (!url) {
        return res.status(400).json({ 
            error: 'URL is required',
            example: '/api/screenshot?url=https://google.com'
        });
    }
    
    // Validate URL
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
        
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.setHeader('X-Workers-Available', browserPool.getStats().workers.available);
        res.send(result.data);
    } catch (error) {
        console.error('Screenshot error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// PDF endpoint
app.get('/api/pdf', async (req, res) => {
    const { url, format = 'A4' } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    try {
        const result = await browserPool.capture(url, {
            format: 'pdf',
            paperFormat: format
        });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="document-${Date.now()}.pdf"`);
        res.send(result.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Batch screenshot endpoint
app.post('/api/batch', async (req, res) => {
    const { urls, fullPage = true } = req.body;
    
    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: 'URLs array is required' });
    }
    
    if (urls.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 URLs per batch' });
    }
    
    const startTime = Date.now();
    const results = [];
    
    for (const url of urls) {
        try {
            const result = await browserPool.capture(url, { fullPage, skipCache: false });
            results.push({
                url,
                success: true,
                data: result.data.toString('base64'),
                fromCache: result.fromCache
            });
        } catch (error) {
            results.push({
                url,
                success: false,
                error: error.message
            });
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

// Stats endpoint
app.get('/api/stats', (req, res) => {
    res.json(browserPool.getStats());
});

// Clear cache
app.delete('/api/cache', (req, res) => {
    browserPool.cleanCache();
    res.json({ message: 'Cache cleared successfully', timestamp: new Date().toISOString() });
});

// ==================== ERROR HANDLER ====================
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// ==================== START SERVER ====================
browserPool.init().then(() => {
    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🌐 CLOUD BROWSER - PROFESSIONAL SCREENSHOT API            ║
║   =============================================              ║
║                                                              ║
║   Status:     🟢 RUNNING                                    ║
║   Port:       ${PORT}                                          ║
║   Workers:    ${MAX_WORKERS}                                   ║
║                                                              ║
║   Endpoints:                                                ║
║   ├── GET  /              - Dashboard                      ║
║   ├── GET  /health        - Health check                   ║
║   ├── GET  /api/screenshot - Take screenshot               ║
║   ├── GET  /api/pdf       - Generate PDF                   ║
║   ├── POST /api/batch     - Batch screenshots              ║
║   ├── GET  /api/stats     - System statistics              ║
║   └── DELETE /api/cache   - Clear cache                    ║
║                                                              ║
║   Dashboard:  http://localhost:${PORT}                        ║
║   Health:     http://localhost:${PORT}/health                ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
        `);
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});
