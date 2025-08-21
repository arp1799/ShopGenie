const { query } = require('../database/connection');

class UserService {
  /**
   * Get user by phone number
   * @param {string} phoneNumber - WhatsApp phone number
   * @returns {Promise<Object|null>} - User object or null
   */
  async getUserByPhone(phoneNumber) {
    try {
      const result = await query(
        'SELECT * FROM users WHERE phone_number = $1',
        [phoneNumber]
      );
      
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Error getting user by phone:', error);
      throw error;
    }
  }

  /**
   * Create a new user
   * @param {string} phoneNumber - WhatsApp phone number
   * @param {string} displayName - Optional display name
   * @returns {Promise<Object>} - Created user object
   */
  async createUser(phoneNumber, displayName = null) {
    try {
      const result = await query(
        'INSERT INTO users (phone_number, name) VALUES ($1, $2) RETURNING *',
        [phoneNumber, displayName]
      );
      
      console.log(`✅ Created new user: ${phoneNumber}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error creating user:', error);
      throw error;
    }
  }

  /**
   * Update user's session data
   * @param {number} userId - User ID
   * @param {Object} sessionData - Session data to update
   * @returns {Promise<Object>} - Updated user object
   */
  async updateUserSession(userId, sessionData) {
    try {
      const result = await query(
        'UPDATE users SET session_data = COALESCE(session_data, \'{}\') || $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [JSON.stringify(sessionData), userId]
      );
      
      if (result.rows.length > 0) {
        console.log(`✅ [USER] Updated session data for user ${userId}`);
        return result.rows[0];
      }
      return null;
    } catch (error) {
      console.error('❌ [USER] Error updating user session:', error);
      throw error;
    }
  }

  /**
   * Get user's session data
   * @param {number} userId - User ID
   * @returns {Promise<Object>} - Session data object
   */
  async getUserSession(userId) {
    try {
      const result = await query(
        'SELECT session_data FROM users WHERE id = $1',
        [userId]
      );
      
      if (result.rows.length > 0 && result.rows[0].session_data) {
        return result.rows[0].session_data;
      }
      return {};
    } catch (error) {
      console.error('❌ [USER] Error getting user session:', error);
      return {};
    }
  }

  /**
   * Update user's allowed status
   * @param {number} userId - User ID
   * @param {boolean} allowed - Whether user is allowed to use the service
   * @returns {Promise<Object>} - Updated user object
   */
  async updateUserAllowed(userId, allowed) {
    try {
      const result = await query(
        'UPDATE users SET allowed = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [allowed, userId]
      );
      
      console.log(`✅ Updated user ${userId} allowed status to ${allowed}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error updating user allowed status:', error);
      throw error;
    }
  }

  /**
   * Get user's primary address (confirmed only)
   * @param {number} userId - User ID
   * @returns {Promise<Object|null>} - Address object or null
   */
  async getUserPrimaryAddress(userId) {
    try {
      const result = await query(
        'SELECT * FROM addresses WHERE user_id = $1 AND is_primary = true AND confirmed = true ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Error getting user primary address:', error);
      throw error;
    }
  }

  /**
   * Get user's primary address (including unconfirmed)
   * @param {number} userId - User ID
   * @returns {Promise<Object|null>} - Address object or null
   */
  async getUserPrimaryAddressIncludingUnconfirmed(userId) {
    try {
      const result = await query(
        'SELECT * FROM addresses WHERE user_id = $1 AND is_primary = true ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Error getting user primary address (including unconfirmed):', error);
      throw error;
    }
  }

  /**
   * Save user address
   * @param {number} userId - User ID
   * @param {Object} addressData - Address data object
   * @returns {Promise<Object>} - Saved address object
   */
  async saveAddress(userId, addressData) {
    try {
      // Set all existing addresses as non-primary
      await query(
        'UPDATE addresses SET is_primary = false WHERE user_id = $1',
        [userId]
      );

      // Insert new address as primary
      const result = await query(
        `INSERT INTO addresses (
          user_id, raw_input, formatted, lat, lng, pincode, components, is_primary, confirmed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, false) RETURNING *`,
        [
          userId,
          addressData.raw_input,
          addressData.formatted,
          addressData.lat,
          addressData.lng,
          addressData.pincode,
          JSON.stringify(addressData.components)
        ]
      );
      
      console.log(`✅ Saved address for user ${userId}: ${addressData.formatted}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error saving address:', error);
      throw error;
    }
  }

  /**
   * Confirm user's address
   * @param {number} userId - User ID
   * @returns {Promise<Object>} - Updated address object
   */
  async confirmAddress(userId) {
    try {
      const result = await query(
        'UPDATE addresses SET confirmed = true WHERE user_id = $1 AND is_primary = true RETURNING *',
        [userId]
      );
      
      console.log(`✅ Confirmed address for user ${userId}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error confirming address:', error);
      throw error;
    }
  }

  /**
   * Get user's address history
   * @param {number} userId - User ID
   * @returns {Promise<Array>} - Array of address objects
   */
  async getUserAddresses(userId) {
    try {
      const result = await query(
        'SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );
      
      return result.rows;
    } catch (error) {
      console.error('❌ Error getting user addresses:', error);
      throw error;
    }
  }

  /**
   * Log a message
   * @param {number} userId - User ID
   * @param {string} messageType - Type of message (inbound/outbound)
   * @param {string} content - Message content
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} - Logged message object
   */
  async logMessage(userId, messageType, content, metadata = {}) {
    try {
      const result = await query(
        'INSERT INTO messages_log (user_id, message_type, content, metadata) VALUES ($1, $2, $3, $4) RETURNING *',
        [userId, messageType, content, JSON.stringify(metadata)]
      );
      
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error logging message:', error);
      // Don't throw error for logging failures
      return null;
    }
  }

  /**
   * Get user's message history
   * @param {number} userId - User ID
   * @param {number} limit - Number of messages to retrieve
   * @returns {Promise<Array>} - Array of message objects
   */
  async getUserMessages(userId, limit = 50) {
    try {
      const result = await query(
        'SELECT * FROM messages_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit]
      );
      
      return result.rows;
    } catch (error) {
      console.error('❌ Error getting user messages:', error);
      throw error;
    }
  }

  /**
   * Get user statistics
   * @param {number} userId - User ID
   * @returns {Promise<Object>} - User statistics
   */
  async getUserStats(userId) {
    try {
      const stats = await query(
        `SELECT 
          COUNT(*) as total_messages,
          COUNT(CASE WHEN message_type = 'inbound' THEN 1 END) as inbound_messages,
          COUNT(CASE WHEN message_type = 'outbound' THEN 1 END) as outbound_messages,
          MIN(created_at) as first_message,
          MAX(created_at) as last_message
        FROM messages_log 
        WHERE user_id = $1`,
        [userId]
      );

      const addressCount = await query(
        'SELECT COUNT(*) as address_count FROM addresses WHERE user_id = $1',
        [userId]
      );

      const cartCount = await query(
        'SELECT COUNT(*) as cart_count FROM carts WHERE user_id = $1',
        [userId]
      );

      return {
        messages: stats.rows[0],
        addresses: addressCount.rows[0].address_count,
        carts: cartCount.rows[0].cart_count
      };
    } catch (error) {
      console.error('❌ Error getting user stats:', error);
      throw error;
    }
  }

  /**
   * Search users by phone number (for admin purposes)
   * @param {string} searchTerm - Search term
   * @param {number} limit - Number of results to return
   * @returns {Promise<Array>} - Array of user objects
   */
  async searchUsers(searchTerm, limit = 10) {
    try {
      const result = await query(
        'SELECT * FROM users WHERE phone_number ILIKE $1 ORDER BY created_at DESC LIMIT $2',
        [`%${searchTerm}%`, limit]
      );
      
      return result.rows;
    } catch (error) {
      console.error('❌ Error searching users:', error);
      throw error;
    }
  }

  /**
   * Get all users (for admin purposes)
   * @param {number} limit - Number of users to return
   * @param {number} offset - Number of users to skip
   * @returns {Promise<Array>} - Array of user objects
   */
  async getAllUsers(limit = 50, offset = 0) {
    try {
      const result = await query(
        'SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
      
      return result.rows;
    } catch (error) {
      console.error('❌ Error getting all users:', error);
      throw error;
    }
  }

  /**
   * Delete user and all associated data
   * @param {number} userId - User ID
   * @returns {Promise<boolean>} - Success status
   */
  async deleteUser(userId) {
    try {
      // This will cascade delete all related data due to foreign key constraints
      await query('DELETE FROM users WHERE id = $1', [userId]);
      
      console.log(`✅ Deleted user ${userId} and all associated data`);
      return true;
    } catch (error) {
      console.error('❌ Error deleting user:', error);
      throw error;
    }
  }

  /**
   * Update user's display name
   * @param {number} userId - User ID
   * @param {string} displayName - New display name
   * @returns {Promise<Object>} - Updated user object
   */
  async updateDisplayName(userId, displayName) {
    try {
      const result = await query(
        'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [displayName, userId]
      );
      
      console.log(`✅ Updated display name for user ${userId}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error updating display name:', error);
      throw error;
    }
  }
}

module.exports = new UserService(); 