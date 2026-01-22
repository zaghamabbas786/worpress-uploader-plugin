<?php
/**
 * Plugin Name: Warzone Uploader
 * Plugin URI: https://example.com/warzone-uploader
 * Description: A Call of Duty/Warzone themed video uploader with Google Drive integration.
 * Version: 1.0.0
 * Author: Your Name
 * License: GPL v2 or later
 * Text Domain: warzone-uploader
 */

if (!defined('ABSPATH')) {
    exit;
}

define('WARZONE_UPLOADER_VERSION', '2.0.0'); // v2: True direct browser-to-Google uploads
define('WARZONE_UPLOADER_PATH', plugin_dir_path(__FILE__));
define('WARZONE_UPLOADER_URL', plugin_dir_url(__FILE__));
define('WARZONE_UPLOADER_CHUNK_SIZE', 70 * 1024 * 1024); // 70MB chunks for faster uploads
define('WARZONE_UPLOADER_MAX_FILE_SIZE', 5 * 1024 * 1024 * 1024); // 5GB max file size

// Security Settings
define('WARZONE_UPLOADS_PER_IP_PER_DAY', 5); // Max uploads per IP per 24 hours
define('WARZONE_RECAPTCHA_ENABLED', true); // Enable/disable reCAPTCHA
// reCAPTCHA v3 keys - can be overridden in Settings → Warzone Uploader
define('WARZONE_RECAPTCHA_SITE_KEY', get_option('warzone_recaptcha_site_key', ''));
define('WARZONE_RECAPTCHA_SECRET_KEY', get_option('warzone_recaptcha_secret_key', ''));

// Include the Google Drive handler
require_once WARZONE_UPLOADER_PATH . 'includes/class-google-drive-uploader.php';

/**
 * Main Plugin Class
 */
class Warzone_Uploader {
    
    private static $instance = null;
    private $drive_uploader;
    
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    private function __construct() {
        $this->drive_uploader = new Warzone_Google_Drive_Uploader();
        $this->init_hooks();
    }
    
    private function init_hooks() {
        add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
        add_shortcode('warzone_upload', [$this, 'render_shortcode']);
        add_shortcode('warzone_contact', [$this, 'render_contact_shortcode']);
        
        // Add body class for full-bleed hero styling
        add_filter('body_class', [$this, 'add_body_class']);
        
        // Admin menu for settings
        add_action('admin_menu', [$this, 'add_admin_menu']);
        add_action('admin_init', [$this, 'register_settings']);
        
        // AJAX handlers
        add_action('wp_ajax_warzone_init_upload', [$this, 'ajax_init_upload']);
        add_action('wp_ajax_nopriv_warzone_init_upload', [$this, 'ajax_init_upload']);
        
        // NOTE: Chunk uploads go DIRECTLY to Google Drive from browser (no WordPress proxy)
        // Only init and finalize go through WordPress
        
        add_action('wp_ajax_warzone_finalize_upload', [$this, 'ajax_finalize_upload']);
        add_action('wp_ajax_nopriv_warzone_finalize_upload', [$this, 'ajax_finalize_upload']);
        
        // Contact form AJAX
        add_action('wp_ajax_warzone_contact_submit', [$this, 'ajax_contact_submit']);
        add_action('wp_ajax_nopriv_warzone_contact_submit', [$this, 'ajax_contact_submit']);
    }
    
    /**
     * Add admin menu page
     */
    public function add_admin_menu() {
        add_options_page(
            'Warzone Uploader Settings',
            'Warzone Uploader',
            'manage_options',
            'warzone-uploader',
            [$this, 'render_settings_page']
        );
    }
    
    /**
     * Register plugin settings
     */
    public function register_settings() {
        register_setting('warzone_uploader_settings', 'warzone_recaptcha_site_key');
        register_setting('warzone_uploader_settings', 'warzone_recaptcha_secret_key');
        register_setting('warzone_uploader_settings', 'warzone_drive_folder_id');
        register_setting('warzone_uploader_settings', 'warzone_uploads_per_day', [
            'default' => 5,
            'sanitize_callback' => 'absint'
        ]);
    }
    
