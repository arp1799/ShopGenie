const crypto = require('crypto');
const { query } = require('../database/connection');

class AuthService {
  /**
   * Encrypt sensitive data
   * @param {string} text - Text to encrypt
   * @returns {string} - Encrypted text
   */
  encrypt(text) {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  /**
   * Decrypt sensitive data
   * @param {string} encryptedText - Encrypted text
   * @returns {string} - Decrypted text
   */
  decrypt(encryptedText) {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY, 'salt', 32);
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Save user's retailer credentials
   * @param {number} userId - User ID
   * @param {string} retailer - Retailer name (zepto, blinkit, instamart)
   * @param {string} loginId - User's email or phone number
   * @param {string} password - User's password (will be encrypted)
   * @param {string} loginType - 'email' or 'phone'
   * @returns {Promise<Object>} - Saved credentials object
   */
  async saveRetailerCredentials(userId, retailer, loginId, password, loginType = 'email') {
    try {
      const encryptedPassword = this.encrypt(password);
      
      // Check if credentials already exist
      const existing = await query(
        'SELECT * FROM retailer_credentials WHERE user_id = $1 AND retailer = $2',
        [userId, retailer]
      );

      if (existing.rows.length > 0) {
        // Update existing credentials
        const result = await query(
          `UPDATE retailer_credentials 
           SET login_id = $1, login_type = $2, encrypted_password = $3, updated_at = NOW()
           WHERE user_id = $4 AND retailer = $5
           RETURNING *`,
          [loginId, loginType, encryptedPassword, userId, retailer]
        );
        console.log(`🔐 [AUTH] Updated ${retailer} credentials for user ${userId} (${loginType}: ${loginId})`);
        return result.rows[0];
      } else {
        // Insert new credentials
        const result = await query(
          `INSERT INTO retailer_credentials (user_id, retailer, login_id, login_type, encrypted_password)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [userId, retailer, loginId, loginType, encryptedPassword]
        );
        console.log(`🔐 [AUTH] Saved ${retailer} credentials for user ${userId} (${loginType}: ${loginId})`);
        return result.rows[0];
      }
    } catch (error) {
      console.error(`❌ Error saving ${retailer} credentials:`, error);
      throw error;
    }
  }

  /**
   * Get user's retailer credentials
   * @param {number} userId - User ID
   * @param {string} retailer - Retailer name
   * @returns {Promise<Object|null>} - Credentials object or null
   */
  async getRetailerCredentials(userId, retailer) {
    try {
      const result = await query(
        'SELECT * FROM retailer_credentials WHERE user_id = $1 AND retailer = $2',
        [userId, retailer]
      );

      if (result.rows.length > 0) {
        const credentials = result.rows[0];
        return {
          id: credentials.id,
          user_id: credentials.user_id,
          retailer: credentials.retailer,
          login_id: credentials.login_id,
          login_type: credentials.login_type,
          encrypted_password: credentials.encrypted_password,
          created_at: credentials.created_at,
          updated_at: credentials.updated_at
        };
      }
      return null;
    } catch (error) {
      console.error(`❌ Error getting ${retailer} credentials:`, error);
      throw error;
    }
  }

  /**
   * Get decrypted password for retailer
   * @param {number} userId - User ID
   * @param {string} retailer - Retailer name
   * @returns {Promise<string|null>} - Decrypted password or null
   */
  async getDecryptedPassword(userId, retailer) {
    try {
      const credentials = await this.getRetailerCredentials(userId, retailer);
      if (credentials && credentials.encrypted_password) {
        return this.decrypt(credentials.encrypted_password);
      }
      return null;
    } catch (error) {
      console.error(`❌ Error decrypting ${retailer} password:`, error);
      return null;
    }
  }

  /**
   * Check if user has credentials for a retailer
   * @param {number} userId - User ID
   * @param {string} retailer - Retailer name
   * @returns {Promise<boolean>} - True if credentials exist
   */
  async hasRetailerCredentials(userId, retailer) {
    try {
      const credentials = await this.getRetailerCredentials(userId, retailer);
      return credentials !== null;
    } catch (error) {
      console.error(`❌ [AUTH] Error checking ${retailer} credentials:`, error);
      
      // If it's a schema error, return false instead of throwing
      if (error.message && (
        error.message.includes('login_id') || 
        error.message.includes('login_type') ||
        error.message.includes('retailer_credentials')
      )) {
        console.log('🔐 [AUTH] Schema error detected, returning false for credentials check');
        return false;
      }
      
      return false;
    }
  }

  /**
   * Get all retailer credentials for a user
   * @param {number} userId - User ID
   * @returns {Promise<Array>} - Array of retailer credentials
   */
  async getAllRetailerCredentials(userId) {
    try {
      const result = await query(
        'SELECT retailer, login_id, login_type, created_at, updated_at FROM retailer_credentials WHERE user_id = $1',
        [userId]
      );
      console.log(`🔐 [AUTH] Retrieved ${result.rows.length} retailer credentials for user ${userId}`);
      return result.rows;
    } catch (error) {
      console.error('❌ [AUTH] Error getting all retailer credentials:', error);
      
      // If it's a schema error, return empty array instead of throwing
      if (error.message && (
        error.message.includes('login_id') || 
        error.message.includes('login_type') ||
        error.message.includes('retailer_credentials')
      )) {
        console.log('🔐 [AUTH] Schema error detected, returning empty credentials array');
        return [];
      }
      
      throw error;
    }
  }

  /**
   * Delete retailer credentials
   * @param {number} userId - User ID
   * @param {string} retailer - Retailer name
   * @returns {Promise<boolean>} - Success status
   */
  async deleteRetailerCredentials(userId, retailer) {
    try {
      await query(
        'DELETE FROM retailer_credentials WHERE user_id = $1 AND retailer = $2',
        [userId, retailer]
      );
      console.log(`✅ Deleted ${retailer} credentials for user ${userId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error deleting ${retailer} credentials:`, error);
      throw error;
    }
  }

  /**
   * Delete all retailer credentials for a user
   * @param {number} userId - User ID
   * @returns {Promise<boolean>} - Success status
   */
  async deleteAllRetailerCredentials(userId) {
    try {
      await query(
        'DELETE FROM retailer_credentials WHERE user_id = $1',
        [userId]
      );
      console.log(`✅ Deleted all retailer credentials for user ${userId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error deleting all retailer credentials:`, error);
      throw error;
    }
  }

  /**
   * Test retailer login credentials
   * @param {string} retailer - Retailer name
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<Object>} - Login result
   */
  async testRetailerLogin(retailer, email, password) {
    try {
      console.log(`🔐 Testing ${retailer} login for ${email}`);
      
      // This would integrate with actual retailer APIs
      // For now, we'll simulate a login test
      const loginResult = {
        success: true,
        message: `Successfully logged into ${retailer}`,
        session_data: {
          retailer: retailer,
          email: email,
          login_time: new Date().toISOString()
        }
      };

      // Simulate different scenarios
      if (email.includes('test') || password.includes('test')) {
        loginResult.success = false;
        loginResult.message = `Invalid credentials for ${retailer}`;
      }

      return loginResult;
    } catch (error) {
      console.error(`❌ Error testing ${retailer} login:`, error);
      return {
        success: false,
        message: `Login failed for ${retailer}: ${error.message}`
      };
    }
  }
}

module.exports = new AuthService(); 