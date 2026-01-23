// js/middleware.js - Production-ready middleware for performance and security

const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Compression middleware - reduces response size by ~70%
function compressionMiddleware() {
    return compression({
        filter: (req, res) => {
            if (req.headers['x-no-compression']) {
                return false;
            }
            return compression.filter(req, res);
        },
        level: 6, // Balance between speed and compression ratio
        threshold: 1024 // Only compress responses larger than 1KB
    });
}

// Security headers middleware
function securityMiddleware() {
    return helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // Removed 'unsafe-eval' - only keep 'unsafe-inline' for inline scripts
                // Azure Maps SDK requires 'unsafe-inline' but not 'unsafe-eval'
                scriptSrc: ["'self'", "'unsafe-inline'", "https://atlas.microsoft.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://ajax.googleapis.com", "https://www.googletagmanager.com", "https://www.google-analytics.com"],
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://atlas.microsoft.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", "data:"],
                imgSrc: ["'self'", "data:", "https:", "blob:"],
                mediaSrc: ["'self'", "https://assets.mixkit.co", "https://*.blob.core.windows.net", "blob:", "data:"],
                connectSrc: ["'self'", "https://atlas.microsoft.com", "https://*.atlas.microsoft.com", "https://dc.services.visualstudio.com", "https://apis.cequens.com", "https://*.crm.dynamics.com", "https://*.railway.app", "https://www.google-analytics.com", "https://region1.google-analytics.com", "https://ipapi.co", "https://ipwho.is"],
                frameSrc: ["'self'", "https://*.blob.core.windows.net"],
                workerSrc: ["'self'", "blob:"],
                childSrc: ["'self'", "blob:"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                upgradeInsecureRequests: []
            }
        },
        crossOriginEmbedderPolicy: false, // Allow external resources
        crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
        crossOriginResourcePolicy: { policy: "cross-origin" },
        // Additional security headers
        referrerPolicy: { policy: "strict-origin-when-cross-origin" },
        hsts: {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true
        },
        // Prevent MIME type sniffing
        noSniff: true,
        // Prevent clickjacking
        frameguard: { action: "deny" },
        // XSS protection (legacy browsers)
        xssFilter: true,
        // Hide X-Powered-By header
        hidePoweredBy: true
    });
}

// Rate limiting middleware - prevents abuse
function rateLimitMiddleware() {
    // General API rate limit
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // Limit each IP to 100 requests per windowMs
        message: 'Too many requests from this IP, please try again later.',
        standardHeaders: true,
        legacyHeaders: false,
    });

    // Stricter rate limit for authentication endpoints
    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 10, // Limit each IP to 10 requests per windowMs
        message: 'Too many authentication attempts, please try again later.',
        skipSuccessfulRequests: false,
    });

    // Very strict rate limit for OTP requests
    const otpLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 5, // Limit each IP to 5 OTP requests per windowMs
        message: 'Too many OTP requests, please try again later.',
        skipSuccessfulRequests: false,
    });

    // Rate limit for OG image generation (social crawlers are aggressive)
    const ogLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 50, // Allow 50 requests per windowMs (for social platform crawlers)
        message: 'Too many image requests, please try again later.',
        standardHeaders: true,
        legacyHeaders: false,
    });

    return { apiLimiter, authLimiter, otpLimiter, ogLimiter };
}

// Cache control middleware for static assets
function cacheControlMiddleware() {
    return (req, res, next) => {
        // Cache static assets aggressively
        if (req.url.match(/\.(css|js|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
        }
        // Don't cache HTML files
        else if (req.url.match(/\.html$/)) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        next();
    };
}

// Request logging middleware (lightweight for production)
function requestLoggerMiddleware() {
    return (req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            if (duration > 1000) { // Only log slow requests
                console.log(`⚠️ Slow request: ${req.method} ${req.url} - ${duration}ms`);
            }
        });
        next();
    };
}

// Error handling middleware
function errorHandlerMiddleware() {
    return (err, req, res, next) => {
        console.error('❌ Unhandled error:', err);

        // Don't leak error details in production
        const isProduction = process.env.NODE_ENV === 'production';

        res.status(err.status || 500).json({
            success: false,
            message: isProduction ? 'An error occurred' : err.message,
            ...(isProduction ? {} : { stack: err.stack })
        });
    };
}

// CORS configuration for production
function corsOptionsProduction() {
    return {
        origin: (origin, callback) => {
            // Allow requests with no origin (same-origin requests, mobile apps, Postman, etc.)
            if (!origin) return callback(null, true);

            // In production, whitelist Railway domains and custom domains
            const allowedOrigins = [
                process.env.FRONTEND_URL,
                'https://www.drweee.com',
                'https://drweee.com',
                /\.railway\.app$/, // Allow all Railway subdomains
                /^https:\/\/[^\/]+\.railway\.app$/ // Allow Railway domains with https
            ].filter(Boolean);

            // Check if origin is allowed
            const isAllowed = allowedOrigins.some(allowed => {
                if (allowed instanceof RegExp) {
                    return allowed.test(origin);
                }
                return allowed === origin;
            });

            // In production, strictly enforce CORS whitelist
            if (process.env.NODE_ENV === 'production') {
                // Allow if matches whitelist OR if it's a Railway domain OR drweee.com OR Dynamics 365 (for POS)
                if (isAllowed || origin.includes('railway.app') || origin.includes('drweee.com') || origin.includes('dynamics.com')) {
                    callback(null, true);
                } else {
                    console.log('⚠️ CORS blocked origin:', origin);
                    callback(new Error('CORS policy: Origin not allowed'), false);
                }
            } else {
                // In development, allow all origins for easier testing
                callback(null, true);
            }
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-POS-API-Key'],
        maxAge: 86400 // 24 hours
    };
}

module.exports = {
    compressionMiddleware,
    securityMiddleware,
    rateLimitMiddleware,
    cacheControlMiddleware,
    requestLoggerMiddleware,
    errorHandlerMiddleware,
    corsOptionsProduction
};