    /**
     * Render admin settings page
     */
    public function render_settings_page() {
        ?>
        <div class="wrap">
            <h1>Warzone Uploader Settings</h1>
            <form method="post" action="options.php">
                <?php settings_fields('warzone_uploader_settings'); ?>
                
                <h2>Google Drive Settings</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">Drive Folder ID</th>
                        <td>
                            <input type="text" name="warzone_drive_folder_id" 
                                   value="<?php echo esc_attr(get_option('warzone_drive_folder_id', '')); ?>" 
                                   class="regular-text">
                            <p class="description">The Google Shared Drive folder ID where videos will be uploaded.</p>
                        </td>
                    </tr>
                </table>
                
                <h2>Security Settings</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">reCAPTCHA v3 Site Key</th>
                        <td>
                            <input type="text" name="warzone_recaptcha_site_key" 
                                   value="<?php echo esc_attr(get_option('warzone_recaptcha_site_key', '')); ?>" 
                                   class="regular-text">
                            <p class="description">Get your keys from <a href="https://www.google.com/recaptcha/admin" target="_blank">Google reCAPTCHA Admin</a></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">reCAPTCHA v3 Secret Key</th>
                        <td>
                            <input type="password" name="warzone_recaptcha_secret_key" 
                                   value="<?php echo esc_attr(get_option('warzone_recaptcha_secret_key', '')); ?>" 
                                   class="regular-text">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Max Uploads Per IP (24hr)</th>
                        <td>
                            <input type="number" name="warzone_uploads_per_day" 
                                   value="<?php echo esc_attr(get_option('warzone_uploads_per_day', 5)); ?>" 
                                   min="1" max="100" class="small-text">
                            <p class="description">Maximum number of uploads allowed per IP address per 24 hours.</p>
                        </td>
                    </tr>
                </table>
                
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }
    
    /**
     * Add body class for pages with the warzone shortcode
     */
    public function add_body_class($classes) {
        global $post;
        if ($post && has_shortcode($post->post_content, 'warzone_upload')) {
            $classes[] = 'warzone-hero-page';
        }
        return $classes;
    }
    
    public function enqueue_assets() {
        wp_enqueue_style(
            'warzone-uploader-style',
            WARZONE_UPLOADER_URL . 'assets/css/style.css',
            [],
            WARZONE_UPLOADER_VERSION
        );
        
        // Google Fonts - Military stencil style
        wp_enqueue_style(
            'warzone-fonts',
            'https://fonts.googleapis.com/css2?family=Black+Ops+One&family=Oswald:wght@400;700&display=swap',
            [],
            null
        );
        
        // reCAPTCHA v3 script (if enabled and keys are set)
        $recaptcha_site_key = get_option('warzone_recaptcha_site_key', '') ?: WARZONE_RECAPTCHA_SITE_KEY;
        if (!empty($recaptcha_site_key)) {
            wp_enqueue_script(
                'google-recaptcha',
                'https://www.google.com/recaptcha/api.js?render=' . esc_attr($recaptcha_site_key),
                [],
                null,
                true
            );
        }
        
        wp_enqueue_script(
            'warzone-uploader-script',
            WARZONE_UPLOADER_URL . 'assets/js/script.js',
            ['jquery'],
            WARZONE_UPLOADER_VERSION,
            true
        );
        
        wp_localize_script('warzone-uploader-script', 'warzoneUploader', [
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('warzone_upload_nonce'),
            'contactNonce' => wp_create_nonce('warzone_contact_nonce'),
            'chunkSize' => WARZONE_UPLOADER_CHUNK_SIZE,
            'maxFileSize' => WARZONE_UPLOADER_MAX_FILE_SIZE, // 5GB
            'allowedTypes' => ['video/mp4', 'video/quicktime'],
            'recaptchaSiteKey' => $recaptcha_site_key,
            'recaptchaEnabled' => !empty($recaptcha_site_key),
            'i18n' => [
                'uploading' => __('UPLOADING...', 'warzone-uploader'),
                'processing' => __('PROCESSING...', 'warzone-uploader'),
                'success' => __('MISSION COMPLETE!', 'warzone-uploader'),
                'error' => __('MISSION FAILED!', 'warzone-uploader'),
                'invalidFile' => __('Invalid file type. Only MP4 and MOV allowed.', 'warzone-uploader'),
                'fileTooLarge' => __('File exceeds 5GB limit.', 'warzone-uploader'),
                'requiredFields' => __('All fields are required, soldier!', 'warzone-uploader'),
                'confirmLegal' => __('You must confirm the legal agreement.', 'warzone-uploader'),
                'rateLimited' => __('Upload limit reached. Please try again tomorrow.', 'warzone-uploader'),
                'recaptchaFailed' => __('Security verification failed. Please try again.', 'warzone-uploader'),
            ]
        ]);
    }
    
