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
const storeProductCache = {
    data: null,
    lastFetch: 0
};
const STORE_CACHE_DURATION_MS = 15 * 60 * 1000; // Cache for 15 minutes
// --- 2. INITIALIZATION & CONFIGURATION ---
const app = express();
const port = process.env.PORT || 3000;

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
        console.log('Full response structure:', JSON.stringify(response.data, null, 2));

        // Extract token from the nested data object
        cequensApi.token = response.data.data?.access_token || response.data.data?.token;

        if (!cequensApi.token) {
            console.error('❌ No token found in response data:', response.data.data);
            throw new Error('Token not found in authentication response');
        }

        cequensApi.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);

        console.log('✅ Token extracted successfully, length:', cequensApi.token.length);
        return cequensApi.token;
    } catch (error) {
        console.error('❌ Authentication failed');
        console.error('Status:', error.response?.status);
        console.error('Data:', error.response?.data);
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
        console.log('Authorization header length:', token.length);

        const response = await axios.post(`${cequensApi.baseUrl}/sms/v1/messages`, smsPayload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        console.log(`✅ SMS sent successfully to ${phoneNumber}`);
        console.log('SMS Response:', response.data);
        return response.data;
    } catch (error) {
        console.error('❌ Error sending SMS:');
        console.error('Status:', error.response?.status);
        console.error('Response data:', JSON.stringify(error.response?.data, null, 2));

        // Try to get more details about internal errors
        if (error.response?.data?.error?.internalErrors) {
            console.error('Internal errors:', error.response.data.error.internalErrors);
        }

        throw new Error('Failed to send SMS');
    }
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
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
    origin: true,
    credentials: true
}));

// Request logging for slow requests
app.use(requestLoggerMiddleware());

app.use(express.json());

// Get rate limiters
const { apiLimiter, authLimiter, otpLimiter } = rateLimitMiddleware();


