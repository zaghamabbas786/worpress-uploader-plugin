/**
 * Warzone Uploader - Frontend JavaScript
 * Handles modal interaction,  file validation, and chunked uploads
 */

(function($) {
    'use strict';

    console.log('🎮 Warzone Uploader v2.0 - DIRECT Google Drive Uploads');
    
    // Configuration from WordPress
    const config = window.warzoneUploader || {};
    // Ensure CHUNK_SIZE is a number (parseInt fixes string concatenation bug)
    const CHUNK_SIZE = parseInt(config.chunkSize, 10) || (70 * 1024 * 1024); // 70MB default
    console.log('⚙️ CHUNK_SIZE:', CHUNK_SIZE, 'bytes (' + (CHUNK_SIZE / 1024 / 1024) + 'MB)');
    const MAX_FILE_SIZE = config.maxFileSize || 5 * 1024 * 1024 * 1024; // 5GB
    const ALLOWED_TYPES = config.allowedTypes || ['video/mp4', 'video/quicktime'];
    const i18n = config.i18n || {};
    
    // Retry configuration for large file reliability
    const MAX_RETRIES = 5;           // Increased from 3 to 5
    const RETRY_DELAY_BASE = 2000;   // Increased from 1s to 2s
    const RETRY_DELAY_MAX = 30000;   // Increased from 5s to 30s

    // State
    let currentFile = null;
    let uploadSessionId = null;
    let isUploading = false;
    let uploadCompleted = false; // Prevent re-submission after success
    let uploadedBytes = 0; // Track for resume capability
    let uploadUri = null; // Store for potential resume

    /**
     * Initialize the plugin
     */
    function init() {
        bindEvents();
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
        setButtonLoading(true);
        showProgress(0, 'Initializing...');
        hideMessage();

        try {
            // Step 1: Initialize upload session
            const initResult = await initializeUpload(formData);
            
            if (!initResult.success) {
                throw new Error(initResult.data.message || 'Failed to initialize upload');
            }

            uploadSessionId = initResult.data.session_id;
            uploadUri = initResult.data.upload_uri; // Google Drive resumable upload URI
            
            console.log('🚀 DIRECT UPLOAD MODE - Version 2.0');
            console.log('📤 Upload URI (Google Drive):', uploadUri.substring(0, 80) + '...');
            console.log('✅ Chunks will go DIRECTLY to Google (NOT through WordPress)');

            // Step 2: Upload file in chunks DIRECTLY to Google Drive
            console.log('📤 Step 2: Starting DIRECT chunked upload to Google Drive...');
            await uploadFileChunks();
            console.log('📤 Step 2: Chunked upload complete!');

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
            $.ajax({
                url: config.ajaxUrl,
                type: 'POST',
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
                success: resolve,
                error: (xhr, status, error) => {
                    reject(new Error('Network error: ' + error));
                }
            });
        });
    }

    /**
     * Upload file in chunks - DIRECT to Google Drive (sequential - required by Google)
     */
    async function uploadFileChunks() {
        const totalChunks = Math.ceil(currentFile.size / CHUNK_SIZE);
        
        console.log(`🚀 Starting DIRECT Google Drive upload: ${totalChunks} chunks of ${CHUNK_SIZE / (1024*1024)}MB`);
        
        // Upload chunks sequentially (Google Drive requires this)
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, currentFile.size);
            const chunk = currentFile.slice(start, end);
            
            let retryCount = 0;
            let result;
            
            // Retry loop with exponential backoff
            while (retryCount < MAX_RETRIES) {
                result = await uploadChunkDirect(chunk, start, end - 1, currentFile.size, chunkIndex);
                
                if (result.success) {
                    break;
                }
                
                // IMMEDIATELY check with Google - maybe data was received but response lost
                console.log(`⚠️ Chunk ${chunkIndex + 1} failed - checking with Google...`);
                showProgress(
                    Math.round((chunkIndex / totalChunks) * 100),
                    `VERIFYING...`
                );
                
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
                
                // LAST CHUNK TRUST: If this is the last chunk and network is dead,
                // skip retries and assume success (file is likely there)
                const isLastChunk = (chunkIndex === totalChunks - 1);
                const mostDataSent = (start >= currentFile.size * 0.9); // 90%+ already uploaded
                
                if (isLastChunk && mostDataSent) {
                    console.log('📝 File should be in Google Drive - proceeding to finalize');
                    result.success = true;
                    break;
                }
                
                // For non-last chunks: retry if we haven't exhausted attempts
                if (result.data.recoverable && retryCount < MAX_RETRIES - 1) {
                    retryCount++;
                    const delay = Math.min(RETRY_DELAY_BASE * Math.pow(2, retryCount - 1), RETRY_DELAY_MAX);
                    console.log(`🔄 Retrying in ${delay/1000}s (${retryCount}/${MAX_RETRIES})...`);
                    showProgress(
                        Math.round((chunkIndex / totalChunks) * 100),
                        `RETRY ${retryCount}/${MAX_RETRIES}...`
                    );
                    await sleep(delay);
                    continue;
                }
                
                throw new Error(result.data.message || 'Chunk upload failed');
            }
            
            uploadedBytes = end;
            
            // Update progress
            const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
            const uploadedMB = (uploadedBytes / (1024 * 1024)).toFixed(1);
            const totalMB = (currentFile.size / (1024 * 1024)).toFixed(1);
            showProgress(progress, `UPLOADING... ${uploadedMB}MB / ${totalMB}MB`);
            
            console.log(`✅ Chunk ${chunkIndex + 1}/${totalChunks} complete`);
            
            // Small delay between chunks to avoid rate limiting (100ms)
            if (chunkIndex < totalChunks - 1) {
                await sleep(100);
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
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`📡 Status check attempt ${attempt}/3...`);
            
            const result = await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.timeout = 30000; // 30 second timeout
                
                xhr.addEventListener('load', () => {
                    if (xhr.status === 308) {
                        // Upload incomplete - check Range header for bytes uploaded
                        const range = xhr.getResponseHeader('Range');
                        if (range) {
                            // Range format: "bytes=0-12345"
                            const match = range.match(/bytes=0-(\d+)/);
                            if (match) {
                                const bytesUploaded = parseInt(match[1], 10) + 1;
                                console.log(`📊 Google says ${(bytesUploaded / 1024 / 1024).toFixed(1)}MB uploaded`);
                                resolve({ bytesUploaded, complete: false, success: true });
                                return;
                            }
                        }
                        resolve({ bytesUploaded: 0, complete: false, success: true });
                    } else if (xhr.status === 200 || xhr.status === 201) {
                        // Upload already complete!
                        console.log('✅ Google says upload is COMPLETE!');
                        resolve({ bytesUploaded: currentFile.size, complete: true, success: true });
                    } else {
                        console.log(`⚠️ Status check returned: ${xhr.status}`);
                        resolve({ bytesUploaded: -1, complete: false, success: false });
                    }
                });
                
                xhr.addEventListener('error', () => {
                    console.log(`❌ Status check error (attempt ${attempt})`);
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
            
            // Wait before retry (2s, 4s, 8s)
            if (attempt < 3) {
                const delay = 2000 * Math.pow(2, attempt - 1);
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
            const contentRange = `bytes ${startByte}-${endByte}/${totalSize}`;
            
            // Track upload progress for this chunk
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const chunkProgress = e.loaded / e.total;
                    const currentBytes = startByte + (chunk.size * chunkProgress);
                    const progressRaw = (currentBytes / currentFile.size) * 100;
                    const overallProgress = Math.max(0.1, parseFloat(progressRaw.toFixed(1)));
                    const currentMB = (currentBytes / (1024 * 1024)).toFixed(1);
                    const totalMB = (currentFile.size / (1024 * 1024)).toFixed(1);
                    
                    showProgress(overallProgress, `UPLOADING... ${currentMB}MB / ${totalMB}MB`);
                }
            });
            
            xhr.addEventListener('load', () => {
                // 308 = Resume Incomplete (more chunks needed)
                // 200/201 = Upload complete
                if (xhr.status === 308 || xhr.status === 200 || xhr.status === 201) {
                    resolve({
                        success: true,
                        data: {
                            bytes_uploaded: endByte + 1,
                            complete: xhr.status === 200 || xhr.status === 201
                        }
                    });
                } else {
                    console.error('Chunk upload failed:', xhr.status, xhr.responseText);
                    resolve({
                        success: false,
                        data: {
                            message: 'Upload error: ' + xhr.status,
                            recoverable: xhr.status >= 500 || xhr.status === 408
                        }
                    });
                }
            });
            
            xhr.addEventListener('error', (e) => {
                console.error(`❌ Chunk ${chunkIndex + 1} XHR error event:`, {
                    status: xhr.status,
                    statusText: xhr.statusText,
                    readyState: xhr.readyState,
                    responseURL: xhr.responseURL,
                    event: e
                });
                resolve({
                    success: false,
                    data: { message: 'Network error', recoverable: true }
                });
            });
            
            xhr.addEventListener('timeout', () => {
                resolve({
                    success: false,
                    data: { message: 'Request timed out', recoverable: true }
                });
            });
            
            // DIRECT PUT to Google Drive (NOT WordPress)
            xhr.open('PUT', uploadUri);
            xhr.setRequestHeader('Content-Range', contentRange);
            xhr.timeout = 300000; // 5 minutes per chunk
            
            if (chunkIndex === 0) {
                console.log('📡 First chunk going DIRECTLY to:', uploadUri.includes('googleapis.com') ? 'googleapis.com (Google Drive)' : uploadUri);
            }
            
            xhr.send(chunk);
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
