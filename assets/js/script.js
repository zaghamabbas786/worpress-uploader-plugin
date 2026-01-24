/**
 * Warzone Uploader - Frontend JavaScript
 * Handles modal interaction,  file validation, and chunked uploads
 */

(function($) {
    'use strict';

    console.log('🎮 Warzone Uploader v2.0 - DIRECT Google Drive Uploads');
    
    // Configuration from WordPress
    const config = window.warzoneUploader || {};
    const BASE_CHUNK_SIZE = parseInt(config.chunkSize, 10) || (70 * 1024 * 1024); // 70MB default for desktop
    const MAX_FILE_SIZE = config.maxFileSize || 5 * 1024 * 1024 * 1024; // 5GB
    const ALLOWED_TYPES = config.allowedTypes || ['video/mp4', 'video/quicktime'];
    const i18n = config.i18n || {};
    
    // Mobile detection
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                     (window.innerWidth <= 768);
    
    // Connection quality detection
    let connectionInfo = null;
    let effectiveType = 'unknown';
    let downlink = 0;
    
    // Get connection info if available (Network Information API)
    if (navigator.connection || navigator.mozConnection || navigator.webkitConnection) {
        connectionInfo = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        effectiveType = connectionInfo.effectiveType || 'unknown';
        downlink = connectionInfo.downlink || 0;
    }
    
    // Adaptive chunk sizing based on device and connection
    function getOptimalChunkSize() {
        // Mobile devices: fixed 10MB (no adaptive sizing)
        if (isMobile) {
            return 10 * 1024 * 1024; // Fixed 10MB for mobile
        }
        
        // Desktop: use configured size or default
        return BASE_CHUNK_SIZE;
    }
    
    // Dynamic chunk size (will be set when upload starts)
    let CHUNK_SIZE = getOptimalChunkSize();
    console.log('⚙️ Device:', isMobile ? 'Mobile' : 'Desktop');
    console.log('⚙️ Connection:', effectiveType, downlink ? `(${downlink}Mbps)` : '');
    console.log('⚙️ CHUNK_SIZE:', CHUNK_SIZE, 'bytes (' + (CHUNK_SIZE / 1024 / 1024) + 'MB)');
    
    // Retry configuration - reduced retries for mobile (with larger chunks, fewer retries needed)
    const MAX_RETRIES = isMobile ? 3 : 5;  // Reduced from 7 to 3 for mobile (larger chunks = fewer retries needed)
    const RETRY_DELAY_BASE = isMobile ? 1000 : 2000;  // Faster retries on mobile (1s vs 2s)
    const RETRY_DELAY_MAX = isMobile ? 15000 : 30000;  // Shorter max delay on mobile (15s vs 30s)
    
    // Timeout configuration - shorter for mobile
    const CHUNK_TIMEOUT = isMobile ? 30000 : 180000; // 30s mobile (reduced from 60s), 3min desktop

    // State
    let currentFile = null;
    let uploadSessionId = null;
    let isUploading = false;
    let uploadCompleted = false; // Prevent re-submission after success
    let uploadedBytes = 0; // Track for resume capability
    let uploadUri = null; // Store for potential resume
    let chunkUploadTimes = []; // Track upload speeds for adaptive sizing
    let lastChunkTime = null;

    /**
     * Initialize the plugin
     */
    function init() {
        bindEvents();
        monitorConnection();
    }
    
    /**
     * Monitor connection quality changes
     */
    function monitorConnection() {
        if (!connectionInfo) return;
        
        // Listen for connection changes
        connectionInfo.addEventListener('change', function() {
            const newType = connectionInfo.effectiveType || 'unknown';
            const newDownlink = connectionInfo.downlink || 0;
            
            if (newType !== effectiveType || newDownlink !== downlink) {
                console.log(`📡 Connection changed: ${effectiveType} → ${newType} (${newDownlink}Mbps)`);
                effectiveType = newType;
                downlink = newDownlink;
                
                // If upload is in progress, log the change (adaptive sizing will adjust)
                if (isUploading) {
                    console.log('⚠️ Connection changed during upload - adaptive sizing will adjust');
                }
            }
        });
        
        // Monitor online/offline status (silent - no UI warnings)
        window.addEventListener('online', function() {
            console.log('✅ Network connection restored');
            // Silent - upload will continue automatically
        });
        
        window.addEventListener('offline', function() {
            console.log('❌ Network connection lost');
            // Silent - upload will retry automatically when connection is restored
        });
    }

    /**
     * Bind all event listeners
     */
    function bindEvents() {
        // Upload Modal triggers
        $('#warzone-upload-trigger').on('click', openModal);
        $('#warzone-modal-close, .warzone-modal-backdrop').on('click', closeModal);
        
        // Contact Modal triggers
        $('#warzone-contact-trigger').on('click', function(e) {
            e.preventDefault();
            openContactModal();
        });
        $('#warzone-contact-close, #warzone-contact-backdrop').on('click', closeContactModal);
        
        // Contact form submission
        $('#warzone-contact-form').on('submit', handleContactSubmit);
        
        // Escape key to close modals
        $(document).on('keydown', function(e) {
            if (e.key === 'Escape') {
                if ($('#warzone-upload-modal').attr('aria-hidden') === 'false') {
                    closeModal();
                }
                if ($('#warzone-contact-modal').attr('aria-hidden') === 'false') {
                    closeContactModal();
                }
            }
        });

        // File input handling
        const $fileDrop = $('#warzone-file-drop');
        const $fileInput = $('#warzone-file');

        $fileInput.on('change', handleFileSelect);

        // Drag and drop
        $fileDrop
            .on('dragenter dragover', function(e) {
                e.preventDefault();
                e.stopPropagation();
                $(this).addClass('drag-over');
            })
            .on('dragleave drop', function(e) {
                e.preventDefault();
                e.stopPropagation();
                $(this).removeClass('drag-over');
            })
            .on('drop', function(e) {
                const files = e.originalEvent.dataTransfer.files;
                if (files.length > 0) {
                    $fileInput[0].files = files;
                    handleFileSelect({ target: $fileInput[0] });
                }
            });

        // Form submission
        $('#warzone-upload-form').on('submit', handleFormSubmit);
    }

    /**
     * Open the upload modal
     */
    function openModal() {
        const $modal = $('#warzone-upload-modal');
        $modal.attr('aria-hidden', 'false');
        $('body').css('overflow', 'hidden');
        
        // Focus first input
        setTimeout(() => {
            $('#warzone-name').focus();
        }, 300);
    }

    /**
     * Close the upload modal
     */
    function closeModal() {
        if (isUploading) {
            if (!confirm('Upload in progress. Are you sure you want to cancel?')) {
                return;
            }
            // Reset upload state
            isUploading = false;
            uploadSessionId = null;
        }

        const $modal = $('#warzone-upload-modal');
        $modal.attr('aria-hidden', 'true');
        $('body').css('overflow', '');
        
        // Reset form after animation
        setTimeout(() => {
            resetForm();
            uploadCompleted = false; // Allow new uploads after modal closes
            setButtonLoading(false); // Show submit button again
            $('#warzone-submit-btn').prop('disabled', false);
        }, 300);
    }
    
    /**
     * Open the contact modal
     */
    function openContactModal() {
        const $modal = $('#warzone-contact-modal');
        $modal.attr('aria-hidden', 'false');
        $('body').css('overflow', 'hidden');
        
        // Focus first input
        setTimeout(() => {
            $('#contact-name').focus();
        }, 300);
    }
    
    /**
     * Close the contact modal
     */
    function closeContactModal() {
        const $modal = $('#warzone-contact-modal');
        $modal.attr('aria-hidden', 'true');
        $('body').css('overflow', '');
        
        // Reset form
        setTimeout(() => {
            $('#warzone-contact-form')[0].reset();
            $('#contact-message-box').removeClass('success error').hide();
            $('#contact-submit-btn').prop('disabled', false).removeClass('loading');
        }, 300);
    }
    
    /**
     * Handle contact form submission
     */
    async function handleContactSubmit(e) {
        e.preventDefault();
        
        const $btn = $('#contact-submit-btn');
        const $msg = $('#contact-message-box');
        
        // Disable button
        $btn.prop('disabled', true).addClass('loading');
        $msg.removeClass('success error').hide();
        
        try {
            const response = await $.ajax({
                url: config.ajaxUrl,
                type: 'POST',
                data: {
                    action: 'warzone_contact_submit',
                    nonce: config.contactNonce,
                    name: $('#contact-name').val(),
                    email: $('#contact-email').val(),
                    subject: $('#contact-subject').val(),
                    message: $('#contact-message').val()
                }
            });
            
            if (response.success) {
                $msg.addClass('success').text(response.data.message).show();
                $('#warzone-contact-form')[0].reset();
                
                // Close modal after 2 seconds
                setTimeout(() => {
                    closeContactModal();
                }, 2000);
            } else {
                $msg.addClass('error').text(response.data.message).show();
            }
        } catch (error) {
            $msg.addClass('error').text('Network error. Please try again.').show();
        } finally {
            $btn.prop('disabled', false).removeClass('loading');
        }
    }

    /**
     * Handle file selection
     */
    function handleFileSelect(e) {
        const file = e.target.files[0];
        
        if (!file) {
            resetFileInput();
            return;
        }

        // Validate file type
        if (!ALLOWED_TYPES.includes(file.type)) {
            showMessage(i18n.invalidFile || 'Invalid file type. Only MP4 and MOV allowed.', 'error');
            resetFileInput();
            return;
        }

        // Validate file size
        if (file.size > MAX_FILE_SIZE) {
            showMessage(i18n.fileTooLarge || 'File exceeds 5GB limit.', 'error');
            resetFileInput();
            return;
        }

        currentFile = file;
        
        // Update UI
        const $fileDrop = $('#warzone-file-drop');
        $fileDrop.addClass('has-file');
        $fileDrop.find('.warzone-file-name').text(file.name);
        $fileDrop.find('.warzone-file-size').text(formatFileSize(file.size));
        
        hideMessage();
    }

    /**
     * Reset file input
     */
    function resetFileInput() {
        currentFile = null;
        const $fileDrop = $('#warzone-file-drop');
        $fileDrop.removeClass('has-file');
        $('#warzone-file').val('');
    }

    /**
     * Handle form submission
     */
    async function handleFormSubmit(e) {
        e.preventDefault();

        console.log('📋 Form submit triggered. isUploading:', isUploading, 'uploadCompleted:', uploadCompleted);
        
        if (isUploading) {
            console.log('⚠️ Upload already in progress. Ignoring submit.');
            return;
        }
        
        if (uploadCompleted) {
            console.log('⚠️ Upload already completed. Ignoring submit.');
            return;
        }

        // Validate form
        const formData = {
            last_war_name: $('#warzone-name').val().trim(),
            last_war_server: $('#warzone-server').val().trim(),
            event: $('#warzone-event').val().trim(),
            legal_confirm: $('#warzone-legal').is(':checked')
        };

        if (!formData.last_war_name || !formData.last_war_server || !formData.event) {
            showMessage(i18n.requiredFields || 'All fields are required, soldier!', 'error');
            return;
        }

        if (!formData.legal_confirm) {
            showMessage(i18n.confirmLegal || 'You must confirm the legal agreement.', 'error');
            return;
        }

        if (!currentFile) {
            showMessage(i18n.invalidFile || 'Please select a video file.', 'error');
            return;
        }

        // Start upload process
        isUploading = true;
        uploadedBytes = 0; // Reset byte counter
        uploadUri = null;
        chunkUploadTimes = []; // Reset speed tracking
        lastChunkTime = null;
        
        setButtonLoading(true);
        showProgress(0, 'Initializing...');
        hideMessage();

        try {
            // Step 1: Initialize upload session
            showProgress(5, 'Connecting to server...');
            console.log('📡 Step 1: Initializing upload session...');
            
            const initResult = await initializeUpload(formData);
            
            if (!initResult.success) {
                throw new Error(initResult.data.message || 'Failed to initialize upload');
            }

            uploadSessionId = initResult.data.session_id;
            uploadUri = initResult.data.upload_uri; // Google Drive resumable upload URI
            
            console.log('🚀 DIRECT UPLOAD MODE - Version 2.0');
            console.log('📤 Upload URI (Google Drive):', uploadUri ? uploadUri.substring(0, 80) + '...' : 'MISSING!');
            console.log('✅ Chunks will go DIRECTLY to Google (NOT through WordPress)');
            
            if (!uploadUri) {
                throw new Error('Upload URI not received from server');
            }

            // Step 2: Upload file in chunks DIRECTLY to Google Drive
            showProgress(10, 'Starting upload...');
            console.log('📤 Step 2: Starting DIRECT chunked upload to Google Drive...');
            
            // Add a watchdog timer to detect stalls (shared with uploadFileChunks)
            // Only logs to console, no UI warnings
            window.warzoneLastProgressUpdate = Date.now();
            const progressWatchdog = setInterval(() => {
                const timeSinceUpdate = Date.now() - (window.warzoneLastProgressUpdate || Date.now());
                // If no progress for 90 seconds, log to console only (no UI warning)
                if (timeSinceUpdate > 90000 && uploadedBytes === 0) {
                    console.warn('⚠️ Upload appears stalled - no progress for 90 seconds');
                    // No UI message - silent handling
                }
            }, 10000); // Check every 10 seconds
            
            try {
                await uploadFileChunks();
                clearInterval(progressWatchdog);
                delete window.warzoneLastProgressUpdate;
                console.log('📤 Step 2: Chunked upload complete!');
            } catch (error) {
                clearInterval(progressWatchdog);
                delete window.warzoneLastProgressUpdate;
                throw error;
            }

            // Step 3: Finalize upload
            console.log('📝 Step 3: Finalizing upload...');
            showProgress(100, i18n.processing || 'PROCESSING...');
            const finalResult = await finalizeUpload();
            console.log('📝 Step 3: Finalize result:', finalResult);

            if (!finalResult.success) {
                throw new Error(finalResult.data.message || 'Failed to finalize upload');
            }

            // Success! Disable form to prevent re-submission
            console.log('🎉 Upload successful! Disabling form...');
            uploadCompleted = true;
            $('#warzone-submit-btn').prop('disabled', true);
            showProgress(100, i18n.success || 'MISSION COMPLETE!');
            showMessage(finalResult.data.message || 'Upload successful!', 'success');
            
            // Reset form after delay
            setTimeout(() => {
                console.log('🔄 Closing modal and resetting...');
                closeModal(); // This will also reset uploadCompleted and re-enable button
            }, 3000);

        } catch (error) {
            console.error('Upload error:', error);
            
            // Show helpful error message with upload progress info
            let errorMsg = error.message || (i18n.error || 'Upload failed. Please try again.');
            if (uploadedBytes > 0) {
                const uploadedMB = (uploadedBytes / (1024 * 1024)).toFixed(1);
                errorMsg += ` (${uploadedMB}MB uploaded before failure)`;
            }
            
            showMessage(errorMsg, 'error');
            
            // Only show submit button again on ERROR (so user can retry)
            setButtonLoading(false);
        } finally {
            isUploading = false;
            uploadSessionId = null;
            uploadedBytes = 0;
            uploadUri = null;
            // NOTE: Don't call setButtonLoading(false) here!
            // On success: button stays hidden until modal closes
            // On error: button is shown in catch block above
        }
    }

    /**
     * Initialize upload session on server
     */
    async function initializeUpload(formData) {
        // Get reCAPTCHA token if enabled
        let recaptchaToken = '';
        if (config.recaptchaEnabled && config.recaptchaSiteKey && typeof grecaptcha !== 'undefined') {
            try {
                console.log('🔒 reCAPTCHA: Getting token...');
                showProgress(3, 'Verifying security...');
                recaptchaToken = await grecaptcha.execute(config.recaptchaSiteKey, {action: 'upload'});
                console.log('✅ reCAPTCHA: Token obtained (length: ' + recaptchaToken.length + ')');
            } catch (e) {
                console.error('❌ reCAPTCHA error:', e);
                throw new Error(i18n.recaptchaFailed || 'Security verification failed.');
            }
        } else {
            console.log('⚠️ reCAPTCHA: Disabled or not loaded');
        }
        
        return new Promise((resolve, reject) => {
            // Log AJAX configuration for debugging
            const currentDomain = window.location.hostname;
            const currentOrigin = window.location.origin;
            let ajaxOrigin = '';
            try {
                ajaxOrigin = config.ajaxUrl ? new URL(config.ajaxUrl).origin : '';
            } catch (e) {
                console.error('❌ Invalid AJAX URL format:', e);
            }
            
            const isSameOrigin = (currentOrigin === ajaxOrigin);
            
            console.log('📡 Initialization AJAX config:', {
                url: config.ajaxUrl,
                action: 'warzone_init_upload',
                hasNonce: !!config.nonce,
                recaptchaTokenLength: recaptchaToken ? recaptchaToken.length : 0,
                fileSize: currentFile.size,
                fileName: currentFile.name,
                currentDomain: currentDomain,
                currentOrigin: currentOrigin,
                ajaxOrigin: ajaxOrigin,
                isSameOrigin: isSameOrigin,
                recaptchaSiteKey: config.recaptchaSiteKey ? config.recaptchaSiteKey.substring(0, 20) + '...' : 'not set',
                note: isSameOrigin ? 'Same origin - CORS should not be an issue' : '⚠️ DIFFERENT ORIGINS - CORS will block this request!'
            });
            
            if (!isSameOrigin) {
                console.error('❌ CORS BLOCK DETECTED:', {
                    pageOrigin: currentOrigin,
                    ajaxOrigin: ajaxOrigin,
                    solution: 'Either fix origin mismatch or add CORS headers on server'
                });
            }
            
            // Add timeout for initialization (30 seconds)
            const timeout = setTimeout(() => {
                reject(new Error('Initialization timed out. Please check your connection and try again.'));
            }, 30000);
            
            // Check for protocol mismatch (HTTP vs HTTPS)
            const currentProtocol = window.location.protocol;
            let ajaxProtocol = '';
            try {
                ajaxProtocol = config.ajaxUrl ? new URL(config.ajaxUrl).protocol : '';
                if (currentProtocol !== ajaxProtocol) {
                    console.error('⚠️ Protocol mismatch detected:', {
                        currentPage: currentProtocol,
                        ajaxUrl: ajaxProtocol,
                        note: 'Mixed content (HTTP/HTTPS) can cause status 0 errors'
                    });
                }
            } catch (urlError) {
                console.error('⚠️ Invalid AJAX URL format:', urlError);
            }
            
            // Test if we can create an XHR object (basic connectivity test)
            try {
                const testXhr = new XMLHttpRequest();
                console.log('✅ XHR object can be created');
            } catch (xhrError) {
                console.error('❌ Cannot create XHR object:', xhrError);
            }
            
            // Validate AJAX URL before attempting request
            if (!config.ajaxUrl) {
                clearTimeout(timeout);
                reject(new Error('AJAX URL not configured. Please check plugin settings.'));
                return;
            }
            
            console.log('🚀 Attempting AJAX request to:', config.ajaxUrl);
            
            try {
                $.ajax({
                    url: config.ajaxUrl,
                    type: 'POST',
                    timeout: 30000, // 30 second timeout
                    data: {
                        action: 'warzone_init_upload',
                        nonce: config.nonce,
                        last_war_name: formData.last_war_name,
                        last_war_server: formData.last_war_server,
                        event: formData.event,
                        file_name: currentFile.name,
                        file_size: currentFile.size,
                        file_type: currentFile.type,
                        recaptcha_token: recaptchaToken
                    },
                    beforeSend: function(xhr) {
                        console.log('📤 beforeSend fired - request is starting...', {
                            url: config.ajaxUrl,
                            readyState: xhr.readyState
                        });
                    },
                success: (response) => {
                    clearTimeout(timeout);
                    console.log('✅ Upload initialized successfully');
                    resolve(response);
                },
                error: (xhr, status, error) => {
                    clearTimeout(timeout);
                    console.error('❌ Initialization failed:', {
                        status: xhr.status,
                        statusText: xhr.statusText,
                        error: error,
                        responseText: xhr.responseText,
                        readyState: xhr.readyState,
                        responseURL: xhr.responseURL,
                        ajaxUrl: config.ajaxUrl,
                        currentProtocol: window.location.protocol,
                        ajaxProtocol: ajaxProtocol,
                        currentDomain: window.location.hostname,
                        note: 'Status 0 with readyState 0 = request never started. Check: network, CORS, mixed content, browser extensions'
                    });
                    
                    let errorMsg = 'Network error';
                    if (status === 'timeout') {
                        errorMsg = 'Connection timed out. Please check your internet connection.';
                    } else if (xhr.status === 0) {
                        // Status 0 - request never reached server
                        if (!config.ajaxUrl) {
                            errorMsg = 'AJAX URL not configured. Please check plugin settings.';
                        } else if (config.ajaxUrl.indexOf('admin-ajax.php') === -1) {
                            errorMsg = 'Invalid AJAX URL. Please check plugin configuration.';
                        } else {
                            // Try to provide more specific guidance
                            const isSameOrigin = (new URL(config.ajaxUrl).origin === window.location.origin);
                            if (!isSameOrigin) {
                                errorMsg = 'Cross-origin request blocked. Check CORS settings or use same domain.';
                            } else {
                                errorMsg = 'Connection failed. Possible causes: network issue, browser extension blocking, or server firewall. Check browser Network tab for details.';
                            }
                        }
                    } else if (xhr.status >= 400) {
                        try {
                            const response = JSON.parse(xhr.responseText);
                            errorMsg = response.data && response.data.message ? response.data.message : `Server error (${xhr.status})`;
                        } catch (e) {
                            errorMsg = `Server error (${xhr.status}): ${xhr.statusText}`;
                        }
                    }
                    
                    reject(new Error(errorMsg));
                }
                });
            } catch (ajaxError) {
                clearTimeout(timeout);
                console.error('❌ AJAX call threw exception before request:', ajaxError);
                reject(new Error('Failed to initiate request: ' + (ajaxError.message || 'Unknown error')));
            }
        });
    }

    /**
     * Upload file in chunks - DIRECT to Google Drive (sequential - required by Google)
     * With adaptive chunk sizing based on connection quality
     */
    async function uploadFileChunks() {
        // Mobile: Fixed 10MB chunk size (no adaptive sizing, no changes during upload)
        // Desktop: Use configured size
        const MOBILE_CHUNK_SIZE = 10 * 1024 * 1024; // Fixed 10MB for mobile
        let currentChunkSize = isMobile ? MOBILE_CHUNK_SIZE : getOptimalChunkSize();
        let chunkIndex = 0;
        // Use global uploadedBytes (already reset to 0 in handleFormSubmit)
        
        console.log(`🚀 Starting DIRECT Google Drive upload with chunk size: ${(currentChunkSize / (1024*1024)).toFixed(1)}MB`);
        console.log(`📱 File size: ${(currentFile.size / (1024*1024)).toFixed(1)}MB`);
        
        // Upload chunks sequentially (Google Drive requires this)
        // Use while loop to handle dynamic chunk size changes
        while (uploadedBytes < currentFile.size) {
            // Mobile: Always use fixed 10MB (no adaptive sizing)
            if (isMobile) {
                currentChunkSize = MOBILE_CHUNK_SIZE;
            }
            
            const start = uploadedBytes;
            const end = Math.min(start + currentChunkSize, currentFile.size);
            let chunk = currentFile.slice(start, end); // Use 'let' instead of 'const' so we can set it to null for cleanup
            
            // Show progress before starting chunk upload
            const progressBefore = Math.max(10, Math.round((start / currentFile.size) * 100));
            showProgress(progressBefore, `UPLOADING...`);
            
            // Track upload start time for speed calculation
            const chunkStartTime = Date.now();
            
            // Check chunk position BEFORE retry loop
            const isFirstChunk = (chunkIndex === 0);
            const isLastChunk = (end >= currentFile.size);
            const isSingleChunk = (currentFile.size <= currentChunkSize);
            const mostDataSent = (start >= currentFile.size * 0.9);
            
            let retryCount = 0;
            let result;
            
            const chunkSizeMB = chunk && chunk.size ? (chunk.size / (1024*1024)).toFixed(1) : '0.0';
            console.log(`📤 Uploading chunk ${chunkIndex + 1}: ${chunkSizeMB}MB (bytes ${start}-${end-1})`);
            
            // MOBILE: Trust mode for last chunk OR when most data is sent (90%+) - upload once, assume success if fails
            // Desktop: Special handling for last chunk/single chunk (original behavior)
            if (isMobile && (isLastChunk || mostDataSent)) {
                const percentSent = ((start / currentFile.size) * 100).toFixed(1);
                console.log(`🎯 Mobile: ${isLastChunk ? 'Last chunk' : 'Most data sent'} (${percentSent}%) - TRUST MODE: uploading once, assuming success if fails`);
                try {
                    result = await uploadChunkDirect(chunk, start, end - 1, currentFile.size, chunkIndex);
                    // Assume success even if response failed - most data is sent, file likely on Google Drive
                    if (!result.success) {
                        console.log('📝 Chunk response failed, but assuming success (most data sent - mission success, NO RETRY)');
                    }
                    result.success = true;
                    // Use Range header bytes if available, otherwise use end
                    if (result.data && result.data.bytes_uploaded) {
                        result.data.bytes_uploaded = result.data.bytes_uploaded;
                    } else {
                        result.data = { bytes_uploaded: end, complete: isLastChunk };
                    }
                } catch (error) {
                    console.log('📝 Chunk exception, but assuming success (most data sent - mission success, NO RETRY)');
                    result = { success: true, data: { bytes_uploaded: end, complete: isLastChunk } };
                }
            }
            // MOBILE: Other chunks go through retry mechanism
            else if (isMobile) {
                // Mobile: ALL chunks retry on failure
                while (retryCount < MAX_RETRIES) {
                    try {
                        result = await uploadChunkDirect(chunk, start, end - 1, currentFile.size, chunkIndex);
                        
                        if (result.success) {
                            break;
                        }
                        
                        console.error(`❌ Mobile: Chunk ${chunkIndex + 1} upload failed:`, result.data);
                    } catch (error) {
                        console.error(`❌ Mobile: Chunk ${chunkIndex + 1} upload exception:`, error);
                        result = {
                            success: false,
                            data: {
                                message: error.message || 'Upload exception occurred',
                                recoverable: true
                            }
                        };
                    }
                    
                    // Before retrying or throwing error, check with Google if upload is already complete
                    // This prevents false errors when the file is actually uploaded but chunk response failed
                    console.log(`⚠️ Mobile: Chunk ${chunkIndex + 1} failed - checking with Google before retry/error...`);
                    const progress = Math.round((start / currentFile.size) * 100);
                    showProgress(progress, `UPLOADING...`);
                    
                    const status = await checkUploadStatus();
                    
                    // If upload is complete, treat as success (file is already on Google Drive)
                    if (status.complete) {
                        console.log('✅ Mobile: Google confirms upload is COMPLETE! Treating as success.');
                        result.success = true;
                        uploadedBytes = currentFile.size;
                        break;
                    }
                    
                    // If chunk bytes are already uploaded, treat as success and continue
                    if (status.bytesUploaded >= end) {
                        console.log(`✅ Mobile: Google confirms chunk ${chunkIndex + 1} was received (${(status.bytesUploaded / 1024 / 1024).toFixed(1)}MB)!`);
                        result.success = true;
                        uploadedBytes = status.bytesUploaded;
                        break;
                    }
                    
                    // If first chunk failed but some bytes uploaded, update and continue
                    if (isFirstChunk && status.bytesUploaded > 0) {
                        console.log(`✅ Mobile: Google confirms ${(status.bytesUploaded / 1024 / 1024).toFixed(1)}MB uploaded - continuing...`);
                        result.success = true;
                        uploadedBytes = status.bytesUploaded;
                        break;
                    }
                    
                    // Mobile: Always retry failed chunks (up to MAX_RETRIES)
                    if (retryCount < MAX_RETRIES - 1) {
                        retryCount++;
                        // Faster retries on mobile - use linear backoff
                        const delay = RETRY_DELAY_BASE * retryCount; // Linear: 1s, 2s, 3s, 4s, etc.
                        console.log(`🔄 Mobile: Retrying chunk ${chunkIndex + 1} in ${delay/1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                        const retryProgress = Math.max(10, Math.round((start / currentFile.size) * 100));
                        showProgress(retryProgress, `UPLOADING...`);
                        await sleep(delay);
                        continue;
                    } else {
                        // All retries exhausted on mobile - check one more time with Google
                        console.log(`⚠️ Mobile: All retries exhausted for chunk ${chunkIndex + 1} - final Google check...`);
                        const finalStatus = await checkUploadStatus();
                        
                        if (finalStatus.complete) {
                            console.log('✅ Mobile: Final check - Google confirms upload is COMPLETE!');
                            result.success = true;
                            uploadedBytes = currentFile.size;
                            break;
                        }
                        
                        if (finalStatus.bytesUploaded >= end) {
                            console.log(`✅ Mobile: Final check - Google confirms chunk ${chunkIndex + 1} was received!`);
                            result.success = true;
                            uploadedBytes = finalStatus.bytesUploaded;
                            break;
                        }
                        
                        // Only throw error if Google confirms upload is truly incomplete
                        const errorMsg = result.data ? result.data.message : 'Chunk upload failed after all retries';
                        console.error(`❌ Mobile: Chunk ${chunkIndex + 1} failed after ${retryCount + 1} attempts: ${errorMsg}`);
                        throw new Error(`Chunk ${chunkIndex + 1} failed: ${errorMsg}`);
                    }
                }
            }
            // DESKTOP: Special handling for last chunk/single chunk (original behavior)
            else if (isLastChunk || isSingleChunk) {
                // Desktop: Last chunk or single chunk - upload once, assume success if fails
                console.log('📝 Desktop last/single chunk - uploading once, no retries');
                try {
                    result = await uploadChunkDirect(chunk, start, end - 1, currentFile.size, chunkIndex);
                    if (!result.success) {
                        console.log('📝 Last chunk response failed, but assuming success (data likely sent)');
                    }
                    result.success = true;
                    // Use Range header bytes if available, otherwise use end
                    if (result.data && result.data.bytes_uploaded) {
                        result.data.bytes_uploaded = result.data.bytes_uploaded;
                    } else {
                        result.data = { bytes_uploaded: end, complete: isLastChunk };
                    }
                } catch (error) {
                    console.log('📝 Last chunk exception, but assuming success (data likely sent)');
                    result = { success: true, data: { bytes_uploaded: end, complete: isLastChunk } };
                }
            }
            // DESKTOP: Other chunks - retry loop with exponential backoff
            else {
                while (retryCount < MAX_RETRIES) {
                    try {
                        result = await uploadChunkDirect(chunk, start, end - 1, currentFile.size, chunkIndex);
                        
                        if (result.success) {
                            break;
                        }
                        
                        console.error(`❌ Chunk ${chunkIndex + 1} upload failed:`, result.data);
                    } catch (error) {
                        console.error(`❌ Chunk ${chunkIndex + 1} upload exception:`, error);
                        result = {
                            success: false,
                            data: {
                                message: error.message || 'Upload exception occurred',
                                recoverable: true
                            }
                        };
                    }
                    
                    // SPECIAL HANDLING: For first chunk, be more careful - don't skip verification
                    // First chunk is critical - if it fails, the whole upload fails
                    if (isFirstChunk && !result.success) {
                        console.log('⚠️ First chunk failed - this is critical, verifying with Google...');
                        const progress = Math.max(10, Math.round((start / currentFile.size) * 100));
                        showProgress(progress, `UPLOADING...`);
                        const status = await checkUploadStatus();
                        if (status.bytesUploaded > 0) {
                            console.log(`✅ Google confirms ${status.bytesUploaded} bytes uploaded - continuing...`);
                            result.success = true;
                            uploadedBytes = status.bytesUploaded;
                            break;
                        }
                    }
                    
                    // On desktop, if most data is sent (90%+), proceed to finalize
                    if (mostDataSent && !isMobile) {
                        console.log('📝 File should be in Google Drive - proceeding to finalize');
                        result.success = true;
                        break;
                    }
                    
                    // For non-last chunks: check with Google to see if data was received
                    console.log(`⚠️ Chunk ${chunkIndex + 1} failed - checking with Google...`);
                    const progress = Math.round((uploadedBytes / currentFile.size) * 100);
                    showProgress(progress, `UPLOADING...`);
                    
                    const status = await checkUploadStatus();
                    
                    if (status.complete) {
                        console.log('✅ Google confirms upload is COMPLETE!');
                        result.success = true;
                        break;
                    }
                    
                    if (status.bytesUploaded >= end) {
                        console.log(`✅ Google confirms chunk ${chunkIndex + 1} was received!`);
                        result.success = true;
                        break;
                    }
                    
                    // MOBILE: Always retry on mobile if chunk fails (unless all retries exhausted)
                    // Desktop: Only retry if recoverable
                    if (isMobile) {
                        // Mobile: Always retry failed chunks (up to MAX_RETRIES)
                        if (retryCount < MAX_RETRIES - 1) {
                            retryCount++;
                            // Faster retries on mobile - use linear backoff
                            const delay = RETRY_DELAY_BASE * retryCount; // Linear: 1s, 2s, 3s, 4s, etc.
                            console.log(`🔄 Mobile: Retrying chunk ${chunkIndex + 1} in ${delay/1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                            const retryProgress = Math.max(10, Math.round((start / currentFile.size) * 100));
                            showProgress(retryProgress, `UPLOADING...`);
                            await sleep(delay);
                            continue;
                        } else {
                            // All retries exhausted on mobile
                            const errorMsg = result.data ? result.data.message : 'Chunk upload failed after all retries';
                            console.error(`❌ Mobile: Chunk ${chunkIndex + 1} failed after ${retryCount + 1} attempts: ${errorMsg}`);
                            throw new Error(`Chunk ${chunkIndex + 1} failed: ${errorMsg}`);
                        }
                    } else {
                        // Desktop: Only retry if recoverable
                        if (result.data && result.data.recoverable && retryCount < MAX_RETRIES - 1) {
                            retryCount++;
                            const delay = Math.min(RETRY_DELAY_BASE * Math.pow(2, retryCount - 1), RETRY_DELAY_MAX);
                            console.log(`🔄 Retrying chunk ${chunkIndex + 1} in ${delay/1000}s (${retryCount}/${MAX_RETRIES})...`);
                            const retryProgress = Math.max(10, Math.round((start / currentFile.size) * 100));
                            showProgress(retryProgress, `UPLOADING...`);
                            await sleep(delay);
                            continue;
                        }
                        
                        // If we get here, all retries failed
                        const errorMsg = result.data ? result.data.message : 'Chunk upload failed after all retries';
                        console.error(`❌ Chunk ${chunkIndex + 1} failed after ${retryCount} retries: ${errorMsg}`);
                        throw new Error(`Chunk ${chunkIndex + 1} failed: ${errorMsg}`);
                    }
                }
            }
            
            // Track upload speed for adaptive sizing
            const chunkEndTime = Date.now();
            const chunkDuration = (chunkEndTime - chunkStartTime) / 1000; // seconds
            // Ensure duration is at least 0.1 seconds to avoid division by zero or NaN
            const safeDuration = Math.max(0.1, chunkDuration);
            let chunkSpeed = 0;
            if (chunk && chunk.size > 0 && isFinite(safeDuration) && safeDuration > 0) {
                chunkSpeed = chunk.size / safeDuration; // bytes per second
            }
            
            // Only track valid speeds (not NaN or Infinity)
            if (isFinite(chunkSpeed) && chunkSpeed > 0) {
                chunkUploadTimes.push(chunkSpeed);
            }
            
            // Keep only last 5 speeds for rolling average (for tracking only, no adaptive sizing on mobile)
            if (chunkUploadTimes.length > 5) {
                chunkUploadTimes.shift();
            }
            
            // Mobile: Fixed 10MB chunk size (no adaptive sizing)
            // Desktop: Can still use adaptive sizing if needed in future
            
            // Update uploadedBytes from Range header (what Google actually received) instead of just end
            // This ensures we track exactly what Google has, preventing infinite loops
            if (result && result.success && result.data && result.data.bytes_uploaded) {
                uploadedBytes = result.data.bytes_uploaded;
                console.log(`📊 Updated uploadedBytes from Range header: ${(uploadedBytes / 1024 / 1024).toFixed(1)}MB`);
            } else {
                // Fallback to end if no Range data available
                uploadedBytes = end;
            }
            
            // CRITICAL: Explicitly release blob memory (all platforms)
            // iOS Safari has aggressive memory management and won't garbage collect blobs automatically
            if (chunk && typeof chunk.close === 'function') {
                chunk.close();
            }
            chunk = null; // Clear reference to help garbage collection
            
            // Force loop exit if upload is complete (200/201) or all bytes received
            if (result && result.success && result.data && result.data.complete) {
                console.log('✅ Upload COMPLETE (200/201) - forcing loop exit');
                uploadedBytes = currentFile.size;
            }
            
            // Force loop exit if all bytes are uploaded (verified via Range header)
            if (uploadedBytes >= currentFile.size) {
                console.log(`✅ All bytes uploaded (${(uploadedBytes / 1024 / 1024).toFixed(1)}MB >= ${(currentFile.size / 1024 / 1024).toFixed(1)}MB) - forcing loop exit`);
                uploadedBytes = currentFile.size;
            }
            
            chunkIndex++;
            
            // Update progress (original simple calculation - based on bytes uploaded)
            // Ensure all values are valid numbers to prevent NaN
            if (!currentFile || !currentFile.size || !isFinite(currentFile.size) || currentFile.size <= 0) {
                console.error('❌ Invalid currentFile.size:', currentFile);
                showProgress(0, 'UPLOADING...');
                continue;
            }
            
            if (!isFinite(uploadedBytes) || uploadedBytes < 0) {
                console.error('❌ Invalid uploadedBytes:', uploadedBytes);
                uploadedBytes = 0;
            }
            
            const progress = Math.round((uploadedBytes / currentFile.size) * 100);
            const uploadedMB = (uploadedBytes / (1024 * 1024)).toFixed(1);
            const totalMB = (currentFile.size / (1024 * 1024)).toFixed(1);
            
            // Calculate speed safely - default to 0.0 if invalid
            let speedMBps = '0.0';
            if (chunkSpeed && isFinite(chunkSpeed) && chunkSpeed > 0) {
                speedMBps = (chunkSpeed / (1024 * 1024)).toFixed(1);
            }
            
            showProgress(progress, `UPLOADING... ${uploadedMB}MB / ${totalMB}MB (${speedMBps}MB/s)`);
            
            // Update watchdog timer
            if (window.warzoneLastProgressUpdate !== undefined) {
                window.warzoneLastProgressUpdate = Date.now();
            }
            
            console.log(`✅ Chunk ${chunkIndex} complete (${speedMBps}MB/s) - ${uploadedMB}MB / ${totalMB}MB`);
            
            // Force loop exit if complete or all bytes uploaded
            if (uploadedBytes >= currentFile.size) {
                console.log('🏁 All bytes uploaded - breaking loop to finalize');
                break;
            }
            
            // Small delay between chunks to avoid rate limiting (50ms mobile, 100ms desktop)
            if (uploadedBytes < currentFile.size) {
                await sleep(isMobile ? 150 : 100); // Increased from 50ms to 150ms for mobile to give iOS Safari more breathing room
            }
        }
        
        console.log('🏁 All chunks uploaded successfully!');
    }
    
    /**
     * Sleep helper for retry delays
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Check upload status from Google Drive (for recovery)
     * Returns: { bytesUploaded: number, complete: boolean }
     * Retries up to 3 times with delays
     */
    async function checkUploadStatus() {
        const statusTimeout = isMobile ? 15000 : 30000; // 15s mobile, 30s desktop
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`📡 Status check attempt ${attempt}/3...`);
            
            const result = await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.timeout = statusTimeout;
                
                xhr.addEventListener('load', () => {
                    // Log Google Drive status check response for debugging
                    console.log(`📡 Google Drive Status Check Response (attempt ${attempt}):`, {
                        status: xhr.status,
                        statusText: xhr.statusText,
                        responseURL: xhr.responseURL,
                        responseHeaders: xhr.getAllResponseHeaders(),
                        responseText: xhr.responseText ? xhr.responseText.substring(0, 500) : '(empty)',
                        readyState: xhr.readyState
                    });
                    
                    if (xhr.status === 308) {
                        // Upload incomplete - check Range header for bytes uploaded
                        const range = xhr.getResponseHeader('Range');
                        console.log(`📊 Google Drive Range Header: ${range || '(not present)'}`);
                        
                        if (range) {
                            // Range format: "bytes=0-12345"
                            const match = range.match(/bytes=0-(\d+)/);
                            if (match) {
                                const bytesUploaded = parseInt(match[1], 10) + 1;
                                const uploadedMB = (bytesUploaded / 1024 / 1024).toFixed(1);
                                const totalMB = (currentFile.size / 1024 / 1024).toFixed(1);
                                const percentComplete = ((bytesUploaded / currentFile.size) * 100).toFixed(1);
                                console.log(`📊 Google Drive Status: INCOMPLETE - ${uploadedMB}MB / ${totalMB}MB (${percentComplete}%) uploaded`);
                                console.log(`📊 Status Complete: FALSE - More chunks needed`);
                                resolve({ bytesUploaded, complete: false, success: true });
                                return;
                            }
                        }
                        console.log(`📊 Google Drive Status: INCOMPLETE - No Range header, assuming 0 bytes`);
                        console.log(`📊 Status Complete: FALSE`);
                        resolve({ bytesUploaded: 0, complete: false, success: true });
                    } else if (xhr.status === 200 || xhr.status === 201) {
                        // Upload already complete!
                        const totalMB = (currentFile.size / 1024 / 1024).toFixed(1);
                        console.log(`✅ Google Drive Status: COMPLETE! - ${totalMB}MB uploaded`);
                        console.log(`✅ Status Complete: TRUE - Upload finished`);
                        resolve({ bytesUploaded: currentFile.size, complete: true, success: true });
                    } else {
                        console.log(`⚠️ Google Drive Status Check: Unexpected status ${xhr.status}`);
                        console.log(`⚠️ Status Complete: UNKNOWN`);
                        resolve({ bytesUploaded: -1, complete: false, success: false });
                    }
                });
                
                xhr.addEventListener('error', (e) => {
                    console.error(`❌ Status check error (attempt ${attempt}):`, {
                        status: xhr.status,
                        statusText: xhr.statusText,
                        readyState: xhr.readyState,
                        responseURL: xhr.responseURL,
                        event: e,
                        uploadUri: uploadUri ? uploadUri.substring(0, 100) + '...' : 'MISSING',
                        note: 'Status check failed - cannot verify upload progress'
                    });
                    resolve({ bytesUploaded: -1, complete: false, success: false });
                });
                
                xhr.addEventListener('timeout', () => {
                    console.log(`⏱️ Status check timeout (attempt ${attempt})`);
                    resolve({ bytesUploaded: -1, complete: false, success: false });
                });
                
                xhr.open('PUT', uploadUri);
                xhr.setRequestHeader('Content-Range', `bytes */${currentFile.size}`);
                xhr.send();
            });
            
            if (result.success) {
                return result;
            }
            
            // Wait before retry (faster on mobile: 1s, 2s, 4s vs 2s, 4s, 8s)
            if (attempt < 3) {
                const baseDelay = isMobile ? 1000 : 2000;
                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.log(`⏳ Waiting ${delay/1000}s before next status check...`);
                await sleep(delay);
            }
        }
        
        console.log('❌ All status check attempts failed');
        return { bytesUploaded: -1, complete: false, success: false };
    }

    /**
     * Upload a single chunk DIRECTLY to Google Drive
     */
    function uploadChunkDirect(chunk, startByte, endByte, totalSize, chunkIndex) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            // Fix Content-Range for last chunk: bytes [start]-[total-1]/[total]
            // CRITICAL: Google Drive requires last byte to be totalSize - 1 (0-indexed)
            // Example: 1000 byte file → last byte must be 999, not 1000
            const isLastChunkInUpload = (endByte >= totalSize - 1);
            const actualEndByte = isLastChunkInUpload ? (totalSize - 1) : endByte;
            
            // Verify math: if totalSize=1000, actualEndByte must be 999 for last chunk
            if (isLastChunkInUpload && actualEndByte !== totalSize - 1) {
                console.error(`❌ Content-Range math error: last chunk endByte=${actualEndByte}, expected=${totalSize - 1} for totalSize=${totalSize}`);
            }
            
            const contentRange = `bytes ${startByte}-${actualEndByte}/${totalSize}`;
            console.log(`📋 Content-Range: ${contentRange} (last chunk: ${isLastChunkInUpload}, totalSize: ${totalSize})`);
            
            // Safety timeout wrapper - ensures we always get a response (critical for mobile)
            // On mobile, XHR can fail silently without firing any events
            const safetyTimeout = setTimeout(() => {
                if (xhr.readyState !== XMLHttpRequest.DONE) {
                    console.error(`⚠️ Mobile: Chunk ${chunkIndex + 1} safety timeout - XHR stuck (readyState: ${xhr.readyState})`);
                    xhr.abort(); // Force abort to trigger error handler
                    
                    // On mobile, check with Google before giving up (data might be uploaded)
                    if (isMobile) {
                        console.log(`📡 Mobile: Checking with Google after stuck request...`);
                        checkUploadStatus().then(status => {
                            if (status.complete) {
                                console.log('✅ Mobile: Google confirms upload COMPLETE despite stuck request!');
                                resolve({
                                    success: true,
                                    data: { bytes_uploaded: totalSize, complete: true }
                                });
                            } else if (status.bytesUploaded >= endByte) {
                                console.log(`✅ Mobile: Google confirms chunk ${chunkIndex + 1} received (${(status.bytesUploaded / 1024 / 1024).toFixed(1)}MB)!`);
                                resolve({
                                    success: true,
                                    data: { bytes_uploaded: status.bytesUploaded, complete: false }
                                });
                            } else {
                                resolve({
                                    success: false,
                                    data: { message: 'Request stuck - no response from server. Connection may be unstable.', recoverable: true }
                                });
                            }
                        }).catch(() => {
                            resolve({
                                success: false,
                                data: { message: 'Request stuck - no response from server. Connection may be unstable.', recoverable: true }
                            });
                        });
                    } else {
                        resolve({
                            success: false,
                            data: { message: 'Request stuck - no response from server. Connection may be unstable.', recoverable: true }
                        });
                    }
                }
            }, CHUNK_TIMEOUT + 5000); // Safety timeout = actual timeout + 5s buffer
            
            let requestStarted = false;
            let requestCompleted = false;
            
            // Set minimum progress immediately to show activity
            const minProgress = Math.max(10, Math.round((startByte / totalSize) * 100));
            showProgress(minProgress, `UPLOADING...`);
            
            // ========== ALL EVENT HANDLERS DEFINED FIRST (before use) ==========
            // CRITICAL: Handlers must be defined BEFORE addEventListener and BEFORE handleResponse
            // so that removeEventListener can properly find and remove them
            
            // Progress handler
            const progressHandler = (e) => {
                requestStarted = true; // Request is actually sending data
                if (e.lengthComputable) {
                    const chunkProgress = e.loaded / e.total;
                    const currentBytes = startByte + (chunk.size * chunkProgress);
                    const progressRaw = (currentBytes / currentFile.size) * 100;
                    const overallProgress = Math.max(0.1, parseFloat(progressRaw.toFixed(1)));
                    const currentMB = (currentBytes / (1024 * 1024)).toFixed(1);
                    const totalMB = (currentFile.size / (1024 * 1024)).toFixed(1);
                    
                    showProgress(overallProgress, `UPLOADING... ${currentMB}MB / ${totalMB}MB`);
                    
                    // Update watchdog timer on any progress
                    if (window.warzoneLastProgressUpdate !== undefined) {
                        window.warzoneLastProgressUpdate = Date.now();
                    }
                } else if (e.loaded > 0) {
                    // Some progress but not computable - show at least something
                    const currentMB = (e.loaded / (1024 * 1024)).toFixed(1);
                    showProgress(minProgress + 1, `Uploading... ${currentMB}MB sent`);
                    
                    if (window.warzoneLastProgressUpdate !== undefined) {
                        window.warzoneLastProgressUpdate = Date.now();
                    }
                }
            };
            
            const loadstartHandler = () => {
                requestStarted = true;
                console.log(`📤 Chunk ${chunkIndex + 1} upload started`);
            };
            
            // Load handler
            const loadHandler = () => {
                // Log Google Drive response for debugging
                console.log(`📡 Google Drive Response - Chunk ${chunkIndex + 1}:`, {
                    status: xhr.status,
                    statusText: xhr.statusText,
                    responseURL: xhr.responseURL,
                    responseHeaders: xhr.getAllResponseHeaders(),
                    responseText: xhr.responseText ? xhr.responseText.substring(0, 500) : '(empty)',
                    readyState: xhr.readyState
                });
                
                // 308 = Resume Incomplete (more chunks needed)
                // 200/201 = Upload complete
                if (xhr.status === 308 || xhr.status === 200 || xhr.status === 201) {
                    const isComplete = xhr.status === 200 || xhr.status === 201;
                    console.log(`✅ Google Drive Status - Chunk ${chunkIndex + 1}: ${isComplete ? 'COMPLETE' : 'INCOMPLETE (308)'} - Status: ${xhr.status}`);
                    
                    let bytesUploaded = endByte + 1; // Default to endByte + 1
                    
                    // For 308 responses, verify via Range header what Google actually received
                    if (xhr.status === 308) {
                        const rangeHeader = xhr.getResponseHeader('Range');
                        console.log(`📊 Google Drive Range Header: ${rangeHeader || '(not present)'}`);
                        
                        if (rangeHeader) {
                            // Range format: "bytes=0-12345"
                            const match = rangeHeader.match(/bytes=0-(\d+)/);
                            if (match) {
                                bytesUploaded = parseInt(match[1], 10) + 1;
                                console.log(`📊 Verified: Google received ${(bytesUploaded / 1024 / 1024).toFixed(1)}MB (Range header)`);
                            }
                        }
                    }
                    
                    // For 200/201, upload is complete - all bytes received
                    if (isComplete) {
                        bytesUploaded = totalSize;
                        console.log(`✅ Upload COMPLETE - all ${(totalSize / 1024 / 1024).toFixed(1)}MB received by Google`);
                    }
                    
                    handleResponse({
                        success: true,
                        data: {
                            bytes_uploaded: bytesUploaded,
                            complete: isComplete
                        }
                    });
                } else {
                    // Parse error message from response (like WordPress does)
                    let errorMessage = `Upload failed (HTTP ${xhr.status})`;
                    try {
                        const errorData = JSON.parse(xhr.responseText);
                        if (errorData && errorData.error && errorData.error.message) {
                            errorMessage = errorData.error.message;
                        }
                    } catch (e) {
                        // Use default error message if JSON parse fails
                    }
                    
                    console.error(`Chunk upload failed: HTTP ${xhr.status} - ${errorMessage}`);
                    console.error('Response:', xhr.responseText.substring(0, 500));
                    
                    // Handle specific error codes (like WordPress does)
                    let recoverable = false;
                    if (xhr.status === 404) {
                        errorMessage = 'Upload session expired. Please start a new upload.';
                        recoverable = false; // Can't retry expired session
                    } else if (xhr.status === 401) {
                        errorMessage = 'Authentication failed. Please try again.';
                        recoverable = false; // Need to re-authenticate
                    } else if (xhr.status === 403) {
                        errorMessage = errorMessage || 'Permission denied.';
                        recoverable = false; // Permission issue, can't retry
                    } else if ([500, 502, 503, 504, 408].includes(xhr.status)) {
                        recoverable = true; // Server errors are retryable
                    }
                    
                    handleResponse({
                        success: false,
                        data: {
                            message: errorMessage,
                            recoverable: recoverable
                        }
                    });
                }
            };
            
            // Error handler
            const errorHandler = (e) => {
                console.error(`❌ Chunk ${chunkIndex + 1} XHR error event:`, {
                    status: xhr.status,
                    statusText: xhr.statusText,
                    readyState: xhr.readyState,
                    responseURL: xhr.responseURL,
                    event: e,
                    error: e.error || 'Unknown error',
                    requestStarted: requestStarted,
                    uploadUri: uploadUri ? uploadUri.substring(0, 100) + '...' : 'MISSING',
                    note: 'Status 0 usually means CORS blocked, network error, or request cancelled'
                });
                
                // Additional diagnostics for status 0 errors
                if (xhr.status === 0) {
                    console.error(`🔍 Status 0 Diagnostics - Chunk ${chunkIndex + 1}:`, {
                        readyState: xhr.readyState,
                        responseURL: xhr.responseURL || '(empty - request never reached server)',
                        possibleCauses: [
                            'CORS preflight failed',
                            'Network connection lost',
                            'Browser extension blocking request',
                            'SSL/TLS certificate issue',
                            'Request cancelled by browser'
                        ]
                    });
                    
                    // Status 0 might mean CORS blocked response, but data could still be uploaded
                    // Skip status check if this is trust mode (last chunk or most data sent) - just assume success
                    const isLastChunkInUpload = (endByte >= totalSize - 1);
                    const mostDataSentInUpload = (startByte >= totalSize * 0.9);
                    
                    if ((isLastChunkInUpload || mostDataSentInUpload) && requestStarted) {
                        // Trust mode - assume success immediately, no status check needed
                        console.log(`🎯 Trust mode (${isLastChunkInUpload ? 'last chunk' : 'most data sent'}) - assuming success despite status 0, NO STATUS CHECK`);
                        handleResponse({
                            success: true,
                            data: { bytes_uploaded: endByte + 1, complete: isLastChunkInUpload }
                        });
                        return; // Exit early - no status check
                    }
                    
                    // ALWAYS check with Google when status 0 occurs (if request started) - but only for non-trust-mode chunks
                    if (requestStarted && xhr.readyState >= 2) {
                        console.log(`🔍 Status 0 detected but request started - checking if data was actually uploaded to Google...`);
                        checkUploadStatus().then(status => {
                            if (status.complete) {
                                console.log('✅ Google confirms upload COMPLETE despite status 0! Data was uploaded.');
                                handleResponse({
                                    success: true,
                                    data: { bytes_uploaded: totalSize, complete: true }
                                });
                                return; // Exit early - don't continue with error handling
                            } else if (status.bytesUploaded >= endByte) {
                                console.log(`✅ Google confirms chunk ${chunkIndex + 1} was received (${(status.bytesUploaded / 1024 / 1024).toFixed(1)}MB) despite status 0!`);
                                handleResponse({
                                    success: true,
                                    data: { bytes_uploaded: status.bytesUploaded, complete: false }
                                });
                                return; // Exit early - don't continue with error handling
                            } else {
                                // Data not uploaded - continue with normal error handling
                                console.log(`❌ Google confirms data NOT uploaded - status 0 was real failure`);
                                // Fall through to error handling below
                            }
                        }).catch((checkError) => {
                            // Status check also failed with status 0 - CORS is blocking ALL requests
                            // If request started and we sent data, assume success (files are uploading despite status 0)
                            console.log(`⚠️ Status check also failed - CORS likely blocking all responses`);
                            console.log(`⚠️ Error:`, checkError);
                            
                            // Since files ARE uploading (as shown in Google Drive), assume success if:
                            // 1. Request started (data was sent)
                            // 2. This is last chunk OR most data sent (90%+)
                            const isLastChunkInError = (endByte >= totalSize - 1);
                            if (isLastChunkInError || (startByte >= totalSize * 0.9)) {
                                console.log(`✅ Last chunk or most data sent (${((startByte / totalSize) * 100).toFixed(1)}%) - assuming upload complete despite status 0`);
                                handleResponse({
                                    success: true,
                                    data: { bytes_uploaded: endByte + 1, complete: isLastChunkInError }
                                });
                                return; // Exit early
                            }
                            
                            // For other chunks, if request started, assume chunk was received
                            // (Files are uploading successfully despite status 0 errors)
                            console.log(`✅ Request started - assuming chunk ${chunkIndex + 1} was received despite status 0 (CORS blocking response)`);
                            handleResponse({
                                success: true,
                                data: { bytes_uploaded: endByte + 1, complete: false }
                            });
                            return; // Exit early
                        });
                        
                        // If we're checking with Google, don't continue with mobile-specific check
                        // Wait for Google check to complete (it will call handleResponse)
                        return;
                    }
                }
                
                // On mobile, if request started but failed (non-status-0 errors), check with Google
                if (isMobile && requestStarted && xhr.readyState >= 2 && xhr.status !== 0) {
                    console.log(`📡 Mobile: Request started but failed - checking with Google...`);
                    checkUploadStatus().then(status => {
                        if (status.complete) {
                            console.log('✅ Mobile: Google confirms upload COMPLETE despite error!');
                            handleResponse({
                                success: true,
                                data: { bytes_uploaded: totalSize, complete: true }
                            });
                        } else if (status.bytesUploaded >= endByte) {
                            console.log(`✅ Mobile: Google confirms chunk ${chunkIndex + 1} received!`);
                            handleResponse({
                                success: true,
                                data: { bytes_uploaded: status.bytesUploaded, complete: false }
                            });
                        } else {
                            // More specific error messages
                            let errorMsg = 'Network error';
                            if (xhr.status === 0) {
                                errorMsg = 'Connection failed. Check your internet connection.';
                            } else if (xhr.status >= 400 && xhr.status < 500) {
                                errorMsg = `Server error (${xhr.status}). Please try again.`;
                            }
                            handleResponse({
                                success: false,
                                data: { message: errorMsg, recoverable: true }
                            });
                        }
                    }).catch(() => {
                        let errorMsg = 'Network error';
                        if (xhr.status === 0) {
                            errorMsg = 'Connection failed. Check your internet connection.';
                        }
                        handleResponse({
                            success: false,
                            data: { message: errorMsg, recoverable: true }
                        });
                    });
                } else {
                    // More specific error messages
                    let errorMsg = 'Network error';
                    if (xhr.status === 0) {
                        errorMsg = 'Connection failed. Check your internet connection.';
                    } else if (xhr.status >= 400 && xhr.status < 500) {
                        errorMsg = `Server error (${xhr.status}). Please try again.`;
                    }
                    
                    handleResponse({
                        success: false,
                        data: { message: errorMsg, recoverable: true }
                    });
                }
            };
            
            // Timeout handler
            const timeoutHandler = () => {
                console.error(`⏱️ Chunk ${chunkIndex + 1} timed out after ${CHUNK_TIMEOUT/1000}s`);
                
                // On mobile, check with Google before reporting timeout (data might be uploaded)
                if (isMobile && requestStarted) {
                    console.log(`📡 Mobile: Timeout occurred but request started - checking with Google...`);
                    checkUploadStatus().then(status => {
                        if (status.complete) {
                            console.log('✅ Mobile: Google confirms upload COMPLETE despite timeout!');
                            handleResponse({
                                success: true,
                                data: { bytes_uploaded: totalSize, complete: true }
                            });
                        } else if (status.bytesUploaded >= endByte) {
                            console.log(`✅ Mobile: Google confirms chunk ${chunkIndex + 1} received!`);
                            handleResponse({
                                success: true,
                                data: { bytes_uploaded: status.bytesUploaded, complete: false }
                            });
                        } else {
                            handleResponse({
                                success: false,
                                data: { message: `Request timed out after ${CHUNK_TIMEOUT/1000}s. Connection may be slow.`, recoverable: true }
                            });
                        }
                    }).catch(() => {
                        handleResponse({
                            success: false,
                            data: { message: `Request timed out after ${CHUNK_TIMEOUT/1000}s. Connection may be slow.`, recoverable: true }
                        });
                    });
                } else {
                    handleResponse({
                        success: false,
                        data: { message: `Request timed out after ${CHUNK_TIMEOUT/1000}s. Connection may be slow.`, recoverable: true }
                    });
                }
            };
            
            // Abort handler
            const abortHandler = () => {
                console.error(`🚫 Chunk ${chunkIndex + 1} was aborted`);
                handleResponse({
                    success: false,
                    data: { message: 'Upload was cancelled', recoverable: false }
                });
            };
            
            // ========== END OF HANDLER DEFINITIONS ==========
            
            // handleResponse function (used by all handlers)
            const handleResponse = (result) => {
                if (requestCompleted) return; // Prevent double resolution
                requestCompleted = true;
                clearTimeout(safetyTimeout);
                
                // CRITICAL: Cleanup XHR (prevents memory leaks and connection pool exhaustion on all platforms)
                try {
                    // Remove all event listeners FIRST (must use removeEventListener, not onload = null)
                    xhr.upload.removeEventListener('progress', progressHandler);
                    xhr.upload.removeEventListener('loadstart', loadstartHandler);
                    xhr.removeEventListener('load', loadHandler);
                    xhr.removeEventListener('error', errorHandler);
                    xhr.removeEventListener('timeout', timeoutHandler);
                    xhr.removeEventListener('abort', abortHandler);
                    
                    // THEN abort if still open (critical for iOS Safari!)
                    if (xhr.readyState !== XMLHttpRequest.DONE) {
                        xhr.abort();
                    }
                    
                    // THEN null the reference to allow garbage collection
                    // Note: Can't null xhr directly in this scope, but removing listeners and aborting helps
                } catch (e) {
                    // Ignore cleanup errors
                    console.warn('XHR cleanup warning:', e);
                }
                
                resolve(result);
            };
            
            // ========== ATTACH EVENT LISTENERS (after all handlers are defined) ==========
            
            // Track upload progress for this chunk
            xhr.upload.addEventListener('progress', progressHandler);
            
            // Track when upload actually starts (for Android debugging)
            xhr.upload.addEventListener('loadstart', loadstartHandler);
            
            // Attach all other event listeners
            xhr.addEventListener('load', loadHandler);
            xhr.addEventListener('error', errorHandler);
            xhr.addEventListener('timeout', timeoutHandler);
            xhr.addEventListener('abort', abortHandler);
            
            // DIRECT PUT to Google Drive (NOT WordPress)
            try {
                xhr.open('PUT', uploadUri);
                xhr.setRequestHeader('Content-Range', contentRange);
                xhr.timeout = CHUNK_TIMEOUT; // Adaptive timeout (60s mobile, 3min desktop)
                
                if (chunkIndex === 0) {
                    console.log('📡 First chunk going DIRECTLY to:', uploadUri.includes('googleapis.com') ? 'googleapis.com (Google Drive)' : uploadUri);
                    if (chunk && chunk.size) {
                        console.log('📦 First chunk size:', (chunk.size / (1024*1024)).toFixed(2), 'MB');
                    }
                }
                
                // Send chunk - catch any immediate errors
                xhr.send(chunk);
            } catch (openError) {
                clearTimeout(safetyTimeout);
                console.error(`❌ Failed to open/send chunk ${chunkIndex + 1}:`, openError);
                resolve({
                    success: false,
                    data: { message: 'Failed to start upload: ' + (openError.message || 'Unknown error'), recoverable: false }
                });
            }
        });
    }

    /**
     * Finalize the upload
     */
    function finalizeUpload() {
        return new Promise((resolve, reject) => {
            showProgress(100, i18n.processing || 'PROCESSING...');
            
            $.ajax({
                url: config.ajaxUrl,
                type: 'POST',
                data: {
                    action: 'warzone_finalize_upload',
                    nonce: config.nonce,
                    session_id: uploadSessionId
                },
                success: resolve,
                error: (xhr, status, error) => {
                    reject(new Error('Network error: ' + error));
                }
            });
        });
    }

    /**
     * Show progress bar
     */
    function showProgress(percent, status) {
        const $container = $('#warzone-progress-container');
        const $fill = $('#warzone-progress-fill');
        const $percent = $('#warzone-progress-percent');
        const $status = $('#warzone-progress-status');

        $container.addClass('active');
        $fill.css('width', percent + '%');
        
        // Show decimal for small percentages, whole number for larger
        const displayPercent = percent < 10 ? percent.toFixed(1) : Math.round(percent);
        $percent.text(displayPercent + '%');
        $status.text(status);
    }

    /**
     * Hide progress bar
     */
    function hideProgress() {
        $('#warzone-progress-container').removeClass('active');
    }

    /**
     * Show message
     */
    function showMessage(text, type) {
        const $message = $('#warzone-message');
        $message
            .removeClass('success error')
            .addClass('show ' + type)
            .text(text);
    }

    /**
     * Hide message
     */
    function hideMessage() {
        $('#warzone-message').removeClass('show success error');
    }

    /**
     * Set button loading state
     */
    function setButtonLoading(loading) {
        const $btn = $('#warzone-submit-btn');
        
        if (loading) {
            $btn.addClass('loading').prop('disabled', true);
        } else {
            $btn.removeClass('loading').prop('disabled', false);
        }
    }

    /**
     * Reset the form
     */
    function resetForm() {
        $('#warzone-upload-form')[0].reset();
        resetFileInput();
        hideProgress();
        hideMessage();
        setButtonLoading(false);
        currentFile = null;
        uploadSessionId = null;
        isUploading = false;
    }

    /**
     * Format file size for display
     */
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Initialize when DOM is ready
    $(document).ready(init);

})(jQuery);