app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'drweee-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    name: 'drweee.sid', // Custom session name
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours instead of 10 minutes
        sameSite: 'lax'
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
        console.log(`[DEBUG] Checking for existing contact with phone: ${normalizedPhone}`);

        // 1. Define an efficient FetchXML query to check for existence.
        // We use top="1" because we only need to know if at least one record exists.
        const checkUserFetchXml = `<fetch top="1">
                                      <entity name="contact">
                                        <attribute name="contactid" />
                                        <filter type="and">
                                          <condition attribute="mobilephone" operator="eq" value="${normalizedPhone}" />
                                        </filter>
                                      </entity>
                                    </fetch>`;

        // 2. Execute the query using the Dataverse helper, replacing the Power Automate call.
        const existingUsers = await queryDataverse('contacts', checkUserFetchXml);

        // 3. Check the result and respond if the user already exists.
        if (existingUsers.length > 0) {
            console.log(`[INFO] Registration blocked: Phone number ${normalizedPhone} already exists.`);
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
            console.log(`[INFO] OTP sent to ${normalizedPhone}`);
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
    if (storedOtpData.otp === otp) {
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
                                    <condition attribute="mobilephone" operator="eq" value="${normalizedPhone}" />
                                </filter>
                            </entity>
                          </fetch>`;

        // Step 1: Execute the query
        const results = await queryDataverse('contacts', fetchXml);

        // Step 2: Immediately check if a user was found. If not, exit early.
        if (results.length === 0) {
            console.log(`Login failed: No contact found with phone ${normalizedPhone}`);
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        // Step 3: NOW it is safe to declare and access userRecord
        const userRecord = results[0];
        const passwordHash = userRecord.adx_identity_passwordhash;

        if (!passwordHash) {
            console.log(`Login failed: Contact ${normalizedPhone} exists but has no password hash.`);
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
                console.log(`✅ User logged in via Dataverse: ${userRecord.firstname} (${normalizedPhone})`);
                res.status(200).json({ message: 'Login successful.' });
            });
        } else {
            console.log(`Login failed: Incorrect password for ${normalizedPhone}`);
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
    // Check if user is logged in
    if (!req.session.user || !req.session.user.phoneNumber) {
        return res.status(401).json({ message: 'User not logged in' });
    }

    const { type, GUID, Description, longitude, latitude } = req.body;

    // Validate required fields
    if (!type || !GUID || !Description || !longitude || !latitude) {
        return res.status(400).json({
            message: 'Missing required fields',
            received: { type: !!type, GUID: !!GUID, Description: !!Description, longitude: !!longitude, latitude: !!latitude }
        });
    }

    // Validate that the GUID matches the logged-in user's GUID
    if (req.session.user.GUID !== GUID) {
        return res.status(403).json({ message: 'GUID mismatch - unauthorized request' });
    }

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
            console.error('Power Automate error data:', JSON.stringify(errorData, null, 2));

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

                console.log('Failed request stored:', JSON.stringify(failedRequest, null, 2));

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
    if (!req.session.user || !req.session.user.GUID) {
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
Customer: ${req.session.user.fullName} (${req.session.user.phoneNumber})
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
            userGUID: req.session.user.GUID,
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


// js/server.js

// REPLACE the existing /api/fetch-products endpoint with this one
app.post('/api/fetch-products', async (req, res) => {
    const { type } = req.body;

    if (type !== 'product') {
        return res.status(400).json({ message: 'Invalid request type' });
    }

    const isCacheValid = productCache.data && (Date.now() - productCache.lastFetch < CACHE_DURATION_MS);

    if (isCacheValid) {
        console.log('✅ Returning e-waste products from global server cache');
        return res.status(200).json({
            success: true,
            products: productCache.data,
            cached: true
        });
    }

    try {
        console.log('🔄 Fetching e-waste products from Dataverse (cache expired or empty)...');

        const fetchXml = `<fetch>
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

        productCache.data = transformedProducts;
        productCache.lastFetch = Date.now();
        console.log('✅ Global e-waste product cache updated successfully from Dataverse.');

        res.status(200).json({
            success: true,
            products: transformedProducts,
            cached: false
        });

    } catch (error) {
        console.error('❌ Error fetching e-waste products:', error.message);
        if (productCache.data) {
            console.warn('⚠️ Serving stale e-waste cache due to fetch error.');
            return res.status(200).json({
                success: true,
                products: productCache.data,
                cached: 'stale'
            });
        }
        res.status(500).json({ message: 'Failed to fetch products', error: 'product_fetch_failed' });
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

app.post('/api/store', async (req, res) => {
    // 1. CHECK THE GLOBAL CACHE FIRST
    const isCacheValid = storeProductCache.data && (Date.now() - storeProductCache.lastFetch < STORE_CACHE_DURATION_MS);

    if (isCacheValid) {
        console.log('✅ Returning store products from global server cache');
        return res.status(200).json({
            success: true,
            products: storeProductCache.data,
            source: 'cache'
        });
    }

    try {
        console.log('🔄 Fetching store products directly from Dataverse (cache expired or empty)...');

        // Step A: Get the primary list of products with filters, now including a link to the parent product
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
            return res.status(200).json({ success: true, products: [], source: 'live' });
        }


        const productIds = products.map(p => `<value>${p.productid}</value>`).join('');
        const parentProductIds = [...new Set(
            products.map(p => p.parentproductid || p._parentproductid_value).filter(Boolean)
        )].map(id => `<value>${id}</value>`).join('');


        const relationshipQuery = `<fetch><entity name="productsubstitute"><attribute name="productsubstituteid" alias="relationshipId"/><attribute name="salesrelationshiptype" alias="relationshipType"/><attribute name="direction"/><attribute name="productid" alias="parentProductIdForJoin"/><link-entity name="product" from="productid" to="substitutedproductid" alias="relatedProduct"><attribute name="productid" alias="productId"/><attribute name="name" alias="relatedName"/><attribute name="productnumber" alias="relatedProductNumber"/></link-entity><filter><condition attribute="productid" operator="in">${productIds}</condition></filter></entity></fetch>`;
        const priceItemQuery = `<fetch><entity name="productpricelevel"><attribute name="productpricelevelid" alias="priceListItemId"/><attribute name="amount"/><attribute name="crd33_buyingamount" alias="buyingAmount"/><attribute name="crd33_drweeepercentageofsell" alias="weeePercentageOfSell"/><attribute name="crd33_maxdiscountpercentage" alias="maxDiscountPercentage"/><attribute name="crd33_costperpagefororiginal" alias="costPerPageOriginal"/><attribute name="crd33_costperpageforremanufactured" alias="costPerPageRemanufactured"/><attribute name="crd33_saving" alias="saving"/><attribute name="crd33_weeepointequivalent" alias="weeePoints"/><attribute name="crd33_carbonsavingsperunit" alias="carbonSavings"/><attribute name="productid" alias="productIdForJoin"/><link-entity name="pricelevel" from="pricelevelid" to="pricelevelid" alias="pricelist"><attribute name="pricelevelid" alias="priceListId"/><attribute name="name" alias="priceListName"/></link-entity><filter><condition attribute="productid" operator="in">${productIds}</condition></filter></entity></fetch>`;
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

        const finalProducts = products.map(product => {
            const relationships = allRelationships.filter(r => r.parentProductIdForJoin === product.productid);

            // FIX: Handle the parent product ID correctly - check multiple possible field names
            const parentProductId = product.parentproductid || product._parentproductid_value;

            console.log(`[DEBUG] Product ${product.name} (${product.productid}):`);
            console.log(`  - Raw parent product data:`, {
                parentproductid: product.parentproductid,
                _parentproductid_value: product._parentproductid_value
            });
            console.log(`  - Resolved Parent Product ID: ${parentProductId}`);

            // Filter properties for THIS SPECIFIC PRODUCT and its parent
            const productLevelProperties = allProperties.filter(p => {
                const regardingId = p.parentRecordId || p._regardingobjectid_value;
                return regardingId === product.productid;
            });

            const familyLevelProperties = allProperties.filter(p => {
                const regardingId = p.parentRecordId || p._regardingobjectid_value;
                return regardingId === parentProductId;
            });

            console.log(`  - Family properties for parent ${parentProductId}: ${familyLevelProperties.length}`);
            console.log(`  - Product properties for ${product.productid}: ${productLevelProperties.length}`);

            // Debug: Show family property details
            if (familyLevelProperties.length > 0) {
                familyLevelProperties.forEach(fp => {
                    console.log(`    - Family property: ${fp.propertyName} (${fp.propertyId}) regarding ${fp.parentRecordId || fp._regardingobjectid_value}`);
                });
            }

            // Create a property map specifically for THIS product
            const propertyMap = new Map();

            // Step 1: Add family-level properties as templates
            familyLevelProperties.forEach(familyProp => {
                const value = extractPropertyValue(familyProp);
                const key = familyProp.propertyId; // Use property ID as unique key

                console.log(`  - Family template: ${familyProp.propertyName} = ${value} (ID: ${familyProp.propertyId})`);

                propertyMap.set(key, {
                    propertyId: familyProp.propertyId,
                    propertyName: familyProp.propertyName,
                    propertyValue: value,
                    source: 'family',
                    isTemplate: true,
                    hasValue: value !== null && value !== undefined && value !== ''
                });
            });

            // Step 2: Process product-level properties
            productLevelProperties.forEach(prodProp => {
                const value = extractPropertyValue(prodProp);
                console.log(`  - Product prop: ${prodProp.propertyName} = ${value} (Root: ${prodProp.rootPropertyId}, Base: ${prodProp.basePropertyId})`);

                // Check if this product property links to a family template
                const rootId = prodProp.rootPropertyId || prodProp.basePropertyId;

                if (rootId && propertyMap.has(rootId)) {
                    const linkedFamilyProp = propertyMap.get(rootId);
                    console.log(`    - Links to family template: ${linkedFamilyProp.propertyName} (${rootId})`);

                    // Override/enhance the family template with product data
                    const finalValue = value !== null && value !== undefined && value !== '' ? value : linkedFamilyProp.propertyValue;
                    const finalSource = value !== null && value !== undefined && value !== '' ? 'product' : 'family';

                    propertyMap.set(rootId, {
                        propertyId: prodProp.propertyId,
                        propertyName: linkedFamilyProp.propertyName, // Keep family property name
                        propertyValue: finalValue,
                        source: finalSource,
                        isTemplate: false,
                        hasValue: finalValue !== null && finalValue !== undefined && finalValue !== ''
                    });
                } else {
                    // This is a standalone product property
                    console.log(`    - Standalone product property: ${prodProp.propertyName}`);

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

            // Step 3: Extract final properties
            const finalProperties = Array.from(propertyMap.values())
                .filter(prop => {
                    // Include properties that have values
                    return prop.hasValue;
                })
                .map(prop => ({
                    propertyId: prop.propertyId,
                    propertyName: prop.propertyName,
                    propertyValue: prop.propertyValue,
                    source: prop.source
                }));

            console.log(`  - Final properties for ${product.name}: ${finalProperties.length}`);
            finalProperties.forEach(fp => console.log(`    * ${fp.propertyName}: ${fp.propertyValue} (${fp.source})`));

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

        storeProductCache.data = finalProducts;
        storeProductCache.lastFetch = Date.now();
        console.log(`✅ Global store cache updated. Found and merged ${finalProducts.length} products.`);

        res.status(200).json({ success: true, products: finalProducts, source: 'live' });

    } catch (error) {
        console.error('❌ Error in /api/store endpoint:', error.message);
        if (storeProductCache.data) {
            console.warn('⚠️ Serving stale store cache due to fetch error.');
            return res.status(200).json({ success: true, products: storeProductCache.data, source: 'stale' });
        }
        res.status(500).json({ message: 'Failed to fetch store products.' });
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
            console.error('Power Automate error data:', JSON.stringify(errorData, null, 2));

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

// Logout endpoint
app.post('/api/logout', (req, res) => {
    const userPhone = req.session.user?.phoneNumber;
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({ message: 'Logout failed' });
        }
        console.log(`✅ User logged out: ${userPhone}`);
        res.clearCookie('drweee.sid');
        res.status(200).json({ message: 'Logged out successfully' });
    });
});



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
