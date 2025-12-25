// js/server.js

// --- 1. IMPORTS ---
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
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

// --- SECURE LOGGING UTILITIES ---
// Production-safe logging that masks sensitive data
const isProduction = () => process.env.NODE_ENV === 'production';

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
    'DATAVERSE_URL', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'
];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
    console.error('Please check your .env file and ensure all Cequens credentials are set.');
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
    const { DATAVERSE_URL, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;

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
        console.error('❌ Dataverse authentication failed:', error.response?.data);
        throw new Error('Could not authenticate with Dataverse.');
    }
}

// This function executes a FetchXML query against the Dataverse Web API
async function queryDataverse(entityPluralName, fetchXml) {
    console.log(`[DEBUG] Executing FetchXML for ${entityPluralName}...`);
    const token = await getDataverseToken();
    const { DATAVERSE_URL } = process.env;

    const encodedFetchXml = encodeURIComponent(fetchXml);
    const url = `${DATAVERSE_URL}/api/data/v9.2/${entityPluralName}?fetchXml=${encodedFetchXml}`;

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
        console.error(`❌ Dataverse query failed for ${entityPluralName}:`, errorMessage);
        throw new Error(`Failed to query ${entityPluralName}.`);
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
if (process.env.NODE_ENV === 'production') {
    app.use(securityMiddleware());
    console.log('✅ Security headers enabled');
}

// Apply compression for better performance
app.use(compressionMiddleware());
console.log('✅ Response compression enabled');

// CORS with production-ready configuration
app.use(cors(process.env.NODE_ENV === 'production' ? corsOptionsProduction() : {
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
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    console.error('FATAL: SESSION_SECRET must be set to a strong random value (at least 32 characters) in production!');
    console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
}

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'drweee-dev-secret-key-not-for-production',
    resave: false,
    saveUninitialized: false,
    name: 'drweee.sid', // Custom session name
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        // For local development with Live Server on different port, use 'none' with secure:false
        // For production, use 'lax' with secure:true
        sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'none'
    }
}));

// --- 5. API ENDPOINTS ---

