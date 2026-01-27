/**
 * Deep Link Router for PWA
 * Converts friendly URLs to hash-based navigation for Dynamics 365
 * Supports paths like /app/pos, /app/finance/reports, etc.
 */

class DeepLinkRouter {
    constructor() {
        // Module name aliases for friendly URLs
        this.moduleAliases = {
            // POS aliases
            'pos': 'pos',
            'point-of-sale': 'pos',
            'sales': 'pos',

            // E-Waste aliases
            'ewaste': 'ewaste',
            'e-waste': 'ewaste',
            'recycling': 'ewaste',
            'waste': 'ewaste',

            // Stock aliases
            'stock': 'stock',
            'inventory': 'stock',
            'warehouse': 'stock',

            // Manufacturing aliases
            'manufacturing': 'manufacturing',
            'production': 'manufacturing',
            'factory': 'manufacturing',

            // Finance aliases
            'finance': 'finance',
            'accounting': 'finance',
            'accounts': 'finance',

            // Training aliases
            'training': 'training',
            'learn': 'training',
            'help': 'training',
            'guide': 'training',

            // CRM aliases
            'crm': 'crm',
            'customers': 'crm',
            'clients': 'crm',

            // HR aliases
            'hr': 'hr',
            'human-resources': 'hr',
            'employees': 'hr',
            'staff': 'hr',

            // Admin aliases
            'admin': 'admin',
            'settings': 'admin',
            'administration': 'admin',
            'config': 'admin'
        };

        this.init();
    }

    init() {
        // Parse initial URL
        this.handleInitialRoute();

        // Listen for navigation changes
        window.addEventListener('popstate', () => {
            this.handleRoute(window.location.pathname + window.location.hash);
        });

        // Listen for hash changes
        window.addEventListener('hashchange', () => {
            this.handleHashChange();
        });

        console.log('[DeepLinkRouter] Initialized');
    }

    /**
     * Handle initial route on page load
     */
    handleInitialRoute() {
        const fullPath = window.location.pathname + window.location.hash;
        this.handleRoute(fullPath);
    }

    /**
     * Handle route changes
     */
    handleRoute(fullPath) {
        console.log('[DeepLinkRouter] Handling route:', fullPath);

        // Extract path after /app
        const match = fullPath.match(/\/app\/?([^#]*)(#.*)?/);
        if (!match) return;

        const pathPart = match[1] || '';
        const existingHash = match[2] || '';

        // If there's already a valid hash, use it
        if (existingHash && existingHash.length > 1) {
            console.log('[DeepLinkRouter] Using existing hash:', existingHash);
            return;
        }

        // Convert path segments to hash
        // /app/pos/sales -> #pos/sales
        const segments = pathPart.split('/').filter(Boolean);

        if (segments.length === 0) {
            // No path, no navigation needed
            return;
        }

        // Resolve module alias
        const moduleAlias = segments[0].toLowerCase();
        const moduleId = this.moduleAliases[moduleAlias] || moduleAlias;
        const section = segments.slice(1).join('/');

        const hash = section ? `#${moduleId}/${section}` : `#${moduleId}`;

        console.log('[DeepLinkRouter] Resolved to hash:', hash);
        this.navigateToHash(hash);
    }

    /**
     * Handle hash changes
     */
    handleHashChange() {
        const hash = window.location.hash;
        console.log('[DeepLinkRouter] Hash changed:', hash);

        // Notify PWA Bridge if loaded
        if (window.pwaBridge?.isLoaded && hash) {
            window.pwaBridge.navigateToHash(hash);
        }
    }

    /**
     * Navigate to a specific hash
     */
    navigateToHash(hash) {
        // Update URL without reloading
        const newUrl = '/app' + hash;
        const currentUrl = window.location.pathname + window.location.hash;

        if (currentUrl !== newUrl) {
            console.log('[DeepLinkRouter] Updating URL to:', newUrl);
            history.replaceState(null, '', newUrl);
        }

        // Send to Dynamics via bridge if available
        if (window.pwaBridge?.isLoaded) {
            const cleanHash = hash.replace(/^#/, '');
            const [moduleId, ...sectionParts] = cleanHash.split('/');
            const section = sectionParts.join('/');

            window.pwaBridge.sendToDynamics({
                type: 'pwa:navigate',
                moduleId: moduleId,
                section: section || null
            });
        }
    }

    /**
     * Create a deep link URL for a module
     */
    createDeepLink(moduleId, section = null) {
        const base = window.location.origin + '/app';
        const hash = section ? `#${moduleId}/${section}` : `#${moduleId}`;
        return base + hash;
    }

    /**
     * Get module info from current URL
     */
    getCurrentModule() {
        const hash = window.location.hash;
        if (!hash) return null;

        const cleanHash = hash.replace(/^#/, '');
        const [moduleId, ...sectionParts] = cleanHash.split('/');

        return {
            moduleId: moduleId,
            section: sectionParts.join('/') || null,
            fullPath: cleanHash
        };
    }

    /**
     * Navigate to a module programmatically
     */
    goToModule(moduleId, section = null) {
        const hash = section ? `#${moduleId}/${section}` : `#${moduleId}`;
        this.navigateToHash(hash);
    }

    /**
     * Go back to home (no module selected)
     */
    goHome() {
        history.replaceState(null, '', '/app');

        if (window.pwaBridge?.isLoaded) {
            window.pwaBridge.sendToDynamics({
                type: 'pwa:navigate',
                action: 'home'
            });
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.deepLinkRouter = new DeepLinkRouter();
});
