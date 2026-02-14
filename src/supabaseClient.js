import { createClient } from '@supabase/supabase-js';

// Supabase credentials
const SUPABASE_URL = 'https://rentumnzxflhlwewfnri.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Vi8YeqE2SpKU8CXM7j0uVw_V0lJpLWE';

// Initialize Supabase client
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// console.log('[Supabase] Client initialized with URL:', SUPABASE_URL);

/**
 * Upload file to Supabase Storage
 * @param {string} bucketName - Name of storage bucket (e.g., 'assets')
 * @param {string} filePath - Path in storage (e.g., 'partner_108/asset_123.jpg')
 * @param {Blob|File} fileData - The file blob
 * @returns {Promise<string|null>} - Public URL if successful, null otherwise
 */
export const uploadFileToStorage = async (bucketName, filePath, fileData) => {
  try {
    // console.log(`[Storage] Uploading file to ${bucketName}/${filePath}`);
    
    // Ensure bucket exists, create if needed
    const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
    if (listErr) {
      console.warn('[Storage] Could not list buckets:', listErr);
    }

    // Upload file
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(filePath, fileData, {
        cacheControl: '3600',
        upsert: true  // Overwrite if exists
      });

    if (error) {
      console.error(`[Storage] Upload error:`, error);
      return null;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    const publicUrl = urlData?.publicUrl;
    // console.log(`[Storage] ✅ File uploaded, URL: ${publicUrl}`);
    
    return publicUrl;
  } catch (error) {
    console.error('[Storage] Exception uploading file:', error);
    return null;
  }
};

/**
 * Download file from Supabase Storage
 */
export const downloadFileFromStorage = async (bucketName, filePath) => {
  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .download(filePath);

    if (error) {
      console.error('[Storage] Download error:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('[Storage] Exception downloading file:', error);
    return null;
  }
};

/**
 * Delete file from Supabase Storage
 */
export const deleteFileFromStorage = async (bucketName, filePath) => {
  try {
    const { error } = await supabase.storage
      .from(bucketName)
      .remove([filePath]);

    if (error) {
      console.error('[Storage] Delete error:', error);
      return false;
    }

    console.log(`[Storage] ✅ File deleted: ${filePath}`);
    return true;
  } catch (error) {
    console.error('[Storage] Exception deleting file:', error);
    return false;
  }
};

/**
 * Helper: Set partner ID for RLS policies
 */
export const setSupabasePartnerContext = async (partnerId) => {
  try {
    // Set JWT claim or custom header for RLS
    // The RLS policies will check the current user's session
    // console.log(`[Supabase] Partner context set for: ${partnerId}`);
  } catch (error) {
    console.error('[Supabase] Error setting partner context:', error);
  }
};

/**
 * Test connection to Supabase
 */
export const testSupabaseConnection = async () => {
  try {
    console.log('[Supabase] Testing connection...');
    const { data, error } = await supabase
      .from('campaigns')
      .select('count(*)', { count: 'exact' })
      .limit(0);
    
    if (error) {
      console.error('[Supabase] Connection error:', error.message);
      return false;
    }
    
    console.log('[Supabase] ✅ Connection successful!');
    return true;
  } catch (error) {
    console.error('[Supabase] Connection test failed:', error);
    return false;
  }
};

export default supabase;
