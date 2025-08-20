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
    const cipher = crypto.createCipher(algorithm, key);
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
    const decipher = crypto.createDecipher(algorithm, key);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Save user's retailer credentials
   * @param {number} userId - User ID
   * @param {string} retailer - Retailer name (zepto, blinkit, instamart)
   * @param {string} email - User's email
   * @param {string} password - User's password (will be encrypted)
   * @returns {Promise<Object>} - Saved credentials object
   */
  async saveRetailerCredentials(userId, retailer, email, password) {
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
           SET email = $1, encrypted_password = $2, updated_at = NOW()
           WHERE user_id = $3 AND retailer = $4
           RETURNING *`,
          [email, encryptedPassword, userId, retailer]
        );
        console.log(`✅ Updated ${retailer} credentials for user ${userId}`);
        return result.rows[0];
      } else {
        // Insert new credentials
        const result = await query(
          `INSERT INTO retailer_credentials (user_id, retailer, email, encrypted_password)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [userId, retailer, email, encryptedPassword]
        );
        console.log(`✅ Saved ${retailer} credentials for user ${userId}`);
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
          email: credentials.email,
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
      console.error(`❌ Error checking ${retailer} credentials:`, error);
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
        'SELECT retailer, email, created_at, updated_at FROM retailer_credentials WHERE user_id = $1',
        [userId]
      );
      return result.rows;
    } catch (error) {
      console.error('❌ Error getting all retailer credentials:', error);
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