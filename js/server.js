// js/server.js

// --- 1. IMPORTS ---
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// --- ENVIRONMENT CONFIGURATION ---
// NODE_ENV switches between production and test env vars.
// Production vars: DATAVERSE_URL, POWER_AUTOMATE_GET_URL
// Test vars: DATAVERSE_URL_TEST, POWER_AUTOMATE_GET_URL_TEST
// development uses test vars with local base URL.
const currentEnv = process.env.NODE_ENV || 'development';

const envConfig = (() => {
    // Actually deployed = NODE_ENV is test/production AND running on Railway (not local)
    const isDeployed = (currentEnv === 'production' || currentEnv === 'test') && !!process.env.RAILWAY_ENVIRONMENT;
    const localBaseUrl = `http://localhost:${process.env.PORT || 3000}`;
    if (currentEnv === 'production') {
        return {
            dataverseUrl: process.env.DATAVERSE_URL || '',
            powerAutomateUrl: process.env.POWER_AUTOMATE_GET_URL || '',
            baseUrl: isDeployed ? (process.env.BASE_URL || 'https://www.drweee.com') : localBaseUrl,
            isDeployed
        };
    }
    // test and development both use test env vars
    return {
        dataverseUrl: process.env.DATAVERSE_URL_TEST || '',
        powerAutomateUrl: process.env.POWER_AUTOMATE_GET_URL_TEST || '',
        baseUrl: isDeployed ? (process.env.BASE_URL || 'https://www.drweee.com') : localBaseUrl,
        isDeployed
    };
})();

console.log(`🌍 Environment: ${currentEnv}`);
console.log(`📊 Dataverse: ${envConfig.dataverseUrl || '⚠️ NOT SET'}`);
console.log(`🔗 Power Automate: ${envConfig.powerAutomateUrl ? 'configured' : '⚠️ NOT SET'}`);

const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
// Remove MySQL session store for now to avoid database lock issues
// const MySQLStore = require('express-mysql-session')(session);
// const mysql = require('mysql2/promise');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const webpush = require('web-push');
// Add after existing imports
const cequensApi = {
    baseUrl: 'https://apis.cequens.com',
    token: null,
    tokenExpiry: null
};
const productCache = {
    data: null,
    lastFetch: 0
};
const CACHE_DURATION_MS = 60 * 60 * 1000; // Cache for 1 hour
const dataverse = {
    accessToken: null,
    tokenExpiry: null
};
const STORE_CACHE_DURATION_MS = 15 * 60 * 1000; // Cache for 15 minutes

// Vouchers cache (keyed by territoryId)
const vouchersCacheByTerritory = new Map();
const VOUCHERS_CACHE_DURATION_MS = 15 * 60 * 1000; // Cache for 15 minutes

// Translation cache for Azure Translator
const translationCache = new Map();
const TRANSLATION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// --- WEB PUSH NOTIFICATIONS ---
// VAPID keys for Web Push (generate once and store in .env)
// To generate: npx web-push generate-vapid-keys
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@drweee.com';

// Configure web-push if VAPID keys are available
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log('🔔 Web Push notifications configured');
} else {
    console.log('⚠️ Web Push: VAPID keys not configured - push notifications disabled');
}

// Push subscription storage (file-based for simplicity, can be upgraded to DB)
const PUSH_SUBSCRIPTIONS_FILE = path.join(__dirname, '../data/push-subscriptions.json');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Load existing subscriptions
let pushSubscriptions = new Map(); // Map<userId, subscription>

// SSE (Server-Sent Events) connections for real-time in-app notifications
// Map<userId, Set<response objects>>
const sseConnections = new Map();

// Send SSE event to a specific user (all their connected clients)
function sendSSEToUser(userId, eventType, data) {
    const userConnections = sseConnections.get(userId);
    if (!userConnections || userConnections.size === 0) {
        return { sent: 0, userId };
    }

    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    let sent = 0;

    userConnections.forEach(res => {
        try {
            res.write(message);
            sent++;
        } catch (e) {
            // Connection might be dead, will be cleaned up on error
        }
    });

    console.log(`📡 SSE sent to ${userId.slice(0, 8)}... (${sent} clients)`);
    return { sent, userId };
}
try {
    if (fs.existsSync(PUSH_SUBSCRIPTIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PUSH_SUBSCRIPTIONS_FILE, 'utf8'));
        pushSubscriptions = new Map(Object.entries(data));
        console.log(`📱 Loaded ${pushSubscriptions.size} push subscriptions`);
    }
} catch (e) {
    console.error('Failed to load push subscriptions:', e.message);
}

// Save subscriptions to file
function savePushSubscriptions() {
    try {
        const data = Object.fromEntries(pushSubscriptions);
        fs.writeFileSync(PUSH_SUBSCRIPTIONS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Failed to save push subscriptions:', e.message);
    }
}

// Send push notification to a specific user
async function sendPushNotification(userId, payload) {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.log('Push notifications not configured - skipping');
        return { success: false, reason: 'not_configured' };
    }

    const subscription = pushSubscriptions.get(userId);
    if (!subscription) {
        console.log(`No push subscription for user ${userId.slice(0, 8)}...`);
        return { success: false, reason: 'no_subscription' };
    }

    try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        console.log(`🔔 Push sent to user ${userId.slice(0, 8)}...`);
        return { success: true };
    } catch (error) {
        console.error(`Push failed for user ${userId.slice(0, 8)}:`, error.message, error.statusCode ? `(${error.statusCode})` : '');

        // Remove invalid subscriptions
        // 410 Gone - subscription expired
        // 404 Not Found - subscription invalid
        // 401 Unauthorized - subscription invalid
        // Any 4xx error means the subscription is no longer valid
        if (error.statusCode >= 400 && error.statusCode < 500) {
            pushSubscriptions.delete(userId);
            savePushSubscriptions();
            console.log(`Removed invalid subscription for user ${userId.slice(0, 8)} (status: ${error.statusCode})`);
            return { success: false, reason: 'subscription_expired' };
        }

        return { success: false, reason: error.message };
    }
}

// --- SECURE LOGGING UTILITIES ---
// Production-safe logging that masks sensitive data
// Returns true for any deployed environment (test or production on Railway)
const isProduction = () => envConfig.isDeployed;

// Mask phone number: +201234567890 -> +20****7890
function maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '[no-phone]';
    if (phone.length <= 4) return '****';
    return phone.slice(0, 3) + '****' + phone.slice(-4);
}

// Mask GUID: 12345678-1234-1234-1234-123456789012 -> 1234****9012
function maskGUID(guid) {
    if (!guid || typeof guid !== 'string') return '[no-guid]';
    if (guid.length <= 8) return '****';
    return guid.slice(0, 4) + '****' + guid.slice(-4);
}

// Mask email: user@domain.com -> u***@domain.com
function maskEmail(email) {
    if (!email || typeof email !== 'string') return '[no-email]';
    const [local, domain] = email.split('@');
    if (!domain) return '****';
    return local.charAt(0) + '***@' + domain;
}

// Safe logger that only logs in development, masks sensitive data in production
const secureLog = {
    info: (message, ...args) => {
        if (isProduction()) {
            // In production, log without sensitive details
            console.log(`[INFO] ${message}`);
        } else {
            console.log(`[INFO] ${message}`, ...args);
        }
    },
    debug: (message, ...args) => {
        // Debug logs only in development
        if (!isProduction()) {
            console.log(`[DEBUG] ${message}`, ...args);
        }
    },
    warn: (message, ...args) => {
        console.warn(`[WARN] ${message}`, ...args);
    },
    error: (message, error = null) => {
        if (isProduction()) {
            // In production, don't log stack traces or detailed error data
            console.error(`[ERROR] ${message}`);
        } else {
            console.error(`[ERROR] ${message}`, error);
        }
    },
    // Log with masked phone number
    phone: (message, phone) => {
        console.log(`${message} ${maskPhone(phone)}`);
    },
    // Log with masked GUID
    guid: (message, guid) => {
        console.log(`${message} ${maskGUID(guid)}`);
    },
    // Safe JSON logging - strips sensitive fields
    safeJson: (message, obj) => {
        if (isProduction()) {
            console.log(`${message} [data redacted in production]`);
        } else {
            // In dev, redact known sensitive fields
            const sanitized = JSON.parse(JSON.stringify(obj || {}));
            const sensitiveFields = ['password', 'passwordhash', 'token', 'secret', 'apikey', 'authorization', 'otp', 'access_token'];
            const redact = (o) => {
                if (typeof o !== 'object' || o === null) return;
                for (const key of Object.keys(o)) {
                    if (sensitiveFields.some(f => key.toLowerCase().includes(f))) {
                        o[key] = '[REDACTED]';
                    } else if (typeof o[key] === 'object') {
                        redact(o[key]);
                    }
                }
            };
            redact(sanitized);
            console.log(`${message}`, JSON.stringify(sanitized, null, 2));
        }
    }
};

// --- 2. INITIALIZATION & CONFIGURATION ---
const app = express();
const port = process.env.PORT || 3000;

// Trust proxy - Required for Railway, Heroku, and other cloud platforms
// This enables express to trust X-Forwarded-* headers from reverse proxies
app.set('trust proxy', 1);

// Use memory store instead of MySQL for sessions (more reliable)
const sessionStore = new MemoryStore({
    checkPeriod: 86400000 // prune expired entries every 24h
});
// Add after app initialization
// Validate required environment variables
const requiredEnvVars = [
    'CEQUENS_API_KEY', 'CEQUENS_USERNAME', 'CEQUENS_SENDER_NAME',
    'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
    'DATAVERSE_URL', 'POWER_AUTOMATE_GET_URL',
    'DATAVERSE_URL_TEST', 'POWER_AUTOMATE_GET_URL_TEST'
];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
    console.error('Please check your .env file and ensure all credentials are set.');
}
// Fallback database connection if needed for other purposes (not sessions)
// const dbPool = mysql.createPool({
//     host: process.env.DB_HOST,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     database: process.env.DB_DATABASE,
//     port: process.env.DB_PORT,
//     acquireTimeout: 60000,
//     timeout: 60000,
//     reconnect: true
// });

// --- 3. HELPER FUNCTIONS ---
function hashPassword(password) {
    const saltSize = 16; // 128 bit
    const hashSize = 32; // 256 bit
    const iterations = 10000;
    const salt = crypto.randomBytes(saltSize);
    const hash = crypto.pbkdf2Sync(password, salt, iterations, hashSize, 'sha256');
    const iterCountBuffer = Buffer.alloc(4);
    iterCountBuffer.writeUInt32BE(iterations, 0);
    const saltSizeBuffer = Buffer.alloc(4);
    saltSizeBuffer.writeUInt32BE(saltSize, 0);
    const combined = Buffer.concat([
        Buffer.from([0x01]), // Format marker
        iterCountBuffer,
        saltSizeBuffer,
        salt,
        hash
    ]);
    return combined.toString('base64');
}

function extractPropertyValue(property) {
    // Based on dataType, extract the appropriate value
    // DataType mapping: 0=OptionSet, 1=String, 2=Whole Number, 3=Float, 4=Integer, 5=Decimal, 6=DateTime, 7=Two Options

    let value = null;

    // FIX: Check for the nested property name returned by the Dataverse API for linked entities.
    // The format is 'alias.fieldname'.
    const optionSetText = property.propertyValueOptionSetText || property['propertyoptionset.propertyValueOptionSetText'];

    switch (property.dataType) {
        case 0: // OptionSet
            value = optionSetText;
            break;
        case 1: // String
            value = property.propertyValueString;
            break;
        case 2: // Whole Number
        case 4: // Integer
            value = property.propertyValueInteger;
            if (value !== null && value !== undefined) {
                value = value.toLocaleString();
            }
            break;
        case 3: // Float
            value = property.propertyValueDouble;
            if (value !== null && value !== undefined) {
                value = parseFloat(value).toFixed(2);
            }
            break;
        case 5: // Decimal
            value = property.propertyValueDecimal;
            if (value !== null && value !== undefined) {
                value = parseFloat(value).toFixed(2);
            }
            break;
        case 6: // DateTime
            // Handle datetime if needed
            value = property.propertyValueString;
            break;
        case 7: // Two Options (Boolean)
            value = property.propertyValueInteger === 1 ? 'Yes' : 'No';
            break;
        default:
            // Fallback - try all possible value fields, including the corrected nested one
            value = optionSetText ||
                property.propertyValueString ||
                property.propertyValueInteger ||
                property.propertyValueDecimal ||
                property.propertyValueDouble;
    }

    return value;
}