    public function render_shortcode($atts) {
        $plugin_url = WARZONE_UPLOADER_URL;
        ob_start();
        ?>
        <section class="warzone-hero" style="background-image: url('<?php echo esc_url($plugin_url . 'assets/images/hero-image.png'); ?>');">
            <div class="warzone-overlay"></div>
            
            <!-- Top Navigation Bar -->
            <nav class="warzone-nav">
                <!-- Left: YouTube/WWC Logo -->
                <div class="warzone-nav-left">
                    <a href="https://www.youtube.com/@WarzoneWreckingCrew" target="_blank" rel="noopener" class="warzone-nav-link warzone-youtube-link">
                        <img src="<?php echo esc_url($plugin_url . 'assets/images/youtube.png'); ?>" alt="WWC YouTube" class="warzone-nav-icon warzone-youtube-icon">
                    </a>
                </div>
                
                <!-- Center: Discord & Contact -->
                <div class="warzone-nav-center">
                    <a href="https://discord.gg/dPfmKFj9P7" target="_blank" rel="noopener" class="warzone-nav-link">
                        <img src="<?php echo esc_url($plugin_url . 'assets/images/discord.png'); ?>" alt="Discord" class="warzone-nav-icon">
                    </a>
                    <a href="#" class="warzone-nav-link" id="warzone-contact-trigger">
                        <img src="<?php echo esc_url($plugin_url . 'assets/images/contact.png'); ?>" alt="Contact" class="warzone-nav-icon">
                    </a>
                </div>
                
                <!-- Right: Empty for balance -->
                <div class="warzone-nav-right"></div>
            </nav>
            
            <!-- Contact Modal -->
            <div class="warzone-modal" id="warzone-contact-modal" aria-hidden="true">
                <div class="warzone-modal-backdrop" id="warzone-contact-backdrop"></div>
                <div class="warzone-modal-container">
                    <div class="warzone-modal-header">
                        <h2 class="warzone-modal-title">CONTACT US</h2>
                        <button type="button" class="warzone-modal-close" id="warzone-contact-close" aria-label="Close">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                    
                    <form class="warzone-upload-form" id="warzone-contact-form">
                        <div class="warzone-form-group">
                            <label for="contact-name" class="warzone-label">NAME <span class="required">*</span></label>
                            <input type="text" id="contact-name" name="name" class="warzone-input" required placeholder="Enter your name">
                        </div>
                        
                        <div class="warzone-form-group">
                            <label for="contact-email" class="warzone-label">EMAIL <span class="required">*</span></label>
                            <input type="email" id="contact-email" name="email" class="warzone-input" required placeholder="Enter your email">
                        </div>
                        
                        <div class="warzone-form-group">
                            <label for="contact-subject" class="warzone-label">SUBJECT</label>
                            <input type="text" id="contact-subject" name="subject" class="warzone-input" placeholder="What's this about?">
                        </div>
                        
                        <div class="warzone-form-group">
                            <label for="contact-message" class="warzone-label">MESSAGE <span class="required">*</span></label>
                            <textarea id="contact-message" name="message" class="warzone-input warzone-textarea" required placeholder="Your message..." rows="5"></textarea>
                        </div>
                        
                        <div class="warzone-form-actions">
                            <button type="submit" class="warzone-submit-btn" id="contact-submit-btn">
                                <span class="btn-text">SEND MESSAGE</span>
                                <span class="btn-loading">
                                    <svg class="spinner" viewBox="0 0 24 24">
                                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="31.416" stroke-dashoffset="10"></circle>
                                    </svg>
                                </span>
                            </button>
                        </div>
                        
                        <div class="warzone-message" id="contact-message-box"></div>
                    </form>
                </div>
            </div>
            
            <!-- Upload Button - Centered -->
            <div class="warzone-upload-button-container">
                <button type="button" class="warzone-upload-trigger" id="warzone-upload-trigger" aria-label="Upload Video">
                    <img src="<?php echo esc_url($plugin_url . 'assets/images/upload-button.png'); ?>" 
                         alt="Upload Video" 
                         class="warzone-upload-button-img">
                    <span class="warzone-button-glow"></span>
                </button>
            </div>
            
            <!-- Upload Modal -->
            <div class="warzone-modal" id="warzone-upload-modal" aria-hidden="true">
                <div class="warzone-modal-backdrop"></div>
                <div class="warzone-modal-container">
                    <div class="warzone-modal-header">
                        <h2 class="warzone-modal-title">SUBMIT FOOTAGE</h2>
                        <button type="button" class="warzone-modal-close" id="warzone-modal-close" aria-label="Close">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                    
                    <form class="warzone-upload-form" id="warzone-upload-form">
                        <div class="warzone-form-group">
                            <label for="warzone-name" class="warzone-label">LAST WAR NAME <span class="required">*</span></label>
                            <input type="text" id="warzone-name" name="last_war_name" class="warzone-input" required placeholder="Enter your Last War name">
                        </div>
                        
                        <div class="warzone-form-group">
                            <label for="warzone-server" class="warzone-label">LAST WAR SERVER <span class="required">*</span></label>
                            <input type="text" id="warzone-server" name="last_war_server" class="warzone-input" required placeholder="Enter your server">
                        </div>
                        
                        <div class="warzone-form-group">
                            <label for="warzone-event" class="warzone-label">EVENT <span class="required">*</span></label>
                            <input type="text" id="warzone-event" name="event" class="warzone-input" required placeholder="Meteor, Kill Event, Warzone Duel, etc.">
                        </div>
                        
                        <div class="warzone-form-group">
                            <label class="warzone-label">VIDEO FILE <span class="required">*</span></label>
                            <div class="warzone-file-drop" id="warzone-file-drop">
                                <input type="file" id="warzone-file" name="video_file" accept=".mp4,.mov,video/mp4,video/quicktime" required>
                                <div class="warzone-file-drop-content">
                                    <svg class="warzone-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                        <polyline points="17 8 12 3 7 8"></polyline>
                                        <line x1="12" y1="3" x2="12" y2="15"></line>
                                    </svg>
                                    <p class="warzone-file-text">
                                        <span class="warzone-file-cta">Click to select</span> or drag and drop
                                    </p>
                                    <p class="warzone-file-hint">MP4 or MOV (Max 5GB)</p>
                                </div>
                                <div class="warzone-file-selected" id="warzone-file-selected">
                                    <span class="warzone-file-name"></span>
                                    <span class="warzone-file-size"></span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="warzone-form-group warzone-disclosure">
                            <p class="warzone-disclosure-text">
                                By uploading content, you grant us a non-exclusive, royalty-free license to store, review, edit and use the submitted materials, including posting edited versions on our YouTube channel and related platforms.
                            </p>
                        </div>
                        
                        <div class="warzone-form-group warzone-checkbox-group">
                            <label class="warzone-checkbox-label">
                                <input type="checkbox" id="warzone-legal" name="legal_confirm" required>
                                <span class="warzone-checkbox-custom"></span>
                                <span class="warzone-checkbox-text">
                                    I confirm that I own or have permission to upload this content and grant Warzone Wrecking Crew permission to edit and publish it on YouTube and related platforms.
                                </span>
                            </label>
                        </div>
                        
                        <div class="warzone-progress-container" id="warzone-progress-container">
                            <div class="warzone-progress-bar">
                                <div class="warzone-progress-fill" id="warzone-progress-fill"></div>
                            </div>
                            <div class="warzone-progress-text">
                                <span id="warzone-progress-percent">0%</span>
                                <span id="warzone-progress-status">Initializing...</span>
                            </div>
                        </div>
                        
                        <div class="warzone-form-actions">
                            <button type="submit" class="warzone-submit-btn" id="warzone-submit-btn">
                                <span class="btn-text">SUBMIT</span>
                                <span class="btn-loading">
                                    <svg class="spinner" viewBox="0 0 24 24">
                                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="31.416" stroke-dashoffset="10"></circle>
                                    </svg>
                                </span>
                            </button>
                        </div>
                        
                        <div class="warzone-message" id="warzone-message"></div>
                    </form>
                </div>
            </div>
        </section>
        <?php
        return ob_get_clean();
    }
    
