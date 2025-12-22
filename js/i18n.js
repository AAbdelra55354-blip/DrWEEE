// js/i18n.js
// DR.WEEE Multi-Language Support Module
// Supports: English (en), Arabic (ar), Italian (it)

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        defaultLanguage: 'en',
        supportedLanguages: ['en', 'ar', 'it'],
        storageKey: 'drweee_language',
        cacheKey: 'drweee_translations_v15_', // Version bump to invalidate old cache (added login page i18n)
        cacheDuration: 60 * 60 * 1000, // 1 hour (reduced for development)
        rtlLanguages: ['ar'],
        languageNames: {
            en: { native: 'English', flag: '🇬🇧' },
            ar: { native: 'العربية', flag: '🇪🇬' },
            it: { native: 'Italiano', flag: '🇮🇹' }
        }
    };

    // State
    let currentLanguage = CONFIG.defaultLanguage;
    let translations = {};
    let isInitialized = false;
    let switcherBound = false; // Track if event listeners are bound

    // Helper function to get the API base URL
    function getApiBaseUrl() {
        const port = window.location.port;
        if (port === '5500' || port === '5501' || window.location.protocol === 'file:') {
            return 'http://localhost:3000';
        }
        return '';
    }

    // Detect user's preferred language
    function detectLanguage() {
        // 1. Check localStorage for saved preference
        const saved = localStorage.getItem(CONFIG.storageKey);
        if (saved && CONFIG.supportedLanguages.includes(saved)) {
            return saved;
        }

        // 2. Check browser language
        const browserLang = navigator.language.split('-')[0];
        if (CONFIG.supportedLanguages.includes(browserLang)) {
            return browserLang;
        }

        // 3. Fall back to default
        return CONFIG.defaultLanguage;
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

        if (text === null) {
            // Don't warn for missing keys - just return key
            return key;
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
        console.log(`[i18n] Applying translations to ${elementsCount} elements`);

        // Translate elements with data-i18n attribute (textContent)
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translated = translate(key);
            if (translated && translated !== key) {
                el.textContent = translated;
            } else if (translated === key) {
                console.warn(`[i18n] Missing translation for key: ${key}`);
            }
        });

        // Translate elements with data-i18n-html attribute (innerHTML)
        document.querySelectorAll('[data-i18n-html]').forEach(el => {
            const key = el.getAttribute('data-i18n-html');
            const translated = translate(key);
            if (translated !== key) {
                el.innerHTML = translated;
            }
        });

        // Translate placeholders
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            const translated = translate(key);
            if (translated !== key) {
                el.setAttribute('placeholder', translated);
            }
        });

        // Translate titles/aria-labels
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            const translated = translate(key);
            if (translated !== key) {
                el.setAttribute('title', translated);
                el.setAttribute('aria-label', translated);
            }
        });

        // Translate alt text
        document.querySelectorAll('[data-i18n-alt]').forEach(el => {
            const key = el.getAttribute('data-i18n-alt');
            const translated = translate(key);
            if (translated !== key) {
                el.setAttribute('alt', translated);
            }
        });

        // Update page title if data-i18n-title exists on html/head
        const pageTitleKey = document.querySelector('title')?.getAttribute('data-i18n');
        if (pageTitleKey) {
            const translated = translate(pageTitleKey);
            if (translated !== pageTitleKey) {
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

    // Flag URLs for each language
    const FLAG_URLS = {
        en: 'https://flagcdn.com/w40/gb.png',
        ar: 'https://flagcdn.com/w40/eg.png',
        it: 'https://flagcdn.com/w40/it.png'
    };

    // Update language switcher UI
    function updateLanguageSwitcher() {
        // Update all language switcher current buttons (desktop and mobile)
        document.querySelectorAll('.language-switcher__current').forEach(btn => {
            btn.textContent = currentLanguage.toUpperCase();
        });

        // Update current flag in trigger
        const currentFlagImg = document.getElementById('current-lang-flag');
        if (currentFlagImg && FLAG_URLS[currentLanguage]) {
            currentFlagImg.src = FLAG_URLS[currentLanguage];
        }

        // Update active state in all dropdowns
        document.querySelectorAll('.language-switcher__menu button[data-lang]').forEach(btn => {
            const btnLang = btn.getAttribute('data-lang');
            btn.classList.toggle('active', btnLang === currentLanguage);
        });

        // Update mobile language pills active state
        document.querySelectorAll('.mobile-lang-pill[data-lang]').forEach(pill => {
            const pillLang = pill.getAttribute('data-lang');
            pill.classList.toggle('active', pillLang === currentLanguage);
        });
    }

    // Initialize language switcher event listeners
    function initLanguageSwitcher() {
        // Prevent duplicate binding
        if (switcherBound) {
            // Just update the UI
            updateLanguageSwitcher();
            return;
        }

        // Use event delegation on document for language buttons
        document.addEventListener('click', function(e) {
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

            // Handle desktop language button clicks
            const langBtn = e.target.closest('.language-switcher__menu button[data-lang]');
            if (langBtn) {
                e.preventDefault();
                e.stopPropagation();
                const lang = langBtn.getAttribute('data-lang');
                if (lang && lang !== currentLanguage) {
                    console.log(`[i18n] Changing language to: ${lang}`);
                    setLanguage(lang);
                }
                // Close all menus
                document.querySelectorAll('.language-switcher__menu').forEach(menu => {
                    menu.classList.remove('is-open');
                });
                document.querySelectorAll('.language-switcher__trigger').forEach(trigger => {
                    trigger.setAttribute('aria-expanded', 'false');
                });
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
        console.log('[i18n] Language switcher initialized');
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

        currentLanguage = detectLanguage();
        console.log(`[i18n] Detected language: ${currentLanguage}`);

        translations = await loadTranslations(currentLanguage);

        applyDirection(currentLanguage);
        applyTranslations();
        initLanguageSwitcher();
        updateLanguageSwitcher();

        isInitialized = true;
        console.log(`[i18n] Initialized with language: ${currentLanguage}`);

        // Dispatch ready event for other scripts to react
        window.dispatchEvent(new CustomEvent('i18nReady', {
            detail: { language: currentLanguage, isRtl: CONFIG.rtlLanguages.includes(currentLanguage) }
        }));
    }

    // Re-apply translations (call after dynamic content loads)
    function refresh() {
        applyTranslations();
        updateLanguageSwitcher();

        // Re-init switcher if not already done (for dynamically loaded headers)
        if (!switcherBound) {
            initLanguageSwitcher();
        }

        // Re-apply RTL styles to header elements (for dynamically loaded header)
        const isRtl = CONFIG.rtlLanguages.includes(currentLanguage);
        applyHeaderRtlStyles(isRtl);
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
    window.DrWeeeI18n = {
        init,
        refresh,
        setLanguage,
        translate,
        translateDynamic,
        translateBatch,
        getCurrentLanguage: () => currentLanguage,
        getSupportedLanguages: () => CONFIG.supportedLanguages,
        getLanguageInfo: (lang) => CONFIG.languageNames[lang],
        isRtl: () => CONFIG.rtlLanguages.includes(currentLanguage),
        clearCache,
        debug
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
