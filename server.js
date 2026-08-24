const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const NodeCache = require('node-cache'); // High-speed in-memory caching engine
const bcrypt = require('bcrypt');         // Secure password hashing library
const mysql = require('mysql2/promise');   // Promise-based MySQL driver
const jwt = require('jsonwebtoken');       // Security tokens
const nodemailer = require('nodemailer');

// Initialize express instance
const app = express();
const PORT = process.env.PORT || 3000;

// Expanded global metrics state & dynamic log buffers
const systemStats = {
    totalVisits: 0,
    successfulDownloads: 0,
    failedDownloads: 0,
    activeRequests: 0,
    errorLogs: [],      // Max 50 error entries
    requestLogs: [],    // Max 100 recent API request logs
    extractionLogs: []  // Max 50 extraction activity logs
};

// Configure email transporter
const mailTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: process.env.EMAIL_PORT || 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// High-availability MySQL pool configuration
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'rukundoshimokevin',
    database: process.env.DB_NAME || 'savetubenow',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false ,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

// Verify database connection and auto-initialize tables on startup
(async () => {
    try {
        const connection = await db.getConnection();
        console.log('✅ Database verification successful: Pool connection acquired.');
        
        // Auto-create admins table if it does not exist
        await connection.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                reset_code VARCHAR(10) DEFAULT NULL,
                reset_expires DATETIME DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        console.log('✅ Admins table schema verified.');
        connection.release();
    } catch (error) {
        console.error('❌ Critical Error: Database connection/initialization failed!', error.message);
    }
})();

// Binary path resolution (Linux vs Windows local)
const localBinPath = path.join(__dirname, 'bin', 'yt-dlp');
const ytDlpBinary = fs.existsSync(localBinPath) ? localBinPath : 'yt-dlp';

// In-memory caching engines
const searchCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
const infoCache = new NodeCache({ stdTTL: 900, checkperiod: 180 });
const suggestCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Global Middleware Configuration
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Comprehensive Telemetry Middleware: Track visits, request execution speed, and IP logs
app.use((req, res, next) => {
    const startTime = Date.now();

    if (!req.path.startsWith('/api/')) {
        systemStats.totalVisits++;
    } else {
        systemStats.activeRequests++;
    }

    res.on('finish', () => {
        if (req.path.startsWith('/api/')) {
            systemStats.activeRequests = Math.max(0, systemStats.activeRequests - 1);
            const duration = Date.now() - startTime;
            const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();

            // Record API telemetry log
            systemStats.requestLogs.unshift({
                timestamp: new Date().toLocaleTimeString(),
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs: duration,
                ip: clientIp,
                userAgent: req.headers['user-agent'] ? req.headers['user-agent'].substring(0, 45) + '...' : 'Unknown'
            });

            if (systemStats.requestLogs.length > 100) systemStats.requestLogs.pop();
        }
    });

    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// JWT Authentication Middleware for Dashboard Security
const verifyAdminToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. Security session token missing.' });
    }

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET || 'savetubesecretfallbackkey');
        req.admin = verified;
        next();
    } catch (err) {
        res.status(403).json({ error: 'Session expired or altered security context.' });
    }
};

