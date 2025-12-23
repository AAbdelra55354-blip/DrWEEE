// js/i18n.js
// DR.WEEE Multi-Language Support Module
// Supports: English (en), Arabic (ar), Italian (it)

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        defaultLanguage: 'en', // Default to English (fallback)
        defaultCountryName: 'Egypt', // Default country name to match against territories
        supportedLanguages: ['en', 'ar', 'it'],
        storageKey: 'drweee_language',
        countryStorageKey: 'drweee_country_id',
        detectedCountryCodeKey: 'drweee_detected_country_code', // ISO code from geolocation
        geoDetectedKey: 'drweee_geo_detected', // Track if we've done geo detection
        territoriesCacheKey: 'drweee_territories_v1',
        territoriesCacheDuration: 60 * 60 * 1000, // 1 hour
        cacheKey: 'drweee_translations_v19_', // Version bump for dynamic country codes
        cacheDuration: 60 * 60 * 1000, // 1 hour (reduced for development)
        rtlLanguages: ['ar'],
        languageNames: {
            en: { native: 'English' },
            ar: { native: 'العربية' },
            it: { native: 'Italiano' }
        },
        // Map country codes to their default language (only for countries with non-English defaults)
        // This is used when a user's detected country matches a territory
        countryLanguageDefaults: {
            'eg': 'ar', // Egypt -> Arabic
            'om': 'ar', // Oman -> Arabic
            'dz': 'ar', // Algeria -> Arabic
            'sa': 'ar', // Saudi Arabia -> Arabic
            'ae': 'ar', // UAE -> Arabic
            'kw': 'ar', // Kuwait -> Arabic
            'qa': 'ar', // Qatar -> Arabic
            'bh': 'ar', // Bahrain -> Arabic
            'jo': 'ar', // Jordan -> Arabic
            'lb': 'ar', // Lebanon -> Arabic
            'sy': 'ar', // Syria -> Arabic
            'iq': 'ar', // Iraq -> Arabic
            'ly': 'ar', // Libya -> Arabic
            'tn': 'ar', // Tunisia -> Arabic
            'ma': 'ar', // Morocco -> Arabic
            'sd': 'ar', // Sudan -> Arabic
            'ye': 'ar', // Yemen -> Arabic
            'ps': 'ar', // Palestine -> Arabic
            'it': 'it'  // Italy -> Italian
            // Any country not listed defaults to English
        },
        // Human-readable country names for validation messages
        countryNames: {
            'eg': 'Egypt', 'om': 'Oman', 'it': 'Italy', 'dz': 'Algeria',
            'sa': 'Saudi Arabia', 'ae': 'United Arab Emirates', 'kw': 'Kuwait',
            'qa': 'Qatar', 'bh': 'Bahrain', 'jo': 'Jordan', 'lb': 'Lebanon',
            'sy': 'Syria', 'iq': 'Iraq', 'ly': 'Libya', 'tn': 'Tunisia',
            'ma': 'Morocco', 'sd': 'Sudan', 'ye': 'Yemen', 'ps': 'Palestine',
            'us': 'United States', 'gb': 'United Kingdom', 'de': 'Germany',
            'fr': 'France', 'es': 'Spain', 'nl': 'Netherlands', 'be': 'Belgium',
            'ch': 'Switzerland', 'at': 'Austria', 'pl': 'Poland', 'tr': 'Turkey',
            'in': 'India', 'pk': 'Pakistan', 'bd': 'Bangladesh', 'cn': 'China',
            'jp': 'Japan', 'kr': 'South Korea', 'au': 'Australia', 'nz': 'New Zealand',
            'br': 'Brazil', 'mx': 'Mexico', 'ar': 'Argentina', 'za': 'South Africa',
            'ng': 'Nigeria', 'ke': 'Kenya', 'gh': 'Ghana', 'et': 'Ethiopia'
        }
    };

    // Extract country code from flag URL (e.g., "https://flagcdn.com/w40/dz.png" -> "dz")
    function extractCountryCodeFromFlag(flagUrl) {
        if (!flagUrl) return null;
        // Match pattern like /w40/xx.png or /xx.png where xx is the country code
        const match = flagUrl.match(/\/([a-z]{2})\.png$/i);
        return match ? match[1].toLowerCase() : null;
    }

    // Find territory by country code (extracted from flag URL)
    function findTerritoryByCountryCode(countryCode) {
        if (!countryCode || territories.length === 0) return null;
        const lowerCode = countryCode.toLowerCase();
        return territories.find(t => {
            const territoryCode = extractCountryCodeFromFlag(t.flag);
            return territoryCode === lowerCode;
        });
    }

    // Get the preferred language for a country code
    function getLanguageForCountryCode(countryCode) {
        if (!countryCode) return CONFIG.defaultLanguage;
        const lowerCode = countryCode.toLowerCase();
        const lang = CONFIG.countryLanguageDefaults[lowerCode];
        // Return the mapped language if supported, otherwise English
        return (lang && CONFIG.supportedLanguages.includes(lang)) ? lang : 'en';
    }

    // Get human-readable country name from code
    function getCountryNameFromCode(countryCode) {
        if (!countryCode) return countryCode;
        const lowerCode = countryCode.toLowerCase();
        return CONFIG.countryNames[lowerCode] || countryCode.toUpperCase();
    }

    // State
    let currentLanguage = CONFIG.defaultLanguage;
    let currentCountryId = null; // Territory ID from Dataverse
    let currentCountry = null; // Full country object with currency
    let territories = []; // List of all countries from API
    let translations = {};
    let isInitialized = false;
    let switcherBound = false; // Track if event listeners are bound
    let territoriesLoaded = false;

    // Helper function to get the API base URL
    function getApiBaseUrl() {
        const port = window.location.port;
        if (port === '5500' || port === '5501' || window.location.protocol === 'file:') {
            return 'http://localhost:3000';
        }
        return '';
    }

    // Detect user's preferred language
    function detectLanguage(detectedCountryCode = null) {
        // 1. Check localStorage for saved preference (user explicitly chose)
        const saved = localStorage.getItem(CONFIG.storageKey);
        if (saved && CONFIG.supportedLanguages.includes(saved)) {
            console.log(`[i18n] Using saved language preference: ${saved}`);
            return saved;
        }

        // 2. If we detected a country, use its preferred language
        if (detectedCountryCode) {
            const lang = getLanguageForCountryCode(detectedCountryCode);
            console.log(`[i18n] Using language from detected country (${detectedCountryCode}): ${lang}`);
            return lang;
        }

        // 3. Check browser language
        const browserLang = navigator.language.split('-')[0];
        if (CONFIG.supportedLanguages.includes(browserLang)) {
            console.log(`[i18n] Using browser language: ${browserLang}`);
            return browserLang;
        }

        // 4. Fall back to default (English)
        console.log(`[i18n] Using default language: ${CONFIG.defaultLanguage}`);
        return CONFIG.defaultLanguage;
    }

    // Check if header elements exist in DOM
    function headerElementsExist() {
        return document.querySelector('.switcher-section__options:not(.switcher-section__options--lang)') !== null ||
               document.querySelector('.mobile-country-pills') !== null;
    }

    // Load territories from API with timeout and retry
    async function loadTerritories(retryCount = 0) {
        const MAX_RETRIES = 2;
        const TIMEOUT_MS = 8000; // 8 second timeout

        // Check sessionStorage cache first
        const cached = sessionStorage.getItem(CONFIG.territoriesCacheKey);
        if (cached) {
            try {
                const { data, timestamp } = JSON.parse(cached);
                if (Date.now() - timestamp < CONFIG.territoriesCacheDuration) {
                    console.log('[i18n] Using cached territories');
                    territories = data;
                    territoriesLoaded = true;
                    // Only render if header elements exist
                    if (headerElementsExist()) {
                        renderCountryOptions();
                    }
                    return data;
                }
            } catch (e) {
                sessionStorage.removeItem(CONFIG.territoriesCacheKey);
            }
        }

        // Show loading state only if header elements exist
        if (headerElementsExist()) {
            showCountryLoadingState('loading');
        }

        // Fetch from API with timeout
        try {
            console.log(`[i18n] Fetching territories from API... (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const response = await fetch(getApiBaseUrl() + '/api/territories', {
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Failed to fetch territories: ${response.status}`);
            }
            const data = await response.json();
            territories = data.territories || [];
            territoriesLoaded = true;

            // Cache in sessionStorage
            sessionStorage.setItem(CONFIG.territoriesCacheKey, JSON.stringify({
                data: territories,
                timestamp: Date.now()
            }));

            console.log(`[i18n] Loaded ${territories.length} territories`);

            // Update UI only if header elements exist
            if (headerElementsExist()) {
                renderCountryOptions();
            }

            return territories;
        } catch (error) {
            console.error('[i18n] Error loading territories:', error.message);

            // Retry on network errors or timeouts
            if (retryCount < MAX_RETRIES && (error.name === 'AbortError' || error.name === 'TypeError')) {
                console.log(`[i18n] Retrying territories fetch...`);
                // Wait a bit before retry
                await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                return loadTerritories(retryCount + 1);
            }

            // Show error state after all retries exhausted
            territories = [];
            territoriesLoaded = true;
            // Only show error state if header elements exist
            if (headerElementsExist()) {
                showCountryLoadingState('error');
            }
            return [];
        }
    }

    // Show loading/error state in country selector
    function showCountryLoadingState(state) {
        const desktopContainer = document.querySelector('.switcher-section__options:not(.switcher-section__options--lang)');
        const mobileContainer = document.querySelector('.mobile-country-pills');

        const loadingHtml = `<div class="country-loading">Loading...</div>`;
        const errorHtml = `
            <div class="country-loading country-error" style="display: flex; flex-direction: column; align-items: center; gap: 0.5rem;">
                <span style="color: #e74c3c;">Failed to load countries</span>
                <button class="country-retry-btn" onclick="window.DrWeeeI18n.retryLoadTerritories()"
                    style="padding: 0.4rem 0.8rem; background: var(--primary-green, #00897b); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.75rem;">
                    <i class="fas fa-redo"></i> Retry
                </button>
            </div>
        `;

        const html = state === 'error' ? errorHtml : loadingHtml;

        if (desktopContainer) {
            desktopContainer.innerHTML = html;
        }
        if (mobileContainer) {
            mobileContainer.innerHTML = html;
        }
    }

    // Retry loading territories (called from retry button)
    async function retryLoadTerritories() {
        console.log('[i18n] Manually retrying territories load...');
        showCountryLoadingState('loading');
        await loadTerritories(0);

        // If territories loaded successfully, also update country state
        if (territories.length > 0 && !currentCountry) {
            currentCountry = await detectCountry();
            if (currentCountry) {
                currentCountryId = currentCountry.id;
                updateCountrySwitcher();
            }
        }
    }

    // Detect user's location via IP geolocation (no consent needed)
    async function detectGeoLocation() {
        // Try multiple geolocation services (all HTTPS, no API key needed)
        const geoServices = [
            {
                url: 'https://ipapi.co/json/',
                extract: (data) => data.country_code
            },
            {
                url: 'https://ipwho.is/',
                extract: (data) => data.success ? data.country_code : null
            }
        ];

        for (const service of geoServices) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout

                const response = await fetch(service.url, {
                    method: 'GET',
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) continue;

                const data = await response.json();
                const countryCode = service.extract(data);

                if (countryCode) {
                    console.log(`[i18n] Detected country from IP: ${countryCode}`);
                    // Store the detected country code for validation purposes
                    localStorage.setItem(CONFIG.detectedCountryCodeKey, countryCode);
                    return countryCode;
                }
            } catch (error) {
                console.warn(`[i18n] Geolocation service failed:`, error.message);
                continue; // Try next service
            }
        }

        console.warn('[i18n] All geolocation services failed, using default');
        return null;
    }

    // Get detected country code from geolocation
    function getDetectedCountryCode() {
        return localStorage.getItem(CONFIG.detectedCountryCodeKey);
    }

    // Get the territory that matches a country code (by comparing flag URLs)
    // Returns the territory object if found, null otherwise
    function getTerritoryForCountryCode(countryCode) {
        if (!countryCode || territories.length === 0) return null;
        return findTerritoryByCountryCode(countryCode);
    }

    // Check if a country code has a matching territory on the list
    function isCountryCodeOnTerritoryList(countryCode) {
        return getTerritoryForCountryCode(countryCode) !== null;
    }

    // Validate if user's selected country matches their detected location
    // Returns: { valid: true } or { valid: false, type: 'changed' | 'unavailable', ... }
    function validateCountrySelection() {
        const detectedCode = getDetectedCountryCode();
        const selectedCountry = currentCountry;

        // No detection available - can't validate
        if (!detectedCode) {
            return { valid: true, reason: 'no_detection' };
        }

        // Find the territory that matches the detected country code
        const expectedTerritory = getTerritoryForCountryCode(detectedCode);
        const isDetectedCountryAvailable = expectedTerritory !== null;

        // Get the country code from the selected territory's flag
        const selectedCountryCode = selectedCountry ? extractCountryCodeFromFlag(selectedCountry.flag) : null;

        // If user's selection matches detected country (compare country codes)
        if (selectedCountryCode && selectedCountryCode.toLowerCase() === detectedCode.toLowerCase()) {
            return { valid: true, reason: 'match' };
        }

        // Get human-readable country name for the detected code
        const detectedCountryName = getCountryNameFromCode(detectedCode);

        if (isDetectedCountryAvailable) {
            // User's detected country IS on the list, but they selected something different
            return {
                valid: false,
                type: 'changed',
                detectedCountryCode: detectedCode,
                detectedCountryName: detectedCountryName,
                expectedTerritoryName: expectedTerritory.name,
                selectedCountryName: selectedCountry?.name || 'Unknown'
            };
        } else {
            // User's detected country is NOT on the territory list
            return {
                valid: false,
                type: 'unavailable',
                detectedCountryCode: detectedCode,
                detectedCountryName: detectedCountryName,
                selectedCountryName: selectedCountry?.name || 'Unknown'
            };
        }
    }

    // Find territory by name (case-insensitive)
    function findTerritoryByName(name) {
        if (!name || territories.length === 0) return null;
        return territories.find(t => t.name.toLowerCase() === name.toLowerCase());
    }

    // Get default territory (Egypt) or first available
    function getDefaultTerritory() {
        // Try to find Egypt first
        const egypt = findTerritoryByName(CONFIG.defaultCountryName);
        if (egypt) return egypt;
        // Fall back to first territory
        return territories.length > 0 ? territories[0] : null;
    }

    // Detect user's preferred country (with geolocation support)
    async function detectCountry() {
        // 1. Check localStorage for saved preference (user explicitly chose)
        const savedId = localStorage.getItem(CONFIG.countryStorageKey);
        if (savedId && territories.length > 0) {
            const found = territories.find(t => t.id === savedId);
            if (found) {
                console.log(`[i18n] Using saved country preference: ${found.name}`);
                return found;
            }
        }

        // 2. Check if we've already done geo detection this session
        const geoDetected = sessionStorage.getItem(CONFIG.geoDetectedKey);
        if (geoDetected) {
            // We've already tried geo detection, use default
            return getDefaultTerritory();
        }

        // 3. Try IP geolocation (only on first visit)
        console.log('[i18n] First visit - detecting location...');
        const countryCode = await detectGeoLocation();

        // Mark that we've done geo detection
        sessionStorage.setItem(CONFIG.geoDetectedKey, 'true');

        if (countryCode) {
            // Find territory by matching country code from flag URL
            const territory = findTerritoryByCountryCode(countryCode);
            if (territory) {
                console.log(`[i18n] Matched ${countryCode} to territory: ${territory.name}`);
                // Save to localStorage so user doesn't need to select again
                localStorage.setItem(CONFIG.countryStorageKey, territory.id);
                return territory;
            }
            console.log(`[i18n] Country ${countryCode} not found in territories, using default (Egypt)`);
        }

        // 4. Fall back to default (Egypt + English)
        const defaultTerritory = getDefaultTerritory();
        if (defaultTerritory) {
            // Save default to localStorage
            localStorage.setItem(CONFIG.countryStorageKey, defaultTerritory.id);
        }
        return defaultTerritory;
    }

    // Set country by territory ID
    function setCountry(countryId) {
        const country = territories.find(t => t.id === countryId);
        if (!country) {
            console.error(`[i18n] Country not found: ${countryId}`);
            return false;
        }

        const previousCountryId = currentCountryId;
        const isCountryChange = previousCountryId && previousCountryId !== countryId;

        console.log(`[i18n] Setting country to: ${country.name}`);
        currentCountryId = countryId;
        currentCountry = country;
        localStorage.setItem(CONFIG.countryStorageKey, countryId);

        // Clear carts on country change (prices differ by territory)
        if (isCountryChange) {
            console.log('[i18n] Country changed - clearing carts');
            clearAllCarts();
        }

        // Update UI
        updateCountrySwitcher();

        // Dispatch event for other scripts to react (include currency info)
        window.dispatchEvent(new CustomEvent('countryChanged', {
            detail: {
                countryId: countryId,
                country: country,
                previousCountryId: previousCountryId,
                isCountryChange: isCountryChange
            }
        }));

        return true;
    }

    // Clear all shopping carts when country changes
    function clearAllCarts() {
        // Clear store cart from sessionStorage
        sessionStorage.removeItem('drweee_store_cart');

        // Clear e-waste selected items from sessionStorage
        sessionStorage.removeItem('weee_selected_items');

        console.log('[i18n] All carts cleared due to country change');
    }

    // Load translations from JSON file
    async function loadTranslations(lang) {
        // Check sessionStorage cache first
        const cacheKey = CONFIG.cacheKey + lang;
        const cached = sessionStorage.getItem(cacheKey);

        if (cached) {
            try {
                const { data, timestamp } = JSON.parse(cached);
                if (Date.now() - timestamp < CONFIG.cacheDuration) {
                    return data;
                }
            } catch (e) {
                sessionStorage.removeItem(cacheKey);
            }
        }

        // Fetch from server
        try {
            const response = await fetch(`locales/${lang}.json?v=${Date.now()}`);
            if (!response.ok) {
                throw new Error(`Failed to load ${lang}.json`);
            }
            const data = await response.json();

            // Cache in sessionStorage
            sessionStorage.setItem(cacheKey, JSON.stringify({
                data,
                timestamp: Date.now()
            }));

            return data;
        } catch (error) {
            console.error(`[i18n] Error loading translations for ${lang}:`, error);

            // If not English, try falling back to English
            if (lang !== 'en') {
                console.warn('[i18n] Falling back to English translations');
                return loadTranslations('en');
            }

            return {};
        }
    }

    // Get nested translation value using dot notation
    function getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : null;
        }, obj);
    }

    // Translate a single key
    function translate(key, params = {}) {
        let text = getNestedValue(translations, key);

        if (text === null || text === undefined) {
            // Return null for missing translations
            return null;
        }

        // Replace parameters {{param}}
        if (params && typeof text === 'string') {
            Object.keys(params).forEach(param => {
                text = text.replace(new RegExp(`{{${param}}}`, 'g'), params[param]);
            });
        }

        return text;
    }

    // Apply translations to DOM elements
    function applyTranslations() {
        const elementsCount = document.querySelectorAll('[data-i18n]').length;
        console.log(`[i18n] Applying translations to ${elementsCount} elements for language: ${currentLanguage}`);

        // Check if translations are loaded
        if (!translations || Object.keys(translations).length === 0) {
            console.warn('[i18n] No translations loaded yet');
            return;
        }

        // Translate elements with data-i18n attribute (textContent)
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translated = translate(key);
            // Only update if we have a valid translation
            if (translated !== null) {
                el.textContent = translated;
            }
        });

        // Translate elements with data-i18n-html attribute (innerHTML)
        document.querySelectorAll('[data-i18n-html]').forEach(el => {
            const key = el.getAttribute('data-i18n-html');
            const translated = translate(key);
            if (translated !== null) {
                el.innerHTML = translated;
            }
        });

        // Translate placeholders
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            const translated = translate(key);
            if (translated !== null) {
                el.setAttribute('placeholder', translated);
            }
        });

        // Translate titles/aria-labels
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            const translated = translate(key);
            if (translated !== null) {
                el.setAttribute('title', translated);
                el.setAttribute('aria-label', translated);
            }
        });

        // Translate alt text
        document.querySelectorAll('[data-i18n-alt]').forEach(el => {
            const key = el.getAttribute('data-i18n-alt');
            const translated = translate(key);
            if (translated !== null) {
                el.setAttribute('alt', translated);
            }
        });

        // Update page title if data-i18n-title exists on html/head
        const pageTitleKey = document.querySelector('title')?.getAttribute('data-i18n');
        if (pageTitleKey) {
            const translated = translate(pageTitleKey);
            if (translated !== null) {
                document.title = translated;
            }
        }
    }

    // Apply RTL direction for Arabic
    function applyDirection(lang) {
        const isRtl = CONFIG.rtlLanguages.includes(lang);

        document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
        document.documentElement.lang = lang;

        // Add/remove RTL class for CSS targeting
        if (document.body) {
            document.body.classList.toggle('rtl', isRtl);
            document.body.classList.toggle('ltr', !isRtl);
        }

        // Apply RTL styles directly to header elements (fixes dynamically loaded header)
        applyHeaderRtlStyles(isRtl);
    }

    // Apply RTL styles directly to header elements via JavaScript
    function applyHeaderRtlStyles(isRtl) {
        const headerContainer = document.querySelector('.header__container');
        const headerLogo = document.querySelector('.header__logo');
        const navList = document.querySelector('.nav__list');
        const headerActions = document.querySelector('.header__actions');
        const mobileMenu = document.querySelector('.mobile-menu');
        const mobileMenuHeader = document.querySelector('.mobile-menu__header');

        if (isRtl) {
            // Apply RTL styles
            if (headerContainer) headerContainer.style.flexDirection = 'row-reverse';
            if (headerLogo) headerLogo.style.flexDirection = 'row-reverse';
            if (navList) navList.style.flexDirection = 'row-reverse';
            if (headerActions) headerActions.style.flexDirection = 'row-reverse';
            if (mobileMenu) {
                mobileMenu.style.right = 'auto';
                mobileMenu.style.left = '0';
            }
            // Mobile menu header: use 'row' so close button appears on left (title on right)
            if (mobileMenuHeader) mobileMenuHeader.style.flexDirection = 'row';
        } else {
            // Reset to LTR (remove inline styles to use default CSS)
            if (headerContainer) headerContainer.style.flexDirection = '';
            if (headerLogo) headerLogo.style.flexDirection = '';
            if (navList) navList.style.flexDirection = '';
            if (headerActions) headerActions.style.flexDirection = '';
            if (mobileMenu) {
                mobileMenu.style.right = '';
                mobileMenu.style.left = '';
            }
            if (mobileMenuHeader) mobileMenuHeader.style.flexDirection = '';
        }
    }

    // Update language switcher UI
    function updateLanguageSwitcher() {
        // Update all language switcher current buttons (desktop and mobile)
        document.querySelectorAll('.language-switcher__current').forEach(btn => {
            btn.textContent = currentLanguage.toUpperCase();
        });

        // Update active state for language options in dropdown
        document.querySelectorAll('.lang-option[data-lang]').forEach(btn => {
            const btnLang = btn.getAttribute('data-lang');
            btn.classList.toggle('active', btnLang === currentLanguage);
        });

        // Update mobile language pills active state
        document.querySelectorAll('.mobile-lang-pill[data-lang]').forEach(pill => {
            const pillLang = pill.getAttribute('data-lang');
            pill.classList.toggle('active', pillLang === currentLanguage);
        });
    }

    // Update country switcher UI
    function updateCountrySwitcher() {
        // Update current country flag in trigger
        const currentFlagImg = document.getElementById('current-country-flag');
        if (currentFlagImg && currentCountry && currentCountry.flag) {
            currentFlagImg.src = currentCountry.flag;
        }

        // Update active state for country options in dropdown
        document.querySelectorAll('.country-option[data-country]').forEach(btn => {
            const btnCountryId = btn.getAttribute('data-country');
            btn.classList.toggle('active', currentCountry && btnCountryId === currentCountry.id);
        });

        // Update mobile country pills active state
        document.querySelectorAll('.mobile-country-pill[data-country]').forEach(pill => {
            const pillCountryId = pill.getAttribute('data-country');
            pill.classList.toggle('active', currentCountry && pillCountryId === currentCountry.id);
        });
    }

    // Render country options dynamically in the switcher
    function renderCountryOptions() {
        const desktopContainer = document.querySelector('.switcher-section__options:not(.switcher-section__options--lang)');
        const mobileContainer = document.querySelector('.mobile-country-pills');

        // If no territories loaded yet, show appropriate state
        if (!territories || territories.length === 0) {
            console.warn('[i18n] No territories to render');
            // If territoriesLoaded is true but array is empty, it means loading failed
            if (territoriesLoaded) {
                showCountryLoadingState('error');
            }
            // Otherwise, loading is still in progress - keep showing "Loading..."
            return;
        }

        // Render desktop country options
        if (desktopContainer) {
            desktopContainer.innerHTML = territories.map(territory => `
                <button class="country-option${currentCountry && currentCountry.id === territory.id ? ' active' : ''}" data-country="${territory.id}">
                    <img src="${territory.flag}" alt="" class="language-switcher__flag">
                    <span>${territory.name}</span>
                </button>
            `).join('');
        }

        // Render mobile country pills
        if (mobileContainer) {
            mobileContainer.innerHTML = territories.map(territory => `
                <button class="mobile-country-pill${currentCountry && currentCountry.id === territory.id ? ' active' : ''}" data-country="${territory.id}" aria-label="${territory.name}">
                    <img src="${territory.flag}" alt="" class="mobile-country-pill__flag">
                    <span class="mobile-country-pill__name">${territory.name}</span>
                </button>
            `).join('');
        }

        console.log(`[i18n] Rendered ${territories.length} country options`);
    }

    // Initialize language switcher event listeners
    function initLanguageSwitcher() {
        // Prevent duplicate binding
        if (switcherBound) {
            // Just update the UI
            updateLanguageSwitcher();
            updateCountrySwitcher();
            return;
        }

        // Use event delegation on document for language and country buttons
        document.addEventListener('click', function(e) {
            // Handle mobile country pill clicks
            const mobileCountryPill = e.target.closest('.mobile-country-pill[data-country]');
            if (mobileCountryPill) {
                e.preventDefault();
                e.stopPropagation();
                const country = mobileCountryPill.getAttribute('data-country');
                if (country && country !== currentCountry) {
                    console.log(`[i18n] Changing country via mobile pill to: ${country}`);
                    setCountry(country);
                }
                return;
            }

            // Handle mobile language pill clicks
            const mobileLangPill = e.target.closest('.mobile-lang-pill[data-lang]');
            if (mobileLangPill) {
                e.preventDefault();
                e.stopPropagation();
                const lang = mobileLangPill.getAttribute('data-lang');
                if (lang && lang !== currentLanguage) {
                    console.log(`[i18n] Changing language via mobile pill to: ${lang}`);
                    setLanguage(lang);
                }
                return;
            }

            // Handle desktop country option clicks
            const countryBtn = e.target.closest('.country-option[data-country]');
            if (countryBtn) {
                e.preventDefault();
                e.stopPropagation();
                const country = countryBtn.getAttribute('data-country');
                if (country && country !== currentCountry) {
                    console.log(`[i18n] Changing country to: ${country}`);
                    setCountry(country);
                }
                return;
            }

            // Handle desktop language option clicks
            const langBtn = e.target.closest('.lang-option[data-lang]');
            if (langBtn) {
                e.preventDefault();
                e.stopPropagation();
                const lang = langBtn.getAttribute('data-lang');
                if (lang && lang !== currentLanguage) {
                    console.log(`[i18n] Changing language to: ${lang}`);
                    setLanguage(lang);
                }
                return;
            }

            // Handle trigger clicks
            const trigger = e.target.closest('.language-switcher__trigger');
            if (trigger) {
                e.preventDefault();
                e.stopPropagation();
                const switcher = trigger.closest('.language-switcher');
                const menu = switcher?.querySelector('.language-switcher__menu');
                if (menu) {
                    // Close other dropdowns first
                    document.querySelectorAll('.language-switcher__menu').forEach(m => {
                        if (m !== menu) m.classList.remove('is-open');
                    });
                    const isOpen = menu.classList.toggle('is-open');
                    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                }
                return;
            }

            // Close all dropdowns on outside click
            document.querySelectorAll('.language-switcher__menu').forEach(menu => {
                menu.classList.remove('is-open');
            });
            document.querySelectorAll('.language-switcher__trigger').forEach(trigger => {
                trigger.setAttribute('aria-expanded', 'false');
            });
        });

        // Handle keyboard escape
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                document.querySelectorAll('.language-switcher__menu').forEach(menu => {
                    menu.classList.remove('is-open');
                });
                document.querySelectorAll('.language-switcher__trigger').forEach(trigger => {
                    trigger.setAttribute('aria-expanded', 'false');
                });
            }
        });

        switcherBound = true;
        console.log('[i18n] Language and country switcher initialized');
    }

    // Set language and apply translations
    async function setLanguage(lang) {
        if (!CONFIG.supportedLanguages.includes(lang)) {
            console.error(`[i18n] Unsupported language: ${lang}`);
            return false;
        }

        console.log(`[i18n] Setting language to: ${lang}`);
        currentLanguage = lang;
        localStorage.setItem(CONFIG.storageKey, lang);

        // Load translations
        translations = await loadTranslations(lang);

        // Apply to DOM
        applyDirection(lang);
        applyTranslations();
        updateLanguageSwitcher();

        // Dispatch event for other scripts to react
        window.dispatchEvent(new CustomEvent('languageChanged', {
            detail: { language: lang, isRtl: CONFIG.rtlLanguages.includes(lang) }
        }));

        console.log(`[i18n] Language changed to: ${lang}`);
        return true;
    }

    // Translate dynamic content via API
    async function translateDynamic(text, targetLang = null) {
        const lang = targetLang || currentLanguage;

        // No need to translate if already in source language
        if (lang === 'en') return text;
        if (!text || typeof text !== 'string') return text;

        try {
            const response = await fetch(getApiBaseUrl() + '/api/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, targetLang: lang })
            });

            if (!response.ok) {
                throw new Error('Translation API error');
            }

            const data = await response.json();
            return data.translatedText || text;
        } catch (error) {
            console.error('[i18n] Dynamic translation error:', error);
            return text;
        }
    }

    // Translate batch of texts
    async function translateBatch(texts, targetLang = null) {
        const lang = targetLang || currentLanguage;

        if (lang === 'en') return texts;
        if (!Array.isArray(texts) || texts.length === 0) return texts;

        try {
            const response = await fetch(getApiBaseUrl() + '/api/translate-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texts, targetLang: lang })
            });

            if (!response.ok) {
                throw new Error('Batch translation API error');
            }

            const data = await response.json();
            return data.translations || texts;
        } catch (error) {
            console.error('[i18n] Batch translation error:', error);
            return texts;
        }
    }

    // Initialize the i18n system
    async function init() {
        if (isInitialized) {
            console.log('[i18n] Already initialized');
            return;
        }

        // Clear old cache keys on init (one-time migration)
        ['drweee_translations_en', 'drweee_translations_ar', 'drweee_translations_it',
         'drweee_translations_v2_en', 'drweee_translations_v2_ar', 'drweee_translations_v2_it',
         'drweee_translations_v3_en', 'drweee_translations_v3_ar', 'drweee_translations_v3_it'].forEach(key => {
            sessionStorage.removeItem(key);
        });

        // Load territories from API first
        await loadTerritories();

        // Detect country first (may involve IP geolocation)
        // This also returns the detected country code for language selection
        let detectedCountryCode = null;

        // Check if this is first visit (no saved preferences)
        const hasSavedCountry = localStorage.getItem(CONFIG.countryStorageKey);
        const hasSavedLanguage = localStorage.getItem(CONFIG.storageKey);

        if (!hasSavedCountry && !sessionStorage.getItem(CONFIG.geoDetectedKey)) {
            // First visit - do geolocation
            console.log('[i18n] First visit - performing geolocation...');
            detectedCountryCode = await detectGeoLocation();
            sessionStorage.setItem(CONFIG.geoDetectedKey, 'true');
        }

        // Detect country (uses cached geo result or saved preference)
        currentCountry = await detectCountry();
        if (currentCountry) {
            currentCountryId = currentCountry.id;
        }

        // Detect language (considers detected country if no saved preference)
        currentLanguage = detectLanguage(detectedCountryCode);

        // If this is first visit and we detected a country, also save the language
        if (!hasSavedLanguage && detectedCountryCode) {
            const lang = getLanguageForCountryCode(detectedCountryCode);
            if (CONFIG.supportedLanguages.includes(lang)) {
                localStorage.setItem(CONFIG.storageKey, lang);
            }
        }

        console.log(`[i18n] Detected language: ${currentLanguage}, country: ${currentCountry?.name || 'none'}`);

        translations = await loadTranslations(currentLanguage);

        applyDirection(currentLanguage);
        applyTranslations();
        initLanguageSwitcher();
        updateLanguageSwitcher();
        renderCountryOptions(); // Render dynamic country options
        updateCountrySwitcher();

        isInitialized = true;
        console.log(`[i18n] Initialized with language: ${currentLanguage}, country: ${currentCountry?.name || 'none'}`);

        // Dispatch ready event for other scripts to react
        window.dispatchEvent(new CustomEvent('i18nReady', {
            detail: {
                language: currentLanguage,
                country: currentCountry,
                territories: territories,
                isRtl: CONFIG.rtlLanguages.includes(currentLanguage)
            }
        }));
    }

    // Re-apply translations (call after dynamic content loads)
    async function refresh() {
        console.log('[i18n] Refresh called - territories:', territories.length, 'currentCountry:', currentCountry?.name);

        // If territories haven't loaded yet, try to load them
        if (!territories || territories.length === 0) {
            console.log('[i18n] Refresh: No territories loaded, attempting to load...');
            await loadTerritories(0);

            // If still no territories, we had an error - the error state will be shown
            if (!territories || territories.length === 0) {
                console.warn('[i18n] Refresh: Failed to load territories');
            }
        }

        // If we have territories but no current country set, detect it
        if (territories.length > 0 && !currentCountry) {
            console.log('[i18n] Refresh: Setting current country...');
            currentCountry = await detectCountry();
            if (currentCountry) {
                currentCountryId = currentCountry.id;
            }
        }

        applyTranslations();
        updateLanguageSwitcher();
        renderCountryOptions(); // Re-render country options for dynamically loaded header
        updateCountrySwitcher();

        // Re-init switcher if not already done (for dynamically loaded headers)
        if (!switcherBound) {
            initLanguageSwitcher();
        }

        // Re-apply RTL styles to header elements (for dynamically loaded header)
        const isRtl = CONFIG.rtlLanguages.includes(currentLanguage);
        applyHeaderRtlStyles(isRtl);

        console.log('[i18n] Refresh complete - language:', currentLanguage, 'country:', currentCountry?.name);
    }

    // Clear translation cache (useful for development)
    function clearCache() {
        CONFIG.supportedLanguages.forEach(lang => {
            sessionStorage.removeItem(CONFIG.cacheKey + lang);
        });
        // Also clear old cache keys
        ['drweee_translations_en', 'drweee_translations_ar', 'drweee_translations_it',
         'drweee_translations_v2_en', 'drweee_translations_v2_ar', 'drweee_translations_v2_it'].forEach(key => {
            sessionStorage.removeItem(key);
        });
        console.log('[i18n] Cache cleared');
    }

    // Debug function to check translations
    function debug() {
        console.log('[i18n] Debug info:');
        console.log('  Current language:', currentLanguage);
        console.log('  Translations loaded:', Object.keys(translations).length > 0);
        console.log('  Translation keys:', Object.keys(translations));
        if (translations.home && translations.home.hero) {
            console.log('  home.hero.description:', translations.home.hero.description);
        }
    }

    // Public API
    // Test function to simulate being in a different country
    function simulateCountry(countryName) {
        const territory = findTerritoryByName(countryName);
        if (!territory) {
            console.error(`[i18n] Territory "${countryName}" not found. Available: ${territories.map(t => t.name).join(', ')}`);
            return false;
        }

        // Get the country code from the territory's flag URL and determine language
        const countryCode = extractCountryCodeFromFlag(territory.flag);
        const language = getLanguageForCountryCode(countryCode);

        console.log(`[i18n] Simulating country: ${territory.name} (code: ${countryCode}) with language: ${language}`);

        // Clear and set new preferences
        localStorage.setItem(CONFIG.countryStorageKey, territory.id);
        localStorage.setItem(CONFIG.storageKey, language);
        // Also store the simulated country code for validation
        if (countryCode) {
            localStorage.setItem(CONFIG.detectedCountryCodeKey, countryCode);
        }
        sessionStorage.removeItem(CONFIG.geoDetectedKey);

        // Reload the page to apply
        location.reload();
        return true;
    }

    // Reset to auto-detect on next visit
    function resetPreferences() {
        localStorage.removeItem(CONFIG.countryStorageKey);
        localStorage.removeItem(CONFIG.storageKey);
        localStorage.removeItem(CONFIG.detectedCountryCodeKey);
        sessionStorage.removeItem(CONFIG.geoDetectedKey);
        sessionStorage.removeItem(CONFIG.territoriesCacheKey);
        console.log('[i18n] Preferences cleared. Reload to auto-detect again.');
        location.reload();
    }

    window.DrWeeeI18n = {
        init,
        refresh,
        setLanguage,
        setCountry,
        translate,
        translateDynamic,
        translateBatch,
        loadTerritories,
        retryLoadTerritories,
        getCurrentLanguage: () => currentLanguage,
        getCurrentCountry: () => currentCountry,
        getTerritories: () => territories,
        getSupportedLanguages: () => CONFIG.supportedLanguages,
        getLanguageInfo: (lang) => CONFIG.languageNames[lang],
        getCountryById: (id) => territories.find(t => t.id === id),
        isRtl: () => CONFIG.rtlLanguages.includes(currentLanguage),
        clearCache,
        debug,
        // Country validation
        validateCountrySelection,
        getDetectedCountryCode,
        clearAllCarts,
        // Testing helpers
        simulateCountry,
        resetPreferences
    };

    // Expose t() as a shorthand for translate
    window.t = translate;

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // DOM already loaded
        init();
    }

})();