    /**
     * Initialize upload - creates resumable upload session on Google Drive
     */
    public function ajax_init_upload() {
        check_ajax_referer('warzone_upload_nonce', 'nonce');
        
        // ========== SECURITY CHECK 1: reCAPTCHA Verification ==========
        $recaptcha_secret = get_option('warzone_recaptcha_secret_key', '') ?: WARZONE_RECAPTCHA_SECRET_KEY;
        if (!empty($recaptcha_secret)) {
            $recaptcha_token = sanitize_text_field($_POST['recaptcha_token'] ?? '');
            
            if (empty($recaptcha_token)) {
                wp_send_json_error(['message' => 'Security verification required.', 'code' => 'recaptcha_missing']);
            }
            
            $recaptcha_response = wp_remote_post('https://www.google.com/recaptcha/api/siteverify', [
                'body' => [
                    'secret' => $recaptcha_secret,
                    'response' => $recaptcha_token,
                    'remoteip' => $this->get_client_ip()
                ]
            ]);
            
            if (!is_wp_error($recaptcha_response)) {
                $recaptcha_data = json_decode(wp_remote_retrieve_body($recaptcha_response), true);
                
                // Log reCAPTCHA result for debugging (can be removed in production)
                error_log('Warzone reCAPTCHA: success=' . ($recaptcha_data['success'] ? 'true' : 'false') . ', score=' . ($recaptcha_data['score'] ?? 'N/A') . ', action=' . ($recaptcha_data['action'] ?? 'N/A'));
                
                // Check if verification passed and score is acceptable (0.5 or higher)
                if (!$recaptcha_data['success'] || ($recaptcha_data['score'] ?? 0) < 0.5) {
                    wp_send_json_error([
                        'message' => 'Security verification failed. Please try again.',
                        'code' => 'recaptcha_failed',
                        'debug_score' => $recaptcha_data['score'] ?? 0
                    ]);
                }
            }
        }
        
        // ========== SECURITY CHECK 2: IP Rate Limiting ==========
        $client_ip = $this->get_client_ip();
        $uploads_limit = intval(get_option('warzone_uploads_per_day', 5));
        $rate_limit_key = 'warzone_uploads_' . md5($client_ip);
        $current_uploads = intval(get_transient($rate_limit_key));
        
        if ($current_uploads >= $uploads_limit) {
            wp_send_json_error([
                'message' => 'Upload limit reached (' . $uploads_limit . ' per day). Please try again tomorrow.',
                'code' => 'rate_limited'
            ]);
        }
        
        $last_war_name = sanitize_text_field($_POST['last_war_name'] ?? '');
        $last_war_server = sanitize_text_field($_POST['last_war_server'] ?? '');
        $event = sanitize_text_field($_POST['event'] ?? '');
        $file_name = sanitize_file_name($_POST['file_name'] ?? '');
        $file_size = intval($_POST['file_size'] ?? 0);
        $file_type = sanitize_text_field($_POST['file_type'] ?? '');
        
        // Validate required fields
        if (empty($last_war_name) || empty($last_war_server) || empty($event) || empty($file_name)) {
            wp_send_json_error(['message' => 'All fields are required.']);
        }
        
        // ========== SECURITY CHECK 3: File Size Validation ==========
        if ($file_size > WARZONE_UPLOADER_MAX_FILE_SIZE) {
            wp_send_json_error(['message' => 'File exceeds maximum allowed size of 5GB.']);
        }
        
        // Validate file type
        $allowed_types = ['video/mp4', 'video/quicktime'];
        if (!in_array($file_type, $allowed_types)) {
            wp_send_json_error(['message' => 'Invalid file type.']);
        }
        
        // Generate new filename
        $extension = pathinfo($file_name, PATHINFO_EXTENSION);
        $new_filename = sprintf(
            '%s_%s_%s.%s',
            $this->sanitize_filename_part($last_war_name),
            $this->sanitize_filename_part($last_war_server),
            $this->sanitize_filename_part($event),
            $extension
        );
        
        // Initialize resumable upload on Google Drive
        $result = $this->drive_uploader->init_resumable_upload($new_filename, $file_type, $file_size);
        
        if (is_wp_error($result)) {
            wp_send_json_error(['message' => $result->get_error_message()]);
        }
        
        // Store upload session data
        // Calculate expiration based on file size (24 hours for large files)
        $estimated_time = ceil($file_size / WARZONE_UPLOADER_CHUNK_SIZE) * 5; // 5 sec per chunk estimate
        $expiration = max(DAY_IN_SECONDS, $estimated_time * 2); // At least 24 hours, or 2x estimated time
        
        $session_id = wp_generate_uuid4();
        set_transient('warzone_upload_' . $session_id, [
            'upload_uri' => $result['upload_uri'],
            'file_name' => $new_filename,
            'file_size' => $file_size,
            'file_type' => $file_type,
            'last_war_name' => $last_war_name,
            'last_war_server' => $last_war_server,
            'event' => $event,
            'bytes_uploaded' => 0,
            'created_at' => time(),
        ], $expiration);
        
        wp_send_json_success([
            'session_id' => $session_id,
            'upload_uri' => $result['upload_uri'], // For DIRECT browser-to-Google-Drive uploads
            'message' => 'Upload initialized'
        ]);
    }
    