function isValidUrl(string) {
    try {
        const url = new URL(string);
        const allowedDomains = ['youtube.com', 'youtu.be', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com'];
        return allowedDomains.some(domain => url.hostname.includes(domain));
    } catch (_) {
        return false;
    }
}

// 1. LIGHTNING FAST INITIAL QUERY
app.post('/api/search', (req, res) => {
    let { url } = req.body;
    if (!url || url.trim() === "") {
        return res.status(400).json({ error: 'Please enter a link or search keywords.' });
    }

    url = url.trim();

    if (isValidUrl(url)) {
        return res.json({ isDirectLink: true, url: url });
    }

    const sanitizedQuery = url.replace(/[;&|`$\n\r<>]/g, '');
    const cacheKey = `search_${sanitizedQuery.toLowerCase()}`;

    const cachedSearch = searchCache.get(cacheKey);
    if (cachedSearch) {
        return res.json(cachedSearch);
    }

    const searchProcess = spawn(ytDlpBinary, [
        '--flat-playlist',
        '--dump-json',
        `ytsearch5:${sanitizedQuery}`
    ]);

    let stdoutData = '';
    searchProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });

    searchProcess.on('close', (code) => {
        try {
            const lines = stdoutData.trim().split('\n').filter(line => line.trim() !== '');
            const results = lines.map(line => {
                const parsed = JSON.parse(line);
                return {
                    title: parsed.title,
                    id: parsed.id,
                    url: parsed.url || `https://www.youtube.com/watch?v=${parsed.id}`,
                    duration: parsed.duration ? new Date(parsed.duration * 1000).toISOString().substr(11, 8).replace(/^00:/, '') : 'Live/Unknown',
                    thumbnail: parsed.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${parsed.id}/mqdefault.jpg`
                };
            });

            const finalResponse = { isDirectLink: false, results: results };
            searchCache.set(cacheKey, finalResponse);
            res.json(finalResponse);
        } catch (err) {
            res.status(500).json({ error: 'Failed to complete search query layout.' });
        }
    });
});

// 2. VIDEO INFO/FORMATS EXTRACTION PATHWAY (WITH IN-MEMORY CACHING)
app.post('/api/info', (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL target is missing.' });

    url = url.trim().replace(/[;&|`$\n\r<>]/g, '');
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();

    // Check Info Cache to save CPU and bypass rate limits
    const cacheKey = `info_${url.toLowerCase()}`;
    const cachedInfo = infoCache.get(cacheKey);
    if (cachedInfo) {
        systemStats.extractionLogs.unshift({
            timestamp: new Date().toLocaleTimeString(),
            title: cachedInfo.title.substring(0, 40) + '...',
            platform: url.includes('youtube') || url.includes('youtu.be') ? 'YouTube' : 'Other',
            ip: clientIp,
            status: 'Success (Cache Hit)'
        });
        if (systemStats.extractionLogs.length > 50) systemStats.extractionLogs.pop();

        return res.json(cachedInfo);
    }

    let ytDlpArgs = [
        '--config-locations', path.join(__dirname, 'yt-dlp.conf'),
        '--dump-json',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=tv,web_embedded',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    const localCookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(localCookiesPath)) {
        ytDlpArgs.push('--cookies', localCookiesPath);
    }

    ytDlpArgs.push(url);

    const infoProcess = spawn(ytDlpBinary, ytDlpArgs);
    let stdoutData = '';
    let stderrData = '';

    infoProcess.stdout.on('data', (data) => { stdoutData += data; });
    infoProcess.stderr.on('data', (data) => { stderrData += data; });

    infoProcess.on('close', (code) => {
        if (code !== 0) {
            console.error('yt-dlp info error:', stderrData);
            return res.status(500).json({
                error: `System Error (${code}): ${stderrData.slice(0, 100)}...`
            });
        }

        try {
            const parsedData = JSON.parse(stdoutData);
            const formattedResponse = {
                title: parsedData.title,
                thumbnail: parsedData.thumbnail,
                duration: parsedData.duration_string || '00:00',
                url: parsedData.webpage_url,
                formats: parsedData.formats.map(f => ({
                    formatId: f.format_id,
                    resolution: f.resolution || `${f.width || '?'}x${f.height || '?'}`,
                    ext: f.ext,
                    filesize: f.filesize ? `${(f.filesize / (1024 * 1024)).toFixed(1)} MB` : 'Unknown Size',
                    isAudio: !f.video_ext || f.video_ext === 'none'
                }))
            };

            // Store result in cache
            infoCache.set(cacheKey, formattedResponse);

            // Log extraction audit telemetry
            systemStats.extractionLogs.unshift({
                timestamp: new Date().toLocaleTimeString(),
                title: parsedData.title.substring(0, 40) + '...',
                platform: url.includes('youtube') || url.includes('youtu.be') ? 'YouTube' : 'Other',
                ip: clientIp,
                status: 'Success'
            });
            if (systemStats.extractionLogs.length > 50) systemStats.extractionLogs.pop();

            res.json(formattedResponse);
        } catch (parseErr) {
            res.status(500).json({ error: 'Failed to process media configuration schema.' });
        }
    });
});

// 3. STITCHING AND CONVERSION DOWNLOAD PATHWAY (WITH LEAK-SAFE CLEANUP)
const ffmpegPath = require('ffmpeg-static'); // Requires 'npm install ffmpeg-static'

app.get('/api/download', (req, res) => {
    let { url, formatId, title, isAudio } = req.query;
    if (!url || !isValidUrl(url)) {
        return res.status(400).json({ error: 'Valid URL parameter is missing.' });
    }

    url = url.trim().replace(/[;&|`$\n\r<>]/g, '');

    const cleanTitle = (title || 'music').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const brandedFilename = `${cleanTitle}_from_savetubenow`;

    const uniqueId = crypto.randomBytes(4).toString('hex');
    const ext = isAudio === 'true' ? 'mp3' : 'mp4';
    const tempFilePath = path.join(os.tmpdir(), `savetube_${uniqueId}.${ext}`);

    let ytDlpArgs = [];

    if (isAudio === 'true') {
        ytDlpArgs = [
            '-f', 'bestaudio/best',
            '-x', 
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--ffmpeg-location', ffmpegPath, // Passes ffmpeg binary directly to yt-dlp
            '-o', tempFilePath,
            '--no-playlist'
        ];
    } else {
        const formatSelection = formatId === 'best' ? 'bestvideo+bestaudio/best' : `${formatId}+bestaudio/best`;
        ytDlpArgs = [
            '-f', formatSelection,
            '--merge-output-format', 'mp4',
            '--ffmpeg-location', ffmpegPath,
            '-o', tempFilePath,
            '--no-playlist'
        ];
    }

    // Bypass cloud IP restrictions using iOS/Android player clients
    ytDlpArgs.push(
        '--extractor-args', 'youtube:player_client=ios,mweb',
        '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
    );

    const localCookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(localCookiesPath)) {
        ytDlpArgs.push('--cookies', localCookiesPath);
    }

    ytDlpArgs.push(url);

    const downloadProcess = spawn(ytDlpBinary, ytDlpArgs);
    let stderrData = '';

    downloadProcess.stderr.on('data', (data) => { stderrData += data.toString(); });

    req.on('close', () => {
        if (!downloadProcess.killed) downloadProcess.kill('SIGTERM');
        if (fs.existsSync(tempFilePath)) fs.unlink(tempFilePath, () => {});
    });

    downloadProcess.on('close', (code) => {
        if (code !== 0) {
            systemStats.failedDownloads++;
            console.error('yt-dlp Download Error:', stderrData);

            if (!res.headersSent) {
                return res.status(500).json({ error: `Download failed: ${stderrData.slice(0, 120)}` });
            }
            return;
        }

        systemStats.successfulDownloads++;

        res.download(tempFilePath, `${brandedFilename}.${ext}`, (err) => {
            if (fs.existsSync(tempFilePath)) {
                fs.unlink(tempFilePath, () => {});
            }
        });
    });
});
// 4. LIVE SEARCH SUGGESTIONS PROXY
app.get('/api/suggestions', async (req, res) => {
    const query = req.query.q;
    if (!query || query.trim() === "") {
        return res.json([]);
    }

    const cleanQuery = query.trim().toLowerCase();
    const cacheKey = `suggest_${cleanQuery}`;

    const cachedSuggestions = suggestCache.get(cacheKey);
    if (cachedSuggestions) {
        return res.json(cachedSuggestions);
    }

    try {
        const targetUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(cleanQuery)}`;
        const response = await fetch(targetUrl);
        const data = await response.json();

        const suggestions = data[1] || [];

        suggestCache.set(cacheKey, suggestions);
        res.json(suggestions);
    } catch (error) {
        console.error("Autocomplete Engine Error:", error);
        res.json([]);
    }
});

// ADMIN AUTHENTICATION & MANAGEMENT ROUTES

// One-time Admin Registration
app.post('/api/admin/register', async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
        const [countRows] = await db.execute('SELECT COUNT(*) as total FROM admins');
        if (countRows[0].total > 0) {
            return res.status(403).json({ error: 'Registration is permanently locked. An administrator account already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.execute('INSERT INTO admins (username, email, password_hash) VALUES (?, ?, ?)', [
            username.trim(),
            email.trim().toLowerCase(),
            hashedPassword
        ]);

        res.json({ success: true, message: 'Master admin registered successfully!' });
    } catch (error) {
        console.error('Registration Security Error:', error);
        res.status(500).json({ error: 'Internal server initialization failure.' });
    }
});

// Admin Login Endpoint
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password fields are required.' });
    }

    try {
        const [rows] = await db.execute('SELECT * FROM admins WHERE username = ?', [username.trim()]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid administrative credentials.' });
        }

        const admin = rows[0];
        const isMatch = await bcrypt.compare(password, admin.password_hash);

        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid administrative credentials.' });
        }

        const token = jwt.sign(
            { id: admin.id, username: admin.username },
            process.env.JWT_SECRET || 'savetubesecretfallbackkey',
            { expiresIn: '1d' }
        );

        const optimizationAlerts = [];
        const youtubeErrors = systemStats.errorLogs.filter(l => l.platform === 'YouTube' && l.error.includes('429'));
        if (youtubeErrors.length > 3) {
            optimizationAlerts.push('Action Required: YouTube is rate-limiting this server block (HTTP 429).');
        }

        res.json({
            success: true,
            token: token,
            stats: systemStats,
            alerts: optimizationAlerts,
            serverUptime: process.uptime()
        });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ error: 'Internal system validation error.' });
    }
});

