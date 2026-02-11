// DR.WEEE Website - Main JavaScript

// Helper function to get the API base URL for local development
function getApiBaseUrl() {
    const port = window.location.port;
    // If running on Live Server (5500/5501) or file protocol, use localhost:3000
    if (port === '5500' || port === '5501' || window.location.protocol === 'file:') {
        return 'http://localhost:3000';
    }
    // Otherwise use relative paths (production)
    return '';
}

// Single DOMContentLoaded initialization - DO NOT DUPLICATE
document.addEventListener('DOMContentLoaded', function () {
    console.log('🚀 DOM Content Loaded - Initializing application...');

    // Initialize non-header components first
    initSmoothScrolling();
    initAnimations();
    initCounters();
    initCarousels();
    initContactForm();
    initLazyLoading();
    initPageSpecific();

    // Load includes (header/footer) - this will trigger header initialization
    loadIncludes();

    console.log('✅ Application initialization complete');
});

// Header functionality
function initHeader() {
    const header = document.getElementById('header');
    const nav = document.querySelector('.nav');

    // Header scroll effect
    window.addEventListener('scroll', function () {
        if (window.scrollY > 100) {
            header.classList.add('header--scrolled');
        } else {
            header.classList.remove('header--scrolled');
        }
    });

    // Active navigation highlighting
    const navLinks = document.querySelectorAll('.nav__link');
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage) {
            link.classList.add('nav__link--active');
        }
    });
}

