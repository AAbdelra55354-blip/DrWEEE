/**
 * DR.WEEE Analytics Module
 * Google Analytics 4 Event Tracking via GTM dataLayer
 * Measurement ID: G-LJ3HG6ELPZ
 * GTM Container: GTM-TM738SMJ
 */

// Initialize dataLayer
window.dataLayer = window.dataLayer || [];

// Analytics configuration
const DrWeeeAnalytics = {
    // Debug mode - set to false in production
    debug: false,

    /**
     * Push event to dataLayer
     */
    pushEvent: function(eventName, eventParams = {}) {
        const eventData = {
            event: eventName,
            ...eventParams
        };

        window.dataLayer.push(eventData);

        if (this.debug) {
            console.log('📊 Analytics Event:', eventName, eventParams);
        }
    },

    /**
     * Set user properties for logged-in users
     */
    setUserProperties: function(userData) {
        if (!userData) return;

        const userProperties = {
            event: 'set_user_properties',
            user_id: userData.userGUID || null,
            user_type: 'registered',
            total_carbon_saved: userData.totalCarbonSaved || 0,
            total_weee_points: userData.totalWeeePoints || 0,
            available_points: userData.availableWeeePoints || 0,
            devices_recycled: userData.totalDevicesRecycled || 0
        };

        window.dataLayer.push(userProperties);

        if (this.debug) {
            console.log('📊 User Properties Set:', userProperties);
        }
    },

    /**
     * Clear user properties on logout
     */
    clearUserProperties: function() {
        window.dataLayer.push({
            event: 'clear_user_properties',
            user_id: null,
            user_type: 'guest'
        });
    },

    // ==========================================
    // AUTHENTICATION EVENTS
    // ==========================================

    /**
     * Track user login
     */
    trackLogin: function(method = 'phone') {
        this.pushEvent('login', {
            method: method
        });
    },

    /**
     * Track user signup/registration
     */
    trackSignup: function(method = 'phone') {
        this.pushEvent('sign_up', {
            method: method
        });
    },

    /**
     * Track user logout
     */
    trackLogout: function() {
        this.pushEvent('logout');
        this.clearUserProperties();
    },

    // ==========================================
    // E-COMMERCE / STORE EVENTS
    // ==========================================

    /**
     * Track product view (when modal opens or product card clicked)
     */
    trackViewItem: function(product) {
        if (!product) return;

        this.pushEvent('view_item', {
            currency: 'EGP',
            value: parseFloat(product.price) || 0,
            items: [{
                item_id: product.productId || product.id,
                item_name: product.name,
                item_category: product.category || 'Printer Cartridges',
                item_brand: 'DR.WEEE',
                price: parseFloat(product.price) || 0,
                quantity: 1
            }]
        });
    },

    /**
     * Track add to cart
     */
    trackAddToCart: function(product, quantity = 1) {
        if (!product) return;

        const price = parseFloat(product.price) || 0;

        this.pushEvent('add_to_cart', {
            currency: 'EGP',
            value: price * quantity,
            items: [{
                item_id: product.productId || product.id,
                item_name: product.name,
                item_category: product.category || 'Printer Cartridges',
                item_brand: 'DR.WEEE',
                price: price,
                quantity: quantity
            }]
        });
    },

    /**
     * Track remove from cart
     */
    trackRemoveFromCart: function(product, quantity = 1) {
        if (!product) return;

        const price = parseFloat(product.price) || 0;

        this.pushEvent('remove_from_cart', {
            currency: 'EGP',
            value: price * quantity,
            items: [{
                item_id: product.productId || product.id,
                item_name: product.name,
                price: price,
                quantity: quantity
            }]
        });
    },

    /**
     * Track cart view
     */
    trackViewCart: function(cartItems, cartTotal) {
        const items = cartItems.map(item => ({
            item_id: item.productId || item.id,
            item_name: item.name,
            price: parseFloat(item.price) || 0,
            quantity: item.quantity || 1
        }));

        this.pushEvent('view_cart', {
            currency: 'EGP',
            value: cartTotal,
            items: items
        });
    },

    /**
     * Track begin checkout
     */
    trackBeginCheckout: function(cartItems, cartTotal) {
        const items = cartItems.map(item => ({
            item_id: item.productId || item.id,
            item_name: item.name,
            price: parseFloat(item.price) || 0,
            quantity: item.quantity || 1
        }));

        this.pushEvent('begin_checkout', {
            currency: 'EGP',
            value: cartTotal,
            items: items
        });
    },

    /**
     * Track purchase completion
     */
    trackPurchase: function(orderData) {
        if (!orderData) return;

        const items = (orderData.items || []).map(item => ({
            item_id: item.productId || item.id,
            item_name: item.name,
            price: parseFloat(item.price) || 0,
            quantity: item.quantity || 1
        }));

        this.pushEvent('purchase', {
            transaction_id: orderData.orderId || orderData.transactionId,
            currency: 'EGP',
            value: orderData.total || 0,
            tax: orderData.tax || 0,
            shipping: orderData.shipping || 0,
            items: items
        });
    },

    // ==========================================
    // E-WASTE / PICKUP REQUEST EVENTS
    // ==========================================

    /**
     * Track e-waste item selection
     */
    trackSelectEwasteItem: function(item) {
        if (!item) return;

        this.pushEvent('select_item', {
            item_list_name: 'E-Waste Items',
            items: [{
                item_id: item.id,
                item_name: item.name,
                item_category: item.category,
                quantity: item.quantity || 1
            }]
        });
    },

    /**
     * Track e-waste cart update
     */
    trackEwasteCartUpdate: function(cartItems, totalPoints, totalCo2) {
        this.pushEvent('ewaste_cart_update', {
            items_count: cartItems.length,
            total_items: cartItems.reduce((sum, item) => sum + (item.quantity || 1), 0),
            estimated_points: totalPoints,
            estimated_co2_saved: totalCo2
        });
    },

    /**
     * Track pickup request submission (Lead Generation)
     */
    trackPickupRequest: function(requestData) {
        if (!requestData) return;

        this.pushEvent('generate_lead', {
            lead_type: 'ewaste_pickup',
            currency: 'EGP',
            value: requestData.estimatedPoints || 0,
            items_count: requestData.itemsCount || 0,
            device_categories: requestData.categories || [],
            estimated_co2: requestData.estimatedCo2 || 0,
            location_city: requestData.city || 'Unknown'
        });

        // Also track as custom event for more details
        this.pushEvent('pickup_request_submitted', {
            request_id: requestData.requestId,
            total_items: requestData.itemsCount,
            device_types: requestData.deviceTypes,
            estimated_points: requestData.estimatedPoints,
            estimated_co2_saved: requestData.estimatedCo2,
            pickup_location: requestData.location
        });
    },

    // ==========================================
    // ENVIRONMENTAL IMPACT / CERTIFICATE EVENTS
    // ==========================================

    /**
     * Track certificate page view
     */
    trackViewCertificate: function(impactData) {
        if (!impactData) return;

        this.pushEvent('view_certificate', {
            carbon_saved: impactData.carbonSaved || 0,
            devices_recycled: impactData.devicesRecycled || 0,
            trees_equivalent: impactData.treesEquivalent || 0,
            total_points: impactData.totalPoints || 0
        });
    },

    /**
     * Track certificate share
     */
    trackShare: function(method, contentType = 'certificate') {
        this.pushEvent('share', {
            method: method, // 'linkedin', 'copy_link', 'twitter', 'facebook'
            content_type: contentType,
            item_id: 'environmental_certificate'
        });
    },

    /**
     * Track certificate download
     */
    trackDownloadCertificate: function() {
        this.pushEvent('file_download', {
            file_name: 'environmental_impact_certificate.png',
            file_extension: 'png',
            content_type: 'certificate'
        });
    },

    // ==========================================
    // CONTACT / LEAD EVENTS
    // ==========================================

    /**
     * Track contact form submission
     */
    trackContactFormSubmit: function(formData) {
        this.pushEvent('generate_lead', {
            lead_type: 'contact_form',
            inquiry_type: formData.subject || 'general',
            form_id: 'contact-form'
        });

        this.pushEvent('contact_form_submit', {
            subject: formData.subject,
            has_phone: !!formData.phone
        });
    },

    // ==========================================
    // POINTS / REDEMPTION EVENTS
    // ==========================================

    /**
     * Track points redemption
     */
    trackRedeemPoints: function(redemptionData) {
        this.pushEvent('redeem_points', {
            points_redeemed: redemptionData.points || 0,
            cash_value: redemptionData.cashValue || 0,
            redemption_type: redemptionData.type || 'cash',
            redemption_method: redemptionData.method || 'vodafone_cash'
        });
    },

    /**
     * Track redemption request submission
     */
    trackRedemptionRequest: function(requestData) {
        this.pushEvent('redemption_request', {
            request_type: requestData.type,
            points_amount: requestData.points,
            cash_amount: requestData.cashAmount
        });
    },

    // ==========================================
    // NAVIGATION / ENGAGEMENT EVENTS
    // ==========================================

    /**
     * Track CTA button clicks
     */
    trackCtaClick: function(ctaName, ctaLocation) {
        this.pushEvent('cta_click', {
            cta_name: ctaName,
            cta_location: ctaLocation,
            page_path: window.location.pathname
        });
    },

    /**
     * Track menu navigation
     */
    trackNavigation: function(destination, source = 'menu') {
        this.pushEvent('navigation_click', {
            destination: destination,
            source: source,
            page_path: window.location.pathname
        });
    },

    /**
     * Track search
     */
    trackSearch: function(searchTerm, searchType = 'products') {
        this.pushEvent('search', {
            search_term: searchTerm,
            search_type: searchType
        });
    },

    /**
     * Track filter usage
     */
    trackFilter: function(filterType, filterValue) {
        this.pushEvent('filter_applied', {
            filter_type: filterType,
            filter_value: filterValue,
            page_path: window.location.pathname
        });
    },

    // ==========================================
    // ERROR TRACKING
    // ==========================================

    /**
     * Track errors
     */
    trackError: function(errorType, errorMessage, errorLocation) {
        this.pushEvent('error', {
            error_type: errorType,
            error_message: errorMessage,
            error_location: errorLocation,
            page_path: window.location.pathname
        });
    }
};

