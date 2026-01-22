<?php
/**
 * Google Drive Uploader Class
 * Handles authentication and resumable uploads to Google Drive API v3
 */

if (!defined('ABSPATH')) {
    exit;
}

class Warzone_Google_Drive_Uploader {
    
    private $service_account_path;
    private $access_token;
    private $token_expiry;
    private $folder_id;
    
    public function __construct() {
        $this->service_account_path = WARZONE_UPLOADER_PATH . 'service-account.json';
        // IMPORTANT: This MUST be a folder inside a SHARED DRIVE (Team Drive), NOT a regular shared folder
        // The Service Account email must be added as a member of the Shared Drive with "Content Manager" access
        $this->folder_id = get_option('warzone_drive_folder_id', '0ANObQyCMAhN8Uk9PVA');
    }
    
    /**
     * Get or refresh access token using service account
     */
    private function get_access_token() {
        // Check if we have a valid cached token
        if ($this->access_token && $this->token_expiry && time() < $this->token_expiry) {
            return $this->access_token;
        }
        
        // Check transient cache
        $cached = get_transient('warzone_drive_token');
        if ($cached) {
            $this->access_token = $cached['token'];
            $this->token_expiry = $cached['expiry'];
            return $this->access_token;
        }
        
        // Load service account credentials
        if (!file_exists($this->service_account_path)) {
            return new WP_Error('no_credentials', 'Service account file not found.');
        }
        
        $credentials = json_decode(file_get_contents($this->service_account_path), true);
        
        if (!$credentials || !isset($credentials['client_email']) || !isset($credentials['private_key'])) {
            return new WP_Error('invalid_credentials', 'Invalid service account credentials.');
        }
        
        // Create JWT
        $jwt = $this->create_jwt($credentials);
        
        if (is_wp_error($jwt)) {
            return $jwt;
        }
        
        // Exchange JWT for access token
        $response = wp_remote_post('https://oauth2.googleapis.com/token', [
            'body' => [
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion' => $jwt
            ],
            'timeout' => 30
        ]);
        
        if (is_wp_error($response)) {
            return $response;
        }
        
        $body = json_decode(wp_remote_retrieve_body($response), true);
        
        if (isset($body['error'])) {
            return new WP_Error('token_error', $body['error_description'] ?? 'Failed to get access token.');
        }
        
        $this->access_token = $body['access_token'];
        $this->token_expiry = time() + ($body['expires_in'] - 60); // 60 second buffer
        
        // Cache the token
        set_transient('warzone_drive_token', [
            'token' => $this->access_token,
            'expiry' => $this->token_expiry
        ], $body['expires_in'] - 120);
        
        return $this->access_token;
    }
    
    /**
     * Create JWT for service account authentication
     */
    private function create_jwt($credentials) {
        $header = [
            'alg' => 'RS256',
            'typ' => 'JWT'
        ];
        
        $now = time();
        $claims = [
            'iss' => $credentials['client_email'],
            'scope' => 'https://www.googleapis.com/auth/drive.file',
            'aud' => 'https://oauth2.googleapis.com/token',
            'iat' => $now,
            'exp' => $now + 3600
        ];
        
        $header_encoded = $this->base64url_encode(json_encode($header));
        $claims_encoded = $this->base64url_encode(json_encode($claims));
        
        $signature_input = $header_encoded . '.' . $claims_encoded;
        
        // Sign with private key
        $private_key = openssl_pkey_get_private($credentials['private_key']);
        
        if (!$private_key) {
            return new WP_Error('key_error', 'Failed to load private key.');
        }
        
        $signature = '';
        $success = openssl_sign($signature_input, $signature, $private_key, OPENSSL_ALGO_SHA256);
        
        if (!$success) {
            return new WP_Error('sign_error', 'Failed to sign JWT.');
        }
        
        return $signature_input . '.' . $this->base64url_encode($signature);
    }
    
    /**
     * Base64 URL encode
     */
    private function base64url_encode($data) {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }
    