    // NOTE: ajax_upload_chunk() has been REMOVED
    // Chunks are now uploaded DIRECTLY from browser to Google Drive
    // This eliminates the WordPress proxy bottleneck entirely
    
    /**
     * Finalize upload and send notification
     */
    public function ajax_finalize_upload() {
        check_ajax_referer('warzone_upload_nonce', 'nonce');
        
        $session_id = sanitize_text_field($_POST['session_id'] ?? '');
        
        if (empty($session_id)) {
            wp_send_json_error(['message' => 'Invalid session.']);
        }
        
        $session = get_transient('warzone_upload_' . $session_id);
        if (!$session) {
            wp_send_json_error(['message' => 'Session expired.']);
        }
        
        // ========== INCREMENT RATE LIMIT COUNTER ==========
        $client_ip = $this->get_client_ip();
        $rate_limit_key = 'warzone_uploads_' . md5($client_ip);
        $current_uploads = intval(get_transient($rate_limit_key));
        set_transient($rate_limit_key, $current_uploads + 1, DAY_IN_SECONDS); // Expires in 24 hours
        
        // Send admin notification
        $this->send_admin_notification($session);
        
        // Clean up transient
        delete_transient('warzone_upload_' . $session_id);
        
        wp_send_json_success([
            'message' => 'Upload complete! Your footage has been submitted for review.'
        ]);
    }
    