// ==========================================
// AUTO-INITIALIZATION
// ==========================================

document.addEventListener('DOMContentLoaded', function() {
    // Check for logged-in user and set properties
    const storedUser = localStorage.getItem('drweee_user');
    if (storedUser) {
        try {
            const userData = JSON.parse(storedUser);
            DrWeeeAnalytics.setUserProperties(userData);
        } catch (e) {
            console.error('Error parsing user data for analytics:', e);
        }
    }

    // Track page-specific events based on current page
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    // Auto-track certain page views with additional context
    switch(currentPage) {
        case 'environmental-impact.html':
            // Certificate page - tracking handled by page itself
            break;
        case 'store.html':
            DrWeeeAnalytics.pushEvent('page_view_enhanced', {
                page_type: 'store',
                page_title: document.title
            });
            break;
        case 'weee-rewards.html':
            DrWeeeAnalytics.pushEvent('page_view_enhanced', {
                page_type: 'ewaste_collection',
                page_title: document.title
            });
            break;
        case 'contact.html':
            DrWeeeAnalytics.pushEvent('page_view_enhanced', {
                page_type: 'contact',
                page_title: document.title
            });
            break;
        case 'redeem-points.html':
            DrWeeeAnalytics.pushEvent('page_view_enhanced', {
                page_type: 'redemption',
                page_title: document.title
            });
            break;
    }
});

// Export for use in other scripts
window.DrWeeeAnalytics = DrWeeeAnalytics;

console.log('📊 DR.WEEE Analytics initialized');
