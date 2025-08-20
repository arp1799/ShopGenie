const { query } = require('../database/connection');
const aiService = require('./aiService');

class CartService {
  /**
   * Get user's active cart
   * @param {number} userId - User ID
   * @returns {Promise<Object|null>} - Active cart object or null
   */
  async getActiveCart(userId) {
    try {
      const result = await query(
        'SELECT * FROM carts WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
        [userId, 'draft']
      );
      
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Error getting active cart:', error);
      throw error;
    }
  }

  /**
   * Create a new cart for user
   * @param {number} userId - User ID
   * @returns {Promise<Object>} - Created cart object
   */
  async createCart(userId) {
    try {
      // Close any existing active carts
      await query(
        'UPDATE carts SET status = $1 WHERE user_id = $2 AND status = $3',
        ['cancelled', userId, 'draft']
      );

      // Create new cart
      const result = await query(
        'INSERT INTO carts (user_id, status) VALUES ($1, $2) RETURNING *',
        [userId, 'draft']
      );
      
      console.log(`✅ Created new cart for user ${userId}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error creating cart:', error);
      throw error;
    }
  }

  /**
   * Add item to cart
   * @param {number} cartId - Cart ID
   * @param {Object} item - Item object
   * @returns {Promise<Object>} - Added cart item object
   */
  async addItemToCart(cartId, item) {
    try {
      // Check if item already exists in cart
      const existingItem = await query(
        'SELECT * FROM cart_items WHERE cart_id = $1 AND LOWER(product_name) = LOWER($2) AND unit = $3',
        [cartId, item.name, item.unit]
      );

      if (existingItem.rows.length > 0) {
        // Update quantity of existing item
        const existing = existingItem.rows[0];
        const newQuantity = existing.quantity + item.quantity;
        
        const result = await query(
          'UPDATE cart_items SET quantity = $1, query = $2 WHERE id = $3 RETURNING *',
          [
            newQuantity,
            `${newQuantity} ${item.unit} ${item.name}`,
            existing.id
          ]
        );
        
        console.log(`✅ Updated quantity for ${item.name} in cart ${cartId}: ${newQuantity} ${item.unit}`);
        return result.rows[0];
      } else {
        // Add new item
        const result = await query(
          `INSERT INTO cart_items (
            cart_id, product_name, normalized_name, quantity, unit, notes, query
          ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            cartId,
            item.name, // product_name
            item.name, // normalized_name
            item.quantity,
            item.unit,
            item.notes || null,
            `${item.quantity} ${item.unit} ${item.name}` // query
          ]
        );
        
        console.log(`✅ Added item to cart ${cartId}: ${item.name}`);
        return result.rows[0];
      }
    } catch (error) {
      console.error('❌ Error adding item to cart:', error);
      throw error;
    }
  }

  /**
   * Add multiple items to cart with proper duplicate handling
   * @param {number} cartId - Cart ID
   * @param {Array} items - Array of item objects
   * @returns {Promise<Array>} - Array of added/updated cart items
   */
  async addItemsToCart(cartId, items) {
    try {
      const results = [];
      
      for (const item of items) {
        const result = await this.addItemToCart(cartId, item);
        results.push(result);
      }
      
      return results;
    } catch (error) {
      console.error('❌ Error adding items to cart:', error);
      throw error;
    }
  }

  /**
   * Remove item from cart
   * @param {number} cartItemId - Cart item ID
   * @returns {Promise<boolean>} - Success status
   */
  async removeItemFromCart(cartItemId) {
    try {
      await query('DELETE FROM cart_items WHERE id = $1', [cartItemId]);
      
      console.log(`✅ Removed item ${cartItemId} from cart`);
      return true;
    } catch (error) {
      console.error('❌ Error removing item from cart:', error);
      throw error;
    }
  }

  /**
   * Get cart items
   * @param {number} cartId - Cart ID
   * @returns {Promise<Array>} - Array of cart items
   */
  async getCartItems(cartId) {
    try {
      const result = await query(
        'SELECT * FROM cart_items WHERE cart_id = $1 ORDER BY created_at ASC',
        [cartId]
      );
      
      return result.rows;
    } catch (error) {
      console.error('❌ Error getting cart items:', error);
      throw error;
    }
  }

  /**
   * Get cart items with combined quantities
   * @param {number} cartId - Cart ID
   * @returns {Promise<Array>} - Array of cart items with combined quantities
   */
  async getCartItemsCombined(cartId) {
    try {
      const result = await query(
        `SELECT 
          product_name,
          unit,
          SUM(quantity) as total_quantity,
          MIN(id) as first_id,
          MIN(created_at) as first_created
        FROM cart_items 
        WHERE cart_id = $1 
        GROUP BY product_name, unit 
        ORDER BY first_created ASC`,
        [cartId]
      );
      
      return result.rows;
    } catch (error) {
      console.error('❌ Error getting combined cart items:', error);
      throw error;
    }
  }

  /**
   * Update cart item
   * @param {number} cartItemId - Cart item ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} - Updated cart item object
   */
  async updateCartItem(cartItemId, updates) {
    try {
      const fields = [];
      const values = [];
      let paramCount = 1;

      Object.keys(updates).forEach(key => {
        if (updates[key] !== undefined) {
          fields.push(`${key} = $${paramCount}`);
          values.push(updates[key]);
          paramCount++;
        }
      });

      if (fields.length === 0) {
        throw new Error('No fields to update');
      }

      values.push(cartItemId);
      const result = await query(
        `UPDATE cart_items SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        values
      );
      
      console.log(`✅ Updated cart item ${cartItemId}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error updating cart item:', error);
      throw error;
    }
  }

  /**
   * Update cart item with selected product details
   * @param {number} cartId - Cart ID
   * @param {string} itemName - Item name
   * @param {Object} selectedProduct - Selected product details
   * @returns {Promise<Object>} - Updated cart item
   */
  async updateCartItemWithProduct(cartId, itemName, selectedProduct) {
    try {
      // Update the cart item with selected product details
      const result = await query(
        `UPDATE cart_items 
         SET product_name = $1, 
             normalized_name = $2,
             notes = $3,
             query = $4
         WHERE cart_id = $5 AND LOWER(product_name) = LOWER($6)
         RETURNING *`,
        [
          selectedProduct.name,
          selectedProduct.name,
          `Selected from ${selectedProduct.retailer} - ₹${selectedProduct.price}`,
          `${selectedProduct.name} from ${selectedProduct.retailer}`,
          cartId,
          itemName
        ]
      );
      
      console.log(`✅ Updated cart item with selected product: ${selectedProduct.name}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error updating cart item with product:', error);
      throw error;
    }
  }

  /**
   * Get price comparisons for cart items
   * @param {number} cartId - Cart ID
   * @returns {Promise<Array>} - Array of price comparisons
   */
  async getPriceComparisons(cartId) {
    try {
      const items = await this.getCartItems(cartId);
      const comparisons = [];

      for (const item of items) {
        // Convert database item to format expected by AI service
        const itemForPricing = {
          name: item.product_name || item.normalized_name,
          quantity: item.quantity,
          unit: item.unit
        };
        
        // Get price suggestions from AI service
        const priceSuggestions = await aiService.getPriceSuggestions([itemForPricing], null);
        
        if (priceSuggestions.length > 0) {
          comparisons.push(priceSuggestions[0]);
        }
      }

      return comparisons;
    } catch (error) {
      console.error('❌ Error getting price comparisons:', error);
      throw error;
    }
  }

  /**
   * Update retailer choices for cart
   * @param {number} cartId - Cart ID
   * @param {Object} choices - Retailer choices for items
   * @returns {Promise<Object>} - Updated cart object
   */
  async updateRetailerChoices(cartId, choices) {
    try {
      const result = await query(
        'UPDATE carts SET retailer_choices = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [JSON.stringify(choices), cartId]
      );
      
      console.log(`✅ Updated retailer choices for cart ${cartId}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error updating retailer choices:', error);
      throw error;
    }
  }

  /**
   * Generate final cart summary
   * @param {number} cartId - Cart ID
   * @returns {Promise<Object>} - Final cart summary
   */
  async generateFinalCart(cartId) {
    try {
      const cart = await query('SELECT * FROM carts WHERE id = $1', [cartId]);
      if (!cart.rows[0]) {
        throw new Error('Cart not found');
      }

      const items = await this.getCartItems(cartId);
      const retailerChoices = cart.rows[0].retailer_choices || {};
      
      const retailerCarts = {};
      const retailerTotals = {};
      const deepLinks = {};

      // Group items by retailer
      for (const item of items) {
        const selectedRetailer = retailerChoices[item.normalized_name];
        if (selectedRetailer) {
          if (!retailerCarts[selectedRetailer]) {
            retailerCarts[selectedRetailer] = [];
            retailerTotals[selectedRetailer] = 0;
          }

          // Get price for this item from the selected retailer
          const priceSuggestions = await aiService.getPriceSuggestions([item], null);
          const price = priceSuggestions[0]?.prices?.find(p => p.retailer === selectedRetailer)?.price || 0;

          retailerCarts[selectedRetailer].push({
            name: item.normalized_name,
            quantity: item.quantity,
            unit: item.unit,
            price: price
          });

          retailerTotals[selectedRetailer] += price;
        }
      }

      // Generate deep links
      for (const [retailer, items] of Object.entries(retailerCarts)) {
        const itemNames = items.map(item => item.name).join(' ');
        deepLinks[retailer] = this.generateRetailerDeepLink(retailer, itemNames);
      }

      // Calculate grand total
      const grandTotal = Object.values(retailerTotals).reduce((sum, total) => sum + total, 0);

      return {
        cartId,
        retailerCarts,
        retailerTotals,
        deepLinks,
        grandTotal
      };
    } catch (error) {
      console.error('❌ Error generating final cart:', error);
      throw error;
    }
  }

  /**
   * Generate deep link for retailer
   * @param {string} retailer - Retailer name
   * @param {string} items - Items string
   * @returns {string} - Deep link URL
   */
  generateRetailerDeepLink(retailer, items) {
    const encodedItems = encodeURIComponent(items);
    
    switch (retailer.toLowerCase()) {
      case 'zepto':
        return `https://www.zepto.in/search?q=${encodedItems}`;
      case 'blinkit':
        return `https://blinkit.com/s/?q=${encodedItems}`;
      case 'instamart':
        return `https://www.swiggy.com/instamart?query=${encodedItems}`;
      default:
        return `https://www.google.com/search?q=${encodedItems}+${retailer}`;
    }
  }

  /**
   * Save price quotes for cart items
   * @param {number} cartId - Cart ID
   * @param {Array} priceQuotes - Array of price quote objects
   * @returns {Promise<Array>} - Saved price quote objects
   */
  async savePriceQuotes(cartId, priceQuotes) {
    try {
      const items = await this.getCartItems(cartId);
      const savedQuotes = [];

      for (const item of items) {
        const itemQuotes = priceQuotes.find(q => q.name === item.normalized_name);
        
        if (itemQuotes && itemQuotes.prices) {
          for (const price of itemQuotes.prices) {
            const result = await query(
              `INSERT INTO price_quotes (
                cart_item_id, retailer, product_title, unit_price, currency, product_url, metadata
              ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
              [
                item.id,
                price.retailer,
                itemQuotes.name,
                price.price,
                'INR',
                price.product_url || null,
                JSON.stringify({
                  delivery_time: price.delivery_time,
                  availability: price.availability
                })
              ]
            );
            
            savedQuotes.push(result.rows[0]);
          }
        }
      }

      console.log(`✅ Saved ${savedQuotes.length} price quotes for cart ${cartId}`);
      return savedQuotes;
    } catch (error) {
      console.error('❌ Error saving price quotes:', error);
      throw error;
    }
  }

  /**
   * Get cart history for user
   * @param {number} userId - User ID
   * @param {number} limit - Number of carts to retrieve
   * @returns {Promise<Array>} - Array of cart objects
   */
  async getCartHistory(userId, limit = 10) {
    try {
      const result = await query(
        'SELECT * FROM carts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit]
      );
      
      return result.rows;
    } catch (error) {
      console.error('❌ Error getting cart history:', error);
      throw error;
    }
  }

  /**
   * Get cart statistics
   * @param {number} cartId - Cart ID
   * @returns {Promise<Object>} - Cart statistics
   */
  async getCartStats(cartId) {
    try {
      const itemCount = await query(
        'SELECT COUNT(*) as count FROM cart_items WHERE cart_id = $1',
        [cartId]
      );

      const totalValue = await query(
        'SELECT SUM(unit_price) as total FROM price_quotes WHERE cart_item_id IN (SELECT id FROM cart_items WHERE cart_id = $1)',
        [cartId]
      );

      return {
        itemCount: parseInt(itemCount.rows[0].count),
        totalValue: parseFloat(totalValue.rows[0].total || 0)
      };
    } catch (error) {
      console.error('❌ Error getting cart stats:', error);
      throw error;
    }
  }

  /**
   * Clear cart (remove all items)
   * @param {number} cartId - Cart ID
   * @returns {Promise<boolean>} - Success status
   */
  async clearCart(cartId) {
    try {
      await query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
      
      console.log(`✅ Cleared cart ${cartId}`);
      return true;
    } catch (error) {
      console.error('❌ Error clearing cart:', error);
      throw error;
    }
  }

  /**
   * Close cart (mark as completed)
   * @param {number} cartId - Cart ID
   * @param {string} status - Final status (handed_off, ordered, cancelled)
   * @returns {Promise<Object>} - Updated cart object
   */
  async closeCart(cartId, status = 'handed_off') {
    try {
      const result = await query(
        'UPDATE carts SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, cartId]
      );
      
      console.log(`✅ Closed cart ${cartId} with status: ${status}`);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error closing cart:', error);
      throw error;
    }
  }

  /**
   * Get product suggestions for items in cart
   * @param {number} cartId - Cart ID
   * @param {number} userId - User ID for authentication
   * @returns {Promise<Object>} - Product suggestions organized by item
   */
  async getProductSuggestions(cartId, userId = null) {
    try {
      const cartItems = await this.getCartItemsCombined(cartId);
      const suggestions = {};
      
      for (const item of cartItems) {
        const itemName = item.product_name;
        const retailers = ['zepto', 'blinkit', 'instamart'];
        
        suggestions[itemName] = {};
        
        for (const retailer of retailers) {
          try {
            const retailerSuggestions = await aiService.scrapeProductSuggestions(itemName, retailer, userId);
            suggestions[itemName][retailer] = retailerSuggestions;
          } catch (error) {
            console.error(`❌ Error getting ${retailer} suggestions for ${itemName}:`, error);
            suggestions[itemName][retailer] = [];
          }
        }
      }
      
      return suggestions;
    } catch (error) {
      console.error('❌ Error getting product suggestions:', error);
      throw error;
    }
  }

  /**
   * Get mixed product suggestions from all retailers for a specific item
   * @param {string} itemName - Item name
   * @param {number} userId - User ID for authentication
   * @returns {Promise<Array>} - Mixed product suggestions from all retailers
   */
  async getMixedProductSuggestions(itemName, userId = null) {
    try {
      const retailers = ['zepto', 'blinkit', 'instamart'];
      const allSuggestions = [];
      
      for (const retailer of retailers) {
        try {
          const retailerSuggestions = await aiService.scrapeProductSuggestions(itemName, retailer, userId);
          retailerSuggestions.forEach(suggestion => {
            allSuggestions.push({
              ...suggestion,
              retailer: retailer.charAt(0).toUpperCase() + retailer.slice(1)
            });
          });
        } catch (error) {
          console.error(`❌ Error getting ${retailer} suggestions for ${itemName}:`, error);
        }
      }
      
      // Sort by price (lowest first) and limit to top 6 suggestions
      allSuggestions.sort((a, b) => {
        if (a.price === 'N/A' && b.price === 'N/A') return 0;
        if (a.price === 'N/A') return 1;
        if (b.price === 'N/A') return -1;
        return a.price - b.price;
      });
      
      return allSuggestions.slice(0, 6);
    } catch (error) {
      console.error('❌ Error getting mixed product suggestions:', error);
      throw error;
    }
  }
}

module.exports = new CartService(); 