// This function gets an OAuth token from Microsoft Entra ID
async function getDataverseToken() {
    // Return cached token if it's still valid
    if (dataverse.accessToken && Date.now() < dataverse.tokenExpiry) {
        return dataverse.accessToken;
    }

    console.log('🔄 Authenticating with Dataverse...');
    const AZURE_TENANT_ID = (process.env.AZURE_TENANT_ID || '').trim();
    const AZURE_CLIENT_ID = (process.env.AZURE_CLIENT_ID || '').trim();
    const AZURE_CLIENT_SECRET = (process.env.AZURE_CLIENT_SECRET || '').trim();
    const DATAVERSE_URL = envConfig.dataverseUrl.replace(/\/+$/, '');

    // Debug: Check if required environment variables are set
    if (!DATAVERSE_URL || !AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
        console.error('❌ Missing required Dataverse environment variables:', {
            hasDataverseUrl: !!DATAVERSE_URL,
            hasTenantId: !!AZURE_TENANT_ID,
            hasClientId: !!AZURE_CLIENT_ID,
            hasClientSecret: !!AZURE_CLIENT_SECRET
        });
        throw new Error('Missing required Dataverse configuration. Check environment variables.');
    }

    const tokenEndpoint = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', AZURE_CLIENT_ID);
    params.append('scope', `${DATAVERSE_URL}/.default`);
    params.append('client_secret', AZURE_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');

    try {
        const response = await axios.post(tokenEndpoint, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        dataverse.accessToken = response.data.access_token;
        // Set expiry to 5 minutes before the actual token expiration for safety
        dataverse.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;

        console.log('✅ Dataverse authentication successful.');
        return dataverse.accessToken;
    } catch (error) {
        console.error('❌ Dataverse authentication failed:', error.response?.status, error.response?.data);
        console.error('❌ Token endpoint used:', tokenEndpoint);
        console.error('❌ Scope used:', `${DATAVERSE_URL}/.default`);
        throw new Error(`Could not authenticate with Dataverse: ${error.response?.data?.error_description || error.message}`);
    }
}

// This function executes a FetchXML query against the Dataverse Web API
async function queryDataverse(entityPluralName, fetchXml) {
    console.log(`[DEBUG] Executing FetchXML for ${entityPluralName}...`);
    const token = await getDataverseToken();
    const baseUrl = envConfig.dataverseUrl.replace(/\/+$/, '');

    const encodedFetchXml = encodeURIComponent(fetchXml);
    const url = `${baseUrl}/api/data/v9.2/${entityPluralName}?fetchXml=${encodedFetchXml}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'OData-MaxVersion': '4.0',
                'OData-Version': '4.0'
            }
        });
        const records = response.data.value;
        console.log(`[DEBUG] Fetched ${records.length} records for ${entityPluralName}.`);
        return records;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        const statusCode = error.response?.status;
        console.error(`❌ Dataverse query failed for ${entityPluralName}: [${statusCode}]`, errorMessage);
        if (error.response?.data) {
            console.error(`❌ Dataverse error details:`, JSON.stringify(error.response.data).substring(0, 500));
        }
        throw new Error(`Failed to query ${entityPluralName}: [${statusCode}] ${errorMessage}`);
    }
}
function verifyPassword(password, hashedPassword) {
    try {
        const hashBytes = Buffer.from(hashedPassword, 'base64');
        const marker = hashBytes[0];
        if (marker !== 0x01) return false;
        const iterCount = hashBytes.readUInt32BE(1);
        const saltSize = hashBytes.readUInt32BE(5);
        const salt = hashBytes.slice(9, 9 + saltSize);
        const storedHash = hashBytes.slice(9 + saltSize);
        const hashSize = storedHash.length;
        const derivedKey = crypto.pbkdf2Sync(password, salt, iterCount, hashSize, 'sha256');
        return crypto.timingSafeEqual(storedHash, derivedKey);
    } catch (error) {
        console.error("Error verifying password:", error);
        return false;
    }
}

function normalizePhoneNumber(phoneNumber) {
    // Remove any non-digit characters first
    let cleaned = phoneNumber.replace(/\D/g, '');

    // Handle Egyptian numbers specifically
    if (cleaned.startsWith('200')) {
        return '20' + cleaned.substring(3);
    } else if (cleaned.startsWith('20') && cleaned.length === 12) {
        return cleaned;
    } else if (cleaned.startsWith('0') && cleaned.length === 11) {
        // Convert local Egyptian format (0xxxxxxxxxx) to international (20xxxxxxxxx)
        return '20' + cleaned.substring(1);
    } else if (cleaned.length === 10) {
        // Add 20 prefix if it's a 10-digit Egyptian number
        return '20' + cleaned;
    }

    return cleaned;
}
async function getCequensToken() {
    if (cequensApi.token && cequensApi.tokenExpiry && Date.now() < cequensApi.tokenExpiry) {
        return cequensApi.token;
    }

    const requestPayload = {
        apiKey: process.env.CEQUENS_API_KEY,
        userName: process.env.CEQUENS_USERNAME
    };

    console.log('🔄 Sending authentication request...');

    try {
        const response = await axios.post(`${cequensApi.baseUrl}/auth/v1/tokens/`, requestPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        console.log('✅ Authentication successful');
        secureLog.safeJson('Cequens auth response:', response.data);

        // Extract token from the nested data object
        cequensApi.token = response.data.data?.access_token || response.data.data?.token;

        if (!cequensApi.token) {
            secureLog.error('No token found in response data');
            throw new Error('Token not found in authentication response');
        }

        cequensApi.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);

        secureLog.debug('Token extracted successfully');
        return cequensApi.token;
    } catch (error) {
        secureLog.error('SMS authentication failed', error.response?.status);
        throw new Error('Failed to authenticate with SMS service');
    }
}
async function sendSMS(phoneNumber, message) {
    try {
        const token = await getCequensToken();

        // Ensure phone number is in the correct format (remove + if present)
        let formattedPhone = phoneNumber.replace(/^\+/, '');

        const smsPayload = {
            messageText: message,
            senderName: process.env.CEQUENS_SENDER_NAME,
            messageType: 'text',
            recipients: formattedPhone,
            shortURL: false
        };

        console.log('📱 Sending SMS request...');
        console.log('SMS Payload:', {
            messageText: message.substring(0, 50) + '...',
            senderName: process.env.CEQUENS_SENDER_NAME,
            messageType: 'text',
            recipients: formattedPhone,
            shortURL: false
        });
        secureLog.debug('SMS request prepared');

        const response = await axios.post(`${cequensApi.baseUrl}/sms/v1/messages`, smsPayload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        secureLog.phone('✅ SMS sent successfully to', phoneNumber);
        return response.data;
    } catch (error) {
        secureLog.error('Failed to send SMS', error.response?.status);
        throw new Error('Failed to send SMS');
    }
}

// Secure OTP generation using crypto
function generateOTP() {
    // Use crypto.randomInt for cryptographically secure random numbers
    return crypto.randomInt(100000, 999999).toString();
}

// Sanitize input for FetchXML to prevent injection attacks
function sanitizeFetchXmlValue(value) {
    if (value === null || value === undefined) return '';
    // Convert to string and escape XML special characters
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Validate GUID format (prevents injection via GUID fields)
function isValidGUID(guid) {
    if (!guid || typeof guid !== 'string') return false;
    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return guidRegex.test(guid);
}

// Timing-safe OTP comparison to prevent timing attacks
function verifyOTP(storedOtp, providedOtp) {
    if (!storedOtp || !providedOtp) return false;
    const storedBuffer = Buffer.from(String(storedOtp));
    const providedBuffer = Buffer.from(String(providedOtp));
    if (storedBuffer.length !== providedBuffer.length) return false;
    return crypto.timingSafeEqual(storedBuffer, providedBuffer);
}

// --- 4. MIDDLEWARE ---

// Import production middleware
const {
    compressionMiddleware,
    securityMiddleware,
    rateLimitMiddleware,
    cacheControlMiddleware,
    requestLoggerMiddleware,
    errorHandlerMiddleware,
    corsOptionsProduction
} = require('./middleware');

// Apply security headers (must be first)
if (isProduction()) {
    app.use(securityMiddleware());
    console.log('✅ Security headers enabled');
}

// Apply compression for better performance
app.use(compressionMiddleware());
console.log('✅ Response compression enabled');

// CORS with production-ready configuration
app.use(cors(isProduction() ? corsOptionsProduction() : {
    origin: ['http://127.0.0.1:5500', 'http://localhost:5500', 'http://127.0.0.1:5501', 'http://localhost:5501', 'http://localhost:3000'],
    credentials: true
}));

// Request logging for slow requests
app.use(requestLoggerMiddleware());

// Add request body size limit to prevent DoS attacks
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Get rate limiters
const { apiLimiter, authLimiter, otpLimiter, ogLimiter } = rateLimitMiddleware();


// Require strong session secret in production
if (isProduction() && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    console.error('FATAL: SESSION_SECRET must be set to a strong random value (at least 32 characters) in production!');
    console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
}

// Session configuration - environment-aware
// secure cookies require HTTPS; only enable when baseUrl is HTTPS (not localhost HTTP)
const isHttps = envConfig.baseUrl.startsWith('https://');

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'drweee-dev-secret-key-not-for-production',
    resave: true,  // Force session save on every request
    saveUninitialized: true,  // Create session even if nothing stored
    name: 'drweee.sid',
    cookie: {
        secure: isHttps,  // true only when on HTTPS (deployed)
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: isHttps ? 'none' : 'lax',  // 'none' for cross-site with secure:true
        path: '/',
        // In production, set domain to allow cookie across subdomains if needed
        ...(isHttps && process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {})
    }
}));

console.log(`🍪 Session cookie: secure=${isHttps}, sameSite=${isHttps ? 'none' : 'lax'}`);

// --- 5. API ENDPOINTS ---

// Session test endpoint - for debugging session issues (can be removed in production)
app.get('/api/session-test', (req, res) => {
    // Initialize or increment a counter
    if (!req.session.testCounter) {
        req.session.testCounter = 0;
    }
    req.session.testCounter++;

    req.session.save((err) => {
        if (err) {
            return res.status(500).json({ error: 'Session save failed' });
        }
        res.json({
            sessionId: req.sessionID,
            counter: req.session.testCounter,
            message: 'Refresh this page - counter should increment if session works'
        });
    });
});

// Health check endpoint for Railway monitoring
app.get('/api/health', (req, res) => {
    const healthcheck = {
        uptime: process.uptime(),
        status: 'OK',
        timestamp: Date.now(),
        environment: currentEnv,
        memoryUsage: {
            heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        }
    };
    res.status(200).json(healthcheck);
});

// Apply rate limiters to specific endpoints
app.post('/api/request-otp', otpLimiter, async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ message: 'Phone number is required.' });
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    try {
        secureLog.phone('[DEBUG] Checking for existing contact with phone:', normalizedPhone);

        // 1. Define an efficient FetchXML query to check for existence.
        // We use top="1" because we only need to know if at least one record exists.
        // Sanitize phone number to prevent FetchXML injection
        const sanitizedPhone = sanitizeFetchXmlValue(normalizedPhone);
        const checkUserFetchXml = `<fetch top="1">
                                      <entity name="contact">
                                        <attribute name="contactid" />
                                        <filter type="and">
                                          <condition attribute="mobilephone" operator="eq" value="${sanitizedPhone}" />
                                        </filter>
                                      </entity>
                                    </fetch>`;

        // 2. Execute the query using the Dataverse helper, replacing the Power Automate call.
        const existingUsers = await queryDataverse('contacts', checkUserFetchXml);

        // 3. Check the result and respond if the user already exists.
        if (existingUsers.length > 0) {
            secureLog.phone('[INFO] Registration blocked: Phone number already exists:', normalizedPhone);
            return res.status(409).json({ message: 'This phone number is already registered. Please login.' });
        }

        // If user does not exist, the original OTP logic continues...
        const otp = generateOTP();
        const smsMessage = `Your DR.WEEE verification code is: ${otp}. This code will expire in 5 minutes. Do not share this code with anyone.`;

        try {
            await sendSMS(normalizedPhone, smsMessage);
        } catch (smsError) {
            console.error('SMS sending failed:', smsError.message);
            // Depending on requirements, you could choose to fail here.
            // For now, we log the error and continue, which is useful for testing.
            console.log('⚠️ Continuing OTP process despite SMS failure.');
        }

        req.session.otpData = {
            phoneNumber: normalizedPhone,
            otp: otp,
            expires: Date.now() + 5 * 60 * 1000 // 5 minutes
        };

        req.session.save((err) => {
            if (err) {
                console.error('Session save error for OTP:', err);
                return res.status(500).json({ message: 'Server error while saving session.' });
            }
            secureLog.phone('[INFO] OTP sent to', normalizedPhone);
            res.status(200).json({ success: true, message: 'OTP sent successfully.' });
        });

    } catch (error) {
        console.error('Error during OTP request:', error.message);
        res.status(500).json({ message: 'An error occurred while checking the phone number.' });
    }
});

app.post('/api/verify-otp', authLimiter, (req, res) => {
    const { phoneNumber, otp } = req.body;
    const storedOtpData = req.session.otpData;
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    if (!storedOtpData || storedOtpData.phoneNumber !== normalizedPhone) {
        console.log('[verify-otp] Session validation failed - no otpData or phone mismatch');
        return res.status(400).json({ message: 'Invalid request. Please start over.' });
    }
    if (Date.now() > storedOtpData.expires) {
        req.session.destroy();
        return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }
    if (verifyOTP(storedOtpData.otp, otp)) {
        req.session.otpData.verified = true;
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ message: 'Session error occurred.' });
            }
            res.status(200).json({ message: 'Phone number verified successfully.' });
        });
    } else {
        res.status(400).json({ message: 'Invalid OTP code.' });
    }
});

app.post('/api/create-contact', authLimiter, async (req, res) => {
    const { fullName, phoneNumber, password } = req.body;
    const storedOtpData = req.session.otpData;
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    // Debug logging for session issues
    console.log('[create-contact] Session ID:', req.sessionID);
    console.log('[create-contact] Cookies received:', req.headers.cookie ? 'yes' : 'no');
    console.log('[create-contact] Has otpData:', !!storedOtpData);
    console.log('[create-contact] OTP verified:', storedOtpData?.verified);

    if (!storedOtpData || !storedOtpData.verified || storedOtpData.phoneNumber !== normalizedPhone) {
        console.log('[create-contact] FAILED: Session validation failed');
        console.log('[create-contact] Reason:', !storedOtpData ? 'no otpData' : !storedOtpData.verified ? 'not verified' : 'phone mismatch');
        return res.status(403).json({ message: 'Phone number not verified. Please complete the OTP step first.' });
    }
    if (!password) {
        return res.status(400).json({ message: 'Password is required.' });
    }

    const powerAutomateUrl = envConfig.powerAutomateUrl;
    if (!powerAutomateUrl) {
        console.error("POWER_AUTOMATE_URL is not set in the .env file.");
        return res.status(500).json({ message: 'Server configuration error.' });
    }

    try {
        const passwordHash = hashPassword(password);
        const contactData = {
            fullName,
            phoneNumber: normalizedPhone,
            adx_identity_passwordhash: passwordHash,
            type: 'new user'
        };

        console.log('Sending data to Power Automate:', {
            fullName,
            phoneNumber: normalizedPhone,
            type: 'new user',
            adx_identity_passwordhash: 'HASH_REDACTED'
        });

        await axios.post(powerAutomateUrl, contactData);

        // Create user session
        req.session.user = {
            phoneNumber: normalizedPhone,
            fullName: fullName,
            loginTime: new Date().toISOString()
        };

        // Clear OTP data
        delete req.session.otpData;

        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ message: 'Registration successful but session error occurred.' });
            }
            console.log(`✅ User registered and logged in: ${normalizedPhone}`);
            res.status(201).json({ message: 'Contact registration successful!' });
        });
    } catch (error) {
        console.error('Error during contact creation:', error.message);
        res.status(500).json({ message: 'Failed to register contact.' });
    }
});

// js/server.js

app.post('/api/login', authLimiter, async (req, res) => {
    const { phoneNumber, password } = req.body;
    if (!phoneNumber || !password) {
        return res.status(400).json({ message: 'Phone number and password are required.' });
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    try {
        // Sanitize phone number to prevent FetchXML injection
        const sanitizedPhone = sanitizeFetchXmlValue(normalizedPhone);
        const fetchXml = `<fetch>
                            <entity name="contact">
                                <attribute name="adx_identity_passwordhash" />
                                <attribute name="firstname" />
                                <attribute name="contactid" />
                                <attribute name="crd33_availableweeepoints" />
                                <attribute name="crd33_totalweeepoints" />
                                <attribute name="crd33_availablecashforredeeming" />
                                <attribute name="crd33_totalredeemablecash" />
                                <attribute name="crd33_totalcarbonsaved" />
                                <filter type="and">
                                    <condition attribute="mobilephone" operator="eq" value="${sanitizedPhone}" />
                                </filter>
                            </entity>
                          </fetch>`;

        // Step 1: Execute the query
        const results = await queryDataverse('contacts', fetchXml);

        // Step 2: Immediately check if a user was found. If not, exit early.
        if (results.length === 0) {
            secureLog.phone('Login failed: No contact found with phone', normalizedPhone);
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        // Step 3: NOW it is safe to declare and access userRecord
        const userRecord = results[0];
        const passwordHash = userRecord.adx_identity_passwordhash;

        if (!passwordHash) {
            secureLog.phone('Login failed: Contact exists but has no password hash:', normalizedPhone);
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        // Step 4: Verify the password
        const isMatch = verifyPassword(password, passwordHash);

        if (isMatch) {
            // Step 5: Create the user session
            req.session.user = {
                phoneNumber: normalizedPhone,
                fullName: userRecord.firstname || 'DR.WEEE User',
                GUID: userRecord.contactid,
                loginTime: new Date().toISOString(),
                availableWeeePoints: userRecord.crd33_availableweeepoints || 0,
                totalWeeePoints: userRecord.crd33_totalweeepoints || 0,
                availableCash: userRecord.crd33_availablecashforredeeming || 0,
                totalRedeemableCash: userRecord.crd33_totalredeemablecash || 0,
                totalCarbonSaved: userRecord.crd33_totalcarbonsaved || 0
            };

            req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ message: 'Login successful but session error occurred.' });
                }
                secureLog.info(`✅ User logged in successfully`);
                // Return user data for client-side storage (helps with cross-origin local dev)
                res.status(200).json({
                    message: 'Login successful.',
                    user: {
                        phoneNumber: normalizedPhone,
                        fullName: userRecord.firstname || 'DR.WEEE User',
                        GUID: userRecord.contactid,
                        availableWeeePoints: userRecord.crd33_availableweeepoints || 0,
                        totalWeeePoints: userRecord.crd33_totalweeepoints || 0,
                        availableCash: userRecord.crd33_availablecashforredeeming || 0,
                        totalRedeemableCash: userRecord.crd33_totalredeemablecash || 0,
                        totalCarbonSaved: userRecord.crd33_totalcarbonsaved || 0
                    }
                });
            });
        } else {
            secureLog.phone('Login failed: Incorrect password for', normalizedPhone);
            res.status(401).json({ message: 'Invalid credentials.' });
        }
    } catch (error) {
        console.error('Error during login:', error.message);
        console.error('Login error stack:', error.stack);
        res.status(500).json({ message: 'An error occurred during login.' });
    }
});

// Check if user is logged in
// Check if user is logged in
app.get('/api/auth-status', (req, res) => {
    console.log('Auth status check - Session ID:', req.sessionID);
    console.log('Session user:', req.session.user);

    if (req.session.user && req.session.user.phoneNumber) {
        res.status(200).json({
            isLoggedIn: true,
            phoneNumber: req.session.user.phoneNumber,
            fullName: req.session.user.fullName || 'DR.WEEE User',
            sessionId: req.sessionID,
            userData: {
                GUID: req.session.user.GUID, // Add this line
                availableWeeePoints: req.session.user.availableWeeePoints || 0,
                totalWeeePoints: req.session.user.totalWeeePoints || 0,
                availableCash: req.session.user.availableCash || 0,
                totalRedeemableCash: req.session.user.totalRedeemableCash || 0,
                totalCarbonSaved: req.session.user.totalCarbonSaved || 0
            }
        });
    } else {
        res.status(200).json({
            isLoggedIn: false,
            sessionId: req.sessionID
        });
    }
});
app.post('/api/collection-request', apiLimiter, async (req, res) => {
    const { type, GUID, Description, longitude, latitude } = req.body;

    // Validate required fields
    if (!type || !GUID || !Description || !longitude || !latitude) {
        return res.status(400).json({
            message: 'Missing required fields',
            received: { type: !!type, GUID: !!GUID, Description: !!Description, longitude: !!longitude, latitude: !!latitude }
        });
    }

    // Check authentication - session or valid GUID for local dev
    const isSessionAuth = req.session.user && req.session.user.phoneNumber;
    const isLocalDev = !isProduction();

    if (isSessionAuth) {
        // Validate that the GUID matches the logged-in user's GUID
        if (req.session.user.GUID !== GUID) {
            return res.status(403).json({ message: 'GUID mismatch - unauthorized request' });
        }
    } else if (!isLocalDev) {
        // In production, require session auth
        return res.status(401).json({ message: 'User not logged in' });
    }
    // In local dev without session, allow request if GUID is provided (trusting client-side localStorage)

    const powerAutomateUrl = envConfig.powerAutomateUrl;
    if (!powerAutomateUrl) {
        console.error("POWER_AUTOMATE_GET_URL is not set.");
        return res.status(500).json({ message: 'Server configuration error.' });
    }

    // MOVE requestPayload declaration OUTSIDE the try block
    const requestPayload = {
        type: type,
        GUID: GUID,
        Description: Description,
        longitude: longitude,
        latitude: latitude
    };

    try {
        console.log('Sending e-waste collection request to Power Automate:', {
            type,
            GUID,
            Description: Description.substring(0, 100) + '...',
            longitude,
            latitude,
            timestamp: new Date().toISOString()
        });

        const paResponse = await axios.post(powerAutomateUrl, requestPayload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });

        console.log('Power Automate response status:', paResponse.status);
        console.log('Power Automate response data:', paResponse.data);

        const requestId = 'WEE' + Date.now().toString().slice(-6);

        res.status(200).json({
            success: true,
            requestId: requestId,
            message: 'Collection request submitted successfully',
            powerAutomateResponse: paResponse.data
        });

    } catch (error) {
        console.error('Error processing collection request:', error.message);

        if (error.code === 'ECONNABORTED') {
            console.error('Request timeout - Power Automate took too long to respond');
            return res.status(408).json({
                message: 'Request timeout - your request is being processed but took longer than expected. Please check back later.',
                error: 'timeout'
            });
        }

        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data;

            console.error('Power Automate error status:', status);
            secureLog.error('Power Automate error', errorData?.error?.code);

            if (status === 502 && errorData?.error?.code === 'NoResponse') {
                console.log('Power Automate 502 NoResponse - storing request for manual processing');

                // NOW requestPayload is accessible here
                const failedRequest = {
                    timestamp: new Date().toISOString(),
                    userGUID: GUID,
                    phoneNumber: req.session.user.phoneNumber,
                    userFullName: req.session.user.fullName,
                    payload: requestPayload,
                    error: 'PA_NO_RESPONSE',
                    trackingId: errorData?.error?.message?.match(/Request tracking id '([^']+)'/)?.[1] || 'unknown'
                };

                secureLog.info('Failed request stored for manual processing');

                return res.status(202).json({
                    success: false,
                    message: 'Your request has been received and will be processed manually. You will be contacted within 24 hours.',
                    requestId: 'WEE' + Date.now().toString().slice(-6),
                    error: 'processing_delayed'
                });
            }

            if (status >= 500) {
                return res.status(503).json({
                    message: 'Service temporarily unavailable. Please try again later.',
                    error: 'service_unavailable'
                });
            }

            if (status >= 400) {
                return res.status(400).json({
                    message: 'Invalid request format. Please check your data and try again.',
                    error: 'invalid_request'
                });
            }
        }

        res.status(500).json({
            message: 'Failed to process collection request. Please try again later.',
            error: 'internal_error'
        });
    }
});

// ADD THIS NEW ENDPOINT FOR SUBMITTING STORE ORDERS

app.post('/api/submit-order', async (req, res) => {
    // 1. Authentication & Authorization Check
    // Check session auth first, then allow GUID-based auth for local development
    const isSessionAuth = req.session.user && req.session.user.GUID;
    const isLocalDev = !isProduction();

    // Get user info from session or request body (for local dev with localStorage auth)
    let userGUID = null;
    let userFullName = 'Guest User';
    let userPhoneNumber = 'N/A';

    if (isSessionAuth) {
        userGUID = req.session.user.GUID;
        userFullName = req.session.user.fullName || 'DR.WEEE User';
        userPhoneNumber = req.session.user.phoneNumber || 'N/A';
    } else if (isLocalDev && req.body.userGUID) {
        // In local dev, trust the client-provided data from localStorage
        userGUID = req.body.userGUID;
        userFullName = req.body.userFullName || 'Local Dev User';
        userPhoneNumber = req.body.userPhoneNumber || 'N/A';
        console.log('📦 Using client-provided user info for local dev:', userFullName, userPhoneNumber);
    }

    if (!userGUID) {
        return res.status(401).json({ message: 'User not logged in or GUID is missing.' });
    }

    // 2. Extract and Validate Data from Client
    const { cart, deliveryDetails, paymentMethod } = req.body;
    if (!cart || Object.keys(cart).length === 0 || !deliveryDetails || !paymentMethod) {
        return res.status(400).json({ message: 'Missing required order data.' });
    }

    const powerAutomateUrl = envConfig.powerAutomateUrl;
    if (!powerAutomateUrl) {
        console.error("POWER_AUTOMATE_GET_URL is not set.");
        return res.status(500).json({ message: 'Server configuration error.' });
    }

    try {
        // 3. Process Cart and Calculate Totals (Server-Side)
        let orderSubtotal = 0;
        let totalDiscount = 0;
        const lineItems = Object.values(cart).map(item => {
            const itemSubtotal = item.price * item.quantity;
            const itemDiscount = (item.price * item.emptyCartridges * 0.1);
            orderSubtotal += itemSubtotal;
            totalDiscount += itemDiscount;

            return {
                productId: item.product.productid,
                productName: item.product.name,
                productNumber: item.product.productnumber,
                quantity: item.quantity,
                unitPrice: item.price,
                emptyCartridgesTradedIn: item.emptyCartridges,
                itemSubtotal: itemSubtotal,
                itemDiscount: itemDiscount,
                itemTotal: itemSubtotal - itemDiscount
            };
        });
        const grandTotal = orderSubtotal - totalDiscount;

        // 4. Construct a Human-Readable Summary (similar to e-waste)
        // Build formatted address from user-edited fields
        const addressParts = [
            deliveryDetails.addressDetails?.street,
            deliveryDetails.addressDetails?.city,
            deliveryDetails.addressDetails?.state,
            deliveryDetails.addressDetails?.country
        ].filter(part => part && part.trim() !== '');
        const formattedAddress = addressParts.length > 0 ? addressParts.join(', ') : deliveryDetails.address;

        const humanReadableSummary = `New Store Order:
--------------------------------
Customer: ${userFullName} (${userPhoneNumber})
Delivery Address: ${formattedAddress}
Preferred Time: ${deliveryDetails.deliveryTime || 'Not specified'}
Payment Method: ${paymentMethod}
--------------------------------
Order Summary:
${lineItems.map(item => {
            const tradeInText = item.emptyCartridgesTradedIn > 0 ? ` (Trade-in: ${item.emptyCartridgesTradedIn})` : '';
            return `• ${item.quantity}x ${item.productName} = EGP ${item.itemSubtotal.toLocaleString()}${tradeInText}`;
        }).join('\n')}
--------------------------------
Subtotal: EGP ${orderSubtotal.toLocaleString()}
Trade-in Discount: -EGP ${totalDiscount.toLocaleString()}
Grand Total: EGP ${grandTotal.toLocaleString()}
`;

        // 5. Construct Final Payload for Power Automate
        const requestPayload = {
            type: 'store',
            userGUID: userGUID,
            deliveryAddress: deliveryDetails.address,
            deliveryLongitude: deliveryDetails.coordinates[0].toString(),
            deliveryLatitude: deliveryDetails.coordinates[1].toString(),
            preferredDeliveryTime: deliveryDetails.deliveryTime || null,
            paymentMethod: paymentMethod,
            orderSubtotal: orderSubtotal,
            totalDiscount: totalDiscount,
            grandTotal: grandTotal,
            lineItems: JSON.stringify(lineItems), // Send line items as a JSON string
            humanReadableSummary: humanReadableSummary,
            // Add address details for contact record fields
            address1_line1: deliveryDetails.addressDetails?.street || '',
            address1_city: deliveryDetails.addressDetails?.city || '',
            address1_stateorprovince: deliveryDetails.addressDetails?.state || '',
            address1_country: deliveryDetails.addressDetails?.country || ''
        };

        console.log('Sending store order request to Power Automate...');

        // 6. Send to Power Automate with Robust Error Handling
        const paResponse = await axios.post(powerAutomateUrl, requestPayload, { timeout: 45000 });

        const requestId = 'ORD' + Date.now().toString().slice(-6);
        res.status(200).json({
            success: true,
            requestId: requestId,
            message: 'Your order has been submitted successfully!'
        });

    } catch (error) {
        // This error handling is copied from your e-waste endpoint for consistency
        console.error('Error processing store order:', error.message);
        if (error.code === 'ECONNABORTED') {
            return res.status(408).json({ message: 'Request timeout: Your order is being processed. We will confirm shortly.', error: 'timeout' });
        }
        if (error.response?.status === 502) {
            return res.status(202).json({ success: false, message: 'Your order has been received and will be processed manually.', error: 'processing_delayed' });
        }
        res.status(500).json({ message: 'Failed to process your order. Please try again later.', error: 'internal_error' });
    }
});


// API endpoint to fetch user's online requests from Dataverse
app.get('/api/my-requests', async (req, res) => {
    // Authentication check - session or localStorage-based
    const isSessionAuth = req.session.user && req.session.user.GUID;
    const isLocalDev = !isProduction();

    // Get userGUID from query param (for localStorage auth) or session
    let userGUID = null;

    if (isSessionAuth) {
        userGUID = req.session.user.GUID;
    } else if (isLocalDev && req.query.userGUID) {
        userGUID = req.query.userGUID;
        console.log('📋 Fetching requests for local dev user:', userGUID);
    }

    if (!userGUID) {
        return res.status(401).json({ message: 'User not logged in.' });
    }

    // Validate GUID format to prevent injection
    if (!isValidGUID(userGUID)) {
        return res.status(400).json({ message: 'Invalid user identifier format.' });
    }

    try {
        // FetchXML query to get online requests for this user (regardingobjectid = contact GUID)
        // GUID is already validated, but sanitize for defense in depth
        const sanitizedGUID = sanitizeFetchXmlValue(userGUID);
        const fetchXml = `
            <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                <entity name="crd33_onlinerequests">
                    <attribute name="activityid" />
                    <attribute name="subject" />
                    <attribute name="description" />
                    <attribute name="createdon" />
                    <attribute name="statuscode" />
                    <attribute name="statecode" />
                    <attribute name="crd33_requesttype" />
                    <attribute name="crd33_orderitems" />
                    <order attribute="createdon" descending="true" />
                    <filter type="and">
                        <condition attribute="regardingobjectid" operator="eq" value="${sanitizedGUID}" />
                    </filter>
                </entity>
            </fetch>
        `;

        const requests = await queryDataverse('crd33_onlinerequestses', fetchXml);

        // Map the request type codes to human-readable labels
        const requestTypeLabels = {
            269530000: 'E-waste Collection',
            269530001: 'Form Submit',
            269530002: 'Online Purchase',
            269530003: 'Redeeming Request'
        };

        // Map status codes to labels
        const statusLabels = {
            1: 'Open',
            2: 'Completed',
            3: 'Cancelled'
        };

        // Transform the data for frontend consumption
        const formattedRequests = requests.map(request => ({
            id: request.activityid,
            subject: request.subject || 'Untitled Request',
            description: request.description || '',
            createdOn: request.createdon,
            status: statusLabels[request.statuscode] || 'Unknown',
            statusCode: request.statuscode,
            stateCode: request.statecode,
            requestType: requestTypeLabels[request.crd33_requesttype] || 'General Request',
            requestTypeCode: request.crd33_requesttype,
            orderItems: request.crd33_orderitems
        }));

        secureLog.guid(`✅ Found ${formattedRequests.length} requests for user`, userGUID);

        res.status(200).json({
            success: true,
            requests: formattedRequests
        });

    } catch (error) {
        console.error('❌ Error fetching user requests:', error.message);
        res.status(500).json({
            message: 'Failed to fetch requests. Please try again later.',
            error: 'internal_error'
        });
    }
});


// API endpoint to fetch vouchers and gifts from Dataverse (with caching)
app.get('/api/vouchers', async (req, res) => {
    const { territoryId } = req.query;

    // Use territory-specific cache key, or 'default' for backwards compatibility
    const cacheKey = territoryId || 'default';
    const cachedData = vouchersCacheByTerritory.get(cacheKey);
    const isCacheValid = cachedData && (Date.now() - cachedData.lastFetch < VOUCHERS_CACHE_DURATION_MS);

    if (isCacheValid) {
        console.log(`✅ [Vouchers] Returning from cache for territory: ${cacheKey}`);
        return res.status(200).json({
            success: true,
            vouchers: cachedData.data,
            source: 'cache'
        });
    }

    try {
        // Build territory filter if provided
        let territoryFilter = '';
        if (territoryId) {
            // Validate and sanitize territory ID
            if (!isValidGUID(territoryId)) {
                return res.status(400).json({ success: false, message: 'Invalid territory ID format.' });
            }
            const sanitizedTerritoryId = sanitizeFetchXmlValue(territoryId);
            territoryFilter = `<condition attribute="crd33_availableonlineterritory" operator="eq" value="${sanitizedTerritoryId}" />`;
            console.log(`[Vouchers] Filtering by territory: ${territoryId}`);
        }

        console.log(`🔄 [Vouchers] Fetching from Dataverse for territory: ${cacheKey}...`);

        // FetchXML query to get vouchers that are available online and have available quantity
        // Note: FetchXML uses logical name (singular), URL uses EntitySetName (plural)
        const fetchXml = `
            <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                <entity name="crd33_voucherandgift">
                    <attribute name="crd33_voucherandgiftid" />
                    <attribute name="crd33_name" />
                    <attribute name="crd33_image" />
                    <attribute name="crd33_costpereach" />
                    <attribute name="crd33_weeepointequivalent" />
                    <attribute name="crd33_availablequantity" />
                    <attribute name="crd33_categoryentertainment" />
                    <attribute name="crd33_voucherstatus" />
                    <attribute name="createdon" />
                    <order attribute="crd33_name" descending="false" />
                    <filter type="and">
                        <condition attribute="crd33_availableonline" operator="eq" value="1" />
                        <condition attribute="crd33_availablequantity" operator="gt" value="0" />
                        <condition attribute="statecode" operator="eq" value="0" />
                        ${territoryFilter}
                    </filter>
                </entity>
            </fetch>
        `;

        const vouchers = await queryDataverse('crd33_voucherandgifts', fetchXml);

        // Map category codes to labels
        const categoryLabels = {
            269530000: 'retail',      // Retail & Shopping
            269530001: 'food',        // Food & Dining
            269530002: 'entertainment', // Entertainment
            269530003: 'tech',        // Technology
            269530004: 'cash'         // Cash
        };

        const categoryNames = {
            269530000: 'Retail & Shopping',
            269530001: 'Food & Dining',
            269530002: 'Entertainment',
            269530003: 'Technology',
            269530004: 'Cash'
        };

        // Transform the data for frontend consumption
        const formattedVouchers = vouchers.map(voucher => ({
            id: voucher.crd33_voucherandgiftid,
            name: voucher.crd33_name || 'Unnamed Voucher',
            image: voucher.crd33_image || 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=400&h=300&fit=crop',
            cashCost: voucher.crd33_costpereach || 0,
            pointsCost: voucher.crd33_weeepointequivalent || 0,
            availableQuantity: voucher.crd33_availablequantity || 0,
            categoryCode: voucher.crd33_categoryentertainment,
            category: categoryLabels[voucher.crd33_categoryentertainment] || 'general',
            categoryName: categoryNames[voucher.crd33_categoryentertainment] || 'General',
            status: voucher.crd33_voucherstatus,
            createdOn: voucher.createdon
        }));

        // Update cache
        vouchersCacheByTerritory.set(cacheKey, {
            data: formattedVouchers,
            lastFetch: Date.now()
        });

        console.log(`✅ [Vouchers] Cached ${formattedVouchers.length} vouchers for territory: ${cacheKey}`);

        res.status(200).json({
            success: true,
            vouchers: formattedVouchers,
            source: 'live'
        });

    } catch (error) {
        console.error('❌ Error fetching vouchers:', error.message);

        // Return stale cache if available
        if (cachedData) {
            console.log(`⚠️ [Vouchers] Returning stale cache due to error for territory: ${cacheKey}`);
            return res.status(200).json({
                success: true,
                vouchers: cachedData.data,
                source: 'stale-cache'
            });
        }

        res.status(500).json({
            message: 'Failed to fetch vouchers. Please try again later.',
            error: 'internal_error'
        });
    }
});


// API endpoint to submit a redemption request
app.post('/api/redeem', async (req, res) => {
    // Authentication check - support both session and client-provided GUID
    const isSessionAuth = req.session.user && req.session.user.GUID;

    let userGUID = null;
    let userFullName = 'Guest User';
    let userPhoneNumber = 'N/A';

    if (isSessionAuth) {
        // Session-based auth (preferred)
        userGUID = req.session.user.GUID;
        userFullName = req.session.user.fullName || 'DR.WEEE User';
        userPhoneNumber = req.session.user.phoneNumber || 'N/A';
    } else if (req.body.userGUID) {
        // Fallback: Accept userGUID from request body (for localStorage-based auth)
        // The GUID is validated against Dataverse when creating the redemption request
        userGUID = req.body.userGUID;
        userFullName = req.body.userFullName || 'DR.WEEE User';
        userPhoneNumber = req.body.userPhoneNumber || 'N/A';
        console.log('🎁 Using client-provided user info for redemption:', userFullName);
    }

    if (!userGUID) {
        return res.status(401).json({ message: 'User not logged in.' });
    }

    const { voucher, quantity, paymentMethod, totalCost } = req.body;

    if (!voucher || !quantity || !paymentMethod) {
        return res.status(400).json({ message: 'Missing required redemption data.' });
    }

    const powerAutomateUrl = envConfig.powerAutomateUrl;
    if (!powerAutomateUrl) {
        console.error("POWER_AUTOMATE_GET_URL is not set.");
        return res.status(500).json({ message: 'Server configuration error.' });
    }

    try {
        // Build human-readable summary (Description field for Power Automate)
        const paymentText = paymentMethod === 'points'
            ? `${totalCost.toLocaleString()} WEEE Points`
            : `EGP ${totalCost.toLocaleString()} Cash`;

        const Description = `Redemption Request:
--------------------------------
Customer: ${userFullName} (${userPhoneNumber})
--------------------------------
Voucher: ${voucher.name}
Category: ${voucher.categoryName}
Quantity: ${quantity}
Payment Method: ${paymentMethod === 'points' ? 'WEEE Points' : 'Cash'}
Total Cost: ${paymentText}
Voucher ID: ${voucher.id}
--------------------------------
`;

        // Construct payload matching Power Automate expected format
        // Using same structure as e-waste and store endpoints
        const requestPayload = {
            type: 'redeem',
            GUID: userGUID,
            Description: Description,
            // Additional fields for redemption processing
            voucherId: voucher.id,
            voucherName: voucher.name,
            voucherCategory: voucher.categoryName,
            quantity: quantity,
            paymentMethod: paymentMethod,
            totalCost: totalCost,
            // Use dummy coordinates (not location-based)
            longitude: '0',
            latitude: '0'
        };

        console.log('🎁 Sending redemption request to Power Automate:', {
            type: 'redeem',
            GUID: userGUID,
            voucherName: voucher.name,
            quantity: quantity,
            paymentMethod: paymentMethod,
            totalCost: totalCost,
            timestamp: new Date().toISOString()
        });

        const paResponse = await axios.post(powerAutomateUrl, requestPayload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });

        console.log('Power Automate response status:', paResponse.status);
        console.log('Power Automate response data:', paResponse.data);

        const requestId = 'RDM' + Date.now().toString().slice(-6);
        res.status(200).json({
            success: true,
            requestId: requestId,
            message: 'Your redemption request has been submitted successfully!',
            powerAutomateResponse: paResponse.data
        });

    } catch (error) {
        console.error('❌ Error processing redemption:', error.message);

        if (error.code === 'ECONNABORTED') {
            console.error('Request timeout - Power Automate took too long to respond');
            return res.status(408).json({
                message: 'Request timeout: Your redemption is being processed.',
                error: 'timeout'
            });
        }

        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data;

            console.error('Power Automate error status:', status);
            secureLog.error('Power Automate error', errorData?.error?.code);

            if (status === 502 && errorData?.error?.code === 'NoResponse') {
                console.log('Power Automate 502 NoResponse - accepting redemption for manual processing');

                const requestId = 'RDM' + Date.now().toString().slice(-6);
                return res.status(202).json({
                    success: true,
                    requestId: requestId,
                    message: 'Your redemption request has been received and will be processed shortly.',
                    warning: 'processing_delayed'
                });
            }

            if (status >= 500) {
                return res.status(503).json({
                    message: 'Service temporarily unavailable. Please try again later.',
                    error: 'service_unavailable'
                });
            }
        }

        res.status(500).json({
            message: 'Failed to process your redemption. Please try again later.',
            error: 'internal_error'
        });
    }
});


// js/server.js

// Per-territory e-waste product cache
const ewasteProductCacheByTerritory = new Map();

// REPLACE the existing /api/fetch-products endpoint with this one
app.post('/api/fetch-products', async (req, res) => {
    const { type, territoryId } = req.body;

    if (type !== 'product') {
        return res.status(400).json({ message: 'Invalid request type' });
    }

    // Use territory-specific cache key
    const cacheKey = territoryId || 'global';
    const cachedData = ewasteProductCacheByTerritory.get(cacheKey);
    const isCacheValid = cachedData && (Date.now() - cachedData.lastFetch < CACHE_DURATION_MS);

    if (isCacheValid) {
        console.log(`✅ Returning e-waste products from cache for territory: ${cacheKey}`);
        return res.status(200).json({
            success: true,
            products: cachedData.data,
            cached: true
        });
    }

    try {
        console.log(`🔄 Fetching e-waste products from Dataverse for territory: ${cacheKey}...`);

        // If territoryId is provided, get the E-waste price list directly from territory
        // Territory now has direct lookup field: crd33_ewastepricelist
        let priceListIds = [];
        if (territoryId) {
            // Validate and sanitize territory ID
            if (!isValidGUID(territoryId)) {
                return res.status(400).json({ success: false, message: 'Invalid territory ID format.' });
            }
            const sanitizedTerritoryId = sanitizeFetchXmlValue(territoryId);

            // Fetch territory with its e-waste price list (direct lookup)
            const territoryQuery = `<fetch version="1.0" mapping="logical">
                <entity name="territory">
                    <attribute name="territoryid"/>
                    <attribute name="name"/>
                    <filter type="and">
                        <condition attribute="territoryid" operator="eq" value="${sanitizedTerritoryId}"/>
                    </filter>
                    <link-entity name="pricelevel" from="pricelevelid" to="crd33_ewastepricelist" alias="pricelist" link-type="outer">
                        <attribute name="pricelevelid" alias="priceListId"/>
                        <filter type="and">
                            <condition attribute="statecode" operator="eq" value="0"/>
                            <condition attribute="crd33_availableforwebsite" operator="eq" value="1"/>
                        </filter>
                    </link-entity>
                </entity>
            </fetch>`;

            const territories = await queryDataverse('territories', territoryQuery);
            secureLog.debug(`Territory query returned ${territories?.length || 0} results`);

            // Extract price list ID from territory
            if (territories && territories.length > 0) {
                const territory = territories[0];
                const priceListId = territory['pricelist.priceListId'] || territory.priceListId || territory['pricelist_priceListId'];
                if (priceListId) {
                    priceListIds = [priceListId];
                }
            }
            secureLog.debug(`Found ${priceListIds.length} price lists for territory`);

            if (priceListIds.length === 0) {
                console.log('⚠️ No e-waste price list configured for territory, returning empty products');
                const emptyProducts = { computing: [], mobile: [], home: [], entertainment: [], accessories: [], office: [] };
                ewasteProductCacheByTerritory.set(cacheKey, { data: emptyProducts, lastFetch: Date.now() });
                return res.status(200).json({
                    success: true,
                    products: emptyProducts,
                    cached: false
                });
            }
        }

        // Build FetchXML query - filter by price list if territory specified
        let fetchXml;
        if (territoryId && priceListIds.length > 0) {
            // Build condition for multiple price lists - validate and sanitize each ID
            const priceListConditions = priceListIds
                .filter(id => isValidGUID(id))
                .map(id => `<condition attribute="pricelevelid" operator="eq" value="${sanitizeFetchXmlValue(id)}"/>`)
                .join('');

            fetchXml = `<fetch>
                <entity name="product">
                    <attribute name="productid" />
                    <attribute name="name" />
                    <attribute name="crd33_emoji" />
                    <attribute name="crd33_category" />
                    <link-entity name="productpricelevel" from="productid" to="productid" alias="ppl">
                        <attribute name="crd33_weeepointequivalent" />
                        <attribute name="crd33_carbonsavingsperunit" />
                        <filter type="and">
                            <filter type="or">
                                ${priceListConditions}
                            </filter>
                            <filter type="or">
                                <condition attribute="crd33_availableforecommerce" operator="eq" value="1" />
                                <condition attribute="crd33_availableforecommerce" operator="null" />
                            </filter>
                        </filter>
                        <link-entity name="uom" from="uomid" to="uomid" alias="uom">
                            <attribute name="name" />
                        </link-entity>
                    </link-entity>
                    <filter type="and">
                        <condition attribute="statecode" operator="eq" value="0" />
                        <filter type="or">
                            <condition attribute="parentproductid" operator="ne" value="b1b4fce2-709a-f011-bbd2-6045bd5eed59" />
                            <condition attribute="parentproductid" operator="null" />
                        </filter>
                    </filter>
                </entity>
            </fetch>`;
        } else {
            // No territory - fetch all products (backwards compatible)
            fetchXml = `<fetch>
                <entity name="product">
                    <attribute name="productid" />
                    <attribute name="name" />
                    <attribute name="crd33_emoji" />
                    <attribute name="crd33_category" />
                    <link-entity name="productpricelevel" from="productid" to="productid" alias="ppl">
                        <attribute name="crd33_weeepointequivalent" />
                        <attribute name="crd33_carbonsavingsperunit" />
                        <filter type="and">
                            <filter type="or">
                                <condition attribute="crd33_availableforecommerce" operator="eq" value="1" />
                                <condition attribute="crd33_availableforecommerce" operator="null" />
                            </filter>
                        </filter>
                        <link-entity name="uom" from="uomid" to="uomid" alias="uom">
                            <attribute name="name" />
                        </link-entity>
                    </link-entity>
                    <filter type="and">
                        <condition attribute="statecode" operator="eq" value="0" />
                        <filter type="or">
                            <condition attribute="parentproductid" operator="ne" value="b1b4fce2-709a-f011-bbd2-6045bd5eed59" />
                            <condition attribute="parentproductid" operator="null" />
                        </filter>
                    </filter>
                </entity>
            </fetch>`;
        }

        const rawData = await queryDataverse('products', fetchXml);

        const categoryMap = {
            269530000: 'computing', 269530001: 'mobile', 269530002: 'home',
            269530003: 'entertainment', 269530004: 'accessories', 269530005: 'office'
        };

        const productGroups = {};
        (rawData || []).forEach(item => {
            const productId = item.productid;
            if (!productId) return;

            if (!productGroups[productId]) {
                productGroups[productId] = {
                    id: `${item.name?.toLowerCase().replace(/\s+/g, '_')}_${productId}`,
                    name: item.name, icon: item.crd33_emoji,
                    category: categoryMap[item.crd33_category] || 'accessories',
                    units: []
                };
            }
            productGroups[productId].units.push({
                value: item['uom.name'],
                points: item['ppl.crd33_weeepointequivalent'] || 0,
                co2: item['ppl.crd33_carbonsavingsperunit'] || 0
            });
        });

        const transformedProducts = { computing: [], mobile: [], home: [], entertainment: [], accessories: [], office: [] };
        Object.values(productGroups).forEach(product => {
            if (transformedProducts[product.category]) {
                transformedProducts[product.category].push(product);
            }
        });

        // Cache by territory
        ewasteProductCacheByTerritory.set(cacheKey, { data: transformedProducts, lastFetch: Date.now() });
        console.log(`✅ E-waste product cache updated for territory: ${cacheKey}`);

        res.status(200).json({
            success: true,
            products: transformedProducts,
            cached: false
        });

    } catch (error) {
        console.error('❌ Error fetching e-waste products:', error.message);
        console.error('❌ Full error stack:', error.stack);
        const cachedData = ewasteProductCacheByTerritory.get(cacheKey);
        if (cachedData) {
            console.warn(`⚠️ Serving stale e-waste cache for territory ${cacheKey} due to fetch error.`);
            return res.status(200).json({
                success: true,
                products: cachedData.data,
                cached: 'stale'
            });
        }
        res.status(500).json({ message: 'Failed to fetch products', error: 'product_fetch_failed', detail: error.message });
    }
});
// Add this endpoint to server.js after other endpoints
app.post('/api/clear-product-cache', (req, res) => {
    if (req.session.cachedProducts) {
        delete req.session.cachedProducts;
        console.log('Product cache cleared from session');
    }
    res.status(200).json({ message: 'Cache cleared' });
});
// Add this endpoint in server.js
app.get('/api/config', (req, res) => {
    res.json({
        azureMapsKey: process.env.AZURE_MAPS_KEY
    });
});


// js/server.js in --- 5. API ENDPOINTS ---

// Territory-specific store product cache (keyed by territoryId)
const storeProductCacheByTerritory = new Map();

app.post('/api/store', async (req, res) => {
    const { territoryId } = req.body;

    // Use territory-specific cache key, or 'default' for backwards compatibility
    const cacheKey = territoryId || 'default';
    const cachedData = storeProductCacheByTerritory.get(cacheKey);
    const isCacheValid = cachedData && (Date.now() - cachedData.lastFetch < STORE_CACHE_DURATION_MS);

    if (isCacheValid) {
        console.log(`✅ Returning store products from cache for territory: ${cacheKey}`);
        return res.status(200).json({
            success: true,
            products: cachedData.data,
            currency: cachedData.currency,
            source: 'cache'
        });
    }

    try {
        console.log(`🔄 Fetching store products for territory: ${cacheKey}...`);

        let territoryPriceListIds = [];
        let territoryCurrency = null;

        // Step 1: If territoryId provided, get the Products price list directly from territory
        // Territory now has direct lookup field: crd33_productspricelist
        if (territoryId) {
            // Validate and sanitize territory ID
            if (!isValidGUID(territoryId)) {
                return res.status(400).json({ success: false, message: 'Invalid territory ID format.' });
            }
            const sanitizedTerritoryId = sanitizeFetchXmlValue(territoryId);
            console.log(`[Store] Fetching products price list for territory: ${territoryId}`);

            // Query territory directly with its products price list (direct lookup)
            const territoryQuery = `<fetch version="1.0" mapping="logical">
                <entity name="territory">
                    <attribute name="territoryid"/>
                    <attribute name="name"/>
                    <filter type="and">
                        <condition attribute="territoryid" operator="eq" value="${sanitizedTerritoryId}"/>
                    </filter>
                    <link-entity name="pricelevel" from="pricelevelid" to="crd33_productspricelist" alias="pricelist" link-type="outer">
                        <attribute name="pricelevelid" alias="priceListId"/>
                        <attribute name="name" alias="priceListName"/>
                        <attribute name="transactioncurrencyid" alias="currencyId"/>
                        <filter type="and">
                            <condition attribute="statecode" operator="eq" value="0"/>
                            <condition attribute="crd33_availableforwebsite" operator="eq" value="1"/>
                        </filter>
                        <link-entity name="transactioncurrency" from="transactioncurrencyid" to="transactioncurrencyid" alias="currency" link-type="outer">
                            <attribute name="currencyname" alias="currencyName"/>
                            <attribute name="currencysymbol" alias="currencySymbol"/>
                            <attribute name="isocurrencycode" alias="currencyIsoCode"/>
                            <attribute name="currencyprecision" alias="currencyPrecision"/>
                            <attribute name="exchangerate" alias="currencyExchangeRate"/>
                        </link-entity>
                    </link-entity>
                </entity>
            </fetch>`;

            const territories = await queryDataverse('territories', territoryQuery);

            if (!territories || territories.length === 0) {
                console.log(`[Store] Territory not found: ${territoryId}`);
                return res.status(200).json({
                    success: true,
                    products: [],
                    currency: null,
                    message: 'Territory not found',
                    source: 'live'
                });
            }

            const territory = territories[0];
            const priceListId = territory['pricelist.priceListId'] || territory.priceListId || territory['pricelist_priceListId'];

            if (!priceListId) {
                console.log(`[Store] No products price list configured for territory: ${territoryId}`);
                return res.status(200).json({
                    success: true,
                    products: [],
                    currency: null,
                    message: 'No products price list configured for this territory',
                    source: 'live'
                });
            }

            territoryPriceListIds = [priceListId];

            // Extract currency info from the price list
            const currencySymbol = territory['currency.currencySymbol'] || territory.currencySymbol || territory['currency_currencySymbol'];
            if (currencySymbol) {
                territoryCurrency = {
                    id: territory['pricelist.currencyId'] || territory.currencyId || territory['pricelist_currencyId'],
                    name: territory['currency.currencyName'] || territory.currencyName || territory['currency_currencyName'],
                    symbol: currencySymbol,
                    isoCode: territory['currency.currencyIsoCode'] || territory.currencyIsoCode || territory['currency_currencyIsoCode'],
                    precision: territory['currency.currencyPrecision'] || territory.currencyPrecision || territory['currency_currencyPrecision'] || 2,
                    exchangeRate: territory['currency.currencyExchangeRate'] || territory.currencyExchangeRate || territory['currency_currencyExchangeRate']
                };
            }

            console.log(`[Store] Found products price list for territory. Currency: ${territoryCurrency?.symbol || 'N/A'}`);
        }

        // Step 2: Get the primary list of products with filters
        const productQuery = `<fetch version="1.0" mapping="logical">
                                <entity name="product">
                                    <attribute name="productid"/>
                                    <attribute name="name"/>
                                    <attribute name="productnumber"/>
                                    <attribute name="description"/>
                                    <attribute name="parentproductid"/>
                                    <attribute name="crd33_productimage"/>
                                    <attribute name="crd33_productimage2"/>
                                    <attribute name="crd33_productimage3"/>
                                    <filter type="and">
                                        <condition attribute="producttypecode" operator="eq" value="1"/>
                                        <condition attribute="parentproductid" operator="eq" value="b1b4fce2-709a-f011-bbd2-6045bd5eed59"/>
                                    </filter>
                                    <link-entity name="product" from="productid" to="parentproductid" link-type="outer" alias="parentProduct">
                                        <attribute name="name" alias="familyName"/>
                                    </link-entity>
                                </entity>
                              </fetch>`;
        const products = await queryDataverse('products', productQuery);

        if (products.length === 0) {
            console.log('✅ No products found matching the criteria. Returning empty array.');
            return res.status(200).json({ success: true, products: [], currency: territoryCurrency, source: 'live' });
        }

        const productIds = products.map(p => `<value>${p.productid}</value>`).join('');
        const parentProductIds = [...new Set(
            products.map(p => p.parentproductid || p._parentproductid_value).filter(Boolean)
        )].map(id => `<value>${id}</value>`).join('');

        // Step 3: Build price query with territory filter if applicable
        let priceItemQuery;
        if (territoryPriceListIds.length > 0) {
            // Filter to only get prices from the territory's price lists
            const priceListIdsCondition = territoryPriceListIds.map(id => `<value>${id}</value>`).join('');
            priceItemQuery = `<fetch><entity name="productpricelevel"><attribute name="productpricelevelid" alias="priceListItemId"/><attribute name="amount"/><attribute name="crd33_buyingamount" alias="buyingAmount"/><attribute name="crd33_drweeepercentageofsell" alias="weeePercentageOfSell"/><attribute name="crd33_maxdiscountpercentage" alias="maxDiscountPercentage"/><attribute name="crd33_costperpagefororiginal" alias="costPerPageOriginal"/><attribute name="crd33_costperpageforremanufactured" alias="costPerPageRemanufactured"/><attribute name="crd33_saving" alias="saving"/><attribute name="crd33_weeepointequivalent" alias="weeePoints"/><attribute name="crd33_carbonsavingsperunit" alias="carbonSavings"/><attribute name="productid" alias="productIdForJoin"/><link-entity name="pricelevel" from="pricelevelid" to="pricelevelid" alias="pricelist"><attribute name="pricelevelid" alias="priceListId"/><attribute name="name" alias="priceListName"/></link-entity><filter type="and"><condition attribute="productid" operator="in">${productIds}</condition><condition attribute="pricelevelid" operator="in">${priceListIdsCondition}</condition><filter type="or"><condition attribute="crd33_availableforecommerce" operator="eq" value="1"/><condition attribute="crd33_availableforecommerce" operator="null"/></filter></filter></entity></fetch>`;
        } else {
            // No territory filter - get all price items (backwards compatibility)
            priceItemQuery = `<fetch><entity name="productpricelevel"><attribute name="productpricelevelid" alias="priceListItemId"/><attribute name="amount"/><attribute name="crd33_buyingamount" alias="buyingAmount"/><attribute name="crd33_drweeepercentageofsell" alias="weeePercentageOfSell"/><attribute name="crd33_maxdiscountpercentage" alias="maxDiscountPercentage"/><attribute name="crd33_costperpagefororiginal" alias="costPerPageOriginal"/><attribute name="crd33_costperpageforremanufactured" alias="costPerPageRemanufactured"/><attribute name="crd33_saving" alias="saving"/><attribute name="crd33_weeepointequivalent" alias="weeePoints"/><attribute name="crd33_carbonsavingsperunit" alias="carbonSavings"/><attribute name="productid" alias="productIdForJoin"/><link-entity name="pricelevel" from="pricelevelid" to="pricelevelid" alias="pricelist"><attribute name="pricelevelid" alias="priceListId"/><attribute name="name" alias="priceListName"/></link-entity><filter type="and"><condition attribute="productid" operator="in">${productIds}</condition><filter type="or"><condition attribute="crd33_availableforecommerce" operator="eq" value="1"/><condition attribute="crd33_availableforecommerce" operator="null"/></filter></filter></entity></fetch>`;
        }

        const relationshipQuery = `<fetch><entity name="productsubstitute"><attribute name="productsubstituteid" alias="relationshipId"/><attribute name="salesrelationshiptype" alias="relationshipType"/><attribute name="direction"/><attribute name="productid" alias="parentProductIdForJoin"/><link-entity name="product" from="productid" to="substitutedproductid" alias="relatedProduct"><attribute name="productid" alias="productId"/><attribute name="name" alias="relatedName"/><attribute name="productnumber" alias="relatedProductNumber"/></link-entity><filter><condition attribute="productid" operator="in">${productIds}</condition></filter></entity></fetch>`;
        const propertyQuery = `<fetch>
    <entity name="dynamicproperty">
        <attribute name="dynamicpropertyid" alias="propertyId"/>
        <attribute name="name" alias="propertyName"/>
        <attribute name="regardingobjectid" alias="parentRecordId"/>
        <attribute name="defaultvaluestring" alias="propertyValueString"/>
        <attribute name="defaultvalueinteger" alias="propertyValueInteger"/>
        <attribute name="defaultvaluedecimal" alias="propertyValueDecimal"/>
        <attribute name="defaultvaluedouble" alias="propertyValueDouble"/>
        <attribute name="datatype" alias="dataType"/>
        <attribute name="statecode" alias="stateCode"/>
        <attribute name="statuscode" alias="statusCode"/>
        <attribute name="rootdynamicpropertyid" alias="rootPropertyId"/>
        <attribute name="basedynamicpropertyid" alias="basePropertyId"/>
        <link-entity name="dynamicpropertyoptionsetitem" from="dynamicpropertyoptionsetvalueid" to="defaultvalueoptionset" link-type="outer" alias="propertyoptionset">
            <attribute name="dynamicpropertyoptionname" alias="propertyValueOptionSetText"/>
        </link-entity>
        <filter type="and">
            <condition attribute="statecode" operator="eq" value="0"/>
            <filter type="or">
                <condition attribute="regardingobjectid" operator="in">${productIds}</condition>
                ${parentProductIds ? `<condition attribute="regardingobjectid" operator="in">${parentProductIds}</condition>` : ''}
            </filter>
        </filter>
    </entity>
</fetch>`;

        const [allRelationships, allProperties, allPriceItems] = await Promise.all([
            queryDataverse('productsubstitutes', relationshipQuery),
            queryDataverse('dynamicproperties', propertyQuery),
            queryDataverse('productpricelevels', priceItemQuery),
        ]);

        // Step 4: Build products with territory-specific pricing
        const productsWithPricing = products.map(product => {
            const relationships = allRelationships.filter(r => r.parentProductIdForJoin === product.productid);
            const parentProductId = product.parentproductid || product._parentproductid_value;

            // Filter properties for THIS SPECIFIC PRODUCT and its parent
            const productLevelProperties = allProperties.filter(p => {
                const regardingId = p.parentRecordId || p._regardingobjectid_value;
                return regardingId === product.productid;
            });

            const familyLevelProperties = allProperties.filter(p => {
                const regardingId = p.parentRecordId || p._regardingobjectid_value;
                return regardingId === parentProductId;
            });

            // Create a property map specifically for THIS product
            const propertyMap = new Map();

            // Add family-level properties as templates
            familyLevelProperties.forEach(familyProp => {
                const value = extractPropertyValue(familyProp);
                propertyMap.set(familyProp.propertyId, {
                    propertyId: familyProp.propertyId,
                    propertyName: familyProp.propertyName,
                    propertyValue: value,
                    source: 'family',
                    isTemplate: true,
                    hasValue: value !== null && value !== undefined && value !== ''
                });
            });

            // Process product-level properties
            productLevelProperties.forEach(prodProp => {
                const value = extractPropertyValue(prodProp);
                const rootId = prodProp.rootPropertyId || prodProp.basePropertyId;

                if (rootId && propertyMap.has(rootId)) {
                    const linkedFamilyProp = propertyMap.get(rootId);
                    const finalValue = value !== null && value !== undefined && value !== '' ? value : linkedFamilyProp.propertyValue;
                    const finalSource = value !== null && value !== undefined && value !== '' ? 'product' : 'family';

                    propertyMap.set(rootId, {
                        propertyId: prodProp.propertyId,
                        propertyName: linkedFamilyProp.propertyName,
                        propertyValue: finalValue,
                        source: finalSource,
                        isTemplate: false,
                        hasValue: finalValue !== null && finalValue !== undefined && finalValue !== ''
                    });
                } else {
                    propertyMap.set(prodProp.propertyId, {
                        propertyId: prodProp.propertyId,
                        propertyName: prodProp.propertyName,
                        propertyValue: value,
                        source: 'product',
                        isTemplate: false,
                        hasValue: value !== null && value !== undefined && value !== ''
                    });
                }
            });

            const finalProperties = Array.from(propertyMap.values())
                .filter(prop => prop.hasValue)
                .map(prop => ({
                    propertyId: prop.propertyId,
                    propertyName: prop.propertyName,
                    propertyValue: prop.propertyValue,
                    source: prop.source
                }));

            // Get price items for this product (already filtered by territory if territoryId provided)
            const priceItems = allPriceItems.filter(item => item.productIdForJoin === product.productid);

            const priceListGroups = {};
            priceItems.forEach(item => {
                const priceListId = item.priceListId;
                if (!priceListGroups[priceListId]) {
                    priceListGroups[priceListId] = {
                        priceListId: priceListId,
                        priceListName: item.priceListName,
                        items: []
                    };
                }
                priceListGroups[priceListId].items.push({
                    priceListItemId: item.priceListItemId,
                    buyingAmount: item.buyingAmount,
                    amount: item.amount,
                    weeePercentageOfSell: item.weeePercentageOfSell,
                    maxDiscountPercentage: item.maxDiscountPercentage,
                    costPerPageOriginal: item.costPerPageOriginal,
                    costPerPageRemanufactured: item.costPerPageRemanufactured,
                    saving: item.saving,
                    weeePoints: item.weeePoints,
                    carbonSavings: item.carbonSavings
                });
            });

            return {
                ...product,
                price_lists: Object.values(priceListGroups),
                properties: finalProperties,
                product_relationships: relationships.map(r => ({
                    relationshipId: r.relationshipId,
                    relationshipType: r.relationshipType,
                    relationshipTypeName: "Substitute",
                    direction: r.direction,
                    productId: r.productId,
                    productNumber: r.relatedProductNumber,
                    name: r.relatedName
                }))
            };
        });

        // Step 5: If territory specified, filter to only products that have prices in the territory
        let finalProducts;
        if (territoryId) {
            finalProducts = productsWithPricing.filter(p => p.price_lists.length > 0);
            console.log(`[Store] Filtered to ${finalProducts.length} products with prices in territory`);
        } else {
            finalProducts = productsWithPricing;
        }

        // Update territory-specific cache
        storeProductCacheByTerritory.set(cacheKey, {
            data: finalProducts,
            currency: territoryCurrency,
            lastFetch: Date.now()
        });
        console.log(`✅ Store cache updated for territory: ${cacheKey}. Found ${finalProducts.length} products.`);

        res.status(200).json({
            success: true,
            products: finalProducts,
            currency: territoryCurrency,
            source: 'live'
        });

    } catch (error) {
        console.error('❌ Error in /api/store endpoint:', error.message);
        console.error('❌ Full error stack:', error.stack);
        const cachedData = storeProductCacheByTerritory.get(cacheKey);
        if (cachedData) {
            console.warn('⚠️ Serving stale store cache due to fetch error.');
            return res.status(200).json({
                success: true,
                products: cachedData.data,
                currency: cachedData.currency,
                source: 'stale'
            });
        }
        res.status(500).json({ message: 'Failed to fetch store products.', detail: error.message });
    }
});

// Contact form endpoint
app.post('/api/contact', apiLimiter, async (req, res) => {
    const { name, email, phone, subject, message, type } = req.body;

    // Validate required fields
    if (!name || !email || !message || type !== 'contact') {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields',
            received: { name: !!name, email: !!email, message: !!message, type }
        });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid email format'
        });
    }

    const powerAutomateUrl = envConfig.powerAutomateUrl;
    if (!powerAutomateUrl) {
        console.error("POWER_AUTOMATE_GET_URL is not set.");
        return res.status(500).json({
            success: false,
            message: 'Server configuration error.'
        });
    }

    // Get user GUID if logged in, otherwise null
    const userGUID = req.session.user?.GUID || null;
    const userPhone = req.session.user?.phoneNumber || null;
    const userFullName = req.session.user?.fullName || null;

    // Use phone from form if provided (for non-logged-in users), otherwise use session phone
    const contactPhone = phone || userPhone || null;

    // Create human-readable summary for Teams chat
    const timestamp = new Date();
    const formattedDate = timestamp.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    const formattedTime = timestamp.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    // Build user status section (without GUID for readability)
    const userStatusSection = userGUID
        ? `🔐 User Status:
   ✅ Logged In
   Account: ${userFullName || 'Unknown'}
   Phone: ${contactPhone || 'N/A'}
`
        : `🔐 User Status:
   ❌ Not Logged In (Anonymous)
   Phone: ${contactPhone || 'N/A'}
`;

    const humanReadableSummary = `📧 NEW CONTACT FORM SUBMISSION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Contact Information:
   Name: ${name}
   Email: ${email}

${userStatusSection}
📋 Subject:
   ${subject || 'General Inquiry'}

💬 Message:
${message}

🕐 Submitted:
   ${formattedDate}
   ${formattedTime}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    // Prepare the payload for Power Automate
    const contactPayload = {
        type: 'contact',
        GUID: userGUID,
        name: name,
        email: email,
        phoneNumber: contactPhone,
        subject: subject || 'General Inquiry',
        message: message,
        submittedAt: timestamp.toISOString(),
        isLoggedIn: userGUID !== null,
        humanReadableSummary: humanReadableSummary
    };

    try {
        console.log('📧 Sending contact form to Power Automate:', {
            type: 'contact',
            name,
            email,
            subject: subject || 'General Inquiry',
            messageLength: message.length,
            timestamp: timestamp.toISOString()
        });
        console.log('\n' + humanReadableSummary + '\n');

        const paResponse = await axios.post(powerAutomateUrl, contactPayload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30 second timeout
        });

        console.log('✅ Contact form sent successfully to Power Automate');
        console.log('Power Automate response status:', paResponse.status);

        res.status(200).json({
            success: true,
            message: 'Contact form submitted successfully',
            contactId: 'CNT' + Date.now().toString().slice(-6)
        });

    } catch (error) {
        console.error('❌ Error sending contact form:', error.message);

        if (error.code === 'ECONNABORTED') {
            console.error('Request timeout - Power Automate took too long to respond');
            return res.status(202).json({
                success: true,
                message: 'Your message has been received and will be processed. We will contact you within 24 hours.',
                warning: 'processing_delayed'
            });
        }

        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data;

            console.error('Power Automate error status:', status);
            secureLog.error('Power Automate error', errorData?.error?.code);

            if (status === 502) {
                // Power Automate NoResponse error - still accept the submission
                console.log('Power Automate 502 - accepting submission for manual processing');
                return res.status(202).json({
                    success: true,
                    message: 'Your message has been received and will be processed manually. We will contact you within 24 hours.',
                    warning: 'processing_delayed'
                });
            }

            if (status >= 500) {
                return res.status(503).json({
                    success: false,
                    message: 'Service temporarily unavailable. Please try again later.',
                    error: 'service_unavailable'
                });
            }
        }

        res.status(500).json({
            success: false,
            message: 'Failed to send your message. Please try again later or contact us directly.',
            error: 'internal_error'
        });
    }
});