// Enhanced Dedicated Secure Admin Metrics Endpoint
app.get('/api/admin/metrics', verifyAdminToken, (req, res) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePct = ((usedMem / totalMem) * 100).toFixed(1);

    const optimizationAlerts = [];
    const youtubeErrors = systemStats.errorLogs.filter(l => l.platform === 'YouTube' && l.error.includes('429'));
    if (youtubeErrors.length > 3) {
        optimizationAlerts.push('Action Required: YouTube is rate-limiting this server block (HTTP 429).');
    }

    res.json({
        success: true,
        serverUptime: Math.floor(process.uptime()),
        memory: {
            totalMB: (totalMem / (1024 * 1024)).toFixed(0),
            usedMB: (usedMem / (1024 * 1024)).toFixed(0),
            percentage: `${memUsagePct}%`
        },
        cacheStats: {
            searchKeys: searchCache.getStats().keys,
            infoKeys: infoCache.getStats().keys,
            suggestKeys: suggestCache.getStats().keys
        },
        stats: {
            totalVisits: systemStats.totalVisits,
            successfulDownloads: systemStats.successfulDownloads,
            failedDownloads: systemStats.failedDownloads,
            activeRequests: systemStats.activeRequests
        },
        alerts: optimizationAlerts,
        recentRequests: systemStats.requestLogs.slice(0, 20),
        recentExtractions: systemStats.extractionLogs.slice(0, 20),
        errorLogs: systemStats.errorLogs.slice(0, 20)
    });
});

