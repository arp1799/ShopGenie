const OpenAI = require('openai');
const axios = require('axios');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

class AIService {
  constructor() {
    this.model = 'gpt-4o-mini'; // Using the most cost-effective model
  }

  /**
   * Parse user message to extract intent and structured data
   * @param {string} message - User's message
   * @returns {Promise<Object>} - Parsed intent and data
   */
  async parseMessage(message) {
    try {
      console.log(`🧠 Parsing message: ${message}`);

      const response = await openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `You are ShopGenie AI, a WhatsApp shopping assistant. Parse user messages to extract shopping intent, items, quantities, and delivery address.

Parse the message and return a JSON object with the following structure:
{
  "intent": "order|add_item|remove_item|address_confirmation|retailer_selection|help|unknown",
  "items": [
    {
      "name": "item name",
      "quantity": "quantity value",
      "unit": "unit (kg, L, pc, etc.)",
      "brand": "brand name (optional)"
    }
  ],
  "address": "full address text if provided",
  "confirmed": true/false (for address confirmation),
  "choices": {} (for retailer selection),
  "confidence": 0.0-1.0
}

Examples:
- "Order 2L milk and bread to 123 Main St, Bangalore" → intent: "order", items: [{"name": "milk", "quantity": "2", "unit": "L"}, {"name": "bread", "quantity": "1", "unit": "pc"}], address: "123 Main St, Bangalore"
- "Add 1kg tomatoes" → intent: "add_item", items: [{"name": "tomatoes", "quantity": "1", "unit": "kg"}]
- "Yes" (after address confirmation) → intent: "address_confirmation", confirmed: true
- "Zepto for milk, Blinkit for bread" → intent: "retailer_selection", choices: {"milk": "Zepto", "bread": "Blinkit"}

Only return valid JSON.`
          },
          {
            role: 'user',
            content: message
          }
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: "json_object" }
      });

      const parsedData = JSON.parse(response.choices[0].message.content);
      console.log(`✅ Parsed intent: ${parsedData.intent}`);
      
      return parsedData;
    } catch (error) {
      console.error('❌ Error parsing message with AI:', error);
      
      // Fallback to simple regex parsing
      return this.fallbackParse(message);
    }
  }

  /**
   * Fallback parsing using regex patterns
   * @param {string} message - User's message
   * @returns {Object} - Parsed data
   */
  fallbackParse(message) {
    const lowerMessage = message.toLowerCase();
    
    // Check for order intent
    if (lowerMessage.includes('order') || lowerMessage.includes('buy') || lowerMessage.includes('get')) {
      return {
        intent: 'order',
        items: this.extractItemsFromText(message),
        address: this.extractAddressFromText(message),
        confidence: 0.7
      };
    }

    // Check for add item intent
    if (lowerMessage.includes('add') || lowerMessage.includes('include')) {
      return {
        intent: 'add_item',
        items: this.extractItemsFromText(message),
        confidence: 0.8
      };
    }

    // Check for address confirmation
    if (lowerMessage.includes('yes') || lowerMessage.includes('correct') || lowerMessage.includes('✅')) {
      return {
        intent: 'address_confirmation',
        confirmed: true,
        confidence: 0.9
      };
    }

    if (lowerMessage.includes('no') || lowerMessage.includes('wrong') || lowerMessage.includes('❌')) {
      return {
        intent: 'address_confirmation',
        confirmed: false,
        confidence: 0.9
      };
    }

    // Check for help
    if (lowerMessage.includes('help') || lowerMessage.includes('start')) {
      return {
        intent: 'help',
        confidence: 0.9
      };
    }

    return {
      intent: 'unknown',
      confidence: 0.3
    };
  }

  /**
   * Extract items from text using regex
   * @param {string} text - Text to extract items from
   * @returns {Array} - Array of item objects
   */
  extractItemsFromText(text) {
    const items = [];
    
    // Common patterns for quantities and units
    const patterns = [
      /(\d+(?:\.\d+)?)\s*(kg|kgs|kilogram|kilograms)\s+of\s+([a-zA-Z\s]+)/gi,
      /(\d+(?:\.\d+)?)\s*(L|l|liter|liters|litre|litres)\s+of\s+([a-zA-Z\s]+)/gi,
      /(\d+(?:\.\d+)?)\s*(pc|pcs|piece|pieces)\s+of\s+([a-zA-Z\s]+)/gi,
      /(\d+(?:\.\d+)?)\s*(kg|kgs|kilogram|kilograms)\s+([a-zA-Z\s]+)/gi,
      /(\d+(?:\.\d+)?)\s*(L|l|liter|liters|litre|litres)\s+([a-zA-Z\s]+)/gi,
      /(\d+(?:\.\d+)?)\s*(pc|pcs|piece|pieces)\s+([a-zA-Z\s]+)/gi,
      /([a-zA-Z\s]+)\s+(\d+(?:\.\d+)?)\s*(kg|kgs|kilogram|kilograms)/gi,
      /([a-zA-Z\s]+)\s+(\d+(?:\.\d+)?)\s*(L|l|liter|liters|litre|litres)/gi,
      /([a-zA-Z\s]+)\s+(\d+(?:\.\d+)?)\s*(pc|pcs|piece|pieces)/gi
    ];

    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const quantity = parseFloat(match[1] || match[2]);
        const unit = this.normalizeUnit(match[2] || match[3]);
        const name = (match[3] || match[1]).trim().toLowerCase();
        
        if (name && quantity > 0) {
          items.push({
            name: name,
            quantity: quantity,
            unit: unit
          });
        }
      }
    });

    // If no structured patterns found, try to extract simple items
    if (items.length === 0) {
      const simpleItems = text.match(/\b(milk|bread|eggs|tomatoes|onions|potatoes|rice|sugar|salt|oil|butter|cheese|yogurt|fruits|vegetables)\b/gi);
      if (simpleItems) {
        simpleItems.forEach(item => {
          items.push({
            name: item.toLowerCase(),
            quantity: 1,
            unit: 'pc'
          });
        });
      }
    }

    return items;
  }

  /**
   * Extract address from text
   * @param {string} text - Text to extract address from
   * @returns {string|null} - Extracted address or null
   */
  extractAddressFromText(text) {
    // Look for address patterns
    const addressPatterns = [
      /to\s+(.+?)(?:\s|$)/i,
      /at\s+(.+?)(?:\s|$)/i,
      /address\s+is\s+(.+?)(?:\s|$)/i,
      /deliver\s+to\s+(.+?)(?:\s|$)/i
    ];

    for (const pattern of addressPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return null;
  }

  /**
   * Normalize unit to standard format
   * @param {string} unit - Raw unit string
   * @returns {string} - Normalized unit
   */
  normalizeUnit(unit) {
    const unitMap = {
      'kg': 'kg', 'kgs': 'kg', 'kilogram': 'kg', 'kilograms': 'kg',
      'L': 'L', 'l': 'L', 'liter': 'L', 'liters': 'L', 'litre': 'L', 'litres': 'L',
      'pc': 'pc', 'pcs': 'pc', 'piece': 'pc', 'pieces': 'pc'
    };

    return unitMap[unit.toLowerCase()] || 'pc';
  }

  /**
   * Validate and geocode address using Google Maps API
   * @param {string} address - Address to validate
   * @returns {Promise<Object|null>} - Validated address object or null
   */
  async validateAddress(address) {
    try {
      console.log(`📍 Validating address: ${address}`);

      const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          address: address,
          key: process.env.GOOGLE_MAPS_API_KEY,
          region: 'in' // Bias towards India
        }
      });

      if (response.data.status === 'OK' && response.data.results.length > 0) {
        const result = response.data.results[0];
        
        // Extract components
        const components = {};
        result.address_components.forEach(component => {
          component.types.forEach(type => {
            components[type] = component.long_name;
          });
        });

        // Extract pincode
        const pincode = components.postal_code || null;

        const validatedAddress = {
          raw_input: address,
          formatted: result.formatted_address,
          lat: result.geometry.location.lat,
          lng: result.geometry.location.lng,
          pincode: pincode,
          components: components
        };

        console.log(`✅ Address validated: ${validatedAddress.formatted}`);
        return validatedAddress;
      } else {
        console.log(`❌ Address validation failed: ${response.data.status}`);
        return null;
      }
    } catch (error) {
      console.error('❌ Error validating address:', error);
      return null;
    }
  }

  /**
   * Get price suggestions for items (mock data for Phase 1)
   * @param {Array} items - Array of items
   * @param {string} pincode - Delivery pincode
   * @returns {Promise<Array>} - Price suggestions
   */
  async getPriceSuggestions(items, pincode) {
    // Mock price data for Phase 1
    const mockPrices = {
      'milk': [
        { retailer: 'Zepto', price: 52, delivery_time: '10 min' },
        { retailer: 'Blinkit', price: 54, delivery_time: '9 min' },
        { retailer: 'Instamart', price: 53, delivery_time: '15 min' }
      ],
      'bread': [
        { retailer: 'Zepto', price: 35, delivery_time: '10 min' },
        { retailer: 'Blinkit', price: 38, delivery_time: '9 min' },
        { retailer: 'Instamart', price: 37, delivery_time: '15 min' }
      ],
      'eggs': [
        { retailer: 'Zepto', price: 72, delivery_time: '10 min' },
        { retailer: 'Blinkit', price: 74, delivery_time: '9 min' },
        { retailer: 'Instamart', price: 69, delivery_time: '15 min' }
      ],
      'tomatoes': [
        { retailer: 'Zepto', price: 40, delivery_time: '10 min' },
        { retailer: 'Blinkit', price: 42, delivery_time: '9 min' },
        { retailer: 'Instamart', price: 41, delivery_time: '15 min' }
      ],
      'onions': [
        { retailer: 'Zepto', price: 30, delivery_time: '10 min' },
        { retailer: 'Blinkit', price: 32, delivery_time: '9 min' },
        { retailer: 'Instamart', price: 31, delivery_time: '15 min' }
      ]
    };

    const suggestions = [];
    
    items.forEach(item => {
      const itemName = item.name.toLowerCase();
      const prices = mockPrices[itemName] || mockPrices['milk']; // Default to milk if item not found
      
      suggestions.push({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        prices: prices
      });
    });

    return suggestions;
  }

  /**
   * Generate deep links for retailers
   * @param {Array} items - Array of items with retailer choices
   * @returns {Object} - Deep links for each retailer
   */
  generateDeepLinks(items) {
    const deepLinks = {};
    
    items.forEach(item => {
      if (item.selectedRetailer) {
        const retailer = item.selectedRetailer.toLowerCase();
        const itemName = encodeURIComponent(item.name);
        
        switch (retailer) {
          case 'zepto':
            deepLinks[retailer] = `https://www.zepto.in/search?q=${itemName}`;
            break;
          case 'blinkit':
            deepLinks[retailer] = `https://blinkit.com/s/?q=${itemName}`;
            break;
          case 'instamart':
            deepLinks[retailer] = `https://www.swiggy.com/instamart?query=${itemName}`;
            break;
          default:
            deepLinks[retailer] = `https://www.google.com/search?q=${itemName}+${retailer}`;
        }
      }
    });

    return deepLinks;
  }
}

module.exports = new AIService(); 