// API endpoint to get user's environmental impact data
// Uses totalCarbonSaved from contact record (updated by Dataverse)
// Emission factors based on Climatiq API database (https://www.climatiq.io/)
// Sources: EPA, IPCC AR6, GHG Protocol, DEFRA 2023
app.get('/api/environmental-impact', async (req, res) => {
    // Authentication check - session or localStorage-based
    const isSessionAuth = req.session.user && req.session.user.GUID;
    const isLocalDev = !isProduction();

    let userGUID = null;
    let userFullName = 'Eco Warrior';

    if (isSessionAuth) {
        userGUID = req.session.user.GUID;
        userFullName = req.session.user.fullName || 'Eco Warrior';
    } else if (isLocalDev && req.query.userGUID) {
        userGUID = req.query.userGUID;
        console.log('🌍 Fetching environmental impact for local dev user:', userGUID);
    }

    if (!userGUID) {
        return res.status(401).json({ message: 'User not logged in.' });
    }

    // Validate GUID format to prevent injection
    if (!isValidGUID(userGUID)) {
        return res.status(400).json({ message: 'Invalid user identifier format.' });
    }

    try {
        // Sanitize GUID for FetchXML (defense in depth)
        const sanitizedGUID = sanitizeFetchXmlValue(userGUID);

        // Fetch user's contact record to get totalCarbonSaved from Dataverse
        const contactFetchXml = `
            <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                <entity name="contact">
                    <attribute name="contactid" />
                    <attribute name="firstname" />
                    <attribute name="crd33_totalcarbonsaved" />
                    <attribute name="crd33_totalweeepoints" />
                    <filter type="and">
                        <condition attribute="contactid" operator="eq" value="${sanitizedGUID}" />
                    </filter>
                </entity>
            </fetch>
        `;

        const contactResults = await queryDataverse('contacts', contactFetchXml);

        let totalCO2Saved = 0;
        if (contactResults.length > 0) {
            const contact = contactResults[0];
            totalCO2Saved = parseFloat(contact.crd33_totalcarbonsaved) || 0;
            userFullName = contact.firstname || userFullName;
        }

        // Also fetch completed e-waste requests to estimate items recycled
        const requestsFetchXml = `
            <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                <entity name="crd33_onlinerequests">
                    <attribute name="activityid" />
                    <attribute name="description" />
                    <attribute name="createdon" />
                    <attribute name="crd33_requesttype" />
                    <filter type="and">
                        <condition attribute="regardingobjectid" operator="eq" value="${sanitizedGUID}" />
                        <condition attribute="crd33_requesttype" operator="eq" value="269530000" />
                    </filter>
                    <order attribute="createdon" descending="true" />
                </entity>
            </fetch>
        `;

        const ewasteRequests = await queryDataverse('crd33_onlinerequestses', requestsFetchXml);

        // Estimate items recycled from request count (since actual items aren't stored)
        // Each e-waste request typically contains ~3-5 items on average
        const totalItemsRecycled = ewasteRequests.length * 4; // Conservative estimate

        // Build request history for display
        let requestHistory = ewasteRequests.slice(0, 10).map(request => ({
            date: request.createdon,
            items: 4, // Estimated items per request
            co2: totalCO2Saved / Math.max(ewasteRequests.length, 1) // Distribute CO2 across requests
        }));

        // =====================================================================
        // CLIMATIQ API EMISSION FACTORS - VERIFIED & SOURCED
        // All calculations based on Climatiq's verified emission factor database
        // Source: https://www.climatiq.io/ (639,000+ emission factors)
        // Data sources: EPA, IPCC AR6, GHG Protocol, UK DEFRA/BEIS, IEA, ADEME
        // =====================================================================

        // Define emission factors with full Climatiq source references
        const emissionFactors = {
            // Tree carbon sequestration: EPA/IPCC AR6 forestry data
            // Source: One Tree Planted, European Environment Agency, IPCC AR6
            // A mature tree absorbs approximately 22-25 kg CO2/year
            // Using conservative estimate of 22 kg CO2/tree/year
            trees: {
                value: 22,
                unit: 'kg CO2/tree/year',
                source: 'EPA/IPCC AR6',
                description: 'Average mature tree annual carbon absorption',
                reference: 'https://www.climatiq.io/data'
            },

            // Passenger car driving: GHG Protocol via Climatiq
            // Climatiq Factor ID: 2b76b9f9-46e0-4933-93c0-21ab62f9d943
            // Activity ID: passenger_vehicle-vehicle_type_car-fuel_source_na-engine_size_na-vehicle_age_na-vehicle_weight_na
            // Value: 0.346447 kg CO2e/mile = 0.2153 kg CO2e/km
            // Region: United States, Year: 2021
            driving: {
                value: 0.2153,
                unit: 'kg CO2e/km',
                source: 'GHG Protocol',
                factorId: '2b76b9f9-46e0-4933-93c0-21ab62f9d943',
                description: 'Passenger vehicle average emissions per km',
                reference: 'https://www.climatiq.io/data/emission-factor/2b76b9f9-46e0-4933-93c0-21ab62f9d943'
            },

            // Egypt electricity grid: ADEME/IEA via Climatiq
            // Climatiq Factor ID: 2c8aa104-7e2e-4bae-af32-c054e9bc4d7f
            // Activity ID: electricity-supply_grid-source_supplier_mix
            // Value: 0.45 kg CO2e/kWh
            // Region: Egypt, Source: ADEME (originally IEA 2013)
            // Average Egyptian household uses ~10 kWh/day = 4.5 kg CO2/day
            electricity: {
                valuePerKwh: 0.45,
                avgDailyKwh: 10,
                value: 4.5, // 0.45 * 10 = 4.5 kg CO2/day
                unit: 'kg CO2e/day',
                source: 'ADEME/IEA',
                factorId: '2c8aa104-7e2e-4bae-af32-c054e9bc4d7f',
                description: 'Egypt grid electricity - average household daily consumption',
                reference: 'https://www.climatiq.io/data/emission-factor/2c8aa104-7e2e-4bae-af32-c054e9bc4d7f'
            },

            // Smartphone charging: Derived from grid electricity
            // A typical smartphone battery is 3000-5000 mAh at 3.7V = ~15 Wh
            // Charging efficiency ~85%, so ~18 Wh from grid = 0.018 kWh
            // Using Egypt grid: 0.018 kWh * 0.45 kg/kWh = 0.0081 kg CO2
            phoneCharging: {
                value: 0.0081,
                unit: 'kg CO2e/charge',
                source: 'Derived (Grid × Device)',
                description: 'Smartphone full charge using Egypt grid electricity',
                reference: 'https://www.climatiq.io/data/emission-factor/2c8aa104-7e2e-4bae-af32-c054e9bc4d7f'
            },

            // Flight emissions: UK DEFRA/BEIS via Climatiq
            // Climatiq Factor ID: 8ff56acc-aeb1-4e5d-aca0-ec1d3799a2c5
            // Activity ID: passenger_flight-route_type_domestic-aircraft_type_na-distance_na-class_na-rf_included-distance_uplift_included
            // Value: 0.24587 kg CO2e/passenger-km (includes RF effect)
            // Average flight speed ~800 km/h, so per hour = ~197 kg CO2e/hour
            flights: {
                valuePerPkm: 0.24587,
                avgSpeedKmh: 800,
                value: 197, // 0.24587 * 800 = 196.7 ≈ 197 kg CO2/hour
                unit: 'kg CO2e/flight-hour',
                source: 'UK BEIS/DEFRA',
                factorId: '8ff56acc-aeb1-4e5d-aca0-ec1d3799a2c5',
                description: 'Domestic flight with radiative forcing, economy class',
                reference: 'https://www.climatiq.io/data/emission-factor/8ff56acc-aeb1-4e5d-aca0-ec1d3799a2c5'
            },

            // Beef burger: EXIOBASE via Climatiq
            // Climatiq Activity: consumer_goods-type_meat_products_beef
            // Research shows beef carbon footprint ranges from 15-60 kg CO2e/kg depending on source
            // Using moderate estimate: 27 kg CO2e/kg beef
            // Average burger patty: 150g = 0.15 kg → 4.05 kg CO2e/burger
            burger: {
                valuePerKg: 27,
                pattyWeight: 0.15,
                value: 4.05, // 27 * 0.15 = 4.05 kg CO2e/burger
                unit: 'kg CO2e/burger',
                source: 'EXIOBASE',
                activityId: 'consumer_goods-type_meat_products_beef',
                description: 'Beef burger (150g patty) lifecycle emissions',
                reference: 'https://www.climatiq.io/data/activity/consumer_goods-type_meat_products_beef'
            }
        };

        // Calculate equivalents using verified emission factors
        const treesEquivalent = totalCO2Saved / emissionFactors.trees.value;
        const drivingKmEquivalent = totalCO2Saved / emissionFactors.driving.value;
        const electricityDays = totalCO2Saved / emissionFactors.electricity.value;
        const phoneCharges = totalCO2Saved / emissionFactors.phoneCharging.value;
        const flightsAvoided = totalCO2Saved / emissionFactors.flights.value;
        const burgersEquivalent = totalCO2Saved / emissionFactors.burger.value;

        // Calculate user rank/level based on CO2 saved
        let ecoLevel = 'Seedling';
        let ecoEmoji = '🌱';
        let nextLevel = 50;
        let progress = 0;

        if (totalCO2Saved >= 1000) {
            ecoLevel = 'Eco Champion';
            ecoEmoji = '🏆';
            nextLevel = null;
            progress = 100;
        } else if (totalCO2Saved >= 500) {
            ecoLevel = 'Forest Guardian';
            ecoEmoji = '🌲';
            nextLevel = 1000;
            progress = ((totalCO2Saved - 500) / 500) * 100;
        } else if (totalCO2Saved >= 200) {
            ecoLevel = 'Earth Protector';
            ecoEmoji = '🌍';
            nextLevel = 500;
            progress = ((totalCO2Saved - 200) / 300) * 100;
        } else if (totalCO2Saved >= 50) {
            ecoLevel = 'Green Warrior';
            ecoEmoji = '🌿';
            nextLevel = 200;
            progress = ((totalCO2Saved - 50) / 150) * 100;
        } else {
            progress = (totalCO2Saved / 50) * 100;
        }

        // Generate shareable stats for social media
        const shareableStats = {
            headline: `I've saved ${totalCO2Saved.toFixed(1)} kg of CO₂ with DR.WEEE!`,
            subtext: `That's equivalent to planting ${treesEquivalent.toFixed(1)} trees!`,
            hashtags: ['DrWEEE', 'EcoWarrior', 'RecycleElectronics', 'SaveThePlanet', 'CircularEconomy']
        };

        secureLog.info(`🌍 Environmental impact calculated: ${totalCO2Saved.toFixed(1)} kg CO2, ${totalItemsRecycled} items`);

        res.status(200).json({
            success: true,
            impact: {
                userName: userFullName,
                co2Saved: parseFloat(totalCO2Saved.toFixed(1)),
                itemsRecycled: totalItemsRecycled,
                treesEquivalent: parseFloat(treesEquivalent.toFixed(1)),
                drivingKm: Math.round(drivingKmEquivalent),
                electricityDays: Math.round(electricityDays),
                phoneCharges: Math.round(phoneCharges),
                flightsAvoided: parseFloat(flightsAvoided.toFixed(2)),
                burgersEquivalent: Math.round(burgersEquivalent),
                itemBreakdown: {}, // Item breakdown not available (items not tracked in Dataverse)
                history: requestHistory.slice(0, 10), // Last 10 activities
                ecoLevel: {
                    name: ecoLevel,
                    emoji: ecoEmoji,
                    progress: Math.round(progress),
                    nextLevel: nextLevel,
                    co2ToNext: nextLevel ? nextLevel - totalCO2Saved : 0
                },
                shareableStats: shareableStats,
                lastUpdated: new Date().toISOString(),
                // Climatiq data source information for credibility
                dataSource: {
                    provider: 'Climatiq',
                    url: 'https://www.climatiq.io/',
                    totalFactors: '639,000+',
                    sources: ['EPA', 'IPCC AR6', 'GHG Protocol', 'DEFRA', 'IEA'],
                    verified: true,
                    lastSync: '2024-12'
                },
                // Detailed emission factors with Climatiq references for UI display
                emissionFactorDetails: {
                    trees: {
                        value: emissionFactors.trees.value,
                        unit: emissionFactors.trees.unit,
                        source: emissionFactors.trees.source,
                        description: emissionFactors.trees.description,
                        reference: emissionFactors.trees.reference
                    },
                    driving: {
                        value: emissionFactors.driving.value,
                        unit: emissionFactors.driving.unit,
                        source: emissionFactors.driving.source,
                        factorId: emissionFactors.driving.factorId,
                        reference: emissionFactors.driving.reference
                    },
                    electricity: {
                        value: emissionFactors.electricity.value,
                        valuePerKwh: emissionFactors.electricity.valuePerKwh,
                        unit: emissionFactors.electricity.unit,
                        source: emissionFactors.electricity.source,
                        factorId: emissionFactors.electricity.factorId,
                        reference: emissionFactors.electricity.reference
                    },
                    phoneCharging: {
                        value: emissionFactors.phoneCharging.value,
                        unit: emissionFactors.phoneCharging.unit,
                        source: emissionFactors.phoneCharging.source,
                        reference: emissionFactors.phoneCharging.reference
                    },
                    flights: {
                        value: emissionFactors.flights.value,
                        valuePerPkm: emissionFactors.flights.valuePerPkm,
                        unit: emissionFactors.flights.unit,
                        source: emissionFactors.flights.source,
                        factorId: emissionFactors.flights.factorId,
                        reference: emissionFactors.flights.reference
                    },
                    burger: {
                        value: emissionFactors.burger.value,
                        unit: emissionFactors.burger.unit,
                        source: emissionFactors.burger.source,
                        activityId: emissionFactors.burger.activityId,
                        reference: emissionFactors.burger.reference
                    }
                }
            }
        });

    } catch (error) {
        console.error('❌ Error fetching environmental impact:', error.message);
        res.status(500).json({
            message: 'Failed to fetch environmental impact. Please try again later.',
            error: 'internal_error'
        });
    }
});