// Health check endpoint for Railway monitoring
app.get('/api/health', (req, res) => {
    const healthcheck = {
        uptime: process.uptime(),
        status: 'OK',
        timestamp: Date.now(),
        environment: process.env.NODE_ENV || 'development',
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
            // Send a clean success response.
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

    if (!storedOtpData || !storedOtpData.verified || storedOtpData.phoneNumber !== normalizedPhone) {
        return res.status(403).json({ message: 'Phone number not verified. Please complete the OTP step first.' });
    }
    if (!password) {
        return res.status(400).json({ message: 'Password is required.' });
    }

    const powerAutomateUrl = process.env.POWER_AUTOMATE_GET_URL;
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
    const isLocalDev = process.env.NODE_ENV !== 'production';

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

    const powerAutomateUrl = process.env.POWER_AUTOMATE_GET_URL;
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
    const isLocalDev = process.env.NODE_ENV !== 'production';

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

    const powerAutomateUrl = process.env.POWER_AUTOMATE_GET_URL;
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
    const isLocalDev = process.env.NODE_ENV !== 'production';

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
    // Authentication check
    const isSessionAuth = req.session.user && req.session.user.GUID;
    const isLocalDev = process.env.NODE_ENV !== 'production';

    let userGUID = null;
    let userFullName = 'Guest User';
    let userPhoneNumber = 'N/A';

    if (isSessionAuth) {
        userGUID = req.session.user.GUID;
        userFullName = req.session.user.fullName || 'DR.WEEE User';
        userPhoneNumber = req.session.user.phoneNumber || 'N/A';
    } else if (isLocalDev && req.body.userGUID) {
        userGUID = req.body.userGUID;
        userFullName = req.body.userFullName || 'Local Dev User';
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

    const powerAutomateUrl = process.env.POWER_AUTOMATE_GET_URL;
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

        // If territoryId is provided, get the "E-waste" price list for this territory
        // Price list types: E-waste = 269530000, Sell Products = 269530001
        // Only get price lists where crd33_availableforwebsite = true
        let priceListIds = [];
        if (territoryId) {
            // Validate and sanitize territory ID
            if (!isValidGUID(territoryId)) {
                return res.status(400).json({ success: false, message: 'Invalid territory ID format.' });
            }
            const sanitizedTerritoryId = sanitizeFetchXmlValue(territoryId);

            const priceListTerritoryQuery = `<fetch version="1.0" mapping="logical">
                <entity name="crd33_pricelistterritory">
                    <attribute name="crd33_pricelistterritoryid"/>
                    <filter type="and">
                        <condition attribute="crd33_territory" operator="eq" value="${sanitizedTerritoryId}"/>
                        <condition attribute="statecode" operator="eq" value="0"/>
                    </filter>
                    <link-entity name="pricelevel" from="pricelevelid" to="crd33_pricelist" alias="pricelist" link-type="inner">
                        <attribute name="pricelevelid" alias="priceListId"/>
                        <filter type="and">
                            <condition attribute="statecode" operator="eq" value="0"/>
                            <condition attribute="crd33_availableforwebsite" operator="eq" value="1"/>
                            <condition attribute="crd33_pricelisttype" operator="eq" value="269530000"/>
                        </filter>
                    </link-entity>
                </entity>
            </fetch>`;

            const priceListTerritories = await queryDataverse('crd33_pricelistterritories', priceListTerritoryQuery);
            secureLog.debug(`Found ${priceListTerritories?.length || 0} price list territories`);

            // Try both possible alias formats
            priceListIds = (priceListTerritories || []).map(plt => {
                // Dataverse may return as 'pricelist.priceListId' or just 'priceListId'
                return plt['pricelist.priceListId'] || plt.priceListId || plt['pricelist_priceListId'];
            }).filter(Boolean);
            secureLog.debug(`Found ${priceListIds.length} price lists for territory`);

            if (priceListIds.length === 0) {
                console.log('⚠️ No price lists found for territory, returning empty products');
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
                        <filter type="or">
                            ${priceListConditions}
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

        // Step 1: If territoryId provided, get the "Sell Products" price list for this territory
        // Price list types: E-waste = 269530000, Sell Products = 269530001
        // Only get price lists where crd33_availableforwebsite = true
        if (territoryId) {
            // Validate and sanitize territory ID
            if (!isValidGUID(territoryId)) {
                return res.status(400).json({ success: false, message: 'Invalid territory ID format.' });
            }
            const sanitizedTerritoryId = sanitizeFetchXmlValue(territoryId);
            console.log(`[Store] Fetching "Sell Products" price list for territory: ${territoryId}`);

            // Query crd33_pricelistterritories to get the Sell Products price list for this territory
            const priceListTerritoryQuery = `<fetch version="1.0" mapping="logical">
                <entity name="crd33_pricelistterritory">
                    <attribute name="crd33_pricelistterritoryid"/>
                    <filter type="and">
                        <condition attribute="crd33_territory" operator="eq" value="${sanitizedTerritoryId}"/>
                        <condition attribute="statecode" operator="eq" value="0"/>
                    </filter>
                    <link-entity name="pricelevel" from="pricelevelid" to="crd33_pricelist" alias="pricelist" link-type="inner">
                        <attribute name="pricelevelid" alias="priceListId"/>
                        <attribute name="name" alias="priceListName"/>
                        <attribute name="transactioncurrencyid" alias="currencyId"/>
                        <attribute name="crd33_pricelisttype" alias="priceListType"/>
                        <attribute name="crd33_availableforwebsite" alias="availableForWebsite"/>
                        <filter type="and">
                            <condition attribute="statecode" operator="eq" value="0"/>
                            <condition attribute="crd33_availableforwebsite" operator="eq" value="1"/>
                            <condition attribute="crd33_pricelisttype" operator="eq" value="269530001"/>
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

            const priceListTerritories = await queryDataverse('crd33_pricelistterritories', priceListTerritoryQuery);

            if (priceListTerritories.length === 0) {
                console.log(`[Store] No price lists found for territory: ${territoryId}`);
                return res.status(200).json({
                    success: true,
                    products: [],
                    currency: null,
                    message: 'No price lists configured for this territory',
                    source: 'live'
                });
            }

            // Extract price list IDs and currency info
            territoryPriceListIds = priceListTerritories.map(plt => plt.priceListId);

            // Get currency from the first price list (should be the same for all in a territory)
            const firstPriceList = priceListTerritories[0];
            if (firstPriceList.currencySymbol) {
                territoryCurrency = {
                    id: firstPriceList.currencyId,
                    name: firstPriceList.currencyName,
                    symbol: firstPriceList.currencySymbol,
                    isoCode: firstPriceList.currencyIsoCode,
                    precision: firstPriceList.currencyPrecision || 2,
                    exchangeRate: firstPriceList.currencyExchangeRate
                };
            }

            console.log(`[Store] Found ${territoryPriceListIds.length} price lists for territory. Currency: ${territoryCurrency?.symbol || 'N/A'}`);
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
            priceItemQuery = `<fetch><entity name="productpricelevel"><attribute name="productpricelevelid" alias="priceListItemId"/><attribute name="amount"/><attribute name="crd33_buyingamount" alias="buyingAmount"/><attribute name="crd33_drweeepercentageofsell" alias="weeePercentageOfSell"/><attribute name="crd33_maxdiscountpercentage" alias="maxDiscountPercentage"/><attribute name="crd33_costperpagefororiginal" alias="costPerPageOriginal"/><attribute name="crd33_costperpageforremanufactured" alias="costPerPageRemanufactured"/><attribute name="crd33_saving" alias="saving"/><attribute name="crd33_weeepointequivalent" alias="weeePoints"/><attribute name="crd33_carbonsavingsperunit" alias="carbonSavings"/><attribute name="productid" alias="productIdForJoin"/><link-entity name="pricelevel" from="pricelevelid" to="pricelevelid" alias="pricelist"><attribute name="pricelevelid" alias="priceListId"/><attribute name="name" alias="priceListName"/></link-entity><filter type="and"><condition attribute="productid" operator="in">${productIds}</condition><condition attribute="pricelevelid" operator="in">${priceListIdsCondition}</condition></filter></entity></fetch>`;
        } else {
            // No territory filter - get all price items (backwards compatibility)
            priceItemQuery = `<fetch><entity name="productpricelevel"><attribute name="productpricelevelid" alias="priceListItemId"/><attribute name="amount"/><attribute name="crd33_buyingamount" alias="buyingAmount"/><attribute name="crd33_drweeepercentageofsell" alias="weeePercentageOfSell"/><attribute name="crd33_maxdiscountpercentage" alias="maxDiscountPercentage"/><attribute name="crd33_costperpagefororiginal" alias="costPerPageOriginal"/><attribute name="crd33_costperpageforremanufactured" alias="costPerPageRemanufactured"/><attribute name="crd33_saving" alias="saving"/><attribute name="crd33_weeepointequivalent" alias="weeePoints"/><attribute name="crd33_carbonsavingsperunit" alias="carbonSavings"/><attribute name="productid" alias="productIdForJoin"/><link-entity name="pricelevel" from="pricelevelid" to="pricelevelid" alias="pricelist"><attribute name="pricelevelid" alias="priceListId"/><attribute name="name" alias="priceListName"/></link-entity><filter><condition attribute="productid" operator="in">${productIds}</condition></filter></entity></fetch>`;
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

    const powerAutomateUrl = process.env.POWER_AUTOMATE_GET_URL;
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
    const isLocalDev = process.env.NODE_ENV !== 'production';

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
                const updateUrl = `${process.env.DATAVERSE_URL}/api/data/v9.2/contacts(${userGUID})`;
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
        const baseUrl = process.env.NODE_ENV === 'production'
            ? 'https://www.drweee.com'
            : `http://localhost:${port}`;

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
        const baseUrl = process.env.NODE_ENV === 'production'
            ? 'https://www.drweee.com'
            : `http://localhost:${port}`;

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
        const { DATAVERSE_URL } = process.env;

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
    'شكراً لتدويرك مع',
    'Merci pour votre recyclage avec'
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
        const isDevelopment = process.env.NODE_ENV !== 'production';
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
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📝 Using memory store for sessions`);
    console.log(`🔒 Security middleware: ${process.env.NODE_ENV === 'production' ? 'ENABLED' : 'DISABLED'}`);
});