    /**
     * Initialize a resumable upload session
     * Forces Shared Drive support to prevent "Service Accounts do not have storage quota" error
     */
    public function init_resumable_upload($filename, $mime_type, $file_size) {
        $accessToken = $this->get_access_token();
        
        if (is_wp_error($accessToken)) {
            return $accessToken;
        }
        
        // 1. Force Shared Drive Support in the URL
        $url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';
        
        // 2. Explicitly set the Parent Folder ID in the metadata
        // This prevents Google from trying to save to the Service Account's root (0GB quota)
        $body = [
            'name' => $filename,
            'mimeType' => $mime_type,
            'parents' => [$this->folder_id]
        ];
        
        $response = wp_remote_post($url, [
            'headers' => [
                'Authorization' => 'Bearer ' . $accessToken,
                'Content-Type'  => 'application/json',
                'X-Upload-Content-Type' => $mime_type,
                'X-Upload-Content-Length' => $file_size
            ],
            'body' => json_encode($body),
            'timeout' => 30
        ]);
        
        if (is_wp_error($response)) {
            return new WP_Error('init_failed', 'Failed to initiate upload: ' . $response->get_error_message());
        }
        
        $headers = wp_remote_retrieve_headers($response);
        
        if (!isset($headers['location'])) {
            $body_response = wp_remote_retrieve_body($response);
            return new WP_Error('no_uri', 'Failed to get upload session URL. Response: ' . $body_response);
        }
        
        return [
            'upload_uri' => $headers['location'],
            'status' => 'initialized'
        ];
    }
    
    /**
     * Upload a chunk of data to the resumable upload URI
     * Uses cURL directly for reliable large file handling
     */
    public function upload_chunk($upload_uri, $chunk_data, $start_byte, $end_byte, $total_size) {
        $token = $this->get_access_token();
        
        if (is_wp_error($token)) {
            return $token;
        }
        
        $content_range = sprintf('bytes %d-%d/%d', $start_byte, $end_byte, $total_size);
        $chunk_size = strlen($chunk_data);
        
        // Use cURL directly for better control over large uploads
        $ch = curl_init();
        
        curl_setopt_array($ch, [
            CURLOPT_URL => $upload_uri,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => 'PUT',
            CURLOPT_POSTFIELDS => $chunk_data,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $token,
                'Content-Length: ' . $chunk_size,
                'Content-Range: ' . $content_range,
                'Content-Type: application/octet-stream'
            ],
            CURLOPT_TIMEOUT => 60, // 60 seconds timeout per chunk
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_HEADER => true,
            CURLOPT_TCP_KEEPALIVE => 1,
            CURLOPT_TCP_KEEPIDLE => 30,
            CURLOPT_TCP_KEEPINTVL => 15,
            CURLOPT_LOW_SPEED_LIMIT => 1024, // Abort if less than 1KB/sec
            CURLOPT_LOW_SPEED_TIME => 30, // for 30 seconds
        ]);
        