// Flush System Caches
app.post('/api/admin/cache/flush', verifyAdminToken, (req, res) => {
    searchCache.flushAll();
    infoCache.flushAll();
    suggestCache.flushAll();
    res.json({ success: true, message: 'All in-memory caches successfully flushed.' });
});

// Clear System Error Logs
app.delete('/api/admin/logs/errors', verifyAdminToken, (req, res) => {
    systemStats.errorLogs = [];
    res.json({ success: true, message: 'Error log buffer cleared.' });
});

// Password Recovery Flow
app.post('/api/admin/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Please enter your account email address.' });
    }

    try {
        const [users] = await db.execute('SELECT id FROM admins WHERE email = ?', [email.trim().toLowerCase()]);
        if (users.length === 0) {
            return res.json({ success: true, message: 'If the account exists, a temporary verification code has been sent.' });
        }

        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await db.execute('UPDATE admins SET reset_code = ?, reset_expires = ? WHERE email = ?', [
            verificationCode,
            expiresAt,
            email.trim().toLowerCase()
        ]);

        const mailOptions = {
            from: `"SaveTubeNow Portal" <${process.env.EMAIL_USER}>`,
            to: email.trim().toLowerCase(),
            subject: 'SaveTubeNow Security Reset Code',
            html: `
                <div style="font-family: sans-serif; padding: 20px; max-width: 500px; border: 1px solid #e2e8f0; border-radius: 8px;">
                    <h2 style="color: #4f46e5;">Verification Security Pin</h2>
                    <p>Use the temporary authorization code below to reset your password:</p>
                    <div style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #1e1b4b; margin: 20px 0; padding: 10px; background-color: #f5f3ff; text-align: center; border-radius: 6px;">
                        ${verificationCode}
                    </div>
                    <p style="font-size: 12px; color: #64748b;">This code will automatically expire in 15 minutes.</p>
                </div>
            `
        };

        await mailTransporter.sendMail(mailOptions);
        res.json({ success: true, message: 'Verification code sent safely to email.' });
    } catch (error) {
        console.error('Password Flow Error:', error);
        res.status(500).json({ error: 'Failed to process account recovery.' });
    }
});

// Reset Password Operation
app.post('/api/admin/reset-password', async (req, res) => {
    const { email, resetCode, newPassword } = req.body;

    if (!email || !resetCode || !newPassword) {
        return res.status(400).json({ error: 'All fields are mandatory.' });
    }

    try {
        const [users] = await db.execute(
            'SELECT id, reset_expires FROM admins WHERE email = ? AND reset_code = ?',
            [email.trim().toLowerCase(), resetCode.trim()]
        );

        if (users.length === 0) {
            return res.status(400).json({ error: 'Invalid verification details.' });
        }

        if (new Date() > new Date(users[0].reset_expires)) {
            return res.status(400).json({ error: 'This token code has expired.' });
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        await db.execute(
            'UPDATE admins SET password_hash = ?, reset_code = NULL, reset_expires = NULL WHERE id = ?',
            [hashedNewPassword, users[0].id]
        );

        res.json({ success: true, message: 'Password updated successfully!' });
    } catch (error) {
        console.error('Reset Execution Error:', error);
        res.status(500).json({ error: 'Failed to rewrite system password.' });
    }
});

app.listen(PORT, () => { console.log(`SaveTubeNow running on port ${PORT}`); });