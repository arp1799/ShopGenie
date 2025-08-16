const OpenAI = require('openai');
const axios = require('axios');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

class AIService {
  constructor() {
    this.models = [
      'gpt-4o-mini',      // Primary model (fastest, cheapest)
      'gpt-3.5-turbo',    // Fallback model 1
      'gpt-4o'            // Fallback model 2 (if available)
    ];
    this.currentModelIndex = 0;
  }

  /**
   * Parse user message to extract intent and structured data
   * @param {string} message - User's message
   * @returns {Promise<Object>} - Parsed intent and data
   */
  async parseMessage(message) {
    console.log(`🧠 Parsing message: ${message}`);

    // Check if OpenAI is disabled (for free tier users)
    const openaiDisabled = process.env.DISABLE_OPENAI === 'true' || !process.env.OPENAI_API_KEY;
    
    if (!openaiDisabled) {
      // Try OpenAI models first
      for (let i = 0; i < this.models.length; i++) {
        try {
          const model = this.models[i];
          console.log(`🤖 Trying OpenAI model: ${model}`);
          
          const result = await this.parseWithOpenAI(message, model);
          console.log(`✅ Parsed with OpenAI ${model}: ${result.intent}`);
          return result;
          
        } catch (error) {
          console.error(`❌ Failed with OpenAI model ${this.models[i]}:`, error.message);
          
          // Continue to next model
          continue;
        }
      }
    } else {
      console.log(`🚫 OpenAI disabled, skipping to free alternatives`);
    }

    // Try free Hugging Face model if OpenAI fails or is disabled
    try {
      console.log(`🤖 Trying free Hugging Face model`);
      const result = await this.parseWithHuggingFace(message);
      console.log(`✅ Parsed with Hugging Face: ${result.intent}`);
      
      // If Hugging Face gives low confidence or wrong intent, fall back to regex
      if (result.confidence < 0.7 || result.intent === 'address_confirmation') {
        console.log(`🔄 Hugging Face confidence too low (${result.confidence}) or wrong intent, using enhanced regex parser`);
        return this.enhancedFallbackParse(message);
      }
      
      return result;
    } catch (error) {
      console.error(`❌ Failed with Hugging Face:`, error.message);
    }

    // Final fallback to enhanced regex parser
    console.log(`🔄 Falling back to enhanced regex parser`);
    return this.enhancedFallbackParse(message);
  }