        $response = curl_exec($ch);
        $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curl_error = curl_error($ch);
        $header_size = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);
        
        // Check for cURL errors
        if ($response === false || !empty($curl_error)) {
            return new WP_Error('curl_error', 'Upload failed: ' . $curl_error);
        }
        
        // Parse response
        $headers = substr($response, 0, $header_size);
        $body = substr($response, $header_size);
        
        // 308 = Resume Incomplete (more chunks needed)
        if ($http_code === 308) {
            // Extract Range header to get bytes uploaded
            preg_match('/range:\s*bytes=0-(\d+)/i', $headers, $matches);
            $uploaded_bytes = isset($matches[1]) ? intval($matches[1]) + 1 : $end_byte + 1;
            
            return [
                'status' => 'incomplete',
                'bytes_uploaded' => $uploaded_bytes
            ];
        }
        
        // 200/201 = Upload complete
        if ($http_code === 200 || $http_code === 201) {
            $body_data = json_decode($body, true);
            
            return [
                'status' => 'complete',
                'file_id' => $body_data['id'] ?? null,
                'file_name' => $body_data['name'] ?? null
            ];
        }
        
        // Handle errors
        $error_data = json_decode($body, true);
        $error_message = $error_data['error']['message'] ?? "Upload failed (HTTP $http_code)";
        
        // Log error for debugging
        error_log("Warzone Uploader - Chunk upload failed: HTTP $http_code - $error_message");
        error_log("Warzone Uploader - Response body: " . substr($body, 0, 500));
        
        // Check if retryable
        if (in_array($http_code, [500, 502, 503, 504, 408])) {
            return new WP_Error('chunk_failed', $error_message . ' (retryable)', ['retryable' => true]);
        }
        
        // Handle 404 - upload URI expired
        if ($http_code === 404) {
            return new WP_Error('upload_expired', 'Upload session expired. Please start a new upload.');
        }
        
        // Handle 401 - token expired
        if ($http_code === 401) {
            delete_transient('warzone_drive_token');
            $this->access_token = null;
            $this->token_expiry = null;
            return new WP_Error('auth_failed', 'Authentication failed. Please try again.');
        }
        
        // Handle 403 - permission denied
        if ($http_code === 403) {
            return new WP_Error('permission_denied', $error_message);
        }
        
        return new WP_Error('chunk_failed', $error_message);
    }
    
    /**
     * Get upload status/progress
     */
    public function get_upload_status($upload_uri) {
        $token = $this->get_access_token();
        
        if (is_wp_error($token)) {
            return $token;
        }
        
        $response = wp_remote_request($upload_uri, [
            'method' => 'PUT',
            'headers' => [
                'Authorization' => 'Bearer ' . $token,
                'Content-Length' => 0,
                'Content-Range' => 'bytes */*'
            ],
            'timeout' => 30
        ]);
        
        if (is_wp_error($response)) {
            return $response;
        }
        
        $status_code = wp_remote_retrieve_response_code($response);
        
        if ($status_code === 308) {
            $range = wp_remote_retrieve_header($response, 'range');
            preg_match('/bytes=0-(\d+)/', $range, $matches);
            return [
                'status' => 'incomplete',
                'bytes_uploaded' => isset($matches[1]) ? intval($matches[1]) + 1 : 0
            ];
        }
        
        if ($status_code === 200 || $status_code === 201) {
            $body = json_decode(wp_remote_retrieve_body($response), true);
            return [
                'status' => 'complete',
                'file_id' => $body['id'] ?? null
            ];
        }
        
        return new WP_Error('status_error', 'Failed to get upload status.');
    }
    
    /**
     * Resume an interrupted upload
     */
    public function resume_upload($upload_uri, $file_path, $total_size) {
        // Get current upload status
        $status = $this->get_upload_status($upload_uri);
        
        if (is_wp_error($status)) {
            return $status;
        }
        
        if ($status['status'] === 'complete') {
            return $status;
        }
        
        $bytes_uploaded = $status['bytes_uploaded'];
        
        // Open file and seek to resume position
        $handle = fopen($file_path, 'rb');
        if (!$handle) {
            return new WP_Error('file_error', 'Could not open file for resume.');
        }
        
        fseek($handle, $bytes_uploaded);
        
        // Continue uploading chunks
        $chunk_size = WARZONE_UPLOADER_CHUNK_SIZE;
        
        while (!feof($handle)) {
            $chunk = fread($handle, $chunk_size);
            $chunk_length = strlen($chunk);
            
            if ($chunk_length === 0) {
                break;
            }
            
            $start = $bytes_uploaded;
            $end = $bytes_uploaded + $chunk_length - 1;
            
            $result = $this->upload_chunk($upload_uri, $chunk, $start, $end, $total_size);
            
            if (is_wp_error($result)) {
                fclose($handle);
                return $result;
            }
            
            if ($result['status'] === 'complete') {
                fclose($handle);
                return $result;
            }
            
            $bytes_uploaded = $result['bytes_uploaded'];
        }
        
        fclose($handle);
        
        return new WP_Error('incomplete', 'Upload did not complete as expected.');
    }
}