    /**
     * Get client IP address
     */
    private function get_client_ip() {
        $ip = '';
        
        if (!empty($_SERVER['HTTP_CLIENT_IP'])) {
            $ip = $_SERVER['HTTP_CLIENT_IP'];
        } elseif (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            // Can contain multiple IPs, get the first one
            $ips = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
            $ip = trim($ips[0]);
        } elseif (!empty($_SERVER['REMOTE_ADDR'])) {
            $ip = $_SERVER['REMOTE_ADDR'];
        }
        
        return sanitize_text_field($ip);
    }
    
    /**
     * Send email notification to admin
     */
    private function send_admin_notification($session) {
        $admin_email = get_option('admin_email');
        $site_name = get_bloginfo('name');
        
        $subject = sprintf('[%s] New Warzone Footage Submitted', $site_name);
        
        $message = sprintf(
            "A new video has been uploaded to Google Drive.\n\n" .
            "Details:\n" .
            "- File Name: %s\n" .
            "- Last War Name: %s\n" .
            "- Server: %s\n" .
            "- Event: %s\n" .
            "- File Size: %s\n" .
            "- Submitted: %s\n\n" .
            "Please review the footage in your Google Drive.",
            $session['file_name'],
            $session['last_war_name'],
            $session['last_war_server'],
            $session['event'],
            size_format($session['file_size']),
            current_time('mysql')
        );
        
        $headers = ['Content-Type: text/plain; charset=UTF-8'];
        
        wp_mail($admin_email, $subject, $message, $headers);
    }
    