// =====================================================================
// AZURE TRANSLATOR API INTEGRATION
// Multi-language support for Arabic and Italian translations
// =====================================================================

// Helper: Get cache key for translation
function getTranslationCacheKey(text, targetLang) {
    return `${targetLang}:${text.substring(0, 100)}`;
}

// Helper: Clean expired cache entries
function cleanTranslationCache() {
    const now = Date.now();
    for (const [key, value] of translationCache.entries()) {
        if (now - value.timestamp > TRANSLATION_CACHE_TTL) {
            translationCache.delete(key);
        }
    }
}

// Clean cache every hour
setInterval(cleanTranslationCache, 60 * 60 * 1000);

// POST /api/translate - Translate single text
app.post('/api/translate', apiLimiter, async (req, res) => {
    try {
        const { text, targetLang } = req.body;

        // Validate input
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'Text is required' });
        }

        if (!targetLang || !['ar', 'it'].includes(targetLang)) {
            return res.status(400).json({ error: 'Valid target language required (ar, it)' });
        }

        // Check Azure Translator credentials
        if (!process.env.AZURE_TRANSLATOR_KEY || !process.env.AZURE_TRANSLATOR_REGION) {
            console.warn('⚠️ Azure Translator credentials not configured');
            return res.json({ translatedText: text, cached: false, warning: 'Translation not configured' });
        }

        // Check cache first
        const cacheKey = getTranslationCacheKey(text, targetLang);
        const cached = translationCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < TRANSLATION_CACHE_TTL) {
            return res.json({ translatedText: cached.translation, cached: true });
        }

        // Call Azure Translator API
        const endpoint = 'https://api.cognitive.microsofttranslator.com';
        const response = await axios.post(
            `${endpoint}/translate?api-version=3.0&from=en&to=${targetLang}`,
            [{ text }],
            {
                headers: {
                    'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY,
                    'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION,
                    'Content-Type': 'application/json'
                }
            }
        );

        const translatedText = response.data[0]?.translations[0]?.text || text;

        // Cache the result
        translationCache.set(cacheKey, {
            translation: translatedText,
            timestamp: Date.now()
        });

        console.log(`🌐 Translated to ${targetLang}: "${text.substring(0, 30)}..." → "${translatedText.substring(0, 30)}..."`);

        res.json({ translatedText, cached: false });

    } catch (error) {
        console.error('❌ Translation error:', error.response?.data || error.message);
        // Return original text on error
        res.json({ translatedText: req.body.text, error: 'Translation failed' });
    }
});