  /**
   * Parse message with OpenAI model
   * @param {string} message - User's message
   * @param {string} model - Model to use
   * @returns {Promise<Object>} - Parsed intent and data
   */
  async parseWithOpenAI(message, model) {
    const response = await openai.chat.completions.create({
      model: model,
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
    return parsedData;
  }

  /**
   * Parse message with free Hugging Face model
   * @param {string} message - User's message
   * @returns {Promise<Object>} - Parsed intent and data
   */
  async parseWithHuggingFace(message) {
    // Using a free text classification model for intent detection
    const response = await axios.post('https://api-inference.huggingface.co/models/facebook/bart-large-mnli', {
      inputs: message,
      parameters: {
        candidate_labels: [
          "order groceries",
          "add item to cart", 
          "remove item from cart",
          "confirm address",
          "select retailer",
          "ask for help",
          "unknown request"
        ]
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY || 'hf_demo'}`,
        'Content-Type': 'application/json'
      }
    });

    const intent = this.mapHuggingFaceIntent(response.data.labels[0]);
    const items = this.extractItemsFromText(message);
    const address = this.extractAddressFromText(message);

    return {
      intent: intent,
      items: items,
      address: address,
      confidence: response.data.scores[0]
    };
  }

  /**
   * Map Hugging Face intent to our intent format
   * @param {string} huggingFaceIntent - Intent from Hugging Face
   * @returns {string} - Mapped intent
   */
  mapHuggingFaceIntent(huggingFaceIntent) {
    const intentMap = {
      'order groceries': 'order',
      'add item to cart': 'add_item',
      'remove item from cart': 'remove_item',
      'confirm address': 'address_confirmation',
      'select retailer': 'retailer_selection',
      'ask for help': 'help',
      'unknown request': 'unknown'
    };
    return intentMap[huggingFaceIntent] || 'unknown';
  }

  /**
   * Enhanced fallback parser with better pattern matching
   * @param {string} message - User's message
   * @returns {Object} - Parsed data
   */
  enhancedFallbackParse(message) {
    const lowerMessage = message.toLowerCase();
    
    // Check for order intent with better patterns
    if (lowerMessage.includes('order') || lowerMessage.includes('buy') || lowerMessage.includes('get') || 
        lowerMessage.includes('want') || lowerMessage.includes('need')) {
      return {
        intent: 'order',
        items: this.extractItemsFromText(message),
        address: this.extractAddressFromText(message),
        confidence: 0.8
      };
    }

    // Check for add item intent
    if (lowerMessage.includes('add') || lowerMessage.includes('include') || lowerMessage.includes('more')) {
      return {
        intent: 'add_item',
        items: this.extractItemsFromText(message),
        confidence: 0.8
      };
    }

    // Check for address confirmation
    if (lowerMessage.includes('yes') || lowerMessage.includes('correct') || lowerMessage.includes('✅') || 
        lowerMessage.includes('right') || lowerMessage.includes('okay') || lowerMessage.includes('ok')) {
      return {
        intent: 'address_confirmation',
        confirmed: true,
        confidence: 0.9
      };
    }

    if (lowerMessage.includes('no') || lowerMessage.includes('wrong') || lowerMessage.includes('❌') || 
        lowerMessage.includes('incorrect') || lowerMessage.includes('not')) {
      return {
        intent: 'address_confirmation',
        confirmed: false,
        confidence: 0.9
      };
    }

    // Check for help
    if (lowerMessage.includes('help') || lowerMessage.includes('start') || lowerMessage.includes('hi') || 
        lowerMessage.includes('hello') || lowerMessage.includes('what can you do')) {
      return {
        intent: 'help',
        confidence: 0.9
      };
    }

    // Check if message looks like an address (enhanced detection)
    if (this.looksLikeAddress(message)) {
      // Extract address from the message
      let address = message.trim();
      
      // Remove common prefixes
      const prefixes = ['my address is', 'address is', 'deliver to', 'send to'];
      for (const prefix of prefixes) {
        if (lowerMessage.startsWith(prefix)) {
          address = message.substring(prefix.length).trim();
          break;
        }
      }
      
      return {
        intent: 'order',
        items: [],
        address: address,
        confidence: 0.9
      };
    }

    // Check for retailer selection
    if (lowerMessage.includes('zepto') || lowerMessage.includes('blinkit') || lowerMessage.includes('swiggy') || 
        lowerMessage.includes('instamart') || lowerMessage.includes('bigbasket')) {
      return {
        intent: 'retailer_selection',
        choices: this.extractRetailerChoices(message),
        confidence: 0.8
      };
    }

    return {
      intent: 'unknown',
      confidence: 0.3
    };
  }

  /**
   * Extract retailer choices from message
   * @param {string} message - User's message
   * @returns {Object} - Retailer choices
   */
  extractRetailerChoices(message) {
    const choices = {};
    const lowerMessage = message.toLowerCase();
    
    // Extract retailer-item pairs
    const retailers = ['zepto', 'blinkit', 'swiggy', 'instamart', 'bigbasket'];
    const items = this.extractItemsFromText(message);
    
    retailers.forEach(retailer => {
      if (lowerMessage.includes(retailer)) {
        // Find items mentioned near this retailer
        const retailerIndex = lowerMessage.indexOf(retailer);
        const nearbyText = lowerMessage.substring(Math.max(0, retailerIndex - 50), retailerIndex + 50);
        
        items.forEach(item => {
          if (nearbyText.includes(item.name)) {
            choices[item.name] = retailer.charAt(0).toUpperCase() + retailer.slice(1);
          }
        });
      }
    });
    
    return choices;
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
   * Check if a message looks like an address
   * @param {string} message - Message to check
   * @returns {boolean} - True if message looks like an address
   */
  looksLikeAddress(message) {
    const lowerMessage = message.toLowerCase();
    
    // Common address keywords
    const addressKeywords = [
      'layout', 'sector', 'block', 'floor', 'apartment', 'flat', 'house', 'building',
      'street', 'road', 'avenue', 'lane', 'colony', 'nagar', 'vihar', 'puram',
      'bangalore', 'mumbai', 'delhi', 'chennai', 'kolkata', 'pune', 'hyderabad',
      'ahmedabad', 'jaipur', 'lucknow', 'kanpur', 'nagpur', 'indore', 'thane',
      'bhopal', 'visakhapatnam', 'patna', 'vadodara', 'ghaziabad', 'ludhiana',
      'agra', 'nashik', 'faridabad', 'meerut', 'rajkot', 'kalyan', 'vasai',
      'vijayawada', 'jodhpur', 'madurai', 'raipur', 'kota', 'chandigarh'
    ];

    // Check for pincode pattern (6 digits)
    const hasPincode = /\d{6}/.test(message);
    
    // Check for address keywords
    const hasAddressKeywords = addressKeywords.some(keyword => lowerMessage.includes(keyword));
    
    // Check for common address patterns (number + text)
    const hasAddressPattern = /^[A-Z0-9\-\/,\s]+$/i.test(message.trim()) && message.length > 10;
    
    // Check for address-like structure (contains numbers and city names)
    const hasAddressStructure = /\d+/.test(message) && addressKeywords.some(keyword => lowerMessage.includes(keyword));
    
    // Check if message contains "address" keyword
    const hasAddressKeyword = lowerMessage.includes('address');
    
    return hasPincode || hasAddressKeywords || hasAddressPattern || hasAddressStructure || hasAddressKeyword;
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