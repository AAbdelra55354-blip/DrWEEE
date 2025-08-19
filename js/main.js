// DR.WEEE Website - Main JavaScript

document.addEventListener('DOMContentLoaded', function() {
    // Initialize all components
    initHeader();
    initMobileMenu();
    initSmoothScrolling();
    initAnimations();
    initCounters();
    initCarousels();
    initContactForm();
    loadIncludes();
});

// Header functionality
function initHeader() {
    const header = document.getElementById('header');
    const nav = document.querySelector('.nav');
    
    // Header scroll effect
    window.addEventListener('scroll', function() {
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

// Mobile menu functionality
function initMobileMenu() {
    const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
    const mobileMenu = document.getElementById('mobile-menu');
    const body = document.body;
    
    if (mobileMenuToggle && mobileMenu) {
        mobileMenuToggle.addEventListener('click', function() {
            mobileMenu.classList.toggle('mobile-menu--active');
            body.classList.toggle('mobile-menu-open');
            
            // Toggle icon
            const icon = mobileMenuToggle.querySelector('i');
            if (mobileMenu.classList.contains('mobile-menu--active')) {
                icon.classList.remove('fa-bars');
                icon.classList.add('fa-times');
            } else {
                icon.classList.remove('fa-times');
                icon.classList.add('fa-bars');
            }
        });
        
        // Close mobile menu when clicking on links
        const mobileMenuLinks = document.querySelectorAll('.mobile-menu__link');
        mobileMenuLinks.forEach(link => {
            link.addEventListener('click', function() {
                mobileMenu.classList.remove('mobile-menu--active');
                body.classList.remove('mobile-menu-open');
                const icon = mobileMenuToggle.querySelector('i');
                icon.classList.remove('fa-times');
                icon.classList.add('fa-bars');
            });
        });
        
        // Close mobile menu when clicking outside
        document.addEventListener('click', function(e) {
            if (!mobileMenu.contains(e.target) && !mobileMenuToggle.contains(e.target)) {
                mobileMenu.classList.remove('mobile-menu--active');
                body.classList.remove('mobile-menu-open');
                const icon = mobileMenuToggle.querySelector('i');
                icon.classList.remove('fa-times');
                icon.classList.add('fa-bars');
            }
        });
    }
}

// Smooth scrolling for anchor links
function initSmoothScrolling() {
    const anchorLinks = document.querySelectorAll('a[href^="#"]');
    
    anchorLinks.forEach(link => {
        link.addEventListener('click', function(e) {
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
    
    const observer = new IntersectionObserver(function(entries) {
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
    
    const counterObserver = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const counter = entry.target;
                const target = parseInt(counter.getAttribute('data-target'));
                const duration = 2000; // 2 seconds
                const step = target / (duration / 16); // 60fps
                let current = 0;
                
                const timer = setInterval(function() {
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
            dot.addEventListener('click', function() {
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
        contactForm.addEventListener('submit', function(e) {
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
            
            // Simulate form submission
            showNotification('Thank you for your message! We will get back to you soon.', 'success');
            contactForm.reset();
        });
    }
}

// Load header and footer includes
function loadIncludes() {
    // Load header
    const headerPlaceholder = document.getElementById('header-placeholder');
    if (headerPlaceholder) {
        fetch('includes/header.html')
            .then(response => response.text())
            .then(html => {
                headerPlaceholder.innerHTML = html;
                initHeader();
                initMobileMenu();
            })
            .catch(error => console.error('Error loading header:', error));
    }
    
    // Load footer
    const footerPlaceholder = document.getElementById('footer-placeholder');
    if (footerPlaceholder) {
        fetch('includes/footer.html')
            .then(response => response.text())
            .then(html => {
                footerPlaceholder.innerHTML = html;
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
    
    const imageObserver = new IntersectionObserver(function(entries) {
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

// Initialize lazy loading
document.addEventListener('DOMContentLoaded', initLazyLoading);

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

// Initialize page-specific functionality
document.addEventListener('DOMContentLoaded', initPageSpecific);
// --- INNOVATIVE ABOUT PAGE HERO SCRIPT ---

// --- INNOVATIVE HERO SCRIPT (HOME & ABOUT) ---

document.addEventListener('DOMContentLoaded', function() {
    // Check if we are on the home or about page and a hero section exists
    if ((document.body.classList.contains('home-page') || document.body.classList.contains('about-page') || document.body.classList.contains('services-page')) && document.getElementById('hero')) {
        
        // 1. Initialize Particle Effect
        initParticleCanvas();

        // 2. Initialize Text Reveal Animation
        initTextReveal();

        // 3. Initialize Magnetic Buttons
        initMagneticButtons();
        
        // 4. Initialize Parallax Scroll Effect
        window.addEventListener('scroll', handleHeroParallax);
    }
});

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
        btn.addEventListener('mousemove', function(e) {
            const rect = btn.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;

            btn.style.transform = `translate(${x * 0.2}px, ${y * 0.3}px)`;
        });
        btn.addEventListener('mouseleave', function() {
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

document.addEventListener('DOMContentLoaded', function() {
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
                plugins: { legend: { labels: { color: chartFontColor } } },
                scales: {
                    y: { ticks: { color: chartFontColor }, grid: { color: gridLineColor } },
                    x: { ticks: { color: chartFontColor }, grid: { color: gridLineColor } }
                }
            }
        });
    }

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