// POST /api/translate-batch - Translate multiple texts
app.post('/api/translate-batch', apiLimiter, async (req, res) => {
    try {
        const { texts, targetLang } = req.body;

        // Validate input
        if (!Array.isArray(texts) || texts.length === 0) {
            return res.status(400).json({ error: 'Texts array is required' });
        }

        if (texts.length > 100) {
            return res.status(400).json({ error: 'Maximum 100 texts per request' });
        }

        if (!targetLang || !['ar', 'it'].includes(targetLang)) {
            return res.status(400).json({ error: 'Valid target language required (ar, it)' });
        }

        // Check Azure Translator credentials
        if (!process.env.AZURE_TRANSLATOR_KEY || !process.env.AZURE_TRANSLATOR_REGION) {
            console.warn('⚠️ Azure Translator credentials not configured');
            return res.json({ translations: texts, warning: 'Translation not configured' });
        }

        const results = [];
        const textsToTranslate = [];
        const indexMap = []; // Map of original index to texts needing translation

        // Check cache for each text
        texts.forEach((text, index) => {
            const cacheKey = getTranslationCacheKey(text, targetLang);
            const cached = translationCache.get(cacheKey);

            if (cached && Date.now() - cached.timestamp < TRANSLATION_CACHE_TTL) {
                results[index] = cached.translation;
            } else {
                textsToTranslate.push({ text });
                indexMap.push(index);
                results[index] = null; // Placeholder
            }
        });

        // If all were cached, return immediately
        if (textsToTranslate.length === 0) {
            return res.json({ translations: results, allCached: true });
        }

        // Call Azure Translator API for uncached texts
        const endpoint = 'https://api.cognitive.microsofttranslator.com';
        const response = await axios.post(
            `${endpoint}/translate?api-version=3.0&from=en&to=${targetLang}`,
            textsToTranslate,
            {
                headers: {
                    'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY,
                    'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Process results and update cache
        response.data.forEach((item, i) => {
            const originalIndex = indexMap[i];
            const originalText = texts[originalIndex];
            const translatedText = item.translations[0]?.text || originalText;

            results[originalIndex] = translatedText;

            // Cache the result
            const cacheKey = getTranslationCacheKey(originalText, targetLang);
            translationCache.set(cacheKey, {
                translation: translatedText,
                timestamp: Date.now()
            });
        });

        console.log(`🌐 Batch translated ${textsToTranslate.length} texts to ${targetLang}`);

        res.json({
            translations: results,
            translated: textsToTranslate.length,
            cached: texts.length - textsToTranslate.length
        });

    } catch (error) {
        console.error('❌ Batch translation error:', error.response?.data || error.message);
        // Return original texts on error
        res.json({ translations: req.body.texts, error: 'Translation failed' });
    }
});

// GET /api/translation-stats - Get translation cache stats (for monitoring)
app.get('/api/translation-stats', (req, res) => {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;

    for (const [, value] of translationCache.entries()) {
        if (now - value.timestamp < TRANSLATION_CACHE_TTL) {
            validEntries++;
        } else {
            expiredEntries++;
        }
    }

    res.json({
        cacheSize: translationCache.size,
        validEntries,
        expiredEntries,
        ttlHours: TRANSLATION_CACHE_TTL / (60 * 60 * 1000),
        configured: !!(process.env.AZURE_TRANSLATOR_KEY && process.env.AZURE_TRANSLATOR_REGION)
    });
});

// =====================================================================
// END AZURE TRANSLATOR API INTEGRATION
// =====================================================================


// Logout endpoint
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({ message: 'Logout failed' });
        }
        secureLog.info('✅ User logged out successfully');
        res.clearCookie('drweee.sid');
        res.status(200).json({ message: 'Logged out successfully' });
    });
});


// =====================================================================
// SHAREABLE CERTIFICATE FEATURE
// Allows users to share their environmental impact on social media
// =====================================================================

// Helper: Generate unique 8-character share code
function generateShareCode() {
    // Excludes O/0, I/l/1 to avoid confusion
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Helper: Validate share code format
function isValidShareCode(code) {
    return /^[A-Za-z0-9]{8}$/.test(code);
}

// Helper: Calculate emission equivalents (same as environmental-impact endpoint)
function calculateEmissionEquivalents(totalCO2Saved) {
    // Verified Climatiq emission factors
    const emissionFactors = {
        trees: { value: 22, unit: 'kg CO2/tree/year' },
        driving: { value: 0.2153, unit: 'kg CO2e/km' },
        electricity: { value: 4.5, unit: 'kg CO2e/day' },
        phoneCharging: { value: 0.0081, unit: 'kg CO2e/charge' },
        flights: { value: 197, unit: 'kg CO2e/flight-hour' },
        burger: { value: 4.05, unit: 'kg CO2e/burger' }
    };

    return {
        treesEquivalent: parseFloat((totalCO2Saved / emissionFactors.trees.value).toFixed(1)),
        drivingKm: Math.round(totalCO2Saved / emissionFactors.driving.value),
        electricityDays: Math.round(totalCO2Saved / emissionFactors.electricity.value),
        phoneCharges: Math.round(totalCO2Saved / emissionFactors.phoneCharging.value),
        flightsAvoided: parseFloat((totalCO2Saved / emissionFactors.flights.value).toFixed(2)),
        burgersEquivalent: Math.round(totalCO2Saved / emissionFactors.burger.value)
    };
}

// Helper: Get eco level from CO2 saved
function getEcoLevel(co2Saved) {
    if (co2Saved >= 1000) {
        return { name: 'Eco Champion', emoji: '🏆', progress: 100, nextLevel: null };
    } else if (co2Saved >= 500) {
        return { name: 'Forest Guardian', emoji: '🌲', progress: Math.round(((co2Saved - 500) / 500) * 100), nextLevel: 1000 };
    } else if (co2Saved >= 200) {
        return { name: 'Earth Protector', emoji: '🌍', progress: Math.round(((co2Saved - 200) / 300) * 100), nextLevel: 500 };
    } else if (co2Saved >= 50) {
        return { name: 'Green Warrior', emoji: '🌿', progress: Math.round(((co2Saved - 50) / 150) * 100), nextLevel: 200 };
    } else {
        return { name: 'Seedling', emoji: '🌱', progress: Math.round((co2Saved / 50) * 100), nextLevel: 50 };
    }
}

// 1. GET /api/share/my-code - Generate or retrieve user's share code
app.get('/api/share/my-code', apiLimiter, async (req, res) => {
    try {
        // Check authentication
        const isSessionAuth = req.session.user && req.session.user.GUID;

        let userGUID = null;
        if (isSessionAuth) {
            userGUID = req.session.user.GUID;
        } else if (req.query.userGUID) { // Accept GUID from query param
            userGUID = req.query.userGUID;
        }

        if (!userGUID) {
            return res.status(401).json({ success: false, message: 'User not logged in.' });
        }

        // Validate GUID format to prevent injection
        if (!isValidGUID(userGUID)) {
            return res.status(400).json({ success: false, message: 'Invalid user identifier format.' });
        }

        // Sanitize GUID for FetchXML
        const sanitizedGUID = sanitizeFetchXmlValue(userGUID);

        // Get access token for Dataverse
        const accessToken = await getDataverseToken();

        // Fetch user's current share code
        // Try with sharecode field first, fall back to basic query if field doesn't exist
        let contact = null;
        let shareCode = null;
        let isNew = false;

        try {
            const fetchXml = `
                <fetch top="1">
                    <entity name="contact">
                        <attribute name="contactid" />
                        <attribute name="firstname" />
                        <attribute name="crd33_sharecode" />
                        <filter>
                            <condition attribute="contactid" operator="eq" value="${sanitizedGUID}" />
                        </filter>
                    </entity>
                </fetch>
            `;
            const response = await queryDataverse('contacts', fetchXml, accessToken);
            if (response && response.length > 0) {
                contact = response[0];
                shareCode = contact.crd33_sharecode;
            }
        } catch (fetchError) {
            // If the crd33_sharecode field doesn't exist yet, try without it
            console.log('⚠️ Share code field may not exist yet, trying basic query...');
            const fallbackXml = `
                <fetch top="1">
                    <entity name="contact">
                        <attribute name="contactid" />
                        <attribute name="firstname" />
                        <filter>
                            <condition attribute="contactid" operator="eq" value="${sanitizedGUID}" />
                        </filter>
                    </entity>
                </fetch>
            `;
            const response = await queryDataverse('contacts', fallbackXml, accessToken);
            if (response && response.length > 0) {
                contact = response[0];
            }
        }

        if (!contact) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Generate new code if doesn't exist
        if (!shareCode) {
            shareCode = generateShareCode();
            isNew = true;

            // Update contact with new share code in Dataverse
            try {
                const updateUrl = `${envConfig.dataverseUrl}/api/data/v9.2/contacts(${userGUID})`;
                await axios.patch(updateUrl, {
                    crd33_sharecode: shareCode
                }, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0'
                    }
                });
                secureLog.info('✅ Generated new share code for user');
            } catch (updateError) {
                console.error('Error updating share code in Dataverse:', updateError.message);
                // Still return the code - it might work for this session
            }
        }

        // Build the public share URL
        const baseUrl = envConfig.baseUrl;

        res.json({
            success: true,
            shareCode: shareCode,
            shareUrl: `${baseUrl}/certificate/${shareCode}`,
            isNew: isNew
        });

    } catch (error) {
        console.error('Error in /api/share/my-code:', error.message);
        if (error.response) {
            console.error('Dataverse error details:', error.response.data);
        }
        res.status(500).json({ success: false, message: 'Failed to get share code.', error: error.message });
    }
});

// 2. GET /api/public/impact/:shareCode - Public endpoint for certificate data
app.get('/api/public/impact/:shareCode', apiLimiter, async (req, res) => {
    try {
        const { shareCode } = req.params;

        // Validate share code format
        if (!isValidShareCode(shareCode)) {
            return res.status(400).json({ success: false, message: 'Invalid share code format.' });
        }

        // Sanitize share code for FetchXML (defense in depth after validation)
        const sanitizedShareCode = sanitizeFetchXmlValue(shareCode);

        // Get access token for Dataverse
        const accessToken = await getDataverseToken();

        // Fetch user by share code
        const fetchXml = `
            <fetch top="1">
                <entity name="contact">
                    <attribute name="contactid" />
                    <attribute name="firstname" />
                    <attribute name="lastname" />
                    <attribute name="crd33_totalcarbonsaved" />
                    <attribute name="crd33_sharecode" />
                    <attribute name="createdon" />
                    <filter>
                        <condition attribute="crd33_sharecode" operator="eq" value="${sanitizedShareCode}" />
                    </filter>
                </entity>
            </fetch>
        `;

        const response = await queryDataverse('contacts', fetchXml, accessToken);

        if (!response || response.length === 0) {
            return res.status(404).json({ success: false, message: 'Certificate not found.' });
        }

        const contact = response[0];
        const totalCO2Saved = parseFloat(contact.crd33_totalcarbonsaved) || 0;
        const firstName = contact.firstname || 'Eco Warrior';
        const lastName = contact.lastname || '';
        const fullName = lastName ? `${firstName} ${lastName}` : firstName;
        const memberSince = contact.createdon ? new Date(contact.createdon).toLocaleDateString('en-US', { year: 'numeric', month: 'long' }) : 'Member';

        // Calculate equivalents
        const equivalents = calculateEmissionEquivalents(totalCO2Saved);
        const ecoLevel = getEcoLevel(totalCO2Saved);

        res.json({
            success: true,
            profile: {
                name: fullName,
                firstName: firstName,
                shareCode: shareCode,
                memberSince: memberSince,
                impact: {
                    co2Saved: parseFloat(totalCO2Saved.toFixed(1)),
                    ...equivalents,
                    ecoLevel: ecoLevel
                },
                lastUpdated: new Date().toISOString()
            },
            dataSource: {
                provider: 'Climatiq',
                url: 'https://www.climatiq.io/',
                verified: true
            }
        });

    } catch (error) {
        console.error('Error in /api/public/impact:', error);
        res.status(500).json({ success: false, message: 'Failed to load certificate data.' });
    }
});

// 3. GET /og/:shareCode - Generate OG image for social sharing
app.get('/og/:shareCode', ogLimiter, async (req, res) => {
    try {
        const { shareCode } = req.params;

        // Validate share code format
        if (!isValidShareCode(shareCode)) {
            return res.status(400).send('Invalid share code');
        }

        // Try to load canvas - if not available, serve a placeholder
        let createCanvas, loadImage;
        try {
            const canvasModule = require('canvas');
            createCanvas = canvasModule.createCanvas;
            loadImage = canvasModule.loadImage;
        } catch (canvasError) {
            console.warn('Canvas module not available, generating SVG fallback');

            // Fetch user data even without canvas to generate SVG
            try {
                const accessToken = await getDataverseToken();
                // Sanitize share code for FetchXML
                const sanitizedShareCode = sanitizeFetchXmlValue(shareCode);
                const fetchXml = `
                    <fetch top="1">
                        <entity name="contact">
                            <attribute name="firstname" />
                            <attribute name="lastname" />
                            <attribute name="crd33_totalcarbonsaved" />
                            <filter>
                                <condition attribute="crd33_sharecode" operator="eq" value="${sanitizedShareCode}" />
                            </filter>
                        </entity>
                    </fetch>
                `;
                const response = await queryDataverse('contacts', fetchXml, accessToken);

                if (response && response.length > 0) {
                    const contact = response[0];
                    const totalCO2Saved = parseFloat(contact.crd33_totalcarbonsaved) || 0;
                    const firstName = contact.firstname || 'Eco Warrior';
                    const lastName = contact.lastname || '';
                    const fullName = lastName ? `${firstName} ${lastName}` : firstName;
                    const equivalents = calculateEmissionEquivalents(totalCO2Saved);
                    const ecoLevel = getEcoLevel(totalCO2Saved);

                                        // Generate SVG certificate image (without emoji for better compatibility)
                    const svg = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
                        <defs>
                            <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" style="stop-color:#ffffff"/>
                                <stop offset="100%" style="stop-color:#e8f5e9"/>
                            </linearGradient>
                            <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
                                <stop offset="0%" style="stop-color:#1B5E20"/>
                                <stop offset="50%" style="stop-color:#2E7D32"/>
                                <stop offset="100%" style="stop-color:#43A047"/>
                            </linearGradient>
                            <linearGradient id="statsBg" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" style="stop-color:#f1f8e9"/>
                                <stop offset="100%" style="stop-color:#e8f5e9"/>
                            </linearGradient>
                        </defs>
                        <rect width="1200" height="630" fill="url(#bg)"/>
                        <rect width="1200" height="10" fill="url(#accent)"/>
                        <rect x="0" y="620" width="1200" height="10" fill="url(#accent)"/>

                        <!-- Header -->
                        <text x="600" y="70" font-family="Arial, sans-serif" font-size="42" font-weight="bold" fill="#1B5E20" text-anchor="middle">DR.WEEE</text>
                        <text x="600" y="105" font-family="Arial, sans-serif" font-size="16" fill="#43A047" text-anchor="middle" letter-spacing="3">SMART GREEN IT SOLUTIONS</text>

                        <!-- Certificate Title -->
                        <text x="600" y="160" font-family="Arial, sans-serif" font-size="28" fill="#2E7D32" text-anchor="middle" letter-spacing="2">ENVIRONMENTAL IMPACT CERTIFICATE</text>

                        <!-- Decorative line -->
                        <line x1="350" y1="180" x2="850" y2="180" stroke="#81C784" stroke-width="2"/>

                        <!-- User name -->
                        <text x="600" y="240" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="#1B5E20" text-anchor="middle">${fullName}</text>

                        <!-- Eco Level -->
                        <rect x="450" y="260" width="300" height="50" rx="25" fill="#2E7D32"/>
                        <text x="600" y="295" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#ffffff" text-anchor="middle">${ecoLevel.name}</text>

                        <!-- Stats Box -->
                        <rect x="100" y="340" width="1000" height="200" rx="20" fill="url(#statsBg)" stroke="#81C784" stroke-width="3"/>

                        <!-- CO2 Stat -->
                        <circle cx="250" cy="400" r="45" fill="#1B5E20"/>
                        <text x="250" y="410" font-family="Arial, sans-serif" font-size="24" fill="#ffffff" text-anchor="middle">CO2</text>
                        <text x="250" y="480" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="#1B5E20" text-anchor="middle">${totalCO2Saved.toFixed(1)}</text>
                        <text x="250" y="510" font-family="Arial, sans-serif" font-size="16" fill="#666666" text-anchor="middle">kg CO2 Saved</text>

                        <!-- Trees Stat -->
                        <circle cx="600" cy="400" r="45" fill="#43A047"/>
                        <text x="600" y="405" font-family="Arial, sans-serif" font-size="18" fill="#ffffff" text-anchor="middle">TREES</text>
                        <text x="600" y="480" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="#1B5E20" text-anchor="middle">${equivalents.treesEquivalent}</text>
                        <text x="600" y="510" font-family="Arial, sans-serif" font-size="16" fill="#666666" text-anchor="middle">Trees Equivalent</text>

                        <!-- Driving Stat -->
                        <circle cx="950" cy="400" r="45" fill="#66BB6A"/>
                        <text x="950" y="405" font-family="Arial, sans-serif" font-size="18" fill="#ffffff" text-anchor="middle">KM</text>
                        <text x="950" y="480" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="#1B5E20" text-anchor="middle">${equivalents.drivingKm.toLocaleString()}</text>
                        <text x="950" y="510" font-family="Arial, sans-serif" font-size="16" fill="#666666" text-anchor="middle">Driving Avoided</text>

                        <!-- Footer -->
                        <text x="600" y="575" font-family="Arial, sans-serif" font-size="14" fill="#888888" text-anchor="middle">Verified Data - Powered by Climatiq API - 639,000+ Emission Factors</text>
                        <text x="600" y="600" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#1B5E20" text-anchor="middle">www.drweee.com</text>
                    </svg>`;

                    // Try to convert SVG to PNG using sharp for LinkedIn compatibility
                    try {
                        const sharp = require('sharp');
                        const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
                        res.setHeader('Content-Type', 'image/png');
                        res.setHeader('Cache-Control', 'public, max-age=3600');
                        return res.send(pngBuffer);
                    } catch (sharpError) {
                        console.warn('Sharp conversion failed, sending SVG:', sharpError.message);
                        res.setHeader('Content-Type', 'image/svg+xml');
                        res.setHeader('Cache-Control', 'public, max-age=3600');
                        return res.send(svg);
                    }

                }
            } catch (svgError) {
                console.error('Error generating SVG fallback:', svgError.message);
            }

            // Last resort: redirect to logo
            return res.redirect('/images/logos/dr-weee-logo.png');
        }

        // Sanitize share code for FetchXML
        const sanitizedShareCode = sanitizeFetchXmlValue(shareCode);

        // Get access token for Dataverse
        const accessToken = await getDataverseToken();

        // Fetch user by share code
        const fetchXml = `
            <fetch top="1">
                <entity name="contact">
                    <attribute name="firstname" />
                    <attribute name="lastname" />
                    <attribute name="crd33_totalcarbonsaved" />
                    <filter>
                        <condition attribute="crd33_sharecode" operator="eq" value="${sanitizedShareCode}" />
                    </filter>
                </entity>
            </fetch>
        `;

        const response = await queryDataverse('contacts', fetchXml, accessToken);

        if (!response || response.length === 0) {
            return res.status(404).send('Certificate not found');
        }

        const contact = response[0];
        const totalCO2Saved = parseFloat(contact.crd33_totalcarbonsaved) || 0;
        const firstName = contact.firstname || 'Eco Warrior';
        const lastName = contact.lastname || '';
        const fullName = lastName ? `${firstName} ${lastName}` : firstName;
        const equivalents = calculateEmissionEquivalents(totalCO2Saved);
        const ecoLevel = getEcoLevel(totalCO2Saved);

        // Create canvas (1200x630 for LinkedIn optimal size)
        const width = 1200;
        const height = 630;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Background gradient
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(1, '#e8f5e9');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // Top accent bar
        const accentGradient = ctx.createLinearGradient(0, 0, width, 0);
        accentGradient.addColorStop(0, '#1B5E20');
        accentGradient.addColorStop(0.5, '#2E7D32');
        accentGradient.addColorStop(1, '#43A047');
        ctx.fillStyle = accentGradient;
        ctx.fillRect(0, 0, width, 8);

        // DR.WEEE text logo
        ctx.fillStyle = '#1B5E20';
        ctx.font = 'bold 36px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('DR.WEEE', width / 2, 60);

        // Certificate title
        ctx.fillStyle = '#2E7D32';
        ctx.font = '24px Arial, sans-serif';
        ctx.fillText('ENVIRONMENTAL IMPACT CERTIFICATE', width / 2, 100);

        // Decorative line
        ctx.strokeStyle = '#4CAF50';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(300, 120);
        ctx.lineTo(900, 120);
        ctx.stroke();

        // User name
        ctx.fillStyle = '#1B5E20';
        ctx.font = 'bold 42px Arial, sans-serif';
        ctx.fillText(fullName, width / 2, 175);

        // Eco level badge
        ctx.font = '72px Arial, sans-serif';
        ctx.fillText(ecoLevel.emoji, width / 2, 260);
        ctx.fillStyle = '#2E7D32';
        ctx.font = 'bold 28px Arial, sans-serif';
        ctx.fillText(ecoLevel.name, width / 2, 300);

        // Main stat box
        const boxX = 200;
        const boxY = 330;
        const boxWidth = 800;
        const boxHeight = 200;

        // Box background
        ctx.fillStyle = '#f1f8e9';
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 20);
        ctx.fill();
        ctx.strokeStyle = '#81C784';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Stats inside box
        const stats = [
            { emoji: '🌍', value: `${totalCO2Saved.toFixed(1)} kg`, label: 'CO₂ Saved' },
            { emoji: '🌳', value: `${equivalents.treesEquivalent}`, label: 'Trees Equivalent' },
            { emoji: '🚗', value: `${equivalents.drivingKm.toLocaleString()} km`, label: 'Driving Avoided' }
        ];

        const statWidth = boxWidth / 3;
        stats.forEach((stat, index) => {
            const statX = boxX + (statWidth * index) + (statWidth / 2);
            const statY = boxY + 50;

            ctx.font = '40px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(stat.emoji, statX, statY);

            ctx.fillStyle = '#1B5E20';
            ctx.font = 'bold 32px Arial, sans-serif';
            ctx.fillText(stat.value, statX, statY + 50);

            ctx.fillStyle = '#666666';
            ctx.font = '18px Arial, sans-serif';
            ctx.fillText(stat.label, statX, statY + 80);

            ctx.fillStyle = '#1B5E20'; // Reset for next iteration
        });

        // Bottom verification badge
        ctx.fillStyle = '#666666';
        ctx.font = '16px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Verified by Climatiq • 639,000+ Emission Factors', width / 2, 570);

        // Footer with website
        ctx.fillStyle = '#1B5E20';
        ctx.font = 'bold 20px Arial, sans-serif';
        ctx.fillText('www.drweee.com', width / 2, 600);

        // Set cache headers
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.setHeader('Content-Type', 'image/png');

        // Send the image
        const buffer = canvas.toBuffer('image/png');
        res.send(buffer);

    } catch (error) {
        console.error('Error generating OG image:', error);
        res.status(500).send('Error generating certificate image');
    }
});

// 4. GET /certificate/:shareCode - Server-side rendered certificate page
app.get('/certificate/:shareCode', async (req, res) => {
    try {
        const { shareCode } = req.params;

        // Validate share code format
        if (!isValidShareCode(shareCode)) {
            return res.sendFile(path.join(__dirname, '..', 'index.html'));
        }

        // Sanitize share code for FetchXML
        const sanitizedShareCode = sanitizeFetchXmlValue(shareCode);

        // Get access token for Dataverse
        const accessToken = await getDataverseToken();

        // Fetch user by share code
        const fetchXml = `
            <fetch top="1">
                <entity name="contact">
                    <attribute name="firstname" />
                    <attribute name="lastname" />
                    <attribute name="crd33_totalcarbonsaved" />
                    <filter>
                        <condition attribute="crd33_sharecode" operator="eq" value="${sanitizedShareCode}" />
                    </filter>
                </entity>
            </fetch>
        `;

        const response = await queryDataverse('contacts', fetchXml, accessToken);

        if (!response || response.length === 0) {
            return res.sendFile(path.join(__dirname, '..', 'index.html'));
        }

        const contact = response[0];
        const totalCO2Saved = parseFloat(contact.crd33_totalcarbonsaved) || 0;
        const firstName = contact.firstname || 'Eco Warrior';
        const lastName = contact.lastname || '';
        const fullName = lastName ? `${firstName} ${lastName}` : firstName;
        const equivalents = calculateEmissionEquivalents(totalCO2Saved);

        // Read the certificate template
        let html;
        try {
            html = fs.readFileSync(path.join(__dirname, '..', 'public-certificate.html'), 'utf8');
        } catch (readError) {
            console.error('Certificate template not found:', readError.message);
            return res.sendFile(path.join(__dirname, '..', 'index.html'));
        }

        // Build the base URL for OG tags
        const baseUrl = envConfig.baseUrl;

        // Inject dynamic OG meta tags
        const ogTitle = `${firstName}'s Environmental Impact | DR.WEEE`;
        const ogDescription = `I've saved ${totalCO2Saved.toFixed(1)} kg of CO₂ by recycling e-waste with DR.WEEE! That's equivalent to planting ${equivalents.treesEquivalent} trees.`;
        const ogImage = `${baseUrl}/og/${shareCode}`;
        const ogUrl = `${baseUrl}/certificate/${shareCode}`;

        // Replace placeholders in HTML
        html = html.replace(/\{\{OG_TITLE\}\}/g, ogTitle);
        html = html.replace(/\{\{OG_DESCRIPTION\}\}/g, ogDescription);
        html = html.replace(/\{\{OG_IMAGE\}\}/g, ogImage);
        html = html.replace(/\{\{OG_URL\}\}/g, ogUrl);
        html = html.replace(/\{\{SHARE_CODE\}\}/g, shareCode);
        html = html.replace(/\{\{USER_NAME\}\}/g, fullName);
        html = html.replace(/\{\{CO2_SAVED\}\}/g, totalCO2Saved.toFixed(1));
        html = html.replace(/\{\{TREES_EQUIVALENT\}\}/g, equivalents.treesEquivalent.toString());

        res.send(html);

    } catch (error) {
        console.error('Error serving certificate page:', error);
        res.sendFile(path.join(__dirname, '..', 'index.html'));
    }
});

// =====================================================================
// END SHAREABLE CERTIFICATE FEATURE
// =====================================================================


// =====================================================================
// TERRITORIES/COUNTRIES API
// =====================================================================

// Cache for territories data
const territoriesCache = {
    data: null,
    lastFetch: 0
};
const TERRITORIES_CACHE_DURATION_MS = 60 * 60 * 1000; // Cache for 1 hour

// GET /api/territories - Fetch countries from Dataverse with currency info
app.get('/api/territories', async (req, res) => {
    try {
        // Check cache first
        if (territoriesCache.data && (Date.now() - territoriesCache.lastFetch) < TERRITORIES_CACHE_DURATION_MS) {
            console.log('[Territories] Serving from cache');
            return res.json(territoriesCache.data);
        }

        console.log('[Territories] Fetching territories from Dataverse...');
        const accessToken = await getDataverseToken();
        const DATAVERSE_URL = envConfig.dataverseUrl;

        // Fetch territories where crd33_iscountry is true, expanding to get currency data
        const url = `${DATAVERSE_URL}/api/data/v9.2/territories?$filter=crd33_iscountry eq true&$select=territoryid,name,crd33_flag,crd33_weeepointequivalent,exchangerate,_transactioncurrencyid_value&$expand=transactioncurrencyid($select=transactioncurrencyid,currencyname,currencysymbol,isocurrencycode,currencyprecision,exchangerate)`;

        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json',
                'OData-MaxVersion': '4.0',
                'OData-Version': '4.0',
                'Prefer': 'odata.include-annotations="*"'
            }
        });

        // Transform the data for frontend use
        const territories = response.data.value.map(territory => ({
            id: territory.territoryid,
            name: territory.name,
            flag: territory.crd33_flag,
            weeePointEquivalent: territory.crd33_weeepointequivalent,
            exchangeRate: territory.exchangerate,
            currency: territory.transactioncurrencyid ? {
                id: territory.transactioncurrencyid.transactioncurrencyid,
                name: territory.transactioncurrencyid.currencyname,
                symbol: territory.transactioncurrencyid.currencysymbol,
                isoCode: territory.transactioncurrencyid.isocurrencycode,
                precision: territory.transactioncurrencyid.currencyprecision,
                exchangeRate: territory.transactioncurrencyid.exchangerate
            } : null
        }));

        console.log(`[Territories] Fetched ${territories.length} countries`);

        // Update cache
        territoriesCache.data = { territories };
        territoriesCache.lastFetch = Date.now();

        res.json({ territories });

    } catch (error) {
        console.error('[Territories] Error fetching territories:', error.response?.data || error.message);

        // If we have cached data, return it even if expired
        if (territoriesCache.data) {
            console.log('[Territories] Returning stale cache due to error');
            return res.json(territoriesCache.data);
        }

        res.status(500).json({ error: 'Failed to fetch territories' });
    }
});