    /**
     * Sanitize filename parts
     */
    private function sanitize_filename_part($string) {
        $string = sanitize_title($string);
        $string = preg_replace('/[^a-zA-Z0-9\-]/', '', $string);
        return substr($string, 0, 50);
    }
    
    /**
     * Render contact form shortcode
     */
    public function render_contact_shortcode($atts) {
        $plugin_url = WARZONE_UPLOADER_URL;
        ob_start();
        ?>
        <div class="warzone-contact-page">
            <div class="warzone-contact-container">
                <h1 class="warzone-contact-title">CONTACT US</h1>
                <p class="warzone-contact-subtitle">Got questions? Drop us a message, soldier.</p>
                
                <form class="warzone-contact-form" id="warzone-contact-form">
                    <div class="warzone-form-group">
                        <label for="contact-name" class="warzone-label">NAME <span class="required">*</span></label>
                        <input type="text" id="contact-name" name="name" class="warzone-input" required placeholder="Enter your name">
                    </div>
                    
                    <div class="warzone-form-group">
                        <label for="contact-email" class="warzone-label">EMAIL <span class="required">*</span></label>
                        <input type="email" id="contact-email" name="email" class="warzone-input" required placeholder="Enter your email">
                    </div>
                    
                    <div class="warzone-form-group">
                        <label for="contact-subject" class="warzone-label">SUBJECT</label>
                        <input type="text" id="contact-subject" name="subject" class="warzone-input" placeholder="What's this about?">
                    </div>
                    
                    <div class="warzone-form-group">
                        <label for="contact-message" class="warzone-label">MESSAGE <span class="required">*</span></label>
                        <textarea id="contact-message" name="message" class="warzone-input warzone-textarea" required placeholder="Your message..." rows="5"></textarea>
                    </div>
                    
                    <div class="warzone-form-actions">
                        <button type="submit" class="warzone-submit-btn" id="contact-submit-btn">
                            <span class="btn-text">SEND MESSAGE</span>
                            <span class="btn-loading">
                                <svg class="spinner" viewBox="0 0 24 24">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="31.416" stroke-dashoffset="10"></circle>
                                </svg>
                            </span>
                        </button>
                    </div>
                    
                    <div class="warzone-message" id="contact-message-box"></div>
                </form>
            </div>
        </div>
        
        <script>
        jQuery(document).ready(function($) {
            $('#warzone-contact-form').on('submit', function(e) {
                e.preventDefault();
                
                var $form = $(this);
                var $btn = $('#contact-submit-btn');
                var $msg = $('#contact-message-box');
                
                // Disable button
                $btn.prop('disabled', true).addClass('loading');
                $msg.removeClass('success error').hide();
                
                $.ajax({
                    url: '<?php echo admin_url('admin-ajax.php'); ?>',
                    type: 'POST',
                    data: {
                        action: 'warzone_contact_submit',
                        nonce: '<?php echo wp_create_nonce('warzone_contact_nonce'); ?>',
                        name: $('#contact-name').val(),
                        email: $('#contact-email').val(),
                        subject: $('#contact-subject').val(),
                        message: $('#contact-message').val()
                    },
                    success: function(response) {
                        if (response.success) {
                            $msg.addClass('success').text(response.data.message).show();
                            $form[0].reset();
                        } else {
                            $msg.addClass('error').text(response.data.message).show();
                        }
                    },
                    error: function() {
                        $msg.addClass('error').text('Network error. Please try again.').show();
                    },
                    complete: function() {
                        $btn.prop('disabled', false).removeClass('loading');
                    }
                });
            });
        });
        </script>
        <?php
        return ob_get_clean();
    }
    
