// ============================================
// DVSA PROXY BACKEND - FIXED VERSION
// No errors, ready for Railway deployment
// ============================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// Simple cookie storage (no complex packages)
// ============================================

let sessionCookie = null;
let sessionActive = false;

// Create axios instance
const client = axios.create({
    timeout: 30000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
    }
});

// Add cookie to requests if available
client.interceptors.request.use(config => {
    if (sessionCookie) {
        config.headers['Cookie'] = sessionCookie;
    }
    return config;
});

// ============================================
// LONDON TEST CENTRES
// ============================================

const LONDON_CENTRES = [
    { code: 'LDNLT', name: 'Loughton', address: 'Loughton, Essex, IG10 1RB' },
    { code: 'LDNHS', name: 'Hounslow', address: 'Hounslow, TW3 1NL' },
    { code: 'LDNMH', name: 'Mill Hill', address: 'Mill Hill, NW7 3HU' },
    { code: 'LDNTD', name: 'Toddington', address: 'Toddington, LU5 6HR' },
    { code: 'LDNWG', name: 'Wood Green', address: 'Wood Green, N22 6UJ' },
    { code: 'LDNYV', name: 'Yelverton', address: 'Yelverton, NW10 7LJ' },
    { code: 'LDNMD', name: 'Morden', address: 'Morden, SM4 5BH' },
    { code: 'LDNER', name: 'Erith', address: 'Erith, DA8 1QD' },
    { code: 'LDNGM', name: 'Goodmayes', address: 'Goodmayes, IG3 9UB' }
];

let slotDatabase = {};
let scanHistory = [];

// ============================================
// SESSION FUNCTIONS
// ============================================

async function checkSession() {
    try {
        const response = await client.get('https://driverpracticaltest.dvsa.gov.uk/');
        const html = response.data;
        const isLoggedIn = html.includes('sign-out') || 
                          html.includes('logout') || 
                          html.includes('Your details');
        sessionActive = isLoggedIn;
        return isLoggedIn;
    } catch (error) {
        sessionActive = false;
        return false;
    }
}

// ============================================
// CENTRE CHECK FUNCTION
// ============================================

async function checkCentre(centre) {
    try {
        const url = `https://driverpracticaltest.dvsa.gov.uk/booking?centreCode=${centre.code}`;
        const response = await client.get(url);
        const html = response.data;
        
        let hasSlots = false;
        let availableDates = [];
        
        // Check for available slots
        if (html.includes('available-date') || html.includes('slot-available')) {
            hasSlots = true;
        }
        
        // Extract dates
        const datePattern = /data-date="([^"]+)"/g;
        let match;
        while ((match = datePattern.exec(html)) !== null) {
            const date = match[1];
            if (!availableDates.includes(date)) {
                availableDates.push(date);
                hasSlots = true;
            }
        }
        
        // Check for time slots
        if (html.includes('time-slot')) {
            hasSlots = true;
        }
        
        const result = {
            centre: centre,
            hasSlots: hasSlots,
            slotCount: availableDates.length,
            availableDates: availableDates.slice(0, 15),
            lastChecked: new Date().toISOString()
        };
        
        slotDatabase[centre.code] = result;
        return result;
        
    } catch (error) {
        slotDatabase[centre.code] = {
            centre: centre,
            hasSlots: false,
            error: error.message,
            lastChecked: new Date().toISOString()
        };
        return slotDatabase[centre.code];
    }
}

// ============================================
// SCAN ALL CENTRES
// ============================================

async function scanAllCentres() {
    const results = [];
    
    for (const centre of LONDON_CENTRES) {
        const result = await checkCentre(centre);
        results.push(result);
        // Delay 2 seconds between requests
        await new Promise(r => setTimeout(r, 2000));
    }
    
    scanHistory.unshift({
        timestamp: new Date().toISOString(),
        slotsFound: results.filter(r => r.hasSlots).length,
        totalSlots: results.reduce((sum, r) => sum + (r.slotCount || 0), 0)
    });
    
    if (scanHistory.length > 50) scanHistory.pop();
    
    return results;
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/api/centres', (req, res) => {
    const centresWithStatus = LONDON_CENTRES.map(centre => ({
        ...centre,
        status: slotDatabase[centre.code] || { hasSlots: false }
    }));
    res.json({ success: true, data: centresWithStatus });
});

app.get('/api/stats', (req, res) => {
    const centresWithSlots = Object.values(slotDatabase).filter(s => s.hasSlots).length;
    const totalSlots = Object.values(slotDatabase).reduce((sum, s) => sum + (s.slotCount || 0), 0);
    
    res.json({
        success: true,
        stats: {
            totalCentres: LONDON_CENTRES.length,
            centresWithSlots: centresWithSlots,
            totalSlots: totalSlots,
            lastScan: scanHistory[0]?.timestamp || null,
            sessionActive: sessionActive,
            historyCount: scanHistory.length
        }
    });
});

app.get('/api/history', (req, res) => {
    res.json({ success: true, data: scanHistory.slice(0, 30) });
});

app.get('/api/session-status', async (req, res) => {
    const isActive = await checkSession();
    res.json({ active: isActive });
});

app.post('/api/set-cookie', express.json(), (req, res) => {
    const { cookie } = req.body;
    if (!cookie) {
        return res.status(400).json({ error: 'No cookie provided' });
    }
    
    sessionCookie = cookie;
    res.json({ success: true, message: 'Cookie saved' });
});

app.post('/api/scan', async (req, res) => {
    res.json({ success: true, message: 'Scan started' });
    // Run scan in background
    scanAllCentres().catch(console.error);
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============================================
// AUTO SCAN (Every 5 minutes)
// ============================================

cron.schedule('*/5 * * * *', async () => {
    console.log('Auto-scan triggered');
    if (sessionActive) {
        await scanAllCentres();
    }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🚗 DVSA PROXY BACKEND - FIXED VERSION                   ║
║                                                            ║
║   Server: http://localhost:${PORT}                          ║
║   Status: Running                                         ║
║   Centres: ${LONDON_CENTRES.length} London centres          ║
║                                                            ║
║   API Endpoints:                                          ║
║   GET  /api/centres       - All centres status           ║
║   GET  /api/stats         - Statistics                   ║
║   GET  /api/history       - Scan history                 ║
║   GET  /api/session-status - Session status              ║
║   POST /api/scan          - Trigger manual scan          ║
║   POST /api/set-cookie    - Set session cookie           ║
║   GET  /api/health        - Health check                 ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
    
    await checkSession();
});