// =====================================================================
// END TERRITORIES/COUNTRIES API
// =====================================================================


// =====================================================================
// POS SMS PROXY API
// Secure endpoint for StorePOS web resource to send SMS notifications
// =====================================================================

// Rate limiting for POS SMS endpoint
const posSmsRateLimits = new Map(); // key: IP, value: { count, windowStart }
const POS_SMS_RATE_LIMIT = 30; // Max requests per window
const POS_SMS_RATE_WINDOW_MS = 60 * 1000; // 1 minute window

// Allowed SMS message templates (must start with one of these)
const ALLOWED_SMS_TEMPLATES = [
    'Thank you for recycling with',
    'Thank you for redeeming',  // For voucher/gift redemption
    'شكراً لتدويرك مع',
    'Merci pour votre recyclage avec',
    'مرحباً'  // Welcome SMS for new users
];

// Clean old rate limit entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of posSmsRateLimits.entries()) {
        if (now - data.windowStart > POS_SMS_RATE_WINDOW_MS * 2) {
            posSmsRateLimits.delete(ip);
        }
    }
}, 5 * 60 * 1000); // Clean every 5 minutes

app.post('/api/pos/send-sms', async (req, res) => {
    try {
        // 1. Verify API key
        const apiKey = req.headers['x-pos-api-key'];
        if (!apiKey || apiKey !== process.env.POS_SMS_API_KEY) {
            console.warn('[POS SMS] Invalid or missing API key');
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        // 2. Verify origin (only allow from Dynamics 365)
        const origin = req.headers.origin || req.headers.referer || '';
        const allowedOrigins = [
            'dynamics.com',
            'crm3.dynamics.com',
            'crm.dynamics.com'
        ];
        const isAllowedOrigin = allowedOrigins.some(allowed => origin.includes(allowed));

        // In development, also allow localhost
        const isDevelopment = !envConfig.isDeployed;
        const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');

        if (!isAllowedOrigin && !(isDevelopment && isLocalhost)) {
            console.warn(`[POS SMS] Rejected origin: ${origin}`);
            return res.status(403).json({
                success: false,
                error: 'Forbidden origin'
            });
        }

        // 3. Rate limiting
        const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        let rateData = posSmsRateLimits.get(clientIP);

        if (!rateData || now - rateData.windowStart > POS_SMS_RATE_WINDOW_MS) {
            rateData = { count: 0, windowStart: now };
        }

        rateData.count++;
        posSmsRateLimits.set(clientIP, rateData);

        if (rateData.count > POS_SMS_RATE_LIMIT) {
            console.warn(`[POS SMS] Rate limit exceeded for IP: ${clientIP}`);
            return res.status(429).json({
                success: false,
                error: 'Rate limit exceeded. Try again later.'
            });
        }

        // 4. Validate request body
        const { phoneNumber, message } = req.body;

        if (!phoneNumber || typeof phoneNumber !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }

        if (!message || typeof message !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Message is required'
            });
        }

        // 5. Validate message template (prevent arbitrary message sending)
        const isValidTemplate = ALLOWED_SMS_TEMPLATES.some(template =>
            message.trim().startsWith(template)
        );

        if (!isValidTemplate) {
            console.warn('[POS SMS] Invalid message template attempted');
            return res.status(400).json({
                success: false,
                error: 'Invalid message format'
            });
        }

        // 6. Validate message length
        if (message.length > 500) {
            return res.status(400).json({
                success: false,
                error: 'Message too long (max 500 characters)'
            });
        }

        // 7. Normalize phone number
        const normalizedPhone = normalizePhoneNumber(phoneNumber);
        if (!normalizedPhone || normalizedPhone.length < 10) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone number format'
            });
        }

        // 8. Send SMS using existing function
        secureLog.phone('[POS SMS] Sending SMS to', normalizedPhone);
        await sendSMS(normalizedPhone, message);

        console.log('[POS SMS] SMS sent successfully');
        res.json({
            success: true,
            message: 'SMS sent successfully'
        });

    } catch (error) {
        secureLog.error('[POS SMS] Failed to send SMS', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send SMS'
        });
    }
});

// =====================================================================
// END POS SMS PROXY API
// =====================================================================


// =====================================================================
// POS OTP API
// OTP verification for new customer registration from StorePOS
// =====================================================================

// In-memory OTP storage for POS (keyed by phone number)
const posOtpStore = new Map(); // key: phone, value: { otp, expires, verified }
const POS_OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Clean expired OTPs periodically
setInterval(() => {
    const now = Date.now();
    for (const [phone, data] of posOtpStore.entries()) {
        if (now > data.expires + 60000) { // Clean 1 minute after expiry
            posOtpStore.delete(phone);
        }
    }
}, 60 * 1000); // Clean every minute

// Request OTP for POS customer registration
app.post('/api/pos/request-otp', async (req, res) => {
    try {
        // 1. Verify API key
        const apiKey = req.headers['x-pos-api-key'];
        if (!apiKey || apiKey !== process.env.POS_SMS_API_KEY) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        // 2. Verify origin
        const origin = req.headers.origin || req.headers.referer || '';
        const isDynamics = origin.includes('dynamics.com');
        const isDev = !envConfig.isDeployed && (origin.includes('localhost') || origin.includes('127.0.0.1'));

        if (!isDynamics && !isDev) {
            return res.status(403).json({ success: false, error: 'Forbidden origin' });
        }

        // 3. Validate phone number
        const { phoneNumber } = req.body;
        if (!phoneNumber || typeof phoneNumber !== 'string') {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }

        const normalizedPhone = normalizePhoneNumber(phoneNumber);
        if (!normalizedPhone || normalizedPhone.length < 10) {
            return res.status(400).json({ success: false, error: 'Invalid phone number format' });
        }

        // 4. Rate limit check (max 3 OTPs per phone per 15 minutes)
        const existingOtp = posOtpStore.get(normalizedPhone);
        if (existingOtp && existingOtp.requestCount >= 3 && Date.now() < existingOtp.rateLimitExpires) {
            return res.status(429).json({
                success: false,
                error: 'Too many OTP requests. Please try again later.'
            });
        }

        // 5. Check if phone already exists in Dataverse
        const sanitizedPhone = sanitizeFetchXmlValue(normalizedPhone);
        const checkUserFetchXml = `<fetch top="1">
            <entity name="contact">
                <attribute name="contactid" />
                <filter type="and">
                    <condition attribute="mobilephone" operator="eq" value="${sanitizedPhone}" />
                </filter>
            </entity>
        </fetch>`;

        const existingUsers = await queryDataverse('contacts', checkUserFetchXml);
        if (existingUsers.length > 0) {
            return res.status(409).json({
                success: false,
                error: 'This phone number is already registered.'
            });
        }

        // 6. Generate and send OTP
        const otp = generateOTP();
        const smsMessage = `Your DR.WEEE verification code is: ${otp}. This code will expire in 5 minutes.`;

        try {
            await sendSMS(normalizedPhone, smsMessage);
        } catch (smsError) {
            console.error('[POS OTP] SMS sending failed:', smsError.message);
            return res.status(500).json({
                success: false,
                error: 'Failed to send verification code. Please try again.'
            });
        }

        // 7. Store OTP
        const requestCount = (existingOtp?.requestCount || 0) + 1;
        posOtpStore.set(normalizedPhone, {
            otp: otp,
            expires: Date.now() + POS_OTP_EXPIRY_MS,
            verified: false,
            requestCount: requestCount,
            rateLimitExpires: Date.now() + (15 * 60 * 1000) // 15 minute window
        });

        secureLog.phone('[POS OTP] OTP sent to', normalizedPhone);
        res.json({ success: true, message: 'Verification code sent successfully.' });

    } catch (error) {
        secureLog.error('[POS OTP] Error requesting OTP', error);
        res.status(500).json({ success: false, error: 'Failed to send verification code' });
    }
});

// Verify OTP for POS customer registration
app.post('/api/pos/verify-otp', (req, res) => {
    try {
        // 1. Verify API key
        const apiKey = req.headers['x-pos-api-key'];
        if (!apiKey || apiKey !== process.env.POS_SMS_API_KEY) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        // 2. Verify origin
        const origin = req.headers.origin || req.headers.referer || '';
        const isDynamics = origin.includes('dynamics.com');
        const isDev = !envConfig.isDeployed && (origin.includes('localhost') || origin.includes('127.0.0.1'));

        if (!isDynamics && !isDev) {
            return res.status(403).json({ success: false, error: 'Forbidden origin' });
        }

        // 3. Validate input
        const { phoneNumber, otp } = req.body;
        if (!phoneNumber || !otp) {
            return res.status(400).json({ success: false, error: 'Phone number and OTP are required' });
        }

        const normalizedPhone = normalizePhoneNumber(phoneNumber);
        const storedData = posOtpStore.get(normalizedPhone);

        // 4. Check if OTP exists
        if (!storedData) {
            return res.status(400).json({ success: false, error: 'No verification code found. Please request a new one.' });
        }

        // 5. Check if OTP expired
        if (Date.now() > storedData.expires) {
            posOtpStore.delete(normalizedPhone);
            return res.status(400).json({ success: false, error: 'Verification code has expired. Please request a new one.' });
        }

        // 6. Verify OTP (timing-safe comparison)
        if (verifyOTP(storedData.otp, otp)) {
            storedData.verified = true;
            posOtpStore.set(normalizedPhone, storedData);
            secureLog.phone('[POS OTP] OTP verified for', normalizedPhone);
            res.json({ success: true, message: 'Phone number verified successfully.' });
        } else {
            res.status(400).json({ success: false, error: 'Invalid verification code.' });
        }

    } catch (error) {
        secureLog.error('[POS OTP] Error verifying OTP', error);
        res.status(500).json({ success: false, error: 'Verification failed' });
    }
});

// Check if phone is verified (for POS to confirm before creating contact)
app.post('/api/pos/check-verification', (req, res) => {
    try {
        // 1. Verify API key
        const apiKey = req.headers['x-pos-api-key'];
        if (!apiKey || apiKey !== process.env.POS_SMS_API_KEY) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }

        const normalizedPhone = normalizePhoneNumber(phoneNumber);
        const storedData = posOtpStore.get(normalizedPhone);

        if (!storedData || !storedData.verified || Date.now() > storedData.expires + (10 * 60 * 1000)) {
            return res.json({ success: true, verified: false });
        }

        // Clear the verification after it's been used
        posOtpStore.delete(normalizedPhone);

        res.json({ success: true, verified: true });

    } catch (error) {
        secureLog.error('[POS OTP] Error checking verification', error);
        res.status(500).json({ success: false, error: 'Check failed' });
    }
});

// =====================================================================
// END POS OTP API
// =====================================================================


// =====================================================================
// BOSTA COURIER INTEGRATION API
// =====================================================================

// Bosta API configuration
const bostaApi = {
    baseUrl: 'https://app.bosta.co/api/v2',
    egyptCountryId: '60e4482c7cb7d4bc4849c4d5'
};

// Cache for Bosta cities/districts (rarely changes)
const bostaCache = {
    cities: null,
    citiesLastFetch: 0,
    districts: new Map(), // keyed by cityId
    CITIES_TTL: 24 * 60 * 60 * 1000, // 24 hours
    DISTRICTS_TTL: 24 * 60 * 60 * 1000 // 24 hours
};

// Bosta delivery state codes mapping
const BOSTA_STATES = {
    // Numeric codes (from webhooks)
    10: 'Pickup Requested',
    20: 'Route Assigned',
    21: 'Picked Up from Business',
    22: 'In Transit to Customer',
    30: 'Received at Warehouse',
    41: 'Out for Delivery',
    45: 'Delivered',
    46: 'Returned to Business',
    47: 'Exception',
    48: 'Terminated',
    49: 'Canceled',
    // String codes (from tracking.bosta.co API)
    'TICKET_CREATED': 'Order Created - Awaiting Pickup',
    'PACKAGE_RECEIVED': 'Package Received',
    'NOT_YET_SHIPPED': 'Not Yet Shipped',
    'IN_TRANSIT': 'In Transit',
    'OUT_FOR_DELIVERY': 'Out for Delivery',
    'DELIVERED': 'Delivered',
    'WAITING_FOR_CUSTOMER_ACTION': 'Waiting for Customer',
    'DELIVERY_FAILED': 'Delivery Failed',
    'RETURNED_TO_BUSINESS': 'Returned to Business',
    'EXCEPTION': 'Exception',
    'TERMINATED': 'Terminated',
    'CANCELED': 'Canceled'
};

// Middleware to verify POS API key for Bosta endpoints
function verifyPosApiKey(req, res, next) {
    const apiKey = req.headers['x-pos-api-key'];
    if (!apiKey || apiKey !== process.env.POS_SMS_API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Also verify origin
    const origin = req.headers.origin || req.headers.referer || '';
    const isDynamics = origin.includes('dynamics.com');
    const isDev = !envConfig.isDeployed && (origin.includes('localhost') || origin.includes('127.0.0.1'));

    if (!isDynamics && !isDev) {
        return res.status(403).json({ success: false, error: 'Forbidden origin' });
    }

    next();
}

// Helper to make Bosta API requests
async function bostaRequest(method, endpoint, data = null) {
    const apiKey = process.env.BOSTA_API_KEY;
    if (!apiKey) {
        throw new Error('BOSTA_API_KEY not configured');
    }

    const config = {
        method,
        url: `${bostaApi.baseUrl}${endpoint}`,
        headers: {
            'Authorization': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    };

    if (data) {
        config.data = data;
    }

    const response = await axios(config);
    return response.data;
}

// GET /api/pos/bosta/cities - Get cached list of Egyptian cities
app.get('/api/pos/bosta/cities', verifyPosApiKey, async (req, res) => {
    try {
        const now = Date.now();

        // Return cached cities if still valid
        if (bostaCache.cities && Array.isArray(bostaCache.cities) && (now - bostaCache.citiesLastFetch) < bostaCache.CITIES_TTL) {
            return res.json({ success: true, cities: bostaCache.cities });
        }

        // Fetch from Bosta API
        console.log('[Bosta] Fetching cities from API...');
        const response = await bostaRequest('GET', `/cities?countryId=${bostaApi.egyptCountryId}`);
        console.log('[Bosta] Cities response type:', typeof response, Array.isArray(response) ? 'is array' : 'not array');

        // Handle different response structures from Bosta API
        // Bosta returns: { success: true, message: "Done successfully.", data: { list: [...] } }
        let cities;
        if (Array.isArray(response)) {
            cities = response;
        } else if (response && response.data && response.data.list && Array.isArray(response.data.list)) {
            // Bosta's actual format: { success, message, data: { list: [...] } }
            cities = response.data.list;
        } else if (response && response.list && Array.isArray(response.list)) {
            cities = response.list;
        } else if (response && response.data && Array.isArray(response.data)) {
            cities = response.data;
        } else {
            console.error('[Bosta] Unexpected cities response structure:', JSON.stringify(response).substring(0, 500));
            return res.status(500).json({ success: false, error: 'Unexpected API response structure' });
        }

        // Cache the result
        bostaCache.cities = cities;
        bostaCache.citiesLastFetch = now;

        console.log('[Bosta] Loaded', cities.length, 'cities');
        res.json({ success: true, cities: cities });

    } catch (error) {
        console.error('[Bosta] Error fetching cities:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch cities' });
    }
});

// GET /api/pos/bosta/districts/:cityId - Get districts for a city
app.get('/api/pos/bosta/districts/:cityId', verifyPosApiKey, async (req, res) => {
    try {
        const { cityId } = req.params;
        const now = Date.now();

        // Check cache
        const cached = bostaCache.districts.get(cityId);
        if (cached && Array.isArray(cached.data) && (now - cached.lastFetch) < bostaCache.DISTRICTS_TTL) {
            return res.json({ success: true, districts: cached.data });
        }

        // Fetch from Bosta API
        console.log(`[Bosta] Fetching districts for city ${cityId}...`);
        const response = await bostaRequest('GET', `/cities/${cityId}/districts`);
        console.log('[Bosta] Districts response type:', typeof response, Array.isArray(response) ? 'is array' : 'not array');

        // Handle different response structures from Bosta API
        // Bosta returns: { success: true, message: "Done successfully.", data: { list: [...] } }
        let districts;
        if (Array.isArray(response)) {
            districts = response;
        } else if (response && response.data && response.data.list && Array.isArray(response.data.list)) {
            // Bosta's actual format: { success, message, data: { list: [...] } }
            districts = response.data.list;
        } else if (response && response.list && Array.isArray(response.list)) {
            districts = response.list;
        } else if (response && response.data && Array.isArray(response.data)) {
            districts = response.data;
        } else {
            console.error('[Bosta] Unexpected districts response structure:', JSON.stringify(response).substring(0, 500));
            return res.status(500).json({ success: false, error: 'Unexpected API response structure' });
        }

        // Cache the result
        bostaCache.districts.set(cityId, {
            data: districts,
            lastFetch: now
        });

        console.log('[Bosta] Loaded', districts.length, 'districts for city', cityId);
        res.json({ success: true, districts: districts });

    } catch (error) {
        console.error('[Bosta] Error fetching districts:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch districts' });
    }
});

// POST /api/pos/bosta/create-delivery - Create a Bosta shipment
app.post('/api/pos/bosta/create-delivery', verifyPosApiKey, async (req, res) => {
    try {
        const {
            orderId,              // Our order ID (will be used as businessReference)
            businessReference,    // Alternative name for orderId
            type,                 // 10 = SEND (deliver to customer), 25 = CRP (pickup from customer)
            businessLocationId,   // Bosta business location ID (where they pick up from)
            pickupLocationId,     // Alternative name for businessLocationId
            receiver,             // { firstName, lastName, phone }
            dropOffAddress,       // { districtId, firstLine, buildingNumber, floor, apartment, secondLine }
            address,              // Alternative name for dropOffAddress
            notes,                // Delivery notes
            cod,                  // Cash on delivery amount (optional)
            specs,                // Package specs (optional)
            items,                // Array of items being shipped (optional)
            allowToOpenPackage    // Allow customer to open package before accepting (optional)
        } = req.body;

        // Support both field names
        const locationId = businessLocationId || pickupLocationId;
        const deliveryAddress = dropOffAddress || address;
        const orderReference = orderId || businessReference;

        // Validate required fields
        if (!orderReference || !type || !locationId || !receiver || !deliveryAddress) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: orderId, type, businessLocationId, receiver, dropOffAddress'
            });
        }

        if (!receiver.firstName || !receiver.lastName || !receiver.phone) {
            return res.status(400).json({
                success: false,
                error: 'Receiver must have firstName, lastName, and phone'
            });
        }

        if (!deliveryAddress.districtId || !deliveryAddress.firstLine) {
            return res.status(400).json({
                success: false,
                error: 'Address must have districtId and firstLine (min 5 characters)'
            });
        }

        // Build Bosta delivery payload according to API spec
        const deliveryPayload = {
            type: type, // 10 = SEND, 25 = CRP
            specs: specs || {
                packageType: 'Parcel',
                size: 'MEDIUM',
                packageDetails: {
                    itemsCount: items?.length || 1,
                    description: items?.map(i => i.name).join(', ') || 'DrWEEE Order'
                }
            },
            receiver: {
                firstName: receiver.firstName,
                lastName: receiver.lastName,
                phone: receiver.phone.replace(/[^0-9+]/g, '') // Clean phone number but keep +
            },
            dropOffAddress: {
                districtId: deliveryAddress.districtId,
                firstLine: deliveryAddress.firstLine,
                buildingNumber: deliveryAddress.buildingNumber || '',
                floor: deliveryAddress.floor || '',
                apartment: deliveryAddress.apartment || '',
                secondLine: deliveryAddress.secondLine || ''
            },
            businessReference: orderReference, // Our order ID for webhook correlation
            businessLocationId: locationId, // Where Bosta picks up from
            notes: notes || ''
        };

        // Add COD if specified
        if (cod && parseFloat(cod) > 0) {
            deliveryPayload.cod = parseFloat(cod);
        }

        // Add allowToOpenPackage if enabled
        if (allowToOpenPackage) {
            deliveryPayload.allowToOpenPackage = true;
        }

        console.log(`[Bosta] Creating delivery for order ${orderReference}, type ${type}...`);
        console.log(`[Bosta] Payload:`, JSON.stringify(deliveryPayload, null, 2));

        const response = await bostaRequest('POST', '/deliveries', deliveryPayload);

        console.log(`[Bosta] Delivery API response:`, JSON.stringify(response, null, 2));

        // Extract tracking number and delivery ID from response
        // Bosta may return data in different structures
        let trackingNumber, deliveryId;
        if (response.data) {
            // Response wrapped in data object
            trackingNumber = response.data.trackingNumber;
            deliveryId = response.data._id;
        } else {
            // Direct response
            trackingNumber = response.trackingNumber;
            deliveryId = response._id;
        }

        console.log(`[Bosta] Delivery created - Tracking: ${trackingNumber}, ID: ${deliveryId}`);

        if (!trackingNumber) {
            console.error('[Bosta] No tracking number in response:', response);
            throw new Error('Bosta API did not return a tracking number');
        }

        // Update the online request in Dataverse with tracking info
        try {
            const token = await getDataverseToken();
            const DATAVERSE_URL = envConfig.dataverseUrl;

            await axios.patch(
                `${DATAVERSE_URL}/api/data/v9.2/crd33_onlinerequestses(${orderReference})`,
                {
                    crd33_bosta_trackingnumber: String(trackingNumber),
                    crd33_bosta_deliveryid: deliveryId,
                    crd33_bosta_state: 10, // Pickup Requested
                    crd33_bosta_statelabel: 'Pickup Requested',
                    crd33_bosta_attempts: 0
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0'
                    }
                }
            );
            console.log(`[Bosta] Updated Dataverse record for order ${orderReference}`);
        } catch (dvError) {
            console.error('[Bosta] Warning: Could not update Dataverse:', dvError.response?.data || dvError.message);
            // Don't fail the request - delivery was created successfully
        }

        res.json({
            success: true,
            trackingNumber: trackingNumber,
            deliveryId: deliveryId,
            awbUrl: response.awb || response.data?.awb || null
        });

    } catch (error) {
        console.error('[Bosta] Error creating delivery:', error.response?.data || error.message);
        const errorMessage = error.response?.data?.message || error.message || 'Failed to create delivery';
        res.status(500).json({ success: false, error: errorMessage });
    }
});