// Check authentication status and update header
async function checkAuthStatus() {
    try {
        console.log('🔍 Checking authentication status...');
        const response = await fetch(getApiBaseUrl() + '/api/auth-status', {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Auth check failed: ${response.status}`);
        }

        const data = await response.json();
        console.log('📋 Auth status response:', data);

        if (data.isLoggedIn && data.phoneNumber) {
            showLoggedInState(data.phoneNumber, data.fullName, data.userData);
            console.log('✅ User is logged in:', data.fullName, '(', data.phoneNumber, ')');
        } else {
            // Fallback: Check localStorage for cross-origin local development
            const storedUser = localStorage.getItem('drweee_user');
            if (storedUser) {
                try {
                    const user = JSON.parse(storedUser);
                    console.log('📦 Found user in localStorage (cross-origin fallback):', user.fullName);
                    showLoggedInState(user.phoneNumber, user.fullName, {
                        GUID: user.GUID,
                        availableWeeePoints: user.availableWeeePoints,
                        totalWeeePoints: user.totalWeeePoints,
                        availableCash: user.availableCash,
                        totalRedeemableCash: user.totalRedeemableCash,
                        totalCarbonSaved: user.totalCarbonSaved
                    });
                    console.log('✅ User is logged in (from localStorage):', user.fullName);
                    return;
                } catch (e) {
                    console.error('Error parsing stored user:', e);
                    localStorage.removeItem('drweee_user');
                }
            }
            showLoggedOutState();
            console.log('❌ User is not logged in');
        }
    } catch (error) {
        console.error('🚨 Error checking auth status:', error);
        // Also try localStorage fallback on error
        const storedUser = localStorage.getItem('drweee_user');
        if (storedUser) {
            try {
                const user = JSON.parse(storedUser);
                console.log('📦 Using localStorage fallback due to API error:', user.fullName);
                showLoggedInState(user.phoneNumber, user.fullName, {
                    GUID: user.GUID,
                    availableWeeePoints: user.availableWeeePoints,
                    totalWeeePoints: user.totalWeeePoints,
                    availableCash: user.availableCash,
                    totalRedeemableCash: user.totalRedeemableCash,
                    totalCarbonSaved: user.totalCarbonSaved
                });
                return;
            } catch (e) {
                localStorage.removeItem('drweee_user');
            }
        }
        showLoggedOutState();
    }
}

// Show logged in state
function showLoggedInState(phoneNumber, fullName = 'DR.WEEE User', userData = {}) {
    console.log('🔄 Updating UI for logged in state with WEEE data:', userData);
    
    // Desktop elements
    const loginBtn = document.getElementById('login-btn');
    const userDropdown = document.getElementById('user-dropdown');
    const userPhoneDesktop = document.getElementById('user-phone');
    
    // Mobile elements
    const mobileLoginItem = document.getElementById('mobile-login-item');
    const mobileUserCard = document.getElementById('mobile-user-card');
    const mobileUserPhone = document.getElementById('mobile-user-phone');
    const mobileEnvImpactItem = document.getElementById('mobile-env-impact-item');
    const mobileMyRequestsItem = document.getElementById('mobile-my-requests-item');
    const mobileRedeemItem = document.getElementById('mobile-redeem-item');
    const mobileLogoutBtnEl = document.getElementById('mobile-logout-btn');

    // Desktop updates
    if (loginBtn) {
        loginBtn.style.display = 'none';
        console.log('✓ Hidden login button');
    }
    if (userDropdown) {
        userDropdown.style.display = 'inline-block';
        console.log('✓ Showed user dropdown');
    }
    if (userPhoneDesktop) {
        // Display full name instead of phone number
        userPhoneDesktop.textContent = fullName;
        console.log('✓ Updated desktop name display');
    }

    // Mobile updates
    if (mobileLoginItem) {
        mobileLoginItem.style.display = 'none';
        console.log('✓ Hidden mobile login item');
    }
    if (mobileUserCard) {
        mobileUserCard.style.display = 'block';
        console.log('✓ Showed mobile user card');
    }
    if (mobileUserPhone) {
        // Display full name instead of phone number
        mobileUserPhone.textContent = fullName;
        console.log('✓ Updated mobile name display');
    }
    // Show user menu items
    if (mobileEnvImpactItem) {
        mobileEnvImpactItem.style.display = 'block';
        console.log('✓ Showed mobile env impact item');
    }
    if (mobileMyRequestsItem) {
        mobileMyRequestsItem.style.display = 'block';
        console.log('✓ Showed mobile my requests item');
    }
    if (mobileRedeemItem) {
        mobileRedeemItem.style.display = 'block';
        console.log('✓ Showed mobile redeem item');
    }
    if (mobileLogoutBtnEl) {
        mobileLogoutBtnEl.style.display = 'inline-flex';
        console.log('✓ Showed mobile logout button');
    }
    
    // Update WEEE data in desktop dropdown
    updateWeeData('desktop', userData);
    
    // Update WEEE data in mobile view
    updateWeeData('mobile', userData);
}

function updateWeeData(viewType, userData = {}) {
    const prefix = viewType === 'mobile' ? 'mobile-' : '';
    
    // Helper function to format currency WITHOUT dollar sign
    const formatCurrency = (value) => {
        const num = parseFloat(value) || 0;
        return num.toFixed(2); // Just the number, no $ sign
    };
    
    // Helper function to format numbers
    const formatNumber = (value) => {
        const num = parseInt(value) || 0;
        return num.toLocaleString();
    };
    
    // Update available WEEE points
    const availableWeeeEl = document.getElementById(`${prefix}available-weee-points`);
    if (availableWeeeEl) {
        availableWeeeEl.textContent = formatNumber(userData.availableWeeePoints);
    }
    
    // Update total WEEE points
    const totalWeeeEl = document.getElementById(`${prefix}total-weee-points`);
    if (totalWeeeEl) {
        totalWeeeEl.textContent = formatNumber(userData.totalWeeePoints);
    }
    
    // Update available cash (NO DOLLAR SIGN)
    const availableCashEl = document.getElementById(`${prefix}available-cash`);
    if (availableCashEl) {
        availableCashEl.textContent = formatCurrency(userData.availableCash);
    }
    
    // Update total carbon saved
    const carbonSavedEl = document.getElementById(`${prefix}total-carbon-saved`);
    if (carbonSavedEl) {
        const carbonValue = parseFloat(userData.totalCarbonSaved) || 0;
        carbonSavedEl.textContent = viewType === 'mobile' ? 
            `${carbonValue.toFixed(1)}kg` : 
            carbonValue.toFixed(1);
    }
    
    console.log(`✅ Updated ${viewType} WEEE data display`);
}

// Show logged out state
function showLoggedOutState() {
    console.log('🔄 Updating UI for logged out state');
    
    // Desktop elements
    const loginBtn = document.getElementById('login-btn');
    const userDropdown = document.getElementById('user-dropdown');
    
    // Mobile elements
    const mobileLoginItem = document.getElementById('mobile-login-item');
    const mobileUserCard = document.getElementById('mobile-user-card');
    const mobileEnvImpactItem = document.getElementById('mobile-env-impact-item');
    const mobileMyRequestsItem = document.getElementById('mobile-my-requests-item');
    const mobileRedeemItem = document.getElementById('mobile-redeem-item');
    const mobileLogoutBtnEl = document.getElementById('mobile-logout-btn');

    // Desktop updates
    if (loginBtn) {
        loginBtn.style.display = 'flex';
        console.log('✓ Showed login button');
    }
    if (userDropdown) {
        userDropdown.style.display = 'none';
        console.log('✓ Hidden user dropdown');
    }

    // Mobile updates
    if (mobileLoginItem) {
        mobileLoginItem.style.display = 'block';
        console.log('✓ Showed mobile login item');
    }
    if (mobileUserCard) {
        mobileUserCard.style.display = 'none';
        console.log('✓ Hidden mobile user card');
    }
    // Hide user menu items
    if (mobileEnvImpactItem) {
        mobileEnvImpactItem.style.display = 'none';
    }
    if (mobileMyRequestsItem) {
        mobileMyRequestsItem.style.display = 'none';
    }
    if (mobileRedeemItem) {
        mobileRedeemItem.style.display = 'none';
    }
    if (mobileLogoutBtnEl) {
        mobileLogoutBtnEl.style.display = 'none';
    }
}

// Initialize user dropdown
function initUserDropdown() {
    const dropdownTrigger = document.getElementById('user-dropdown-trigger');
    const dropdownMenu = document.getElementById('user-dropdown-menu');
    const logoutBtn = document.getElementById('logout-btn');
    const mobileLogoutBtn = document.getElementById('mobile-logout-btn');

    if (!dropdownTrigger) return;

    // Toggle dropdown
    dropdownTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdownTrigger.getAttribute('aria-expanded') === 'true';
        dropdownTrigger.setAttribute('aria-expanded', !isOpen);
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!dropdownTrigger.contains(e.target) && !dropdownMenu.contains(e.target)) {
            dropdownTrigger.setAttribute('aria-expanded', 'false');
        }
    });

    // Close dropdown on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            dropdownTrigger.setAttribute('aria-expanded', 'false');
        }
    });

    // Handle logout
    const handleLogout = async () => {
        console.log('🚪 Logging out user...');
        try {
            const response = await fetch(getApiBaseUrl() + '/api/logout', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            // Clear localStorage regardless of API response
            localStorage.removeItem('drweee_user');

            if (response.ok) {
                console.log('✅ Logout successful');

                // Track logout event
                if (window.DrWeeeAnalytics) {
                    window.DrWeeeAnalytics.trackLogout();
                }

                showLoggedOutState();

                // Show success message
                if (typeof showNotification === 'function') {
                    showNotification('Logged out successfully!', 'success');
                }

                // Redirect to home page after a short delay
                setTimeout(() => {
                    if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') {
                        window.location.href = '/index.html';
                    }
                }, 1000);
            } else {
                throw new Error('Logout request failed');
            }
        } catch (error) {
            console.error('🚨 Error during logout:', error);
            if (typeof showNotification === 'function') {
                showNotification('Logout failed. Please try again.', 'error');
            }
        }
    };

    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (mobileLogoutBtn) {
        mobileLogoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleLogout();
        });
    }
}
// REPLACE the existing initMobileMenu function in main.js with this improved version

function initMobileMenu() {
    const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
    const mobileMenu = document.getElementById('mobile-menu');
    const mobileMenuClose = document.getElementById('mobile-menu-close');
    const body = document.body;

    if (!mobileMenuToggle || !mobileMenu || !mobileMenuClose) {
        console.warn('Mobile menu elements not found');
        return;
    }

    // Create backdrop if it doesn't exist
    let backdrop = document.querySelector('.mobile-menu-backdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = 'mobile-menu-backdrop';
        document.body.appendChild(backdrop);
    }

    const openMenu = () => {
        // Add classes for open state
        mobileMenu.classList.add('is-open');
        backdrop.classList.add('is-visible');
        body.classList.add('mobile-menu-open');

        // Update accessibility
        mobileMenuToggle.setAttribute('aria-expanded', 'true');

        // Focus management - focus the close button inside menu
        setTimeout(() => {
            mobileMenuClose.focus();
        }, 100);

        console.log('Menu opened'); // Debug log
    };

    const closeMenu = () => {
        // Remove classes for closed state
        mobileMenu.classList.remove('is-open');
        backdrop.classList.remove('is-visible');
        body.classList.remove('mobile-menu-open');

        // Update accessibility
        mobileMenuToggle.setAttribute('aria-expanded', 'false');

        // Return focus to toggle button
        mobileMenuToggle.focus();

        console.log('Menu closed'); // Debug log
    };

    // Toggle menu on hamburger click
    mobileMenuToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (mobileMenu.classList.contains('is-open')) {
            closeMenu();
        } else {
            openMenu();
        }
    });

    // Close menu on close button click
    mobileMenuClose.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
    });

    // Close menu when clicking on backdrop
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
            closeMenu();
        }
    });

    // Close menu when clicking on navigation links
    const mobileMenuLinks = document.querySelectorAll('.mobile-menu__link');
    mobileMenuLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            // Don't prevent default for actual navigation
            setTimeout(() => {
                closeMenu();
            }, 150);
        });
    });

    // Close menu on Escape key press
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && mobileMenu.classList.contains('is-open')) {
            closeMenu();
        }
    });

    // Handle window resize - close menu if viewport becomes larger
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (window.innerWidth > 991 && mobileMenu.classList.contains('is-open')) {
                closeMenu();
            }
        }, 150);
    });

    // Trap focus within menu when open
    const focusableElements = mobileMenu.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    if (focusableElements.length > 0) {
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];

        mobileMenu.addEventListener('keydown', (e) => {
            if (e.key === 'Tab' && mobileMenu.classList.contains('is-open')) {
                if (e.shiftKey) {
                    // Shift + Tab
                    if (document.activeElement === firstFocusable) {
                        e.preventDefault();
                        lastFocusable.focus();
                    }
                } else {
                    // Tab
                    if (document.activeElement === lastFocusable) {
                        e.preventDefault();
                        firstFocusable.focus();
                    }
                }
            }
        });
    }
}
// Smooth scrolling for anchor links
function initSmoothScrolling() {
    const anchorLinks = document.querySelectorAll('a[href^="#"]');

    anchorLinks.forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();

            const targetId = this.getAttribute('href').substring(1);
            const targetElement = document.getElementById(targetId);

            if (targetElement) {
                const headerHeight = document.getElementById('header').offsetHeight;
                const targetPosition = targetElement.offsetTop - headerHeight;

                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
}

// Animation on scroll
function initAnimations() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver(function (entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
            }
        });
    }, observerOptions);

    // Observe elements with animation classes
    const animatedElements = document.querySelectorAll('.animate-on-scroll');
    animatedElements.forEach(element => {
        observer.observe(element);
    });
}

// Counter animations
function initCounters() {
    const counters = document.querySelectorAll('.counter');

    const counterObserver = new IntersectionObserver(function (entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const counter = entry.target;
                const target = parseInt(counter.getAttribute('data-target'));
                const duration = 2000; // 2 seconds
                const step = target / (duration / 16); // 60fps
                let current = 0;

                const timer = setInterval(function () {
                    current += step;
                    if (current >= target) {
                        current = target;
                        clearInterval(timer);
                    }
                    counter.textContent = Math.floor(current);
                }, 16);

                counterObserver.unobserve(counter);
            }
        });
    }, { threshold: 0.5 });

    counters.forEach(counter => {
        counterObserver.observe(counter);
    });
}

// Carousel functionality
function initCarousels() {
    const carousels = document.querySelectorAll('.carousel');

    carousels.forEach(carousel => {
        const track = carousel.querySelector('.carousel__track');
        const slides = carousel.querySelectorAll('.carousel__slide');
        const prevBtn = carousel.querySelector('.carousel__btn--prev');
        const nextBtn = carousel.querySelector('.carousel__btn--next');
        const dots = carousel.querySelectorAll('.carousel__dot');

        if (!track || slides.length === 0) return;

        let currentSlide = 0;
        const totalSlides = slides.length;

        function updateCarousel() {
            const translateX = -currentSlide * 100;
            track.style.transform = `translateX(${translateX}%)`;

            // Update dots
            dots.forEach((dot, index) => {
                dot.classList.toggle('carousel__dot--active', index === currentSlide);
            });
        }

        function nextSlide() {
            currentSlide = (currentSlide + 1) % totalSlides;
            updateCarousel();
        }

        function prevSlide() {
            currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            updateCarousel();
        }

        // Event listeners
        if (nextBtn) nextBtn.addEventListener('click', nextSlide);
        if (prevBtn) prevBtn.addEventListener('click', prevSlide);

        dots.forEach((dot, index) => {
            dot.addEventListener('click', function () {
                currentSlide = index;
                updateCarousel();
            });
        });

        // Auto-play
        setInterval(nextSlide, 5000);
    });
}

// Contact form handling
function initContactForm() {
    const contactForm = document.getElementById('contact-form');

    if (contactForm) {
        // Check if user is logged in and hide phone field if they are
        const phoneFieldGroup = document.getElementById('phone-field-group');
        const phoneInput = document.getElementById('phone');

        fetch(getApiBaseUrl() + '/api/auth-status', { credentials: 'include' })
            .then(response => response.json())
            .then(data => {
                if (data.isLoggedIn && phoneFieldGroup) {
                    // Hide phone field for logged-in users
                    phoneFieldGroup.style.display = 'none';
                    if (phoneInput) phoneInput.removeAttribute('required');
                } else if (phoneFieldGroup) {
                    // Show phone field for non-logged-in users
                    phoneFieldGroup.style.display = 'block';
                    if (phoneInput) phoneInput.setAttribute('required', 'required');
                }
            })
            .catch(error => {
                console.error('Error checking auth status:', error);
                // On error, assume not logged in and show phone field
                if (phoneFieldGroup) {
                    phoneFieldGroup.style.display = 'block';
                    if (phoneInput) phoneInput.setAttribute('required', 'required');
                }
            });

        contactForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            // Get form data
            const formData = new FormData(contactForm);
            const data = Object.fromEntries(formData);

            // Basic validation
            if (!data.name || !data.email || !data.message) {
                showNotification('Please fill in all required fields.', 'error');
                return;
            }

            if (!isValidEmail(data.email)) {
                showNotification('Please enter a valid email address.', 'error');
                return;
            }

            // Disable submit button to prevent double submission
            const submitButton = contactForm.querySelector('button[type="submit"]');
            const originalButtonText = submitButton ? submitButton.innerHTML : '';
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
            }

            try {
                // Prepare payload - include phone if provided
                const payload = {
                    name: data.name,
                    email: data.email,
                    subject: data.subject,
                    message: data.message,
                    type: 'contact'
                };

                // Add phone number if provided (for non-logged-in users)
                if (data.phone) {
                    payload.phone = data.phone;
                }

                // Send to backend API which will forward to Power Automate
                const response = await fetch(getApiBaseUrl() + '/api/contact', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();

                if (response.ok && result.success) {
                    // Track contact form submission
                    if (window.DrWeeeAnalytics) {
                        window.DrWeeeAnalytics.trackContactFormSubmit({
                            subject: data.subject,
                            phone: data.phone || null
                        });
                    }

                    // Show innovative success modal instead of basic notification
                    if (typeof window.showContactSuccessModal === 'function') {
                        window.showContactSuccessModal();
                    } else {
                        showNotification('Thank you for your message! We will get back to you within 24 hours.', 'success');
                    }
                    contactForm.reset();
                } else {
                    throw new Error(result.message || 'Failed to send message');
                }
            } catch (error) {
                console.error('Contact form submission error:', error);
                showNotification('Sorry, there was an error sending your message. Please try again or contact us directly.', 'error');
            } finally {
                // Re-enable submit button
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.innerHTML = originalButtonText;
                }
            }
        });
    }
}

// Load header and footer includes
function loadIncludes() {
    // Load header
    const headerPlaceholder = document.getElementById('header-placeholder');
    if (headerPlaceholder) {
        console.log('📥 Loading header from includes...');
        fetch('includes/header.html')
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.text();
            })
            .then(html => {
                headerPlaceholder.innerHTML = html;
                console.log('✅ Header HTML loaded, initializing components...');

                // Show test environment indicator
                fetch(getApiBaseUrl() + '/api/health')
                    .then(r => r.json())
                    .then(data => {
                        if (data.environment === 'test' && !document.getElementById('test-env-banner')) {
                            const banner = document.createElement('div');
                            banner.id = 'test-env-banner';
                            banner.textContent = 'TEST ENVIRONMENT';
                            banner.style.cssText = 'background:#ff9800;color:#fff;text-align:center;padding:4px 0;font-size:12px;font-weight:700;letter-spacing:1px;position:sticky;top:0;z-index:9999;';
                            document.getElementById('header').after(banner);
                        }
                    })
                    .catch(() => {});

                // Initialize header components in correct order
                initHeader();
                initMobileMenu();
                initUserDropdown();

                // Check auth status after all components are ready
                setTimeout(() => {
                    checkAuthStatus();
                    console.log('✅ Header initialization complete');

                    // Initialize i18n after header is loaded (for language switcher)
                    if (window.DrWeeeI18n) {
                        window.DrWeeeI18n.refresh();
                    }
                }, 100);
            })
            .catch(error => {
                console.error('🚨 Error loading header:', error);
                // Fallback: check if header exists in DOM already
                if (document.getElementById('header')) {
                    initHeader();
                    initMobileMenu();
                    initUserDropdown();
                    checkAuthStatus();
                }
            });
    } else if (document.getElementById('header')) {
        // Header is directly in HTML (not using includes)
        console.log('📄 Header found directly in DOM');
        initHeader();
        initMobileMenu();
        initUserDropdown();
        checkAuthStatus();
    }

    // Load footer
    const footerPlaceholder = document.getElementById('footer-placeholder');
    if (footerPlaceholder) {
        fetch('includes/footer.html')
            .then(response => response.text())
            .then(html => {
                footerPlaceholder.innerHTML = html;

                // Refresh i18n after footer is loaded
                if (window.DrWeeeI18n) {
                    window.DrWeeeI18n.refresh();
                }
            })
            .catch(error => console.error('Error loading footer:', error));
    }
}

// Utility functions
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification--${type}`;
    notification.innerHTML = `
        <div class="notification__content">
            <span class="notification__message">${message}</span>
            <button class="notification__close" onclick="this.parentElement.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;

    // Add to page
    document.body.appendChild(notification);

    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 5000);
}

// Lazy loading for images
function initLazyLoading() {
    const images = document.querySelectorAll('img[data-src]');

    const imageObserver = new IntersectionObserver(function (entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                img.src = img.dataset.src;
                img.classList.remove('lazy');
                imageObserver.unobserve(img);
            }
        });
    });

    images.forEach(img => {
        imageObserver.observe(img);
    });
}

// NOTE: Lazy loading is initialized in main DOMContentLoaded listener at top of file

// Page-specific functionality
function initPageSpecific() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    switch (currentPage) {
        case 'index.html':
            initHomePage();
            break;
        case 'about.html':
            initAboutPage();
            break;
        case 'services.html':
            initServicesPage();
            break;
        case 'ventures.html':
            initVenturesPage();
            break;
        case 'impact.html':
            initImpactPage();
            break;
        case 'recognition.html':
            initRecognitionPage();
            break;
        case 'news.html':
            initNewsPage();
            break;
        case 'contact.html':
            initContactPage();
            break;
    }
}

// Page-specific initialization functions
function initHomePage() {
    // Home page specific functionality
    console.log('Home page initialized');
}

function initAboutPage() {
    // About page specific functionality
    console.log('About page initialized');
}

function initServicesPage() {
    // Services page specific functionality
    console.log('Services page initialized');
}

function initVenturesPage() {
    // Ventures page specific functionality
    console.log('Ventures page initialized');
}

function initImpactPage() {
    // Impact page specific functionality
    console.log('Impact page initialized');
}

function initRecognitionPage() {
    // Recognition page specific functionality
    console.log('Recognition page initialized');
}

function initNewsPage() {
    // News page specific functionality
    console.log('News page initialized');
}

function initContactPage() {
    // Contact page specific functionality
    console.log('Contact page initialized');
}



// --- INNOVATIVE HERO SCRIPT (HOME & ABOUT) ---
// NOTE: Main DOMContentLoaded listener is at the top of this file - DO NOT DUPLICATE

/**
 * Creates a subtle, interactive particle animation in the hero background.
 */
function initParticleCanvas() {
    const canvas = document.getElementById('particle-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    let particles = [];
    const particleCount = Math.floor(canvas.width / 30);

    class Particle {
        constructor() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 1;
            this.speedX = Math.random() * 1 - 0.5;
            this.speedY = Math.random() * 1 - 0.5;
            this.color = 'rgba(77, 182, 172, 0.5)';
        }
        update() {
            if (this.x > canvas.width || this.x < 0) this.speedX *= -1;
            if (this.y > canvas.height || this.y < 0) this.speedY *= -1;
            this.x += this.speedX;
            this.y += this.speedY;
        }
        draw() {
            ctx.fillStyle = this.color;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function initParticles() {
        particles = [];
        for (let i = 0; i < particleCount; i++) {
            particles.push(new Particle());
        }
    }

    function animateParticles() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const particle of particles) {
            particle.update();
            particle.draw();
        }
        requestAnimationFrame(animateParticles);
    }

    initParticles();
    animateParticles();
    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        initParticles();
    });
}

/**
 * Animates the letters of the hero title to reveal them on page load.
 */
function initTextReveal() {
    const title = document.querySelector('[data-animate-reveal]');
    if (!title) return;

    const mainTitle = title.querySelector('.hero__title-main');
    const subTitle = title.querySelector('.hero__title-sub');

    const wrapLetters = (element) => {
        element.innerHTML = element.textContent.replace(/\\S/g, "<span class='letter'>$&</span>");
        return element.querySelectorAll('span');
    };

    const mainLetters = wrapLetters(mainTitle);
    const subLetters = wrapLetters(subTitle);

    let delay = 0;
    mainLetters.forEach(letter => {
        letter.style.animationDelay = `${delay}s`;
        delay += 0.04;
    });
    subLetters.forEach(letter => {
        letter.style.animationDelay = `${delay}s`;
        delay += 0.02;
    });
}


/**
 * Makes buttons move towards the cursor for a magnetic effect.
 */
function initMagneticButtons() {
    const buttons = document.querySelectorAll('.magnetic-btn');
    buttons.forEach(btn => {
        btn.addEventListener('mousemove', function (e) {
            const rect = btn.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;

            btn.style.transform = `translate(${x * 0.2}px, ${y * 0.3}px)`;
        });
        btn.addEventListener('mouseleave', function () {
            btn.style.transform = 'translate(0,0)';
        });
    });
}

/**
 * Creates a parallax effect on the hero content as the user scrolls.
 */
function handleHeroParallax() {
    // This selector now targets the content inside ANY element with the .hero class
    const heroContent = document.querySelector('.hero .hero__content');
    if (heroContent) {
        const scrollY = window.scrollY;
        heroContent.style.transform = `translateY(${scrollY * 0.4}px)`;
        heroContent.style.opacity = 1 - (scrollY / (window.innerHeight * 0.8));
    }
}

document.addEventListener('DOMContentLoaded', function () {
    // Only run chart logic on the DR.WEEE Impact page
    if (!document.body.classList.contains('impact-drweee-page')) {
        return;
    }

    const chartFontColor = '#FFFFFF';
    const gridLineColor = 'rgba(255, 255, 255, 0.1)';
    const primaryColor = '#4DB6AC';
    const secondaryColor = '#A5D6A7';

    // E-Waste Processed Chart
    const ewasteCtx = document.getElementById('ewasteChart');
    if (ewasteCtx) {
        new Chart(ewasteCtx, {
            type: 'line',
            data: {
                labels: ['2020', '2021', '2022', '2023', '2024'],
                datasets: [{
                    label: 'Tons Processed',
                    data: [150, 300, 550, 800, 1000],
                    borderColor: primaryColor,
                    backgroundColor: 'rgba(77, 182, 172, 0.2)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false, // <-- ADD THIS LINE
                plugins: { legend: { labels: { color: chartFontColor } } },
                scales: {
                    y: { ticks: { color: chartFontColor }, grid: { color: gridLineColor } },
                    x: { ticks: { color: chartFontColor }, grid: { color: gridLineColor } }
                }
            }
        });
    }
    // Periodically check auth status to handle session expiration
    setInterval(() => {
        // Only check if we think we're logged in and elements exist
        const userDropdown = document.getElementById('user-dropdown');
        if (userDropdown && userDropdown.style.display !== 'none') {
            checkAuthStatus();
        }
    }, 5 * 60 * 1000); // Check every 5 minutes

    // Export functions for global access
    window.checkAuthStatus = checkAuthStatus;
    window.showLoggedInState = showLoggedInState;
    window.showLoggedOutState = showLoggedOutState;
    // Economic Contribution Chart
    const economicCtx = document.getElementById('economicChart');
    if (economicCtx) {
        new Chart(economicCtx, {
            type: 'doughnut',
            data: {
                labels: ['Job Creation', 'Local Manufacturing', 'Market Revenue'],
                datasets: [{
                    data: [35, 25, 40],
                    backgroundColor: [primaryColor, secondaryColor, '#00897B'],
                    borderColor: '#f9fbfb'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false, // <-- ADD THIS LINE
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#5F6368' }
                    }
                }
            }
        });
    }
});