    /**
     * Handle contact form submission
     */
    public function ajax_contact_submit() {
        check_ajax_referer('warzone_contact_nonce', 'nonce');
        
        $name = sanitize_text_field($_POST['name'] ?? '');
        $email = sanitize_email($_POST['email'] ?? '');
        $subject = sanitize_text_field($_POST['subject'] ?? 'Contact Form Submission');
        $message = sanitize_textarea_field($_POST['message'] ?? '');
        
        // Validate
        if (empty($name) || empty($email) || empty($message)) {
            wp_send_json_error(['message' => 'Please fill in all required fields.']);
        }
        
        if (!is_email($email)) {
            wp_send_json_error(['message' => 'Please enter a valid email address.']);
        }
        
        // Send email to admin
        $admin_email = get_option('admin_email');
        $site_name = get_bloginfo('name');
        
        $email_subject = sprintf('[%s] %s', $site_name, $subject ?: 'Contact Form Message');
        
        $email_body = sprintf(
            "New contact form submission:\n\n" .
            "Name: %s\n" .
            "Email: %s\n" .
            "Subject: %s\n\n" .
            "Message:\n%s\n\n" .
            "---\nSent from: %s",
            $name,
            $email,
            $subject ?: '(none)',
            $message,
            home_url()
        );
        
        $headers = [
            'Content-Type: text/plain; charset=UTF-8',
            'Reply-To: ' . $name . ' <' . $email . '>'
        ];
        
        $sent = wp_mail($admin_email, $email_subject, $email_body, $headers);
        
        if ($sent) {
            wp_send_json_success(['message' => 'Message sent successfully! We\'ll get back to you soon.']);
        } else {
            wp_send_json_error(['message' => 'Failed to send message. Please try again later.']);
        }
    }
}

// Initialize plugin
add_action('plugins_loaded', function() {
    Warzone_Uploader::get_instance();
});

// Activation hook
register_activation_hook(__FILE__, function() {
    // Create necessary directories
    $upload_dir = wp_upload_dir();
    $temp_dir = $upload_dir['basedir'] . '/warzone-temp';
    if (!file_exists($temp_dir)) {
        wp_mkdir_p($temp_dir);
    }
    
    // Add .htaccess to protect temp directory
    $htaccess = $temp_dir . '/.htaccess';
    if (!file_exists($htaccess)) {
        file_put_contents($htaccess, 'deny from all');
    }
});

// Deactivation hook
register_deactivation_hook(__FILE__, function() {
    // Clean up temp files
    $upload_dir = wp_upload_dir();
    $temp_dir = $upload_dir['basedir'] . '/warzone-temp';
    if (file_exists($temp_dir)) {
        array_map('unlink', glob("$temp_dir/*"));
    }
});