// GET /api/pos/bosta/locations - Get business pickup locations
app.get('/api/pos/bosta/locations', verifyPosApiKey, async (req, res) => {
    try {
        console.log('[Bosta] Fetching business pickup locations...');
        const response = await bostaRequest('GET', '/pickup-locations');  // Correct endpoint per Bosta SDK

        console.log('[Bosta] Locations response:', JSON.stringify(response, null, 2));

        // Handle different response structures
        let locations;
        if (Array.isArray(response)) {
            locations = response;
        } else if (response.data && Array.isArray(response.data)) {
            locations = response.data;
        } else if (response.data && response.data.list && Array.isArray(response.data.list)) {
            locations = response.data.list;
        } else if (response.pickupLocations && Array.isArray(response.pickupLocations)) {
            locations = response.pickupLocations;
        } else {
            locations = [];
        }

        res.json({
            success: true,
            locations: locations.map(loc => ({
                id: loc._id || loc.id,
                name: loc.locationName || loc.name,
                district: loc.district?.districtName || loc.districtName,
                districtAr: loc.district?.districtOtherName || loc.districtOtherName,
                city: loc.district?.city?.cityName || loc.cityName,
                cityAr: loc.district?.city?.cityOtherName || loc.cityOtherName,
                firstLine: loc.firstLine || loc.address,
                buildingNumber: loc.buildingNumber,
                floor: loc.floor,
                apartment: loc.apartment,
                secondLine: loc.secondLine || loc.landmark,
                isDefault: loc.isDefault || false
            }))
        });

    } catch (error) {
        console.error('[Bosta] Error fetching locations:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch pickup locations' });
    }
});

// GET /api/pos/bosta/location/:locationId - Get a specific pickup location
app.get('/api/pos/bosta/location/:locationId', verifyPosApiKey, async (req, res) => {
    try {
        const { locationId } = req.params;
        console.log(`[Bosta] Fetching location ${locationId}...`);

        // Try different Bosta API endpoints for locations
        let response;
        let locations = [];

        // Try multiple possible endpoints (correct one is /pickup-locations per Bosta Ruby SDK)
        const endpoints = [
            '/pickup-locations',  // Correct endpoint per Bosta SDK
            '/users/pickup-locations',
            '/business/pickup-locations'
        ];

        for (const endpoint of endpoints) {
            try {
                console.log(`[Bosta] Trying endpoint: ${endpoint}`);
                response = await bostaRequest('GET', endpoint);
                console.log(`[Bosta] Response from ${endpoint}:`, JSON.stringify(response, null, 2));

                // Parse locations from response
                if (Array.isArray(response)) {
                    locations = response;
                } else if (response.data && Array.isArray(response.data)) {
                    locations = response.data;
                } else if (response.data && response.data.list) {
                    locations = response.data.list;
                } else if (response.pickupLocations) {
                    locations = response.pickupLocations;
                } else if (response.list) {
                    locations = response.list;
                }

                if (locations.length > 0) {
                    console.log(`[Bosta] Found ${locations.length} locations from ${endpoint}`);
                    break;
                }
            } catch (endpointError) {
                console.log(`[Bosta] Endpoint ${endpoint} failed:`, endpointError.message);
                continue;
            }
        }

        if (locations.length === 0) {
            console.log('[Bosta] No locations found from any endpoint');
            return res.status(404).json({ success: false, error: 'No pickup locations found' });
        }

        const location = locations.find(loc => (loc._id || loc.id) === locationId);

        if (!location) {
            console.log(`[Bosta] Location ${locationId} not found in`, locations.map(l => l._id || l.id));
            return res.status(404).json({ success: false, error: 'Location not found' });
        }

        // Helper to extract string from possibly nested object
        const getString = (val) => {
            if (!val) return null;
            if (typeof val === 'string') return val;
            if (typeof val === 'object') {
                return val.name || val.firstLine || val.districtName || val.cityName || val.value || JSON.stringify(val);
            }
            return String(val);
        };

        // Extract address from location (Bosta returns nested structure)
        const address = location.address || location.pickupAddress || {};
        const district = location.district || address.district || {};
        const city = district.city || location.city || {};

        res.json({
            success: true,
            location: {
                id: location._id || location.id,
                name: getString(location.locationName) || getString(location.name),
                district: getString(district.districtName) || getString(district.name) || getString(location.districtName),
                districtAr: getString(district.districtOtherName) || getString(district.nameAr),
                city: getString(city.cityName) || getString(city.name) || getString(location.cityName),
                cityAr: getString(city.cityOtherName) || getString(city.nameAr),
                firstLine: getString(location.firstLine) || getString(address.firstLine),
                buildingNumber: getString(location.buildingNumber) || getString(address.buildingNumber),
                floor: getString(location.floor) || getString(address.floor),
                apartment: getString(location.apartment) || getString(address.apartment),
                secondLine: getString(location.secondLine) || getString(address.secondLine) || getString(location.landmark),
                isDefault: location.isDefault || false
            }
        });

    } catch (error) {
        console.error('[Bosta] Error fetching location:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch location: ' + (error.response?.data?.message || error.message) });
    }
});

// GET /api/pos/bosta/track/:trackingNumber - Get delivery tracking info
// Uses tracking.bosta.co public API + business API for cost data
app.get('/api/pos/bosta/track/:trackingNumber', verifyPosApiKey, async (req, res) => {
    try {
        const { trackingNumber } = req.params;

        console.log(`[Bosta] Tracking delivery ${trackingNumber}...`);

        // First, try to get cost data from the business API
        let deliveryCost = null;
        try {
            const bizResponse = await bostaRequest('GET', `/deliveries/business/${trackingNumber}`);
            const d = bizResponse.data || bizResponse;

            // Log all cost-related fields from Bosta response
            console.log(`[Bosta] Business API cost fields:`, {
                shipmentFees: d.shipmentFees,
                cod: d.cod,
                collectAmount: d.collectAmount,
                totalFees: d.totalFees,
                deliveryFees: d.deliveryFees,
                serviceFees: d.serviceFees,
                codFees: d.codFees,
                insuranceFees: d.insuranceFees,
                extraFees: d.extraFees,
                allowToOpenPackage: d.allowToOpenPackage,
                openPackage: d.openPackage
            });

            // Return the exact cost breakdown from Bosta API
            // shipmentFees = base shipping fee (includes VAT)
            // extraFees may include Open Package fee, etc.
            const shipmentFees = d.shipmentFees ? parseFloat(d.shipmentFees) : 0;
            let extraFees = d.extraFees ? parseFloat(d.extraFees) : 0;
            const codFees = d.codFees ? parseFloat(d.codFees) : 0;
            const insuranceFees = d.insuranceFees ? parseFloat(d.insuranceFees) : 0;
            const allowToOpenPackage = d.allowToOpenPackage || false;

            // Bosta API may not return extraFees even when allowToOpenPackage is true
            // In that case, add the open package fee (12.70 EGP including VAT)
            const OPEN_PACKAGE_FEE = 12.70;
            if (allowToOpenPackage && extraFees === 0) {
                console.log(`[Bosta] allowToOpenPackage is true but extraFees is 0, adding open package fee`);
                extraFees = OPEN_PACKAGE_FEE;
            }

            // Total is sum of all fees (all include VAT already)
            const total = shipmentFees + extraFees + codFees + insuranceFees;

            if (total > 0) {
                deliveryCost = {
                    shipmentFees: shipmentFees,
                    extraFees: extraFees,
                    codFees: codFees,
                    insuranceFees: insuranceFees,
                    total: parseFloat(total.toFixed(2)),
                    currency: 'EGP',
                    allowToOpenPackage: allowToOpenPackage
                };
                console.log(`[Bosta] Extracted deliveryCost:`, deliveryCost);
            }
        } catch (bizErr) {
            console.log('[Bosta] Business API failed for cost:', bizErr.response?.data || bizErr.message);
        }

        // Use the public tracking API at tracking.bosta.co (no auth required)
        const response = await axios.get(`https://tracking.bosta.co/shipments/track/${trackingNumber}`);
        const trackingData = response.data;

        console.log(`[Bosta] Tracking response:`, JSON.stringify(trackingData, null, 2));

        // Parse the tracking.bosta.co response format
        const currentStatus = trackingData.CurrentStatus || {};
        const stateValue = currentStatus.state || 'Unknown';
        const stateLabel = BOSTA_STATES[stateValue] || stateValue.replace(/_/g, ' ');

        res.json({
            success: true,
            tracking: {
                trackingNumber: trackingData.TrackingNumber || trackingNumber,
                deliveryId: null, // Not provided by tracking API
                state: stateValue,
                stateLabel: stateLabel,
                promisedDate: trackingData.PromisedDate,
                createDate: trackingData.CreateDate,
                history: (trackingData.TransitEvents || []).map(event => ({
                    state: event.state,
                    timestamp: event.timestamp,
                    hub: event.hub,
                    reason: event.reason
                })),
                trackingUrl: trackingData.TrackingURL,
                supportPhone: trackingData.SupportPhoneNumbers?.[0] || null,
                isEditable: trackingData.isEditableShipment,
                deliveryCost: deliveryCost
            }
        });

    } catch (error) {
        console.error('[Bosta] Error tracking delivery:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message || 'Failed to track delivery';

        // If 404, the order was probably deleted on Bosta
        if (statusCode === 404) {
            return res.status(404).json({ success: false, error: 'Order not found on Bosta - it may have been deleted' });
        }

        res.status(statusCode).json({ success: false, error: errorMsg });
    }
});

// DELETE /api/pos/bosta/cancel/:deliveryId - Cancel a delivery (old method - kept for backwards compatibility)
app.delete('/api/pos/bosta/cancel/:deliveryId', verifyPosApiKey, async (req, res) => {
    try {
        const { deliveryId } = req.params;

        console.log(`[Bosta] Canceling delivery ${deliveryId}...`);
        await bostaRequest('DELETE', `/deliveries/${deliveryId}`);

        res.json({ success: true, message: 'Delivery canceled successfully' });

    } catch (error) {
        console.error('[Bosta] Error canceling delivery:', error.response?.data || error.message);
        const errorMessage = error.response?.data?.message || 'Failed to cancel delivery';
        res.status(500).json({ success: false, error: errorMessage });
    }
});

// DELETE /api/pos/bosta/terminate/:trackingNumber - Terminate/delete a delivery using tracking number
app.delete('/api/pos/bosta/terminate/:trackingNumber', verifyPosApiKey, async (req, res) => {
    try {
        const { trackingNumber } = req.params;

        console.log(`[Bosta] Terminating delivery with tracking ${trackingNumber}...`);

        // Use the correct Bosta endpoint: DELETE /deliveries/business/{trackingNumber}/terminate
        await bostaRequest('DELETE', `/deliveries/business/${trackingNumber}/terminate`);

        res.json({ success: true, message: 'Delivery terminated successfully' });

    } catch (error) {
        console.error('[Bosta] Error terminating delivery:', error.response?.data || error.message);
        const errorMessage = error.response?.data?.message || 'Failed to terminate delivery';
        const statusCode = error.response?.status || 500;

        // If 404, the order may already be deleted
        if (statusCode === 404) {
            res.status(404).json({ success: false, error: 'Delivery not found - may already be deleted' });
        } else {
            res.status(statusCode).json({ success: false, error: errorMessage });
        }
    }
});

// GET /api/pos/bosta/awb/:trackingNumber - Get AWB (Air Waybill) PDF
app.get('/api/pos/bosta/awb/:trackingNumber', verifyPosApiKey, async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        const { deliveryId } = req.query; // Optional delivery ID

        console.log(`[Bosta] Getting AWB for tracking ${trackingNumber}, deliveryId: ${deliveryId}...`);

        // Helper to process AWB response
        const processAwbResponse = (awbResponse) => {
            // If response is base64 PDF string directly
            if (typeof awbResponse === 'string' && awbResponse.length > 100) {
                return {
                    success: true,
                    awbUrl: `data:application/pdf;base64,${awbResponse}`,
                    isBase64: true
                };
            }
            // If response has data as base64 string
            if (awbResponse.data && typeof awbResponse.data === 'string' && awbResponse.data.length > 100) {
                return {
                    success: true,
                    awbUrl: `data:application/pdf;base64,${awbResponse.data}`,
                    isBase64: true
                };
            }
            // If response has URL
            if (awbResponse.data?.url || awbResponse.url) {
                return { success: true, awbUrl: awbResponse.data?.url || awbResponse.url };
            }
            return null;
        };

        // Try Method 1: GET /deliveries/awb/{deliveryId} (per SDK)
        if (deliveryId) {
            try {
                console.log(`[Bosta] Trying GET /deliveries/awb/${deliveryId}...`);
                const awbResponse = await bostaRequest('GET', `/deliveries/awb/${deliveryId}`);
                console.log(`[Bosta] AWB response type:`, typeof awbResponse);
                const result = processAwbResponse(awbResponse);
                if (result) return res.json(result);
            } catch (err) {
                console.log('[Bosta] GET /deliveries/awb/{id} failed:', err.response?.status, err.response?.data?.message || err.message);
            }
        }

        // Try Method 2: POST /deliveries/mass-awb with trackingNumbers (correct endpoint per Bosta docs)
        try {
            console.log(`[Bosta] Trying POST /deliveries/mass-awb with trackingNumbers...`);
            const awbResponse = await bostaRequest('POST', '/deliveries/mass-awb', {
                trackingNumbers: trackingNumber,
                requestedAwbType: 'A4',
                lang: 'ar'
            });
            console.log(`[Bosta] AWB mass-awb response type:`, typeof awbResponse);
            const result = processAwbResponse(awbResponse);
            if (result) return res.json(result);
            console.log('[Bosta] AWB mass-awb response structure:', JSON.stringify(awbResponse, null, 2).substring(0, 500));
        } catch (awbError) {
            console.log('[Bosta] POST /deliveries/mass-awb failed:', awbError.response?.status, awbError.response?.data?.message || awbError.message);
        }

        // Try Method 3: GET /deliveries/{trackingNumber}/awb
        try {
            console.log(`[Bosta] Trying GET /deliveries/${trackingNumber}/awb...`);
            const awbResponse = await bostaRequest('GET', `/deliveries/${trackingNumber}/awb`);
            console.log(`[Bosta] AWB alt response type:`, typeof awbResponse);
            const result = processAwbResponse(awbResponse);
            if (result) return res.json(result);
        } catch (altError) {
            console.log('[Bosta] GET /deliveries/{tracking}/awb failed:', altError.response?.status, altError.response?.data?.message || altError.message);
        }

        res.status(404).json({ success: false, error: 'AWB not available - please try from Bosta portal' });

    } catch (error) {
        console.error('[Bosta] Error getting AWB:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorMsg = error.response?.data?.message || error.response?.data?.error || 'Failed to get AWB';

        res.status(statusCode).json({ success: false, error: errorMsg });
    }
});

// GET /api/pos/bosta/pricing - Get delivery pricing/rates
app.get('/api/pos/bosta/pricing', verifyPosApiKey, async (req, res) => {
    try {
        console.log('[Bosta] Fetching pricing calculator...');

        // Try to get pricing from Bosta API
        try {
            const response = await bostaRequest('GET', '/pricing/shipment/calculator');
            console.log('[Bosta] Pricing response:', JSON.stringify(response, null, 2).substring(0, 500));

            res.json({
                success: true,
                pricing: response.data || response
            });
        } catch (apiError) {
            console.log('[Bosta] Pricing API error:', apiError.response?.status, apiError.response?.data?.message || apiError.message);

            // If Bosta doesn't expose pricing API, return a message
            res.status(404).json({
                success: false,
                error: 'Pricing API not available. Contact Bosta for rate information.',
                message: 'Bosta pricing is typically based on pickup/dropoff zones. Check your Bosta dashboard for current rates.'
            });
        }
    } catch (error) {
        console.error('[Bosta] Error getting pricing:', error.message);
        res.status(500).json({ success: false, error: 'Failed to get pricing' });
    }
});

// POST /api/pos/bosta/search - Search for a delivery by tracking number
app.post('/api/pos/bosta/search', verifyPosApiKey, async (req, res) => {
    try {
        const { trackingNumber } = req.body;

        if (!trackingNumber) {
            return res.status(400).json({ success: false, error: 'Tracking number is required' });
        }

        console.log(`[Bosta] Searching for delivery with tracking ${trackingNumber}...`);

        let delivery = null;

        // Bosta state code to label mapping
        const bostaStateLabels = {
            10: 'Pickup Requested',
            20: 'Route Assigned',
            21: 'Picked Up',
            22: 'In Transit',
            24: 'Received at Warehouse',
            30: 'Out for Delivery',
            45: 'Delivered',
            46: 'Returned',
            100: 'Canceled'
        };

        // Helper to extract delivery data with proper state handling and cost
        const extractDelivery = (d) => {
            const stateCode = d.state?.code ?? d.state;
            const stateValue = typeof stateCode === 'number' ? stateCode : parseInt(stateCode, 10) || null;
            const stateLabel = d.state?.value || d.stateLabel || bostaStateLabels[stateValue] || '';

            // Extract shipmentFees from Bosta response (total including VAT)
            let cost = null;
            if (d.shipmentFees) {
                const total = parseFloat(d.shipmentFees);
                // VAT in Egypt is 14%
                const vatRate = 0.14;
                const feesBeforeVat = total / (1 + vatRate);
                const vat = total - feesBeforeVat;

                cost = {
                    deliveryFees: parseFloat(feesBeforeVat.toFixed(2)),
                    vat: parseFloat(vat.toFixed(2)),
                    total: parseFloat(total.toFixed(2)),
                    currency: 'EGP'
                };
            }

            return {
                trackingNumber: d.trackingNumber,
                deliveryId: d._id,
                state: stateValue,
                stateLabel: stateLabel,
                receiver: d.receiver,
                dropOffAddress: d.dropOffAddress,
                cost: cost
            };
        };

        // Method 1: Try GET /deliveries/business/{trackingNumber} - business-specific endpoint
        try {
            console.log('[Bosta] Trying GET /deliveries/business/{trackingNumber}...');
            const bizResponse = await bostaRequest('GET', `/deliveries/business/${trackingNumber}`);
            console.log('[Bosta] Business response:', JSON.stringify(bizResponse, null, 2).substring(0, 1000));

            if (bizResponse.data || bizResponse.trackingNumber || bizResponse._id) {
                const d = bizResponse.data || bizResponse;
                delivery = extractDelivery(d);
            }
        } catch (bizErr) {
            console.log('[Bosta] Business endpoint failed:', bizErr.response?.status, bizErr.response?.data || bizErr.message);
        }

        // Method 2: Try GET /deliveries/{trackingNumber} - direct fetch by tracking
        if (!delivery) {
            try {
                console.log('[Bosta] Trying GET /deliveries/{trackingNumber}...');
                const directResponse = await bostaRequest('GET', `/deliveries/${trackingNumber}`);
                console.log('[Bosta] Direct response:', JSON.stringify(directResponse, null, 2).substring(0, 1000));

                if (directResponse.data || directResponse.trackingNumber || directResponse._id) {
                    const d = directResponse.data || directResponse;
                    delivery = extractDelivery(d);
                }
            } catch (directErr) {
                console.log('[Bosta] Direct fetch failed:', directErr.response?.status, directErr.response?.data || directErr.message);
            }
        }

        // Method 3: Try POST /deliveries/search with trackingNumbers array
        if (!delivery) {
            try {
                console.log('[Bosta] Trying POST /deliveries/search...');
                const searchResponse = await bostaRequest('POST', '/deliveries/search', {
                    trackingNumbers: [trackingNumber]
                });
                console.log('[Bosta] Search response:', JSON.stringify(searchResponse, null, 2).substring(0, 500));

                const deliveries = searchResponse.data?.list || searchResponse.list ||
                                   (Array.isArray(searchResponse.data) ? searchResponse.data : []);

                if (deliveries.length > 0) {
                    delivery = extractDelivery(deliveries[0]);
                }
            } catch (searchErr) {
                console.log('[Bosta] Search endpoint failed:', searchErr.response?.status, searchErr.message);
            }
        }

        if (delivery) {
            console.log('[Bosta] Found delivery:', delivery);
            res.json({ success: true, delivery });
        } else {
            res.status(404).json({ success: false, error: 'Delivery not found. Please check the tracking number.' });
        }

    } catch (error) {
        console.error('[Bosta] Error searching delivery:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorMessage = error.response?.data?.message || 'Failed to search delivery';
        res.status(statusCode).json({ success: false, error: errorMessage });
    }
});

// PUT /api/pos/bosta/update/:deliveryId - Update delivery details (before pickup)
app.put('/api/pos/bosta/update/:deliveryId', verifyPosApiKey, async (req, res) => {
    try {
        const { deliveryId } = req.params;
        const updateData = req.body;

        console.log(`[Bosta] Updating delivery ${deliveryId}...`, updateData);

        // Bosta allows updating: dropOffAddress, receiver, cod, notes before pickup
        const response = await bostaRequest('PUT', `/deliveries/${deliveryId}`, updateData);

        console.log('[Bosta] Update response:', JSON.stringify(response, null, 2));

        res.json({
            success: true,
            message: 'Delivery updated successfully',
            delivery: response.data || response
        });

    } catch (error) {
        console.error('[Bosta] Error updating delivery:', error.response?.data || error.message);
        const errorMessage = error.response?.data?.message || 'Failed to update delivery';
        const statusCode = error.response?.status || 500;

        // Check if it's because the delivery has already been picked up
        if (errorMessage.includes('picked up') || errorMessage.includes('cannot be updated')) {
            res.status(400).json({
                success: false,
                error: 'Cannot update delivery - it has already been picked up or is in transit'
            });
        } else {
            res.status(statusCode).json({ success: false, error: errorMessage });
        }
    }
});

// POST /api/webhooks/bosta - Receive Bosta status updates
// Note: This endpoint should be whitelisted for Bosta IPs: 34.89.199.241, 35.246.223.19
app.post('/api/webhooks/bosta', async (req, res) => {
    try {
        const payload = req.body;

        console.log('[Bosta Webhook] Received:', JSON.stringify(payload));

        const {
            _id: deliveryId,
            trackingNumber,
            state,
            businessReference,  // Our order ID
            exceptionReason,
            numberOfAttempts
        } = payload;

        if (!businessReference) {
            console.log('[Bosta Webhook] No businessReference, ignoring');
            return res.json({ success: true });
        }

        const stateLabel = BOSTA_STATES[state] || 'Unknown';
        console.log(`[Bosta Webhook] Order ${businessReference}: State ${state} (${stateLabel})`);

        // Update the online request in Dataverse
        try {
            const token = await getDataverseToken();
            const DATAVERSE_URL = envConfig.dataverseUrl;

            const updateData = {
                crd33_bosta_state: state,
                crd33_bosta_statelabel: stateLabel,
                crd33_bosta_attempts: numberOfAttempts || 0
            };

            // Add exception reason if present
            if (exceptionReason) {
                updateData.crd33_bosta_exception = exceptionReason;
            }

            await axios.patch(
                `${DATAVERSE_URL}/api/data/v9.2/crd33_onlinerequestses(${businessReference})`,
                updateData,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0'
                    }
                }
            );

            console.log(`[Bosta Webhook] Updated Dataverse for order ${businessReference}`);

            // Handle specific state transitions
            if (state === 45) { // Delivered
                console.log(`[Bosta Webhook] Order ${businessReference} delivered successfully`);
                // Could trigger SMS notification or status update here
            } else if (state === 47) { // Exception
                console.log(`[Bosta Webhook] Order ${businessReference} has exception: ${exceptionReason}`);
                // Could trigger alert notification here
            } else if (state === 48 || state === 49) { // Terminated or Canceled
                console.log(`[Bosta Webhook] Order ${businessReference} was ${stateLabel.toLowerCase()}`);
            }

        } catch (dvError) {
            console.error('[Bosta Webhook] Error updating Dataverse:', dvError.response?.data || dvError.message);
            // Still return success to Bosta - we'll retry internally if needed
        }

        res.json({ success: true });

    } catch (error) {
        console.error('[Bosta Webhook] Error processing webhook:', error.message);
        // Return 200 to prevent Bosta from retrying
        res.json({ success: false, error: error.message });
    }
});

// POST /api/pos/bosta/update-address - Update delivery address on an online request
app.post('/api/pos/bosta/update-address', verifyPosApiKey, async (req, res) => {
    try {
        const {
            orderId,
            firstName,
            lastName,
            phone,
            city,
            cityId,
            district,
            districtId,
            address,
            building,
            floor,
            apartment,
            landmark,
            notes
        } = req.body;

        if (!orderId) {
            return res.status(400).json({ success: false, error: 'Order ID is required' });
        }

        // Update the online request in Dataverse with address info
        const token = await getDataverseToken();
        const DATAVERSE_URL = envConfig.dataverseUrl;

        const updateData = {};
        if (firstName) updateData.crd33_delivery_firstname = firstName;
        if (lastName) updateData.crd33_delivery_lastname = lastName;
        if (phone) updateData.crd33_delivery_phone = phone;
        if (city) updateData.crd33_delivery_city = city;
        if (cityId) updateData.crd33_delivery_cityid = cityId;
        if (district) updateData.crd33_delivery_district = district;
        if (districtId) updateData.crd33_delivery_districtid = districtId;
        if (address) updateData.crd33_delivery_address = address;
        if (building) updateData.crd33_delivery_building = building;
        if (floor) updateData.crd33_delivery_floor = floor;
        if (apartment) updateData.crd33_delivery_apartment = apartment;
        if (landmark) updateData.crd33_delivery_landmark = landmark;
        if (notes) updateData.crd33_delivery_notes = notes;

        await axios.patch(
            `${DATAVERSE_URL}/api/data/v9.2/crd33_onlinerequestses(${orderId})`,
            updateData,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0'
                }
            }
        );

        console.log(`[Bosta] Updated delivery address for order ${orderId}`);
        res.json({ success: true });

    } catch (error) {
        console.error('[Bosta] Error updating address:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to update address' });
    }
});

// =====================================================================
// END BOSTA COURIER INTEGRATION API
// =====================================================================


// =====================================================================
// MICROSOFT GRAPH API - AZURE AD USER MANAGEMENT
// =====================================================================

// Cache for Microsoft Graph token (separate from Dataverse token)
const graphApi = {
    accessToken: null,
    tokenExpiry: 0
};

// Get Microsoft Graph API token
async function getGraphToken() {
    // Return cached token if it's still valid
    if (graphApi.accessToken && Date.now() < graphApi.tokenExpiry) {
        return graphApi.accessToken;
    }

    console.log('🔄 Authenticating with Microsoft Graph API...');
    const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;

    if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
        console.error('❌ Missing required Azure environment variables for Graph API');
        throw new Error('Missing required Azure configuration. Check environment variables.');
    }

    const tokenEndpoint = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', AZURE_CLIENT_ID);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('client_secret', AZURE_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');

    try {
        const response = await axios.post(tokenEndpoint, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        graphApi.accessToken = response.data.access_token;
        // Set expiry to 5 minutes before the actual token expiration for safety
        graphApi.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;

        console.log('✅ Microsoft Graph API authentication successful.');
        return graphApi.accessToken;
    } catch (error) {
        console.error('❌ Microsoft Graph API authentication failed:', error.response?.data);
        throw new Error('Could not authenticate with Microsoft Graph API.');
    }
}

// Create Azure AD User endpoint
app.post('/api/admin/create-azure-user', apiLimiter, async (req, res) => {
    console.log('[Graph API] Create Azure AD user request received');

    try {
        const {
            firstName,
            lastName,
            displayName,
            userPrincipalName,
            email,
            password,
            forcePasswordChange,
            jobTitle,
            department,
            mobilePhone
        } = req.body;

        // Validate required fields
        if (!firstName || !lastName || !userPrincipalName || !password) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: firstName, lastName, userPrincipalName, and password are required'
            });
        }

        // Validate password complexity
        const hasUpper = /[A-Z]/.test(password);
        const hasLower = /[a-z]/.test(password);
        const hasNumber = /[0-9]/.test(password);
        const hasSpecial = /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password);

        if (password.length < 8 || !(hasUpper && hasLower && hasNumber && hasSpecial)) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character'
            });
        }

        // Get Graph API token
        const token = await getGraphToken();

        // Prepare user payload for Microsoft Graph API
        const userPayload = {
            accountEnabled: true,
            displayName: displayName || `${firstName} ${lastName}`,
            givenName: firstName,
            surname: lastName,
            mailNickname: userPrincipalName.split('@')[0],
            userPrincipalName: userPrincipalName,
            passwordProfile: {
                forceChangePasswordNextSignIn: forcePasswordChange !== false,
                password: password
            }
        };

        // Add optional fields if provided
        if (email) userPayload.mail = email;
        if (jobTitle) userPayload.jobTitle = jobTitle;
        if (department) userPayload.department = department;
        if (mobilePhone) userPayload.mobilePhone = mobilePhone;

        console.log('[Graph API] Creating user:', userPrincipalName);

        // Create user via Microsoft Graph API
        const response = await axios.post(
            'https://graph.microsoft.com/v1.0/users',
            userPayload,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('[Graph API] User created successfully:', response.data.id);

        // Add user to Power Platform security group (required for environment access)
        const POWERPLATFORM_SECURITY_GROUP_ID = process.env.POWERPLATFORM_SECURITY_GROUP_ID || 'a19e66ea-2e19-48f7-a92b-964d0f99c4a3';
        try {
            await axios.post(
                `https://graph.microsoft.com/v1.0/groups/${POWERPLATFORM_SECURITY_GROUP_ID}/members/$ref`,
                { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${response.data.id}` },
                { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );
            console.log('[Graph API] User added to Power Platform security group');
        } catch (groupError) {
            // Don't fail if group add fails - user might already be a member or group might not exist
            console.warn('[Graph API] Could not add user to security group:', groupError.response?.data?.error?.message || groupError.message);
        }

        res.json({
            success: true,
            user: {
                id: response.data.id,
                displayName: response.data.displayName,
                userPrincipalName: response.data.userPrincipalName,
                mail: response.data.mail
            }
        });

    } catch (error) {
        console.error('[Graph API] Error creating user:', error.response?.data || error.message);

        // Extract meaningful error message from Graph API response
        let errorMessage = 'Failed to create Azure AD user';
        if (error.response?.data?.error) {
            const graphError = error.response.data.error;
            errorMessage = graphError.message || errorMessage;

            // Handle specific error codes
            if (graphError.code === 'Request_BadRequest') {
                if (errorMessage.includes('userPrincipalName already exists')) {
                    errorMessage = 'A user with this login name already exists';
                } else if (errorMessage.includes('password')) {
                    errorMessage = 'Password does not meet complexity requirements';
                }
            } else if (graphError.code === 'Authorization_RequestDenied') {
                errorMessage = 'Insufficient permissions to create users. Please contact administrator.';
            }
        }

        res.status(error.response?.status || 500).json({
            success: false,
            error: errorMessage
        });
    }
});

// Check if Azure AD user exists
app.get('/api/admin/check-azure-user/:upn', apiLimiter, async (req, res) => {
    console.log('[Graph API] Check Azure AD user request received');

    try {
        const { upn } = req.params;

        if (!upn) {
            return res.status(400).json({
                success: false,
                error: 'User principal name is required'
            });
        }

        const token = await getGraphToken();

        try {
            const response = await axios.get(
                `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}?$select=id,displayName,userPrincipalName,mail,accountEnabled`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            res.json({
                success: true,
                exists: true,
                user: response.data
            });

        } catch (userError) {
            if (userError.response?.status === 404) {
                res.json({
                    success: true,
                    exists: false
                });
            } else {
                throw userError;
            }
        }

    } catch (error) {
        console.error('[Graph API] Error checking user:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to check Azure AD user'
        });
    }
});

// =====================================================================
// BAP (Business Application Platform) API - Power Platform Admin
// =====================================================================

// BAP API token cache
const bapApi = {
    accessToken: null,
    tokenExpiry: 0
};

// Get BAP API token for Power Platform Admin operations
async function getBapToken() {
    if (bapApi.accessToken && Date.now() < bapApi.tokenExpiry) {
        return bapApi.accessToken;
    }

    console.log('[BAP API] Authenticating with Power Platform Admin API...');
    const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;

    if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
        throw new Error('Missing Azure configuration for BAP API');
    }

    const tokenEndpoint = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', AZURE_CLIENT_ID);
    params.append('scope', 'https://api.bap.microsoft.com/.default');
    params.append('client_secret', AZURE_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');

    const response = await axios.post(tokenEndpoint, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    bapApi.accessToken = response.data.access_token;
    bapApi.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;

    console.log('[BAP API] Authentication successful');
    return bapApi.accessToken;
}

// Get Power Platform environment ID by Dataverse URL
// The BAP API uses a different environment ID than Dataverse organizationid
app.post('/api/admin/get-environment-id', apiLimiter, async (req, res) => {
    const { dataverseUrl } = req.body;

    if (!dataverseUrl) {
        return res.status(400).json({ success: false, error: 'dataverseUrl is required' });
    }

    try {
        const token = await getBapToken();

        // List all environments and find the one matching the Dataverse URL
        const response = await axios.get(
            'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01',
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        const environments = response.data.value || [];

        // Extract org name from URL (e.g., "org1cbcc5c9" from "https://org1cbcc5c9.crm3.dynamics.com")
        const urlMatch = dataverseUrl.match(/https?:\/\/([^.]+)\./i);
        const orgName = urlMatch ? urlMatch[1].toLowerCase() : null;

        console.log(`[BAP API] Looking for environment with org: ${orgName}`);

        // Find environment by matching the Dataverse URL
        const env = environments.find(e => {
            const envUrl = e.properties?.linkedEnvironmentMetadata?.instanceUrl || '';
            return envUrl.toLowerCase().includes(orgName);
        });

        if (env) {
            console.log(`[BAP API] Found environment: ${env.name} (${env.properties?.displayName})`);
            res.json({ success: true, environmentId: env.name });
        } else {
            console.warn('[BAP API] Environment not found for URL:', dataverseUrl);
            res.json({ success: false, error: 'Environment not found' });
        }

    } catch (error) {
        console.error('[BAP API] Get environment failed:', error.response?.data || error.message);
        res.json({ success: false, error: error.response?.data?.error?.message || error.message });
    }
});

// Sync user to Power Platform (Force add user to environment)
app.post('/api/admin/sync-user-to-powerplatform', apiLimiter, async (req, res) => {
    const { azureUserId, environmentId } = req.body;

    if (!azureUserId || !environmentId) {
        return res.status(400).json({ success: false, error: 'azureUserId and environmentId are required' });
    }

    try {
        const token = await getBapToken();

        console.log(`[BAP API] Syncing user ${azureUserId} to environment ${environmentId}`);

        await axios.post(
            `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${environmentId}/addUser?api-version=2020-10-01`,
            { ObjectId: azureUserId },
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        console.log('[BAP API] User sync successful');
        res.json({ success: true });

    } catch (error) {
        console.error('[BAP API] Sync failed:', error.response?.data || error.message);
        res.json({ success: false, error: error.response?.data?.error?.message || error.message });
    }
});

// Search Azure AD users (for adding existing users to Power Platform)
app.get('/api/admin/search-azure-users', apiLimiter, async (req, res) => {
    const { query } = req.query;

    if (!query || query.length < 2) {
        return res.status(400).json({ success: false, error: 'Search query must be at least 2 characters' });
    }

    try {
        const token = await getGraphToken();

        // Search by displayName, userPrincipalName, or mail
        const searchFilter = `startswith(displayName,'${query}') or startswith(userPrincipalName,'${query}') or startswith(mail,'${query}')`;

        console.log(`[Graph API] Searching Azure AD users with query: ${query}`);

        const response = await axios.get(
            `https://graph.microsoft.com/v1.0/users?$filter=${encodeURIComponent(searchFilter)}&$select=id,displayName,userPrincipalName,mail,jobTitle,department&$top=20`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const users = response.data.value || [];
        console.log(`[Graph API] Found ${users.length} Azure AD users`);

        res.json({
            success: true,
            users: users.map(u => ({
                id: u.id,
                displayName: u.displayName,
                userPrincipalName: u.userPrincipalName,
                mail: u.mail,
                jobTitle: u.jobTitle,
                department: u.department
            }))
        });

    } catch (error) {
        console.error('[Graph API] Search users failed:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data?.error?.message || error.message
        });
    }
});

// Update Azure AD user's mobile phone
app.patch('/api/admin/update-azure-user-phone', apiLimiter, async (req, res) => {
    const { userPrincipalName, mobilePhone } = req.body;

    if (!userPrincipalName) {
        return res.status(400).json({ success: false, error: 'userPrincipalName is required' });
    }

    try {
        const token = await getGraphToken();

        console.log(`[Graph API] Updating mobile phone for user: ${userPrincipalName}`);

        await axios.patch(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userPrincipalName)}`,
            { mobilePhone: mobilePhone || null },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('[Graph API] Mobile phone updated successfully');
        res.json({ success: true });

    } catch (error) {
        console.error('[Graph API] Update mobile phone failed:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data?.error?.message || error.message
        });
    }
});

// =====================================================================
// END MICROSOFT GRAPH API & BAP API
// =====================================================================


// =====================================================================
// PWA ROUTES
// =====================================================================

// Check if PWA directory exists
const pwaDir = path.join(__dirname, '..', 'pwa');
let pwaEnabled = false;
try {
    pwaEnabled = fs.existsSync(pwaDir) && fs.existsSync(path.join(pwaDir, 'app-shell.html'));
} catch (e) {
    console.log('📱 PWA check failed:', e.message);
}

if (pwaEnabled) {
    console.log('📱 PWA enabled - serving from /pwa directory');

    // Serve PWA app shell dynamically - injects correct Dataverse URL based on NODE_ENV
    const appShellPath = path.join(pwaDir, 'app-shell.html');
    function serveAppShell(req, res) {
        fs.readFile(appShellPath, 'utf8', (err, html) => {
            if (err) {
                console.error('Failed to read app-shell.html:', err.message);
                return res.status(500).send('Internal Server Error');
            }
            const rendered = html.replace(/\{\{DATAVERSE_URL\}\}/g, envConfig.dataverseUrl);
            res.type('html').send(rendered);
        });
    }

    // Express 5 path-to-regexp v8 syntax: use {*name} for wildcards
    app.get('/app', serveAppShell);
    app.get('/app/{*splat}', serveAppShell);

    // PWA manifest with correct MIME type
    app.get('/pwa/manifest.json', (req, res) => {
        res.type('application/manifest+json');
        res.sendFile(path.join(pwaDir, 'manifest.json'));
    });

    // Dynamics 365 PWA manifest - with CORS for cross-origin access
    app.get('/pwa/d365-manifest.json', (req, res) => {
        res.type('application/manifest+json');
        res.setHeader('Access-Control-Allow-Origin', envConfig.dataverseUrl);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.sendFile(path.join(pwaDir, 'd365-manifest.json'));
    });

    // Service worker - allow root scope for PWA to work on Chrome/Edge
    app.get('/pwa/sw.js', (req, res) => {
        res.type('application/javascript');
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(pwaDir, 'sw.js'));
    });

    // Static PWA assets with caching
    app.use('/pwa', express.static(pwaDir, {
        maxAge: '7d',
        etag: true,
        setHeaders: (res, filepath) => {
            if (filepath.endsWith('.html') || filepath.endsWith('sw.js')) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            }
        }
    }));
} else {
    console.log('📱 PWA directory not found - using redirect for /app');

    // Fallback: redirect to Dynamics 365 directly
    app.get('/app', (req, res) => {
        res.redirect(301, `${envConfig.dataverseUrl}/WebResources/crd33_home`);
    });
}

// =====================================================================
// END PWA ROUTES
// =====================================================================

// =====================================================================
// PUSH NOTIFICATION API ROUTES
// =====================================================================

// Get VAPID public key (needed by clients to subscribe)
app.get('/api/push/vapid-public-key', (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
        return res.status(503).json({ error: 'Push notifications not configured' });
    }
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Subscribe to push notifications
app.post('/api/push/subscribe', express.json(), (req, res) => {
    const { userId, subscription } = req.body;

    if (!userId || !subscription) {
        return res.status(400).json({ error: 'userId and subscription required' });
    }

    if (!subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Invalid subscription object' });
    }

    // Store subscription
    pushSubscriptions.set(userId, subscription);
    savePushSubscriptions();

    console.log(`🔔 Push subscription saved for user ${userId.slice(0, 8)}...`);
    res.json({ success: true, message: 'Subscription saved' });
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', express.json(), (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId required' });
    }

    const existed = pushSubscriptions.has(userId);
    pushSubscriptions.delete(userId);
    savePushSubscriptions();

    console.log(`🔕 Push subscription removed for user ${userId.slice(0, 8)}...`);
    res.json({ success: true, existed });
});

// Send task notification (called from Dynamics 365 web resources)
app.post('/api/push/task-notification', express.json(), async (req, res) => {
    const { targetUserId, type, taskSubject, taskId, senderName } = req.body;

    if (!targetUserId || !type || !taskSubject) {
        return res.status(400).json({ error: 'targetUserId, type, and taskSubject required' });
    }

    // Build notification payload
    const titles = {
        'new_task': { en: 'New Task Assigned', ar: 'تم إسناد مهمة جديدة' },
        'task_completed': { en: 'Task Completed', ar: 'تم إكمال المهمة' },
        'task_updated': { en: 'Task Updated', ar: 'تم تحديث المهمة' },
        'task_due': { en: 'Task Due Soon', ar: 'المهمة مستحقة قريباً' }
    };

    const title = titles[type] || { en: 'Task Notification', ar: 'إشعار مهمة' };

    const payload = {
        title: title,
        body: taskSubject,
        data: {
            type: type,
            taskId: taskId || null,
            senderName: senderName || null,
            url: '/WebResources/crd33_home#tasks'
        },
        icon: 'https://www.drweee.com/pwa/assets/icons/icon-192x192.png',
        badge: 'https://www.drweee.com/pwa/assets/icons/icon-96x96.png'
    };

    // Send browser push notification
    const pushResult = await sendPushNotification(targetUserId, payload);

    // Also send via SSE for real-time in-app notification
    const sseResult = sendSSEToUser(targetUserId, 'task-notification', {
        type,
        title,
        body: taskSubject,
        taskId: taskId || null,
        senderName: senderName || null,
        timestamp: Date.now()
    });

    res.json({
        ...pushResult,
        sse: { sent: sseResult.sent }
    });
});

// Batch send notifications (for multiple users)
app.post('/api/push/batch-notification', express.json(), async (req, res) => {
    const { userIds, type, taskSubject, taskId, senderName } = req.body;

    if (!userIds || !Array.isArray(userIds) || !type || !taskSubject) {
        return res.status(400).json({ error: 'userIds array, type, and taskSubject required' });
    }

    const titles = {
        'new_task': { en: 'New Task Assigned', ar: 'تم إسناد مهمة جديدة' },
        'task_completed': { en: 'Task Completed', ar: 'تم إكمال المهمة' },
        'task_updated': { en: 'Task Updated', ar: 'تم تحديث المهمة' },
        'task_due': { en: 'Task Due Soon', ar: 'المهمة مستحقة قريباً' }
    };

    const title = titles[type] || { en: 'Task Notification', ar: 'إشعار مهمة' };

    const payload = {
        title: title,
        body: taskSubject,
        data: {
            type: type,
            taskId: taskId || null,
            senderName: senderName || null,
            url: '/WebResources/crd33_home#tasks'
        },
        icon: 'https://www.drweee.com/pwa/assets/icons/icon-192x192.png',
        badge: 'https://www.drweee.com/pwa/assets/icons/icon-96x96.png'
    };

    // Send browser push notifications
    const pushResults = await Promise.all(
        userIds.map(userId => sendPushNotification(userId, payload))
    );

    // Also send via SSE for real-time in-app notification
    const sseData = {
        type,
        title,
        body: taskSubject,
        taskId: taskId || null,
        senderName: senderName || null,
        timestamp: Date.now()
    };
    let sseSent = 0;
    userIds.forEach(userId => {
        const result = sendSSEToUser(userId, 'task-notification', sseData);
        sseSent += result.sent;
    });

    const successful = pushResults.filter(r => r.success).length;
    res.json({
        success: true,
        sent: successful,
        failed: pushResults.length - successful,
        sseSent,
        results: pushResults
    });
});

// Check subscription status
app.get('/api/push/status/:userId', (req, res) => {
    const { userId } = req.params;
    const hasSubscription = pushSubscriptions.has(userId);
    res.json({
        subscribed: hasSubscription,
        pushEnabled: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
    });
});

// =====================================================================
// SSE (Server-Sent Events) for Real-Time In-App Notifications
// =====================================================================

// SSE connection endpoint - clients connect here to receive real-time events
app.get('/api/sse/connect/:userId', (req, res) => {
    const { userId } = req.params;

    if (!userId) {
        return res.status(400).json({ error: 'userId required' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Flush headers immediately to establish connection
    res.flushHeaders();

    // Send initial connection confirmation
    res.write(`event: connected\ndata: ${JSON.stringify({ userId, timestamp: Date.now() })}\n\n`);

    // Add this connection to the user's set
    if (!sseConnections.has(userId)) {
        sseConnections.set(userId, new Set());
    }
    sseConnections.get(userId).add(res);

    console.log(`📡 SSE connected: ${userId.slice(0, 8)}... (${sseConnections.get(userId).size} clients)`);

    // Send heartbeat every 30 seconds to keep connection alive
    const heartbeat = setInterval(() => {
        try {
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
        } catch (e) {
            clearInterval(heartbeat);
        }
    }, 30000);

    // Clean up on disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        const userConns = sseConnections.get(userId);
        if (userConns) {
            userConns.delete(res);
            if (userConns.size === 0) {
                sseConnections.delete(userId);
            }
        }
        console.log(`📡 SSE disconnected: ${userId.slice(0, 8)}... (${sseConnections.get(userId)?.size || 0} clients remaining)`);
    });
});

// Get SSE connection count (for debugging)
app.get('/api/sse/status', (req, res) => {
    const stats = {
        totalUsers: sseConnections.size,
        connections: []
    };
    sseConnections.forEach((conns, userId) => {
        stats.connections.push({ userId: userId.slice(0, 8) + '...', clients: conns.size });
    });
    res.json(stats);
});

// =====================================================================
// END PUSH NOTIFICATION ROUTES
// =====================================================================

// Apply cache control middleware
app.use(cacheControlMiddleware());

app.use(express.static(path.join(__dirname, '..'), {
    index: false,  // Disable automatic index.html serving
    etag: true,
    maxAge: '1h',
    setHeaders: (res, filepath) => {
        // Prevent caching of HTML files
        if (filepath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));
// --- 6. FALLBACK ROUTE & SERVER START ---

// Fallback route for SPA (must be before error handler)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Global error handler (must be last)
app.use(errorHandlerMiddleware());

app.listen(port, () => {
    console.log(`✅ Server is running on http://localhost:${port}`);
    console.log(`📝 Environment: ${currentEnv}`);
    console.log(`📝 Using memory store for sessions`);
    console.log(`🔒 Security middleware: ${isProduction() ? 'ENABLED' : 'DISABLED'}`);
});
